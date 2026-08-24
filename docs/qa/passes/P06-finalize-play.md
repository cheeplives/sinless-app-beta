# P06 — The finalize boundary and play mode

**Preconditions for every case:** P00 complete, including the `confirm`/`alert`
stubs (§3) — several cases here trigger dialogs.
**Effort:** 60–75 min. **Fixture:** `kitchen-sink-final.json` unless stated.

This is the highest-yield pass in the suite. The chargen↔play boundary is where
state written by one mode is read by the other, and it is where the app is least
defended: once `finalized` is true, `rules.js` returns empty `errors` and
`warnings`, so an illegal state produces no visible complaint at all.

Load the fixture once at the start:

```js
(async () => { const raw = await (await fetch("docs/qa/fixtures/kitchen-sink-final.json", { cache: "reload" })).json(); await openCharacter(RULES.mergeDefaults(raw)); return { name: CHAR.name, finalized: CHAR.finalized }; })()
```

**Expected:** `{ "name": "QA Kitchen Sink", "finalized": true }`

Several cases mutate `CHAR`. Reload the fixture between sections rather than
assuming a clean slate.

---

## The blanking behaviour

### P06-001: A finalized character drops its creation-only problems
- **Type:** correctness
- **Check:**

      (() => { const c = JSON.parse(JSON.stringify(CHAR)); c.finalized = true; c.lifestyles = []; c.skills = { Athletics: 99 }; const k = RULES.calculate(c); return { errors: k.errors, warnings: k.warnings }; })()

- **Expected:** `{ "errors": [], "warnings": [] }`
- **Note:** JC-012, ruled **B**. That character has no lifestyle and a skill at
  99, and both stay silent — they are creation rules and creation is over. The
  lists are no longer blanked *unconditionally* though; P06-001b is the half that
  now speaks.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-001b: …but still reports what stays illegal at the table
- **Type:** correctness
- **Check:**

      (() => { const c = JSON.parse(JSON.stringify(CHAR)); c.finalized = true; c.play.cash = -2500; c.augments = [...c.augments, { name: "Bone Lacing-Plastic", count: 1 }, { name: "Bone Lacing-Titanium", count: 1 }]; const k = RULES.calculate(c); return { errors: k.errors, warnings: k.warnings }; })()

- **Expected:** `errors` contains both

      "Bone Lacing: only one tier may be installed — remove all but one of Bone Lacing-Plastic, Bone Lacing-Titanium."
      "Overdrawn by ㄓ2,500."

- **Note:** The reduced set is *what is installed in your body, and what is in
  your wallet*: augment conflicts and tiers, the Synthetic Bioware ban, augment
  requirements, Body Index over Body, a martial art above Unarmed Combat, an
  overdrawn `play.cash`, the Skillsoft/Chipjack and Skillsoft/Skillwires caps
  (added v336 — see P06-064), and the three worn-armor warnings. The overdraw is
  measured against `play.cash`, **not** the creation budget. Overloaded mounts
  and the magic/Amp OFFLINE state are deliberately excluded — the sheet has
  dedicated read-outs for both. The play Overview renders whatever survives in a
  **Needs attention** card, and since v336 the sticky bar carries an **Attention**
  chip on all ten tabs (P06-065). Both are absent entirely for a clean character.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-002: The same character un-finalized reports both problems
- **Type:** correctness
- **Check:**

      (() => { const c = JSON.parse(JSON.stringify(CHAR)); c.finalized = false; c.lifestyles = []; c.skills = { Athletics: 99 }; const k = RULES.calculate(c); return { errors: k.errors, warnings: k.warnings }; })()

- **Expected:**

      { "errors": ["Firearms: a specialization needs at least 1 rank in the skill.",
                   "Skill points overspent by 69.",
                   "Choose a lifestyle with at least 1 prepaid month."],
        "warnings": ["Athletics: maximum 6 skill points at creation."] }

- **Note:** The control for P06-001. If this one is also empty, blanking has
  leaked into chargen and that is a genuine FAIL.

  All three errors come from the Check's own setup, which is blunter than it
  looks: `c.skills = { Athletics: 99 }` **replaces** the whole skills map, so
  every other skill drops to 0 ranks. That overspends the budget by 69, and it
  strips the ranks out from under the fixture's Firearms specialization, which
  JC-001 now errors on. The Expected listed only the lifestyle error until
  2026-08-05 — the overspend was missing even before JC-001 existed.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-003: The loaded fixture is genuinely valid, not merely silent
- **Type:** correctness
- **Check:**

      (() => { const c = JSON.parse(JSON.stringify(CHAR)); c.finalized = false; const k = RULES.calculate(c); return { errors: k.errors, warnings: k.warnings }; })()

- **Expected:** `{ "errors": [], "warnings": [] }`
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Advances

### P06-004: Play advances apply only while finalized
- **Type:** correctness
- **Check:**

      (() => { const on = JSON.parse(JSON.stringify(CHAR)); on.finalized = true; const off = JSON.parse(JSON.stringify(CHAR)); off.finalized = false; return { advance: CHAR.play.attribute_advances.Strength, finalizedStrength: RULES.calculate(on).attributes.Strength.final, chargenStrength: RULES.calculate(off).attributes.Strength.final }; })()

- **Expected:** `{ "advance": 1, "finalizedStrength": 6, "chargenStrength": 5 }`
- **Note:** This is the gate working correctly — a play advance must not inflate
  a character that has gone back to chargen.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-005: Advances are clamped to the caps the Kismet buttons enforce
- **Type:** correctness
- **Check:**

      (() => { const c = JSON.parse(JSON.stringify(CHAR)); c.finalized = true; c.play.skill_advances = { Athletics: 40 }; c.play.attribute_advances = { Strength: 40 }; const k = RULES.calculate(c); return { athletics: k.skills.Athletics.final, strength: k.attributes.Strength.final, strengthMax: k.attributes.Strength.max, errors: k.errors }; })()

- **Expected:** `{ "athletics": 8, "strength": 29, "strengthMax": 20, "errors": [] }`
- **Note:** JC-013, ruled **A**. Both used to sail through — Athletics reached 43
  and Strength 44 — because the caps lived only in the Kismet tab's button
  `disabled` attributes, which an imported or hand-edited ledger never touches.
  `applyPlayAdvances` clamps now: skills to 8 (rank 6 by Kismet, 7 on a mastery
  boon, 8 on a major one) and attributes to the engine's level range of 29.
  Strength 29 is still over its per-heritage `strengthMax` of 20 — that stays a
  **warning**, per JC-002, and warnings about creation caps aren't play-relevant,
  so `errors` is empty.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Condition tracks

### P06-006: Stored damage is not re-clamped when the track shrinks
- **Type:** leak
- **Steps:**
  1. Run the Check below. It writes a damage value far above the track maximum.
- **Check:**

      (() => { CHAR.play.physical_damage = 99; return { trackMax: CALC.condition.physical, stored: CHAR.play.physical_damage }; })()

- **Expected:** `{ "trackMax": 8, "stored": 99 }`
- **Note:** The renderer clamps what it *draws* (`min(stored, max)`), but the
  stored value is untouched. Losing a Body-boosting infusion or augment shrinks
  the track without correcting existing damage. Reload the fixture afterwards.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## The Kismet ledger

### P06-007: Ledger entries carry a serializable undo descriptor
- **Type:** correctness
- **Check:**

      (() => ({ entries: CHAR.play.kismet_log.map(e => ({ label: e.label, delta: e.delta, undoKind: e.undo ? e.undo.kind : null })), kismet: CHAR.play.kismet }))()

- **Expected:** `{ "entries": [{ "label": "Strength 5 -> 6", "delta": -6, "undoKind": "attribute" }], "kismet": 12 }`
- **Note:** `undo` must be a plain `{kind, name}` object, never a function — the
  ledger is JSON-persisted and a closure would not survive a save.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-008: Undo refunds the kismet and decrements the advance
- **Type:** correctness
- **Steps:**
  1. Click the **Kismet** tab.
  2. Find the ledger row `Strength 5 -> 6` and click its **Undo** button.
- **Check:**

      (() => ({ kismet: CHAR.play.kismet, advance: CHAR.play.attribute_advances.Strength || 0, logLength: CHAR.play.kismet_log.length }))()

- **Expected:** `{ "kismet": 18, "advance": 0, "logLength": 0 }`
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-009: The Activity ledger undoes a purchase and refunds it in full
- **Type:** correctness
- **Steps:**
  1. Reload the fixture. The fixture starts with `play.cash` at **1500**.
  2. Click the **Gear** tab and buy any item.
  3. Scroll to **Activity** at the bottom. The purchase row has an **Undo**
     button; the starting-cash roll does not.
  4. Press Undo and confirm.
- **Check:**

      (async () => { window.confirm = () => true; const before = CHAR.play.cash; const w = DATA.tables.weapons.find(x => +x.Cost > 0 && x.Type === "Melee"); CHAR.play.purchases.weapons.push({ name: w.Weapon, smart: false, mods: [], equipped: true, qty: 1 }); logCash(`Bought ${w.Weapon}`, -Math.round(+w.Cost), { kind: "weapon", name: w.Weapon }); await playChangedRecalc(); const spent = CHAR.play.cash; await undoCashSpend(CHAR.play.cash_log[0]); return { before, spent, after: CHAR.play.cash, weapons: CHAR.play.purchases.weapons.length, top: CHAR.play.cash_log[0].label }; })()

- **Expected:** `spent` is `before` minus the weapon's cost, `after` is back to
  `before` exactly, `weapons` is `0`, and `top` is the starting-cash roll — the
  purchase row is gone from the ledger.
- **Note:** JC-011, ruled **A but scoped**. Undo lives **only** in the Activity
  ledger; the per-row ✕ on the tabs above still just removes the item and keeps
  the money, and the card says so. Covered kinds: weapon, armor, gear, augment,
  spell, hacking level, weapon mod, armor extra, gear mount, prepaid lifestyle
  month. Rows with nothing to reverse — manual adjustments, α-grade upgrades,
  quality changes, the cash roll — get no button. Undoing a purchase whose item
  was already removed reports that and pays nothing.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Purchases crossing back into chargen

### P06-010: A weapon bought in play lands in `play.purchases`
- **Type:** correctness
- **Steps:**
  1. Reload the fixture.
  2. Click the **Gear** tab.
  3. Click **Buy equipment** at the top of the tab, expand a weapon category,
     click **Add** on any weapon, then approve the basket with the footer's
     **Buy 1 item**.
- **Check:**

      (() => ({ chargenWeapons: CHAR.weapons.map(w => w.name), playWeapons: CHAR.play.purchases.weapons.map(w => w.name), allWeapons: allWeapons().map(w => w.name), calcWeapons: (CALC.weapons || []).map(w => w.Weapon) }))()

- **Expected:** `chargenWeapons` is unchanged (`["Kalishnikov A-80", "Katana"]`
  for this fixture); the new weapon is in `playWeapons`; `allWeapons` is the two
  chargen ones **followed by** the new one; `calcWeapons` matches `allWeapons`
  element for element.
- **Note:** JC-010, ruled **A**. Weapons and armor joined gear, augments, spells,
  amp powers and hacking levels in `play.purchases`. The ordering matters as much
  as the split: `applyPlayAdvances` appends purchases **after** the chargen
  entries, so index N of the character's array is still index N of the matching
  CALC array — which is what lets the Gear tab keep indexing straight across. The
  Gear tab reads the union through `allWeapons()` / `allArmor()`.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-011: That weapon is **not** charged against the creation budget
- **Type:** correctness
- **Steps:** (continues from P06-010 — do not reload)
- **Check:**

      (() => { const c = JSON.parse(JSON.stringify(CHAR)); c.finalized = false; const k = RULES.calculate(c); return { remaining: k.budget.remaining, weapons: k.weapons.map(w => w.Weapon), errors: k.errors }; })()

- **Expected:** `remaining` is still **33902** — the number the fixture starts
  with, whatever you bought — `weapons` lists only the two chargen weapons, and
  `errors` is `[]`.
- **Note:** This is the harm JC-010 was ruled on: money earned and spent in play
  used to be retroactively deducted from the creation budget the moment you went
  Back to Chargen, and `revertToChargenEnd()` couldn't remove the item either.
  Both follow from the split. If `remaining` moves at all, the purchase has
  leaked back into the chargen arrays — re-check P06-010 first, since this case
  can only be right if that one is.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-011b: The line holds for every purchasable category
- **Type:** correctness
- **Steps:** reload the fixture first — this buys one of everything.
- **Check:**

      (async () => { window.confirm = () => true; CHAR.play.cash = 5000000; const p = CHAR.play.purchases; p.decks.push({ name: "MasterDeck", mods: [] }); logCash("Bought MasterDeck", -1000, { kind: "deck", name: "MasterDeck" }); p.programs.push("Acid Burn 1"); logCash("Bought program Acid Burn 1", -500, { kind: "program", name: "Acid Burn 1" }); p.rigs.push({ name: "Basic VCR", mods: [] }); logCash("Bought Basic VCR", -2000, { kind: "rig", name: "Basic VCR" }); p.drones.push({ name: "Bug-Spy", weapons: [], mods: [] }); logCash("Bought Bug-Spy", -300, { kind: "drone", name: "Bug-Spy" }); await playChangedRecalc(); const chargen = { decks: CHAR.decks.length, programs: CHAR.programs.length, rigs: CHAR.rigs.length, drones: CHAR.drones.length }; const joined = { decks: allDecks().length, programs: allPrograms().length, rigs: allRigs().length, drones: allDrones().length }; const probe = JSON.parse(JSON.stringify(CHAR)); probe.finalized = false; const remaining = RULES.calculate(probe).budget.remaining; const before = CHAR.play.cash; for (let n = 0; n < 4; n++) await undoCashSpend(CHAR.play.cash_log[0]); return { chargen, joined, remaining, refunded: CHAR.play.cash - before, leftOver: p.decks.length + p.programs.length + p.rigs.length + p.drones.length }; })()

- **Expected:**

      { "chargen": { "decks": 0, "programs": 0, "rigs": 0, "drones": 0 },
        "joined":  { "decks": 1, "programs": 1, "rigs": 1, "drones": 1 },
        "remaining": 33902, "refunded": 3800, "leftOver": 0 }

- **Note:** JC-024, ruled **A**: there is a hard and fast line between the
  chargen record and anything after Finalize, and `play.purchases` now holds
  every purchasable category. `chargen` all-zero with `joined` all-one is the
  line; `remaining` unmoved is what it buys; `leftOver` zero is Undo reaching all
  four. Vehicles behave identically and are left out only to keep the expression
  readable.

  The subtle one underneath this is `unitStateKey`, which keys a drone's damage
  tracks by position in the **joined** list. Buy a drone in play, damage it, then
  buy another and check the damage stayed on the first — if it jumps, the keying
  has broken.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Grenade launchers in play

### P06-012: A launcher takes Damage, Pen and Barrier from the chambered grenade
- **Type:** correctness
- **Steps:**
  1. Reload the fixture.
  2. Run the setup below, then read the Overview weapon line.
- **Setup:**

      (async () => { CHAR.weapons = [{ name: "Ares Grenade Launcher", smart: false, mods: [], equipped: true, qty: 1, ammo: "Incendiary Grenade" }, { name: "Incendiary Grenade", smart: false, mods: [], equipped: true, qty: 3 }]; await recalc(); sheetTab = "overview"; renderSheet(); return "ready"; })()

- **Check:**

      (() => [...document.querySelectorAll("#sheet td.sub")].map(n => n.textContent.trim()).find(t => /^GrenadeLauncher/.test(t)))()

- **Expected:** a line containing `DMG 10+fire`, `Pen 0` and `Barrier 3`.
- **Note:** If it reads `DMG By Grenade` with no Barrier, the launcher's `Type`
  has reverted to `Heavy` and it can no longer chamber anything — see P02-012.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-013: An empty launcher shows an em dash, not a zero
- **Type:** correctness
- **Steps:** (continues from P06-012)
- **Check:**

      (async () => { delete CHAR.weapons[0].ammo; await recalc(); renderSheet(); return [...document.querySelectorAll("#sheet td.sub")].map(n => n.textContent.trim()).find(t => /^GrenadeLauncher/.test(t)); })()

- **Expected:** a line containing `DMG By Grenade` and `Barrier —`.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Every play tab renders

### P06-014: All ten play tabs render without throwing
- **Type:** correctness
- **Steps:**
  1. Reload the fixture.
- **Check:**

      (async () => { const tabs = ["overview","skills","kismet","gear","augments","magic","decking","rigging","actions","notes"]; const bad = []; for (const t of tabs) { try { sheetTab = t; renderSheet(); if (!document.getElementById("sheet").textContent.trim()) bad.push(t + ":empty"); } catch (e) { bad.push(t + ":" + e.message); } } return bad; })()

- **Expected:** `[]`
- **Note:** A tab name in the output is a hard failure — record the message
  verbatim, it names the throwing function.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Lifestyle months: chargen record vs play balance

Chargen months are **bought** with creation cash (`priceMiscGearAndLifestyle`
charges `MonthlyCost × months`, and at least one month is a hard chargen error).
`play.lifestyles[].months` is months *remaining*, and drifts as they are burned
or prepaid. `play.lifestyles_baseline` records what chargen said at the last
sync, which is what lets the two be told apart.

### P06-015: Correcting chargen months carries across; an unrelated re-finalize doesn't
- **Type:** correctness
- **Steps:** load any finalized fixture, or run straight from a fresh sheet.
- **Check:**

      (async () => { CHAR = RULES.defaultCharacter(); CHAR.name = "LS Case"; CHAR.lifestyles = [{ name: "Squatter", months: 6 }]; CHAR.finalized = true; ensurePlay(); seedLifestyles(); const m = () => CHAR.play.lifestyles[0].months; const seeded = m(); CHAR.play.lifestyles[0].months = 2; syncChargenLifestyles(); const burnKept = m(); CHAR.lifestyles[0].months = 3; syncChargenLifestyles(); const corrected = m(); return { seeded, burnKept, corrected, baseline: CHAR.play.lifestyles_baseline, log: CHAR.play.cash_log.map(e => e.label) }; })()

- **Expected:**

      { "seeded": 6, "burnKept": 2, "corrected": 3,
        "baseline": { "Squatter": 3 },
        "log": ["Squatter lifestyle corrected in chargen: 2 → 3 mo"] }

- **Note:** `burnKept` is the important one. Re-finalizing after an edit that
  didn't touch lifestyles must leave the play balance alone — otherwise fixing a
  typo in the character's name hands back every month they had burned. If
  `corrected` comes back `2`, the sync has gone back to being insert-only and
  the mismatch this whole section exists for is live again.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-016: The Months counter is free but never silent
- **Type:** leak
- **Steps:** continue from P06-015 (or any finalized character with a lifestyle).
- **Check:**

      (async () => { await recalc(); sheetTab = "gear"; renderSheet(); const card = [...document.querySelectorAll(".sh-card")].find(c => /^Lifestyle$/.test(((c.querySelector("h3") || {}).textContent || "").trim())); const plus = [...card.querySelectorAll("button")].find(b => b.textContent.trim() === "+"); const cash = CHAR.play.cash, months = CHAR.play.lifestyles[0].months; plus.click(); const after = { months: CHAR.play.lifestyles[0].months, cash: CHAR.play.cash, top: CHAR.play.cash_log[0] }; const realConfirm = window.confirm; window.confirm = () => true; await undoCashSpend(CHAR.play.cash_log[0]); window.confirm = realConfirm; return { cash, months, after, undone: CHAR.play.lifestyles[0].months }; })()

- **Expected:** `after.months` is one higher, `after.cash` is **unchanged**, and
  `after.top` is `{ delta: 0, label: "Adjusted … lifestyle to N mo (unpaid)",
  undo: { kind: "lifestyle_adjust", … } }`. `undone` returns to `months`.
- **Note:** The counter sits beside a **+1 mo (cost)** button that charges for
  the same thing, so a free up-tick has to be visible or the two are impossible
  to tell apart after the fact. A zero-delta ledger row renders as an em dash,
  not `+ㄓ0`. If `after.cash` dropped, the counter has started charging and the
  paid button is now double-billing.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-017: A character saved before the fix is repaired once, on load
- **Type:** correctness
- **Steps:** none — builds the pre-fix shape directly.
- **Check:**

      (async () => { CHAR = RULES.defaultCharacter(); CHAR.name = "LS Legacy"; CHAR.lifestyles = [{ name: "Wealthy", months: 1 }]; CHAR.finalized = true; CHAR.play.cash_log = []; CHAR.play.lifestyles = [{ name: "Wealthy", months: 4, active: true }]; CHAR.play.lifestyles_seeded = true; delete CHAR.play.lifestyles_baseline; delete CHAR.play.lifestyles_reconciled; ensurePlay(); const first = { months: CHAR.play.lifestyles[0].months, log: CHAR.play.cash_log.length, baseline: CHAR.play.lifestyles_baseline }; ensurePlay(); ensurePlay(); return { first, afterRepeats: { months: CHAR.play.lifestyles[0].months, log: CHAR.play.cash_log.length } }; })()

- **Expected:**

      { "first": { "months": 1, "log": 1, "baseline": { "Wealthy": 1 } },
        "afterRepeats": { "months": 1, "log": 1 } }

- **Note:** The absence of `lifestyles_baseline` is what marks a character
  finalized before 2026-08-05. The repair sets the play balance to the chargen
  purchase, logs it undoably, and stamps the baseline so it can never run twice
  — `afterRepeats.log` staying at 1 is the half that matters, since a repair
  that re-fires on every `ensurePlay` would overwrite live play state forever.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## The bright line: `play.kit`

At Finalize the character's gear is **copied** into `play.kit`, and from then on
the play sheet edits only that copy. Worn flags, fitted mods, quantities,
α-grades, sales, losses, reordering — all of it lands in the kit, and the
chargen arrays are never written to again.

That one rule replaced four narrower mechanisms (`disposed`, `fitted_mods` /
`disposed_mods`, `unit_overrides`, `armor_worn`), each of which had patched one
path by which play could reach into the creation record.

### P06-018: Ten play actions, and the chargen record does not move
- **Type:** leak
- **Steps:** none — the Check builds and finalizes its own character each time.
- **Check:**

      (async () => { const raw = JSON.parse(JSON.stringify(CHAR)); const KEYS = ["priorities","attributes","skills","knowledge_skills","heritage","magic","augments","weapons","armor","gear","decks","programs","rigs","drones","vehicles","lifestyles","description"]; const fp = () => { const o = {}; for (const k of KEYS) o[k] = CHAR[k]; return JSON.stringify(o); }; const view = () => { const c = JSON.parse(JSON.stringify(CHAR)); c.finalized = false; const k = RULES.calculate(c); return [k.budget.remaining, (k.knowledge || {}).remaining]; }; const rows = []; const test = async (label, fn) => { CHAR = RULES.mergeDefaults(JSON.parse(JSON.stringify(raw))); CHAR.armor = [{ name: "Armor Jacket", style: "", material: "", extras: [], active: true }]; CHAR.finalized = true; ensurePlay(); await recalc(); const a = fp(), b = view(); fn(); await recalc(); rows.push({ label, chargen: fp() === a ? "same" : "CHANGED", budget: String(view()) === String(b) ? "same" : "MOVED" }); }; const K = c => CHAR.play.kit[c]; await test("worn", () => { K("armor")[0].active = false; }); await test("equipped", () => { K("weapons")[0].equipped = false; }); await test("carried", () => { K("gear")[0].carried = false; }); await test("qty +5", () => { K("gear")[0].qty = (K("gear")[0].qty || 1) + 5; }); await test("augment count +1", () => { K("augments")[0].count = (K("augments")[0].count || 1) + 1; }); await test("augment alpha", () => { K("augments")[0].alpha = true; }); await test("augment slotted", () => { K("augments")[0].slotted = !K("augments")[0].slotted; }); await test("knowledge added", () => { K("knowledge_skills").push({ name: "Streetwise", points: 3 }); }); await test("description", () => { CHAR.play.description = "changed"; }); await test("reorder", () => { arrayMove(K("weapons"), 0, 1, () => {}); }); return rows; })()

- **Expected:** ten rows, every one `{ chargen: "same", budget: "same" }`.
- **Note:** This is the case the refactor exists for. Before it, **all ten**
  mutated the chargen record and four moved a creation budget — the qty stepper
  by ㄓ5,000, an extra Skillsoft by ㄓ2,500, an α-grade by ㄓ2,500, a knowledge
  skill by 3 points. A single `CHANGED` means something on the sheet is writing
  through to `CHAR.<array>` again instead of `play.kit`; the offender is
  whichever field that row touches.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-019: Sell, lose and cancel through the dialog
- **Type:** correctness
- **Steps:** reload `kitchen-sink-final.json` and enter play mode.
- **Check:**

      (async () => { CHAR.finalized = true; ensurePlay(); CHAR.play.kit = kitFromChargen(); CHAR.play.cash_log = []; await recalc(); const open = async re => { sheetTab = "gear"; renderSheet(); const row = [...document.querySelectorAll("#sheet table tr")].find(r => re.test(r.textContent) && r.querySelector(".row-del")); row.querySelector(".row-del").click(); await new Promise(r => setTimeout(r, 60)); return document.querySelector(".mount-modal"); }; const press = async (m, label) => { [...m.querySelectorAll("button")].find(b => b.textContent.trim() === label).click(); await new Promise(r => setTimeout(r, 120)); }; const cash0 = CHAR.play.cash; let m = await open(/Kalishnikov/); const shown = { heading: m.querySelector("h3").textContent, pct: m.querySelectorAll("input")[0].value, amount: m.querySelectorAll("input")[1].value }; await press(m, "Cancel"); const cancelled = { cash: CHAR.play.cash === cash0, log: CHAR.play.cash_log.length }; m = await open(/Kalishnikov/); m.querySelectorAll("input")[1].value = "500"; await press(m, "Sell"); const sold = { cash: CHAR.play.cash, top: CHAR.play.cash_log[0].label, kit: CHAR.play.kit.weapons.map(w => w.name), chargen: CHAR.weapons.map(w => w.name) }; m = await open(/Katana/); await press(m, "Lost / discarded"); const lost = { cash: CHAR.play.cash, top: CHAR.play.cash_log[0] }; return { cash0, shown, cancelled, sold, lost }; })()

- **Expected:** `shown` is `{ heading: "Part with Kalishnikov A-80?", pct: "50",
  amount: "375" }`. `cancelled` is `{ cash: true, log: 0 }`. `sold.cash` is
  `cash0 + 500`, `sold.top` is `"Sold Kalishnikov A-80"`, `sold.kit` is
  `["Katana"]` and **`sold.chargen` is still `["Kalishnikov A-80", "Katana"]`**.
  `lost.top` has `delta: 0` and label `"Lost Katana"`, with an undo descriptor
  of kind `restore_item`.
- **Note:** `sold.chargen` is the load-bearing assertion. The percentage seeds
  the amount and the amount wins, because what a fence pays is the table's call.
  Escape and clicking the backdrop are Cancel.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-020: The Back-to-Chargen round trip
- **Type:** correctness
- **Steps:** continue from P06-019.
- **Check:**

      (async () => { const out = {}; const sheet = () => (CALC.weapons || []).map(w => w.Weapon); const chargen = () => { const c = JSON.parse(JSON.stringify(CHAR)); c.finalized = false; const k = RULES.calculate(c); return { weapons: k.weapons.map(w => w.Weapon), remaining: k.budget.remaining }; }; CHAR.finalized = true; ensurePlay(); CHAR.play.kit = kitFromChargen(); CHAR.play.kit_baseline = kitFromChargen(); CHAR.play.cash_log = []; await recalc(); CHAR.play.kit.weapons.splice(0, 1); await recalc(); out.sold = { sheet: sheet(), chargen: chargen() }; CHAR.finalized = false; await recalc(); out.backToChargen = { listed: sheet(), remaining: CALC.budget.remaining, errors: CALC.errors.length }; CHAR.finalized = true; reconcileKit(); await recalc(); out.refinalized = { sheet: sheet(), logged: CHAR.play.cash_log.length }; CHAR.finalized = false; CHAR.weapons.push({ name: "Katana", mods: [], equipped: true }); CHAR.finalized = true; reconcileKit(); await recalc(); out.afterBuildEdit = { sheet: sheet(), top: CHAR.play.cash_log[0].label }; window.confirm = () => true; window.alert = () => {}; await revertToChargenEnd(); out.reverted = sheet(); return out; })()

- **Expected:**

      { "sold": { "sheet": ["Katana"],
                  "chargen": { "weapons": ["Kalishnikov A-80", "Katana"], "remaining": 33902 } },
        "backToChargen": { "listed": ["Kalishnikov A-80", "Katana"], "remaining": 33902, "errors": 0 },
        "refinalized": { "sheet": ["Katana"], "logged": 0 },
        "afterBuildEdit": { "sheet": ["Katana", "Katana"],
                            "top": "Chargen build edited: +Katana" },
        "reverted": ["Kalishnikov A-80", "Katana", "Katana"] }

- **Note:** Four separate promises in one case. Selling doesn't touch the build.
  Back to Chargen shows the character exactly as made. A re-finalize that
  changed nothing leaves the sale standing and **logs nothing** — `logged: 0` is
  the half people get wrong, since a re-finalize that rebuilt the kit would
  silently undo every sale. A re-finalize that *did* edit the build carries the
  change across and says so. Revert rebuilds the kit from chargen, so everything
  comes back — including the Katana added mid-case.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-021: Fitting and pulling mods leaves the creation record alone
