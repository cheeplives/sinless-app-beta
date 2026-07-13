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
 * Magic in play:
 *   spells cost their listed Cost in zuzus PER FORCE to learn or advance
 *   ZP advances cost Kismet (assumed: same tier costs as attributes) and
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
  "Gain 3d6 × 4,000ㄓ in cash or gear of rarity 4 or less",
];

/* Roll a single die and any `NdM` dice-expressions embedded in a string,
 * substituting each with its rolled total (honouring a trailing ×K / × K,KKK
 * multiplier). "Gain 3d6×10 Techtronics" -> "Gain 90 Techtronics". */
function rollDie(sides) { return Math.floor(Math.random() * sides) + 1; }
function rollDiceInText(text) {
  return String(text).replace(
    /(\d+)d(\d+)(?:\s*[×x*]\s*([\d,]+))?/gi,
    (_m, n, sides, mult) => {
      let total = 0;
      for (let i = 0; i < +n; i++) total += rollDie(+sides);
      if (mult) total *= parseInt(mult.replace(/,/g, ""), 10);
      return total.toLocaleString();
    });
}

const HACKING_RATING_COST = 5000;    // per level; deck needs rating ≥ ½ MCP (min 1)
const HACKING_RATING_MAX = 6;
const SPELL_FORCE_MAX = 6;           // spells are learned/advanced to Force 6 at most

/* Weapon Type -> the skill you roll to use it (everything else is Firearms) */
const WEAPON_SKILL_BY_TYPE = {
  Melee: "Melee Weapons",
  Thrown: "Throwing Weapons",
  GrenadeLauncher: "Heavy Weapons",
};
function weaponRoll(type) {
  const skill = WEAPON_SKILL_BY_TYPE[type] || "Firearms";
  const s = CALC.skills[skill] || {};
  const pool = s.pool || "Finesse";
  const rating = s.final > 0 ? s.final
    : s.group_value != null ? `grp ${s.group_value}` : "untrained";
  return `Roll ${pool} ${CALC.pools[pool]}d · ${skill} ${rating}`;
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
let playSaveTimer = null;

/* ------------------------------------------------ play-state plumbing */
function ensurePlay() {
  const d = {
    cash: 0, cash_rolled: false, starting_cash: 0, cash_log: [],
    lifestyles: [], lifestyles_seeded: false, armor_worn: null,
    kismet: 0, kismet_earned: 0, kismet_log: [],
    boons_spent: 0, major_boons_spent: 0,
    physical_damage: 0, stun_damage: 0, initiative: 0,
    pool_used: {},                        // pool name -> dice spent from the pool
    pool_boost: {},                       // pool name -> temporary bonus dice
    pool_kismet: {},                      // pool name -> permanent Kismet-die boons
    effects: [], modifiers: [], notes: "",
    attribute_advances: {}, skill_advances: {},
    zp_advances: 0, spell_force_advances: {},
    purchases: { gear: [], augments: [], amp_powers: [], spells: [], hacking_levels: 0 },
    decking: { active_deck: "", loaded: [] },
    rigging: { active_rig: "", units: {} },
    infusion_spirits: {},                 // infusion slot -> spirit placed in it
    bond_slots: [],                       // [{ spirit, favors }] spirits placed in bonds
  };
  CHAR.play = CHAR.play || {};
  for (const [k, v] of Object.entries(d)) {
    if (CHAR.play[k] == null) CHAR.play[k] = v;
    else if (v && typeof v === "object" && !Array.isArray(v)
             && CHAR.play[k] && typeof CHAR.play[k] === "object")
      for (const [k2, v2] of Object.entries(v))
        if (CHAR.play[k][k2] == null) CHAR.play[k][k2] = v2;
  }
  return CHAR.play;
}
function schedulePlaySave() {
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
  CHAR.play.kismet_log.unshift({ label, delta: n });
}
function spendKismet(label, n) {
  if (CHAR.play.kismet < n) { alert(`Not enough Kismet (need ${n}, have ${CHAR.play.kismet}).`); return false; }
  CHAR.play.kismet -= n;
  CHAR.play.kismet_log.unshift({ label, delta: -n });
  return true;
}
function logCash(label, delta) {
  CHAR.play.cash += delta;
  CHAR.play.cash_log.unshift({ label, delta });
}

function seedLifestyles() {
  const play = CHAR.play;
  if (play.lifestyles_seeded) return;
  const prepaid = (CHAR.lifestyles && CHAR.lifestyles.length)
    ? CHAR.lifestyles
    : (CHAR.lifestyle && CHAR.lifestyle.name ? [CHAR.lifestyle] : []);
  prepaid.forEach((ls, i) =>
    play.lifestyles.push({ name: ls.name, months: ls.months || 0, active: i === 0 }));
  play.lifestyles_seeded = true;
}

function enterSheet() {
  ensurePlay();
  seedLifestyles();
  sheetTab = "overview";
  expandedPool = null;
  $("#app").hidden = true;
  $("#sheet").hidden = false;
  renderSheet();
  window.scrollTo(0, 0);
}
function exitSheet() {
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
    + "  • Everything bought in play (gear, augments, powers, spells, Hacking levels)\n"
    + `  • Zuzus beyond the original starting roll (back to ${fmt(play.starting_cash || 0)})\n`
    + "  • Damage, initiative, effects, modifiers, ledgers, and notes\n\n"
    + "The chargen build itself (attributes, skills, purchased gear) is untouched."))
    return;
  const keepRolled = play.cash_rolled;
  const keepStart = play.starting_cash
    || (play.cash_log.find(e => e.label.startsWith("Starting cash roll")) || {}).delta || 0;
  const rollEntry = play.cash_log.find(e => e.label.startsWith("Starting cash roll"));
  const wornSnapshot = play.armor_worn;
  CHAR.play = {};
  ensurePlay();
  CHAR.play.cash_rolled = keepRolled;
  CHAR.play.starting_cash = keepStart;
  CHAR.play.cash = keepStart;
  if (rollEntry) CHAR.play.cash_log = [rollEntry];
  if (Array.isArray(wornSnapshot)) {   // worn flags as they were at finalize
    CHAR.play.armor_worn = wornSnapshot;
    CHAR.armor.forEach((a, i) => { a.active = wornSnapshot[i] !== false; });
  }
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
  if (CALC.zoetics.amp_offline)
    notes.push(`AMP POWERS OFFLINE: ZP is ${CALC.zoetics.zp_remaining} — Amp ZP spent plus carried ZR exceeds your Zoetic Potential. Shed ZR or lose the powers.`);
  if (moveSpecial()) notes.push("Movement: " + moveSpecial());
  if ((CHAR.heritage.features || []).length)
    notes.push(`Heritage features: ${CHAR.heritage.features.join(", ")}.`);
  return notes;
}

/* ------------------------------------------------ shell */
function sheetTabList() {
  // Magic (everyone can learn rituals), Decking and Rigging are always shown so
  // a character can pick up a deck/rig/drone/vehicle in play even if they had
  // none at chargen.
  return [["overview", "Overview"], ["skills", "Skills"], ["kismet", "Kismet"],
    ["gear", "Gear"], ["magic", "Magic"], ["decking", "Decking"],
    ["rigging", "Rigging"], ["notes", "Notes"]];
}

function renderSheet() {
  const root = $("#sheet");
  root.innerHTML = "";
  root.append(sheetHeader());
  const body = el("div", { class: "sheet-body" });
  ({ overview: shOverview, skills: shSkills, kismet: shKismet, gear: shGear,
     magic: shMagic, decking: shDecking, rigging: shRigging, notes: shNotes })[sheetTab](body);
  root.append(body, sheetFooter());
}

function counterBtn(label, fn, cls) {
  return el("button", { class: "btn " + (cls || ""), onclick: fn }, label);
}

function sheetHeader() {
  const play = CHAR.play;
  const head = el("header", { class: "sheet-head" });

  const heritageLabel = CHAR.heritage.type
    + (CHAR.heritage.uplift_type ? ` (${CHAR.heritage.uplift_type})` : "");
  const activeLs = (play.lifestyles || []).find(l => l.active);
  const heritageAbilities = heritageAbilityLines();
  const ident = el("div", { class: "sh-ident" },
    el("div", { class: "sh-avatar" }, (CHAR.name || "?").slice(0, 1).toUpperCase()),
    el("div", {},
      el("div", { class: "sh-name" }, CHAR.name || "Unnamed"),
      CHAR.player ? el("div", { class: "sh-player" }, CHAR.player) : null,
      el("div", {},
        el("span", { class: "sh-tag" }, heritageLabel),
        el("span", { class: "sh-tag magic" }, CALC.magic.type),
        activeLs ? el("span", { class: "sh-tag", title: LIFESTYLE_EFFECTS[activeLs.name] || "" },
          `${activeLs.name} lifestyle · ${activeLs.months || 0} mo`) : null),
      activeLs && LIFESTYLE_EFFECTS[activeLs.name]
        ? el("div", { class: "sh-ls-effect" }, LIFESTYLE_EFFECTS[activeLs.name]) : null,
      heritageAbilities.length
        ? el("div", { class: "sh-heritage-abilities" },
            el("b", {}, "Abilities: "), heritageAbilities.join(" · ")) : null));

  // interactive pool tiles live up here — pools matter more than attributes
  const pools = el("div", { class: "sh-head-pools" },
    ...POOL_ORDER.map(headerPoolTile));

  const z = CALC.zoetics;
  const right = el("div", { class: "sh-meters" },
    el("div", { class: "sh-meter zoetic",
      title: `Zoetic Potential ${z.zp} − Amp ZP spent ${z.amp_zp_spent}`
        + (z.amp_zp_spent > 0 ? ` − carried ZR ${z.zr_total}` : "") },
      el("div", { class: "k" }, "ZP"),
      el("div", { class: "v", style: z.zp_remaining < 0 ? "color:var(--bad)" : "" },
        String(z.zp_remaining))),
    el("div", { class: "sh-meter zoetic",
      title: `Augment ZR ${z.augment_zr} + gear ZR ${z.gear_zr}`
        + (CHAR.heritage.type === "Synthetic" ? " (Synthetic: augment ZR untracked)" : "") },
      el("div", { class: "k" }, "ZR"),
      el("div", { class: "v" }, String(z.zr_total))),
    el("div", { class: "sh-meter zoetic", title: "Ghost Rating" },
      el("div", { class: "k" }, "Ghost"),
      el("div", { class: "v" }, z.ghost_rating || "2d6")),
    el("div", { class: "sh-meter cash", role: "button", tabindex: "0",
      title: "Adjust zuzus", onclick: adjustCash,
      onkeydown: e => { if (e.key === "Enter") adjustCash(); } },
      el("div", { class: "k" }, "Zuzus"),
      el("div", { class: "v" }, fmt(play.cash), el("span", { class: "plus" }, " +"))));

  // Freeform character description, sitting between identity and the meters.
  const descField = el("div", { class: "sh-desc" },
    el("textarea", { class: "sh-desc-input", placeholder: "Character description…",
      spellcheck: "true",
      oninput: e => { CHAR.description = e.target.value; schedulePlaySave(); } },
      CHAR.description || ""));

  // Top band: identity on the left, description in the middle, meters on the right.
  const top = el("div", { class: "sh-top" }, ident, descField, right);
  // Pool band: Save/Load/New on the left, then the four pool tiles as a single
  // 1×4 row travelling across to sit under the meters.
  const poolBar = el("div", { class: "sh-poolbar" }, sheetActions(), pools);

  const nav = el("nav", { class: "sh-tabs" });
  for (const [id, label] of sheetTabList()) {
    nav.append(el("button", {
      class: id === sheetTab ? "active" : "",
      onclick: () => { sheetTab = id; renderSheet(); window.scrollTo(0, 0); },
    }, label));
  }
  head.append(top, poolBar, nav);
  return head;
}

