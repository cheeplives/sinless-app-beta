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
/* The money glyph, read fresh on every call: it follows the "currency" house
   rule (\u3113 for Zuzus, \u20a9 for Woolongs) and that rule is per character, so a
   constant captured at load would show one character's money on another's
   sheet. */
const currencySymbol = () => RULES.currencySymbol();

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
  // Arrays of children are flattened rather than appended whole. `append` takes
  // Nodes and strings, so handing it an array stringifies it — a cell built as
  // `el("td", {}, cond ? [a, b] : [c, d])` rendered the literal text
  // "[object HTMLSpanElement],[object HTMLInputElement]". Nesting is allowed,
  // and null/undefined at any depth is skipped so `cond ? x : null` still works.
  const add = kid => {
    if (kid == null) return;
    if (Array.isArray(kid)) { for (const k of kid) add(k); return; }
    n.append(kid);
  };
  for (const k of kids) add(k);
  return n;
};
/* Append a child that may legitimately be absent. Element.append() stringifies
 * anything that isn't a Node, so append(null) quietly writes the word "null"
 * into the page — el() skips nulls for its own children, and this is the same
 * courtesy for a bare parent.append(). */
const appendIf = (parent, kid) => { if (kid != null) parent.append(kid); };
const fmt = amount => currencySymbol() + Number(amount || 0).toLocaleString();

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
  initTheme();
  initHouseRules();
  // Auth gate (sync.js). In local-only mode (no backend, e.g. GitHub Pages) this
  // returns "local" and the app runs exactly as before.
  const mode = await SYNC.probe();
  if (mode === "signedout") { renderLoginGate(); return; }
  if (mode === "pending")   { renderPendingScreen(); return; }
  if (mode === "signedin") {
    // Push any queued/offline writes BEFORE pulling, so a backlog (e.g. writes
    // made while the server was unreachable) isn't clobbered by hydrate.
    await SYNC.flush();
    await SYNC.hydrate();   // then pull server → local cache
  }
  mergeCustomContent();   // homebrew.js: splice user-created rows (incl. synced) into the tables
  bindRail();
  initWorkspace();        // workspace.js: restore/seed open characters, set CHAR
  await recalc();
  showActiveTab();        // reveal #app or #sheet for the active tab + the tab strip
  refreshLoadList();
}

/* Theme has two independent axes, both applied pre-paint by theme-init.js:
 *   - light/dark MODE  -> data-theme (the 🌙/☀ toggle, a simple flip)
 *   - colour SCHEME    -> data-scheme (the pill dropdown, lists accent colours)
 * This wires up both controls and keeps the button labels + PWA theme-color
 * meta in sync with the active mode×scheme combination. */
// Colour schemes shown in the picker dropdown (id must match a data-scheme
// block in style.css; dot is the swatch colour). To add one: add its dark+light
// var blocks in style.css, add an entry here AND to the BG map in initTheme(),
// then bump CACHE_VERSION. `default` is the base violet (no CSS override). See
// the theming header comment at the top of style.css for the full contract.
const SCHEMES = [
  { id: "default", name: "Slate Violet", dot: "#9d7bff" },
  { id: "azure",   name: "Azure Steel",  dot: "#4a90e2" },
  { id: "ghost",   name: "Ghost Aqua",   dot: "#2fd0cf" },
  { id: "rose",    name: "Neon Rose",    dot: "#ff6ec7" },
];
function initTheme() {
  const html = document.documentElement;
  const meta = $('meta[name="theme-color"]');
  const modeBtn = $("#theme-toggle");
  const schemeBtn = $("#scheme-btn");
  const schemeList = $("#scheme-list");
  // Top-of-page browser chrome colour per mode×scheme (matches --ink).
  const BG = {
    "default|dark": "#0d1017", "default|light": "#f2f3f8",
    "azure|dark":   "#0d1220", "azure|light":   "#eef1f9",
    "ghost|dark":   "#0e141c", "ghost|light":   "#eef4f4",
    "rose|dark":    "#150f18", "rose|light":    "#f9eef4",
  };
  const mode = () => (html.getAttribute("data-theme") === "light" ? "light" : "dark");
  const scheme = () => (SCHEMES.some(s => s.id === html.getAttribute("data-scheme"))
    ? html.getAttribute("data-scheme") : "default");
  const schemeOf = id => SCHEMES.find(s => s.id === id) || SCHEMES[0];

  const syncMeta = () => { if (meta) meta.setAttribute("content", BG[`${scheme()}|${mode()}`]); };
  const syncModeBtn = () => {
    const m = mode();
    modeBtn.textContent = m === "light" ? "☀" : "🌙";
    modeBtn.setAttribute("aria-label", `Switch to ${m === "light" ? "dark" : "light"} mode`);
  };
  const syncSchemeBtn = () => {
    const s = schemeOf(scheme());
    schemeBtn.querySelector(".scheme-dot").style.background = s.dot;
    schemeBtn.querySelector(".scheme-name").textContent = s.name;
  };
  const markActive = () => schemeList.querySelectorAll(".scheme-opt").forEach(b =>
    b.setAttribute("aria-checked", b.dataset.id === scheme() ? "true" : "false"));

  // ----- light/dark mode toggle (restored simple flip) -----
  modeBtn.addEventListener("click", () => {
    html.setAttribute("data-theme", mode() === "light" ? "dark" : "light");
    try { localStorage.setItem("sinless:theme", mode()); } catch { /* best-effort */ }
    syncModeBtn(); syncMeta();
  });

  // ----- colour-scheme dropdown -----
  schemeList.replaceChildren(...SCHEMES.map(s => el("li", { role: "none" },
    el("button", { type: "button", role: "menuitemradio", class: "scheme-opt", "data-id": s.id,
      onclick: () => { setScheme(s.id); closeMenu(); } },
      el("span", { class: "scheme-dot", style: `background:${s.dot}` }),
      el("span", {}, s.name)))));
  function setScheme(id) {
    html.setAttribute("data-scheme", id);
    try { localStorage.setItem("sinless:scheme", id); } catch { /* best-effort */ }
    syncSchemeBtn(); syncMeta(); markActive();
  }
  let open = false;
  function closeMenu() { open = false; schemeList.hidden = true; schemeBtn.setAttribute("aria-expanded", "false"); }
  function openMenu() { open = true; schemeList.hidden = false; schemeBtn.setAttribute("aria-expanded", "true"); markActive(); }
  schemeBtn.addEventListener("click", e => { e.stopPropagation(); open ? closeMenu() : openMenu(); });
  document.addEventListener("click", () => { if (open) closeMenu(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && open) closeMenu(); });

  if (!html.getAttribute("data-scheme")) html.setAttribute("data-scheme", "default");
  // Persist canonical values so any migrated/legacy storage is cleaned up.
  try {
    localStorage.setItem("sinless:theme", mode());
    localStorage.setItem("sinless:scheme", scheme());
  } catch { /* best-effort */ }
  syncModeBtn(); syncSchemeBtn(); syncMeta();
}

/* House-rules settings panel (⚙): a gear button opening a small panel built
 * from RULES.HOUSE_RULE_DEFS. Choices are PER CHARACTER — a change writes to the
 * active character's house_rules, recomputes, saves, and re-renders. The panel
 * reflects whichever character is active (refreshed on every recalc). */
const PRIORITY_CATEGORIES = ["heritage", "magic", "attributes", "skills", "resources"];
const CLASSIC_PRIORITY_SEED = { attributes: 4, skills: 3, resources: 2, heritage: 1, magic: 0 };

/* Classic priorities are a bijection over 0–4: one of each letter, no repeats.
 * Point-buy allocations usually aren't, so switching rules needs the numbers
 * replaced with a valid spread — which throws away whatever the player had
 * chosen. It used to happen silently; now it asks first, and declining leaves
 * the old numbers in place with the engine's "assign each letter exactly once"
 * error to guide the fix. A character with nothing allocated yet has nothing to
 * lose, so it's seeded without asking.
 *
 * `ask` is false when this runs as part of rendering the Priorities tab: only
 * the switch itself is allowed to raise the question, or declining it would
 * mean being asked again every time the tab is opened. */
function seedClassicPriorities(ask = true) {
  if (RULES.houseRule("priorities") !== "classic") return;
  const values = PRIORITY_CATEGORIES.map(k => CHAR.priorities[k]);
  const isPermutation = new Set(values).size === 5 && values.every(v => v >= 0 && v <= 4);
  if (isPermutation) return;
  const untouched = values.every(v => !v);
  if (!untouched && (!ask || !confirm(
      "Classic priorities need one of each letter A–E, and your current "
      + "allocation isn't one.\n\nReplace it with a default spread "
      + "(Attributes A, Skills B, Resources C, Heritage D, Magic E)?\n\n"
      + "Cancel keeps your numbers — you'll be asked to fix them by hand.")))
    return;
  for (const k of PRIORITY_CATEGORIES) CHAR.priorities[k] = CLASSIC_PRIORITY_SEED[k];
}

/* Each rule's description is a full paragraph, and five stacked turn both the
 * panel and the new-character modal into a wall of prose the reader has to
 * wade through to reach the next choice (#64). Fold it behind a summary so the
 * list reads as choices first, with the reasoning one click away. Returns the
 * element to place plus the setter, because the caller re-points it whenever
 * the select changes. */
function houseRuleHelp() {
  const text = el("div", { class: "settings-help" });
  const box = el("details", { class: "settings-rule-help" },
    el("summary", {}, "What this means"), text);
  return { box, setText: v => { text.textContent = v; } };
}

let houseRuleControls = [];
function initHouseRules() {
  const btn = $("#settings-btn"), panel = $("#settings-panel");
  if (!btn || !panel) return;
  houseRuleControls = [];
  panel.replaceChildren(el("h4", {}, "House rules"),
    el("p", { class: "settings-help", style: "margin:-2px 0 8px" },
      "Set per character — changes affect only the open character."),
    ...RULES.HOUSE_RULE_DEFS.map(def => {
      const { box: help, setText } = houseRuleHelp();
      const setHelp = v => setText((def.options.find(o => o.value === v) || {}).help || "");
      const sel = el("select", {
        onchange: async e => {
          RULES.setHouseRule(def.id, e.target.value);
          setHelp(e.target.value);
          if (typeof CHAR !== "undefined" && CHAR) {
            if (def.id === "priorities") seedClassicPriorities();
            await recalc();
            if (CHAR.name) STORAGE.saveCharacter(CHAR);   // persist the choice on this character
            showActiveTab();
          }
        } },
        ...def.options.map(o => el("option", { value: o.value }, o.label)));
      sel.value = RULES.houseRule(def.id);
      setHelp(sel.value);
      houseRuleControls.push({ def, sel, setHelp });
      return el("label", { class: "settings-rule" }, el("span", {}, def.label), sel, help);
    }));
  let open = false;
  const close = () => { open = false; panel.hidden = true; btn.setAttribute("aria-expanded", "false"); };
  btn.addEventListener("click", e => {
    e.stopPropagation();
    open = !open; panel.hidden = !open; btn.setAttribute("aria-expanded", String(open));
  });
  panel.addEventListener("click", e => e.stopPropagation());
  document.addEventListener("click", () => { if (open) close(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && open) close(); });
}

