#!/usr/bin/env node
// tools/ui-icons-build.js — writes static/icons.js, the interface's icons, from the game-icons.net drawings kept in
// tools/icon-src/ (CC BY 3.0, credited in the README and in Settings) plus a few plain shapes drawn here.
// The same arrangement as GM's Almanac, which keeps the whole game-icons set; this app keeps only what it uses.
//
//   node tools/ui-icons-build.js
//
// Each icon has a name, the file it comes from (artist/name under tools/icon-src) or a shape of our own, a label for
// screen readers, and the characters it stands in for. The app's code still writes those characters in its labels
// ("🛒 Buy equipment", "⚄ Dodge"): el() in static/app.js swaps each one for its icon as it builds the page, so every
// device shows the same drawing in the text's colour. To add one: copy its SVG from game-icons.net into
// tools/icon-src/<artist>/, add a row below and run this again. Text the app writes for other programs (the Markdown
// export) never goes through el() and keeps its characters.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(__dirname, 'icon-src');

// Plain shapes of our own, on the same 512 grid as game-icons.
const OWN = {
  menu: 'M64 112h384v48H64zm0 120h384v48H64zm0 120h384v48H64z',
};

// [name, source (artist/name in tools/icon-src, or a name in OWN), label, the characters it replaces...]
const ICONS = [
  ['menu', 'menu', 'Menu', '☰'],
  ['dice', 'delapouite/rolling-dices', 'Roll', '🎲', '⚄'],
  ['moon', 'lorc/moon', 'Dark mode', '🌙'],
  ['sun', 'lorc/sun', 'Light mode', '☀'],
  ['cog', 'lorc/cog', 'Settings', '⚙'],
  ['person', 'delapouite/person', 'Account', '👤', '🧍'],
  ['globe', 'lorc/world', 'Public', '🌐'],
  ['lock', 'lorc/padlock', 'Private', '🔒'],
  ['eye', 'lorc/semi-closed-eye', 'Viewing', '👁'],
  ['run', 'lorc/run', 'Movement', '🏃'],
  ['shield', 'sbed/shield', 'Armor', '🛡'],
  ['network', 'delapouite/mesh-network', 'Deck', '🖧'],
  ['pill', 'lorc/pill', 'Dose', '💊'],
  ['sparkles', 'delapouite/sparkles', 'Magic', '✨', '✦'],
  ['paw', 'lorc/paw-print', 'Shifted', '🐾'],
  ['swords', 'lorc/crossed-swords', 'Attack', '⚔'],
  ['cart', 'delapouite/shopping-cart', 'Buy', '🛒'],
  ['wolf', 'lorc/wolf-head', 'Beast form', '🐺'],
  ['power', 'lorc/power-lightning', 'Running', '⚡'],
  ['warning', 'lorc/hazard-sign', 'Warning', '⚠'],
  ['refresh', 'delapouite/clockwise-rotation', 'Refresh', '↻'],
  ['reset', 'delapouite/anticlockwise-rotation', 'Reset', '↺'],
  ['book', 'lorc/open-book', 'Needs training', '📖'],
];

function source(src) {
  if (OWN[src]) return `<path d="${OWN[src]}"/>`;
  const file = path.join(SRC, `${src}.svg`);
  if (!fs.existsSync(file)) throw new Error(`No file tools/icon-src/${src}.svg`);
  const svg = fs.readFileSync(file, 'utf8');
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/\s+fill="currentColor"/g, '');
  if (/<script|on\w+=/i.test(inner)) throw new Error(`${src} has script in it`);
  return inner.trim();
}

const shapes = {}, labels = {}, emoji = {}, credit = {};
for (const [name, src, label, ...chars] of ICONS) {
  if (shapes[name]) throw new Error(`Two icons named ${name}`);
  shapes[name] = source(src);
  labels[name] = label;
  if (!OWN[src]) credit[name] = src.split('/')[0];
  for (const ch of chars) {
    const bare = ch.replace(/️/g, '');
    if (emoji[bare]) throw new Error(`${ch} is already ${emoji[bare]}`);
    emoji[bare] = name;
  }
}

const out = `// static/icons.js — the interface's icons. Written by tools/ui-icons-build.js: change that and run it, not this.
// Drawn from game-icons.net (CC BY 3.0, the artist of each is in ICON_ARTISTS; credited in the README and in
// Settings), plus a few plain shapes of our own. Each is a 512 x 512 shape filled with currentColor.
/* eslint-disable */
const ICON_SHAPES = ${JSON.stringify(shapes, null, 0).replace(/","/g, '",\n"')};
const ICON_LABELS = ${JSON.stringify(labels)};
const ICON_ARTISTS = ${JSON.stringify(credit)};
/** The characters the app's labels are written with, and the icon each one is drawn as (el() in app.js, kit.js). */
const ICON_FOR_EMOJI = ${JSON.stringify(emoji)};
`;
fs.writeFileSync(path.join(ROOT, 'static', 'icons.js'), out);
console.log(`static/icons.js: ${Object.keys(shapes).length} icons for ${Object.keys(emoji).length} characters`);
