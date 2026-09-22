# P07 — Workspace tabs and cross-character leaks

**Preconditions for every case:** P00 complete.
**Effort:** 45 min. **Fixture:** none — cases build their own characters.

Each workspace tab holds its own character object, and only the active one is
aliased by the global `CHAR`. That isolation is real for character *data*. It is
not real for three pieces of module-level state that `calculate()` writes on
every run:

- the global `SKILLS` map (and `BUNDLE.skills`, exposed as `DATA.skills`),
  reshaped by `syncEngineeringSkills()` and `syncEWSkill()`
- `activeHouseRules`, the pointer `RULES.houseRule()` reads
- `playSaveTimer`, a single debounced save timer

All three answer for **whichever character recalculated last**, regardless of
which tab you are looking at. These cases demonstrate that without needing two
real tabs — calculating a character is enough to move the global state.

None of these is a crash. Whether they matter depends on whether two characters
with different house rules are ever open at once, which is exactly the judgement
the owner needs to make.

---

### P07-001: The engineering house rule reshapes the global skill list
- **Type:** leak
- **Check:**

      (() => { const mk = rule => { const c = RULES.defaultCharacter(); c.house_rules.engineering = rule; c.priorities={heritage:0,magic:1,attributes:2,skills:3,resources:4}; c.heritage.type="Human"; c.lifestyles=[{name:"Squatter",months:1}]; return c; }; const eng = () => Object.keys(DATA.skills).filter(s => /Engineering/i.test(s)).sort(); RULES.calculate(mk("classic")); const afterClassic = eng(); RULES.calculate(mk("single")); const afterSingle = eng(); RULES.calculate(mk("classic")); return { afterClassic: afterClassic.length, afterSingle, backToClassic: eng().length }; })()

- **Expected:**

      { "afterClassic": 6, "afterSingle": ["Engineering"], "backToClassic": 6 }

- **Note:** Calculating a `single`-rule character collapsed the six Engineering
  skills to one **in the global map**, and calculating a `classic` one restored
  them. Any render that reads `DATA.skills` between those two points sees the
  other character's shape.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P07-002: The EW house rule adds and removes a skill globally
- **Type:** leak
- **Check:**

      (() => { const mk = rule => { const c = RULES.defaultCharacter(); c.house_rules.ew = rule; c.priorities={heritage:0,magic:1,attributes:2,skills:3,resources:4}; c.heritage.type="Human"; c.lifestyles=[{name:"Squatter",months:1}]; return c; }; const has = () => "Computer: Electronic Warfare" in DATA.skills; RULES.calculate(mk("classic")); const a = has(); RULES.calculate(mk("houserule")); const b = has(); return { afterClassic: a, afterHouserule: b }; })()

- **Expected:** `{ "afterClassic": true, "afterHouserule": false }`
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P07-003: houseRule() answers for the last character calculated
- **Type:** leak
- **Check:**

      (() => { const mk = zr => { const c = RULES.defaultCharacter(); c.house_rules.zr = zr; c.priorities={heritage:0,magic:1,attributes:2,skills:3,resources:4}; c.heritage.type="Human"; c.lifestyles=[{name:"Squatter",months:1}]; return c; }; RULES.calculate(mk("classic")); const a = RULES.houseRule("zr"); RULES.calculate(mk("houserule")); const b = RULES.houseRule("zr"); return { afterClassic: a, afterHouserule: b }; })()

- **Expected:** `{ "afterClassic": "classic", "afterHouserule": "houserule" }`
- **Note:** `RULES.currencyName()` reads the same pointer, so a currency label
  can be rendered from the wrong character's rules for the same reason.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## With two real tabs

These cases use the workspace properly. Create the two characters first:

```js
(async () => { const mk = (name, eng) => { const c = RULES.defaultCharacter(); c.name = name; c.house_rules.engineering = eng; c.priorities={heritage:0,magic:1,attributes:2,skills:3,resources:4}; c.heritage.type="Human"; c.lifestyles=[{name:"Squatter",months:1}]; return c; }; await openCharacter(mk("QA Tab Classic", "classic")); await openCharacter(mk("QA Tab Single", "single")); return { tabs: WORKSPACE.tabs.map(t => t.char.name).slice(-2), active: CHAR.name }; })()
```

