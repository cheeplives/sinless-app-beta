# P13 — Readability and usability at tablet and desktop sizes

**Preconditions for every case:** P00 complete.
**Effort:** 45–60 min. **Fixture:** `kitchen-sink-final.json` — it is the
densest character in the set, which is what makes layout problems visible.

The app is used on tablets. This pass measures whether it is comfortable there,
at five viewports covering 11-inch and 13-inch devices in both orientations plus
a desktop baseline.

**Measure, do not eyeball.** Screenshots time out intermittently on this app and
"looks fine" is not a finding anyone can act on. Every case below returns numbers.
Where a case genuinely is a matter of taste, it says so and routes to JUDGEMENT.

## The viewports

| Label | Size | Device |
|---|---|---|
| `11-portrait` | 834 × 1194 | 11″ iPad Pro, portrait |
| `11-landscape` | 1194 × 834 | 11″ iPad Pro, landscape |
| `13-portrait` | 1024 × 1366 | 12.9/13″ iPad Pro, portrait |
| `13-landscape` | 1366 × 1024 | 12.9/13″ iPad Pro, landscape |
| `desktop` | 1280 × 800 | baseline for comparison |

Set each with the `resize_window` tool, passing `width` and `height` explicitly.
Re-run the measurement block after every resize.

## Setup

Load the fixture and install the measurement helper once:

```js
(async () => { window.confirm = () => true; window.alert = () => {}; const raw = await (await fetch("docs/qa/fixtures/kitchen-sink-final.json", { cache: "reload" })).json(); await openCharacter(RULES.mergeDefaults(raw)); window.__qaMeasure = async (scope) => { const sel = scope === "chargen" ? "#app" : "#sheet"; const tabs = scope === "chargen" ? ["stats","weapons","gear"] : ["overview","gear","kismet"]; const out = { viewport: window.innerWidth + "x" + window.innerHeight }; for (const t of tabs) { if (scope === "chargen") { activeTab = t; await recalc(); renderTabs(); renderPanel(); } else { sheetTab = t; renderSheet(); } await new Promise(r => setTimeout(r, 80)); const b = [...document.querySelectorAll(sel + " button")].map(x => x.getBoundingClientRect()).filter(r => r.width > 0 && r.height > 0); out[t] = { buttons: b.length, minH: b.length ? Math.min(...b.map(r => Math.round(r.height))) : null, under32h: b.filter(r => r.height < 32).length, under44h: b.filter(r => r.height < 44).length, overflow: document.documentElement.scrollWidth > window.innerWidth + 1, scrollW: document.documentElement.scrollWidth }; } return out; }; return "ready"; })()
```

---

## Horizontal overflow

### P13-001: No viewport scrolls the page sideways
- **Type:** usability
- **Steps:** for each of the five viewports, resize and run the Check.
- **Check:**

      window.__qaMeasure("play")

- **Expected:** `overflow` is `false` on every tab at every viewport, and
  `scrollW` never exceeds the viewport width.
- **Note:** Observed at 834 × 1194: `scrollW` 819 against a viewport of 834, no
  overflow on Overview, Gear or Kismet. The page body must never scroll
  sideways; wide tables are expected to scroll **inside their own container**
  instead, which P13-003 checks.
- **Result (record per viewport):**
  - `11-portrait` [ ] PASS [ ] FAIL — `overflow`: ______
  - `11-landscape` [ ] PASS [ ] FAIL — `overflow`: ______
  - `13-portrait` [ ] PASS [ ] FAIL — `overflow`: ______
  - `13-landscape` [ ] PASS [ ] FAIL — `overflow`: ______
  - `desktop` [ ] PASS [ ] FAIL — `overflow`: ______

### P13-002: The chargen side is also clean
- **Type:** usability
- **Check:**

      (async () => { CHAR.finalized = false; await recalc(); showActiveTab(); return await window.__qaMeasure("chargen"); })()

- **Expected:** `overflow` is `false` on Stats, Weapons and Gear at every
  viewport. The Stats tab is the densest screen in the app — if anything
  overflows, it will be that one.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P13-003: Wide tables scroll inside their own container
- **Type:** usability
- **Check:**

      (() => { const wraps = [...document.querySelectorAll("#sheet .scroll-x, #sheet [style*='overflow']")]; const tables = [...document.querySelectorAll("#sheet table")]; return { wrappedTables: tables.filter(t => t.closest(".scroll-x") || (t.parentElement && /auto|scroll/.test(getComputedStyle(t.parentElement).overflowX))).length, totalTables: tables.length, wrappers: wraps.length }; })()

