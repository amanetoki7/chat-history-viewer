/**
 * チャット履歴を根拠に自然言語の質問へ答える RAG パイプライン。
 *
 * 流れ:
 *   1. Claude が質問から全文検索クエリを立案（構造化出力）
 *   2. 既存の索引 (search.js) で関連会話を横断検索し、抜粋を収集
 *   3. 抜粋を根拠として Claude がストリーミングで回答（出典番号つき）
 *
 * 認証は ANTHROPIC_API_KEY（または `ant auth login` のプロファイル）を使う。
 */

import Anthropic from '@anthropic-ai/sdk';
import { index } from './indexer.js';
import { search, parseQuery, buildSnippets } from './search.js';
import { SOURCE_META } from './config.js';

const MODEL = 'claude-opus-5';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** 回答コンテキストに載せる抜粋の総量（文字数）の上限 */
const CONTEXT_CHAR_BUDGET = 28_000;
/** コンテキストに含める会話数の上限 */
const MAX_CONVERSATIONS = 12;
/** クエリ 1 本あたり採用する上位ヒット数 */
const HITS_PER_QUERY = 8;

const client = new Anthropic();

/* ------------------------------------------------------- 1. クエリ立案 */

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['queries', 'from', 'to'],
  properties: {
    queries: {
      type: 'array',
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
    from: { anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }], description: '期間の開始日 (YYYY-MM-DD)。期間指定が不要なら null' },
    to: { anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }], description: '期間の終了日 (YYYY-MM-DD)。不要なら null' },
  },
};

const PLANNER_SYSTEM = `あなたは個人の AI チャット履歴アーカイブ（ChatGPT/Claude/Gemini 等との過去の全会話）を検索するためのクエリプランナーです。
質問に答える根拠を見つけるための全文検索クエリを 2〜6 本立案してください。

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
- それ以外は null`;

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

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 8000,
    betas: [FALLBACK_BETA],
    fallbacks: 'default',
    system: PLANNER_SYSTEM,
    output_config: { format: { type: 'json_schema', schema: PLAN_SCHEMA } },
    messages: [
      {
        role: 'user',
        content:
          `今日の日付: ${today}\n` +
          (recent ? `これまでの対話:\n${recent}\n\n` : '') +
          `質問: ${question}`,
      },
    ],
  });

  if (response.stop_reason === 'refusal') throw new Error('クエリ立案が拒否されました。質問を変えてお試しください。');
  const text = response.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('クエリ立案の応答が空でした。');
  const plan = JSON.parse(text);
  plan.queries = (plan.queries || []).filter((q) => q.q && q.q.trim());
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

  for (const query of plan.queries) {
    for (const term of parseQuery(query.q).terms) termByText.set(term.text, term);
    const { hits } = search(index, {
      q: query.q,
      scope: ['user', 'assistant'].includes(query.scope) ? query.scope : 'all',
      from: Number.isFinite(from) ? from : null,
      to: Number.isFinite(to) ? to : null,
      sort: 'relevance',
    });
    for (const hit of hits.slice(0, HITS_PER_QUERY)) {
      const cur = byPath.get(hit.entry.relPath);
      if (cur) cur.score += hit.score + 10; // 複数クエリにヒットした会話を優遇
      else byPath.set(hit.entry.relPath, { ...hit });
    }
  }

  const selected = [...byPath.values()]
    .sort((a, b) => b.score - a.score || b.entry.chatTime - a.entry.chatTime)
    .slice(0, MAX_CONVERSATIONS);

  const terms = [...termByText.values()];
  const items = await buildSnippets(index, selected, terms, { perHit: 4, before: 120, after: 360 });

  return items
    .filter((item) => item.snippets.length)
    .map((item, i) => ({
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
  const { context, kept } = buildContext(items);

  const userContent = kept.length
    ? `<excerpts>\n${context}</excerpts>\n\n上の抜粋は私の過去のチャット履歴からの検索結果です。これを根拠に答えてください。\n\n質問: ${question}`
    : `私のチャット履歴を検索しましたが、関連する会話は見つかりませんでした。その前提で答えてください。\n\n質問: ${question}`;

  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    betas: [FALLBACK_BETA],
    fallbacks: 'default',
    system: ANSWER_SYSTEM,
    messages: [
      ...history.slice(-10).map((t) => ({ role: t.role, content: String(t.content) })),
      { role: 'user', content: userContent },
    ],
  });

  stream.on('text', (delta) => onDelta(delta));

  const message = await stream.finalMessage();
  if (message.stop_reason === 'refusal') throw new Error('回答が安全性の理由で中断されました。質問を変えてお試しください。');

  const text = message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return { text, kept };
}
