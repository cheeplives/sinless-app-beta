// #109: a familiar picked at the top of the Magic tab gives its bonus dice.
const { test, expect } = require("@playwright/test");
const { fixture, watchErrors, expectNoErrors, openWith, domClick, waitForApp } = require("./helpers");

const dice = (page, skill) => page.evaluate(s => CALC.skills[s].dice_bonus || 0, skill);

test("picking a familiar in play applies its dice, and a night-only familiar waits for its toggle", async ({ page }) => {
  const errors = watchErrors(page);
  await openWith(page, [fixture("kitchen-sink-final")]);   // a finalized Mage
  await domClick(page.locator(".sh-tabs button", { hasText: /magic/i }));
  const card = page.locator(".familiar-card");
  const pick = name => card.locator("select").selectOption(name);
  const base = { shadow: await dice(page, "Shadow"), subterfuge: await dice(page, "Subterfuge"),
                 sorcery: await dice(page, "Sorcery"), biotech: await dice(page, "Biotech") };

  await pick("Shadow Cat");
  await expect.poll(() => dice(page, "Shadow")).toBe(base.shadow + 1);
  expect(await dice(page, "Subterfuge")).toBe(base.subterfuge + 1);
  await expect(page.locator(".familiar-card select")).toHaveAttribute("title", /plane of shadows/);
  await expect(page.locator(".familiar-effect")).toContainText("+1 Kismet");

  // Moon Moth: Resolve-pool dice, but only at night.
  await pick("Moon Moth");
  await expect.poll(() => dice(page, "Shadow")).toBe(base.shadow);
  expect(await dice(page, "Sorcery")).toBe(base.sorcery);
  await domClick(page.locator(".familiar-card label.opt input"));
  await expect.poll(() => dice(page, "Sorcery")).toBe(base.sorcery + 2);
  expect(await dice(page, "Subterfuge")).toBe(base.subterfuge + 2);   // Subterfuge is a Resolve skill

  // Ash Phoenix: +2d on every trained-only skill, ranks or not.
  await page.locator(".familiar-card select").selectOption("Ash Phoenix");
  await expect.poll(() => dice(page, "Biotech")).toBe(base.biotech + 2);
  expect(await dice(page, "Sorcery")).toBe(base.sorcery + 2);
  expect(await dice(page, "Shadow")).toBe(base.shadow);

  // It is saved with the character.
  await page.waitForTimeout(800);
  await page.reload(); await waitForApp(page);
  expect(await page.evaluate(() => CHAR.play.familiar)).toBe("Ash Phoenix");
  expect(await dice(page, "Biotech")).toBe(base.biotech + 2);
  expectNoErrors(errors);
});

test("a Shadow Cat grants a Kismet when time passes, and Undo takes it back", async ({ page }) => {
  const errors = watchErrors(page);
  const c = fixture("kitchen-sink-final");
  c.play.familiar = "Shadow Cat";
  c.play.calendar = { start: { month: 1, year: 2080 }, months_elapsed: 0, entries: [] };
  await openWith(page, [c]);
  const k = await page.evaluate(() => CHAR.play.kismet);
  // The month's own dialog answered in advance: nothing bought, no missions.
  await page.evaluate(async () => {
    window.promptTimePasses = async () => ({ missions: "", sector_actions: "", awards: [], ammo: [],
      lifestyle: { action: "none", name: (CHAR.play.lifestyles[0] || {}).name || "Street" } });
    await runTimePasses();
  });
  expect(await page.evaluate(() => CHAR.play.kismet)).toBe(k + 1);
  expect(await page.evaluate(() => CHAR.play.kismet_log[0].label)).toContain("Shadow Cat");
  page.on("dialog", d => d.accept());
  await page.evaluate(async () => { await undoCalendarEntry(CHAR.play.calendar.entries[0]); });
  expect(await page.evaluate(() => CHAR.play.kismet)).toBe(k);
  expectNoErrors(errors);
});
