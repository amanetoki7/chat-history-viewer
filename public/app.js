/* global markdownit */
'use strict';

/* ------------------------------------------------------------- markdown */

// コードハイライトは CodeMirror (lezer) ベースの ES モジュール（code-highlight.js）。
// 読み込み完了前に会話を描画しないよう、openConversation で await する
const cmHighlightReady = import('/code-highlight.js').catch((e) => {
  console.error('code-highlight.js の読み込みに失敗しました', e);
});

const md = window.markdownit({
  html: false,
  linkify: true,
  breaks: true,
  highlight(code, lang) {
    return (window.cmHighlight && window.cmHighlight(code, lang)) || '';
  },
});

/* コードブロックを .codeblock で包み、言語名ヘッダーとコピーボタンを付ける */
const copyBtn = () =>
  `<button class="code-copy" type="button" title="コピー" aria-label="コードをコピー">${icon('copy', 15)}</button>`;

for (const rule of ['fence', 'code_block']) {
  const base = md.renderer.rules[rule] ?? ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules[rule] = (tokens, idx, options, env, self) => {
    const body = base(tokens, idx, options, env, self);
    const lang = rule === 'fence' ? md.utils.unescapeAll(tokens[idx].info || '').trim().split(/\s+/)[0] : '';
    // text はヘッダーを付けず内容だけ見せる（コピーボタンは右上に重ねる）
    if (!lang || lang.toLowerCase() === 'text') return `<div class="codeblock">${body}${copyBtn()}</div>`;
    return (
      `<div class="codeblock has-lang"><div class="codeblock-head">` +
      `<span class="codeblock-lang">${icon('code', 13)}<span>${escapeHtml(lang)}</span></span>${copyBtn()}` +
      `</div>${body}</div>`
    );
  };
}

/* 本文中の外部リンク（http/https）を favicon 付きのチップとして描画する。
 * favicon はサードパーティ API を経由せず、リンク先サイトの /favicon.ico を直接読む。
 * 読み込めるまでは world アイコンを表示し、成功したら favicon に置き換える */
const baseLinkOpen =
  md.renderer.rules.link_open ?? ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));

/* display:none で隠すと lazy 画像は交差判定が起きず永遠にロードされないため、
 * world アイコンの上に透明のまま重ねておき、ロード成功時にアイコン側を消す */
const chipIcoHtml = (origin) =>
  `<span class="chip-ico">${icon('world', 13)}` +
  `<img src="${escapeHtml(origin)}/favicon.ico" alt="" loading="lazy"` +
  ` onload="this.previousElementSibling?.remove()" onerror="this.remove()"></span>`;

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const href = token.attrGet('href') || '';

  // ChatGPT（Native）の引用チップ。`#cite-N` は turn.citeLists[N]（出典ページの束）を指す。
  // リンク先は「ホバーカードで今開いているページ」= 初期状態では 1 つ目の出典
  const cite = /^#cite-(\d+)$/.exec(href);
  const pages = cite ? env.turn?.citeLists?.[Number(cite[1])] : null;
  if (pages?.length) {
    token.attrSet('href', pages[0].url);
    token.attrJoin('class', 'link-chip cite-chip');
    token.attrSet('target', '_blank');
    token.attrSet('rel', 'noopener');
    token.attrSet('data-cite', cite[1]);
    (env.linkChips ??= []).push(pages.length);
    let origin = '';
    try {
      origin = new URL(pages[0].url).origin;
    } catch {}
    // 信頼済みソース（Perplexity の trust）はチェックマークを添える
    const trust = pages[0].trusted ? `<span class="chip-trust">${icon('discount-check', 13)}</span>` : '';
    return (
      baseLinkOpen(tokens, idx, options, env, self) +
      `${origin ? chipIcoHtml(origin) : ''}${trust}<span class="chip-label">`
    );
  }

  const chip = /^https?:\/\//i.test(href);
  (env.linkChips ??= []).push(chip);
  if (!chip) return baseLinkOpen(tokens, idx, options, env, self);

  token.attrJoin('class', 'link-chip');
  token.attrSet('target', '_blank');
  token.attrSet('rel', 'noopener');

  const url = new URL(href);
  // linkify による自動リンクはラベルが URL そのままで長いので、ホスト名に短縮する
  const next = tokens[idx + 1];
  if (token.markup === 'linkify' && next?.type === 'text') next.content = url.hostname;

  return baseLinkOpen(tokens, idx, options, env, self) + `${chipIcoHtml(url.origin)}<span class="chip-label">`;
};

md.renderer.rules.link_close = (tokens, idx, options, env, self) => {
  const closing = self.renderToken(tokens, idx, options);
  const chip = env.linkChips?.pop();
  if (!chip) return closing;
  // 引用チップ（数値 = 出典ページ数）は残り件数を「+N」で添える
  const more = typeof chip === 'number' && chip > 1 ? `<span class="cite-more">+${chip - 1}</span>` : '';
  return `</span>${more}${closing}`;
};

const ARTIFACT_LANG = {
  'text/html': 'html',
  'application/vnd.ant.code': '',
  'application/vnd.ant.react': 'jsx',
  'image/svg+xml': 'xml',
  'text/markdown': 'markdown',
  'application/vnd.ant.mermaid': 'mermaid',
};

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const attrOf = (attrs, name) => {
  const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(attrs);
  return m ? m[1] : '';
};

/** 折りたたみブロック。見出しには Tabler アイコン（icons.js）を添える。 */
const detailsBlock = (cls, iconName, label, innerHtml, open) =>
  `<details class="block ${cls}"${open ? ' open' : ''}>` +
  `<summary>${icon(iconName, 14)}<span>${escapeHtml(label)}</span></summary>` +
  `<div class="block-body md">${innerHtml}</div></details>`;

/** サイトの favicon。リンクチップと同じく /favicon.ico を直接読み、読めるまで world アイコンを出す。 */
const favIcoHtml = (domain) =>
  `<span class="fav-ico">${icon('world', 13)}` +
  (domain
    ? `<img src="https://${escapeHtml(domain)}/favicon.ico" alt="" loading="lazy"` +
      ` onload="this.previousElementSibling?.remove()" onerror="this.remove()">`
    : '') +
  `</span>`;

/** 思考の所要時間。本家の表記（2m 43s）に合わせる。 */
function fmtThinkDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m ? `${m}m ${s}s` : `${s}s`;
}

/** コード内のバッククォート列より長いフェンスを選ぶ（``` を含むコードでも壊れないように） */
const fenceFor = (s) =>
  '`'.repeat(Math.max(3, ((s || '').match(/`+/g) || []).reduce((max, run) => Math.max(max, run.length), 0) + 1));

/**
 * 検索だけの思考（本文のある思考・コード実行・前置きが無い）か。
 * 本家はこの場合「◯s考えました」もアクティビティも出さないため、既定では隠し、
 * 設定（ChatGPT > 検索の詳細を表示する）で表示できるようにする（styles/chat.css 参照）。
 */
const isSearchOnlyReasoning = (r) =>
  !r.preamble &&
  r.activity.some((a) => a.kind === 'search') &&
  r.activity.every((a) => a.kind === 'search' || (a.kind === 'thought' && !a.content)) &&
  (r.toolRows || []).every((w) => w.kind === 'web');

/**
 * ChatGPT（Native）の思考アクティビティを「◯m ◯s考えました」の折りたたみにする。
 * 展開には前置きテキストとツール要約の行（ウェブ検索は 1 つ目のサイトの favicon、
 * ターミナル実行はターミナルアイコン付き。クリックでアクティビティパネルが開く）を出す。
 * ツール実行の無い会話は、思考の要約と本文をそのまま展開に出す。
 */
function reasoningBlock(turn) {
  const r = turn.reasoning;
  const searchOnly = isSearchOnlyReasoning(r) ? ' search-only' : '';
  const label = r.recap || (r.durationSec ? `${fmtThinkDuration(r.durationSec)}考えました` : '思考プロセス');

  let body = r.preamble ? md.render(r.preamble) : '';
  const rows = (r.toolRows || [])
    .map(
      (w) =>
        `<button type="button" class="reasoning-web" data-turn="${turn.index}" title="アクティビティを表示">` +
        `${w.kind === 'exec' ? `<span class="fav-ico">${icon('terminal-2', 13)}</span>` : favIcoHtml(w.domain)}` +
        `<span>${escapeHtml(w.label)}</span></button>`
    )
    .join('');
  if (rows) {
    body += rows;
  } else {
    body += r.activity
      .filter((a) => a.kind === 'thought')
      .map((a) => md.render([a.summary && `**${a.summary}**`, a.content].filter(Boolean).join('\n\n')))
      .join('');
  }
  // 中身が何も無い思考は、本家と同じくラベルだけをテキストとして出す
  if (!body) return r.recap ? `<div class="reasoning-plain${searchOnly}">${escapeHtml(r.recap)}</div>` : '';

  return (
    `<details class="block reasoning${searchOnly}"><summary><span>${escapeHtml(label)}</span></summary>` +
    `<div class="block-body md">${body}</div></details>`
  );
}

/**
 * 吹き出し下の「情報源」ボタン（本家のフッターに相当）。情報源パネルを開く。
 *   - 検索だけの思考（既定で非表示）：ヒットしたドメイン先頭 3 つの favicon を重ねて出す。
 *     「検索の詳細を表示する」がオンのあいだは CSS（.for-search）で隠す
 *   - 検索ツール呼び出しが無い情報源（メモリ引用など）：ライブラリアイコンで常に出す
 *   - 本文のある思考を伴う検索：思考の展開から開けるため出さない
 */
function sourcesButtonHtml(turn) {
  const r = turn.reasoning;
  if (!r || !(r.sources?.length || r.memoryCount)) return '';
  const searched = r.activity.some((a) => a.kind === 'search') || r.toolRows.some((w) => w.kind === 'web');
  if (searched && !isSearchOnlyReasoning(r)) return '';

  const domains = [];
  for (const s of r.sources || []) {
    let d = '';
    try {
      d = new URL(s.url).hostname;
    } catch {}
    if (d && !domains.includes(d)) domains.push(d);
    if (domains.length >= 3) break;
  }
  const ico =
    searched && domains.length
      ? `<span class="fav-stack">${domains.map((d) => favIcoHtml(d)).join('')}</span>`
      : icon('book', 15);
  return (
    `<button class="act sources-btn${searched ? ' for-search' : ''}" data-act="sources"` +
    ` data-turn="${turn.index}" title="情報源を表示" aria-label="情報源">${ico}<span>情報源</span></button>`
  );
}

/* ------------------------------------- Perplexity（Native）の手順の連鎖 */

/** 結果行のドメイン表示。本家に合わせ www と末尾の公開サフィックスを落とす（表示のみ）。 */
const shortDomain = (d) => (d || '').replace(/^www\./, '').replace(/\.(?:com|net|org|co\.jp|or\.jp|ne\.jp|jp|io|ai|app|dev)$/, '');

/** ステップ配下に最初から見せる結果行の数。残りは「+さらに N」で開く */
const PPLX_RESULT_VISIBLE = 3;

const PPLX_STEP_ICON = { search: 'world-search', memory: 'clock-search', read: 'world', code: 'terminal-2', plain: 'list-search' };

/** ステップ 1 件。見出し（アイコン + タイトル）と、検索語・結果・コードのネスト。 */
function pplxStepHtml(step) {
  const head =
    (step.kind === 'thought' ? '<span class="pplx-dot"></span>' : icon(PPLX_STEP_ICON[step.kind] || 'list-search', 15)) +
    `<span class="pplx-step-title">${escapeHtml(step.title)}</span>`;

  const queries = (step.queries || [])
    .map((q) => `<div class="pplx-query">${icon('search', 13)}<span>${escapeHtml(q)}</span></div>`)
    .join('');

  const results = (step.results || [])
    .map(
      (r, i) =>
        `<a class="pplx-result${i >= PPLX_RESULT_VISIBLE ? ' pplx-rest' : ''}" href="${escapeHtml(r.url)}" target="_blank" rel="noopener">` +
        `${favIcoHtml(r.domain && r.domain.includes('.') ? r.domain : '')}` +
        `<span class="pplx-result-title">${escapeHtml(r.title || r.url)}</span>` +
        `<span class="pplx-result-domain">${escapeHtml(shortDomain(r.domain))}</span>` +
        `${r.trusted ? icon('discount-check', 14) : ''}</a>`
    )
    .join('');
  const rest = (step.results || []).length - PPLX_RESULT_VISIBLE;
  const more =
    rest > 0
      ? `<button type="button" class="pplx-more">+さらに${fmtInt(rest)}</button>` +
        `<button type="button" class="pplx-less">表示を減らす</button>`
      : '';

  let code = '';
  if (step.code) {
    const fence = fenceFor(step.code);
    let bodyMd = fence + '\n' + step.code + '\n' + fence;
    if (step.output) {
      const outFence = fenceFor(step.output);
      bodyMd += '\n\n' + outFence + '\n' + step.output + '\n' + outFence;
    }
    code = `<div class="pplx-code md">${md.render(bodyMd)}</div>`;
  }

  const body = queries + results + more + code;
  if (!body) return `<div class="pplx-step"><div class="pplx-step-head">${head}</div></div>`;
  // 既定は折りたたみ（本家の完了後表示と同じく、見出し行だけを出す）
  return (
    `<details class="pplx-step"><summary class="pplx-step-head">${head}${icon('chevron-down', 13)}</summary>` +
    `<div class="pplx-step-body">${body}</div></details>`
  );
}

/**
 * Perplexity（Native）の手順の連鎖（本家の Pro 検索ステップ表示に相当）。
 * 1 ステップならそのまま、複数なら「N ステップ完了」の折りたたみで束ねる。
 */
function pplxStepsHtml(turn) {
  const steps = turn.reasoning?.steps || [];
  if (!steps.length) return '';
  const body = steps.map((s) => pplxStepHtml(s)).join('');
  if (steps.length === 1) return `<div class="pplx-steps">${body}</div>`;
  return (
    `<div class="pplx-steps"><details class="pplx-wrap">` +
    `<summary>${escapeHtml(`${steps.length} ステップ完了`)}${icon('chevron-down', 13)}</summary>` +
    `<div class="pplx-chain">${body}</div></details></div>`
  );
}

/** ChatGPT（Native）の記事カード（nav_list）。画像・出典元・タイトル・日付の横並びカード。 */
function navCardsHtml(items) {
  if (!items?.length) return '';
  const cards = items
    .map((it) => {
      let domain = '';
      try {
        domain = new URL(it.url).hostname;
      } catch {}
      const date = it.date ? dtSource.format(new Date(it.date)) : '';
      return `<a class="nav-card" href="${escapeHtml(it.url)}" target="_blank" rel="noopener">
        ${it.thumbnail ? `<img class="nav-card-img" src="${escapeHtml(it.thumbnail)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
        <span class="nav-card-body">
          <span class="nav-card-site">${favIcoHtml(domain)}<span>${escapeHtml(it.attribution || domain)}</span></span>
          <span class="nav-card-title">${escapeHtml(it.title)}</span>
          ${date ? `<span class="nav-card-date">${escapeHtml(date)}</span>` : ''}
        </span>
      </a>`;
    })
    .join('');
  return `<div class="nav-cards">${cards}</div>`;
}

/**
 * Claude の <antArtifact> / <antThinking> を折りたたみブロックへ、
 * ChatGPT（Native）の <antNavList>（turn.navLists への参照）を記事カードへ、
 * ChatGPT の `:::writing{…}` ディレクティブを文章作成カードへ
 * 変換しつつ Markdown を描画する。
 */
function renderRich(text, turn, conv) {
  if (!text) return '';
  // link_open レンダラーが引用チップ（#cite-N）の解決に turn.citeLists を使う
  const env = { turn };
  const re =
    /<antArtifact\b([^>]*)>([\s\S]*?)<\/antArtifact>|<antThinking>([\s\S]*?)<\/antThinking>|<antNavList index="(\d+)"><\/antNavList>|^:::writing\{([^}\n]*)\}[ \t]*\n([\s\S]*?)\n:::[ \t]*$/gm;
  let html = '';
  let last = 0;
  let wseq = 0; // 同一ターン内に複数の writing ブロックがあるときの連番
  let m;

  while ((m = re.exec(text)) !== null) {
    const before = text.slice(last, m.index);
    if (before.trim()) html += md.render(before, env);
    last = m.index + m[0].length;

    if (m[5] !== undefined) {
      html += writingCardHtml(m[5], m[6], turn, conv, wseq++);
    } else if (m[4] !== undefined) {
      html += navCardsHtml(turn?.navLists?.[Number(m[4])]);
    } else if (m[3] !== undefined) {
      html += detailsBlock('thinking', 'bulb', '思考プロセス', md.render(m[3].trim()), false);
    } else {
      const attrs = m[1] || '';
      const title = attrOf(attrs, 'title') || attrOf(attrs, 'identifier') || 'Artifact';
      const type = attrOf(attrs, 'type');
      const lang = ARTIFACT_LANG[type] ?? '';
      const body = '```' + lang + '\n' + m[2].replace(/^\n+|\n+$/g, '') + '\n```';
      html += detailsBlock('artifact', 'package', title, md.render(body), true);
    }
  }
  const rest = text.slice(last);
  if (rest.trim()) html += md.render(rest, env);
  return html;
}

/* 単独行の Markdown 画像（添付画像がこの形で発言先頭に置かれる） */
const ATTACHMENT_IMG_LINE = /^!\[[^\]]*\]\([^)]*\)$/;

