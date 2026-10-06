// Weapon mods in play: take one off without selling it, and move one between
// guns. No money changes hands; each gun keeps the mods it now owns.
const { test, expect } = require("@playwright/test");
const { fixture, watchErrors, expectNoErrors, openWith, domClick } = require("./helpers");

const X9 = "Federated Arms X-9mm";
const SC = 'Federated Arms 454 DA "Super Chief"';
const AK = "Kalishnikov A-80";

function character() {
  const c = fixture("kitchen-sink-final");
  c.play.cash = 10000;
  // The rifle has a mounted underbarrel launcher and an unmounted rifle-only Bi-pod.
  c.weapons[0].mods = ["Under-slung grenade launcher", "Bi-pod (Rifle Only)"];
  c.weapons[0].equipped_mods = ["Under-slung grenade launcher"];
  c.play.purchases.weapons = [
    { name: X9, mods: ["Laser Sight", "Silencer"], equipped: true, qty: 1 },
    { name: SC, mods: ["Imaging scope", "Laser Sight", "Extended Magazine"], equipped: true, qty: 1 },
  ];
  return c;
}

function slot(page, weapon, label) {
  const row = page.locator("tr", { has: page.locator("td b", { hasText: weapon }) })
    .filter({ has: page.locator("input[type=checkbox]") }).first();
  return row.locator("xpath=following-sibling::tr[1]").locator(".sh-modslot")
    .filter({ has: page.locator(".sh-modslot-label", { hasText: new RegExp(`^${label}$`) }) });
}
const mods = (page, weapon) => page.evaluate(n => {
  const w = allWeapons().find(x => x.name === n);
  return { owned: w.mods, mounted: w.equipped_mods || w.mods };
}, weapon);

// Open a slot's Swap dialog and press the button on the row named `label`.
async function swap(page, weapon, slotLabel, label, button = "Fit") {
  await domClick(slot(page, weapon, slotLabel).getByRole("button", { name: "⇄ Swap" }));
  const dlg = page.locator(".mount-modal");
  await expect(dlg).toBeVisible();
  await domClick(dlg.locator(".sh-modswap-row", { has: page.locator("b", { hasText: new RegExp(`^${label.replace(/[()]/g, "\\$&")}$`) }) })
    .getByRole("button", { name: button }));
  await expect(dlg).toHaveCount(0);
}
async function choicesIn(page, weapon, slotLabel) {
  await domClick(slot(page, weapon, slotLabel).getByRole("button", { name: "⇄ Swap" }));
  const dlg = page.locator(".mount-modal");
  const names = await dlg.locator(".sh-modswap-row b").allInnerTexts();
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);
  return names;
}

test("Swap takes mods off without selling, and moves them between guns", async ({ page }) => {
  const errors = watchErrors(page);
  await openWith(page, [character()]);
  await domClick(page.locator(".sh-tabs button", { hasText: /gear/i }));
  const cash = await page.evaluate(() => CHAR.play.cash);

  // A gun that already owns a mod isn't offered another copy; a rifle-only
  // mod isn't offered to a pistol.
  expect(await choicesIn(page, SC, "Overbarrel")).not.toContain("Laser Sight");
  expect(await choicesIn(page, X9, "Underbarrel")).not.toContain("Bi-pod (Rifle Only)");

  // Move: the Super Chief's Extended Magazine onto the X-9mm's empty chassis.
  await swap(page, X9, "Chassis", "Extended Magazine");
  expect((await mods(page, X9)).mounted).toContain("Extended Magazine");
  expect((await mods(page, SC)).owned).not.toContain("Extended Magazine");
  expect(await page.evaluate(n => CALC.weapons.find(w => w.Weapon === n).Ammo, X9)).toBe(16);

  // Leave empty: the Silencer comes off the X-9mm but stays owned.
  await swap(page, X9, "Underbarrel", "Leave empty", "Unmount");
  const x9 = await mods(page, X9);
  expect(x9.owned).toContain("Silencer");
  expect(x9.mounted).not.toContain("Silencer");

  // ...and can go on the Super Chief, whose Laser Sight comes off but stays.
  await swap(page, SC, "Underbarrel", "Silencer");
  const sc = await mods(page, SC);
  expect(sc.mounted).toContain("Silencer");
  expect(sc.owned).toContain("Laser Sight");
  expect(sc.mounted).not.toContain("Laser Sight");
  expect((await mods(page, X9)).owned).not.toContain("Silencer");

  // An unmounted launcher grants no underbarrel weapon; re-fitting restores it.
  const ub = () => page.evaluate(() => underbarrelWeapons().length);
  expect(await ub()).toBe(1);
  await swap(page, AK, "Underbarrel", "Leave empty", "Unmount");
  expect(await ub()).toBe(0);
  await swap(page, AK, "Underbarrel", "Under-slung grenade launcher");
  expect(await ub()).toBe(1);

  expect(await page.evaluate(() => CHAR.play.cash)).toBe(cash);
  expect(await page.evaluate(() => CALC.errors)).toEqual([]);
  expectNoErrors(errors);
});