- **Type:** leak
- **Steps:** reload `kitchen-sink-final.json`.
- **Check:**

      (async () => { CHAR = RULES.mergeDefaults(CHAR); CHAR.weapons[0].mods = ["Gyro-mount"]; CHAR.finalized = true; ensurePlay(); CHAR.play.kit = kitFromChargen(); CHAR.play.kit_baseline = kitFromChargen(); CHAR.play.cash_log = []; await recalc(); const creation = () => { const c = JSON.parse(JSON.stringify(CHAR)); c.finalized = false; return RULES.calculate(c).budget.remaining; }; const base = creation(); sheetTab = "gear"; renderSheet(); const chip = [...document.querySelectorAll("#sheet .sh-modslot .chip")].find(c => /Gyro-mount/.test(c.textContent)); chip.click(); await new Promise(r => setTimeout(r, 80)); const m = document.querySelector(".mount-modal"); const dialog = { heading: m.querySelector("h3").textContent, amount: m.querySelectorAll("input")[1].value }; [...m.querySelectorAll("button")].find(b => b.textContent.trim() === "Sell").click(); await new Promise(r => setTimeout(r, 150)); const pulled = { creation: creation(), kit: JSON.parse(JSON.stringify(CHAR.play.kit.weapons[0].mods)), chargen: JSON.parse(JSON.stringify(CHAR.weapons[0].mods)), ledger: CHAR.play.cash_log[0].label }; sheetTab = "gear"; renderSheet(); const sel = [...document.querySelectorAll("#sheet .sh-modslot select")].find(s => [...s.options].some(o => o.value === "Optical Scope")); sel.value = "Optical Scope"; sel.dispatchEvent(new Event("change")); await new Promise(r => setTimeout(r, 150)); const fitted = { creation: creation(), kit: JSON.parse(JSON.stringify(CHAR.play.kit.weapons[0].mods)), chargen: JSON.parse(JSON.stringify(CHAR.weapons[0].mods)) }; return { base, dialog, pulled, fitted }; })()

- **Expected:** `base`, `pulled.creation` and `fitted.creation` are all
  **32402**. `dialog` is `{ heading: "Part with Gyro-mount?", amount: "750" }`.
  `pulled.kit` is `[]` and `fitted.kit` is `["Optical Scope"]`, while
  **`chargen` reads `["Gyro-mount"]` in both** — the build is untouched
  throughout.
- **Note:** Mods leaked both ways before the kit existed: pulling a chargen mod
  refunded ㄓ1,500 to the creation budget, and fitting one in play *charged* it
  ㄓ1,500 for something play cash had already paid for — which could leave a
  character overspent and unable to re-finalize.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-022: A character saved before the kit migrates once
- **Type:** correctness
- **Steps:** none — the Check reloads the fixture itself, so it doesn't inherit
  whatever the previous case left in `CHAR`.
- **Check:**

      (async () => { const raw = await (await fetch("docs/qa/fixtures/kitchen-sink-final.json", { cache: "reload" })).json(); CHAR = RULES.mergeDefaults(raw); CHAR.weapons[0].mods = ["Gyro-mount"]; CHAR.finalized = true; CHAR.play = CHAR.play || {}; Object.assign(CHAR.play, { kit: null, kit_baseline: null, disposed: { weapons: [1] }, disposed_mods: [{ category: "weapons", host: 0, list: "mods", name: "Gyro-mount" }], fitted_mods: [{ category: "weapons", host: 0, list: "mods", name: "Optical Scope" }], unit_overrides: {} }); ensurePlay(); await recalc(); const first = JSON.stringify(CHAR.play.kit); ensurePlay(); ensurePlay(); return { kit: CHAR.play.kit.weapons.map(w => `${w.name}[${(w.mods || []).join("|")}]`), chargen: CHAR.weapons.map(w => `${w.name}[${(w.mods || []).join("|")}]`), legacyCleared: { disposed: CHAR.play.disposed, fitted: CHAR.play.fitted_mods, disposedMods: CHAR.play.disposed_mods }, stable: JSON.stringify(CHAR.play.kit) === first }; })()

- **Expected:**

      { "kit": ["Kalishnikov A-80[Optical Scope]"],
        "chargen": ["Kalishnikov A-80[Gyro-mount]", "Katana[]"],
        "legacyCleared": { "disposed": {}, "fitted": [], "disposedMods": [] },
        "stable": true }

- **Note:** That legacy state means "Katana sold, Gyro-mount pulled, Optical
  Scope fitted", and the migrated kit says exactly that. The old records are
  replayed through the engine once and then cleared — leaving them would apply
  every edit a second time. `stable: true` is the guard: migration must be
  idempotent, since `ensurePlay` runs on every load.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-023: The creation budget freezes at Finalize
- **Type:** correctness
- **Steps:** reload `kitchen-sink-final.json`.
- **Check:**

      (async () => { CHAR.finalized = true; ensurePlay(); CHAR.play.kit = kitFromChargen(); CHAR.play.creation_budget = snapshotCreationBudget(); await recalc(); const b = () => [CALC.budget.spent, CALC.budget.remaining]; const out = { atFinalize: b() }; CHAR.play.kit.weapons.splice(0, 1); await recalc(); out.afterSale = b(); const w = DATA.tables.weapons.find(x => (+x.Cost || 0) > 2000); CHAR.play.purchases.weapons.push({ name: w.Weapon, mods: [], equipped: true }); await recalc(); out.afterPurchase = b(); CHAR.play.kit.weapons[0].mods = ["Gyro-mount"]; await recalc(); out.afterMod = b(); CHAR.finalized = false; CHAR.weapons.push({ name: "Katana", mods: [], equipped: true }); await recalc(); out.chargenIsLive = b(); CHAR.finalized = true; await recalc(); out.stillFrozen = b(); CHAR.play.creation_budget = snapshotCreationBudget(); await recalc(); out.afterRefinalize = b(); return out; })()

- **Expected:**

      { "atFinalize":      [26098, 33902],
        "afterSale":       [26098, 33902],
        "afterPurchase":   [26098, 33902],
        "afterMod":        [26098, 33902],
        "chargenIsLive":   [27598, 32402],
        "stillFrozen":     [26098, 33902],
        "afterRefinalize": [27598, 32402] }

- **Note:** A finalized character's budget line is a record of what the build
  cost, not a running total of what they're carrying — selling a rifle at the
  table shouldn't make creation look cheaper. It used to track the current kit
  in both directions.

  `chargenIsLive` is the half that keeps this honest: back in chargen the
  figures must move again, or the creation budget has stopped working. And the
  freeze is re-taken at every Finalize, not just the first, so a genuine edit to
  the build is picked up (`afterRefinalize`).

  Only the cash figures freeze. `gear_cost_multiplier` and
  `armor_cost_multiplier` stay live — they come from heritage and price what
  play buys today.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-024: No stringified objects reach the DOM
- **Type:** correctness
- **Steps:** any finalized character; a fixture with gear in it is best.
- **Check:**

      (async () => { const hits = []; for (const t of ["overview","skills","kismet","gear","augments","magic","decking","rigging","actions","notes"]) { sheetTab = t; renderSheet(); const txt = document.querySelector("#sheet").textContent; if (/\[object /.test(txt)) hits.push({ tab: t, sample: (txt.match(/.{0,40}\[object [^\]]*\].{0,20}/) || [])[0] }); } return hits; })()

- **Expected:** `[]`
- **Note:** A one-line canary for a whole class of rendering bug. `el()`'s
  children go to `node.append()`, which takes Nodes and strings — hand it
  anything else and it silently stringifies. A Gear-tab cell built as
  `el("td", {}, cond ? [a, b] : [c, d])` shipped for weeks rendering the literal
  text `"[object HTMLSpanElement],[object HTMLInputElement]"` in the **Carried**
  column, because an array child was appended whole instead of flattened.
  `el()` flattens arrays now, so the same call site is correct — but any future
  child that isn't a Node, string or array will land here the same way, and this
  case names the tab and quotes the surrounding text.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-025: The header meters carry play state, not creation budgets
- **Type:** correctness
- **Steps:** any finalized character.
- **Check:**

      (async () => { const read = () => [...document.querySelectorAll(".sheet-head .sh-meter")].map(m => `${m.querySelector(".k").textContent}=${m.querySelector(".v").textContent}`); const strip = () => [...document.querySelectorAll(".sh-compact .sh-cmeter")].map(m => m.textContent.trim()); const p = CHAR.play.physical_damage, s = CHAR.play.stun_damage; CHAR.play.physical_damage = 5; CHAR.play.stun_damage = 4; await recalc(); renderSheet(); const hurt = read(), hurtStrip = strip(); CHAR.play.physical_damage = 0; CHAR.play.stun_damage = 0; await recalc(); renderSheet(); const well = read(); CHAR.play.physical_damage = p; CHAR.play.stun_damage = s; await recalc(); renderSheet(); return { hurt, well, hurtStrip, noBudgets: !read().join(" ").match(/^ZP=|\bZR=/) }; })()

- **Expected:** `hurt` begins `["Wounds=−2d", "Initiative=…"]` and `well` begins
  `["Wounds=0", …]`; `hurtStrip` contains `"Wounds −2d"`; `noBudgets` is `true`.
- **Note:** 5 Physical and 4 Stun is one wound step on each track — `floor(5/3) +
  floor(4/3)` — so **−2d**, not −3d. Getting −1d here means only one track is
  being counted.

  The header is the only chrome visible from every tab, so it carries what
  changes every round rather than what was fixed at creation. ZP and ZR moved
  out: the Kismet tab spends ZP (and now shows the effective value beside the
  base, which is what Force is measured against), the Augments tab shows ZR in
  context, and the MAGIC/AMP OFFLINE notes already fire when ZP goes bad.
  Ghost moved to the attribute line (P06-027) and Armor took its slot, being
  the thing you read on every incoming hit.

  `hurtStrip` matters as much as the header: the compact strip is what's on
  screen while you're actually playing, and the wound penalty sitting beside the
  pool pills is what tells you what those dice are currently worth.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-026: The ZR casting penalty chip appears only when it bites
- **Type:** correctness
- **Check:**

      (async () => { const seen = () => [...document.querySelectorAll(".sheet-head .sh-meter .k")].some(k => /ZR Casting Penalty/.test(k.textContent)); const zr = CHAR.house_rules.zr, mt = CHAR.magic.chosen_type, w = JSON.parse(JSON.stringify(CHAR.weapons)); const set = async (rule, type) => { CHAR.house_rules.zr = rule; RULES.setHouseRule("zr", rule); CHAR.magic.chosen_type = type; CHAR.weapons = [{ name: 'Arasaka "Panther" 20mm cannon', equipped: true, mods: [], qty: 1 }]; await recalc(); renderSheet(); return { shown: seen(), type: CALC.magic.type, gearZr: CALC.zoetics.gear_zr }; }; const caster = await set("houserule", "Mage"); const classic = await set("classic", "Mage"); CHAR.weapons = []; await set("houserule", "Mage"); const noGear = seen(); CHAR.house_rules.zr = zr; RULES.setHouseRule("zr", zr); CHAR.magic.chosen_type = mt; CHAR.weapons = w; await recalc(); renderSheet(); return { caster, classicRule: classic.shown, noGear }; })()

- **Expected:**

      { "caster": { "shown": true, "type": "Mage", "gearZr": 3 },
        "classicRule": false, "noGear": false }

- **Note:** Three conditions, and all three have to hold: the `houserule` ZR
  setting (only there is gear ZR a **casting penalty** rather than a budget), a
  character who can cast, and a penalty that is actually non-zero. It spans both
  grid columns so it reads as a condition currently applying rather than a fourth
  standing stat.

  This is the one piece of ZR worth header space, because unlike ZP it genuinely
  moves in play — pick up or holster a chromed weapon and it changes. A mundane
  never sees it. Note the magic priority has to allow the type: setting
  `chosen_type` to Hedge at magic priority 3 resolves to Amp, so test the
  mundane case with a mundane character.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-027: Every attribute shows its cap, and Ghost rides the same line
- **Type:** correctness
- **Steps:** Overview tab on a finalized character.
- **Check:**

      (async () => { sheetTab = "overview"; renderSheet(); const chips = [...document.querySelectorAll(".sh-attrs .sh-attr")].map(c => ({ k: c.querySelector(".k").textContent, v: c.querySelector(".v").firstChild.nodeValue, cap: c.querySelector(".cap") ? c.querySelector(".cap").textContent : null, atMax: c.classList.contains("at-max"), ghost: c.classList.contains("ghost") })); const s = CHAR.play.attribute_advances ? JSON.parse(JSON.stringify(CHAR.play.attribute_advances)) : {}; return { count: chips.length, everyAttrHasCap: chips.filter(c => !c.ghost).every(c => c.cap && +c.cap > 0), capsMatchEngine: chips.filter(c => !c.ghost).every((c, i) => +c.cap === CALC.attributes[RULES.ATTRIBUTES[i]].max), last: chips[chips.length - 1], ghostInHeader: [...document.querySelectorAll(".sheet-head .sh-meter .k")].some(k => /Ghost/.test(k.textContent)) }; })()

- **Expected:**

      { "count": 7, "everyAttrHasCap": true, "capsMatchEngine": true,
        "last": { "k": "GHOST", "v": "2d6", "cap": null, "atMax": false, "ghost": true },
        "ghostInHeader": false }

- **Note:** Seven chips — the six attributes plus Ghost, which is a standing
  figure you read off the character rather than a play meter, so it belongs
  beside them and not in the header. Armor took the header slot it vacated.

  `capsMatchEngine` is the point of the case. The corner number reads
  `CALC.attributes[x].max`, **not** a constant, so an augment that raises a
  maximum moves it: Dermal Plating 2 shows Body at `6` with a cap of `22`, not
  20. A hardcoded 20 would pass a casual glance and be wrong for exactly the
  characters who care.

  `last.cap` is `null` on purpose — Ghost has no maximum, so it carries no
  superscript. `atMax` turns it red once value meets cap, which is why being
  maxed reads without doing the comparison yourself.

  The cap is a **superscript inside `.v`**, so the value has to be read as
  `.v.firstChild.nodeValue` — `.v.textContent` would return `"420"` for a
  Strength 4 against a cap of 20 and quietly pass a sloppier assertion.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-028: A dose does nothing until it is taken, and stops at its cap
- **Type:** correctness
- **Steps:** Any finalized character. The check builds its own gear and doses
  and clears them again, so it can be run on the fixture in place.
- **Check:**

      (() => { const c = CHAR; c.priorities = { heritage:1, magic:0, attributes:4, skills:2, resources:3 }; c.heritage.type = "Human"; c.lifestyles = [{ name: "Squatter", months: 1 }]; for (const a of RULES.ATTRIBUTES) c.attributes[a] = 3; c.skills = { Biotech: 2 }; c.gear = [{ name: "Cram", qty: 3 }, { name: "First Aid Kit", qty: 2 }, { name: "Glitter", qty: 1 }]; c.finalized = true; ensurePlay(); CHAR.play.doses = []; recalc(); const read = () => { recalc(); return { focus: CALC.pools.Focus + poolEffectMod("Focus"), biotech: CALC.skills.Biotech.final }; }; const cram = CHAR.gear.find(g => g.name === "Cram"); const out = { carriedUnused: read(), qtyBefore: cram.qty }; const row = DATA.tables.misc_gear.find(r => r.Item === "Cram"); shUseDoseBtn(cram, row, cram.qty).dispatchEvent(new MouseEvent("click")); out.qtyAfterUse = cram.qty; out.afterOneCram = read(); takeDose("Cram"); takeDose("Cram"); takeDose("Cram"); takeDose("Cram"); out.fiveCram = read(); out.cramTally = doseTally("Cram"); takeDose("First Aid Kit"); out.kitUsed = read(); takeDose("First Aid Kit"); out.kitTwice = read(); takeDose("Glitter"); out.glitterSummary = doseSummary("Glitter"); out.doseCount = activeDoses().length; CHAR.play.doses = []; out.allWornOff = read(); return out; })()

- **Expected:**

      { "carriedUnused": { "focus": 5, "biotech": 2 },
        "qtyBefore": 3, "qtyAfterUse": 2,
        "afterOneCram":  { "focus": 7,  "biotech": 2 },
        "fiveCram":      { "focus": 13, "biotech": 2 },
        "cramTally": { "taken": 5, "counted": 4, "cap": 4 },
        "kitUsed":       { "focus": 13, "biotech": 3 },
        "kitTwice":      { "focus": 13, "biotech": 3 },
        "glitterSummary": "",
        "doseCount": 8,
        "allWornOff":    { "focus": 5,  "biotech": 2 } }

- **Note:** `carriedUnused` is the case. Cram and a First Aid Kit are in the
  character's hands and neither is doing anything — Focus 5, Biotech 2. Owning a
  consumable is not using it, and if either number is already raised here the
  Use button is decoration and the bonus is permanent.

  That guarantee runs through two separate paths, which is why both a pool and a
  skill are read. Cram's dice come from `pool_effects`, gated in the sheet;
  the medkits' come from their `Skill Bonus` column, gated in `gearSkillEffects`
  (rules.js). A regression in either one alone would still leave the other
  looking right.

  `qtyBefore`/`qtyAfterUse` prove Use spends the dose. Nothing else in the sheet
  decrements a stack as a side effect, so 3 → 2 is attributable.

  **The caps.** Cram's row says "can chain up to 4", and `Max Doses` is 4:
  five doses are held, four pay out, so Focus is 5 + 4×2 = **13** and not 15.
  `cramTally` states that split directly — `taken` 5, `counted` 4 — because the
  fifth dose must still be *listed* (you took it, and Dependence cares) while
  contributing nothing. The First Aid Kit caps at 1: `kitUsed` and `kitTwice`
  are identical, which is the same rule reaching the skill path.

  `glitterSummary` is empty on purpose. Glitter is a real dose with no dice
  effect, and it still consumes, still lists, still gets a dismiss — the banner
  says "No dice effect — tracked for the record" rather than hiding it. A
  non-empty string here means something is inventing a bonus from its prose.

  `allWornOff` returning to the `carriedUnused` numbers is the lossless check:
  dismissing every dose restores exactly the pools and skills you started with.
  A drift of even 1 means a dose wrote into a stored total instead of being
  applied on top of it.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-029: A live dose can suppress wound penalties; a carried one cannot
- **Type:** correctness
- **Steps:** No fixture. The check builds four throwaway characters.
- **Check:**

      (() => { const mk = (augs, doses) => { const c = RULES.defaultCharacter(); c.priorities = {heritage:2, magic:0, attributes:1, skills:3, resources:4}; c.heritage.type = "Human"; c.lifestyles = [{ name: "Squatter", months: 1 }]; c.augments = augs.map(n => ({ name: n })); c.gear = [{ name: "Dorf", qty: 1 }]; c.finalized = true; c.play = { doses }; return c; }; const r = c => { const k = RULES.calculate(c); return { negated: k.combat.wound_penalty_negated, doubled: k.combat.wound_penalty_doubled, by: k.combat.wound_penalty_doubled_by }; }; const dose = [{ uid: "a", name: "Dorf" }]; return { carriedOnly: r(mk([], [])), oneDoseLive: r(mk([], dose)), painNullifier: r(mk(["Pain Nullifier"], [])), reactionEnhOnly: r(mk(["Reaction Enhancer 2"], [])), reactionEnhPlusDorf: r(mk(["Reaction Enhancer 2"], dose)), dedup: RULES.liveDoseRows(mk([], [{uid:"a",name:"Dorf"},{uid:"b",name:"Dorf"}]), DATA.tables).map(x => x.Item) }; })()

- **Expected:**

      { "carriedOnly":         { "negated": false, "doubled": false, "by": "" },
        "oneDoseLive":         { "negated": true,  "doubled": false, "by": "" },
        "painNullifier":       { "negated": true,  "doubled": false, "by": "" },
        "reactionEnhOnly":     { "negated": false, "doubled": true,  "by": "Reaction Enhancer 2" },
        "reactionEnhPlusDorf": { "negated": true,  "doubled": false, "by": "" },
        "dedup": ["Dorf"] }

- **Note:** `carriedOnly` is the case, exactly as in P06-028: a painkiller in
  your pocket kills no pain. If that flips to `true`, buying Dorf has become
  permanent wound immunity for the price of 25.

  `painNullifier` is the regression guard. `removesWoundPenalty` used to be
  handed only augments, martial-art levels and heritage traits; adding doses must
  not disturb the three paths that already worked.

  `reactionEnhPlusDorf` fixes the precedence in place. Negation beats doubling —
  twice nothing is still nothing — and a dose has to obey that rule too, so
  `doubled` goes false and `by` empties. If both flags ever read true at once the
  condition track has two masters.

  `dedup` covers `liveDoseRows` collapsing repeats. Two Dorf doses are a real
  state (Dependence counts them) but this is a yes/no question, and a caller that
  cares about magnitude — the pool stacking in `gearSkillEffects` — counts
  `play.doses` itself and clamps to `Max Doses`.

  Dorf's Effect must read "wound penalties". It shipped for a long time as
  "wound pen", two characters short of `/wound penalt/i` — the row promised
  immunity that no code could see.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-030: Lick and Rage grant pool dice while a dose is live, capped at 2
- **Type:** correctness
- **Steps:** No fixture. The check builds its own gear and doses.
- **Check:**

      (() => { const c = CHAR; c.priorities = { heritage:2, magic:0, attributes:1, skills:3, resources:4 }; c.heritage.type = "Human"; c.lifestyles = [{ name: "Squatter", months: 1 }]; for (const a of RULES.ATTRIBUTES) c.attributes[a] = 3; c.gear = [{ name: "Lick", qty: 2 }]; c.finalized = true; ensurePlay(); CHAR.play.doses = []; recalc(); const read = () => { recalc(); return CALC.pools.Finesse + poolEffectMod("Finesse"); }; const out = { carried: read() }; takeDose("Lick"); out.oneLick = read(); out.lickTally = doseTally("Lick"); takeDose("Lick"); out.twoLick = read(); takeDose("Lick"); out.threeLickTally = doseTally("Lick"); out.threeLick = read(); CHAR.play.doses = []; out.wornOff = read(); return out; })()

- **Expected:**

      { "carried": 5,
        "oneLick": 9,
        "lickTally": { "taken": 1, "counted": 1, "cap": 2 },
        "twoLick": 13,
        "threeLickTally": { "taken": 3, "counted": 2, "cap": 2 },
        "threeLick": 13,
        "wornOff": 5 }

- **Note:** This is P06-028's pattern (a dose does nothing until taken, and
  stops at its cap) applied to the row that motivated writing that case in the
  first place. Lick and Rage shipped for a long time as "Increase Finesse by 4
  for 10/min" — no signed number, so `POOL_DICE_RE` never matched, and the drug
  did nothing even once the Use button and dose tracking existed. Having a dose
  *system* doesn't grant a dose its effect; the Effect text still has to parse.

  `carried: 5` with nothing taken is the same guarantee as P06-028: owning Lick
  is not using it. `oneLick: 9` is 5 + 4, `twoLick: 13` is 5 + 4×2 — the cap at
  `Max Doses: 2` matters here because the row's own text calls the second dose
  "doubling" (and raises Dependence for it), so a third dose must count as taken
  (`threeLickTally.taken: 3`, Dependence cares) while contributing no more dice
  (`counted: 2`, `threeLick` unchanged from `twoLick`). `wornOff` returning to
  `carried` is the lossless check.

  Rage is the same shape on Brawn and isn't re-run here; P06-028 already
  establishes that a second, independently-implemented path (there, the
  medkits' `Skill Bonus` column) doesn't share a bug with the pool path, so one
  case per path is the point, not one per row.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-031: New Round refills the four pools, clears hand-tracked dodge dice, and leaves Kismet dice alone
- **Type:** correctness
- **Steps:** Any finalized character, Overview tab. The check spends dice,
  ticks up the Dodge card's hand-tracked counter, clicks the real New Round
  button, and reads the result.
- **Check:**

      (() => { const c = CHAR; ensurePlay(); c.play.kismet_earned = 25; c.play.dodge_dice = 3; recalc(); kismetPoolState().setUsed(0); for (const p of POOL_ORDER) poolState(p).setUsed(2); kismetPoolState().setUsed(2); renderSheet(); const before = { pools: POOL_ORDER.map(p => poolState(p).remaining), kismet: kismetPoolState().remaining, kismetMax: kismetPoolState().max, dodge: c.play.dodge_dice }; [...document.querySelectorAll("button")].find(b => b.textContent.includes("New Round")).click(); const after = { pools: POOL_ORDER.map(p => poolState(p).remaining), kismet: kismetPoolState().remaining, dodge: c.play.dodge_dice }; return { before, after, refilled: POOL_ORDER.every(p => poolState(p).remaining === poolState(p).max) }; })()

- **Expected:** `before.kismet` is 1 (of 3), and **`after.kismet` is still 1**.
  `before.dodge` is 3 and **`after.dodge` is 0**. `refilled` is `true` — every
  attribute pool comes back to its own max.
- **Note:** Three halves, one rule: New Round means a fresh round, and each
  resource here answers differently to that.

  Kismet dice are NOT a per-round resource. They're 1 to start plus 1 per 10
  Kismet earned across the character's life, and spending one is meant to sting
  until you deliberately reset it. If `after.kismet` ever equals `before.kismetMax`,
  Kismet has silently become free.

  `play.dodge_dice` (the Dodge card's legacy hand-tracked counter, `openDodgePopover`'s
  "Tracked dodge dice" +/-) IS a per-round resource, or at least the only sane
  reading of what a player ticks it up for — "Full Defense this round," a GM's
  one-off bonus — and until this ruling it was the one thing on the Overview
  that outlived New Round entirely: nothing but its own +/- ever touched it, so
  a die added in round 3 was still there in round 30 unless someone remembered
  to zero it by hand. `after.dodge: 0` is the fix.

  `refilled` is the third, and it has to be checked in the same case: it would
  be trivially easy to "fix" a Kismet reset by narrowing what New Round touches
  and take an attribute pool out with it. The button walks `POOL_ORDER`
  (`["Brawn","Finesse","Focus","Resolve"]`), which is the entire mechanism —
  Kismet is excluded by not being in that list, dodge dice by a dedicated line,
  neither by a special case in the pool loop itself.

  Kismet's own used-count does live in `play.pool_used.Kismet`, alongside the
  four, which is why this is worth a standing test rather than an obvious truth:
  the data sits in the same object, and only the iteration order keeps them apart.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-032: The Kismet roller ignores the wound penalty and spends what it rolls
- **Type:** correctness
- **Steps:** Any finalized character, Overview tab, wounded (so a penalty
  actually exists to ignore). Clicks the real meter tile and the real Roll
  button.
- **Check:**

      (() => { const c = CHAR; ensurePlay(); c.play.kismet_earned = 25; c.play.physical_damage = 3; recalc(); kismetPoolState().setUsed(0); renderSheet(); const wound = woundPenalty(); document.querySelector(".sh-meter.kismet").click(); const step = () => document.querySelectorAll(".sh-popover .sh-roller-step")[1]; step().click(); step().click(); const requested = document.querySelector(".sh-popover .sh-roller-count").textContent; document.querySelector(".sh-popover .sh-roller-roll").click(); const thrown = document.querySelectorAll(".sh-popover .sh-roller-die").length; const remaining = kismetPoolState().remaining; document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return { woundDice: wound.dice, requested, thrown, remaining }; })()

- **Expected:** `{ "woundDice": -1, "requested": "3d6", "thrown": 3, "remaining": 0 }`
- **Note:** `woundDice: -1` is the setup working — this character really is
  carrying a wound penalty, the same one `openPoolRoller` would take off any
  other test on this sheet. `thrown` matching `requested` exactly (3 of 3, not
  2) is the assertion: nothing in this roller reads `woundPenalty()` at all, by
  design, because Kismet dice are the character choosing to spend a rare
  resource on raw luck, not a skill test the fiction can penalize.

  `remaining: 0` is the other half — the roll actually spent what it rolled,
  through the same `kismetPoolState().setUsed()` the meter's own −/+/↺ buttons
  use. There's no separate ledger for "dice the roller spent."
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-033: A second click on a header tile closes its popover
- **Type:** correctness
- **Steps:** Any finalized character with at least one enhanced sense (so the
  Senses tile exists), Overview tab. Each tap sends a real `pointerdown` before
  the click, because the outside-close listener runs on `pointerdown` and the
  toggle runs on `click` — a test that only clicks would never exercise the
  interaction between them.
- **Check:**

      (() => { const c = CHAR; ensurePlay(); c.play.kismet_earned = 25; recalc(); kismetPoolState().setUsed(0); sheetTab = "overview"; renderSheet(); const tap = sel => { const n = document.querySelector(sel); n.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, composed: true })); n.click(); }; const open = () => { const p = document.querySelector(".sh-popover"); return p ? p.dataset.popover : "none"; }; const seq = []; tap(".sh-meter.kismet"); seq.push(open()); tap(".sh-meter.kismet"); seq.push(open()); tap(".sh-pool.senses"); seq.push(open()); tap(".sh-meter.kismet"); seq.push(open()); const tile = document.querySelector(".sh-meter.kismet"); document.querySelector(".sh-popover .sh-roller-roll").click(); const replaced = tile !== document.querySelector(".sh-meter.kismet"); tap(".sh-meter.kismet"); seq.push(open()); kismetPoolState().setUsed(0); return { seq, replaced, boxes: document.querySelectorAll(".sh-popover").length }; })()

