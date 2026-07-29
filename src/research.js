/**
 * Deep リサーチ — チャット履歴を時間をかけて多段調査する非同期ジョブ。
 *
 * 通常の /api/ask が「クエリ立案 → 検索 1 回 → 回答」で数十秒なのに対し、
 * 調査ジョブは調査予算（時間・検索回数・モデル呼び出し回数）の範囲で
 *
 *   1. 調査計画（質問をサブ質問へ分解、JSON Schema 構造化出力）
 *   2. サブ質問ごとに 検索 → 証拠評価 → 不足発見 → 追加クエリで再検索（反復）
 *   3. 横断検証（重複統合・矛盾確認・根拠のない主張の除外）
 *   4. 出典番号つき Markdown レポート生成（ストリーミング）
 *
 * を実行する。ジョブは .cache/research.json に永続化し、プロセス再起動後は
 * 未完了ジョブを再キューする（計画と完了済みサブ質問はチェックポイントから再利用）。
 * LLM はローカルの LM Studio のみを使い、履歴を外部へ送信しない。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { CACHE_DIR, SOURCE_META } from './config.js';
import { index } from './indexer.js';
import { chatJson, chatStream, resolveModel, connectionErrorMessage } from './llm.js';
import { retrieve } from './ask.js';

const JOBS_PATH = path.join(CACHE_DIR, 'research.json');
const JOBS_VERSION = 1;
/** 永続化するジョブ数の上限（古い完了ジョブから削除） */
const MAX_JOBS_KEPT = 30;
const MAX_CONCURRENT = 1;

/** 調査予算。時間だけでなく検索・モデル呼び出し回数でも打ち切る。 */
export const BUDGET = {
  defaultMinutes: 12,
  minMinutes: 3,
  maxMinutes: 20,
  maxSubQuestions: 6,
  /** サブ質問 1 件あたりの 検索→評価 反復回数 */
  maxIterationsPerSubQuestion: 3,
  maxSearches: 40,
  maxModelCalls: 30,
  /** 1 回の証拠評価に渡す候補数 */
  maxCandidatesPerEval: 20,
  maxEvidenceItems: 60,
  /** 検索 1 反復で採用する会話数 */
  maxConversationsPerSearch: 8,
  /** レポート生成のために残す時間 */
  reportReserveMs: 90_000,
};

export const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

class ResearchCancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'ResearchCancelledError';
  }
}

/* ------------------------------------------------------------ ジョブ管理 */

/** id → job。job オブジェクトは実行中も SSE 送信側からも同じ参照を共有する。 */
const jobs = new Map();
let running = 0;
let workerStarted = false;
let loaded = false;
let saveTimer = null;
let savePending = false;

