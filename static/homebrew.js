/**
 * homebrew.js — user-created custom content (homebrew) editor.
 *
 * Loaded between storage.js and app.js and shares the app's globals
 * (DATA/el/$/fmt at event time; DATA_BUNDLE/STORAGE at merge time).
 *
 * Custom rows live in localStorage (STORAGE.loadCustomContent) keyed by
 * data.js table name, in the exact column schema of that table with string
 * values, plus the marker Custom:"Y". mergeCustomContent() splices them into
 * the live DATA_BUNDLE.tables arrays — the same arrays every chargen picker,
 * play-mode buy list, and rules.js lookup reads — so custom content appears
 * everywhere with no other integration.
 *
 * The editor is a third screen (#homebrew) toggled like #sheet, reachable
 * from the chargen rail and the play-sheet footer. Packs (the whole custom
 * collection) can be exported/imported as JSON to share between users;
 * import merges and skips name collisions, so combining several players'
 * packs is just importing them in turn.
 */
"use strict";

/* Working copy of the custom collection. Kept in memory so the row objects
 * pushed into DATA_BUNDLE.tables are the SAME objects the editor mutates —
 * edits flow through without re-merging object identities. */
let HB_CUSTOM = null;

let hbTable = "weapons";     // active editor tab (table key)
let hbEditIndex = null;      // index into HB_CUSTOM[hbTable] being edited; null = adding
let hbReturnTo = "app";      // which screen Back returns to

/* ---- per-table editor config ------------------------------------------ */
/* Field flags: ta = textarea, select = fixed choices (app logic gates on the
 * value), datalist = suggestions but free-form allowed, hint = placeholder. */
