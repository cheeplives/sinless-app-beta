#!/usr/bin/env python3
"""Consistency checks for the Sinless game-data bundle (static/data.js).

Run this after hand-editing static/data.js, HOMEBREW_CONFIG in static/homebrew.js,
or NAME_KEYS in tools/promote_homebrew.py:

    python tools/check_data.py
    python tools/check_data.py --strict      # warnings fail too

What it checks:

  1. data.js still parses as one JSON literal (the same head/bundle/tail split
     promote_homebrew.py uses, so a pass here means the promoter can run).
  2. Key-column agreement across the three places that hardcode it --
     HOMEBREW_CONFIG (static/homebrew.js), NAME_KEYS (tools/promote_homebrew.py),
     and the findRow(data.X, "Col") literals in static/rules.js -- plus data.js
     itself. Nothing else keeps these in sync; this check is that "something".
  3. Row identity: every key column present, non-empty, and unique
     case-insensitively (matching how the homebrew merge and the promoter match
     names, and how findRow's first-match lookup behaves).
  4. Column-set drift within a table, calling out the columns that
     promote_homebrew.base_columns() would silently drop -- it takes the
     canonical column set from row 0 only.
  5. Every HOMEBREW_CONFIG field key actually exists in its table.
  6. And the reverse: every column a homebrew table's rows carry is exposed in
     HOMEBREW_CONFIG. A column the editor omits can't be authored, and
     mergePackData drops it from imported packs -- so adding a column to a table
     means adding it to HOMEBREW_CONFIG in the same commit. This one is an error.
  7. Only the four sanctioned non-ASCII glyphs appear (see ALLOWED_NON_ASCII).

Exit status is 1 if any ERROR was reported (warnings alone still exit 0), so this
can gate a commit. See docs/DATA.md for the table catalogue and conventions.
"""

import argparse
import collections
import io
import json
import re
import sys
from pathlib import Path

# Run as `python tools/check_data.py` and Python puts tools/ on sys.path for us;
# be explicit so `python -m tools.check_data` and odd cwds work the same way.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from promote_homebrew import NAME_KEYS, load_data_bundle  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_JS = REPO_ROOT / "static" / "data.js"
HOMEBREW_JS = REPO_ROOT / "static" / "homebrew.js"
RULES_JS = REPO_ROOT / "static" / "rules.js"

# The only non-ASCII characters allowed in data.js. Everything else must be
# plain ASCII so the file stays diffable and encoding-proof (README, docs/DATA.md).
ALLOWED_NON_ASCII = {
    "°": "degree sign (temperatures)",
    "½": "one-half (ranges/inches)",
    "×": "multiplication sign (cost multiplier prose)",
    "ㄓ": "currency glyph",
}

# Bookkeeping columns mergeCustomContent() stamps onto a custom row as it splices
# it into the live table (homebrew.js). They are never authored, so the editor is
# not expected to expose them -- but a promoted pack row carries them into
# data.js, where they would otherwise read as columns nobody can edit.
MERGE_ADDED_COLUMNS = {"Custom", "PackId", "ReadOnly", "Source"}

# Same-name rows that are intentional and must not fail the uniqueness check.
# weapon_mods carries Overbarrel and Underbarrel variants under one name; note
# that findRow (rules.js) returns the FIRST match, so the Overbarrel row's stats
# win wherever a mod is looked up by name alone. See docs/DATA.md.
KNOWN_DUPLICATES = {"weapon_mods": {"laser sight", "flashlight"}}

# Key columns for the 20 tables that homebrew does not cover. Harvested from the
# findRow literals and the index loops in rules.js; a tuple means the row's
# identity is composite (no single column is unique on its own).
EXTRA_KEY_COLUMNS = {
    "amp_powers": "Name",
    "armor_extras": "Extra",
    "armor_materials": "Material",
    "armor_styles": "Style",
    "attribute_costs": "Level",
    "cyberguns": "Type",
    "deck_mods": "Deck Mod",
    "decks": "Name",
    "fashionware_qualities": "Quality",
    "hack_actions": ("Group", "Action"),
    "heritage_features": ("Category", "Name"),
    "heritages": "Name",
    "lifestyles": "Lifestyle",
    "martial_arts": ("Style", "Level"),
    "priorities": "Priority",
    "programs": "Name",
    "rig_mods": "Rig Mod",
    "rigs": "Rig Type",
    "speaker_bond_costs": "Bond",
    "speaker_elements": "Element",
    "speaker_infusions": "Infusions",   # plural, unlike every other key column
}

