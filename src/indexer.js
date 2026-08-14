/**
 * チャットファイルの全探索・解析・索引構築。
 *
 * 索引は 2 層で持つ:
 *   - メタデータ（タイトル/日時/ソース等）… JS ヒープ上のオブジェクト配列
 *   - 検索用テキスト … 1 本の巨大な Buffer（ヒープ外）。ASCII 部分のみ小文字化してあり、
 *     バイト長が元テキストと完全に一致するため、一致位置をそのまま原文の位置として使える。
 *
 * 解析結果は .cache/ に保存し、次回起動時は mtime/size が変わっていなければ再利用する。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  CHAT_ROOT,
  CACHE_DIR,
  CACHE_META,
  CACHE_BLOB,
  EXTENSIONS,
  IGNORED_DIRS,
  REQUIRED_PROPERTY,
} from './config.js';
import { parseChatFile, stripDataUriPayloads, normalizeText } from './parser.js';

const CACHE_SEGS = path.join(CACHE_DIR, 'segments.bin');
const CACHE_VERSION = 5;

export const ROLE_CODE = { title: 0, user: 1, assistant: 2, note: 3 };
export const ROLE_NAME = ['title', 'user', 'assistant', 'note'];

/** @type {{entries: any[], blob: Buffer, segments: Int32Array, builtAt: number, root: string}} */
export let index = { entries: [], blob: Buffer.alloc(0), segments: new Int32Array(0), builtAt: 0, root: CHAT_ROOT };

/** フロントマター判定のために先頭だけ読むバイト数。実データは 300 バイト前後。 */
const PROBE_BYTES = 4096;

const PROPERTY_LINE = new RegExp(`^${REQUIRED_PROPERTY}\\s*:\\s*(.*)$`, 'i');
const FRONTMATTER_END = /^(---|\.\.\.)\s*$/;

/** 先頭のフロントマターに値付きの `base` があるか。全文は読まない。 */
function frontmatterHasProperty(head) {
  const text = normalizeText(head);
  if (!text.startsWith('---\n')) return false;
  for (const line of text.slice(4).split('\n')) {
    if (FRONTMATTER_END.test(line)) return false;
    const m = PROPERTY_LINE.exec(line);
    if (m) return m[1].trim() !== '';
  }
  return false; // 4KB 内に見つからなければ対象外
}

async function hasRequiredProperty(abs) {
  let fh;
  try {
    fh = await fs.open(abs, 'r');
    const { buffer, bytesRead } = await fh.read({ buffer: Buffer.alloc(PROBE_BYTES), position: 0 });
    return frontmatterHasProperty(buffer.toString('utf8', 0, bytesRead));
  } catch {
    return false;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/**
 * dir 以下を再帰的に走査してファイル一覧を返す。
 * relPath は base からの相対パスにするため、部分木だけを走査する場合も
 * 索引全体と同じキーが得られる。
 */
async function scanFiles(dir, base = dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const dir = stack.pop();
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      const abs = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        if (!IGNORED_DIRS.has(dirent.name.toLowerCase())) stack.push(abs);
        continue;
      }
      if (!dirent.isFile()) continue;
      const ext = path.extname(dirent.name).toLowerCase();
      if (!EXTENSIONS.has(ext)) continue;
      if (!(await hasRequiredProperty(abs))) continue;
      let st;
      try {
        st = await fs.stat(abs);
      } catch {
        continue;
      }
      out.push({
        abs,
        relPath: path.relative(base, abs).split(path.sep).join('/'),
        title: path.basename(dirent.name, ext),
        mtimeMs: Math.floor(st.mtimeMs),
        size: st.size,
      });
    }
  }
  out.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return out;
}

const NEWLINE = Buffer.from('\n', 'utf8');

/**
 * 会話 1 件を「タイトル + 各ターン本文」を改行で連結した 1 本の Buffer にする。
 *
 * 検索用 blob とスニペット生成の双方が必ずこの関数を通るため、両者のバイト位置は常に一致する。
 * base64 画像の除去もここで行う（表示用の turns[].text には影響しない）。
 *
 * @returns {{buf: Buffer, segs: number[]}} segs は [start, end, roleCode, turnIndex] の並び
 */
export function concatConversation(conv) {
  const parts = [];
  const segs = [];
  let offset = 0;

  const push = (rawText, roleCode, turnIndex) => {
    const buf = Buffer.from(stripDataUriPayloads(rawText), 'utf8');
    parts.push(buf, NEWLINE);
    segs.push(offset, offset + buf.length, roleCode, turnIndex);
    offset += buf.length + NEWLINE.length;
  };

  push(conv.title, ROLE_CODE.title, -1);
  conv.turns.forEach((turn, i) => push(turn.text, ROLE_CODE[turn.role] ?? ROLE_CODE.note, i));

  return { buf: Buffer.concat(parts, offset), segs };
}

