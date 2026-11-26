/* YDC 골프 내기 — 서비스 워커
 * 앱 전체를 미리 받아 두고, 평소에는 캐시에서 즉시 응답한다(필드에서 신호 없어도 실행).
 * 화면(index)은 캐시를 먼저 주고 뒤에서 최신본을 받아 다음 실행 때 반영한다.
 */
const CACHE = 'ydc-golf-bet-v6';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;

  const isDoc = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');

  if (isDoc) {
    // 캐시 우선 + 뒤에서 갱신(다음 실행 때 최신)
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const hit = await cache.match('./index.html', { ignoreSearch: true });
        const network = fetch(req).then((res) => {
          if (res && res.ok) cache.put('./index.html', res.clone()).catch(() => {});
          return res;
        }).catch(() => null);

        if (hit) return hit;
        const res = await network;
        return res || new Response(
          '<!doctype html><meta charset="utf-8"><div style="font-family:sans-serif;padding:24px">오프라인 상태이고 저장된 앱이 없습니다. 인터넷이 되는 곳에서 한 번 열어 주세요.</div>',
          { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      })
    );
    return;
  }

  // 정적 파일: 캐시 우선, 없으면 네트워크 후 저장
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => new Response('', { status: 504 }));
    })
  );
});
