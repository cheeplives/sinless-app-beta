// Shared setup for the cross-browser specs.
const fs = require("fs");
const path = require("path");
const { expect } = require("@playwright/test");

const FIXTURE_DIR = path.join(__dirname, "..", "..", "docs", "qa", "fixtures");
const ALL_FIXTURES = fs.readdirSync(FIXTURE_DIR)
  .filter(f => f.endsWith(".json")).map(f => f.replace(/\.json$/, "")).sort();

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name + ".json"), "utf8"));
}

// Same rule as STORAGE.sanitizeName in static/storage.js.
function slug(name) {
  return String(name || "").trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "unnamed";
}

/* Collect everything that would show up red in a devtools console. Attach
 * before navigating; assert with expectNoErrors() at the end of the test. */
function watchErrors(page) {
  const errors = [];
  page.on("pageerror", e => errors.push(`pageerror: ${e.message}`));
  page.on("console", m => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  return errors;
}
function expectNoErrors(errors) {
  expect(errors, "page errors / console errors").toEqual([]);
}

/* Open the app with these characters already saved and open as tabs, the
 * first one active. Runs only on the first load of the page so a test can
 * reload and see what the app itself persisted. The WebKit storage tip is
 * pre-dismissed unless a test asks for it (showStorageTip), so it can't sit
 * over whatever a WebKit run is trying to look at. */
async function openWith(page, chars = [], { extraStorage = {}, showStorageTip = false } = {}) {
  const entries = chars.map(c => [slug(c.name), c]);
  extraStorage = { ...(showStorageTip ? {} : { "sinless:webkit-storage-tip": "1" }), ...extraStorage };
  await page.addInitScript(([entries, extra]) => {
    if (location.protocol !== "http:") return;          // about:blank between navigations
    if (sessionStorage.getItem("__seeded")) return;
    sessionStorage.setItem("__seeded", "1");
    localStorage.clear();
    for (const [key, c] of entries) localStorage.setItem("sinless:char:" + key, JSON.stringify(c));
    if (entries.length)
      localStorage.setItem("sinless:workspace", JSON.stringify({ open: entries.map(e => e[0]), active: 0 }));
    for (const [k, v] of Object.entries(extra)) localStorage.setItem(k, v);
  }, [entries, extraStorage]);
  await page.goto("index.html");
  await waitForApp(page);
}

async function waitForApp(page) {
  // boot() is async; the workspace strip is drawn once the active tab is up.
  await expect(page.locator("#workspace-tabs .ws-tab").first()).toBeVisible();
}

/* Click by DOM rather than by pointer: the floating theme controls and sticky
 * bars legitimately overlap some tabs at phone widths, and these tests are
 * about what the click does, not about hit-testing. */
async function domClick(locator) {
  await locator.evaluate(e => e.click());
}

async function openMenu(page) {
  await domClick(page.locator(".sh-menu-btn").first());
  await expect(page.locator(".sh-menu-panel")).toBeVisible();
}

module.exports = { ALL_FIXTURES, fixture, slug, watchErrors, expectNoErrors,
                   openWith, waitForApp, domClick, openMenu };