# Composite-key tables where one column must ALSO stay unique on its own because
# code indexes by it: rules.js:580 builds traitsByName[row.Name] across all
# heritage_features categories, so two categories sharing a Name would collide.
SINGLE_COLUMN_ALSO_UNIQUE = {"heritage_features": "Name"}

ERROR, WARN, INFO = "ERROR", "WARN", "INFO"


class Report:
    """Collects findings grouped by check, in the order checks first report."""

    def __init__(self):
        self.findings = []          # (level, section, message)
        self.sections = []          # section names, in first-seen order

    def add(self, level, section, message):
        if section not in self.sections:
            self.sections.append(section)
        self.findings.append((level, section, message))

    def error(self, section, message):
        self.add(ERROR, section, message)

    def warn(self, section, message):
        self.add(WARN, section, message)

    def info(self, section, message):
        self.add(INFO, section, message)

    def count(self, level):
        return sum(1 for lv, _, _ in self.findings if lv == level)

    def print(self):
        for section in self.sections:
            rows = [(lv, m) for lv, s, m in self.findings if s == section]
            bad = sum(1 for lv, _ in rows if lv in (ERROR, WARN))
            status = "FAIL" if any(lv == ERROR for lv, _ in rows) else (
                "warn" if bad else "ok")
            print(f"\n[{status}] {section}")
            for level, message in rows:
                prefix = {ERROR: "  ERROR: ", WARN: "  warn:  ",
                          INFO: "  note:  "}[level]
                print(prefix + message)


def key_columns(table):
    """Every key column tuple for a table: (col, ...) -- homebrew tables first."""
    if table in NAME_KEYS:
        return (NAME_KEYS[table],)
    spec = EXTRA_KEY_COLUMNS.get(table)
    if spec is None:
        return ()
    return spec if isinstance(spec, tuple) else (spec,)


def extract_homebrew_config(text):
    """Parse HOMEBREW_CONFIG out of homebrew.js: {table: (nameKey, [field keys])}.

    Regex-scraped rather than executed (no Node here). Structure assumed:
        const HOMEBREW_CONFIG = {
          tab: { label: "...", nameKey: "...", fields: [ { key: "..." }, ...
        };

    A tab may be a VIEW of another table rather than a table of its own
    ("ammo" is misc_gear filtered by Class), declared as `table: "misc_gear"`
    between label and nameKey. Such a tab is folded into the table it stores
    into -- its fields join that table's, and it is not a table name of its own
    -- so every check downstream still reasons in data.js tables.
    """
    block = re.search(r"const HOMEBREW_CONFIG = \{(.*?)\n\};", text, re.S)
    if not block:
        return None
    body = block.group(1)
    entries = re.findall(
        r'\n  (\w+):\s*\{\s*label:\s*"[^"]*",\s*(?:table:\s*"(\w+)",\s*)?nameKey:\s*"([^"]+)"',
        body)
    # Split on the same tab-entry boundary to attribute field keys per tab.
    parts = re.split(r"\n  (\w+):\s*\{", body)
    fields = {parts[i]: re.findall(r'\{\s*key:\s*"([^"]+)"', parts[i + 1])
              for i in range(1, len(parts) - 1, 2)}
    out = {}
    for tab, table, name_key in entries:
        table = table or tab
        have_key, have_fields = out.get(table, (name_key, []))
        merged = list(have_fields)
        for col in fields.get(tab, []):
            if col not in merged:
                merged.append(col)
        out[table] = (have_key, merged)
    return out


