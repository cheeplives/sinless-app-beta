// The members' gallery of shared characters, reached from the ☰ menu.
//
// There is no PHP backend in the test server, so the API is answered here:
// a signed-in member (id 7, "Me") who owns one shared character, plus one
// shared by somebody else.
const { test, expect } = require("@playwright/test");
const { fixture, watchErrors, expectNoErrors, waitForApp, domClick, openMenu } = require("./helpers");

function mine() { const c = fixture("kitchen-sink-final"); c.name = "My Runner"; return c; }
function theirs() { const c = fixture("rigger-drones"); c.name = "Their Runner"; return c; }

async function signedIn(page) {
  const json = (route, body, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/**", route => {
    const url = new URL(route.request().url());
    const p = url.pathname, q = url.searchParams;
    if (p.endsWith("auth/me.php"))
      return json(route, { id: 7, name: "Me", display_name: "Me", email: "me@example.test",
                           status: "approved", is_admin: false, csrf: "t" });
    if (p.endsWith("characters.php")) {
      if (q.get("public") === "1")
        return json(route, { characters: [
          { id: 1, name: "My Runner", owner: "Me" },
          { id: 2, name: "Their Runner", owner: "Someone Else" }] });
      if (q.get("public_id"))
        return json(route, q.get("public_id") === "1"
          ? { id: 1, owner: "Me", name: "My Runner", data: mine() }
          : { id: 2, owner: "Someone Else", name: "Their Runner", data: theirs() });
      if (q.get("slug"))
        return json(route, { slug: q.get("slug"), client_updated_at: 1, data: mine() });
      if (route.request().method() === "GET")
        return json(route, { characters: [{ slug: "My-Runner", is_public: 1 }] });
      return json(route, { ok: true, updated: true });
    }
    if (p.endsWith("homebrew.php")) return json(route, { packs: [] });
    if (p.endsWith("homebrew-subscriptions.php")) return json(route, { subscriptions: [] });
    return json(route, {});
  });
  await page.addInitScript(() => {
    if (location.protocol !== "http:" || sessionStorage.getItem("__seeded")) return;
    sessionStorage.setItem("__seeded", "1");
    localStorage.clear();
    localStorage.setItem("sinless:webkit-storage-tip", "1");
    localStorage.setItem("sinless:u7:workspace", JSON.stringify({ open: ["My-Runner"], active: 0 }));
  });
  await page.goto("index.html");
  await waitForApp(page);
}

test("☰ → Shared characters opens the gallery; your own open for editing, others copy", async ({ page }) => {
  const errors = watchErrors(page);
  await signedIn(page);

  await openMenu(page);
  await domClick(page.getByRole("button", { name: "Shared characters…" }));
  const gallery = page.locator("#shared");
  await expect(gallery).toBeVisible();
  const row = name => gallery.locator(".admin-row", { hasText: name });
  await expect(row("My Runner").getByRole("button")).toHaveText(["Unshare", "Save a copy", "Open"]);
  await expect(row("Their Runner").getByRole("button")).toHaveText(["Save a copy", "View"]);

  // Open your own: your editable save, in a tab, not the read-only view.
  await domClick(row("My Runner").getByRole("button", { name: "Open" }));
  await expect(gallery).toBeHidden();
  expect(await page.evaluate(() => [CHAR.name, !!activeTabObj().readonly])).toEqual(["My Runner", false]);

  // Copy someone else's: a new character of your own, under a fresh name.
  await openMenu(page);
  await domClick(page.getByRole("button", { name: "Shared characters…" }));
  await domClick(row("Their Runner").getByRole("button", { name: "Save a copy" }));
  await expect(gallery).toBeHidden();
  const copied = await page.evaluate(() => CHAR.name);
  expect(copied).toContain("Their Runner");
  expect(await page.evaluate(n => STORAGE.listCharacters().includes(STORAGE.sanitizeName(n)), copied)).toBe(true);
  expectNoErrors(errors);
});

test("no gallery entry in ☰ when not signed in", async ({ page }) => {
  await page.goto("index.html");
  await waitForApp(page);
  await openMenu(page);
  await expect(page.getByRole("button", { name: "Shared characters…" })).toHaveCount(0);
});