function newId() {
  return `research_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 調査ジョブを作成してキューへ積む。
 * @returns {object} job
 */
export function createResearchJob(question, { budgetMinutes } = {}) {
  const minutes = clamp(Number(budgetMinutes) || BUDGET.defaultMinutes, BUDGET.minMinutes, BUDGET.maxMinutes);
  const job = {
    id: newId(),
    question,
    status: 'queued',
    progress: 0,
    currentStep: '順番を待っています',
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null,
    budgetMs: minutes * 60_000,
    deadline: null,
    cancelRequested: false,
    truncated: false,
    stats: { searches: 0, modelCalls: 0, chunksSeen: 0, iterations: 0, evidence: 0 },
    /** 進捗 UI に出す調査ステップ: {id, label, status: pending|running|done|skipped, queries: string[]} */
    steps: [],
    plan: null,
    /** サブ質問 id → Finding[]（再開用チェックポイント） */
    subResults: {},
    /** 証拠 id → {relPath, title, date, source, role, excerpt} */
    evidence: {},
    evidenceSeq: 0,
    findings: null,
    interimFindings: [],
    report: '',
    sources: [],
    error: null,
  };
  jobs.set(job.id, job);
  scheduleSave();
  return job;
}

export function getJob(id) {
  return jobs.get(id) || null;
}

/** 実行中・待機中のうち最新のジョブ（フロントの再接続用）。 */
export function getActiveJob() {
  let latest = null;
  for (const job of jobs.values()) {
    if (TERMINAL_STATUSES.has(job.status)) continue;
    if (!latest || job.createdAt > latest.createdAt) latest = job;
  }
  return latest;
}

export function cancelJob(id) {
  const job = jobs.get(id);
  if (!job || TERMINAL_STATUSES.has(job.status)) return false;
  if (job.status === 'queued') {
    job.status = 'cancelled';
    job.currentStep = 'キャンセルされました';
    job.completedAt = Date.now();
  } else {
    job.cancelRequested = true;
  }
  scheduleSave(true);
  return true;
}

/** SSE / REST で返す表示用スナップショット（証拠の生データは含めない）。 */
export function jobSnapshot(job) {
  return {
    id: job.id,
    question: job.question,
    status: job.status,
    progress: job.progress,
    currentStep: job.currentStep,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    budgetMs: job.budgetMs,
    elapsedMs: job.startedAt ? (job.completedAt || Date.now()) - job.startedAt : 0,
    stats: job.stats,
    steps: job.steps || [],
    interimFindings: job.interimFindings,
    report: job.report,
    sources: job.sources,
    truncated: job.truncated,
    cancelRequested: job.cancelRequested,
    error: job.error,
  };
}

/* ------------------------------------------------------------ 永続化 */

function scheduleSave(immediate = false) {
  savePending = true;
  if (immediate) {
    clearTimeout(saveTimer);
    saveTimer = null;
    saveJobs().catch((err) => console.warn('[research] 保存に失敗:', err.message));
    return;
  }
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveJobs().catch((err) => console.warn('[research] 保存に失敗:', err.message));
  }, 2000);
}

async function saveJobs() {
  if (!savePending) return;
  savePending = false;

  // 古い完了ジョブから削る
  const all = [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  for (const job of all.slice(MAX_JOBS_KEPT)) {
    if (TERMINAL_STATUSES.has(job.status)) jobs.delete(job.id);
  }

  const data = { version: JOBS_VERSION, jobs: [...jobs.values()] };
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(JOBS_PATH, JSON.stringify(data), 'utf8');
}

async function loadJobs(log) {
  loaded = true;
  let data;
  try {
    data = JSON.parse(await fs.readFile(JOBS_PATH, 'utf8'));
  } catch {
    return;
  }
  if (data.version !== JOBS_VERSION || !Array.isArray(data.jobs)) return;

  let requeued = 0;
  for (const job of data.jobs) {
    if (!job?.id) continue;
    if (!Array.isArray(job.steps)) job.steps = [];
    // 実行途中で落ちたジョブは再キュー。計画・完了済みサブ質問は引き継がれる
    if (!TERMINAL_STATUSES.has(job.status)) {
      job.status = 'queued';
      job.currentStep = '再起動により再開待ちです';
      job.startedAt = null;
      job.deadline = null;
      requeued++;
    }
    jobs.set(job.id, job);
  }
  if (requeued) log?.(`未完了の調査ジョブ ${requeued} 件を再キューしました`);
}

/* ------------------------------------------------------------ Worker */

/** バックグラウンド Worker を起動する（多重起動は無視）。 */
export function startResearchWorker({ log = () => {} } = {}) {
  if (workerStarted) return;
  workerStarted = true;

  (async () => {
    if (!loaded) await loadJobs(log);
    for (;;) {
      try {
        if (running < MAX_CONCURRENT) {
          const job = [...jobs.values()]
            .filter((j) => j.status === 'queued')
            .sort((a, b) => a.createdAt - b.createdAt)[0];
          if (job) {
            running++;
            executeJob(job, log)
              .catch((err) => console.error('[research] ジョブ実行エラー:', err))
              .finally(() => {
                running--;
              });
          }
        }
      } catch (err) {
        console.error('[research] worker error:', err);
      }
      await sleep(1000);
    }
  })();
}

async function executeJob(job, log) {
  job.status = 'planning';
  job.startedAt = Date.now();
  job.deadline = job.startedAt + job.budgetMs;
  job.cancelRequested = false;
  job.error = null;
  scheduleSave(true);
  log(`調査開始: ${job.id} "${job.question.slice(0, 60)}"`);

  try {
    await runResearch(job);
    job.status = 'completed';
    job.progress = 100;
    job.currentStep = '完了';
    log(`調査完了: ${job.id} (${Math.round((Date.now() - job.startedAt) / 1000)}s, 検索 ${job.stats.searches} 回)`);
  } catch (err) {
    if (err instanceof ResearchCancelledError) {
      job.status = 'cancelled';
      job.currentStep = 'キャンセルされました';
      log(`調査キャンセル: ${job.id}`);
    } else {
      job.status = 'failed';
      job.error = connectionErrorMessage(err) || err?.message || '調査に失敗しました。';
      job.currentStep = '失敗';
      console.error('[research] failed:', err);
    }
  } finally {
    job.completedAt = Date.now();
    scheduleSave(true);
  }
}

/* ------------------------------------------------------------ 予算・中断 */

function assertCanContinue(job) {
  if (job.cancelRequested) throw new ResearchCancelledError();
}

function deadlineReached(job, reserveMs = 0) {
  return Date.now() >= job.deadline - reserveMs;
}

function canCallModel(job) {
  return job.stats.modelCalls < BUDGET.maxModelCalls;
}

function update(job, patch) {
  Object.assign(job, patch);
  scheduleSave();
}

/* ------------------------------------------------------------ ステップ記録 */

/** 進捗 UI 用のステップを追加・更新する（同じ id は状態だけ更新）。 */
function upsertStep(job, id, label, status = 'running') {
  let step = job.steps.find((s) => s.id === id);
  if (!step) {
    step = { id, label, status, queries: [] };
    job.steps.push(step);
  } else {
    step.status = status;
  }
  scheduleSave();
  return step;
}

function setStepStatus(job, id, status) {
  const step = job.steps.find((s) => s.id === id);
  if (step) step.status = status;
  scheduleSave();
}

/** ステップの下に、実行した検索ワードを記録する（重複は除く）。 */
function addStepQueries(job, id, queries) {
  const step = job.steps.find((s) => s.id === id);
  if (!step) return;
  for (const q of queries) if (q && !step.queries.includes(q)) step.queries.push(q);
  scheduleSave();
}

/* ------------------------------------------------------------ 1. 調査計画 */

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['goal', 'subQuestions'],
  properties: {
    goal: { type: 'string', description: '調査の目的を一文で' },
    subQuestions: {
      type: 'array',
      minItems: 2,
      maxItems: 6,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['question', 'stepLabel', 'keywordQueries', 'semanticQuery', 'scope', 'from', 'to'],
        properties: {
          question: { type: 'string', description: 'サブ質問（このサブ質問単体で調査できる粒度）' },
          stepLabel: {
            type: 'string',
            description: '進捗画面に表示する短い活動ラベル。「最近の関心の始まりを調べている」のような現在進行形の日本語で 25 字以内',
          },
          keywordQueries: {
            type: 'array',
            minItems: 1,
            maxItems: 4,
            items: { type: 'string' },
            description: '全文検索クエリ。1 本 1〜2 語。表記ゆれ・英語/日本語の別表記を別クエリに',
          },
          semanticQuery: { type: 'string', description: '意味検索用の自然文（1 文）' },
          scope: { type: 'string', enum: ['all', 'user', 'assistant'] },
          from: { type: ['string', 'null'], description: '期間の開始日 (YYYY-MM-DD)。不要なら null' },
          to: { type: ['string', 'null'], description: '期間の終了日 (YYYY-MM-DD)。不要なら null' },
        },
      },
    },
  },
};

const PLANNER_SYSTEM = `あなたは個人の AI チャット履歴アーカイブ（ChatGPT/Claude/Gemini 等との過去の全会話）を深く調査するためのリサーチプランナーです。
質問に本格的に答えるための調査計画を立て、JSON だけを出力してください。

重要: 出力に含むテキスト（goal・question・stepLabel・semanticQuery・keywordQueries）はすべて日本語で書くこと。
画面に表示され、日本語の履歴を検索するため。英語で書いてよいのは、英語表記が一般的な固有名詞・技術用語のキーワードだけ（例: LM Studio, Obsidian）。

計画の立て方:
- 質問を 2〜6 件のサブ質問に分解する。それぞれ独立に検索・検証できる粒度にする
- stepLabel は進捗画面に出す活動ラベル。「〜を調べている」「〜を確認している」のような現在進行形にする
- 時系列の変化を問う質問なら、期間を分けたサブ質問（初期 / 最近など）を作る
- ユーザー本人の好み・経験を問うなら scope を "user" にする
- 「変化の理由」「矛盾の有無」など、単純検索では出ない論点もサブ質問にする

検索エンジンの仕様:
- 単純な部分一致検索。スペース区切りの複数語はすべて含む会話だけがヒットする（AND）
- 形態素解析・類義語展開はない。1 クエリは 1〜2 語の短いキーワードにし、表記ゆれ・類義語・英語/日本語の別表記は別クエリとして並べる
- semanticQuery は埋め込みベースの意味検索に使うので、探したい内容を自然な 1 文で書く`;

async function createPlan(job) {
  const today = new Date().toISOString().slice(0, 10);

  // アーカイブの期間をプランナーへ渡す（時期分割サブ質問の精度向上）
  let earliest = Infinity;
  let latest = -Infinity;
  for (const e of index.entries) {
    if (!e.chatTime) continue;
    if (e.chatTime < earliest) earliest = e.chatTime;
    if (e.chatTime > latest) latest = e.chatTime;
  }
  const range =
    Number.isFinite(earliest) && Number.isFinite(latest)
      ? `アーカイブの期間: ${new Date(earliest).toISOString().slice(0, 10)} 〜 ${new Date(latest).toISOString().slice(0, 10)}（${index.entries.length.toLocaleString()} 件の会話）\n`
      : '';

  job.stats.modelCalls++;
  const plan = await chatJson({
    messages: [
      { role: 'system', content: PLANNER_SYSTEM },
      { role: 'user', content: `今日の日付: ${today}\n${range}\n調査する質問: ${job.question}` },
    ],
    schema: PLAN_SCHEMA,
    name: 'research_plan',
    temperature: 0.2,
    maxTokens: 4096,
  });

  plan.subQuestions = (plan.subQuestions || [])
    .filter((sq) => sq && sq.question && Array.isArray(sq.keywordQueries) && sq.keywordQueries.length)
    .slice(0, BUDGET.maxSubQuestions)
    .map((sq, i) => ({
      id: `q${i + 1}`,
      question: String(sq.question),
      stepLabel: String(sq.stepLabel || '').trim() || String(sq.question),
      keywordQueries: sq.keywordQueries.map(String).filter(Boolean).slice(0, 4),
      semanticQuery: String(sq.semanticQuery || sq.question),
      scope: ['user', 'assistant'].includes(sq.scope) ? sq.scope : 'all',
      from: sq.from || null,
      to: sq.to || null,
    }));

  if (!plan.subQuestions.length) {
    plan.subQuestions = [
      {
        id: 'q1',
        question: job.question,
        keywordQueries: [job.question.slice(0, 40)],
        semanticQuery: job.question,
        scope: 'all',
        from: null,
        to: null,
      },
    ];
  }
  return plan;
}

/* ------------------------------------------------------- 2. 反復調査 */

const EVAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings', 'remainingGaps', 'followUpQueries', 'sufficient'],
  properties: {
    findings: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'evidenceIds', 'confidence'],
        properties: {
          claim: { type: 'string', description: '証拠から言える主張（1 文）' },
          evidenceIds: { type: 'array', minItems: 1, items: { type: 'string' }, description: '根拠となる証拠候補の id' },
          confidence: { type: 'number', description: '確度 0〜1' },
        },
      },
    },
    remainingGaps: { type: 'array', maxItems: 4, items: { type: 'string' }, description: 'まだ答えられていない点' },
    followUpQueries: {
      type: 'array',
      maxItems: 4,
      items: { type: 'string' },
      description: '不足を埋めるための追加検索キーワード（1 本 1〜2 語）',
    },
    sufficient: { type: 'boolean', description: 'サブ質問に十分答えられるなら true' },
  },
};

const EVALUATOR_SYSTEM = `あなたは調査アシスタントです。個人の AI チャット履歴から集めた抜粋を証拠として評価します。

重要: 出力（claim・remainingGaps・followUpQueries）はすべて日本語で書くこと。
followUpQueries のみ、英語表記が一般的な固有名詞・技術用語は英語可（例: LM Studio, Obsidian）。

ルール:
- findings の claim は、抜粋に実際に書かれていることだけから作る。推測で補わない
- 各 claim の evidenceIds には、その claim を実際に支える抜粋の id だけを挙げる
- ユーザー本人の好み・経験・状況を問う調査では「(ユーザー)」の発言を重視する。AI の応答・仮定の話・引用・第三者の話は根拠として弱いので confidence を下げる
- 発言の時期が意味を持つ場合は claim に時期を含める（例:「2026年春以降〜が増えた」）
- まだ答えられていない点を remainingGaps に挙げる
- followUpQueries は不足を埋める全文検索キーワード。1 本 1〜2 語で、表記ゆれ・英語/日本語の別表記も考慮する
- 抜粋だけでサブ質問に十分答えられるなら sufficient を true にする

JSON のみを出力してください。`;

/** 検索 1 反復分の証拠候補を集める。既出のものは除外する。 */
async function collectCandidates(job, subQuestion, queries, semanticQuery, seenKeys) {
  const plan = {
    queries: queries.map((q) => ({ q, scope: subQuestion.scope })),
    from: subQuestion.from,
    to: subQuestion.to,
  };
  const items = await retrieve(plan, semanticQuery, {
    maxConversations: BUDGET.maxConversationsPerSearch,
  });
  job.stats.searches += queries.length;

  const candidates = [];
  for (const item of items) {
    for (const snip of item.snippets) {
      job.stats.chunksSeen++;
      const excerpt = String(snip.text || '').slice(0, 400);
      const key = `${item.relPath}:${excerpt.replace(/\s+/g, '').slice(0, 80)}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      if (Object.keys(job.evidence).length + candidates.length >= BUDGET.maxEvidenceItems + 40) break;
      candidates.push({
        id: `e${++job.evidenceSeq}`,
        relPath: item.relPath,
        title: item.title,
        date: item.date,
        source: item.source,
        role: snip.role,
        excerpt,
      });
    }
  }
  return candidates.slice(0, BUDGET.maxCandidatesPerEval);
}

