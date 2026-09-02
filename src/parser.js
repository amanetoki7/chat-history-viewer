/**
 * Obsidian にエクスポートされた各種 AI チャットの Markdown を
 * 共通の「会話 (turns)」構造へ変換するパーサ。
 *
 * 対応フォーマットは 3 種類:
 *   marker … `# you asked` / `# xxx response` で発言が区切られる（ChatGPT / Claude / Gemini / Google AI / Perplexity Exporter）
 *   thread … H1 が質問、以降が回答。`## Sources` / `## Related Questions` で回答が閉じる（Perplexity Threads）
 *   plain  … 区切りの無い単一本文（LM Studio など）
 */

import { FOLDER_SOURCE_HINTS } from './config.js';

const USER_MARKER = /^# you asked\s*$/;
// 実データ上のマーカーはすべて小文字。誤検出を避けるため文字種と長さを絞る。
const RESPONSE_MARKER = /^# ([a-z0-9][a-z0-9 ._-]{0,24}) response\s*$/;
const MESSAGE_TIME = /^message time:\s*(.+?)\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HR_LINE = /^\s*-{3,}\s*$/;
const H1 = /^# (.+?)\s*$/;
const THREAD_CLOSER = /^## (Sources|Related Questions|参考文献|関連する質問)\s*$/i;

/**
 * ファイル名（拡張子なし）から表示用のタイトルを復元する。
 *
 * エクスポータは元のタイトルの空白と `\/:*?"<>|` をまとめて `_` に潰すので、
 * 復元できるのは空白だけになる。ただし数字に挟まれた `_` は `16_9`（元は `16:9`）や
 * `192.168.0.0_24` のように空白でなかった可能性が高いため、そのまま残す。
 */
export function titleFromFilename(name) {
  return name
    .replace(/_+/g, (run, at) => {
      const prev = name[at - 1];
      const next = name[at + run.length];
      return prev >= '0' && prev <= '9' && next >= '0' && next <= '9' ? run : ' ';
    })
    .trim();
}

/** 改行コードを LF に統一し、BOM を除去する。 */
export function normalizeText(raw) {
  let text = raw.replace(/\r\n?/g, '\n');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  // 一部ファイルに NUL が混入しているため落とす
  text = text.replace(/\u0000/g, '\uFFFD');
  return text;
}

const B64_MARK = 'base64,';
const MIN_B64_RUN = 200;

const isB64Char = (c) =>
  (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47 || c === 61;

/**
 * 貼り付けられた画像の base64 本体を取り除く。
 *
 * 実データではこれが索引全体の約 6 割を占めるうえ、検索対象としては無意味で
 * 誤ヒットの温床にもなる。表示用のターン本文には手を加えないため、
 * チャット画面では画像がそのまま描画される。
 *
 * 正規表現だと数 MB の連続一致でスタックを溢れさせるので、手動で走査する。
 */
export function stripDataUriPayloads(text) {
  let at = text.indexOf(B64_MARK);
  if (at === -1) return text;

  let out = '';
  let last = 0;
  while (at !== -1) {
    const start = at + B64_MARK.length;
    let end = start;
    while (end < text.length && isB64Char(text.charCodeAt(end))) end++;
    if (end - start >= MIN_B64_RUN) {
      out += text.slice(last, start);
      last = end;
    }
    at = text.indexOf(B64_MARK, Math.max(end, start));
  }
  return out + text.slice(last);
}

/**
 * Markdown の画像記法（![alt](src)）の src を抜き出す正規表現。
 * `<src>` 囲いと後続のタイトルは無視する。src が空のものには一致しない。
 */
export const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?/g;

/** テキストに含まれる Markdown 画像の数。 */
export function countMarkdownImages(text) {
  let count = 0;
  MARKDOWN_IMAGE_RE.lastIndex = 0;
  while (MARKDOWN_IMAGE_RE.exec(text)) count++;
  return count;
}

/**
 * 先頭の YAML フロントマターを取り出す。
 * 完全な YAML ではなく、実データに出現する `key: value` 形式のみを解釈する。
 */
export function parseFrontmatter(text) {
  if (!text.startsWith('---\n')) return { data: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: text };
  const block = text.slice(4, end);
  // 閉じ `---` の行末まで読み飛ばす
  const afterFence = text.indexOf('\n', end + 1);
  const body = afterFence === -1 ? '' : text.slice(afterFence + 1);

  const data = {};
  for (const line of block.split('\n')) {
    const m = /^([A-Za-z][A-Za-z0-9 _-]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    data[m[1].trim()] = parseScalar(m[2]);
  }
  return { data, body };
}

function parseScalar(rawValue) {
  const value = rawValue.trim();
  if (value === '' || value === '""' || value === "''") return '';
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === '[]') return [];
  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }
  // ダブルクォート囲みは JSON として読む（Title は `\"` や `\n` を含みうる）。
  // JSON として不正なものは、囲みを外すだけの従来動作に落とす。
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === 'string') return parsed;
    } catch {
      /* 素朴な引用符剥がしに任せる */
    }
  }
  return value.replace(/^["']|["']$/g, '');
}

/** コードフェンスの内側にある行を除外しながら走査するためのヘルパ。 */
function* walkLines(lines) {
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = FENCE.exec(line);
    if (m) {
      if (fence === null) fence = m[1][0];
      else if (m[1][0] === fence) fence = null;
      yield { i, line, inFence: true };
      continue;
    }
    yield { i, line, inFence: fence !== null };
  }
}