const HOMEBREW_CONFIG = {
  rituals: { label: "Rituals", nameKey: "Name", fields: [
    { key: "Name" },
    { key: "Drain", hint: "number" },
    { key: "Time", hint: "e.g. 10 min" },
    { key: "Effect", ta: true },
    { key: "Description", ta: true },
  ]},
  spells: { label: "Spells", nameKey: "Name", fields: [
    { key: "Name" },
    { key: "School", datalist: () => hbDistinct("spells", "School") },
    { key: "Target Resistance" },
    { key: "Duration" },
    { key: "Drain", hint: "number" },
    { key: "Cost", hint: "number" },
    { key: "Effect", ta: true },
    { key: "Description", ta: true },
  ]},
  misc_gear: { label: "Gear", nameKey: "Item", fields: [
    { key: "Item" },
    { key: "Class", datalist: () => hbDistinct("misc_gear", "Class"),
      hint: "new classes make new picker groups" },
    { key: "Cost", hint: "number" },
    { key: "Dependence", hint: "addiction factor" },
    { key: "Weight", hint: "number" },
    { key: "Rarity", hint: "number" },
    { key: "Mount Types", datalist: () => ["Any",
        ...hbDistinct("augments", "Type").filter(t => t !== "Bioware")],
      hint: "augment types this can mount — comma-separated, or Any; blank = none" },
    { key: "Mount ZP", hint: "ZP capacity for mounted augments (exempt from the character's ZP)" },
    { key: "Effect", ta: true },
  ]},
  augments: { label: "Augments", nameKey: "Name", fields: [
    { key: "Name", hint: "end with a number (“Reflex Booster 2”) for rank logic" },
    { key: "Type", select: () => hbDistinct("augments", "Type") },
    { key: "ZR", hint: "number" },
    { key: "BI", hint: "number" },
    { key: "Cost", hint: "number" },
    { key: "Strength", hint: "+N" },
    { key: "Body", hint: "+N" },
    { key: "Reaction", hint: "+N" },
    { key: "Intelligence", hint: "+N" },
    { key: "Armor Slot", hint: "N or slot name" },
    { key: "Impact Armor" },
    { key: "ImpArmMin" },
    { key: "Ballistic Armor" },
    { key: "Ban", hint: "name prefixes this bans" },
    { key: "Effect", ta: true },
    { key: "Description", ta: true },
  ]},
  weapons: { label: "Weapons", nameKey: "Weapon", fields: [
    { key: "Weapon" },
    { key: "Type", select: () => Object.keys(WEAPON_TYPE_LABELS),
      optionLabel: k => `${WEAPON_TYPE_LABELS[k]} (${k})` },
    { key: "ZR", hint: "number" },
    { key: "BI", hint: "number" },
    { key: "Cost", hint: "number" },
    { key: "Accuracy", hint: "number" },
    { key: "Reach", hint: "Melee reach or “Ranged”" },
    { key: "Damage", hint: "e.g. 8; for Melee this is the base added to a share of Strength" },
    { key: "STR Mult", hint: "Melee only, share of Strength added — default 0.5, e.g. 1 for full STR" },
    { key: "Damage Bonus", hint: "Melee only, e.g. +2d6" },
    { key: "Firing modes", hint: "e.g. SS, BF, FA" },
    { key: "Ammo", hint: "magazine size" },
    { key: "Pen", hint: "armor penetration" },
    { key: "Conceal", hint: "number" },
    { key: "Weight", hint: "number" },
    { key: "Hardening", hint: "number" },
    { key: "Rarity", hint: "number" },
    { key: "Upgr1_Cost", hint: "Upgrade 1 cost — Woolongs plus optional special part, e.g. “1500 + 50 Tc”" },
    { key: "Upgr1_Eff", hint: "Upgrade 1 effect, e.g. “Barrel Detailing (+1 damage)”" },
    { key: "Upgr2_Cost", hint: "Upgrade 2 cost — same format as Upgrade 1" },
    { key: "Upgr2_Eff", hint: "Upgrade 2 effect" },
    { key: "Mount Types", datalist: () => ["Any",
        ...hbDistinct("augments", "Type").filter(t => t !== "Bioware")],
      hint: "augment types this can mount — comma-separated, or Any; blank = none" },
    { key: "Mount ZP", hint: "ZP capacity for mounted augments (exempt from the character's ZP)" },
    { key: "Notes", ta: true },
  ]},
  armor: { label: "Armor", nameKey: "Armor", fields: [
    { key: "Armor" },
    { key: "Slot", select: () => ["Outer", "Under", "Other"] },
    { key: "ZR", hint: "number" },
    { key: "BI", hint: "number" },
    { key: "Cost", hint: "number" },
    { key: "Ballistic", hint: "number" },
    { key: "Impact", hint: "number" },
    { key: "wt", hint: "number" },
    { key: "Rarity", hint: "number" },
    { key: "Style", select: () => ["", "Y"],
      optionLabel: v => v === "Y" ? "Y (styleable)" : "(fixed)" },
    { key: "Mount Types", datalist: () => ["Any",
        ...hbDistinct("augments", "Type").filter(t => t !== "Bioware")],
      hint: "augment types this can mount — comma-separated, or Any; blank = none" },
    { key: "Mount ZP", hint: "ZP capacity for mounted augments (exempt from the character's ZP)" },
  ]},
  vehicles: { label: "Vehicles", nameKey: "Vehicle", fields: [
    { key: "Vehicle" },
    { key: "ZR", hint: "number" },
    { key: "BI", hint: "number" },
    { key: "Cost", hint: "number" },
    { key: "Body", hint: "number" },
    { key: "Move" },
    { key: "Handling", hint: "number" },
    { key: "Cargo" },
    { key: "Rarity", hint: "number" },
    { key: "Armor" },
    { key: "Impact", hint: "number" },
    { key: "Ballistic", hint: "number" },
  ]},
  drones: { label: "Drones", nameKey: "Drone", fields: [
    { key: "Drone" },
    { key: "Frame", datalist: () => hbDistinct("drones", "Frame") },
    { key: "ZR", hint: "number" },
    { key: "BI", hint: "number" },
    { key: "Cost", hint: "number" },
    { key: "Body", hint: "number" },
    { key: "WW" },
    { key: "Move" },
    { key: "Handling", hint: "number" },
    { key: "Hard Point", hint: "number of mounts" },
    { key: "Rarity", hint: "number" },
    { key: "Armor" },
    { key: "Impact", hint: "number" },
    { key: "Ballistic", hint: "number" },
    { key: "Effect", ta: true },
  ]},
  weapon_mods: { label: "Weapon Mods", nameKey: "Modification", fields: [
    { key: "Modification" },
    { key: "Slot", select: () => hbDistinct("weapon_mods", "Slot") },
    { key: "ZR", hint: "number" },
    { key: "BI", hint: "number" },
    { key: "Cost", hint: "number" },
    { key: "Effect", ta: true },
    { key: "RecoilMod", hint: "+/-N" },
    { key: "AccMod", hint: "+/-N" },
    { key: "MagMod", hint: "e.g. x1.5" },
    { key: "HardMod", hint: "+/-N" },
    { key: "Conceal Mod", hint: "+/-N" },
  ]},
  vehicle_ballistic_weapons: { label: "Vehicle Ballistic", nameKey: "Vehicle Ballistic Weapon", fields: [
    { key: "Vehicle Ballistic Weapon" },
    { key: "ZR", hint: "number" },
    { key: "BI", hint: "number" },
    { key: "Cost", hint: "number" },
    { key: "Accuracy", hint: "number" },
    { key: "Damage", hint: "number" },
    { key: "Ammo" },
    { key: "Modes", hint: "e.g. SS, BF, FA" },
    { key: "Rarity", hint: "number" },
    { key: "Weight", hint: "number" },
    { key: "Pen", hint: "armor penetration" },
    { key: "Effect", ta: true },
    { key: "ModeEffect", ta: true },
  ]},
  vehicle_energy_weapons: { label: "Vehicle Energy", nameKey: "Vehicle Energy Weapon", fields: [
    { key: "Vehicle Energy Weapon" },
    { key: "ZR", hint: "number" },
    { key: "BI", hint: "number" },
    { key: "Cost", hint: "number" },
    { key: "Accuracy", hint: "number" },
    { key: "Damage", hint: "number" },
    { key: "Heat", hint: "number" },
    { key: "Heat Limit", hint: "number" },
    { key: "Rarity", hint: "number" },
    { key: "Weight", hint: "number" },
    { key: "Pen", hint: "armor penetration" },
    { key: "ModeEffect", ta: true },
  ]},
  drone_ballistic_weapons: { label: "Drone Ballistic", nameKey: "Drone Ballistic Weapon", fields: [
    { key: "Drone Ballistic Weapon" },
    { key: "ZR", hint: "number" },
    { key: "BI", hint: "number" },
    { key: "Cost", hint: "number" },
    { key: "Accuracy", hint: "number" },
    { key: "Damage", hint: "number" },
    { key: "Ammo" },
    { key: "Modes", hint: "e.g. SS, BF, FA" },
    { key: "Rarity", hint: "number" },
    { key: "Weight", hint: "number" },
    { key: "Pen", hint: "armor penetration" },
    { key: "Effect", ta: true },
    { key: "ModeEffect", ta: true },
  ]},
  drone_energy_weapons: { label: "Drone Energy", nameKey: "Drone Energy Weapon", fields: [
    { key: "Drone Energy Weapon" },
    { key: "ZR", hint: "number" },
    { key: "BI", hint: "number" },
    { key: "Cost", hint: "number" },
    { key: "Accuracy", hint: "number" },
    { key: "Damage", hint: "number" },
    { key: "Heat", hint: "number" },
    { key: "Heat Limit", hint: "number" },
    { key: "Rarity", hint: "number" },
    { key: "Weight", hint: "number" },
    { key: "Pen", hint: "armor penetration" },
    { key: "ModeEffect", ta: true },
  ]},
  vehicle_mods: { label: "Vehicle Mods", nameKey: "Vehicle Mod", fields: [
    { key: "Vehicle Mod" },
    { key: "ZR", hint: "number" },
    { key: "BI", hint: "number" },
    { key: "Cost", hint: "number" },
    { key: "Weight", hint: "number" },
    { key: "ModeEffect", ta: true },
  ]},
  drone_mods: { label: "Drone Mods", nameKey: "Drone Mod", fields: [
    { key: "Drone Mod" },
    { key: "ZR", hint: "number" },
    { key: "BI", hint: "number" },
    { key: "Cost", hint: "number" },
    { key: "Weight", hint: "number" },
    { key: "ModeEffect", ta: true },
  ]},
};

