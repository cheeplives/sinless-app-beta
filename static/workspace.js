/**
 * workspace.js — multiple characters open at once, browsed via a tab strip.
 *
 * The rest of the app is built around three shared globals (see app.js):
 * DATA, CHAR, CALC. Only ONE character is "live" at a time — it's mirrored
 * into CHAR/CALC, and every view re-renders wholesale from those globals.
 * This module keeps an ordered list of OPEN characters and swaps which one is
 * live, so switching a tab is just: point CHAR at that tab's character,
 * recalc, and re-render whichever view (chargen #app or play #sheet) matches
 * its `finalized` flag.
 *
 * Nothing in app.js / sheet.js needs to know it's one of many: they keep
 * reading and mutating the global CHAR. The only integration points are the
 * handful of places that used to REPLACE CHAR (New / Load / Import / Delete /
 * boot) — those now route through openCharacter / newCharacterTab / closeTab
 * so the active tab slot stays in sync with the global.
 *
 * Persistence: the set of open (named) characters + the active index is saved
 * under sinless:workspace, so a reload restores the workspace. Each open tab's
 * character lives in its own storage slot (keyed by street name, as always);
 * the descriptor just records which ones are open. Unnamed drafts can't be
 * keyed, so — exactly as before this feature — they don't survive a reload.
 */
"use strict";

/* Namespaced per signed-in user (device-local, but separated by account so two
 * people on one browser don't share an open-tabs list). */
function workspaceKey() {
  const prefix = (typeof SYNC !== "undefined" && SYNC.userPrefix) ? SYNC.userPrefix() : "sinless:";
  return prefix + "workspace";
}
const WORKSPACE_PERSIST_DEBOUNCE_MS = 500;

/* tabs: [{ char, view }]. `view` remembers each tab's UI cursor so switching
 * back lands where you left off. Which screen a tab shows is derived from
 * char.finalized, so there's no separate view-mode flag. */
const WORKSPACE = { tabs: [], active: 0 };

function defaultView() {
  return { activeTab: "priorities", sheetTab: "overview", expandedPool: null };
}

/* ---- live cursor <-> per-tab view ---------------------------------------
 * activeTab lives in app.js; sheetTab / expandedPool in sheet.js. All are
 * plain module-level `let`s on the shared script scope, so we read and write
 * them directly here. */
function stashView(tab) {
  if (!tab) return;
  tab.view = { activeTab, sheetTab, expandedPool };
}

/* Persist a tab's character to its storage slot — only if it has a name (the
 * slot is keyed by street name). Finalized chars already autosave on every
 * play change; this covers chargen chars at deliberate moments (leaving or
 * closing a tab, unload) so a reload can restore them. Never called mid-keystroke,
 * which would save partial names into orphan slots. */
function commitTabChar(tab) {
  if (!tab || tab.readonly) return;   // read-only shared views are never saved
  if (tab.char.name) STORAGE.saveCharacter(tab.char);
}
/* Leaving the active tab: remember where the cursor was AND flush the char. */
function leaveTab(tab) { stashView(tab); commitTabChar(tab); }
function commitAllTabs() { WORKSPACE.tabs.forEach(commitTabChar); }
function restoreView(tab) {
  const v = tab.view || defaultView();
  activeTab = v.activeTab || "priorities";
  sheetTab = v.sheetTab || "overview";
  expandedPool = v.expandedPool || null;
}

function activeTabObj() { return WORKSPACE.tabs[WORKSPACE.active] || null; }

/* ---- drag-to-reorder -----------------------------------------------------
 * Pointer Events (not HTML5 drag-and-drop) so it works with both mouse and
 * touch on the tablets we target. A small movement threshold distinguishes a
 * reorder from a plain tab-switch tap; while dragging, the tabs array reorders
 * live as the pointer crosses each chip's midpoint, and the strip re-renders. */
