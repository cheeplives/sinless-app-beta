/**
 * Sinless character dossier — frontend.
 *
 * No build step, no framework: plain DOM construction via the `el()`
 * helper below. State lives in three module-level variables:
 *
 *   DATA  - game data tables + rule constants (the DATA_BUNDLE from
 *           data.js). Loaded once at boot; mutated only by the homebrew
 *           merge (homebrew.js), which splices user rows into the tables.
 *   CHAR  - the character being edited. Every input handler in this file
 *           mutates CHAR directly, then calls scheduleRecalc() or refresh().
 *   CALC  - the derived character sheet from the last RULES.calculate(CHAR).
 *           Read-only from here; never edit CALC directly, it's overwritten
 *           wholesale on every recalc.
 *
 * Edit lifecycle: a control's event handler mutates CHAR -> calls
 * scheduleRecalc() (debounced) or refresh() (immediate) -> that runs
 * RULES.calculate(CHAR) -> CALC is replaced with the result -> renderRail()
 * and the current tab's render function redraw from DATA/CHAR/CALC.
 *
 * Tabs: each tab is one render function (tabPriorities, tabHeritage, ...)
 * that takes the <section id="panel"> element and appends its DOM into it.
 * renderPanel() clears #panel and calls whichever one is active.
 */
"use strict";

let DATA = null;      // game data tables + constants (see header above)
let CHAR = null;      // character being edited
let CALC = null;      // last calculation result
let activeTab = "priorities";
let calcTimer = null;

const RECALC_DEBOUNCE_MS = 200;   // how long to wait after a keystroke/stepper click before recalculating
const CURRENCY_SYMBOL = "\u3113"; // woolongs, this setting's currency

const $ = (sel, el = document) => el.querySelector(sel);

/** Build one DOM element. `attrs.class`/`on*` map to className/listeners;
 * any other key becomes a real attribute, and null/undefined attrs are
 * skipped entirely (never stringified — that's what caused a bug where
 * `disabled: null` rendered as the literal attribute disabled="null").
 * Children are appended as-is; strings become text nodes automatically
 * via Node.append(), so there is no raw-HTML injection path here by
 * construction — build any dynamic HTML-flavored content as real nodes,
 * not with innerHTML. */
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;              // skip null/undefined -> no attribute at all
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const k of kids) if (k != null) n.append(k);
  return n;
};
const fmt = amount => CURRENCY_SYMBOL + Number(amount || 0).toLocaleString();

/* Raw dice-pool formulas (match computePools in rules.js). Shown on the
 * chargen skills page so the composition is visible even before the "Nd"
 * total recalculates. */
const POOL_FORMULAS = {
  Brawn: "1×STR + ½ BOD + ¼ WIL",
  Finesse: "½ BOD + 1×REA + ¼ INT",
  Focus: "½ REA + 1×INT + ¼ WIL",
  Resolve: "½ INT + 1×WIL + ½ CHA",
};

/* ------------------------------------------------ boot */
/* Fully client-side: game data comes from data.js (DATA_BUNDLE), the
 * engine from rules.js (RULES), persistence from storage.js (STORAGE).
 * recalc() is synchronous but stays `async`-shaped so the many
 * `await recalc()` call sites read uniformly. */
async function boot() {
  DATA = DATA_BUNDLE;
  mergeCustomContent();   // homebrew.js: splice user-created rows into the tables
  CHAR = RULES.defaultCharacter();
  initTheme();
  bindRail();
  renderTabs();
  await recalc();
  renderPanel();
  refreshLoadList();
}

/* Theme is applied pre-paint by the inline script in index.html; this just
 * wires up the toggle button and keeps its icon + the PWA theme-color meta
 * in sync with whichever theme is active. */
function initTheme() {
  const btn = $("#theme-toggle");
  const meta = $('meta[name="theme-color"]');
  const THEME_COLOR = { dark: "#0d1017", light: "#f2f3f8" };
  const applyIcon = theme => {
    btn.textContent = theme === "light" ? "☀" : "🌙";
    btn.setAttribute("aria-label", `Switch to ${theme === "light" ? "dark" : "light"} theme`);
    if (meta) meta.setAttribute("content", THEME_COLOR[theme]);
  };
  applyIcon(document.documentElement.getAttribute("data-theme") || "dark");
  btn.addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("sinless:theme", next); } catch { /* best-effort persistence */ }
    applyIcon(next);
  });
}

function scheduleRecalc() {
  clearTimeout(calcTimer);
  calcTimer = setTimeout(recalc, RECALC_DEBOUNCE_MS);
}
async function recalc() {
  CALC = RULES.calculate(CHAR);
  renderRail();
  renderBudgetChips();
  // keep the Finalize button's error gate current without a full re-render
  const finalizeBtn = $("#btn-finalize");
  if (finalizeBtn) {
    const blocked = !!(CALC.errors && CALC.errors.length);
    finalizeBtn.disabled = blocked;
    finalizeBtn.textContent = blocked ? "Resolve errors to finalize" : "Finalize Character ✓";
  }
}

/* ------------------------------------------------ rail */
function bindRail() {
  $("#char-name").addEventListener("input", e => { CHAR.name = e.target.value; });
  $("#char-player").addEventListener("input", e => { CHAR.player = e.target.value; });
  $("#btn-save").addEventListener("click", () => {
    if (!CHAR.name) { alert("Give the character a street name first."); return; }
    STORAGE.saveCharacter(CHAR);
    refreshLoadList();
  });
  $("#btn-new").addEventListener("click", async () => {
    CHAR = RULES.defaultCharacter();
    $("#char-name").value = ""; $("#char-player").value = "";
    exitSheet();
    await recalc(); renderPanel();
  });
  $("#btn-export").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(CHAR, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: (CHAR.name || "character") + ".json" });
    a.click();
    URL.revokeObjectURL(url);   // release the blob; the click has already fired
  });
  $("#btn-homebrew").addEventListener("click", enterHomebrew);
  $("#btn-import").addEventListener("click", () => $("#import-file").click());
  $("#import-file").addEventListener("change", async e => {
    const file = e.target.files[0];
    e.target.value = "";   // allow re-importing the same file later
    if (!file) return;
    let parsed;
    try { parsed = JSON.parse(await file.text()); } catch { parsed = null; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !parsed.attributes) {
      alert("That file doesn't look like an exported Sinless character.");
      return;
    }
    CHAR = RULES.mergeDefaults(parsed);
    $("#char-name").value = CHAR.name || "";
    $("#char-player").value = CHAR.player || "";
    STORAGE.saveCharacter(CHAR);
    refreshLoadList();
    await recalc();
    if (CHAR.finalized) enterSheet(); else { exitSheet(); renderPanel(); }
  });
  $("#load-select").addEventListener("change", async e => {
    const name = e.target.value;
    if (!name) return;
    const loaded = STORAGE.loadCharacter(name);
    if (!loaded) { e.target.value = ""; return; }
    CHAR = RULES.mergeDefaults(loaded);
    $("#char-name").value = CHAR.name || "";
    $("#char-player").value = CHAR.player || "";
    await recalc();
    if (CHAR.finalized) enterSheet(); else { exitSheet(); renderPanel(); }
    e.target.value = "";
  });
  $("#delete-select").addEventListener("change", async e => {
    const name = e.target.value;
    e.target.value = "";
    if (!name) return;
    await deleteSavedCharacter(name);
  });
}

/* Permanently remove a saved character. If it's the one currently open,
 * also reset to a fresh character — otherwise the next autosave would
 * quietly resurrect the deleted slot. */
async function deleteSavedCharacter(name) {
  if (!name) return;
  if (!confirm(`Delete ${name}? The saved character is permanently removed.`)) return;
  STORAGE.deleteCharacter(name);
  refreshLoadList();
  if (STORAGE.sanitizeName(CHAR.name) === STORAGE.sanitizeName(name)) {
    CHAR = RULES.defaultCharacter();
    $("#char-name").value = ""; $("#char-player").value = "";
    exitSheet();
    await recalc(); renderPanel();
  }
}
function refreshLoadList() {
  const names = STORAGE.listCharacters();
  $("#load-select").replaceChildren(
    el("option", { value: "" }, "Load\u2026"),
    ...names.map(name => el("option", {}, name)));
  $("#delete-select").replaceChildren(
    el("option", { value: "" }, "Delete\u2026"),
    ...names.map(name => el("option", {}, name)));
}

function budgetRow(label, remaining, budget) {
  const cls = remaining < 0 ? "neg" : remaining === 0 ? "zero" : "";
  return el("div", { class: "budget" },
    el("span", { class: "lbl" }, label),
    el("span", { class: `val ${cls}` }, `${remaining}${budget != null ? " / " + budget : ""}`));
}

function renderRail() {
  if (!CALC) return;
  // pools
  const pg = $("#rail-pools"); pg.innerHTML = "";
  for (const [k, v] of Object.entries(CALC.pools)) {
    pg.append(el("div", { class: "pool-die" },
      el("div", { class: "v" }, String(v)), el("div", { class: "k" }, k)));
  }
  // condition
  const rc = $("#rail-condition"); rc.innerHTML = "";
  rc.append(
    el("div", { class: "track" }, el("span", {}, "Physical"), el("b", {}, String(CALC.condition.physical))),
    el("div", { class: "track" }, el("span", {}, "Stun"), el("b", {}, String(CALC.condition.stun))),
    el("div", { class: "track" }, el("span", {}, "Move"), el("b", {}, CALC.combat.move + " m")),
    el("div", { class: "track" }, el("span", {}, "Armor B / I"),
      el("b", {}, `${CALC.combat.ballistic_armor} / ${CALC.combat.impact_armor}`)),
    el("div", { class: "track track-sub" }, el("span", {}, "Max B / Min I"),
      el("b", {}, `${CALC.combat.max_ballistic} / ${CALC.combat.min_impact}`)));
  for (const note of (CALC.combat.move_special || [])) {
    rc.append(el("div", { class: "track track-special" },
      el("span", {}, "Special move"), el("b", {}, note)));
  }
  // budgets
  const rb = $("#rail-budgets"); rb.innerHTML = "";
  rb.append(
    budgetRow("Priority pts", CALC.priorities.remaining, 10),
    budgetRow("Attribute pts", CALC.attr_points.remaining, CALC.attr_points.budget),
    budgetRow("Skill pts", CALC.skill_points.remaining, CALC.skill_points.budget),
    budgetRow("Knowledge pts", CALC.knowledge.remaining, CALC.knowledge.budget),
    budgetRow("Etiquette pts", CALC.etiquette_points.remaining, CALC.etiquette_points.budget));
  const m = CALC.magic;
  if (m.type === "Mage" || m.type === "Archmage")
    rb.append(budgetRow("Starting Force", m.force_remaining, m.start_force));
  if (m.type === "Amp" || m.type === "Archmage")
    rb.append(budgetRow("Amp ZP", m.amp_zp_remaining, m.amp_zp_budget));
  if (m.type === "Speaker") {   // Archmages buy Speaker options with Force instead
    rb.append(budgetRow("Infusion pts", m.infusion_pts.remaining, m.infusion_pts.budget));
    rb.append(budgetRow("Relationship pts", m.relationship_pts.remaining, m.relationship_pts.budget));
  }
  rb.append(budgetRow("Body Index", CALC.attributes.Body.final - CALC.zoetics.body_index,
                       CALC.attributes.Body.final));
  const cashRow = el("div", { class: "budget" },
    el("span", { class: "lbl" }, "Cash"),
    el("span", { class: `val ${CALC.budget.remaining < 0 ? "neg" : ""}` },
      fmt(CALC.budget.remaining)));
  rb.append(cashRow);
  // zoetics
  const rz = $("#rail-zoetics"); rz.innerHTML = "";
  const z = CALC.zoetics;
  rz.append(
    el("div", { class: "track" }, el("span", {}, "ZP"), el("b", {}, String(z.zp))),
    el("div", { class: "track" }, el("span", {}, "Cyber/Gear ZR"), el("b", {}, String(z.cyber_zr))),
    ...(z.mounted_zr ? [el("div", { class: "track",
        title: "ZR of augments mounted on gear — never counts against your ZP" },
      el("span", {}, "Mounted ZR (exempt)"), el("b", {}, String(z.mounted_zr)))] : []),
    el("div", { class: "track" }, el("span", {}, "Amp ZR"), el("b", {}, String(z.amp_zr))),
    el("div", { class: "track" }, el("span", {}, "Body Index"),
      el("b", { style: z.body_index_ok ? "" : "color:var(--bad)" }, String(z.body_index))));
  // alerts
  const ra = $("#rail-alerts"); ra.innerHTML = "";
  for (const e2 of CALC.errors) ra.append(el("div", { class: "alert" }, e2));
  for (const w of CALC.warnings) ra.append(el("div", { class: "alert warn" }, w));
}