/* Sorted unique non-empty values of one column, read from the live merged
 * table so existing custom rows contribute their groups too. */
function hbDistinct(tableKey, col) {
  const seen = new Set();
  for (const row of DATA_BUNDLE.tables[tableKey] || [])
    if (row[col] != null && String(row[col]).trim() !== "") seen.add(String(row[col]));
  return [...seen].sort();
}

/* ---- merge into the live game data ------------------------------------ */
/* In-place splice/push (never reassign) so the array references captured by
 * rules.js at load stay live. Idempotent: strips prior custom rows first. */
function mergeCustomContent() {
  if (!HB_CUSTOM) HB_CUSTOM = STORAGE.loadCustomContent();
  for (const key of Object.keys(HOMEBREW_CONFIG)) {
    const table = DATA_BUNDLE.tables[key];
    if (!table) continue;
    for (let i = table.length - 1; i >= 0; i--)
      if (table[i].Custom === "Y") table.splice(i, 1);
    for (const row of HB_CUSTOM[key] || []) table.push(row);
  }
}

function hbSave() {
  STORAGE.saveCustomContent(HB_CUSTOM);
  mergeCustomContent();
}

/* ---- screen management ------------------------------------------------- */
function enterHomebrew() {
  hbReturnTo = $("#sheet").hidden ? "app" : "sheet";
  hbEditIndex = null;
  $("#app").hidden = true;
  $("#sheet").hidden = true;
  $("#homebrew").hidden = false;
  renderHomebrew();
  window.scrollTo(0, 0);
}