- **Expected:** `{ "seq": ["kismet", "none", "senses", "kismet", "none"], "replaced": true, "boxes": 0 }`
- **Note:** Three separate promises in one sequence. `kismet → none` is the
  toggle. `senses` following an open Kismet box, and `boxes: 0` at the end, is
  the one-at-a-time rule: opening either tile closes whatever was up, and
  nothing ever stacks.

  `replaced: true` is the case that makes this worth testing rather than
  assuming. Rolling spends a die, which re-renders the sheet, which builds a
  *new* Kismet tile node — so the last `none` is a toggle performed against a
  tile that did not exist when the popover opened. That only works because both
  openers re-find their anchor by selector; a captured node reference would make
  the final tap read as an outside click followed by a fresh open, and the box
  would stay stubbornly on screen.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-034: The header carries four meters, and Initiative is not one of them
- **Type:** correctness
- **Steps:** Any finalized character, Overview tab, in a window wider than
  1024px (below that the band unrolls to a single 4-across row by design, and
  `cols` reads 4).
- **Check:**

      (() => { sheetTab = "overview"; renderSheet(); const meters = [...document.querySelectorAll(".sheet-head .sh-meter")].map(m => m.querySelector(".k").textContent); const card = [...document.querySelectorAll("#sheet h3")].find(h => h.textContent === "Initiative"); return { meters: meters.slice(0, 3), count: meters.length, cash: meters[3] === RULES.currencyName(), cols: getComputedStyle(document.querySelector(".sh-meters")).gridTemplateColumns.split(" ").length, initInHeader: meters.some(k => /Initiative/i.test(k)), initCardHasDice: !!card && /^\d+d\+\d+$/.test(card.parentElement.querySelector(".big").textContent), initRollButton: !!document.querySelector(".sh-init-roll") }; })()

- **Expected:** `{ "meters": ["Wounds", "Kismet", "Armor"], "count": 4, "cash": true, "cols": 2, "initInHeader": false, "initCardHasDice": true, "initRollButton": true }`
- **Note:** The band is a fixed 2x2 of exactly four tiles, not an auto-fitting
  strip — `count: 4` and `cols: 2` together are what "the 2x2 block" means, and
  a fifth tile appearing would break both at once.

  The fourth key isn't spelled out because it's the currency name, which the
  data can rename; `cash: true` checks it against `RULES.currencyName()` rather
  than pinning today's word.

  `initInHeader: false` with `initCardHasDice` and `initRollButton` both true is
  the actual claim: Initiative left the header without leaving the sheet. The
  header tile could only be read, while the Combat card shows the same `Nd+N`,
  rolls it, and records the result — so removing the tile cost a quarter of a
  scarce band and lost nothing.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-035: A knowledge added in play survives a trip through chargen exactly once
- **Type:** correctness
- **Steps:** Any character. Builds its own fixture — one knowledge in chargen,
  a second added in play — then walks the round trip and re-types the second one
  in chargen the way a player would who hadn't noticed it was already there.
  Restores what it found.
- **Check:**

      (async () => { const c = CHAR; const snap = JSON.stringify([c.finalized, c.knowledge_skills, c.play]); const read = () => ({ build: (c.knowledge_skills || []).map(k => `${k.name}:${k.points}`), kit: ((c.play && c.play.kit) ? c.play.kit.knowledge_skills || [] : []).map(k => `${k.name}:${k.points}`) }); const setup = async () => { c.finalized = false; c.knowledge_skills = [{ name: "Street Rumors", points: 2 }]; c.play = null; await recalc(); ensurePlay(); c.finalized = true; c.play.kit = null; ensureKit(); c.play.kit_baseline = kitFromChargen(); await recalc(); kitOf("knowledge_skills").push({ name: "Corp Ladders", points: 1 }); await recalc(); }; const out = {}; await setup(); c.finalized = false; syncKnowledgeToBuild(); await recalc(); out.visibleInChargen = read().build; c.knowledge_skills.push({ name: "corp ladders ", points: 1 }); c.finalized = true; reconcileKit(); await recalc(); out.afterSloppyReadd = read(); await setup(); kitOf("knowledge_skills").push({ name: "Corp Law", points: 1 }); c.finalized = false; syncKnowledgeToBuild(); await recalc(); c.finalized = true; reconcileKit(); await recalc(); out.distinctKept = read().kit.length; const [f, k, p] = JSON.parse(snap); c.finalized = f; c.knowledge_skills = k; c.play = p; await recalc(); return out; })()

- **Expected:** `{ "visibleInChargen": ["Street Rumors:2", "Corp Ladders:1"], "afterSloppyReadd": { "build": ["Street Rumors:2", "Corp Ladders:1"], "kit": ["Street Rumors:2", "Corp Ladders:1"] }, "distinctKept": 3 }`
- **Note:** Knowledge skills are the one kit category the play sheet writes to
  directly — every other category has a `play.purchases` list, but a knowledge
  costs no cash and is budgeted off Intelligence in both modes. That makes it
  the one category whose names are *typed* rather than picked from a data table,
  and free text is where "same thing, different spelling" becomes possible.

  `visibleInChargen` is the first half of issue #35: a knowledge added in play
  used to be invisible on the chargen tab, so players re-added it there.

  `afterSloppyReadd` is the second half, and the part that survived the first
  fix. `syncKnowledgeToBuild` compared names case-insensitively; `reconcileKit`
  compared them exactly. So "corp ladders " looked like a brand new entry to the
  tally and was faithfully copied into the kit — the duplicate the issue
  reports. Both now use the same normalised key, and the build is de-duplicated
  before it's compared to the baseline.

  `distinctKept: 3` is the guard on the other side: loose matching must not
  merge Corp Ladders with Corp Law. Anything that made this pass by collapsing
  everything would fail here.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-036: A tracked effect moves its pool, and only its own dice come back
- **Type:** correctness
- **Steps:** Any finalized character, Overview tab. Works in deltas rather than
  absolute pool sizes so it holds for any build. Restores what it found.
- **Check:**

      (async () => { const p = CHAR.play; const snap = JSON.stringify([p.effects, p.modifiers, p.pool_boost]); const read = () => Object.fromEntries(RULES.POOL_NAMES.map(n => [n, poolState(n).max])); p.effects = []; p.modifiers = []; p.pool_boost = {}; await recalc(); const before = read(); p.effects = [{ name: "Haste", source: "spell", pool: "Focus", dice: 3 }, { name: "Bleeding", source: "GM", pool: "", dice: 0 }]; p.modifiers = [{ name: "Cover", source: "terrain", pool: "Brawn", dice: -2 }]; await recalc(); const applied = read(); poolState("Focus").setBoost(2); await recalc(); const boostedFocus = poolState("Focus").max; p.effects = p.effects.filter(e => e.name !== "Haste"); await recalc(); const afterRemove = { focus: poolState("Focus").max, boostKept: poolState("Focus").boost }; const [e, m, b] = JSON.parse(snap); p.effects = e; p.modifiers = m; p.pool_boost = b; await recalc(); return { focusDelta: applied.Focus - before.Focus, brawnDelta: applied.Brawn - before.Brawn, resolveDelta: applied.Resolve - before.Resolve, boostedFocus: boostedFocus - before.Focus, afterRemove: { focusDelta: afterRemove.focus - before.Focus, boostKept: afterRemove.boostKept } }; })()

- **Expected:** `{ "focusDelta": 3, "brawnDelta": -2, "resolveDelta": 0, "boostedFocus": 5, "afterRemove": { "focusDelta": 2, "boostKept": 2 } }`
- **Note:** `brawnDelta: -2` is why these entries take a signed number rather
  than a "bonus": a penalty is the same mechanism with the other sign, and
  Cover is far more common than Haste. Brawn is used for it because the pools
  clamp at zero — on a 1-die pool a −2 reads as −1, which is correct behaviour
  and a confusing thing to assert.

  `resolveDelta: 0` is the "No pool" case the issue asks to keep. A row with no
  pool is a reminder — "Bleeding", "3 rounds left" — and must move nothing.

  The last two keys are the important pair. These dice join the *conditional*
  layer, alongside a drug and the Wildling shift, not the player's own
  `pool_boost`. So a hand-set +2 and a Haste +3 stack to +5, and removing Haste
  leaves the +2 exactly where it was. Folding them into pool_boost instead would
  have made deleting an effect eat dice the player put there themselves — the
  same trap issue #31 already fixed once for drugs.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-037: Shapeshift's form allowance follows Force, and never strands a worn form
- **Type:** correctness
- **Steps:** Any finalized character. Sets three chosen forms directly and reads
  the state back at three different Forces without touching the picks.
  Restores what it found.
- **Check:**

      (() => { const c = CHAR; const snap = JSON.stringify(c.play.shapeshift || null); c.play.shapeshift = { picks: ["Wolf", "Hawk", "Bear"], active: "Bear" }; const at3 = RULES.shapeshiftState(c, 3); const at2 = RULES.shapeshiftState(c, 2); const at0 = RULES.shapeshiftState(c, 0); c.play.shapeshift = snap ? JSON.parse(snap) : { picks: [], active: "" }; return { at3: { allowed: at3.allowed, over: at3.over, active: at3.active, remaining: at3.remaining }, at2: { allowed: at2.allowed, over: at2.over, active: at2.active }, at0: { allowed: at0.allowed, over: at0.over.length, active: at0.active } }; })()

- **Expected:** `{ "at3": { "allowed": ["Wolf", "Hawk", "Bear"], "over": [], "active": "Bear", "remaining": 0 }, "at2": { "allowed": ["Wolf", "Hawk"], "over": ["Bear"], "active": "" }, "at0": { "allowed": [], "over": 3, "active": "" } }`
- **Note:** "Choose a number of animals equal to the Force of the spell", and
  Force moves — a play advance raises it, a re-import or an undone advance can
  lower it. The picks are stored, the allowance is derived, and the two are
  reconciled on read rather than on write.

  `at2.over: ["Bear"]` is the important half: dropping to Force 2 does **not**
  delete the third form. Picks are a player's choices and survive a number
  changing; the sheet greys the excess and lets them decide which to drop.
  Silently discarding one would be unrecoverable.

  `at2.active: ""` is the other half, and the reason `active` is validated
  rather than trusted. The character was wearing the Bear, and at Force 2 the
  Bear is no longer within the allowance — so the form is taken off. Without
  that check a caster could be walking around as a creature they no longer know,
  with a statblock on their Condition card they have no claim to.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-038: A mod fitted in play is read from the kit, never from the build
- **Type:** correctness
- **Steps:** Any character. Builds the one fixture that can catch this: the
  chargen record carries BARE items and the kit carries the same items WITH mods
  — the state a character reaches by buying a mod after Finalize. Restores what
  it found.
- **Check:**

      (async () => { const c = CHAR; const T = DATA.tables; const snap = JSON.stringify([c.finalized, c.weapons, c.decks, c.rigs, c.drones, c.programs, c.play.kit, c.play.kit_baseline, c.play.rigging]); const rigName = T.rigs.find(r => /VCR/i.test(r["Rig Type"]))["Rig Type"]; const bare = { weapons: [{ name: "FN-RAL Heavy Assault", equipped: true, mods: [] }], decks: [{ name: "Mars Claymore", mods: [], hacking: "Hacking 4", carried: true }], rigs: [{ name: rigName, mods: [] }], drones: [{ name: "Bug-Spy", carried: true, weapons: [], mods: [] }], programs: ["Hacking 4"] }; const modded = { weapons: [{ name: "FN-RAL Heavy Assault", equipped: true, mods: ["Bi-pod (Rifle Only)"] }], decks: [{ name: "Mars Claymore", mods: ["Input Validation", "Range Extension"], hacking: "Hacking 4", carried: true }], rigs: [{ name: rigName, mods: ["Military Grade Hardening"] }], drones: [{ name: "Bug-Spy", carried: true, weapons: [], mods: [] }], programs: ["Hacking 4"], armor: [], gear: [], augments: [], vehicles: [], knowledge_skills: [] }; c.finalized = true; ensurePlay(); Object.assign(c, JSON.parse(JSON.stringify(bare))); c.play.kit = JSON.parse(JSON.stringify(modded)); c.play.kit_baseline = JSON.parse(JSON.stringify(modded)); c.play.rigging = { active_rig: rigName, linked: { "drones:0": true }, active: {}, hotseat: {}, units: {} }; await recalc(); const droneRow = T.drones.find(d => d.Drone === "Bug-Spy"); const out = { weaponRecoilMod: (CALC.weapons[0] || {}).recoil_mod, deckHardening: RULES.deckHardening(allDecks()[0], T), deckRange: RULES.deckHackRange(allDecks()[0], T), rigOwn: RULES.rigStats(allRigs()[0], T).hardening, linkedDrone: unitHardening(droneRow, { hardening: 0 }, "drones:0"), droneBase: RULES.hardeningOf(droneRow) }; const [f, w, dk, rg, dr, pg, kit, kb, rig] = JSON.parse(snap); c.finalized = f; c.weapons = w; c.decks = dk; c.rigs = rg; c.drones = dr; c.programs = pg; c.play.kit = kit; c.play.kit_baseline = kb; c.play.rigging = rig; await recalc(); return out; })()

- **Expected:** `{ "weaponRecoilMod": 1, "deckHardening": 5, "deckRange": 15, "rigOwn": 2, "linkedDrone": 4, "droneBase": 2 }`
- **Note:** Every value here is zero or base if the reader looked at the chargen
  record instead of the kit. That is the entire point of the case, and it is
  worth knowing how the bug it guards against got shipped.

  The rig-hardening feature was "verified" twice against fixtures that wrote the
  SAME rig into both `CHAR.rigs` and `play.kit.rigs`. With both sides identical,
  a reader looking at the wrong one still produces the right answer, so the
  fixture agreed with the code and neither was right. The bug only surfaced on a
  real character who had bought the mod after Finalize.

  So the shape of this fixture is the assertion: **bare in the build, modded in
  the kit.** Anything that reads gear during play must be exercised against a
  character where those two disagree, or the test is testing nothing.

  `linkedDrone: 4` against `droneBase: 2` is the specific regression —
  rigHardeningFor now sources from `allRigs()` rather than `CHAR.rigs`.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-039: A Speaker grows their practice with Kismet, at creation prices
- **Type:** correctness
- **Steps:** finalized **Speaker** (or Archmage), Kismet tab. Note the Magic
  tab's infusion and relationship meters before you start.
- **Check:**

      (() => { const play = CHAR.play, sp = CHAR.speaker || {}; const before = { kismet: play.kismet, inf: `${CALC.magic.infusion_pts.spent}/${CALC.magic.infusion_pts.budget}`, rel: `${CALC.magic.relationship_pts.spent}/${CALC.magic.relationship_pts.budget}` }; const ladder = (DATA.tables.speaker_bond_costs || []).map(r => `${r.Bond}=${r.Cost}`); const bonds = RULES.speakerBondCount(CALC); const row = [...document.querySelectorAll("#sheet .sh-advrow")].find(r => /Spirit bonds/.test(r.textContent)); const btn = row && row.querySelector("button"); return { ladder, bondsNow: bonds, max: RULES.SPEAKER_BOND_MAX, rowText: row ? row.textContent.replace(/\s+/g, " ").trim() : null, buttonLabel: btn ? btn.textContent : "(at maximum)", before }; })()

- **Expected:** `ladder` is `["1=0","2=3","3=8","4=13"]`, `max` is `4`, and
  `buttonLabel` is `+1 (N)` where **N is the cost of the NEXT rung** — 3 for a
  character with one bond, 8 with two, 13 with three, and the button is replaced
  by "at maximum" at four.
- **Then buy one** and re-run the Check. Kismet drops by exactly that cost, a
  ledger entry appears reading `Bonded a 2nd spirit` (or 3rd/4th), and **`before.inf`
  and `before.rel` are unchanged**.
- **Note:** The prices are the creation prices, read live from
  `speaker_bond_costs` rather than restated here — 0/3/8/13 for the 1st through
  4th bond. Infusions and spirits likewise cost their own listed `Cost`.

  The budgets not moving is the point of the case. Kismet purchases are excluded
  from the **creation** budgets, because those are what Magic priority bought and
  creation is over. A meter that reads overspent for a character who has done
  nothing wrong is a false alarm, and a false alarm teaches you to ignore the
  meter — after which it can't warn you when something is genuinely wrong. If
  `inf` or `rel` climbs after a purchase, that exclusion has broken.

  **The first bond costs 0.** That is faithful to the ladder (`Bond 1 = Cost 0`)
  and matches what creation charges, but it means a Speaker who took no bonds can
  claim one free. Deliberate, not a pricing bug — flag it as JUDGEMENT if the
  table wants a floor.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-040: Each Speaker purchase undoes cleanly, and only for Speakers
- **Type:** correctness
- **Check:**

      (() => { const play = CHAR.play; const kinds = ["speaker_bond", "speaker_infusion", "speaker_relationship"]; const src = undoKismetSpend.toString(); const handled = kinds.filter(k => src.includes(k)); const shown = t => { const was = CHAR.magic.chosen_type; CHAR.magic.chosen_type = t; renderSheet(); const hit = /Speaker practice/.test(document.querySelector("#sheet").textContent); CHAR.magic.chosen_type = was; renderSheet(); return hit; }; return { handled, bondAdvances: play.bond_advances || 0, boughtInfusions: play.speaker_infusions || [], boughtRelationships: play.speaker_relationships || [], magicType: CALC.magic.type }; })()

- **Expected:** `handled` lists all three kinds. The three `play.*` fields hold
  exactly what you've bought this session.
- **Then press Undo** on a Speaker entry in the Kismet ledger: the Kismet comes
  back, the entry disappears, and the matching field steps down — `bond_advances`
  by one, or the bought **name** removed from its list.
- **Note:** `undoKismetSpend` dispatches on `undo.kind`, and an unhandled kind
  refunds the Kismet while leaving the purchase in place — a silent duplication
  bug, which is why `handled` is asserted rather than assumed.

  Bonds decrement a counter; infusions and relationships are bought by name, so
  undo removes the **last** occurrence. Buy the same infusion twice, undo once,
  and one remains — check that rather than assuming, since removing the first
  occurrence looks identical until you own two.

  The section is absent for every other magic type. A Mage at magic priority 3,
  an Amp at 2 and a Hedge at 1 all render nothing; Archmage renders it. Watch the
  priority when testing this: setting `chosen_type` to a type the priority
  doesn't allow resolves to a different one, so a "Mage" at priority 2 is really
  an Amp or Speaker and proves nothing.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-041: What Kismet bought reaches the Speaker card, not just the ledger
- **Type:** correctness
- **Steps:** finalized **Speaker** (or Archmage) who has bought at least one
  bond, infusion and relationship with Kismet. Magic tab.
- **Check:**

      (() => { const card = [...document.querySelectorAll("#sheet h3")].find(h => /Speaker/.test(h.textContent)); const txt = card ? card.closest(".card").innerText : ""; return { chargen: CHAR.speaker, folded: CALC.speaker, bondSlotsShown: (txt.match(/BOND \d+/gi) || []).length, cardMentions: (CALC.speaker.relationships || []).map(n => [n, txt.includes(n)]), infusionSlots: (CALC.speaker.infusions || []).map(n => [n, txt.includes(n)]) }; })()

- **Expected:** `folded` is a **superset** of `chargen` — bonds raised by
  `play.bond_advances`, and `play.speaker_infusions` / `play.speaker_relationships`
  appended to their lists. Every name in `cardMentions` and `infusionSlots` is
  `true`, and `bondSlotsShown` equals `folded.bonds`.
- **Observed** on a finalized Archmage carrying one chargen bond and relationship
  who then bought a 2nd bond, the Protection infusion and Mound of Skulls:
  `chargen` `{bonds: 1, infusions: [], relationships: ["Bacchanal"]}` against
  `folded` `{bonds: 2, infusions: ["Protection"], relationships: ["Bacchanal",
  "Mound of Skulls"]}`, with two bond slots and a Protection row on the card.
- **Note:** The regression this guards is a card that reads `CHAR.speaker`.
  Kismet purchases never land there — `character.speaker` is chargen-owned, so
  `applyPlayAdvances` merges them onto the **deep copy** that only `calculate()`
  sees, published as `CALC.speaker`. Read the raw character instead and every
  purchase is charged for, logged in the ledger, undoable — and invisible on the
  sheet, which is the worst shape a bug can take: the money is gone and nothing
  looks broken.

  P06-039 and P06-040 both pass while this fails. They watch the ledger and the
  buy panel, and those are correct in exactly the case where the card is wrong —
  which is why the assertion here is on rendered card text rather than on
  `play.*` state.

  Applies equally to the markdown export, which shares the same source.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-042: A spirit bonded or infused is unavailable for every other slot
- **Type:** correctness
- **Steps:** finalized **Speaker** (or Archmage) with **2+ bond slots** and
  **2+ known relationships**. Magic tab. Place one relationship in Bond 1.
- **Check:**

      (() => { const card = [...document.querySelectorAll("#sheet h3")].find(h => /Speaker/.test(h.textContent)).closest(".card"); const opts = sel => [...sel.options].map(o => o.value || "(empty)"); const infSel = [...card.querySelectorAll(".sh-advrow select")][0]; const bondSels = [...card.querySelectorAll(".sh-bond-tile select")]; return { placedInBond1: bondSels[0] && bondSels[0].value, infusionOptions: infSel ? opts(infSel) : "(no infusion slots)", bond2Options: bondSels[1] ? opts(bondSels[1]) : "(no 2nd bond)" }; })()

- **Expected:** the spirit placed in Bond 1 does **not** appear in
  `infusionOptions` or `bond2Options` — each list holds only `(empty)` plus
  relationships not already committed elsewhere. It still appears as Bond 1's
  own selected value (a slot always offers its current occupant).
- **Then place a different relationship in the infusion slot** and re-run: that
  name drops out of both bond pickers' option lists the same way.
- **Note:** One spirit, one job — a spirit bonded or infused is committed there
  and can't simultaneously fill a different bond or infusion. Before this case
  existed, the bond picker offered every known relationship unfiltered (no
  bond-vs-bond or bond-vs-infusion exclusion at all), and the infusion picker
  only excluded other infusion slots, not bonds. Confirmed on a 2-bond Archmage
  with Bacchanal bonded first: Bacchanal was offered again in both the 2nd bond
  slot and the infusion slot before the fix, and excluded from both after.

  `rules.js` carries the same rule as a safety net for stale or hand-edited
  data that predates this case: `RULES.boundSpiritNames` seeds
  `resolveInfusions`'s dedup set, so a spirit saved as both bonded and infused
  only counts once (as bonded) —

      (() => { const raw = RULES.mergeDefaults(JSON.parse(JSON.stringify(CHAR))); raw.play.bond_slots = [{ spirit: "Bacchanal", force: 3, favors: 0 }]; raw.speaker.bonds = 1; raw.play.infusion_spirits = { Protection: "Bacchanal" }; raw.speaker.infusions = ["Protection"]; return RULES.calculate(raw).infusions.map(e => e.spirit); })()

  Expected `[]` — Bacchanal's stale Protection placement is dropped, not
  double-counted alongside its bond. The same file has an analogous safety net
  for two BOND slots holding the same spirit (Control exploits and Bound
  Services etiquette effects each count that spirit once, not per slot) — not
  independently cased here since the UI now prevents the state that would
  exercise it.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-043: A legacy `infusion_spirits: []` self-heals instead of eating placements
- **Type:** correctness
- **Steps:** any finalized Speaker/Archmage. Console only, no fixture needed.
- **Check:**

      (() => { CHAR.play.infusion_spirits = []; CHAR.play.infusion_spirits.Protection = "Test Spirit"; const before = { isArray: Array.isArray(CHAR.play.infusion_spirits), json: JSON.stringify(CHAR.play.infusion_spirits) }; ensurePlay(); const after = { isArray: Array.isArray(CHAR.play.infusion_spirits), json: JSON.stringify(CHAR.play.infusion_spirits) }; return { before, after }; })()

- **Expected:** `before` is `{ isArray: true, json: "[]" }` — an Array with a
  string-keyed prop JSON.stringify silently drops. `after` is
  `{ isArray: false, json: "{}" }` — `ensurePlay()` resets it to a clean plain
  object rather than leaving the wrong-typed value in place.
- **Note:** This is a real shape some exported/saved characters carry — not a
  synthetic edge case. `JSON.stringify` on an Array only serialises integer
  indices, so a spirit placed into an infusion slot on a character whose
  `play.infusion_spirits` was ever persisted as `[]` would render correctly
  for the rest of that session and then silently disappear on the next
  save/reload/export — charged nowhere, logged nowhere, just gone, and nothing
  would report an error.

  `mergeDefaults` in rules.js already guards this exact failure mode for its
  own default fields (see its comment on `isPlainObject`), but
  `infusion_spirits`/`bond_slots` aren't declared in `RULES.defaultCharacter()`
  — they're topped up separately by `ensurePlay()` in sheet.js, which used a
  weaker `== null` check that left a non-null wrong-typed value alone. Fixed by
  giving `ensurePlay()` the same reset-if-wrong-type guard. `ensurePlay()` runs
  on every character open and tab switch, so an already-corrupted save heals
  itself the next time it's opened — no manual repair needed.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-044: Every boon redemption gets an Undo, not just Kismet purchases