/** 証拠候補を LLM に評価させ、findings と不足を得る。 */
async function evaluateEvidence(job, subQuestion, candidates) {
  const listing = candidates
    .map((c) => {
      const speaker = c.role === 'user' ? 'ユーザー' : c.role === 'assistant' ? 'AI' : '抜粋';
      return `[${c.id}] ${c.date || '日付不明'} / 会話「${c.title}」 / 発言者: ${speaker}\n「${c.excerpt}」`;
    })
    .join('\n\n');

  job.stats.modelCalls++;
  const result = await chatJson({
    messages: [
      { role: 'system', content: EVALUATOR_SYSTEM },
      {
        role: 'user',
        content: `調査全体の質問: ${job.question}\nサブ質問: ${subQuestion.question}\n\n証拠候補:\n${listing}`,
      },
    ],
    schema: EVAL_SCHEMA,
    name: 'evidence_evaluation',
    temperature: 0.1,
    maxTokens: 4096,
  });

  const byId = new Map(candidates.map((c) => [c.id, c]));
  const findings = [];
  for (const f of result.findings || []) {
    if (!f?.claim) continue;
    const ids = (f.evidenceIds || []).filter((id) => byId.has(id));
    if (!ids.length) continue; // 引用監査: 実在する証拠の裏づけがない主張は捨てる
    for (const id of ids) {
      if (!job.evidence[id]) {
        job.evidence[id] = byId.get(id);
        job.stats.evidence++;
      }
    }
    findings.push({
      claim: String(f.claim),
      evidenceIds: ids,
      contradictingEvidenceIds: [],
      confidence: clamp(Number(f.confidence) || 0.5, 0, 1),
    });
  }

  return {
    findings,
    remainingGaps: (result.remainingGaps || []).map(String).filter(Boolean).slice(0, 4),
    followUpQueries: (result.followUpQueries || []).map(String).filter(Boolean).slice(0, 4),
    sufficient: result.sufficient === true,
  };
}