let tabDrag = null;            // { tab, startX, startY, dragging, activeChar }
let suppressTabClick = false;  // set after a drag so the trailing click doesn't switch tabs
const TAB_DRAG_THRESHOLD = 6;  // px before a press becomes a drag

function onTabPointerDown(e, tab) {
  if (e.button != null && e.button > 0) return;             // primary button only
  if (e.target.closest(".ws-dup, .ws-close")) return;       // let the chip buttons work
  tabDrag = { tab, startX: e.clientX, startY: e.clientY, dragging: false,
              activeChar: activeTabObj() ? activeTabObj().char : null };
  window.addEventListener("pointermove", onTabPointerMove);
  window.addEventListener("pointerup", onTabPointerUp, { once: true });
}

function onTabPointerMove(e) {
  if (!tabDrag) return;
  if (!tabDrag.dragging) {
    if (Math.hypot(e.clientX - tabDrag.startX, e.clientY - tabDrag.startY) < TAB_DRAG_THRESHOLD) return;
    tabDrag.dragging = true;
    document.body.classList.add("ws-reordering");
  }
  e.preventDefault();
  const chips = [...document.querySelectorAll("#workspace-tabs .ws-tab")];
  const from = WORKSPACE.tabs.indexOf(tabDrag.tab);
  if (from < 0) return;
  // Target slot: leftmost right-neighbor whose midpoint we've passed, or the
  // first left-neighbor we've moved before. Insert index is valid post-splice.
  let to = from;
  for (let k = 0; k < chips.length; k++) {
    if (k === from) continue;
    const mid = chips[k].getBoundingClientRect().left + chips[k].getBoundingClientRect().width / 2;
    if (k < from && e.clientX < mid) { to = k; break; }
    if (k > from && e.clientX > mid) { to = k; }
  }
  if (to !== from) {
    WORKSPACE.tabs.splice(from, 1);
    WORKSPACE.tabs.splice(to, 0, tabDrag.tab);
    WORKSPACE.active = Math.max(0, WORKSPACE.tabs.findIndex(t => t.char === tabDrag.activeChar));
    renderWorkspaceBar();
  }
  const chipNow = document.querySelectorAll("#workspace-tabs .ws-tab")[WORKSPACE.tabs.indexOf(tabDrag.tab)];
  if (chipNow) chipNow.classList.add("ws-dragging");
}

function onTabPointerUp() {
  window.removeEventListener("pointermove", onTabPointerMove);
  if (tabDrag && tabDrag.dragging) {
    document.body.classList.remove("ws-reordering");
    renderWorkspaceBar();
    persistWorkspace();
    suppressTabClick = true;                       // swallow the click that follows this drag
    setTimeout(() => { suppressTabClick = false; }, 0);
  }
  tabDrag = null;
}

/* ---- render the strip ---------------------------------------------------- */
function renderWorkspaceBar() {
  const bar = $("#workspace-tabs");
  if (!bar) return;
  bar.replaceChildren(
    el("div", { class: "ws-tabs" },
      ...WORKSPACE.tabs.map((tab, i) => {
        const active = i === WORKSPACE.active;
        const name = (tab.char.name || "").trim() || "Unnamed";
        const finalized = !!tab.char.finalized;
        const ro = !!tab.readonly;
        const chip = el("div", {
          class: "ws-tab" + (active ? " active" : "") + (ro ? " ws-readonly" : ""),
          role: "button", tabindex: "0",
          title: ro ? `${name} — shared by ${tab.owner || "member"} (read only)`
                    : `${name} — ${finalized ? "play" : "chargen"}`,
          "aria-current": active ? "true" : null,
          onpointerdown: e => onTabPointerDown(e, tab),
          onclick: () => { if (suppressTabClick) { suppressTabClick = false; return; } switchTab(i); },
          onkeydown: e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); switchTab(i); } },
        },
          el("span", { class: "ws-dot " + (ro ? "readonly" : finalized ? "play" : "chargen"),
            "aria-hidden": "true" }),
          el("span", { class: "ws-name" }, ro ? "👁 " + name : name),
          // No duplicate button on a read-only view (use "Save a copy" instead).
          ro ? null : el("button", {
            class: "ws-dup", "aria-label": `Duplicate ${name}`, title: "Duplicate tab",
            onclick: e => { e.stopPropagation(); duplicateTab(i); },
          }, "⎘"),
          el("button", {
            class: "ws-close", "aria-label": `Close ${name}`, title: "Close tab",
            onclick: e => { e.stopPropagation(); closeTab(i); },
          }, "×"));
        return chip;
      })),
    el("button", { class: "ws-new", title: "Open a new character",
      "aria-label": "New character tab", onclick: newCharacterTab }, "+"));
}