- **Type:** correctness
- **Steps:** finalized character (any magic type — boons aren't Speaker-specific).
  Kismet tab. Set up enough lifetime Kismet to have both a regular and a major
  boon available:

      (() => { CHAR.play.kismet_earned = 20; CHAR.play.boons_spent = 0; CHAR.play.major_boons_spent = 0; CHAR.play.kismet_log = []; playChanged(); return kismetEcon(); })()

  Expected `regularsAvail`/`majorsAvail` both `>= 1`.
- **Check — redeem a regular boon (Free asset), then read the ledger row:**

      (() => { document.querySelector("#sheet"); const card = [...document.querySelectorAll(".card.sh-card")].find(c => c.querySelector("h3")?.textContent === "Boons"); [...card.querySelectorAll("button")].find(b => b.textContent.trim() === "Redeem: Free asset").click(); const row = document.querySelector(".card.sh-card table tr:nth-child(2)"); return { boonsSpentAfterRedeem: CHAR.play.boons_spent, rowHasUndo: row.textContent.includes("Undo"), logEntry: CHAR.play.kismet_log[0] }; })()

- **Expected:** `boonsSpentAfterRedeem` is `1`, `rowHasUndo` is `true`, and
  `logEntry` carries `{ delta: 0, undo: { kind: "boon" } }` alongside its label.
- **Then click that Undo button** and re-check: `CHAR.play.boons_spent` back to
  `0`, the ledger row gone, and `kismetEcon().regularsAvail` back up by one —
  the boon is available to redeem again, not lost.
- **Repeat for a rank boon** (Mastery 6→7, or the major Skill 7→8) with a
  skill/etiquette/knowledge at the matching rank: Undo must roll back **both**
  the `boons_spent`/`major_boons_spent` counter **and** the rank
  (`play.skill_advances` / `etiquette_advances` / the knowledge's own
  `points`) — check the rank specifically, not just the counter, since a boon
  that un-spends but leaves the rank raised is still a bug.
- **Repeat for the pool-die major boon** (+1 Kismet die to a pool): Undo must
  roll back `major_boons_spent` **and** `play.pool_kismet[pool]`.
- **Note:** Before this case, no boon redemption of any kind could be undone —
  not a partial gap, all seven redeem buttons (Windfall, Free asset, generic
  Major boon, Mastery 6→7, magic item, Skill 7→8, +1 Kismet die to pool) wrote
  `kismet_log.unshift({ label, delta: 0 })` with no `undo` descriptor at all.
  Two independent gates were blocking it, and both had to give for any of them
  to work:

  1. The ledger only rendered an Undo button when `entry.delta < 0` — a boon's
     `delta` is always `0` (it costs no Kismet, just a milestone slot), so the
     button never rendered regardless of `undo`.
  2. `undoKismetSpend()` itself returned early on `entry.delta >= 0` — even a
     hand-added `undo` descriptor wouldn't have done anything.

  Both were loosened from "delta is negative" to "delta is not positive"
  (`<= 0`), which is safe: a **gained** entry (`awardKismet`, positive delta —
  e.g. "Custom award") never carries an `undo` field regardless, so it still
  renders no button. Confirm that stays true:

      (() => { awardKismet("Custom award", 1); const row = document.querySelector(".card.sh-card table tr:nth-child(2)"); const ok = !row.textContent.includes("Undo"); CHAR.play.kismet = Math.max(0, CHAR.play.kismet - 1); CHAR.play.kismet_earned -= 1; CHAR.play.kismet_log.shift(); playChanged(); return ok; })()

  Expected `true`. Also confirm the "🎲 Roll windfall" button (which just logs
  a dice result — it doesn't spend a boon, "Redeem: Windfall" does that
  separately) still shows no Undo: it carries no `undo` field by design, since
  there's nothing to roll back.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-045: A pool's permanent Kismet die is a floor no penalty can dig under
- **Type:** correctness
- **Steps:** any finalized character. Console only.
- **Check:**

      (() => { const play = CHAR.play; const snap = JSON.stringify([play.pool_kismet, play.pool_boost]); play.pool_kismet = { Resolve: 2 }; play.pool_boost = { Resolve: -50 }; playChanged(); const withDie = poolState("Resolve"); play.pool_kismet = {}; const noDie = poolState("Resolve"); const [pk, pb] = JSON.parse(snap); play.pool_kismet = pk; play.pool_boost = pb; playChanged(); return { base: CALC.pools.Resolve, withDieMax: withDie.max, noDieMax: noDie.max }; })()

- **Expected:** with a base Resolve pool of `20` and a `-50` temporary penalty,
  `withDieMax` is `2` (the permanent-die floor, not `0` and not negative) while
  `noDieMax` — same penalty, no Kismet die — is `0`. The floor applies only to
  the pool actually holding the die.
- **Then check the boundary**, where the natural total lands strictly between
  `0` and the die count rather than deeply negative:

      (() => { const play = CHAR.play; const snap = JSON.stringify([play.pool_kismet, play.pool_boost]); play.pool_kismet = { Resolve: 2 }; play.pool_boost = { Resolve: -19 }; playChanged(); const max = poolState("Resolve").max; const [pk, pb] = JSON.parse(snap); play.pool_kismet = pk; play.pool_boost = pb; playChanged(); return { base: CALC.pools.Resolve, naturalTotal: CALC.pools.Resolve - 19, max }; })()

- **Expected:** `naturalTotal` is `1` (below the 2-die floor) and `max` is
  still `2`, not `1` — the floor isn't "clamp to 0 unless deeply negative", it
  holds at exactly the die count.
- **Note:** `poolState()` in `sheet.js` is the single function every pool
  reader goes through (header tiles, sticky-bar pills, the die roller, "Reset
  pool to full") — before this fix it clamped the effective max at `Math.max(0,
  base + boost + beast)`, floored at zero like a pool with no boon at all. A
  permanent Kismet die from a major boon is explicitly "cannot be removed" —
  the header tile's own tooltip already said so — but nothing enforced that
  once temporary penalty dice (the manual "Reduce temporary dice" control, a
  drug, a tracked negative Effect/Modifier) stacked deep enough. Fixed by
  flooring at `kismetDice` instead of `0`; `kismetDice` defaults to `0` for
  every pool without a boon die, so the ordinary case is unchanged (confirmed
  by `noDieMax` above).
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-046: Hand assignment persists, and a two-handed weapon claims its neighbour
- **Type:** correctness
- **Steps:** open this purpose-built character (a real one-handed pistol, a
  real two-handed rifle, and a melee weapon, so the exclusivity rule has
  something to bite on):

      (async () => { const raw = RULES.mergeDefaults(RULES.defaultCharacter()); raw.name = "QA-Hands"; raw.heritage.type = "Human"; raw.attributes = { Strength: 5, Body: 5, Reaction: 5, Intelligence: 5, Willpower: 5, Charisma: 5 }; raw.skills = { "Firearms": 4, "Melee Weapons": 3 }; raw.weapons = [{ name: "KL-89 \"Klaw\" (POS)", equipped: true }, { name: "Militech Whisper 1000", equipped: true }, { name: "Sword", equipped: true }]; raw.finalized = true; raw.lifestyles = [{ name: "Low", months: 1 }]; await openCharacter(RULES.mergeDefaults(raw)); return { name: CHAR.name, handsRifle: RULES.weaponHands(DATA.tables.weapons.find(w=>w.Weapon==="Militech Whisper 1000")), handsPistol: RULES.weaponHands(DATA.tables.weapons.find(w=>w.Weapon==='KL-89 "Klaw" (POS)')) }; })()

  Expected `handsRifle` is `2`, `handsPistol` is `1`.
- **Check — assign the pistol to Hand 1, then read both cards:**

      (() => { const card = [...document.querySelectorAll("h3")].find(h => h.textContent.includes("Loadout")).closest(".card"); const sel1 = card.querySelectorAll(".sh-hand-card")[0].querySelector("select"); sel1.value = [...sel1.options].find(o => o.textContent === 'KL-89 "Klaw" (POS)').value; sel1.dispatchEvent(new Event("change", { bubbles: true })); return CHAR.play.kit.weapons.find(w => w.name === 'KL-89 "Klaw" (POS)').hand; })()

  Expected `0`.
- **Then assign the rifle (two-handed) into Hand 1** — the same slot the
  pistol already holds, so placing it must evict the pistol AND claim Hand 2:

      (() => { const card = [...document.querySelectorAll("h3")].find(h => h.textContent.includes("Loadout")).closest(".card"); const sel1 = card.querySelectorAll(".sh-hand-card")[0].querySelector("select"); sel1.value = [...sel1.options].find(o => o.textContent === "Militech Whisper 1000").value; sel1.dispatchEvent(new Event("change", { bubbles: true })); const card2 = [...document.querySelectorAll("h3")].find(h => h.textContent.includes("Loadout")).closest(".card"); const tiles = [...card2.querySelectorAll(".sh-hand-card")]; const sel2 = tiles[1].querySelector("select"); return { pistolHand: CHAR.play.kit.weapons.find(w => w.name === 'KL-89 "Klaw" (POS)').hand, rifleHand: CHAR.play.kit.weapons.find(w => w.name === "Militech Whisper 1000").hand, tile1HasRifleStats: tiles[0].innerText.includes("Rifle"), tile2SelectDisabled: sel2.disabled, tile2Text: tiles[1].innerText }; })()

  Expected `pistolHand` is `null` (evicted — the rifle needed its slot too),
  `rifleHand` is `0`, `tile1HasRifleStats` is `true` (Hand 1 now shows the
  rifle's full stat/fire card), `tile2SelectDisabled` is `true`, and
  `tile2Text` is `"HAND 2\n— Militech Whisper 1000 (two-handed) —"`.
- **Then try the bypass directly** — assign the rifle into Hand 2 (the LAST
  slot) by setting `.value` on the `<select>` past its `disabled` option,
  the way a stray script or an accessibility tool could (a real click can't:
  the option is disabled). The assignment function has to hold the same rule
  a browser's own input handling won't enforce for it here:

      (() => { CHAR.play.kit.weapons.forEach(w => { w.hand = null; }); CHAR.play.kit.weapons.find(w => w.name === 'KL-89 "Klaw" (POS)').hand = 0; playChanged(); const card = [...document.querySelectorAll("h3")].find(h => h.textContent.includes("Loadout")).closest(".card"); const sel2 = card.querySelectorAll(".sh-hand-card")[1].querySelector("select"); const wasDisabled = [...sel2.options].find(o => o.textContent === "Militech Whisper 1000").disabled; sel2.value = [...sel2.options].find(o => o.textContent === "Militech Whisper 1000").value; sel2.dispatchEvent(new Event("change", { bubbles: true })); return { rifleOptionWasDisabled: wasDisabled, pistolHandAfter: CHAR.play.kit.weapons.find(w => w.name === 'KL-89 "Klaw" (POS)').hand, rifleHandAfter: CHAR.play.kit.weapons.find(w => w.name === "Militech Whisper 1000").hand }; })()

  Expected `rifleOptionWasDisabled` is `true` (confirming the picker itself
  refused this) and `rifleHandAfter` is `1` — the assignment still went
  through since nothing stops a raw `.value` set, landing the rifle in the
  LAST hand with no slot after it to claim. This is a known, accepted gap in
  a bypass scenario the UI doesn't allow through normal interaction; not
  something a future change should treat as license to loosen the picker.
- **Note:** Hand assignment lives on the weapon entry (`w.hand`), the same way
  `w.lo`/`w.mode` already do — never a `play.hands` array keyed by name, since
  two identically-named weapons is a designed-for case elsewhere in this app
  (`reconcileKit`) that name-keying would collapse. Only the PRIMARY slot is
  ever stored; a two-handed weapon's second slot is derived from
  `RULES.weaponHands()` on every render and is never written down, so it can't
  drift from a data change.

  In the picker itself, a two-handed weapon offered in the LAST hand slot is
  rendered `disabled` with a title explaining why, not omitted — the same
  "stays but says why it can't be pressed" idiom the Reload button and the
  reorder handles already use elsewhere on this tab.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-047: A free other hand steadies a one-handed weapon — melee gets nothing
- **Type:** correctness
- **Steps:** continue on `QA-Hands` from P06-046 (or rebuild it). Clear the
  rifle out of both hands and put the pistol back in Hand 1 alone:

      (() => { CHAR.play.kit.weapons.forEach(w => { w.hand = null; }); CHAR.play.kit.weapons.find(w => w.name === 'KL-89 "Klaw" (POS)').hand = 0; playChanged(); return "ready"; })()

- **Check:**

      (() => { const card = [...document.querySelectorAll("h3")].find(h => h.textContent.includes("Loadout")).closest(".card"); const tile1 = [...card.querySelectorAll(".sh-hand-card")][0]; return tile1.innerText; })()

  Expected the stat line reads `Recoil 2 (+1 free hand)` — one more than the
  pistol's bare `Recoil 1` (confirm the bare figure by reading the Gear tab or
  temporarily filling Hand 2, per the next step) — because Hand 2 is empty.
- **Then put the Sword in Hand 2** and re-run the same check:

      (() => { const card = [...document.querySelectorAll("h3")].find(h => h.textContent.includes("Loadout")).closest(".card"); const sel2 = card.querySelectorAll(".sh-hand-card")[1].querySelector("select"); sel2.value = [...sel2.options].find(o => o.textContent === "Sword").value; sel2.dispatchEvent(new Event("change", { bubbles: true })); const card2 = [...document.querySelectorAll("h3")].find(h => h.textContent.includes("Loadout")).closest(".card"); const tiles = [...card2.querySelectorAll(".sh-hand-card")]; return { pistolLine: tiles[0].innerText, swordLine: tiles[1].innerText }; })()

  Expected `pistolLine` now reads plain `Recoil 1` (both hands full, no
  bonus), and `swordLine` — a Melee weapon — carries **no `Recoil` figure at
  all**, not `Recoil 1 (+1 free hand)`.
- **Note:** Recoil in this app is a *capacity*, not a penalty — higher is
  better (a gyromount gives `+2`; a cybergun doubles it), so "+1 free hand" is
  a bonus for having a hand free to steady the gun with, the same shape a
  bolted-on mod's `+N` already takes (added onto `recoil_mod`, never replacing
  it, so a bipod's own `+N` isn't erased by this).

  The melee guard is the trap that would have shipped broken without it: the
  engine deliberately gives Melee and Thrown **no** `Recoil` key at all (a
  Katana reading "Recoil 3" would be noise on every unarmed character's
  sheet), so the bonus is computed only when `calcRow.Recoil != null` — a
  blind `{...calcRow, Recoil: +1}` would have printed a phantom Recoil line on
  every one-handed melee card with an empty other hand.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-048: Switching a hand costs a Simple Action and clears recoil; refused when broke
- **Type:** correctness
- **Steps:** `QA-Hands`, both hands empty, `play.action_costs` on, a little
  recoil already on the books:

      (() => { CHAR.play.kit.weapons.forEach(w => { w.hand = null; }); CHAR.play.action_costs = true; CHAR.play.recoil = 5; CHAR.play.actions_used = {}; playChanged(); return { simpleAvail: CALC.combat.simple_actions }; })()

- **Check — assign a weapon, spending one of them:**

      (() => { const card = [...document.querySelectorAll("h3")].find(h => h.textContent.includes("Loadout")).closest(".card"); const sel1 = card.querySelectorAll(".sh-hand-card")[0].querySelector("select"); sel1.value = [...sel1.options].find(o => o.textContent === 'KL-89 "Klaw" (POS)').value; sel1.dispatchEvent(new Event("change", { bubbles: true })); return { actionsUsed: CHAR.play.actions_used, recoil: CHAR.play.recoil }; })()

  Expected `actionsUsed.simple` is `1` and `recoil` is `0` — filling a hand
  costs a Simple Action and resets the tracker (your stance changed; recoil is
  one character-wide counter, not per-weapon — `CHAR.play.recoil`, read by
  every gun via `recoilTracked()`).
- **Then exhaust the remaining Simple Actions and try to fill Hand 2** (an
  `alert` fires — this stubs it rather than skipping the case, per P00 §3):

      (() => { CHAR.play.actions_used.simple = CALC.combat.simple_actions; playChanged(); const card = [...document.querySelectorAll("h3")].find(h => h.textContent.includes("Loadout")).closest(".card"); const sel2 = card.querySelectorAll(".sh-hand-card")[1].querySelector("select"); const orig = window.alert; let msg = null; window.alert = m => { msg = m; }; sel2.value = [...sel2.options].find(o => o.textContent === "Sword").value; sel2.dispatchEvent(new Event("change", { bubbles: true })); window.alert = orig; const card2 = [...document.querySelectorAll("h3")].find(h => h.textContent.includes("Loadout")).closest(".card"); const sel2After = card2.querySelectorAll(".sh-hand-card")[1].querySelector("select"); return { alertFired: !!msg, swordHand: CHAR.play.kit.weapons.find(w => w.name === "Sword").hand, selectValueAfterRerender: sel2After.value }; })()

  Expected `alertFired` is `true`, `swordHand` is `null` (unchanged from the
  setup step — the refusal touched no state), and `selectValueAfterRerender`
  is `""` — the refused pick did not stick, and the re-render (triggered on
  refusal specifically so the `<select>` doesn't keep showing an uncommitted
  choice) put the control back to what it actually holds.
- **Then confirm clearing a hand to empty is free** — put the pistol back with
  a Simple Action to spare, then take it out again with none:

      (() => { CHAR.play.actions_used.simple = 0; playChanged(); const card = [...document.querySelectorAll("h3")].find(h => h.textContent.includes("Loadout")).closest(".card"); const sel1 = card.querySelectorAll(".sh-hand-card")[0].querySelector("select"); sel1.value = ""; sel1.dispatchEvent(new Event("change", { bubbles: true })); return { pistolHand: CHAR.play.kit.weapons.find(w => w.name === 'KL-89 "Klaw" (POS)').hand, actionsUsed: CHAR.play.actions_used.simple || 0 }; })()

  Expected `pistolHand` is `null` and `actionsUsed` unchanged at `0` — taking
  a weapon OUT of a hand spends nothing, only putting one IN does.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-049: Shrinking the hand count preserves assignments, same ruling as bond slots
- **Type:** correctness
- **Steps:** `QA-Hands`. Put the pistol in Hand 1, the Sword in Hand 2:

      (() => { CHAR.play.action_costs = false; const w = CHAR.play.kit.weapons; w.find(x => x.name === 'KL-89 "Klaw" (POS)').hand = 0; w.find(x => x.name === "Sword").hand = 1; w.find(x => x.name === "Militech Whisper 1000").hand = null; CHAR.play.hand_override = null; playChanged(); return { handCount: RULES.handCount(CALC, CHAR.play.hand_override) }; })()

  Expected `handCount` is `2`.
- **Check — override down to 1 hand:**

      (() => { CHAR.play.hand_override = 1; playChanged(); const card = [...document.querySelectorAll("h3")].find(h => h.textContent.includes("Loadout")).closest(".card"); return { tileCount: card.querySelectorAll(".sh-hand-card").length, hints: [...card.querySelectorAll("p.hint")].map(p => p.textContent), swordHandStillStored: CHAR.play.kit.weapons.find(w => w.name === "Sword").hand }; })()

  Expected `tileCount` is `1`, `hints` includes a line naming the Sword as
  *"Held in a hand you no longer have"* (not deleted, just not rendered), and
  `swordHandStillStored` is still `1` — unchanged in the data.
- **Then clear the override** and confirm the Sword's card comes back with no
  further action:

      (() => { CHAR.play.hand_override = null; playChanged(); const card = [...document.querySelectorAll("h3")].find(h => h.textContent.includes("Loadout")).closest(".card"); const sel2 = card.querySelectorAll(".sh-hand-card")[1].querySelector("select"); return { tileCount: card.querySelectorAll(".sh-hand-card").length, hand2Selected: sel2.options[sel2.selectedIndex].textContent }; })()

  Expected `tileCount` is `2` and `hand2Selected` is `"Sword"`.
- **Note:** This is the identical ruling already applied to `play.bond_slots`
  (Speaker bonds): dropping the count and raising it again hands the
  assignment back rather than losing it, because the count alone decides how
  much of the stored state is *live*, not how much *exists*. Confirmed here by
  never clearing `w.hand` on a shrink — only `handCount()`-bounded rendering
  changes.

  Also worth a manual look while here: `CALC.combat.hand_count` is 2 by
  default and grows with an "Extra Arm" heritage trait or a Heavy Torso mount
  picked as a Cyberarm (`RULES.handCount(CALC, override)` layers a
  `play.hand_override` on top, clamped `1..RULES.HAND_COUNT_MAX`). Not cased
  here since it rides the same `applyHeritage` machinery P06 already exercises
  elsewhere for Extra Arm/Extra Leg's armor surcharge.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-050: The M31-a1 / M31-a1G is a named one-off exception to "2H claims both hands"
- **Type:** correctness
- **Steps:** a character carrying both the Militech M31-a1 Advanced Combat
  Weapon (Rifle, two-handed) and the Militech M31-a1G (its own grenade
  launcher, one-handed) equipped:

      (async () => { const raw = RULES.mergeDefaults(RULES.defaultCharacter()); raw.name = "QA-Companion"; raw.heritage.type = "Human"; raw.attributes = { Strength: 5, Body: 5, Reaction: 5, Intelligence: 5, Willpower: 5, Charisma: 5 }; raw.skills = { "Firearms": 4, "Heavy Weapons": 3 }; raw.weapons = [{ name: "Militech M31-a1 Advanced Combat Weapon", equipped: true }, { name: "Militech M31-a1G", equipped: true }, { name: "Sword", equipped: true }]; raw.finalized = true; raw.lifestyles = [{ name: "Low", months: 1 }]; await openCharacter(RULES.mergeDefaults(raw)); return "loaded"; })()

- **Check — put the M31-a1 in Hand 1, then read Hand 2 before touching it:**

      (() => { const card = [...document.querySelectorAll("h3")].find(h => h.textContent.includes("Loadout")).closest(".card"); const sel1 = card.querySelectorAll(".sh-hand-card")[0].querySelector("select"); sel1.value = [...sel1.options].find(o => o.textContent === "Militech M31-a1 Advanced Combat Weapon").value; sel1.dispatchEvent(new Event("change", { bubbles: true })); const card2 = [...document.querySelectorAll("h3")].find(h => h.textContent.includes("Loadout")).closest(".card"); const sel2 = card2.querySelectorAll(".sh-hand-card")[1].querySelector("select"); return { tile2Disabled: sel2.disabled, tile2Options: [...sel2.options].map(o => o.textContent) }; })()

  Expected `tile2Disabled` is `false` (a REAL picker, not the usual disabled
  "needs both hands" placeholder every other two-handed weapon gets — see
  P06-046) and `tile2Options` is `["— empty —", "Militech M31-a1G"]` — the
  Sword is carried too but is deliberately excluded here; this slot is still
  "spoken for" by the M31-a1, just with one named weapon let through.
- **Then assign the M31-a1G into Hand 2 and confirm both hold together:**

      (() => { const card = [...document.querySelectorAll("h3")].find(h => h.textContent.includes("Loadout")).closest(".card"); const sel2 = card.querySelectorAll(".sh-hand-card")[1].querySelector("select"); sel2.value = [...sel2.options].find(o => o.textContent === "Militech M31-a1G").value; sel2.dispatchEvent(new Event("change", { bubbles: true })); return { rifleHand: CHAR.play.kit.weapons.find(w => w.name === "Militech M31-a1 Advanced Combat Weapon").hand, launcherHand: CHAR.play.kit.weapons.find(w => w.name === "Militech M31-a1G").hand }; })()

  Expected `rifleHand` is `0` and `launcherHand` is `1` — both persist
  simultaneously, unlike the normal rule where a second hand near a
  two-handed weapon can never hold its own primary assignment.
- **Then confirm re-picking the M31-a1 into Hand 1 doesn't bump the M31-a1G**
  out of Hand 2 (the general two-handed eviction rule in `assignHand` skips
  exactly this one pairing):

      (() => { CHAR.play.kit.weapons.find(w => w.name === "Militech M31-a1 Advanced Combat Weapon").hand = null; playChanged(); const card = [...document.querySelectorAll("h3")].find(h => h.textContent.includes("Loadout")).closest(".card"); const sel1 = card.querySelectorAll(".sh-hand-card")[0].querySelector("select"); sel1.value = [...sel1.options].find(o => o.textContent === "Militech M31-a1 Advanced Combat Weapon").value; sel1.dispatchEvent(new Event("change", { bubbles: true })); return { rifleHand: CHAR.play.kit.weapons.find(w => w.name === "Militech M31-a1 Advanced Combat Weapon").hand, launcherHand: CHAR.play.kit.weapons.find(w => w.name === "Militech M31-a1G").hand }; })()

  Expected `rifleHand` is `0`, `launcherHand` is still `1`.
- **Then confirm the exception is named, not general** — a different
  two-handed weapon paired with the M31-a1G gets the ordinary disabled
  placeholder, not an open picker:

      (async () => { const raw = RULES.mergeDefaults(RULES.defaultCharacter()); raw.name = "QA-Companion2"; raw.heritage.type = "Human"; raw.attributes = { Strength: 5, Body: 5, Reaction: 5, Intelligence: 5, Willpower: 5, Charisma: 5 }; raw.skills = { Firearms: 4 }; raw.weapons = [{ name: "Militech Whisper 1000", equipped: true }, { name: "Militech M31-a1G", equipped: true }]; raw.finalized = true; raw.lifestyles = [{ name: "Low", months: 1 }]; await openCharacter(RULES.mergeDefaults(raw)); const card = [...document.querySelectorAll("h3")].find(h => h.textContent.includes("Loadout")).closest(".card"); const sel1 = card.querySelectorAll(".sh-hand-card")[0].querySelector("select"); sel1.value = [...sel1.options].find(o => o.textContent === "Militech Whisper 1000").value; sel1.dispatchEvent(new Event("change", { bubbles: true })); const card2 = [...document.querySelectorAll("h3")].find(h => h.textContent.includes("Loadout")).closest(".card"); const sel2 = card2.querySelectorAll(".sh-hand-card")[1].querySelector("select"); return sel2.disabled; })()

  Expected `true` — Militech Whisper 1000 is an unrelated two-handed rifle,
  so Hand 2 falls back to the ordinary "needs both hands" placeholder even
  though the M31-a1G happens to be carried.
- **Note:** `TWO_HANDED_COMPANION` in `sheet.js` is a small hardcoded map, one
  entry, added on request as a one-off exception — not a data column, not a
  general "these two weapons pair" system. The M31-a1G represents the M31-a1's
  own under-mounted grenade launcher, so holding it in the second hand while
  the base rifle occupies the first is the same weapon system, not genuine
  two-weapon fighting. No other weapon gets this; extending it to another
  pairing means adding another named entry, not changing the rule.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-051: A conditional effect (Wildling's shift) moves the Skills tab, not just the header
- **Type:** correctness
- **Check:**

      (async () => { const c = RULES.defaultCharacter(); c.name = "QA Wildling Pools"; c.priorities = { heritage: 4, magic: 0, attributes: 3, skills: 2, resources: 1 }; c.heritage.type = "Green"; c.heritage.features = ["Wildling"]; c.lifestyles = [{ name: "Squatter", months: 1 }]; c.finalized = true; await openCharacter(c); sheetTab = "skills"; renderSheet(); const readSkills = () => [...document.querySelectorAll(".sh-skillcard .colhead")].map(h => `${h.querySelector("span").textContent}=${h.querySelector("b").textContent}`); const skillsOff = readSkills(); sheetTab = "overview"; renderSheet(); const headerTitle = () => { const t = document.querySelector(".sh-pool.resolve"); return t ? t.title : null; }; const headerOff = headerTitle(); setPoolEffect(RULES.WILDLING_EFFECT_ID, true); sheetTab = "skills"; renderSheet(); const skillsOn = readSkills(); const colorOn = document.querySelector(".sh-skillcard.resolve .colhead b").getAttribute("style"); sheetTab = "overview"; renderSheet(); const headerOn = headerTitle(); await closeTabByName("QA Wildling Pools"); return { skillsOff, headerOff, skillsOn, headerOn, colorOn }; })()

- **Expected:**

      { "skillsOff": ["Brawn=2","Finesse=1","Focus=1","Resolve=2"],
        "headerOff": "Resolve: 2 of 2 dice left — click to show Resolve skills",
        "skillsOn": ["Brawn=8","Finesse=7","Focus=0","Resolve=0"],
        "headerOn": "Resolve: 0 of 0 dice left — click to show Resolve skills",
        "colorOn": "color:var(--bad)" }

- **Note:** This is a real bug that shipped and was reported: switching Beast
  Form on in Conditional Effects visibly moved the header tile's Resolve pool
  but left the Skills tab's per-pool card header completely unchanged. Rerunning
  this exact check against the pre-fix code reproduces it precisely — `skillsOn`
  comes back **identical to `skillsOff`** (`Resolve=2`, not `0`) while
  `headerOn` already reads `0 of 0`, the two panels disagreeing about how big
  your own Resolve pool currently is.

  The cause was one call site. Every other pool total on the sheet —
  the header tile, the compact sticky strip — reads `poolState(pool).max`,
  which layers temp boost dice and active conditional effects (Wildling,
  Adrenal Pump, a drug) on top of the static build number. The Skills tab's
  card header alone read the raw build number (`CALC.pools[pool]`) straight
  from the engine, which has no notion of what's currently switched on — that
  state lives in `play.pool_effects`, one layer up, by design (see the comment
  above `derivePoolEffects` in rules.js). So the header and the Skills tab were
  never wired to the same source of truth, and the Skills tab was one `git
  blame` away from being right the whole time it looked wrong.

  `colorOn` checks the header now flags a live-altered pool rather than just
  silently changing the number — red for a net reduction (Resolve, Focus),
  which would be green for Brawn/Finesse if you check those too. A pool that's
  merely BOOSTED and one that's ACTIVELY SHIFTED both hit this same code path
  (`ps.beast + ps.boost`), so a temp +2 from `pool_boost` alone should also
  recolor the header without needing Wildling at all — worth trying by hand if
  you want to see the boost half of this independently.

  Built inline via `RULES.defaultCharacter()` rather than a fixture because no
  shipped fixture takes the Green heritage with the Wildling boon, and this bug
  is specific to that combination having something to switch on. Verified in an
  actual headless Chromium run against the real app (not just this DOM
  read-out) before this case was written, including reproducing the failure
  against the unpatched file.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-052: The action economy is spendable from every tab, agrees with the Overview card, and folds away without losing New Round
- **Type:** correctness
- **Steps:** none.
- **Check:**

      (async () => { const c = RULES.defaultCharacter(); c.name = "QA Actions Strip"; c.priorities = { heritage: 2, magic: 0, attributes: 3, skills: 2, resources: 3 }; c.heritage.type = "Human"; c.augments = [{ name: "Wired Reflexes 2", count: 1 }]; c.decks = [{ name: "MasterDeck", mods: [] }]; c.hacking_rating = 2; c.finalized = true; c.lifestyles = [{ name: "Squatter", months: 1 }]; await openCharacter(c); const tabIds = ["overview", "skills", "kismet", "gear", "augments", "magic", "decking", "rigging", "actions", "notes"]; const presentOnEveryTab = {}; for (const t of tabIds) { sheetTab = t; renderSheet(); presentOnEveryTab[t] = !!document.querySelector(".sh-actions-strip"); } sheetTab = "overview"; renderSheet(); const pillLabels = [...document.querySelectorAll(".sh-apill .k")].map(k => k.textContent); const findPill = label => [...document.querySelectorAll(".sh-apill")].find(p => p.querySelector(".k").textContent === label); const plusBtn = [...findPill("Simple").querySelectorAll("button")].find(b => b.textContent === "+"); plusBtn.click(); const stripSimpleAfter = findPill("Simple").querySelector("b").textContent; const cardSimpleText = [...document.querySelectorAll(".sh-card .stat-line")].find(l => l.textContent.startsWith("Simple")).querySelector("b").textContent; sheetTab = "gear"; renderSheet(); const poolBeforeNewRound = poolState("Brawn").remaining; poolState("Brawn").setUsed(1); playChanged(); const poolAfterSpend = poolState("Brawn").remaining; [...document.querySelectorAll(".sh-actions-strip button")].find(b => b.textContent.includes("New Round")).click(); const afterNewRound = { pool: poolState("Brawn").remaining, actionsUsed: CHAR.play.actions_used, tabStayedOnGear: sheetTab === "gear" }; sheetTab = "overview"; renderSheet(); const startedExpanded = !document.querySelector(".sh-actions-strip").classList.contains("collapsed"); document.querySelector(".sh-strip-toggle").click(); const collapsed = document.querySelector(".sh-actions-strip").classList.contains("collapsed"); const newRoundStillPressableCollapsed = !![...document.querySelectorAll(".sh-actions-strip button")].find(b => b.textContent.includes("New Round")); const persistedToLocalStorage = localStorage.getItem("sinless:actionstrip"); document.querySelector(".sh-strip-toggle").click(); const tab = activeTabObj(); tab.readonly = true; renderSheet(); const roStrip = document.querySelector(".sh-actions-strip"); const readonly = { hasNewRound: !![...roStrip.querySelectorAll("button")].find(b => b.textContent.includes("New Round")), miniCounters: roStrip.querySelectorAll(".mini-btn").length, pillCounts: [...roStrip.querySelectorAll(".sh-apill b")].map(b => b.textContent) }; tab.readonly = false; await closeTabByName("QA Actions Strip"); return { presentOnEveryTab, pillLabels, spendAgreesWithCard: { stripSimpleAfter, cardSimpleText }, afterNewRound, startedExpanded, collapsed, newRoundStillPressableCollapsed, persistedToLocalStorage, readonly }; })()

- **Expected:**

      { "presentOnEveryTab": { "overview": true, "skills": true, "kismet": true, "gear": true,
                                "augments": true, "magic": true, "decking": true, "rigging": true,
                                "actions": true, "notes": true },
        "pillLabels": ["Simple", "Reflex", "Melee exploit", "Decking exploit"],
        "spendAgreesWithCard": { "stripSimpleAfter": "1/2", "cardSimpleText": "1 / 2" },
        "afterNewRound": { "pool": 2, "actionsUsed": {}, "tabStayedOnGear": true },
        "startedExpanded": true, "collapsed": true, "newRoundStillPressableCollapsed": true,
        "persistedToLocalStorage": "collapsed",
        "readonly": { "hasNewRound": false, "miniCounters": 0,
                       "pillCounts": ["2/2", "1/1", "2/2", "1/1"] } }

- **Note:** Reported gap: in real play the action economy is consulted and
  spent constantly, but `actionsCard()` ("Actions This Round") rendered on
  Overview only — spending a Simple Action from Gear or Magic meant tabbing
  away and back, and `↻ New Round` (which also refills every pool) was
  equally stranded.

  Pools solve the same "visible from every tab" problem with two components —
  `headerPoolTile()` in `sheetHeader()` plus `compactPoolPill()` in
  `.sh-compact`, the latter surfacing only once an `IntersectionObserver` sees
  the header scroll away — because `.sheet-head` scrolls off by design
  (`style.css` ~590: *"the header no longer eats half a tablet screen"*).
  Actions doesn't need that split: `.sh-stickybar` is the one piece of chrome
  genuinely on screen at all times, so `actionsStrip()` mounts there directly,
  unconditionally — not gated on `.scrolled` the way `.sh-compact` is.
  `presentOnEveryTab` is the direct guard: every one of the ten `sheetTab`
  values must find `.sh-actions-strip` in the DOM.

  `actionRows()` and `newRound()` were pulled out of `actionsCard()` so the
  card and the strip read/write the exact same `CHAR.play.actions_used` keys
  in the exact same order — never a second source of truth.
  `spendAgreesWithCard` presses `+` on the strip's Simple pill and confirms
  the Overview card shows the same `left / total` afterward. `afterNewRound`
  presses `↻ New Round` from the **Gear** tab and checks both halves of what
  a fresh round means: every pool refills (`poolState("Brawn").remaining`
  back to its max) and `actions_used` clears — while `sheetTab` itself stays
  put (`tabStayedOnGear`), unlike clicking a header pool tile, which forces a
  jump to Overview.

  Recoil/Stabilize, the exploit source attributions, and the "Enable action
  costs in loadout" checkbox stay Overview-only by design — settled choices
  and reference detail, not per-round counters worth a permanent strip of
  screen on ten tabs. `pillLabels` guards that the strip carries exactly
  Simple, Reflex and the granted exploit kinds, nothing more.

  The strip is collapsible (`localStorage`, key `sinless:actionstrip` — a
  screen-real-estate preference, not a fact about the character, so it isn't
  `CHAR.play.*`) and `↻ New Round` stays pressable while folded
  (`newRoundStillPressableCollapsed`) — it is the once-a-round button, the one
  thing folding must never hide. `readonly` confirms a shared read-only
  character still shows every count (`pillCounts`) with every mutating
  control gone (`hasNewRound` false, no `.mini-btn`s) — the same gate
  `actionsCard()` already applies via `activeTabObj().readonly`.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-053: A pool tile's temp row folds away at 0, never while it's live, and reopens on demand
- **Type:** correctness
- **Steps:** none.
- **Check:**

      (async () => { const c = RULES.defaultCharacter(); c.name = "QA Temp Collapse"; c.priorities = { heritage: 2, magic: 0, attributes: 3, skills: 2, resources: 3 }; c.heritage.type = "Human"; c.finalized = true; c.lifestyles = [{ name: "Squatter", months: 1 }]; await openCharacter(c); sheetTab = "overview"; renderSheet(); const boostRow = () => document.querySelector(".sh-pool.brawn .sh-pool-boost"); const startsCollapsed = boostRow().classList.contains("collapsed"); const collapsedText = boostRow().textContent; boostRow().click(); const afterClickOpen = !boostRow().classList.contains("collapsed"); const hasButtons = boostRow().querySelectorAll("button").length; const expandedPoolAfterToggle = expandedPool; const foldBtn = [...boostRow().querySelectorAll("button")].find(b => b.textContent === "▴"); foldBtn.click(); const afterFoldCollapsed = boostRow().classList.contains("collapsed"); poolState("Brawn").setBoost(2); renderSheet(); const autoExpandsWithLiveBoost = !boostRow().classList.contains("collapsed"); const noFoldButtonWhileLive = ![...boostRow().querySelectorAll("button")].some(b => b.textContent === "▴"); const hasResetButtonWhileLive = [...boostRow().querySelectorAll("button")].some(b => b.textContent === "↺"); poolState("Brawn").setBoost(0); renderSheet(); const collapsesAgainAfterReset = boostRow().classList.contains("collapsed"); const tab = activeTabObj(); tab.readonly = true; renderSheet(); const readonlyStillCollapsedByDefault = boostRow().classList.contains("collapsed"); tab.readonly = false; await closeTabByName("QA Temp Collapse"); return { startsCollapsed, collapsedText, afterClickOpen, hasButtons, expandedPoolAfterToggle, afterFoldCollapsed, autoExpandsWithLiveBoost, noFoldButtonWhileLive, hasResetButtonWhileLive, collapsesAgainAfterReset, readonlyStillCollapsedByDefault }; })()

- **Expected:**

      { "startsCollapsed": true, "collapsedText": "temp +0 ▸", "afterClickOpen": true,
        "hasButtons": 3, "expandedPoolAfterToggle": null, "afterFoldCollapsed": true,
        "autoExpandsWithLiveBoost": true, "noFoldButtonWhileLive": true,
        "hasResetButtonWhileLive": true, "collapsesAgainAfterReset": true,
        "readonlyStillCollapsedByDefault": true }

- **Note:** Follow-on from slimming the header (2026-08-18): the "temp" boost
  row's three `−`/`+`/`↺` buttons cost a hard 32px each under the coarse-
  pointer tap-target floor (JC-017), on all four pool tiles, all the time —
  most tables never touch it, since a nonzero boost is the exception, not the
  rule. `poolBoostRow()` folds it to one plain text line
  (`"temp +0 ▸"`, no buttons, so the 32px floor doesn't apply) whenever a
  pool's boost is 0 and nobody's asked to see it.

  `startsCollapsed`/`collapsedText` are the default state. `afterClickOpen`/
  `hasButtons` confirm a click reveals the real row (3 buttons: `−`, `+`, and
  `▴` in the reset slot, since there's nothing to reset at 0).
  `expandedPoolAfterToggle` stays `null` — the click must not also bubble to
  the tile itself and pop the Skills panel open, the same `stopPropagation()`
  guard the always-expanded row already used. `afterFoldCollapsed` confirms
  `▴` folds it back — opening it to look and changing your mind isn't a
  one-way door.

  `autoExpandsWithLiveBoost` is the guard that matters most: the row must
  **never** be collapsible while a boost is actually live — hiding an active
  temporary bonus or penalty would be actively misleading, not just
  cosmetic. `noFoldButtonWhileLive` confirms there's no way to fold it away in
  that state, and `hasResetButtonWhileLive` confirms the reset button is back
  in that slot (it has something to do again). `collapsesAgainAfterReset`
  closes the loop: setting boost back to 0 folds the row automatically,
  without needing the player to fold it by hand. `readonlyStillCollapsedByDefault`
  is a plain sanity check that read-only doesn't force it open — the
  existing `body.sheet-readonly .sh-pool-boost{pointer-events:none}` rule
  already covers both states of the row, collapsed or not, since `.collapsed`
  is an added class on the same element rather than a different one.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-054: All three conditional-effect sources resolve together, and the tiles agree with themselves
- **Type:** correctness
- **Steps:** load `wildling-pools.json` and enter play mode.
- **Check:**

      (async () => { setPoolEffect(RULES.WILDLING_EFFECT_ID, true); await recalc(); sheetTab = "overview"; renderSheet(); const tiles = [...document.querySelectorAll(".sh-head-pools > *")].map(t => t.innerText.replace(/\n+/g, " | ").trim()); const sums = {}; for (const pool of RULES.POOL_NAMES) { const st = poolState(pool); sums[pool] = { base: CALC.pools[pool], mod: st.beast, max: st.max, adds: CALC.pools[pool] + st.beast === st.max }; } const sources = CALC.pool_effects.map(e => e.source); return { sources, sums, focusLines: tiles[2] }; })()

- **Expected:** `sources` is
  `["Heritage","Augment","Gear","Gear","Gear"]`. Every entry in `sums` has
  `adds: true`, with `max` of **21 / 19 / 14 / 7** for Brawn / Finesse / Focus /
  Resolve over a **11 / 9 / 7 / 8** base. `focusLines` reads

      ◈ 0 | FOCUS | 14 / 14 | − | + | ↺ | TEMP | + | ⚡ Wildling −3 | ⚡ Cram ×3 +6 | ⚡ Sixgun +4

- **Note:** The `×3 +6` on the Cram line is the assertion, not decoration.
  `poolTile` used to print the **per-dose** figure (`⚡ Cram +2`) while
  `poolEffectMod` multiplied by the number counting, so a tile's own breakdown
  did not add up to the total printed directly above it — 7 − 3 + 2 + 4 = 10
  against a displayed 14 — and the line's tooltip claimed *"this is already in
  the number above"*. Fixed 2026-08-19; see
  [`../findings/2026-08-19-P06.md`](../findings/2026-08-19-P06.md) NEW-001. If
  this case regresses, the Running Now panel will still be right, so the two
  surfaces will disagree on one screen rather than both being wrong.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-055: A shift that shrinks a pool clamps what is spent without writing it off
- **Type:** correctness
- **Steps:** load `wildling-pools.json` and enter play mode.
- **Check:**

      (async () => { setPoolEffect(RULES.WILDLING_EFFECT_ID, false); await recalc(); CHAR.play.pool_used = { Resolve: 9 }; const read = () => { const st = poolState("Resolve"); return { max: st.max, used: st.used, remaining: st.remaining, stored: CHAR.play.pool_used.Resolve }; }; const off = read(); setPoolEffect(RULES.WILDLING_EFFECT_ID, true); await recalc(); const shifted = read(); setPoolEffect(RULES.WILDLING_EFFECT_ID, false); await recalc(); return { off, shifted, backOut: read() }; })()

- **Expected:**

      { "off":      { "max": 10, "used": 9, "remaining": 1, "stored": 9 },
        "shifted":  { "max":  7, "used": 7, "remaining": 0, "stored": 9 },
        "backOut":  { "max": 10, "used": 9, "remaining": 1, "stored": 9 } }

- **Note:** Wildling is the **only** source of negative pool dice in the data,
  so this path is unreachable from any other fixture. `used` reads 7 while
  shifted because `poolState` clamps for display, but `play.pool_used.Resolve`
  stays 9 — dice a shift takes away are not spent, and shifting back out
  returns them. A `setUsed` that wrote the clamp down would pass the `shifted`
  line and fail `backOut`, which is the whole point of asserting all three.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-056: Doses stack to their cap and stop, and one dismiss removes one dose
- **Type:** correctness
- **Steps:** load `wildling-pools.json` and enter play mode.
- **Check:**

      (async () => { const play = CHAR.play; const orig = JSON.parse(JSON.stringify(play.doses)); const set = n => { play.doses = Array.from({ length: n }, (_, i) => ({ uid: `c${i}`, name: "Cram" })).concat([{ uid: "sg", name: "Sixgun" }]); return poolState("Focus").beast; }; const stacking = { "1": set(1), "3": set(3), "4": set(4), "5": set(5), "6": set(6) }; play.doses = orig; await recalc(); renderSheet(); document.querySelector(".sh-running").click(); await new Promise(r => setTimeout(r, 80)); const before = poolState("Focus").max; [...document.querySelectorAll(".sh-popover button")].find(b => /Dismiss dose 2 of 3/.test(b.title)).click(); await new Promise(r => setTimeout(r, 140)); const pop = document.querySelector(".sh-popover"); return { stacking, dismissed: { left: play.doses.map(d => d.uid), focus: [before, poolState("Focus").max], popoverStillOpen: !!pop, cramLine: pop && pop.innerText.split("\n").find(l => /^Cram/.test(l)) } }; })()

- **Expected:**

      { "stacking": { "1": 6, "3": 10, "4": 12, "5": 12, "6": 12 },
        "dismissed": { "left": ["qa-dose-1-cram","qa-dose-3-cram","qa-dose-4-sixgun","qa-dose-5-kamakazi"],
                       "focus": [17, 15], "popoverStillOpen": true, "cramLine": "Cram ×2" } }

- **Note:** Sixgun's +4 is in every `stacking` reading, so the Cram half is
  6/10/12/12/12 minus 4 → 2/6/8/8/8, clamping at `Max Doses` 4. Sixgun is also
  the `parsePoolDice` first-clause-wins case: its text carries both `+4d Focus`
  and a `-2d Focus` withdrawal clause, and a parser that netted the two would
  make every row here 6 lower.

  The `dismissed` half is the R2 refresh contract — the popover lives outside
  the `#sheet` subtree `playChanged` rebuilds, so it must be refreshed by hand.
  `popoverStillOpen: true` with `cramLine: "Cram ×2"` proves it updated in
  place rather than closing or going stale. **`left` is load-bearing**: dose 2
  goes and doses 1 and 3 stay. Removing by uid means a dose list written without
  uids matched `undefined !== undefined` for every row and one click emptied it
  (findings 2026-08-19 NEW-002); `dismissDose` now falls back to dropping the
  first uid-less entry.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-057: Shifting heals physical damage only, and the Running Now popover survives its own scrollbar
- **Type:** correctness
- **Steps:** load `wildling-pools.json` (3 physical / 2 stun as shipped) and enter play mode. Stub `alert` per P00 §3.
- **Check:**

      (async () => { window.__alerts = []; setPoolEffect(RULES.WILDLING_EFFECT_ID, false); CHAR.play.physical_damage = 3; CHAR.play.stun_damage = 2; await recalc(); setPoolEffect(RULES.WILDLING_EFFECT_ID, true); await new Promise(r => setTimeout(r, 60)); const healed = { phys: CHAR.play.physical_damage, stun: CHAR.play.stun_damage, beast: CHAR.play.beast_dice, alert: window.__alerts.at(-1) }; renderSheet(); document.querySelector(".sh-running").click(); await new Promise(r => setTimeout(r, 80)); const pop = document.querySelector(".sh-popover"); const scrolls = pop.scrollHeight > pop.clientHeight; pop.scrollTop = 40; pop.dispatchEvent(new Event("scroll", { bubbles: true })); await new Promise(r => setTimeout(r, 60)); return { healed, scrolls, stillOpenAfterInnerScroll: !!document.querySelector(".sh-popover") }; })()

- **Expected:** `healed.phys` is **0 to 2** (1d6 against 3, floored at 0),
  `healed.stun` is still **2**, `healed.beast` is **6**, and `healed.alert`
  matches `/^Beast Form heals you\. Physical −3 \(rolled \d\)\.$/` when the
  roll covered it. `scrolls` and `stillOpenAfterInnerScroll` are both `true`.
- **Note:** The heal is a die roll, so this is the one case here without a fixed
  expected number — assert the range and that **stun did not move**, which is
  the half that has been wrong before (#67 heals wounds, not stun). A fresh
  shift also refreshes Beast dice to 6.

  The scroll half is a regression guard for a bug this panel exposed rather than
  caused: `openAnchoredPopover` bound `scroll` on `window` in the **capture**
  phase, which fires for scrolls on descendants too. No earlier popover scrolled
  internally; this one does, and it would have shut under the reader's finger.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-058: Running Now carries the deck, and reads the deck you are actually jacked into
- **Type:** correctness
- **Steps:** any tab. Escape first, so a popover left open by an earlier case
  isn't toggled shut by this one's click.
- **Check:**

      (async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await new Promise(r => setTimeout(r, 60)); const c = RULES.defaultCharacter(); c.name = "QA MCP Box"; c.priorities = { heritage: 2, magic: 0, attributes: 3, skills: 2, resources: 3 }; c.heritage.type = "Human"; c.decks = [{ name: "MasterDeck", mods: [], hacking: "Hacking 2" }]; c.programs = ["Analysis Locus 1"]; c.hacking_rating = 2; c.finalized = true; c.lifestyles = [{ name: "Squatter", months: 1 }]; await openCharacter(c); sheetTab = "overview"; renderSheet(); const lineOf = () => [...document.querySelectorAll(".sh-running .sh-fold-sum")].map(d => d.textContent).at(-1); const chargen = { deck: runningDeckInfo().name, mcp: runningDeckInfo().max, line: lineOf() }; CHAR.play.purchases.decks.push({ name: "Shingo Activa", mods: [], hacking: "Hacking 2" }); CHAR.play.decking.active_deck = "Shingo Activa"; CHAR.play.decking.loaded = ["Analysis Locus 1"]; CHAR.play.mcp_dice = 2; await playChangedRecalc(); renderSheet(); const boughtInPlay = { info: runningDeckInfo(), staleEngineAnswer: RULES.equippedDeckName(CHAR), line: lineOf() }; document.querySelector(".sh-running").click(); await new Promise(r => setTimeout(r, 200)); const pop = document.querySelector(".sh-popover"); const deckGroup = pop.innerText.split("\n").slice(pop.innerText.split("\n").indexOf("DECK")).join(" | "); const mini = [...pop.querySelectorAll(".sh-mini")][0]; mini.querySelectorAll(".mini-btn")[1].click(); await new Promise(r => setTimeout(r, 140)); const afterPlus = { stored: CHAR.play.mcp_dice, chip: document.querySelector(".sh-popover").innerText.split("\n").find(l => /^MCP dice/.test(l)) }; document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); const mundane = (() => { CHAR.play.purchases.decks.length = 0; CHAR.decks = []; CHAR.play.kit.decks = []; renderSheet(); return { info: runningDeckInfo(), summaryLines: document.querySelectorAll(".sh-running .sh-fold-sum").length }; })(); await closeTabByName("QA MCP Box"); return { chargen, boughtInPlay, deckGroup, afterPlus, mundane }; })()
