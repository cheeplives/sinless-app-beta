/**
 * sync.js — auth probe + offline-first background sync against the PHP backend.
 *
 * Design: localStorage stays the synchronous working store (so the whole app is
 * untouched); this layer mirrors it to the server per authenticated user.
 *
 * Modes (SYNC.mode), decided by probing api/auth/me.php at boot:
 *   'local'     — no backend reachable (e.g. GitHub Pages / file://). Behaves
 *                 exactly like the pre-server app; no login gate.
 *   'signedout' — backend up, not authenticated → app shows the login gate.
 *   'pending'   — authenticated but awaiting admin approval → pending screen.
 *   'signedin'  — authenticated + approved → hydrate + sync.
 *
 * localStorage is namespaced per user (STORAGE.nsPrefix() consults SYNC), so two
 * accounts on one browser never see each other's cache, and sign-out wipes it.
 * Writes go to localStorage instantly and enqueue a retriable server op; the
 * queue survives offline and flushes on reconnect. Conflicts: last-write-wins by
 * a per-character millisecond stamp (server compares client_updated_at).
 */
"use strict";

const SYNC = (() => {

const API = "api/";                       // relative to the app root
let mode = "local";                       // local | signedout | pending | signedin
let user = null;                          // { id, email, name, avatar, status, is_admin }
let csrf = "";
let providers = [];                       // configured sign-in buttons, from me.php 401
let flushTimer = null;

/* ---- identity / namespace ------------------------------------------------ */
function userPrefix() {                    // STORAGE keys hang off this
  return (mode === "signedin" && user) ? `sinless:u${user.id}:` : "sinless:";
}
function enabled() { return mode === "signedin"; }   // server sync active?
function isAdmin() { return !!(user && user.is_admin); }

/* Per-character last-edit stamps (ms) drive last-write-wins. Kept in a small
 * map beside the character cache, in the same namespace. */
function stampsKey() { return userPrefix() + "stamps"; }
function queueKey()  { return userPrefix() + "syncqueue"; }
function sessionKey(){ return "sinless:session"; }     // cross-namespace hint for offline boot

function readJSON(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key) || "null"); return v == null ? fallback : v; }
  catch { return fallback; }
}
function writeJSON(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* quota */ } }

function stamps() { return readJSON(stampsKey(), {}); }
function setStamp(slug, ms) { const s = stamps(); s[slug] = ms; writeJSON(stampsKey(), s); }
function getStamp(slug) { return stamps()[slug] || 0; }

/* ---- HTTP ---------------------------------------------------------------- */
async function api(method, path, body) {
  const opts = { method, credentials: "same-origin", headers: { "Accept": "application/json" } };
  if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  if (method !== "GET" && csrf) opts.headers["X-CSRF-Token"] = csrf;
  return fetch(API + path, opts);
}

/* ---- probe --------------------------------------------------------------- */
async function probe() {
  try {
    const res = await fetch(API + "auth/me.php", { credentials: "same-origin", headers: { "Accept": "application/json" } });
    if (res.status === 200) {
      user = await res.json(); csrf = user.csrf || "";
      writeJSON(sessionKey(), { id: user.id, name: user.name, email: user.email, is_admin: user.is_admin });
      mode = user.status === "approved" ? "signedin" : "pending";
    } else if (res.status === 401) {
      const j = await res.json().catch(() => ({}));
      providers = j.providers || [];
      mode = "signedout";
    } else {
      mode = "local";                      // backend present but unusable — don't lock the user out
    }
  } catch {
    // Network failure. If we have a prior session, keep working offline from
    // cache (writes queue); otherwise there's simply no backend here.
    const cached = readJSON(sessionKey(), null);
    if (cached) { user = cached; csrf = ""; mode = "signedin"; }
    else mode = "local";
  }
  return mode;
}

/* ---- hydrate (pull server → local cache) --------------------------------- */
async function hydrate() {
  if (mode !== "signedin" || !csrf) return;   // offline (no csrf) → skip, use cache
  try {
    const cc = await (await api("GET", "custom-content.php")).json();
    if (cc && cc.data) STORAGE.cacheCustomContent(cc.data);

    const list = (await (await api("GET", "characters.php")).json()).characters || [];
    for (const meta of list) {
      const full = await (await api("GET", "characters.php?slug=" + encodeURIComponent(meta.slug))).json();
      if (full && full.data) {
        STORAGE.cacheCharacter(full.data);
        setStamp(full.slug, Number(full.client_updated_at) || 0);
      }
    }
  } catch (e) {
    // Offline mid-hydrate is fine — we run from whatever cache we have.
    console.warn("hydrate incomplete:", e);
  }
}

/* ---- write-through queue ------------------------------------------------- */
function enqueue(op) {
  const q = readJSON(queueKey(), []).filter(o => !(o.slug === op.slug));  // collapse per slug
  q.push(op);
  writeJSON(queueKey(), q);
  scheduleFlush();
}
/* Called by STORAGE after a local write/delete. */
function onSave(char) {
  if (!enabled()) return;
  const slug = STORAGE.sanitizeName(char.name);
  const ts = Date.now();
  setStamp(slug, ts);
  enqueue({ t: "put", slug, ts });
}
function onDelete(name) {
  if (!enabled()) return;
  enqueue({ t: "del", slug: STORAGE.sanitizeName(name) });
}

function scheduleFlush() { clearTimeout(flushTimer); flushTimer = setTimeout(flush, 800); }

async function flush() {
  if (!enabled() || !csrf) return;              // offline / not signed in → try later
  let q = readJSON(queueKey(), []);
  while (q.length) {
    const op = q[0];
    try {
      let res;
      if (op.t === "put") {
        const char = STORAGE.loadCharacter(op.slug);        // send the current copy
        if (!char) { q.shift(); writeJSON(queueKey(), q); continue; }   // deleted since — drop
        res = await api("PUT", "characters.php?slug=" + encodeURIComponent(op.slug),
                        { data: char, client_updated_at: getStamp(op.slug) || op.ts });
      } else {
        res = await api("DELETE", "characters.php?slug=" + encodeURIComponent(op.slug));
      }
      if (res.status === 409) { /* server had newer — drop our stale write */ }
      else if (!res.ok) break;                  // transient/server error → retry later
      q.shift(); writeJSON(queueKey(), q);
    } catch { break; }                          // offline → stop, retry on reconnect
  }
}

/* Push the homebrew blob (called by homebrew.js after edits). */
async function pushCustomContent(content) {
  if (!enabled() || !csrf) return;
  try { await api("PUT", "custom-content.php", { data: content }); } catch { /* retry next edit */ }
}

/* ---- sign out ------------------------------------------------------------ */
async function signOut() {
  const prefix = userPrefix();
  try { await api("POST", "auth/logout.php"); } catch { /* proceed with local cleanup regardless */ }
  // Wipe this user's cached data + queue from the shared device.
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && (k.startsWith(prefix) || k === sessionKey())) localStorage.removeItem(k);
  }
  user = null; csrf = ""; mode = "signedout";
}

/* Re-flush when connectivity returns. */
window.addEventListener("online", () => { if (enabled()) flush(); });

return {
  probe, hydrate, flush, onSave, onDelete, pushCustomContent, signOut,
  userPrefix, enabled, isAdmin, api,
  get mode() { return mode; },
  get user() { return user; },
  get providers() { return providers; },
};

})();

if (typeof module !== "undefined") module.exports = SYNC;
