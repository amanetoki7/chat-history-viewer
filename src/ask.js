/**
 * チャット履歴を根拠に自然言語の質問へ答える RAG パイプライン。
 *
 * LLM はローカルの LM Studio（OpenAI 互換 API）を使う。
 * チャット履歴はプライバシー保護のため一切外部へ送信しない。
 *
 * 流れ:
 *   1. LLM が質問から全文検索クエリを立案（JSON Schema 構造化出力）
 *   2. 既存の索引 (search.js) で関連会話を横断検索し、抜粋を収集
 *   3. 抜粋を根拠として LLM がストリーミングで回答（出典番号つき）
 *
 * 環境変数:
 *   LMSTUDIO_BASE_URL … 既定 http://localhost:1234/v1
 *   LMSTUDIO_MODEL    … 未指定ならロード済みモデルを自動選択
 */

import { index } from './indexer.js';
import { search, parseQuery, buildSnippets } from './search.js';
import { SOURCE_META } from './config.js';

const BASE_URL = (process.env.LMSTUDIO_BASE_URL || 'http://localhost:1234/v1').replace(/\/+$/, '');

/** 回答コンテキストに載せる抜粋の総量（文字数）の上限 */
const CONTEXT_CHAR_BUDGET = Number(process.env.ASK_CONTEXT_CHARS) || 28_000;
/** コンテキストに含める会話数の上限 */
const MAX_CONVERSATIONS = 12;
/** クエリ 1 本あたり採用する上位ヒット数 */
const HITS_PER_QUERY = 8;

/* --------------------------------------------------- LM Studio クライアント */

/** 使用モデルを決める。指定がなければロード済みモデル → モデル一覧の先頭。 */
async function resolveModel() {
  if (process.env.LMSTUDIO_MODEL) return process.env.LMSTUDIO_MODEL;

  // LM Studio 拡張 API でロード済みモデルを探す（JIT ロード待ちを避ける）
  try {
    const res = await fetch(BASE_URL.replace(/\/v1$/, '') + '/api/v0/models');
    if (res.ok) {
      const { data } = await res.json();
      const loaded = (data || []).find((m) => m.state === 'loaded' && m.type === 'llm');
      if (loaded) return loaded.id;
    }
  } catch {
    /* 拡張 API が無いバージョンは無視して /v1/models へ */
  }

  const res = await fetch(`${BASE_URL}/models`);
  if (!res.ok) throw new Error(`LM Studio /models が ${res.status} を返しました`);
  const { data } = await res.json();
  const first = (data || []).find((m) => !/embed/i.test(m.id));
  if (!first) throw new Error('LM Studio に利用可能なモデルがありません。モデルをロードしてください。');
  return first.id;
}

/** /chat/completions を呼ぶ（非ストリーミング）。 */
async function chat(body) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`LM Studio がエラーを返しました (${res.status}): ${detail.slice(0, 300)}`);
  }
  const json = await res.json();
  return json.choices?.[0]?.message?.content ?? '';
}

/* ------------------------------------------------------- 1. クエリ立案 */

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['queries', 'from', 'to'],
  properties: {
    queries: {
      type: 'array',
      minItems: 1,
      maxItems: 6,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['q', 'scope'],
        properties: {
          q: { type: 'string', description: '全文検索クエリ（スペース区切りは AND 条件）' },
          scope: { type: 'string', enum: ['all', 'user', 'assistant'], description: '検索対象の発言者' },
        },
      },
    },
    from: { type: ['string', 'null'], description: '期間の開始日 (YYYY-MM-DD)。期間指定が不要なら null' },
    to: { type: ['string', 'null'], description: '期間の終了日 (YYYY-MM-DD)。不要なら null' },
  },
};

