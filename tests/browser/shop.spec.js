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
