# Judgement calls

Open questions about behaviour that is **defensible but undecided**. A test that
lands here is not a bug report — it is a request for a ruling from the owner.

Testers **append**; only the owner fills in `RULING`. Never resolve one of these
yourself, and never "fix" the code to match your guess.

## When to file one

File a JC when any of these is true:

- The code does something consistent and deliberate-looking, but whether it is
  *correct* depends on a rules decision nobody has written down.
- Two parts of the app disagree and neither is obviously wrong.
- A cap or limit exists as a warning in one place and an error in another.
- You cannot determine the intended behaviour from the code, comments or docs.

Do **not** file a JC for something that is plainly broken — a crash, a wrong sum,
a leak. That is a FAIL, and it goes in the findings file.

## Entry format

```markdown
## JC-0NN: <short title>
- **Status:** OPEN
- **Where:** <file:line>
- **Observed:** <what the code does today, 2-3 sentences>
- **Question:** <the single decision needed>
- **Options:** A) … B) … C) …
- **Raised by:** <test IDs>
- **RULING (owner only):** _
- **Follow-up on ruling:** <what changes once this is decided>
```

Number sequentially from the highest existing JC. Never reuse a number.

A `RESOLVED` entry keeps its original Observed/Question text — it is the record
of why the decision was needed — and gains an **Applied** line saying what the
code does now. Don't delete resolved entries; a re-run that finds the old
behaviour back is a regression, and this is what it's measured against.

## Where things stand

**JC-001 … JC-025 are all ruled on and implemented.** The rulings came from
[issue #27](https://github.com/cheeplives/sinless-app-beta/issues/27) and the
follow-up round.

Four are ruled *no change* — the current behaviour is accepted, and the entries
record why so a later run doesn't re-litigate them: **JC-015** (unlimited reads
on a members-only instance), **JC-018** (imported image URLs rely on the CSP),
**JC-025** (no host mounts a Smartlink, so JC-009's third case is unreachable),
and the picker half of **JC-008**.

**JC-018 is the one to come back to.** It is marked RESOLVED but the owner asked
to keep it in view for a second look once the rest settled; the entry says what
to weigh.

**JC-026 is OPEN** — whether a known spell's `Skill Bonus`/`Skill Note` should
apply unconditionally, surfaced by the effect-text-review pass and not yet a
live issue (no spell has either column populated today), but worth ruling on
before one does.

**JC-027 is RESOLVED in the same round it was raised** — the engine and the
sheet disagreed about whether a hotseat flag is deployment; ruled a modifier on
an already-deployed unit, applied in v338.

---

## JC-001: Skill specializations are free, uncapped and unprerequisited
- **Status:** RESOLVED
- **Where:** `static/app.js` (`tabStats`, the specialization inputs); `character.skill_specializations`
- **Observed:** A specialization is written straight onto the character and costs
  nothing. There is no point cost, no limit on how many skills may be
  specialized, and no check that the skill has any ranks. `weaponSpecAdjust()`
  then consumes it for a real ±1 dice swing.
- **Question:** Should specializations cost something, be capped in number, or
  require at least 1 rank in the parent skill?
- **Options:** A) Leave free and uncapped — they are a flavour split, not power.
  B) Require ≥1 rank in the skill. C) Cap the count (e.g. one per skill group).
  D) Charge a skill point.
- **Raised by:** P03
- **RULING (owner only):** **B — require ≥1 rank in the parent skill.** Free and
  uncapped otherwise.
- **Applied:** `scoreSkills` errors with `"<skill>: a specialization needs at
  least 1 rank in the skill."`. In chargen the Spec toggle only appears once the
  skill is bought, and stepping a skill across 0 ↔ 1 re-renders the row; the
  stored flag is left alone, so dropping a skill to 0 and back brings its
  specialization with it. The play sheet already gated on `final > 0`.
  New case: P03-011.

## JC-002: Rank and attribute caps warn but do not block
- **Status:** RESOLVED
- **Where:** `static/rules.js` — skill cap ~L1606, attribute max ~L1523
- **Observed:** Exceeding `SKILL_RANK_CAP` (6) or an attribute's maximum produces
  a *warning*. Warnings do not disable the Finalize button, so a character can be
  finalized above both caps. `maxed-mage.json` finalizes with Sorcery 7.
- **Question:** Are creation caps advisory or binding?
- **Options:** A) Keep as warnings — the GM adjudicates. B) Promote to errors so
  finalize is blocked. C) Keep as warnings but clamp the stepper so the state is
  unreachable through the UI.
- **Raised by:** P01, P03
- **RULING (owner only):** **C — still warnings, but unreachable through the UI.**
- **Applied:** The skill stepper is bounded by `RULES.SKILL_RANK_CAP` instead of a
  hard-coded 6, and each attribute stepper stops at `max(1, c.max − c.adjust,
  c.base)` — the largest base level that keeps Final inside the attribute's
  maximum. The `c.base` term means an imported character already over its
  maximum keeps its value rather than being yanked down by a "+". Both breaches
  still warn, so `maxed-mage.json` is unchanged.

## JC-003: Deck / drone / vehicle limit breaches are finalizable
- **Status:** RESOLVED
- **Where:** `static/rules.js` — `checkVehicleLimits`, `checkDroneLimits`, deck and rig pricing
- **Observed:** Exceeding a rig's drone capacity, a vehicle's mod limits or a
  deck's slot count warns but does not block finalize.
- **Question:** Same as JC-002 but for equipment limits — advisory or binding?
- **Options:** A) Advisory. B) Binding. C) Binding only where the limit is
  physical (slots) and advisory where it is a guideline.
