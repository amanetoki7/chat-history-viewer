/**
 * 索引 blob に対する全文検索。
 *
 * blob は ASCII 部分のみ小文字化されており、バイト長は原文と一致する。
 * したがって「クエリを ASCII 小文字化して UTF-8 バイト列で探す」だけで
 * 英字の大小を無視しつつ、日本語をそのまま部分一致検索できる。
 */

import { ROLE_CODE, ROLE_NAME, concatConversation, asciiLowerInPlace, loadConversation, resolveEntryPath } from './indexer.js';

const MAX_COUNT_PER_TERM = 24; // スコア用の出現回数はこの数で打ち切る

/**
 * クエリ文字列を解釈する。
 *   "二語 フレーズ"  … フレーズ一致
 *   -除外語          … 除外
 *   それ以外          … AND 条件
 */
export function parseQuery(raw) {
  const terms = [];
  const excludes = [];
  const re = /(-?)"([^"]*)"|(-?)(\S+)/g;
  let m;
  while ((m = re.exec(raw || '')) !== null) {
    const neg = (m[1] || m[3]) === '-';
    const text = (m[2] ?? m[4] ?? '').trim();
    if (!text) continue;
    const entry = { text, buf: asciiLowerInPlace(Buffer.from(text, 'utf8')) };
    if (entry.buf.length === 0) continue;
    (neg ? excludes : terms).push(entry);
  }
  return { terms, excludes, raw: raw || '' };
}

/** entry の検索対象範囲（scope 指定があればその role のセグメント群）を返す。 */
function rangesFor(index, entry, scope) {
  if (scope === 'all') return [[entry.blobStart, entry.blobStart + entry.blobLength]];
  const wanted = scope === 'user' ? ROLE_CODE.user : ROLE_CODE.assistant;
  const ranges = [];
  const { segments } = index;
  for (let s = 0; s < entry.segCount; s++) {
    const base = (entry.segStart + s) * 4;
    if (segments[base + 2] !== wanted) continue;
    ranges.push([entry.blobStart + segments[base], entry.blobStart + segments[base + 1]]);
  }
  return ranges;
}

/** ranges 内で term が最初に現れるバイト位置。見つからなければ -1。 */
function findFirst(blob, ranges, term) {
  for (const [from, to] of ranges) {
    if (to - from < term.length) continue;
    const hit = blob.subarray(from, to).indexOf(term);
    if (hit !== -1) return from + hit;
  }
  return -1;
}

/** ranges 内の出現回数（MAX_COUNT_PER_TERM で打ち切り）。 */
function countHits(blob, ranges, term) {
  let total = 0;
  for (const [from, to] of ranges) {
    const view = blob.subarray(from, to);
    let pos = 0;
    while (total < MAX_COUNT_PER_TERM) {
      const hit = view.indexOf(term, pos);
      if (hit === -1) break;
      total++;
      pos = hit + term.length;
    }
    if (total >= MAX_COUNT_PER_TERM) break;
  }
  return total;
}

/** entry のタイトル部分だけを対象にした範囲。 */
function titleRange(index, entry) {
  if (!entry.segCount) return [];
  const base = entry.segStart * 4;
  return [[entry.blobStart + index.segments[base], entry.blobStart + index.segments[base + 1]]];
}

/**
 * 絞り込み + 検索 + 並べ替え。
 * @returns {{total: number, hits: Array<{entry: any, score: number, firstHit: number}>}}
 */
