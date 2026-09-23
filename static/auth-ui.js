/**
 * auth-ui.js — the login gate, pending-approval screen, admin panel, and
 * sign-out, layered on the existing screen-toggle pattern. Uses app.js globals
 * (el, $, SYNC). Only active when a backend is present; in local-only mode none
 * of these screens are shown.
 */
"use strict";

const AUTH_SCREENS = ["#app", "#sheet", "#homebrew", "#login", "#pending", "#admin", "#shared", "#workspace-tabs"];
function hideAllScreens() {
  for (const sel of AUTH_SCREENS) { const e = $(sel); if (e) e.hidden = true; }
}

const PROVIDER_LABEL = { google: "Google", github: "GitHub" };

/* Preserve the caller's spot so we land back where we were after OAuth. */
function returnParam() {
  return encodeURIComponent(location.pathname + location.search);
}

function renderLoginGate() {
  const root = $("#login");
  root.replaceChildren();
  const providers = (SYNC.providers || []);
  const card = el("div", { class: "auth-card" },
    el("div", { class: "auth-brand" }, "SINLESS"),
    el("div", { class: "auth-sub" }, "character dossier"),
    el("p", { class: "auth-lead" }, "Sign in to sync your characters across devices."));
  if (providers.length) {
    for (const p of providers) {
      card.append(el("a", {
        class: "btn-oauth " + p,
        href: `api/auth/login.php?provider=${p}&return=${returnParam()}`,
      }, `Sign in with ${PROVIDER_LABEL[p] || p}`));
    }
  } else {
    card.append(el("p", { class: "auth-warn" },
      "No sign-in providers are configured on the server yet."));
  }
  if (new URLSearchParams(location.search).has("auth_error")) {
    card.append(el("p", { class: "auth-warn" }, "Sign-in didn't complete. Please try again."));
  }
  root.replaceChildren(card);
  hideAllScreens();
  root.hidden = false;
}

let pendingPollTimer = null;
function renderPendingScreen() {
  const root = $("#pending");
  const u = SYNC.user || {};
  root.replaceChildren(el("div", { class: "auth-card" },
    el("div", { class: "auth-brand" }, "SINLESS"),
    el("h2", { class: "auth-title" }, "Awaiting approval"),
    el("p", { class: "auth-lead" },
      "Your account has been created and is waiting for the site owner to approve it. "
      + "You'll get in automatically once approved — no need to reload."),
    u.email ? el("p", { class: "auth-meta" }, "Signed in as " + u.email) : null,
    el("button", { class: "btn ghost", onclick: doSignOut }, "Sign out")));
  hideAllScreens();
  root.hidden = false;
  // Poll for approval; when it flips, reload to run the normal signed-in boot.
  clearInterval(pendingPollTimer);
  pendingPollTimer = setInterval(async () => {
    if ((await SYNC.probe()) === "signedin") { clearInterval(pendingPollTimer); location.reload(); }
  }, 30000);
}

async function doSignOut() {
  await SYNC.signOut();
  renderLoginGate();
}

/* ---- admin panel --------------------------------------------------------- */
async function openAdminPanel() {
  const root = $("#admin");
  root.replaceChildren(el("div", { class: "auth-card admin-card" }, el("p", {}, "Loading…")));
  hideAllScreens();
  root.hidden = false;
  await renderAdminList();
}