const PLANNER_SYSTEM = `あなたは個人の AI チャット履歴アーカイブ（ChatGPT/Claude/Gemini 等との過去の全会話）を検索するためのクエリプランナーです。
質問に答える根拠を見つけるための全文検索クエリを 2〜6 本立案し、JSON だけを出力してください。

検索エンジンの仕様:
- 単純な部分一致検索。スペース区切りの複数語はすべて含む会話だけがヒットする（AND）
- 日本語はそのまま部分一致、英字は大小無視
- 形態素解析・類義語展開はない。だから 1 クエリは 1〜2 語の短いキーワードにし、代わりに表記ゆれ・類義語・英語/日本語の別表記を別クエリとして並べること

scope の使い分け:
- ユーザー本人の好み・発言・状況を探すなら "user"
- AI の回答内容を探すなら "assistant"
- どちらとも言えなければ "all"

期間 (from/to):
- 「最近」「今月」「去年」など時期を限定する質問のときだけ設定する（「最近」はおおむね直近 2〜3 か月）
- それ以外は null

出力形式（JSON のみ、他のテキスト禁止）:
{"queries": [{"q": "キーワード", "scope": "all"}], "from": null, "to": null}`;

/** テキストから最初の JSON オブジェクトを取り出す（構造化出力が使えないモデル向けの保険）。 */
function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('クエリ立案の応答から JSON を取り出せませんでした。');
  return JSON.parse(text.slice(start, end + 1));
}

/**
 * 質問と対話履歴から検索プランを作る。
 * @returns {Promise<{queries: Array<{q: string, scope: string}>, from: string|null, to: string|null}>}
 */
export async function planQueries(question, history = []) {
  const model = await resolveModel();
  const today = new Date().toISOString().slice(0, 10);
  const recent = history
    .slice(-6)
    .map((t) => `${t.role === 'user' ? 'ユーザー' : 'アシスタント'}: ${String(t.content).slice(0, 400)}`)
    .join('\n');

  const messages = [
    { role: 'system', content: PLANNER_SYSTEM },
    {
      role: 'user',
      content:
        `今日の日付: ${today}\n` +
        (recent ? `これまでの対話:\n${recent}\n\n` : '') +
        `質問: ${question}`,
    },
  ];

  let text;
  try {
    text = await chat({
      model,
      messages,
      temperature: 0.1,
      max_tokens: 2048,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'search_plan', strict: true, schema: PLAN_SCHEMA },
      },
    });
  } catch (err) {
    // 構造化出力に未対応のモデルはプロンプト指示だけで再試行する
    if (!/400|json_schema|response_format/i.test(err.message || '')) throw err;
    text = await chat({ model, messages, temperature: 0.1, max_tokens: 2048 });
  }

  const plan = extractJson(text);
  plan.queries = (plan.queries || []).filter((q) => q && q.q && String(q.q).trim());
  if (!plan.queries.length) plan.queries = [{ q: question.slice(0, 40), scope: 'all' }];
  return plan;
}

/* --------------------------------------------------------- 2. 検索収集 */

/**
 * プランの各クエリを実行し、会話単位で統合したうえで抜粋を作る。
 * @returns {Promise<Array<{n, relPath, title, source, date, snippets}>>}
 */
export async function retrieve(plan) {
  const from = plan.from ? Date.parse(plan.from) : null;
  const to = plan.to ? Date.parse(plan.to) + 86_399_999 : null;

  const byPath = new Map();
  const termByText = new Map();

  const runQuery = (q, scope) => {
    for (const term of parseQuery(q).terms) termByText.set(term.text, term);
    return search(index, {
      q,
      scope: ['user', 'assistant'].includes(scope) ? scope : 'all',
      from: Number.isFinite(from) ? from : null,
      to: Number.isFinite(to) ? to : null,
      sort: 'relevance',
    }).hits;
  };
  const collect = (hits, limit) => {
    for (const hit of hits.slice(0, limit)) {
      const cur = byPath.get(hit.entry.relPath);
      if (cur) cur.score += hit.score + 10; // 複数クエリにヒットした会話を優遇
      else byPath.set(hit.entry.relPath, { ...hit });
    }
  };

  for (const query of plan.queries) {
    const hits = runQuery(query.q, query.scope);
    collect(hits, HITS_PER_QUERY);
    // 複数語 AND で空振りしたクエリは単語ごとに分解して再検索する
    if (!hits.length) {
      const words = parseQuery(query.q).terms.map((t) => t.text);
      if (words.length > 1) {
        for (const word of words) collect(runQuery(word, query.scope), Math.ceil(HITS_PER_QUERY / 2));
      }
    }
  }

  const selected = [...byPath.values()]
    .sort((a, b) => b.score - a.score || b.entry.chatTime - a.entry.chatTime)
    .slice(0, MAX_CONVERSATIONS);

  const terms = [...termByText.values()];
  const built = await buildSnippets(index, selected, terms, { perHit: 4, before: 120, after: 360 });
  let withSnips = built.filter((item) => item.snippets.length);

  // 時期指定の質問（「最近〜」など）でキーワードが空振りしたら、
  // その期間の新しい会話をプレビュー付きで根拠に回す
  if (!withSnips.length && (plan.from || plan.to)) {
    const recentHits = search(index, {
      q: '',
      from: Number.isFinite(from) ? from : null,
      to: Number.isFinite(to) ? to : null,
      sort: 'newest',
    }).hits.slice(0, 8);
    withSnips = recentHits.map(({ entry }) => ({
      ...entry,
      snippets: entry.preview ? [{ text: entry.preview, role: 'user', turnIndex: 0 }] : [],
    }));
  }

  return withSnips.map((item, i) => ({
    n: i + 1,
    relPath: item.relPath,
    title: item.title,
    source: item.source,
    sourceLabel: (SOURCE_META[item.source] || SOURCE_META.unknown).label,
    date: item.chatTime ? new Date(item.chatTime).toISOString().slice(0, 10) : null,
    snippets: item.snippets,
  }));
}