/* budget chips inside panels get refreshed without a full re-render */
function renderBudgetChips() {
  document.querySelectorAll("[data-chip]").forEach(n => {
    const key = n.dataset.chip;
    const v = chipValue(key);
    if (v == null) return;
    n.textContent = v.text;
    n.className = "chip " + (v.cls || "") + (n.dataset.magic ? " magic" : "");
  });
}
function chipValue(key) {
  if (!CALC) return null;
  const m = CALC.magic;
  switch (key) {
    case "prio": return { text: `${CALC.priorities.remaining} left`, cls: CALC.priorities.remaining < 0 ? "neg" : CALC.priorities.remaining === 0 ? "ok" : "" };
    case "attr": return { text: `${CALC.attr_points.remaining} / ${CALC.attr_points.budget} pts left`, cls: CALC.attr_points.remaining < 0 ? "neg" : "" };
    case "skill": return { text: `${CALC.skill_points.remaining} / ${CALC.skill_points.budget} pts left`, cls: CALC.skill_points.remaining < 0 ? "neg" : "" };
    case "know": return { text: `${CALC.knowledge.remaining} / ${CALC.knowledge.budget} pts left`, cls: CALC.knowledge.remaining < 0 ? "neg" : "" };
    case "etq": return { text: `${CALC.etiquette_points.remaining} / ${CALC.etiquette_points.budget} pts left`, cls: CALC.etiquette_points.remaining < 0 ? "neg" : "" };
    case "force": return { text: `${m.force_remaining} / ${m.start_force} Force left`, cls: m.force_remaining < 0 ? "neg" : "" };
    case "zp": return { text: `${m.amp_zp_remaining} / ${m.amp_zp_budget} ZP left`, cls: m.amp_zp_remaining < 0 ? "neg" : "" };
    case "inf": return { text: `${m.infusion_pts.remaining} / ${m.infusion_pts.budget} left`, cls: m.infusion_pts.remaining < 0 ? "neg" : "" };
    case "rel": return { text: `${m.relationship_pts.remaining} / ${m.relationship_pts.budget} left`, cls: m.relationship_pts.remaining < 0 ? "neg" : "" };
    case "cash": return { text: `${fmt(CALC.budget.remaining)} left`, cls: CALC.budget.remaining < 0 ? "neg" : "" };
  }
  return null;
}
const chip = (key, magic) => el("span", Object.assign({ class: "chip", "data-chip": key }, magic ? { "data-magic": "1" } : {}), "\u2026");

/* ------------------------------------------------ tabs */
const TABS = [
  ["priorities", "Priorities"],
  ["heritage", "Heritage"],
  ["stats", "Stats & Skills"],
  ["knowledge", "Knowledge & Etiquette"],
  ["magic", "Magic & Rituals"],
  ["speaker", "Speaker"],
  ["augments", "Augments"],
  ["weapons", "Weapons & Armor"],
  ["decks", "Decks & Programs"],
  ["drones", "Drones & Vehicles"],
  ["gear", "Gear & Costs"],
];
function renderTabs() {
  const nav = $("#tabs"); nav.innerHTML = "";
  for (const [id, label] of TABS) {
    nav.append(el("button", {
      class: id === activeTab ? "active" : "",
      onclick: () => { activeTab = id; renderTabs(); renderPanel(); },
    }, label));
  }
}
function renderPanel() {
  const p = $("#panel"); p.innerHTML = "";
  ({
    priorities: tabPriorities, heritage: tabHeritage, stats: tabStats,
    knowledge: tabKnowledge, magic: tabMagic, speaker: tabSpeaker,
    augments: tabAugments, weapons: tabWeapons, decks: tabDecks,
    drones: tabDrones, gear: tabGear,
  })[activeTab](p);
  renderPanelNav(p);
  renderBudgetChips();
}
function renderPanelNav(p) {
  const idx = TABS.findIndex(([id]) => id === activeTab);
  if (idx === TABS.length - 1) {
    const blocked = !!(CALC && CALC.errors && CALC.errors.length);
    p.append(el("div", { class: "panel-nav" },
      el("button", { id: "btn-finalize", class: "btn-add",
        disabled: blocked ? "1" : null, onclick: finalizeCharacter },
        blocked ? "Resolve errors to finalize" : "Finalize Character ✓"),
      el("p", { class: "hint", style: "margin-top:8px" },
        "Locks character generation. Any unspent points — attribute, skill, magic, and remaining cash — are lost. "
        + "Unspent Knowledge points carry over and stay spendable on the character sheet. "
        + "A character with outstanding errors (red alerts) cannot be finalized.")));
    return;
  }
  const [, nextLabel] = TABS[idx + 1];
  p.append(el("div", { class: "panel-nav" },
    el("button", { class: "btn", onclick: () => {
      activeTab = TABS[idx + 1][0];
      renderTabs(); renderPanel();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } }, `Next: ${nextLabel} →`)));
}

/* ------------------------------------------------ finalize -> play mode */
function unspentSummary() {
  const lines = [];
  const add = (label, value, money) => {
    if (value > 0) lines.push(`  • ${label}: ${money ? fmt(value) : value}`);
  };
  add("Priority points", CALC.priorities.remaining);
  add("Attribute points", CALC.attr_points.remaining);
  add("Skill points", CALC.skill_points.remaining);
  // Knowledge points are deliberately excluded — they carry over and stay
  // spendable on the character sheet instead of being forfeited.
  add("Etiquette points", CALC.etiquette_points.remaining);
  const m = CALC.magic;
  if (m.type === "Mage" || m.type === "Archmage") add("Starting Force", m.force_remaining);
  if (m.type === "Amp" || m.type === "Archmage") add("Amp ZP", m.amp_zp_remaining);
  if (m.type === "Speaker") {   // Archmage speaker spends already count against Force
    add("Infusion points", m.infusion_pts.remaining);
    add("Relationship points", m.relationship_pts.remaining);
  }
  add("Cash", CALC.budget.remaining, true);
  return lines;
}
async function finalizeCharacter() {
  if (!CHAR.name) { alert("Give the character a street name first — the sheet saves under it."); return; }
  await recalc();
  if (CALC.errors.length) {
    alert("Resolve these problems before finalizing:\n\n" + CALC.errors.join("\n"));
    return;
  }
  const lost = unspentSummary();
  const msg = "Finalize this character?\n\n"
    + (lost.length
      ? "These unspent points are LOST forever:\n" + lost.join("\n")
      : "All budgets are fully spent — nothing is forfeited.")
    + "\n\nAfter finalizing you play from the interactive character sheet.";
  if (!confirm(msg)) return;
  CHAR.finalized = true;
  ensurePlay();
  // snapshot of the worn-armor flags at the moment of finalize, for revert
  CHAR.play.armor_worn = CHAR.armor.map(a => a.active !== false);
  let rollNote = "";
  if (!CHAR.play.cash_rolled) {   // only on the first finalize, never re-rolled
    const dice = [0, 0, 0, 0].map(() => 1 + Math.floor(Math.random() * 6));
    const total = dice.reduce((a, b) => a + b, 0) * 100;
    CHAR.play.cash += total;
    CHAR.play.cash_rolled = true;
    CHAR.play.starting_cash = total;   // remembered for "revert to post-chargen"
    CHAR.play.cash_log.unshift({ label: `Starting cash roll 4d6×100: [${dice.join(", ")}]`, delta: total });
    rollNote = `Starting cash roll — 4d6×100: [${dice.join(", ")}] → ${fmt(total)}`;
  }
  if (!CHAR.play.ghost_rating) {   // rolled once at finalize, then permanent
    const gd = [0, 0].map(() => 1 + Math.floor(Math.random() * 6));
    CHAR.play.ghost_rating = gd[0] + gd[1];
    rollNote += (rollNote ? "\n\n" : "")
      + `Ghost rating roll — 2d6: [${gd.join(", ")}] → ${CHAR.play.ghost_rating}`;
  }
  STORAGE.saveCharacter(CHAR);
  refreshLoadList();
  await recalc();          // re-run: finalized chars get advances applied, errors suppressed
  enterSheet();
  if (rollNote) alert(rollNote);
}
async function refresh() { await recalc(); renderPanel(); }

/* ------------------------------------------------ generic list editor */
/* Owned-items table + a way to add more: either a classic `options`
 * dropdown, or a `picker` element (e.g. categoryBrowser) rendered below. */
function listEditor({ items, options, picker, label, onAdd, onRemove, render }) {
  const wrap = el("div");
  const table = el("table");
  wrap.append(table);
  const rebuild = () => {
    table.innerHTML = "";
    items.forEach((it, i) => table.append(render(it, i, () => { onRemove(i); refresh(); })));
  };
  rebuild();
  if (picker) {
    wrap.append(picker);
    return wrap;
  }
  const sel = el("select", {},
    el("option", { value: "" }, `Add ${label}\u2026`),
    ...options);
  wrap.append(el("div", { class: "add-row" }, sel,
    el("button", { class: "btn-add", onclick: () => {
      if (!sel.value) return;
      onAdd(sel.value); sel.value = ""; refresh();
    } }, "Add")));
  return wrap;
}
const optGroups = (rows, groupKey, nameKey, extra = r => "") => {
  const groups = {};
  rows.forEach(r => (groups[r[groupKey] || "Other"] ??= []).push(r));
  return Object.entries(groups).map(([g, rs]) =>
    el("optgroup", { label: g }, ...rs.map(r =>
      el("option", { value: r[nameKey] }, r[nameKey] + extra(r)))));
};
const opts = (rows, nameKey, extra = r => "") =>
  rows.map(r => el("option", { value: r[nameKey] }, r[nameKey] + extra(r)));

function stepper(get, set, min = 0, max = 99) {
  const clamp = n => Math.max(min, Math.min(max, n));
  const sv = el("span", { class: "sv", title: "Click to type a value",
    style: "cursor:text" }, String(get()));
  // Click the number to type an exact value.
  sv.addEventListener("click", () => {
    const input = el("input", { type: "number", value: String(get()),
      min: String(min), max: String(max), class: "sv-edit", style: "width:56px" });
    sv.replaceWith(input); input.focus(); input.select();
    let done = false;
    const commit = save => {
      if (done) return; done = true;
      if (save) {
        const n = parseInt(input.value, 10);
        if (Number.isFinite(n)) { set(clamp(n)); sv.textContent = String(get()); }
      }
      input.replaceWith(sv);
      if (save) scheduleRecalc();
    };
    input.addEventListener("blur", () => commit(true));
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") commit(true);
      else if (e.key === "Escape") commit(false);
    });
  });
  const btn = (d, t) => el("button", { onclick: () => {
    set(clamp(get() + d));
    sv.textContent = String(get());
    scheduleRecalc();
  } }, t);
  return el("span", { class: "stepper" }, btn(-1, "\u2013"), sv, btn(1, "+"));
}

/* Sort comparator that clusters the four spellcasting skills at the top of a
 * list (in casting order), everything else alphabetical after them. */
const SPELLCASTING_SKILLS = ["Astral Senses", "Channeling", "Conjuring", "Sorcery"];
function spellcastingFirst(a, b) {
  const ia = SPELLCASTING_SKILLS.indexOf(a), ib = SPELLCASTING_SKILLS.indexOf(b);
  if (ia !== -1 || ib !== -1) {
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  }
  return a.localeCompare(b);
}

