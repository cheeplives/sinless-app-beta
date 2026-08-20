# P09 — Homebrew packs and custom content

**Preconditions for every case:** P00 complete.
**Effort:** 55 min. **Fixture:** none.

Homebrew rows are spliced into `DATA_BUNDLE.tables` at boot by
`mergeCustomContent()` and are then indistinguishable from core data to the rest
of the app. They get priced, they drive engine branches, and **nothing validates
their column values**. This pass establishes what a malformed pack can do.

Precedence is core > my packs > subscriptions, first writer of a name wins, and
losers are dropped silently into `HB_COLLISIONS`.

**These cases create homebrew content.** Clean up at the end — the cleanup block
is not optional, and a leftover QA pack will confuse every later pass.

---

### P09-001: Establish the baseline
- **Type:** correctness
- **Check:**

      (() => ({ packs: HB_PACKS.length, subs: HB_SUBS.length, collisions: HB_COLLISIONS.length, customWeapons: DATA.tables.weapons.filter(w => w.Custom === "Y").length, tables: Object.keys(HOMEBREW_CONFIG).length }))()

- **Expected:** on a clean install, `{ "packs": 0, "subs": 0, "collisions": 0, "customWeapons": 0, "tables": 18 }`
- **Note:** `tables` counts editor TABS, which is one more than the 17
  homebrew-eligible data.js tables: Ammo and Gear are two views of
  `misc_gear` (P09-014).
- **Note:** If `packs` is non-zero you have real homebrew here. Record the
  starting numbers and compare against them rather than against zero.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P09-002: A homebrew weapon appears in the game data and gets priced
- **Type:** correctness
- **Check:**

      (async () => { const row = { Weapon: "QA Test Rifle", Type: "Rifle", ZR: "2", Cost: "1000", Accuracy: "2", Reach: "Ranged", Damage: "6", "Firing modes": "SS", Ammo: "10", Pen: "3", Bar: "4", Conceal: "3", Weight: "2", Rarity: "1", Custom: "Y" }; DATA.tables.weapons.push(row); const c = RULES.defaultCharacter(); c.priorities = { heritage:1, magic:2, attributes:3, skills:4, resources:0 }; c.heritage.type = "Human"; c.lifestyles = [{ name: "Squatter", months: 1 }]; c.weapons = [{ name: "QA Test Rifle", smart: false, mods: [], equipped: true, qty: 1 }]; const k = RULES.calculate(c); const w = k.weapons[0]; return { found: !!w, Pen: w && w.Pen, Bar: w && w.Bar, spent: k.budget.spent, gearZr: k.zoetics.gear_zr }; })()

- **Expected:** `{ "found": true, "Pen": "3", "Bar": "4", "spent": 1000, "gearZr": 2 }`
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P09-003: Missing numeric columns read as zero, and the editor says so
- **Type:** correctness
- **Check:**

      (async () => { const row = { Weapon: "QA Malformed", Type: "Rifle", Custom: "Y" }; DATA.tables.weapons.push(row); const c = RULES.defaultCharacter(); c.priorities = { heritage:1, magic:2, attributes:3, skills:4, resources:0 }; c.heritage.type = "Human"; c.lifestyles = [{ name: "Squatter", months: 1 }]; c.weapons = [{ name: "QA Malformed", smart: false, mods: [], equipped: true, qty: 1 }]; const k = RULES.calculate(c); return { spent: k.budget.spent, gearZr: k.zoetics.gear_zr, errors: k.errors, warnings: k.warnings, weapon: k.weapons[0] }; })()

- **Expected:** the weapon is accepted, costs `0`, contributes `0` ZR, and
  produces **no** error or warning.
- **Also check** (the editor half, which is where JC-022 landed):

      (() => hbMissingColumns("weapons", { Weapon: "QA Malformed", Type: "Rifle", Custom: "Y" }))()

- **Expected:** `["Cost", "Damage"]`.
- **Note:** JC-022, ruled **C**. The *engine* is unchanged and this case still
  passes as written — a row with almost no columns is still a perfectly good free
  weapon, because the free-form data model is deliberate and a placeholder row is
  a reasonable thing to want. What changed is upstream: `HOMEBREW_REQUIRED` lists
  the columns each table's rows genuinely need, saving a row that leaves any of
  them blank asks for confirmation and says what it will read as, and the row
  list marks it in amber. Nothing blocks; only the name is genuinely required.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P09-004: A homebrew Ban column drives a real engine branch