/**
 * 発言先頭に並ぶ添付画像（単独行の `![...](...)`）を本文から分離する。
 * ChatGPT のエクスポートでは添付がユーザー発言の冒頭に置かれるため、
 * 本家 UI と同じく吹き出しの外（上）に独立して描画するのに使う。
 */
function splitAttachments(text) {
  const lines = text.split('\n');
  const images = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line === '') { i++; continue; }
    if (!ATTACHMENT_IMG_LINE.test(line)) break;
    images.push(line);
    i++;
  }
  if (!images.length) return { images, rest: text };
  return { images, rest: lines.slice(i).join('\n').trim() };
}

/* ---------------------------------------------------------------- utils */

const $ = (sel) => document.querySelector(sel);
const fmtInt = (n) => Number(n || 0).toLocaleString('ja-JP');

const dtFull = new Intl.DateTimeFormat('ja-JP', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});
const dtShort = new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' });

const fmtDate = (ms, full) => (ms ? (full ? dtFull : dtShort).format(new Date(ms)) : '');

/* 「3時間前」「昨日」などの相対表記（numeric:'auto' が 昨日/一昨日 を出してくれる） */
const rtf = new Intl.RelativeTimeFormat('ja-JP', { numeric: 'auto' });

/** その日の 0 時の時刻（「昨日」を経過時間ではなく暦日で判定するため） */
const startOfDay = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

function fmtRelTime(ms) {
  if (!ms) return '';
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60) return 'たった今';
  if (sec < 3600) return rtf.format(-Math.floor(sec / 60), 'minute');
  if (sec < 86400) return rtf.format(-Math.floor(sec / 3600), 'hour');
  const days = Math.round((startOfDay(Date.now()) - startOfDay(ms)) / 86400000);
  if (days < 7) return rtf.format(-days, 'day');
  if (days < 30) return rtf.format(-Math.floor(days / 7), 'week');
  if (days < 365) return rtf.format(-Math.floor(days / 30), 'month');
  return rtf.format(-Math.floor(days / 365), 'year');
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* ------------------------------------------------------------ highlight */

/** 検索語を DOM のテキストノード上で <mark> 化する（ASCII は大小無視）。 */
function highlightIn(root, terms) {
  if (!terms || !terms.length) return 0;
  const lowered = terms.map((t) => t.toLowerCase()).filter(Boolean);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.nodeValue.trim() && node.parentElement.tagName !== 'MARK'
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT,
  });

  const targets = [];
  while (walker.nextNode()) targets.push(walker.currentNode);

  let count = 0;
  for (const node of targets) {
    const text = node.nodeValue;
    const hay = text.toLowerCase();
    const spans = [];
    for (const term of lowered) {
      let pos = 0;
      for (;;) {
        const at = hay.indexOf(term, pos);
        if (at === -1) break;
        spans.push([at, at + term.length]);
        pos = at + term.length;
      }
    }
    if (!spans.length) continue;

    spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const merged = [];
    for (const s of spans) {
      const last = merged[merged.length - 1];
      if (last && s[0] < last[1]) last[1] = Math.max(last[1], s[1]);
      else merged.push([...s]);
    }

    const frag = document.createDocumentFragment();
    let cursor = 0;
    for (const [start, end] of merged) {
      if (start > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, start)));
      const mark = document.createElement('mark');
      mark.textContent = text.slice(start, end);
      frag.appendChild(mark);
      cursor = end;
      count++;
    }
    if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
    node.parentNode.replaceChild(frag, node);
  }
  return count;
}

/** プレーンテキストを、検索語をハイライトした HTML 文字列にする。 */
function highlightText(text, terms) {
  const el = document.createElement('span');
  el.textContent = text;
  highlightIn(el, terms);
  return el.innerHTML;
}

/* ---------------------------------------------------------------- state */

const state = {
  q: '',
  sources: new Set(),
  allSources: [],
  from: '',
  to: '',
  favorite: false,
  archived: true,
  scope: 'all',
  sort: 'relevance',
  offset: 0,
  limit: 30,
  total: 0,
  terms: [],
  items: [],
  cursor: -1,
  activeId: null,
  loading: false,
  loadingMore: false,
  seq: 0,
};

/** 一覧の下端からこの距離まで来たら次ページを読む（px） */
const SCROLL_MARGIN = 400;

const el = {
  q: $('#q'), scope: $('#scope'),
  sources: $('#source-filter'),
  list: $('#result-list'), count: $('#result-count'), took: $('#result-took'), more: $('#result-more'),
  toast: $('#toast'),
  reader: $('#reader'), conversation: $('#conversation'), readerEmpty: $('#reader-empty'),
  hint: $('#search-hint'),
  btnSearch: $('#btn-search'), modal: $('#search-modal'),
  searchList: $('#search-list'), searchLabel: $('#search-label'),
  btnSettings: $('#btn-settings'), settingsModal: $('#settings-modal'),
  settingsTabs: $('#settings-tabs'), settingsPane: $('#settings-pane'),
};

/* ----------------------------------------------------------------- boot */

/**
 * テーマ。設定画面の「一般」で light / dark / system を選ぶ。
 * localStorage に light / dark があれば固定、無ければ OS の設定に追従する。
 */
const THEME_KEY = 'chv-theme';
const systemDarkMq = window.matchMedia('(prefers-color-scheme: dark)');

function themeSetting() {
  const v = localStorage.getItem(THEME_KEY);
  return v === 'light' || v === 'dark' ? v : 'system';
}

/** テーマを適用する。コードハイライトの配色は CSS 変数（tok-*）が追従する。 */
function applyTheme() {
  const setting = themeSetting();
  const mode = setting === 'system' ? (systemDarkMq.matches ? 'dark' : 'light') : setting;
  document.documentElement.dataset.theme = mode;
  // PWA のウィンドウ枠・ステータスバー色をトップバー（--bg-elev）に合わせる
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.content = mode === 'dark' ? '#161920' : '#ffffff';
}

function setThemeSetting(value) {
  if (value === 'system') localStorage.removeItem(THEME_KEY);
  else localStorage.setItem(THEME_KEY, value);
  applyTheme();
}

applyTheme();
systemDarkMq.addEventListener('change', applyTheme);

// 一覧ペインの開閉。狭い画面は本文の上にオーバーレイでスライドイン、
// 広い画面は端に折りたたむ（状態を記憶）
const narrowMq = window.matchMedia('(max-width: 900px)');
const RESULTS_WIDTH_KEY = 'chv-results-width';
const RESULTS_DEFAULT_WIDTH = 260;
const RESULTS_MIN_WIDTH = 200;
const RESULTS_MAX_WIDTH = 600;
const READER_MIN_WIDTH = 360;
const resultsPane = $('#results-pane');
const resultsResizer = $('#results-resizer');
let preferredResultsWidth = Number.parseFloat(localStorage.getItem(RESULTS_WIDTH_KEY));
if (!Number.isFinite(preferredResultsWidth)) preferredResultsWidth = RESULTS_DEFAULT_WIDTH;

function resultsWidthBounds() {
  const max = Math.max(
    RESULTS_MIN_WIDTH,
    Math.min(RESULTS_MAX_WIDTH, window.innerWidth - READER_MIN_WIDTH),
  );
  return { min: RESULTS_MIN_WIDTH, max };
}

function clampResultsWidth(width) {
  const { min, max } = resultsWidthBounds();
  return Math.round(Math.min(max, Math.max(min, width)));
}

/** 保存された希望幅を、現在の画面に収まる範囲で反映する。 */
function renderResultsWidth() {
  const { min, max } = resultsWidthBounds();
  const width = clampResultsWidth(preferredResultsWidth);
  document.body.style.setProperty('--results-w', `${width}px`);
  resultsResizer.setAttribute('aria-valuemin', String(min));
  resultsResizer.setAttribute('aria-valuemax', String(max));
  resultsResizer.setAttribute('aria-valuenow', String(width));
}

function setResultsWidth(width, persist = false) {
  preferredResultsWidth = clampResultsWidth(width);
  renderResultsWidth();
  if (persist) localStorage.setItem(RESULTS_WIDTH_KEY, String(preferredResultsWidth));
}

let resizePointerId = null;
let resizeStartX = 0;
let resizeStartWidth = RESULTS_DEFAULT_WIDTH;

resultsResizer.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || narrowMq.matches) return;
  resizePointerId = event.pointerId;
  resizeStartX = event.clientX;
  resizeStartWidth = resultsPane.getBoundingClientRect().width;
  resultsResizer.setPointerCapture(event.pointerId);
  document.body.classList.add('results-resizing');
  event.preventDefault();
});

resultsResizer.addEventListener('pointermove', (event) => {
  if (event.pointerId !== resizePointerId) return;
  setResultsWidth(resizeStartWidth + event.clientX - resizeStartX);
});

function finishResultsResize(event) {
  if (event.pointerId !== resizePointerId) return;
  if (resultsResizer.hasPointerCapture(event.pointerId)) {
    resultsResizer.releasePointerCapture(event.pointerId);
  }
  resizePointerId = null;
  document.body.classList.remove('results-resizing');
  localStorage.setItem(RESULTS_WIDTH_KEY, String(preferredResultsWidth));
}

resultsResizer.addEventListener('pointerup', finishResultsResize);
resultsResizer.addEventListener('pointercancel', finishResultsResize);
resultsResizer.addEventListener('keydown', (event) => {
  const current = resultsPane.getBoundingClientRect().width;
  let next = current;
  if (event.key === 'ArrowLeft') next -= event.shiftKey ? 48 : 16;
  else if (event.key === 'ArrowRight') next += event.shiftKey ? 48 : 16;
  else if (event.key === 'Home') next = resultsWidthBounds().min;
  else if (event.key === 'End') next = resultsWidthBounds().max;
  else return;
  event.preventDefault();
  setResultsWidth(next, true);
});

renderResultsWidth();
window.addEventListener('resize', renderResultsWidth);

/* iOS スタンドアロン PWA のビューポート補正（SO 78669293 / WebKit 218983）。
   高さの基準は CSS 側（dvh、standalone は lvh）に任せ、JS は「治す」だけ:
   1) キーボード・回転・復帰の後にビューポートが縮んだまま固着したら、
      画面実寸から求めた高さを --app-height に入れて上書きする。
      visualViewport.height 自体も固着することがあるため基準にしない。
   2) レイアウトビューポートがスクロールしたまま戻らないずれは原点へ戻す。
   タッチ端末の standalone 起動時のみ有効（デスクトップはウィンドウ可変なので対象外）。 */
if (
  window.visualViewport &&
  (matchMedia('(display-mode: standalone)').matches || navigator.standalone === true) &&
  matchMedia('(pointer: coarse)').matches
) {
  const vv = window.visualViewport;
  // iOS の screen.width/height は回転しても入れ替わらない（常に縦持ち基準）ため、
  // 現在の向きから「本来のビューポート全高」を求める
  const expectedHeight = () =>
    matchMedia('(orientation: portrait)').matches
      ? Math.max(screen.width, screen.height)
      : Math.min(screen.width, screen.height);
  const healViewport = () => {
    const shrink = expectedHeight() - window.innerHeight;
    if (shrink > 150) return; // キーボード表示中とみなし iOS に任せる
    if (shrink > 4) {
      document.documentElement.style.setProperty('--app-height', `${expectedHeight()}px`);
    } else {
      document.documentElement.style.removeProperty('--app-height'); // 正常なら CSS(lvh) に戻す
    }
    if (window.scrollY !== 0 || vv.offsetTop !== 0) window.scrollTo(0, 0);
  };
  vv.addEventListener('resize', healViewport);
  vv.addEventListener('scroll', healViewport);
  window.addEventListener('pageshow', healViewport);
  window.addEventListener('orientationchange', () => setTimeout(healViewport, 60));
  // キーボードを閉じた直後は resize が発火しないことがあるため blur 後にも実行
  document.addEventListener('focusout', () => setTimeout(healViewport, 150));
  healViewport();
}

if (localStorage.getItem('chv-results') === 'collapsed') document.body.classList.add('results-collapsed');
$('#btn-menu').addEventListener('click', () => {
  if (narrowMq.matches) {
    document.body.classList.toggle('menu-open');
    return;
  }
  const collapsed = document.body.classList.toggle('results-collapsed');
  if (collapsed) localStorage.setItem('chv-results', 'collapsed');
  else localStorage.removeItem('chv-results');
});
$('#scrim').addEventListener('click', () => document.body.classList.remove('menu-open'));

/** ファイル監視の状態表示（緑=監視中 / 灰=オフ / 赤=停止中） */
function watchStateHtml(watcher) {
  if (!watcher) return '';
  if (!watcher.enabled) return '<div class="watch-state is-off"><span class="watch-dot"></span>監視オフ</div>';
  if (!watcher.watching)
    return '<div class="watch-state is-error"><span class="watch-dot"></span>監視が停止中（再開を試みています）</div>';
  const at = watcher.lastAppliedAt ? `（最終更新 ${fmtDate(watcher.lastAppliedAt, true)}）` : '';
  return `<div class="watch-state"><span class="watch-dot"></span>変更を監視中${at}</div>`;
}

/** topbar 中央のソース絞り込み。広い画面はピルの横並び、狭い画面は「ソース」のリスト選択。 */
function renderSourceFilter() {
  // 再描画をまたいでモバイルのリストの開閉状態を保つ（選ぶたびに閉じない）
  const wasOpen = Boolean(el.sources.querySelector('.select-pop:not([hidden])'));

  const pills = state.allSources
    .map(
      (s) => `<button type="button" class="source-pill${state.sources.has(s.id) ? ' active' : ''}" data-id="${escapeHtml(s.id)}" aria-pressed="${state.sources.has(s.id)}">
        ${sourceLogo(s.id, s, false)}
        <span class="pill-label">${escapeHtml(s.label)}</span>
        <span class="pill-count">${fmtInt(s.count)}</span>
      </button>`
    )
    .join('');

  const options = state.allSources
    .map((s) => {
      const sel = state.sources.has(s.id);
      return `<button type="button" class="select-option" role="option" data-id="${escapeHtml(s.id)}" aria-selected="${sel}">
        <span class="opt-check">${sel ? icon('check', 14) : ''}</span>
        ${sourceLogo(s.id, s, false)}
        <span class="opt-label">${escapeHtml(s.label)}</span>
        <span class="pill-count">${fmtInt(s.count)}</span>
      </button>`;
    })
    .join('');

  el.sources.innerHTML = `
    <div class="source-pills" role="group" aria-label="ソースで絞り込み">${pills}</div>
    <div class="select-menu source-menu">
      <button type="button" class="select-btn" aria-haspopup="listbox" aria-expanded="${wasOpen}">
        <span class="select-current">ソース${state.sources.size ? `（${state.sources.size}）` : ''}</span>${icon('chevron-down', 14)}
      </button>
      <div class="select-pop" role="listbox" aria-label="ソースで絞り込み"${wasOpen ? '' : ' hidden'}>${options}</div>
    </div>`;

  const toggle = (id) => {
    if (state.sources.has(id)) state.sources.delete(id);
    else state.sources.add(id);
    renderSourceFilter();
    reload();
  };

  for (const btn of el.sources.querySelectorAll('.source-pill')) {
    btn.addEventListener('click', () => toggle(btn.dataset.id));
  }
  for (const opt of el.sources.querySelectorAll('.select-option')) {
    opt.addEventListener('click', () => toggle(opt.dataset.id));
  }
  const menuBtn = el.sources.querySelector('.select-btn');
  const pop = el.sources.querySelector('.select-pop');
  menuBtn.addEventListener('click', () => {
    pop.hidden = !pop.hidden;
    menuBtn.setAttribute('aria-expanded', String(!pop.hidden));
  });
}

// リスト選択（ソース・並び順・設定内）は、開いているメニューの外を押したら閉じる
document.addEventListener('pointerdown', (ev) => {
  const within = ev.target.closest('.select-menu');
  for (const pop of document.querySelectorAll('.select-pop:not([hidden])')) {
    const menu = pop.closest('.select-menu');
    if (menu === within) continue;
    pop.hidden = true;
    menu.querySelector('.select-btn').setAttribute('aria-expanded', 'false');
  }
});

/** 最新の /api/stats。設定モーダルの「サーバー概要」ペインが描画に使う */
let serverStats = null;

async function loadStats() {
  const stats = await fetch('/api/stats').then((r) => r.json());
  state.allSources = stats.sources;
  serverStats = stats;

  // 監視による更新で描き直されるので、選択中のソースは state から復元する
  renderSourceFilter();

  // サーバー概要を開いたまま更新が来たら描き直す
  if (isSettingsOpen() && settingsSource === STATS_TAB) renderSettingsPane();
}

/* --------------------------------------------------------------- search */

function buildQuery(offset, limit = state.limit) {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  if (state.sources.size) p.set('sources', [...state.sources].join(','));
  if (state.from) p.set('from', state.from);
  if (state.to) p.set('to', state.to);
  if (state.favorite) p.set('favorite', '1');
  if (!state.archived) p.set('archived', '0');
  p.set('scope', state.scope);
  p.set('sort', state.sort);
  p.set('basis', timeBasis);
  p.set('offset', String(offset));
  p.set('limit', String(limit));
  return p.toString();
}

/** 検索語と開いている会話を URL に残し、再読み込み・ブックマークで復元できるようにする。 */
function writeHash() {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  if (state.activeId) p.set('id', state.activeId);
  const s = p.toString();
  history.replaceState(null, '', s ? '#' + s : location.pathname);
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const t = p.get('t');
  return { q: p.get('q') || '', id: p.get('id') || '', turn: t == null ? null : Number(t) };
}

async function reload() {
  state.offset = 0;
  state.cursor = -1;
  writeHash();
  await fetchPage(true);
}