/* ---- show the active tab's screen ---------------------------------------
 * The single dispatcher: sync the rail name inputs, then reveal #sheet or
 * #app depending on finalized state, and paint the strip. */
function showActiveTab() {
  const tab = activeTabObj();
  if (!tab) return;
  // Auth screens (login/pending/admin) hide the tab strip; restore it whenever
  // we return to the app/sheet.
  const wsBar = $("#workspace-tabs"); if (wsBar) wsBar.hidden = false;
  const login = $("#login"); if (login) login.hidden = true;
  const pending = $("#pending"); if (pending) pending.hidden = true;
  const admin = $("#admin"); if (admin) admin.hidden = true;
  const shared = $("#shared"); if (shared) shared.hidden = true;
  const nameInput = $("#char-name"), playerInput = $("#char-player");
  if (nameInput) nameInput.value = CHAR.name || "";
  if (playerInput) playerInput.value = CHAR.player || "";
  if (CHAR.finalized) {
    ensurePlay();
    seedLifestyles();
    $("#app").hidden = true;
    $("#sheet").hidden = false;
    renderSheet();
    window.scrollTo(0, 0);
  } else {
    $("#sheet").hidden = true;
    $("#app").hidden = false;
    renderTabs();
    renderPanel();
    renderRail();
  }
  renderWorkspaceBar();
}

/* ---- tab operations ------------------------------------------------------ */
async function switchTab(i) {
  if (i === WORKSPACE.active && $("#homebrew") && $("#homebrew").hidden) return;
  if ($("#homebrew") && !$("#homebrew").hidden && typeof exitHomebrew === "function")
    await exitHomebrew();
  leaveTab(activeTabObj());
  WORKSPACE.active = Math.max(0, Math.min(i, WORKSPACE.tabs.length - 1));
  const tab = activeTabObj();
  CHAR = tab.char;
  restoreView(tab);
  sheetStickyScrolled = false;
  await recalc();
  showActiveTab();
  persistWorkspace();
}

/* Open a character (from Load / Import). De-dupe by storage key: a given
 * street name maps to one slot, so re-opening just activates the tab. */
async function openCharacter(char) {
  const key = STORAGE.sanitizeName(char.name);
  const existing = char.name
    ? WORKSPACE.tabs.findIndex(t => STORAGE.sanitizeName(t.char.name) === key)
    : -1;
  if (existing >= 0) {
    leaveTab(activeTabObj());
    WORKSPACE.tabs[existing].char = char;   // refresh with the loaded copy
    WORKSPACE.active = existing;
    const tab = activeTabObj();
    CHAR = tab.char;
    restoreView(tab);
  } else {
    leaveTab(activeTabObj());
    WORKSPACE.tabs.push({ char, view: defaultView() });
    WORKSPACE.active = WORKSPACE.tabs.length - 1;
    CHAR = char;
    restoreView(activeTabObj());
  }
  sheetStickyScrolled = false;
  await recalc();
  showActiveTab();
  persistWorkspace();
}

async function newCharacterTab() {
  leaveTab(activeTabObj());
  WORKSPACE.tabs.push({ char: RULES.defaultCharacter(), view: defaultView() });
  WORKSPACE.active = WORKSPACE.tabs.length - 1;
  CHAR = activeTabObj().char;
  restoreView(activeTabObj());
  sheetStickyScrolled = false;
  await recalc();
  showActiveTab();
  persistWorkspace();
}