/** 同一主張の findings を統合する（正規化した claim の一致で判定）。 */
function mergeFindings(base, extra) {
  const norm = (s) => s.replace(/\s+/g, '').toLowerCase();
  const merged = [...base];
  for (const f of extra) {
    const hit = merged.find((m) => norm(m.claim) === norm(f.claim));
    if (hit) {
      hit.evidenceIds = [...new Set([...hit.evidenceIds, ...f.evidenceIds])];
      hit.confidence = Math.max(hit.confidence, f.confidence);
    } else {
      merged.push(f);
    }
  }
  return merged.slice(0, 12);
}

/** サブ質問 1 件を、検索 → 評価 → 不足発見 → 再検索 のループで調査する。 */
async function investigateSubQuestion(job, subQuestion) {
  let queries = subQuestion.keywordQueries;
  let semanticQuery = subQuestion.semanticQuery;
  let findings = [];
  const seenKeys = new Set();

  for (let iteration = 0; iteration < BUDGET.maxIterationsPerSubQuestion; iteration++) {
    assertCanContinue(job);
    if (deadlineReached(job, BUDGET.reportReserveMs) || job.stats.searches >= BUDGET.maxSearches || !canCallModel(job)) {
      job.truncated = true;
      break;
    }

    addStepQueries(job, subQuestion.id, queries);
    update(job, { currentStep: `「${queries[0]}」${queries.length > 1 ? 'などで' : 'で'}検索している` });
    const candidates = await collectCandidates(job, subQuestion, queries, semanticQuery, seenKeys);
    job.stats.iterations++;
    if (!candidates.length) break; // 新しい情報が増えない

    assertCanContinue(job);
    update(job, { currentStep: '集めた抜粋から根拠を評価している' });
    const evaluated = await evaluateEvidence(job, subQuestion, candidates);
    findings = mergeFindings(findings, evaluated.findings);

    if (evaluated.sufficient || !evaluated.followUpQueries.length) break;
    queries = evaluated.followUpQueries;
    semanticQuery = evaluated.remainingGaps[0] || semanticQuery;
  }

  return findings;
}