async function exitHomebrew() {
  $("#homebrew").hidden = true;
  await recalc();
  if (hbReturnTo === "sheet") {
    $("#sheet").hidden = false;
    renderSheet();
  } else {
    $("#app").hidden = false;
    renderPanel();
  }
}

/* ---- rendering ---------------------------------------------------------- */
/* Compact one-line summary of a row's non-empty fields (skipping the name
 * and the Custom marker) for list rows and the built-in reference. */
function hbRowSummary(cfg, row) {
  const parts = [];
  for (const f of cfg.fields) {
    if (f.key === cfg.nameKey) continue;
    const v = String(row[f.key] ?? "").trim();
    if (v !== "") parts.push(`${f.key} ${v}`);
  }
  return parts.join(" · ");
}

function renderHomebrew() {
  const root = $("#homebrew");
  root.innerHTML = "";
  const cfg = HOMEBREW_CONFIG[hbTable];
  const rows = HB_CUSTOM[hbTable] || [];

  /* hidden file input for pack import */
  const importInput = el("input", {
    type: "file", accept: ".json,application/json", hidden: "1",
    onchange: async e => {
      const file = e.target.files[0];
      e.target.value = "";
      if (!file) return;
      let parsed;
      try { parsed = JSON.parse(await file.text()); } catch { parsed = null; }
      importHomebrewPack(parsed);
    },
  });

  const head = el("div", { class: "hb-head" },
    el("div", {},
      el("h2", {}, "Homebrew Content"),
      el("p", { class: "hint" },
        "Custom items merge into every picker and price calculation. "
        + "Characters that use them need this content present, so share your "
        + "pack alongside exported characters. Importing a pack merges it "
        + "into yours; duplicate names are skipped.")),
    el("div", { class: "hb-head-actions" },
      el("button", { class: "btn ghost", onclick: exitHomebrew }, "← Back"),
      el("button", { class: "btn", onclick: exportHomebrewPack }, "Export Pack"),
      el("button", { class: "btn", onclick: () => importInput.click() }, "Import Pack"),
      importInput));
  root.append(head);

  /* tab strip */
  const tabs = el("div", { class: "hb-tabs" },
    ...Object.entries(HOMEBREW_CONFIG).map(([key, c]) =>
      el("button", {
        class: "hb-tab" + (key === hbTable ? " active" : ""),
        onclick: () => { hbTable = key; hbEditIndex = null; renderHomebrew(); },
      }, `${c.label}${(HB_CUSTOM[key] || []).length ? ` (${HB_CUSTOM[key].length})` : ""}`)));
  root.append(tabs);

  /* custom rows list */
  const list = el("div", { class: "card" }, el("h3", {}, `Your ${cfg.label}`));
  if (!rows.length) {
    list.append(el("p", { class: "hint" }, `No custom ${cfg.label.toLowerCase()} yet — add one below.`));
  } else {
    const t = el("table");
    rows.forEach((row, i) => {
      t.append(el("tr", {},
        el("td", {}, el("b", {}, row[cfg.nameKey] || "(unnamed)"),
          el("div", { class: "sub" }, hbRowSummary(cfg, row))),
        el("td", { class: "hb-row-actions" },
          el("button", { class: "btn small", onclick: () => { hbEditIndex = i; renderHomebrew(); } }, "Edit"),
          el("button", { class: "row-del", title: "Delete",
            onclick: () => {
              const name = row[cfg.nameKey] || "(unnamed)";
              if (!confirm(`Delete ${name}? Characters that own it keep the name but lose its stats.`)) return;
              rows.splice(i, 1);
              if (hbEditIndex === i) hbEditIndex = null;
              hbSave();
              renderHomebrew();
            } }, "✕"))));
    });
    list.append(t);
  }
  root.append(list);

  /* add / edit form */
  const editing = hbEditIndex != null ? rows[hbEditIndex] : null;
  const form = el("div", { class: "card" },
    el("h3", {}, editing ? `Edit: ${editing[cfg.nameKey] || "(unnamed)"}` : `Add ${cfg.label.replace(/s$/, "")}`));
  const inputs = {};   // column key -> input/textarea/select element
  const grid = el("div", { class: "hb-form-grid" });
  for (const f of cfg.fields) {
    const current = editing ? String(editing[f.key] ?? "") : "";
    let control;
    if (f.select) {
      const opts = f.select();
      control = el("select", {},
        ...opts.map(v => el("option", { value: v }, f.optionLabel ? f.optionLabel(v) : (v || "(none)"))));
      control.value = opts.includes(current) ? current : opts[0];
    } else if (f.ta) {
      control = el("textarea", { rows: "2" });
      control.value = current;
    } else {
      const attrs = { type: "text", ...(f.hint ? { placeholder: f.hint } : {}) };
      if (f.datalist) {
        const listId = `hb-dl-${hbTable}-${f.key.replace(/\W+/g, "-")}`;
        attrs.list = listId;
        grid.append(el("datalist", { id: listId },
          ...f.datalist().map(v => el("option", { value: v }))));
      }
      control = el("input", attrs);
      control.value = current;
    }
    inputs[f.key] = control;
    grid.append(el("label", { class: "hb-field" + (f.ta ? " hb-wide" : "") },
      el("span", { class: "hb-field-name" }, f.key), control));
  }
  form.append(grid,
    el("div", { class: "hb-form-actions" },
      el("button", { class: "btn-add", onclick: () => {
        const row = {};
        for (const f of cfg.fields) row[f.key] = String(inputs[f.key].value ?? "").trim();
        row.Custom = "Y";
        const name = row[cfg.nameKey];
        if (!name) { alert(`${cfg.nameKey} is required.`); return; }
        const clash = DATA_BUNDLE.tables[hbTable].find(r =>
          r !== editing && String(r[cfg.nameKey] || "").trim().toLowerCase() === name.toLowerCase());
        if (clash) {
          alert(`A ${cfg.label.replace(/s$/, "").toLowerCase()} named “${name}” already exists`
            + (clash.Custom === "Y" ? " in your homebrew." : " in the core data."));
          return;
        }
        if (editing) rows[hbEditIndex] = row; else rows.push(row);
        hbEditIndex = null;
        hbSave();
        renderHomebrew();
      } }, editing ? "Save Changes" : "Add"),
      editing ? el("button", { class: "btn ghost", onclick: () => { hbEditIndex = null; renderHomebrew(); } }, "Cancel") : null));
  root.append(form);

  /* built-in reference: shows the column conventions while authoring */
  const builtins = DATA_BUNDLE.tables[hbTable].filter(r => r.Custom !== "Y");
  const refTable = el("table");
  for (const row of builtins) {
    refTable.append(el("tr", {},
      el("td", {}, el("b", {}, row[cfg.nameKey] || ""),
        el("div", { class: "sub" }, hbRowSummary(cfg, row)))));
  }
  root.append(el("details", { class: "card hb-ref" },
    el("summary", {}, `Built-in ${cfg.label} reference (${builtins.length})`),
    refTable));
}

