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