export function search(index, options) {
  const {
    q = '',
    sources = null,
    from = null,
    to = null,
    favorite = false,
    includeArchived = true,
    scope = 'all',
    sort = 'relevance',
    timeBasis = 'start',
  } = options;

  // 並び替え・期間の絞り込みに使う日時。'last' は最終メッセージ時刻基準
  const timeOf = timeBasis === 'last' ? (e) => e.lastTime ?? e.chatTime : (e) => e.chatTime;

  const { terms, excludes } = parseQuery(q);
  const hasQuery = terms.length > 0 || excludes.length > 0;
  const { blob } = index;
  const hits = [];

  for (const entry of index.entries) {
    if (sources && !sources.has(entry.source)) continue;
    if (favorite && !entry.favorite) continue;
    if (!includeArchived && entry.archived) continue;
    if (from !== null && timeOf(entry) < from) continue;
    if (to !== null && timeOf(entry) > to) continue;

    if (!hasQuery) {
      hits.push({ entry, score: 0, firstHit: -1 });
      continue;
    }

    const ranges = rangesFor(index, entry, scope);
    if (!ranges.length) continue;

    let score = 0;
    let firstHit = -1;
    let nearest = Infinity;
    let farthest = -Infinity;
    let ok = true;

    for (const term of terms) {
      const pos = findFirst(blob, ranges, term.buf);
      if (pos === -1) {
        ok = false;
        break;
      }
      if (firstHit === -1 || pos < firstHit) firstHit = pos;
      if (pos < nearest) nearest = pos;
      if (pos > farthest) farthest = pos;
      score += countHits(blob, ranges, term.buf);
      if (findFirst(blob, titleRange(index, entry), term.buf) !== -1) score += 30;
    }
    if (!ok) continue;

    // 複数語が近接している会話は、単に全語をどこかに含むだけの会話より関連度が高い
    if (terms.length > 1 && farthest - nearest < 2000) score += 40;

    for (const term of excludes) {
      if (findFirst(blob, rangesFor(index, entry, 'all'), term.buf) !== -1) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    hits.push({ entry, score, firstHit });
  }

  const byTime = (a, b) => timeOf(b.entry) - timeOf(a.entry);
  if (sort === 'oldest') hits.sort((a, b) => timeOf(a.entry) - timeOf(b.entry));
  else if (sort === 'longest') hits.sort((a, b) => b.entry.chars - a.entry.chars || byTime(a, b));
  else if (sort === 'newest' || !hasQuery) hits.sort(byTime);
  else hits.sort((a, b) => b.score - a.score || byTime(a, b));

  return { total: hits.length, hits };
}

/** UTF-8 の途中で切らないように、バイト位置を文字境界まで戻す。 */
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

/** バイト位置がどのターンに属するかを引く。 */
function segmentAt(index, entry, absPos) {
  const local = absPos - entry.blobStart;
  for (let s = 0; s < entry.segCount; s++) {
    const base = (entry.segStart + s) * 4;
    if (local >= index.segments[base] && local < index.segments[base + 1]) {
      return { role: ROLE_NAME[index.segments[base + 2]], turnIndex: index.segments[base + 3] };
    }
  }
  return { role: 'assistant', turnIndex: -1 };
}

/**
 * 検索結果ページ分のスニペットを作る。
 * 原文はファイルを読み直して同じレイアウトで再構築するので、
 * blob 上のバイト位置をそのまま流用できる（大小文字も原文のまま得られる）。
 */
export async function buildSnippets(index, hits, terms, { perHit = 3, before = 48, after = 132 } = {}) {
  const results = [];
  for (const hit of hits) {
    const entry = hit.entry;
    const item = { ...entry, snippets: [] };
    delete item.blobStart;
    delete item.blobLength;
    delete item.segStart;
    delete item.segCount;

    if (terms.length) {
      const abs = resolveEntryPath(entry.relPath);
      const conv = abs ? await loadConversation({ abs, relPath: entry.relPath, title: entry.title, mtimeMs: entry.mtimeMs, size: entry.size }) : null;
      const plain = conv ? concatConversation(conv).buf : null;

      // タイトルは結果カードに別途出るため、スニペットは本文側から採る
      const bodyStart = entry.segCount ? index.segments[entry.segStart * 4 + 1] : 0;
      const view = index.blob.subarray(entry.blobStart, entry.blobStart + entry.blobLength);

      // 語ごとに順番に拾い、1 語だけで枠を使い切らないようにする
      const perTerm = terms.map(() => []);
      terms.forEach((term, ti) => {
        let pos = bodyStart;
        while (perTerm[ti].length < perHit) {
          const at = view.indexOf(term.buf, pos);
          if (at === -1) break;
          perTerm[ti].push({ local: at, len: term.buf.length });
          pos = at + term.buf.length;
        }
        // 本文に無い語はタイトル側から拾う
        if (!perTerm[ti].length) {
          const at = view.indexOf(term.buf);
          if (at !== -1) perTerm[ti].push({ local: at, len: term.buf.length });
        }
      });

      const positions = [];
      for (let round = 0; round < perHit; round++) {
        for (const hitsOfTerm of perTerm) {
          if (hitsOfTerm[round]) positions.push(hitsOfTerm[round]);
        }
      }

      const used = [];
      for (const p of positions) {
        if (item.snippets.length >= perHit) break;
        if (used.some((u) => Math.abs(u - p.local) < before + after)) continue;
        used.push(p.local);

        const src = plain && plain.length === entry.blobLength ? plain : index.blob.subarray(entry.blobStart, entry.blobStart + entry.blobLength);
        // 本文中の一致なら、前方文脈がタイトルまで遡らないよう切り詰める
        const floor = p.local >= bodyStart ? bodyStart : 0;
        const s = alignStart(src, Math.max(floor, p.local - before));
        const e = alignEnd(src, p.local + p.len + after);
        const seg = segmentAt(index, entry, entry.blobStart + p.local);
        item.snippets.push({
          text: (s > 0 ? '…' : '') + src.subarray(s, e).toString('utf8').replace(/\s+/g, ' ').trim() + (e < src.length ? '…' : ''),
          role: seg.role,
          turnIndex: seg.turnIndex,
        });
      }
    }

    results.push(item);
  }
  return results;
}
