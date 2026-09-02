/**
 * 会話埋め込みの構築・キャッシュ・意味検索。
 *
 * LM Studio の埋め込みモデル（OpenAI 互換 /v1/embeddings）で会話をチャンク単位で
 * ベクトル化し、.cache/ に保存する。検索はメモリ上でコサイン類似度（正規化済み
 * ベクトルの内積）を総当たりで計算する。すべてローカルで完結する。
 *
 * チャンクは concatConversation() のバイトオフセットで持つ。ファイルの
 * mtime/size が変わらない限りオフセットは原文と一致するため、キャッシュの
 * 有効判定と同じ条件でそのまま原文抽出に使える。
 *
 * 環境変数:
 *   LMSTUDIO_EMBED_MODEL … 未指定なら既定モデル（ruri-v3）→ embed を含む id の順に自動選択
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { CACHE_DIR } from './config.js';
import { index, loadConversation, resolveEntryPath, concatConversation } from './indexer.js';

const BASE_URL = (process.env.LMSTUDIO_BASE_URL || 'http://100.77.90.128:1234/v1').replace(/\/+$/, '');
const META_PATH = path.join(CACHE_DIR, 'embeddings.json');
const BIN_PATH = path.join(CACHE_DIR, 'embeddings.bin');
const VERSION = 1;

/** チャンクの目安サイズ（バイト）。これを超えたら区切る */
const CHUNK_BYTES = 2000;
/** 1 ターンがこれを超える場合は分割する */
const CHUNK_MAX = 3000;
/** 長いターンを分割するときの重なり（バイト） */
const CHUNK_OVERLAP = 200;
/** /v1/embeddings 1 リクエストに載せるチャンク数 */
const BATCH = 64;
/** 1 バッチあたりの試行回数（瞬断や過負荷で全体を捨てないため） */
const EMBED_ATTEMPTS = 4;
/** 再試行の初回待ち時間。失敗のたびに倍にする */
const RETRY_BASE_MS = 1000;
/**
 * 1 リクエストの上限時間。
 * Node の既定（ヘッダ待ち 300s）だと、応答が返らないまま固まったときに
 * 5 分ブロックしてしまう。実測は 64 チャンクで数秒なので十分な余裕。
 */
const REQUEST_TIMEOUT_MS = 120_000;

const state = {
  model: null,
  dim: 0,
  /** relPath → {mtimeMs, size, chunks: [[start,end],...], vecs: Float32Array[]} */
  files: new Map(),
  loaded: false,
  building: false,
  /** 構築中に新たな変更が届いたか（終わり次第もう一度回す） */
  rerun: false,
  filesDone: 0,
  filesTotal: 0,
  lastError: null,
};

/* ------------------------------------------------------------ LM Studio */

/** 日本語検索に強い Ruri v3 を優先して使う */
const PREFERRED_EMBED_MODEL = 'text-embedding-ruri-v3-310m';

async function resolveEmbedModel() {
  if (process.env.LMSTUDIO_EMBED_MODEL) return process.env.LMSTUDIO_EMBED_MODEL;
  const res = await fetch(`${BASE_URL}/models`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`LM Studio /models が ${res.status} を返しました`);
  const { data } = await res.json();
  const ids = (data || []).map((x) => x.id);
  if (ids.includes(PREFERRED_EMBED_MODEL)) return PREFERRED_EMBED_MODEL;
  const m = ids.find((id) => /embed/i.test(id));
  if (!m) throw new Error('LM Studio に埋め込みモデルがありません。ruri-v3 などをダウンロードしてください。');
  return m;
}

/** 埋め込みモデルごとのタスク接頭辞（付けると検索精度が上がる） */
function docPrefix() {
  const m = state.model || '';
  if (/ruri/i.test(m)) return '検索文書: ';
  if (/nomic/i.test(m)) return 'search_document: ';
  return '';
}
function queryPrefix() {
  const m = state.model || '';
  if (/ruri/i.test(m)) return '検索クエリ: ';
  if (/nomic/i.test(m)) return 'search_query: ';
  return '';
}

/**
 * fetch の失敗は message が "fetch failed" だけで原因が分からないため、
 * err.cause（ECONNREFUSED / ECONNRESET / UND_ERR_HEADERS_TIMEOUT など）まで見せる。
 */