def extract_findrow_pairs(text):
    """(table, column) pairs from literal findRow(data.X, "Col", ...) calls.

    Only literals are visible this way; call sites that pass a table or column
    through a variable (hostKinds, weaponAndModTables, priceAll, activeGearRow)
    are invisible here and are listed in docs/DATA.md instead.
    """
    return sorted(set(re.findall(r'findRow\(\s*data\.(\w+)\s*,\s*"([^"]+)"', text)))


def columns_of(rows):
    """(row-0 columns, union of all columns) for a table."""
    if not rows:
        return set(), set()
    union = set()
    for row in rows:
        union |= set(row)
    return set(rows[0]), union


def check_key_registries(report, tables, hb_config, findrow_pairs):
    section = "Key-column registries agree"

    if hb_config is None:
        report.error(section, "could not find `const HOMEBREW_CONFIG = {...};` in "
                              f"{HOMEBREW_JS.name} -- the scraping regex in "
                              "extract_homebrew_config() has gone stale.")
    else:
        hb_keys = {t: k for t, (k, _) in hb_config.items()}
        for table in sorted(set(hb_keys) | set(NAME_KEYS)):
            in_hb, in_py = hb_keys.get(table), NAME_KEYS.get(table)
            if in_hb is None:
                report.error(section, f"{table}: in NAME_KEYS "
                                      f"({HOMEBREW_JS.name} HOMEBREW_CONFIG is missing it)")
            elif in_py is None:
                report.error(section, f"{table}: in HOMEBREW_CONFIG "
                                      "(promote_homebrew.NAME_KEYS is missing it)")
            elif in_hb != in_py:
                report.error(section, f"{table}: nameKey {in_hb!r} in HOMEBREW_CONFIG "
                                      f"but {in_py!r} in NAME_KEYS")
        report.info(section, f"{len(hb_keys)} homebrew tables; HOMEBREW_CONFIG and "
                             "NAME_KEYS agree" if hb_keys == NAME_KEYS else
                             f"{len(hb_keys)} homebrew tables scraped")

    if not findrow_pairs:
        report.error(section, f"no literal findRow(data.X, \"Col\") calls found in "
                              f"{RULES_JS.name} -- the regex in "
                              "extract_findrow_pairs() has gone stale.")
    else:
        report.info(section, f"{len(findrow_pairs)} literal findRow lookups in "
                             f"{RULES_JS.name}")

    # Every registered/observed key column must exist in the data.
    registered = {t: key_columns(t) for t in tables if key_columns(t)}
    for table, cols in sorted(registered.items()):
        rows = tables.get(table) or []
        for col in cols:
            missing = sum(1 for r in rows if col not in r)
            if missing:
                report.error(section, f"{table}: key column {col!r} missing from "
                                      f"{missing}/{len(rows)} rows")

    # findRow's column must match what we registered, and exist in the data.
    for table, col in findrow_pairs:
        rows = tables.get(table)
        if rows is None:
            report.error(section, f"rules.js calls findRow(data.{table}, ...) but "
                                  "data.js has no such table")
            continue
        expected = key_columns(table)
        if expected and col not in expected:
            report.error(section, f"rules.js looks up {table} by {col!r}, but its "
                                  f"registered key is {'/'.join(expected)!r}")
        row0, union = columns_of(rows)
        if col not in union:
            report.error(section, f"rules.js looks up {table} by {col!r}, which no "
                                  "row has")
        elif col not in row0:
            report.warn(section, f"{table}: findRow column {col!r} is absent from "
                                 "row 0 (see the drift check)")

    unregistered = sorted(t for t, rows in tables.items()
                          if isinstance(rows, list) and rows and not key_columns(t))
    if unregistered:
        report.warn(section, "no key column registered for: "
                             + ", ".join(unregistered)
                             + " -- add them to EXTRA_KEY_COLUMNS and docs/DATA.md")