/* ---- pack export / import ---------------------------------------------- */
function exportHomebrewPack() {
  const pack = { format: "sinless-homebrew", version: 1, ...HB_CUSTOM };
  const blob = new Blob([JSON.stringify(pack, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: "sinless-homebrew-pack.json" });
  a.click();
  URL.revokeObjectURL(url);
}

/* Merge a parsed pack into HB_CUSTOM: whitelist configured columns, coerce
 * to strings, skip rows whose name collides (case-insensitive) with any
 * existing built-in or custom row. Re-importing the same pack is a no-op. */
function importHomebrewPack(parsed) {
  const known = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    && Object.keys(HOMEBREW_CONFIG).some(k => Array.isArray(parsed[k]));
  if (!known) {
    alert("That file doesn't look like a Sinless homebrew pack.");
    return;
  }
  let imported = 0;
  const skipped = [];
  for (const [key, cfg] of Object.entries(HOMEBREW_CONFIG)) {
    if (!Array.isArray(parsed[key])) continue;
    const taken = new Set(DATA_BUNDLE.tables[key]
      .map(r => String(r[cfg.nameKey] || "").trim().toLowerCase()));
    for (const raw of parsed[key]) {
      if (!raw || typeof raw !== "object") continue;
      const row = {};
      for (const f of cfg.fields) row[f.key] = String(raw[f.key] ?? "").trim();
      row.Custom = "Y";
      const name = row[cfg.nameKey];
      if (!name) continue;
      if (taken.has(name.toLowerCase())) { skipped.push(name); continue; }
      taken.add(name.toLowerCase());
      HB_CUSTOM[key].push(row);
      imported++;
    }
  }
  hbSave();
  renderHomebrew();
  const skipNote = skipped.length
    ? ` Skipped ${skipped.length} duplicate name(s): ${skipped.slice(0, 8).join(", ")}${skipped.length > 8 ? ", …" : ""}.`
    : "";
  alert(`Imported ${imported} item(s).${skipNote}`);
}
