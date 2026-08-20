/**
 * homebrew.js — user-created custom content (homebrew) editor.
 *
 * Loaded between storage.js and app.js and shares the app's globals
 * (DATA/el/$/fmt at event time; DATA_BUNDLE/STORAGE at merge time).
 *
 * Custom rows are organised into named PACKS ({id,name,is_public,data}); data is
 * keyed by data.js table name in the exact column schema (string values, marker
 * Custom:"Y"). mergeCustomContent() splices my packs (editable) then subscribed
 * packs (read-only) into the live DATA_BUNDLE.tables arrays — the same arrays
 * every chargen picker, play-mode buy list, and rules.js lookup reads — so custom
 * content appears everywhere with no other integration. First writer of a name
 * wins: core > my packs > subscriptions.
 *
 * Packs sync per-user (STORAGE.loadPacks/loadSubs cache; SYNC mirrors to the
 * server). A pack can be published (is_public) so other members find it in the
 * Shared gallery and either Import a copy or Subscribe (live merge). JSON file
 * export/import stays as an offline fallback. In local-only mode packs live only
 * in localStorage (string ids) and there's no gallery/publish.
 */
"use strict";

/* Homebrew is organised into named packs. HB_PACKS are my editable packs
 * ({id,name,is_public,data}); HB_SUBS are packs I subscribe to, merged read-only.
 * A pack's `data` is {tableKey:[rows]}. Server ids are numbers; offline/local-only
 * packs use string ids and never sync. */
let HB_PACKS = null;
let HB_SUBS = null;
let hbActivePackId = null;    // which of my packs the editor is editing
let hbView = "editor";       // "editor" | "gallery"
let HB_GALLERY = null;       // cached public-pack listing for the gallery
let HB_SUB_IDS = null;       // Set of pack ids I'm subscribed to (for gallery buttons)

let hbTable = "weapons";     // active editor tab (table key)
let hbEditIndex = null;      // index into the active pack's rows being edited; null = adding
let hbReturnTo = "app";      // which screen Back returns to

function hbOnline() {
  return typeof SYNC !== "undefined" && SYNC.enabled && SYNC.enabled();
}

/* ---- per-table editor config ------------------------------------------ */
/* The 17 homebrew-eligible data.js tables and the columns the editor exposes,
 * as 18 tabs -- Ammo and Gear are two views of misc_gear (see isAmmoRow).
 * Field flags: ta = textarea, select = fixed choices (app logic gates on the
 * value), datalist = suggestions but free-form allowed, hint = placeholder.
 *
 * Each nameKey must match NAME_KEYS in tools/promote_homebrew.py and the table
 * catalogue in docs/DATA.md -- tools/check_data.py enforces all three agree.
 * Fields listed here are the only ones an imported pack keeps (mergePackData
 * drops the rest), so adding a column to a table means adding it here too --
 * tools/check_data.py fails on a column with no field, and P09-009 checks the
 * same thing in the browser against the merged tables. A column the editor
 * omits can't be authored AND is stripped from imported packs, which is how a
 * custom row ends up quietly behaving unlike the core row it was modelled on. */
/* Ammunition has no table of its own -- a round is a misc_gear row whose Class
 * starts with "Ammo" -- so its tab is a VIEW of misc_gear: `table` names the
 * array its rows are stored in and `rowFilter` says which of that array's rows
 * belong to the tab. The Gear tab carries the complementary filter, so every
 * gear row shows up under exactly one of the two and retyping a row's Class as
 * Ammo moves it between them. Anything that touches STORED rows (merging,
 * counting, importing, exporting) iterates tables via hbStoredTables(), never
 * tabs, or a shared table would be processed once per tab. */
const isAmmoRow = row => String((row || {}).Class || "").startsWith("Ammo");