/* ------------------------------------------------------- 3. 横断検証 */

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'evidenceIds', 'contradictingEvidenceIds', 'confidence'],
        properties: {
          claim: { type: 'string' },
          evidenceIds: { type: 'array', minItems: 1, items: { type: 'string' } },
          contradictingEvidenceIds: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'number' },
        },
      },
    },
  },
};

const VERIFIER_SYSTEM = `あなたは調査結果の検証担当です。複数のサブ調査から集まった主張（findings）と証拠を横断して整理します。

重要: 主張（claim）はすべて日本語で書くこと。

ルール:
- 同じ内容の主張は 1 つに統合する（evidenceIds もまとめる）
- 互いに矛盾する主張があれば、片方の contradictingEvidenceIds に相手側の証拠 id を入れ、confidence を下げる
- evidenceIds は入力に実在する id だけを使う。証拠のない主張は出力しない
- 主張は重要なものから並べる

JSON のみを出力してください。`;

async function verifyFindings(job, allFindings) {
  const listing = allFindings
    .map((f, i) => {
      const refs = f.evidenceIds
        .map((id) => {
          const ev = job.evidence[id];
          return ev ? `[${id}] ${ev.date || ''}「${ev.excerpt.slice(0, 160)}」` : null;
        })
        .filter(Boolean)
        .join('\n    ');
      return `${i + 1}. ${f.claim}（確度 ${f.confidence.toFixed(2)}）\n    ${refs}`;
    })
    .join('\n');

  job.stats.modelCalls++;
  const result = await chatJson({
    messages: [
      { role: 'system', content: VERIFIER_SYSTEM },
      { role: 'user', content: `調査の質問: ${job.question}\n\n主張と証拠:\n${listing}` },
    ],
    schema: VERIFY_SCHEMA,
    name: 'verified_findings',
    temperature: 0.1,
    maxTokens: 4096,
  });

  const verified = [];
  for (const f of result.findings || []) {
    if (!f?.claim) continue;
    const ids = (f.evidenceIds || []).filter((id) => job.evidence[id]);
    if (!ids.length) continue; // 引用監査
    verified.push({
      claim: String(f.claim),
      evidenceIds: ids,
      contradictingEvidenceIds: (f.contradictingEvidenceIds || []).filter((id) => job.evidence[id]),
      confidence: clamp(Number(f.confidence) || 0.5, 0, 1),
    });
  }
  return verified.length ? verified : allFindings;
}