- **Type:** correctness
- **Check:**

      (async () => { const a = { Name: "QA Banning Augment", Type: "Cyberware", ZR: "1", Cost: "100", Ban: "Smartlink", Custom: "Y" }; DATA.tables.augments.push(a); const c = RULES.defaultCharacter(); c.priorities = { heritage:1, magic:2, attributes:3, skills:4, resources:0 }; c.heritage.type = "Human"; c.lifestyles = [{ name: "Squatter", months: 1 }]; c.augments = [{ name: "QA Banning Augment", count: 1, target: "", slotted: false, alpha: false }, { name: "Smartlink", count: 1, target: "", slotted: false, alpha: false }]; return RULES.calculate(c).errors; })()

- **Expected:** an error naming the conflict between the two augments.
- **Note:** User-authored text in a `Ban` column can make core augments
  uninstallable. That is powerful and intended, but confirm a *typo* in that
  column fails safe (no error) rather than banning something unrelated.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P09-005: A name colliding with a core row is dropped, and reported
- **Type:** correctness
- **Check:**

      (() => { const before = DATA.tables.weapons.filter(w => /^Katana$/i.test(w.Weapon)).length; const dup = { Weapon: "katana", Type: "Melee", Damage: "99", Cost: "0", Custom: "Y" }; const merged = [...DATA.tables.weapons]; const seen = new Set(merged.map(w => String(w.Weapon).toLowerCase())); const wouldDrop = seen.has(dup.Weapon.toLowerCase()); return { coreCount: before, wouldDrop, collisionsRecorded: HB_COLLISIONS.length }; })()

- **Expected:** `{ "coreCount": 1, "wouldDrop": true, "collisionsRecorded": <n> }`
- **Also check** (the UI half, which is where JC-022 landed): add a weapon named
  `katana` to a pack, then open **Homebrew**. A card headed **"Not merged — name
  already taken"** lists it with its table and pack.
- **Note:** JC-022, ruled **C**. The drop itself is unchanged — first writer of a
  name wins, core > my packs > subscriptions — and this case still records that.
  What changed is that `HB_COLLISIONS` finally has a UI, covering every pack
  rather than just the active one. It was the more confusing of the two failure
  modes JC-022 covered: content that simply never appears while the row sits in
  the editor looking fine.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P09-006: Imported packs are field-whitelisted
- **Type:** security
- **Check:**

      (() => { const cfg = HOMEBREW_CONFIG.weapons; const allowed = cfg.fields.map(f => f.key); return { hasBar: allowed.includes("Bar"), hasWeapon: allowed.includes("Weapon"), rejectsProto: !allowed.includes("__proto__"), rejectsReadOnly: !allowed.includes("ReadOnly"), rejectsPackId: !allowed.includes("PackId"), fieldCount: allowed.length }; })()

- **Expected:** `hasBar` and `hasWeapon` are `true`; all three `rejects*` are
  `true`.
- **Note:** `mergePackData` rebuilds each row from this whitelist and coerces
  every value to a trimmed string, so an imported file cannot inject `__proto__`
  or forge the `ReadOnly` / `PackId` / `Custom` markers.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P09-007: Subscribed pack rows bypass that whitelist
- **Type:** security
- **Check:** read `mergeCustomContent` in `static/homebrew.js` and confirm the
  subscription branch spreads the foreign row (`{...row, ...}`) rather than
  passing it through `mergePackData`.

      (() => { const src = mergeCustomContent.toString(); return { spreadsRawRow: /\.\.\.row/.test(src), callsMergePackData: /mergePackData/.test(src), stampsAfterSpread: /ReadOnly/.test(src) }; })()

- **Expected:** `spreadsRawRow` is `true` and `callsMergePackData` is `false` —
  i.e. subscription rows are **not** whitelisted.
