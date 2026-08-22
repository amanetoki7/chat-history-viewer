import express from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import { CHAT_ROOT, PORT, ROOT_DIR, SOURCE_META, SOURCE_ORDER } from './src/config.js';
import { ensureIndex, index, loadConversation, onIndexChange, resolveEntryPath } from './src/indexer.js';
import { search, parseQuery, buildSnippets } from './src/search.js';
import { splitThreadSections, MARKDOWN_IMAGE_RE } from './src/parser.js';
import { loadNativeConversation } from './src/native.js';
import { planQueries, retrieve, answerStream } from './src/ask.js';
import { ensureEmbeddings, embeddingsStatus } from './src/embeddings.js';
import { startWatcher, watcherStatus } from './src/watcher.js';
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

/** SOURCE_ORDER の並び順。未知のソースは末尾（件数順）に回す。 */
function sourceRank(id) {
  const i = SOURCE_ORDER.indexOf(id);
  return i === -1 ? SOURCE_ORDER.length : i;
}

/** ヒートマップ用の日付キー（サーバーのローカル時刻で 'YYYY-MM-DD'） */
function dayKey(time) {
  const d = new Date(time);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

app.get('/api/stats', (_req, res) => {
  const bySource = new Map();
  const activity = {}; // { source: { 'YYYY-MM-DD': チャット開始日ごとの会話数 } }
  let earliest = Infinity;
  let latest = -Infinity;
  let totalTurns = 0;
  let totalChars = 0;

  for (const e of index.entries) {
    bySource.set(e.source, (bySource.get(e.source) || 0) + 1);
    if (e.chatTime) {
      if (e.chatTime < earliest) earliest = e.chatTime;
      if (e.chatTime > latest) latest = e.chatTime;
      const bucket = (activity[e.source] ??= {});
      const k = dayKey(e.chatTime);
      bucket[k] = (bucket[k] || 0) + 1;
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
    watcher: watcherStatus(),
    earliest: Number.isFinite(earliest) ? earliest : null,
    latest: Number.isFinite(latest) ? latest : null,
    activity,
    sources: [...bySource.entries()]
      .map(([id, count]) => ({ id, count, ...(SOURCE_META[id] || SOURCE_META.unknown) }))
      .sort((a, b) => sourceRank(a.id) - sourceRank(b.id) || b.count - a.count),
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
    timeBasis: req.query.basis === 'last' ? 'last' : 'start',
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

  // 同名の .raw.json があれば、その会話ツリーから組み立てた turns で描画する
  const native = await loadNativeConversation(abs, conv);

  const turns = (native ? native.turns : conv.turns).map((turn, i) => {
    const base = {
      index: i,
      role: turn.role,
      model: turn.model,
      time: turn.time,
      chars: turn.text.length,
      // Native 描画の思考アクティビティ（ChatGPT の「◯m ◯s考えました」、Perplexity の検索手順）
      reasoning: turn.reasoning || null,
      // Native 描画の記事カード（ChatGPT の nav_list、Perplexity のメディア。本文の <antNavList> が参照する）
      navLists: turn.navLists || null,
      // Native 描画の引用チップ（ChatGPT の grouped_webpages、Perplexity の [1]。本文の #cite- リンクが参照する）
      citeLists: turn.citeLists || null,
    };
    // Sources / Related Questions の見出し分割は .md（Perplexity Threads）由来の構造にだけ適用する
    if (!native && turn.role === 'assistant') {
      const { body, sources, related } = splitThreadSections(turn.text);
      return { ...base, text: body, sources, related };
    }
    // Native 描画（Perplexity）の関連する質問
    return { ...base, text: turn.text, sources: null, related: turn.related || null };
  });

  // ターン範囲の指定。tail=N は末尾 N 件、turnFrom / turnTo（末尾は省略可、to は含まない）は
  // 絶対インデックスの範囲。turn.index は全体でのインデックスのまま返すので、
  // フロントは後から前の範囲を継ぎ足せる（上方向の Lazy 読み込み用）
  const turnCount = turns.length;
  let from = 0;
  let to = turnCount;
  const tail = Number(req.query.tail);
  if (Number.isFinite(tail) && tail > 0) {
    from = Math.max(0, turnCount - Math.floor(tail));
  } else {
    const qFrom = Number(req.query.turnFrom);
    const qTo = Number(req.query.turnTo);
    if (Number.isFinite(qFrom)) from = Math.min(Math.max(Math.floor(qFrom), 0), turnCount);
    if (Number.isFinite(qTo)) to = Math.min(Math.max(Math.floor(qTo), from), turnCount);
  }

  res.json({
    relPath,
    absPath: abs,
    title: conv.title,
    source: conv.source,
    sourceMeta: SOURCE_META[conv.source] || SOURCE_META.unknown,
    format: conv.format,
    native: Boolean(native),
    url: conv.url,
    favorite: conv.favorite,
    archived: conv.archived,
    tags: conv.tags,
    spaceName: conv.spaceName,
    chatTime: conv.chatTime,
    lastTime: conv.lastTime,
    createdAt: conv.createdAt,
    chars: conv.chars,
    turnCount,
    turnFrom: from,
    turns: turns.slice(from, to),
  });
});

/**
 * 会話に含まれる添付画像（Markdown 画像）の src を先頭から返す。
 * 一覧の画像チップのホバープレビュー用。data URI をそのまま返すので
 * limit で枚数を絞る（total は全体の枚数）。
 * チップの枚数（索引の imageCount / firstImageCount）と合わせ、ユーザー発言の
 * 画像だけを対象にする。scope=first なら最初のユーザー発言だけ。
 */
app.get('/api/images', async (req, res) => {
  const relPath = String(req.query.id || '');
  const limit = Math.min(Math.max(Number(req.query.limit) || 4, 1), 12);
  const scope = req.query.scope === 'first' ? 'first' : 'all';
  const entry = index.entries.find((e) => e.relPath === relPath);
  const abs = resolveEntryPath(relPath);
  if (!entry || !abs) return res.status(404).json({ error: 'not found' });

  const conv = await loadConversation({ abs, relPath, title: entry.title, mtimeMs: entry.mtimeMs, size: entry.size });
  if (!conv) return res.status(500).json({ error: 'read failed' });
  // 表示と同じターン（.raw.json があればそちら）から拾う
  const native = await loadNativeConversation(abs, conv);
  const turns = native ? native.turns : conv.turns;

  const images = [];
  let total = 0;
  for (const turn of turns) {
    if (turn.role !== 'user') continue;
    MARKDOWN_IMAGE_RE.lastIndex = 0;
    for (const m of turn.text.matchAll(MARKDOWN_IMAGE_RE)) {
      total++;
      if (images.length < limit) images.push(m[1]);
    }
    if (scope === 'first') break; // 最初のユーザー発言だけ
  }
  res.json({ total, images });
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

/* ------------------------------------------------- 索引の更新通知（SSE） */

/** 経路上のプロキシに切られないための無通信対策 */
const EVENTS_PING_MS = 25_000;

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  res.write('retry: 3000\n\n');
  send('hello', { conversations: index.entries.length, builtAt: index.builtAt, watcher: watcherStatus() });

  const off = onIndexChange((detail) =>
    send('index', { ...detail, conversations: index.entries.length, builtAt: index.builtAt })
  );
  const ping = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, EVENTS_PING_MS);

  req.on('close', () => {
    off();
    clearInterval(ping);
  });
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

// 旧「履歴に質問」ページ。モーダルに統合したためトップへ戻す（ブックマーク対策）
app.get('/ask', (_req, res) => res.redirect('/'));

app.use('/vendor/markdown-it', express.static(path.join(ROOT_DIR, 'node_modules/markdown-it/dist')));
// CodeMirror (lezer) の ESM モジュール群。index.html の import map から参照される
app.use('/vendor/nm', express.static(path.join(ROOT_DIR, 'node_modules')));
app.use(express.static(path.join(ROOT_DIR, 'public'), { extensions: ['html'] }));

/* ---------------------------------------------------------------- start */

const force = process.argv.includes('--reindex');

ensureIndex({ force, log: (m) => console.log('[index]', m) })
  .then(() => {
    // 意味検索用の埋め込みは起動をブロックせずに裏で構築・更新する
    ensureEmbeddings({ log: (m) => console.log('[embed]', m) });
    // ファイルの追加・変更・削除を監視して索引と埋め込みへ即時反映する
    startWatcher({ log: (m) => console.log('[watch]', m) });
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
