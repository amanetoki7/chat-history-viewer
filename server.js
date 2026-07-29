import express from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import { CHAT_ROOT, PORT, ROOT_DIR, SOURCE_META } from './src/config.js';
import { ensureIndex, index, loadConversation, resolveEntryPath } from './src/indexer.js';
import { search, parseQuery, buildSnippets } from './src/search.js';
import { splitThreadSections } from './src/parser.js';
import { planQueries, retrieve, answerStream } from './src/ask.js';
import { ensureEmbeddings, embeddingsStatus } from './src/embeddings.js';
import {
  createResearchJob,
  getJob,
  getActiveJob,
  cancelJob,
  jobSnapshot,
  startResearchWorker,
  TERMINAL_STATUSES,
} from './src/research.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

let indexing = false;

/* ------------------------------------------------------------------ API */

app.get('/api/stats', (_req, res) => {
  const bySource = new Map();
  let earliest = Infinity;
  let latest = -Infinity;
  let totalTurns = 0;
  let totalChars = 0;

  for (const e of index.entries) {
    bySource.set(e.source, (bySource.get(e.source) || 0) + 1);
    if (e.chatTime) {
      if (e.chatTime < earliest) earliest = e.chatTime;
      if (e.chatTime > latest) latest = e.chatTime;
    }
    totalTurns += e.turnCount;
    totalChars += e.chars;
  }

  res.json({
    root: CHAT_ROOT,
    conversations: index.entries.length,
    totalTurns,
    totalChars,
    indexBytes: index.blob.length,
    builtAt: index.builtAt,
    indexing,
    earliest: Number.isFinite(earliest) ? earliest : null,
    latest: Number.isFinite(latest) ? latest : null,
    sources: [...bySource.entries()]
      .map(([id, count]) => ({ id, count, ...(SOURCE_META[id] || SOURCE_META.unknown) }))
      .sort((a, b) => b.count - a.count),
  });
});

