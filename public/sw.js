// Sada service worker — offline shell + push display (spec §34, §18).
const SHELL_CACHE = "sada-shell-v1";
const SHELL_ASSETS = ["/", "/manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// network-first for API, cache-first for static shell
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(JSON.stringify({ ok: false, error: { code: "OFFLINE", message: "Offline" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        })
      )
    );
    return;
  }
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then(
        (cached) =>
          cached ||
          fetch(event.request)
            .then((res) => {
              const copy = res.clone();
              caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, copy)).catch(() => undefined);
              return res;
            })
            .catch(() => caches.match("/"))
      )
    );
  }
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
