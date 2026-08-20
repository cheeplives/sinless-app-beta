# Game data reference — `static/data.js`

Companion to `static/data.js`, which cannot hold comments (it is one JSON
literal). Covers how the bundle is loaded, the conventions its rows follow, a
catalogue of every table, and the gotchas that bite people editing it.

> **The code is authoritative.** This file is maintained by hand, so when the two
> disagree, the code is right and this file needs fixing. Four places encode the
> same "which column identifies a row" knowledge:
>
> | Where | What |
> |---|---|
> | `HOMEBREW_CONFIG` — `static/homebrew.js` | `nameKey` per homebrew-eligible table |
> | `NAME_KEYS` — `tools/promote_homebrew.py` | the same 17 tables, for promotion |
> | `findRow(data.X, "Col")` — `static/rules.js` | per-lookup literals |
> | the catalogue below | all 36 tables |
>
> **`python tools/check_data.py` mechanically verifies the first three against
> each other and against the data.** Run it after editing any of them. It does
> not check this document — that part is on you.

## How the bundle is loaded

`static/data.js` defines one global, `DATA_BUNDLE`, and ends with a
`module.exports` line so Python/Node tooling can read the same file.

```
index.html  →  data.js first, then rules.js, storage.js, sync.js, homebrew.js,
               app.js, sheet.js, workspace.js, auth-ui.js
```

No modules and no `defer`: load order *is* the dependency graph.

- `rules.js:23` captures `const BUNDLE = DATA_BUNDLE ?? require("./data.js")`;
  `loadData()` returns `BUNDLE.tables`.
- `app.js:75` aliases the global `DATA = DATA_BUNDLE` during `boot()`; `sheet.js`
  shares those globals.
- Lookups use three idioms: `findRow(rows, column, value)` (`rules.js:377`, linear
  scan, trimmed compare, returns `null`), inline `.find()` in the UI (usually
  `... || {}` on miss), and direct index loops that build a map.

At ~820 rows the linear scans are irrelevant; don't add indexes without a
measured reason.

### Homebrew mutates the tables in place

`mergeCustomContent()` (`homebrew.js:290`) splices and pushes into the existing
`DATA_BUNDLE.tables` arrays rather than replacing them — deliberately, because
`rules.js` captured those array references at load time. Custom content then
appears in every picker and lookup with no further integration.

Precedence is **first writer of a name wins: core > my packs > subscriptions.**

Merged rows carry runtime-only columns that must **never** appear in `data.js`:

| Column | Meaning |
|---|---|
| `Custom:"Y"` | row came from a homebrew pack (merge strips these before re-adding) |
| `PackId` | which pack supplied it |
| `ReadOnly:"Y"` | from a subscription, not editable here |
| `Source` | display name of the subscribed pack |

`promote_homebrew.py` drops `Custom` when folding a pack into the base data.

## Editing protocol

See also “Editing game data” in `README.md`.

1. Edit whole rows; keep **one row per line** inside `tables`. Line-oriented rows
   let git diff and merge data changes instead of conflicting on one giant line.
   `promote_homebrew.format_bundle()` re-emits exactly this shape.
2. Keep it ASCII apart from the four sanctioned glyphs (below).
3. Run `python tools/check_data.py` — it re-parses the bundle and checks identity,
   registries and glyphs. Exit 1 means don't commit.
4. **Bump `CACHE_VERSION` in `sw.js`** so deployed clients drop their cached copy.
   `promote_homebrew.py` does this automatically; hand edits need it by hand.

## Conventions

- **Every value is a string**, including numbers: `"Cost":"20000"`,
  `"ZP Cost":"0.5"`. Read them through `asNumber(value, default)`
  (`rules.js:368`), which tolerates thousands separators and returns the default
  for `""` or non-numeric text. Never `parseInt` a cell directly.
- **Empty string means absent/null.** There is no `null` anywhere in `tables`
  (only in the `skills` map's `"group":null`). Columns like `ZR`/`BI` are `""` on
  most rows.
- **Non-ASCII is limited to exactly four glyphs.** `check_data.py` errors on any
  other: `°` (degrees), `½` (half-Strength melee damage), `×` (one
  cost-multiplier string in `heritage_features`), `ㄓ` (currency).
- **Key-column naming is inconsistent by design** — three styles, all live:
  `Name` (8 tables); the singular of the table (`Weapon`, `Armor`, `Vehicle`,
  `Drone`, `Item`, `Lifestyle`, `Spirit`, `Element`, `Material`, `Style`,
  `Extra`, `Level`, `Priority`, `Bond`, `Type`); and repeated-noun mod keys
  (`Rig Type`, `Deck Mod`, `Rig Mod`, `Vehicle Mod`, `Drone Mod`,
  `Modification`). Don't "fix" these — three registries and 17 lookups depend on
  them.

### Shared column families

Not declared anywhere in code, but consistent across tables:

| Columns | Where | Meaning |
|---|---|---|
| `Cost` | 25 tables | price in ㄓ (face value; surcharges applied in `rules.js`) |
| `ZR` / `BI` | 17 tables | Zoetic Rating / Body Index cost of carrying the item |
| `Effect` | 14 tables | short rules text shown in the UI |
| `Rarity` | 11 tables | availability rating |
| `Weight` | 8 tables | carried-weight contribution |
| `Damage` / `Pen` / `Accuracy` / `Ammo` | 5–6 tables | weapon stats (personal, drone, vehicle) |
| `ModeEffect` | 6 tables | fire-mode rider on the 4 unit-weapon tables + 2 mod tables |
| `Mount Types` / `Mount ZP` | armor, misc_gear, weapons | mount compatibility (added by `tools/add_mount_columns.py`) — see below |
| `Description` | 5 tables | long-form flavour/rules text |

### Rated program families, and Hacking

Ten program families are rated by a trailing number in the **name**, not a
separate column — `Acid Burn 1` … `Acid Burn 6`, `De-rez`, `Decoy`,
`Electric Strike` and the rest. Cost is the base × the rating. There is no
rating field to parse: the number in the name *is* the rating.

`Hacking 1` … `Hacking 6` (ㄓ5,000 × rating) follow that convention but are a
category of their own in the `Attack` column — value `"Hacking"`, alongside
`Attack` / `Control` / `Util` — so they group separately in both buy browsers.
A Hacking program is a deck's **operating system**:

- A deck names the one slotted into it in `deck.hacking`. **No program slotted
  is an error** — the deck doesn't run at all. One rated under ½ the deck's MCP
  (round down, min 1) is a **warning**: it runs badly. That split is JC-003's.
- `I/O: N/A`, so it costs no thread and no I/O. It is what makes the deck run,
  not a tool run on top of it.
- It moves between decks freely, and a character can own several ratings and
  match each to the deck that needs it. Nothing stops one copy being named by
  two decks — the reading is that you carry one chip and swap it.

`rules.js` exposes `isHackingProgram`, `hackingProgramRating` and
`deckHackingRequired`; the family is matched by `/^Hacking\s+(\d+)$/i`, so a
homebrew program called "Hacking 7" would be picked up as rating 7.

Before 2026-08-05 this was `character.hacking_rating`, a character-wide scalar
priced per level and attached to no deck.

### Gear mounts

A row with a non-empty `Mount Types` can host augments (`Power Armor`, `Arwin
Goggles`, `Helmet`, homebrew). Mounted augments live on the character's gear
entry, never in `character.augments`; their ZR must fit `Mount ZP` and never
counts against the character's own ZP; and their effects apply only while the
host is worn, carried or equipped.

**`Mount Types` grammar.** A comma-separated list of tokens, read by
`RULES.mountCapability`:

| Token | Means |
|---|---|
| `Any` | any non-Bioware augment |
| an augment **Type** (`Eyeware`) | the whole category |
| an augment **Name** (`Commlink`) | that one item, even if its category isn't listed |
| `!` prefix (`!Eye Laser`) | excluded — beats any inclusion, so cell order doesn't matter |

Bioware is never mountable, and Skillsofts never are either (they run from a
Chipjack wired into your head, not from a gear device) — both are enforced in
code rather than per row. The Helmet is the worked example: it takes Eyeware and
Earware wholesale, adds two Headware items by name, and excludes five.

**When a mounted augment duplicates a body one, the two ADD.** A second piece of
hardware does a second piece of work — attributes, armor, move, recoil, dodge,
melee exploit actions, damage reduction and skill bonuses all sum. The single
exception is `ballistic_armor_max`, which isn't a quantity but the best *single*
ballistic source (ballistic armor doesn't stack), so it takes the larger of the
two. See `mergeMountedAugments` in `rules.js`.

## Table catalogue

37 tables, 857 rows. “Key” is the column that identifies a row; a `+` means
identity is composite. Consumer counts are rough reference-frequency hints, not
call graphs.

| Table | Rows | Key | What it holds | Mainly used by |
|---|---|---|---|---|
| `amp_powers` | 26 | `Name` | Amp powers with `ZP Cost` | rules, app, sheet |
| `animals` | 9 | `Animal` | Summonable creatures for Create Darkenbeast / Bound Servant. `Move`/`Flight` in metres. `Attacks` is pipe-separated | rules, sheet, homebrew |
| `armor` | 16 | `Armor` | Worn armor, `Ballistic`/`Impact` | rules, app, sheet |
| `armor_extras` | 3 | `Extra` | Armor add-ons, cost `Multiplier` | rules, app |
| `armor_materials` | 6 | `Material` | Material cost `Multiplier` | rules, app |
| `armor_styles` | 7 | `Style` | Style multiplier + `Etiquette Bonus` | rules, app |
| `attribute_costs` | 29 | `Level` | Attribute point cost per level | rules |
| `augments` | 154 | `Name` | Cyberware/bioware/Fashionware; attribute deltas, armor, `Type`, `Rarity`, `Quality` | rules, app, sheet, homebrew |
| `fashionware_qualities` | 4 | `Quality` | Fashionware quality tiers, cost `Multiplier` | rules, app, sheet |
| `cyberguns` | 4 | `Type` | Implanted gun frames; `Pen`, `Bar` | rules, app, sheet |
| `deck_mods` | 4 | `Deck Mod` | Cyberdeck mods, `Slots` | rules, app, sheet |
| `decks` | 8 | `Name` | Cyberdecks; `MCP`, `Threads`, `Core` | rules, app, sheet |
| `drone_ballistic_weapons` | 9 | `Drone Ballistic Weapon` | Drone hardpoint ballistics | rules, app, sheet |
| `drone_energy_weapons` | 7 | `Drone Energy Weapon` | Drone hardpoint energy weapons | rules, app, sheet |
| `drone_mods` | 6 | `Drone Mod` | Drone modifications | rules, app, sheet |
| `drones` | 16 | `Drone` | Drone chassis; `Frame`, `Body` | rules, app, homebrew |
| `hack_actions` | 10 | `Group`+`Action` | Hacking action reference (display only) | sheet |
| `heritage_features` | 52 | `Category`+`Name` | Uplift types, Green boons/banes, per-`Category` | rules, app, sheet |
| `heritages` | 6 | `Name` | Heritages; `ZP`, `MinPriority` | rules, app |
| `lifestyles` | 5 | `Lifestyle` | `MonthlyCost` tiers | rules, app, sheet |
| `martial_arts` | 24 | `Style`+`Level` | Cumulative per-level style effects | rules, app, sheet |
| `misc_gear` | 60 | `Item` | General gear + Ammo, grouped by `Class`; `Notes` holds restrictions | rules, app, sheet, homebrew |
| `priorities` | 5 | `Priority` | Chargen priority table (points, cash, magic) | rules, app |
| `programs` | 121 | `Name` | Decking programs; `Action Type`, `Attack` | rules, app, sheet |
| `rig_mods` | 4 | `Rig Mod` | VCR mods; `Link`, `Hardening` | rules, app, sheet |
| `rigs` | 3 | `Rig Type` | VCRs; `Links`, `Cores`, `Bonus Dice` | rules, app, sheet |
| `rituals` | 9 | `Name` | Rituals; `Drain`, `Time` | app, sheet |
| `speaker_bond_costs` | 4 | `Bond` | Cumulative bond-slot costs | rules |
| `speaker_elements` | 6 | `Element` | Elements and their `Pool` | app |
| `speaker_infusions` | 7 | `Infusions` | Infusion costs — **key is plural** | rules, app |
| `speaker_spirits` | 16 | `Spirit` | Spirits; one column per infusion type, plus the bound writeup (`Bound Services`, statblock, `Special`) | rules, app, sheet, homebrew |
| `spells` | 64 | `Name` | Spells by `School`; `Drain`, `Duration` | rules, app, sheet, homebrew |
| `vehicle_ballistic_weapons` | 8 | `Vehicle Ballistic Weapon` | Vehicle ballistics | rules, app, sheet |
| `vehicle_energy_weapons` | 5 | `Vehicle Energy Weapon` | Vehicle energy weapons | rules, app, sheet |
| `vehicle_mods` | 6 | `Vehicle Mod` | Vehicle modifications | rules, app, sheet |
| `vehicles` | 23 | `Vehicle` | Vehicles; `Body`, `Handling`, `Cargo` | rules, app, sheet |
| `weapon_mods` | 18 | `Modification` | Weapon mods by `Slot` | rules, app, sheet, homebrew |
| `weapons` | 110 | `Weapon` | Weapons by `Type`; `Accuracy`, `Damage`, `Pen`, `Bar`, `Hands` | rules, app, sheet, homebrew |

17 of these are **homebrew-eligible** (users can add rows, and packs can be
promoted): `animals`, `rituals`, `spells`, `speaker_spirits`, `misc_gear`,
`augments`, `weapons`, `armor`, `vehicles`, `drones`, `weapon_mods`,
`vehicle_ballistic_weapons`, `vehicle_energy_weapons`,
`drone_ballistic_weapons`, `drone_energy_weapons`, `vehicle_mods`,
`drone_mods`. The rest are core rules data, editable only here.

The editor shows **18 tabs** for those 17 tables: ammunition has no table of
its own — a round is a `misc_gear` row whose `Class` starts with `Ammo` — so
the Ammo tab and the Gear tab are two filtered views of `misc_gear`, declared
with `table:` + `rowFilter` in `HOMEBREW_CONFIG`. Rows still store, merge,
export and promote as `misc_gear`; only the editor splits them.

### Per-table quirks

- **`spells`** — key is `Name`, but `School` is the *first* column. Mage
  characters are restricted to a single school (`rules.js:1550`).
- **`speaker_infusions`** — key column is `"Infusions"`, plural. The only table
  that does this (`rules.js:1567`).
- **`speaker_spirits`** — two text conventions, both parsed in `app.js`
  (`splitSpiritEntries` / `parseSpiritServices` / `withForce`) and rendered by
  `bondSpiritDetail` in `sheet.js`:
  - `Bound Services`, `Attacks` and `Special` hold **several entries in one
    cell, separated by `" | "`**. A service is `Name: text`; the name is
    everything before the first colon when that colon falls within 40
    characters, so ordinary prose colons stay in the body.
  - **A backslash escapes either delimiter**, so neither is barred from prose:
    `\|` is a literal pipe, `\:` a colon that is *not* a label separator, and
    `\\` a literal backslash. Anything else after a backslash is passed through
    with the backslash removed, so write `\\` whenever you want one to survive.
    Escapes are resolved after splitting, so `Toll\: paid in memories | Bargain:
    ...` is two entries and the first has no service name. The shipped data uses
    none of this — no cell in `data.js` contains a backslash at all — but a
    homebrew spirit writing `10\:00 sharp` or `black\|white` now renders it.
  - **`[F]` is the spirit's Force**, substituted live from the Force set on the
    bond slot (`play.bond_slots[i].force`) and shown as a dotted `F` when that
    is still 0. Write `[F]d6`, `6+[F]`, `2x[F]` — never the literal word.

  `Ballistic` and `Impact` are armor values (labelled *B Armor* / *I Armor* on
  the sheet). `Statblock Of` is normally blank; where the stats belong to a
  cohort the spirit summons rather than to the spirit itself it names that
  cohort, and the sheet titles the panel *Statblock — <that name>* (`Bacchanal`,
  `Cisseis the Menad`, `Mound of Skulls`). `Miasma` and `Stormwing` have no
  statblock at all and say so in `Special`.
- **`weapons`** — the `Type` column decides which skill a weapon rolls
  (`WEAPON_TYPE_SKILL` in `rules.js`, mirrored by `WEAPON_SKILL_BY_TYPE` in
  `sheet.js`; `WEAPON_NAME_SKILL` overrides it for the handful of rows that
  don't follow their type). **`Projectile`** is bows and crossbows and rolls
  **Archery**. Only firearm types take weapon mods and only firearm types can be
  smart-linked — `NO_WEAPON_MOD_TYPES` in `app.js` is the list.
- **`weapons` — STR-rated bows.** A crossbow is a fixed weapon like any other. A
  bow is built to a draw weight, and the Strength needed to draw it decides
  everything about it, so two columns mark a row as STR-rated (blank on every
  other row):

  | Column | Meaning |
  |---|---|
  | `StrCost` | price per point of Minimum Strength. Non-empty is what makes a row STR-rated |
  | `StrDmg` | added to Minimum Strength for damage |

  `Cost`, `Damage` and `Rarity` are left **blank** on those rows — all three are
  derived. Rarity is Minimum Strength ÷ 2, rounded down, for every bow.

  The Minimum Strength itself is chosen when the bow is bought and lives on the
  character's weapon entry as `min_str`, the way `smart` and `quality` do: it
  belongs to the item the character owns, not to the character. A Strength 18
  archer holding a minimum-4 bow still only gets what a minimum-4 bow does.
  `RULES.bowRating(row, entry)` resolves all of it and returns null for anything
  that isn't STR-rated, so it doubles as the "is this a bow" test.
- **`misc_gear` — `Ammo (Projectile)`** is arrows and bolts. The split from
  conventional ammunition is total in both directions: a bow chambers nothing
  else, and no firearm takes an arrow (`ammoFitsWeapon`). Note the class exists
  because the names would otherwise collide — there is already a conventional
  `Explosive` round, so the arrow is `Explosive Tip`.
- **`weapons`** — `Bar` is the **Barrier** rating, 0–5, for shooting through
  cover. It is on every row so `promote_homebrew.base_columns()` (which reads
  row 0 only) can't drop it, but a **blank means the stat doesn't apply** — melee
  and thrown weapons other than grenades — and prints nothing rather than a
  misleading `0`. Grenade launchers are blank too because they take Barrier from
  the chambered grenade, the way they already take `Damage` and `Pen`; their line
  shows an em dash until something is loaded. Ammo can adjust it: the prose says
  *Barrier* (`AP` is `"Pen +1, Barrier +1"`) while the column says `Bar`, and
  `AMMO_STAT_KEYS` in `rules.js` maps both spellings to the same key. Formatting
  for every stat line goes through `barrierBit()` in `app.js`.
- **`weapons` — `Hands`** is `1H` or `2H`, read by `RULES.weaponHands()` (blank
  or any other value is treated as `1H`, so an unlabelled homebrew row stays
  wieldable rather than becoming unassignable the moment this column exists).
  Drives the Overview Loadout's per-hand cards: a `2H` weapon claims its own
  hand slot and the next one. On every row (including row 0) for the same
  `promote_homebrew.base_columns()` reason as `Bar` above. The five
  `GrenadeLauncher` rows are all `1H` even though none of them is realistically
  wielded alone — four are underbarrel-granted (no hand of their own to begin
  with) and the fifth, `Militech M31-a1G`, is a directly-purchasable weapon
  gated by `Requires`, so marking it anything but `1H` would have made it
  vanish from the Loadout with no card to appear under. Revisit once mount-only
  weapons have a home of their own.
- **`cyberguns`** — carries the same `Bar` column, set to the mean Barrier of the
  weapons-table `Type` each frame corresponds to (Palm Pistol → `PistolLt`,
  Forearm SMG → `SMG`, Heavy Pistol → `PistolHvy`, Shotgun → `Shotgun`), rounding
  a half down. `Pen` is deliberately *not* averaged — those values predate the
  Barrier work and stand on their own.
- **`weapon_mods`** — `Laser Sight` and `Flashlight` each appear **twice**, once
  per `Slot` (Overbarrel / Underbarrel). Identity is really `Slot`+`Modification`,
  but `findRow(data.weapon_mods, "Modification", …)` (`rules.js:1659`) returns the
  **first** match, so the Overbarrel row's cost wins wherever a mod is resolved by
  name alone. `check_data.py` allowlists these two names; a *new* duplicate is an
  error. Both pairs currently price identically (Laser Sight 150, Flashlight 50),
  so which row wins costs nothing today — keep them in step, or the by-name
  lookup starts quietly overcharging for the Underbarrel fit.
  `Cost` is a flat figure **or** a percentage of the host weapon's own cost when
  the cell ends in `%` (`Bling` is `25%`, floored to whole woolongs) —
  `RULES.weaponModCost(modRow, base)` resolves either, and
  `RULES.weaponBaseCost` supplies the base (a bow's comes from its draw
  Strength, not a data cell). Anything pricing a weapon mod must go
  through those two, not `asNumber(row.Cost)`, which reads `"25%"` as 0.
- **`heritage_features`** — identity is `Category`+`Name` (`UpliftType`,
  `GreenBoon`, `GreenBane`, …), but `rules.js:580` builds
  `traitsByName[row.Name]` across *all* categories. `Name` is unique table-wide
  today (52/52) and must stay that way; `check_data.py` enforces it.
- **`decks` / `rigs`** — `Core`/`Cores` (`"Single"`…`"Quad"`) drive decking and
  rigging exploit-action counts for the character's one *active* deck/rig
  (`rules.js` `CORE_EXPLOIT_COUNT`, `activeGearRow`).
- **`martial_arts`** — rows are per `Level`; effects are cumulative up to the
  character's rank, so a style's rows must be contiguous and level-ordered.

### Non-table top-level keys

Seven keys sit beside `tables` (near the end of `data.js`) and are the only lines
that break the row-per-line rule — they're single long lines, so diffs on them are
noisy:

| Key | Shape |
|---|---|
| `attributes` | ordered list of the 6 attribute names |
| `skills` | 32 skills → `{pool, group}` (`group` is `null` or a group id) |
| `etiquettes` | list of the 7 etiquettes |
| `magic_by_priority` | priority level → magic label |
| `magic_types_allowed_by_priority` | priority level → allowed magic types |
| `heritage_availability` | priority range (`"2-4"`) → heritages |
| `action_reference` | 7 display-only action-reference sections |

## Gotchas

1. **Numbers are strings** — always `asNumber()`. See Conventions.
2. **Rows within a table do not share a column set.** Five tables are ragged:
   `weapons` (8 distinct column sets), `heritage_features` (4), `weapon_mods`,
   `vehicle_mods`, `drone_mods` (2 each). New columns were added to some rows only.
   (`augments` and `misc_gear` were normalised to one uniform column set when
   Fashionware and Ammo were added — keep them that way.)
3. **The row-0 hazard.** `promote_homebrew.base_columns()` takes a table's
   canonical column set from **row 0 alone**, so promoting a pack row into a ragged
   table silently drops any column that only later rows carry. `check_data.py`
   reports these as warnings ("promoted rows would LOSE …"). If you need one of
   those columns to survive promotion, add it to row 0 (empty string is fine)
   first.

   **No homebrew-eligible table has a row-0 gap today** — `weapons` (`Damage
   Bonus`, `Heat`, `Integrated Smart`, `Max Heat`, `Requires`, `STR Mult`) and
   `weapon_mods` (`Req Type`) were filled in when those columns were added to
   `HOMEBREW_CONFIG`, because an editable column that promotion drops is the
   worst of both worlds. The one remaining gap is `heritage_features`
   (`GearCostMultiplier`, `SmallUplift`), which homebrew does not cover.
   Exposing a column in the editor and adding it to row 0 go together.

   **This bites scripts too.** Any tool that rewrites a table row-by-row must
   build its column list from the **union of every row**, never from row 0 — the
   `augments` normalisation above silently dropped `Damage`, `Req Limb`,
   `MoveMode`, `AltMove` and `STR Mult` on the first attempt, all of which
   `rules.js` reads (implant damage, limb requirements, Mobi movement modes).
   Diff old vs. new for lost non-empty values before committing a data script.
4. **Key-column knowledge the checker cannot see.** Call sites that pass the table
   or column through a variable are invisible to the `findRow` regex — `hostKinds`
   (`rules.js:1154`), `weaponAndModTables` (`rules.js:1903`), `priceAll`
   (`rules.js:1975`), `activeGearRow` (`rules.js:2060`). Rename a key column and
   you must grep these by hand.
5. **Renaming a table or key column touches four places** — see the banner at the
   top.
6. **`CACHE_VERSION`** — forgetting the bump means deployed clients keep serving a
   stale `data.js` from the service-worker cache.

## Tooling

| Command | Does |
|---|---|
| `python tools/check_data.py` | all checks below; exit 1 on error |
| `python tools/check_data.py --strict` | warnings fail too |
| `python tools/check_data.py --data PATH` | check a copy (useful for testing) |
| `python tools/promote_homebrew.py pack.json` | fold a homebrew pack into `data.js`, bump `CACHE_VERSION` |
| `python tools/promote_homebrew.py pack.json --dry-run` | report only |

`check_data.py` checks: bundle parses (same split the promoter uses) · the three
key registries agree with each other and the data · key columns present,
non-empty and case-insensitively unique · column-set drift and row-0 losses ·
`HOMEBREW_CONFIG` field keys exist · **and every column a homebrew table carries
has a `HOMEBREW_CONFIG` field** (an error, not a warning) · only the four
sanctioned glyphs.

Expected clean run today: **0 errors, 6 warnings** — all drift, all pre-existing.