/* ------------------------------------------------------- 4. レポート生成 */

const REPORT_SYSTEM = `あなたは、ユーザー本人の過去の AI チャット履歴を調査した結果を Markdown レポートにまとめるアシスタントです。

ルール:
- 与えられた調査結果（主張と根拠抜粋）に書かれていることだけを使う。推測を書く場合は推測だと明示する
- 根拠にした会話は文中で [1] [2] のように出典番号で示す（根拠に付いている出典番号をそのまま使う）
- 「## 見出し」を使ったレポート形式で書く: 概要 → 論点ごとの節 → まとめ
- 発言の時期が意味を持つ場合は日付を添える
- 矛盾する証拠があれば正直に触れる
- 根拠が見つからなかった論点は「確認できなかった」と正直に書く
- ユーザー本人向けの自然な日本語で書く`;

/** 検証済み findings から出典番号を割り当て、レポート用コンテキストを組み立てる。 */
function buildReportContext(job, findings) {
  const sourceByPath = new Map(); // relPath → n
  const sources = [];

  const sourceNum = (relPath) => {
    if (sourceByPath.has(relPath)) return sourceByPath.get(relPath);
    const ev = Object.values(job.evidence).find((e) => e.relPath === relPath);
    const n = sources.length + 1;
    sourceByPath.set(relPath, n);
    sources.push({
      n,
      relPath,
      title: ev?.title || relPath,
      source: ev?.source || 'unknown',
      sourceLabel: (SOURCE_META[ev?.source] || SOURCE_META.unknown).label,
      date: ev?.date || null,
    });
    return n;
  };

  const blocks = findings.map((f, i) => {
    const refs = f.evidenceIds
      .map((id) => {
        const ev = job.evidence[id];
        if (!ev) return null;
        const speaker = ev.role === 'user' ? 'ユーザー' : ev.role === 'assistant' ? 'AI' : '抜粋';
        return `  - [${sourceNum(ev.relPath)}] ${ev.date || '日付不明'}（${speaker}）「${ev.excerpt}」`;
      })
      .filter(Boolean)
      .join('\n');
    const contra = f.contradictingEvidenceIds
      .map((id) => {
        const ev = job.evidence[id];
        return ev ? `  - [${sourceNum(ev.relPath)}] ${ev.date || ''}「${ev.excerpt.slice(0, 200)}」` : null;
      })
      .filter(Boolean)
      .join('\n');
    return (
      `${i + 1}. 主張: ${f.claim}（確度 ${f.confidence.toFixed(2)}）\n根拠:\n${refs}` +
      (contra ? `\n矛盾する証拠:\n${contra}` : '')
    );
  });

  return { context: blocks.join('\n\n'), sources };
}