/* Point the ⚙ panel at the active character's house rules (called after every
 * recalc, so switching characters/tabs updates it). */
function refreshHouseRulesPanel() {
  for (const { def, sel, setHelp } of houseRuleControls) {
    const v = RULES.houseRule(def.id);
    if (sel.value !== v) { sel.value = v; setHelp(v); }
  }
}

/* Modal shown when starting a NEW character: pick its house rules up front.
 * `initial` seeds the selects (defaults to the rules a fresh character gets).
 * Resolves to the chosen house_rules object, or null if the user cancels. */
function promptHouseRules(initial) {
  return new Promise(resolve => {
    const chosen = {};
    for (const def of RULES.HOUSE_RULE_DEFS)
      chosen[def.id] = (initial && initial[def.id]) || def.default;

    const backdrop = el("div", { class: "mount-modal-backdrop" });
    const done = val => { document.removeEventListener("keydown", onKey); backdrop.remove(); resolve(val); };
    const onKey = e => { if (e.key === "Escape") done(null); };

    const rows = RULES.HOUSE_RULE_DEFS.map(def => {
      const { box: help, setText } = houseRuleHelp();
      const setHelp = v => setText((def.options.find(o => o.value === v) || {}).help || "");
      const sel = el("select", {
        onchange: e => { chosen[def.id] = e.target.value; setHelp(e.target.value); } },
        ...def.options.map(o => el("option", { value: o.value }, o.label)));
      sel.value = chosen[def.id];
      setHelp(sel.value);
      return el("label", { class: "settings-rule" }, el("span", {}, def.label), sel, help);
    });

    const modal = el("div", { class: "card mount-modal", style: "max-width:460px" },
      el("h3", {}, "House rules for this character"),
      el("p", { class: "hint" },
        "Choose the optional rules for your new character. You can change these any time in ⚙ Settings."),
      ...rows,
      el("div", { style: "display:flex;gap:8px;margin-top:14px" },
        el("button", { class: "btn-add", onclick: () => done(chosen) }, "Create character"),
        el("button", { class: "btn", onclick: () => done(null) }, "Cancel")));
    backdrop.append(modal);
    backdrop.addEventListener("click", e => { if (e.target === backdrop) done(null); });
    document.addEventListener("keydown", onKey);
    document.body.append(backdrop);
    const first = modal.querySelector("select");
    if (first) first.focus();
  });
}

function scheduleRecalc() {
  clearTimeout(calcTimer);
  calcTimer = setTimeout(recalc, RECALC_DEBOUNCE_MS);
}
async function recalc() {
  CALC = RULES.calculate(CHAR);
  refreshHouseRulesPanel();   // keep the ⚙ panel in sync with the active character
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
  $("#char-name").addEventListener("input", e => {
    CHAR.name = e.target.value; renderWorkspaceBar(); persistWorkspace();
  });
  $("#char-player").addEventListener("input", e => { CHAR.player = e.target.value; persistWorkspace(); });
  // The character-action buttons (Save/Load/New/Import/Export/Homebrew) moved
  // out of the rail into the workspace ☰ menu (sheetMenu), so there's nothing
  // to wire here anymore. mountAccountControls() no-ops without .rail-actions.
  if (typeof mountAccountControls === "function") mountAccountControls();
}

/* Permanently remove a saved character. If it's the one currently open,
 * also reset to a fresh character — otherwise the next autosave would
 * quietly resurrect the deleted slot. */
async function deleteSavedCharacter(name) {
  if (!name) return;
  if (!confirm(`Delete ${name}? The saved character is permanently removed.`)) return;
  await deleteSavedCharacters([name]);
}

/* Delete several saves in one go. Every slot is removed FIRST, then the tabs
 * are closed by name — closing a tab commits the character back to storage
 * unless told not to, and closing them one at a time in step with the deletes
 * would let a still-open neighbour resurrect a slot deleted moments earlier.
 * Confirmation belongs to the caller: this is the mechanism, not the guard. */
async function deleteSavedCharacters(names) {
  const list = [...new Set((names || []).filter(Boolean))];
  if (!list.length) return 0;
  for (const name of list) STORAGE.deleteCharacter(name);
  refreshLoadList();
  // Each lookup is fresh because closeTab mutates the tab array. Reseeds a
  // blank character if this closed the last tab.
  for (const name of list) await closeTabByName(name, false);
  return list.length;
}
function refreshLoadList() {
  // The rail's Load/Delete selects were removed (character actions live in the
  // \u2630 menu, which rebuilds its own list each open). Guard in case they're gone.
  const names = STORAGE.listCharacters();
  const load = $("#load-select"), del = $("#delete-select");
  if (load) load.replaceChildren(
    el("option", { value: "" }, "Load\u2026"),
    ...names.map(name => el("option", {}, name)));
  if (del) del.replaceChildren(
    el("option", { value: "" }, "Delete\u2026"),
    ...names.map(name => el("option", {}, name)));
}

function budgetRow(label, remaining, budget) {
  // Round away floating-point dust from summed fractional budgets (e.g. Body
  // Index 14 − 15.8 = −1.8000000000000007).
  const round2 = n => (typeof n === "number" ? Math.round(n * 100) / 100 : n);
  remaining = round2(remaining); budget = round2(budget);
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
    rb.append(budgetRow("Amp ZP",
      RULES.houseRule("zr") === "houserule" ? CALC.zoetics.zp_remaining : m.amp_zp_remaining,
      m.amp_zp_budget));
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
  const houseZr = RULES.houseRule("zr") === "houserule";
  const mountedTrack = z.mounted_zr ? [el("div", { class: "track",
      title: "ZR of augments mounted on gear — never counts against your ZP" },
    el("span", {}, "Mounted ZR (exempt)"), el("b", {}, String(z.mounted_zr)))] : [];
  const bodyTrack = el("div", { class: "track" }, el("span", {}, "Body Index"),
    el("b", { style: z.body_index_ok ? "" : "color:var(--bad)" }, String(z.body_index)));
  if (houseZr) {
    const castPen = Math.floor(z.gear_zr);
    rz.append(
      el("div", { class: "track", title: "Zoetic Potential remaining (base − Cyber − Amp)" },
        el("span", {}, "ZP"),
        el("b", { style: z.zp_remaining <= 0 ? "color:var(--bad)" : "" }, `${z.zp_remaining} / ${z.zp}`)),
      el("div", { class: "track", title: "Cyber ZR spent against ZP" },
        el("span", {}, "Cyber ZP Spent"), el("b", {}, String(z.augment_zr))),
      ...mountedTrack,
      el("div", { class: "track" }, el("span", {}, "Amp ZP Spent"), el("b", {}, String(z.amp_zr))),
      el("div", { class: "track", title: "Gear/weapon ZR — each full point is −1d on casting rolls" },
        el("span", {}, "Gear ZR"),
        el("b", {}, String(z.gear_zr) + (castPen > 0 ? ` (−${castPen}d cast)` : ""))),
      bodyTrack);
  } else {
    rz.append(
      el("div", { class: "track" }, el("span", {}, "ZP"), el("b", {}, String(z.zp))),
      el("div", { class: "track" }, el("span", {}, "Cyber/Gear ZR"), el("b", {}, String(z.cyber_zr))),
      ...mountedTrack,
      el("div", { class: "track" }, el("span", {}, "Amp ZR"), el("b", {}, String(z.amp_zr))),
      bodyTrack);
  }
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
    case "zp": {
      // House rule: ZP left is the current total (base − Cyber − Amp), not just base − Amp.
      const zpLeft = RULES.houseRule("zr") === "houserule" ? CALC.zoetics.zp_remaining : m.amp_zp_remaining;
      return { text: `${zpLeft} / ${m.amp_zp_budget} ZP left`, cls: zpLeft < 0 ? "neg" : "" };
    }
    case "inf": return { text: `${m.infusion_pts.remaining} / ${m.infusion_pts.budget} left`, cls: m.infusion_pts.remaining < 0 ? "neg" : "" };
    case "rel": return { text: `${m.relationship_pts.remaining} / ${m.relationship_pts.budget} left`, cls: m.relationship_pts.remaining < 0 ? "neg" : "" };
    case "cash": return { text: `${fmt(CALC.budget.remaining)} left`, cls: CALC.budget.remaining < 0 ? "neg" : "" };
    // Bare numbers for the floating tracker, which carries its own label.
    // "ok" once every point is spent, so landing exactly on budget reads as done.
    case "skill-left": {
      const r = CALC.skill_points.remaining;
      return { text: `${r} / ${CALC.skill_points.budget}`, cls: r < 0 ? "neg" : r === 0 ? "ok" : "" };
    }
  }
  return null;
}
const chip = (key, magic) => el("span", Object.assign({ class: "chip", "data-chip": key }, magic ? { "data-magic": "1" } : {}), "\u2026");

/* The "Trained only" marker, in its neutral state \u2014 for section headers (Martial
 * Arts, Rituals) that cover a whole list rather than one skill, and for chargen,
 * where every skill starts at 0 and an unusable-state chip would light up the
 * entire table on load. Per-skill rows on the sheet build their own two-state
 * chip in skillTableRow(); shared here because sheet.js renders headers too. */
const trainedOnlyChip = () => el("span", { class: "skill-to-chip",
  title: "Trained only \u2014 cannot be used without dice in the skill or its group" },
  "Trained");

/* Skill points remaining, pinned to the viewport while the Stats & Skills tab
 * is open. The skill list runs well past a screen, so the rail's budget row
 * scrolls out of reach exactly when you're spending. Built on the same
 * [data-chip] hook as the inline chips, so renderBudgetChips() keeps it current
 * after every stepper click without a re-render. */
function skillPointsTracker() {
  return el("div", { class: "sp-fab", title: "Skill points remaining" },
    el("span", { class: "k" }, "Skill pts"), chip("skill-left"));
}

/* ZR house rule: each full point of gear/weapon ZR is \u22121d on spellcasting rolls
 * (Channeling, Conjuring, Sorcery). Renders the current penalty as a note for
 * the Magic tab \u2014 an alert when active, a plain reminder when not yet triggered. */
function zrCastingPenaltyNote() {
  const gearZr = CALC.zoetics.gear_zr || 0;
  const pen = Math.floor(gearZr);
  return pen > 0
    ? el("div", { class: "alert warn" },
        el("b", {}, `ZR Casting Penalty: \u2212${pen}d `),
        `on all spellcasting rolls (Channeling, Conjuring, Sorcery). `
        + `${gearZr} ${gearZr === 1 ? "point" : "points"} of gear/weapon ZR \u2014 \u22121d per full point.`)
    : el("p", { class: "hint" },
        el("b", {}, "ZR Casting Penalty: none. "),
        `Each full point of gear/weapon ZR is \u22121d on spellcasting rolls `
        + `(Channeling, Conjuring, Sorcery). Currently ${gearZr} ZR.`);
}

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
/* The chargen tab strip is sticky and wraps to two or three rows as the window
 * narrows, so its height isn't a constant anything can hard-code. Publish it the
 * way renderSheet publishes --sh-sticky-h, so overlays can park clear of it. */
function publishTabsHeight() {
  const nav = document.getElementById("tabs");
  if (nav) document.documentElement.style.setProperty("--cg-tabs-h", nav.offsetHeight + "px");
}
window.addEventListener("resize", publishTabsHeight);

