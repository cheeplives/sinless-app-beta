#!/usr/bin/env python3
"""One-off schema migration: add gear-mount columns to static/data.js.

Adds "Mount Types" / "Mount ZP" to every row of the armor, misc_gear, and
weapons tables (empty string = the item cannot mount augments), then fills in
the two base items that can:

    Power Armor (armor)        Mount Types "Any",     Mount ZP 3
    Arwin Goggles (misc_gear)  Mount Types "Eyeware", Mount ZP 0.3

Idempotent -- setdefault only appends missing keys, so rerunning is a no-op.
Run from anywhere: python tools/add_mount_columns.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from promote_homebrew import DATA_JS, load_data_bundle, serialize_data_js

MOUNT_TABLES = ("armor", "misc_gear", "weapons")

ARWIN_EFFECT = ("Grants an arwin window. Can mount up to 0.3 ZP of Eyeware "
                "augments. Can be customized with fashion from the fashion board.")


def main():
    head, bundle, tail = load_data_bundle(DATA_JS.read_text(encoding="utf-8"))
    tables = bundle["tables"]

    for table in MOUNT_TABLES:
        added = 0
        for row in tables[table]:
            before = len(row)
            row.setdefault("Mount Types", "")
            row.setdefault("Mount ZP", "")
            added += len(row) != before
        print(f"  {table}: columns added to {added}/{len(tables[table])} rows")

    for row in tables["armor"]:
        if row["Armor"] == "Power Armor":
            row["Mount Types"] = "Any"
            row["Mount ZP"] = "3"
            print("  set Power Armor: Any / 3 ZP")
    for row in tables["misc_gear"]:
        if row["Item"] == "Arwin Goggles":
            row["Mount Types"] = "Eyeware"
            row["Mount ZP"] = "0.3"
            row["Effect"] = ARWIN_EFFECT
            print("  set Arwin Goggles: Eyeware / 0.3 ZP")

    DATA_JS.write_text(serialize_data_js(head, bundle, tail),
                       encoding="utf-8", newline="\n")
    print(f"Wrote {DATA_JS}")


if __name__ == "__main__":
    main()