const HOMEBREW_CONFIG = {
  /* Animals a summoning spell can turn into something else — Create Darkenbeast
     and Bound Servant both pick from this list. A statblock rather than gear:
     it never costs money, is never carried, and the character never owns one
     except while a spell is up.

     Move and Flight are metres, like every distance in the app. */
  animals: { label: "Animals", nameKey: "Animal", fields: [
    { key: "Animal" },
    { key: "Move", hint: "ground movement in metres" },
    { key: "Flight", hint: "flying movement in metres — blank for anything that can't fly" },
    { key: "Initiative", hint: "flat initiative score, not dice" },
    { key: "Condition", hint: "condition track length in boxes" },
    { key: "Ballistic", hint: "natural ballistic armor — blank for none" },
    { key: "Impact", hint: "natural impact armor — blank for none" },
    { key: "Hardening", hint: "rarely used; the Elephant has 5" },
    { key: "Dodge", hint: "dice rolled to dodge" },
    { key: "Soak", hint: "dice rolled to soak" },
    { key: "Attacks", ta: true,
      hint: "one per entry, pipe-separated: “Bite, Attack 3, Damage 9 | Claw, Attack 9, Damage 3”. "
        + "A summoning spell that raises damage edits the Damage number in place, so keep that word." },
    { key: "Notes", ta: true, hint: "special rules — the Bear's free first claw, the Elephant's Trample" },
  ]},
  rituals: { label: "Rituals", nameKey: "Name", fields: [
    { key: "Name" },
    { key: "Drain", hint: "number" },
    { key: "Time", hint: "e.g. 10 min" },
    { key: "Effect", ta: true },
    { key: "Description", ta: true },
    { key: "Skill Bonus", hint: "flat dice folded into the rating, e.g. \u201cFascination +1\u201d \u2014 comma-separate several" },
    { key: "Skill Note", hint: "situational text shown beside the skill, e.g. \u201cShadow: reroll 1s/2s in urban environments\u201d \u2014 pipe-separate several" },
  ]},
  speaker_spirits: { label: "Spirits", nameKey: "Spirit", fields: [
    { key: "Spirit" },
    { key: "Element", datalist: () => hbDistinct("speaker_elements", "Element") },
    { key: "Cost", hint: "relationship points" },
    { key: "Firearm", ta: true },
    { key: "Protection", ta: true },
    { key: "Drone", ta: true },
    { key: "Digital", ta: true },
    { key: "Physical", ta: true },
    { key: "Appearance", ta: true },
    // Services/Attacks/Special pack several entries into one cell, separated by
    // " | ". Write the spirit's Force as [F] and the sheet resolves it live.
    { key: "Bound Services", ta: true },
    { key: "Movement" },
    { key: "Initiative" },
    { key: "Condition" },
    { key: "Ballistic" },
    { key: "Impact" },
    { key: "Defense Dice" },
    { key: "Statblock Of", hint: "blank unless the stats are a summoned cohort's" },
    { key: "Attacks", ta: true },
    { key: "Special", ta: true },
    { key: "Skill Bonus", hint: "flat dice folded into the rating, e.g. \u201cFascination +1\u201d \u2014 comma-separate several" },
    { key: "Skill Note", hint: "situational text shown beside the skill, e.g. \u201cShadow: reroll 1s/2s in urban environments\u201d \u2014 pipe-separate several" },
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
    { key: "Skill Bonus", hint: "flat dice folded into the rating, e.g. \u201cFascination +1\u201d \u2014 comma-separate several" },
    { key: "Skill Note", hint: "situational text shown beside the skill, e.g. \u201cShadow: reroll 1s/2s in urban environments\u201d \u2014 pipe-separate several" },
  ]},
  misc_gear: { label: "Gear", nameKey: "Item", rowFilter: row => !isAmmoRow(row), fields: [
    { key: "Move", hint: "metres added to (or, negative, taken off) ground movement while this is worn/carried/installed — e.g. “-1”" },
    { key: "AltMove", hint: "a whole extra way of getting around, in metres — pair with MoveMode" },
    { key: "MoveMode", datalist: () => hbDistinct("augments", "MoveMode"),
      hint: "what the AltMove is — e.g. Flight, Water, Swim, Tracked" },
    { key: "Item" },
    { key: "Class", datalist: () => hbDistinct("misc_gear", "Class"),
      hint: "new classes make new picker groups" },
    { key: "Cost", hint: "number" },
    { key: "Dependence", hint: "addiction factor" },
    // Sits with Dependence: both describe something you take rather than carry.
    { key: "Dose", select: () => ["", "1"],
      optionLabel: v => v === "1"
        ? "1 (taken as a dose — gets a Use button in play)"
        : "(carried, not consumed)" },
    { key: "Max Doses",
      hint: "doses that can stack before the extra ones stop counting — blank reads as 1. "
          + "Only meaningful with Dose set" },
    { key: "Weight", hint: "number" },
    { key: "Rarity", hint: "number" },
    { key: "Mount Types", datalist: () => ["Any",
        ...hbDistinct("augments", "Type").filter(t => t !== "Bioware")],
      hint: "augment types this can mount — comma-separated, or Any; blank = none" },
    { key: "Mount ZP", hint: "ZP capacity for mounted augments (exempt from the character's ZP)" },
    { key: "Effect", ta: true },
    { key: "Notes", ta: true, hint: "restrictions or usage notes (e.g. which guns take this ammo)" },
    { key: "Skill Bonus", hint: "flat dice folded into the rating, e.g. \u201cFascination +1\u201d \u2014 comma-separate several" },
    { key: "Skill Note", hint: "situational text shown beside the skill, e.g. \u201cShadow: reroll 1s/2s in urban environments\u201d \u2014 pipe-separate several" },
  ]},
  /* Ammunition. Stored in misc_gear (see isAmmoRow above), but authored on its
     own tab with only the columns a round actually uses, because the thing that
     makes a homebrew round work -- the mod syntax in Effect -- is invisible on
     the general Gear form.

     What a round DOES is prose in Effect, parsed by RULES.ammoStatMods: the
     four shot stats (Acc/Damage/Pen/Barrier) move the shot, and the row stats
     (Mag/Recoil/Hardening/Conceal/Weight/ZR/Rarity) move the weapon it is
     loaded into, so a round can reach everything a weapon mod can. A clause
     that isn't a stat adjustment is kept verbatim as a note under the weapon,
     which is how "Starts fires." and "Range = S." still work. */
  ammo: { label: "Ammo", table: "misc_gear", nameKey: "Item",
    rowFilter: row => isAmmoRow(row), fields: [
    { key: "Item" },
    { key: "Class", select: () => ["Ammo", "Ammo (Projectile)"],
      optionLabel: v => v === "Ammo (Projectile)"
        ? "Ammo (Projectile) — arrows and bolts; bows only"
        : "Ammo — conventional rounds; anything but a bow" },
    { key: "Cost", hint: "number — the price of a full load" },
    { key: "Rarity", hint: "number" },
    { key: "Weight", hint: "number — blank for conventional rounds" },
    { key: "Effect", ta: true,
      hint: "what it does, one clause per sentence. Stat clauses are applied: "
        + "“Acc +2. Damage +3. Pen = 1. Barrier +1. Mag -5. Recoil +1. "
        + "Hardening +2. Conceal -1. Weight +1. ZR +1. Rarity +1. Modes = SS, DT.” "
        + "Either order reads (“+2 Acc”), “=” sets instead of adjusting, and "
        + "“Modes +BF” / “Modes -FA” add or bar a firing mode. Anything else is "
        + "shown as a note under the weapon" },
    { key: "Notes", ta: true,
      hint: "which guns take it, and any rule the numbers don't carry" },
  ]},
  augments: { label: "Augments", nameKey: "Name", fields: [
    { key: "Name", hint: "end with a number (“Reflex Booster 2”) for rank logic" },
    { key: "Type", select: () => hbDistinct("augments", "Type") },
    { key: "ZR", hint: "number" },
    { key: "BI", hint: "number" },
    { key: "Cost", hint: "number" },
    { key: "Rarity", hint: "number" },
    // All six attributes. Core augments only ever raise the first four, but the
    // engine sums whichever columns a row carries (rules.js augmentEffectSums),
    // so Willpower and Charisma work exactly the same way.
    { key: "Strength", hint: "+N" },
    { key: "Body", hint: "+N" },
    { key: "Reaction", hint: "+N" },
    { key: "Intelligence", hint: "+N" },
    { key: "Willpower", hint: "+N" },
    { key: "Charisma", hint: "+N" },
    // Applies to whichever attribute columns the row sets, so it belongs with
    // them rather than beside the other flags further down.
    { key: "RaisesMax", select: () => ["", "1"],
      optionLabel: v => v === "1"
        ? "1 (also raises those attributes' maximums)"
        : "(raises the value only — the cap is unchanged)" },
    { key: "Armor Slot", hint: "N or slot name" },
    { key: "Impact Armor" },
    { key: "ImpArmMin" },
    { key: "Ballistic Armor" },
    { key: "Ban", hint: "name prefixes this bans" },
    { key: "Quality", select: () => ["", "Y"],
      optionLabel: v => v === "Y" ? "Y (Fashionware quality tiers apply)" : "(fixed)" },
    { key: "Req Limb", datalist: () => ["Arm", "Leg", "Any"],
      hint: "Cyberlimbs only — which limb this mounts in; blank defaults to Any" },
    { key: "Damage", hint: "implant attacks only (Spurs, Fangs) — base damage before STR" },
    { key: "STR Mult", hint: "share of Strength added to Damage — default 0.5, 0 for fixed damage" },
    { key: "Move", hint: "metres added to (or, negative, taken off) ground movement — e.g. “-1” for Polypedal-style legs" },
    { key: "AltMove", hint: "alternate movement in metres (Mobi augments)" },
    { key: "MoveMode", datalist: () => hbDistinct("augments", "MoveMode"),
      hint: "what the AltMove is — e.g. Flight, Water, Tracked" },
    { key: "Effect", ta: true },
    { key: "Description", ta: true },
    { key: "Skill Bonus", hint: "flat dice folded into the rating, e.g. \u201cFascination +1\u201d \u2014 comma-separate several" },
    { key: "Skill Note", hint: "situational text shown beside the skill, e.g. \u201cShadow: reroll 1s/2s in urban environments\u201d \u2014 pipe-separate several" },
  ]},
  weapons: { label: "Weapons", nameKey: "Weapon", fields: [
    { key: "Move", hint: "metres added to (or, negative, taken off) ground movement while this is worn/carried/installed — e.g. “-1”" },
    { key: "AltMove", hint: "a whole extra way of getting around, in metres — pair with MoveMode" },
    { key: "MoveMode", datalist: () => hbDistinct("augments", "MoveMode"),
      hint: "what the AltMove is — e.g. Flight, Water, Swim, Tracked" },
    { key: "Weapon" },
    { key: "Type", select: () => Object.keys(WEAPON_TYPE_LABELS),
      optionLabel: k => `${WEAPON_TYPE_LABELS[k]} (${k})` },
    { key: "ZR", hint: "number" },
    { key: "BI", hint: "number" },
    { key: "Cost", hint: "number" },
    { key: "Accuracy", hint: "number" },
    { key: "Reach", hint: "Melee reach or “Ranged”" },
    { key: "Hands", select: () => ["", "1H", "2H"],
      optionLabel: v => v === "2H" ? "2H (needs both hands)"
                      : v === "1H" ? "1H (one-handed)" : "(unspecified — treated as 1H)" },
    { key: "Damage", hint: "e.g. 8; for Melee this is the base added to a share of Strength" },
    { key: "STR Mult", hint: "Melee only, share of Strength added — default 0.5, e.g. 1 for full STR" },
    { key: "StrCost", hint: "Bows only — cost per point of Minimum Strength. Setting it makes the weapon STR-rated: leave Cost, Damage and Rarity blank" },
    { key: "StrDmg", hint: "Bows only — added to Minimum Strength for damage" },
    { key: "Damage Bonus", hint: "Melee only, e.g. +2d6" },
    { key: "Firing modes", hint: "e.g. SS, BF, FA" },
    { key: "Ammo", hint: "magazine size" },
    // Energy weapons spend Heat instead of a magazine. The sheet reads these
    // columns and falls back to parsing "Heat N / max N" out of Notes.
    { key: "Heat", hint: "Energy only — heat built per shot" },
    { key: "Max Heat", hint: "Energy only — heat capacity before it overheats" },
    { key: "Pen", hint: "armor penetration" },
    { key: "Bar", hint: "Barrier rating 0-5 — blank if it doesn't apply" },
    { key: "Conceal", hint: "number" },
    { key: "Weight", hint: "number" },
    { key: "Hardening", hint: "number" },
    { key: "Rarity", hint: "number" },
    { key: "Upgr1_Cost", hint: "Upgrade 1 cost — Woolongs plus optional special part, e.g. “1500 + 50 Tc”" },
    { key: "Upgr1_Eff", hint: "Upgrade 1 effect, e.g. “Barrel Detailing (+1 damage)”" },
    { key: "Upgr2_Cost", hint: "Upgrade 2 cost — same format as Upgrade 1" },
    { key: "Upgr2_Eff", hint: "Upgrade 2 effect" },
    { key: "Integrated Smart", select: () => ["", "1"],
      optionLabel: v => v === "1" ? "1 (smart at no extra cost)" : "(opt-in smart pays the multiplier)" },
    { key: "Integrated Mods", datalist: () => hbDistinct("weapon_mods", "Modification"),
      hint: "mods built into the weapon — fitted free and they don't use up their slot, "
        + "so you can still add another of the same kind. Comma-separate several" },
    { key: "Oneshot", select: () => ["", "1"],
      optionLabel: v => v === "1" ? "1 (sealed — cannot be reloaded)" : "(reloads normally)" },
    { key: "Requires", datalist: () => hbDistinct("weapons", "Weapon"),
      hint: "another weapon that must be equipped to use this (under-barrel mounts)" },
    { key: "Mount Types", datalist: () => ["Any",
        ...hbDistinct("augments", "Type").filter(t => t !== "Bioware")],
      hint: "augment types this can mount — comma-separated, or Any; blank = none" },
    { key: "Mount ZP", hint: "ZP capacity for mounted augments (exempt from the character's ZP)" },
    { key: "Notes", ta: true },
    { key: "Skill Bonus", hint: "flat dice folded into the rating, e.g. \u201cFascination +1\u201d \u2014 comma-separate several" },
    { key: "Skill Note", hint: "situational text shown beside the skill, e.g. \u201cShadow: reroll 1s/2s in urban environments\u201d \u2014 pipe-separate several" },
  ]},
  armor: { label: "Armor", nameKey: "Armor", fields: [
    { key: "Move", hint: "metres added to (or, negative, taken off) ground movement while this is worn/carried/installed — e.g. “-1”" },
    { key: "AltMove", hint: "a whole extra way of getting around, in metres — pair with MoveMode" },
    { key: "MoveMode", datalist: () => hbDistinct("augments", "MoveMode"),
      hint: "what the AltMove is — e.g. Flight, Water, Swim, Tracked" },
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
    { key: "Skill Bonus", hint: "flat dice folded into the rating, e.g. \u201cFascination +1\u201d \u2014 comma-separate several" },
    { key: "Skill Note", hint: "situational text shown beside the skill, e.g. \u201cShadow: reroll 1s/2s in urban environments\u201d \u2014 pipe-separate several" },
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
    { key: "Skill Bonus", hint: "flat dice folded into the rating, e.g. \u201cFascination +1\u201d \u2014 comma-separate several" },
    { key: "Skill Note", hint: "situational text shown beside the skill, e.g. \u201cShadow: reroll 1s/2s in urban environments\u201d \u2014 pipe-separate several" },
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
    { key: "Skill Bonus", hint: "flat dice folded into the rating, e.g. \u201cFascination +1\u201d \u2014 comma-separate several" },
    { key: "Skill Note", hint: "situational text shown beside the skill, e.g. \u201cShadow: reroll 1s/2s in urban environments\u201d \u2014 pipe-separate several" },
  ]},
  weapon_mods: { label: "Weapon Mods", nameKey: "Modification", fields: [
    { key: "Move", hint: "metres added to (or, negative, taken off) ground movement while this is worn/carried/installed — e.g. “-1”" },
    { key: "AltMove", hint: "a whole extra way of getting around, in metres — pair with MoveMode" },
    { key: "MoveMode", datalist: () => hbDistinct("augments", "MoveMode"),
      hint: "what the AltMove is — e.g. Flight, Water, Swim, Tracked" },
    { key: "Modification" },
    { key: "Slot", select: () => hbDistinct("weapon_mods", "Slot") },
    { key: "ZR", hint: "number" },
    { key: "BI", hint: "number" },
    { key: "Cost", hint: "number, or 25% for a share of the weapon's cost" },
    { key: "Effect", ta: true },
    { key: "GrantsWeapon", datalist: () => hbDistinct("weapons", "Weapon"),
      hint: "an underbarrel weapon this mod IS — name a row from the weapons table and "
        + "fitting the mod adds that gun, free (the mod already charged for it) and marked Underbarrel" },
    { key: "RecoilMod", hint: "+/-N — added to the shooter's recoil capacity, but only for the gun this is fitted to" },
    { key: "AccMod", hint: "+/-N" },
    { key: "MagMod", hint: "e.g. x1.5" },
    { key: "HardMod", hint: "+/-N" },
    { key: "Conceal Mod", hint: "+/-N" },
    { key: "Req Type", select: () => ["", ...Object.keys(WEAPON_TYPE_LABELS)],
      optionLabel: k => k ? `${WEAPON_TYPE_LABELS[k]} (${k}) only` : "(any weapon type)" },
    { key: "Skill Bonus", hint: "flat dice folded into the rating, e.g. \u201cFascination +1\u201d \u2014 comma-separate several" },
    { key: "Skill Note", hint: "situational text shown beside the skill, e.g. \u201cShadow: reroll 1s/2s in urban environments\u201d \u2014 pipe-separate several" },
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
    { key: "Skill Bonus", hint: "flat dice folded into the rating, e.g. \u201cFascination +1\u201d \u2014 comma-separate several" },
    { key: "Skill Note", hint: "situational text shown beside the skill, e.g. \u201cShadow: reroll 1s/2s in urban environments\u201d \u2014 pipe-separate several" },
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
    { key: "Skill Bonus", hint: "flat dice folded into the rating, e.g. \u201cFascination +1\u201d \u2014 comma-separate several" },
    { key: "Skill Note", hint: "situational text shown beside the skill, e.g. \u201cShadow: reroll 1s/2s in urban environments\u201d \u2014 pipe-separate several" },
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
    { key: "Skill Bonus", hint: "flat dice folded into the rating, e.g. \u201cFascination +1\u201d \u2014 comma-separate several" },
    { key: "Skill Note", hint: "situational text shown beside the skill, e.g. \u201cShadow: reroll 1s/2s in urban environments\u201d \u2014 pipe-separate several" },
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
    { key: "Skill Bonus", hint: "flat dice folded into the rating, e.g. \u201cFascination +1\u201d \u2014 comma-separate several" },
    { key: "Skill Note", hint: "situational text shown beside the skill, e.g. \u201cShadow: reroll 1s/2s in urban environments\u201d \u2014 pipe-separate several" },
  ]},
  vehicle_mods: { label: "Vehicle Mods", nameKey: "Vehicle Mod", fields: [
    { key: "Vehicle Mod" },
    { key: "ZR", hint: "number" },
    { key: "BI", hint: "number" },
    { key: "Cost", hint: "number" },
    { key: "Weight", hint: "number" },
    { key: "Target", select: () => ["", "weapon"],
      optionLabel: v => v === "weapon" ? "weapon (fits a mounted gun)" : "(fits the vehicle itself)" },
    { key: "ModeEffect", ta: true },
    { key: "Skill Bonus", hint: "flat dice folded into the rating, e.g. \u201cFascination +1\u201d \u2014 comma-separate several" },
    { key: "Skill Note", hint: "situational text shown beside the skill, e.g. \u201cShadow: reroll 1s/2s in urban environments\u201d \u2014 pipe-separate several" },
  ]},
  drone_mods: { label: "Drone Mods", nameKey: "Drone Mod", fields: [
    { key: "Drone Mod" },
    { key: "ZR", hint: "number" },
    { key: "BI", hint: "number" },
    { key: "Cost", hint: "number" },
    { key: "Weight", hint: "number" },
    { key: "Target", select: () => ["", "weapon"],
      optionLabel: v => v === "weapon" ? "weapon (fits a mounted gun)" : "(fits the drone itself)" },
    { key: "ModeEffect", ta: true },
    { key: "Skill Bonus", hint: "flat dice folded into the rating, e.g. \u201cFascination +1\u201d \u2014 comma-separate several" },
    { key: "Skill Note", hint: "situational text shown beside the skill, e.g. \u201cShadow: reroll 1s/2s in urban environments\u201d \u2014 pipe-separate several" },
  ]},
};

