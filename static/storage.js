/**
 * storage.js — localStorage character persistence (the synchronous working
 * store). Its public API is unchanged, so the rest of the app is untouched.
 *
 * Keys are namespaced by SYNC.userPrefix(): "sinless:" in local-only mode
 * (identical to the pre-server app) or "sinless:u<id>:" when signed in, so two
 * accounts on one browser stay separate and sign-out can wipe one cleanly.
 * When signed in, writes/deletes also notify SYNC to mirror them to the server;
 * `cacheCharacter`/`cacheCustomContent` are the no-notify variants SYNC uses
 * when hydrating FROM the server.
 */
"use strict";

const STORAGE = (() => {

const MAX_CHARACTER_NAME_LENGTH = 80;

/* Namespace prefix — consults SYNC at call time (SYNC may sign in/out during a
 * session). Falls back to the legacy "sinless:" when SYNC isn't present. */
function nsPrefix() {
  return (typeof SYNC !== "undefined" && SYNC.userPrefix) ? SYNC.userPrefix() : "sinless:";
}
function charPrefix() { return nsPrefix() + "char:"; }
function customKey()  { return nsPrefix() + "custom:content"; }

/** Turn a character name into a stable storage key: letters/digits/_/-
 * survive, everything else collapses to a hyphen; length-capped; never empty. */
function sanitizeName(name) {
  let cleaned = String(name || "unnamed").trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  cleaned = cleaned.slice(0, MAX_CHARACTER_NAME_LENGTH) || "unnamed";
  return cleaned;
}

function listCharacters() {
  const prefix = charPrefix();
  const names = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(prefix)) names.push(key.slice(prefix.length));
  }
  return names.sort();
}

function loadCharacter(name) {
  const key = charPrefix() + sanitizeName(name);
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // Corrupt entry (partial write, manual edit): drop it so it stops
    // breaking loads, and report nothing found.
    localStorage.removeItem(key);
    return null;
  }
}

/* Local write only (no server notify) — used by SYNC.hydrate. */
function cacheCharacter(character) {
  const saved = sanitizeName(character.name);
  localStorage.setItem(charPrefix() + saved, JSON.stringify(character));
  return saved;
}

function saveCharacter(character) {
  const saved = cacheCharacter(character);
  if (typeof SYNC !== "undefined" && SYNC.onSave) SYNC.onSave(character);
  return saved;
}

function deleteCharacter(name) {
  localStorage.removeItem(charPrefix() + sanitizeName(name));
  if (typeof SYNC !== "undefined" && SYNC.onDelete) SYNC.onDelete(name);
}

/* ---- homebrew custom content --------------------------------------------
 * One entry holds every user-created row, keyed by data.js table name, in the
 * exact column schema of that table (string values, marker Custom:"Y").
 * homebrew.js merges these into DATA_BUNDLE.tables at boot and after edits. */
const CUSTOM_TABLES = [
  "rituals", "spells", "misc_gear", "augments", "weapons", "armor",
  "vehicles", "drones", "weapon_mods",
  "vehicle_ballistic_weapons", "vehicle_energy_weapons",
  "drone_ballistic_weapons", "drone_energy_weapons",
  "drone_mods", "vehicle_mods",
];

function loadCustomContent() {
  let parsed = null;
  try { parsed = JSON.parse(localStorage.getItem(customKey()) || "null"); }
  catch { /* corrupt entry: start fresh rather than break boot */ }
  const content = {};
  for (const t of CUSTOM_TABLES)
    content[t] = (parsed && Array.isArray(parsed[t])) ? parsed[t] : [];
  return content;
}

/* Local write only (no server push) — used by SYNC.hydrate. */
function cacheCustomContent(content) {
  localStorage.setItem(customKey(), JSON.stringify(content));
}

function saveCustomContent(content) {
  cacheCustomContent(content);
  if (typeof SYNC !== "undefined" && SYNC.pushCustomContent) SYNC.pushCustomContent(content);
}

return { sanitizeName, listCharacters, loadCharacter, saveCharacter, deleteCharacter,
         cacheCharacter, loadCustomContent, saveCustomContent, cacheCustomContent,
         CUSTOM_TABLES };

})();

if (typeof module !== "undefined") module.exports = STORAGE;
