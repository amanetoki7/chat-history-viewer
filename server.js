import express from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import { CHAT_ROOT, PORT, ROOT_DIR, SOURCE_META } from './src/config.js';
import { ensureIndex, index, loadConversation, resolveEntryPath } from './src/indexer.js';
import { search, parseQuery, buildSnippets } from './src/search.js';
import { splitThreadSections } from './src/parser.js';
import { planQueries, retrieve, answerStream } from './src/ask.js';

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
    send('status', { phase: 'searching', queries: plan.queries.map((q) => q.q) });

    const items = await retrieve(plan);

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

app.post('/api/reindex', async (_req, res) => {
  if (indexing) return res.status(409).json({ error: 'already indexing' });
  indexing = true;
  res.json({ started: true });
  try {
    await ensureIndex({ force: true, log: (m) => console.log('[reindex]', m) });
  } catch (err) {
    console.error('[reindex] failed:', err);
  } finally {
    indexing = false;
  }
});

/* --------------------------------------------------------------- static */

app.use('/vendor/markdown-it', express.static(path.join(ROOT_DIR, 'node_modules/markdown-it/dist')));
app.use('/vendor/hljs', express.static(path.join(ROOT_DIR, 'node_modules/@highlightjs/cdn-assets')));
app.use(express.static(path.join(ROOT_DIR, 'public'), { extensions: ['html'] }));

/* ---------------------------------------------------------------- start */

const force = process.argv.includes('--reindex');

ensureIndex({ force, log: (m) => console.log('[index]', m) })
  .then(() => {
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