/* Columns a row genuinely needs to behave like the thing it claims to be.
 *
 * Every numeric column is read through `asNumber`, so a blank one is silently 0
 * — a weapon authored with nothing but a name is accepted, costs nothing, does
 * no damage, contributes no ZR, and raises nothing anywhere. Nothing here
 * BLOCKS a save (the free-form data model is deliberate, and a placeholder row
 * is a reasonable thing to want): leaving one blank asks for confirmation and
 * says what it will read as. Only the name is genuinely required.
 *
 * Listed per table rather than as a flag on each field so the shape of the
 * requirement is visible in one place. Keys must exist in HOMEBREW_CONFIG. */
const HOMEBREW_REQUIRED = {
  rituals: ["Drain"],
  speaker_spirits: ["Element", "Cost"],
  spells: ["School", "Drain", "Cost"],
  misc_gear: ["Class", "Cost"],
  ammo: ["Class", "Cost"],
  augments: ["Type", "ZR", "BI", "Cost"],
  weapons: ["Type", "Cost", "Damage"],
  armor: ["Slot", "Cost", "Ballistic", "Impact"],
  vehicles: ["Cost", "Body", "Move", "Handling"],
  drones: ["Cost", "Body", "Move", "Handling", "WW", "Hard Point"],
  weapon_mods: ["Slot", "Cost"],
  vehicle_ballistic_weapons: ["Cost", "Damage", "Weight"],
  vehicle_energy_weapons: ["Cost", "Damage", "Weight"],
  drone_ballistic_weapons: ["Cost", "Damage", "Weight"],
  drone_energy_weapons: ["Cost", "Damage", "Weight"],
  vehicle_mods: ["Cost", "Weight"],
  drone_mods: ["Cost", "Weight"],
};

