/**
 * .md と同名の .raw.json（エクスポータが保存したサービス生 API 応答）から会話を組み立てる。
 *
 * 対応サービス:
 *   - ChatGPT: conversation ツリー（mapping）。current_node から parent を遡り、
 *     本家 UI に表示されている枝を線形化して描画に使う。
 *   - Perplexity: thread エンドポイントの entries（1 件 = 質問と回答の 1 往復）。
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

/** URL のホスト名（出典ラベルの代替に使う） */
function urlHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * web ツールへの検索指示 `search("…")` から検索語を取り出す。
 * 引数は JSON 文字列リテラル（非 ASCII は \uXXXX エスケープ）なので JSON.parse で復元する。
 * 形が合わなければ null（呼び出し側はコードカード表示へフォールバック）。
 */
function searchCallQuery(text) {
  const m = /^search\(\s*("(?:[^"\\]|\\.)*")\s*\)\s*;?$/.exec((text || '').trim());
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/** 引用ホバーカードの 1 ページぶんに整形する。 */
function toCitePage(it) {
  return {
    title: it.title || '',
    url: it.url,
    snippet: it.snippet || '',
    date: Number.isFinite(it.pub_date) ? it.pub_date * 1000 : null,
    attribution: it.attribution || '',
  };
}

/**
 * 本文中の引用マーカー（citeturn0search1 のような私用領域文字の並び）を
 * metadata.content_references の代替表記（Markdown リンク）へ置き換える。
 *
 * collect（{ navLists, citeLists }）を渡すと、次の 2 種は構造化データとして集め、
 * 本文にはプレースホルダーだけを残す（フロントが描画する）。
 *   - nav_list（回答末尾の記事カルーセル）→ navLists / `<antNavList index="N"></antNavList>`
 *   - grouped_webpages（引用チップ）→ citeLists / `[ラベル](#cite-N)`
 *     主出典 + supporting_websites を 1 つのチップ（「Reuters +2」）に束ね、
 *     ホバーカードでページ送りできるようにする。
 */
function applyContentReferences(text, refs, collect) {
  if (Array.isArray(refs)) {
    // sources_footnote は matched_text が空白 1 文字のことがあるため、
    // マーカー文字を含む参照だけを、長い一致から順に置換する
    const usable = refs.filter((r) => typeof r?.matched_text === 'string' && PUA_CHAR.test(r.matched_text));
    usable.sort((a, b) => b.matched_text.length - a.matched_text.length);
    for (const ref of usable) {
      let alt = ref.alt || '';
      if (ref.type === 'nav_list' && collect && Array.isArray(ref.items)) {
        const items = ref.items
          .filter((it) => it?.url)
          .map((it) => ({
            title: it.title || '',
            url: it.url,
            thumbnail: it.thumbnail_url || null,
            date: Number.isFinite(it.pub_date) ? it.pub_date * 1000 : null,
            attribution: it.attribution || '',
          }));
        if (items.length) alt = `\n\n<antNavList index="${collect.navLists.push(items) - 1}"></antNavList>\n\n`;
      } else if (ref.type === 'grouped_webpages' && collect && Array.isArray(ref.items)) {
        const pages = [];
        for (const it of ref.items) {
          if (!it?.url) continue;
          pages.push(toCitePage(it));
          for (const s of it.supporting_websites || []) if (s?.url) pages.push(toCitePage(s));
        }
        if (pages.length) {
          const label = (pages[0].attribution || urlHost(pages[0].url)).replace(/[[\]]/g, ' ').trim() || '出典';
          alt = `[${label}](#cite-${collect.citeLists.push(pages) - 1})`;
        }
      }
      text = text.split(ref.matched_text).join(alt);
    }
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
    // 展開に出すツール要約の行（「6件のウェブサイトを検索しました」「…を修正確認」など）。
    // kind: 'web'（favicon 付き）| 'exec'（ターミナルアイコン）
    toolRows: [],
    activity: [], // アクティビティパネルの時系列（search / thought / exec）
    toolEntries: [], // 思考中に拾った検索結果（情報源の材料）
  };
}

/**
 * 前置き・思考・検索結果と、可視回答の metadata（情報源）から
 * 画面へ渡す reasoning オブジェクトを組み立てる。空なら null。
 * 思考が無くても情報源（ウェブ・メモリ）があれば返す（フッターの「情報源」ボタン用）。
 */
function finishReasoning(p, finalMeta) {
  // 過去のチャット（メモリ）への引用。エクスポートには参照先のタイトル等が
  // 含まれないため、memcite マーカーの数だけを拾う
  const memoryCount = (finalMeta.content_references || []).filter(
    (r) => r?.type === 'hidden' && /memcite/.test(r.matched_text || '')
  ).length;

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

  if (!p.preamble && !p.recap && !p.toolRows.length && !p.activity.length && !sources.length && !memoryCount) {
    return null;
  }

  return {
    preamble: p.preamble,
    recap: p.recap,
    durationSec: p.durationSec,
    toolRows: p.toolRows,
    activity: p.activity,
    sources,
    memoryCount,
  };
}

/** 1 ターンに束ねられた回答が複数の思考フェーズを持つ場合の併合（稀）。 */
function mergeReasoning(a, b) {
  if (!a) return b;
  if (!b) return a;
  a.preamble = [a.preamble, b.preamble].filter(Boolean).join('\n\n') || null;
  a.recap = a.recap || b.recap;
  a.durationSec = (a.durationSec || 0) + (b.durationSec || 0) || null;
  a.toolRows.push(...b.toolRows);
  a.activity.push(...b.activity);
  const seen = new Set(a.sources.map((s) => canonicalUrl(s.url)));
  for (const s of b.sources) if (!seen.has(canonicalUrl(s.url))) a.sources.push(s);
  a.memoryCount = (a.memoryCount || 0) + (b.memoryCount || 0);
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
        continue;
      }
      // ターミナル実行の結果。直前のコマンド（exec）へ出力として付ける
      if (content.content_type === 'execution_output') {
        const out = (content.text || '').trim();
        const item = pending.activity.findLast((a) => a.kind === 'exec' && a.output == null);
        if (item && out) item.output = out.slice(0, 10000);
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
        if (label) pending.toolRows.push({ label, kind: 'web', domain: domain || null });
        for (const g of groups) pending.toolEntries.push(...(g?.entries || []));
      } else if (meta.tool_summary_type) {
        // ターミナル実行など（container 等）のツール要約。「…を修正確認」の行になる
        const label = (content.thoughts || []).map((th) => th?.summary).filter(Boolean).join(' / ');
        if (label) pending.toolRows.push({ label, kind: 'exec', domain: null });
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

    // web ツールへの検索指示（search("\uXXXX…")）。コードカードではなく
    // 検索行（地球儀の見出し + 虫眼鏡の検索語チップ）として出す
    if (content.content_type === 'code' && (msg.recipient === 'web' || msg.recipient === 'browser')) {
      const query = searchCallQuery(content.text);
      if (query) {
        pending.activity.push({
          kind: 'search',
          title: typeof meta.reasoning_title === 'string' ? meta.reasoning_title : '',
          domains: [],
          query,
        });
        continue;
      }
    }

    // ターミナル実行（container.exec / python 等へのコマンド）。パネルにコードカードとして出す。
    // web.run への検索指示は tool 側の結果メッセージから拾うためここでは扱わない
    if (content.content_type === 'code' && msg.recipient && msg.recipient !== 'all' && msg.recipient !== 'web.run') {
      const code = (content.text || '').trim();
      if (code) {
        const lang = content.language && content.language !== 'unknown' ? content.language : 'python';
        pending.activity.push({
          kind: 'exec',
          title: typeof meta.reasoning_title === 'string' ? meta.reasoning_title : '',
          lang,
          code: code.slice(0, 20000),
          output: null,
        });
      }
      continue;
    }

    // ツールへの指示（code 等）は本文にしない
    if (msg.recipient && msg.recipient !== 'all') continue;
    if (content.content_type !== 'text' && content.content_type !== 'multimodal_text') continue;

    const collect = { navLists: [], citeLists: [] };
    const text = applyContentReferences(partsToText(content).text, meta.content_references, collect);
    if (!text.trim()) continue;
    const reasoning = finishReasoning(pending, meta);
    pending = newReasoning();

    const prev = turns[turns.length - 1];
    if (prev?.role === 'assistant') {
      // 本家 UI では 1 回の返信が複数メッセージに分かれることがあるため 1 ターンに束ねる。
      // 記事カード・引用のプレースホルダーは、束ねた先の並びに合わせて番号を振り直す
      let merged = text;
      if (collect.navLists.length) {
        const base = (prev.navLists ??= []).length;
        merged = merged.replace(/<antNavList index="(\d+)">/g, (_, k) => `<antNavList index="${base + Number(k)}">`);
        prev.navLists.push(...collect.navLists);
      }
      if (collect.citeLists.length) {
        const base = (prev.citeLists ??= []).length;
        merged = merged.replace(/\]\(#cite-(\d+)\)/g, (_, k) => `](#cite-${base + Number(k)})`);
        prev.citeLists.push(...collect.citeLists);
      }
      prev.text += '\n\n' + merged;
      if (reasoning) prev.reasoning = mergeReasoning(prev.reasoning, reasoning);
    } else {
      turns.push({
        role: 'assistant',
        model: meta.model_slug || null,
        time: fmtTime(msg.create_time),
        text,
        reasoning,
        navLists: collect.navLists.length ? collect.navLists : null,
        citeLists: collect.citeLists.length ? collect.citeLists : null,
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

/* ------------------------------------------------------------ Perplexity */

/** ISO 8601 の日時文字列を .md の `message time:` と同じ表記に揃える。
    Perplexity はタイムゾーン表記の無い UTC を返すことがあるため補う。 */
function fmtIsoTime(s) {
  if (typeof s !== 'string' || !s) return null;
  const ms = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(s) ? s : s + 'Z');
  return Number.isFinite(ms) ? fmtTime(ms / 1000) : null;
}

/** 過去のチャット・会話履歴由来の検索結果（情報源には出さず、メモリとして数える） */
const isMemoryResult = (w) => Boolean(w?.is_memory || w?.is_conversation_history || w?.is_conversation_summary);

/** Perplexity の検索結果 1 件を、情報源・引用ホバーカードの 1 ページぶんに整形する。 */
function pplxSource(w) {
  const ts = w.timestamp || w.meta_data?.published_date || '';
  const ms = ts ? Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(ts) ? ts : ts + 'Z') : NaN;
  return {
    title: w.name || '',
    url: w.url,
    snippet: w.snippet || '',
    date: Number.isFinite(ms) ? ms : null,
    attribution: (w.meta_data?.domain_name || urlHost(w.url)).replace(/^www\./, ''),
    // 信頼済みソース（本家のチェックマークと「信頼済み」カード）。理由文があれば添える
    trusted: Boolean(w.trust),
    trustNote: w.trust?.description || '',
  };
}

/**
 * 本文中の引用マーカー（[1][2] のような 1 始まりの番号。web_results ブロックの並びを指す）を
 * 引用チップ（`[ラベル](#cite-N)`）へ置き換える。連続する番号は 1 つのチップ
 * （「tenki.jp +1」）に束ね、ホバーカードでページ送りできるようにする。
 * コードフェンス内は配列添字などと紛らわしいため置換しない。
 */
function linkPplxCitations(text, results, collect) {
  if (!results.length) return text;
  let inFence = false;
  const lines = (text || '').split('\n').map((line) => {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    // 直後に ( が続くものは通常の Markdown リンクなので除く
    return line.replace(/(?:\[\d{1,3}\])+(?!\()/g, (run) => {
      const nums = [...run.matchAll(/\d{1,3}/g)].map(Number);
      const pages = nums.filter((n) => n >= 1 && n <= results.length).map((n) => pplxSource(results[n - 1]));
      if (!pages.length) return run;
      const label = (pages[0].attribution || urlHost(pages[0].url)).replace(/[[\]]/g, ' ').trim() || '出典';
      return `[${label}](#cite-${collect.citeLists.push(pages) - 1})`;
    });
  });
  return lines.join('\n');
}

/** 検索結果 1 件を、ステップ配下の結果行（favicon + タイトル + ドメイン + 信頼バッジ）に整形する。 */
function pplxStepResult(w) {
  return {
    title: w.name || '',
    url: w.url,
    domain: (w.meta_data?.domain_name || urlHost(w.url)).replace(/^www\./, ''),
    trusted: Boolean(w.trust),
  };
}

/** 1 ステップに保持する結果行の上限（本家は畳んで見せるが、保存量もここで抑える） */
const STEP_RESULT_MAX = 24;

/**
 * plan（goals）と pro_search_steps を、本家の手順表示（「N ステップ完了」の連鎖）へ変換する。
 *
 * goals はステップの見出し（「ウェブを検索する」「◯◯について整理中」…）。最後の goal には
 * 回答本文がそのまま流れ込むため、改行を含む・長すぎるものは見出しから除外する。
 * pro_search_steps の詳細（SEARCH_WEB の検索語、SEARCH_RESULTS の結果、THOUGHT…）は
 * goal_id で見出しに紐付くが、エクスポートに INITIAL_QUERY しか残っていないスレッドも多い。
 * その場合は引用（web_results ブロック）を最後のステップの結果として見せる。
 *
 * 返り値はステップ配列。併せて添付ファイル（ATTACHMENT）を attachments に集める。
 *   step: { kind: 'search'|'plain'|'thought'|'read'|'code', title, queries, results, code?, output? }
 */
/**
 * workflow_root（2026-08-22 以降の COPILOT 応答）の手順。ステップに title と
 * tool_name（search_web / memory_search …）が付き、items に検索語（QUERIES）・
 * 結果（SOURCES）・回答本文（TEXT）が入る。本文だけのステップは連鎖に出さない。
 */
function pplxWorkflowSteps(workflow) {
  const steps = [];
  for (const s of workflow.steps || []) {
    const title = (s.title || '').trim();
    const step = {
      kind: s.tool_name === 'memory_search' ? 'memory' : 'search',
      title,
      queries: [],
      results: [],
    };
    for (const it of s.items || []) {
      if (it?.type === 'WORKFLOW_ITEM_QUERIES') {
        step.queries.push(...(it.payload?.queries_payload?.queries || []).filter(Boolean));
      } else if (it?.type === 'WORKFLOW_ITEM_SOURCES') {
        for (const w of it.payload?.sources_payload?.sources || []) {
          if (!w?.url || step.results.length >= STEP_RESULT_MAX) continue;
          if (!step.results.some((r) => r.url === w.url)) step.results.push(pplxStepResult(w));
        }
      }
    }
    if (title || step.queries.length || step.results.length) steps.push(step);
  }
  return steps;
}

function pplxSteps(entry, blocks, answer, cited) {
  const attachments = [];
  let steps = [];
  const byGoal = new Map(); // goal id → step（見出し行）

  // 新形式（workflow_root）があればそれを使い、旧形式（plan + pro_search_steps）の
  // 組み立てはスキップする。引用のフォールバックは両形式で共通
  const workflow = blocks.get('workflow_root')?.workflow_block;
  const useWorkflow = Boolean(workflow?.steps?.length);
  if (useWorkflow) steps = pplxWorkflowSteps(workflow);

  for (const g of (useWorkflow ? [] : blocks.get('plan')?.plan_block?.goals) || []) {
    const title = (g?.description || '').trim();
    if (!title || title === answer || title.includes('\n') || title.length > 120) continue;
    const step = { kind: title === 'ウェブを検索する' ? 'search' : 'plain', title, queries: [], results: [] };
    byGoal.set(String(g.id ?? ''), step);
    steps.push(step);
  }

  /** goal_id に対応する見出しステップ。無ければ新しいステップを末尾に作る。 */
  const stepFor = (goalId, kind, title) => {
    const found = byGoal.get(String(goalId ?? ''));
    if (found) {
      if (found.kind === 'plain') found.kind = kind;
      return found;
    }
    const step = { kind, title, queries: [], results: [] };
    steps.push(step);
    return step;
  };
  const addResults = (step, list) => {
    for (const w of list) {
      if (step.results.length >= STEP_RESULT_MAX) break;
      if (!step.results.some((r) => r.url === w.url)) step.results.push(pplxStepResult(w));
    }
  };

  let initialQuery = '';
  let lastSearch = null; // 直後の SEARCH_RESULTS を受けるステップ
  for (const s of (useWorkflow ? [] : blocks.get('pro_search_steps')?.plan_block?.steps) || []) {
    if (s.step_type === 'INITIAL_QUERY') {
      initialQuery = (s.initial_query_content?.query || '').trim();
      continue;
    }
    if (s.step_type === 'SEARCH_WEB') {
      lastSearch = stepFor(s.search_web_content?.goal_id, 'search', 'ウェブを検索する');
      lastSearch.queries.push(...(s.search_web_content?.queries || []).map((q) => q?.query).filter(Boolean));
      continue;
    }
    if (s.step_type === 'SEARCH_RESULTS') {
      const results = (s.web_results_content?.web_results || []).filter((w) => w?.url && !isMemoryResult(w));
      const step = lastSearch || stepFor(s.web_results_content?.goal_id, 'search', 'ウェブを検索する');
      addResults(step, results);
      lastSearch = null;
      continue;
    }
    if (s.step_type === 'THOUGHT') {
      const text = (s.thought_content?.thought || '').trim();
      if (!text) continue;
      const step = { kind: 'thought', title: text, queries: [], results: [] };
      addResults(step, (s.thought_content?.web_results || []).filter((w) => w?.url && !isMemoryResult(w)));
      steps.push(step);
      continue;
    }
    if (s.step_type === 'GET_URL_CONTENT') {
      const pages = (s.get_url_content_content?.pages || []).filter((pg) => pg?.url);
      if (pages.length) {
        const step = stepFor(s.get_url_content_content?.goal_id, 'read', 'ウェブページを読む');
        addResults(step, pages.map((pg) => ({ url: pg.url })));
      }
      continue;
    }
    if (s.step_type === 'CODE') {
      const c = s.code_content || {};
      const code = (c.script || '').trim();
      if (code) {
        const output = (c.stdout || c.output || c.error || '').trim();
        const step = stepFor(c.goal_id, 'code', 'コードを実行');
        step.code = code.slice(0, 20000);
        step.output = output ? output.slice(0, 10000) : null;
      }
      continue;
    }
    if (s.step_type === 'ATTACHMENT') {
      for (const a of s.attachment_content?.attachments || []) {
        if (a?.url) attachments.push({ name: a.name || 'attachment', url: a.url });
      }
    }
  }

  // 本家は「ウェブを検索する」の下に最初の検索語（= 質問文）を出す
  const firstSearch = steps.find((s) => s.title === 'ウェブを検索する');
  if (firstSearch && !firstSearch.queries.length && initialQuery) firstSearch.queries.push(initialQuery);

  // 手順の詳細が残っていないスレッドでは、引用を最後のステップの結果として見せる
  if (cited.length && !steps.some((s) => s.results.length)) {
    let last = steps.findLast((s) => s.kind === 'search' || s.kind === 'plain');
    if (!last) {
      last = { kind: 'search', title: 'ウェブを検索する', queries: initialQuery ? [initialQuery] : [], results: [] };
      steps.push(last);
    }
    if (last.kind === 'plain') last.kind = 'search';
    addResults(last, cited);
  }

  return { steps, attachments };
}

/** entries の blocks から intended_usage → ブロックの索引を作る。 */
function pplxBlocks(entry) {
  const map = new Map();
  for (const b of entry.blocks || []) {
    if (b?.intended_usage && !map.has(b.intended_usage)) map.set(b.intended_usage, b);
  }
  return map;
}

/** Perplexity の 1 エントリ（質問 + 回答）を user / assistant の 2 ターンへ変換する。 */
function pplxEntryTurns(entry, turns) {
  const blocks = pplxBlocks(entry);
  const mdBlock = blocks.get('ask_text')?.markdown_block;
  let answer = (mdBlock?.answer || (mdBlock?.chunks || []).join('')).trim();
  if (!answer) {
    // 新形式（workflow_root）では本文が WORKFLOW_ITEM_TEXT に入る
    answer = (blocks.get('workflow_root')?.workflow_block?.steps || [])
      .flatMap((s) => s.items || [])
      .filter((it) => it?.type === 'WORKFLOW_ITEM_TEXT')
      .map((it) => it.payload?.text_payload?.text || '')
      .join('\n\n')
      .trim();
  }
  const query = (entry.query_str || '').trim();
  if (!query && !answer) return;

  // 手順の連鎖と情報源。情報源は引用（web_results）→ ソースタブ（sources_answer_mode）の順
  const cited = (blocks.get('web_results')?.web_result_block?.web_results || []).filter((w) => w?.url);
  const { steps, attachments } = pplxSteps(entry, blocks, answer, cited.filter((w) => !isMemoryResult(w)));
  let memoryCount = 0;
  const seen = new Set();
  const sources = [];
  for (const list of [cited, blocks.get('sources_answer_mode')?.sources_mode_block?.web_results || []]) {
    for (const w of list) {
      if (!w?.url) continue;
      if (isMemoryResult(w)) {
        memoryCount++;
        continue;
      }
      const key = canonicalUrl(w.url);
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push(pplxSource(w));
    }
  }
  // steps がフロントの Perplexity 専用描画（手順の連鎖）を選ぶ目印。
  // toolRows / activity は ChatGPT（Native）と共通のコードが触るため空配列を置く
  const reasoning =
    steps.length || sources.length || memoryCount
      ? { preamble: null, recap: null, durationSec: null, toolRows: [], activity: [], steps, sources, memoryCount }
      : null;

  if (query || attachments.length) {
    // 添付ファイルの URL は期限付き署名のため、リンクとして残すだけにする
    const head = attachments.map((a) => `[${a.name.replace(/[[\]]/g, ' ')}](${a.url})`).join(' · ');
    turns.push({
      role: 'user',
      model: null,
      time: fmtIsoTime(entry.entry_created_datetime),
      text: [head, query].filter(Boolean).join('\n\n'),
    });
  }
  if (!answer) return;

  const collect = { citeLists: [], navLists: [] };
  let text = linkPplxCitations(answer, cited.filter((w) => !isMemoryResult(w)), collect);

  // メディア（画像・動画）は記事カード（nav_list と同じ描画）として回答末尾に出す
  const media = (blocks.get('media_items')?.media_block?.media_items || [])
    .filter((it) => it?.url && (it.thumbnail || it.image))
    .map((it) => ({
      title: it.name || '',
      url: it.url,
      thumbnail: it.thumbnail_384 || it.thumbnail || it.image || null,
      date: null,
      attribution: (urlHost(it.url) || it.citation_info?.domain_name || '').replace(/^www\./, ''),
    }));
  if (media.length) text += `\n\n<antNavList index="${collect.navLists.push(media) - 1}"></antNavList>`;

  turns.push({
    role: 'assistant',
    model: entry.display_model || null,
    time: fmtIsoTime(entry.entry_updated_datetime) || fmtIsoTime(entry.updated_datetime),
    text,
    reasoning,
    navLists: collect.navLists.length ? collect.navLists : null,
    citeLists: collect.citeLists.length ? collect.citeLists : null,
    related: (entry.related_queries || []).length ? entry.related_queries.map((q) => `- ${q}`).join('\n') : null,
  });
}

/** Perplexity の thread 応答（responses[].response.entries）から turns を組み立てる。 */
function buildPplxTurns(raw) {
  const turns = [];
  const seen = new Set();
  for (const r of raw.responses || []) {
    for (const entry of r?.response?.entries || []) {
      const id = entry?.uuid || entry?.backend_uuid;
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      pplxEntryTurns(entry, turns);
    }
  }
  return turns;
}

/* ---------------------------------------------------------------- loader */

/**
 * .md の絶対パスに対応する .raw.json があれば、生 API 応答から turns を組み立てて返す。
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

  if (raw?.service === 'perplexity') {
    const turns = buildPplxTurns(raw);
    return turns.length ? { turns } : null;
  }

  if (raw?.service !== 'chatgpt') return null;
  const resp = (raw.responses || []).map((r) => r?.response).find((r) => r?.mapping);
  if (!resp) return null;

  const turns = buildTurns(resp.mapping, resp.current_node);
  if (!turns.length) return null;
  attachImagesFromMarkdown(turns, mdConv?.turns);
  return { turns: turns.map(({ imageCount, ...turn }) => turn) };
}