/* Open someone else's shared character in a read-only tab: a throwaway deep copy
 * (finalized so the play sheet renders), flagged so it's never saved to this
 * account, never synced, and never restored on reload. `meta` = {id, owner}. */
async function openReadonly(charData, meta) {
  leaveTab(activeTabObj());
  const copy = RULES.mergeDefaults(JSON.parse(JSON.stringify(charData)));
  copy.finalized = true;
  WORKSPACE.tabs.push({
    char: copy, view: defaultView(),
    readonly: true, owner: (meta && meta.owner) || "", publicId: (meta && meta.id) || null,
  });
  WORKSPACE.active = WORKSPACE.tabs.length - 1;
  CHAR = copy;
  restoreView(activeTabObj());
  sheetStickyScrolled = false;
  await recalc();
  showActiveTab();          // read-only: no persistWorkspace()
}

/* Clone the active read-only shared character into the viewer's OWN account as a
 * normal, editable, private character (unique "(copy)" name). */
async function saveReadonlyCopy() {
  const tab = activeTabObj();
  if (!tab || !tab.readonly) return;
  const copy = RULES.mergeDefaults(JSON.parse(JSON.stringify(tab.char)));
  copy.name = uniqueCopyName(copy.name || "Shared character");
  copy.finalized = true;
  STORAGE.saveCharacter(copy);        // persist locally + queue sync to my account
  await openCharacter(copy);          // open it as an owned, editable tab
  if (typeof refreshLoadList === "function") refreshLoadList();
}

/* Duplicate the tab at index i: deep-copy its character (including play state,
 * so a finalized character clones with its damage/Kismet/purchases intact),
 * give the copy a unique "(copy)" name so it gets its own storage slot instead
 * of clobbering the original, and open it in a new tab right after the source. */
async function duplicateTab(i) {
  const src = WORKSPACE.tabs[i];
  if (!src) return;
  leaveTab(activeTabObj());   // stash + flush whatever's currently active first
  const copy = RULES.mergeDefaults(JSON.parse(JSON.stringify(src.char)));
  if (copy.name) copy.name = uniqueCopyName(copy.name);
  const view = src.view ? { ...src.view } : defaultView();
  WORKSPACE.tabs.splice(i + 1, 0, { char: copy, view });
  WORKSPACE.active = i + 1;
  CHAR = copy;
  restoreView(activeTabObj());
  sheetStickyScrolled = false;
  await recalc();
  showActiveTab();
  commitTabChar(activeTabObj());   // named copy -> save its slot now
  if (typeof refreshLoadList === "function") refreshLoadList();
  persistWorkspace();
}

/* "<name> (copy)", bumping to "(copy 2)", "(copy 3)"… until the sanitized name
 * collides with neither an open tab nor an existing save. An existing
 * "(copy)"/"(copy N)" suffix is stripped first so duplicating a copy yields
 * "Alice (copy 2)" rather than "Alice (copy) (copy)". */
function uniqueCopyName(name) {
  const base = name.replace(/\s*\(copy(?: \d+)?\)$/i, "");
  const taken = new Set(
    WORKSPACE.tabs.map(t => STORAGE.sanitizeName(t.char.name))
      .concat(STORAGE.listCharacters()));
  let candidate = `${base} (copy)`;
  for (let n = 2; taken.has(STORAGE.sanitizeName(candidate)); n++)
    candidate = `${base} (copy ${n})`;
  return candidate;
}

/* Close a tab. Saved characters close silently (they stay in storage — Load
 * reopens them). Only an unnamed, non-default draft prompts, since it can't be
 * restored. Never leaves zero tabs. */