/** 一覧見出しの件数表記（差分更新でも件数だけはここで更新する） */
function renderResultCount(took) {
  el.count.textContent = state.total
    ? `${fmtInt(state.total)} 件${state.q ? ' が一致' : ''}`
    : state.q
    ? '一致する会話はありません'
    : '会話がありません';
  if (took != null) el.took.textContent = `${took} ms`;
}

/**
 * 一覧を読み込む。
 * @param {boolean} reset 先頭から読み直すか
 */
async function fetchPage(reset) {
  if (state.loading) return;
  state.loading = true;
  state.loadingMore = !reset;
  const seq = ++state.seq;

  if (reset) {
    el.count.textContent = '検索中…';
    el.took.textContent = '';
  }
  renderMore();

  let ok = false;
  try {
    const data = await fetch('/api/conversations?' + buildQuery(reset ? 0 : state.offset)).then((r) => r.json());
    if (seq !== state.seq) return;

    state.total = data.total;
    state.terms = data.terms;
    state.offset = data.offset + data.items.length;
    state.items = reset ? data.items : state.items.concat(data.items);

    if (reset) el.list.innerHTML = '';
    renderItems(data.items);

    renderResultCount(data.took);
    if (isSearchOpen()) renderSearchList();
    ok = true;
  } catch (err) {
    el.count.textContent = '読み込みに失敗しました';
    console.error(err);
  } finally {
    state.loading = false;
    state.loadingMore = false;
    renderMore();
    // 読み込み中に監視の更新が届いていたら、落ち着いたところで差分を取り直す
    if (listRefreshQueued) {
      listRefreshQueued = false;
      scheduleListRefresh();
    }
    if (ok) autoLoadIfShort(); // 失敗時は無限リトライにならないよう見送る
  }
}

function sourceMetaOf(id) {
  return state.allSources.find((s) => s.id === id) || { label: id, color: '#8a8f98' };
}

/** ロゴ画像を持つソース（画像は CSS 側で theme に応じて出し分け） */
const LOGO_SOURCES = new Set(['chatgpt', 'claude', 'gemini', 'google_ai_mode', 'perplexity']);

/** ロゴがなければ色ドットで代用。隣にラベルがある場合は labelled=false で読み上げを省く。 */
function sourceLogo(id, meta, labelled = true) {
  const hasLogo = LOGO_SOURCES.has(id);
  const style = hasLogo ? '' : ` style="background-color:${escapeHtml(meta.color)}"`;
  const a11y = labelled
    ? ` role="img" title="${escapeHtml(meta.label)}" aria-label="${escapeHtml(meta.label)}"`
    : ' aria-hidden="true"';
  return `<span class="src-logo${hasLogo ? '' : ' is-dot'}" data-source="${escapeHtml(id)}"${a11y}${style}></span>`;
}

/** 行の中身の HTML。差分検出の署名も兼ねる（liHtmlCache と比較して変化した行だけ書き換える） */
function itemHtml(item) {
  const meta = sourceMetaOf(item.source);
  const snippets = (showSnippets ? item.snippets || [] : [])
    .map(
      (s) =>
        `<div class="ri-snippet" data-turn="${s.turnIndex}">` +
        `<span class="who">${s.role === 'user' ? '自分' : s.role === 'title' ? 'タイトル' : 'AI'}</span>` +
        `${highlightText(s.text, state.terms)}</div>`
    )
    .join('');

  return `
      <div class="ri-head">
        ${sourceLogo(item.source, meta)}
        <span class="ri-title">${highlightText(item.title, state.terms)}</span>        ${item.favorite ? `<span class="ri-star" title="お気に入り">${icon('star-filled', 13)}</span>` : ''}
        ${showListTime ? `<span class="ri-time" title="${fmtDate(itemTime(item), true)}">${fmtRelTime(itemTime(item))}</span>` : ''}
        ${showUpdateDots && updatedDots.has(item.relPath) ? `<span class="ri-dot" title="更新があります"></span>` : ''}
      </div>
      <div class="ri-meta">
        <span>${fmtDate(itemTime(item))}</span>
        <span>${fmtInt(item.turnCount)} 発言</span>
      </div>
      ${snippets || `<div class="ri-preview">${imageChipHtml(item)}${highlightText(item.preview, state.terms)}</div>`}`;
}

/** プレビュー先頭に置く添付画像チップ（画像アイコン + 枚数）。ホバーで画像をプレビューできる */
function imageChipHtml(item) {
  const count = imageCountScope === 'first' ? item.firstImageCount : item.imageCount;
  if (!count) return '';
  const label = imageCountScope === 'first' ? '添付画像（最初の発言）' : '添付画像';
  return `<span class="ri-img-chip" title="${label} ${fmtInt(count)} 枚">${icon('photo', 11)}${fmtInt(count)}</span>`;
}

/** li → 描画済み HTML（差分検出用の署名）。行を作り直さず変化だけを反映するために持つ */
const liHtmlCache = new WeakMap();

function buildItem(item) {
  const li = document.createElement('li');
  li.className = 'result-item' + (item.relPath === state.activeId ? ' active' : '');
  li.dataset.id = item.relPath;
  li.dataset.source = item.source; // styles/providers/*.css から行の見た目を差し替えられる
  const html = itemHtml(item);
  li.innerHTML = html;
  liHtmlCache.set(li, html);
  return li;
}

/** 既存の行を作り直さずに内容だけ最新化する（変化が無ければ何もしない） */
function patchItem(li, item) {
  if (li.dataset.source !== item.source) li.dataset.source = item.source;
  const html = itemHtml(item);
  if (liHtmlCache.get(li) !== html) {
    li.innerHTML = html;
    liHtmlCache.set(li, html);
  }
  li.classList.toggle('active', item.relPath === state.activeId);
}

/** 表示設定を変えたときに、読み込み直さず今ある行だけ描き直す */
function repaintItems() {
  const byId = new Map(state.items.map((it) => [it.relPath, it]));
  for (const li of el.list.children) {
    const item = byId.get(li.dataset.id);
    if (item) patchItem(li, item);
  }
}

function renderItems(items) {
  const frag = document.createDocumentFragment();
  for (const item of items) frag.appendChild(buildItem(item));
  el.list.appendChild(frag);
}

/** 一覧下の状態表示。追加読み込み中はスピナー、それ以外は残件数を出す。 */
function renderMore() {
  if (state.loadingMore) {
    el.more.innerHTML = '<span class="spinner" role="status" aria-label="読み込み中"></span>';
  } else if (state.offset < state.total) {
    el.more.textContent = `残り ${fmtInt(state.total - state.offset)} 件`;
  } else {
    el.more.textContent = state.total > state.limit ? 'すべて表示しました' : '';
  }
}

/** 一覧がスクロールできない高さのままなら、スクロール待ちにならないよう先に読む。 */
function autoLoadIfShort() {
  if (state.loading || state.offset >= state.total) return;
  if (el.list.scrollHeight <= el.list.clientHeight + SCROLL_MARGIN) fetchPage(false);
}

el.list.addEventListener('click', (ev) => {
  const li = ev.target.closest('.result-item');
  if (!li) return;
  const snippet = ev.target.closest('.ri-snippet');
  state.cursor = [...el.list.children].indexOf(li);
  openConversation(li.dataset.id, snippet ? Number(snippet.dataset.turn) : null);
});

el.list.addEventListener('scroll', () => {
  if (state.loading || state.offset >= state.total) return;
  if (el.list.scrollTop + el.list.clientHeight > el.list.scrollHeight - SCROLL_MARGIN) fetchPage(false);
});

/* ------------------------- 一覧の画像チップ（ホバーで添付画像をプレビュー） */

/** `scope:relPath` → /api/images の取得 Promise。ホバーのたびに読み直さない */
const imagePopCache = new Map();
/** プレビューに出す最大枚数（残りは「+n」で示す） */
const IMAGE_POP_MAX = 4;
/** ホバーしてから出すまでの猶予。行の上を素通りしただけでは出さない */
const IMAGE_POP_DELAY = 150;

const imagePop = document.createElement('div');
imagePop.id = 'image-pop';
imagePop.hidden = true;
document.body.appendChild(imagePop);

let imagePopChip = null; // ホバー中（読み込み待ち含む）のチップ
let imagePopTimer = null;

function hideImagePop() {
  clearTimeout(imagePopTimer);
  imagePopTimer = null;
  imagePopChip = null;
  imagePop.hidden = true;
  imagePop.innerHTML = '';
}

