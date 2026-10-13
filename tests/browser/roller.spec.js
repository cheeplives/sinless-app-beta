// Dodge and soak rolls can't dial in more dice than their pool has left this
// round; and the Magic tab lists spells A–Z.
const { test, expect } = require("@playwright/test");
const { fixture, watchErrors, expectNoErrors, openWith, domClick } = require("./helpers");

const roller = page => page.locator("#die-roller .sh-roller");
const count = page => page.locator("#die-roller .sh-roller-count-input");
const plus = page => page.locator("#die-roller .sh-roller-step", { hasText: "+" }).first();

async function clickButton(page, text) {
  // The Dodge/Soak buttons live on the Overview's header tiles and cards; find
  // the one on screen by its label.
  await page.evaluate(t => {
    const b = [...document.querySelectorAll("button")].find(x => x.textContent.trim() === t);
    if (!b) throw new Error(`no button "${t}"`);
    b.click();
  }, text);
}

for (const [label, pool] of [["⚄ Dodge", "Finesse"], ["⚄ Soak", "Brawn"]]) {
  test(`${label.slice(2)} can't dial in more ${pool} than is left this round`, async ({ page }) => {
    const errors = watchErrors(page);
    // Unhurt: wound penalties cancel dialled dice before the pool is charged,
    // which would leave a die unspent and blur what this test is about.
    const c = fixture("kitchen-sink-final");
    c.play.physical_damage = 0; c.play.stun_damage = 0;
    await openWith(page, [c]);
    // Leave exactly 2 dice in the pool.
    await page.evaluate(p => { const ps = poolState(p); ps.setUsed(ps.max - 2); renderSheet(); }, pool);
    if (label === "⚄ Dodge") {
      // Dodge's roll button sits in its header tile's popover.
      await page.evaluate(() => {
        const face = [...document.querySelectorAll(".sh-box-face")].find(x => /dodge/i.test(x.textContent));
        if (face) face.click();
      });
    }
    await clickButton(page, label);
    await expect(roller(page)).toBeVisible();

    for (let i = 0; i < 5; i++) await domClick(plus(page));
    await expect(count(page)).toHaveValue("2");
    await expect(plus(page)).toBeDisabled();
    await expect(roller(page)).toContainText(`up to 2 — ${pool} left this round`);

    // Typing past it settles at the cap too.
    await count(page).fill("9");
    await expect(count(page)).toHaveValue("2");

    // Rolling spends the two; the next roll of the same kind has nothing to dial.
    await domClick(page.locator("#die-roller .sh-roller-roll"));
    expect(await page.evaluate(p => poolState(p).remaining, pool)).toBe(0);
    await expect(count(page)).toHaveValue("0");
    await expect(plus(page)).toBeDisabled();

    // A New Round refills the pool and lifts the cap with it.
    await domClick(page.locator("#die-roller").getByRole("button", { name: "↻ New Round" }));
    await domClick(plus(page));
    await expect(count(page)).toHaveValue("1");
    expectNoErrors(errors);
  });
}

test("a plain roll from the dice button isn't capped", async ({ page }) => {
  await openWith(page, [fixture("kitchen-sink-final")]);
  await page.evaluate(() => { const ps = poolState("Finesse"); ps.setUsed(ps.max); renderSheet(); });
  await domClick(page.locator(".sh-roller-fab"));
  await count(page).fill("9");
  await expect(count(page)).toHaveValue("9");
});

test("the Magic tab lists spells A–Z by name", async ({ page }) => {
  const errors = watchErrors(page);
  const c = fixture("kitchen-sink-final");                 // knows Create Barrier
  // Learned out of order: last alphabetically first, then the first.
  c.play.purchases.spells = [
    { name: "The Uncountable Tendrils of Ehon", force: 1 },
    { name: "Black Bolt of Uthal", force: 1 },
  ];
  await openWith(page, [c]);
  await domClick(page.locator(".sh-tabs button", { hasText: /magic/i }));
  const shown = await page.evaluate(() => {
    const card = [...document.querySelectorAll(".sh-card")]
      .find(x => x.querySelector("h3")?.textContent === "Spells");
    return [...card.querySelectorAll("b")].map(b => b.textContent.trim())
      .filter(n => DATA.tables.spells.some(s => s.Name === n));
  });
  expect(shown).toEqual(["Black Bolt of Uthal", "Create Barrier", "The Uncountable Tendrils of Ehon"]);
  expectNoErrors(errors);
});
