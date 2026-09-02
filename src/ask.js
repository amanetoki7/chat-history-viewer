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
 *   LMSTUDIO_BASE_URL … 既定 http://100.77.90.128:1234/v1
 *   LMSTUDIO_MODEL    … 未指定ならロード済みモデルを自動選択
 */

import { index, loadConversation, resolveEntryPath, concatConversation } from './indexer.js';
import { search, parseQuery, buildSnippets } from './search.js';
import { SOURCE_META } from './config.js';
import { embeddingsReady, embedQuery, semanticSearch } from './embeddings.js';
import { resolveModel, chatJson, chatStream } from './llm.js';

/** 回答コンテキストに載せる抜粋の総量（文字数）の上限 */
const CONTEXT_CHAR_BUDGET = Number(process.env.ASK_CONTEXT_CHARS) || 28_000;
/** コンテキストに含める会話数の上限 */
const MAX_CONVERSATIONS = 12;
/** クエリ 1 本あたり採用する上位ヒット数 */
const HITS_PER_QUERY = 8;

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

/**
 * 質問と対話履歴から検索プランを作る。
 * @returns {Promise<{queries: Array<{q: string, scope: string}>, from: string|null, to: string|null}>}
 */
export async function planQueries(question, history = []) {
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

  const plan = await chatJson({ messages, schema: PLAN_SCHEMA, name: 'search_plan', temperature: 0.1, maxTokens: 2048 });
  plan.queries = (plan.queries || []).filter((q) => q && q.q && String(q.q).trim());
  if (!plan.queries.length) plan.queries = [{ q: question.slice(0, 40), scope: 'all' }];
  return plan;
}

/* --------------------------------------------------------- 2. 検索収集 */

/** 意味検索チャンクの原文を読み直して表示用テキストにする。 */
async function extractChunkTexts(entry, chunks, maxChars = 600) {
  const abs = resolveEntryPath(entry.relPath);
  const conv = abs
    ? await loadConversation({ abs, relPath: entry.relPath, title: entry.title, mtimeMs: entry.mtimeMs, size: entry.size })
    : null;
  if (!conv) return [];
  const { buf } = concatConversation(conv);
  return chunks
    .filter((c) => c.end <= buf.length)
    .map((c) => {
      const text = buf.subarray(c.start, c.end).toString('utf8').replace(/\s+/g, ' ').trim();
      return text.length > maxChars ? text.slice(0, maxChars) + '…' : text;
    })
    .filter(Boolean);
}

/**
 * キーワード検索（クエリプラン）と意味検索（埋め込み）を実行し、
 * RRF（Reciprocal Rank Fusion）で会話単位に統合して抜粋を作る。
 * @param {{queries: Array<{q, scope}>, from: string|null, to: string|null}} plan
 * @param {string} question 意味検索に使う自然文（空なら意味検索なし）
 * @returns {Promise<Array<{n, relPath, title, source, date, snippets}>>}
 */
export async function retrieve(plan, question = '', { maxConversations = MAX_CONVERSATIONS, hitsPerQuery = HITS_PER_QUERY, semanticTopK = 20 } = {}) {
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
    collect(hits, hitsPerQuery);
    // 複数語 AND で空振りしたクエリは単語ごとに分解して再検索する
    if (!hits.length) {
      const words = parseQuery(query.q).terms.map((t) => t.text);
      if (words.length > 1) {
        for (const word of words) collect(runQuery(word, query.scope), Math.ceil(hitsPerQuery / 2));
      }
    }
  }

  // 意味検索（埋め込みが構築済みのときだけ）。質問文をそのままベクトル化して
  // 全チャンクと照合し、会話単位に上位チャンクをまとめる
  const semByConv = new Map(); // relPath → {sim, chunks: [{start,end,sim}]}
  if (question && embeddingsReady()) {
    try {
      const qvec = await embedQuery(question);
      for (const hit of semanticSearch(qvec, semanticTopK)) {
        // 期間指定の質問では期間外の会話を混ぜない
        const entry = index.entries.find((e) => e.relPath === hit.relPath);
        if (!entry) continue;
        if (Number.isFinite(from) && entry.chatTime < from) continue;
        if (Number.isFinite(to) && entry.chatTime > to) continue;
        const cur = semByConv.get(hit.relPath);
        if (cur) {
          cur.sim = Math.max(cur.sim, hit.sim);
          if (cur.chunks.length < 2) cur.chunks.push(hit);
        } else {
          semByConv.set(hit.relPath, { sim: hit.sim, chunks: [hit] });
        }
      }
    } catch (err) {
      console.warn('[ask] 意味検索をスキップ:', err.message);
    }
  }

  // RRF でキーワード順位と意味検索順位を融合する
  const RRF_K = 60;
  const fused = new Map(); // relPath → score
  [...byPath.values()]
    .sort((a, b) => b.score - a.score || b.entry.chatTime - a.entry.chatTime)
    .forEach((hit, rank) => fused.set(hit.entry.relPath, (fused.get(hit.entry.relPath) || 0) + 1 / (RRF_K + rank)));
  [...semByConv.entries()]
    .sort((a, b) => b[1].sim - a[1].sim)
    .forEach(([relPath], rank) => fused.set(relPath, (fused.get(relPath) || 0) + 1 / (RRF_K + rank)));

  const entryByPath = new Map(index.entries.map((e) => [e.relPath, e]));
  const chosen = [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxConversations)
    .map(([relPath]) => byPath.get(relPath) || { entry: entryByPath.get(relPath), score: 0 })
    .filter((h) => h.entry);

  // キーワード側のスニペット
  const terms = [...termByText.values()];
  const built = await buildSnippets(index, chosen, terms, { perHit: 4, before: 120, after: 360 });
  const snipsByPath = new Map(built.map((b) => [b.relPath, b.snippets]));

  // 意味検索チャンクの原文をスニペットとして追加する
  for (const hit of chosen) {
    const sem = semByConv.get(hit.entry.relPath);
    if (!sem) continue;
    const texts = await extractChunkTexts(hit.entry, sem.chunks);
    const list = snipsByPath.get(hit.entry.relPath) || [];
    for (const text of texts) {
      if (list.length >= 6) break;
      if (!list.some((s) => s.text.includes(text.slice(0, 80)))) list.push({ text, role: null, turnIndex: -1 });
    }
    snipsByPath.set(hit.entry.relPath, list);
  }

  let withSnips = chosen
    .map((hit) => ({ ...hit.entry, snippets: snipsByPath.get(hit.entry.relPath) || [] }))
    .filter((item) => item.snippets.length);

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
      const label = snip.role === 'user' ? 'ユーザー' : snip.role === 'assistant' ? 'AI' : '抜粋';
      block += `  - (${label}) ${snip.text}\n`;
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

  const text = await chatStream(
    {
      model,
      messages: [
        { role: 'system', content: ANSWER_SYSTEM },
        ...history.slice(-10).map((t) => ({ role: t.role, content: String(t.content) })),
        { role: 'user', content: userContent },
      ],
    },
    onDelta
  );

  if (!text.trim()) throw new Error('LM Studio から回答が返りませんでした。モデルがロードされているか確認してください。');
  return { text, kept };
}