def check_row_identity(report, tables):
    section = "Row identity (present, non-empty, unique)"
    checked = 0
    for table in sorted(tables):
        rows = tables[table]
        if not isinstance(rows, list) or not rows:
            continue
        cols = key_columns(table)
        if not cols:
            continue
        checked += 1
        # Blank keys: a row the merge and the promoter would both skip silently.
        blank = sum(1 for r in rows
                    if not all(str(r.get(c, "")).strip() for c in cols))
        if blank:
            report.error(section, f"{table}: {blank} row(s) with a blank "
                                  f"{'/'.join(cols)}")
        allowed = KNOWN_DUPLICATES.get(table, set())
        counts = collections.Counter(
            tuple(str(r.get(c, "")).strip().lower() for c in cols) for r in rows)
        for key, n in sorted(counts.items()):
            if n < 2 or not any(key):
                continue
            label = " / ".join(k for k in key)
            if len(cols) == 1 and key[0] in allowed:
                report.info(section, f"{table}: {n}x {label!r} (known variant rows; "
                                     "first match wins on lookup)")
            else:
                report.error(section, f"{table}: {n} rows share "
                                      f"{'/'.join(cols)} {label!r}")
        # Columns that must be unique alone even though identity is composite.
        alone = SINGLE_COLUMN_ALSO_UNIQUE.get(table)
        if alone:
            solo = collections.Counter(
                str(r.get(alone, "")).strip().lower() for r in rows)
            clashes = {k: n for k, n in solo.items() if n > 1 and k}
            for key, n in sorted(clashes.items()):
                report.error(section, f"{table}: {n} rows share {alone}={key!r}; code "
                                      f"indexes {table} by {alone} alone, so these "
                                      "would shadow each other")
    report.info(section, f"{checked} tables checked")


def check_column_drift(report, tables):
    section = "Column-set drift"
    drifting = 0
    for table in sorted(tables):
        rows = tables[table]
        if not isinstance(rows, list) or not rows:
            continue
        variants = collections.Counter(frozenset(r) for r in rows)
        if len(variants) < 2:
            continue
        drifting += 1
        row0, union = columns_of(rows)
        late = sorted(union - row0)
        sizes = ", ".join(f"{n} cols x{c}" for n, c in
                          sorted(collections.Counter(len(r) for r in rows).items()))
        report.warn(section, f"{table}: {len(variants)} column sets ({sizes})")
        if late:
            # base_columns() reads row 0 only, so these vanish from promoted rows.
            hazard = ("promoted rows would LOSE" if table in NAME_KEYS
                      else "absent from row 0:")
            report.warn(section, f"{table}: {hazard} {', '.join(late)}")
    if drifting:
        report.info(section, f"{drifting} tables have ragged rows. This is the "
                             "current reality, not a regression -- but promoting "
                             "homebrew into a table listed above drops the columns "
                             "named (promote_homebrew.base_columns reads row 0).")


def check_homebrew_fields(report, tables, hb_config):
    section = "HOMEBREW_CONFIG field keys exist"
    if hb_config is None:
        report.info(section, "skipped (HOMEBREW_CONFIG not readable)")
        return
    for table, (_, fields) in sorted(hb_config.items()):
        rows = tables.get(table)
        if rows is None:
            report.error(section, f"HOMEBREW_CONFIG has table {table!r}, absent from "
                                  "data.js")
            continue
        _, union = columns_of(rows)
        unknown = [f for f in fields if f not in union]
        if unknown:
            report.warn(section, f"{table}: editor field(s) no row has: "
                                 + ", ".join(unknown))
    report.info(section, f"{sum(len(f) for _, f in hb_config.values())} field keys "
                         f"across {len(hb_config)} tables")


