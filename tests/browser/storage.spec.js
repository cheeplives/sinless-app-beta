// Saving on the way out, and the engine-specific storage protections.
const { test, expect } = require("@playwright/test");
const { fixture, watchErrors, expectNoErrors, openWith, waitForApp } = require("./helpers");

test("an unsaved chargen draft survives leaving the page", async ({ page }) => {
  const errors = watchErrors(page);
  await openWith(page);
  await page.locator("#char-name").fill("Left Behind");
  // A real navigation away: beforeunload where the engine fires it, pagehide
  // everywhere (iOS Safari only ever sends the latter).
  await page.goto("about:blank");
  await page.goto("index.html");
  await waitForApp(page);
  await expect(page.locator("#workspace-tabs .ws-tab", { hasText: "Left Behind" })).toBeVisible();
  expectNoErrors(errors);
});

test("pagehide alone flushes open tabs to storage", async ({ page }) => {
  // The iOS case directly: no beforeunload at all, just pagehide.
  await openWith(page);
  await page.locator("#char-name").fill("Pagehide Only");
  expect(await page.evaluate(() => localStorage.getItem("sinless:char:Pagehide-Only"))).toBeNull();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false })));
  expect(await page.evaluate(() => localStorage.getItem("sinless:char:Pagehide-Only"))).not.toBeNull();
  const desc = JSON.parse(await page.evaluate(() => localStorage.getItem("sinless:workspace")));
  expect(desc.open).toContain("Pagehide-Only");
});

test("the 7-day-deletion tip shows on WebKit only, once", async ({ page, browserName }) => {
  const errors = watchErrors(page);
  await openWith(page, [fixture("min-mundane")], { showStorageTip: true });
  const tip = page.locator(".storage-tip");
  if (browserName !== "webkit") {
    // Chromium and Gecko don't delete storage on a timer; nothing to warn about.
    await expect(tip).toHaveCount(0);
    expectNoErrors(errors);
    return;
  }
  await expect(tip).toBeVisible();
  await expect(tip).toContainText("7 days");
  await tip.getByRole("button", { name: "Got it" }).click();
  await expect(tip).toHaveCount(0);
  await page.reload();
  await waitForApp(page);
  await expect(tip).toHaveCount(0);
  expectNoErrors(errors);
});

test("iOS: text fields are at least 16px so focusing one doesn't zoom", async ({ page, isMobile }) => {
  await openWith(page, [fixture("maxed-mage")]);
  const iosRuleApplies = await page.evaluate(() =>
    CSS.supports("-webkit-touch-callout", "none") && matchMedia("(max-width:940px)").matches);
  // Only an iOS build of WebKit understands -webkit-touch-callout; desktop
  // engines (and Playwright's Linux WebKit) must be left at the drawn sizes.
  const sizes = await page.evaluate(() =>
    [...document.querySelectorAll("input:not([type=checkbox]):not([type=radio]), select, textarea")]
      .filter(e => e.offsetParent).map(e => parseFloat(getComputedStyle(e).fontSize)));
  expect(sizes.length).toBeGreaterThan(0);
  if (iosRuleApplies) expect(Math.min(...sizes)).toBeGreaterThanOrEqual(16);
  else expect(Math.min(...sizes), "non-iOS layouts keep their compact fields").toBeLessThan(16);
  test.info().annotations.push({ type: "ios-rule", description: String(iosRuleApplies) + (isMobile ? " (mobile)" : "") });
});