/* New / Load / Save on the sheet, mirroring the chargen rail. CHAR, recalc,
 * exitSheet, renderPanel and refreshLoadList are app.js globals. */
function sheetActions() {
  const saveBtn = el("button", { class: "btn", onclick: () => {
    if (!CHAR.name) { alert("Give the character a street name first."); return; }
    STORAGE.saveCharacter(CHAR);
    if (typeof refreshLoadList === "function") refreshLoadList();
    saveBtn.textContent = "Saved ✓";
    setTimeout(() => { saveBtn.textContent = "Save"; }, 1200);
  } }, "Save");
  const loadSel = el("select", { class: "btn-select", onchange: async e => {
    const name = e.target.value;
    if (!name) return;
    const loaded = STORAGE.loadCharacter(name);
    if (!loaded) { e.target.value = ""; return; }
    CHAR = RULES.mergeDefaults(loaded);
    await recalc();
    if (CHAR.finalized) renderSheet(); else { exitSheet(); renderTabs(); renderPanel(); }
  } }, el("option", { value: "" }, "Load…"),
    ...STORAGE.listCharacters().map(n => el("option", { value: n }, n)));
  const newBtn = el("button", { class: "btn ghost", onclick: async () => {
    if (!confirm("Start a new character? Unsaved changes are lost.")) return;
    CHAR = RULES.defaultCharacter();
    exitSheet(); renderTabs(); await recalc(); renderPanel();
  } }, "New");
  return el("div", { class: "sh-actions" }, saveBtn, loadSel, newBtn);
}

/* One pool tile in the header: shows dice remaining / max, lets the player
 * mark dice as spent (−), return one (+), or reset to full (↺), and lists
 * any bonus-dice notes (soak dice, Specialization, Adrenal Pump, …) from
 * CALC.pool_notes. Clicking the tile itself shows the pool's skills on the
 * Overview tab. */
function headerPoolTile(pool) {
  const play = CHAR.play;
  play.pool_boost = play.pool_boost || {};
  play.pool_kismet = play.pool_kismet || {};
  const kismetDice = Math.max(0, play.pool_kismet[pool] || 0);   // permanent, never removed
  const base = CALC.pools[pool];   // already includes permanent Kismet dice
  const boost = Math.max(0, play.pool_boost[pool] || 0);   // temporary bonus dice
  const max = base + boost;
  const used = Math.max(0, Math.min(play.pool_used[pool] || 0, max));
  const remaining = max - used;
  const setUsed = v => { play.pool_used[pool] = Math.max(0, Math.min(max, v)); playChanged(); };
  const setBoost = v => { play.pool_boost[pool] = Math.max(0, v); playChanged(); };
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
    el("div", { class: "sh-pool-boost", onclick: e => e.stopPropagation() },
      el("span", { class: "sub" }, "temp"),
      btn("−", () => setBoost(boost - 1), "Reduce temporary bonus dice"),
      el("b", { title: "Temporary bonus dice", style: boost ? "color:var(--ok)" : "" }, `+${boost}`),
      btn("+", () => setBoost(boost + 1), "Add temporary bonus dice")),
    ...notes.map(n => el("div", { class: "sh-pool-note" }, n)));
}

function adjustCash() {
  const raw = prompt("Adjust zuzus by (negative to spend):", "0");
  if (raw == null) return;
  const delta = parseInt(raw, 10);
  if (!Number.isFinite(delta) || !delta) return;
  const label = (prompt("Reason (optional):", "") || "Manual adjustment").trim() || "Manual adjustment";
  logCash(label, delta);
  playChanged();
}

function sheetFooter() {
  return el("div", { class: "sheet-foot" },
    el("button", { class: "btn ghost", onclick: backToChargen }, "← Back to Chargen"),
    el("button", { class: "btn warn", onclick: revertToChargenEnd }, "Revert to Post-Chargen"),
    el("button", { class: "btn", onclick: exportMarkdown }, "Export Markdown (Scabard)"),
    el("button", { class: "btn ghost", onclick: () => {
      const blob = new Blob([JSON.stringify(CHAR, null, 2)], { type: "application/json" });
      const a = el("a", { href: URL.createObjectURL(blob),
        download: (CHAR.name || "character") + ".json" });
      a.click();
    } }, "Export JSON"));
}
async function backToChargen() {
  if (!confirm("Return to character generation?\n\nChargen budgets become editable again. "
    + "Play state (damage, Kismet, notes, advances, purchases) is kept and returns when you re-finalize."))
    return;
  CHAR.finalized = false;
  schedulePlaySave();
  await recalc();
  exitSheet();
  renderTabs();
  renderPanel();
}

/* ------------------------------------------------ overview */
function shOverview(body) {
  const play = CHAR.play;
  const econ = kismetEcon();

  // dossier warnings (Replicant illegality, Amp powers offline, …)
  for (const note of dossierNotes().slice(0, 2))
    body.append(el("div", { class: "sh-callout" }, "⚠ ", note));

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
    attrsRow.append(el("div", { class: "sh-attr", title: full },
      el("div", { class: "k" }, abbr),
      el("div", { class: "v" }, String(a.final)),
      a.adjust ? el("div", { class: "adj" }, (a.adjust > 0 ? "+" : "") + a.adjust) : null));
  }
  const poolCard = el("div", { class: "card sh-card" }, kismetRow,
    el("h4", { class: "sh-h4" }, "Attributes"), attrsRow);
  if (expandedPool) poolCard.append(poolSkillList(expandedPool));

  // --- condition
  const cond = el("div", { class: "card sh-card" },
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
      "Every 3 boxes marked on either track: −1 die on tasks, cumulative. Biotech can remove these penalties during combat."));

  // --- initiative + wound + combat numbers
  const rawWound = -(Math.floor(play.physical_damage / 3) + Math.floor(play.stun_damage / 3));
  const woundNegated = !!CALC.combat.wound_penalty_negated;   // Pain Nullifier, Shibumi, …
  const wound = woundNegated ? 0 : rawWound;
  // Initiative: roll Focus-pool dice, add Reaction — e.g. "12d+8".
  const init = CALC.initiative
    || { dice: CALC.pools.Focus, bonus: CALC.attributes.Reaction.final, notes: [] };
  const initInput = el("input", { type: "number", class: "sh-init-input",
    min: "0", value: String(play.initiative || 0),
    oninput: e => { play.initiative = parseInt(e.target.value, 10) || 0; playChanged(false); } });
  const initCard = el("div", { class: "card sh-card sh-counter" },
    el("h3", {}, "Initiative"),
    el("div", { class: "big" }, `${init.dice}d+${init.bonus}`),
    el("div", { class: "sub" }, "Focus Pool dice + Reaction"),
    ...(init.notes || []).map(n =>
      el("div", { class: "sub", style: "color:var(--amber);margin-top:4px" }, "★ " + n)),
    el("div", { class: "sh-counter-btns", style: "margin-top:8px" },
      el("span", { class: "sub", style: "align-self:center" }, "Rolled:"), initInput));
  const woundCard = el("div", { class: "card sh-card sh-counter" },
    el("h3", {}, "Wound Penalty"),
    el("div", { class: "big", style: wound < 0 ? "color:var(--bad)" : "color:var(--ok)" },
      wound < 0 ? `${wound} dice` : "0"),
    woundNegated
      ? el("div", { class: "sub", style: "color:var(--ok)" },
          rawWound < 0 ? `Negated — would be ${rawWound}` : "Wound penalties negated")
      : el("div", { class: "sub" }, "−1 per 3 boxes on each track, cumulative"),
    el("div", { class: "sub" },
      woundNegated ? "Removed by an augment / martial art" : "Biotech can treat in combat"));

  const c = CALC.combat;
  const combatCard = el("div", { class: "card sh-card" },
    el("h3", {}, "Combat"),
    statLine("Move", `${c.move} m` + (moveSpecial() ? ` · ${moveSpecial()}` : "")),
    statLine("Armor B / I", `${c.ballistic_armor} / ${c.impact_armor}`),
    statLine("Max B / Min I", `${c.max_ballistic} / ${c.min_impact}`),
    statLine("Simple actions", String(c.simple_actions)),
    c.melee_exploit ? statLine("Melee exploit", `+${c.melee_exploit}`) : null,
    c.dodge_bonus ? statLine("Dodge bonus", `+${c.dodge_bonus}`) : null,
    c.soak_bonus ? statLine("Soak bonus", `+${c.soak_bonus}`) : null,
    statLine("Carried weight", String(c.carried_weight)));

  body.append(el("div", { class: "sh-ov-grid" },
    el("div", {}, poolCard),
    el("div", {}, cond),
    el("div", {}, initCard, woundCard, combatCard)));

  // Heritage / uplift special abilities (e.g. a Bat's Echolocation) — surfaced
  // here on the Overview, not just buried on the Notes tab.
  const heritageCard = heritageTraitsCard();
  if (heritageCard) body.append(heritageCard);

  // --- equipped weapons (+ mods) and worn armor, mirrored from the Gear tab
  const equippedWeapons = CHAR.weapons.filter(w => w.equipped !== false);
  const wornArmor = CHAR.armor.filter(a => a.active !== false);
  if (equippedWeapons.length || wornArmor.length) {
    const loadout = el("div", { class: "card sh-card" }, el("h3", {}, "Loadout"));
    if (equippedWeapons.length) {
      const wt = el("table");
      wt.append(el("tr", {}, el("th", {}, "Equipped weapon"), el("th", {}, "Stats"), el("th", {}, "Mods")));
      equippedWeapons.forEach(w => {
        const r = DATA.tables.weapons.find(x => x.Weapon === w.name) || {};
        const calcRow = (CALC.weapons || []).find(x => x.Weapon === w.name) || {};
        wt.append(el("tr", {},
          el("td", {}, el("b", {}, w.name + (w.smart ? " (smart)" : ""))),
          el("td", { class: "sub" },
            `${r.Type || ""} · Acc ${r.Accuracy || 0} · DMG ${r.Damage || "—"} · Pen ${r.Pen || 0}`
            + ((calcRow.Ammo ?? r.Ammo) ? ` · Ammo ${calcRow.Ammo ?? r.Ammo}` : "")),
          el("td", { class: "sub" }, (w.mods || []).length ? w.mods.join(", ") : "—")));
      });
      loadout.append(wt);
    }
    if (wornArmor.length) {
      const at = el("table");
      at.append(el("tr", {}, el("th", {}, "Worn armor"), el("th", {}, "B / I"), el("th", {}, "Extras")));
      wornArmor.forEach(a => {
        const r = DATA.tables.armor.find(x => x.Armor === a.name) || {};
        at.append(el("tr", {},
          el("td", {}, el("b", {}, a.name)),
          el("td", { class: "num" }, `${r.Ballistic || 0} / ${r.Impact || 0}`),
          el("td", { class: "sub" }, (a.extras || []).length ? a.extras.join(", ") : "—")));
      });
      loadout.append(el("div", { class: "sh-advrow", style: "border:0;padding:6px 0 0" },
        el("span", { class: "sub" }, `Total armor: ${CALC.combat.ballistic_armor}B / ${CALC.combat.impact_armor}I`)), at);
    }
    body.append(loadout);
  }

  // --- temporary effects + active modifiers
  body.append(el("div", { class: "sh-two" },
    trackedList("Temporary Effects", play.effects, "Add Effect",
      () => {
        const name = (prompt("Effect name (e.g. Haste F4, 3 rounds):") || "").trim();
        if (name) { play.effects.push({ name }); playChanged(); }
      },
      e2 => e2.name, "No temporary effects tracked."),
    trackedList("Active Modifiers", play.modifiers, "Add Modifier",
      () => {
        const name = (prompt("Modifier name (e.g. Cover, Smartlink):") || "").trim();
        if (!name) return;
        const v = (prompt("Value (e.g. +2, −1d):", "+1") || "").trim();
        play.modifiers.push({ name, value: v }); playChanged();
      },
      m => m.value ? `${m.name}  ${m.value}` : m.name, "No active modifiers tracked.")));

  // --- notes
  body.append(notesCard(3));
}