async function writeReport(job, findings) {
  const model = await resolveModel();
  const today = new Date().toISOString().slice(0, 10);
  const { context, sources } = buildReportContext(job, findings);
  job.sources = sources;

  const planText = job.plan
    ? `調査の目的: ${job.plan.goal}\nサブ質問:\n${job.plan.subQuestions.map((sq) => `- ${sq.question}`).join('\n')}\n\n`
    : '';

  const note = job.truncated
    ? '\n\n注意: 調査予算（時間または回数）の上限に達したため、レポートの冒頭で「確認できた範囲でまとめた」ことを一言断ってください。'
    : '';

  const userContent = findings.length
    ? `今日の日付: ${today}\n\n${planText}検証済みの調査結果:\n${context}\n\n上の調査結果を根拠に、質問「${job.question}」への調査レポートを書いてください。${note}`
    : `質問「${job.question}」についてチャット履歴を調査しましたが、根拠となる会話を見つけられませんでした。その旨を正直に伝え、検索語を変えた質問の提案があれば添えてください。${note}`;

  job.stats.modelCalls++;
  const text = await chatStream(
    {
      model,
      messages: [
        { role: 'system', content: REPORT_SYSTEM },
        { role: 'user', content: userContent },
      ],
    },
    (delta) => {
      if (job.cancelRequested) throw new ResearchCancelledError();
      job.report += delta;
      scheduleSave();
    }
  );

  if (!text.trim()) throw new Error('LM Studio からレポートが返りませんでした。モデルがロードされているか確認してください。');
  job.report = text;
}

