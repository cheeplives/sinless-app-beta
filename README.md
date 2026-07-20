# Sinless Character Dossier

A fully offline, client-side web app for building and running characters for
the **Sinless** tabletop RPG — a cyberpunk game of chrome, Zoetics, and street
grit. It covers full character generation and an interactive play-mode sheet
for use at the table, installable as a PWA so it works with no connection.

No build step, no framework, no backend, no accounts. It's static files plus a
service worker for offline use — open it and play.

> This repository is the canonical source of truth for the app and its rules.
> An older Python/Flask version once served the same logic over HTTP; it is
> now out of date and is **not** the reference. Change behavior here.

## Features

**Character creation** walks through the full build, tab by tab:
Priorities · Heritage · Stats & Skills · Knowledge & Etiquette · Magic &
Rituals · Speaker · Augments · Weapons & Armor · Decks & Programs · Drones &
Vehicles · Gear & Costs. A live sidebar tracks pools, condition, every point
budget, and Zoetic stats (ZP, ZR, Body Index) as you spend, with errors and
warnings surfaced immediately — so the sheet is self-checking, not just a form.

**Play mode** takes over once a character is finalized:
- Kismet-based advancement (raise attributes/skills, learn new skills, buy
  gear/augments/spells/Amp powers during play) — all priced per the same rules
  engine used at chargen, so nothing is hand-waved.
- Condition tracks with cumulative wound penalties, initiative, combat stats,
  and everything else needed to run a scene without leaving the sheet.
- Auto-saves (debounced) to `localStorage` as you play — no explicit save step.

**Homebrew editor** lets anyone add or tweak custom Augments, Weapons, Armor,
Gear, Vehicles, Drones, Spells, Rituals, and their mods/sub-items, right in the
app. Custom content merges live into every picker and calculation alongside
the base tables. Export/import a homebrew "pack" (JSON) to share content, and
see [Promoting homebrew into the base data](#promoting-homebrew-into-the-base-data)
for how the app owner can fold a pack into the shipped base rules.

**Offline-first**: installable as a PWA (manifest + service worker); once
loaded, it keeps working with no network. Everything — characters, homebrew,
theme — lives in the browser's `localStorage`; nothing is ever sent anywhere.

## Running it

It's a static site — serve the repo root over HTTP (the service worker needs a
real origin, so opening `index.html` from `file://` won't fully work):

```sh
python -m http.server 8753
# then open http://localhost:8753
```

Any static file server works. The bundled `.claude/launch.json` uses the
command above. To install it as an app, open it in a browser and use
"Install" / "Add to Home Screen" — the manifest and icons are already wired up.

## Architecture

`index.html` loads six scripts, in order:

| File | Role |
|------|------|
| `static/data.js` | All game data tables + rule constants, as the `DATA_BUNDLE` global. **Canonical, hand-maintained** (see below). |
| `static/rules.js` | The rules engine (`RULES`). Pure functions: character in, derived sheet out. The source of truth for all calculations. |
| `static/storage.js` | Character + homebrew persistence (`STORAGE`) via `localStorage`. |
| `static/homebrew.js` | The homebrew editor screen and the merge that splices custom rows into `DATA_BUNDLE.tables` at boot and after every edit. |
| `static/app.js` | Chargen UI. Builds the DOM directly via the `el()` helper (no innerHTML), mutates the in-memory `CHAR`, and re-derives `CALC` on each edit. |
| `static/sheet.js` | Interactive play-mode sheet, shown after a character is finalized. |

`sw.js` is the service worker: network-first for app code (freshest deploy wins
online), cache-first for immutable assets (fonts/icons). Bump `CACHE_VERSION`
in `sw.js` to force-drop old caches on deploy.

### Data flow

An input handler mutates `CHAR` → `scheduleRecalc()`/`refresh()` →
`RULES.calculate(CHAR)` returns `CALC` → the rail and active tab re-render from
`DATA`/`CHAR`/`CALC`. `CALC` is read-only and replaced wholesale each recalc.

### Project layout

```
index.html          entry point: markup shell + script load order
manifest.json        PWA metadata (name, icons, theme colors)
sw.js                 service worker: offline caching
icons/                PWA icons
static/
  data.js             game data tables + rule constants (DATA_BUNDLE)
  rules.js            rules engine (RULES) — all calculations
  storage.js          localStorage persistence for characters + homebrew
  homebrew.js         homebrew editor UI + merge into DATA_BUNDLE
  app.js              chargen UI (tabs, sidebar rail, boot())
  sheet.js            play-mode UI (Kismet advancement, combat, etc.)
  style.css / fonts.css / fonts/    styling and type
tools/
  promote_homebrew.py  owner CLI: fold a homebrew pack into static/data.js
```

## Editing game data

`static/data.js` is one large JSON literal, formatted **one table row per
line** (each row itself stays compact) so git can diff and merge data changes
instead of conflicting on a single giant line. It was originally generated
from a spreadsheet by a Python step, but that pipeline is out of date — the
tables here are now maintained by hand. To change a stat, feature, or price,
edit the relevant row's line directly in `static/data.js`; add new rows as new
lines in the same table array. Keep the header comment ASCII-only, preserve
the row-per-line layout, and confirm the file still parses (it's plain JSON
after the `const DATA_BUNDLE =` prefix). The homebrew promoter re-emits this
exact format, so promotions keep the layout stable.

### Promoting homebrew into the base data

Anyone can create custom "homebrew" content in-app (Augments, Weapons, Gear,
etc.); it lives only in their browser. To fold that content into the base
package for everyone, the owner can promote an exported pack instead of hand-
editing `data.js`:

1. In the app, open the Homebrew screen and click **Export Pack** to download a
   `sinless-homebrew-pack.json` (from your own browser, or one a user sent you).
2. Run the promoter:

   ```
   python tools/promote_homebrew.py sinless-homebrew-pack.json --dry-run   # preview
   python tools/promote_homebrew.py sinless-homebrew-pack.json             # apply
   ```

   By default a promoted row whose name matches an existing base row *replaces*
   its stats (upsert); new names are appended. The `Custom` marker is stripped
   so promoted rows become permanent base rows. Flags: `--skip` (leave existing
   base rows untouched, only add new items), `--no-cache-bump`, `--dry-run`.
3. The script rewrites `static/data.js` and bumps `CACHE_VERSION` in `sw.js`.
   Review the diff, commit both files, and deploy.

Note: if you promote your *own* homebrew, that item still exists in your
browser's local homebrew afterward — delete it from the Homebrew screen so you
don't see both the base copy and your custom copy.

## Notes

- Entirely client-side: no accounts, no network calls, no secrets. Characters
  live in your browser's `localStorage`; use **Export JSON** to back one up.
- `rules.js` and `data.js` also load under Node (`require("./data.js")`), which
  is handy for scripting or testing the engine in isolation.
- No test suite is committed today; verify changes by running the app in a
  browser and exercising the affected flow end-to-end.

## House Rules
-Minimum Alpha Cyber ZR Reduction of 0.1
-Minimum Alpha Cyber Cost of 1000
-Zuzus-> Woolongs
-1/2 Cost to Cyberlimbs
-Collapse Engnineering Skills to one Skill
-Remove Computer (Electronic Warfare) Skill
-Priorites are rated from 4 to 0 instead of A to E. Players have 10 points to spend and can buy things of the same Prority.
