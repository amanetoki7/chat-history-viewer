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

const detailsBlock = (cls, summary, innerHtml, open) =>
  `<details class="block ${cls}"${open ? ' open' : ''}><summary>${escapeHtml(summary)}</summary>` +
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
      html += detailsBlock('thinking', '💭 思考プロセス', md.render(m[3].trim()), false);
    } else {
      const attrs = m[1] || '';
      const title = attrOf(attrs, 'title') || attrOf(attrs, 'identifier') || 'Artifact';
      const type = attrOf(attrs, 'type');
      const lang = ARTIFACT_LANG[type] ?? '';
      const body = '```' + lang + '\n' + m[2].replace(/^\n+|\n+$/g, '') + '\n```';
      html += detailsBlock('artifact', `📦 ${title}`, md.render(body), true);
    }
  }
  const rest = text.slice(last);
  if (rest.trim()) html += md.render(rest);
  return html;
}

/* ---------------------------------------------------------------- icons */

/* Tabler Icons (outline) の path をそのまま埋め込む */
const ICONS = {
  copy:
    '<path d="M7 7m0 2.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667z"/>' +
    '<path d="M4.012 16.737a2.005 2.005 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1"/>',
  share: '<path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"/><path d="M7 9l5 -5l5 5"/><path d="M12 4l0 12"/>',
  pencil: '<path d="M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4"/><path d="M13.5 6.5l4 4"/>',
  check: '<path d="M5 12l5 5l10 -10"/>',
};

const icon = (name) =>
  `<svg class="ti" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
  `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

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
  seq: 0,
};

const el = {
  q: $('#q'), scope: $('#scope'), sort: $('#sort'),
  from: $('#from'), to: $('#to'), favorite: $('#favorite'), archived: $('#archived'),
  sources: $('#sources'), stats: $('#stats'),
  list: $('#result-list'), count: $('#result-count'), took: $('#result-took'), more: $('#result-more'),
  reader: $('#reader'), conversation: $('#conversation'), readerEmpty: $('#reader-empty'),
  hint: $('#search-hint'),
};

/* ----------------------------------------------------------------- boot */

/** テーマを適用する。コードハイライトの配色も合わせて差し替える。 */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('#hljs-dark').disabled = theme !== 'dark';
  $('#hljs-light').disabled = theme === 'dark';
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