async function closeTab(i, commit = true) {
  const tab = WORKSPACE.tabs[i];
  if (!tab) return;
  if (!tab.char.name && isDirtyDraft(tab.char) &&
      !confirm("Close this unnamed character? It hasn't been saved and can't be reopened."))
    return;
  // Normally a named char is flushed so Load can reopen it. When closing
  // because the save was just DELETED, skip the flush — otherwise it would
  // resurrect the slot we just removed.
  if (commit) commitTabChar(tab);
  WORKSPACE.tabs.splice(i, 1);
  if (WORKSPACE.tabs.length === 0)
    WORKSPACE.tabs.push({ char: RULES.defaultCharacter(), view: defaultView() });
  if (WORKSPACE.active >= WORKSPACE.tabs.length) WORKSPACE.active = WORKSPACE.tabs.length - 1;
  else if (i < WORKSPACE.active) WORKSPACE.active--;
  const active = activeTabObj();
  CHAR = active.char;
  restoreView(active);
  sheetStickyScrolled = false;
  await recalc();
  showActiveTab();
  persistWorkspace();
}

/* Close whichever open tab holds the given (just-deleted) character, if any.
 * commit=false: the storage slot is already gone — don't re-save it on close. */
function closeTabByName(name, commit = true) {
  const key = STORAGE.sanitizeName(name);
  const i = WORKSPACE.tabs.findIndex(t => STORAGE.sanitizeName(t.char.name) === key);
  if (i >= 0) return closeTab(i, commit);
}

/* A brand-new character has an empty name and no meaningful edits. Compare to
 * a fresh default's JSON to decide whether closing would lose real work. */
function isDirtyDraft(char) {
  try { return JSON.stringify(char) !== JSON.stringify(RULES.defaultCharacter()); }
  catch { return true; }
}

/* ---- persistence ---------------------------------------------------------
 * The descriptor is just the list of open (named) tabs + which is active.
 * Character bodies live in their own storage slots (committed via
 * commitTabChar at tab boundaries / unload), so this stays a cheap write and
 * is safe to call on every name keystroke — no partial-name slots created. */
let workspacePersistTimer = null;
function persistWorkspace() {   // public: debounced descriptor write
  clearTimeout(workspacePersistTimer);
  workspacePersistTimer = setTimeout(writeDescriptor, WORKSPACE_PERSIST_DEBOUNCE_MS);
}
function writeDescriptor() {
  const open = [];
  let active = 0;
  WORKSPACE.tabs.forEach((tab, i) => {
    if (tab.readonly || !tab.char.name) return;  // read-only views + unnamed drafts aren't restorable
    if (i === WORKSPACE.active) active = open.length;
    open.push(STORAGE.sanitizeName(tab.char.name));
  });
  try { localStorage.setItem(workspaceKey(), JSON.stringify({ open, active })); }
  catch { /* storage full / unavailable — workspace just won't restore */ }
}

/* ---- boot ---------------------------------------------------------------- */
function initWorkspace() {
  let desc = null;
  try { desc = JSON.parse(localStorage.getItem(workspaceKey()) || "null"); }
  catch { /* corrupt descriptor: fall through to a fresh workspace */ }
  const names = (desc && Array.isArray(desc.open)) ? desc.open : [];
  for (const name of names) {
    const loaded = STORAGE.loadCharacter(name);
    if (loaded) WORKSPACE.tabs.push({ char: RULES.mergeDefaults(loaded), view: defaultView() });
  }
  if (WORKSPACE.tabs.length === 0)
    WORKSPACE.tabs.push({ char: RULES.defaultCharacter(), view: defaultView() });
  WORKSPACE.active = Math.max(0, Math.min(
    desc && Number.isInteger(desc.active) ? desc.active : 0,
    WORKSPACE.tabs.length - 1));
  CHAR = activeTabObj().char;
  restoreView(activeTabObj());
  // Flush open chargen drafts + the descriptor on the way out so a reload
  // restores the workspace. (Finalized chars already autosave continuously.)
  window.addEventListener("beforeunload", () => { commitAllTabs(); writeDescriptor(); });
}
