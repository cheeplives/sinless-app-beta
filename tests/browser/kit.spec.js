// The shared UI kit (static/kit.js, the same file as Campaign Chronicle's): the ☰ character menu is a KIT.menu, and
// every title el() is given becomes a kit tooltip. The actions behind the menu's rows have their own specs (files,
// sharing); this one is about the menu and the tooltips behaving the same in every engine.
const { test, expect } = require("@playwright/test");
const { fixture, watchErrors, expectNoErrors, openWith, domClick, openMenu } = require("./helpers");

test("the ☰ menu opens on screen, closes on Escape with focus back on its button, and closes on a click elsewhere", async ({ page }) => {
  const errors = watchErrors(page);
  await openWith(page, [fixture("min-mundane")]);
  await openMenu(page);
  const list = page.locator(".sh-menu .sh-menu-panel");
  const box = await list.boundingBox(), vp = page.viewportSize();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
  await expect(list.getByRole("button", { name: "New" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(list).toBeHidden();
  expect(await page.evaluate(() => document.activeElement && document.activeElement.tagName)).toBe("SUMMARY");
  await openMenu(page);
  await domClick(page.locator("#panel"));
  await expect(list).toBeHidden();
  expectNoErrors(errors);
});

test("a title given to el() is a kit tooltip: no native title, and the tip box shows it on hover", async ({ page, isMobile }) => {
  await openWith(page, [fixture("min-mundane")]);
  expect(await page.locator("#app [title], #workspace-tabs [title]").count()).toBe(0);
  const tipped = page.locator("[data-tip]:visible").first();
  await expect(tipped).toBeVisible();
  // The kit shows a tip on hover only where the device can hover (a phone taps instead); headless Firefox says it can't.
  test.skip(isMobile || !(await page.evaluate(() => matchMedia("(hover: hover)").matches)), "hover needs a mouse");
  await tipped.hover();
  await expect(page.locator("#tipbox")).toHaveClass(/show/);
  await expect(page.locator("#tipbox")).toHaveText(await tipped.getAttribute("data-tip"));
});
