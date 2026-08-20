# P02 — Engine: gear, augments and data-apply leaks

**Preconditions for every case:** P00 complete.
**Effort:** 45–60 min. **Fixture:** none except where named.

This pass hunts **data-apply leaks**: a modifier that applies when it should not,
or fails to apply when it should. Most of these cases are deliberately built to
expose an inconsistency rather than a crash, so several are expected to end in
**JUDGEMENT** rather than FAIL. Read the Note under each case before deciding.

Every case uses `resources` priority 4 unless stated. That is not cosmetic — at
lower priorities a cash-overspend error appears and masks whatever the case was
actually testing.

---

## Gear Zoetic Rating: what counts, and when

### P02-001: An unequipped weapon contributes no gear ZR
- **Type:** correctness
- **Check:**

      (() => { const mk = eq => { const c = RULES.defaultCharacter(); c.priorities={heritage:1,magic:2,attributes:3,skills:0,resources:4}; c.heritage.type="Human"; c.lifestyles=[{name:"Squatter",months:1}]; c.weapons=[{name:"Kalishnikov A-80",smart:false,mods:[],equipped:eq,qty:1}]; return RULES.calculate(c).zoetics.gear_zr; }; return { equipped: mk(true), unequipped: mk(false) }; })()

- **Expected:** `{ "equipped": 2, "unequipped": 0 }`
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-002: A deck contributes gear ZR only while carried
- **Type:** correctness
- **Check:**

      (() => { const mk = carried => { const c = RULES.defaultCharacter(); c.priorities={heritage:1,magic:2,attributes:3,skills:0,resources:4}; c.heritage.type="Human"; c.lifestyles=[{name:"Squatter",months:1}]; c.decks=[{name:"MasterDeck",mods:[],carried}]; return RULES.calculate(c).zoetics.gear_zr; }; const legacy = (() => { const c = RULES.defaultCharacter(); c.priorities={heritage:1,magic:2,attributes:3,skills:0,resources:4}; c.heritage.type="Human"; c.lifestyles=[{name:"Squatter",months:1}]; c.decks=[{name:"MasterDeck",mods:[]}]; return RULES.calculate(c).zoetics.gear_zr; })(); return { deckZR: DATA.tables.decks.find(d=>d.Name==="MasterDeck").ZR, carried: mk(true), stashed: mk(false), legacy }; })()

- **Expected:** `{ "deckZR": "1", "carried": 1, "stashed": 0, "legacy": 1 }`
- **Note:** JC-004, ruled **A**. Decks, drones and vehicles now take the same
  permissive `carried !== false` flag misc gear uses, matching P02-001's
  treatment of weapons. `legacy` is the point of the third value: an entry with
  no flag at all — every character predating this — still counts, so nothing
  needed migrating.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-002b: A program counts when it is loaded on the deck
- **Type:** correctness
- **Check:** (lends two programs a ZR and puts it back — none ship with one)

      (() => { const threaded = DATA.tables.programs.find(p => RULES.programNeedsThread(p)); const alwaysOn = DATA.tables.programs.find(p => !RULES.programNeedsThread(p)); const save = [threaded.ZR, alwaysOn.ZR]; threaded.ZR = "1"; alwaysOn.ZR = "2"; const base = () => { const c = RULES.defaultCharacter(); c.priorities={heritage:1,magic:2,attributes:3,skills:0,resources:4}; c.heritage.type="Human"; c.lifestyles=[{name:"Squatter",months:1}]; c.programs=[threaded.Name, alwaysOn.Name]; return c; }; const zr = c => RULES.calculate(c).zoetics.gear_zr; const noDeck = zr(base()); const a = base(); a.decks=[{name:"MasterDeck",mods:[],carried:true}]; const nothingLoaded = zr(a); const b = base(); b.decks=[{name:"MasterDeck",mods:[],carried:true}]; b.play.decking={active_deck:"MasterDeck",loaded:[threaded.Name]}; const loaded = zr(b); const c2 = base(); c2.decks=[{name:"MasterDeck",mods:[],carried:false}]; c2.play.decking={active_deck:"MasterDeck",loaded:[threaded.Name]}; const stashed = zr(c2); threaded.ZR = save[0]; alwaysOn.ZR = save[1]; return { threaded: threaded.Name, alwaysOn: alwaysOn.Name, noDeck, nothingLoaded, loaded, stashed }; })()

- **Expected:** `{ "noDeck": 0, "nothingLoaded": 3, "loaded": 4, "stashed": 0 }`
  with `threaded` `"De-rez 1"` and `alwaysOn` `"Acid Burn 1"`.
- **Note:** JC-004's program half, ruled separately: a program isn't carried, it
  is **part of the deck** — loaded on it or not. `nothingLoaded` is 3 because the
  deck's own ZR is 1 and the always-on program's 2 counts with it: a program
  whose `I/O` is `N/A` or `No` never occupies a thread, so it runs whenever the
  deck does. Loading the threaded one adds its 1. Stash the deck and nothing on
  it counts, loaded or not. Nothing is loaded during creation, so only the
  always-on programs contribute there.

  `RULES.programNeedsThread` is the same predicate the Decking tab's Load button
  uses, so the two can't disagree about what loaded means. In the shipped data
  this is all academic — **no program has a non-zero ZR** — which is why the
  check lends them one.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-002c: A mounted augment duplicating a body one adds
- **Type:** correctness
- **Check:**

      (() => { const mk = (body, mounted) => { const c = RULES.defaultCharacter(); c.priorities={heritage:1,magic:2,attributes:3,skills:0,resources:4}; c.heritage.type="Human"; c.lifestyles=[{name:"Squatter",months:1}]; c.augments = body.map(n => ({ name: n, count: 1 })); c.armor = [{ name: "Power Armor", active: true, extras: [], mounted: mounted.map(n => ({ name: n })) }]; const k = RULES.calculate(c); return { ball: k.combat.ballistic_armor, maxBall: k.combat.max_ballistic, dodge: k.combat.dodge_bonus }; }; const A = "Dermal Plating 3", D = "Covert Synthskin"; return { bodyOnly: mk([A, D], []), mountOnly: mk([], [A, D]), both: mk([A, D], [A, D]) }; })()

- **Expected:**

      { "bodyOnly":  { "ball": 6, "maxBall": 5, "dodge": 1 },
        "mountOnly": { "ball": 6, "maxBall": 5, "dodge": 1 },
        "both":      { "ball": 7, "maxBall": 5, "dodge": 2 } }

- **Note:** JC-006, ruled **everything adds except `ballistic_armor_max`**.
  `dodge` going 1 → 1 → **2** is the ruling: two pieces of hardware do twice the
  work. `maxBall` staying **5** in all three is the exception — it isn't a
  quantity but the best *single* ballistic source, and ballistic armor doesn't
  stack. Dodge, melee exploit actions, damage reduction and skill bonuses all
  used to cap the way `maxBall` still does. Power Armor is the host because its
  `Mount Types` is `Any`.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-003: An owned rig contributes gear ZR during creation
- **Type:** correctness
- **Check:**

      (() => { const c = RULES.defaultCharacter(); c.priorities={heritage:1,magic:2,attributes:3,skills:0,resources:4}; c.heritage.type="Human"; c.lifestyles=[{name:"Squatter",months:1}]; c.rigs=[{name:"Basic VCR",mods:[]}]; const k=RULES.calculate(c); return { rigZR: DATA.tables.rigs.find(r=>r["Rig Type"]==="Basic VCR").ZR, gearZr: k.zoetics.gear_zr, activeRig: c.play.rigging.active_rig }; })()