/* ------------------------------------------------ 1. priorities */
function tabPriorities(p) {
  p.append(el("h2", {}, "Set Starting Priorities ", chip("prio")));
  p.append(el("p", { class: "hint" },
    "Distribute 10 priority points, 0\u20134 per category. Each level sets what the category grants below."));

  const cats = [
    ["heritage", "Heritage"], ["magic", "Magic"], ["attributes", "Attributes"],
    ["skills", "Skills"], ["resources", "Resources"],
  ];
  const prow = { 4: DATA.tables.priorities[0], 3: DATA.tables.priorities[1],
    2: DATA.tables.priorities[2], 1: DATA.tables.priorities[3], 0: DATA.tables.priorities[4] };
  const grants = (cat, v) => {
    const r = prow[v];
    switch (cat) {
      case "magic": return r.Magic;
      case "attributes": return r.AttributePoints + " pts";
      case "skills": return r.SkillPoints + " pts";
      case "resources": return fmt(r.Cash);
      case "heritage": {
        const key = v === 0 ? "0-0" : v === 1 ? "1-1" : "2-4";
        return DATA.heritage_availability[key].join(", ");
      }
    }
  };

  const grid = el("div", { class: "prio-grid" });
  grid.append(el("div"));
  for (let v = 0; v <= 4; v++) grid.append(el("div", { class: "head" }, String(v)));
  grid.append(el("div", { class: "head", style: "text-align:left" }, "Grants"));
  const gets = {};
  for (const [key, label] of cats) {
    grid.append(el("div", { class: "prio-cat" }, label));
    for (let v = 0; v <= 4; v++) {
      grid.append(el("div", {
        class: "prio-dot" + (CHAR.priorities[key] === v ? " sel" : ""),
        role: "button", tabindex: "0", "aria-label": `${label} priority ${v}`,
        onclick: async e => {
          CHAR.priorities[key] = v;
          if (key === "magic") { await refresh(); return; }
          grid.querySelectorAll(`[aria-label^='${label} ']`).forEach(n => n.classList.remove("sel"));
          e.currentTarget.classList.add("sel");
          gets[key].textContent = grants(key, v);
          await recalc();
        },
        onkeydown: e => { if (e.key === "Enter" || e.key === " ") e.currentTarget.click(); },
      }));
    }
    gets[key] = el("div", { class: "prio-gets" }, grants(key, CHAR.priorities[key]));
    grid.append(gets[key]);
  }
  p.append(grid);

  // Magic type choice: Magic priority 2+ unlocks its tier and every tier below
  const magicPriority = CHAR.priorities.magic;
  const allowedTypes = DATA.magic_types_allowed_by_priority[String(magicPriority)] || [];
  if (allowedTypes.length > 1) {
    const wrap = el("div", { class: "card", style: "margin-top:18px;max-width:520px" });
    wrap.append(el("h3", {}, `Magic priority ${magicPriority} \u2014 choose your magic type`));
    const sel = el("select", { onchange: e => { CHAR.magic.chosen_type = e.target.value; refresh(); } },
      ...allowedTypes.map(t => el("option", {}, t)));
    sel.value = allowedTypes.includes(CHAR.magic.chosen_type) ? CHAR.magic.chosen_type
      : allowedTypes[allowedTypes.length - 1];
    CHAR.magic.chosen_type = sel.value;
    wrap.append(sel);
    p.append(wrap);
  }

  const steps = el("div", { class: "card", style: "max-width:720px" });
  steps.append(el("h3", {}, "Character generation order (Process-CharGen)"));
  ["1. Set starting priorities", "2. Make heritage decision (type, then features)",
   "3. Spend starting attribute points (cost table applies above 10)",
   "4. Spend starting skill points 1-for-1, max 6 per skill",
   "5. Choose magic: Archmage/Mage spend Starting Force; Amps buy powers with ZP; Speakers spend Infusion & Relationship points (Archmages buy spirits, bonds, and infusions with Force)",
   "6. Buy gear with starting cash"].forEach(s =>
    steps.append(el("div", { class: "stat-line" }, s)));
  p.append(steps);
}

/* ------------------------------------------------ 2. heritage */
function tabHeritage(p) {
  p.append(el("h2", {}, "Heritage"));
  const allowed = CALC ? CALC.priorities.allowed_heritages : ["Human"];
  p.append(el("p", { class: "hint" },
    `Available at Heritage priority ${CHAR.priorities.heritage}: ${allowed.join(", ")}.`));

  const hsel = el("select", { onchange: e => {
    CHAR.heritage.type = e.target.value;
    CHAR.heritage.features = [];
    CHAR.heritage.uplift_type = "";
    refresh();
  } }, ...DATA.tables.heritages.map(h =>
    el("option", { value: h.Name, disabled: allowed.includes(h.Name) ? null : "1" },
      `${h.Name} (ZP ${h.ZP})`)));
  hsel.value = CHAR.heritage.type;
  p.append(el("div", { class: "card", style: "max-width:520px" },
    el("h3", {}, "Heritage type"), hsel));

  if (CHAR.heritage.type === "Replicant") {
    p.append(el("div", { class: "card", style: "max-width:520px" },
      el("h3", {}, "Replicant bonus"),
      el("p", { class: "hint", style: "margin:0" },
        "Replicants gain +6 bonus Attribute points and +6 bonus Skill points "
        + "(already added to your budgets). The trade-off: replicants are "
        + "illegal and hunted by government agents.")));
  }

  const feats = DATA.tables.heritage_features;
  const featureCard = (title, category, mode, note) => {
    const card = el("div", { class: "card" });
    card.append(el("h3", {}, title));
    if (note) card.append(el("p", { class: "hint" }, note));
    feats.filter(f => f.Category === category).forEach(f => {
      const checked = CHAR.heritage.features.includes(f.Name);
      card.append(el("label", { class: "opt" },
        el("input", { type: "checkbox", ...(checked ? { checked: "1" } : {}),
          onchange: e => {
            if (e.target.checked) CHAR.heritage.features.push(f.Name);
            else CHAR.heritage.features = CHAR.heritage.features.filter(x => x !== f.Name);
            refresh();
          } }),
        el("span", {}, el("b", {}, f.Name + " "),
          el("span", { class: "feature-desc" }, f.Effects || describeStats(f)))));
    });
    return card;
  };

  const t = CHAR.heritage.type;
  if (t === "Uplift") {
    const usel = el("select", { onchange: e => { CHAR.heritage.uplift_type = e.target.value; refresh(); } },
      el("option", { value: "" }, "Choose animal\u2026"),
      ...feats.filter(f => f.Category === "UpliftType").map(f =>
        el("option", { value: f.Name }, `${f.Name} (${f.Size}, attr mod ${f.Modifier || 0})`)));
    usel.value = CHAR.heritage.uplift_type || "";
    const card = el("div", { class: "card", style: "max-width:620px" },
      el("h3", {}, "Uplift type"), usel);
    const cur = feats.find(f => f.Name === CHAR.heritage.uplift_type);
    if (cur) card.append(el("p", { class: "hint" }, cur.Effects || describeStats(cur)));
    p.append(card);
  }
  if (t === "Green") {
    p.append(el("div", { class: "grid-2" },
      featureCard("Green Boons \u2014 choose 1", "GreenBoon"),
      featureCard("Green Banes \u2014 choose 1", "GreenBane")));
  }
  if (t === "Blighted") {
    p.append(el("div", { class: "grid-2" },
      featureCard("Blighted Boons \u2014 choose 2", "BlightBoon"),
      featureCard("Blighted Banes \u2014 choose 1", "BlightBane")));
  }
  if (t === "Synthetic") {
    p.append(featureCard("Frame Mods", "SynthMod",
      null, "Durable is incompatible with Arcano-Manon Interface Matrix and Specialization."));
  }

  // conditional choices
  if (CHAR.heritage.features.includes("Nature's Blessing")) {
    const attrSel = key => {
      const s = el("select", { onchange: e => { CHAR.heritage[key] = e.target.value; refresh(); } },
        el("option", { value: "" }, "Choose\u2026"),
        ...DATA.attributes.map(a => el("option", {}, a)));
      s.value = CHAR.heritage[key] || "";
      return s;
    };
    p.append(el("div", { class: "card", style: "max-width:520px" },
      el("h3", {}, "Nature's Blessing"),
      el("div", { class: "stat-line" }, "+3 attribute ", attrSel("blessing_plus3")),
      el("div", { class: "stat-line" }, "+1 attribute ", attrSel("blessing_plus1"))));
  }
  if (CHAR.heritage.features.includes("Specialization")) {
    const s = el("select", { onchange: e => { CHAR.heritage.specialization_pool = e.target.value; refresh(); } },
      el("option", { value: "" }, "Choose pool\u2026"),
      ...["Brawn", "Finesse", "Focus", "Resolve"].map(x => el("option", {}, x)));
    s.value = CHAR.heritage.specialization_pool || "";
    p.append(el("div", { class: "card", style: "max-width:520px" },
      el("h3", {}, "Specialization \u2014 +1d to all tests of one pool"), s));
  }
}
function describeStats(f) {
  const parts = [];
  for (const k of ["STR", "BOD", "REA", "INT", "WILL", "CHA"])
    if (f[k]) parts.push(`${k} ${f[k] > 0 ? "+" : ""}${f[k]}`);
  return parts.join(", ");
}

/* ------------------------------------------------ 3. stats & skills */
function tabStats(p) {
  p.append(el("h2", {}, "Attributes ", chip("attr")));
  const costOf = lv => {
    const r = DATA.tables.attribute_costs.find(x => +x.Level === lv);
    return r ? +r.Cost : lv;
  };
  const at = el("table");
  at.append(el("tr", {},
    ...["Attribute", "Base", "Cost", "Adjust", "Final", "Max"].map((h, i) =>
      el("th", { class: i ? "num" : "" }, h))));
  for (const a of DATA.attributes) {
    const c = CALC.attributes[a];
    const costCell = el("td", { class: "num" }, String(costOf(c.base)));
    const adjCell = el("td", { class: "num" }, (c.adjust >= 0 ? "+" : "") + c.adjust);
    const finCell = el("td", { class: "num" }, el("b", {}, String(c.final)));
    const maxCell = el("td", { class: "num sub" }, String(c.max));
    at.append(el("tr", {},
      el("td", {}, a),
      el("td", { class: "num" }, stepper(
        () => CHAR.attributes[a],
        v => {
          CHAR.attributes[a] = v;
          costCell.textContent = String(costOf(v));
        }, 1, 29)),
      costCell, adjCell, finCell, maxCell));
  }
  p.append(at);

  const chaSel = el("select", { onchange: e => { CHAR.cha_pool_choice = e.target.value; scheduleRecalc(); } },
    ...["Brawn", "Finesse", "Focus", "Resolve"].map(x => el("option", {}, x)));
  chaSel.value = CHAR.cha_pool_choice || "Brawn";
  p.append(el("div", { class: "card", style: "max-width:520px;margin-top:14px" },
    el("h3", {}, "Charisma Pool Bonus \u2014 add \u00bc CHA to one pool"), chaSel));

  p.append(el("h2", {}, "Skills ", chip("skill")));
  p.append(el("p", { class: "hint" },
    "1 point per rank, max 6 at creation. Untrained skills in a group roll at the group's best skill \u22122. "
    + "Martial Arts costs 2 points per rank and can never exceed your Unarmed Combat rank."));
  const GROUP_LABELS = { close_combat: "Close Combat", ranged_combat: "Ranged Combat",
    hacking: "Hacking", vehicle: "Vehicle" };
  const byPool = {};
  Object.entries(DATA.skills).forEach(([name, s]) => (byPool[s.pool] ??= []).push(name));
  const grid = el("div", { class: "grid-2" });
  for (const pool of ["Brawn", "Finesse", "Focus", "Resolve"]) {
    const card = el("div", { class: "card" });
    // Show the raw pool formula in the header instead of the "Nd" die code
    // (the total already lives in the left sidebar pool tiles, and the raw
    // formula stays accurate even before recalc catches up).
    const formula = POOL_FORMULAS[pool]
      + (CHAR.cha_pool_choice === pool ? " + \u00bc CHA (pool bonus)" : "");
    card.append(el("h3", {}, `${pool} pool `,
      el("span", { class: "pool-formula", style: "color:var(--manon);font-weight:400;font-size:12.5px" }, `\u2014 ${formula}`)));
    const tbl = el("table");
    tbl.append(el("tr", {}, el("th", {}, "Skill"), el("th", { class: "num" }, "Pts"),
      el("th", { class: "num" }, "Bonus"), el("th", { class: "num" }, "Final")));

    const skillRow = (name, grouped) => {
      const s = CALC.skills[name];
      CHAR.skill_specializations ??= {};
      const spec = CHAR.skill_specializations[name];
      const specOn = !!(spec && spec.on);
      // Specialized skills split into a lower / higher rating (\u22121 / +1).
      const ratingText = specOn ? `${s.final - 1} / ${s.final + 1}` : String(s.final);
      const bonusCell = el("td", { class: "num sub" }, s.bonus ? "+" + s.bonus : "");
      const finCell = el("td", { class: "num" },
        el("b", {}, ratingText),
        s.soft ? el("span", { class: "sub" }, ` (soft ${s.soft})`) : null);
      const specToggle = el("label", { class: "skill-spec-toggle" },
        el("input", { type: "checkbox", ...(specOn ? { checked: 1 } : {}),
          onchange: e => {
            const entry = CHAR.skill_specializations[name] ??= { on: false, text: "" };
            entry.on = e.target.checked;
            refresh();
          } }),
        el("span", {}, "Spec"));
      const specText = specOn
        ? el("input", { type: "text", class: "skill-spec-text",
            value: (spec && spec.text) || "", placeholder: "Specialization\u2026",
            oninput: e => {
              (CHAR.skill_specializations[name] ??= { on: true, text: "" }).text = e.target.value;
            } })
        : null;
      return el("tr", { class: grouped ? "skill-grouped" : null },
        el("td", {},
          el("div", { class: "skill-name-line" }, name,
            name === "Martial Arts" ? el("span", { class: "sub" }, " \u00b72 pts/rank, \u2264 Unarmed Combat") : null,
            specToggle),
          specText),
        el("td", { class: "num" }, stepper(
          () => CHAR.skills[name] || 0,
          v => { CHAR.skills[name] = v; }, 0, 6)),
        bonusCell, finCell);
    };

    // grouped skills clustered under a subtle group header, then the rest,
    // everything alphabetical
    const names = byPool[pool];
    const groupsHere = [...new Set(names.map(n => DATA.skills[n].group).filter(Boolean))].sort();
    for (const g of groupsHere) {
      tbl.append(el("tr", { class: "skill-group-row" },
        el("td", { colspan: "4" }, GROUP_LABELS[g] || g,
          el("span", { class: "sub" }, "  \u2014 untrained roll best \u22122"))));
      names.filter(n => DATA.skills[n].group === g).sort()
        .forEach(n => tbl.append(skillRow(n, true)));
    }
    const ungrouped = names.filter(n => !DATA.skills[n].group).sort(spellcastingFirst);
    if (ungrouped.length && groupsHere.length)
      tbl.append(el("tr", { class: "skill-group-row" },
        el("td", { colspan: "4" }, "General")));
    ungrouped.forEach(n => tbl.append(skillRow(n, false)));

    card.append(tbl);
    grid.append(card);
  }
  p.append(grid);

  // rituals \u2014 each is its own skill bought from skill points
  p.append(el("h2", {}, "Rituals ", chip("skill")));
  p.append(el("p", { class: "hint" },
    "Each ritual is its own skill, bought 1-for-1 from your skill points (max 6)."));
  CHAR.ritual_skills ??= {};   // old saves predate this field
  const rt = el("table", { style: "max-width:860px" });
  rt.append(el("tr", {}, el("th", {}, "Ritual"), el("th", { class: "num" }, "Pts"),
    el("th", {}, "Drain"), el("th", {}, "Effect")));
  DATA.tables.rituals.forEach(r => {
    rt.append(el("tr", {},
      el("td", {}, el("b", {}, r.Name)),
      el("td", { class: "num" }, stepper(
        () => CHAR.ritual_skills[r.Name] || 0,
        v => { CHAR.ritual_skills[r.Name] = v; }, 0, 6)),
      el("td", { class: "sub" }, r.Drain),
      el("td", { class: "sub" }, r.Effect)));
  });
  p.append(rt);

  // martial art
  const styles = [...new Set(DATA.tables.martial_arts.map(m => m.Style))];
  const msel = el("select", { onchange: e => { CHAR.martial_art = e.target.value; refresh(); } },
    el("option", { value: "" }, "None"), ...styles.map(s => el("option", {}, s)));
  msel.value = CHAR.martial_art || "";
  const mcard = el("div", { class: "card", style: "max-width:640px" },
    el("h3", {}, "Martial art style (uses Martial Arts skill rank)"), msel);
  if (CALC.martial_art.style) {
    CALC.martial_art.levels.forEach(l =>
      mcard.append(el("div", { class: "stat-line" }, `Level ${l.Level}`, el("b", {}, l.Effect))));
  }
  p.append(mcard);

}

