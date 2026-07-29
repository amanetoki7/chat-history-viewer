/* 履歴に質問 — チャット UI。/api/ask (SSE) を叩いて逐次表示する。 */

const md = window.markdownit({ linkify: true, breaks: true });

const log = document.getElementById('log');
const empty = document.getElementById('empty');
const form = document.getElementById('form');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const deepMode = document.getElementById('deep-mode');

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

/* ------------------------------------------------- Deep リサーチ */

const RESEARCH_PHASE_LABEL = {
  queued: '順番を待っています',
  planning: '調査計画を作成しています',
  searching: '履歴を反復検索しています',
  verifying: '根拠と矛盾を確認しています',
  writing: 'レポートを作成しています',
};

function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}分${String(s % 60).padStart(2, '0')}秒` : `${s}秒`;
}

/** 進捗カード（進捗バー・現在の工程・統計・途中経過・キャンセル）を作る。 */
function addResearchCard(jobId) {
  empty?.remove();
  const card = el('div', 'research-card');

  const head = el('div', 'research-head');
  const title = el('span', 'research-title', '🔬 詳しく調査しています');
  const pct = el('span', 'research-pct', '0%');
  const cancel = el('button', 'research-cancel', 'キャンセル');
  cancel.type = 'button';
  cancel.addEventListener('click', () => {
    cancel.disabled = true;
    cancel.textContent = '停止中…';
    fetch(`/api/research/${jobId}/cancel`, { method: 'POST' }).catch(() => {});
  });
  head.append(title, pct, cancel);

  const bar = el('div', 'research-bar');
  const fill = el('i');
  bar.appendChild(fill);

  const step = el('div', 'research-step', '');
  const stats = el('div', 'research-stats', '');
  const findings = el('ul', 'research-findings');
  findings.hidden = true;

  card.append(head, bar, step, stats, findings);
  log.appendChild(card);
  scrollDown();
  return { card, title, pct, fill, step, stats, findings, cancel };
}

function updateResearchCard(refs, snap) {
  refs.pct.textContent = `${snap.progress}%`;
  refs.fill.style.width = `${snap.progress}%`;
  const phase = RESEARCH_PHASE_LABEL[snap.status] || snap.status;
  refs.step.textContent = snap.currentStep && snap.currentStep !== phase ? `${phase} — ${snap.currentStep}` : phase;
  refs.stats.textContent =
    `検索 ${snap.stats.searches} 回 ・ 参照 ${snap.stats.chunksSeen} チャンク ・ ` +
    `証拠 ${snap.stats.evidence} 件 ・ 経過 ${fmtElapsed(snap.elapsedMs)}`;

  if (snap.interimFindings?.length) {
    refs.findings.hidden = false;
    refs.findings.replaceChildren(
      ...snap.interimFindings.map((f) => el('li', '', `${f.claim}（根拠 ${f.evidenceCount} 件）`))
    );
  }
}

function finishResearchCard(refs, snap) {
  refs.card.classList.add('done');
  refs.cancel.remove();
  refs.fill.style.width = '100%';
  if (snap.status === 'completed') {
    refs.title.textContent = snap.truncated ? '✅ 調査完了（予算上限で打ち切り）' : '✅ 調査完了';
    refs.step.textContent = `検索 ${snap.stats.searches} 回・${fmtElapsed(snap.elapsedMs)} で完了`;
  } else if (snap.status === 'cancelled') {
    refs.title.textContent = '⏹ 調査をキャンセルしました';
    refs.step.textContent = '';
  } else {
    refs.title.textContent = '⚠ 調査に失敗しました';
    refs.step.textContent = '';
  }
}

/** SSE でジョブを購読し、進捗カードとレポートを更新する。 */
function watchResearch(jobId, refs, question) {
  const es = new EventSource(`/api/research/${jobId}/events`);
  let assistant = null;
  let lastReport = '';

  es.addEventListener('progress', (ev) => {
    const snap = JSON.parse(ev.data);
    updateResearchCard(refs, snap);

    if (snap.report && snap.report !== lastReport) {
      if (!assistant) assistant = addAssistantMsg();
      assistant.body.innerHTML = md.render(snap.report);
      lastReport = snap.report;
      scrollDown();
    }

    if (['completed', 'failed', 'cancelled'].includes(snap.status)) {
      es.close();
      finishResearchCard(refs, snap);
      if (snap.status === 'completed') {
        if (assistant && snap.sources?.length) renderSources(assistant.node, snap.sources);
        if (snap.report) history.push({ role: 'user', content: question }, { role: 'assistant', content: snap.report });
      } else if (snap.status === 'failed') {
        log.appendChild(el('div', 'ask-msg assistant ask-error', snap.error || '調査に失敗しました。'));
      }
      scrollDown();
      busy = false;
      sendBtn.disabled = false;
      input.focus();
    }
  });
}

async function research(question) {
  busy = true;
  sendBtn.disabled = true;
  addUserMsg(question);

  try {
    const res = await fetch('/api/research', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    watchResearch(data.jobId, addResearchCard(data.jobId), question);
  } catch (err) {
    log.appendChild(el('div', 'ask-msg assistant ask-error', String(err.message || err)));
    scrollDown();
    busy = false;
    sendBtn.disabled = false;
  }
}

/** ページ再読込時、実行中の調査ジョブがあれば表示を復元して購読し直す。 */
(async () => {
  try {
    const res = await fetch('/api/research/active');
    const { job } = await res.json();
    if (!job) return;
    busy = true;
    sendBtn.disabled = true;
    addUserMsg(job.question);
    const refs = addResearchCard(job.id);
    updateResearchCard(refs, job);
    watchResearch(job.id, refs, job.question);
  } catch {
    /* サーバ未対応・接続不可は無視 */
  }
})();

/* -------------------------------------------------------------- form */

form.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const question = input.value.trim();
  if (!question || busy) return;
  input.value = '';
  input.style.height = '';
  if (deepMode?.checked) research(question);
  else ask(question);
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
