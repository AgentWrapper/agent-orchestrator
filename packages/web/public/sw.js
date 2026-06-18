/* globals self, caches, fetch, Response, URL, console */
const CACHE_NAME = "ao-pwa-v2";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.add(OFFLINE_URL)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request).catch((err) => {
      console.warn("[SW] Navigation fetch failed:", err.message);
      return caches
        .match(OFFLINE_URL)
        .then(
          (r) =>
            r ||
            new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } }),
        );
    }),
  );
});