- **Raised by:** P05
- **RULING (owner only):** **C — binding where the limit counts physical slots.**
- **Applied:** The line is *slots and mount points bind; capacities and formulas
  advise*. Now errors: deck mod slots, rig mod slots, drone hard points, weapon
  mod slots (Overbarrel / Underbarrel / Chassis). Still warnings: a deck's
  required Hacking rating, a vehicle's leftover Cargo, the Body ÷ 3 vehicle
  weapon cap, and a drone's loaded weight against WW. Drone hard points bind
  while the vehicle weapon cap doesn't, and that asymmetry is the ruling: one
  counts mounts, the other is a formula.

## JC-004: Gear ZR counts unowned-state items inconsistently
- **Status:** RESOLVED
- **Where:** `static/rules.js` `gearZoeticRating` (~L2606)
- **Observed:** Weapons contribute only when `equipped`, armor only when
  `active` — but **decks, programs, drones and vehicles contribute
  unconditionally**, whether or not they are carried or in use.
- **Question:** Should ZR come from what you are *carrying* or from what you
  *own*?
- **Options:** A) Carried — filter decks/programs/drones/vehicles the way
  weapons and armor are filtered. B) Owned — remove the equipped/active filters
  so everything counts. C) Intentional as-is: some gear is always "on you".
- **Raised by:** P02
- **RULING (owner only):** **A — carried.** Programs are the exception: they are
  part of the deck and shouldn't need to be "carried" at all — they are either
  loaded on it or they aren't.
- **Applied:** Decks, drones and vehicles take the same permissive `carried !==
  false` flag misc gear uses, with a Carried toggle on their rows in both chargen
  and the play sheet.

  Programs have no carried flag and don't get one. A program counts when it is
  **loaded** onto the deck you're running, read from `play.decking.loaded` — the
  same list the Decking tab's Load button writes. A program whose `I/O` never
  occupies a thread (`N/A` or `No`) is never "loaded" in that sense; it runs
  whenever the deck does, so it counts with it. `RULES.programNeedsThread` is
  that predicate and both the Load button and the ZR rule call it, so they can't
  drift. Stash the deck and nothing on it counts, loaded or not.

  Nothing is loaded during creation, so only the always-on programs contribute
  there. In the shipped data this is all academic — **no program has a non-zero
  ZR** — but it decides the answer for homebrew ones.

## JC-005: No rig ever contributes gear ZR during chargen
- **Status:** RESOLVED
- **Where:** `static/rules.js` `gearZoeticRating`; keyed on `play.rigging.active_rig`
- **Observed:** Rigs contribute ZR only when they are the *active* rig, and
  `active_rig` is `""` for the whole of character creation. A rig bought in
  chargen therefore contributes nothing until play begins.
- **Question:** Should a rig's ZR count during creation?
- **Options:** A) Yes — treat an owned rig as active during chargen. B) No —
  current behaviour is correct, ZR is about what is jacked in. C) Yes, and add a
  chargen-side active-rig selector.
- **Raised by:** P02
- **RULING (owner only):** **C — it counts, and chargen gets a selector.**
- **Applied:** `gearZoeticRating` resolves the active rig through
  `activeGearRow`, which falls back to the first owned rig when none is flagged
  — the same fallback `deriveExploitActions` and the Rigging tab already used, so
  the three now agree. The Rigging tab in chargen gained an **Active rig** card
  writing the same `play.rigging.active_rig` the play sheet uses.

## JC-006: Mounted augments combine with mixed add-vs-max semantics
- **Status:** RESOLVED
- **Where:** `static/rules.js` `mergeMountedAugments` (~L1382)
- **Observed:** When a gear-mounted augment duplicates a body one, the two are
  combined differently depending on the stat:

  | Stat | Combined by | Note |
  |---|---|---|
  | Attributes (all six) | **add** | including their max adjustments |
  | Move bonus | **add** | |
  | Recoil capacity | **add** | |
  | Impact / Ballistic armor | **add** | |
  | Un-strippable impact armor (`ImpArmMin`) | **add** | |
  | Cost | **add** | not a rules question |
  | Dodge bonus | **max** | |
  | Melee exploit actions | **max** | |
  | `ballistic_armor_max` | **max** | the ballistic cap, so max is arguably forced |
  | Physical damage reduction | **max** | |
  | Skill bonuses | **max** | but their *notes* concatenate, so the sheet lists both sources for one bonus |

  (That table is the state **before** the ruling — it's what the question was
  about. Everything in the max column except `ballistic_armor_max` now adds.)

- **Question:** For each row above, is add or max correct?
- **Options:** A) Intentional — document the rule behind it. B) Uniform max.
  C) Uniform add. D) Per-stat, as ruled row by row above.
- **Raised by:** P02
- **RULING (owner only):** **C, with one exception — everything adds except
  `ballistic_armor_max`.** That one is the only case where the max is forced.
- **Applied:** `mergeMountedAugments` adds every field. The four that used to
  cap — dodge, melee exploit actions, physical damage reduction and skill
  bonuses — now sum, so a second copy of an augment does a second copy of the
  work. `ballistic_armor_max` still takes the larger of the two, because it
  isn't a quantity: it's the best *single* ballistic source, and ballistic armor
  doesn't stack.

  Skill-bonus notes already concatenated, and now that the bonus itself adds
  they no longer read as two explanations for one number. Documented under the
  mount conventions in `docs/DATA.md`.