async function renderAdminList() {
  const root = $("#admin");
  let users = [];
  try { users = (await (await SYNC.api("GET", "admin/users.php")).json()).users || []; }
  catch { /* show empty */ }

  const back = el("button", { class: "btn ghost", onclick: () => { $("#admin").hidden = true; showActiveTab(); } }, "← Back");
  const card = el("div", { class: "auth-card admin-card" },
    el("div", { class: "admin-head" }, el("h2", { class: "auth-title" }, "Members"), back));

  const pending = users.filter(u => u.status === "pending");
  const others  = users.filter(u => u.status !== "pending");

  const row = u => {
    const actions = el("div", { class: "admin-actions" });
    if (u.status === "pending")
      actions.append(el("button", { class: "btn small good", onclick: () => adminAct(u.id, "approve") }, "Approve"),
                     el("button", { class: "btn small warn", onclick: () => adminAct(u.id, "revoke") }, "Deny"));
    else if (u.status === "approved" && !u.is_admin)
      actions.append(el("button", { class: "btn small warn", onclick: () => adminAct(u.id, "revoke") }, "Revoke"));
    else if (u.status === "revoked")
      actions.append(el("button", { class: "btn small good", onclick: () => adminAct(u.id, "approve") }, "Reinstate"));
    return el("div", { class: "admin-row" },
      el("div", { class: "admin-id" },
        el("div", { class: "admin-name" }, (u.display_name || u.email || "(unknown)") + (u.is_admin ? " ★" : "")),
        el("div", { class: "admin-email" }, `${u.email} · ${u.provider} · ${u.status}`)),
      actions);
  };

  card.append(el("div", { class: "admin-section-label" }, `Pending (${pending.length})`));
  card.append(pending.length ? el("div", {}, ...pending.map(row))
                             : el("p", { class: "auth-meta" }, "No one waiting."));
  card.append(el("div", { class: "admin-section-label" }, "Members"));
  card.append(others.length ? el("div", {}, ...others.map(row))
                            : el("p", { class: "auth-meta" }, "None yet."));
  root.replaceChildren(card);
}

async function adminAct(userId, action) {
  try {
    const res = await SYNC.api("POST", "admin/users.php", { user_id: userId, action });
    if (!res.ok) { alert("Action failed."); return; }
  } catch { alert("Network error."); return; }
  await renderAdminList();
}

/* The 👤 account menu, in the fixed controls cluster top-right beside the
 * scheme picker and ⚙. Shared characters, Admin and Sign out used to sit at
 * the bottom of the character ☰ menu, which is wrong twice over: they aren't
 * actions on the open character, and they were the three rows most likely to
 * fall off the bottom of a long menu on a short viewport.
 *
 * Built once, from boot(), after SYNC.probe() has settled — so isAdmin() is
 * already known and there's no state to keep refreshing. In local-only mode
 * (no backend) none of these actions exist, so the whole control stays hidden
 * and costs nothing. Sign-out re-renders the login gate and approval changes
 * arrive via a reload, so the panel can't go stale while it's mounted.
 *
 * Open/close mirrors initHouseRules(): click toggles, a click anywhere else or
 * Escape closes, and clicks inside the panel don't bubble out to that handler. */
function initAccountMenu() {
  const wrap = $("#account-menu"), btn = $("#account-btn"), panel = $("#account-panel");
  if (!wrap || !btn || !panel) return;
  if (!(typeof SYNC !== "undefined" && SYNC.enabled && SYNC.enabled())) {
    wrap.hidden = true;
    return;
  }
  const u = SYNC.user || {};
  const who = u.display_name || u.email || "";
  const close = () => { panel.hidden = true; btn.setAttribute("aria-expanded", "false"); };
  const item = (label, fn, cls) => el("button", {
    class: "btn " + (cls || "ghost") + " account-item",
    onclick: () => { close(); fn(); } }, label);

  panel.replaceChildren(
    el("h4", {}, "Account"),
    who ? el("p", { class: "auth-meta account-who" }, who) : null,
    item("Shared characters", openSharedGallery),
    SYNC.isAdmin() ? item("Admin", openAdminPanel) : null,
    item("Sign out", doSignOut, "warn"));

  btn.addEventListener("click", e => {
    e.stopPropagation();
    const open = panel.hidden;
    panel.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
  });
  panel.addEventListener("click", e => e.stopPropagation());
  document.addEventListener("click", () => { if (!panel.hidden) close(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !panel.hidden) close(); });
  wrap.hidden = false;
}

/* ---- sharing: toggle + gallery ------------------------------------------- */
async function toggleSharing() {
  if (!CHAR.name) { alert("Give the character a name and save it first."); return; }
  const slug = STORAGE.sanitizeName(CHAR.name);
  STORAGE.saveCharacter(CHAR);          // ensure the latest is queued
  await SYNC.flush();                   // push so the server has a row to toggle
  const res = await SYNC.setVisibility(slug, !SYNC.isPublic(slug));
  if (res === null) { alert("Couldn't update sharing — the character may not have synced yet. Try again in a moment."); return; }
  alert(res ? "Now shared with other members." : "Now private.");
}

