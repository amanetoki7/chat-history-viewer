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
import { CHAT_ROOT, CACHE_DIR, CACHE_META, CACHE_BLOB, EXTENSIONS, IGNORED_DIRS } from './config.js';
import { parseChatFile, stripDataUriPayloads } from './parser.js';

const CACHE_SEGS = path.join(CACHE_DIR, 'segments.bin');
const CACHE_VERSION = 4;

export const ROLE_CODE = { title: 0, user: 1, assistant: 2, note: 3 };
export const ROLE_NAME = ['title', 'user', 'assistant', 'note'];

/** @type {{entries: any[], blob: Buffer, segments: Int32Array, builtAt: number, root: string}} */
export let index = { entries: [], blob: Buffer.alloc(0), segments: new Int32Array(0), builtAt: 0, root: CHAT_ROOT };

/** ルート以下を再帰的に走査してファイル一覧を返す。 */
async function scanFiles(root) {
  const out = [];
  const stack = [root];
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
      let st;
      try {
        st = await fs.stat(abs);
      } catch {
        continue;
      }
      out.push({
        abs,
        relPath: path.relative(root, abs).split(path.sep).join('/'),
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
  await fs.writeFile(CACHE_META, JSON.stringify(meta), 'utf8');
  await fs.writeFile(CACHE_BLOB, built.blob);
  await fs.writeFile(CACHE_SEGS, Buffer.from(built.segments.buffer, 0, built.segments.byteLength));
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
    const segments = new Int32Array(segBuf.buffer, segBuf.byteOffset, segBuf.byteLength / 4);
    return { entries: meta.entries, blob, segments, builtAt: meta.builtAt, root: meta.root };
  } catch {
    return null;
  }
}

/**
 * 索引を用意する。
 * @param {{force?: boolean, log?: (msg: string) => void}} options
 */
export async function ensureIndex({ force = false, log = () => {} } = {}) {
  const started = Date.now();
  log(`走査中: ${CHAT_ROOT}`);
  const files = await scanFiles(CHAT_ROOT);
  log(`対象ファイル ${files.length.toLocaleString()} 件`);
  if (!files.length) {
    index = { entries: [], blob: Buffer.alloc(0), segments: new Int32Array(0), builtAt: Date.now(), root: CHAT_ROOT };
    return { index, cached: false, files: 0, ms: Date.now() - started };
  }

  if (!force) {
    const cached = await loadCache(files);
    if (cached) {
      index = cached;
      log(`キャッシュから復元 (${(Date.now() - started) / 1000}s)`);
      return { index, cached: true, files: files.length, ms: Date.now() - started };
    }
  }

  log('索引を構築します（初回は数十秒かかります）…');
  const built = await buildIndex(files, (done, total) => {
    if (done % 1000 === 0 || done === total) log(`  解析 ${done.toLocaleString()} / ${total.toLocaleString()}`);
  });
  index = built;
  await saveCache(built, files);
  log(`索引構築 完了 (${((Date.now() - started) / 1000).toFixed(1)}s, 検索対象 ${(built.blob.length / 1024 / 1024).toFixed(1)} MB)`);
  return { index, cached: false, files: files.length, ms: Date.now() - started };
}

/** relPath から絶対パスを得る（ルート外へのアクセスを防ぐ）。 */
export function resolveEntryPath(relPath) {
  const abs = path.resolve(CHAT_ROOT, relPath);
  const rootWithSep = CHAT_ROOT.endsWith(path.sep) ? CHAT_ROOT : CHAT_ROOT + path.sep;
  if (!abs.startsWith(rootWithSep)) return null;
  return abs;
}