## JC-007: Duplicate items are never deduplicated
- **Status:** RESOLVED
- **Where:** `static/rules.js` `priceArmor` (~L2364) and the gear pricing generally
- **Observed:** The same armor row can be added twice and both copies count as
  `active`, summing their armor values. This only warns ("More than one X armor
  piece is active"). The same is true of duplicate gear, decks and programs.
- **Question:** Should identical duplicates stack, or should the engine collapse
  them?
- **Options:** A) Stack — the player is responsible. B) Collapse duplicates when
  computing armor. C) Promote the warning to an error.
- **Raised by:** P02, P05
- **RULING (owner only):** **A — they stack.** But make sure every case warns.
- **Applied:** `calculate` warns once per repeated name for decks, programs and
  gear: `"<kind> <name> is listed more than once — the copies stack."`. Armor
  keeps its existing per-slot warning, which is the more useful message there
  because `active` is what decides whether the copies actually sum.

## JC-008: Augment tier exclusivity is enforced only in the picker
- **Status:** RESOLVED
- **Where:** UI: `static/app.js` `augmentAvailability` / `NAMED_TIERS`. Engine: nothing.
- **Observed:** The picker hides lower tiers of an owned family (Bone Lacing,
  Wired Reflexes), but `rules.js` never re-checks. A character that acquires both
  tiers by import, homebrew or hand-edited JSON keeps both and gets both effects.
  `synthetic-augmented.json` demonstrates this and loads with zero complaints.
- **Question:** Should tier exclusivity be a rule the engine enforces, or a UI
  affordance only?
- **Options:** A) Engine rule — add an error. B) UI only — accept that imported
  characters can hold both. C) Engine warning rather than error.
- **Raised by:** P02, P08
- **RULING (owner only):** **A — an engine rule, and an error.**
- **Applied:** Tier parsing moved into `rules.js` as `augmentTier` /
  `augmentStacks`, and `augmentAvailability` now calls them — so the picker hides
  exactly what the engine refuses. `tallyAugments` errors with `"<family>: only
  one tier may be installed — remove all but one of …"`. The error is also
  play-relevant (JC-012), because an illegal implant doesn't become legal at
  Finalize. `synthetic-augmented.json` is now a 1-error fixture, deliberately not
  repaired — it's the proof the engine no longer takes the picker's word.

## JC-009: Smartlink is matched by name only
- **Status:** RESOLVED
- **Where:** `static/rules.js` `priceWeapons` (~L2151)
- **Observed:** The +1 Accuracy for a smart weapon checks only that an augment
  named `Smartlink` appears in `character.augments`. It does not check whether
  that Smartlink is gear-mounted, on an uncarried host, or otherwise inactive.
- **Question:** Should an inactive or unmounted Smartlink still grant its bonus?
- **Options:** A) No — gate it the way mounted augments are gated elsewhere.
  B) Yes — an implanted Smartlink is always live. C) Depends on where it is
  installed; needs a rules decision first.
- **Raised by:** P02
- **RULING (owner only):** **C, with the rule stated.** A Smartlink comes three
  ways: (1) installed by itself — Eyeware with no Cybertechtronic Eye — always
  active; (2) installed in a suite of eyeware inside a Cybertechtronic Eye —
  always active; (3) mounted on a Helmet or Arwin Goggles — active only while
  that host is equipped.
- **Applied:** `priceWeapons` takes the set of augment names that are actually
  live, built from `augments.rows` after `mergeMountedAugments`. That list is
  body augments plus mounted ones whose host is worn, so all three cases fall out
  of one lookup: (1) and (2) are body augments and always present, (3) drops out
  when the host isn't equipped. See **JC-025** — in the shipped data Smartlink is
  *Headware*, so case (3) currently has no host that will mount it.

## JC-010: Play-mode weapon and armor purchases land in the chargen arrays
- **Status:** RESOLVED
- **Where:** `static/sheet.js` `shGear` (weapon and armor buy paths)
- **Observed:** Gear, augments, amp powers, spells and hacking levels bought in
  play go into `CHAR.play.purchases.*`. **Weapons and armor do not** — they are
  pushed straight onto `CHAR.weapons` / `CHAR.armor`, the same arrays chargen
  uses. Going Back to Chargen therefore charges them against the creation cash
  budget, and `revertToChargenEnd()` does not remove them.
- **Question:** Should play purchases of weapons and armor be tracked separately
  like every other category?
- **Options:** A) Yes — move them into `play.purchases` for consistency.
  B) No — but then Back to Chargen must exclude them from the budget.
  C) Accept the leak; Back to Chargen is a rare escape hatch.
- **Raised by:** P06
- **RULING (owner only):** **A — move them into `play.purchases`.**
- **Applied:** `play.purchases` gained `weapons` and `armor`;
  `applyPlayAdvances` appends them **after** the chargen entries, so index N of
  `character.weapons` is still index N of `CALC.weapons`. The sheet reads the
  union through `allWeapons()` / `allArmor()`, and edits go through
  `ownedWeapons()` / `ownedArmor()`, which tag each entry with the array it lives
  in — so removing and reordering hit the right one. Reordering is confined to
  the owning array, since dragging a play purchase above a chargen one would
  change which budget paid for it. (`play.armor_worn` indexed `CHAR.armor` alone
  and stayed correct here because Revert clears the purchases anyway; the
  `play.kit` bright line has since retired that field entirely — worn flags now
  live on the kit copy, so there is no index into a chargen array left to keep
  in step.)
- **Note:** decks, programs, rigs, drones and vehicles bought in play still push
  straight onto the chargen arrays. That is the same leak and was not part of
  this ruling — filed as **JC-024**.

