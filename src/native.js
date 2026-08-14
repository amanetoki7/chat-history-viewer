/**
 * .md と同名の .raw.json（エクスポータが保存したサービス生 API 応答）から会話を組み立てる。
 *
 * 現状は ChatGPT の conversation ツリー（mapping）のみ対応。
 * current_node から parent を遡り、本家 UI に表示されている枝を線形化して描画に使う。
 * 読めない・解釈できない場合は null を返し、呼び出し側は従来どおり .md の解析結果を使う。
 */

import fs from 'node:fs/promises';

/** 引用マーカー等に使われる私用領域の文字（文字クラスは不可視の U+E000〜U+F8FF） */
const PUA_CHAR = /[-]/;

/** `create_time`（epoch 秒）を .md の `message time:` と同じ表記に揃える。 */
function fmtTime(sec) {
  if (!Number.isFinite(sec)) return null;
  const d = new Date(sec * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 本文中の引用マーカー（citeturn0search1 のような私用領域文字の並び）を
 * metadata.content_references の代替表記（Markdown リンク）へ置き換える。
 */
function applyContentReferences(text, refs) {
  if (Array.isArray(refs)) {
    // sources_footnote は matched_text が空白 1 文字のことがあるため、
    // マーカー文字を含む参照だけを、長い一致から順に置換する
    const usable = refs.filter((r) => typeof r?.matched_text === 'string' && PUA_CHAR.test(r.matched_text));
    usable.sort((a, b) => b.matched_text.length - a.matched_text.length);
    for (const ref of usable) text = text.split(ref.matched_text).join(ref.alt || '');
  }
  // 参照に対応しないマーカーが残っても表示を汚さないよう落とす
  return text.replace(/[-]/g, '');
}

/** content の text / parts を本文文字列に集める。画像パートは数だけ返す。 */
function partsToText(content) {
  const texts = [];
  let imageCount = 0;
  if (typeof content.text === 'string' && content.text) texts.push(content.text);
  for (const part of content.parts || []) {
    if (typeof part === 'string') {
      if (part) texts.push(part);
      continue;
    }
    // 画像は sediment:// ポインタで実体が取れない。数えておき .md 側の埋め込みで補う
    if (part?.content_type === 'image_asset_pointer') imageCount++;
  }
  return { text: texts.join('\n\n').trim(), imageCount };
}

/** Google の favicon API の URL（tool_icons の実データ）からドメイン名を取り出す。 */
function iconDomain(url) {
  if (typeof url !== 'string') return null;
  const m = /[?&]domain=([^&]+)/.exec(url);
  if (m) return decodeURIComponent(m[1]);
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** 情報源の重複判定用。ChatGPT が付ける utm_source だけを落とした URL。 */
function canonicalUrl(url) {
  try {
    const u = new URL(url);
    u.searchParams.delete('utm_source');
    return u.toString().replace(/\?$/, '');
  } catch {
    return url;
  }
}

/** 回答 1 つぶんの思考アクティビティ（「◯m ◯s考えました」ブロック）の集積場所。 */
function newReasoning() {
  return {
    preamble: null, // 展開に出す前置きテキスト（is_thinking_preamble_message）
    recap: null, // 「2m 43s考えました」
    durationSec: null,
    webSearches: [], // 「6件のウェブサイトを検索しました」の行（label / domain）
    activity: [], // アクティビティパネルの時系列（search / thought）
    toolEntries: [], // 思考中に拾った検索結果（情報源の材料）
  };
}

/**
 * 前置き・思考・検索結果と、可視回答の metadata（情報源）から
 * 画面へ渡す reasoning オブジェクトを組み立てる。空なら null。
 */
function finishReasoning(p, finalMeta) {
  if (!p.preamble && !p.recap && !p.webSearches.length && !p.activity.length) return null;

  // 情報源。本家の並びに合わせ、sources_footnote → 回答の検索結果 → 思考中の検索結果。
  // URL で重複を除き、後から来た同一 URL は欠けている項目（snippet 等）だけを埋める。
  const seen = new Map();
  const sources = [];
  const add = (e) => {
    if (!e?.url) return;
    const key = canonicalUrl(e.url);
    const prev = seen.get(key);
    if (prev) {
      if (!prev.title && e.title) prev.title = e.title;
      if (!prev.snippet && e.snippet) prev.snippet = e.snippet;
      if (!prev.date && Number.isFinite(e.pub_date)) prev.date = e.pub_date * 1000;
      return;
    }
    const src = {
      title: e.title || '',
      url: e.url,
      snippet: e.snippet || '',
      date: Number.isFinite(e.pub_date) ? e.pub_date * 1000 : null,
      attribution: e.attribution || '',
    };
    seen.set(key, src);
    sources.push(src);
  };

  for (const ref of finalMeta.content_references || []) {
    if (ref?.type !== 'sources_footnote') continue;
    for (const s of ref.sources || []) add(s);
  }
  for (const g of finalMeta.search_result_groups || []) for (const e of g?.entries || []) add(e);
  for (const e of p.toolEntries) add(e);

  return {
    preamble: p.preamble,
    recap: p.recap,
    durationSec: p.durationSec,
    webSearches: p.webSearches,
    activity: p.activity,
    sources,
  };
}

/** 1 ターンに束ねられた回答が複数の思考フェーズを持つ場合の併合（稀）。 */
function mergeReasoning(a, b) {
  if (!a) return b;
  if (!b) return a;
  a.preamble = [a.preamble, b.preamble].filter(Boolean).join('\n\n') || null;
  a.recap = a.recap || b.recap;
  a.durationSec = (a.durationSec || 0) + (b.durationSec || 0) || null;
  a.webSearches.push(...b.webSearches);
  a.activity.push(...b.activity);
  const seen = new Set(a.sources.map((s) => canonicalUrl(s.url)));
  for (const s of b.sources) if (!seen.has(canonicalUrl(s.url))) a.sources.push(s);
  return a;
}

/** current_node（無ければ最新の葉）から parent を遡り、根から葉への並びを返す。 */
function activePath(mapping, currentNode) {
  let leaf = currentNode && mapping[currentNode] ? currentNode : null;
  if (!leaf) {
    let bestTime = -Infinity;
    for (const [id, node] of Object.entries(mapping)) {
      if (node.children?.length) continue;
      const t = node.message?.create_time || 0;
      if (t > bestTime) {
        bestTime = t;
        leaf = id;
      }
    }
  }
  const path = [];
  const seen = new Set();
  for (let id = leaf; id && mapping[id] && !seen.has(id); id = mapping[id].parent) {
    seen.add(id);
    path.push(mapping[id]);
  }
  return path.reverse();
}

/** 会話ツリーの表示対象メッセージを、画面に出す turns へ変換する。 */
function buildTurns(mapping, currentNode) {
  const turns = [];
  /** 次に出る回答本文へ付ける思考アクティビティ */
  let pending = newReasoning();

  for (const node of activePath(mapping, currentNode)) {
    const msg = node.message;
    if (!msg) continue;
    const role = msg.author?.role;
    const content = msg.content || {};
    const meta = msg.metadata || {};
    if (meta.is_visually_hidden_from_conversation) continue;

    if (role === 'user') {
      const { text, imageCount } = partsToText(content);
      if (!text && !imageCount) continue;
      turns.push({ role: 'user', model: null, time: fmtTime(msg.create_time), text, imageCount });
      pending = newReasoning();
      continue;
    }

    // web.run の検索結果（tool メッセージ）。「6件のサイトを検索中」の見出しとドメイン、情報源を拾う
    if (role === 'tool') {
      const groups = meta.search_result_groups;
      if (Array.isArray(groups) && groups.length) {
        pending.activity.push({
          kind: 'search',
          title: typeof meta.reasoning_title === 'string' ? meta.reasoning_title : '',
          domains: groups.map((g) => g?.domain).filter(Boolean),
        });
        for (const g of groups) pending.toolEntries.push(...(g?.entries || []));
      }
      continue;
    }
    if (role !== 'assistant') continue; // system は表示しない

    // 前置きテキスト。本家では本文ではなく「考えました」の展開に入る
    if (meta.is_thinking_preamble_message) {
      const text = applyContentReferences(partsToText(content).text, meta.content_references);
      if (text) pending.preamble = pending.preamble ? pending.preamble + '\n\n' + text : text;
      continue;
    }

    if (content.content_type === 'thoughts') {
      if (meta.tool_summary_type === 'web') {
        // 「6件のウェブサイトを検索しました」の行。アイコンは 1 つ目のサイトの favicon
        const label = (content.thoughts || []).map((th) => th?.summary).filter(Boolean).join(' / ');
        const groups = meta.inline_cot_expandable_content?.search_result_groups || [];
        const domain = groups[0]?.domain || iconDomain((meta.tool_icons || [])[0]);
        if (label) pending.webSearches.push({ label, domain: domain || null });
        for (const g of groups) pending.toolEntries.push(...(g?.entries || []));
      } else {
        // 要約だけの思考も保持する（ウェブ検索の無い会話ではインライン表示に使う。
        // アクティビティパネル側は本家に合わせ、本文のあるものだけを描画する）
        for (const th of content.thoughts || []) {
          if (th?.summary || th?.content) {
            pending.activity.push({ kind: 'thought', summary: th.summary || '', content: th.content || '' });
          }
        }
      }
      continue;
    }

    // 「2m 43s考えました」（折りたたみの見出しと所要時間）
    if (content.content_type === 'reasoning_recap') {
      if (typeof content.content === 'string' && content.content) pending.recap = content.content;
      if (Number.isFinite(meta.finished_duration_sec)) pending.durationSec = meta.finished_duration_sec;
      continue;
    }

    // ツールへの指示（code 等）は本文にしない
    if (msg.recipient && msg.recipient !== 'all') continue;
    if (content.content_type !== 'text' && content.content_type !== 'multimodal_text') continue;

    const text = applyContentReferences(partsToText(content).text, meta.content_references);
    if (!text.trim()) continue;
    const reasoning = finishReasoning(pending, meta);
    pending = newReasoning();

    const prev = turns[turns.length - 1];
    if (prev?.role === 'assistant') {
      // 本家 UI では 1 回の返信が複数メッセージに分かれることがあるため 1 ターンに束ねる
      prev.text += '\n\n' + text;
      if (reasoning) prev.reasoning = mergeReasoning(prev.reasoning, reasoning);
    } else {
      turns.push({
        role: 'assistant',
        model: meta.model_slug || null,
        time: fmtTime(msg.create_time),
        text,
        reasoning,
      });
    }
  }
  return turns;
}

/* 単独行の Markdown 画像（.md では添付がユーザー発言の冒頭に置かれる） */
const IMG_LINE = /^!\[[^\]]*\]\([^)]*\)$/;

function leadingImages(text) {
  const images = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    if (!IMG_LINE.test(t)) break;
    images.push(t);
  }
  return images;
}