function renderTabs() {
  const nav = $("#tabs"); nav.innerHTML = "";
  for (const [id, label] of TABS) {
    nav.append(el("button", {
      class: id === activeTab ? "active" : "",
      onclick: () => { activeTab = id; renderTabs(); renderPanel(); },
    }, label));
  }
  publishTabsHeight();
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
  if (m.type === "Amp" || m.type === "Archmage")
    add("Amp ZP", RULES.houseRule("zr") === "houserule" ? CALC.zoetics.zp_remaining : m.amp_zp_remaining);
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
  // Saving keys on the sanitised name, so finalizing under a name someone else
  // already holds replaces them outright — and "Ada Lovelace" and "Ada-Lovelace"
  // sanitise to the same slot, so the clash isn't always obvious on the page.
  const clash = STORAGE.collidingCharacter(CHAR);
  if (clash && !confirm(`"${clash}" is already saved under this name.\n\n`
    + `Finalizing as "${CHAR.name}" REPLACES that character permanently — `
    + "their build, play state and history all go.\n\nOverwrite them?"))
    return;
  const lost = unspentSummary();
  const msg = "Finalize this character?\n\n"
    + (lost.length
      ? "These unspent points are LOST forever:\n" + lost.join("\n")
      : "All budgets are fully spent — nothing is forfeited.")
    + "\n\nAfter finalizing you play from the interactive character sheet.";
  if (!confirm(msg)) return;
  CHAR.finalized = true;
  ensurePlay();
  syncChargenLifestyles();   // carry chargen lifestyle(s) into play, even on re-finalize
  // Hand the build over to play. First finalize copies it; a re-finalize keeps
  // what play has and carries across only what actually changed in chargen.
  if (!CHAR.play.kit) ensureKit(); else reconcileKit();
  // Freeze what the build cost. Re-taken every finalize, because a trip back
  // through chargen may legitimately have changed it.
  CHAR.play.creation_budget = snapshotCreationBudget();
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
  renderWorkspaceBar();    // state dot flips chargen -> play
  persistWorkspace();
  if (rollNote) alert(rollNote);
}
async function refresh() { await recalc(); renderPanel(); }

/* ------------------------------------------------ generic list editor */
/* Owned-items table + a way to add more: either a classic `options`
 * dropdown, or a `picker` element (e.g. categoryBrowser) rendered below. */
function listEditor({ items, options, picker, label, onAdd, onRemove, render, sortBy }) {
  const wrap = el("div");
  const table = el("table");
  wrap.append(table);
  const rebuild = () => {
    table.innerHTML = "";
    // `sortBy` only changes the order rows are DISPLAYED in. Pair each entry
    // with its original index and hand that to render(), so removal still hits
    // the right element and the character's own ordering is left alone.
    const order = items.map((it, i) => [it, i]);
    if (sortBy) order.sort((a, b) => sortBy(a[0], b[0]));
    for (const [it, i] of order) {
      table.append(render(it, i, () => { onRemove(i); refresh(); }));
    }
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

/* Owned vs carried counts for a gear entry. `carried` stays the boolean every
 * other consumer reads -- the mounted-augment activity check in rules.js,
 * mountEditor, shMountEditor -- while `carried_qty` narrows it to a subset, so
 * you can own six grenades and take two on the run. Entries without the field
 * (everything predating it) carry all they own, so nothing needs migrating.
 * Lives here rather than in sheet.js because chargen and the play sheet share
 * it, and app.js loads first. */
function ownedQty(g) {
  return Math.max(0, Math.floor(+g.qty || (g.qty === 0 ? 0 : 1)));
}
function carriedQty(g) {
  const owned = ownedQty(g);
  if (g.carried === false) return 0;
  if (g.carried_qty == null) return owned;               // legacy: carries everything
  return Math.max(0, Math.min(Math.floor(+g.carried_qty || 0), owned));
}
function setCarriedQty(g, n) {
  const next = Math.max(0, Math.min(Math.floor(+n || 0), ownedQty(g)));
  g.carried_qty = next;
  g.carried = next > 0;      // carrying none must still read as "not carried"
  return next;
}

/* "Carried" toggle for a deck, drone or vehicle. Those have no quantity, so it
 * stays a plain yes/no rather than the 0..owned spinner misc gear gets -- but
 * the flag and its permissive default are the same one, and gear ZR reads it
 * the same way: what you carry counts, what sits at home doesn't. */
function carriedToggle(entry, onChange) {
  return el("label", { class: "sub",
      style: "display:inline-flex;align-items:center;gap:6px;margin-top:4px",
      title: "Only carried gear contributes Zoetic Rating" },
    el("input", { type: "checkbox", ...(entry.carried !== false ? { checked: 1 } : {}),
      onchange: e => { entry.carried = e.target.checked; onChange(); } }),
    el("span", {}, "Carried"));
}

/* Minimum Strength selector for a bow — the one stat you choose when you buy
 * one, and the one that sets its damage, price and rarity (RULES.bowRating).
 * Returns null for anything that isn't a bow, so call sites can pass the result
 * straight into el().
 *
 * The stepper stops at the character's own Strength: you can't draw a bow
 * heavier than you are, so offering the choice would only be offering a
 * mistake. A bow already rated above it — Strength dropped after the purchase,
 * or the character was imported — keeps its rating rather than being quietly
 * downgraded, and the engine warns instead. */
function minStrControl(entry, row, onChange) {
  const bow = RULES.bowRating(row, entry);
  if (!bow) return null;
  const strength = CALC.attributes.Strength.final;
  const ceiling = Math.max(1, strength, bow.minStr);
  return el("label", { class: "opt",
      title: `Damage ${bow.damage} · ${fmt(bow.cost)} · Rarity ${bow.rarity}`
        + (strength < bow.minStr ? ` — needs Strength ${bow.minStr}, this character has ${strength}` : "") },
    el("span", { style: strength < bow.minStr ? "color:var(--bad)" : "" }, "Min STR "),
    stepper(() => bow.minStr, v => { entry.min_str = v; onChange(); }, 1, ceiling));
}

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

/* Collapsed long-form text for a data row. Five tables carry a Description
 * column that nothing used to display \u2014 spells, augments, programs, rituals and
 * amp_powers \u2014 holding prose the short Effect line doesn't cover. This exposes it
 * on demand without crowding the row. Returns null when there's nothing to show,
 * so call sites can pass the result straight into el().
 *
 * `key` should be stable for the row (e.g. "spells:Mind Link"): the panel
 * re-renders on every recalc, so open state is remembered in a module-level set
 * rather than being lost on the next keystroke. It's ephemeral UI state and
 * deliberately NOT saved with the character. */
const openDescriptions = new Set();

/* The <details> shell on its own, for bodies that are structured markup rather
 * than a paragraph (spirit statblocks). `key` carries the same remembered-open
 * contract as descriptionExpander. */
function expanderPanel(key, label, ...children) {
  return el("details", { class: "desc-expander",
    ...(openDescriptions.has(key) ? { open: "1" } : {}),
    ontoggle: e => {
      if (e.target.open) openDescriptions.add(key); else openDescriptions.delete(key);
    } },
    el("summary", {}, label),
    el("div", { class: "desc-body" }, ...children));
}

function descriptionExpander(text, key, label = "More Details") {
  const body = String(text || "").trim();
  if (!body) return null;
  return expanderPanel(key || body.slice(0, 48), label, body);
}

/* Spirit writeups (speaker_spirits "Bound Services", "Attacks", "Special") pack
 * several entries into one column, joined by " | ", each optionally prefixed
 * with "Name: ". data.js is one row per line, so a delimiter beats one row per
 * ability -- and homebrew identifies rows by a single column, which a per-
 * ability table couldn't do.
 *
 * Both delimiters are escapable with a backslash, so prose isn't barred from
 * using them: `\|` is a literal pipe, `\:` a colon that isn't a label
 * separator, and `\\` a literal backslash. Without this a pipe could never
 * appear in spirit text at all, and "Meet at 10:00 sharp" rendered as a
 * service named "Meet at 10" with the body "00 sharp". */
const SPIRIT_ENTRY_SEPARATOR = "|";
/** Index of the first unescaped `ch` in `s`, or -1. */
function firstUnescapedIndex(s, ch) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") { i++; continue; }
    if (s[i] === ch) return i;
  }
  return -1;
}
/** Resolve escapes for display: `\x` becomes `x` for any x. */
function unescapeSpiritText(s) {
  return String(s).replace(/\\(.)/g, "$1");
}
/** Split on unescaped pipes, escapes left intact for the caller to resolve. */
function splitSpiritEntriesRaw(str) {
  const source = String(str || "");
  const parts = [];
  let buffer = "";
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "\\" && i + 1 < source.length) { buffer += ch + source[++i]; continue; }
    if (ch === SPIRIT_ENTRY_SEPARATOR) { parts.push(buffer); buffer = ""; continue; }
    buffer += ch;
  }
  parts.push(buffer);
  return parts.map(p => p.trim()).filter(Boolean);
}
/** Entries as plain display text. Returns [] for blank input. */
function splitSpiritEntries(str) {
  return splitSpiritEntriesRaw(str).map(unescapeSpiritText).filter(Boolean);
}
function parseSpiritServices(str) {
  return splitSpiritEntriesRaw(str).map(entry => {
    // Only treat the colon as a name separator when it looks like a label --
    // a long run before it is prose ("Note: ..." vs "...ratio 2:1"). The 40 is
    // measured on the raw entry; an escape adds one character to that count,
    // which only matters for a label that is already at the limit.
    const at = firstUnescapedIndex(entry, ":");
    if (at > 0 && at <= 40) {
      return { name: unescapeSpiritText(entry.slice(0, at)).trim(),
               text: unescapeSpiritText(entry.slice(at + 1)).trim() };
    }
    return { name: "", text: unescapeSpiritText(entry) };
  }).filter(svc => svc.name || svc.text);
}

/* Every service of a spirit as one block, for places that show a whole spirit
 * at once (the chargen relationship picker) rather than one expander per
 * service the way a bond tile does. Returns null when there's no writeup. */
function spiritServiceList(row, force = 0) {
  const services = parseSpiritServices(row["Bound Services"]);
  if (!services.length) return null;
  return el("div", {}, ...services.map(svc => el("div", { class: "spirit-svc" },
    svc.name ? el("b", {}, svc.name + ": ") : null, ...withForce(svc.text, force))));
}

/* Spirit ability text writes the spirit's Force as the token [F] ("[F]d6"), so
 * a bound spirit's numbers can be resolved live from the Force set on its bond
 * slot. Force 0 means "not set yet" and shows a hoverable F instead. Returns an
 * array of nodes to spread into el(). */