def check_homebrew_coverage(report, tables, hb_config):
    """The reverse of check_homebrew_fields: every data column is editable.

    A column that data.js carries but HOMEBREW_CONFIG omits is invisible twice
    over -- the editor can't author it, and mergePackData drops it from any pack
    that has one, so an imported row loses the value silently. That is how a
    column added for core rows quietly becomes homebrew-hostile, which is why
    this is an ERROR rather than a warning: adding a column to a table means
    adding it to HOMEBREW_CONFIG in the same commit.
    """
    section = "HOMEBREW_CONFIG covers every column"
    if hb_config is None:
        report.info(section, "skipped (HOMEBREW_CONFIG not readable)")
        return
    covered = 0
    for table, (_, fields) in sorted(hb_config.items()):
        rows = tables.get(table)
        if rows is None:
            continue                       # already reported by check_homebrew_fields
        _, union = columns_of(rows)
        missing = sorted(union - set(fields) - MERGE_ADDED_COLUMNS)
        if missing:
            report.error(section, f"{table}: column(s) the editor cannot author: "
                                  + ", ".join(missing))
        else:
            covered += 1
    report.info(section, f"{covered}/{len(hb_config)} homebrew tables expose every "
                         "column their rows carry")


def check_non_ascii(report, text):
    section = "Non-ASCII glyphs"
    counts = collections.Counter(c for c in text if ord(c) > 127)
    for char, n in sorted(counts.items(), key=lambda kv: -kv[1]):
        line = text[:text.index(char)].count("\n") + 1
        code = f"U+{ord(char):04X}"
        if char in ALLOWED_NON_ASCII:
            report.info(section, f"{code} x{n} -- {ALLOWED_NON_ASCII[char]}")
        else:
            report.error(section, f"{code} x{n} not allowed (first at line {line}); "
                                  "use ASCII or add it to ALLOWED_NON_ASCII and "
                                  "docs/DATA.md")
    if not counts:
        report.info(section, "file is pure ASCII")


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", type=Path, default=DATA_JS,
                    help=f"path to data.js (default: {DATA_JS})")
    ap.add_argument("--strict", action="store_true",
                    help="exit 1 on warnings as well as errors")
    args = ap.parse_args()

    # data.js legitimately contains non-ASCII; don't die printing it on a cp1252
    # console (Windows).
    if hasattr(sys.stdout, "buffer"):
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8",
                                      errors="replace", line_buffering=True)

    report = Report()
    parse_section = "data.js parses"
    try:
        text = args.data.read_text(encoding="utf-8")
    except OSError as e:
        print(f"ERROR: cannot read {args.data}: {e}")
        return 1
    try:
        # load_data_bundle sys.exit()s on a bad payload; convert that into a finding.
        _, bundle, _ = load_data_bundle(text)
    except SystemExit as e:
        report.error(parse_section, str(e) or "data.js payload is not valid JSON")
        report.print()
        print("\n1 error(s), 0 warning(s) -- data.js could not be parsed.")
        return 1

    tables = bundle.get("tables")
    if not isinstance(tables, dict):
        report.error(parse_section, "bundle has no `tables` object")
        report.print()
        return 1
    rows_total = sum(len(v) for v in tables.values() if isinstance(v, list))
    extras = [k for k in bundle if k != "tables"]
    report.info(parse_section, f"{len(tables)} tables, {rows_total} rows, "
                               f"{len(extras)} non-table top-level key(s): "
                               + ", ".join(extras))

    hb_config = None
    if HOMEBREW_JS.exists():
        hb_config = extract_homebrew_config(HOMEBREW_JS.read_text(encoding="utf-8"))
    findrow_pairs = (extract_findrow_pairs(RULES_JS.read_text(encoding="utf-8"))
                     if RULES_JS.exists() else [])

    check_key_registries(report, tables, hb_config, findrow_pairs)
    check_row_identity(report, tables)
    check_column_drift(report, tables)
    check_homebrew_fields(report, tables, hb_config)
    check_homebrew_coverage(report, tables, hb_config)
    check_non_ascii(report, text)

    report.print()
    errors, warnings = report.count(ERROR), report.count(WARN)
    print(f"\n{errors} error(s), {warnings} warning(s).")
    if args.data == DATA_JS:
        print("Reminder: if static/data.js changed, bump CACHE_VERSION in sw.js "
              "(promote_homebrew.py does this for you).")
    return 1 if errors or (args.strict and warnings) else 0


if __name__ == "__main__":
    sys.exit(main())