/** 末尾の区切り線 (`----`) と余分な空白を落とす。 */
function trimBlock(text) {
  const lines = text.split('\n');
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length && HR_LINE.test(lines[lines.length - 1])) {
    lines.pop();
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  }
  while (lines.length && lines[0].trim() === '') lines.shift();
  return lines.join('\n');
}

/** ブロック先頭の `message time:` 行を取り出す。 */
function extractMessageTime(block) {
  const lines = block.split('\n');
  let idx = 0;
  while (idx < lines.length && lines[idx].trim() === '') idx++;
  const m = idx < lines.length ? MESSAGE_TIME.exec(lines[idx]) : null;
  if (!m) return { time: null, text: block };
  return { time: m[1], text: trimBlock(lines.slice(idx + 1).join('\n')) };
}

/** `# you asked` / `# xxx response` 形式 */
function parseMarkerFormat(body) {
  const lines = body.split('\n');
  const marks = [];
  for (const { i, line, inFence } of walkLines(lines)) {
    if (inFence) continue;
    if (USER_MARKER.test(line)) {
      marks.push({ line: i, role: 'user', model: null });
      continue;
    }
    const m = RESPONSE_MARKER.exec(line);
    if (m) marks.push({ line: i, role: 'assistant', model: m[1] });
  }
  if (!marks.length) return null;

  const turns = [];
  const preamble = trimBlock(lines.slice(0, marks[0].line).join('\n'));
  if (preamble) turns.push({ role: 'note', model: null, time: null, text: preamble });

  for (let k = 0; k < marks.length; k++) {
    const start = marks[k].line + 1;
    const end = k + 1 < marks.length ? marks[k + 1].line : lines.length;
    const { time, text } = extractMessageTime(trimBlock(lines.slice(start, end).join('\n')));
    if (!text && !time) continue;
    turns.push({ role: marks[k].role, model: marks[k].model, time, text });
  }
  return turns.length ? turns : null;
}

/**
 * Perplexity Threads 形式。
 * H1 は「新しい質問」だが、貼り付けられた長文プロンプト内にも H1 が現れる。
 * 直前の H1 以降に `## Sources` / `## Related Questions` が出ていれば
 * 回答が閉じたと判断し、そこで初めて次の H1 を新しいターンとみなす。
 */
function parseThreadFormat(body) {
  const lines = body.split('\n');
  const heads = [];
  let closedSinceLastHead = true;
  let sawCloser = false;

  for (const { i, line, inFence } of walkLines(lines)) {
    if (inFence) continue;
    if (THREAD_CLOSER.test(line)) {
      closedSinceLastHead = true;
      sawCloser = true;
      continue;
    }
    const m = H1.exec(line);
    if (!m) continue;
    if (heads.length === 0 || closedSinceLastHead) {
      heads.push({ line: i, title: m[1] });
      closedSinceLastHead = false;
    }
  }
  // H1 が 1 つあるだけの単なる見出し付き文書（LM Studio 等）を誤検出しないよう、
  // 複数ターンか、出典セクションがある場合のみスレッドとみなす。
  if (heads.length < 2 && !sawCloser) return null;

  const turns = [];
  for (let k = 0; k < heads.length; k++) {
    const answerStart = heads[k].line + 1;
    const answerEnd = k + 1 < heads.length ? heads[k + 1].line : lines.length;
    let cursor = answerStart;
    while (cursor < answerEnd && lines[cursor].trim() === '') cursor++;
    turns.push({ role: 'user', model: null, time: null, text: heads[k].title });
    const answer = trimBlock(lines.slice(cursor, answerEnd).join('\n'));
    if (answer) turns.push({ role: 'assistant', model: null, time: null, text: answer });
  }
  return turns;
}

/** 区切りの無い単一本文 */
function parsePlainFormat(body, fallbackTitle) {
  const lines = body.split('\n');
  let start = 0;
  while (start < lines.length && lines[start].trim() === '') start++;
  const m = start < lines.length ? H1.exec(lines[start]) : null;
  let title = null;
  if (m) {
    title = m[1];
    start++;
  }
  const text = trimBlock(lines.slice(start).join('\n'));
  if (!text) return null;
  return {
    title: title || fallbackTitle,
    turns: [{ role: 'assistant', model: null, time: null, text }],
  };
}