## JC-011: Cash purchases have no refund path
- **Status:** RESOLVED
- **Where:** `static/sheet.js` — `logCash` is append-only; item removal splices without crediting
- **Observed:** Kismet spends of kind `attribute`, `skill`, `martial_art`,
  `ritual` and `zp` all have working Undo. Cash purchases do not: removing a
  bought item deletes the row without refunding. The only exceptions are two
  Knowledge Skillsoft paths, which do credit back.
- **Question:** Should removing a play-mode purchase refund its cash?
- **Options:** A) Yes — mirror the kismet undo. B) No — cash spent is spent; add
  a manual adjustment instead. C) Yes, but only within the same session.
- **Raised by:** P06
- **RULING (owner only):** **A, scoped to the ledger.** Undo lives only in the
  Activity list at the bottom of the Gear tab, and refunds in full.
- **Applied:** `logCash` takes an optional serializable `undo` descriptor
  (cash_log is persisted as JSON, so no closures), mirroring `spendKismet`.
  Covered kinds: weapon, armor, gear, augment, spell, hacking level, weapon mod,
  armor extra, gear mount, prepaid lifestyle month. Each Activity row with a
  descriptor gets an Undo button; the item goes and the money comes back. The
  per-row ✕ on the tabs above still just removes the item, and the card says so.
  Entries with nothing to reverse — manual adjustments, α-grade upgrades, quality
  changes, the starting cash roll — get no button. If the item is already gone,
  Undo says so and leaves the ledger entry alone rather than paying twice.

## JC-012: Errors and warnings are blanked once finalized
- **Status:** RESOLVED
- **Where:** `static/rules.js` ~L3526
- **Observed:** `calculate` returns empty `errors` and `warnings` arrays whenever
  `finalized` is true. An illegal state introduced in play — Body Index over
  Body, cash overdrawn, martial rank above Unarmed — is therefore completely
  invisible. Only the inline `confirm()` prompts in the buy paths push back.
- **Question:** Should the play sheet surface validity problems?
- **Options:** A) Keep blanked — creation rules stop applying after finalize.
  B) Show a reduced set that still makes sense in play (cash, Body Index).
  C) Show everything but style it as advisory.
- **Raised by:** P06
- **RULING (owner only):** **B — a reduced set.**
- **Applied:** `calculate` collects a parallel `playErrors` / `playWarnings` pair
  and returns those instead of `[]` when finalized. The set is *what is installed
  in your body, and what is in your wallet*: augment conflicts, the Synthetic
  Bioware ban, augment requirements, tier exclusivity (JC-008), Body Index over
  Body, a martial art above Unarmed Combat, an overdrawn `play.cash`, and the
  three worn-armor warnings (Tough, Antlers, internal armor slot). The chargen
  `Cash overspent` error is deliberately **not** included: after Finalize the
  creation budget no longer means anything, since play purchases are appended to
  the same arrays. Overloaded mounts and the magic/Amp OFFLINE state are also
  excluded — the sheet already has dedicated read-outs for both, and a second
  copy would only add noise. A **Needs attention** card at the top of the play
  Overview renders whatever survives; it is silent for a clean character.

## JC-013: Import validation is a single truthiness check, and advances are unclamped
- **Status:** RESOLVED
- **Where:** `static/sheet.js` (the import file input); `static/rules.js` `applyPlayAdvances`
- **Observed:** Character import accepts anything that parses as JSON, is a
  non-array object, and has a truthy `.attributes`. `applyPlayAdvances` then
  applies `skill_advances` / `attribute_advances` with no cap check — it only
  verifies the key exists. Ritual advances, spell force advances, purchases and
  `pool_kismet` are not key-checked at all.
- **Question:** How much should import trust a file?
- **Options:** A) Validate shape and clamp advances to the same caps the UI
  enforces. B) Trust the file — hand-editing is a feature for a local-first app.
  C) Trust it but surface a warning banner on an out-of-range character.
- **Raised by:** P08
- **RULING (owner only):** **A — validate the shape and clamp the advances.**
- **Applied:** `RULES.validateCharacterShape(value)` returns `{ ok, problems }`
  and checks what `mergeDefaults` and the engine actually rely on: object-vs-list
  per key, numeric attributes (tested directly, not through `asNumber`, which
  coerces junk to 0 on purpose), and `magic.spells` / `magic.amp_powers`. Import
  lists every problem at once instead of a flat "no". It stays a **shape** check:
  an out-of-range character still imports and is then told so by the normal
  errors, because hand-editing a save is supported and being handed a file that
  isn't a character is not.
  In `applyPlayAdvances`, skills clamp to `PLAY_SKILL_RANK_CAP` (8 — rank 6 by
  Kismet, 7 on a mastery boon, 8 on a major one), attributes to
  `ATTRIBUTE_LEVEL_MAX`, hacking to `HACKING_RATING_MAX`, spell force to
  `SPELL_FORCE_MAX`; martial-art styles and ritual names are key-checked against
  the data; negative advances are discarded, so nothing here ever lowers a value.
  `pool_kismet` is key-checked and floored at 0.

## JC-014: Finalizing does not check name uniqueness
- **Status:** RESOLVED
- **Where:** `static/app.js` `finalizeCharacter`; `static/storage.js` `sanitizeName`
- **Observed:** Finalize requires a non-empty name and no errors, but does not
  check whether that name is already taken. Saving keys on the sanitised name, so
  finalizing under an existing name silently **overwrites** the other character.
  Note `"Ada Lovelace"` and `"Ada-Lovelace"` sanitise identically.
