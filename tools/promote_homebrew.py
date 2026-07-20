#!/usr/bin/env python3
"""Promote a Sinless homebrew pack into the canonical static/data.js.

A user (or the owner) exports their homebrew via the app's "Export Pack" button,
producing a `sinless-homebrew-pack.json`. This script folds those rows into the
base data file so they ship as part of the base package for everyone -- no
hand-editing of the ~320 KB minified data.js required.

Usage:
    python tools/promote_homebrew.py path/to/sinless-homebrew-pack.json
    python tools/promote_homebrew.py pack.json --dry-run
    python tools/promote_homebrew.py pack.json --skip          # skip name clashes
    python tools/promote_homebrew.py pack.json --no-cache-bump

By default, a promoted row whose name matches an existing base row *replaces*
that row's stats in place (upsert); new names are appended. Use --skip to leave
existing base rows untouched and only add genuinely new items.

The script bumps CACHE_VERSION in sw.js so deployed clients drop their stale
cached data.js. Commit static/data.js and sw.js afterwards, then deploy.
"""

import argparse
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_JS = REPO_ROOT / "static" / "data.js"
SW_JS = REPO_ROOT / "sw.js"

# The 15 homebrew-eligible tables and the column that holds each row's identity
# name. Mirrors HOMEBREW_CONFIG in static/homebrew.js -- keep in sync if that
# changes. Only these tables are considered during promotion.
NAME_KEYS = {
    "rituals": "Name",
    "spells": "Name",
    "misc_gear": "Item",
    "augments": "Name",
    "weapons": "Weapon",
    "armor": "Armor",
    "vehicles": "Vehicle",
    "drones": "Drone",
    "weapon_mods": "Modification",
    "vehicle_ballistic_weapons": "Vehicle Ballistic Weapon",
    "vehicle_energy_weapons": "Vehicle Energy Weapon",
    "drone_ballistic_weapons": "Drone Ballistic Weapon",
    "drone_energy_weapons": "Drone Energy Weapon",
    "vehicle_mods": "Vehicle Mod",
    "drone_mods": "Drone Mod",
}


def load_data_bundle(text):
    """Split data.js into (head, bundle_obj, tail).

    data.js is `const DATA_BUNDLE = <one big JSON literal>;` wrapped in a comment
    header and a trailing `module.exports` line. We locate the JSON, parse it with
    raw_decode (which reports exactly where it ends), and keep the surrounding
    wrapper as literal strings so nothing else in the file is disturbed.
    """
    marker = "const DATA_BUNDLE"
    m = re.search(marker + r"\s*=\s*", text)
    if not m:
        sys.exit(f"error: could not find `{marker} =` in {DATA_JS}")
    json_start = text.index("{", m.end())
    head = text[:json_start]
    try:
        bundle, end = json.JSONDecoder().raw_decode(text, json_start)
    except json.JSONDecodeError as e:
        sys.exit(f"error: data.js payload is not valid JSON: {e}")
    tail = text[end:]
    return head, bundle, tail


def load_pack(path):
    try:
        parsed = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        sys.exit(f"error: could not read pack {path}: {e}")
    # Same validity check the in-app importer uses: an object with at least one
    # known table array (homebrew.js:453-454).
    if not isinstance(parsed, dict) or not any(
        isinstance(parsed.get(k), list) for k in NAME_KEYS
    ):
        sys.exit("error: that file doesn't look like a Sinless homebrew pack.")
    return parsed


def base_columns(table_rows, pack_row, table):
    """Canonical column set for a table: keys of existing base rows, else the
    pack row's own keys (with a warning) when the base table is empty."""
    if table_rows:
        return list(table_rows[0].keys())
    print(
        f"  warning: base table '{table}' is empty; "
        f"deriving columns from the pack row."
    )
    return [k for k in pack_row.keys() if k != "Custom"]


def conform_row(raw, columns, table):
    """Build a promoted row matching the base schema: every base column present,
    all values coerced to trimmed strings, the Custom marker dropped. Warn on any
    pack keys outside the base schema (they are dropped)."""
    row = {col: str(raw.get(col, "")).strip() for col in columns}
    extra = [k for k in raw if k not in columns and k != "Custom"]
    if extra:
        print(
            f"  warning: {table}: dropped field(s) not in base schema: "
            f"{', '.join(extra)}"
        )
    return row


def promote(bundle, pack, skip):
    """Apply the pack to bundle['tables'] in place. Returns a per-table summary
    dict {table: (updated, added, skipped)}."""
    tables = bundle.get("tables", {})
    summary = {}
    for table, name_key in NAME_KEYS.items():
        pack_rows = pack.get(table)
        if not isinstance(pack_rows, list) or not pack_rows:
            continue
        base = tables.setdefault(table, [])
        # Map normalized name -> index in base for in-place upsert.
        index = {}
        for i, r in enumerate(base):
            key = str(r.get(name_key, "")).strip().lower()
            if key:
                index[key] = i
        updated = added = skipped = 0
        for raw in pack_rows:
            if not isinstance(raw, dict):
                continue
            columns = base_columns(base, raw, table)
            row = conform_row(raw, columns, table)
            name = row.get(name_key, "")
            if not name:
                continue
            key = name.lower()
            if key in index:
                if skip:
                    skipped += 1
                    continue
                base[index[key]] = row  # overwrite in place, keep position
                updated += 1
            else:
                index[key] = len(base)
                base.append(row)
                added += 1
        if updated or added or skipped:
            summary[table] = (updated, added, skipped)
    return summary


