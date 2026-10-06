// Drones on the Rigging tab: what ticking Active does, and what the card shows.
const { test, expect } = require("@playwright/test");
const { fixture, watchErrors, expectNoErrors, openWith, domClick } = require("./helpers");

function character() {
  const c = fixture("kitchen-sink-final");
  c.play.purchases.drones = [{ name: "Bug-Spy", weapons: [], mods: [] }];
  return c;
}

test("ticking Active applies a drone's bonus straight away, and the card shows its effect", async ({ page }) => {
  const errors = watchErrors(page);
  await openWith(page, [character()]);
  const read = () => page.evaluate(() => ({
    init: CALC.initiative.dice,
    obs: CALC.skills.Observation.dice_bonus || 0,
    recon: CALC.skills.Reconnaissance.dice_bonus || 0,
  }));
  const before = await read();

  await domClick(page.locator(".sh-tabs button", { hasText: /rigging/i }));
  const card = page.locator(".sh-unit", { hasText: "Bug-Spy" }).first();
  await expect(card.locator(".sh-unit-effect")).toContainText("+1d Observation/Reconnaissance. +2d Initiative.");

  // Bug-Spy: "+1d Observation/Reconnaissance. +2d Initiative." Nothing else is
  // touched, so this only passes if the toggle itself re-runs the engine.
  await domClick(card.locator("label.opt", { hasText: "Active" }).locator("input"));
  await expect.poll(read).toEqual({ init: before.init + 2, obs: before.obs + 1, recon: before.recon + 1 });

  await domClick(page.locator(".sh-unit", { hasText: "Bug-Spy" }).first()
    .locator("label.opt", { hasText: "Active" }).locator("input"));
  await expect.poll(read).toEqual(before);
  expectNoErrors(errors);
});

// ---- Swap for drone/vehicle attachments ------------------------------------
function swapCharacter() {
  const c = fixture("kitchen-sink-final");
  c.play.purchases.drones = [
    { name: "Dog-Patrol Drone", weapons: ["Sentry Gun"], mods: [{ name: "Extended Magazine", weapon: 0 }, "Armor"] },
    { name: "Tracked-Patrol Drone", weapons: ["Missile Launcher"], mods: [] },
  ];
  c.play.rigging = { ...(c.play.rigging || {}),
    units: { "drones:0": { inertia: 0, physical: 0, integrity: 0, guns: { 0: { loaded: 7 } } } } };
  return c;
}
const unitState = page => page.evaluate(() => allDrones().map(d =>
  ({ name: d.name, weapons: d.weapons, mods: d.mods, stowed: d.stowed || [] })));

async function openModify(page, drone) {
  await domClick(page.locator(".sh-tabs button", { hasText: /rigging/i }));
  await domClick(page.locator(".sh-unit", { hasText: drone }).first().getByRole("button", { name: "Modify" }));
  await expect(page.locator(".mount-modal")).toHaveCount(1);
}
// Click a button in the topmost dialog's row whose label starts with `label`.
async function pick(page, label, button) {
  const dlg = page.locator(".mount-modal").last();
  await domClick(dlg.locator(".sh-modswap-row", { has: page.locator("b", { hasText: label }) })
    .getByRole("button", { name: button }));
}

