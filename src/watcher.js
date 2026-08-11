/**
 * CHAT_ROOT 配下の追加・変更・削除を監視し、索引と埋め込みへ即座に反映する。
 *
 * fs.watch の再帰監視（Windows / macOS でネイティブ対応）で 1 本のハンドルだけを使い、
 * 届いたパスをまとめて indexer の増分更新へ渡す。エディタの保存は 1 回でも複数の
 * イベントを生むため、少し待って束ねてから適用する。
 *
 * 反映の順番:
 *   1. 索引（全文検索）… その場で更新。数十 ms で検索に反映される
 *   2. 埋め込み（意味検索）… 変更されたファイルだけ LM Studio でベクトル化
 *   3. .cache への保存 … 100MB 級の書き出しなので、落ち着いてからまとめて
 *
 * 環境変数:
 *   CHV_WATCH=0 … 監視を無効にする
 */

import fs from 'node:fs';
import path from 'node:path';
import { CHAT_ROOT, IGNORED_DIRS } from './config.js';
import { updateEntries, reconcileIndex, saveIndexCache } from './indexer.js';
import { ensureEmbeddings } from './embeddings.js';

/** 保存直後の連続イベントを束ねる待ち時間 */
const DEBOUNCE_MS = 700;
/** 変更が続いていても、この間隔では必ず反映する */
const MAX_WAIT_MS = 5000;
/** 索引キャッシュの書き出しは変更が止まってから */
const PERSIST_IDLE_MS = 15_000;
/** 監視が落ちたときの再開待ち（指数バックオフ） */
const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 60_000;

/** エディタや同期ツールの一時ファイル */
const TEMP_FILE = /(^~|^\.~|\.tmp$|\.temp$|\.swp$|\.crswap$|\.partial$)/i;

const state = {
  enabled: false,
  watching: false,
  root: CHAT_ROOT,
  pending: 0,
  lastEventAt: null,
  lastAppliedAt: null,
  /** 直近に反映した内容 {added, updated, removed, ms} */
  lastChange: null,
  error: null,
};

let log = () => {};
let watcher = null;
let retryMs = RETRY_MIN_MS;

/** 未反映のパス。null 相当の全体再走査は fullPending で持つ。 */
const pending = new Set();
let fullPending = false;
let batchTimer = null;
let batchStartedAt = 0;
let persistTimer = null;
let persistNeeded = false;
/** 反映処理を直列に並べる */
let chain = Promise.resolve();

/* ------------------------------------------------------------ イベント収集 */

function ignorable(relPath) {
  const parts = relPath.split(/[\\/]/);
  if (parts.some((seg) => IGNORED_DIRS.has(seg.toLowerCase()))) return true;
  return TEMP_FILE.test(parts[parts.length - 1] || '');
}

function onEvent(filename) {
  state.lastEventAt = Date.now();
  if (filename == null) {
    // パスが取れないイベント。取りこぼしを避けるため全体を突き合わせる
    fullPending = true;
  } else {
    const rel = String(filename);
    if (ignorable(rel)) return;
    pending.add(path.resolve(CHAT_ROOT, rel));
  }
  scheduleBatch();
}

function scheduleBatch() {
  state.pending = pending.size;
  const now = Date.now();
  if (!batchStartedAt) batchStartedAt = now;
  if (batchTimer) clearTimeout(batchTimer);
  // 保存が続いている間も MAX_WAIT_MS で一度は反映する
  const wait = Math.max(0, Math.min(DEBOUNCE_MS, batchStartedAt + MAX_WAIT_MS - now));
  batchTimer = setTimeout(runBatch, wait);
  batchTimer.unref?.();
}

function runBatch() {
  batchTimer = null;
  batchStartedAt = 0;
  const paths = [...pending];
  const full = fullPending;
  pending.clear();
  fullPending = false;
  state.pending = 0;
  if (!full && !paths.length) return;

  chain = chain.then(() => apply(paths, full)).catch((err) => log(`反映に失敗: ${err.message}`));
}

/* ---------------------------------------------------------------- 反映 */

async function apply(paths, full) {
  const result = full ? await reconcileIndex({ log }) : await updateEntries(paths);
  state.lastAppliedAt = Date.now();

  const changed = result.added + result.updated + result.removed;
  if (!changed) return;

  state.lastChange = result;
  log(`索引を更新: 追加 ${result.added} / 変更 ${result.updated} / 削除 ${result.removed} (${result.ms}ms)`);

  persistNeeded = true;
  schedulePersist();

  // 埋め込みは変更されたファイルだけを見る（LM Studio が居なければ status に記録されるだけ）
  await ensureEmbeddings({ log: (m) => log(`[embed] ${m}`) });
}

function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    chain = chain.then(persistNow).catch((err) => log(`索引キャッシュの保存に失敗: ${err.message}`));
  }, PERSIST_IDLE_MS);
  persistTimer.unref?.();
}

async function persistNow() {
  if (!persistNeeded) return;
  persistNeeded = false;
  const started = Date.now();
  await saveIndexCache();
  log(`索引キャッシュを保存しました (${Date.now() - started}ms)`);
}

/* ---------------------------------------------------------------- 監視本体 */

function startNativeWatcher({ reconcile }) {
  try {
    watcher = fs.watch(CHAT_ROOT, { recursive: true, persistent: true }, (_event, filename) => onEvent(filename));
  } catch (err) {
    state.watching = false;
    state.error = err.message;
    log(`監視を開始できません (${err.message}) — ${Math.round(retryMs / 1000)} 秒後に再試行します`);
    setTimeout(() => {
      retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
      startNativeWatcher({ reconcile: true });
    }, retryMs).unref?.();
    return;
  }

  watcher.on('error', (err) => {
    state.watching = false;
    state.error = err.message;
    log(`監視が停止しました (${err.message}) — 再開します`);
    watcher?.close();
    watcher = null;
    setTimeout(() => {
      retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
      startNativeWatcher({ reconcile: true });
    }, retryMs).unref?.();
  });

  state.watching = true;
  state.error = null;
  retryMs = RETRY_MIN_MS;
  log(`監視中: ${CHAT_ROOT}`);

  // 監視が途切れていた間の変更を拾い直す
  if (reconcile) {
    fullPending = true;
    scheduleBatch();
  }
}

/**
 * 監視を開始する。
 * @param {{log?: (msg: string) => void}} options
 */
export function startWatcher({ log: logger = () => {} } = {}) {
  if (state.enabled) return state;
  if (process.env.CHV_WATCH === '0') {
    log = logger;
    log('監視は無効です (CHV_WATCH=0)');
    return state;
  }
  log = logger;
  state.enabled = true;
  startNativeWatcher({ reconcile: false });

  // 終了時、未保存の索引があれば書き出してから落とす
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      if (!persistNeeded) process.exit(0);
      log('索引キャッシュを保存しています…');
      persistNow()
        .catch(() => {})
        .finally(() => process.exit(0));
    });
  }
  return state;
}

export function stopWatcher() {
  watcher?.close();
  watcher = null;
  if (batchTimer) clearTimeout(batchTimer);
  if (persistTimer) clearTimeout(persistTimer);
  batchTimer = null;
  persistTimer = null;
  state.enabled = false;
  state.watching = false;
}

export function watcherStatus() {
  return { ...state };
}

/** 監視とは別に、いま一度だけ全体を突き合わせる（起動直後や手動実行用）。 */
export function requestReconcile() {
  fullPending = true;
  scheduleBatch();
}