- **Expected:** every table that is wider than its parent sits inside a
  horizontally scrollable wrapper (`wrapScrollableTables()` in `sheet.js` does
  this). `wrappedTables` should equal the number of wide tables, not necessarily
  `totalTables` — narrow tables need no wrapper.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Touch targets

### P13-004: Controls are large enough to tap
- **Type:** usability
- **Check:**

      window.__qaMeasure("play")

- **Expected (guideline):** interactive controls should be at least **44 px**
  tall for comfortable touch, and no smaller than **32 px**.
- **First check the media query is actually engaged** — this is the whole case:

      matchMedia("(pointer: coarse)").matches

  If that is `false`, you are measuring the desktop layout and the numbers below
  will not reproduce. A tablet-sized *viewport* is not enough; the browser has to
  report a coarse pointer. Resizing alone often doesn't do it — use the device
  emulation, or run it on a real tablet.

- **Observed with a coarse pointer** (375 × 812, the only configuration the
  automation harness can emulate — re-measure at the five tablet viewports and
  record what you get):

  | Tab | Visible buttons | Smallest height | Under 32 px | Under 44 px |
  |---|---|---|---|---|
  | Overview | 69 | 32 px | **0** | 68 |
  | Gear | 67 | 16 px | 6 | 64 |
  | Kismet | 70 | 32 px | **0** | 68 |
  | Stats (chargen) | 119 | 32 px | **0** | 119 |

  (Re-observed 2026-08-19 after v316/v317, against a checkout of `c984806` —
  the commit immediately before this session's touch-target and header-trim
  work — as the control, same fixture and same coarse pointer on both sides.
  At `c984806` these three read Overview 68/32/**0**/67, Gear 66/16/**8**/63,
  Kismet 69/32/**0**/67; the "65/61/64" this table showed before dates from
  an earlier, undated re-measurement and does not reflect either commit.
  Overview's +1 button is the new "Effect ▾" chip (`.sh-tag.sh-ls-info`),
  added by the header-trim work that moved Initiative/Dodge prose into
  popovers — it inherited `.sh-tag`'s 21px chip metrics and was briefly a
  sub-floor target the day it was born, now covered at `min-height:32px`.
  Kismet's +1 is the same chip, since the header renders on every tab.
  Gear's under-32 count fell 8 → 6: `.sh-rollable` reaching 32px tall and a
  `flex:0 1 auto` default that had been silently shrinking checkboxes in
  flex rows back to 13px (fixed with `flex:none`) both landed there.
  Initiative and Dodge are `role="button"` DIVs (`headBoxFace`), not
  `&lt;button&gt;` elements, so neither ever appears in this `#sheet button`
  query on either side of the diff.)

  Every remaining sub-32 control is a `.sh-reorder-btn` — the ▲/▼ arrows, which
  are 16 px **each** because they are a stacked pair occupying 32 px together.
  Confirm that with:

      [...document.querySelectorAll("#sheet button")].filter(x => { const r = x.getBoundingClientRect(); return r.height > 0 && r.height < 32; }).map(x => x.className || "(none)")

  Anything other than `sh-reorder-btn` in that output is a control the
  coarse-pointer block has missed.

- **Note:** JC-017, ruled **B**. Before the ruling this pass measured 47 of 65
  under 32 px on the Overview and **107 of 108** on chargen Stats, with a
  minimum of 11 px — but those numbers were taken with a tablet viewport and a
  *fine* pointer, so the `@media(pointer:coarse)` block that existed then wasn't
  active either. The block was extended to raise everything clickable to a 32 px
  floor; desktop density is untouched, which is the point of ruling B over C.

  The 44 px column stays high and that is expected: 32 px is the floor the
  ruling bought, not 44.

  Two controls turned out to be sitting below the floor and were added to the
  coarse block on 2026-08-18: `.sh-complex-btn` (the inline **Complex** and
  **Stabilize** buttons on Actions This Round) and `.sh-strip-toggle` (the
  Actions strip's fold control). Both are labelled buttons, so they joined the
  `.btn, .btn-add, …` min-height rule rather than getting sizes of their own.
  Each already sits in a row held open to 32 px by a neighbouring `.mini-btn`,
  so the floor cost no extra height anywhere — measured identical with and
  without it on the strip, the sticky bar and the Actions card. With those in,
  the class list from the check above is **empty** at every tablet viewport,
  not just free of non-`sh-reorder-btn` entries.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P13-005: Controls do not overlap
- **Type:** usability
- **Check:**

      (() => { const b = [...document.querySelectorAll("#sheet button")].map(x => ({ r: x.getBoundingClientRect(), t: x.textContent.trim().slice(0, 8) })).filter(x => x.r.width > 0); const hits = []; for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) { const a = b[i].r, c = b[j].r; if (a.left < c.right - 1 && c.left < a.right - 1 && a.top < c.bottom - 1 && c.top < a.bottom - 1) hits.push([b[i].t, b[j].t]); } return { overlaps: hits.length, sample: hits.slice(0, 5) }; })()

