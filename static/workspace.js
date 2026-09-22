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
  tab.view = { activeTab, sheetTab, expandedPool, imagesCollapsed };
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
  imagesCollapsed = !!v.imagesCollapsed;
  // An older tab.view may still carry sensesCollapsed / dosesCollapsed /
  // fxCollapsed. All three panels are popovers off the header now rather than
  // folding banners, so those keys are simply ignored.
  // One-shot upgrades that must run for chargen characters too, which never
  // reach ensurePlay(). Both are guarded and idempotent.
  if (typeof migrateHackingProgram === "function") migrateHackingProgram();
}

function activeTabObj() { return WORKSPACE.tabs[WORKSPACE.active] || null; }

/* ---- unsaved-changes tracking -------------------------------------------
 * Two different gaps between what you're looking at and what's been kept, and
 * the tab dot reports them differently because the consequences differ:
 *
 *   dirty       — the character in memory differs from its storage slot. In
 *                 chargen that's the normal state between deliberate saves
 *                 (nothing autosaves there); in play it should only ever be
 *                 the autosave debounce.
 *   pendingSync — written here, but the push hasn't reached the server. For a
 *                 SHARED character this is the one that matters: the gallery
 *                 goes on serving the old version to other members until the
 *                 queue drains.
 *
 * Dirtiness is a raw string compare against the slot, not a flag maintained by
 * every mutation site — the whole app mutates CHAR directly from hundreds of
 * places, and a flag would be wrong the first time one of them was missed.
 * Characters are a few KB (a portrait pushes that to ~256 KB at worst), so the
 * compare is cheap, but it still runs on a trailing timer and caches onto the
 * tab rather than happening inside every render. */
const DIRTY_SWEEP_DEBOUNCE_MS = 800;   // > PLAY_SAVE_DEBOUNCE_MS (600), deliberately:
                                       // a routine play autosave lands first, so the
                                       // dot doesn't flash red on every click in play.
let dirtySweepTimer = null;

/* Does this tab differ from what's saved? Read-only shared views are never
 * saved at all, so they're never dirty. */
function computeTabDirty(tab) {
  if (!tab || tab.readonly) return false;
  if (!tab.char.name) return unnamedDraftHasWork(tab.char);
  try {
    const stored = STORAGE.rawCharacter(tab.char.name);
    if (stored == null) return true;                  // named but never saved
    return stored !== JSON.stringify(tab.char);
  } catch { return false; }   // unserialisable/quota — don't claim to know
}

function computeTabPendingSync(tab) {
  if (!tab || tab.readonly || !tab.char.name) return false;
  if (!(typeof SYNC !== "undefined" && SYNC.pendingSync)) return false;
  return SYNC.pendingSync(STORAGE.sanitizeName(tab.char.name));
}

/* Recompute every tab's flags; repaint the strip only if one actually moved.
 * The "only if changed" is what stops render → sweep → render looping. */
function sweepDirtyFlags() {
  let changed = false;
  for (const tab of WORKSPACE.tabs) {
    const dirty = computeTabDirty(tab);
    const pending = computeTabPendingSync(tab);
    if (dirty !== !!tab.dirty || pending !== !!tab.pendingSync) changed = true;
    tab.dirty = dirty;
    tab.pendingSync = pending;
  }
  if (changed) renderWorkspaceBar();
}

/* Public: "something may have changed". Called from the debounced change paths
 * (recalc, schedulePlaySave, persistWorkspace) and from STORAGE's save/delete
 * and SYNC's flush, so both sides of the comparison trigger a re-check. */
function scheduleDirtySweep() {
  clearTimeout(dirtySweepTimer);
  dirtySweepTimer = setTimeout(sweepDirtyFlags, DIRTY_SWEEP_DEBOUNCE_MS);
}

/* ---- drag-to-reorder -----------------------------------------------------
 * Pointer Events (not HTML5 drag-and-drop) so it works with both mouse and
 * touch on the tablets we target. While dragging, the tabs array reorders live
 * as the pointer crosses each chip's midpoint, and the strip re-renders.
 *
 * Arming differs by input, because on touch a reorder and a scroll are the SAME
 * gesture — both are a horizontal drag across the strip:
 *
 *   mouse — 6px of movement, as before. Nothing else wants that gesture.
 *   touch — a LONG PRESS. The chips used to carry `touch-action: none` so the
 *           drag could preventDefault, which also meant a swipe starting on a
 *           chip never became a scroll: with enough tabs open, the ones off the
 *           right edge were simply unreachable, since the chips cover nearly
 *           the whole strip. They're `pan-x` now, so an ordinary swipe scrolls,
 *           and holding still for a moment is what says "I meant to move this".
 *
 * Holding still matters mechanically, not just as an affordance: `touch-action`
 * is latched when the pointer goes down, so once the browser has begun panning
 * it owns the gesture. Arming only after LONG_PRESS_MS of near-stillness means
 * it hasn't started, and the touchmove is still cancelable — which is what the
 * non-passive listener below relies on to stop the strip scrolling under a
 * chip that's being dragged. */