app.get('/api/conversations', async (req, res) => {
  const q = String(req.query.q || '');
  const limit = Math.min(Number(req.query.limit) || 30, 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const sourcesParam = String(req.query.sources || '').trim();

  const started = Date.now();
  const { total, hits } = search(index, {
    q,
    sources: sourcesParam ? new Set(sourcesParam.split(',').filter(Boolean)) : null,
    from: req.query.from ? Date.parse(String(req.query.from)) : null,
    to: req.query.to ? Date.parse(String(req.query.to)) + 86_399_999 : null,
    favorite: req.query.favorite === '1',
    includeArchived: req.query.archived !== '0',
    scope: ['user', 'assistant'].includes(String(req.query.scope)) ? String(req.query.scope) : 'all',
    sort: String(req.query.sort || 'relevance'),
  });

  const { terms } = parseQuery(q);
  const page = hits.slice(offset, offset + limit);
  const items = await buildSnippets(index, page, terms);

  res.json({
    total,
    offset,
    limit,
    took: Date.now() - started,
    terms: terms.map((t) => t.text),
    items,
  });
});

app.get('/api/conversation', async (req, res) => {
  const relPath = String(req.query.id || '');
  const entry = index.entries.find((e) => e.relPath === relPath);
  const abs = resolveEntryPath(relPath);
  if (!entry || !abs) return res.status(404).json({ error: 'not found' });

  const conv = await loadConversation({ abs, relPath, title: entry.title, mtimeMs: entry.mtimeMs, size: entry.size });
  if (!conv) return res.status(500).json({ error: 'read failed' });

  const turns = conv.turns.map((turn, i) => {
    const base = { index: i, role: turn.role, model: turn.model, time: turn.time, chars: turn.text.length };
    if (turn.role === 'assistant') {
      const { body, sources, related } = splitThreadSections(turn.text);
      return { ...base, text: body, sources, related };
    }
    return { ...base, text: turn.text, sources: null, related: null };
  });

  res.json({
    relPath,
    absPath: abs,
    title: conv.title,
    source: conv.source,
    sourceMeta: SOURCE_META[conv.source] || SOURCE_META.unknown,
    format: conv.format,
    url: conv.url,
    favorite: conv.favorite,
    archived: conv.archived,
    tags: conv.tags,
    spaceName: conv.spaceName,
    chatTime: conv.chatTime,
    createdAt: conv.createdAt,
    chars: conv.chars,
    turns,
  });
});

app.get('/api/raw', async (req, res) => {
  const abs = resolveEntryPath(String(req.query.id || ''));
  if (!abs) return res.status(404).send('not found');
  try {
    res.type('text/plain; charset=utf-8').send(await fs.readFile(abs, 'utf8'));
  } catch {
    res.status(404).send('not found');
  }
});

app.post('/api/ask', async (req, res) => {
  const question = String(req.body?.question || '').trim();
  const history = Array.isArray(req.body?.history)
    ? req.body.history
        .filter((t) => t && ['user', 'assistant'].includes(t.role) && typeof t.content === 'string')
        .slice(-20)
    : [];
  if (!question) return res.status(400).json({ error: 'question is required' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    send('status', { phase: 'planning' });
    const plan = await planQueries(question, history);
    send('status', { phase: 'searching', queries: plan.queries.map((q) => q.q), semantic: embeddingsStatus().ready });

    const items = await retrieve(plan, question);

    send('status', { phase: 'answering' });
    const { kept } = await answerStream(question, history, items, (delta) => send('delta', { text: delta }));

    send('sources', {
      items: kept.map(({ n, relPath, title, source, sourceLabel, date }) => ({ n, relPath, title, source, sourceLabel, date })),
    });
    send('done', {});
  } catch (err) {
    console.error('[ask] failed:', err);
    const unreachable =
      err?.cause?.code === 'ECONNREFUSED' ||
      (err?.cause?.errors || []).some((e) => e?.code === 'ECONNREFUSED') ||
      /fetch failed|ECONNREFUSED/i.test(err?.message || '');
    const message = unreachable
      ? 'LM Studio に接続できません。LM Studio を起動し、ローカルサーバー（既定 http://localhost:1234）を開始してください。'
      : err?.message || '回答の生成に失敗しました。';
    send('error', { message });
  } finally {
    res.end();
  }
});

/* ------------------------------------------------- Deep リサーチ（非同期ジョブ） */

app.post('/api/research', (req, res) => {
  const question = String(req.body?.question || '').trim();
  if (!question) return res.status(400).json({ error: 'question is required' });

  // 同時実行は 1 件。実行中があれば新規作成を断る（フロントは再接続できる）
  const active = getActiveJob();
  if (active) {
    return res.status(409).json({ error: '調査が進行中です。完了かキャンセルを待ってください。', jobId: active.id });
  }

  const job = createResearchJob(question, { budgetMinutes: req.body?.budgetMinutes });
  res.status(202).json({ jobId: job.id, status: job.status, budgetMs: job.budgetMs });
});

app.get('/api/research/active', (_req, res) => {
  const job = getActiveJob();
  res.json({ job: job ? jobSnapshot(job) : null });
});

app.get('/api/research/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  res.json(jobSnapshot(job));
});

app.post('/api/research/:id/cancel', (req, res) => {
  const ok = cancelJob(req.params.id);
  if (!ok) return res.status(404).json({ error: 'not found or already finished' });
  res.json({ ok: true });
});

app.get('/api/research/:id/events', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  // 1 秒ごとにスナップショットを送り、終了状態になったら閉じる
  const send = () => {
    if (res.writableEnded) return true;
    res.write(`event: progress\ndata: ${JSON.stringify(jobSnapshot(job))}\n\n`);
    if (TERMINAL_STATUSES.has(job.status)) {
      res.end();
      return true;
    }
    return false;
  };
  if (!send()) {
    const timer = setInterval(() => {
      if (send()) clearInterval(timer);
    }, 1000);
    req.on('close', () => clearInterval(timer));
  }
});

app.post('/api/reindex', async (_req, res) => {
  if (indexing) return res.status(409).json({ error: 'already indexing' });
  indexing = true;
  res.json({ started: true });
  try {
    await ensureIndex({ force: true, log: (m) => console.log('[reindex]', m) });
    await ensureEmbeddings({ log: (m) => console.log('[embed]', m) });
  } catch (err) {
    console.error('[reindex] failed:', err);
  } finally {
    indexing = false;
  }
});

app.get('/api/embeddings/status', (_req, res) => {
  res.json(embeddingsStatus());
});

/* --------------------------------------------------------------- static */

app.use('/vendor/markdown-it', express.static(path.join(ROOT_DIR, 'node_modules/markdown-it/dist')));
app.use('/vendor/hljs', express.static(path.join(ROOT_DIR, 'node_modules/@highlightjs/cdn-assets')));
app.use(express.static(path.join(ROOT_DIR, 'public'), { extensions: ['html'] }));

/* ---------------------------------------------------------------- start */

const force = process.argv.includes('--reindex');

ensureIndex({ force, log: (m) => console.log('[index]', m) })
  .then(() => {
    // 意味検索用の埋め込みは起動をブロックせずに裏で構築・更新する
    ensureEmbeddings({ log: (m) => console.log('[embed]', m) });
    // Deep リサーチの Worker（再起動時は未完了ジョブを再キューして続行）
    startResearchWorker({ log: (m) => console.log('[research]', m) });
    app.listen(PORT, () => {
      console.log('');
      console.log(`  AI Chat History Viewer`);
      console.log(`  → http://localhost:${PORT}`);
      console.log(`  ${index.entries.length.toLocaleString()} 件の会話を索引済み (${CHAT_ROOT})`);
      console.log('');
    });
  })
  .catch((err) => {
    console.error('索引の構築に失敗しました:', err);
    process.exit(1);
  });
