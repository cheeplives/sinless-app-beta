/**
 * sheet.js — the interactive play-mode character sheet (after Finalize).
 *
 * Loaded after app.js and shares its globals (DATA/CHAR/CALC, el, $, fmt,
 * recalc). Chargen and play mode are two top-level views: #app (rail +
 * chargen tabs) and #sheet (this file); enterSheet()/exitSheet() toggle
 * between them. All play state lives under CHAR.play and is auto-saved
 * (debounced) to localStorage whenever it changes — no explicit Save button
 * in play mode.
 *
 * Derived stats (pools, condition maxima, attribute finals) still come from
 * CALC: rules.calculate() applies play advances AND play purchases (gear,
 * augments, amp powers, spells bought during play) on top of the chargen
 * build when character.finalized is true, so everything bought here flows
 * through the same engine as chargen.
 *
 * Kismet rules (per KISMET.docx):
 *   raise attribute +1    new level ≤10: 3 · 11–15: 4 · 16+: 5 Kismet
 *   raise skill +1        current skill level in Kismet, cannot exceed 6
 *   new skill (rank 1)    4 Kismet
 *   every 10 earned       +1 Kismet pool -> pick a boon (windfall / free
 *                         asset / skill mastery 6→7); every 2nd is a major
 * Etiquettes and Knowledges are skills like any other (#58) and follow the
 * same rules above — same Kismet costs, same rank-6 cap, same boons.
 * Magic in play:
 *   spells cost their listed Cost in woolongs PER FORCE to learn or advance
 *   ZP advances cost Kismet (2x current max ZP per point) and
 *   unlock higher-Force casting — drain is lethal when Force > ZP, Stun
 *   when Force <= ZP
 * House rules (not in KISMET.docx):
 *   wound penalty         −1 die per 3 filled boxes on EACH track, cumulative
 *                         (Biotech can remove the penalties during combat)
 */
"use strict";

const POOL_ORDER = ["Brawn", "Finesse", "Focus", "Resolve"];
const ATTR_ABBR = [["Strength", "STR"], ["Body", "BOD"], ["Reaction", "REA"],
  ["Intelligence", "INT"], ["Willpower", "WIL"], ["Charisma", "CHA"]];
const PLAY_SAVE_DEBOUNCE_MS = 600;
const SKILL_KISMET_CAP = 6;        // Kismet raises stop at 6; mastery boon reaches 7
const NEW_SKILL_KISMET_COST = 4;
const KNOWLEDGE_RANK_CAP = 6;      // mirrors rules.js KNOWLEDGE_ETIQUETTE_RANK_CAP

/* per KISMET.docx: "Grant Kismet at the end of a session as follows" */
const KISMET_AWARDS = [
  ["Survived the session", 1],
  ["Completed mission successfully", 2],
  ["Acquired paydata during run", 1],
  ["Optional objective completed", 1],
  ["Personal goal achieved", 5],
  ["Said what their character learned", 1],
];
const WINDFALL_TABLE = [
  "Gain 3d6×10 Techtronics",
  "Gain 3d6×10 Manastellite",
  "Gain a prototype Arcanatech (installed in a HQ: +1 to a brand stat permanently)",
  "Get 3d6 points of influence on a resource",
  "Get 3d6 points of Market Cap added to your brand's bank",
  // The one entry that names money — kept as a token the renderer swaps for the
  // live glyph, so this list stays a plain array of strings.
  "Gain 3d6 × 4,000{¤} in cash or gear of rarity 4 or less",
];

/* Roll a single die and any `NdM` dice-expressions embedded in a string,
 * substituting each with its rolled total (honouring a trailing ×K / × K,KKK
 * multiplier). "Gain 3d6×10 Techtronics" -> "Gain 90 Techtronics".
 *
 * Also resolves the `{¤}` money token to the live currency glyph — the tables
 * these strings come from are plain arrays defined at load, long before a
 * character (and so a currency house rule) exists. */
function rollDie(sides) { return Math.floor(Math.random() * sides) + 1; }
function rollDiceInText(text) {
  return String(text)
    .replace(/\{¤\}/g, () => RULES.currencySymbol())
    .replace(
      /(\d+)d(\d+)(?:\s*[×x*]\s*([\d,]+))?/gi,
      (_m, n, sides, mult) => {
        let total = 0;
        for (let i = 0; i < +n; i++) total += rollDie(+sides);
        if (mult) total *= parseInt(mult.replace(/,/g, ""), 10);
        return total.toLocaleString();
      });
}

// Hacking programs are priced in the programs table now (Hacking N = 5,000 × N).
const SPELL_FORCE_MAX = 6;           // spells are learned/advanced to Force 6 at most

/* Weapon Type -> the skill you roll to use it (everything else is Firearms) */
const WEAPON_SKILL_BY_TYPE = {
  Melee: "Melee Weapons",
  Thrown: "Throwing Weapons",
  GrenadeLauncher: "Heavy Weapons",
  Heavy: "Heavy Weapons",
  Energy: "Energy Weapons",
  Projectile: "Archery",
};
/* The ±1 a skill's specialization contributes for one specific weapon. Thin
   wrapper so the Overview dice chip and the Gear tab roll hint agree. */
function specAdjustFor(skill, weaponName, weaponType) {
  const entry = (CHAR.skill_specializations || {})[skill];
  return RULES.weaponSpecAdjust(entry, skill, weaponName, weaponType, DATA.tables);
}

/* Everything needed to roll one attack with one weapon.
 *
 * The split follows the combat sequence: "total the number of dice, skill +
 * accuracy to get your limit", then "total any bonus dice from firing mode,
 * bright light, point-blank range". So Accuracy is part of the LIMIT — it comes
 * out of the pool like the skill dice do — and only the firing mode, Gun-Kata
 * and the like are free.
 *
 * `skillDice` and `acc` are kept apart for the tooltip; `limitDice` is what the
 * roller loads as skill dice and what the pool pays for. The Overview's dice
 * chip renders this and the Fire button loads the roller from it, so the number
 * you click and the number you shoot with cannot drift apart. */
/* Weirding Way 1: a weapon with no reach is close enough to a fist that the
 * style lets you swing it as one — "Reach 0 weapons may use Unarmed Combat
 * instead of Melee Weapons or Cybertech Combat" (issue #34). Only ever an
 * upgrade: it applies when Unarmed is the better rating, so a specialist in
 * either of the other two is never dragged down to it. */
const MD_UNARMED_SWAPPABLE = ["Melee Weapons", "Cybertech Combat"];
function weirdingWayRank() {
  const ma = (CALC.martial_arts || []).find(m => /^weirding\s*way$/i.test(m.style || ""));
  return ma ? (+ma.rank || 0) : 0;
}
function unarmedSwapFor(skill, reach) {
  if (!MD_UNARMED_SWAPPABLE.includes(skill)) return null;
  if (reach == null || parseInt(reach, 10) !== 0) return null;
  if (weirdingWayRank() < 1) return null;
  const unarmed = ((CALC.skills || {})["Unarmed Combat"] || {}).final || 0;
  const current = ((CALC.skills || {})[skill] || {}).final || 0;
  return unarmed > current ? "Unarmed Combat" : null;
}

function weaponRollSpec(name, type, accuracy, bonuses = [], reach = null) {
  const mapped = RULES.weaponSkillName(name, type);
  const swapped = unarmedSwapFor(mapped, reach);
  const skill = swapped || mapped;
  const s = skill && (CALC.skills || {})[skill];
  if (!s) return null;
  const spec = specAdjustFor(skill, name, type);
  // Trained-only with no dice anywhere: the weapon can't be used at all.
  const locked = s.trained_only && !(s.final > 0 || s.dice_bonus);
  const skillDice = Math.max(0, s.final + spec.delta);
  const acc = +accuracy || 0;
  const limitDice = skillDice + acc;
  const bonus = bonuses.reduce((n, b) => n + (+b.dice || 0), 0);
  const why = [`${skill} ${s.final}`];
  if (swapped) why.push(`(Weirding Way: Reach 0, so ${mapped} gives way to Unarmed)`);
  if (spec.delta > 0) why.push(`+1 specialized in ${spec.term}`);
  if (spec.delta < 0) why.push(`−1 outside your specialty (${spec.term})`);
  why.push(`= ${skillDice} skill`);
  if (acc) why.push(`+ Accuracy ${acc} = ${limitDice} limit dice`);
  const bwhy = [];
  for (const b of bonuses) if (+b.dice) bwhy.push(`${b.label} +${b.dice}`);
  return { skill, pool: s.pool, spec, locked, skillDice, acc, limitDice, bonus, why, bwhy };
}


const LIFESTYLE_EFFECTS = {
  Squatter: "Rough living: begin play with one Physical condition box already checked and take a −1 penalty die on all tests during the run.",
  Low: "Either start the game with one Physical box checked OR take −1 penalty die on tests until the end of the first conflict encounter.",
  Middle: "No special effect.",
  High: "Well rested: ignore your first penalty die on all tests during the run.",
  Wealthy: "Blend into affluent corporate enclaves and arcologies. +1 die to all etiquette tests (you may roll a one-die test even with etiquette 0), plus the High benefit (ignore your first penalty die).",
};

let sheetTab = "overview";
let expandedPool = null;      // pool card the user clicked open on Overview
// Header pool tiles: which ones have had their "temp" boost row manually
// expanded. A tile with a nonzero boost shows the row regardless — this only
// covers the "let me add one" case, where the row starts folded because there
// is nothing yet to show. Per-pool (a Set of pool names), not one flag for
// all four, so opening Brawn's doesn't also open Finesse's.
let poolTempOpen = new Set();
let imagesCollapsed = false;  // Images section folded shut on the Notes tab
let playSaveTimer = null;
let sheetMenuOpen = false;    // hamburger menu (Back to Chargen / Homebrew / Export / …)
let sheetHeadObserver = null; // IntersectionObserver toggling the compact sticky strip
let sheetStickyScrolled = false;  // survives re-renders so the strip doesn't flicker
// Fold state for the always-on sticky-bar Actions strip. A screen-real-estate
// preference, not a fact about the character — device/viewport-specific, and
// still useful on a read-only shared character where CHAR.play can't be
// written — so it lives in localStorage next to the theme/scheme choices
// (app.js), not in play state. Defaults EXPANDED: the point of this strip is
// to be seen without hunting for it.
let actionsStripCollapsed = (() => {
  try { return localStorage.getItem("sinless:actionstrip") === "collapsed"; }
  catch { return false; }
})();

/* ------------------------------------------------ play-state plumbing */
/* Top up CHAR.play with whatever is missing, so a character that predates a
 * field still gets it on the way into the sheet.
 *
 * The shape comes from RULES.defaultCharacter().play — one definition, so a
 * character created fresh and one topped up here end up with the same keys —
 * plus the fields below, which only the play sheet ever reads and the engine
 * has no opinion about. */
function ensurePlay() {
  const d = {
    ...RULES.defaultCharacter().play,
    pool_boost: {},                       // pool name -> temporary bonus dice
    pool_kismet: {},                      // pool name -> permanent Kismet-die boons
    images: [],                           // [{ url (data URL), caption, big }]
    infusion_spirits: {},                 // infusion slot -> spirit placed in it
    bond_slots: [],                       // [{ spirit, force, favors }] spirits placed in bonds
  };
  CHAR.play = CHAR.play || {};
  for (const [k, v] of Object.entries(d)) {
    if (CHAR.play[k] == null) CHAR.play[k] = v;
    else if (v && typeof v === "object" && !Array.isArray(v)) {
      // Default expects a keyed object here (same protection mergeDefaults
      // gives its own fields, and for the same reason — a legacy/corrupt
      // value that isn't a plain object, e.g. infusion_spirits saved as [],
      // silently drops any named prop on JSON.stringify, so a placement made
      // on it would render fine this session and then vanish on save).
      if (CHAR.play[k] && typeof CHAR.play[k] === "object" && !Array.isArray(CHAR.play[k])) {
        for (const [k2, v2] of Object.entries(v))
          if (CHAR.play[k][k2] == null) CHAR.play[k][k2] = v2;
      } else {
        CHAR.play[k] = v;
      }
    }
  }
  // The Wildling shift had its own boolean for exactly one release before the
  // generic conditional-effect store existed. Fold it in and clear it.
  if (CHAR.play.beast_form) {
    CHAR.play.pool_effects[RULES.WILDLING_EFFECT_ID] = true;
    CHAR.play.beast_form = false;
  }
  // The play shape is complete now, so the ledger exists and the one-time
  // repairs can log what they change. Both are guarded — each runs at most once.
  reconcileLifestyles();
  ensureKit();
  migrateHackingProgram();
  pruneLoadedPrograms();      // after the kit exists — it is what "owned" means
  ensureCreationBudget();     // after the migration, so the freeze prices it
  return CHAR.play;
}
/* The hard line between chargen and play (JC-010, JC-024).
 *
 * Nothing bought after Finalize is written to the chargen arrays. Each category
 * lives in two places — `CHAR.<kind>` for what the character was built with,
 * `CHAR.play.purchases.<kind>` for what they've picked up since — and the sheet
 * shows the two joined, chargen first. That is the same order
 * `applyPlayAdvances` concatenates them in, so index N of this list is index N
 * of the matching CALC array and everything downstream can index straight
 * across.
 *
 * `ownedSplit` tags each entry with the array it lives in, so removing and
 * reordering hit the right one. Read-only consumers want the flat `all*`
 * versions.
 *
 * The first half is `play.kit` — play's own copy of what the character left
 * creation with, NOT the chargen arrays. `inPlay` still marks which side of
 * Finalize an item came from, because the sheet labels play purchases, but both
 * halves are equally play's to edit. Nothing here can reach the chargen record. */
function ownedSplit(category, starting, bought) {
  return [...starting.map((ref, i) => ({ ref, arr: starting, i, inPlay: false, category })),
          ...bought.map((ref, i) => ({ ref, arr: bought, i, inPlay: true, category }))];
}
function ownedWeapons()  { return ownedSplit("weapons", kitOf("weapons"), CHAR.play.purchases.weapons); }
function ownedArmor()    { return ownedSplit("armor", kitOf("armor"), CHAR.play.purchases.armor); }
function ownedDecks()    { return ownedSplit("decks", kitOf("decks"), CHAR.play.purchases.decks); }
function ownedRigs()     { return ownedSplit("rigs", kitOf("rigs"), CHAR.play.purchases.rigs); }
function ownedDrones()   { return ownedSplit("drones", kitOf("drones"), CHAR.play.purchases.drones); }
function ownedVehicles() { return ownedSplit("vehicles", kitOf("vehicles"), CHAR.play.purchases.vehicles); }
function ownedPrograms() { return ownedSplit("programs", kitOf("programs"), CHAR.play.purchases.programs); }
function ownedGear()     { return ownedSplit("gear", kitOf("gear"), CHAR.play.purchases.gear); }
function ownedAugments() { return ownedSplit("augments", kitOf("augments"), CHAR.play.purchases.augments); }

/* Flat views for read-only consumers — what the character HAS right now. */
function allWeapons()  { return [...kitOf("weapons"), ...CHAR.play.purchases.weapons]; }
function allArmor()    { return [...kitOf("armor"), ...CHAR.play.purchases.armor]; }
function allDecks()    { return [...kitOf("decks"), ...CHAR.play.purchases.decks]; }
function allPrograms() { return [...kitOf("programs"), ...CHAR.play.purchases.programs]; }
function allRigs()     { return [...kitOf("rigs"), ...CHAR.play.purchases.rigs]; }
function allDrones()   { return [...kitOf("drones"), ...CHAR.play.purchases.drones]; }
function allVehicles() { return [...kitOf("vehicles"), ...CHAR.play.purchases.vehicles]; }
function allGear()     { return [...kitOf("gear"), ...CHAR.play.purchases.gear]; }
function allAugmentsOwned() { return [...kitOf("augments"), ...CHAR.play.purchases.augments]; }
function allKnowledgeSkills() { return kitOf("knowledge_skills"); }
function allUnits(table) { return table === "drones" ? allDrones() : allVehicles(); }

function schedulePlaySave() {
  // Read-only shared views never persist (also server-rejected as non-owner).
  if (typeof activeTabObj === "function" && activeTabObj() && activeTabObj().readonly) return;
  clearTimeout(playSaveTimer);
  playSaveTimer = setTimeout(() => {
    if (!CHAR.name) return;
    STORAGE.saveCharacter(CHAR);
  }, PLAY_SAVE_DEBOUNCE_MS);
}
/* mutate play state -> autosave + redraw */
function playChanged(rerender = true) {
  schedulePlaySave();
  if (rerender) renderSheet();
}
async function playChangedRecalc() {   // for changes that alter derived stats
  schedulePlaySave();
  await recalc();
  renderSheet();
}

/* ------------------------------------------------ kismet + cash ledgers */
function kismetEcon() {
  const p = CHAR.play;
  const increases = Math.floor(p.kismet_earned / 10);   // pool +1 per 10 earned
  const majorsTotal = Math.floor(increases / 2);        // every 2nd is a major boon
  const regularsTotal = increases - majorsTotal;
  return {
    increases, majorsTotal, regularsTotal,
    regularsAvail: Math.max(0, regularsTotal - p.boons_spent),
    majorsAvail: Math.max(0, majorsTotal - p.major_boons_spent),
  };
}
function awardKismet(label, n) {
  CHAR.play.kismet += n;
  CHAR.play.kismet_earned += n;
  // Awards are undoable too (#76). The descriptor carries the amount so undo
  // can walk back BOTH the available Kismet and the lifetime total -- the
  // lifetime figure is what sizes the boon milestones and the Kismet die pool,
  // so leaving it standing would hand out a permanent boon for a mis-key.
  CHAR.play.kismet_log.unshift({ label, delta: n, undo: { kind: "award", amount: n } });
}
/* `undo`, when given, is a small serializable descriptor (not a closure —
 * kismet_log is persisted to localStorage as JSON) letting a later
 * undoKismetSpend() reverse the specific advance this spend made. */
function spendKismet(label, n, undo) {
  if (CHAR.play.kismet < n) { alert(`Not enough Kismet (need ${n}, have ${CHAR.play.kismet}).`); return false; }
  CHAR.play.kismet -= n;
  CHAR.play.kismet_log.unshift({ label, delta: -n, undo: undo || null });
  return true;
}

/* Reverses a still-undoable kismet_log entry: refunds the Kismet and rolls
 * back whichever play.*_advances counter the spend incremented, then drops
 * the entry from the ledger. Safe to call out of order — every advance is a
 * simple additive counter, so undoing one just subtracts 1 regardless of
 * what was spent afterward. */
/* Speakers grow their practice with Kismet at the same prices chargen charged:
 * the bond ladder from speaker_bond_costs (0/3/8/13 for the 1st-4th), and each
 * infusion or spirit at its own listed Cost. Nothing here is discounted or
 * marked up — a bond you didn't buy at creation costs what it would have.
 *
 * Absent for anyone who isn't a Speaker or Archmage, which is every other
 * magic type plus the mundane. */
function speakerKismetSection(spend) {
  const type = CALC.magic.type;
  if (type !== "Speaker" && type !== "Archmage") return;
  const play = CHAR.play;
  // Chargen practice plus everything Kismet has already bought — see CALC.speaker.
  const sp = CALC.speaker;
  const cost = (rows, key, name) => {
    const row = (DATA.tables[rows] || []).find(r => r[key] === name);
    return row ? (parseInt(row.Cost, 10) || 0) : 0;
  };

  spend.append(el("h4", { class: "sh-h4" }, "Speaker practice"));

  // --- bonds: the next rung of the ladder, priced by its index
  const bondsNow = RULES.speakerBondCount(CALC);
  const nextBond = bondsNow + 1;
  const bondRow = (DATA.tables.speaker_bond_costs || [])
    .find(r => (parseInt(r.Bond, 10) || 0) === nextBond);
  const bondCost = bondRow ? (parseInt(bondRow.Cost, 10) || 0) : null;
  spend.append(el("p", { class: "hint" },
    "Bonds, infusions and spirit relationships cost the same Kismet as they cost "
    + "points at creation. The creation budgets don't stretch — this is bought, not found."));
  spend.append(el("div", { class: "sh-advrow", style: "max-width:420px" },
    el("span", {}, el("b", {}, "Spirit bonds"),
      el("span", { class: "sub" }, ` ${bondsNow} of ${RULES.SPEAKER_BOND_MAX}`)),
    bondCost == null
      ? el("span", { class: "sub" }, "at maximum")
      : el("button", {
          class: "btn small", disabled: play.kismet < bondCost ? "1" : null,
          onclick: async () => {
            if (!spendKismet(`Bonded a ${ordinalish(nextBond)} spirit`, bondCost,
                             { kind: "speaker_bond" })) return;
            play.bond_advances = (play.bond_advances || 0) + 1;
            await playChangedRecalc();
          },
        }, `+1 (${bondCost})`)));

  // --- infusions and relationships: pick an unowned one, pay its listed cost
  const buyer = (label, table, key, field, undoKind, playKey) => {
    const have = sp[field] || [];
    const rows = (DATA.tables[table] || [])
      .filter(r => r[key] && !have.includes(r[key]))
      .sort((a, b) => (parseInt(a.Cost, 10) || 0) - (parseInt(b.Cost, 10) || 0));
    if (!rows.length) return;
    const sel = el("select", {},
      el("option", { value: "" }, `${label}…`),
      ...rows.map(r => el("option", { value: r[key] },
        `${r[key]} (${parseInt(r.Cost, 10) || 0})`)));
    spend.append(el("div", { class: "add-row" }, sel,
      el("button", {
        class: "btn-add",
        onclick: async () => {
          const name = sel.value;
          if (!name) return;
          const n = cost(table, key, name);
          if (!spendKismet(`${label}: ${name}`, n, { kind: undoKind, name })) return;
          (play[playKey] = play[playKey] || []).push(name);
          await playChangedRecalc();
        },
      }, "Buy")));
  };
  buyer("Infusion", "speaker_infusions", "Infusions", "infusions",
        "speaker_infusion", "speaker_infusions");
  buyer("Relationship", "speaker_spirits", "Spirit", "relationships",
        "speaker_relationship", "speaker_relationships");
}

/* "2nd" / "3rd" / "4th" — only ever called with 2-4. */
function ordinalish(n) { return n + (n === 2 ? "nd" : n === 3 ? "rd" : "th"); }

function undoKismetSpend(entry) {
  const play = CHAR.play;
  const idx = play.kismet_log.indexOf(entry);
  // An AWARD runs the other way: it handed out Kismet and raised the lifetime
  // total, so undoing has to take back both (#76). Two states make that unsafe,
  // and both REFUSE rather than force it -- quietly un-redeeming a boon, or
  // driving the balance negative, is worse than asking for the undo in order.
  if (idx >= 0 && entry.undo && entry.undo.kind === "award") {
    const n = Math.max(0, +entry.delta || 0);
    if (play.kismet < n) {
      alert(`That award gave ${n} Kismet and only ${play.kismet} is still unspent. `
        + "Undo what it paid for first, then undo the award.");
      return;
    }
    const lifetimeAfter = Math.max(0, (play.kismet_earned || 0) - n);
    const incAfter = Math.floor(lifetimeAfter / 10);
    const majorsAfter = Math.floor(incAfter / 2);
    if ((play.major_boons_spent || 0) > majorsAfter
        || (play.boons_spent || 0) > incAfter - majorsAfter) {
      alert("Undoing this would drop the lifetime total below a milestone whose "
        + "boon has already been redeemed. Undo the boon first.");
      return;
    }
    play.kismet -= n;
    play.kismet_earned = lifetimeAfter;
    // The Kismet die pool is sized off the lifetime total, so a smaller total
    // can leave more dice marked used than now exist. The read side clamps, but
    // the stored value should not be left lying about what was spent.
    play.pool_used = play.pool_used || {};
    play.pool_used.Kismet = Math.min(play.pool_used.Kismet || 0, 1 + Math.floor(lifetimeAfter / 10));
    play.kismet_log.splice(idx, 1);
    return;
  }
  // Boons cost no Kismet (delta: 0) but still consume a boons_spent /
  // major_boons_spent slot, so only a strictly POSITIVE (gained) entry is
  // blocked here -- a zero-cost boon redemption is still undoable.
  if (idx < 0 || entry.delta > 0 || !entry.undo) return;
  const u = entry.undo;
  const dec = (obj, key) => { obj[key] = Math.max(0, (obj[key] || 0) - 1); };
  // Boons: redeeming one consumed a milestone slot (regular or major) and,
  // for the two that grant a specific rank/pool bonus, that too -- both are
  // rolled back together so an undone boon is available to redeem again.
  if (u.kind === "boon") {
    if (u.major) dec(play, "major_boons_spent"); else dec(play, "boons_spent");
  }
  else if (u.kind === "boon_rank") {
    if (u.major) dec(play, "major_boons_spent"); else dec(play, "boons_spent");
    if (u.rankKind === "etiquette") dec(play.etiquette_advances = play.etiquette_advances || {}, u.name);
    else if (u.rankKind === "knowledge") {
      const k = allKnowledgeSkills().find(k => k.name === u.name);
      if (k) k.points = Math.max(0, (k.points || 0) - 1);
    } else dec(play.skill_advances, u.name);
  }
  else if (u.kind === "boon_pool") {
    dec(play, "major_boons_spent");
    dec(play.pool_kismet = play.pool_kismet || {}, u.pool);
  }
  else if (u.kind === "attribute") dec(play.attribute_advances, u.name);
  else if (u.kind === "skill") dec(play.skill_advances, u.name);
  else if (u.kind === "martial_art") dec(play.martial_art_advances = play.martial_art_advances || {}, u.name);
  else if (u.kind === "ritual") dec(play.ritual_advances, u.name);
  else if (u.kind === "etiquette") dec(play.etiquette_advances = play.etiquette_advances || {}, u.name);
  // Knowledges have no advances counter of their own -- points live straight
  // on the play.kit entry (the same field the free budget +/- buttons edit),
  // so undoing just steps that entry back down instead.
  else if (u.kind === "knowledge") {
    const entry = allKnowledgeSkills().find(k => k.name === u.name);
    if (entry) entry.points = Math.max(0, (entry.points || 0) - 1);
  }
  else if (u.kind === "zp") play.zp_advances = Math.max(0, (play.zp_advances || 0) - 1);
  else if (u.kind === "speaker_bond") play.bond_advances = Math.max(0, (play.bond_advances || 0) - 1);
  // Infusions and relationships are bought by NAME, so undo removes that name
  // rather than decrementing a counter. Last occurrence, so buying the same
  // thing twice and undoing once leaves one behind.
  else if (u.kind === "speaker_infusion" || u.kind === "speaker_relationship") {
    const key = u.kind === "speaker_infusion" ? "speaker_infusions" : "speaker_relationships";
    const list = play[key] || [];
    const at = list.lastIndexOf(u.name);
    if (at >= 0) list.splice(at, 1);
  }
  play.kismet -= entry.delta;   // delta is negative, so this refunds it
  play.kismet_log.splice(idx, 1);
}
/* `undo`, when given, is a small serializable descriptor (cash_log is persisted
 * as JSON, so no closures) naming what this spend bought, for undoCashSpend()
 * below. Spends with nothing to reverse — manual adjustments, α-grade
 * upgrades, quality changes — pass none and get no Undo button. */
function logCash(label, delta, undo) {
  CHAR.play.cash += delta;
  CHAR.play.cash_log.unshift(undo ? { label, delta, undo } : { label, delta });
}

/* Using something up belongs in the Activity ledger next to what was bought —
 * "where did my six doses go" is the same question as "where did my money go".
 * No cash moves (a spent dose isn't a sale), so it lands as a zero-delta note,
 * which the ledger already renders with a dash rather than a fake ㄓ0.
 *
 * Consecutive clicks on the same item fold into ONE line, because a stepper is
 * held down: taking three doses reads "Used 3 Bliss — 7 left", not three rows.
 * The fold only ever touches the newest entry, and only while it's still the
 * same item going the same direction, so it can't rewrite history. */
function logItemUse(name, delta, left) {
  if (!delta) return;
  const log = CHAR.play.cash_log;
  const top = log[0];
  const folds = top && top.use === name && Math.sign(top.use_n || 0) === Math.sign(delta);
  const n = (folds ? top.use_n : 0) + delta;
  const label = n < 0
    ? `Used ${-n} ${name} — ${left} left`
    : `Restocked ${n} ${name} from supplies — ${left} on hand`;
  if (folds) Object.assign(top, { label, use_n: n });
  else log.unshift({ label, delta: 0, use: name, use_n: n });
}

/* Reversing a cash purchase: the item goes and the money comes back in full.
 * Kismet spends have always had this; cash didn't, so removing a bought item
 * quietly kept the money. Undo lives only here in the Activity ledger — the
 * per-row ✕ on the Gear tab still just removes the thing, since selling for
 * face value on a whim isn't the same as taking back a misclick.
 *
 * Each handler returns true when it found and removed what the entry bought.
 * Items are located by NAME at undo time, most recent first: object identity
 * doesn't survive a save/load round trip. */
function removeNamedEntry(list, name) {
  const i = list.map(x => x.name).lastIndexOf(name);
  if (i < 0) return false;
  list.splice(i, 1);
  return true;
}
function removeCountedEntry(list, name, countKey) {
  const i = list.map(x => x.name).lastIndexOf(name);
  if (i < 0) return false;
  const count = list[i][countKey] || 1;
  if (count > 1) list[i][countKey] = count - 1;
  else list.splice(i, 1);
  return true;
}
/* Undoing a FITTING (the ledger's "Fitted X to Y" / "Mounted X on Y" rows).
 *
 * Hosts are found by name, because object identity doesn't survive a save/load
 * round trip. On a chargen host the fitting is a play.fitted_mods record, so
 * undoing it drops that record rather than touching the chargen item — which
 * is the whole point, and what the old direct splice got wrong. */
function removeFromSublist(entries, hostName, key, name) {
  const play = CHAR.play;
  play.fitted_mods = play.fitted_mods || [];
  for (const entry of entries) {
    if (entry.ref.name !== hostName) continue;
    if (!entry.inPlay) {
      const i = play.fitted_mods.findIndex(r => r.category === entry.category
        && r.host === entry.i && r.list === key && r.name === name);
      if (i >= 0) { play.fitted_mods.splice(i, 1); return true; }
      continue;
    }
    const arr = entry.ref[key] || [];
    const i = arr.findIndex(x => sublistName(x) === name);
    if (i >= 0) { arr.splice(i, 1); return true; }
  }
  return false;
}
const CASH_UNDO = {
  weapon:    u => removeNamedEntry(CHAR.play.purchases.weapons, u.name),
  armor:     u => removeNamedEntry(CHAR.play.purchases.armor, u.name),
  // Amp powers cost ZP rather than cash, so their ledger row moves no money
  // (delta 0). Undo still belongs here: the row is what carries the button, and
  // dropping the purchase is the whole refund — the engine derives
  // CALC.zoetics.amp_zp_spent from this list, so the ZP comes back exactly as
  // paid, including the half-cost Amp rate (#82).
  amp_power: u => removeNamedEntry(CHAR.play.purchases.amp_powers, u.name),
  spell:     u => removeNamedEntry(CHAR.play.purchases.spells, u.name),
  deck:      u => removeNamedEntry(CHAR.play.purchases.decks, u.name),
  rig:       u => removeNamedEntry(CHAR.play.purchases.rigs, u.name),
  drone:     u => removeNamedEntry(CHAR.play.purchases.drones, u.name),
  vehicle:   u => removeNamedEntry(CHAR.play.purchases.vehicles, u.name),
  gear:      u => removeCountedEntry(CHAR.play.purchases.gear, u.name, "qty"),
  augment:   u => removeCountedEntry(CHAR.play.purchases.augments, u.name, "count"),
  // Programs are bare names, not entries.
  program: u => {
    const list = CHAR.play.purchases.programs;
    const i = list.lastIndexOf(u.name);
    if (i < 0) return false;
    list.splice(i, 1);
    CHAR.play.decking.loaded = (CHAR.play.decking.loaded || []).filter(n => n !== u.name);
    return true;
  },
  weapon_mod:  u => removeFromSublist(ownedWeapons(), u.host, "mods", u.name),
  armor_extra: u => removeFromSublist(ownedArmor(), u.host, "extras", u.name),
  // Quality and Style are a FIELD on the piece rather than an entry in a list,
  // so undo puts the previous value back instead of removing anything (#73).
  // A unit's Condition is a field like armor Quality, so undo restores the
  // value rather than removing an entry (#73).
  unit_condition: u => {
    const list = [...(kitOf(u.table) || []), ...((CHAR.play.purchases || {})[u.table] || [])];
    const unit = list.find(x => x && x.name === u.name);
    if (!unit) return false;
    unit.condition = u.from || "Pristine";
    return true;
  },
  armor_trait: u => {
    const en = ownedArmor().find(e => e.ref && e.ref.name === u.host);
    if (!en) return false;
    en.ref[u.field] = u.from || "";
    return true;
  },
  // A spell's Force is a counter, not an entry, so undo restores the count the
  // way armor_trait restores a field (#82). Guarded against going backwards
  // past what is actually stored: undoing two advances out of order must not
  // leave a negative advance that the engine would read as a Force reduction.
  spell_force: u => {
    const advances = CHAR.play.spell_force_advances || {};
    const from = Math.max(0, +u.from || 0);
    if (!((+advances[u.name] || 0) > from)) return false;
    advances[u.name] = from;
    return true;
  },
  // Undoing the sale of a spell BOUGHT IN PLAY puts the entry back where it
  // was; undoCashSpend takes the sale money away again (#82).
  restore_spell: u => {
    const list = CHAR.play.purchases.spells;
    if (u.entry === undefined) return false;
    list.splice(Math.max(0, Math.min(list.length, u.at)), 0, deepCopyEntry(u.entry));
    return true;
  },
  // Undoing the sale of a CHARGEN spell just drops the "forgotten" record —
  // the spell itself never went anywhere, it was only being subtracted (#82).
  unforget_spell: u => {
    const list = CHAR.play.spells_forgotten || [];
    const i = list.indexOf(u.name);
    if (i < 0) return false;
    list.splice(i, 1);
    return true;
  },
  // Raising a program's rating renames it in place ("Crack Encryption 3" ->
  // "… 4"), so undo renames it back — a field restore, not a removal (#82).
  program_rating: u => {
    for (const en of ownedPrograms()) {
      if (en.ref !== u.to) continue;
      en.arr[en.i] = u.from;
      const dk = CHAR.play.decking || {};
      dk.loaded = (dk.loaded || []).map(n => (n === u.to ? u.from : n));
      for (const d of [...kitOf("decks"), ...(CHAR.play.purchases.decks || [])])
        if (d && d.hacking === u.to) d.hacking = u.from;
      return true;
    }
    return false;
  },
  deck_mod:    u => removeFromSublist(ownedDecks(), u.host, "mods", u.name),
  rig_mod:     u => removeFromSublist(ownedRigs(), u.host, "mods", u.name),
  mount: u => removeFromSublist(
    [...ownedWeapons(), ...ownedArmor(), ...ownedGear()], u.host, "mounted", u.name),
  lifestyle_month: u => {
    const ls = (CHAR.play.lifestyles || []).find(x => x.name === u.name);
    if (!ls || !(ls.months > 0)) return false;
    ls.months -= 1;
    return true;
  },
  // Undoing a disposal puts the item back where it was and takes the sale money
  // away again (undoCashSpend does the cash half). A loss logs delta 0, so
  // undoing one only returns the item.
  restore_item: u => {
    const list = u.inPlay ? (CHAR.play.purchases || {})[u.category] : kitOf(u.category);
    if (!Array.isArray(list) || u.entry === undefined) return false;
    list.splice(Math.max(0, Math.min(list.length, u.at)), 0, deepCopyEntry(u.entry));
    return true;
  },
  restore_mod: u => {
    const owner = (u.inPlay ? (CHAR.play.purchases || {})[u.category] : kitOf(u.category))
      || [];
    const host = owner[u.host];
    if (!host || u.entry === undefined) return false;
    const arr = host[u.list] = host[u.list] || [];
    arr.splice(Math.max(0, Math.min(arr.length, u.at)), 0, deepCopyEntry(u.entry));
    return true;
  },
  // Unpaid month changes: the counter, a chargen correction, the one-time
  // resync. No cash moved either way, so undo just puts the count back.
  lifestyle_adjust: u => {
    const ls = (CHAR.play.lifestyles || []).find(x => x.name === u.name);
    if (!ls) return false;
    ls.months = Math.max(0, +u.from || 0);
    return true;
  },
  // Undoing a chargen-side removal puts the lifestyle and its prepaid months
  // back where they were. It comes back inactive — whatever replaced it is
  // current now, and picking between them is the player's call.
  lifestyle_restore: u => {
    const list = CHAR.play.lifestyles = CHAR.play.lifestyles || [];
    if (list.some(x => x.name === u.name)) return false;
    list.splice(Math.max(0, Math.min(list.length, +u.at || 0)),
      0, { name: u.name, months: Math.max(0, +u.months || 0), active: !list.length });
    return true;
  },
};
async function undoCashSpend(entry) {
  const log = CHAR.play.cash_log;
  const idx = log.indexOf(entry);
  const handler = entry && entry.undo && CASH_UNDO[entry.undo.kind];
  if (idx < 0 || !handler) return;
  // A zero-delta entry moved no money (an unpaid lifestyle adjustment), so
  // promising a refund would be nonsense.
  // A ZP purchase moves no cash but is emphatically not "no cost restored" —
  // saying so on an amp power would read as a warning that the ZP was lost
  // (#82). The ZP figure comes off the entry rather than being recomputed:
  // it is what the row was labelled with, so the promise matches the receipt.
  const zpNote = entry.undo.zp !== undefined
    ? `It is removed and ${entry.undo.zp} ZP freed up again. No cash moved.` : null;
  if (!confirm(`Undo "${entry.label}"?\n\n`
    + (entry.delta
        ? `It is removed and ${fmt(-entry.delta)} refunded in full.`
        : zpNote
          || "It is removed and the previous value restored. No cash moved."))) return;
  if (!handler(entry.undo)) {
    alert(`"${entry.label}" isn't there any more — it was already removed.\n\n`
      + "The ledger entry stays. Use Adjust if the refund is still owed.");
    return;
  }
  CHAR.play.cash -= entry.delta;   // delta is negative, so this refunds it
  log.splice(idx, 1);
  await playChangedRecalc();
}

/* ================================================================ the kit
 *
 * `play.kit` is play's own copy of what the character walked out of creation
 * with. Everything the play sheet edits — worn flags, fitted mods, quantities,
 * α-grades, sales, losses, reordering — edits the kit; the chargen arrays are
 * never written to after Finalize. That single rule is what keeps the creation
 * budget stable, lets Back to Chargen show the character exactly as built, and
 * makes Revert a one-liner: rebuild the kit from chargen.
 *
 * It replaced three narrower mechanisms (`disposed`, `fitted_mods` /
 * `disposed_mods`, `unit_overrides`), each of which patched one path by which
 * play could reach into the creation record. */
function kitFromChargen() {
  const kit = {};
  for (const category of RULES.KIT_CATEGORIES)
    kit[category] = deepCopyEntry(CHAR[category] || []);
  return kit;
}
function kitOf(category) {
  const kit = CHAR.play.kit;
  if (!kit) return CHAR[category] || [];        // pre-Finalize / pre-migration
  return (kit[category] = kit[category] || []);
}

/* Build the kit if there isn't one, and migrate a character saved before it
 * existed. The legacy replay lives in the engine, so migration is just "ask the
 * engine what this character currently has, and keep that". */
function ensureKit() {
  const play = CHAR.play;
  if (play.kit) return play.kit;
  if (!CHAR.finalized) return null;             // nothing to copy yet
  const legacy = play.disposed || play.fitted_mods || play.disposed_mods
    || play.unit_overrides;
  const hadLegacyEdits = legacy && (
    Object.values(play.disposed || {}).some(v => (v || []).length)
    || (play.fitted_mods || []).length || (play.disposed_mods || []).length
    || Object.keys(play.unit_overrides || {}).length);
  if (hadLegacyEdits) {
    // Replay the old records through the engine, then keep the result minus
    // anything bought in play (which stays in play.purchases where it lives).
    const resolved = RULES.applyPlayAdvances(JSON.parse(JSON.stringify(CHAR)));
    play.kit = {};
    for (const category of RULES.KIT_CATEGORIES) {
      const bought = ((play.purchases || {})[category] || []).length;
      const all = resolved[category] || [];
      play.kit[category] = deepCopyEntry(bought ? all.slice(0, all.length - bought) : all);
    }
  } else {
    play.kit = kitFromChargen();
  }
  play.kit_baseline = kitFromChargen();
  // The old records are now folded into the kit; leaving them would apply twice.
  play.disposed = {}; play.fitted_mods = []; play.disposed_mods = [];
  play.unit_overrides = {};
  return play.kit;
}

/* Characters built before the Hacking program existed carry a `hacking_rating`
 * scalar instead, plus any levels bought in play. Grant the equivalent program
 * once and slot it into every deck they own.
 *
 * Cost-neutral by construction: they paid ㄓ5,000 per level and "Hacking N"
 * costs ㄓ5,000 × N, so the budget doesn't move. The same copy goes in every
 * deck because that is what a character-wide rating meant — one program, moved
 * between decks as needed.
 *
 * Runs against the chargen record (which is what the old scalar priced) and
 * against the kit, so the play sheet and the build agree. */
function migrateHackingProgram() {
  const play = CHAR.play;
  const legacy = Math.max(0, Math.min(6,
    (+CHAR.hacking_rating || 0) + (+(play.purchases || {}).hacking_levels || 0)));
  if (!CHAR.hacking_rating && !((play.purchases || {}).hacking_levels)) return;
  const program = legacy ? `Hacking ${legacy}` : "";
  const grant = (programs, decks) => {
    if (program && !programs.includes(program)) programs.push(program);
    for (const d of decks) if (d && !d.hacking) d.hacking = program;
  };
  grant(CHAR.programs = CHAR.programs || [], CHAR.decks || []);
  if (play.kit) grant(play.kit.programs = play.kit.programs || [], play.kit.decks || []);
  CHAR.hacking_rating = 0;
  if (play.purchases) play.purchases.hacking_levels = 0;
  if (program && play.cash_log) {
    logCash(`Hacking rating ${legacy} became ${program}, slotted into `
      + `${(CHAR.decks || []).length || (play.kit ? (play.kit.decks || []).length : 0)} deck(s)`, 0);
  }
}

/* `decking.loaded` is a list of program NAMES, so it only means anything while
 * the character still owns those programs — and nothing was keeping the two in
 * step (issue #74). Selling a program in play unloads it, but a trip back
 * through chargen doesn't: drop De-rez, or re-rate Crack Encryption 5 up to 6,
 * and reconcileKit faithfully updates the kit while `loaded` keeps pointing at
 * names nobody owns. The thread counter reads `loaded.length` and the program
 * rows read `loaded.includes(name)`, so the header claimed 4 of 7 threads in
 * use above a list with nothing loaded.
 *
 * Fixed here rather than in the header, because the count isn't wrong about the
 * array — the array is wrong. Programs that never occupy a thread are dropped
 * too: they have no Load button, so being in here can only ever inflate the
 * count. Runs on every load and after every re-finalize; it is idempotent, so
 * the ledger note lands once, when there is actually something to say. */
function pruneLoadedPrograms() {
  const dk = CHAR.play.decking;
  if (!dk || !Array.isArray(dk.loaded) || !dk.loaded.length) return;
  const owned = new Set(allPrograms());
  const keep = dk.loaded.filter(name => owned.has(name)
    && RULES.programNeedsThread(DATA.tables.programs.find(x => x.Name === name)));
  if (keep.length === dk.loaded.length) return;
  const dropped = dk.loaded.filter(n => !keep.includes(n));
  dk.loaded = keep;
  if (CHAR.play.cash_log)
    logCash(`Unloaded ${dropped.join(", ")} — no longer owned`, 0);
}

/* What creation cost, priced from the chargen record — never from the kit, so
 * it answers "what did this build cost" rather than "what is this character
 * carrying". Taken at every Finalize, and once on load for a character
 * finalized before the freeze existed. */
function snapshotCreationBudget() {
  const c = JSON.parse(JSON.stringify(CHAR));
  c.finalized = false;
  const b = RULES.calculate(c).budget;
  return { starting_cash: b.starting_cash, categories: b.categories,
           spent: b.spent, remaining: b.remaining };
}
function ensureCreationBudget() {
  const play = CHAR.play;
  if (play.creation_budget || !CHAR.finalized) return;
  play.creation_budget = snapshotCreationBudget();
}

/* An entry's identity for reconciling: its name. Sublist members (weapon mods,
 * armor extras) are sometimes bare strings and sometimes {name}, so both shapes
 * answer here. */
const entryLabel = e => (e && typeof e === "object") ? (e.name || "") : String(e);

/* Knowledge skills are the one kit category whose names are TYPED rather than
 * chosen from a data table. "Corp Ladders" and "corp ladders " are the same
 * skill to a person and were two different skills to reconcileKit, which is the
 * last way issue #35 could still double a knowledge up: a player who added one
 * in play and then re-typed it in chargen got both copies. Everything else in
 * the kit is named by a row in DATA, where an exact match is the right test. */
const knowledgeKey = name => String(name || "").trim().replace(/\s+/g, " ").toLowerCase();
const entryKeyFor = category => category === "knowledge_skills"
  ? (e => knowledgeKey(entryLabel(e)))
  : entryLabel;

/* Collapse knowledge rows that differ only in case or spacing, keeping the
 * first spelling and the highest points. Runs when a character comes back to
 * chargen, so a sheet that already carries duplicates from before this fix
 * heals itself instead of needing the player to spot them. Returns how many
 * rows it removed. */
function dedupeKnowledge(list) {
  if (!Array.isArray(list)) return 0;
  const byKey = new Map();
  const kept = [];
  let removed = 0;
  for (const row of list) {
    const key = knowledgeKey(entryLabel(row));
    // A half-typed row has no name yet and is nobody's duplicate; leave it.
    if (!key) { kept.push(row); continue; }
    const first = byKey.get(key);
    if (!first) { byKey.set(key, row); kept.push(row); continue; }
    // First spelling wins — it's the one the character has had longest, and the
    // later row is the accidental re-entry. The better rating of the two wins,
    // because whichever the player raised is the one they meant.
    first.points = Math.max(toIntSafe(first.points), toIntSafe(row.points));
    removed++;
  }
  if (removed) list.splice(0, list.length, ...kept);
  return removed;
}
const toIntSafe = v => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };

/* Carry a chargen edit to an item the character ALREADY owned onto play's copy
 * of it. `from` is the chargen entry now, `base` what chargen said at the last
 * sync, `into` play's copy. Only fields the owner actually changed move, so
 * anything play did to the same item survives:
 *
 *   - list fields (a weapon's mods, an armor piece's extras) apply the chargen
 *     DELTA — a mod fitted in play isn't wiped by a chargen edit elsewhere on
 *     the same gun;
 *   - scalar fields (smart, style, material, qty, a focus link) are written
 *     across only when they differ from the baseline. An untouched field means
 *     play's value stands, which is what keeps a "worn"/"equipped" toggle made
 *     at the table from snapping back after a trip through chargen.
 */
function mergeChargenEdits(from, base, into, note) {
  if (!from || typeof from !== "object" || !into || typeof into !== "object") return;
  const was = (base && typeof base === "object") ? base : {};
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  for (const [key, value] of Object.entries(from)) {
    if (key === "name") continue;
    if (Array.isArray(value)) {
      const wasList = Array.isArray(was[key]) ? was[key] : [];
      if (same(value, wasList)) continue;
      const target = Array.isArray(into[key]) ? into[key] : (into[key] = []);
      const tally = list => list.reduce((m, e) =>
        m.set(entryLabel(e), (m.get(entryLabel(e)) || 0) + 1), new Map());
      const nowCount = tally(value), wasCount = tally(wasList);
      for (const [member, n] of nowCount) {
        for (let k = (wasCount.get(member) || 0); k < n; k++) {
          target.push(deepCopyEntry(value.find(e => entryLabel(e) === member)));
          note(`+${member}`);
        }
      }
      for (const [member, n] of wasCount) {
        for (let k = (nowCount.get(member) || 0); k < n; k++) {
          const at = target.findIndex(e => entryLabel(e) === member);
          if (at >= 0) { target.splice(at, 1); note(`−${member}`); }
        }
      }
    } else if (!same(value, was[key])) {
      into[key] = deepCopyEntry(value);
      note(`${key} ${value === "" ? "cleared" : value}`);
    }
  }
}

/* Re-finalize. The kit is play's, so an unrelated trip through chargen must not
 * disturb it — but a genuine edit to the BUILD should carry across, the same
 * ruling that governs lifestyle months. `kit_baseline` is what chargen said at
 * the last sync, so anything that differs from it now is an owner edit:
 * appended entries are added to the kit, removed ones are taken out of it,
 * edits to an item that's still there are merged onto play's copy of it, and
 * everything the player did in play is left alone.
 *
 * That last case is easy to miss: matching by name alone, fitting Bling to a
 * rifle you already owned changes nothing about the name, so before
 * mergeChargenEdits the mod stayed in chargen and never reached the sheet or
 * the markdown export. */
function reconcileKit() {
  const play = CHAR.play;
  if (!play.kit) { ensureKit(); return; }
  // Collapse any knowledge the player re-typed while in chargen before the
  // build is compared to the baseline. Without this the duplicate is a genuine
  // new entry as far as the tally below is concerned, and it gets faithfully
  // copied into the kit — which is exactly how issue #35 doubled things up.
  dedupeKnowledge(CHAR.knowledge_skills);
  const baseline = play.kit_baseline || {};
  const notes = [];
  for (const category of RULES.KIT_CATEGORIES) {
    const now = CHAR[category] || [];
    const was = baseline[category] || [];
    const kit = play.kit[category] = play.kit[category] || [];
    // Typed names (knowledge skills) match loosely; table names match exactly.
    const label = entryKeyFor(category);
    const tally = list => list.reduce((m, e) => m.set(label(e), (m.get(label(e)) || 0) + 1), new Map());
    const nowCount = tally(now), wasCount = tally(was);
    for (const [name, n] of nowCount) {                 // added in chargen
      // Copy the k-th same-named entry, not the first: buying a SECOND M31 must
      // hand play a bare one, not a clone of the first gun's mods and flags.
      const ones = now.filter(e => label(e) === name);
      for (let k = (wasCount.get(name) || 0); k < n; k++) {
        kit.push(deepCopyEntry(ones[k]));
        notes.push(`+${name}`);
      }
    }
    for (const [name, n] of wasCount) {                 // removed in chargen
      for (let k = (nowCount.get(name) || 0); k < n; k++) {
        const at = kit.findIndex(e => label(e) === name);
        if (at >= 0) { kit.splice(at, 1); notes.push(`−${name}`); }
      }
    }
    // Still-owned items, reconfigured in chargen. Same-named copies pair up in
    // order (the k-th "Armored Coat" here is the k-th one there). Only the ones
    // that existed at the baseline are merged — anything added above that count
    // was just deep-copied into the kit and has nothing to reconcile.
    for (const name of nowCount.keys()) {
      const nowOnes = now.filter(e => label(e) === name);
      const wasOnes = was.filter(e => label(e) === name);
      const kitOnes = kit.filter(e => label(e) === name);
      for (let k = 0; k < Math.min(nowOnes.length, kitOnes.length, wasOnes.length); k++) {
        mergeChargenEdits(nowOnes[k], wasOnes[k], kitOnes[k],
          detail => notes.push(`${name}: ${detail}`));
      }
    }
  }
  play.kit_baseline = kitFromChargen();
  // A chargen edit can take a loaded program out of the kit; the thread list
  // holds names, so it has to follow the kit rather than outlive it (#74).
  pruneLoadedPrograms();
  if (notes.length)
    logCash(`Chargen build edited: ${notes.slice(0, 6).join(", ")}`
      + (notes.length > 6 ? ` +${notes.length - 6} more` : ""), 0);
}

/* ---------------------------------------------- disposing of kit during play
 *
 * Parting with something in play is either a SALE (cash back at whatever the
 * fence pays) or a LOSS (destroyed, confiscated, left in a burning car).
 * Both land in the Activity ledger; only the first moves money.
 *
 * Where the item goes depends on which side of Finalize it came from, and this
 * is the other half of the JC-024 line:
 *
 *   - Bought in play  → spliced out of play.purchases, where it lived.
 *   - Chargen kit     → the chargen array is NOT touched. The index is recorded
 *                       in play.disposed and the engine filters it out of the
 *                       finalized sheet. The creation budget still counts it —
 *                       it was bought with creation cash and that money is
 *                       spent — so Back to Chargen shows the character exactly
 *                       as built, and re-finalizing takes the item away again.
 *                       Revert drops the whole play layer, so it comes back.
 *
 * Before this, every ✕ spliced the owning array. On a chargen item that handed
 * its cost back to the creation budget: sell a weapon in play, go Back to
 * Chargen, and the money was there to spend again.
 */
const DEFAULT_RESALE_PCT = 50;
// The chargen arrays a disposal can be recorded against.
const DISPOSABLE_CATEGORIES = ["weapons", "armor", "gear", "augments", "decks",
  "programs", "rigs", "drones", "vehicles"];

/* Sell / lose / cancel. Resolves to null (cancelled), { sold: false }, or
 * { sold: true, amount }. The percentage is a starting point, not a rule — the
 * amount is editable, because what a fence pays is a table's call, not ours.
 * The last percentage used sticks for the session, so a table running 25%
 * doesn't retype it on every sale. */
let lastResalePct = DEFAULT_RESALE_PCT;
/* `value` is everything the item is worth, fitted kit included. `modsValue` is
 * the slice of that which came from things BOLTED ON — mods, armor extras and
 * Quality/Style surcharges, mounted augments, a drone's guns (#81).
 *
 * The percentage is a CONDITION slider: it prices wear and tear on the thing
 * you are selling, and a scope does not get scratched because the rifle it is
 * clamped to did. Mods therefore come back at face value and only the base
 * price is scaled. The reporter's rationale is the deciding one: a mod could in
 * principle be pulled off and re-fitted elsewhere, but the app has no notion of
 * owning a mod apart from its host, so the only way to let a player re-buy what
 * they had is to hand back what they paid for it.
 *
 * The total stays editable, as it always was — this only moves where the
 * slider's default lands. */
function promptDisposal(name, value, modsValue) {
  return new Promise(resolve => {
    const total = Math.max(0, Math.round(+value || 0));
    // Clamped into the total: a caller that miscounts must not be able to make
    // the scaled part negative and have the slider read backwards.
    const mods = Math.max(0, Math.min(total, Math.round(+modsValue || 0)));
    const base = total - mods;
    const backdrop = el("div", { class: "mount-modal-backdrop" });
    const done = val => {
      document.removeEventListener("keydown", onKey); backdrop.remove(); resolve(val);
    };
    const onKey = e => { if (e.key === "Escape") done(null); };

    // Base scaled by condition, fitted kit added back whole (#81).
    const amountOf = pct => Math.round(base * (Math.max(0, Math.min(100, pct)) / 100)) + mods;
    // Both fields sit inside a sentence ("Sell at [ ] % of base -> [ ] Woolongs"),
    // so the words around them are their only label — spelled out here because
    // a screen reader reads the field, not the sentence it is embedded in.
    const pctInput = el("input", { type: "number", min: "0", max: "100", step: "5",
      "aria-label": "Sell at percent of base price",
      value: String(lastResalePct), style: "width:74px" });
    const amtInput = el("input", { type: "number", min: "0", step: "1",
      "aria-label": `Sale price in ${RULES.currencyName()}`,
      value: String(amountOf(lastResalePct)), style: "width:110px" });
    const sellBtn = el("button", { class: "btn-add" }, "Sell");
    const syncFromPct = () => { amtInput.value = String(amountOf(+pctInput.value || 0)); };
    pctInput.addEventListener("input", syncFromPct);

    sellBtn.onclick = () => {
      lastResalePct = Math.max(0, Math.min(100, +pctInput.value || 0));
      done({ sold: true, amount: Math.max(0, Math.round(+amtInput.value || 0)) });
    };

    const modal = el("div", { class: "card mount-modal", style: "max-width:420px" },
      el("h3", {}, `Part with ${name}?`),
      el("p", { class: "hint" },
        (base || mods)
          ? `Bought for ${fmt(total)}. Sell it on, or write it off as lost.`
          : "No recorded value for this item — set the sale price yourself, "
            + "or write it off as lost."),
      // Spelled out because the sum stops being obvious once mods are in it:
      // the number in the box is not the percentage of the price above (#81).
      mods
        ? el("p", { class: "hint" },
            `${fmt(mods)} of that is fitted mods, which come back in full — the `
            + `percentage below applies to the ${fmt(base)} base price only.`)
        : null,
      el("div", { class: "stat-line" },
        el("span", {}, "Sell at "), pctInput, el("span", {}, "% "),
        el("span", { class: "sub" }, mods ? "of base → " : "→ "), amtInput,
        el("span", { class: "sub" }, ` ${RULES.currencyName()}`)),
      el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin-top:14px" },
        sellBtn,
        el("button", { class: "btn", onclick: () => done({ sold: false }) }, "Lost / discarded"),
        el("button", { class: "btn ghost", onclick: () => done(null) }, "Cancel")));
    backdrop.append(modal);
    backdrop.addEventListener("click", e => { if (e.target === backdrop) done(null); });
    document.addEventListener("keydown", onKey);
    document.body.append(backdrop);
    amtInput.focus(); amtInput.select();
  });
}

function deepCopyEntry(entry) {
  return (entry && typeof entry === "object") ? JSON.parse(JSON.stringify(entry)) : entry;
}
const sublistName = m => (m && typeof m === "object") ? m.name : m;

/* ------------------------------------------------- (#81) fitted-kit value
 *
 * What the things bolted onto an owned item are worth. Every one of these feeds
 * promptDisposal's `modsValue`, which hands them back at face value while the
 * condition percentage scales only the host's own price.
 *
 * Each helper quotes a fitted thing at exactly the price its OWN ✕ quotes, so
 * "sell the gun" and "strip it, then sell it" come to the same money. That
 * equality is the reason these read the tables again rather than reaching for a
 * CALC total: CALC.armor.cost folds the trim into one number that can't be
 * split back out reliably once rounding has been applied to the sum.
 *
 * The α-cyber surcharge on a mounted augment is deliberately NOT counted. The
 * mount chip's own ✕ doesn't offer it either, and quoting two different prices
 * for the same augment depending on which button was pressed would be worse
 * than under-quoting it consistently. */
function mountedValue(item, mult) {
  return ((item || {}).mounted || []).reduce((sum, m) => {
    const row = (DATA.tables.augments || []).find(a => a.Name === sublistName(m)) || {};
    return sum + Math.round((+row.Cost || 0) * mult);
  }, 0);
}

/* Flat-priced fitted lists: deck mods, rig mods, and a drone's or vehicle's
 * unit mods and hardpoint weapons. `tables` is a list of [tableKey, nameColumn]
 * pairs, because a unit's guns are spread across several tables and are looked
 * up by trying each in turn — the same search findWeapon does on the rig tab.
 * A name no table knows (a deleted homebrew row) contributes nothing rather
 * than throwing, matching how the rest of the sheet treats an orphan. */
function flatFittedValue(names, tables, mult) {
  return (names || []).reduce((sum, m) => {
    const n = sublistName(m);
    for (const [tk, nc] of tables) {
      const row = (DATA.tables[tk] || []).find(x => x[nc] === n);
      if (row) return sum + Math.round((+row.Cost || 0) * mult);
    }
    return sum;
  }, 0);
}

/* Weapon mods are priced against the gun they are fitted to — a percentage-
 * priced mod (Bling) costs a share of THIS weapon — so this needs the entry and
 * its table row, not just the mod names. Same call weaponModSlots' `priceOf`
 * makes, so the slot chip and the whole-weapon sale agree. */
function weaponModsValue(item, weaponRow, mult) {
  const base = RULES.weaponBaseCost(weaponRow || {}, item);
  return ((item || {}).mods || []).reduce((sum, m) => {
    const row = (DATA.tables.weapon_mods || []).find(x => x.Modification === sublistName(m));
    return sum + (row ? Math.round(RULES.weaponModCost(row, base) * mult) : 0);
  }, 0);
}

/* Armor's "mods" are its trim: Quality (material), Style and Extras. They are
 * multipliers rather than list entries, but they are bought and refunded like
 * mods — armorTraitSelect and the Extras picker both charge base × (mult − 1) —
 * so they belong in the un-scaled half of a sale.
 *
 * A multiplier BELOW 1 makes a surcharge negative: shoddy material is a
 * discount, not a fitting worth money. The sum can therefore come out negative,
 * and promptDisposal clamps it to zero, which is the right reading — there is
 * nothing there to refund at face value, so the whole (already reduced) price
 * is what the condition slider scales. */
function armorTrimValue(item, armorRow, baseCost, mult) {
  const surcharge = (tableKey, column, name) => {
    const row = name ? (DATA.tables[tableKey] || []).find(x => x[column] === name) : null;
    return row ? Math.round(baseCost * ((+row.Multiplier || 1) - 1) * mult) : 0;
  };
  let total = surcharge("armor_materials", "Material", (item || {}).material);
  // Style and Extras only exist on styleable pieces; a stale value on a fixed
  // design was never charged for, so it must not be refunded either.
  if ((armorRow || {}).Style === "Y") {
    total += surcharge("armor_styles", "Style", item.style);
    for (const extra of item.extras || [])
      total += surcharge("armor_extras", "Extra", sublistName(extra));
  }
  return total;
}

/* The one entry point every ✕ on the play sheet goes through. `arr` is the
 * array the row is backed by — the kit or play.purchases, both play's — so
 * parting with something is now just a splice. Returns true when it happened. */
async function disposeOfItem({ category, arr, index, inPlay, name, value, modsValue }) {
  const result = await promptDisposal(name, value, modsValue);
  if (!result) return false;
  const entry = deepCopyEntry(arr[index]);
  arr.splice(index, 1);
  logCash(`${result.sold ? "Sold" : "Lost"} ${name}`, result.sold ? result.amount : 0,
    { kind: "restore_item", category, inPlay, at: index, entry });
  await playChangedRecalc();
  return true;
}

/* Sublists inside an owned item: weapon mods, armor extras, deck/rig/unit mods,
 * mounted augments, a drone's weapons. The host is play's own copy either way
 * now, so these are plain array operations — no records, no replay, no
 * index bookkeeping. The shape is kept so call sites read the same. */
function sublistOf(entry, list) {
  const arr = entry.ref[list] = entry.ref[list] || [];
  return { items: arr, add: v => arr.push(v), removeAt: i => { arr.splice(i, 1); } };
}

/* Pulling a mod off a drone or vehicle. Unit mods point at the unit's weapons
 * by index, so removeUnitWeapon renumbers them; restoring one out of a
 * renumbered set isn't a safe single step, hence no Undo button here. */
async function disposeOfUnitMod(entry, modIndex, name, hostName, value) {
  const result = await promptDisposal(name, value);
  if (!result) return false;
  entry.ref.mods.splice(modIndex, 1);
  logCash(`${result.sold ? "Sold" : "Lost"} ${name} (off ${hostName})`,
    result.sold ? result.amount : 0);
  await playChangedRecalc();
  return true;
}

/* Pulling something off an item: same dialog, same ledger, same undo as
 * parting with the item itself. Returns true when it went ahead. */
async function disposeOfMod({ entry, list, index, name, value, hostName }) {
  const result = await promptDisposal(name, value);
  if (!result) return false;
  const sub = sublistOf(entry, list);
  const removed = deepCopyEntry(sub.items[index]);
  sub.removeAt(index);
  logCash(`${result.sold ? "Sold" : "Lost"} ${name} (off ${hostName})`,
    result.sold ? result.amount : 0,
    { kind: "restore_mod", category: entry.category, inPlay: entry.inPlay,
      host: entry.i, list, at: index, entry: removed });
  await playChangedRecalc();
  return true;
}

/* Sell (or forget) a known spell — issue #82's "sell spells like ordinary
 * gear". It goes through the same promptDisposal dialog everything else does,
 * so the condition percentage, the editable amount and the "Lost / discarded"
 * option all behave exactly as they do for a gun.
 *
 * `modsValue` is deliberately not passed: a spell has nothing bolted to it, so
 * the whole price is what the slider scales. Its Force advances are NOT carved
 * out either — they were bought at the same per-Force rate as the spell itself,
 * so they are part of the one price, not a fitting.
 *
 * The two halves are stored differently and that is the point:
 *   - bought in play  -> splice play.purchases.spells, undo re-inserts it, the
 *                        same restore-at-index shape gear disposal uses;
 *   - from chargen    -> record the NAME in play.spells_forgotten, because the
 *                        chargen record must not be written to after Finalize
 *                        (splicing CHAR.magic.spells would refund the spell's
 *                        price into the CREATION budget). Undo drops the name.
 *
 * Force advances are left in play.spell_force_advances untouched. They go inert
 * the moment the spell is gone — applyPlayAdvances only walks spells the
 * character still has — and leaving them is what lets Undo bring the spell back
 * at the Force it was sold at rather than the Force it was learned at. */
async function sellSpell(sp, value) {
  const play = CHAR.play;
  const result = await promptDisposal(sp.name, value);
  if (!result) return false;
  const verb = result.sold ? "Sold" : "Forgot";
  if (sp.inPlay) {
    const list = play.purchases.spells;
    const at = list.map(x => x.name).lastIndexOf(sp.name);
    if (at < 0) return false;
    const entry = deepCopyEntry(list[at]);
    list.splice(at, 1);
    logCash(`${verb} ${sp.name}`, result.sold ? result.amount : 0,
      { kind: "restore_spell", at, entry });
  } else {
    play.spells_forgotten = play.spells_forgotten || [];
    if (play.spells_forgotten.includes(sp.name)) return false;
    play.spells_forgotten.push(sp.name);
    logCash(`${verb} ${sp.name}`, result.sold ? result.amount : 0,
      { kind: "unforget_spell", name: sp.name });
  }
  // A spell that is currently up can't stay up once it's been sold. Same rule
  // pruneLoadedPrograms applies to a sold program's thread, and like that one it
  // is not restored by Undo: the spell comes back, but whether it is cast again
  // is the player's call, not a bookkeeping consequence.
  play.active_spells = activeSpells().filter(s => s.name !== sp.name);
  await playChangedRecalc();
  return true;
}

function chargenLifestyles() {
  return (CHAR.lifestyles && CHAR.lifestyles.length)
    ? CHAR.lifestyles
    : (CHAR.lifestyle && CHAR.lifestyle.name ? [CHAR.lifestyle] : []);
}

/* Snapshot the chargen months so a later sync can tell "the player burned a
 * month" from "someone corrected the purchase in chargen". */
function stampLifestyleBaseline(play) {
  // Rebuilt, not merged: the baseline is "what chargen said at the last sync",
  // the same contract as kit_baseline. Merging left names chargen had dropped
  // in it forever, and the removal pass below keys off exactly this map — so a
  // stale key would delete a lifestyle bought later in play (issue #75).
  const baseline = play.lifestyles_baseline = {};
  for (const ls of chargenLifestyles()) baseline[ls.name] = Math.max(0, +ls.months || 0);
  play.lifestyles_reconciled = true;
  return baseline;
}

function seedLifestyles() {
  const play = CHAR.play;
  if (play.lifestyles_seeded) return;
  chargenLifestyles().forEach((ls, i) =>
    play.lifestyles.push({ name: ls.name, months: ls.months || 0, active: i === 0 }));
  play.lifestyles_seeded = true;
  stampLifestyleBaseline(play);
}

/* Merge chargen (prepaid) lifestyles into play at finalize. Adds any not present
 * by name, and — because chargen months are BOUGHT with creation cash — carries
 * a corrected month count across to the play balance too. Runs only at an
 * explicit finalize (not on every sheet view), so it never resurrects a
 * lifestyle the player removed during play.
 *
 * Months are only overwritten when the chargen record itself changed since the
 * last sync. A re-finalize that didn't touch lifestyles leaves the play balance
 * alone, so months burned in play aren't handed back for an unrelated edit.
 *
 * Removals are the mirror image, and the half that was missing (issue #75):
 * swapping Low for Middle in chargen is a delete plus an add, so an insert-only
 * merge left Low in play — still flagged active, because the new entry could
 * only ever be pushed inactive — and the sheet went on reporting the lifestyle
 * the player had just replaced. This is the same baseline-diff reconcileKit
 * uses for gear: anything the baseline had and chargen no longer does was
 * removed by the owner, while a lifestyle bought in play was never in the
 * baseline and is left alone. */
function syncChargenLifestyles() {
  const play = CHAR.play;
  play.lifestyles = play.lifestyles || [];
  const baseline = play.lifestyles_baseline = play.lifestyles_baseline || {};
  const now = chargenLifestyles();
  for (const ls of now) {
    const months = Math.max(0, +ls.months || 0);
    const existing = play.lifestyles.find(p => p.name === ls.name);
    if (!existing) {
      play.lifestyles.push({ name: ls.name, months, active: play.lifestyles.length === 0 });
    } else if (baseline[ls.name] !== months && existing.months !== months) {
      logCash(`${ls.name} lifestyle corrected in chargen: `
        + `${existing.months} → ${months} mo`, 0,
        { kind: "lifestyle_adjust", name: ls.name, from: existing.months });
      existing.months = months;
    }
  }
  for (const name of Object.keys(baseline)) {           // dropped in chargen
    if (now.some(ls => ls.name === name)) continue;
    const at = play.lifestyles.findIndex(p => p.name === name);
    if (at < 0) continue;
    const gone = play.lifestyles[at];
    logCash(`${name} lifestyle dropped in chargen (${gone.months || 0} mo)`, 0,
      { kind: "lifestyle_restore", name, months: gone.months || 0, at });
    play.lifestyles.splice(at, 1);
  }
  // Dropping the active one leaves nobody current, and the overview reads the
  // active flag — so hand it to whatever is left rather than showing "none".
  if (play.lifestyles.length && !play.lifestyles.some(l => l.active))
    play.lifestyles[0].active = true;
  play.lifestyles_seeded = true;
  stampLifestyleBaseline(play);
}

/* One-time repair for characters finalized before 2026-08-05.
 *
 * play.lifestyles was seeded from chargen once and then never reconciled: both
 * copiers above were insert-only by name, so correcting the months in chargen
 * left the play balance stranded at its old value with no way to fix it short
 * of a full Revert. Those characters carry no baseline, which is how we spot
 * them. Chargen months are paid for out of creation cash, so the chargen record
 * wins and the play balance is reset to it.
 *
 * This can hand back months already burned, because burning one was never
 * recorded anywhere — there is no evidence to tell the two apart. Every change
 * is written to the Activity ledger so it is visible and undoable, and it
 * happens once: from here on the baseline exists and month changes are logged
 * as they happen. */
function reconcileLifestyles() {
  const play = CHAR.play;
  if (!play.lifestyles_seeded || play.lifestyles_reconciled) return;
  for (const ls of chargenLifestyles()) {
    const months = Math.max(0, +ls.months || 0);
    const existing = (play.lifestyles || []).find(p => p.name === ls.name);
    if (!existing || existing.months === months) continue;
    logCash(`${ls.name} lifestyle resynced to the chargen purchase: `
      + `${existing.months} → ${months} mo`, 0,
      { kind: "lifestyle_adjust", name: ls.name, from: existing.months });
    existing.months = months;
  }
  stampLifestyleBaseline(play);
}

function enterSheet() {
  ensurePlay();
  seedLifestyles();
  sheetTab = "overview";
  expandedPool = null;
  sheetStickyScrolled = false;   // entering always lands at the top
  $("#app").hidden = true;
  $("#sheet").hidden = false;
  renderSheet();
  window.scrollTo(0, 0);
}
function exitSheet() {
  if (sheetHeadObserver) { sheetHeadObserver.disconnect(); sheetHeadObserver = null; }
  sheetStickyScrolled = false;
  removeSkipLink();
  $("#sheet").hidden = true;
  $("#app").hidden = false;
}

/* Reset the play layer back to how it looked right after Finalize.
 * No snapshot needed: the chargen record (attributes, skills, gear, decks…)
 * is never mutated during play — advancement and purchases live in CHAR.play
 * — so reverting is just rebuilding CHAR.play, keeping only the original
 * starting-cash roll. */
async function revertToChargenEnd() {
  const play = CHAR.play;
  if (!confirm("Revert this character to their state at the end of character generation?\n\n"
    + "This permanently erases everything gained in play:\n"
    + `  • Kismet (${play.kismet} available, ${play.kismet_earned} lifetime) and all advances\n`
    + "  • Everything bought in play (weapons, armor, gear, augments, powers, spells, Hacking levels)\n"
    + `  • ${RULES.currencyName()} beyond the original starting roll (back to ${fmt(play.starting_cash || 0)})\n`
    + "  • Damage, initiative, effects, modifiers, ledgers, and notes\n\n"
    + "The chargen build itself (attributes, skills, purchased gear) is untouched."))
    return;
  const keepRolled = play.cash_rolled;
  const keepStart = play.starting_cash
    || (play.cash_log.find(e => e.label.startsWith("Starting cash roll")) || {}).delta || 0;
  const rollEntry = play.cash_log.find(e => e.label.startsWith("Starting cash roll"));
  const keepGhost = play.ghost_rating;   // rolled once at first finalize — never re-rolled
  CHAR.play = {};
  ensurePlay();
  CHAR.play.cash_rolled = keepRolled;
  CHAR.play.starting_cash = keepStart;
  CHAR.play.cash = keepStart;
  if (rollEntry) CHAR.play.cash_log = [rollEntry];
  if (keepGhost) CHAR.play.ghost_rating = keepGhost;
  // A fresh copy of the build IS the revert: worn flags, fitted mods,
  // quantities and everything else come back exactly as chargen has them. The
  // old armor_worn snapshot existed only because play used to edit the chargen
  // armor in place; there is nothing left to snapshot.
  CHAR.play.kit = kitFromChargen();
  CHAR.play.kit_baseline = kitFromChargen();
  seedLifestyles();
  await playChangedRecalc();
  alert("Character reverted to their post-chargen state.");
}

/* auto-generated dossier notes that don't fit the tab structure */
function moveSpecial() {   // CALC.combat.move_special is a list of special-movement notes
  const v = CALC.combat.move_special;
  return (Array.isArray(v) ? v.join(" · ") : String(v || "")).trim();
}

function dossierNotes() {
  const notes = [];
  if (CHAR.heritage.type === "Replicant")
    notes.push("Replicants are ILLEGAL and are hunted by government agents. Exposure means retirement squads — keep a low profile.");
  if (CALC.zoetics.magic_offline)
    notes.push(`MAGIC OFFLINE: ZP is ${CALC.zoetics.zp_remaining} — cyber ZR and Amp spending have driven Zoetic Potential negative. Spells, Amps and Summoning are unavailable; only Rituals remain.`);
  else if (CALC.zoetics.amp_offline)
    notes.push(`AMP POWERS OFFLINE: ZP is ${CALC.zoetics.zp_remaining} — Amp ZP spent plus carried ZR exceeds your Zoetic Potential. Shed ZR or lose the powers.`);
  for (const msg of CALC.zoetics.mount_errors || []) notes.push(msg);
  // Special movement is NOT a note. Dossier notes are a warning strip — things
  // that are wrong or dangerous — and "climbs at full speed" is neither; it's a
  // standing capability, and it read as an alarm purely because this was the
  // only place with a list to push it onto. The Move tile in the header owns
  // all of it now, prose quirks and structured alt-modes together.
  // Heritage features are NOT a note. They were listed here as one, which put a
  // red ⚠ callout on every uplift character saying nothing but the trait names —
  // no effects, no problem to act on, and the header already names them. The
  // header band (sh-heritage-abilities) carries them with their effects now.
  return notes;
}

/* Worn armor stacked in one slot. Only ONE Outer and one Under piece is meant to
 * count, but every piece marked active adds to the Ballistic/Impact totals, so a
 * character wearing two coats silently reads several points too tough. The Gear
 * tab's Worn checkbox unticks the slot's other piece, and priceArmor already
 * pushes a warning -- but nothing created before that checkbox existed was
 * cleaned up, an import can arrive in any state, and CALC.warnings is only
 * rendered during chargen (the rail alerts), never on the play sheet.
 *
 * Recomputed from CALC.armor instead of matching the engine's warning text, so
 * the note can name the offending pieces. "Outer*" (Helmet) is deliberately not
 * counted -- it's a separate piece, matching priceArmor. */
function overArmoredSlots() {
  const bySlot = {};
  for (const a of CALC.armor || []) {
    if (!a.active || (a.Slot !== "Outer" && a.Slot !== "Under")) continue;
    (bySlot[a.Slot] ??= []).push(a.Armor);
  }
  return Object.entries(bySlot)
    .filter(([, names]) => names.length > 1)
    .map(([slot, names]) => ({ slot, names }));
}

/* Replicant remaining-lifespan tracker. Rolled once as (1d6+1)×12 months, then
 * ticked down by hand as play advances. Returns null for non-Replicants.
 *
 * Built fresh per call, and deliberately shown in two places — the Overview
 * warning area and the Notes tab's Dossier Notes, where the rest of what being
 * a Replicant costs you is written down. Both are live: only one tab renders at
 * a time and both edit the same play field, so they cannot disagree. */
function replicantLifespanTracker() {
  if (CHAR.heritage.type !== "Replicant") return null;
  const play = CHAR.play;
  if (play.replicant_lifespan_months == null) {
    play.replicant_lifespan_months = (Math.floor(Math.random() * 6) + 1 + 1) * 12;   // (1d6+1)×12
    schedulePlaySave();
  }
  return el("div", { class: "sh-callout warn sh-lifespan" }, "⏳ ",
    miniCounter("Remaining Lifespan (Months)",
      () => play.replicant_lifespan_months || 0,
      v => { play.replicant_lifespan_months = v; }, 0, 9999));
}

/* ------------------------------------------------ shell */
function sheetTabList() {
  // Magic (everyone can learn rituals), Decking and Rigging are always shown so
  // a character can pick up a deck/rig/drone/vehicle in play even if they had
  // none at chargen.
  return [["overview", "Overview"], ["skills", "Skills"], ["kismet", "Kismet"],
    ["gear", "Gear"], ["augments", "Augments"], ["magic", "Magic"],
    ["decking", "Decking"], ["rigging", "Rigging"], ["actions", "Actions"],
    ["notes", "Notes"]];
}

function readonlyBanner() {
  const tab = activeTabObj();
  const who = (tab && tab.owner) ? `${tab.owner}'s` : "a shared";
  return el("div", { class: "sh-readonly-banner" },
    el("span", { class: "sh-ro-label" }, `👁 Viewing ${who} character — read only`),
    el("span", { class: "sh-ro-actions" },
      el("button", { class: "btn small good", onclick: saveReadonlyCopy }, "Save a copy to my account"),
      el("button", { class: "btn small ghost", onclick: () => closeTab(WORKSPACE.active) }, "Close")));
}

/* Reference tables (spirit benefits, rituals, the action reference) are wider
 * than a phone viewport and used to push the whole page sideways, so the sheet
 * scrolled horizontally instead of the table. Give each its own scroll box.
 * Done centrally rather than at the ~20 el("table") call sites; the wrapper is
 * inert when the table already fits, and no CSS selector depends on a table's
 * parent. */
function wrapScrollableTables(root) {
  for (const t of root.querySelectorAll("table")) {
    if (t.parentElement && t.parentElement.classList.contains("sh-tablewrap")) continue;
    const wrap = el("div", { class: "sh-tablewrap" });
    t.replaceWith(wrap);
    wrap.append(t);
  }
}

/* Where the page was and what the player was typing into, so a re-render can
 * put both back.
 *
 * renderSheet() rebuilds everything, which is fine for a click and jarring for
 * a keystroke: editing a tracked effect's dice re-rendered the sheet and threw
 * the reader back to the top of the page mid-word (#57). Fields are identified
 * by a stable data-keep-id rather than by node, because the node they were is
 * gone by the time this runs.
 *
 * Only fields that ask for it are restored. A blanket "refocus whatever was
 * focused" would fight the roller, which does its own more specific version of
 * this, and would resurrect focus on controls a re-render deliberately drops. */
function captureSheetFocus() {
  const a = document.activeElement;
  const id = a && a.dataset ? a.dataset.keepId : null;
  return {
    y: window.scrollY,
    id: id || null,
    start: (id && a.selectionStart != null) ? a.selectionStart : null,
    end: (id && a.selectionEnd != null) ? a.selectionEnd : null,
  };
}

function restoreSheetFocus(snap) {
  if (!snap) return;
  if (snap.y) window.scrollTo({ top: snap.y, behavior: "instant" });
  if (!snap.id) return;
  const next = document.querySelector(`[data-keep-id="${CSS.escape(snap.id)}"]`);
  if (!next) return;
  next.focus({ preventScroll: true });
  // A number input refuses setSelectionRange in some browsers; the caret is a
  // nicety and must not take the focus down with it.
  try { if (snap.start != null) next.setSelectionRange(snap.start, snap.end); } catch { /* not selectable */ }
}

/* Publishes the sticky bar's live height as --sh-sticky-h so nested sticky
 * elements (the gear-tab jump submenu) can park directly beneath it. Queries
 * the DOM fresh each call rather than closing over a captured node, so one
 * `resize` listener (registered once, below) stays valid across every
 * renderSheet() rebuild — the same idiom app.js's publishTabsHeight uses for
 * the chargen tab strip. Without this, resizing the window so .sh-tabs (or,
 * now, the actions strip) re-wraps to another row left the published height
 * stale until the next render. */
function publishStickyBarHeight() {
  const bar = $("#sheet > .sh-stickybar");
  if (bar) document.documentElement.style.setProperty("--sh-sticky-h", bar.offsetHeight + "px");
}
window.addEventListener("resize", publishStickyBarHeight);

function renderSheet() {
  const keep = captureSheetFocus();
  const root = $("#sheet");
  root.innerHTML = "";
  const ro = !!(typeof activeTabObj === "function" && activeTabObj() && activeTabObj().readonly);
  document.body.classList.toggle("sheet-readonly", ro);
  ensureSkipLink();               // parked on <body>, ahead of the workspace strip
  if (ro) root.append(readonlyBanner());
  const head = sheetHeader();
  const bar = sheetStickyBar();
  root.append(head, bar);
  // The tab strip's panel. There is exactly one, rebuilt per tab, so a fixed id
  // is safe and every tab button can point its aria-controls at it. No
  // tabindex: the panel always has focusable content of its own, and an empty
  // stop between the strip and that content would be one more thing to pass.
  const body = el("div", { class: "sheet-body", id: "sh-tabpanel", role: "tabpanel",
    "aria-labelledby": "sh-tab-" + sheetTab });
  ({ overview: shOverview, skills: shSkills, kismet: shKismet, gear: shGear,
     augments: shAugments, magic: shMagic, decking: shDecking,
     rigging: shRigging, actions: shActions, notes: shNotes })[sheetTab](body);
  wrapScrollableTables(body);
  root.append(body);
  root.append(rollerOverlay());
  root.append(scrollTopFab());
  // The full header scrolls away normally; once it leaves the viewport the
  // sticky bar grows a compact summary strip (pools / ZP / cash). The DOM is
  // rebuilt every render, so the observer is re-attached each time.
  publishStickyBarHeight();
  if (sheetHeadObserver) sheetHeadObserver.disconnect();
  // The workspace strip is a fixed bar of height --ws-h at the very top; the
  // sheet's sticky bar parks just below it, so the header counts as "gone" once
  // it slips under both.
  const wsH = parseInt(getComputedStyle(document.documentElement)
    .getPropertyValue("--ws-h"), 10) || 0;
  sheetHeadObserver = new IntersectionObserver(([entry]) => {
    sheetStickyScrolled = !entry.isIntersecting;
    bar.classList.toggle("scrolled", sheetStickyScrolled);
    // The back-to-top FAB rides the same threshold as the shrunk header.
    const fab = document.getElementById("sh-scrolltop");
    if (fab) fab.classList.toggle("visible", sheetStickyScrolled);
    publishStickyBarHeight();
  }, { rootMargin: `-${48 + wsH}px 0px 0px 0px` });
  sheetHeadObserver.observe(head);
  restoreSheetFocus(keep);
}

/* Skip link — hidden until it takes focus, and the first stop inside #sheet so
 * a Tab from the workspace strip reaches it immediately.
 *
 * It jumps to the TAB STRIP rather than to the sheet body, because the strip is
 * this screen's navigation: the header in front of it is some fifty focus stops
 * of pool tiles, meters and counters, and landing on the strip puts the reader
 * one arrow key from any of the ten sections and one Tab from the content of
 * the one they are on. A link straight to the body would skip the header and
 * the navigation both.
 *
 * Focus is moved in script rather than left to the href jump for two reasons:
 * the jump would land on <nav>, whereas what wants focus is the ACTIVE tab
 * button (so the arrow keys work straight away), and preventDefault keeps a
 * #sh-tabs out of the address bar of an app that does no hash routing. The href
 * stays because it is what makes this a link at all. */
function sheetSkipLink() {
  return el("a", { class: "sh-skip-link", href: "#sh-tabs",
    onclick: e => {
      const tab = document.querySelector('.sh-tabs button[aria-selected="true"]')
        || document.querySelector(".sh-tabs button");
      if (!tab) return;                // no strip yet — let the href try
      e.preventDefault();
      tab.focus();                     // scrolling the strip into view is wanted here
    } }, "Skip to sheet tabs");
}

/* The link has to be the FIRST tab stop on the page, and #sheet cannot give it
 * that: <nav id="workspace-tabs"> is above #sheet in index.html and spends ~11
 * stops of its own (the ☰ button, then a chip plus its ⎘ and ✕ per open
 * character), so a link living inside #sheet was reachable only as the 12th
 * stop — it still saved 41 of the 53, but a skip link you have to tab to is
 * most of the way to not having one. Parked on <body> instead, ahead of the
 * strip.
 *
 * Idempotent because renderSheet() runs on every state change: reuse the node
 * if it is already there rather than stacking a fresh link per render. */
function ensureSkipLink() {
  let link = document.querySelector("body > .sh-skip-link");
  if (!link) {
    link = sheetSkipLink();
    document.body.insertBefore(link, document.body.firstChild);
  }
  return link;
}

/* Living on <body> means it outlives the sheet, so it has to be taken down on
 * the way out: chargen has no .sh-tabs, and a first-stop link that does nothing
 * is worse for a keyboard user than no link — it is a promise the page cannot
 * keep. Called from every path that hides #sheet. */
function removeSkipLink() {
  document.querySelector("body > .sh-skip-link")?.remove();
}

/* Smoothly scroll the sheet back to the top. Shared by the back-to-top FAB and
 * the compact sticky strip (click any non-interactive part of it). */
function scrollSheetToTop() { window.scrollTo({ top: 0, behavior: "smooth" }); }

/* Floating "back to top" button, lower-right, just left of the die-roller FAB.
 * Hidden until the header shrinks away; the head observer toggles .visible. */
function scrollTopFab() {
  return el("button", {
    id: "sh-scrolltop",
    class: "sh-scrolltop" + (sheetStickyScrolled ? " visible" : ""),
    title: "Back to top", "aria-label": "Back to top",
    onclick: scrollSheetToTop,
  }, "↑");
}

function counterBtn(label, fn, cls) {
  return el("button", { class: "btn " + (cls || ""), onclick: fn }, label);
}

/* ------------------------------------------------ die roller */
/* Floating d6 success roller: pick a pool size, roll, every 4-6 is a Success.
 * Any die can be selected and re-rolled, but each die only once per roll.
 * State lives here (not in the DOM) so it survives the full rebuilds of
 * renderSheet(); interactions re-render only the overlay itself.
 *
 * Two modes. "free" is a bare pool roll. "initiative" preloads the Focus-pool
 * dice and carries Reaction as a flat bonus added to the successes, writing
 * the total straight into the sheet's Initiative field on every roll and
 * re-roll (see rollerApply). */
/* 100 dice. The old cap was 30, which a high-Force spell or a fully-stacked
 * attack can genuinely exceed — the ceiling was a UI convenience, not a rule,
 * and hitting it silently capped a legitimate roll. */
const ROLLER_MAX_DICE = 100;
const rollerD6 = () => 1 + Math.floor(Math.random() * 6);
/* dice: {value, selected, rerolled}
 * `count`     — the LIMIT dice: skill (or skill ± specialization). These are
 *               the dice that come out of a pool, and the only thing the main
 *               ± moves. Shown on its own, the way a weapon chip reads "3d".
 * `bonus`     — flat number added to successes (Initiative's Reaction).
 * `bonusDice` — free dice the roll came WITH: a weapon's Accuracy and firing
 *               mode, a skill's bonus dice. Inherent to the test, so they stay
 *               put across repeat rolls of it.
 * `bonusAdded` — free dice added by hand for this roll: point-blank, good
 *               light, a spirit leaning in. Situational, so they clear once
 *               thrown. Both are rolled and neither costs pool; the Bonus dice
 *               row shows the two together, since what you want to see there is
 *               how many free dice are going in.
 * Dice thrown = count + bonusDice + bonusAdded. Pool spent = count.
 * `pool`      — the pool a roll draws from, "" for none. Sticky between rolls,
 *               because a run of Finesse tests is the normal case. */
/* `penaltyLabel` names where the penalty dice came from, because they are no
 * longer only wounds: Twin Fire adds one of its own (#59) and the roller has to
 * say "Wound + Twin Fire −2d" rather than blaming it all on the wound track.
 * `queue` is a list of further openPoolRoller specs to offer AFTER this one is
 * rolled, and `seq` is the "shot 1 of 2" caption that goes with them. Only one
 * roller panel exists, so a button that means "two separate rolls" has to hand
 * them over one at a time rather than opening two panels (#59). */
const rollerState = { open: false, count: 6, dice: [], bonus: 0, bonusDice: 0,
                      bonusAdded: 0, mode: "free", pool: "", spent: null, penalty: 0,
                      penaltyLabel: "Wound", queue: [], seq: null };
/* Every die in the roll that costs no pool, before penalties. */
const rollerFreeDice = () => (rollerState.bonusDice || 0) + (rollerState.bonusAdded || 0);

/* What actually gets thrown once the wound penalty is taken off.
 *
 * The combat sequence is explicit about the order: penalty dice cancel bonus
 * dice first, and only "once the bonus dice are eliminated" do they lower the
 * limit. So a −2 wound on a roll with 5 bonus dice costs no limit at all, and a
 * −2 on a roll with none takes 2 off the limit — and with it, 2 off the pool,
 * since the pool only ever pays for limit dice. */
function rollerEffective() {
  const st = rollerState;
  const penalty = Math.max(0, st.penalty || 0);
  const free = rollerFreeDice();
  const bonus = Math.max(0, free - penalty);
  const limit = Math.max(0, Math.max(0, st.count) - Math.max(0, penalty - free));
  return { penalty, free, bonus, limit, total: bonus + limit,
           bonusLost: free - bonus, limitLost: Math.max(0, st.count) - limit };
}
const rollerTotalDice = () => rollerEffective().total;

function rollerRefresh() {
  const cur = $("#die-roller");
  if (!cur) return;
  // The dice count is a text field you can type into, and every refresh builds a
  // brand new one — so without this, typing a second digit would lose focus
  // after the first. Remember where the caret was and put it back on the
  // replacement. Only the count field needs this; nothing else here is typed in.
  const active = document.activeElement;
  const wasCount = active && active.classList
    && active.classList.contains("sh-roller-count-input");
  const caret = wasCount ? active.selectionStart : null;
  cur.replaceWith(rollerOverlay());
  if (!wasCount) return;
  const next = $("#die-roller .sh-roller-count-input");
  if (!next) return;
  next.focus();
  // A number input rejects setSelectionRange in some browsers; the caret is a
  // nicety, so losing it must not take the focus down with it.
  try { next.setSelectionRange(caret, caret); } catch { /* not selectable */ }
}

/* The wound penalty the tracks currently impose: every 3 boxes marked on either
 * track is −1 die on tasks, cumulative, doubled by a Reaction Enhancer and
 * negated outright by a Pain Nullifier. `dice` is signed (−2), `size` is the
 * count of penalty dice (2). Shared by the Condition card and the die roller,
 * so what the sheet says you're suffering is what the roller takes off. */
function woundPenalty() {
  const play = CHAR.play || {};
  const raw = -(Math.floor((play.physical_damage || 0) / 3) + Math.floor((play.stun_damage || 0) / 3));
  const negated = !!(CALC.combat || {}).wound_penalty_negated;
  const doubled = !!(CALC.combat || {}).wound_penalty_doubled;
  const dice = negated ? 0 : raw * (doubled ? 2 : 1);
  return { raw, negated, doubled, dice, size: Math.abs(dice) };
}

/* Initiative as shown on the sheet: Focus-pool dice + Reaction ("12d+8"). */
function sheetInitiative() {
  return CALC.initiative
    || { dice: CALC.pools.Focus, bonus: CALC.attributes.Reaction.final, notes: [] };
}

/* Open the roller loaded with a named test's dice — what every clickable dice
 * figure on the sheet calls. `dice` is the limit (skill, or skill + Accuracy on
 * a weapon) and `bonus` the bonus dice from firing mode, light, point-blank and
 * so on; both are dice you roll, so they add into one count. It stops at
 * loading them: penalty dice from range, cover and lighting are a table call,
 * and the ± steppers are right there to apply them before you roll. */
/* `extraPenalty` is a penalty die the TEST itself carries, as distinct from the
 * situational ones the player dials in with ± — Twin Fire's −1 for firing two
 * guns at once is one, and it has to arrive already applied or the button would
 * be handing over a roll that is a die too generous (#59). `queue`/`seq` drive
 * the follow-up roll; see rollerState. Every call assigns all of them, so a
 * plain roll opened after a queued one starts clean rather than inheriting a
 * stale queue or somebody else's penalty label. */
function openPoolRoller({ dice, bonus = 0, label, note, pool,
                          extraPenalty = 0, penaltyLabel = null, queue = null, seq = null }) {
  const wound = woundPenalty().size;
  const extra = Math.max(0, +extraPenalty || 0);
  Object.assign(rollerState, {
    open: true, mode: "pool", label: label || "", note: note || "",
    dice: [], bonus: 0, spent: null, bonusAdded: 0,
    queue: Array.isArray(queue) ? queue.slice() : [],
    seq: seq || null,
    // Skill dice in the count, bonus dice in the bonus row — the roller reads
    // the way the chip that opened it does.
    bonusDice: Math.max(0, Math.min(ROLLER_MAX_DICE, +bonus || 0)),
    count: Math.max(0, Math.min(ROLLER_MAX_DICE, +dice || 0)),
    // A test rolled off a skill knows which pool it draws from; keep the last
    // choice when the caller doesn't say.
    pool: pool !== undefined ? (pool || "") : rollerState.pool,
    // Wounds are a standing condition, not a situational modifier, so the
    // roller takes them off every test without being asked (issue #30).
    penalty: wound + extra,
    penaltyLabel: penaltyLabel
      || (extra && wound ? "Wound + test" : extra ? "Test" : "Wound"),
  });
  // A roll with nothing in it is no roll: a caller that preloads only bonus
  // dice (Soak, Dodge) starts at zero limit, but a bare one needs a die.
  if (rollerTotalDice() < 1 && !rollerFreeDice()) rollerState.count = Math.max(1, rollerState.count);
  rollerRefresh();
}

/* Take the roll's limit dice out of the chosen pool. Bonus dice are free — they
 * come from the firing mode or the light, not from you — so only the part of
 * the count that isn't bonus is spent. Returns what actually moved, which can
 * be short of the ask when the pool is nearly out. */
function rollerSpendPool() {
  const st = rollerState;
  if (!st.pool || st.mode === "initiative") return null;
  // A shared view can roll all it likes; it doesn't get to spend someone else's
  // pool, even transiently (nothing persists there, but the chip would move).
  if (activeTabObj() && activeTabObj().readonly) return null;
  // Only limit dice cost pool, and only the ones that survived the penalty.
  const want = rollerEffective().limit;
  if (!want) return null;
  const ps = poolState(st.pool);
  const spend = Math.min(want, ps.remaining);
  const result = { pool: st.pool, want, spend, left: ps.remaining - spend };
  if (spend > 0) ps.setUsed(ps.used + spend);   // persists and re-renders
  return result;
}

/* A dice figure you can click to load the roller. Wraps whatever the caller
 * already renders (a rating, a "(4d +1b)" chip) so the reading stays put and
 * only the affordance is added. */
function rollable(node, { dice, bonus = 0, label, note, title, pool }) {
  const total = Math.max(0, (+dice || 0) + (+bonus || 0));
  if (!total) return node;      // nothing to roll — leave it as plain text
  return el("button", {
    class: "sh-rollable", type: "button",
    title: (title || `Roll ${total}d6 — ${label}`)
      + (pool ? ` · costs ${dice} ${pool}` : ""),
    onclick: e => { e.stopPropagation(); openPoolRoller({ dice, bonus, label, note, pool }); },
  }, node);
}

/* Open the roller preloaded for an Initiative roll. */
function openInitiativeRoller() {
  const init = sheetInitiative();
  Object.assign(rollerState, {
    open: true, mode: "initiative", dice: [],
    count: Math.max(1, Math.min(ROLLER_MAX_DICE, init.dice || 1)),
    bonus: init.bonus || 0,
  });
  rollerRefresh();
}

/* In initiative mode, push successes + bonus into the play sheet's Initiative
 * field. The input is patched in place rather than via renderSheet() so the
 * open roller isn't torn down mid-interaction; the value is still persisted. */
function rollerApply() {
  if (rollerState.mode !== "initiative") return;
  const successes = rollerState.dice.filter(d => d.value >= 4).length;
  CHAR.play.initiative = successes + rollerState.bonus;
  schedulePlaySave();
  const input = $(".sh-init-input");
  if (input) input.value = String(CHAR.play.initiative);
}

function rollerOverlay() {
  const st = rollerState;
  const wrap = el("div", { id: "die-roller" });
  wrap.append(el("button", {
    class: "sh-roller-fab" + (st.open ? " open" : ""),
    title: st.open ? "Close die roller" : "Die roller",
    "aria-label": st.open ? "Close die roller" : "Open die roller",
    // The FAB always opens a plain pool roll; the Initiative card's own button
    // is what puts the roller into initiative mode.
    onclick: () => {
      if (!st.open && st.mode !== "free") {
        Object.assign(st, { mode: "free", bonus: 0, bonusDice: 0, bonusAdded: 0,
          dice: [], spent: null });
      }
      // Reopening by hand is a NEW roll, so a queued follow-up and any
      // test-specific penalty from the roll before it are dropped here along
      // with the dice — otherwise the FAB would silently resume someone's
      // half-finished Twin Fire (#59).
      if (!st.open) {
        st.penalty = woundPenalty().size;   // refresh: wounds change
        st.penaltyLabel = "Wound";
        st.queue = [];
        st.seq = null;
      }

      st.open = !st.open;
      rollerRefresh();
    },
  }, "⚄"));
  if (!st.open) return wrap;

  const successes = st.dice.filter(d => d.value >= 4).length;
  const selected = st.dice.filter(d => d.selected).length;
  // Room left for more dice of either kind — 30 is the whole roll, not each half.
  const headroom = () => ROLLER_MAX_DICE - rollerTotalDice();
  // The main ± moves the skill dice, which are exactly the dice a pool pays
  // for: trimming for penalty dice trims the cost and leaves the free dice be.
  const stepBtn = (delta, label) => el("button", {
    class: "sh-roller-step", title: delta < 0 ? "One skill die fewer" : "One skill die more",
    onclick: () => {
      const next = st.count + delta;
      st.count = Math.max(0, delta > 0 ? Math.min(next, st.count + Math.max(0, headroom())) : next);
      if (rollerTotalDice() < 1) st.count = 1;      // never roll nothing
      rollerRefresh();
    },
  }, label);

  const isInit = st.mode === "initiative";
  const isPool = st.mode === "pool";
  const panel = el("div", { class: "sh-roller" },
    el("div", { class: "sh-roller-head" },
      isInit ? "Initiative Roll" : (isPool && st.label) ? st.label : "Die Roller",
      // "Shot 1 of 2" — a queued roll has to say which one you are looking at,
      // or the second Twin Fire roll is indistinguishable from a stray reopen.
      (isPool && st.seq)
        ? el("span", { class: "sh-roller-seq" }, `${st.seq.i} of ${st.seq.n}`) : null,
      el("button", { class: "sh-roller-close", title: "Close",
        onclick: () => { st.open = false; rollerRefresh(); } }, "✕")),
    el("div", { class: "sh-roller-controls" },
      stepBtn(-1, "–"),
      // The skill dice, as a box you can type into. It used to be a read-only
      // "3d6 +2b" label, which meant reaching 40 dice was forty clicks of the +
      // spinner. The spinners still drive it — this is the same st.count they
      // move — and the free dice keep their "+2b" shorthand beside it rather
      // than inside the field, because those are not yours to type.
      (() => {
        const eff = rollerEffective();
        const suffix = (eff.bonus ? ` +${eff.bonus}b` : "") + (st.bonus ? ` +${st.bonus}` : "");
        return el("span", { class: "sh-roller-count",
            title: `${eff.total}d6 thrown — ${eff.limit} skill`
              + (eff.bonus ? ` + ${eff.bonus} bonus` : "")
              + (eff.penalty
                  ? ` · ${(st.penaltyLabel || "Wound").toLowerCase()} −${eff.penalty} already taken off`
                  : "") },
          el("input", { type: "number", class: "sh-roller-count-input",
            min: "0", max: String(ROLLER_MAX_DICE),
            value: String(st.count),
            "aria-label": "Skill dice",
            oninput: e => {
              // Typed dice are limit dice, and the cap is the whole roll, so the
              // free dice already in the roll take their share of the 100 first.
              const free = rollerTotalDice() - st.count;
              const raw = parseInt(e.target.value, 10);
              st.count = Number.isFinite(raw)
                ? Math.max(0, Math.min(raw, ROLLER_MAX_DICE - free))
                : 0;
              rollerRefresh();
            },
            // An empty box while typing is fine; an empty box you walked away
            // from is a roll of nothing, so it settles back to a usable value.
            onblur: () => { if (rollerTotalDice() < 1) { st.count = 1; rollerRefresh(); } },
          }),
          // "d6" was noise beside a box you type a die count into — the panel
          // is a die roller, and nothing else in it is measured in anything
          // else (#48). The bonus-dice shorthand stays: that IS information.
          suffix ? el("span", { class: "sh-roller-count-unit" }, suffix) : null);
      })(),
      stepBtn(1, "+"),
      el("button", { class: "btn sh-roller-roll",
        // Wounds can take a small test to nothing. That's the rule, but it has
        // to read as "you can't attempt this" rather than as a broken button.
        ...(rollerTotalDice() < 1 ? { disabled: "1",
          title: "No dice left once the wound penalty is applied" } : {}),
        onclick: () => {
        if (rollerTotalDice() < 1) return;
        st.dice = Array.from({ length: rollerTotalDice() },
          () => ({ value: rollerD6(), selected: false, rerolled: false }));
        rollerApply();
        st.spent = rollerSpendPool();   // re-renders the sheet if a pool moved
        // Hand-added dice belong to the roll that was just made — point-blank
        // range, that light, that one spirit — so they come off with it and a
        // second roll of the same test doesn't inherit a situation that has
        // passed. The dice the test came WITH (Accuracy, firing mode) stay:
        // they're the weapon, not the moment.
        if (st.bonusAdded) {
          if (st.spent) st.spent.bonus = st.bonusAdded;
          st.bonusAdded = 0;
        }
        rollerRefresh();
      } }, "Roll")));

  // Pool selector: which pool the roll comes out of. Initiative doesn't spend
  // one, so it isn't offered there.
  if (!isInit) {
    const sel = el("select", { class: "sh-roller-pool",
      title: "Rolling spends this many dice from this pool (bonus dice are free)",
      onchange: e => { st.pool = e.target.value; rollerRefresh(); } },
      el("option", { value: "" }, "No pool"),
      ...POOL_ORDER.map(p => {
        const ps = poolState(p);
        return el("option", { value: p }, `${p} ${ps.remaining}/${ps.max}`);
      }));
    sel.value = st.pool || "";
    const eff = rollerEffective();
    const freeDice = rollerFreeDice();
    panel.append(el("div", { class: "sh-roller-poolrow" }, sel,
      el("span", { class: "sub" }, st.pool
        ? `−${eff.limit}d on roll${eff.bonus ? ` (${eff.bonus} bonus free)` : ""}`
        : "no pool spent")));
    // Wounds come off before anything else is decided, so they're stated here
    // rather than left for the player to subtract (issue #30). Cancelling bonus
    // dice first is the combat sequence's own order.
    if (eff.penalty)
      panel.append(el("div", { class: "sh-roller-wound" },
        `${st.penaltyLabel || "Wound"} −${eff.penalty}d applied`
        + (eff.bonusLost ? ` · ${eff.bonusLost} bonus ${eff.bonusLost === 1 ? "die" : "dice"} cancelled` : "")
        + (eff.limitLost ? ` · ${eff.limitLost} off the limit` : "")));

    // Bonus dice: thrown with the rest, but off the table's own ledger rather
    // than out of you — a firing mode, point-blank range, good light, a spirit
    // leaning in. The count above moves with them; the pool cost does not.
    // Stepping the main ± moves the limit dice, so the two controls between
    // them say "how many I'm putting in" and "how many I'm being given".
    // The row shows every free die going in — the ones the test came with and
    // the ones added here — because that's the number you check before rolling.
    // ± only ever adds or removes hand-added ones first; the built-in dice go
    // last, and come back when the roll is reloaded from its chip.
    const bonusStep = (delta, label, title) => el("button", {
      class: "sh-roller-step", title,
      onclick: () => {
        if (delta > 0) {
          if (headroom() > 0) st.bonusAdded = (st.bonusAdded || 0) + 1;
        } else if (st.bonusAdded > 0) {
          st.bonusAdded -= 1;
        } else if (st.bonusDice > 0 && rollerTotalDice() > 1) {
          st.bonusDice -= 1;               // trimming a built-in bonus die
        }
        rollerRefresh();
      },
    }, label);
    panel.append(el("div", { class: "sh-roller-bonusrow" },
      el("span", { class: "sub" }, "Bonus dice"),
      bonusStep(-1, "–", "One fewer free die"),
      el("span", { class: "sh-roller-bonuscount" }, String(freeDice)),
      bonusStep(1, "+", "One more die that costs no pool, for this roll only"),
      el("span", { class: "sub" },
        st.bonusAdded ? `${st.bonusAdded} added this roll` : "no pool cost")));
  }

  if (st.dice.length) {
    panel.append(el("div", { class: "sh-roller-dice" },
      ...st.dice.map(d => el("button", {
        class: "sh-roller-die" + (d.value >= 4 ? " hit" : "")
          + (d.selected ? " sel" : "") + (d.rerolled ? " spent" : ""),
        title: d.rerolled ? `${d.value} — already re-rolled`
          : `${d.value} — tap to ${d.selected ? "keep" : "select for re-roll"}`,
        onclick: () => { if (!d.rerolled) { d.selected = !d.selected; rollerRefresh(); } },
      }, String(d.value)))));
    panel.append(el("div", { class: "sh-roller-succ" },
      el("b", {}, String(successes)), ` Success${successes === 1 ? "" : "es"}`,
      // Initiative adds Reaction to the successes; show the arithmetic.
      st.bonus ? el("span", { class: "sh-roller-sum" }, ` + ${st.bonus} = `) : null,
      st.bonus ? el("b", { class: "sh-roller-total" }, String(successes + st.bonus)) : null,
      st.bonus && isInit ? el("span", { class: "sh-roller-sum" }, " Initiative") : null));
    panel.append(el("button", {
      class: "btn sh-roller-reroll", ...(selected ? {} : { disabled: 1 }),
      onclick: () => {
        for (const d of st.dice) {
          if (d.selected) { d.value = rollerD6(); d.rerolled = true; d.selected = false; }
        }
        rollerApply();
        rollerRefresh();
      },
    }, selected ? `Re-roll ${selected} selected` : "Re-roll selected"));
    // What the roll cost, said once, after it happens. A short pool spends what
    // it has rather than refusing the roll — the dice were already thrown.
    if (st.spent && st.spent.spend > 0)
      panel.append(el("div", { class: "sh-roller-spent" },
        `−${st.spent.spend} ${st.spent.pool}`
        + (st.spent.spend < st.spent.want
            ? ` — ${st.spent.want} needed, pool was short` : "")
        + ` · ${st.spent.left} left`
        + (st.spent.bonus ? ` · ${st.spent.bonus} bonus dice free, now cleared` : "")));
    else if (st.spent && st.spent.want)
      panel.append(el("div", { class: "sh-roller-spent" },
        `${st.spent.pool} is empty — nothing left to spend`));
    panel.append(el("div", { class: "sh-roller-hint" },
      "4–6 = Success. Tap dice to mark for re-roll — each die re-rolls once."
      + (isInit ? " The total is saved to your Initiative." : "")
      + (st.spent ? " Re-rolls cost no further pool." : "")));
    // The handover to a queued follow-up roll (#59). It waits until the dice
    // are down, on purpose: the first shot's successes and its re-rolls are
    // still on screen to be read and used, and only then does the panel
    // reload as the second shot. Nothing has been spent for it — Twin Fire
    // already paid the action, the rounds and the recoil for BOTH shots up
    // front, so this button is purely "show me the other roll" and is safe to
    // press late, or to walk away from.
    if (isPool && st.queue.length) {
      const next = st.queue[0];
      panel.append(el("button", { class: "btn sh-roller-next",
        title: `Open the next roll of this attack — ${next.label}. `
          + "Nothing further is spent; it was all paid when you pressed the button.",
        onclick: () => openPoolRoller({ ...next, queue: st.queue.slice(1) }),
      }, `Next roll → ${next.label}`));
    }
  } else if (rollerTotalDice() < 1) {
    panel.append(el("div", { class: "sh-roller-hint", style: "color:var(--bad)" },
      `The wound penalty takes this test to nothing — there are no dice left to roll. `
      + "Add bonus dice, or heal."));
  } else {
    panel.append(el("div", { class: "sh-roller-hint" },
      isInit
        ? `Roll ${rollerTotalDice()}d6 — every 4–6 is a Success, plus ${st.bonus} Reaction.`
        : `Roll ${rollerTotalDice()}d6 — every 4–6 is a Success.`
          // What made up the count, and the reminder that penalties are yours
          // to apply: the sheet can't know the range or the lighting.
          + (isPool && st.note ? ` ${st.note}.` : "")
          + (isPool ? " Adjust with – / + for penalty dice." : "")));
  }
  wrap.append(panel);
  return wrap;
}

/* Effective ZP = max ZP minus Amp ZP spent minus carried ZR, any fraction
 * knocking off a whole point (5.6 spent on 6 ZP shows 0 / 6), floored at 0.
 * Maximum ZP is unchanged by spending — only ZP advances raise it. Shared by
 * the header meter and the compact sticky strip. */
function zpMeterValues() {
  const z = CALC.zoetics;
  // House rule: ZP remaining = base − cyber − amp (gear ZR is a casting penalty,
  // not a ZP cost) and may go negative. Classic: base − ceil(amp + all carried ZR).
  if (RULES.houseRule("zr") === "houserule")
    return { current: z.zp_remaining, max: z.zp };
  const spent = (z.amp_zp_spent || 0) + (z.zr_total || 0);
  return { current: Math.max(0, z.zp - Math.ceil(spent)), max: z.zp };
}

/* The clickable face of a header box — its name, its live figure, and the ▾
 * that says there is a detail box behind it.
 *
 * Move and Armor make the WHOLE tile role="button"; Initiative and Dodge can't,
 * because each already owns a real <button> (and Initiative a number field), and
 * a role="button" wrapping a live control is both a nesting error and a click
 * that would fire twice. So the affordance is scoped to the part of the card
 * that isn't already interactive: same cursor, same role, same Enter/Space, same
 * "click for…" title. The roll row underneath is left entirely alone.
 *
 * The ▾ is not decoration. cursor:pointer and a title tooltip are both hover-only
 * affordances, and this band is read on an 11" tablet more than anywhere else,
 * where there is no hover at all — the glyph is the only thing that says "there
 * is more here" to a finger. `flag` adds a ★ when the box is hiding something
 * exceptional (an initiative note, standing cover), so a character who has one
 * isn't relying on the reader opening every box on the off-chance. */
function headBoxFace(name, figure, title, open, flag = false) {
  return el("div", { class: "sh-box-face", role: "button", tabindex: "0",
    title, "aria-label": `${name} ${figure} — open detail`,
    onclick: open,
    onkeydown: e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } } },
    el("h3", {}, name,
      flag ? el("span", { class: "sh-box-flag" }, "★") : null,
      el("span", { class: "sh-box-more" }, "▾")),
    el("div", { class: "big" }, figure));
}

/* Initiative, lifted to top level so the header band can carry it (#83).
 * You roll it once at the top of a fight and read it every round after, and it
 * was reachable from the Overview only. Condition took this slot first and gave
 * it back: two damage tracks made the header 1080px on a phone, where this card
 * is a figure, a roll button and a field.
 *
 * What the card no longer prints is the prose: "Focus Pool dice + Reaction" and
 * the ★ notes are true for a character all session and never change between
 * rounds, and the header's own bar is what you consult EVERY round. They now sit
 * one tap away in openInitiativePopover(), whole and expanded on. The figure and
 * the roll row — the two things that are per-round — stay. */
function initiativeCard() {
  const play = CHAR.play;
  // --- initiative + combat numbers
  // Initiative: roll Focus-pool dice, add Reaction — e.g. "12d+8". The Roll
  // button hands that pool to the die roller, which writes the result back
  // into the input below; the input stays directly editable either way.
  const init = sheetInitiative();
  const notes = init.notes || [];
  // The visible "Rolled:" beside the field is its label, so it is a real
  // <label for> rather than an invented aria-label: same words, and clicking
  // it now focuses the field the way a label should.
  const initInput = el("input", { type: "number", class: "sh-init-input",
    id: "sh-init-input", min: "0", value: String(play.initiative || 0),
    oninput: e => { play.initiative = parseInt(e.target.value, 10) || 0; playChanged(false); } });
  return el("div", { class: "card sh-card sh-counter sh-init" },
    headBoxFace("Initiative", `${init.dice}d+${init.bonus}`,
      "Focus Pool dice + Reaction"
        + (notes.length ? ` · ${notes.length} note${notes.length === 1 ? "" : "s"}` : "")
        + " — click for how initiative is rolled",
      openInitiativePopover, notes.length > 0),
    el("div", { class: "sh-counter-btns", style: "margin-top:8px" },
      el("button", { class: "btn roll sh-init-roll", title: "Roll initiative in the die roller",
        onclick: openInitiativeRoller }, "⚄ Initiative"),
      el("label", { class: "sub", for: "sh-init-input", style: "align-self:center" },
        "Rolled:"), initInput));
}

/* Where "Focus Pool dice + Reaction" went, restated and expanded on the way the
 * Move and Armor popovers expand their tiles' tooltips: the header says the
 * figure, this says what the two halves of it are and what you do with the
 * total. Anchored to the face rather than the whole card so it opens under the
 * number, not under the roll button. */
function openInitiativePopover() {
  openAnchoredPopover({
    kind: "initiative", anchorSel: ".sh-init .sh-box-face", label: "Initiative",
    build: (refresh, close) => {
      const init = sheetInitiative();
      const body = [popoverHead("⚄ Initiative", close),
        el("div", { class: "sh-sense" },
          el("div", {}, `${init.dice}d + ${init.bonus}`),
          el("div", { class: "sub" }, "Focus Pool dice + Reaction. Throw the dice, "
            + "count every 4–6 as a Success, then add Reaction — that total is "
            + "where you sit in the round order."))];
      // Rolling initiative does NOT spend Focus: the pool sets how many dice you
      // get, and the roller is in initiative mode with no pool selector for
      // exactly that reason. Worth saying once here, because every other place
      // on the sheet that names a pool is naming something you pay.
      body.push(el("div", { class: "sh-sense" },
        el("div", { class: "sub smaller" }, "⚄ Initiative rolls it and writes the "
          + "total into Rolled: for you. The field stays typeable, for a total "
          + "rolled at the table. Focus is not spent — the pool only sizes the roll.")));
      // The ★ notes are per-character standing riders ("acts twice in the first
      // round", and the like). Prose, and prose is what a popover is for.
      for (const n of (init.notes || [])) {
        body.push(el("div", { class: "sh-sense" },
          el("div", { style: "color:var(--amber)" }, "★ " + n)));
      }
      return body;
    },
  });
}
/* The Condition tracks, lifted out of the Overview so the sheet header can
 * carry them (#83). Wound penalty applies to EVERY roll, and the tracks were
 * reachable only from one tab -- marking a box mid-fight meant leaving
 * whatever tab you were on. Everything the card had comes with it, including
 * the Heal buttons and the Soak roll.
 *
 * Recomputes `play` and `ro` itself rather than closing over shOverview, which
 * is what lets the header call it. */
function conditionCard() {
  const play = CHAR.play;
  const ro = !!(activeTabObj() && activeTabObj().readonly);
  // --- condition (wound penalty folded in — it's derived straight from these tracks)
  const { raw: rawWound, negated: woundNegated, doubled: woundDoubled, dice: wound } = woundPenalty();
  return el("div", { class: "card sh-card" },
    el("div", { class: "sh-card-head" }, el("h3", {}, "Condition"),
      el("span", {},
        counterBtn("Heal Stun", () => {
          play.stun_damage = 0; playChanged();
        }), " ",
        counterBtn("Full Heal", () => {
          play.physical_damage = 0; play.stun_damage = 0; playChanged();
        }, "good"))),
    conditionTrack("Physical", CALC.condition.physical,
      () => play.physical_damage, v => { play.physical_damage = v; }),
    conditionTrack("Stun", CALC.condition.stun,
      () => play.stun_damage, v => { play.stun_damage = v; }),
    el("p", { class: "hint", style: "margin:8px 0 0" },
      `Every 3 boxes marked on either track: ${woundDoubled ? "−2 dice" : "−1 die"} on tasks, `
      + "cumulative. Biotech can remove these penalties during combat."),
    el("div", { class: "stat-line", style: "margin-top:8px" },
      "Wound Penalty",
      el("b", { style: wound < 0 ? "color:var(--bad)" : "color:var(--ok)" },
        wound < 0 ? `${wound} dice` : "0")),
    // Soaking is Brawn out of the pool plus whatever soak dice you're owed, so
    // it opens the roller pointed at Brawn with those already in (issue #39).
    ro ? null : el("div", { class: "sh-counter-btns", style: "margin-top:8px" },
      el("button", { class: "btn roll",
        title: "Roll to soak — Brawn pool dice, plus any passive soak dice",
        onclick: () => openPoolRoller({ dice: 0, bonus: CALC.combat.soak_bonus || 0,
          pool: "Brawn", label: "Soak",
          note: (CALC.combat.soak_bonus ? `${CALC.combat.soak_bonus} passive soak dice — ` : "")
            + "dial in the Brawn you're spending" }) }, "⚄ Soak"),
      el("span", { class: "sub", style: "align-self:center" },
        CALC.combat.soak_bonus ? `+${CALC.combat.soak_bonus} soak dice` : "Brawn pool")),
    woundNegated
      ? el("div", { class: "sub", style: "color:var(--ok)" },
          rawWound < 0 ? `Negated — would be ${rawWound}` : "Wound penalties negated")
      : null,
    woundDoubled
      ? el("div", { class: "sub", style: "color:var(--bad)" },
          "Doubled by " + (CALC.combat.wound_penalty_doubled_by || "an augment")
          + (rawWound < 0 ? ` — would be ${rawWound}` : ""))
      : null,
    CALC.combat.physical_damage_reduction
      ? el("div", { class: "sub", style: "color:var(--ok)" },
          `Damage soak: −${CALC.combat.physical_damage_reduction} physical per hit (min 1) — Platelet Production Enhancement`)
      : null);
}

/* Dodge, likewise lifted to top level for the header band (#83).
 *
 * Dodging is a roll, not a counter: the card works like Soak — a button that
 * opens the roller pointed at Finesse with your passive dodge dice already in.
 * Situational dice (Full Defense, cover) are what the roller's own Bonus ± is
 * for, and they last exactly one roll, which is what "gained in play" meant.
 *
 * It used to carry every WHY of that number in the header: which augments the
 * free dice come from, the "No passive dodge dice — dodging is Finesse out of
 * the pool" sentence when there are none, standing cover, drone riders. All of
 * it is per-character and none of it changes between rounds, so all of it now
 * lives one tap away in openDodgePopover(). What stays is the figure and the
 * roll button.
 *
 * The figure is new here and deliberate: the card used to have no number at all
 * (the old big number was play.dodge_dice, a scratch value nothing ever wrote
 * but its own ±, so it sat at 0 forever and told you nothing). With the prose
 * gone the free-dice total is the one thing worth reading at a glance — and it
 * gives this box the same h3/figure/roll-row shape as Initiative beside it,
 * which is what makes the matched pair match without CSS having to force it. */
function dodgeCard() {
  const play = CHAR.play;
  const c = CALC.combat;
  const ro = !!(activeTabObj() && activeTabObj().readonly);
  const dodgeTracked = play.dodge_dice || 0;      // legacy hand-tracked dice, still counted
  const dodgeFree = (c.dodge_bonus || 0) + dodgeTracked;
  const dodgeRoll = () => openPoolRoller({ dice: 0, bonus: dodgeFree, pool: "Finesse",
    label: "Dodge",
    note: (dodgeFree ? `${dodgeFree} dodge dice free — ` : "")
      + "dial in the Finesse you're spending" });
  // Cover and drone riders are the ★-worthy ones: they change how hard you are
  // to hit and there is no number on the face that hints at them. Hand-tracked
  // dice are already counted into the figure, so they don't earn a star.
  const flagged = !!c.cover || (c.drone_dodge_notes || []).length > 0
    || (c.drone_cover_notes || []).length > 0;
  return el("div", { class: "card sh-card sh-counter sh-dodge" },
    headBoxFace("Dodge", dodgeFree ? `+${dodgeFree}d` : "0d",
      (dodgeFree
        ? `${dodgeFree} free dodge ${dodgeFree === 1 ? "die" : "dice"}`
        : "No passive dodge dice")
        + (c.cover ? ` · cover ${c.cover.label}` : "")
        + " — click for where these come from",
      openDodgePopover, flagged),
    ro
      ? null
      : el("div", { class: "sh-counter-btns", style: "margin-top:8px" },
          el("button", { class: "btn roll",
            title: `Roll to dodge — ${dodgeFree} free dodge ${dodgeFree === 1 ? "die" : "dice"}`
              + " plus whatever Finesse you spend",
            onclick: dodgeRoll }, "⚄ Dodge"),
          el("span", { class: "sub", style: "align-self:center" }, "Finesse pool")));
}

/* Everything the Dodge box used to print under its heading.
 *
 * Same shape as the Armor popover: one row per thing, the thing named on top and
 * where it comes from underneath. The hand-tracked counter comes along whole —
 * it is a control, not prose, but it only exists on characters carrying a legacy
 * value and putting it in the header for them cost a row on everyone's ten tabs.
 * Stepping it re-renders the sheet, which replaces the anchor tile; the popover
 * survives that because it lives on document.body and openAnchoredPopover looks
 * its anchor up by selector each time — but it does have to be told to redraw,
 * which is why the counter here is written out rather than reusing miniCounter():
 * that helper's ± leave their own figure to be repainted by the sheet re-render,
 * and a popover on document.body is exactly the thing that re-render doesn't
 * touch. Same classes, so it looks like every other mini counter. */
function openDodgePopover() {
  openAnchoredPopover({
    kind: "dodge", anchorSel: ".sh-dodge .sh-box-face", label: "Dodge",
    build: (refresh, close) => {
      const play = CHAR.play;
      const c = CALC.combat;
      const ro = !!(activeTabObj() && activeTabObj().readonly);
      const dodgeTracked = play.dodge_dice || 0;
      const dodgeFree = (c.dodge_bonus || 0) + dodgeTracked;
      const sources = c.dodge_sources || [];
      const body = [popoverHead("⚄ Dodge", close),
        el("div", { class: "sh-sense" },
          el("div", {}, dodgeFree
            ? `+${dodgeFree} dodge ${dodgeFree === 1 ? "die" : "dice"}, free`
            : "0 free dodge dice"),
          el("div", { class: "sub" }, sources.length ? sources.join(" · ")
            : "No passive dodge dice — dodging is Finesse out of the pool")),
        el("div", { class: "sh-sense" },
          el("div", { class: "sub smaller" }, "⚄ Dodge opens the roller pointed at "
            + "Finesse with the free dice already in — dial in the Finesse you are "
            + "spending on top. Situational dice (Full Defense, cover) go in with "
            + "the roller's own Bonus ±, and last exactly one roll."))];
      if (dodgeTracked) {
        body.push(el("div", { class: "sh-sense" },
          el("div", { style: "color:var(--amber)" },
            `includes ${dodgeTracked} hand-tracked`),
          el("div", { class: "sub" }, "A legacy count kept by hand. It is already "
            + "in the figure above; clear it here once the engine covers it."),
          ro ? null : (() => {
            const step = d => () => {
              CHAR.play.dodge_dice = Math.max(0, Math.min(99, (CHAR.play.dodge_dice || 0) + d));
              playChanged();
              refresh();
            };
            return el("span", { class: "sh-mini" },
              el("span", { class: "lbl" }, "Tracked dodge dice"),
              el("button", { class: "mini-btn", title: "One fewer hand-tracked die",
                onclick: step(-1) }, "−"),
              el("b", {}, String(dodgeTracked)),
              el("button", { class: "mini-btn", title: "One more hand-tracked die",
                onclick: step(1) }, "+"));
          })()));
      }
      // A deployed drone whose rider is about dodging says so here, where you
      // roll it — a Shield Drone's "reroll 1s" is not a number the engine can add
      // to a pool, but it is a thing to remember at exactly this moment (#38).
      for (const n of (c.drone_dodge_notes || [])) {
        body.push(el("div", { class: "sh-sense" },
          el("div", { style: "color:var(--manon)" }, n.text),
          el("div", { class: "sub" }, n.source)));
      }
      // Standing cover: martial-art stances and full-cover infusions, best tier
      // wins rather than stacking. There is no cover stat in the engine, so this
      // is reported and played at the table — and it belongs beside Dodge because
      // both answer the same question, "how hard am I to hit right now".
      if (c.cover) {
        body.push(el("div", { class: "sh-sense" },
          el("div", {}, `Cover ${c.cover.label}`),
          el("div", { class: "sub" }, c.cover.sources.join(" · "))));
      }
      // A Shield-Wall Drone's mobile cover is the same kind of standing rider (#38).
      for (const n of (c.drone_cover_notes || [])) {
        body.push(el("div", { class: "sh-sense" },
          el("div", {}, `Cover (drone) ${n.text}`),
          el("div", { class: "sub" }, n.source)));
      }
      return body;
    },
  });
}
/* The current lifestyle's effect, behind the "Effect ▾" chip in the tags row.
 *
 * Reads the active lifestyle fresh rather than closing over it, for the same
 * reason every other popover here does: changing the lifestyle from the dropdown
 * beside the chip re-renders the sheet, and a captured name would leave this box
 * quoting the lifestyle you just moved off. The Gear tab's lifestyle card carries
 * the same sentence in full and is where you'd act on it — this is the copy you
 * can reach from the other nine tabs. */
function openLifestylePopover() {
  openAnchoredPopover({
    kind: "lifestyle", anchorSel: ".sh-ls-info", label: "Lifestyle effect",
    build: (refresh, close) => {
      const ls = (CHAR.play.lifestyles || []).find(l => l.active);
      if (!ls) {
        return [popoverHead("◈ Lifestyle", close),
          el("div", { class: "sh-roller-hint" },
            "No current lifestyle selected — pick one from the dropdown.")];
      }
      return [popoverHead("◈ Lifestyle", close),
        el("div", { class: "sh-sense" },
          el("div", {}, `${ls.name} · ${ls.months || 0} mo prepaid`),
          el("div", { class: "sub" },
            LIFESTYLE_EFFECTS[ls.name] || "No listed effect."))];
    },
  });
}

/* Public/Private badge shown next to the name when signed in and viewing your
 * own saved character. Click to toggle sharing. Hidden in local-only mode and
 * on read-only shared views (not yours to share). */
function sharingBadge() {
  if (!(typeof SYNC !== "undefined" && SYNC.enabled && SYNC.enabled())) return null;
  if (activeTabObj() && activeTabObj().readonly) return null;
  if (!CHAR.name) return null;
  const pub = SYNC.isPublic(STORAGE.sanitizeName(CHAR.name));
  return el("button", {
    class: "sh-share-badge " + (pub ? "public" : "private"),
    title: pub ? "Public — visible to other members. Click to make private."
               : "Private. Click to share with other members.",
    onclick: async e => { e.stopPropagation(); await toggleSharing(); renderSheet(); },
  }, pub ? "🌐 Public" : "🔒 Private");
}

function sheetHeader() {
  const play = CHAR.play;
  const head = el("header", { class: "sheet-head" });

  const heritageLabel = CHAR.heritage.type
    + (CHAR.heritage.uplift_type ? ` (${CHAR.heritage.uplift_type})` : "");
  const activeLs = (play.lifestyles || []).find(l => l.active);
  const lsEffectText = activeLs ? LIFESTYLE_EFFECTS[activeLs.name] : null;
  const heritageAbilities = heritageAbilityLines();
  // Current-lifestyle dropdown: switches the active flag among the
  // lifestyles the character owns (same effect as the radio buttons on the
  // Gear tab's lifestyle card).
  const lsSelect = (play.lifestyles || []).length
    ? el("select", { class: "sh-tag-select",
        title: activeLs ? (LIFESTYLE_EFFECTS[activeLs.name] || "") : "Choose current lifestyle",
        onchange: e => {
          play.lifestyles.forEach(l => { l.active = l.name === e.target.value; });
          playChanged();
        } },
        ...(activeLs ? [] : [el("option", { value: "", selected: 1 }, "Lifestyle…")]),
        ...play.lifestyles.map(l => el("option",
          { value: l.name, ...(l.active ? { selected: 1 } : {}) },
          `${l.name} lifestyle · ${l.months || 0} mo`)))
    : null;
  const ident = el("div", { class: "sh-ident" },
    el("div", { class: "sh-ident-top" },
      // The ☰ menu now lives on the workspace tab strip (renderWorkspaceBar),
      // so it's reachable from both chargen and play — not just here.
      el("div", { class: "sh-name" }, CHAR.name || "Unnamed"),
      sharingBadge()),
    CHAR.player ? el("div", { class: "sh-player" }, CHAR.player) : null,
    el("div", { class: "sh-tags" },
      el("span", { class: "sh-tag" }, heritageLabel),
      el("span", { class: "sh-tag magic" }, CALC.magic.type),
      lsSelect,
      // The lifestyle effect used to print in full as a .sh-ls-effect paragraph
      // right here. It is a sentence that is true for the whole session and does
      // nothing between rounds, and in the stacked tablet-portrait layout it was
      // buying a whole extra line of the one band that renders on all ten tabs.
      // As a chip beside the dropdown that sets the lifestyle it costs no height
      // at all — the tags row already exists — and the sentence itself is one tap
      // away, whole, in the popover. (It also still reads out of the select's own
      // title, which is a hover tooltip and therefore useless on a tablet; the
      // chip is the version a finger can reach.)
      lsEffectText
        ? el("button", { class: "sh-tag sh-ls-info", type: "button",
            title: `${activeLs.name} lifestyle effect — click to read it`,
            "aria-label": `${activeLs.name} lifestyle effect`,
            onclick: openLifestylePopover }, "Effect ▾")
        : null));

  // Interactive pool tiles live up here — pools matter more than attributes.
  // The fifth slot Kismet used to hold is now Enhanced Senses: a tile rather
  // than a banner because what it answers ("can I see in this?") is a property
  // of the character like a pool is, not an event log. Absent entirely for
  // ordinary eyes and ears, and the four pools simply take the width back.
  const pools = el("div", { class: "sh-head-pools" },
    ...POOL_ORDER.map(headerPoolTile), sensesTile());

  /* ZP, total ZR and the ZR casting penalty used to sit here and no longer do.
   * ZP and ZR are creation budgets that barely move in play, and both already
   * have a home where you'd act on them — the Kismet tab spends ZP ("Advance
   * Zoetic Potential"), the Augments tab shows ZR beside the chrome, and the
   * MAGIC/AMP OFFLINE notes already shout when ZP goes bad. The casting penalty
   * moved to the Attributes line beside Ghost Rating, where the other standing
   * per-character figures are. The header is the only chrome visible from EVERY
   * tab, so it now carries what you consult every round instead. */

  const right = el("div", { class: "sh-meters" },
    // Move replaces Wounds here. Wounds was the only meter in this band that
    // was already on screen twice: the Condition card carries both damage
    // tracks and the penalty in full, and the compact sticky strip carries the
    // penalty everywhere else, so nothing is lost by dropping the tile. Move,
    // by contrast, had no home outside the Combat card, and it's consulted
    // constantly — every turn someone asks how far they get.
    moveMeter(),
    // Kismet takes the slot Initiative used to hold, keeping this band at the
    // four tiles it was built for. Initiative was the one meter here you could
    // only read — its Combat-tab card shows the same "12d+8" and is where you
    // actually roll it and record the result, so the copy up here was costing a
    // quarter of the band to duplicate a number.
    //
    // Kismet earns the slot instead, but it is NOT one of the pools below: it
    // doesn't refresh on New Round, isn't spent per test, and has no temp track
    // — it's a slow-burning resource measured in whole sessions, and among four
    // tiles that refill every round it read as a fifth thing that empties.
    kismetMeter(),
    // Consulted on every incoming hit, so it earns the slot Ghost gave up —
    // Ghost is a standing signature and now sits on the attribute line.
    armorMeter(),
    el("div", { class: "sh-meter cash", role: "button", tabindex: "0",
      title: `Adjust ${RULES.currencyName().toLowerCase()}`, onclick: adjustCash,
      onkeydown: e => { if (e.key === "Enter") adjustCash(); } },
      el("div", { class: "k" }, RULES.currencyName()),
      el("div", { class: "v" }, fmt(play.cash), el("span", { class: "plus" }, " +"))));

  // Top band: identity on the left, Condition (and Dodge beside it, when there
  // is room) in the middle, meters on the right.
  //
  // The middle slot has now held three things. The character description was
  // first and never changed mid-session; "Running now" replaced it and moved to
  // its own Overview card; Condition earns it outright (#83). The wound penalty
  // applies to EVERY roll and the tracks were reachable from one tab only, so
  // marking a box mid-fight meant leaving whatever tab you were on.
  //
  // Condition held this slot briefly and gave it back: two damage tracks made
  // the header 1080px on a 375px phone, taller than the screen, on every tab.
  // Initiative is the right size for a band that renders everywhere -- one
  // figure, one roll button, one field -- and answers a question you ask every
  // round. Condition returned to the Overview whole.
  //
  // Both boxes are now that size. Each was also printing its own explanation
  // under the heading ("Focus Pool dice + Reaction"; the dodge sources, or the
  // sentence about there being none) plus, on the characters who have them,
  // initiative notes, standing cover and drone riders. None of that changes
  // between rounds, which is the bar this band is held to, so it went behind the
  // same click Move and Armor use -- openInitiativePopover / openDodgePopover,
  // where it is restated and expanded rather than merely relocated.
  const headBoxes = el("div", { class: "sh-head-boxes" },
    initiativeCard(), dodgeCard());
  const top = el("div", { class: "sh-top" }, ident, headBoxes, right);
  // Heritage abilities, full-width, directly above the pools.
  //
  // This used to be two things in two places: a squeezed "Abilities:" line in
  // the identity column, and a separate "Heritage features:" callout in the
  // Overview body listing the same traits by name with no effects. The callout
  // was pure duplication and the line had a third of the width to say the same
  // thing, so it wrapped to three rows. One band, the full width of the header,
  // says it once — and it belongs above the pools because several of these
  // traits are exactly what those pool numbers are already counting.
  const heritageBand = heritageAbilities.length
    ? el("div", { class: "sh-heritage-abilities" },
        el("b", {}, "Abilities: "), heritageAbilities.join(" · "))
    : null;
  // Pool band: the four pool tiles as a single 1×4 row travelling across to sit
  // under the meters. (Load/Save/New moved into the ☰ menu.)
  const poolBar = el("div", { class: "sh-poolbar" }, pools);

  head.append(top, ...(heritageBand ? [heritageBand] : []), poolBar);
  return head;
}

/* Sticky bar under the header: the tab strip (always visible) plus a compact
 * summary strip (name, pool pills, ZP, cash) that appears only once the full
 * header has scrolled out of view — so play-mode essentials stay reachable
 * without the header permanently eating half a tablet screen. */
function sheetStickyBar() {
  // The tab strip is the ARIA tabs pattern: role="tablist"/"tab", aria-selected,
  // and a roving tabindex so the whole strip is ONE tab stop instead of ten
  // (only the selected tab is tabbable; the arrows reach the other nine).
  const nav = el("nav", { class: "sh-tabs", id: "sh-tabs", role: "tablist",
    "aria-label": "Character sheet sections" });
  const ids = sheetTabList().map(([id]) => id);
  /* Switch tabs, optionally chasing the focus.
   *
   * AUTOMATIC activation (the arrow key switches tab as focus reaches it)
   * rather than manual: every other path into a tab — a click, the Kismet
   * counter's "Kismet tab →" button — already sets sheetTab and re-renders on
   * the spot, so a manual model would make the keyboard the one route that
   * behaves differently, and there is nothing costly to defer (the panels are
   * built from CALC either way).
   *
   * `keepFocus` is what stops that from being a focus bug. renderSheet()
   * rebuilds the strip, so the button the reader was standing on is gone by
   * the time this returns; the new one has to be found and focused. Doing that
   * unconditionally would let an ordinary re-render (or a mouse click, where
   * the caret belongs wherever the reader left it) yank focus into the strip,
   * so the keyboard paths ask for it and nothing else does. */
  const go = (id, keepFocus) => {
    sheetTab = id;
    sheetStickyScrolled = false;   // tab switch scrolls back to the top
    renderSheet();
    window.scrollTo(0, 0);
    if (!keepFocus) return;
    const next = document.querySelector('.sh-tabs button[aria-selected="true"]');
    if (next) next.focus({ preventScroll: true });   // scrollTo(0,0) above stands
  };
  const onKey = e => {
    // Read the position off the button the key landed on rather than off
    // sheetTab: the two agree today (only the selected tab is tabbable), and
    // this keeps working if that ever stops being true.
    const at = ids.indexOf((e.currentTarget.id || "").replace("sh-tab-", ""));
    let to = null;
    if (e.key === "ArrowRight") to = (at + 1) % ids.length;
    else if (e.key === "ArrowLeft") to = (at - 1 + ids.length) % ids.length;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = ids.length - 1;
    else return;
    e.preventDefault();   // Home/End would otherwise scroll the page instead
    if (at >= 0) go(ids[to], true);
  };
  for (const [id, label] of sheetTabList()) {
    const on = id === sheetTab;
    nav.append(el("button", {
      class: on ? "active" : "",
      id: "sh-tab-" + id, role: "tab",
      "aria-selected": on ? "true" : "false",
      "aria-controls": "sh-tabpanel",
      tabindex: on ? "0" : "-1",
      // detail === 0 means the click was synthesised by Enter/Space on the
      // button rather than by a pointer — the one way to tell a keyboard
      // activation from a mouse one inside a plain click handler.
      onclick: e => go(id, !e.detail),
      onkeydown: onKey,
    }, label));
  }
  // The strip is what's on screen while you're actually playing, so it carries
  // the wound penalty rather than ZP: sitting beside the pool pills, it's the
  // number that changes what every one of those dice is worth.
  const wound = woundPenalty();
  // Clicking any non-interactive part of the compact strip jumps back to the top
  // (its +/- pills and the cash meter are <button>/[role=button], so they're
  // excluded and keep working).
  const compact = el("div", { class: "sh-compact", title: "Back to top",
    onclick: e => { if (!e.target.closest("button, [role=button]")) scrollSheetToTop(); } },
    el("span", { class: "sh-compact-name" }, CHAR.name || "Unnamed"),
    ...POOL_ORDER.map(compactPoolPill),
    compactKismetPill(),
    el("span", { class: "sh-cmeter" + (wound.dice < 0 ? " cond" : ""),
      title: wound.negated
        ? "Wound penalties negated"
        : `Wound penalty — Physical ${Math.min(CHAR.play.physical_damage || 0, CALC.condition.physical)}`
          + `/${CALC.condition.physical}, Stun ${Math.min(CHAR.play.stun_damage || 0, CALC.condition.stun)}`
          + `/${CALC.condition.stun}` },
      wound.dice < 0 ? `Wounds ${wound.dice}d` : "Wounds 0"),
    el("span", { class: "sh-cmeter cash", role: "button", tabindex: "0",
      title: `Adjust ${RULES.currencyName().toLowerCase()}`, onclick: adjustCash,
      onkeydown: e => { if (e.key === "Enter") adjustCash(); } },
      fmt(CHAR.play.cash)));
  // The actions strip sits between the pool pills and the tab strip — right
  // under the pool tiles that "↻ New Round" refills, and it never depends on
  // .scrolled the way .sh-compact does: it's live from the first render, not
  // only once the header has scrolled out of view.
  return el("div", { class: "sh-stickybar" + (sheetStickyScrolled ? " scrolled" : "") },
    compact, actionsStrip(), nav);
}

/* One pool as a slim pill for the compact strip — same play-state math and
 * mutation path as headerPoolTile(), minus temp boosts and notes. */
function compactPoolPill(pool) {
  const s = poolState(pool);
  const btn = (label, fn, title) => el("button", { class: "mini-btn", title,
    onclick: e => { e.stopPropagation(); fn(); } }, label);
  return el("span", { class: `sh-cpool ${pool.toLowerCase()}`,
    title: `${pool}: ${s.remaining} of ${s.max} dice left` },
    el("span", { class: "k" }, pool.slice(0, 3)),
    el("b", {}, `${s.remaining}/${s.max}`),
    btn("−", () => s.setUsed(s.used + 1), `Spend a ${pool} die`),
    btn("+", () => s.setUsed(s.used - 1), `Return a spent ${pool} die`));
}

function compactKismetPill() {
  const s = kismetPoolState();
  const btn = (label, fn, title) => el("button", { class: "mini-btn", title,
    onclick: e => { e.stopPropagation(); fn(); } }, label);
  return el("span", { class: "sh-cpool kismet",
    title: `Kismet dice: ${s.remaining} of ${s.max} left` },
    el("span", { class: "k" }, "Kis"),
    el("b", {}, `${s.remaining}/${s.max}`),
    btn("−", () => s.setUsed(s.used + 1), "Spend a Kismet die"),
    btn("+", () => s.setUsed(s.used - 1), "Return a spent Kismet die"));
}

/* One pool tile in the header: shows dice remaining / max, lets the player
 * mark dice as spent (−), return one (+), or reset to full (↺), and lists
 * any bonus-dice notes (soak dice, Specialization, Adrenal Pump, …) from
 * CALC.pool_notes. Clicking the tile itself shows the pool's skills on the
 * Overview tab. */
/* Shared pool math for the header tiles and the compact sticky-bar pills:
 * max includes temporary boost dice, used is clamped into [0, max], and
 * setUsed persists + re-renders via playChanged(). */
function poolState(pool) {
  const play = CHAR.play;
  play.pool_boost = play.pool_boost || {};
  play.pool_kismet = play.pool_kismet || {};
  const kismetDice = Math.max(0, play.pool_kismet[pool] || 0);   // permanent, never removed
  const base = CALC.pools[pool];   // already includes permanent Kismet dice
  const boost = play.pool_boost[pool] || 0;   // temporary bonus/penalty dice (may be negative)
  // Conditional effects (the Wildling shift, a triggered Adrenal Pump, a drug
  // you're dosed on) are applied here rather than in the engine: they flip
  // several times a session, and they have to leave the player's own temp dice
  // alone so switching one off doesn't eat them (issue #31).
  const beast = poolEffectMod(pool);          // 0 when nothing is switched on
  // A permanent Kismet die from a major boon "cannot be removed" (see the
  // header tile's own tooltip below) -- no stack of temporary penalty dice,
  // however large, may shrink the pool under that floor. Everyday 0 still
  // applies to a pool with no such die.
  const max = Math.max(kismetDice, base + boost + beast);
  // Spent dice are clamped for reading but never written down, so a shift that
  // shrinks Focus/Resolve doesn't destroy dice you get back on shifting out.
  const used = Math.max(0, Math.min(play.pool_used[pool] || 0, max));
  return {
    kismetDice, boost, beast, max, used, remaining: max - used,
    setUsed: v => { play.pool_used[pool] = Math.max(0, Math.min(max, v)); playChanged(); },
    setBoost: v => { play.pool_boost[pool] = v; playChanged(); },   // negatives allowed (penalties)
  };
}

function kismetPoolState() {
  const play = CHAR.play;
  play.pool_used = play.pool_used || {};
  const max = 1 + Math.floor((play.kismet_earned || 0) / 10);
  const used = Math.max(0, Math.min(play.pool_used.Kismet || 0, max));
  return {
    max, used, remaining: max - used,
    setUsed: v => { play.pool_used.Kismet = Math.max(0, Math.min(max, v)); playChanged(); },
  };
}

/* The pool tile's "temp" boost row: −/+/↺ over a bonus/penalty count that
 * sits at 0 for most characters most of the time. Folded to a single line
 * when there's nothing to show, because at coarse pointer this row's three
 * mini-btns cost a hard 32px each (the tap-target floor, JC-017) on every one
 * of the four pool tiles, all the time, whether anyone had ever touched it or
 * not — a real chunk of the header on a tablet for a control most tables
 * never use.
 *
 * A tile with a LIVE boost always shows the full row regardless of fold
 * state — this only folds the "nothing to see" case, never an active one.
 * `poolTempOpen` is the "let me add one" override: click the folded line to
 * reveal the −/+ controls, same click-to-reveal idiom as the doses banner and
 * Conditional Effects panel use elsewhere on this tab. */
function poolBoostRow(pool, boost, setBoost, btn) {
  const stop = e => e.stopPropagation();
  if (boost === 0 && !poolTempOpen.has(pool)) {
    const open = () => { poolTempOpen.add(pool); renderSheet(); };
    return el("div", { class: "sh-pool-temp collapsed", role: "button", tabindex: "0",
        title: "No temporary dice — click to add some",
        onclick: e => { stop(e); open(); },
        onkeydown: e => { if (e.key === "Enter" || e.key === " ") { stop(e); open(); } } },
      el("span", { class: "sh-pool-temp-lbl" }, "temp"),
      el("span", { class: "sh-pool-temp-plus" }, "+"));
  }
  // Vertical, and up means more (#78): a spinner read top-to-bottom is the one
  // shape nobody has to think about, and stacking the two targets along the
  // tile edge gives each of them the full height to be hit in rather than the
  // few pixels either side of the number they used to share.
  return el("div", { class: "sh-pool-temp", onclick: stop },
    btn("+", () => setBoost(boost + 1), "Add temporary dice"),
    el("b", { class: "sh-pool-temp-val", title: "Temporary bonus/penalty dice",
      style: boost > 0 ? "color:var(--ok)" : boost < 0 ? "color:var(--bad)" : "" },
      boost > 0 ? `+${boost}` : boost < 0 ? `−${Math.abs(boost)}` : "0"),
    btn("−", () => setBoost(boost - 1), "Reduce temporary dice (can go negative)"),
    // At 0 there is nothing to reset — that slot folds the strip away instead,
    // so opening it to add a die and changing your mind is not a one-way door.
    // A live boost keeps the reset: folding it would hide an active effect,
    // which this control is never allowed to do.
    boost
      ? btn("↺", () => setBoost(0), "Reset temporary dice to 0")
      : el("button", { class: "mini-btn", title: "Fold this away",
          onclick: e => { stop(e); poolTempOpen.delete(pool); renderSheet(); } },
          "▴"));
}

function headerPoolTile(pool) {
  const { kismetDice, boost, beast, max, used, remaining, setUsed, setBoost } = poolState(pool);
  const btn = (label, fn, title) => el("button", { class: "mini-btn", title,
    onclick: e => { e.stopPropagation(); fn(); } }, label);
  const notes = (CALC.pool_notes || {})[pool] || [];
  return el("div", {
    class: `sh-pool ${pool.toLowerCase()}` + (expandedPool === pool ? " open" : ""),
    role: "button", tabindex: "0",
    title: `${pool}: ${remaining} of ${max} dice left — click to show ${pool} skills`,
    "aria-label": `${pool} pool ${remaining} of ${max} — show ${pool} skills`,
    onclick: () => {
      expandedPool = expandedPool === pool ? null : pool;
      if (expandedPool && sheetTab !== "overview") sheetTab = "overview";
      renderSheet();
    },
    onkeydown: e => { if (e.key === "Enter" || e.key === " ") e.currentTarget.click(); },
  },
    // permanent Kismet-die tracker, upper-right (major boon — cannot be removed)
    el("div", { class: "sh-pool-kismet",
      title: `${kismetDice} permanent Kismet die(s) in ${pool} — major boon, cannot be removed` },
      `◈ ${kismetDice}`),
    el("div", { class: "k" }, pool),
    el("div", { class: "v" }, String(remaining),
      el("span", { class: "max" }, ` / ${max}`)),
    el("div", { class: "sh-pool-btns" },
      btn("−", () => setUsed(used + 1), "Spend a die from this pool"),
      btn("+", () => setUsed(used - 1), "Return a spent die"),
      btn("↺", () => setUsed(0), "Reset pool to full")),
    poolBoostRow(pool, boost, setBoost, btn),
    // Only the effects that are switched ON get a line here — the rest live in
    // the Conditional Effects panel, where you'd go to switch them on.
    ...activePoolEffects().map(e => {
      // What this effect is worth RIGHT NOW, which for a dose means times the
      // number counting -- the same multiply poolEffectMod does. Reading the
      // per-dose figure here made the tile disagree with its own total: three
      // Crams contribute +6 to Focus but the line said "+2", and the line's
      // tooltip claims the two agree.
      const count = e.dose ? doseTally(e.label).counted : 1;
      const n = (e.pools[pool] || 0) * count;
      const label = count > 1 ? `${e.label} ×${count}` : e.label;
      return n ? el("div", { class: "sh-pool-note",
        style: `color:var(--${n > 0 ? "ok" : "bad"})`,
        title: `${label} is switched on — this is already in the number above` },
        `⚡ ${label} ${n > 0 ? "+" : "−"}${Math.abs(n)}`) : null;
    }).filter(Boolean),
    ...notes.map(n => el("div", { class: "sh-pool-note" }, n)));
}

/* Close whatever header popover is open, and say which one it was.
 *
 * Two things need this. Only one popover may be open at a time, so opening
 * either one shuts the other; and clicking the tile you opened from should
 * close its own box rather than tear it down and build an identical one, which
 * is what "click again to close" means. Both fall out of the same call: the
 * opener closes what's there, and returns early if what it closed was its own.
 *
 * Each box carries its owner in data-popover and its teardown on _close.
 * Calling remove() directly would leave the keydown/pointerdown/scroll/resize
 * listeners bound to a node no longer in the document, so the real close() is
 * stashed on the element for anyone holding only the node. */
function closeSheetPopover() {
  const open = document.querySelector(".sh-popover");
  if (!open) return null;
  const kind = open.dataset.popover || "";
  (open._close || (() => open.remove()))();
  return kind;
}

/* Everything the character's legs (or wheels, or wings) can do.
 *
 * `move_special` is heritage quirks in prose ("cannot run", "climbs at full
 * speed"); `move_modes` is structured alternates from chrome (Fly 14m, Swim
 * 10m). They arrive from different places in the engine and used to be shown
 * in different places too — the prose as a red ⚠ dossier note, the modes as a
 * Combat-card stat line — which meant a character with both had their movement
 * described in two unrelated parts of the sheet. This gathers all of it. */
function moveDetail() {
  const c = CALC.combat;
  return {
    metres: c.move,
    special: Array.isArray(c.move_special) ? c.move_special.filter(Boolean) : [],
    modes: c.move_modes || [],
  };
}

/* Move, in the slot Wounds used to hold. Always clickable: even with nothing
 * exotic to report, the box explains where the number comes from, and a tile
 * that is sometimes a button and sometimes not is worse than one that always
 * answers. */
function moveMeter() {
  const { metres, special, modes } = moveDetail();
  const extras = special.length + modes.length;
  return el("div", {
    class: "sh-meter move" + (extras ? " has-detail" : ""),
    role: "button", tabindex: "0",
    title: `Move ${metres} m per turn`
      + (extras ? " — click for the rest of how this character gets around" : " — click for detail"),
    "aria-label": `Move ${metres} metres`,
    onclick: () => openMovePopover(),
    onkeydown: e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openMovePopover(); } },
  },
    el("div", { class: "k" }, "Move"),
    el("div", { class: "v" }, String(metres), el("span", { class: "max" }, " m")),
    el("span", { class: "sub" }, modes.length
      ? modes.map(m => m.mode).join(" · ")
      : (special.length ? "see notes" : "on foot")));
}

function openMovePopover() {
  openAnchoredPopover({
    kind: "move", anchorSel: ".sh-meter.move", label: "Movement",
    build: (refresh, close) => {
      const { metres, special, modes } = moveDetail();
      const body = [popoverHead("🏃 Movement", close),
        el("div", { class: "sh-sense" },
          el("div", {}, `Ground ${metres} m`),
          el("div", { class: "sub smaller" }, "Per simple action"))];
      for (const m of modes) {
        body.push(el("div", { class: "sh-sense" },
          el("div", {}, `${m.mode} ${m.meters} m`),
          el("div", { class: "sub smaller" }, `${m.name} · Per simple action`)));
      }
      // Heritage quirks are prose and stay prose — they qualify how the numbers
      // above are used ("cannot run"), so flattening them into a figure would
      // lose the condition that makes them worth reading.
      for (const note of special) {
        body.push(el("div", { class: "sh-sense" },
          el("div", { class: "sub" }, note)));
      }
      if (!modes.length && !special.length) {
        body.push(el("div", { class: "sh-roller-hint" },
          "No alternate movement types — this character gets around on the ground."));
      }
      return body;
    },
  });
}

/* Armor, with the Max Ballistic / Min Impact pair behind a click.
 *
 * The two figures are a gear-shopping constraint, not a combat number: they say
 * what this character can still wear before the armor starts working against
 * them. Consulting them mid-fight is rare enough that they don't earn header
 * space of their own, and rare is exactly what a popover is for. */
function armorMeter() {
  const c = CALC.combat;
  return el("div", {
    class: "sh-meter armor", role: "button", tabindex: "0",
    // Max Ballistic leads because it answers a question the totals can't: it
    // decides whether an incoming hit is Physical or Stun. The totals only say
    // how much of it you shrug off afterwards.
    title: `Max Ballistic ${c.max_ballistic} — a weapon whose Pen reaches it deals`
      + ` PHYSICAL damage, below it Stun. Total Ballistic ${c.ballistic_armor}`
      + ` then reduces the damage. Total Impact ${c.impact_armor} applies to melee.`,
    "aria-label": `Armor: max ballistic ${c.max_ballistic}, total ballistic `
      + `${c.ballistic_armor}, total impact ${c.impact_armor}`,
    onclick: () => openArmorPopover(),
    onkeydown: e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openArmorPopover(); } },
  },
    el("div", { class: "k" }, "Armor"),
    // No spaces around the slashes: three figures have to fit a tile built for
    // two, and at phone width "5 / 6 / 7" overflows it while "5/6/7" doesn't.
    // The sub-label underneath is what says which is which.
    el("div", { class: "v armor3" },
      `${c.max_ballistic}/${c.ballistic_armor}/${c.impact_armor}`),
    el("span", { class: "sub" }, "max B · bal · imp"));
}

/* What the three armor figures actually do, in the order a hit resolves.
 *
 * The first version of this box had Max Ballistic wrong in a way that mattered:
 * it called it "the most ballistic armor this character benefits from" and
 * warned when the total went above it, as though it were a cap on useful armor.
 * It isn't a cap at all — it's the threshold that decides the DAMAGE TYPE of an
 * incoming hit, and having a total well above it is normal and good (#55). */
function openArmorPopover() {
  openAnchoredPopover({
    kind: "armor", anchorSel: ".sh-meter.armor", label: "Armor",
    build: (refresh, close) => {
      const c = CALC.combat;
      // Which piece the threshold actually comes from, so a player can see what
      // they'd be giving up by swapping it out. Worn armor and implanted/innate
      // sources are checked together: combat.armor_sources only ever holds the
      // second kind (augments, heritage, Chelonian), so on a character whose
      // best ballistic is a coat — the ordinary case — it is empty.
      const best = [
        ...(CALC.armor || [])
          .filter(a => a.active !== false)
          .map(a => ({ name: a.Armor || a.name, b: toIntSafe(a.Ballistic) })),
        ...(c.armor_sources || []).map(s => ({ name: s.name, b: toIntSafe(s.b) })),
      ].filter(s => s.b > 0 && s.b === toIntSafe(c.max_ballistic)).map(s => s.name);
      return [
        popoverHead("🛡 Armor", close),
        el("div", { class: "sh-sense" },
          el("div", {}, `Max Ballistic ${c.max_ballistic}`),
          el("div", { class: "sub" },
            "The highest Ballistic on any ONE piece — it does not add up. "
            + "A weapon whose Pen is this or higher deals PHYSICAL damage; "
            + "below it, the hit is Stun."
            + (best.length ? ` From: ${best.join(" · ")}.` : ""))),
        el("div", { class: "sh-sense" },
          el("div", {}, `Total Ballistic ${c.ballistic_armor}`),
          el("div", { class: "sub" },
            "Every piece added together. This is what reduces the damage once "
            + "the type above has been decided.")),
        el("div", { class: "sh-sense" },
          el("div", {}, `Total Impact ${c.impact_armor}`),
          el("div", { class: "sub" }, "Applies to melee.")),
        c.min_impact ? el("div", { class: "sh-sense" },
          el("div", {}, `Impact you can't lose ${c.min_impact}`),
          el("div", { class: "sub" },
            "Implanted or innate — bone lacing, a heritage's own hide. Still "
            + "there with everything else stripped off.")) : null,
      ];
    },
  });
}

/* Kismet die pool — 1 die to start, +1 per 10 Kismet earned during play
 * (lifetime, from play.kismet_earned, which only moves backwards when an
 * award is undone -- see undoKismetSpend, which clamps this pool when it does).
 *
 * A meter in the header's top row, in the slot Initiative held, rather than a sixth pool
 * tile. Kismet dice keep their own used-count in `play.pool_used.Kismet`, but
 * they are NOT one of the round-cycle pools: New Round walks POOL_ORDER, which
 * is the four attribute pools and deliberately not this. Spend a Kismet die and
 * it stays spent until you reset it yourself — that is the whole point of the
 * resource, and sitting it among four tiles that refill every round was the
 * wrong promise. P06-031 holds that line. */
function kismetMeter() {
  const { max, used, remaining, setUsed } = kismetPoolState();
  const ro = !!(activeTabObj() && activeTabObj().readonly);
  const btn = (label, fn, title) => el("button", { class: "mini-btn", title,
    onclick: e => { e.stopPropagation(); fn(); } }, label);
  return el("div", {
    class: "sh-meter kismet" + (remaining ? "" : " spent"),
    title: `Kismet dice: ${remaining} of ${max} left — 1 to start, +1 per 10 Kismet`
      + " earned. These do NOT refresh on New Round."
      + (ro ? "" : " Click to roll some."),
    "aria-label": `Kismet dice ${remaining} of ${max}`,
    // The mini-buttons below stopPropagation, so a click that lands on the tile
    // itself (not on −/+/↺) opens the roller instead of doing nothing.
    ...(ro ? {} : { role: "button", tabindex: "0",
      onclick: () => openKismetRoller(),
      onkeydown: e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openKismetRoller(); } } }),
  },
    el("div", { class: "k" }, "Kismet"),
    el("div", { class: "v" }, String(remaining),
      el("span", { class: "max" }, ` / ${max}`)),
    ro ? null : el("div", { class: "sh-meter-btns" },
      btn("−", () => setUsed(used + 1), "Spend a Kismet die"),
      btn("+", () => setUsed(used - 1), "Return a spent Kismet die"),
      btn("↺", () => setUsed(0), "Reset Kismet dice to full")));
}

/* What counts as a tab stop inside a popover, for the focus trap below.
 * [tabindex="-1"] is excluded on purpose: that is how the box itself, and any
 * child that is focusable but deliberately not tabbable, opt out. */
const POPOVER_FOCUS_SEL = "a[href], button:not([disabled]), input:not([disabled]),"
  + " select:not([disabled]), textarea:not([disabled]), summary,"
  + " [tabindex]:not([tabindex='-1'])";

/* One anchored popover, opened from a header tile.
 *
 * Five tiles now open one of these (Kismet, Senses, Move, Armor, and whatever
 * comes next), and they all want the same six behaviours: place under the tile
 * and flip up when the viewport bottom is close, close on Escape / outside
 * click / scroll / resize, close when the tile that owns it goes away, toggle
 * shut when that tile is clicked again, and never coexist with another. Those
 * are fiddly enough individually that a second hand-written copy had already
 * drifted from the first; this is the one implementation.
 *
 * `anchorSel` is a selector, not a node, and that is load-bearing rather than
 * stylistic: anything a popover does that changes play state re-renders the
 * sheet, which replaces the tile. Held as a captured node, the anchor would
 * stop matching the tile the user is actually clicking — the toggle would read
 * as an outside-click followed by a fresh open, and the box would never shut.
 * Re-finding it every time costs a querySelector and removes the whole class
 * of bug. P06-033 pins that case down.
 *
 * `build(refresh)` returns the box's children and may call `refresh` to redraw
 * after changing something. The box lives on document.body, not inside #sheet,
 * because renderSheet() clears #sheet and only #sheet — that is what lets a
 * popover survive the re-render its own buttons cause.
 *
 * It is a real modal dialog for the keyboard as well as for the name it
 * carries: focus moves in on open, Tab is trapped inside, and Escape (or any
 * other close) hands focus back to whoever opened it.
 *
 * Returns { refresh, close } for callers that need to drive it. */
function openAnchoredPopover({ kind, anchorSel, label, build, cls }) {
  // Clicking the tile while this is already up closes it instead of rebuilding
  // it — the tile is a toggle, not a re-open button.
  if (closeSheetPopover() === kind) return null;
  const getAnchor = () => document.querySelector(anchorSel);
  // Whatever had focus when the box opened is what gets it back on close.
  // Captured rather than assumed to be the anchor: these boxes are opened from
  // header tiles, from the running-now chip and (soon enough) from anywhere
  // else, and dumping the reader on a tile they never touched is its own kind
  // of lost. The anchor is only the fallback, below.
  const opener = document.activeElement;

  // tabindex="-1" so a popover with no controls at all — Move on a character
  // with nothing exotic, Senses with no toggles — can still be focused, and so
  // still gets announced as the dialog it says it is.
  const box = el("div", { class: "sh-popover" + (cls ? " " + cls : ""),
    role: "dialog", "aria-modal": "true", "aria-label": label || "Details",
    tabindex: "-1", "data-popover": kind });
  document.body.append(box);

  // Focus is moved INTO the box on open. Without this the box is a dialog only
  // in name: it lives on document.body, i.e. at the very end of the document,
  // so its controls sit some eighty tab stops past the tile that opened it.
  // preventScroll throughout, because the Running Now box is max-height:70vh
  // with its own scrollbar and plain focus() would scroll that pane (and the
  // page under it) to wherever the browser thinks the control belongs.
  const focusables = () => Array.from(box.querySelectorAll(POPOVER_FOCUS_SEL));
  const focusInto = () => {
    const first = focusables()[0];
    (first || box).focus({ preventScroll: true });
  };

  const place = () => {
    const anchor = getAnchor();
    if (!anchor) { close(); return; }
    const r = anchor.getBoundingClientRect();
    const w = box.offsetWidth, h = box.offsetHeight;
    // Prefer below-left-aligned; flip above when the viewport bottom is closer
    // than the box is tall, and clamp horizontally so it never leaves the page.
    const top = (r.bottom + h + 8 <= window.innerHeight) ? r.bottom + 6
              : Math.max(6, r.top - h - 6);
    const left = Math.max(6, Math.min(r.left, window.innerWidth - w - 6));
    box.style.top = `${top}px`;
    box.style.left = `${left}px`;
  };

  const close = () => {
    // Whether focus is still ours to give back, decided BEFORE the box goes:
    // a pointerdown outside closes the box too, and yanking focus off whatever
    // the reader just reached for would be worse than leaving it where it is.
    const mine = box.contains(document.activeElement)
      || !document.activeElement || document.activeElement === document.body;
    box.remove();
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerdown", onOutside, true);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", close);
    if (!mine) return;
    // The opener is often a header tile, and every playChanged() rebuilds those
    // — so the node we captured may be detached by now. Fall back to whatever
    // answers the anchor selector today, and to nothing if even that is gone
    // (a popover can outlive its tile; place() closes on the next reflow).
    const back = (opener && document.contains(opener)) ? opener : getAnchor();
    if (back && back.focus) back.focus({ preventScroll: true });
  };
  // Stashed so closeSheetPopover() can tear this down properly when it only has
  // the node: a bare remove() would orphan all four listeners below.
  box._close = close;
  const onKey = e => {
    if (e.key === "Escape") { close(); return; }
    if (e.key !== "Tab") return;
    // aria-modal="true" tells a screen reader nothing outside this box exists;
    // Tab has to agree, or the first press walks straight back out of the
    // dialog that was just announced and into the rest of the sheet. Wraps in
    // both directions; with nothing focusable inside, Tab simply does nothing
    // and Escape remains the way out.
    const items = focusables();
    if (!items.length) { e.preventDefault(); return; }
    const active = document.activeElement;
    const outside = !box.contains(active);
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey ? (outside || active === first) : (outside || active === last)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus({ preventScroll: true });
    }
  };
  // Scroll doesn't bubble, but a CAPTURE listener on window still fires for a
  // scroll inside any descendant -- so a popover tall enough to scroll itself
  // would shut under the reader's finger. Only page scroll should close it.
  const onScroll = e => { if (!box.contains(e.target)) close(); };
  // A pointerdown on the tile is left alone so the click that follows reaches
  // the toggle above; closing here would let that click re-open the box.
  const onOutside = e => {
    const anchor = getAnchor();
    if (!box.contains(e.target) && !(anchor && anchor.contains(e.target))) close();
  };
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("pointerdown", onOutside, true);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", close);

  const refresh = () => {
    // replaceChildren throws away the node that had focus — press Roll and the
    // Roll button itself is gone — which drops focus to <body> and takes the
    // trap with it. If the reader was inside the box, put them back inside it.
    const had = box.contains(document.activeElement);
    box.replaceChildren(...build(refresh, close));
    place();
    if (had && !box.contains(document.activeElement)) focusInto();
  };
  refresh();
  focusInto();
  return { refresh, close };
}

/* A popover's title bar, with the ✕ that closes it. */
function popoverHead(title, close) {
  return el("div", { class: "sh-popover-head" }, title,
    el("button", { class: "sh-roller-close", title: "Close", onclick: close }, "✕"));
}

/* Kismet die roller: a popover opened by clicking the header meter.
 *
 * Deliberately its own thing rather than another mode on the combat roller
 * (openPoolRoller / rollerState): no wound penalty, no bonus dice, no pool
 * choice. Kismet dice ARE the pool — picking how many to roll and spending
 * that many out of it are the same act, which is what "not subject to any
 * penalties or anything else" means here. 4-6 is still a Success, because
 * that half of the game's math doesn't change just because the dice are rare.
 *
 * State lives in this closure rather than a module-level object the way
 * rollerState does, because it doesn't need to survive being torn down —
 * closing it forgets it. Surviving its own Roll button is a different matter,
 * and openAnchoredPopover handles that. */
function openKismetRoller() {
  const state = { count: 1, dice: [] };
  openAnchoredPopover({
    kind: "kismet", anchorSel: ".sh-meter.kismet", cls: "sh-kismet-roller",
    label: "Kismet dice roller",
    build: (refresh, close) => {
      const { max, used, remaining } = kismetPoolState();
      // Never offer more than what's actually left, and never less than 1 while
      // there's anything to roll at all.
      state.count = remaining > 0 ? Math.max(1, Math.min(state.count, remaining)) : 0;
      const successes = state.dice.filter(v => v >= 4).length;

      const stepBtn = (delta, title) => el("button", { class: "sh-roller-step", title,
        onclick: () => { state.count = Math.max(1, Math.min(remaining, state.count + delta)); refresh(); } },
        delta < 0 ? "–" : "+");

      const body = [popoverHead("🎲 Kismet Dice", close)];

      if (remaining < 1) {
        body.push(el("div", { class: "sh-roller-avail" }, "No Kismet dice left to roll."));
      } else {
        body.push(el("div", { class: "sh-roller-controls" },
          stepBtn(-1, "One fewer die"),
          el("span", { class: "sh-roller-count" }, `${state.count}d6`),
          stepBtn(1, "One more die"),
          el("button", { class: "btn sh-roller-roll",
            onclick: () => {
              state.dice = Array.from({ length: state.count }, rollerD6);
              kismetPoolState().setUsed(used + state.count);   // -> playChanged() -> renderSheet()
              refresh();
            } }, "Roll")),
          el("div", { class: "sh-roller-avail" }, `${remaining} of ${max} available`));
      }

      if (state.dice.length) {
        body.push(el("div", { class: "sh-roller-dice" },
          ...state.dice.map(v => el("span",
            { class: "sh-roller-die static" + (v >= 4 ? " hit" : "") }, String(v)))),
          el("div", { class: "sh-roller-succ" },
            el("b", {}, String(successes)), ` Success${successes === 1 ? "" : "es"}`));
      }
      body.push(el("div", { class: "sh-roller-hint" },
        "4–6 = Success. Kismet dice roll clean — no wound penalty, no bonus dice, "
        + "nothing else added or taken off."));

      return body;
    },
  });
}

function adjustCash() {
  const raw = prompt(`Adjust ${RULES.currencyName().toLowerCase()} by (negative to spend):`, "0");
  if (raw == null) return;
  const delta = parseInt(raw, 10);
  if (!Number.isFinite(delta) || !delta) return;
  const label = (prompt("Reason (optional):", "") || "Manual adjustment").trim() || "Manual adjustment";
  logCash(label, delta);
  playChanged();
}

/* What a JSON import found, before it opens.
 *
 * A JSON file is an exact record, so unlike the Markdown importer there is
 * nothing here to approximate — the dialog exists for the two things that are
 * genuinely worth a player's attention. First, an old file gets repaired on
 * open (gear copied into the kit, a hacking rating turned into a program), and
 * a silent repair is the hardest kind of surprise to report later. Second, a
 * name the tables no longer answer to prices at zero and contributes nothing,
 * and until now it did that without saying a word.
 *
 * Resolves truthy to proceed, null to cancel. Mirrors mdReportModal so the two
 * import paths read the same. */
function importReportModal(report, fileName) {
  return new Promise(resolve => {
    const backdrop = el("div", { class: "mount-modal-backdrop" });
    const done = val => { document.removeEventListener("keydown", onKey); backdrop.remove(); resolve(val); };
    const onKey = e => { if (e.key === "Escape") done(null); };

    const group = (title, rows, colour) => rows.length
      ? el("details", { class: "desc-expander", ...(colour ? { style: `color:${colour}` } : {}) },
          el("summary", {}, `${title} (${rows.length})`),
          el("div", { class: "desc-body" }, ...rows.map(r => el("div", { class: "sub" }, r))))
      : null;

    const orphans = report.unresolved.map(u => `${u.label}: “${u.name}”`);
    const madeWith = report.madeWith
      ? `made with v${report.madeWith}`
      : "made before this app stamped a version into characters";

    const modal = el("div", { class: "card mount-modal", style: "max-width:620px" },
      el("h3", {}, "Import character"),
      el("p", { class: "hint" },
        `“${fileName}” — ${madeWith}. This build is v${report.currentVersion}.`),
      ...[group("Brought up to date", report.legacy),
          group("Names no longer in the data", orphans, "var(--amber)"),
          group("The engine reports", report.errors, "var(--bad)")].filter(Boolean),
      orphans.length ? el("p", { class: "hint", style: "color:var(--amber)" },
        "These import, but nothing answers to them: they cost nothing, grant nothing and "
        + "won't show their stats. Either the row was renamed or retired, or it's homebrew "
        + "this browser doesn't have installed.") : null,
      report.errors.length ? el("p", { class: "hint", style: "color:var(--bad)" },
        "The character still opens — these are the same errors the rail shows, and they were "
        + "either legal when it was built or a rule has moved since.") : null,
      (!report.legacy.length && !orphans.length && !report.errors.length)
        ? el("p", { class: "hint", style: "color:var(--ok)" },
            "Nothing to repair — this file matches the current shape.") : null,
      el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin-top:14px" },
        el("button", { class: "btn-add", onclick: () => done({ ok: true }) }, "Open"),
        el("button", { class: "btn ghost", onclick: () => done(null) }, "Cancel")));
    backdrop.append(modal);
    backdrop.addEventListener("click", e => { if (e.target === backdrop) done(null); });
    document.addEventListener("keydown", onKey);
    document.body.append(backdrop);
  });
}

/* "Running now": what is currently ON, in the one band visible from every tab.
 *
 * Three things change every round and were each visible from exactly one tab:
 * active spells (Magic), doses and switched-on conditional effects (Overview).
 * From anywhere else, a character with three spells up, dosed and shifted looked
 * identical to one with nothing running. The header is the only chrome on all
 * ten tabs, so it is where that belongs.
 *
 * The face carries NO controls, and that is load-bearing rather than taste:
 * @media(pointer:coarse) inflates .btn/.mini-btn/.row-del to a 32px floor, which
 * is what makes the mobile header tall. A face holding none of those classes
 * cannot inflate. Every control lives in the popover behind the click -- the
 * same split Move, Armor and Enhanced Senses already use.
 *
 * Gated on poolEffects() (what COULD be switched) rather than activePoolEffects()
 * (what IS): with the panel gone from Overview this popover is the only route to
 * those switches, so a Wildling with nothing on must still be able to reach the
 * shift. An all-off list wears the dim styling and says so. */
function runningNowPanel() {
  const spells = activeSpells();
  const doses = activeDoses();
  const fx = poolEffects().filter(e => !e.dose);
  const shifted = shiftedForm();

  const onFx = fx.filter(e => poolEffectOn(e.id));
  const anyOn = Boolean(spells.length || doses.length || onFx.length || shifted);
  const count = spells.length + doses.length + onFx.length + (shifted ? 1 : 0);
  // Nothing switchable AND nothing running: the card still stands rather than
  // vanishing (#83). It is a fixed column on the Overview now, not a header
  // panel that could quietly take its slot back, and a card that disappears
  // when empty is one the reader has to remember used to be there.
  const nothingToSwitch = !fx.length && !shifted;

  // Being shifted leads: "you are not currently shaped like a person" is the
  // loudest thing that can be true here. Then spells, then doses, then effects.
  const bits = [
    ...(shifted ? [`Shifted: ${shifted.name}`] : []),
    ...spells.map(sp => `${sp.name} F${sp.force}`),
    ...doseGroupsSummary(doses),
    ...onFx.map(e => `${e.label} (${Object.entries(e.pools)
      .map(([pl, n]) => `${n > 0 ? "+" : "−"}${Math.abs(n)} ${pl}`).join(" ")})`),
  ];

  return el("div", {
    class: `card sh-card sh-running ${anyOn ? "warn" : "info"}`,
    role: "button", tabindex: "0",
    title: anyOn ? "What is running right now — click for the controls"
                 : "Nothing running — click to switch something on",
    "aria-label": `Running now: ${count} active`,
    onclick: () => openRunningPopover(),
    onkeydown: e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openRunningPopover(); } },
  },
    el("div", { class: "sh-fx-head" },
      el("span", {}, anyOn ? "⚡ " : "○ ", el("b", {}, "Running now"),
        anyOn ? " " : null, anyOn ? el("b", {}, String(count)) : null)),
    el("div", { class: "sh-fold-sum" },
      anyOn ? bits.join(" · ")
        : nothingToSwitch ? "Nothing running — no spells up, no doses, nothing switched on."
        : fx.map(e => e.label).join(" · ") + " — none active"));
}

/* Doses summarised the way the banner folds them: two Crams read as one row
 * with a x2, and the swing rides along when the drug has one. */
function doseGroupsSummary(doses) {
  const seen = new Map();
  for (const d of doses) seen.set(d.name, (seen.get(d.name) || 0) + 1);
  return [...seen.entries()].map(([name, n]) => {
    const swing = doseSummary(name);
    return name + (n > 1 ? ` ×${n}` : "") + (swing ? ` (${swing})` : "");
  });
}

/* Every control for what is running, one click from any tab. The two banners
 * are rendered WHOLE -- nothing was trimmed on the way here -- and refresh
 * themselves in place, because this box lives on document.body and a re-render
 * of #sheet would otherwise leave it showing pre-dismissal state. */
function openRunningPopover() {
  openAnchoredPopover({
    kind: "running", anchorSel: ".sh-running", cls: "sh-running-pop",
    label: "What is running now",
    build: (refresh, close) => {
      const ro = !!(activeTabObj() && activeTabObj().readonly);
      const spells = activeSpells();
      const body = [popoverHead("⚡ Running Now", close)];
      if (spells.length) {
        body.push(el("div", { class: "sh-run-group" },
          el("div", { class: "sh-popover-sub" }, "Active spells"),
          ...spells.map(sp => activeSpellRow(sp, { detail: false, ro, after: refresh }))));
      }
      // Rendered unfolded: a fold inside a popover would be a second click to
      // reach what the first click was for.
      const doses = dosesBanner({ after: refresh });
      if (doses) body.push(doses);
      const fx = poolEffectsPanel({ after: refresh });
      if (fx) body.push(fx);
      if (spells.length) {
        body.push(el("p", { class: "hint" },
          "Durations are fiction-paced, so nothing expires on a clock. The Magic "
          + "tab carries each effect text and what a summoning brought."));
      }
      return body;
    },
  });
}
/* Enhanced Senses, as a header tile in the pool row's fifth slot.
 *
 * It was a folding banner in the Overview strip, which put it in the wrong
 * place twice over: it only existed on one tab, and folded-with-a-summary is
 * the shape for something that changes (what you're dosed on), not for a
 * standing property of the character. As a tile it's visible from every tab,
 * costs a slot that was already there, and opens its detail on click.
 *
 * The tile shows the count and the capability names; the popover names what
 * grants each one, which is the part you only want when you're checking whether
 * a sense survives losing a piece of gear.
 *
 * Returns null for a character with ordinary eyes and ears. */
function sensesTile() {
  const senses = (CALC.combat && CALC.combat.senses) || [];
  if (!senses.length) return null;
  return el("div", {
    class: "sh-pool senses",
    role: "button", tabindex: "0",
    title: `${senses.length} enhanced ${senses.length === 1 ? "sense" : "senses"}`
      + " — click for what grants each",
    "aria-label": `Enhanced senses: ${senses.map(s => s.capability).join(", ")}`,
    onclick: () => openSensesPopover(senses),
    onkeydown: e => { if (e.key === "Enter" || e.key === " ") e.currentTarget.click(); },
  },
    el("div", { class: "k" }, "Senses"),
    el("div", { class: "v" }, String(senses.length)),
    el("div", { class: "sh-senses-list" },
      senses.map(s => s.capability).join(" · ")));
}

/* The tile's detail box: one row per capability with its sources.
 *
 * Anchored to the tile rather than centred as a modal — it's a peek at a
 * reference, and a full backdrop for "what gives me thermographic vision" would
 * be heavier than the question. */
function openSensesPopover(senses) {
  openAnchoredPopover({
    kind: "senses", anchorSel: ".sh-pool.senses", label: "Enhanced senses",
    build: (refresh, close) => [
      popoverHead("👁 Enhanced Senses", close),
      ...senses.map(s => el("div", { class: "sh-sense" },
        el("div", {}, s.capability),
        el("div", { class: "sub" },
          s.sources.map(src => `${src.name} (${src.from})`).join(" · ")))),
      ...senseToggleRows(refresh),
    ],
  });
}

/* Senses that cost an action to engage get a switch here rather than being
 * silently on. Far Sight is the one in the core data: its +2d Reconnaissance
 * only exists once the character has entered a Trance, so handing the dice out
 * for free would be paying nobody's complex action (#42).
 *
 * Toggling re-renders the sheet (the dice have to reach the skill), and the
 * popover survives that because it lives on document.body — but the row still
 * needs redrawing to flip its own label, hence the refresh. */
function senseToggleRows(refresh) {
  const toggles = (CALC.combat || {}).sense_toggles || [];
  if (!toggles.length) return [];
  const ro = !!(activeTabObj() && activeTabObj().readonly);
  return toggles.map(t => el("div", { class: "sh-sense sh-sense-toggle" + (t.active ? " on" : "") },
    el("div", {}, t.name,
      t.active ? el("span", { class: "chip ok", style: "margin-left:6px" }, "active") : null),
    el("div", { class: "sub" },
      t.skill && t.dice
        ? `${t.dice > 0 ? "+" : ""}${t.dice}d ${t.skill} while active`
        : "No dice bonus listed",
      ` · needs ${t.requires}`),
    ro ? null : el("button", {
      class: "btn small" + (t.active ? "" : " btn-add"),
      onclick: () => {
        const play = CHAR.play;
        play.active_senses = play.active_senses || {};
        if (t.active) delete play.active_senses[t.name];
        else play.active_senses[t.name] = true;
        playChangedRecalc().then(refresh);
      },
    }, t.active ? "Deactivate" : "Activate")));
}

/* What the character is currently on, one row per dose.
 *
 * Folded by default like the senses banner, but it folds to something louder:
 * an empty summary is fine for "what can I see", and actively misleading for
 * "am I holding +4 Focus that's about to vanish". The collapsed line therefore
 * names the drugs and the net swing.
 *
 * Each dose gets its own ✕ because doses wear off one at a time, not as a set.
 * Nothing here expires on a timer — durations in this game are fiction-paced
 * ("a few hours", "for 12 hrs"), and a clock that silently removed a bonus
 * mid-fight would be worse than one the player closes themselves.
 *
 * Returns null when nothing is active. */
/* Rendered inside the Running Now popover, always open: a fold inside a popover
 * would be a second click to reach what the first click was for. `after` runs
 * once a dismissal has landed, because the popover lives on document.body and a
 * re-render of #sheet would leave it showing pre-dismissal state. */
function dosesBanner({ after = null } = {}) {
  const doses = activeDoses();
  if (!doses.length) return null;
  const ro = !!(activeTabObj() && activeTabObj().readonly);

  // Group by drug so two Crams read as one row with a ×2, but keep every dose's
  // uid so each can still be dismissed on its own.
  const groups = [];
  for (const d of doses) {
    let g = groups.find(x => x.name === d.name);
    if (!g) {
      const row = (DATA.tables.misc_gear || []).find(r => r.Item === d.name);
      groups.push(g = { name: d.name, uids: [], effect: doseEffectFor(d.name),
                        // The row's own Effect prose, so the ruling is at hand
                        // for doses whose effect isn't dice at all.
                        text: (row && row.Effect) || "" });
    }
    g.uids.push(d.uid);
  }

  const swingOf = g => doseSummary(g.name);

  const card = el("div", { class: "sh-callout warn sh-doses" },
    el("div", { class: "sh-doses-head" },
      el("span", {}, "💊 Under the Effects Of ",
        el("b", {}, String(doses.length)))));
  card.classList.add("is-open");

  for (const g of groups) {
    const tally = doseTally(g.name);
    const over = tally.taken > tally.counted;
    const swing = swingOf(g);
    const row = el("div", { class: "sh-dose-row" },
      el("div", { class: "sh-dose-what" },
        el("span", { class: "sh-dose-name" }, g.name,
          g.uids.length > 1 ? el("span", { class: "sub" }, ` ×${g.uids.length}`) : ""),
        swing ? el("div", { class: "sh-fx-swing on" }, swing) : null,
        // Says why the third Cram isn't doing anything, at the moment it stops.
        over ? el("div", { class: "sub warn-text" },
          `${tally.taken} taken, ${tally.counted} counting — stacks up to ${tally.cap}`) : null,
        g.text ? el("div", { class: "sh-fx-text sub", title: g.text }, g.text)
               : el("div", { class: "sub" }, "No dice effect — tracked for the record")),
      ro ? null : el("div", { class: "sh-dose-btns" },
        ...g.uids.map((uid, i) =>
          el("button", { class: "btn small",
            title: g.uids.length > 1
              ? `Dismiss dose ${i + 1} of ${g.uids.length} — it wore off`
              : `${g.name} wore off — remove it${swing ? ` (${swing} comes back out)` : ""}`,
            onclick: () => { dismissDose(uid); if (after) after(); } }, "✕"))));
    card.append(row);
  }
  return card;
}

/* Bulk save management: tick several characters, delete them in one go.
 *
 * "Delete Character" only ever reaches the one that's open, so clearing out a
 * handful of test builds meant opening each in turn to throw it away. Each row
 * carries enough to tell near-identical saves apart — heritage, whether it's
 * finalized, and whether it's open in a tab right now — because the failure
 * this dialog invites is deleting the wrong one, and a bare list of names is
 * exactly how that happens.
 *
 * Deletion is permanent and, when signed in, propagates to the server through
 * STORAGE.deleteCharacter, so the confirmation names what's going. */
function manageSavesModal() {
  return new Promise(resolve => {
    const openKeys = new Set(WORKSPACE.tabs
      .map(t => STORAGE.sanitizeName((t.char || {}).name || ""))
      .filter(Boolean));
    const rows = STORAGE.listCharacters().map(key => {
      const rec = STORAGE.loadCharacter(key) || {};
      const heritage = (rec.heritage || {}).type || "—";
      const uplift = (rec.heritage || {}).uplift_type;
      return {
        key,
        label: rec.name || key,
        detail: [heritage + (uplift ? ` (${uplift})` : ""),
                 rec.finalized ? "in play" : "in chargen",
                 rec.app_version ? `v${rec.app_version}` : "unversioned",
                 openKeys.has(key) ? "open in a tab" : null].filter(Boolean).join(" · "),
        box: el("input", { type: "checkbox" }),
      };
    });

    const backdrop = el("div", { class: "mount-modal-backdrop" });
    const done = val => { document.removeEventListener("keydown", onKey); backdrop.remove(); resolve(val); };
    const onKey = e => { if (e.key === "Escape") done(null); };

    const delBtn = el("button", { class: "btn sh-mi-delete", disabled: "1" }, "Delete selected");
    const chosen = () => rows.filter(r => r.box.checked);
    const sync = () => {
      const n = chosen().length;
      delBtn.textContent = n ? `Delete selected (${n})` : "Delete selected";
      if (n) delBtn.removeAttribute("disabled"); else delBtn.setAttribute("disabled", "1");
    };
    rows.forEach(r => r.box.addEventListener("change", sync));

    delBtn.addEventListener("click", async () => {
      const picked = chosen();
      if (!picked.length) return;
      const names = picked.map(r => r.label);
      // Name them all up to a point — past that the list stops being readable
      // and the count is the number that matters.
      const shown = names.length <= 12
        ? names.map(n => `  • ${n}`).join("\n")
        : `${names.slice(0, 12).map(n => `  • ${n}`).join("\n")}\n  …and ${names.length - 12} more`;
      if (!confirm(`Permanently delete ${names.length} saved character`
        + `${names.length === 1 ? "" : "s"}?\n\n${shown}\n\n`
        + "This cannot be undone.")) return;
      const n = await deleteSavedCharacters(picked.map(r => r.key));
      done({ deleted: n });
    });

    const list = rows.length
      ? el("div", { class: "sh-saves-list" },
          ...rows.map(r => el("label", { class: "opt sh-saves-row" }, r.box,
            el("span", {}, el("b", {}, r.label),
              el("div", { class: "sub" }, r.detail)))))
      : el("p", { class: "hint" }, "No saved characters.");

    const modal = el("div", { class: "card mount-modal", style: "max-width:560px" },
      el("h3", {}, "Manage saved characters"),
      el("p", { class: "hint" },
        `${rows.length} saved in this browser`
        + (typeof SYNC !== "undefined" && SYNC.enabled && SYNC.enabled()
            ? ". You're signed in, so deleting also removes them from your account." : ".")),
      rows.length ? el("div", { style: "display:flex;gap:8px;margin-bottom:8px" },
        el("button", { class: "btn small ghost",
          onclick: () => { rows.forEach(r => { r.box.checked = true; }); sync(); } }, "Select all"),
        el("button", { class: "btn small ghost",
          onclick: () => { rows.forEach(r => { r.box.checked = false; }); sync(); } }, "Select none")) : null,
      list,
      el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin-top:14px" },
        rows.length ? delBtn : null,
        el("button", { class: "btn ghost", onclick: () => done(null) }, "Close")));
    backdrop.append(modal);
    backdrop.addEventListener("click", e => { if (e.target === backdrop) done(null); });
    document.addEventListener("keydown", onKey);
    document.body.append(backdrop);
  });
}

/* Collapsible hamburger menu (upper-left of the sheet header) holding the
 * less-frequent whole-character actions: leaving/reverting chargen state,
 * Homebrew, and import/export. `act()` closes the menu and re-renders once
 * the action settles, unless the action already navigated away from #sheet
 * (backToChargen, enterHomebrew) in which case that view's own render wins. */
function sheetMenu() {
  const importInput = el("input", {
    type: "file", accept: ".json,application/json", hidden: "1",
    onchange: async e => {
      const file = e.target.files[0];
      e.target.value = "";
      if (!file) return;
      let parsed;
      try { parsed = JSON.parse(await file.text()); } catch { parsed = null; }
      const report = RULES.inspectCharacterFile(parsed, DATA.tables);
      if (!report.ok) {
        alert("That file doesn't look like an exported Sinless character:\n\n"
          + report.problems.map(p => "  • " + p).join("\n"));
        return;
      }
      // An old file opens either way — the repairs are automatic. The dialog
      // exists so they're visible, and so an orphaned row gets said out loud
      // instead of quietly pricing at zero.
      if (!(await importReportModal(report, file.name))) return;
      sheetMenuOpen = false;
      const merged = report.character;
      if (merged.name) STORAGE.saveCharacter(merged);   // so it shows in the Load list
      await openCharacter(merged);                      // opens in its own tab
      if (typeof refreshLoadList === "function") refreshLoadList();
    },
  });

  // A separate input rather than widening the one above: two formats, two
  // failure messages, so "that isn't a character file" always names the right
  // format. See static/md-import.js.
  const importMdInput = el("input", {
    type: "file", accept: ".md,.markdown,.txt,text/markdown", hidden: "1",
    onchange: async e => {
      const file = e.target.files[0];
      e.target.value = "";
      if (!file) return;
      sheetMenuOpen = false;
      await importMarkdownFile(file);
    },
  });

  const act = fn => async () => {
    sheetMenuOpen = false;
    await fn();
    rerenderApp();
  };

  const toggle = el("button", {
    class: "sh-menu-btn", "aria-label": "Menu", "aria-haspopup": "true",
    "aria-expanded": String(sheetMenuOpen),
    onclick: () => { sheetMenuOpen = !sheetMenuOpen; renderWorkspaceBar(); },
  }, el("span", { class: "bar" }), el("span", { class: "bar" }), el("span", { class: "bar" }));

  const wrap = el("div", { class: "sh-menu" }, toggle);
  if (sheetMenuOpen) {
    const ro = !!(activeTabObj() && activeTabObj().readonly);
    const synced = typeof SYNC !== "undefined" && SYNC.enabled && SYNC.enabled();

    // Group 1 — Load / Save / New (character files). Load is the same picker as
    // the header; Save mirrors it (incl. the "Saved ✓" flash) and stays open so
    // the confirmation is visible. Save is hidden on a read-only shared view —
    // use "Save a copy" in the banner instead.
    const loadSel = el("select", { class: "btn-select sh-mi-load", onchange: async e => {
      const name = e.target.value;
      if (!name) return;
      const loaded = STORAGE.loadCharacter(name);
      if (!loaded) { e.target.value = ""; return; }
      sheetMenuOpen = false;
      await openCharacter(RULES.mergeDefaults(loaded));
      e.target.value = "";
    } }, el("option", { value: "" }, "Load…"),
      ...STORAGE.listCharacters().map(n => el("option", { value: n }, n)));
    const saveBtn = !ro ? el("button", { class: "btn sh-mi-save", onclick: () => {
      if (!CHAR.name) { alert("Give the character a street name first."); return; }
      // Same silent-overwrite path as Finalize: the save keys on the sanitised
      // name, so an unrelated character with a matching one is replaced.
      const clash = STORAGE.collidingCharacter(CHAR);
      if (clash && !confirm(`"${clash}" is already saved under this name.\n\n`
        + "Saving REPLACES that character permanently. Overwrite them?")) return;
      STORAGE.saveCharacter(CHAR);
      if (typeof refreshLoadList === "function") refreshLoadList();
      saveBtn.textContent = "Saved ✓";
      setTimeout(() => { saveBtn.textContent = "Save"; }, 1200);
    } }, "Save") : null;
    const renameBtn = !ro ? el("button", { class: "btn sh-mi-plain",
      title: "Rename this character and move its save — not a copy",
      onclick: act(renameCharacter) }, "Rename…") : null;
    // Duplicate lives here as well as on the tab chip, because the chip's ⎘ is
    // hidden on a coarse pointer: at 15px it sat 3px from ✕, and of the two
    // mis-taps the one that WRITES is the copy — duplicateTab commits the new
    // character to storage immediately, with no undo, while a closed tab is
    // still in storage and reopens. A deliberate action belongs behind the
    // menu. Read-only views are excluded: they offer "Save a copy" instead.
    const dupBtn = !ro ? el("button", { class: "btn sh-mi-plain",
      title: "Open a copy of this character in a new tab — saved straight away under a new name",
      onclick: () => { sheetMenuOpen = false; duplicateTab(WORKSPACE.active); } },
      "Duplicate") : null;
    const newBtn = el("button", { class: "btn sh-mi-plain", onclick: () => {
      sheetMenuOpen = false; newCharacterTab();
    } }, "New");

    // Group 2 — Import / Export.
    const importBtn = el("button", { class: "btn sh-mi-load", onclick: () => importInput.click() }, "Import JSON");
    const importMdBtn = el("button", { class: "btn sh-mi-load",
      title: "Rebuild a character from a Markdown (Scabard) export — opens in the character generator",
      onclick: () => importMdInput.click() }, "Import Markdown");
    const exportJsonBtn = el("button", { class: "btn sh-mi-save", onclick: act(() => {
      // Two versions, because they answer different questions. `app_version` on
      // the record is what BUILT this character and travels with it forever;
      // `exported_with` is this build, and is the only one an older file can
      // offer. Kept outside `app_version` so a round trip can't overwrite the
      // character's own provenance with whoever last exported it.
      const payload = Object.assign({}, CHAR, {
        exported_with: RULES.APP_VERSION,
        exported_at: new Date().toISOString(),
      });
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const a = el("a", { href: URL.createObjectURL(blob),
        download: (CHAR.name || "character") + ".json" });
      a.click();
    }) }, "Export JSON");
    // Export Markdown reads the finalized play sheet; only offer it in play mode.
    const exportMdBtn = CHAR.finalized
      ? el("button", { class: "btn sh-mi-save", onclick: act(exportMarkdown) }, "Export Markdown (Scabard)") : null;

    // Group 3 — Sharing / Shared characters / Homebrew (sharing + gallery need a backend).
    const sharingBtn = (synced && !ro && CHAR.name)
      ? el("button", { class: "btn sh-mi-plain", onclick: act(toggleSharing) },
          SYNC.isPublic(STORAGE.sanitizeName(CHAR.name))
            ? "Sharing: Public ✓ — make private"
            : "Sharing: Private — make public")
      : null;
    const sharedBtn = synced
      ? el("button", { class: "btn sh-mi-plain", onclick: act(openSharedGallery) }, "Shared characters") : null;
    const homebrewBtn = el("button", { class: "btn sh-mi-brew", onclick: act(enterHomebrew) }, "Homebrew");

    // Group 4 — Back to Chargen / Revert / Delete. Back/Revert only apply to a
    // finalized character (they toggle play state), so hide them in chargen.
    const backBtn = CHAR.finalized
      ? el("button", { class: "btn sh-mi-plain", onclick: act(backToChargen) }, "← Back to Chargen") : null;
    const resyncBtn = (CHAR.finalized && !ro && CHAR.play && CHAR.play.kit)
      ? el("button", { class: "btn sh-mi-plain",
          title: "Rebuild play's copy of the items you still own from the chargen build",
          onclick: act(resyncKitFromBuild) }, "Re-sync Build → Kit") : null;
    const revertBtn = CHAR.finalized
      ? el("button", { class: "btn warn", onclick: act(revertToChargenEnd) }, "Revert to Post-Chargen") : null;
    const deleteBtn = el("button", { class: "btn sh-mi-delete", disabled: CHAR.name ? null : "1",
      title: CHAR.name ? "Permanently delete this character's save" : "Character has no name — nothing saved to delete",
      onclick: act(() => deleteSavedCharacter(CHAR.name)) }, "Delete Character");
    const manageBtn = el("button", { class: "btn sh-mi-delete",
      title: "Tick several saved characters and delete them in one go",
      onclick: act(manageSavesModal) }, "Manage saves…");

    // Group 5 — Admin / Sign out (danger red; only when signed in).
    const adminBtn = (synced && SYNC.isAdmin())
      ? el("button", { class: "btn sh-mi-danger", onclick: act(openAdminPanel) }, "Admin") : null;
    const signOutBtn = synced
      ? el("button", { class: "btn sh-mi-danger", onclick: act(doSignOut) }, "Sign out") : null;

    const groups = [
      [loadSel, saveBtn, renameBtn, dupBtn, newBtn],
      [importBtn, importMdBtn, exportJsonBtn, exportMdBtn],
      [sharingBtn, sharedBtn, homebrewBtn],
      [backBtn, resyncBtn, revertBtn, deleteBtn, manageBtn],
      [adminBtn, signOutBtn],
    ].map(g => g.filter(Boolean)).filter(g => g.length);

    const panel = el("div", { class: "sh-menu-panel", role: "menu" });
    groups.forEach((g, i) => {
      if (i > 0) panel.append(el("div", { class: "sh-menu-sep" }));
      g.forEach(b => panel.append(b));
    });
    panel.append(importInput, importMdInput);

    wrap.append(
      el("div", { class: "sh-menu-backdrop", onclick: () => { sheetMenuOpen = false; renderWorkspaceBar(); } }),
      panel);
  }
  return wrap;
}
/* Rename a character, moving its save rather than forking it. Typing a new name
 * into the chargen field and saving leaves the old slot behind — two characters
 * where the player meant one — so this writes the new slot, re-points sharing at
 * it, and deletes the old one. Storage keys are sanitised, so "Jimmy Chan" and
 * "Jimmy-Chan" are the same slot and renaming between them is a no-op move. */
async function renameCharacter() {
  const oldName = CHAR.name || "";
  const next = (prompt("New name for this character:", oldName) || "").trim();
  if (!next || next === oldName) return;
  const oldSlug = CHAR.saved_as || (oldName ? STORAGE.sanitizeName(oldName) : "");
  const newSlug = STORAGE.sanitizeName(next);
  // Someone else already in the destination slot: renaming would overwrite them.
  const clash = STORAGE.collidingCharacter({ name: next, saved_as: oldSlug });
  if (clash && !confirm(`"${clash}" is already saved under that name.\n\n`
    + `Renaming REPLACES that character permanently — their build, play state `
    + "and history all go.\n\nOverwrite them?")) return;
  const wasPublic = typeof SYNC !== "undefined" && SYNC.enabled && SYNC.enabled()
    && oldSlug && SYNC.isPublic(oldSlug);
  CHAR.name = next;
  CHAR.saved_as = newSlug;
  if (oldSlug) STORAGE.saveCharacter(CHAR);      // unnamed drafts have nothing to move
  // Sharing is keyed by slug, so a shared character has to be re-published under
  // the new one. Links to the old slug are dead either way — the slug IS the URL.
  if (wasPublic && newSlug !== oldSlug) {
    await SYNC.setVisibility(newSlug, true);
    await SYNC.setVisibility(oldSlug, false);
  }
  if (oldSlug && newSlug !== oldSlug) STORAGE.deleteCharacter(oldSlug);
  if (typeof refreshLoadList === "function") refreshLoadList();
  await recalc();
  showActiveTab();
  renderWorkspaceBar();     // the tab carries the name too
  persistWorkspace();
}

/* "carried_qty 10 → 8" for every field a re-sync would actually change, so it
 * can be judged row by row instead of on faith.
 *
 * Only fields the BUILD carries are compared. A weapon in play also holds
 * things chargen has never heard of — chambered ammo, rounds loaded, firing
 * mode, kata — and those are play's alone: the build has no opinion on them, so
 * they are neither a difference to report nor anything a re-sync should touch.
 * Reporting them made every fired gun look out of step and offered to blank the
 * magazine. */
function entryDiff(kitEntry, buildEntry) {
  const show = v => {
    if (Array.isArray(v)) return v.length ? v.map(entryLabel).join(", ") : "none";
    if (v === "" || v == null) return "—";
    return String(v);
  };
  const out = [];
  for (const key of Object.keys(buildEntry || {})) {
    if (key === "name") continue;
    const a = (kitEntry || {})[key], b = (buildEntry || {})[key];
    if (JSON.stringify(a ?? null) === JSON.stringify(b ?? null)) continue;
    out.push(`${key} ${show(a)} → ${show(b)}`);
  }
  return out.join(" · ");
}

/* Lay the build's version of an item over play's copy, field by field. Not a
 * wholesale replacement: play-only keys (see entryDiff) survive, so re-syncing
 * a rifle's mods doesn't unload it. */
function applyBuildEntry(into, from) {
  for (const [key, value] of Object.entries(from || {})) into[key] = deepCopyEntry(value);
  return into;
}

/* Which of the out-of-step items to rebuild from the build. Resolves to the
 * chosen subset, or null if the player backed out. Nothing is ticked to start
 * with — the safe answer is "change nothing". */
function promptKitResync(pending) {
  return new Promise(resolve => {
    const backdrop = el("div", { class: "mount-modal-backdrop" });
    const done = val => {
      document.removeEventListener("keydown", onKey); backdrop.remove(); resolve(val);
    };
    const onKey = e => { if (e.key === "Escape") done(null); };
    const boxes = pending.map(p => el("input", { type: "checkbox" }));
    const rows = pending.map((p, i) => el("label", { class: "opt sh-resync-row" },
      boxes[i],
      el("span", {},
        el("b", {}, p.label),
        p.diff ? el("div", { class: "sub" }, p.diff) : null)));
    const setAll = on => boxes.forEach(b => { b.checked = on; });
    const modal = el("div", { class: "card mount-modal", style: "max-width:560px" },
      el("h3", {}, "Re-sync from the build"),
      el("p", { class: "hint" },
        "These items differ between the chargen build and play's copy. Ticking one "
        + "lays the build's version over play's copy — use it for edits made in "
        + "chargen that never reached the sheet. Leave the rest alone: flags you "
        + "changed at the table would be overwritten. Only items the build and play "
        + "both hold are listed; anything bought in play has no build version to "
        + "sync from, and a magazine or firing mode is play's alone either way."),
      el("div", { style: "display:flex;gap:8px;margin-bottom:6px" },
        el("button", { class: "btn small", onclick: () => setAll(true) }, "Select all"),
        el("button", { class: "btn small", onclick: () => setAll(false) }, "None")),
      el("div", { class: "sh-resync-list" }, ...rows),
      el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin-top:14px" },
        el("button", { class: "btn-add",
          onclick: () => done(pending.filter((p, i) => boxes[i].checked)) }, "Re-sync ticked"),
        el("button", { class: "btn ghost", onclick: () => done(null) }, "Cancel")));
    backdrop.append(modal);
    backdrop.addEventListener("click", e => { if (e.target === backdrop) done(null); });
    document.addEventListener("keydown", onKey);
    document.body.append(backdrop);
  });
}

/* Repair hatch: rebuild play's copy of the items the character still owns from
 * the chargen build.
 *
 * Needed because reconcileKit used to match by NAME only. A weapon you already
 * owned, re-modded in chargen, changed no names — so nothing was carried across,
 * while kit_baseline still advanced to the edited build. That leaves a character
 * permanently out of step: chargen says Blinged with three mods, the sheet shows
 * the bike as it was, and no future re-finalize can tell the difference, because
 * as far as the baseline is concerned nothing changed.
 *
 * Membership is left alone — this only rewrites the CONFIGURATION of items
 * present on both sides. Anything bought in play lives in play.purchases and is
 * never touched; anything sold in play stays sold. */
async function resyncKitFromBuild() {
  const play = CHAR.play;
  if (!play || !play.kit) { alert("Nothing to re-sync — this character has no play kit yet."); return; }
  // Work out every replacement first, so the confirm can list them and a "no"
  // leaves the character exactly as it was.
  const pending = [];
  for (const category of RULES.KIT_CATEGORIES) {
    const now = CHAR[category] || [];
    const kit = play.kit[category] = play.kit[category] || [];
    for (const name of new Set(now.map(entryLabel))) {
      const nowOnes = now.filter(e => entryLabel(e) === name);
      const kitOnes = kit.filter(e => entryLabel(e) === name);
      for (let k = 0; k < Math.min(nowOnes.length, kitOnes.length); k++) {
        // An empty diff means the build and play agree on everything the build
        // has a say in — a fired gun differs only in its magazine, and that is
        // not something to offer to "repair".
        const diff = entryDiff(kitOnes[k], nowOnes[k]);
        if (!diff) continue;
        pending.push({ category, kit, at: kit.indexOf(kitOnes[k]), entry: nowOnes[k],
          label: `${category}: ${name}`, diff });
      }
    }
  }
  if (!pending.length) { alert("Already in step — play's copy matches the build."); return; }
  // Item by item, not all or nothing: most of what differs here is the table
  // doing its job — ammo spent, grenades thrown — and only the player knows
  // which rows are the build edits that never came across.
  const picked = await promptKitResync(pending);
  if (!picked || !picked.length) return;
  picked.forEach(p => { applyBuildEntry(p.kit[p.at], p.entry); });
  // The baseline only moves for what was actually re-synced; anything left
  // deliberately out of step stays a pending chargen edit for the next
  // re-finalize to carry across.
  const base = play.kit_baseline || (play.kit_baseline = {});
  picked.forEach(p => {
    const list = base[p.category] = base[p.category] || [];
    const at = list.findIndex(e => entryLabel(e) === entryLabel(p.entry));
    if (at >= 0) list[at] = deepCopyEntry(p.entry); else list.push(deepCopyEntry(p.entry));
  });
  const changed = picked.map(p => p.label);
  logCash(`Re-synced from the build: ${changed.slice(0, 6).join(", ")}`
    + (changed.length > 6 ? ` +${changed.length - 6} more` : ""), 0);
  STORAGE.saveCharacter(CHAR);
  await recalc();
  showActiveTab();
}

/* Knowledge skills are the one kit category the play sheet ADDS to directly:
 * every other category has a play.purchases list, but a knowledge costs no cash
 * and is budgeted off Intelligence in both modes, so the sheet writes it
 * straight into the kit. That left one added in play invisible on the chargen
 * tab, so players re-added it there — and re-finalize, seeing a genuinely new
 * chargen entry, pushed a second copy into the kit (issue #35).
 *
 * Going back to chargen therefore folds them into the build: the same points
 * against the same Intelligence budget, just now visible where they're edited.
 * The baseline moves with it so the next re-finalize sees nothing new to add.
 * This is a deliberate, narrow exception to "play never writes to the build" —
 * it is safe precisely because knowledge spends no creation cash. */
function syncKnowledgeToBuild() {
  const play = CHAR.play;
  if (!play || !play.kit) return 0;
  const build = CHAR.knowledge_skills = CHAR.knowledge_skills || [];
  const key = k => knowledgeKey(entryLabel(k));
  // Heal anything already doubled up before folding today's play additions in,
  // so a character carrying old duplicates comes back to a clean list.
  let moved = dedupeKnowledge(build) + dedupeKnowledge(play.kit.knowledge_skills);
  for (const k of play.kit.knowledge_skills || []) {
    if (!key(k)) continue;                       // an unnamed row is a half-typed one
    const found = build.find(b => key(b) === key(k));
    if (!found) { build.push({ name: k.name, points: k.points }); moved++; }
    else if (found.points !== k.points) { found.points = k.points; moved++; }
  }
  if (moved) {
    play.kit_baseline = play.kit_baseline || {};
    play.kit_baseline.knowledge_skills = JSON.parse(JSON.stringify(build));
  }
  return moved;
}

async function backToChargen() {
  if (!confirm("Return to character generation?\n\nChargen budgets become editable again. "
    + "Play state (damage, Kismet, notes, advances, purchases) is kept and returns when you re-finalize."))
    return;
  CHAR.finalized = false;
  syncKnowledgeToBuild();      // so knowledges added in play are visible where they're edited
  schedulePlaySave();
  await recalc();
  exitSheet();
  renderTabs();
  renderPanel();
  renderWorkspaceBar();   // state dot flips play -> chargen
  persistWorkspace();
}

/* ------------------------------------------------ overview */
// Drag-to-reorder a table row backed by `arr` (the row represents `item`, an
// element of arr). Dropping onto another reorderable row of the same array moves
// item there, persists, and re-renders. Non-reorderable rows (cyberguns, granted
// armor) simply don't call this, so they stay put.
// Row reordering via ▲/▼ buttons. Native <tr> drag-and-drop is unreliable in
// tables (drag-image / drop hit-testing quirks) and dead on touch, so loadout
// rows reorder with explicit buttons instead. reorderHandle renders the control.
function reorderHandle(up, down, canUp, canDown) {
  const mk = (label, fn, ok, title) => el("button", {
    class: "sh-reorder-btn", title, ...(ok ? {} : { disabled: "1" }),
    onclick: e => { e.stopPropagation(); if (ok) fn(); } }, label);
  return el("span", { class: "sh-reorder" },
    mk("▲", up, canUp, "Move up"),
    mk("▼", down, canDown, "Move down"));
}
// A unified loadout list can span different backing stores (equipped weapons,
// cybergun augments, worn armor, derived granted-armor rows). Each item exposes
// getOrder()/setOrder(v) onto its own store and an `ins` insertion index used as
// the tiebreak before any custom order exists. loadoutSort orders the list;
// loadoutMove swaps two neighbours and renumbers every item's stored order.
function loadoutSort(items) {
  return items.sort((a, b) => {
    const ao = Number.isFinite(a.getOrder()) ? a.getOrder() : 1e6 + a.ins;
    const bo = Number.isFinite(b.getOrder()) ? b.getOrder() : 1e6 + b.ins;
    return ao - bo;
  });
}
function loadoutMove(items, i, dir) {
  const j = i + dir;
  if (j < 0 || j >= items.length) return;
  [items[i], items[j]] = [items[j], items[i]];
  items.forEach((it, k) => it.setOrder(k));
  playChanged();
}
// The Gear tab lists ARE their backing array in order, so reordering there moves
// the element itself rather than layering a stored order over several stores.
// `after` re-renders: playChanged for name-keyed lists, playChangedRecalc where
// a CALC array is index-aligned to the one being moved (armor).
/* Reordering swaps two entries in place. Every list the play sheet can reorder
 * is play's own — the kit or a purchases array — so this is just a swap. */
function arrayMove(arr, i, dir, after = playChanged) {
  const j = i + dir;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  after();
}
/* Same swap, but between two arbitrary slots. A grouped list (the Gear tab's
 * gear table, split into Class headings) shows a category's rows as a subset of
 * its backing array, so "move up" means swapping with the previous row of the
 * SAME category — not the previous array slot, which may belong to another
 * heading. Only the two entries move; every other item keeps its index. */
function arraySwap(arr, i, j, after = playChanged) {
  if (i === j || i < 0 || j < 0 || i >= arr.length || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  after();
}

// Cyberguns are augments with a chosen gun; surface them as read-only weapons
// on the Overview loadout and the Gear weapons list.
/* Guns that ARE a mod on another gun.
 *
 * Three underbarrel mods aren't accessories at all — a Cap Laser, an EZ-Bake
 * microwaver and an under-slung grenade launcher are weapons bolted beneath the
 * host, each with its own row in the weapons table. Fitting the mod should put
 * that gun on your list, and it did not: the mod sat in the host's mod strip
 * with its effect text and the weapon it represents was never reachable.
 *
 * Derived, never owned. The player buys the MOD, and the mod's price already
 * equals the weapon's, so the granted gun is free — charging for both would
 * bill the same purchase twice. It follows its host: it can't be sold on its
 * own (remove the mod), and it stops existing if the host is unequipped.
 *
 * Which weapon a mod grants is a data column (GrantsWeapon), not a list of
 * names here, so a homebrew underbarrel weapon works the moment it's written. */
function underbarrelWeapons() {
  const out = [];
  for (const en of ownedWeapons()) {
    const host = en.ref;
    if (host.equipped === false) continue;
    for (const m of host.mods || []) {
      const modName = (m && typeof m === "object") ? m.name : m;
      const modRow = (DATA.tables.weapon_mods || []).find(x => x.Modification === modName);
      const grants = modRow && String(modRow.GrantsWeapon || "").trim();
      if (!grants) continue;
      const row = (DATA.tables.weapons || []).find(x => x.Weapon === grants);
      // A GrantsWeapon naming a row this browser doesn't have (homebrew the
      // player hasn't installed) is skipped rather than rendered as a blank gun.
      if (!row) continue;
      // A granted gun still needs somewhere to keep what it's loaded with, which
      // round is chambered and which firing mode is set — the same state an
      // owned weapon keeps on its own entry. It has no entry of its own, so the
      // state lives on the HOST, keyed by the mod that granted it: one mod per
      // underbarrel slot, so the key is unique, and it travels with the host
      // through the kit like every other play edit.
      const store = (host.ub_state = host.ub_state || {});
      const state = (store[modName] = store[modName] || {});
      state.name = grants;                       // firingModeControls labels from this
      // hostRef is the entry OBJECT (identity), host.name is display text only --
      // two owned weapons can share a name (reconcileKit pairs same-named entries
      // positionally), and only the object tells which one this underbarrel gun
      // actually rides on.
      out.push({ name: grants, row, host: host.name, hostRef: host, mod: modName, state });
    }
  }
  return out;
}

function equippedCyberguns() {
  // Keep the source augment entry + its array so the Overview can drag-reorder
  // cyberguns (they're derived, so reordering acts on the underlying augments).
  const sources = [
    kitOf("augments"),
    (CHAR.play && CHAR.play.purchases && CHAR.play.purchases.augments) || [],
  ];
  const out = [];
  let ins = 0;
  for (const arr of sources) {
    for (const a of arr) {
      if (!RULES.isCybergunAugment(a.name) || !a.gunType) continue;
      const g = (DATA.tables.cyberguns || []).find(x => x.Type === a.gunType);
      if (g) out.push({ name: `Cybergun — ${g.Type}`, gun: g, src: a,
        reloadable: RULES.cybergunReloadable(a.name), _ins: ins++ });
    }
  }
  // A custom drag order is stored on each source augment as cgOrder, unifying the
  // order across both arrays; entries without it keep insertion order, last.
  return out.sort((a, b) =>
    (typeof a.src.cgOrder === "number" ? a.src.cgOrder : 1e6 + a._ins)
    - (typeof b.src.cgOrder === "number" ? b.src.cgOrder : 1e6 + b._ins));
}

/* CALC.weapons is index-aligned to the character's owned weapons in order
 * (rules.js resolveWeapons pushes one item per entry, skipping only a row it
 * can't resolve), so a plain name-`find` returns the FIRST match and two
 * identical guns both read the first one's numbers — cosmetic on the Gear tab,
 * but on a hand card it's the wrong Recoil feeding the Fire button's gate.
 * This resolves by POSITION among same-named entries instead: the Nth "Militech
 * M31" entry gets the Nth "Militech M31" CALC row. `entries` must be the same
 * array `entry` came from (equippedWeapons), so the position lines up. */
function calcRowFor(entry, entries) {
  const nth = entries.filter(e => e.name === entry.name).indexOf(entry);
  const rows = (CALC.weapons || []).filter(x => x.Weapon === entry.name);
  return rows[nth] || rows[0] || {};
}

/* "Reload All Weapons" (issue #85): a bulk, between-fights action from the
 * Gear tab's Ammo section. Tops off every owned weapon's `w.loaded` to a full
 * magazine and spends nothing — the single-weapon Reload button on a hand
 * card is a combat action (costs a Simple Action, or two for a crossbow) and
 * this deliberately is not; it's meant for the moment before a session
 * starts, not the moment before a shot.
 *
 * Scope, all deliberate: melee/natural attacks have no `Ammo` figure and are
 * skipped by the maxAmmo check below; a sealed one-shot has no magazine to
 * refill (RULES.weaponIsOneshot). Cyberguns are left out entirely — their
 * per-weapon Reload already gates a non-Reloadable implant behind a confirm
 * ("cannot be reloaded during combat... Reload anyway?"), and a silent bulk
 * pass would run right past a rule that exists specifically to make that
 * decision explicit. Drone/vehicle-mounted weapons are left out too: those
 * are configured and reloaded from the Rigging tab, spending its own Exploit
 * Actions, and are a different array (`unit.weapons`) with a different owner.
 * Recoil is untouched — the per-weapon Reload's "also steadies the gun" is a
 * combat-action side effect this free, out-of-round action doesn't carry.
 *
 * `calcRowFor` rather than a bare name-`find`, so two identically-named
 * weapons each read their own Ammo figure instead of both reading the
 * first's — see calcRowFor's own comment for the bug that fixed. */
function reloadAllWeapons() {
  const entries = ownedWeapons().map(en => en.ref);
  let reloaded = 0, full = 0;
  entries.forEach(w => {
    const r = DATA.tables.weapons.find(x => x.Weapon === w.name) || {};
    if (RULES.weaponIsOneshot(r)) return;
    const calcRow = calcRowFor(w, entries);
    // The loaded round can resize the magazine, and a bulk reload must fill
    // the magazine the hand card shows rather than the unloaded one (#86).
    const ammoRow = RULES.applyAmmoToRow(calcRow, r, loadedAmmoFor(w, r).mods);
    const maxAmmo = Math.max(0, parseInt(ammoRow.Ammo ?? r.Ammo, 10) || 0);
    if (!maxAmmo) return;
    const loaded = w.loaded == null ? maxAmmo
      : Math.max(0, Math.min(Math.floor(+w.loaded) || 0, maxAmmo));
    if (loaded >= maxAmmo) { full++; return; }
    w.loaded = maxAmmo;
    reloaded++;
  });
  if (!reloaded) {
    alert(full ? "Every weapon is already fully loaded." : "No weapons need reloading.");
    return;
  }
  playChanged();
}

/* Ammo the character actually owns, by name -- chargen kit plus anything bought
   in play, merged, since you load from one stock. */
function ownedAmmoRows() {
  const seen = new Map();
  for (const g of allGear()) {
    const row = DATA.tables.misc_gear.find(x => x.Item === g.name);
    if (row && (row.Class || "").startsWith("Ammo") && !seen.has(row.Item)) seen.set(row.Item, row);
  }
  return [...seen.values()];
}

/* Ammo the character owns that this particular weapon will actually chamber. */
function ammoOptionsFor(weaponRow) {
  return ownedAmmoRows().filter(r => RULES.ammoFitsWeapon(r, weaponRow));
}

/* Which ammo an entry is loaded with. An unset choice falls back to Standard --
   the plain rounds a gun is assumed to carry, and they have no effect, so the
   default changes no numbers. Falls through to nothing when the character owns
   no Standard, when a previously chosen type has since been sold off, and when
   a choice made before the compatibility rules no longer fits this weapon. */
function ammoNameFor(entry, weaponRow) {
  const fits = ammoOptionsFor(weaponRow);
  if (fits.some(x => x.Item === entry.ammo)) return entry.ammo;
  if (entry.ammo === "") return "";                       // explicitly unloaded
  return fits.some(x => x.Item === "Standard") ? "Standard" : "";
}

/* The ammo an entry is loaded with, plus its parsed stat mods. */
function loadedAmmoFor(entry, weaponRow) {
  const none = { row: null, name: "", mods: RULES.ammoStatMods(""), notes: [] };
  const name = ammoNameFor(entry, weaponRow);
  if (!name) return none;
  const row = ownedAmmoRows().find(x => x.Item === name);
  if (!row) return none;
  const mods = RULES.ammoStatMods(row.Effect);
  const notes = [...mods.notes, row.Notes || ""].filter(Boolean);
  return { row, name: row.Item, mods, notes };
}

/* Grenades the character owns. A launcher is loaded with these rather than with
   ammunition -- its own Damage reads "By Grenade" -- and they're weapons in the
   data, so they come from CHAR.weapons. Thrown weapons that aren't grenades
   (Knife, Shuriken, Molotov) are not launchable. */
function ownedGrenadeRows() {
  const seen = new Map();
  for (const w of allWeapons()) {
    const row = DATA.tables.weapons.find(x => x.Weapon === w.name);
    if (row && row.Type === "Thrown" && /grenade/i.test(row.Weapon) && !seen.has(row.Weapon))
      seen.set(row.Weapon, row);
  }
  return [...seen.values()];
}

/* What a launcher currently has chambered, and the stats it lends. Unlike ammo
   there's no sensible default -- an empty launcher deals "By Grenade". */
function loadedGrenadeFor(entry) {
  const row = ownedGrenadeRows().find(x => x.Weapon === entry.ammo);
  if (!row) return { row: null, name: "", notes: [] };
  return { row, name: row.Weapon, notes: [row.Notes || ""].filter(Boolean) };
}

/* Munition selector. Melee and thrown weapons load nothing, and neither do
   Energy weapons -- they run on Heat. Grenade launchers pick a grenade;
   everything else that fires, cyberguns included, picks ammunition. */
function munitionPicker(entry, weaponRow) {
  const type = (weaponRow || {}).Type;
  if (["Melee", "Thrown", "Energy"].includes(type)) return "—";
  const launcher = type === "GrenadeLauncher";
  const owned = launcher ? ownedGrenadeRows() : ammoOptionsFor(weaponRow);
  const key = r => (launcher ? r.Weapon : r.Item);
  if (!owned.length)
    return el("span", { class: "sub" },
      launcher ? "no grenades owned"
        : (ownedAmmoRows().length ? "none this weapon takes" : "none owned"));
  const ro = !!(activeTabObj() && activeTabObj().readonly);
  const cur = launcher ? loadedGrenadeFor(entry).name : ammoNameFor(entry, weaponRow);
  if (ro) return el("span", { class: "sub" }, cur || "—");
  // Names only. What each round DOES is already spelled out in the Ammo table
  // under this one, and repeating it inside every option made the dropdown —
  // and with it the whole Ammo column — as wide as the weapon names. The detail
  // rides along as each option's tooltip.
  const label = r => launcher ? r.Weapon.replace(/\s*Grenade$/i, "") : r.Item;
  const detail = r => launcher
    ? `DMG ${r.Damage || "—"}`
    : (r.Effect || "no special effect");
  return el("select", { class: "sh-fire-sel sh-ammo-sel",
    title: launcher ? "Chambered grenade" : "Loaded ammunition",
    onchange: e => { entry.ammo = e.target.value; playChanged(); } },
    el("option", { value: "" }, launcher ? "— empty —" : "— none —"),
    ...owned.map(r => el("option", { value: key(r), title: detail(r),
      ...(key(r) === cur ? { selected: 1 } : {}) }, label(r))));
}

/* What a mount is loaded with, and the stat mods it lends. Same parsing as
   personal ammo -- the exotic rounds state their effect the same way. */
function unitLoadedAmmo(table, unit, wi, wn) {
  const st = unitGunState(table, unit, wi);
  const fits = ownedAmmoRows().filter(a => RULES.ammoFitsUnitWeapon(a, wn));
  const row = fits.find(a => a.Item === st.ammo);
  if (!row) return { row: null, name: "", mods: RULES.ammoStatMods(""), notes: [] };
  const mods = RULES.ammoStatMods(row.Effect);
  return { row, name: row.Item, mods, notes: mods.notes };
}

/* Firing state for a mount, kept in play state because a unit's weapons are
   stored as bare names with nothing to hang it on. Keyed by the unit's slot and
   the weapon's index within it, alongside the condition tracks. */
function unitGunState(table, unit, wi) {
  const rg = CHAR.play.rigging;
  const slot = (rg.units[unitStateKey(table, unit)] ??= {});
  const guns = (slot.guns ??= {});
  return (guns[wi] ??= {});
}

/* The Gunnery-based attack test for a rigger firing a drone/vehicle mount —
 * "Use gunnery to fire a vehicle weapon" per the action reference. A mounted
 * weapon row carries no Type column for weaponSkillName() to map through
 * (it isn't Firearms/Melee/etc — whatever's bolted to the mount is aimed
 * with Gunnery regardless of what it is), so this builds the same shape
 * weaponRollSpec() returns directly off the Gunnery skill rather than
 * forcing a Type lookup that doesn't apply. No specialization support
 * (Gunnery has none of the per-weapon specialties Firearms/Melee do). */
function gunneryRollSpec(accuracy, bonuses = []) {
  const s = (CALC.skills || {})["Gunnery"];
  if (!s) return null;
  const locked = s.trained_only && !(s.final > 0 || s.dice_bonus);
  const skillDice = Math.max(0, s.final);
  const acc = +accuracy || 0;
  const limitDice = skillDice + acc;
  const bonus = bonuses.reduce((n, b) => n + (+b.dice || 0), 0);
  const why = [`Gunnery ${s.final}`, `= ${skillDice} skill`];
  if (acc) why.push(`+ Accuracy ${acc} = ${limitDice} limit dice`);
  const bwhy = [];
  for (const b of bonuses) if (+b.dice) bwhy.push(`${b.label} +${b.dice}`);
  return { skill: "Gunnery", pool: s.pool, locked, skillDice, acc, limitDice, bonus, why, bwhy };
}

/* Firing controls for a mounted weapon: mode + magazine for a ballistic mount,
   a heat tracker for an energy one. Energy mounts state Heat and Heat Limit in
   their own columns, so unlike personal energy weapons nothing has to be parsed
   out of prose.
 *
 * Fire, Reload and Aimed Fire all spend from the "Rigging" Exploit Actions a
 * jumped-in rig's cores grant before reaching for a Simple Action — a
 * rigger directs a mount through the same exploit pool the Rigging tab
 * already lists, not through a personal weapon's action economy. */
function unitGunControls(table, unit, wi, wn, wr, isEnergy, ammoMods = null) {
  const ro = !!(activeTabObj() && activeTabObj().readonly);
  const st = unitGunState(table, unit, wi);
  const wrap = el("div", { class: "sh-fire" });

  if (isEnergy) {
    const per = parseInt(wr.Heat, 10) || 0;
    const max = parseInt(wr["Heat Limit"], 10) || 0;
    if (!per && !max) return null;                 // no heat rating on this mount
    const cur = () => (st.heat == null ? 1 : Math.max(0, Math.floor(+st.heat) || 0));
    if (ro) wrap.append(el("span", { class: "sub" }, `Heat ${cur()}`));
    else wrap.append(miniCounter("Heat", cur, v => { st.heat = v; }, 0, max || 99));
    wrap.append(el("span", { class: "sub" },
      ` ${per} per shot · max ${max}${max && cur() >= max ? " — overheated" : ""}`));
    // No ordinary Fire button here, matching personal Energy weapons — Heat
    // is tracked by hand above. Aimed Fire still applies, spending a point
    // of Heat (when the row rates one) the same way Fire spends a round.
    if (!ro) {
      const overheated = !!(max && cur() + per > max);
      const rollSpec = gunneryRollSpec(wr.Accuracy);
      const aimed = aimedFireButton(rollSpec, wn, "SS", {
        disabled: overheated,
        disabledTitle: "Not enough heat capacity left for another shot",
        spend: () => { st.heat = cur() + per; },
      }, "Rigging");
      if (aimed) wrap.append(el("div", { class: "sh-fire-btns" }, aimed));
    }
    return wrap;
  }

  const modes = RULES.ammoFiringModes(RULES.weaponFiringModes(wr), ammoMods);
  if (!modes.length) return null;                  // Oil Slick / Smokescreen
  const mode = modes.includes(st.mode) ? st.mode : modes[0];
  const md = RULES.firingMode(mode);
  wrap.append(modes.length > 1 && !ro
    ? el("select", { class: "sh-fire-sel", title: "Firing mode",
        onchange: e => { st.mode = e.target.value; playChanged(); } },
        ...modes.map(m => {
          const d = RULES.firingMode(m);
          return el("option", { value: m, ...(m === mode ? { selected: 1 } : {}) },
            `${m} — ${d.name} (${d.dice ? `+${d.dice}b, ` : ""}${d.ammo} rd${d.ammo === 1 ? "" : "s"})`);
        }))
    : el("span", { class: "sh-fire-mode", title: md.name }, mode));

  // "1 missile" and the like aren't counts, so those mounts get no magazine.
  // The loaded round may resize it, the same as on a personal weapon (#86).
  const magRaw = ammoMods
    ? (RULES.applyAmmoToRow({ Ammo: wr.Ammo }, wr, ammoMods).Ammo ?? wr.Ammo) : wr.Ammo;
  const maxAmmo = /^\s*\d+\s*$/.test(String(magRaw || "")) ? parseInt(magRaw, 10) : 0;
  if (maxAmmo) {
    const loaded = st.loaded == null ? maxAmmo
      : Math.max(0, Math.min(Math.floor(+st.loaded) || 0, maxAmmo));
    const dry = loaded < md.ammo;
    wrap.append(el("span", { class: "sh-fire-mag" + (dry ? " dry" : "") },
      `${loaded}/${maxAmmo} rds`));
    // Same skill+Accuracy math as a personal weapon's Fire button, just off
    // Gunnery instead of a Type-mapped skill — see gunneryRollSpec().
    const bonuses = [];
    if (md.dice) bonuses.push({ label: mode, dice: md.dice });
    const rollSpec = gunneryRollSpec(wr.Accuracy, bonuses);
    const rollable = rollSpec && !rollSpec.locked && (rollSpec.limitDice + rollSpec.bonus) > 0;
    if (!ro) wrap.append(el("div", { class: "sh-fire-btns" },
      el("button", { class: "btn small", disabled: dry ? "1" : null,
        title: dry ? `Not enough rounds for ${mode} (needs ${md.ammo})`
                   : `Fire ${mode} — spends ${md.ammo} round${md.ammo === 1 ? "" : "s"}`
                     + (rollable
                         ? ` and loads ${rollSpec.limitDice + rollSpec.bonus}d6 in the roller`
                         : ""),
        onclick: () => {
          // Same Full-Auto-is-Complex rule as a personal weapon's Fire, but
          // drawing on Rigging Exploit Actions before Simple ones.
          if (!spendActionUnits("Rigging", mode === "FA" ? 2 : 1, `Firing ${mode} (${wn})`)) return;
          if (rollable)
            openPoolRoller({ dice: rollSpec.limitDice, bonus: rollSpec.bonus,
              pool: rollSpec.pool, label: wn,
              note: `${rollSpec.skill}: ${rollSpec.skillDice} skill`
                + (rollSpec.acc ? ` + ${rollSpec.acc} Accuracy` : "")
                + (rollSpec.bonus ? ` + ${rollSpec.bonus} bonus (${mode})` : "") });
          st.loaded = Math.max(0, loaded - md.ammo);
          playChanged();
        } }, "Fire"),
      el("button", { class: "btn small", disabled: loaded >= maxAmmo ? "1" : null,
        title: "Reload to a full magazine"
          + (/crossbow/i.test(wn) ? " — a Complex Action to recock" : ""),
        onclick: () => {
          const reloadCost = /crossbow/i.test(wn) ? 2 : 1;
          if (!spendActionUnits("Rigging", reloadCost, `Reloading ${wn}`)) return;
          st.loaded = maxAmmo;
          playChanged();
        } }, "Reload"),
      aimedFireButton(rollSpec, wn, mode, {
        disabled: dry,
        disabledTitle: `Not enough rounds for Aimed Fire (needs ${md.ammo})`,
        spend: () => { st.loaded = Math.max(0, loaded - md.ammo); },
      }, "Rigging")));
  }

  // Exotic rounds are mount-specific; ordinary personal ammo never fits one.
  const fits = ownedAmmoRows().filter(a => RULES.ammoFitsUnitWeapon(a, wn));
  if (fits.length && !ro) {
    const cur = fits.some(a => a.Item === st.ammo) ? st.ammo : "";
    wrap.append(el("select", { class: "sh-fire-sel", title: "Loaded ammunition",
      onchange: e => { st.ammo = e.target.value; playChanged(); } },
      el("option", { value: "" }, "— none —"),
      ...fits.map(a => el("option", { value: a.Item, ...(a.Item === cur ? { selected: 1 } : {}) },
        a.Effect ? `${a.Item} — ${a.Effect}` : a.Item))));
  }
  return wrap;
}

/* Firing state for a trait-mounted weapon (a Heavy Torso / No Head free mount).
 * Those aren't owned entries — they're derived from the heritage picks on every
 * recalc — so the magazine, mode and Gun-Kata flag live in play state, keyed by
 * the mount's label. Same shape firingModeControls expects of a weapon entry. */
function traitMountState(label) {
  const play = CHAR.play;
  const mounts = (play.trait_mounts = play.trait_mounts || {});
  return (mounts[label] = mounts[label] || {});
}

/* Gun-Kata rank, or 0. Level 2 is the one that matters here: "Can fire +1
   bullet (+1d for 1 ammo)". */
function gunKataRank() {
  const ma = (CALC.martial_arts || []).find(m => /^gun.?kata$/i.test(m.style || ""));
  return ma ? (+ma.rank || 0) : 0;
}

/* Gun-Kata is a pistol-and-SMG discipline, so the +1 bullet is only offered on
 * those — not on a rifle, a shotgun or a vehicle's autocannon.
 *
 * Tested against the weapon's Type TEXT rather than a fixed list of codes,
 * because the two sources spell it differently: the weapons table uses
 * "PistolLt" / "PistolMed" / "PistolHvy" / "SMG", while cyberguns carry prose
 * ("Palm Pistol", "Forearm SMG", "Heavy Pistol"). One test covers both, and
 * homebrew of either shape comes along for free. */
/* Accepts a weapon ROW where the caller has one, so the one-handed half of the
 * rule can be checked; a bare Type string (cyberguns, whose Hands column does
 * not exist) still works and counts as one-handed, which is correct for an
 * implanted gun. */
function gunKataFitsWeapon(rowOrType) {
  const row = (rowOrType && typeof rowOrType === "object") ? rowOrType : { Type: rowOrType };
  return /pistol|smg/i.test(String(row.Type || "")) && RULES.weaponHands(row) === 1;
}

/* ---- the "No Recoil" house rule's bonus dice (#61) --------------------------
 * Under that rule the gear that used to raise Recoil Capacity pays out bonus
 * dice instead. The engine says WHAT a gun's sources are worth and when each
 * one counts; these two decide which are live for the shot being set up, and
 * hand them to the same `bonuses` list the firing mode and Gun-Kata 2 use — so
 * they land in the dice chip, the Fire tooltip and the roller together, and the
 * number you click is the number you shoot with.
 *
 * Empty under the Classic rule, so neither the weapon rows nor the roller need
 * to know which rule is running. */
function noRecoilSourcesFor(row, calcRow) {
  const names = [...((calcRow || {}).mods || []), ...((calcRow || {}).integrated_mods || [])]
    .map(m => (m && typeof m === "object") ? m.name : m);
  return RULES.noRecoilBonuses((row || {}).Type, names, CALC.combat, RULES.weaponHands(row));
}

/* A "nonss" source is live the moment a mode other than SS is selected — that
 * is a fact about the shot, so the engine's number applies on its own. "braced"
 * is not: whether the bipod is actually deployed is a situation only the player
 * can declare, so it follows the Gun-Kata checkbox pattern (a per-weapon opt-in
 * on the entry) rather than being assumed on. */
function noRecoilLiveBonuses(sources, mode, entry) {
  const nonss = String(mode || "SS") !== "SS";
  return (sources || [])
    .filter(b => b.when === "braced" ? !!(entry && entry.braced) : nonss)
    .map(b => ({ label: b.when === "braced" ? `${b.label} braced` : b.label, dice: b.dice }));
}

/* Per-shot heat and its cap for an Energy weapon. The structured "Heat" /
   "Max Heat" columns win; failing those it parses the prose the core rows also
   carry ("Heat 3 / max 15"). Columns first because they're what the homebrew
   editor exposes — a custom weapon shouldn't have to phrase its Notes just so
   to get a working heat tracker. Null when the row states neither, which is a
   real answer: the Dazzleray has no heat rating at all. */
function heatSpec(row) {
  const per = parseInt(row && row.Heat, 10);
  const max = parseInt(row && row["Max Heat"], 10);
  if (Number.isFinite(per) && Number.isFinite(max)) return { per, max };
  const m = /heat\s*(\d+)\s*\/\s*max\s*(\d+)/i.exec((row && row.Notes) || "");
  return m ? { per: +m[1], max: +m[2] } : null;
}

/* A weapon with no firing mode still makes an attack test — a blade, a fist, a
 * thrown grenade — so it gets the same one-press roll the guns' Fire button
 * gives, minus the ammo. Returns "—" when there's nothing to roll (an untrained
 * trained-only skill), which is what the cell used to show for all of them. */
function attackButton(label, rs, opts = {}) {
  if (!rs || rs.locked || (rs.limitDice + rs.bonus) <= 0) return "—";
  const total = rs.limitDice + rs.bonus;
  return el("div", { class: "sh-fire-btns" },
    el("button", { class: "btn small",
      title: opts.title || (`Roll ${total}d6 — ${rs.why.join(" ")}`
        + (rs.bwhy.length ? `, bonus ${rs.bwhy.join(" + ")}` : "")),
      onclick: () => {
        // Melee/unarmed (opts.melee) prefers a Melee Exploit Action and only
        // reaches for a Simple Action once those are gone. Everything else
        // this button covers — thrown weapons, fixed-pool ranged implants
        // (Eye Laser, Snake's Spit) — isn't a melee/unarmed swing, so it
        // spends a Simple Action directly, same as any other shot fired.
        const spent = opts.melee ? spendMeleeAttack() : spendSimpleActions(1, `Attacking with ${label}`);
        if (!spent) return;
        openPoolRoller({ dice: rs.limitDice, bonus: rs.bonus,
          pool: rs.pool, label,
          note: opts.note
            || `${rs.skill}: ${rs.skillDice} skill`
               + (rs.acc ? ` + ${rs.acc} Accuracy` : "")
               + (rs.bonus ? ` + ${rs.bonus} bonus` : "") });
        playChanged();
      },
    }, "Attack"));
}

/* Aimed Fire: spend a Complex Action (2 Simple Actions) to line the shot up
 * properly. weaponRollSpec() normally folds a weapon's Accuracy into its
 * costly limit dice (limitDice = skillDice + acc) — Aimed Fire is the one
 * button that pulls Accuracy back OUT of that pool-costing count and grants
 * it as free bonus dice instead: same total dice, less pool spent, more time
 * taken. Not offered on Full Auto — emptying a magazine in a spray isn't an
 * aimed shot.
 *
 * `resource` is how the caller checks and pays whatever a shot actually
 * costs (a magazine round, a point of Heat) so ballistic and Energy weapons
 * can share this without either one being taught the other's bookkeeping:
 * { disabled, disabledTitle, spend() }. `kind` is an Exploit Action kind to
 * draw on before Simple Actions (e.g. "Rigging" for a drone/vehicle mount);
 * null (personal weapons) spends Simple Actions outright. `calcRow` is the
 * weapon's engine row for the recoil check — null means this gun doesn't
 * feed the character's recoil tracker (drone/vehicle mounts). */
function aimedFireButton(rollSpec, fireLabel, mode, resource, kind = null, calcRow = null) {
  if (!rollSpec || rollSpec.locked
      || (rollSpec.skillDice + rollSpec.bonus + rollSpec.acc) <= 0) return null;
  const faBlocked = mode === "FA";
  const blocked = faBlocked || resource.disabled;
  return el("button", { class: "btn small", disabled: blocked ? "1" : null,
    title: faBlocked ? "Full Auto can't be aimed — pick a different fire mode"
      : resource.disabled ? resource.disabledTitle
      : `Aimed Fire — a Complex Action; Accuracy (${rollSpec.acc}) becomes bonus dice `
        + "instead of costing pool, and steadies the gun (recoil back to 0)",
    onclick: () => {
      // No recoil check here, unlike Fire: taking the time to aim IS steadying
      // the weapon, so an unsteady gun is exactly what this button is for.
      if (!spendActionUnits(kind, 2, `Aimed Fire with ${fireLabel}`)) return;
      openPoolRoller({ dice: rollSpec.skillDice, bonus: rollSpec.bonus + rollSpec.acc,
        pool: rollSpec.pool, label: fireLabel,
        note: `${rollSpec.skill}: ${rollSpec.skillDice} skill`
          + (rollSpec.bonus ? ` + ${rollSpec.bonus} bonus (${mode})` : "")
          + (rollSpec.acc ? ` + ${rollSpec.acc} Accuracy (aimed — bonus, not limit)` : "") });
      // Stabilize on the way in, so resource.spend()'s addRecoil leaves only
      // this shot's own point behind rather than stacking on the old total.
      stabilizeRecoil(calcRow);
      resource.spend();
      playChanged();
    } }, "Aimed Fire");
}

/* ---------------------------------------------------------------- Twin Fire
 *
 * Two guns, one trigger pull each, at the same instant (#59). Offered only when
 * two hands each hold a ONE-HANDED pistol or SMG — the same "is this a gun you
 * can fight with in one hand" question Gun-Kata already asks, so it reuses
 * gunKataFitsWeapon rather than growing a third copy of the pistol|smg + 1H
 * test that would drift away from the other two.
 *
 * The trade the rule makes, and why each half is coded where it is:
 *
 *  - No Accuracy. weaponRollSpec() normally folds a weapon's Accuracy into its
 *    limit dice, so "no Accuracy bonus" is expressed by passing 0 for it rather
 *    than by subtracting afterwards — that keeps the pool cost honest too,
 *    since the pool only ever pays for limit dice.
 *  - −1 penalty die on each roll. Carried into the roller as extraPenalty so it
 *    is already applied when the panel opens; a player who had to remember to
 *    dial it in would sometimes not.
 *  - Two SEPARATE rolls, each out of the shooter's own pool (Finesse, via the
 *    Firearms skill) exactly as if two Fire buttons had been pressed. The
 *    roller is a singleton, so they are handed over one at a time via its queue.
 *  - One Simple Action for the pair, not two. This is the whole point of the
 *    manoeuvre and it is deliberately NOT scaled up for Full Auto the way the
 *    ordinary Fire button is: the issue prices Twin Fire at a flat one Simple
 *    Action for both rolls.
 *  - Recoil from BOTH guns, because both actually fired.
 *
 * Everything is charged UP FRONT, on the press: the action, both magazines and
 * both guns' recoil. The two rolls that follow are presentation only. That
 * ordering is what makes the queued second roll safe to leave unopened — the
 * character has already paid for the shot whether or not its dice get read.
 */
const TWIN_FIRE_PENALTY = 1;

/* One hand's contribution to a Twin Fire, built by the loadout while it already
 * has the weapon's row, mode and magazine in hand. Kept as plain data so the
 * bar below can live at top level instead of inside shOverview's closure. */
function twinFireRollSpec(h, i) {
  // Accuracy zeroed on purpose — see the header. Bonus dice (firing mode,
  // Gun-Kata, a No-Recoil-rule mod) are untouched: the rule takes away the
  // guns' Accuracy, not everything else the shot was going to get.
  const rs = weaponRollSpec(h.name, h.row.Type, 0, h.bonuses, h.row.Reach);
  if (!rs || rs.locked) return null;
  const wounded = woundPenalty().size > 0;
  return {
    dice: rs.limitDice, bonus: rs.bonus, pool: rs.pool,
    label: `Twin Fire: ${h.name}`,
    extraPenalty: TWIN_FIRE_PENALTY,
    penaltyLabel: wounded ? "Wound + Twin Fire" : "Twin Fire",
    seq: { i, n: 2 },
    note: `${rs.skill}: ${rs.skillDice} skill`
      + (rs.bonus ? ` + ${rs.bonus} bonus (${h.mode})` : "")
      + " — Twin Fire gives up this gun's Accuracy and takes a penalty die",
  };
}

/* The control itself. Returns null when the pair can't twin-fire at all (which
 * is what keeps it HIDDEN rather than merely greyed for every ordinary
 * loadout); returns a disabled control, with the reason in its title, when the
 * pair is right but the moment isn't — a mode mismatch, an empty magazine, an
 * untrained skill. Hidden vs disabled is the difference between "this doesn't
 * apply to you" and "this applies but not yet", and only the second is worth
 * taking up space. */
function twinFireBar(a, b) {
  const specA = twinFireRollSpec(a, 1);
  const specB = twinFireRollSpec(b, 2);
  // Both guns must be in the same fire mode. Two things can go wrong and they
  // are NOT the same problem: the guns may have no mode in common at all (a
  // fact about the weapons, and the issue's own "disable the option" case), or
  // they may share modes but be set to different ones right now (a fact about
  // the player's selects, fixable in two clicks). Say which.
  const shared = a.modes.filter(m => b.modes.includes(m));
  const sameMode = a.mode === b.mode && shared.includes(a.mode);
  const dry = a.loaded < a.cost || b.loaded < b.cost;
  // No Recoil house rule (#61): recoil isn't a stat under it, so Twin Fire
  // neither adds any nor says anything about it — the same silence the Recoil
  // counter, recoilBit and the Dossier line already keep.
  const recoilOn = RULES.recoilInPlay();
  const why =
      (!specA || !specB) ? "One of these guns can't be rolled — the skill is trained only"
    : !shared.length     ? `${a.name} and ${b.name} have no firing mode in common, `
                           + "so they can't be fired together"
    : !sameMode          ? "Both guns must be in the SAME fire mode — set each hand's "
                           + `mode select to one of: ${shared.join(", ")}`
    : dry                ? "Not enough rounds loaded in both guns for another shot"
    : null;
  const costBits = [
    "1 Simple Action for both rolls",
    `${a.cost} + ${b.cost} rounds`,
    recoilOn ? "recoil from both guns" : null,
  ].filter(Boolean);
  const btn = el("button", { class: "btn small sh-twinfire-btn",
    ...(why ? { disabled: "1" } : {}),
    title: why || `Fire ${a.name} and ${b.name} together in ${a.mode} — two separate `
      + `rolls, each without the gun's Accuracy and each at −${TWIN_FIRE_PENALTY} `
      + `penalty die. Costs ${costBits.join(", ")}.`,
    onclick: () => {
      // Recoil first and for BOTH guns, before anything is spent: a shot
      // refused because a gun is shaken loose must cost nothing, and that is
      // only true if the check happens ahead of the action and the rounds.
      // recoilBlocked alerts, so || short-circuits to one message, not two.
      if (recoilOn && (recoilBlocked(a.name, a.effRow) || recoilBlocked(b.name, b.effRow))) return;
      // Flat one Simple Action for the pair — see the header on why this is
      // not the Fire button's `mode === "FA" ? 2 : 1`.
      if (!spendSimpleActions(1, "Twin Fire")) return;
      a.entry.loaded = Math.max(0, a.loaded - a.cost);
      b.entry.loaded = Math.max(0, b.loaded - b.cost);
      if (recoilOn) { addRecoil(a.mode, a.effRow); addRecoil(b.mode, b.effRow); }
      // Both rolls are built and queued now, from the state as it was when the
      // trigger was pulled, so the second one can't be quietly re-priced by a
      // re-render happening between the first roll and the second.
      openPoolRoller({ ...specA, queue: [specB] });
      playChanged();
    } }, "Twin Fire");
  return el("div", { class: "sh-twinfire" + (why ? " off" : "") },
    el("div", { class: "sh-twinfire-bar" }, btn),
    el("div", { class: "sub sh-twinfire-note" },
      `Hand ${a.slot + 1} + Hand ${b.slot + 1} — ${a.name} & ${b.name}`
      + (sameMode ? ` in ${a.mode}` : "")));
}

/* Firing controls on each Overview weapon row.
 *
 * Ballistic weapons pick a firing mode -- its bonus dice are folded into the
 * dice chip beside it -- and track a magazine: Fire spends that mode's rounds,
 * Reload fills it. Rounds live on the weapon entry (like `mods` and `lo`) so
 * they survive a reload; absent means a full magazine.
 *
 * Energy weapons have no magazine. They're single-shot and run on Heat, stated
 * per shot and capped in their Notes, so they get a heat tracker instead of a
 * round count. Heat starts at 1. */
/* `label` names the thing being fired in the roller. It defaults to the entry's
 * own name, which is right for an owned weapon — but a cybergun's entry is the
 * augment that installed it ("Cybergun Installation") and a trait mount's is a
 * bare play-state record with no name at all, so both pass their own. */
/* `opts.braceOffered` puts a Braced checkbox beside the Gun-Kata one: under the
 * "No Recoil" house rule a Bi-pod is worth +1b, but only when the gun is
 * actually braced, and that is a situation the player declares (#61). */
function firingModeControls(w, r, calcRow, modes, mode, kataOffered = false, rollSpec = null,
                            label = null, opts = {}) {
  const fireLabel = label || w.name || "Attack";
  const ro = !!(activeTabObj() && activeTabObj().readonly);
  const wrap = el("div", { class: "sh-fire" });

  const optLabelFor = m => {
    const d = RULES.FIRING_MODES[m];
    return `${m} — ${d.name}${d.dice ? ` (+${d.dice}b)` : ""}`;
  };
  const modeSelect = (labelWithAmmo) => modes.length > 1 && !ro
    ? el("select", { class: "sh-fire-sel", title: "Firing mode",
        onchange: e => { w.mode = e.target.value; playChanged(); } },
        ...modes.map(m => el("option", { value: m, ...(m === mode ? { selected: 1 } : {}) },
          labelWithAmmo(m))))
    : el("span", { class: "sh-fire-mode", title: RULES.firingMode(mode).name }, mode);

  // Energy weapons carry no magazine -- Heat is the resource they spend -- so
  // they get a heat tracker rather than a round count. Most are single-shot,
  // but one that names real modes (the X-3 spins up to full auto) still picks
  // between them for the bonus dice.
  if (r.Type === "Energy") {
    const hs = heatSpec(r);
    const cur = () => (w.heat == null ? 1 : Math.max(0, Math.floor(+w.heat) || 0));
    wrap.append(modeSelect(optLabelFor));
    if (ro) wrap.append(el("span", { class: "sub" }, `Heat ${cur()}`));
    else wrap.append(miniCounter("Heat", cur, v => { w.heat = v; }, 0, hs ? hs.max : 99));
    wrap.append(el("span", { class: "sub" }, hs
      ? ` ${hs.per} per shot · max ${hs.max}${cur() >= hs.max ? " — overheated" : ""}`
      : " no heat rating listed"));
    // Energy weapons have no ordinary Fire button here — Heat is tracked by
    // hand above — but Aimed Fire still applies, spending a point of Heat
    // (when the row rates one) the same way Fire spends a round.
    if (!ro) {
      const overheated = !!(hs && cur() + hs.per > hs.max);
      const aimed = aimedFireButton(rollSpec, fireLabel, mode, {
        disabled: overheated,
        disabledTitle: "Not enough heat capacity left for another shot",
        spend: () => { if (hs) w.heat = cur() + hs.per; addRecoil(mode, calcRow); },
      }, null, calcRow);
      if (aimed) wrap.append(el("div", { class: "sh-fire-btns" }, aimed));
    }
    return wrap;
  }

  const maxAmmo = Math.max(0, parseInt(calcRow.Ammo ?? r.Ammo, 10) || 0);
  const loaded = w.loaded == null ? maxAmmo
    : Math.max(0, Math.min(Math.floor(+w.loaded) || 0, maxAmmo));
  const md = RULES.firingMode(mode);
  wrap.append(modeSelect(m => {
    const d = RULES.FIRING_MODES[m];
    return `${m} — ${d.name} (${d.dice ? `+${d.dice}b, ` : ""}${d.ammo} rd${d.ammo === 1 ? "" : "s"})`;
  }));

  if (!maxAmmo) return wrap;
  const oneshot = RULES.weaponIsOneshot(r);
  // Gun-Kata 2 rides on whichever mode is selected: one more bullet, one more
  // die. Offered per weapon so it can be left off when you don't want the cost.
  const kataOn = kataOffered && !!w.kata;
  const cost = md.ammo + (kataOn ? 1 : 0);
  const dry = loaded < cost;
  wrap.append(el("span", { class: "sh-fire-mag" + (dry ? " dry" : "") },
    `${loaded}/${maxAmmo} rds`));
  if (kataOffered) {
    wrap.append(el("label", { class: "sh-fire-kata",
      title: "Gun-Kata 2: fire +1 bullet for +1 die" },
      el("input", { type: "checkbox", ...(kataOn ? { checked: 1 } : {}), ...(ro ? { disabled: "1" } : {}),
        onchange: e => { w.kata = e.target.checked; playChanged(); } }),
      el("span", {}, "Gun-Kata")));
  }
  if (opts.braceOffered) {
    wrap.append(el("label", { class: "sh-fire-kata",
      title: "Bi-pod deployed: +1 bonus die while braced" },
      el("input", { type: "checkbox", ...(w.braced ? { checked: 1 } : {}), ...(ro ? { disabled: "1" } : {}),
        onchange: e => { w.braced = e.target.checked; playChanged(); } }),
      el("span", {}, "Braced")));
  }
  if (ro) return wrap;
  // Fire and Reload sit together on their own line — they're the pair you reach
  // between, and the mode select and round count above are what you set once.
  const rollable = rollSpec && !rollSpec.locked
    && (rollSpec.limitDice + rollSpec.bonus) > 0;
  wrap.append(el("div", { class: "sh-fire-btns" },
    el("button", { class: "btn small", disabled: dry ? "1" : null,
      title: dry ? `Not enough rounds loaded for ${mode} (needs ${cost})`
                 : `Fire ${mode} — spends ${cost} round${cost === 1 ? "" : "s"}`
                   + (kataOn ? " (includes the Gun-Kata bullet)" : "")
                   + (rollable
                       ? ` and loads ${rollSpec.limitDice + rollSpec.bonus}d6 in the roller`
                       : ""),
      onclick: () => {
        // Recoil first: a gun that's shaken loose can't fire at all, so it
        // must not cost actions or ammunition on the way to being refused.
        if (recoilBlocked(fireLabel, calcRow)) return;
        // Full Auto is a Complex Action (2 Simple Actions); every other mode
        // is Simple. Checked — and refused with a warning — before anything
        // else moves, same as a dry magazine already disables the button.
        if (!spendSimpleActions(mode === "FA" ? 2 : 1, `Firing ${mode}`)) return;
        // Same dice the chip beside it would load — firing IS the attack test,
        // so it spends the rounds and opens the roll in one press.
        if (rollable)
          openPoolRoller({ dice: rollSpec.limitDice, bonus: rollSpec.bonus,
            pool: rollSpec.pool, label: fireLabel,
            note: `${rollSpec.skill}: ${rollSpec.skillDice} skill`
              + (rollSpec.acc ? ` + ${rollSpec.acc} Accuracy` : "")
              + (rollSpec.bonus ? ` + ${rollSpec.bonus} bonus (${mode})` : "") });
        w.loaded = Math.max(0, loaded - cost);
        addRecoil(mode, calcRow);
        playChanged();
      } }, "Fire"),
    // A sealed one-shot is its own magazine: once it's fired there is nothing to
    // put back, so the button stays but says why it can't be pressed rather than
    // disappearing and leaving the row looking different for no stated reason.
    el("button", { class: "btn small",
      disabled: (oneshot || loaded >= maxAmmo) ? "1" : null,
      title: oneshot ? RULES.ONESHOT_NOTE
        : "Reload to a full magazine"
          + (/crossbow/i.test(fireLabel) ? " — a Complex Action to recock" : "")
          + (r.cybergun && !r.Reloadable ? " — implanted; not meant to be done mid-fight" : "")
          + ". Also steadies the gun (recoil back to 0).",
      onclick: () => {
        if (oneshot) return;
        // A cybergun's magazine lives inside the arm — swapping it isn't a
        // pocket reload, so this makes the player say so explicitly rather
        // than silently topping off an implant mid-fight. The Reload Port
        // variant pays extra ZR specifically to skip this — see r.Reloadable.
        if (r.cybergun && !r.Reloadable
            && !confirm(`${fireLabel} cannot be reloaded during combat. Reload anyway?`)) return;
        const reloadCost = /crossbow/i.test(fireLabel) ? 2 : 1;
        if (!spendSimpleActions(reloadCost, `Reloading ${fireLabel}`)) return;
        w.loaded = maxAmmo;
        // A fresh magazine comes with the gun re-seated, so reloading steadies
        // it for free — no separate Stabilize, and no shot to add recoil back.
        // After the spend, so a reload refused for lack of actions doesn't
        // hand out the stabilize anyway.
        stabilizeRecoil(calcRow);
        playChanged();
      } }, "Reload"),
    aimedFireButton(rollSpec, fireLabel, mode, {
      disabled: dry,
      disabledTitle: `Not enough rounds loaded for Aimed Fire (needs ${cost})`,
      spend: () => { w.loaded = Math.max(0, loaded - cost); addRecoil(mode, calcRow); },
    }, null, calcRow)));
  return wrap;
}

/* The compact skill-dice chip a weapon shows -- "(5d +3b)", click to roll.
 *
 * Hoisted out of shOverview so the Gear tab can use the same one. Gear was
 * rendering weaponRollParts' prose instead ("Roll Finesse 12d - Firearms 4"),
 * which spells out the pool as well as the skill and reads as a different,
 * busier stat than the chip beside the identical weapon on the Overview.
 */
// A specialization is +1 on what it covers and −1 on everything else the
// skill rolls, so it resolves per weapon rather than as the flat −1/+1 pair
// the Skills tab shows. The chip shows the LIMIT (skill + Accuracy) beside
// the free dice, because that's the line that matters: the limit comes out
// of a pool and the bonus dice don't.
function weaponSkillDice(name, type, accuracy, bonuses = [], reach = null) {
  const rs = weaponRollSpec(name, type, accuracy, bonuses, reach);
  if (!rs) return null;
  const { skill, limitDice, bonus, spec, why, bwhy } = rs;
  // The bladed cyber implants roll Cybertech Combat, which is trained only —
  // with no dice in it the weapon can't be used at all, so say so rather than
  // showing an Accuracy-only dice count that implies you can swing it.
  if (rs.locked)
    return el("b", { class: "wpn-dice locked",
      title: `${skill} is trained only — needs at least 1 die in the skill or its group` },
      "(trained only)");
  // Click the chip to load the roller: limit dice go in as skill dice (they
  // cost pool), free dice go in the bonus row.
  return rollable(el("span", { class: "wpn-dice-set" },
    el("b", { class: "wpn-dice" + (spec.delta ? (spec.delta > 0 ? " spec-on" : " spec-off") : ""),
      title: why.join(" ") }, `(${limitDice}d`),
    bonus
      ? el("b", { class: "wpn-bonus", title: `Bonus dice: ${bwhy.join(" + ")}` },
          ` +${bonus}b`)
      : null,
    el("b", { class: "wpn-dice" }, ")")),
    // Weapon name alone in the header — it's a panel title, and the skill
    // that made the number is one line down in the hint.
    { dice: limitDice, bonus, label: name, pool: rs.pool,
      note: `${skill}: ${rs.skillDice} skill`
        + (rs.acc ? ` + ${rs.acc} Accuracy` : "")
        + (bonus ? ` + ${bonus} bonus` : ""),
      title: `Roll ${limitDice + bonus}d6 — ${why.join(" ")}`
        + (bwhy.length ? `, bonus ${bwhy.join(" + ")}` : "") });
}

/* Concealment (#62): whether the guns you are carrying read as guns.
 *
 * The check is the summed Conceal of every carried weapon against Subterfuge --
 * one rating covering the whole load, not a per-weapon test, because an
 * observer sees the silhouette all at once. Conceal here is the EFFECTIVE
 * rating the engine already folded mods into, so a bulky scope shows up.
 *
 * Cyberguns are deliberately excluded: they are inside the body, and nothing on
 * the surface is what Subterfuge is hiding. Returns null when the character is
 * carrying nothing, since there is no question to answer. */
function concealCallout() {
  const carried = allWeapons().filter(w => w.equipped !== false);
  if (!carried.length) return null;
  // Resolved by position, not by name: two identical guns are two silhouettes
  // and both have to count. See calcRowFor for why a name-find is wrong here.
  const conceal = w => toIntSafe(calcRowFor(w, carried).Conceal);
  const total = carried.reduce((n, w) => n + conceal(w), 0);
  const sub = ((CALC.skills || {}).Subterfuge || {}).final || 0;
  // Subterfuge 0 can't cover anything, so any bulk at all is showing. Guarded
  // rather than divided, because total/0 is Infinity and reads as a bug.
  const hidden = total === 0 || (sub > 0 && total / sub <= 1);
  return el("div", { class: "sh-conceal" + (hidden ? "" : " bad"),
      title: carried.map(w => `${w.name} ${conceal(w)}`).join(" · ") },
    el("span", { class: "k" }, "Conceal"), " ",
    el("b", {}, `${total} / ${sub}`),
    el("span", { class: "sub" }, hidden
      ? "Carried weapons are hidden from casual observers"
      : "Weapons not concealed"));
}

/* One-time special case (player request, not a general homebrew mechanic):
 * the M31-a1G is the under-mounted grenade launcher that belongs to the
 * M31-a1 Advanced Combat Weapon itself -- so even though the M31-a1 is
 * two-handed, holding the G in the second hand while the base rifle is in
 * the first is allowed. No other weapon pairing gets this; it isn't data
 * driven (no Hands="2H+companion" column) on purpose -- it's one named
 * exception to the general rule, not a system. */
const TWO_HANDED_COMPANION = {
  "Militech M31-a1 Advanced Combat Weapon": "Militech M31-a1G",
};

function shOverview(body) {
  const play = CHAR.play;
  const econ = kismetEcon();
  // A shared view reads the same Overview but edits nothing on it.
  const ro = !!(activeTabObj() && activeTabObj().readonly);

  // Rules problems that survive Finalize. Creation budgets stop applying, but
  // an illegal body or an empty wallet doesn't stop being illegal — the engine
  // reports the reduced set once `finalized` is true, and this is where it
  // lands. Silent for a clean character, which is the usual case.
  if (CALC.errors.length || CALC.warnings.length) {
    const list = el("div", { class: "card sh-card sh-validity" },
      el("h3", {}, "Needs attention"),
      ...CALC.errors.map(e => el("div", { class: "sh-advrow", style: "color:var(--bad)" }, "✕ " + e)),
      ...CALC.warnings.map(w => el("div", { class: "sh-advrow", style: "color:var(--manon)" }, "⚠ " + w)));
    body.append(list);
  }

  // dossier warnings (Replicant illegality, Amp powers offline, …)
  for (const note of dossierNotes().slice(0, 2))
    body.append(el("div", { class: "sh-callout" }, "⚠ ", note));
  // Replicants have a fixed remaining lifespan, rolled once and ticked down.
  const lifespan = replicantLifespanTracker();
  if (lifespan) body.append(lifespan);
  // The Conditional Effects panel and the doses banner used to sit here, folded.
  // Both now live in the header's "Running now" popover, whole: neither had any
  // business being Overview-only, because you switch an effect on from what the
  // Augments and Gear tabs gave you and you take a dose from the Gear tab, so
  // Overview was an arbitrary parking spot for both. They went from one tab and
  // zero clicks to ten tabs and one click. (Enhanced Senses made the same trip
  // earlier, to a header tile.) The pool tiles still carry each switched-on
  // effect's dice at zero clicks, so what moved is the reason, not the number.

  // --- kismet + pools
  const kismetRow = el("div", { class: "sh-kismet" },
    el("span", { class: "chip magic" }, `Kismet ${play.kismet}`),
    el("span", { class: "chip" }, `Earned ${play.kismet_earned}`),
    el("span", { class: "chip" }, `Boons ${econ.regularsAvail}`),
    el("span", { class: "chip" }, `Major ${econ.majorsAvail}`),
    el("span", { class: "sh-kismet-btns" },
      counterBtn("+ Award", () => {
        const n = parseInt(prompt("Award how much Kismet?", "1") ?? "", 10);
        if (n > 0) { awardKismet("Quick award", n); playChanged(); }
      }, "good"),
      counterBtn("Kismet tab →", () => { sheetTab = "kismet"; renderSheet(); window.scrollTo(0, 0); })));

  // attributes moved down here — the header now belongs to the pool tiles
  const attrsRow = el("div", { class: "sh-attrs" });
  for (const [full, abbr] of ATTR_ABBR) {
    const a = CALC.attributes[full];
    // The cap rides the value as a superscript — it reads as "4 out of 20"
    // without a separator competing for width, and it stays tied to the number
    // it qualifies. Turns red at the cap so being maxed reads without doing the
    // comparison. NOTE: `.v` now contains the cap, so anything reading the
    // value out of the DOM wants its first child text node, not textContent.
    attrsRow.append(el("div", {
      // attr-<name> carries the per-attribute colour (see --attr-* in style.css)
      class: `sh-attr attr-${full.toLowerCase()}` + (a.final >= a.max ? " at-max" : ""),
      title: `${full} ${a.final} of a maximum ${a.max}`
        + (a.adjust ? ` (${a.adjust > 0 ? "+" : ""}${a.adjust} from augments and gear)` : ""),
    },
      el("div", { class: "k" }, abbr),
      el("div", { class: "v" }, String(a.final),
        el("span", { class: "cap" }, String(a.max))),
      a.adjust ? el("div", { class: "adj" }, (a.adjust > 0 ? "+" : "") + a.adjust) : null));
  }
  // Ghost Rating rides the attribute line: it's a standing figure you read off
  // the character, not a play meter, and it was the least-earning header chip.
  // Same box as the six, marked `ghost` so its colour says it isn't one of them.
  attrsRow.append(el("div", { class: "sh-attr ghost",
    title: "Ghost Rating — the dice you roll to stay off the grid" },
    el("div", { class: "k" }, "GHOST"),
    el("div", { class: "v" }, CALC.zoetics.ghost_rating || "2d6")));
  // The ZR casting penalty keeps Ghost company for the same reason: it's a
  // standing figure about this character, not something you consult every round.
  // Conditional, and deliberately so — under the house rule gear ZR isn't a
  // budget but a live −1d-per-point penalty on Channeling, Conjuring and
  // Sorcery. Same test the Magic tab uses (houserule + not Hedge) plus "and
  // it's actually biting", so it appears exactly when it means something and a
  // mundane never sees it at all.
  const zrCastPen = Math.floor(CALC.zoetics.gear_zr);
  if (RULES.houseRule("zr") === "houserule"
      && CALC.magic.type !== "Hedge" && zrCastPen > 0) {
    attrsRow.append(el("div", { class: "sh-attr zr-pen",
      title: `${CALC.zoetics.gear_zr} `
        + `${CALC.zoetics.gear_zr === 1 ? "point" : "points"} of gear/weapon ZR`
        + " — −1d per full point on Channeling, Conjuring and Sorcery" },
      el("div", { class: "k" }, "ZR CAST"),
      el("div", { class: "v" }, `−${zrCastPen}d`)));
  }
  // The clicked pool's skills go ABOVE the attributes, next to the pool tiles
  // that opened them — the list is the answer to the click, and pushing it under
  // the attribute boxes put it further from the thing you just pressed.
  const poolCard = el("div", { class: "card sh-card" }, kismetRow);
  if (expandedPool) poolCard.append(poolSkillList(expandedPool));
  poolCard.append(el("h4", { class: "sh-h4" }, "Attributes"), attrsRow);

  const c = CALC.combat;
  /* The Combat card stood here and is gone. It had become a catch-all: fourteen
   * lines with nothing in common except that each was a derived number nobody
   * had found a better home for, several of them read-only copies of a live
   * control elsewhere on the same screen.
   *
   * Every line went somewhere it belongs rather than being dropped:
   *
   *   Move, Alt movement       -> the Move header chip and its popover (#52)
   *   Armor B/I, Max B/Min I   -> the Armor header chip and its popover (#51)
   *   Recoil capacity          -> foot of the Finesse card + Dossier Notes (#50)
   *   Martial art              -> "In your stats" on the Martial Arts card
   *   Infusions applied        -> "Applied" on the Speaker Infusions card
   *   Cover, Cover (drone)     -> the Dodge card, beside what they modify
   *   Bling                    -> the Etiquettes card; it IS an etiquette bonus
   *   Simple + exploit actions -> already live on "Actions This Round", with
   *                               counters; the copies here were strictly worse
   *   Dodge bonus              -> the Dodge card already states it and rolls it
   *   Soak bonus               -> the Condition card's Soak button already
   *                               states it and rolls it
   *   Carried weight           -> the Gear tab's "Carried load", which also
   *                               weighs it against Strength and warns
   *
   * The rule that decided each one: a number belongs next to the thing you do
   * with it. Cover belongs by the Dodge roll, Bling by the Etiquettes it
   * raises, recoil by the Finesse dice you throw with it. */
  // Enhanced Senses closes the card: everything the character can perceive that
  // an unaugmented person can't, gathered from heritage, chrome, carried gear
  // and any drone that's out. It sits at the bottom because it's a reference
  // you consult when the lights go off, not a number you read every round —
  // and it's absent entirely for a character with ordinary eyes and ears.
  // --- drones on station, sized to sit in the card flow beside Dodge Dice and
  // Combat rather than as a full-width band. The hotseat unit gets a compact
  // stat block (the full Unit|Stats|Attachments table is a Rigging-tab width);
  // every deployed unit's passive rider is listed under it.
  const onStation = deployedUnits();
  const stationCard = onStation.length
    ? (() => {
        const card = el("div", { class: "card sh-card" }, el("h3", {}, "Drones on Station"));
        const seat = onStation.find(d => d.hotseat);
        if (seat) {
          const cfg = RIG_UNIT_CFG[seat.table];
          const r = DATA.tables[seat.table].find(x => x[cfg.nameKey] === seat.u.name) || {};
          const { statMods } = unitAttachments(cfg, seat.u);
          const ball = toInt(r.Ballistic) + statMods.ballistic;
          const imp = toInt(r.Impact) + statMods.impact;
          const bodyMax = Math.max(0, toInt(r.Body) + statMods.body);
          const st = (CHAR.play.rigging.units || {})[unitStateKey(seat.table, seat.u)] || {};
          card.append(el("div", { class: "sh-h4", style: "margin:6px 0 2px" },
            (seat.u.label || seat.u.name),
            el("span", { class: "sh-tag", style: "margin-left:6px" }, "hotseat")));
          if (seat.u.label) card.append(el("div", { class: "sub" }, seat.u.name));
          // .filter(Boolean), not a bare append: Element.append() stringifies a
          // null argument into the literal word "null" on the page.
          card.append(...[
            statLine("Move", String(r.Move || "—")
              + (statMods.infusion_move ? ` +${statMods.infusion_move}m` : "")),
            statLine("Handling", String(r.Handling ?? "—")),
            statLine("Body", String(bodyMax) + (statMods.body ? ` (base ${r.Body})` : "")),
            (ball || imp) ? statLine("Armor B / I", `${ball} / ${imp}`) : null,
            statLine("Hardening", String(unitHardening(r, statMods, seat.key))),
            bodyMax ? statLine("Damage",
              `${Math.min(toInt(st.physical), bodyMax)} phys · `
              + `${Math.min(toInt(st.integrity), bodyMax)} integrity`) : null,
            (seat.u.weapons || []).length
              ? statLine("Weapons", seat.u.weapons.map(sublistName).join(" · ")) : null,
          ].filter(Boolean));
        }
        const riders = onStation
          .map(d => ({ d, effect: unitPassiveEffect(d.table, d.u) }))
          .filter(x => x.effect);
        if (riders.length) {
          card.append(el("div", { class: "sh-h4", style: "margin:8px 0 2px" }, "Passive while deployed"));
          riders.forEach(({ d, effect }) => card.append(el("div", { class: "stat-line" },
            el("span", { class: "sub", style: "white-space:nowrap" }, d.u.label || d.u.name),
            el("span", { style: "text-align:right;color:var(--manon)" }, effect))));
        }
        if (!seat && !riders.length)
          card.append(el("p", { class: "hint" },
            `${onStation.length} deployed · none carries a passive effect. Tick `
            + "Hotseat on the Rigging tab to bring a unit's stats up here."));
        else if (riders.length)
          card.append(el("p", { class: "hint" }, "Applied at the table, not in the numbers above."));
        return card;
      })()
    : null;

  // --- martial arts combat effects: every unlocked level, grouped by style
  const maStylesWithLevels = (CALC.martial_arts || []).filter(m => m.levels.length);
  const maCard = maStylesWithLevels.length
    ? el("div", { class: "card sh-card" },
        el("h3", {}, "Martial Arts"),
        ...maStylesWithLevels.flatMap(m => [
          el("div", { class: "sh-h4", style: "margin:6px 0 2px" }, m.style),
          ...m.levels.map(lvl => el("div", { class: "stat-line" },
            el("span", { class: "sub", style: "white-space:nowrap" }, `L${lvl.Level}`),
            el("span", { style: "text-align:right" }, lvl.Effect || ""))),
        ]),
        // Which of those level effects the engine actually folded into a number.
        // The levels above are the rules as written; this is what the sheet did
        // with them, and the gap between the two is worth being able to see.
        (c.martial_notes && c.martial_notes.length)
          ? el("p", { class: "hint" }, "In your stats: " + c.martial_notes.join(" · "))
          : null)
    : null;

  // --- active infusions: every placed spirit, marked by whether its effect was
  // folded into the derived stats or has to be applied situationally at the table.
  // An effect can be both (Moryana: "+2 Brawn Pool, +2 I armor" is fully in
  // stats; Terra Factorem's "+1 to I armor, +2d to melee attacks" is partly).
  const infusionList = CALC.infusions || [];
  const infCard = infusionList.length
    ? el("div", { class: "card sh-card" },
        el("h3", {}, "Speaker Infusions"),
        ...infusionList.map(inf => el("div", { class: "stat-line" },
          el("span", { class: "sub", style: "white-space:nowrap" },
            `${inf.slot} · ${inf.spirit}`),
          el("span", { style: "text-align:right" }, inf.effect || "—",
            el("span", { class: "sh-tag", style: "margin-left:6px" },
              infusionAppliedLabel(inf.spirit))))),
        // The parsed list of what actually moved a number, which is the half of
        // "in stats" a player can check against their own arithmetic.
        (CALC.infusion_mods && CALC.infusion_mods.applied.length)
          ? el("p", { class: "hint" }, "Applied: "
              + CALC.infusion_mods.applied.map(a => `${a.text} (${a.source})`).join(" · "))
          : null,
        el("p", { class: "hint" },
          "“In stats” effects are already counted in the numbers above. "
          + "“Situational” ones apply at the table — they can't be folded into a single figure."))
    : null;

  // Flat card list in a balanced multi-column flow (see .sh-ov-grid): columns
  // fill to equal height and reflow 3→2→1 by width, so no column is overloaded.
  //
  // Actions This Round heads the middle column. The flow balances by height, so
  // being second in the list wouldn't put it there — it needs an explicit
  // column break, which is what .sh-col-break is. Everything before it fills
  // column one; Actions starts column two.
  // Only the pool card precedes the break. Everything before a forced break is
  // still balanced across the columns ahead of it, so leaving Condition there
  // too pushed Actions into column THREE — pools and Condition took one column
  // each. One card before the break puts Actions at the head of column two,
  // which is where it was asked for.
  // Three columns, pinned by break-before rather than left to the flow (#83):
  // Attributes/Skills fill column one; Running Now heads column two with
  // Actions under it; Condition heads column three. Initiative and Dodge are
  // not here -- they moved to the header band, reachable from every tab.
  const actions = actionsCard();
  const running = runningNowPanel();
  running.classList.add("sh-col-break");
  const cond = conditionCard();
  cond.classList.add("sh-col-break");
  body.append(el("div", { class: "sh-ov-grid" },
    ...[poolCard, running, actions, cond,
        infCard, stationCard, maCard].filter(Boolean)));

  /* The Heritage Traits card used to sit here, on the grounds that a Bat's
   * Echolocation shouldn't be buried on the Notes tab. It isn't buried any
   * more: the header's abilities band carries every trait with its effect and
   * is visible from all ten tabs, which is strictly better than one card on
   * one of them. The full table is still on Notes for anyone who wants it laid
   * out in rows. Three copies of the same six words was two too many. */

  // --- equipped weapons (+ mods) and worn armor, mirrored from the Gear tab
  const weaponsAll = allWeapons(), armorAll = allArmor();
  const equippedWeapons = weaponsAll.filter(w => w.equipped !== false);
  const cyberguns = equippedCyberguns();
  const wornArmor = armorAll.filter(a => a.active !== false);
  const grantedWeapons = CALC.combat.granted_weapons || [];
  const traitGear = CALC.combat.trait_gear || [];
  // Ammo owned (chargen gear + anything bought in play), merged by name so one
  // ammo type reads as a single stack of uses. Ordered as the tables list it.
  const ammoOnHand = (() => {
    const byName = new Map();
    for (const g of allGear()) {
      const row = DATA.tables.misc_gear.find(x => x.Item === g.name);
      if (!row || !(row.Class || "").startsWith("Ammo")) continue;
      const seen = byName.get(g.name);
      if (seen) seen.uses += (g.qty || 0);
      else byName.set(g.name, { name: g.name, row, uses: g.qty || 0 });
    }
    return [...byName.values()];
  })();
  if (equippedWeapons.length || cyberguns.length || wornArmor.length
      || grantedWeapons.length || traitGear.length || ammoOnHand.length
      || (CALC.combat.armor_sources || []).length) {
    /* The dice you actually roll to attack with this weapon, shown next to its
     * type: rank in the mapped skill (CALC .final already folds in the untrained
     * group fallback, so Unarmed 4 shows Melee Weapons as 2) plus the weapon's
     * own Accuracy. Melee rows list Reach and carry no Accuracy, so those come
     * out as the bare skill. Returns null when nothing maps, so it can be
     * dropped straight into el(). */
    const loadout = el("div", { class: "card sh-card" }, el("h3", {}, "Loadout"));

    // Natural / implanted / power-granted weapons (Hand Razors, Spurs, Fangs,
    // Iron Fist, an Eye Laser) lead the Loadout: they're the things that are
    // always on you, can't be dropped or taken off you, and are what you're
    // left holding when everything else is gone. Damage and Reach are
    // Strength-derived, so they're computed rather than read off a row.
    //
    // Cyberguns join this table rather than the carried-weapon Hands section
    // below: an implanted gun isn't picked up or put down, so it doesn't
    // compete for a hand slot either. Column 4 is polymorphic -- a bare
    // Attack button for a claw or blade, full firingModeControls (magazine,
    // mode select, Gun-Kata) for a cybergun -- which is why this table now
    // carries an Ammo column the natural-weapon rows simply leave blank.
    if (grantedWeapons.length || cyberguns.length) {
      const gt = el("table");
      const gro = ro;
      gt.append(el("tr", {}, el("th", {}, "Natural / cyber weapon"),
        el("th", {}, "Stats"), el("th", {}, "Source"),
        gro ? null : el("th", {}, ""), gro ? null : el("th", {}, "Ammo")));
      // These are attacks made with the body, so they resolve against the
      // "Natural" pseudo-type (Unarmed Combat) unless weaponSkillName knows the
      // name -- the bladed implants roll Cybertech Combat instead.
      // `gw.stats` is a preformatted line (Snake's ranged Spit), so it's left be.
      // `gw.dice` is a fixed pool the implant supplies itself (Eye Laser): show
      // that number instead of asking for a skill rating it doesn't roll off,
      // and let `kind`/`note` replace the Melee/Reach framing that doesn't fit.
      grantedWeapons.forEach(gw => {
        const dice = gw.dice != null
          ? el("b", { class: "wpn-dice", title:
              `${gw.dice} dice — a fixed pool from the implant, not a skill rating` },
              `(${gw.dice}d)`)
          : weaponSkillDice(gw.name, "Natural", 0, [], gw.reach);
        // Same one-press roll the equipped weapons get, off whichever number
        // this row is showing: a skill rating for claws and blades, or the
        // implant's own fixed pool, which rolls off no skill and so spends none
        // of a pool unless you pick one in the roller.
        const rs = gw.dice != null
          ? { skillDice: Math.max(0, +gw.dice || 0), bonus: 0, pool: "", locked: false,
              skill: "", why: [`${gw.dice} dice from the implant`], bwhy: [] }
          : weaponRollSpec(gw.name, "Natural", 0, [], gw.reach);
        // reach is only set on genuine melee/unarmed entries (claws, bio-
        // blades, Iron Fist); the fixed-pool ranged implants (Eye Laser) and
        // stats-only ranged natural attacks (Snake's Spit) leave it unset.
        const meleeAttack = gw.reach != null;
        const attack = gro ? null : el("td", {},
          attackButton(gw.name, rs, gw.dice != null
            ? { note: `${gw.dice} dice — a fixed pool from the implant, not a skill rating`,
                title: `Roll ${gw.dice}d6 — fixed pool from ${gw.source}`, melee: meleeAttack }
            : { melee: meleeAttack }));
        gt.append(el("tr", {},
          el("td", {}, el("b", {}, gw.name)),
          gw.stats
            ? el("td", { class: "sub" }, gw.stats)
            : el("td", { class: "sub" }, gw.kind || "Melee", dice,
                ` · DMG ${gw.damage}` + (gw.note ? ` · ${gw.note}` : ` · Reach ${gw.reach}`)),
          el("td", { class: "sub" }, gw.source),
          attack, gro ? null : el("td", { class: "sub" }, "—")));
      });
      cyberguns.forEach(cg => {
        const g = cg.gun;
        // A cybergun loads ammo and runs a magazine like any other firearm —
        // the implant states its own Ammo and Modes. Both the choice and the
        // round count live on the source augment entry, since the gun row
        // itself is shared data.
        //
        // `Type` used to be hardcoded to the literal string "Cybergun" here,
        // which was doing two jobs that don't agree: firingModeControls reads
        // it to gate the "implanted; not meant to be done mid-fight" reload
        // confirm, but RULES.ammoFitsWeapon and AMMO_FITS read the SAME field
        // expecting a real gun-type string ("Shotgun", "Rifle", …) — the same
        // vocabulary the cyberguns table's own Type column already uses (g.Type
        // is literally "Shotgun" for the shotgun option). With Type pinned to
        // "Cybergun", `AMMO_FITS["Buckshot"] = row => row.Type === "Shotgun"`
        // could never match ANY cybergun, including the one kind of cybergun
        // Buckshot is actually meant for. `cybergun` is the flag that job
        // needed all along; Type carries the gun's real archetype instead, and
        // "Firing modes" is filled in too so mode-gated ammo (Tracer Rounds
        // needs FA) reads real data instead of the no-modes-listed fallback of
        // ["SS"] that made it just as unreachable.
        const cgRow = { Type: g.Type, cybergun: true, Weapon: cg.name, Damage: g.Dmg,
          Ammo: g.Ammo, "Firing modes": g.Modes, Reloadable: cg.reloadable };
        const ammo = loadedAmmoFor(cg.src, cgRow);
        const base = { acc: g.Acc, damage: g.Dmg, pen: g.Pen, bar: g.Bar ?? "" };
        const shot = RULES.applyAmmoStats(base, ammo.mods);
        // An implanted gun takes no weapon mods, so the loaded round is the
        // only thing that moves its magazine, Hardening or modes (#86). The
        // adjusted magazine is written back onto cgRow, which is the row the
        // fire controls read their round count from.
        const cgAmmoRow = ammo.row
          ? RULES.applyAmmoToRow({ Ammo: g.Ammo, Hardening: RULES.hardeningOf(g) }, g, ammo.mods)
          : { Ammo: g.Ammo, Hardening: RULES.hardeningOf(g) };
        cgRow.Ammo = cgAmmoRow.Ammo;
        const cgModes = RULES.ammoFiringModes(RULES.weaponFiringModes(g),
          ammo.row ? ammo.mods : null);
        const cgMode = cgModes.includes(cg.src.mode) ? cg.src.mode : (cgModes[0] || "");
        const cgMd = cgMode ? RULES.firingMode(cgMode) : { dice: 0, ammo: 0 };
        const cgMag = Math.max(0, parseInt(cgAmmoRow.Ammo, 10) || 0);
        // Cybergun Types are prose ("Palm Pistol", "Forearm SMG"), which the
        // same test reads — a Shotgun cybergun is correctly left out.
        const cgKataOffered = gunKataRank() >= 2 && cgMag > 0 && cgModes.length > 0
          && gunKataFitsWeapon(g.Type);
        const cgBonuses = [];
        if (cgMd.dice) cgBonuses.push({ label: cgMode, dice: cgMd.dice });
        if (cgKataOffered && cg.src.kata) cgBonuses.push({ label: "Gun-Kata", dice: 1 });
        // No Recoil (#61). An implanted gun takes no weapon mods, so only the
        // character-wide sources reach it -- and a Palm Pistol is still a pistol
        // as far as Gun-Kata is concerned (RULES.weaponTypeIs).
        cgBonuses.push(...noRecoilLiveBonuses(
          RULES.noRecoilBonuses(g.Type, [], CALC.combat), cgMode, cg.src));
        const bit = (label, key) => el("span",
          (ammo.row && String(shot[key]) !== String(base[key]))
            ? { class: "wpn-ammo-mod", title: `${ammo.name} ammo` } : {},
          `${label} ${shot[key]}`);
        // Same marking for the stats that live on the row rather than the shot.
        const bitOf = (label, shown, was) => el("span",
          String(shown) !== String(was)
            ? { class: "wpn-ammo-mod", title: `${ammo.name} ammo` } : {},
          `${label} ${shown}`);
        // Braced against the arm it's built into, so its recoil rating is
        // its own (doubled) figure rather than the character's bare one.
        // Passed as the calcRow so the Fire button's recoil check reads the
        // same number the stat line prints.
        const cgRecoil = ammo.row
          ? RULES.applyAmmoToRow(RULES.cybergunRecoil(g, CALC.combat), g, ammo.mods)
          : RULES.cybergunRecoil(g, CALC.combat);
        gt.append(el("tr", {},
          el("td", {}, el("b", {}, cg.name + " (smart)")),
          el("td", { class: "sub" },
            "Cybergun", weaponSkillDice(cg.name, "Cybergun", shot.acc, cgBonuses),
            " · ", bit("Acc", "acc"), " · ", bit("DMG", "damage"), " · ", bit("Pen", "pen"),
            base.bar ? " · " : null, base.bar ? bit("Barrier", "bar") : null,
            " · ",
            bitOf("Mag", cgAmmoRow.Ammo, g.Ammo),
            " · ",
            bitOf("Hardening", cgAmmoRow.Hardening, RULES.hardeningOf(g)),
            recoilBit(cgRecoil),
            el("div", { class: "sub wpn-mods" }, "Implanted — configured on the Augments tab"),
            ammo.notes.length
              ? el("div", { class: "sub wpn-ammo-note" }, `${ammo.name}: ${ammo.notes.join(" · ")}`) : null),
          el("td", { class: "sub" }, "Cyberware"),
          gro ? null : el("td", { class: "sub" }, cgModes.length
            ? firingModeControls(cg.src, cgRow, cgRecoil, cgModes, cgMode, cgKataOffered,
                weaponRollSpec(cg.name, "Cybergun", shot.acc, cgBonuses), cg.name)
            : "—"),
          gro ? null : el("td", { class: "sub" }, munitionPicker(cg.src, cgRow))));
      });
      loadout.append(gt);
    }

    // Heavy Torso / No Head free-mount gear — weapons (with stats) and extra
    // limbs, each noting the granting trait. Bolted to the frame rather than
    // carried, so it sits with the natural weapons above the loadout proper.
    if (traitGear.length) {
      const tt = el("table");
      tt.append(el("tr", {}, el("th", {}, "Trait-mounted"),
        el("th", {}, "Stats"), el("th", {}, "From trait"),
        ro ? null : el("th", {}, ""), ro ? null : el("th", {}, "Ammo")));
      traitGear.forEach(g => {
        const w = g.weapon;
        // A mounted gun loads from the same stock as anything else you own, and
        // what's in it moves its numbers — so resolve the round before building
        // the stat line, the way the equipped weapons do.
        const mountEntry = (g.kind === "weapon" && w) ? traitMountState(g.label) : null;
        const mAmmo = mountEntry ? loadedAmmoFor(mountEntry, w)
                                 : { row: null, name: "", mods: null, notes: [] };
        const mBase = w ? { acc: w.Accuracy || 0, damage: w.Damage || "—",
                            pen: w.Pen || 0, bar: String(w.Bar ?? "") } : null;
        const mShot = (mBase && mAmmo.row) ? RULES.applyAmmoStats(mBase, mAmmo.mods) : mBase;
        // Conceal and weight are the only row stats this line prints, but a
        // round that states either moves them here too (#86).
        const mRow = (w && mAmmo.row) ? RULES.applyAmmoToRow({}, w, mAmmo.mods) : (w || {});
        const mBit = (label, key) => el("span",
          (mAmmo.row && String(mShot[key]) !== String(mBase[key]))
            ? { class: "wpn-ammo-mod", title: `${mAmmo.name} loaded` } : {},
          `${label} ${mShot[key]}`);
        const stats = g.kind === "weapon" && w
          ? [`${w.Type || ""}`, weaponSkillDice(w.Weapon, w.Type, mShot.acc, [], w.Reach),
             " · ", mBit("Acc", "acc"), " · ", mBit("DMG", "damage"),
             " · ", mBit("Pen", "pen"),
             mBase.bar ? " · " : "", mBase.bar ? mBit("Barrier", "bar") : "",
             ` · Conceal ${mRow.Conceal ?? w.Conceal ?? 0} · wt ${mRow.Weight ?? w.Weight ?? 0}`,
             mAmmo.notes.length
               ? el("div", { class: "sub wpn-ammo-note" },
                   `${mAmmo.name}: ${mAmmo.notes.join(" · ")}`) : null]
          : ["Extra limb (free mount)"];
        // A mounted gun runs a magazine like any other, off its own weapon row's
        // Ammo and Firing modes. Trait gear is derived fresh every recalc from
        // the heritage picks, so there's no entry to hang the round count on —
        // it lives in play state keyed by the mount's label instead. A mounted
        // blade has no modes and keeps the plain Attack; an extra limb is a
        // mount rather than a weapon and gets nothing to press.
        const modes = (g.kind === "weapon" && w) ? RULES.weaponFiringModes(w) : [];
        const mount = mountEntry;
        const mMode = modes.includes(mount && mount.mode) ? mount.mode : (modes[0] || "");
        const mMd = mMode ? RULES.firingMode(mMode) : { dice: 0, ammo: 0 };
        const mMag = Math.max(0, parseInt(w && w.Ammo, 10) || 0);
        const mKata = gunKataRank() >= 2 && mMag > 0 && modes.length > 0
          && gunKataFitsWeapon(w);
        const mBonuses = [];
        if (mMd.dice) mBonuses.push({ label: mMode, dice: mMd.dice });
        if (mKata && mount && mount.kata) mBonuses.push({ label: "Gun-Kata", dice: 1 });
        const rs = (g.kind === "weapon" && w)
          ? weaponRollSpec(w.Weapon, w.Type, mShot.acc, mBonuses, w.Reach) : null;
        const attack = ro ? null : el("td", {},
          (modes.length && mount)
            ? firingModeControls(mount, w, {}, modes, mMode, mKata, rs, g.label)
            : (g.kind === "weapon" && w)
              ? attackButton(g.label, rs, { melee: w.Type === "Melee" }) : "—");
        // Loads from the same stock as everything else — a mount is a gun, not
        // a special case. Melee mounts and limbs take nothing, so they say so.
        const ammoCell = ro ? null : el("td", { class: "sub" },
          mount ? munitionPicker(mount, w) : "—");
        tt.append(el("tr", {},
          el("td", {}, el("b", {}, g.label)),
          el("td", { class: "sub" }, ...stats),
          el("td", { class: "sub" }, g.source),
          attack, ammoCell));
      });
      loadout.append(tt);
    }

    // --- Hands: which carried weapon is actually in which hand.
    //
    // Assignment lives on the weapon entry itself (w.hand = slot index), the
    // same way w.lo / w.mode / w.loaded already do -- NOT a play.hands array
    // keyed by name, because two identical pistols is a designed-for case
    // (reconcileKit pairs same-named entries positionally) and name-keying
    // would collapse them. Only the PRIMARY slot is stored; a two-handed
    // weapon's second slot is derived from RULES.weaponHands() every render,
    // never stored, so it can't desync from a data change.
    if (equippedWeapons.length) {
      const handCountEff = RULES.handCount(CALC, CHAR.play.hand_override);
      const primaryAt = i => equippedWeapons.find(w => w.hand === i);
      // A slot past its own primary is claimed by the PREVIOUS slot's weapon
      // when that weapon is two-handed -- unless something is genuinely
      // primary there itself, which wins (defensive, for a hand-edited file;
      // the picker below never lets this conflict arise on its own).
      const secondaryOf = i => {
        if (i <= 0 || primaryAt(i)) return null;
        const prev = primaryAt(i - 1);
        if (!prev) return null;
        const row = DATA.tables.weapons.find(x => x.Weapon === prev.name) || {};
        return RULES.weaponHands(row) === 2 ? prev : null;
      };
      const slotFilled = i => !!(primaryAt(i) || secondaryOf(i));

      loadout.append(el("h4", { class: "sh-h4" }, "Hands"));
      // Manual override: heritage (Extra Arm, a Heavy Torso Cyberarm mount)
      // derives a count automatically, but nothing here models every way a
      // table might grant or cost a hand, so the derived number can be
      // hand-adjusted. Cleared back to "derived" rather than left wrong.
      const derivedHands = CALC.combat.hand_count || RULES.HAND_COUNT_BASE;
      const handRow = el("div", { class: "sh-advrow" },
        el("span", {}, el("b", {}, "Hand count"),
          el("span", { class: "sub" }, ` ${handCountEff} (derived ${derivedHands})`)));
      if (!ro) {
        handRow.append(miniCounter("Hands",
          () => handCountEff,
          v => { CHAR.play.hand_override = v; },
          1, RULES.HAND_COUNT_MAX));
        if (CHAR.play.hand_override != null && CHAR.play.hand_override !== "")
          handRow.append(el("button", { class: "btn small",
              title: "Clear the override and go back to the derived count",
              onclick: () => { CHAR.play.hand_override = null; playChanged(); } }, "↺ derived"));
      }
      loadout.append(handRow);

      // Underbarrel weapons, grouped by the exact host ENTRY they ride on
      // (identity, not name -- see hostRef on underbarrelWeapons()) so two
      // same-named hosts each show only their own underbarrel gun.
      const ubByHost = new Map();
      for (const ub of underbarrelWeapons()) {
        (ubByHost.get(ub.hostRef) || ubByHost.set(ub.hostRef, []).get(ub.hostRef)).push(ub);
      }

      const renderUnderbarrel = ub => {
        const r = ub.row;
        const st = ub.state;
        const ubModes = RULES.weaponFiringModes(r);
        const ubMode = ubModes.includes(st.mode) ? st.mode : (ubModes[0] || "");
        const rs = weaponRollSpec(ub.name, r.Type, r.Accuracy || 0, [], r.Reach);
        // An underslung launcher chambers a grenade and runs a magazine
        // exactly like the M31-a1G does — it is the same kind of weapon, and
        // the only thing that made it different was having no entry to keep
        // the round count on. Its damage comes from whatever is loaded.
        const gren = loadedGrenadeFor(st);
        const dmg = gren.row ? (gren.row.Damage || r.Damage) : (r.Damage || "—");
        return el("div", { class: "sh-hand-underbarrel" },
          el("div", {}, el("b", {}, ub.name), " ",
            el("span", { class: "sh-tag" }, "Underbarrel")),
          el("div", { class: "sub" },
            `${r.Type || ""}`,
            weaponSkillDice(ub.name, r.Type, r.Accuracy || 0, [], r.Reach),
            ` · Acc ${r.Accuracy || 0} · `,
            el("span", gren.row ? { class: "wpn-ammo-mod", title: `${gren.name} chambered` } : {},
              `DMG ${dmg}`),
            ` · Pen ${r.Pen || 0}`
            + barrierBit(r, r.Bar)
            + (r.Ammo ? ` · Mag ${r.Ammo}` : "")
            + ` · Hardening ${RULES.hardeningOf(r)}`,
            el("div", { class: "sub wpn-mods" }, `via the ${ub.mod} mod`),
            gren.notes.length
              ? el("div", { class: "sub wpn-ammo-note" }, `${gren.name}: ${gren.notes.join(" · ")}`)
              : null),
          ro ? null : el("div", { class: "sh-fire" },
            ubModes.length
              ? firingModeControls(st, r, {}, ubModes, ubMode, false, rs, ub.name)
              : attackButton(ub.name, rs, { melee: r.Type === "Melee" })),
          ro ? null : munitionPicker(st, r));
      };

      // Reassigning a hand: filling it costs a Simple Action (switching what
      // you hold), gated the same way every other loadout action-cost is;
      // clearing it to empty is free (stowing a weapon costs nothing). Either
      // way clears accumulated recoil -- your STANCE changed, and recoil is
      // one character-wide tracker, not per-weapon (see recoilTracked). A
      // failed spend leaves state untouched and just re-renders, which snaps
      // the <select> back to what it actually holds.
      const assignHand = (slotIndex, newEntry) => {
        if (newEntry && CHAR.play.action_costs
            && !spendSimpleActions(1, "switching weapons")) { renderSheet(); return; }
        const prev = primaryAt(slotIndex);
        if (prev) prev.hand = null;
        if (newEntry) {
          newEntry.hand = slotIndex;
          // A two-handed weapon takes the next slot too. The picker already
          // only offers one when that slot is free -- this is the function's
          // OWN guarantee of the same rule, not just the picker's, since state
          // can also arrive here from a stale save or a bypassed <select>
          // (a disabled <option> stops mouse/keyboard use, not a script
          // setting .value directly). Evicting rather than refusing keeps
          // this simple: whatever was there is freed, not silently dropped.
          const row = DATA.tables.weapons.find(x => x.Weapon === newEntry.name) || {};
          if (RULES.weaponHands(row) === 2) {
            const bumped = primaryAt(slotIndex + 1);
            // The one named exception (see TWO_HANDED_COMPANION): its
            // companion weapon is allowed to keep riding the second hand
            // rather than being bumped by its own two-handed host.
            const companion = TWO_HANDED_COMPANION[newEntry.name];
            if (bumped && bumped.name !== companion) bumped.hand = null;
          }
        }
        stabilizeRecoil({});
        playChanged();
      };

      const cards = el("div", { class: "sh-hand-cards" });
      // Twin Fire (#59): one slot per hand, filled only by a hand that could
      // actually take part. Populated as each card is built — everything Twin
      // Fire needs (the mode, the magazine, the bonus dice, the recoil row) is
      // already computed there, and recomputing it afterwards would be a second
      // copy of that arithmetic waiting to disagree with the card it describes.
      const twinHands = [];
      for (let i = 0; i < handCountEff; i++) {
        const held = primaryAt(i);
        const claimedBy = !held ? secondaryOf(i) : null;
        // TWO_HANDED_COMPANION's one named exception: this slot is normally
        // the disabled "needs both hands" placeholder, but when the weapon
        // claiming it has a registered companion, it opens as a real
        // (restricted) picker instead.
        const companionName = claimedBy && TWO_HANDED_COMPANION[claimedBy.name];

        if (claimedBy && !companionName) {
          // The second half of a two-handed weapon: nothing to choose here,
          // just say what's using it. Kept as a real (disabled) control, not
          // a plain string, so the row still reads as "a hand" at a glance.
          cards.append(el("div", { class: "sh-hand-card" },
            el("div", { class: "k" }, `Hand ${i + 1}`),
            el("select", { disabled: "1",
                title: `Held by ${claimedBy.name} — it needs both hands` },
              el("option", {}, `— ${claimedBy.name} (two-handed) —`))));
          continue;
        }

        // Options: every carried weapon, always including whatever already
        // occupies THIS slot (so the select can show it selected) — a
        // two-handed weapon is only offered where slot i+1 exists and isn't
        // independently held, matching the exclusivity idiom used for the
        // Speaker bond/infusion pickers. Disabled-with-a-title in the last
        // slot rather than simply absent, so the option doesn't look like it
        // was never there (same idiom as reorderHandle and a sealed Reload).
        // A companion-claimed slot narrows the pool to just that one weapon —
        // this hand is still "spoken for" by the two-handed host, with one
        // named exception let through.
        const candidatePool = companionName
          ? equippedWeapons.filter(cand => cand.name === companionName)
          : equippedWeapons;
        const canPlace2H = (i + 1) < handCountEff && !primaryAt(i + 1);
        const opts = candidatePool.map(cand => {
          const row = DATA.tables.weapons.find(x => x.Weapon === cand.name) || {};
          const needsTwo = RULES.weaponHands(row) === 2;
          const isHere = cand === held;
          const disabled = needsTwo && !canPlace2H && !isHere;
          return { cand, disabled,
            title: disabled
              ? (i === handCountEff - 1
                  ? "Needs a second hand — there's no slot after this one"
                  : "Needs a second hand — the next hand is already holding something")
              : null };
        });
        const idxOf = cand => equippedWeapons.indexOf(cand);
        const sel = el("select", { title: "Weapon held in this hand",
          onchange: e => {
            const v = e.target.value;
            assignHand(i, v === "" ? null : equippedWeapons[+v]);
          } },
          el("option", { value: "" }, "— empty —"),
          ...opts.map(o => el("option",
            { value: String(idxOf(o.cand)), ...(o.disabled ? { disabled: "1" } : {}),
              ...(o.title ? { title: o.title } : {}) },
            o.cand.name)));
        sel.value = held ? String(idxOf(held)) : "";

        const tile = el("div", { class: "sh-hand-card" + (held ? " active" : "") },
          el("div", { class: "k" }, `Hand ${i + 1}`),
          ro ? el("div", {}, held ? held.name : "— empty —") : sel,
          (companionName && !held)
            ? el("div", { class: "sub" },
                `Only ${companionName} can go here while ${claimedBy.name} is in Hand ${i} — `
                + "it's the same weapon's own grenade launcher.")
            : null);

        if (held) {
          const r = DATA.tables.weapons.find(x => x.Weapon === held.name) || {};
          const calcRow = calcRowFor(held, equippedWeapons);
          const modNames = [
            ...RULES.weaponIntegratedMods(r, DATA.tables.weapon_mods)
              .map(m => `${m} (built in)`),
            ...(held.mods || [])];
          if (held.upgr1 && r.Upgr1_Eff) modNames.push("Upgrade 1");
          if (held.upgr2 && r.Upgr2_Eff) modNames.push("Upgrade 2");
          const baseAcc = calcRow.Accuracy ?? r.Accuracy ?? 0;
          // Thrown weapons skip the melee damage pass, so a Knife would print
          // "½ Str" rather than the number it resolves to.
          let baseDmg = calcRow.Damage ?? r.Damage ?? "—";
          if (RULES.isStrengthDamage(baseDmg) && RULES.meleeDamageIsComputable(baseDmg))
            baseDmg = RULES.meleeDamage(r, CALC.attributes.Strength.final);
          const isLauncher = r.Type === "GrenadeLauncher";
          const base = { acc: baseAcc, damage: baseDmg, pen: r.Pen || 0,
                         bar: String(calcRow.Bar ?? r.Bar ?? "") || (isLauncher ? "—" : "") };
          const canLoad = !["Melee", "Thrown", "Energy"].includes(r.Type);
          const gren = isLauncher ? loadedGrenadeFor(held) : null;
          const ammo = (isLauncher || !canLoad)
            ? { row: null, name: "", notes: [] } : loadedAmmoFor(held, r);
          const munName = isLauncher ? gren.name : ammo.name;
          const munNotes = isLauncher ? gren.notes : ammo.notes;
          const shot = isLauncher
            ? (gren.row ? { acc: baseAcc, damage: gren.row.Damage || "—", pen: gren.row.Pen || 0,
                            bar: String(gren.row.Bar ?? "") || "—" }
                        : { ...base })
            : (ammo.row ? RULES.applyAmmoStats(base, ammo.mods) : { ...base });
          // Everything the round moves that isn't a shot stat -- the magazine
          // it feeds, the recoil it kicks, its Hardening/Conceal/Weight/ZR/
          // Rarity -- lands on a copy of the priced row, so the stat line, the
          // Fire button and the Reload button all read the same figures (#86).
          // The firing modes come after it for the same reason: a round can
          // bar full auto, or add a mode the gun alone doesn't offer.
          const ammoRow = ammo.row ? RULES.applyAmmoToRow(calcRow, r, ammo.mods) : calcRow;
          const modes = RULES.ammoFiringModes(RULES.weaponFiringModes(r),
            ammo.row ? ammo.mods : null);
          const mode = modes.includes(held.mode) ? held.mode : (modes[0] || "");
          const md = mode ? RULES.firingMode(mode) : { dice: 0, ammo: 0, name: "" };
          const magSize = Math.max(0, parseInt(ammoRow.Ammo ?? r.Ammo, 10) || 0);
          const kataOffered = gunKataRank() >= 2 && magSize > 0 && modes.length > 0
            && gunKataFitsWeapon(r);
          const kataOn = kataOffered && !!held.kata;
          // No Recoil (#61): a Bi-pod / Gyro-mount / Gas Vent on this gun, plus
          // the Gyromount augment and Gun-Kata 3, as bonus dice. Distinct from
          // the `braced` const below, which is the free-hand Recoil bonus and
          // goes inert under this rule along with Recoil itself.
          const noRecoil = noRecoilSourcesFor(r, calcRow);
          const braceOffered = noRecoil.some(b => b.when === "braced");
          const bonuses = [];
          if (md.dice) bonuses.push({ label: mode, dice: md.dice });
          if (kataOn) bonuses.push({ label: "Gun-Kata", dice: 1 });
          bonuses.push(...noRecoilLiveBonuses(noRecoil, mode, held));
          const statBit = (label, key) => el("span",
            (munName && String(shot[key]) !== String(base[key]))
              ? { class: "wpn-ammo-mod", title: `${munName} loaded` } : {},
            `${label} ${shot[key]}`);
          // A free OTHER hand steadies a one-handed weapon: +1 Recoil
          // capacity, the same shape a bipod's +1 already takes (added onto
          // recoil_mod, never replacing it; melee/thrown carry no Recoil key
          // at all and must stay that way, or every unarmed card would grow
          // a phantom "Recoil 1"). See RULES.weaponHands / the plan's Recoil
          // section for the four traps this threads.
          const braced = RULES.weaponHands(r) === 1 && ammoRow.Recoil != null
            && Array.from({ length: handCountEff }, (_, j) => j)
                 .some(j => j !== i && !slotFilled(j));
          const effRow = braced ? {
            ...ammoRow,
            Recoil: toInt(ammoRow.Recoil) + 1,
            recoil_mod: toInt(ammoRow.recoil_mod) + 1,
            recoil_mod_label: ammoRow.recoil_mod
              ? `${ammoRow.recoil_mod_label || "mods"} + free hand` : "free hand",
          } : ammoRow;
          // Twin Fire candidacy for this hand (#59). gunKataFitsWeapon is the
          // file's established "one-handed pistol or SMG" test — reused, not
          // reimplemented. A gun with no magazine or no firing mode (a
          // launcher, an energy weapon) can't be Twin Fired, and the ammo
          // figures are derived exactly the way firingModeControls derives its
          // own so the button and the Fire beside it agree about "dry".
          if (gunKataFitsWeapon(r) && magSize > 0 && modes.length) {
            const loadedNow = held.loaded == null ? magSize
              : Math.max(0, Math.min(Math.floor(+held.loaded) || 0, magSize));
            twinHands[i] = { slot: i, entry: held, row: r, name: held.name,
              effRow, modes, mode, bonuses,
              cost: md.ammo + (kataOn ? 1 : 0), loaded: loadedNow, maxAmmo: magSize };
          }
          // The row stats get the same treatment the shot stats do: the value
          // shown is the one with the round in it, marked when the round is
          // what changed it. Conceal and Recoil carry their own "(+N ammo)"
          // annotation through concealBit/recoilBit instead.
          const rowBit = (label, shown, was) => el("span",
            String(shown) !== String(was)
              ? { class: "wpn-ammo-mod", title: `${munName} loaded` } : {},
            `${label} ${shown}`);
          const hardOf = row => RULES.hardeningOf(
            String((row || {}).Hardening ?? "").trim() !== "" ? row : r);
          const magShown = ammoRow.Ammo ?? r.Ammo ?? "";
          const rarityShown = String((ammoRow.Rarity ?? r.Rarity) || "");
          tile.append(el("div", { class: "sub" },
            `${r.Type || ""}`,
            weaponSkillDice(held.name, r.Type, shot.acc, bonuses, r.Reach),
            (calcRow.smart ?? held.smart) ? " (smart)" : "",
            " · ",
            r.Type === "Melee" ? `Reach ${r.Reach || 0}` : statBit("Acc", "acc"),
            " · ", statBit("DMG", "damage"), " · ", statBit("Pen", "pen"),
            base.bar ? " · " : null, base.bar ? statBit("Barrier", "bar") : null,
            ` · Conceal ${concealBit(r, effRow)} · `,
            rowBit("ZR", (ammoRow.ZR ?? r.ZR) || 0, (calcRow.ZR ?? r.ZR) || 0),
            " · ",
            rowBit("Weight", (ammoRow.Weight ?? r.Weight) || 0,
              (calcRow.Weight ?? r.Weight) || 0),
            magShown ? " · " : null,
            magShown ? rowBit("Mag", magShown, calcRow.Ammo ?? r.Ammo ?? "") : null,
            " · ", rowBit("Hardening", hardOf(ammoRow), hardOf(calcRow)),
            recoilBit(effRow),
            rarityShown && rarityShown !== "-" ? " · " : null,
            rarityShown && rarityShown !== "-"
              ? rowBit("Rarity", rarityShown, String((calcRow.Rarity ?? r.Rarity) || "")) : null,
            RULES.weaponIsOneshot(r) ? ` · ${RULES.ONESHOT_NOTE}` : ""));
          if (modNames.length)
            tile.append(el("div", { class: "sub wpn-mods" }, "Mods: " + modNames.join(" · ")));
          if (munNotes.length)
            tile.append(el("div", { class: "sub wpn-ammo-note" }, `${munName}: ${munNotes.join(" · ")}`));
          if (!ro) {
            const rs = weaponRollSpec(held.name, r.Type, shot.acc, bonuses, r.Reach);
            tile.append(el("div", { class: "sh-fire" }, modes.length
              ? firingModeControls(held, r, effRow, modes, mode, kataOffered, rs,
                  null, { braceOffered })
              : attackButton(held.name, rs, { melee: r.Type === "Melee" })));
            tile.append(munitionPicker(held, r));
          }
          for (const ub of (ubByHost.get(held) || [])) tile.append(renderUnderbarrel(ub));
        }
        cards.append(tile);
        // Twin Fire's control belongs to the PAIR, not to either card, so it is
        // emitted here — inside the grid, immediately after the second card of
        // an adjacent qualifying pair — rather than after the loop. It spans the
        // whole grid row (grid-column:1/-1), which puts it directly under the
        // two cards it joins on a two-hand character, where they sit side by
        // side. A three-armed character can pair 1+2 and 2+3, so a bar is
        // emitted for each adjacent pair and names its own two hands; it can no
        // longer sit visually between them once the grid has been broken into
        // rows, which is why the caption states the hands rather than relying on
        // position alone. Read-only shares get no firing controls at all, here
        // as everywhere else in this block.
        if (!ro && i > 0 && twinHands[i - 1] && twinHands[i])
          cards.append(twinFireBar(twinHands[i - 1], twinHands[i]));
      }
      loadout.append(cards);
      loadout.append(concealCallout());

      // Carried but not in a hand right now -- names only; press the select
      // above to actually wield one. Distinct from "dormant" below: this
      // weapon was never assigned, that one was and the hand it was in is
      // gone (fewer hands now than when it was picked up).
      const carried = equippedWeapons.filter(w => w.hand == null);
      if (carried.length) {
        loadout.append(el("p", { class: "hint" },
          `Carried, not in hand: ${carried.map(w => w.name).join(" · ")}.`));
      }
      // Never cleared on a shrink (fewer hands than before) -- same ruling as
      // play.bond_slots: raising the count back hands the weapon back, so the
      // assignment is kept rather than lost. Named here so it doesn't read as
      // the sheet having silently dropped a weapon.
      const dormant = equippedWeapons.filter(w => Number.isInteger(w.hand) && w.hand >= handCountEff);
      if (dormant.length) {
        loadout.append(el("p", { class: "hint" },
          `Held in a hand you no longer have: ${dormant.map(w => w.name).join(" · ")} — `
          + "nothing has been deleted; more hands will bring it back."));
      }
      // A weapon you own but haven't equipped is absent above entirely, which
      // reads as the sheet having lost it. Name them, and say where to fix it.
      const stowed = weaponsAll.filter(w => w.equipped === false);
      if (stowed.length) {
        loadout.append(el("p", { class: "hint" },
          `Not equipped, so not carried: ${stowed.map(w => w.name).join(" · ")}. `
          + `Tick Equip on the Gear tab to carry ${stowed.length > 1 ? "them" : "it"}.`));
      }
    }
    // Armor and Ammo sit side by side in half-width boxes, the same shape the
    // hand cards use (#60): both were full-width bands stacked under the guns,
    // and neither carries enough to earn the whole width. auto-fit means they
    // pair up when there is room and stack when there is not, so the phone
    // layout is unchanged. Armor leads because it is the longer of the two and
    // the one consulted on every incoming hit.
    const loadoutBoxes = el("div", { class: "sh-loadout-boxes" });

    // Ammo on hand, listed under the weapons it feeds (issue #21). Uses remaining
    // are tracked on the Gear tab; Effect/Notes come straight from the table.
    let ammoBox = null;
    if (ammoOnHand.length) {
      const amt = el("table");
      amt.append(el("tr", {}, el("th", {}, "Ammo"), el("th", { class: "num" }, "Uses"),
        el("th", {}, "Effect / restrictions")));
      ammoOnHand.forEach(a => amt.append(el("tr", {},
        el("td", {}, el("b", {}, a.name)),
        el("td", { class: "num" }, String(a.uses)),
        el("td", { class: "sub" }, [a.row.Effect || "", a.row.Notes || ""]
          .filter(Boolean).join(" · ") || "—"))));
      ammoBox = el("div", { class: "sh-loadout-box" },
        el("div", { class: "k" }, "Ammo"), amt);
    }
    // (Both the natural / cyber and trait-mounted tables are built and appended
    // above the equipped weapons — what's part of you, then what's bolted to
    // you, then what you picked up.)
    const armorSources = CALC.combat.armor_sources || [];
    if (wornArmor.length || armorSources.length) {
      // Worn armor + granted (cyber/bioware/heritage/amp) armor share ONE ordered
      // list. Worn order lives on the armor object (`lo`); granted rows are derived
      // each recalc, so their order is stored by source name in a play-state map.
      const gmap = (CHAR.play.granted_armor_order = CHAR.play.granted_armor_order || {});
      const at = el("table");
      at.append(el("tr", {}, el("th", {}, "Armor"), el("th", { class: "num" }, "B / I"),
        el("th", {}, "Notes")));
      const items = [];
      wornArmor.forEach((a, idx) => items.push({
        ins: idx, getOrder: () => a.lo, setOrder: v => { a.lo = v; },
        cells: () => {
          const r = DATA.tables.armor.find(x => x.Armor === a.name) || {};
          // Match the Gear tab: Quality/Style/slot, weight, extras -- then the
          // gameplay effects those carry (issue #18). wornArmor is a filtered
          // view, so map back through the full owned list to reach the CALC row.
          const arow = (CALC.armor || [])[armorAll.indexOf(a)] || {};
          // ZR and Rarity join the line so armor reports the same shape the
          // weapon rows beside it do — both were on the weapon line and on
          // neither armor line, which is exactly the kind of gap #56 asks for a
          // pass on. Rarity is skipped when the data says "-" (no rating).
          const notes = [
            [arow.material, arow.style].filter(Boolean).join(" · ") || r.Slot || "",
            `wt ${r.wt || 0}`,
            `ZR ${r.ZR || 0}`,
            (r.Rarity && r.Rarity !== "-") ? `Rarity ${r.Rarity}` : "",
          ].filter(Boolean).join(" · ");
          const aeffects = arow.effects || [];
          // What the Quality, Style and Extras DO is folded behind the list of
          // their own names (#60): a coat with four extras was printing four
          // rulings inline, which buried the armor values the row exists for.
          // The summary is the inventory -- names only, always readable -- and
          // one click gets the meanings, the same trade spells make with their
          // Description. Extras with no ruling still get named in the summary,
          // so folding never loses the fact that they are fitted.
          const named = new Set(aeffects.map(e => e.label));
          const trimNames = [...aeffects.map(e => e.label),
            ...(arow.extras || []).filter(x => !named.has(x))];
          return {
            name: el("b", {}, a.name),
            stats: el("td", { class: "num" }, `${r.Ballistic || 0} / ${r.Impact || 0}`),
            last: el("td", { class: "sub" }, notes || "—",
              trimNames.length
                ? (aeffects.length
                    ? expanderPanel(`armor-trim:${a.name}:${idx}`, trimNames.join(" · "),
                        ...aeffects.map(e => el("div", { class: "armor-effect-line" },
                          el("b", {}, `${e.label}: `), e.text)))
                    // Nothing fitted has a ruling to explain, so an expander
                    // would open onto an empty box -- name them and stop.
                    : el("div", { class: "armor-effects" }, trimNames.join(" · ")))
                : null),
          };
        },
      }));
      armorSources.forEach((s, idx) => items.push({
        ins: 1000 + idx, getOrder: () => gmap[s.name], setOrder: v => { gmap[s.name] = v; },
        cells: () => ({
          name: el("span", {}, el("b", {}, s.name), el("span", { class: "sh-tag" }, "granted")),
          stats: el("td", { class: "num" }, `${s.b} / ${s.i}`),
          last: el("td", { class: "sub" }, s.unstrippable ? "unstrippable" : "—"),
        }),
      }));
      loadoutSort(items);
      items.forEach((it, i) => {
        const c = it.cells();
        const handle = reorderHandle(() => loadoutMove(items, i, -1), () => loadoutMove(items, i, 1),
          i > 0, i < items.length - 1);
        at.append(el("tr", {}, el("td", {}, handle, c.name), c.stats, c.last));
      });
      // One selector per slot the character owns armor for, so changing what
      // you're wearing is a single click here rather than a trip to the Gear
      // tab to untick one box and tick another. Picking a piece takes off
      // whatever else was in that slot — the same one-piece-per-slot rule the
      // Worn checkbox enforces — and a Helmet keeps its own slot ("Outer*"),
      // which is why it can be worn alongside a coat.
      const SLOT_LABELS = { Outer: "Outer", Under: "Under", "Outer*": "Helmet" };
      const armorSwap = (() => {
        if (ro || !armorAll.length) return null;
        const bySlot = new Map();
        armorAll.forEach((a, i) => {
          const slot = (DATA.tables.armor.find(x => x.Armor === a.name) || {}).Slot || "Other";
          if (!bySlot.has(slot)) bySlot.set(slot, []);
          bySlot.get(slot).push({ a, i });
        });
        const order = ["Outer", "Under", "Outer*"];
        const slots = [...bySlot.keys()]
          .sort((x, y) => (order.indexOf(x) + 1 || 99) - (order.indexOf(y) + 1 || 99));
        const row = el("div", { class: "sh-armor-swap" });
        for (const slot of slots) {
          const group = bySlot.get(slot);
          const worn = group.find(({ a }) => a.active !== false);
          const sel = el("select", { class: "sh-fire-sel",
            title: `What you're wearing in the ${SLOT_LABELS[slot] || slot} slot`,
            onchange: async e => {
              const pick = e.target.value === "" ? -1 : +e.target.value;
              group.forEach(({ a, i }) => { a.active = (i === pick); });
              await playChangedRecalc();
            } },
            el("option", { value: "" }, "— nothing —"),
            ...group.map(({ a, i }) => {
              const r = DATA.tables.armor.find(x => x.Armor === a.name) || {};
              const arow = (CALC.armor || [])[i] || {};
              // Style and Quality distinguish four otherwise identical coats.
              const trim = [arow.style, arow.material].filter(Boolean).join(" · ");
              return el("option", { value: String(i),
                ...(worn && worn.i === i ? { selected: 1 } : {}) },
                `${a.name}${trim ? ` (${trim})` : ""} — ${r.Ballistic || 0}/${r.Impact || 0}`);
            }));
          sel.value = worn ? String(worn.i) : "";
          row.append(el("label", { class: "sub sh-armor-swap-slot" },
            el("span", {}, SLOT_LABELS[slot] || slot), sel));
        }
        return row;
      })();
      const armorBox = el("div", { class: "sh-loadout-box" },
        el("div", { class: "k" }, "Armor"));
      armorBox.append(...[
        el("div", { class: "sh-advrow", style: "border:0;padding:6px 0 0" },
          el("span", { class: "sub" },
            `Total armor: ${CALC.combat.ballistic_armor}B / ${CALC.combat.impact_armor}I `
            + `(Max Ballistic ${CALC.combat.max_ballistic})`)),
        armorSwap,
        at,
      ].filter(Boolean));
      // Sits directly under the total it inflates, so the number and the reason
      // it's wrong are read together.
      for (const { slot, names } of overArmoredSlots()) {
        armorBox.append(el("div", { class: "sh-callout warn" }, "⚠ ",
          el("b", {}, `${names.length} ${slot} pieces worn — `),
          `only one ${slot} piece should count, but all ${names.length} are adding to the `
          + `totals above: ${names.join(" · ")}. Untick the extras under Worn on the Gear tab.`));
      }
      loadoutBoxes.append(armorBox);
    }
    if (ammoBox) loadoutBoxes.append(ammoBox);
    if (loadoutBoxes.children.length) loadout.append(loadoutBoxes);
    body.append(loadout);
  }

  // --- temporary effects + active modifiers
  // One list, not two. "Temporary Effects" and "Active Modifiers" were the same
  // thing wearing different names — both a label, a source, a pool and a dice
  // delta — and having two of them made every entry start with a question that
  // had no answer (#57). Splitting them into bonuses and penalties instead was
  // the other option and would have been the same mistake in a new shape: the
  // dice are signed, so the sign already says which it is.
  mergeTrackedEffects(play);
  body.append(trackedEffectList("Effects & Modifiers", play.effects, "Add",
    "Haste F4 · Cover · Smartlink", "Nothing active."));

  // --- notes
  body.append(notesCard(3));
}

/* The character's own recoil capacity, with where each point came from.
 *
 * This is the base every gun starts from; a weapon's own mods are added on its
 * stat line, not here. Shown in two places on purpose — in the Dossier Notes
 * card as a derived figure of the build, and at the foot of the Finesse card
 * because Firearms is a Finesse skill and this is the number you check in the
 * same breath as the dice you're about to roll. */
function recoilSummary() {
  const c = CALC.combat;
  const parts = [`base ${RULES.BASE_RECOIL_CAPACITY ?? 1}`];
  if (c.recoil_strength_bonus) parts.push(`+${c.recoil_strength_bonus} Strength`);
  if (c.recoil_augment_bonus) parts.push(`+${c.recoil_augment_bonus} Gyromount`);
  return {
    value: c.recoil_capacity,
    breakdown: parts.join(" · "),
    ignored: c.recoil_ignored ? `Gun-Kata: recoil ignored on ${c.recoil_ignored_types}` : "",
  };
}

/* Null under the "No Recoil" house rule (#61) — there is no capacity to report,
 * so the Finesse card and the Dossier both lose the line rather than showing a
 * number that means nothing. Both callers test for null. */
function recoilStatLine() {
  if (!RULES.recoilInPlay()) return null;
  const r = recoilSummary();
  return el("div", { class: "sh-recoil" },
    statLine("Recoil capacity", String(r.value), r.breakdown),
    el("div", { class: "sub" }, r.breakdown
      + (r.ignored ? ` — ${r.ignored}` : "")
      + ". Mods fitted to a gun add to this on its own line."));
}

function statLine(label, value, title) {
  return el("div", title ? { class: "stat-line", title } : { class: "stat-line" },
    label, el("b", {}, value));
}
// Exploit-action kinds, in the order they're listed (rules #1–7). The grouping
// and source attribution that used to live here as exploitLines() moved into
// actionsCard(), which is where the actions are spent.
const EXPLOIT_KIND_ORDER = ["Melee", "Move", "Decking", "Rigging", "Control"];
/* The action-economy rows for the current character: Simple (engine-derived),
 * Reflex (a flat 1 every character gets), then one row per exploit-action kind
 * actually granted, grouped and ordered by EXPLOIT_KIND_ORDER. Shared by
 * actionsCard() (the full Overview card) and actionsStrip() (the always-on
 * sticky-bar strip) so the two never drift out of sync — same rows, same
 * order, same `key` each `used[key]` is stored under. */
function actionRows() {
  // Every character gets exactly one Reflex Action a round, same as every
  // build's Simple Actions come from the engine — this one's just a flat 1
  // rather than anything derived, so it's written here instead.
  const rows = [{ key: "simple", label: "Simple", total: CALC.combat.simple_actions || 0 },
                { key: "reflex", label: "Reflex", total: 1 }];
  // Grouped by kind, keeping each kind's granting sources. The Combat card used
  // to list those separately (exploitLines); this card is where the actions are
  // actually spent, so the attribution moved here rather than disappearing with
  // the card. Per-source counts show only when several sources share a kind — a
  // lone source's count already equals the line total, so "(+n)" would be noise.
  const byKind = {};
  for (const a of CALC.combat.exploit_actions || []) {
    const g = (byKind[a.kind] = byKind[a.kind] || { total: 0, items: [] });
    g.total += a.count;
    g.items.push(a);
  }
  for (const kind of EXPLOIT_KIND_ORDER) {
    const g = byKind[kind];
    if (!g) continue;
    rows.push({ key: kind, label: `${kind} exploit`, total: g.total,
      sources: g.items.map(a =>
        g.items.length > 1 && a.count > 1 ? `${a.source} (+${a.count})` : a.source) });
  }
  return rows;
}
/* Fresh round: every pool back to full, every action unspent, Beast and MCP
 * dice refreshed. Shared by actionsCard()'s "↻ New Round" button and
 * actionsStrip()'s copy of the same button, so both clear the same things. */
function newRound() {
  for (const p of POOL_ORDER) poolState(p).setUsed(0);
  CHAR.play.actions_used = {};
  refreshBeastDice();     // Wildling's Beast dice refresh each round too
  refreshMcpDice();       // ...and a deck's MCP dice, same deal (#79)
  playChanged();
}
/* What a round costs you, tracked as it's spent (issue #32).
 *
 * Actions come from the engine — `simple_actions` plus the exploit actions each
 * source grants — so only the SPENT count is play state, keyed by "simple" or
 * the exploit kind. Everything derived stays derived: gain an exploit mid-play
 * and the total moves on its own.
 *
 * New Round (issue #37) is here rather than in the header because it belongs
 * with what it clears: every pool back to full and every action unspent, which
 * between them is what a fresh round actually means. */
function actionsCard() {
  const play = CHAR.play;
  const ro = !!(activeTabObj() && activeTabObj().readonly);
  const used = (play.actions_used = play.actions_used || {});
  const rows = actionRows();

  const card = el("div", { class: "card sh-card" },
    el("div", { class: "sh-card-head" }, el("h3", {}, "Actions This Round"),
      ro ? null : counterBtn("↻ New Round", newRound, "good")));
  for (const r of rows) {
    const spent = Math.max(0, Math.min(used[r.key] || 0, r.total));
    const left = r.total - spent;
    card.append(el("div", { class: "stat-line" + (left ? "" : " dim") },
      el("span", {}, r.label,
        // A Complex Action costs 2 Simple Actions and nothing tracks it on its
        // own — spending it just eats the two Simples up front, with the same
        // warning-and-bail pattern as every other "not enough X" check.
        (!ro && r.key === "simple")
          ? el("button", { class: "sh-complex-btn",
              title: "Spend a Complex Action (2 Simple Actions)",
              onclick: () => {
                const cur = used.simple || 0;
                const left2 = r.total - cur;
                if (left2 < 2) {
                  alert(`Not enough Simple Actions for a Complex Action `
                    + `(need 2, have ${left2}).`);
                  return;
                }
                used.simple = cur + 2;
                playChanged();
              } }, "Complex")
          : null,
        (r.sources && r.sources.length)
          ? el("div", { class: "sub", style: "font-weight:400" }, r.sources.join(" · "))
          : null),
      el("span", { style: "text-align:right;display:inline-flex;align-items:center;gap:8px" },
        el("b", { style: left ? "" : "color:var(--dim)" }, `${left} / ${r.total}`),
        // The counter reads and writes AVAILABLE actions, not spent ones (#77):
        // - takes an action away, + gives one back, matching the "left" figure
        // it sits beside. The store stays "used" so the total can move freely.
        ro ? null : miniCounter("", () => r.total - Math.max(0, Math.min(used[r.key] || 0, r.total)),
          v => { used[r.key] = r.total - v; }, 0, r.total, false))));
  }
  // Recoil sits with the actions rather than on a card of its own: it's the
  // other thing firing costs you, and Stabilize is a Free Action spent from
  // this same round. It does NOT clear on New Round — see recoilTracked().
  //
  // Under the "No Recoil" house rule the counter and its Stabilize button go
  // with the concept (#61): there is nothing to build up and nothing to clear,
  // so a tracker sitting at zero would be furniture asking to be fiddled with.
  if (RULES.recoilInPlay()) {
  const recoil = recoilTracked();
  const ownCap = toIntSafe((CALC.combat || {}).recoil_capacity);
  card.append(el("div", { class: "stat-line" + (recoil ? "" : " dim"),
      title: `Recoil builds by 1 a shot (2 on Full Auto) and is cleared by `
        + `Stabilize, a Free Action. Your own capacity is ${ownCap}; a gun's `
        + `mods can raise its rating above that.` },
    el("span", {}, "Recoil",
      ro ? null : el("button", { class: "sh-complex-btn",
        title: "Stabilize — a Free Action; clears accumulated recoil. "
          + "You cannot stabilize if the gun was fired this round.",
        onclick: () => { CHAR.play.recoil = 0; playChanged(); } }, "Stabilize")),
    el("span", { style: "text-align:right;display:inline-flex;align-items:center;gap:8px" },
      ro ? el("b", { style: recoil ? "" : "color:var(--dim)" }, String(recoil))
         : miniCounter("", recoilTracked, v => { CHAR.play.recoil = v; }, 0, 99))));
  // Master switch for the automatic spend the loadout's Cast/Fire/Aimed
  // Fire/Attack/Reload buttons do (spendActionUnits, below) — off by default
  // so an existing table's habits don't change out from under them; the
  // manual controls above (New Round, the ± counters, the Complex button,
  // Stabilize) always work regardless, since those are the player doing
  // their own bookkeeping rather than the buttons doing it for them.
  }
  card.append(el("label", { class: "opt", style: "margin-top:4px",
      title: "Governs what the loadout's Cast / Fire / Aimed Fire / Attack / "
        + "Reload buttons spend on their own: the round's actions, and the "
        + "recoil a shot builds up." },
    el("input", { type: "checkbox", ...(play.action_costs ? { checked: 1 } : {}),
      disabled: ro ? "1" : null,
      onchange: e => { play.action_costs = e.target.checked; playChanged(); } }),
    el("span", {}, "Enable action costs in loadout")));
  return card;
}

/* The action economy, spendable from every tab (issue: Actions This Round was
 * Overview-only, so spending mid-scene meant tabbing away and back). Lives in
 * the sticky bar rather than the header band the way pools do: .sheet-head
 * scrolls away by design (style.css, "the header no longer eats half a tablet
 * screen"), so the sticky bar is the only chrome that is actually always on
 * screen. One component instead of pools' two (header tile + compact pill)
 * because nothing here needs the extra room a header band would cost against
 * the P13-009 25%-of-viewport budget.
 *
 * Same rows (actionRows()) and the same New Round (newRound()) as
 * actionsCard() — this is a slimmer read on identical state, never a second
 * source of truth. Recoil/Stabilize, the exploit source attributions, and the
 * "Enable action costs" checkbox stay Overview-only: settled choices and
 * reference detail, not per-round counters worth a permanent strip of screen
 * on ten tabs. */
function actionsStrip() {
  const play = CHAR.play;
  const ro = !!(activeTabObj() && activeTabObj().readonly);
  const used = (play.actions_used = play.actions_used || {});
  const rows = actionRows();
  const toggle = () => {
    actionsStripCollapsed = !actionsStripCollapsed;
    try {
      localStorage.setItem("sinless:actionstrip", actionsStripCollapsed ? "collapsed" : "open");
    } catch { /* best-effort */ }
    renderSheet();
  };

  if (actionsStripCollapsed) {
    // Folded, this has to answer one question: what's left to spend? So the
    // summary names every row rather than a bare count — the same reasoning
    // the Conditional Effects panel uses when folded.
    const summary = rows.map(r => {
      const spent = Math.max(0, Math.min(used[r.key] || 0, r.total));
      return `${r.label} ${r.total - spent}/${r.total}`;
    }).join(" · ");
    return el("div", { class: "sh-actions-strip collapsed" },
      ro ? null : counterBtn("↻ New Round", newRound, "good"),
      el("button", { class: "sh-strip-toggle", title: "Show the action counters",
        onclick: toggle }, "▸ Actions"),
      el("span", { class: "sh-apill-summary" }, summary));
  }

  const strip = el("div", { class: "sh-actions-strip" },
    ro ? null : counterBtn("↻ New Round", newRound, "good"),
    el("button", { class: "sh-strip-toggle", title: "Fold the action counters away",
      onclick: toggle }, "▾ Actions"));
  for (const r of rows) {
    const spent = Math.max(0, Math.min(used[r.key] || 0, r.total));
    const left = r.total - spent;
    strip.append(el("span", { class: "sh-apill" + (left ? "" : " spent") },
      el("span", { class: "k" }, r.label), " ",
      el("b", {}, `${left}/${r.total}`),
      (!ro && r.key === "simple")
        ? el("button", { class: "sh-complex-btn",
            title: "Spend a Complex Action (2 Simple Actions)",
            onclick: () => {
              const cur = used.simple || 0;
              const left2 = r.total - cur;
              if (left2 < 2) {
                alert(`Not enough Simple Actions for a Complex Action `
                  + `(need 2, have ${left2}).`);
                return;
              }
              used.simple = cur + 2;
              playChanged();
            } }, "Complex")
        : null,
      // Same available-facing counter as the card (#77): - spends an action,
      // + hands one back. Stored as "used" so the total stays derived.
      ro ? null : miniCounter("", () => left,
        v => { used[r.key] = r.total - v; }, 0, r.total, false)));
  }
  return strip;
}

/* ---- action economy spends ------------------------------------------------
 * actionsCard() above is the read-and-manually-adjust view of
 * `play.actions_used`; these are the "a button got pressed" writes into that
 * same store, so a Cast/Fire/Attack lands exactly like a manual click of the
 * counter would, and New Round clears it the same way either way.
 */

/* Total Exploit Actions of `kind` the build grants — the same total the
 * Actions This Round card lists under "<kind> exploit". */
function exploitActionTotal(kind) {
  return (CALC.combat.exploit_actions || [])
    .filter(a => a.kind === kind)
    .reduce((n, a) => n + a.count, 0);
}

/* Spend `n` action-units, drawing from Exploit Actions of `kind` first (if
 * any are left) and topping up with Simple Actions for the rest — the free
 * extra a martial style or a jumped-in rig grants, only reaching for a
 * Simple Action once that runs out or was never granted. `kind` of null
 * skips the exploit pool entirely (Cast, personal-weapon Fire — nothing
 * grants those an exploit action to draw on first).
 *
 * Never partially spends: a refusal (with a warning naming the actual
 * shortfall) leaves both pools exactly as they were, even when the exploit
 * pool alone would have covered part of `n`.
 *
 * Gated on the "Enable action costs in loadout" checkbox (Actions This
 * Round) — off by default, in which case this is a no-op that always
 * succeeds. That checkbox is the one on/off switch for every automatic
 * spend Cast/Fire/Aimed Fire/Attack/Reload do; the manual controls on
 * Actions This Round itself (New Round, the ± counters, the Complex
 * button) are unaffected either way. */
function spendActionUnits(kind, n, why) {
  if (!CHAR.play.action_costs) return true;
  const used = (CHAR.play.actions_used = CHAR.play.actions_used || {});
  const exploitLeft = kind ? Math.max(0, exploitActionTotal(kind) - (used[kind] || 0)) : 0;
  const simpleLeft = (CALC.combat.simple_actions || 0) - (used.simple || 0);
  if (exploitLeft + simpleLeft < n) {
    alert(kind
      ? `Out of actions — ${why} needs ${n}, you have ${exploitLeft + simpleLeft} left `
        + `(${exploitLeft} ${kind} Exploit + ${simpleLeft} Simple).`
      : `Out of Simple Actions — ${why} needs ${n}, you have ${simpleLeft} left.`);
    return false;
  }
  const fromExploit = Math.min(exploitLeft, n);
  if (fromExploit) used[kind] = (used[kind] || 0) + fromExploit;
  const fromSimple = n - fromExploit;
  if (fromSimple) used.simple = (used.simple || 0) + fromSimple;
  return true;
}

/* ---- recoil -----------------------------------------------------------------
 * Recoil the shooter has soaked up since their last Stabilize. Play state,
 * shown and hand-adjustable on Actions This Round.
 *
 * Deliberately NOT cleared by New Round: "Stabilize a gun (if not fired this
 * round)" is a Free Action in the reference, and spending a Free Action on it
 * is only a decision worth making if recoil outlives the round that caused
 * it. Stabilize is what clears it. */
function recoilTracked() { return Math.max(0, toIntSafe((CHAR.play || {}).recoil)); }

/* How much recoil one gun can soak before its shooter has to stabilize.
 *
 * `calcRow.Recoil` is the engine's per-weapon figure — the character's own
 * capacity plus whatever is bolted to that gun (rules.js sets it for every
 * non-melee, non-thrown weapon). Guns the engine doesn't rate individually
 * fall back to the character's bare capacity, which is exactly what an
 * unmodded gun's rating would have been. Gun-Kata 3's "Ignore Recoil" gives
 * Infinity: that gun never needs steadying. */
function recoilCapacityOf(calcRow) {
  const c = calcRow || {};
  if (c.recoil_ignored) return Infinity;
  if (c.Recoil != null) return toIntSafe(c.Recoil);
  return toIntSafe((CALC.combat || {}).recoil_capacity);
}

/* True when this gun is too unsteady to fire again — checked BEFORE any
 * action is spent or any round leaves the magazine, so a refused shot costs
 * nothing. A null `calcRow` means the weapon doesn't feed the character's
 * tracker at all (drone/vehicle mounts brace against the unit, not a
 * shoulder), so it never blocks. */
function recoilBlocked(label, calcRow) {
  if (!CHAR.play.action_costs || !calcRow) return false;
  const cap = recoilCapacityOf(calcRow);
  const cur = recoilTracked();
  if (cur < cap) return false;
  alert(`${label} is unsteady — recoil ${cur} has reached this gun's Recoil ${cap}.\n\n`
    + "Stabilize (a Free Action) before firing again. "
    + "You cannot stabilize if the gun was fired this round.");
  return true;
}

/* Aiming steadies the weapon. Spending a Complex Action to line the shot up
 * shakes the accumulated recoil out before the trigger is pulled, which is
 * why Aimed Fire is never refused for recoil: it clears the tracker on the
 * way in and leaves only its own shot's point behind.
 *
 * Same two guards as the rest: a null calcRow is a gun that doesn't feed the
 * character's tracker at all, and with the loadout switch off the app isn't
 * touching the player's bookkeeping either way. */
function stabilizeRecoil(calcRow) {
  if (!CHAR.play.action_costs || !calcRow) return;
  CHAR.play.recoil = 0;
}

/* Firing adds recoil: Full Auto shakes loose two, everything else one.
 * Called only after the shot is committed, so it pairs with recoilBlocked's
 * check-first ordering. */
function addRecoil(mode, calcRow) {
  if (!CHAR.play.action_costs || !calcRow) return;
  CHAR.play.recoil = recoilTracked() + (mode === "FA" ? 2 : 1);
}

/* Spend `n` Simple Actions outright, warning and refusing if there aren't
 * enough. Shared by Cast and personal-weapon Fire/Reload — nothing grants
 * those an Exploit Action to draw on first. */
function spendSimpleActions(n, why) {
  return spendActionUnits(null, n, why);
}

/* A melee/unarmed Attack spends a Melee Exploit Action first — the free
 * extra swing a martial style grants — and only reaches for a Simple Action
 * once those are gone, or weren't granted at all. */
function spendMeleeAttack() {
  return spendActionUnits("Melee", 1, "a melee attack");
}

/* `showValue: false` drops the click-to-type number and leaves just −/+.
 * Use it wherever the counter sits beside its own bold readout computed the
 * OTHER way round from what get()/set() store (Actions This Round shows
 * "left", but the counter has to read/write the raw "used" field so New
 * Round and the loadout's auto-spend keep touching the same number) — two
 * numbers stepping in opposite directions next to each other reads as a
 * bug, so don't print the second one. */
function miniCounter(label, get, set, min = 0, max = 9999, showValue = true) {
  const clamp = n => Math.max(min, Math.min(max, n));
  const val = showValue
    ? el("b", { title: "Click to type a value", style: "cursor:text" }, String(get()))
    : null;
  if (val) val.addEventListener("click", () => {
    // The counter's own label names the field. Several callers pass "" because
    // they print a coloured label of their own beside the counter (the
    // Condition tracks, the recoil and dodge rows) — those fall back to the
    // generic name rather than being left with none at all.
    const input = el("input", { type: "number", value: String(get()),
      "aria-label": label || "Value",
      min: String(min), max: String(max), class: "sv-edit", style: "width:56px" });
    val.replaceWith(input); input.focus(); input.select();
    let done = false;
    const commit = save => {
      if (done) return; done = true;
      if (save) {
        const n = parseInt(input.value, 10);
        if (Number.isFinite(n)) { set(clamp(n)); val.textContent = String(get()); }
      }
      input.replaceWith(val);
      if (save) playChanged();
    };
    input.addEventListener("blur", () => commit(true));
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") commit(true);
      else if (e.key === "Escape") commit(false);
    });
  });
  return el("span", { class: "sh-mini" },
    el("span", { class: "lbl" }, label),
    el("button", { class: "mini-btn", onclick: () => { set(clamp(get() - 1)); playChanged(); } }, "−"),
    val,
    el("button", { class: "mini-btn", onclick: () => { set(clamp(get() + 1)); playChanged(); } }, "+"));
}

function conditionTrack(label, max, get, set) {
  const filled = Math.min(get(), max);
  const boxes = el("div", { class: "sh-boxes" });
  for (let i = 1; i <= max; i++) {
    boxes.append(el("button", {
      class: "sh-box" + (i <= filled ? " filled" : "") + (label === "Stun" ? " stun" : ""),
      "aria-label": `${label} box ${i}`,
      onclick: () => { set(i === filled ? i - 1 : i); playChanged(); },
    }, String(i)));
  }
  return el("div", { class: "sh-track" },
    el("div", { class: "sh-track-head" },
      el("span", { class: label === "Stun" ? "stun-lbl" : "phys-lbl" }, label.toUpperCase()),
      el("span", { class: "sub" }, `${filled} / ${max}`)),
    boxes);
}

/* ---- casting (#45) ---------------------------------------------------------
 * Cast puts a spell on the Active Spells banner and leaves it there until it's
 * dismissed. Nothing expires on a timer, for the same reason doses don't:
 * durations in this game are fiction-paced ("until exposed to sunlight",
 * "Special"), and a clock that silently dropped a spell mid-scene would be
 * worse than one the player closes themselves.
 */
function activeSpells() { return (CHAR.play && CHAR.play.active_spells) || []; }

/* The three skills a cast can be rolled on. Nothing in the spells table names a
 * skill — there is no column for it, and School ("Incantor", "Mentalism", …)
 * classifies the magic rather than the test — so the app must not pretend to
 * know. Sorcery leads because it is the general spellcasting skill, and the
 * other two are offered rather than derived (#68). */
const CASTING_SKILLS = ["Sorcery", "Conjuring", "Channeling"];

/* The gear/weapon ZR casting penalty, in dice, or 0.
 *
 * Same test the Magic tab's banner and the Overview's ZR line use: the house
 * rule turns carried ZR into −1d per full point on casting rolls, and Hedge
 * magic is exempt. Factored out because the cast roller now has to APPLY it
 * rather than just describe it — a roll that opened without it would be a die
 * or two too generous, which is the bug #59 fixed for Twin Fire. */
function castingZrPenalty() {
  if (RULES.houseRule("zr") !== "houserule") return 0;
  if (CALC.magic.type === "Hedge") return 0;
  return Math.max(0, Math.floor(CALC.zoetics.gear_zr || 0));
}

/* Configure-then-cast dialog (#68).
 *
 * Force used to be a bare prompt(). Casting now carries three more decisions —
 * which skill is rolling, how many Ley Line dice the site is worth, how many
 * Void Line dice it costs — and a chain of four prompt()s would be four modal
 * boxes with no way to see the total or back out of the third. Every other
 * multi-input flow in play mode is a configure-then-confirm modal (buyDialog
 * for anything priced by its options), so this is the same shape with the cash
 * half removed: choose everything, read the consequences live, commit once.
 *
 * It is deliberately NOT buyDialog itself. buyDialog exists to price choices —
 * it owns a Total line, a cash line and a Buy button that reads "Buy anyway"
 * when you overdraw — and a cast costs no money at all. Bending it here would
 * mean threading "pretend this is free" through a dialog whose whole subject is
 * what things cost. The modal chrome (`mount-modal-backdrop`, `sh-buy-field`)
 * is shared; the money is not.
 *
 * Resolves to { force, skill, ley, void } or null if cancelled. */
function castDialog({ name, knownForce, zp, row }) {
  return new Promise(resolve => {
    const state = { force: knownForce, skill: CASTING_SKILLS[0], ley: 0, void: 0 };
    const backdrop = el("div", { class: "mount-modal-backdrop" });
    const done = v => { document.removeEventListener("keydown", onKey); backdrop.remove(); resolve(v); };
    const onKey = e => { if (e.key === "Escape") done(null); };

    const drainLine = el("div", { class: "sh-buy-total" });
    const soakLine = el("div", { class: "sub" });
    const poolLine = el("div", { class: "sub" });
    const castBtn = el("button", { class: "btn-add", onclick: () => done(state) }, "✦ Cast");

    // Number field rather than a select: Ley and Void dice are a table call with
    // no fixed ceiling, so an enumerated list would be guessing where to stop.
    const numField = (key, label, hint) => {
      const input = el("input", { type: "number", min: "0", max: String(ROLLER_MAX_DICE),
        value: "0", style: "width:80px", "aria-label": label,   // the <b> below is the visible copy
        oninput: e => {
          state[key] = Math.max(0, Math.min(ROLLER_MAX_DICE, parseInt(e.target.value, 10) || 0));
          refresh();
        } });
      return el("div", { class: "sh-buy-field" }, el("b", {}, label), input,
        el("div", { class: "sub" }, hint));
    };

    const refresh = () => {
      const drain = RULES.spellDrain(row.Drain, state.force);
      const lethal = RULES.drainIsLethal(state.force, zp);
      drainLine.replaceChildren(
        el("span", { class: "sub" }, "Drain "),
        el("b", { style: `color:var(--${lethal ? "bad" : "ok"})` },
          drain == null ? `${row.Drain || "Special"} (table decides)`
            : `${drain} ${lethal ? "LETHAL" : "Stun"}`));
      // Restated live as the Force slides, because crossing ZP changes not just
      // how much drain there is but which pools may soak it (#68) — that is the
      // consequence worth seeing BEFORE committing, not after.
      soakLine.textContent = drainSoakText(name, lethal);
      const sk = CALC.skills[state.skill] || { final: 0, dice_bonus: 0 };
      const zr = castingZrPenalty();
      // Terms, not a total. The roller is the authority on the final count —
      // it takes wound penalties off on top of these — so printing a bottom
      // line here would be a second implementation of the same arithmetic,
      // free to drift from the one that actually rolls.
      poolLine.textContent =
        `Casting roll: ${sk.final} ${state.skill}`
        + (sk.dice_bonus ? ` + ${sk.dice_bonus} skill bonus` : "")
        + (state.ley ? ` + ${state.ley} Ley Line` : "")
        + (state.void ? ` − ${state.void} Void Line` : "")
        + (zr ? ` − ${zr} gear ZR` : "")
        + " · wound penalties come off in the roller.";
    };

    const forceSel = el("select", { onchange: e => { state.force = +e.target.value; refresh(); } },
      ...Array.from({ length: knownForce }, (_, i) => {
        const f = i + 1;
        return el("option", { value: String(f) },
          `Force ${f}${f > zp ? " — drain is LETHAL" : ""}`);
      }));
    forceSel.value = String(knownForce);

    const skillSel = el("select", { onchange: e => { state.skill = e.target.value; refresh(); } },
      ...CASTING_SKILLS.map(s => el("option", { value: s },
        `${s} (${(CALC.skills[s] || { final: 0 }).final}d)`)));
    skillSel.value = state.skill;

    const modal = el("div", { class: "card mount-modal", style: "max-width:460px" },
      el("h3", {}, `Cast ${name}`),
      el("p", { class: "hint" },
        `Your ZP is ${zp}. At Force ${zp + 1} or higher the Drain lands as LETHAL `
        + `(physical-based) damage instead of Stun, which changes how it can be `
        + `soaked. Casting is a Complex Action (2 Simple).`),
      el("div", { class: "sh-buy-field" }, el("b", {}, "Force"), forceSel),
      el("div", { class: "sh-buy-field" }, el("b", {}, "Casting skill"), skillSel),
      numField("ley", "Ley Line dice", "Bonus dice from a ley line or other favourable site."),
      numField("void", "Void Line dice", "Penalty dice from a void line or hostile mana."),
      el("div", { class: "sh-buy-foot" }, drainLine, soakLine, poolLine),
      el("div", { style: "display:flex;gap:8px;margin-top:12px" },
        castBtn,
        el("button", { class: "btn", onclick: () => done(null) }, "Cancel")));
    backdrop.append(modal);
    backdrop.addEventListener("click", e => { if (e.target === backdrop) done(null); });
    document.addEventListener("keydown", onKey);
    document.body.append(backdrop);
    refresh();
  });
}

/* Cast at a chosen Force, up to the Force the spell is known at.
 *
 * Force is asked for rather than assumed, because it decides three separate
 * things at once: the spell's own Force-scaled effects, how much Drain it
 * deals, and — the part worth being loud about — whether that Drain is Stun or
 * LETHAL. The dialog states the consequence before the player commits, and
 * since #68 collects the Ley/Void dice for the casting roll in the same pass. */
async function castSpell(name, knownForce, after) {
  const zp = CALC.zoetics.zp_remaining;
  const row = DATA.tables.spells.find(x => x.Name === name) || {};
  const choice = await castDialog({ name, knownForce, zp, row });
  if (!choice) return;
  const force = Math.max(1, Math.min(knownForce, choice.force || 0));
  if (!force) return;
  // A cast is a Complex Action — 2 Simple Actions — same as pressing the
  // Complex button on Actions This Round, just spent from here instead.
  if (!spendSimpleActions(2, `Casting ${name}`)) return;
  const drain = RULES.spellDrain(row.Drain, force);
  const lethal = RULES.drainIsLethal(force, zp);
  CHAR.play.active_spells = activeSpells();
  CHAR.play.active_spells.push({
    uid: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name, force, lethal, drain,
    // The line dice are recorded on the cast, not just spent on the roll: they
    // are the reason this cast rolled what it did, and a player re-reading the
    // Running Now list mid-scene should be able to see that the +3 came from a
    // ley line rather than wonder where it went. Both are optional, so old
    // records without them keep working (the row treats absent as 0).
    ley: choice.ley || 0, void: choice.void || 0,
  });
  // Whatever the cast is FOR — stepping into a shape, pointing a familiar at an
  // animal — happens here, after the Force is known and before the state is
  // saved, so one press does one whole thing.
  if (after) after(force);
  await playChangedRecalc();
  // State the Drain and, per #68, exactly how it may be soaked — the two cases
  // are not the same test and the old message named the wrong pool for both.
  // The soak itself is rollable from the active-spell row rather than from
  // here, so the alert can be dismissed without losing the offer.
  const damage = lethal ? "LETHAL" : "Stun";
  alert(`${name} cast at Force ${force}.\n\n`
    + (drain == null
        ? `Drain: ${row.Drain || "Special"} — this spell states no fixed Drain; the table decides.`
        : `Soak ${drain} Drain, taken as ${damage} damage.`)
    + `\n\n${drainSoakText(name, lethal)}`
    + `\n\nThe soak buttons on the Active Spells row load the right pool.`);
  // The casting roll comes last so it is what's left on screen: the alert above
  // is a statement about a cost that lands AFTER the spell goes off, while this
  // is the roll being made right now.
  openCastingRoller(name, force, choice);
}

/* Open the roller for the casting roll itself, with the line dice applied.
 *
 * Ley Line dice are BONUS dice — they come from the site, not from the caster —
 * so they go in `bonus` and cost no pool, exactly like a firing mode's free
 * dice. Void Line dice are the mirror: a penalty the TEST carries, which is
 * what `extraPenalty` is for (#59), so they arrive already taken off rather
 * than being left for the player to dial in and forget. The gear-ZR casting
 * penalty rides in the same number for the same reason. */
function openCastingRoller(name, force, choice) {
  const sk = CALC.skills[choice.skill] || { final: 0, dice_bonus: 0, pool: "Resolve" };
  const ley = choice.ley || 0;
  const voidD = choice.void || 0;
  const zr = castingZrPenalty();
  const penaltyBits = [voidD ? "Void Line" : null, zr ? "Gear ZR" : null].filter(Boolean);
  openPoolRoller({
    dice: sk.final, bonus: (sk.dice_bonus || 0) + ley, pool: sk.pool,
    label: `Cast ${name} (F${force})`,
    note: `${sk.final} ${choice.skill}`
      + (sk.dice_bonus ? ` + ${sk.dice_bonus} skill bonus` : "")
      + (ley ? ` + ${ley} Ley Line` : "")
      + (voidD ? ` · −${voidD} Void Line` : "")
      + (zr ? ` · −${zr} gear ZR` : ""),
    extraPenalty: voidD + zr,
    penaltyLabel: penaltyBits.length ? penaltyBits.join(" + ") : null,
  });
}

function dismissSpell(uid) {
  const going = activeSpells().find(s => s.uid === uid);
  CHAR.play.active_spells = activeSpells().filter(s => s.uid !== uid);
  // Dismissing Shapeshift ends the shape with it. Leaving a form worn after the
  // spell that granted it has gone would be a character stuck as a bear with
  // nothing on the sheet explaining why.
  if (going && RULES.isFormSpell(going.name)
      && !activeSpells().some(s => s.name === going.name)
      && CHAR.play.shapeshift) {
    CHAR.play.shapeshift.active = "";
  }
  // Returned so a caller outside #sheet -- the Running Now popover, which lives
  // on document.body and is not rebuilt by a re-render -- can refresh itself
  // once the dismissal has actually landed.
  return playChangedRecalc();
}

/* Is this spell currently up? Shapeshift's forms are free to switch between
 * while it is, and cost a fresh cast when it isn't. */
function spellIsActive(name) {
  return activeSpells().some(s => s.name === name);
}

/* The Active Spells banner. Magic tab only, per the issue — it's a caster's
 * working surface, and a mundane character should never see an empty one. */
/* One active spell as a row: what it is, at what Force, and what it will cost
 * to soak. `detail` adds the duration, effect prose and summoned-creature line
 * -- the Magic tab wants all of it, the header popover wants the head row only,
 * so the popover is a strict subset rather than a second implementation.
 *
 * `after` runs once a dismissal has landed, for callers that live outside
 * #sheet and are not rebuilt by the re-render. */
/* ---- drain soak (#68) ------------------------------------------------------
 * Which Fetish, if any, helps this spell's soak. `allGear()` is the play-mode
 * view of what the character HAS — the deep-copied kit plus anything bought in
 * play — which is the list that can have a Fetish in it after Finalize; the
 * chargen array is the wrong one to read past the bright line. */
function fetishFor(name) {
  return RULES.fetishesForSpell(allGear(), name);
}

/* One sentence stating how this drain may be soaked, Fetish included.
 *
 * Kept as a string rather than nodes because the same words have to go in two
 * places that take different things: the post-cast alert (plain text) and the
 * active-spell row (a `sub` line). One source, so the ruling cannot be right in
 * one place and stale in the other. */
function drainSoakText(name, lethal) {
  const fet = fetishFor(name);
  // "LETHAL" is this app's word for physical-based drain everywhere else (the
  // chip, the Magic tab hint), so it leads and "physical" follows in
  // parentheses rather than the other way round — one vocabulary, or the player
  // has to work out that two labels mean the same track.
  const base = lethal
    ? "Soak: LETHAL (physical-based) drain can ONLY be soaked with Channeling — Brawn does not apply."
    : "Soak: Stun-based drain is soaked with Channeling FIRST, then Brawn on what's left.";
  if (!fet.bonus) return base;
  // Stated as an applied bonus because it IS decidable from the data: the
  // Fetish's `link` names this exact spell. Anything vaguer would be a reminder
  // instead — see fetishesForSpell.
  return `${base} ${fet.best.name} is linked to ${name}: +${fet.bonus}d on the Channeling roll.`
    + (fet.all.length > 1
        ? ` (${fet.all.length} linked Fetishes — the best one applies, they don't stack.)`
        : "");
}

/* The soak roll buttons for one active spell.
 *
 * Reuses openPoolRoller the way the Condition card's Soak button does rather
 * than reimplementing anything: Channeling rolls out of its own pool (Resolve)
 * with the Fetish as free bonus dice, and Brawn is the Condition card's soak
 * shape — no limit dice, dial in what you're spending.
 *
 * Brawn deliberately does NOT preload CALC.combat.soak_bonus the way the
 * Condition card does. Those passive dice come from heritage and martial arts
 * as *damage* soak; nothing in the data says they resist Drain, and loading
 * them here would be inventing a bonus rather than reading one. The Brawn
 * button is offered only on Stun drain, because on physical drain there is no
 * legal Brawn roll to offer at all. */
function drainSoakButtons(s) {
  const fet = fetishFor(s.name);
  const ch = CALC.skills.Channeling || { final: 0, dice_bonus: 0, pool: "Resolve" };
  const chBonus = (ch.dice_bonus || 0) + fet.bonus;
  const btns = [el("button", { class: "btn small roll",
    title: `Soak Drain with Channeling${fet.bonus ? ` — includes ${fet.best.name} +${fet.bonus}d` : ""}`,
    onclick: () => openPoolRoller({
      dice: ch.final, bonus: chBonus, pool: ch.pool || "Resolve",
      label: `Drain soak — Channeling (${s.name} F${s.force})`,
      note: `${ch.final} Channeling`
        + (ch.dice_bonus ? ` + ${ch.dice_bonus} skill bonus` : "")
        + (fet.bonus ? ` + ${fet.bonus} ${fet.best.name}` : "")
        + (s.drain == null ? "" : ` · ${s.drain} Drain to soak`),
    }) }, "⚄ Channeling")];
  if (!s.lethal) {
    btns.push(el("button", { class: "btn small roll",
      title: "Soak what Channeling left over with Brawn — Stun drain only",
      onclick: () => openPoolRoller({
        dice: 0, bonus: 0, pool: "Brawn",
        label: `Drain soak — Brawn (${s.name} F${s.force})`,
        note: "Second soak, after Channeling — dial in the Brawn you're spending",
      }) }, "⚄ Brawn"));
  }
  // No spacer text nodes: .sh-drain-soak is a flex row and gap does the
  // spacing, whereas a " " between buttons would become its own flex item.
  return el("div", { class: "sh-drain-soak" }, ...btns);
}

function activeSpellRow(s, { detail = false, ro = false, after = null } = {}) {
  const row = DATA.tables.spells.find(x => x.Name === s.name) || {};
  const summon = detail
    ? RULES.summonedAnimal(s.name, (CHAR.play.summons || {})[s.name], s.force, DATA.tables)
    : null;
  return el("div", { class: "sh-active-spell" },
    el("div", { class: "sh-fx-head" },
      el("span", {}, el("b", {}, s.name), " ",
        el("span", { class: "chip magic" }, `F${s.force}`), " ",
        el("span", { class: "chip" + (s.lethal ? " neg" : " ok") },
          s.drain == null ? "drain: special"
            : `drain ${s.drain} ${s.lethal ? "LETHAL" : "stun"}`),
        // The line dice this cast was made with. Shown only when non-zero so a
        // plain cast reads exactly as it did before (#68).
        s.ley ? el("span", { class: "chip ok" }, `ley +${s.ley}d`) : null,
        s.void ? el("span", { class: "chip neg" }, `void −${s.void}d`) : null),
      ro ? null : el("button", { class: "row-del", title: "Dismiss this spell",
        onclick: () => { const r = dismissSpell(s.uid); if (after) r.then(after); } }, "✕")),
    // How this drain is soaked, stated wherever the drain chip is (#68) — the
    // Magic tab banner and the header's Running Now popover both get it, since
    // both are surfaces a player consults mid-scene with drain still to take.
    el("div", { class: "sub" }, drainSoakText(s.name, s.lethal)),
    drainSoakButtons(s),
    detail && row.Duration ? el("div", { class: "sub" }, `Duration: ${row.Duration}`) : null,
    detail && row.Effect ? el("div", { class: "sub" }, row.Effect) : null,
    // A summoning spell that's up shows what it summoned, at the Force it was
    // actually cast at rather than the Force it's known at.
    summon ? el("div", { class: "sub", style: "color:var(--manon)" },
      `${summon.label}: ${summon.name} — Armor ${summon.ballistic}B/${summon.impact}I`
      + ` · Dodge ${summon.dodge} · Soak ${summon.soak}`
      + (summon.attacks.length ? ` · ${summon.attacks[0]}` : "")) : null);
}

function activeSpellsBanner() {
  const list = activeSpells();
  if (!list.length) return null;
  const ro = !!(activeTabObj() && activeTabObj().readonly);
  const card = el("div", { class: "sh-callout sh-active-spells" },
    el("div", { class: "sh-doses-head" },
      el("span", {}, "✨ Active Spells ", el("b", {}, String(list.length)))));
  for (const s of list) card.append(activeSpellRow(s, { detail: true, ro }));
  card.append(el("p", { class: "hint" },
    "Spells stay up until dismissed — durations here are fiction-paced, so nothing "
    + "expires on a clock. Bonuses a spell grants are applied by adding it under "
    + "Temporary Effects with a pool and dice."));
  return card;
}

/* The Shapeshift form currently worn, resolved, or null in your own skin.
 *
 * Lives in the Conditional Effects panel rather than on the Condition card:
 * being shifted is exactly what that panel is for — a thing you switched on
 * that changes what your numbers mean, sitting beside the Wildling shift, a
 * triggered Adrenal Pump and the rest.
 *
 * The animal's own numbers are shown but NOT applied to the character. The
 * spell heals "1d6 boxes from both their physical and stun condition track" —
 * the CASTER's tracks, which means the caster keeps their own and the animal's
 * are reference. Swapping the tracks out would also silently rewrite recorded
 * damage every time someone shifted, which is a much worse failure than making
 * the player read two numbers. */
function shiftedForm() {
  const force = shapeshiftForce();
  const st = RULES.shapeshiftState(CHAR, force);
  if (!st.active) return null;
  return RULES.summonedAnimal("Shapeshift", st.active, force, DATA.tables);
}

/* The worn form as a row for the Conditional Effects panel. */
function shiftedFormRow(s, after = null) {
  const ro = !!(activeTabObj() && activeTabObj().readonly);
  return el("div", { class: "sh-fx-row on sh-shifted" },
    el("div", { class: "sh-fx-what" },
      el("span", { class: "sh-fx-name" }, "🐾 Shifted — ", el("b", {}, s.name),
        el("span", { class: "sub" }, " · Shapeshift")),
      animalStatBlock(s),
      el("div", { class: "sh-fx-text sub" },
        "Your own Condition tracks still apply — the form's is what it would "
        + "have as a creature.")),
    ro ? null : el("button", { class: "btn warn", title: "Return to your own shape",
      onclick: () => {
        CHAR.play.shapeshift.active = "";
        const r = playChangedRecalc();
        if (after) r.then(after);
      } }, "Revert"));
}

/* The Force the character knows Shapeshift at, or 0 if they don't know it.
 * Chargen force plus any play advance, matching how the Magic tab reads it. */
function shapeshiftForce() {
  const play = CHAR.play || {};
  const all = [...((CHAR.magic || {}).spells || []),
               ...(((play.purchases || {}).spells) || [])];
  const sp = all.find(s => s && s.name === "Shapeshift");
  if (!sp) return 0;
  return toIntSafe(sp.force) + toIntSafe((play.spell_force_advances || {})["Shapeshift"]);
}

/* Shapeshift: the forms a caster knows, and the one they're wearing.
 *
 * Unlike the two summoning spells this picks SEVERAL animals — "a number equal
 * to the Force of the spell" — and then wears one at a time. So it's a list you
 * add to and remove from, plus a Shift control per row, rather than a dropdown.
 *
 * Two states worth being careful with. Picks beyond the current allowance are
 * shown greyed rather than deleted: Force can go down (a re-import, an undone
 * advance) and quietly dropping forms a player chose would be the worst reading
 * of "the limit is Force". And the active form is cleared whenever it falls
 * outside the allowance, so a character can never be wearing a form they no
 * longer know. */
function shapeshiftPicker(spellName, force) {
  const play = CHAR.play;
  const ro = !!(activeTabObj() && activeTabObj().readonly);
  play.shapeshift = play.shapeshift || { picks: [], active: "" };
  const st = RULES.shapeshiftState(CHAR, force);
  const animals = DATA.tables.animals || [];
  const save = () => playChangedRecalc();
  // Whether the spell is currently up decides what a Shift press means.
  const up = spellIsActive(spellName);

  // The add control, or nothing when the allowance is full. Built here rather
  // than inline so the header below stays one readable expression.
  const taken = new Set(st.picks);
  const addSel = (ro || !st.remaining) ? null : el("select", {
    title: `Add a form — Force ${st.limit} allows ${st.limit}`,
    onchange: e => {
      if (!e.target.value) return;
      play.shapeshift.picks = [...st.picks, e.target.value];
      save();
    } },
    el("option", { value: "" }, "Add a form…"),
    ...animals.filter(a => !taken.has(a.Animal))
              .map(a => el("option", { value: a.Animal }, a.Animal)));

  const rows = [el("div", { class: "sh-summon-pick" },
    el("span", { class: "sub" },
      `Forms known ${st.allowed.length}/${st.limit}`
      + (st.remaining ? ` — ${st.remaining} still to choose` : "")),
    addSel)];

  if (!st.picks.length) {
    rows.push(el("div", { class: "sub" },
      "No forms chosen yet. Casting this at Force "
      + `${st.limit} lets you carry ${st.limit}.`));
  }

  st.picks.forEach((name, i) => {
    const beyond = i >= st.limit;
    const isActive = !beyond && name === st.active;
    rows.push(el("div", { class: "sh-form-row" + (isActive ? " on" : "") + (beyond ? " over" : "") },
      el("span", {}, name,
        isActive ? el("span", { class: "chip ok", style: "margin-left:6px" }, "shifted") : null,
        beyond ? el("span", { class: "chip neg", style: "margin-left:6px" }, "over Force") : null),
      ro ? null : el("span", { class: "sh-form-btns" },
        beyond ? null : el("button", {
          class: "btn small" + (isActive ? "" : " btn-add"),
          title: isActive
            ? "Return to your own shape"
            : up
              ? `Shift into ${name} — a Complex action, no new casting`
              : `Cast Shapeshift and step into ${name}`,
          onclick: () => {
            if (isActive) { play.shapeshift.active = ""; save(); return; }
            // Already up: switching between chosen forms is a Complex action
            // within the duration, so it costs no new cast and no new Drain —
            // that's the spell's own wording. Not up: this IS the cast, which
            // is why the spell has no separate Cast button.
            if (up) { play.shapeshift.active = name; save(); return; }
            // Only the CAST heals. Stepping between forms already held is a
            // Complex action inside the same spell (the branch above), and
            // healing on each step would make one cast an unbounded heal.
            castSpell(spellName, st.limit, () => {
              play.shapeshift.active = name;
              healOnShift("Shapeshift", true);   // 1d6 Stun and 1d6 Physical (#67)
            });
          } }, isActive ? "Revert" : (up ? "Shift" : "Cast & Shift")),
        el("button", { class: "row-del", title: `Forget the ${name} form`,
          onclick: () => {
            play.shapeshift.picks = st.picks.filter((_, j) => j !== i);
            if (play.shapeshift.active === name) play.shapeshift.active = "";
            save();
          } }, "✕"))));
  });

  if (st.over.length) {
    rows.push(el("div", { class: "sub", style: "color:var(--amber)" },
      `${st.over.length} form${st.over.length === 1 ? "" : "s"} beyond what Force `
      + `${st.limit} allows — raise the Force or drop ${st.over.length === 1 ? "it" : "some"}.`));
  }

  // The worn form's full statblock, resolved the same way a summon's is.
  const s = st.active
    ? RULES.summonedAnimal(spellName, st.active, force, DATA.tables) : null;
  if (s) rows.push(animalStatBlock(s));
  return el("div", { class: "sh-summon" }, ...rows);
}

/* One resolved animal's numbers, shared by the summon picker, the Shapeshift
 * picker and the Condition card, so a form reads identically wherever it's
 * shown. */
function animalStatBlock(s) {
  const move = [s.move ? `${s.move}m` : null, s.flight ? `Fly ${s.flight}m` : null]
    .filter(Boolean).join(" · ") || "—";
  return el("div", { class: "sh-summon-stats" },
    el("div", { class: "sub" },
      `Move ${move} · Init ${s.initiative} · Condition ${s.condition} boxes`
      + ` · Armor ${s.ballistic}B/${s.impact}I`
      + (s.hardening ? ` · Hardening ${s.hardening}` : "")
      + ` · Dodge ${s.dodge} · Soak ${s.soak}`),
    ...s.attacks.map(a => el("div", { class: "sub" }, "⚔ " + a)),
    s.attacks.length ? null : el("div", { class: "sub" }, "No attacks"),
    s.pool_bonus
      ? el("div", { class: "sub" }, `+${s.pool_bonus} Brawn / Finesse / Resolve pool dice`) : null,
    ...s.notes.map(n => el("div", { class: "sub", style: "color:var(--manon)" }, n)));
}

/* The animal a summoning spell is pointed at, and what it becomes (#47).
 *
 * Renders nothing at all for an ordinary spell, so it can be dropped into the
 * spell row unconditionally. The choice is play state keyed by spell name — a
 * caster keeps one Bound Servant at a time, and re-picking replaces it.
 *
 * The statblock is recomputed from the animal and the current Force on every
 * render rather than being stored: advance the spell's Force and a Darkenbeast's
 * armor follows it, which is the whole reason the modified stats are worth
 * showing instead of leaving the player to do the arithmetic. */
function summonPicker(spellName, force) {
  if (!RULES.isSummonSpell(spellName)) return null;
  if (RULES.isFormSpell(spellName)) return shapeshiftPicker(spellName, force);
  const play = CHAR.play;
  const ro = !!(activeTabObj() && activeTabObj().readonly);
  play.summons = play.summons || {};
  const chosen = play.summons[spellName] || "";
  const animals = DATA.tables.animals || [];

  const sel = el("select", {
    title: "Which animal this spell is on",
    onchange: async e => {
      const v = e.target.value;
      if (v) play.summons[spellName] = v; else delete play.summons[spellName];
      await playChangedRecalc();
    } },
    el("option", { value: "" }, "— no animal chosen —"),
    ...animals.map(a => el("option", { value: a.Animal }, a.Animal)));
  sel.value = chosen;

  const rows = [el("div", { class: "sh-summon-pick" },
    el("span", { class: "sub" }, `${RULES.SUMMON_SPELLS[spellName].label}: `),
    ro ? el("span", {}, chosen || "none") : sel)];

  const s = RULES.summonedAnimal(spellName, chosen, force, DATA.tables);
  if (s) {
    rows.push(animalStatBlock(s));
  } else if (chosen) {
    rows.push(el("div", { class: "sub", style: "color:var(--amber)" },
      `Nothing in the animals table answers to “${chosen}” — it may be homebrew this browser doesn't have.`));
  }
  return el("div", { class: "sh-summon" }, ...rows);
}

/* Fold any legacy Active Modifiers into the single list (#57).
 *
 * play.modifiers is left in place but emptied rather than deleted: a character
 * saved by this build can still be opened by an older one, and an older build
 * reading a missing key is a different failure from reading an empty list.
 * Runs on render, so it costs nothing once done. */
function mergeTrackedEffects(play) {
  if (!Array.isArray(play.modifiers) || !play.modifiers.length) return;
  play.effects = play.effects || [];
  play.effects.push(...play.modifiers);
  play.modifiers = [];
  schedulePlaySave();
}

/* The character description, on the Notes tab.
 *
 * It used to sit in the sheet header, between identity and the meters. It never
 * changes mid-session and the markdown export does not even emit it, so it was
 * failing the header comment test -- what that band carries is what you consult
 * every round -- while holding 400-600px of the one strip visible from all ten
 * tabs, and growing the header when someone wrote a paragraph.
 *
 * Two things must not drift. The READ falls back to the chargen record, because
 * CHAR.description is what the markdown importer restores and play.description
 * starts null. The WRITE stays on play.description: writing through to
 * CHAR.description would let the first keystroke in play rewrite how the
 * character was BUILT. */
function descriptionCard() {
  const play = CHAR.play;
  const ro = !!(activeTabObj() && activeTabObj().readonly);
  const ta = el("textarea", { class: "sh-notes", rows: "10",
    placeholder: "Character description…", spellcheck: "true",
    ...(ro ? { readonly: "1" } : {}),
    oninput: e => { play.description = e.target.value; playChanged(false); } });
  // Set after construction, not as a child: a textarea child text node and its
  // .value diverge the moment the user types. Same reason notesCard does it.
  ta.value = play.description ?? CHAR.description ?? "";
  return el("div", { class: "card sh-card" },
    el("h3", {}, "Description"),
    el("p", { class: "hint", style: "margin:2px 0 8px" },
      "How this character looks and carries themselves. Saves automatically while you type."),
    ta);
}
/* The one list of things currently changing your dice, each row a small form
 * (#46, merged in #57).
 *
 * The header chip counts how many are actually moving dice, not how many rows
 * exist — a list of six reminders and a list of six live penalties are very
 * different situations, and the pool tiles only reflect the second. */
function trackedEffectList(title, items, addLabel, placeholder, emptyText) {
  const live = items.filter(e => e && e.pool && toIntSafe(e.dice));
  const card = el("div", { class: "card sh-card" },
    el("div", { class: "sh-card-head" },
      el("h3", {}, title, " ",
        el("span", { class: "chip" + (live.length ? " ok" : "") }, String(items.length))),
      counterBtn(addLabel, () => {
        const name = (prompt(`Name (e.g. ${placeholder}):`) || "").trim();
        if (!name) return;
        items.push({ name, pool: "", dice: 0 });
        playChanged();
      }, "accent")));
  if (!items.length) {
    card.append(el("p", { class: "hint", style: "margin:6px 0 0" }, emptyText));
  } else {
    items.forEach((it, i) => card.append(trackedEffectRow(it, items, i)));
    if (live.length) {
      const sum = {};
      for (const e of live) sum[e.pool] = (sum[e.pool] || 0) + toIntSafe(e.dice);
      card.append(el("p", { class: "hint" }, "In your pools: "
        + Object.entries(sum).map(([p, n]) => `${n > 0 ? "+" : ""}${n}d ${p}`).join(" · ")));
    }
  }
  return card;
}

function notesCard(rows) {
  // Read-only shares must not invite typing that will silently not persist --
  // schedulePlaySave() already returns early, but nothing said so. The attribute
  // rather than pointer-events, so the text stays selectable and copyable.
  const ro = !!(activeTabObj() && activeTabObj().readonly);
  const ta = el("textarea", { class: "sh-notes", rows: String(rows || 6),
    placeholder: "Character notes, session logs, reminders…",
    ...(ro ? { readonly: "1" } : {}),
    oninput: e => { CHAR.play.notes = e.target.value; playChanged(false); } });
  ta.value = CHAR.play.notes || "";
  return el("div", { class: "card sh-card" },
    el("h3", {}, "Notes"),
    el("p", { class: "hint", style: "margin:2px 0 8px" }, "Notes save automatically while you type."),
    ta);
}

/* ---- character images (portrait, crest, …) --------------------------------
 * Stored on the character as data URLs, so a picture travels with a save, a
 * cloud sync and a JSON export instead of living only on one device. The cost
 * is that images share the server's 256 KB per-character payload cap
 * (read_json_body in api/lib.php rejects anything bigger with a 413), so
 * everything here exists to keep a save from ever being refused: uploads are
 * downscaled and re-encoded, and the running total is checked before storing. */
const IMAGE_MAX_EDGE = 512;      // longest side, px — plenty for a sheet portrait
const IMAGE_MAX_COUNT = 6;
const IMAGE_BUDGET = 180 * 1024; // total data-URL chars across all images
const imageBytes = url => (url || "").length;
const imagesUsed = () => (CHAR.play.images || []).reduce((n, im) => n + imageBytes(im.url), 0);
const fmtKB = n => `${Math.round(n / 1024)} KB`;

/* Downscale + re-encode a picked file, returning { url, bytes, flattened }.
 * `room` is how many data-URL chars are still available.
 *
 * Transparency only survives PNG, and PNG of a photo is enormous, so the format
 * follows the image: alpha means a logo, no alpha means a picture. A big
 * transparent logo shrinks — still as PNG — before transparency is given up,
 * because a smaller crest beats a crest with a rectangle of background behind
 * it. Only when no PNG size fits does it flatten to JPEG, and it says so.
 * Rejects with a message fit to show the user. */
function prepareImage(file, room) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error("Couldn't read that file."));
    fr.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error(`${file.name} isn't an image this browser can read.`));
      img.onload = () => {
        const draw = edge => {
          const scale = Math.min(1, edge / Math.max(img.width, img.height));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(img.width * scale));
          canvas.height = Math.max(1, Math.round(img.height * scale));
          canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
          return canvas;
        };
        const full = draw(IMAGE_MAX_EDGE);
        const px = full.getContext("2d").getImageData(0, 0, full.width, full.height).data;
        let hasAlpha = false;
        for (let i = 3; i < px.length; i += 4) { if (px[i] < 255) { hasAlpha = true; break; } }

        const fits = url => imageBytes(url) <= room;
        let best = null;                       // smallest thing we produced, for the error
        const consider = (url, flattened) => {
          if (!best || imageBytes(url) < imageBytes(best.url)) best = { url, flattened };
          return fits(url) ? { url, bytes: imageBytes(url), flattened } : null;
        };
        if (hasAlpha) {
          for (const edge of [IMAGE_MAX_EDGE, 384, 256, 160]) {
            const hit = consider(draw(edge).toDataURL("image/png"), false);
            if (hit) { resolve(hit); return; }
          }
        }
        for (const edge of [IMAGE_MAX_EDGE, 384, 256]) {
          const canvas = draw(edge);
          for (const q of [0.82, 0.7, 0.58, 0.46]) {
            const hit = consider(canvas.toDataURL("image/jpeg", q), hasAlpha);
            if (hit) { resolve(hit); return; }
          }
        }
        reject(new Error(`${file.name} won't fit — needs at least `
          + `${fmtKB(imageBytes(best.url))}, ${fmtKB(Math.max(0, room))} free. `
          + `Remove an image first.`));
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

function imagesCard() {
  CHAR.play.images = CHAR.play.images || [];
  const list = CHAR.play.images;
  const used = imagesUsed();
  // Pictures are the tallest thing on the Notes tab and the least often needed
  // once they're set, so the whole section folds. The state is per-tab view
  // state (stashView/restoreView), same as the expanded pool card, so it
  // survives re-renders and tab switches without touching the character.
  const collapsed = imagesCollapsed;
  const card = el("div", { class: "card sh-card" },
    el("div", { class: "sh-card-head" },
      el("h3", {}, "Images",
        list.length ? el("span", { class: "sub" }, ` ${list.length}`) : null),
      counterBtn(collapsed ? "Show ▾" : "Hide ▴", () => {
        imagesCollapsed = !imagesCollapsed;
        renderSheet();
      })));
  if (collapsed) {
    card.append(el("p", { class: "hint", style: "margin:2px 0 0" },
      list.length
        ? `${list.length} image${list.length === 1 ? "" : "s"} · ${fmtKB(used)} — hidden.`
        : "No images."));
    return card;
  }
  card.append(el("p", { class: "hint", style: "margin:2px 0 8px" },
    `Portrait, crest, gang logo — up to ${IMAGE_MAX_COUNT}. Saved with the character, `
    + `so they sync and travel in an export. Large files are scaled to `
    + `${IMAGE_MAX_EDGE}px and re-compressed to stay inside the size limit.`));

  const grid = el("div", { class: "sh-imgs" });
  list.forEach((im, i) => {
    const shot = el("img", { class: "sh-img" + (im.big ? " big" : ""), src: im.url,
      alt: im.caption || "Character image", title: "Click to enlarge",
      onclick: () => { im.big = !im.big; playChanged(); } });
    const cap = el("input", { type: "text", placeholder: "Caption…",
      oninput: e => { im.caption = e.target.value; playChanged(false); } });
    cap.value = im.caption || "";
    grid.append(el("div", { class: "sh-img-cell" }, shot,
      el("div", { class: "sh-img-foot" }, cap,
        el("button", { class: "row-del", title: "Remove this image",
          onclick: () => { list.splice(i, 1); playChanged(); } }, "✕")),
      el("div", { class: "sub" }, fmtKB(imageBytes(im.url)))));
  });
  if (list.length) card.append(grid);

  const status = el("div", { class: "hint" },
    `${list.length} / ${IMAGE_MAX_COUNT} images · ${fmtKB(used)} of ${fmtKB(IMAGE_BUDGET)} used`);
  const picker = el("input", { type: "file", accept: "image/*", multiple: "1",
    style: "display:none",
    onchange: async e => {
      const files = [...e.target.files];
      e.target.value = "";                     // so the same file can be re-picked
      const notes = [];
      for (const file of files) {
        if ((CHAR.play.images || []).length >= IMAGE_MAX_COUNT) {
          notes.push(`Stopped at ${IMAGE_MAX_COUNT} images.`); break;
        }
        try {
          const out = await prepareImage(file, IMAGE_BUDGET - imagesUsed());
          CHAR.play.images.push({ url: out.url, caption: file.name.replace(/\.[^.]+$/, "") });
          if (out.flattened) notes.push(`${file.name}: transparency flattened to fit.`);
        } catch (err) { notes.push(err.message); }
      }
      if (notes.length) alert(notes.join("\n"));
      playChanged();
    } });
  const addBtn = el("button", { class: "btn-add",
    disabled: list.length >= IMAGE_MAX_COUNT ? "1" : null,
    onclick: () => picker.click() },
    list.length >= IMAGE_MAX_COUNT ? "Limit reached" : "Add image…");
  card.append(el("div", { class: "sh-advrow", style: "border:0;padding:8px 0 0" },
    status, addBtn), picker);
  return card;
}

/* skills belonging to one pool — shown when its pool card is clicked */
// Shared skill-breakdown table, used by both the Skills tab and the pool-chip
// expansion on the Overview so the two stay in lockstep. Columns read left to
// right as Base (Pts) + Bonus + Group = Final dice.
function skillTableHeader() {
  return el("tr", {}, el("th", {}, "Skill"), el("th", { class: "num" }, "Pts"),
    el("th", { class: "num" }, "Bonus"), el("th", { class: "num" }, "Group"),
    el("th", { class: "num" }, "Final"));
}

// `bareName` drops the Trained Only chip: the locked block below carries the
// label on its section header, so repeating it on every row is pure noise.
function skillTableRow(name, dim = false, editable = false, bareName = false) {
  const s = CALC.skills[name];
  CHAR.skill_specializations ??= {};
  const spec = CHAR.skill_specializations[name];
  const specOn = !!(spec && spec.on) && s.final > 0;
  const rating = specOn ? `${s.final - 1} / ${s.final + 1}`
    : s.final > 0 ? String(s.final)
    : s.dice_bonus ? "0" : "—";
  // group_value already folds the bonus in; the Group column shows just the
  // group-derived dice so Pts + Bonus + Group reads as Final.
  const groupDice = s.points === 0 && s.group_value != null ? s.group_value - s.bonus : 0;

  // Inline chips that sit beside the name. The Trained Only marker goes on every
  // view (read-only and untrained rows included) -- it's needed most exactly when
  // the skill is unusable -- and turns amber once the character genuinely can't
  // roll it. Editable specialization (Skills tab only) is a "Spec" toggle plus a
  // text field; a specialized skill splits its rating into −1 / +1, and only
  // trained skills can carry one. Read-only views just show the note.
  const chips = [];
  if (s.trained_only && !bareName) {
    const unusable = !(s.final > 0 || s.dice_bonus);
    chips.push(el("span", { class: "skill-to-chip" + (unusable ? " unusable" : ""),
      title: unusable
        ? "Trained only — unusable: needs at least 1 die in this skill or its group"
        : "Trained only — cannot be used without dice in the skill or its group" },
      "Trained"));
  }
  let nameCell, specText = null;
  if (editable && s.final > 0) {
    chips.push(el("label", { class: "sh-spec-chip" + (specOn ? " on" : ""), title: "Specialize this skill (−1 / +1)" },
      el("input", { type: "checkbox", ...(specOn ? { checked: 1 } : {}),
        onchange: e => {
          const entry = CHAR.skill_specializations[name] ??= { on: false, text: "" };
          entry.on = e.target.checked;
          playChanged();
        } }),
      el("span", {}, "Spec")));
    if (specOn)
      specText = el("input", { type: "text", class: "sh-spec-input",
        value: (spec && spec.text) || "", placeholder: "Specialization…",
        oninput: e => { (CHAR.skill_specializations[name] ??= { on: true, text: "" }).text = e.target.value; schedulePlaySave(); } });
  } else if (specOn && spec.text) {
    specText = el("span", { class: "sub skill-spec-note" }, ` — ${spec.text}`);
  }
  // A specialty that matches no weapon this skill rolls contributes nothing --
  // better than silently costing -1 on everything -- but say so, or a typo just
  // looks like the feature not working.
  const dead = specOn
    ? RULES.classifySpecTerms(spec, name, DATA.tables).dead : [];
  const deadNote = dead.length
    ? el("div", { class: "sub skill-spec-dead" },
        `⚠ no ${name} weapon matches ${dead.map(t => `"${t}"`).join(", ")}`
        + " — not applied")
    : null;
  nameCell = chips.length
    ? el("div", { class: "sh-spec-line" }, el("span", { class: "sh-skillname" }, name), ...chips)
    : name;

  return el("tr", dim ? { class: "dim" } : {},
    el("td", {}, nameCell, specText, deadNote,
      (s.notes && s.notes.length) ? el("div", { class: "sub" }, "✦ " + s.notes.join(" · ")) : null),
    el("td", { class: "num sub" }, s.points ? String(s.points) : ""),
    el("td", { class: "num sub" }, s.bonus ? (s.bonus > 0 ? `+${s.bonus}` : String(s.bonus)) : ""),
    el("td", { class: "num sub" }, groupDice ? String(groupDice) : ""),
    // The rating is the dice limit for a test, so it's the thing to click. A
    // specialized skill shows two ratings and each loads its own: −1 off the
    // specialty, +1 on it. Bonus dice (+Nd) ride along into the count.
    el("td", { class: "num" },
      specOn
        ? el("span", {},
            rollable(el("b", {}, String(s.final - 1)),
              { dice: s.final - 1, bonus: s.dice_bonus || 0, pool: s.pool,
                label: `${name} (outside ${(spec && spec.text) || "specialty"})`,
                note: `${s.final - 1} skill${s.dice_bonus ? ` + ${s.dice_bonus} bonus` : ""}` }),
            el("b", {}, " / "),
            rollable(el("b", {}, String(s.final + 1)),
              { dice: s.final + 1, bonus: s.dice_bonus || 0, pool: s.pool,
                label: `${name}${(spec && spec.text) ? ` (${spec.text})` : ""}`,
                note: `${s.final + 1} skill${s.dice_bonus ? ` + ${s.dice_bonus} bonus` : ""}` }))
        : rollable(el("b", {}, rating),
            { dice: s.final, bonus: s.dice_bonus || 0, label: name, pool: s.pool,
              note: `${s.final} skill${s.dice_bonus ? ` + ${s.dice_bonus} bonus` : ""}` }),
      s.soft ? el("span", { class: "sub" }, ` (soft)`) : null,
      s.dice_bonus ? el("span", { class: "skill-dice" }, `+${s.dice_bonus}d`) : null));
}

/* The Skills tab's "trained only, and you have no dice in it" list, folded.
 *
 * It used to be a section INSIDE each pool card's table, headed "Trained only —
 * unavailable without dice", one dimmed row per skill. Measured on the QA
 * kitchen-sink character that section routinely runs longer than the trained
 * list above it: Focus reads "No trained skills." and then ten-plus dimmed rows
 * of things the character cannot do. The card ends up describing the game's
 * skill list rather than this character's skills.
 *
 * Folding it keeps the information — a player does need to know the skill
 * exists and is out of reach — without letting it outweigh what the character
 * actually has. Collapsed by default, which is the whole point: what you own
 * should be what you see first. The count goes in the summary so the size of
 * what's hidden is legible without opening it.
 *
 * Deliberately NOT persisted. The sheet has no per-tab UI-state store to hang
 * this on: the comparable folds are module-level Sets (poolTempOpen) that live
 * only as long as the page does, and CHAR.play is character data, not chrome.
 * <details> keeps its own open state for as long as the node lives, which
 * covers the case that matters (reading the list, then reading it again), and
 * a fold this cheap to reopen does not justify inventing storage. Note that a
 * re-render rebuilds the card, so it does reclose on any change that redraws
 * the tab -- acceptable for a list nobody reads twice in a sitting.
 *
 * A <details> cannot wrap <tr>s, so this is its own table rather than a
 * section of the card's. That costs nothing here: a skill only lands in this
 * list when it has 0 points, 0 bonus and 0 group dice — that is what put it
 * here — so every numeric column is empty by construction and the header row
 * would label four blank columns. The name and the em dash are the content.
 * `bareName` drops the per-row Trained chip for the same reason: the summary
 * already says it, once, for the whole list. */
function lockedSkillsBlock(names) {
  const d = el("details", { class: "sh-locked-skills" },
    el("summary", { title: "Trained only — these need at least 1 die in the skill or its group before they can be rolled" },
      `Trained only — ${names.length} skill${names.length === 1 ? "" : "s"} unavailable without dice`));
  const t = el("table", { class: "sh-skilltable" });
  for (const name of names) t.append(skillTableRow(name, true, false, true));
  d.append(t);
  return d;
}

function poolSkillList(pool) {
  const names = Object.entries(DATA.skills)
    .filter(([, meta]) => meta.pool === pool)
    .map(([name]) => name)
    .sort((a, b) => (CALC.skills[b].final - CALC.skills[a].final) || a.localeCompare(b));
  const box = el("div", { class: `sh-poolskills ${pool.toLowerCase()}` },
    el("h4", {}, `${pool} skills`));
  const t = el("table", { class: "sh-skilltable" });
  t.append(skillTableHeader());
  for (const name of names) {
    const s = CALC.skills[name];
    t.append(skillTableRow(name, !(s.final > 0 || s.dice_bonus)));
  }
  box.append(t);
  return box;
}

/* ------------------------------------------------ skills tab (display only) */
function shSkills(body) {
  // Martial Arts are Brawn skills, one per style, so their rank and the "learn a
  // style" control sit in the Brawn card with everything else Brawn; the unlocked
  // level effects follow in their own card below the grid. A style never takes a
  // specialization, so these rows carry no Spec toggle.
  const ro = !!(activeTabObj() && activeTabObj().readonly);
  const maList = CALC.martial_arts || [];
  const unarmedRank = (CALC.skills["Unarmed Combat"] || { points: 0 }).points;
  const allMaStyles = [...new Set(DATA.tables.martial_arts.map(r => r.Style))].sort();
  const usedMaStyles = new Set(maList.map(m => m.style));

  const appendMartialArtRows = t => {
    t.append(el("tr", { class: "skill-group-row" },
      el("td", { colspan: "5" }, "Martial Arts", " ", trainedOnlyChip(),
        el("span", { class: "sub" }, "  — ≤ Unarmed Combat"))));
    maList.forEach(ma => {
      const atCap = ma.rank >= SKILL_KISMET_CAP || ma.rank >= unarmedRank;
      const cost = skillRaiseCost(ma.rank);
      const raise = ro ? null : el("button", { class: "btn small sh-ma-raise",
        disabled: (atCap || CHAR.play.kismet < cost) ? "1" : null,
        title: ma.rank >= unarmedRank ? "Cannot exceed Unarmed Combat rank"
          : ma.rank >= SKILL_KISMET_CAP ? "Rank 6 is the Kismet cap"
          : `Raise with Kismet (${cost})`,
        onclick: async () => {
          if (!spendKismet(`Raised Martial Arts (${ma.style}) to rank ${ma.rank + 1}`, cost,
              { kind: "martial_art", name: ma.style })) return;
          const adv = CHAR.play.martial_art_advances = CHAR.play.martial_art_advances || {};
          adv[ma.style] = (adv[ma.style] || 0) + 1;
          await playChangedRecalc();
        } }, atCap ? "cap" : `+1 (${cost})`);
      t.append(el("tr", {},
        el("td", {}, el("div", { class: "sh-spec-line" }, el("span", {}, ma.style), raise)),
        el("td", { class: "num sub" }, String(ma.rank)),
        el("td", { class: "num sub" }, ""),
        el("td", { class: "num sub" }, ""),
        el("td", { class: "num" }, el("b", {}, String(ma.rank)))));
    });
    const addable = allMaStyles.filter(s => !usedMaStyles.has(s));
    if (!ro && addable.length && unarmedRank >= 1) {
      const addSel = el("select", { class: "btn-select" },
        el("option", { value: "" }, "Add style…"),
        ...addable.map(s => el("option", {}, s)));
      t.append(el("tr", {}, el("td", { colspan: "5" },
        el("div", { class: "add-row" }, addSel,
          el("button", { class: "btn-add",
            disabled: CHAR.play.kismet < NEW_SKILL_KISMET_COST ? "1" : null,
            onclick: async () => {
              const style = addSel.value; if (!style) return;
              if (!spendKismet(`Learned Martial Arts style: ${style}`, NEW_SKILL_KISMET_COST,
                  { kind: "martial_art", name: style })) return;
              const adv = CHAR.play.martial_art_advances = CHAR.play.martial_art_advances || {};
              adv[style] = (adv[style] || 0) + 1;
              await playChangedRecalc();
            } }, `Add (${NEW_SKILL_KISMET_COST})`)))));
    } else if (!ro && unarmedRank < 1) {
      t.append(el("tr", {}, el("td", { colspan: "5", class: "hint" },
        "Train Unarmed Combat before learning a martial art.")));
    }
  };

  // Each pool gets its OWN card, laid out 2×2 (stacks to 1 column on phones),
  // so nothing crams into a single wide card at narrow widths.
  const grid = el("div", { class: "sh-skillgrid" });
  for (const pool of POOL_ORDER) {
    // poolState(), not raw CALC.pools[pool] — the header tile and the compact
    // strip both show the LIVE total (temp boost dice, a triggered Adrenal
    // Pump, the Wildling shift), and this header used to be the one place on
    // the sheet that silently fell back to the static build number. Switching
    // Beast Form on dropped the header tile's Resolve to 0 while this card
    // kept reading the untouched build value — the mismatch the bug reported.
    const ps = poolState(pool);
    const live = ps.beast + ps.boost;   // net swing from temp dice + active effects
    const card = el("div", { class: `card sh-card sh-skillcard ${pool.toLowerCase()}` },
      el("div", {
        class: "colhead",
        title: live
          ? `${pool}: ${ps.max} dice right now (base ${CALC.pools[pool]}`
            + (ps.beast ? `, ${ps.beast > 0 ? "+" : "−"}${Math.abs(ps.beast)} active effect` : "")
            + (ps.boost ? `, ${ps.boost > 0 ? "+" : "−"}${Math.abs(ps.boost)} temp` : "")
            + ")"
          : `${pool}: ${ps.max} dice`,
      },
        el("span", {}, pool),
        el("b", { style: live ? `color:var(--${live > 0 ? "ok" : "bad"})` : "" }, String(ps.max))));
    const trained = Object.entries(DATA.skills)
      .filter(([n, m]) => m.pool === pool && (CALC.skills[n].final > 0 || CALC.skills[n].dice_bonus
        || (CALC.skills[n].notes && CALC.skills[n].notes.length)))
      .sort((a, b) => CALC.skills[b[0]].final - CALC.skills[a[0]].final);
    // This tab only lists skills you can actually roll, which would hide a
    // Trained Only skill exactly when it matters -- you have no dice, so it's off
    // the table entirely. List those separately instead of dropping them. The
    // `shown` guard keeps a flagged skill that qualified above (via notes) from
    // appearing twice.
    const shown = new Set(trained.map(([n]) => n));
    const locked = Object.keys(DATA.skills)
      .filter(n => DATA.skills[n].pool === pool && CALC.skills[n].trained_only && !shown.has(n))
      .sort();
    // Brawn always renders its table -- the Martial Arts section lives in it, so
    // it has to be reachable even with no trained Brawn skills.
    const isBrawn = pool === "Brawn";
    if (trained.length || isBrawn) {
      const t = el("table", { class: "sh-skilltable" });
      t.append(skillTableHeader());
      for (const [name] of trained) t.append(skillTableRow(name, false, true));
      if (!trained.length)
        t.append(el("tr", {}, el("td", { colspan: "5", class: "hint" }, "No trained skills.")));
      if (isBrawn) appendMartialArtRows(t);
      card.append(t);
    } else {
      // Nothing trained and no Martial Arts section to hold open: a five-column
      // header over an empty table is worse than a sentence, and the locked
      // fold below carries the rest.
      card.append(el("p", { class: "hint" }, "No trained skills."));
    }
    // Firearms, Heavy Weapons and Archery are all Finesse, so the number that
    // decides how much of a burst you can hold on target belongs at the foot of
    // this card rather than a tab away.
    if (pool === "Finesse") {
      const rl = recoilStatLine();
      if (rl) card.append(rl);
    }
    // Last in the card, below the table and below Finesse's recoil line — see
    // lockedSkillsBlock. Everything above it is about what this character can
    // do; the fold is the footnote saying what they cannot.
    if (locked.length) card.append(lockedSkillsBlock(locked));
    grid.append(card);
  }
  body.append(grid);
  body.append(el("p", { class: "hint", style: "margin:2px 0 10px" },
    "Raise skills and attributes with Kismet on the Kismet tab."));

  const know = el("div", { class: "card sh-card" },
    el("h3", {}, "Knowledge & Etiquette"));
  // Rated off CALC, not CHAR: what you bought plus what you're currently
  // wearing. An etiquette at 0 points still shows when gear is carrying it.
  const ep = CALC.etiquette_points || {};
  const etqFinal = ep.final || {};
  const etqAdjust = ep.adjust || {};
  const etq = Object.entries(etqFinal).filter(([, v]) => v > 0);
  const from0 = CALC.etiquette_sources || [];
  if (etq.length) {
    const row = el("div", { class: "sh-tagrow" });
    for (const [name, total] of etq) {
      const bonus = etqAdjust[name] || 0;
      const base = (ep.values || {})[name] || 0;
      const from = (CALC.etiquette_sources || [])
        .filter(s => s.etiquette === name)
        .map(s => `${s.label} +${s.bonus}`);
      // Rollable at its FINAL rating, with no pool attached (#72): an etiquette
      // test is the rating on its own, so there is nothing to spend and the
      // roller opens with the count already right.
      row.append(rollable(el("span", {
        class: "sh-tag magic" + (bonus ? " sh-tag-boosted" : ""),
      }, bonus ? `${name} ${total} (${base}+${bonus})` : `${name} ${total}`), {
        dice: total, label: `${name} Etiquette`,
        title: `Roll ${total}d6 — ${name} Etiquette`
          + (bonus ? ` (${base} bought +${bonus} from ${from.join(", ")})` : ""),
        note: bonus ? `${base} bought +${bonus} from ${from.join(", ")}` : "No pool — this is the rating on its own",
      }));
    }
    know.append(el("h4", { class: "sh-h4" }, "Etiquettes"), row);
    // Where each bonus comes from, spelled out rather than left in a tooltip
    // (#72). A player checking whether they still have the Corporate bonus is
    // asking which garment is carrying it, and a hover they have to discover
    // is a poor way to answer that.
    if (from0.length) {
      know.append(el("div", { class: "sh-etq-sources" },
        ...from0.map(s => el("div", { class: "sub" },
          `+${s.bonus} ${s.etiquette} — ${s.label}`))));
      know.append(el("p", { class: "hint" },
        "Bonuses come from what you're wearing and carrying — they drop when the "
        + "gear does, and they sit outside the point cap."));
    }
    // Bling is an Etiquette bonus, so it belongs with the Etiquettes rather than
    // on a combat card. One line for the whole look: a blinged gun and a blinged
    // ride are the same show, so it's the best single source, never the sum.
    for (const b of CALC.combat.bling_etiquette || []) {
      know.append(statLine("Bling", `+${b.bonus} ${b.etiquette} Etiquette`,
        b.sources.length > 1
          ? `Best single source — bling doesn't stack: ${b.sources.join(" · ")}`
          : b.sources[0]));
    }
  } else {
    know.append(el("h4", { class: "sh-h4" }, "Etiquettes"),
      el("p", { class: "hint" }, "No etiquettes."));
  }

  // Knowledge points are never forfeited at finalize — any leftover (or
  // freed up by a later Intelligence raise) budget stays spendable here.
  const kBudget = CALC.knowledge || { budget: 0, spent: 0, remaining: 0 };
  // Name what actually built the budget rather than describing the formula
  // (#72). The bonus is derived from the gap so it needs nothing new from the
  // engine, and it is only mentioned when there IS one.
  const kInt = CALC.attributes.Intelligence.final;
  const kBonus = Math.max(0, (kBudget.budget || 0) - 2 * kInt);
  know.append(el("h4", { class: "sh-h4" }, "Knowledges"),
    el("p", { class: "hint", style: "margin:0 0 6px" },
      `${kBudget.remaining} / ${kBudget.budget} points left — 2 × Intelligence ${kInt} = ${2 * kInt}`
      + (kBonus ? `, +${kBonus} from Knowledge Skillsoft` : "")
      + ". Free-form, spendable any time."));
  const kt = el("table", { style: "max-width:560px" });
  allKnowledgeSkills().forEach((k, i) => {
    const atCap = (k.points || 0) >= KNOWLEDGE_RANK_CAP;
    const pointsCtl = el("span", { class: "sh-mini" },
      el("button", { class: "mini-btn", title: "Reduce",
        onclick: async () => { k.points = Math.max(0, (k.points || 0) - 1); await playChangedRecalc(); } }, "−"),
      // Same click-to-roll as an etiquette, and for the same reason: a
      // knowledge test is its rating with no pool behind it (#72).
      rollable(el("b", {}, String(k.points || 0)), {
        dice: k.points || 0, label: `${k.name || "Knowledge"}`,
        note: "No pool — this is the rating on its own" }),
      el("button", { class: "mini-btn", title: atCap ? `Rank ${KNOWLEDGE_RANK_CAP} is the cap`
          : kBudget.remaining < 1 ? "No Knowledge points left" : "Raise",
        disabled: (atCap || kBudget.remaining < 1) ? "1" : null,
        onclick: async () => { k.points = Math.min(KNOWLEDGE_RANK_CAP, (k.points || 0) + 1); await playChangedRecalc(); } }, "+"));
    kt.append(el("tr", {},
      el("td", {}, el("input", { type: "text", value: k.name || "",
        placeholder: "Knowledge area",
        oninput: e => { k.name = e.target.value; playChanged(false); } })),
      el("td", { class: "num" }, pointsCtl),
      el("td", {}, el("button", { class: "row-del", title: "Remove",
        onclick: async () => { kitOf("knowledge_skills").splice(i, 1); await playChangedRecalc(); } }, "✕"))));
  });
  if (!allKnowledgeSkills().length)
    kt.append(el("tr", {}, el("td", { class: "sub", colspan: "3" }, "No knowledge skills yet.")));
  know.append(kt, el("div", { class: "add-row" },
    el("button", {
      class: "btn-add", disabled: kBudget.remaining < 1 ? "1" : null,
      onclick: async () => { kitOf("knowledge_skills").push({ name: "", points: 1 }); await playChangedRecalc(); },
    }, "Add knowledge skill")));
  body.append(know);

  // Style effects only — rank and "add style" live in the Brawn card above.
  if (maList.length) {
    const maCard = el("div", { class: "card sh-card" },
      el("h3", {}, "Martial Art Style Effects"));
    maList.forEach(ma => {
      maCard.append(el("div", { class: "sh-h4", style: "margin:8px 0 2px" }, ma.style,
        el("span", { class: "sub" }, ` · rank ${ma.rank}`)));
      if (ma.levels.length) {
        ma.levels.forEach(l => maCard.append(statLine(`Level ${l.Level}`, l.Effect)));
        if (ma.mods.applied.length)
          maCard.append(statLine("Applied to stats", ma.mods.applied.join(" · ")));
      } else {
        maCard.append(el("p", { class: "hint" },
          "Raise this style's rank to unlock its level effects."));
      }
    });
    body.append(maCard);
  }
}

/* ------------------------------------------------ kismet tab */
/* KISMET.docx: raising an attribute costs 3 per point up to 10, 4 for 11–15,
 * and 5 for 16+ — cost keyed to the level being bought. */
const attrRaiseCost = newLevel => newLevel <= 10 ? 3 : newLevel <= 15 ? 4 : 5;
const skillRaiseCost = rank => Math.max(1, rank);   // "current skill level in Kismet"

function shKismet(body) {
  const play = CHAR.play;
  const econ = kismetEcon();

  // --- balance + awards
  const balance = el("div", { class: "card sh-card" },
    el("div", { class: "sh-card-head" },
      el("h3", {}, "Kismet"),
      el("span", {},
        el("span", { class: "chip magic" }, `Available ${play.kismet}`), " ",
        el("span", { class: "chip" }, `Lifetime ${play.kismet_earned}`))),
    el("p", { class: "hint" },
      "The Agonarch grants Kismet at the end of each session (usually 4–6). "
      + "Every 10 lifetime Kismet grants a boon pick; every second one is a major boon."));
  const awardRow = el("div", { class: "sh-tagrow" });
  for (const [label, n] of KISMET_AWARDS) {
    awardRow.append(el("button", { class: "btn small", onclick: () => {
      awardKismet(label, n); playChanged();
    } }, `${label} +${n}`));
  }
  // Its two buttons (Award / Spend) say what happens to the number, but neither
  // names the field itself.
  const customAmt = el("input", { type: "number", value: "1", min: "1",
    "aria-label": "Kismet to award or spend", style: "width:70px" });
  awardRow.append(el("span", { class: "sh-inline-adjust" },
    customAmt,
    el("button", { class: "btn small good", onclick: () => {
      const n = parseInt(customAmt.value, 10);
      if (n > 0) { awardKismet("Custom award", n); playChanged(); }
    } }, "Award"),
    el("button", { class: "btn small warn", onclick: () => {
      const n = parseInt(customAmt.value, 10);
      if (n > 0 && spendKismet("Custom spend", n, { kind: "custom" })) playChanged();
    } }, "Spend")));
  balance.append(el("h4", { class: "sh-h4" }, "Session Awards"), awardRow);
  body.append(balance);

  // --- spending: attributes + skills + magic
  const spend = el("div", { class: "card sh-card" },
    el("h3", {}, "Spend Kismet"),
    el("p", { class: "hint" },
      "Attribute +1: 3 Kismet up to level 10, 4 for 11–15, 5 for 16+. "
      + "Skill +1: current level in Kismet (max 6 — mastery boon reaches 7). New skill: 4 Kismet."));
  const two = el("div", { class: "sh-two" });

  const attrBox = el("div", {}, el("h4", { class: "sh-h4" }, "Raise Attributes"));
  for (const [full] of ATTR_ABBR) {
    const a = CALC.attributes[full];
    const cost = attrRaiseCost(a.final + 1);
    const capped = a.final >= a.max;
    attrBox.append(el("div", { class: "sh-advrow" },
      el("span", {}, el("b", {}, full),
        el("span", { class: "sub" }, ` ${a.final} / max ${a.max}`)),
      el("button", {
        class: "btn small", disabled: (capped || play.kismet < cost) ? "1" : null,
        onclick: async () => {
          if (!spendKismet(`Raised ${full} to ${a.final + 1}`, cost, { kind: "attribute", name: full })) return;
          play.attribute_advances[full] = (play.attribute_advances[full] || 0) + 1;
          await playChangedRecalc();
        },
      }, capped ? "max" : `+1 (${cost})`)));
  }

  const skillBox = el("div", {}, el("h4", { class: "sh-h4" }, "Raise Existing Skills"));
  const ranked = Object.keys(DATA.skills)
    .filter(n => CALC.skills[n].points > 0)
    .sort((a, b) => CALC.skills[b].points - CALC.skills[a].points);
  if (!ranked.length) skillBox.append(el("p", { class: "hint" }, "No trained skills yet."));
  for (const name of ranked) {
    const s = CALC.skills[name];
    // Martial arts aren't normal skills — they're raised from their own card on
    // the Skills tab (per style), so they never appear in this list.
    const atCap = s.points >= SKILL_KISMET_CAP;
    const cost = skillRaiseCost(s.points);
    skillBox.append(el("div", { class: "sh-advrow" },
      el("span", {}, el("b", {}, name),
        el("span", { class: "sub" }, ` ${s.pool} · rank ${s.points}`)),
      el("button", {
        class: "btn small", disabled: (atCap || play.kismet < cost) ? "1" : null,
        title: atCap ? "Rank 6 is the Kismet cap — use a mastery boon for 7" : null,
        onclick: async () => {
          if (!spendKismet(`Raised ${name} to rank ${s.points + 1}`, cost, { kind: "skill", name })) return;
          play.skill_advances[name] = (play.skill_advances[name] || 0) + 1;
          await playChangedRecalc();
        },
      }, atCap ? "cap 6" : `+1 (${cost})`)));
  }
  const untrained = Object.keys(DATA.skills)
    .filter(n => CALC.skills[n].points === 0).sort();
  const learnSel = el("select", {},
    el("option", { value: "" }, "Learn new skill…"),
    ...untrained.map(n => el("option", {}, n)));
  skillBox.append(el("div", { class: "add-row" }, learnSel,
    el("button", {
      class: "btn-add", disabled: play.kismet < NEW_SKILL_KISMET_COST ? "1" : null,
      onclick: async () => {
        const name = learnSel.value;
        if (!name) return;
        if (!spendKismet(`Learned new skill: ${name}`, NEW_SKILL_KISMET_COST, { kind: "skill", name })) return;
        play.skill_advances[name] = (play.skill_advances[name] || 0) + 1;
        await playChangedRecalc();
      },
    }, `Learn (${NEW_SKILL_KISMET_COST})`)));

  two.append(attrBox, skillBox);
  spend.append(two);

  // Etiquettes and Knowledges are skills like any other (#58): same Kismet
  // costs, same rank-6 cap, same mastery/major boons as the skill list above.
  const two2 = el("div", { class: "sh-two" });

  const etiquetteBox = el("div", {}, el("h4", { class: "sh-h4" }, "Raise Etiquettes"));
  const etqValues = (CALC.etiquette_points || {}).values || {};
  const rankedEtiquettes = RULES.ETIQUETTES.filter(n => (etqValues[n] || 0) > 0)
    .sort((a, b) => (etqValues[b] || 0) - (etqValues[a] || 0));
  if (!rankedEtiquettes.length) etiquetteBox.append(el("p", { class: "hint" }, "No trained etiquettes yet."));
  for (const name of rankedEtiquettes) {
    const points = etqValues[name] || 0;
    const atCap = points >= SKILL_KISMET_CAP;
    const cost = skillRaiseCost(points);
    etiquetteBox.append(el("div", { class: "sh-advrow" },
      el("span", {}, el("b", {}, name), el("span", { class: "sub" }, ` rank ${points}`)),
      el("button", {
        class: "btn small", disabled: (atCap || play.kismet < cost) ? "1" : null,
        title: atCap ? "Rank 6 is the Kismet cap — use a mastery boon for 7" : null,
        onclick: async () => {
          if (!spendKismet(`Raised ${name} (Etiquette) to rank ${points + 1}`, cost,
              { kind: "etiquette", name })) return;
          play.etiquette_advances[name] = (play.etiquette_advances[name] || 0) + 1;
          await playChangedRecalc();
        },
      }, atCap ? "cap 6" : `+1 (${cost})`)));
  }
  const untrainedEtiquettes = RULES.ETIQUETTES.filter(n => (etqValues[n] || 0) === 0);
  const learnEtqSel = el("select", {},
    el("option", { value: "" }, "Learn new etiquette…"),
    ...untrainedEtiquettes.map(n => el("option", {}, n)));
  etiquetteBox.append(el("div", { class: "add-row" }, learnEtqSel,
    el("button", {
      class: "btn-add",
      disabled: (!untrainedEtiquettes.length || play.kismet < NEW_SKILL_KISMET_COST) ? "1" : null,
      onclick: async () => {
        const name = learnEtqSel.value;
        if (!name) return;
        if (!spendKismet(`Learned new etiquette: ${name}`, NEW_SKILL_KISMET_COST,
            { kind: "etiquette", name })) return;
        play.etiquette_advances[name] = (play.etiquette_advances[name] || 0) + 1;
        await playChangedRecalc();
      },
    }, `Learn (${NEW_SKILL_KISMET_COST})`)));

  // Knowledge points are also free-form via 2×Intelligence any time (see the
  // Knowledge & Etiquette card on the Skills tab) — this is the second, Kismet
  // -funded path onto the same play.kit entries, for when that budget's spent.
  const knowledgeBox = el("div", {}, el("h4", { class: "sh-h4" }, "Raise Knowledges"));
  const rankedKnowledge = allKnowledgeSkills().filter(k => k.name && (k.points || 0) > 0)
    .sort((a, b) => (b.points || 0) - (a.points || 0));
  if (!rankedKnowledge.length) knowledgeBox.append(el("p", { class: "hint" }, "No trained knowledges yet."));
  for (const k of rankedKnowledge) {
    const points = k.points || 0;
    const atCap = points >= SKILL_KISMET_CAP;
    const cost = skillRaiseCost(points);
    knowledgeBox.append(el("div", { class: "sh-advrow" },
      el("span", {}, el("b", {}, k.name), el("span", { class: "sub" }, ` rank ${points}`)),
      el("button", {
        class: "btn small", disabled: (atCap || play.kismet < cost) ? "1" : null,
        title: atCap ? "Rank 6 is the Kismet cap — use a mastery boon for 7" : null,
        onclick: async () => {
          if (!spendKismet(`Raised ${k.name} (Knowledge) to rank ${points + 1}`, cost,
              { kind: "knowledge", name: k.name })) return;
          k.points = points + 1;
          await playChangedRecalc();
        },
      }, atCap ? "cap 6" : `+1 (${cost})`)));
  }
  const learnKnowledgeInput = el("input", { type: "text", placeholder: "New knowledge area" });
  knowledgeBox.append(el("div", { class: "add-row" }, learnKnowledgeInput,
    el("button", {
      class: "btn-add", disabled: play.kismet < NEW_SKILL_KISMET_COST ? "1" : null,
      onclick: async () => {
        const name = learnKnowledgeInput.value.trim();
        if (!name) return;
        if (!spendKismet(`Learned new knowledge: ${name}`, NEW_SKILL_KISMET_COST,
            { kind: "knowledge", name })) return;
        kitOf("knowledge_skills").push({ name, points: 1 });
        await playChangedRecalc();
      },
    }, `Learn (${NEW_SKILL_KISMET_COST})`)));

  two2.append(etiquetteBox, knowledgeBox);
  spend.append(two2);

  const ritualBox = el("div", {}, el("h4", { class: "sh-h4" }, "Raise Rituals"));
  const ritualNames = DATA.tables.rituals.map(r => r.Name);
  const rankedRituals = ritualNames.filter(n => (CALC.ritual_skills[n] || 0) > 0)
    .sort((a, b) => (CALC.ritual_skills[b] || 0) - (CALC.ritual_skills[a] || 0));
  if (!rankedRituals.length) ritualBox.append(el("p", { class: "hint" }, "No trained rituals yet."));
  for (const name of rankedRituals) {
    const points = CALC.ritual_skills[name] || 0;
    const atCap = points >= SKILL_KISMET_CAP;
    const cost = skillRaiseCost(points);
    ritualBox.append(el("div", { class: "sh-advrow" },
      el("span", {}, el("b", {}, name), el("span", { class: "sub" }, ` rank ${points}`)),
      el("button", {
        class: "btn small", disabled: (atCap || play.kismet < cost) ? "1" : null,
        title: atCap ? "Rank 6 is the Kismet cap — use a mastery boon for 7" : null,
        onclick: async () => {
          if (!spendKismet(`Raised ritual ${name} to rank ${points + 1}`, cost, { kind: "ritual", name })) return;
          play.ritual_advances[name] = (play.ritual_advances[name] || 0) + 1;
          await playChangedRecalc();
        },
      }, atCap ? "cap 6" : `+1 (${cost})`)));
  }
  const untrainedRituals = ritualNames.filter(n => (CALC.ritual_skills[n] || 0) === 0).sort();
  const learnRitualSel = el("select", {},
    el("option", { value: "" }, "Learn new ritual…"),
    ...untrainedRituals.map(n => el("option", {}, n)));
  ritualBox.append(el("div", { class: "add-row" }, learnRitualSel,
    el("button", {
      class: "btn-add", disabled: play.kismet < NEW_SKILL_KISMET_COST ? "1" : null,
      onclick: async () => {
        const name = learnRitualSel.value;
        if (!name) return;
        if (!spendKismet(`Learned new ritual: ${name}`, NEW_SKILL_KISMET_COST, { kind: "ritual", name })) return;
        play.ritual_advances[name] = (play.ritual_advances[name] || 0) + 1;
        await playChangedRecalc();
      },
    }, `Learn (${NEW_SKILL_KISMET_COST})`)));
  spend.append(ritualBox);

  // Martial Arts also live on the Skills tab, in the Brawn card where their
  // rank is read. They are repeated here because this is where a player comes
  // to SPEND, and a control that exists only on another tab is what "no way to
  // buy a style with Kismet" actually looked like (#70). Same store, same costs
  // and the same two gates as the Skills-tab copy, so the views cannot drift:
  // a style never outranks Unarmed Combat, and you cannot learn one before you
  // can throw a punch.
  const maBox = el("div", {}, el("h4", { class: "sh-h4" }, "Martial Arts"));
  const maUnarmed = (CALC.skills["Unarmed Combat"] || { points: 0 }).points;
  const maOwned = CALC.martial_arts || [];
  const maStyles = [...new Set(DATA.tables.martial_arts.map(r => r.Style))].sort();
  if (!maOwned.length) maBox.append(el("p", { class: "hint" }, "No styles trained yet."));
  for (const ma of maOwned) {
    const maCap = ma.rank >= SKILL_KISMET_CAP || ma.rank >= maUnarmed;
    const maCost = skillRaiseCost(ma.rank);
    maBox.append(el("div", { class: "sh-advrow" },
      el("span", {}, el("b", {}, ma.style), el("span", { class: "sub" }, ` rank ${ma.rank}`)),
      el("button", {
        class: "btn small", disabled: (maCap || play.kismet < maCost) ? "1" : null,
        title: ma.rank >= SKILL_KISMET_CAP ? "Rank 6 is the Kismet cap — use a mastery boon for 7"
          : ma.rank >= maUnarmed ? `Cannot exceed Unarmed Combat rank ${maUnarmed}` : null,
        onclick: async () => {
          if (!spendKismet(`Raised Martial Arts (${ma.style}) to rank ${ma.rank + 1}`, maCost,
              { kind: "martial_art", name: ma.style })) return;
          const adv = play.martial_art_advances = play.martial_art_advances || {};
          adv[ma.style] = (adv[ma.style] || 0) + 1;
          await playChangedRecalc();
        },
      }, maCap ? "cap" : `+1 (${maCost})`)));
  }
  const maAddable = maStyles.filter(st => !maOwned.some(m => m.style === st));
  if (maUnarmed < 1) {
    maBox.append(el("p", { class: "hint" },
      "Train Unarmed Combat before learning a martial art."));
  } else if (maAddable.length) {
    const maSel = el("select", {}, el("option", { value: "" }, "Learn new style…"),
      ...maAddable.map(st => el("option", {}, st)));
    maBox.append(el("div", { class: "add-row" }, maSel,
      el("button", {
        class: "btn-add", disabled: play.kismet < NEW_SKILL_KISMET_COST ? "1" : null,
        onclick: async () => {
          const style = maSel.value;
          if (!style) return;
          if (!spendKismet(`Learned Martial Arts style: ${style}`, NEW_SKILL_KISMET_COST,
              { kind: "martial_art", name: style })) return;
          const adv = play.martial_art_advances = play.martial_art_advances || {};
          adv[style] = (adv[style] || 0) + 1;
          await playChangedRecalc();
        },
      }, `Learn (${NEW_SKILL_KISMET_COST})`)));
  }
  spend.append(maBox);

  // ZP advancement: unlocks higher-Force casting (drain Stun instead of
  // lethal when Force <= ZP) and widens Amp/augment headroom.
  // Cost is 2x current MAX ZP per point (#69): it scales off the maximum, not
  // the effective value left after chrome, so spending never makes ZP cheaper.
  const zp = CALC.zoetics.zp;
  const zpEffective = zpMeterValues();
  const zpCost = 2 * zp;
  spend.append(el("h4", { class: "sh-h4" }, "Advance Zoetic Potential"),
    el("p", { class: "hint" },
      "ZP gates spell Force: casting a spell with Force above your ZP deals its drain as LETHAL damage; "
      + "at or below ZP, drain is Stun. Each point costs 2x your current maximum ZP."),
    el("div", { class: "sh-advrow", style: "max-width:420px" },
      el("span", {}, el("b", {}, "Zoetic Potential"),
        // Effective ZP is what actually gates Force, and it's the number the
        // header used to carry. Base alone would understate the cost of chrome:
        // under either ZR rule the spending you've already done eats into it.
        el("span", { class: "sub" }, ` current ${zp}`),
        zpEffective.current !== zp
          ? el("span", { class: "sub",
              title: "What your spending leaves — this is the value Force is measured against" },
              ` · effective ${zpEffective.current}`)
          : null),
      el("button", {
        class: "btn small", disabled: play.kismet < zpCost ? "1" : null,
        onclick: async () => {
          if (!spendKismet(`Raised Zoetic Potential to ${zp + 1}`, zpCost, { kind: "zp" })) return;
          play.zp_advances = (play.zp_advances || 0) + 1;
          await playChangedRecalc();
        },
      }, `+1 (${zpCost})`)));
  speakerKismetSection(spend);
  body.append(spend);

  // --- boons
  const boons = el("div", { class: "card sh-card" },
    el("div", { class: "sh-card-head" },
      el("h3", {}, "Boons"),
      el("span", {},
        el("span", { class: "chip" }, `Regular available ${econ.regularsAvail}`), " ",
        el("span", { class: "chip magic" }, `Major available ${econ.majorsAvail}`))),
    el("p", { class: "hint" },
      `Milestones reached: ${econ.increases} (every 10 lifetime Kismet). `
      + "Regular boons: financial windfall · a new free asset from an old friend · skill mastery (6→7). "
      + "Every second milestone is a major boon — ask the Agonarch."));

  // Skills, Etiquettes and Knowledges all share the mastery/major boon rules
  // (#58), so both boon dropdowns below draw from all three. Options are
  // namespaced "kind:name" since a skill and a knowledge area could share a
  // name; applyRankAdvance() routes the redeemed rank to the right bucket —
  // skill_advances / etiquette_advances, or straight onto the knowledge's own
  // play.kit entry, same as the Kismet-raise buttons above.
  const masterableAt = rank => [
    ...Object.keys(DATA.skills).filter(n => CALC.skills[n].points === rank)
      .map(n => ({ value: `skill:${n}`, label: n })),
    ...RULES.ETIQUETTES.filter(n => (etqValues[n] || 0) === rank)
      .map(n => ({ value: `etiquette:${n}`, label: `${n} (Etiquette)` })),
    ...allKnowledgeSkills().filter(k => k.name && (k.points || 0) === rank)
      .map(k => ({ value: `knowledge:${k.name}`, label: `${k.name} (Knowledge)` })),
  ];
  const applyRankAdvance = (kind, name) => {
    if (kind === "etiquette") play.etiquette_advances[name] = (play.etiquette_advances[name] || 0) + 1;
    else if (kind === "knowledge") {
      const entry = allKnowledgeSkills().find(k => k.name === name);
      if (entry) entry.points = (entry.points || 0) + 1;
    } else play.skill_advances[name] = (play.skill_advances[name] || 0) + 1;
  };

  const masterable = masterableAt(6);
  const masterSel = el("select", {},
    el("option", { value: "" }, "Skill at rank 6…"),
    ...masterable.map(o => el("option", { value: o.value }, o.label)));
  boons.append(el("div", { class: "sh-tagrow" },
    counterBtn("Redeem: Windfall (roll below)", () => {
      if (econ.regularsAvail < 1) { alert("No regular boons available."); return; }
      play.boons_spent++;
      play.kismet_log.unshift({ label: "Boon redeemed: financial windfall (Agonarch rolls)",
        delta: 0, undo: { kind: "boon" } });
      playChanged();
    }, econ.regularsAvail ? "accent" : ""),
    counterBtn("Redeem: Free asset", () => {
      if (econ.regularsAvail < 1) { alert("No regular boons available."); return; }
      play.boons_spent++;
      play.kismet_log.unshift({ label: "Boon redeemed: new free random asset (old friend)",
        delta: 0, undo: { kind: "boon" } });
      playChanged();
    }, econ.regularsAvail ? "accent" : ""),
    counterBtn("Redeem: Major boon", () => {
      if (econ.majorsAvail < 1) { alert("No major boons available."); return; }
      play.major_boons_spent++;
      play.kismet_log.unshift({ label: "MAJOR boon redeemed (see Agonarch)",
        delta: 0, undo: { kind: "boon", major: true } });
      playChanged();
    }, econ.majorsAvail ? "accent" : "")));
  boons.append(el("div", { class: "add-row" }, masterSel,
    el("button", { class: "btn-add", onclick: async () => {
      const sel = masterSel.value;
      if (!sel) return;
      const [kind, name] = sel.split(/:(.+)/);
      if (econ.regularsAvail < 1) { alert("No regular boons available."); return; }
      play.boons_spent++;
      play.kismet_log.unshift({ label: `Boon redeemed: skill mastery — ${name} 6→7`,
        delta: 0, undo: { kind: "boon_rank", rankKind: kind, name } });
      applyRankAdvance(kind, name);
      await playChangedRecalc();
    } }, "Mastery 6→7 (boon)")));

  // --- specific MAJOR boon options
  play.pool_kismet = play.pool_kismet || {};
  boons.append(el("h4", { class: "sh-h4" }, "Major Boons"));
  const spendMajor = (label, undo) => {
    if (econ.majorsAvail < 1) { alert("No major boons available."); return false; }
    play.major_boons_spent++;
    play.kismet_log.unshift({ label: `MAJOR boon: ${label}`, delta: 0,
      undo: { major: true, ...undo } });
    return true;
  };
  // 1) magic item / experimental tech
  boons.append(el("div", { class: "sh-tagrow" },
    counterBtn("Gain magic item / experimental tech", () => {
      if (spendMajor("gained a magic item / experimental tech (see Agonarch)",
                      { kind: "boon" })) playChanged();
    }, econ.majorsAvail ? "accent" : "")));
  // 2) raise a rank-7 skill (or Etiquette / Knowledge) to 8
  const skill7 = masterableAt(7);
  const skill7Sel = el("select", {}, el("option", { value: "" }, "Skill at rank 7…"),
    ...skill7.map(o => el("option", { value: o.value }, o.label)));
  boons.append(el("div", { class: "add-row" }, skill7Sel,
    el("button", { class: "btn-add", disabled: skill7.length ? null : "1", onclick: async () => {
      const sel = skill7Sel.value;
      if (!sel) return;
      const [kind, name] = sel.split(/:(.+)/);
      if (!spendMajor(`raised ${name} 7→8`, { kind: "boon_rank", rankKind: kind, name })) return;
      applyRankAdvance(kind, name);
      await playChangedRecalc();
    } }, "Skill 7→8 (major)")));
  // 3) add a permanent Kismet die to a pool
  const poolSel = el("select", {}, el("option", { value: "" }, "Pool…"),
    ...POOL_ORDER.map(p => el("option", {}, p)));
  boons.append(el("div", { class: "add-row" }, poolSel,
    el("button", { class: "btn-add", onclick: async () => {
      const pool = poolSel.value;
      if (!pool) return;
      if (!spendMajor(`+1 Kismet die to ${pool} pool`, { kind: "boon_pool", pool })) return;
      play.pool_kismet[pool] = (play.pool_kismet[pool] || 0) + 1;
      await playChangedRecalc();
    } }, "+1 Kismet die to pool (major)")));

  const wf = el("ol", { class: "sh-windfall" });
  const wfRows = WINDFALL_TABLE.map(w => { const li = el("li", {}, w); wf.append(li); return li; });
  const wfResult = el("div", { class: "sh-callout", hidden: true });
  boons.append(el("div", { class: "sh-card-head" },
    el("h4", { class: "sh-h4", style: "margin:0" }, "Financial Windfall Table (d6)"),
    counterBtn("🎲 Roll windfall", () => {
      const roll = rollDie(6);
      const rolled = rollDiceInText(WINDFALL_TABLE[roll - 1]);
      wfRows.forEach((li, i) => li.classList.toggle("wf-hit", i === roll - 1));
      wfResult.hidden = false;
      wfResult.replaceChildren(el("b", {}, `Rolled ${roll}: `), rolled);
      play.kismet_log.unshift({ label: `Windfall (d6=${roll}): ${rolled}`, delta: 0 });
      playChanged(false);
    }, "good")),
    wf, wfResult);
  body.append(boons);

  // --- ledger
  const ledger = el("div", { class: "card sh-card" }, el("h3", {}, "Ledger"));
  if (!play.kismet_log.length)
    ledger.append(el("p", { class: "hint" }, "No Kismet activity yet."));
  else {
    const t = el("table", { style: "max-width:640px" });
    t.append(el("tr", {}, el("th", {}, "Entry"), el("th", { class: "num" }, "Kismet"), el("th", {}, "")));
    play.kismet_log.slice(0, 40).forEach(entry =>
      t.append(el("tr", {},
        el("td", {}, entry.label),
        el("td", { class: "num", style: entry.delta > 0 ? "color:var(--ok)" : entry.delta < 0 ? "color:var(--bad)" : "" },
          entry.delta > 0 ? `+${entry.delta}` : String(entry.delta)),
        el("td", {}, entry.undo
          ? el("button", { class: "btn small",
              title: entry.delta < 0 ? "Refund the Kismet and reverse this spend"
                : entry.delta > 0 ? "Take this award back, lifetime total included"
                : "Reverse this and free up the boon slot it spent",
              onclick: async () => { undoKismetSpend(entry); await playChangedRecalc(); } }, "Undo")
          : null))));
    ledger.append(t);
  }
  body.append(ledger);
}

/* Fixed 3x1 mod-slot strip for a weapon (Overbarrel / Underbarrel / Chassis),
 * replacing the old side-stacked mod chip list. Each box shows the currently
 * fitted mod's name above its chip (or "—" when empty), with an inline picker
 * to fit a new mod once a box is empty. Dual-slot mods (e.g. Laser Sight, fits
 * either barrel slot) land in whichever of their candidate slots is free. */
function weaponModSlots(entry, mult, weaponName, weaponRow) {
  const table = DATA.tables.weapon_mods;
  const order = ["Overbarrel", "Underbarrel", "Chassis"];
  // A percentage-priced mod (Bling) costs a share of this gun, so every price
  // below — fitting, selling, the dropdown label — is quoted per weapon.
  const base = RULES.weaponBaseCost(weaponRow || {}, entry.ref);
  const priceOf = m => Math.round(RULES.weaponModCost(m, base) * mult);
  const sub = sublistOf(entry, "mods");
  const boxes = RULES.assignWeaponModSlots(sub.items, table).assigned;
  const grid = el("div", { class: "sh-modslots" });
  for (const slot of order) {
    const modName = boxes[slot];
    const modRow = modName ? table.find(m => m.Modification === modName && m.Slot === slot) : null;
    const cls = modSlotClass(slot);
    const box = el("div", { class: `sh-modslot ${cls}` },
      el("div", { class: "sh-modslot-label" }, slot),
      el("div", { class: "sh-modslot-active" }, modName || "—"));
    if (modName) {
      box.append(el("span", {
        class: `chip ${cls}`, style: "cursor:pointer",
        title: "Click to sell or remove",
        onclick: () => {
          const idx = sub.items.findIndex(m => sublistName(m) === modName);
          if (idx < 0) return;
          disposeOfMod({ entry, list: "mods", index: idx, name: modName,
            hostName: weaponName, value: priceOf(modRow) });
        },
      }, modName + " ✕"));
      if (modRow && modRow.Effect)
        box.append(el("div", { class: "sh-modslot-eff" }, modRow.Effect));
    } else {
      const options = table.filter(m => m.Slot === slot);
      box.append(el("select", {
        onchange: e => {
          const name = e.target.value;
          if (!name) return;
          const mr = table.find(m => m.Modification === name && m.Slot === slot);
          const cost = priceOf(mr);
          if (CHAR.play.cash < cost
              && !confirm(`${name} costs ${fmt(cost)} but you have ${fmt(CHAR.play.cash)}. Overdraw?`)) {
            e.target.value = ""; return;
          }
          sub.add(name);
          logCash(`Fitted ${name} to ${weaponName}`, -cost,
            { kind: "weapon_mod", host: weaponName, name });
          playChangedRecalc();
        },
      }, el("option", { value: "" }, `+ ${slot}…`),
        ...options.map(m => el("option", { value: m.Modification },
          `${m.Modification} (${fmt(priceOf(m))})`))));
    }
    grid.append(box);
  }
  return grid;
}

/* Split an upgrade cost string into the Woolong part and any special-currency
 * remainder: "1500 + 50 Tc" -> {cash:1500, special:"50 Tc"}; "250" -> {cash:250}.
 * Some rows use "and" as the separator ("10000 and 200 Tc"). */
function parseUpgradeCost(str) {
  const m = /^\s*([\d,]+)\s*(?:(?:\+|and)\s*(.+))?$/i.exec(str || "");
  if (!m) return { cash: 0, special: (str || "").trim() };
  return { cash: parseInt(m[1].replace(/,/g, ""), 10) || 0, special: (m[2] || "").trim() };
}

/* Fixed Upgrade 1 / Upgrade 2 boxes for a weapon. Each weapon has at most one
 * of each, defined on its data row (Upgr1_Cost/Upgr1_Eff/Upgr2_Cost/Upgr2_Eff).
 * Unpurchased: the box shows the cost with a Buy button. Purchased: it shows
 * the upgrade's effect. Mixed costs ("1500 + 50 Tc") deduct the Woolong part
 * from cash; the special part pops a reminder to settle with the Agonarch. */
function weaponUpgradeSlots(w, r, mult) {
  const boxes = [];
  for (const n of [1, 2]) {
    const costStr = r[`Upgr${n}_Cost`] || "";
    const eff = r[`Upgr${n}_Eff`] || "";
    if (!costStr && !eff) continue;
    const key = `upgr${n}`;
    const label = `Upgrade ${n}`;
    const box = el("div", { class: "sh-modslot mod-upgrade" },
      el("div", { class: "sh-modslot-label" }, label));
    if (w[key]) {
      box.append(
        el("div", { class: "sh-modslot-active" },
          el("span", { class: "chip mod-upgrade", style: "cursor:pointer",
            title: "Installed — click to remove (not refunded)",
            onclick: async () => {
              if (!confirm(`Remove ${label} (${eff}) from ${w.name}? Not refunded.`)) return;
              delete w[key];
              await playChangedRecalc();
            } }, "Installed ✕")),
        el("div", { class: "sh-modslot-eff" }, eff));
    } else {
      const { cash, special } = parseUpgradeCost(costStr);
      const cost = Math.round(cash * mult);
      box.append(
        el("div", { class: "sh-modslot-active" }, fmt(cost) + (special ? ` + ${special}` : "")),
        el("div", { class: "sh-modslot-eff" }, eff),
        el("button", { class: "btn small", style: "margin-top:4px",
          onclick: async () => {
            if (!confirm(`Install ${label} on ${w.name}?\n\n${eff}\nCost: ${fmt(cost)}${special ? ` + ${special}` : ""}`))
              return;
            if (CHAR.play.cash < cost
                && !confirm(`${label} costs ${fmt(cost)} but you have ${fmt(CHAR.play.cash)}. Overdraw?`))
              return;
            w[key] = true;
            logCash(`Installed ${label} (${eff}) on ${w.name}`, -cost);
            if (special)
              alert(`${label} on ${w.name} has an extra cost of ${special} on top of the Woolongs.\n\nMake sure that cost is paid — consult with the Agonarch.`);
            await playChangedRecalc();
          } }, "Buy"));
    }
    boxes.push(box);
  }
  return boxes;
}

/* ------------------------------------------------ gear tab */
/* Which Gear-list categories are expanded, keyed by Class. Module-level like
 * browserOpenState: toggling one re-renders the sheet, so it can't live in the
 * DOM, and it isn't part of the character. Missing = open, so a kit reads
 * exactly as it always did until you collapse something. */
const gearCatOpen = {};

/* Uses tracker for consumables bought per use (Ammo). Adjusts the owned count
   in place and moves NO cash — spending a use isn't a sale, and buying more
   goes through the Buy section, which charges per use. Floors at 0 so a spent
   stack can sit at zero rather than being forced to 1 like other gear. */
/* How much of a placed spirit's effect actually moved a number: all of it, none
   of it, or some. Shared by the Overview infusion card and the Magic tab so the
   two can't disagree. */
function infusionAppliedLabel(spirit) {
  const mods = CALC.infusion_mods || { applied: [], unapplied: [] };
  const applied = (mods.applied || []).some(a => a.source === spirit);
  const pending = (mods.unapplied || []).some(a => a.source === spirit);
  if (applied && pending) return "partly in stats";
  return applied ? "in stats" : "situational";
}

/* Carried-count spinner for a gear row: 0 .. owned. carriedQty / setCarriedQty
 * live in app.js (loaded first) so chargen and the play sheet share one
 * definition of what "carried" means. */
function shCarriedStepper(entry, onChange) {
  const val = el("span", { class: "sv" }, String(carriedQty(entry)));
  const set = async n => {
    val.textContent = String(setCarriedQty(entry, n));
    await onChange();
  };
  const btn = (delta, label, title) => el("button", { class: "btn small", title,
    onclick: () => set(carriedQty(entry) + delta) }, label);
  return el("span", { class: "stepper", title: `Carrying out of ${ownedQty(entry)} owned` },
    btn(-1, "–", "Carry one fewer — the rest stays in your stash"),
    val,
    btn(1, "+", "Carry one more"));
}

/* A bow's Minimum Strength, shown on its row in play. Re-rating a bow in play
 * is really re-buying it, so this is a read-out rather than a stepper: it says
 * what the bow needs and goes red when the character can no longer draw it,
 * which is exactly the case that appears mid-campaign when Strength drops.
 * Returns null for anything that isn't a bow. */
function shMinStrControl(entry, row) {
  const bow = RULES.bowRating(row, entry);
  if (!bow) return null;
  const strength = CALC.attributes.Strength.final;
  const short = strength < bow.minStr;
  return el("span", { class: "sub", style: "margin-left:8px" + (short ? ";color:var(--bad)" : ""),
    title: short ? `Needs Strength ${bow.minStr} to draw — this character has ${strength}`
                 : `Rated to Strength ${bow.minStr}` },
    `Min STR ${bow.minStr}${short ? " ⚠" : ""}`);
}

/* Taking the hotseat means jacking in, and that takes a VCR. Owning one is the
 * test: equippedSelect makes the first rig owned the active one by default, so
 * "owns a rig" and "has one equipped" are the same state in practice. */
function hasVcrRig() { return allRigs().length > 0; }

/* "Hotseat": the unit the player is currently piloting. One at a time — you
 * can't be in two cockpits — so ticking one clears the rest. Its stat block is
 * what the Overview puts above the character's own weapons. */
function shHotseatToggle(key, u) {
  const rg = rigFlags();
  const on = !!rg.hotseat[key];
  const rigged = hasVcrRig();
  return el("label", { class: "sub" + (rigged ? "" : " sh-disabled"),
      style: "display:inline-flex;align-items:center;gap:6px;margin-top:4px",
      title: rigged
        ? `Piloting ${u.label || u.name} — its stats move to the Overview`
        : "No VCR owned — nothing to jack into. Buy a rig on this tab first." },
    el("input", { type: "checkbox", ...(on ? { checked: 1 } : {}),
      ...(rigged ? {} : { disabled: "1" }),
      onchange: e => {
        const want = e.target.checked;
        for (const k of Object.keys(rg.hotseat)) rg.hotseat[k] = false;
        rg.hotseat[key] = want;
        playChanged();
        renderSheet();
      } }),
    el("span", {}, "Hotseat"));
}

/* Plain Carried yes/no for a deck, drone or vehicle — the same flag misc gear
 * uses, minus the quantity. Only carried gear contributes Zoetic Rating. */
function shCarriedToggle(entry) {
  return el("label", { class: "sub",
      style: "display:inline-flex;align-items:center;gap:6px;margin-top:4px",
      title: "Only carried gear contributes Zoetic Rating" },
    el("input", { type: "checkbox", ...(entry.carried !== false ? { checked: 1 } : {}),
      onchange: async e => { entry.carried = e.target.checked; await playChangedRecalc(); } }),
    el("span", {}, "Carried"));
}

/* How many of this you own. Ammo counts in uses, everything else in items, but
 * the control is the same: things get used up at the table — doses taken, rounds
 * fired, grenades thrown — and that has to be recordable without deleting the
 * row and losing the rest of the stack. No cash moves either way: spending isn't
 * selling, and the + is for stock you already have (buying goes through the Buy
 * section, which charges). A stack floors at 0 rather than 1, so an empty one
 * sits there as a reminder to restock; the ✕ is what removes it for good. */
/* Move a stack by `delta`, flooring at 0, and log it. Returns how many actually
 * moved — 0 when the stack was already empty, which is how a caller tells "one
 * came out" from "there was nothing to take". */
function adjustOwned(entry, delta) {
  const before = ownedQty(entry);
  entry.qty = Math.max(0, before + delta);
  const moved = entry.qty - before;
  // Carrying more than you own is nonsense; carriedQty already clamps on
  // read, and this keeps the stored number honest too.
  if (entry.carried_qty != null && entry.carried_qty > entry.qty)
    setCarriedQty(entry, entry.qty);
  logItemUse(entry.name, moved, entry.qty);
  return moved;
}

function shUsesStepper(entry, onChange, unit = "use") {
  const val = el("span", { class: "sv" }, String(ownedQty(entry)));
  const btn = (delta, label, title) => el("button", { class: "btn small", title,
    onclick: async () => {
      adjustOwned(entry, delta);
      val.textContent = String(entry.qty);
      await onChange();
    } }, label);
  return el("span", { class: "stepper" },
    btn(-1, "–", `Spend one ${unit} (no refund)`),
    val,
    btn(1, "+", `Add one ${unit} you already own — buy more in the Buy section below`));
}

/* "Use" for a dose: spend one from the stack and start being under its effects.
 *
 * Two separate things happen and both matter — the stack goes down whether or
 * not the drug does anything mechanical (Glitter is still gone), and a dose
 * entry appears so the banner can show it and give it a dismiss.
 *
 * An empty stack disables the button rather than hiding it: the row is still
 * there as a reminder to restock, and a button that vanished at zero would read
 * as "this isn't a drug any more". */
function shUseDoseBtn(entry, row, owned) {
  const cap = RULES.gearMaxDoses(row);
  const live = doseCount(entry.name);
  const swing = doseSummary(entry.name);

  let title;
  if (!owned) title = `None left — restock ${entry.name} before taking one`;
  else if (swing && live >= cap)
    title = `Take one more ${entry.name}. ${cap} already counting, so this dose `
          + `adds nothing (stacks up to ${cap}) — but it still leaves the stack`;
  else title = `Take one ${entry.name}`
          + (swing ? ` — ${swing} until you dismiss it` : " — tracked in Under the Effects Of");

  return el("button", {
    class: "btn small use-dose" + (owned ? "" : " off"),
    ...(owned ? {} : { disabled: 1 }),
    title,
    onclick: async () => {
      if (adjustOwned(entry, -1) === 0) return;   // nothing left to take
      takeDose(entry.name);
      // The banner used to be unfolded here so the first dose could not be
      // missed. It no longer needs the nudge: the first dose turns the header's
      // "Running now" panel from absent to present on every tab, which is a
      // louder signal than unfolding a banner on a tab you may not be looking at.
      await playChangedRecalc();
    } }, "Use");
}

/* A configure-then-buy dialog for anything whose price depends on choices.
 *
 * Buying armor or a vehicle in play used to be two disconnected halves: you
 * paid the base price on the Buy list, and only afterwards found the Quality,
 * Style, Extras or Condition controls on the owned row, each charging its own
 * difference as you touched it. That works, but it asks the player to commit
 * before they can see what the thing actually costs. This collects every
 * decision first, prices them together, and asks once (#73).
 *
 * `fields` are {key, label, type: "select" | "checks", options: [{value, label}],
 * initial}. `priceOf(state)` returns the total for the current choices -- the
 * caller owns the arithmetic, because armor surcharges ADD onto the base while
 * a vehicle Condition SCALES it, and this dialog should not have an opinion.
 *
 * Resolves to the chosen state, or null if cancelled. An unaffordable total is
 * shown and named but not blocked: overdrawing is the player's call everywhere
 * else in play, and it stays their call here.  */
function buyDialog({ title, sub, fields, priceOf }) {
  return new Promise(resolve => {
    const state = {};
    for (const f of fields) state[f.key] = f.initial;
    const backdrop = el("div", { class: "mount-modal-backdrop" });
    const done = v => { document.removeEventListener("keydown", onKey); backdrop.remove(); resolve(v); };
    const onKey = e => { if (e.key === "Escape") done(null); };

    const totalLine = el("div", { class: "sh-buy-total" });
    const cashLine = el("div", { class: "sub" });
    const buyBtn = el("button", { class: "btn-add", onclick: () => done(state) }, "Buy");
    const refresh = () => {
      const total = priceOf(state);
      totalLine.replaceChildren(el("span", { class: "sub" }, "Total "), el("b", {}, fmt(total)));
      const over = total - CHAR.play.cash;
      cashLine.textContent = over > 0
        ? `You have ${fmt(CHAR.play.cash)} — this overdraws by ${fmt(over)}.`
        : `You have ${fmt(CHAR.play.cash)}, leaving ${fmt(-over)}.`;
      cashLine.style.color = over > 0 ? "var(--bad)" : "";
      buyBtn.textContent = over > 0 ? "Buy anyway" : "Buy";
    };

    const rows = fields.map(f => {
      if (f.type === "checks") {
        const box = el("div", { class: "sh-buy-checks" });
        for (const o of f.options) {
          box.append(el("label", { class: "opt" },
            el("input", { type: "checkbox",
              onchange: e => {
                const set = new Set(state[f.key]);
                if (e.target.checked) set.add(o.value); else set.delete(o.value);
                state[f.key] = [...set];
                refresh();
              } }),
            el("span", {}, o.label)));
        }
        return el("div", { class: "sh-buy-field" }, el("b", {}, f.label), box);
      }
      const sel = el("select", { onchange: e => { state[f.key] = e.target.value; refresh(); } },
        ...f.options.map(o => el("option", { value: o.value }, o.label)));
      sel.value = f.initial ?? "";
      return el("div", { class: "sh-buy-field" }, el("b", {}, f.label), sel);
    });

    const modal = el("div", { class: "card mount-modal", style: "max-width:460px" },
      el("h3", {}, title),
      sub ? el("p", { class: "hint" }, sub) : null,
      ...rows,
      el("div", { class: "sh-buy-foot" }, totalLine, cashLine),
      el("div", { style: "display:flex;gap:8px;margin-top:12px" },
        buyBtn,
        el("button", { class: "btn", onclick: () => done(null) }, "Cancel")));
    backdrop.append(modal);
    backdrop.addEventListener("click", e => { if (e.target === backdrop) done(null); });
    document.addEventListener("keydown", onKey);
    document.body.append(backdrop);
    refresh();
  });
}
/* A Quality/Style dropdown on an owned piece of armor, priced like an Extra.
 *
 * The multiplier is on the piece as a whole, so the marginal charge is
 * base x (multiplier - 1) and a SWITCH costs the difference between the two.
 * Charging the full new multiplier each time would bill the player again for
 * armor they already own; refunding on a downgrade is the same rule read
 * backwards. An overdraw is refused and the select snaps back, rather than
 * leaving the piece changed and the cash negative.
 *
 * The previous value rides along in the ledger entry so Undo can restore it --
 * a field, unlike a fitted Extra, has nothing to remove (#73).
 *
 * `overdrawOK` is handed in rather than reached for: it is a closure inside the
 * Gear tab (it needs that tab's surcharge multiplier), and an async handler that
 * throws for an out-of-scope name fails SILENTLY as an unhandled rejection --
 * the dropdown moves, nothing else does, and there is no error to read. */
function armorTraitSelect({ entry, field, table, column, label, baseCost, mult, overdrawOK }) {
  const current = entry[field] || "";
  const multOf = v => {
    const row = table.find(x => x[column] === v);
    return row ? (+row.Multiplier || 1) : 1;
  };
  const sel = el("select", { class: "btn-select",
    onchange: async e => {
      const next = e.target.value;
      const delta = Math.round(baseCost * (multOf(next) - multOf(current)) * mult);
      if (delta > 0 && !overdrawOK(next || label, delta)) { e.target.value = current; return; }
      entry[field] = next;
      logCash(next ? `${entry.name}: ${label} ${next}` : `${entry.name}: ${label} cleared`,
        -delta, { kind: "armor_trait", host: entry.name, field, from: current });
      await playChangedRecalc();
    } },
    el("option", { value: "" }, `${label}…`),
    ...table.map(x => el("option", { value: x[column] }, `${x[column]} ×${x.Multiplier}`)));
  sel.value = current;
  return sel;
}
/* Mounted-augment editor for host gear (Power Armor, Arwin Goggles, homebrew
   with a "Mount Types" column). Mounted augments are managed with the gear —
   they never appear on the Augments tab, their ZR is exempt from ZP, and
   their effects only apply while the host is worn / carried / equipped. */
function shMountEditor(entry, hostRow, hostActive) {
  const host = entry.ref;
  const cap = RULES.mountCapability(hostRow || {});
  if (!cap) return null;
  const sub = sublistOf(entry, "mounted");
  const mult = CALC.budget.gear_cost_multiplier || 1;
  const r2 = x => Math.round(x * 100) / 100;
  const copies = Math.max(1, +(host.qty || 1));   // armor entries have no qty
  const capacity = r2(cap.capacity * copies);
  const augRow = name => DATA.tables.augments.find(a => a.Name === name);
  const used = r2(sub.items.reduce((sum, m) => {
    const row = augRow(m.name);
    return sum + (row ? RULES.augmentEffZr(row, m) : 0);
  }, 0));

  const over = used - capacity > 1e-9;
  const free = r2(capacity - used);

  // Same compact layout + modal picker as chargen (helpers shared from
  // app.js); adding here is a purchase, so it charges cash and hits the ledger.
  const wrap = el("div", { class: "sub" });
  wrap.append(el("div", { style: "display:flex;align-items:center;gap:6px;flex-wrap:wrap" },
    el("b", {}, "Mounts"),
    el("span", { style: over ? "color:var(--bad)" : "",
      title: `Mounted augments' ZR never counts against your ZP · accepts ${cap.label}` },
      `${used} / ${capacity} ZP`),
    hostActive ? null : el("span", {}, "· inactive — effects offline"),
    el("button", { class: "btn-add", title: `Accepts ${cap.label} — ${free} ZP free`,
      onclick: () => openMountPicker({
        title: `Mount on ${host.name} — ${free} ZP free`,
        groups: mountBrowserGroups(cap, free, sub.items, mult),
        afterAdd: () => playChangedRecalc(),
        onAdd: name => {
          const row = augRow(name) || {};
          const cost = Math.round((+row.Cost || 0) * mult);
          if (CHAR.play.cash < cost
              && !confirm(`${name} costs ${fmt(cost)} but you have ${fmt(CHAR.play.cash)}. Overdraw?`))
            return;
          sub.add({ name });
          logCash(`Mounted ${name} on ${host.name}`, -cost,
            { kind: "mount", host: host.name, name });
        },
      }) }, "+ Mount")));

  if (sub.items.length) {
    wrap.append(el("div", {}, ...sub.items.map((m, idx) => {
      const row = augRow(m.name) || {};
      const hasZr = +row.ZR > 0;
      // Same α-cyber cash math as the Augments tab: going alpha adds
      // max(base cost, 1000) × the gear multiplier (mirrors rules.js effCost).
      const alphaExtra = Math.round(Math.max(+row.Cost || 0, 1000) * mult);
      return el("span", { class: "chip", style: "margin:2px 4px 0 0" },
        `${m.name} · ${RULES.augmentEffZr(row, m)} `,
        hasZr ? el("button", { class: "chip-btn" + (m.alpha ? " alpha-on" : ""),
          title: (m.alpha ? "α-cyber grade — click to revert" : "Upgrade to α-cyber grade")
            + ` (ZR −20% min 0.1, cost ×2 min +${currencySymbol()}1,000)`,
          onclick: async () => {
            const now = !m.alpha;
            // On a chargen host the mount object IS the creation record, so
            // flipping the flag in place would re-price what creation paid for.
            // Swap it instead: drop the old, fit an α copy, both in play.
            if (sub.onChargenHost && idx < sub.baseCount) {
              sub.removeAt(idx);
              sub.add({ ...m, alpha: now });
            } else {
              m.alpha = now;
            }
            logCash(now ? `Upgraded ${m.name} (${host.name}) to α-cyber grade`
                        : `Reverted ${m.name} (${host.name}) from α-cyber grade`,
              now ? -alphaExtra : alphaExtra);
            await playChangedRecalc();
          } }, "α") : null,
        el("button", { class: "chip-btn", title: "Unmount — sell it on or write it off",
          onclick: () => disposeOfMod({ entry, list: "mounted", index: idx,
            name: m.name, hostName: host.name,
            value: Math.round((+row.Cost || 0) * mult) }) }, "✕"));
    })));
  }
  return wrap;
}

function shGear(body) {
  const play = CHAR.play;
  // Shared read-only flag for the tab's editable controls (a shared view reads
  // the same sheet but must not spend, sell or use anything up).
  const ro = !!(activeTabObj() && activeTabObj().readonly);
  // Weapons & armor carry the small-heritage surcharge; general gear does not.
  const mult = RULES.surchargeFor("weapon", CALC.budget.gear_cost_multiplier || 1);
  const gearMult = RULES.surchargeFor("gear", CALC.budget.gear_cost_multiplier || 1);
  // Armor additionally carries the Extra Arm / Extra Leg +50% surcharge.
  const armorMult = RULES.surchargeFor("armor", CALC.budget.gear_cost_multiplier || 1)
    * (CALC.budget.armor_cost_multiplier || 1);
  const overdrawOK = (name, cost) => CHAR.play.cash >= cost
    || confirm(`${name} costs ${fmt(cost)} but you have ${fmt(CHAR.play.cash)}. Overdraw?`);

  // ===== Jump submenu: scroll to any section within the gear tab.
  const jump = id => () => document.getElementById(id)
    ?.scrollIntoView({ behavior: "smooth", block: "start" });
  body.append(el("div", { class: "gear-submenu" },
    ...[["gear-cash", RULES.currencyName()], ["gear-lifestyle", "Lifestyle"], ["gear-weapons", "Weapons"],
        ["gear-armor", "Armor"], ["gear-gear", "Gear"],
        ["gear-vehicles", "Vehicles"], ["gear-buy", "Buy"]]
      .map(([id, label]) => el("button", { onclick: jump(id) }, label))));

  // ===== Woolongs on hand + Lifestyle — half-width, side by side.
  const amt = el("input", { type: "number", value: "100", min: "1",
    "aria-label": `${RULES.currencyName()} to add or subtract`, style: "width:90px" });
  const applyCash = sign => {
    const n = parseInt(amt.value, 10);
    if (!Number.isFinite(n) || n <= 0) return;
    logCash(sign > 0 ? "Cash awarded" : "Cash spent", sign * n);
    playChanged();
  };
  const woolongsCard = el("div", { class: "card sh-card", id: "gear-cash" },
    el("h3", {}, `${RULES.currencyName()} on hand`),
    el("div", { class: "sh-cash-row" },
      el("div", { class: "big cash" }, fmt(play.cash)),
      el("span", { class: "sh-inline-adjust" },
        amt,
        el("button", { class: "btn good", onclick: () => applyCash(1) }, "+ Add"),
        el("button", { class: "btn warn", onclick: () => applyCash(-1) }, "− Subtract"))),
    el("p", { class: "hint" },
      "Unspent chargen cash was forfeited at finalize; starting cash was rolled 4d6×100. "
      + "Money gained in play can be spent any time — buy equipment in the Buy section below."));
  const lsCard = lifestyleCard();
  lsCard.id = "gear-lifestyle";

  // Carried load: equipped weapons + worn armor + gear vs Strength. Sits
  // half-width, stacked under Woolongs.
  const wtNum = n => +n || 0;
  let load = 0;
  allWeapons().filter(w => w.equipped !== false).forEach(w => {
    const r = DATA.tables.weapons.find(x => x.Weapon === w.name) || {};
    load += wtNum(r.Weight);
  });
  allArmor().filter(a => a.active !== false).forEach(a => {
    const r = DATA.tables.armor.find(x => x.Armor === a.name) || {};
    load += wtNum(r.wt);
  });
  // Only what's actually on you counts against Strength -- gear left in a stash
  // carries no weight, which is the point of the per-item carried count.
  allGear().forEach(g => {
    const r = DATA.tables.misc_gear.find(x => x.Item === g.name) || {};
    load += wtNum(r.Weight) * carriedQty(g);
  });
  load = Math.round(load * 10) / 10;
  const strength = CALC.attributes.Strength.final;
  const overburdened = load > strength;
  const loadCard = el("div", { class: "card sh-card", id: "gear-load" }, el("h3", {}, "Carried load"),
    el("div", { class: "sh-advrow" },
      el("span", {}, "Equipped/worn weight vs Strength"),
      el("b", { style: overburdened ? "color:var(--bad)" : "" }, `${load} / ${strength}`)));
  // The engine's own total: everything OWNED rather than only what's on you,
  // so the gap between the two lines is what you left in the stash. Shown only
  // when they disagree — with nothing stashed they're the same number, and two
  // identical rows would just look like a bug.
  if (Math.abs((CALC.combat.carried_weight || 0) - load) > 0.05) {
    loadCard.append(el("div", { class: "sh-advrow" },
      el("span", { class: "sub" }, "Total owned weight"),
      el("b", { class: "sub" }, String(CALC.combat.carried_weight))));
  }
  // Chrome used to be added INTO the weight above, which mixed a Zoetic Rating
  // into a figure measured in kilograms (#65). It's a real burden and still
  // worth seeing here beside the gear it competes with, but it is its own unit
  // and never presses on Strength — so it gets its own line, named for what it
  // is. Already zero for Synthetics, who don't pay it.
  const chromeZr = (CALC.zoetics || {}).augment_zr || 0;
  if (chromeZr)
    loadCard.append(el("div", { class: "sh-advrow" },
      el("span", { class: "sub" }, "Chrome — Zoetic Rating (not weight)"),
      el("b", { class: "sub" }, String(chromeZr))));
  if (overburdened)
    loadCard.append(el("div", { class: "sh-callout", style: "border-color:var(--bad);color:var(--bad)" },
      el("b", {}, "Overburdened — "),
      `carrying ${load} weight exceeds Strength ${strength}.`));

  body.append(el("div", { class: "sh-two" },
    el("div", {}, woolongsCard, loadCard),
    lsCard));

  // ===== Weapons — owned table (equipped toggle stays live, remove). Buying
  // moved to the Buy section at the bottom.
  const weaponCard = el("div", { class: "card sh-card", id: "gear-weapons" }, el("h3", {}, "Weapons"));
  if (mult > 1) weaponCard.append(el("p", { class: "hint" }, `Heritage surcharge: all costs ×${mult}.`));
  weaponCard.append(el("div", { class: "mod-slot-legend" },
    el("span", { class: "mod-overbarrel" }, "● Overbarrel"),
    el("span", { class: "mod-underbarrel" }, "● Underbarrel"),
    el("span", { class: "mod-chassis" }, "● Chassis"),
    el("span", { class: "mod-upgrade" }, "● Upgrade")));
  if (CALC.combat.optics_notes && CALC.combat.optics_notes.length)
    weaponCard.append(el("p", { class: "hint" }, "Optics: " + CALC.combat.optics_notes.join(" · ")));
  const weaponBuyGroups = Object.entries(
    DATA.tables.weapons.reduce((acc, r) => (((acc[r.Type] ??= []).push(r)), acc), {}))
    .map(([type, rows]) => ({
      label: WEAPON_TYPE_LABELS[type] || type,
      // A bow is priced and rated by the Strength it takes to draw. Buying one
      // in play rates it to this character's Strength — the heaviest they can
      // actually use — and prices it accordingly, so the browser shows what
      // this buyer would pay rather than a base cost the row doesn't have.
      items: rows.map(r => {
        const bow = RULES.bowRating(r, { min_str: CALC.attributes.Strength.final });
        return { name: r.Weapon,
          cost: Math.round((bow ? bow.cost : (+r.Cost || 0)) * mult),
          sub: (r.Type === "Melee" ? `Reach ${r.Reach || 0}` : `Acc ${r.Accuracy || 0}`)
            + ` · DMG ${r.Type === "Melee" ? RULES.meleeDamage(r, CALC.attributes.Strength.final)
                       : bow ? `${bow.damage} (Min STR ${bow.minStr})` : (r.Damage || "—")}`
            + ` · Pen ${r.Pen || 0}` + barrierBit(r, r.Bar)
            + ` · Conceal ${r.Conceal || 0} · ZR ${r.ZR || 0} · wt ${r.Weight || 0}` };
      }),
    }));
  const cyberguns = equippedCyberguns();
  const weaponEntries = ownedWeapons();
  if (weaponEntries.length || cyberguns.length) {
    const t = el("table");
    t.append(el("tr", {}, el("th", {}, "Weapon"), el("th", {}, "Stats"),
      el("th", {}, "Equip"), el("th", {}, "")));
    weaponEntries.forEach(en => {
      const { ref: w, arr, i: wi, inPlay, category } = en;
      const r = DATA.tables.weapons.find(x => x.Weapon === w.name) || {};
      const canMod = !NO_WEAPON_MOD_TYPES.includes(r.Type);
      const calcRow = (CALC.weapons || []).find(x => x.Weapon === w.name) || {};
      t.append(el("tr", {},
        el("td", {},
          // Reordering stays inside the owning array — dragging a play purchase
          // above a chargen one would change which budget paid for it.
          reorderHandle(() => arrayMove(arr, wi, -1), () => arrayMove(arr, wi, 1),
            wi > 0, wi < arr.length - 1),
          el("b", {}, w.name + ((calcRow.smart ?? w.smart) ? " (smart)" : "")),
          // The same skill chip the Overview shows for this weapon — "(5d)",
          // the limit you'd roll — rather than a sentence naming the pool as
          // well. Two spellings of one stat across two tabs read as two stats
          // and invited the reader to work out which was right. Firing-mode
          // bonus dice still aren't included here: the mode is chosen on the
          // Overview, so this is the weapon's own limit either way.
          el("span", { class: "sub sh-gear-dice" },
            weaponSkillDice(w.name, r.Type, calcRow.Accuracy ?? r.Accuracy ?? 0, [], r.Reach)),
          shMountEditor(en, r, w.equipped !== false)),
        el("td", { class: "sub" },
          `${r.Type || ""} · Acc ${calcRow.Accuracy ?? r.Accuracy ?? 0} · DMG ${calcRow.Damage ?? r.Damage ?? "—"} · ${r["Firing modes"] || "melee"} · Pen ${r.Pen || 0}${barrierBit(r, calcRow.Bar ?? r.Bar)} · Conceal ${concealBit(r, calcRow)} · ZR ${r.ZR || 0} · Weight ${r.Weight || 0}${weaponTraitBits(r)}` +
          ((calcRow.Ammo ?? r.Ammo) ? ` · Ammo ${calcRow.Ammo ?? r.Ammo}` : "") +
          recoilBit(calcRow)),
        el("td", {},
          el("input", { type: "checkbox", ...(w.equipped !== false ? { checked: 1 } : {}),
            onchange: async e => { w.equipped = e.target.checked; await playChangedRecalc(); } }),
          shMinStrControl(w, r),
          // Thrown weapons stack, and a thrown grenade is gone. Same −/+ the
          // gear rows carry, so the stack can run down without deleting it.
          (!ro && r.Type === "Thrown")
            ? el("div", { class: "sub", style: "margin-top:4px" },
                el("span", { class: "sub" }, "Qty "),
                shUsesStepper(w, playChangedRecalc, "grenade"))
            : null),
        el("td", {}, el("button", { class: "row-del", title: "Sell / remove weapon",
          onclick: () => {
            // (#81) Fitted mods and mounted augments go with the gun, so their
            // money comes back with it — in full, not scaled by condition.
            // Before this they were simply lost: the sale quoted the bare
            // table price and everything bolted on was thrown in for free.
            const fitted = weaponModsValue(w, r, mult) + mountedValue(w, mult);
            return disposeOfItem({ category, arr, index: wi, inPlay, name: w.name,
              value: Math.round((+r.Cost || 0) * mult) + fitted, modsValue: fitted });
          } }, "✕"))));
      const upgBoxes = weaponUpgradeSlots(w, r, mult);
      if (canMod || upgBoxes.length) {
        const strip = canMod ? weaponModSlots(en, mult, w.name, r)
                             : el("div", { class: "sh-modslots" });
        upgBoxes.forEach(b => strip.append(b));
        t.append(el("tr", { class: "sh-modslots-row" },
          el("td", { colspan: "4" }, strip)));
      }
    });
    cyberguns.forEach(cg => {
      const g = cg.gun;
      t.append(el("tr", {},
        el("td", {}, el("b", {}, cg.name + " (smart)"),
          el("div", { class: "sub" }, "Implanted cyberarm gun — configured on the Augments tab")),
        el("td", { class: "sub" },
          `Cybergun · Acc ${g.Acc} · DMG ${g.Dmg} · ${g.Modes} · Pen ${g.Pen}${barrierBit(g, g.Bar)} · Ammo ${g.Ammo}`
          + ` · Hardening ${RULES.hardeningOf(g)}`
          + recoilBit(RULES.cybergunRecoil(g, CALC.combat))),
        el("td", { class: "sub" }, "—"),
        el("td", {}, "")));
    });
    // Underbarrel weapons: granted by a mod on the gun above them, so they sit
    // in the list but carry no sell control — you remove the mod instead.
    underbarrelWeapons().forEach(ub => {
      const r = ub.row;
      const gren = loadedGrenadeFor(ub.state);
      t.append(el("tr", {},
        el("td", {}, el("b", {}, ub.name), " ",
          el("span", { class: "sh-tag" }, "Underbarrel"),
          el("span", { class: "sub sh-gear-dice" },
            weaponSkillDice(ub.name, r.Type, r.Accuracy || 0, [], r.Reach)),
          el("div", { class: "sub" }, `Fitted to ${ub.host} — remove the ${ub.mod} mod to lose it`)),
        el("td", { class: "sub" },
          `${r.Type || ""} · Acc ${r.Accuracy || 0}`
          + ` · DMG ${gren.row ? (gren.row.Damage || r.Damage) : (r.Damage || "—")}`
          + ` · ${r["Firing modes"] || "—"} · Pen ${r.Pen || 0}${barrierBit(r, r.Bar)}`
          + (r.Ammo ? ` · Ammo ${r.Ammo}` : "")
          + ` · Hardening ${RULES.hardeningOf(r)}`),
        // The chambered grenade is pickable here as well as on the Overview,
        // matching every other weapon row on this tab.
        el("td", { class: "sub" }, munitionPicker(ub.state, r)),
        el("td", {}, "")));
    });
    weaponCard.append(t);
  } else {
    weaponCard.append(el("p", { class: "hint" }, "No weapons owned — buy some in the Buy section below."));
  }
  body.append(weaponCard);

  // ===== Armor — owned table (worn toggle stays live, remove). Buying moved
  // to the Buy section at the bottom.
  const armorCard = el("div", { class: "card sh-card", id: "gear-armor" }, el("h3", {}, "Armor"),
    el("p", { class: "hint" },
      `Current totals: ${CALC.combat.ballistic_armor}B / ${CALC.combat.impact_armor}I (augments and powers included). One Outer and one Under piece worn at a time.`));
  const armorItem = r => ({ name: r.Armor, cost: Math.round((+r.Cost || 0) * armorMult),
    sub: `${r.Ballistic}B / ${r.Impact}I · wt ${r.wt}${r.Style === "Y" ? " · styleable" : ""}` });
  const armorBuyGroups = [
    { label: "Outer Armor", items: DATA.tables.armor.filter(r => (r.Slot || "").startsWith("Outer")).map(armorItem) },
    { label: "Under Armor", items: DATA.tables.armor.filter(r => r.Slot === "Under").map(armorItem) },
    { label: "Other", items: DATA.tables.armor.filter(r => !(r.Slot || "").startsWith("Outer") && r.Slot !== "Under").map(armorItem) },
  ];
  const armorEntries = ownedArmor();
  if (armorEntries.length) {
    const t = el("table");
    t.append(el("tr", {}, el("th", {}, "Armor"), el("th", { class: "num" }, "B / I"),
      el("th", {}, "Extras"), el("th", {}, "Worn"), el("th", {}, "")));
    armorEntries.forEach((en, ai) => {
      const { ref: a, arr, i: localIndex, inPlay, category } = en;
      const r = DATA.tables.armor.find(x => x.Armor === a.name) || {};
      const baseCost = +r.Cost || 0;
      const extrasSub = sublistOf(en, "extras");
      // Extras are cost multipliers; the marginal charge is base cost × (mult − 1).
      const extrasCell = r.Style === "Y"
        ? fittedCategoryEditor({
            id: `sh-aextras-${ai}-${a.name}`,
            items: extrasSub.items,
            // A piece takes one of each extra, so anything already fitted drops
            // out of the picker — the shortlist is what you can still add. Unfit
            // the chip and it comes back.
            groups: [{ label: "Armor Extras", items: DATA.tables.armor_extras.map(x => ({
              name: x.Extra,
              cost: Math.round(baseCost * ((+x.Multiplier || 1) - 1) * armorMult),
              sub: `×${x.Multiplier}${x.Effects ? " · " + x.Effects : ""}`,
              hidden: extrasSub.items.some(it => sublistName(it) === x.Extra),
            })) }],
            onAdd: name => {
              const ex = DATA.tables.armor_extras.find(x => x.Extra === name) || {};
              const cost = Math.round(baseCost * ((+ex.Multiplier || 1) - 1) * armorMult);
              if (!overdrawOK(name, cost)) return;
              extrasSub.add(name);
              logCash(`Added ${name} to ${a.name}`, -cost,
                { kind: "armor_extra", host: a.name, name });
            },
            onRemove: index => disposeOfMod({ entry: en, list: "extras", index,
              name: sublistName(extrasSub.items[index]), hostName: a.name,
              value: Math.round(baseCost * (((+(DATA.tables.armor_extras
                .find(x => x.Extra === sublistName(extrasSub.items[index])) || {}).Multiplier || 1)) - 1)
                * armorMult) }),
            // No effectOf: every fitted extra already reports its effect on the
            // armor's own line below (CALC.armor effects covers Quality, Style
            // AND Extras), so repeating it beside the chip printed each one
            // twice. The picker still shows the effect where it's needed — when
            // you're choosing what to fit.
            rerender: renderSheet,
            afterAdd: () => playChangedRecalc(),
          })
        : "—";
      // Quality / Style and their gameplay effects (issue #18). CALC.armor is
      // built chargen-then-play, the same order ownedArmor() lists them in, so
      // the combined index goes straight across.
      const arow = (CALC.armor || [])[ai] || {};
      const aeffects = arow.effects || [];
      t.append(el("tr", {},
        el("td", {},
          // A move has to recalc (CALC.armor is index-aligned), and stays inside
          // the owning array so a play purchase can't drift into the chargen run.
          reorderHandle(() => arrayMove(arr, localIndex, -1, playChangedRecalc),
            () => arrayMove(arr, localIndex, 1, playChangedRecalc),
            localIndex > 0, localIndex < arr.length - 1),
          el("b", {}, a.name),
          el("div", { class: "sub" }, `${r.Slot || ""} · wt ${r.wt || 0}`),
          // Quality and Style were display-only in play (#73): you could buy a
          // coat and never say what it was made of. They are priced exactly the
          // way Extras above are -- base × (multiplier − 1) -- and switching
          // between two of them charges, or refunds, only the difference, so
          // the ledger never double-charges for a piece you already own.
          ro ? null : el("div", { class: "sh-armor-traits" },
            armorTraitSelect({ entry: a, field: "material", table: DATA.tables.armor_materials,
              column: "Material", label: "Quality", baseCost, mult: armorMult, overdrawOK }),
            r.Style === "Y"
              ? armorTraitSelect({ entry: a, field: "style", table: DATA.tables.armor_styles,
                  column: "Style", label: "Style", baseCost, mult: armorMult, overdrawOK })
              : el("span", { class: "sub" }, "fixed design — no Style")),
          aeffects.length ? el("div", { class: "sub armor-effects" },
            aeffects.map(e => `${e.label}: ${e.text}`).join(" · ")) : null,
          shMountEditor(en, r, a.active !== false)),
        el("td", { class: "num" }, `${r.Ballistic || 0} / ${r.Impact || 0}`),
        el("td", { class: "sub" }, extrasCell),
        el("td", {}, el("input", { type: "checkbox", ...(a.active !== false ? { checked: 1 } : {}),
          onchange: async e => {
            a.active = e.target.checked;
            // Only one piece per armor slot may be worn at a time.
            if (a.active && r.Slot) {
              ownedArmor().forEach(({ ref: other }) => {
                if (other === a) return;
                const os = (DATA.tables.armor.find(x => x.Armor === other.name) || {}).Slot;
                if (os === r.Slot) other.active = false;
              });
            }
            await playChangedRecalc();
          } })),
        el("td", {}, el("button", { class: "row-del", title: "Sell / remove armor",
          onclick: () => {
            // (#81) Armor already sold for its FULL price including trim
            // (CALC.armor.cost folds Quality/Style/Extras in), but the whole
            // lot was then scaled by condition. Split it: the piece's own
            // price is what wears out, the trim and any mounted augment come
            // back whole. Recomputed from the tables rather than subtracted
            // out of arow.cost, so the refund matches to the penny what
            // armorTraitSelect and the Extras picker charged.
            const trim = armorTrimValue(a, r, baseCost, armorMult)
              + mountedValue(a, armorMult);
            return disposeOfItem({ category, arr, index: localIndex, inPlay,
              name: a.name, value: Math.round(baseCost * armorMult) + trim,
              modsValue: trim });
          } }, "✕"))));
    });
    armorCard.append(t);
  } else {
    armorCard.append(el("p", { class: "hint" }, "No armor owned — buy some in the Buy section below."));
  }
  body.append(armorCard);

  // ===== Gear list (chargen + bought in play) — remove buttons
  // (Augments moved to their own tab.)
  // Two backing stores rendered as one table (chargen kit, then bought-in-play),
  // under the same Class headings the Buy section groups by, so a long kit can
  // be collapsed down to the category you're looking for. Reordering stays
  // inside an item's own array AND its own heading — moving across either
  // boundary would silently relabel a purchase or its category — so the handles
  // stop at each block's edge.
  // An item whose table row has gone (a deleted homebrew entry) still needs a
  // home, so it falls back to the same "Gear" heading the Buy section uses.
  const gearEntries = ownedGear().map(en => {
    const row = DATA.tables.misc_gear.find(x => x.Item === en.ref.name) || {};
    return { en, row, cls: row.Class || "Gear" };
  });
  const gearCats = [...new Set(gearEntries.map(e => e.cls))].sort((a, b) => a.localeCompare(b));
  const gt = el("table");
  gt.append(el("tr", {}, el("th", {}, "Item"), el("th", { class: "num" }, "Qty"),
    el("th", { class: "num" }, "Weight"),
    el("th", {}, "Effect"), el("th", {}, "Carried"), el("th", {}, "")));
  let gearWeightCarried = 0, gearWeightOwned = 0;
  const round1 = n => Math.round(n * 10) / 10;
  const gearRow = ({ en, row: r }, prev, next) => {
    const { ref: g, inPlay, arr } = en;
    // Focus/Fetish/Spirit Bag links (chosen in chargen) now show — and stay
    // editable — on the sheet (issue #14). gearLinkSelect returns null otherwise.
    const linkSel = (!ro && typeof gearLinkSelect === "function")
      ? gearLinkSelect(g, playChangedRecalc) : null;
    // Ammo counts in uses rather than pieces: its Qty stepper is the rounds you
    // own, and the Carried spinner is how many of those are on you.
    const isAmmo = (r.Class || "").startsWith("Ammo");
    const owned = ownedQty(g);
    const unitWt = wtNum(r.Weight);
    const carried = carriedQty(g);
    return el("tr", {},
      el("td", {},
        reorderHandle(() => prev && arraySwap(arr, en.i, prev.en.i),
          () => next && arraySwap(arr, en.i, next.en.i), !!prev, !!next),
        el("b", {}, g.name),
        inPlay ? el("span", { class: "sh-tag" }, "bought in play") : null,
        linkSel ? el("div", { class: "sub sh-gearlink" }, "Linked to ", linkSel)
          : (g.link ? el("div", { class: "sub" }, `Linked to ${g.link}`) : null),
        shMountEditor(en, r, g.carried !== false)),
      // Everything you own a count of gets the same live −/+ tracker: ammo in
      // rounds (issue #21), and doses, meds and grenades in items, because a
      // stack gets used up at the table and the row shouldn't have to be
      // deleted to say so. It moves no cash — buying more goes through the Buy
      // section below, which charges.
      el("td", { class: "num" }, ro
        ? String(owned)
        : [shUsesStepper(g, playChangedRecalc, isAmmo ? "use" : "item"),
           // Taking one is a different act from correcting the count, so it gets
           // its own button: the stepper says how many you have, Use says you
           // just took one and puts it in the effects banner.
           RULES.gearIsDose(r) ? shUseDoseBtn(g, r, owned) : null]),
      // Unit weight always; the carried subtotal too once it can differ from it.
      el("td", { class: "num sub" }, String(round1(unitWt)),
        (owned > 1 && unitWt > 0)
          ? el("div", { class: "sub" }, `${round1(unitWt * carried)} carried`) : null),
      el("td", { class: "sub" },
        [(+r.Dependence ? `Dependence ${r.Dependence}` : ""), r.Effect || "", r.Notes || ""]
          .filter(Boolean).join(" · ")),
      // More than one owned means "how many are on me" is a real question, so it
      // gets a spinner; a single item is still a plain yes/no.
      el("td", {}, (!ro && owned > 1)
        ? [el("span", { class: "sub" }, "Carried "), shCarriedStepper(g, playChangedRecalc)]
        : [el("span", { class: "sub" }, "Carried "), el("input", { type: "checkbox", ...(g.carried !== false ? { checked: 1 } : {}),
            onchange: async e => {
              setCarriedQty(g, e.target.checked ? owned : 0);
              await playChangedRecalc();
            } })]),
      el("td", {}, el("button", { class: "row-del", title: "Sell / remove item",
        onclick: () => {
          // (#81) Host gear (Power Armor, Arwin Goggles, homebrew with mounts)
          // can carry mounted augments; they leave with it, so their money
          // comes back whole. Not multiplied by `owned` — the mount list is
          // per row, not per copy.
          const fitted = mountedValue(g, gearMult);
          return disposeOfItem({ category: "gear", arr, index: en.i, inPlay,
            name: g.name, value: Math.round((+r.Cost || 0) * gearMult * owned) + fitted,
            modsValue: fitted });
        } }, "✕")));
  };
  // Weights tally over everything owned, collapsed categories included — hiding
  // a heading tidies the list, it doesn't take the load off your back.
  gearEntries.forEach(({ en, row: r }) => {
    const unitWt = wtNum(r.Weight);
    gearWeightCarried += unitWt * carriedQty(en.ref);
    gearWeightOwned += unitWt * ownedQty(en.ref);
  });
  // The data splits ammo across three literal Class strings -- "Ammo",
  // "Ammo (Exotic)", "Ammo (Projectile)" -- each its own heading, so a
  // character carrying only exotic or projectile rounds and nothing plain
  // would never see a bare "Ammo" heading at all. Match the prefix, the same
  // test `isAmmo` uses elsewhere in this tab, and show the button once, on
  // whichever ammo heading sorts first, rather than once per heading.
  let ammoReloadShown = false;
  gearCats.forEach(cls => {
    const rows = gearEntries.filter(e => e.cls === cls);
    const open = gearCatOpen[cls] !== false;
    // Per-heading carried weight, so collapsing a category doesn't hide the one
    // number the section is otherwise there to answer.
    const catWt = round1(rows.reduce((sum, { en, row: r }) =>
      sum + wtNum(r.Weight) * carriedQty(en.ref), 0));
    const isAmmoHeading = cls.startsWith("Ammo");
    const showReloadHere = isAmmoHeading && !ro && !ammoReloadShown;
    if (showReloadHere) ammoReloadShown = true;
    gt.append(el("tr", { class: "sh-gear-cat" },
      el("td", { colspan: "6", role: "button", tabindex: "0",
        title: open ? `Collapse ${cls}` : `Expand ${cls}`,
        onclick: () => { gearCatOpen[cls] = !open; renderSheet(); },
        onkeydown: e => { if (e.key === "Enter" || e.key === " ") e.currentTarget.click(); } },
        el("span", { class: "cat-arrow" }, open ? "▾" : "▸"),
        el("b", {}, cls),
        el("span", { class: "sub" }, ` (${rows.length})`),
        catWt > 0 ? el("span", { class: "sub" }, ` · ${catWt} carried`) : null,
        // Issue #85, parked on the Ammo heading rather than a card of its own —
        // it's a bulk action ON this category, the same way "Expand/Collapse
        // all" sits on the category bar below rather than in its own card.
        showReloadHere ? el("button", { class: "btn small", style: "margin-left:10px",
          title: "Top off every owned weapon's magazine. Costs no Actions — "
            + "for the moment before a session starts, not the moment before a shot.",
          onclick: e => { e.stopPropagation(); reloadAllWeapons(); } },
          "Reload All Weapons") : null)));
    if (!open) return;
    // Rows of one category run kit-first then bought-in-play, so a neighbour in
    // the same backing array is simply the adjacent row of this block.
    rows.forEach((e, p) => {
      const sameArr = other => (other && other.en.arr === e.en.arr) ? other : null;
      gt.append(gearRow(e, sameArr(rows[p - 1]), sameArr(rows[p + 1])));
    });
  });
  if (!gearEntries.length)
    gt.append(el("tr", {}, el("td", { class: "sub", colspan: "6" }, "No gear.")));
  else {
    const stashed = round1(gearWeightOwned - gearWeightCarried);
    gt.append(el("tr", { class: "sh-gear-total" },
      el("td", { class: "sub" }, el("b", {}, "Gear weight")),
      el("td", {}, ""),
      el("td", { class: "num" }, el("b", {}, String(round1(gearWeightCarried)))),
      el("td", { class: "sub", colspan: "3" },
        `carried of ${round1(gearWeightOwned)} owned`
        + (stashed > 0 ? ` · ${stashed} left behind` : ""))));
  }
  // One switch for the whole list once there's more than one heading to work.
  const gearCatBar = gearCats.length > 1 ? el("div", { class: "cat-sort" },
    el("span", { class: "sub" }, "Categories"),
    el("button", { class: "cat-sort-btn",
      onclick: () => { gearCats.forEach(c => { gearCatOpen[c] = true; }); renderSheet(); } },
      "Expand all"),
    el("button", { class: "cat-sort-btn",
      onclick: () => { gearCats.forEach(c => { gearCatOpen[c] = false; }); renderSheet(); } },
      "Collapse all")) : null;
  body.append(el("div", { class: "card sh-card", id: "gear-gear" },
    el("h3", {}, "Gear"), concealCallout(), gearCatBar, gt));

  // ===== Vehicles / rigs / decks owned (configured on their own tabs).
  // Drones and vehicles get their full Rigging-tab stat + attachment lines here
  // too, so the Gear tab is a complete inventory (issue #20).
  const gearRigs = allRigs(), gearDecks = allDecks();
  const gearDrones = allDrones(), gearVehicles = allVehicles();
  if (gearRigs.length || gearDecks.length || gearDrones.length || gearVehicles.length) {
    const vcard = el("div", { class: "card sh-card", id: "gear-vehicles" },
      el("h3", {}, "Vehicles, Rigs & Decks"),
      el("p", { class: "hint" }, "Bought, modified and removed on the Rigging and Decking tabs."));
    const unitEntries = [
      ...gearDrones.map(u => ({ table: "drones", u })),
      ...gearVehicles.map(u => ({ table: "vehicles", u })),
    ];
    if (unitEntries.length) vcard.append(unitLoadoutTable(unitEntries));
    if (gearRigs.length || gearDecks.length) {
      const vt = el("table");
      vt.append(el("tr", {}, el("th", {}, "Item"), el("th", {}, "Type")));
      // Rigs are gated by which one is active (Rigging tab), not by carrying, so
      // only decks get the toggle.
      const addRows = (list, label, carriable) => list.forEach(u =>
        vt.append(el("tr", {},
          el("td", {}, el("b", {}, u.label || u.name),
            (u.label && u.name) ? el("span", { class: "sub" }, ` (${u.name})`) : null,
            carriable ? shCarriedToggle(u) : null),
          el("td", { class: "sub" }, label))));
      addRows(gearRigs, "VCR", false);
      addRows(gearDecks, "Cyberdeck", true);
      vcard.append(vt);
    }
    body.append(vcard);
  }

  // ===== Buy equipment — all purchasing lives here, collapsible by type.
  // (Augments are bought on the Augments tab.)
  const gearBuyGroups = Object.entries(
    DATA.tables.misc_gear.reduce((acc, r) => (((acc[r.Class || "Gear"] ??= []).push(r)), acc), {}))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cls, rows]) => ({
      label: cls,
      items: rows.map(r => ({ name: r.Item, cost: Math.round((+r.Cost || 0) * gearMult),
        sub: [(+r.Dependence ? `Dependence ${r.Dependence}` : ""), r.Effect || "", r.Notes || "",
          (r.Class || "").startsWith("Ammo") ? "per use" : ""]
          .filter(Boolean).join(" · ") })),
    }));
  const buySection = el("div", { class: "card sh-card", id: "gear-buy" },
    el("h3", {}, "Buy equipment"),
    el("p", { class: "hint" }, `Everything purchasable from ${RULES.currencyName().toLowerCase()}, grouped by type. `
      + (mult > 1 ? `Heritage surcharge ×${mult} applies to weapons & armor (not general gear). ` : "")
      + "Augments are bought on the Augments tab; decks, programs, rigs, drones and vehicles on the Decking and Rigging tabs."));
  const buyBlock = (title, browser) =>
    buySection.append(el("div", { class: "sh-unit-add" }, el("b", {}, title), browser));
  buyBlock("Weapons", categoryBrowser({ id: "sh-buy-weapons", groups: weaponBuyGroups,
    rerender: renderSheet, afterAdd: () => playChangedRecalc(),
    onAdd: name => {
      const r = DATA.tables.weapons.find(x => x.Weapon === name) || {};
      const bow = RULES.bowRating(r, { min_str: CALC.attributes.Strength.final });
      const cost = Math.round((bow ? bow.cost : (+r.Cost || 0)) * mult);
      if (!overdrawOK(name, cost)) return;
      const entry = { name, smart: Boolean(r["Integrated Smart"]),
        mods: [], equipped: true, qty: 1 };
      if (bow) entry.min_str = bow.minStr;
      CHAR.play.purchases.weapons.push(entry);
      logCash(`Bought ${name}${bow ? ` (Min STR ${bow.minStr})` : ""}`, -cost,
        { kind: "weapon", name });
    } }));
  buyBlock("Armor", categoryBrowser({ id: "sh-buy-armor", groups: armorBuyGroups,
    rerender: renderSheet, afterAdd: () => playChangedRecalc(),
    onAdd: async name => {
      const r = DATA.tables.armor.find(x => x.Armor === name) || {};
      const base = +r.Cost || 0;
      const styleable = r.Style === "Y";
      // Surcharges ADD onto the base -- base x (multiplier - 1) each, never
      // compounding -- which is exactly what priceArmor does, so the figure in
      // the dialog is the figure the engine will price the piece at.
      const mOf = (table, col, v) => {
        const row = table.find(x => x[col] === v);
        return row ? (+row.Multiplier || 1) : 1;
      };
      const priceOf = st => Math.round((base
        + base * (mOf(DATA.tables.armor_materials, "Material", st.material) - 1)
        + (styleable ? base * (mOf(DATA.tables.armor_styles, "Style", st.style) - 1) : 0)
        + (styleable ? (st.extras || []).reduce((n, e) =>
            n + base * (mOf(DATA.tables.armor_extras, "Extra", e) - 1), 0) : 0)) * mult);
      const opt = (table, col) => [{ value: "", label: "—" },
        ...table.map(x => ({ value: x[col], label: `${x[col]} ×${x.Multiplier}` }))];
      const chosen = await buyDialog({
        title: `Buy ${name}`,
        sub: `${r.Ballistic}B / ${r.Impact}I · weight ${r.wt}`
          + (styleable ? " · styleable" : " · fixed design, no Style or Extras"),
        fields: [
          { key: "material", label: "Quality", type: "select",
            options: opt(DATA.tables.armor_materials, "Material"), initial: "" },
          ...(styleable ? [
            { key: "style", label: "Style", type: "select",
              options: opt(DATA.tables.armor_styles, "Style"), initial: "" },
            { key: "extras", label: "Extras", type: "checks",
              options: DATA.tables.armor_extras.map(x => ({ value: x.Extra,
                label: `${x.Extra} ×${x.Multiplier}` })), initial: [] },
          ] : []),
        ],
        priceOf,
      });
      if (!chosen) return;
      const cost = priceOf(chosen);
      CHAR.play.purchases.armor.push({ name, style: chosen.style || "",
        material: chosen.material || "", extras: chosen.extras || [], active: true });
      logCash(`Bought ${name}`
        + ([chosen.material, chosen.style, ...(chosen.extras || [])].filter(Boolean).length
            ? ` (${[chosen.material, chosen.style, ...(chosen.extras || [])].filter(Boolean).join(", ")})` : ""),
        -cost, { kind: "armor", name });
      await playChangedRecalc();
    } }));
  buyBlock("Gear", categoryBrowser({ id: "sh-buy-gear", groups: gearBuyGroups,
    rerender: renderSheet, afterAdd: () => {},
    onAdd: name => buyGear(name, gearMult) }));
  body.append(buySection);

  // ===== Activity (cash ledger) — moved to the bottom
  if (play.cash_log.length) {
    const t = el("table", { style: "max-width:560px" });
    play.cash_log.slice(0, 20).forEach(entry =>
      t.append(el("tr", {},
        el("td", {}, entry.label),
        // A zero-delta row is a record of something that changed without money
        // moving (an unpaid lifestyle adjustment) — show a dash, not "+ㄓ0".
        el("td", { class: "num", style: !entry.delta ? "color:var(--dim)"
                     : entry.delta > 0 ? "color:var(--ok)" : "color:var(--bad)" },
          // fmt puts the glyph in front, so a negative reads "ㄓ-500"; move the
          // sign out to the front. Keyed off the live glyph, not a literal.
          entry.delta
            ? (entry.delta > 0 ? "+" : "")
              + fmt(entry.delta).replace(`${RULES.currencySymbol()}-`,
                                         `−${RULES.currencySymbol()}`)
            : "—"),
        // Undo is only offered where there is something to take back: a
        // purchase this ledger knows how to reverse.
        el("td", {}, (entry.undo && CASH_UNDO[entry.undo.kind])
          ? el("button", { class: "btn small",
              title: entry.delta ? `Undo this purchase and refund ${fmt(-entry.delta)}`
                                 : "Undo this change and restore the previous value",
              onclick: () => undoCashSpend(entry) }, "Undo")
          : null))));
    body.append(el("div", { class: "card sh-card" }, el("h3", {}, "Activity"),
      el("p", { class: "hint" },
        "Undo takes back a purchase in full — the item goes and the "
        + `${RULES.currencyName().toLowerCase()} comes back. Removing an item on the `
        + "tabs above only removes it; the money stays spent."),
      t));
  }
}

/* ------------------------------------------------ augments tab */
// Preferred display order for augment type groups; unlisted types follow
// alphabetically.
const AUG_TYPE_ORDER = ["Headware", "Eyeware", "Earware", "Bodyware", "Bioware",
  "Cyberlimbs", "Right Arm", "Left Arm", "Right Leg", "Left Leg", "Mobi"];

function shAugments(body) {
  const play = CHAR.play;
  const mult = CALC.budget.gear_cost_multiplier || 1;
  const z = CALC.zoetics;

  const augEntries = ownedAugments();
  // Slotted Skillsofts grant their bonus; how many can be slotted at once is
  // capped by the number of Chipjacks installed.
  const ownedAugsAll = allAugmentsOwned();
  const chipjackCount = ownedAugsAll
    .filter(a => a.name === "Chipjack").reduce((sum, a) => sum + (a.count || 1), 0);
  const slottedSkillsoftCount = ownedAugsAll
    .filter(a => a.name.startsWith("Skillsoft") && a.slotted !== false).length;

  const augHeaderCard = el("div", { class: "card sh-card" }, el("h3", {}, "Augments"),
    el("div", { class: "sh-advrow" },
      el("span", {}, RULES.houseRule("zr") === "houserule" ? "Cyber ZP Spent" : "Augment ZR"),
      el("b", {}, String(z.augment_zr))),
    ...(z.mounted_zr ? [el("div", { class: "sh-advrow",
        title: "ZR of augments mounted on gear (Gear tab) — never counts against your ZP" },
      el("span", {}, "Mounted on gear (ZP-exempt)"), el("b", {}, String(z.mounted_zr)))] : []),
    ...(z.mount_errors || []).map(msg =>
      el("div", { class: "sh-advrow", style: "color:var(--bad)" }, msg)),
    el("div", { class: "sh-advrow" },
      el("span", {}, `Body Index (max ${CALC.attributes.Body.final})`),
      el("b", { style: z.body_index_ok ? "" : "color:var(--bad)" }, String(z.body_index))),
    el("p", { class: "hint" },
      "α-cyber Augments are bleeding edge, reducing the ZR by 20% but doubling the cost. "
      + "Augments mounted on gear are managed on the Gear tab with their host item."));

  // Curated "special senses & immunities" summary — sits beside the Augments card.
  const sensesCard = (CALC.combat.sense_notes && CALC.combat.sense_notes.length)
    ? el("div", { class: "card sh-card" }, el("h3", {}, "Senses & immunities"),
        ...CALC.combat.sense_notes.map(s =>
          el("p", { class: "hint", style: "margin:4px 0" }, el("b", {}, s.name + ": "), s.effect)))
    : null;
  body.append(sensesCard
    ? el("div", { class: "sh-two" }, augHeaderCard, sensesCard)
    : augHeaderCard);

  // One card per augment type, in anatomical-ish order.
  const byType = {};
  augEntries.forEach(en => {
    const r = DATA.tables.augments.find(x => x.Name === en.ref.name) || {};
    (byType[r.Type || "Other"] ??= []).push(en);
  });
  const types = Object.keys(byType).sort((a, b) => {
    const ia = AUG_TYPE_ORDER.indexOf(a), ib = AUG_TYPE_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  const augmentRow = ({ ref: a, inPlay, arr, i: augIndex }) => {
    const r = DATA.tables.augments.find(x => x.Name === a.name) || {};
    // Cybertechtronic augments are surcharged; Bioware is grown to fit (face value).
    const augMult = RULES.surchargeFor(r.Type === "Bioware" ? "bioware" : "cyberware", mult);
    const isSkillsoft = a.name.startsWith("Skillsoft");
    const hasZr = !!(+r.ZR);
    const alphaZr = hasZr ? RULES.augmentEffZr(r, { alpha: true }) : 0;
    // Going alpha adds max(base cost, 1000) — mirrors rules.js effCost (min
    // applied to raw cost, then × the gear multiplier) so the play-mode cash
    // ledger stays in step with the recalculated total.
    const alphaExtra = Math.round(Math.max(+r.Cost || 0, 1000) * augMult);
    const alphaCell = hasZr
      ? el("label", { class: "opt", title: `α-cyber grade: ZR ${alphaZr} (−20%, min −0.1), cost ×2 (min +${currencySymbol()}1,000)` },
          el("input", { type: "checkbox", ...(a.alpha ? { checked: 1 } : {}),
            onchange: async e => {
              a.alpha = e.target.checked;
              logCash(a.alpha ? `Upgraded ${a.name} to α-cyber grade`
                              : `Reverted ${a.name} from α-cyber grade`,
                a.alpha ? -alphaExtra : alphaExtra);
              await playChangedRecalc();
            } }),
          el("span", {}, `ZR ${a.alpha ? alphaZr : +r.ZR}`))
      : el("span", { class: "sub" }, "—");
    // Skillsofts target a player-chosen skill (like chargen) and only grant
    // their bonus while slotted, capped by owned Chipjacks.
    let target = null, slottedCell = el("span", { class: "sub" }, "—");
    if (isSkillsoft) {
      target = el("select", { onchange: async e => { a.target = e.target.value; await playChangedRecalc(); } },
        el("option", { value: "" }, "Skill…"),
        ...Object.keys(DATA.skills).sort().map(x => el("option", {}, x)));
      target.value = a.target || "";
      const isSlotted = a.slotted !== false;
      const atCap = !isSlotted && slottedSkillsoftCount >= chipjackCount;
      slottedCell = el("label", {
        class: "opt",
        title: atCap
          ? `Only ${chipjackCount} Chipjack(s) installed — unslot another Skillsoft first`
          : "Apply this Skillsoft's bonus to its target skill",
      },
        el("input", { type: "checkbox", ...(isSlotted ? { checked: 1 } : {}),
          disabled: atCap ? "1" : null,
          onchange: async e => { a.slotted = e.target.checked; await playChangedRecalc(); } }));
    }
    // Knowledge Skillsofts bought in play get a cash-aware +/- stepper —
    // each unit adds a Knowledge skill point. Chargen-installed ones (or
    // other augments) show a static count; the chargen record is immutable
    // in play, so extra copies are bought in play instead.
    const unitCost = Math.round((+r.Cost || 0) * augMult);
    const countCell = (inPlay && a.name === "Knowledge Skillsoft")
      ? el("td", { class: "num" }, el("span", { class: "stepper" },
          el("button", { title: "Remove one (refunded)", onclick: async () => {
            if ((a.count || 1) <= 1) return;
            a.count -= 1;
            logCash("Removed a Knowledge Skillsoft", unitCost);
            await playChangedRecalc();
          } }, "–"),
          el("b", {}, String(a.count || 1)),
          el("button", { title: "Install another", onclick: async () => {
            if (CHAR.play.cash < unitCost
                && !confirm(`Another Knowledge Skillsoft costs ${fmt(unitCost)} but you have ${fmt(CHAR.play.cash)}. Overdraw?`))
              return;
            a.count = (a.count || 1) + 1;
            logCash("Installed Knowledge Skillsoft", -unitCost);
            await playChangedRecalc();
          } }, "+")))
      : el("td", { class: "num" }, String(a.count || 1));
    // Cybergun shows its chosen gun's stats; melee implants show computed damage.
    const gun = RULES.isCybergunAugment(a.name) && a.gunType
      ? (DATA.tables.cyberguns || []).find(g => g.Type === a.gunType) : null;
    const implantDmg = RULES.augmentMeleeDamage(r, CALC.attributes.Strength.final, CALC.martial_art && CALC.martial_art.mods);
    const effectText = gun
      ? [r.Effect || "", `${gun.Type}: Acc ${gun.Acc} · DMG ${gun.Dmg} · Ammo ${gun.Ammo} · ${gun.Modes} · Pen ${gun.Pen} · Rarity ${gun.Rarity}`].filter(Boolean).join(" · ")
      : [r.Effect || "", implantDmg !== "" ? `DMG ${implantDmg}` : ""].filter(Boolean).join(" · ");
    // Cybergun: choose / change the mounted gun in play. The gun-cost difference
    // (× heritage surcharge) is charged or refunded to the play cash ledger.
    let gunSel = null;
    if (RULES.isCybergunAugment(a.name)) {
      gunSel = el("select", { onchange: async e => {
        const nv = e.target.value;
        const oldGun = (DATA.tables.cyberguns || []).find(g => g.Type === a.gunType);
        const newGun = (DATA.tables.cyberguns || []).find(g => g.Type === nv);
        const delta = Math.round(((newGun ? +newGun.Cost : 0) - (oldGun ? +oldGun.Cost : 0)) * mult);
        if (delta > 0 && CHAR.play.cash < delta
            && !confirm(`${nv} costs ${fmt(delta)} more but you have ${fmt(CHAR.play.cash)}. Overdraw?`)) {
          e.target.value = a.gunType || ""; return;
        }
        a.gunType = nv;
        if (delta !== 0) logCash(`Cybergun gun: ${oldGun ? oldGun.Type : "none"} → ${nv || "none"}`, -delta);
        await playChangedRecalc();
      } },
        el("option", { value: "" }, "Choose gun…"),
        ...(DATA.tables.cyberguns || []).map(g =>
          el("option", { value: g.Type }, `${g.Type} (${fmt(Math.round(+g.Cost * mult))})`)));
      gunSel.value = a.gunType || "";
    }
    // Fashionware quality tier (issue #19). Switching tier re-prices the piece,
    // so charge/refund the difference through the cash ledger. Costed via
    // augmentEffCost so any α-grade premium is re-derived on the new base.
    let qualitySel = null;
    if (r.Quality === "Y") {
      qualitySel = el("select", { class: "fw-quality-select", onchange: async e => {
        const nv = e.target.value;
        const before = Math.round(RULES.augmentEffCost(r, a) * augMult);
        const after = Math.round(RULES.augmentEffCost(r, { ...a, quality: nv }) * augMult);
        const delta = after - before;
        if (delta > 0 && CHAR.play.cash < delta
            && !confirm(`${nv || "Normal"} costs ${fmt(delta)} more but you have ${fmt(CHAR.play.cash)}. Overdraw?`)) {
          e.target.value = a.quality || ""; return;
        }
        const prev = a.quality || "standard";
        a.quality = nv;
        if (delta !== 0) logCash(`${a.name} quality: ${prev} → ${nv || "standard"}`, -delta);
        await playChangedRecalc();
      } },
        el("option", { value: "" }, "Quality…"),
        ...(DATA.tables.fashionware_qualities || []).map(q =>
          el("option", { value: q.Quality }, `${q.Quality} ×${q.Multiplier}`)));
      qualitySel.value = a.quality || "";
    }
    return el("tr", {},
      el("td", {}, el("b", {}, a.name),
        inPlay ? el("span", { class: "sh-tag" }, "bought in play") : null,
        r.Rarity ? el("div", { class: "sub" }, `Rarity ${r.Rarity}`) : null,
        target, gunSel, qualitySel),
      countCell,
      el("td", {}, alphaCell),
      el("td", {}, slottedCell),
      el("td", { class: "sub" }, effectText,
        descriptionExpander(r.Description, `augments:${a.name}`)),
      // Cyberware comes out surgically: there is no resale market for a used
      // arm, so the dialog opens with nothing offered. A table that wants to
      // allow a chop-shop sale can still type a number in.
      el("td", {}, el("button", { class: "row-del", title: "Remove (surgical removal — not refunded)",
        onclick: () => disposeOfItem({ category: "augments", arr, index: augIndex, inPlay,
          name: a.name, value: 0 }) }, "✕")));
  };
  if (!augEntries.length) {
    body.append(el("div", { class: "card sh-card" },
      el("p", { class: "hint" }, "No augments installed — buy some below.")));
  }
  for (const type of types) {
    const t = el("table");
    t.append(el("tr", {}, el("th", {}, "Augment"), el("th", { class: "num" }, "×"),
      el("th", {}, "α-cyber"), el("th", {}, "Slotted"), el("th", {}, "Effect"), el("th", {}, "")));
    byType[type].forEach(en => t.append(augmentRow(en)));
    body.append(el("div", { class: "card sh-card" }, el("h3", {}, type), t));
  }

  // ===== Buy augments — same browser that used to live on the Gear tab.
  const augAvail = augmentAvailability(ownedAugsAll);
  const syntheticNoBio = CHAR.heritage.type === "Synthetic";
  // Cyberlimb augments may need a cyberarm/leg first (data "Req Limb").
  const ARM_T = new Set(["Right Arm", "Left Arm"]), LEG_T = new Set(["Right Leg", "Left Leg"]);
  const buyAugType = a => (DATA.tables.augments.find(x => x.Name === a.name) || {}).Type || "";
  const ownsArm = ownedAugsAll.some(a => ARM_T.has(buyAugType(a)));
  const ownsLeg = ownedAugsAll.some(a => LEG_T.has(buyAugType(a)));
  // Cyberguns are capped at one per cyberarm.
  const cyberarmCount = ownedAugsAll.filter(a => ARM_T.has(buyAugType(a))).length;
  const cybergunCount = ownedAugsAll.filter(a => RULES.isCybergunAugment(a.name)).length;
  const buyLimbNeed = r => {
    switch (RULES.augmentLimbRequirement(r)) {
      case "Arm": return ownsArm ? null : "a Cyberarm";
      case "Leg": return ownsLeg ? null : "a Cyberleg";
      case "Any": return (ownsArm || ownsLeg) ? null : "a Cyberarm or Cyberleg";
      default:    return null;
    }
  };
  const augBuyGroups = Object.entries(
    DATA.tables.augments.reduce((acc, r) => (((acc[r.Type || "Augment"] ??= []).push(r)), acc), {}))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, rows]) => ({
      label: type,
      items: rows.map(r => {
        const bioBanned = syntheticNoBio && r.Type === "Bioware";
        const banned = bioBanned ? "Synthetics cannot install Bioware" : augAvail.bannedReason(r.Name);
        const need = buyLimbNeed(r);
        const dmg = RULES.augmentMeleeDamage(r, CALC.attributes.Strength.final, CALC.martial_art && CALC.martial_art.mods);
        const isCybergun = RULES.isCybergunAugment(r.Name);
        let disabled = !!need;
        let reason = banned || (need ? `Requires ${need} installed` : "");
        let note = banned ? "banned" : (need ? `needs ${need}` : "");
        if (isCybergun && !banned && !need && cybergunCount >= cyberarmCount) {
          disabled = true;
          reason = `One cybergun per cyberarm (${cybergunCount}/${cyberarmCount} installed)`;
          note = "at capacity";
        }
        return {
          name: r.Name,
          // augmentEffCost, not the raw row: it carries the Classic-ZR
          // cyberlimb doubling, so the quote matches what the engine prices.
          cost: Math.round(RULES.augmentEffCost(r, {})
            * RULES.surchargeFor(r.Type === "Bioware" ? "bioware" : "cyberware", mult)),
          sub: `ZR ${r.ZR || 0} · BI ${r.BI || 0}${dmg !== "" ? " · DMG " + dmg : ""}`
            + (r.Rarity ? ` · Rarity ${r.Rarity}` : "")
            + (r.Quality === "Y" ? " · quality tiers available" : "")
            + (r.Effect ? " · " + r.Effect : ""),
          banned: !!banned,
          disabled,
          reason,
          note,
        };
      }),
    }));
  body.append(el("div", { class: "card sh-card" },
    el("h3", {}, "Buy augments"),
    el("p", { class: "hint" },
      (mult > 1 ? `Heritage surcharge ×${mult} applies to cybertechtronic augments (Bioware pays face value). ` : "")
      + "Installed augments appear above, grouped by type."),
    el("div", { class: "sh-unit-add" },
      categoryBrowser({ id: "sh-buy-augments", groups: augBuyGroups,
        rerender: renderSheet, afterAdd: () => {},
        onAdd: name => buyAugment(name, mult) }))));
}

/* prepaid lifestyle months: tick up/down, buy months, one active at a time */
function lifestyleCard() {
  const play = CHAR.play;
  const card = el("div", { class: "card sh-card" },
    el("h3", {}, "Lifestyle"),
    el("p", { class: "hint" },
      "Each sector turn requires eliminating one month of pre-purchased lifestyle "
      + "or paying upkeep for your desired lifestyle."));
  // Hyperthyroid raises lifestyle cost 10% (matches HYPERTHYROID_LIFESTYLE_SURCHARGE in rules.js).
  const hasHyperthyroid = allAugmentsOwned()
    .some(a => a.name === "Hyperthyroid");
  const lifestyleSurcharge = hasHyperthyroid ? 1.10 : 1;
  play.lifestyles.forEach((ls, i) => {
    const row = DATA.tables.lifestyles.find(x => x.Lifestyle === ls.name) || {};
    const monthly = Math.round((+row.MonthlyCost || 0) * lifestyleSurcharge);
    card.append(el("div", { class: "sh-advrow" + (ls.active ? " active-row" : "") },
      el("span", {},
        el("input", { type: "radio", name: "ls-active", title: "Set as current lifestyle",
          ...(ls.active ? { checked: 1 } : {}),
          onchange: () => {
            play.lifestyles.forEach(l => { l.active = false; });
            ls.active = true; playChanged();
          } }),
        " ", el("b", {}, ls.name),
        el("span", { class: "sub" }, ` ${fmt(monthly)}/month`)),
      el("span", { class: "sh-unit-ctr" },
        // Free to tick — burning a month per sector turn costs nothing, and a
        // GM correction shouldn't have to route through a purchase. But it
        // moves prepaid months that WERE paid for, so every change lands in the
        // ledger at zero cash: visible, undoable, and impossible to confuse
        // with the "+1 mo" button beside it, which charges.
        miniCounter("Months", () => ls.months || 0, v => {
          const from = ls.months || 0;
          if (v === from) return;
          ls.months = v;
          logCash(`Adjusted ${ls.name} lifestyle to ${v} mo (unpaid)`, 0,
            { kind: "lifestyle_adjust", name: ls.name, from });
        }),
        counterBtn(`+1 mo (${fmt(monthly)})`, () => {
          if (play.cash < monthly
              && !confirm(`A month of ${ls.name} costs ${fmt(monthly)} but you have ${fmt(play.cash)}. Overdraw?`))
            return;
          ls.months = (ls.months || 0) + 1;
          if (monthly) logCash(`Prepaid 1 month of ${ls.name} lifestyle`, -monthly,
            { kind: "lifestyle_month", name: ls.name });
          playChanged();
        }, "accent"),
        el("button", { class: "row-del", title: "Remove lifestyle",
          onclick: () => {
            if (!confirm(`Remove ${ls.name}? Remaining prepaid months are lost.`)) return;
            play.lifestyles.splice(i, 1); playChanged();
          } }, "✕"))));
  });
  const activeLs = play.lifestyles.find(l => l.active);
  if (activeLs)
    card.append(el("div", { class: "sh-callout lifestyle" },
      el("b", {}, `${activeLs.name} — current effect: `),
      LIFESTYLE_EFFECTS[activeLs.name] || "No listed effect."));
  else
    card.append(el("p", { class: "hint" }, "No current lifestyle selected — pick one with the radio button."));
  const addable = DATA.tables.lifestyles.filter(r => !play.lifestyles.some(l => l.name === r.Lifestyle));
  if (addable.length) {
    const addSel = el("select", {}, el("option", { value: "" }, "Add lifestyle…"),
      ...addable.map(r => el("option", { value: r.Lifestyle }, `${r.Lifestyle} — ${fmt(r.MonthlyCost)}/month`)));
    card.append(el("div", { class: "add-row" }, addSel,
      el("button", { class: "btn-add", onclick: () => {
        if (!addSel.value) return;
        play.lifestyles.push({ name: addSel.value, months: 0, active: !play.lifestyles.length });
        playChanged();
      } }, "Add")));
  }
  return card;
}

async function buyGear(name, mult) {
  if (!name) return;
  const r = DATA.tables.misc_gear.find(x => x.Item === name);
  if (!r) return;
  const cost = Math.round(r.Cost * mult);
  if (CHAR.play.cash < cost
      && !confirm(`${name} costs ${fmt(cost)} but you only have ${fmt(CHAR.play.cash)}. Overdraw?`))
    return;
  const existing = CHAR.play.purchases.gear.find(g => g.name === name);
  if (existing) existing.qty = (existing.qty || 1) + 1;
  else CHAR.play.purchases.gear.push({ name, qty: 1 });
  logCash(`Bought ${name}`, -cost, { kind: "gear", name });
  await playChangedRecalc();
}
async function buyAugment(name, mult) {
  if (!name) return;
  const r = DATA.tables.augments.find(x => x.Name === name);
  if (!r) return;
  // Synthetics can't install Bioware; block augments that conflict with
  // something already installed.
  if (CHAR.heritage.type === "Synthetic" && r.Type === "Bioware") {
    alert(`Can't install ${name}: Synthetics cannot install Bioware.`); return;
  }
  const owned = allAugmentsOwned();
  const banReason = augmentAvailability(owned).bannedReason(name);
  if (banReason) { alert(`Can't install ${name}: ${banReason}.`); return; }
  // Cyberguns are capped at one per installed cyberarm.
  if (RULES.isCybergunAugment(name)) {
    const armTypes = new Set(["Right Arm", "Left Arm"]);
    const arms = owned.filter(a => armTypes.has((DATA.tables.augments.find(x => x.Name === a.name) || {}).Type)).length;
    const guns = owned.filter(a => RULES.isCybergunAugment(a.name)).length;
    if (arms === 0) { alert("Can't install a Cybergun: requires a Cyberarm."); return; }
    if (guns >= arms) { alert(`Can't install another Cybergun: one per cyberarm (${guns}/${arms}).`); return; }
  }
  // Bioware is grown to fit and never carries the small-heritage surcharge.
  // Priced through augmentEffCost so a Classic-ZR cyberlimb is charged at the
  // doubled rate the chargen budget uses -- reading r.Cost straight made
  // limbs half price when bought in play.
  const cost = Math.round(RULES.augmentEffCost(r, {})
    * RULES.surchargeFor(r.Type === "Bioware" ? "bioware" : "cyberware", mult));
  const z = CALC.zoetics;
  const newBI = z.body_index + (+r.BI || 0);
  const newZR = z.cyber_zr + z.amp_zr + (+r.ZR || 0);
  if (newBI > CALC.attributes.Body.final
      && !confirm(`Warning: Body Index would reach ${newBI} (Body ${CALC.attributes.Body.final}) — Too Many Biomods. Install anyway?`))
    return;
  if (newZR > z.zp
      && !confirm(`Warning: total Zoetic Rating would reach ${newZR} (ZP ${z.zp}). Install anyway?`))
    return;
  if (CHAR.play.cash < cost
      && !confirm(`${name} costs ${fmt(cost)} but you only have ${fmt(CHAR.play.cash)}. Overdraw?`))
    return;
  // Stackable augments (Knowledge Skillsoft, Chipjack, Memory) grow one entry's
  // count so repeated buys read as "× N" rather than a wall of duplicate rows.
  const existing = isStackableAugment(name)
    && CHAR.play.purchases.augments.find(a => a.name === name && !a.alpha);
  if (existing) existing.count = (existing.count || 1) + 1;
  else CHAR.play.purchases.augments.push({ name, count: 1 });
  logCash(`Installed ${name}`, -cost, { kind: "augment", name });
  await playChangedRecalc();
}

// Augments whose quantity is meaningful and merged into a single entry.
function isStackableAugment(name) {
  return name === "Chipjack" || name === "Memory-1 EB" || name === "Knowledge Skillsoft";
}

/* The bound half of a spirit's writeup, for one bond tile: its services, its
 * statblock and its appearance, each behind its own expander so four bound
 * spirits still fit in the card. `force` resolves the [F] terms in the text.
 * Returns an array of nodes (possibly empty) to append to the tile. */
function bondSpiritDetail(name, row, force) {
  const out = [];
  const services = parseSpiritServices(row["Bound Services"]);
  for (const svc of services) {
    out.push(expanderPanel(`bond:${name}:${svc.name || svc.text.slice(0, 24)}`,
      svc.name || "Service", ...withForce(svc.text, force)));
  }
  if (!services.length) {
    out.push(el("p", { class: "hint" }, "No bound-services writeup for this spirit yet."));
  }

  // Ballistic/Impact are armor values, so they're labelled the way the rest of
  // the app labels armor. Omit any stat this spirit doesn't list.
  const stats = [["Move", row.Movement], ["Init", row.Initiative],
    ["Condition", row.Condition], ["B Armor", row.Ballistic],
    ["I Armor", row.Impact], ["Def Dice", row["Defense Dice"]]]
    .filter(([, v]) => String(v || "").trim());
  const attacks = splitSpiritEntries(row.Attacks);
  const special = splitSpiritEntries(row.Special);
  if (stats.length || attacks.length || special.length) {
    const kids = [];
    if (stats.length) {
      kids.push(el("div", { class: "sh-spirit-stats" },
        ...stats.map(([k, v]) => el("div", {},
          el("div", { class: "k" }, k),
          el("div", { class: "v" }, ...withForce(v, force))))));
    }
    for (const a of attacks) {
      kids.push(el("div", { class: "sh-spirit-line" }, ...withForce(a, force)));
    }
    for (const sp of special) {
      kids.push(el("div", { class: "sh-spirit-line sub" }, ...withForce(sp, force)));
    }
    // A few spirits list the statblock of the cohort they summon rather than
    // their own; "Statblock Of" names it so the label says whose it is. Spirits
    // with no stats at all (Miasma, Stormwing) carry only their special rules.
    const of = String(row["Statblock Of"] || "").trim();
    const label = !stats.length && !attacks.length ? "Special"
      : of ? `Statblock — ${of}` : "Statblock";
    out.push(expanderPanel(`bond:${name}:stats`, label, ...kids));
  }

  const look = descriptionExpander(row.Appearance, `bond:${name}:look`, "Appearance");
  if (look) out.push(look);
  return out;
}

/* ------------------------------------------------ magic tab */
function shMagic(body) {
  const type = CALC.magic.type;
  const play = CHAR.play;
  // A shared view reads the same sheet but must not sell anything off it, so
  // the spell ✕ is hidden there — same flag every other tab's destructive
  // controls are gated on (#82).
  const ro = !!(activeTabObj() && activeTabObj().readonly);

  // House rule: gear/weapon ZR is a spellcasting dice penalty (−1d per full
  // point), not a ZP cost. Surface the current penalty at the top of the tab.
  if (RULES.houseRule("zr") === "houserule" && type !== "Hedge") {
    const gearZr = CALC.zoetics.gear_zr || 0;
    const pen = Math.floor(gearZr);
    body.append(pen > 0
      ? el("div", { class: "sh-callout warn" },
          el("b", {}, `ZR Casting Penalty: −${pen}d `),
          `on all spellcasting rolls (Channeling, Conjuring, Sorcery). `
          + `${gearZr} ${gearZr === 1 ? "point" : "points"} of gear/weapon ZR — −1d per full point.`)
      : el("div", { class: "sh-callout info" },
          el("b", {}, "ZR Casting Penalty: none. "),
          `Each full point of gear/weapon ZR is −1d on spellcasting rolls `
          + `(Channeling, Conjuring, Sorcery). Currently ${gearZr} ZR.`));
  }

  const zp = CALC.zoetics.zp;
  // (#82) Spells sold in play. A play-bought spell is spliced out of
  // purchases.spells outright; a CHARGEN spell can only be recorded here,
  // because the chargen record is never written to after Finalize — so the
  // list this tab renders has to subtract the same names the engine does.
  const forgottenSpells = new Set(play.spells_forgotten || []);
  const allSpells = [
    ...CHAR.magic.spells.map(s => ({ ...s, inPlay: false })),
    ...play.purchases.spells.map(s => ({ ...s, inPlay: true }))]
    .filter(s => !forgottenSpells.has(s.name));
  if (allSpells.length || type === "Mage" || type === "Archmage") {
    const wrap = el("div", { class: "card sh-card" },
      el("div", { class: "sh-card-head" },
        el("h3", {}, "Spells"),
        el("span", { class: "chip magic" }, `ZP ${zp}`)));
    wrap.append(el("p", { class: "hint" },
      `Spells cost their listed price in ${RULES.currencyName().toLowerCase()} per Force to learn or advance. `
      + `Casting at Force above your ZP (${zp}) deals drain as LETHAL damage; at or below, drain is Stun.`));
    // The soak ruling stated once for the whole card, because every row below
    // carries a "drain: stun" / "drain: LETHAL" chip and the two are not soaked
    // the same way (#68). Cast rows repeat it per-spell with the Fetish folded
    // in; these rows are spells not yet cast, where no Force is fixed yet and
    // so no Fetish bonus can be quoted against a real roll.
    wrap.append(el("p", { class: "hint" },
      "Stun drain is soaked with Channeling first, then Brawn on what's left. "
      + "LETHAL (physical-based) drain can ONLY be soaked with Channeling. "
      + "A Fetish linked to the spell adds its rating to that Channeling roll."));
    // What's currently up, above the list of what could be — the banner is the
    // thing you consult mid-scene, the list is what you consult between them.
    const banner = activeSpellsBanner();
    if (banner) wrap.append(banner);
    for (const sp of allSpells) {
      const r = DATA.tables.spells.find(x => x.Name === sp.name) || {};
      const force = sp.force + (play.spell_force_advances[sp.name] || 0);
      const lethal = force > zp;
      const perForce = Math.round(+r.Cost || 0);
      wrap.append(el("div", { class: "sh-spell" },
        el("div", {}, el("b", {}, sp.name), " ",
          el("span", { class: "chip magic" }, `F${force}`), " ",
          el("span", { class: "chip" + (lethal ? " neg" : " ok") },
            lethal ? "drain: LETHAL" : "drain: stun"),
          el("span", { class: "sub" }, ` ${r.School || ""}`),
          sp.inPlay ? el("span", { class: "sh-tag" }, "learned in play") : null,
          " ",
          // No Cast button on Shapeshift: casting it means becoming something,
          // so the cast lives on the form you're becoming. A separate Cast
          // would put the spell up with nobody in a shape.
          RULES.isFormSpell(sp.name) ? null
            : el("button", { class: "btn small roll sh-cast",
                title: `Cast ${sp.name} — pick a Force up to ${force}`,
                onclick: () => castSpell(sp.name, force) }, "✦ Cast"),
          RULES.isFormSpell(sp.name) ? null : " ",
          el("button", { class: "btn small",
            disabled: force >= SPELL_FORCE_MAX ? "1" : null,
            title: force >= SPELL_FORCE_MAX ? `Maximum Force is ${SPELL_FORCE_MAX}`
              : `Advance Force (${fmt(perForce)} per Force)`,
            onclick: async () => {
              if (force >= SPELL_FORCE_MAX) return;
              if (play.cash < perForce
                  && !confirm(`+1 Force costs ${fmt(perForce)} but you have ${fmt(play.cash)}. Overdraw?`))
                return;
              play.spell_force_advances[sp.name] = (play.spell_force_advances[sp.name] || 0) + 1;
              // (#82) An advance is a FIELD change, not a purchase — there is
              // no entry to remove — so undo puts the counter back, the same
              // shape armor_trait and unit_condition use. `from` carries the
              // advance count rather than the Force, because that counter is
              // what is stored; the displayed Force is chargen + advances.
              logCash(`${sp.name}: Force ${force} → ${force + 1}`, -perForce,
                { kind: "spell_force", name: sp.name,
                  from: (play.spell_force_advances[sp.name] || 1) - 1 });
              await playChangedRecalc();
            } }, force >= SPELL_FORCE_MAX ? `Force ${SPELL_FORCE_MAX} (max)` : `+1 Force (${fmt(perForce)})`),
          // Sell a spell like any other bought thing (#82). Priced at the same
          // rate everything else about a spell is priced at: the table's Cost
          // is per Force, and that is what learning it and every advance since
          // has charged, so Cost × its CURRENT Force is what the character has
          // actually sunk into it — advances included.
          ro ? null : el("span", {}, " "),
          ro ? null : el("button", { class: "row-del", title: "Sell / forget this spell",
            onclick: () => sellSpell(sp, perForce * force) }, "✕")),
        el("div", { class: "sub" },
          `Drain: ${r.Drain || "—"} · Resist: ${r["Target Resistance"] || "—"} · Duration: ${r.Duration || "—"}`),
        r.Effect ? el("div", { class: "sub" }, r.Effect) : null,
        summonPicker(sp.name, force),
        descriptionExpander(r.Description, `spells:${sp.name}`)));
    }
    // learn a new spell with cash: listed Cost × starting Force
    if (type === "Mage" || type === "Archmage") {
      const known = new Set(allSpells.map(s => s.name));
      const learnable = DATA.tables.spells.filter(r =>
        !known.has(r.Name) && (type === "Archmage" || !CHAR.magic.school || r.School === CHAR.magic.school));
      if (learnable.length) {
        const shortEff = s => (s && s.length > 90) ? s.slice(0, 89) + "…" : (s || "");
        const spellSel = el("select", {},
          el("option", { value: "" }, "Learn new spell…"),
          ...learnable.map(r => el("option", { value: r.Name, title: r.Effect || "" },
            `${r.Name} (${r.School}) — ${fmt(Math.round(+r.Cost || 0))}/Force`
            + (r.Effect ? ` — ${shortEff(r.Effect)}` : ""))));
        const forceSel = el("select", {},
          ...[1, 2, 3, 4, 5, 6].map(f => el("option", { value: String(f) }, `Force ${f}`)));
        wrap.append(el("div", { class: "add-row" }, spellSel, forceSel,
          el("button", { class: "btn-add", onclick: async () => {
            const name = spellSel.value, force = parseInt(forceSel.value, 10);
            if (!name) return;
            const r = DATA.tables.spells.find(x => x.Name === name);
            const cost = Math.round((+r.Cost || 0) * force);
            if (play.cash < cost
                && !confirm(`${name} at Force ${force} costs ${fmt(cost)} but you have ${fmt(play.cash)}. Overdraw?`))
              return;
            play.purchases.spells.push({ name, force });
            logCash(`Learned ${name} at Force ${force}`, -cost, { kind: "spell", name });
            await playChangedRecalc();
          } }, "Buy")));
      }
    }
    body.append(wrap);
  }

  // amp powers (chargen + bought) + buy control — `ref` keeps the original
  // entry so target picks on play purchases actually persist
  const allPowers = [
    ...CHAR.magic.amp_powers.map(p => ({ ...p, ref: p, inPlay: false })),
    ...play.purchases.amp_powers.map(p => ({ ...p, ref: p, inPlay: true }))];
  if (allPowers.length || type === "Amp" || type === "Archmage") {
    const zo = CALC.zoetics;
    const wrap = el("div", { class: "card sh-card" },
      el("div", { class: "sh-card-head" },
        el("h3", {}, "Amp Powers"),
        el("span", {},
          el("span", { class: "chip magic" }, `Amp ZP spent ${zo.amp_zp_spent}`), " ",
          el("span", { class: "chip" + (zo.zp_remaining < 0 ? " neg" : "") },
            `ZP remaining ${zo.zp_remaining}`))));
    if (zo.amp_offline)
      wrap.append(el("div", { class: "sh-callout" },
        "⚠ AMP POWERS OFFLINE — ZP is 0 or less. Shed carried ZR or the powers stay dark."));
    for (const p of allPowers) {
      const r = DATA.tables.amp_powers.find(x => x.Name === p.name) || {};
      // Targeted powers bought in play still need their target picked here —
      // without it, Attribute Boost/Increase and Expertise grant nothing.
      const needsAttr = ["Attribute Boost", "Attribute Increase"].includes(p.name);
      const needsSkill = p.name === "Expertise";
      let targetCtl = null;
      if (p.inPlay && (needsAttr || needsSkill)) {
        targetCtl = el("select", { onchange: async e => {
          p.ref.target = e.target.value; await playChangedRecalc();
        } },
          el("option", { value: "" }, "Choose target…"),
          ...(needsAttr ? ATTR_ABBR.map(([full]) => full)
                        : Object.keys(DATA.skills).sort()).map(x => el("option", {}, x)));
        targetCtl.value = p.target || "";
      }
      // Amps pay half the listed ZP — show both numbers so the listed cost
      // isn't mistaken for what was actually deducted.
      const listedZp = +r["ZP Cost"] || 0;
      const paidZp = listedZp * (type === "Amp" ? 0.5 : 1);
      wrap.append(el("div", { class: "sh-spell amp" },
        el("div", {}, el("b", {}, p.name), " ",
          el("span", { class: "chip",
            title: paidZp !== listedZp ? "Amps pay half the listed ZP cost" : null },
            r["ZP Cost"] == null ? "? ZP"
              : paidZp !== listedZp ? `${listedZp} ZP → paid ${paidZp}`
              : `${listedZp} ZP`),
          p.target && !targetCtl ? el("span", { class: "sub" }, ` → ${p.target}`) : null,
          (p.times || 1) > 1 ? el("span", { class: "sub" }, ` ×${p.times}`) : null,
          p.inPlay ? el("span", { class: "sh-tag" }, "bought in play") : null,
          targetCtl ? el("span", {}, " ", targetCtl) : null,
          targetCtl && !p.target
            ? el("span", { class: "sub", style: "color:var(--bad)" }, " ← needs a target to apply")
            : null),
        r.Effect ? el("div", { class: "sub" }, r.Effect) : null,
        descriptionExpander(r.Description, `amp_powers:${p.name}`)));
    }
    if (type === "Amp" || type === "Archmage") {
      const zpMult = type === "Amp" ? 0.5 : 1;
      const powerSel = el("select", {}, el("option", { value: "" }, "Buy amp power…"),
        ...DATA.tables.amp_powers.map(r =>
          el("option", { value: r.Name }, `${r.Name} — ${(+r["ZP Cost"] || 0) * zpMult} ZP`)));
      wrap.append(el("div", { class: "add-row" }, powerSel,
        el("button", { class: "btn-add", onclick: async () => {
          const name = powerSel.value;
          if (!name) return;
          const r = DATA.tables.amp_powers.find(x => x.Name === name);
          const zpCost = (+r["ZP Cost"] || 0) * zpMult;
          if (zpCost > CALC.zoetics.zp_remaining) {   // ZP can never go negative on a purchase
            alert(`${name} needs ${zpCost} ZP but only ${CALC.zoetics.zp_remaining} remains. ZP cannot go negative.`);
            return;
          }
          play.purchases.amp_powers.push({ name, target: "", times: 1 });
          // (#82) Amp powers are paid for in ZP, never cash, so buying one used
          // to leave no trace anywhere the player could act on — and there was
          // no ✕ on the row either, so a misclicked power was permanent.
          //
          // It gets a ZERO-DELTA ledger row: the Activity list already carries
          // changes that moved no money (unpaid lifestyle months, write-offs),
          // and undoCashSpend's `delta` arithmetic is a no-op on 0, so the
          // ledger stays exactly balanced while the row gives the purchase an
          // Undo button. The ZP refund needs no arithmetic of its own —
          // CALC.zoetics.amp_zp_spent is DERIVED from this list by the engine,
          // so dropping the entry returns precisely what was charged, half-cost
          // Amp discount and all. `zp` rides along for the label only.
          logCash(`Learned amp power ${name} (${zpCost} ZP)`, 0,
            { kind: "amp_power", name, zp: zpCost });
          await playChangedRecalc();
        } }, "Buy (ZP)")));
      wrap.append(el("p", { class: "hint" },
        "New powers draw on your remaining ZP and cannot take it below 0"
        + (type === "Amp" ? " (Amps pay half the listed ZP)." : ".")));
    }
    body.append(wrap);
  }

  if (type === "Speaker" || type === "Archmage") {
    // CALC, not CHAR: the folded-in view, so bonds/infusions/relationships
    // bought with Kismet in play show up here alongside the chargen ones.
    const s = CALC.speaker;
    play.infusion_spirits = play.infusion_spirits || {};
    play.bond_slots = play.bond_slots || [];
    // Infusion slot base name -> the spirit column that holds its benefit.
    const slotColumn = slot => {
      const base = slot.replace(/\s*\d+$/, "").trim();
      return base === "Firearms" ? "Firearm" : base;
    };
    const spiritRow = name => DATA.tables.speaker_spirits.find(x => x.Spirit === name) || {};
    const card = el("div", { class: "card sh-card" },
      el("h3", {}, "Speaker — Spirits, Infusions & Bonds"));

    // Bond count and slot array grown up front — not just in the Bonds
    // section below — so the Infusions section, which renders first, already
    // sees every live bond occupant for the exclusivity rule both use.
    // Grow to the bought count, never shrink. Dropping Bonds in chargen and
    // raising it again must hand the spirit back, so slots past the count are
    // kept dormant and simply not rendered — the array is play state, and the
    // count alone decides how much of it is live (see speakerBondCount).
    const bondCount = RULES.speakerBondCount(CALC);
    while (play.bond_slots.length < bondCount) play.bond_slots.push({ spirit: "", force: 0, favors: 0 });
    // A spirit slotted into a bond or an infusion is committed there and can't
    // ALSO fill a different bond or infusion — one spirit, one job at a time.
    // Fixed for this render: nothing in the Infusions loop touches bond_slots
    // and nothing in the Bonds loop touches infusion_spirits, so a snapshot
    // here is exact for both.
    const liveBondSpirits = new Set(play.bond_slots.slice(0, bondCount)
      .filter(b => b && b.spirit).map(b => b.spirit));
    const infusedSpirits = new Set(Object.values(play.infusion_spirits));

    if (s.relationships.length) {
      const row = el("div", { class: "sh-tagrow" });
      for (const name of s.relationships) {
        const r = spiritRow(name);
        row.append(el("span", { class: "sh-tag magic" },
          `${name}${r.Element ? " · " + r.Element : ""}`));
      }
      card.append(el("h4", { class: "sh-h4" }, "Relationships"), row);
    } else {
      card.append(el("p", { class: "hint" },
        "No spirit relationships — add them in chargen, or buy one with Kismet."));
    }

    // --- Infusions (#26): place a spirit into each infusion slot; show benefit
    if (s.infusions.length) {
      card.append(el("h4", { class: "sh-h4" }, "Infusions — place a spirit for its benefit"));
      for (const slot of s.infusions) {
        const col = slotColumn(slot);
        const placed = play.infusion_spirits[slot] || "";
        const sel = el("select", { onchange: e => {
          if (e.target.value) play.infusion_spirits[slot] = e.target.value;
          else delete play.infusion_spirits[slot];
          playChanged();
        } }, el("option", { value: "" }, "— empty —"),
          // A spirit can only do one job at a time: one already placed in
          // another infusion slot, or already bonded, isn't offered here (the
          // engine dedupes too, as a safety net).
          ...s.relationships
            .filter(n => n === placed
              || (!liveBondSpirits.has(n)
                  && !Object.entries(play.infusion_spirits).some(([k, v]) => k !== slot && v === n)))
            .map(n => el("option", { value: n }, n)));
        sel.value = placed;
        const benefit = placed ? (spiritRow(placed)[col] || "no listed benefit") : "";
        // Say whether this placement moved a number or has to be played out at
        // the table, so "active" isn't mistaken for "already in my stats".
        card.append(el("div", { class: "sh-advrow" + (placed ? " active-row" : "") },
          el("span", {}, el("b", {}, slot),
            placed ? el("span", { class: "chip ok", style: "margin-left:6px" }, "active") : null,
            placed ? el("span", { class: "sh-tag", style: "margin-left:6px" },
              infusionAppliedLabel(placed)) : null,
            benefit ? el("div", { class: "sub", style: "color:var(--ok)" }, benefit) : null),
          sel));
      }
      if (CALC.infusion_mods && CALC.infusion_mods.applied.length) {
        card.append(el("p", { class: "hint" }, "Folded into your stats: "
          + CALC.infusion_mods.applied.map(a => `${a.text} (${a.source})`).join(" · ")));
      }
      // quick reference: every spirit's benefit for each infusion type
      const ref = el("details", { style: "margin-top:8px" }, el("summary", { class: "sub" }, "All spirit infusion benefits"));
      const rt = el("table", { style: "margin-top:6px" });
      rt.append(el("tr", {}, el("th", {}, "Spirit"), el("th", {}, "Firearm"),
        el("th", {}, "Protection"), el("th", {}, "Drone"), el("th", {}, "Digital"), el("th", {}, "Physical")));
      for (const name of s.relationships) {
        const r = spiritRow(name);
        rt.append(el("tr", {}, el("td", {}, el("b", {}, name)),
          el("td", { class: "sub" }, r.Firearm || "—"), el("td", { class: "sub" }, r.Protection || "—"),
          el("td", { class: "sub" }, r.Drone || "—"), el("td", { class: "sub" }, r.Digital || "—"),
          el("td", { class: "sub" }, r.Physical || "—")));
      }
      ref.append(rt);
      card.append(ref);
    }

    // --- Bonds (#27): place spirits in bond slots and track favors
    card.append(el("h4", { class: "sh-h4" }, `Bonds — ${bondCount} slot(s), track favors owed`));
    if (!bondCount) card.append(el("p", { class: "hint" }, "No spirit bonds yet."));
    const dormant = play.bond_slots.slice(bondCount).filter(b => b && b.spirit);
    const bondTiles = el("div", { class: "sh-bond-tiles" });
    play.bond_slots.slice(0, bondCount).forEach((bond, bi) => {
      // Same exclusivity as the infusion picker above, plus every OTHER live
      // bond slot — a spirit already holding one bond can't fill a second.
      const otherBonds = new Set(play.bond_slots.slice(0, bondCount)
        .filter((b, j) => j !== bi && b && b.spirit).map(b => b.spirit));
      const sel = el("select", { onchange: e => { bond.spirit = e.target.value; playChanged(); } },
        el("option", { value: "" }, "— empty —"),
        ...s.relationships
          .filter(n => n === bond.spirit || (!otherBonds.has(n) && !infusedSpirits.has(n)))
          .map(n => el("option", { value: n }, n)));
      sel.value = bond.spirit || "";
      const row = bond.spirit ? spiritRow(bond.spirit) : {};
      // Each slot keeps one identity colour (see --bond-N in style.css) so four
      // bound spirits stay tellable apart; slots past the fourth wrap around.
      const tile = el("div", { class: `sh-bond-tile slot-${(bi % 4) + 1}`
          + (bond.spirit ? " active" : "") },
        el("div", { class: "k" }, `Bond ${bi + 1}`),
        sel);
      if (row.Element) tile.append(el("div", { class: "sh-bond-meta" },
        el("span", { class: "sh-tag magic" }, row.Element)));
      // Force drives the [F] terms in the ability text below, so it sits with
      // Favors above the detail rather than buried under it.
      tile.append(el("div", { class: "sh-bond-fav" },
        bond.spirit
          ? miniCounter("Force", () => bond.force || 0, v => { bond.force = v; }, 0, 12)
          : null,
        miniCounter("Favors", () => bond.favors || 0, v => { bond.favors = v; }, 0, 99)));
      if (bond.spirit) tile.append(...bondSpiritDetail(bond.spirit, row, bond.force || 0));
      bondTiles.append(tile);
    });
    if (bondCount) card.append(bondTiles);
    // Say so out loud, otherwise a dropped bond looks like lost data.
    if (dormant.length) card.append(el("p", { class: "hint" },
      `Held for ${dormant.length} bond slot(s) you no longer have: `
      + dormant.map(b => b.spirit).join(" · ")
      + ". Raise Bonds in chargen to get them back — nothing has been deleted."));

    if (CHAR.magic.archmage_bind) card.append(statLine("Bound spirit (chargen)", "yes (15 Force)"));
    body.append(card);
  }

  // Rituals — full reference table with the character's current level in each
  // (raised via Kismet on the Kismet tab). Shown for every magic type, since
  // rituals are bought as ordinary skill points at chargen regardless of type.
  {
    const t = el("table");
    t.append(el("tr", {}, el("th", {}, "Ritual"), el("th", { class: "num" }, "Level"),
      el("th", {}, "Drain"), el("th", {}, "Time"), el("th", {}, "Effect")));
    for (const r of DATA.tables.rituals) {
      const lvl = (CALC.ritual_skills || {})[r.Name] || 0;
      t.append(el("tr", { class: lvl > 0 ? "sh-ritual-trained" : null },
        el("td", {}, el("b", {}, r.Name)),
        el("td", { class: "num" }, lvl > 0 ? el("b", {}, String(lvl)) : el("span", { class: "sub" }, "—")),
        el("td", { class: "sub" }, r.Drain),
        el("td", { class: "sub" }, r.Time),
        el("td", { class: "sub" }, r.Effect,
          descriptionExpander(r.Description, `rituals:${r.Name}`))));
    }
    body.append(el("div", { class: "card sh-card" },
      el("h3", {}, "Rituals ", trainedOnlyChip()), t));
  }
}

/* ---- running programs (#79) -------------------------------------------------
 * Running a program is a Computer: Hacking test with the program's rating added
 * to the dice, and the dice have to be paid for. Two things pay: the deck's MCP
 * — spare cycles the machine itself contributes, sized by its MCP rating — and
 * then the decker's own Focus pool. MCP goes first, because it is the resource
 * that exists only for this and refreshes every round anyway; spending Focus
 * while the deck still had cycles left would be strictly worse for the player
 * with no decision behind it.
 *
 * MCP dice are stored the way Beast dice are (play.mcp_dice, refreshed by New
 * Round) rather than as a pool: the max is derived from whichever deck is
 * active, so only the REMAINDER is play state and swapping decks re-reads the
 * ceiling for free.
 */

/* The size of the MCP reserve: the MCP rating of the deck the character is
 * jacked into. Zero with no active deck, which is also the "no MCP dice" case,
 * so callers need no separate check. Goes through RULES.equippedDeckName so it
 * agrees with the engine about which deck is the live one. */
function mcpDiceMax() {
  const name = RULES.equippedDeckName(CHAR);
  if (!name) return 0;
  const row = DATA.tables.decks.find(x => x.Name === name) || {};
  return Math.max(0, toIntSafe(row.MCP));
}

/* MCP dice still available. null (never touched) reads as full, and the value
 * is clamped rather than rewritten, so downgrading decks mid-round can't leave
 * a stored number above the new ceiling — same lossless clamp poolState uses. */
function mcpDiceLeft() {
  const max = mcpDiceMax();
  const stored = CHAR.play.mcp_dice;
  return Math.max(0, Math.min(max, stored == null ? max : stored));
}

/* MCP dice come back with the round, like the pools and Wildling's Beast dice.
 * Written back as the raw max — a character with no deck stores 0, which is the
 * honest reading of "you have no MCP dice" rather than "untouched, assume
 * full". */
function refreshMcpDice() { CHAR.play.mcp_dice = mcpDiceMax(); }

/* Everything the Run button needs to know before anything is spent: the skill
 * the program rolls, what the roll costs in dice, and what is actually there to
 * pay with. Kept separate from the spending so the button can render its
 * tooltip from the same numbers the click will charge.
 *
 * The skill is RULES.programSkill's answer where it has one — under the Classic
 * EW house rule the EW programs roll Computer: Electronic Warfare, and the tab
 * already tells the player so on the row itself — falling back to plain
 * Computer: Hacking for everything else. Both sit in the Focus pool, so #79's
 * "charges the character's Focus pool" holds either way; the pool is read off
 * the skill rather than hardcoded so a house rule that moved one wouldn't
 * silently charge the wrong pool. */
function programRunSpec(name, row) {
  const skill = RULES.programSkill(name) || RULES.HACKING_SKILL;
  const s = (CALC.skills || {})[skill] || {};
  const skillDice = Math.max(0, toIntSafe(s.final));
  const rating = RULES.programRating(name);
  const pool = s.pool || "Focus";
  const mcp = mcpDiceLeft();
  const focus = poolState(pool).remaining;
  return {
    skill, pool, skillDice, rating,
    cost: skillDice + rating,
    // Skill dice bonuses (a Skillsoft, a piece of kit) are free dice the way
    // they are everywhere else on the sheet: rolled, never paid for.
    bonusDice: Math.max(0, toIntSafe(s.dice_bonus)),
    mcp, focus, available: mcp + focus,
    // A Complex Action is 2 Simple Actions; see RULES.programActionUnits.
    actionUnits: RULES.programActionUnits(row),
    actionType: String((row || {})["Action Type"] || "").trim(),
  };
}

/* ------------------------------------- raising a program's rating (#82)
 *
 * PRICING, and where it comes from: a rated program is not one row with a
 * rating field, it is SIX rows — "Crack Encryption 1" … "Crack Encryption 6" —
 * each with its own Cost in the programs table. Nothing here is invented: the
 * charge is simply the difference between the row the character owns and the
 * row they are moving to, exactly the way armorTraitSelect charges base ×
 * (newMult − oldMult) and unitConditionSelect charges the difference between
 * two condition factors. The program has already been bought once; only the
 * gap is outstanding.
 *
 * That reading is worth stating because it is NOT "Cost per rating × 1". Most
 * families happen to be linear (Acid Burn is 2,000 per point, so either reading
 * gives 2,000), but some are not: Sonic Sickness is a flat 10,000 at every
 * rating, so re-rating it is free — which is what the data says, and pricing it
 * off a per-point average would silently overcharge for it. Reading the two
 * rows keeps homebrew program families working too, whatever curve they use.
 *
 * Returns null where there is nothing to sell: an unrated program, one already
 * at the ceiling, one whose next tier isn't in the table, or one whose next
 * tier the character ALREADY owns — a duplicate name would break every
 * name-keyed lookup on this tab (loaded threads, deck slots, ownership). */
function programUpgrade(name, mult) {
  const from = RULES.programRating(name);
  if (!from || from >= RULES.HACKING_RATING_MAX) return null;
  const to = String(name).trim().replace(/\s\d+$/, ` ${from + 1}`);
  const fromRow = DATA.tables.programs.find(x => x.Name === name);
  const toRow = DATA.tables.programs.find(x => x.Name === to);
  if (!fromRow || !toRow) return null;
  if (allPrograms().includes(to)) return null;
  const fromCost = Math.round((+fromRow.Cost || 0) * mult);
  const toCost = Math.round((+toRow.Cost || 0) * mult);
  return { from: name, to, rating: from + 1, fromCost, toCost,
    // A family priced flat across its ratings yields 0, not a refund: a
    // downgrade isn't on offer here, so the charge floors at nothing.
    cost: Math.max(0, toCost - fromCost) };
}

/* Rename the owned program in place. The entry is a bare STRING in the array
 * (programs have no per-copy state), so "raising the rating" is literally
 * writing the higher-rated name over it — which is why every other place that
 * holds a program name has to move with it: the deck's loaded threads and the
 * `hacking` slot on each deck both key off the name and would go stale
 * otherwise, exactly the drift pruneLoadedPrograms was written to catch. */
async function raiseProgramRating(en, upgrade) {
  const play = CHAR.play;
  if (upgrade.cost > 0 && play.cash < upgrade.cost
      && !confirm(`${upgrade.to} costs ${fmt(upgrade.cost)} more than `
        + `${upgrade.from} but you have ${fmt(play.cash)}. Overdraw?`)) return;
  en.arr[en.i] = upgrade.to;
  const dk = play.decking || {};
  dk.loaded = (dk.loaded || []).map(n => (n === upgrade.from ? upgrade.to : n));
  for (const d of [...kitOf("decks"), ...(play.purchases.decks || [])])
    if (d && d.hacking === upgrade.from) d.hacking = upgrade.to;
  logCash(`${upgrade.from} → rating ${upgrade.rating}`, -upgrade.cost,
    { kind: "program_rating", from: upgrade.from, to: upgrade.to });
  await playChangedRecalc();
}

/* Run a program: charge the action, charge the dice, open the roller loaded.
 *
 * The dice are spent HERE rather than handed to the roller as a `pool`, which
 * is what every other rollable on the sheet does. It has to be: the roller
 * knows how to bill exactly one pool, and #79 needs two resources drained in a
 * fixed order (MCP, then Focus). So the cost is settled up front and the roller
 * is opened pool-less — it would otherwise bill Focus a second time for dice
 * the MCP already paid for. The note tells the player what moved.
 *
 * Short of dice is NOT a refusal (#79): say so, spend everything that is there,
 * and open the roller with the dice they actually have. Short of ACTIONS is a
 * refusal, because that is spendActionUnits' contract everywhere else — a
 * refused action costs nothing, and the dice must not move if the run never
 * happened. So the action is charged first. */
function runProgram(name, row) {
  const spec = programRunSpec(name, row);
  // Gated on the loadout switch inside spendActionUnits: with action costs off
  // this is a no-op that succeeds, and only the dice are charged.
  if (!spendActionUnits("Decking", spec.actionUnits, `running ${name}`)) return;

  const paid = Math.min(spec.cost, spec.available);
  const fromMcp = Math.min(paid, spec.mcp);
  const fromPool = paid - fromMcp;
  CHAR.play.mcp_dice = spec.mcp - fromMcp;
  if (fromPool) {
    const ps = poolState(spec.pool);
    CHAR.play.pool_used = CHAR.play.pool_used || {};
    CHAR.play.pool_used[spec.pool] = Math.min(ps.max, ps.used + fromPool);
  }

  if (paid < spec.cost)
    alert(`Not enough dice to run ${name} — it needs ${spec.cost} `
      + `(${spec.skillDice} ${spec.skill} + ${spec.rating} rating) and you have `
      + `${spec.available} (${spec.mcp} MCP + ${spec.focus} ${spec.pool}).\n\n`
      + `Rolling the ${paid} you have.`);

  const paidBits = [];
  if (fromMcp) paidBits.push(`${fromMcp} MCP`);
  if (fromPool) paidBits.push(`${fromPool} ${spec.pool}`);
  openPoolRoller({
    dice: paid, bonus: spec.bonusDice, pool: "",
    label: `Run ${name}`,
    note: `${spec.skill}: ${spec.skillDice} skill + ${spec.rating} rating`
      + (spec.bonusDice ? ` + ${spec.bonusDice} bonus` : "")
      + (paidBits.length ? ` · paid ${paidBits.join(" + ")}` : " · nothing to pay with"),
  });
  playChanged();
}

/* ------------------------------------------------ decking tab */
function shDecking(body) {
  const dk = CHAR.play.decking;
  const deckEntries = ownedDecks();
  const decks = deckEntries.map(e => e.ref);
  if (decks.length && !decks.some(d => d.name === dk.active_deck))
    dk.active_deck = decks[0].name;
  const active = DATA.tables.decks.find(x => x.Name === dk.active_deck);

  // Decks, deck mods, programs and hacking levels are not physical kit — the
  // small-heritage surcharge never applies (surchargeFor("deck") → 1).
  const mult = RULES.surchargeFor("deck", CALC.budget.gear_cost_multiplier || 1);
  // Buy browsers collect here and render at the bottom of the tab.
  const deckBuySection = el("div", { class: "card sh-card", id: "deck-buy" },
    el("h3", {}, "Buy decks & programs"));
  const deckCard = el("div", { class: "card sh-card" }, el("h3", {}, "Cyberdecks"));
  deckEntries.forEach((en, di) => {
    const { ref: d, arr: deckArr, i: deckIndex, inPlay, category } = en;
    const r = DATA.tables.decks.find(x => x.Name === d.name) || {};
    const isActive = d.name === dk.active_deck;
    const modSub = sublistOf(en, "mods");
    const deckModCost = name => Math.round(
      (+(DATA.tables.deck_mods.find(m => m["Deck Mod"] === name) || {}).Cost || 0) * mult);
    const modEditor = fittedCategoryEditor({
      id: `sh-dmods-${di}-${d.name}`,
      items: modSub.items,
      groups: modGroups(DATA.tables.deck_mods, "Deck Mod", null, "Deck Mods"),
      onAdd: name => {
        const cost = deckModCost(name);
        if (CHAR.play.cash < cost
            && !confirm(`${name} costs ${fmt(cost)} but you have ${fmt(CHAR.play.cash)}. Overdraw?`)) return;
        modSub.add(name);
        logCash(`Fitted ${name} to ${d.name}`, -cost,
          { kind: "deck_mod", host: d.name, name });
      },
      onRemove: index => disposeOfMod({ entry: en, list: "mods", index,
        name: sublistName(modSub.items[index]), hostName: d.name,
        value: deckModCost(sublistName(modSub.items[index])) }),
      effectOf: name => (DATA.tables.deck_mods.find(m => m["Deck Mod"] === name) || {}).Effect || "",
      rerender: renderSheet, afterAdd: () => playChangedRecalc(),
    });
    deckCard.append(el("div", { class: "sh-unit" },
      el("div", {},
        el("div", { class: "sh-advrow" + (isActive ? " active-row" : ""), style: "border:0;padding:0" },
          el("span", {}, el("b", {}, d.name),
            el("span", { class: "sub" },
              ` MCP ${r.MCP} · Hardening ${deckHardeningBit(d, r)} · Threads ${r.Threads} · Core ${r.Core} · I/O ${r.IO}`
              // Range is per-deck because the mods that change it are per-deck.
              + ` · Range ${RULES.deckHackRange(d, DATA.tables)} m`)),
          isActive ? el("span", { class: "chip ok" }, "Active")
            : counterBtn("Set Active", () => {
                dk.active_deck = d.name; dk.loaded = []; playChanged();
              })),
        el("div", { class: "sh-unit-add" }, el("b", {}, "Mods"), modEditor)),
      el("button", { class: "row-del", title: "Sell / remove deck",
        onclick: async () => {
          const row = DATA.tables.decks.find(x => x.Name === d.name) || {};
          // (#81) Fitted deck mods refund in full; only the chassis is scaled.
          const fitted = flatFittedValue(d.mods, [["deck_mods", "Deck Mod"]], mult);
          if (!await disposeOfItem({ category, arr: deckArr, index: deckIndex, inPlay,
            name: d.name, value: Math.round((+row.Cost || 0) * mult) + fitted,
            modsValue: fitted })) return;
          if (dk.active_deck === d.name) { dk.active_deck = ""; dk.loaded = []; }
          await playChangedRecalc();
        } }, "✕")));
  });
  if (!decks.length) deckCard.append(el("p", { class: "hint" }, "No decks owned."));

  // buy a new cyberdeck in play
  const deckGroups = [{ label: "Cyberdecks", items: DATA.tables.decks.map(x => ({
    name: x.Name, cost: Math.round((+x.Cost || 0) * mult),
    sub: `MCP ${x.MCP} · Threads ${x.Threads} · Core ${x.Core} · I/O ${x.IO}` })) }];
  deckBuySection.append(el("div", { class: "sh-unit-add" }, el("b", {}, "Buy cyberdeck"),
    categoryBrowser({ id: "buy-decks", groups: deckGroups,
      rerender: renderSheet, afterAdd: () => playChangedRecalc(),
      onAdd: name => {
        const row = DATA.tables.decks.find(x => x.Name === name) || {};
        const cost = Math.round((+row.Cost || 0) * mult);
        if (CHAR.play.cash < cost
            && !confirm(`${name} costs ${fmt(cost)} but you have ${fmt(CHAR.play.cash)}. Overdraw?`)) return;
        CHAR.play.purchases.decks.push({ name, mods: [] });
        logCash(`Bought ${name}`, -cost, { kind: "deck", name });
      } })));
  body.append(deckCard);

  // --- hacking program: the deck's operating system, slotted per deck. Costs
  // no thread and no I/O; a deck without one doesn't run at all.
  const activeEntry = deckEntries.find(e => e.ref.name === (active && active.Name));
  const required = active ? RULES.deckHackingRequired(active) : 0;
  const slotted = activeEntry ? (activeEntry.ref.hacking || "") : "";
  const ownedHacking = allPrograms().filter(RULES.isHackingProgram);
  const rating = RULES.hackingProgramRating(slotted);
  const meets = !active || (slotted && ownedHacking.includes(slotted) && rating >= required);
  const hackBox = el("div", { class: "sh-hackbox" },
    el("div", { class: "sh-card-head" },
      el("h4", { class: "sh-h4", style: "margin:0" }, "Hacking Program"),
      el("span", { class: "chip" + (meets ? " ok" : " neg") },
        !active ? "no active deck"
          : !slotted ? "none slotted"
          : `${slotted} / required ${required}`)),
    el("p", { class: "hint" },
      "A deck runs on the Hacking program slotted into it — buy one below and pick it "
      + "here. It must be rated at least ½ the deck's MCP (round down, min 1)"
      + (active ? ` — min ${required} for ${active.Name} (MCP ${active.MCP})` : "")
      + ". It uses no thread and no I/O, and moves between decks freely."),
    activeEntry
      ? el("div", { class: "add-row" },
          el("span", { class: "sub" }, "Slotted "),
          (() => {
            const sel = el("select", { onchange: async e => {
              activeEntry.ref.hacking = e.target.value; await playChangedRecalc(); } },
              el("option", { value: "" },
                ownedHacking.length ? "— no Hacking program —" : "— none owned —"),
              ...ownedHacking.map(n => el("option", { value: n },
                `${n}${RULES.hackingProgramRating(n) < required ? " (under ½ MCP)" : ""}`)));
            sel.value = slotted;
            return sel;
          })())
      : el("p", { class: "hint" }, "Set a deck active to slot its Hacking program."));

  const threads = active ? +active.Threads : 0;
  // MCP dice (#79) read out beside the thread count because that is where the
  // player is looking when they pick a program to run, and they are the first
  // thing a run spends. They refresh on New Round like the pools; the ↻ is here
  // for the same reason Beast dice have one — a table that runs rounds loosely
  // still needs a way to top them up.
  const mcpMax = mcpDiceMax();
  const mcpLeft = mcpDiceLeft();
  const progCard = el("div", { class: "card sh-card" },
    el("div", { class: "sh-card-head" },
      el("h3", {}, "Programs"),
      el("span", { style: "display:inline-flex;gap:6px;align-items:center" },
        mcpMax
          ? el("span", { class: "chip" + (mcpLeft ? " ok" : " neg"),
              title: `MCP dice from ${dk.active_deck} — spent before the Focus `
                + "pool when you run a program. Refresh each round." },
              `MCP dice ${mcpLeft} / ${mcpMax}`)
          : null,
        mcpMax
          ? counterBtn("↻", () => { refreshMcpDice(); playChanged(); }, "good")
          : null,
        el("span", { class: "chip" + (dk.loaded.length > threads ? " neg" : "") },
          `Loaded ${dk.loaded.length} / ${threads}`))),
    hackBox);   // the Hacking program lives at the top of the Programs section
  // Programs whose I/O is N/A or No are never loaded onto threads — they run
  // without occupying a thread slot, so no Load button is shown for them. The
  // gear-ZR rule reads the same predicate, so the two can't disagree about what
  // being loaded means.
  const programEntries = ownedPrograms();
  // `en` is kept whole (not just destructured) because raiseProgramRating (#82)
  // needs the backing array and index together to rename the entry in place.
  programEntries.forEach(en => {
    const { ref: name, arr: progArr, i: progIndex, inPlay, category } = en;
    const r = DATA.tables.programs.find(x => x.Name === name) || {};
    const io = r["I/O"] || "—";
    const loadable = RULES.programNeedsThread(r);
    const loaded = dk.loaded.includes(name);
    const nodeCtrl = ` · Node Control ${r["Node Control"] || "N"}`;
    const pSkill = RULES.programSkill(name);   // EW programs: EW skill (Classic) or Hacking
    // Run Program (#79). Not offered on the Hacking family: that is the deck's
    // operating system, not a tool you run — which is also why its Action Type
    // is "N/A" — so a Run button there would be an invitation to spend dice on
    // nothing. Everything else gets one, loaded or not: loading a program is
    // about threads, not about whether you can point it at something.
    const runSpec = RULES.isHackingProgram(name) ? null : programRunSpec(name, r);
    const upgrade = programUpgrade(name, mult);
    // Issue #84: a flex row sizes its action cluster to whatever that ROW
    // happens to hold, so a program with no Upgrade (rating-capped, or none
    // to raise to) sat with Run one slot further left than its neighbours —
    // "Run" and "Load" drifted sideways program to program instead of
    // stacking into columns. `.sh-prog-actions` fixes each button to the same
    // width on every row via `grid-template-columns`, and every row supplies
    // all four cells — an empty placeholder standing in for a button that
    // doesn't apply — so a column's X position is the same whether or not
    // THIS row's version of it has anything to say. Order (left to right)
    // follows the request: rating upgrade, then Run beside it, then Load.
    const upgradeCell = upgrade
      // Costs run to 6 figures on the priciest programs and the column is
      // fixed-width to line up with every other row, so long labels wrap to a
      // second line (style.css) rather than push the column wider.
      ? el("button", { class: "btn small",
          title: `Upgrade to ${upgrade.to} — ${fmt(upgrade.cost)}`
            + ` (${fmt(upgrade.toCost)} − ${fmt(upgrade.fromCost)} already paid)`,
          onclick: () => raiseProgramRating(en, upgrade) },
          `+1 Rating (${fmt(upgrade.cost)})`)
      : el("span", { class: "sh-prog-cell-empty", "aria-hidden": "true" });
    const runCell = runSpec
      // The dice count is on the face, not just the tooltip: it is the
      // number the player is deciding on, and at a coarse pointer there is
      // no hover to read.
      ? el("button", { class: "btn good",
          title: `Roll ${runSpec.cost}d6 — ${runSpec.skill} ${runSpec.skillDice}`
            + ` + ${name} rating ${runSpec.rating}`
            + (runSpec.bonusDice ? `, bonus ${runSpec.bonusDice}` : "")
            + `. Costs ${runSpec.cost} dice: ${runSpec.mcp} MCP available,`
            + ` then ${runSpec.pool}`
            + (runSpec.actionUnits
                ? ` · ${runSpec.actionType} Action (Decking Exploit first, then Simple)`
                : ""),
          onclick: () => runProgram(name, r) }, `Run (${runSpec.cost}d)`)
      : el("span", { class: "sh-prog-cell-empty", "aria-hidden": "true" });
    const loadCell = loadable
      ? counterBtn(loaded ? "Unload" : "Load", () => {
          if (loaded) dk.loaded = dk.loaded.filter(n => n !== name);
          else if (dk.loaded.length >= threads) { alert("All threads are in use — unload something first."); return; }
          else dk.loaded.push(name);
          playChanged();
        }, loaded ? "" : "accent")
      : el("span", { class: "chip", title: `I/O ${io}: runs without occupying a thread` }, "no load");
    progCard.append(el("div", { class: "sh-advrow" },
      el("span", {}, el("b", {}, name),
        // Action Type is on the face now that Run charges it (#79) — what a
        // button will cost you shouldn't live only in its tooltip.
        el("span", { class: "sub" }, ` ${r.Attack || ""} · I/O ${io} · Alert ${r.Alert || 0}${nodeCtrl}`
          + (runSpec && runSpec.actionType && runSpec.actionType !== "N/A"
              ? ` · ${runSpec.actionType} Action` : "")),
        pSkill ? el("div", { class: "sub" }, `Skill: ${pSkill}`) : null,
        r.Effect ? el("div", { class: "sub" }, r.Effect) : null,
        descriptionExpander(r.Description, `programs:${name}`)),
      el("span", { class: "sh-prog-actions" },
        upgradeCell, runCell, loadCell,
        el("button", { class: "row-del", title: "Sell / remove program",
          onclick: async () => {
            const pr = DATA.tables.programs.find(x => x.Name === name) || {};
            if (!await disposeOfItem({ category, arr: progArr, index: progIndex, inPlay,
              name, value: Math.round((+pr.Cost || 0) * mult) })) return;
            dk.loaded = dk.loaded.filter(n => n !== name);
            await playChangedRecalc();
          } }, "✕"))));
  });
  if (!programEntries.length) progCard.append(el("p", { class: "hint" }, "No programs owned."));

  // buy new programs in play (grouped by Attack class, owned ones drop out)
  const ownedProg = new Set(allPrograms());
  const progByType = {};
  DATA.tables.programs.forEach(pr =>
    (progByType[pr.Attack || "Program"] ??= []).push(pr));
  // Hacking leads the list — it's what makes a deck run, not a tool run on it.
  const progGroups = Object.entries(progByType)
    .sort(([a], [b]) => (a === RULES.HACKING_PROGRAM_CATEGORY ? -1 : 0)
                      - (b === RULES.HACKING_PROGRAM_CATEGORY ? -1 : 0)
                      || a.localeCompare(b))
    .map(([label, rows]) => ({
      label,
      items: rows.map(pr => ({
        name: pr.Name, cost: Math.round((+pr.Cost || 0) * mult),
        sub: `I/O ${pr["I/O"] || "—"} · Node Control ${pr["Node Control"] || "N"}`
          + (RULES.programSkill(pr.Name) ? ` · Skill: ${RULES.programSkill(pr.Name)}` : "")
          + (pr.Effect ? " · " + pr.Effect : ""),
        hidden: ownedProg.has(pr.Name),
      })),
    }));
  deckBuySection.append(el("div", { class: "sh-unit-add" }, el("b", {}, "Buy program"),
    categoryBrowser({ id: "buy-programs", groups: progGroups,
      rerender: renderSheet, afterAdd: () => playChangedRecalc(),
      onAdd: name => {
        const pr = DATA.tables.programs.find(x => x.Name === name) || {};
        const cost = Math.round((+pr.Cost || 0) * mult);
        if (CHAR.play.cash < cost
            && !confirm(`${name} costs ${fmt(cost)} but you have ${fmt(CHAR.play.cash)}. Overdraw?`)) return;
        CHAR.play.purchases.programs.push(name);
        logCash(`Bought program ${name}`, -cost, { kind: "program", name });
      } })));
  body.append(progCard);
  body.append(deckBuySection);
}

/* Condition on an owned drone or vehicle, with the money attached (#73).
 *
 * The picker itself already existed in play, but changing it only recalculated:
 * the factor scales the base chassis price, so a Scooter switched from Pristine
 * to Good got cheaper on paper while the cash on hand never moved. This charges
 * or refunds the DIFFERENCE between the two factors, never the whole new price,
 * because the unit has already been bought once -- the same rule the armor
 * Quality/Style pickers follow.
 *
 * An unaffordable upgrade asks before overdrawing and snaps back if declined,
 * rather than leaving the unit improved and the balance negative. The previous
 * value rides in the ledger entry so Undo can put it back. */
function unitConditionSelect(u, table, baseCost, mult) {
  let previous = u.condition || "Pristine";
  const factor = c => RULES.VEHICLE_CONDITION_FACTORS[c] ?? 1;
  return vehicleConditionSelect(u, async () => {
    const delta = Math.round(baseCost * (factor(u.condition) - factor(previous)) * mult);
    if (delta > 0 && CHAR.play.cash < delta
        && !confirm(`Changing ${u.name} to ${u.condition} costs ${fmt(delta)} but you have `
          + `${fmt(CHAR.play.cash)}. Overdraw?`)) {
      u.condition = previous;
      await playChangedRecalc();
      return;
    }
    if (delta !== 0)
      logCash(`${u.name}: condition ${previous} → ${u.condition}`, -delta,
        { kind: "unit_condition", table, name: u.name, from: previous });
    previous = u.condition;
    await playChangedRecalc();
  });
}
/* ------------------------------------------------ rigging tab */
// Per unit-type config. The weapon/mod table names come from rules.js's
// UNIT_ATTACHMENT_TABLES so the engine, the legacy-attachment migration and this
// UI can't drift apart; only the display bits live here.
const RIG_UNIT_CFG = {
  drones: {
    title: "Drones", table: "drones", nameKey: "Drone",
    weaponTables: RULES.UNIT_ATTACHMENT_TABLES.drones.weapons,
    modTable: RULES.UNIT_ATTACHMENT_TABLES.drones.mods,
    capLabel: "Hard points", capOf: r => toInt(r["Hard Point"]),
  },
  vehicles: {
    title: "Vehicles", table: "vehicles", nameKey: "Vehicle",
    weaponTables: RULES.UNIT_ATTACHMENT_TABLES.vehicles.weapons,
    modTable: RULES.UNIT_ATTACHMENT_TABLES.vehicles.mods,
    capLabel: "Weapon cap", capOf: r => Math.floor(toInt(r.Body) / 3),
  },
};
function toInt(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; }

// Scale an ammo value by a multiplier, preserving any non-numeric suffix
// ("40" → "80", "1 missile" → "2 missile", "" → "").
function scaleAmmo(ammo, mult) {
  const m = String(ammo).match(/^(\d+)(.*)$/);
  return m ? (parseInt(m[1], 10) * mult) + m[2] : String(ammo);
}

// A unit mod is either a plain name (unit-scoped, also the legacy shape) or
// {name, weapon: <index>} attached to a specific mounted weapon. These read
// either shape without caring which it is.
const modName = m => (typeof m === "string" ? m : (m && m.name) || "");
const modWeaponIdx = m =>
  (m && typeof m === "object" && Number.isInteger(m.weapon)) ? m.weapon : null;
const modDoublesAmmo = row => !!row && /doubl\w*\s+ammo/i.test(row.ModeEffect || row.Effect || "");

// Remove a mounted weapon and keep weapon-attached mods consistent: drop mods on
// the removed weapon and shift the index of mods attached to later weapons.
function removeUnitWeapon(u, wi, table) {
  u.weapons.splice(wi, 1);
  u.mods = (u.mods || []).reduce((acc, m) => {
    const idx = modWeaponIdx(m);
    if (idx === wi) return acc;
    acc.push(idx != null && idx > wi ? { ...m, weapon: idx - 1 } : m);
    return acc;
  }, []);
  // Firing state is keyed by weapon index too, so close the gap the same way --
  // otherwise the removed gun's magazine and mode are inherited by whichever
  // weapon shifts into its slot.
  const slot = table && (CHAR.play.rigging.units || {})[unitStateKey(table, u)];
  if (slot && slot.guns) {
    const next = {};
    for (const [k, v] of Object.entries(slot.guns)) {
      const idx = +k;
      if (idx === wi) continue;
      next[idx > wi ? idx - 1 : idx] = v;
    }
    slot.guns = next;
  }
  playChangedRecalc();
}

// Flatten a unit's fitted weapons + mods into one attachment list (each with its
// effect) and tally the mod effects that change unit stats. Each name is
// self-classified against the weapon/mod tables, so a mod that slipped into
// u.weapons (older saves) still shows as a mod with the right effect.
function unitAttachments(cfg, unit) {
  const findWeapon = wn => {
    for (const [tk, nc] of cfg.weaponTables) {
      const wr = DATA.tables[tk].find(x => x[nc] === wn);
      if (wr) return wr;
    }
    return null;
  };
  const [mtk, mnc] = cfg.modTable;
  const findMod = mn => DATA.tables[mtk].find(x => x[mnc] === mn) || null;

  const weapons = unit.weapons || [];
  const mods = unit.mods || [];
  // Sort mods into unit-scoped and per-weapon (attached to a mounted weapon).
  // A weapon-scoped mod with no valid target (legacy save) falls back to every
  // weapon, preserving the old "applies to all" behaviour.
  const unitMods = [];
  const weaponMods = weapons.map(() => []);
  for (const m of mods) {
    const nm = modName(m), mr = findMod(nm), idx = modWeaponIdx(m);
    if (idx != null && idx >= 0 && idx < weapons.length) weaponMods[idx].push({ nm, mr });
    else if (mr && mr.Target === "weapon" && weapons.length)
      weapons.forEach((_, wi) => weaponMods[wi].push({ nm, mr }));
    else unitMods.push({ nm, mr });
  }

  const items = [];
  const statMods = { ballistic: 0, impact: 0, hardening: 0, body: 0 };
  // Body deltas can come from a weapon OR a mod (issue #22), so this is tallied
  // across every attachment rather than only unit-scoped mods. An explicit sign
  // is required ("-1 Body") so prose like "Targets make Body test" can't match.
  const tallyBody = text => {
    const m = String(text || "").match(/([+-]\d+)\s*Body/i);
    if (m) statMods.body += toInt(m[1]);
  };
  // Weapons first, each with its attached mods and (if an ammo-doubler is fitted)
  // doubled ammo.
  weapons.forEach((wn, wi) => {
    const wr = findWeapon(wn) || {};
    const doubles = weaponMods[wi].some(x => modDoublesAmmo(x.mr));
    const bits = [];
    if (wr.Damage) bits.push(`DMG ${wr.Damage}`);
    if (wr.Pen && wr.Pen !== "N/A") bits.push(`Pen ${wr.Pen}`);
    if (wr.Ammo) bits.push(`Ammo ${doubles ? scaleAmmo(wr.Ammo, 2) : wr.Ammo}${doubles ? " (×2)" : ""}`);
    const modBits = weaponMods[wi].map(x =>
      x.nm + ((x.mr && (x.mr.ModeEffect || x.mr.Effect)) ? ` (${x.mr.ModeEffect || x.mr.Effect})` : ""));
    items.push({ name: wn, kind: "weapon", stats: bits.join(", "),
      effect: wr.Effect || wr.ModeEffect || "", mods: modBits });
    tallyBody(wr.Effect); tallyBody(wr.ModeEffect);
    weaponMods[wi].forEach(x => x.mr && tallyBody(x.mr.ModeEffect || x.mr.Effect));
  });
  // Unit-scoped mods, tallying the ones that change unit stats.
  for (const { nm, mr } of unitMods) {
    const eff = mr ? (mr.ModeEffect || mr.Effect || "") : "";
    items.push({ name: nm, kind: "mod", stats: "", effect: eff, mods: [] });
    let m;
    if ((m = eff.match(/([+-]?\d+)\s*Ballistic Armor/i))) statMods.ballistic += toInt(m[1]);
    if ((m = eff.match(/([+-]?\d+)\s*Impact Armor/i))) statMods.impact += toInt(m[1]);
    if ((m = eff.match(/([+-]?\d+)\s*(?:Base )?Hardening/i))) statMods.hardening += toInt(m[1]);
    tallyBody(eff);
  }
  // A Speaker's Drone-slot infusion buffs EVERY owned drone, so it folds in here
  // rather than at each call site — that way the Rigging card, the Gear table and
  // the condition tracks (which size themselves from effective Body) all agree.
  // Vehicles are untouched: the column is "Drone".
  const di = (CALC.infusion_mods || {}).drones;
  if (di && cfg.table === "drones") {
    statMods.ballistic += di.ballistic;
    statMods.impact += di.impact;
    statMods.hardening += di.hardening;
    statMods.body += di.body;
    statMods.infusion_move = di.move;
    if (di.ballistic || di.impact || di.hardening || di.body || di.move) {
      items.push({ name: "Spirit infusion", kind: "mod", stats: "",
        effect: [di.ballistic || di.impact ? `+${di.ballistic}B/+${di.impact}I armor` : "",
                 di.hardening ? `+${di.hardening} Hardening` : "",
                 di.body ? `+${di.body} Body` : "",
                 di.move ? `+${di.move}m Movement` : ""].filter(Boolean).join(", "),
        mods: [] });
    }
  }
  return { items, statMods };
}

/* Close the gap in the position-keyed play-state maps after a unit at `removedAt`
   is spliced out of its list: slot n+1 becomes n for every later unit, and the
   now-vacant last slot is dropped. Without this a sold vehicle's damage tracks
   and link flag would be inherited by whatever shifted into its index.
   `newLength` is the list length AFTER the splice. `unit_open` is vestigial (the
   attachment list no longer collapses) but is still shifted so older saves that
   carry the key don't leave stale entries behind. */
function shiftUnitStateDown(table, removedAt, newLength) {
  const rg = CHAR.play.rigging;
  for (const map of [rg.units, rg.linked, rg.active, rg.hotseat, rg.unit_open]) {
    if (!map) continue;
    for (let n = removedAt; n < newLength; n++) {
      const next = map[`${table}:${n + 1}`];
      if (next === undefined) delete map[`${table}:${n}`];
      else map[`${table}:${n}`] = next;
    }
    delete map[`${table}:${newLength}`];
  }
}

/* The three ways a unit can be "out there", all keyed by the same slot:
 *
 *   linked  — riding a VCR link. Limited by the active rig's Links.
 *   active  — deployed WITHOUT a link: it runs itself, costs no link, and its
 *             passive rider (a Shield Drone's dodge reroll, a Bug-Spy's
 *             Observation and Initiative dice) is on the character.
 *   hotseat — the one the player is currently piloting. Its stats belong on the
 *             Overview, above the character's own weapons, because that is what
 *             the player is rolling this round.
 *
 * A linked drone is deployed by definition, so it grants its rider too — the
 * Active box is what a drone running off-link needs to say the same thing.
 */
function rigFlags() {
  const rg = CHAR.play.rigging;
  rg.linked = rg.linked || {};
  rg.active = rg.active || {};
  rg.hotseat = rg.hotseat || {};
  return rg;
}

/* Every unit currently on station, in Rigging-tab order. `onStation` is the
 * linked-or-active test the passive-bonus and summary lists both read. */
function deployedUnits() {
  const rg = rigFlags();
  const out = [];
  [["drones", allDrones()], ["vehicles", allVehicles()]].forEach(([table, list]) => {
    list.forEach((u, i) => {
      const key = `${table}:${i}`;
      const linked = !!rg.linked[key], active = !!rg.active[key];
      // A hotseat flag left over from before the rig was sold reads as empty:
      // you can't be piloting anything without a VCR to jack in with.
      if (linked || active)
        out.push({ table, u, key, linked, active,
          hotseat: !!rg.hotseat[key] && hasVcrRig() });
    });
  });
  return out;
}

/* The passive rider a deployed unit puts on the character, from the data row's
 * Effect column. Free text — reported, never folded into a stat, the same
 * ruling armor Style etiquette bonuses and Blinged vehicles follow. */
function unitPassiveEffect(table, u) {
  const cfg = RIG_UNIT_CFG[table];
  const r = (DATA.tables[table] || []).find(x => x[cfg.nameKey] === u.name) || {};
  return (r.Effect || "").trim();
}

/* Play-state key for a unit's slot in CHAR.play.rigging.units. Keyed by list
   position, matching the `${cfg.table}:${i}` convention the Rigging tab uses. */
/* Damage/state for one drone or vehicle, keyed by its position in the joined
 * chargen-then-play list — the same index CALC uses. Play purchases append, so
 * a chargen unit's key never moves and existing saves keep their state. */
function unitStateKey(table, unit) {
  return `${table}:${allUnits(table).indexOf(unit)}`;
}

/* A deck's Hardening with its mods folded in, saying so when they moved it.
 * Shared by both UIs through RULES.deckHardening so chargen and play agree. */
function deckHardeningBit(entry, row) {
  const total = RULES.deckHardening(entry, DATA.tables);
  const base = RULES.hardeningOf(row);
  return total === base ? String(total) : `${total} (${base} +${total - base} mods)`;
}

/* A unit's Hardening: whatever its data row states (drones and vehicles carry
 * no such column today, so 0) plus anything a fitted mod or a Drone-slot spirit
 * infusion adds. Reported everywhere a unit's stats are, including at 0 — a
 * blank read as "this stat doesn't exist here" (issue #33).
 *
 * `key` identifies the unit ("drones:2") so the rig's own hardening mods can be
 * included for the units it's actually flying. Callers that don't know or care
 * which unit this is simply leave it out and get the unit's own figure. */
function unitHardening(row, statMods, key) {
  return RULES.hardeningOf(row) + toInt((statMods || {}).hardening)
    + (key ? rigHardeningFor(key) : 0);
}

/* What the equipped rig's mods add to one unit's Hardening.
 *
 * Only linked units: the bonus rides the VCR link ("+1 Vehicle/Drone
 * Hardening"), so a drone running loose on its own autopilot doesn't get it,
 * and neither does one sitting in the garage. Before this the number was added
 * to the RIG's hardening, which protects the thing in your skull rather than
 * the thing downrange (#44). */
function rigHardeningFor(key) {
  if (!CHAR.finalized) return 0;          // links are play state
  const rg = rigFlags();
  if (!rg.linked || !rg.linked[key]) return 0;
  // allRigs(), NOT CHAR.rigs. Past Finalize the character's own `rigs` array is
  // the frozen chargen record; what the character is actually carrying lives in
  // play.kit (plus play purchases), which is what allRigs() joins. A mod fitted
  // to a rig during play only ever exists on the kit copy, so reading CHAR here
  // saw the rig as it was BUILT and missed the hardening entirely — the exact
  // trap play.kit exists to make visible. Only the rigs are swapped; the play
  // state that names the equipped one is read from CHAR.play as before.
  return RULES.rigUnitHardening({ rigs: allRigs(), play: CHAR.play }, DATA.tables);
}

/* Effective Body after any weapon/mod deltas — the box count for both condition
   tracks (issue #22). Never below 0; a wrecked chassis still has zero boxes
   rather than a negative track. */
function unitEffectiveBody(cfg, unit) {
  const r = DATA.tables[cfg.table].find(x => x[cfg.nameKey] === unit.name) || {};
  const { statMods } = unitAttachments(cfg, unit);
  return Math.max(0, toInt(r.Body) + statMods.body);
}

/* Per-box repair price for a unit's Physical Condition Track: 1/100th of the
   chassis base price (the table's face Cost — no heritage surcharge). */
function unitRepairCostPerBox(cfg, unit) {
  const r = DATA.tables[cfg.table].find(x => x[cfg.nameKey] === unit.name) || {};
  return Math.round((+r.Cost || 0) / 100);
}

/* The two damage tracks for one unit. `st` is the unit's play-state slot
   (rg.units[key]). Physical damage costs cash to repair; Integrity clears free.
   Rendered as a counter + proportional bar rather than the character sheet's
   box grid: vehicle Body reaches 48, which would be 96 clickable boxes and
   ~500px per unit. A counter is constant height at any Body, and typing "37"
   beats hunting for the 37th box. */
function unitConditionTracks(cfg, unit, st, label) {
  // A shared character is read-only: show both tracks, but no marking, no
  // repairing and no cash movement.
  const ro = !!(activeTabObj() && activeTabObj().readonly);
  const max = unitEffectiveBody(cfg, unit);
  st.physical = Math.min(Math.max(0, toInt(st.physical)), max);
  st.integrity = Math.min(Math.max(0, toInt(st.integrity)), max);
  const perBox = unitRepairCostPerBox(cfg, unit);
  const wrap = el("div", { class: "sh-unit-tracks" });
  if (!max) {
    wrap.append(el("p", { class: "hint" },
      "No condition boxes — this chassis has no effective Body."));
    return wrap;
  }

  /* One track: label, counter, "n / max", a proportional fill bar, and whatever
     repair control the track uses. `kind` picks the colour (physical / integrity). */
  const track = (kind, labelText, get, set, note, controls) => {
    const countText = el("span", { class: "sub sh-track-count" }, `${get()} / ${max}`);
    const fill = el("div", { class: `sh-bar-fill ${kind}`,
      style: `width:${max ? (get() / max) * 100 : 0}%` });
    const bar = el("div", { class: "sh-bar", role: "img",
      "aria-label": `${label} ${labelText.toLowerCase()} ${get()} of ${max}` }, fill);
    // miniCounter renders its own label and calls playChanged() itself, so pass
    // an empty one (the coloured label above is ours) and leave the setter pure
    // — matching the Damage / Inertia counters on the same row.
    const counter = ro ? null : miniCounter("", get, v => { set(v); }, 0, max);
    return el("div", { class: "sh-track" },
      el("div", { class: "sh-track-head" },
        el("span", { class: kind === "physical" ? "phys-lbl" : "stun-lbl" }, labelText),
        counter, countText,
        el("span", { class: "sub" }, `· ${note}`)),
      bar,
      ro ? null : controls);
  };

  // --- Physical Condition Track: repaired for cash, per box.
  const repairQty = el("input", { type: "number", min: "1", max: String(max),
    value: "1", class: "sv-edit", style: "width:56px",
    title: "How many boxes to repair" });
  const repairPrice = el("span", { class: "sub" }, "");
  const priceFor = n => `→ ${fmt(Math.max(0, Math.min(st.physical, n || 0)) * perBox)}`;
  const syncPrice = () => {
    repairPrice.textContent = st.physical ? priceFor(parseInt(repairQty.value, 10)) : "";
  };
  repairQty.addEventListener("input", syncPrice);
  syncPrice();
  const repairBtn = el("button", { class: "btn small",
    disabled: st.physical ? null : "1",
    title: st.physical ? `Repair at ${fmt(perBox)} per box` : "No damage to repair",
    onclick: () => {
      const want = Math.max(1, Math.min(st.physical, parseInt(repairQty.value, 10) || 1));
      const cost = want * perBox;
      if (CHAR.play.cash < cost
          && !confirm(`Repairing ${want} box(es) costs ${fmt(cost)} but you have ${fmt(CHAR.play.cash)}. Overdraw?`))
        return;
      st.physical -= want;
      logCash(`Repaired ${want} Physical Condition box(es) on ${label}`, -cost);
      playChangedRecalc();
    } }, "Repair");
  const repairAllBtn = el("button", { class: "btn small",
    disabled: st.physical ? null : "1",
    title: st.physical ? `Repair all ${st.physical} — ${fmt(st.physical * perBox)}` : "No damage to repair",
    onclick: () => {
      const want = st.physical, cost = want * perBox;
      if (CHAR.play.cash < cost
          && !confirm(`Full repair costs ${fmt(cost)} but you have ${fmt(CHAR.play.cash)}. Overdraw?`))
        return;
      st.physical = 0;
      logCash(`Repaired ${want} Physical Condition box(es) on ${label}`, -cost);
      playChangedRecalc();
    } }, "Repair all");
  wrap.append(track("physical", "PHYSICAL CONDITION",
    () => st.physical, v => { st.physical = v; },
    `${fmt(perBox)} per box to repair`,
    el("div", { class: "add-row" }, repairQty, repairBtn, repairPrice, repairAllBtn)));

  // --- Vehicle Integrity Track: same size, free to clear.
  wrap.append(track("integrity", "VEHICLE INTEGRITY",
    () => st.integrity, v => { st.integrity = v; }, "free to repair",
    el("div", { class: "add-row" },
      el("button", { class: "btn small", disabled: st.integrity ? null : "1",
        title: "Clear the whole Integrity track (no cost)",
        onclick: () => { st.integrity = 0; playChangedRecalc(); } }, "Clear all"))));
  return wrap;
}

/* Unit | Stats | Attachments table for drones/vehicles. Shared by the Rigging
   tab (units on station) and the Gear tab (everything owned) so the two never
   drift -- issue #20 was the Gear tab showing only a name and a type. `entries`
   are {table, u} pairs, where table keys RIG_UNIT_CFG.

   `mode` picks the per-row toggle, because the two callers ask different
   questions. The Gear tab is an inventory: "Carried". The on-station list is
   about what you're flying right now: "Hotseat" — carrying a drone you have
   deployed says nothing, and the box that matters there is which one you're in.
   `mode: "station"` also labels how each unit is out (VCR link or Active). */
function unitLoadoutTable(entries, mode = "inventory") {
  const t = el("table");
  t.append(el("tr", {}, el("th", {}, "Unit"), el("th", {}, "Stats"),
    el("th", {}, "Weapons & mods")));
  entries.forEach(({ table, u }) => {
    const cfg = RIG_UNIT_CFG[table];
    const r = DATA.tables[table].find(x => x[cfg.nameKey] === u.name) || {};
    const { items, statMods } = unitAttachments(cfg, u);
    // Hoisted from further down: the stats line below needs it to ask whether
    // this unit is on the rig's link.
    const key = unitStateKey(table, u);
    // Mods can raise armor/hardening — reflect the boosted values here.
    const ball = toInt(r.Ballistic) + statMods.ballistic;
    const imp = toInt(r.Impact) + statMods.impact;
    const body = Math.max(0, toInt(r.Body) + statMods.body);
    const stats = `Move ${r.Move}`
      + (statMods.infusion_move ? ` +${statMods.infusion_move}m (infusion)` : "")
      + ` · Handling ${r.Handling} · Body ${body}`
      + (statMods.body ? ` (base ${r.Body})` : "")
      + ((ball || imp) ? ` · ${ball}B/${imp}I` : "")
      // Hardening always prints, even at 0. Drones and vehicles carry no base
      // Hardening in the data — it only arrives from a fitted mod or a drone
      // infusion — and hiding the zero made the stat look missing rather than
      // absent (issue #33).
      + ` · Hardening ${unitHardening(r, statMods, key)}`
      + ` · ${cfg.capLabel} ${cfg.capOf(r)}`
      // A condition carrying a gameplay rider (Blinged) reports it here; it is
      // never applied to a stat.
      + (u.condition && RULES.VEHICLE_CONDITION_EFFECTS[u.condition]
          ? ` · ${u.condition}: ${RULES.VEHICLE_CONDITION_EFFECTS[u.condition]}` : "");
    // Damage read-out, so the Gear inventory reflects it too (the interactive
    // tracks live on the Rigging tab).
    const dst = (CHAR.play.rigging.units || {})[unitStateKey(table, u)] || {};
    const dmgLine = body
      ? `Physical ${Math.min(toInt(dst.physical), body)} / ${body}`
        + ` · Integrity ${Math.min(toInt(dst.integrity), body)} / ${body}`
      : "";
    const attachCell = items.length
      ? el("div", {}, ...items.map(it => el("div", { class: "sub", style: "margin:2px 0" },
          el("b", {}, it.name),
          it.kind === "mod" ? el("span", { class: "sh-tag", style: "margin-left:6px" }, "mod") : null,
          it.stats ? ` — ${it.stats}` : "",
          it.effect ? el("span", { style: "color:var(--manon)" },
            `${it.stats ? " · " : " — "}${it.effect}`) : null,
          ...((it.mods && it.mods.length)
            ? [el("div", { style: "margin-left:14px;color:var(--manon)" }, "↳ " + it.mods.join(" · "))]
            : []))))
      : "—";
    const station = mode === "station";
    const rg = station ? rigFlags() : null;
    t.append(el("tr", {},
      el("td", {}, el("b", {}, u.label || u.name),
        u.label ? el("div", { class: "sub" }, u.name) : null,
        el("div", { class: "sub" }, cfg.title.replace(/s$/, "")),
        station
          ? el("div", {},
              el("div", { class: "sub" },
                rg.linked[key] ? "VCR link" : null,
                (rg.linked[key] && rg.active[key]) ? " · " : null,
                rg.active[key] ? "Active" : null),
              shHotseatToggle(key, u))
          : shCarriedToggle(u)),
      el("td", { class: "sub" }, stats,
        dmgLine ? el("div", { class: "sh-unit-dmg" }, dmgLine) : null),
      el("td", {}, attachCell)));
  });
  return t;
}

function shRigging(body) {
  const rg = rigFlags();
  // The small-heritage surcharge applies to vehicles (below, via unitBlock) but
  // not to VCRs/rigs or drones — those pay face value.
  const base = CALC.budget.gear_cost_multiplier || 1;
  const rigMult = RULES.surchargeFor("rig", base);
  const rigEntries = ownedRigs();
  const rigs = rigEntries.map(e => e.ref);
  if (rigs.length && !rigs.some(r => r.name === rg.active_rig))
    rg.active_rig = rigs[0].name;

  const activeRig = rigs.find(r => r.name === rg.active_rig);
  const linkLimit = activeRig ? RULES.rigStats(activeRig, DATA.tables).links : 0;
  const linkedCount = () => Object.values(rg.linked).filter(Boolean).length;
  // All "buy new unit" browsers collect here and render at the bottom.
  const rigBuySection = el("div", { class: "card sh-card", id: "rig-buy" },
    el("h3", {}, "Buy rigs, drones & vehicles"),
    el("p", { class: "hint" }, "New units are purchased here; configure owned ones above."));

  // --- VCRs
  const rigCard = el("div", { class: "card sh-card" }, el("h3", {}, "Vehicle Control Rigs"));
  rigEntries.forEach((en, ri) => {
    const { ref: r, arr: rigArr, i: rigIndex, inPlay, category } = en;
    const st = RULES.rigStats(r, DATA.tables);
    const isActive = r.name === rg.active_rig;
    const modSub = sublistOf(en, "mods");
    const rigModCost = name => Math.round(
      (+(DATA.tables.rig_mods.find(m => m["Rig Mod"] === name) || {}).Cost || 0) * rigMult);
    const modEditor = fittedCategoryEditor({
      id: `sh-rmods-${ri}-${r.name}`,
      items: modSub.items,
      groups: modGroups(DATA.tables.rig_mods, "Rig Mod", null, "Rig Mods"),
      onAdd: name => {
        const cost = rigModCost(name);
        if (CHAR.play.cash < cost
            && !confirm(`${name} costs ${fmt(cost)} but you have ${fmt(CHAR.play.cash)}. Overdraw?`)) return;
        modSub.add(name);
        logCash(`Fitted ${name} to ${r.name}`, -cost,
          { kind: "rig_mod", host: r.name, name });
      },
      onRemove: index => disposeOfMod({ entry: en, list: "mods", index,
        name: sublistName(modSub.items[index]), hostName: r.name,
        value: rigModCost(sublistName(modSub.items[index])) }),
      effectOf: name => (DATA.tables.rig_mods.find(m => m["Rig Mod"] === name) || {}).Effect || "",
      rerender: renderSheet, afterAdd: () => playChangedRecalc(),
    });
    rigCard.append(el("div", { class: "sh-unit" },
      el("div", {},
        el("div", { class: "sh-advrow" + (isActive ? " active-row" : ""), style: "border:0;padding:0" },
          el("span", {}, el("b", {}, r.name),
            el("span", { class: "sub" },
              ` +${st.bonusDice}d · Hardening ${st.hardening >= 0 ? "+" : ""}${st.hardening} · Links ${st.links} · Cores ${st.cores}`
              // What the rig's mods hand its linked units, stated on the rig
              // because that's where you fitted them — but it lands on the
              // drones, not here (#44).
              + (st.unit_hardening
                  ? ` · +${st.unit_hardening} Hardening to linked units` : ""))),
          isActive ? el("span", { class: "chip ok" }, "Active VCR")
            : counterBtn("Set Active", () => { rg.active_rig = r.name; playChanged(); })),
        el("div", { class: "sh-unit-add" }, el("b", {}, "Mods"), modEditor)),
      el("button", { class: "row-del", title: "Sell / remove VCR",
        onclick: async () => {
          const row = DATA.tables.rigs.find(x => x["Rig Type"] === r.name) || {};
          // (#81) Fitted rig mods refund in full; only the VCR itself is scaled.
          const fitted = flatFittedValue(r.mods, [["rig_mods", "Rig Mod"]], rigMult);
          if (!await disposeOfItem({ category, arr: rigArr, index: rigIndex, inPlay,
            name: r.name, value: Math.round((+row.Cost || 0) * rigMult) + fitted,
            modsValue: fitted })) return;
          if (rg.active_rig === r.name) rg.active_rig = "";
          await playChangedRecalc();
        } }, "✕")));
  });
  if (rigs.length)
    rigCard.append(el("p", { class: "hint" },
      `Active VCR links ${linkedCount()} / ${linkLimit} units.`));
  else
    rigCard.append(el("p", { class: "hint" }, "No rigs owned — drones are piloted unlinked."));
  // buy a new VCR in play
  const rigGroups = [{ label: "Vehicle Control Rigs", items: DATA.tables.rigs.map(x => ({
    name: x["Rig Type"], cost: Math.round((+x.Cost || 0) * rigMult),
    sub: `+${x["Bonus Dice"]}d · Links ${x.Links} · Cores ${x.Cores}` })) }];
  rigBuySection.append(el("div", { class: "sh-unit-add" }, el("b", {}, "Buy VCR"),
    categoryBrowser({ id: "buy-rigs", groups: rigGroups,
      rerender: renderSheet, afterAdd: () => playChangedRecalc(),
      onAdd: name => {
        const row = DATA.tables.rigs.find(x => x["Rig Type"] === name) || {};
        const cost = Math.round((+row.Cost || 0) * rigMult);
        if (CHAR.play.cash < cost
            && !confirm(`${name} costs ${fmt(cost)} but you have ${fmt(CHAR.play.cash)}. Overdraw?`)) return;
        CHAR.play.purchases.rigs.push({ name, mods: [] });
        logCash(`Bought ${name}`, -cost, { kind: "rig", name });
      } })));
  body.append(rigCard);

  // On-station summary: everything riding a VCR link OR running Active.
  // Link keys index the joined list, the same one unitStateKey uses.
  const activeUnits = deployedUnits();
  if (activeUnits.length) {
    body.append(el("div", { class: "card sh-card" },
      el("h3", {}, "Active drones & vehicles"),
      el("p", { class: "hint" },
        "Anything on a VCR link or ticked Active. Hotseat marks the one you're "
        + "piloting — its stats move to the Overview, above your own weapons."),
      unitLoadoutTable(activeUnits, "station")));
  }

  /* `entries` is the joined chargen-then-play list from ownedSplit, so `i` is
     the combined index every play-state key uses and `arr`/`localIndex` is
     where the unit actually lives. New units are always bought into
     play.purchases — the chargen record is closed once Finalize is pressed. */
  const unitBlock = (cfg, entries, calcArr) => {
    const list = entries.map(e => e.ref);
    // Only a vehicle's base chassis carries the small-heritage surcharge; fitted
    // weapons/mods (and everything on a drone) pay face value.
    const baseMult = cfg.table === "vehicles" ? RULES.surchargeFor("vehicle", base) : 1;
    const mult = 1;   // fitted weapons & mods — never surcharged
    const unitReadonly = !!(activeTabObj() && activeTabObj().readonly);
    const card = el("div", { class: "card sh-card" }, el("h3", {}, cfg.title));
    entries.forEach((en, i) => {
      const { arr: unitArr, i: localIndex, inPlay, category } = en;
      // The unit is play's own copy, so reads and writes are the same object.
      const u = en.ref;
      const edit = () => u;
      const r = DATA.tables[cfg.table].find(x => x[cfg.nameKey] === u.name) || {};
      const summary = (calcArr || [])[i] || {};
      const key = `${cfg.table}:${i}`;
      const st = rg.units[key] = rg.units[key] || { inertia: 0, physical: 0, integrity: 0 };
      u.weapons = u.weapons || []; u.mods = u.mods || [];

      // Editable custom name. `type: "text"` matters -- the global input styling
      // is keyed on input[type=text], which a bare <input> does not match, so
      // without it this fell through to the browser's white default box.
      const nameInput = el("input", { type: "text", class: "sh-unit-name",
        value: u.label || "", placeholder: u.name,
        title: `Rename this ${cfg.title.replace(/s$/, "").toLowerCase()} (blank uses "${u.name}")`,
        onchange: e => { u.label = e.target.value.trim(); playChanged(); } });

      const findWeapon = wn => {
        for (const [tk, nc] of cfg.weaponTables) {
          const wr = DATA.tables[tk].find(x => x[nc] === wn);
          if (wr) return wr;
        }
        return null;
      };
      const [mtk, mnc] = cfg.modTable;
      const findMod = mn => DATA.tables[mtk].find(x => x[mnc] === mn) || null;
      const weaponScopedMods = DATA.tables[mtk].filter(x => x.Target === "weapon");
      const unitScopedMods = DATA.tables[mtk].filter(x => x.Target !== "weapon");
      const buyMod = (name, targetLabel) => {
        const mr = findMod(name) || {};
        const cost = Math.round((+mr.Cost || 0) * mult);
        if (CHAR.play.cash < cost
            && !confirm(`${name} costs ${fmt(cost)} but you have ${fmt(CHAR.play.cash)}. Overdraw?`)) return false;
        logCash(`Fitted ${name} to ${targetLabel}`, -cost);
        return true;
      };
      // Classify existing mods: those attached to a weapon vs unit-scoped (which
      // also catches legacy untargeted mods so they stay removable).
      const weaponModIdx = u.weapons.map(() => []);
      const unitModIdx = [];
      u.mods.forEach((m, mi) => {
        const wi = modWeaponIdx(m);
        if (wi != null && wi >= 0 && wi < u.weapons.length) weaponModIdx[wi].push(mi);
        else unitModIdx.push(mi);
      });

      // fitted weapons — each shows its stats, effect, its attached weapon-mods
      // (with removal), doubled ammo when an ammo-mod is attached, and a picker
      // for weapon-scoped mods bound to that specific weapon.
      const weaponRows = u.weapons.map((wn, wi) => {
        const wr = findWeapon(wn) || {};
        const doubles = weaponModIdx[wi].some(mi => modDoublesAmmo(findMod(modName(u.mods[mi]))));
        const effect = wr.Effect || wr.ModeEffect || "";
        const modChips = weaponModIdx[wi].map(mi => {
          const nm = modName(u.mods[mi]);
          return el("span", { class: "chip", style: "margin:2px 4px 0 0;cursor:pointer",
            title: "Sell or remove mod",
            onclick: () => disposeOfUnitMod(en, mi, nm, wn,
              Math.round((+(findMod(nm) || {}).Cost || 0) * mult)) },
            nm + " ✕");
        });
        const addWeaponMod = weaponScopedMods.length ? fittedCategoryEditor({
          id: `rig-wm-${key}-${wi}`, items: [],
          groups: modGroups(weaponScopedMods, mnc, null, "Weapon mods"),
          onAdd: name => { if (buyMod(name, wn)) edit().mods.push({ name, weapon: wi }); },
          onRemove: () => {}, rerender: renderSheet, afterAdd: () => playChangedRecalc(),
        }) : null;
        // Energy mounts run on Heat and carry no Modes/Ammo columns at all.
        const isEnergy = wr["Heat Limit"] !== undefined || wr.Heat !== undefined;
        // The loaded round shifts what the mount actually puts downrange --
        // resolved before the fire controls, which need it for the magazine
        // and the firing modes it leaves the mount (#86).
        const uAmmo = isEnergy ? { row: null, name: "", mods: RULES.ammoStatMods(""), notes: [] }
                               : unitLoadedAmmo(cfg.table, u, wi, wn);
        const fireCtl = unitGunControls(cfg.table, u, wi, wn, wr, isEnergy,
          uAmmo.row ? uAmmo.mods : null);
        // The round adjusts the magazine before the ammo-mod doubles it: the
        // mount holds however many of THESE rounds, twice over.
        const uMag = uAmmo.row
          ? (RULES.applyAmmoToRow({ Ammo: wr.Ammo }, wr, uAmmo.mods).Ammo ?? wr.Ammo)
          : wr.Ammo;
        const ammo = uMag ? (doubles ? `${scaleAmmo(uMag, 2)} (×2)` : uMag) : "";
        const uBase = { acc: wr.Accuracy || 0, damage: wr.Damage || "—", pen: wr.Pen || 0 };
        const uShot = uAmmo.row ? RULES.applyAmmoStats(uBase, uAmmo.mods) : uBase;
        const uBit = (label, key) => el("span",
          (uAmmo.row && String(uShot[key]) !== String(uBase[key]))
            ? { class: "wpn-ammo-mod", title: `${uAmmo.name} loaded` } : {},
          `${label} ${uShot[key]}`);
        return el("div", { class: "sub", style: "margin:4px 0" },
          el("span", { class: "chip", style: "cursor:pointer", title: "Sell or remove weapon",
            onclick: async () => {
              const result = await promptDisposal(wn,
                Math.round((+(findWeapon(wn) || {}).Cost || 0) * mult));
              if (!result) return;
              removeUnitWeapon(edit(), wi, cfg.table);
              logCash(`${result.sold ? "Sold" : "Lost"} ${wn} (off ${u.label || u.name})`,
                result.sold ? result.amount : 0);
              await playChangedRecalc();
            } }, wn + " ✕"),
          " ", uBit("DMG", "damage"), " · ", uBit("Acc", "acc"),
          (ammo ? ` · Mag ${ammo}` : ""),
          wr.Pen ? el("span", {}, " · ") : null, wr.Pen ? uBit("Pen", "pen") : null,
          fireCtl,
          uAmmo.notes.length
            ? el("div", { class: "sub wpn-ammo-note", style: "margin-left:4px" },
                `${uAmmo.name}: ${uAmmo.notes.join(" · ")}`) : null,
          effect ? el("div", { class: "sub", style: "margin:2px 0 0 4px;color:var(--manon)" }, effect) : null,
          modChips.length ? el("div", { style: "margin:2px 0 0 4px" }, ...modChips) : null,
          addWeaponMod ? el("div", { class: "sub", style: "margin:2px 0 0 4px" },
            el("b", {}, "Weapon mod "), addWeaponMod) : null);
      });

      // unit-scoped mods (armor, hardening, …)
      const modRows = unitModIdx.map(mi => {
        const nm = modName(u.mods[mi]);
        const mr = findMod(nm) || {};
        const effect = mr.Effect || mr.ModeEffect || "";
        return el("div", { class: "sub" },
          el("span", { class: "chip", style: "margin:2px 4px 0 0;cursor:pointer",
            title: "Sell or remove mod",
            onclick: () => disposeOfUnitMod(en, mi, nm, u.label || u.name,
              Math.round((+mr.Cost || 0) * mult)) }, nm + " ✕"),
          effect ? el("span", { style: "color:var(--manon)" }, effect) : null);
      });

      // add-weapon picker (nested by weapon table)
      const weaponGroups = cfg.weaponTables.map(([tk, nc]) => ({
        label: nc.replace(cfg.nameKey, "").trim() || nc,
        items: DATA.tables[tk].map(x => ({ name: x[nc], cost: Math.round((+x.Cost || 0) * mult),
          sub: `DMG ${x.Damage || "—"}${x.Ammo ? " · Ammo " + x.Ammo : ""}`
            + ((x.Effect || x.ModeEffect) ? " · " + (x.Effect || x.ModeEffect) : "") })),
      }));
      const addWeapon = fittedCategoryEditor({
        id: `rig-w-${key}`, items: [], groups: weaponGroups,
        onAdd: name => {
          const wr = findWeapon(name) || {};
          const cost = Math.round((+wr.Cost || 0) * mult);
          if (CHAR.play.cash < cost
              && !confirm(`${name} costs ${fmt(cost)} but you have ${fmt(CHAR.play.cash)}. Overdraw?`)) return;
          edit().weapons.push(name);
          logCash(`Mounted ${name} on ${u.label || u.name}`, -cost);
        },
        onRemove: () => {}, rerender: renderSheet, afterAdd: () => playChangedRecalc(),
      });
      // unit-level add-mod picker (unit-scoped mods only; weapon mods are added
      // per-weapon above)
      const addMod = fittedCategoryEditor({
        id: `rig-m-${key}`, items: [],
        groups: modGroups(unitScopedMods, mnc, null, `${cfg.nameKey} Mods`),
        onAdd: name => { if (buyMod(name, u.label || u.name)) edit().mods.push(name); },
        onRemove: () => {}, rerender: renderSheet, afterAdd: () => playChangedRecalc(),
      });

      // link-to-VCR toggle (capped at the active VCR's links)
      const isLinked = !!rg.linked[key];
      const linkToggle = el("label", { class: "opt" },
        el("input", { type: "checkbox", ...(isLinked ? { checked: 1 } : {}),
          disabled: (!activeRig || (!isLinked && linkedCount() >= linkLimit)) ? "1" : null,
          onchange: e => {
            if (e.target.checked && linkedCount() >= linkLimit) {
              alert(`Active VCR links only ${linkLimit} unit(s).`); e.target.checked = false; return;
            }
            rg.linked[key] = e.target.checked; playChanged();
            renderSheet();       // the on-station list and Overview both follow this
          } }),
        el("span", {}, isLinked ? "Linked to VCR" : "Link to VCR"));
      // Running off-link. Costs no VCR link and takes no rig, but the drone is
      // out there, so its passive rider is on the character. Drones only —
      // a vehicle nobody is driving isn't doing anything for you.
      const isActive = !!rg.active[key];
      const passive = unitPassiveEffect(cfg.table, u);
      const activeToggle = cfg.table === "drones" ? el("label", { class: "opt",
          title: passive ? `Deployed off-link — grants: ${passive}`
                         : "Deployed off-link (this drone has no passive effect of its own)" },
        el("input", { type: "checkbox", ...(isActive ? { checked: 1 } : {}),
          onchange: e => {
            rg.active[key] = e.target.checked; playChanged();
            renderSheet();
          } }),
        el("span", {}, "Active")) : null;

      // Weapons + mods live in their own column (below), so they're always
      // visible alongside the condition tracks instead of collapsed.
      const wCount = u.weapons.length, mCount = u.mods.length;
      const attachments = el("div", { class: "sh-unit-attach" },
        el("div", { class: "sh-attach-head" },
          `Weapons & mods (${wCount} weapon${wCount === 1 ? "" : "s"}, ${mCount} mod${mCount === 1 ? "" : "s"})`),
        weaponRows.length ? el("div", {}, ...weaponRows) : null,
        modRows.length ? el("div", { class: "sub" }, el("b", {}, "Mods:"), ...modRows) : null,
        (!weaponRows.length && !modRows.length)
          ? el("p", { class: "hint" }, "Nothing fitted yet.") : null,
        el("div", { class: "sh-unit-add" },
          el("div", { class: "sub" }, el("b", {}, "Add weapon"), addWeapon),
          el("div", { class: "sub" }, el("b", {}, "Add unit mod"), addMod)));

      const removeBtn = el("button", { class: "row-del", title: "Sell / remove unit",
        onclick: async () => {
          // The unit's own resale value uses the unit multiplier, not the
          // fitted-weapon `mult` (which is deliberately 1 in this scope).
          //
          // (#81) Everything on the hardpoints goes with the chassis, so it all
          // refunds in full: unit mods AND fitted weapons. The weapons are in a
          // separate list from the mods, but the reporter's rationale is the
          // same for both — they were bought with cash, the app has no way to
          // own one apart from the unit it is bolted to, and a chassis's
          // condition is no reason to discount the autocannon on its roof.
          const fitted =
            flatFittedValue(u.mods, [cfg.modTable], mult)
            + flatFittedValue(u.weapons, cfg.weaponTables, mult);
          if (!await disposeOfItem({ category, arr: unitArr, index: localIndex, inPlay,
            name: u.label || u.name, value: Math.round((+r.Cost || 0) * baseMult) + fitted,
            modsValue: fitted })) return;
          // Per-unit play state is keyed by position in the JOINED list, so
          // losing a unit has to shift every later unit's slot down — otherwise
          // its damage tracks (and the linked flag) land on the wrong vehicle.
          // `entries.length - 1` is that list's length once this one is gone.
          shiftUnitStateDown(cfg.table, i, entries.length - 1);
          await playChangedRecalc();
        } }, "✕");

      card.append(el("div", { class: "sh-unit" },
        el("div", { class: "sh-unit-main" },
          el("div", { class: "sh-unit-title" }, nameInput, removeBtn),
          el("div", { class: "sub" }, el("b", {}, u.name), " · ",
            (() => {
              // Move moved out to its own box beside Inertia — it's the stat you
              // reach for constantly in a chase, so it shouldn't be buried here.
              const sm = unitAttachments(cfg, u).statMods;
              const ball = toInt(r.Ballistic) + sm.ballistic, imp = toInt(r.Impact) + sm.impact;
              const eBody = Math.max(0, toInt(r.Body) + sm.body);
              return `Handling ${r.Handling} · Body ${eBody}`
                + (sm.body ? ` (base ${r.Body})` : "")
                + ((ball || imp) ? ` · Armor ${ball}B/${imp}I` : "")
                // `key` (this unit's slot in the joined list) is what lets the
                // equipped rig's hardening mods reach a linked unit. Omitting
                // it here meant the Rigging tab — the one screen a rigger
                // actually reads a drone's stats on — silently showed the
                // unmodified figure while the Overview and Gear tab showed the
                // boosted one (#44).
                + ` · Hardening ${unitHardening(r, sm, key)}`
                + ` · weapons ${summary.weapon_count ?? u.weapons.length}/${summary.weapon_cap ?? cfg.capOf(r)}`;
            })()),
          r.Effect ? el("div", { class: "sub", style: "color:var(--manon)" }, r.Effect) : null,
          unitConditionSelect(u, cfg.table, +r.Cost || 0, baseMult),
          // Physical Condition + Vehicle Integrity tracks (issue #22), then
          // Inertia sitting with them. Inertia is a free-form tally the engine
          // never reads — it's a place to note momentum during a chase. The old
          // Damage counter alongside it was retired: it duplicated the Physical
          // Condition track but was uncapped and equally inert.
          unitConditionTracks(cfg, u, st, u.label || u.name),
          el("div", { class: "sh-unit-ctr sh-unit-inertia" },
            // Move gets its own tile: it's read constantly during a chase, and
            // it's derived (base + any Drone-infusion bonus) so it's a readout,
            // not a counter.
            (() => {
              const bonus = unitAttachments(cfg, u).statMods.infusion_move || 0;
              const base = String(r.Move || "0");
              const num = parseInt(base, 10);
              const unit = base.replace(/^\d+\s*/, "") || "m";
              return el("div", { class: "sh-unit-stat" + (bonus ? " boosted" : ""),
                title: bonus ? `${base} base +${bonus}m from a spirit infusion` : "Movement rate" },
                el("span", { class: "lbl" }, "Move"),
                el("b", {}, Number.isFinite(num) ? `${num + bonus}${unit}` : base),
                bonus ? el("span", { class: "delta" }, `+${bonus}`) : null);
            })(),
            unitReadonly
              // Read-only shares report the value but can't edit it, matching
              // the condition tracks above.
              ? el("span", { class: "sub" }, `Inertia ${toInt(st.inertia)}`)
              : miniCounter("Inertia", () => st.inertia, v => { st.inertia = v; })),
          // No effect text beside the box: the unit's own stat line above
          // already carries it, and printing it twice on one row is the noise
          // the armor rows were just cleaned up for. The tooltip says it.
          activeRig ? linkToggle : null,
          activeToggle),
        attachments));
    });
    if (!entries.length) card.append(el("p", { class: "hint" }, `No ${cfg.title.toLowerCase()} owned.`));
    body.append(card);

    // buy a new unit — rendered in the bottom Buy section
    const buyGroups = [{ label: cfg.title, items: DATA.tables[cfg.table].map(x => ({
      name: x[cfg.nameKey], cost: Math.round((+x.Cost || 0) * baseMult),
      sub: `Body ${x.Body} · Move ${x.Move} · Handling ${x.Handling}` })) }];
    rigBuySection.append(el("div", { class: "sh-unit-add" }, el("b", {}, `Buy new ${cfg.title.toLowerCase().replace(/s$/, "")}`),
      categoryBrowser({ id: `buy-${cfg.table}`, groups: buyGroups,
        rerender: renderSheet, afterAdd: () => playChangedRecalc(),
        onAdd: async name => {
          const row = DATA.tables[cfg.table].find(x => x[cfg.nameKey] === name) || {};
          const base = +row.Cost || 0;
          // Condition SCALES the base chassis price (it does not add a
          // surcharge the way armor Quality does), matching priceFittedVehicle.
          const priceOf = st => Math.round(
            base * (RULES.VEHICLE_CONDITION_FACTORS[st.condition] ?? 1) * baseMult);
          const chosen = await buyDialog({
            title: `Buy ${name}`,
            sub: `Body ${row.Body} · Move ${row.Move} · Handling ${row.Handling}`,
            fields: [{ key: "condition", label: "Condition", type: "select",
              options: RULES.VEHICLE_CONDITIONS.map(c => ({ value: c,
                label: `${c} (×${RULES.VEHICLE_CONDITION_FACTORS[c]})`
                  + (RULES.VEHICLE_CONDITION_EFFECTS[c] ? ` — ${RULES.VEHICLE_CONDITION_EFFECTS[c]}` : "") })),
              initial: "Pristine" }],
            priceOf,
          });
          if (!chosen) return;
          CHAR.play.purchases[cfg.table].push({ name, condition: chosen.condition,
            weapons: [], mods: [] });
          logCash(`Bought ${name} (${chosen.condition})`, -priceOf(chosen),
            { kind: cfg.table.replace(/s$/, ""), name });
          await playChangedRecalc();
        } })));
  };
  unitBlock(RIG_UNIT_CFG.drones, ownedDrones(), CALC.drones);
  unitBlock(RIG_UNIT_CFG.vehicles, ownedVehicles(), CALC.vehicles);
  body.append(rigBuySection);
}

/* ------------------------------------------------ actions tab */
/* Player reference: common actions and their skill/difficulty, straight from
 * DATA.tables.hack_actions. Grouped by the table's Group column so future
 * action categories land here automatically. */
function actionRefCard(section) {
  if (!section) return null;
  // A house rule can retire an action outright — "No Recoil" takes "Stabilize a
  // gun" with it, since there is no recoil to stabilize (#61). The engine
  // decides which lines are gone so the reference stays plain data.
  const items = section.items.filter(item => !RULES.actionRefHidden(item));
  return el("div", { class: "card sh-card" },
    el("h3", {}, section.title),
    section.note ? el("p", { class: "hint" }, section.note) : null,
    el("ul", { class: "sh-bullets" }, ...items.map(item => el("li", {}, item))));
}

function shActions(body) {
  const ref = DATA.action_reference || {};

  const pairRow = (...keys) =>
    el("div", { class: "sh-two" }, ...keys.map(k => actionRefCard(ref[k])));

  body.append(
    pairRow("free_actions", "reflex_actions"),
    pairRow("simple_actions", "complex_actions"),
    actionRefCard(ref.conflict_sequence),
    pairRow("resolving_ranged", "resolving_melee"));

  const groups = {};
  for (const row of DATA.tables.hack_actions || [])
    (groups[row.Group || "Actions"] ??= []).push(row);
  if (!Object.keys(groups).length) {
    body.append(el("div", { class: "card sh-card" },
      el("h3", {}, "Actions"),
      el("p", { class: "hint" }, "No action reference data available.")));
    return;
  }
  for (const [group, rows] of Object.entries(groups)) {
    const t = el("table");
    t.append(el("tr", {}, el("th", {}, "Action"), el("th", {}, "Skill"),
      el("th", {}, "Difficulty"), el("th", {}, "Notes")));
    for (const r of rows) {
      t.append(el("tr", {},
        el("td", {}, el("b", {}, r.Action)),
        el("td", {}, RULES.hackActionSkill(r.Skill)),
        el("td", { class: "sub" }, r.Diff),
        el("td", { class: "sub" }, r.Notes || "")));
    }
    body.append(el("div", { class: "card sh-card" }, el("h3", {}, group), t,
      el("p", { class: "hint", style: "margin-top:8px" },
        "Difficulties listed as a/b/c/d scale by site tier. (n) is a minimum Alert raise.")));
  }
}

/* ------------------------------------------------ notes tab */
function shNotes(body) {
  // What you came here to write goes first and sits beside what the build has
  // to tell you, so the two halves of "notes" are in one eyeful. The generated
  // half only exists when there's something to say — with nothing beside it the
  // editor takes the full width rather than leaving a hole.
  const autos = dossierNotes();
  const notes = notesCard(14);   // shorter: it no longer owns the whole column
  // A Replicant's clock belongs with the rest of what being one costs you, not
  // only on the Overview. Same live control, same play field.
  const lifespan = replicantLifespanTracker();
  // The card always renders now, because recoil capacity is always there to
  // report. It goes in as a stat line rather than a ⚠ callout: this card mixes
  // two kinds of generated content, and a standing figure of the build is not a
  // warning about it. (The one exception is the "No Recoil" house rule, which
  // takes the stat away entirely — #61.)
  const dossier = el("div", { class: "card sh-card" },
    el("h3", {}, "Dossier Notes"),
    el("p", { class: "hint" }, "Generated from your build — reminders that don't fit the other tabs."));
  const dossierRecoil = recoilStatLine();
  if (dossierRecoil) dossier.append(dossierRecoil);
  autos.forEach(n => dossier.append(el("div", { class: "sh-callout" }, "⚠ ", n)));
  if (lifespan) dossier.append(lifespan);
  // Two columns of two. Left is what the PLAYER writes — description above the
  // session notes, both freeform prose in the same voice, so they read as one
  // column. Right is reference: the pictures, then the generated dossier under
  // them. Dossier goes last because it is the least-read thing here and is often
  // just the recoil line, so it fills a tail rather than stranding whitespace at
  // the top of a column, which is what it did when it led.
  //
  // Column WRAPPERS rather than a flat four-cell grid: at <=900px .sh-notes-top
  // collapses to one column, and wrappers keep the phone order description ->
  // notes -> images -> dossier instead of splitting the two textareas apart.
  body.append(el("div", { class: "sh-notes-top" },
    el("div", { class: "sh-notes-col" }, descriptionCard(), notes),
    el("div", { class: "sh-notes-col" }, imagesCard(), dossier)));
  const traits = heritageTraitsCard();
  if (traits) body.append(traits);
}

/* All heritage traits (features + uplift animal) with their listed effects. */
/* [name, effect] for the character's uplift type + each chosen heritage feature. */
function heritageTraitEntries() {
  const feats = DATA.tables.heritage_features || [];
  const rowOf = name => feats.find(f => f.Name === name);
  const traitEffect = f => f.Effects
    || ["STR", "BOD", "REA", "INT", "WILL", "CHA"]
        .filter(k => f[k]).map(k => `${k} ${f[k] > 0 ? "+" : ""}${f[k]}`).join(", ")
    || "—";
  const entries = [];
  if (CHAR.heritage.uplift_type) {
    const f = rowOf(CHAR.heritage.uplift_type);
    if (f) entries.push([`${f.Name} (uplift)`, traitEffect(f)]);
  }
  (CHAR.heritage.features || []).forEach(name => {
    const f = rowOf(name);
    entries.push([name, f ? traitEffect(f) : "—"]);
  });
  return entries;
}

/* Compact "Name: effect" strings for the header, skipping empty effects. */
function heritageAbilityLines() {
  return heritageTraitEntries()
    .filter(([, effect]) => effect && effect !== "—")
    .map(([name, effect]) => `${name.replace(" (uplift)", "")}: ${effect}`);
}

function heritageTraitsCard() {
  const entries = heritageTraitEntries();
  if (!entries.length) return null;
  const card = el("div", { class: "card sh-card" },
    el("h3", {}, "Heritage Traits"),
    el("p", { class: "hint" }, `${CHAR.heritage.type}${CHAR.heritage.uplift_type ? " · " + CHAR.heritage.uplift_type : ""} — trait effects for quick reference.`));
  const t = el("table");
  t.append(el("tr", {}, el("th", {}, "Trait"), el("th", {}, "Effect")));
  entries.forEach(([name, effect]) =>
    t.append(el("tr", {}, el("td", {}, el("b", {}, name)), el("td", { class: "sub" }, effect))));
  card.append(t);
  return card;
}

/* ------------------------------------------- conditional pool effects */
/* Every "+2 to your pools while X" the character owns, as a switch.
 *
 * CALC.pool_effects enumerates what the build COULD switch on (parsed out of
 * each thing's own effect text, so homebrew is covered too); `play.pool_effects`
 * says which are on; poolState() adds the live ones on top of CALC.pools. That
 * split is the whole design: an Adrenal Pump that's been in your chest since
 * chargen shouldn't inflate the pool totals for the 99% of the session it isn't
 * running, and a pool total you have to mentally subtract from is worse than no
 * total at all.
 *
 * Switching one off is lossless — the swing is never written into the player's
 * own temp dice, and spent dice are clamped for reading but never stored down —
 * so a pump wearing off gives back exactly the pool you had (issue #31).
 *
 * Wildling is one of these like any other, but it carries a second thing to
 * track: six Beast dice, refreshing each round while shifted (so New Round tops
 * them up, same as the pools) and hidden while human, since there's nothing to
 * spend. */
const BEAST_DICE_MAX = RULES.WILDLING_BEAST_DICE;

function poolEffects() { return (CALC && CALC.pool_effects) || []; }

/* ---- doses -----------------------------------------------------------------
 * A drug is not a switch. You take a dose, it does something for a while, and
 * then it wears off — so the state that matters is "what am I on right now",
 * which is a list of doses, not a boolean per drug.
 *
 * Each dose is its own entry even when it's the same drug twice, because
 * dismissing them independently is the whole point: two Crams taken ten minutes
 * apart wear off ten minutes apart.
 *
 * Stacking is capped per row (`Max Doses`). Over the cap the extra doses still
 * appear in the list — you did take them, and Dependence cares — but they stop
 * contributing dice. */
function activeDoses() {
  return (CHAR.play && CHAR.play.doses) || [];
}

function doseCount(name) {
  return activeDoses().filter(d => d.name === name).length;
}

/* How many doses of this drug are actually paying out, and how many were taken.
 * `taken > counted` is what the banner reports as over the cap.
 *
 * Keyed by name and read off the data row rather than the enumerated pool
 * effect, because a dose need not have one: the medkits' whole effect is a
 * Skill Bonus, and they still stack to a cap like everything else. */
function doseTally(name) {
  const row = (DATA.tables.misc_gear || []).find(r => r.Item === name);
  const cap = row ? RULES.gearMaxDoses(row) : 1;
  const taken = doseCount(name);
  return { taken, counted: Math.min(taken, cap), cap };
}

function takeDose(name) {
  CHAR.play.doses = CHAR.play.doses || [];
  CHAR.play.doses.push({ uid: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                         name, at: new Date().toISOString() });
}

function dismissDose(uid) {
  // Identity, not value: two Crams are two rows and dismissing one keeps the
  // other. Hand-written or externally generated character JSON can arrive with
  // no uid at all, though, and `undefined !== undefined` is false for every
  // such row -- one click would empty the list. Fall back to dropping the first
  // uid-less entry, which is what the caller meant.
  const doses = activeDoses();
  const at = uid == null
    ? doses.findIndex(d => d.uid == null)
    : doses.findIndex(d => d.uid === uid);
  if (at < 0) return;
  doses.splice(at, 1);
  CHAR.play.doses = doses;
  playChanged();
}

/* Gear rows the engine marked as doses, keyed by name, so a gear row can ask
 * "is this a dose, and what is it worth" without re-parsing anything. */
function doseEffectFor(name) {
  return poolEffects().find(e => e.dose && e.label === name) || null;
}

/* What a dose is worth, as a line of text, for the banner and the Use tooltip.
 *
 * Pool dice come from the enumerated effect; skill dice come off the row's own
 * columns, because gearSkillEffects applies those and they never enter
 * pool_effects. The kits are the reason this exists — their whole effect is
 * "Biotech +1", and a banner that called that "no dice effect" would be lying. */
function doseSummary(name) {
  const parts = [];
  const fx = doseEffectFor(name);
  if (fx) {
    const { counted } = doseTally(name);
    for (const [p, n] of Object.entries(fx.pools)) {
      const total = n * Math.max(1, counted);
      parts.push(`${total > 0 ? "+" : "−"}${Math.abs(total)} ${p}`);
    }
  }
  const row = (DATA.tables.misc_gear || []).find(r => r.Item === name);
  if (row) {
    // Same "how many are counting" rule the dice use, so the text can't claim a
    // total the engine isn't applying. Reads as 1 before any dose is taken, so
    // the Use tooltip can say what one dose will be worth.
    const times = Math.min(Math.max(1, doseCount(name)), RULES.gearMaxDoses(row));
    for (const part of String(row["Skill Bonus"] || "").split(",")) {
      const m = /^(.+?)\s*([+-]\s*\d+)$/.exec(part.trim());
      if (!m) continue;
      const n = parseInt(m[2].replace(/\s+/g, ""), 10) * times;
      parts.push(`${n > 0 ? "+" : "−"}${Math.abs(n)} ${m[1].trim()}`);
    }
    for (const part of String(row["Skill Note"] || "").split("|")) {
      const m = /^(.+?)\s*:\s*(.+)$/.exec(part.trim());
      if (m) parts.push(`${m[1].trim()}: ${m[2].trim()}`);
    }
  }
  return parts.join(" · ");
}

function poolEffectOn(id) {
  const e = poolEffects().find(x => x.id === id);
  // A dose effect ignores the switch entirely: it's on because a dose is live.
  if (e && e.dose) return doseTally(e.label).counted > 0;
  return !!((CHAR.play.pool_effects || {})[id]);
}

function activePoolEffects() {
  return poolEffects().filter(e => poolEffectOn(e.id));
}

/* The total swing every live effect is worth to this pool right now. Dose
 * effects multiply by how many doses are counting; everything else is on once
 * or not at all. */
function poolEffectMod(pool) {
  if (!CHAR.play) return 0;
  let n = 0;
  for (const e of activePoolEffects()) {
    const each = e.pools[pool] || 0;
    n += e.dose ? each * doseTally(e.label).counted : each;
  }
  return n + trackedPoolMod(pool);
}

/* Dice from hand-tracked Temporary Effects and Active Modifiers (#46).
 *
 * These join the conditional-effect layer rather than the player's own
 * pool_boost, for the same reason a drug does: they come and go several times a
 * session, and they must not eat the temp dice the player set by hand. Removing
 * the effect removes exactly its own dice and nothing else.
 *
 * An entry with no pool contributes nothing — it's the free-text case the issue
 * asks to keep, a reminder like "Haste F4, 3 rounds" that the table applies. */
function trackedPoolMod(pool) {
  const play = CHAR.play;
  let n = 0;
  // Both lists, still: the two were merged in #57 but mergeTrackedEffects only
  // runs when the Overview renders, and a character sitting on another tab must
  // not lose the dice a legacy modifier is giving them in the meantime.
  for (const list of [play.effects || [], play.modifiers || []]) {
    for (const e of list) {
      if (e && e.pool === pool) n += toIntSafe(e.dice);
    }
  }
  return n;
}

/* Changing shape knits you back together (#67). A Wildling's man-beast form
 * heals 1d6 Physical; the Shapeshifting spell rebuilds you wholesale and heals
 * 1d6 of each track. The rolls are announced rather than applied silently: they
 * ARE dice the player would otherwise have rolled themselves, and damage that
 * moves with no explanation reads as the sheet having lost track of a wound.
 *
 * Nothing is said when there was nothing to heal — a fresh character shifting
 * shape does not need a popup to be told they are still uninjured. */
function healOnShift(what, healStun) {
  const play = CHAR.play;
  const hadP = play.physical_damage || 0, hadS = play.stun_damage || 0;
  if (!hadP && !(healStun && hadS)) return;
  const rp = rollDie(6);
  play.physical_damage = Math.max(0, hadP - rp);
  const parts = [`Physical −${hadP - play.physical_damage} (rolled ${rp})`];
  if (healStun) {
    const rs = rollDie(6);
    play.stun_damage = Math.max(0, hadS - rs);
    parts.push(`Stun −${hadS - play.stun_damage} (rolled ${rs})`);
  }
  alert(`${what} heals you. ${parts.join(", ")}.`);
}

/* One tracked effect/modifier, as a row the player fills in.
 *
 * Prompt chains were the old way in, which made "Cover, Finesse, −2" three
 * separate modal questions and gave the dice nowhere to go afterwards. This is
 * a form: what it is, where it came from, which pool it touches, how many dice.
 *
 * `kind` only changes the wording; both lists store and apply the same shape. */
function trackedEffectRow(entry, list, index) {
  const commit = () => playChangedRecalc();
  // Stable per-row field id so a re-render can hand focus back to the pool
  // selector — changing it recalculates, which rebuilds the sheet under the
  // control being used (#57). Keyed by name rather than index so deleting an
  // earlier row doesn't move everyone else's identity. The Dice stepper below
  // doesn't need one: it only re-renders after a commit, never mid-edit.
  const kid = what => `fx:${entry.name || index}:${what}`;
  const poolSel = el("select", {
    "data-keep-id": kid("pool"),
    title: "Which pool these dice come off or go onto",
    onchange: e => { entry.pool = e.target.value; commit(); } },
    el("option", { value: "" }, "No pool"),
    ...POOL_ORDER.map(p => el("option", { value: p }, p)));
  poolSel.value = entry.pool || "";
  const dice = toIntSafe(entry.dice);
  // Name, pool, dice, what it's doing, and delete — one line, so reading a row
  // doesn't mean scanning up and down between a head and a fields block that
  // used to sit at different heights. The delete button rides margin-left:auto
  // to the far end of whichever line it lands on, wrapped or not.
  return el("div", { class: "sh-fx-row sh-fx-tracked" },
    el("div", { class: "sh-fx-line" },
      el("b", { class: "sh-fx-name" }, entry.name || "(unnamed)"),
      poolSel,
      // A number input that re-renders on every keystroke fights a typed
      // minus sign: the interim "-" parses as NaN, gets coerced to 0, and the
      // rebuilt field shows "0" out from under the player mid-type — which is
      // exactly how a real penalty could silently end up not applied. The
      // stepper only commits on blur/Enter (or the −/+ buttons), the same
      // click-to-type pattern every other spend-a-die control on this sheet
      // already uses, so there's no keystroke for a rebuild to race.
      miniCounter("", () => toIntSafe(entry.dice) || 0,
        v => { entry.dice = v; }, -99, 99),
      // Say what it's actually doing, so a row that affects nothing looks
      // deliberate rather than broken.
      el("span", { class: "sh-fx-swing" + (entry.pool && dice ? " on" : "") },
        entry.pool && dice
          ? `${dice > 0 ? "+" : ""}${dice}d ${entry.pool}, applied to the pool`
          : "Reminder only — no pool dice applied"),
      el("button", { class: "row-del",
        onclick: () => { list.splice(index, 1); playChangedRecalc(); } }, "✕")),
    // Modifiers saved before this form existed carry a free-text "value"
    // ("+2", "−1d") and nothing else. Dropping it would quietly lose what the
    // player wrote, so it's shown until they fill in the pool and dice that
    // replace it.
    (entry.value && !(entry.pool && dice))
      ? el("div", { class: "sub", style: "color:var(--amber)" },
          `Was noted as "${entry.value}" — set a pool and dice above to apply it`)
      : null);
}

function setPoolEffect(id, on) {
  CHAR.play.pool_effects = CHAR.play.pool_effects || {};
  if (on) CHAR.play.pool_effects[id] = true;
  else delete CHAR.play.pool_effects[id];
  // A fresh shift arrives with a full set of Beast dice.
  if (on && id === RULES.WILDLING_EFFECT_ID) {
    CHAR.play.beast_dice = BEAST_DICE_MAX;
    healOnShift("Beast Form", false);   // 1d6 Physical only (#67)
  }
  playChanged();
}

/* Beast dice refresh each round, but only while there's a beast to refresh. */
function refreshBeastDice() {
  if (poolEffectOn(RULES.WILDLING_EFFECT_ID)) CHAR.play.beast_dice = BEAST_DICE_MAX;
}

/* Most of these are a switch you flip: on, off, done. A Wildling's shift isn't —
 * it's a shape you're in, and "Human Form / Beast Form" is what a player at the
 * table actually says. Anything named here gets that wording and an icon that
 * tracks the state; everything else falls through to plain On/Off. */
const POOL_EFFECT_FORMS = {
  [RULES.WILDLING_EFFECT_ID]: {
    onIcon: "🐺", offIcon: "🧍",
    onState: "Man-beast form", offState: "Human form",
    onBtn: "Human Form", offBtn: "Beast Form",   // the button says where it takes you
  },
};

/* One row per effect: what it is, what it's worth, and the switch. Sits in the
 * Overview callout strip beside the Replicant lifespan tracker, because these
 * are things you flip mid-fight and they belong above the pools they move. */
/* `after` as on dosesBanner above: the Running Now popover renders this whole
 * and must be refreshed by hand after a toggle, since it sits outside the
 * #sheet subtree that playChanged rebuilds. */
function poolEffectsPanel({ after = null } = {}) {
  // Doses live in their own banner with a Use button and a per-dose dismiss.
  // Giving them an On/Off here as well would be two controls for one bonus,
  // and the two would disagree the moment either was touched.
  const list = poolEffects().filter(e => !e.dose);
  // A worn Shapeshift form belongs here too, and can be the ONLY thing here —
  // a caster with no drugs and no Wildling still needs somewhere that says they
  // are currently a hawk. So the panel survives an empty effect list when a
  // form is on.
  const shifted = shiftedForm();
  if (!list.length && !shifted) return null;
  const play = CHAR.play;
  const ro = !!(activeTabObj() && activeTabObj().readonly);
  const anyOn = list.some(e => poolEffectOn(e.id)) || Boolean(shifted);

  const onList = list.filter(e => poolEffectOn(e.id));
  // The form counts as one of the things that can be on, in both halves of the
  // tally, so "1/1" reads correctly for a shifted caster with nothing else.
  const onCount = onList.length + (shifted ? 1 : 0);
  const total = list.length + (shifted ? 1 : 0);

  const card = el("div", { class: `sh-callout sh-fx ${anyOn ? "warn" : "info"}` },
    el("div", { class: "sh-fx-head" },
      el("span", {}, anyOn ? "⚡ " : "○ ", el("b", {}, "Conditional Effects"), " ",
        el("b", {}, anyOn ? `${onCount}/${total}` : String(total)))));
  card.classList.add("is-open");

  if (shifted) card.append(shiftedFormRow(shifted, after));

  for (const e of list) {
    const on = poolEffectOn(e.id);
    const form = POOL_EFFECT_FORMS[e.id];
    const swing = Object.entries(e.pools)
      .map(([p, n]) => `${n > 0 ? "+" : "−"}${Math.abs(n)} ${p}`).join(" · ");
    const state = form ? (on ? form.onState : form.offState) : (on ? "On" : "Off");
    const row = el("div", { class: "sh-fx-row" + (on ? " on" : "") },
      el("div", { class: "sh-fx-what" },
        el("span", { class: "sh-fx-name" },
          form ? `${on ? form.onIcon : form.offIcon} ` : "",
          e.label,
          el("span", { class: "sub" }, ` · ${form ? state : e.source}`)),
        el("div", { class: "sh-fx-swing" + (on ? " on" : "") }, swing),
        el("div", { class: "sh-fx-text sub", title: e.text }, e.text)),
      ro
        ? el("span", { class: "sub" }, state)
        // A form button names where it takes you, so green means "go there" and
        // amber means "you're currently altered" — the opposite of the plain
        // On/Off chips, where green simply means live.
        : el("button", { class: "btn " + (form ? (on ? "warn" : "good") : (on ? "good" : "")),
            title: on ? `${e.label} is on — click to switch it off (${swing} comes back out)`
                      : `Switch ${e.label} on — adds ${swing} to the pools`,
            onclick: () => { setPoolEffect(e.id, !on); if (after) after(); } },
            form ? (on ? form.onBtn : form.offBtn) : (on ? "On" : "Off")));
    card.append(row);

    // Wildling's other half — only worth showing once you're actually shifted.
    if (on && e.id === RULES.WILDLING_EFFECT_ID) {
      if (play.beast_dice == null) play.beast_dice = BEAST_DICE_MAX;
      const left = Math.max(0, Math.min(BEAST_DICE_MAX, play.beast_dice));
      card.append(el("div", { class: "sh-fx-dice" },
        el("span", {}, "Beast dice ",
          el("b", { style: left ? "color:var(--ok)" : "color:var(--bad)" },
            `${left} / ${BEAST_DICE_MAX}`)),
        ro ? null : miniCounter("", () => play.beast_dice ?? BEAST_DICE_MAX,
          v => { play.beast_dice = v; if (after) after(); }, 0, BEAST_DICE_MAX),
        ro ? null : counterBtn("↻", () => {
          play.beast_dice = BEAST_DICE_MAX; playChanged(); if (after) after();
        }, "good"),
        el("span", { class: "sub" }, "refresh each round")));
    }
  }
  return card;
}

/* ------------------------------------------------ markdown export (scabard.com) */
function exportMarkdown() {
  const md = buildMarkdown();
  const blob = new Blob([md], { type: "text/markdown" });
  const a = el("a", { href: URL.createObjectURL(blob),
    download: (CHAR.name || "character").replace(/[^\w-]+/g, "-") + ".md" });
  a.click();
}

function buildMarkdown() {
  const play = CHAR.play;
  const econ = kismetEcon();
  const c = CALC.combat;
  const L = [];
  const heritageLabel = CHAR.heritage.type
    + (CHAR.heritage.uplift_type ? ` (${CHAR.heritage.uplift_type})` : "");

  L.push(`# ${CHAR.name || "Unnamed"}`);
  L.push("");
  L.push(`*${heritageLabel} · ${CALC.magic.type}${CHAR.player ? ` · Player: ${CHAR.player}` : ""}*`);
  L.push("");

  // ---- compact stat block: attributes, pools, and combat vitals at a glance ----
  const altMoves = (c.move_modes || []).map(m => `${m.mode} ${m.meters}m`).join(", ");
  const initEx = sheetInitiative();
  L.push(ATTR_ABBR.map(([full, ab]) => `**${ab}** ${CALC.attributes[full].final}`).join(" · "));
  L.push("");
  L.push(POOL_ORDER.map(p => `**${p}** ${CALC.pools[p]}`).join(" · "));
  L.push("");
  L.push([
    `**Physical** ${CALC.condition.physical} · **Stun** ${CALC.condition.stun}`,
    `**Armor** ${c.ballistic_armor}B/${c.impact_armor}I`,
    `**Move** ${c.move}m${moveSpecial() ? ` (${moveSpecial()})` : ""}${altMoves ? ` [${altMoves}]` : ""}`,
    `**Init** ${initEx.dice}d+${initEx.bonus}`,
    `**Actions** ${c.simple_actions}`,
    // No Recoil (#61): nothing to export — the stat doesn't exist for this
    // character, and an exported "Recoil 1" would be a rule the table dropped.
    RULES.recoilInPlay()
      ? `**Recoil** ${c.recoil_capacity}${c.recoil_ignored ? " (ignored)" : ""}` : null,
    c.dodge_bonus ? `**Dodge** +${c.dodge_bonus}` : null,
    c.soak_bonus ? `**Soak** +${c.soak_bonus}d` : null,
    c.physical_damage_reduction ? `**Soak** −${c.physical_damage_reduction}` : null,
  ].filter(Boolean).join(" · "));
  if (CALC.martial_art.style && (c.martial_notes || []).length)
    L.push(`**${CALC.martial_art.style}**: ${c.martial_notes.join(" · ")}`);
  L.push("");
  const notes = dossierNotes();
  if (notes.length) { for (const note of notes) L.push(`> ⚠ ${note}`); L.push(""); }
  L.push("*Wound rule: every 3 boxes marked on either track = −1 die on tasks, cumulative. Biotech can remove these penalties during combat.*");
  L.push("");

  L.push("## Skills");
  L.push("");
  // A specialization splits the rating the way the sheet shows it — −1 off it,
  // +1 on it — so the export carries both numbers and what the specialty is,
  // rather than a single figure that is right in neither case.
  const mdSpec = n => {
    const spec = (CHAR.skill_specializations || {})[n];
    return (spec && spec.on && CALC.skills[n].final > 0 && spec.text) ? spec : null;
  };
  let anySpec = false;
  for (const pool of POOL_ORDER) {
    const trained = Object.entries(DATA.skills)
      .filter(([n, m]) => m.pool === pool && CALC.skills[n].final > 0)
      .sort((a, b) => CALC.skills[b[0]].final - CALC.skills[a[0]].final);
    if (!trained.length) continue;
    L.push(`**${pool} (${CALC.pools[pool]}d)**: `
      + trained.map(([n]) => {
          const final = CALC.skills[n].final;
          const spec = mdSpec(n);
          if (!spec) return `${n} ${final}`;
          anySpec = true;
          return `${n} ${final - 1}/${final + 1} (${spec.text})`;
        }).join(" · "));
    L.push("");
  }
  if (anySpec) {
    L.push("*Specialized skills read **off-specialty / on-specialty** — the "
      + "specialty in brackets is the +1 side.*");
    L.push("");
  }
  const skillNoteLines = [];
  for (const [n, s] of Object.entries(CALC.skills))
    if (s.notes && s.notes.length) skillNoteLines.push(`- **${n}** — ${s.notes.join("; ")}`);
  if (skillNoteLines.length) {
    L.push("*Situational skill dice:*");
    skillNoteLines.forEach(line => L.push(line));
    L.push("");
  }
  // The BOUGHT value leads and the gear total follows in parentheses. That
  // order matters on the way back in: the importer reads the leading number, so
  // a round trip restores the points that were actually purchased. Emitting the
  // total there would bake the gear bonus into the points and double it the
  // moment the gear was re-applied.
  const ep = CALC.etiquette_points || {};
  const etqAdjust = ep.adjust || {};
  const etqList = Object.entries(ep.final || {}).filter(([, v]) => v > 0);
  if (etqList.length) {
    L.push("**Etiquettes:** " + etqList.map(([n, total]) => {
      const bonus = etqAdjust[n] || 0;
      const base = (ep.values || {})[n] || 0;
      return bonus ? `${n} ${base} (+${bonus} gear = ${total})` : `${n} ${total}`;
    }).join(" · "));
    L.push("");
    if (Object.keys(etqAdjust).length) {
      const by = {};
      for (const s of CALC.etiquette_sources || [])
        (by[s.label] ||= []).push(`+${s.bonus} ${s.etiquette}`);
      L.push("**Etiquette bonuses** (from worn/carried gear, outside the cap): "
        + Object.entries(by).map(([label, list]) => `${list.join(", ")} — ${label}`)
          .join(" · "));
      L.push("");
    }
  }
  const knows = allKnowledgeSkills().filter(k => k.name);
  if (knows.length) {
    L.push("**Knowledges:** " + knows.map(k => `${k.name} ${k.points || 0}`).join(" · "));
    L.push("");
  }
  const ritualList = Object.entries(CALC.ritual_skills || {}).filter(([, v]) => v > 0);
  if (ritualList.length) {
    L.push("**Ritual skills:** " + ritualList.map(([n, v]) => `${n} ${v}`).join(" · "));
    L.push("");
  }
  for (const m of (CALC.martial_arts || [])) {
    L.push(`**Martial Art — ${m.style} (rank ${m.rank}):** `
      + (m.levels.length ? m.levels.map(l => `L${l.Level}: ${l.Effect}`).join("; ") : "no levels unlocked yet"));
    L.push("");
  }

  const allSpells = [...CHAR.magic.spells, ...play.purchases.spells];
  const allPowers = [...CHAR.magic.amp_powers, ...play.purchases.amp_powers];
  if (CALC.magic.type !== "Hedge") {
    L.push(`## Magic — ${CALC.magic.type}`);
    L.push("");
    if (allSpells.length) {
      const zp = CALC.zoetics.zp;
      L.push("**Spells** (drain is LETHAL above ZP " + zp + ", Stun at or below): "
        + allSpells.map(s => {
            const force = s.force + (play.spell_force_advances[s.name] || 0);
            return `${s.name} (F${force}${force > zp ? " ⚠lethal" : ""})`;
          }).join(" · "));
    }
    if (allPowers.length)
      L.push("**Amp powers:** " + allPowers.map(p =>
        p.name + (p.target ? ` → ${p.target}` : "") + ((p.times || 1) > 1 ? ` ×${p.times}` : "")).join(" · "));
    if (CALC.speaker.relationships.length)
      L.push("**Spirit relationships:** " + CALC.speaker.relationships.join(" · ")
        + ` (bonds: ${CALC.speaker.bonds || 0})`);
    if (CALC.speaker.infusions.length)
      L.push("**Infusions:** " + CALC.speaker.infusions.join(" · "));
    // Bound spirits carry their Force and the services they're currently owed
    // for; the full writeup stays in the app rather than bloating the export.
    // Only the bonds actually bought — dormant slots past the count are held
    // for a restore, not bonds this character has.
    const liveBonds = (play.bond_slots || []).slice(0, RULES.speakerBondCount(CALC));
    for (const [bi, bond] of liveBonds.entries()) {
      if (!bond.spirit) continue;
      const row = DATA.tables.speaker_spirits.find(x => x.Spirit === bond.spirit) || {};
      const names = parseSpiritServices(row["Bound Services"])
        .map(svc => svc.name).filter(Boolean);
      L.push(`**Bond ${bi + 1}:** ${bond.spirit} (Force ${bond.force || 0}`
        + `, favors owed ${bond.favors || 0})`
        + (names.length ? " — " + names.join(" · ") : ""));
    }
    L.push("");
  }

  const allAugments = allAugmentsOwned();
  if (allAugments.length) {
    L.push("## Augments");
    L.push("");
    allAugments.forEach(a => {
      const r = DATA.tables.augments.find(x => x.Name === a.name) || {};
      const dmg = RULES.augmentMeleeDamage(r, CALC.attributes.Strength.final, CALC.martial_art && CALC.martial_art.mods);
      const gun = (RULES.isCybergunAugment(a.name) && a.gunType) ? ` — ${a.gunType}` : "";
      L.push(`- ${a.name}${(a.count || 1) > 1 ? ` ×${a.count}` : ""}${gun}${dmg !== "" ? ` — DMG ${dmg}` : ""}`);
    });
    if (c.sense_notes && c.sense_notes.length)
      L.push(`- *Senses & immunities:* ${c.sense_notes.map(s => s.name).join(", ")}`);
    L.push("");
  }
  const cyberguns = equippedCyberguns();
  const grantedWeapons = c.granted_weapons || [];
  const traitGear = c.trait_gear || [];
  const mdWeapons = allWeapons(), mdArmor = allArmor();
  if (mdWeapons.length || cyberguns.length || grantedWeapons.length || traitGear.length) {
    L.push("## Weapons");
    L.push("");
    mdWeapons.forEach(w => {
      const r = DATA.tables.weapons.find(x => x.Weapon === w.name) || {};
      const calcRow = (CALC.weapons || []).find(x => x.Weapon === w.name) || {};
      const smart = (calcRow.smart ?? w.smart) ? " (smart)" : "";
      const isMelee = r.Type === "Melee";
      const ammo = calcRow.Ammo ?? r.Ammo;
      const bar = String(calcRow.Bar ?? r.Bar ?? "");
      const stats = [`DMG ${calcRow.Damage ?? r.Damage ?? "—"}`,
                     isMelee ? `Reach ${r.Reach || 0}` : `Acc ${calcRow.Accuracy ?? r.Accuracy ?? 0}`,
                     `Pen ${r.Pen || 0}`,
                     (bar || r.Type === "GrenadeLauncher") ? `Barrier ${bar || "—"}` : null,
                     // The effective rating, mods included — same as Acc above.
                     // Kept a bare number: the importer uses "· Conceal " as its
                     // owned-weapon discriminator and re-derives the mod share
                     // from the mods list, so anything extra here would be noise.
                     `Conceal ${calcRow.Conceal ?? r.Conceal ?? 0}`,
                     (!isMelee && ammo) ? `Ammo ${ammo}` : null,
                     (!isMelee && r["Firing modes"]) ? r["Firing modes"] : null].filter(Boolean).join(" · ");
      L.push(`- **${w.name}**${smart} — ${stats}`
        + ((w.mods || []).length ? ` — mods: ${w.mods.join(", ")}` : ""));
    });
    cyberguns.forEach(cg => {
      const g = cg.gun;
      L.push(`- **${cg.name}** (smart) — DMG ${g.Dmg} · Acc ${g.Acc} · Pen ${g.Pen}${barrierBit(g, g.Bar)} · Ammo ${g.Ammo} · ${g.Modes}`);
    });
    grantedWeapons.forEach(gw => {
      const line = gw.stats
        || `${gw.kind || "Melee"}${gw.dice != null ? ` ${gw.dice}d` : ""} · DMG ${gw.damage}`
           + (gw.note ? ` · ${gw.note}` : ` · Reach ${gw.reach}`);
      L.push(`- **${gw.name}** — ${line} (${gw.source})`);
    });
    traitGear.forEach(g => {
      const w = g.weapon;
      L.push(g.kind === "weapon" && w
        ? `- **${g.label}** — ${w.Type || ""} · DMG ${w.Damage || "—"} · Acc ${w.Accuracy || 0} · wt ${w.Weight || 0} (${g.source} mount)`
        : `- **${g.label}** — extra limb (${g.source} mount)`);
    });
    if (c.optics_notes && c.optics_notes.length) L.push(`- *Optics:* ${c.optics_notes.join(" · ")}`);
    L.push("");
  }
  if (mdArmor.length) {
    L.push("## Armor");
    L.push("");
    mdArmor.forEach(a => {
      const r = DATA.tables.armor.find(x => x.Armor === a.name) || {};
      L.push(`- **${a.name}** — ${r.Ballistic || 0}B/${r.Impact || 0}I${a.active !== false ? " (worn)" : ""}`);
    });
    L.push("");
  }
  const gearOwned = allGear();
  if (gearOwned.length || play.lifestyles.length) {
    L.push("## Gear");
    L.push("");
    gearOwned.forEach(g => L.push(`- ${g.name}${(g.qty || 1) > 1 ? ` ×${g.qty}` : ""}`));
    play.lifestyles.forEach(ls => {
      L.push(`- Lifestyle: ${ls.name} — ${ls.months || 0} month(s) prepaid${ls.active ? " **(current)**" : ""}`);
      if (ls.active && LIFESTYLE_EFFECTS[ls.name])
        L.push(`  - *Effect:* ${LIFESTYLE_EFFECTS[ls.name]}`);
    });
    L.push("");
  }
  const mdDecks = allDecks(), mdPrograms = allPrograms();
  const mdRigs = allRigs(), mdDrones = allDrones(), mdVehicles = allVehicles();
  if (mdDecks.length || mdPrograms.length) {
    L.push("## Decking");
    L.push("");
    mdDecks.forEach(d => L.push(`- Deck: **${d.name}**${(d.mods || []).length ? ` (${d.mods.join(", ")})` : ""}`
      + (d.hacking ? ` — running ${d.hacking}` : " — **no Hacking program slotted**")));
    if (mdPrograms.length) L.push("- Programs: " + mdPrograms.join(" · "));
    L.push("");
  }
  if (mdRigs.length || mdDrones.length || mdVehicles.length) {
    L.push("## Rigging");
    L.push("");
    // A unit's condition and fitted mods are half of what it is — a Blinged,
    // reframed bike is not the Motorcycle off the page — so they travel with it.
    const unitBits = u => [
      (u.condition && u.condition !== "Pristine") ? u.condition : "",
      (u.weapons || []).length ? `weapons: ${u.weapons.map(sublistName).join(", ")}` : "",
      (u.mods || []).length ? `mods: ${u.mods.map(sublistName).join(", ")}` : "",
    ].filter(Boolean).join(" · ");
    const unitLine = (kind, u) => {
      const bits = unitBits(u);
      L.push(`- ${kind}: **${u.label || u.name}**`
        + (u.label && u.name && u.label !== u.name ? ` (${u.name})` : "")
        + (bits ? ` — ${bits}` : ""));
    };
    mdRigs.forEach(r => unitLine("Rig", r));
    mdDrones.forEach(d => unitLine("Drone", d));
    mdVehicles.forEach(v => unitLine("Vehicle", v));
    L.push("");
  }

  L.push("## Wealth & Advancement");
  L.push("");
  L.push(`**${RULES.currencyName()}:** ${fmt(play.cash)} · **Kismet:** ${play.kismet} available / ${play.kismet_earned} lifetime · **Boons:** ${econ.regularsAvail} regular, ${econ.majorsAvail} major available`);
  const spends = play.kismet_log.filter(entry => entry.delta < 0 || entry.delta === 0);
  if (spends.length) {
    L.push("");
    L.push("**Kismet spent on:**");
    spends.slice(0, 25).forEach(entry => L.push(`- ${entry.label}${entry.delta ? ` (${entry.delta})` : ""}`));
  }
  L.push("");

  if (play.notes && play.notes.trim()) {
    L.push("## Notes");
    L.push("");
    L.push(play.notes.trim());
    L.push("");
  }
  // Provenance rides on the existing footer rather than a new line: the parser
  // is coupled to the format of everything above the payload comment, and a
  // line it has never seen would land in report.unparsedLines (P14-004).
  // "made with" is the build that generated the character; older files have no
  // stamp, so they get the export version alone — which is the fallback the
  // request asked for.
  const provenance = CHAR.app_version
    ? `app v${RULES.APP_VERSION} · character made with v${CHAR.app_version}`
    : `app v${RULES.APP_VERSION} · character predates version stamping`;
  L.push(`*Exported from the Sinless Character Dossier · `
    + `${new Date().toISOString().slice(0, 10)} · ${provenance}*`);
  // An exact copy of the build, base64'd inside an HTML comment: invisible in
  // Scabard and every markdown viewer, ~8KB, and it makes this file restorable
  // without guessing. Import reads it if it's there and falls back to reading
  // the prose above if it isn't. See static/md-import.js — the parser is
  // coupled to the format of everything above this line.
  if (typeof mdPayloadComment === "function") {
    L.push("");
    L.push(mdPayloadComment(CHAR));
  }
  return L.join("\n");
}
