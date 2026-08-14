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
    return (
      baseLinkOpen(tokens, idx, options, env, self) +
      `${origin ? chipIcoHtml(origin) : ''}<span class="chip-label">`
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

/**
 * ChatGPT（Native）の思考アクティビティを「◯m ◯s考えました」の折りたたみにする。
 * 展開には前置きテキストと「N件のウェブサイトを検索しました」の行（1 つ目のサイトの
 * favicon 付き。クリックでアクティビティパネルが開く）を出す。
 * ウェブ検索の無い会話は、思考の要約と本文をそのまま展開に出す。
 */
function reasoningBlock(turn) {
  const r = turn.reasoning;
  const label = r.recap || (r.durationSec ? `${fmtThinkDuration(r.durationSec)}考えました` : '思考プロセス');

  let body = r.preamble ? md.render(r.preamble) : '';
  const rows = r.webSearches
    .map(
      (w) =>
        `<button type="button" class="reasoning-web" data-turn="${turn.index}" title="アクティビティを表示">` +
        `${favIcoHtml(w.domain)}<span>${escapeHtml(w.label)}</span></button>`
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
  if (!body) return r.recap ? `<div class="reasoning-plain">${escapeHtml(r.recap)}</div>` : '';

  return (
    `<details class="block reasoning"><summary><span>${escapeHtml(label)}</span></summary>` +
    `<div class="block-body md">${body}</div></details>`
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
 * ChatGPT（Native）の <antNavList>（turn.navLists への参照）を記事カードへ
 * 変換しつつ Markdown を描画する。
 */
function renderRich(text, turn) {
  if (!text) return '';
  // link_open レンダラーが引用チップ（#cite-N）の解決に turn.citeLists を使う
  const env = { turn };
  const re =
    /<antArtifact\b([^>]*)>([\s\S]*?)<\/antArtifact>|<antThinking>([\s\S]*?)<\/antThinking>|<antNavList index="(\d+)"><\/antNavList>/g;
  let html = '';
  let last = 0;
  let m;

  while ((m = re.exec(text)) !== null) {
    const before = text.slice(last, m.index);
    if (before.trim()) html += md.render(before, env);
    last = m.index + m[0].length;

    if (m[4] !== undefined) {
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
  updatePill: $('#update-pill'), toast: $('#toast'),
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
  document.documentElement.dataset.theme =
    setting === 'system' ? (systemDarkMq.matches ? 'dark' : 'light') : setting;
}

function setThemeSetting(value) {
  if (value === 'system') localStorage.removeItem(THEME_KEY);
  else localStorage.setItem(THEME_KEY, value);
  applyTheme();
}

applyTheme();
systemDarkMq.addEventListener('change', applyTheme);

// 一覧ペインの開閉。広い画面は端に折りたたむ（状態を記憶）。
// 狭い画面は一覧⇄本文の切り替えなので、本文から一覧へ戻るボタンとして働く。
const narrowMq = window.matchMedia('(max-width: 900px)');
if (localStorage.getItem('chv-results') === 'collapsed') document.body.classList.add('results-collapsed');
$('#btn-menu').addEventListener('click', () => {
  if (narrowMq.matches) {
    document.body.classList.remove('reading');
    return;
  }
  const collapsed = document.body.classList.toggle('results-collapsed');
  if (collapsed) localStorage.setItem('chv-results', 'collapsed');
  else localStorage.removeItem('chv-results');
});

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

function buildQuery(offset) {
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
  p.set('limit', String(state.limit));
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

/**
 * 一覧を読み込む。
 * @param {boolean} reset 先頭から読み直すか
 * @param {{quiet?: boolean}} options quiet=true なら「検索中…」を出さずに差し替える（監視による自動更新用）
 */
async function fetchPage(reset, { quiet = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  state.loadingMore = !reset;
  const seq = ++state.seq;

  if (reset && !quiet) {
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

    el.count.textContent = state.total
      ? `${fmtInt(state.total)} 件${state.q ? ' が一致' : ''}`
      : state.q
      ? '一致する会話はありません'
      : '会話がありません';
    el.took.textContent = `${data.took} ms`;
    if (isSearchOpen()) renderSearchList();
    ok = true;
  } catch (err) {
    el.count.textContent = '読み込みに失敗しました';
    console.error(err);
  } finally {
    state.loading = false;
    state.loadingMore = false;
    renderMore();
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

function renderItems(items) {
  const frag = document.createDocumentFragment();
  for (const item of items) {
    const meta = sourceMetaOf(item.source);
    const li = document.createElement('li');
    li.className = 'result-item' + (item.relPath === state.activeId ? ' active' : '');
    li.dataset.id = item.relPath;
    li.dataset.source = item.source; // styles/providers/*.css から行の見た目を差し替えられる

    const snippets = (item.snippets || [])
      .map(
        (s) =>
          `<div class="ri-snippet" data-turn="${s.turnIndex}">` +
          `<span class="who">${s.role === 'user' ? '自分' : s.role === 'title' ? 'タイトル' : 'AI'}</span>` +
          `${highlightText(s.text, state.terms)}</div>`
      )
      .join('');

    li.innerHTML = `
      <div class="ri-head">
        ${sourceLogo(item.source, meta)}
        <span class="ri-title">${highlightText(item.title, state.terms)}</span>
        ${state.terms.length ? `<span class="ri-score" title="検索スコア">${fmtInt(item.score || 0)}</span>` : ''}
        ${item.favorite ? `<span class="ri-star" title="お気に入り">${icon('star-filled', 13)}</span>` : ''}
      </div>
      <div class="ri-meta">
        <span>${fmtDate(itemTime(item))}</span>
        <span>${fmtInt(item.turnCount)} 発言</span>
      </div>
      ${snippets || `<div class="ri-preview">${highlightText(item.preview, state.terms)}</div>`}`;

    frag.appendChild(li);
  }
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
  { key: 'maxWidth', label: '本文の最大幅', cssVar: '--chat-max-width', min: 640, max: 1400, step: 20, unit: 'px' },
  { key: 'bubbleWidth', label: '自分の吹き出し幅', cssVar: '--user-bubble-max-width', min: 40, max: 100, step: 2, unit: '%' },
];

/** チェックボックスの項目（一覧の行の表示。既定はコンパクト＝非表示） */
const UI_TOGGLES = [
  { key: 'showMeta', label: '一覧に日付・発言数を表示', selector: '.ri-meta', display: 'flex' },
  { key: 'showPreview', label: '一覧にプレビューを表示', selector: '.ri-preview', display: '-webkit-box' },
];

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
    for (const t of UI_TOGGLES) {
      if (conf[t.key]) css.push(`.result-item[data-source="${source}"] ${t.selector}{display:${t.display}}`);
    }
  }
  uiStyle.textContent = css.join('\n');
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

applyUiSettings();

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

const THEME_OPTIONS = [
  { value: 'system', label: 'システム' },
  { value: 'dark', label: 'ダーク' },
  { value: 'light', label: 'ライト' },
];

const TIME_BASIS_OPTIONS = [
  { value: 'last', label: '最後のメッセージの時刻' },
  { value: 'start', label: 'チャットを開始した時刻' },
];

/** 「一般」ペイン。テーマとチャットの日時の基準（プロバイダーに依らない設定）。 */
function renderGeneralPane() {
  el.settingsPane.innerHTML = `
    <div class="settings-section-label">外観</div>
    <div class="setting-row">
      <label>テーマ</label>
      ${selectMenuHtml('theme-select', 'テーマ', THEME_OPTIONS, themeSetting())}
    </div>
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

/** 「サーバー概要」ペイン。索引の統計・監視状態と再構築ボタン（旧サイドバーの統計）。 */
function renderStatsPane() {
  if (!serverStats) {
    el.settingsPane.innerHTML = '<p class="settings-note">統計を読み込み中…</p>';
    return;
  }
  const s = serverStats;
  el.settingsPane.innerHTML = `
    <div class="settings-section-label">サーバー概要</div>
    <div class="server-stats">
      <div>会話 <b>${fmtInt(s.conversations)}</b> 件 / 発言 <b>${fmtInt(s.totalTurns)}</b> 件</div>
      <div>本文 <b>${fmtInt(Math.round(s.totalChars / 10000))}</b> 万文字（索引 ${(s.indexBytes / 1048576).toFixed(0)} MB）</div>
      <div>${fmtDate(s.earliest)} 〜 ${fmtDate(s.latest)}</div>
      <div class="root">${escapeHtml(s.root)}</div>
      ${watchStateHtml(s.watcher)}
    </div>
    <button class="btn-block" id="btn-reindex">索引を再構築</button>`;

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

  const toggles = UI_TOGGLES.map(
    (t) => `<label class="check"><input type="checkbox" data-key="${t.key}"${conf[t.key] ? ' checked' : ''}> ${t.label}</label>`
  ).join('');

  el.settingsPane.innerHTML = `
    <div class="settings-section-label">チャット表示</div>
    ${sliders}
    <div class="settings-section-label">一覧の行</div>
    ${toggles}
    <button class="btn-block" id="settings-reset">${icon('arrow-back-up', 14)}このプロバイダーを既定に戻す</button>
    <p class="settings-note">設定はこのブラウザに保存され、すぐに反映されます。会話を開いたまま調整できます。</p>`;

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

  for (const input of el.settingsPane.querySelectorAll('.check input')) {
    input.addEventListener('change', () => {
      if (input.checked) (uiSettings[source] ??= {})[input.dataset.key] = true;
      else if (uiSettings[source]) delete uiSettings[source][input.dataset.key];
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

/**
 * 会話を開く。
 * @param {string} relPath
 * @param {number|null} focusTurn スクロールして光らせる発言
 * @param {{keepScroll?: boolean}} options keepScroll=true なら読書位置を保つ（監視による再読み込み用）
 */
async function openConversation(relPath, focusTurn, { keepScroll = false } = {}) {
  // アクティビティは開いていた会話のものなので、別の会話へ移るときに閉じる
  if (relPath !== state.activeId) closeActivity();
  state.activeId = relPath;
  el.list.querySelectorAll('.result-item').forEach((li) => li.classList.toggle('active', li.dataset.id === relPath));
  document.body.classList.add('reading');
  writeHash();

  const scrollTop = el.reader.scrollTop;
  await cmHighlightReady;
  const conv = await fetch('/api/conversation?id=' + encodeURIComponent(relPath)).then((r) => r.json());
  if (conv.error) {
    if (keepScroll) showToast('この会話は索引から消えました', { iconName: 'trash', warn: true, ms: 0 });
    return;
  }
  activeConv = conv;
  closeCitePop();

  const links = [];
  if (conv.url)
    links.push(
      `<a href="${escapeHtml(conv.url)}" target="_blank" rel="noopener">元のチャットを開く${icon('external-link', 13)}</a>`
    );
  links.push(`<a href="obsidian://open?path=${encodeURIComponent(conv.absPath)}">Obsidian で開く</a>`);
  links.push(`<a href="/api/raw?id=${encodeURIComponent(relPath)}" target="_blank" rel="noopener">Markdown 原文</a>`);

  const turnsHtml = conv.turns
    .map((turn) => {
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
          attachmentsHtml = `<div class="turn-attachments md">${md.render(images.join('\n\n'))}</div>`;
          bodyText = rest;
        }
      }
      // Native 描画の思考アクティビティ（「◯m ◯s考えました」）は本文の上に置く
      const reasoningHtml = turn.role === 'assistant' && turn.reasoning ? reasoningBlock(turn) : '';
      const bubbleHtml =
        bodyText.trim() || extras || reasoningHtml
          ? `<div class="bubble md">${reasoningHtml}${renderRich(bodyText, turn)}${extras}</div>`
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
          </div>
        </div>`;
    })
    .join('');

  // プロバイダーごとの描画スタイル（styles/providers/*.css）の切り替えスイッチ
  el.conversation.dataset.source = conv.source || 'unknown';

  el.conversation.innerHTML = `
    <div class="conv-head">
      <h1 class="conv-title">${escapeHtml(conv.title)}</h1>
      <div class="conv-meta">
        <span class="badge" style="color:${escapeHtml(conv.sourceMeta.color)}">${escapeHtml(conv.sourceMeta.label)}</span>
        ${conv.native ? `<span class="badge badge-native" title=".raw.json の会話ツリーから描画しています">Native</span>` : ''}
        <span>${fmtDate(itemTime(conv), true)}</span>
        <span>${fmtInt(conv.turns.length)} 発言 / ${fmtInt(conv.chars)} 文字</span>
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
  el.reader.scrollTop = keepScroll ? scrollTop : 0;

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

  el.conversation.querySelectorAll('.turn-actions .act').forEach((btn) =>
    btn.addEventListener('click', () => runTurnAction(btn, conv))
  );

  // 「N件のウェブサイトを検索しました」→ アクティビティを別パネルで開く
  el.conversation.querySelectorAll('.reasoning-web').forEach((btn) =>
    btn.addEventListener('click', () => {
      const turn = conv.turns[Number(btn.dataset.turn)];
      if (turn?.reasoning) openActivity(turn.reasoning);
    })
  );

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
}

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

function closeReader() {
  document.body.classList.remove('reading');
  if (window.innerWidth > 900) return;
  el.conversation.hidden = true;
  el.readerEmpty.hidden = false;
}

/* ------------------------------------------- 思考アクティビティ（別パネル） */

/** アクティビティのサイトチップはここまで表示し、残りは「あと N 個」にまとめる。 */
const ACTIVITY_CHIP_MAX = 3;

const activityPanel = $('#activity-panel');

function isActivityOpen() {
  return !activityPanel.hidden;
}

function closeActivity() {
  activityPanel.hidden = true;
}

/** 本家のアクティビティパネル相当。思考の時系列と情報源の一覧を出す。 */
function openActivity(r) {
  const dur = fmtThinkDuration(r.durationSec);
  $('#activity-title').innerHTML =
    'アクティビティ' + (dur ? `<span class="activity-duration"> · ${escapeHtml(dur)}</span>` : '');
  $('#activity-body').innerHTML = activityHtml(r);
  activityPanel.hidden = false;
  $('#activity-body').scrollTop = 0;
}

const dtSource = new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });

function activityHtml(r) {
  let html = '<div class="activity-section">思考中</div>';

  for (const item of r.activity) {
    if (item.kind === 'search') {
      const chip = (d, cls = '') => `<span class="activity-chip${cls}">${favIcoHtml(d)}<span>${escapeHtml(d)}</span></span>`;
      let chips = item.domains.slice(0, ACTIVITY_CHIP_MAX).map((d) => chip(d)).join('');
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

  if (r.sources?.length) {
    html += `<div class="activity-section">情報源 · ${fmtInt(r.sources.length)}</div>`;
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
  citePop.innerHTML = `${nav}
    <a class="cite-pop-item" href="${escapeHtml(p.url)}" target="_blank" rel="noopener">
      <span class="cite-pop-site">${favIcoHtml(domain)}<span>${escapeHtml(p.attribution || domain)}</span></span>
      ${p.title ? `<span class="cite-pop-title">${escapeHtml(p.title)}</span>` : ''}
      ${snippet ? `<span class="cite-pop-snippet">${escapeHtml(snippet)}</span>` : ''}
    </a>`;
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
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(ev.target.tagName);

  if (ev.key === 'Escape') {
    if (isSearchOpen()) closeSearch();
    else if (isSettingsOpen()) closeSettings();
    else if (isActivityOpen()) closeActivity();
    else if (typing) ev.target.blur();
    else closeReader();
    return;
  }
  if (isSettingsOpen()) return; // 設定を開いているあいだは他のショートカットを止める

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
 * /api/events（SSE）で知らせてくる。ここではそれを画面へ映す。
 *
 *   - 開いている会話が変わった  … 読書位置を保ったまま読み直す
 *   - 一覧が先頭・上端にある     … そのまま差し替える
 *   - それ以外                   … 「N 件の更新」を出し、押されたら読み直す
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

let pendingUpdates = 0;

function showUpdatePill(count) {
  pendingUpdates += count;
  el.updatePill.innerHTML = icon('refresh', 12) + (pendingUpdates ? `${fmtInt(pendingUpdates)} 件の更新` : '更新があります');
  el.updatePill.hidden = false;
}

function hideUpdatePill() {
  pendingUpdates = 0;
  el.updatePill.hidden = true;
}

/** 一覧をその場で差し替えてよいか（先頭ページを上端で見ているときだけ）。 */
function canAutoRefreshList() {
  return !state.loading && !isSearchOpen() && state.offset <= state.limit && el.list.scrollTop < 40;
}

const refreshStats = debounce(() => loadStats().catch(() => {}), 1200);

async function onIndexChanged(detail) {
  const changes = detail.changes || [];
  const mine = state.activeId ? changes.find((c) => c.relPath === state.activeId) : null;

  if (mine && mine.kind === 'removed') {
    showToast('この会話のファイルは削除されました', { iconName: 'trash', warn: true, ms: 0 });
  } else if (state.activeId && (mine || detail.truncated)) {
    // truncated（全再構築など）のときは、開いている会話も変わったとみなして読み直す
    await openConversation(state.activeId, null, { keepScroll: true });
    if (mine) showToast('開いている会話を更新しました');
  }

  refreshStats();

  if (canAutoRefreshList()) {
    hideUpdatePill();
    await fetchPage(true, { quiet: true });
  } else {
    showUpdatePill(detail.added + detail.updated + detail.removed);
  }
}

el.updatePill.addEventListener('click', () => {
  hideUpdatePill();
  el.list.scrollTop = 0; // 新しいものを見るための操作なので先頭へ戻す
  reload();
});

function startLiveUpdates() {
  if (!window.EventSource) return;
  const events = new EventSource('/api/events');
  let connected = false;

  events.addEventListener('hello', () => {
    // 2 回目以降は再接続。切れている間の変更があるかもしれないので確認する
    if (connected) {
      refreshStats();
      if (canAutoRefreshList()) fetchPage(true, { quiet: true });
      else showUpdatePill(0);
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
