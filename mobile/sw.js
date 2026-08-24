// NewTube PWA service worker — minimal offline cache for the app shell.
const CACHE = "newtube-v1";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Network-first for API calls (Invidious, NewTube server)
  if (url.pathname.startsWith("/api/") || url.hostname !== self.location.hostname) {
    return;  // let the browser handle
  }
  // Cache-first for the app shell
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request).then((resp) => {
      const copy = resp.clone();
      if (resp.ok && e.request.method === "GET") {
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return resp;
    }).catch(() => caches.match("./index.html")))
  );
});