let tabDrag = null;            // { tab, startX, startY, dragging, activeChar, timer, touch }
let suppressTabClick = false;  // set after a drag so the trailing click doesn't switch tabs
const TAB_DRAG_THRESHOLD = 6;  // px before a mouse press becomes a drag
const TAB_LONG_PRESS_MS = 400; // hold before a touch press becomes a drag
const TAB_LONG_PRESS_SLOP = 10; // px of drift allowed while waiting — beyond it, it's a scroll

/* Blocks the browser panning the strip while a chip is being dragged. Non-passive
 * so preventDefault actually bites; only attached once a drag is armed. */
function blockTabScroll(e) { if (tabDrag && tabDrag.dragging) e.preventDefault(); }

function armTabDrag() {
  if (!tabDrag || tabDrag.dragging) return;
  tabDrag.dragging = true;
  document.body.classList.add("ws-reordering");
  window.addEventListener("touchmove", blockTabScroll, { passive: false });
}

function onTabPointerDown(e, tab) {
  if (e.button != null && e.button > 0) return;             // primary button only
  if (e.target.closest(".ws-dup, .ws-close")) return;       // let the chip buttons work
  tabDrag = { tab, startX: e.clientX, startY: e.clientY, dragging: false,
              touch: e.pointerType === "touch", timer: null,
              activeChar: activeTabObj() ? activeTabObj().char : null };
  if (tabDrag.touch) tabDrag.timer = setTimeout(armTabDrag, TAB_LONG_PRESS_MS);
  window.addEventListener("pointermove", onTabPointerMove);
  window.addEventListener("pointerup", onTabPointerUp, { once: true });
  // The browser takes the gesture back the moment it decides to pan, which is
  // exactly the "this was a scroll" case — drop the press rather than leaving a
  // half-armed drag behind.
  window.addEventListener("pointercancel", onTabPointerUp, { once: true });
}