- **Expected:**

      { "chargen": { "deck": "MasterDeck", "mcp": 3,
                     "line": "🖧 MasterDeck · MCP 3/3 · nothing loaded" },
        "boughtInPlay": {
          "info": { "name": "Shingo Activa", "max": 5, "left": 2, "threads": 5,
                    "loaded": ["Analysis Locus 1"] },
          "staleEngineAnswer": "MasterDeck",
          "line": "🖧 Shingo Activa · MCP 2/5 · 1 loaded: Analysis Locus 1" },
        "deckGroup": "DECK | Shingo Activa jacked in | MCP dice 2 / 5 | − | + | ↻ | Loaded 1 / 5 | Analysis Locus 1",
        "afterPlus": { "stored": 3, "chip": "MCP dice 3 / 5" },
        "mundane": { "info": null, "summaryLines": 1 } }

- **Note:** `staleEngineAnswer` is the load-bearing field, and it is expected to
  be **wrong on purpose**: `RULES.equippedDeckName` reads `character.decks`, and
  the engine calls it on the FOLDED character (kit + play purchases) where that
  is the right list. Called with the raw `CHAR` — which is what `mcpDiceMax`
  used to do — it reads the CHARGEN record, so a deck bought in play is not in
  the list at all and the "nobody chose" fallback quietly returns the first
  chargen deck. The whole MCP feature was reading the wrong machine: the chip on
  the Decking tab, and the dice a Run actually spent, came off MasterDeck (MCP
  3) while the character was jacked into a Shingo Activa (MCP 5). The sheet now
  derives it from `ownedDecks()` (`activeDeckName`), which is the same list the
  Decking tab picks the active deck from, so the two cannot disagree. If
  `boughtInPlay.info.max` ever equals `chargen.mcp`, the CHAR-vs-folded mistake
  is back.

  The rest is the Running Now deck group itself. The line on the card's face is
  a SEPARATE summary line, never folded into the effect bits, because a
  jacked-in deck is not a switched-on effect and must not make the card read
  "warn" or raise its count. `mundane.summaryLines` is 1 — a character with no
  deck sees no deck line at all, which is most characters.

  `afterPlus` is the counter: MCP is adjustable from the popover as well as the
  Decking tab, because a program run away from the sheet's own Run button still
  spends cycles. The pill is bare −/+ with no number between them, the same
  shape the action pills use — the chip one gap away is already showing the
  figure, and printing it twice side by side invites the two to disagree. It has to prove the popover REDREW — it lives on document.body,
  so `playChanged`'s re-render of `#sheet` leaves it showing the old count
  unless the setter calls the popover's own `refresh`. A stale `"MCP dice 2 / 5"`
  in `afterPlus.chip` against a `stored` of 3 is that bug. The face carries no
  controls at all (touch targets inflate the header — see runningNowPanel), and
  a read-only shared tab gets the chips without the counter.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-059: A deck can be jacked out — still owned, still carried, not running
- **Type:** correctness
- **Steps:** load `decker-two-decks.json` (Fujitsu Edge active, two programs
  loaded) and enter play mode. Stub `alert`/`confirm` per P00 §3.