async function showImagePop(chip, relPath) {
  const cacheKey = `${imageCountScope}:${relPath}`;
  let job = imagePopCache.get(cacheKey);
  if (!job) {
    job = fetch(`/api/images?id=${encodeURIComponent(relPath)}&limit=${IMAGE_POP_MAX}&scope=${imageCountScope}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    imagePopCache.set(cacheKey, job);
  }
  const data = await job;
  if (!data) imagePopCache.delete(cacheKey); // 失敗は次のホバーで読み直す
  if (imagePopChip !== chip || !chip.isConnected) return; // ホバーが外れた・行が描き直された
  if (!data?.images?.length) return;

  const rest = data.total - data.images.length;
  imagePop.innerHTML =
    data.images.map((src) => `<img src="${escapeHtml(src)}" alt="">`).join('') +
    (rest > 0 ? `<span class="image-pop-more">+${fmtInt(rest)}</span>` : '');

  // 一旦不可視で出して実寸を測り、画面からはみ出さない位置に置く
  imagePop.style.visibility = 'hidden';
  imagePop.hidden = false;
  const r = chip.getBoundingClientRect();
  const w = imagePop.offsetWidth;
  const h = imagePop.offsetHeight;
  const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
  const top = r.bottom + 8 + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 8) : r.bottom + 8;
  imagePop.style.left = `${left}px`;
  imagePop.style.top = `${top}px`;
  imagePop.style.visibility = '';
}

el.list.addEventListener('mouseover', (ev) => {
  const chip = ev.target.closest('.ri-img-chip');
  if (!chip || chip === imagePopChip) return;
  hideImagePop();
  const li = chip.closest('.result-item');
  if (!li?.dataset.id) return;
  imagePopChip = chip;
  imagePopTimer = setTimeout(() => showImagePop(chip, li.dataset.id), IMAGE_POP_DELAY);
});

el.list.addEventListener('mouseout', (ev) => {
  if (!ev.target.closest('.ri-img-chip')) return;
  // チップ内の移動やプレビュー自体への移動では消さない
  const to = ev.relatedTarget;
  if (to && (imagePop.contains(to) || to.closest?.('.ri-img-chip') === imagePopChip)) return;
  hideImagePop();
});

imagePop.addEventListener('mouseleave', hideImagePop);
el.list.addEventListener('scroll', hideImagePop, { passive: true });

/* ---------------------------------------------------------- search popup */

/** ポップアップに出す候補の最大件数（続きは背後の一覧で見る） */
const SEARCH_LIST_MAX = 12;

/** ポップアップ内のキーボード選択位置（-1 は未選択） */
let searchCursor = -1;

const isSearchOpen = () => !el.modal.hidden;

/** 検索語の有無を虫めがねに反映する（入力欄が畳まれていて見えないため） */
function updateSearchButton() {
  el.btnSearch.classList.toggle('has-q', Boolean(state.q));
  el.btnSearch.title = state.q ? `検索: ${state.q}` : '検索（/）';
}

function renderSearchList() {
  const items = state.items.slice(0, SEARCH_LIST_MAX);
  el.searchLabel.textContent = state.q
    ? state.total
      ? `検索結果  ${fmtInt(state.total)} 件`
      : ''
    : '最近のチャット';

  if (!items.length) {
    el.searchList.innerHTML =
      `<li class="search-empty">${state.q ? '一致する会話はありません' : '会話がありません'}</li>`;
    searchCursor = -1;
    return;
  }

  el.searchList.innerHTML = items
    .map((item) => {
      const meta = sourceMetaOf(item.source);
      return `<li data-id="${escapeHtml(item.relPath)}" data-source="${escapeHtml(item.source)}">
        ${sourceLogo(item.source, meta, false)}
        <span class="sr-title">${highlightText(item.title, state.terms)}</span>
        <span class="sr-date">${fmtDate(itemTime(item))}</span>
      </li>`;
    })
    .join('');

  searchCursor = -1;
}

function moveSearchCursor(delta) {
  const items = [...el.searchList.querySelectorAll('li[data-id]')];
  if (!items.length) return;
  items.forEach((li) => li.classList.remove('cursor'));
  // -1（入力欄のみ）〜 items.length-1 を巡回させる
  const slots = items.length + 1;
  searchCursor = ((searchCursor + 1 + delta) % slots + slots) % slots - 1;
  if (searchCursor < 0) return; // 一周したら入力欄だけに戻す
  const li = items[searchCursor];
  li.classList.add('cursor');
  li.scrollIntoView({ block: 'nearest' });
}

function openSearch() {
  if (isSearchOpen()) {
    el.q.select();
    return;
  }
  el.modal.hidden = false;
  el.btnSearch.setAttribute('aria-expanded', 'true');
  renderSearchList();
  el.q.focus();
  el.q.select();
}

function closeSearch() {
  if (!isSearchOpen()) return;
  el.modal.hidden = true;
  el.btnSearch.setAttribute('aria-expanded', 'false');
  searchCursor = -1;
  el.q.blur();
}

el.btnSearch.addEventListener('click', openSearch);
$('#search-close').addEventListener('click', closeSearch);
$('#search-backdrop').addEventListener('click', closeSearch);

el.searchList.addEventListener('click', (ev) => {
  const li = ev.target.closest('li[data-id]');
  if (!li) return;
  closeSearch();
  state.cursor = state.items.findIndex((it) => it.relPath === li.dataset.id);
  openConversation(li.dataset.id, null);
});

el.q.addEventListener('keydown', (ev) => {
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    moveSearchCursor(ev.key === 'ArrowDown' ? 1 : -1);
    return;
  }
  if (ev.key === 'Enter') {
    ev.preventDefault();
    const li = el.searchList.querySelector('li.cursor');
    closeSearch();
    if (li) {
      state.cursor = state.items.findIndex((it) => it.relPath === li.dataset.id);
      openConversation(li.dataset.id, null);
    }
  }
});

/* -------------------------------------------------- 設定（共通） */

/**
 * チャットの日時の基準（'last'=最終メッセージ時刻 / 'start'=チャット開始時刻）。
 * 多くの公式アプリの一覧は最終メッセージ順なので、既定は 'last'。
 * 一覧の日付表示に加え、サーバー側の並び替え・期間絞り込みにも渡す。
 */
const TIME_BASIS_KEY = 'chv-time-basis';
let timeBasis = localStorage.getItem(TIME_BASIS_KEY) === 'start' ? 'start' : 'last';

/** 基準設定に応じた表示用日時。古い索引に lastTime が無ければ chatTime に落とす。 */
const itemTime = (item) => (timeBasis === 'last' ? item.lastTime ?? item.chatTime : item.chatTime);

/**
 * 検索結果の一覧にハイライト行（一致した発言の抜粋）を出すか。設定画面の「一般」で切り替える。
 * 既定は表示。オフにすると抜粋を描かないので、一覧はタイトル中心のコンパクトな見た目になる。
 */
const SHOW_SNIPPETS_KEY = 'chv-show-snippets';
let showSnippets = localStorage.getItem(SHOW_SNIPPETS_KEY) !== '0';

function setShowSnippets(on) {
  showSnippets = on;
  if (on) localStorage.removeItem(SHOW_SNIPPETS_KEY);
  else localStorage.setItem(SHOW_SNIPPETS_KEY, '0');
}

/**
 * 同期（自動反映）で追加・更新された会話に付く青いドット（未読マーク）を出すか。
 * 設定画面の「一般」で切り替える。既定は表示。
 */
const SHOW_UPDATE_DOTS_KEY = 'chv-show-update-dots';
let showUpdateDots = localStorage.getItem(SHOW_UPDATE_DOTS_KEY) !== '0';

function setShowUpdateDots(on) {
  showUpdateDots = on;
  if (on) localStorage.removeItem(SHOW_UPDATE_DOTS_KEY);
  else {
    localStorage.setItem(SHOW_UPDATE_DOTS_KEY, '0');
    updatedDots.clear(); // 付いているドットは repaintItems で消える
  }
}

/**
 * 一覧の各行の右端に出す相対時間（「3時間前」「昨日」など）を表示するか。
 * 設定画面の「一般」で切り替える。既定は表示。
 */
const SHOW_LIST_TIME_KEY = 'chv-show-list-time';
let showListTime = localStorage.getItem(SHOW_LIST_TIME_KEY) !== '0';

function setShowListTime(on) {
  showListTime = on;
  if (on) localStorage.removeItem(SHOW_LIST_TIME_KEY);
  else localStorage.setItem(SHOW_LIST_TIME_KEY, '0');
}

/**
 * 一覧の各行に出す日付・発言数（メタ）とプレビュー。設定画面の「一般」で
 * 全プロバイダー共通に切り替える。既定はコンパクト＝どちらも非表示。
 * 表示の切り替えは applyUiSettings が注入する CSS で行う。
 */
const SHOW_LIST_META_KEY = 'chv-show-list-meta';
let showListMeta = localStorage.getItem(SHOW_LIST_META_KEY) === '1';

function setShowListMeta(on) {
  showListMeta = on;
  if (on) localStorage.setItem(SHOW_LIST_META_KEY, '1');
  else localStorage.removeItem(SHOW_LIST_META_KEY);
}

const SHOW_LIST_PREVIEW_KEY = 'chv-show-list-preview';
let showListPreview = localStorage.getItem(SHOW_LIST_PREVIEW_KEY) === '1';

function setShowListPreview(on) {
  showListPreview = on;
  if (on) localStorage.setItem(SHOW_LIST_PREVIEW_KEY, '1');
  else localStorage.removeItem(SHOW_LIST_PREVIEW_KEY);
}

/**
 * 添付画像チップの数え方。'all' はチャット全体（ユーザー発言のみ）、
 * 'first' は最初の発言に添付したものだけ。ホバープレビューも同じ範囲になる。
 */
const IMAGE_COUNT_SCOPE_KEY = 'chv-image-count-scope';
let imageCountScope = localStorage.getItem(IMAGE_COUNT_SCOPE_KEY) === 'first' ? 'first' : 'all';

function setImageCountScope(value) {
  imageCountScope = value;
  if (value === 'first') localStorage.setItem(IMAGE_COUNT_SCOPE_KEY, 'first');
  else localStorage.removeItem(IMAGE_COUNT_SCOPE_KEY);
}

// 「5分前」が古いままにならないよう毎分描き直す（表記が変わった行だけ書き換わる）
setInterval(() => {
  if (showListTime && state.items.length) repaintItems();
}, 60_000);

/* -------------------------------------------------- 設定（プロバイダー別 UI） */

/**
 * プロバイダーごとの表示調整。styles/providers/*.css の CSS 変数を
 * <style id="provider-ui-style"> の注入で上書きする（後勝ち）。
 * 変更した値だけを localStorage に保存し、未指定の項目は各 CSS の既定のまま。
 */

const UI_SETTINGS_KEY = 'chv-provider-ui';

/** スライダーで調整する項目（.conversation の CSS 変数へ反映） */
const UI_FIELDS = [
  { key: 'fontSize', label: '文字サイズ', cssVar: '--chat-font-size', min: 12, max: 18, step: 0.5, unit: 'px' },
  { key: 'lineHeight', label: '行間', cssVar: '--chat-line-height', min: 1.4, max: 2.2, step: 0.05, unit: '' },
  { key: 'bubbleWidth', label: '自分の吹き出し幅', cssVar: '--user-bubble-max-width', min: 40, max: 100, step: 2, unit: '%' },
];

/**
 * アクセントカラー（本家 ChatGPT の「設定 → アクセントカラー」に相当）。
 * プロバイダーごとに用意でき、今は ChatGPT のみ。dot は選択メニューに出す色見本。
 *
 * 選んだ色は他の項目のような CSS 変数の注入ではなく、<html> の
 * data-accent-<source> 属性として置く。見た目は styles/providers/*.css が
 * この属性で切り替え、後から JS で読むときは accentOf(source) で取れる。
 * 「デフォルト」は属性を持たない状態（＝プロバイダー CSS の既定色）。
 */
const UI_ACCENTS = {
  chatgpt: [
    // dot の実値は styles/providers/chatgpt.css の --cgpt-swatch-*（本家の --accent-<色>）
    { value: 'default', label: 'デフォルト', dot: 'var(--cgpt-swatch-default)' },
    { value: 'blue', label: '青', dot: 'var(--cgpt-swatch-blue)' },
    { value: 'green', label: '緑', dot: 'var(--cgpt-swatch-green)' },
    { value: 'yellow', label: '黄', dot: 'var(--cgpt-swatch-yellow)' },
    { value: 'pink', label: 'ピンク', dot: 'var(--cgpt-swatch-pink)' },
    { value: 'orange', label: 'オレンジ', dot: 'var(--cgpt-swatch-orange)' },
    { value: 'purple', label: '紫', dot: 'var(--cgpt-swatch-purple)' },
    { value: 'black', label: '黒', dot: 'var(--cgpt-swatch-black)' },
  ],
};

const accentAttr = (source) => `data-accent-${source}`;

/** 現在のアクセントカラー。未設定なら 'default'（属性なし） */
const accentOf = (source) => document.documentElement.getAttribute(accentAttr(source)) || 'default';

/** stats が読めていないあいだのタブ用（並びは src/config.js の SOURCE_META と同じ） */
const FALLBACK_PROVIDERS = [
  { id: 'chatgpt', label: 'ChatGPT', color: '#10a37f' },
  { id: 'claude', label: 'Claude', color: '#d97757' },
  { id: 'gemini', label: 'Gemini', color: '#4285f4' },
  { id: 'google_ai_mode', label: 'Google AI Mode', color: '#ea4335' },
  { id: 'perplexity', label: 'Perplexity', color: '#20808d' },
  { id: 'lmstudio', label: 'LM Studio', color: '#8b5cf6' },
  { id: 'unknown', label: 'その他', color: '#8a8f98' },
];

let uiSettings = {};
try {
  uiSettings = JSON.parse(localStorage.getItem(UI_SETTINGS_KEY)) || {};
} catch { /* 壊れた保存値は捨てる */ }

const uiStyle = document.createElement('style');
uiStyle.id = 'provider-ui-style';
document.head.appendChild(uiStyle);

function applyUiSettings() {
  const css = [];
  for (const [source, conf] of Object.entries(uiSettings)) {
    const vars = UI_FIELDS.filter((f) => conf[f.key] != null)
      .map((f) => `${f.cssVar}:${conf[f.key]}${f.unit}`)
      .join(';');
    if (vars) css.push(`.conversation[data-source="${source}"]{${vars}}`);
  }

  // 一覧の行のメタ・プレビュー（「一般」の設定。全プロバイダー共通）
  if (showListMeta) css.push('.result-item .ri-meta{display:flex}');
  if (showListPreview) css.push('.result-item .ri-preview{display:-webkit-box}');

  uiStyle.textContent = css.join('\n');

  // アクセントカラーだけは属性で持つ（CSS からも後からの読み出しからも参照できる）
  for (const source of Object.keys(UI_ACCENTS)) {
    const value = uiSettings[source]?.accent;
    if (value && value !== 'default') document.documentElement.setAttribute(accentAttr(source), value);
    else document.documentElement.removeAttribute(accentAttr(source));
  }

  // 検索だけの思考の表示（ChatGPT のみ）。styles/chat.css が html.show-search-detail で切り替える
  document.documentElement.classList.toggle('show-search-detail', !!uiSettings.chatgpt?.searchDetail);
}

function saveUiSettings() {
  // 空になったプロバイダーは落としてから保存する
  for (const [source, conf] of Object.entries(uiSettings)) {
    if (!Object.keys(conf).length) delete uiSettings[source];
  }
  if (Object.keys(uiSettings).length) localStorage.setItem(UI_SETTINGS_KEY, JSON.stringify(uiSettings));
  else localStorage.removeItem(UI_SETTINGS_KEY);
  applyUiSettings();
}

// 旧形式（プロバイダーごとの showMeta / showPreview）からの引き継ぎ。
// どれか 1 つでも表示していたら「一般」の設定で表示にし、旧キーは捨てる。
{
  let migrated = false;
  for (const conf of Object.values(uiSettings)) {
    if ('showMeta' in conf || 'showPreview' in conf) {
      if (conf.showMeta) setShowListMeta(true);
      if (conf.showPreview) setShowListPreview(true);
      delete conf.showMeta;
      delete conf.showPreview;
      migrated = true;
    }
  }
  if (migrated) saveUiSettings();
  else applyUiSettings();
}

/** プロバイダー CSS が定める既定値を読む（未変更の項目のスライダー初期値用） */
function readProviderDefaults(source) {
  const probe = document.createElement('article');
  probe.className = 'conversation';
  probe.dataset.source = source;
  probe.hidden = true;
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const out = {};
  for (const f of UI_FIELDS) out[f.key] = parseFloat(cs.getPropertyValue(f.cssVar)) || f.min;
  probe.remove();
  return out;
}

/** プロバイダー ID と衝突しない「一般」タブの ID */
const GENERAL_TAB = '__general';
/** タブ列の一番下に離して置く「サーバー概要」タブの ID */
const STATS_TAB = '__stats';

let settingsSource = GENERAL_TAB; // 選択中のタブ

const isSettingsOpen = () => !el.settingsModal.hidden;

const settingsProviders = () => (state.allSources.length ? state.allSources : FALLBACK_PROVIDERS);

const isModified = (id) => Boolean(uiSettings[id] && Object.keys(uiSettings[id]).length);

function renderSettingsTabs() {
  const providers = settingsProviders();
  if (
    settingsSource !== GENERAL_TAB &&
    settingsSource !== STATS_TAB &&
    !providers.some((p) => p.id === settingsSource)
  ) {
    settingsSource = GENERAL_TAB;
  }

  const generalActive = settingsSource === GENERAL_TAB;
  const statsActive = settingsSource === STATS_TAB;
  el.settingsTabs.innerHTML =
    `<button class="settings-tab${generalActive ? ' active' : ''}" data-id="${GENERAL_TAB}" role="tab" aria-selected="${generalActive}">
      <span class="tab-icon" aria-hidden="true">${icon('settings', 16)}</span>
      <span class="tab-label">一般</span>
    </button>` +
    providers
      .map(
        (p) => `<button class="settings-tab${p.id === settingsSource ? ' active' : ''}" data-id="${escapeHtml(p.id)}" role="tab" aria-selected="${p.id === settingsSource}">
        ${sourceLogo(p.id, p, false)}
        <span class="tab-label">${escapeHtml(p.label)}</span>
        ${isModified(p.id) ? '<span class="tab-dot" title="既定から変更あり"></span>' : ''}
      </button>`
      )
      .join('') +
    `<button class="settings-tab tab-stats${statsActive ? ' active' : ''}" data-id="${STATS_TAB}" role="tab" aria-selected="${statsActive}">
      <span class="tab-icon" aria-hidden="true">${icon('server', 16)}</span>
      <span class="tab-label">サーバー概要</span>
    </button>`;
}

/** リスト選択（現在値のボタン＋チェックマーク付きメニュー）のマークアップ */
function selectMenuHtml(id, ariaLabel, options, current) {
  const cur = options.find((o) => o.value === current);
  return `<div class="select-menu" id="${id}">
    <button type="button" class="select-btn" aria-haspopup="listbox" aria-label="${ariaLabel}" aria-expanded="false">
      <span class="select-current">${cur.label}</span>${icon('chevron-down', 14)}
    </button>
    <div class="select-pop" role="listbox" aria-label="${ariaLabel}" hidden>
      ${options
        .map(
          (o) => `<button type="button" class="select-option" role="option" data-value="${o.value}" aria-selected="${o.value === current}">
          <span class="opt-label">${o.label}</span>
          <span class="opt-check">${o.value === current ? icon('check', 14) : ''}</span>
        </button>`
        )
        .join('')}
    </div>
  </div>`;
}

/** リスト選択の配線。ボタンで開閉し、項目を選ぶと onSelect(value) を呼ぶ */
function wireSelectMenu(id, onSelect) {
  const menu = $(`#${id}`);
  const btn = menu.querySelector('.select-btn');
  const pop = menu.querySelector('.select-pop');
  btn.addEventListener('click', () => {
    pop.hidden = !pop.hidden;
    btn.setAttribute('aria-expanded', String(!pop.hidden));
  });
  for (const opt of pop.querySelectorAll('.select-option')) {
    opt.addEventListener('click', () => onSelect(opt.dataset.value));
  }
}

/** on/off のトグルスイッチのマークアップ */
function switchHtml(id, ariaLabel, on) {
  return `<button type="button" class="switch" id="${id}" role="switch" aria-checked="${on}" aria-label="${ariaLabel}">
    <span class="switch-thumb"></span>
  </button>`;
}

/** トグルスイッチの配線。押すたびに onToggle(切り替えた後の値) を呼ぶ */
function wireSwitch(id, onToggle) {
  const btn = $(`#${id}`);
  btn.addEventListener('click', () => onToggle(btn.getAttribute('aria-checked') !== 'true'));
}

const THEME_OPTIONS = [
  { value: 'system', label: 'システム' },
  { value: 'dark', label: 'ダーク' },
  { value: 'light', label: 'ライト' },
];

const TIME_BASIS_OPTIONS = [
  { value: 'last', label: '最後のメッセージの時刻' },
  { value: 'start', label: 'チャットを開始した時刻' },
];

const IMAGE_SCOPE_OPTIONS = [
  { value: 'all', label: 'チャット全体' },
  { value: 'first', label: '最初の発言のみ' },
];

/** 「一般」ペイン。テーマとチャットの日時の基準（プロバイダーに依らない設定）。 */
function renderGeneralPane() {
  el.settingsPane.innerHTML = `
    <div class="settings-section-label">外観</div>
    <div class="setting-row">
      <label>テーマ</label>
      ${selectMenuHtml('theme-select', 'テーマ', THEME_OPTIONS, themeSetting())}
    </div>
    <div class="settings-section-label">検索結果</div>
    <div class="setting-row">
      <label>ハイライト行</label>
      ${switchHtml('snippets-switch', 'ハイライト行を表示', showSnippets)}
    </div>
    <p class="settings-note">オフにすると、一致した発言の抜粋（ハイライト行）を一覧に出しません。</p>
    <div class="setting-row">
      <label>時間表示</label>
      ${switchHtml('list-time-switch', '一覧に相対時間を表示', showListTime)}
    </div>
    <p class="settings-note">オフにすると、一覧の各行の右端に出る相対時間（「3時間前」「昨日」など）を出しません。</p>
    <div class="settings-section-label">一覧の行</div>
    <div class="setting-row">
      <label>日付・発言数</label>
      ${switchHtml('list-meta-switch', '一覧に日付・発言数を表示', showListMeta)}
    </div>
    <div class="setting-row">
      <label>プレビュー</label>
      ${switchHtml('list-preview-switch', '一覧にプレビューを表示', showListPreview)}
    </div>
    <p class="settings-note">一覧の各行に日付・発言数と本文のプレビューを表示します。全プロバイダー共通で、オフ（既定）ではタイトル中心のコンパクトな見た目になります。</p>
    <div class="setting-row">
      <label>画像の枚数</label>
      ${selectMenuHtml('image-scope-select', '添付画像の数え方', IMAGE_SCOPE_OPTIONS, imageCountScope)}
    </div>
    <p class="settings-note">プレビューに出す添付画像チップの枚数の数え方。「最初の発言のみ」はチャット開始時に添付した画像だけを数えます。ホバーで出る画像も同じ範囲になります。</p>
    <div class="settings-section-label">同期</div>
    <div class="setting-row">
      <label>更新ドット</label>
      ${switchHtml('update-dots-switch', '更新ドットを表示', showUpdateDots)}
    </div>
    <p class="settings-note">オフにすると、同期で追加・更新された会話に付く青いドット（未読マーク）を出しません。</p>
    <div class="settings-section-label">チャットの日時</div>
    <div class="setting-row">
      <label>日時の基準</label>
      ${selectMenuHtml('time-basis-select', '日時の基準', TIME_BASIS_OPTIONS, timeBasis)}
    </div>
    <p class="settings-note">日時の基準は一覧の日付表示のほか、並び替えと期間の絞り込みにも使われます。「最後のメッセージの時刻」は多くの公式アプリと同じ並びです。</p>`;

  wireSelectMenu('theme-select', (value) => {
    setThemeSetting(value);
    renderGeneralPane(); // 選択表示とチェックを描き直す（メニューも閉じる）
  });

  wireSwitch('snippets-switch', (on) => {
    setShowSnippets(on);
    repaintItems(); // 抜粋の有無だけの変更なので読み込み直さない
    renderGeneralPane();
  });

  wireSwitch('list-time-switch', (on) => {
    setShowListTime(on);
    repaintItems(); // 時間表示の有無だけの変更なので読み込み直さない
    renderGeneralPane();
  });

  wireSwitch('list-meta-switch', (on) => {
    setShowListMeta(on);
    applyUiSettings(); // 表示の切り替えは注入 CSS だけなので再描画は不要
    renderGeneralPane();
  });

  wireSwitch('list-preview-switch', (on) => {
    setShowListPreview(on);
    applyUiSettings();
    renderGeneralPane();
  });

  wireSelectMenu('image-scope-select', (value) => {
    setImageCountScope(value);
    repaintItems(); // チップの枚数表記だけの変更なので読み込み直さない
    renderGeneralPane();
  });

  wireSwitch('update-dots-switch', (on) => {
    setShowUpdateDots(on);
    repaintItems(); // オフにしたとき、付いているドットをその場で消す
    renderGeneralPane();
  });

  wireSelectMenu('time-basis-select', (value) => {
    if (value !== timeBasis) {
      timeBasis = value;
      localStorage.setItem(TIME_BASIS_KEY, timeBasis);
      reload(); // 並び順・日付表示を新しい基準で読み直す
      if (state.activeId) openConversation(state.activeId, null, { keepScroll: true });
    }
    renderGeneralPane();
  });
}

/* ---------- GitHub 風ヒートマップ（サーバー概要・プロバイダー別のアクティビティ） */

/** サーバーの activity と同じ形式の日付キー（ローカル時刻で 'YYYY-MM-DD'） */
function heatDayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 過去 1 年（今日まで、週は日曜はじまり）の日別会話数を GitHub 風に描く。
 * counts は /api/stats の activity と同じ { 'YYYY-MM-DD': 件数 }。
 * 色の濃さは表示範囲の最大値に対する比率で 4 段階（0 件は空マス）。
 */
function heatmapHtml(counts, color) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - 364);
  start.setDate(start.getDate() - start.getDay()); // 直前の日曜まで戻して列を揃える

  const days = [];
  let total = 0;
  let max = 0;
  for (const d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
    const count = counts[heatDayKey(d)] || 0;
    days.push({ date: new Date(d), count });
    total += count;
    if (count > max) max = count;
  }

  const cells = days
    .map(({ date, count }) => {
      const level = count === 0 ? 0 : Math.max(1, Math.ceil((count / max) * 4));
      const label = `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}: ${count} 件`;
      return `<span class="hm-cell" data-level="${level}" title="${label}"></span>`;
    })
    .join('');

  // 月ラベル。週（列）の先頭の日曜で月が替わった列にだけ置く
  const weeks = Math.ceil(days.length / 7);
  let prevMonth = -1;
  let months = '';
  for (let w = 0; w < weeks; w++) {
    const d = days[w * 7].date;
    if (d.getMonth() !== prevMonth) {
      months += `<span style="grid-column:${w + 1}">${d.getMonth() + 1}月</span>`;
      prevMonth = d.getMonth();
    }
  }

  return `
    <div class="heatmap" style="--hm-color:${color}">
      <div class="hm-days" aria-hidden="true"><span></span><span>月</span><span></span><span>水</span><span></span><span>金</span><span></span></div>
      <div class="hm-scroll">
        <div class="hm-months" style="grid-template-columns:repeat(${weeks}, var(--hm-cell))">${months}</div>
        <div class="hm-grid">${cells}</div>
      </div>
    </div>
    <p class="settings-note hm-note">過去 1 年の会話 ${fmtInt(total)} 件（チャット開始日で集計）</p>`;
}