/** ASCII の A-Z のみ小文字化する。多バイト文字に触れないためバイト長は不変。 */
export function asciiLowerInPlace(buf) {
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b >= 0x41 && b <= 0x5a) buf[i] = b + 32;
  }
  return buf;
}

/** 会話 1 件分の検索用テキストとセグメント境界を組み立てる。 */
function buildSearchable(conv) {
  const { buf, segs } = concatConversation(conv);
  return { buf: asciiLowerInPlace(buf), segs };
}

/** 解析済み会話から、キャッシュ・API に載せるメタデータだけを抜き出す。 */
function toEntry(conv, blobStart, blobLength, segStart, segCount) {
  return {
    relPath: conv.relPath,
    title: conv.title,
    source: conv.source,
    format: conv.format,
    url: conv.url,
    favorite: conv.favorite,
    archived: conv.archived,
    tags: conv.tags,
    spaceName: conv.spaceName,
    chatTime: conv.chatTime,
    lastTime: conv.lastTime,
    createdAt: conv.createdAt,
    mtimeMs: conv.mtimeMs,
    size: conv.size,
    turnCount: conv.turnCount,
    userTurns: conv.userTurns,
    chars: conv.chars,
    preview: conv.preview,
    blobStart,
    blobLength,
    segStart,
    segCount,
  };
}

/** 1 ファイルを読み込んで解析する。読めない場合は null。 */
export async function loadConversation(file) {
  let raw;
  try {
    raw = await fs.readFile(file.abs, 'utf8');
  } catch {
    return null;
  }
  return parseChatFile(raw, file);
}

/** 全ファイルを解析して索引を構築する。 */
async function buildIndex(files, onProgress) {
  const entries = [];
  const blobParts = [];
  const segParts = [];
  let blobOffset = 0;
  let segOffset = 0;

  for (let i = 0; i < files.length; i++) {
    const conv = await loadConversation(files[i]);
    if (!conv) continue;
    const { buf, segs } = buildSearchable(conv);
    blobParts.push(buf);
    for (const v of segs) segParts.push(v);
    entries.push(toEntry(conv, blobOffset, buf.length, segOffset, segs.length / 4));
    blobOffset += buf.length;
    segOffset += segs.length / 4;
    if (onProgress && (i % 500 === 0 || i === files.length - 1)) onProgress(i + 1, files.length);
  }

  return {
    entries,
    blob: Buffer.concat(blobParts, blobOffset),
    segments: Int32Array.from(segParts),
    builtAt: Date.now(),
    root: CHAT_ROOT,
  };
}

/**
 * 一時ファイルへ書いてから rename する。
 * 監視による更新で稼働中に何度も書き換わるため、途中で落ちても
 * 壊れたキャッシュを残さないようにする。
 */