- **Note:** The markers `Custom`, `PackId`, `ReadOnly` and `Source` are assigned
  *after* the spread, so a hostile pack cannot forge those. It can still carry
  arbitrary extra keys. Impact is data shape, not code execution — nothing in
  the render path executes a field value. Mark **JUDGEMENT** and describe what
  you found; do not claim an XSS without demonstrating one (see P11).
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P09-008: Homebrew rows render as text, not markup
- **Type:** security
- **Check:**

      (async () => { window.__xss = undefined; const row = { Weapon: '"><img src=x onerror=window.__xss=1>', Type: "Rifle", Cost: "100", Damage: "1", Pen: "0", Bar: "0", Custom: "Y" }; DATA.tables.weapons.push(row); const c = RULES.defaultCharacter(); c.priorities = { heritage:1, magic:2, attributes:3, skills:4, resources:0 }; c.heritage.type = "Human"; c.lifestyles = [{ name: "Squatter", months: 1 }]; c.name = "QA HB XSS"; await openCharacter(c); CHAR.finalized = false; activeTab = "weapons"; await recalc(); renderTabs(); renderPanel(); await new Promise(r => setTimeout(r, 200)); return { xssFired: window.__xss, imgCount: document.querySelectorAll("#panel img").length, nameAppearsAsText: document.getElementById("panel").textContent.includes("onerror=window.__xss=1") }; })()

- **Expected:** `{ "xssFired": undefined, "imgCount": 0, "nameAppearsAsText": true }`
- **Note:** The payload must appear as visible text and never as an element. A
  non-zero `imgCount` or a defined `xssFired` is a **critical FAIL** — report it
  immediately, do not finish the pass first.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P09-009: The editor exposes every column its tables carry
- **Type:** correctness
- **Check:**

      (() => { const skip = new Set(["Custom", "PackId", "ReadOnly", "Source"]); const gaps = {}; for (const [key, cfg] of Object.entries(HOMEBREW_CONFIG)) { const fields = new Set(cfg.fields.map(f => f.key)); const cols = new Set(); for (const row of DATA.tables[key] || []) for (const c of Object.keys(row)) if (!skip.has(c)) cols.add(c); const missing = [...cols].filter(c => !fields.has(c)).sort(); if (missing.length) gaps[key] = missing; } return { tables: Object.keys(HOMEBREW_CONFIG).length, gaps }; })()

- **Expected:**

      { "tables": 16, "gaps": {} }

- **Note:** This is the invariant that keeps homebrew able to author the same
  gear the core data uses. A column in `data.js` that `HOMEBREW_CONFIG` omits is
  invisible **twice**: the editor can't set it, and `mergePackData` rebuilds
  imported rows from the field whitelist (P09-006), so a pack carrying that
  column loses it on import. The result is a custom row that looks fine and
  quietly behaves differently from the core row it was modelled on.

  Any non-empty `gaps` is a FAIL naming exactly which columns to add. The four
  skipped keys are stamped on by `mergeCustomContent`, not authored.

  `tools/check_data.py` asserts the same thing from the command line and exits 1
  on a gap — run it after any data.js edit. This case is the in-browser mirror,
  and it reads the **merged** tables, so it also catches a subscribed pack that
  introduces a column the editor has no field for.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P09-010: A homebrew augment can raise any of the six attributes
- **Type:** correctness
- **Check:**

      (() => { const row = { Name: "QA Serenity Cortex", Type: "Headware", ZR: "0.5", BI: "0", Cost: "5000", Willpower: "2", Charisma: "1", Custom: "Y" }; DATA.tables.augments.push(row); const c = RULES.defaultCharacter(); c.priorities = { heritage:1, magic:0, attributes:4, skills:2, resources:3 }; c.heritage.type = "Human"; c.lifestyles = [{ name: "Squatter", months: 1 }]; for (const a of RULES.ATTRIBUTES) c.attributes[a] = 3; c.augments = [{ name: "QA Serenity Cortex" }]; const k = RULES.calculate(c); const editable = HOMEBREW_CONFIG.augments.fields.map(f => f.key); return { will: k.attributes.Willpower.final, cha: k.attributes.Charisma.final, str: k.attributes.Strength.final, allSixEditable: RULES.ATTRIBUTES.every(a => editable.includes(a)) }; })()

- **Expected:**

      { "will": 5, "cha": 4, "str": 3, "allSixEditable": true }

- **Note:** `augmentEffectSums` sums whichever attribute columns a row carries
  and used to iterate a hardcoded four — Strength, Body, Reaction, Intelligence
  — because those are the only ones core augments use. Everything downstream
  (`mergeMountedAugments`, the final-attribute loop) already walked all six, so
  the narrow loop was the only thing making Willpower and Charisma unreachable.

  `str` staying at **3** is half the case: an untouched attribute must gain
  nothing. If every attribute moves, the sum is reading the wrong column.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P09-011: An energy weapon's heat comes from its columns, not its prose