- **Check:**

      (async () => { sheetTab = "decking"; renderSheet(); const snap = () => ({ equipped: RULES.equippedDeckName(CHAR), mcp: mcpDiceMax(), deckingExploits: (((CALC.combat || {}).exploit_actions) || []).filter(a => a.kind === "Decking").map(a => a.count)[0] || 0, gearZr: CALC.zoetics.gear_zr, loaded: CHAR.play.decking.loaded.length, programsOwned: ownedPrograms().length, allCarried: ownedDecks().every(e => e.ref.carried !== false), owned: ownedDecks().length, errors: CALC.errors.length }); const jackedIn = snap(); [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Jack out").click(); await new Promise(r => setTimeout(r, 300)); const jackedOut = snap(); const chip = [...document.querySelectorAll(".chip")].map(c => c.textContent).find(t => /^Loaded/.test(t)); window.__alerts = []; [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Load").click(); const refused = { alert: window.__alerts[0] || null, loaded: CHAR.play.decking.loaded.length }; sheetTab = "overview"; renderSheet(); const runningSummaryLines = document.querySelectorAll(".sh-running .sh-fold-sum").length; sheetTab = "decking"; renderSheet(); [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Jack in").click(); await new Promise(r => setTimeout(r, 300)); const backIn = snap(); return { jackedIn, jackedOut, chip, refused, runningSummaryLines, backIn }; })()

- **Expected:**

      { "jackedIn":  { "equipped": "Fujitsu Edge", "mcp": 8, "deckingExploits": 3,
                       "gearZr": 3, "loaded": 2, "programsOwned": 6,
                       "allCarried": true, "owned": 2, "errors": 0 },
        "jackedOut": { "equipped": "",             "mcp": 0, "deckingExploits": 0,
                       "gearZr": 3, "loaded": 0, "programsOwned": 6,
                       "allCarried": true, "owned": 2, "errors": 0 },
        "chip": "Loaded — · jacked out",
        "refused": { "alert": "No deck is running — jack into one to load a program onto its threads.",
                     "loaded": 0 },
        "runningSummaryLines": 1,
        "backIn": { "equipped": "Fujitsu Edge", "mcp": 8, "deckingExploits": 3,
                    "gearZr": 3, "loaded": 0, "programsOwned": 6,
                    "allCarried": true, "owned": 2, "errors": 0 } }

- **Note:** Jacking out is a third state, distinct from the two that already
  existed: selling the deck (gone) and un-ticking carried (left at home). The
  line the expected values draw is which numbers move and which do not.

  **Move:** `equipped` empties, so the deck's cores grant no Decking exploit
  actions and there is no MCP reserve to spend; `loaded` goes to 0, because
  pulling the jack drops the threads (`RULES.jackOutDeck` — the one function
  behind both the play sheet's button and the chargen picker's "none" option,
  so the two can't drift); the Running Now card loses its deck line
  (`runningSummaryLines` back to 1); and a Load press is refused with a reason
  rather than the "all threads are in use" message meant for a full deck.

  **Do not move:** `owned` and `allCarried` — the decks are still on the
  character — `programsOwned` stays 6, since unloading a program frees a thread
  and never sells anything, and `gearZr` stays 3, because gear ZR counts every
  CARRIED deck rather than the running one. A jacked-out decker who suddenly got
  lighter, or lost programs, would mean the flag had been wired to the wrong
  list.

  The flag is stored (`play.decking.jacked_out`) rather than encoded as an empty
  `active_deck`, because "" already means "never chose" and must keep resolving
  to the first owned deck — otherwise every character who never opened this tab
  would silently stop running theirs. A save written before the flag existed
  therefore keeps running its deck, and the remembered choice survives the trip
  out and back: `backIn` returns to Fujitsu Edge without being re-picked.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-060: Running a program says which dice it already took
- **Type:** correctness
- **Steps:** load `decker-two-decks.json` and enter play mode. Stub
  `alert`/`confirm` per P00 §3.
- **Check:**

      (async () => { const r = DATA.tables.programs.find(x => x.Name === "Analysis Locus 1"); const read = () => { const p = document.querySelector(".sh-roller"); return { poolRow: p.querySelector(".sh-roller-poolrow").innerText.split("\n").pop(), select: p.querySelector(".sh-roller-pool").value }; }; CHAR.play.mcp_dice = 8; CHAR.play.pool_used = {}; renderSheet(); runProgram("Analysis Locus 1", r); await new Promise(x => setTimeout(x, 200)); const mcpPays = { ...read(), mcpLeft: mcpDiceLeft(), focusLeft: poolState("Focus").remaining }; document.querySelector(".sh-roller-close").click(); CHAR.play.mcp_dice = 1; CHAR.play.pool_used = {}; renderSheet(); runProgram("Analysis Locus 1", r); await new Promise(x => setTimeout(x, 200)); const focusPays = { ...read(), mcpLeft: mcpDiceLeft(), focusLeft: poolState("Focus").remaining, focusUsed: CHAR.play.pool_used.Focus }; document.querySelector(".sh-roller-close").click(); openPoolRoller({ dice: 5, label: "QA plain roll", note: "no caller settled anything" }); await new Promise(x => setTimeout(x, 150)); const plainRoll = read(); document.querySelector(".sh-roller-close").click(); return { mcpPays, focusPays, plainRoll }; })()

- **Expected:**

      { "mcpPays":   { "poolRow": "already paid: 4 MCP", "select": "",
                       "mcpLeft": 4, "focusLeft": 9 },
        "focusPays": { "poolRow": "already paid: 1 MCP + 3 Focus", "select": "",
                       "mcpLeft": 0, "focusLeft": 6, "focusUsed": 3 },
        "plainRoll": { "poolRow": "no pool spent", "select": "" } }

- **Note:** Reported as "Run isn't charging the Focus pool — it defaults to no
  Pool". The charge was landing all along (`focusPays` proves it: Focus 9 → 6
  and `pool_used.Focus` 3); what was wrong was the roller *saying so*. #79
  settles both resources BEFORE opening the roller — it has to, because the
  roller bills exactly one pool and a run drains two in a fixed order — and it
  therefore opens pool-less, so the pool row read **"no pool spent"** two lines
  above a note reading "paid 1 MCP + 3 Focus". The sheet was contradicting
  itself about the player's own dice, and the reading that stuck was the one in
  the bigger control.

  So the roller now takes a `prepaid` string and states it. The three cases are
  the three things that can be true: MCP alone covered it (Focus untouched at
  9), MCP ran out and Focus paid the rest, and a plain roll opened afterwards —
  which must read "no pool spent" again, because `prepaid` is written on every
  open and never inherited. A `plainRoll.poolRow` still claiming "already paid"
  is that leak.

  `select` stays `""` in all three: the row explains, it does not silently pick
  a pool. Picking one there would spend the same dice a second time, which is
  what the option's own tooltip now warns.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-061: A month passes, and can be taken back whole
- **Type:** correctness
- **Steps:** load `kitchen-sink-final.json` and enter play mode. Stub
  `alert`/`confirm` per P00 §3 (the case answers the undo confirm).
- **Check:**

      (async () => { CHAR.play.purchases.gear.push({ name: "Gel", qty: 8, carried: true, carried_qty: 8 }); CHAR.play.calendar.start = { month: 12, year: 2070 }; await playChangedRecalc(); sheetTab = "notes"; renderSheet(); await new Promise(r => setTimeout(r, 150)); const snap = () => ({ now: calendarLabel(calendarNow()), elapsed: CHAR.play.calendar.months_elapsed, entries: CHAR.play.calendar.entries.length, low: (CHAR.play.lifestyles.find(l => l.name === "Low") || {}).months, active: (CHAR.play.lifestyles.find(l => l.active) || {}).name, ap: (ownedAmmoStacks().find(a => a.name === "AP") || {}).qty, gel: (ownedAmmoStacks().find(a => a.name === "Gel") || {}).qty, cash: CHAR.play.cash }); const before = snap(); [...document.querySelectorAll("button")].find(b => /Time Passes/.test(b.textContent)).click(); await new Promise(r => setTimeout(r, 250)); const m = document.querySelector(".sh-cal-modal"); const title = m.querySelector("h3").textContent; const tas = m.querySelectorAll("textarea"); tas[0].value = "Ghost run on Renraku sublevel"; tas[1].value = "Legwork — mapped the grid"; const rows = [...m.querySelectorAll(".sh-cal-ammo-row")]; rows[0].querySelectorAll("input")[0].click(); rows[1].querySelectorAll("input")[1].click(); const faImpliesUsed = rows[1].querySelectorAll("input")[0].checked; [...m.querySelectorAll("button")].find(b => /Advance the month/.test(b.textContent)).click(); await new Promise(r => setTimeout(r, 400)); const after = snap(); const entry = CHAR.play.calendar.entries[0]; const logged = CHAR.play.cash_log.slice(0, 3).map(e => e.label); document.querySelector(".sh-cal-entry button").click(); await new Promise(r => setTimeout(r, 400)); const undone = snap(); return { title, faImpliesUsed, before, after, entry: { month: entry.month, year: entry.year, lifestyle: entry.lifestyle, ammo: entry.ammo }, logged, undone }; })()

- **Expected:**

      { "title": "Time Passes — December 2070 → January 2071",
        "faImpliesUsed": true,
        "before": { "now": "December 2070", "elapsed": 0, "entries": 0, "low": 2,
                    "active": "Low", "ap": 20, "gel": 8, "cash": 1500 },
        "after":  { "now": "January 2071", "elapsed": 1, "entries": 1, "low": 1,
                    "active": "Low", "ap": 19, "gel": 6, "cash": 1500 },
        "entry": { "month": 12, "year": 2070,
                   "lifestyle": { "name": "Low", "spent_month": true, "bought": false, "cost": 0 },
                   "ammo": [{ "name": "AP", "used": 1, "fa": false },
                            { "name": "Gel", "used": 2, "fa": true }] },
        "logged": ["Used 2 Gel — 6 left", "Used 1 AP — 19 left",
                   "Sector turn: 1 month of Low lifestyle"],
        "undone": { "now": "December 2070", "elapsed": 0, "entries": 0, "low": 2,
                    "active": "Low", "ap": 20, "gel": 8, "cash": 1500 } }

- **Note:** `undone` is `before` — that is the whole case. A month costs four
  separate things (a lifestyle month, two ammunition stacks at different rates,
  the date itself) written through four different mechanisms, and Undo has to
  put every one of them back or the sheet quietly drifts from the table's idea
  of what happened.

  The entry is dated **December** while the clock now reads January: an entry
  records the month that CLOSED, not the one you are in. `used: 2` for Gel with
  `fa: true` is the FA rule — a burst spends two — and `faImpliesUsed` guards the
  half of it a player will hit by accident: ticking only the second box still
  means the round was fired.

  `logged` proves the month went through the existing ledger rather than a
  private log of its own: `adjustOwned` wrote the two ammunition lines (so a
  stack that ran out mid-month records what actually came off it) and the
  lifestyle line is a zero-cash `lifestyle_adjust`, undoable from the Activity
  card too. `cash` never moves here because the month was prepaid; the buy-a-
  month path is the one that charges, and its undo refunds.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-062: The three ways a month's lifestyle gets covered
- **Type:** correctness
- **Steps:** continues from P06-061 (same character, month back at December 2070).
- **Check:**

      (async () => { const pick = async (setup, choose) => { await setup(); await playChangedRecalc(); renderSheet(); await new Promise(r => setTimeout(r, 150)); [...document.querySelectorAll("button")].find(b => /Time Passes/.test(b.textContent)).click(); await new Promise(r => setTimeout(r, 250)); const m = document.querySelector(".sh-cal-modal"); const radios = [...m.querySelectorAll("input[type=radio]")]; const shape = radios.map(r => ({ v: r.value, disabled: r.disabled })); choose(m, radios); [...m.querySelectorAll("button")].find(b => /Advance the month/.test(b.textContent)).click(); await new Promise(r => setTimeout(r, 400)); const e = CHAR.play.calendar.entries[0]; const out = { shape, lifestyle: e.lifestyle, cash: CHAR.play.cash, lifestyles: CHAR.play.lifestyles.map(l => `${l.name}:${l.months}${l.active ? "*" : ""}`) }; document.querySelector(".sh-cal-entry button").click(); await new Promise(r => setTimeout(r, 400)); return out; }; const buy = await pick(async () => { CHAR.play.lifestyles.find(l => l.name === "Low").months = 0; CHAR.play.cash = 1500; }, (m, radios) => { radios.find(r => r.value === "buy").checked = true; m.querySelector("select").value = "Low"; }); const squat = await pick(async () => { CHAR.play.lifestyles = []; }, (m, radios) => { radios.find(r => r.value === "squatter").checked = true; }); return { buy, squat, cashAfterUndo: CHAR.play.cash }; })()

- **Expected:**

      { "buy": { "shape": [{ "v": "spend:Low", "disabled": true },
                           { "v": "buy", "disabled": false },
                           { "v": "squatter", "disabled": false }],
                 "lifestyle": { "name": "Low", "spent_month": true, "bought": true, "cost": 300 },
                 "cash": 1200, "lifestyles": ["Low:0*"] },
        "squat": { "shape": [{ "v": "buy", "disabled": false },
                             { "v": "squatter", "disabled": false }],
                   "lifestyle": { "name": "Squatter", "spent_month": false, "bought": false, "cost": 0 },
                   "cash": 1500, "lifestyles": ["Squatter:0*"] },
        "cashAfterUndo": 1500 }

- **Note:** The dialog will not advance a month nobody paid for, and these are
  the only three ways to pay: spend a prepaid month, buy one now, or live rough.
  A lifestyle with nothing left on it renders **disabled** rather than absent —
  it is still the character's lifestyle, it just can't cover this month.

  A bought month is added and then spent, which is why `lifestyles` reads
  `Low:0` afterwards: two ledger rows (a charged "Prepaid 1 month" and a
  zero-cash "Sector turn"), each undoable on its own from the Activity card, and
  the month count ends where a player would expect to find it. `cashAfterUndo`
  is the half worth watching — undoing the month has to hand the ㄓ300 back.

  Squatter is the floor, and taking it ADDS Squatter to `play.lifestyles` marked
  active, so the header's lifestyle select, the Gear tab's lifestyle card and the
  calendar all describe the same month.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-063: A mission's Kismet and payout land on the character, and come back with the month
- **Type:** correctness
- **Steps:** load `kitchen-sink-final.json` and enter play mode. Stub
  `alert`/`confirm` per P00 §3 — the case reads an alert and answers a confirm.
- **Check:**

      (async () => { CHAR.play.calendar.start = { month: 12, year: 2070 }; await playChangedRecalc(); sheetTab = "notes"; renderSheet(); await new Promise(r => setTimeout(r, 150)); const snap = () => ({ kismet: CHAR.play.kismet, lifetime: CHAR.play.kismet_earned, cash: CHAR.play.cash, entries: CHAR.play.calendar.entries.length }); const before = snap(); [...document.querySelectorAll("button")].find(b => /Time Passes/.test(b.textContent)).click(); await new Promise(r => setTimeout(r, 250)); const m = document.querySelector(".sh-cal-modal"); const ta = m.querySelectorAll("textarea")[0]; const emptyHint = !!m.querySelector(".sh-cal-award-row"); ta.value = "Ghost run on Renraku sublevel\nEscort the fixer to Sector 9"; ta.dispatchEvent(new Event("input", { bubbles: true })); await new Promise(r => setTimeout(r, 100)); const rows = [...m.querySelectorAll(".sh-cal-award-row")]; const set = (row, idx, v) => { const i = row.querySelectorAll("input")[idx]; i.value = String(v); i.dispatchEvent(new Event("input", { bubbles: true })); }; set(rows[0], 0, 3); set(rows[0], 1, 5000); set(rows[1], 0, 1); ta.value = "Ghost run on Renraku sublevel (Renraku)\nEscort the fixer to Sector 9"; ta.dispatchEvent(new Event("input", { bubbles: true })); await new Promise(r => setTimeout(r, 100)); const keptWhileTyping = [...m.querySelectorAll(".sh-cal-award-row")].map(r => [...r.querySelectorAll("input")].map(i => i.value)); [...m.querySelectorAll("button")].find(b => /Advance the month/.test(b.textContent)).click(); await new Promise(r => setTimeout(r, 400)); const after = snap(); const awards = CHAR.play.calendar.entries[0].awards; const tagged = { kismet: CHAR.play.kismet_log.filter(r => r.cal).map(r => r.label), cash: CHAR.play.cash_log.filter(r => r.cal).map(r => r.label) }; const spent = CHAR.play.kismet; CHAR.play.kismet = 0; renderSheet(); await new Promise(r => setTimeout(r, 120)); window.__alerts = []; document.querySelector(".sh-cal-entry button").click(); await new Promise(r => setTimeout(r, 300)); const refused = { alert: window.__alerts[0], entries: CHAR.play.calendar.entries.length, lifetime: CHAR.play.kismet_earned }; CHAR.play.kismet = spent; renderSheet(); await new Promise(r => setTimeout(r, 120)); document.querySelector(".sh-cal-entry button").click(); await new Promise(r => setTimeout(r, 400)); const undone = snap(); return { awardsHiddenUntilTyped: !emptyHint, keptWhileTyping, before, after, awards, tagged, refused, undone }; })()

- **Expected:**

      { "awardsHiddenUntilTyped": true,
        "keptWhileTyping": [["3", "5000"], ["1", ""]],
        "before": { "kismet": 12, "lifetime": 30, "cash": 1500, "entries": 0 },
        "after":  { "kismet": 16, "lifetime": 34, "cash": 6500, "entries": 1 },
        "awards": [{ "mission": "Ghost run on Renraku sublevel (Renraku)", "kismet": 3, "cash": 5000 },
                   { "mission": "Escort the fixer to Sector 9", "kismet": 1, "cash": 0 }],
        "tagged": { "kismet": ["Escort the fixer to Sector 9 — Kismet award",
                               "Ghost run on Renraku sublevel (Renraku) — Kismet award"],
                    "cash":   ["Ghost run on Renraku sublevel (Renraku) — payout",
                               "Sector turn: 1 month of Low lifestyle"] },
        "refused": { "alert": "December 2070 can't be undone yet.\n\nThat award gave 4 Kismet and only 0 is still unspent. Undo what it paid for first, then undo the award.",
                     "entries": 1, "lifetime": 34 },
        "undone": { "kismet": 12, "lifetime": 30, "cash": 1500, "entries": 0 } }

- **Note:** Awards are attached to the MISSION, not to the month: the rows are
  built from the mission lines and each ledger entry is named after the run that
  paid it, which is the form the question takes later ("what did the Renraku job
  actually pay?"). `keptWhileTyping` guards the mechanism — the rows are rebuilt
  on every keystroke in the missions box and the numbers are held BY LINE INDEX,
  so a name still being typed doesn't drop the award beside it.

  `lifetime` is the load-bearing figure. Kismet goes through `awardKismet`, which
  raises the lifetime total as well as the balance — that total sizes the Kismet
  die pool and the boon milestones, so an award that only moved the balance would
  quietly cost the character a boon. Undo runs back through `undoKismetSpend` for
  the same reason.

  `refused` is the case that matters most: the month-undo asks
  `kismetUndoBlocker` FIRST and refuses as a whole when the awarded Kismet has
  already been spent. `entries` is still 1 and `lifetime` still 34 — nothing was
  half-undone. A version that reversed the ammunition and the lifestyle month and
  then stalled on the Kismet would leave the sheet in a state no one asked for.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Rules problems are visible from every tab

### P06-064: The Skillsoft/Chipjack cap survives Finalize, and the excess grants nothing
- **Type:** correctness
- **Steps:** load `kitchen-sink-final.json`. The check builds two copies and
  mutates neither the loaded character nor each other.
- **Check:**

      (() => { const base = JSON.parse(JSON.stringify(CHAR)); const strip = a => a.name !== "Chipjack" && !a.name.startsWith("Skillsoft") && !a.name.startsWith("Skillwires"); const build = jacks => { const c = JSON.parse(JSON.stringify(base)); c.play.kit.augments = [...c.play.kit.augments.filter(strip), { name: "Chipjack", count: jacks }, { name: "Skillwires 3", count: 1 }, { name: "Skillsoft 2", count: 1, target: "Archery" }, { name: "Skillsoft 2", count: 1, target: "Biotech" }]; return RULES.calculate(c); }; const one = build(1), two = build(2); return { overCap: { errors: one.errors, Archery: one.skills.Archery.final, Biotech: one.skills.Biotech.final }, legal: { errors: two.errors, Archery: two.skills.Archery.final, Biotech: two.skills.Biotech.final } }; })()

- **Expected:**

      { "overCap": { "errors": ["2 Skillsoft(s) slotted but only 1 Chipjack(s) installed."],
                     "Archery": 2, "Biotech": 0 },
        "legal":   { "errors": [], "Archery": 2, "Biotech": 2 } }

- **Note:** Two failures were fixed together in v336 and this case pins both.
  **The cap now grants nothing past the limit** — before, an over-cap Skillsoft
  still handed out its ranks and the engine merely logged a string, so `Biotech`
  would read 2 in the `overCap` arm. **And the error is now `bothWays`** rather
  than `errors.push`, so it survives Finalize: this is the one augment cap you
  can break *without installing anything* — sell a Chipjack in play and softs
  that were legal a moment ago are over the line. Reported at creation only, it
  was invisible in the exact mode where it becomes reachable.

  `Archery` holds at 2 in both arms: the cap truncates in list order, so the
  first slotted soft keeps its bonus and only the excess is dropped. The
  Skillsoft/Skillwires rating error moved to `bothWays` in the same change, for
  the same reason (a Skillwires module can be the thing that leaves).
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-065: The Attention chip rides the sticky bar on all ten tabs
- **Type:** UX
- **Steps:** load `kitchen-sink-final.json` and enter play mode. Mutates `CHAR`
  — reload the fixture afterwards.
- **Check:**

      (() => { const strip = a => a.name !== "Chipjack" && !a.name.startsWith("Skillsoft") && !a.name.startsWith("Skillwires"); CHAR.play.kit.augments = [...CHAR.play.kit.augments.filter(strip), { name: "Chipjack", count: 1 }, { name: "Skillwires 3", count: 1 }, { name: "Skillsoft 2", count: 1, target: "Archery" }, { name: "Skillsoft 2", count: 1, target: "Biotech" }]; CALC = RULES.calculate(CHAR); const tabs = {}; for (const [id] of sheetTabList()) { sheetTab = id; renderSheet(); const c = document.querySelector(".sh-validity-chip"); tabs[id] = { chip: c ? c.textContent : null, inStickyBar: !!(c && c.closest(".sh-stickybar")), card: !!document.querySelector(".sh-validity") }; } sheetTab = "augments"; renderSheet(); document.querySelector(".sh-validity-chip").click(); const box = document.querySelector('.sh-popover[data-popover="validity"]'); const pop = { role: box.getAttribute("role"), label: box.getAttribute("aria-label"), focusInside: box.contains(document.activeElement), rows: [...box.querySelectorAll(".sh-advrow")].map(r => r.textContent) }; document.querySelector(".sh-validity-chip").click(); const toggledShut = !document.querySelector('.sh-popover[data-popover="validity"]'); return { distinctChips: [...new Set(Object.values(tabs).map(t => t.chip))], everyTabSticky: Object.values(tabs).every(t => t.inStickyBar), cardTabs: Object.entries(tabs).filter(([, t]) => t.card).map(([id]) => id), pop, toggledShut }; })()

- **Expected:**

      { "distinctChips": ["Attention ✕ 1"],
        "everyTabSticky": true,
        "cardTabs": ["overview"],
        "pop": { "role": "dialog", "label": "Needs attention", "focusInside": true,
                 "rows": ["✕ 2 Skillsoft(s) slotted but only 1 Chipjack(s) installed."] },
        "toggledShut": true }

- **Note:** #88. "Needs attention" was an Overview card and nothing else, so the
  nine tabs where you actually break a rule — installing chrome past your Body,
  slotting a Skillsoft with no Chipjack, loading a deck over its MCP — said
  nothing at all. `cardTabs` is still `["overview"]` on purpose: the chip is a
  count and a severity colour, the card is the sentences, and the chip's popover
  carries the same rows from the same `validityRows()` so the two cannot drift.

  `everyTabSticky` is the load-bearing assertion. The chip rides
  `.sh-actions-strip` inside `.sh-stickybar`, which is live from the first render
  and does *not* wait for `.scrolled` the way `.sh-compact` does — a violation
  you can only see after scrolling would be the same bug in a smaller form. It
  also rides the strip folded (`actionsStripCollapsed = true`), because a rules
  violation doesn't stop mattering because you tidied the counters away.

  Absent entirely for a clean character: reload the fixture without the augment
  mutation and `document.querySelector(".sh-validity-chip")` is `null`.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Rigging: cores, seats and the guns on them

**Section setup.** Both cases below run against this rigger, built on top of
`kitchen-sink-final.json` in play mode. Run it once:

```js
(async () => { const p = CHAR.play.purchases, rg = CHAR.play.rigging; p.rigs.push({ name: "Master VCR", mods: [] }); rg.active_rig = "Master VCR"; [["Alpha","Mini Gun"],["Bravo","Autocannon"],["Charlie","Sentry Gun"],["Delta","Railgun"],["Echo","Recoilless Gun"]].forEach(([label, w]) => p.drones.push({ name: "Disc", label, weapons: [w], mods: [] })); for (let i = 0; i < 5; i++) rg.linked[`drones:${i}`] = true; for (let i = 0; i < 4; i++) rg.hotseat[`drones:${i}`] = true; CHAR.play.action_costs = true; await playChangedRecalc(); return { cap: hotseatCapacity(), dice: hotseatBonusDice(), deployed: deployedUnits().length }; })()
```

**Expected:** `{ "cap": 4, "dice": 6, "deployed": 5 }`

Five armed Discs on the link, four of them seated. **Unit weapons are stored as
bare name strings**, not `{name}` objects — the Rigging tab reads them raw, and
an object there renders as `[object Object]` with no stats.

### P06-066: Hotseat capacity is the VCR's cores, and a downgrade truncates it
- **Type:** correctness
- **Check:**

      (() => { const rig = n => RULES.rigStats({ name: n, mods: [] }, DATA.tables); const seats = () => deployedUnits().filter(d => d.hotseat).map(d => d.u.label); const rg = CHAR.play.rigging; const use = n => { CHAR.play.purchases.rigs = [{ name: n, mods: [] }]; rg.active_rig = n; }; const out = { cores: DATA.tables.rigs.map(r => ({ rig: r["Rig Type"], cores: rig(r["Rig Type"]).cores, coreCount: rig(r["Rig Type"]).coreCount, bonusDice: rig(r["Rig Type"]).bonusDice })) }; out.master = { cap: hotseatCapacity(), dice: hotseatBonusDice(), seats: seats(), flags: hotseatCount() }; use("Advanced VCR"); out.advanced = { cap: hotseatCapacity(), dice: hotseatBonusDice(), seats: seats(), flags: hotseatCount() }; use("Basic VCR"); out.basic = { cap: hotseatCapacity(), dice: hotseatBonusDice(), seats: seats(), flags: hotseatCount() }; CHAR.play.purchases.rigs = []; rg.active_rig = ""; out.noRig = { cap: hotseatCapacity(), dice: hotseatBonusDice(), seats: seats(), flags: hotseatCount() }; use("Master VCR"); out.refit = { cap: hotseatCapacity(), seats: seats() }; return out; })()

- **Expected:**

      { "cores": [{ "rig": "Basic VCR",    "cores": "Single", "coreCount": 1, "bonusDice": 2 },
                  { "rig": "Advanced VCR", "cores": "Double", "coreCount": 2, "bonusDice": 4 },
                  { "rig": "Master VCR",   "cores": "Quad",   "coreCount": 4, "bonusDice": 6 }],
        "master":   { "cap": 4, "dice": 6, "seats": ["Alpha","Bravo","Charlie","Delta"], "flags": 4 },
        "advanced": { "cap": 2, "dice": 4, "seats": ["Alpha","Bravo"],                   "flags": 4 },
        "basic":    { "cap": 1, "dice": 2, "seats": ["Alpha"],                           "flags": 4 },
        "noRig":    { "cap": 0, "dice": 0, "seats": [],                                  "flags": 4 },
        "refit":    { "cap": 4, "seats": ["Alpha","Bravo","Charlie","Delta"] } }

- **Note:** #87, and a rules change: hotseat used to be strictly one at a time —
  ticking any box cleared every other — so the three VCRs differed only in links
  and dice, and a Master's four cores bought nothing a Basic's one didn't.

  `flags` staying at 4 through every arm is the load-bearing part. A downgrade
  **truncates** the seats in list order rather than clearing the flags, so
  refitting the Master brings all four back (`refit`) instead of making the
  player re-tick them. That is the same "the excess simply does nothing" shape
  the Skillsoft/Chipjack cap uses (P06-064), and it is why `deployedUnits()` —
  not the raw `rigging.hotseat` map — is the authority on who is actually
  seated. Anything reading the raw flag would still be handing a truncated seat
  the rig's bonus dice.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-067: A seat's guns fire from the Overview, on Gunnery + the rig's dice
- **Type:** correctness
- **Steps:** re-run the section setup first if P06-066 left the rig swapped.
  Stub `alert` per P00 §3 — the last arm reads one.
- **Check:**

      (() => { newRound(); window.__alerts = []; const close = () => document.querySelector(".sh-roller, .sh-popover")?._close?.(); const ov = () => { sheetTab = "overview"; renderSheet(); return [...document.querySelectorAll(".sh-card")].find(c => /Drones on Station/.test(c.querySelector("h3")?.textContent||"")); }; const out = {}; out.hint = ov().querySelector(".hint").textContent; out.seats = [...ov().querySelectorAll(".sh-h4")].map(h => h.textContent).filter(t => /hotseat/.test(t)); sheetTab = "rigging"; renderSheet(); out.fireDice = [...document.querySelectorAll(".sh-fire button")].filter(b => b.textContent === "Fire").map(b => (b.title.match(/loads (\d+)d6/)||[])[1]); const mag0 = ov().querySelector(".sh-fire-mag").textContent; const sel = ov().querySelector("select.sh-fire-sel"); sel.value = "FA"; sel.dispatchEvent(new Event("change", { bubbles: true })); [...ov().querySelectorAll("button")].find(b => b.textContent === "Fire").click(); close(); const after1 = { used: JSON.parse(JSON.stringify(CHAR.play.actions_used)), mag: ov().querySelector(".sh-fire-mag").textContent }; for (let i = 0; i < 2; i++) { [...ov().querySelectorAll("button")].find(b => b.textContent === "Fire").click(); close(); } const after3 = { used: JSON.parse(JSON.stringify(CHAR.play.actions_used)), mag: ov().querySelector(".sh-fire-mag").textContent }; [...ov().querySelectorAll("button")].find(b => b.textContent === "Fire").click(); close(); const refused = { alert: window.__alerts[0], mag: ov().querySelector(".sh-fire-mag").textContent }; sheetTab = "rigging"; renderSheet(); const riggingMag = document.querySelector(".sh-fire-mag").textContent; return { ...out, mag0, after1, after3, refused, riggingMag }; })()

- **Expected:**

      { "hint": "4 of 4 cores flying · every roll from a seat gains +6d from the Master VCR",
        "seats": ["Alphahotseat", "Bravohotseat", "Charliehotseat", "Deltahotseat"],
        "fireDice": ["11", "14", "12", "8"],
        "mag0": "360/360 rds",
        "after1": { "used": { "Rigging": 2 },              "mag": "340/360 rds" },
        "after3": { "used": { "Rigging": 4, "simple": 2 }, "mag": "300/360 rds" },
        "refused": { "alert": "Out of actions — Firing FA (Mini Gun) needs 2, you have 0 left (0 Rigging Exploit + 0 Simple).",
                     "mag": "300/360 rds" },
        "riggingMag": "300/360 rds" }

- **Note:** #87. The Drones on Station card used to print a seat's weapons as a
  comma-joined list of names — it told you what was bolted on and left you to
  walk to the Rigging tab to fire any of it, the one tab you are not on while
  flying.

  `fireDice` is the case's centre. Gunnery is 4 and the mounts are Acc 1 / 4 / 2
  / 4, so the seated three roll **11 / 14 / 12** — skill + Accuracy + the Master
  VCR's 6 — while **Echo, linked but not seated, rolls 8**: skill + Accuracy and
  nothing else. The rig's dice are a property of being jacked in, not of being
  deployed. (Delta's Railgun is an energy mount and has no Fire button at all —
  Heat plus Aimed Fire, the same split personal energy weapons use — which is
  why four drones with Fire buttons cover five drones.)

  `after1`/`after3` pin the action economy: FA is a Complex action, so 2 units a
  burst, drawn from the **4 Rigging Exploit actions the Quad cores grant** before
  spilling into Simple. `refused` proves the fourth burst is refused whole —
  the magazine does not move, so a refusal never costs ammunition.

  `riggingMag` is the anti-drift assertion. The Overview's controls are the same
  `unitGunControls` off the same `unitGunState`, so 60 rounds spent from the
  Overview are 60 rounds gone on the Rigging tab. Two independent magazines for
  one gun would be the obvious way to build this wrong.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-068: The on-station rollup fires too, and the Gear tab does not
- **Type:** correctness
- **Steps:** re-run the section setup if a previous case left the rig swapped or
  a magazine spent (`newRound()` alone will not refill one).
- **Check:**

      (() => { const rollup = () => { sheetTab = "rigging"; renderSheet(); return [...document.querySelectorAll(".sh-card")].find(c => /Active drones/.test(c.querySelector("h3")?.textContent||"")); }; const rows = [...rollup().querySelectorAll("tr")].slice(1).map(tr => { const fire = [...tr.cells[2].querySelectorAll("button")].find(b => b.textContent === "Fire"); return { unit: tr.cells[0].innerText.split("\n")[0], dice: fire ? +(fire.title.match(/loads (\d+)d6/)||[])[1] : null, buttons: [...tr.cells[2].querySelectorAll("button")].map(b => b.textContent).join("/") }; }); sheetTab = "gear"; renderSheet(); const gearFire = document.querySelectorAll("#sh-tabpanel .sh-fire").length; return { rows, gearFire }; })()

- **Expected:**

      { "rows": [{ "unit": "Alpha",   "dice": 11,   "buttons": "Fire/Reload/Aimed Fire" },
                 { "unit": "Bravo",   "dice": 14,   "buttons": "Fire/Reload/Aimed Fire" },
                 { "unit": "Charlie", "dice": 12,   "buttons": "Fire/Reload/Aimed Fire" },
                 { "unit": "Delta",   "dice": null, "buttons": "−/+/Aimed Fire" },
                 { "unit": "Echo",    "dice": 8,    "buttons": "Fire/Reload/Aimed Fire" }],
        "gearFire": 0 }

- **Note:** `unitLoadoutTable` is rendered twice from one definition — the
  Rigging tab's **Active drones & vehicles** rollup (`mode: "station"`) and the
  Gear tab's owned-units inventory (`mode: "inventory"`) — and only the first
  gets fire controls. This is the mode split earning its keep: the rollup is the
  list of what is deployed, so it is where you reach when you want to shoot with
  one of them, while a drone sitting in the Gear tab's inventory has nothing to
  fire at. `gearFire` at 0 is the assertion that the controls did not leak
  across; a `.sh-fire` on the Gear tab means the `station` guard was dropped.

  The `dice` column repeats P06-067's split in the other view — 11/14/12 seated,
  **8 for the linked-but-unseated Echo** — because the rollup asks
  `deployedUnits()` who is really seated rather than reading `rigging.hotseat`.
  Reading the raw flag here would hand a seat truncated by a VCR downgrade
  (P06-066) the rig's bonus dice anyway. Delta's `null` is the energy mount
  again: Heat counter and Aimed Fire, no Fire button.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## The Rigging tab restructure: a Modify dialog, and a readable rollup

A UX pass (still #87), separate from the mechanics above: the per-unit card was
doing two jobs at once — the garage (own it, name it, outfit it, repair it,
sell it) and the cockpit (what's deployed, what's damaged, shoot with it) —
and the outfitting half, consulted between runs, was paying rent on every
render. Measured against the section setup's rigger (one Master VCR, five armed
Discs), the Rigging tab was **5538px** with every picker collapsed — 6.1
screens at a 910px viewport, three quarters of it the Drones card alone.

**Section setup**, on top of the P06-066/067/068 setup already in this
character (re-run that section's block first if starting fresh):

      (() => { sheetTab = "rigging"; renderSheet(); return { cardOrder: [...document.querySelectorAll("#sh-tabpanel .sh-card h3")].map(x => x.textContent), heightPx: document.getElementById("sh-tabpanel").scrollHeight }; })()

**Expected:**

      { "cardOrder": ["Vehicle Control Rigs", "Drones 5", "Vehicles"],
        "heightPx": 1482 }

**Note:** 5538px → 3105px (3.4 screens) at the #87 restructure, 2276px once two
later changes landed on top (the two-up card layout, and the move of the tab's
"Buy rigs, drones & vehicles" card into a Buy dialog), and **1482px** (877px
viewport, matching P13-018) once #94 retired the "Active drones & vehicles"
rollup outright — Hotseat and a unit's fire controls moved onto its own card
in the Drones/Vehicles lists below, so the rollup that used to render first
had nothing left to do that wasn't already duplicated underneath it.
`cardOrder` now opens on Vehicle Control Rigs, which is where #95 also moved
this same deployment summary — see its own card, not a `.sh-card` of its own
any more.

### P06-069: The garage is a garage — outfitting moved to Modify, firing did not move at all
- **Type:** correctness
- **Check:**

      (() => { sheetTab = "rigging"; renderSheet(); const droneCard = [...document.querySelectorAll(".sh-card")].find(c => c.querySelector("h3")?.textContent === "Drones"); const rollup = [...document.querySelectorAll(".sh-card")].find(c => /Active drones/.test(c.querySelector("h3")?.textContent||"")); return { cardFire: droneCard.querySelectorAll(".sh-fire").length, cardBrowsers: droneCard.querySelectorAll(".cat-browser").length, cardRepairButtons: [...droneCard.querySelectorAll("button")].filter(b => /^Repair/.test(b.textContent)).length, cardConditionSelects: droneCard.querySelectorAll("select").length, cardNameInputs: droneCard.querySelectorAll("input.sh-unit-name").length, bars: droneCard.querySelectorAll(".sh-bar").length, modifyButtons: [...droneCard.querySelectorAll("button")].filter(b => /^(Modify|View loadout)$/.test(b.textContent)).length, rollupFire: rollup.querySelectorAll(".sh-fire").length }; })()

- **Expected:**

      { "cardFire": 0, "cardBrowsers": 0, "cardRepairButtons": 0, "cardConditionSelects": 0,
        "cardNameInputs": 0, "bars": 10, "modifyButtons": 5, "rollupFire": 5 }

- **Note:** `bars: 10` is the one thing that DIDN'T move, in one number — 5
  drones × 2 tracks (Physical, Integrity) still on the card, because marking
  damage is frequent and only the *purchase* of a repair moved to the dialog.
  Everything else in this check is a 0 that used to be non-zero: name input,
  condition select, repair buttons, fire controls and category browsers are
  all gone from the card. `cardBrowsers: 0` is scoped to the **Drones** card
  specifically — the VCR row above it keeps its own rig-mod `.cat-browser`
  unchanged, since VCR editing wasn't part of this restructure.

  `modifyButtons: 5` and `rollupFire: 5` are the same number for a different
  reason: one Modify button per unit (outfitting, one place), and one set of
  fire controls per deployed mount in the rollup (firing, the other place).
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-070: The Modify dialog survives the re-render its own buttons cause
- **Type:** correctness
- **Steps:** open Modify on Alpha (`drones:0`) from the Drones card.
- **Check:**

      (async () => { const btn = [...document.querySelectorAll("button")].find(b => b.textContent === "Modify" && b.dataset.modifyKey === "drones:0"); btn.click(); await new Promise(r => setTimeout(r, 30)); const head = [...document.querySelectorAll(".mount-modal .cat-head")].find(h => /Mods/.test(h.textContent) && !/Weapon/.test(h.textContent)); head.click(); await new Promise(r => setTimeout(r, 30)); const addBtn = [...document.querySelectorAll(".mount-modal .btn-add")].find(b => b.closest(".cat-item")); const addedName = addBtn.closest(".cat-item").querySelector("b").textContent; addBtn.click(); await new Promise(r => setTimeout(r, 60)); const modal = document.querySelector(".mount-modal"); const out = { stillOpen: !!modal, focusInside: modal.contains(document.activeElement), modsLegend: [...modal.querySelectorAll(".sh-cal-legend")].find(l => /^Mods/.test(l.textContent)).textContent, charMods: CHAR.play.purchases.drones[0].mods, noLiteralNull: !/(^|\n)null(\n|$)/.test(modal.innerText) }; return { addedName, out }; })()

- **Expected:** `addedName` is whatever the first collapsed unit-mod group's
  first item is (`"Hardening"` against this fixture); `out` is

      { "stillOpen": true, "focusInside": true, "modsLegend": "Mods (1)",
        "charMods": ["Hardening"], "noLiteralNull": true }

- **Note:** The `openSheetModal` analogue of P06-033. `focusInside` is the
  load-bearing assertion — `commit()` runs `recalc()` then the dialog's own
  `refresh()`, which replaces only `.sh-modal-body`, never the header; a
  version that rebuilt the whole box would drop focus to `<body>` on every
  add, same as the bug P06-033 pins for the popover.

  `noLiteralNull` guards a real bug this restructure shipped and then fixed in
  the same pass: `Element.append()` (not `el()`'s own child handling)
  stringifies a bare `null` argument into the literal text "null" on the page.
  `openSheetModal`'s header-then-optional-sub-then-body assembly did exactly
  that when no `sub` was passed; the fix routes it through the existing
  `appendIf()` helper (app.js) instead of a raw `.append(a, b, c)` call.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-071: Repair moved into Modify; marking damage stayed on the card
- **Type:** correctness
- **Steps:** close any open dialog first. Reload the fixture's drone state if a
  prior case left Alpha damaged (`CHAR.play.rigging.units["drones:0"]`).
- **Check:**

      (async () => { document.querySelector(".mount-modal-backdrop")?.remove(); sheetTab = "rigging"; renderSheet(); const card = [...document.querySelectorAll(".sh-unit")].find(u => /Alpha/.test(u.querySelector(".sh-unit-title b")?.textContent||"")); const physTrack = [...card.querySelectorAll(".sh-track")].find(t => /PHYSICAL/.test(t.textContent)); const plus = [...physTrack.querySelectorAll(".mini-btn")].find(b => b.textContent === "+"); plus.click(); plus.click(); await new Promise(r => setTimeout(r, 60)); const markedFromCard = CHAR.play.rigging.units["drones:0"].physical; const btn = [...document.querySelectorAll("button")].find(b => b.textContent === "Modify" && b.dataset.modifyKey === "drones:0"); btn.click(); await new Promise(r => setTimeout(r, 30)); const modal = document.querySelector(".mount-modal"); const qty = modal.querySelector('input[type="number"].sv-edit'); qty.value = "2"; qty.dispatchEvent(new Event("input", { bubbles: true })); const repairBtn = [...modal.querySelectorAll("button")].find(b => b.textContent === "Repair"); const cashBefore = CHAR.play.cash; repairBtn.click(); await new Promise(r => setTimeout(r, 60)); const physicalAfterRepair = CHAR.play.rigging.units["drones:0"].physical; const cashSpent = cashBefore - CHAR.play.cash; const stillOpen = !!document.querySelector(".mount-modal"); document.querySelector(".mount-modal-backdrop")?.remove(); return { markedFromCard, physicalAfterRepair, cashSpent, stillOpen }; })()

- **Expected:** `{ "markedFromCard": 2, "physicalAfterRepair": 0, "cashSpent": 24, "stillOpen": true }`
- **Note:** `markedFromCard` is the card's own `+`/`−` mini-counter, untouched
  by this change — marking damage is what you do constantly, so it never left.
  `cashSpent: 24` is `2 boxes × unitRepairCostPerBox` (1/100th of the Disc's
  face cost); `stillOpen` shows the dialog redrew itself through `commit()`
  rather than the card's own `playChangedRecalc()` closing everything.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-072: Removing a weapon in Modify still renumbers unitGunState correctly
- **Type:** correctness
- **Steps:** gives Bravo (`drones:1`) a second mount, fires the SECOND one from
  the rollup, then removes the FIRST one from Modify — the exact shape that
  breaks if `removeUnitWeapon`'s re-keying is ever dropped from the move.
- **Check:**

      (async () => { window.confirm = () => true; CHAR.play.purchases.drones[1].weapons = ["Mini Gun", "Autocannon"]; await playChangedRecalc(); sheetTab = "rigging"; renderSheet(); const rollup = () => [...document.querySelectorAll(".sh-card")].find(c => /Active drones/.test(c.querySelector("h3")?.textContent||"")); const bravoRow = [...rollup().querySelectorAll("tr")].find(tr => /Bravo/.test(tr.cells[0].innerText)); const fireButtons = [...bravoRow.cells[2].querySelectorAll("button")].filter(b => b.textContent === "Fire"); fireButtons[1].click(); document.querySelector(".sh-roller, .sh-popover")?._close?.(); const gunsBefore = JSON.parse(JSON.stringify(CHAR.play.rigging.units["drones:1"].guns)); const btn = [...document.querySelectorAll("button")].find(b => b.textContent === "Modify" && b.dataset.modifyKey === "drones:1"); btn.click(); await new Promise(r => setTimeout(r, 30)); const modal = document.querySelector(".mount-modal"); const miniGunChip = [...modal.querySelectorAll(".chip")].find(c => /Mini Gun/.test(c.textContent)); miniGunChip.click(); await new Promise(r => setTimeout(r, 60)); const disposal = document.querySelectorAll(".mount-modal")[1]; [...disposal.querySelectorAll("button")].find(b => b.textContent === "Sell").click(); await new Promise(r => setTimeout(r, 100)); const gunsAfter = JSON.parse(JSON.stringify(CHAR.play.rigging.units["drones:1"].guns)); const weaponsAfter = CHAR.play.purchases.drones[1].weapons; document.querySelector(".mount-modal-backdrop")?.remove(); return { gunsBefore, gunsAfter, weaponsAfter }; })()

- **Expected:**

      { "gunsBefore": { "0": {}, "1": { "loaded": 119 } },
        "gunsAfter": { "0": { "loaded": 119 } },
        "weaponsAfter": ["Autocannon"] }

- **Note:** Autocannon (mount index 1) fired an FA burst down to 119/120,
  Mini Gun (index 0) was untouched. Removing Mini Gun must shift Autocannon's
  firing state from key `"1"` down to `"0"` — `gunsAfter` shows it landed with
  its OWN magazine (119), not a fresh or inherited one. This is
  `removeUnitWeapon(u, wi, cfg.table)`'s third argument doing its job (sheet.js,
  search `removeUnitWeapon`) — drop that argument when a weapon-sell handler
  moves to a new dialog and the survivor silently inherits the dead gun's
  magazine and firing mode instead.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-073: A nested disposal prompt closes on its own Escape; a second Escape closes Modify
- **Type:** accessibility
- **Check:**

      (async () => { document.querySelector(".mount-modal-backdrop")?.remove(); sheetTab = "rigging"; renderSheet(); const btn = [...document.querySelectorAll("button")].find(b => b.textContent === "Modify" && b.dataset.modifyKey === "drones:0"); btn.focus(); btn.click(); await new Promise(r => setTimeout(r, 30)); const modal = document.querySelector(".mount-modal"); const modChip = [...modal.querySelectorAll(".chip")].find(c => /Hardening/.test(c.textContent)); if (!modChip) return { skipped: "no Hardening mod fitted — run P06-070 first, or fit one" }; modChip.click(); await new Promise(r => setTimeout(r, 60)); const stacked = document.querySelectorAll(".mount-modal-backdrop").length; document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await new Promise(r => setTimeout(r, 30)); const afterEscape1 = { backdrops: document.querySelectorAll(".mount-modal-backdrop").length, modifyStillOpen: !!document.querySelector(".mount-modal") }; document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await new Promise(r => setTimeout(r, 30)); const afterEscape2 = { backdrops: document.querySelectorAll(".mount-modal-backdrop").length, focusedIsModifyBtn: document.activeElement && document.activeElement.dataset.modifyKey === "drones:0" }; return { stacked, afterEscape1, afterEscape2 }; })()

- **Expected:**

      { "stacked": 2,
        "afterEscape1": { "backdrops": 1, "modifyStillOpen": true },
        "afterEscape2": { "backdrops": 0, "focusedIsModifyBtn": true } }

- **Note:** `promptDisposal`'s own Escape handler is bubble-phase;
  `openSheetModal`'s is capture-phase and would fire first on every nested
  dialog otherwise — closing Modify out from under the disposal prompt it just
  opened. `isTop()` (checks whether this dialog's backdrop is the LAST
  `.mount-modal-backdrop` in the document) gates it: the first Escape reaches
  `promptDisposal`'s own listener untouched; only the second, once Modify's
  backdrop is again the topmost, closes Modify and hands focus back to the
  button via `restoreSel`.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-074: A seat truncated by a VCR downgrade now says so
- **Type:** UX
- **Steps:** companion to P06-066, which proves the engine truncates seats
  past the new rig's cores. This proves the rollup finally SHOWS it. Restores
  the Master VCR at the end.
- **Check:**

      (() => { const rg = CHAR.play.rigging; CHAR.play.purchases.rigs = [{ name: "Basic VCR", mods: [] }]; rg.active_rig = "Basic VCR"; sheetTab = "rigging"; renderSheet(); const rollup = [...document.querySelectorAll(".sh-card")].find(c => /Active drones/.test(c.querySelector("h3")?.textContent||"")); const rows = [...rollup.querySelectorAll("tr")].slice(1).map(tr => ({ unit: tr.cells[0].innerText.split("\n")[0], chips: [...tr.querySelectorAll(".sh-tagrow .chip")].map(c => c.textContent) })); const out = { rows, countsLine: rollup.querySelector(".hint").textContent }; CHAR.play.purchases.rigs = [{ name: "Master VCR", mods: [] }]; rg.active_rig = "Master VCR"; renderSheet(); return out; })()

- **Expected:**

      { "rows": [{ "unit": "Alpha",   "chips": ["LINK", "HOTSEAT"] },
                 { "unit": "Bravo",   "chips": ["LINK", "SEAT — NO CORE"] },
                 { "unit": "Charlie", "chips": ["LINK", "SEAT — NO CORE"] },
                 { "unit": "Delta",   "chips": ["LINK", "SEAT — NO CORE"] },
                 { "unit": "Echo",    "chips": ["LINK"] }],
        "countsLine": "5 deployed · 1 of 1 core flying · 5 of 1 VCR link used" }

- **Note:** Before this change, a seat truncated by a VCR downgrade
  (P06-066's `deployedUnits()` truncation) was **invisible in the UI** —
  Bravo/Charlie/Delta's flags were still set, but nothing on screen said they
  had stopped flying. `SEAT — NO CORE` is the one genuinely new fact this
  restructure adds: `rg.hotseat[key]` is true but `deployedUnits()`'s
  `hotseat` came back false for that unit.

  `countsLine` reads `"5 of 1 VCR link"` because the section setup links all
  five Discs directly through `rigging.linked`, bypassing the `linkToggle`'s
  own cap check (which would refuse a 5th link at the table in ordinary play,
  alerting `"Active VCR links only N unit(s)."`) — the over-cap link count is
  the counts line honestly reporting a state the setup script forced, not a
  bug in the count.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-075: Drones/Vehicles lay out two-up, and each card collapses on its own
- **Type:** correctness
- **Steps:** the section setup's five Discs, at a 900px-wide viewport
  (`resize_window` to `{width:900, height:900}` — the grid column count is
  viewport-dependent, so pin it before reading `gridCols`).
- **Check:**

      (() => { sheetTab = "rigging"; renderSheet(); const droneCard = [...document.querySelectorAll(".sh-card")].find(c => c.querySelector("h3")?.textContent.startsWith("Drones")); const vehCard = [...document.querySelectorAll(".sh-card")].find(c => c.querySelector("h3")?.textContent.startsWith("Vehicles")); return { droneToggle: [...droneCard.querySelectorAll("button")].find(b => /Hide|Show/.test(b.textContent)).textContent, vehToggle: [...vehCard.querySelectorAll("button")].find(b => /Hide|Show/.test(b.textContent)).textContent, vehHint: vehCard.querySelector(".hint")?.textContent, gridCols: getComputedStyle(droneCard.querySelector(".sh-unit-grid")).gridTemplateColumns.split(" ").length, heightPx: document.getElementById("sh-tabpanel").scrollHeight }; })()

- **Expected:**

      { "droneToggle": "Hide ▴", "vehToggle": "Show ▾", "vehHint": "No vehicles owned.",
        "gridCols": 2, "heightPx": 2558 }

- **Note:** Drones defaults OPEN (5 owned) and Vehicles defaults COLLAPSED
  (none owned) from the same rule: `unitGroupCollapsed[table]` starts `null`
  ("the player hasn't touched this"), and the card reads
  `entries.length === 0` for its default every render until a manual toggle
  turns it into a fixed boolean. `heightPx: 2558` is the two-column payoff on
  top of the Modify-dialog restructure (P06-069) — the same fixture was 3105px
  in one column and 5538px before either change, all at a comparable width.
  `gridCols: 2` at 900px confirms `auto-fit`/`minmax(360px,1fr)` is doing the
  packing with no media query; a single owned unit, or a narrow phone width,
  folds the same grid to one column on its own.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-076: A manual collapse/expand sticks regardless of what's bought or sold afterward
- **Type:** correctness
- **Check:**

      (async () => { const droneCard = () => [...document.querySelectorAll(".sh-card")].find(c => c.querySelector("h3")?.textContent.startsWith("Drones")); const vehCard = () => [...document.querySelectorAll(".sh-card")].find(c => c.querySelector("h3")?.textContent.startsWith("Vehicles")); [...droneCard().querySelectorAll("button")].find(b => /Hide/.test(b.textContent)).click(); const collapsedWithFive = { toggle: [...droneCard().querySelectorAll("button")].find(b => /Hide|Show/.test(b.textContent)).textContent, hint: droneCard().querySelector(".hint")?.textContent, gridPresent: !!droneCard().querySelector(".sh-unit-grid") }; renderSheet(); const survivesRerender = [...droneCard().querySelectorAll("button")].find(b => /Hide|Show/.test(b.textContent)).textContent; unitGroupCollapsed.vehicles = null; CHAR.play.purchases.vehicles.push({ name: DATA.tables.vehicles[0][RIG_UNIT_CFG.vehicles.nameKey], weapons: [], mods: [] }); await playChangedRecalc(); sheetTab = "rigging"; renderSheet(); const vehAutoOpensOnFirstBuy = { toggle: [...vehCard().querySelectorAll("button")].find(b => /Hide|Show/.test(b.textContent)).textContent, unitCount: vehCard().querySelectorAll(".sh-unit").length }; [...droneCard().querySelectorAll("button")].find(b => /Show/.test(b.textContent)).click(); CHAR.play.purchases.vehicles.pop(); await playChangedRecalc(); return { collapsedWithFive, survivesRerender, vehAutoOpensOnFirstBuy }; })()

- **Expected:**

      { "collapsedWithFive": { "toggle": "Show ▾", "hint": "5 drones — hidden.", "gridPresent": false },
        "survivesRerender": "Show ▾",
        "vehAutoOpensOnFirstBuy": { "toggle": "Hide ▴", "unitCount": 1 } }

- **Note:** `collapsedWithFive`/`survivesRerender` prove the override is a
  plain boolean once set — collapsing a card with 5 units owned doesn't
  reopen itself on the next `renderSheet()` just because there's something to
  show. `vehAutoOpensOnFirstBuy` is the companion case: reset
  `unitGroupCollapsed.vehicles` to `null` (simulating a player who never
  touched the toggle) and the first Vehicle purchase opens the card on its
  own, same as P06-075's `vehHint` default. The two together are the whole
  contract: untouched tracks ownership live, touched stays exactly where the
  player left it.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-077: A deployed unit's Inertia reads 0, not the literal text "undefined"
- **Type:** correctness
- **Steps:** the bug this pins needs the rollup to render a unit's fire
  controls (which calls `unitGunState`, creating `rg.units[key]`) BEFORE that
  unit's own card runs its `rg.units[key] || {...}` default — linking a fresh
  drone and rendering the Rigging tab does both in the right order for free.
- **Check:**

      (async () => { const p = CHAR.play.purchases, rg = CHAR.play.rigging; rigFlags(); p.rigs.push({ name: "Master VCR", mods: [] }); rg.active_rig = "Master VCR"; p.drones.push({ name: "Disc", label: "Alpha", weapons: ["Mini Gun"], mods: [] }); rg.linked["drones:0"] = true; await playChangedRecalc(); sheetTab = "rigging"; renderSheet(); const droneCard = [...document.querySelectorAll(".sh-card")].find(c => c.querySelector("h3")?.textContent.startsWith("Drones")); const freshState = { blockText: droneCard.querySelector(".sh-unit-inertia").innerText, raw: CHAR.play.rigging.units["drones:0"] }; CHAR.play.rigging.units["drones:0"] = { guns: { "0": {} } }; renderSheet(); const legacyState = { blockText: [...document.querySelectorAll(".sh-card")].find(c => c.querySelector("h3")?.textContent.startsWith("Drones")).querySelector(".sh-unit-inertia").innerText }; return { freshState, legacyState }; })()

- **Expected:**

      { "freshState": { "blockText": "MOVE\n8m\nInertia\n−\n0\n+",
                        "raw": { "guns": { "0": {} }, "inertia": 0, "integrity": 0, "physical": 0 } },
        "legacyState": { "blockText": "MOVE\n8m\nInertia\n−\n0\n+" } }

- **Note:** `unitGunState` (sheet.js, called from `unitFireControls` when the
  on-station rollup builds a mount's Fire controls, which always renders
  before `unitBlock`'s own card) used to seed `rg.units[key]` with a bare `{}`.
  `unitBlock`'s `rg.units[key] || { inertia: 0, … }` default never applies
  once the slot already exists — sparse or not — so `st.inertia` stayed
  `undefined` forever for any unit whose rollup row rendered first, and
  `miniCounter`'s `String(get())` printed that literally as the four-letter
  word "undefined" instead of a number. `freshState.raw` proves the root
  cause is fixed: `unitGunState` now seeds the same three-field shape
  `unitBlock` does, so a newly-deployed unit's slot is never sparse to begin
  with. `legacyState` proves the belt-and-suspenders half: a character saved
  *before* this fix, still carrying exactly the old sparse shape, is caught by
  `toInt(st.inertia)` at the Inertia counter's getter — the same defence the
  read-only branch already had, now applied to the editable one too.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-078: Running a program without a Nerve Rig carries a −2d penalty
- **Type:** correctness
- **Steps:** none.
- **Check:**

      (async () => { window.alert = () => {}; const c = RULES.defaultCharacter(); c.name = "QA Nerve Rig"; c.priorities = { heritage: 1, magic: 0, attributes: 5, skills: 4, resources: 0 }; c.heritage.type = "Human"; c.skills = { "Computer: Hacking": 4 }; c.decks = [{ name: "MasterDeck", mods: [] }]; c.programs = ["Attack Dog"]; c.play = c.play || {}; c.play.decking = { active_deck: "MasterDeck", loaded: ["Attack Dog"], jacked_out: false }; c.finalized = true; c.lifestyles = [{ name: "Squatter", months: 1 }]; await openCharacter(c); sheetTab = "decking"; renderSheet(); const btn = () => [...document.querySelectorAll("button")].find(b => /^Run \(/.test(b.textContent)); const noRig = deckingNerveRigPenalty(); const titleNoRig = btn().title; btn().click(); const rollerNoRig = { penalty: rollerState.penalty, label: rollerState.penaltyLabel }; closeSheetPopover(); rollerState.open = false; CHAR.play.kit.augments.push({ name: "Nerve Rig", count: 1 }); playChanged(); const withRig = deckingNerveRigPenalty(); const titleWithRig = btn().title; btn().click(); const rollerWithRig = { penalty: rollerState.penalty, label: rollerState.penaltyLabel }; closeSheetPopover(); rollerState.open = false; await closeTabByName("QA Nerve Rig"); return { noRig, titleNoRig, rollerNoRig, withRig, titleWithRig, rollerWithRig }; })()

- **Expected:**

      { "noRig": 2,
        "titleNoRig": "Roll 4d6 — Computer: Hacking 4 + Attack Dog rating 0. Costs 4 dice: 3 MCP available, then Focus · −2d, no Nerve Rig",
        "rollerNoRig": { "penalty": 2, "label": "No Nerve Rig" },
        "withRig": 0,
        "titleWithRig": "Roll 4d6 — Computer: Hacking 4 + Attack Dog rating 0. Costs 4 dice: 0 MCP available, then Focus",
        "rollerWithRig": { "penalty": 0, "label": "Wound" } }

- **Note:** Issue #90. Nerve Rig's own data-row description already said it's
  "necessary for direct control-hotseating while rigging or decking" — nothing
  enforced it. `deckingNerveRigPenalty()` follows the exact shape
  `castingZrPenalty()` established for the ZR house rule and `TWIN_FIRE_PENALTY`
  established for dual-wielding: a fixed penalty the TEST carries, applied at
  roll time via `openPoolRoller`'s `extraPenalty`/`penaltyLabel`, not a note
  parked on the deck or program — there's no `CALC.decking` object to hang a
  note on, and the penalty depends on the character's own augment loadout, not
  either item's stats.

  `noRig`/`withRig` are the direct check: `allAugmentsOwned().some(a => a.name
  === "Nerve Rig")` gates it, same idiom as the existing Hyperthyroid surcharge
  check. `titleNoRig`/`titleWithRig` confirm the penalty is on the button's
  face before the click, not just inside the roller after — the same reasoning
  the MCP/pool cost breakdown is already there for. `rollerNoRig`/`rollerWithRig`
  confirm the roller itself actually carries `extraPenalty: 2` (not just a
  cosmetic label) when the rig is missing, and drops to a plain `0`/"Wound"
  once it's installed — `withRig`'s roll happens second, after the first
  `Run` already drained this character's 3 MCP dice, which is why its title
  reads "0 MCP available" rather than 3; that's the state the test sequence
  leaves behind, not a second bug.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-079: Maneuver rolls Drive or Fly off the unit's Move Type, adds Handling from Focus, and penalizes a missing VCR or Hotseat
- **Type:** correctness
- **Steps:** none.
- **Check:**

      (async () => { window.alert = () => {}; const c = RULES.defaultCharacter(); c.name = "QA Maneuver"; c.priorities = { heritage: 1, magic: 0, attributes: 5, skills: 4, resources: 0 }; c.heritage.type = "Human"; c.skills = { "Fly": 4, "Drive": 2 }; c.drones = [{ name: "Roto-Drone", weapons: [], mods: [] }]; c.vehicles = [{ name: "Speedboat", weapons: [], mods: [] }]; c.rigs = [{ name: "Basic VCR", mods: [] }]; c.finalized = true; c.lifestyles = [{ name: "Squatter", months: 1 }]; await openCharacter(c); sheetTab = "rigging"; renderSheet(); const droneSpec1 = maneuverRollSpec("drones", CHAR.play.kit.drones[0]); const boatSpec1 = maneuverRollSpec("vehicles", CHAR.play.kit.vehicles[0]); const droneNoHotseat = { skill: droneSpec1.skill, dice: droneSpec1.dice, penalty: droneSpec1.penalty, bits: droneSpec1.penaltyBits }; const boatNoHotseat = { skill: boatSpec1.skill, dice: boatSpec1.dice, penalty: boatSpec1.penalty, bits: boatSpec1.penaltyBits }; const rg = rigFlags(); rg.active["drones:0"] = true; rg.hotseat["drones:0"] = true; playChanged(); const droneHotseat = maneuverRollSpec("drones", CHAR.play.kit.drones[0]).penalty; const removedRig = CHAR.play.kit.rigs.pop(); playChanged(); const droneNoVcrAtAll = maneuverRollSpec("drones", CHAR.play.kit.drones[0]); CHAR.play.kit.rigs.push(removedRig); playChanged(); sheetTab = "rigging"; renderSheet(); const riggingTabButtonCount = [...document.querySelectorAll("button")].filter(b => /^Maneuver \(/.test(b.textContent)).length; sheetTab = "overview"; renderSheet(); const overviewBtn = () => [...document.querySelectorAll("button")].find(b => /^Maneuver \(/.test(b.textContent)); const overviewButtonTitle = overviewBtn().title; const focusBefore = poolState("Focus").remaining; overviewBtn().click(); document.querySelector(".sh-roller-roll").click(); const focusSpent = focusBefore - poolState("Focus").remaining; rollerState.open = false; const tab = activeTabObj(); tab.readonly = true; renderSheet(); const readonlyHasButton = !![...document.querySelectorAll("button")].find(b => /^Maneuver \(/.test(b.textContent)); tab.readonly = false; await closeTabByName("QA Maneuver"); return { droneNoHotseat, boatNoHotseat, droneHotseat, droneNoVcrAtAll: { penalty: droneNoVcrAtAll.penalty, bits: droneNoVcrAtAll.penaltyBits }, riggingTabButtonCount, overviewButtonTitle, focusSpent, readonlyHasButton }; })()

- **Expected:**

      { "droneNoHotseat": { "skill": "Fly", "dice": 10, "penalty": 2, "bits": ["not hotseat"] },
        "boatNoHotseat": { "skill": "Drive", "dice": 7, "penalty": 2, "bits": ["not hotseat"] },
        "droneHotseat": 0,
        "droneNoVcrAtAll": { "penalty": 6, "bits": ["no VCR", "not hotseat"] },
        "riggingTabButtonCount": 2, "overviewButtonTitle": "Roll 10d6 — Fly 4 + Handling 6",
        "focusSpent": 1, "readonlyHasButton": false }

- **Note:** Issue #89, built on #91's `Move Type` tagging. `maneuverRollSpec()`
  picks the skill off the unit's own row — `"Fly"` rolls Fly, everything else
  (blank/ground, `"Water"`) rolls Drive, per the issue text. The Roto-Drone
  (Fly, Handling 6) and Speedboat (Water → Drive, Handling 5) confirm both
  branches from real tagged rows, not a stub.

  Handling is folded into `dice` (the roller's limit), not `bonus` —
  `rollerSpendPool()` only ever bills the limit to a pool, so bonus dice are
  free the way a firing mode's are. The issue wants Handling to *also* draw
  from Focus, which only happens if it rides in `dice`; `focusSpent` (using
  `Roto-Drone`'s Fly 4 + Handling 6 = 10 dice against a small Focus pool)
  proves the roll's actual pool draw agrees with the button's own math, not
  just its label.

  Two independent penalties, same `extraPenalty`/`penaltyLabel` shape as the
  Nerve Rig penalty (P06-078) and Twin Fire before it: `droneNoHotseat`/
  `boatNoHotseat` are −2d with a VCR owned but this unit not seated in it;
  `droneNoVcrAtAll` — the VCR removed outright — is −6d (−4d no VCR, −2d not
  hotseat; losing the VCR also un-hotseats every seat, so both apply
  together, never just one masking the other). `droneHotseat` (0) is the
  clean case: VCR owned, this unit actually jacked in.

  The button renders in both places a Fire button already does, off the same
  `maneuverButton()` — the Rigging tab's per-unit card (`riggingTabButtonCount`
  2, one per owned unit, gated on nothing but ownership — maneuvering doesn't
  require the unit be on station, only that it be flown, hence the −2d rather
  than a hard refusal without Hotseat) and the Overview's hotseat rollup
  (only for seats actually on station, next to the same Move line the
  Rigging tab's Move tile mirrors). It spends a Rigging Exploit Action before
  a Simple one, same as Fire — maneuvering is a round's action.

  (#94 retired the Rigging tab's separate "Active drones & vehicles" rollup —
  the per-unit cards now carry Hotseat too, so the count here dropped back
  from 3 to 2. See P06-082.)
  `readonlyHasButton` false confirms a shared read-only character gets no
  mutating control, the same gate every other roll button on this sheet uses.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-080: An overheated Energy weapon always fires — it warns, then risks exploding
- **Type:** correctness
- **Steps:** none.
- **Check:**

      (async () => { window.alert = () => {}; const c = RULES.defaultCharacter(); c.name = "QA Overheat"; c.priorities = { heritage: 1, magic: 0, attributes: 5, skills: 4, resources: 0 }; c.heritage.type = "Human"; c.skills = { "Firearms": 4, "Gunnery": 3 }; c.weapons = [{ name: "Neon Fang LS", mods: [] }]; c.drones = [{ name: "Roto-Drone", weapons: ["Pulse Rifle"], mods: [] }]; c.finalized = true; c.lifestyles = [{ name: "Squatter", months: 1 }]; await openCharacter(c); CHAR.play.kit.weapons[0].hand = 0; sheetTab = "overview"; renderSheet(); const w = CHAR.play.kit.weapons[0]; const defaultHeatIsZero = w.heat == null; const row = () => [...document.querySelectorAll(".sh-hand-card")].find(r => /Neon Fang LS/.test(r.textContent)); const fireOf = () => [...row().querySelectorAll("button")].find(b => b.textContent === "Fire"); const aimedExists = !![...row().querySelectorAll("button")].find(b => b.textContent === "Aimed Fire"); fireOf().click(); await new Promise(r => setTimeout(r, 20)); const safeFireNoWarning = !document.querySelector(".mount-modal-backdrop"); const heatAfterSafeFire = w.heat; rollerState.open = false; w.heat = 3; playChanged(); fireOf().click(); await new Promise(r => setTimeout(r, 20)); const warnModal = document.querySelector(".mount-modal-backdrop"); const warningText = warnModal.querySelector("p.hint").textContent; [...warnModal.querySelectorAll("button")].find(b => b.textContent === "Cancel").click(); const cancelNoHeatChange = w.heat === 3; const cancelNoModal = !document.querySelector(".mount-modal-backdrop"); fireOf().click(); await new Promise(r => setTimeout(r, 20)); const realRandom = Math.random; Math.random = () => 0; [...document.querySelector(".mount-modal-backdrop").querySelectorAll("button")].find(b => b.textContent === "Continue to Fire").click(); await new Promise(r => setTimeout(r, 20)); Math.random = realRandom; const heatAfterContinue = w.heat; rollerState.open = false; const explModal = document.querySelector(".mount-modal-backdrop"); const dieGroups = [...explModal.querySelectorAll(".sh-roller-dice")]; const forcedExplosion = { checkDice: dieGroups[0].children.length, damageGroupShown: dieGroups.length > 1, damageDiceCount: dieGroups.length > 1 ? dieGroups[1].children.length : 0 }; [...explModal.querySelectorAll("button")].find(b => b.textContent === "OK").click(); const rg = rigFlags(); rg.active["drones:0"] = true; sheetTab = "rigging"; renderSheet(); const droneCard = () => [...document.querySelectorAll(".sh-unit")].find(x => /Pulse Rifle/.test(x.textContent)); const droneFireBtn = () => [...droneCard().querySelectorAll("button")].find(b => b.textContent === "Fire"); const mountFireExists = !!droneFireBtn(); droneFireBtn().click(); await new Promise(r => setTimeout(r, 20)); const gunState = CHAR.play.rigging.units["drones:0"].guns[0]; const mountHeatAfterFire = gunState.heat; rollerState.open = false; newRound(); const mountHeatAfterNewRound = gunState.heat; w.heat = 0; playChanged(); newRound(); const personalHeatFloorsAtZero = w.heat; await closeTabByName("QA Overheat"); return { defaultHeatIsZero, aimedExists, safeFireNoWarning, heatAfterSafeFire, warningText, cancelNoHeatChange, cancelNoModal, heatAfterContinue, forcedExplosion, mountFireExists, mountHeatAfterFire, mountHeatAfterNewRound, personalHeatFloorsAtZero }; })()

- **Expected:**

      { "defaultHeatIsZero": true, "aimedExists": true, "safeFireNoWarning": true,
        "heatAfterSafeFire": 1,
        "warningText": "Gun Overheated, if you fire, roll 1d6 after the attack. If any dice come up a 1, it explodes dealing 18d6 damage.",
        "cancelNoHeatChange": true, "cancelNoModal": true, "heatAfterContinue": 4,
        "forcedExplosion": { "checkDice": 1, "damageGroupShown": true, "damageDiceCount": 18 },
        "mountFireExists": true, "mountHeatAfterFire": 3, "mountHeatAfterNewRound": 2,
        "personalHeatFloorsAtZero": 0 }

- **Note:** Issue #92. Heat now defaults to 0 (`defaultHeatIsZero`), not the
  old 1 — the bug the issue opened with. Firing while under Max Heat
  (Neon Fang LS: Heat 1/Max 3) is silent — no warning, heat just ticks up
  (`safeFireNoWarning`, `heatAfterSafeFire` 1).

  Pushed to Heat 3 (== Max), firing warns instead of refusing: the modal's
  text is the issue's own wording verbatim, with the actual d6 count
  computed as how far THIS shot would carry the gun over the cap — clarified
  with the user as `max(1, (cur + per) - max)`, floored at 1. "Cancel"
  charges nothing at all (`cancelNoHeatChange`, and no action or roll either
  — not captured here only because they're already covered by `spendAction`
  short-circuiting before `openRoll`/`applyHeat` run). "Continue to Fire"
  charges Heat (`heatAfterContinue` 4 = 3 + 1), opens the attack roll, and
  THEN rolls the explosion check — forced deterministic here by stubbing
  `Math.random` to 0 so every d6 reads 1, proving both halves of the payoff:
  the 1-die check itself, and the follow-on 18d6 damage roll it triggers.

  The drone's Pulse Rifle mount (Heat 3/Heat Limit 15) gets the same Fire
  button, on station, off the Rigging Exploit Action pool
  (`mountFireExists`, `mountHeatAfterFire` 3 = 0 + 3). Looked up via
  `droneCard` (a `.sh-unit` card, not a `<tr>`) since #94 moved a mount's
  fire controls onto the drone/vehicle's own card in the main list.

  `mountHeatAfterNewRound` (2 = 3 − 1) and `personalHeatFloorsAtZero` (heat
  set to 0, New Round leaves it at 0, not −1) both exercise
  `decrementAllHeat()` — one point off every Heat counter in the game each
  round, floored at 0, walking personal weapons and every rigging unit's
  mounts alike.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Wrapping up

Every case should PASS. P06-001, P06-005, P06-009, P06-010 and P06-011 were all
JUDGEMENT before the first round of rulings (JC-012, JC-013, JC-011, JC-010);
each is now a correctness case for the ruled behaviour, joined by the new
P06-001b.

P06-011 is the load-bearing one. If `budget.remaining` moves when you buy
something in play, the chargen/play split has broken and every "my cash is wrong
after going back to chargen" report is live again.

P06-018 to P06-022 cover the other half of that line, and **P06-018 is the one
to run first if anything here looks wrong.** P06-011 proves a play *purchase*
can't reach the creation budget; P06-018 proves nothing else can either. It is
the case the whole `play.kit` refactor exists to keep passing, and a single
`CHANGED` in its output means the shared-object bug is back.

P06-015 to P06-017 are the lifestyle set, added 2026-08-05 after a real
character (Jimmy Chan) turned up showing 4 prepaid months against a chargen
record of 1. They cover the two independent causes: a sync that never
reconciled a corrected chargen record, and a free `+` on the play counter
sitting next to a button that charges for the same month. P06-016 is the one to
watch — it is the only case that would notice the play sheet handing out paid
goods for nothing.

### P06-081: Chargen lifestyle months apply as a change, a move-out sticks, and prepaid months settle
- **Type:** correctness
- **Steps:** none.
- **Check:**

      (async () => { window.alert = () => {}; window.confirm = () => true; const mk = async (n, ls) => { const c = RULES.defaultCharacter(); c.name = n; c.priorities = { heritage: 1, magic: 0, attributes: 5, skills: 4, resources: 0 }; c.heritage.type = "Human"; c.finalized = true; c.lifestyles = ls; await openCharacter(c); }; const months = n => (CHAR.play.lifestyles.find(l => l.name === n) || {}).months; const names = () => CHAR.play.lifestyles.map(l => l.name); const modal = re => [...document.querySelectorAll(".mount-modal button")].find(x => re.test(x.textContent)).click(); await mk("QA LS Sync", [{ name: "Middle", months: 7 }]); CHAR.play.lifestyles.push({ name: "High", months: 0, active: false }); for (let i = 0; i < 3; i++) { CHAR.play.lifestyles.find(l => l.name === "High").months += 1; logCash("Prepaid 1 month of High lifestyle", -lifestyleMonthlyCost("High"), { kind: "lifestyle_month", name: "High" }); } playChanged(); CHAR.lifestyles.push({ name: "High", months: 0 }); syncChargenLifestyles(); const chargenZeroKeepsPlayMonths = months("High"); CHAR.lifestyles.find(l => l.name === "High").months = 2; syncChargenLifestyles(); const chargenBuysTwoMore = months("High"); syncChargenLifestyles(); const idempotentResync = months("High"); CHAR.play.lifestyles.find(l => l.name === "High").months = 1; syncChargenLifestyles(); const burntMonthsStayBurnt = months("High"); await closeTabByName("QA LS Sync"); await mk("QA LS Drop", [{ name: "Middle", months: 7 }, { name: "Wealthy", months: 2 }]); const at = CHAR.play.lifestyles.findIndex(l => l.active); const cashBefore = CHAR.play.cash; const p = removeLifestyle(at); await new Promise(r => setTimeout(r, 20)); modal(/^Refund/); await p; const refunded = CHAR.play.cash - cashBefore; const expectedRefund = 7 * lifestyleMonthlyCost("Middle"); const afterMoveOut = names(); const activeMovedOn = (CHAR.play.lifestyles.find(l => l.active) || {}).name; const droppedList = [...(CHAR.play.lifestyles_dropped || [])]; syncChargenLifestyles(); const stillGoneAfterResync = names(); await playChangedRecalc(); const etiquetteFollowsFlag = CALC.etiquette_points.adjust.Street || 0; const ledgerTop = CHAR.play.cash_log[0].label; await undoCashSpend(CHAR.play.cash_log[0]); const undoRestores = names(); const undoTakesCashBack = CHAR.play.cash === cashBefore; await closeTabByName("QA LS Drop"); return { chargenZeroKeepsPlayMonths, chargenBuysTwoMore, idempotentResync, burntMonthsStayBurnt, refunded, expectedRefund, afterMoveOut, activeMovedOn, droppedList, stillGoneAfterResync, etiquetteFollowsFlag, ledgerTop, undoRestores, undoTakesCashBack }; })()

- **Expected:**

      { "chargenZeroKeepsPlayMonths": 3, "chargenBuysTwoMore": 5,
        "idempotentResync": 5, "burntMonthsStayBurnt": 1,
        "refunded": 5600, "expectedRefund": 5600,
        "afterMoveOut": ["Wealthy"], "activeMovedOn": "Wealthy",
        "droppedList": ["Middle"], "stillGoneAfterResync": ["Wealthy"],
        "etiquetteFollowsFlag": 1,
        "ledgerTop": "Moved out of Middle lifestyle (7 mo refunded)",
        "undoRestores": ["Middle", "Wealthy"], "undoTakesCashBack": true }

- **Note:** Issue #93. `syncChargenLifestyles()` applies what CHANGED in the
  chargen record, never the chargen total. The two numbers count different
  things — chargen months are what creation cash bought, play months are what
  is LEFT plus whatever play prepaid since — so overwriting one with the other
  threw away every month bought on the Gear tab.
  `chargenZeroKeepsPlayMonths` is the reported bug exactly: a chargen entry
  sitting at 0 (the chargen stepper's own minimum, app.js) zeroed three
  months that had been paid for, leaving the prepays visible in the Activity
  log and `0 mo` in both the lifestyle card and the header.

  The other three guard the delta rule's edges: a chargen purchase of 2 more
  months ADDS to play's total rather than replacing it
  (`chargenBuysTwoMore`), a re-sync with nothing changed in chargen is a
  no-op (`idempotentResync` — what a re-finalize that didn't touch lifestyles
  must do), and months burned in play are not handed back by the next sync
  (`burntMonthsStayBurnt`).

  Moving out is the second half. `droppedList` records it by name, which is
  what makes `stillGoneAfterResync` hold — the chargen record still lists
  Middle and always will, so without that record the next sync reads "chargen
  has it, play doesn't" and hands the lifestyle straight back, which is the
  "older/redundant lifestyles reappearing" users kept reporting.
  `activeMovedOn` covers dropping the one being lived in: the header select,
  the card's current-effect callout and the engine's lifestyle bonus all read
  the active flag, and `etiquetteFollowsFlag` (Wealthy's +1 to every
  etiquette, `CALC.etiquette_points.adjust`) confirms the flag's move is
  mechanically live, not just cosmetic.

  Prepaid months are money already handed over, so a move-out settles them
  instead of binning them (the issue's own side note — its reporter had to
  adjust their cash by hand). `refunded` matches 7 months × Middle's monthly
  cost, and the whole thing rides the existing `lifestyle_restore` undo, so
  one Undo puts the lifestyle back at its old index with its months intact
  AND takes the refund away again (`undoRestores`, `undoTakesCashBack`).
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED


### P06-082: Hotseat lives on the linked unit itself, sorted to the top of its list
- **Type:** correctness
- **Steps:** none.
- **Check:**

      (async () => { window.alert = () => {}; window.confirm = () => true; const c = RULES.defaultCharacter(); c.name = "QA Hotseat94"; c.priorities = { heritage: 1, magic: 0, attributes: 5, skills: 4, resources: 0 }; c.heritage.type = "Human"; c.skills = { "Fly": 4, "Drive": 2 }; c.drones = [{ name: "Roto-Drone", weapons: [], mods: [] }, { name: "Orb", weapons: [], mods: [] }, { name: "Bug-Spy", weapons: [], mods: [] }, { name: "Disc", weapons: [], mods: [] }]; c.vehicles = [{ name: "Speedboat", weapons: [], mods: [] }]; c.rigs = [{ name: "Master VCR", mods: [] }]; c.finalized = true; c.lifestyles = [{ name: "Squatter", months: 1 }]; await openCharacter(c); const rg = rigFlags(); rg.active["drones:1"] = true; rg.linked["drones:2"] = true; rg.linked["drones:3"] = true; rg.hotseat["drones:3"] = true; playChanged(); sheetTab = "rigging"; renderSheet(); const oldCardGone = ![...document.querySelectorAll(".sh-card")].some(x => /^Active drones & vehicles$/.test(((x.querySelector("h3")||{}).textContent||"").trim())); const cardTitles = [...document.querySelectorAll(".sh-card h3")].map(h => h.textContent.trim()); const vcrIdx = cardTitles.indexOf("Vehicle Control Rigs"); const dronesIdx = cardTitles.findIndex(t => /^Drones/.test(t)); const vcrBeforeDrones = vcrIdx >= 0 && dronesIdx > vcrIdx; const vcrCard = [...document.querySelectorAll(".sh-card")].find(x => (x.querySelector("h3")||{}).textContent.trim() === "Vehicle Control Rigs"); const vcrCardHints = [...vcrCard.querySelectorAll("p.hint")].map(p => p.textContent); const droneCard = [...document.querySelectorAll(".sh-card")].find(x => /^Drones/.test((x.querySelector("h3")||{}).textContent.trim())); const droneOrder = [...droneCard.querySelectorAll(".sh-unit-title b")].map(b => b.textContent); const unitCards = [...droneCard.querySelectorAll(".sh-unit")]; const hotseatLabelOf = card => [...card.querySelectorAll("label")].map(l => l.textContent.trim()).find(t => t === "Hotseat"); const hotseatVisibility = unitCards.map(uc => ({ name: (uc.querySelector(".sh-unit-title b")||{}).textContent, hasHotseatToggle: !!hotseatLabelOf(uc) })); const bugSpyCard = unitCards.find(uc => /Bug-Spy/.test(uc.textContent)); const bugSpyHotseatCb = [...bugSpyCard.querySelectorAll("input[type=checkbox]")].find(cb => cb.closest("label").textContent.trim() === "Hotseat"); const bugSpyHotseatBefore = !!rg.hotseat["drones:2"]; bugSpyHotseatCb.click(); await new Promise(r => setTimeout(r, 30)); const bugSpyHotseatAfter = !!CHAR.play.rigging.hotseat["drones:2"]; const vehCard = [...document.querySelectorAll(".sh-card")].find(x => /^Vehicles/.test((x.querySelector("h3")||{}).textContent.trim())); const boatCard = [...vehCard.querySelectorAll(".sh-unit")].find(uc => /Speedboat/.test(uc.textContent)); const boatHasHotseatBeforeLink = !!hotseatLabelOf(boatCard); const boatLinkCb = [...boatCard.querySelectorAll("input[type=checkbox]")].find(cb => cb.closest("label").textContent.trim().includes("VCR")); boatLinkCb.click(); await new Promise(r => setTimeout(r, 30)); const boatCard2 = [...document.querySelectorAll(".sh-card")].find(x => /^Vehicles/.test((x.querySelector("h3")||{}).textContent.trim())).querySelectorAll(".sh-unit")[0]; const boatHasHotseatAfterLink = !!hotseatLabelOf(boatCard2); await closeTabByName("QA Hotseat94"); return { oldCardGone, vcrBeforeDrones, vcrCardHints, droneOrder, hotseatVisibility, bugSpyHotseatBefore, bugSpyHotseatAfter, boatHasHotseatBeforeLink, boatHasHotseatAfterLink }; })()

- **Expected:**

      { "oldCardGone": true, "vcrBeforeDrones": true,
        "vcrCardHints": [
          "3 deployed · 1 of 4 cores flying · 2 of 4 VCR links used",
          "Anything on a VCR link or ticked Active. Hotseat marks the ones you're piloting — up to the Master VCR's 4 cores. Each seat's stats and guns move to the Overview, above your own weapons, and its rolls gain +6d."
        ],
        "droneOrder": ["Disc", "Bug-Spy", "Orb", "Roto-Drone"],
        "hotseatVisibility": [
          { "name": "Disc", "hasHotseatToggle": true },
          { "name": "Bug-Spy", "hasHotseatToggle": true },
          { "name": "Orb", "hasHotseatToggle": false },
          { "name": "Roto-Drone", "hasHotseatToggle": false }
        ],
        "bugSpyHotseatBefore": false, "bugSpyHotseatAfter": true,
        "boatHasHotseatBeforeLink": false, "boatHasHotseatAfterLink": true }

- **Note:** Issue #94. The Rigging tab's separate "Active drones & vehicles"
  rollup (`unitLoadoutTable(activeUnits, "station")`) is gone
  (`oldCardGone`); its deployment summary and explanatory paragraph moved
  into the Vehicle Control Rigs card instead, right above the drone/vehicle
  lists (`vcrBeforeDrones`, `vcrCardHints` — the same text, word for word,
  the old card's header used to carry).

  Four drones cover the four states the sort has to tell apart: Disc is
  Hotseat, Bug-Spy is Linked (not seated), Orb is Active off-link, and
  Roto-Drone is owned but stored. `droneOrder` — read off each unit card's
  own title, in DOM order — is exactly Hotseat, Linked, Active, stored, which
  is the tier order asked for, not just "deployed before stored": Bug-Spy
  outranks Orb despite `rg.active` never being set for it, because a linked
  unit counts as deployed on its own (a vehicle, which never carries a
  separate Active flag at all, would fall to the sort's default tier
  forever if Linked didn't outrank Active by itself).

  `hotseatVisibility` is the toggle's new placement: it rides the unit card
  itself now, shown only once the unit is actually Linked — Disc and
  Bug-Spy get it, Orb (off-link) and Roto-Drone (stored) don't. This is a
  narrowing from before #94, when the toggle rendered for anything on
  station (linked OR active); an off-link Active drone runs autonomously by
  definition, so there was never a rig to jack into. `bugSpyHotseatBefore`/
  `After` confirms the relocated toggle still writes the same
  `CHAR.play.rigging.hotseat` flag the rest of the engine reads.

  The toggle isn't drone-only: `boatHasHotseatBeforeLink`/`AfterLink` links
  the Speedboat live and watches the Hotseat toggle appear on the same
  render, proving it follows `isLinked` reactively rather than only at
  card-build time, and that vehicles get it exactly like drones do.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-083: Owned and carried track separately for a Thrown weapon, and Attack spends only what's carried
- **Type:** correctness
- **Steps:** none.
- **Check:**

      (async () => { const c = RULES.defaultCharacter(); c.name = "QA Thrown95"; c.priorities = { heritage: 2, magic: 0, attributes: 3, skills: 2, resources: 3 }; c.heritage.type = "Human"; c.skills = { "Throwing Weapons": 3 }; c.weapons = [{ name: "Explosive Grenade", mods: [], equipped: true, qty: 3, carried_qty: 2, hand: 0 }]; c.finalized = true; c.lifestyles = [{ name: "Squatter", months: 1 }]; await openCharacter(c); sheetTab = "overview"; renderSheet(); const gren = () => allWeapons()[0]; const findAttack = () => [...document.querySelectorAll(".sh-hand-card button")].find(b => b.textContent.trim() === "Attack"); const closeRoller = () => { const d = document.querySelector(".sh-roller"); if (d) { const x = [...d.querySelectorAll("button")].find(b => b.title === "Close"); if (x) x.click(); } }; const before = { owned: ownedQty(gren()), carried: carriedQty(gren()) }; findAttack().click(); closeRoller(); renderSheet(); const afterFirst = { owned: ownedQty(gren()), carried: carriedQty(gren()) }; findAttack().click(); closeRoller(); renderSheet(); const afterSecond = { owned: ownedQty(gren()), carried: carriedQty(gren()) }; const dryBtn = findAttack(); const dry = { disabled: dryBtn.disabled, title: dryBtn.title }; sheetTab = "gear"; renderSheet(); const row = [...document.querySelectorAll("#gear-weapons table tr")].find(tr => tr.textContent.includes("Explosive Grenade")); const steppers = [...row.querySelectorAll(".stepper")]; const gearReadout = { qty: steppers[0].querySelector(".sv").textContent, carried: steppers[1].querySelector(".sv").textContent }; steppers[1].querySelectorAll("button")[1].click(); renderSheet(); const restored = { owned: ownedQty(gren()), carried: carriedQty(gren()) }; sheetTab = "overview"; renderSheet(); const reenabled = !findAttack().disabled; sheetTab = "gear"; renderSheet(); const tab = activeTabObj(); tab.readonly = true; renderSheet(); const roRow = [...document.querySelectorAll("#gear-weapons table tr")].find(tr => tr.textContent.includes("Explosive Grenade")); const roText = roRow.textContent.includes("Qty 3 (1 carried)"); const roNoControls = roRow.querySelectorAll(".stepper").length === 0; tab.readonly = false; await closeTabByName("QA Thrown95"); return { before, afterFirst, afterSecond, dry, gearReadout, restored, reenabled, roText, roNoControls }; })()

- **Expected:**

      { "before": { "owned": 3, "carried": 2 },
        "afterFirst": { "owned": 3, "carried": 1 },
        "afterSecond": { "owned": 3, "carried": 0 },
        "dry": { "disabled": true,
          "title": "None carried — carry one on the Gear tab before throwing another" },
        "gearReadout": { "qty": "3", "carried": "0" },
        "restored": { "owned": 3, "carried": 1 },
        "reenabled": true, "roText": true, "roNoControls": true }

- **Note:** Reported gap: a Thrown weapon (grenade, knife, shuriken) only had
  a Qty stepper, so there was no way to say "I own 3 but I'm only carrying 2
  today" — and pressing Attack didn't touch either number, so a thrown
  grenade never actually left the stack.

  Qty and Carried are now the same pair a stacked misc-gear row already gets
  (`shUsesStepper` / `shCarriedStepper`, `ownedQty` / `carriedQty` in
  app.js) — Qty is the total owned, Carried is what's on you and is what
  Attack draws from. `before`→`afterFirst`→`afterSecond` presses the
  Overview hand card's Attack button twice: `owned` never moves, `carried`
  drops 2→1→0. This is deliberate, not an oversight — see
  `attackButton`'s `consumeCarried`: what stays in a locker at the safehouse
  isn't in your hand to throw, but it's still yours, so Qty is untouched and
  only Carried spends.

  `dry` is the empty-carried state: the button disables (rather than
  vanishing) once nothing is left in hand, the same "still there as a
  reminder to restock" idiom `shUseDoseBtn` uses for an empty dose stack —
  and its title says why. `gearReadout` confirms the Gear tab's Weapons
  table shows the same two numbers live (Qty 3 unmoved, Carried 0). Clicking
  Carried's own `+` there (not Qty) restores it to 1 (`restored`) and the
  Overview button re-enables on its own (`reenabled`) — Qty and Carried
  never touch each other except that Carried can't exceed Qty.

  `roText`/`roNoControls` is the read-only reader's view: a plain "Qty 3 (1
  carried)" line, no steppers — matching how every other owned/carried gear
  row degrades for a shared read-only character.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-084: A Thrown weapon's Conceal follows what's carried, not the whole owned stack
- **Type:** correctness
- **Steps:** none.
- **Check:**

      (async () => { const c = RULES.defaultCharacter(); c.name = "QA Conceal96"; c.priorities = { heritage: 2, magic: 0, attributes: 3, skills: 2, resources: 3 }; c.heritage.type = "Human"; c.skills = { "Firearms": 3, "Subterfuge": 3 }; c.weapons = [{ name: "Ares TAG-1 Taser", mods: [], equipped: true }, { name: "Explosive Grenade", mods: [], equipped: true, qty: 5, carried_qty: 3 }]; c.finalized = true; c.lifestyles = [{ name: "Squatter", months: 1 }]; await openCharacter(c); sheetTab = "overview"; renderSheet(); const readConceal = () => { const el = document.querySelector(".sh-conceal b"); return el ? el.textContent.trim() : null; }; const withStash = readConceal(); const gren = allWeapons().find(w => w.name === "Explosive Grenade"); setCarriedQty(gren, 0); playChanged(); renderSheet(); const withNoneCarried = readConceal(); setCarriedQty(gren, 2); playChanged(); renderSheet(); const restored = readConceal(); await closeTabByName("QA Conceal96"); return { withStash, withNoneCarried, restored }; })()

- **Expected:**

      { "withStash": "4 / 3", "withNoneCarried": "2 / 3", "restored": "4 / 3" }

- **Note:** Reported gap: Conceal read as if it were based on how many
  grenades were *owned*, not how many were actually *carried* — because
  `concealCallout()` only ever checked `equipped !== false`, and for a
  Thrown weapon's single stacked entry that flag says "this stack is part
  of the loadout at all," not "one of these is on me right now." Setting
  Carried to 0 left the entry still equipped, so its Conceal kept counting.

  The Taser (Conceal 2, always genuinely carried — a gun has no owned/
  carried split) and the grenade stack (Conceal 2, carried_qty 3 of 5
  owned) both count while something is carried: `withStash` is `4 / 3`, the
  sum of both. Zeroing the grenade's Carried count — leaving `equipped`
  untouched, only `carried_qty` changes — drops the total to just the
  Taser's 2 (`withNoneCarried`), proving the stash sitting at home no
  longer contributes. Setting Carried back to 2 restores `4 / 3`
  (`restored`), confirming it tracks live rather than latching.

  A character carrying nothing at all still returns `null` from
  `concealCallout()` (no card at all — see the function's own doc comment),
  which this case doesn't re-litigate; it's the *partial* case — one gun
  worn, one stack left home — that the old code got wrong.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED
