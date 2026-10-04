/* ============================================================
   HPF Digital Learning Portal — service worker.

   Keeps the APP itself (pages, scripts, styles, icons, the sign-in
   library) on the device so every dashboard opens without a connection.
   It never touches data: the API, files and anything signed in go
   straight to the network — data offline lives in IndexedDB per account
   (offline.js), where it can be cleared on sign-out. A shared cache of
   signed-in replies is how one person's data reaches the next person on
   a shared school device; this avoids that by design.

   Network first, so a deploy shows up on the very next online load —
   but on a slow connection the copy here is used after 4 seconds (the
   download still finishes in the background, for next time). Offline,
   the copy here is used straight away.
   ============================================================ */

const VERSION = "hpf-learning-v5";
const SHELL = [
  "./", "./index.html", "./learner.html", "./teacher.html", "./leader.html", "./field.html",
  "./platform.html", "./admin.html", "./me.html", "./education.html", "./workspace.html", "./workspace.js",
  "./styles.css", "./manifest.webmanifest", "./assets/icon-192.png", "./assets/icon-512.png",
  "./config.js", "./supabase.js", "./api.js", "./auth.js", "./util.js", "./data.js", "./store.js", "./nav.js", "./navigation.js", "./viewer.js",
  "./offline.js", "./sync.js", "./sync-ui.js", "./notify-ui.js", "./reports-ui.js", "./export.js", "./pwa.js", "./forms.js", "./assignments-ui.js", "./learners-ui.js",
  "./index.js", "./learner.js", "./teacher.js", "./leader.js", "./field.js", "./console.js", "./admin-ui.js", "./profile-ui.js",
  "./impact-ui.js", "./training-ui.js", "./mel-ui.js", "./dq-ui.js", "./kobo-ui.js",
];
// Third-party code the pages load (the sign-in library, fonts): kept as it's fetched.
const RUNTIME_HOSTS = ["esm.sh", "fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // One by one: a single missing file mustn't leave the device with nothing.
    await Promise.all(SHELL.map((url) => cache.add(new Request(url, { cache: "reload" })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== VERSION) await caches.delete(key);
    await self.clients.claim();
  })());
});

/** Network first; the device's copy if the network fails or takes over 4 s. */
async function networkFirst(request, fallbackUrl) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(request, { ignoreSearch: request.mode === "navigate" });
  const network = fetch(request).then((res) => {
    if (res && (res.ok || res.type === "opaque")) cache.put(request, res.clone()).catch(() => {});
    return res;
  });
  network.catch(() => {});
  if (cached) {
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 4000));
    const first = await Promise.race([network.catch(() => null), timeout]);
    return first || cached;
  }
  try {
    return await network;
  } catch {
    const fallback = fallbackUrl ? await cache.match(fallbackUrl) : null;
    return fallback || new Response("You're offline and this page isn't on this device yet.", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // never a write
  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(request, request.mode === "navigate" ? "./index.html" : null));
    return;
  }
  if (RUNTIME_HOSTS.includes(url.hostname)) event.respondWith(networkFirst(request, null));
  // Everything else — the API, signed file links — goes to the network untouched.
});