/** ペイン描画後に呼び、ヒートマップを右端（今日）までスクロールしておく */
function scrollHeatmaps() {
  for (const sc of el.settingsPane.querySelectorAll('.hm-scroll')) sc.scrollLeft = sc.scrollWidth;
}

/** 「サーバー概要」ペイン。索引の統計・監視状態と再構築ボタン（旧サイドバーの統計）。 */
function renderStatsPane() {
  if (!serverStats) {
    el.settingsPane.innerHTML = '<p class="settings-note">統計を読み込み中…</p>';
    return;
  }
  const s = serverStats;

  // 全プロバイダー合算の日別件数
  const totalCounts = {};
  for (const bucket of Object.values(s.activity || {})) {
    for (const [day, n] of Object.entries(bucket)) totalCounts[day] = (totalCounts[day] || 0) + n;
  }

  el.settingsPane.innerHTML = `
    <div class="settings-section-label">サーバー概要</div>
    <div class="server-stats">
      <div>会話 <b>${fmtInt(s.conversations)}</b> 件 / 発言 <b>${fmtInt(s.totalTurns)}</b> 件</div>
      <div>本文 <b>${fmtInt(Math.round(s.totalChars / 10000))}</b> 万文字（索引 ${(s.indexBytes / 1048576).toFixed(0)} MB）</div>
      <div>${fmtDate(s.earliest)} 〜 ${fmtDate(s.latest)}</div>
      <div class="root">${escapeHtml(s.root)}</div>
      ${watchStateHtml(s.watcher)}
    </div>
    <div class="settings-section-label">アクティビティ</div>
    ${heatmapHtml(totalCounts, '#3fb950')}
    <button class="btn-block" id="btn-reindex">索引を再構築</button>`;

  scrollHeatmaps();

  $('#btn-reindex').addEventListener('click', async (ev) => {
    ev.target.disabled = true;
    ev.target.textContent = '再構築中…（コンソール参照）';
    await fetch('/api/reindex', { method: 'POST' });
    setTimeout(() => location.reload(), 4000);
  });
}

function renderSettingsPane() {
  if (settingsSource === GENERAL_TAB) {
    renderGeneralPane();
    return;
  }
  if (settingsSource === STATS_TAB) {
    renderStatsPane();
    return;
  }

  const source = settingsSource;
  const conf = uiSettings[source] || {};
  const defaults = readProviderDefaults(source);

  const sliders = UI_FIELDS.map((f) => {
    const set = conf[f.key] != null;
    const value = set ? conf[f.key] : defaults[f.key];
    return `<div class="setting-row" data-key="${f.key}">
      <label for="set-${f.key}">${f.label}</label>
      <input type="range" id="set-${f.key}" min="${f.min}" max="${f.max}" step="${f.step}" value="${value}">
      <span class="setting-value${set ? '' : ' is-default'}">${set ? `${value}${f.unit}` : '既定'}</span>
    </div>`;
  }).join('');

  // アクセントカラー（持っているプロバイダーだけ）。色見本付きのリスト選択
  const accents = UI_ACCENTS[source];
  const accentRow = accents
    ? `<div class="settings-section-label">外観</div>
    <div class="setting-row">
      <label>アクセントカラー</label>
      ${selectMenuHtml(
        'accent-select',
        'アクセントカラー',
        accents.map((a) => ({
          value: a.value,
          label: `<span class="accent-dot" style="background:${a.dot}"></span>${a.label}`,
        })),
        conf.accent || 'default'
      )}
    </div>`
    : '';

  // 検索だけの思考の表示（ChatGPT のみ）。本家は展開を出さないため既定はオフ
  const searchDetailRow =
    source === 'chatgpt'
      ? `<div class="settings-section-label">思考アクティビティ</div>
    <div class="setting-row">
      <label>検索の詳細を表示する</label>
      ${switchHtml('search-detail-switch', '検索の詳細を表示する', !!conf.searchDetail)}
    </div>
    <p class="settings-note">オンにすると、検索だけで完了した思考にも「◯s考えました」の折りたたみとアクティビティ（検索語）を表示します。オフでは本家と同じく省略します。</p>`
      : '';

  // このプロバイダーのアクティビティ（統計が未取得のあいだは出さない）
  const meta = settingsProviders().find((p) => p.id === source);
  const heatmapRow = serverStats
    ? `<div class="settings-section-label">アクティビティ</div>
    ${heatmapHtml(serverStats.activity?.[source] || {}, meta?.color || '#8a8f98')}`
    : '';

  el.settingsPane.innerHTML = `
    ${heatmapRow}
    ${accentRow}
    ${searchDetailRow}
    <div class="settings-section-label">チャット表示</div>
    ${sliders}
    <button class="btn-block" id="settings-reset">${icon('arrow-back-up', 14)}このプロバイダーを既定に戻す</button>
    <p class="settings-note">設定はこのブラウザに保存され、すぐに反映されます。会話を開いたまま調整できます。</p>`;

  scrollHeatmaps();

  if (accents) {
    wireSelectMenu('accent-select', (value) => {
      if (value === 'default') delete uiSettings[source]?.accent;
      else (uiSettings[source] ??= {}).accent = value;
      saveUiSettings(); // 属性の付け外しも applyUiSettings が行う
      renderSettingsTabs();
      renderSettingsPane(); // 選択表示とチェックを描き直す（メニューも閉じる）
    });
  }

  if (searchDetailRow) {
    wireSwitch('search-detail-switch', (on) => {
      if (on) (uiSettings[source] ??= {}).searchDetail = true;
      else if (uiSettings[source]) delete uiSettings[source].searchDetail;
      saveUiSettings(); // html クラスの付け外しも applyUiSettings が行う
      renderSettingsTabs();
      renderSettingsPane();
    });
  }

  for (const f of UI_FIELDS) {
    const row = el.settingsPane.querySelector(`.setting-row[data-key="${f.key}"]`);
    const input = row.querySelector('input');
    const valueEl = row.querySelector('.setting-value');
    input.addEventListener('input', () => {
      const v = Number(input.value);
      (uiSettings[source] ??= {})[f.key] = v;
      valueEl.textContent = `${v}${f.unit}`;
      valueEl.classList.remove('is-default');
      saveUiSettings();
      renderSettingsTabs();
    });
  }

  $('#settings-reset').addEventListener('click', () => {
    delete uiSettings[source];
    saveUiSettings();
    renderSettingsTabs();
    renderSettingsPane();
  });
}

function openSettings() {
  if (isSettingsOpen()) return;
  // 開いている会話のプロバイダーを最初に選んでおく（調整しながら確認しやすい）
  const current = el.conversation.dataset.source;
  if (current && settingsProviders().some((p) => p.id === current)) settingsSource = current;
  el.settingsModal.hidden = false;
  el.btnSettings.setAttribute('aria-expanded', 'true');
  renderSettingsTabs();
  renderSettingsPane();
}

function closeSettings() {
  if (!isSettingsOpen()) return;
  el.settingsModal.hidden = true;
  el.btnSettings.setAttribute('aria-expanded', 'false');
}

el.btnSettings.addEventListener('click', openSettings);
$('#settings-close').addEventListener('click', closeSettings);
$('#settings-backdrop').addEventListener('click', closeSettings);

el.settingsTabs.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.settings-tab');
  if (!btn || btn.dataset.id === settingsSource) return;
  settingsSource = btn.dataset.id;
  renderSettingsTabs();
  renderSettingsPane();
});

/* ---------------------------------------------------------------- reader */

let hitMarks = [];
let hitIndex = -1;
/** 表示中の会話。引用チップのホバーカードが citeLists を引くのに使う */
let activeConv = null;

/** 1 ターン分の HTML。初期描画と、上方向 Lazy 読み込みの継ぎ足しの両方で使う。 */
function renderTurnHtml(turn, conv) {
  const who = turn.role === 'user' ? '自分' : turn.role === 'note' ? 'メモ' : conv.sourceMeta.label;
  const extras =
    (turn.sources ? detailsBlock('', 'link', '出典', md.render(turn.sources), false) : '') +
    (turn.related ? detailsBlock('', 'help-circle', '関連する質問', md.render(turn.related), false) : '');

  // ChatGPT は本家 UI に合わせ、添付画像を吹き出しの外（上）に独立表示する
  let bodyText = turn.text;
  let attachmentsHtml = '';
  if (conv.source === 'chatgpt' && turn.role === 'user') {
    const { images, rest } = splitAttachments(turn.text);
    if (images.length) {
      // 1枚=1列 / 2枚=2列 / 3枚以上=3列（CSS グリッドが4枚目以降を自動で折り返す）
      const cols = Math.min(images.length, 3);
      attachmentsHtml = `<div class="turn-attachments md cols-${cols}">${md.render(images.join('\n\n'))}</div>`;
      bodyText = rest;
    }
  }
  // Native 描画の思考は本文の上に置く。Perplexity は手順の連鎖、ChatGPT は「◯m ◯s考えました」
  const reasoningHtml =
    turn.role === 'assistant' && turn.reasoning
      ? turn.reasoning.steps
        ? pplxStepsHtml(turn)
        : reasoningBlock(turn)
      : '';
  const bubbleHtml =
    bodyText.trim() || extras || reasoningHtml
      ? `<div class="bubble md">${reasoningHtml}${renderRich(bodyText, turn, conv)}${extras}</div>`
      : '';

  return `<div class="turn ${turn.role}" data-turn="${turn.index}">
      <div class="turn-head">
        <span class="turn-who">${escapeHtml(who)}</span>
        ${turn.time ? `<span>${escapeHtml(turn.time)}</span>` : ''}
      </div>
      ${attachmentsHtml}${bubbleHtml}
      <div class="turn-actions">
        <button class="act" data-act="copy" data-turn="${turn.index}" title="コピー" aria-label="コピー">${icon('copy')}</button>
        <button class="act" data-act="share" data-turn="${turn.index}" title="共有（この発言へのリンク）" aria-label="共有">${icon('share')}</button>
        <button class="act" data-act="edit" data-turn="${turn.index}" title="Obsidian で編集" aria-label="編集">${icon('pencil')}</button>
        ${turn.role === 'assistant' ? sourcesButtonHtml(turn) : ''}
      </div>
    </div>`;
}

/** 会話を開くときに最初に取得する末尾のターン数 */
const INITIAL_TAIL_TURNS = 4;
/** 上へスクロールしたとき一度に継ぎ足す過去のターン数 */
const OLDER_CHUNK_TURNS = 10;
/** 本文の上端からこの距離まで来たら過去のターンを読む（px） */
const TOP_LOAD_MARGIN = 300;

/** openConversation の競合ガード（連打時は最後の呼び出しだけを描画する） */
let convSeq = 0;

/**
 * リーダーのスクロール位置を瞬時に合わせる。.reader は scroll-behavior: smooth のため、
 * scrollTop への代入だとアニメーションになり、通過中の上端付近で
 * 過去ターンの Lazy 読み込みが誤発火してしまう。
 */
const setReaderScroll = (top) => el.reader.scrollTo({ top, behavior: 'instant' });

/**
 * 会話を開く。
 * @param {string} relPath
 * @param {number|null} focusTurn スクロールして光らせる発言
 * @param {{keepScroll?: boolean}} options keepScroll=true なら読書位置を保つ（監視による再読み込み用）
 */
async function openConversation(relPath, focusTurn, { keepScroll = false } = {}) {
  flushWritingEdits(); // カードが描き直される前に、打ちかけの編集を確定する
  // アクティビティは開いていた会話のものなので、別の会話へ移るときに閉じる
  if (relPath !== state.activeId) closeActivity();
  clearUpdatedDot(relPath); // 開いたら「更新あり」の青ドットは消える
  state.activeId = relPath;
  el.list.querySelectorAll('.result-item').forEach((li) => li.classList.toggle('active', li.dataset.id === relPath));
  document.body.classList.add('reading');
  document.body.classList.remove('menu-open'); // オーバーレイの一覧から選んだら閉じる
  writeHash();

  const seq = ++convSeq;
  const scrollTop = el.reader.scrollTop;
  const prev = activeConv;

  // 取得する範囲を決める。
  //   - keepScroll（監視による再読み込み）… 表示済みの範囲＋末尾の新規分を読み直す
  //   - 発言指定・検索語あり             … 位置ジャンプと一致ナビのため全件
  //   - それ以外（通常のオープン）        … 末尾だけ先に出し、過去は上スクロールで継ぎ足す
  const tailMode = !keepScroll && focusTurn == null && !state.terms.length;
  let range = '';
  if (keepScroll && prev?.relPath === relPath && prev.turnFrom > 0) range = '&turnFrom=' + prev.turnFrom;
  else if (tailMode) range = '&tail=' + INITIAL_TAIL_TURNS;

  if (!keepScroll) {
    // 前の会話が残ったままにせず、すぐにまっさらな状態にする
    activeConv = null;
    closeCitePop();
    closeWritingView();
    el.conversation.innerHTML = '';
    el.conversation.hidden = false;
    el.readerEmpty.hidden = true;
    setReaderScroll(0);
  }

  await cmHighlightReady;
  const conv = await fetch('/api/conversation?id=' + encodeURIComponent(relPath) + range).then((r) => r.json());
  if (seq !== convSeq) return; // 描画前に別の会話が開かれた
  if (conv.error) {
    if (keepScroll) showToast('この会話は索引から消えました', { iconName: 'trash', warn: true, ms: 0 });
    return;
  }
  // 取得した範囲（pageTurns）とは別に、turn.index（全体でのインデックス）で引ける
  // 疎配列を conv.turns に持つ。turn-actions・引用チップ・アクティビティが index で参照する
  const pageTurns = conv.turns;
  conv.turns = [];
  for (const t of pageTurns) conv.turns[t.index] = t;
  activeConv = conv;
  closeCitePop();

  const links = [];
  if (conv.url)
    links.push(
      `<a href="${escapeHtml(conv.url)}" target="_blank" rel="noopener">元のチャットを開く${icon('external-link', 13)}</a>`
    );
  links.push(`<a href="obsidian://open?path=${encodeURIComponent(conv.absPath)}">Obsidian で開く</a>`);
  links.push(`<a href="/api/raw?id=${encodeURIComponent(relPath)}" target="_blank" rel="noopener">Markdown 原文</a>`);

  const turnsHtml = pageTurns.map((turn) => renderTurnHtml(turn, conv)).join('');

  // プロバイダーごとの描画スタイル（styles/providers/*.css）の切り替えスイッチ
  el.conversation.dataset.source = conv.source || 'unknown';

  el.conversation.innerHTML = `
    <div class="conv-head">
      <h1 class="conv-title">${escapeHtml(conv.title)}</h1>
      <div class="conv-meta">
        <span class="badge" style="color:${escapeHtml(conv.sourceMeta.color)}">${escapeHtml(conv.sourceMeta.label)}</span>
        ${conv.native ? `<span class="badge badge-native" title=".raw.json の会話ツリーから描画しています">Native</span>` : ''}
        <span>${fmtDate(itemTime(conv), true)}</span>
        <span>${fmtInt(conv.turnCount)} 発言 / ${fmtInt(conv.chars)} 文字</span>
        ${conv.favorite ? `<span class="ri-star">${icon('star-filled', 13)}</span>` : ''}
        ${links.join('<span style="opacity:.4">·</span>')}
        <span class="hitnav" id="hitnav" hidden>
          <button class="icon-btn" id="hit-prev" title="前の一致" aria-label="前の一致">${icon('arrow-up', 14)}</button>
          <span id="hit-label"></span>
          <button class="icon-btn" id="hit-next" title="次の一致" aria-label="次の一致">${icon('arrow-down', 14)}</button>
        </span>
      </div>
    </div>
    <div class="turns">${turnsHtml}</div>`;

  el.conversation.hidden = false;
  el.readerEmpty.hidden = true;
  if (keepScroll) setReaderScroll(scrollTop);
  else if (tailMode) setReaderScroll(el.reader.scrollHeight); // 一番最後のチャットの位置で開く
  else setReaderScroll(0);

  // 検索語をハイライトし、一致箇所を辿れるようにする
  hitMarks = [];
  hitIndex = -1;
  if (state.terms.length) {
    highlightIn(el.conversation.querySelector('.turns'), state.terms);
    hitMarks = [...el.conversation.querySelectorAll('.turns mark')];
    if (hitMarks.length) {
      $('#hitnav').hidden = false;
      $('#hit-prev').addEventListener('click', () => gotoHit(-1));
      $('#hit-next').addEventListener('click', () => gotoHit(1));
      updateHitLabel();
    }
  }

  if (focusTurn !== null && focusTurn >= 0) {
    const target = el.conversation.querySelector(`.turn[data-turn="${focusTurn}"]`);
    if (target) {
      target.scrollIntoView({ block: 'center' });
      target.classList.add('turn-hit');
      setTimeout(() => target.classList.remove('turn-hit'), 1600);
      hitIndex = hitMarks.findIndex((m) => target.contains(m));
      updateHitLabel();
      return;
    }
  }
  // 監視による再読み込みでは、読んでいた位置を一致箇所へ飛ばさない
  if (hitMarks.length && !keepScroll) gotoHit(1);

  // 末尾だけの表示でビューポートが埋まらないときは、スクロールを待たずに過去分を継ぎ足す
  if (tailMode) fillOlderIfShort();
}