/** The data.js table a tab's rows are stored in (its own key unless it is a
 *  view of another table). */
function hbTableKey(tabKey) {
  return (HOMEBREW_CONFIG[tabKey] || {}).table || tabKey;
}

/** A pack's rows for one TAB, each with its index in the stored array -- the
 *  index is what edit and delete work on, so a filtered view still writes to
 *  the right row. */
function hbTabRows(pack, tabKey) {
  const cfg = HOMEBREW_CONFIG[tabKey] || {};
  const all = (pack && pack.data && pack.data[hbTableKey(tabKey)]) || [];
  return all.map((row, i) => ({ row, i }))
    .filter(e => !cfg.rowFilter || cfg.rowFilter(e.row));
}

/** The stored tables behind the tabs: table -> {nameKey, fields}, with the
 *  fields of every tab that shares the table unioned, since an imported row
 *  keeps whatever column any of those tabs can author. */
function hbStoredTables() {
  const out = new Map();
  for (const [key, cfg] of Object.entries(HOMEBREW_CONFIG)) {
    const table = hbTableKey(key);
    const prev = out.get(table);
    if (!prev) { out.set(table, { nameKey: cfg.nameKey, fields: [...cfg.fields] }); continue; }
    for (const f of cfg.fields)
      if (!prev.fields.some(x => x.key === f.key)) prev.fields.push(f);
  }
  return out;
}

