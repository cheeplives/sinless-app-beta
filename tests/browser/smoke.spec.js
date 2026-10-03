// Every screen renders in every engine without a script error.
//
// Each QA fixture is opened and every tab of whichever view it lands in
// (chargen for drafts, the play sheet for finalized characters) is visited.
// A parse error, a missing DOM/JS API or a CSS-driven layout throw in one
// engine shows up here as a page error.
const { test, expect } = require("@playwright/test");
const { ALL_FIXTURES, fixture, watchErrors, expectNoErrors, openWith, domClick } = require("./helpers");

test("boots to a blank character with no errors", async ({ page }) => {
  const errors = watchErrors(page);
  await openWith(page);
  await expect(page.locator("#tabs button").first()).toBeVisible();
  // theme-init.js ran before first paint
  await expect(page.locator("html")).toHaveAttribute("data-theme", /^(light|dark)$/);
  expectNoErrors(errors);
});

for (const name of ALL_FIXTURES) {
  test(`fixture ${name}: every tab renders`, async ({ page }) => {
    const errors = watchErrors(page);
    // hostile-payloads.json carries inert <img onerror> probes in every string;
    // none may ever execute, and nothing may open a dialog.
    page.on("dialog", d => { errors.push(`unexpected dialog: ${d.message()}`); d.dismiss(); });
    await openWith(page, [fixture(name)]);

    const inPlay = await page.locator("#sheet").isVisible();
    const tabs = page.locator(inPlay ? "#sheet .sh-tabs button" : "#tabs button");
    const count = await tabs.count();
    expect(count).toBeGreaterThan(3);
    for (let i = 0; i < count; i++) {
      const tab = tabs.nth(i);
      await domClick(tab);
      await expect(tab).toHaveClass(/active/);
      await expect(page.locator(inPlay ? "#sheet" : "#panel")).not.toBeEmpty();
    }
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    // Its probes include image URLs no browser can fetch; the refused load is
    // the expected outcome there, and each engine words it differently.
    expectNoErrors(name === "hostile-payloads"
      ? errors.filter(e => !/^console: (Failed to load resource|.*(not allowed|cannot load|ERR_))/i.test(e))
      : errors);
  });
}