/* ------------------------------------------------------ 3. 回答生成 */

const ANSWER_SYSTEM = `あなたは、ユーザー本人の過去の AI チャット履歴（ChatGPT/Claude/Gemini 等との会話ログ）を根拠に質問へ答えるアシスタントです。

ルール:
- 与えられた抜粋に書かれていることだけを根拠にする。抜粋にない事実を推測で補わない
- 根拠にした会話は文中で [1] [2] のように出典番号で示す
- 抜粋から答えが見つからない・根拠が弱い場合は、その旨を正直に伝える（検索語を変えた質問の提案をしてもよい）
- 発言の時期が意味を持つ質問（「最近〜」など）では日付を添える
- ユーザー本人との対話なので、簡潔で自然な日本語で答える。前置きは不要`;

/** 抜粋一覧を回答用のテキストブロックに整形する（文字数上限で打ち切り）。 */
function buildContext(items) {
  const parts = [];
  let used = 0;
  const kept = [];
  for (const item of items) {
    let block = `[${item.n}] ${item.title}（${item.sourceLabel}${item.date ? `, ${item.date}` : ''}）\n`;
    for (const snip of item.snippets) {
      block += `  - (${snip.role === 'user' ? 'ユーザー' : 'AI'}) ${snip.text}\n`;
    }
    if (used + block.length > CONTEXT_CHAR_BUDGET && kept.length) break;
    parts.push(block);
    kept.push(item);
    used += block.length;
  }
  return { context: parts.join('\n'), kept };
}

/**
 * 回答をストリーミング生成する。
 * @param {string} question
 * @param {Array<{role, content}>} history
 * @param {Array} items retrieve() の結果
 * @param {(text: string) => void} onDelta 逐次テキスト
 * @returns {Promise<{text: string, kept: Array}>}
 */
export async function answerStream(question, history, items, onDelta) {
  const model = await resolveModel();
  const { context, kept } = buildContext(items);

  const userContent = kept.length
    ? `<excerpts>\n${context}</excerpts>\n\n上の抜粋は私の過去のチャット履歴からの検索結果です。これを根拠に答えてください。\n\n質問: ${question}`
    : `私のチャット履歴を検索しましたが、関連する会話は見つかりませんでした。その前提で答えてください。\n\n質問: ${question}`;

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [
        { role: 'system', content: ANSWER_SYSTEM },
        ...history.slice(-10).map((t) => ({ role: t.role, content: String(t.content) })),
        { role: 'user', content: userContent },
      ],
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`LM Studio がエラーを返しました (${res.status}): ${detail.slice(0, 300)}`);
  }

  // OpenAI 互換の SSE ストリームを読み、content の差分だけを流す
  let text = '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      const delta = json.choices?.[0]?.delta?.content;
      if (delta) {
        text += delta;
        onDelta(delta);
      }
    }
  }

  if (!text.trim()) throw new Error('LM Studio から回答が返りませんでした。モデルがロードされているか確認してください。');
  return { text, kept };
}