test("Swap moves drone weapons (with their mods and magazine) and stows what comes off", async ({ page }) => {
  const errors = watchErrors(page);
  await openWith(page, [swapCharacter()]);
  const cash = await page.evaluate(() => CHAR.play.cash);

  // Dog-Patrol's Sentry Gun ⇄ the Tracked-Patrol's Missile Launcher (both ground
  // drones: a Sentry Gun can't go on a flying one).
  await openModify(page, "Dog-Patrol Drone");
  const modal = page.locator(".mount-modal").first();
  await domClick(modal.locator(".sub", { hasText: "Sentry Gun" }).getByRole("button", { name: "⇄ Swap" }).first());
  await expect(page.locator(".mount-modal")).toHaveCount(2);
  await pick(page, "Missile Launcher", "Fit");
  await expect(page.locator(".mount-modal")).toHaveCount(1);
  let s = await unitState(page);
  expect(s[0].weapons).toEqual(["Missile Launcher"]);
  expect(s[0].stowed).toEqual([{ kind: "weapon", name: "Sentry Gun", mods: ["Extended Magazine"], gun: { loaded: 7 } }]);
  expect(s[1].weapons).toEqual([]);

  // Its one hard point is full: fitting into free space is refused.
  await domClick(modal.getByRole("button", { name: "Fit an owned weapon…" }));
  await expect(page.locator(".mount-modal").last()).toContainText("no free hard point");
  await expect(page.locator(".mount-modal").last().getByRole("button", { name: "Fit" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Unit mod: Armor comes off into the stowed list.
  await domClick(modal.locator(".sub", { hasText: "Armor" }).getByRole("button", { name: "⇄ Swap" }).last());
  await pick(page, "Leave empty", "Stow");
  s = await unitState(page);
  expect(s[0].mods).toEqual([]);
  expect(s[0].stowed.map(i => i.name)).toEqual(["Sentry Gun", "Armor"]);
  await page.keyboard.press("Escape");
  await expect(page.locator(".mount-modal")).toHaveCount(0);

  // Tracked-Patrol fits the stowed Sentry Gun; its mod and magazine come along.
  await openModify(page, "Tracked-Patrol Drone");
  await domClick(page.locator(".mount-modal").getByRole("button", { name: "Fit an owned weapon…" }));
  await pick(page, "Sentry Gun", "Fit");
  s = await unitState(page);
  expect(s[1].weapons).toEqual(["Sentry Gun"]);
  expect(s[1].mods).toEqual([{ name: "Extended Magazine", weapon: 0 }]);
  expect(s[0].stowed.map(i => i.name)).toEqual(["Armor"]);
  expect(await page.evaluate(() => CHAR.play.rigging.units["drones:1"].guns[0])).toEqual({ loaded: 7 });

  // The Rigging card lists what's stowed; nothing was bought or sold.
  await page.keyboard.press("Escape");
  await expect(page.locator(".sh-unit", { hasText: "Dog-Patrol Drone" }).first()).toContainText("Stowed: Armor");
  expect(await page.evaluate(() => CHAR.play.cash)).toBe(cash);
  expect(await page.evaluate(() => CALC.errors)).toEqual([]);
  expectNoErrors(errors);
});

test("the die roller has a New Round button that refills pools", async ({ page }) => {
  const errors = watchErrors(page);
  await openWith(page, [fixture("kitchen-sink-final")]);
  const used = () => page.evaluate(() => POOL_ORDER.map(p => poolState(p).used));
  await page.evaluate(() => { poolState(POOL_ORDER[0]).setUsed(2); CHAR.play.actions_used = { simple: 1 }; });
  await domClick(page.locator(".sh-roller-fab"));
  await domClick(page.locator("#die-roller").getByRole("button", { name: "↻ New Round" }));
  expect((await used()).every(n => n === 0)).toBe(true);
  expect(await page.evaluate(() => CHAR.play.actions_used)).toEqual({});
  await expect(page.locator("#die-roller .sh-roller")).toBeVisible();   // roller stays open
  expectNoErrors(errors);
});

test("a weapon that can't go on aerial units is refused on a flying drone", async ({ page }) => {
  const errors = watchErrors(page);
  const c = fixture("kitchen-sink-final");
  c.play.purchases.drones = [
    { name: "Orb", weapons: [], mods: [], stowed: [{ kind: "weapon", name: "Sentry Gun", mods: [] }] },
    { name: "Dog-Patrol Drone", weapons: [], mods: [] },
  ];
  await openWith(page, [c]);
  // Fitting it in the Swap dialog: shown with the reason, no Fit button.
  await openModify(page, "Orb");
  await expect(page.locator(".mount-modal").getByRole("button", { name: "Fit an owned weapon…" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  // ...while the ground drone can take it.
  await openModify(page, "Dog-Patrol Drone");
  await domClick(page.locator(".mount-modal").getByRole("button", { name: "Fit an owned weapon…" }));
  await pick(page, "Sentry Gun", "Fit");
  expect(await page.evaluate(() => allDrones()[1].weapons)).toEqual(["Sentry Gun"]);
  await page.keyboard.press("Escape");
  // Buying it for the Orb from the Add weapon list is refused too.
  await openModify(page, "Orb");
  page.once("dialog", d => { expect(d.message()).toContain("cannot be mounted on an aerial unit"); d.accept(); });
  const dlg = page.locator(".mount-modal");
  await domClick(dlg.locator(".cat-head", { hasText: "Ballistic" }).first());
  await domClick(dlg.locator(".cat-item", { has: page.locator("b", { hasText: /^Sentry Gun$/ }) })
    .locator(".btn-add").first());
  expect(await page.evaluate(() => allDrones()[0].weapons)).toEqual([]);
  // And a save that already has one is flagged.
  await page.evaluate(async () => { allDrones()[0].weapons.push("Sentry Gun"); await recalc(); });
  expect(await page.evaluate(() => CALC.errors)).toContain("Orb: Sentry Gun cannot be mounted on an aerial unit.");
  expectNoErrors(errors);
});
