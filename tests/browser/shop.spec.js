// The Buy dialog's price adjustment: ±% per basket line, or for the whole basket.
const { test, expect } = require("@playwright/test");
const { fixture, watchErrors, expectNoErrors, openWith, domClick } = require("./helpers");

async function addToBasket(page, name) {
  const dlg = page.locator(".mount-modal");
  await dlg.locator(".sh-shop-search").fill(name);
  await domClick(dlg.locator(".cat-item", { has: page.locator("b", { hasText: new RegExp(`^${name}$`) }) })
    .locator(".btn-add").first());
  await dlg.locator(".sh-shop-search").fill("");
}
const listPrice = (page, name) => page.evaluate(n =>
  Math.round(+(DATA.tables.weapons.find(w => w.Weapon === n) || {}).Cost || 0), name);

test("a basket line's price can be adjusted by a percentage, and the ledger says so", async ({ page }) => {
  const errors = watchErrors(page);
  const c = fixture("kitchen-sink-final");
  c.play.cash = 100000;
  await openWith(page, [c]);
  await domClick(page.locator(".sh-tabs button", { hasText: /gear/i }));
  await domClick(page.locator(".sh-shop-open").first());
  const dlg = page.locator(".mount-modal");
  await expect(dlg).toBeVisible();

  await addToBasket(page, "Katana");
  await addToBasket(page, "Kalishnikov A-80");
  const katana = await listPrice(page, "Katana");
  const ak = await listPrice(page, "Kalishnikov A-80");
  const line = name => dlg.locator(".sh-shop-line", { hasText: name });

  // −20% on the Katana only.
  await line("Katana").locator(".sh-shop-adjust input").fill("-20");
  const katanaPaid = Math.round(katana * 0.8);
  await expect(line("Katana").locator(".sh-shop-listprice")).toBeVisible();
  await expect(dlg.locator(".sh-shop-totals b")).toContainText(
    await page.evaluate(n => fmt(n), katanaPaid + ak));

  // The whole-basket figure overrides every line…
  const all = dlg.locator(".sh-shop-adjust-all input");
  await all.fill("50");
  await expect(dlg.locator(".sh-shop-totals b")).toContainText(
    await page.evaluate(n => fmt(n), Math.round(katana * 1.5) + Math.round(ak * 1.5)));
  // …and a line can still be set on its own afterwards. Typed, then straight
  // to Buy with a real click while the field still has focus: the click must
  // land (the prices repaint in place, so Buy isn't rebuilt under it).
  await line("Katana").locator(".sh-shop-adjust input").fill("");   // focused and empty
  await page.keyboard.type("-20");

  const cash = await page.evaluate(() => CHAR.play.cash);
  await dlg.locator(".sh-shop-buttons .btn-add").click();
  await expect(dlg).toHaveCount(0);
  expect(await page.evaluate(() => CHAR.play.cash)).toBe(cash - katanaPaid - Math.round(ak * 1.5));
  const log = await page.evaluate(() => CHAR.play.cash_log.slice(0, 2).map(e => [e.label, e.delta]));
  expect(log).toContainEqual(["Bought Katana (−20%)", -katanaPaid]);
  expect(log).toContainEqual(["Bought Kalishnikov A-80 (+50%)", -Math.round(ak * 1.5)]);
  expectNoErrors(errors);
});

test("augments can be bought at α-cyber grade: ZR reduced, price doubled, Undo matches the grade", async ({ page }) => {
  const errors = watchErrors(page);
  const c = fixture("kitchen-sink-final");
  c.play.cash = 200000;
  await openWith(page, [c]);
  await domClick(page.locator(".sh-tabs button", { hasText: /augments/i }));
  await domClick(page.locator(".sh-shop-open").first());
  const dlg = page.locator(".mount-modal");
  const add = async name => {
    await dlg.locator(".sh-shop-search").fill(name);
    await domClick(dlg.locator(".cat-item", { has: page.locator("b", { hasText: new RegExp(`^${name}$`) }) })
      .locator(".btn-add").first());
    await dlg.locator(".sh-shop-search").fill("");
  };
  const price = (name, alpha) => page.evaluate(([n, a]) => {
    const r = DATA.tables.augments.find(x => x.Name === n);
    return Math.round(RULES.augmentEffCost(r, { alpha: a })
      * RULES.surchargeFor("cyberware", CALC.budget.gear_cost_multiplier || 1));
  }, [name, alpha]);
  const std = await price("Commlink", false), alpha = await price("Commlink", true);
  expect(alpha).toBe(std * 2);

  await add("Commlink");
  await add("Augmented Eyesight");
  // No ZR, nothing for α-grade to reduce: no option on that line.
  await expect(dlg.locator(".sh-shop-line", { hasText: "Augmented Eyesight" }).locator(".sh-shop-toggle")).toHaveCount(0);
  await domClick(dlg.locator(".sh-shop-line", { hasText: "Augmented Eyesight" }).locator(".row-del"));

  const line = dlg.locator(".sh-shop-line", { hasText: "Commlink" });
  await domClick(line.locator(".sh-shop-toggle input"));
  await expect(line).toContainText("α-cyber · ZR 0.2 (std 0.3)");
  await expect(line.locator(".cat-cost")).toContainText(await page.evaluate(n => fmt(n), alpha));
  // A plain add of the same augment afterwards is its own (standard) line.
  await add("Commlink");
  await expect(dlg.locator(".sh-shop-line", { hasText: "Commlink" })).toHaveCount(2);

  const zrBefore = await page.evaluate(() => CALC.zoetics.cyber_zr);
  const cash = await page.evaluate(() => CHAR.play.cash);
  await dlg.locator(".sh-shop-buttons .btn-add").click();
  await expect(dlg).toHaveCount(0);
  expect(await page.evaluate(() => CHAR.play.cash)).toBe(cash - alpha - std);
  const owned = await page.evaluate(() => CHAR.play.purchases.augments.filter(a => a.name === "Commlink"));
  expect(owned).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "Commlink", alpha: true }),
    expect.not.objectContaining({ alpha: true })]));
  expect(await page.evaluate(() => CALC.zoetics.cyber_zr)).toBeCloseTo(zrBefore + 0.2 + 0.3, 5);

  // Undo the α purchase: the α entry goes, the standard one stays, the α price comes back.
  page.once("dialog", d => d.accept());           // "Undo …?" confirm
  await page.evaluate(() => undoCashSpend(CHAR.play.cash_log.find(e => /Installed Commlink \(α-cyber\)/.test(e.label))));
  await expect.poll(() => page.evaluate(() =>
    CHAR.play.purchases.augments.filter(a => a.name === "Commlink").map(a => !!a.alpha))).toEqual([false]);
  expect(await page.evaluate(() => CHAR.play.cash)).toBe(cash - std);
  expectNoErrors(errors);
});