async function writeAtomic(dest, data) {
  const tmp = `${dest}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, dest);
}

async function saveCache(built, files) {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const meta = {
    version: CACHE_VERSION,
    root: CHAT_ROOT,
    builtAt: built.builtAt,
    blobLength: built.blob.length,
    segCount: built.segments.length / 4,
    files: files.map((f) => [f.relPath, f.mtimeMs, f.size]),
    entries: built.entries,
  };
  const segs = built.segments;
  // 本体を先に確定させ、妥当性の判定材料になるメタデータを最後に置き換える
  await writeAtomic(CACHE_BLOB, built.blob);
  await writeAtomic(CACHE_SEGS, Buffer.from(segs.buffer, segs.byteOffset, segs.byteLength));
  await writeAtomic(CACHE_META, JSON.stringify(meta));
}

/** キャッシュが現在のファイル群と一致していれば読み込む。 */
async function loadCache(files) {
  let meta;
  try {
    meta = JSON.parse(await fs.readFile(CACHE_META, 'utf8'));
  } catch {
    return null;
  }
  if (meta.version !== CACHE_VERSION || meta.root !== CHAT_ROOT) return null;
  if (!Array.isArray(meta.files) || meta.files.length !== files.length) return null;
  for (let i = 0; i < files.length; i++) {
    const [relPath, mtimeMs, size] = meta.files[i];
    if (relPath !== files[i].relPath || mtimeMs !== files[i].mtimeMs || size !== files[i].size) return null;
  }

  try {
    const blob = await fs.readFile(CACHE_BLOB);
    const segBuf = await fs.readFile(CACHE_SEGS);
    if (blob.length !== meta.blobLength) return null;
    if (segBuf.byteLength !== meta.segCount * 16) return null;
    const segments = new Int32Array(segBuf.buffer, segBuf.byteOffset, segBuf.byteLength / 4);
    return { entries: meta.entries, blob, segments, builtAt: meta.builtAt, root: meta.root };
  } catch {
    return null;
  }
}

/* --------------------------------------------------------- 索引の増分更新 */

/**
 * blob と segments は「実体（余白付き）」と「使用中の範囲を指す view」に分けて持つ。
 * index.blob / index.segments は常に view なので、長さもオフセットも従来どおり。
 * 更新されたファイルは末尾に追記し、古い領域は参照されなくなるだけにする
 * （どのエントリも自分の範囲しか見ないため、穴が空いていても検索は壊れない）。
 */
let blobStore = Buffer.alloc(0);
let blobUsed = 0;
let segStore = new Int32Array(0);
let segUsed = 0;
/** 追記・削除で参照されなくなった blob のバイト数 */
let deadBytes = 0;

/** 追記のたびに巨大な再確保をしないよう、余白はまとめて確保する */
const BLOB_GROW_MIN = 8 * 1024 * 1024;
const SEG_GROW_MIN = 16 * 1024;
/** 無駄が大きくなったら詰め直す閾値 */
const COMPACT_MIN_BYTES = 16 * 1024 * 1024;
const COMPACT_RATIO = 0.2;

/** 変更通知の購読者。フロントへ SSE で流すために server.js が使う。 */
const listeners = new Set();

/**
 * 索引が変わったときに呼ばれる関数を登録する。
 * @returns {() => void} 解除する関数
 */
export function onIndexChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emitIndexChange(detail) {
  for (const fn of listeners) {
    try {
      fn(detail);
    } catch {
      /* 購読者の失敗で索引更新を止めない */
    }
  }
}

/** 1 回の通知に載せる変更パスの上限。これを超えたら truncated にする。 */
const MAX_CHANGES = 300;

/** 索引の更新を直列化する（全再構築と監視による増分更新が競合しないように）。 */
let queue = Promise.resolve();
function exclusive(task) {
  const run = queue.then(task, task);
  queue = run.then(
    () => {},
    () => {}
  );
  return run;
}

/** 構築・復元した索引を現在の索引として採用し、増分更新の状態を初期化する。 */
function adoptIndex(built) {
  index = built;
  blobStore = built.blob;
  blobUsed = built.blob.length;
  segStore = built.segments;
  segUsed = built.segments.length;
  deadBytes = 0;
  return built;
}

function publishStores() {
  index.blob = blobStore.subarray(0, blobUsed);
  index.segments = segStore.subarray(0, segUsed);
}

function reserveBlob(extra) {
  if (blobUsed + extra <= blobStore.length) return;
  const next = Buffer.allocUnsafe(Math.max(blobUsed + extra, blobStore.length + Math.max(extra, BLOB_GROW_MIN)));
  blobStore.copy(next, 0, 0, blobUsed);
  blobStore = next;
}

function reserveSegments(extra) {
  if (segUsed + extra <= segStore.length) return;
  const next = new Int32Array(Math.max(segUsed + extra, segStore.length + Math.max(extra, SEG_GROW_MIN)));
  next.set(segStore.subarray(0, segUsed));
  segStore = next;
}

/** relPath の挿入位置を二分探索する。entries は relPath 昇順（scanFiles と同じ順）。 */
function locateEntry(relPath) {
  const entries = index.entries;
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].relPath < relPath) lo = mid + 1;
    else hi = mid;
  }
  return { at: lo, found: lo < entries.length && entries[lo].relPath === relPath };
}

/** 解析済みの会話 1 件を索引へ追加（既にあれば差し替え）する。 */
function putConversation(conv) {
  const { buf, segs } = buildSearchable(conv);

  reserveBlob(buf.length);
  buf.copy(blobStore, blobUsed);
  const blobStart = blobUsed;
  blobUsed += buf.length;

  reserveSegments(segs.length);
  segStore.set(segs, segUsed);
  const segStart = segUsed / 4;
  segUsed += segs.length;

  // 追記からエントリ差し替えまでは同期処理なので、
  // ここで view を貼り替えておけば途中の状態が読まれることはない
  publishStores();

  const entry = toEntry(conv, blobStart, buf.length, segStart, segs.length / 4);
  const { at, found } = locateEntry(conv.relPath);
  if (found) {
    deadBytes += index.entries[at].blobLength;
    index.entries[at] = entry;
  } else {
    index.entries.splice(at, 0, entry);
  }
  return found ? 'updated' : 'added';
}

function dropEntry(relPath) {
  const { at, found } = locateEntry(relPath);
  if (!found) return false;
  deadBytes += index.entries[at].blobLength;
  index.entries.splice(at, 1);
  return true;
}

/** 参照されない領域が増えたら、生きているエントリだけを詰め直す。 */
function compactIfNeeded() {
  if (deadBytes < COMPACT_MIN_BYTES || deadBytes < blobUsed * COMPACT_RATIO) return false;

  let liveBytes = 0;
  let liveSegs = 0;
  for (const e of index.entries) {
    liveBytes += e.blobLength;
    liveSegs += e.segCount * 4;
  }

  const nextBlob = Buffer.allocUnsafe(liveBytes + BLOB_GROW_MIN);
  const nextSeg = new Int32Array(liveSegs + SEG_GROW_MIN);
  let blobOffset = 0;
  let segOffset = 0;
  for (const e of index.entries) {
    blobStore.copy(nextBlob, blobOffset, e.blobStart, e.blobStart + e.blobLength);
    nextSeg.set(segStore.subarray(e.segStart * 4, (e.segStart + e.segCount) * 4), segOffset);
    e.blobStart = blobOffset;
    e.segStart = segOffset / 4;
    blobOffset += e.blobLength;
    segOffset += e.segCount * 4;
  }

  blobStore = nextBlob;
  blobUsed = blobOffset;
  segStore = nextSeg;
  segUsed = segOffset;
  deadBytes = 0;
  return true;
}

/** CHAT_ROOT からの相対パス。ルート外なら null。 */
function toRelPath(abs) {
  const rel = path.relative(CHAT_ROOT, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

function isIgnored(relPath) {
  return relPath.split('/').some((seg) => IGNORED_DIRS.has(seg.toLowerCase()));
}

/**
 * 変更対象の一覧（relPath → ファイル情報 / 削除なら null）を索引へ適用する。
 * @returns {{added: number, updated: number, removed: number, unchanged: number,
 *            changes: Array<{relPath: string, kind: string}>, truncated: boolean}}
 */
async function applyTargets(targets) {
  const result = { added: 0, updated: 0, removed: 0, unchanged: 0, changes: [], truncated: false };

  /** @param {'added'|'updated'|'removed'} kind */
  const note = (relPath, kind) => {
    result[kind]++;
    if (result.changes.length < MAX_CHANGES) result.changes.push({ relPath, kind });
    else result.truncated = true;
  };

  for (const [relPath, file] of targets) {
    if (!file) {
      if (dropEntry(relPath)) note(relPath, 'removed');
      continue;
    }
    const { at, found } = locateEntry(relPath);
    if (found) {
      const cur = index.entries[at];
      if (cur.mtimeMs === file.mtimeMs && cur.size === file.size) {
        result.unchanged++;
        continue;
      }
    }
    const conv = await loadConversation(file);
    if (!conv) {
      if (dropEntry(relPath)) note(relPath, 'removed');
      continue;
    }
    note(relPath, putConversation(conv) === 'added' ? 'added' : 'updated');
  }

  if (result.added || result.updated || result.removed) {
    compactIfNeeded();
    publishStores();
    index.builtAt = Date.now();
    emitIndexChange({ ...result, reason: 'watch' });
  }
  return result;
}

/**
 * 変更のあったパス（ファイル / ディレクトリ / 消えたもの）だけを索引へ反映する。
 * ディレクトリを渡した場合はその配下を再走査し、消えたファイルも取り除く。
 *
 * @param {string[]} paths 絶対パス
 * @returns {Promise<{added: number, updated: number, removed: number, unchanged: number, ms: number}>}
 */
export function updateEntries(paths) {
  return exclusive(async () => {
    const started = Date.now();
    /** @type {Map<string, {abs: string, relPath: string, title: string, mtimeMs: number, size: number} | null>} */
    const targets = new Map();

    for (const raw of new Set(paths)) {
      const abs = path.resolve(raw);
      const rel = toRelPath(abs);
      if (rel === null || isIgnored(rel)) continue;

      const st = await fs.stat(abs).catch(() => null);

      if (st?.isDirectory()) {
        // フォルダの移動・リネームはこのイベントだけが届くことがあるので配下を突き合わせる
        const found = await scanFiles(abs, CHAT_ROOT);
        const alive = new Set(found.map((f) => f.relPath));
        for (const f of found) targets.set(f.relPath, f);
        const prefix = `${rel}/`;
        for (const e of index.entries) {
          if (e.relPath.startsWith(prefix) && !alive.has(e.relPath)) targets.set(e.relPath, null);
        }
        continue;
      }

      if (st?.isFile()) {
        if (!EXTENSIONS.has(path.extname(abs).toLowerCase())) continue;
        // 対象プロパティが外された場合も「索引から消す」変更として扱う
        if (!(await hasRequiredProperty(abs))) {
          targets.set(rel, null);
          continue;
        }
        targets.set(rel, {
          abs,
          relPath: rel,
          title: path.basename(abs, path.extname(abs)),
          mtimeMs: Math.floor(st.mtimeMs),
          size: st.size,
        });
        continue;
      }

      // 消えたパス。ファイルだったかフォルダだったかは分からないので両方を掃除する
      targets.set(rel, null);
      const prefix = `${rel}/`;
      for (const e of index.entries) if (e.relPath.startsWith(prefix)) targets.set(e.relPath, null);
    }

    const result = await applyTargets(targets);
    return { ...result, ms: Date.now() - started };
  });
}

/**
 * ルート全体を走査し直し、差分（追加・更新・削除）だけを索引へ反映する。
 * 監視が途切れて取りこぼした可能性があるときに使う。全再構築より大幅に安い。
 */
export function reconcileIndex({ log = () => {} } = {}) {
  return exclusive(async () => {
    const started = Date.now();
    const files = await scanFiles(CHAT_ROOT, CHAT_ROOT);
    const targets = new Map();

    const seen = new Set();
    for (const f of files) {
      seen.add(f.relPath);
      const { at, found } = locateEntry(f.relPath);
      if (found && index.entries[at].mtimeMs === f.mtimeMs && index.entries[at].size === f.size) continue;
      targets.set(f.relPath, f);
    }
    for (const e of index.entries) if (!seen.has(e.relPath)) targets.set(e.relPath, null);

    if (targets.size) log(`差分 ${targets.size.toLocaleString()} 件を反映します`);
    const result = await applyTargets(targets);
    return { ...result, ms: Date.now() - started };
  });
}

/** 現在の索引を .cache/ へ保存する。 */
export function saveIndexCache() {
  return exclusive(() => saveCache(index, index.entries));
}

/**
 * 索引を用意する。
 * @param {{force?: boolean, log?: (msg: string) => void}} options
 */
export function ensureIndex({ force = false, log = () => {} } = {}) {
  return exclusive(async () => {
    const started = Date.now();
    log(`走査中: ${CHAT_ROOT}`);
    const files = await scanFiles(CHAT_ROOT, CHAT_ROOT);
    log(`対象ファイル ${files.length.toLocaleString()} 件`);
    if (!files.length) {
      adoptIndex({ entries: [], blob: Buffer.alloc(0), segments: new Int32Array(0), builtAt: Date.now(), root: CHAT_ROOT });
      return { index, cached: false, files: 0, ms: Date.now() - started };
    }

    if (!force) {
      const cached = await loadCache(files);
      if (cached) {
        adoptIndex(cached);
        log(`キャッシュから復元 (${(Date.now() - started) / 1000}s)`);
        return { index, cached: true, files: files.length, ms: Date.now() - started };
      }
    }

    log('索引を構築します（初回は数十秒かかります）…');
    const built = await buildIndex(files, (done, total) => {
      if (done % 1000 === 0 || done === total) log(`  解析 ${done.toLocaleString()} / ${total.toLocaleString()}`);
    });
    adoptIndex(built);
    await saveCache(built, files);
    log(`索引構築 完了 (${((Date.now() - started) / 1000).toFixed(1)}s, 検索対象 ${(built.blob.length / 1024 / 1024).toFixed(1)} MB)`);
    // 全再構築は「何が変わったか」を持たないので、まとめて変わったものとして通知する
    emitIndexChange({ added: 0, updated: 0, removed: 0, unchanged: 0, changes: [], truncated: true, reason: 'rebuild' });
    return { index, cached: false, files: files.length, ms: Date.now() - started };
  });
}

/** relPath から絶対パスを得る（ルート外へのアクセスを防ぐ）。 */
export function resolveEntryPath(relPath) {
  const abs = path.resolve(CHAT_ROOT, relPath);
  const rootWithSep = CHAT_ROOT.endsWith(path.sep) ? CHAT_ROOT : CHAT_ROOT + path.sep;
  if (!abs.startsWith(rootWithSep)) return null;
  return abs;
}
