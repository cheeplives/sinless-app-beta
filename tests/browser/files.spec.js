// Downloads and file pickers, through the real menus.
//
// Blob downloads are where engines differ most (Safari fails one whose URL is
// revoked too early; older Firefox ignored a click on a detached anchor), so
// every export the app offers is exercised and its file read back.
const fs = require("fs");
const { test, expect } = require("@playwright/test");
const { fixture, watchErrors, expectNoErrors, openWith, domClick, openMenu } = require("./helpers");

async function openFiles(page) {
  await openMenu(page);
  await domClick(page.getByRole("button", { name: "Files…" }));
  await expect(page.locator(".mount-modal")).toBeVisible();
}

async function download(page, trigger) {
  const [dl] = await Promise.all([page.waitForEvent("download"), trigger()]);
  expect(await dl.failure()).toBeNull();
  return { name: dl.suggestedFilename(), text: fs.readFileSync(await dl.path(), "utf8") };
}

test("Export JSON downloads the character, and Import JSON opens it again", async ({ page }) => {
  const errors = watchErrors(page);
  const char = fixture("kitchen-sink-final");
  await openWith(page, [char]);

  await openFiles(page);
  const out = await download(page, () => domClick(page.getByRole("button", { name: "Export JSON" })));
  expect(out.name).toBe(`${char.name}.json`);
  const exported = JSON.parse(out.text);
  expect(exported.name).toBe(char.name);
  expect(exported.exported_with).toBeTruthy();

  // Re-import under a new name so it opens as a second tab.
  exported.name = "Round Trip";
  await openFiles(page);
  const chooser = page.waitForEvent("filechooser");
  await domClick(page.getByRole("button", { name: "Import JSON" }));
  await (await chooser).setFiles({ name: "round-trip.json", mimeType: "application/json",
                                   buffer: Buffer.from(JSON.stringify(exported)) });
  await domClick(page.getByRole("button", { name: "Open", exact: true }));
  await expect(page.locator("#workspace-tabs .ws-tab", { hasText: "Round Trip" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("sinless:char:Round-Trip"))).not.toBeNull();
  expectNoErrors(errors);
});

test("Export Markdown downloads the play sheet", async ({ page }) => {
  const errors = watchErrors(page);
  const char = fixture("kitchen-sink-final");
  await openWith(page, [char]);
  await openFiles(page);
  const out = await download(page,
    () => domClick(page.getByRole("button", { name: /Export Markdown/ })));
  expect(out.name).toMatch(/\.md$/);
  expect(out.text).toContain(char.name);
  expectNoErrors(errors);
});

test("Homebrew pack exports as a file", async ({ page }) => {
  const errors = watchErrors(page);
  page.on("dialog", d => d.accept("Test Pack"));     // the pack-name prompt()
  await openWith(page, [fixture("min-mundane")]);
  await openMenu(page);
  await domClick(page.getByRole("button", { name: "Homebrew" }));
  await domClick(page.getByRole("button", { name: "+ Create a pack" }));
  const out = await download(page, () => domClick(page.getByRole("button", { name: "Export File" })));
  expect(out.name).toBe("sinless-homebrew-Test-Pack.json");
  expect(JSON.parse(out.text)).toMatchObject({ format: "sinless-homebrew", name: "Test Pack" });
  expectNoErrors(errors);
});
