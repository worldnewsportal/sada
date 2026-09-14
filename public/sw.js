// Sada service worker — offline shell + push display (spec §34, §18).
//
// v2 — CRITICAL FIX: the old strategy was cache-first for ALL same-origin
// requests, including the app document "/". Devices that visited before a
// deploy kept loading the STALE HTML + stale JS chunks from the cache
// forever (users saw old crashes even after the server was fixed).
//
// v2 strategy:
//   - navigations (documents)  → NETWORK-FIRST, cached "/" only as offline
//     fallback  → devices always boot the latest client build.
//   - /api/*                   → network-only, structured offline envelope.
//   - other same-origin GETs   → NETWORK-FIRST, cache fallback (offline shell
//     still works; hashed prod chunks get cached opportunistically).
const SHELL_CACHE = "sada-shell-v2";
const SHELL_ASSETS = ["/", "/manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // API: always live; offline → structured envelope the client understands.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(req).catch(
        () =>
          new Response(JSON.stringify({ ok: false, error: { code: "OFFLINE", message: "Offline" } }), {
            status: 503,
            headers: { "content-type": "application/json" },
          })
      )
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  // Same-origin: NETWORK-FIRST with cache fallback (fixes stale-app bug).
  event.respondWith(
    fetch(req)
      .then((res) => {
        // Opportunistic cache for offline fallback (best-effort, never blocks).
        const copy = res.clone();
        caches.open(SHELL_CACHE).then((cache) => cache.put(req, copy)).catch(() => undefined);
        return res;
      })
      .catch(() =>
        caches
          .match(req)
          .then((cached) => cached || (req.mode === "navigate" ? caches.match("/") : undefined))
          .then((fallback) => fallback || new Response("Offline", { status: 503, statusText: "Offline" }))
      )
  );
});

// push display (spec §18)
self.addEventListener("push", (event) => {
  let data = { title: "Sada", body: "New message", chatId: null };
  try {
    data = { ...data, ...event.data.json() };
  } catch {
    /* keep defaults */
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: data.chatId || "sada",
      data: { chatId: data.chatId },
      vibrate: [80, 40, 80],
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const chatId = event.notification.data?.chatId;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          client.postMessage({ type: "open-chat", chatId });
          return client.focus();
        }
      }
      return self.clients.openWindow("/" + (chatId ? `#/chat/${chatId}` : ""));
    })
  );
});