function statLine(label, value) {
  return el("div", { class: "stat-line" }, label, el("b", {}, value));
}
function miniCounter(label, get, set, min = 0, max = 9999) {
  const clamp = n => Math.max(min, Math.min(max, n));
  const val = el("b", { title: "Click to type a value", style: "cursor:text" }, String(get()));
  val.addEventListener("click", () => {
    const input = el("input", { type: "number", value: String(get()),
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

function trackedList(title, items, addLabel, onAdd, describe, emptyText) {
  const card = el("div", { class: "card sh-card" },
    el("div", { class: "sh-card-head" },
      el("h3", {}, title, " ", el("span", { class: "chip" }, String(items.length))),
      counterBtn(addLabel, onAdd, "accent")));
  if (!items.length) card.append(el("p", { class: "hint", style: "margin:6px 0 0" }, emptyText));
  items.forEach((it, i) => card.append(el("div", { class: "stat-line" },
    describe(it),
    el("button", { class: "row-del", onclick: () => { items.splice(i, 1); playChanged(); } }, "✕"))));
  return card;
}

function notesCard(rows) {
  const ta = el("textarea", { class: "sh-notes", rows: String(rows || 6),
    placeholder: "Character notes, session logs, reminders…",
    oninput: e => { CHAR.play.notes = e.target.value; playChanged(false); } });
  ta.value = CHAR.play.notes || "";
  return el("div", { class: "card sh-card" },
    el("h3", {}, "Notes"),
    el("p", { class: "hint", style: "margin:2px 0 8px" }, "Notes save automatically while you type."),
    ta);
}

/* skills belonging to one pool — shown when its pool card is clicked */
function poolSkillList(pool) {
  const rows = [];
  for (const [name, meta] of Object.entries(DATA.skills)) {
    if (meta.pool !== pool) continue;
    rows.push({ name, s: CALC.skills[name] });
  }
  rows.sort((a, b) => (b.s.final - a.s.final) || a.name.localeCompare(b.name));
  const box = el("div", { class: `sh-poolskills ${pool.toLowerCase()}` },
    el("h4", {}, `${pool} skills`));
  for (const { name, s } of rows) {
    const rating = s.final > 0 ? String(s.final)
      : s.dice_bonus ? "0"
      : s.group_value != null ? `grp ${s.group_value}` : "—";
    box.append(el("div", { class: "sh-poolskill" + (s.final > 0 || s.dice_bonus ? "" : " dim") },
      el("span", {}, name, s.group ? el("span", { class: "sub" }, ` ·${s.group}`) : null),
      skillDots(s.final, pool),
      el("b", {}, rating,
        s.dice_bonus ? el("span", { class: "skill-dice" }, `+${s.dice_bonus}d`) : null)));
  }
  return box;
}

function skillDots(n, pool) {
  const dots = el("span", { class: `dots ${pool.toLowerCase()}` });
  for (let i = 1; i <= 7; i++)
    dots.append(el("span", { class: "dot" + (i <= n ? " on" : "") }));
  return dots;
}

/* ------------------------------------------------ skills tab (display only) */
function shSkills(body) {
  const grid = el("div", { class: "sh-skillgrid" });
  for (const pool of POOL_ORDER) {
    const col = el("div", { class: `sh-skillcol ${pool.toLowerCase()}` },
      el("div", { class: "colhead" }, el("span", {}, pool),
        el("b", {}, String(CALC.pools[pool]))));
    const trained = Object.entries(DATA.skills)
      .filter(([n, m]) => m.pool === pool && (CALC.skills[n].final > 0 || CALC.skills[n].dice_bonus))
      .sort((a, b) => CALC.skills[b[0]].final - CALC.skills[a[0]].final);
    if (!trained.length) col.append(el("p", { class: "hint" }, "No trained skills."));
    for (const [name] of trained) {
      const s = CALC.skills[name];
      col.append(el("div", { class: "sh-poolskill" },
        el("span", {}, name), skillDots(s.final, pool),
        el("b", {}, String(s.final),
          s.dice_bonus ? el("span", { class: "skill-dice" }, `+${s.dice_bonus}d`) : null)));
    }
    grid.append(col);
  }
  body.append(el("div", { class: "card sh-card" }, el("h3", {}, "Skills"), grid,
    el("p", { class: "hint", style: "margin-top:10px" },
      "Raise skills and attributes with Kismet on the Kismet tab.")));

  const know = el("div", { class: "card sh-card" },
    el("h3", {}, "Knowledge & Etiquette"));
  const etq = Object.entries(CHAR.etiquettes || {}).filter(([, v]) => v > 0);
  if (etq.length) {
    const row = el("div", { class: "sh-tagrow" });
    for (const [name, pts] of etq)
      row.append(el("span", { class: "sh-tag magic" }, `${name} ${pts}`));
    know.append(el("h4", { class: "sh-h4" }, "Etiquettes"), row);
  }
  if (CHAR.knowledge_skills.some(k => k.name)) {
    const row = el("div", { class: "sh-tagrow" });
    for (const k of CHAR.knowledge_skills)
      if (k.name) row.append(el("span", { class: "sh-tag" }, `${k.name} ${k.points || 0}`));
    know.append(el("h4", { class: "sh-h4" }, "Knowledges"), row);
  }
  if (!etq.length && !CHAR.knowledge_skills.some(k => k.name))
    know.append(el("p", { class: "hint" }, "No knowledge skills or etiquettes."));
  body.append(know);

  // rituals — each its own skill
  const rituals = Object.entries(CALC.ritual_skills || {}).filter(([, v]) => v > 0);
  if (rituals.length) {
    const rc = el("div", { class: "card sh-card" }, el("h3", {}, "Ritual Skills"));
    for (const [name, pts] of rituals) {
      const r = DATA.tables.rituals.find(x => x.Name === name) || {};
      rc.append(el("div", { class: "sh-poolskill" },
        el("span", {}, name, el("span", { class: "sub" }, ` · Drain ${r.Drain || "—"}`)),
        skillDots(pts, "resolve"),
        el("b", {}, String(pts))));
    }
    body.append(rc);
  }

  // Martial Art: pick a style (needed when you buy Martial Arts in play), then
  // its level effects unlock as the skill rises.
  const maPts = (CALC.skills["Martial Arts"] || { points: 0 }).points;
  const maStyles = [...new Set(DATA.tables.martial_arts.map(r => r.Style))].sort();
  const maCard = el("div", { class: "card sh-card" },
    el("h3", {}, "Martial Art" + (CALC.martial_art.style ? ` — ${CALC.martial_art.style}` : "")));
  const maSel = el("select", {},
    el("option", { value: "" }, "Choose style…"),
    ...maStyles.map(st =>
      el("option", { value: st, ...(CHAR.martial_art === st ? { selected: 1 } : {}) }, st)));
  maSel.addEventListener("change", () => { CHAR.martial_art = maSel.value; playChangedRecalc(); });
  maCard.append(el("div", { class: "add-row" }, el("span", { class: "sub" }, "Style"), maSel));
  if (CALC.martial_art.style) {
    CALC.martial_art.levels.forEach(l => maCard.append(statLine(`Level ${l.Level}`, l.Effect)));
  } else {
    maCard.append(el("p", { class: "hint" }, maPts > 0
      ? "Pick a style to see its level effects."
      : "Buy the Martial Arts skill on the Kismet tab (Unarmed Combat first), then pick a style."));
  }
  body.append(maCard);
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
  const customAmt = el("input", { type: "number", value: "1", min: "1", style: "width:70px" });
  awardRow.append(el("span", { class: "sh-inline-adjust" },
    customAmt,
    el("button", { class: "btn small good", onclick: () => {
      const n = parseInt(customAmt.value, 10);
      if (n > 0) { awardKismet("Custom award", n); playChanged(); }
    } }, "Award"),
    el("button", { class: "btn small warn", onclick: () => {
      const n = parseInt(customAmt.value, 10);
      if (n > 0 && spendKismet("Custom spend", n)) playChanged();
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
          if (!spendKismet(`Raised ${full} to ${a.final + 1}`, cost)) return;
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
    const maCapped = name === "Martial Arts"
      && s.points >= (CALC.skills["Unarmed Combat"] || { points: 0 }).points;
    const atCap = s.points >= SKILL_KISMET_CAP || maCapped;
    const cost = skillRaiseCost(s.points);
    skillBox.append(el("div", { class: "sh-advrow" },
      el("span", {}, el("b", {}, name),
        el("span", { class: "sub" }, ` ${s.pool} · rank ${s.points}`)),
      el("button", {
        class: "btn small", disabled: (atCap || play.kismet < cost) ? "1" : null,
        title: maCapped ? "Martial Arts can never exceed Unarmed Combat"
          : atCap ? "Rank 6 is the Kismet cap — use a mastery boon for 7" : null,
        onclick: async () => {
          if (!spendKismet(`Raised ${name} to rank ${s.points + 1}`, cost)) return;
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
        // Martial Arts can never exceed Unarmed Combat, so it can't be the
        // first-learned rank unless Unarmed Combat is already trained — and it
        // needs a chosen style to do anything.
        if (name === "Martial Arts") {
          const uc = (CALC.skills["Unarmed Combat"] || { points: 0 }).points;
          if (uc < 1) {
            alert("Martial Arts can never exceed Unarmed Combat — raise Unarmed Combat first.");
            return;
          }
          if (!CHAR.martial_art) {
            alert("Choose a martial art style on the Skills tab first.");
            return;
          }
        }
        if (!spendKismet(`Learned new skill: ${name}`, NEW_SKILL_KISMET_COST)) return;
        play.skill_advances[name] = (play.skill_advances[name] || 0) + 1;
        await playChangedRecalc();
      },
    }, `Learn (${NEW_SKILL_KISMET_COST})`)));

  two.append(attrBox, skillBox);
  spend.append(two);

  // ZP advancement: unlocks higher-Force casting (drain Stun instead of
  // lethal when Force <= ZP) and widens Amp/augment headroom.
  // Cost rate is an assumption: same tiers as attributes (3 / 4 / 5).
  const zp = CALC.zoetics.zp;
  const zpCost = attrRaiseCost(zp + 1);
  spend.append(el("h4", { class: "sh-h4" }, "Advance Zoetic Potential"),
    el("p", { class: "hint" },
      "ZP gates spell Force: casting a spell with Force above your ZP deals its drain as LETHAL damage; "
      + "at or below ZP, drain is Stun. Cost per point assumed to match attribute tiers."),
    el("div", { class: "sh-advrow", style: "max-width:420px" },
      el("span", {}, el("b", {}, "Zoetic Potential"),
        el("span", { class: "sub" }, ` current ${zp}`)),
      el("button", {
        class: "btn small", disabled: play.kismet < zpCost ? "1" : null,
        onclick: async () => {
          if (!spendKismet(`Raised Zoetic Potential to ${zp + 1}`, zpCost)) return;
          play.zp_advances = (play.zp_advances || 0) + 1;
          await playChangedRecalc();
        },
      }, `+1 (${zpCost})`)));
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

  const masterable = Object.keys(DATA.skills).filter(n => CALC.skills[n].points === 6);
  const masterSel = el("select", {},
    el("option", { value: "" }, "Skill at rank 6…"),
    ...masterable.map(n => el("option", {}, n)));
  boons.append(el("div", { class: "sh-tagrow" },
    counterBtn("Redeem: Windfall (roll below)", () => {
      if (econ.regularsAvail < 1) { alert("No regular boons available."); return; }
      play.boons_spent++;
      play.kismet_log.unshift({ label: "Boon redeemed: financial windfall (Agonarch rolls)", delta: 0 });
      playChanged();
    }, econ.regularsAvail ? "accent" : ""),
    counterBtn("Redeem: Free asset", () => {
      if (econ.regularsAvail < 1) { alert("No regular boons available."); return; }
      play.boons_spent++;
      play.kismet_log.unshift({ label: "Boon redeemed: new free random asset (old friend)", delta: 0 });
      playChanged();
    }, econ.regularsAvail ? "accent" : ""),
    counterBtn("Redeem: Major boon", () => {
      if (econ.majorsAvail < 1) { alert("No major boons available."); return; }
      play.major_boons_spent++;
      play.kismet_log.unshift({ label: "MAJOR boon redeemed (see Agonarch)", delta: 0 });
      playChanged();
    }, econ.majorsAvail ? "accent" : "")));
  boons.append(el("div", { class: "add-row" }, masterSel,
    el("button", { class: "btn-add", onclick: async () => {
      const name = masterSel.value;
      if (!name) return;
      if (econ.regularsAvail < 1) { alert("No regular boons available."); return; }
      play.boons_spent++;
      play.kismet_log.unshift({ label: `Boon redeemed: skill mastery — ${name} 6→7`, delta: 0 });
      play.skill_advances[name] = (play.skill_advances[name] || 0) + 1;
      await playChangedRecalc();
    } }, "Mastery 6→7 (boon)")));

  // --- specific MAJOR boon options
  play.pool_kismet = play.pool_kismet || {};
  boons.append(el("h4", { class: "sh-h4" }, "Major Boons"));
  const spendMajor = label => {
    if (econ.majorsAvail < 1) { alert("No major boons available."); return false; }
    play.major_boons_spent++;
    play.kismet_log.unshift({ label: `MAJOR boon: ${label}`, delta: 0 });
    return true;
  };
  // 1) magic item / experimental tech
  boons.append(el("div", { class: "sh-tagrow" },
    counterBtn("Gain magic item / experimental tech", () => {
      if (spendMajor("gained a magic item / experimental tech (see Agonarch)")) playChanged();
    }, econ.majorsAvail ? "accent" : "")));
  // 2) raise a rank-7 skill to 8
  const skill7 = Object.keys(DATA.skills).filter(n => CALC.skills[n].points === 7);
  const skill7Sel = el("select", {}, el("option", { value: "" }, "Skill at rank 7…"),
    ...skill7.map(n => el("option", {}, n)));
  boons.append(el("div", { class: "add-row" }, skill7Sel,
    el("button", { class: "btn-add", disabled: skill7.length ? null : "1", onclick: async () => {
      const name = skill7Sel.value;
      if (!name) return;
      if (!spendMajor(`raised ${name} 7→8`)) return;
      play.skill_advances[name] = (play.skill_advances[name] || 0) + 1;
      await playChangedRecalc();
    } }, "Skill 7→8 (major)")));
  // 3) add a permanent Kismet die to a pool
  const poolSel = el("select", {}, el("option", { value: "" }, "Pool…"),
    ...POOL_ORDER.map(p => el("option", {}, p)));
  boons.append(el("div", { class: "add-row" }, poolSel,
    el("button", { class: "btn-add", onclick: async () => {
      const pool = poolSel.value;
      if (!pool) return;
      if (!spendMajor(`+1 Kismet die to ${pool} pool`)) return;
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
    t.append(el("tr", {}, el("th", {}, "Entry"), el("th", { class: "num" }, "Kismet")));
    play.kismet_log.slice(0, 40).forEach(entry =>
      t.append(el("tr", {},
        el("td", {}, entry.label),
        el("td", { class: "num", style: entry.delta > 0 ? "color:var(--ok)" : entry.delta < 0 ? "color:var(--bad)" : "" },
          entry.delta > 0 ? `+${entry.delta}` : String(entry.delta)))));
    ledger.append(t);
  }
  body.append(ledger);
}

/* ------------------------------------------------ gear tab */
function shGear(body) {
  const play = CHAR.play;
  const mult = CALC.budget.gear_cost_multiplier || 1;
  const overdrawOK = (name, cost) => CHAR.play.cash >= cost
    || confirm(`${name} costs ${fmt(cost)} but you have ${fmt(CHAR.play.cash)}. Overdraw?`);

  // ===== Jump submenu: scroll to any section within the gear tab.
  const jump = id => () => document.getElementById(id)
    ?.scrollIntoView({ behavior: "smooth", block: "start" });
  body.append(el("div", { class: "gear-submenu" },
    ...[["gear-cash", "Zuzus"], ["gear-lifestyle", "Lifestyle"], ["gear-weapons", "Weapons"],
        ["gear-armor", "Armor"], ["gear-augments", "Augments"], ["gear-gear", "Gear"],
        ["gear-vehicles", "Vehicles"], ["gear-buy", "Buy"]]
      .map(([id, label]) => el("button", { onclick: jump(id) }, label))));

  // ===== Zuzus on hand + Lifestyle — half-width, side by side.
  const amt = el("input", { type: "number", value: "100", min: "1", style: "width:90px" });
  const applyCash = sign => {
    const n = parseInt(amt.value, 10);
    if (!Number.isFinite(n) || n <= 0) return;
    logCash(sign > 0 ? "Cash awarded" : "Cash spent", sign * n);
    playChanged();
  };
  const zuzusCard = el("div", { class: "card sh-card", id: "gear-cash" },
    el("h3", {}, "Zuzus on hand"),
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
  // half-width, stacked under Zuzus.
  const wtNum = n => +n || 0;
  let load = 0;
  CHAR.weapons.filter(w => w.equipped !== false).forEach(w => {
    const r = DATA.tables.weapons.find(x => x.Weapon === w.name) || {};
    load += wtNum(r.Weight);
  });
  CHAR.armor.filter(a => a.active !== false).forEach(a => {
    const r = DATA.tables.armor.find(x => x.Armor === a.name) || {};
    load += wtNum(r.wt);
  });
  [...CHAR.gear, ...play.purchases.gear].forEach(g => {
    const r = DATA.tables.misc_gear.find(x => x.Item === g.name) || {};
    load += wtNum(r.Weight) * (g.qty || 1);
  });
  load = Math.round(load * 10) / 10;
  const strength = CALC.attributes.Strength.final;
  const overburdened = load > strength;
  const loadCard = el("div", { class: "card sh-card", id: "gear-load" }, el("h3", {}, "Carried load"),
    el("div", { class: "sh-advrow" },
      el("span", {}, "Equipped/worn weight vs Strength"),
      el("b", { style: overburdened ? "color:var(--bad)" : "" }, `${load} / ${strength}`)));
  if (overburdened)
    loadCard.append(el("div", { class: "sh-callout", style: "border-color:var(--bad);color:var(--bad)" },
      el("b", {}, "Overburdened — "),
      `carrying ${load} weight exceeds Strength ${strength}.`));

  body.append(el("div", { class: "sh-two" },
    el("div", {}, zuzusCard, loadCard),
    lsCard));

  // ===== Weapons — owned table (equipped toggle stays live, remove). Buying
  // moved to the Buy section at the bottom.
  const weaponCard = el("div", { class: "card sh-card", id: "gear-weapons" }, el("h3", {}, "Weapons"));
  if (mult > 1) weaponCard.append(el("p", { class: "hint" }, `Heritage surcharge: all costs ×${mult}.`));
  weaponCard.append(el("div", { class: "mod-slot-legend" },
    el("span", { class: "mod-overbarrel" }, "● Overbarrel"),
    el("span", { class: "mod-underbarrel" }, "● Underbarrel"),
    el("span", { class: "mod-chassis" }, "● Chassis")));
  const weaponBuyGroups = Object.entries(
    DATA.tables.weapons.reduce((acc, r) => (((acc[r.Type] ??= []).push(r)), acc), {}))
    .map(([type, rows]) => ({
      label: WEAPON_TYPE_LABELS[type] || type,
      items: rows.map(r => ({ name: r.Weapon, cost: Math.round((+r.Cost || 0) * mult),
        sub: (r.Type === "Melee" ? `Reach ${r.Reach || 0}` : `Acc ${r.Accuracy || 0}`)
          + ` · DMG ${r.Damage || "—"} · Pen ${r.Pen || 0} · wt ${r.Weight || 0}` })),
    }));
  if (CHAR.weapons.length) {
    const t = el("table");
    t.append(el("tr", {}, el("th", {}, "Weapon"), el("th", {}, "Stats"),
      el("th", {}, "Mods"), el("th", {}, "Equip"), el("th", {}, "")));
    CHAR.weapons.forEach((w, wi) => {
      const r = DATA.tables.weapons.find(x => x.Weapon === w.name) || {};
      const canMod = !["Melee", "Thrown", "GrenadeLauncher"].includes(r.Type);
      const calcRow = (CALC.weapons || []).find(x => x.Weapon === w.name) || {};
      const modsCell = canMod
        ? fittedCategoryEditor({
            id: `sh-wmods-${wi}-${w.name}`,
            items: w.mods || [],
            groups: modGroups(DATA.tables.weapon_mods, "Modification", "Slot"),
            onAdd: name => {
              const mr = DATA.tables.weapon_mods.find(m => m.Modification === name) || {};
              const cost = Math.round((+mr.Cost || 0) * mult);
              if (!overdrawOK(name, cost)) return;
              (w.mods = w.mods || []).push(name);
              logCash(`Fitted ${name} to ${w.name}`, -cost);
            },
            onRemove: index => { w.mods.splice(index, 1); },
            effectOf: name =>
              (DATA.tables.weapon_mods.find(m => m.Modification === name) || {}).Effect || "",
            classOf: name =>
              modSlotClass((DATA.tables.weapon_mods.find(m => m.Modification === name) || {}).Slot),
            rerender: renderSheet,
            afterAdd: () => playChangedRecalc(),
          })
        : ((w.mods || []).length
            ? el("div", { class: "sub" }, ...w.mods.map(m => el("div", {}, m)))
            : "—");
      t.append(el("tr", {},
        el("td", {}, el("b", {}, w.name + (w.smart ? " (smart)" : "")),
          el("div", { class: "sub", style: "color:var(--manon)" }, weaponRoll(r.Type))),
        el("td", { class: "sub" },
          `${r.Type || ""} · Acc ${r.Accuracy || 0} · DMG ${r.Damage || "—"} · ${r["Firing modes"] || "melee"} · Pen ${r.Pen || 0}` +
          ((calcRow.Ammo ?? r.Ammo) ? ` · Ammo ${calcRow.Ammo ?? r.Ammo}` : "")),
        el("td", { class: "sub" }, modsCell),
        el("td", {}, el("input", { type: "checkbox", ...(w.equipped !== false ? { checked: 1 } : {}),
          onchange: async e => { w.equipped = e.target.checked; await playChangedRecalc(); } })),
        el("td", {}, el("button", { class: "row-del", title: "Sell / remove weapon",
          onclick: async () => {
            if (!confirm(`Remove ${w.name}?`)) return;
            CHAR.weapons.splice(wi, 1); await playChangedRecalc();
          } }, "✕"))));
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
  const armorItem = r => ({ name: r.Armor, cost: Math.round((+r.Cost || 0) * mult),
    sub: `${r.Ballistic}B / ${r.Impact}I · wt ${r.wt}${r.Style === "Y" ? " · styleable" : ""}` });
  const armorBuyGroups = [
    { label: "Outer Armor", items: DATA.tables.armor.filter(r => (r.Slot || "").startsWith("Outer")).map(armorItem) },
    { label: "Under Armor", items: DATA.tables.armor.filter(r => r.Slot === "Under").map(armorItem) },
    { label: "Other", items: DATA.tables.armor.filter(r => !(r.Slot || "").startsWith("Outer") && r.Slot !== "Under").map(armorItem) },
  ];
  if (CHAR.armor.length) {
    const t = el("table");
    t.append(el("tr", {}, el("th", {}, "Armor"), el("th", {}, "B / I"),
      el("th", {}, "Extras"), el("th", {}, "Worn"), el("th", {}, "")));
    CHAR.armor.forEach((a, ai) => {
      const r = DATA.tables.armor.find(x => x.Armor === a.name) || {};
      const baseCost = +r.Cost || 0;
      // Extras are cost multipliers; the marginal charge is base cost × (mult − 1).
      const extrasCell = r.Style === "Y"
        ? fittedCategoryEditor({
            id: `sh-aextras-${ai}-${a.name}`,
            items: a.extras || [],
            groups: [{ label: "Armor Extras", items: DATA.tables.armor_extras.map(x => ({
              name: x.Extra,
              cost: Math.round(baseCost * ((+x.Multiplier || 1) - 1) * mult),
              sub: `×${x.Multiplier}${x.Effects ? " · " + x.Effects : ""}`,
            })) }],
            onAdd: name => {
              const ex = DATA.tables.armor_extras.find(x => x.Extra === name) || {};
              const cost = Math.round(baseCost * ((+ex.Multiplier || 1) - 1) * mult);
              if (!overdrawOK(name, cost)) return;
              (a.extras = a.extras || []).push(name);
              logCash(`Added ${name} to ${a.name}`, -cost);
            },
            onRemove: index => { a.extras.splice(index, 1); },
            rerender: renderSheet,
            afterAdd: () => playChangedRecalc(),
          })
        : "—";
      t.append(el("tr", {},
        el("td", {}, el("b", {}, a.name),
          el("div", { class: "sub" }, [a.style, a.material].filter(Boolean).join(" · ") || r.Slot || "")),
        el("td", { class: "num" }, `${r.Ballistic || 0} / ${r.Impact || 0}`),
        el("td", { class: "sub" }, extrasCell),
        el("td", {}, el("input", { type: "checkbox", ...(a.active !== false ? { checked: 1 } : {}),
          onchange: async e => {
            a.active = e.target.checked;
            // Only one piece per armor slot may be worn at a time.
            if (a.active && r.Slot) {
              CHAR.armor.forEach(other => {
                if (other === a) return;
                const os = (DATA.tables.armor.find(x => x.Armor === other.name) || {}).Slot;
                if (os === r.Slot) other.active = false;
              });
            }
            await playChangedRecalc();
          } })),
        el("td", {}, el("button", { class: "row-del", title: "Sell / remove armor",
          onclick: async () => {
            if (!confirm(`Remove ${a.name}?`)) return;
            CHAR.armor.splice(ai, 1); await playChangedRecalc();
          } }, "✕"))));
    });
    armorCard.append(t);
  } else {
    armorCard.append(el("p", { class: "hint" }, "No armor owned — buy some in the Buy section below."));
  }
  body.append(armorCard);

  // ===== Augments (chargen + bought in play) — Alpha toggle + remove
  const augEntries = [
    ...CHAR.augments.map(a => ({ ref: a, inPlay: false })),
    ...play.purchases.augments.map(a => ({ ref: a, inPlay: true }))];
  const augCard = el("div", { class: "card sh-card", id: "gear-augments" }, el("h3", {}, "Augments"));
  if (augEntries.length) {
    const t = el("table");
    t.append(el("tr", {}, el("th", {}, "Augment"), el("th", { class: "num" }, "×"),
      el("th", {}, "α-cyber"), el("th", {}, "Effect"), el("th", {}, "")));
    augEntries.forEach(({ ref: a, inPlay }) => {
      const r = DATA.tables.augments.find(x => x.Name === a.name) || {};
      const hasZr = !!(+r.ZR);
      const alphaZr = hasZr ? Math.ceil(+r.ZR * 0.8 * 10) / 10 : 0;
      const base = Math.round((+r.Cost || 0) * mult);
      const alphaCell = hasZr
        ? el("label", { class: "opt", title: `α-cyber grade: ZR ${alphaZr} (−20%), cost ×2` },
            el("input", { type: "checkbox", ...(a.alpha ? { checked: 1 } : {}),
              onchange: async e => {
                a.alpha = e.target.checked;
                logCash(a.alpha ? `Upgraded ${a.name} to α-cyber grade`
                                : `Reverted ${a.name} from α-cyber grade`,
                  a.alpha ? -base : base);
                await playChangedRecalc();
              } }),
            el("span", {}, `ZR ${a.alpha ? alphaZr : +r.ZR}`))
        : el("span", { class: "sub" }, "—");
      t.append(el("tr", {},
        el("td", {}, el("b", {}, a.name),
          inPlay ? el("span", { class: "sh-tag" }, "bought in play") : null),
        el("td", { class: "num" }, String(a.count || 1)),
        el("td", {}, alphaCell),
        el("td", { class: "sub" }, r.Effect || ""),
        el("td", {}, el("button", { class: "row-del", title: "Remove (surgical removal — not refunded)",
          onclick: async () => {
            if (!confirm(`Remove ${a.name}? Surgical removal is not refunded.`)) return;
            const arr = inPlay ? CHAR.play.purchases.augments : CHAR.augments;
            const idx = arr.indexOf(a);
            if (idx >= 0) arr.splice(idx, 1);
            await playChangedRecalc();
          } }, "✕"))));
    });
    augCard.append(el("p", { class: "hint" },
      "α-cyber Augments are bleeding edge, reducing the ZR by 20% but doubling the cost."), t);
  } else {
    augCard.append(el("p", { class: "hint" }, "No augments — buy some in the Buy section below."));
  }
  body.append(augCard);

  // ===== Gear list (chargen + bought in play) — remove buttons
  const gearEntries = [
    ...CHAR.gear.map(g => ({ ref: g, inPlay: false })),
    ...play.purchases.gear.map(g => ({ ref: g, inPlay: true }))];
  const gt = el("table");
  gt.append(el("tr", {}, el("th", {}, "Item"), el("th", { class: "num" }, "Qty"),
    el("th", {}, "Effect"), el("th", {}, "")));
  gearEntries.forEach(({ ref: g, inPlay }) => {
    const r = DATA.tables.misc_gear.find(x => x.Item === g.name) || {};
    gt.append(el("tr", {},
      el("td", {}, el("b", {}, g.name),
        inPlay ? el("span", { class: "sh-tag" }, "bought in play") : null),
      el("td", { class: "num" }, String(g.qty || 1)),
      el("td", { class: "sub" }, r.Effect || ""),
      el("td", {}, el("button", { class: "row-del", title: "Remove item",
        onclick: async () => {
          if (!confirm(`Remove ${g.name}?`)) return;
          const arr = inPlay ? CHAR.play.purchases.gear : CHAR.gear;
          const idx = arr.indexOf(g);
          if (idx >= 0) arr.splice(idx, 1);
          await playChangedRecalc();
        } }, "✕"))));
  });
  if (!gearEntries.length)
    gt.append(el("tr", {}, el("td", { class: "sub", colspan: "4" }, "No gear.")));
  body.append(el("div", { class: "card sh-card", id: "gear-gear" }, el("h3", {}, "Gear"), gt));

  // ===== Vehicles / rigs / decks owned (configured on their own tabs)
  if (CHAR.rigs.length || CHAR.decks.length || CHAR.drones.length || CHAR.vehicles.length) {
    const vt = el("table");
    vt.append(el("tr", {}, el("th", {}, "Item"), el("th", {}, "Type")));
    const addRows = (list, label, nameKey) => list.forEach(u =>
      vt.append(el("tr", {},
        el("td", {}, el("b", {}, u.label || u[nameKey] || u.name),
          (u.label && (u.name)) ? el("span", { class: "sub" }, ` (${u.name})`) : null),
        el("td", { class: "sub" }, label))));
    addRows(CHAR.rigs, "VCR", "name");
    addRows(CHAR.decks, "Cyberdeck", "name");
    addRows(CHAR.drones, "Drone", "name");
    addRows(CHAR.vehicles, "Vehicle", "name");
    body.append(el("div", { class: "card sh-card", id: "gear-vehicles" },
      el("h3", {}, "Vehicles, Rigs & Decks"),
      el("p", { class: "hint" }, "Bought, modified and removed on the Rigging and Decking tabs."), vt));
  }

  // ===== Buy equipment — all purchasing lives here, collapsible by type.
  const augBuyGroups = Object.entries(
    DATA.tables.augments.reduce((acc, r) => (((acc[r.Type || "Augment"] ??= []).push(r)), acc), {}))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, rows]) => ({
      label: type,
      items: rows.map(r => ({ name: r.Name, cost: Math.round((+r.Cost || 0) * mult),
        sub: `ZR ${r.ZR || 0} · BI ${r.BI || 0}${r.Effect ? " · " + r.Effect : ""}` })),
    }));
  const gearBuyGroups = Object.entries(
    DATA.tables.misc_gear.reduce((acc, r) => (((acc[r.Class || "Gear"] ??= []).push(r)), acc), {}))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cls, rows]) => ({
      label: cls,
      items: rows.map(r => ({ name: r.Item, cost: Math.round((+r.Cost || 0) * mult),
        sub: r.Effect || "" })),
    }));
  const buySection = el("div", { class: "card sh-card", id: "gear-buy" },
    el("h3", {}, "Buy equipment"),
    el("p", { class: "hint" }, "Everything purchasable from zuzus, grouped by type. "
      + (mult > 1 ? `Heritage surcharge ×${mult} applied. ` : "")
      + "Decks, programs, rigs, drones and vehicles are bought on the Decking and Rigging tabs."));
  const buyBlock = (title, browser) =>
    buySection.append(el("div", { class: "sh-unit-add" }, el("b", {}, title), browser));
  buyBlock("Weapons", categoryBrowser({ id: "sh-buy-weapons", groups: weaponBuyGroups,
    rerender: renderSheet, afterAdd: () => playChangedRecalc(),
    onAdd: name => {
      const r = DATA.tables.weapons.find(x => x.Weapon === name) || {};
      const cost = Math.round((+r.Cost || 0) * mult);
      if (!overdrawOK(name, cost)) return;
      CHAR.weapons.push({ name, smart: false, mods: [], equipped: true, qty: 1 });
      logCash(`Bought ${name}`, -cost);
    } }));
  buyBlock("Armor", categoryBrowser({ id: "sh-buy-armor", groups: armorBuyGroups,
    rerender: renderSheet, afterAdd: () => playChangedRecalc(),
    onAdd: name => {
      const r = DATA.tables.armor.find(x => x.Armor === name) || {};
      const cost = Math.round((+r.Cost || 0) * mult);
      if (!overdrawOK(name, cost)) return;
      CHAR.armor.push({ name, style: "", material: "", extras: [], active: true });
      logCash(`Bought ${name}`, -cost);
    } }));
  buyBlock("Augments", categoryBrowser({ id: "sh-buy-augments", groups: augBuyGroups,
    rerender: renderSheet, afterAdd: () => {},
    onAdd: name => buyAugment(name, mult) }));
  buyBlock("Gear", categoryBrowser({ id: "sh-buy-gear", groups: gearBuyGroups,
    rerender: renderSheet, afterAdd: () => {},
    onAdd: name => buyGear(name, mult) }));
  body.append(buySection);

  // ===== Activity (cash ledger) — moved to the bottom
  if (play.cash_log.length) {
    const t = el("table", { style: "max-width:560px" });
    play.cash_log.slice(0, 20).forEach(entry =>
      t.append(el("tr", {},
        el("td", {}, entry.label),
        el("td", { class: "num", style: entry.delta >= 0 ? "color:var(--ok)" : "color:var(--bad)" },
          (entry.delta >= 0 ? "+" : "") + fmt(entry.delta).replace("ㄓ-", "−ㄓ")))));
    body.append(el("div", { class: "card sh-card" }, el("h3", {}, "Activity"), t));
  }
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
  const hasHyperthyroid = [...CHAR.augments, ...((play.purchases && play.purchases.augments) || [])]
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
        miniCounter("Months", () => ls.months || 0, v => { ls.months = v; }),
        counterBtn(`+1 mo (${fmt(monthly)})`, () => {
          if (play.cash < monthly
              && !confirm(`A month of ${ls.name} costs ${fmt(monthly)} but you have ${fmt(play.cash)}. Overdraw?`))
            return;
          ls.months = (ls.months || 0) + 1;
          if (monthly) logCash(`Prepaid 1 month of ${ls.name} lifestyle`, -monthly);
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
  logCash(`Bought ${name}`, -cost);
  await playChangedRecalc();
}
async function buyAugment(name, mult) {
  if (!name) return;
  const r = DATA.tables.augments.find(x => x.Name === name);
  if (!r) return;
  // Block augments that conflict with something already installed.
  const owned = [...CHAR.augments, ...CHAR.play.purchases.augments];
  const banReason = augmentAvailability(owned).bannedReason(name);
  if (banReason) { alert(`Can't install ${name}: ${banReason}.`); return; }
  const cost = Math.round(r.Cost * mult);
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
  CHAR.play.purchases.augments.push({ name, count: 1 });
  logCash(`Installed ${name}`, -cost);
  await playChangedRecalc();
}

/* ------------------------------------------------ magic tab */
function shMagic(body) {
  const type = CALC.magic.type;
  const play = CHAR.play;

  const zp = CALC.zoetics.zp;
  const allSpells = [
    ...CHAR.magic.spells.map(s => ({ ...s, inPlay: false })),
    ...play.purchases.spells.map(s => ({ ...s, inPlay: true }))];
  if (allSpells.length || type === "Mage" || type === "Archmage") {
    const wrap = el("div", { class: "card sh-card" },
      el("div", { class: "sh-card-head" },
        el("h3", {}, "Spells"),
        el("span", { class: "chip magic" }, `ZP ${zp}`)));
    wrap.append(el("p", { class: "hint" },
      "Spells cost their listed price in zuzus per Force to learn or advance. "
      + `Casting at Force above your ZP (${zp}) deals drain as LETHAL damage; at or below, drain is Stun.`));
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
              logCash(`${sp.name}: Force ${force} → ${force + 1}`, -perForce);
              await playChangedRecalc();
            } }, force >= SPELL_FORCE_MAX ? `Force ${SPELL_FORCE_MAX} (max)` : `+1 Force (${fmt(perForce)})`)),
        el("div", { class: "sub" },
          `Drain: ${r.Drain || "—"} · Resist: ${r["Target Resistance"] || "—"} · Duration: ${r.Duration || "—"}`),
        r.Effect ? el("div", { class: "sub" }, r.Effect) : null));
    }
    // learn a new spell with cash: listed Cost × starting Force
    if (type === "Mage" || type === "Archmage") {
      const known = new Set(allSpells.map(s => s.name));
      const learnable = DATA.tables.spells.filter(r =>
        !known.has(r.Name) && (type === "Archmage" || !CHAR.magic.school || r.School === CHAR.magic.school));
      if (learnable.length) {
        const spellSel = el("select", {},
          el("option", { value: "" }, "Learn new spell…"),
          ...learnable.map(r => el("option", { value: r.Name },
            `${r.Name} (${r.School}) — ${fmt(Math.round(+r.Cost || 0))}/Force`)));
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
            logCash(`Learned ${name} at Force ${force}`, -cost);
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
        "⚠ AMP POWERS OFFLINE — ZP is negative. Shed carried ZR or the powers stay dark."));
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
      wrap.append(el("div", { class: "sh-spell amp" },
        el("div", {}, el("b", {}, p.name), " ",
          el("span", { class: "chip" }, `${r["ZP Cost"] || "?"} ZP`),
          p.target && !targetCtl ? el("span", { class: "sub" }, ` → ${p.target}`) : null,
          (p.times || 1) > 1 ? el("span", { class: "sub" }, ` ×${p.times}`) : null,
          p.inPlay ? el("span", { class: "sh-tag" }, "bought in play") : null,
          targetCtl ? el("span", {}, " ", targetCtl) : null,
          targetCtl && !p.target
            ? el("span", { class: "sub", style: "color:var(--bad)" }, " ← needs a target to apply")
            : null),
        r.Effect ? el("div", { class: "sub" }, r.Effect) : null));
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
          await playChangedRecalc();
        } }, "Buy (ZP)")));
      wrap.append(el("p", { class: "hint" },
        "New powers draw on your remaining ZP and cannot take it below 0"
        + (type === "Amp" ? " (Amps pay half the listed ZP)." : ".")));
    }
    body.append(wrap);
  }

  if (type === "Speaker" || type === "Archmage") {
    const s = CHAR.speaker;
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

    if (s.relationships.length) {
      const row = el("div", { class: "sh-tagrow" });
      for (const name of s.relationships) {
        const r = spiritRow(name);
        row.append(el("span", { class: "sh-tag magic" },
          `${name}${r.Element ? " · " + r.Element : ""}`));
      }
      card.append(el("h4", { class: "sh-h4" }, "Relationships"), row);
    } else {
      card.append(el("p", { class: "hint" }, "No spirit relationships — add them in chargen."));
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
          ...s.relationships.map(n => el("option", { value: n }, n)));
        sel.value = placed;
        const benefit = placed ? (spiritRow(placed)[col] || "no listed benefit") : "";
        card.append(el("div", { class: "sh-advrow" + (placed ? " active-row" : "") },
          el("span", {}, el("b", {}, slot),
            placed ? el("span", { class: "chip ok", style: "margin-left:6px" }, "active") : null,
            benefit ? el("div", { class: "sub", style: "color:var(--ok)" }, benefit) : null),
          sel));
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
    const bondCount = s.bonds || 0;
    card.append(el("h4", { class: "sh-h4" }, `Bonds — ${bondCount} slot(s), track favors owed`));
    if (!bondCount) card.append(el("p", { class: "hint" }, "No spirit bonds purchased in chargen."));
    while (play.bond_slots.length < bondCount) play.bond_slots.push({ spirit: "", favors: 0 });
    if (play.bond_slots.length > bondCount) play.bond_slots.length = bondCount;
    const bondTiles = el("div", { class: "sh-bond-tiles" });
    play.bond_slots.forEach((bond, bi) => {
      const sel = el("select", { onchange: e => { bond.spirit = e.target.value; playChanged(); } },
        el("option", { value: "" }, "— empty —"),
        ...s.relationships.map(n => el("option", { value: n }, n)));
      sel.value = bond.spirit || "";
      bondTiles.append(el("div", { class: "sh-bond-tile" + (bond.spirit ? " active" : "") },
        el("div", { class: "k" }, `Bond ${bi + 1}`),
        sel,
        el("div", { class: "sh-bond-fav" },
          miniCounter("Favors", () => bond.favors || 0, v => { bond.favors = v; }, 0, 99))));
    });
    if (bondCount) card.append(bondTiles);

    if (CHAR.magic.archmage_bind) card.append(statLine("Bound spirit (chargen)", "yes (15 Force)"));
    body.append(card);
  }

  if (type === "Mage" || type === "Archmage" || type === "Speaker") {
    const t = el("table");
    t.append(el("tr", {}, el("th", {}, "Ritual"), el("th", {}, "Drain"),
      el("th", {}, "Time"), el("th", {}, "Effect")));
    for (const r of DATA.tables.rituals)
      t.append(el("tr", {},
        el("td", {}, el("b", {}, r.Name)), el("td", { class: "sub" }, r.Drain),
        el("td", { class: "sub" }, r.Time), el("td", { class: "sub" }, r.Effect)));
    body.append(el("div", { class: "card sh-card" }, el("h3", {}, "Rituals (reference)"), t));
  }
}

/* ------------------------------------------------ decking tab */
function shDecking(body) {
  const dk = CHAR.play.decking;
  const decks = CHAR.decks;
  if (decks.length && !decks.some(d => d.name === dk.active_deck))
    dk.active_deck = decks[0].name;
  const active = DATA.tables.decks.find(x => x.Name === dk.active_deck);

  const mult = CALC.budget.gear_cost_multiplier || 1;
  // Buy browsers collect here and render at the bottom of the tab.
  const deckBuySection = el("div", { class: "card sh-card", id: "deck-buy" },
    el("h3", {}, "Buy decks & programs"));
  const deckCard = el("div", { class: "card sh-card" }, el("h3", {}, "Cyberdecks"));
  decks.forEach((d, di) => {
    const r = DATA.tables.decks.find(x => x.Name === d.name) || {};
    const isActive = d.name === dk.active_deck;
    d.mods = d.mods || [];
    const modEditor = fittedCategoryEditor({
      id: `sh-dmods-${di}-${d.name}`,
      items: d.mods,
      groups: modGroups(DATA.tables.deck_mods, "Deck Mod", null, "Deck Mods"),
      onAdd: name => {
        const mr = DATA.tables.deck_mods.find(m => m["Deck Mod"] === name) || {};
        const cost = Math.round((+mr.Cost || 0) * mult);
        if (CHAR.play.cash < cost
            && !confirm(`${name} costs ${fmt(cost)} but you have ${fmt(CHAR.play.cash)}. Overdraw?`)) return;
        d.mods.push(name);
        logCash(`Fitted ${name} to ${d.name}`, -cost);
      },
      onRemove: index => { d.mods.splice(index, 1); },
      effectOf: name => (DATA.tables.deck_mods.find(m => m["Deck Mod"] === name) || {}).Effect || "",
      rerender: renderSheet, afterAdd: () => playChangedRecalc(),
    });
    deckCard.append(el("div", { class: "sh-unit" },
      el("div", {},
        el("div", { class: "sh-advrow" + (isActive ? " active-row" : ""), style: "border:0;padding:0" },
          el("span", {}, el("b", {}, d.name),
            el("span", { class: "sub" },
              ` MCP ${r.MCP} · Hardening ${r.Hardening} · Threads ${r.Threads} · Core ${r.Core} · I/O ${r.IO}`)),
          isActive ? el("span", { class: "chip ok" }, "Active")
            : counterBtn("Set Active", () => {
                dk.active_deck = d.name; dk.loaded = []; playChanged();
              })),
        el("div", { class: "sh-unit-add" }, el("b", {}, "Mods"), modEditor)),
      el("button", { class: "row-del", title: "Sell / remove deck",
        onclick: () => {
          if (!confirm(`Remove ${d.name}? Fitted mods are lost.`)) return;
          decks.splice(di, 1);
          if (dk.active_deck === d.name) { dk.active_deck = ""; dk.loaded = []; }
          playChangedRecalc();
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
        CHAR.decks.push({ name, mods: [] });
        logCash(`Bought ${name}`, -cost);
      } })));
  body.append(deckCard);

  // --- hacking program: deck needs rating ≥ ½ MCP (round down, min 1)
  const baseRating = CHAR.hacking_rating || 0;
  const boughtLevels = CHAR.play.purchases.hacking_levels || 0;
  const rating = baseRating + boughtLevels;
  const required = active ? Math.max(1, Math.floor(+active.MCP / 2)) : 0;
  const meets = !active || rating >= required;
  const levelCost = Math.round(HACKING_RATING_COST * mult);
  const hackBox = el("div", { class: "sh-hackbox" },
    el("div", { class: "sh-card-head" },
      el("h4", { class: "sh-h4", style: "margin:0" }, "Hacking Program"),
      el("span", { class: "chip" + (meets ? " ok" : " neg") },
        active ? `rating ${rating} / required ${required}` : `rating ${rating}`)),
    el("p", { class: "hint" },
      "The loaded Hacking program must be rated at least ½ the active deck's MCP (round down, min 1)"
      + (active ? ` — min ${required} for ${active.Name} (MCP ${active.MCP})` : "")
      + `, plus any levels bought on top. Each level costs ${fmt(levelCost)} (max ${HACKING_RATING_MAX}).`),
    statLine("Program rating", String(rating)
      + (boughtLevels ? ` (${baseRating} at chargen + ${boughtLevels} in play)` : "")),
    el("div", { class: "add-row" },
      el("button", {
        class: "btn-add", disabled: rating >= HACKING_RATING_MAX ? "1" : null,
        onclick: async () => {
          if (CHAR.play.cash < levelCost
              && !confirm(`A rating level costs ${fmt(levelCost)} but you have ${fmt(CHAR.play.cash)}. Overdraw?`))
            return;
          CHAR.play.purchases.hacking_levels = boughtLevels + 1;
          logCash(`Hacking program rating ${rating} → ${rating + 1}`, -levelCost);
          await playChangedRecalc();
        },
      }, rating >= HACKING_RATING_MAX ? "At max (6)" : `Buy +1 rating (${fmt(levelCost)})`)));

  const threads = active ? +active.Threads : 0;
  const progCard = el("div", { class: "card sh-card" },
    el("div", { class: "sh-card-head" },
      el("h3", {}, "Programs"),
      el("span", { class: "chip" + (dk.loaded.length > threads ? " neg" : "") },
        `Loaded ${dk.loaded.length} / ${threads}`)),
    hackBox);   // the Hacking program lives at the top of the Programs section
  // Programs whose I/O is N/A or No are never loaded onto threads — they run
  // without occupying a thread slot, so no Load button is shown for them.
  const loadable = io => io !== "N/A" && io !== "No";
  CHAR.programs.forEach((name, pi) => {
    const r = DATA.tables.programs.find(x => x.Name === name) || {};
    const io = r["I/O"] || "—";
    const loaded = dk.loaded.includes(name);
    const nodeCtrl = ` · Node Control ${r["Node Control"] || "N"}`;
    progCard.append(el("div", { class: "sh-advrow" },
      el("span", {}, el("b", {}, name),
        el("span", { class: "sub" }, ` ${r.Attack || ""} · I/O ${io} · Alert ${r.Alert || 0}${nodeCtrl}`),
        r.Effect ? el("div", { class: "sub" }, r.Effect) : null),
      el("span", { style: "display:flex;gap:6px;align-items:center" },
        loadable(io)
          ? counterBtn(loaded ? "Unload" : "Load", () => {
              if (loaded) dk.loaded = dk.loaded.filter(n => n !== name);
              else if (dk.loaded.length >= threads) { alert("All threads are in use — unload something first."); return; }
              else dk.loaded.push(name);
              playChanged();
            }, loaded ? "" : "accent")
          : el("span", { class: "chip", title: `I/O ${io}: runs without occupying a thread` }, "no load"),
        el("button", { class: "row-del", title: "Remove program",
          onclick: () => {
            if (!confirm(`Remove program ${name}?`)) return;
            CHAR.programs.splice(pi, 1);
            dk.loaded = dk.loaded.filter(n => n !== name);
            playChangedRecalc();
          } }, "✕"))));
  });
  if (!CHAR.programs.length) progCard.append(el("p", { class: "hint" }, "No programs owned."));

  // buy new programs in play (grouped by Attack class, owned ones drop out)
  const ownedProg = new Set(CHAR.programs);
  const progByType = {};
  DATA.tables.programs.forEach(pr =>
    (progByType[pr.Attack || "Program"] ??= []).push(pr));
  const progGroups = Object.entries(progByType).sort(([a], [b]) => a.localeCompare(b))
    .map(([label, rows]) => ({
      label,
      items: rows.map(pr => ({
        name: pr.Name, cost: Math.round((+pr.Cost || 0) * mult),
        sub: `I/O ${pr["I/O"] || "—"} · Node Control ${pr["Node Control"] || "N"}${pr.Effect ? " · " + pr.Effect : ""}`,
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
        CHAR.programs.push(name);
        logCash(`Bought program ${name}`, -cost);
      } })));
  body.append(progCard);
  body.append(deckBuySection);
}

/* ------------------------------------------------ rigging tab */
// Per unit-type config: base table, weapon tables, mod table, name column.
const RIG_UNIT_CFG = {
  drones: {
    title: "Drones", table: "drones", nameKey: "Drone",
    weaponTables: [["drone_ballistic_weapons", "Drone Ballistic Weapon"],
                   ["drone_energy_weapons", "Drone Energy Weapon"]],
    modTable: ["drone_mods", "Drone Mod"],
    capLabel: "Hard points", capOf: r => toInt(r["Hard Point"]),
  },
  vehicles: {
    title: "Vehicles", table: "vehicles", nameKey: "Vehicle",
    weaponTables: [["vehicle_ballistic_weapons", "Vehicle Ballistic Weapon"],
                   ["vehicle_energy_weapons", "Vehicle Energy Weapon"]],
    modTable: ["vehicle_mods", "Vehicle Mod"],
    capLabel: "Weapon cap", capOf: r => Math.floor(toInt(r.Body) / 3),
  },
};
function toInt(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; }

function shRigging(body) {
  const rg = CHAR.play.rigging;
  rg.linked = rg.linked || {};
  const mult = CALC.budget.gear_cost_multiplier || 1;
  if (CHAR.rigs.length && !CHAR.rigs.some(r => r.name === rg.active_rig))
    rg.active_rig = CHAR.rigs[0].name;

  const activeRig = CHAR.rigs.find(r => r.name === rg.active_rig);
  const linkLimit = activeRig ? RULES.rigStats(activeRig, DATA.tables).links : 0;
  const linkedCount = () => Object.values(rg.linked).filter(Boolean).length;
  // All "buy new unit" browsers collect here and render at the bottom.
  const rigBuySection = el("div", { class: "card sh-card", id: "rig-buy" },
    el("h3", {}, "Buy rigs, drones & vehicles"),
    el("p", { class: "hint" }, "New units are purchased here; configure owned ones above."));

  // --- VCRs
  const rigCard = el("div", { class: "card sh-card" }, el("h3", {}, "Vehicle Control Rigs"));
  CHAR.rigs.forEach((r, ri) => {
    const st = RULES.rigStats(r, DATA.tables);
    const isActive = r.name === rg.active_rig;
    r.mods = r.mods || [];
    const modEditor = fittedCategoryEditor({
      id: `sh-rmods-${ri}-${r.name}`,
      items: r.mods,
      groups: modGroups(DATA.tables.rig_mods, "Rig Mod", null, "Rig Mods"),
      onAdd: name => {
        const mr = DATA.tables.rig_mods.find(m => m["Rig Mod"] === name) || {};
        const cost = Math.round((+mr.Cost || 0) * mult);
        if (CHAR.play.cash < cost
            && !confirm(`${name} costs ${fmt(cost)} but you have ${fmt(CHAR.play.cash)}. Overdraw?`)) return;
        r.mods.push(name);
        logCash(`Fitted ${name} to ${r.name}`, -cost);
      },
      onRemove: index => { r.mods.splice(index, 1); },
      effectOf: name => (DATA.tables.rig_mods.find(m => m["Rig Mod"] === name) || {}).Effect || "",
      rerender: renderSheet, afterAdd: () => playChangedRecalc(),
    });
    rigCard.append(el("div", { class: "sh-unit" },
      el("div", {},
        el("div", { class: "sh-advrow" + (isActive ? " active-row" : ""), style: "border:0;padding:0" },
          el("span", {}, el("b", {}, r.name),
            el("span", { class: "sub" },
              ` +${st.bonusDice}d · Hardening ${st.hardening >= 0 ? "+" : ""}${st.hardening} · Links ${st.links} · Cores ${st.cores}`)),
          isActive ? el("span", { class: "chip ok" }, "Active VCR")
            : counterBtn("Set Active", () => { rg.active_rig = r.name; playChanged(); })),
        el("div", { class: "sh-unit-add" }, el("b", {}, "Mods"), modEditor)),
      el("button", { class: "row-del", title: "Sell / remove VCR",
        onclick: () => {
          if (!confirm(`Remove ${r.name}? Fitted mods are lost.`)) return;
          CHAR.rigs.splice(ri, 1);
          if (rg.active_rig === r.name) rg.active_rig = "";
          playChangedRecalc();
        } }, "✕")));
  });
  if (CHAR.rigs.length)
    rigCard.append(el("p", { class: "hint" },
      `Active VCR links ${linkedCount()} / ${linkLimit} units.`));
  else
    rigCard.append(el("p", { class: "hint" }, "No rigs owned — drones are piloted unlinked."));
  // buy a new VCR in play
  const rigGroups = [{ label: "Vehicle Control Rigs", items: DATA.tables.rigs.map(x => ({
    name: x["Rig Type"], cost: Math.round((+x.Cost || 0) * mult),
    sub: `+${x["Bonus Dice"]}d · Links ${x.Links} · Cores ${x.Cores}` })) }];
  rigBuySection.append(el("div", { class: "sh-unit-add" }, el("b", {}, "Buy VCR"),
    categoryBrowser({ id: "buy-rigs", groups: rigGroups,
      rerender: renderSheet, afterAdd: () => playChangedRecalc(),
      onAdd: name => {
        const row = DATA.tables.rigs.find(x => x["Rig Type"] === name) || {};
        const cost = Math.round((+row.Cost || 0) * mult);
        if (CHAR.play.cash < cost
            && !confirm(`${name} costs ${fmt(cost)} but you have ${fmt(CHAR.play.cash)}. Overdraw?`)) return;
        CHAR.rigs.push({ name, mods: [] });
        logCash(`Bought ${name}`, -cost);
      } })));
  body.append(rigCard);

  const unitBlock = (cfg, list, calcArr) => {
    const card = el("div", { class: "card sh-card" }, el("h3", {}, cfg.title));
    list.forEach((u, i) => {
      const r = DATA.tables[cfg.table].find(x => x[cfg.nameKey] === u.name) || {};
      const summary = (calcArr || [])[i] || {};
      const key = `${cfg.table}:${i}`;
      const st = rg.units[key] = rg.units[key] || { damage: 0, inertia: 0 };
      u.weapons = u.weapons || []; u.mods = u.mods || [];

      // editable custom name
      const nameInput = el("input", { value: u.label || "", placeholder: u.name,
        style: "font-weight:600;width:180px",
        onchange: e => { u.label = e.target.value.trim(); playChanged(); } });

      // fitted weapons with stats (extended-magazine applied from unit mods)
      const findWeapon = wn => {
        for (const [tk, nc] of cfg.weaponTables) {
          const wr = DATA.tables[tk].find(x => x[nc] === wn);
          if (wr) return wr;
        }
        return null;
      };
      const weaponRows = u.weapons.map((wn, wi) => {
        const wr = findWeapon(wn) || {};
        const ammo = RULES.applyExtendedMagazine(wr.Ammo, u.mods);
        const effect = wr.Effect || wr.ModeEffect || "";
        return el("div", { class: "sub" },
          el("span", { class: "chip", style: "cursor:pointer", title: "Remove weapon",
            onclick: () => { u.weapons.splice(wi, 1); playChangedRecalc(); } }, wn + " ✕"),
          ` DMG ${wr.Damage || "—"} · Acc ${wr.Accuracy || 0}`
          + (ammo ? ` · Ammo ${ammo}` : "") + (wr.Pen ? ` · Pen ${wr.Pen}` : ""),
          effect ? el("div", { class: "sub", style: "margin:2px 0 0 4px;color:var(--manon)" }, effect) : null);
      });

      const [mtk0, mnc0] = cfg.modTable;
      const modRows = u.mods.map((mn, mi) => {
        const mr = DATA.tables[mtk0].find(x => x[mnc0] === mn) || {};
        const effect = mr.Effect || mr.ModeEffect || "";
        return el("div", { class: "sub" },
          el("span", { class: "chip", style: "margin:2px 4px 0 0;cursor:pointer", title: "Remove mod",
            onclick: () => { u.mods.splice(mi, 1); playChangedRecalc(); } }, mn + " ✕"),
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
          u.weapons.push(name); logCash(`Mounted ${name} on ${u.label || u.name}`, -cost);
        },
        onRemove: () => {}, rerender: renderSheet, afterAdd: () => playChangedRecalc(),
      });
      const [mtk, mnc] = cfg.modTable;
      const addMod = fittedCategoryEditor({
        id: `rig-m-${key}`, items: [],
        groups: modGroups(DATA.tables[mtk], mnc, null, `${cfg.nameKey} Mods`),
        onAdd: name => {
          const mr = DATA.tables[mtk].find(x => x[mnc] === name) || {};
          const cost = Math.round((+mr.Cost || 0) * mult);
          if (CHAR.play.cash < cost
              && !confirm(`${name} costs ${fmt(cost)} but you have ${fmt(CHAR.play.cash)}. Overdraw?`)) return;
          u.mods.push(name); logCash(`Fitted ${name} to ${u.label || u.name}`, -cost);
        },
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
          } }),
        el("span", {}, isLinked ? "Linked to VCR" : "Link to VCR"));

      // Weapons + mods + their pickers collapse into a <details> to keep the
      // list scannable; open state persists per unit across re-renders.
      rg.unit_open = rg.unit_open || {};
      const wCount = u.weapons.length, mCount = u.mods.length;
      const details = el("details", { class: "sh-unit-details",
        ...(rg.unit_open[key] ? { open: "1" } : {}),
        ontoggle: e => { rg.unit_open[key] = e.target.open; schedulePlaySave(); } },
        el("summary", {}, `Weapons & mods (${wCount} weapon${wCount === 1 ? "" : "s"}, ${mCount} mod${mCount === 1 ? "" : "s"})`),
        weaponRows.length ? el("div", {}, ...weaponRows) : null,
        modRows.length ? el("div", { class: "sub" }, el("b", {}, "Mods:"), ...modRows) : null,
        el("div", { class: "sh-unit-add" },
          el("div", { class: "sub" }, el("b", {}, "Add weapon"), addWeapon),
          el("div", { class: "sub" }, el("b", {}, "Add mod"), addMod)));

      card.append(el("div", { class: "sh-unit" },
        el("div", {},
          nameInput,
          el("div", { class: "sub" }, el("b", {}, u.name), " · ",
            `Move ${r.Move} · Handling ${r.Handling} · Body ${r.Body}`
            + (r.Ballistic || r.Impact ? ` · Armor ${r.Ballistic || 0}B/${r.Impact || 0}I` : "")
            + ` · weapons ${summary.weapon_count ?? u.weapons.length}/${summary.weapon_cap ?? cfg.capOf(r)}`),
          r.Effect ? el("div", { class: "sub", style: "color:var(--manon)" }, r.Effect) : null,
          details,
          activeRig ? linkToggle : null),
        el("div", { class: "sh-unit-ctr" },
          miniCounter("Damage", () => st.damage, v => { st.damage = v; }),
          miniCounter("Inertia", () => st.inertia, v => { st.inertia = v; }),
          el("button", { class: "row-del", title: "Sell / remove unit",
            onclick: () => {
              if (!confirm(`Remove ${u.label || u.name}?`)) return;
              list.splice(i, 1); delete rg.linked[key]; playChangedRecalc();
            } }, "✕"))));
    });
    if (!list.length) card.append(el("p", { class: "hint" }, `No ${cfg.title.toLowerCase()} owned.`));
    body.append(card);

    // buy a new unit — rendered in the bottom Buy section
    const buyGroups = [{ label: cfg.title, items: DATA.tables[cfg.table].map(x => ({
      name: x[cfg.nameKey], cost: Math.round((+x.Cost || 0) * mult),
      sub: `Body ${x.Body} · Move ${x.Move} · Handling ${x.Handling}` })) }];
    rigBuySection.append(el("div", { class: "sh-unit-add" }, el("b", {}, `Buy new ${cfg.title.toLowerCase().replace(/s$/, "")}`),
      categoryBrowser({ id: `buy-${cfg.table}`, groups: buyGroups,
        rerender: renderSheet, afterAdd: () => playChangedRecalc(),
        onAdd: name => {
          const row = DATA.tables[cfg.table].find(x => x[cfg.nameKey] === name) || {};
          const cost = Math.round((+row.Cost || 0) * mult);
          if (CHAR.play.cash < cost
              && !confirm(`${name} costs ${fmt(cost)} but you have ${fmt(CHAR.play.cash)}. Overdraw?`)) return;
          list.push({ name, weapons: [], mods: [] });
          logCash(`Bought ${name}`, -cost);
        } })));
  };
  unitBlock(RIG_UNIT_CFG.drones, CHAR.drones, CALC.drones);
  unitBlock(RIG_UNIT_CFG.vehicles, CHAR.vehicles, CALC.vehicles);
  body.append(rigBuySection);
}

/* ------------------------------------------------ notes tab */
function shNotes(body) {
  const autos = dossierNotes();
  if (autos.length) {
    const card = el("div", { class: "card sh-card" },
      el("h3", {}, "Dossier Notes"),
      el("p", { class: "hint" }, "Generated from your build — reminders that don't fit the other tabs."));
    autos.forEach(n => card.append(el("div", { class: "sh-callout" }, "⚠ ", n)));
    body.append(card);
  }
  const traits = heritageTraitsCard();
  if (traits) body.append(traits);
  body.append(notesCard(18));
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
  L.push(`**Player:** ${CHAR.player || "—"} · **Heritage:** ${heritageLabel} · **Magic:** ${CALC.magic.type}`);
  L.push("");
  for (const note of dossierNotes()) L.push(`> ⚠ ${note}`);
  L.push("");

  L.push("## Attributes");
  L.push("");
  L.push("| " + ATTR_ABBR.map(([, ab]) => ab).join(" | ") + " |");
  L.push("|" + ATTR_ABBR.map(() => "---").join("|") + "|");
  L.push("| " + ATTR_ABBR.map(([full]) => CALC.attributes[full].final).join(" | ") + " |");
  L.push("");

  L.push("## Pools & Condition");
  L.push("");
  L.push("| Brawn | Finesse | Focus | Resolve |");
  L.push("|---|---|---|---|");
  L.push("| " + POOL_ORDER.map(p => CALC.pools[p]).join(" | ") + " |");
  L.push("");
  L.push(`**Physical:** ${CALC.condition.physical} boxes · **Stun:** ${CALC.condition.stun} boxes`);
  L.push(`**Move:** ${c.move} m${moveSpecial() ? " (" + moveSpecial() + ")" : ""} · **Armor:** ${c.ballistic_armor}B / ${c.impact_armor}I · **Simple actions:** ${c.simple_actions}`);
  L.push("");
  L.push("*Wound rule: every 3 boxes marked on either track = −1 die on tasks, cumulative. Biotech can remove these penalties during combat.*");
  L.push("");

  L.push("## Skills");
  L.push("");
  for (const pool of POOL_ORDER) {
    const trained = Object.entries(DATA.skills)
      .filter(([n, m]) => m.pool === pool && CALC.skills[n].final > 0)
      .sort((a, b) => CALC.skills[b[0]].final - CALC.skills[a[0]].final);
    if (!trained.length) continue;
    L.push(`**${pool} (${CALC.pools[pool]}d)**: `
      + trained.map(([n]) => `${n} ${CALC.skills[n].final}`).join(" · "));
    L.push("");
  }
  const etqList = Object.entries(CHAR.etiquettes || {}).filter(([, v]) => v > 0);
  if (etqList.length) {
    L.push("**Etiquettes:** " + etqList.map(([n, v]) => `${n} ${v}`).join(" · "));
    L.push("");
  }
  const knows = CHAR.knowledge_skills.filter(k => k.name);
  if (knows.length) {
    L.push("**Knowledges:** " + knows.map(k => `${k.name} ${k.points || 0}`).join(" · "));
    L.push("");
  }
  const ritualList = Object.entries(CALC.ritual_skills || {}).filter(([, v]) => v > 0);
  if (ritualList.length) {
    L.push("**Ritual skills:** " + ritualList.map(([n, v]) => `${n} ${v}`).join(" · "));
    L.push("");
  }
  if (CALC.martial_art.style) {
    L.push(`**Martial Art:** ${CALC.martial_art.style} — `
      + CALC.martial_art.levels.map(l => `L${l.Level}: ${l.Effect}`).join("; "));
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
    if (CHAR.speaker.relationships.length)
      L.push("**Spirit relationships:** " + CHAR.speaker.relationships.join(" · ")
        + ` (bonds: ${CHAR.speaker.bonds || 0})`);
    if (CHAR.speaker.infusions.length)
      L.push("**Infusions:** " + CHAR.speaker.infusions.join(" · "));
    L.push("");
  }

  const allAugments = [...CHAR.augments, ...play.purchases.augments];
  if (allAugments.length) {
    L.push("## Augments");
    L.push("");
    allAugments.forEach(a => L.push(`- ${a.name}${(a.count || 1) > 1 ? ` ×${a.count}` : ""}`));
    L.push("");
  }
  if (CHAR.weapons.length) {
    L.push("## Weapons");
    L.push("");
    CHAR.weapons.forEach(w => {
      const r = DATA.tables.weapons.find(x => x.Weapon === w.name) || {};
      L.push(`- **${w.name}**${w.smart ? " (smart)" : ""} — DMG ${r.Damage || "—"}, Acc ${r.Accuracy || 0}, Pen ${r.Pen || 0}`
        + ((w.mods || []).length ? ` (${w.mods.join(", ")})` : ""));
    });
    L.push("");
  }
  if (CHAR.armor.length) {
    L.push("## Armor");
    L.push("");
    CHAR.armor.forEach(a => {
      const r = DATA.tables.armor.find(x => x.Armor === a.name) || {};
      L.push(`- **${a.name}** — ${r.Ballistic || 0}B/${r.Impact || 0}I${a.active !== false ? " (worn)" : ""}`);
    });
    L.push("");
  }
  const allGear = [...CHAR.gear, ...play.purchases.gear];
  if (allGear.length || play.lifestyles.length) {
    L.push("## Gear");
    L.push("");
    allGear.forEach(g => L.push(`- ${g.name}${(g.qty || 1) > 1 ? ` ×${g.qty}` : ""}`));
    play.lifestyles.forEach(ls => {
      L.push(`- Lifestyle: ${ls.name} — ${ls.months || 0} month(s) prepaid${ls.active ? " **(current)**" : ""}`);
      if (ls.active && LIFESTYLE_EFFECTS[ls.name])
        L.push(`  - *Effect:* ${LIFESTYLE_EFFECTS[ls.name]}`);
    });
    L.push("");
  }
  if (CHAR.decks.length || CHAR.programs.length) {
    L.push("## Decking");
    L.push("");
    CHAR.decks.forEach(d => L.push(`- Deck: **${d.name}**${(d.mods || []).length ? ` (${d.mods.join(", ")})` : ""}`));
    if (CHAR.programs.length) L.push("- Programs: " + CHAR.programs.join(" · "));
    const hackingRating = (CHAR.hacking_rating || 0) + (play.purchases.hacking_levels || 0);
    if (hackingRating) L.push(`- Hacking program rating: ${hackingRating}`);
    L.push("");
  }
  if (CHAR.rigs.length || CHAR.drones.length || CHAR.vehicles.length) {
    L.push("## Rigging");
    L.push("");
    CHAR.rigs.forEach(r => L.push(`- Rig: **${r.name}**`));
    CHAR.drones.forEach(d => L.push(`- Drone: **${d.name}**${(d.weapons || []).length ? ` (${d.weapons.join(", ")})` : ""}`));
    CHAR.vehicles.forEach(v => L.push(`- Vehicle: **${v.name}**${(v.weapons || []).length ? ` (${v.weapons.join(", ")})` : ""}`));
    L.push("");
  }

  L.push("## Wealth & Advancement");
  L.push("");
  L.push(`**Zuzus:** ${fmt(play.cash)} · **Kismet:** ${play.kismet} available / ${play.kismet_earned} lifetime · **Boons:** ${econ.regularsAvail} regular, ${econ.majorsAvail} major available`);
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
  L.push(`*Exported from the Sinless Character Dossier · ${new Date().toISOString().slice(0, 10)}*`);
  return L.join("\n");
}