/* ------------------------------------------------ 3b. knowledge & etiquette */
function tabKnowledge(p) {
  p.append(el("h2", {}, "Etiquettes ", chip("etq")));
  p.append(el("p", { class: "hint" },
    "2 \u00d7 Charisma points. How smoothly you move through each stratum of society \u2014 "
    + "Wealthy lifestyle adds +1 die to all etiquette tests."));
  CHAR.etiquettes ??= {};
  const etbl = el("table", { style: "max-width:480px" });
  etbl.append(el("tr", {}, el("th", {}, "Etiquette"), el("th", { class: "num" }, "Pts")));
  for (const name of DATA.etiquettes) {
    etbl.append(el("tr", {},
      el("td", {}, name),
      el("td", { class: "num" }, stepper(
        () => CHAR.etiquettes[name] || 0,
        v => { CHAR.etiquettes[name] = v; }, 0, 6))));
  }
  p.append(etbl);

  p.append(el("h2", {}, "Knowledge Skills ", chip("know")));
  p.append(el("p", { class: "hint" },
    "2 × Intelligence points (+1 per Knowledge Skillsoft augment), free-form "
    + "(e.g. Poetry, Corporate Law, Sprawl Gangs)."));
  const kt = el("table", { style: "max-width:560px" });
  CHAR.knowledge_skills.forEach((k, i) => {
    kt.append(el("tr", {},
      el("td", {}, el("input", { type: "text", value: k.name || "",
        placeholder: "Knowledge area",
        oninput: e => { k.name = e.target.value; } })),
      el("td", { class: "num" }, stepper(() => k.points || 0, v => { k.points = v; }, 0, 6)),
      el("td", {}, el("button", { class: "row-del", onclick: () => {
        CHAR.knowledge_skills.splice(i, 1); refresh(); } }, "\u2715"))));
  });
  p.append(kt, el("div", { class: "add-row" },
    el("button", { class: "btn-add", onclick: () => {
      CHAR.knowledge_skills.push({ name: "", points: 1 }); refresh(); } },
      "Add knowledge skill")));
}

/* ------------------------------------------------ 4. magic */
function tabMagic(p) {
  const type = CALC.magic.type;
  p.append(el("h2", {}, `Magic \u2014 ${type} `,
    (type === "Mage" || type === "Archmage") ? chip("force", true) : null,
    (type === "Amp" || type === "Archmage") ? chip("zp", true) : null));

  if (type === "Hedge") {
    p.append(el("p", { class: "hint" },
      "Hedge mages have no starting magic. Raise your Magic priority to 2+ to become an Amp, Speaker, Mage, or Archmage."));
    ritualsRef(p);
    return;
  }

  if (type === "Mage" || type === "Archmage") {
    if (type === "Mage") {
      const schools = [...new Set(DATA.tables.spells.map(s => s.School))];
      const sel = el("select", { onchange: e => { CHAR.magic.school = e.target.value; refresh(); } },
        el("option", { value: "" }, "Choose school\u2026"),
        ...schools.map(s => el("option", {}, s)));
      sel.value = CHAR.magic.school || "";
      p.append(el("div", { class: "card", style: "max-width:520px" },
        el("h3", {}, "School (Mages know one school)"), sel));
    } else {
      const bind = el("label", { class: "opt" },
        el("input", { type: "checkbox", ...(CHAR.magic.archmage_bind ? { checked: 1 } : {}),
          onchange: e => { CHAR.magic.archmage_bind = e.target.checked; refresh(); } }),
        el("span", {}, `Bind a spirit at creation (costs ${15} Force)`));
      p.append(el("div", { class: "card", style: "max-width:520px" },
        el("h3", {}, "Archmage \u2014 all schools available"), bind));
    }

    p.append(el("h2", {}, "Known Spells"));
    p.append(el("p", { class: "hint" },
      "Each spell is learned at a Force level (max 6); total learned Force is limited by Starting Force (Mage 25, Archmage 35)."));
    const pool = type === "Mage" && CHAR.magic.school
      ? DATA.tables.spells.filter(s => s.School === CHAR.magic.school)
      : DATA.tables.spells;
    const ownedSpells = new Set(CHAR.magic.spells.map(s => s.name));
    const spellsBySchool = {};
    pool.forEach(s => (spellsBySchool[s.School || "Other"] ??= []).push(s));
    const spellGroups = Object.entries(spellsBySchool)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([school, rows]) => ({
        label: school,
        items: rows.map(s => ({
          name: s.Name,
          sub: `Drain ${s.Drain || "?"}${s.Duration ? " · " + s.Duration : ""}`,
          hidden: ownedSpells.has(s.Name),   // already-known spells drop out
        })),
      }));
    p.append(listEditor({
      items: CHAR.magic.spells,
      picker: categoryBrowser({ id: "spells", groups: spellGroups,
        onAdd: n => CHAR.magic.spells.push({ name: n, force: 1 }) }),
      onRemove: i => CHAR.magic.spells.splice(i, 1),
      render: (it, i, del) => {
        const row = DATA.tables.spells.find(s => s.Name === it.name) || {};
        return el("tr", {},
          el("td", {}, el("b", {}, it.name),
            el("div", { class: "sub" }, `${row.School || ""} \u00b7 Drain ${row.Drain || "?"} \u00b7 ${row.Duration || ""}`)),
          el("td", {}, el("div", { class: "sub" }, row.Effect || "")),
          el("td", { class: "num" }, "Force ", stepper(() => it.force || 1, v => { it.force = v; }, 1, 6)),
          el("td", {}, el("button", { class: "row-del", onclick: del }, "\u2715")));
      },
    }));
  }

  if (type === "Amp" || type === "Archmage") {
    p.append(el("h2", {}, "Amp Powers ", chip("zp", true)));
    p.append(el("p", { class: "hint" },
      type === "Amp"
        ? "Amps pay half the listed ZP cost. Attribute Boost/Increase and Expertise need a target and can be taken multiple times."
        : "Archmages pay the listed ZP cost against their Zoetic Potential."));
    const zpMult = type === "Amp" ? 0.5 : 1;
    p.append(listEditor({
      items: CHAR.magic.amp_powers,
      options: opts(DATA.tables.amp_powers, "Name",
        r => ` (${(+r["ZP Cost"] || 0) * zpMult} ZP)`),
      label: "power",
      onAdd: n => CHAR.magic.amp_powers.push({ name: n, target: "", times: 1 }),
      onRemove: i => CHAR.magic.amp_powers.splice(i, 1),
      render: (it, i, del) => {
        const row = DATA.tables.amp_powers.find(r => r.Name === it.name) || {};
        const needsAttr = ["Attribute Boost", "Attribute Increase"].includes(it.name);
        const needsSkill = it.name === "Expertise";
        let target = null;
        if (needsAttr || needsSkill) {
          target = el("select", { onchange: e => { it.target = e.target.value; scheduleRecalc(); } },
            el("option", { value: "" }, "Target\u2026"),
            ...(needsAttr ? DATA.attributes : Object.keys(DATA.skills)).map(x => el("option", {}, x)));
          target.value = it.target || "";
        }
        return el("tr", {},
          el("td", {}, el("b", {}, it.name), el("div", { class: "sub" }, row.Effect || "")),
          el("td", {}, target),
          el("td", { class: "num" }, el("b", {}, `${(+row["ZP Cost"] || 0) * zpMult} ZP`)),
          el("td", {}, el("button", { class: "row-del", onclick: del }, "\u2715")));
      },
    }));
  }
  ritualsRef(p);
}
function ritualsRef(p) {
  p.append(el("h2", {}, "Rituals (reference)"));
  const t = el("table");
  t.append(el("tr", {}, ...["Ritual", "Drain", "Time", "Effect"].map(h => el("th", {}, h))));
  DATA.tables.rituals.forEach(r => t.append(el("tr", {},
    el("td", {}, el("b", {}, r.Name)), el("td", {}, r.Drain), el("td", {}, r.Time),
    el("td", { class: "sub" }, r.Effect))));
  p.append(t);
}

/* ------------------------------------------------ 5. speaker */
function tabSpeaker(p) {
  const type = CALC.magic.type;
  p.append(el("h2", {}, "Speaker ",
    type === "Speaker" ? chip("inf", true) : chip("force", true), " ",
    type === "Speaker" ? chip("rel", true) : null));
  if (type !== "Speaker" && type !== "Archmage") {
    p.append(el("p", { class: "hint" },
      "Spirit relationships, bonds, and infusions require the Speaker magic type (Magic priority 2, choose Speaker) or Archmage."));
    return;
  }
  p.append(el("p", { class: "hint" },
    type === "Speaker"
      ? "Spend Relationship points (11) on spirits and bonds; spend Infusion points (10) on infusions. Bonds cost 0 / 3 / 8 / 13 cumulatively."
      : "Only Speakers get the free starting Relationship and Infusion pools — as an Archmage, every spirit relationship, bond, and infusion here is bought with your Starting Force, point for point."));

  p.append(el("h2", {}, "Spirit Relationships"));
  p.append(listEditor({
    items: CHAR.speaker.relationships,
    options: optGroups(DATA.tables.speaker_spirits, "Element", "Spirit", r => ` (${r.Cost})`),
    label: "spirit",
    onAdd: n => CHAR.speaker.relationships.push(n),
    onRemove: i => CHAR.speaker.relationships.splice(i, 1),
    render: (name, i, del) => {
      const s = DATA.tables.speaker_spirits.find(x => x.Spirit === name) || {};
      return el("tr", {},
        el("td", {}, el("b", {}, name), el("div", { class: "sub" }, `${s.Element} \u00b7 cost ${s.Cost}`)),
        el("td", { class: "sub" },
          `Firearm: ${s.Firearm} \u00b7 Protection: ${s.Protection} \u00b7 Physical: ${s.Physical}`),
        el("td", {}, el("button", { class: "row-del", onclick: del }, "\u2715")));
    },
  }));

  const bcard = el("div", { class: "card", style: "max-width:520px" });
  bcard.append(el("h3", {}, "Spirit Bonds"));
  bcard.append(el("div", { class: "stat-line" }, "Bonds ",
    stepper(() => CHAR.speaker.bonds || 0, v => { CHAR.speaker.bonds = v; }, 0, 4)));
  bcard.append(el("p", { class: "hint" }, "1st bond free, 2nd costs 3, 3rd costs 8, 4th costs 13 relationship points."));
  p.append(bcard);

  p.append(el("h2", {}, "Infusions"));
  const icard = el("div", { class: "card", style: "max-width:520px" });
  DATA.tables.speaker_infusions.forEach(inf => {
    const checked = CHAR.speaker.infusions.includes(inf.Infusions);
    icard.append(el("label", { class: "opt" },
      el("input", { type: "checkbox", ...(checked ? { checked: 1 } : {}),
        onchange: e => {
          if (e.target.checked) CHAR.speaker.infusions.push(inf.Infusions);
          else CHAR.speaker.infusions = CHAR.speaker.infusions.filter(x => x !== inf.Infusions);
          refresh();
        } }),
      el("span", {}, el("b", {}, inf.Infusions), ` \u2014 ${inf.Cost} pts`)));
  });
  p.append(icard);

  p.append(el("h2", {}, "Elemental Pools (reference)"));
  const t = el("table");
  t.append(el("tr", {}, el("th", {}, "Element"), el("th", {}, "Pool"), el("th", { class: "num" }, "Cost")));
  DATA.tables.speaker_elements.forEach(r => t.append(el("tr", {},
    el("td", {}, r.Element), el("td", {}, r.Pool || "\u2014"), el("td", { class: "num" }, r.Cost || ""))));
  p.append(t);
}

