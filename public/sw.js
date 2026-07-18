// Minimal service worker — exists only so the OMS pages satisfy PWA
// installability checks. It deliberately does no caching: these pages poll
// live order state, so anything cached could show staff or customers stale
// data. Every request just passes straight through to the network.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", () => self.clients.claim());

self.addEventListener("fetch", event => {
  event.respondWith(fetch(event.request));
});