- **Question:** Should saving over an existing character require confirmation?
- **Options:** A) Yes — prompt on collision. B) Yes — auto-uniquify the way
  `uniqueCopyName` does for duplicates. C) No — overwriting is the expected
  behaviour of a save.
- **Raised by:** P05, P08
- **RULING (owner only):** **A — prompt on collision.**
- **Applied:** A character now remembers the slot it came from in `saved_as`
  (stamped by `cacheCharacter` and by `loadCharacter`), which is what lets
  `STORAGE.collidingCharacter(character)` tell "overwriting myself" from
  "overwriting someone else". It returns the stored character's own name — which
  may be spelled differently — or null. Both Finalize and the sheet's Save button
  confirm before replacing, naming who would be lost.

## JC-015: Read endpoints are not rate limited
- **Status:** RESOLVED — no change
- **Where:** `api/lib.php` `rate_limit`; call sites in `api/*.php`
- **Observed:** Rate limiting covers `login`, `callback`, authenticated `write`
  and `admin`. Plain GETs — including the shared-character and homebrew
  galleries — are not limited, so an approved member can enumerate them freely.
- **Question:** Is unlimited read acceptable for a members-only instance?
- **Options:** A) Yes — every reader is an approved member already. B) Add a
  read bucket. C) Limit only the gallery endpoints.
- **Raised by:** P12
- **RULING (owner only):** **A — acceptable.** Every reader is an approved
  member.
- **Applied:** Nothing. Worth revisiting only if signup ever stops being
  approval-gated, which is the assumption this rests on.

## JC-016: Heritage priority error renders with a blank subject
- **Status:** RESOLVED
- **Where:** `static/rules.js` `resolvePriorities` (~L719)
- **Observed:** With no heritage chosen, the error reads
  `" requires a higher Heritage priority (available at priority 0: Human,
  Replicant)."` — leading space, no subject. `fresh-default.json` shows it.
  The message is only sensible once a heritage has actually been picked.
- **Question:** Should an unchosen heritage produce this error at all?
- **Options:** A) Suppress it while `heritage.type` is empty and rely on a
  "choose a heritage" error instead. B) Keep the check but name the subject.
  C) Cosmetic only; leave it.
- **Raised by:** P01 (found while authoring the fixtures)
- **RULING (owner only):** **A.**
- **Applied:** An empty `heritage.type` produces `"Choose a heritage (available
  at priority N: …)"` instead, which still names what's on offer. The
  higher-priority message is unchanged for a heritage that *is* chosen but out of
  reach. `fresh-default.json` still has three errors; the second one now reads
  properly, and the fixtures README records the new text.

## JC-017: Touch targets are far below any tablet guideline
- **Status:** RESOLVED
- **Where:** `static/style.css` — stepper and small-button sizing
- **Observed:** Measured identically at 834×1194, 1194×834 and 1024×1366: on the
  play Overview 47 of 65 visible buttons are under 32 px tall with a minimum of
  **11 px**; on the chargen Stats tab **107 of 108** are under 32 px. Controls
  are sized in fixed pixels and do not respond to viewport or pointer type. No
  horizontal overflow at any viewport, and no overlapping targets — the issue is
  purely size.
- **Question:** Should the app enlarge hit areas on touch devices?
- **Options:** A) Leave as-is — density is the point and tablet users can zoom.
  B) Add a `@media (pointer: coarse)` block enlarging stepper and icon-button hit
  areas without changing the desktop layout. C) Enlarge everywhere.
- **Raised by:** P13-004
- **RULING (owner only):** **B — coarse pointers only.**
- **Applied:** The existing `@media(pointer:coarse)` block was extended to raise
  everything clickable to a 32 px floor: steppers and their value, `.mini-btn`,
  `.row-del`, `.btn` / `.btn-add` / `.counter` (min-height only — a width floor
  would stretch the rows they sit in), `.chip-btn`, the reorder arrows, and
  checkboxes/radios to 20 px, which are the densest targets on the Gear tab.
  Labelled controls grow by padding rather than fixed size, so text isn't
  clipped. Desktop density is untouched. P13-004 should be re-measured with the
  browser reporting a coarse pointer, not just a tablet viewport — the original
  measurement wouldn't have had this block active either way.

## JC-018: Imported image URLs are not restricted to data:
- **Status:** RESOLVED — no change, but held for a second look
- **Where:** `static/sheet.js` — the images card sets `src` from `play.images[].url`
- **Observed:** Images added locally are re-encoded through a canvas and are
  always `data:` URLs. An **imported or shared** character's URLs are never
  re-validated, so an arbitrary string reaches `img@src`. A `javascript:` URL
  does not execute there, but an off-origin URL is fetched — disclosing the
  viewer's IP and that they opened that character. The deployed CSP
  (`img-src 'self' data:`) blocks it; a plain static host has no CSP.
- **Question:** Should imported image URLs be restricted?
- **Options:** A) Accept only `data:` on import, dropping anything else.
  B) Keep as-is and rely on CSP. C) Keep the URL but require confirmation before
  loading an off-origin image.
- **Raised by:** P11-004
- **RULING (owner only):** **B — rely on CSP.** Keep this open for a secondary
  review once the rest of this round is implemented.
- **Applied:** Nothing yet, by ruling. For that second look, the thing to weigh
  is that (B) covers the deployed site and nothing else: GitHub Pages and a local
  `file://` or `python -m http.server` install serve no `.htaccess`, so a shared
  character opened there still fetches off-origin images. If the app is only ever
  read from discreteinfinity.com that is fine; if it isn't, (A) is a two-line
  filter on import. `hostile-payloads.json` carries both URL shapes for testing.

