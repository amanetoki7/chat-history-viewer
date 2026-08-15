/*
 * Service Worker。方針は「ネットワーク優先・キャッシュは落ちたときの控え」。
 * ローカルサーバーが生きていれば常に最新を返し、切れているときだけ
 * キャッシュ済みのアプリシェルで開けるようにする。
 * /api/ は SSE（EventSource）と動的データのため一切触らない。
 */

const CACHE = 'chv-shell-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key !== CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // GET の同一オリジンだけを扱う。/api/ はストリーミングを壊さないよう素通し
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    (async () => {
      try {
        const res = await fetch(req);
        if (res.ok) {
          const cache = await caches.open(CACHE);
          cache.put(req, res.clone());
        }
        return res;
      } catch (err) {
        // オフライン時のフォールバック。ナビゲーションはクエリ違いでも index を返す
        const hit = await caches.match(req, { ignoreSearch: req.mode === 'navigate' });
        if (hit) return hit;
        if (req.mode === 'navigate') {
          const shell = await caches.match('/');
          if (shell) return shell;
        }
        throw err;
      }
    })()
  );
});