- **Type:** correctness
- **Check:**

      (() => { const core = DATA.tables.weapons.find(w => w.Weapon === "Neon Fang LS"); return { core: heatSpec(core), columnsOnly: heatSpec({ Type: "Energy", Heat: "4", "Max Heat": "12", Notes: "Custom blaster." }), proseOnly: heatSpec({ Type: "Energy", Notes: "Heat 2 / max 8." }), neither: heatSpec({ Type: "Energy", Notes: "No rating." }), dazzleray: heatSpec(DATA.tables.weapons.find(w => w.Weapon === "Aztechnologies Dazzleray")) }; })()

- **Expected:**

      { "core": { "per": 1, "max": 3 }, "columnsOnly": { "per": 4, "max": 12 },
        "proseOnly": { "per": 2, "max": 8 }, "neither": null, "dazzleray": null }

- **Note:** Run this on the **play sheet** — `heatSpec` lives in `sheet.js`.

  The `weapons` table states heat in `Heat` / `Max Heat` columns *and* repeats it
  in `Notes` as "Heat 1 / max 3". The tracker used to read only the prose, so a
  homebrew energy weapon authored through the editor's columns got no tracker at
  all. Columns now win, prose is the fallback, and `core` proves the two agree on
  the shipped rows — if it disagrees with the columns, the data is contradicting
  itself and the row needs fixing, not the parser.

  `dazzleray` is `null` on purpose: it states `-` for both, meaning no heat
  rating, which is different from "unstated".
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P09-012: Homebrew can grant skill dice and situational notes
- **Type:** correctness
- **Check:**

      (() => { const row = { Name: "QA Empathy Weave", Type: "Bioware", ZR: "0.5", BI: "0", Cost: "9000", Body: "1", Charisma: "1", "Skill Bonus": "Fascination +1", "Skill Note": "Shadow: reroll 1s and 2s in urban environments", Custom: "Y" }; DATA.tables.augments.push(row); const typo = { Name: "QA Typo", Type: "Headware", ZR: "0", BI: "0", Cost: "1", "Skill Bonus": "Fascinaton +1", "Skill Note": "Shadow reroll 1s", Custom: "Y" }; DATA.tables.augments.push(typo); const mk = names => { const c = RULES.defaultCharacter(); c.priorities = { heritage:1, magic:0, attributes:4, skills:2, resources:3 }; c.heritage.type = "Human"; c.lifestyles = [{ name: "Squatter", months: 1 }]; for (const a of RULES.ATTRIBUTES) c.attributes[a] = 3; c.skills = { Fascination: 2, Shadow: 2, Observation: 2 }; c.augments = names.map(n => ({ name: n })); return RULES.calculate(c); }; const off = mk([]), on = mk(["QA Empathy Weave"]), sf = mk(["Sound Filter"]); return { before: off.skills.Fascination.final, after: on.skills.Fascination.final, note: on.skills.Shadow.notes, body: on.attributes.Body.final, bodyMax: on.attributes.Body.max, charisma: on.attributes.Charisma.final, soundFilter: sf.skills.Observation.final, typoWarnings: mk(["QA Typo"]).warnings.filter(w => /QA Typo/.test(w)) }; })()

- **Expected:**

      { "before": 2, "after": 3,
        "note": ["reroll 1s and 2s in urban environments (QA Empathy Weave)"],
        "body": 4, "bodyMax": 20, "charisma": 4, "soundFilter": 3,
        "typoWarnings": ["QA Typo: Skill Bonus — no skill called \"Fascinaton\".",
                         "QA Typo: Skill Note — \"Shadow reroll 1s\" is not \"Skill: note\"."] }

