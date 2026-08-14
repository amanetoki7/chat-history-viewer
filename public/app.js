/* global markdownit, hljs */
'use strict';

/* ------------------------------------------------------------- markdown */

const md = window.markdownit({
  html: false,
  linkify: true,
  breaks: true,
  highlight(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      } catch { /* fall through */ }
    }
    return '';
  },
});

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

/**
 * Claude の <antArtifact> / <antThinking> を折りたたみブロックに変換しつつ Markdown を描画する。
 */
function renderRich(text) {
  if (!text) return '';
  const re = /<antArtifact\b([^>]*)>([\s\S]*?)<\/antArtifact>|<antThinking>([\s\S]*?)<\/antThinking>/g;
  let html = '';
  let last = 0;
  let m;

  while ((m = re.exec(text)) !== null) {
    const before = text.slice(last, m.index);
    if (before.trim()) html += md.render(before);
    last = m.index + m[0].length;

    if (m[3] !== undefined) {
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
  if (rest.trim()) html += md.render(rest);
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
  q: $('#q'), scope: $('#scope'), sort: $('#sort'),
  from: $('#from'), to: $('#to'), favorite: $('#favorite'), archived: $('#archived'),
  sources: $('#sources'), stats: $('#stats'),
  list: $('#result-list'), count: $('#result-count'), took: $('#result-took'), more: $('#result-more'),
  updatePill: $('#update-pill'), toast: $('#toast'),
  reader: $('#reader'), conversation: $('#conversation'), readerEmpty: $('#reader-empty'),
  hint: $('#search-hint'),
  btnSearch: $('#btn-search'), modal: $('#search-modal'),
  searchList: $('#search-list'), searchLabel: $('#search-label'),
};

/* ----------------------------------------------------------------- boot */

/** テーマを適用する。コードハイライトの配色も合わせて差し替える。 */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('#hljs-dark').disabled = theme !== 'dark';
  $('#hljs-light').disabled = theme === 'dark';
  paintThemeIcon(theme);
}

// 明示的に選ばれていなければ OS の設定に従う
const preferredTheme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
applyTheme(localStorage.getItem('chv-theme') || preferredTheme);

$('#btn-theme').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  localStorage.setItem('chv-theme', next);
});

$('#btn-menu').addEventListener('click', () => document.body.classList.toggle('menu-open'));
$('#scrim').addEventListener('click', () => document.body.classList.remove('menu-open'));

// サイドバーの折りたたみ状態を記憶する（閉じたパネルだけ保存）
for (const panel of document.querySelectorAll('details.panel[data-panel]')) {
  const key = `chv-panel-${panel.dataset.panel}`;
  if (localStorage.getItem(key) === 'closed') panel.open = false;
  panel.addEventListener('toggle', () => {
    if (panel.open) localStorage.removeItem(key);
    else localStorage.setItem(key, 'closed');
  });
}

/** ファイル監視の状態表示（緑=監視中 / 灰=オフ / 赤=停止中） */
function watchStateHtml(watcher) {
  if (!watcher) return '';
  if (!watcher.enabled) return '<div class="watch-state is-off"><span class="watch-dot"></span>監視オフ</div>';
  if (!watcher.watching)
    return '<div class="watch-state is-error"><span class="watch-dot"></span>監視が停止中（再開を試みています）</div>';
  const at = watcher.lastAppliedAt ? `（最終更新 ${fmtDate(watcher.lastAppliedAt, true)}）` : '';
  return `<div class="watch-state"><span class="watch-dot"></span>変更を監視中${at}</div>`;
}