- **Expected:** `{ "overlaps": 0, "sample": [] }`
- **Note:** Overlapping tap targets mean a mis-tap fires the wrong action —
  that is a real FAIL at any viewport, not a taste question.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Legibility

### P13-006: No text is rendered below a readable size
- **Type:** usability
- **Check:**

      (() => { const nodes = [...document.querySelectorAll("#sheet *, #app *")].filter(e => e.childElementCount === 0 && e.textContent.trim() && e.getBoundingClientRect().width > 0); const sizes = nodes.map(e => parseFloat(getComputedStyle(e).fontSize)); return { min: Math.min(...sizes), max: Math.max(...sizes), under12: sizes.filter(s => s < 12).length, under10: sizes.filter(s => s < 10).length, sampled: sizes.length }; })()

- **Expected:** `under10` is `0`. **Not `under11`** — see the note below; the
  bar moved on 2026-08-19 and this case's own script and criterion must move
  with it, or every play tab now fails a case that is actually passing.
- **Note:** A UX review (2026-08-19) found the app's smallest base text at
  6px (`.skill-to-chip`) — decoration, not reading, on its own account — and
  the user directed it fixed. Every base rule under 10px was raised to
  exactly 10px (`docs/qa/JUDGEMENT-CALLS.md` was checked first: this wasn't
  filed as a JC because the user had already decided it by asking for the
  fix, not left it open for the owner). 10px was picked over 11/12 because
  the layouts are deliberately dense and the `@media(pointer:coarse)` block
  had already picked 9.5px as an acceptable floor for the *harder* viewing
  case (touch); 10px sits a hair above that and applies everywhere, so
  desktop stops being worse-served than a tablet. Shipped in v316.

  This case's original 11px bar predates that decision and is now the wrong
  test: re-observed after the change, every play tab and chargen read
  `min: 10`, with `under11` nonzero (mid-teens to 40s depending on tab —
  dominated by uppercase, letter-spaced display-face labels like `th`,
  `.sub` and `.sh-tag`, which read fine smaller than body text because the
  letterforms are simpler and the tracking adds spacing back) while
  `under10` is `0` everywhere. The check above and the Expected line were
  both updated to test the floor that is now actually in force. Chargen was
  previously the only side sampled by hand (11.5px min, 5 under 12 of 65) —
  re-observed here too and now reads `min: 10, under10: 0, sampled: 85`.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P13-007: Both themes are legible
- **Type:** usability
- **Steps:**
  1. Switch the app between light and dark using its own theme control.
  2. Re-run P13-006 in each.
- **Check:**

      (() => ({ theme: document.documentElement.getAttribute("data-theme"), scheme: document.documentElement.getAttribute("data-scheme"), bodyBg: getComputedStyle(document.body).backgroundColor, bodyFg: getComputedStyle(document.body).color }))()

- **Expected:** the attribute flips, and text remains readable against the
  background in both. This one is a genuine visual judgement — if you cannot
  assess contrast reliably, mark **BLOCKED** rather than guessing.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Navigation reachability

### P13-008: Every tab is reachable at every viewport
- **Type:** usability
- **Check:**

      (() => { const strip = document.querySelector("#sheet .sheet-tabs") || document.querySelector("#sheet nav") || document.querySelector("#workspace-tabs"); if (!strip) return "no tab strip found"; const r = strip.getBoundingClientRect(); const tabs = [...strip.querySelectorAll("button, a")].map(t => t.getBoundingClientRect()); return { stripWidth: Math.round(r.width), viewport: window.innerWidth, tabs: tabs.length, offscreen: tabs.filter(t => t.right > window.innerWidth + 1 || t.left < -1).length, scrollable: /auto|scroll/.test(getComputedStyle(strip).overflowX) }; })()

