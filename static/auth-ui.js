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

/* Append Sign out (+ Admin) to the chargen rail actions when signed in. Called
 * from bindRail(). No-op in local-only mode. */
function mountAccountControls() {
  if (!(typeof SYNC !== "undefined" && SYNC.enabled && SYNC.enabled())) return;
  const bar = $(".rail-actions");
  if (!bar || bar.querySelector(".btn-signout")) return;
  bar.append(el("button", { class: "btn ghost btn-shared", onclick: openSharedGallery }, "Shared"));
  if (SYNC.isAdmin())
    bar.append(el("button", { class: "btn ghost btn-admin", onclick: openAdminPanel }, "Admin"));
  bar.append(el("button", { class: "btn ghost btn-signout", onclick: doSignOut }, "Sign out"));
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
  const chars = await SYNC.listShared();
  const back = el("button", { class: "btn ghost",
    onclick: () => { $("#shared").hidden = true; showActiveTab(); } }, "← Back");
  const card = el("div", { class: "auth-card admin-card" },
    el("div", { class: "admin-head" }, el("h2", { class: "auth-title" }, "Shared characters"), back));
  if (!chars.length) {
    card.append(el("p", { class: "auth-meta" },
      "No public characters yet. Share one from a character's ☰ menu → Sharing."));
  } else {
    for (const c of chars) {
      card.append(el("div", { class: "admin-row" },
        el("div", { class: "admin-id" },
          el("div", { class: "admin-name" }, c.name || "(unnamed)"),
          el("div", { class: "admin-email" }, "by " + (c.owner || "member"))),
        el("div", { class: "admin-actions" },
          el("button", { class: "btn small", onclick: () => viewShared(c.id) }, "View"),
          el("button", { class: "btn small good", onclick: () => copyShared(c.id) }, "Save a copy"))));
    }
  }
  root.replaceChildren(card);
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