## JC-019: Two definitions of the play object disagree
- **Status:** RESOLVED
- **Where:** `RULES.defaultCharacter().play` vs `ensurePlay()` in `static/sheet.js`
- **Observed:** Neither key set is a superset of the other. Only in
  `defaultCharacter`: `dodge_dice`, `martial_art_advances`,
  `replicant_lifespan_months`, `ritual_advances`. Only in `ensurePlay`:
  `armor_worn`, `bond_slots`, `images`, `infusion_spirits`, `pool_boost`,
  `pool_kismet`. Which keys a character has depends on whether it was created
  fresh or topped up on entry to the sheet.
- **Question:** Should there be one definition?
- **Options:** A) Make `ensurePlay` merge `defaultCharacter().play` so there is a
  single source of truth. B) Keep both but document why they differ.
- **Raised by:** P08-007
- **RULING (owner only):** **A.**
- **Applied:** `ensurePlay` now spreads `RULES.defaultCharacter().play` and adds
  only the fields the engine has no opinion about (`pool_boost`, `pool_kismet`,
  `images`, `infusion_spirits`, `bond_slots`), each commented. A character
  created fresh and one topped up on entry now carry the same keys. `armor_worn`
  was a sixth of these when this was ruled; the `play.kit` bright line (JC-024)
  later retired it, which is why P08-007 now expects five.
- **Still open from the follow-up:** the heritage half of P08-005 didn't turn out
  to be a disagreement — `defaultCharacter()` sets `heritage.type: "Human"`, and
  `mergeDefaults` fills an *absent* heritage from that same default, so the two
  agree. The remaining wrinkle is that a heritage explicitly set to `""` (which
  is what `fresh-default.json` holds) is left alone by `mergeDefaults`, so
  "absent" and "empty" differ. That is now visible rather than silent, thanks to
  JC-016's `"Choose a heritage"` error.

## JC-020: A Mage with no school can take any spell
- **Status:** RESOLVED
- **Where:** `static/rules.js` — the school check is `if (row && school && …)`
- **Observed:** Choosing no school is only a warning, and with `school` empty the
  out-of-school check is skipped entirely. A schoolless Mage can therefore take
  spells from every school and still finalize.
- **Question:** Should a Mage be required to choose a school?
- **Options:** A) Promote the missing-school warning to an error. B) Treat an
  empty school as "no spells permitted". C) Leave it.
- **Raised by:** P04-004
- **RULING (owner only):** **A.**
- **Applied:** `"Mage: choose one School of magic."` is now an error, so a
  schoolless Mage cannot finalize and the out-of-school check can no longer be
  skipped by leaving the field blank.

## JC-021: Switching the priorities house rule rewrites the character
- **Status:** RESOLVED
- **Where:** `static/app.js` `tabPriorities` — auto-seeds a permutation on switch
- **Observed:** Changing from point-buy to classic silently overwrites
  `CHAR.priorities` with a valid permutation. The player's previous allocation is
  gone with no prompt and no undo.
- **Question:** Should the rewrite be confirmed first?
- **Options:** A) Prompt before rewriting. B) Keep the old values and let the
  resulting error guide the player. C) Leave as-is — the rewrite is a
  convenience.
- **Raised by:** P03-004
- **RULING (owner only):** **A — prompt first.**
- **Applied:** The seeding moved out of the tab render into
  `seedClassicPriorities(ask)`, called with `ask: true` from the ⚙ house-rule
  handler and `ask: false` from `tabPriorities`. A character with nothing
  allocated is still seeded silently — there is nothing to lose. One that has an
  allocation is asked, and declining keeps the numbers with the engine's "assign
  each letter exactly once" error to guide the fix, which is effectively option
  (B) as the fallback. Only the switch itself asks, so declining doesn't mean
  being re-prompted every time the tab is opened.

## JC-022: Homebrew rows get no schema validation and name collisions are silent
- **Status:** RESOLVED
- **Where:** `static/homebrew.js` `mergeCustomContent` / `HB_COLLISIONS`
- **Observed:** A homebrew weapon with almost no columns is accepted, costs 0,
  contributes 0 ZR, and raises nothing — missing numerics read as 0 via
  `asNumber`. Separately, a homebrew row whose name matches a core row is
  dropped by the first-writer-wins rule and recorded only in `HB_COLLISIONS`,
  which has no UI at all.
- **Question:** Should authoring mistakes be surfaced?
- **Options:** A) Validate required columns per table and warn in the editor.
  B) Surface `HB_COLLISIONS` in the homebrew UI. C) Both. D) Neither — homebrew
  is expert-only.
- **Raised by:** P09-003, P09-005
- **RULING (owner only):** **C — both.**
- **Applied:** `HOMEBREW_REQUIRED` lists the columns each table's rows genuinely
  need, in one place rather than as a flag on 195 fields. Saving a row that
  leaves any of them blank asks for confirmation and says what it will read as;
  the row list marks incomplete rows in amber. Nothing blocks — the free-form
  data model is deliberate and a placeholder row is a reasonable thing to want —
  only the name is genuinely required, as before. A **"Not merged — name already
  taken"** card lists every `HB_COLLISIONS` entry across all packs, with the
  table and the pack it came from, and explains the precedence rule. That card is
  the fix for the more confusing of the two failure modes: content that simply
  never appears.

