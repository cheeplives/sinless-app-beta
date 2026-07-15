/**
 * storage.js — localStorage character persistence.
 *
 * Each character is stored under `sinless:char:<sanitized-name>`, so a given
 * street name always maps to the same slot. Characters are a few KB each;
 * localStorage's ~5 MB budget is ample.
 */
"use strict";

const STORAGE = (() => {

const KEY_PREFIX = "sinless:char:";
const MAX_CHARACTER_NAME_LENGTH = 80;

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
  const names = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(KEY_PREFIX)) names.push(key.slice(KEY_PREFIX.length));
  }
  return names.sort();
}

function loadCharacter(name) {
  const key = KEY_PREFIX + sanitizeName(name);
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

function saveCharacter(character) {
  const saved = sanitizeName(character.name);
  localStorage.setItem(KEY_PREFIX + saved, JSON.stringify(character));
  return saved;
}

function deleteCharacter(name) {
  localStorage.removeItem(KEY_PREFIX + sanitizeName(name));
}

/* ---- homebrew custom content --------------------------------------------
 * One entry holds every user-created row, keyed by data.js table name, in the
 * exact column schema of that table (string values, marker Custom:"Y").
 * homebrew.js merges these into DATA_BUNDLE.tables at boot and after edits. */
const CUSTOM_KEY = "sinless:custom:content";
const CUSTOM_TABLES = [
  "rituals", "spells", "misc_gear", "augments", "weapons", "armor",
  "vehicles", "drones", "weapon_mods",
  "vehicle_ballistic_weapons", "vehicle_energy_weapons",
  "drone_ballistic_weapons", "drone_energy_weapons",
  "drone_mods", "vehicle_mods",
];

function loadCustomContent() {
  let parsed = null;
  try { parsed = JSON.parse(localStorage.getItem(CUSTOM_KEY) || "null"); }
  catch { /* corrupt entry: start fresh rather than break boot */ }
  const content = {};
  for (const t of CUSTOM_TABLES)
    content[t] = (parsed && Array.isArray(parsed[t])) ? parsed[t] : [];
  return content;
}

function saveCustomContent(content) {
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(content));
}

return { sanitizeName, listCharacters, loadCharacter, saveCharacter, deleteCharacter,
         loadCustomContent, saveCustomContent, CUSTOM_TABLES };

})();

if (typeof module !== "undefined") module.exports = STORAGE;