/* ------------------------------------------------------- 実行本体 */

/** 途中経過（上位 findings の要約）を更新する。 */
function updateInterim(job) {
  const all = job.findings || Object.values(job.subResults).flat();
  job.interimFindings = [...all]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5)
    .map((f) => ({ claim: f.claim, confidence: f.confidence, evidenceCount: f.evidenceIds.length }));
}

async function runResearch(job) {
  // 1. 調査計画（再開時はチェックポイントを再利用）
  if (!job.plan) {
    update(job, { status: 'planning', progress: 4, currentStep: '調査の計画を立てている' });
    upsertStep(job, 'plan', '調査の計画を立てている');
    job.plan = await createPlan(job);
    setStepStatus(job, 'plan', 'done');
    for (const sq of job.plan.subQuestions) upsertStep(job, sq.id, sq.stepLabel || sq.question, 'pending');
    scheduleSave(true);
  }
  assertCanContinue(job);

  // 2. サブ質問ごとの反復調査
  const subQuestions = job.plan.subQuestions;
  for (let i = 0; i < subQuestions.length; i++) {
    const sq = subQuestions[i];
    if (job.subResults[sq.id]) {
      setStepStatus(job, sq.id, 'done'); // 再開時: 調査済み
      continue;
    }
    assertCanContinue(job);
    if (deadlineReached(job, BUDGET.reportReserveMs) || job.stats.searches >= BUDGET.maxSearches || !canCallModel(job)) {
      job.truncated = true;
      break;
    }

    update(job, {
      status: 'searching',
      progress: 8 + Math.round((i / subQuestions.length) * 60),
      currentStep: sq.stepLabel || sq.question,
    });
    upsertStep(job, sq.id, sq.stepLabel || sq.question, 'running');

    job.subResults[sq.id] = await investigateSubQuestion(job, sq);
    setStepStatus(job, sq.id, 'done');
    updateInterim(job);
    scheduleSave(true);
  }

  // 予算切れで着手できなかったサブ質問
  for (const step of job.steps) if (step.status === 'pending') step.status = 'skipped';

  const allFindings = Object.values(job.subResults).flat();
  assertCanContinue(job);

  // 3. 横断検証（時間・予算が残っているときだけ）
  let verified = allFindings;
  if (allFindings.length >= 2 && canCallModel(job) && !deadlineReached(job, BUDGET.reportReserveMs / 2)) {
    update(job, { status: 'verifying', progress: 74, currentStep: '根拠の統合と矛盾を確認している' });
    upsertStep(job, 'verify', '根拠の統合と矛盾を確認している');
    verified = await verifyFindings(job, allFindings);
    setStepStatus(job, 'verify', 'done');
  }
  job.findings = verified;
  updateInterim(job);
  assertCanContinue(job);

  // 4. レポート生成（ストリーミングで job.report に流し込む）
  update(job, { status: 'writing', progress: 86, currentStep: 'レポートを執筆している', report: '' });
  upsertStep(job, 'write', '最終レポートを作成している');
  await writeReport(job, verified);
  setStepStatus(job, 'write', 'done');
}