## JC-023: Spirit prose has unescapable characters
- **Status:** RESOLVED
- **Where:** `static/app.js` `splitSpiritEntries` / `parseSpiritServices`
- **Observed:** Entries split on a bare `|` with no escape, so a pipe can never
  appear in spirit prose. A colon within the first 40 characters is treated as a
  service label, so `"Meet at 10:00 sharp"` renders as a service named
  `"Meet at 10"` with body `"00 sharp"`. The shipped data trips neither today
  (P10-006, P10-009 both return empty).
- **Question:** Should the parsers be hardened, or the constraint documented?
- **Options:** A) Document the two forbidden shapes in `docs/DATA.md` and leave
  the parsers alone. B) Add escaping. C) Add a `check_data.py` rule that fails on
  either shape.
- **Raised by:** P10-002, P10-004
- **RULING (owner only):** **B — add escaping.** Document it in `data.md`.
- **Applied:** A backslash escapes either delimiter: `\|` is a literal pipe, `\:`
  a colon that is not a label separator, `\\` a literal backslash. Splitting
  happens on the raw text and escapes are resolved afterwards, so a delimiter can
  never survive into a rendered entry. `splitSpiritEntriesRaw` does the split,
  `firstUnescapedIndex` finds the label colon, `unescapeSpiritText` resolves.
  Documented under `speaker_spirits` in `docs/DATA.md`. Verified safe against the
  shipped data first: **no cell anywhere in `data.js` contains a backslash**, and
  every shipped spirit still parses to the same services.

---

# Round two

Raised while implementing the rulings above, and ruled on in the same round.

## JC-024: Decks, programs, rigs, drones and vehicles bought in play still land in the chargen arrays
- **Status:** RESOLVED
- **Where:** `static/sheet.js` — `shDecking` (deck and program buys), `shRigging`
  (rig, drone and vehicle buys)
- **Observed:** JC-010 moved play purchases of weapons and armor into
  `play.purchases`, joining gear, augments, spells, amp powers and hacking
  levels. Five categories were left behind: buying a deck in play pushes onto
  `CHAR.decks`, a program onto `CHAR.programs`, and rigs/drones/vehicles onto
  their chargen arrays. So the exact behaviour JC-010 described — Back to Chargen
  charging a play purchase against the creation budget, and
  `revertToChargenEnd()` not removing it — is still live for those five.
- **Question:** Should these five follow weapons and armor into
  `play.purchases`?
- **Options:** A) Yes — finish the job, so `play.purchases` holds everything
  bought after Finalize. B) No, and say why these five differ. C) Yes for
  decks/programs (personal kit) but not rigs/drones/vehicles (assets, arguably
  the group's).
- **Raised by:** noticed while applying JC-010
- **RULING (owner only):** **A — finish the job.** There is a hard and fast line
  between a character in the chargen process and anything that happens after
  Finalize is pressed; nothing bought in play lands in a chargen array.
- **Applied:** `play.purchases` gained `decks`, `programs`, `rigs`, `drones` and
  `vehicles`, and `applyPlayAdvances` appends all five. That is now the complete
  set — every purchasable category has a home there, and the comment on
  `defaultCharacter().play.purchases` says to add to it when a new one appears.

  The Decking and Rigging tabs read the joined list through `ownedDecks()`,
  `ownedRigs()`, `ownedDrones()`, `ownedVehicles()` and `ownedPrograms()`, each
  tagging entries with the array they live in so removal hits the right one. Two
  things needed care beyond the pattern JC-010 established:

  - **`unitStateKey`** keys a drone's or vehicle's damage tracks and link flag
    by list position. It now indexes the *joined* list, which is also the order
    CALC uses. Purchases append, so a chargen unit's key never moves and
    existing saves keep their state.
  - **Active deck / active rig** key on name rather than index, so they needed
    no change — but the fallback that picks the first owned one now walks the
    joined list, so a character whose only deck was bought in play still has an
    active one.

  Undo covers all five, plus deck mods and rig mods.

## JC-025: No host in the shipped data can mount a Smartlink
- **Status:** RESOLVED — no change
- **Where:** `static/data.js` `augments` (Smartlink is `Type: "Headware"`);
  `armor` / `misc_gear` `Mount Types`
- **Observed:** JC-009's ruling describes a Smartlink "installed as an augment
  attached to a Helmet or Arwin Goggles", active only while that host is
  equipped. But Smartlink's Type in the data is **Headware**, not Eyeware. Arwin
  Goggles accept `Eyeware` only, and issue #28 specifies the Helmet as accepting
  Eyeware, Earware and exactly two Headware items — Commlink and Subvocal Mic.
  So neither host will mount a Smartlink, and JC-009's case (3) is currently
  unreachable. Power Armor (`Mount Types: Any`) is the only host that takes one.
- **Question:** Which is right — the Type, or the mount lists?
- **Options:** A) Add `Smartlink` to the Helmet's and Arwin Goggles' mount lists
  (one token each; the grammar already takes augment names). B) Re-type
  Smartlink as Eyeware, which makes both hosts accept it via their category and
  also subjects it to the one-Eyeware-augment-without-Cybertechtronic-Eyes rule.
  C) JC-009 case (3) was hypothetical — leave the data alone and note that only
  Power Armor mounts one.
- **Raised by:** noticed while applying issue #28 alongside JC-009
- **RULING (owner only):** **C — leave the data alone.** A Smartlink is not
  available to helmets or Arwin Goggles, so JC-009's case (3) is simply
  unreachable.