/* ------------------------------------------------ 6. augments */
function tabAugments(p) {
  p.append(el("h2", {}, "Augments ", chip("cash")));
  p.append(el("p", { class: "hint" },
    "Cyberware accrues ZR (Zoetic Rating); bioware accrues Body Index, which must stay at or below your Body. Banned combinations are flagged in the sidebar. "
    + "α-cyber Augments are bleeding edge, reducing the ZR by 20% (minimum 0.1) but doubling the cost (minimum +ㄓ1,000). "
    + "Augments installed in your body are managed here; some gear (Power Armor, Arwin Goggles, …) can mount augments on the Weapons & Armor / Gear tabs instead — those never count against your ZP."));
  const avail = augmentAvailability(CHAR.augments);
  // Cyberlimb augments (except the melee implants below) need a replacement limb.
  const LIMB_TYPES = new Set(["Right Arm", "Left Arm", "Right Leg", "Left Leg"]);
  const hasReplacementLimb = CHAR.augments.some(e => {
    const row = DATA.tables.augments.find(a => a.Name === e.name) || {};
    return LIMB_TYPES.has(row.Type || "");
  });
  const cyberlimbExempt = name => /^(Hand Blade|Hand Razors|Knee Spurs|Elbow Spurs)/.test(name);
  // Group order: Cyberlimbs first, the four limb-replacement groups directly
  // under it (they're what the cyberlimb augments attach to), then the rest.
  const GROUP_ORDER = ["Cyberlimbs", "Right Arm", "Left Arm", "Right Leg", "Left Leg"];
  const byType = DATA.tables.augments.reduce(
    (acc, r) => (((acc[r.Type || "Other"] ??= []).push(r)), acc), {});
  const orderedTypes = [
    ...GROUP_ORDER.filter(t => byType[t]),
    ...Object.keys(byType).filter(t => !GROUP_ORDER.includes(t)).sort((a, b) => a.localeCompare(b)),
  ];
  // Synthetics have no living tissue to graft bioware onto, so the whole
  // Bioware category is banned outright for that heritage.
  const syntheticNoBio = CHAR.heritage.type === "Synthetic";
  const augGroups = orderedTypes.map(type => ({
    label: type,
    items: byType[type].map(r => {
      const needsLimb = type === "Cyberlimbs" && !cyberlimbExempt(r.Name) && !hasReplacementLimb;
      const bioBanned = syntheticNoBio && r.Type === "Bioware";
      const banned = bioBanned ? "Synthetics cannot install Bioware" : avail.bannedReason(r.Name);
      return {
        name: r.Name, cost: +r.Cost,
        sub: [(+r.ZR ? `ZR ${r.ZR}` : ""), (+r.BI ? `BI ${r.BI}` : ""), r.Effect || ""]
          .filter(Boolean).join(" \u00b7 "),
        hidden: avail.hidden(r.Name),
        banned: !!banned,
        disabled: needsLimb,
        reason: banned || (needsLimb ? "Requires a Replacement Arm or Leg" : ""),
        note: banned ? "banned" : (needsLimb ? "needs a replacement limb" : ""),
      };
    }),
  }));
  // Slotted Skillsofts grant their bonus; how many can be slotted at once is
  // capped by the number of Chipjacks installed.
  const chipjackCount = CHAR.augments
    .filter(a => a.name === "Chipjack")
    .reduce((sum, a) => sum + (a.count || 1), 0);
  const slottedSkillsoftCount = CHAR.augments
    .filter(a => a.name.startsWith("Skillsoft") && a.slotted !== false).length;
  p.append(listEditor({
    items: CHAR.augments,
    picker: categoryBrowser({ id: "augments", groups: augGroups,
      onAdd: n => CHAR.augments.push({ name: n, count: 1 }) }),
    onRemove: i => CHAR.augments.splice(i, 1),
    render: (it, i, del) => {
      const r = DATA.tables.augments.find(x => x.Name === it.name) || {};
      // Only stackable augments keep a quantity stepper; everything else is
      // implicitly one of a kind. Knowledge Skillsofts stack — each one adds a
      // Knowledge skill point.
      const stackable = it.name === "Chipjack" || it.name === "Memory-1 EB"
        || it.name === "Knowledge Skillsoft";
      if (!stackable && (it.count || 1) !== 1) it.count = 1;
      // Skillsofts target a player-chosen skill (like Amp Expertise) and set
      // it to the soft's level.
      let target = null;
      if (it.name.startsWith("Skillsoft")) {
        target = el("select", { onchange: e => { it.target = e.target.value; scheduleRecalc(); } },
          el("option", { value: "" }, "Skill\u2026"),
          ...Object.keys(DATA.skills).sort().map(x => el("option", {}, x)));
        target.value = it.target || "";
      }
      // Alpha grade: only augments that carry ZR can go bleeding-edge.
      const hasZr = !!(+r.ZR);
      const alphaZr = hasZr
        ? Math.max(0, Math.ceil((+r.ZR - Math.max(+r.ZR * 0.2, 0.1)) * 10) / 10) : 0;
      const costOf = () => {
        const base = +r.Cost || 0;
        return (it.alpha ? base + Math.max(base, 1000) : base) * (it.count || 1);
      };
      const costCell = el("td", { class: "num" }, fmt(costOf()));
      const zrCell = el("td", { class: "num" },
        hasZr ? `ZR ${it.alpha ? alphaZr : +r.ZR}` : r.BI ? `BI ${r.BI}` : "");
      const alphaCtl = hasZr
        ? el("label", { class: "opt", title: `\u03b1-cyber grade: ZR ${alphaZr} (\u221220%, min \u22120.1), cost \u00d72 (min +${CURRENCY_SYMBOL}1,000)` },
            el("input", { type: "checkbox", ...(it.alpha ? { checked: "1" } : {}),
              onchange: e => {
                it.alpha = e.target.checked;
                costCell.textContent = fmt(costOf());
                zrCell.textContent = `ZR ${it.alpha ? alphaZr : +r.ZR}`;
                scheduleRecalc();
              } }),
            el("span", {}, "α-cyber"))
        : null;
      // Slotted checkbox: only a slotted Skillsoft applies its bonus, and no
      // more can be slotted than the character has Chipjacks installed.
      let slottedCtl = null;
      if (it.name.startsWith("Skillsoft")) {
        const isSlotted = it.slotted !== false;
        const atCap = !isSlotted && slottedSkillsoftCount >= chipjackCount;
        slottedCtl = el("label", {
          class: "opt",
          title: atCap
            ? `Only ${chipjackCount} Chipjack(s) installed — unslot another Skillsoft first`
            : "Apply this Skillsoft's bonus to its target skill",
        },
          el("input", { type: "checkbox", ...(isSlotted ? { checked: "1" } : {}),
            disabled: atCap ? "1" : null,
            onchange: e => { it.slotted = e.target.checked; refresh(); } }),
          el("span", {}, "Slotted"));
      }
      return el("tr", {},
        el("td", {}, el("b", {}, it.name),
          el("div", { class: "sub" }, `${r.Type || ""}${r.Ban ? ` \u00b7 bans: ${r.Ban}` : ""}`),
          target),
        el("td", { class: "sub" }, r.Effect || ""),
        zrCell,
        costCell,
        el("td", {}, alphaCtl, slottedCtl),
        el("td", { class: "num" }, stackable
          ? stepper(() => it.count || 1,
              v => { it.count = v; costCell.textContent = fmt(costOf()); },
              1, it.name === "Memory-1 EB" ? 500 : 10)
          : null),
        el("td", {}, el("button", { class: "row-del", onclick: del }, "\u2715")));
    },
  }));
}

/** A chip list of currently-fitted item names plus a "pick one, click Fit"
 * row to add more. This is the one interaction pattern repeated across
 * weapon mods, armor extras, deck mods, rig mods, and drone/vehicle
 * weapons+mods — everywhere a character attaches zero or more named
 * things to a slot. Click a chip to unfit it. `onAdd`/`onRemove` mutate
 * the character; this helper always calls refresh() after either. */
function fittedItemsEditor({ items, placeholder, optionElements, onAdd, onRemove, guard, effectOf }) {
  const chips = el("div", { class: "sub" },
    ...items.map((name, index) => el("span", {
      class: "chip", style: "margin:2px 4px 0 0;cursor:pointer", title: "Click to remove this mod",
      onclick: () => { onRemove(index); refresh(); },
    }, name + " \u2715")));
  // what each fitted mod actually does, right under the chips
  const effects = effectOf
    ? el("div", { class: "sub" },
        ...items.map(name => {
          const effect = effectOf(name);
          return effect ? el("div", {}, `${name}: ${effect}`) : null;
        }).filter(Boolean))
    : null;
  const picker = el("select", {}, el("option", { value: "" }, placeholder), ...optionElements);
  const addRow = el("div", { class: "add-row" }, picker,
    el("button", { class: "btn-add", onclick: () => {
      if (!picker.value) return;
      const problem = guard ? guard(picker.value) : null;
      if (problem) { alert(problem); return; }
      onAdd(picker.value); refresh();
    } }, "Fit"));
  return el("div", {}, chips, effects, addRow);
}

/** Build categoryBrowser groups from a mod/extra table. Groups by `catCol`
 * (e.g. weapon mods by Slot); tables with no category column collapse to a
 * single group named `fallback`. */
/* A CSS class for a weapon-mod slot, e.g. "Overbarrel" -> "mod-overbarrel".
 * Returns null for slots without a dedicated colour. */
function modSlotClass(slot) {
  const s = String(slot || "").toLowerCase().replace(/\s+/g, "-");
  return ["overbarrel", "underbarrel", "chassis"].includes(s) ? `mod-${s}` : null;
}

function modGroups(table, nameCol, catCol, fallback) {
  const byCat = {};
  for (const r of table) {
    const cat = (catCol && r[catCol]) ? r[catCol] : fallback;
    (byCat[cat] ??= []).push(r);
  }
  return Object.entries(byCat).map(([label, rows]) => ({
    label,
    cls: modSlotClass(label),   // colour the group header by slot, when applicable
    items: rows.map(r => ({
      name: r[nameCol],
      cost: (r.Cost != null && r.Cost !== "") ? +r.Cost : null,
      sub: r.Effect || r.ModeEffect || "",
      cls: catCol ? modSlotClass(r[catCol]) : null,   // colour each item name by slot
    })),
  }));
}

/** Like fittedItemsEditor but the "add more" UI is the nested collapsible
 * categoryBrowser instead of a flat dropdown. Used for weapon/rig/deck mods. */
function fittedCategoryEditor({ id, items, groups, onAdd, onRemove, effectOf, classOf, guard, rerender, afterAdd }) {
  const postRemove = afterAdd || refresh;
  const chips = el("div", { class: "sub" },
    ...items.map((name, index) => el("span", {
      class: "chip" + (classOf && classOf(name) ? " " + classOf(name) : ""),
      style: "margin:2px 4px 0 0;cursor:pointer", title: "Click to remove this mod",
      onclick: () => { onRemove(index); postRemove(); },
    }, name + " \u2715")));
  const effects = effectOf
    ? el("div", { class: "sub" },
        ...items.map(name => {
          const effect = effectOf(name);
          return effect ? el("div", {}, `${name}: ${effect}`) : null;
        }).filter(Boolean))
    : null;
  const browser = categoryBrowser({ id, groups, rerender, afterAdd, onAdd: name => {
    const problem = guard ? guard(name) : null;
    if (problem) { alert(problem); return; }
    onAdd(name);
  } });
  return el("div", {}, chips, effects, browser);
}

/* Collapsible categorized equipment browser \u2014 replaces the giant dropdowns.
 * groups: [{label, items: [{name, sub, cost}]}]; open state persists across
 * re-renders per browser id. */
