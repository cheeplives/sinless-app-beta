/**
 * sw.js — service worker for the Sinless Character Dossier PWA.
 *
 * Precaches the whole app at install so it opens and calculates fully
 * offline. Serving strategy:
 *   - App code (same-origin HTML/JS/CSS): NETWORK-FIRST. When online the
 *     freshest deploy always wins; the cache is only a fallback for offline.
 *     This avoids the classic cache-first pitfall where an edited file keeps
 *     serving the stale precached copy until CACHE_VERSION is bumped.
 *   - Fonts / icons / images: CACHE-FIRST (they're immutable and heavy).
 * Successful network responses refresh the cache, so offline always has the
 * last-seen version. Bump CACHE_VERSION when you want to force-drop old caches.
 */
"use strict";

const CACHE_VERSION = "sinless-v40";

const PRECACHE = [
  "./",
  "index.html",
  "manifest.json",
  "static/style.css",
  "static/fonts.css",
  "static/data.js",
  "static/rules.js",
  "static/storage.js",
  "static/sync.js",
  "static/homebrew.js",
  "static/app.js",
  "static/sheet.js",
  "static/workspace.js",
  "static/auth-ui.js",
  "static/theme-init.js",
  "static/register-sw.js",
  "icons/icon-192.png",
  "icons/icon-512.png",
  // latin woff2 subsets referenced by fonts.css
  "static/fonts/-F63fjptAgt5VM-kVkqdyU8n1i8q1w.woff2",
  "static/fonts/-F6qfjptAgt5VM-kVkqdyU8n3twJwlBFgg.woff2",
  "static/fonts/-F6qfjptAgt5VM-kVkqdyU8n3vAOwlBFgg.woff2",
  "static/fonts/cIflMapbsEk7TDLdtEz1BwkeJI91R5_F.woff2",
  "static/fonts/cIflMapbsEk7TDLdtEz1BwkeQI51R5_F.woff2",
  "static/fonts/cIflMapbsEk7TDLdtEz1BwkebIl1R5_F.woff2",
  "static/fonts/zYXzKVElMYYaJe8bpLHnCwDKr932-G7dytD-Dmu1syxeKYY.woff2",
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(key => key !== CACHE_VERSION).map(key => caches.delete(key))))
      .then(() => self.clients.claim()));
});

// Assets that never change in place — safe (and fast) to serve cache-first.
const CACHE_FIRST_RE = /\.(woff2?|ttf|otf|png|jpg|jpeg|gif|svg|webp|ico)(\?|$)/i;

function updateCache(request, response) {
  if (response && response.ok
      && new URL(request.url).origin === self.location.origin) {
    const copy = response.clone();
    caches.open(CACHE_VERSION).then(cache => cache.put(request, copy));
  }
  return response;
}

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  // Never cache or intercept API calls — auth/character data must always be
  // live and per-user; let them hit the network directly.
  if (url.pathname.includes("/api/")) return;
  const sameOrigin = url.origin === self.location.origin;

  // Cache-first for immutable heavy assets (fonts, icons, images).
  if (CACHE_FIRST_RE.test(request.url)) {
    event.respondWith(
      caches.match(request, { ignoreSearch: true }).then(cached =>
        cached || fetch(request).then(r => updateCache(request, r))));
    return;
  }

  // Network-first for app code + everything else same-origin: the freshest
  // deploy always wins online; fall back to cache only when the network fails.
  // `no-cache` forces a conditional request so the browser's own HTTP cache can
  // never shadow an edited file with a stale copy (server answers 304/200).
  if (sameOrigin) {
    event.respondWith(
      fetch(request, { cache: "no-cache" })
        .then(r => updateCache(request, r))
        .catch(() => fetch(request).catch(() =>
          caches.match(request, { ignoreSearch: true }))));
    return;
  }
  // Cross-origin: pass through, no caching.
});