- **Expected:** `{ "rigZR": "1", "gearZr": 1, "activeRig": "" }`
- **Note:** JC-005, ruled **C**. `activeRig` is still `""` — nothing is flagged
  active during creation — but `gearZoeticRating` now resolves the rig through
  `activeGearRow`, which falls back to the first owned one. That is the same
  fallback `deriveExploitActions` and the Rigging tab already used, so all three
  agree. Chargen's Rigging tab gained an **Active rig** selector for choosing
  between several.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-004: The one rule, applied to both
- **Type:** correctness
- **Check:**

      (() => { const c = RULES.defaultCharacter(); c.priorities={heritage:1,magic:2,attributes:3,skills:0,resources:4}; c.heritage.type="Human"; c.lifestyles=[{name:"Squatter",months:1}]; c.weapons=[{name:"Kalishnikov A-80",smart:false,mods:[],equipped:false,qty:1}]; c.decks=[{name:"MasterDeck",mods:[]}]; const bothOwned = RULES.calculate(c).zoetics.gear_zr; const d = JSON.parse(JSON.stringify(c)); d.decks[0].carried = false; return { bothOwned, deckStashed: RULES.calculate(d).zoetics.gear_zr }; })()

- **Expected:** `{ "bothOwned": 1, "deckStashed": 0 }`
- **Note:** One unequipped rifle (ZR 2, excluded) plus one deck (ZR 1). The deck
  counts while carried and stops when it isn't — the same rule the rifle was
  always under. Before JC-004 the deck counted either way.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Duplicates and stacking

### P02-005: Two copies of the same active armor stack
- **Type:** leak
- **Check:**

      (() => { const mk = n => { const c = RULES.defaultCharacter(); c.priorities={heritage:1,magic:2,attributes:3,skills:0,resources:4}; c.heritage.type="Human"; c.lifestyles=[{name:"Squatter",months:1}]; c.armor = Array.from({length:n}, () => ({name:"Heavy leathers",active:true,extras:[]})); const k = RULES.calculate(c); return { B: k.combat.ballistic_armor, I: k.combat.impact_armor, errors: k.errors.length, warnings: k.warnings }; }; return { one: mk(1), two: mk(2) }; })()

- **Expected:**

      { "one": { "B": 2, "I": 2, "errors": 0, "warnings": [] },
        "two": { "B": 4, "I": 4, "errors": 0,
                 "warnings": ["More than one Outer armor piece is active."] } }

- **Note:** JC-007, ruled **A** — duplicates stack and the player is responsible.
  Both copies apply in full, it warns, it does not block, and nothing
  deduplicates. Unchanged by the ruling; what the ruling added is P02-005b.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-005b: Duplicate decks, programs and gear each warn once
- **Type:** correctness
- **Check:**

      (() => { const c = RULES.defaultCharacter(); c.priorities={heritage:1,magic:2,attributes:3,skills:0,resources:4}; c.heritage.type="Human"; c.lifestyles=[{name:"Squatter",months:1}]; c.decks=[{name:"MasterDeck",mods:[]},{name:"MasterDeck",mods:[]}]; c.programs=["Attack","Attack"]; c.gear=[{name:"Medkit",qty:1},{name:"Medkit",qty:1}]; return RULES.calculate(c).warnings.filter(w => w.includes("more than once")); })()

- **Expected:**

      ["Deck MasterDeck is listed more than once — the copies stack.",
       "Program Attack is listed more than once — the copies stack.",
       "Gear Medkit is listed more than once — the copies stack."]

- **Note:** JC-007's "make sure there are warnings" half. **Once** per repeated
  name, not once per copy — add a third MasterDeck and the list is unchanged.
  Armor is deliberately not in here: its per-slot warning (P02-005) is the more
  useful message, because `active` is what decides whether the copies sum.
  Filtering the warnings keeps the unrelated Hacking-rating message out.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-006: Deactivating the duplicate correctly removes it
- **Type:** correctness
- **Check:**

      (() => { const c = RULES.defaultCharacter(); c.priorities={heritage:1,magic:2,attributes:3,skills:0,resources:4}; c.heritage.type="Human"; c.lifestyles=[{name:"Squatter",months:1}]; c.armor=[{name:"Heavy leathers",active:true,extras:[]},{name:"Heavy leathers",active:false,extras:[]}]; const k=RULES.calculate(c); return { B: k.combat.ballistic_armor, warnings: k.warnings }; })()

- **Expected:** `{ "B": 2, "warnings": [] }`
- **Note:** This is the control for P02-005 — the `active` flag *is* respected
  for armor. Proves the stacking above is about duplicates, not broken gating.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-007: Holding both augment tiers of one family is an error
- **Type:** correctness
- **Fixture:** may also be observed with `synthetic-augmented.json`
- **Check:**

      (() => { const c = RULES.defaultCharacter(); c.priorities={heritage:1,magic:2,attributes:3,skills:0,resources:4}; c.heritage.type="Human"; c.lifestyles=[{name:"Squatter",months:1}]; c.augments=[{name:"Bone Lacing-Plastic",count:1,target:"",slotted:false,alpha:false},{name:"Bone Lacing-Titanium",count:1,target:"",slotted:false,alpha:false}]; const k=RULES.calculate(c); return { errors: k.errors, warnings: k.warnings, cyberZr: k.zoetics.cyber_zr }; })()

- **Expected:**

      { "errors": ["Bone Lacing: only one tier may be installed — remove all but one of Bone Lacing-Plastic, Bone Lacing-Titanium."],
        "warnings": [], "cyberZr": 2.75 }

- **Note:** JC-008, ruled **A**. The picker hid the lower tier and the engine
  used to take its word for it, so a character arriving by import, homebrew or
  hand-edited JSON kept both. `tallyAugments` now re-checks, using the same
  `augmentTier` / `augmentStacks` helpers the picker calls — so the two can't
  drift apart again. `cyberZr` is unchanged at 2.75: the error doesn't remove
  anything, it refuses to finalize. The error is also play-relevant (JC-012), so
  it survives Finalize.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Smartlink

### P02-008: Smartlink grants +1 Accuracy to a smart weapon
- **Type:** correctness
- **Check:**

      (() => { const mk = withAug => { const c = RULES.defaultCharacter(); c.priorities={heritage:1,magic:2,attributes:3,skills:0,resources:4}; c.heritage.type="Human"; c.lifestyles=[{name:"Squatter",months:1}]; c.weapons=[{name:"Kalishnikov A-80",smart:true,mods:[],equipped:true,qty:1}]; if (withAug) c.augments=[{name:"Smartlink",count:1,target:"",slotted:false,alpha:false}]; const w = RULES.calculate(c).weapons[0]; return { acc: w.Accuracy, smartlink: !!w.smartlink }; }; return { without: mk(false), with: mk(true) }; })()

- **Expected:** `{ "without": { "acc": "1", "smartlink": false }, "with": { "acc": "2", "smartlink": true } }`
- **Note:** JC-009 is ruled: the match is now against the augments that are
  actually **live** — body augments plus mounted ones whose host is worn — so an
  implanted Smartlink always counts and one mounted on an unworn host does not.
  This case covers the implanted half. The mounted half is not testable against
  the shipped data, because Smartlink is typed Headware and no host will mount
  one; see JC-025.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Ammunition and Barrier

### P02-009: Ammo prose adjusts Pen and Barrier, leaving no leftover note
- **Type:** correctness
- **Check:**

      RULES.ammoStatMods(DATA.tables.misc_gear.find(r => r.Item === "AP").Effect)

- **Expected:** `{ "acc": 0, "damage": 0, "pen": 2, "bar": 1, "mag": 0, "recoil": 0, "hardening": 0, "conceal": 0, "weight": 0, "zr": 0, "rarity": 0, "set": {}, "modes": null, "notes": [] }`
- **Note:** Reads the **real row**, not a hand-written string — this is
  load-bearing. Every multi-clause ammo in the data separates its clauses with
  a period ("Pen +2. Barrier +1."), not a comma, and this case used to pass a
  synthetic `"Pen +1, Barrier +1"` (comma-joined) that parsed fine under both
  the broken and the fixed code, so it never actually exercised the real data's
  punctuation and could not have caught the bug it was written to guard
  against. Found 2026-08-19 building an unrelated feature: the Kalishnikov's
  Pen/Barrier stayed at their un-modified 5/4 on the Overview with AP loaded,
  and the reason was exactly this — the whole string fell through to `notes`
  unparsed, and the note LOOKED correct (it repeats the same prose) so nothing
  about the display looked broken at a glance. Fixed by splitting on `[,.]`
  instead of `,` alone; see `../findings/2026-08-19-P02.md`.

  `notes` must still be **empty** for AP specifically — if it comes back
  non-empty, the period split broke, or the Barrier spelling stopped being
  recognised and the adjustment is being silently dropped again.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-010: Applying that ammo raises both stats
- **Type:** correctness
- **Check:**

      RULES.applyAmmoStats({ acc: 2, damage: "7", pen: "5", bar: "4" }, RULES.ammoStatMods(DATA.tables.misc_gear.find(r => r.Item === "AP").Effect))

- **Expected:** `{ "acc": 2, "damage": "7", "pen": "7", "bar": "5" }`
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-010b: A SET clause keeps its trailing prose as a note; Buckshot's three clauses all land
- **Type:** correctness
- **Check:**

      RULES.ammoStatMods(DATA.tables.misc_gear.find(r => r.Item === "Buckshot").Effect)

- **Expected:** `{ "acc": 2, "damage": 3, "pen": 0, "bar": 0, "mag": 0, "recoil": 0, "hardening": 0, "conceal": 0, "weight": 0, "zr": 0, "rarity": 0, "set": { "pen": 1 }, "modes": null, "notes": ["Range = S"] }`
- **Note:** Buckshot's Effect is `"+2 Accuracy. +3 Damage. Pen = 1. Range = S."`
  — four clauses, three shapes (`+d Stat`, `Stat = d`, and a fourth that has no
  recognised stat at all). `Pen = 1` is a SET, not a `+1` delta — it wins over
  whatever the weapon's own Pen is, which is why it lands in `set` rather than
  `pen`. "Range = S" matches the same `Stat = value` shape textually but "S" is
  not a number, so it falls through to `notes` whole rather than being
  half-applied. This is the case that would have caught the cybergun ammo-fit
  bug's sibling defect one step earlier — Buckshot is the ammo named in
  `../findings/2026-08-19-P02.md`.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-010c: Buckshot fits the Cybergun Shotgun option, and only that one
- **Type:** correctness
- **Check:**

      (() => { const buckshot = DATA.tables.misc_gear.find(r => r.Item === "Buckshot"); const fits = t => RULES.ammoFitsWeapon(buckshot, { Type: t }); return { shotgun: fits("Shotgun"), palmPistol: fits("Palm Pistol"), forearmSMG: fits("Forearm SMG"), heavyPistol: fits("Heavy Pistol") }; })()

- **Expected:** `{ "shotgun": true, "palmPistol": false, "forearmSMG": false, "heavyPistol": false }`
- **Note:** `AMMO_FITS["Buckshot"]` reads `row.Type === "Shotgun"` — the same
  test a real (non-cyber) shotgun passes. Before 2026-08-19, the cybergun row
  built for ammo-fit checks (`static/sheet.js`, inside `shOverview`'s
  `cyberguns.forEach`) hardcoded `Type: "Cybergun"` on every cybergun
  regardless of which of the four the character actually has, so this read
  `false` for all four including the one Buckshot is meant for — the ammo
  picker on the Overview's Cybergun — Shotgun row never offered it. Fixed by
  giving that row's `Type` the cyberguns table's own archetype string
  (`"Shotgun"`, `"Palm Pistol"`, …) and moving the "this is an implanted gun,
  gate the mid-fight reload confirm" signal onto a separate `cybergun: true`
  flag, so the two jobs `Type` used to do at once no longer collide. See
  `../findings/2026-08-19-P02.md`.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-010d: A round moves the weapon's row stats, and only the ones it rates
- **Type:** correctness
- **Check:**

      (() => { const W = n => DATA.tables.weapons.find(w => w.Weapon === n); const m = RULES.ammoStatMods("Mag -10. Recoil +2. Conceal -1. Hardening +1."); const rifle = RULES.applyAmmoToRow({ Recoil: 3 }, W("Kalishnikov A-80"), m); const katana = RULES.applyAmmoToRow({}, W("Katana"), m); return { rifleMag: rifle.Ammo, rifleRecoil: rifle.Recoil, rifleLabel: rifle.recoil_mod_label, rifleConceal: rifle.Conceal, rifleHardening: rifle.Hardening, taserMag: RULES.applyAmmoToRow({}, W("Ares TAG-1 Taser"), m).Ammo, katanaGotAMagazine: "Ammo" in katana, katanaGotRecoil: "Recoil" in katana, missileMag: RULES.applyAmmoToRow({ Ammo: "1 missile" }, {}, RULES.ammoStatMods("Mag +40.")).Ammo }; })()

- **Expected:** `{ "rifleMag": "20", "rifleRecoil": "5", "rifleLabel": "ammo", "rifleConceal": "2", "rifleHardening": "6", "taserMag": "0", "katanaGotAMagazine": false, "katanaGotRecoil": false, "missileMag": "1 missile" }`
- **Note:** Issue #86 widened ammunition from the four shot stats to everything
  a weapon MOD can reach. The three guards in one case: a stat the weapon
  doesn't rate is **not invented** (a Katana gets neither a magazine nor a
  Recoil rating), a rating stated as prose is **left alone** (a missile rack
  holds `"1 missile"`, not 41), and nothing goes **below zero** (a 2-round taser
  with `Mag -10` holds 0 — the round doesn't fit — rather than −8). `Recoil`
  and `Conceal` already print a `(+N mods)` annotation, so the round's share
  joins it under the label `ammo` rather than moving the number silently.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-010e: A round can bar or add a firing mode
- **Type:** correctness
- **Check:**

      (() => { const kal = DATA.tables.weapons.find(w => w.Weapon === "Kalishnikov A-80"); const base = RULES.weaponFiringModes(kal); const m = s => RULES.ammoStatMods(s); return { base, noFA: RULES.ammoFiringModes(base, m("Modes -FA.")), onlySS: RULES.ammoFiringModes(base, m("Modes = SS.")), addBF: RULES.ammoFiringModes(["SS"], m("Modes +BF.")), prose: RULES.ammoFiringModes(base, m("Modes - see the notes.")) }; })()

- **Expected:** `{ "base": ["SS", "DT", "BF", "FA"], "noFA": ["SS", "DT", "BF"], "onlySS": ["SS"], "addBF": ["SS", "BF"], "prose": ["SS", "DT", "BF", "FA"] }`
- **Note:** The mode clause is pulled out of the Effect text *before* the clause
  split, because a mode list contains the very commas that split clauses —
  `"Modes = SS, DT"` would otherwise arrive as `Modes = SS` plus a stray `DT`.
  `prose` is the guard on the other side: text that merely fits the shape is
  validated through `parseFiringMode`, fails, and stays a note, so a round whose
  Effect says "Modes - see the notes" does not silently strip the gun's modes.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-010f: Silvered Ammo is a plain, expensive round
- **Type:** correctness
- **Check:**

      (() => { const s = DATA.tables.misc_gear.find(r => r.Item === "Silvered Ammo"); const bow = DATA.tables.weapons.find(w => w.Type === "Projectile"); return { Class: s.Class, Cost: s.Cost, Rarity: s.Rarity, Effect: s.Effect, notes: RULES.ammoStatMods(s.Effect).notes, fitsRifle: RULES.ammoFitsWeapon(s, DATA.tables.weapons.find(w => w.Weapon === "Kalishnikov A-80")), fitsBow: RULES.ammoFitsWeapon(s, bow) }; })()

- **Expected:** `{ "Class": "Ammo", "Cost": "2000", "Rarity": "3", "Effect": "", "notes": [], "fitsRifle": true, "fitsBow": false }`
- **Note:** Added with #86. It states no effect at all, which is the point — it
  buys the fiction, not a stat. Unlisted in `AMMO_FITS`, so it chambers in any
  conventional gun; the projectile/firearm split (P02-016) still keeps it out of
  a bow.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-011: Barrier reaches CALC.weapons
- **Type:** correctness
- **Check:**

      (() => { const c = RULES.defaultCharacter(); c.priorities={heritage:1,magic:2,attributes:3,skills:0,resources:4}; c.heritage.type="Human"; c.lifestyles=[{name:"Squatter",months:1}]; c.weapons=[{name:"Kalishnikov A-80",smart:false,mods:[],equipped:true,qty:1}]; const w = RULES.calculate(c).weapons[0]; return { Pen: w.Pen, Bar: w.Bar }; })()

- **Expected:** `{ "Pen": "5", "Bar": "4" }`
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-012: Barrier's blank-vs-zero convention holds in the data
- **Type:** correctness
- **Check:**

      (() => { const w = n => DATA.tables.weapons.find(x => x.Weapon === n); return { launcherType: w("Ares Grenade Launcher").Type, launcherBar: w("Ares Grenade Launcher").Bar, explosiveBar: w("Explosive Grenade").Bar, katanaBar: w("Katana").Bar, neonFangBar: w("Neon Fang LS").Bar }; })()

- **Expected:**

      { "launcherType": "GrenadeLauncher", "launcherBar": "", "explosiveBar": "5",
        "katanaBar": "", "neonFangBar": "0" }

- **Note:** Blank means "does not apply" (melee, and launchers which inherit from
  the chambered grenade); `"0"` means a real rating of zero. `launcherType` must
  be `GrenadeLauncher` — if it reads `Heavy`, the launcher cannot chamber a
  grenade at all and P06's inheritance cases will fail too.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-012b: Fitted mods add their Concealability to the weapon's Conceal
- **Type:** correctness
- **Check:**

      (() => { const mk = mods => { const c = RULES.defaultCharacter(); c.name = "G"; c.lifestyles = [{ name: "Squatter", months: 1 }]; c.weapons = [{ name: "Militech Whisper 1000", mods }]; const w = RULES.calculate(c).weapons[0]; return [w.Conceal, w.conceal_mod ?? 0]; }; return { base: DATA.tables.weapons.find(r => r.Weapon === "Militech Whisper 1000").Conceal, none: mk([]), optical: mk(["Optical Scope"]), three: mk(["Gyro-mount", "Optical Scope", "Bayonet"]), silencer: mk(["Silencer"]), blankRated: (() => { const c = RULES.defaultCharacter(); c.name = "G"; c.lifestyles = [{ name: "Squatter", months: 1 }]; c.weapons = [{ name: "Underslung Grenade Launcher (40mm) (Underbarrel slot)", mods: [] }]; return RULES.calculate(c).weapons[0].Conceal; })() }; })()

- **Expected:**

      { "base": "4", "none": ["4", 0], "optical": ["5", 1], "three": ["8", 4],
        "silencer": ["4", 0], "blankRated": "" }

- **Note:** Concealability is the `Conceal Mod` column on `weapon_mods`, and it
  adds — three mods worth 2, 1 and 1 make a Conceal-4 rifle a Conceal-8 one.
  `silencer` is the case that says a `0` in the column really means zero rather
  than "unset": a Silencer changes Accuracy and nothing else.

  `blankRated` must stay `""`. A weapon whose data row states no Conceal at all
  has no rating for a mod to add to, so it stays blank — if it ever prints a
  bare mod total, the sheet is reporting a concealability that the weapon does
  not have. `conceal_mod` is what the stat lines use to show " (+N mods)", so a
  non-zero `Conceal` with a zero `conceal_mod` means the adjustment got baked in
  somewhere it can no longer be explained.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-013: Every weapon row carries the Bar column
- **Type:** correctness
- **Check:**

      (() => ({ missing: DATA.tables.weapons.filter(r => !("Bar" in r)).map(r => r.Weapon), sentinelX: DATA.tables.weapons.filter(r => r.Bar === "X").map(r => r.Weapon), rows: DATA.tables.weapons.length }))()

- **Expected:** `{ "missing": [], "sentinelX": [], "rows": 106 }`
- **Note:** `Bar` must be present on row 0 or `promote_homebrew.base_columns()`
  silently drops it from promoted homebrew. An `"X"` reappearing means someone
  reintroduced the retired sentinel.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Bows and crossbows

### P02-014: A bow's damage, price and rarity all come from its Minimum Strength
- **Type:** correctness
- **Check:**

      (() => { const mk = (name, minStr) => { const c = RULES.defaultCharacter(); c.priorities={heritage:1,magic:2,attributes:3,skills:0,resources:4}; c.heritage.type="Human"; c.lifestyles=[{name:"Squatter",months:1}]; c.attributes.Strength=10; c.weapons=[{name,smart:false,mods:[],equipped:true,qty:1,min_str:minStr}]; const w = RULES.calculate(c).weapons[0]; return { dmg: w.Damage, rarity: w.Rarity, cost: w.cost }; }; return { recurve4: mk("Self / Recurve bow", 4), recurve8: mk("Self / Recurve bow", 8), compound5: mk("Compound Bow", 5) }; })()

- **Expected:**

      { "recurve4":  { "dmg": "5", "rarity": "2", "cost": 600 },
        "recurve8":  { "dmg": "9", "rarity": "4", "cost": 1200 },
        "compound5": { "dmg": "7", "rarity": "2", "cost": 1500 } }

- **Note:** Damage is Min STR + `StrDmg` (1 for a self/recurve, 2 for a
  compound), cost is `StrCost` × Min STR (150 and 300), rarity is Min STR ÷ 2
  rounded down. The character's own Strength is 10 throughout and changes none of
  it — a bow's rating belongs to the bow, not the archer. The data rows carry
  blank `Cost`, `Damage` and `Rarity` precisely so there is no second source for
  these to disagree with.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-015: Projectile weapons roll Archery, and a bow too heavy to draw warns
- **Type:** correctness
- **Check:**

      (() => { const c = RULES.defaultCharacter(); c.priorities={heritage:1,magic:2,attributes:3,skills:0,resources:4}; c.heritage.type="Human"; c.lifestyles=[{name:"Squatter",months:1}]; c.attributes.Strength=4; c.weapons=[{name:"Compound Bow",smart:false,mods:[],equipped:true,qty:1,min_str:9},{name:"Heavy Crossbow",smart:false,mods:[],equipped:true,qty:1}]; const k = RULES.calculate(c); return { skill: RULES.weaponSkillName("Compound Bow","Projectile"), crossbowDmg: k.weapons[1].Damage, crossbowCost: k.weapons[1].cost, warnings: k.warnings }; })()

- **Expected:**

      { "skill": "Archery", "crossbowDmg": "9", "crossbowCost": 1000,
        "warnings": ["Compound Bow: needs Strength 9 to draw — this character has 4."] }

- **Note:** `Archery` was in the skill list from the beginning but nothing rolled
  it until the Projectile type existed. The crossbow is the control: it is a
  fixed weapon and takes its damage and price straight from its row, so only
  bows are STR-rated. The shortfall is a **warning**, not an error — Strength
  moves in play — and it is play-relevant (JC-012), so it survives Finalize.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-016: Arrows and bullets never cross over
- **Type:** correctness
- **Check:**

      (() => { const bow = DATA.tables.weapons.find(w => w.Weapon === "Compound Bow"); const rifle = DATA.tables.weapons.find(w => w.Type === "Rifle"); const g = n => DATA.tables.misc_gear.find(x => x.Item === n); const fits = (a, w) => RULES.ammoFitsWeapon(g(a), w); return { broadheadOnBow: fits("Broadhead", bow), broadheadOnRifle: fits("Broadhead", rifle), apOnBow: fits("AP", bow), apOnRifle: fits("AP", rifle) }; })()

- **Expected:**

      { "broadheadOnBow": true, "broadheadOnRifle": false,
        "apOnBow": false, "apOnRifle": true }

- **Note:** The split is symmetric and keyed on the ammo's `Class` rather than a
  rule per round. It has to be: `ammoFitsWeapon` defaults **unlisted ammo to
  "fits"**, so without the check every conventional round would chamber in a
  crossbow. Note the projectile `Explosive Tip` is named that way because a
  conventional `Explosive` round already exists and row identity is by name.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-016b: "Vehicle " marks only the two mount rounds a personal round collides with
- **Type:** correctness
- **Check:**

      (() => { const g = n => DATA.tables.misc_gear.find(x => x.Item === n); const W = DATA.tables.weapons; const fits = n => W.filter(w => RULES.ammoFitsWeapon(g(n), w)).map(w => w.Weapon); const legacy = { name: "R", gear: [{ name: "Autocannon HEI", qty: 20 }, { name: "Tank Rounds (KE)", qty: 4 }], vehicles: [{ name: "V", weapons: [{ name: "30mm Cannon", ammo: "Autocannon Tracer" }] }] }; const m = RULES.mergeDefaults(JSON.parse(JSON.stringify(legacy))); return { prefixed: DATA.tables.misc_gear.filter(r => /^Vehicle /.test(r.Item)).map(r => r.Item), hei: fits("High Explosive Incendiary (HEI)").length, tracerAllFA: fits("Tracer Rounds").every(n => RULES.weaponFiringModes(W.find(w => w.Weapon === n)).includes("FA")), mountRoundOnPeople: fits("Vehicle Autocannon HEI").length, binds: [RULES.ammoFitsUnitWeapon(g("Vehicle Autocannon HEI"), "Autocannon"), RULES.ammoFitsUnitWeapon(g("Tank Rounds (KE)"), "Tank Cannon"), RULES.ammoFitsUnitWeapon(g("30mm Cannon"), "30mm Cannon")], migratedGear: m.gear.map(x => x.name), migratedAmmo: m.vehicles[0].weapons[0].ammo, weaponNameIntact: m.vehicles[0].weapons[0].name }; })()

- **Expected:**

      { "prefixed": ["Vehicle Autocannon HEI", "Vehicle Autocannon Tracer"],
        "hei": 3, "tracerAllFA": true, "mountRoundOnPeople": 0,
        "binds": [true, true, true],
        "migratedGear": ["Vehicle Autocannon HEI", "Tank Rounds (KE)"],
        "migratedAmmo": "Vehicle Autocannon Tracer",
        "weaponNameIntact": "30mm Cannon" }

- **Note:** `prefixed` is the whole naming rule: **exactly two** rounds say
  Vehicle, and only because a personal HEI and a personal Tracer now exist to
  confuse them with. Tank Rounds, Micro missiles and the cannon rounds were
  never ambiguous and keep their names — a third entry here means someone
  prefixed the whole exotic class again. `migratedGear` shows the same
  asymmetry surviving the migration: the Autocannon HEI stack is renamed, the
  Tank Rounds stack is left alone.

  `weaponNameIntact` is the case with teeth. **Ammo and vehicle weapons share a
  namespace** — "30mm Cannon" and "Vulcan Cannon" are each both a round and a
  mounted gun — so `migrateRenamedAmmo` walks `ammo` anywhere but rewrites
  `name` only inside the three arrays holding bought gear. Nothing in today's
  rename map collides, which is exactly why this guard is easy to loosen and
  worth asserting: widen it and the next rename renames a rigger's gun.

  `hei` is 3 — the large-bore guns, the same set API fits. The data's Recoilless
  Rifle and Autocannon are drone/vehicle mounts, so the personal-scale reading
  of "Recoilless Rifle / Autocannon only" is the large-bore list.
  `tracerAllFA` checks "Autofire only" is read off each weapon's own modes
  rather than a hardcoded list, so a new full-auto gun takes Tracer on its own.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-017: A deck runs on the Hacking program slotted into it
- **Type:** correctness
- **Steps:** none — the Check builds its own characters.
- **Check:**

      (() => { const mk = () => { const c = RULES.defaultCharacter(); c.name = "Decker"; c.priorities = { heritage: 4, magic: 5, attributes: 2, skills: 3, resources: 1 }; c.heritage.type = "Human"; c.lifestyles = [{ name: "Squatter", months: 1 }]; return c; }; const run = c => { const k = RULES.calculate(c); return { cat: k.budget.categories["Decks and Programs"], err: k.errors.filter(e => /Hacking/i.test(e)), warn: k.warnings.filter(w => /Hacking/i.test(w)) }; }; const out = {}; let c = mk(); c.decks = [{ name: "MasterDeck", mods: [] }]; out.none = run(c); c = mk(); c.decks = [{ name: "MasterDeck", mods: [], hacking: "Hacking 4" }]; out.notOwned = run(c); c = mk(); c.decks = [{ name: "Semi Point Razor", mods: [], hacking: "Hacking 2" }]; c.programs = ["Hacking 2"]; out.under = run(c); c = mk(); c.decks = [{ name: "Semi Point Razor", mods: [], hacking: "Hacking 3" }]; c.programs = ["Hacking 3"]; out.ok = run(c); c = mk(); c.decks = [{ name: "MasterDeck", mods: [], hacking: "Hacking 2" }, { name: "Semi Point Razor", mods: [], hacking: "Hacking 4" }]; c.programs = ["Hacking 2", "Hacking 4"]; out.matched = run(c); return out; })()

- **Expected:**

      { "none":     { "cat": 14000,  "err": ["MasterDeck: no Hacking program slotted — the deck will not run. It needs one rated 1 or better."], "warn": [] },
        "notOwned": { "cat": 14000,  "err": ["MasterDeck: the slotted Hacking 4 isn't owned — buy it or slot a Hacking program you have."], "warn": [] },
        "under":    { "cat": 135000, "err": [], "warn": ["Semi Point Razor: Hacking 2 is under ½ MCP — needs rating 3 for MCP 6."] },
        "ok":       { "cat": 140000, "err": [], "warn": [] },
        "matched":  { "cat": 169000, "err": [], "warn": [] } }

- **Note:** `matched` is the point of the whole model — one character owning
  Hacking 2 and Hacking 4 with each slotted into the deck that needs it. Before
  2026-08-05 the rating was a character-wide scalar (`character.hacking_rating`)
  at ㄓ5,000/level that no deck could be matched to, and losing your last deck
  left it billed with nothing to run on.

  The error/warning split follows JC-003: **no program at all** is binding — the
  deck does not run, so it is an error — while **under ½ MCP** is degraded
  performance and stays a warning. Hacking programs cost no thread and no I/O
  (`I/O: N/A`); they are the deck's operating system, not a tool run on top,
  which is why `cat` for `ok` is just the deck plus ㄓ15,000 for Hacking 3.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-018: A pre-2026-08-05 hacking rating migrates cost-neutrally
- **Type:** correctness
- **Steps:** none.
- **Check:**

      (async () => { CHAR = RULES.defaultCharacter(); CHAR.name = "Legacy decker"; CHAR.priorities = { heritage: 4, magic: 5, attributes: 2, skills: 3, resources: 1 }; CHAR.heritage.type = "Human"; CHAR.lifestyles = [{ name: "Squatter", months: 1 }]; CHAR.decks = [{ name: "MasterDeck", mods: [] }, { name: "Shingo Activa", mods: [] }]; CHAR.hacking_rating = 6; await recalc(); migrateHackingProgram(); await recalc(); const first = JSON.stringify({ p: CHAR.programs, d: CHAR.decks }); migrateHackingProgram(); migrateHackingProgram(); return { programs: CHAR.programs, decks: CHAR.decks.map(d => `${d.name}→${d.hacking}`), rating: CHAR.hacking_rating, spent: CALC.budget.spent, errors: CALC.errors.filter(e => /Hacking/i.test(e)), stable: JSON.stringify({ p: CHAR.programs, d: CHAR.decks }) === first }; })()

- **Expected:**

      { "programs": ["Hacking 6"],
        "decks": ["MasterDeck→Hacking 6", "Shingo Activa→Hacking 6"],
        "rating": 0, "spent": 114000, "errors": [], "stable": true }

- **Note:** Cost-neutral by construction — the character paid ㄓ5,000 × 6 for
  the old scalar and "Hacking 6" costs ㄓ30,000, so `spent` matches what the
  pre-change engine returned for the same character to the woolong. The one
  copy is slotted into **both** decks, because that is what a character-wide
  rating meant; the model allows it, on the reading that you carry one chip and
  move it. `stable` guards idempotence — the migration runs from both
  `ensurePlay()` and `restoreView()`, so it fires on essentially every load.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-019: Classic ZR doubles cyberlimb prices
- **Type:** correctness
- **Steps:** none — the Check builds a character per price it needs.
- **Check:**

      (() => { const price = (zr, name, entry = {}) => { const c = RULES.defaultCharacter(); c.house_rules = { ...c.house_rules, zr }; c.name = "Limb"; c.lifestyles = [{ name: "Squatter", months: 1 }]; c.augments = [{ name, count: 1, target: "", slotted: false, alpha: false, ...entry }]; return RULES.calculate(c).budget.categories["Augments"]; }; const pair = (n, e) => [price("classic", n, e), price("houserule", n, e)]; return { chromed: pair("Right Arm Replacement-Chromed"), synthetic: pair("Right Arm Replacement-Synthetic"), chromedRC: pair("Left Leg Replacement-Chromed, RC"), syntheticRC: pair("Left Leg Replacement-Synthetic, RC"), chromedAlpha: pair("Right Arm Replacement-Chromed", { alpha: true }), smartlink: pair("Smartlink"), wired: pair("Wired Reflexes 1"), omnikit: pair("Arm Omni-kit") }; })()

- **Expected:** each pair is `[classic, houserule]`.

      { "chromed":      [75000, 37500],
        "synthetic":    [100000, 50000],
        "chromedRC":    [150000, 75000],
        "syntheticRC":  [200000, 100000],
        "chromedAlpha": [150000, 75000],
        "smartlink":    [2500, 2500],
        "wired":        [60000, 60000],
        "omnikit":      [150000, 150000] }

- **Note:** Under Classic ZR each cyberlimb absorbs 1.0 ZR, which makes chrome a
  bargain; doubling the price is the counterweight. The ZR Casting Penalty rule
  leaves limbs at list price, which is what the second number in each pair is
  for — **`smartlink` and `wired` are the controls**: if they move, the
  multiplier has escaped past `AUGMENT_LIMB_TYPES` and is repricing every
  augment.

  `chromedAlpha` checks that α-grade scales from the *doubled* base
  (75,000 + max(75,000, 1000) = 150,000), not from list price. The RC pairs
  matter because ㄓ75,000 / ㄓ100,000 are the RC variants' own list prices —
  double only the plain limbs and a remote-controllable arm ends up costing the
  same as a plain one.

  **`omnikit` is deliberately unchanged.** "Arm Omni-kit" is `Type: Cyberlimbs`,
  not one of the four limb types, so it is not a limb replacement and does not
  double. If that is wrong, the fix is its `Type`, not the rule.

  No fixture owns a cyberlimb, so a two-engine sweep will report zero drift
  through any change to this — see the note in [`../README.md`](../README.md).
  This case is the coverage.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-020: Armor material, style and extras combine additively, not multiplicatively
- **Type:** correctness
- **Steps:** none.
- **Check:**

      (() => { const mk = a => { const c = RULES.defaultCharacter(); c.name = "Armor probe"; c.lifestyles = [{ name: "Squatter", months: 1 }]; c.priorities = { attributes: 4, skills: 3, resources: 2, heritage: 1, magic: 0 }; c.heritage.type = "Human"; c.armor = [{ name: "Armored Coat", style: "", material: "", extras: [], active: true, ...a }]; return RULES.calculate(c).budget.categories["Weapons/Armor"]; }; return { plain: mk({}), cheap: mk({ material: "Cheap" }), good: mk({ material: "Good" }), business: mk({ style: "Business wear" }), polylog: mk({ extras: ["PolyLog Material"] }), stacked: mk({ material: "Good", style: "Business wear", extras: ["PolyLog Material"] }) }; })()

- **Expected:**

      { "plain": 1800, "cheap": 1350, "good": 2700,
        "business": 5400, "polylog": 5400, "stacked": 9900 }

- **Note:** Armored Coat is ㄓ1,800 and is one of the few `Style: Y` rows, which
  is what makes styles and extras available at all — most armor is `Style: N`
  and ignores them.

  Each modifier alone behaves as its table multiplier: Cheap ×0.75, Good ×1.5,
  Business wear ×3, PolyLog ×3. **Stacked, they do not multiply.** ×1.5 × ×3 ×
  ×3 would be ㄓ24,300; the engine gives ㄓ9,900, which is
  `1 + (0.5 + 2 + 2) = 5.5×`. Every modifier contributes its excess over 1 and
  the excesses are summed.

  That is the whole reason this case exists — multiplicative is the natural
  assumption, and a `9900 → 24300` reading means someone "fixed" it.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-021: The heritage surcharge applies to four categories, not all nine
- **Type:** correctness
- **Steps:** none.
- **Check:**

      (() => { const cats = ["gear","weapon","armor","cyberware","bioware","deck","rig","vehicle","drone"]; const at = m => Object.fromEntries(cats.map(k => [k, RULES.surchargeFor(k, m)])); return { atOne: at(1), atOneAndAHalf: at(1.5) }; })()

- **Expected:**

      { "atOne":          { "gear":1, "weapon":1, "armor":1, "cyberware":1, "bioware":1,
                            "deck":1, "rig":1, "vehicle":1, "drone":1 },
        "atOneAndAHalf":  { "gear":1, "weapon":1.5, "armor":1.5, "cyberware":1.5, "bioware":1,
                            "deck":1, "rig":1, "vehicle":1.5, "drone":1 } }

- **Note:** Small heritages pay a gear-cost multiplier, but it does **not** hit
  everything. Only **weapons, armor, cyberware and vehicles** are surcharged —
  things sized to a body. Gear, bioware (grown to fit), decks, rigs and drones
  pay face value.

  `surchargeFor` is the single definition, and both UIs price their buy screens
  through it. The `atOne` row is the control: with no surcharge every category
  must read exactly 1, or a multiplier is leaking in from somewhere else.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-022: Recoil capacity is 1 plus flat Strength steps, not raw Strength
- **Type:** correctness
- **Steps:** Any character. Restores its own Strength and augments afterwards.
- **Check:**

      (async () => { const c = CHAR; const str = c.attributes.Strength; const aug = JSON.parse(JSON.stringify(c.augments)); const out = {}; const at = async (s, augs) => { c.attributes.Strength = s; c.augments = augs; if (c.play && c.play.kit) c.play.kit.augments = JSON.parse(JSON.stringify(augs)); await recalc(); return CALC.combat.recoil_capacity; }; out.str1 = await at(1, []); out.str11 = await at(11, []); out.str12 = await at(12, []); out.str23 = await at(23, []); out.str24 = await at(24, []); out.str24gyro = await at(24, [{ name: "Gyromount" }]); out.str1twoGyro = await at(1, [{ name: "Gyromount", count: 2 }]); c.attributes.Strength = str; c.augments = aug; if (c.play && c.play.kit) c.play.kit.augments = JSON.parse(JSON.stringify(aug)); await recalc(); return out; })()

- **Expected:** `{ "str1": 1, "str11": 1, "str12": 2, "str23": 2, "str24": 3, "str24gyro": 5, "str1twoGyro": 5 }`
- **Note:** `str24: 3` is the case worth having. The Strength tiers are checked
  highest-first and exactly one applies — a Strength of 24 is base 1 plus 2, not
  base 1 plus 1 for clearing 12 and another 2 for clearing 24. Reading the tiers
  as cumulative is the obvious way to write this and gives 4.

  `str11` and `str23` are the boundaries from below: the steps land *at* 12 and
  24, not near them.

  This replaced a formula that was raw Strength plus Gyromounts, which handed a
  heavy hitter a recoil capacity in the twenties and made the stat meaningless
  for exactly the characters most likely to fire something with recoil.

  `str1twoGyro: 5` shows the augment stacks per copy (1 + 2 + 2) and that
  `count` is honoured — two Gyromounts as one entry with `count: 2` must equal
  two separate entries.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-023: Each gun carries its own recoil, and Gun-Kata only steadies two types
- **Type:** correctness
- **Steps:** Any character; the check sets Strength 1 and no augments so the
  character's own capacity is exactly 1 and every number below is the mods'
  contribution. Restores what it found.
- **Check:**

      (async () => { const c = CHAR; const snap = JSON.stringify([c.attributes.Strength, c.augments, c.weapons, c.martial_arts || []]); const put = async (str, augs, weapons, arts) => { c.attributes.Strength = str; c.augments = augs; c.weapons = weapons; c.martial_arts = arts; if (c.play && c.play.kit) Object.assign(c.play.kit, JSON.parse(JSON.stringify({ augments: augs, weapons, martial_arts: arts }))); await recalc(); }; const guns = [{ name: "FN-RAL Heavy Assault", equipped: true, mods: [] }, { name: "FN-RAL Heavy Assault", equipped: true, mods: ["Bi-pod (Rifle Only)", "Gas Vent"] }, { name: "Ingram MAC 14", equipped: true, mods: [] }, { name: "Katana", equipped: true, mods: [] }]; await put(1, [], guns, []); const cap = CALC.combat.recoil_capacity; const plain = CALC.weapons.map(x => `${x.Type}:${x.Recoil ?? "—"}${x.recoil_ignored ? " ignored" : ""}`); await put(1, [], guns, [{ style: "Gun-Kata", rank: 3 }]); const kata = CALC.weapons.map(x => `${x.Type}:${x.Recoil ?? "—"}${x.recoil_ignored ? " ignored" : ""}`); const [s, a, w, m] = JSON.parse(snap); await put(s, a, w, m); return { cap, plain, kata }; })()

- **Expected:** `{ "cap": 1, "plain": ["Rifle:1", "Rifle:3", "SMG:1", "Melee:—"], "kata": ["Rifle:1", "Rifle:3", "SMG:1 ignored", "Melee:—"] }`
- **Note:** Two identical rifles, one bare and one wearing a Bi-pod and a Gas
  Vent, are the point: `Rifle:1` beside `Rifle:3` proves recoil is resolved per
  weapon rather than once per character. The `RecoilMod` column has been in the
  data — and in the homebrew editor — since before anything read it, so fitting
  a bipod used to do nothing at all.

  `Melee:—` is deliberate. A Katana has no recoil to absorb, so it gets no
  rating rather than the character's number; "Recoil 1" on a sword would be
  noise on every melee sheet.

  The `plain` → `kata` diff is the scope test. Gun-Kata rank 3 says "Ignore
  Recoil", and the engine's generic effect parser sets one flag from that text;
  applying the flag as written makes a heavy assault rifle recoilless. Only the
  SMG changes here, and the rifles hold at 1 and 3.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-024: A broken deck stays broken after Finalize
- **Type:** correctness
- **Steps:** Any character. Builds a deliberately broken deck — nothing slotted,
  two range mods, over its slot budget, not carried — and asks for the same
  report in chargen and in play. Restores what it found.
- **Check:**

      (async () => { const c = CHAR; const snap = JSON.stringify([c.finalized, c.decks, c.programs, (c.play && c.play.kit) ? c.play.kit.decks : null, (c.play && c.play.kit) ? c.play.kit.programs : null]); const decks = [{ name: "Mars Claymore", mods: ["Range Extension", "Wide Area Protocols"], hacking: "", carried: false }]; const put = async fin => { c.finalized = fin; c.decks = JSON.parse(JSON.stringify(decks)); c.programs = []; if (c.play && c.play.kit) { c.play.kit.decks = JSON.parse(JSON.stringify(decks)); c.play.kit.programs = []; } await recalc(); return { errors: CALC.errors.filter(e => /Claymore/.test(e)).length, warnings: (CALC.warnings || []).filter(w => /Claymore/.test(w)).length }; }; const chargen = await put(false); const play = await put(true); const [f, d, p, kd, kp] = JSON.parse(snap); c.finalized = f; c.decks = d; c.programs = p; if (c.play && c.play.kit) { c.play.kit.decks = kd; c.play.kit.programs = kp; } await recalc(); return { chargen, play, same: JSON.stringify(chargen) === JSON.stringify(play) }; })()

- **Expected:** `{ "chargen": { "errors": 3, "warnings": 1 }, "play": { "errors": 3, "warnings": 1 }, "same": true }`
- **Note:** `calculate` keeps two report lists and returns `finalized ?
  playErrors : errors`. That split is right — creation budgets stop applying at
  Finalize — but `priceDecking` and `priceRig` only ever filled the chargen
  side, so every complaint they made was computed and thrown away the moment a
  character was finalized. Play reported zero of the four.

  None of these are budget rules. "No Hacking program slotted" means the deck
  does not run; the others mean the hardware could not be assembled or was left
  at home. Those stay true at the table, which is what the play list is for.

  The slotted program matters most: it's a live dropdown on the Decking tab, so
  a decker can create this state *during* play and, before this, hear nothing
  back.

  `same: true` is the assertion. Counting rather than comparing text keeps the
  case from breaking every time one of these messages is reworded.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-025: A deployed drone's cover counts as cover, and hotseat grants dice
- **Type:** correctness
- **Steps:** Any finalized character. Gives it three drones with contrasting
  effects and deploys them one at a time. Clears martial arts so the only cover
  in play comes from the drone. Restores what it found.
- **Check:**

      (async () => { const c = CHAR; const snap = JSON.stringify([c.drones, c.martial_arts, (c.play || {}).rigging, (c.play && c.play.kit) ? c.play.kit.drones : null, (c.play && c.play.kit) ? c.play.kit.martial_arts : null]); const drones = [{ name: "Shield-Wall Drone", carried: true, weapons: [], mods: [] }, { name: "Aerial Warden", carried: true, weapons: [], mods: [] }, { name: "Bug-Spy", carried: true, weapons: [], mods: [] }]; c.drones = JSON.parse(JSON.stringify(drones)); c.martial_arts = []; if (c.play && c.play.kit) { c.play.kit.drones = JSON.parse(JSON.stringify(drones)); c.play.kit.martial_arts = []; } const set = async rg => { c.play.rigging = { active_rig: "", linked: {}, active: {}, hotseat: {}, units: {}, ...rg }; await recalc(); return { cover: (CALC.combat.cover || {}).label || null, obs: CALC.skills.Observation.dice_bonus ?? null }; }; const out = { shieldWall: await set({ linked: { "drones:0": true } }), aerialWarden: await set({ linked: { "drones:1": true } }), bugSpyHotseat: await set({ hotseat: { "drones:2": true } }) }; const [d, ma, rg, kd, km] = JSON.parse(snap); c.drones = d; c.martial_arts = ma; if (c.play) c.play.rigging = rg; if (c.play && c.play.kit) { c.play.kit.drones = kd; c.play.kit.martial_arts = km; } await recalc(); return out; })()

- **Expected:** `{ "shieldWall": { "cover": "High cover (−2d)", "obs": null }, "aerialWarden": { "cover": null, "obs": null }, "bugSpyHotseat": { "cover": null, "obs": 1 } }`
- **Note:** Three separate rules in one fixture.

  A Shield-Wall Drone "Provides mobile High cover", which used to be a note
  printed beside the cover figure rather than part of it. It now feeds the same
  best-wins resolution as a martial-art stance and a full-cover infusion — so a
  Gun-Kata L1 rigger under this drone is at High cover, not Low, and not −3d.

  The Aerial Warden is the reason that isn't just "match /cover/". It "carries 3
  passengers under High cover" — cover for whoever is riding in it, and the
  rigger usually isn't. `cover: null` is the assertion that a drone flying a
  block away doesn't hand its pilot a −2d.

  `bugSpyHotseat` covers the deployment set. droneSkillDice counted linked and
  active drones; droneCombatBonuses counted linked, active AND hotseat. The same
  drone could therefore grant its Initiative dice but not its skill dice
  depending on which box was ticked. Both now agree, so a hotseated Bug-Spy
  gives its +1d Observation.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-026: Max Ballistic is a per-piece threshold, not a cap on total armor
- **Type:** correctness
- **Steps:** Any character. Wears one armor piece, then adds a second, and
  compares the two figures. Restores what it found.
- **Check:**

      (async () => { const c = CHAR; const snap = JSON.stringify([c.armor, (c.play && c.play.kit) ? c.play.kit.armor : null]); const set = async list => { c.armor = JSON.parse(JSON.stringify(list)); if (c.play && c.play.kit) c.play.kit.armor = JSON.parse(JSON.stringify(list)); await recalc(); return { maxB: CALC.combat.max_ballistic, totalB: CALC.combat.ballistic_armor }; }; const one = await set([{ name: "Power Armor", active: true, mods: [] }]); const two = await set([{ name: "Power Armor", active: true, mods: [] }, { name: "Helmet", active: true, mods: [] }]); const [a, k] = JSON.parse(snap); c.armor = a; if (c.play && c.play.kit) c.play.kit.armor = k; await recalc(); return { onePiece: one, twoPieces: two, maxHeldWhileTotalRose: one.maxB === two.maxB && two.totalB > one.totalB }; })()

- **Expected:** `{ "onePiece": { "maxB": 5, "totalB": 5 }, "twoPieces": { "maxB": 5, "totalB": 6 }, "maxHeldWhileTotalRose": true }`
- **Note:** Two figures that look alike and mean completely different things.

  **Max Ballistic** is the highest Ballistic on any ONE source and does not add
  up. It decides the DAMAGE TYPE of an incoming hit: a weapon whose Pen reaches
  it deals Physical, below it the hit is Stun.

  **Total Ballistic** is every piece summed, and only reduces the damage after
  that type is settled.

  `maxHeldWhileTotalRose` is the whole case. Adding a Helmet raises the total to
  6 and leaves the threshold at 5, because the Helmet's own 1 was never going to
  beat Power Armor's 5. A build that treats Max Ballistic as a cap would report
  the character "over" it here, which is what the Armor popover used to say —
  it described the figure as "the most ballistic armor this character benefits
  from" and warned when the total exceeded it. Both wrong: exceeding it is
  normal, and it isn't about benefit at all (#55).
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Wrapping up

Every case should PASS. P02-002, P02-003, P02-005 and P02-007 used to be
JUDGEMENT; JC-004, JC-005, JC-007 and JC-008 were all ruled on, and each of those
cases is now a correctness case for the ruled behaviour, joined by the new
P02-002b and P02-005b. P02-014 to P02-016 cover the Projectile weapon type.

If P02-001 or P02-006 fails, the equipped/active filtering has broken and that is
a real regression — the whole "leak" premise of this pass depends on those two
being the cases that work correctly.
