/**
 * rules.js — Sinless character-generation engine.
 *
 * The canonical implementation of the chargen + play-mode rules. Pure
 * functions throughout: a character object goes in, a plain results object
 * comes out — the only shared mutable state is the `warnings`/`errors`
 * arrays each step appends to. The naming and structure mirror the original
 * Python engine this was ported from, but that Python project is no longer
 * maintained; this file is now the source of truth.
 *
 * Data comes from static/data.js (the DATA_BUNDLE global). Runs in the
 * browser (data.js loaded first) and under Node (require("./data.js")).
 *
 * Public API:
 *   RULES.calculate(character)   — full derived character sheet
 *   RULES.defaultCharacter()     — a blank character in canonical shape
 *   RULES.mergeDefaults(char)    — fill a loaded/imported character's shape
 */
"use strict";

const RULES = (() => {

const BUNDLE = (typeof DATA_BUNDLE !== "undefined")
  ? DATA_BUNDLE
  : require("./data.js");

// ============================================================== app version
/* The build that made a character. Stamped into the record at creation and into
 * every export, so a file that turns up months later says what produced it.
 *
 * Bump alongside CACHE_VERSION in sw.js — they move together, and that cache
 * number is the only other version this app has.
 *
 * A record with NO stamp predates versioning (anything saved on or before
 * 2026-08-11). mergeDefaults writes `null` there rather than letting the
 * default fill claim this build made it: "unknown" is a fact worth keeping,
 * and a confidently wrong version is worse than none when you are working out
 * why an old file behaves oddly. */
const APP_VERSION = "319";

// ============================================================== game constants
// The numeric knobs the engine reads; grouped by chargen step below.

const ATTRIBUTES = ["Strength", "Body", "Reaction", "Intelligence", "Willpower", "Charisma"];
const ATTRIBUTE_COLUMN = {  // Attribute name -> its column header in heritage_features.csv
  Strength: "STR", Body: "BOD", Reaction: "REA",
  Intelligence: "INT", Willpower: "WILL", Charisma: "CHA",
};

// Skill -> [pool it draws from, shared-training group fallback]
const SKILLS = {
  // Brawn pool
  "Athletics": ["Brawn", null],
  // NB: Martial Arts is NOT a normal skill — it's a per-style list on the
  // character (character.martial_arts = [{style, rank}]), each style an
  // independent skill at 2 pts/rank capped by Unarmed Combat. Handled in
  // scoreSkills / resolveMartialArts, not this map.
  "Cybertech Combat": ["Brawn", "close_combat"],
  "Melee Weapons": ["Brawn", "close_combat"],
  "Throwing Weapons": ["Brawn", "close_combat"],
  "Unarmed Combat": ["Brawn", "close_combat"],
  // Finesse pool
  "Archery": ["Finesse", null],
  "Articulated Movements": ["Finesse", null],
  "Firearms": ["Finesse", "ranged_combat"],
  "Gunnery": ["Finesse", "ranged_combat"],
  "Heavy Weapons": ["Finesse", "ranged_combat"],
  "Energy Weapons": ["Finesse", "ranged_combat"],
  // Focus pool
  "Artificing": ["Focus", null],
  "Biotech": ["Focus", null],
  "Computer: Programming": ["Focus", null],
  "Negotiation": ["Focus", null],
  "Observation": ["Focus", null],
  "Reconnaissance": ["Focus", null],
  "Shadow": ["Focus", null],
  "Engineering": ["Focus", null],
  "Computer: Hacking": ["Focus", "hacking"],
  "Locksmithing": ["Focus", "hacking"],
  "Drive": ["Focus", "vehicle"],
  "Fly": ["Focus", "vehicle"],
  // Resolve pool
  "Astral Senses": ["Resolve", null],
  "Channeling": ["Resolve", null],
  "Conjuring": ["Resolve", null],
  "Sorcery": ["Resolve", null],
  "Coercion": ["Resolve", null],
  "Fascination": ["Resolve", null],
  "Leadership": ["Resolve", null],
  "Subterfuge": ["Resolve", null],
  "Survival": ["Resolve", null],
};
const POOL_NAMES = ["Brawn", "Finesse", "Focus", "Resolve"];

// Skills that cannot be attempted AT ALL without dice, where every other skill
// can be tried untrained. "Has dice" is exactly scoreSkills' `final > 0` —
// points, bonuses, or group fallback all count — so this set carries no math of
// its own; it only tells the UI which skills to mark.
//
// Keyed by NAME rather than a column on SKILLS / BUNDLE.skills, because seven of
// these exist only under a house rule and are injected at runtime: the six
// Engineering splits and Computer: Electronic Warfare are never in data.js, and
// plain "Engineering" exists only under the opposite rule (syncEngineeringSkills
// / syncEWSkill). A name set covers every shape from one place.
//
// Martial Arts and Rituals belong to the same rule but are not entries in
// SKILLS — they're their own per-style / per-ritual lists — so the UI marks
// their section headers instead.
const TRAINED_ONLY_SKILLS = new Set([
  "Cybertech Combat",
  "Drive", "Fly",
  "Biotech", "Locksmithing",
  "Computer: Hacking", "Computer: Electronic Warfare", "Computer: Programming",
  "Engineering",
  "Engineering: Aeronautics", "Engineering: Armory", "Engineering: Electronics",
  "Engineering: Industrial", "Engineering: Mechanical", "Engineering: Nautical",
  "Artificing", "Channeling", "Sorcery", "Survival", "Conjuring",
]);

const ETIQUETTES = ["Aristocratic", "Civic", "Corporate", "Criminal",
                    "Military", "Street", "Wasteland"];

const MARTIAL_ARTS_COST_MULTIPLIER = 2;

// --- priorities --------------------------------------------------------------
const PRIORITY_POOL_POINTS = 10;
const PRIORITY_MIN = 0, PRIORITY_MAX = 4;
const MAGIC_TYPE_BY_PRIORITY = { 4: "Archmage", 3: "Mage", 2: "Amp/Speaker", 1: "Hedge", 0: "Hedge" };
const MAGIC_TYPES_ALLOWED_BY_PRIORITY = {
  4: ["Amp", "Speaker", "Mage", "Archmage"],
  3: ["Amp", "Speaker", "Mage"],
  2: ["Amp", "Speaker"],
  1: ["Hedge"],
  0: ["Hedge"],
};
const HERITAGE_AVAILABILITY = [
  // [priority_low, priority_high, heritages unlocked in that range]
  [0, 0, ["Human", "Replicant"]],
  [1, 1, ["Synthetic", "Human"]],
  [2, 4, ["Blighted", "Green", "Uplift", "Synthetic", "Human"]],
];

// --- attributes --------------------------------------------------------------
const ATTRIBUTE_LEVEL_MIN = 1, ATTRIBUTE_LEVEL_MAX = 29;
const MANDATORY_ATTRIBUTE_REFUND = 6;
const ATTRIBUTE_MAX_BASELINE = 20;
const HYPERTHYROID_LIFESTYLE_SURCHARGE = 1.10;
/* Lifestyles that change how a room reads you. Wealthy's listed effect is "+1
 * die to all etiquette tests (you may roll a one-die test even with etiquette
 * 0)" — a rating point by another name, and the parenthetical is the
 * zero-bought case. The prose lives in LIFESTYLE_EFFECTS (sheet.js); this is the
 * number the engine applies. */
const LIFESTYLE_ETIQUETTE_BONUS = { Wealthy: 1 };

/* Whether an augment lifts an attribute's CEILING as well as its value.
 *
 * Muscle Replacement 3 and Strength Enhancement 3 both give +3 Strength; only
 * the first raises the cap with it. That used to be a list of seven name
 * prefixes matched with startsWith, which had two problems a data column
 * doesn't: homebrew could never express the property at all, and a name was
 * load-bearing -- renaming a core augment silently dropped it, while a homebrew
 * row called "Muscle Replacement Custom" picked it up by accident.
 *
 * "1" for yes, empty for no, following the Oneshot / Integrated Smart flags. */
function augmentRaisesMax(row) {
  return String((row && row.RaisesMax) || "").trim() === "1";
}

// --- skills ------------------------------------------------------------------
const SKILL_RANK_CAP = 6;
const EXPERTISE_SKILL_RANK_CAP = 8;
const EXPERTISE_SKILL_BONUS = 2;
const GROUP_FALLBACK_PENALTY = 2;
const GROUP_FALLBACK_MIN_TRAINED = 2;
const KNOWLEDGE_POINTS_PER_INTELLIGENCE = 2;
const ETIQUETTE_POINTS_PER_CHARISMA = 2;
const KNOWLEDGE_ETIQUETTE_RANK_CAP = 6;
const HEPHESTUS_ENGINEERING_BONUS = 2;
const CYCLOPEAN_RANGED_PENALTY = 2;
const RANGED_ATTACK_SKILLS = ["Archery", "Firearms", "Gunnery", "Throwing Weapons"];

// --- magic -------------------------------------------------------------------
const STARTING_FORCE_BY_MAGIC_TYPE = { Mage: 25, Archmage: 35 };
const SPELL_FORCE_MAX = 6;
const ARCHMAGE_SPIRIT_BIND_FORCE_COST = 15;
const SPEAKER_INFUSION_POINTS = 10;
const SPEAKER_RELATIONSHIP_POINTS = 11;
const AMP_COST_MULTIPLIER = 0.5;
const CHELONIAN_BALLISTIC_ARMOR = 2;
const CHELONIAN_IMPACT_ARMOR = 3;

// --- combat derived stats ------------------------------------------------------
const GHOST_RATING_DICE = "2d6";
const CONDITION_TRACK_BASE = 6;
const REPLICANT_BONUS_ATTRIBUTE_POINTS = 6;
const REPLICANT_BONUS_SKILL_POINTS = 6;
const BASE_MOVE_METERS = 6;
const DEFAULT_SIMPLE_ACTIONS = 2;
const ADRENALINE_BOOST_SIMPLE_ACTIONS = 3;
const COMBAT_MASTERY_MELEE_EXPLOIT_BONUS = 2;
const IRON_FIST_BASE_DAMAGE = 6;   // Iron Fist amp: unarmed = ½STR + 6, Reach 0
const WIRED_REFLEXES_MELEE_EXPLOITS_BY_RANK = { 1: 1, 2: 2, 3: 2 };
// Decks/Rigs grant one hacking/rigging exploit action per processing core.
const CORE_EXPLOIT_COUNT = { Single: 1, Double: 2, Triple: 3, Quad: 4 };
// Mage/Archmage summoning spells that grant a control exploit for the summoned
// creature (one per spell known — the creature is directed with that action).
const SUMMON_CONTROL_SPELLS = ["Create Darkenbeast", "Summon Elemental", "Bound Servant"];
/* The character arrays that Finalize hands over to play (see play.kit). Gear
 * plus knowledge skills — knowledge points are deliberately still spendable
 * after Finalize, so that list has to be play's to edit too. Anything added
 * here must also be copied by ensureKit() in sheet.js. */
const KIT_CATEGORIES = ["weapons", "armor", "gear", "augments", "decks",
  "programs", "rigs", "drones", "vehicles", "knowledge_skills"];

/* Anything that can be hardened and doesn't state a rating has 2. Decks and
 * rigs always list one; 32 weapons don't, and drones and vehicles have no such
 * column at all — which is why their Hardening read as missing rather than as
 * a number (issue #33). One default, one helper, so a blank never renders as 0
 * or as nothing. An explicit "0" is still 0. */
const DEFAULT_HARDENING = 2;
function hardeningOf(row) {
  const raw = String(((row || {}).Hardening) ?? "").trim();
  return raw === "" ? DEFAULT_HARDENING : toInt(asNumber(raw));
}

// A Speaker gets two control exploit actions per spirit slotted in a bond slot.
const SPEAKER_BOND_CONTROL_EXPLOITS = 2;
// Bonds are bought in chargen, 0-4, and that count is the ONLY authority on how
// many bond slots a character has. play.bond_slots may legitimately hold more
// entries than that — dropping the count in chargen and raising it again has to
// give the spirit back, so the extras are kept dormant rather than deleted.
// Every consumer bounds itself with speakerBondCount(); nothing trims the array.
const SPEAKER_BOND_MAX = 4;
function speakerBondCount(character) {
  return Math.max(0, Math.min(SPEAKER_BOND_MAX,
    toInt(asNumber(((character || {}).speaker || {}).bonds))));
}
// Spirits currently occupying a LIVE bond slot — bounded by speakerBondCount,
// since a dormant slot past that count is retained state (see above), not an
// active bond. A spirit bonded here is committed and can't ALSO be infused;
// resolveInfusions seeds its own dedup set from this as a safety net for a
// stale save, on top of what the picker in sheet.js already prevents.
function boundSpiritNames(character) {
  return new Set((((character || {}).play || {}).bond_slots || [])
    .slice(0, speakerBondCount(character))
    .filter(b => b && b.spirit).map(b => b.spirit));
}
/* How many hands a character has to hold weapons in, same bound-reader shape as
 * speakerBondCount: every consumer (the Loadout hand cards, the free-hand recoil
 * bonus) goes through this rather than reading either source directly. A
 * play.hand_override, when set to a non-blank value, takes priority over the
 * heritage-derived combat.hand_count -- see applyHeritage. Both are clamped the
 * same way, so an override can't produce a count the UI has no room for. */
function handCount(calc, override) {
  const base = toInt(asNumber(((calc || {}).combat || {}).hand_count, HAND_COUNT_BASE));
  const ov = (override == null || override === "") ? null : toInt(asNumber(override));
  return Math.max(1, Math.min(HAND_COUNT_MAX, ov == null ? base : ov));
}
const COVERT_SYNTHSKIN_DODGE_BONUS = 1;
const PERFECT_SITUATIONAL_AWARENESS_BONUS = 3;   // +3d dodge AND soak (amp power)
/* Recoil capacity — how many recoil tokens a shooter can absorb before it costs
 * them dice. Everyone has 1. Strength buys more, but in two flat steps rather
 * than by the point: it used to be raw Strength, which handed a heavy hitter a
 * recoil capacity in the twenties and made the whole stat meaningless for them.
 *
 * The tiers are checked highest-first and only one applies — a Strength of 24
 * is +2, NOT +1 for passing 12 and +2 again for passing 24. */
const BASE_RECOIL_CAPACITY = 1;
const RECOIL_STRENGTH_TIERS = [[24, 2], [12, 1]];
function recoilStrengthBonus(strength) {
  const tier = RECOIL_STRENGTH_TIERS.find(([floor]) => toInt(strength) >= floor);
  return tier ? tier[1] : 0;
}
/* Gun-Kata rank 3 ("Ignore Recoil") is a pistol-and-SMG discipline — it does not
 * steady a heavy machine gun. Pistol rows are typed by weight (PistolLt/Med/Hvy),
 * hence the prefix test rather than an exact match. */
const RECOIL_IGNORED_WEAPON_TYPES = ["Pistol", "SMG"];
const RECOIL_IGNORED_TYPES_LABEL = "pistols and SMGs";
function recoilIgnoredForType(type) {
  return RECOIL_IGNORED_WEAPON_TYPES.some(t => String(type || "").startsWith(t));
}

/* Gun-Kata is a ONE-HANDED discipline: a two-handed pistol or SMG gets nothing
 * from it. Every shipped Pistol/SMG row is already 1H, so this only bites
 * homebrew -- which is exactly where an unstated assumption would go wrong.
 * A row with no Hands column counts as 1H (weaponHands' default), which is the
 * right answer for cyberguns: they are typed in prose and carry no Hands. */
function recoilIgnoredForWeapon(row) {
  return recoilIgnoredForType((row || {}).Type) && weaponHands(row) === 1;
}

/* A cybergun's recoil: DOUBLE the character's own capacity.
 *
 * The gun is braced against the frame of a cybertechtronic arm rather than
 * against a shoulder, and the Cybergun Installation row has always said so.
 * Its wording is "your Strength is doubled for calculating recoil capacity",
 * which was the same thing as doubling the capacity back when capacity simply
 * WAS Strength. It isn't any more (#50 made Strength buy capacity in two flat
 * steps), and doubling the input now barely moves the output — at Strength 24
 * it does nothing at all, because the top tier is already reached. Doubling the
 * result is what preserves the intent, and is the ruling applied here.
 *
 * Implanted guns take no weapon mods, so there is nothing per-gun to add on top.
 *
 * Their Type is prose ("Palm Pistol", "Forearm SMG"), which is why this tests
 * the words rather than reusing recoilIgnoredForType's prefix match: a Forearm
 * SMG starts with "Forearm", not "SMG". Shotgun and Heavy Pistol cyberguns exist
 * too, and a Shotgun correctly gets no relief from Gun-Kata. */
const CYBERGUN_RECOIL_MULTIPLIER = 2;
function cybergunRecoil(gunRow, combat) {
  const type = String((gunRow || {}).Type || "");
  const isPistolOrSmg = RECOIL_IGNORED_WEAPON_TYPES.some(
    t => new RegExp(`\\b${t}\\b`, "i").test(type));
  const base = toInt((combat || {}).recoil_capacity);
  return {
    Recoil: base * CYBERGUN_RECOIL_MULTIPLIER,
    // Reported as a mod so the stat line can show where the extra came from,
    // the same way a bipod's +1 is shown on an ordinary gun.
    recoil_mod: base * (CYBERGUN_RECOIL_MULTIPLIER - 1),
    recoil_mod_label: "implanted",
    recoil_ignored: Boolean((combat || {}).recoil_ignored) && isPistolOrSmg,
  };
}
const GYROMOUNT_RECOIL_BONUS = 2;
const PLATELET_DAMAGE_REDUCTION = 1;
// Augments granting a special sense or immunity (no numeric stat) — surfaced as
// a "senses & immunities" summary rather than folded into a derived number.
const SENSE_AUGMENTS = new Set([
  "Low-Light", "Thermographic", "Flare Compensation", "Augmented Eyesight",
  "Echolocation Positioning", "Dampener", "Gills", "Metabolic Stasis",
  "Broadcast Jammer", "Covert Synthskin", "Shimmerskin",
]);

/* ---- House rules (per-character, player-toggleable) ------------------------
 * A registry of optional rule variants the table can switch on. Each rule has
 * an id, a label, a set of options (value + label + help), and a default. Read
 * the active choice via houseRule(id) wherever a rule branches; the settings UI
 * (app.js) flips it with setHouseRule(). Choices live on each character
 * (character.house_rules) and are saved/synced with the character, so changing a
 * rule on one character never affects another.
 *
 * EVERY rule defaults to its "Classic" option -- the rules as written -- so a
 * fresh character starts by the book and each house rule is an explicit opt-in.
 * Keep it that way when adding a rule: list Classic first and make it the
 * default. (Note "currency"'s Classic value is "zuzus", not "classic".)
 *
 * Characters that already store house_rules are never touched by a default
 * change; only new characters, and legacy saves with no house_rules key at all,
 * pick up the defaults. Add a rule by appending a def here and branching on
 * houseRule(<id>) at the relevant point in the engine. */
const HOUSE_RULE_DEFS = [
  { id: "zr", label: "Zoetic Rating", default: "classic",
    options: [
      { value: "classic", label: "Classic",
        help: "Per-augment ZR; cyber eyes/ears absorb 0.5, each cyberlimb 1.0. "
          + "Cyberarms and cyberlegs cost double — ㄓ75,000 chromed, ㄓ100,000 "
          + "synthetic — to offset how much ZR they soak up." },
      { value: "houserule", label: "ZR Casting Penalty",
        help: "Gear/weapon ZR doesn't touch ZP — it's −1d per full point on casting rolls (Channeling/Conjuring/Sorcery). Cyber ZR reduces ZP directly (may go negative; Synthetics exempt). At ZP ≤ 0 only Rituals work." },
    ] },
  { id: "priorities", label: "Priorities", default: "classic",
    options: [
      { value: "classic", label: "Classic — A–E",
        help: "Assign the letters A, B, C, D, E (= priority 4, 3, 2, 1, 0) across the five categories — each letter used exactly once." },
      { value: "point", label: "Point-based",
        help: "Distribute 10 priority points, 0–4 per category; values may repeat." },
    ] },
  { id: "currency", label: "Currency name", default: "zuzus",
    options: [
      { value: "zuzus", label: "Classic — Zuzus",
        help: "The setting's money is called Zuzus." },
      { value: "woolongs", label: "House rule — Woolongs",
        help: "The setting's money is called Woolongs." },
    ] },
  { id: "ew", label: "Electronic Warfare", default: "classic",
    options: [
      { value: "classic", label: "Classic — EW skill",
        help: "Adds a Computer: Electronic Warfare skill to the Computer group; the camera hack actions and the EW programs (Analysis Locus, Corrupt IFF, Acid Burn, De-Rez, Hypnotic Projection, Refraction Field, Targeted Disruption, Device Control) roll it." },
      { value: "houserule", label: "House rule — No EW skill",
        help: "No separate EW skill; those actions and programs use Computer: Hacking instead." },
    ] },
  { id: "engineering", label: "Engineering skills", default: "classic",
    options: [
      { value: "classic", label: "Classic (six skills)",
        help: "Engineering splits into a six-skill group — Aeronautics, Armory, Electronics, Industrial, Mechanical, Nautical. Like Ranged Weapons, an untrained member rolls the group's best −2." },
      { value: "single", label: "Single skill",
        help: "One Engineering skill covers every discipline." },
    ] },
  { id: "recoil", label: "Recoil", default: "classic",
    options: [
      { value: "classic", label: "Classic",
        help: "Firing generates recoil tokens; your Recoil Capacity is how many you absorb before they cost you, and gear that steadies a gun raises it." },
      { value: "houserule", label: "No Recoil",
        help: "Recoil stops existing — no Recoil Capacity, no tokens, nothing to stabilize. The gear that used to soak it pays out bonus dice instead: Bi-pod +1b braced; Gyro-mount and Gas Vent +1b; the Gyromount augment +3b; Gun-Kata 3 +3b — each on any firing mode that isn't SS." },
    ] },
];

// House rule: the single Engineering skill can split into a six-skill group.
const ENGINEERING_GROUP = "engineering";
const ENGINEERING_SPLIT_SKILLS = [
  "Engineering: Aeronautics", "Engineering: Armory", "Engineering: Electronics",
  "Engineering: Industrial", "Engineering: Mechanical", "Engineering: Nautical",
];

// Reshape the skill set to match the Engineering house rule. Mutates both SKILLS
// (the engine map) and the data bundle's skills map (the UI's source) so every
// consumer sees the same set. Idempotent — safe to run on each calculate().
// Character skill points for the inactive shape are left untouched, so toggling
// the rule back restores them.
function syncEngineeringSkills() {
  const classic = houseRule("engineering") === "classic";
  // The UI reads the bundle's top-level `skills` map (DATA.skills); loadData()
  // only exposes BUNDLE.tables, so mutate BUNDLE.skills directly here.
  const dskills = (BUNDLE.skills = BUNDLE.skills || {});
  if (classic) {
    delete SKILLS["Engineering"]; delete dskills["Engineering"];
    for (const name of ENGINEERING_SPLIT_SKILLS) {
      SKILLS[name] = ["Focus", ENGINEERING_GROUP];
      dskills[name] = { pool: "Focus", group: ENGINEERING_GROUP };
    }
  } else {
    for (const name of ENGINEERING_SPLIT_SKILLS) { delete SKILLS[name]; delete dskills[name]; }
    SKILLS["Engineering"] = ["Focus", null];
    dskills["Engineering"] = { pool: "Focus" };
  }
}

// House rule: the "Classic" Electronic Warfare rule adds a dedicated
// Computer: Electronic Warfare skill to the Computer (hacking) group. Same
// idempotent SKILLS + BUNDLE.skills reshaping as syncEngineeringSkills; points
// for the inactive shape are left untouched so toggling back restores them.
const EW_SKILL = "Computer: Electronic Warfare";
function syncEWSkill() {
  const classic = houseRule("ew") === "classic";
  const dskills = (BUNDLE.skills = BUNDLE.skills || {});
  if (classic) {
    SKILLS[EW_SKILL] = ["Focus", "hacking"];
    dskills[EW_SKILL] = { pool: "Focus", group: "hacking" };
  } else {
    delete SKILLS[EW_SKILL];
    delete dskills[EW_SKILL];
  }
}

/* ---- House rule: "No Recoil" (#61) ------------------------------------------
 * Under this rule recoil is not a thing that exists. There is no Recoil
 * Capacity, no tokens to soak and nothing to stabilize — so the gear that
 * bought recoil capacity has to be worth something else, and what it buys
 * instead is BONUS DICE ("+1b" is one bonus die), on any firing mode that isn't
 * a single shot. A Bi-pod is the exception: it pays out only when the gun is
 * braced, which is a thing the player declares at the table.
 *
 * WHY THE ALTERNATE WORDING LIVES HERE AND NOT IN data.js: Classic still needs
 * the as-written text, so one data row has to serve both rules. Rewriting the
 * row would break Classic for every character who never opted in. Instead the
 * rule is resolved in the engine — syncNoRecoilText() retargets each affected
 * row's Effect at recalc time and keeps the row's original text in
 * NO_RECOIL_AS_WRITTEN, so switching back restores exactly what the data says
 * (rather than a copy of it here that could go stale). That is the same shape
 * as syncEngineeringSkills/syncEWSkill: reshape the shared tables to match the
 * active rule, idempotently. Every display site — chargen, the sheet, exports,
 * the homebrew editor's builtin list, tooltips — then reads the right wording
 * without any of them having to know this rule exists.
 *
 * `dice` is what the piece is worth and `when` says when it counts:
 *   "nonss"  — any firing mode other than SS. The sheet applies it on its own.
 *   "braced" — the player declares it, so the sheet offers it as a per-weapon
 *              toggle beside the Gun-Kata one rather than assuming a bipod is
 *              always deployed.
 * `types` narrows a source to weapon types it can apply to (Gun-Kata is a
 * pistol-and-SMG discipline — see RECOIL_IGNORED_WEAPON_TYPES, which is the
 * same restriction its Classic "Ignore Recoil" already carries). */
const NO_RECOIL_NONSS = "when using any firing mode that's not SS";
const NO_RECOIL_EFFECTS = [
  { id: "mod:bipod", table: "weapon_mods", col: "Effect", label: "Bi-pod",
    match: row => row.Modification === "Bi-pod (Rifle Only)",
    text: "+1b when braced.", dice: 1, when: "braced" },
  { id: "mod:gyro", table: "weapon_mods", col: "Effect", label: "Gyro-mount",
    match: row => row.Modification === "Gyro-mount",
    text: `+1b ${NO_RECOIL_NONSS}.`, dice: 1, when: "nonss" },
  { id: "mod:gasvent", table: "weapon_mods", col: "Effect", label: "Gas Vent",
    match: row => row.Modification === "Gas Vent",
    text: `+1b ${NO_RECOIL_NONSS}.`, dice: 1, when: "nonss" },
  { id: "augment:gyromount", table: "augments", col: "Effect", label: "Gyromount",
    match: row => row.Name === "Gyromount",
    text: `+3b ${NO_RECOIL_NONSS}.`, dice: 3, when: "nonss" },
  // Gun-Kata 3's displayed wording is the issue's, not a generated one: the
  // level does two things and only the second changes, so the split-fire half
  // is carried through verbatim.
  { id: "ma:gunkata3", table: "martial_arts", col: "Effect", label: "Gun-Kata 3",
    match: row => /^gun.?kata$/i.test(String(row.Style || ""))
      && toInt(asNumber(row.Level)) === 3,
    text: "Can split fire with no penalty. +3b when a fire mode that's not SS.",
    dice: 3, when: "nonss", types: RECOIL_IGNORED_WEAPON_TYPES },
];
// row object -> the Effect text the data actually ships, captured the first time
// that row is retargeted. Keyed by row identity so a homebrew row that happens
// to share a name is untouched unless it matched, and so nothing here has to
// hardcode a copy of the data.
const NO_RECOIL_AS_WRITTEN = new Map();

function noRecoilActive() { return houseRule("recoil") === "houserule"; }
/** Classic recoil is the only rule under which recoil is a number worth showing. */
function recoilInPlay() { return !noRecoilActive(); }

// Idempotent: safe to run on every calculate(), and it must run BEFORE the
// martial arts are resolved — martialArtStatMods reads Gun-Kata 3's text to
// decide `recoil_ignored`, and under this rule that text no longer says it.
function syncNoRecoilText() {
  const on = noRecoilActive();
  const tables = BUNDLE.tables || {};
  for (const spec of NO_RECOIL_EFFECTS) {
    for (const row of tables[spec.table] || []) {
      if (!spec.match(row)) continue;
      if (!NO_RECOIL_AS_WRITTEN.has(row)) NO_RECOIL_AS_WRITTEN.set(row, row[spec.col]);
      row[spec.col] = on ? spec.text : NO_RECOIL_AS_WRITTEN.get(row);
    }
  }
}

const noRecoilSpec = id => NO_RECOIL_EFFECTS.find(s => s.id === id);

/* The bonus-dice sources this rule gives the CHARACTER (as opposed to a
 * particular gun): the Gyromount augment and Gun-Kata 3. Resolved in calculate()
 * onto combat.no_recoil_sources so the sheet can ask one question per weapon. */
function noRecoilCharacterSources(augments, martialArt) {
  if (!noRecoilActive()) return [];
  const out = [];
  const gyros = toInt((augments || {}).gyromount_count);
  if (gyros) {
    const spec = noRecoilSpec("augment:gyromount");
    // Cumulative with other gyroscopic mounts, exactly as the augment's own
    // description says — the same reason Classic scales its +2 by the count.
    out.push({ id: spec.id, label: spec.label, dice: spec.dice * gyros, when: spec.when });
  }
  for (const level of ((martialArt || {}).levels) || []) {
    const spec = NO_RECOIL_EFFECTS.find(s => s.table === "martial_arts" && s.match(level));
    if (spec) out.push({ id: spec.id, label: spec.label, dice: spec.dice,
                         when: spec.when, types: spec.types });
  }
  return out;
}

/* Every bonus-dice source this rule gives ONE gun: whatever is bolted to it,
 * plus the character-wide sources that reach a weapon of this type.
 * `modNames` is the fitted + integrated mod names; `combat` is CALC.combat.
 * Returns [{ id, label, dice, when }] — the caller decides which are live,
 * because "nonss" is a fact about the selected mode and "braced" is a
 * declaration only the player can make. Empty under the Classic rule. */
function noRecoilBonuses(weaponType, modNames, combat, hands = 1) {
  if (!noRecoilActive()) return [];
  const fitted = new Set((modNames || []).map(n => String(n || "").trim()));
  const out = [];
  for (const spec of NO_RECOIL_EFFECTS) {
    if (spec.table !== "weapon_mods") continue;
    for (const row of (BUNDLE.tables.weapon_mods || []))
      if (spec.match(row) && fitted.has(String(row.Modification).trim())) {
        out.push({ id: spec.id, label: spec.label, dice: spec.dice, when: spec.when });
        break;   // one row per spec; a mod fitted and integrated is still one mod
      }
  }
  for (const src of ((combat || {}).no_recoil_sources) || []) {
    // A typed source is Gun-Kata, which is one-handed pistols and SMGs both.
    if (src.types && !(hands === 1 && src.types.some(t => weaponTypeIs(weaponType, t)))) continue;
    out.push({ id: src.id, label: src.label, dice: src.dice, when: src.when });
  }
  return out;
}

/* Does a weapon's Type belong to a category? Both of the app's existing tests
 * are needed: owned weapons are typed by weight and want the prefix match
 * ("PistolHvy" is a Pistol — recoilIgnoredForType), while a cybergun's Type is
 * prose and wants the word match ("Forearm SMG" is an SMG — cybergunRecoil).
 * One weapon list feeds both, so ask both. */
function weaponTypeIs(type, category) {
  const t = String(type || "");
  return t.startsWith(category) || new RegExp(`\\b${category}\\b`, "i").test(t);
}

/* Free actions that stop existing under this rule. "Stabilize a gun" is recoil
 * housekeeping, and there is no recoil to keep house on. Matched on the text so
 * the reference table stays plain data. */
function actionRefHidden(item) {
  return noRecoilActive() && /\bstabiliz/i.test(String(item || ""));
}
// House rules are PER CHARACTER, stored on `character.house_rules`. The engine
// reads the active character's choices via houseRule() (activeHouseRules is
// pointed at that character's rules at the top of calculate()); the UI flips one
// with setHouseRule() and then persists the character. Changing a rule on one
// character never affects another.
// Legacy: earlier builds kept a single GLOBAL pref in localStorage. Read it once
// to seed characters that predate per-character rules, so their behaviour carries
// over unchanged on first load.
const LEGACY_HOUSE_RULES = (() => {
  try {
    if (typeof localStorage !== "undefined") {
      const saved = JSON.parse(localStorage.getItem("sinless:houserules") || "null");
      if (saved && typeof saved === "object") return saved;
    }
  } catch { /* blocked/absent localStorage */ }
  return null;
})();
const legacyOrDefault = def =>
  (LEGACY_HOUSE_RULES && def.options.some(o => o.value === LEGACY_HOUSE_RULES[def.id]))
    ? LEGACY_HOUSE_RULES[def.id] : def.default;
function defaultHouseRules() {
  const hr = {};
  for (const def of HOUSE_RULE_DEFS) hr[def.id] = legacyOrDefault(def);
  return hr;
}
// Repair/seed a character's house_rules IN PLACE (invalid or missing values fall
// back to the legacy global, then the rule's default) and return that same object
// so the UI's setHouseRule mutations land on the character.
function normalizeHouseRules(character) {
  const hr = character.house_rules || (character.house_rules = {});
  for (const def of HOUSE_RULE_DEFS)
    if (!def.options.some(o => o.value === hr[def.id])) hr[def.id] = legacyOrDefault(def);
  return hr;
}
let activeHouseRules = null;
function houseRule(id) {
  return (activeHouseRules && activeHouseRules[id])
    ?? (HOUSE_RULE_DEFS.find(d => d.id === id) || {}).default;
}
function setHouseRule(id, value) {
  const def = HOUSE_RULE_DEFS.find(d => d.id === id);
  if (!def || !def.options.some(o => o.value === value)) return;
  if (activeHouseRules) activeHouseRules[id] = value;   // written onto the active character
}
// The setting's money name, per the "currency" house rule. Reads the active
// character's choice (activeHouseRules is pointed at it during calculate(), so
// render code that runs after recalc sees the right value).
function currencyName() {
  return houseRule("currency") === "zuzus" ? "Zuzus" : "Woolongs";
}
/* ...and its glyph, which follows the name. Zuzus keep ㄓ; Woolongs use ₩.
 * A function rather than a constant because the rule is per character and can
 * change between renders — anything that caches this at load time will show one
 * character's money on another's sheet. */
function currencySymbol() {
  return houseRule("currency") === "zuzus" ? "ㄓ" : "₩";
}

// Programs (any rating) that key off Electronic Warfare under the Classic EW
// rule, and Computer: Hacking otherwise. Matched by base name (rating stripped).
const EW_PROGRAM_BASES = new Set([
  "Analysis Locus", "Corrupt IFF", "Acid Burn", "De-Rez",
  "Hypnotic Projection", "Refraction Field", "Targeted Disruption", "Device Control",
]);
function isEWProgram(name) {
  return EW_PROGRAM_BASES.has(String(name || "").replace(/\s+\d+$/, "").trim());
}
/* Programs with these I/O values run WITHOUT occupying one of the deck's
 * threads, so they are never "loaded" in the play sheet's sense — they are
 * simply on whenever the deck is. The Decking tab's Load button and the gear-ZR
 * rule both key off this, so they can't disagree about what "loaded" means. */
const PROGRAM_NO_THREAD_IO = new Set(["N/A", "No"]);
/* The Hacking family is "Hacking N", rated by the trailing number, the same
 * convention Acid Burn and the other rated families use. Its own category in
 * the programs table keeps it out of the Attack/Control/Utility browsers — it
 * isn't a tool you run, it's what makes the deck run. */
const HACKING_PROGRAM_CATEGORY = "Hacking";
const HACKING_PROGRAM_RE = /^Hacking\s+(\d+)$/i;
function isHackingProgram(name) { return HACKING_PROGRAM_RE.test(String(name || "").trim()); }
function hackingProgramRating(name) {
  const m = HACKING_PROGRAM_RE.exec(String(name || "").trim());
  return m ? toInt(m[1]) : 0;
}
/* What a deck needs to run properly: ½ MCP, rounded down, minimum 1. */
function deckHackingRequired(deckRow) {
  return Math.max(1, Math.floor(toInt(asNumber((deckRow || {}).MCP)) / 2));
}

/* How far a deck reaches. Every deck hacks at 10 m; two mods extend it, and the
 * distance is read out of the mod's own Effect text ("Extends Hacking range to
 * 15m") rather than kept in a lookup here. That's deliberate: a homebrew deck
 * mod that says the same thing works without the engine being taught about it,
 * which is the whole promise of the homebrew editor, and the number can never
 * drift from the text a player reads on the mod.
 *
 * Range is set, not added — a mod says what the range BECOMES. Only one such mod
 * is allowed per deck (see deckRangeConflict); when a saved deck somehow carries
 * both, the longer wins so the reported figure stays deterministic while the
 * error tells the player to drop one. */
const BASE_HACK_RANGE_METERS = 10;
const HACK_RANGE_RE = /hacking range to\s*(\d+)\s*m/i;
function hackRangeOfMod(modRow) {
  const m = HACK_RANGE_RE.exec(String((modRow || {}).Effect || ""));
  return m ? toInt(m[1]) : 0;
}
function deckRangeMods(entry, data) {
  return (((entry || {}).mods) || [])
    .map(name => findRow(data.deck_mods, "Deck Mod", name))
    .filter(row => row && hackRangeOfMod(row) > 0);
}
function deckHackRange(entry, data) {
  const ranges = deckRangeMods(entry, data).map(hackRangeOfMod);
  return ranges.length ? Math.max(...ranges) : BASE_HACK_RANGE_METERS;
}
function deckRangeConflict(entry, data) {
  const rows = deckRangeMods(entry, data);
  return rows.length > 1 ? rows.map(r => r["Deck Mod"]) : null;
}

/* Hardening written into an effect line — "+1 Hardening", "+2 Vehicle/Drone
 * Hardening". The unit-mod scanner on the sheet has read hardening this way for
 * a while; this is the same test, shared so decks, rigs and units can't drift
 * apart on what counts. */
const HARDENING_TEXT_RE = /([+-]?\d+)\s*(?:Base\s+)?(?:[A-Za-z/]+\s+)?Hardening/i;
function hardeningBonusFromText(text) {
  const m = HARDENING_TEXT_RE.exec(String(text || ""));
  return m ? toInt(m[1]) : 0;
}

/* A deck's Hardening: its own, plus every fitted mod that raises it.
 *
 * deck_mods has no Hardening column — Input Validation states its "+1 Hardening"
 * in prose and nothing read it, so fitting it did nothing at all (#44). Parsing
 * the text rather than adding a column keeps homebrew deck mods working the
 * moment they're written, the same choice deckHackRange makes. */
function deckHardening(entry, data) {
  const row = findRow(data.decks, "Name", (entry || {}).name) || {};
  let total = hardeningOf(row);
  for (const modName of ((entry || {}).mods) || []) {
    const modRow = findRow(data.deck_mods, "Deck Mod", modName);
    if (modRow) total += hardeningBonusFromText(modRow.Effect);
  }
  return total;
}

/* Hardening a rig's mods confer on the units it's flying.
 *
 * Read the effect text and it's clear these were never meant for the rig
 * itself: "+1 Vehicle/Drone Hardening". rigStats has been adding them to the
 * rig's own Hardening, where they protect nothing that gets shot at — the rig
 * is in your skull, the drone is downrange. Only the equipped rig counts, since
 * only one is jacked in, and only linked units benefit: the bonus travels down
 * the VCR link, so a drone running loose on its own autopilot is on its own. */
function rigUnitHardening(character, data) {
  const rigs = character.rigs || [];
  // Same "chosen, else the first owned" fallback the ZR tally and the Rigging
  // tab both use, so all three agree on which rig is jacked in.
  const chosen = ((character.play || {}).rigging || {}).active_rig;
  const equipped = rigs.find(r => r.name === chosen) || rigs[0];
  if (!equipped) return 0;
  let total = 0;
  for (const modName of equipped.mods || []) {
    const modRow = findRow(data.rig_mods, "Rig Mod", modName);
    if (!modRow) continue;
    // The column is authoritative where it exists; the text covers homebrew
    // that only says it in prose.
    total += String(modRow.Hardening || "").trim() !== ""
      ? toInt(asNumber(modRow.Hardening))
      : hardeningBonusFromText(modRow.Effect);
  }
  return total;
}

/* Exactly one deck and one rig are equipped — jacked in — at a time. A
 * character may own and carry any number; only the equipped one contributes
 * Zoetic Rating and exploit actions, and only it needs to actually run. The
 * choice is a single name, so two can never be marked. Falls back to the first
 * owned entry for characters that never made a choice. */
function equippedDeckName(character) {
  const decks = (character || {}).decks || [];
  const decking = ((character || {}).play || {}).decking || {};
  // Jacked out: a deck the character owns and carries, but isn't running. The
  // fallback below is what makes this a stored flag rather than an empty
  // `active_deck` — "" already means "never chose", and both of those have to
  // keep resolving to the first owned deck or every character who never opened
  // the Decking tab would silently stop running theirs.
  if (decking.jacked_out) return "";
  const chosen = decking.active_deck;
  return decks.some(d => d.name === chosen) ? chosen : ((decks[0] || {}).name || "");
}

function programNeedsThread(row) {
  return !PROGRAM_NO_THREAD_IO.has(String((row || {})["I/O"] || "").trim());
}

// The skill an EW program rolls, per the EW house rule; null for non-EW programs.
function programSkill(name) {
  if (!isEWProgram(name)) return null;
  return houseRule("ew") === "classic" ? EW_SKILL : "Computer: Hacking";
}

/* The default hacking skill, named once so the Run Program button (#79) and
 * anything else that reaches for it can't drift from the SKILLS key. */
const HACKING_SKILL = "Computer: Hacking";

/* Every rated program is "<Base> N" — the same trailing-number convention
 * hackingProgramRating reads, generalised, because running a program rolls its
 * rating as dice (#79) and that is true of the whole table, not just the
 * Hacking family. "Alert Monitor" is the one unrated program; it comes back 0,
 * which is exactly right — it contributes no rating dice. */
function programRating(name) {
  const m = /\s(\d+)$/.exec(String(name || "").trim());
  return m ? toInt(m[1]) : 0;
}

/* What running a program costs the action economy, counted in SIMPLE ACTIONS
 * because that is the unit the play sheet actually spends (#79): a Complex
 * Action is two Simples, and "N/A" — the Hacking family, which is the deck's
 * operating system rather than a tool you run — costs nothing.
 *
 * The issue words this as "the action type named in the Program's Description",
 * but the programs table carries a dedicated `Action Type` column that says the
 * same thing in one word instead of a paragraph; reading the column keeps
 * homebrew programs working without prose-parsing, and the two agree. */
const PROGRAM_ACTION_UNITS = { Complex: 2, Simple: 1 };
function programActionUnits(row) {
  return PROGRAM_ACTION_UNITS[String((row || {})["Action Type"] || "").trim()] || 0;
}
// The label for a hack-action's Skill cell: "EW" stays "EW" under Classic but
// reads "Hacking" when there's no EW skill; everything else is unchanged.
function hackActionSkill(skillCode) {
  if (skillCode === "EW") return houseRule("ew") === "classic" ? "EW" : "Hacking";
  return skillCode;
}
// NB: the cyber ZR *value* (raw minus eyes/ears/limb absorption) is the same
// under both ZR house rules; only how that ZR is *applied* differs — see the
// zpRemaining / casting-penalty branches in calculate() gated on houseRule("zr").
const MOVEMENT_ENHANCEMENT_METERS_PER_RATING = 2;

// --- gear & money --------------------------------------------------------------
const SMART_WEAPON_COST_MULTIPLIER = 2;
const EXTRA_LIMB_ARMOR_COST_MULTIPLIER = 1.5;   // Extra Arm / Extra Leg: +50% armor
// Everyone starts with two hands to hold a weapon in. An "Extra Arm" heritage
// trait or a Heavy Torso mount picked as "Cyberarm" adds one apiece -- see
// applyHeritage's hand_count below, and handCount() for the bound reader every
// consumer of it goes through (same shape as speakerBondCount).
const HAND_COUNT_BASE = 2;
const HAND_COUNT_MAX = 6;
const HACKING_RATING_COST = 5000;
const HACKING_RATING_MAX = 6;

// The small-heritage gear surcharge (Small Uplifts and the Green "Smol" bane
// carry GearCostMultiplier 1.4) only applies to physical kit a small body must
// be fitted for: Weapons, Armor, Vehicles, and cybertechtronic Augments.
// Bioware (grown to fit), Drones, Rigs, Decks/Programs, misc Gear, and
// Lifestyle pay face value. Both the engine and the play-mode buy screens read
// this through surchargeFor() so the two never disagree.
const SURCHARGED_KINDS = new Set(["weapon", "armor", "vehicle", "cyberware"]);
function surchargeFor(kind, baseMultiplier) {
  return SURCHARGED_KINDS.has(kind) ? (baseMultiplier || 1) : 1;
}

// ============================================================== data access
function loadData() {
  return BUNDLE.tables;
}

/** Python int(): truncate toward zero. */
const toInt = v => Math.trunc(v);
/** Python round(x, 2), close enough for money values. */
const round2 = v => Math.round(v * 100) / 100;

function asNumber(value, dflt = 0) {
  // Parse a data-table cell to a number: strip thousands commas, else `dflt`.
  if (value === null || value === undefined || typeof value === "boolean") return dflt;
  const s = String(value).replace(/,/g, "").trim();
  if (s === "") return dflt;
  const n = Number(s);
  return Number.isNaN(n) ? dflt : n;
}

/* Find a data-table row by its key column. Returns the FIRST match (weapon_mods
 * has intentional same-name rows per Slot, so name-only lookups there resolve to
 * the Overbarrel variant) or null. Which column keys which table is catalogued in
 * docs/DATA.md; tools/check_data.py verifies the literal call sites below stay in
 * sync with HOMEBREW_CONFIG and the promoter's NAME_KEYS. Call sites that pass the
 * table or column through a variable are invisible to that check. */
function findRow(rows, column, value) {
  const target = String(value || "").trim();
  for (const row of rows) {
    if (String(row[column] ?? "").trim() === target) return row;
  }
  return null;
}

const sumBy = (items, fn) => items.reduce((total, item) => total + fn(item), 0);
const maxOf = (values, dflt) => values.length ? Math.max(...values) : dflt;

// ============================================================== character shape
function defaultCharacter() {
  const attributes = {};
  for (const name of ATTRIBUTES) attributes[name] = 1;
  return {
    name: "",
    player: "",
    description: "",
    notes: "",
    // The build this character was generated under. mergeDefaults deliberately
    // does NOT let this default reach an older file — see APP_VERSION.
    app_version: APP_VERSION,
    house_rules: defaultHouseRules(),   // per-character optional rule variants
    priorities: { heritage: 0, magic: 0, attributes: 0, skills: 0, resources: 0 },
    heritage: {
      type: "Human",
      uplift_type: "",
      features: [],
      blessing_plus3: "",
      blessing_plus1: "",
      specialization_pool: "",
      heavy_torso_mounts: ["", ""],   // Heavy Torso: up to 2 free 1-wt mounts
      no_head_mount: "",              // No Head: one free 1-wt weapon mount
      snake_attack: "bite",           // Snake uplift: "bite" or "spit" (locked after chargen)
    },
    attributes,
    cha_pool_choice: "Brawn",
    skills: {},
    skill_specializations: {},
    ritual_skills: {},
    knowledge_skills: [],
    etiquettes: {},
    martial_arts: [],   // [{style, rank}] — each an independent Martial Arts skill
    magic: {
      chosen_type: "Amp",
      school: "",
      spells: [],
      amp_powers: [],
      archmage_bind: false,
    },
    speaker: {
      relationships: [],
      bonds: 0,
      infusions: [],
    },
    augments: [],
    weapons: [],
    armor: [],
    decks: [],
    programs: [],
    // Legacy: replaced by a Hacking program slotted into each deck. Read once
    // by migrateHackingProgram() in sheet.js, then cleared.
    hacking_rating: 0,
    rigs: [],
    drones: [],
    vehicles: [],
    gear: [],
    lifestyle: { name: "", months: 0 },   // no default lifestyle — must be chosen in chargen
    lifestyles: [],
    finalized: false,
    play: {
      cash: 0,
      cash_rolled: false,
      starting_cash: 0,
      cash_log: [],
      lifestyles: [],
      lifestyles_seeded: false,
      // What the CHARGEN record said at the last sync, per lifestyle name.
      // play.lifestyles[].months is months REMAINING and drifts as they are
      // burned or prepaid; this is the yardstick that says whether a change
      // came from play or from someone editing the chargen purchase itself.
      lifestyles_baseline: {},
      // Cleared once a character finalized before 2026-08-05 has had its play
      // months reconciled with chargen. See reconcileLifestyles in sheet.js.
      lifestyles_reconciled: false,
      kismet: 0,
      kismet_earned: 0,
      kismet_log: [],
      boons_spent: 0,
      major_boons_spent: 0,
      physical_damage: 0,
      stun_damage: 0,
      initiative: 0,
      dodge_dice: 0,
      replicant_lifespan_months: null,   // Replicant only: (1d6+1)×12, rolled once
      // Which of CALC.pool_effects are switched on right now (id -> true). The
      // swing they add is applied by the sheet on top of CALC, never baked into
      // it — see derivePoolEffects.
      pool_effects: {},
      // Doses taken and not yet worn off: [{ uid, name, at }], one entry per
      // dose so two of the same drug can be dismissed independently. Drives the
      // gear half of pool_effects — see gearIsDose.
      doses: [],
      beast_dice: WILDLING_BEAST_DICE,   // Wildling: "Beast" dice left this round
      // Decker: MCP dice left this round, spent before Focus when a program is
      // run (#79). The MAX is derived from the active deck's MCP, so only what
      // is left gets stored — null means "never touched, assume full", the same
      // read beast_dice gets, so buying a bigger deck mid-round isn't punished.
      mcp_dice: null,
      pool_used: {},
      // Actions spent so far this round, keyed "simple" or an exploit kind
      // ("Melee", "Rigging", …). Cleared by New Round alongside the pools.
      actions_used: {},
      effects: [],
      modifiers: [],
      notes: "",
      attribute_advances: {},
      skill_advances: {},
      etiquette_advances: {},     // { etiquette name: +ranks } bought with Kismet in play
      martial_art_advances: {},   // { style: +ranks } bought in play
      ritual_advances: {},
      zp_advances: 0,
      spell_force_advances: {},
      // Spells sold or forgotten in play, by name (#82). Spells are the one
      // bought-with-cash thing that is NOT in `play.kit` -- KIT_CATEGORIES has
      // no "spells", because magic lives under character.magic rather than in a
      // top-level array -- so play cannot simply splice the list it renders the
      // way it does for gear. Splicing CHAR.magic.spells would cross the bright
      // line and hand the spell's price back to the CREATION budget.
      //
      // A name list is therefore the play-side record, in the same spirit as
      // the `disposed` map the kit replaced, and applyPlayAdvances subtracts it
      // below. Names, not indices: a name survives a save/load round trip and a
      // chargen edit that reorders the list, and a spell can only be known once
      // (the learn picker hides anything already known), so a name is unique.
      spells_forgotten: [],
      // ---- THE BRIGHT LINE ----------------------------------------------
      // What the character walked out of creation with, copied into play at
      // Finalize. From that moment play owns this outright: worn flags, fitted
      // mods, quantities, α-grades, sales, losses, reordering — all of it edits
      // `kit`, and the chargen arrays on the character are never written to
      // again. That is the whole invariant, and it is what makes the creation
      // budget stable, Back to Chargen show the character exactly as built, and
      // Revert restore everything by simply rebuilding this from chargen.
      //
      // Before this existed, play mutated the chargen objects in place, and
      // every leak we chased was a symptom: burning ammo re-priced the creation
      // budget, α-grading an augment charged creation cash, selling a weapon
      // refunded it. Three separate patches (`disposed`, `fitted_mods` /
      // `disposed_mods`, `unit_overrides`) each covered one path; this replaces
      // all three. They are still READ below so characters saved before
      // 2026-08-05 render correctly until ensureKit() migrates them.
      //
      // null until a character is finalized for the first time.
      kit: null,
      // Play's own copy of the description, so editing it at the table doesn't
      // rewrite the chargen record. null falls back to the chargen text.
      description: null,
      // What creation cost, frozen at Finalize: { starting_cash, categories,
      // spent, remaining }. A finalized character's budget line is a record of
      // what the build cost, not a running total of what they are carrying —
      // selling a rifle in play shouldn't make the creation budget look
      // cheaper. Re-taken on every finalize, since the build may legitimately
      // have changed. null on a character finalized before 2026-08-05;
      // ensureCreationBudget() fills it once. The two cost multipliers are NOT
      // frozen — they come from heritage and price what play buys today.
      creation_budget: null,
      // What the chargen record looked like when `kit` was last synced, so a
      // re-finalize can tell "the player changed this in play" from "the owner
      // edited the build". Same rule as lifestyles: chargen wins, but only
      // where chargen actually changed.
      kit_baseline: null,
      // Magazine / firing mode for trait-mounted weapons (Heavy Torso, No Head),
      // keyed by the mount's label. They're derived from the heritage picks on
      // every recalc, so unlike an owned weapon there's no entry to keep it on.
      trait_mounts: {},
      // Senses that have to be switched on, keyed by the power's name. Far Sight
      // needs a Trance before its dice are real, so being "on" is play state
      // like a spent pool die rather than a fact about the build.
      active_senses: {},
      // Which animal each summoning spell is pointed at, keyed by spell name.
      // A caster keeps one Bound Servant at a time, so re-picking replaces it.
      summons: {},
      // Shapeshift: { picks: [animal names], active: name }. The picks are
      // chosen when the spell is learned and persist; `active` is the form
      // currently worn, and is empty whenever the caster is in their own skin.
      shapeshift: { picks: [], active: "" },
      // Spells currently up: [{ uid, name, force, lethal, drain, note }].
      // Nothing here expires on a timer — durations in this game are
      // fiction-paced, the same reason doses are dismissed by hand.
      active_spells: [],
      // Legacy, read-only — replaced by `kit`, migrated once by ensureKit().
      disposed: {},
      fitted_mods: [],
      disposed_mods: [],
      unit_overrides: {},
      // Everything bought after Finalize. There is a hard line between the
      // chargen record and anything that happens once Finalize is pressed:
      // nothing bought in play ever touches the arrays above. That is what lets
      // Back to Chargen reopen the creation budget untouched and Revert drop a
      // character's whole play history in one go. Every purchasable category
      // has a home here — if you add one, add it here too.
      purchases: {
        gear: [],
        augments: [],
        amp_powers: [],
        spells: [],
        weapons: [],
        armor: [],
        decks: [],
        programs: [],
        rigs: [],
        drones: [],
        vehicles: [],
        hacking_levels: 0,   // legacy, folded into the granted Hacking program
      },
      // jacked_out: the deck is owned and carried but not running (see
      // equippedDeckName). Distinct from an empty active_deck, which means
      // "never chose" and resolves to the first owned deck.
      decking: { active_deck: "", loaded: [], jacked_out: false },
      rigging: { active_rig: "", units: {} },
    },
  };
}

/* Which data tables hold a drone's / vehicle's mountable weapons and mods, and
 * the name column of each. Single source of truth: priceDronesAndVehicles, the
 * legacy-attachment migration below, and sheet.js's RIG_UNIT_CFG all read this
 * rather than repeating the table/column names. See docs/DATA.md. */
const UNIT_ATTACHMENT_TABLES = {
  drones: {
    weapons: [["drone_ballistic_weapons", "Drone Ballistic Weapon"],
              ["drone_energy_weapons", "Drone Energy Weapon"]],
    mods: ["drone_mods", "Drone Mod"],
  },
  vehicles: {
    weapons: [["vehicle_ballistic_weapons", "Vehicle Ballistic Weapon"],
              ["vehicle_energy_weapons", "Vehicle Energy Weapon"]],
    mods: ["vehicle_mods", "Vehicle Mod"],
  },
};

/* Legacy saves could land a unit MOD in `unit.weapons` (an older UI offered one
 * combined picker). Pricing never cared -- it charges for both arrays alike --
 * but the stat tally only reads `unit.mods`, so a misfiled mod silently lost its
 * Ballistic/Impact/Hardening/Body effect and ate a weapon slot. Move any name
 * that is not a weapon for that unit type but IS a mod into `unit.mods`.
 *
 * Lossless (the name is only reclassified, never dropped), idempotent, and it
 * leaves names that match neither table alone rather than discarding data. */
function migrateUnitAttachments(character, tables) {
  if (!tables) return;
  for (const [listKey, cfg] of Object.entries(UNIT_ATTACHMENT_TABLES)) {
    for (const unit of character[listKey] || []) {
      if (!Array.isArray(unit.weapons) || !unit.weapons.length) continue;
      const isWeapon = n => cfg.weapons.some(([tk, nc]) =>
        (tables[tk] || []).some(row => row[nc] === n));
      const isMod = n => (tables[cfg.mods[0]] || []).some(row => row[cfg.mods[1]] === n);
      const misfiled = unit.weapons.filter(n => !isWeapon(n) && isMod(n));
      if (!misfiled.length) continue;
      unit.weapons = unit.weapons.filter(n => !misfiled.includes(n));
      unit.mods = [...(unit.mods || []), ...misfiled];
    }
  }
}

/* Augments renamed in the base data, old name -> new. Rows resolve by name, so a
 * rename silently orphans the item on every saved character unless it's followed
 * here. Add an entry whenever an augment's Name changes and never remove one --
 * an old save can surface at any time.
 *
 * "Cybertechronic Ears" was a misspelling of the "Cybertech*t*ronic" its sibling
 * Cybertechtronic Eyes uses. "Delux Trackmobi" was missing its second "e" —
 * confirmed with the repo owner that no saved character owns one yet, so this
 * entry is precautionary rather than a rescue, but the convention is to add one
 * regardless: the next character that buys it is exactly the case this exists
 * to cover, and "no one has it yet" stops being true the moment this ships. */
const RENAMED_AUGMENTS = {
  "Cybertechronic Ears": "Cybertechtronic Ears",
  "Delux Trackmobi": "Deluxe Trackmobi",
};

/* Apply RENAMED_AUGMENTS everywhere an augment name is stored on a character:
 * the chargen list, anything bought in play, and the `mounted` arrays that hang
 * off armor / weapons / gear hosts. Idempotent. */
function migrateRenamedAugments(character) {
  const rename = list => {
    for (const entry of list || []) {
      if (entry && RENAMED_AUGMENTS[entry.name]) entry.name = RENAMED_AUGMENTS[entry.name];
    }
  };
  rename(character.augments);
  rename(((character.play || {}).purchases || {}).augments);
  for (const hosts of [character.armor, character.weapons, character.gear]) {
    for (const host of hosts || []) rename(host && host.mounted);
  }
}

/* Spirits renamed in the base data, old name -> new. Same contract as
 * RENAMED_AUGMENTS: `speaker_spirits` rows resolve by name, so a rename orphans
 * the spirit on every saved character -- its relationship cost stops counting,
 * an infusion slot holding it goes blank, and a bond tile loses its writeup.
 * Add an entry whenever a Spirit changes name and never remove one.
 *
 * "Bachinal" was a misspelling of the Bacchanal(ia) its own service names
 * already used. */
const RENAMED_SPIRITS = {
  "Bachinal": "Bacchanal",
};

/* Apply RENAMED_SPIRITS everywhere a spirit name is stored on a character:
 * chargen relationships, the play-mode infusion slots and bond slots, and the
 * `link` on a Focus/Fetish/Spirit Bag. Idempotent. */
function migrateRenamedSpirits(character) {
  const to = name => RENAMED_SPIRITS[name] || name;
  const speaker = character.speaker;
  if (speaker && Array.isArray(speaker.relationships)) {
    speaker.relationships = speaker.relationships.map(to);
  }
  const play = character.play || {};
  for (const [slot, name] of Object.entries(play.infusion_spirits || {})) {
    play.infusion_spirits[slot] = to(name);
  }
  for (const bond of play.bond_slots || []) {
    if (bond && bond.spirit) bond.spirit = to(bond.spirit);
  }
  // Focus/Fetish link to a spell, ritual or spirit; Spirit Bags to a spirit.
  for (const item of character.gear || []) {
    if (item && item.link) item.link = to(item.link);
  }
}

/* Spells renamed in the base data, old name -> new. Same contract as
 * RENAMED_AUGMENTS: `spells` resolves by name, so a rename orphans the spell on
 * every saved character that knows it -- it drops out of `magic.spells`
 * silently (nothing errors; it just stops appearing), a Force advance keyed to
 * the old name in `play.spell_force_advances` stops matching and goes inert,
 * and a Focus/Fetish linked to it (`gear[].link`) shows a blank instead of the
 * spell's name. Add an entry whenever a Spell's Name changes and never remove
 * one.
 *
 * "The Infinite Illusion of Spiritual Seperation" was missing the second "a"
 * in "Separation". */
const RENAMED_SPELLS = {
  "The Infinite Illusion of Spiritual Seperation":
    "The Infinite Illusion of Spiritual Separation",
};

/* Apply RENAMED_SPELLS everywhere a spell name is stored on a character:
 * the chargen list, anything bought in play, the Force-advance ledger (a key,
 * not a value -- rebuild the object so the advance survives under the new
 * name), and a Focus/Fetish's `link`. Idempotent.
 *
 * Spells never enter `play.kit` (KIT_CATEGORIES has no "spells" -- magic stays
 * on the character rather than being deep-copied at Finalize the way gear is),
 * so those two arrays are the only places a *known* spell lives. */
function migrateRenamedSpells(character) {
  const to = name => RENAMED_SPELLS[name] || name;
  const rename = list => {
    for (const entry of list || []) {
      if (entry && RENAMED_SPELLS[entry.name]) entry.name = RENAMED_SPELLS[entry.name];
    }
  };
  rename((character.magic || {}).spells);
  rename(((character.play || {}).purchases || {}).spells);
  const advances = ((character.play || {}).spell_force_advances);
  if (advances && Object.keys(RENAMED_SPELLS).some(old => old in advances)) {
    const rebuilt = {};
    for (const [name, plus] of Object.entries(advances)) rebuilt[to(name)] = plus;
    character.play.spell_force_advances = rebuilt;
  }
  for (const item of character.gear || []) {
    if (item && RENAMED_SPELLS[item.link]) item.link = RENAMED_SPELLS[item.link];
  }
}

/* RENAMED_WEAPONS: rows retired in favour of an equivalent that stayed.
 *
 * "Underbarrel mounted grenade launcher (40mm)" was a second row for the same
 * real thing as "Underslung Grenade Launcher (40mm) (Underbarrel slot)", and
 * was retired on 2026-08-13 once the surviving row became reachable through the
 * Under-slung grenade launcher mod. A weapon resolves by name, so without this
 * a character who owned the retired one would find it priced at zero, rolling
 * nothing and reporting no stats.
 *
 * PERSONAL weapons only. Drone and vehicle hardpoints draw from their own
 * tables, which never had this row — a drone carrying the name was already an
 * orphan (P14 documents exactly that in the rigger-drones fixture) and stays
 * one, because renaming it would silently invent a mount weapon that has never
 * existed. Never remove an entry. */
const RENAMED_WEAPONS = {
  "Underbarrel mounted grenade launcher (40mm)":
    "Underslung Grenade Launcher (40mm) (Underbarrel slot)",
  // Issue #63: every Polymer Oneshot pistol got "(POS)" appended to its name
  // on 2026-08-17 so it's unmistakable in the buying list without reading the
  // stat line — see weaponIsOneshot/ONESHOT_NOTE. Cosmetic rename, same rows.
  "KL-89 \"Klaw\"": "KL-89 \"Klaw\" (POS)",
  "KL-89 \"Klaw\" (Stripped)": "KL-89 \"Klaw\" (Stripped) (POS)",
  "BudgetArms C-13": "BudgetArms C-13 (POS)",
  "Dai Lung Cybermag 15": "Dai Lung Cybermag 15 (POS)",
  "Federated Arms X-22": "Federated Arms X-22 (POS)",
  "Surprising Stranger": "Surprising Stranger (POS)",
  "Teen Dreem": "Teen Dreem (POS)",
};

/* Apply RENAMED_WEAPONS to the three places a personal weapon name is stored:
 * the chargen record, the play kit, and anything bought in play. */
function migrateRenamedWeapons(character) {
  const play = character.play || {};
  for (const list of [character.weapons, (play.kit || {}).weapons,
                      (play.purchases || {}).weapons]) {
    for (const entry of list || []) {
      if (entry && RENAMED_WEAPONS[entry.name]) entry.name = RENAMED_WEAPONS[entry.name];
    }
  }
}

/* RENAMED_AMMO: personal HEI and Tracer rounds arrived on 2026-08-10 and would
 * otherwise read as the mount rounds of the same designation, so those two
 * mount rounds — and only those two — say "Vehicle": a Wolfhound's Vehicle
 * Autocannon HEI is not the HEI a character loads into a Panther. Every other
 * mount round keeps its name; Tank Rounds and Micro missiles were never
 * ambiguous. Ammo resolves by name, so without this a saved character's loaded
 * mount goes blank and its stockpile stops pricing. Never remove an entry. */
const RENAMED_AMMO = {
  "Autocannon HEI": "Vehicle Autocannon HEI",
  "Autocannon Tracer": "Vehicle Autocannon Tracer",
};

/* Apply RENAMED_AMMO everywhere an ammo name is stored. Two shapes, and they
 * need different treatment:
 *
 *  - `ammo` on a weapon or a unit mount. Walked, because the rigging state
 *    nests deeply enough that naming every path is the thing most likely to
 *    miss one. Safe to walk: nothing but a round is ever stored under `ammo`.
 *
 *  - `name` on a bought stack of rounds. NOT walked, and it must stay that way:
 *    ammo and vehicle weapons share a namespace — "30mm Cannon" and "Vulcan
 *    Cannon" are each both a round and a mounted gun — so a blanket rewrite of
 *    every `name` would one day rename the gun out from under a rigger. Only
 *    the three arrays that hold bought gear are touched.
 *
 * Idempotent: a prefixed name is not itself a key. */
function migrateRenamedAmmo(character) {
  const rename = value => (typeof value === "string" && RENAMED_AMMO[value]) || null;
  const walkAmmo = node => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walkAmmo); return; }
    for (const [key, value] of Object.entries(node)) {
      if (key === "ammo") { const to = rename(value); if (to) node[key] = to; }
      else walkAmmo(value);
    }
  };
  walkAmmo(character);
  const play = character.play || {};
  for (const list of [character.gear, (play.kit || {}).gear,
                      (play.purchases || {}).gear]) {
    for (const item of list || []) {
      const to = item && rename(item.name);
      if (to) item.name = to;
    }
  }
}

/* Does this parsed JSON look like a Sinless character?
 *
 * Import used to accept anything that parsed, wasn't an array, and had a truthy
 * `.attributes` — so a file with `attributes: 1` and `weapons: "sword"` got all
 * the way to a render before failing somewhere unhelpful. This checks the shape
 * mergeDefaults and the engine actually rely on, and hands back every problem
 * at once so the message can say what's wrong rather than just "no".
 *
 * It is a shape check, not a rules check: an out-of-range character imports
 * fine and is then told so by the normal errors and warnings. Hand-editing a
 * save is a supported thing to do in a local-first app — being handed a file
 * that isn't a character at all is not. */
function validateCharacterShape(value) {
  const problems = [];
  const isPlainObject = v => v && typeof v === "object" && !Array.isArray(v);
  if (!isPlainObject(value)) return { ok: false, problems: ["not a JSON object"] };

  if (!isPlainObject(value.attributes)) problems.push("`attributes` is missing or not an object");
  else {
    // Not via asNumber: that coerces junk to 0 on purpose, which is right for
    // the engine and useless for telling a file it's malformed.
    const numeric = v => (typeof v === "number")
      ? Number.isFinite(v)
      : (String(v).trim() !== "" && Number.isFinite(Number(v)));
    const bad = ATTRIBUTES.filter(name =>
      name in value.attributes && !numeric(value.attributes[name]));
    if (bad.length) problems.push(`non-numeric attribute(s): ${bad.join(", ")}`);
  }

  for (const key of ["skills", "priorities", "heritage", "magic", "ritual_skills",
                     "etiquettes", "speaker", "play", "skill_specializations"]) {
    if (key in value && !isPlainObject(value[key])) problems.push(`\`${key}\` is not an object`);
  }
  for (const key of ["weapons", "armor", "gear", "augments", "decks", "programs",
                     "rigs", "drones", "vehicles", "lifestyles", "martial_arts",
                     "knowledge_skills"]) {
    if (key in value && !Array.isArray(value[key])) problems.push(`\`${key}\` is not a list`);
  }
  if (isPlainObject(value.magic)) {
    for (const key of ["spells", "amp_powers"]) {
      if (key in value.magic && !Array.isArray(value.magic[key]))
        problems.push(`\`magic.${key}\` is not a list`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/* ---- import inspection -----------------------------------------------------
 * A character stores NAMES, not rows. Every weapon, augment, spell and lifestyle
 * is a string looked up in the data tables at calculate() time, so a row that
 * gets renamed or retired silently empties whatever referenced it: the item
 * stops pricing, stops contributing stats, and vanishes from the sheet without
 * a word. Renames we knew about get migrations (RENAMED_AUGMENTS and friends);
 * this is the net under everything else.
 *
 * The checks are SHAPE-based, not version-based, and deliberately so — the files
 * that need this most are exactly the ones saved before there was a version to
 * check. See APP_VERSION. */

/* Which table each name-bearing list resolves against, and the column holding
 * the name. Play purchases and the play kit are included: after Finalize the
 * kit is where gear lives, and a name can rot there just as easily. */
const CHARACTER_NAME_SOURCES = [
  ["Weapon", "weapons", "Weapon", "weapons"],
  ["Armor", "armor", "Armor", "armor"],
  ["Gear", "misc_gear", "Item", "gear"],
  ["Augment", "augments", "Name", "augments"],
  ["Deck", "decks", "Name", "decks"],
  ["Program", "programs", "Name", "programs"],
  ["Rig", "rigs", "Rig Type", "rigs"],
  ["Drone", "drones", "Drone", "drones"],
  ["Vehicle", "vehicles", "Vehicle", "vehicles"],
];

function characterNameRefs(character) {
  const arr = v => (Array.isArray(v) ? v : []);
  const nameOf = x => (x && typeof x === "object") ? x.name : x;
  const play = character.play || {};
  const kit = play.kit || {};
  const purchases = play.purchases || {};
  // Chargen, the post-Finalize kit copy and anything bought in play. Duplicates
  // are collapsed by the caller, so overlap between kit and chargen is free.
  const owned = cat => [...arr(character[cat]), ...arr(kit[cat]), ...arr(purchases[cat])];
  const refs = [];
  const add = (label, table, column, names) => {
    for (const raw of names) {
      const name = nameOf(raw);
      if (name) refs.push({ label, table, column, name: String(name) });
    }
  };
  for (const [label, table, column, cat] of CHARACTER_NAME_SOURCES) {
    add(label, table, column, owned(cat));
  }
  // Mods hang off their weapon rather than living in a list of their own.
  add("Weapon mod", "weapon_mods", "Modification",
      owned("weapons").flatMap(w => arr(w && w.mods)));
  const magic = character.magic || {};
  add("Spell", "spells", "Name", [...arr(magic.spells), ...arr(purchases.spells)]);
  add("Amp power", "amp_powers", "Name",
      [...arr(magic.amp_powers), ...arr(purchases.amp_powers)]);
  add("Martial art", "martial_arts", "Style",
      arr(character.martial_arts).map(m => m && m.style));
  add("Heritage feature", "heritage_features", "Name",
      arr((character.heritage || {}).features));
  add("Lifestyle", "lifestyles", "Lifestyle",
      [...arr(character.lifestyles), ...arr(play.lifestyles)]);
  add("Spirit", "speaker_spirits", "Spirit",
      arr((character.speaker || {}).relationships));
  return refs;
}

/* Names the data tables no longer answer to. Run AFTER mergeDefaults so the
 * known renames have already been applied — anything left is a genuine orphan. */
function unresolvedCharacterRefs(character, data) {
  const seen = new Set();
  const out = [];
  for (const ref of characterNameRefs(character)) {
    // NUL separator, written as an escape: no label or item name can contain
    // one, so the two halves can't run together. A space would let
    // "Weapon mod" + "Ghost" collide with "Weapon" + "mod Ghost" and silently
    // drop one of them. (This was a literal NUL byte until v195, which made the
    // whole file read as binary to git, grep and $EDITOR.)
    const key = `${ref.label}\0${ref.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rows = (data && data[ref.table]) || [];
    if (!rows.some(row => String(row[ref.column]) === ref.name)) out.push(ref);
  }
  return out;
}

/* The legacy shapes worth telling a player about when their file lands. Each is
 * something the app repairs on its own; the point is that the repair is visible
 * rather than silent, because a character that quietly gains or loses a field is
 * the hardest kind of bug to report. */
function legacyShapeNotes(raw) {
  const notes = [];
  const play = (raw && raw.play) || {};
  if (raw && raw.finalized && !play.kit) {
    notes.push("Finalized before the play kit existed — its gear will be copied "
      + "into the kit on open, leaving the creation record untouched.");
  }
  if ("armor_worn" in play) {
    notes.push("Carries the retired `play.armor_worn`; worn flags now live on "
      + "the kit copy and this is ignored.");
  }
  if (raw && "martial_art" in raw) {
    notes.push("Carries the single `martial_art` field; it becomes an entry in "
      + "the per-style `martial_arts` list.");
  }
  if (raw && raw.lifestyle && (raw.lifestyle.name || raw.lifestyle.months)) {
    notes.push("Carries the single `lifestyle` field; lifestyles are a list now.");
  }
  // Only a rating that was actually bought migrates — the field still exists and
  // sits at 0 on every current character, so its mere presence says nothing.
  const legacyHacking = Number((raw && raw.hacking_rating) || 0)
    + Number((play.purchases || {}).hacking_levels || 0);
  if (legacyHacking > 0) {
    notes.push(`Carries a flat hacking rating of ${legacyHacking}; it becomes a `
      + `"Hacking ${Math.min(6, legacyHacking)}" program slotted into every deck, `
      + "at the same cost.");
  }
  if (!(raw && raw.house_rules)) {
    notes.push("No house rules recorded — this build's defaults apply, which may "
      + "not be the ones it was made under.");
  }
  return notes;
}

/* One report for the import dialog: where the file came from, what will be
 * repaired, what no longer resolves, and whether the engine accepts the result.
 * Takes the RAW parsed file; merging is done here so the caller sees the same
 * character the app will open. */
function inspectCharacterFile(raw, data) {
  const shape = validateCharacterShape(raw);
  if (!shape.ok) return { ok: false, problems: shape.problems };
  const character = mergeDefaults(deepCopy(raw));
  const unresolved = unresolvedCharacterRefs(character, data);
  let errors = [];
  let threw = null;
  try {
    errors = calculate(deepCopy(character)).errors || [];
  } catch (e) {
    threw = String((e && e.message) || e);
  }
  return {
    ok: true,
    character,
    // null means "made before the stamp existed", not "made by version null".
    madeWith: character.app_version,
    currentVersion: APP_VERSION,
    legacy: legacyShapeNotes(raw),
    unresolved,
    errors,
    threw,
  };
}

function mergeDefaults(character) {
  const defaults = defaultCharacter();
  const isPlainObject = v => v && typeof v === "object" && !Array.isArray(v);

  // Claim this record's provenance before the fill can invent it: a file with
  // no stamp was made by a build that predates stamping, and saying so is the
  // point. Must run before fill(), which would otherwise hand it APP_VERSION.
  if (!("app_version" in character)) character.app_version = null;

  const fill = (target, source) => {
    for (const [key, value] of Object.entries(source)) {
      if (!(key in target)) target[key] = value;
      else if (isPlainObject(value)) {
        // Default expects a keyed object here. If the stored value isn't a
        // plain object (e.g. a legacy character whose skill_specializations was
        // persisted as []), reset it to the default: an array silently drops
        // any named props on JSON.stringify, so writes to it never save.
        if (isPlainObject(target[key])) fill(target[key], value);
        else target[key] = value;
      }
    }
  };

  fill(character, defaults);

  // Migrate the legacy single martial art (character.martial_art + the old
  // "Martial Arts" skill rank) into the per-style list. Idempotent: once the
  // list is populated and the legacy fields cleared, later runs are no-ops.
  if (!Array.isArray(character.martial_arts)) character.martial_arts = [];
  if (character.martial_arts.length === 0 && character.martial_art) {
    const rank = Math.max(0, toInt(asNumber((character.skills || {})["Martial Arts"])));
    character.martial_arts.push({ style: character.martial_art, rank });
  }
  if (character.skills && "Martial Arts" in character.skills) delete character.skills["Martial Arts"];
  delete character.martial_art;

  // Re-file unit mods that legacy saves stored in `weapons` (see above). Uses
  // the merged bundle so homebrew mods are recognised too.
  migrateUnitAttachments(character, BUNDLE && BUNDLE.tables);

  // Follow renamed data rows onto saved characters (see RENAMED_AUGMENTS).
  migrateRenamedAugments(character);
  migrateRenamedSpirits(character);
  migrateRenamedSpells(character);
  migrateRenamedWeapons(character);
  migrateRenamedAmmo(character);

  // The per-unit Damage counter was a free-form tally no code ever read, and the
  // Physical Condition track superseded it. Carry a recorded Damage over into
  // that track (same intent) rather than dropping it, then retire the field. The
  // track clamps to effective Body when it renders, so an over-large legacy
  // value settles itself. Inertia stays — it tracks momentum, not damage.
  const units = ((character.play || {}).rigging || {}).units;
  if (units && typeof units === "object" && !Array.isArray(units)) {
    for (const st of Object.values(units)) {
      if (!st || typeof st !== "object") continue;
      const legacyDamage = toInt(asNumber(st.damage));
      if (legacyDamage > 0 && !toInt(asNumber(st.physical))) st.physical = legacyDamage;
      delete st.damage;
    }
  }
  return character;
}

// ============================================================== step 1: priorities
function resolvePriorities(character, data, warnings, errors) {
  const prioritySpend = {};
  for (const [category, value] of Object.entries(character.priorities)) {
    prioritySpend[category] = Math.max(PRIORITY_MIN,
      Math.min(PRIORITY_MAX, toInt(asNumber(value))));
  }
  const pointsRemaining = PRIORITY_POOL_POINTS
    - Object.values(prioritySpend).reduce((a, b) => a + b, 0);
  // Classic priorities are a bijection: the five categories take the letters
  // A–E (= 4,3,2,1,0) once each. Any permutation of 0–4 sums to 10, so the
  // point pool is auto-satisfied; the added rule is that no value repeats.
  if (houseRule("priorities") === "classic") {
    const values = Object.values(prioritySpend);
    if (new Set(values).size !== values.length)
      errors.push("Classic priorities: assign each letter A–E exactly once (no repeats).");
  } else if (pointsRemaining < 0) {
    errors.push(`Priorities overspent by ${-pointsRemaining} point(s).`);
  }

  const priorityRowByLevel = {};
  for (const row of data.priorities) priorityRowByLevel[toInt(Number(row.Priority))] = row;
  const magicPriorityRow = priorityRowByLevel[prioritySpend.magic];
  const startingAttributePoints = toInt(asNumber(
    priorityRowByLevel[prioritySpend.attributes].AttributePoints));
  const startingSkillPoints = toInt(asNumber(
    priorityRowByLevel[prioritySpend.skills].SkillPoints));
  const startingCash = toInt(asNumber(
    priorityRowByLevel[prioritySpend.resources].Cash));

  const allowedMagicTypes = MAGIC_TYPES_ALLOWED_BY_PRIORITY[prioritySpend.magic];
  let magicType = character.magic.chosen_type || allowedMagicTypes[allowedMagicTypes.length - 1];
  if (!allowedMagicTypes.includes(magicType)) {
    magicType = allowedMagicTypes[allowedMagicTypes.length - 1];
  }

  const heritagePriority = prioritySpend.heritage;
  let allowedHeritages = ["Human"];
  for (const [lo, hi, heritages] of HERITAGE_AVAILABILITY) {
    if (lo <= heritagePriority && heritagePriority <= hi) { allowedHeritages = heritages; break; }
  }
  const chosenHeritageType = character.heritage.type;
  // With nothing chosen there is no subject to put in the priority message —
  // it used to render as a bare " requires a higher Heritage priority", which
  // reads like a bug. Say what's actually missing instead.
  if (!chosenHeritageType) {
    errors.push(`Choose a heritage (available at priority ${heritagePriority}: `
                + `${allowedHeritages.join(", ")}).`);
  } else if (!allowedHeritages.includes(chosenHeritageType)) {
    errors.push(
      `${chosenHeritageType} requires a higher Heritage priority `
      + `(available at priority ${heritagePriority}: ${allowedHeritages.join(", ")}).`);
  }

  return {
    values: prioritySpend,
    remaining: pointsRemaining,
    magic_type: magicType,
    magic_priority_label: magicPriorityRow.Magic,
    starting_attr_pts: startingAttributePoints,
    starting_skill_pts: startingSkillPoints,
    starting_cash: startingCash,
    allowed_heritages: allowedHeritages,
  };
}

// ============================================================== step 2: heritage
function heritageTraitRows(character, data) {
  const heritage = character.heritage;
  const traitsByName = {};
  for (const row of data.heritage_features) traitsByName[row.Name] = row;
  const rows = [];
  if (heritage.type === "Uplift" && heritage.uplift_type) {
    const upliftRow = traitsByName[heritage.uplift_type];
    if (upliftRow) rows.push(upliftRow);
  }
  for (const featureName of heritage.features || []) {
    const row = traitsByName[featureName];
    if (row) rows.push(row);
  }
  return rows;
}

function applyHeritage(character, data, warnings, errors) {
  const heritage = character.heritage;
  const heritageType = heritage.type;
  const traits = heritageTraitRows(character, data);

  const sumColumn = column => sumBy(traits, row => asNumber(row[column]));

  const attributePointModifier = toInt(sumColumn("Modifier"));

  const attributeAdjustment = {};
  const attributeMaxAdjustment = {};

  // Initialize both adjustment objects
  for (const [name, column] of Object.entries(ATTRIBUTE_COLUMN)) {
    attributeAdjustment[name] = toInt(sumColumn(column));
    attributeMaxAdjustment[name] = 0;
  }

  // Move an attribute's current adjustment into the max-only bucket: it
  // raises/lowers the maximum but not the starting value. Accumulates so
  // multiple sources on the same attribute compose instead of clobbering.
  const moveToMaxOnly = name => {
    attributeMaxAdjustment[name] += attributeAdjustment[name];
    attributeAdjustment[name] = 0;
  };

  // Small Uplifts: STR and BOD reductions apply to the maximum only.
  const isSmallUplift = traits.some(row => row.SmallUplift === "true" || row.SmallUplift === true);
  if (isSmallUplift) {
    moveToMaxOnly("Strength");
    moveToMaxOnly("Body");
  }

  // Any heritage trait may name attributes whose modifier is max-only.
  for (const trait of traits) {
    if (!trait.MaxOnlyAttributes) continue;
    for (const raw of trait.MaxOnlyAttributes.split(",")) {
      const attrName = raw.trim();
      const fullName = attrName.charAt(0).toUpperCase() + attrName.slice(1).toLowerCase();
      if (ATTRIBUTES.includes(fullName)) moveToMaxOnly(fullName);
    }
  }

  if (traits.some(row => row.Name === "Nature's Blessing")) {
    const plus3 = heritage.blessing_plus3;
    if (ATTRIBUTES.includes(plus3)) attributeAdjustment[plus3] += 3;
    else warnings.push("Nature's Blessing: choose the +3 attribute.");
    const plus1 = heritage.blessing_plus1;
    if (ATTRIBUTES.includes(plus1)) attributeAdjustment[plus1] += 1;
    else warnings.push("Nature's Blessing: choose the +1 attribute.");
  }

  const traitCategories = traits.map(row => row.Category);
  validateBoonBaneCounts(heritageType, traitCategories, warnings, errors);

  if (heritageType === "Synthetic") {
    const traitNames = new Set(traits.map(row => row.Name));
    if (traitNames.has("Durable") && (traitNames.has("Arcano-Manon Interface Matrix")
                                      || traitNames.has("Specialization"))) {
      errors.push("Cannot have Durable with these Mods "
                  + "(Arcano-Manon Interface Matrix / Specialization).");
    }
  }

  let specializationPool = "";
  if (traits.some(row => row.Name === "Specialization")) {
    specializationPool = heritage.specialization_pool || "";
  }

  const heritageRow = findRow(data.heritages, "Name", heritageType);
  const baseZoeticPotential = toInt(asNumber((heritageRow || {}).ZP, 6));

  // Calculate gear cost multiplier (Small Uplifts get 40% increase)
  const smallUpliftMult = traits.reduce((max, row) => Math.max(max, asNumber(row.GearCostMultiplier, 1.0)), 1.0);
  const gearCostMult = smallUpliftMult;

  // Extra limbs (Extra Arm / Extra Leg) need custom-fitted armor: each such
  // trait adds +50% to ARMOR cost only (other gear is unaffected). Additive per
  // limb, and multiplies on top of any small-heritage armor surcharge.
  const extraLimbCount = traits.filter(row =>
    row.Name === "Extra Arm" || row.Name === "Extra Leg").length;
  const armorCostMult = 1 + (EXTRA_LIMB_ARMOR_COST_MULTIPLIER - 1) * extraLimbCount;

  // Heavy Torso / No Head free 1-weight mounts: resolve the player's picks into
  // granted gear (all free). Each pick is "Cyberarm"/"Cyberleg" (an extra limb)
  // or a weapon name. Ignored unless the granting trait is actually selected.
  const traitGear = [];
  const hasTrait = n => traits.some(row => row.Name === n);
  if (hasTrait("Heavy Torso")) {
    for (const choice of (heritage.heavy_torso_mounts || [])) {
      if (!choice) continue;
      if (choice === "Cyberarm" || choice === "Cyberleg")
        traitGear.push({ source: "Heavy Torso", kind: "limb", label: choice });
      else {
        const w = findRow(data.weapons, "Weapon", choice);
        if (w) traitGear.push({ source: "Heavy Torso", kind: "weapon", label: choice, weapon: w });
      }
    }
  }
  if (hasTrait("No Head") && heritage.no_head_mount) {
    const w = findRow(data.weapons, "Weapon", heritage.no_head_mount);
    if (w) traitGear.push({ source: "No Head", kind: "weapon", label: heritage.no_head_mount, weapon: w });
  }

  // Hands to hold a weapon in: the baseline two, plus one per Extra Arm trait
  // (heritage features are a checkbox list, so this is 0 or 1 in practice —
  // counted rather than assumed, in case a hand-edited or imported file
  // carries more) and one per Heavy Torso mount actually picked as a Cyberarm.
  // A Right/Left Arm Replacement augment REPLACES a hand's arm rather than
  // adding one (see AUGMENT_LIMB_TYPES), so it is deliberately not counted here.
  const extraHands = traits.filter(row => row.Name === "Extra Arm").length
    + traitGear.filter(g => g.kind === "limb" && g.label === "Cyberarm").length;

  return {
    type: heritageType,
    traits,
    trait_gear: traitGear,
    attribute_adjustment: attributeAdjustment,
    attribute_max_adjustment: attributeMaxAdjustment,
    uplift_attribute_point_modifier: attributePointModifier,
    specialization_pool: specializationPool,
    zoetic_potential: baseZoeticPotential + toInt(sumColumn("ZP")),
    soak_bonus: toInt(sumColumn("Soak")),
    move_bonus: toInt(sumColumn("Move")),
    dodge_bonus: toInt(sumColumn("Dodge")),
    ballistic_armor: toInt(sumColumn("Ballistic Armor")),
    impact_armor: toInt(sumColumn("Impact Armor")),
    // Highest single innate ballistic source (for the max-ballistic cap).
    ballistic_armor_max: maxOf(traits.map(row => toInt(asNumber(row["Ballistic Armor"]))), 0),
    all_skills_bonus: toInt(sumColumn("All")),
    special_move_notes: traits.filter(row => row.SpecMove).map(row => row.SpecMove),
    skill_bonus: {
      "Observation": toInt(sumColumn("Observation")),
      "Reconnaissance": toInt(sumColumn("Recon")),
      "Shadow": toInt(sumColumn("Shadow")),
      "Athletics": toInt(sumColumn("Athletics")),
      "Sorcery": toInt(sumColumn("Sorcery")),
      "Conjuring": toInt(sumColumn("Conjuring")),
      "Channeling": toInt(sumColumn("Channeling")),
      "Astral Senses": toInt(sumColumn("AstralSenses")),
    },
    has_hephestus: traits.some(row => row.Name === "Hephestus"),
    has_cyclopean: traits.some(row => row.Name === "Cyclopean"),
    has_antlers: traits.some(row => row.Name === "Antlers"),
    gear_cost_multiplier: gearCostMult,
    armor_cost_multiplier: armorCostMult,
    hand_count: Math.max(HAND_COUNT_BASE, Math.min(HAND_COUNT_MAX, HAND_COUNT_BASE + extraHands)),
  };
}

function validateBoonBaneCounts(heritageType, categories, warnings, errors) {
  const count = label => categories.filter(c => c === label).length;
  if (heritageType === "Green") {
    const boons = count("GreenBoon"), banes = count("GreenBane");
    if (banes > 1) errors.push("Green heritage: choose at most 1 Bane.");
    const boonLimit = banes >= 1 ? 2 : 1;
    if (boons > boonLimit) {
      const unlockHint = boonLimit === 1 ? "take a Bane to unlock a 2nd" : "";
      errors.push(`Green heritage: ${boonLimit} Boon(s) allowed (${unlockHint}).`);
    } else if (boons < 1) {
      warnings.push("Green heritage: choose at least 1 Boon.");
    }
  } else if (heritageType === "Blighted") {
    const boons = count("BlightBoon"), banes = count("BlightBane");
    if (banes > 1) errors.push("Blighted heritage: choose at most 1 Bane.");
    const boonLimit = banes >= 1 ? 3 : 2;
    if (boons > boonLimit) {
      const unlockHint = boonLimit === 2 ? "take a Bane to unlock a 3rd" : "";
      errors.push(`Blighted heritage: ${boonLimit} Boon(s) allowed (${unlockHint}).`);
    } else if (boons < 2) {
      warnings.push("Blighted heritage: choose at least 2 Boons.");
    }
  }
}

// ============================================================== step 3: augments
// Two augment rows grant a mounted cybergun: the base install, and the
// Reload Port variant its own Description already names ("an external ammo
// port that extends out from the forearm, allowing you to reload as
// normal", +0.1 ZR) as row #168's own optional upgrade. They're the same
// THING everywhere except that one difference — same gun-type picker, same
// one-per-cyberarm cap, same cost math (augmentEffCost keys off entry.gunType,
// not the name, so it needs no changes) — so every check that used to test
// the name literally tests membership here instead. A third variant is one
// line to add, not a grep across four files.
const CYBERGUN_AUGMENT_NAMES = new Set(["Cybergun Installation", "Cybergun-Reload Port"]);
function isCybergunAugment(name) { return CYBERGUN_AUGMENT_NAMES.has(name); }
// Only the Reload Port variant is exempt from the "cannot be reloaded during
// combat" confirm — that's the entire point of paying its extra 0.1 ZR.
function cybergunReloadable(name) { return name === "Cybergun-Reload Port"; }

const AUGMENT_REQUIREMENTS = {
  "Skillwires": [["Chipjack"]],
  "Skillsoft": [["Chipjack"], ["Skillwires"]],
  // Knowledge Skillsofts need only a single Chipjack (no Skillwires), no
  // matter how many are installed — each adds a Knowledge skill point.
  "Knowledge Skillsoft": [["Chipjack"]],
  "Pain Nullifier": [["Nerve Rig"]],
  "Subvocal Mic": [["Commlink"]],
  "Recorder": [["Datajack", "Optical Datajack", "Memory", "Chipjack"]],
  "Camera": [["Datajack", "Optical Datajack", "Memory", "Chipjack"]],
  "Cybergun Installation": [["Right Arm Replacement", "Left Arm Replacement",
                             "Arm Omni-kit"]],
  "Cybergun-Reload Port": [["Right Arm Replacement", "Left Arm Replacement",
                            "Arm Omni-kit"]],
  "Gyromount": [["Right Arm Replacement", "Left Arm Replacement",
                 "Arm Omni-kit"]],
};

const CYBER_SENSE_ZR_ABSORB = 0.5;
const CYBER_LIMB_ZR_ABSORB = 1.0;
const CYBER_EYES_NAME = "Cybertechtronic Eyes";
const CYBER_EARS_NAME = "Cybertechronic Ears";   // (sic — matches the data table)
const LIMB_REPLACEMENT_TYPES = ["Right Arm", "Left Arm", "Right Leg", "Left Leg"];

function augmentLevel(name) {
  const parts = String(name || "").trim().split(" ");
  const tail = parts[parts.length - 1];
  return /^\d+$/.test(tail) ? parseInt(tail, 10) : 0;
}

// Alpha-grade augments (bleeding edge): ZR reduced 20% (minimum reduction
// of 0.1, round UP to the nearest tenth) but cost is doubled (with a minimum
// increase of 1000). Flagged per-entry with entry.alpha. Shared by the
// body-augment tally, the gear-mount tally, and the UIs.
function augmentEffZr(row, entry) {
  const base = asNumber(row.ZR);
  if (!(entry && entry.alpha && base)) return base;
  // Alpha grade reduces ZR by 20% or 0.1, whichever is larger. round2 clears
  // float dust before the ceil so e.g. 0.4−0.1 = 0.30000000000000004 rounds to
  // 0.3 rather than getting ceil'd up to 0.4.
  const reduction = Math.max(base * 0.2, 0.1);
  return Math.max(0, Math.ceil(round2(base - reduction) * 10) / 10);
}
// Fashionware quality tiers (Ad Supported ×0.5 … Bespoke ×15). Only pieces
// flagged Quality = Y can be made at a tier; everything else ignores it.
function augmentQualityMultiplier(row, entry) {
  if (!(row && row.Quality === "Y" && entry && entry.quality)) return 1;
  const tier = (BUNDLE.tables.fashionware_qualities || [])
    .find(q => q.Quality === entry.quality);
  return tier ? asNumber(tier.Multiplier, 1) : 1;
}
/* Classic ZR prices cyberlimbs at double. Under the Classic rule each limb
 * absorbs 1.0 ZR, which makes chrome a bargain; doubling the price is the
 * counterweight. The ZR Casting Penalty rule leaves limbs at list price.
 *
 * Applied to the base, so quality and α-grade scale from the doubled figure —
 * a more expensive limb costs more to upgrade, which is the point. It covers
 * the RC (remote-controllable) variants too: "all cyberlimbs cost double" with
 * no exceptions, so the premium for remote control survives instead of
 * collapsing into the base price. Keyed off `Type`, so a homebrew limb picks it
 * up automatically.
 *
 *   Chromed   ㄓ37,500 → ㄓ75,000        Synthetic     ㄓ50,000  → ㄓ100,000
 *   Chromed RC ㄓ75,000 → ㄓ150,000      Synthetic RC ㄓ100,000 → ㄓ200,000
 */
const CLASSIC_ZR_LIMB_COST_MULTIPLIER = 2;
function classicZrLimbMultiplier(row) {
  return (houseRule("zr") === "classic" && AUGMENT_LIMB_TYPES.has((row || {}).Type || ""))
    ? CLASSIC_ZR_LIMB_COST_MULTIPLIER : 1;
}

function augmentEffCost(row, entry) {
  // Quality scales the base price first; α-grade then applies on top of the
  // quality-adjusted cost (issue #19).
  const base = asNumber(row.Cost) * augmentQualityMultiplier(row, entry)
    * classicZrLimbMultiplier(row);
  // Doubles the cost, but the increase is at least 1000 so cheap augments
  // still pay a real premium for bleeding-edge grade.
  let cost = (entry && entry.alpha) ? base + Math.max(base, 1000) : base;
  // Cybergun Installation: the chosen gun type adds its own cost on top of the
  // installation (added flat, after the α-grade premium on the installation).
  if (entry && entry.gunType) {
    const gun = (BUNDLE.tables.cyberguns || []).find(g => g.Type === entry.gunType);
    if (gun) cost += asNumber(gun.Cost);
  }
  return cost;
}

/**
 * A Cyberlimbs augment's limb requirement, driven by the data "Req Limb" field:
 *   "Arm" -> needs a cyberarm, "Leg" -> a cyberleg, "Any" -> either.
 * Hand implants (blades/razors) name-match to no requirement; any other
 * Cyberlimbs augment with no explicit field defaults to "Any". Returns "" for
 * non-cyberlimb augments and for augments that need no limb.
 */
function augmentLimbRequirement(row) {
  if (!row || row.Type !== "Cyberlimbs") return "";
  if (row["Req Limb"]) return row["Req Limb"];
  return /^(Hand Blade|Hand Razors)/.test(row.Name || "") ? "" : "Any";
}

/**
 * Computed damage for an augment that carries a structured "Damage" bonus —
 * cyber melee implants (Hand Blade/Razors, Spurs), Fangs, and the Eye Laser.
 * meleeDamage adds ½ STR by default, or the row's "STR Mult" (0 = fixed damage,
 * e.g. the Eye Laser). Returns "" for augments with no built-in attack.
 */
function augmentMeleeDamage(row, strength, martialMods) {
  if (!row || row.Damage === undefined || row.Damage === "") return "";
  // Way of the Tank L6 overrides spur damage to full STR + N (e.g. "6+STR").
  if (martialMods && martialMods.spurs_str_bonus != null && /spurs?/i.test(row.Name || ""))
    return String(strength + martialMods.spurs_str_bonus);
  return meleeDamage(row, strength);
}

// Melee attacks a character carries without a hand weapon — cyber implants
// (Hand Blade/Razors, Spurs, Fangs, …), and Amp powers such as Iron Fist that
// grant a bare-handed strike. Surfaced on the Overview loadout beside carried
// weapons so their auto-calculated (Strength-based) damage and Reach are visible
// in one place. Each: { name, damage, reach, source }.
/* Implants that carry a Damage value but are NOT melee attacks rolled off a
 * skill: the implant supplies the whole dice pool itself. Curated here beside
 * the other special cases (Iron Fist, Shark, Snake) rather than parsed out of
 * the Effect prose -- the description is written for humans and editing it
 * shouldn't silently change what the sheet rolls. `dice` is the complete attack
 * pool, so consumers get a number rather than a preformatted string.
 *
 * Adding a data column instead would mean touching every augment row: the table
 * currently has a uniform column set, and a column present on one row only is
 * exactly what promote_homebrew.base_columns() drops (it reads row 0). */
const FIXED_POOL_IMPLANTS = {
  "Eye Laser": { kind: "Ranged 2m", dice: 8, note: "one shot — burns out the eye" },
};

function collectGrantedWeapons(augments, amp, strength, martialMods) {
  const list = [];
  // Cyber melee implants + Fangs: any owned augment with a structured Damage.
  for (const [row, count] of augments.rows) {
    const dmg = augmentMeleeDamage(row, strength, martialMods);
    if (dmg === "") continue;
    const name = count > 1 ? `${row.Name} ×${count}` : row.Name;
    const fixed = FIXED_POOL_IMPLANTS[row.Name];
    if (fixed) {
      list.push({ name, damage: String(row.Damage ?? ""), source: "Cyberware", ...fixed });
      continue;
    }
    list.push({ name, damage: dmg, reach: 0, source: "Cyberware" });
  }
  // Iron Fist (Amp power): unarmed strikes deal physical ½STR + 6 at Reach 0.
  if (amp.powers_taken.has("Iron Fist")) {
    list.push({ name: "Iron Fist", damage: meleeDamage({ Damage: IRON_FIST_BASE_DAMAGE }, strength),
      reach: 0, source: "Amp Power" });
  }
  return list;
}

// Curated natural attacks granted by heritage uplifts (issue #9). Gorilla is a
// pure reach modifier (surfaced as a heritage ability, not a weapon). Shark and
// Snake grant bite/spit attacks; Snake's is a chargen-locked bite-or-spit pick.
function heritageNaturalWeapons(heritage, character, strength) {
  const has = n => heritage.traits.some(row => row.Name === n);
  const list = [];
  if (has("Shark"))
    list.push({ name: "Bite", damage: String(6 + strength), reach: 0, source: "Shark" });  // 6 + full STR
  if (has("Snake")) {
    if ((character.heritage.snake_attack || "bite") === "spit")
      list.push({ name: "Spit", source: "Snake",
        stats: `Ranged 12m · Acc 4 · DMG 2d6 · +Blind` });
    else
      list.push({ name: "Bite", damage: `${Math.floor(strength / 2) + 1} +3d6 poison`,
        reach: 0, source: "Snake" });
  }
  return list;
}

// Effect sums shared by body-installed augments (tallyAugments) and augments
// mounted on gear (tallyMountedAugments). `owned` is [row, count, entry]
// tuples; entries that shouldn't grant effects (e.g. mounted on unworn gear)
// are simply left out of the list by the caller.
function augmentEffectSums(owned) {
  const names = new Set(owned.map(([row]) => row.Name));
  const attributeAdjustment = {}, attributeMaxAdjustment = {};
  // Every attribute, not just the four core rows happen to use: a column that
  // no shipped augment carries reads as 0 through asNumber, so this costs
  // nothing today and lets homebrew raise Willpower or Charisma the same way.
  for (const name of ATTRIBUTES) {
    attributeAdjustment[name] = toInt(sumBy(owned,
      ([row, count]) => asNumber(row[name]) * count));
    attributeMaxAdjustment[name] = toInt(sumBy(owned,
      ([row, count]) => augmentRaisesMax(row) ? asNumber(row[name]) * count : 0));
  }
  const wiredReflexesRank = maxOf(
    [...names].filter(n => n.startsWith("Wired Reflexes")).map(augmentLevel), 0);
  // Skill bonuses and situational per-skill notes used to be five hardcoded
  // name checks here (Sound Filter, Rocket Boots, Compartment, Covert
  // Synthskin, Amplification). They now live in the rows' own "Skill Bonus" and
  // "Skill Note" columns and are collected by gearSkillEffects, so homebrew can
  // do exactly what the core rows do. Left empty here: mergeSkillEffects fills
  // them from the data, and mergeMountedAugments still merges a mounted host's
  // share through the same fields.
  const skillBonus = {};
  const skillNotes = {};
  // Situational firearm/optics modifiers, shown as reminders by the weapons UI.
  const combatNotes = [];
  if (names.has("Smartlink")) combatNotes.push("Smartlink: +1 Accuracy on smart guns (already applied)");
  if (names.has("Laser Designator")) combatNotes.push("Laser Designator: +1 Accuracy when the laser is lit");
  if (names.has("Augmented Eyesight")) combatNotes.push("Augmented Eyesight: shift firearm range one category closer");
  for (const [row] of owned) {
    if (row.Name.startsWith("Vision Magnification"))
      combatNotes.push(`${row.Name}: reduce firearm range by ${augmentLevel(row.Name)}`);
  }
  // Special senses / immunities (curated) and alternate movement modes (Mobi
  // augments with an AltMove value) surface as summaries; damage soak is a flag.
  const senseNotes = owned
    .filter(([row]) => SENSE_AUGMENTS.has(row.Name))
    .map(([row]) => ({ name: row.Name, effect: row.Effect || "" }));
  const moveModes = owned
    .filter(([row]) => row.AltMove !== undefined && row.AltMove !== "")
    .map(([row]) => ({ name: row.Name, mode: row.MoveMode || "Alt", meters: toInt(asNumber(row.AltMove)) }));
  return {
    attribute_adjustment: attributeAdjustment,
    attribute_max_adjustment: attributeMaxAdjustment,
    skill_bonus: skillBonus,
    skill_notes: skillNotes,
    combat_notes: combatNotes,
    sense_notes: senseNotes,
    move_modes: moveModes,
    physical_damage_reduction: names.has("Platelet Production Enhancement") ? PLATELET_DAMAGE_REDUCTION : 0,
    // Movement Enhancement states its metres through its rating; anything else
    // states them in a "Move" column, signed, so a homebrew augment can slow you
    // down as easily as speed you up (#41). Read here rather than in the generic
    // gear sweep so augments keep a single path for movement — the sweep already
    // skips them to avoid counting their AltMove twice.
    move_bonus: toInt(sumBy(owned, ([row, count]) =>
      (row.Name.startsWith("Movement Enhancement")
        ? augmentLevel(row.Name) * MOVEMENT_ENHANCEMENT_METERS_PER_RATING : 0) * count
      + toInt(asNumber(row.Move)) * count)),
    // Recoil-capacity bonus: each Gyromount adds +2.
    recoil_capacity_bonus: toInt(sumBy(owned, ([row, count]) =>
      row.Name === "Gyromount" ? GYROMOUNT_RECOIL_BONUS * count : 0)),
    // How many, as its own figure: the "No Recoil" house rule pays a Gyromount
    // in bonus dice instead (#61), and dividing the capacity bonus back out
    // would break the moment anything else contributed to it.
    gyromount_count: toInt(sumBy(owned, ([row, count]) =>
      row.Name === "Gyromount" ? count : 0)),
    dodge_bonus: names.has("Covert Synthskin") ? COVERT_SYNTHSKIN_DODGE_BONUS : 0,
    impact_armor: toInt(sumBy(owned, ([row, count]) => asNumber(row["Impact Armor"]) * count)),
    ballistic_armor: toInt(sumBy(owned, ([row, count]) => asNumber(row["Ballistic Armor"]) * count)),
    // Un-strippable impact armor (ImpArmMin col: Bone Lacing, Bone Density, …).
    impact_armor_min: toInt(sumBy(owned, ([row, count]) => asNumber(row.ImpArmMin) * count)),
    // Highest single ballistic source (ballistic armor doesn't stack for the cap).
    ballistic_armor_max: maxOf(owned.map(([row]) => toInt(asNumber(row["Ballistic Armor"]))), 0),
    melee_exploit_bonus: WIRED_REFLEXES_MELEE_EXPLOITS_BY_RANK[wiredReflexesRank] || 0,
    wired_reflexes_rank: wiredReflexesRank,
    internal_armor_slot_items: owned
      .filter(([row]) => row["Armor Slot"] === "Y")
      .map(([row]) => row.Name),
    mobility_move_notes: owned
      .filter(([row]) => row.Type === "Mobi" && row.Effect)
      .map(([row]) => row.Effect),
    has_move_exploit: owned.some(([row]) =>
      row.Name.includes("Trackmobi") || row.Name.includes("Repulsors")),
    // Named sources of the move exploit action, so the Overview can attribute it.
    move_exploit_sources: owned
      .filter(([row]) => row.Name.includes("Trackmobi") || row.Name.includes("Repulsors"))
      .map(([row]) => row.Name),
  };
}

/* ---- augment tiers ----------------------------------------------------------
 * Most augment families are graded: Wired Reflexes 1/2/3, Muscle Augmentation
 * 1..n. Taking a grade replaces the one below it rather than sitting alongside
 * it. A few families genuinely stack (Skillsofts, Memory, Compartments) and so
 * do the four limb-replacement types — you can have two cyberarms.
 *
 * Bone Lacing's tiers are named rather than numbered (plastic < aluminum <
 * titanium in cost, ZR, Body and armor alike), so it needs its own table: the
 * trailing-digit rule reads all three as separate one-rank families.
 *
 * The picker in app.js hides lower tiers of an owned family, but a character
 * that arrives by import, homebrew or hand-edited JSON never passes through it,
 * so `tallyAugments` re-checks and errors. Both live off these helpers. */
const NAMED_AUGMENT_TIERS = {
  "Bone Lacing": { plastic: 1, aluminum: 2, titanium: 3 },
};
const STACKABLE_AUGMENT_RE = /^(Skillsoft|Knowledge Skillsoft|Memory|Unmodified|Compartment|Chipjack)/i;
const AUGMENT_LIMB_TYPES = new Set(["Right Arm", "Left Arm", "Right Leg", "Left Leg"]);

/** `name` -> { family, rank }. Unnumbered names are their own rank-1 family. */
function augmentTier(name) {
  for (const [family, tiers] of Object.entries(NAMED_AUGMENT_TIERS)) {
    if (!name.startsWith(family + "-")) continue;
    const rank = tiers[name.slice(family.length + 1).trim().toLowerCase()];
    if (rank) return { family, rank };
  }
  const m = String(name).match(/^(.*?)[\s-]*(\d+)\s*$/);
  return m ? { family: m[1].trim(), rank: +m[2] } : { family: String(name), rank: 1 };
}

/** True when several of this augment may be installed side by side. */
function augmentStacks(name, data) {
  if (STACKABLE_AUGMENT_RE.test(name)) return true;
  const row = findRow(data.augments, "Name", name);
  return AUGMENT_LIMB_TYPES.has((row || {}).Type || "");
}

/* `playErrors`, when given, collects the subset of these errors that stays
 * illegal after Finalize — what is installed in the character's body doesn't
 * stop being wrong just because creation is over. See `calculate`. */
function tallyAugments(character, data, warnings, errors, playErrors) {
  const bothWays = message => {
    errors.push(message);
    if (playErrors) playErrors.push(message);
  };
  const owned = [];  // [row, count, character entry]
  for (const entry of character.augments) {
    const row = findRow(data.augments, "Name", entry.name);
    if (row) owned.push([row, toInt(asNumber(entry.count, 1)) || 1, entry]);
  }

  const ownedNames = new Set(owned.map(([row]) => row.Name));
  const owns = prefix => [...ownedNames].some(name => name.startsWith(prefix));

  const hasVcr = (character.rigs || []).some(
    rig => findRow(data.rigs, "Rig Type", rig.name));
  if (character.heritage.type === "Synthetic") {
    for (const [row] of owned) {
      if (row.Type === "Bioware") {
        bothWays(`${row.Name}: Synthetics cannot have Bioware installed.`);
      }
    }
  }

  // One tier per family — the better grade replaces the lesser (see augmentTier).
  const tiersHeld = {};
  for (const [row] of owned) {
    if (augmentStacks(row.Name, data)) continue;
    const { family } = augmentTier(row.Name);
    (tiersHeld[family] ??= new Set()).add(row.Name);
  }
  for (const [family, held] of Object.entries(tiersHeld)) {
    if (held.size > 1) {
      bothWays(`${family}: only one tier may be installed — `
               + `remove all but one of ${[...held].join(", ")}.`);
    }
  }

  for (const [row] of owned) {
    const banned = String(row.Ban || "").split(",").map(n => n.trim()).filter(Boolean);
    for (const bannedName of banned) {
      if (bannedName === "VCR") {
        if (hasVcr) {
          bothWays(`Augment conflict: ${row.Name} is incompatible `
                   + "with a Vehicle Control Rig.");
        }
      } else if ([...ownedNames].some(name => name !== row.Name && name.startsWith(bannedName))) {
        bothWays(`Augment conflict: ${row.Name} is incompatible with ${bannedName}.`);
      }
    }
  }

  for (const [row] of owned) {
    for (const [prefix, groups] of Object.entries(AUGMENT_REQUIREMENTS)) {
      if (!row.Name.startsWith(prefix)) continue;
      for (const group of groups) {
        if (!group.some(alternative => owns(alternative))) {
          bothWays(`${row.Name} requires ${group.join(" or ")}.`);
        }
      }
      break;
    }
  }

  const skillwireRating = maxOf(
    [...ownedNames].filter(n => n.startsWith("Skillwires")).map(augmentLevel), 0);
  // Only a slotted Skillsoft grants its bonus; how many can be slotted at
  // once is capped by the number of Chipjacks installed.
  const chipjackCount = owned
    .filter(([row]) => row.Name === "Chipjack")
    .reduce((sum, [, count]) => sum + count, 0);
  const skillsoftLevels = {};
  let slottedSkillsoftCount = 0;
  for (const [row, , entry] of owned) {
    if (!row.Name.startsWith("Skillsoft")) continue;
    const level = augmentLevel(row.Name);
    const target = entry.target || "";
    if (!(target in SKILLS)) {
      warnings.push(`${row.Name}: choose the skill it grants.`);
      continue;
    }
    if (skillwireRating && level > skillwireRating) {
      errors.push(`${row.Name} (${target}) needs Skillwires rating ${level} — `
                  + `yours is ${skillwireRating}.`);
    }
    if (entry.slotted === false) continue;
    slottedSkillsoftCount++;
    skillsoftLevels[target] = Math.max(skillsoftLevels[target] || 0, level);
  }
  if (slottedSkillsoftCount > chipjackCount) {
    errors.push(`${slottedSkillsoftCount} Skillsoft(s) slotted but only `
                + `${chipjackCount} Chipjack(s) installed.`);
  }

  const eyewareModCount = sumBy(owned, ([row, count]) =>
    (row.Type === "Eyeware" && row.Name !== CYBER_EYES_NAME) ? count : 0);
  if (eyewareModCount > 1 && !ownedNames.has(CYBER_EYES_NAME)) {
    errors.push(`More than 1 Eyeware augment requires ${CYBER_EYES_NAME}.`);
  }

  const strengthEnhancementRank = maxOf(
    [...ownedNames].filter(n => n.startsWith("Strength Enhancement")).map(augmentLevel), 0);
  const muscleReplacementRank = maxOf(
    [...ownedNames].filter(n => n.startsWith("Muscle Replacement")).map(augmentLevel), 0);
  if (strengthEnhancementRank > muscleReplacementRank) {
    warnings.push(`Strength Enhancement ${strengthEnhancementRank} needs Muscle `
                  + `Replacement ${strengthEnhancementRank}+ (you have `
                  + `${muscleReplacementRank}) — you risk injury when exerting yourself.`);
  }

  const effZr = augmentEffZr, effCost = augmentEffCost;

  const typeZr = (typeName, exclude = []) => sumBy(owned, ([row, count, entry]) =>
    (row.Type === typeName && !exclude.includes(row.Name))
      ? effZr(row, entry) * count : 0);

  const rawZr = sumBy(owned, ([row, count, entry]) => effZr(row, entry) * count);
  let zrAbsorbed = 0.0;
  if (ownedNames.has(CYBER_EYES_NAME)) {
    zrAbsorbed += Math.min(CYBER_SENSE_ZR_ABSORB, typeZr("Eyeware", [CYBER_EYES_NAME]));
  }
  if (ownedNames.has(CYBER_EARS_NAME)) {
    zrAbsorbed += Math.min(CYBER_SENSE_ZR_ABSORB, typeZr("Earware", [CYBER_EARS_NAME]));
  }
  const limbCount = sumBy(owned, ([row, count]) =>
    LIMB_REPLACEMENT_TYPES.includes(row.Type) ? count : 0);
  if (limbCount) {
    zrAbsorbed += Math.min(CYBER_LIMB_ZR_ABSORB * limbCount, typeZr("Cyberlimbs"));
  }

  // Each installed Knowledge Skillsoft grants one extra Knowledge skill point.
  const knowledgePointsBonus = toInt(sumBy(owned, ([row, count]) =>
    row.Name === "Knowledge Skillsoft" ? count : 0));

  return {
    ...augmentEffectSums(owned),
    rows: owned,
    zoetic_rating: round2(Math.max(0.0, rawZr - zrAbsorbed)),
    zoetic_rating_raw: round2(rawZr),
    body_index: sumBy(owned, ([row, count]) => asNumber(row.BI) * count),
    cost: sumBy(owned, ([row, count, entry]) => effCost(row, entry) * count),
    // Bioware is grown to fit, so it never carries the small-heritage surcharge.
    bioware_cost: sumBy(owned, ([row, count, entry]) =>
      row.Type === "Bioware" ? effCost(row, entry) * count : 0),
    skillsoft_levels: skillsoftLevels,
    knowledge_points_bonus: knowledgePointsBonus,
    has_hyperthyroid: ownedNames.has("Hyperthyroid"),
  };
}

// ============================================================== step 3b: gear mounts
// Gear rows carrying a "Mount Types" column can host non-Bioware augments
// (Power Armor, Arwin Goggles, homebrew). Mounted augments live on the host
// entry's `mounted` array ({name, alpha}) — they are bought and managed with
// the gear, never appear in character.augments, and their ZR must fit the
// host's "Mount ZP" capacity. That ZR never touches the character's ZP, and
// their effects apply only while the host is worn / carried / equipped.
// Augments no host can ever mount, whatever its Mount Types say. Skillsofts
// are Headware, so an "Any" host would otherwise offer them — but a Skillsoft
// only runs from a Chipjack wired into your head, never from a gear device.
const MOUNT_EXCLUDED_RE = /^(Skillsoft|Knowledge Skillsoft)/;
// Worn on the face, so it can't share a head with a Helmet.
const HEAD_MOUNTED_GEAR = "Arwin Goggles";

/* "Mount Types" is a comma-separated list of tokens. A token is an augment
 * **Type** ("Eyeware"), the literal "Any", or a single augment **Name**
 * ("Commlink") when a host takes one specific item out of a category it
 * otherwise doesn't accept. A leading "!" excludes instead of including, which
 * is how a host takes most of a category but not all of it — a Helmet mounts
 * Eyeware and Earware, but not a whole Cybertechtronic Eye.
 *
 * Exclusions always beat inclusions, so order in the cell doesn't matter. */
function mountCapability(row) {
  const raw = String(row["Mount Types"] || "").trim();
  if (!raw) return null;
  const tokens = raw.split(",").map(t => t.trim()).filter(Boolean);
  const denied = [], types = [];
  for (const token of tokens) {
    if (token.startsWith("!")) denied.push(token.slice(1).trim());
    else types.push(token);
  }
  const any = types.some(t => t.toLowerCase() === "any");
  const listed = (list, aug) => list.some(t => t === aug.Type || t === aug.Name);
  const describe = list => list.join(", ");
  return {
    types, denied, any,
    capacity: asNumber(row["Mount ZP"]),
    // Takes an augment row: the Skillsoft exclusion is by name, not by type.
    accepts: aug => aug.Type !== "Bioware" && !MOUNT_EXCLUDED_RE.test(aug.Name || "")
                    && !listed(denied, aug)
                    && (any || listed(types, aug)),
    label: (any ? "any non-Bioware augment" : describe(types))
           + (denied.length ? ` (except ${describe(denied)})` : ""),
  };
}

// Why a host refuses an augment — shown as a warning (engine) or as the
// disabled Add button's tooltip (UI).
function mountRefusal(hostName, row, cap) {
  if (row.Type === "Bioware") {
    return `${hostName} cannot mount ${row.Name}: Bioware can't be mounted in gear.`;
  }
  if (MOUNT_EXCLUDED_RE.test(row.Name || "")) {
    return `${hostName} cannot mount ${row.Name}: Skillsofts must be slotted in a Chipjack.`;
  }
  return `${hostName} cannot mount ${row.Name} (${row.Type || "?"}) — `
         + `it accepts ${cap.label}.`;
}

function tallyMountedAugments(character, data, warnings, errors) {
  // [entries, table, name column, host-active test, copies owned]
  const hostKinds = [
    [character.armor || [], data.armor, "Armor",
     e => e.active !== false, () => 1],
    [character.weapons || [], data.weapons, "Weapon",
     e => e.equipped !== false, e => Math.max(1, toInt(asNumber(e.qty, 1)))],
    [character.gear || [], data.misc_gear, "Item",
     e => e.carried !== false, e => Math.max(1, toInt(asNumber(e.qty, 1)))],
  ];

  const active = [];   // [row, 1, mounted entry] — feeds the shared effect sums
  const mountErrors = [];
  let cost = 0.0, totalZr = 0.0;
  for (const [entries, table, nameColumn, isActive, copies] of hostKinds) {
    for (const host of entries) {
      const mountedList = host.mounted || [];
      if (!mountedList.length) continue;
      const hostRow = findRow(table, nameColumn, host.name);
      const cap = hostRow && mountCapability(hostRow);
      if (!cap) {
        warnings.push(`${host.name} cannot mount augments — remove the augments mounted on it.`);
        continue;
      }
      let used = 0.0;
      for (const mount of mountedList) {
        const row = findRow(data.augments, "Name", mount.name);
        if (!row) continue;
        cost += augmentEffCost(row, mount);
        used += augmentEffZr(row, mount);
        if (!cap.accepts(row)) {
          warnings.push(mountRefusal(host.name, row, cap));
        } else if (isActive(host)) {
          active.push([row, 1, mount]);
        }
      }
      const capacity = round2(cap.capacity * copies(host));
      if (used - capacity > 1e-9) {
        mountErrors.push(`Overloaded Mount: ${host.name} holds ZR ${round2(used)} `
                         + `of mounted augments — its capacity is ${capacity} ZP.`);
      }
      totalZr += used;
    }
  }
  errors.push(...mountErrors);
  return { ...augmentEffectSums(active), rows: active, cost,
           mounted_zr: round2(totalZr), mount_errors: mountErrors };
}

/* Fold gear-mounted augments' cost and active effects into the body-augment
 * tally so every downstream consumer (attributes, combat, initiative notes,
 * wound-penalty scan) sees them without special-casing. The ZR fields are
 * deliberately untouched: mounted ZR never counts against the character.
 *
 * **Everything adds.** A gear-mounted augment that duplicates a body one is a
 * second piece of hardware, and two of a thing does twice the work. The single
 * exception is `ballistic_armor_max`, which is not a quantity but a cap — the
 * highest single ballistic source, because ballistic armor doesn't stack — so
 * it takes the larger of the two rather than their sum.
 *
 * This used to be a per-stat split, with dodge, melee exploits, damage
 * reduction and skill bonuses all capping. That was never written down anywhere
 * a player could find it, which is what JC-006 was raised about. */
function mergeMountedAugments(augments, mounted) {
  augments.cost += mounted.cost;
  for (const name of ATTRIBUTES) {
    augments.attribute_adjustment[name] += mounted.attribute_adjustment[name];
    augments.attribute_max_adjustment[name] += mounted.attribute_max_adjustment[name];
  }
  for (const [skill, bonus] of Object.entries(mounted.skill_bonus)) {
    augments.skill_bonus[skill] = (augments.skill_bonus[skill] || 0) + bonus;
  }
  for (const [skill, notes] of Object.entries(mounted.skill_notes || {})) {
    (augments.skill_notes[skill] = augments.skill_notes[skill] || []).push(...notes);
  }
  augments.move_bonus += mounted.move_bonus;
  augments.recoil_capacity_bonus += mounted.recoil_capacity_bonus || 0;
  augments.gyromount_count += mounted.gyromount_count || 0;
  augments.dodge_bonus += mounted.dodge_bonus;
  augments.impact_armor += mounted.impact_armor;
  augments.ballistic_armor += mounted.ballistic_armor;
  augments.impact_armor_min += mounted.impact_armor_min;
  // The one cap, not a quantity: the best single ballistic source.
  augments.ballistic_armor_max = Math.max(augments.ballistic_armor_max,
                                          mounted.ballistic_armor_max);
  augments.melee_exploit_bonus += mounted.melee_exploit_bonus;
  augments.internal_armor_slot_items.push(...mounted.internal_armor_slot_items);
  augments.mobility_move_notes.push(...mounted.mobility_move_notes);
  augments.combat_notes.push(...(mounted.combat_notes || []));
  augments.sense_notes.push(...(mounted.sense_notes || []));
  augments.move_modes.push(...(mounted.move_modes || []));
  augments.physical_damage_reduction += mounted.physical_damage_reduction || 0;
  augments.has_move_exploit = augments.has_move_exploit || mounted.has_move_exploit;
  augments.move_exploit_sources.push(...(mounted.move_exploit_sources || []));
  augments.rows.push(...mounted.rows);
  augments.mounted_zr = mounted.mounted_zr;
  augments.mount_errors = mounted.mount_errors;
}

// ============================================================== step 4: amp powers
function tallyAmpPowers(character, data, magicType, warnings, errors) {
  let zpSpent = 0.0;
  const attributeAdjustment = {}, attributeMaxAdjustment = {};
  for (const name of ATTRIBUTES) { attributeAdjustment[name] = 0; attributeMaxAdjustment[name] = 0; }
  const skillBonus = {};
  const powersTaken = new Set();

  const eligible = magicType === "Amp" || magicType === "Archmage";
  const requestedPowers = character.magic.amp_powers || [];
  if (!eligible) {
    if (requestedPowers.length) {
      warnings.push("Amp powers require Amp or Archmage magic type.");
    }
    return { spent: 0.0, attribute_adjustment: attributeAdjustment,
             attribute_max_adjustment: attributeMaxAdjustment,
             skill_bonus: skillBonus, powers_taken: powersTaken,
             expertise_skills: new Set() };
  }

  const costMultiplier = magicType === "Amp" ? AMP_COST_MULTIPLIER : 1.0;
  const expertiseSkills = new Set();
  for (const entry of requestedPowers) {
    const row = findRow(data.amp_powers, "Name", entry.name);
    if (!row) continue;
    const times = Math.max(1, toInt(asNumber(entry.times, 1)));
    zpSpent += asNumber(row["ZP Cost"]) * costMultiplier * times;
    powersTaken.add(row.Name);
    const target = entry.target || "";

    if (row.Name === "Attribute Boost" && ATTRIBUTES.includes(target)) {
      attributeAdjustment[target] += times;
      attributeMaxAdjustment[target] += times;
    } else if (row.Name === "Attribute Increase" && ATTRIBUTES.includes(target)) {
      attributeAdjustment[target] += times;
    } else if (row.Name === "Expertise" && (target in SKILLS)) {
      // Stays here: Expertise raises the skill's CAP as well as its rating
      // (expertiseSkills), and "Skill Bonus" has no way to say that. It also
      // targets a skill the player picks rather than one the row names.
      skillBonus[target] = (skillBonus[target] || 0) + EXPERTISE_SKILL_BONUS * times;
      expertiseSkills.add(target);
    }
    // Eyes of the Raptor, Might of the Bear, Sting of the Scorpion and Hidden
    // Presence used to be four more branches here. They are now "Skill Bonus"
    // columns on their own rows, read by gearSkillEffects like every other
    // table's -- so homebrew amp powers can grant skill dice too, and a typo
    // gets reported instead of silently granting nothing.
  }

  return {
    spent: zpSpent,
    attribute_adjustment: attributeAdjustment,
    attribute_max_adjustment: attributeMaxAdjustment,
    skill_bonus: skillBonus,
    powers_taken: powersTaken,
    expertise_skills: expertiseSkills,
  };
}

// ============================================================== step 5: attributes
function cumulativeAttributeCost(level, costTable) {
  const clampedLevel = Math.max(ATTRIBUTE_LEVEL_MIN,
    Math.min(toInt(level), ATTRIBUTE_LEVEL_MAX));
  return costTable[clampedLevel] !== undefined ? costTable[clampedLevel] : clampedLevel;
}

/* `infusionAdjustment` is an optional 4th adjustment source: temporary boosts
 * from spirits placed in infusion slots. It lands in `adjust` (so every derived
 * stat sees it) and in `max` (so a supernatural boost doesn't trip the
 * "exceeds its maximum" warning) — the same treatment heritage adjustments get.
 * It never touches pointsSpent, which is derived from base levels alone. */
function scoreAttributes(character, data, startingAttributePoints, heritage, augments, amp,
                         warnings, errors, infusionAdjustment) {
  const costTable = {};
  for (const row of data.attribute_costs) costTable[toInt(Number(row.Level))] = toInt(Number(row.Cost));
  const baseLevel = {};
  for (const name of ATTRIBUTES) {
    baseLevel[name] = Math.max(1, toInt(asNumber(character.attributes[name], 1)));
  }
  const pointsSpent = sumBy(Object.values(baseLevel),
    level => cumulativeAttributeCost(level, costTable));
  const pointsRemaining = (MANDATORY_ATTRIBUTE_REFUND + startingAttributePoints
                           - pointsSpent + heritage.uplift_attribute_point_modifier);
  if (pointsRemaining < 0) {
    errors.push(`Attribute points overspent by ${-pointsRemaining}.`);
  }

  const attributes = {};
  for (const name of ATTRIBUTES) {
    const infusionBonus = toInt((infusionAdjustment || {})[name]);
    const adjustment = (heritage.attribute_adjustment[name]
                        + augments.attribute_adjustment[name]
                        + amp.attribute_adjustment[name]
                        + infusionBonus);
    const finalValue = baseLevel[name] + adjustment;
    const maxValue = (ATTRIBUTE_MAX_BASELINE
                      + heritage.attribute_max_adjustment[name]
                      + heritage.attribute_adjustment[name]
                      + augments.attribute_max_adjustment[name]
                      + amp.attribute_max_adjustment[name]
                      + infusionBonus);
    attributes[name] = { base: baseLevel[name], adjust: adjustment,
                         final: finalValue, max: maxValue };
    if (finalValue > maxValue) {
      warnings.push(`${name} ${finalValue} exceeds its maximum of ${maxValue}.`);
    }
  }

  const finals = {};
  for (const name of ATTRIBUTES) finals[name] = attributes[name].final;

  return {
    attributes,
    final: finals,
    points: { budget: startingAttributePoints,
              uplift_mod: heritage.uplift_attribute_point_modifier,
              spent: pointsSpent - MANDATORY_ATTRIBUTE_REFUND,
              remaining: pointsRemaining },
  };
}

// ============================================================== step 3b: pools
function computePools(finalAttributes, chaPoolChoice) {
  const charismaQuarterShare = finalAttributes.Charisma * 0.25;
  const pools = {
    Brawn: (finalAttributes.Strength
            + 0.5 * finalAttributes.Body
            + 0.25 * finalAttributes.Willpower),
    Finesse: (0.5 * finalAttributes.Body
              + finalAttributes.Reaction
              + 0.25 * finalAttributes.Intelligence),
    Focus: (0.5 * finalAttributes.Reaction
            + finalAttributes.Intelligence
            + 0.25 * finalAttributes.Willpower),
    Resolve: (0.5 * finalAttributes.Intelligence
              + finalAttributes.Willpower
              + 0.5 * finalAttributes.Charisma),
  };
  if (chaPoolChoice in pools) pools[chaPoolChoice] += charismaQuarterShare;
  const floored = {};
  for (const [pool, value] of Object.entries(pools)) floored[pool] = Math.floor(value);
  return floored;
}

// ============================================================== step 6: skills
function scoreSkills(character, heritage, amp, augments, warnings, errors, playErrors) {
  const skillPoints = {};
  for (const [name, value] of Object.entries(character.skills)) {
    if (name in SKILLS) skillPoints[name] = toInt(asNumber(value));
  }
  let pointsSpent = sumBy(Object.values(skillPoints), points => Math.max(0, points));

  // Martial arts: each chosen style is an independent skill at 2 pts/rank, and
  // no style may exceed Unarmed Combat rank. (Martial Arts isn't in `skills`, so
  // it's costed separately here.)
  const unarmedRank = Math.max(0, skillPoints["Unarmed Combat"] || 0);
  for (const ma of character.martial_arts || []) {
    const rank = Math.max(0, toInt(asNumber(ma.rank)));
    pointsSpent += rank * MARTIAL_ARTS_COST_MULTIPLIER;
    if (rank > unarmedRank) {
      const message = `Martial Arts (${ma.style || "unnamed style"}) rank ${rank} `
        + `cannot exceed Unarmed Combat rank ${unarmedRank}.`;
      errors.push(message);
      if (playErrors) playErrors.push(message);   // still illegal after Finalize
    }
    if (rank > SKILL_RANK_CAP)
      warnings.push(`Martial Arts (${ma.style || "unnamed style"}): maximum ${SKILL_RANK_CAP} points at creation.`);
  }

  // A specialization stays free and uncapped, but it splits a rating you
  // actually have -- the parent skill needs at least one rank of its own.
  for (const [name, entry] of Object.entries(character.skill_specializations || {})) {
    if (!entry || !entry.on || !(name in SKILLS)) continue;
    if (Math.max(0, skillPoints[name] || 0) < 1) {
      errors.push(`${name}: a specialization needs at least 1 rank in the skill.`);
    }
  }

  const ritualSkills = {};
  for (const [name, points] of Object.entries(character.ritual_skills || {})) {
    ritualSkills[name] = Math.max(0, toInt(asNumber(points)));
  }
  for (const [name, points] of Object.entries(ritualSkills)) {
    if (points > SKILL_RANK_CAP) {
      warnings.push(`Ritual ${name}: maximum ${SKILL_RANK_CAP} points at creation.`);
    }
  }
  pointsSpent += sumBy(Object.values(ritualSkills), v => v);

  const groups = {};
  for (const [name, [, group]] of Object.entries(SKILLS)) {
    if (group) (groups[group] = groups[group] || []).push(name);
  }

  const expertiseSkills = amp.expertise_skills || new Set();
  const skillsoftLevels = augments.skillsoft_levels || {};
  const results = {};
  for (const [name, [pool, group]] of Object.entries(SKILLS)) {
    const points = Math.max(0, skillPoints[name] || 0);
    if (points > SKILL_RANK_CAP) {
      warnings.push(`${name}: maximum ${SKILL_RANK_CAP} skill points at creation.`);
    }

    let bonus = ((heritage.skill_bonus[name] || 0)
                 + heritage.all_skills_bonus
                 + (amp.skill_bonus[name] || 0)
                 + ((augments.skill_bonus || {})[name] || 0));
    if (name.startsWith("Engineering") && heritage.has_hephestus) {
      bonus += HEPHESTUS_ENGINEERING_BONUS;
    }
    if (RANGED_ATTACK_SKILLS.includes(name) && heritage.has_cyclopean) {
      bonus -= CYCLOPEAN_RANGED_PENALTY;
    }
    // Specialization is NOT a rank in every skill of its pool — it's a bonus
    // die on each, granted below with the drone dice. Raising the rating would
    // also raise what the skill can be pushed to and what its group falls back
    // to; a die does neither.

    let groupValue = null;
    if (group && points === 0) {
      const bestFallback = maxOf(groups[group].map(sibling =>
        Math.max(0, skillPoints[sibling] || 0)
        - (expertiseSkills.has(sibling) ? 0 : GROUP_FALLBACK_PENALTY)), 0);
      const bestTrained = maxOf(groups[group].map(sibling =>
        Math.max(0, skillPoints[sibling] || 0)), 0);
      // Untrained group fallback needs a sibling trained strictly above
      // GROUP_FALLBACK_MIN_TRAINED (i.e. rank 3+); a sibling at exactly the
      // threshold does not unlock it.
      if (bestTrained > GROUP_FALLBACK_MIN_TRAINED) {
        groupValue = bestFallback + bonus;
      }
    }

    const softLevel = skillsoftLevels[name] || 0;
    // Group fallback dice count toward final, so an untrained skill with a
    // trained group sibling rolls its group dice with no special notation.
    results[name] = { points, bonus,
                      final: Math.max(points + bonus, softLevel, groupValue || 0),
                      soft: softLevel,
                      pool, group, group_value: groupValue,
                      trained_only: TRAINED_ONLY_SKILLS.has(name),
                      notes: (augments.skill_notes || {})[name] || [] };
  }

  return {
    skills: results,
    ritual_skills: ritualSkills,
    points: { budget: null, spent: pointsSpent },
  };
}

/* Which skill a weapon is attacked with, keyed by the weapons table's `Type`.
 * Two keys aren't row Types: "Cybergun" (implanted guns have their own table
 * and are always pistols) and "Natural", the fallback for granted weapons --
 * amp-power and heritage attacks like Iron Fist or a Shark's bite are made with
 * the body, so they default to Unarmed Combat rather than Melee Weapons. */
const WEAPON_TYPE_SKILL = {
  Melee: "Melee Weapons",
  Thrown: "Throwing Weapons",
  PistolLt: "Firearms", PistolMed: "Firearms", PistolHvy: "Firearms",
  SMG: "Firearms", Rifle: "Firearms", Shotgun: "Firearms",
  Cybergun: "Firearms",
  Heavy: "Heavy Weapons", GrenadeLauncher: "Heavy Weapons",
  Energy: "Energy Weapons",
  Projectile: "Archery",
  Natural: "Unarmed Combat",
};

/* The handful of weapons that don't follow their Type: bladed cyber implants
 * are Cybertech Combat, while knuckles and fangs are Unarmed. Keyed by the
 * exact name in the data (the asterisk is part of those two). */
const WEAPON_NAME_SKILL = {
  // The asterisk is part of the name in the data, but it's a footnote marker
  // rather than meaningful identity -- a data cleanup or a homebrew re-entry
  // that drops it would silently send Brass Knuckles to Melee Weapons (its Type)
  // and the Whip to Melee too. Both spellings map, so neither can drift.
  "Brass Knuckles*": "Unarmed Combat",
  "Brass Knuckles": "Unarmed Combat",
  "Fangs": "Unarmed Combat",
  "Monofilament Whip*": "Cybertech Combat",
  "Monofilament Whip": "Cybertech Combat",
  "Elbow Spurs": "Cybertech Combat",
  "Knee Spurs": "Cybertech Combat",
  "Hand Razors": "Cybertech Combat",
  "Hand Blade": "Cybertech Combat",
};

/** Canonical skill for a weapon, or null when nothing maps. Name beats Type.
 *  Granted weapons carry a "×2" count suffix, which isn't part of the name. */
function weaponSkillName(name, type) {
  const bare = String(name || "").replace(/\s*[x×]\s*\d+$/i, "").trim();
  if (WEAPON_NAME_SKILL[bare]) return WEAPON_NAME_SKILL[bare];
  // The cyber implants ship as "<base>-<variant>" rows -- Hand Razors-Improved,
  // Hand Blade-Retractable, Knee Spurs-Retractable and so on. They are the same
  // weapon with a different mounting, so they roll the base weapon's skill.
  // Matching only the exact name silently dropped every variant through to the
  // Type mapping, where granted weapons are "Natural" and default to Unarmed
  // Combat -- the Overview showed Unarmed dice for a Cybertech Combat implant.
  const base = bare.split("-")[0].trim();
  if (WEAPON_NAME_SKILL[base]) return WEAPON_NAME_SKILL[base];
  return WEAPON_TYPE_SKILL[type] || null;
}

/* ---- firing modes -----------------------------------------------------------
 * Each mode trades ammunition for bonus dice. Bonus dice are tracked apart from
 * skill dice because they behave differently at the table, so the UI adds them
 * to the same "bonus" pool as Accuracy rather than to the skill rating.
 *
 * SS is the default and buys nothing; it still spends the single round fired.
 * "FA (40)" is a heavier full-auto that spends 40 rounds for 40 dice instead of
 * the standard 20/20. */
const FIRING_MODES = {
  "SS": { name: "Single Shot", dice: 0,  ammo: 1 },
  "DT": { name: "Double Tap",  dice: 1,  ammo: 2 },
  "BF": { name: "Burst Fire",  dice: 3,  ammo: 3 },
  "FA": { name: "Full Auto",   dice: 20, ammo: 20 },
};
// Melee and thrown weapons aren't fired, so they get no mode at all.
const UNFIRED_WEAPON_TYPES = new Set(["Melee", "Thrown"]);

/** Resolve a mode token to its trade, or null when it isn't a mode.
 *  Vehicle and drone mounts scale their bursts -- "FA (40)", "FA (60)",
 *  "BF (4)" -- where the parenthetical is the round count and the dice match
 *  it, the same trade the base modes make at a bigger scale. Parsed generically
 *  so a new size in the data needs no code. */
function parseFiringMode(token) {
  const key = String(token || "").trim();
  if (FIRING_MODES[key]) return Object.assign({ key }, FIRING_MODES[key]);
  const m = /^([A-Za-z]+)\s*\((\d+)\)$/.exec(key);
  const base = m && FIRING_MODES[m[1].toUpperCase()];
  if (!base) return null;
  const n = +m[2];
  return { key, name: `${base.name} (${n})`, dice: n, ammo: n };
}
function firingMode(token) {
  return parseFiringMode(token) || Object.assign({ key: "SS" }, FIRING_MODES.SS);
}

/** The firing modes a weapon offers, cheapest first. Reads "Firing modes"
 *  (personal weapons) or "Modes" (vehicle / drone mounts).
 *  Most Energy weapons put a weapon class in that column (Laser pistol,
 *  Railgun, ...) rather than modes, and are single-shot; they fall back to SS.
 *  But an Energy weapon that DOES name real modes keeps them -- the Militech
 *  X-3 spins up to full auto -- so the exception is data-driven rather than a
 *  hardcoded name. A mount with a blank column (Oil Slick, Smokescreen) isn't
 *  really fired and gets nothing. */
function weaponFiringModes(row) {
  if (!row || UNFIRED_WEAPON_TYPES.has(row.Type)) return [];
  const isUnit = row["Firing modes"] === undefined && row.Modes !== undefined;
  const text = isUnit ? row.Modes : row["Firing modes"];
  const found = String(text || "").split(",")
    .map(t => parseFiringMode(t)).filter(Boolean);
  if (!found.length) return isUnit ? [] : ["SS"];
  const seen = new Set();
  return found.sort((a, b) => a.ammo - b.ammo)
    .filter(m => !seen.has(m.key) && seen.add(m.key))
    .map(m => m.key);
}

/* ---- ammunition --------------------------------------------------------------
 * Ammo effects are prose in the gear table ("Pen +2. Barrier +1.", "+2
 * Accuracy. +3 Damage. Pen = 1. Range = S."), so the numbers a weapon line can
 * actually show -- Accuracy, Damage, Pen, Barrier -- are parsed out and
 * everything else is kept verbatim as a note. Both orderings appear in the
 * data, and Pen is sometimes SET rather than adjusted ("Pen = 0" for Gel),
 * which is not the same as an adjustment and has to win over the weapon's own
 * value. The data column is "Bar" but the prose says "Barrier", so both
 * spellings map to the same key.
 *
 * Every ammo row in misc_gear separates its clauses with a period, not a
 * comma -- "Pen +2. Barrier +1." -- so splitting on "," alone (what this used
 * to do) never split anything: a two-clause effect stayed one unbroken string,
 * failed every anchored regex below because of the leftover ". Barrier +1."
 * hanging off the end, and fell straight through to `notes`. The number was
 * never applied; only the note LOOKED like it had been, because the note text
 * repeats the same prose the number should have come from. AP's "Pen +2.
 * Barrier +1." read as a note and the Kalishnikov's Pen/Barrier stayed at
 * their un-modified 5/4 with no visual sign anything was wrong. Splitting on
 * "[,.]" fixes every multi-clause ammo in the data at once -- AP, Flechette,
 * Buckshot, HEI, AP/Razor, Subsonic loads, Tracer Rounds -- not just the one
 * that got noticed. */
/* The numbers a round can move. The four the weapon line always shows -- Acc,
 * Damage, Pen, Barrier -- land on the shot itself; the rest (magazine size,
 * Recoil, Hardening, Conceal, Weight, ZR, Rarity) land on the weapon's row,
 * so a homebrew round can reach everything a weapon MOD can reach (#86).
 * Several spellings map to one key because the columns and the prose disagree:
 * the column is "Bar" but the text says "Barrier", the column is "Ammo" but
 * the stat line says "Mag". */
const AMMO_STAT_KEYS = {
  acc: "acc", accuracy: "acc",
  dmg: "damage", damage: "damage",
  pen: "pen", penetration: "pen",
  bar: "bar", barrier: "bar",
  mag: "mag", magazine: "mag", ammo: "mag", capacity: "mag",
  recoil: "recoil",
  hard: "hardening", hardening: "hardening",
  conceal: "conceal", concealability: "conceal", concealment: "conceal",
  weight: "weight", wt: "weight",
  zr: "zr",
  rarity: "rarity",
};
/* Which weapon column each of the row-level stats writes to. Anything not
 * listed here is a shot stat and is applied by applyAmmoStats instead. */
const AMMO_STAT_COLUMNS = {
  mag: "Ammo", recoil: "Recoil", hardening: "Hardening",
  conceal: "Conceal", weight: "Weight", zr: "ZR", rarity: "Rarity",
};

/* Firing modes a round changes: "Modes = SS, DT" (all this gun can fire with
 * these loaded), "Modes -FA" (can't be walked out on full auto), "Modes +BF".
 * Pulled out of the effect text BEFORE the clause split below, because a mode
 * list contains the very commas that split clauses -- "Modes = SS, DT" would
 * otherwise arrive as "Modes = SS" and a stray "DT". Tokens are validated
 * through parseFiringMode, so prose that happens to fit the shape ("Modes -
 * see the notes") is left alone and falls through to the notes as before. */
const AMMO_MODES_RE =
  /\bmodes?\s*(=|\+|-)\s*([A-Za-z]{2}(?:\s*\(\d+\))?(?:\s*,\s*[A-Za-z]{2}(?:\s*\(\d+\))?)*)/gi;

function ammoStatMods(effectText) {
  const out = { acc: 0, damage: 0, pen: 0, bar: 0, mag: 0, recoil: 0, hardening: 0,
                conceal: 0, weight: 0, zr: 0, rarity: 0, set: {}, modes: null, notes: [] };
  const statOf = w => AMMO_STAT_KEYS[String(w || "").toLowerCase()];
  const text = String(effectText || "").replace(AMMO_MODES_RE, (whole, op, list) => {
    const keys = list.split(",").map(t => t.trim().toUpperCase()).filter(t => parseFiringMode(t));
    if (!keys.length) return whole;                 // not modes after all -- keep the prose
    const m = out.modes || (out.modes = { set: null, add: [], remove: [] });
    if (op === "=") m.set = keys;
    else if (op === "+") m.add.push(...keys);
    else m.remove.push(...keys);
    return " ";
  });
  // Split on clause punctuation, but not on the dot INSIDE a number: the data
  // separates clauses with ". " and a decimal never has a space after the point,
  // so a comma or a period that isn't between two digits ends a clause.
  for (const rawPart of text.split(/(?<!\d)[,.]\s*|[,.](?!\d)\s*/)) {
    const part = rawPart.trim();
    if (!part) continue;
    let m;
    // "Pen = 0" / "Pen = 1" -- an absolute value, not a delta. Trailing prose is
    // kept as a note ("Pen = 1 Range = S" carries the Range half through).
    if ((m = /^([A-Za-z]+)\s*=\s*(-?\d+(?:\.\d+)?)\s*(.*)$/.exec(part)) && statOf(m[1])) {
      out.set[statOf(m[1])] = +m[2];
      if (m[3].trim()) out.notes.push(m[3].trim());
      continue;
    }
    // "Pen +1" or "+3 Dmg"
    if (((m = /^([A-Za-z]+)\s*([+-]\d+(?:\.\d+)?)$/.exec(part)) && statOf(m[1]))) {
      out[statOf(m[1])] += +m[2]; continue;
    }
    if (((m = /^([+-]\d+(?:\.\d+)?)\s*([A-Za-z]+)$/.exec(part)) && statOf(m[2]))) {
      out[statOf(m[2])] += +m[1]; continue;
    }
    out.notes.push(part);
  }
  return out;
}

/** Apply an ammo's parsed mods to a weapon's numbers. Absolute values win.
 *  Damage is often stated as a number with prose attached ("20 Stun",
 *  "10+fire"), so the adjustment lands on the leading number and the rest is
 *  carried through untouched -- Flashbang + Flechette is "21 Stun", not "21".
 *  Values with no leading number at all ("By Grenade", "By Missile", "1/2 Str",
 *  "Tgt Brawn Test (4)", "-") describe damage some other way and are left
 *  exactly as they are.
 *
 *  Every key the caller passes in is resolved, so a caller that wants only the
 *  four shot stats passes four, and one that also wants the magazine passes
 *  `mag` too and gets it back adjusted. */
function applyAmmoStats(base, mods) {
  const one = (key, raw) => {
    if (mods.set[key] != null) return mods.set[key];
    const d = mods[key] || 0;
    if (!d) return raw;                              // nothing to apply
    const s = String(raw).trim();
    const m = /^(-?\d+(?:\.\d+)?)(.*)$/.exec(s);
    if (!m) return raw;                              // no leading number
    return `${round2(parseFloat(m[1]) + d)}${m[2]}`;
  };
  const out = {};
  for (const key of Object.keys(base || {})) out[key] = one(key, base[key]);
  return out;
}

/** Fold a round's row-level stats into a weapon's calc row and hand back a
 *  copy -- the pricing pass owns the row it produced and nothing here may
 *  write to it. `base` is the weapon's data row, read for a column the calc
 *  row doesn't carry (Hardening, ZR and Rarity never reach a priced row).
 *
 *  A column the weapon doesn't rate at all is left alone rather than invented:
 *  a Katana has no magazine and no Recoil, and a round that says "Mag +5" must
 *  not give it one. Hardening is the exception -- every weapon has one, blank
 *  meaning the default -- so a delta resolves that default first.
 *
 *  Recoil and Conceal already print "(+N mods)", so the ammo's share joins
 *  that annotation instead of silently moving the number. */
const AMMO_NUMERIC_RE = /^\s*-?\d+(\.\d+)?\s*$/;
function applyAmmoToRow(row, base, mods) {
  const out = { ...(row || {}) };
  if (!mods) return out;
  const label = (cur, add) => (cur ? `${cur} + ${add}` : add);
  for (const [stat, col] of Object.entries(AMMO_STAT_COLUMNS)) {
    const setTo = mods.set[stat];
    const delta = mods[stat] || 0;
    if (setTo == null && !delta) continue;
    let cur = (out[col] != null && String(out[col]).trim() !== "")
      ? out[col] : ((base || {})[col] ?? "");
    if (stat === "hardening" && String(cur).trim() === "") cur = hardeningOf(base || {});
    if (String(cur).trim() === "") continue;          // unrated -- not this weapon's stat
    // A rating stated as prose isn't a number to adjust: a missile rack holds
    // "1 missile", and adding 40 to that is meaningless. Left exactly as it is,
    // the same call applyExtendedMagazine makes about the same column.
    if (!AMMO_NUMERIC_RE.test(String(cur))) continue;
    // None of these ratings mean anything below zero -- a round that takes 10
    // off a 2-round taser leaves a magazine of 0 (it doesn't fit), not -8.
    // Arrow weights are fractional (0.05), so the arithmetic keeps decimals and
    // only the display rounding drops them.
    const next = Math.max(0, setTo != null ? setTo : asNumber(cur) + delta);
    out[col] = String(Number.isInteger(next) ? next : round2(next));
    if (stat === "recoil") {
      out.recoil_mod = (toInt(out.recoil_mod) || 0) + (setTo != null ? 0 : delta);
      out.recoil_mod_label = label(out.recoil_mod_label, "ammo");
    }
    if (stat === "conceal") {
      out.conceal_mod = (toInt(out.conceal_mod) || 0) + (setTo != null ? 0 : delta);
      out.conceal_mod_label = label(out.conceal_mod_label, "ammo");
    }
  }
  return out;
}

/** The firing modes a gun offers with this round loaded, cheapest first -- the
 *  same order weaponFiringModes returns, since this replaces its answer. A
 *  round that removes every mode leaves the gun unfirable, which is the honest
 *  reading of a round that bars the only mode the gun has. */
function ammoFiringModes(modes, mods) {
  const m = mods && mods.modes;
  if (!m) return modes;
  const up = t => String(t).toUpperCase();
  let out = (m.set ? m.set : modes).slice();
  if (m.remove.length) out = out.filter(k => !m.remove.some(r => up(r) === up(k)));
  for (const k of m.add) if (!out.some(x => up(x) === up(k))) out.push(k);
  return out.sort((a, b) => firingMode(a).ammo - firingMode(b).ammo);
}

/* ---- ammo compatibility -----------------------------------------------------
 * Which weapons an ammunition will actually chamber. Keyed by ammo NAME rather
 * than by the prose in Notes, because several of the restrictions aren't stated
 * there at all -- Subsonic and the common special rounds carry no note. Each
 * rule takes the weapon's data row, so it can read Type, name or Damage.
 * Ammo not listed here (Standard, the exotic named rounds) is unrestricted. */
const HEAVY_RIFLES = [/AM-3/i, /M334/i, /Panther/i];
/* The common special rounds need a conventional bullet-firing gun: nothing that
 * lobs grenades or missiles, and nothing that already delivers stun damage. */
const takesConventionalRounds = row =>
  !/by grenade|by missile|stun/i.test(String((row && row.Damage) || ""));
const isLargeBore = row => HEAVY_RIFLES.some(rx => rx.test(String(row.Weapon || "")));
/* "Autofire only" — a round you only load to walk a burst onto the target, so
 * it needs a gun that can actually burst. Read off the weapon's own modes
 * rather than a list of names, so a new full-auto gun takes it on its own. */
const firesFullAuto = row => weaponFiringModes(row).includes("FA");
const AMMO_FITS = {
  "Buckshot":        row => row.Type === "Shotgun",
  "Subsonic loads":  row => row.Type !== "Shotgun",
  "API":             isLargeBore,
  // Recoilless Rifle / Autocannon only. The personal-scale guns that qualify
  // are the large-bore ones — the same set API needs.
  "High Explosive Incendiary (HEI)": isLargeBore,
  "Tracer Rounds":   firesFullAuto,
  "Gel":             takesConventionalRounds,
  "Flechette":       takesConventionalRounds,
  "Cased":           takesConventionalRounds,
  "Explosive":       takesConventionalRounds,
  "AM-3 Rifle ammo": row => /AM-3/i.test(String(row.Weapon || "")),
};
/* Every round that belongs to a vehicle / drone mount is barred from personal
 * weapons outright. Derived from UNIT_AMMO_FITS below so the two lists can't
 * drift -- adding a mount round in one place excludes it from the other. */
function ammoIsMountOnly(item) {
  return Object.prototype.hasOwnProperty.call(UNIT_AMMO_FITS, String(item || ""));
}
/* Arrows and bolts are their own ammunition class, and the split is total in
 * both directions: a bow takes nothing but projectile rounds, and no firearm
 * takes an arrow. One symmetric test rather than a rule per round — the default
 * for unlisted ammo is "fits", so without this every conventional round would
 * chamber in a crossbow. */
const PROJECTILE_AMMO_CLASS = "Ammo (Projectile)";
const PROJECTILE_WEAPON_TYPE = "Projectile";
function ammoFitsWeapon(ammoRow, weaponRow) {
  const item = String((ammoRow && ammoRow.Item) || "");
  if (ammoIsMountOnly(item)) return false;
  const isProjectileRound = (ammoRow && ammoRow.Class) === PROJECTILE_AMMO_CLASS;
  const isProjectileWeapon = (weaponRow && weaponRow.Type) === PROJECTILE_WEAPON_TYPE;
  if (isProjectileRound !== isProjectileWeapon) return false;
  const rule = AMMO_FITS[item];
  return rule ? !!rule(weaponRow || {}) : true;
}

/* The exotic rounds exist for vehicle and drone mounts, and each names the
 * mount it belongs to in its Notes. Matched here by mount name so the mount
 * pickers offer only what actually fits, and the ordinary personal rounds --
 * which say nothing about vehicles -- stay out of them entirely. */
/* Only the two that collide with a personal round of the same designation say
 * "Vehicle" (see RENAMED_AMMO); the rest were never ambiguous and keep the
 * names they have always had. */
const UNIT_AMMO_FITS = {
  "Micro missile (HEAP)": /missile launcher/i,
  "Micro Missile (anti-personnel)": /missile launcher/i,
  "Tank Rounds (HEAP)": /tank cannon/i,
  "Tank Rounds (HE)": /tank cannon/i,
  "Tank Rounds (KE)": /tank cannon/i,
  "Tank Rounds (Cannister)": /tank cannon/i,
  // The autocannons name their rounds in prose; these are those rounds. The
  // vehicle mount is "Autocannons" and the drone one "Autocannon", so match both.
  "Autocannon AP": /autocannon/i,
  "Vehicle Autocannon HEI": /autocannon/i,
  "Vehicle Autocannon Tracer": /autocannon/i,
  "20/25mm Cannon": /^25mm cannon$/i,
  "30mm Cannon": /^30mm cannon$/i,
  "Vulcan Cannon": /vulcan/i,
};
function ammoFitsUnitWeapon(ammoRow, unitWeaponName) {
  const rx = UNIT_AMMO_FITS[String((ammoRow && ammoRow.Item) || "")];
  return rx ? rx.test(String(unitWeaponName || "")) : false;
}

/* ---- weapon specializations -------------------------------------------------
 * A specialization is +1 to the skill when it covers what you're using and -1
 * when it doesn't, so it needs to be resolved per WEAPON rather than shown as a
 * flat -1/+1 pair. The text is free-form and may list several, separated by
 * commas, ampersands or slashes: "Pistols, Rifles".
 *
 * Matching is deliberately textual rather than a curated vocabulary. The Type
 * strings already carry the category word -- PistolLt / PistolMed / PistolHvy
 * all contain "Pistol" -- so normalising both sides and testing every word of
 * the term against "<type> <name>" covers the categories, narrower phrases like
 * "Heavy Pistols" (once Hvy/Lt/Med are spelled out), and a term naming one
 * specific gun.
 *
 * A term that matches NO weapon the skill can use is treated as not applying at
 * all, rather than quietly costing -1 on everything: a typo shouldn't silently
 * halve your dice. The UI surfaces those as dead terms so they can be fixed. */
const SPEC_ABBREV = { hvy: "heavy", lt: "light", med: "medium" };

function normalizeSpecText(s) {
  return String(s || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")   // PistolHvy -> Pistol Hvy
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .map(w => SPEC_ABBREV[w] || w)
    .filter(Boolean)
    .join(" ");
}
// Trailing plural is noise: "Pistols" and "Pistol" are the same specialty.
const specStem = w => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w);

/** Split a specialization field into its individual terms, original text kept
 *  for display. "Pistols, Rifles" / "Pistols & Rifles" / "Pistols/Rifles". */
function specTerms(text) {
  return String(text || "")
    .split(/[,&/]|\band\b/i)
    .map(t => t.trim())
    .filter(Boolean);
}

/** Does one term cover this weapon? Every word of the term must appear in the
 *  weapon's normalised "<type> <name>", so "Pistols" takes the whole pistol
 *  family while "Heavy Pistols" takes only PistolHvy. */
function specTermMatchesWeapon(term, weaponName, weaponType) {
  const words = normalizeSpecText(term).split(" ").map(specStem).filter(Boolean);
  if (!words.length) return false;
  const hay = normalizeSpecText(`${weaponType || ""} ${weaponName || ""}`)
    .split(" ").map(specStem).join(" ");
  return words.every(w => hay.includes(w));
}

/** Every weapon name/type pair the given skill is rolled for. */
function weaponsForSkill(skillName, data) {
  const out = [];
  for (const row of (data && data.weapons) || []) {
    if (weaponSkillName(row.Weapon, row.Type) === skillName) out.push(row);
  }
  return out;
}

/** Split a skill's specialization terms into the ones that actually cover
 *  something that skill can use, and the ones that match nothing. */
function classifySpecTerms(specEntry, skillName, data) {
  const live = [], dead = [];
  if (!specEntry || !specEntry.on) return { live, dead };
  const pool = weaponsForSkill(skillName, data);
  for (const term of specTerms(specEntry.text)) {
    const hit = pool.some(w => specTermMatchesWeapon(term, w.Weapon, w.Type));
    (hit ? live : dead).push(term);
  }
  return { live, dead };
}

/** The specialization adjustment for one weapon: +1 when a live term covers it,
 *  -1 when the skill is specialized but none do, 0 when there's no usable
 *  specialization at all. Returns { delta, term } -- `term` names the matching
 *  specialty so the UI can say why. */
function weaponSpecAdjust(specEntry, skillName, weaponName, weaponType, data) {
  const { live } = classifySpecTerms(specEntry, skillName, data);
  if (!live.length) return { delta: 0, term: "" };
  const hit = live.find(t => specTermMatchesWeapon(t, weaponName, weaponType));
  return hit ? { delta: 1, term: hit } : { delta: -1, term: live.join(", ") };
}

// Short forms used in gear/drone effect text -> canonical skill name.
const SKILL_ALIASES = {
  "Reconnaissance": ["Reconnaissance", "Recon"],
  "Computer: Hacking": ["Computer: Hacking", "Hacking"],
  "Computer: Programming": ["Computer: Programming", "Programming"],
};

/**
 * Bonus skill DICE granted by active + linked drones (play mode). A linked
 * drone contributes the numeric bonus it lists per skill, e.g. the Bug-Spy's
 * "+1 to Observation/Recon" becomes +1d to Observation and Reconnaissance.
 * Returns { skillName: dice }. Only drones currently feed this layer, so it
 * never double-counts the heritage/augment bonuses already folded into rank.
 */
function droneSkillDice(character, data) {
  const bonus = {};
  const rigging = ((character.play || {}).rigging || {});
  // A drone grants its rider because it's OUT THERE, not because of how it's
  // being flown: riding a VCR link, running Active and being hotseated all
  // count. (Active is the off-link flag — no rig, no link spent.) Counted once
  // however many of the three are ticked.
  //
  // Hotseat was missing here while droneCombatBonuses had it, so the same drone
  // could grant its Initiative dice and not its skill dice depending on which
  // boxes were ticked — the two functions have to agree on what "deployed"
  // means (#38).
  const deployed = {};
  for (const map of [rigging.linked || {}, rigging.active || {}, rigging.hotseat || {}]) {
    for (const [key, on] of Object.entries(map)) if (on) deployed[key] = true;
  }
  const drones = character.drones || [];
  const aliasesFor = skill => SKILL_ALIASES[skill] || [skill];
  const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const [key, on] of Object.entries(deployed)) {
    if (!on || !key.startsWith("drones:")) continue;
    const unit = drones[+key.split(":")[1]];
    if (!unit) continue;
    const effect = (findRow(data.drones, "Drone", unit.name) || {}).Effect || "";
    for (const clause of effect.split(/[,.;]/)) {
      const m = clause.match(/([+-]?\d+)\s*d?/);
      const n = m ? parseInt(m[1], 10) : 0;
      if (!n) continue;
      for (const skill of Object.keys(SKILLS)) {
        if (aliasesFor(skill).some(a => new RegExp(`\\b${escape(a)}\\b`, "i").test(clause))) {
          bonus[skill] = (bonus[skill] || 0) + n;
        }
      }
    }
  }
  return bonus;
}

/* What a deployed drone gives the character beyond skill dice (issue #38).
 *
 * droneSkillDice already turns "+1 to Observation/Recon" into real dice. The
 * rest of an Effect column is either another countable rider — "+2d Initiative"
 * — or prose no engine can apply ("Reroll 1s on dodge tests", "Provides mobile
 * High Cover"). Count the first, and hand back the second as notes tagged with
 * the drone that grants it, so the sheet can report them where they matter
 * instead of leaving them on the Rigging tab.
 *
 * Deployed is linked, Active OR the hotseat — a drone is out there or it isn't;
 * how it's being flown doesn't change what it does for you, and the one you're
 * personally piloting is the most deployed of all. */
function droneCombatBonuses(character, data) {
  const rigging = ((character.play || {}).rigging || {});
  const deployed = {};
  for (const map of [rigging.linked || {}, rigging.active || {}, rigging.hotseat || {}])
    for (const [key, on] of Object.entries(map)) if (on) deployed[key] = true;
  const out = { initiative_dice: 0, dodge_notes: [], cover_notes: [],
                cover_grants: [], vision_notes: [], other_notes: [] };
  for (const key of Object.keys(deployed)) {
    if (!key.startsWith("drones:")) continue;
    const unit = (character.drones || [])[+key.split(":")[1]];
    if (!unit) continue;
    const label = unit.label || unit.name;
    const row = findRow(data.drones, "Drone", unit.name) || {};
    const effect = row.Effect || "";
    for (const clause of effect.split(/[,.;]/)) {
      const c = clause.trim();
      if (!c) continue;
      const init = /([+-]?\d+)\s*d?\s*(?:to\s+)?Initiative/i.exec(c);
      if (init) { out.initiative_dice += toInt(init[1]); continue; }
      if (/dodge/i.test(c)) { out.dodge_notes.push({ text: c, source: label }); continue; }
      if (/cover/i.test(c)) {
        out.cover_notes.push({ text: c, source: label });
        // Cover the drone puts over the RIGGER feeds the same best-wins
        // resolution as a martial-art stance or a full-cover infusion, so a
        // Shield-Wall Drone's High cover finally counts as cover rather than
        // sitting in a note beside the real figure.
        //
        // "Carries 3 passengers under High cover" is deliberately excluded: that
        // is cover for whoever is riding in it, and the rigger is usually not.
        // Crediting it would hand a −2d to a character standing somewhere else
        // entirely.
        const grant = /passenger/i.test(c) ? null : parseCoverGrant(c);
        if (grant) out.cover_grants.push({ ...grant, source: label });
        continue;
      }
      // A sensor the drone is lending you — its feed is your feed while it's
      // out. Joins the character's own optics rather than sitting on the
      // Rigging tab, because it's the same question ("what can I see?").
      if (/vision/i.test(c)) {
        out.vision_notes.push({ text: c.replace(/^grants\s+/i, ""), source: label });
        continue;
      }
      // Anything else (a light radius, a flight ceiling, an Anthrodoid's own
      // Strength, the VSTOL Bird's stealth penalty) is deliberately NOT
      // collected here. None of it folds into one of the character's stats, and
      // the Drones on Station card already prints each deployed unit's full
      // Effect line — a second list of the same words would be the read-only
      // copy problem, not a fix for it.
    }
  }
  return out;
}

/* ---- casting ---------------------------------------------------------------
 * A cast spell is play state: which spells are up, at what Force, and what each
 * one is doing. Nothing here touches the chargen record — casting is the most
 * transient thing a character does.
 *
 * Drain is written in the data as an expression in Force ("3 + (Force/2)"),
 * which is prose the engine has never had to evaluate before. Rather than run
 * arbitrary text, the shapes actually present are matched: a flat number, a sum
 * with a Force term, and "Special" for the two that don't state one. Anything
 * unrecognised returns null and the sheet says so instead of inventing a value.
 */
const DRAIN_SPECIAL = "Special";
function spellDrain(drainText, force) {
  const raw = String(drainText || "").trim();
  if (!raw || /^special$/i.test(raw)) return null;
  const f = toInt(force);
  // "3 + (Force/2)" / "Force/2" / "2 + Force" / "4"
  const m = /^(?:(\d+)\s*\+\s*)?\(?\s*force\s*\/\s*(\d+)\s*\)?$/i.exec(raw);
  if (m) return toInt(m[1] || 0) + Math.floor(f / toInt(m[2]));
  const plusForce = /^(?:(\d+)\s*\+\s*)?\(?\s*force\s*\)?$/i.exec(raw);
  if (plusForce) return toInt(plusForce[1] || 0) + f;
  if (/^\d+$/.test(raw)) return toInt(raw);
  return null;
}

/* Drain lands as Lethal when the spell's Force is greater than the caster's
 * Zoetic Potential, and as Stun at or below it. The sheet already states this
 * rule above the spell list; this is the same test, in one place. */
function drainIsLethal(force, zp) {
  return toInt(force) > toInt(zp);
}

/* ---- drain soak (#68) ------------------------------------------------------
 * How Drain is soaked depends on what it lands as, and the two cases are not
 * symmetrical:
 *
 *   Stun-based drain      Channeling FIRST, then Brawn on what's left.
 *   Physical-based drain  Channeling ONLY. Brawn does not touch it.
 *
 * The order matters and is not a formatting detail: a caster who leads with
 * Brawn on Stun drain has spent the pool that was supposed to go second. So the
 * sheet states the sequence rather than just listing two skills, and the roll
 * buttons are offered in that order.
 *
 * "Physical-based" is the same test as `drainIsLethal` — Force above ZP — which
 * is why this takes the resolved `lethal` flag rather than re-deriving it: the
 * active-spell record already froze that decision at cast time, and re-testing
 * against a ZP that has since moved would silently rewrite what an already-cast
 * spell costs. */
const DRAIN_SOAK_STUN = ["Channeling", "Brawn"];
const DRAIN_SOAK_PHYSICAL = ["Channeling"];
function drainSoakOrder(lethal) {
  return lethal ? DRAIN_SOAK_PHYSICAL.slice() : DRAIN_SOAK_STUN.slice();
}

/* Fetishes that apply to a given spell.
 *
 * A Fetish is not a mechanism of its own in this data: it is a `misc_gear` row
 * named "Fetish N" whose Effect reads "Increase magic soak for a specific spell
 * or spirit by +N", and the *specific* half is carried by the owned entry's
 * `link` field — the same field a Focus and a Spirit Bag use, set by
 * gearLinkSelect in chargen. So "appropriate" is decidable from the data and
 * needs no guessing: link === the spell being soaked for. A Fetish linked to a
 * spirit, to a ritual, or to nothing at all is simply not appropriate here.
 *
 * The rating is read from the NAME rather than parsed out of the Effect prose,
 * because the name is the row's key — homebrew and renames both have to keep it
 * intact for the row to resolve at all, while the prose is free text.
 *
 * `carried !== false` is the same permissive test gear ZR and encumbrance use:
 * a Fetish left at home is owned but not in hand, and cannot help a roll.
 *
 * Several can be held at once, and they are NOT summed. A Fetish states a flat
 * "+N to soak this", so two linked to the same spell is the better of the two
 * applying, not a stacking pair — summing would let a caster buy Fetish 1 six
 * times for the price of one Fetish 6's benefit and change. The runner-up is
 * still returned in `all` so the sheet can say what else is on the hook.
 *
 * Returns { bonus, best, all } — bonus 0 and all [] when nothing applies. */
const FETISH_NAME_RE = /^Fetish\s+(\d+)$/i;
function fetishesForSpell(gearList, spellName) {
  const want = String(spellName || "").trim();
  const all = [];
  if (want) {
    for (const item of gearList || []) {
      if (!item || item.carried === false) continue;
      const m = FETISH_NAME_RE.exec(String(item.name || "").trim());
      if (!m) continue;
      if (String(item.link || "").trim() !== want) continue;
      all.push({ name: item.name, rating: toInt(m[1]) });
    }
  }
  all.sort((a, b) => b.rating - a.rating);
  return { bonus: all.length ? all[0].rating : 0, best: all[0] || null, all };
}

/* ---- animal spells ---------------------------------------------------------
 * Three spells reach into the animals table. Create Darkenbeast and Bound
 * Servant hand the caster ONE animal and change its numbers. Shapeshift is
 * different in two ways that the `forms` flag marks: the caster picks several
 * (Force of them), and the animal is the caster rather than a companion, so
 * nothing is added to it — you become the creature as written.
 *
 * Move and Flight are metres, like every distance in the app.
 */
const SUMMON_SPELLS = {
  "Shapeshift": {
    label: "Form",
    // Several picks, one of them worn at a time.
    forms: true,
    apply: animal => ({
      ballistic: toInt(asNumber(animal.Ballistic)),
      impact: toInt(asNumber(animal.Impact)),
      damage_bonus: 0,
      pool_bonus: 0,
      test_bonus: 0,
      notes: ["Shifting is a Complex action, and heals 1d6 boxes of BOTH tracks",
              "No speaking and no spellcasting while shifted"],
    }),
  },
  "Create Darkenbeast": {
    label: "Darkenbeast",
    // Force/2 armor (rounded down), +2 melee damage, +3 to each pool.
    apply: (animal, force) => {
      const armor = Math.floor(toInt(force) / 2);
      return {
        ballistic: toInt(asNumber(animal.Ballistic)) + armor,
        impact: toInt(asNumber(animal.Impact)) + armor,
        damage_bonus: 2,
        pool_bonus: 3,
        test_bonus: 0,
        // The armor and damage changes are already folded into the numbers
        // above, so these notes say where they came from rather than repeating
        // them as instructions. The pool bonus has its own line in the
        // read-out and is deliberately not repeated here.
        notes: [`Armor includes +${armor} from Force ${toInt(force)} ÷ 2`,
                "Melee damage above already includes the spell's +2",
                "Caster gets an Exploit action to control it; a Simple action to direct it"],
      };
    },
  },
  "Bound Servant": {
    label: "Familiar",
    // Flat +2d on everything it rolls; no armor or damage change.
    apply: (animal) => ({
      ballistic: toInt(asNumber(animal.Ballistic)),
      impact: toInt(asNumber(animal.Impact)),
      damage_bonus: 0,
      pool_bonus: 0,
      test_bonus: 2,
      notes: ["+2 dice on all its tests",
              "Caster gets an Exploit action to direct it, and +2d Sorcery/Channeling",
              "If it dies: caster takes 2d6 Stun, and a new familiar arrives at dawn"],
    }),
  },
};

function isSummonSpell(name) {
  return Object.prototype.hasOwnProperty.call(SUMMON_SPELLS, name);
}

/* Does this spell pick several animals rather than one? */
function isFormSpell(name) {
  return Boolean((SUMMON_SPELLS[name] || {}).forms);
}

/* The caster's chosen forms, and which one they are wearing.
 *
 * "A number of animals equal to the Force of the spell", chosen when learned —
 * so the allowance moves with Force, and raising it grants another form rather
 * than re-picking the set. Picks beyond the current allowance are kept rather
 * than discarded: Force can move down as well as up (a re-import, an undone
 * advance), and silently deleting a player's chosen forms because a number
 * changed would be the worst possible reading of "the limit is Force". They're
 * returned as `over` so the sheet can show them greyed and let the player
 * choose which to drop.
 *
 * `active` is the form currently worn — at most one, and only ever one that is
 * actually within the allowance. */
function shapeshiftState(character, force) {
  const store = ((character.play || {}).shapeshift) || {};
  const limit = Math.max(0, toInt(force));
  const picks = (store.picks || []).filter(Boolean);
  const allowed = picks.slice(0, limit);
  const over = picks.slice(limit);
  const active = allowed.includes(store.active) ? store.active : "";
  return { limit, picks, allowed, over, active, remaining: Math.max(0, limit - allowed.length) };
}

/* One summoned animal, resolved: the creature's own line plus what the spell
 * did to it. Returns null when the spell isn't a summon or no animal is chosen
 * yet, so callers can simply not render anything. */
function summonedAnimal(spellName, animalName, force, data) {
  const spec = SUMMON_SPELLS[spellName];
  if (!spec) return null;
  const animal = findRow(data.animals, "Animal", animalName);
  if (!animal) return null;
  const mod = spec.apply(animal, force);
  const attacks = String(animal.Attacks || "").split("|").map(a => a.trim()).filter(Boolean)
    .map(text => {
      // "+2 melee damage" moves the number rather than being tacked on as
      // prose, so the stat line reads as one figure to hit and one to do.
      if (!mod.damage_bonus) return text;
      return text.replace(/(Damage\s+)(\d+)/i,
        (_, lead, n) => `${lead}${toInt(n) + mod.damage_bonus}`);
    });
  return {
    spell: spellName,
    label: spec.label,
    name: animal.Animal,
    force: toInt(force),
    move: animal.Move, flight: animal.Flight,
    initiative: animal.Initiative,
    condition: animal.Condition,
    ballistic: mod.ballistic, impact: mod.impact,
    hardening: animal.Hardening,
    dodge: toInt(asNumber(animal.Dodge)) + mod.test_bonus,
    soak: toInt(asNumber(animal.Soak)) + mod.test_bonus,
    pool_bonus: mod.pool_bonus,
    test_bonus: mod.test_bonus,
    attacks,
    notes: [...mod.notes, ...(animal.Notes ? [animal.Notes] : [])],
  };
}

/* ---- enhanced senses -------------------------------------------------------
 * Everything a character can perceive that an unaugmented person can't, from
 * wherever it comes: a Bat's echolocation, cyber eyes, a dose of Gleam, a drone
 * lending you its thermal feed. Scattered across four tables and three tabs
 * until now, which meant "can I see in the dark?" was a question you answered
 * by remembering.
 *
 * Grouped by CAPABILITY rather than listed per source. Two things that grant
 * the same sense say so differently — the Thermographic augment's "Can see in
 * thermographic spectrum" and the Roto-Drone's "Grants Thermographic Vision" —
 * and one line naming both beats two lines saying the same thing twice.
 */

/* Each entry is one capability and the phrasings that grant it. The label is
 * what the sheet shows.
 *
 * Order matters: first match wins, so the specific capabilities come before the
 * catch-all darkness one. A clause is tested against "<source> <clause>", which
 * is how "Echolocation Positioning" is recognised from an effect line that
 * never uses the word.
 *
 * Deliberately narrow. Matching mere sense WORDS pulls in "Eyes like a fly, but
 * softball sized", "Changes color and shape of eyes", Cyclopean (a penalty), an
 * Eye Laser (a weapon) and Astral Senses (magic) — all mention eyes or senses,
 * none is an enhanced sense. Every pattern here describes PERCEIVING, which is
 * what keeps them out, and it picks homebrew up for free when it uses the
 * wording the core data already does. */
const SENSE_CAPABILITIES = [
  ["Thermographic vision", "\\bthermograph"],
  ["Infrared vision", "\\binfrared\\b"],
  ["Ultraviolet vision", "\\bultraviolet\\b"],
  ["Echolocation", "\\becholocat"],
  ["Vision magnification", "\\bvision mag|magnif\\w*\\s+vision"],
  ["Selective hearing", "sound filtering"],
  ["Sonic protection", "\\bsonic\\b"],
  ["Sees in darkness / low light",
    "ignore[^.]*\\b(?:low.?light|darkness|dark)\\b|treat darkness"
    + "|\\bsee better\\b[^.]*\\bdark|\\bcan see\\b[^.]*\\bdark"
    + "|\\bdetect[^.]*\\b(?:darkness|dark)\\b"],
  // Perceiving somewhere you aren't. Far Sight is the amp power that does this;
  // the phrasing rather than the name is matched so a homebrew power describing
  // the same trick lands in the same row.
  ["Remote viewing",
    "\\bfar ?sight\\b|observe within a city block|see and hear nearby"],
].map(([label, source]) => ({ label, re: new RegExp(source, "i") }));

/* A sense that has to be switched on.
 *
 * Most enhanced senses are simply true of the character — thermographic eyes see
 * heat whether you think about it or not. A few cost an action to engage, and
 * their bonus is only real once you've paid it: Far Sight needs a Trance
 * (Complex Action) before its +2d Reconnaissance means anything, so granting
 * that bonus unconditionally would be handing out dice for an action nobody
 * spent.
 *
 * The gate is read out of the Effect text — "Requires entering a Trance" —
 * rather than from a list of power names here, so a homebrew power written the
 * same way behaves the same way. The dice it grants are read from the same text
 * ("+2d Reconnaissance") for the same reason.
 *
 * Whether it's currently on lives in play state, so it survives a reload and
 * clears the way every other play toggle does. */
const TRANCE_GATED_RE = /requires entering a trance/i;
const SENSE_SKILL_DICE_RE = /([+-]\s*\d+)\s*d\s+([A-Za-z][A-Za-z /:'’-]*)/;
function activatableSenses(character, data) {
  const active = ((character.play || {}).active_senses) || {};
  const out = [];
  for (const name of (character.magic || {}).amp_powers || []) {
    const row = findRow(data.amp_powers, "Name", name);
    const effect = String((row || {}).Effect || "");
    if (!row || !TRANCE_GATED_RE.test(effect)) continue;
    const m = SENSE_SKILL_DICE_RE.exec(effect);
    // Resolve the skill through the same alias table the rest of the engine
    // uses, so "Recon" and "Reconnaissance" are one skill.
    const skill = m ? canonicalSkillName(m[2].trim()) : null;
    out.push({
      name,
      skill: skill || null,
      dice: (m && skill) ? toInt(m[1].replace(/\s+/g, "")) : 0,
      requires: "Trance (Complex Action)",
      active: Boolean(active[name]),
    });
  }
  return out;
}

function senseCapability(source, clause) {
  const probe = source + " " + clause;
  const hit = SENSE_CAPABILITIES.find(c => c.re.test(probe));
  return hit ? hit.label : null;
}

/* Split on sentence ends so one clause of a long Effect can qualify without
 * dragging the rest along — Augmented Eyesight's firearm range shift is a
 * combat note, not a sense. */
function senseClauses(text) {
  return String(text || "").split(/(?<=[.;])\s+/)
    .map(c => c.trim().replace(/^grants\s+/i, ""))
    .filter(Boolean);
}

/* [{ capability, sources: [{ name, from }] }], one row per distinct capability.
 * Gear counts only while carried and a drone only while deployed, because both
 * can be put down — this answers what the character can perceive right now. */
function deriveSenseNotes(character, data, heritage, augments, droneVision) {
  const byCapability = new Map();
  const add = (from, source, text) => {
    for (const clause of senseClauses(text)) {
      const capability = senseCapability(source, clause);
      if (!capability) continue;
      if (!byCapability.has(capability)) byCapability.set(capability, []);
      const sources = byCapability.get(capability);
      // One source grants a capability once, however many of its clauses say so.
      if (!sources.some(s => s.name === source && s.from === from)) {
        sources.push({ name: source, from });
      }
    }
  };
  for (const row of (heritage && heritage.traits) || []) add("Heritage", row.Name, row.Effects);
  for (const [row] of (augments && augments.rows) || []) add("Augment", row.Name, row.Effect);
  // Amp powers were never scanned, which is why Far Sight — a sense in every
  // sense of the word — appeared nowhere near the other senses (#42).
  for (const name of (character.magic || {}).amp_powers || []) {
    const row = findRow(data.amp_powers, "Name", name);
    if (row) add("Amp power", name, row.Effect);
  }
  for (const item of character.gear || []) {
    if (item.carried === false) continue;
    const row = findRow(data.misc_gear, "Item", item.name);
    if (row) add("Gear", item.name, row.Effect);
  }
  // Already filtered to deployed drones by droneCombatBonuses.
  for (const v of droneVision || []) add("Drone", v.source, v.text);
  return [...byCapability.entries()].map(([capability, sources]) => ({ capability, sources }));
}

function scoreKnowledgeSkills(character, finalIntelligence, finalCharisma,
                             knowledgePointsBonus, warnings, errors,
                             etiquetteAdjust) {
  const knowledgeBudget = KNOWLEDGE_POINTS_PER_INTELLIGENCE * finalIntelligence
                          + toInt(asNumber(knowledgePointsBonus));
  const knowledgeSpent = sumBy(character.knowledge_skills,
    entry => toInt(asNumber(entry.points)));
  if (knowledgeSpent > knowledgeBudget) {
    errors.push("Knowledge skill points overspent.");
  }
  for (const entry of character.knowledge_skills) {
    if (toInt(asNumber(entry.points)) > KNOWLEDGE_ETIQUETTE_RANK_CAP) {
      errors.push(`Knowledge ${entry.name || "(unnamed)"}: `
                  + `maximum ${KNOWLEDGE_ETIQUETTE_RANK_CAP} points.`);
    }
  }

  const etiquetteValues = {};
  for (const [name, points] of Object.entries(character.etiquettes || {})) {
    if (ETIQUETTES.includes(name)) etiquetteValues[name] = Math.max(0, toInt(asNumber(points)));
  }
  const etiquetteBudget = ETIQUETTE_POINTS_PER_CHARISMA * finalCharisma;
  const etiquetteSpent = sumBy(Object.values(etiquetteValues), v => v);
  if (etiquetteSpent > etiquetteBudget) {
    errors.push("Etiquette points overspent.");
  }
  for (const [name, points] of Object.entries(etiquetteValues)) {
    if (points > KNOWLEDGE_ETIQUETTE_RANK_CAP) {
      errors.push(`Etiquette ${name}: maximum ${KNOWLEDGE_ETIQUETTE_RANK_CAP} points.`);
    }
  }

  // Gear modifiers sit OUTSIDE the budget and the per-entry cap: both govern
  // points you bought with Charisma, and a bonus you're wearing is neither
  // bought nor spent. So `final` can exceed the rank cap of 6, exactly as an
  // augment can push an attribute past what chargen would sell you.
  const adjust = {};
  const finalValues = {};
  for (const name of ETIQUETTES) {
    const bonus = toInt((etiquetteAdjust || {})[name]);
    const base = etiquetteValues[name] || 0;
    if (bonus) adjust[name] = bonus;
    // Carry an etiquette you never bought but are currently getting a bonus to:
    // rolling it at all is the whole point of the bonus.
    if (base || bonus) finalValues[name] = base + bonus;
  }

  return {
    knowledge: { budget: knowledgeBudget, spent: knowledgeSpent,
                 remaining: knowledgeBudget - knowledgeSpent },
    etiquettes: { values: etiquetteValues, adjust, final: finalValues,
                  budget: etiquetteBudget,
                  spent: etiquetteSpent,
                  remaining: etiquetteBudget - etiquetteSpent },
  };
}

// ============================================================== step 7: magic budgets
function budgetMagic(character, data, magicType, warnings, errors) {
  const startForce = STARTING_FORCE_BY_MAGIC_TYPE[magicType] || 0;
  let forceSpent = sumBy(character.magic.spells || [],
    spell => Math.max(0, toInt(asNumber(spell.force))));
  for (const spell of character.magic.spells || []) {
    if (toInt(asNumber(spell.force)) > SPELL_FORCE_MAX) {
      errors.push(`Spell ${spell.name || "(unnamed)"}: `
                  + `maximum Force is ${SPELL_FORCE_MAX}.`);
    }
  }
  if (magicType === "Archmage" && character.magic.archmage_bind) {
    forceSpent += ARCHMAGE_SPIRIT_BIND_FORCE_COST;
  }

  if (magicType === "Mage") {
    const school = character.magic.school;
    // A Mage's school is what bounds their spell list, so leaving it unset was
    // a way to take spells from every school at once. It's required.
    if (!school) errors.push("Mage: choose one School of magic.");
    for (const spell of character.magic.spells || []) {
      const row = findRow(data.spells, "Name", spell.name);
      if (row && school && row.School !== school) {
        errors.push(`Spell ${spell.name} is outside your school (${school}).`);
      }
    }
  }
  if (magicType !== "Mage" && magicType !== "Archmage" && (character.magic.spells || []).length) {
    warnings.push("Spells require Mage or Archmage magic type.");
  }

  let infusionSpent = 0, relationshipSpent = 0, bondSpent = 0;
  if (magicType === "Speaker" || magicType === "Archmage") {
    /* These budgets are what Magic priority bought at CREATION, so anything
     * added later with Kismet is excluded — otherwise the tab reads overspent
     * for a character that has done nothing wrong. applyPlayAdvances appends
     * play purchases, so dropping them off the end leaves the chargen share. */
    const kismet = character.kismet_speaker || { bonds: 0, infusions: 0, relationships: 0 };
    const chargenOnly = (list, bought) =>
      (list || []).slice(0, Math.max(0, (list || []).length - toInt(bought)));

    for (const name of chargenOnly(character.speaker.infusions, kismet.infusions)) {
      const row = findRow(data.speaker_infusions, "Infusions", name);
      infusionSpent += row ? toInt(asNumber(row.Cost)) : 0;
    }
    for (const name of chargenOnly(character.speaker.relationships, kismet.relationships)) {
      const row = findRow(data.speaker_spirits, "Spirit", name);
      relationshipSpent += row ? toInt(asNumber(row.Cost)) : 0;
    }
    const bondCostByIndex = {};
    for (const row of data.speaker_bond_costs) {
      bondCostByIndex[toInt(Number(row.Bond))] = toInt(asNumber(row.Cost));
    }
    // Kismet buys the TOP rungs of the ladder, so the chargen share is the
    // bottom ones — a character who bought 1 at creation and 2 in play spent
    // creation points on rung 1 alone.
    const bondCount = speakerBondCount(character) - toInt(kismet.bonds);
    for (let i = 1; i <= bondCount; i++) bondSpent += bondCostByIndex[i] || 0;
  }

  if (magicType === "Archmage") {
    forceSpent += infusionSpent + relationshipSpent + bondSpent;
  }
  const forceRemaining = startForce - forceSpent;
  if ((magicType === "Mage" || magicType === "Archmage") && forceRemaining < 0) {
    errors.push(`Starting Force overspent by ${-forceRemaining}.`);
  }

  const infusionBudget = magicType === "Speaker" ? SPEAKER_INFUSION_POINTS : 0;
  const relationshipBudget = magicType === "Speaker" ? SPEAKER_RELATIONSHIP_POINTS : 0;
  const infusionRemaining = infusionBudget - infusionSpent;
  const relationshipRemaining = relationshipBudget - relationshipSpent - bondSpent;
  if (magicType === "Speaker") {
    if (infusionRemaining < 0) errors.push("Infusion points overspent.");
    if (relationshipRemaining < 0) errors.push("Relationship points overspent.");
  }

  return {
    start_force: startForce,
    force_spent: forceSpent,
    force_remaining: forceRemaining,
    infusion_pts: { budget: infusionBudget, spent: infusionSpent,
                    remaining: infusionRemaining },
    relationship_pts: { budget: relationshipBudget,
                        spent: relationshipSpent + bondSpent,
                        remaining: relationshipRemaining },
  };
}

// ============================================================== step 8: gear pricing
/**
 * Assign fitted mod names to a weapon's three slots (Overbarrel / Underbarrel /
 * Chassis), one mod per slot. Single-slot mods claim their slot first; dual-slot
 * mods (e.g. Laser Sight, which fits either barrel slot) then take whichever of
 * their candidate slots is still free. Mods not in the table are ignored.
 * Returns { assigned: {slot: modName}, overflow: [modName] } where overflow is
 * every mod left without a free slot.
 */
/* Mods built into a weapon at the factory. Two things follow from "integrated",
 * and the second is the one that's easy to miss: the mod is fitted free, AND it
 * does not consume its slot — a Ninja's suppressor is inside the barrel, so the
 * underbarrel rail is still empty. That's what lets an integrated weapon take
 * one more mod of the same kind than a bare one could.
 *
 * Comma-separated in the data ("Integrated Mods"), so a weapon can carry more
 * than one. Names must match the weapon_mods table; an unknown one is dropped
 * rather than half-applied. */
function weaponIntegratedMods(row, modsTable) {
  const names = String((row && row["Integrated Mods"]) || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  if (!names.length) return [];
  const table = modsTable || [];
  return names.filter(n => table.some(m => m.Modification === n));
}

/* A sealed, single-load weapon: the magazine is the weapon. Fires normally and
 * then it's spent, so the sheet offers no Reload. */
function weaponIsOneshot(row) {
  return String((row && row.Oneshot) || "").trim() === "1";
}
const ONESHOT_NOTE = "Polymer Oneshot, cannot be reloaded";

/* How many hands a weapon needs to wield. Blank/missing is 1H, the safe
 * default -- an unlabelled homebrew weapon stays wieldable rather than
 * becoming unassignable the moment this column exists. */
function weaponHands(row) {
  return String((row && row.Hands) || "").trim().toUpperCase() === "2H" ? 2 : 1;
}

function assignWeaponModSlots(modNames, modsTable) {
  const order = ["Overbarrel", "Underbarrel", "Chassis"];
  const slotsByMod = {};
  for (const m of modsTable) (slotsByMod[m.Modification] ??= new Set()).add(m.Slot);
  const entries = (modNames || [])
    .map(name => ({ name, candidates: order.filter(s => (slotsByMod[name] || new Set()).has(s)) }))
    .filter(e => e.candidates.length > 0);
  const assigned = {}, overflow = [];
  for (const flexible of [false, true]) {
    for (const e of entries) {
      if ((e.candidates.length > 1) !== flexible) continue;
      const slot = e.candidates.find(s => !assigned[s]);
      if (slot) assigned[slot] = e.name;
      else overflow.push(e.name);
    }
  }
  return { assigned, overflow };
}

/* ---- bows --------------------------------------------------------------------
 * A crossbow is a fixed weapon like any other. A bow isn't: it's built to a
 * draw weight, and the Strength needed to draw it decides everything about it.
 * That number is chosen when the bow is bought and lives on the character's
 * entry as `min_str`, the way `smart` and `quality` do — it belongs to the item
 * the character owns, not to the character. A Strength 18 archer with a
 * minimum-4 bow still only gets what a minimum-4 bow does.
 *
 * Two data columns mark a row as STR-rated, both blank on everything else:
 *   StrCost — price per point of Minimum Strength
 *   StrDmg  — added to Minimum Strength for damage
 * Rarity is Minimum Strength ÷ 2, rounded down, for every bow.
 *
 * Returns null for anything that isn't STR-rated, so callers can use it as the
 * "is this a bow" test as well.
 */
const BOW_MIN_STR_FLOOR = 1;
function bowRating(row, entry) {
  const perPoint = asNumber((row || {}).StrCost);
  if (!(perPoint > 0)) return null;
  const minStr = Math.max(BOW_MIN_STR_FLOOR,
    Math.min(ATTRIBUTE_LEVEL_MAX, toInt(asNumber((entry || {}).min_str, BOW_MIN_STR_FLOOR))));
  return {
    minStr,
    cost: perPoint * minStr,
    damage: minStr + toInt(asNumber(row.StrDmg)),
    rarity: Math.floor(minStr / 2),
  };
}

/* What the gun itself is worth — the number a percentage-priced mod takes its
 * share of. A bow has no price of its own: it's rated by the Strength needed to
 * draw it, and bowRating turns that into the cost. */
function weaponBaseCost(row, entry) {
  const bow = bowRating(row, entry || {});
  return bow ? bow.cost : asNumber((row || {}).Cost);
}

/* A weapon mod's price. Most are a flat figure, but a mod whose Cost cell ends
 * in "%" is priced as a share of the gun it's bolted to (Bling is 25%) — a
 * showpiece finish costs what the piece underneath is worth. The share rounds
 * DOWN to whole woolongs: nobody bills a runner for three quarters of one, and
 * flooring keeps the break in the customer's favour. Anything else falls
 * through to asNumber, so a blank or junk cell reads as free. */
function weaponModCost(modRow, weaponBaseCostValue) {
  const raw = String((modRow || {}).Cost ?? "").trim();
  const pct = /^(-?\d+(?:\.\d+)?)\s*%$/.exec(raw);
  if (!pct) return asNumber(raw);
  return Math.floor(asNumber(weaponBaseCostValue) * (Number(pct[1]) / 100));
}

/* The "25%" from such a cell, or null for a flat price — for UI that wants to
 * say WHY one gun's Bling costs more than another's. */
function weaponModCostPercent(modRow) {
  const pct = /^(-?\d+(?:\.\d+)?)\s*%$/.exec(String((modRow || {}).Cost ?? "").trim());
  return pct ? Number(pct[1]) : null;
}

function priceWeapons(character, data, gearCostMultiplier, warnings, strength, errors,
                      activeAugmentNames, playWarnings) {
  const priced = [];
  let totalCost = 0.0, totalWeight = 0.0;
  // Smartlink grants +1 Accuracy die to any smart-capable gun. It comes three
  // ways, and only the third is conditional: implanted on its own (Eyeware with
  // no Cybertechtronic Eye) or as part of an eyeware suite inside a
  // Cybertechtronic Eye, it is always live; mounted on a Helmet or Arwin
  // Goggles it is live only while that host is worn. `activeAugmentNames` is
  // built from the merged augment rows, which already drop mounted augments
  // whose host isn't equipped, so all three fall out of one lookup.
  const hasSmartlink = (activeAugmentNames || new Set()).has("Smartlink");
  for (const entry of character.weapons) {
    const row = findRow(data.weapons, "Weapon", entry.name);
    if (!row) continue;
    // Thrown weapons stack (buy several of the same); everything else is one.
    const qty = row.Type === "Thrown" ? Math.max(1, toInt(asNumber(entry.qty, 1))) : 1;
    // A bow is rated by the Strength needed to draw it, chosen when it's bought
    // and kept on the entry. That one number sets its damage, its price and how
    // hard it is to find, so the data row carries none of the three.
    const bow = bowRating(row, entry);
    const baseCost = bow ? bow.cost : asNumber(row.Cost);
    // Integrated-smart weapons (data column "Integrated Smart") are always
    // smart at no extra cost; only opt-in smart pays the multiplier.
    const integratedSmart = Boolean(row["Integrated Smart"]);
    let cost = baseCost
      * (entry.smart && !integratedSmart ? SMART_WEAPON_COST_MULTIPLIER : 1);

    const fittedMods = [];
    let accMod = 0;
    let concealMod = 0;
    // Gyro-mount, Bi-pod and Gas Vent each carry RecoilMod. The column has been
    // in the data (and in the homebrew editor) all along with nothing reading
    // it, so a player could fit a bipod and watch it do nothing.
    let recoilMod = 0;
    // Built in at the factory: same stat effects as a bolted-on one, no cost,
    // and no slot consumed. Applied first so a duplicate the player chose is
    // recognisable below.
    const integratedNames = weaponIntegratedMods(row, data.weapon_mods);
    const integratedMods = [];
    for (const modName of integratedNames) {
      const modRow = findRow(data.weapon_mods, "Modification", modName);
      // A built-in mod skips its ACCURACY PENALTY. The −2d on a silencer is the
      // cost of hanging a can off the muzzle of a gun not built for one; a
      // weapon designed around its suppressor doesn't pay it. The data says so
      // itself — the Militech Whisper 1000's upgrade is "Integrated silencer
      // mount (eliminates the -2d penalty for silencer)". Bonuses still apply:
      // an integrated laser sight is still worth its +1.
      const acc = asNumber(modRow.AccMod);
      if (acc > 0) accMod += acc;
      concealMod += asNumber(modRow["Conceal Mod"]);
      recoilMod += asNumber(modRow.RecoilMod);
      integratedMods.push({ name: modName, slot: modRow.Slot,
                            effect: modRow.Effect, integrated: true,
                            penalty_waived: acc < 0 ? acc : 0 });
    }
    for (const modName of entry.mods || []) {
      const modRow = findRow(data.weapon_mods, "Modification", modName);
      if (modRow) {
        // Percentage-priced mods take their share of the gun's own price, not of
        // the running total — fitting two of them can't compound.
        cost += weaponModCost(modRow, baseCost);
        accMod += asNumber(modRow.AccMod);
        // Concealability: bolting things to a gun makes it harder to hide, and
        // the mods' numbers add straight onto the weapon's own Conceal rating.
        concealMod += asNumber(modRow["Conceal Mod"]);
        recoilMod += asNumber(modRow.RecoilMod);
        fittedMods.push({ name: modName, slot: modRow.Slot, effect: modRow.Effect });
      }
    }
    // The same mod can't be fitted twice (e.g. two Laser Sights) — including
    // fitting one the weapon already has built in, which is the easy mistake
    // now that some weapons arrive with mods already on them.
    const seenMods = new Set(integratedNames);
    for (const mod of fittedMods) {
      if (seenMods.has(mod.name)) {
        warnings.push(integratedNames.includes(mod.name)
          ? `${entry.name}: ${mod.name} is already built into this weapon — `
            + "the fitted one is charged for and its effect counted twice."
          : `${entry.name}: ${mod.name} fitted more than once.`);
      }
      seenMods.add(mod.name);
    }
    // One mod per slot (Overbarrel / Underbarrel / Chassis). Dual-slot mods
    // land in whichever of their slots is free; any mod left without a free
    // slot is flagged.
    // Slots are physical, so overflow binds (JC-003).
    // Integrated mods are deliberately absent from this: they take no slot, so
    // the rail they'd occupy is still free for one of the player's own.
    const { overflow } = assignWeaponModSlots(fittedMods.map(m => m.name), data.weapon_mods);
    for (const name of overflow) {
      errors.push(`${entry.name}: no free slot for ${name} — one Overbarrel, `
        + "one Underbarrel, and one Chassis mod per weapon.");
    }

    cost = round2(cost * gearCostMultiplier * qty);
    totalCost += cost;
    totalWeight += asNumber(row.Weight) * qty;
    const item = {};
    for (const col of ["Type", "Weapon", "Accuracy", "Reach", "Damage", "Firing modes",
                       "Ammo", "Pen", "Bar", "Conceal", "Weight", "Hardening", "Notes"]) {
      item[col] = row[col] !== undefined ? row[col] : "";
    }
    if (row.Type === "Melee" && meleeDamageIsComputable(row.Damage))
      item.Damage = meleeDamage(row, strength);
    if (bow) {
      item.Damage = String(bow.damage);
      item.Rarity = String(bow.rarity);
      item.min_str = bow.minStr;
      // Drawing a bow you're not strong enough for isn't a creation mistake —
      // Strength moves in play — so it warns rather than blocking, and the
      // warning is play-relevant (JC-012): it describes what you're carrying.
      if (strength < bow.minStr) {
        const message = `${entry.name}: needs Strength ${bow.minStr} to draw — `
          + `this character has ${strength}.`;
        warnings.push(message);
        if (playWarnings) playWarnings.push(message);
      }
    }
    item.smart = Boolean(entry.smart) || integratedSmart;
    // Accuracy: base + fitted-mod AccMod (Laser Sight / Red dot +1, Silencer −2)
    // + Smartlink (+1 on smart guns). Melee weapons carry no Accuracy value.
    if (item.Accuracy !== "" && item.Accuracy != null) {
      let acc = toInt(asNumber(item.Accuracy)) + toInt(accMod);
      if (item.smart && hasSmartlink) { acc += 1; item.smartlink = true; }
      item.Accuracy = String(acc);
    }
    // Conceal: base + every fitted mod's Concealability. A weapon whose data row
    // states no Conceal at all (the underbarrel grenade launcher) has no rating
    // to add to, so it stays blank rather than becoming a bare mod total.
    if (concealMod && item.Conceal !== "" && item.Conceal != null) {
      item.Conceal = String(toInt(asNumber(item.Conceal)) + toInt(concealMod));
      item.conceal_mod = concealMod;
    }
    // Just the mods' contribution. The character's own capacity is added in
    // calculate(), which is also where Gun-Kata's "Ignore Recoil" is resolved —
    // pricing a gun shouldn't need to know what martial art its owner studies.
    item.recoil_mod = toInt(recoilMod);
    item.qty = qty;
    item.mods = fittedMods;
    item.integrated_mods = integratedMods;
    // An integrated Extended Magazine would enlarge the magazine too, so both
    // lists feed this.
    item.Ammo = applyExtendedMagazine(item.Ammo, [...integratedMods, ...fittedMods]);
    // Sealed single-load weapons say so on the stat line and offer no Reload.
    if (weaponIsOneshot(row)) { item.oneshot = true; item.oneshot_note = ONESHOT_NOTE; }
    item.cost = cost;
    item.equipped = entry.equipped !== false;
    priced.push(item);
  }
  return { items: priced, cost: totalCost, weight: totalWeight };
}

/**
 * Melee weapon damage: table Damage is a base value; a share of the wielder's
 * Strength (rounded down) is added — half by default, or the weapon's
 * "STR Mult" (e.g. Power Fist uses 1 for full Strength) — then any
 * "Damage Bonus" notation (e.g. Plasma weapons' "+2d6") is appended as-is.
 */
function meleeDamage(row, strength) {
  const mult = row["STR Mult"] !== undefined && row["STR Mult"] !== ""
    ? asNumber(row["STR Mult"]) : 0.5;
  const raw = String(row.Damage || "");
  // "½ Str-1" (Shuriken) states the Strength share and then a flat adjustment.
  // asNumber sees no leading digit and returns 0, which silently swallowed the
  // adjustment and made a Shuriken hit as hard as a Knife.
  const m = /str\s*([+-]\s*\d+)/i.exec(raw);
  const adj = m ? toInt(m[1].replace(/\s+/g, "")) : 0;
  // Read the base off the front of the string rather than through asNumber,
  // which gives up on "6 Stun" and returned 0 -- a Stun Baton was losing its
  // own 6 and reporting half Strength alone. "½ Str" has no leading digit, and
  // correctly contributes no base.
  const lead = /^\s*(-?\d+)/.exec(raw);
  const total = Math.max(0, (lead ? parseInt(lead[1], 10) : 0)
    + Math.floor(strength * mult) + adj);
  // A qualifier after the number is part of the damage, not decoration: a Stun
  // Baton's "6 Stun" must stay stun damage once Strength is folded in. Take the
  // remainder by slicing past what `lead` matched -- a second regex would let
  // \d+ backtrack and read "12" as 1 followed by a "2" qualifier. "Str" is not
  // a qualifier to keep; it's the notation being resolved.
  const rest = lead ? raw.slice(lead[0].length).trim() : "";
  const suffix = (!isStrengthDamage(raw) && rest) ? " " + rest : "";
  return String(total) + suffix + (row["Damage Bonus"] || "");
}

/** True when a Damage column defers to Strength ("½ Str", "½ Str-1") and so
 *  needs meleeDamage() to become a number. */
function isStrengthDamage(value) {
  return /str/i.test(String(value || ""));
}

/** Whether meleeDamage can resolve this Damage column at all. A value that is
 *  neither a number nor Strength-based describes damage some other way --
 *  the Sickstick's "Tgt Brawn Test (4)" tests the TARGET's Brawn, and replacing
 *  it with a computed number would state something the rules never said. */
function meleeDamageIsComputable(value) {
  const s = String(value == null ? "" : value).trim();
  return s !== "" && (/^-?\d/.test(s) || isStrengthDamage(s));
}

/**
 * Extended Magazine mod: base ammo + 2 + 20% of base (the percentage part is at
 * least 1). Non-numeric ammo (melee, blank) is returned unchanged. `mods` is the
 * list of fitted-mod objects ({name,...}) or plain mod-name strings.
 */
function applyExtendedMagazine(ammo, mods) {
  const hasExtMag = (mods || []).some(m =>
    (typeof m === "string" ? m : m && m.name) === "Extended Magazine");
  if (!hasExtMag) return ammo;
  const base = toInt(asNumber(ammo, NaN));
  if (!Number.isFinite(base) || String(ammo).trim() === "") return ammo;
  return base + 2 + Math.max(1, Math.floor(base * 0.2));
}

function priceArmor(character, data, gearCostMultiplier, warnings) {
  const styleMultiplier = {}, materialMultiplier = {}, extraMultiplier = {};
  // Quality/Style also carry gameplay effects (Charisma tests, Etiquette
  // bonuses) that the Gear and Overview tabs display alongside the piece.
  const styleEffect = {}, materialEffect = {}, extraEffect = {};
  for (const row of data.armor_styles) {
    styleMultiplier[row.Style] = asNumber(row.Multiplier, 1);
    styleEffect[row.Style] = row["Etiquette Bonus"] || "";
  }
  for (const row of data.armor_materials) {
    materialMultiplier[row.Material] = asNumber(row.Multiplier, 1);
    materialEffect[row.Material] = row.Effect || "";
  }
  for (const row of data.armor_extras) {
    extraMultiplier[row.Extra] = asNumber(row.Multiplier, 1);
    extraEffect[row.Extra] = row.Effects || "";
  }

  const priced = [];
  let totalCost = 0.0, totalWeight = 0.0;
  let totalBallistic = 0, totalImpact = 0, maxBallistic = 0;
  const activePiecesBySlot = {};

  for (const entry of character.armor) {
    const row = findRow(data.armor, "Armor", entry.name);
    if (!row) continue;
    let cost = asNumber(row.Cost);
    // Each multiplier applies to the BASE cost: its surcharge is base ×
    // (mult − 1), and surcharges add — they never compound on the running
    // total. (Matches the play-mode extras pricing in sheet.js.)
    // Quality (the armor_materials scale) applies to EVERY armor piece; Style
    // and Extras are cosmetic and only apply to styleable pieces (Style = Y).
    const base = cost;
    const surcharge = mult => base * ((mult !== undefined ? mult : 1) - 1);
    cost += surcharge(materialMultiplier[entry.material]);
    if (row.Style === "Y") {
      cost += surcharge(styleMultiplier[entry.style]);
      for (const extraName of entry.extras || []) {
        cost += surcharge(extraMultiplier[extraName]);
      }
    }
    cost = round2(cost * gearCostMultiplier);

    totalCost += cost;
    totalWeight += asNumber(row.wt);
    const isActive = entry.active === undefined ? true : Boolean(entry.active);
    if (isActive) {
      const slot = row.Slot || "";
      if (slot === "Outer" || slot === "Under") {
        activePiecesBySlot[slot] = (activePiecesBySlot[slot] || 0) + 1;
      }
      const pieceBallistic = toInt(asNumber(row.Ballistic));
      totalBallistic += pieceBallistic;
      if (pieceBallistic > maxBallistic) maxBallistic = pieceBallistic;
      totalImpact += toInt(asNumber(row.Impact));
    }

    const item = {};
    for (const col of ["Armor", "Ballistic", "Impact", "wt", "Slot"]) {
      item[col] = row[col] !== undefined ? row[col] : "";
    }
    // Style/Extras only exist on styleable pieces, so blank them out on the
    // rest -- a stale value from an earlier edit must not show as applied.
    const styleable = row.Style === "Y";
    item.styleable = styleable;
    item.style = styleable ? (entry.style || "") : "";
    item.material = entry.material || "";
    item.extras = styleable ? (entry.extras || []) : [];
    // Gameplay effects of the chosen Quality / Style / Extras, labelled for
    // display. "No Bonus" and blanks are dropped -- nothing to report.
    const effects = [];
    const addEffect = (label, text) => {
      const t = (text || "").trim();
      if (t && !/^no bonus$/i.test(t)) effects.push({ label, text: t });
    };
    addEffect(item.material, materialEffect[item.material]);
    addEffect(item.style, styleEffect[item.style]);
    for (const extraName of item.extras) addEffect(extraName, extraEffect[extraName]);
    item.effects = effects;
    item.active = isActive;
    item.cost = cost;
    priced.push(item);
  }

  for (const [slot, count] of Object.entries(activePiecesBySlot)) {
    if (count > 1) warnings.push(`More than one ${slot} armor piece is active.`);
  }

  return { items: priced, cost: totalCost, weight: totalWeight,
           ballistic_armor: totalBallistic, impact_armor: totalImpact,
           ballistic_armor_max: maxBallistic };
}

/* Gear limits split two ways (JC-003). A limit that counts physical slots or
 * mount points is BINDING and pushes an error: there is nowhere to put the
 * thing. A limit derived from a formula or describing degraded performance
 * (cargo left over, Body ÷ 3 weapons, drone loaded weight) stays advisory and
 * pushes a warning for the GM to adjudicate. */
/* `playErrors` / `playWarnings`, when given, collect the checks that stay true
 * after Finalize. Every complaint this function makes is one of them, which is
 * why there is no filtering here: none of them are budget rules. They describe
 * a deck that does not work — nothing slotted, a program you don't own, more
 * mods than the chassis holds, two mods fighting over the same stat, hardware
 * left at home. A creation budget stops applying at Finalize; "this deck will
 * not run" does not, and play is exactly when you'd try to run it.
 *
 * The slotted program in particular is a live dropdown on the Decking tab, so
 * this state is reachable DURING play and not only inherited from chargen. */
function priceDecking(character, data, gearCostMultiplier, warnings, errors,
                      playWarnings, playErrors) {
  const bothErr = message => {
    errors.push(message);
    if (playErrors) playErrors.push(message);
  };
  const bothWarn = message => {
    warnings.push(message);
    if (playWarnings) playWarnings.push(message);
  };
  // A deck runs on a Hacking program slotted into it — its operating system,
  // not a tool loaded on top, so it costs no thread and no I/O. The program is
  // owned like any other and named by `deck.hacking`, which lets a character
  // with Hacking 2 and Hacking 4 put the right one in the right deck. No
  // program slotted means the deck does not run at all (an error); one rated
  // under ½ MCP runs badly (a warning), the same split JC-003 draws everywhere.
  const owned = new Set(character.programs || []);
  let deckCost = 0.0;
  for (const entry of character.decks) {
    const row = findRow(data.decks, "Name", entry.name);
    if (!row) continue;
    let cost = asNumber(row.Cost);
    const slotCapacity = toInt(asNumber(row.Mods));
    let slotsUsed = 0;
    for (const modName of entry.mods || []) {
      const modRow = findRow(data.deck_mods, "Deck Mod", modName);
      if (modRow) {
        cost += asNumber(modRow.Cost);
        slotsUsed += toInt(asNumber(modRow.Slots, 1));
      }
    }
    // Only the equipped deck runs, so only it needs a working Hacking program.
    // The rest are stock you own; complaining about all of them would drown the
    // real problem, and changing which is equipped moves the check with it.
    if (entry.name === equippedDeckName(character)) {
      const requiredHacking = deckHackingRequired(row);
      const slotted = entry.hacking || "";
      if (!slotted) {
        bothErr(`${entry.name}: no Hacking program slotted — the deck will not `
                + `run. It needs one rated ${requiredHacking} or better.`);
      } else if (!owned.has(slotted)) {
        bothErr(`${entry.name}: the slotted ${slotted} isn't owned — `
                + "buy it or slot a Hacking program you have.");
      } else if (hackingProgramRating(slotted) < requiredHacking) {
        bothWarn(`${entry.name}: ${slotted} is under ½ MCP — needs rating `
                 + `${requiredHacking} for MCP ${row.MCP}.`);
      }
      if (entry.carried === false) {
        bothWarn(`${entry.name} is the equipped deck but isn't carried — `
                 + "you can't run a deck you left at home.");
      }
    }
    if (slotsUsed > slotCapacity) {
      bothErr(`${entry.name}: deck mod slots exceeded `
              + `(${slotsUsed}/${slotCapacity}).`);
    }
    // Range mods set the range rather than adding to it, so a second one has
    // nothing to do but overwrite the first — the slots it costs are wasted.
    const clash = deckRangeConflict(entry, data);
    if (clash) {
      bothErr(`${entry.name}: ${clash.join(" and ")} both set the hacking `
              + "range — fit only one.");
    }
    deckCost += round2(cost * gearCostMultiplier);
  }

  // Hacking programs are ordinary programs now, so they are priced with the
  // rest — no separate per-level line.
  const programCost = round2(sumBy(character.programs, name =>
    asNumber((findRow(data.programs, "Name", name) || {}).Cost)) * gearCostMultiplier);

  return { cost: deckCost + programCost };
}

/**
 * Effective VCR stats after fitted rig mods are applied. Bonus Link raises Links,
 * Input Validation / Military Grade Hardening raise Hardening, etc. Returns base
 * values (from the rig row) plus mod contributions, and mod-slot usage.
 */
function rigStats(rigEntry, data) {
  const row = findRow(data.rigs, "Rig Type", rigEntry.name) || {};
  let links = toInt(asNumber(row.Links));
  let hardening = toInt(asNumber(row.Hardening));   // stored like "+0"/"+1"; asNumber parses the sign
  let bonusDice = toInt(asNumber(row["Bonus Dice"]));
  const modSlots = toInt(asNumber(row.Mods));
  let modSlotsUsed = 0;
  let unitHardening = 0;
  for (const modName of rigEntry.mods || []) {
    const modRow = findRow(data.rig_mods, "Rig Mod", modName);
    if (!modRow) continue;
    modSlotsUsed += Math.max(1, toInt(asNumber(modRow.Slots, 1)));
    links += toInt(asNumber(modRow.Link));
    bonusDice += toInt(asNumber(modRow["Bonus Dice"]));
    // A rig mod's Hardening protects BOTH ends of the link: the rig itself and
    // every drone or vehicle flying on it. An earlier pass moved it off the rig
    // entirely on the reasoning that "+1 Vehicle/Drone Hardening" named the
    // units — but the rig is a networked device that gets attacked too, and the
    // mod hardens the whole rig-and-units system (#44). Counted in both places
    // on purpose; these are two different things being shot at, not one number
    // double-counted.
    const modHard = String(modRow.Hardening || "").trim() !== ""
      ? toInt(asNumber(modRow.Hardening))
      : hardeningBonusFromText(modRow.Effect);
    hardening += modHard;
    unitHardening += modHard;
  }
  return { row, links, hardening, unit_hardening: unitHardening, bonusDice,
           cores: row.Cores || "", modSlots, modSlotsUsed };
}

/* Same reasoning as priceDecking: a rig carrying more mods than it has slots is
 * a physically impossible piece of hardware, not an overspend, so it stays wrong
 * after Finalize. */
function priceRig(character, data, gearCostMultiplier, warnings, errors,
                  playWarnings, playErrors) {
  let totalCost = 0.0;
  for (const entry of character.rigs) {
    const row = findRow(data.rigs, "Rig Type", entry.name);
    if (!row) continue;
    let cost = asNumber(row.Cost);
    for (const modName of entry.mods || []) {
      const modRow = findRow(data.rig_mods, "Rig Mod", modName);
      if (modRow) cost += asNumber(modRow.Cost);
    }
    const stats = rigStats(entry, data);
    if (errors && stats.modSlotsUsed > stats.modSlots) {
      const message = `${entry.name}: ${stats.modSlotsUsed} mod slot(s) used but only `
                    + `${stats.modSlots} available.`;
      errors.push(message);
      if (playErrors) playErrors.push(message);
    }
    totalCost += round2(cost * gearCostMultiplier);
  }
  return { cost: totalCost };
}

const HEAVY_FITTING_WEIGHT = 4;
const CARGO_PER_WEIGHT_BLOCK = 3;
const VEHICLE_MIN_CARGO = 1;
const VEHICLE_WEAPON_BODY_DIVISOR = 3;
// Vehicle Condition scales the base price (not fitted weapons/mods).
/* Condition scales the base chassis price. Pristine..Poor describe wear;
 * "Blinged" is the opposite direction — a customised showpiece at triple price
 * that turns heads. Applies to drones as well as vehicles.
 * VEHICLE_CONDITION_EFFECTS carries any gameplay rider a condition brings; it's
 * reported on the unit rather than applied, matching how armor Style etiquette
 * bonuses work (the engine has no etiquette-bonus mechanism, and the bonus only
 * counts when you're actually showing the thing off). */
const VEHICLE_CONDITIONS = ["Blinged", "Pristine", "Good", "Fair", "Poor"];
const VEHICLE_CONDITION_FACTORS = { Blinged: 3, Pristine: 1, Good: 0.75, Fair: 0.5, Poor: 0.25 };
const VEHICLE_CONDITION_EFFECTS = { Blinged: "+2 Street Etiquette" };

function priceFittedVehicle(entry, baseRow, data, weaponAndModTables, gearCostMultiplier) {
  // Vehicle Condition AND the small-heritage surcharge scale the BASE price
  // only — fitted weapons/mods always pay face value. Drones have no condition
  // field and pass gearCostMultiplier 1, so both are no-ops for them.
  let cost = asNumber(baseRow.Cost) * (VEHICLE_CONDITION_FACTORS[entry.condition] || 1)
             * gearCostMultiplier;
  const fitted = [];
  // Unit mods may be plain names (unit-scoped) or {name, weapon} (attached to a
  // specific mounted weapon); either way we price by the mod's name.
  const fittedNames = [...(entry.weapons || []),
    ...(entry.mods || []).map(m => (typeof m === "string" ? m : m && m.name))];
  for (const requestedName of fittedNames) {
    if (!requestedName) continue;
    for (const [dataKey, nameColumn] of weaponAndModTables) {
      const found = findRow(data[dataKey], nameColumn, requestedName);
      if (found) {
        cost += asNumber(found.Cost);
        fitted.push({ name: requestedName,
                      weight: asNumber(found.Weight),
                      is_weapon: !dataKey.includes("mods") });
        break;
      }
    }
  }
  cost = round2(cost);
  const summary = { name: entry.name, fitted: fitted.map(f => f.name),
                    fitted_detail: fitted, cost };
  for (const field of ["Move", "Body", "Handling", "Frame", "Cargo", "Impact",
                       "Ballistic", "Effect", "WW", "Hard Point"]) {
    if (field in baseRow) summary[field] = baseRow[field];
  }
  return [cost, summary];
}

// Every vehicle limit is a guideline, so this one takes no `errors` — priceAll
// passes it anyway and the extra argument is simply ignored.
function checkVehicleLimits(summary, warnings) {
  const fitted = summary.fitted_detail || [];
  const heavy = fitted.filter(f => f.weight > HEAVY_FITTING_WEIGHT);
  const normalWeight = sumBy(fitted, f => f.weight <= HEAVY_FITTING_WEIGHT ? f.weight : 0);
  const cargoLoss = Math.floor(toInt(normalWeight) / CARGO_PER_WEIGHT_BLOCK) + 2 * heavy.length;
  const baseCargo = toInt(asNumber(summary.Cargo));
  summary.effective_cargo = baseCargo - cargoLoss;
  if (summary.effective_cargo < VEHICLE_MIN_CARGO) {
    warnings.push(`${summary.name}: fitted weight leaves ${summary.effective_cargo} `
                  + `Cargo — a vehicle needs at least ${VEHICLE_MIN_CARGO} for the driver.`);
  }

  const weaponCount = fitted.filter(f => f.is_weapon).length;
  const weaponCap = Math.floor(toInt(asNumber(summary.Body)) / VEHICLE_WEAPON_BODY_DIVISOR);
  summary.weapon_count = weaponCount;
  summary.weapon_cap = weaponCap;
  // Body ÷ 3 is a guideline, not a count of mounting points, so it stays a
  // warning even though the drone equivalent (hard points) is binding.
  if (weaponCount > weaponCap) {
    warnings.push(`${summary.name}: ${weaponCount} weapons mounted — `
                  + `max is ${weaponCap} (Body ÷ 3).`);
  }
}

function checkDroneLimits(summary, warnings, errors) {
  const fitted = summary.fitted_detail || [];
  const totalWeight = sumBy(fitted, f => f.weight);
  const ww = toInt(asNumber(summary.WW));
  summary.ww_used = totalWeight;
  summary.ww_max = ww;
  // Overloading a drone degrades it; it doesn't make the fitting impossible.
  if (totalWeight > ww) {
    // %g-style formatting to match the Python reference exactly
    warnings.push(`${summary.name}: fitted weight ${Number(totalWeight.toPrecision(6))} exceeds WW ${ww}.`);
  }

  const weaponCount = fitted.filter(f => f.is_weapon).length;
  const hardPoints = toInt(asNumber(summary["Hard Point"]));
  summary.weapon_count = weaponCount;
  summary.weapon_cap = hardPoints;
  // Hard points are physical mounts: past the last one there is nowhere to bolt
  // the weapon on, so this one binds.
  if (weaponCount > hardPoints) {
    errors.push(`${summary.name}: ${weaponCount} weapons mounted — `
                + `only ${hardPoints} hard point(s).`);
  }
}

function priceDronesAndVehicles(character, data, gearCostMultiplier, warnings, errors) {
  // Weapons first, then the mod table — priceFittedVehicle walks the list in
  // order and stops at the first match, and charges for either kind alike.
  const flatten = cfg => [...cfg.weapons, cfg.mods];
  const droneTables = flatten(UNIT_ATTACHMENT_TABLES.drones);
  const vehicleTables = flatten(UNIT_ATTACHMENT_TABLES.vehicles);

  const priceAll = (entries, tableKey, nameColumn, weaponTables, check, mult) => {
    let total = 0.0;
    const summaries = [];
    for (const entry of entries) {
      const row = findRow(data[tableKey], nameColumn, entry.name);
      if (!row) continue;
      const [cost, summary] = priceFittedVehicle(entry, row, data, weaponTables, mult);
      check(summary, warnings, errors);
      total += cost;
      summaries.push(summary);
    }
    return [total, summaries];
  };

  // The small-heritage surcharge covers a vehicle's base chassis (priceFittedVehicle
  // applies it to the base only, not fitted weapons/mods) but not drones — a
  // small pilot doesn't change a remote drone's price.
  const [droneCost, drones] = priceAll(character.drones, "drones", "Drone",
                                       droneTables, checkDroneLimits, 1);
  const [vehicleCost, vehicles] = priceAll(character.vehicles, "vehicles", "Vehicle",
                                           vehicleTables, checkVehicleLimits,
                                           surchargeFor("vehicle", gearCostMultiplier));
  return { drones, vehicles, cost: droneCost + vehicleCost };
}

function priceMiscGearAndLifestyle(character, data, gearCostMultiplier, hasHyperthyroid) {
  let gearCost = 0.0, gearWeight = 0.0;
  for (const entry of character.gear) {
    const row = findRow(data.misc_gear, "Item", entry.name);
    if (!row) continue;
    const quantity = Math.max(1, toInt(asNumber(entry.qty, 1)));
    gearCost += asNumber(row.Cost) * quantity;
    gearWeight += asNumber(row.Weight) * quantity;
  }
  gearCost = round2(gearCost * gearCostMultiplier);

  let prepaid = (character.lifestyles || []).length ? character.lifestyles : [];
  if (!prepaid.length && character.lifestyle && character.lifestyle.name) {
    prepaid = [character.lifestyle];
  }
  let lifestyleCost = 0.0;
  for (const entry of prepaid) {
    const row = findRow(data.lifestyles, "Lifestyle", entry.name) || { MonthlyCost: 0 };
    lifestyleCost += asNumber(row.MonthlyCost) * Math.max(
      0, toInt(asNumber(entry.months, 1)));
  }
  if (hasHyperthyroid) lifestyleCost *= HYPERTHYROID_LIFESTYLE_SURCHARGE;

  return { gear_cost: gearCost, gear_weight: gearWeight, lifestyle_cost: lifestyleCost };
}

// Zoetic Rating from gear reflects what's actively carried/worn/linked, not
// everything owned — matches the "carried ZR" wording in the ZP warning below.
function gearZoeticRating(character, data) {
  let total = 0.0;

  const add = (table, nameColumn, names) => {
    for (const name of names) {
      const row = findRow(data[table], nameColumn, name);
      if (row) total += asNumber(row.ZR);
    }
  };

  add("weapons", "Weapon", character.weapons
    .filter(w => w.equipped !== false).map(w => w.name));
  // Armor: base row ZR, +1 for any piece with at least one Extra fitted
  // (house rule: mods add circuitry to otherwise-inert armor).
  for (const entry of character.armor.filter(a => a.active !== false)) {
    const row = findRow(data.armor, "Armor", entry.name);
    if (row) total += asNumber(row.ZR) + ((entry.extras || []).length ? 1 : 0);
  }
  // ZR comes from what you are carrying, not from everything you own, so decks,
  // drones and vehicles take the same permissive `carried !== false` flag misc
  // gear uses.
  add("decks", "Name", character.decks
    .filter(d => d.carried !== false).map(d => d.name));
  // A program isn't carried — it's part of the deck. It counts when it is
  // loaded onto the deck you're running, and one whose I/O never occupies a
  // thread runs whenever the deck does, so it counts with it. Nothing is loaded
  // during creation, so only the always-on ones count then.
  const decking = (character.play || {}).decking || {};
  const equippedName = equippedDeckName(character);
  const activeDeck = character.decks.find(d => d.name === equippedName) || null;
  if (activeDeck && activeDeck.carried !== false) {
    const loaded = new Set(decking.loaded || []);
    add("programs", "Name", character.programs.filter(name =>
      loaded.has(name) || !programNeedsThread(findRow(data.programs, "Name", name))));
  }
  // A rig contributes when it is the equipped one — one at a time, same as
  // decks. A character that never chose falls back to the first owned, the same
  // fallback deriveExploitActions and the play tab use.
  const activeRig = activeGearRow(character.rigs,
    ((character.play || {}).rigging || {}).active_rig, data.rigs, "Rig Type");
  if (activeRig) total += asNumber(activeRig.ZR);
  add("drones", "Drone", character.drones
    .filter(d => d.carried !== false).map(d => d.name));
  add("vehicles", "Vehicle", character.vehicles
    .filter(v => v.carried !== false).map(v => v.name));
  return round2(total);
}

// The character's single "active" deck/rig drives its exploit-action count (you
// can only jack into one deck / pilot one rig at a time). Falls back to the first
// owned item when nothing is flagged active yet, mirroring the play-tab default.
function activeGearRow(owned, activeName, table, keyCol) {
  if (!owned || !owned.length) return null;
  let name = activeName;
  if (!name || !owned.some(o => o.name === name)) name = owned[0].name;
  return findRow(table, keyCol, name) || null;
}

// Every exploit action the character can bring to bear, itemised by kind and
// source, for the Overview combat card. See rules #1–7 in the changelog:
// Wired Reflexes / Combat Mastery (Melee), Trackmobi / Repulsors (Move), the
// active Deck / Rig's cores (Decking / Rigging), and summon spells / slotted
// bond spirits (Control).
function deriveExploitActions(character, data, magicType, augments, amp) {
  const actions = [];   // [{ kind, count, source }]

  // --- Melee: Wired Reflexes (1 or 2 by rank) + Combat Mastery amp (+2).
  if (augments.melee_exploit_bonus > 0) {
    actions.push({ kind: "Melee", count: augments.melee_exploit_bonus,
      source: augments.wired_reflexes_rank
        ? `Wired Reflexes ${augments.wired_reflexes_rank}` : "Wired Reflexes" });
  }
  if (amp.powers_taken.has("Combat Mastery")) {
    actions.push({ kind: "Melee", count: COMBAT_MASTERY_MELEE_EXPLOIT_BONUS,
      source: "Combat Mastery (Amp)" });
  }

  // --- Move: each Trackmobi / Repulsors mount grants one.
  for (const name of augments.move_exploit_sources || []) {
    actions.push({ kind: "Move", count: 1, source: name });
  }

  // --- Decking: the active deck's cores (Single 1 … Quad 4). Through
  // equippedDeckName rather than activeGearRow directly, so a jacked-out
  // decker's cores stop granting exploit actions — the deck isn't running.
  const deckName = equippedDeckName(character);
  const deck = deckName ? findRow(data.decks, "Name", deckName) : null;
  if (deck) {
    const n = CORE_EXPLOIT_COUNT[deck.Core] || 0;
    if (n) actions.push({ kind: "Decking", count: n,
      source: `${deck.Name} (${deck.Core} core)` });
  }

  // --- Rigging: the active rig's cores, same scale as decks.
  const rig = activeGearRow(character.rigs,
    ((character.play || {}).rigging || {}).active_rig, data.rigs, "Rig Type");
  if (rig) {
    const n = CORE_EXPLOIT_COUNT[rig.Cores] || 0;
    if (n) actions.push({ kind: "Rigging", count: n,
      source: `${rig["Rig Type"]} (${rig.Cores} core)` });
  }

  // --- Control: one per summon spell known (Mage/Archmage) …
  if (magicType === "Mage" || magicType === "Archmage") {
    const known = new Set((character.magic.spells || []).map(s => s.name));
    for (const spellName of SUMMON_CONTROL_SPELLS) {
      if (known.has(spellName)) actions.push({ kind: "Control", count: 1, source: spellName });
    }
  }
  // … and two per spirit slotted in a Speaker/Archmage bond slot (play state).
  // Bounded by the bonds actually bought: a slot beyond that count is dormant
  // state kept for a restore, not a bond the character can call on.
  if (magicType === "Speaker" || magicType === "Archmage") {
    const slots = ((character.play || {}).bond_slots || [])
      .slice(0, speakerBondCount(character));
    // Safety net for a stale save with the same spirit in two slots (the
    // picker prevents it going forward) — one spirit is one Control source,
    // not two.
    const seen = new Set();
    for (const bond of slots) {
      if (bond && bond.spirit && !seen.has(bond.spirit)) {
        seen.add(bond.spirit);
        actions.push({ kind: "Control",
          count: SPEAKER_BOND_CONTROL_EXPLOITS, source: bond.spirit });
      }
    }
  }

  return actions;
}

// ============================================================== step 9: combat stats
function deriveCombatStats(heritage, finalAttributes, augments, amp, weaponWeight,
                           armorWeight, gearWeight, cyberwareZoeticRating,
                           armorBallistic, armorImpact, armorBallisticMax) {
  // 1/2 attribute rounds down but never below 1, then +6 base track. This is
  // the same for every heritage -- Replicants used to get a further +6 here,
  // which no rule backs (issue #23).
  const physicalCondition = (CONDITION_TRACK_BASE
                             + Math.max(1, Math.floor(finalAttributes.Body / 2)));
  const stunCondition = (CONDITION_TRACK_BASE
                         + Math.max(1, Math.floor(finalAttributes.Willpower / 2)));

  const hasChelonian = amp.powers_taken.has("Aspect of the Chelonian");
  // Perfect Situational Awareness grants +3d on dodge AND soak — fold it into
  // both combat bonuses (it was previously only a Brawn pool note).
  const psaBonus = amp.powers_taken.has("Perfect Situational Awareness")
    ? PERFECT_SITUATIONAL_AWARENESS_BONUS : 0;
  // Itemised non-worn armor (cyber/bioware augments, innate heritage, amp) so
  // the Overview loadout can list each source, not just the combined total.
  const armorSources = [];
  for (const [row, count] of augments.rows) {
    const b = toInt(asNumber(row["Ballistic Armor"])) * count;
    const i = toInt(asNumber(row["Impact Armor"])) * count;
    if (b || i) armorSources.push({ name: row.Name, b, i,
      unstrippable: !!toInt(asNumber(row.ImpArmMin)) });
  }
  if (heritage.ballistic_armor || heritage.impact_armor)
    armorSources.push({ name: "Innate (heritage)", b: heritage.ballistic_armor,
      i: heritage.impact_armor, unstrippable: true });
  if (hasChelonian)
    armorSources.push({ name: "Aspect of the Chelonian", b: CHELONIAN_BALLISTIC_ARMOR,
      i: CHELONIAN_IMPACT_ARMOR });
  const simpleActions = amp.powers_taken.has("Adrenaline Boost")
    ? ADRENALINE_BOOST_SIMPLE_ACTIONS : DEFAULT_SIMPLE_ACTIONS;

  // Weight is weight (#65). This used to fold cyberware Zoetic Rating into
  // the same figure, which added a magic-interference number to a pile of
  // kilograms and produced a total that was neither: chrome is INSIDE you and
  // weighs nothing you can put down. ZR has its own home in CALC.zoetics
  // (augment_zr, already exempt for Synthetics) and is reported there.
  const carriedWeight = weaponWeight + armorWeight + gearWeight;

  return {
    physical: physicalCondition,
    stun: stunCondition,
    move: BASE_MOVE_METERS + heritage.move_bonus + augments.move_bonus,
    // Mobi augments now surface as structured move_modes; keep heritage quirks here.
    move_special: [...heritage.special_move_notes],
    // Recoil capacity: everyone starts at 1, Strength adds a flat step at 12 and
    // a bigger one at 24, and each Gyromount augment adds +2. Fitted weapon mods
    // (Gyro-mount, Bi-pod, Gas Vent) raise it further for the one gun they're on
    // — that part is per-weapon and lands in CALC.weapons, not here.
    recoil_capacity: BASE_RECOIL_CAPACITY
      + recoilStrengthBonus(finalAttributes.Strength)
      + augments.recoil_capacity_bonus,
    recoil_strength_bonus: recoilStrengthBonus(finalAttributes.Strength),
    recoil_augment_bonus: augments.recoil_capacity_bonus,
    optics_notes: augments.combat_notes,
    sense_notes: augments.sense_notes,
    move_modes: augments.move_modes,
    physical_damage_reduction: augments.physical_damage_reduction,
    simple_actions: simpleActions,
    ballistic_armor: (armorBallistic + augments.ballistic_armor
                      + heritage.ballistic_armor
                      + (hasChelonian ? CHELONIAN_BALLISTIC_ARMOR : 0)),
    impact_armor: (armorImpact + augments.impact_armor
                   + heritage.impact_armor
                   + (hasChelonian ? CHELONIAN_IMPACT_ARMOR : 0)),
    armor_sources: armorSources,
    // Highest single ballistic source (armor doesn't stack for this cap).
    max_ballistic: Math.max(armorBallisticMax || 0, augments.ballistic_armor_max || 0,
                            heritage.ballistic_armor_max || 0,
                            hasChelonian ? CHELONIAN_BALLISTIC_ARMOR : 0),
    // Impact armor that can't be stripped: un-strippable augments + innate heritage.
    min_impact: (augments.impact_armor_min || 0) + (heritage.impact_armor || 0),
    dodge_bonus: heritage.dodge_bonus + augments.dodge_bonus + psaBonus,
    soak_bonus: heritage.soak_bonus + psaBonus,
    carried_weight: round2(carriedWeight),
  };
}

/* Bling is a look, and a room only notices it once. A blinged gun, a blinged
 * ride and (should one ever exist) blinged plate DO NOT add up: the character
 * gets the best single source per etiquette, not the sum. Like every other
 * etiquette rider this is reported rather than applied — but reported as ONE
 * number, because the whole point is that they don't stack.
 *
 * Sources are the weapon mod (Effect "Street cred: +2 Street Etiquette") and a
 * unit's Blinged condition. Anything else whose name starts "Bling" and whose
 * effect names an etiquette joins in automatically, which is what an armor
 * version would need.
 *
 * Returns [{ etiquette, bonus, sources: [...] }], best first, or []. */
function blingEtiquette(character, data) {
  const found = {};
  const add = (text, label) => {
    const m = /([+-]?\d+)\s*(?:to\s+)?([A-Za-z]+)\s+Etiquette/i.exec(text || "");
    if (!m) return;
    const n = parseInt(m[1], 10);
    const etq = ETIQUETTES.find(e => e.toLowerCase().startsWith(m[2].toLowerCase()));
    if (!n || !etq) return;
    const slot = found[etq] || (found[etq] = { etiquette: etq, bonus: 0, sources: [] });
    slot.sources.push(`${label} (+${n})`);
    slot.bonus = Math.max(slot.bonus, n);      // best source wins, never the sum
  };
  const isBling = name => /^bling/i.test(String(name || ""));
  for (const w of character.weapons || []) {
    for (const mod of w.mods || []) {
      const name = (mod && typeof mod === "object") ? mod.name : mod;
      if (!isBling(name)) continue;
      const row = findRow(data.weapon_mods, "Modification", name) || {};
      add(row.Effect, `${name} on ${w.name}`);
    }
  }
  for (const key of ["drones", "vehicles"]) {
    for (const u of character[key] || []) {
      add(VEHICLE_CONDITION_EFFECTS[u.condition], `${u.label || u.name} (${u.condition})`);
    }
  }
  for (const a of character.armor || []) {
    for (const extra of [...(a.extras || []), a.material, a.style]) {
      const name = (extra && typeof extra === "object") ? extra.name : extra;
      if (!isBling(name)) continue;
      const row = findRow(data.armor_extras, "Extra", name)
        || findRow(data.armor_materials, "Material", name)
        || findRow(data.armor_styles, "Style", name) || {};
      add(row.Effects || row.Effect || row["Etiquette Bonus"], `${name} on ${a.name}`);
    }
  }
  return Object.values(found).sort((x, y) => y.bonus - x.bonus);
}

/* ---- skill bonuses and notes from anything you own -------------------------
 * Two columns every homebrew-eligible table carries:
 *
 *   Skill Bonus  "Fascination +1"            flat dice, folded into the rating
 *                "Shadow +1, Observation +2"  several, comma-separated
 *   Skill Note   "Shadow: reroll 1s/2s in urban environments"
 *                situational text, shown beside the skill and never summed
 *
 * Structured rather than parsed out of Effect prose, deliberately. "+1 bonus
 * die to Fascination" and "+1 to Body" are the same shape in English, so a
 * prose parser would have to guess which nouns are skills and which are
 * attributes. Making the author name the column removes the guess — and the
 * check in tools/check_data.py then guarantees the editor exposes it.
 *
 * Unknown skill names are reported rather than silently dropped: a typo here
 * produces a bonus that never lands, which is exactly the failure this whole
 * mechanism exists to stop. */
function parseSkillBonuses(text, warn) {
  const out = [];
  for (const part of String(text || "").split(",")) {
    const s = part.trim();
    if (!s) continue;
    const m = /^(.+?)\s*([+-]\s*\d+)$/.exec(s);
    if (!m) { if (warn) warn(`"${s}" is not "Skill +N"`); continue; }
    const skill = canonicalSkillName(m[1].trim());
    if (!skill) { if (warn) warn(`no skill called "${m[1].trim()}"`); continue; }
    out.push({ skill, bonus: toInt(asNumber(m[2].replace(/\s+/g, ""))) });
  }
  return out;
}

function parseSkillNotes(text, warn) {
  const out = [];
  for (const part of String(text || "").split("|")) {
    const s = part.trim();
    if (!s) continue;
    const m = /^(.+?)\s*:\s*(.+)$/.exec(s);
    if (!m) { if (warn) warn(`"${s}" is not "Skill: note"`); continue; }
    const skill = canonicalSkillName(m[1].trim());
    if (!skill) { if (warn) warn(`no skill called "${m[1].trim()}"`); continue; }
    out.push({ skill, note: m[2].trim() });
  }
  return out;
}

/* Skill names are matched case-insensitively so an author needn't reproduce the
 * exact capitalisation of "Computer: Hacking". */
function canonicalSkillName(name) {
  const want = String(name || "").trim().toLowerCase();
  return Object.keys(SKILLS).find(s => s.toLowerCase() === want) || null;
}

/* Every Skill Bonus / Skill Note the character is currently getting.
 *
 * The active tests are the ones the rest of the engine already uses: armor must
 * be worn, weapons equipped, gear carried, augments are installed and always
 * count, and a spirit must be infused or bonded rather than merely known.
 * Vehicles and drones count as owned — a rigger's kit isn't "worn".
 *
 * Returns { bonus: {skill: n}, notes: {skill: [text]}, sources: [...] }. */
function gearSkillEffects(character, data, warnings) {
  const bonus = {}, notes = {}, sources = [];
  // Movement rides along with the skill sweep rather than getting a second one.
  // The hard part of both jobs is identical — deciding what the character is
  // currently wearing, carrying, has installed or has out — and two sweeps would
  // be two chances for those rules to drift apart (#41).
  const movement = { move_bonus: 0, move_modes: [] };
  const nameOf = x => (x && typeof x === "object") ? x.name : x;
  /* `times` is how many copies are contributing — 1 for anything you simply
   * own, and the number of counting doses for a consumable. 0 means the thing is
   * present but doing nothing (an unused kit in your bag), so it contributes no
   * dice and no note, but its text is still validated: a typo should be reported
   * whether or not the item happens to be in use right now. */
  /* `skipMove` turns off the movement half for a row.
   *
   * Two unrelated reasons, both real:
   *
   *   Augments already have their AltMove/MoveMode read by augmentEffectSums —
   *   reading them again here would fly every Repulsors character twice.
   *
   *   Drones and vehicles have a "Move" column that means the UNIT's own speed
   *   ("8m"), not a change to its owner's. Owning a fast car must not make you
   *   fast. Today those values carry an "m" that wouldn't parse anyway, which is
   *   luck rather than a design, and a homebrew drone written "8" would quietly
   *   turn into a +8m sprint for its rigger. */
  const apply = (row, label, times = 1, skipMove = false) => {
    if (!row) return;
    const warn = msg => warnings && warnings.push(`${label}: Skill Bonus — ${msg}.`);
    for (const b of parseSkillBonuses(row["Skill Bonus"], warn)) {
      if (times < 1) continue;
      bonus[b.skill] = (bonus[b.skill] || 0) + b.bonus * times;
      sources.push({ skill: b.skill, bonus: b.bonus * times, label });
    }
    const warnNote = msg => warnings && warnings.push(`${label}: Skill Note — ${msg}.`);
    for (const n of parseSkillNotes(row["Skill Note"], warnNote)) {
      // A note is a rider, not a quantity: two doses don't make it truer.
      if (times < 1) continue;
      (notes[n.skill] = notes[n.skill] || []).push(`${n.note} (${label})`);
    }
    if (times < 1 || skipMove) return;
    // "Move": metres added to or taken off ground movement. Signed, so a
    // penalty is just a negative — Polypedal Legs are −1m, and nothing about
    // the column assumes a bonus.
    movement.move_bonus += toInt(asNumber(row.Move)) * times;
    // "AltMove" + "MoveMode": a whole extra way of getting around (Fly 14m,
    // Swim 10m) rather than a change to the one you have.
    const alt = toInt(asNumber(row.AltMove));
    if (alt) {
      movement.move_modes.push({ name: label, mode: row.MoveMode || "Alt", meters: alt });
    }
  };
  const rowsOf = (entries, table, column, active, skipMove = false) => {
    for (const e of entries || []) {
      if (active && !active(e)) continue;
      const name = nameOf(e);
      if (!name) continue;
      apply(findRow(data[table], column, name), name, 1, skipMove);
    }
  };

  rowsOf(character.augments, "augments", "Name", null, true);
  rowsOf(character.armor, "armor", "Armor", e => e.active !== false);
  // Gear, with consumables gated on actually having been used. A First Aid Kit
  // in your bag is not a First Aid Kit you have opened, so its Biotech dice only
  // land while a dose of it is live — which is what makes "one-time use" mean
  // anything. Ordinary carried gear is unchanged.
  const doseList = ((character.play || {}).doses) || [];
  for (const e of character.gear || []) {
    if (e.carried === false) continue;
    const name = nameOf(e);
    if (!name) continue;
    const row = findRow(data.misc_gear, "Item", name);
    if (!row) continue;
    if (gearIsDose(row)) {
      const live = doseList.filter(d => d && d.name === name).length;
      apply(row, name, Math.min(live, gearMaxDoses(row)));
    } else apply(row, name);
  }
  rowsOf(character.weapons, "weapons", "Weapon", e => e.equipped !== false);
  rowsOf(character.decks, "decks", "Name");
  rowsOf(character.programs, "programs", "Name");
  rowsOf(character.rigs, "rigs", "Rig Type");
  // skipMove: their "Move" is the unit's own speed, not their owner's.
  rowsOf(character.vehicles, "vehicles", "Vehicle", null, true);
  rowsOf(character.drones, "drones", "Drone", null, true);
  rowsOf((character.magic || {}).spells, "spells", "Name");
  rowsOf(character.rituals, "rituals", "Name");
  // Amp powers. Play-bought powers are already merged into magic.amp_powers by
  // applyPlayAdvances, which runs first, so this is the same set the hardcoded
  // name checks used to see.
  rowsOf((character.magic || {}).amp_powers, "amp_powers", "Name");
  // Mods fitted to an equipped weapon, and augments mounted in worn hosts.
  for (const w of character.weapons || []) {
    if (w.equipped === false) continue;
    for (const mod of w.mods || [])
      apply(findRow(data.weapon_mods, "Modification", nameOf(mod)), `${nameOf(mod)} on ${w.name}`);
  }
  for (const [entries, test] of [[character.armor, e => e.active !== false],
                                 [character.weapons, e => e.equipped !== false],
                                 [character.gear, e => e.carried !== false]]) {
    for (const host of entries || []) {
      if (!test(host)) continue;
      for (const m of host.mounted || [])
        apply(findRow(data.augments, "Name", nameOf(m)), `${nameOf(m)} on ${host.name}`,
              1, true);   // mounted augments' alt-modes come via mergeMountedAugments
    }
  }
  // Spirits, on the same terms etiquette uses: the infusion slot picks the
  // column, a bond reads Bound Services. The Skill columns sit on the row
  // itself, so a spirit grants them whenever it is actually doing something.
  const engaged = new Set();
  for (const e of resolveInfusions(character, data).list) engaged.add(e.spirit);
  for (const b of ((character.play || {}).bond_slots || [])
                    .slice(0, speakerBondCount(character)))
    if (b && b.spirit) engaged.add(b.spirit);
  for (const spirit of engaged)
    apply(findRow(data.speaker_spirits, "Spirit", spirit), spirit);

  return { bonus, notes, sources, movement };
}

/* Fold gear skill effects into the augment tally, which is already the place
 * every skill bonus and note is aggregated before scoreSkills reads it. */
function mergeSkillEffects(augments, gear) {
  for (const [skill, n] of Object.entries(gear.bonus))
    augments.skill_bonus[skill] = (augments.skill_bonus[skill] || 0) + n;
  for (const [skill, list] of Object.entries(gear.notes))
    (augments.skill_notes[skill] = augments.skill_notes[skill] || []).push(...list);
  // Movement lands in the same tally for the same reason: `combat` already adds
  // augments.move_bonus and reads augments.move_modes, so anything folded in
  // here reaches the Move chip without a second wiring path.
  const mv = gear.movement || { move_bonus: 0, move_modes: [] };
  augments.move_bonus += mv.move_bonus;
  augments.move_modes.push(...mv.move_modes);
}

/* ---- etiquette modifiers ---------------------------------------------------
 * Gear that changes how a room reads you. The data states these in prose, in a
 * handful of shapes:
 *
 *   "Etiquette Bonus: +2 Corp, +1 Civic"                  armor_styles
 *   "Etiquette Bonus: +2 to Corp, Aristocratic, and Criminal"   one N, several
 *   "+2 to Charisma tests, +1 to Aristocratic etiquette"  armor_materials
 *   "Street cred: +2 Street Etiquette"                    Bling weapon mod
 *   "Gain +4 to all Etiquettes"                           speaker_spirits
 *
 * A number governs every etiquette named after it, up to the next number or the
 * end of the clause — which is how "+2 to Charisma tests" contributes nothing
 * while the "+1" beside it still lands on Aristocratic. Names match on prefix so
 * "Corp" resolves to Corporate, and "all" means all seven.
 *
 * Nothing is parsed out of text that never says "etiquette": without that guard
 * an augment reading "+2 Body. Opens Corporate doors." would score a Corporate
 * bonus off its flavour text. */
function parseEtiquetteBonuses(text) {
  const s = String(text || "");
  if (!/etiquette/i.test(s)) return [];
  const marks = [];
  const re = /[+-]?\d+/g;
  let m;
  while ((m = re.exec(s))) marks.push({ n: parseInt(m[0], 10), from: m.index, to: re.lastIndex });
  const out = [];
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i];
    if (!mark.n) continue;
    // Everything up to the next number, stopping at a sentence break so prose
    // after the bonus can't be read as more etiquette names.
    let span = s.slice(mark.to, i + 1 < marks.length ? marks[i + 1].from : s.length);
    const stop = span.search(/[.;]/);
    if (stop >= 0) span = span.slice(0, stop);
    const names = new Set();
    if (/\ball\b/i.test(span)) {
      for (const e of ETIQUETTES) names.add(e);
    } else {
      for (const word of span.match(/[A-Za-z]+/g) || []) {
        if (word.length < 3) continue;      // too short to disambiguate C-words
        const hit = ETIQUETTES.find(e => e.toLowerCase().startsWith(word.toLowerCase()));
        if (hit) names.add(hit);
      }
    }
    for (const etiquette of names) out.push({ etiquette, bonus: mark.n });
  }
  return out;
}

/* Every etiquette modifier the character is currently getting, and from what.
 *
 * Only worn / carried / equipped things count — the same host test
 * tallyMountedAugments applies — because a wardrobe hanging in a closet doesn't
 * change how anyone reads you. Installed augments and spirit relationships have
 * no such flag and always count.
 *
 * Sources stack. The one exception is Bling, which collapses to its best single
 * source first (a blinged gun and a blinged ride are one look, not two) and then
 * adds to everything else like any other source — so the no-stacking rule stays
 * scoped to Bling, where it belongs.
 *
 * Returns { adjust: {etiquette: n}, sources: [{etiquette, bonus, label}] }. */
function etiquetteModifiers(character, data) {
  const adjust = {};
  for (const e of ETIQUETTES) adjust[e] = 0;
  const sources = [];
  const apply = (text, label) => {
    for (const { etiquette, bonus } of parseEtiquetteBonuses(text)) {
      adjust[etiquette] += bonus;
      sources.push({ etiquette, bonus, label });
    }
  };
  const nameOf = x => (x && typeof x === "object") ? x.name : x;
  const isBling = name => /^bling/i.test(String(name || ""));

  // Worn armor: the Style's dedicated column plus whatever the Material and
  // Extras state in prose. Bling-named pieces are left to blingEtiquette.
  for (const a of character.armor || []) {
    if (a.active === false) continue;
    for (const [value, table, column, effectCols] of [
      [a.style, data.armor_styles, "Style", ["Etiquette Bonus"]],
      [a.material, data.armor_materials, "Material", ["Effect"]],
    ]) {
      const name = nameOf(value);
      if (!name || isBling(name)) continue;
      const row = findRow(table, column, name) || {};
      for (const col of effectCols) apply(row[col], `${name} on ${a.name}`);
    }
    for (const extra of a.extras || []) {
      const name = nameOf(extra);
      if (!name || isBling(name)) continue;
      const row = findRow(data.armor_extras, "Extra", name) || {};
      apply(row.Effects || row.Effect, `${name} on ${a.name}`);
    }
  }
  // Equipped weapons and the mods fitted to them; carried gear; installed
  // augments. None of these carry etiquette text in the core data today — the
  // mechanism covers them so homebrew can, and so a future core row works
  // without another engine change.
  for (const w of character.weapons || []) {
    if (w.equipped === false) continue;
    for (const mod of w.mods || []) {
      const name = nameOf(mod);
      if (!name || isBling(name)) continue;
      const row = findRow(data.weapon_mods, "Modification", name) || {};
      apply(row.Effect, `${name} on ${w.name}`);
    }
  }
  for (const g of character.gear || []) {
    if (g.carried === false) continue;
    const row = findRow(data.misc_gear, "Item", nameOf(g)) || {};
    apply(row.Effect, nameOf(g));
    apply(row.Notes, nameOf(g));
  }
  for (const aug of character.augments || []) {
    const row = findRow(data.augments, "Name", nameOf(aug)) || {};
    apply(row.Effect, nameOf(aug));
  }
  // Speaker spirits give nothing for the relationship alone — a spirit you know
  // is not a spirit that is doing anything for you. The rider lands only when
  // the spirit is INFUSED or BONDED, and the description says which is which:
  //
  //   infused — the slot picks the column (Physical, Firearm, Protection, …),
  //             so Eriphe's "+4 to all Etiquettes" needs a Physical infusion
  //   bonded  — "Bound Services", the list a bound spirit performs
  //
  // resolveInfusions already resolves slot -> column and drops stale or
  // double-invoked placements, so reuse it rather than re-deriving it here.
  for (const entry of resolveInfusions(character, data).list) {
    apply(entry.effect, `${entry.spirit} (infused: ${entry.slot})`);
  }
  // Same stale-save safety net as the Control exploits above: a spirit in two
  // bond slots grants its Bound Services rider once, not twice.
  const boundApplied = new Set();
  for (const bond of ((character.play || {}).bond_slots || [])
                       .slice(0, speakerBondCount(character))) {
    const name = bond && bond.spirit;
    if (!name || boundApplied.has(name)) continue;
    boundApplied.add(name);
    const row = findRow(data.speaker_spirits, "Spirit", name) || {};
    apply(row["Bound Services"], `${name} (bonded)`);
  }

  // Lifestyle. Wealthy states "+1 die to all etiquette tests (you may roll a
  // one-die test even with etiquette 0)" — the same thing as a rating point,
  // and the parenthetical is exactly the zero-bought case `final` already
  // surfaces. Play flags one lifestyle active; before that flag exists (chargen)
  // a lifestyle with prepaid months is the one you're living.
  const allLifestyles = [...(character.lifestyles || []),
                         ...((character.play || {}).lifestyles || [])];
  const anyActive = allLifestyles.some(l => l && l.active);
  for (const l of allLifestyles) {
    const bonus = LIFESTYLE_ETIQUETTE_BONUS[l && l.name];
    if (!bonus) continue;
    const living = anyActive ? !!l.active : toInt(asNumber(l.months)) > 0;
    if (!living) continue;
    for (const e of ETIQUETTES) { adjust[e] += bonus; sources.push({ etiquette: e, bonus, label: `${l.name} lifestyle` }); }
    break;                      // one lifestyle is lived at a time
  }
  // Bling last, already collapsed to one number per etiquette.
  for (const b of blingEtiquette(character, data)) {
    adjust[b.etiquette] += b.bonus;
    sources.push({ etiquette: b.etiquette, bonus: b.bonus,
                   label: `Bling (${b.sources.join(", ")})` });
  }
  return { adjust, sources };
}

function deriveInitiative(pools, finalAttributes, heritage, augments, amp, martialArt, data) {
  const notes = [];

  const scan = (label, text) => {
    if (text && text.toLowerCase().includes("initiat")) notes.push(`${label}: ${text}`);
  };

  for (const row of heritage.traits) scan(row.Name, row.Effects || "");
  for (const [row] of augments.rows) scan(row.Name, row.Effect || "");
  for (const name of amp.powers_taken) {
    const row = findRow(data.amp_powers, "Name", name);
    if (row) scan(name, row.Effect || "");
  }
  for (const level of martialArt.levels) {
    scan(`${level.Style || martialArt.style} L${level.Level}`, level.Effect || "");
  }
  return { dice: pools.Focus, bonus: finalAttributes.Reaction, notes };
}

/* Wildling's shift is an ordinary conditional pool effect (its dice fall out of
 * the trait text like everyone else's), but the Beast dice it grants are a
 * counter the sheet has to know the size of. */
const WILDLING_EFFECT_ID = "heritage:Wildling";
const WILDLING_BEAST_DICE = 6;    // refresh each round while shifted

/* ---------------------------------------------- conditional pool effects
 * Things the build owns that are only worth dice some of the time: an Adrenal
 * Pump you've triggered, a drug you're dosed on, the Wildling shift. None of
 * them belong in `pools` — a total that silently assumed your pump was running
 * would be wrong for most of a session — so the engine enumerates what the
 * character COULD switch on and what each is worth, and stops there. Which are
 * actually ON is play state; the sheet adds the live ones in poolState().
 *
 * The dice are read out of the same effect text the player reads, so homebrew
 * gets toggles for free and nothing is hardcoded per item.
 *
 * Infused spirits are deliberately NOT here: placing a spirit in a slot is
 * already the switch, and resolveInfusions folds those dice into the totals.
 */
const POOL_ALT = POOL_NAMES.join("|");
const POOL_LIST_RE = `(?:${POOL_ALT})(?:\\s*(?:[/,&]|,?\\s*and)\\s*(?:${POOL_ALT}))*`;
const POOL_DICE_RE = new RegExp(
  // a SIGNED number — "Brawn Pool (3) to avoid knockdown" is a target number,
  // not a bonus, and an unsigned match would turn it into one
  `([+\\u2212-]\\s*\\d+)\\s*(?:d\\b|dice)?\\s*(?:in\\s+)?(?:bonus\\s+)?(?:dice\\s+)?`
  + `(?:to\\s+)?(?:the\\s+|their\\s+)?(${POOL_LIST_RE})`, "gi");

/* Pull "+2 to Resolve, Brawn, and Finesse Pools" / "-3 Focus/Resolve" out of an
 * effect line. First clause per pool wins, because a second mention is a
 * different condition rather than more of the same one: "+4d Focus pool for 3
 * hrs. If addicted instead at -2d Focus w/o it" is a +4 you can switch on, not
 * a +4 and a -2 netted into +2. Returns null when the text grants no dice. */
function parsePoolDice(text) {
  if (!text) return null;
  const out = {};
  POOL_DICE_RE.lastIndex = 0;
  let m;
  while ((m = POOL_DICE_RE.exec(text))) {
    const n = toInt(m[1].replace(/−/g, "-").replace(/\s+/g, ""));
    if (!n) continue;
    for (const raw of m[2].split(/[/,&]|\band\b/)) {
      const pool = raw.trim();
      if (POOL_NAMES.includes(pool) && !(pool in out)) out[pool] = n;
    }
  }
  return Object.keys(out).length ? out : null;
}

/* ---- doses -----------------------------------------------------------------
 * Gear you take rather than carry: a drug, a stim, a patch. `Class` can't answer
 * this — "Meds" covers BioGel, which is consumed, and the First Aid Kit, which
 * is a reusable tool — so the flag is explicit, like Oneshot and RaisesMax.
 *
 * Max Doses is the stacking cap. Blank reads as 1, so a second dose of Sixgun is
 * tracked without doubling its bonus; Cram's "can chain up to 4" is a 4. */
function gearIsDose(row) {
  return String((row && row.Dose) || "").trim() === "1";
}

function gearMaxDoses(row) {
  const n = toInt(asNumber((row && row["Max Doses"]) || 0));
  return n > 0 ? n : 1;
}

/* The `misc_gear` rows behind the doses currently running, deduplicated.
 *
 * Carrying a drug and being on it are different states, and only the second one
 * grants anything — so anything reading dose effects has to start here rather
 * than from `character.gear`. Deduplicated because these feed yes/no questions
 * (does anything suppress wound penalties?) where a second Dorf adds nothing;
 * callers that care how many are live, like the pool-dice stacking in
 * `gearSkillEffects`, count `play.doses` themselves and clamp to `Max Doses`. */
function liveDoseRows(character, data) {
  const seen = new Set();
  const rows = [];
  for (const d of ((character.play || {}).doses) || []) {
    const name = d && d.name;
    if (!name || seen.has(name)) continue;
    const row = findRow(data.misc_gear, "Item", name);
    if (!row || !gearIsDose(row)) continue;
    seen.add(name);
    rows.push(row);
  }
  return rows;
}

function derivePoolEffects(character, data, heritage, augments, amp) {
  const seen = new Set();
  const effects = [];
  const add = (id, label, source, text, extra) => {
    if (!text || seen.has(id)) return;
    const pools = parsePoolDice(text);
    if (!pools) return;
    seen.add(id);
    effects.push({ id, label, source, text: String(text).trim(), pools, ...extra });
  };
  for (const row of heritage.traits) add(`heritage:${row.Name}`, row.Name, "Heritage", row.Effects);
  for (const [row] of augments.rows) add(`augment:${row.Name}`, row.Name, "Augment", row.Effect);
  for (const item of character.gear || []) {
    if (item.carried === false) continue;
    const row = findRow(data.misc_gear, "Item", item.name);
    // A dose isn't a switch you flip — it's something you took, and it stays
    // taken until it wears off. Marked here so the sheet drives it from the
    // dose list instead of offering an On/Off that would compete with it.
    if (row) add(`gear:${item.name}`, item.name, "Gear", row.Effect,
                 gearIsDose(row) ? { dose: true, max_doses: gearMaxDoses(row) } : null);
  }
  for (const name of amp.powers_taken) {
    const row = findRow(data.amp_powers, "Name", name);
    if (row) add(`amp:${name}`, name, "Amp power", row.Effect);
  }
  for (const name of ((character.magic || {}).spells) || []) {
    const row = findRow(data.spells, "Name", name);
    if (row) add(`spell:${name}`, name, "Spell", row.Effect);
  }
  return effects;
}

function derivePoolNotes(heritage, augments, amp, martialArt, poolEffects) {
  const notes = {};
  for (const pool of POOL_NAMES) notes[pool] = [];
  if (heritage.soak_bonus) {
    notes.Brawn.push(`+${heritage.soak_bonus}d Soak (heritage)`);
  }
  const traitNames = new Set(heritage.traits.map(row => row.Name));
  if (traitNames.has("Unstoppable")) {
    notes.Brawn.push("Reroll 1s on Soak (Unstoppable)");
  }
  // Conditional effects describe themselves on the tile with their own on/off
  // state (see conditionalPoolLines in sheet.js), so they get no standing note
  // here — one would say the same thing without saying whether it's live.
  if (heritage.specialization_pool in notes) {
    notes[heritage.specialization_pool].push("+1d to all tests (Specialization)");
  }
  if (amp.powers_taken.has("Perfect Situational Awareness")) {
    notes.Brawn.push("+3d dodge/soak/resistance (Perfect Situational Awareness)");
  }
  // Escalating soak tiers replace each other, so show the single effective bonus
  // (computed in martialArtStatMods) rather than one note per unlocked tier.
  if (martialArt.mods && martialArt.mods.soak_bonus)
    notes.Brawn.push(`+${martialArt.mods.soak_bonus}d Soak (${martialArt.style})`);
  return notes;
}

/**
 * Parse the cumulative unlocked levels of a martial art for the effects that map
 * to a tracked numeric stat, so they can be applied (not just shown as text):
 *   - Dodge dice  (Weirding Way +1d→+2d)  — escalating tiers *replace*, take best
 *   - Soak dice   (Shibumi +1d→+6d)       — escalating tiers *replace*, take best
 *   - Movement    (Weirding Way +2m base)  — additive metres
 *   - Recoil      (Gun-Kata "Ignore Recoil") — flag
 *   - Unarmed dmg (Shibumi "Unarmed deals Str+N") — surfaced as a note
 *   - Spurs dmg   (Way of the Tank "Spurs do N+STR") — overrides spur damage
 * Conditional dodge ("+4d vs 1 Tgt") is left as flavour text, not a flat bonus.
 */
function martialArtStatMods(levels) {
  const mods = { dodge_bonus: 0, soak_bonus: 0, move_bonus: 0,
    recoil_ignored: false, unarmed_damage: "", spurs_str_bonus: null,
    cover: [],   // [{ rank, label, source }] — Gun-Kata L1 Low, L5 High
    applied: [] };
  for (const lvl of levels) {
    const eff = lvl.Effect || "";
    // Standing cover granted by a level (merged with infusion cover, best wins).
    const coverGrant = parseCoverGrant(eff);
    if (coverGrant) {
      mods.cover.push({ ...coverGrant,
        source: `${lvl.Style || "Martial art"} L${lvl.Level}` });
    }
    let m = eff.match(/([+-]?\d+)\s*d\b[^.]*?\bdodge\b/i);
    if (m && !/\b(vs|if)\b/i.test(eff)) mods.dodge_bonus = Math.max(mods.dodge_bonus, toInt(m[1]));
    m = eff.match(/([+-]?\d+)\s*d\b[^.]*?\bsoak\b/i);
    if (m) mods.soak_bonus = Math.max(mods.soak_bonus, toInt(m[1]));
    m = eff.match(/([+-]?\d+)\s*m\b[^.]*?mov/i);
    if (m) mods.move_bonus += toInt(m[1]);
    if (/ignore\s+recoil/i.test(eff)) mods.recoil_ignored = true;
    m = eff.match(/unarmed[^.]*?str\s*\+\s*(\d+)/i);
    if (m) mods.unarmed_damage = `STR+${m[1]}`;
    m = eff.match(/spurs?[^.]*?(\d+)\s*\+\s*str/i);
    if (m) mods.spurs_str_bonus = toInt(m[1]);
  }
  if (mods.dodge_bonus) mods.applied.push(`+${mods.dodge_bonus}d Dodge`);
  if (mods.soak_bonus) mods.applied.push(`+${mods.soak_bonus}d Soak`);
  if (mods.move_bonus) mods.applied.push(`+${mods.move_bonus}m Movement`);
  if (mods.recoil_ignored) mods.applied.push("Recoil ignored");
  if (mods.unarmed_damage) mods.applied.push(`Unarmed ${mods.unarmed_damage} physical`);
  if (mods.spurs_str_bonus != null) mods.applied.push(`Spurs STR+${mods.spurs_str_bonus}`);
  return mods;
}

// Resolve each of the character's martial-art styles to its unlocked levels +
// stat mods. Returns a list of { style, rank, levels, mods }.
function resolveMartialArts(character, data) {
  const seen = new Set();
  const list = [];
  for (const ma of character.martial_arts || []) {
    const style = (ma.style || "").trim();
    if (!style || seen.has(style)) continue;   // ignore blanks / duplicate styles
    seen.add(style);
    const rank = Math.max(0, Math.min(SKILL_RANK_CAP, toInt(asNumber(ma.rank))));
    const levels = data.martial_arts.filter(row =>
      row.Style === style && toInt(asNumber(row.Level)) <= rank);
    list.push({ style, rank, levels, mods: martialArtStatMods(levels) });
  }
  return list;
}

// Fold the per-style list into one object shaped like the old single martial
// art, so combat / initiative / pool-note consumers keep working unchanged.
// Cross-style stat bonuses combine via martialArtStatMods on the union of all
// unlocked levels (max for dodge/soak, sum for movement).
function aggregateMartialArts(list) {
  const levels = list.flatMap(a => a.levels);
  const styles = list.map(a => a.style);
  return { style: styles.join(", "), styles, list, levels,
    rank: maxOf(list.map(a => a.rank), 0), mods: martialArtStatMods(levels) };
}

/* ---------------------------------------------------------------- infusions
 * A Speaker places a spirit into an infusion slot during play
 * (play.infusion_spirits: slot -> spirit name). The slot picks which column of
 * speaker_spirits applies: "Firearms 2" -> Firearm, "Protection" -> Protection,
 * and so on.
 *
 * Placement IS the active state -- unlike Adrenal Pump ("while active"), a
 * placed infusion is simply on -- so the flat numeric bonuses below are applied
 * to the derived stats, not just noted.
 *
 * Only unambiguous, flat patterns are parsed. The effect column is free-form
 * prose and much of it is situational ("Melee attackers take 1d6 stun dmg",
 * "Complex action to heal"), so anything not matched here is deliberately left
 * unparsed and surfaced as text instead -- silently applying a mis-read bonus
 * would be worse than not applying it. `unapplied` carries those so the UI can
 * show them and nothing is lost.
 */
const INFUSION_SLOT_COLUMNS = ["Firearm", "Protection", "Drone", "Digital", "Physical"];

/* Standing cover, granted by Gun-Kata levels ("Always Low Cover (-1d)", "Always
 * High Cover (-2d)") and by full-cover infusions. There's no cover stat in the
 * engine, so this is reported for the table to adjudicate. Cover is a STATE, not
 * a stack: escalating grants replace each other and the best one wins, matching
 * how martial-art dodge/soak tiers already behave.
 * The scale is Low −1d, High −2d, Full −4d to attackers. */
const COVER_TIERS = { low: 1, high: 2, full: 3 };
const COVER_DICE = { 1: 1, 2: 2, 3: 4 };   // dice penalty imposed on attackers
const COVER_LABELS = { 1: "Low cover (−1d)", 2: "High cover (−2d)",
                       3: "Full cover (−4d)" };

// Return { rank, label } for the best cover named in `text`, or null.
function parseCoverGrant(text) {
  const m = String(text || "").match(/\b(low|high|full)\s+cover\b/i);
  if (!m) return null;
  const rank = COVER_TIERS[m[1].toLowerCase()];
  return { rank, label: COVER_LABELS[rank] };
}

/* Fold every cover grant into one best-wins result:
 *   { rank, label, sources: [name] }  — or null when nothing grants cover.
 * Only grants AT the winning tier are credited: at Gun-Kata L5 the answer is
 * "High cover (L5)", not "High cover (L1, L5)" — L1's Low cover is superseded,
 * not contributing. */
function bestCover(grants) {
  const valid = grants.filter(g => g && g.rank);
  if (!valid.length) return null;
  const rank = Math.max(...valid.map(g => g.rank));
  const sources = [];
  for (const g of valid) {
    if (g.rank === rank && !sources.includes(g.source)) sources.push(g.source);
  }
  return { rank, label: COVER_LABELS[rank], dice: COVER_DICE[rank], sources };
}

// "Firearms 2" -> "Firearm"; "Protection 2" -> "Protection"; else the slot name.
function infusionSlotColumn(slot) {
  const base = String(slot || "").replace(/\s*\d+$/, "").trim();
  return base === "Firearms" ? "Firearm" : base;
}

function infusionStatMods(entries) {
  const mods = {
    pools: { Brawn: 0, Finesse: 0, Focus: 0, Resolve: 0 },
    attributes: {},  // attribute name -> temporary delta
    ballistic: 0, impact: 0, move: 0,
    // Drone-column bonuses apply to EVERY drone the character owns.
    drones: { ballistic: 0, impact: 0, hardening: 0, move: 0, body: 0 },
    cover: [],       // [{ rank, label, source }] — merged with martial-art cover
    applied: [],     // [{ text, source }] — what was folded into the numbers
    unapplied: [],   // [{ text, source }] — situational prose, shown as-is
  };
  for (const a of ATTRIBUTES) mods.attributes[a] = 0;
  for (const e of entries) {
    const eff = String(e.effect || "").trim();
    if (!eff) continue;
    // Split on commas so "+2 Brawn Pool, +2 I armor" contributes both halves —
    // and so a clause that ISN'T numeric ("+1 to I armor, +2d to melee attacks")
    // still reaches `unapplied` instead of being swallowed by its sibling.
    for (const clause of eff.split(",")) {
      const c = clause.trim();
      if (!c) continue;
      let hit = false;
      let m;
      // Drone column: bonuses to every owned drone. Handled first and exclusively
      // — "All Drones gain +5m Movement" must not also register as the
      // character's own movement.
      if (e.column === "Drone") {
        if ((m = c.match(/\+(\d+)\s*(?:to\s*)?B\s*\/\s*I\s*armor/i))) {
          mods.drones.ballistic += toInt(m[1]); mods.drones.impact += toInt(m[1]);
          mods.applied.push({ text: `Drones +${toInt(m[1])} B/I armor`, source: e.spirit });
          hit = true;
        } else if ((m = c.match(/\+(\d+)\s*(?:to\s*)?B\b(?!\s*\/)[^.]*?armor/i))) {
          mods.drones.ballistic += toInt(m[1]);
          mods.applied.push({ text: `Drones +${toInt(m[1])} Ballistic armor`, source: e.spirit });
          hit = true;
        } else if ((m = c.match(/\+(\d+)\s*(?:to\s*)?I\b(?!\s*\/)[^.]*?armor/i))) {
          mods.drones.impact += toInt(m[1]);
          mods.applied.push({ text: `Drones +${toInt(m[1])} Impact armor`, source: e.spirit });
          hit = true;
        }
        if ((m = c.match(/\+(\d+)\s*Hardening/i))) {
          mods.drones.hardening += toInt(m[1]);
          mods.applied.push({ text: `Drones +${toInt(m[1])} Hardening`, source: e.spirit });
          hit = true;
        }
        if ((m = c.match(/\+(\d+)\s*m\b[^.]*?mov/i))) {
          mods.drones.move += toInt(m[1]);
          mods.applied.push({ text: `Drones +${toInt(m[1])}m Movement`, source: e.spirit });
          hit = true;
        }
        // "Drones gain +3 Health" — Body is the only health-like quantity a
        // drone has, and it sizes both condition tracks.
        if ((m = c.match(/\+(\d+)\s*Health/i))) {
          mods.drones.body += toInt(m[1]);
          mods.applied.push({ text: `Drones +${toInt(m[1])} Body (condition tracks)`,
                              source: e.spirit });
          hit = true;
        }
        if (!hit) mods.unapplied.push({ text: c, source: e.spirit, slot: e.slot });
        continue;
      }
      // Cover grants merge with the martial-art ones (best tier wins). The
      // clause keeps flowing through the checks below, so "Full cover and +1B
      // Armor" contributes both.
      const cover = parseCoverGrant(c);
      if (cover) {
        mods.cover.push({ ...cover, source: e.spirit });
        hit = true;
      }
      // Pools: "+4 Brawn Pool" | "+1 Finesse Pool" | "Finesse +2" | "+2 Brawn"
      for (const pool of POOL_NAMES) {
        const re = new RegExp(
          `(?:\\+(\\d+)\\s*${pool}(?:\\s*Pool)?\\b|\\b${pool}\\s*\\+(\\d+))`, "i");
        if ((m = c.match(re))) {
          mods.pools[pool] += toInt(m[1] || m[2]);
          mods.applied.push({ text: `+${toInt(m[1] || m[2])} ${pool} Pool`, source: e.spirit });
          hit = true;
        }
      }
      // Attributes: "+2 Reaction". Attribute and pool names never overlap, so
      // this can't collide with the pool patterns above. Fed into scoreAttributes
      // as a fourth adjustment source, so pools, initiative, condition tracks and
      // melee damage all pick it up without any of them knowing about infusions.
      for (const attr of ATTRIBUTES) {
        const re = new RegExp(`(?:\\+(\\d+)\\s*${attr}\\b|\\b${attr}\\s*\\+(\\d+))`, "i");
        if ((m = c.match(re))) {
          const n = toInt(m[1] || m[2]);
          mods.attributes[attr] += n;
          mods.applied.push({ text: `+${n} ${attr}`, source: e.spirit });
          hit = true;
        }
      }
      // Armor: "+2 to B/I armor" | "+1B Armor" | "+2 B Armor" | "+1 to I armor"
      if ((m = c.match(/\+(\d+)\s*(?:to\s*)?B\s*\/\s*I\s*armor/i))) {
        mods.ballistic += toInt(m[1]); mods.impact += toInt(m[1]);
        mods.applied.push({ text: `+${toInt(m[1])} Ballistic & Impact armor`, source: e.spirit });
        hit = true;
      } else if ((m = c.match(/\+(\d+)\s*(?:to\s*)?B\b(?!\s*\/)[^.]*?armor/i))) {
        mods.ballistic += toInt(m[1]);
        mods.applied.push({ text: `+${toInt(m[1])} Ballistic armor`, source: e.spirit });
        hit = true;
      } else if ((m = c.match(/\+(\d+)\s*(?:to\s*)?I\b(?!\s*\/)[^.]*?armor/i))) {
        mods.impact += toInt(m[1]);
        mods.applied.push({ text: `+${toInt(m[1])} Impact armor`, source: e.spirit });
        hit = true;
      }
      // Movement: "+5m Movement"
      if ((m = c.match(/\+(\d+)\s*m\b[^.]*?mov/i))) {
        mods.move += toInt(m[1]);
        mods.applied.push({ text: `+${toInt(m[1])}m Movement`, source: e.spirit });
        hit = true;
      }
      if (!hit) mods.unapplied.push({ text: c, source: e.spirit, slot: e.slot });
    }
  }
  return mods;
}

/* Resolve the spirits currently placed in infusion slots into a display list
 * plus the stat mods above. Returns an empty result outside play. */
function resolveInfusions(character, data) {
  const placed = ((character.play || {}).infusion_spirits) || {};
  const owned = new Set((character.speaker || {}).infusions || []);
  const entries = [];
  // A spirit can only be invoked once, so it can never occupy two slots — the
  // picker enforces it, and this is the safety net that stops a stale save from
  // double-counting a bonus. Different spirits DO stack. A spirit already
  // bonded is committed there and can't ALSO be infused, so it's seeded in
  // up front rather than merely excluded slot-by-slot below.
  const invoked = boundSpiritNames(character);
  for (const [slot, spirit] of Object.entries(placed).sort((a, b) => a[0].localeCompare(b[0]))) {
    // Ignore a placement whose slot the character no longer owns.
    if (!spirit || (owned.size && !owned.has(slot))) continue;
    if (invoked.has(spirit)) continue;
    const row = findRow(data.speaker_spirits, "Spirit", spirit);
    if (!row) continue;
    const column = infusionSlotColumn(slot);
    if (!INFUSION_SLOT_COLUMNS.includes(column)) continue;
    invoked.add(spirit);
    entries.push({ slot, spirit, column, element: row.Element || "",
                   effect: row[column] || "" });
  }
  return { list: entries, mods: infusionStatMods(entries) };
}

// ============================================================== play mode (post-finalize)
function deepCopy(value) {
  return (typeof structuredClone === "function")
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

/* Applying an advance clamps it to the same ceiling the Kismet buttons enforce.
 * The buttons alone aren't enough: a character can arrive by import, cloud sync
 * or a hand-edited JSON file and carry any number at all, and until this
 * clamped, `skill_advances: { Sorcery: 900 }` was simply believed.
 *
 * Skills top out at 8 — rank 6 by Kismet, 7 on a mastery boon, 8 on a major
 * one. Etiquettes and Knowledges follow the same skill rules (#58) and share
 * this ceiling. Attributes stay inside the engine's own level range; their
 * per-heritage maximum is checked downstream, where it warns rather than
 * blocks (JC-002). Nothing here ever lowers a value: a negative advance is
 * discarded. */
const PLAY_SKILL_RANK_CAP = EXPERTISE_SKILL_RANK_CAP;

function applyPlayAdvances(character) {
  character = deepCopy(character);
  const play = character.play || {};
  const advance = plus => Math.max(0, toInt(asNumber(plus)));
  for (const [name, plus] of Object.entries(play.attribute_advances || {})) {
    if (name in character.attributes) {
      character.attributes[name] = Math.min(ATTRIBUTE_LEVEL_MAX,
        toInt(asNumber(character.attributes[name], 1)) + advance(plus));
    }
  }
  for (const [name, plus] of Object.entries(play.skill_advances || {})) {
    if (name in SKILLS) {
      character.skills[name] = Math.min(PLAY_SKILL_RANK_CAP,
        toInt(asNumber(character.skills[name] || 0)) + advance(plus));
    }
  }
  // Etiquettes are chargen-owned (not part of play.kit — see the bright line
  // below), so a Kismet raise can't write character.etiquettes[name] directly;
  // it goes through this advances counter instead, same as attributes/skills.
  character.etiquettes = character.etiquettes || {};
  for (const [name, plus] of Object.entries(play.etiquette_advances || {})) {
    if (ETIQUETTES.includes(name)) {
      character.etiquettes[name] = Math.min(PLAY_SKILL_RANK_CAP,
        toInt(asNumber(character.etiquettes[name] || 0)) + advance(plus));
    }
  }

  /* Speaker growth bought with Kismet. Bonds, infusions and relationships are
   * all chargen-owned fields, so — like etiquettes above — a Kismet purchase
   * can't write them directly; it accumulates here and is folded in.
   *
   * The chargen POINT budgets (SPEAKER_INFUSION_POINTS and friends) are
   * deliberately not extended: those are what Magic priority bought at
   * creation, and creation is over. A finalized character reports no budget
   * errors at all (JC-012), so the Magic tab simply shows more spent than the
   * creation budget held, which is the honest reading — the extra was paid for
   * in Kismet, not in points. */
  const speaker = character.speaker = character.speaker || {};
  const boughtBefore = speakerBondCount(character);
  if (play.bond_advances) {
    speaker.bonds = Math.min(SPEAKER_BOND_MAX,
      toInt(asNumber(speaker.bonds)) + advance(play.bond_advances));
  }
  for (const [field, bought] of [["infusions", play.speaker_infusions],
                                 ["relationships", play.speaker_relationships]]) {
    if (!Array.isArray(bought) || !bought.length) continue;
    speaker[field] = [...(speaker[field] || []), ...bought];
  }
  /* What Kismet paid for, so budgetMagic can leave it out of the CREATION
   * budgets. Without this the Magic tab reads overspent the moment a Speaker
   * buys anything in play — a false alarm, since nothing is wrong and no error
   * fires. Kismet purchases are appended above, so the chargen share is always
   * the prefix; the bond count is recorded before the ladder grows.
   *
   * Transient: applyPlayAdvances works on a deepCopy that only calculate()
   * sees, so this never reaches a saved character. */
  character.kismet_speaker = {
    bonds: speakerBondCount(character) - boughtBefore,
    infusions: (play.speaker_infusions || []).length,
    relationships: (play.speaker_relationships || []).length,
  };
  // Martial-art ranks bought in play, per style. Raising an existing style adds
  // to its rank; a style first learned in play is appended. An unknown style is
  // dropped — it can never be raised or displayed.
  character.martial_arts = character.martial_arts || [];
  const knownStyles = new Set((loadData().martial_arts || []).map(row => row.Style));
  for (const [style, plus] of Object.entries(play.martial_art_advances || {})) {
    const add = advance(plus);
    if (!style || !add || !knownStyles.has(style)) continue;
    const entry = character.martial_arts.find(m => m.style === style);
    if (entry) entry.rank = Math.min(PLAY_SKILL_RANK_CAP, toInt(asNumber(entry.rank)) + add);
    else character.martial_arts.push({ style, rank: Math.min(PLAY_SKILL_RANK_CAP, add) });
  }
  const knownRituals = new Set((loadData().rituals || []).map(row => row.Name));
  for (const [name, plus] of Object.entries(play.ritual_advances || {})) {
    if (!knownRituals.has(name)) continue;
    character.ritual_skills[name] = Math.min(PLAY_SKILL_RANK_CAP,
      toInt(asNumber(character.ritual_skills[name] || 0)) + advance(plus));
  }
  // The bright line. A finalized character carries its own copy of the kit it
  // left creation with, and play owns it: swap the chargen arrays for it and
  // everything downstream — pricing, ZR, armor totals, the sheet — is looking
  // at what the character HAS, while the untouched chargen record goes on
  // answering what they were BUILT with.
  if (play.kit) {
    for (const category of KIT_CATEGORIES) {
      if (Array.isArray(play.kit[category])) character[category] = deepCopy(play.kit[category]);
    }
  } else applyLegacyPlayEdits(character, play);

  // Play purchases append AFTER the kit, so index N of the character's array is
  // index N of the matching CALC array either way. This is the only place the
  // two halves are ever joined; everything upstream keeps them apart.
  const purchases = play.purchases || {};
  character.gear.push(...(purchases.gear || []));
  character.augments.push(...(purchases.augments || []));
  character.weapons.push(...(purchases.weapons || []));
  character.armor.push(...(purchases.armor || []));
  character.decks.push(...(purchases.decks || []));
  character.programs.push(...(purchases.programs || []));
  character.rigs.push(...(purchases.rigs || []));
  character.drones.push(...(purchases.drones || []));
  character.vehicles.push(...(purchases.vehicles || []));
  character.magic.amp_powers.push(...(purchases.amp_powers || []));
  character.magic.spells.push(...(purchases.spells || []));
  // Spells sold in play (#82). Applied AFTER the purchases are appended so one
  // pass covers both halves: a play-bought spell is spliced out of
  // purchases.spells directly by the sheet, but a CHARGEN spell can only be
  // removed here, because the chargen record itself must stay untouched.
  // Filtering the joined list means neither half needs a special case, and a
  // stale name (the spell was already gone) is simply a no-op.
  const forgotten = (play.spells_forgotten || []);
  if (forgotten.length) {
    const gone = new Set(forgotten);
    character.magic.spells = character.magic.spells.filter(s => !gone.has(s && s.name));
  }
  for (const [name, plus] of Object.entries(play.spell_force_advances || {})) {
    for (const spell of character.magic.spells) {
      if (spell.name === name) {
        spell.force = Math.min(SPELL_FORCE_MAX,
          toInt(asNumber(spell.force)) + advance(plus));
        break;
      }
    }
  }
  return character;
}

/* Everything below is pre-kit bookkeeping, kept so characters saved before
 * 2026-08-05 render correctly until ensureKit() converts them. Three separate
 * mechanisms, each covering one way play could reach into the chargen record;
 * `play.kit` replaces all of them with a copy play simply owns.
 *
 * Sublist edits run first: they address a chargen host by index, so they have
 * to happen before the item filter reindexes anything. Removals before
 * additions, so pulling a mod and fitting the same one again reads in the
 * order it happened. */
function applyLegacyPlayEdits(character, play) {
  const modName = m => (m && typeof m === "object") ? m.name : m;
  const hostSublist = record => {
    const list = Array.isArray(character[(record || {}).category])
      ? character[record.category][toInt(asNumber(record.host, -1))] : null;
    if (!list || !record.list) return null;
    return Array.isArray(list[record.list]) ? list[record.list]
      : (list[record.list] = []);
  };
  for (const record of play.disposed_mods || []) {
    const sub = hostSublist(record);
    if (!sub) continue;
    const i = sub.findIndex(m => modName(m) === record.name);
    if (i >= 0) sub.splice(i, 1);
  }
  for (const record of play.fitted_mods || []) {
    const sub = hostSublist(record);
    if (sub) sub.push(record.entry !== undefined ? deepCopy(record.entry) : record.name);
  }
  // Whole-sublist overrides for drones and vehicles (see unit_overrides).
  for (const [key, override] of Object.entries(play.unit_overrides || {})) {
    const [category, at] = String(key).split(":");
    const unit = Array.isArray(character[category])
      ? character[category][toInt(asNumber(at, -1))] : null;
    if (!unit || !override) continue;
    if (Array.isArray(override.weapons)) unit.weapons = deepCopy(override.weapons);
    if (Array.isArray(override.mods)) unit.mods = deepCopy(override.mods);
  }

  // Chargen kit sold or lost in play drops out last, so the recorded indices
  // still line up with the chargen arrays while the edits above run.
  for (const [category, indices] of Object.entries(play.disposed || {})) {
    if (!Array.isArray(character[category]) || !Array.isArray(indices)) continue;
    const gone = new Set(indices.map(i => toInt(asNumber(i, -1))));
    if (!gone.size) continue;
    character[category] = character[category].filter((_, i) => !gone.has(i));
  }
  return character;
}

// ============================================================== orchestrator
function calculate(character) {
  character = mergeDefaults(character);
  activeHouseRules = normalizeHouseRules(character);   // this character's house rules drive houseRule()
  const finalized = Boolean(character.finalized);
  if (finalized) character = applyPlayAdvances(character);
  const data = loadData();
  syncEngineeringSkills();   // reshape Engineering skills per the house rule
  syncEWSkill();             // add/remove Computer: Electronic Warfare per the EW rule
  syncNoRecoilText();        // retarget the recoil-gear effect text per the Recoil rule (#61)
  const warnings = [], errors = [];
  /* Creation rules stop applying at Finalize — budgets are spent and a play
   * character is allowed to have drifted from them. But some of those checks
   * describe states that stay illegal at the table whatever the budget says:
   * what is installed in your body (augment conflicts, tiers, Body Index), a
   * martial art outranking your Unarmed Combat, and cash you don't have.
   * Those are pushed here too and are the only ones `calculate` reports once
   * `finalized` is true.
   *
   * Deliberately NOT mirrored: anything the sheet already surfaces better on
   * its own — overloaded mounts and the magic/Amp OFFLINE state both have
   * dedicated read-outs and would only read as a second copy here.
   *
   * Decks and rigs mirror everything they check (see priceDecking): none of it
   * is a budget rule, all of it is "this hardware does not work", and the
   * slotted-program dropdown means the state is reachable during play rather
   * than merely inherited from chargen. */
  const playErrors = [], playWarnings = [];

  const priorities = resolvePriorities(character, data, warnings, errors);
  const magicType = priorities.magic_type;

  const heritage = applyHeritage(character, data, warnings, errors);
  if (finalized) {
    heritage.zoetic_potential += toInt(asNumber(
      (character.play || {}).zp_advances));
  }
  const augments = tallyAugments(character, data, warnings, errors, playErrors);
  mergeMountedAugments(augments,
                       tallyMountedAugments(character, data, warnings, errors));
  // Skill Bonus / Skill Note from every owned source, folded in here because
  // `augments` is already where scoreSkills reads bonuses and notes from.
  const gearSkills = gearSkillEffects(character, data, warnings);
  mergeSkillEffects(augments, gearSkills);
  const amp = tallyAmpPowers(character, data, magicType, warnings, errors);

  let replicantAttrBonus = 0, replicantSkillBonus = 0;
  if (character.heritage.type === "Replicant") {
    replicantAttrBonus = REPLICANT_BONUS_ATTRIBUTE_POINTS;
    replicantSkillBonus = REPLICANT_BONUS_SKILL_POINTS;
  }

  // Spirits placed in infusion slots (play only). Resolved BEFORE attributes are
  // scored so a temporary attribute boost flows through every derived stat --
  // pools, initiative, condition tracks, melee damage -- instead of being
  // bolted on afterwards. The attribute POINT BUDGET is unaffected: scoreAttributes
  // computes points spent from the character's own base levels, never from
  // adjustments, which is exactly how heritage/augment/amp bonuses already work.
  const infusions = finalized ? resolveInfusions(character, data)
                              : { list: [], mods: infusionStatMods([]) };

  const attributeScoring = scoreAttributes(
    character, data, priorities.starting_attr_pts + replicantAttrBonus,
    heritage, augments, amp, warnings, errors, infusions.mods.attributes);
  const finalAttributes = attributeScoring.final;

  const pools = computePools(finalAttributes, character.cha_pool_choice || "Brawn");
  // Permanent Kismet-die major boons add to a pool (finalized play only).
  if (finalized && character.play && character.play.pool_kismet) {
    for (const [pool, n] of Object.entries(character.play.pool_kismet)) {
      // Key-checked and non-negative: a boon adds dice, it never takes them.
      if (pool in pools) pools[pool] += Math.max(0, toInt(asNumber(n)));
    }
  }
  // Flat infusion pool bonuses (attribute boosts already went in above, via
  // scoreAttributes, so they're baked into these pool totals already).
  for (const [pool, n] of Object.entries(infusions.mods.pools)) {
    if (n && pool in pools) pools[pool] += n;
  }

  const skillScoring = scoreSkills(character, heritage, amp, augments, warnings, errors, playErrors);
  skillScoring.points.budget = priorities.starting_skill_pts + replicantSkillBonus;
  skillScoring.points.remaining =
    skillScoring.points.budget - skillScoring.points.spent;
  if (skillScoring.points.remaining < 0) {
    errors.push(`Skill points overspent by ${-skillScoring.points.remaining}.`);
  }

  // Bonus skill dice from deployed drones (shown as "rank+Nd"), plus a
  // Synthetic's Specialization pool — a die on every skill in it rather than a
  // point in each.
  const skillDice = droneSkillDice(character, data);
  if (heritage.specialization_pool) {
    for (const [name, [pool]] of Object.entries(SKILLS)) {
      if (pool === heritage.specialization_pool)
        skillDice[name] = (skillDice[name] || 0) + 1;
    }
  }
  // A switched-on sense belongs in this layer rather than in amp.skill_bonus:
  // it's a bonus die you have right now because you spent an action, exactly
  // like a deployed drone's, not a permanent part of the skill's rating. Off
  // again and the dice go with it (#42).
  const senseToggles = activatableSenses(character, data);
  for (const sense of senseToggles) {
    if (sense.active && sense.skill && sense.dice) {
      skillDice[sense.skill] = (skillDice[sense.skill] || 0) + sense.dice;
    }
  }
  for (const [name, dice] of Object.entries(skillDice)) {
    if (skillScoring.skills[name]) skillScoring.skills[name].dice_bonus = dice;
  }

  // Read straight off the character rather than off priced armor, so this stays
  // independent of where priceArmor sits in this function.
  const etiquetteMods = etiquetteModifiers(character, data);
  const knowledgeScoring = scoreKnowledgeSkills(
    character, finalAttributes.Intelligence, finalAttributes.Charisma,
    augments.knowledge_points_bonus, warnings, errors, etiquetteMods.adjust);
  const knowledge = knowledgeScoring.knowledge;
  const etiquettePoints = knowledgeScoring.etiquettes;

  const boostedInt = (augments.attribute_adjustment.Intelligence
                      + amp.attribute_adjustment.Intelligence);
  const boostedCha = (augments.attribute_adjustment.Charisma
                      + amp.attribute_adjustment.Charisma);
  if (boostedInt > 0 && knowledge.remaining > 0) {
    warnings.push(`An augment/power raised Intelligence (+${boostedInt}): your Knowledge `
                  + `pool grew — ${knowledge.remaining} point(s) unspent on the `
                  + "Knowledge & Etiquette tab.");
  }
  if (boostedCha > 0 && etiquettePoints.remaining > 0) {
    warnings.push(`An augment/power raised Charisma (+${boostedCha}): your Etiquette `
                  + `pool grew — ${etiquettePoints.remaining} point(s) unspent on the `
                  + "Knowledge & Etiquette tab.");
  }

  const magicBudget = budgetMagic(character, data, magicType, warnings, errors);

  const bodyIndexOk = augments.body_index <= finalAttributes.Body;
  if (!bodyIndexOk) {
    errors.push("Too Many Biomods: Body Index exceeds Body.");
    playErrors.push("Too Many Biomods: Body Index exceeds Body.");
  }

  // Small-heritage surcharge applies to physical kit only (see surchargeFor):
  // Weapons, Armor, Vehicles and cybertechtronic Augments pay it; Bioware,
  // Drones, Rigs, Decks/Programs, Gear and Lifestyle pay face value.
  const gearCostMultiplier = heritage.gear_cost_multiplier;
  // Extra Arm / Extra Leg surcharge armor only, on top of any small-heritage one.
  const armorCostMultiplier = heritage.armor_cost_multiplier || 1;
  // Every augment that is actually live right now: body augments plus mounted
  // ones whose host is worn (tallyMountedAugments drops the rest).
  const activeAugmentNames = new Set(augments.rows.map(([row]) => row.Name));
  const weapons = priceWeapons(character, data,
    surchargeFor("weapon", gearCostMultiplier), warnings, finalAttributes.Strength, errors,
    activeAugmentNames, playWarnings);
  const armor = priceArmor(character, data,
    surchargeFor("armor", gearCostMultiplier) * armorCostMultiplier, warnings);
  // What you have on right now stays worth flagging in play, so these three go
  // to playWarnings as well.
  const wornWarning = message => { warnings.push(message); playWarnings.push(message); };
  if (heritage.traits.some(row => row.Name === "Tough")
      && armor.items.some(item => item.Slot === "Under" && item.active)) {
    wornWarning("Tough (Blighted boon) occupies the Under armor slot — "
                + "it doesn't stack with a worn Under armor piece.");
  }
  const helmetWorn = armor.items.some(item => item.Armor === "Helmet" && item.active);
  if (heritage.has_antlers && helmetWorn) {
    wornWarning("Antlers (Green bane): cannot wear helmets or headgear.");
  }
  // A Helmet sits in its own armor slot ("Outer*"), so it doesn't count against
  // the one-Outer-piece rule the way a coat does — but it covers the same head
  // and face as Arwin Goggles, and the two can't be worn together.
  if (helmetWorn && (character.gear || []).some(
        g => g.name === HEAD_MOUNTED_GEAR && g.carried !== false)) {
    wornWarning(`A Helmet and ${HEAD_MOUNTED_GEAR} can't both be worn — `
                + "take one off, or mount the goggles' augments in the helmet.");
  }
  const internalSlotOccupants = [...augments.internal_armor_slot_items];
  if (amp.powers_taken.has("Aspect of the Chelonian")) {
    internalSlotOccupants.push("Aspect of the Chelonian");
  }
  if (internalSlotOccupants.length > 1) {
    wornWarning("Internal armor slot conflict: "
                + internalSlotOccupants.join(", ")
                + " all occupy the internal armor slot.");
  }
  // Identical duplicates stack — buying two of a thing is the player's call —
  // but a repeat is far more often a double-add than a deliberate pair, so each
  // repeated row gets one nudge. Armor warns per slot in priceArmor instead,
  // where "active" is what decides whether the copies actually sum.
  const warnDuplicates = (label, names) => {
    const seen = new Set(), reported = new Set();
    for (const name of names) {
      if (!name) continue;
      if (seen.has(name) && !reported.has(name)) {
        warnings.push(`${label} ${name} is listed more than once — the copies stack.`);
        reported.add(name);
      }
      seen.add(name);
    }
  };
  warnDuplicates("Deck", character.decks.map(d => d.name));
  warnDuplicates("Program", character.programs);
  warnDuplicates("Gear", (character.gear || []).map(g => g.name));

  const decking = priceDecking(character, data, 1, warnings, errors,
                               playWarnings, playErrors);
  const rig = priceRig(character, data, 1, warnings, errors,
                       playWarnings, playErrors);
  // priceDronesAndVehicles applies the surcharge to vehicles only (drones pay
  // face value) — it splits internally, so it takes the raw multiplier.
  const vehicles = priceDronesAndVehicles(character, data, gearCostMultiplier, warnings, errors);
  const misc = priceMiscGearAndLifestyle(character, data, 1,
                                         augments.has_hyperthyroid);
  // Cybertechtronic augments are surcharged; Bioware pays face value.
  const cyberAugmentCost = augments.cost - augments.bioware_cost;
  const augmentCost = round2(augments.bioware_cost
    + cyberAugmentCost * surchargeFor("cyberware", gearCostMultiplier));

  // --- Zoetic bookkeeping ---------------------------------------------------
  const isSynthetic = character.heritage.type === "Synthetic";
  const augmentZr = isSynthetic ? 0.0 : round2(augments.zoetic_rating);
  const gearZr = round2(gearZoeticRating(character, data));
  const zrTotal = round2(augmentZr + gearZr);
  const hasAmpPowers = amp.powers_taken.size > 0;
  const houseZr = houseRule("zr") === "houserule";
  // House rule: cyber ZR reduces ZP directly and always (may go negative); gear
  // ZR does NOT touch ZP (it penalises casting instead). Classic: total carried
  // ZR counts against ZP only when amp powers are taken.
  const zpRemaining = round2(heritage.zoetic_potential - amp.spent
    - (houseZr ? augmentZr : (hasAmpPowers ? zrTotal : 0)));
  // House rule: ZP at exactly 0 is still spendable -- only going NEGATIVE
  // (cyber ZR + Amp spending outrunning the budget) takes magic offline.
  const magicOffline = houseZr && magicType !== "Hedge" && zpRemaining < 0;
  // Classic: Amp powers go offline at ZP ≤ 0, driven by total carried ZR (gear
  // included -- that's the classic rule, gear ZR counts against ZP the same as
  // cyber ZR does). ZR Casting Penalty house rule: Amp powers have NO offline
  // state of their own -- gear ZR only ever penalises casting rolls (below),
  // never ZP, and cyber ZR/Amp overspend outrunning ZP already shuts everything
  // down through the shared magicOffline banner above.
  const ampOffline = houseZr ? false : (hasAmpPowers && zpRemaining <= 0);
  if (magicOffline) {
    warnings.push("Magic OFFLINE: Zoetic Potential has gone negative (cyber ZR "
      + "+ Amp spending). Spells, Amps and Summoning are unavailable — only Rituals remain.");
  } else if (ampOffline) {
    warnings.push("Amp powers OFFLINE: ZP is 0 or less — Amp ZP spent plus "
                  + "carried ZR exceeds Zoetic Potential.");
  }
  // House rule: each full point of gear/weapon ZR is a −1d penalty on casting
  // rolls (Channeling, Conjuring, Sorcery), surfaced as a note on those skills.
  if (houseZr && magicType !== "Hedge") {
    const castPenalty = Math.floor(gearZr);
    if (castPenalty > 0) {
      for (const sk of ["Channeling", "Conjuring", "Sorcery"]) {
        const s = skillScoring.skills[sk];
        if (s && (s.points > 0 || s.final > 0))
          s.notes = [...(s.notes || []), `−${castPenalty}d on casting rolls (gear/weapon ZR ${gearZr})`];
      }
    }
  }

  const cashCategories = {
    "Weapons/Armor": round2(weapons.cost + armor.cost),
    "Augments": augmentCost,
    "Drones/Vehicles/Rigs": round2(vehicles.cost + rig.cost),
    "Decks and Programs": round2(decking.cost),
    "Gear": round2(misc.gear_cost),
    "Lifestyle": round2(misc.lifestyle_cost),
  };
  const cashSpent = round2(Object.values(cashCategories).reduce((a, b) => a + b, 0));
  const cashRemaining = round2(priorities.starting_cash - cashSpent);
  if (cashRemaining < 0) {
    errors.push(`Cash overspent by ${currencySymbol()}${Math.round(-cashRemaining).toLocaleString("en-US")}.`);
  }
  /* The creation budget is a record of what the BUILD cost. Live figures while
   * a character is in chargen; frozen at the last Finalize once they're in
   * play, so selling a rifle at the table doesn't make creation look cheaper.
   * A pre-2026-08-05 character has no snapshot and reads live until
   * ensureCreationBudget() takes one. */
  const creationBudgetFigures = () => {
    const frozen = finalized && (character.play || {}).creation_budget;
    if (frozen && typeof frozen === "object") {
      return { starting_cash: asNumber(frozen.starting_cash),
               categories: frozen.categories || {},
               spent: asNumber(frozen.spent),
               remaining: asNumber(frozen.remaining) };
    }
    return { starting_cash: priorities.starting_cash, categories: cashCategories,
             spent: cashSpent, remaining: cashRemaining };
  };
  // In play the creation budget stops meaning anything — purchases are paid out
  // of play.cash, which the sheet lets you overdraw past a confirm. That, not
  // `cashRemaining`, is the balance that has to add up at the table.
  const playCash = asNumber((character.play || {}).cash);
  if (finalized && playCash < 0) {
    playErrors.push(`Overdrawn by ${currencySymbol()}${Math.round(-playCash).toLocaleString("en-US")}.`);
  }

  // Every character must live somewhere: at least one prepaid month of a lifestyle.
  const hasLifestyle = (character.lifestyles || []).some(ls => (Number(ls.months) || 0) >= 1)
    || (character.lifestyle && character.lifestyle.name && (Number(character.lifestyle.months) || 0) >= 1);
  if (!hasLifestyle) {
    errors.push("Choose a lifestyle with at least 1 prepaid month.");
  }

  const combat = deriveCombatStats(
    heritage, finalAttributes, augments, amp,
    weapons.weight, armor.weight, misc.gear_weight,
    augments.zoetic_rating_raw,
    armor.ballistic_armor, armor.impact_armor,
    armor.ballistic_armor_max);

  // Bling's etiquette rider, collapsed to the best single source per etiquette
  // — a blinged gun and a blinged ride are one look, not two bonuses.
  combat.bling_etiquette = blingEtiquette(character, data);

  // Fold infusion armor / movement into the derived combat stats, and name the
  // spirit in armor_sources so the Overview shows where it came from.
  if (infusions.mods.ballistic || infusions.mods.impact) {
    combat.ballistic_armor += infusions.mods.ballistic;
    combat.impact_armor += infusions.mods.impact;
    for (const e of infusions.list) {
      const own = infusionStatMods([e]);
      if (own.ballistic || own.impact) {
        combat.armor_sources.push({ name: `${e.spirit} (${e.slot} infusion)`,
                                    b: own.ballistic, i: own.impact });
      }
    }
  }
  if (infusions.mods.move) combat.move += infusions.mods.move;

  const martialArtsList = resolveMartialArts(character, data);
  const martialArt = aggregateMartialArts(martialArtsList);   // combined, for combat consumers
  const initiative = deriveInitiative(pools, finalAttributes, heritage, augments, amp,
                                      martialArt, data);
  // A deployed drone's countable riders are real: its Initiative dice join the
  // roll, and its prose riders (dodge rerolls, mobile cover) ride along as
  // notes for the sheet to place (issue #38).
  const droneBonus = droneCombatBonuses(character, data);
  if (droneBonus.initiative_dice) {
    initiative.dice += droneBonus.initiative_dice;
    initiative.notes.push(`Drones: +${droneBonus.initiative_dice}d`);
  }
  combat.drone_dodge_notes = droneBonus.dodge_notes;
  combat.drone_cover_notes = droneBonus.cover_notes;
  // Riders that aren't a stat and aren't cover — a light source, a flight
  // ceiling, a stealth penalty imposed on whoever is looking for the drone.
  combat.drone_other_notes = droneBonus.other_notes;
  // Every sense the character has right now, from whichever table grants it.
  // Deliberately NOT folded into optics_notes: that list is the handful of
  // augments that change firearm accuracy and range, which is a different
  // question from what this one answers.
  combat.senses = deriveSenseNotes(character, data, heritage, augments,
                                   droneBonus.vision_notes);
  // Senses that need an action before they do anything, with whether they're on
  // — the sheet renders the Activate control from this.
  combat.sense_toggles = senseToggles;
  const poolEffects = derivePoolEffects(character, data, heritage, augments, amp);
  const poolNotes = derivePoolNotes(heritage, augments, amp, martialArt, poolEffects);
  // Name the spirit behind each pool bonus that was folded in above, so the
  // number and its reason sit together.
  for (const a of infusions.mods.applied) {
    const m = a.text.match(/^\+(\d+)\s+(\w+)\s+Pool$/);
    if (m && poolNotes[m[2]]) poolNotes[m[2]].push(`+${m[1]} (${a.source} infusion)`);
  }

  const combatOut = {};
  for (const [k, v] of Object.entries(combat)) {
    if (k !== "physical" && k !== "stun") combatOut[k] = v;
  }
  combatOut.exploit_actions = deriveExploitActions(character, data, magicType, augments, amp);
  // Standing cover from martial-art levels, full-cover infusions AND a deployed
  // drone that provides it, merged into a single best-wins value. Cover is a
  // state rather than a stack, so Gun-Kata L5's High cover is superseded by a
  // full-cover infusion rather than adding to it — and a Shield-Wall Drone's
  // High cover is the same tier as the martial art's, not another −2d on top.
  // Reported on the Dodge card; there's no cover stat to apply it to.
  combatOut.cover = bestCover([...(martialArt.mods.cover || []),
                               ...(infusions.mods.cover || []),
                               ...(droneBonus.cover_grants || [])]);

  // Apply the martial art's stat modifiers (gated by Martial Arts rank via the
  // cumulative levels resolved above) on top of heritage/augment bonuses.
  const maMods = martialArt.mods;
  combatOut.dodge_bonus += maMods.dodge_bonus;
  combatOut.soak_bonus += maMods.soak_bonus;
  // Per-gun recoil capacity: the character's own figure plus whatever is bolted
  // to that particular weapon. Melee and thrown weapons have no recoil to
  // absorb, so they get no rating rather than a meaningless one — a Katana
  // reading "Recoil 3" would be noise on every melee character's sheet.
  for (const item of weapons.items) {
    if (item.Type === "Melee" || item.Type === "Thrown") continue;
    item.recoil_ignored = Boolean(maMods.recoil_ignored) && recoilIgnoredForWeapon(item);
    item.Recoil = combatOut.recoil_capacity + toInt(item.recoil_mod);
  }
  combatOut.move += maMods.move_bonus;
  // Kept as a flag for the summary line, but it is no longer a blanket "this
  // character never suffers recoil" — Gun-Kata steadies pistols and SMGs, and
  // the per-weapon rows above are what decide which guns that reaches.
  if (maMods.recoil_ignored) {
    combatOut.recoil_ignored = 1;
    combatOut.recoil_ignored_types = RECOIL_IGNORED_TYPES_LABEL;
  }
  /* "No Recoil" (#61): the character-wide half of the bonus dice that replace
   * recoil compensation — the Gyromount augment and Gun-Kata 3. Empty under the
   * Classic rule, so nothing downstream needs to branch. The per-gun half (a
   * Bi-pod, Gyro-mount or Gas Vent bolted to one weapon) stays with the weapon
   * and is joined to these by noRecoilBonuses(). */
  combatOut.no_recoil_sources = noRecoilCharacterSources(augments, martialArt);
  combatOut.martial_notes = maMods.applied;
  // Natural / implanted / power-granted melee weapons for the Overview loadout,
  // plus heritage bite/spit attacks (Shark, Snake).
  combatOut.granted_weapons = [
    ...collectGrantedWeapons(augments, amp, finalAttributes.Strength, maMods),
    ...heritageNaturalWeapons(heritage, character, finalAttributes.Strength),
  ];
  // Heavy Torso / No Head free-mount gear (weapons + extra limbs) for the loadout.
  combatOut.trait_gear = heritage.trait_gear || [];
  // Hands to hold a weapon in -- see applyHeritage's hand_count. A play-mode
  // manual override (play.hand_override) takes priority when set; read it
  // through handCount() rather than this field directly.
  combatOut.hand_count = heritage.hand_count || HAND_COUNT_BASE;

  // Per-source breakdowns so the Combat box can show where each Soak/Dodge die
  // comes from — every contributing source in one place (the sweep).
  const hasPsa = amp.powers_taken.has("Perfect Situational Awareness");
  const fmtSrc = list => list.filter(([, d]) => d).map(([label, d]) => `${label} +${d}`);
  combatOut.soak_sources = fmtSrc([
    ["Heritage", heritage.soak_bonus],
    ["Perfect Situational Awareness", hasPsa ? PERFECT_SITUATIONAL_AWARENESS_BONUS : 0],
    [martialArt.style || "Martial art", maMods.soak_bonus],
  ]);
  combatOut.dodge_sources = fmtSrc([
    ["Heritage", heritage.dodge_bonus],
    ["Augments", augments.dodge_bonus],
    ["Perfect Situational Awareness", hasPsa ? PERFECT_SITUATIONAL_AWARENESS_BONUS : 0],
    [martialArt.style || "Martial art", maMods.dodge_bonus],
  ]);

  // Some sources zero out condition-track wound penalties (Pain Nullifier
  // augment, the Shibumi martial art, …). Detect data-driven: any effect text
  // that both mentions "wound penalt(y)" and a removal verb.
  // A live dose counts too. Dorf's whole selling point is exactly this, and it
  // never worked: `misc_gear` was not one of the tables scanned, so the text
  // said "ignore wound penalties" and nothing read it. It is deliberately the
  // DOSE and not the carried item — a painkiller in your pocket kills no pain —
  // which is the same rule the medkits' Biotech dice already follow.
  const removesWoundPenalty = text =>
    /wound penalt/i.test(text) && /(remove|ignore|negat|nullif|zero|no\b)/i.test(text);
  const doses = liveDoseRows(character, data);
  combatOut.wound_penalty_negated =
    augments.rows.some(([row]) => removesWoundPenalty(row.Effect || row.Description || ""))
    || martialArt.levels.some(lvl => removesWoundPenalty(lvl.Effect || ""))
    || heritage.traits.some(row => removesWoundPenalty(row.Effects || ""))
    || doses.some(row => removesWoundPenalty(row.Effect || ""));

  // Others double them — the Reaction Enhancer bioware ("+N Reaction but
  // doubles pain-based penalties") trades pain tolerance for reflexes. Scanned
  // the same data-driven way, so homebrew worded alike behaves alike. Negation
  // wins over doubling: twice nothing is still nothing.
  const doublesWoundPenalty = text =>
    /doubl/i.test(text) && /(wound|pain)[- ]?(based )?penalt/i.test(text);
  const doublingSource =
    augments.rows.find(([row]) =>
      doublesWoundPenalty(row.Effect || row.Description || ""))?.[0]?.Name
    || martialArt.levels.find(lvl => doublesWoundPenalty(lvl.Effect || ""))?.Style
    || heritage.traits.find(row => doublesWoundPenalty(row.Effects || ""))?.Name
    // Doses cut both ways. No shipped drug doubles wound penalties today, but
    // the pair is scanned identically everywhere else and a homebrew drug that
    // says so should behave, rather than being silently ignored because only the
    // flattering half of the mechanic was wired up.
    || doses.find(row => doublesWoundPenalty(row.Effect || ""))?.Item
    || "";
  combatOut.wound_penalty_doubled = !combatOut.wound_penalty_negated && !!doublingSource;
  combatOut.wound_penalty_doubled_by = combatOut.wound_penalty_doubled ? doublingSource : "";

  return {
    priorities: {
      values: priorities.values, remaining: priorities.remaining,
      magic_type: magicType, magic_priority_label: priorities.magic_priority_label,
      starting_attr_pts: priorities.starting_attr_pts,
      starting_skill_pts: priorities.starting_skill_pts,
      starting_cash: priorities.starting_cash,
      allowed_heritages: priorities.allowed_heritages,
    },
    attributes: attributeScoring.attributes,
    attr_points: attributeScoring.points,
    pools,
    skills: skillScoring.skills,
    ritual_skills: skillScoring.ritual_skills,
    skill_points: skillScoring.points,
    knowledge,
    etiquette_points: etiquettePoints,
    // Named sources behind etiquettePoints.adjust, for the UI to attribute them.
    etiquette_sources: etiquetteMods.sources,
    magic: {
      type: magicType,
      start_force: magicBudget.start_force,
      force_spent: magicBudget.force_spent,
      force_remaining: magicBudget.force_remaining,
      amp_zp_budget: heritage.zoetic_potential,
      amp_zp_spent: round2(amp.spent),
      amp_zp_remaining: round2(heritage.zoetic_potential - amp.spent),
      infusion_pts: magicBudget.infusion_pts,
      relationship_pts: magicBudget.relationship_pts,
    },
    /* Speaker practice AFTER applyPlayAdvances has folded in what Kismet
     * bought. character.speaker is chargen-owned, so a play purchase never
     * reaches it — it accumulates in play.bond_advances / speaker_infusions /
     * speaker_relationships and is merged onto this copy. Anything displaying
     * a finalized character's bonds, infusions or relationships must read this
     * and never CHAR.speaker, or play purchases go invisible. */
    speaker: character.speaker,
    zoetics: { zp: heritage.zoetic_potential,
               ghost_rating: (character.play && character.play.ghost_rating) || GHOST_RATING_DICE,
               zp_remaining: zpRemaining,
               amp_zp_spent: round2(amp.spent),
               augment_zr: augmentZr,
               gear_zr: gearZr,
               zr_total: zrTotal,
               amp_offline: ampOffline,
               magic_offline: magicOffline,
               cyber_zr: round2(augments.zoetic_rating),
               amp_zr: round2(amp.spent),
               // Gear-mounted augments: ZR exempt from ZP by design; the
               // errors are mirrored here because `errors` is blanked once
               // the character is finalized and play mode must still show them.
               mounted_zr: round2(augments.mounted_zr || 0),
               mount_errors: augments.mount_errors || [],
               body_index: round2(augments.body_index),
               body_index_ok: bodyIndexOk },
    condition: { physical: combat.physical, stun: combat.stun },
    combat: combatOut,
    initiative,
    pool_notes: poolNotes,
    // Everything the build could switch on for extra (or fewer) pool dice.
    // Enumerated, never applied — see derivePoolEffects.
    pool_effects: poolEffects,
    // Spirits currently placed in infusion slots: the resolved list plus which
    // of their effects were folded into the numbers and which stay situational.
    infusions: infusions.list,
    infusion_mods: infusions.mods,
    weapons: weapons.items,
    armor: armor.items,
    drones: vehicles.drones,
    vehicles: vehicles.vehicles,
    martial_art: martialArt,        // aggregate (combined styles) — combat consumers
    martial_arts: martialArtsList,  // per-style list — UI display / editing
    // Frozen at Finalize for a finalized character (see play.creation_budget) —
    // what the build cost, not what the kit is worth today. The multipliers
    // stay live: they price what play buys now.
    budget: { ...creationBudgetFigures(),
              gear_cost_multiplier: gearCostMultiplier,
              armor_cost_multiplier: armorCostMultiplier },
    warnings: finalized ? playWarnings : warnings,
    errors: finalized ? playErrors : errors,
  };
}

return {
  calculate,
  defaultCharacter,
  mergeDefaults,
  validateCharacterShape,
  // exposed for the UI and tests
  asNumber, loadData,
  APP_VERSION, inspectCharacterFile, unresolvedCharacterRefs, characterNameRefs,
  etiquetteModifiers, parseEtiquetteBonuses,
  ATTRIBUTES, SKILLS, TRAINED_ONLY_SKILLS, ETIQUETTES, POOL_NAMES,
  MAGIC_TYPE_BY_PRIORITY, MAGIC_TYPES_ALLOWED_BY_PRIORITY,
  SPELL_FORCE_MAX, SKILL_RANK_CAP, HACKING_RATING_COST, HACKING_RATING_MAX,
  GHOST_RATING_DICE,
  weaponIntegratedMods, weaponIsOneshot, ONESHOT_NOTE, weaponHands,
  BASE_RECOIL_CAPACITY, recoilStrengthBonus, recoilIgnoredForType, cybergunRecoil,
  recoilInPlay, noRecoilBonuses, actionRefHidden, weaponTypeIs,
  gearIsDose, gearMaxDoses, liveDoseRows,
  rigStats, applyExtendedMagazine, meleeDamage, isStrengthDamage,
  meleeDamageIsComputable, assignWeaponModSlots, bowRating,
  weaponBaseCost, weaponModCost, weaponModCostPercent,
  DEFAULT_HARDENING, hardeningOf,
  WILDLING_EFFECT_ID, WILDLING_BEAST_DICE, parsePoolDice,
  mountCapability, mountRefusal, augmentEffZr, augmentEffCost, augmentQualityMultiplier,
  UNIT_ATTACHMENT_TABLES,
  augmentLimbRequirement, augmentMeleeDamage, augmentTier, augmentStacks,
  augmentRaisesMax, isCybergunAugment, cybergunReloadable,
  weaponSkillName,
  specTerms, specTermMatchesWeapon, classifySpecTerms, weaponSpecAdjust,
  FIRING_MODES, weaponFiringModes, firingMode, parseFiringMode,
  ammoFitsUnitWeapon,
  ammoStatMods, applyAmmoStats, applyAmmoToRow, ammoFiringModes,
  ammoFitsWeapon, AMMO_FITS,
  HOUSE_RULE_DEFS, houseRule, setHouseRule, currencyName, currencySymbol,
  recoilIgnoredForWeapon,
  programSkill, isEWProgram, hackActionSkill, programNeedsThread,
  HACKING_SKILL, programRating, programActionUnits,
  HACKING_PROGRAM_CATEGORY, isHackingProgram, hackingProgramRating, deckHackingRequired,
  BASE_HACK_RANGE_METERS, deckHackRange, deckRangeConflict,
  deckHardening, rigUnitHardening, hardeningBonusFromText,
  SUMMON_SPELLS, isSummonSpell, isFormSpell, shapeshiftState, summonedAnimal,
  spellDrain, drainIsLethal, DRAIN_SPECIAL,
  drainSoakOrder, fetishesForSpell,
  equippedDeckName,
  SPEAKER_BOND_MAX, speakerBondCount,
  HAND_COUNT_BASE, HAND_COUNT_MAX, handCount,
  KIT_CATEGORIES, applyPlayAdvances,
  VEHICLE_CONDITIONS, VEHICLE_CONDITION_FACTORS, VEHICLE_CONDITION_EFFECTS,
  surchargeFor,
};

})();

if (typeof module !== "undefined") module.exports = RULES;