function withForce(text, force) {
  const parts = String(text || "").split("[F]");
  const out = [parts[0]];
  for (let i = 1; i < parts.length; i++) {
    out.push(force > 0
      ? el("b", { class: "force-term", title: "Force" }, String(force))
      : el("span", { class: "force-term unset", title: "Force (not set)" }, "F"));
    out.push(parts[i]);
  }
  return out;
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
  const classic = RULES.houseRule("priorities") === "classic";
  const LETTERS = { 4: "A", 3: "B", 2: "C", 1: "D", 0: "E" };
  p.append(el("h2", {}, "Set Starting Priorities ", chip("prio")));
  p.append(el("p", { class: "hint" }, classic
    ? "Classic: assign the letters A\u2013E (= priority 4, 3, 2, 1, 0) across the five categories \u2014 each used exactly once. Picking a letter already in use swaps it with the other category."
    : "Distribute 10 priority points, 0\u20134 per category. Each level sets what the category grants below."));

  const cats = [
    ["heritage", "Heritage"], ["magic", "Magic"], ["attributes", "Attributes"],
    ["skills", "Skills"], ["resources", "Resources"],
  ];
  // Classic is a bijection over 0\u20134. A character that has never allocated
  // anything gets a sensible spread here; one that HAS is left alone, because
  // overwriting it is a decision the player makes at the house-rule switch
  // (seedClassicPriorities) rather than a side effect of opening this tab.
  if (classic) seedClassicPriorities(false);
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
  for (let v = 0; v <= 4; v++)
    grid.append(el("div", { class: "head" }, classic ? LETTERS[v] : String(v)));
  grid.append(el("div", { class: "head", style: "text-align:left" }, "Grants"));
  const gets = {};
  for (const [key, label] of cats) {
    grid.append(el("div", { class: "prio-cat" }, label));
    for (let v = 0; v <= 4; v++) {
      grid.append(el("div", {
        class: "prio-dot" + (CHAR.priorities[key] === v ? " sel" : ""),
        role: "button", tabindex: "0",
        "aria-label": `${label} priority ${classic ? LETTERS[v] : v}`,
        onclick: async e => {
          if (classic) {
            const old = CHAR.priorities[key];
            if (old === v) return;
            // Keep the bijection: hand our old letter to whoever currently holds v.
            for (const [okey] of cats)
              if (okey !== key && CHAR.priorities[okey] === v) { CHAR.priorities[okey] = old; break; }
            CHAR.priorities[key] = v;
            await refresh();   // full redraw so every swapped dot + grant updates
            return;
          }
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

  // Heavy Torso / No Head free 1-weight mounts (issue #11). Options: a
  // Cyberarm/Cyberleg (Heavy Torso only) or any non-melee, non-thrown weapon of
  // weight \u2264 1. All free \u2014 they never touch the cost budget.
  const mountWeapons = DATA.tables.weapons
    .filter(w => w.Type !== "Melee" && w.Type !== "Thrown" && (+w.Weight || 0) <= 1)
    .map(w => w.Weapon).sort();
  const mountSelect = (get, set, limbs) => {
    const s = el("select", { onchange: e => { set(e.target.value); refresh(); } },
      el("option", { value: "" }, "Empty\u2026"),
      ...(limbs ? ["Cyberarm", "Cyberleg"].map(x => el("option", { value: x }, x)) : []),
      ...mountWeapons.map(w => el("option", { value: w }, w)));
    s.value = get() || "";
    return s;
  };
  if (CHAR.heritage.features.includes("Heavy Torso")) {
    const m = CHAR.heritage.heavy_torso_mounts = CHAR.heritage.heavy_torso_mounts || ["", ""];
    p.append(el("div", { class: "card", style: "max-width:520px" },
      el("h3", {}, "Heavy Torso \u2014 two free 1-weight mounts"),
      el("p", { class: "hint" }, "Each holds a Cyberarm, Cyberleg, or a non-melee, non-thrown weapon of weight \u2264 1. No cost."),
      el("div", { class: "stat-line" }, "Mount 1 ", mountSelect(() => m[0], v => { m[0] = v; }, true)),
      el("div", { class: "stat-line" }, "Mount 2 ", mountSelect(() => m[1], v => { m[1] = v; }, true))));
  }
  if (CHAR.heritage.features.includes("No Head")) {
    p.append(el("div", { class: "card", style: "max-width:520px" },
      el("h3", {}, "No Head \u2014 one free 1-weight weapon mount"),
      el("p", { class: "hint" }, "Holds a non-melee, non-thrown weapon of weight \u2264 1. No cost."),
      el("div", { class: "stat-line" }, "Mount ",
        mountSelect(() => CHAR.heritage.no_head_mount, v => { CHAR.heritage.no_head_mount = v; }, false))));
  }

  // Snake uplift: its natural attack is a choice of Bite or Spit, chosen at
  // chargen and then locked (the play sheet only displays the result).
  if (CHAR.heritage.uplift_type === "Snake" || CHAR.heritage.features.includes("Snake")) {
    const s = el("select", { onchange: e => { CHAR.heritage.snake_attack = e.target.value; refresh(); } },
      el("option", { value: "bite" }, "Bite \u2014 Reach 0, \u00bdSTR+1 +3d6 poison"),
      el("option", { value: "spit" }, "Spit \u2014 Ranged 12m, Acc 4, 2d6 +Blind"));
    s.value = CHAR.heritage.snake_attack || "bite";
    p.append(el("div", { class: "card", style: "max-width:520px" },
      el("h3", {}, "Snake \u2014 natural attack (locked after chargen)"),
      el("div", { class: "stat-line" }, "Attack ", s)));
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
    // The stepper stops at the base level that puts Final on the attribute's
    // max: c.max and c.adjust share their bonuses, so the difference is the
    // largest legal base. An imported character already over its max keeps its
    // value (the engine still warns) rather than being yanked down by a "+".
    const baseCeiling = Math.max(1, c.max - c.adjust, c.base);
    at.append(el("tr", {},
      el("td", {}, a),
      el("td", { class: "num" }, stepper(
        () => CHAR.attributes[a],
        v => {
          CHAR.attributes[a] = v;
          costCell.textContent = String(costOf(v));
        }, 1, baseCeiling)),
      costCell, adjCell, finCell, maxCell));
  }
  p.append(at);

  const chaSel = el("select", { onchange: e => { CHAR.cha_pool_choice = e.target.value; scheduleRecalc(); } },
    ...["Brawn", "Finesse", "Focus", "Resolve"].map(x => el("option", {}, x)));
  chaSel.value = CHAR.cha_pool_choice || "Brawn";
  p.append(el("div", { class: "card", style: "max-width:520px;margin-top:14px" },
    el("h3", {}, "Charisma Pool Bonus \u2014 add \u00bc CHA to one pool"), chaSel));

  p.append(el("h2", {}, "Skills ", chip("skill")));
  p.append(skillPointsTracker());
  p.append(el("p", { class: "hint" },
    "1 point per rank, max 6 at creation. Untrained skills in a group roll at the group's best skill \u22122. "
    + "Martial Arts sits with the Brawn skills \u2014 one skill per style, 2 points per rank."));

  // Martial arts: one independent Martial Arts skill per style. The style
  // chooser and its rank live in the Brawn card with the other Brawn skills
  // (appendMartialArtRows below); each style's unlocked level effects are listed
  // in their own card under the grid. A style never takes a specialization, so
  // these rows have no Spec toggle.
  CHAR.martial_arts = CHAR.martial_arts || [];
  const allStyles = [...new Set(DATA.tables.martial_arts.map(m => m.Style))].sort();
  const usedStyles = new Set(CHAR.martial_arts.map(m => m.style).filter(Boolean));

  const GROUP_LABELS = { close_combat: "Close Combat", ranged_combat: "Ranged Combat",
    hacking: "Hacking", vehicle: "Vehicle", engineering: "Engineering" };
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
      // A specialization needs a rank of its own to split, so the toggle only
      // appears once the skill is bought. The stored flag is left alone: drop a
      // skill to 0 and back and the specialization comes back with it.
      const canSpecialize = Math.max(0, CHAR.skills[name] || 0) >= 1;
      const specOn = !!(spec && spec.on) && canSpecialize;
      // Specialized skills split into a lower / higher rating (\u22121 / +1).
      const ratingText = specOn ? `${s.final - 1} / ${s.final + 1}` : String(s.final);
      const bonusCell = el("td", { class: "num sub" }, s.bonus ? "+" + s.bonus : "");
      const finCell = el("td", { class: "num" },
        el("b", {}, ratingText),
        s.soft ? el("span", { class: "sub" }, ` (soft ${s.soft})`) : null);
      const specToggle = canSpecialize
        ? el("label", { class: "skill-spec-toggle" },
            el("input", { type: "checkbox", ...(specOn ? { checked: 1 } : {}),
              onchange: e => {
                const entry = CHAR.skill_specializations[name] ??= { on: false, text: "" };
                entry.on = e.target.checked;
                refresh();
              } }),
            el("span", {}, "Spec"))
        : null;
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
            s.trained_only ? trainedOnlyChip() : null, specToggle),
          specText,
          (s.notes && s.notes.length) ? el("div", { class: "sub" }, "\u2726 " + s.notes.join(" \u00b7 ")) : null),
        el("td", { class: "num" }, stepper(
          () => CHAR.skills[name] || 0,
          v => {
            const had = canSpecialize;
            CHAR.skills[name] = v;
            // Crossing 0 <-> 1 adds or removes the Spec toggle on this row.
            if (had !== (v >= 1)) refresh();
          }, 0, RULES.SKILL_RANK_CAP)),
        bonusCell, finCell);
    };

    // Martial Arts rows, appended to the Brawn table: a style dropdown and a
    // rank stepper per chosen style, plus an Add row. Each dropdown offers only
    // styles not already taken. Rank is the Final rating (no group/bonus dice
    // apply), and there's no Spec toggle.
    const appendMartialArtRows = () => {
      tbl.append(el("tr", { class: "skill-group-row" },
        el("td", { colspan: "4" }, "Martial Arts", " ", trainedOnlyChip(),
          el("span", { class: "sub" }, "  — 2 pts/rank, ≤ Unarmed Combat"))));
      CHAR.martial_arts.forEach((ma, i) => {
        const styleOpts = allStyles.filter(s => s === ma.style || !usedStyles.has(s));
        const sel = el("select", { class: "ma-style-select",
          onchange: e => { ma.style = e.target.value; refresh(); } },
          el("option", { value: "" }, "Choose style…"),
          ...styleOpts.map(s =>
            el("option", { value: s, ...(ma.style === s ? { selected: 1 } : {}) }, s)));
        tbl.append(el("tr", { class: "skill-grouped" },
          el("td", {}, el("div", { class: "skill-name-line" }, sel,
            el("button", { class: "row-del", title: "Remove this style",
              onclick: () => { CHAR.martial_arts.splice(i, 1); refresh(); } }, "✕"))),
          el("td", { class: "num" }, stepper(
            () => ma.rank || 0, v => { ma.rank = v; refresh(); }, 0, 6)),
          el("td", { class: "num sub" }, ""),
          el("td", { class: "num" }, el("b", {}, String(ma.rank || 0)))));
      });
      const canAdd = usedStyles.size < allStyles.length;
      tbl.append(el("tr", { class: "skill-grouped" },
        el("td", { colspan: "4" },
          el("button", { class: "btn-add", disabled: canAdd ? null : "1",
            title: canAdd ? null : "Every martial art style is already chosen",
            onclick: () => { CHAR.martial_arts.push({ style: "", rank: 0 }); refresh(); } },
            "+ Add martial art style"))));
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
    if (pool === "Brawn") appendMartialArtRows();

    card.append(tbl);
    grid.append(card);
  }
  p.append(grid);

  // rituals \u2014 each is its own skill bought from skill points
  p.append(el("h2", {}, "Rituals ", chip("skill"), " ", trainedOnlyChip()));
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

  // Martial art style effects: the chooser and rank live in the Brawn card
  // above, so this card only reports what each chosen style has unlocked.
  const chosenStyles = CHAR.martial_arts.filter(ma => ma.style);
  if (chosenStyles.length) {
    const mcard = el("div", { class: "card", style: "max-width:640px" },
      el("h3", {}, "Martial Art Style Effects"));
    chosenStyles.forEach(ma => {
      const resolved = (CALC.martial_arts || []).find(r => r.style === ma.style);
      mcard.append(el("div", { class: "sh-h4", style: "margin:10px 0 2px" }, ma.style,
        el("span", { class: "sub" }, ` · rank ${ma.rank || 0}`)));
      if (resolved && resolved.levels.length) {
        resolved.levels.forEach(l =>
          mcard.append(el("div", { class: "stat-line" }, `Level ${l.Level}`, el("b", {}, l.Effect))));
        if (resolved.mods.applied.length)
          mcard.append(el("div", { class: "stat-line" }, "Applied to stats",
            el("b", {}, resolved.mods.applied.join(" · "))));
      } else {
        mcard.append(el("p", { class: "hint" },
          "Raise this style's rank to unlock its level effects."));
      }
    });
    p.append(mcard);
  }
}

/* ------------------------------------------------ 3b. knowledge & etiquette */
function tabKnowledge(p) {
  p.append(el("h2", {}, "Etiquettes ", chip("etq")));
  p.append(el("p", { class: "hint" },
    "2 \u00d7 Charisma points. How smoothly you move through each stratum of society. "
    + "Worn gear, a Wealthy lifestyle and an infused or bonded spirit add to the "
    + "Total without spending points \u2014 see the Gear column."));
  CHAR.etiquettes ??= {};
  const ep = CALC.etiquette_points || {};
  const etqAdjust = ep.adjust || {};
  const etbl = el("table", { style: "max-width:600px" });
  etbl.append(el("tr", {}, el("th", {}, "Etiquette"), el("th", { class: "num" }, "Pts"),
    el("th", { class: "num" }, "Gear"), el("th", { class: "num" }, "Total")));
  for (const name of DATA.etiquettes) {
    const bonus = etqAdjust[name] || 0;
    const base = CHAR.etiquettes[name] || 0;
    const from = (CALC.etiquette_sources || [])
      .filter(s => s.etiquette === name).map(s => `${s.label} +${s.bonus}`);
    etbl.append(el("tr", {},
      el("td", {}, name),
      el("td", { class: "num" }, stepper(
        () => CHAR.etiquettes[name] || 0,
        v => { CHAR.etiquettes[name] = v; }, 0, 6)),
      el("td", { class: "num", title: from.join(", ") || null },
        bonus ? `+${bonus}` : "—"),
      el("td", { class: "num" }, String(base + bonus))));
  }
  p.append(etbl);
  if (Object.keys(etqAdjust).length)
    p.append(el("p", { class: "hint" },
      "Gear bonuses come from what's worn, carried or equipped — they don't spend "
      + "points and they sit outside the cap of 6."));

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

  // House rule: gear/weapon ZR imposes a spellcasting dice penalty (\u22121d per full
  // point) instead of reducing ZP. Surface it here on the Magic tab.
  if (RULES.houseRule("zr") === "houserule" && type !== "Hedge")
    p.append(zrCastingPenaltyNote());

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
          sub: `Drain ${s.Drain || "?"}${s.Duration ? " · " + s.Duration : ""}${s.Effect ? " · " + s.Effect : ""}`,
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
          el("td", {}, el("div", { class: "sub" }, row.Effect || ""),
            descriptionExpander(row.Description, `spells:${it.name}`)),
          el("td", { class: "num" }, "Force ", stepper(() => it.force || 1, v => { it.force = v; }, 1, 6)),
          el("td", {}, el("button", { class: "row-del", onclick: del }, "\u2715")));
      },
    }));
  }

  if (type === "Amp" || type === "Archmage") {
    p.append(el("h2", {}, "Amp Powers"));
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
          el("td", {}, el("b", {}, it.name), el("div", { class: "sub" }, row.Effect || ""),
            descriptionExpander(row.Description, `amp_powers:${it.name}`)),
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
    el("td", { class: "sub" }, r.Effect,
      descriptionExpander(r.Description, `rituals:${r.Name}`)))));
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
      const svcList = spiritServiceList(s);
      return el("tr", {},
        el("td", {}, el("b", {}, name), el("div", { class: "sub" }, `${s.Element} \u00b7 cost ${s.Cost}`)),
        el("td", { class: "sub" },
          `Firearm: ${s.Firearm} \u00b7 Protection: ${s.Protection} \u00b7 Physical: ${s.Physical}`,
          // What this spirit grants once bound, so the two halves of the choice
          // (infusion benefit vs. bound services) can be compared while buying.
          svcList ? expanderPanel(`speaker_spirits:${name}`, "Bound services", svcList) : null),
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
  // Cyberlimb augments may require a cyberarm and/or cyberleg (data "Req Limb").
  const ARM_TYPES = new Set(["Right Arm", "Left Arm"]);
  const LEG_TYPES = new Set(["Right Leg", "Left Leg"]);
  const ownedAugType = e => (DATA.tables.augments.find(a => a.Name === e.name) || {}).Type || "";
  const hasCyberarm = CHAR.augments.some(e => ARM_TYPES.has(ownedAugType(e)));
  const hasCyberleg = CHAR.augments.some(e => LEG_TYPES.has(ownedAugType(e)));
  // Cyberguns are capped at one per cyberarm.
  const cyberarmCount = CHAR.augments.filter(e => ARM_TYPES.has(ownedAugType(e))).length;
  const cybergunCount = CHAR.augments.filter(e => RULES.isCybergunAugment(e.name)).length;
  // Which limb (if any) a cyberlimb augment still needs; null when satisfied.
  const limbUnmet = r => {
    switch (RULES.augmentLimbRequirement(r)) {
      case "Arm": return hasCyberarm ? null : "a Cyberarm";
      case "Leg": return hasCyberleg ? null : "a Cyberleg";
      case "Any": return (hasCyberarm || hasCyberleg) ? null : "a Cyberarm or Cyberleg";
      default:    return null;
    }
  };
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
      const need = limbUnmet(r);
      const bioBanned = syntheticNoBio && r.Type === "Bioware";
      const banned = bioBanned ? "Synthetics cannot install Bioware" : avail.bannedReason(r.Name);
      const dmg = RULES.augmentMeleeDamage(r, CALC.attributes.Strength.final, CALC.martial_art && CALC.martial_art.mods);
      // Cybergun: one per cyberarm, so it stays visible after the first install
      // and disables at capacity rather than hiding.
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
        name: r.Name, cost: +r.Cost,
        sub: [(+r.ZR ? `ZR ${r.ZR}` : ""), (+r.BI ? `BI ${r.BI}` : ""),
              (dmg !== "" ? `DMG ${dmg}` : ""),
              (r.Rarity ? `Rarity ${r.Rarity}` : ""),
              (r.Quality === "Y" ? "quality tiers available" : ""), r.Effect || ""]
          .filter(Boolean).join(" \u00b7 "),
        hidden: isCybergun ? false : avail.hidden(r.Name),
        banned: !!banned,
        disabled,
        reason,
        note,
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
  // Orders the installed list directly below it. The picker further down keeps
  // its category grouping either way.
  p.append(sortToggle("augments"));
  p.append(listEditor({
    items: CHAR.augments,
    sortBy: sortedAZ("augments")
      ? (a, b) => String(a.name).localeCompare(String(b.name)) : null,
    picker: categoryBrowser({ id: "augments", groups: augGroups,
      // A freshly-added Skillsoft only starts slotted if a free Chipjack is
      // still available — otherwise it lands unslotted rather than silently
      // busting the cap (recomputed here, not the stale render-time counts,
      // since several can be added before the panel re-renders).
      onAdd: n => {
        const entry = { name: n, count: 1 };
        if (n.startsWith("Skillsoft")) {
          const jacks = CHAR.augments.filter(a => a.name === "Chipjack")
            .reduce((sum, a) => sum + (a.count || 1), 0);
          const slotted = CHAR.augments
            .filter(a => a.name.startsWith("Skillsoft") && a.slotted !== false).length;
          if (slotted >= jacks) entry.slotted = false;
        }
        CHAR.augments.push(entry);
      } }),
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
      // Cybergun Installation (or its Reload Port variant): choose the mounted
      // gun. Its cost adds to the installation (RULES.augmentEffCost) and its
      // stats replace the effect text.
      let gunSel = null, gun = null;
      if (RULES.isCybergunAugment(it.name)) {
        gun = it.gunType ? (DATA.tables.cyberguns || []).find(g => g.Type === it.gunType) : null;
        gunSel = el("select", { onchange: e => { it.gunType = e.target.value; refresh(); } },
          el("option", { value: "" }, "Choose gun…"),
          ...(DATA.tables.cyberguns || []).map(g =>
            el("option", { value: g.Type }, `${g.Type} (+${fmt(+g.Cost)})`)));
        gunSel.value = it.gunType || "";
      }
      // Cyber melee implants show their computed ½ STR + bonus damage number.
      const implantDmg = RULES.augmentMeleeDamage(r, CALC.attributes.Strength.final, CALC.martial_art && CALC.martial_art.mods);
      const effectText = gun
        ? [r.Effect || "", `${gun.Type}: Acc ${gun.Acc} · DMG ${gun.Dmg} · Ammo ${gun.Ammo} · ${gun.Modes} · Pen ${gun.Pen}${barrierBit(gun, gun.Bar)} · Rarity ${gun.Rarity}`].filter(Boolean).join(" · ")
        : [r.Effect || "", implantDmg !== "" ? `DMG ${implantDmg}` : ""].filter(Boolean).join(" · ");
      // Alpha grade: only augments that carry ZR can go bleeding-edge.
      const hasZr = !!(+r.ZR);
      const alphaZr = hasZr ? RULES.augmentEffZr(r, { alpha: true }) : 0;
      const costOf = () => RULES.augmentEffCost(r, it) * (it.count || 1);
      const costCell = el("td", { class: "num" }, fmt(costOf()));
      const zrCell = el("td", { class: "num" },
        hasZr ? `ZR ${it.alpha ? alphaZr : +r.ZR}` : r.BI ? `BI ${r.BI}` : "");
      const alphaCtl = hasZr
        ? el("label", { class: "opt", title: `\u03b1-cyber grade: ZR ${alphaZr} (\u221220%, min \u22120.1), cost \u00d72 (min +${currencySymbol()}1,000)` },
            el("input", { type: "checkbox", ...(it.alpha ? { checked: "1" } : {}),
              onchange: e => {
                it.alpha = e.target.checked;
                costCell.textContent = fmt(costOf());
                zrCell.textContent = `ZR ${it.alpha ? alphaZr : +r.ZR}`;
                scheduleRecalc();
              } }),
            el("span", {}, "α-cyber"))
        : null;
      // Fashionware quality tier (issue #19): only pieces flagged Quality = Y
      // offer one. It scales the base price; α-grade then applies on top.
      let qualityCtl = null;
      if (r.Quality === "Y") {
        const qs = el("select", { class: "fw-quality-select",
          onchange: e => { it.quality = e.target.value; refresh(); } },
          el("option", { value: "" }, "Quality…"),
          ...(DATA.tables.fashionware_qualities || []).map(q =>
            el("option", { value: q.Quality }, `${q.Quality} ×${q.Multiplier}`)));
        qs.value = it.quality || "";
        qualityCtl = qs;
      }
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
          el("div", { class: "sub" }, `${r.Type || ""}${r.Ban ? ` \u00b7 bans: ${r.Ban}` : ""}`
            + (r.Rarity ? ` \u00b7 Rarity ${r.Rarity}` : "")),
          target, gunSel, qualityCtl),
        el("td", { class: "sub" }, effectText,
          descriptionExpander(r.Description, `augments:${it.name}`)),
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
  // Nothing left to offer (every one-per-piece option already fitted) means no
  // add row at all — an empty dropdown beside a Fit button can only disappoint.
  if (!optionElements.length) return el("div", {}, chips, effects);
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

/* `costOf` prices a row against its host when a flat number won't do — a
 * percentage-priced weapon mod (Bling) is worth a share of the gun it's going
 * on, so the browser can only show a real figure per weapon. The percentage is
 * spelled out beside the effect, since the same mod costs different money on
 * different guns. */
function modGroups(table, nameCol, catCol, fallback, costOf) {
  const byCat = {};
  for (const r of table) {
    const cat = (catCol && r[catCol]) ? r[catCol] : fallback;
    (byCat[cat] ??= []).push(r);
  }
  return Object.entries(byCat).map(([label, rows]) => ({
    label,
    cls: modSlotClass(label),   // colour the group header by slot, when applicable
    items: rows.map(r => {
      const pct = RULES.weaponModCostPercent(r);
      return {
        name: r[nameCol],
        cost: costOf ? costOf(r)
          : ((r.Cost != null && r.Cost !== "") ? +r.Cost : null),
        sub: [r.Effect || r.ModeEffect || "",
              pct != null ? `${pct}% of the weapon's cost` : ""].filter(Boolean).join(" · "),
        cls: catCol ? modSlotClass(r[catCol]) : null,   // colour each item name by slot
      };
    }),
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

/* Display order for a list of things the character already owns, keyed by list
 * id. Module-level for the same reason as browserOpenState: flipping it
 * re-renders the panel, so it can't live in the DOM. */
const listSortState = {};
const sortedAZ = id => listSortState[id] === "az";

/* The added-order/A-Z switch for an owned-items list. Render it directly above
 * the list it controls, and pass the redraw the caller uses. */
function sortToggle(id, redraw = renderPanel) {
  const az = sortedAZ(id);
  const btn = (mode, text) => el("button", {
    class: "cat-sort-btn" + ((mode === "az") === az ? " active" : ""),
    onclick: () => { listSortState[id] = mode; redraw(); },
  }, text);
  return el("div", { class: "cat-sort" },
    el("span", { class: "sub" }, "Sort"), btn("added", "Added"), btn("az", "A–Z"));
}

/* `forceOpen` flips the default the other way: groups start expanded and stay
 * that way unless the reader collapses one. It exists for a filtered list --
 * the Buy dialog's search results are already the answer, and making the reader
 * open five headings to see three matches would hide it again. */
function categoryBrowser({ id, groups, onAdd, rerender, afterAdd, forceOpen }) {
  const redraw = rerender || renderPanel;      // toggling open/closed
  const postAdd = afterAdd || refresh;         // after an item is added
  const state = (browserOpenState[id] ??= {});
  const wrap = el("div", { class: "cat-browser" });
  for (const g of groups) {
    // Items flagged `hidden` (e.g. an owned augment or a lesser rank) drop out.
    const visible = g.items.filter(it => !it.hidden);
    if (!visible.length) continue;
    const open = forceOpen ? state[g.label] !== false : !!state[g.label];
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
  const rowOf = name => DATA.tables.augments.find(a => a.Name === name) || {};
  // Tier parsing and the stackable-family list live in rules.js, so the picker
  // hides exactly what the engine refuses to let you finalize holding.
  const isStackable = name => RULES.augmentStacks(name, DATA.tables);
  const parse = RULES.augmentTier;
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
  Projectile: "Bows & Crossbows",
};
/* Weapon types with no mod slots: the weapon_mods table is barrels, silencers,
   magazines and sights for firearms. Shared with sheet.js so the chargen and
   play rows agree about which weapons show a mod strip. */
const NO_WEAPON_MOD_TYPES = ["Melee", "Thrown", "GrenadeLauncher", "Heavy", "Energy", "Projectile"];
/* Barrier ("Bar" in the data) is the 0-5 rating for shooting through cover.
   A blank means the stat doesn't apply — melee, thrown and the weapons that
   simply have no rating — so it prints nothing rather than a misleading 0.
   Grenade launchers are the exception: they carry no rating of their own and
   take the chambered grenade's, so they always show the stat, as an em dash
   while empty. Returns a ready-to-concatenate " · Barrier N" or "". Shared
   with sheet.js so the chargen and play stat lines agree. */
function barrierBit(row, value) {
  const v = value == null ? "" : String(value);
  if (!v && (row || {}).Type !== "GrenadeLauncher") return "";
  return ` · Barrier ${v || "—"}`;
}
/* Conceal, showing what the fitted mods did to it. Every mod bolted to a gun
   carries a Concealability that adds onto the weapon's own rating, so the
   number on a modded weapon is not the number in the data — say so, and say by
   how much, rather than leaving the player to wonder which one they're reading.
   Shared with sheet.js so chargen and play agree. */
function concealBit(row, calcRow) {
  const c = (calcRow || {}).Conceal ?? (row || {}).Conceal ?? 0;
  const mod = (calcRow || {}).conceal_mod || 0;
  // A loaded round can move Conceal too (#86), and it can move it DOWN, so the
  // sign is written rather than assumed -- "(+2 mods)" but "(-1 ammo)". The
  // label names whatever sources contributed.
  const label = (calcRow || {}).conceal_mod_label || "mods";
  return `${c || 0}${mod ? ` (${signed(mod)} ${label})` : ""}`;
}
/** "+2" / "-1" -- an adjustment printed with its sign either way. */
function signed(n) { return `${n > 0 ? "+" : ""}${n}`; }
/* Recoil capacity for one gun: the shooter's own capacity plus whatever is
   bolted to this weapon, or "Ignored" when Gun-Kata rank 3 covers the type.
   Blank for melee, thrown and anything the engine didn't rate — there is no
   recoil to absorb, and a Katana reading "Recoil 3" would be pure noise.
   Shared with sheet.js so chargen and play agree. */
function recoilBit(calcRow) {
  const c = calcRow || {};
  // Under the "No Recoil" house rule recoil isn't a stat, so no weapon carries
  // one — every gun line in chargen and in play goes through here (#61).
  if (!RULES.recoilInPlay()) return "";
  if (c.recoil_ignored) return " · Recoil ignored";
  if (c.Recoil == null) return "";
  // A cybergun labels its own contribution "implanted" rather than "mods" —
  // it isn't bolted on, it's the arm the gun is built into.
  const label = c.recoil_mod_label || "mods";
  return ` · Recoil ${c.Recoil}${c.recoil_mod ? ` (${signed(c.recoil_mod)} ${label})` : ""}`;
}
/* Everything a weapon carries that isn't a number: the mods built into it at
   the factory and, for a sealed weapon, the fact that it can't be reloaded.
   Read off the data row, so it says the same thing in chargen and in play, and
   before a character owns one as well as after. Ready to concatenate. */
function weaponTraitBits(row) {
  const bits = (RULES.weaponIntegratedMods(row, DATA.tables.weapon_mods) || [])
    .map(m => `integrated ${m}`);
  if (RULES.weaponIsOneshot(row)) bits.push(RULES.ONESHOT_NOTE);
  return bits.length ? ` · ${bits.join(" · ")}` : "";
}
function tabWeapons(p) {
  p.append(el("h2", {}, "Weapons ", chip("cash")));
  p.append(el("p", { class: "hint" },
    "Smart-capable weapons cost double their base price; integrated-smart weapons are always Smart at no extra cost. Each weapon takes one Underbarrel, one Overbarrel, and Chassis mods. "
    + "Melee, Thrown, and Grenade Launcher weapons can't take mods. Thrown weapons can be bought in quantity."));
  if (CALC.combat.optics_notes && CALC.combat.optics_notes.length)
    p.append(el("p", { class: "hint" }, "Optics: " + CALC.combat.optics_notes.join(" · ")));
  const weaponGroups = Object.entries(
    DATA.tables.weapons.reduce((acc, r) => (((acc[r.Type] ??= []).push(r)), acc), {}))
    .map(([type, rows]) => ({
      label: WEAPON_TYPE_LABELS[type] || type,
      items: rows.map(r => ({
        name: r.Weapon,
        // A bow has no price of its own — it's priced per point of Minimum
        // Strength, which is chosen on the row once it's bought.
        cost: RULES.bowRating(r, {}) ? 0 : +r.Cost,
        // Some weapons require another weapon already equipped (e.g. the
        // Militech M31-a1G under-barrel launcher needs its host rifle).
        disabled: Boolean(r.Requires) && !CHAR.weapons.some(
          w => w.name === r.Requires && w.equipped !== false),
        reason: r.Requires ? `Requires an equipped ${r.Requires}.` : null,
        // weaponTraitBits carries integrated mods and the Oneshot ("Polymer
        // Oneshot, cannot be reloaded") note -- both intrinsic to the row, so
        // they cost nothing to show before the weapon is ever bought. Every
        // other stat here already came off the row too; only Recoil doesn't,
        // since it depends on the buying character's Strength and isn't
        // computed for something not yet owned.
        sub: (RULES.bowRating(r, {})
          ? `${fmt(+r.StrCost)} per point of Min STR · Damage = Min STR +${r.StrDmg} · `
            + `Rarity = Min STR ÷ 2 · ZR ${r.ZR || 0} · Acc ${r.Accuracy || 0} · `
            + `Weight ${r.Weight || 0} · Pen ${r.Pen || 0} · Conceal ${r.Conceal || 0}${weaponTraitBits(r)}`
          : r.Type === "Melee"
          ? `Rarity ${r.Rarity || "\u2014"} \u00b7 ZR ${r.ZR || 0} \u00b7 Reach ${r.Reach || 0} \u00b7 Weight ${r.Weight || 0} \u00b7 Pen ${r.Pen || 0}${barrierBit(r, r.Bar)} \u00b7 Conceal ${r.Conceal || 0} \u00b7 Damage ${RULES.meleeDamage(r, CALC.attributes.Strength.final)}${weaponTraitBits(r)}`
          : `Rarity ${r.Rarity || "\u2014"} \u00b7 ZR ${r.ZR || 0} \u00b7 Acc ${r.Accuracy || 0} \u00b7 ${r["Firing modes"] || ""} \u00b7 Weight ${r.Weight || 0} \u00b7 Pen ${r.Pen || 0}${barrierBit(r, r.Bar)} \u00b7 Conceal ${r.Conceal || 0} \u00b7 Damage ${r.Damage}${weaponTraitBits(r)}`),
      })),
    }));
  p.append(listEditor({
    items: CHAR.weapons,
    picker: categoryBrowser({ id: "weapons", groups: weaponGroups,
      onAdd: n => {
        const r = DATA.tables.weapons.find(x => x.Weapon === n) || {};
        const entry = { name: n, smart: Boolean(r["Integrated Smart"]),
          mods: [], equipped: true, qty: 1 };
        // A bow is rated to a draw weight. Default it to the heaviest this
        // character can actually draw — that's the one they'd buy — and let the
        // Min STR stepper on the row take it down if they want it cheaper.
        if (RULES.bowRating(r, {})) entry.min_str = Math.max(1, CALC.attributes.Strength.final);
        CHAR.weapons.push(entry);
      } }),
    onRemove: i => CHAR.weapons.splice(i, 1),
    render: (it, i, del) => {
      const r = DATA.tables.weapons.find(x => x.Weapon === it.name) || {};
      const calcRow = (CALC.weapons || []).find(x => x.Weapon === it.name) || {};
      const isMelee = r.Type === "Melee";
      const isThrown = r.Type === "Thrown";
      // Only firearms take the mod slots — the mod table is barrels, silencers
      // and magazines. Melee, Thrown, Grenade Launchers, Heavy, Energy and
      // Projectile (bows and crossbows) have nothing to fit them to.
      const canMod = !NO_WEAPON_MOD_TYPES.includes(r.Type);
      // Stripped guns have their circuits removed — nothing left to smart-link.
      // Smartlink needs a gun with circuitry to talk to: not a blade, not a
      // thrown weapon, not a bow, and not one whose electronics were stripped.
      const canSmart = !isMelee && !isThrown && r.Type !== "Projectile"
        && !/\(Stripped\)$/.test(it.name);
      // Integrated-smart weapons are always Smart (no cost bump): keep the
      // saved flag in sync (covers characters made before the data flag) and
      // lock the checkbox on.
      const integratedSmart = Boolean(r["Integrated Smart"]);
      if (integratedSmart && !it.smart) it.smart = true;
      return el("tr", {},
        el("td", {}, el("b", {}, it.name),
          el("div", { class: "sub" },
            `${r.Type} \u00b7 Acc ${calcRow.Accuracy ?? r.Accuracy ?? 0}${calcRow.smartlink ? " (smart)" : ""} \u00b7 DMG ${calcRow.Damage ?? r.Damage} \u00b7 ${r["Firing modes"] || "melee"} \u00b7 Pen ${r.Pen || 0}${barrierBit(r, calcRow.Bar ?? r.Bar)} \u00b7 Conceal ${concealBit(r, calcRow)} \u00b7 ZR ${r.ZR || 0} \u00b7 Weight ${r.Weight || 0}${weaponTraitBits(r)}${recoilBit(calcRow)}`
            + (isThrown ? ` \u00b7 \u00d7${it.qty || 1}` : "")),
          canMod ? fittedCategoryEditor({
            id: `wmods-${i}-${it.name}`,
            items: it.mods || [],
            // Prices are per-weapon: a percentage-costed mod is a share of this
            // gun (a bow's price comes from its draw Strength, not a data cell).
            groups: modGroups(DATA.tables.weapon_mods, "Modification", "Slot", null,
              m => RULES.weaponModCost(m, RULES.weaponBaseCost(r, it))),
            // One mod per slot (Overbarrel / Underbarrel / Chassis): refuse a
            // mod that would leave the fitted set without a free slot.
            guard: name => {
              if ((it.mods || []).includes(name)) return `${name} is already fitted.`;
              // Built into this weapon already — fitting a second would charge
              // for it and double its effect.
              if (RULES.weaponIntegratedMods(r, DATA.tables.weapon_mods).includes(name))
                return `${name} is built into this weapon — it's already fitted, free.`;
              // Some mods are restricted to a weapon category (e.g. Bi-pod is
              // Rifle-only via the data "Req Type" column).
              const modRow = DATA.tables.weapon_mods.find(m => m.Modification === name) || {};
              if (modRow["Req Type"] && r.Type !== modRow["Req Type"])
                return `${name} can only be mounted on ${WEAPON_TYPE_LABELS[modRow["Req Type"]] || modRow["Req Type"]}.`;
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
          minStrControl(it, r, refresh),
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
    "One Outer and one Under piece active at a time. Quality applies to any piece; styleable pieces also take a Style and Extras. Each multiplier surcharges the base cost."));
  const styles = DATA.tables.armor_styles, mats = DATA.tables.armor_materials,
    extras = DATA.tables.armor_extras;
  // Rarity and ZR are shown here to match the weapons list above -- both were
  // on the row all along, just missing from the buying list (issue #63).
  const armorItem = r => ({ name: r.Armor, cost: +r.Cost,
    sub: `Rarity ${r.Rarity || "\u2014"} \u00b7 ZR ${r.ZR || 0} \u00b7 ${r.Ballistic}B / ${r.Impact}I \u00b7 wt ${r.wt}${r.Style === "Y" ? " \u00b7 styleable" : ""}` });
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
      // Quality applies to every piece; Style and Extras are cosmetic and only
      // offered on styleable pieces (Style = Y).
      const styleable = r.Style === "Y";
      const ms = el("select", { onchange: e => { it.material = e.target.value; refresh(); } },
        el("option", { value: "" }, "Quality\u2026"),
        ...mats.map(m => el("option", { value: m.Material }, `${m.Material} \u00d7${m.Multiplier}`)));
      ms.value = it.material || "";
      const styleCtl = el("div", {}, ms);
      if (styleable) {
        const ss = el("select", { onchange: e => { it.style = e.target.value; refresh(); } },
          el("option", { value: "" }, "Style\u2026"),
          ...styles.map(s => el("option", { value: s.Style }, `${s.Style} \u00d7${s.Multiplier}`)));
        ss.value = it.style || "";
        styleCtl.append(" ", ss,
          fittedItemsEditor({
            items: it.extras || [],
            placeholder: "Extra\u2026",
            // A piece takes one of each extra, so the dropdown offers only what
            // this one isn't already wearing; unfit a chip and it comes back.
            optionElements: extras
              .filter(x => !(it.extras || []).includes(x.Extra))
              .map(x => el("option", { value: x.Extra }, `${x.Extra} \u00d7${x.Multiplier}`)),
            onAdd: name => it.extras.push(name),
            onRemove: index => it.extras.splice(index, 1),
            // No effectOf: the effects line below already reports every fitted
            // extra alongside the Quality and Style ones, so listing them by the
            // chips as well printed each one twice.
          }));
      } else {
        styleCtl.append(el("div", { class: "sub" }, "fixed design \u2014 no Style"));
      }
      // Effects of the chosen Quality / Style / Extras (issue #18).
      const effs = calcRow.effects || [];
      if (effs.length) styleCtl.append(el("div", { class: "sub armor-effects" },
        effs.map(e => `${e.label}: ${e.text}`).join(" \u00b7 ")));
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

/* Which Hacking program is slotted into this deck — its operating system.
 * Lists only the ones the character owns, so buy the program first, then slot
 * it; a character with Hacking 2 and Hacking 4 can put the right one in each
 * deck. Shared by chargen and the play sheet so both read the same. */
function hackingSlotSelect(deck, deckRow, onChange) {
  const owned = (CHAR.programs || []).filter(RULES.isHackingProgram)
    .sort((a, b) => RULES.hackingProgramRating(a) - RULES.hackingProgramRating(b));
  const required = RULES.deckHackingRequired(deckRow);
  const slotted = deck.hacking || "";
  const rating = RULES.hackingProgramRating(slotted);
  const state = !slotted ? "bad" : (!owned.includes(slotted) ? "bad"
    : (rating < required ? "warn" : "ok"));
  const sel = el("select", {
    title: `This deck needs a Hacking program rated ${required} (½ MCP ${deckRow.MCP || 0})`,
    onchange: e => { deck.hacking = e.target.value; onChange(); } },
    el("option", { value: "" }, owned.length ? "— no Hacking program —" : "— none owned —"),
    ...owned.map(n => el("option", { value: n },
      `${n}${RULES.hackingProgramRating(n) < required ? " (under ½ MCP)" : ""}`)));
  sel.value = slotted;
  const note = state === "ok" ? null
    : el("span", { class: "sub", style: "color:var(--bad)" },
        state === "warn" ? ` needs ${required}` : " deck won't run");
  return el("div", { class: "sub", style: "margin-top:4px" },
    el("b", {}, "Hacking program "), sel, note);
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
    // Fitted mods and the slotted Hacking program name live on the deck object,
    // so they go with it. The program itself is owned separately and stays —
    // it's a chip you can put in another deck, and it appears in the Programs
    // list below where it can be sold like anything else.
    onRemove: i => CHAR.decks.splice(i, 1),
    render: (it, i, del) => {
      const r = DATA.tables.decks.find(x => x.Name === it.name) || {};
      return el("tr", {},
        el("td", {}, el("b", {}, it.name),
          el("div", { class: "sub" },
            `MCP ${r.MCP} \u00b7 Hardening ${RULES.deckHardening(it, DATA.tables)} \u00b7 Threads ${r.Threads} \u00b7 Core ${r.Core} \u00b7 IO ${r.IO} \u00b7 ${r.Mods} mod slot(s)`
            + ` \u00b7 Range ${RULES.deckHackRange(it, DATA.tables)} m`),
          fittedCategoryEditor({
            id: `dmods-${i}-${it.name}`,
            items: it.mods || [],
            groups: modGroups(DATA.tables.deck_mods, "Deck Mod", null, "Deck Mods"),
            onAdd: name => it.mods.push(name),
            onRemove: index => it.mods.splice(index, 1),
            effectOf: name =>
              (DATA.tables.deck_mods.find(m => m["Deck Mod"] === name) || {}).Effect || "",
          }),
          hackingSlotSelect(it, r, refresh),
          carriedToggle(it, refresh)),
        el("td", { class: "num" }, fmt(r.Cost)),
        el("td", {}, el("button", { class: "row-del", onclick: del }, "\u2715")));
    },
  }));

  appendIf(p, activeDeckSelect());   // null until a deck is owned

  // What each owned deck needs, and whether its slotted program covers it. The
  // program itself is bought below with the rest, and slotted on the deck row.
  const hackCard = el("div", { class: "card", style: "max-width:640px" });
  hackCard.append(el("h3", {}, "Hacking Programs"));
  hackCard.append(el("p", { class: "hint" },
    "A deck runs on a Hacking program slotted into it \u2014 buy one below, then pick it "
    + "on the deck. It must be rated at least \u00bd the deck's MCP (round down, min 1); "
    + "without one the deck doesn't run at all. It costs no thread and no I/O, and can "
    + "be moved between decks. Effective Hacking skill = \u00bd MCP, max 6."));
  for (const d of CHAR.decks) {
    const r = DATA.tables.decks.find(x => x.Name === d.name);
    if (!r) continue;
    const req = RULES.deckHackingRequired(r);
    const rating = RULES.hackingProgramRating(d.hacking);
    const owned = (CHAR.programs || []).includes(d.hacking);
    const ok = d.hacking && owned && rating >= req;
    hackCard.append(el("div", { class: "stat-line" },
      `${d.name} (MCP ${r.MCP}) requires rating ${req}`,
      el("b", { style: ok ? "color:var(--ok)" : "color:var(--bad)" },
        !d.hacking ? "none slotted" : !owned ? "not owned" : ok ? d.hacking : `${d.hacking} \u2014 short`)));
  }
  if (!CHAR.decks.length)
    hackCard.append(el("p", { class: "hint" }, "No decks owned \u2014 none required."));
  p.append(hackCard);

  p.append(el("h2", {}, "Programs"));
  // Hacking leads: it's what makes a deck run, not one more tool to run on it.
  const progGroups = [RULES.HACKING_PROGRAM_CATEGORY, "Attack", "Control", "Util"].map(cls => ({
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
        el("td", { class: "sub" }, r.Effect || "",
          descriptionExpander(r.Description, `programs:${name}`)),
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
      + barrierBit(r, r.Bar)
      + (r.Ammo ? ` \u00b7 Ammo ${r.Ammo}` : "")
      + (r.ModeEffect ? ` \u00b7 ${r.ModeEffect}` : "");
  };
  // The picker is one combined list, but the two kinds live in separate arrays:
  // rules.js reads unit.mods for a mod's stat effects, and
  // migrateUnitAttachments moves any mod found in unit.weapons across on the
  // next recalc. So render BOTH arrays and route each add/remove to the one the
  // name belongs to -- otherwise a fitted mod drops out of this list on the next
  // recalc while still being charged for and still affecting the unit's stats,
  // with no way left to take it off (issue #24).
  const modName = m => (typeof m === "string" ? m : (m && m.name) || "");
  const entries = [
    ...(it.weapons || []).map((name, i) => ({ name, list: "weapons", i })),
    ...(it.mods || []).map((m, i) => ({ name: modName(m), list: "mods", i })),
  ].filter(e => e.name);
  return fittedItemsEditor({
    items: entries.map(e => e.name),
    placeholder: "Fit weapon/mod\u2026",
    optionElements: weaponTables.map(([table, nameColumn]) =>
      el("optgroup", { label: nameColumn },
        ...DATA.tables[table].map(r => el("option", { value: r[nameColumn] },
          `${r[nameColumn]} \u2014 ${fmt(r.Cost)} \u00b7 wt ${r.Weight || 0}`
          + (r.ModeEffect ? " \u00b7 " + r.ModeEffect : ""))))),
    onAdd: name => {
      const found = findFitting(name, weaponTables);
      const key = found && !found.isWeapon ? "mods" : "weapons";
      (it[key] ??= []).push(name);
    },
    onRemove: index => {
      const e = entries[index];
      if (e) (it[e.list] || []).splice(e.i, 1);
    },
    guard,
    effectOf: describeFitting,
  });
}
/* Vehicle Condition selector — scales the base price only (Pristine ×1, Good
 * ×0.75, Fair ×0.5, Poor ×0.25). Shared by chargen and the play sheet; `onChange`
 * is the caller's recompute/re-render. */
/* Condition picker for a drone or vehicle. Scales the base chassis price, and a
 * condition carrying a gameplay rider (Blinged) shows it alongside — reported,
 * not applied, since it only counts when the unit is actually on show. */
function vehicleConditionSelect(it, onChange) {
  it.condition = it.condition || "Pristine";
  const sel = el("select", { onchange: e => { it.condition = e.target.value; onChange(); } },
    ...RULES.VEHICLE_CONDITIONS.map(c =>
      el("option", { value: c }, `${c} (×${RULES.VEHICLE_CONDITION_FACTORS[c]})`)));
  sel.value = it.condition;
  const effect = RULES.VEHICLE_CONDITION_EFFECTS[it.condition];
  return el("label", { class: "sub", style: "display:inline-flex;align-items:center;gap:6px;margin-top:4px" },
    el("span", {}, "Condition"), sel,
    effect ? el("span", { style: "color:var(--manon)" }, effect) : null);
}

/* Which rig is jacked in. Only the active rig contributes Zoetic Rating and
 * rigging exploit actions, and creation used to have no way to say — so a rig
 * bought in chargen silently counted for nothing. Writes the same
 * play.rigging.active_rig the play sheet uses; with nothing chosen the engine
 * falls back to the first owned rig, which is what this select shows. */
/* Equipped deck / rig. A character can own and carry any number, but exactly
 * one of each is jacked in at a time — only that one contributes its Zoetic
 * Rating and its Decking/Rigging exploit actions. Exclusivity is structural:
 * the choice is a single name, so there is no way to mark two.
 *
 * The default (first owned) is written through rather than merely displayed,
 * so the record says which one is equipped instead of leaving the engine to
 * infer it from list order. */
/* Returns null when there's nothing to equip. Callers must NOT hand that
 * straight to Element.append(), which stringifies a non-Node argument and
 * renders the literal word "null" on the page — use appendIf. */
/* `none`, when given, adds an explicit "nothing equipped" option: {label, get,
   set}. It is a stored flag of its own rather than an empty selection, because
   an empty choice already means "never chose" and has to keep resolving to the
   first owned item — see RULES.equippedDeckName. While it is set, the select
   shows that option and the implied-default write below is skipped, so the
   remembered choice survives to be jacked back into. */
function equippedSelect({ owned, get, set, title, hint, carriedOf, none }) {
  if (!owned.length) return null;
  // A value no item name can collide with; the flag, not this string, is
  // what gets stored.
  const NONE = "__none__";
  const names = owned.map(o => o.name);
  const isNone = !!(none && none.get());
  const current = names.includes(get()) ? get() : names[0];
  if (!isNone && get() !== current) set(current);   // persist the implied default
  const sel = el("select", { onchange: e => {
      const picked = e.target.value === NONE;
      if (none) none.set(picked);
      if (!picked) set(e.target.value);
      refresh();
    } },
    ...owned.map(o => el("option", { value: o.name },
      o.name + (carriedOf && carriedOf(o) === false ? " (not carried)" : ""))),
    none ? el("option", { value: NONE }, none.label) : null);
  sel.value = isNone ? NONE : current;
  const entry = owned.find(o => o.name === current);
  const notCarried = !isNone && carriedOf && entry && carriedOf(entry) === false;
  return el("div", { class: "card", style: "max-width:520px" },
    el("h3", {}, title),
    el("p", { class: "hint" }, hint),
    sel,
    notCarried ? el("p", { class: "hint", style: "color:var(--bad)" },
      "This one isn't marked carried — you can't be jacked into gear you left at home.") : null);
}

function activeRigSelect() {
  const rigging = ((CHAR.play ??= {}).rigging ??= { active_rig: "", units: {} });
  return equippedSelect({
    owned: CHAR.rigs,
    get: () => rigging.active_rig, set: v => { rigging.active_rig = v; },
    title: "Equipped rig",
    hint: "The rig you're jacked into. Only this one contributes its Zoetic Rating "
      + "and rigging exploit actions; the rest are just owned.",
  });
}

function activeDeckSelect() {
  const decking = ((CHAR.play ??= {}).decking ??= { active_deck: "", loaded: [] });
  return equippedSelect({
    owned: CHAR.decks,
    get: () => decking.active_deck, set: v => { decking.active_deck = v; },
    title: "Equipped deck",
    hint: "The deck you're running. Only this one contributes its Decking exploit "
      + "actions, and only its threads are available; the rest are just owned. "
      + "Carry as many as you like — one runs at a time, or none at all.",
    carriedOf: d => d.carried,
    // Owning a deck and running one are different things: a deck you're jacked
    // out of is still carried and still needs no Hacking program to sit there.
    none: { label: "— none (jacked out) —",
      get: () => !!decking.jacked_out,
      // Through RULES.jackOutDeck so this clears the threads exactly the way
      // the play sheet's own "Jack out" button does.
      set: v => { if (v) RULES.jackOutDeck(CHAR); else decking.jacked_out = false; } },
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
            `Bonus ${st.bonusDice}d \u00b7 Hardening ${st.hardening >= 0 ? "+" : ""}${st.hardening} \u00b7 Links ${st.links} \u00b7 Cores ${st.cores} \u00b7 ${st.modSlotsUsed}/${st.modSlots} mod slot(s)${slotWarn}`
            + (st.unit_hardening ? ` \u00b7 +${st.unit_hardening} Hardening to linked units` : "")),
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
  appendIf(p, activeRigSelect());    // null until a rig is owned

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
        // Both arrays count toward WW and hard points -- rules.js prices and
        // limits off the union too, so reading only `weapons` here let a mod
        // slip past the weight guard once migrateUnitAttachments moved it.
        const fitted = () => [...(it.weapons || []), ...(it.mods || [])]
          .map(n => findFitting(typeof n === "string" ? n : (n && n.name), wtabs))
          .filter(Boolean);
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
            vehicleConditionSelect(it, refresh),
            carriedToggle(it, refresh),
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
function gearLinkSelect(it, onChange) {
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
  const sel = el("select", { onchange: e => { it.link = e.target.value; (onChange || scheduleRecalc)(); } },
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
        sub: [(+r.Dependence ? `Dependence ${r.Dependence}` : ""), r.Effect || "", r.Notes || ""]
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
      // Ammo is bought per use, so the qty stepper below is a "uses" count.
      const isAmmo = (r.Class || "").startsWith("Ammo");
      return el("tr", {},
        el("td", {}, el("b", {}, it.name),
          el("div", { class: "sub" },
            [(+r.Dependence ? `Dependence ${r.Dependence}` : ""), r.Effect || "", r.Notes || ""]
              .filter(Boolean).join(" · ")),
          isAmmo ? el("div", { class: "sub" }, `${fmt(+r.Cost || 0)} per use`) : null,
          gearLinkSelect(it),
          mountEditor(it, r, it.carried !== false)),
        costCell,
        el("td", { class: "num" }, stepper(() => it.qty || 1,
          v => { it.qty = v; costCell.textContent = fmt((+r.Cost || 0) * v); }, 1, 99)),
        // More than one owned makes "how many am I carrying" a real question, so
        // it gets a 0..owned spinner; a single item stays a plain yes/no.
        // The label leads (issue #26, applied here to match the play Gear tab):
        // trailing it left the Qty and Carried spinners running together as one
        // undifferentiated row of -/+ buttons.
        el("td", {},
          el("label", { class: "opt" },
            el("span", {}, "Carried"),
            ownedQty(it) > 1
              ? stepper(() => carriedQty(it), v => setCarriedQty(it, v), 0, ownedQty(it))
              : el("input", { type: "checkbox", ...(it.carried !== false ? { checked: 1 } : {}),
                  onchange: e => {
                    setCarriedQty(it, e.target.checked ? ownedQty(it) : 0);
                    refresh();
                  } }))),
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
      `Heritage surcharge \u00d7${CALC.budget.gear_cost_multiplier} on weapons, armor, `
      + "vehicle chassis and cybertechtronic augments (vehicle mods/weapons, Bioware, "
      + "drones, rigs, decks, gear and lifestyle unaffected)."));
  if (CALC.budget.armor_cost_multiplier > 1)
    p.append(el("p", { class: "hint" },
      `Extra limb surcharge \u00d7${CALC.budget.armor_cost_multiplier} on Armor `
      + "(Extra Arm / Extra Leg need custom-fitted armor)."));
}

// Deferred to DOMContentLoaded so every later script (sheet.js, workspace.js)
// is defined before boot() — which restores the workspace and may open the
// play sheet — runs.
if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", boot);
else
  boot();