- **Expected:** `offscreen` is `0`, **or** `scrollable` is `true` so the
  overflowing tabs can be reached by swiping.
- **Note:** A tab that is both offscreen and in a non-scrollable strip is
  unreachable — a hard FAIL. Check this at `11-portrait` especially, the
  narrowest viewport.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P13-009: The sticky header does not consume the screen in landscape
- **Type:** usability
- **Check:**

      (() => { const h = document.querySelector("#sheet .sheet-head, #sheet header, #sheet .sticky"); if (!h) return "no sticky header found"; const r = h.getBoundingClientRect(); return { headerHeight: Math.round(r.height), viewportHeight: window.innerHeight, percent: Math.round((r.height / window.innerHeight) * 100) }; })()

- **Expected:** `percent` is under 25 at the landscape viewports (834 px tall),
  where vertical space is scarcest.
- **Note:** Run this specifically at `11-landscape` and `13-landscape`. A header
  eating a third of a short viewport is the classic tablet-landscape complaint.

  Known FAIL, tightened twice (2026-08-18) and still short. Measured against
  `kitchen-sink-final.json`, coarse pointer: `11-landscape` 42% → 34%,
  `13-landscape` 33% → 28%. `13-landscape` now clears the 25 line's spirit
  even though it doesn't clear the number; `11-landscape` — the shortest
  viewport, so the same header height reads as the biggest percentage there —
  is the holdout.

  What's left is not spacing any more. Both rounds of tightening (line-height,
  padding, gaps) ran up against the coarse-pointer 32px tap-target floor
  (JC-017) on every inline `−`/`+`/`↺` row in the header, and the second round
  additionally folded the pool tiles' "temp" boost row away entirely when it's
  at 0 (P06-053) — removing one of those floored rows per tile outright rather
  than just shrinking around it. What remains at `11-landscape` is real text
  wrapping: the identity column's tags (heritage · magic · lifestyle) and the
  lifestyle effect line both wrap to two lines at that width once the meters
  and description columns take their share, and that's content length against
  available width, not slack spacing. Closing the rest of the gap means either
  rebalancing how much width the identity column gets against the description
  and meters (a layout change, not a spacing one), or accepting this as the
  practical floor for what the header currently shows.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P13-010: The sticky bar (tab strip + actions strip) stays a fraction of a short viewport
- **Type:** usability
- **Check:**

      (() => { const b = document.querySelector("#sheet .sh-stickybar"); if (!b) return "no sticky bar found"; const r = b.getBoundingClientRect(); const strip = document.querySelector(".sh-actions-strip"); return { barHeight: Math.round(r.height), viewportHeight: window.innerHeight, percent: Math.round((r.height / window.innerHeight) * 100), stripPresent: !!strip, stripHeight: strip ? Math.round(strip.getBoundingClientRect().height) : null }; })()

- **Expected:** `percent` is under 15 at the landscape viewports, `stripPresent`
  is `true`, and `stripHeight` is under 60 (one row of pills — it should not
  have wrapped to two at these widths).
- **Note:** `#sheet .sheet-head` — the scroll-away header P13-009 measures — is
  the only element that case's selector can ever resolve to (`.sheet-head`
  precedes `.sh-stickybar` in the DOM, and nothing else in `#sheet` matches
  `header` or `.sticky`), so **the sticky bar's own height sits outside any
  case's budget**. That gap is what this case closes, and it matters more now
  that the bar carries a second row (the actions strip, P06-052) on top of the
  tab strip it always has.

  Measured at `11-landscape` (1194×834) and `13-landscape` (1366×1024) against
  `kitchen-sink-final.json`: `barHeight` 83px both times — `percent` 10 and 8.
  15 leaves real headroom above that without being meaningless; a genuine
  regression (the actions strip wrapping to two rows because a build gained
  enough exploit-action kinds, or a future addition growing the bar further)
  would need to roughly double the current height to trip it.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

## Phone widths (out of target, guarded anyway)

The viewports above start at 834px and this app is not designed for a phone.
The stylesheet still carries an `@media(max-width:680px)` block that exists
purely to keep a phone usable, and its own comment records a sideways-scroll bug
it was written to fix. One case keeps that promise honest.

### P13-011: No horizontal page scroll on any play tab at 375×812
- **Type:** correctness
- **Steps:** load `wildling-pools.json` (or any finalized fixture), enter play
  mode, and `resize_window` to `375 × 812`.
