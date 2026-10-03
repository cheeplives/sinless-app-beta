// The PWA promise: once loaded, the app opens and works with no network.
const { test, expect } = require("@playwright/test");
const { fixture, watchErrors, openWith, waitForApp } = require("./helpers");

test.use({ serviceWorkers: "allow" });

test("reopens offline from the service worker cache", async ({ page, context }) => {
  const errors = watchErrors(page);
  await openWith(page, [fixture("kitchen-sink-final")]);
  // Wait until sw.js has installed (precache done) and controls this page.
  await page.evaluate(() => navigator.serviceWorker.ready);
  if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) {
    await page.reload();
    await waitForApp(page);
  }
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

  await context.setOffline(true);
  await page.reload();
  await waitForApp(page);
  await expect(page.locator("#sheet")).toBeVisible();
  await expect(page.locator("#workspace-tabs .ws-tab", { hasText: "QA Kitchen Sink" })).toBeVisible();
  // Offline, the auth probe can't reach the server; that's a handled failure.
  expect(errors.filter(e => !/auth\/me\.php|Failed to load resource|ERR_INTERNET_DISCONNECTED|NetworkError|network connection/i.test(e)))
    .toEqual([]);
});
