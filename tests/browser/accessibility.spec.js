// Text contrast (WCAG AA): axe-core finds no colour-contrast failure on any tab of character creation or of the play
// sheet, in light and dark mode, and in every accent the Settings menu offers. Only the contrast rule runs here; the
// rest of axe's rules are not yet a promise this app makes.
const { test, expect } = require("@playwright/test");
const { fixture, openWith, watchErrors, expectNoErrors, domClick } = require("./helpers");

// axe is injected as a script, which a Content Security Policy would refuse
test.use({ bypassCSP: true });

const AXE = require.resolve("axe-core/axe.min.js");
const TABS = "#sheet:not([hidden]) .sh-tabs > button, #app:not([hidden]) #tabs > *";

async function contrastFindings(page) {
  if (!(await page.evaluate(() => typeof window.axe !== "undefined"))) await page.addScriptTag({ path: AXE });
  const r = await page.evaluate(() => window.axe.run(document, { runOnly: { type: "rule", values: ["color-contrast"] } }));
  return r.violations.flatMap(v => v.nodes.map(n => {
    const d = (n.any[0] && n.any[0].data) || {};
    return `${n.target.join(" ")}  ${d.fgColor} on ${d.bgColor} = ${d.contrastRatio} (needs ${d.expectedContrastRatio})`;
  }));
}

// Every tab of the view this character opens in: chargen for a draft, the play sheet for a finalized one.
async function everyTab(page, name, mode, scheme) {
  await openWith(page, [fixture(name)], { extraStorage: { "sinless:theme": mode, "sinless:scheme": scheme } });
  await expect(page.locator("html")).toHaveAttribute("data-theme", mode);
  await expect(page.locator("html")).toHaveAttribute("data-scheme", scheme);
  const found = {};
  const n = await page.locator(TABS).count();
  expect(n).toBeGreaterThan(3);
  for (let i = 0; i < n; i++) {
    const tab = page.locator(TABS).nth(i);
    const label = (await tab.textContent()).trim();
    await domClick(tab);
    const v = await contrastFindings(page);
    if (v.length) found[label] = v;
  }
  return found;
}

const skipOthers = testInfo =>
  test.skip(testInfo.project.name !== "chromium", "the colours are the same in every browser: one is enough");

for (const mode of ["dark", "light"]) {
  for (const name of ["maxed-mage", "kitchen-sink-final"]) {
    test(`text contrast passes on every tab of ${name} in ${mode} mode`, async ({ page }, testInfo) => {
      skipOthers(testInfo);
      test.setTimeout(120_000);
      const errors = watchErrors(page);
      expect(await everyTab(page, name, mode, "default")).toEqual({});
      expectNoErrors(errors);
    });
  }
}

// The other accents change only the accent tokens, so the play sheet, which uses them most, stands for both views.
for (const scheme of ["azure", "ghost", "rose", "violet"]) {
  for (const mode of ["dark", "light"]) {
    test(`text contrast passes in the ${scheme} accent in ${mode} mode`, async ({ page }, testInfo) => {
      skipOthers(testInfo);
      test.setTimeout(120_000);
      const errors = watchErrors(page);
      expect(await everyTab(page, "kitchen-sink-final", mode, scheme)).toEqual({});
      expectNoErrors(errors);
    });
  }
}