/** Which tab a stored row belongs to — for naming the row's kind when the
 *  editor talks about a table it doesn't have open. */
function hbTabForRow(table, row) {
  const keys = Object.keys(HOMEBREW_CONFIG).filter(k => hbTableKey(k) === table);
  return keys.find(k => {
    const f = HOMEBREW_CONFIG[k].rowFilter;
    return f && f(row);
  }) || keys[0] || table;
}

/** Required columns of `tableKey` that `row` leaves blank. */
function hbMissingColumns(tableKey, row) {
  return (HOMEBREW_REQUIRED[tableKey] || [])
    .filter(col => String(row[col] ?? "").trim() === "");
}

/* Sorted unique non-empty values of one column, read from the live merged
 * table so existing custom rows contribute their groups too. */
function hbDistinct(tableKey, col) {
  const seen = new Set();
  for (const row of DATA_BUNDLE.tables[tableKey] || [])
    if (row[col] != null && String(row[col]).trim() !== "") seen.add(String(row[col]));
  return [...seen].sort();
}

/* ---- pack state ---------------------------------------------------------- */
function hbLoad() {
  HB_PACKS = STORAGE.loadPacks();
  HB_SUBS = STORAGE.loadSubs();
  if (!HB_PACKS.some(p => p.id === hbActivePackId))
    hbActivePackId = HB_PACKS.length ? HB_PACKS[0].id : null;
}
function activePack() {
  if (!HB_PACKS) hbLoad();
  return HB_PACKS.find(p => p.id === hbActivePackId) || null;
}
function subscribedPacks() { if (!HB_SUBS) hbLoad(); return HB_SUBS; }

/* ---- merge into the live game data ------------------------------------ */
/* Strip prior custom rows, then merge my packs (editable) followed by
 * subscribed packs (read-only). First writer of a name wins, so core data keeps
 * its name, then my packs, then subscriptions; skipped collisions are recorded
 * on HB_COLLISIONS for the editor to surface. In-place splice/push keeps the
 * array references rules.js captured at load. */
let HB_COLLISIONS = [];
function mergeCustomContent() {
  if (!HB_PACKS) hbLoad();
  HB_COLLISIONS = [];
  const sources = [
    ...HB_PACKS.map(p => ({ pack: p, readOnly: false })),
    ...subscribedPacks().map(p => ({ pack: p, readOnly: true })),
  ];
  for (const [key, spec] of hbStoredTables()) {
    const table = DATA_BUNDLE.tables[key];
    if (!table) continue;
    for (let i = table.length - 1; i >= 0; i--)
      if (table[i].Custom === "Y") table.splice(i, 1);
    const nameKey = spec.nameKey;
    const taken = new Set(table.map(r => String(r[nameKey] || "").trim().toLowerCase()));
    for (const src of sources) {
      for (const row of (src.pack.data && src.pack.data[key]) || []) {
        const nm = String(row[nameKey] || "").trim().toLowerCase();
        if (!nm) continue;
        if (taken.has(nm)) {
          HB_COLLISIONS.push({ table: hbTabForRow(key, row), name: row[nameKey],
            pack: src.pack.name || "", owner: src.pack.owner || "" });
          continue;
        }
        taken.add(nm);
        const merged = { ...row, Custom: "Y", PackId: src.pack.id };
        if (src.readOnly) { merged.ReadOnly = "Y"; merged.Source = src.pack.owner || src.pack.name || ""; }
        table.push(merged);
      }
    }
  }
}

/* Persist the active pack (local cache + best-effort server), then re-merge. */
function hbSave() {
  STORAGE.cachePacks(HB_PACKS);
  const pack = activePack();
  if (pack && hbOnline() && typeof pack.id === "number") SYNC.savePack(pack.id, pack.data);
  mergeCustomContent();
}