**Expected:** `{ "tabs": ["QA Tab Classic", "QA Tab Single"], "active": "QA Tab Single" }`

### P07-004: Switching tabs restores the correct skill shape
- **Type:** leak
- **Steps:**
  1. Click the workspace tab labelled **QA Tab Classic**.
- **Check:**

      (() => ({ active: CHAR.name, rule: CHAR.house_rules.engineering, globalEngineering: Object.keys(DATA.skills).filter(s => /Engineering/i.test(s)).length }))()

- **Expected:** `{ "active": "QA Tab Classic", "rule": "classic", "globalEngineering": 6 }`
- **Note:** `switchTab` recalculates, so by the time you can read the DOM the
  global map is correct. A mismatch here means the recalculation on switch has
  broken — that is a real FAIL, not a JUDGEMENT.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P07-005: Character data itself does not bleed between tabs
- **Type:** correctness
- **Steps:**
  1. With **QA Tab Classic** active, run the Check.
- **Check:**

      (async () => { CHAR.skills = { Athletics: 4 }; await recalc(); const mine = JSON.parse(JSON.stringify(CHAR.skills)); const other = WORKSPACE.tabs.find(t => t.char.name === "QA Tab Single").char.skills; return { mine, other }; })()

- **Expected:** `{ "mine": { "Athletics": 4 }, "other": {} }`
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P07-006: A pending debounced save fires against whichever character is active
- **Type:** leak
- **Steps:**
  1. Switch to **QA Tab Single**.
  2. Enter play mode (P00 §5) so autosave is active.
  3. Make a change, then switch tabs immediately — within the 600 ms debounce.
- **Check:**

      (() => ({ savedNames: Object.keys(localStorage).filter(k => k.startsWith("sinless:char:QA-Tab")).sort(), timerPending: typeof playSaveTimer !== "undefined" && playSaveTimer !== null }))()

- **Expected:** both `QA-Tab-Classic` and `QA-Tab-Single` keys exist and neither
  character's saved content belongs to the other.
- **Note:** `playSaveTimer` is a single module-level timer whose callback reads
  the **global** `CHAR` rather than a captured reference. This case is timing
  dependent and may not reproduce every run — if you cannot make it happen, mark
  **BLOCKED** and say so rather than PASS. Verify content with:

      (() => { const g = n => JSON.parse(localStorage.getItem("sinless:char:" + n) || "null"); return { classic: (g("QA-Tab-Classic")||{}).name, single: (g("QA-Tab-Single")||{}).name }; })()

- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P07-007: Two names that sanitise identically share one storage slot
- **Type:** leak
- **Check:**

      (() => ({ a: STORAGE.sanitizeName("Ada Lovelace"), b: STORAGE.sanitizeName("Ada-Lovelace"), same: STORAGE.sanitizeName("Ada Lovelace") === STORAGE.sanitizeName("Ada-Lovelace") }))()

- **Expected:** `{ "a": "Ada-Lovelace", "b": "Ada-Lovelace", "same": true }`
- **Note:** `openCharacter` de-duplicates on load, and since JC-014 both Finalize
  and the sheet's Save ask before replacing whoever holds the slot — see
  P05-010. Two names still share one slot, which is what this case records; what
  changed is that landing in an occupied one is no longer silent.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P07-008: The tab dot tracks unsaved and unpushed state
- **Type:** correctness
- **Note:** `sweepDirtyFlags` runs on an 800 ms trailing timer, so this calls the
  predicates directly rather than racing it. The SYNC stubs are restored in
  `finally`.