/* ------------------------------------- 過去ターンの Lazy 読み込み（上方向） */

/** 過去のターンを取得中か（多重リクエスト防止） */
let loadingOlder = false;

/** 表示済みより前のターンをひとかたまり取得して上に継ぎ足す。読書位置は保つ。 */
async function loadOlderTurns() {
  const conv = activeConv;
  if (!conv || !(conv.turnFrom > 0) || loadingOlder) return;
  const turnsEl = el.conversation.querySelector('.turns');
  if (!turnsEl) return;
  loadingOlder = true;

  const spin = document.createElement('div');
  spin.className = 'turns-loading';
  spin.innerHTML = '<span class="spinner" role="status" aria-label="読み込み中"></span>';
  turnsEl.prepend(spin);

  try {
    const to = conv.turnFrom;
    const from = Math.max(0, to - OLDER_CHUNK_TURNS);
    const data = await fetch(
      `/api/conversation?id=${encodeURIComponent(conv.relPath)}&turnFrom=${from}&turnTo=${to}`
    ).then((r) => r.json());
    if (activeConv !== conv || data.error) return; // 取得中に別の会話へ移った

    spin.remove();
    const prevHeight = el.reader.scrollHeight;
    const prevTop = el.reader.scrollTop;
    turnsEl.insertAdjacentHTML('afterbegin', data.turns.map((t) => renderTurnHtml(t, conv)).join(''));
    for (const t of data.turns) conv.turns[t.index] = t;
    conv.turnFrom = data.turnFrom;
    // 継ぎ足した分だけスクロール位置を送り、読んでいた場所を保つ
    setReaderScroll(prevTop + (el.reader.scrollHeight - prevHeight));
  } finally {
    spin.remove();
    loadingOlder = false;
  }
  fillOlderIfShort();
}

/** 上端付近（またはスクロールできない高さ）のあいだは続けて過去分を読む。 */
function fillOlderIfShort() {
  if (el.reader.scrollTop < TOP_LOAD_MARGIN) loadOlderTurns();
}

el.reader.addEventListener('scroll', fillOlderIfShort, { passive: true });

/** 発言へのパーマリンク（#id=…&t=…）。開き直すとその発言までスクロールする。 */
function turnLink(turnIndex) {
  const p = new URLSearchParams({ id: state.activeId, t: String(turnIndex) });
  return `${location.origin}${location.pathname}#${p}`;
}

/** 吹き出し下のアクション（コピー / 共有 / 編集）を実行する。 */
async function runTurnAction(btn, conv) {
  const turn = conv.turns[Number(btn.dataset.turn)];
  const original = btn.innerHTML;
  const flash = (name) => {
    btn.innerHTML = icon(name);
    btn.classList.add('done');
    setTimeout(() => {
      btn.innerHTML = original;
      btn.classList.remove('done');
    }, 1200);
  };

  if (btn.dataset.act === 'sources') {
    if (turn?.reasoning) openSources(turn.reasoning);
    return;
  }

  if (btn.dataset.act === 'copy') {
    await navigator.clipboard.writeText(turn.text);
    flash('check');
    return;
  }

  if (btn.dataset.act === 'share') {
    const url = turnLink(turn.index);
    if (navigator.share) {
      try {
        await navigator.share({ title: conv.title, url });
        return;
      } catch (err) {
        if (err.name === 'AbortError') return; // ユーザーが共有シートを閉じただけ
      }
    }
    await navigator.clipboard.writeText(url); // 共有先がなければリンクをコピー
    flash('check');
    return;
  }

  // 編集：元の Markdown を Obsidian で開く
  location.href = 'obsidian://open?path=' + encodeURIComponent(conv.absPath);
}

// 吹き出し下のアクションと「N件のウェブサイトを検索しました」は、過去分の
// 継ぎ足しで増える要素にも効くよう、会話全体への委譲で拾う
el.conversation.addEventListener('click', (ev) => {
  if (!activeConv) return;
  const act = ev.target.closest('.turn-actions .act');
  if (act) {
    runTurnAction(act, activeConv);
    return;
  }
  const attImg = ev.target.closest('.turn-attachments img');
  if (attImg) {
    openImageView(attImg);
    return;
  }
  const web = ev.target.closest('.reasoning-web');
  if (web) {
    const turn = activeConv.turns[Number(web.dataset.turn)];
    if (turn?.reasoning) openActivity(turn.reasoning);
    return;
  }
  // Perplexity の手順：結果行の「+さらに N」⇔「表示を減らす」
  const moreBtn = ev.target.closest('.pplx-more, .pplx-less');
  if (moreBtn) {
    moreBtn.closest('.pplx-step-body').classList.toggle('expanded', moreBtn.classList.contains('pplx-more'));
  }
});

/* コードブロック右上のコピーボタン（markdown 描画時に .codeblock 内へ挿入される） */
document.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('.code-copy');
  if (!btn) return;
  const code = btn.closest('.codeblock').querySelector('pre code, pre');
  await navigator.clipboard.writeText(code ? code.textContent.replace(/\n$/, '') : '');
  btn.innerHTML = icon('check', 15);
  btn.classList.add('done');
  setTimeout(() => {
    btn.innerHTML = icon('copy', 15);
    btn.classList.remove('done');
  }, 1200);
});

/* ------------------------------------------- 添付画像のフルサイズプレビュー */

const imgViewModal = $('#imgview-modal');
const imgViewImg = $('#imgview-img');
const isImgViewOpen = () => !imgViewModal.hidden;

/** 添付のサムネイル（1:1 切り抜き）をタップしたとき、フル画像を重ねて表示する */
function openImageView(img) {
  imgViewImg.src = img.currentSrc || img.src;
  imgViewImg.alt = img.alt || '';
  imgViewModal.hidden = false;
}

function closeImageView() {
  if (!isImgViewOpen()) return;
  imgViewModal.hidden = true;
  imgViewImg.removeAttribute('src'); // 次を開いたとき前の画像が一瞬見えないように
}

$('#imgview-close').addEventListener('click', closeImageView);
$('#imgview-backdrop').addEventListener('click', closeImageView);

/* ------------------------------------------- 文章作成ドキュメント（:::writing） */

/*
 * ChatGPT の文章作成（canvas）は Markdown へ `:::writing{…} … :::` として
 * エクスポートされる。これを本家風のドキュメントカードとして描画する。
 *
 *   - 本文は常に編集可能（クリックしてそのまま打ち始める）。本家の canvas と
 *     同じく、太字・見出しなどの描画を保ったまま直接編集する
 *   - 保存は自動。入力が落ち着く・フォーカスが外れる・別の操作をする、の
 *     いずれかで版として確定し、ひと続きの編集は 1 つの版にまとまる
 *   - 版はこのブラウザ（localStorage）にだけ積み上がり、
 *     元の .md ファイルは一切変更しない
 *   - 「戻す / やり直す」で版を行き来でき、いちばん最初まで戻すと
 *     実際の履歴ファイルに残っている内容（原文）に復元される
 */

/** 表示中ドキュメントの原文。docKey → { title, original }（renderRich が登録する） */
const writingDocs = new Map();

const WRITING_STORE_PREFIX = 'chv-writing:';

/** ローカル編集の版を読む。{ versions: string[], cursor: number }。cursor 0 = 原文 */
function readWritingStore(docKey) {
  try {
    const s = JSON.parse(localStorage.getItem(WRITING_STORE_PREFIX + docKey));
    if (s && Array.isArray(s.versions)) {
      return { versions: s.versions, cursor: Math.min(Math.max(0, s.cursor | 0), s.versions.length) };
    }
  } catch { /* 壊れた保存値は原文扱いに落とす */ }
  return { versions: [], cursor: 0 };
}

function saveWritingStore(docKey, store) {
  const key = WRITING_STORE_PREFIX + docKey;
  try {
    if (store.versions.length) localStorage.setItem(key, JSON.stringify(store));
    else localStorage.removeItem(key);
  } catch {
    showToast('編集を保存できませんでした（ブラウザの保存容量）', { iconName: 'alert-triangle', warn: true });
  }
}

/** いま表示すべき本文。cursor 0 は原文、それ以外はローカル編集の版 */
function writingCurrentText(docKey) {
  const store = readWritingStore(docKey);
  return store.cursor === 0 ? writingDocs.get(docKey)?.original ?? '' : store.versions[store.cursor - 1];
}

/** カードの外枠。renderRich から呼ばれ、原文を writingDocs に登録する */
function writingCardHtml(attrs, content, turn, conv, seq) {
  const id = attrOf(attrs, 'id');
  const title = attrOf(attrs, 'title');
  // 同じ id の文書が別ターンに再登場する（書き直し）ことがあるため、ターン番号も鍵に含める
  const docKey = `${conv?.relPath || ''}#t${turn?.index ?? 0}#w${id || 'n' + seq}`;
  writingDocs.set(docKey, { title, original: content });
  return `<section class="writing-card" data-dockey="${escapeHtml(docKey)}">${writingCardInnerHtml(docKey)}</section>`;
}

const writingIconBtn = (act, name, label) =>
  `<button type="button" class="w-act" data-wact="${act}" title="${label}" aria-label="${label}">${icon(name, 16)}</button>`;

/*
 * 本文の描画にはリンクチップ・コードコピー等の装飾を持たないプレーンな
 * markdown-it を使い、DOM が素直な HTML（h1〜h6 / p / strong / em …）に
 * なるようにしておく。contenteditable での編集後、Markdown への逆変換は
 * その語彙だけを相手にすればよい。
 */
const mdPlain = window.markdownit({ html: false, linkify: true, breaks: true });

/** ツールバーの中身。版の状態が変わるたびにここだけ描き直す（本文には触らない） */
function writingToolbarInnerHtml(docKey) {
  const store = readWritingStore(docKey);
  const canUndo = store.cursor > 0;
  const canRedo = store.cursor < store.versions.length;
  // 戻す・やり直すは押せるときだけ出す（本家と同じく、区切り線ごと消える）
  const history =
    canUndo || canRedo
      ? (canUndo ? writingIconBtn('undo', 'arrow-back-up', '前の版に戻す') : '') +
        (canRedo ? writingIconBtn('redo', 'arrow-forward-up', '次の版へ進む') : '') +
        '<span class="writing-sep"></span>'
      : '';
  const left = canUndo
    ? '<span class="writing-local" title="この版はこのブラウザにだけ自動保存されています（元のファイルは変更されません）">ローカル編集</span>'
    : '<span class="writing-note">直接編集できます（自動保存 · 元のファイルは変更されません）</span>';
  return (
    `${left}<span class="writing-tools">${history}${writingIconBtn('copy', 'copy', 'コピー')}` +
    `${writingIconBtn('download', 'download', 'Markdown をダウンロード')}${writingIconBtn('expand', 'arrows-diagonal', '拡大表示')}</span>`
  );
}

/** カードの中身。本文は常に contenteditable で、描画されたまま直接編集できる */
function writingCardInnerHtml(docKey) {
  return (
    `<div class="writing-toolbar">${writingToolbarInnerHtml(docKey)}</div>
    <div class="writing-body md writing-editable" contenteditable="true" spellcheck="false">${mdPlain.render(writingCurrentText(docKey))}</div>`
  );
}

/** カード全体（ツールバー＋本文）を描き直す。版の移動後などに使う */
function renderWritingCard(card) {
  card.innerHTML = writingCardInnerHtml(card.dataset.dockey);
  writingSessions.delete(card); // 本文を差し替えたので編集セッションも仕切り直す
}

function updateWritingToolbar(card) {
  card.querySelector('.writing-toolbar').innerHTML = writingToolbarInnerHtml(card.dataset.dockey);
}

// 編集領域への貼り付けはプレーンテキストとして挿入する
// （他サイトの装飾 HTML が紛れ込むと Markdown へ戻せなくなるため）
document.addEventListener('paste', (ev) => {
  if (!ev.target.closest?.('.writing-editable')) return;
  ev.preventDefault();
  document.execCommand('insertText', false, ev.clipboardData.getData('text/plain'));
});

/* ---------- 自動保存。入力が落ち着いたら（またはフォーカスが外れたら）版として確定する */

/** 入力が止まってから保存するまでの待ち時間（ms） */
const WRITING_SAVE_DELAY = 1200;

/** まだ保存していない編集を持つカード */
const writingDirty = new Set();
let writingSaveTimer = null;

/**
 * ひと続きの編集（フォーカスがカードの外へ出るまで）は 1 つの版にまとめる。
 * card → その編集で積んだ版の位置。同じ位置にいるあいだの自動保存は版を置き換える
 */
const writingSessions = new WeakMap();

/** カードの未保存の編集を版として確定する（変更が無ければ何もしない） */
function flushWritingCard(card) {
  const docKey = card.dataset.dockey;
  const body = card.querySelector('.writing-editable');
  if (!docKey || !body) return;
  const text = writingBlocksMd(body);
  // 逆変換は空行の詰め方などで原文と一致しないことがあるため、意味（描画結果）で比較する
  if (mdPlain.render(text) === mdPlain.render(writingCurrentText(docKey))) return;
  const store = readWritingStore(docKey);
  if (writingSessions.get(card) === store.cursor && store.cursor > 0) {
    store.versions[store.cursor - 1] = text; // 同じ編集セッション内は最新の内容で置き換える
  } else {
    store.versions = store.versions.slice(0, store.cursor); // 先の「やり直し」は捨てる
    store.versions.push(text);
    store.cursor = store.versions.length;
    writingSessions.set(card, store.cursor);
  }
  saveWritingStore(docKey, store);
  updateWritingToolbar(card); // 「戻す」やバッジを最新にする（本文とキャレットには触らない）
}

/** 保留中の自動保存をすべて確定する。会話の切り替え・各種操作の前にも呼ばれる */
function flushWritingEdits() {
  clearTimeout(writingSaveTimer);
  writingSaveTimer = null;
  for (const card of writingDirty) {
    if (card.isConnected) flushWritingCard(card);
  }
  writingDirty.clear();
}

document.addEventListener('input', (ev) => {
  const card = ev.target.classList?.contains('writing-editable') && ev.target.closest('.writing-card');
  if (!card) return;
  writingDirty.add(card);
  clearTimeout(writingSaveTimer);
  writingSaveTimer = setTimeout(flushWritingEdits, WRITING_SAVE_DELAY);
});

// フォーカスが外れたら即保存。カードの外へ出たときは編集セッションも締める
// （次の編集はまた新しい版として積まれる）
document.addEventListener('focusout', (ev) => {
  const card = ev.target.closest?.('.writing-card');
  if (!card) return;
  flushWritingEdits();
  if (!card.contains(ev.relatedTarget)) writingSessions.delete(card);
});

// タブを閉じる・離れるときの取りこぼし防止（localStorage への書き込みは同期）
window.addEventListener('pagehide', flushWritingEdits);

/* ---------- 編集領域の DOM → Markdown 逆変換 */

