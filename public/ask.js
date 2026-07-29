/* 履歴に質問 — チャット UI。/api/ask (SSE) を叩いて逐次表示する。 */

const md = window.markdownit({ linkify: true, breaks: true });

const log = document.getElementById('log');
const empty = document.getElementById('empty');
const form = document.getElementById('form');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');

/** {role, content} の対話履歴（サーバーへそのまま送る） */
const history = [];
let busy = false;

/* ------------------------------------------------------------ theme */

const savedTheme = localStorage.getItem('theme');
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
document.getElementById('btn-theme').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('theme', next);
});

/* --------------------------------------------------------------- UI */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function scrollDown() {
  log.scrollTop = log.scrollHeight;
}

function addUserMsg(text) {
  empty?.remove();
  log.appendChild(el('div', 'ask-msg user', text));
  scrollDown();
}

function addStatus(text) {
  const node = el('div', 'ask-status');
  node.append(el('span', 'dots', text));
  log.appendChild(node);
  scrollDown();
  return node;
}

function addAssistantMsg() {
  const node = el('div', 'ask-msg assistant');
  const body = el('div', 'ask-body');
  node.appendChild(body);
  log.appendChild(node);
  return { node, body };
}

function renderSources(node, items) {
  if (!items.length) return;
  const wrap = el('div', 'ask-sources');
  for (const s of items) {
    const a = el('a', 'ask-source');
    a.href = '/#' + new URLSearchParams({ id: s.relPath }).toString();
    a.target = '_blank';
    a.title = `${s.title}（${s.sourceLabel}${s.date ? ', ' + s.date : ''}）`;
    a.append(el('span', 'num', `[${s.n}]`), el('span', 'title', s.title), el('span', '', s.date || ''));
    wrap.appendChild(a);
  }
  node.appendChild(wrap);
}

/* --------------------------------------------------------------- SSE */

/** fetch レスポンスの SSE を {event, data} ごとにコールバックする。 */
async function readSSE(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      let event = 'message';
      let data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      if (data) onEvent(event, JSON.parse(data));
    }
  }
}

const PHASE_LABEL = {
  planning: '検索クエリを考えています',
  searching: '履歴を検索しています',
  answering: '回答を書いています',
};

async function ask(question) {
  busy = true;
  sendBtn.disabled = true;
  addUserMsg(question);

  let status = addStatus(PHASE_LABEL.planning);
  let assistant = null;
  let answerText = '';
  let failed = false;

  try {
    const response = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, history }),
    });
    if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || `HTTP ${response.status}`);

    await readSSE(response, (event, data) => {
      if (event === 'status') {
        status.firstChild.textContent = PHASE_LABEL[data.phase] || data.phase;
        if (data.queries) status.append(el('span', '', `　(${data.queries.join(' / ')})`));
      } else if (event === 'delta') {
        if (!assistant) {
          status.remove();
          assistant = addAssistantMsg();
        }
        answerText += data.text;
        assistant.body.innerHTML = md.render(answerText);
        scrollDown();
      } else if (event === 'sources') {
        if (assistant) renderSources(assistant.node, data.items);
      } else if (event === 'error') {
        failed = true;
        status.remove();
        log.appendChild(el('div', 'ask-msg assistant ask-error', data.message));
        scrollDown();
      }
    });
  } catch (err) {
    failed = true;
    status.remove();
    log.appendChild(el('div', 'ask-msg assistant ask-error', String(err.message || err)));
    scrollDown();
  }

  if (!failed && answerText) {
    history.push({ role: 'user', content: question }, { role: 'assistant', content: answerText });
  }
  busy = false;
  sendBtn.disabled = false;
  input.focus();
}

/* -------------------------------------------------------------- form */

form.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const question = input.value.trim();
  if (!question || busy) return;
  input.value = '';
  input.style.height = '';
  ask(question);
});

input.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault();
    form.requestSubmit();
  }
});

input.addEventListener('input', () => {
  input.style.height = '';
  input.style.height = Math.min(input.scrollHeight, 160) + 'px';
});

document.querySelectorAll('.hint').forEach((btn) => {
  btn.addEventListener('click', () => {
    input.value = btn.textContent;
    form.requestSubmit();
  });
});

input.focus();