const browserOpenState = {};
function categoryBrowser({ id, groups, onAdd, rerender, afterAdd }) {
  const redraw = rerender || renderPanel;      // toggling open/closed
  const postAdd = afterAdd || refresh;         // after an item is added
  const state = (browserOpenState[id] ??= {});
  const wrap = el("div", { class: "cat-browser" });
  for (const g of groups) {
    // Items flagged `hidden` (e.g. an owned augment or a lesser rank) drop out.
    const visible = g.items.filter(it => !it.hidden);
    if (!visible.length) continue;
    const open = !!state[g.label];
    wrap.append(el("div", {
      class: "cat-head", role: "button", tabindex: "0",
      onclick: () => { state[g.label] = !open; redraw(); },
      onkeydown: e => { if (e.key === "Enter" || e.key === " ") e.currentTarget.click(); },
    },
      el("span", {}, el("span", { class: g.cls || null }, g.label), " ",
        el("span", { class: "sub" }, `(${visible.length})`)),
      el("span", { class: "cat-arrow" }, open ? "\u25be" : "\u25b8")));
    if (!open) continue;
    const list = el("div", { class: "cat-items" });
    for (const it of visible) {
      const blocked = it.banned || it.disabled;
      const cls = "cat-item"
        + (it.banned ? " cat-item-banned" : "")
        + (it.disabled ? " cat-item-disabled" : "");
      const sub = [it.sub, it.note].filter(Boolean).join(" \u00b7 ");
      const addBtn = blocked
        ? el("button", { class: "btn-add", disabled: "1",
            title: it.reason || "Unavailable" }, "Add")
        : el("button", { class: "btn-add",
            onclick: () => { onAdd(it.name); postAdd(); } }, "Add");
      list.append(el("div", { class: cls },
        el("div", { class: "cat-item-info" },
          el("b", { class: it.cls || null }, it.name),
          sub ? el("div", { class: "sub" }, sub) : null),
        el("div", { class: "cat-item-right" },
          it.cost != null ? el("span", { class: "cat-cost" }, fmt(it.cost)) : null,
          addBtn)));
    }
    wrap.append(list);
  }
  return wrap;
}

/**
 * Given the character's owned augment entries, returns helpers for the augment
 * picker: which augments to hide (already owned, or a lesser/equal rank of an
 * owned family) and which are banned by an owned augment (mutual exclusion).
 * Families that can legitimately be bought many times are never hidden.
 */
function augmentAvailability(ownedEntries) {
  const STACKABLE_RE = /^(Skillsoft|Knowledge Skillsoft|Memory|Unmodified|Compartment|Chipjack)/i;
  const LIMB_TYPES = new Set(["Right Arm", "Left Arm", "Right Leg", "Left Leg"]);
  const rowOf = name => DATA.tables.augments.find(a => a.Name === name) || {};
  const isStackable = name =>
    STACKABLE_RE.test(name) || LIMB_TYPES.has(rowOf(name).Type || "");
  // name -> {family, rank}
  const parse = name => {
    const m = name.match(/^(.*?)[\s-]*(\d+)\s*$/);
    return m ? { family: m[1].trim(), rank: +m[2] } : { family: name, rank: 1 };
  };
  // Highest owned rank per family (skipping stackable families).
  const ownedMaxRank = {};
  const ownedNames = new Set();
  for (const e of ownedEntries) {
    ownedNames.add(e.name);
    if (isStackable(e.name)) continue;
    const { family, rank } = parse(e.name);
    ownedMaxRank[family] = Math.max(ownedMaxRank[family] || 0, rank);
  }
  // Ban prefixes contributed by owned augments (both directions).
  const ownedBanPrefixes = [];
  for (const e of ownedEntries) {
    const bans = String(rowOf(e.name).Ban || "").split(",").map(s => s.trim()).filter(Boolean);
    for (const b of bans) ownedBanPrefixes.push(b);
  }
  const hidden = name => {
    if (isStackable(name)) return false;
    const { family, rank } = parse(name);
    return (ownedMaxRank[family] || 0) >= rank;
  };
  const bannedReason = name => {
    // this augment is on an owned augment's ban list \u2026
    for (const pref of ownedBanPrefixes) {
      if (pref !== "VCR" && name.startsWith(pref)) {
        const owner = ownedEntries.find(e =>
          String(rowOf(e.name).Ban || "").split(",").map(s => s.trim()).includes(pref));
        return `Incompatible with ${owner ? owner.name : "an installed augment"}`;
      }
    }
    // \u2026 or an owned augment is on THIS augment's ban list.
    const myBans = String(rowOf(name).Ban || "").split(",").map(s => s.trim()).filter(Boolean);
    for (const b of myBans) {
      if (b === "VCR") continue;
      const conflict = [...ownedNames].find(n => n !== name && n.startsWith(b));
      if (conflict) return `Incompatible with ${conflict}`;
    }
    return null;
  };
  return { hidden, bannedReason, ownedNames };
}

/* Mounted-augment editor for gear that can host augments (Power Armor, Arwin
   Goggles, homebrew with a "Mount Types" column). Rendered inside the host
   item's row on the Weapons/Armor/Gear tabs — mounted augments are managed
   with the gear, never on the Augments tab, and their ZR doesn't count
   against the character's ZP. Effects apply only while the host is active. */

/* categoryBrowser groups for the mount picker: accepted augments grouped by
   type, each priced and annotated, with an unavailable reason when it won't
   fit the host's free ZP or is already mounted. Shared with sheet.js. */
function mountBrowserGroups(cap, freeZp, mounted, mult = 1) {
  const mountedNames = new Set((mounted || []).map(m => m.name));
  const byType = {};
  for (const a of DATA.tables.augments) {
    if (cap.accepts(a)) (byType[a.Type] ??= []).push(a);
  }
  return Object.entries(byType).sort(([a], [b]) => a.localeCompare(b))
    .map(([type, rows]) => ({
      label: type,
      items: rows.map(a => {
        const zr = +a.ZR || 0;
        const dupe = mountedNames.has(a.Name);
        const noFit = zr - freeZp > 1e-9;
        return {
          name: a.Name,
          cost: Math.round((+a.Cost || 0) * mult),
          sub: `ZR ${a.ZR || 0}${a.Effect ? " · " + a.Effect : ""}`,
          disabled: dupe || noFit,
          reason: dupe ? "Already mounted on this item"
                : noFit ? `Needs ${zr} ZP — only ${freeZp} free on this item` : "",
        };
      }),
    }));
}

/* Pop-up picker for mounting an augment: the grouped browser opens in a
   small modal so the host item's row stays compact. Closes on add, backdrop
   click, ✕ or Escape. Shared with sheet.js. */
function openMountPicker({ title, groups, onAdd, afterAdd }) {
  const backdrop = el("div", { class: "mount-modal-backdrop",
    onclick: e => { if (e.target === backdrop) close(); } });
  const card = el("div", { class: "card mount-modal" });
  const esc = e => { if (e.key === "Escape") close(); };
  const close = () => { backdrop.remove(); document.removeEventListener("keydown", esc); };
  const draw = () => {
    card.innerHTML = "";
    card.append(
      el("div", { style: "display:flex;justify-content:space-between;align-items:center;gap:8px" },
        el("h3", { style: "margin:0" }, title),
        el("button", { class: "row-del", title: "Close", onclick: close }, "✕")),
      categoryBrowser({ id: "mount-picker", groups, rerender: draw,
        afterAdd: afterAdd || refresh,
        onAdd: name => { close(); onAdd(name); } }));
  };
  draw();
  backdrop.append(card);
  document.body.append(backdrop);
  document.addEventListener("keydown", esc);
}

function mountEditor(host, hostRow, hostActive) {
  const cap = RULES.mountCapability(hostRow || {});
  if (!cap) return null;
  host.mounted ??= [];
  const r2 = x => Math.round(x * 100) / 100;
  const copies = Math.max(1, +(host.qty || 1));   // armor entries have no qty
  const capacity = r2(cap.capacity * copies);
  const augRow = name => DATA.tables.augments.find(a => a.Name === name);
  const used = r2(host.mounted.reduce((sum, m) => {
    const row = augRow(m.name);
    return sum + (row ? RULES.augmentEffZr(row, m) : 0);
  }, 0));
  const over = used - capacity > 1e-9;
  const free = r2(capacity - used);

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
        groups: mountBrowserGroups(cap, free, host.mounted),
        onAdd: name => host.mounted.push({ name }),
      }) }, "+ Mount")));

  if (host.mounted.length) {
    wrap.append(el("div", {}, ...host.mounted.map((m, idx) => {
      const row = augRow(m.name) || {};
      const hasZr = +row.ZR > 0;
      return el("span", { class: "chip", style: "margin:2px 4px 0 0" },
        `${m.name} · ${RULES.augmentEffZr(row, m)} `,
        hasZr ? el("button", { class: "chip-btn" + (m.alpha ? " alpha-on" : ""),
          title: (m.alpha ? "α-cyber grade — click to revert" : "Upgrade to α-cyber grade")
            + " (ZR −20% min 0.1, cost ×2 min +1000)",
          onclick: () => { m.alpha = !m.alpha; refresh(); } }, "α") : null,
        el("button", { class: "chip-btn", title: "Unmount",
          onclick: () => { host.mounted.splice(idx, 1); refresh(); } }, "✕"));
    })));
  }
  return wrap;
}