function describeError(err) {
  if (err?.name === 'TimeoutError') return `応答なし (${REQUEST_TIMEOUT_MS / 1000}s でタイムアウト)`;
  const cause = err?.cause;
  const detail = cause?.code || cause?.errors?.find((e) => e?.code)?.code || cause?.message;
  return detail ? `${err.message} (${detail})` : err.message || String(err);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalize(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  s = Math.sqrt(s) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= s;
  return v;
}

/** テキスト配列を 1 リクエストで埋め込む。返り値は正規化済み Float32Array の配列。 */
async function embedOnce(texts) {
  const res = await fetch(`${BASE_URL}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: state.model, input: texts }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`LM Studio /embeddings がエラー (${res.status}): ${detail.slice(0, 200)}`);
  }
  const json = await res.json();
  const out = new Array(texts.length);
  for (const d of json.data) out[d.index] = normalize(Float32Array.from(d.embedding));
  if (!state.dim && out[0]) state.dim = out[0].length;
  return out;
}

/**
 * バッチ 1 つを、瞬断を挟んでも諦めずに埋め込む。
 *
 * 10,000 件規模の構築は数十分かかるので、途中の 1 リクエストが
 * ネットワークの瞬断（fetch failed）や一時的な過負荷で落ちただけで
 * 全体を捨てないよう、指数バックオフで再試行する。
 * それでも駄目ならバッチを半分に割って試す（本文が長すぎる場合の保険）。
 */
async function embed(texts, log = () => {}) {
  let wait = RETRY_BASE_MS;
  for (let attempt = 1; ; attempt++) {
    try {
      return await embedOnce(texts);
    } catch (err) {
      if (attempt < EMBED_ATTEMPTS) {
        log(`  埋め込みリクエスト失敗 (${describeError(err)}) — ${wait / 1000}s 後に再試行 ${attempt}/${EMBED_ATTEMPTS - 1}`);
        await sleep(wait);
        wait *= 2;
        continue;
      }
      if (texts.length === 1) throw err;
      const mid = Math.ceil(texts.length / 2);
      log(`  埋め込みリクエスト失敗 (${describeError(err)}) — ${texts.length} 件を ${mid} 件ずつに分割して再試行`);
      const head = await embed(texts.slice(0, mid), log);
      const tail = await embed(texts.slice(mid), log);
      return [...head, ...tail];
    }
  }
}

/* ---------------------------------------------------------- チャンク分割 */

function alignStart(buf, i) {
  let p = Math.max(0, i);
  while (p > 0 && (buf[p] & 0xc0) === 0x80) p--;
  return p;
}
function alignEnd(buf, i) {
  let p = Math.min(buf.length, i);
  while (p < buf.length && (buf[p] & 0xc0) === 0x80) p++;
  return p;
}

/**
 * 会話をターン境界を尊重しつつ CHUNK_BYTES 前後のチャンクに割る。
 * @returns {{buf: Buffer, chunks: Array<[number, number]>}}
 */
export function chunkConversation(conv) {
  const { buf, segs } = concatConversation(conv);
  const chunks = [];
  let curStart = -1;
  let curEnd = -1;

  const flush = () => {
    if (curStart !== -1 && curEnd > curStart) chunks.push([curStart, curEnd]);
    curStart = -1;
    curEnd = -1;
  };

  for (let s = 0; s < segs.length; s += 4) {
    const segStart = segs[s];
    const segEnd = segs[s + 1];
    if (segEnd - segStart <= 0) continue;

    if (segEnd - segStart > CHUNK_MAX) {
      flush();
      let p = segStart;
      while (p < segEnd) {
        const e = alignEnd(buf, Math.min(p + CHUNK_BYTES, segEnd));
        chunks.push([alignStart(buf, p), e]);
        if (e >= segEnd) break;
        const next = alignStart(buf, e - CHUNK_OVERLAP);
        p = next > p ? next : e;
      }
      continue;
    }

    if (curStart === -1) {
      curStart = segStart;
      curEnd = segEnd;
    } else if (segEnd - curStart > CHUNK_BYTES) {
      flush();
      curStart = segStart;
      curEnd = segEnd;
    } else {
      curEnd = segEnd;
    }
  }
  flush();

  return {
    buf,
    chunks: chunks.filter(([s, e]) => buf.subarray(s, e).toString('utf8').trim().length >= 10),
  };
}

/** チャンクの埋め込み入力テキスト。2 番目以降はタイトルを添えて文脈を補う。 */
function docText(title, buf, start, end, chunkIndex) {
  const body = buf.subarray(start, end).toString('utf8');
  return docPrefix() + (chunkIndex > 0 ? `【${title}】\n${body}` : body);
}

/* ------------------------------------------------------------- キャッシュ */

async function saveCache() {
  const files = [];
  const buffers = [];
  for (const [relPath, f] of state.files) {
    if (f.vecs.some((v) => !v)) continue; // 埋め込み未完了のファイルは保存しない（次回再試行）
    files.push([relPath, f.mtimeMs, f.size, f.chunks]);
    for (const v of f.vecs) buffers.push(Buffer.from(v.buffer, v.byteOffset, v.byteLength));
  }
  const meta = { version: VERSION, model: state.model, dim: state.dim, files };
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(BIN_PATH, Buffer.concat(buffers));
  await fs.writeFile(META_PATH, JSON.stringify(meta), 'utf8');
}

async function loadCache(model) {
  state.loaded = true;
  let meta;
  try {
    meta = JSON.parse(await fs.readFile(META_PATH, 'utf8'));
  } catch {
    return;
  }
  if (meta.version !== VERSION || meta.model !== model || !meta.dim) return;

  let bin;
  try {
    bin = await fs.readFile(BIN_PATH);
  } catch {
    return;
  }
  const totalChunks = meta.files.reduce((n, [, , , chunks]) => n + chunks.length, 0);
  if (bin.length !== totalChunks * meta.dim * 4) return;

  // 1 つの ArrayBuffer に載せ替えて、各チャンクはその view として持つ
  const all = new Float32Array(bin.length / 4);
  Buffer.from(all.buffer).set(bin);

  let off = 0;
  for (const [relPath, mtimeMs, size, chunks] of meta.files) {
    const vecs = chunks.map(() => {
      const v = all.subarray(off, off + meta.dim);
      off += meta.dim;
      return v;
    });
    state.files.set(relPath, { mtimeMs, size, chunks, vecs });
  }
  state.dim = meta.dim;
}

/* ------------------------------------------------------------- 構築 */

/**
 * 索引 (index.entries) に合わせて埋め込みを増分構築する。
 *
 * 構築中に呼ばれた場合は「終わったらもう一度」だけを記録して即座に戻る。
 * 監視によるファイル変更が構築中に届いても取りこぼさないようにするため。
 * 失敗しても例外は投げず status に記録する。
 */
export async function ensureEmbeddings(options = {}) {
  if (state.building) {
    state.rerun = true;
    return;
  }
  for (;;) {
    state.rerun = false;
    await buildEmbeddings(options);
    if (!state.rerun) return;
    // 再実行は増分のみでよい（force は初回で消化済み）
    options = { ...options, force: false };
  }
}

async function buildEmbeddings({ force = false, log = () => {} } = {}) {
  state.building = true;
  state.lastError = null;
  try {
    const model = await resolveEmbedModel();
    if (!state.loaded && !force) await loadCache(model);
    if (force || (state.model && state.model !== model)) {
      state.files.clear();
      state.dim = 0;
    }
    state.model = model;

    // 索引から消えたファイルを落とす
    const wanted = new Set(index.entries.map((e) => e.relPath));
    let dropped = 0;
    for (const key of [...state.files.keys()]) {
      if (!wanted.has(key)) {
        state.files.delete(key);
        dropped++;
      }
    }

    const todo = index.entries.filter((e) => {
      const f = state.files.get(e.relPath);
      return !f || f.mtimeMs !== e.mtimeMs || f.size !== e.size;
    });
    state.filesTotal = todo.length;
    state.filesDone = 0;
    if (!todo.length) {
      // 削除だけだった場合もキャッシュを書き直す（消えた会話が検索に残らないように）
      if (dropped) {
        await saveCache();
        log(`埋め込みから ${dropped} 件を削除しました`);
      } else {
        log(`埋め込みは最新です (${totalChunks()} チャンク, model: ${model})`);
      }
      return;
    }
    log(`埋め込みを構築します: ${todo.length.toLocaleString()} 件 (model: ${model})`);

    let queue = []; // {rec, i, text}
    const flushQueue = async () => {
      if (!queue.length) return;
      const batch = queue;
      queue = [];
      const vecs = await embed(batch.map((b) => b.text), log);
      batch.forEach((b, j) => {
        b.rec.vecs[b.i] = vecs[j];
      });
    };

    const started = Date.now();
    let lastSave = Date.now();
    for (let n = 0; n < todo.length; n++) {
      const entry = todo[n];
      const abs = resolveEntryPath(entry.relPath);
      const conv = abs
        ? await loadConversation({ abs, relPath: entry.relPath, title: entry.title, mtimeMs: entry.mtimeMs, size: entry.size })
        : null;
      if (conv) {
        const { buf, chunks } = chunkConversation(conv);
        const rec = { mtimeMs: entry.mtimeMs, size: entry.size, chunks, vecs: new Array(chunks.length) };
        chunks.forEach(([s, e], i) => queue.push({ rec, i, text: docText(conv.title, buf, s, e, i) }));
        state.files.set(entry.relPath, rec);
      }
      while (queue.length >= BATCH) await flushQueue();
      state.filesDone = n + 1;
      if ((n + 1) % 500 === 0) log(`  埋め込み ${(n + 1).toLocaleString()} / ${todo.length.toLocaleString()}`);
      if (Date.now() - lastSave > 120_000) {
        await flushQueue();
        await saveCache();
        lastSave = Date.now();
      }
    }
    await flushQueue();
    await saveCache();
    log(`埋め込み構築 完了 (${totalChunks().toLocaleString()} チャンク, ${((Date.now() - started) / 1000).toFixed(0)}s)`);
  } catch (err) {
    state.lastError = describeError(err);
    // 途中で落ちたファイルは vecs が欠けたまま state に残る。消しておかないと
    // 次の増分構築で mtime/size が一致して「済み」と見なされ、再起動するまで
    // 二度と埋め込まれない（キャッシュにも保存されないので検索から消える）。
    let incomplete = 0;
    for (const [relPath, f] of state.files) {
      if (f.vecs.some((v) => !v)) {
        state.files.delete(relPath);
        incomplete++;
      }
    }
    log(`埋め込み構築に失敗: ${state.lastError}${incomplete ? `（未完了の ${incomplete} 件は次回やり直します）` : ''}`);
  } finally {
    state.building = false;
  }
}

/* ------------------------------------------------------------- 検索 */

function totalChunks() {
  let n = 0;
  for (const f of state.files.values()) n += f.chunks.length;
  return n;
}

export function embeddingsReady() {
  return state.dim > 0 && state.files.size > 0;
}

export function embeddingsStatus() {
  return {
    ready: embeddingsReady(),
    building: state.building,
    model: state.model,
    dim: state.dim,
    files: state.files.size,
    chunks: totalChunks(),
    progress: state.building ? { done: state.filesDone, total: state.filesTotal } : null,
    lastError: state.lastError,
  };
}

/** 質問文を埋め込む。 */
export async function embedQuery(text) {
  if (!state.model) state.model = await resolveEmbedModel();
  const [vec] = await embed([queryPrefix() + String(text).slice(0, 2000)]);
  return vec;
}

/**
 * 全チャンクとの内積で上位 topK を返す。
 * @returns {Array<{relPath: string, start: number, end: number, sim: number}>}
 */
export function semanticSearch(qvec, topK = 16, minSim = 0.4) {
  const dim = state.dim;
  if (!dim || !qvec) return [];
  const top = [];
  let floor = minSim;

  for (const [relPath, f] of state.files) {
    for (let c = 0; c < f.chunks.length; c++) {
      const v = f.vecs[c];
      if (!v) continue;
      let s = 0;
      for (let i = 0; i < dim; i++) s += qvec[i] * v[i];
      if (s <= floor) continue;
      top.push({ relPath, chunk: f.chunks[c], sim: s });
      if (top.length >= topK * 2) {
        top.sort((a, b) => b.sim - a.sim);
        top.length = topK;
        floor = Math.max(minSim, top[topK - 1].sim);
      }
    }
  }

  top.sort((a, b) => b.sim - a.sim);
  return top.slice(0, topK).map((t) => ({ relPath: t.relPath, start: t.chunk[0], end: t.chunk[1], sim: t.sim }));
}