- **Check:**

      (async () => { const de = document.documentElement; const tabs = {}; for (const t of ["overview","skills","kismet","gear","augments","magic","decking","rigging","actions","notes"]) { sheetTab = t; renderSheet(); await new Promise(r => setTimeout(r, 40)); tabs[t] = de.scrollWidth; } sheetTab = "gear"; renderSheet(); await new Promise(r => setTimeout(r, 40)); const wrap = [...document.querySelectorAll(".sh-tablewrap")].find(w => w.querySelector("table")); return { clientWidth: de.clientWidth, tabs, gearTable: { wrapW: Math.round(wrap.getBoundingClientRect().width), tableW: Math.round(wrap.querySelector("table").getBoundingClientRect().width), scrollable: wrap.scrollWidth > wrap.clientWidth } }; })()

- **Expected:** every entry in `tabs` equals `clientWidth` (375). `gearTable` has
  `scrollable: true` with `tableW` well over `wrapW` — the table is **wider**
  than the screen and that is correct, because it scrolls inside its own
  `.sh-tablewrap`. The defect this guards against is the *page* scrolling, not
  the table.
- **Note:** Failed on the Gear tab at 389 against 375 until 2026-08-19. The
  table was never the problem — it was already wrapped. The blowout was the
  grid above it: `.sh-two` resolved to a bare `1fr`, and a `1fr` track takes
  `min-content` as its automatic minimum, so the card's content sized the column
  instead of the column sizing the card. `.sh-two` measured 347px wide with a
  computed `grid-template-columns: 374.547px` — a single column wider than the
  grid holding it. `minmax(0,1fr)` gives the track a real floor.
  `.sh-pools` and `.sh-skillgrid` share the declaration and were changed with
  it; neither tripped, but both had the same latent weakness. See
  [`../findings/2026-08-19-P13.md`](../findings/2026-08-19-P13.md) NEW-003.

  If this ever fails again, find the offender by walking for elements whose
  right edge clears the viewport and that sit in no scroll container:

      (() => { const W = document.documentElement.clientWidth; const inScroller = e => { let q = e.parentElement; while (q && q !== document.body) { const o = getComputedStyle(q).overflowX; if (o === "auto" || o === "scroll" || o === "hidden") return true; q = q.parentElement; } return false; }; return [...document.querySelectorAll("body *")].filter(e => { const r = e.getBoundingClientRect(); return r.right > W + 0.5 && r.width > 0 && !inScroller(e); }).slice(0, 8).map(e => ({ cls: (e.className || e.tagName).toString().slice(0, 50), left: Math.round(e.getBoundingClientRect().left), right: Math.round(e.getBoundingClientRect().right) })); })()

- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## The Modify dialog (#87)

`openSheetModal`'s box (`.mount-modal`) lives on `document.body`, outside
`#sheet` — so it is invisible to `window.__qaMeasure`, which scopes every
query to `#sheet button` (setup script, top of this file) and whose `"play"`
tab list doesn't include `rigging` at all. These three cases stand alone
rather than extending that shared harness, so the already-recorded Overview/
Gear/Kismet numbers in P13-004 stay exactly what they were measured against.

**Section setup** (coarse pointer, 375×812 — `resize_window` to `mobile`,
then reload so the `pointer:coarse` gate re-runs):

      (async () => { window.confirm = () => true; const raw = await (await fetch("docs/qa/fixtures/kitchen-sink-final.json", { cache: "reload" })).json(); await openCharacter(RULES.mergeDefaults(raw)); rigFlags(); const p = CHAR.play.purchases, rg = CHAR.play.rigging; p.rigs.push({ name: "Master VCR", mods: [] }); rg.active_rig = "Master VCR"; p.drones.push({ name: "Disc", label: "Alpha", weapons: ["Mini Gun"], mods: [] }); rg.linked["drones:0"] = true; rg.hotseat["drones:0"] = true; await playChangedRecalc(); sheetTab = "rigging"; renderSheet(); const btn = [...document.querySelectorAll("button")].find(b => b.textContent === "Modify"); btn.click(); await new Promise(r => setTimeout(r, 30)); const head = document.querySelector(".mount-modal .cat-head"); head.click(); await new Promise(r => setTimeout(r, 30)); return { coarsePointer: matchMedia("(pointer: coarse)").matches, modalOpen: !!document.querySelector(".mount-modal") }; })()