/** インラインコード。中身のバッククォート列より長い区切りで囲む */
function inlineCodeMd(text) {
  const runs = text.match(/`+/g);
  const ticks = '`'.repeat(runs ? Math.max(...runs.map((r) => r.length)) + 1 : 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return ticks + pad + text + pad + ticks;
}

/** インライン要素の並びを Markdown にする。BR は改行（breaks: true が復元する） */
function writingInlineMd(nodes) {
  let out = '';
  for (const node of nodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      // 生の改行は markdown-it がタグの後（<br> 直後など）に挟む整形用のもの。
      // 表示上は存在しない（改行は BR が担う）ので落とす。nbsp は普通の空白へ
      out += node.nodeValue.replace(/\n/g, '').replace(/ /g, ' ');
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = node.tagName;
    const inner = () => writingInlineMd(node.childNodes);
    if (tag === 'BR') out += '\n';
    else if (tag === 'STRONG' || tag === 'B') out += `**${inner()}**`;
    else if (tag === 'EM' || tag === 'I') out += `*${inner()}*`;
    else if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') out += `~~${inner()}~~`;
    else if (tag === 'CODE') out += inlineCodeMd(node.textContent);
    else if (tag === 'A') {
      const href = node.getAttribute('href') || '';
      const label = inner();
      out += label === href ? href : `[${label}](${href})`;
    } else if (tag === 'IMG') {
      out += `![${node.getAttribute('alt') || ''}](${node.getAttribute('src') || ''})`;
    } else if (tag === 'SPAN' && /bold|^[7-9]00$/.test(node.style.fontWeight)) {
      out += `**${inner()}**`; // 一部ブラウザの Ctrl+B は style 付き span を作る
    } else if (tag === 'SPAN' && node.style.fontStyle === 'italic') {
      out += `*${inner()}*`;
    } else {
      out += inner(); // その他の span 等は透過
    }
  }
  return out;
}

const WRITING_BLOCK_TAG = /^(P|DIV|H[1-6]|UL|OL|PRE|BLOCKQUOTE|HR|TABLE)$/;

/** ブロック要素 1 つを Markdown にする */
function writingBlockMd(el) {
  const tag = el.tagName;
  const h = /^H([1-6])$/.exec(tag);
  if (h) return `${'#'.repeat(Number(h[1]))} ${writingInlineMd(el.childNodes).replace(/\n/g, ' ').trim()}`;
  if (tag === 'HR') return '---';
  if (tag === 'PRE') {
    const code = el.querySelector('code');
    const lang = /language-(\S+)/.exec(code?.className || '')?.[1] || '';
    const body = (code || el).textContent.replace(/\n$/, '');
    const fence = fenceFor(body);
    return `${fence}${lang}\n${body}\n${fence}`;
  }
  if (tag === 'UL' || tag === 'OL') return writingListMd(el);
  if (tag === 'BLOCKQUOTE') {
    return writingBlocksMd(el)
      .split('\n')
      .map((line) => (line ? `> ${line}` : '>'))
      .join('\n');
  }
  if (tag === 'TABLE') return writingTableMd(el);
  // P / DIV / その他は段落
  return writingInlineMd(el.childNodes).trim();
}

function writingListMd(list) {
  const ordered = list.tagName === 'OL';
  let n = Number(list.getAttribute('start')) || 1;
  const lines = [];
  for (const li of list.children) {
    if (li.tagName !== 'LI') continue;
    const marker = ordered ? `${n++}. ` : '- ';
    const pad = ' '.repeat(marker.length);
    // 項目の直下を「テキストの流れ」と「入れ子のブロック」に分けて直列化する
    const inline = [];
    const parts = [];
    for (const node of li.childNodes) {
      if (node.nodeType === Node.ELEMENT_NODE && WRITING_BLOCK_TAG.test(node.tagName)) {
        const md = writingBlockMd(node);
        if (md) parts.push(md);
      } else {
        inline.push(node);
      }
    }
    const head = writingInlineMd(inline).trim();
    if (head) parts.unshift(head);
    const itemLines = parts.join('\n').split('\n');
    lines.push(marker + (itemLines[0] || ''));
    for (const line of itemLines.slice(1)) lines.push(pad + line);
  }
  return lines.join('\n');
}

function writingTableMd(table) {
  const rows = [...table.querySelectorAll('tr')];
  if (!rows.length) return '';
  const cells = (tr) =>
    [...tr.children].map((c) => writingInlineMd(c.childNodes).replace(/\n/g, ' ').replace(/\|/g, '\\|').trim());
  const head = cells(rows[0]);
  const out = [`| ${head.join(' | ')} |`, `|${head.map(() => ' --- ').join('|')}|`];
  for (const tr of rows.slice(1)) out.push(`| ${cells(tr).join(' | ')} |`);
  return out.join('\n');
}

/** コンテナ直下を歩き、ブロックの列として Markdown 化する（空段落は落とす） */
function writingBlocksMd(container) {
  const blocks = [];
  let run = ''; // ブロック要素の合間に直接置かれたテキスト・インラインの寄せ集め
  const flush = () => {
    const text = run.trim();
    if (text) blocks.push(text);
    run = '';
  };
  for (const node of container.childNodes) {
    if (node.nodeType === Node.ELEMENT_NODE && WRITING_BLOCK_TAG.test(node.tagName)) {
      flush();
      const md = writingBlockMd(node);
      if (md) blocks.push(md);
    } else if (node.nodeType === Node.TEXT_NODE) {
      run += node.nodeValue.replace(/ /g, ' ');
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      run += writingInlineMd([node]);
    }
  }
  flush();
  return blocks.join('\n\n');
}

/* ---------- 拡大表示。チャットプレビュー（リーダーのグリッドセル）全体に展開する。
             カードの DOM ごと #writing-view へ移し、閉じると元の位置へ戻す
             （移動なので、編集途中のテキストや版の状態はそのまま保たれる） */

const writingView = $('#writing-view');

/** 拡大表示中のカードと戻り先。{ card, marker } */
let writingHome = null;

const isWritingViewOpen = () => !writingView.hidden;

function openWritingView(card) {
  const marker = document.createComment('writing-card');
  card.parentNode.insertBefore(marker, card);
  // ヘッダーにはディレクティブの title 属性（内部データのタイトル）を出す
  $('#writing-view-title').textContent = writingDocs.get(card.dataset.dockey)?.title || 'ドキュメント';
  $('#writing-view-slot').appendChild(card);
  writingHome = { card, marker };
  writingView.hidden = false;
  writingView.querySelector('.writing-view-body').scrollTop = 0;
}

function closeWritingView() {
  if (!writingHome) return;
  const { card, marker } = writingHome;
  if (marker.parentNode) {
    marker.parentNode.insertBefore(card, marker);
  } else {
    // 会話が描き直されて戻り先が消えていたら、カードは捨てる（本文側に新しいカードがある）
    card.remove();
  }
  marker.remove();
  writingHome = null;
  writingView.hidden = true;
}

$('#writing-view-close').addEventListener('click', closeWritingView);

/* ツールバーの操作。カードは本文と拡大表示のどちらにも居られるため document で拾う */
document.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-wact]');
  if (!btn) return;
  const card = btn.closest('.writing-card');
  const docKey = card.dataset.dockey;
  const act = btn.dataset.wact;
  flushWritingEdits(); // 打ちかけの編集を確定してから操作する

  if (act === 'undo' || act === 'redo') {
    const store = readWritingStore(docKey);
    store.cursor = Math.min(Math.max(0, store.cursor + (act === 'undo' ? -1 : 1)), store.versions.length);
    saveWritingStore(docKey, store);
    renderWritingCard(card);
  } else if (act === 'copy') {
    await navigator.clipboard.writeText(writingCurrentText(docKey));
    btn.innerHTML = icon('check', 16);
    btn.classList.add('done');
    setTimeout(() => {
      btn.innerHTML = icon('copy', 16);
      btn.classList.remove('done');
    }, 1200);
  } else if (act === 'download') {
    const title = writingDocs.get(docKey)?.title || 'document';
    const url = URL.createObjectURL(new Blob([writingCurrentText(docKey)], { type: 'text/markdown' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title.replace(/[\\/:*?"<>|]/g, '_')}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } else if (act === 'expand') {
    openWritingView(card);
  }
});

function gotoHit(delta) {
  if (!hitMarks.length) return;
  hitIndex = (hitIndex + delta + hitMarks.length) % hitMarks.length;
  hitMarks[hitIndex].scrollIntoView({ block: 'center' });
  updateHitLabel();
}

function updateHitLabel() {
  const label = $('#hit-label');
  if (label) label.textContent = `${hitIndex < 0 ? 0 : hitIndex + 1} / ${hitMarks.length}`;
}

/** ロゴから戻るホーム状態。検索語と開いている会話を捨て、URL のハッシュも消す。 */
function goHome() {
  convSeq++; // 読み込み中の会話があっても描画させない
  flushWritingEdits(); // 会話ごと消す前に、打ちかけの編集を確定する
  closeActivity();
  closeCitePop();
  closeWritingView();
  activeConv = null;
  state.activeId = '';
  el.conversation.hidden = true;
  el.conversation.innerHTML = '';
  el.readerEmpty.hidden = false;
  document.body.classList.remove('reading');
  document.body.classList.remove('menu-open');

  state.q = '';
  el.q.value = '';
  updateSearchButton();
  reload(); // writeHash() も呼ばれ、#q・#id が消える
}

function closeReader() {
  document.body.classList.remove('reading');
  document.body.classList.remove('menu-open');
  if (window.innerWidth > 900) return;
  el.conversation.hidden = true;
  el.readerEmpty.hidden = false;
}

/* ------------------------------------------- 思考アクティビティ（別パネル） */

/** アクティビティのサイトチップはここまで表示し、残りは「あと N 個」にまとめる。 */
const ACTIVITY_CHIP_MAX = 3;

const activityPanel = $('#activity-panel');
const activityBackdrop = $('#activity-backdrop');

/** 表示中の思考。同じリンクをもう一度押したときの「閉じる」判定に使う */
let activeReasoning = null;
/** パネルの種類。'activity'（思考の時系列 + 情報源）| 'sources'（情報源のみ） */
let activePanelKind = 'activity';

function isActivityOpen() {
  return !activityPanel.hidden;
}

/** 閉じるアニメーション（CSS の .closing、0.4s）を待ってから hidden にするためのタイマー */
let activityCloseTimer = null;

function closeActivity() {
  if (activityPanel.hidden || activityPanel.classList.contains('closing')) return;
  activeReasoning = null;
  activityPanel.classList.add('closing');
  activityBackdrop.classList.add('closing');
  activityCloseTimer = setTimeout(() => {
    activityPanel.classList.remove('closing');
    activityBackdrop.classList.remove('closing');
    activityPanel.hidden = true;
    activityBackdrop.hidden = true;
  }, 400);
}

/** 本家のアクティビティ / 情報源パネル相当。開くリンクはトグルとして働き、
    同じ内容・同じ種類で開いていれば閉じる。 */
function openPanel(r, kind) {
  if (
    isActivityOpen() &&
    !activityPanel.classList.contains('closing') &&
    activeReasoning === r &&
    activePanelKind === kind
  ) {
    closeActivity();
    return;
  }
  // 閉じるアニメーションの途中でも、開き直しはすぐに切り替える
  clearTimeout(activityCloseTimer);
  activityPanel.classList.remove('closing');
  activityBackdrop.classList.remove('closing');
  activeReasoning = r;
  activePanelKind = kind;
  activityPanel.setAttribute('aria-label', kind === 'sources' ? '情報源' : 'アクティビティ');
  if (kind === 'sources') {
    $('#activity-title').textContent = '情報源';
    $('#activity-body').innerHTML = sourceSectionsHtml(r);
  } else {
    const dur = fmtThinkDuration(r.durationSec);
    $('#activity-title').innerHTML =
      'アクティビティ' + (dur ? `<span class="activity-duration"> · ${escapeHtml(dur)}</span>` : '');
    $('#activity-body').innerHTML = activityHtml(r);
  }
  activityPanel.hidden = false;
  activityBackdrop.hidden = false; // 背景はモバイルのモーダル表示時だけ CSS で見える
  $('#activity-body').scrollTop = 0;
}

/** 思考の時系列 + 情報源（メモリ・ウェブ）のパネル */
const openActivity = (r) => openPanel(r, 'activity');
/** 情報源（メモリ・ウェブ）だけのパネル。フッターの「情報源」ボタンから開く */
const openSources = (r) => openPanel(r, 'sources');

const dtSource = new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });

function activityHtml(r) {
  let html = '<div class="activity-section">思考中</div>';

  for (const item of r.activity) {
    if (item.kind === 'search') {
      const chip = (d, cls = '') => `<span class="activity-chip${cls}">${favIcoHtml(d)}<span>${escapeHtml(d)}</span></span>`;
      // 検索語（ChatGPT の search("…") / Perplexity の queries）は虫眼鏡アイコン（右端）付きのチップで先頭に出す
      const queries = item.queries || (item.query ? [item.query] : []);
      let chips = queries
        .map((q) => `<span class="activity-chip activity-query"><span>${escapeHtml(q)}</span>${icon('search', 13)}</span>`)
        .join('');
      chips += item.domains.slice(0, ACTIVITY_CHIP_MAX).map((d) => chip(d)).join('');
      const rest = item.domains.slice(ACTIVITY_CHIP_MAX);
      if (rest.length) {
        // 畳んだ残りは通常は隠し、「あと N 個」（残り先頭 3 つのファビコンを重ねて表示）で展開する
        const stack = rest.slice(0, 3).map((d) => favIcoHtml(d)).join('');
        chips += rest.map((d) => chip(d, ' chip-rest')).join('');
        chips +=
          `<button type="button" class="activity-chip activity-more">` +
          `<span class="fav-stack">${stack}</span><span>あと ${rest.length} 個</span></button>` +
          `<button type="button" class="activity-chip activity-less">表示を減らす</button>`;
      }
      html += `<div class="activity-item">
        <div class="activity-item-head">${icon('world', 14)}<span>${escapeHtml(item.title || 'ウェブを検索中')}</span></div>
        ${chips ? `<div class="activity-chips">${chips}</div>` : ''}
      </div>`;
      continue;
    }
    // ターミナル実行。コマンドのコードカードと実行結果を出す
    if (item.kind === 'exec') {
      const codeFence = fenceFor(item.code);
      let bodyMd = codeFence + (item.lang || '') + '\n' + item.code + '\n' + codeFence;
      if (item.output) {
        const outFence = fenceFor(item.output);
        bodyMd += '\n\n' + outFence + '\n' + item.output + '\n' + outFence;
      }
      html += `<div class="activity-item">
        <div class="activity-item-head">${icon('terminal-2', 14)}<span>${escapeHtml(item.title || 'コードを実行中')}</span></div>
        <div class="activity-item-body md">${md.render(bodyMd)}</div>
      </div>`;
      continue;
    }
    // 本家のアクティビティに合わせ、本文のある思考だけを出す（見出しだけの進捗は出さない）
    if (!item.content) continue;
    html += `<div class="activity-item">
      <div class="activity-item-head"><span class="activity-dot"></span><span>${escapeHtml(item.summary)}</span></div>
      <div class="activity-item-body md">${md.render(item.content)}</div>
    </div>`;
  }

  if (r.recap) {
    html += `<div class="activity-item">
      <div class="activity-item-head">${icon('circle-check', 14)}<span>${escapeHtml(r.recap)}</span></div>
      <div class="activity-item-body">完了</div>
    </div>`;
  }

  return html + sourceSectionsHtml(r);
}

/** 情報源の節（メモリ · N / ウェブ · N）。アクティビティと情報源の両パネルで使う。 */
function sourceSectionsHtml(r) {
  let html = '';

  // 過去のチャット（メモリ）への引用。参照先のタイトル・抜粋はエクスポータが
  // conversation_context_sources API から保存したもの（memorySources）。
  // 保存メモリ（Memory）はリンク先が無く、過去チャット（Past chat）は本家の会話へリンクする
  if (r.memorySources?.length) {
    html += `<div class="activity-section">メモリ · ${fmtInt(r.memorySources.length)}</div>`;
    html += r.memorySources
      .map((m) => {
        const date = m.date ? dtSource.format(new Date(m.date)) + ' — ' : '';
        const body = `<span class="activity-source-site">${icon(m.kind === 'general_memory' ? 'sparkles' : 'messages', 14)}<span>${escapeHtml(m.attribution)}</span></span>
          ${m.title ? `<span class="activity-source-title">${escapeHtml(m.title)}</span>` : ''}
          ${m.snippet ? `<span class="activity-source-snippet">${escapeHtml(date + m.snippet)}</span>` : ''}`;
        return m.url
          ? `<a class="activity-source activity-memory" href="${escapeHtml(m.url)}" target="_blank" rel="noopener">${body}</a>`
          : `<div class="activity-source activity-memory">${body}</div>`;
      })
      .join('');
  } else if (r.memoryCount) {
    // 参照先の無い古いエクスポートは件数と汎用の行だけを出す
    html += `<div class="activity-section">メモリ · ${fmtInt(r.memoryCount)}</div>
      <div class="activity-source activity-memory">
        <span class="activity-source-site">${icon('messages', 14)}<span>Past chat</span></span>
        <span class="activity-source-snippet">過去のチャットの記憶を参照しています（参照先はエクスポートに含まれていません）。</span>
      </div>`;
  }

  if (r.sources?.length) {
    html += `<div class="activity-section">ウェブ · ${fmtInt(r.sources.length)}</div>`;
    html += r.sources
      .map((s) => {
        let domain = '';
        try {
          domain = new URL(s.url).hostname;
        } catch {}
        const date = s.date ? dtSource.format(new Date(s.date)) + ' — ' : '';
        const snippet = date + (s.snippet || '');
        return `<a class="activity-source" href="${escapeHtml(s.url)}" target="_blank" rel="noopener">
          <span class="activity-source-site">${favIcoHtml(domain)}<span>${escapeHtml(s.attribution || domain)}</span></span>
          ${s.title ? `<span class="activity-source-title">${escapeHtml(s.title)}</span>` : ''}
          ${snippet ? `<span class="activity-source-snippet">${escapeHtml(snippet)}</span>` : ''}
        </a>`;
      })
      .join('');
  }
  return html;
}

$('#activity-close').addEventListener('click', closeActivity);
$('#activity-backdrop').addEventListener('click', closeActivity);

// 「あと N 個」⇔「表示を減らす」でサイトチップの一覧を開閉する
$('#activity-body').addEventListener('click', (ev) => {
  const btn = ev.target.closest('.activity-more, .activity-less');
  if (!btn) return;
  btn.closest('.activity-chips').classList.toggle('expanded', btn.classList.contains('activity-more'));
});

/* ------------------------------------------- 引用チップのホバーカード */

/*
 * 本文の引用チップ（「Reuters +2」）にホバーすると、出典の詳細カードを重ねて出す。
 * 複数出典のチップは ← → でページ送りでき、今開いているページが
 * そのままチップのリンク先になる。
 */

const citePop = $('#cite-pop');
/** 表示中のカード。{ chip, pages, idx } */
let citeState = null;
let citeHideTimer = null;

function closeCitePop() {
  clearTimeout(citeHideTimer);
  citePop.hidden = true;
  citeState = null;
}

function renderCitePop() {
  const { chip, pages, idx } = citeState;
  const p = pages[idx];
  let domain = '';
  try {
    domain = new URL(p.url).hostname;
  } catch {}
  const date = p.date ? dtSource.format(new Date(p.date)) + ' — ' : '';
  const snippet = date + (p.snippet || '');
  const nav =
    pages.length > 1
      ? `<div class="cite-pop-head">
          <button type="button" class="cite-pop-nav" data-dir="-1" aria-label="前の出典">${icon('arrow-left', 14)}</button>
          <button type="button" class="cite-pop-nav" data-dir="1" aria-label="次の出典">${icon('arrow-right', 14)}</button>
          <span class="cite-pop-count">${idx + 1}/${pages.length}</span>
        </div>`
      : '';
  // 信頼済みソース（Perplexity の trust）。理由文があればドメインを頭に付けて出す
  const trust = p.trusted
    ? `<div class="cite-pop-trust">
        <span class="cite-pop-trust-head">${icon('discount-check', 14)}<span>信頼済み</span></span>
        ${p.trustNote ? `<span class="cite-pop-trust-note"><b>${escapeHtml(domain)}</b> ${escapeHtml(p.trustNote)}</span>` : ''}
      </div>`
    : '';
  citePop.innerHTML = `${nav}
    <a class="cite-pop-item" href="${escapeHtml(p.url)}" target="_blank" rel="noopener">
      <span class="cite-pop-site">${favIcoHtml(domain)}<span>${escapeHtml(p.attribution || domain)}</span></span>
      ${p.title ? `<span class="cite-pop-title">${escapeHtml(p.title)}</span>` : ''}
      ${snippet ? `<span class="cite-pop-snippet">${escapeHtml(snippet)}</span>` : ''}
    </a>${trust}`;
  // 今開いているページをチップのリンク先にする
  chip.href = p.url;
}

function positionCitePop() {
  const rect = citeState.chip.getBoundingClientRect();
  citePop.style.visibility = 'hidden';
  citePop.hidden = false;
  const w = citePop.offsetWidth;
  const h = citePop.offsetHeight;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - w - 12));
  let top = rect.bottom + 6;
  if (top + h > window.innerHeight - 8) top = rect.top - h - 6;
  citePop.style.left = `${left}px`;
  citePop.style.top = `${top}px`;
  citePop.style.visibility = '';
}