- **Check:**

      (() => { const save = { enabled: SYNC.enabled, isPublic: SYNC.isPublic, pendingSync: SYNC.pendingSync }; try { STORAGE.saveCharacter({ name: "QA Dot", attributes: {} }); const clean = STORAGE.loadCharacter("QA Dot"); const dirty = STORAGE.loadCharacter("QA Dot"); dirty.attributes.Body = 99; const t = c => ({ char: c, view: {} }); SYNC.enabled = () => true; SYNC.pendingSync = s => s === "QA-Dot"; return { clean: computeTabDirty(t(clean)), edited: computeTabDirty(t(dirty)), neverSaved: computeTabDirty(t({ name: "QA Ghost", attributes: {} })), readonly: computeTabDirty(Object.assign(t(dirty), { readonly: true })), pending: computeTabPendingSync(t(clean)) }; } finally { Object.assign(SYNC, save); } })()

- **Expected:**

      { "clean": false, "edited": true, "neverSaved": true,
        "readonly": false, "pending": true }

- **Note:** `clean: true` would mean the dot is red on a character that is
  saved — the false alarm that makes the indicator worthless. `edited: false`
  is the more serious direction: a green dot over changes that are not in the
  slot. A read-only shared view is never saved at all, so it is never dirty.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P07-009: The close warning fires only on what a close would actually cost
- **Type:** correctness
- **Note:** `beforeunload` saves every named tab on the way out, so a named
  private character is never at risk and must not warn. This drives
  `unloadRisks()` directly — the same function the handler calls — because
  `beforeunload` itself cannot be triggered from the console.
- **Check:**

      (() => { const save = { enabled: SYNC.enabled, isPublic: SYNC.isPublic, pendingSync: SYNC.pendingSync }; const tabs = WORKSPACE.tabs; try { STORAGE.saveCharacter({ name: "QA Risk", attributes: {} }); const clean = STORAGE.loadCharacter("QA Risk"); const dirty = STORAGE.loadCharacter("QA Risk"); dirty.attributes.Body = 99; const t = c => ({ char: c, view: {} }); const n = (ts, pub, q) => { WORKSPACE.tabs = ts; SYNC.enabled = () => true; SYNC.isPublic = s => pub && s === "QA-Risk"; SYNC.pendingSync = s => q && s === "QA-Risk"; return unloadRisks().length; }; const fresh = RULES.defaultCharacter(); const worked = RULES.defaultCharacter(); worked.attributes[Object.keys(worked.attributes)[0]] += 2; return { privateDirty: n([t(dirty)], false, false), sharedClean: n([t(clean)], true, false), sharedDirty: n([t(dirty)], true, false), sharedQueued: n([t(clean)], true, true), freshUnnamed: n([t(fresh)], false, false), unnamedWithWork: n([t(worked)], false, false) }; } finally { Object.assign(SYNC, save); WORKSPACE.tabs = tabs; } })()

- **Expected:**

      { "privateDirty": 0, "sharedClean": 0, "sharedDirty": 1,
        "sharedQueued": 1, "freshUnnamed": 0, "unnamedWithWork": 1 }

- **Note:** `privateDirty: 1` is a **FAIL** — it is the cry-wolf case, warning
  about edits the unload handler is about to save anyway. `sharedDirty: 0` is
  the opposite failure: closing there strands a push and leaves the gallery
  serving the old version to other members.

  `freshUnnamed: 0` matters because `newCharacterTab` asks for house rules
  before the character opens; a non-default pick must not count as work (see
  `unnamedDraftHasWork`), or every untouched tab warns on close.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Clean up

Remove the indicator cases' saves:

```js
["QA-Dot", "QA-Risk"].forEach(k => localStorage.removeItem((typeof SYNC !== "undefined" ? SYNC.userPrefix() : "sinless:") + "char:" + k))
```

Close the two tabs and remove their saves:

```js
(async () => { for (const n of ["QA Tab Classic", "QA Tab Single"]) await closeTabByName(n); ["QA-Tab-Classic","QA-Tab-Single"].forEach(k => localStorage.removeItem("sinless:char:" + k)); return WORKSPACE.tabs.length; })()
```

## Wrapping up

**P07-001, P07-002, P07-003 and P07-007 are JUDGEMENT** — they document real
shared state, but whether it causes harm depends on usage the owner has to
decide about. P07-004 and P07-005 should PASS; a failure there means isolation
is actually broken rather than merely shared.

P07-006 is expected to be hard to reproduce. BLOCKED is an honest result.
