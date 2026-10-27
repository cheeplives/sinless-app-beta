// #110: the "Clothing/Armor Ignored" house rule leaves worn armor out of ZR.
const { test, expect } = require("@playwright/test");
const { fixture, watchErrors, expectNoErrors, openWith } = require("./helpers");

test("worn armor's ZR counts under Classic and not under Clothing/Armor Ignored", async ({ page }) => {
  const errors = watchErrors(page);
  const c = fixture("kitchen-sink-final");
  c.play.purchases.armor = [{ name: "Battle Armor", extras: ["Thermoweave"] }];   // ZR 2, +1 for the Extra
  // ZR Casting Penalty on too, so the gear ZR shows up as dice on Sorcery.
  c.house_rules = { ...(c.house_rules || {}), armor_zr: "classic", zr: "houserule" };
  await openWith(page, [c]);
  const read = () => page.evaluate(() => ({ gear: CALC.zoetics.gear_zr,
    note: (CALC.skills.Sorcery.notes || []).find(n => /on casting rolls/.test(n)) || "" }));
  const classic = await read();
  expect(classic.note).toContain(`gear/weapon ZR ${classic.gear}`);

  await page.evaluate(async () => { RULES.setHouseRule("armor_zr", "houserule"); await recalc(); });
  const ignored = await read();
  expect(classic.gear - ignored.gear).toBeCloseTo(3, 5);   // Battle Armor's 2, +1 for the Extra
  expect(ignored.note).not.toBe(classic.note);
  expectNoErrors(errors);
});