async function loadStats() {
  const stats = await fetch('/api/stats').then((r) => r.json());
  state.allSources = stats.sources;

  // 監視による更新で描き直されるので、選択中のソースは state から復元する
  el.sources.innerHTML = stats.sources
    .map(
      (s) => `<label class="source-item">
        <input type="checkbox" value="${escapeHtml(s.id)}"${state.sources.has(s.id) ? ' checked' : ''}>
        ${sourceLogo(s.id, s, false)}
        <span class="source-name">${escapeHtml(s.label)}</span>
        <span class="source-count">${fmtInt(s.count)}</span>
      </label>`
    )
    .join('');

  el.sources.querySelectorAll('input').forEach((input) =>
    input.addEventListener('change', () => {
      if (input.checked) state.sources.add(input.value);
      else state.sources.delete(input.value);
      reload();
    })
  );

  el.stats.innerHTML = `
    <div>会話 <b>${fmtInt(stats.conversations)}</b> 件 / 発言 <b>${fmtInt(stats.totalTurns)}</b> 件</div>
    <div>本文 <b>${fmtInt(Math.round(stats.totalChars / 10000))}</b> 万文字（索引 ${(stats.indexBytes / 1048576).toFixed(0)} MB）</div>
    <div>${fmtDate(stats.earliest)} 〜 ${fmtDate(stats.latest)}</div>
    <div class="root">${escapeHtml(stats.root)}</div>
    ${watchStateHtml(stats.watcher)}
    <button class="btn-block" id="btn-reindex">索引を再構築</button>`;

  $('#btn-reindex').addEventListener('click', async (ev) => {
    ev.target.disabled = true;
    ev.target.textContent = '再構築中…（コンソール参照）';
    await fetch('/api/reindex', { method: 'POST' });
    setTimeout(() => location.reload(), 4000);
  });
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
        ${item.favorite ? `<span class="ri-star" title="お気に入り">${icon('star-filled', 13)}</span>` : ''}
      </div>
      <div class="ri-meta">
        <span>${fmtDate(item.chatTime)}</span>
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
        <span class="sr-date">${fmtDate(item.chatTime)}</span>
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

/* ---------------------------------------------------------------- reader */

let hitMarks = [];
let hitIndex = -1;

/**
 * 会話を開く。
 * @param {string} relPath
 * @param {number|null} focusTurn スクロールして光らせる発言
 * @param {{keepScroll?: boolean}} options keepScroll=true なら読書位置を保つ（監視による再読み込み用）
 */
async function openConversation(relPath, focusTurn, { keepScroll = false } = {}) {
  state.activeId = relPath;
  el.list.querySelectorAll('.result-item').forEach((li) => li.classList.toggle('active', li.dataset.id === relPath));
  document.body.classList.add('reading');
  writeHash();

  const scrollTop = el.reader.scrollTop;
  const conv = await fetch('/api/conversation?id=' + encodeURIComponent(relPath)).then((r) => r.json());
  if (conv.error) {
    if (keepScroll) showToast('この会話は索引から消えました', { iconName: 'trash', warn: true, ms: 0 });
    return;
  }

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
      const bubbleHtml =
        bodyText.trim() || extras ? `<div class="bubble md">${renderRich(bodyText)}${extras}</div>` : '';

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
        <span>${fmtDate(conv.chatTime, true)}</span>
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

/* --------------------------------------------------------------- inputs */

el.q.addEventListener('input', debounce(() => {
  state.q = el.q.value.trim();
  el.hint.textContent = state.q ? '' : '';
  updateSearchButton();
  reload();
}, 220));

el.scope.addEventListener('change', () => { state.scope = el.scope.value; reload(); });
el.sort.addEventListener('change', () => { state.sort = el.sort.value; reload(); });
el.from.addEventListener('change', () => { state.from = el.from.value; reload(); });
el.to.addEventListener('change', () => { state.to = el.to.value; reload(); });
el.favorite.addEventListener('change', () => { state.favorite = el.favorite.checked; reload(); });
el.archived.addEventListener('change', () => { state.archived = el.archived.checked; reload(); });

$('#quick-dates').addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-days]');
  if (!btn) return;
  const days = Number(btn.dataset.days);
  if (!days) {
    state.from = state.to = '';
  } else {
    const since = new Date(Date.now() - days * 86400000);
    state.from = since.toISOString().slice(0, 10);
    state.to = '';
  }
  el.from.value = state.from;
  el.to.value = state.to;
  reload();
});

$('#btn-reset').addEventListener('click', () => {
  state.q = ''; state.sources.clear(); state.from = ''; state.to = '';
  state.favorite = false; state.archived = true; state.scope = 'all'; state.sort = 'relevance';
  el.q.value = ''; el.from.value = ''; el.to.value = '';
  el.favorite.checked = false; el.archived.checked = true;
  el.scope.value = 'all'; el.sort.value = 'relevance';
  el.sources.querySelectorAll('input').forEach((i) => (i.checked = false));
  updateSearchButton();
  reload();
});

document.addEventListener('keydown', (ev) => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(ev.target.tagName);

  if ((ev.key === '/' && !typing) || ((ev.ctrlKey || ev.metaKey) && ev.key === 'k')) {
    ev.preventDefault();
    openSearch();
    return;
  }
  if (ev.key === 'Escape') {
    if (isSearchOpen()) closeSearch();
    else if (typing) ev.target.blur();
    else closeReader();
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