/* ------------------------------------------------ 7. weapons & armor */
const WEAPON_TYPE_LABELS = {
  Melee: "Melee Weapons", Thrown: "Thrown Weapons", PistolLt: "Light Pistols",
  PistolMed: "Medium Pistols", PistolHvy: "Heavy Pistols", SMG: "SMGs",
  Rifle: "Rifles", Shotgun: "Shotguns", GrenadeLauncher: "Grenade Launchers",
  Heavy: "Heavy Weapons", Energy: "Energy Weapons",
};
function tabWeapons(p) {
  p.append(el("h2", {}, "Weapons ", chip("cash")));
  p.append(el("p", { class: "hint" },
    "Smart-capable weapons cost double their base price; integrated-smart weapons are always Smart at no extra cost. Each weapon takes one Underbarrel, one Overbarrel, and Chassis mods. "
    + "Melee, Thrown, and Grenade Launcher weapons can't take mods. Thrown weapons can be bought in quantity."));
  const weaponGroups = Object.entries(
    DATA.tables.weapons.reduce((acc, r) => (((acc[r.Type] ??= []).push(r)), acc), {}))
    .map(([type, rows]) => ({
      label: WEAPON_TYPE_LABELS[type] || type,
      items: rows.map(r => ({
        name: r.Weapon, cost: +r.Cost,
        sub: (r.Type === "Melee"
          ? `Rarity ${r.Rarity || "\u2014"} \u00b7 Reach ${r.Reach || 0} \u00b7 Weight ${r.Weight || 0} \u00b7 Pen ${r.Pen || 0} \u00b7 Conceal ${r.Conceal || 0} \u00b7 Damage ${r.Damage}`
          : `Rarity ${r.Rarity || "\u2014"} \u00b7 Acc ${r.Accuracy || 0} \u00b7 ${r["Firing modes"] || ""} \u00b7 Weight ${r.Weight || 0} \u00b7 Pen ${r.Pen || 0} \u00b7 Conceal ${r.Conceal || 0} \u00b7 Damage ${r.Damage}`),
      })),
    }));
  p.append(listEditor({
    items: CHAR.weapons,
    picker: categoryBrowser({ id: "weapons", groups: weaponGroups,
      onAdd: n => {
        const r = DATA.tables.weapons.find(x => x.Weapon === n) || {};
        CHAR.weapons.push({ name: n, smart: Boolean(r["Integrated Smart"]),
          mods: [], equipped: true, qty: 1 });
      } }),
    onRemove: i => CHAR.weapons.splice(i, 1),
    render: (it, i, del) => {
      const r = DATA.tables.weapons.find(x => x.Weapon === it.name) || {};
      const calcRow = (CALC.weapons || [])[i] || {};
      const isMelee = r.Type === "Melee";
      const isThrown = r.Type === "Thrown";
      // Melee, Thrown, Grenade Launchers, Heavy and Energy weapons can't take mods.
      const canMod = !["Melee", "Thrown", "GrenadeLauncher", "Heavy", "Energy"].includes(r.Type);
      const canSmart = !isMelee && !isThrown;
      // Integrated-smart weapons are always Smart (no cost bump): keep the
      // saved flag in sync (covers characters made before the data flag) and
      // lock the checkbox on.
      const integratedSmart = Boolean(r["Integrated Smart"]);
      if (integratedSmart && !it.smart) it.smart = true;
      return el("tr", {},
        el("td", {}, el("b", {}, it.name),
          el("div", { class: "sub" },
            `${r.Type} \u00b7 Acc ${r.Accuracy || 0} \u00b7 DMG ${r.Damage} \u00b7 ${r["Firing modes"] || "melee"} \u00b7 Pen ${r.Pen || 0} \u00b7 Weight ${r.Weight || 0}`
            + (isThrown ? ` \u00b7 \u00d7${it.qty || 1}` : "")),
          canMod ? fittedCategoryEditor({
            id: `wmods-${i}-${it.name}`,
            items: it.mods || [],
            groups: modGroups(DATA.tables.weapon_mods, "Modification", "Slot"),
            // One mod per slot (Overbarrel / Underbarrel / Chassis): refuse a
            // mod that would leave the fitted set without a free slot.
            guard: name => {
              if ((it.mods || []).includes(name)) return `${name} is already fitted.`;
              const { overflow } = RULES.assignWeaponModSlots(
                [...(it.mods || []), name], DATA.tables.weapon_mods);
              return overflow.length
                ? "No free slot: each weapon takes one Overbarrel, one Underbarrel, and one Chassis mod."
                : null;
            },
            onAdd: name => it.mods.push(name),
            onRemove: index => it.mods.splice(index, 1),
            effectOf: name =>
              (DATA.tables.weapon_mods.find(m => m.Modification === name) || {}).Effect || "",
          }) : null,
          mountEditor(it, r, it.equipped !== false)),
        el("td", {},
          el("label", { class: "opt" },
            el("input", { type: "checkbox", ...(it.equipped !== false ? { checked: 1 } : {}),
              onchange: e => { it.equipped = e.target.checked; refresh(); } }),
            el("span", {}, "Equipped")),
          isThrown ? el("label", { class: "opt" },
            el("span", {}, "Qty "),
            stepper(() => it.qty || 1, v => { it.qty = v; }, 1, 99)) : null,
          canSmart ? el("label", { class: "opt" },
            el("input", { type: "checkbox", ...(it.smart ? { checked: 1 } : {}),
              ...(integratedSmart ? { disabled: 1 } : {}),
              onchange: e => { it.smart = e.target.checked; refresh(); } }),
            el("span", {}, integratedSmart ? "Smart (integrated)" : "Smart")) : null),
        el("td", { class: "num" }, el("b", {}, fmt(calcRow.cost ?? r.Cost))),
        el("td", {}, el("button", { class: "row-del", onclick: del }, "\u2715")));
    },
  }));

  p.append(el("h2", {}, "Armor"));
  p.append(el("p", { class: "hint" },
    "One Outer and one Under piece active at a time. Styleable pieces multiply base cost by Style \u00d7 Material and can take Extras."));
  const styles = DATA.tables.armor_styles, mats = DATA.tables.armor_materials,
    extras = DATA.tables.armor_extras;
  const armorItem = r => ({ name: r.Armor, cost: +r.Cost,
    sub: `${r.Ballistic}B / ${r.Impact}I \u00b7 wt ${r.wt}${r.Style === "Y" ? " \u00b7 styleable" : ""}` });
  const armorGroups = [
    { label: "Outer Armor",
      items: DATA.tables.armor.filter(r => (r.Slot || "").startsWith("Outer")).map(armorItem) },
    { label: "Under Armor",
      items: DATA.tables.armor.filter(r => r.Slot === "Under").map(armorItem) },
    { label: "Other",
      items: DATA.tables.armor.filter(r => !(r.Slot || "").startsWith("Outer") && r.Slot !== "Under").map(armorItem) },
  ];
  p.append(listEditor({
    items: CHAR.armor,
    picker: categoryBrowser({ id: "armor", groups: armorGroups,
      onAdd: n => CHAR.armor.push({ name: n, style: "", material: "", extras: [], active: true }) }),
    onRemove: i => CHAR.armor.splice(i, 1),
    render: (it, i, del) => {
      const r = DATA.tables.armor.find(x => x.Armor === it.name) || {};
      const calcRow = (CALC.armor || [])[i] || {};
      const styleable = r.Style === "Y";
      let styleCtl = el("span", { class: "sub" }, "fixed design");
      if (styleable) {
        const ss = el("select", { onchange: e => { it.style = e.target.value; refresh(); } },
          el("option", { value: "" }, "Style\u2026"),
          ...styles.map(s => el("option", { value: s.Style }, `${s.Style} \u00d7${s.Multiplier}`)));
        ss.value = it.style || "";
        const ms = el("select", { onchange: e => { it.material = e.target.value; refresh(); } },
          el("option", { value: "" }, "Material\u2026"),
          ...mats.map(m => el("option", { value: m.Material }, `${m.Material} \u00d7${m.Multiplier}`)));
        ms.value = it.material || "";
        styleCtl = el("div", {}, ss, " ", ms,
          fittedItemsEditor({
            items: it.extras || [],
            placeholder: "Extra\u2026",
            optionElements: extras.map(x => el("option", { value: x.Extra }, `${x.Extra} \u00d7${x.Multiplier}`)),
            onAdd: name => it.extras.push(name),
            onRemove: index => it.extras.splice(index, 1),
            effectOf: name => (extras.find(x => x.Extra === name) || {}).Effects || "",
          }));      }
      return el("tr", {},
        el("td", {}, el("b", {}, it.name),
          el("div", { class: "sub" }, `${r.Slot} \u00b7 ${r.Ballistic}B / ${r.Impact}I \u00b7 wt ${r.wt}`),
          mountEditor(it, r, it.active !== false)),
        el("td", {}, styleCtl),
        el("td", {}, el("label", { class: "opt" },
          el("input", { type: "checkbox", ...(it.active !== false ? { checked: 1 } : {}),
            onchange: e => { it.active = e.target.checked; refresh(); } }),
          el("span", {}, "Worn"))),
        el("td", { class: "num" }, el("b", {}, fmt(calcRow.cost ?? r.Cost))),
        el("td", {}, el("button", { class: "row-del", onclick: del }, "\u2715")));
    },
  }));
}

/* ------------------------------------------------ 8. decks & programs */
function tabDecks(p) {
  p.append(el("h2", {}, "Decks ", chip("cash")));
  p.append(listEditor({
    items: CHAR.decks,
    picker: categoryBrowser({ id: "decks", groups: [{
      label: "Cyberdecks",
      items: DATA.tables.decks.map(r => ({
        name: r.Name, cost: +r.Cost,
        sub: `MCP ${r.MCP} \u00b7 Hardening ${r.Hardening} \u00b7 Threads ${r.Threads} \u00b7 Core ${r.Core} \u00b7 ${r.Mods} mod slot(s) \u00b7 I/O ${r.IO}`,
      })),
    }], onAdd: n => CHAR.decks.push({ name: n, mods: [] }) }),
    onRemove: i => CHAR.decks.splice(i, 1),
    render: (it, i, del) => {
      const r = DATA.tables.decks.find(x => x.Name === it.name) || {};
      return el("tr", {},
        el("td", {}, el("b", {}, it.name),
          el("div", { class: "sub" },
            `MCP ${r.MCP} \u00b7 Hardening ${r.Hardening} \u00b7 Threads ${r.Threads} \u00b7 Core ${r.Core} \u00b7 IO ${r.IO} \u00b7 ${r.Mods} mod slot(s)`),
          fittedCategoryEditor({
            id: `dmods-${i}-${it.name}`,
            items: it.mods || [],
            groups: modGroups(DATA.tables.deck_mods, "Deck Mod", null, "Deck Mods"),
            onAdd: name => it.mods.push(name),
            onRemove: index => it.mods.splice(index, 1),
            effectOf: name =>
              (DATA.tables.deck_mods.find(m => m["Deck Mod"] === name) || {}).Effect || "",
          })),
        el("td", { class: "num" }, fmt(r.Cost)),
        el("td", {}, el("button", { class: "row-del", onclick: del }, "\u2715")));
    },
  }));

  // Hacking program rating \u2014 required at \u00bd MCP, \u31135,000/level
  const hackCard = el("div", { class: "card", style: "max-width:640px" });
  hackCard.append(el("h3", {}, "Hacking Program \u2014 \u3113" + (5000).toLocaleString() + " per rating level"));
  hackCard.append(el("p", { class: "hint" },
    "A deck needs a Hacking program rated at least \u00bd its MCP (round down, min 1). "
    + "Effective Hacking skill = \u00bd MCP, max 6."));
  const reqLines = el("div");
  const renderReqs = () => {
    reqLines.innerHTML = "";
    for (const d of CHAR.decks) {
      const r = DATA.tables.decks.find(x => x.Name === d.name);
      if (!r) continue;
      const req = Math.max(1, Math.floor(+r.MCP / 2));
      const ok = (CHAR.hacking_rating || 0) >= req;
      reqLines.append(el("div", { class: "stat-line" },
        `${d.name} (MCP ${r.MCP}) requires rating ${req}`,
        el("b", { style: ok ? "color:var(--ok)" : "color:var(--bad)" }, ok ? "OK" : "short")));
    }
    if (!CHAR.decks.length)
      reqLines.append(el("p", { class: "hint" }, "No decks owned \u2014 no rating required."));
  };
  renderReqs();
  hackCard.append(el("div", { class: "stat-line" }, "Hacking program rating ",
    stepper(() => CHAR.hacking_rating || 0,
      v => { CHAR.hacking_rating = v; renderReqs(); }, 0, 6)), reqLines);
  p.append(hackCard);

  p.append(el("h2", {}, "Programs"));
  const progGroups = ["Attack", "Control", "Util"].map(cls => ({
    label: cls === "Util" ? "Utility" : cls,
    items: DATA.tables.programs.filter(r => (r.Attack || "Util") === cls).map(r => ({
      name: r.Name, cost: +r.Cost,
      sub: `${r["Action Type"] || ""} \u00b7 Alert ${r.Alert || 0}${r.Effect ? " \u00b7 " + r.Effect : ""}`,
    })),
  }));
  p.append(listEditor({
    items: CHAR.programs,
    picker: categoryBrowser({ id: "programs", groups: progGroups,
      onAdd: n => CHAR.programs.push(n) }),
    onRemove: i => CHAR.programs.splice(i, 1),
    render: (name, i, del) => {
      const r = DATA.tables.programs.find(x => x.Name === name) || {};
      return el("tr", {},
        el("td", {}, el("b", {}, name),
          el("div", { class: "sub" }, `${r["Action Type"] || ""} \u00b7 Alert ${r.Alert || 0}`)),
        el("td", { class: "sub" }, r.Effect || ""),
        el("td", { class: "num" }, fmt(r.Cost)),
        el("td", {}, el("button", { class: "row-del", onclick: del }, "\u2715")));
    },
  }));
}

/* ------------------------------------------------ 9. drones & vehicles */
/** Weapons+mods editor for one drone or vehicle: a single fitted-items
 * list drawing options from however many weapon/mod tables apply
 * (ballistic, energy, mods), each contributing its own <optgroup>.
 * `guard(name)` may return an error string to block a fit. */