function onTabPointerMove(e) {
  if (!tabDrag) return;
  const moved = Math.hypot(e.clientX - tabDrag.startX, e.clientY - tabDrag.startY);
  if (!tabDrag.dragging) {
    if (tabDrag.touch) {
      // Drifting before the timer fires means a scroll was intended. Let it go.
      if (moved > TAB_LONG_PRESS_SLOP) { clearTimeout(tabDrag.timer); tabDrag = null; }
      return;
    }
    if (moved < TAB_DRAG_THRESHOLD) return;
    armTabDrag();
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
  window.removeEventListener("touchmove", blockTabScroll);
  // Both are registered `once`, but only the one that actually fired removed
  // itself — drop the other so presses don't accumulate listeners.
  window.removeEventListener("pointerup", onTabPointerUp);
  window.removeEventListener("pointercancel", onTabPointerUp);
  if (tabDrag) clearTimeout(tabDrag.timer);
  if (tabDrag && tabDrag.dragging) {
    document.body.classList.remove("ws-reordering");
    renderWorkspaceBar();
    persistWorkspace();
    suppressTabClick = true;                       // swallow the click that follows this drag
    setTimeout(() => { suppressTabClick = false; }, 0);
  }
  tabDrag = null;
}

/* The theme picker and settings gear are `position: fixed` over the right end
 * of the strip, so the strip reserves room for them via --ws-right-gap. It has
 * to be measured rather than hardcoded: the picker shows the scheme NAME, so
 * its width changes with the theme ("Slate Violet" vs "Ash"), and a fixed
 * reservation left the last tab underneath the controls -- reachable only by
 * scrolling past it.
 *
 * A ResizeObserver keeps it honest when the name changes without the strip
 * re-rendering; the render-time call covers browsers without one. */
let themeGapObserver = null;
function syncThemeControlsGap() {
  const controls = document.getElementById("theme-controls");
  if (!controls) return;
  const gap = Math.ceil(controls.getBoundingClientRect().width) + 16;  // + breathing room
  document.documentElement.style.setProperty("--ws-right-gap", gap + "px");
  if (!themeGapObserver && typeof ResizeObserver !== "undefined") {
    themeGapObserver = new ResizeObserver(() => syncThemeControlsGap());
    themeGapObserver.observe(controls);
  }
}


/* ---- render the strip ---------------------------------------------------- */
function renderWorkspaceBar() {
  const bar = $("#workspace-tabs");
  if (!bar) return;
  // The ☰ character-actions menu (Load/Save/New, Import/Export, Homebrew,
  // Admin, …) sits at the head of the tab strip so it's available in chargen
  // and play alike. sheetMenu() is defined in sheet.js but is mode-aware.
  const menu = (typeof sheetMenu === "function" && activeTabObj()) ? sheetMenu() : null;
  syncThemeControlsGap();
  bar.replaceChildren(
    ...(menu ? [menu] : []),
    el("div", { class: "ws-tabs" },
      ...WORKSPACE.tabs.map((tab, i) => {
        const active = i === WORKSPACE.active;
        const name = (tab.char.name || "").trim() || "Unnamed";
        const finalized = !!tab.char.finalized;
        const ro = !!tab.readonly;
        // Unsaved beats unpushed: if the slot itself is behind, whether the
        // server has last week's copy is the lesser of the two problems.
        const dirty = !ro && !!tab.dirty;
        const unpushed = !ro && !dirty && !!tab.pendingSync;
        const state = dirty ? " unsaved" : unpushed ? " unpushed" : "";
        const chip = el("div", {
          class: "ws-tab" + (active ? " active" : "") + (ro ? " ws-readonly" : ""),
          role: "button", tabindex: "0",
          title: ro ? `${name} — shared by ${tab.owner || "member"} (read only)`
                    : `${name} — ${finalized ? "play" : "chargen"}`
                      + (dirty ? " · unsaved changes" : "")
                      + (unpushed ? " · saved here, still reaching the server" : ""),
          "aria-current": active ? "true" : null,
          onpointerdown: e => onTabPointerDown(e, tab),
          onclick: () => { if (suppressTabClick) { suppressTabClick = false; return; } switchTab(i); },
          onkeydown: e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); switchTab(i); } },
        },
          el("span", { class: "ws-dot " + (ro ? "readonly" : finalized ? "play" : "chargen") + state,
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
      "aria-label": "New tab — load a character or start a new one",
      onclick: newTabPicker }, "+"));
}

/* Re-render after a global-menu action. The ☰ menu lives in the workspace
 * strip and is available in both chargen and play, so redraw the strip (to
 * reflect the menu's open/closed state) plus the play sheet when it's showing. */
function rerenderApp() {
  renderWorkspaceBar();
  const sheet = $("#sheet");
  if (sheet && !sheet.hidden && typeof renderSheet === "function") renderSheet();
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
    if (typeof removeSkipLink === "function") removeSkipLink();
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

/* The + button asks first: a new tab is as often "open the character I already
 * have" as "start a fresh one", and the Load list was buried in the ☰ menu on
 * the sheet — unreachable while you're mid-chargen (issue #36). Cancelling, or
 * pressing + with nothing saved, falls straight through to a new character. */
async function newTabPicker() {
  const saved = STORAGE.listCharacters();
  if (!saved.length) return newCharacterTab();
  const pick = await promptNewTab(saved);
  if (!pick) return;
  if (pick.type === "new") return newCharacterTab();
  const loaded = STORAGE.loadCharacter(pick.name);
  if (!loaded) return;
  await openCharacter(RULES.mergeDefaults(loaded));
}

/* Load-or-new, in the modal shape the rest of the app uses. Resolves to
 * {type:"new"} | {type:"load", name} | null. */
function promptNewTab(saved) {
  return new Promise(resolve => {
    const backdrop = el("div", { class: "mount-modal-backdrop" });
    const done = v => { document.removeEventListener("keydown", onKey); backdrop.remove(); resolve(v); };
    const onKey = e => { if (e.key === "Escape") done(null); };
    const list = el("div", { class: "sh-newtab-list" },
      ...saved.map(name => el("button", { class: "btn sh-newtab-row",
        onclick: () => done({ type: "load", name }) }, name)));
    const modal = el("div", { class: "card mount-modal", style: "max-width:460px" },
      el("h3", {}, "New tab"),
      el("p", { class: "hint" }, "Open a character you've saved, or start a new one."),
      list,
      el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin-top:14px" },
        el("button", { class: "btn-add", onclick: () => done({ type: "new" }) }, "New character"),
        el("button", { class: "btn ghost", onclick: () => done(null) }, "Cancel")));
    backdrop.append(modal);
    backdrop.addEventListener("click", e => { if (e.target === backdrop) done(null); });
    document.addEventListener("keydown", onKey);
    document.body.append(backdrop);
  });
}

async function newCharacterTab() {
  const char = RULES.defaultCharacter();
  // Let the player pick this character's house rules before it opens. Cancelling
  // the picker aborts creation. (Falls back to defaults if the modal is absent.)
  if (typeof promptHouseRules === "function") {
    const chosen = await promptHouseRules(char.house_rules);
    if (!chosen) return;
    char.house_rules = chosen;
  }
  leaveTab(activeTabObj());
  WORKSPACE.tabs.push({ char, view: defaultView() });
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
/* A name no open tab and no saved character is using, suffixed with `label`.
 * The taken-set spans both because openCharacter() de-dupes tabs by sanitized
 * name (replacing that tab's character) and commitTabChar() saves any named
 * character on tab-leave — so a duplicate name loses work in two ways. */
function uniqueTabName(name, label) {
  const strip = new RegExp(`\\s*\\(${label}(?: \\d+)?\\)$`, "i");
  const base = String(name || "").replace(strip, "") || "Unnamed";
  const taken = new Set(
    WORKSPACE.tabs.map(t => STORAGE.sanitizeName(t.char.name))
      .concat(STORAGE.listCharacters()));
  let candidate = `${base} (${label})`;
  for (let n = 2; taken.has(STORAGE.sanitizeName(candidate)); n++)
    candidate = `${base} (${label} ${n})`;
  return candidate;
}
function uniqueCopyName(name) { return uniqueTabName(name, "copy"); }

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

/* isDirtyDraft, minus the house rules.
 *
 * newCharacterTab asks for house rules before the character opens, so a brand
 * new tab where the player picked anything other than the defaults already
 * differs from defaultCharacter() — by a choice they made in a dialog, not by
 * work they'd mind losing. closeTab can afford to be twitchy about that (they
 * pressed ✕, a prompt is expected); an unload warning cannot, or it fires on
 * every close of an untouched tab and stops being read. Kept separate rather
 * than folded into isDirtyDraft so tab-close behaviour is unchanged. */
function unnamedDraftHasWork(char) {
  try {
    const base = RULES.defaultCharacter();
    base.house_rules = char.house_rules;   // assignment, not insertion: key order holds
    return JSON.stringify(char) !== JSON.stringify(base);
  } catch { return true; }
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
  scheduleDirtySweep();         // renaming in the rail changes which slot we compare to
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
  // The risk survey has to run BEFORE that flush — see unloadRisks.
  window.addEventListener("beforeunload", e => {
    const risks = unloadRisks();
    commitAllTabs();
    writeDescriptor();
    if (!risks.length) return;
    // Browsers show their own wording and ignore any string given here, so the
    // detail lives in the tab dots and their tooltips, which are on screen
    // behind the dialog. Both are needed: Chrome honours preventDefault, older
    // engines only honour returnValue.
    e.preventDefault();
    e.returnValue = "";
  });
}

/* What closing the window right now would actually cost.
 *
 * Deliberately NOT "every tab with unsaved changes". The handler above saves
 * every named tab on the way out, so warning about those would fire on almost
 * every close and teach the player to click straight through it. Two things
 * genuinely survive that flush badly:
 *
 *   • an unnamed draft — storage slots are keyed by street name, so
 *     commitTabChar skips it and nothing brings it back.
 *   • a SHARED character with something still to push — the flush queues the
 *     op but the 800ms flush timer never gets to run, so the gallery goes on
 *     serving the old version to other members until this browser is next
 *     opened. (Private characters are fine: the queue is in localStorage and
 *     drains on the next boot, and nobody else was reading them meanwhile.)
 *
 * Runs before commitAllTabs precisely because that commit enqueues a push for
 * every named tab — asked afterwards, every shared character would look
 * pending on every close. Asked before, "has anything to push" is honest:
 * unsaved edits that the commit is about to queue, or an op already stuck. */
function unloadRisks() {
  const risks = [];
  for (const tab of WORKSPACE.tabs) {
    if (tab.readonly) continue;
    if (!tab.char.name) {
      if (unnamedDraftHasWork(tab.char)) risks.push(tab);
      continue;
    }
    if (typeof isSharedSave === "function" && isSharedSave(tab.char.name)
        && (computeTabDirty(tab) || computeTabPendingSync(tab))) risks.push(tab);
  }
  return risks;
}