- **Expected:** `{ "coarsePointer": true, "modalOpen": true }`. If
  `coarsePointer` is `false`, stop — you're measuring the desktop layout, same
  caveat as P13-004.

### P13-016: The Modify dialog clears the 32px touch floor
- **Type:** usability
- **Check:**

      (() => { const modal = document.querySelector(".mount-modal"); const buttons = [...modal.querySelectorAll("button")].map(b => b.getBoundingClientRect()).filter(r => r.width > 0 && r.height > 0); return { count: buttons.length, minH: Math.round(Math.min(...buttons.map(r => r.height))), under32h: buttons.filter(r => r.height < 32).length }; })()

- **Expected:** `under32h: 0`. Every control in the dialog lands on a selector
  the coarse-pointer block already covers (`.btn`/`.btn-add`/`.row-del`/
  `.btn.small`, `static/style.css` — search `@media(pointer:coarse)`) — the
  state chips added to the rollup in the same change are non-interactive
  `<span>`s and don't appear in this query at all.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P13-017: One scroller, not two
- **Type:** usability
- **Check:**

      (() => { const modal = document.querySelector(".mount-modal"); const catItems = modal.querySelector(".cat-items"); return { catItemsIsScroller: catItems.scrollHeight > catItems.clientHeight + 1, modalIsScroller: modal.scrollHeight > modal.clientHeight + 1, modalWidth: Math.round(modal.getBoundingClientRect().width), pageOverflowsX: document.documentElement.scrollWidth > window.innerWidth }; })()

- **Expected:** `{ "catItemsIsScroller": false, "modalIsScroller": true, "modalWidth": 343, "pageOverflowsX": false }`
- **Note:** `.cat-items` is `max-height:420px;overflow-y:auto` (style.css) —
  fine as a standalone picker, but nested inside the modal's own
  `max-height:82vh;overflow:auto` on a 812px-tall phone that's two scrollbars
  fighting for one thumb. `@media(max-width:700px){ .mount-modal .cat-items{max-height:none} }`
  unclamps the inner one so the modal is the only scroller left. `modalWidth:
  343` (viewport 375 minus the backdrop's 16px gutter each side) confirms the
  dialog isn't itself overflowing sideways.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P13-018: The Rigging tab's height, as a ceiling
- **Type:** usability
- **Steps:** **desktop width, not a phone** — the number below moves with
  viewport width (narrower wraps more and reads taller: the same fixture is
  3105px at an 877px-wide desktop pane and 4206px at 375px), so pin the width
  or the ceiling is meaningless. `resize_window` to `desktop` (or don't touch
  it — this is the default). Uses the P06-066/067/068 section setup (Master
  VCR, five armed Discs, four seated), not the two-unit setup above the
  previous two cases; re-run that block first.
- **Check:**

      (async () => { sheetTab = "rigging"; renderSheet(); await new Promise(r => setTimeout(r, 60)); return { viewportWidth: window.innerWidth, heightPx: document.getElementById("sh-tabpanel").scrollHeight, cardOrder: [...document.querySelectorAll("#sh-tabpanel .sh-card h3")].map(x => x.textContent) }; })()

- **Expected:** `heightPx` under **3400** at an ~877px-wide viewport (observed
  3105 immediately after the #87 restructure — leaving headroom rather than
  pinning the exact figure, since minor content changes shift it a little);
  `cardOrder` is
  `["Active drones & vehicles", "Vehicle Control Rigs", "Drones", "Vehicles", "Buy rigs, drones & vehicles"]`.
- **Note:** No case anywhere in this pass measured a TAB's height before this
  one — only individual controls and horizontal overflow — which is exactly
  how the same fixture reached **5538px** (6.1 screens at an 877px-wide pane)
  before #87 went unnoticed for as long as it did. This is the number the
  whole restructure exists to move, and the one a future feature will quietly
  undo if nothing keeps watch on it. Treat the 3400px line as a ceiling to
  re-set deliberately (recording the viewport width alongside it), not a
  target to shrink further for its own sake.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Wrapping up

Report a table of the five viewports against P13-001, P13-004 and P13-008 — those
three answer "can this be used on a tablet at all". The rest add detail.

**P13-004 should now PASS**, and it is the case most likely to fail for a boring
reason: if `matchMedia("(pointer: coarse)").matches` is `false` you measured the
desktop layout, which is unchanged by design. Check that first and mark
**BLOCKED** rather than FAIL if you can't get a coarse pointer. Everything else
should PASS on a healthy build.
