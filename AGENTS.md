# Working on Sinless

Plain JavaScript, no build step, no framework. `README.md` covers the layout,
the data file and how to run it. `tests/README.md` covers the browser tests.
This file is about how the app looks, because that is the part that drifts.

## How the app looks

The look is called Chrome: near-black or near-white surfaces, one pale steel
accent, hairline edges, and colour kept for things that mean something. The
same rules as GM's Almanac, which shares `static/kit.js` with this app.

Before adding any interface, read the top of `static/style.css`. Then keep to
these.

**Colour.** Use the tokens (`--ink`, `--panel`, `--panel-2`, `--line`,
`--text`, `--dim`, `--manon`, `--ok`, `--amber`, `--bad`, `--roll`). No hex
values or `rgba()` in a rule; mix from a token with `color-mix()` when a tint
is needed. `--manon` is the one accent, and the player can change it in
Settings, so nothing may depend on it being a particular hue. Pool and
attribute colours (`--pool-*`, `--attr-*`) identify a pool. They appear as a
thin top rule and a label, never as a filled or outlined box.

**Surfaces.** Flat. No gradients, no glow, no gradient text, no lift on hover.
A shadow is allowed only on something that floats over the page: a menu, a
dialog, a popover, the round roller button.

**Edges.** A border has to mean something. Group related figures in one box
divided by hairlines instead of giving each its own box. No thick stripe down
the left side of a card or notice; a notice gets a full tinted edge
(`.alert`, `.sh-callout`).

**Type.** Sizes are 12, 13, 14, 16, 18, 24 and 32px. Nothing smaller than 12.
No uppercase transforms and no letter-spacing, except the wordmark. Sentence
case for every heading, tab, button and label ("Adjust money manually"). Game
terms keep their capitals (Kismet, Zoetic, Amp).

**Shape.** One corner radius, `var(--radius)`. Circles are for things that are
round (the roller button, a radio dot).

**Buttons.** Use the kinds that exist: `.btn` (outlined), `.btn-add` (outlined
with the accent edge, for add, buy and apply), `.primary` (filled accent),
`.btn.roll`, `.btn.good`, `.btn.warn`, and the red delete. Two sizes: regular
and `.small`. A screen has at most one `.primary`, and never two side by side.

**Icons.** No emoji as icons. Icons are drawn, in `static/icons.js`, built by
`tools/ui-icons-build.js` from game-icons.net drawings (CC BY 3.0, credited in
the README and in Settings). Code still writes the character in the label
(`"🛒 Buy equipment"`), and `el()` in `static/app.js` swaps it for the drawing.
A character with no row in the build script stays a character on screen, so
add the row. Text written for other programs (the Markdown export) does not go
through `el()` and keeps its characters.

**Words.** Say what the thing does, briefly. No em dashes in new interface
text; use a full stop, a comma or a colon. Older strings still have them, and
some are read back by the Markdown import, so check `static/md-import.js` and
the tests before changing one.

**Contrast.** Text meets WCAG AA in both modes and every accent.
`tests/browser/accessibility.spec.js` checks it; a new colour pairing that
fails there needs a different token, not an exception.

**Screens.** Desktop and iPad come first. A phone has to be usable: no
sideways page scroll, wide tables scroll inside their own box, and the
problems list becomes a bar at the bottom.

## Before you finish

- Bump `CACHE_VERSION` in `sw.js` and `APP_VERSION` in `static/rules.js`
  together when shipped files change. A new file under `static/` also goes in
  the `PRECACHE` list.
- After touching `static/data.js`, run `python tools/check_data.py`.
- Run the browser tests: `cd tests && npx playwright test --project=chromium`.