- **Applied:** Nothing. The engine side of JC-009 stands and is correct: a
  mounted Smartlink would follow its host if one could ever hold it, and today
  only Power Armor (`Mount Types: Any`) can. P02-008 covers the implanted half
  and says the mounted half isn't testable against the shipped data.
- **If this is ever revisited:** adding `Smartlink` to a host's mount list is a
  one-cell data edit — the grammar already takes augment names — plus a
  `CACHE_VERSION` bump. Re-typing Smartlink as Eyeware would be the bigger
  change: it would start counting toward "More than 1 Eyeware augment requires
  Cybertechtronic Eyes" on every existing character, so it needs a P02 re-run.

## JC-026: A known spell grants its Skill Bonus / Skill Note unconditionally
- **Status:** OPEN
- **Where:** `gearSkillEffects` (`static/rules.js:3944`,
  `rowsOf((character.magic || {}).spells, "spells", "Name")`)
- **Observed:** `gearSkillEffects` gates every other source on being currently
  *active* — armor worn, a weapon equipped, gear carried, a spirit infused or
  bonded rather than merely known — and says so in its own doc comment. Spells
  are the one exception: knowing a spell is enough, with no notion of it being
  cast, maintained, or otherwise "on". Not live today — no row in the `spells`
  table has `Skill Bonus` or `Skill Note` populated, so this read is currently a
  no-op for every character. `Bound Servant` is the row that surfaced the
  question: its prose (`+2d to all tests` for the familiar, `+2d
  Sorcery/Channeling` for the caster) was deliberately left as text rather than
  migrated into those columns, specifically because migrating it would make the
  bonus permanent from the moment the spell is learned rather than only while a
  familiar is actually bound. The gate is missing, not misused — nobody has hit
  it yet because nobody has populated the columns it would misread.
- **Question:** Should a known spell's Skill Bonus / Skill Note apply always,
  or only while the spell is somehow "in effect"?
- **Options:** A) Always, as today — a spell known is a spell mastered, and
  `Bound Servant`'s permanent familiar (a 2 ZP spell bought specifically for a
  standing effect) is the argument this is sometimes exactly right. B) Never
  unconditionally — gate spells the same way spirits are gated, which raises
  a harder question with no existing precedent: what "active" means for a
  spell with no duration field to check against (an instant like Confusion vs.
  a bind like Bound Servant aren't the same shape). C) Per-row, via a new flag
  (`Standing: 1`, following `RaisesMax`/`Dose`'s pattern) — the minimal change,
  but every spell with a Skill Bonus/Skill Note needs a considered value, not
  a default.
- **Raised by:** the effect-text-review pass (`docs/effect-text-review/`,
  now deleted) while adding `Skill Bonus`/`Skill Note` prose-vs-column checks
  across every table; recorded here so the question survives the bundle.
- **RULING (owner only):** _
- **Follow-up on ruling:** If A, no code changes — just note the design intent
  somewhere `gearSkillEffects`'s doc comment can point to. If B or C, every
  spell currently carrying a Skill Bonus or Skill Note needs to be re-audited
  against whatever "active" ends up meaning, which is a P02/P04 re-run.

## JC-027: Hotseat counted as deployment in the engine and as a modifier in the UI
- **Status:** RESOLVED
- **Where:** `deployedUnitKeys` / `droneSkillDice` / `droneCombatBonuses`
  (`static/rules.js`), `deployedUnits` / `shHotseatToggle` (`static/sheet.js`)
- **Observed:** The engine treated `character.play.rigging.hotseat[key]` as a
  third, independent way of being deployed, alongside `linked` and `active`,
  with no check that the character owns a VCR. The sheet said the opposite in
  three places: the Hotseat toggle is only rendered inside the on-station list
  (so a unit must already be linked or Active to have one), it is disabled with
  the title "No VCR owned — nothing to jack into" when `hasVcrRig()` is false,
  and since v337 `deployedUnits()` truncates seats past the active rig's cores.
  So a bare `hotseat` flag with `active_rig: ""` handed the character a deployed
  drone's passive rider — a Bug-Spy's +1d Observation and +2d Initiative — in a
  state the UI will not let you reach and does not display. Reachable through an
  imported or hand-edited save, and through a save written before the seat cap
  existed.
- **Question:** Is a hotseat flag deployment on its own, or a modifier on a unit
  that is already out there?
- **Options:** A) A modifier — the engine drops `hotseat` from its deployment
  set and counts linked-or-Active, matching the sheet. B) Deployment, but gated
  on owning a rig — fixes the no-VCR case only, and still disagrees with the
  sheet about a seat truncated by a VCR downgrade and about a seated unit that
  is neither linked nor Active. C) Deployment as today, and the sheet is what
  changes — hotseat becomes tickable off-station.
- **Raised by:** P02-025, against P06-066's note that `deployedUnits()`, not the
  raw `rigging.hotseat` map, is the authority on who is seated.
- **RULING (owner only):** A. Hotseating means jacking in, and that takes a rig;
  the seat says which deployed unit you are flying, not whether it is out there.
- **Applied (v338):** Both engine functions now take their deployment set from
  one shared `RULES.deployedUnitKeys(character)` — linked ∪ active, hotseat not
  consulted — and `deployedUnits()` reads the same helper for its on-station
  test, so the two cannot drift. Nothing reachable through the UI changes: a
  hotseated unit is linked or Active by construction, and still grants its
  rider. P02-025 gained a `seatedNoRig` arm (was `obs: 1`, now `obs: null`) and
  an `init` read-out, so the skill-dice and Initiative halves that disagreed in
  #38 are now asserted together.