/**
 * raw.json の添付画像は実体を取れないため、同じ並びのユーザー発言を
 * .md の解析結果と突き合わせ、base64 埋め込み画像を先頭に流用する。
 */
function attachImagesFromMarkdown(turns, mdTurns) {
  const mdUsers = (mdTurns || []).filter((t) => t.role === 'user');
  const rawUsers = turns.filter((t) => t.role === 'user');
  if (mdUsers.length !== rawUsers.length) return; // 対応が取れなければ画像は諦める
  rawUsers.forEach((turn, i) => {
    if (!turn.imageCount) return;
    const images = leadingImages(mdUsers[i].text);
    if (images.length) turn.text = `${images.join('\n')}\n\n${turn.text}`.trim();
  });
}

/**
 * .md の絶対パスに対応する .raw.json があれば、会話ツリーから turns を組み立てて返す。
 * @param {string} abs        .md の絶対パス
 * @param {object|null} mdConv .md の解析結果（添付画像の流用に使う）
 * @returns {Promise<{turns: any[]} | null>}
 */
export async function loadNativeConversation(abs, mdConv) {
  if (!/\.md$/i.test(abs)) return null;
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(abs.replace(/\.md$/i, '.raw.json'), 'utf8'));
  } catch {
    return null; // 無い・読めない・JSON でない
  }
  if (raw?.service !== 'chatgpt') return null;
  const resp = (raw.responses || []).map((r) => r?.response).find((r) => r?.mapping);
  if (!resp) return null;

  const turns = buildTurns(resp.mapping, resp.current_node);
  if (!turns.length) return null;
  attachImagesFromMarkdown(turns, mdConv?.turns);
  return { turns: turns.map(({ imageCount, ...turn }) => turn) };
}