/* ---- pack CRUD ----------------------------------------------------------- */
async function hbCreatePack(name) {
  name = String(name || "").trim() || "New Pack";
  const data = STORAGE.emptyPackData();
  let id = STORAGE.newLocalPackId();
  if (hbOnline()) { const res = await SYNC.createPack(name, data); if (res && res.id != null) id = res.id; }
  HB_PACKS.push({ id, name, is_public: false, data });
  hbActivePackId = id;
  STORAGE.cachePacks(HB_PACKS);
  mergeCustomContent();
}
function hbRenamePack(pack, name) {
  pack.name = String(name || "").trim() || pack.name;
  STORAGE.cachePacks(HB_PACKS);
  if (hbOnline() && typeof pack.id === "number") SYNC.savePack(pack.id, pack.data, pack.name);
}
function hbDeletePack(pack) {
  const i = HB_PACKS.indexOf(pack);
  if (i < 0) return;
  HB_PACKS.splice(i, 1);
  if (hbActivePackId === pack.id) hbActivePackId = HB_PACKS.length ? HB_PACKS[0].id : null;
  STORAGE.cachePacks(HB_PACKS);
  if (hbOnline() && typeof pack.id === "number") SYNC.deletePack(pack.id);
  mergeCustomContent();
}
async function hbTogglePublic(pack) {
  if (!hbOnline() || typeof pack.id !== "number") {
    alert("Sign in to publish a pack so other members can find it.");
    return;
  }
  const res = await SYNC.setPackVisibility(pack.id, !pack.is_public);
  if (res) { pack.is_public = res.is_public; STORAGE.cachePacks(HB_PACKS); }
  else alert("Couldn't change sharing — the pack may not be saved to the server yet.");
}

/* ---- screen management ------------------------------------------------- */
function enterHomebrew() {
  hbReturnTo = $("#sheet").hidden ? "app" : "sheet";
  hbEditIndex = null; hbView = "editor";
  hbLoad();
  if (typeof removeSkipLink === "function") removeSkipLink();
  $("#app").hidden = true;
  $("#sheet").hidden = true;
  $("#homebrew").hidden = false;
  renderHomebrew();
  window.scrollTo(0, 0);
  // Pull the latest packs/subscriptions in the background, then repaint.
  if (hbOnline()) hbRefreshFromServer().then(() => { if (!$("#homebrew").hidden) renderHomebrew(); });
}

/* Refresh my packs + subscriptions from the server into the local cache. When
 * signed in the server is the source of truth for packs (offline-only local
 * packs use string ids and simply aren't returned). */