def format_bundle(bundle):
    """Serialize the bundle with one table row per line (rows themselves stay
    compact). Line-oriented rows let git diff and merge data changes instead of
    conflicting on one giant line. Non-ASCII is preserved (e.g. the currency
    glyph)."""
    compact = lambda v: json.dumps(v, ensure_ascii=False, separators=(",", ":"))
    lines = ["{"]
    top = list(bundle.items())
    for ti, (key, val) in enumerate(top):
        tc = "" if ti == len(top) - 1 else ","
        if key == "tables" and isinstance(val, dict):
            lines.append(compact(key) + ":{")
            tables = list(val.items())
            for i, (tname, rows) in enumerate(tables):
                c = "" if i == len(tables) - 1 else ","
                if isinstance(rows, list):
                    lines.append(compact(tname) + ":[")
                    for j, row in enumerate(rows):
                        lines.append(compact(row) + ("" if j == len(rows) - 1 else ","))
                    lines.append("]" + c)
                else:
                    lines.append(compact(tname) + ":" + compact(rows) + c)
            lines.append("}" + tc)
        else:
            lines.append(compact(key) + ":" + compact(val) + tc)
    lines.append("}")
    return "\n".join(lines)


def serialize_data_js(head, bundle, tail):
    """Re-emit data.js row-per-line via format_bundle. Re-parse as a safety
    check before handing anything back to write."""
    payload = format_bundle(bundle)
    result = head + payload + tail
    # Safety: the wrapper's own text is untouched, but confirm the payload still
    # round-trips before we hand back something to write.
    if json.loads(payload) != bundle:
        sys.exit("error: serializer round-trip mismatch; data.js not written.")
    return result


def bump_cache_version(text):
    """Increment the sinless-vN cache version in sw.js. Returns (new_text, old,
    new) or (text, None, None) if not found / not bumped."""
    m = re.search(r'CACHE_VERSION\s*=\s*"(sinless-v(\d+))"', text)
    if not m:
        print("  warning: could not find CACHE_VERSION in sw.js; not bumped.")
        return text, None, None
    old = m.group(1)
    new = f"sinless-v{int(m.group(2)) + 1}"
    new_text = text[: m.start(1)] + new + text[m.end(1):]
    return new_text, old, new


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pack", help="path to a sinless-homebrew-pack.json")
    ap.add_argument("--dry-run", action="store_true",
                    help="report what would change; write nothing")
    ap.add_argument("--skip", action="store_true",
                    help="skip rows whose name already exists (default: upsert)")
    ap.add_argument("--no-cache-bump", action="store_true",
                    help="do not bump CACHE_VERSION in sw.js")
    ap.add_argument("--data", type=Path, default=DATA_JS,
                    help=f"path to data.js (default: {DATA_JS})")
    ap.add_argument("--sw", type=Path, default=SW_JS,
                    help=f"path to sw.js (default: {SW_JS})")
    args = ap.parse_args()

    data_text = args.data.read_text(encoding="utf-8")
    head, bundle, tail = load_data_bundle(data_text)
    pack = load_pack(args.pack)

    summary = promote(bundle, pack, args.skip)

    if not summary:
        print("Nothing to promote (no new or changed rows found in the pack).")
        return

    total_u = sum(u for u, _, _ in summary.values())
    total_a = sum(a for _, a, _ in summary.values())
    total_s = sum(s for _, _, s in summary.values())
    print(f"\n{'DRY RUN -- ' if args.dry_run else ''}Promotion summary:")
    for table, (u, a, s) in sorted(summary.items()):
        parts = [f"{u} updated", f"{a} added"]
        if s:
            parts.append(f"{s} skipped")
        print(f"  {table}: {', '.join(parts)}")
    print(f"  total: {total_u} updated, {total_a} added"
          + (f", {total_s} skipped" if total_s else ""))

    new_data = serialize_data_js(head, bundle, tail)

    sw_text = args.sw.read_text(encoding="utf-8") if args.sw.exists() else None
    old_v = new_v = None
    if sw_text is not None and not args.no_cache_bump:
        sw_text, old_v, new_v = bump_cache_version(sw_text)
        if old_v:
            print(f"  cache: {old_v} -> {new_v}")

    if args.dry_run:
        print("\nDry run: no files written.")
        return

    args.data.write_text(new_data, encoding="utf-8", newline="\n")
    if sw_text is not None and new_v:
        args.sw.write_text(sw_text, encoding="utf-8", newline="\n")
    print(f"\nWrote {args.data}"
          + (f" and bumped {args.sw}" if new_v else "")
          + ". Review, commit, and deploy.")


if __name__ == "__main__":
    main()