function openCitePop(chip) {
  const turn = activeConv?.turns[Number(chip.closest('.turn')?.dataset.turn)];
  const pages = turn?.citeLists?.[Number(chip.dataset.cite)];
  if (!pages?.length) return;
  citeState = { chip, pages, idx: 0 };
  renderCitePop();
  positionCitePop();
}

// ホバーで開く。チップ⇔カード間の移動では消えないよう、少し待ってから閉じる
document.addEventListener('mouseover', (ev) => {
  const chip = ev.target.closest?.('.cite-chip');
  if (chip) {
    clearTimeout(citeHideTimer);
    if (citeState?.chip !== chip) openCitePop(chip);
    return;
  }
  if (ev.target.closest?.('#cite-pop')) clearTimeout(citeHideTimer);
});

document.addEventListener('mouseout', (ev) => {
  if (!citeState) return;
  if (!ev.target.closest?.('.cite-chip, #cite-pop')) return;
  const to = ev.relatedTarget;
  if (to && (to.closest?.('.cite-chip') === citeState.chip || to.closest?.('#cite-pop'))) return;
  clearTimeout(citeHideTimer);
  citeHideTimer = setTimeout(closeCitePop, 200);
});

// ← → でページ送り
citePop.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.cite-pop-nav');
  if (!btn || !citeState) return;
  const n = citeState.pages.length;
  citeState.idx = (citeState.idx + Number(btn.dataset.dir) + n) % n;
  renderCitePop();
  positionCitePop();
});

// カードは画面座標で固定なので、本文スクロールに追従せず閉じる
el.reader.addEventListener('scroll', () => closeCitePop(), { passive: true });

/* --------------------------------------------------------------- inputs */

// ロゴを押したらホーム（検索語・会話・#id なし）へ。修飾キー付きは新しいタブに任せる
$('#brand-home').addEventListener('click', (ev) => {
  if (ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
  ev.preventDefault();
  goHome();
});

el.q.addEventListener('input', debounce(() => {
  state.q = el.q.value.trim();
  el.hint.textContent = state.q ? '' : '';
  updateSearchButton();
  reload();
}, 220));

el.scope.addEventListener('change', () => { state.scope = el.scope.value; reload(); });
/** 並び順。結果ペインのヘッダーに置く独自ドロップダウン（#theme-select と同じ部品） */
const SORT_OPTIONS = [
  { value: 'relevance', label: '関連度' },
  { value: 'newest', label: '新しい順' },
  { value: 'oldest', label: '古い順' },
  { value: 'longest', label: '長い順' },
];

function renderSortMenu() {
  $('#sort-slot').innerHTML = selectMenuHtml('sort-menu', '並び順', SORT_OPTIONS, state.sort);
  wireSelectMenu('sort-menu', (value) => {
    if (value !== state.sort) {
      state.sort = value;
      reload();
    }
    renderSortMenu(); // 選択表示とチェックを描き直す（メニューも閉じる）
  });
}
renderSortMenu();

document.addEventListener('keydown', (ev) => {
  // contenteditable（文章作成ドキュメントの WYSIWYG 編集）も「入力中」として扱う
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(ev.target.tagName) || ev.target.isContentEditable;

  if (ev.key === 'Escape') {
    if (isImgViewOpen()) closeImageView();
    else if (isWritingViewOpen()) closeWritingView();
    else if (isSearchOpen()) closeSearch();
    else if (isSettingsOpen()) closeSettings();
    else if (window.askModal?.isOpen()) window.askModal.close();
    else if (isActivityOpen()) closeActivity();
    else if (typing) ev.target.blur();
    else closeReader();
    return;
  }
  // 設定・「履歴に質問」・画像プレビューを開いているあいだは他のショートカットを止める
  if (isSettingsOpen() || window.askModal?.isOpen() || isImgViewOpen()) return;

  if ((ev.key === '/' && !typing) || ((ev.ctrlKey || ev.metaKey) && ev.key === 'k')) {
    ev.preventDefault();
    openSearch();
    return;
  }
  if (typing) return;

  if (ev.key === 'j' || ev.key === 'k') {
    ev.preventDefault();
    const items = [...el.list.children];
    if (!items.length) return;
    items.forEach((li) => li.classList.remove('cursor'));
    state.cursor = Math.min(Math.max(state.cursor + (ev.key === 'j' ? 1 : -1), 0), items.length - 1);
    const li = items[state.cursor];
    li.classList.add('cursor');
    li.scrollIntoView({ block: 'nearest' });
    openConversation(li.dataset.id, null);
    return;
  }
  if ((ev.key === 'n' || ev.key === 'N') && hitMarks.length) {
    ev.preventDefault();
    gotoHit(ev.key === 'n' ? 1 : -1);
  }
});

/* -------------------------------------------------- 更新の即時反映（監視） */

/**
 * サーバはファイルの追加・変更・削除を監視していて、索引へ反映するたびに
 * /api/events（SSE）で知らせてくる。ここではそれを自動で画面へ映す。
 *
 *   - チャットプレビューは絶対に再描画しない。開いている会話が更新されたら
 *     一覧の行に青いドットを付けるだけ（プレビューをスクロールすると消える）
 *   - 一覧は現在の検索条件のまま静かに取り直し、差分だけを DOM へ反映する。
 *     見えている範囲への追加は、隣の行が滑って余白を作ってから現れる。
 *     見えていない範囲の変化は無音で同期し、件数の表記だけを更新する
 */

let toastTimer = null;

/** 右下の通知。ms=0 なら消えない。 */
function showToast(text, { iconName = 'refresh', warn = false, ms = 3200 } = {}) {
  clearTimeout(toastTimer);
  el.toast.className = 'toast' + (warn ? ' is-warn' : '');
  el.toast.innerHTML = `${icon(iconName, 14)}<span>${escapeHtml(text)}</span>`;
  el.toast.hidden = false;
  if (ms) toastTimer = setTimeout(() => (el.toast.hidden = true), ms);
}

const refreshStats = debounce(() => loadStats().catch(() => {}), 1200);

/* --------------------------------- 更新ドット（未読の更新を知らせる青い丸） */

/** 更新があってまだ読まれていない会話の relPath。itemHtml が行の右端にドットを描く */
const updatedDots = new Set();

function listItemOf(relPath) {
  return [...el.list.children].find((li) => li.dataset.id === relPath) || null;
}

/**
 * ドットを消す。会話を開いたとき、また既に開いている会話なら
 * プレビューをスクロールしたとき（＝読んだとき）に呼ばれる。
 */
function clearUpdatedDot(relPath) {
  if (!updatedDots.delete(relPath)) return;
  const li = listItemOf(relPath);
  const dot = li?.querySelector('.ri-dot');
  if (dot) {
    dot.classList.add('is-clearing');
    setTimeout(() => dot.remove(), 400);
    // ドット無しの HTML を署名に置き直し、次の差分反映で行ごと書き換わらないようにする
    const item = state.items.find((it) => it.relPath === relPath);
    if (item) liHtmlCache.set(li, itemHtml(item));
  }
}

// 開いている会話のドットは、プレビューのスクロールで「読んだ」とみなして消す
el.reader.addEventListener(
  'scroll',
  () => {
    if (state.activeId && updatedDots.has(state.activeId)) clearUpdatedDot(state.activeId);
  },
  { passive: true }
);

/* ------------------------------------------ 一覧の差分反映（再描画しない） */

/** 差分で追いかける読み込み済み範囲の上限。超えたら件数の表記だけを更新する */
const DIFF_WINDOW_MAX = 300;
/** 1 回の反映でアニメーションを付ける新規行の上限。大量更新は音もなく揃える */
const ANIMATE_MAX = 20;

let listRefreshTimer = null;
/** fetchPage 実行中に更新が届いたときの覚え書き（終わってから差分を取り直す） */
let listRefreshQueued = false;

/** 連続イベントを少し束ねてから一覧の差分を取り直す */
function scheduleListRefresh() {
  clearTimeout(listRefreshTimer);
  listRefreshTimer = setTimeout(() => {
    listRefreshTimer = null;
    runListRefresh().catch((err) => console.error(err));
  }, 250);
}

/** 読み込み済みの範囲を先頭から取り直す（API の limit 上限 100 を跨いでページを繋ぐ） */
async function fetchListWindow(count) {
  const want = Math.min(Math.max(count, state.limit), DIFF_WINDOW_MAX);
  const items = [];
  let total = 0;
  let terms = [];
  let took = 0;
  while (items.length < want) {
    const limit = Math.min(100, want - items.length);
    const data = await fetch('/api/conversations?' + buildQuery(items.length, limit)).then((r) => r.json());
    total = data.total;
    terms = data.terms;
    took += data.took;
    items.push(...data.items);
    if (items.length >= total || data.items.length < limit) break;
  }
  return { items, total, terms, took };
}

async function runListRefresh() {
  if (state.loading) {
    listRefreshQueued = true; // fetchPage の finally が取り直す
    return;
  }
  const seq = state.seq;

  // 大量に読み込んでいるときは並びの同期を見送り、件数の表記だけを最新にする
  if (state.items.length > DIFF_WINDOW_MAX) {
    const data = await fetch('/api/conversations?' + buildQuery(0, 1)).then((r) => r.json());
    if (seq !== state.seq || state.loading) return;
    state.total = data.total;
    renderResultCount(data.took);
    renderMore();
    return;
  }

  const data = await fetchListWindow(state.items.length);
  if (seq !== state.seq || state.loading) return; // 取得中にユーザー操作で読み直された
  applyListDiff(data);
}

/**
 * 一覧を再描画せずに、新しい検索結果との差分だけを DOM へ反映する。
 *
 *   - 既存の行は DOM ノードを作り直さず、内容が変わった行だけ書き換える
 *   - 並びが変わった行は FLIP（transform）で新しい位置へ滑らせる。行の挿入では
 *     下の行が滑って余白が開き、その中へ新しい行がふわっと現れる
 *   - 画面に見えていない範囲の増減はスクロール位置を補正して無音で同期し、
 *     見た目は一切動かさない（件数の表記だけが変わる）
 */
function applyListDiff({ items: fresh, total, terms, took }) {
  state.total = total;
  state.terms = terms;

  const listEl = el.list;
  const prev = [...listEl.children];
  const byId = new Map(prev.map((li) => [li.dataset.id, li]));

  // First: 移動アニメーションのために現在位置を覚えておく
  const scrollTop = listEl.scrollTop;
  const viewH = listEl.clientHeight;
  const oldTop = new Map();
  for (const li of prev) oldTop.set(li, li.offsetTop);
  // スクロール補正の基準行 = いま画面に掛かっている最初の行
  const anchor = prev.find((li) => li.offsetTop + li.offsetHeight > scrollTop) || null;

  // DOM を新しい並びへ揃える（既存ノードは移動、新規は生成、消えた行は取り除く）
  const entering = new Set();
  let ref = listEl.firstElementChild;
  for (const item of fresh) {
    let li = byId.get(item.relPath);
    if (li) {
      byId.delete(item.relPath);
      patchItem(li, item);
    } else {
      li = buildItem(item);
      entering.add(li);
    }
    if (li === ref) ref = ref.nextElementSibling;
    else listEl.insertBefore(li, ref);
  }
  for (const li of byId.values()) li.remove(); // 結果から消えた行

  state.items = fresh;
  state.offset = fresh.length;
  // キーボードカーソルは行に付いたまま動くので、位置だけ数え直す
  const cursorLi = listEl.querySelector('.result-item.cursor');
  state.cursor = cursorLi ? [...listEl.children].indexOf(cursorLi) : -1;

  // 画面より上での増減ぶんスクロールを送り、見えている行を絶対に動かさない
  // （上端で見ているときは補正せず、新しい行がアニメーションで入ってくる）
  let scrollAdj = 0;
  if (anchor && anchor.isConnected && scrollTop > 4) {
    const want = scrollTop + (anchor.offsetTop - oldTop.get(anchor));
    if (want !== scrollTop) {
      listEl.scrollTop = want;
      scrollAdj = listEl.scrollTop - scrollTop; // 端で clamp された実際の移動量
    }
  }

  // Invert & Play: 画面の近くで位置が変わった行だけを、古い位置から新しい位置へ滑らせる
  const animate = !document.hidden && entering.size <= ANIMATE_MAX;
  const nearTop = listEl.scrollTop - viewH;
  const nearBottom = listEl.scrollTop + viewH * 2;
  const moving = [];
  if (animate) {
    for (const li of listEl.children) {
      const top = li.offsetTop;
      if (top < nearTop || top > nearBottom) continue; // 画面から遠い行は瞬時に揃える
      if (entering.has(li)) {
        li.classList.add('ri-enter');
        continue;
      }
      const from = oldTop.get(li);
      if (from == null) continue;
      const delta = from - top + scrollAdj; // 補正後の見た目上の移動量
      if (Math.abs(delta) < 1) continue;
      li.style.transform = `translateY(${delta}px)`;
      moving.push(li);
    }
  }
  if (moving.length) {
    void listEl.offsetHeight; // 開始位置の transform を確定させてから遷移する
    requestAnimationFrame(() => {
      for (const li of moving) {
        li.classList.add('ri-flip');
        li.style.transform = '';
      }
    });
  }
  if (moving.length || entering.size) {
    setTimeout(() => {
      for (const li of moving) li.classList.remove('ri-flip');
      for (const li of entering) li.classList.remove('ri-enter');
    }, 500);
  }

  renderResultCount(took);
  renderMore();
  if (isSearchOpen()) renderSearchList();
  autoLoadIfShort();
}

/* ------------------------------------------------------- SSE イベント処理 */

function onIndexChanged(detail) {
  const changes = detail.changes || [];

  // 開いている会話のプレビューには触らない。ファイルごと消えたときだけ知らせる
  const mine = state.activeId ? changes.find((c) => c.relPath === state.activeId) : null;
  if (mine && mine.kind === 'removed') {
    showToast('この会話のファイルは削除されました', { iconName: 'trash', warn: true, ms: 0 });
  }

  // 追加・更新された会話に青いドットを付ける（開くと消える）。設定でオフなら付けない
  if (showUpdateDots) {
    for (const c of changes) {
      if (c.kind !== 'removed') updatedDots.add(c.relPath);
    }
  }

  refreshStats(); // ソース内訳・サーバー概要の件数
  scheduleListRefresh(); // 一覧は再描画せず差分だけを反映する
}

function startLiveUpdates() {
  if (!window.EventSource) return;
  const events = new EventSource('/api/events');
  let connected = false;

  events.addEventListener('hello', () => {
    // 2 回目以降は再接続。切れている間の変更があるかもしれないので差分を取り直す
    if (connected) {
      refreshStats();
      scheduleListRefresh();
    }
    connected = true;
  });

  events.addEventListener('index', (ev) => {
    try {
      onIndexChanged(JSON.parse(ev.data));
    } catch (err) {
      console.error(err);
    }
  });

  // 切断時は EventSource が自動で再接続する（retry はサーバが指定）
}

/* ---------------------------------------------------------------- start */

const initial = readHash();
state.q = initial.q;
el.q.value = initial.q;
updateSearchButton();

loadStats()
  .then(reload)
  .then(() => {
    if (initial.id) openConversation(initial.id, initial.turn);
    startLiveUpdates();
  });