async function hbRefreshFromServer() {
  const mine = await SYNC.listMyPacks();
  if (mine) STORAGE.cachePacks(mine);
  const subs = await SYNC.listSubs();
  if (subs) STORAGE.cacheSubs(subs);
  hbLoad();
  mergeCustomContent();
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

function packItemCount(pack) {
  if (!pack || !pack.data) return 0;
  let n = 0;
  for (const table of hbStoredTables().keys()) n += (pack.data[table] || []).length;
  return n;
}

function renderHomebrew() {
  const root = $("#homebrew");
  root.innerHTML = "";
  if (hbView === "gallery") { renderHomebrewGallery(root); return; }
  renderHomebrewEditor(root);
}

function renderHomebrewEditor(root) {
  const cfg = HOMEBREW_CONFIG[hbTable];
  const pack = activePack();
  // `store` is the array rows live in; `rows` is this tab's view of it, each
  // entry carrying its index in `store` so edits land on the right row.
  const store = pack ? pack.data[hbTableKey(hbTable)] : [];
  const rows = pack ? hbTabRows(pack, hbTable) : [];

  const importInput = el("input", {
    type: "file", accept: ".json,application/json", hidden: "1",
    onchange: async e => {
      const file = e.target.files[0]; e.target.value = "";
      if (!file) return;
      let parsed; try { parsed = JSON.parse(await file.text()); } catch { parsed = null; }
      importHomebrewFile(parsed);
    },
  });

  root.append(el("div", { class: "hb-head" },
    el("div", {},
      el("h2", {}, "Homebrew Content"),
      el("p", { class: "hint" },
        "Custom items merge into every picker and price calculation. Organise them "
        + "into packs, publish a pack to share it with other members, or subscribe "
        + "to someone else's — subscribed items appear everywhere, read-only.")),
    el("div", { class: "hb-head-actions" },
      el("button", { class: "btn ghost", onclick: exitHomebrew }, "← Back"),
      el("button", { class: "btn", onclick: openHomebrewGallery }, "Browse Shared"),
      pack ? el("button", { class: "btn", onclick: () => exportActivePack() }, "Export File") : null,
      el("button", { class: "btn", onclick: () => importInput.click() }, "Import File"),
      importInput)));

  /* ---- pack bar: choose / create / rename / delete / publish ------------- */
  const packBar = el("div", { class: "card hb-packbar" });
  if (!HB_PACKS.length) {
    packBar.append(el("p", { class: "hint" }, "You have no homebrew packs yet."),
      el("button", { class: "btn-add", onclick: async () => {
        const name = (prompt("Name this pack:", "My Homebrew") || "").trim();
        if (name === "") return;
        await hbCreatePack(name); renderHomebrew();
      } }, "+ Create a pack"));
  } else {
    const sel = el("select", { onchange: e => { hbActivePackId = castPackId(e.target.value); hbEditIndex = null; renderHomebrew(); } },
      ...HB_PACKS.map(p => el("option", { value: String(p.id), ...(p.id === hbActivePackId ? { selected: 1 } : {}) },
        `${p.name} (${packItemCount(p)})${p.is_public ? " · public" : ""}`)));
    packBar.append(el("div", { class: "hb-packrow" },
      el("span", { class: "hb-field-name" }, "Pack"), sel,
      pack && pack.is_public ? el("span", { class: "sh-tag magic" }, "public") : null,
      el("button", { class: "btn small", onclick: async () => {
        const name = (prompt("New pack name:", "New Pack") || "").trim();
        if (name === "") return;
        await hbCreatePack(name); renderHomebrew();
      } }, "+ New"),
      el("button", { class: "btn small", onclick: () => {
        const name = (prompt("Rename pack:", pack.name) || "").trim();
        if (name === "" || name === pack.name) return;
        hbRenamePack(pack, name); renderHomebrew();
      } }, "Rename"),
      el("button", { class: "btn small",
        title: hbOnline() ? "" : "Sign in to publish a pack",
        onclick: async () => { await hbTogglePublic(pack); renderHomebrew(); } },
        pack.is_public ? "Make private" : "Publish"),
      el("button", { class: "row-del", title: "Delete pack",
        onclick: () => {
          if (!confirm(`Delete the whole pack “${pack.name}” and its ${packItemCount(pack)} item(s)?`)) return;
          hbDeletePack(pack); renderHomebrew();
        } }, "✕ Delete pack")));
  }
  root.append(packBar);

  if (!pack) return;   // nothing more to show until a pack exists

  /* ---- table tabs (counts are for the active pack) ---------------------- */
  root.append(el("div", { class: "hb-tabs" },
    ...Object.entries(HOMEBREW_CONFIG).map(([key, c]) =>
      el("button", {
        class: "hb-tab" + (key === hbTable ? " active" : ""),
        onclick: () => { hbTable = key; hbEditIndex = null; renderHomebrew(); },
      }, `${c.label}${hbTabRows(pack, key).length ? ` (${hbTabRows(pack, key).length})` : ""}`))));

  /* ---- this pack's rows for the active table --------------------------- */
  const list = el("div", { class: "card" }, el("h3", {}, `${pack.name} — ${cfg.label}`));
  if (!rows.length) {
    list.append(el("p", { class: "hint" }, `No ${cfg.label.toLowerCase()} in this pack yet — add one below.`));
  } else {
    const t = el("table");
    rows.forEach(({ row, i }) => {
      const missing = hbMissingColumns(hbTable, row);
      t.append(el("tr", {},
        el("td", {}, el("b", {}, row[cfg.nameKey] || "(unnamed)"),
          el("div", { class: "sub" }, hbRowSummary(cfg, row)),
          missing.length
            ? el("div", { class: "sub", style: "color:var(--amber)" },
                `⚠ blank: ${missing.join(", ")} — reads as 0 / none`)
            : null),
        el("td", { class: "hb-row-actions" },
          el("button", { class: "btn small", onclick: () => { hbEditIndex = i; renderHomebrew(); } }, "Edit"),
          el("button", { class: "row-del", title: "Delete",
            onclick: () => {
              const name = row[cfg.nameKey] || "(unnamed)";
              if (!confirm(`Delete ${name}? Characters that own it keep the name but lose its stats.`)) return;
              store.splice(i, 1);
              if (hbEditIndex === i) hbEditIndex = null;
              hbSave(); renderHomebrew();
            } }, "✕"))));
    });
    list.append(t);
  }
  root.append(list);

  /* ---- add / edit form (writes into the active pack) ------------------- */
  const editing = hbEditIndex != null ? store[hbEditIndex] : null;
  const form = el("div", { class: "card" },
    el("h3", {}, editing ? `Edit: ${editing[cfg.nameKey] || "(unnamed)"}` : `Add ${cfg.label.replace(/s$/, "")}`));
  const inputs = {};
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
      control = el("textarea", { rows: "2" }); control.value = current;
    } else {
      const attrs = { type: "text", ...(f.hint ? { placeholder: f.hint } : {}) };
      if (f.datalist) {
        const listId = `hb-dl-${hbTable}-${f.key.replace(/\W+/g, "-")}`;
        attrs.list = listId;
        grid.append(el("datalist", { id: listId }, ...f.datalist().map(v => el("option", { value: v }))));
      }
      control = el("input", attrs); control.value = current;
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
        // Collide against core + other packs + other rows in THIS pack.
        const taken = new Set(DATA_BUNDLE.tables[hbTableKey(hbTable)]
          .filter(r => !(r.Custom === "Y" && r.PackId === pack.id))
          .map(r => String(r[cfg.nameKey] || "").trim().toLowerCase()));
        // The whole stored table, not just this tab's view of it: a round and a
        // piece of gear share the misc_gear namespace and can't share a name.
        store.forEach((r, i) => { if (i !== hbEditIndex) taken.add(String(r[cfg.nameKey] || "").trim().toLowerCase()); });
        if (taken.has(name.toLowerCase())) {
          alert(`A ${cfg.label.replace(/s$/, "").toLowerCase()} named “${name}” already exists in the core data or another pack.`);
          return;
        }
        // Blank required columns read as 0 / none everywhere downstream, which
        // looks like the item not working rather than the row being incomplete.
        const missing = hbMissingColumns(hbTable, row);
        if (missing.length && !confirm(
          `“${name}” leaves these columns blank:\n\n  ${missing.join(", ")}\n\n`
          + "Blank numbers read as 0 and blank categories as none, so it will "
          + "cost nothing and do nothing in those respects.\n\nAdd it anyway?"))
          return;
        if (editing) store[hbEditIndex] = row; else store.push(row);
        hbEditIndex = null;
        hbSave(); renderHomebrew();
      } }, editing ? "Save Changes" : "Add"),
      editing ? el("button", { class: "btn ghost", onclick: () => { hbEditIndex = null; renderHomebrew(); } }, "Cancel") : null));
  root.append(form);

  /* ---- rows that never made it in -------------------------------------- */
  /* First writer of a name wins, so a homebrew row whose name matches core
   * data or an earlier pack is dropped at merge time. Without this card the
   * only symptom is content that simply never appears in any picker — the most
   * confusing possible failure, since the row is still sitting in the editor
   * looking fine. Covers every pack, not just the active one. */
  if (HB_COLLISIONS.length) {
    const card = el("div", { class: "card" },
      el("h3", {}, `Not merged — name already taken (${HB_COLLISIONS.length})`),
      el("p", { class: "hint" },
        "Core data wins over your packs, and your packs win over subscriptions. "
        + "These rows keep their place in their pack but never appear in a picker. "
        + "Rename them to bring them back."));
    const t = el("table");
    HB_COLLISIONS.forEach(c => t.append(el("tr", {},
      el("td", {}, el("b", {}, c.name),
        el("div", { class: "sub" }, (HOMEBREW_CONFIG[c.table] || {}).label || c.table)),
      el("td", { class: "sub" },
        `in ${c.pack || "(unnamed pack)"}${c.owner ? ` by ${c.owner}` : ""}`))));
    card.append(t);
    root.append(card);
  }

  /* ---- subscribed packs (read-only) ------------------------------------ */
  const subs = subscribedPacks();
  if (subs.length) {
    const card = el("div", { class: "card" }, el("h3", {}, "Subscribed packs (read-only)"));
    subs.forEach(sp => card.append(el("div", { class: "hb-packrow" },
      el("b", {}, sp.name),
      el("span", { class: "sub" }, `by ${sp.owner || "?"} · ${packItemCount(sp)} item(s)`),
      el("button", { class: "btn small", onclick: async () => {
        if (!confirm(`Unsubscribe from “${sp.name}”? Its items stop appearing in your pickers.`)) return;
        await SYNC.unsubscribePack(sp.id);
        await hbRefreshFromServer();
        renderHomebrew();
      } }, "Unsubscribe"))));
    root.append(card);
  }

  /* ---- built-in reference ---------------------------------------------- */
  const builtins = DATA_BUNDLE.tables[hbTableKey(hbTable)]
    .filter(r => r.Custom !== "Y" && (!cfg.rowFilter || cfg.rowFilter(r)));
  const refTable = el("table");
  for (const row of builtins)
    refTable.append(el("tr", {}, el("td", {}, el("b", {}, row[cfg.nameKey] || ""),
      el("div", { class: "sub" }, hbRowSummary(cfg, row)))));
  root.append(el("details", { class: "card hb-ref" },
    el("summary", {}, `Built-in ${cfg.label} reference (${builtins.length})`), refTable));
}

