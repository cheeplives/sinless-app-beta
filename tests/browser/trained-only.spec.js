// Skills that cannot be used unskilled (RULES.TRAINED_ONLY_SKILLS) carry a "Needs training" book icon whose kit
// tooltip says so. It has to open by keyboard focus as well as hover and tap, since a phone can't hover.
const { test, expect } = require("@playwright/test");
const { fixture, watchErrors, expectNoErrors, openWith, domClick } = require("./helpers");

test("chargen marks trained-only skills, and focusing the marker shows the unskilled rule", async ({ page }) => {
  const errors = watchErrors(page);
  await openWith(page, [fixture("fresh-default")]);
  await domClick(page.locator("#tabs button", { hasText: /skills/i }).first());
  const row = page.locator("tr", { has: page.locator(".skill-name-line", { hasText: "Cybertech Combat" }) });
  const chip = row.locator(".skill-to-chip");
  await expect(chip).toHaveAttribute("aria-label", "Needs training");
  await expect(chip.locator("svg.ico-book")).toBeVisible();
  await expect(chip).toHaveAttribute("data-tip", /Cannot be used unskilled/);
  // A skill anyone can attempt carries no marker.
  await expect(page.locator("tr", { has: page.locator(".skill-name-line", { hasText: /^Athletics/ }) })
    .locator(".skill-to-chip")).toHaveCount(0);
  await page.keyboard.press("Shift");          // after a key press, focus counts as :focus-visible
  await chip.focus();
  await expect(page.locator("#tipbox")).toHaveText(/Cannot be used unskilled/);
  expectNoErrors(errors);
});
