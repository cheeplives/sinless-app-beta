// The PWA promise: once loaded, the app opens and works with no network.
const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");
const { fixture, watchErrors, openWith, waitForApp } = require("./helpers");

test.use({ serviceWorkers: "allow" });

// The file list sw.js precaches, read from sw.js itself so the two can't drift.
const SW_SOURCE = fs.readFileSync(path.join(__dirname, "..", "..", "sw.js"), "utf8");
const PRECACHE = [...SW_SOURCE.match(/const PRECACHE = \[([\s\S]*?)\];/)[1]
  .matchAll(/"([^"]+)"/g)].map(m => m[1]);

async function controlledBySW(page) {
  await page.evaluate(() => navigator.serviceWorker.ready);
  if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) {
    await page.reload();
    await waitForApp(page);
  }
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
}

// Playwright's WebKit applies setOffline() in front of the service worker:
// with the worker controlling the page and its cache full, even the
// cache-first fonts fail with "Load failed", and a reload dies with "WebKit
// encountered an internal error". So the two network-off tests run in
// Chromium and Firefox only, and this one checks WebKit's half of the promise
// (everything sw.js needs offline is really in Cache Storage) in every engine.
const OFFLINE_SKIP = "Playwright WebKit's setOffline() blocks requests before the service worker";

test("the service worker installs and caches every app file", async ({ page }) => {
  await openWith(page, [fixture("kitchen-sink-final")]);
  await controlledBySW(page);
  const missing = await page.evaluate(async files => {
    const out = [];
    for (const f of files) {
      const hit = await caches.match(new URL(f, location.href).href, { ignoreSearch: true });
      if (!hit || !hit.ok) out.push(f);
    }
    return out;
  }, PRECACHE);
  expect(missing, "precached files missing from Cache Storage").toEqual([]);
});

test("with the network off, the service worker serves every app file", async ({ page, context, browserName }) => {
  test.skip(browserName === "webkit", OFFLINE_SKIP);
  await openWith(page, [fixture("kitchen-sink-final")]);
  await controlledBySW(page);
  await context.setOffline(true);
  // Fetched from inside the page, so each request goes through sw.js exactly
  // as the files of an offline launch would.
  const results = await page.evaluate(async files => Promise.all(files.map(async f => {
    try { const r = await fetch(f); return [f, r.status]; }
    catch (e) { return [f, String(e)]; }
  })), PRECACHE);
  expect(results.filter(([, status]) => status !== 200), "files not served offline").toEqual([]);
});

test("reopens offline from the service worker cache", async ({ page, context, browserName }) => {
  test.skip(browserName === "webkit", OFFLINE_SKIP);
  const errors = watchErrors(page);
  await openWith(page, [fixture("kitchen-sink-final")]);
  await controlledBySW(page);

  await context.setOffline(true);
  await page.reload();
  await waitForApp(page);
  await expect(page.locator("#sheet")).toBeVisible();
  await expect(page.locator("#workspace-tabs .ws-tab", { hasText: "QA Kitchen Sink" })).toBeVisible();
  // Offline, the auth probe can't reach the server; that's a handled failure.
  expect(errors.filter(e => !/auth\/me\.php|Failed to load resource|ERR_INTERNET_DISCONNECTED|NetworkError|network connection/i.test(e)))
    .toEqual([]);
});