async function openSharedGallery() {
  const root = $("#shared");
  root.replaceChildren(el("div", { class: "auth-card admin-card" }, el("p", {}, "Loading…")));
  hideAllScreens();
  root.hidden = false;
  await renderSharedList();
}

async function renderSharedList() {
  const root = $("#shared");
  // Group the gallery by owner (then by character name within each owner).
  const chars = (await SYNC.listShared()).slice().sort((a, b) =>
    (a.owner || "").localeCompare(b.owner || "")
    || (a.name || "").localeCompare(b.name || ""));
  const back = el("button", { class: "btn ghost",
    onclick: () => { $("#shared").hidden = true; showActiveTab(); } }, "← Back");
  const card = el("div", { class: "auth-card admin-card" },
    el("div", { class: "admin-head" }, el("h2", { class: "auth-title" }, "Shared characters"), back));
  if (!chars.length) {
    card.append(el("p", { class: "auth-meta" },
      "No public characters yet. Share one from a character's ☰ menu → Sharing."));
    root.replaceChildren(card);
    return;
  }

  // Live filter by character name (case-insensitive substring), no re-fetch.
  const rows = el("div", {});
  let search;
  const renderRows = () => {
    const q = search.value.trim().toLowerCase();
    const matches = q ? chars.filter(c => (c.name || "").toLowerCase().includes(q)) : chars;
    rows.replaceChildren(...(matches.length ? matches.map(sharedRow)
      : [el("p", { class: "auth-meta" }, `No characters match “${search.value.trim()}”.`)]));
  };
  search = el("input", { type: "text", class: "shared-search",
    placeholder: "Search by character name…", oninput: renderRows });
  card.append(search, rows);
  renderRows();
  root.replaceChildren(card);
}

function sharedRow(c) {
  const isOwner = SYNC.user && (SYNC.user.name === c.owner || SYNC.user.display_name === c.owner);
  const actions = el("div", { class: "admin-actions" });

  if (isOwner) {
    // For owned characters, show Unshare (destructive) and View
    actions.append(
      el("button", { class: "btn small warn", onclick: () => unshareCharacter(c) }, "Unshare"),
      el("button", { class: "btn small good", onclick: () => viewShared(c.id) }, "View"));
  } else {
    // For other people's characters, show Save a copy and View
    actions.append(
      el("button", { class: "btn small", onclick: () => copyShared(c.id) }, "Save a copy"),
      el("button", { class: "btn small good", onclick: () => viewShared(c.id) }, "View"));
  }

  return el("div", { class: "admin-row" },
    el("div", { class: "admin-id" },
      el("div", { class: "admin-name" }, c.name || "(unnamed)"),
      el("div", { class: "admin-email" }, "by " + (c.owner || "member"))),
    actions);
}

async function viewShared(id) {
  const rec = await SYNC.fetchShared(id);
  if (!rec || !rec.data) { alert("That character is no longer available."); return; }
  $("#shared").hidden = true;
  await openReadonly(rec.data, { id: rec.id, owner: rec.owner });
}

async function copyShared(id) {
  const rec = await SYNC.fetchShared(id);
  if (!rec || !rec.data) { alert("That character is no longer available."); return; }
  const copy = RULES.mergeDefaults(JSON.parse(JSON.stringify(rec.data)));
  copy.name = uniqueCopyName(copy.name || rec.name || "Shared character");
  copy.finalized = true;
  STORAGE.saveCharacter(copy);
  $("#shared").hidden = true;
  await openCharacter(copy);
  if (typeof refreshLoadList === "function") refreshLoadList();
}

async function unshareCharacter(c) {
  if (!confirm(`Stop sharing "${c.name || '(unnamed)'}"?`)) return;

  // Use the character slug from the name
  const slug = STORAGE.sanitizeName(c.name);
  const res = await SYNC.setVisibility(slug, false);

  if (res === null) {
    alert("Couldn't unshare the character. Try again in a moment.");
    return;
  }

  // Character is now private; refresh the shared list to remove it
  alert("Character unshared.");
  await renderSharedList();
}
