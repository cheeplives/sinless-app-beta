// Augment quality tiers move Etiquette, and gear bonuses don't stack: a
// character takes the best gear bonus per etiquette (plus the worst penalty).
const { test, expect } = require("@playwright/test");
const { fixture, watchErrors, expectNoErrors, openWith, domClick } = require("./helpers");

test("quality tiers set Etiquette; gear takes the best bonus, not the sum", async ({ page }) => {
  const errors = watchErrors(page);
  const c = fixture("kitchen-sink-final");          // Street 2 bought
  c.play.cash = 500000;
  c.play.purchases.augments = [{ name: "Techhair", count: 1 }, { name: "Skinwatch", count: 1 }];
  await openWith(page, [c]);
  page.on("dialog", d => d.accept());
  await domClick(page.locator(".sh-tabs button", { hasText: /augments/i }));

  const setQuality = async (aug, tier) => {
    const sel = page.locator("tr", { has: page.locator("td b", { hasText: new RegExp(`^${aug}$`) }) })
      .locator(".fw-quality-select");
    await sel.selectOption(tier);
    // A pricier tier is a purchase and asks its price (#108); a cheaper one is
    // a refund and doesn't. Take the asked price at list.
    const ask = page.locator(".mount-modal");
    await ask.waitFor({ timeout: 1000 }).catch(() => {});
    if (await ask.count()) await domClick(ask.getByRole("button", { name: /^Buy/ }));
    await expect.poll(() => page.evaluate(n =>
      allAugmentsOwned().find(a => a.name === n).quality || "", aug)).toBe(tier);
  };
  const final = () => page.evaluate(() => CALC.etiquette_points.final);

  // The picker says what each tier does.
  await expect(page.locator("tr", { has: page.locator("td b", { hasText: /^Techhair$/ }) })
    .locator(".fw-quality-select option", { hasText: "Bespoke" })).toContainText("+2 Street and Aristocratic Etiquette");

  await setQuality("Techhair", "Excellent");
  expect(await final()).toMatchObject({ Street: 4 });

  // A second Excellent piece doesn't add another +2: best gear source only.
  await setQuality("Skinwatch", "Excellent");
  expect((await final()).Street).toBe(4);

  // Bespoke: +2 Street and Aristocratic.
  await setQuality("Techhair", "Bespoke");
  expect(await final()).toMatchObject({ Street: 4, Aristocratic: 2 });

  // Ad Supported Skinwatch alongside it: +1 Wasteland, Street stays at the best
  // (+2), and its −4 Aristocratic still shows through (2 − 4, floored at 0).
  await setQuality("Skinwatch", "Ad Supported");
  expect(await final()).toMatchObject({ Street: 4, Wasteland: 1, Aristocratic: 0 });
  expect(await page.evaluate(() => CALC.etiquette_points.adjust.Aristocratic)).toBe(-2);

  // The sheet shows the penalty as a penalty.
  const sources = await page.evaluate(() => CALC.etiquette_sources.map(s => `${s.label} ${signed(s.bonus)}`));
  expect(sources).toContain("Skinwatch (Ad Supported) -4");
  expect(sources).not.toContain("Skinwatch (Ad Supported) +-4");
  expectNoErrors(errors);
});