async function loadStats() {
  const stats = await fetch('/api/stats').then((r) => r.json());
  state.allSources = stats.sources;

  el.sources.innerHTML = stats.sources
    .map(
      (s) => `<label class="source-item">
        <input type="checkbox" value="${escapeHtml(s.id)}">
        <span class="dot" style="background:${escapeHtml(s.color)}"></span>
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

async function fetchPage(reset) {
  if (state.loading) return;
  state.loading = true;
  const seq = ++state.seq;

  if (reset) {
    el.count.textContent = '検索中…';
    el.took.textContent = '';
  }

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
    renderMore();
  } catch (err) {
    el.count.textContent = '読み込みに失敗しました';
    console.error(err);
  } finally {
    state.loading = false;
  }
}

function sourceMetaOf(id) {
  return state.allSources.find((s) => s.id === id) || { label: id, color: '#8a8f98' };
}

/** ロゴ画像を持つソース（画像は CSS 側で theme に応じて出し分け） */
const LOGO_SOURCES = new Set(['chatgpt', 'claude', 'gemini', 'perplexity']);

function sourceLogo(id, meta) {
  const hasLogo = LOGO_SOURCES.has(id);
  const style = hasLogo ? '' : ` style="background-color:${escapeHtml(meta.color)}"`;
  return `<span class="ri-logo${hasLogo ? '' : ' is-dot'}" data-source="${escapeHtml(id)}"
    role="img" title="${escapeHtml(meta.label)}" aria-label="${escapeHtml(meta.label)}"${style}></span>`;
}

function renderItems(items) {
  const frag = document.createDocumentFragment();
  for (const item of items) {
    const meta = sourceMetaOf(item.source);
    const li = document.createElement('li');
    li.className = 'result-item' + (item.relPath === state.activeId ? ' active' : '');
    li.dataset.id = item.relPath;

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
        ${item.favorite ? '<span class="ri-star" title="お気に入り">★</span>' : ''}
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

function renderMore() {
  if (state.offset < state.total) {
    el.more.innerHTML = `<button id="btn-more">さらに読み込む（残り ${fmtInt(state.total - state.offset)} 件）</button>`;
    $('#btn-more').addEventListener('click', () => fetchPage(false));
  } else {
    el.more.textContent = state.total > state.limit ? 'すべて表示しました' : '';
  }
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
  if (el.list.scrollTop + el.list.clientHeight > el.list.scrollHeight - 400) fetchPage(false);
});

/* ---------------------------------------------------------------- reader */

let hitMarks = [];
let hitIndex = -1;

async function openConversation(relPath, focusTurn) {
  state.activeId = relPath;
  el.list.querySelectorAll('.result-item').forEach((li) => li.classList.toggle('active', li.dataset.id === relPath));
  document.body.classList.add('reading');
  writeHash();

  const conv = await fetch('/api/conversation?id=' + encodeURIComponent(relPath)).then((r) => r.json());
  if (conv.error) return;

  const links = [];
  if (conv.url) links.push(`<a href="${escapeHtml(conv.url)}" target="_blank" rel="noopener">元のチャットを開く ↗</a>`);
  links.push(`<a href="obsidian://open?path=${encodeURIComponent(conv.absPath)}">Obsidian で開く</a>`);
  links.push(`<a href="/api/raw?id=${encodeURIComponent(relPath)}" target="_blank" rel="noopener">Markdown 原文</a>`);

  const turnsHtml = conv.turns
    .map((turn) => {
      const who = turn.role === 'user' ? '自分' : turn.role === 'note' ? 'メモ' : conv.sourceMeta.label;
      const extras =
        (turn.sources ? detailsBlock('', `🔗 出典`, md.render(turn.sources), false) : '') +
        (turn.related ? detailsBlock('', `❓ 関連する質問`, md.render(turn.related), false) : '');
      return `<div class="turn ${turn.role}" data-turn="${turn.index}">
          <div class="turn-head">
            <span class="turn-who">${escapeHtml(who)}</span>
            ${turn.time ? `<span>${escapeHtml(turn.time)}</span>` : ''}
          </div>
          <div class="bubble md">${renderRich(turn.text)}${extras}</div>
          <div class="turn-actions">
            <button class="act" data-act="copy" data-turn="${turn.index}" title="コピー" aria-label="コピー">${icon('copy')}</button>
            <button class="act" data-act="share" data-turn="${turn.index}" title="共有（この発言へのリンク）" aria-label="共有">${icon('share')}</button>
            <button class="act" data-act="edit" data-turn="${turn.index}" title="Obsidian で編集" aria-label="編集">${icon('pencil')}</button>
          </div>
        </div>`;
    })
    .join('');

  el.conversation.innerHTML = `
    <div class="conv-head">
      <h1 class="conv-title">${escapeHtml(conv.title)}</h1>
      <div class="conv-meta">
        <span class="badge" style="color:${escapeHtml(conv.sourceMeta.color)}">${escapeHtml(conv.sourceMeta.label)}</span>
        <span>${fmtDate(conv.chatTime, true)}</span>
        <span>${fmtInt(conv.turns.length)} 発言 / ${fmtInt(conv.chars)} 文字</span>
        ${conv.favorite ? '<span class="ri-star">★</span>' : ''}
        ${links.join('<span style="opacity:.4">·</span>')}
        <span class="hitnav" id="hitnav" hidden>
          <button class="icon-btn" id="hit-prev" title="前の一致">↑</button>
          <span id="hit-label"></span>
          <button class="icon-btn" id="hit-next" title="次の一致">↓</button>
        </span>
      </div>
    </div>
    <div class="turns">${turnsHtml}</div>`;

  el.conversation.hidden = false;
  el.readerEmpty.hidden = true;
  el.reader.scrollTop = 0;

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
  if (hitMarks.length) gotoHit(1);
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
  reload();
});

document.addEventListener('keydown', (ev) => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(ev.target.tagName);

  if (ev.key === '/' && !typing) {
    ev.preventDefault();
    el.q.focus();
    el.q.select();
    return;
  }
  if (ev.key === 'Escape') {
    if (typing) el.q.blur();
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

/* ---------------------------------------------------------------- start */

const initial = readHash();
state.q = initial.q;
el.q.value = initial.q;

loadStats()
  .then(reload)
  .then(() => {
    if (initial.id) openConversation(initial.id, initial.turn);
  });