/* Pack ids are numbers (server) or strings (local). <select> gives strings, so
 * coerce back to a number when the id is numeric. */
function castPackId(v) {
  return HB_PACKS.some(p => p.id === Number(v)) ? Number(v) : v;
}

/* ---- shared-homebrew gallery ------------------------------------------- */
async function openHomebrewGallery() {
  if (!hbOnline()) { alert("Sign in to browse packs shared by other members."); return; }
  hbView = "gallery"; HB_GALLERY = null;
  renderHomebrew();
  HB_GALLERY = await SYNC.listPublicPacks();
  HB_SUB_IDS = new Set(subscribedPacks().map(s => s.id));
  renderHomebrew();
}

function renderHomebrewGallery(root) {
  root.append(el("div", { class: "hb-head" },
    el("div", {}, el("h2", {}, "Shared Homebrew"),
      el("p", { class: "hint" }, "Packs published by other members. Subscribe to merge a pack live "
        + "(read-only, always current), or import a copy into one of your own packs.")),
    el("div", { class: "hb-head-actions" },
      el("button", { class: "btn ghost", onclick: () => { hbView = "editor"; renderHomebrew(); } }, "← Back to my packs"))));

  if (HB_GALLERY === null) { root.append(el("p", { class: "hint" }, "Loading…")); return; }
  const myIds = new Set(HB_PACKS.map(p => p.id));
  const packs = HB_GALLERY;
  if (!packs.length) { root.append(el("div", { class: "card" }, el("p", { class: "hint" }, "No shared packs yet."))); return; }

  const card = el("div", { class: "card" });
  const t = el("table");
  packs.forEach(p => {
    const mine = myIds.has(p.id);
    const subd = HB_SUB_IDS && HB_SUB_IDS.has(p.id);
    t.append(el("tr", {},
      el("td", {}, el("b", {}, p.name), mine ? el("span", { class: "sh-tag" }, "yours") : null,
        el("div", { class: "sub" }, `by ${p.owner} · ${p.item_count} item(s)`)),
      el("td", { class: "hb-row-actions" },
        el("button", { class: "btn small", onclick: () => viewSharedPack(p.id) }, "View"),
        mine ? null : el("button", { class: "btn small", onclick: () => importSharedPack(p) }, "Import copy"),
        mine ? null : el("button", { class: "btn small" + (subd ? " ghost" : ""),
          onclick: async () => {
            if (subd) await SYNC.unsubscribePack(p.id); else await SYNC.subscribePack(p.id);
            await hbRefreshFromServer();
            HB_SUB_IDS = new Set(subscribedPacks().map(s => s.id));
            renderHomebrew();
          } }, subd ? "Unsubscribe" : "Subscribe"))));
    if (p._preview) {
      const pre = el("td", { colspan: "2" }, el("div", { class: "sub" }, p._preview));
      t.append(el("tr", {}, pre));
    }
  });
  card.append(t);
  root.append(card);
}

async function viewSharedPack(id) {
  const full = await SYNC.fetchPublicPack(id);
  const p = HB_GALLERY.find(x => x.id === id);
  if (!p) return;
  if (!full) { p._preview = "Pack is no longer available."; renderHomebrew(); return; }
  const names = [];
  for (const [key, spec] of hbStoredTables())
    for (const row of full.data[key] || []) names.push(row[spec.nameKey]);
  p._preview = names.length ? "Contains: " + names.join(", ") : "(empty pack)";
  renderHomebrew();
}

/* Import a copy of a shared pack's items into one of my packs (a snapshot;
 * later author edits won't propagate). Merges into the active pack, or creates
 * a new one named after the source. Skips name collisions. */
async function importSharedPack(meta) {
  const full = await SYNC.fetchPublicPack(meta.id);
  if (!full) { alert("That pack is no longer available."); return; }
  let target = activePack();
  if (!target) { await hbCreatePack(full.name + " (imported)"); target = activePack(); }
  const { imported, skipped } = mergePackData(target, full.data);
  hbSave();
  renderHomebrew();
  alert(`Imported ${imported} item(s) into “${target.name}”.`
    + (skipped.length ? ` Skipped ${skipped.length} duplicate name(s).` : ""));
}

/* Merge rows from `src` data into `target` pack, coercing to the configured
 * columns and skipping names already present anywhere (core/packs/subs). */
function mergePackData(target, src) {
  let imported = 0; const skipped = [];
  for (const [key, spec] of hbStoredTables()) {
    if (!Array.isArray(src[key])) continue;
    const taken = new Set(DATA_BUNDLE.tables[key].map(r => String(r[spec.nameKey] || "").trim().toLowerCase()));
    for (const raw of src[key]) {
      if (!raw || typeof raw !== "object") continue;
      const row = {}; for (const f of spec.fields) row[f.key] = String(raw[f.key] ?? "").trim();
      row.Custom = "Y";
      const name = row[spec.nameKey];
      if (!name) continue;
      if (taken.has(name.toLowerCase())) { skipped.push(name); continue; }
      taken.add(name.toLowerCase());
      target.data[key].push(row);
      imported++;
    }
  }
  return { imported, skipped };
}

/* ---- file export / import (offline fallback, per active pack) ----------- */
function exportActivePack() {
  const pack = activePack();
  if (!pack) return;
  const out = { format: "sinless-homebrew", version: 2, name: pack.name, ...pack.data };
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: `sinless-homebrew-${STORAGE.sanitizeName(pack.name)}.json` });
  a.click();
  URL.revokeObjectURL(url);
}

/* Import a JSON pack file into the active pack (creating one if needed). */
async function importHomebrewFile(parsed) {
  const known = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    && [...hbStoredTables().keys()].some(k => Array.isArray(parsed[k]));
  if (!known) { alert("That file doesn't look like a Sinless homebrew pack."); return; }
  let target = activePack();
  if (!target) { await hbCreatePack(String(parsed.name || "Imported")); target = activePack(); }
  const { imported, skipped } = mergePackData(target, parsed);
  hbSave();
  renderHomebrew();
  alert(`Imported ${imported} item(s) into “${target.name}”.`
    + (skipped.length ? ` Skipped ${skipped.length} duplicate name(s): ${skipped.slice(0, 8).join(", ")}${skipped.length > 8 ? ", …" : ""}.` : ""));
}