/** 回答本文から Sources / Related Questions セクションを切り出す。 */
export function splitThreadSections(text) {
  const lines = text.split('\n');
  const bounds = [];
  for (const { i, line, inFence } of walkLines(lines)) {
    if (inFence) continue;
    const m = THREAD_CLOSER.exec(line);
    if (m) bounds.push({ line: i, kind: /sources|参考文献/i.test(m[1]) ? 'sources' : 'related' });
  }
  if (!bounds.length) return { body: text, sources: null, related: null };

  const result = { body: trimBlock(lines.slice(0, bounds[0].line).join('\n')), sources: null, related: null };
  for (let k = 0; k < bounds.length; k++) {
    const from = bounds[k].line + 1;
    const to = k + 1 < bounds.length ? bounds[k + 1].line : lines.length;
    const section = trimBlock(lines.slice(from, to).join('\n'));
    if (section) result[bounds[k].kind] = section;
  }
  return result;
}

function normalizeSource(value, relPath) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw && raw !== '""') {
    if (raw.includes('google')) return 'google_ai_mode';
    if (raw.includes('lm') && raw.includes('studio')) return 'lmstudio';
    return raw.replace(/\s+/g, '_');
  }
  const hay = relPath.toLowerCase();
  for (const [needle, source] of FOLDER_SOURCE_HINTS) {
    if (hay.includes(needle)) return source;
  }
  return 'unknown';
}

/** `2025-10-20T04:10:59` / `2025-10-20 04:10:59` を epoch ms に。 */
export function toEpoch(value) {
  if (!value) return null;
  const s = String(value).trim().replace(' ', 'T');
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 1 ファイルを解析して会話オブジェクトを返す。
 * @param {string} raw     ファイル内容
 * @param {object} ctx     { relPath, title, mtimeMs, size }
 */
export function parseChatFile(raw, ctx) {
  const text = normalizeText(raw);
  const { data, body } = parseFrontmatter(text);

  let format = 'marker';
  let turns = parseMarkerFormat(body);
  let plainTitle = null;

  if (!turns) {
    turns = parseThreadFormat(body);
    format = 'thread';
  }
  if (!turns) {
    const plain = parsePlainFormat(body, ctx.title);
    if (plain) {
      turns = plain.turns;
      plainTitle = plain.title;
    } else {
      turns = [];
    }
    format = 'plain';
  }

  // Title はエクスポータが書き出す元のタイトルそのもの。無い（古い書き出しの）場合は
  // ctx.title＝ファイル名から復元したタイトルで代用する。
  const frontTitle = typeof data.Title === 'string' ? data.Title.trim() : '';

  const source = normalizeSource(data.Source, ctx.relPath);
  const chatTime = toEpoch(data['Chat Time']) ?? toEpoch(turns.find((t) => t.time)?.time) ?? ctx.mtimeMs;
  // 本家 GUI の多くはチャット一覧を最終メッセージ順に並べるため、最後の発言時刻も持つ。
  // 発言に時刻が無い形式（thread / plain）は chatTime と同じ値になる。
  const lastTime = toEpoch(turns.findLast((t) => t.time)?.time) ?? chatTime;
  const firstUser = turns.find((t) => t.role === 'user');
  const preview = stripDataUriPayloads(firstUser?.text || turns[0]?.text || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // 画像
    .replace(/```[\s\S]*?```/g, ' ') // コードブロック
    .replace(/[#*_>`|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);

  // 貼り付け画像の base64 は文字数に数えない（数百万文字規模の水増しになるため）
  let chars = 0;
  // 添付画像（Markdown の画像記法）の数。一覧のプレビューのチップに出す。
  // AI の回答が例示などで含む画像は「添付」ではないので、ユーザー発言だけを数える。
  // 数え方は設定で選べるため、全体と「最初のユーザー発言のみ」の両方を持つ
  let imageCount = 0;
  let firstImageCount = 0;
  for (const t of turns) {
    const stripped = stripDataUriPayloads(t.text);
    chars += stripped.length;
    if (t.role === 'user') {
      const n = countMarkdownImages(stripped);
      imageCount += n;
      if (t === firstUser) firstImageCount = n;
    }
  }

  return {
    relPath: ctx.relPath,
    title: frontTitle || plainTitle || ctx.title,
    source,
    format,
    url: typeof data.URL === 'string' ? data.URL : '',
    favorite: data.Favorite === true,
    archived: data.Archive === true,
    tags: Array.isArray(data.Tags) ? data.Tags : [],
    spaceName: typeof data['Space Name'] === 'string' ? data['Space Name'] : '',
    chatTime,
    lastTime,
    createdAt: toEpoch(data['Created at']),
    mtimeMs: ctx.mtimeMs,
    size: ctx.size,
    turnCount: turns.length,
    userTurns: turns.filter((t) => t.role === 'user').length,
    chars,
    imageCount,
    firstImageCount,
    preview,
    turns,
  };
}