- **Note:** `Skill Bonus` ("Fascination +1", comma-separated for several) is flat
  dice folded into the rating; `Skill Note` ("Shadow: reroll 1s/2s in urban
  environments", pipe-separated) is situational text shown beside the skill and
  never summed. Both columns are on **all sixteen** homebrew tables and are read
  from anything the character has active — worn armor, carried gear, equipped
  weapons and their mods, installed and gear-mounted augments, known spells and
  rituals, owned vehicles and drones, and a spirit that is infused or bonded.

  `bodyMax` at **20** is part of the case: attribute columns raise the value, not
  the maximum. Raising the maximum too is a separate opt-in, the `RaisesMax`
  column, and this fixture leaves it unset.

  It used to be that a homebrew augment *could not* raise a maximum at all —
  the engine matched the row's name against a hardcoded `AUGMENTS_THAT_RAISE_MAX`
  prefix list, which no homebrew name would ever be on. Now that it is a column,
  add `RaisesMax: "1"` to this fixture's row and `bodyMax` reads **21** — the
  row's own `Body: "1"` lifting the cap with the value. Worth a spot-check when
  this pass is run: it is the difference between a homebrew row that can express
  what Muscle Replacement does and one that can't.

  `soundFilter` at 3 guards the migration. Sound Filter's +1 Observation used to
  be a hardcoded `names.has("Sound Filter")` check in `rules.js`, alongside four
  situational notes (Rocket Boots, Compartment, Covert Synthskin, Amplification).
  All five now live in their own rows' columns, so core and homebrew go through
  one mechanism. If this reads 2, the migration dropped a core effect.

  `typoWarnings` is the reason these are columns rather than parsed prose: a
  misspelled skill produces a bonus that never lands, so it is reported. Silence
  here means a typo would fail invisibly — the exact bug this mechanism exists
  to prevent.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P09-013: Raising an attribute's maximum is a column, not a name
- **Type:** correctness
- **Check:**

      (() => { const mk = (name, extra) => Object.assign({ Name: name, Type: "Bodyware", ZR: "0.5", BI: "0", Cost: "5000", Custom: "Y" }, extra); const rows = [mk("QA Sinew Weave", { Strength: "2" }), mk("QA Sinew Weave Plus", { Strength: "2", RaisesMax: "1" }), mk("Muscle Replacement QA", { Strength: "2" })]; for (const r of rows) DATA.tables.augments.push(r); const run = n => { const c = RULES.defaultCharacter(); c.priorities = { heritage:1, magic:0, attributes:4, skills:2, resources:3 }; c.heritage.type = "Human"; c.lifestyles = [{ name: "Squatter", months: 1 }]; for (const a of RULES.ATTRIBUTES) c.attributes[a] = 3; c.augments = [{ name: n }]; const k = RULES.calculate(c); return { final: k.attributes.Strength.final, max: k.attributes.Strength.max }; }; const out = { plain: run("QA Sinew Weave"), flagged: run("QA Sinew Weave Plus"), prefixTrap: run("Muscle Replacement QA"), coreRaises: run("Muscle Replacement 2"), coreValueOnly: run("Strength Enhancement 2"), editable: HOMEBREW_CONFIG.augments.fields.some(f => f.key === "RaisesMax") }; for (const r of rows) DATA.tables.augments.pop(); return out; })()

- **Expected:**

      { "plain":         { "final": 5, "max": 20 },
        "flagged":       { "final": 5, "max": 22 },
        "prefixTrap":    { "final": 5, "max": 20 },
        "coreRaises":    { "final": 5, "max": 22 },
        "coreValueOnly": { "final": 5, "max": 20 },
        "editable": true }

- **Note:** Muscle Replacement 3 and Strength Enhancement 3 both give +3
  Strength; only the first lifts the cap with it. That distinction used to be
  `AUGMENTS_THAT_RAISE_MAX`, seven name prefixes matched with `startsWith`, which
  made the row's **name** load-bearing. It is now the `RaisesMax` column.

  Each pair isolates one half of the change:

  - `plain` vs `flagged` — the same homebrew row, differing only in the column.
    20 vs 22 is the capability that did not exist before: no homebrew name was
    ever on the prefix list, so a custom augment simply could not raise a
    maximum. If `flagged` reads 20, the column isn't being read.
  - `prefixTrap` at **20** is the regression guard, and the reason the row is
    named the way it is. Under the old rule `"Muscle Replacement QA".startsWith(
    "Muscle Replacement")` was true and this row would have raised the cap by
    accident. If this reads 22, the prefix matching is back.
  - `coreRaises` / `coreValueOnly` prove the migration preserved core behaviour.
    All 23 rows that raised a maximum still do; the other 131 still don't.

  `final` is **5** in every case (base 3 + the row's 2) — the value bonus is not
  what changed, and if one of these moves, the column is being read as an
  attribute rather than a flag.

  This case cleans up after itself: it pops the three rows it pushed. If it
  throws part-way, `Muscle Replacement QA` will not be caught by the cleanup
  block's `/^QA /` filter — the query below names it explicitly.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P09-014: The Ammo tab is a filtered view of misc_gear, not a table of its own
- **Type:** correctness
- **Check:**

      (() => ({ tabs: Object.keys(HOMEBREW_CONFIG).length, storedTables: [...hbStoredTables().keys()].length, ammoTabStoresInto: hbTableKey("ammo"), gearTabStoresInto: hbTableKey("misc_gear"), ammoRowsShown: DATA.tables.misc_gear.filter(r => HOMEBREW_CONFIG.ammo.rowFilter(r)).length, gearRowsShown: DATA.tables.misc_gear.filter(r => HOMEBREW_CONFIG.misc_gear.rowFilter(r)).length, total: DATA.tables.misc_gear.length }))()

- **Expected:** on a clean install, `{ "tabs": 18, "storedTables": 17, "ammoTabStoresInto": "misc_gear", "gearTabStoresInto": "misc_gear", "ammoRowsShown": 29, "gearRowsShown": 43, "total": 72 }`
- **Note:** Ammunition is `misc_gear` with an `Ammo` Class (#86), so its tab
  declares `table: "misc_gear"` and a `rowFilter`; the Gear tab carries the
  complementary filter. The two counts must **sum to the whole table** — if they
  don't, a row is either hidden from both tabs (unauthorable) or shown in both
  (editable from two places, with two indices into one array). Everything that
  touches stored rows iterates `hbStoredTables()` rather than the tabs, which is
  what keeps `packItemCount`, the merge and the importer from processing
  `misc_gear` twice.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P09-015: A round authored on the Ammo tab stores, merges and loads
- **Type:** correctness
- **Check:**

      (async () => { await hbCreatePack("QA Ammo"); const pack = activePack(); pack.data.misc_gear.push({ Item: "QA Silvered Hollowpoint", Class: "Ammo", Cost: "3000", Rarity: "4", Effect: "Damage +2. Pen -1. Mag -2. Modes -FA. Blessed by somebody.", Notes: "QA authored.", Custom: "Y" }); pack.data.misc_gear.push({ Item: "QA Widget", Class: "Tools", Cost: "50", Custom: "Y" }); hbSave(); const p = activePack(); return { ammoTab: hbTabRows(p, "ammo").map(e => e.row.Item), ammoTabIndices: hbTabRows(p, "ammo").map(e => e.i), gearTab: hbTabRows(p, "misc_gear").map(e => e.row.Item), packCount: packItemCount(p), merged: DATA.tables.misc_gear.filter(r => r.Custom === "Y").map(r => r.Item), mods: RULES.ammoStatMods(DATA.tables.misc_gear.find(r => r.Item === "QA Silvered Hollowpoint").Effect).notes }; })()

- **Expected:** `{ "ammoTab": ["QA Silvered Hollowpoint"], "ammoTabIndices": [0], "gearTab": ["QA Widget"], "packCount": 2, "merged": ["QA Silvered Hollowpoint", "QA Widget"], "mods": ["Blessed by somebody"] }`
- **Note:** `ammoTabIndices` is the load-bearing half: the tab shows a filtered
  list but Edit and Delete write to the index in the **stored** array, so a pack
  holding both kinds must still edit the right row. `packCount` is 2, not 4 —
  proof the shared table isn't counted once per tab.
- **Cleanup:** run the pass's cleanup block below, or
  `hbDeletePack(HB_PACKS.find(p => p.name === "QA Ammo"))`.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Clean up — required

Every case above pushed rows onto the live tables. Reload the page to discard
them, then confirm:

```js
(() => ({ leftovers: DATA.tables.weapons.filter(w => /^QA /i.test(w.Weapon) || /onerror/.test(w.Weapon)).map(w => w.Weapon), augments: DATA.tables.augments.filter(a => /^QA |QA$/i.test(a.Name)).map(a => a.Name) }))()
```

**Expected after reload:** `{ "leftovers": [], "augments": [] }`

Also remove the test character:

```js
(async () => { try { await closeTabByName("QA HB XSS"); } catch (e) {} localStorage.removeItem("sinless:char:QA-HB-XSS"); return "clean"; })()
```

## Wrapping up

Expected JUDGEMENT: **P09-007**. P09-003 and P09-005 were ruled on (JC-022) and
are now correctness cases. P09-008 must PASS — it is the
one case here that would be a security incident rather than a design question.