function findFitting(name, weaponTables) {
  for (const [table, nameColumn] of weaponTables) {
    const row = DATA.tables[table].find(r => r[nameColumn] === name);
    if (row) return { row, isWeapon: !table.includes("mods") };
  }
  return null;
}
function fittedEditor(it, weaponTables, guard) {
  // a fitting's "effect": mods carry ModeEffect text, weapons show their stats
  const describeFitting = name => {
    const found = findFitting(name, weaponTables);
    if (!found) return "";
    const r = found.row;
    if (!found.isWeapon) return r.ModeEffect || r.Effect || "";
    return `Acc ${r.Accuracy || 0} \u00b7 DMG ${r.Damage || "\u2014"} \u00b7 Pen ${r.Pen || 0}`
      + (r.Ammo ? ` \u00b7 Ammo ${r.Ammo}` : "")
      + (r.ModeEffect ? ` \u00b7 ${r.ModeEffect}` : "");
  };
  return fittedItemsEditor({
    items: it.weapons || [],
    placeholder: "Fit weapon/mod\u2026",
    optionElements: weaponTables.map(([table, nameColumn]) =>
      el("optgroup", { label: nameColumn },
        ...DATA.tables[table].map(r => el("option", { value: r[nameColumn] },
          `${r[nameColumn]} \u2014 ${fmt(r.Cost)} \u00b7 wt ${r.Weight || 0}`
          + (r.ModeEffect ? " \u00b7 " + r.ModeEffect : ""))))),
    onAdd: name => (it.weapons ??= []).push(name),
    onRemove: index => it.weapons.splice(index, 1),
    guard,
    effectOf: describeFitting,
  });
}
function tabDrones(p) {
  p.append(el("h2", {}, "Rigs ", chip("cash")));
  p.append(listEditor({
    items: CHAR.rigs,
    picker: categoryBrowser({ id: "rigs", groups: [{
      label: "Vehicle Control Rigs",
      items: DATA.tables.rigs.map(r => ({
        name: r["Rig Type"], cost: +r.Cost,
        sub: `+${r["Bonus Dice"]}d \u00b7 Hardening ${r.Hardening} \u00b7 Links ${r.Links} \u00b7 Cores ${r.Cores} \u00b7 ${r.Mods} mod slot(s)`,
      })),
    }], onAdd: n => CHAR.rigs.push({ name: n, mods: [] }) }),
    onRemove: i => CHAR.rigs.splice(i, 1),
    render: (it, i, del) => {
      const r = DATA.tables.rigs.find(x => x["Rig Type"] === it.name) || {};
      const st = RULES.rigStats(it, DATA.tables);
      const slotWarn = st.modSlotsUsed > st.modSlots ? " \u26a0" : "";
      return el("tr", {},
        el("td", {}, el("b", {}, it.name),
          el("div", { class: "sub" },
            `Bonus ${st.bonusDice}d \u00b7 Hardening ${st.hardening >= 0 ? "+" : ""}${st.hardening} \u00b7 Links ${st.links} \u00b7 Cores ${st.cores} \u00b7 ${st.modSlotsUsed}/${st.modSlots} mod slot(s)${slotWarn}`),
          fittedCategoryEditor({
            id: `rmods-${i}-${it.name}`,
            items: it.mods || [],
            groups: modGroups(DATA.tables.rig_mods, "Rig Mod", null, "Rig Mods"),
            onAdd: name => it.mods.push(name),
            onRemove: index => it.mods.splice(index, 1),
            effectOf: name =>
              (DATA.tables.rig_mods.find(m => m["Rig Mod"] === name) || {}).Effect || "",
          })),
        el("td", { class: "num" }, fmt(r.Cost)),
        el("td", {}, el("button", { class: "row-del", onclick: del }, "\u2715")));
    },
  }));

  const block = (title, key, table, nameKey, wtabs, kind) => {
    p.append(el("h2", {}, title));
    if (kind === "drone")
      p.append(el("p", { class: "hint" },
        "WW is the total Weight a drone can carry in weapons and mods; Hard Points cap the number of weapons."));
    else
      p.append(el("p", { class: "hint" },
        "Every 3 full points of fitted Weight costs 1 Cargo; a single fitting over Weight 4 costs 2 Cargo by itself. "
        + "Keep at least 1 Cargo for the driver. Weapons are capped at Body \u00f7 3."));
    p.append(listEditor({
      items: CHAR[key],
      picker: categoryBrowser({ id: key, groups: [{
        label: title,
        items: DATA.tables[table].map(r => ({
          name: r[nameKey], cost: +r.Cost,
          sub: `Move ${r.Move} \u00b7 Body ${r.Body} \u00b7 Handling ${r.Handling}`
            + (kind === "drone" ? ` \u00b7 WW ${r.WW} \u00b7 Hard Points ${r["Hard Point"]}` : ` \u00b7 Cargo ${r.Cargo || 0}`)
            + (r.Effect ? ` \u00b7 ${r.Effect}` : ""),
        })),
      }], onAdd: n => CHAR[key].push({ name: n, weapons: [], mods: [] }) }),
      onRemove: i => CHAR[key].splice(i, 1),
      render: (it, i, del) => {
        const r = DATA.tables[table].find(x => x[nameKey] === it.name) || {};
        const calcRow = (CALC[key] || [])[i] || {};
        const fitted = () => (it.weapons || []).map(n => findFitting(n, wtabs)).filter(Boolean);
        const guard = name => {
          const cand = findFitting(name, wtabs);
          if (!cand) return null;
          const current = fitted();
          const weaponCount = current.filter(f => f.isWeapon).length;
          if (kind === "drone") {
            const ww = +r.WW || 0;
            const used = current.reduce((s, f) => s + (+f.row.Weight || 0), 0);
            if (used + (+cand.row.Weight || 0) > ww)
              return `${it.name}: fitting ${name} would put weight at ${used + (+cand.row.Weight || 0)} \u2014 WW is ${ww}.`;
            if (cand.isWeapon && weaponCount + 1 > (+r["Hard Point"] || 0))
              return `${it.name}: only ${r["Hard Point"] || 0} hard point(s) \u2014 can't mount another weapon.`;
          } else if (cand.isWeapon && weaponCount + 1 > Math.floor((+r.Body || 0) / 3)) {
            return `${it.name}: weapons are capped at ${Math.floor((+r.Body || 0) / 3)} (Body \u00f7 3).`;
          }
          return null;
        };
        const limits = kind === "drone"
          ? `WW ${calcRow.ww_used ?? 0} / ${r.WW ?? 0} \u00b7 weapons ${calcRow.weapon_count ?? 0} / ${r["Hard Point"] ?? 0}`
          : `Cargo ${calcRow.effective_cargo ?? r.Cargo ?? 0} of ${r.Cargo ?? 0} \u00b7 weapons ${calcRow.weapon_count ?? 0} / ${calcRow.weapon_cap ?? Math.floor((+r.Body || 0) / 3)}`;
        const overLimit = kind === "drone"
          ? (calcRow.ww_used > +r.WW || calcRow.weapon_count > +r["Hard Point"])
          : (calcRow.effective_cargo < 1 || calcRow.weapon_count > calcRow.weapon_cap);
        return el("tr", {},
          el("td", {}, el("b", {}, it.name),
            el("div", { class: "sub" },
              `Move ${r.Move} \u00b7 Body ${r.Body} \u00b7 Handling ${r.Handling}` +
              (r.Frame ? ` \u00b7 ${r.Frame}` : "") + (r.Effect ? ` \u00b7 ${r.Effect}` : "")),
            el("div", { class: "sub", style: overLimit ? "color:var(--bad)" : "" }, limits),
            fittedEditor(it, wtabs, guard)),
          el("td", { class: "num" }, el("b", {}, fmt(calcRow.cost ?? r.Cost))),
          el("td", {}, el("button", { class: "row-del", onclick: del }, "\u2715")));
      },
    }));
  };
  block("Drones", "drones", "drones", "Drone",
    [["drone_ballistic_weapons", "Drone Ballistic Weapon"],
     ["drone_energy_weapons", "Drone Energy Weapon"],
     ["drone_mods", "Drone Mod"]], "drone");
  block("Vehicles", "vehicles", "vehicles", "Vehicle",
    [["vehicle_ballistic_weapons", "Vehicle Ballistic Weapon"],
     ["vehicle_energy_weapons", "Vehicle Energy Weapon"],
     ["vehicle_mods", "Vehicle Mod"]], "vehicle");
}

/* ------------------------------------------------ 10. gear & costs */
/* Focus/Fetish gear links to a spell, ritual, or spirit; Spirit Bags link to
 * a spirit. The character's own known spells, trained rituals, and spirit
 * relationships sort to the top of the list; everything else stays
 * selectable below. */
function gearLinkSelect(it) {
  const isFocusOrFetish = /^(Focus|Fetish) /.test(it.name);
  const isSpiritBag = /^Spirit Bag /.test(it.name);
  if (!isFocusOrFetish && !isSpiritBag) return null;
  const knownSpells = new Set(
    [...CHAR.magic.spells, ...((CHAR.play && CHAR.play.purchases) ? CHAR.play.purchases.spells : [])]
      .map(s => s.name));
  const knownRituals = new Set(
    Object.entries(CHAR.ritual_skills || {})
      .filter(([, points]) => +points > 0).map(([name]) => name));
  const knownSpirits = new Set(CHAR.speaker.relationships);
  const split = (rows, nameKey, known) => {
    const yours = rows.filter(r => known.has(r[nameKey]));
    const others = rows.filter(r => !known.has(r[nameKey]));
    return { yours, others };
  };
  const group = (label, rows, nameKey) => rows.length
    ? el("optgroup", { label }, ...rows.map(r => el("option", { value: r[nameKey] }, r[nameKey])))
    : null;
  const spirits = split(DATA.tables.speaker_spirits, "Spirit", knownSpirits);
  const groups = [];
  if (isFocusOrFetish) {
    const spells = split(DATA.tables.spells, "Name", knownSpells);
    const rituals = split(DATA.tables.rituals, "Name", knownRituals);
    groups.push(group("Your Spells", spells.yours, "Name"),
                group("Your Rituals", rituals.yours, "Name"),
                group("Your Spirits", spirits.yours, "Spirit"),
                group("Other Spells", spells.others, "Name"),
                group("Other Rituals", rituals.others, "Name"),
                group("Other Spirits", spirits.others, "Spirit"));
  } else {
    groups.push(group("Your Spirits", spirits.yours, "Spirit"),
                group("Other Spirits", spirits.others, "Spirit"));
  }
  const sel = el("select", { onchange: e => { it.link = e.target.value; scheduleRecalc(); } },
    el("option", { value: "" }, isSpiritBag ? "Link to spirit\u2026" : "Link to spell, ritual, or spirit\u2026"),
    ...groups.filter(Boolean));
  sel.value = it.link || "";
  return sel;
}

function tabGear(p) {
  p.append(el("h2", {}, "Gear ", chip("cash")));
  const gearGroups = Object.entries(
    DATA.tables.misc_gear.reduce((acc, r) => (((acc[r.Class || "Other"] ??= []).push(r)), acc), {}))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cls, rows]) => ({
      label: cls,
      items: rows.map(r => ({ name: r.Item, cost: +r.Cost,
        sub: [(+r.Dependence ? `Dependence ${r.Dependence}` : ""), r.Effect || ""]
          .filter(Boolean).join(" · ") })),
    }));
  p.append(listEditor({
    items: CHAR.gear,
    picker: categoryBrowser({ id: "gear", groups: gearGroups,
      onAdd: n => CHAR.gear.push({ name: n, qty: 1, link: "", carried: true }) }),
    onRemove: i => CHAR.gear.splice(i, 1),
    render: (it, i, del) => {
      const r = DATA.tables.misc_gear.find(x => x.Item === it.name) || {};
      const costCell = el("td", { class: "num" }, fmt((+r.Cost || 0) * (it.qty || 1)));
      return el("tr", {},
        el("td", {}, el("b", {}, it.name),
          el("div", { class: "sub" },
            [(+r.Dependence ? `Dependence ${r.Dependence}` : ""), r.Effect || ""]
              .filter(Boolean).join(" · ")),
          gearLinkSelect(it),
          mountEditor(it, r, it.carried !== false)),
        costCell,
        el("td", { class: "num" }, stepper(() => it.qty || 1,
          v => { it.qty = v; costCell.textContent = fmt((+r.Cost || 0) * v); }, 1, 99)),
        el("td", {},
          el("label", { class: "opt" },
            el("input", { type: "checkbox", ...(it.carried !== false ? { checked: 1 } : {}),
              onchange: e => { it.carried = e.target.checked; refresh(); } }),
            el("span", {}, "Carried"))),
        el("td", {}, el("button", { class: "row-del", onclick: del }, "\u2715")));
    },
  }));

  // multiple prepaid lifestyles
  CHAR.lifestyles ??= [];
  if (!CHAR.lifestyles.length && CHAR.lifestyle && CHAR.lifestyle.name) {
    CHAR.lifestyles.push({ name: CHAR.lifestyle.name, months: CHAR.lifestyle.months || 1 });
    CHAR.lifestyle = { name: "", months: 0 };   // migrated to the list
  }
  const lcard = el("div", { class: "card", style: "max-width:560px" });
  lcard.append(el("h3", {}, "Lifestyles (prepaid months)"));
  CHAR.lifestyles.forEach((ls, i) => {
    const row = DATA.tables.lifestyles.find(x => x.Lifestyle === ls.name) || {};
    lcard.append(el("div", { class: "stat-line" },
      el("span", {}, el("b", {}, ls.name),
        el("span", { class: "sub" }, ` ${fmt(row.MonthlyCost || 0)}/month`)),
      el("span", {},
        stepper(() => ls.months || 0, v => { ls.months = v; }, 0, 36), " ",
        el("button", { class: "row-del", onclick: () => {
          CHAR.lifestyles.splice(i, 1); refresh(); } }, "\u2715"))));
  });
  const addable = DATA.tables.lifestyles.filter(
    l => !CHAR.lifestyles.some(x => x.name === l.Lifestyle));
  if (addable.length) {
    const lsel = el("select", {}, el("option", { value: "" }, "Add lifestyle\u2026"),
      ...addable.map(l => el("option", { value: l.Lifestyle },
        `${l.Lifestyle} \u2014 ${fmt(l.MonthlyCost)}/month`)));
    lcard.append(el("div", { class: "add-row" }, lsel,
      el("button", { class: "btn-add", onclick: () => {
        if (!lsel.value) return;
        CHAR.lifestyles.push({ name: lsel.value, months: 1 }); refresh();
      } }, "Add")));
  }
  p.append(lcard);

  p.append(el("h2", {}, "Cost Breakdown ", chip("cash")));
  const t = el("table", { style: "max-width:560px" });
  t.append(el("tr", {}, el("th", {}, "Category"), el("th", { class: "num" }, "Spent")));
  for (const [k, v] of Object.entries(CALC.budget.categories))
    t.append(el("tr", {}, el("td", {}, k), el("td", { class: "num" }, fmt(v))));
  t.append(el("tr", {}, el("td", {}, el("b", {}, "Total")),
    el("td", { class: "num" }, el("b", {}, fmt(CALC.budget.spent)))));
  t.append(el("tr", {}, el("td", {}, "Starting cash"),
    el("td", { class: "num" }, fmt(CALC.budget.starting_cash))));
  t.append(el("tr", {}, el("td", {}, el("b", {}, "Remaining")),
    el("td", { class: "num", style: CALC.budget.remaining < 0 ? "color:var(--bad)" : "color:var(--ok)" },
      el("b", {}, fmt(CALC.budget.remaining)))));
  p.append(t);
  if (CALC.budget.gear_cost_multiplier > 1)
    p.append(el("p", { class: "hint" },
      `Heritage surcharge: all gear & augment costs \u00d7${CALC.budget.gear_cost_multiplier}.`));
}

boot();
