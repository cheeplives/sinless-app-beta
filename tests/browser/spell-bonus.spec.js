// A spell's Skill Bonus applies only while it's cast (JC-026).
//
// Known is not cast: the bonus lands while a cast of the spell is on the
// Active Spells banner (play.active_spells), leaves when it's dismissed, and
// two casts of the same spell still count once. No shipped spell row carries a
// Skill Bonus yet, so the test gives one to the fixture's first known spell.
const { test, expect } = require("@playwright/test");
const { fixture } = require("./helpers");

global.DATA_BUNDLE = require("../../static/data.js");
const RULES = require("../../static/rules.js");

test("a known spell's Skill Bonus applies only while it is cast", () => {
  const base = fixture("kitchen-sink-final");
  const spell = base.magic.spells[0];
  const name = typeof spell === "object" ? spell.name : spell;
  const row = DATA_BUNDLE.tables.spells.find(r => r.Name === name);
  const saved = row["Skill Bonus"];
  row["Skill Bonus"] = "Athletics +2";
  try {
    const athletics = active => {
      const c = JSON.parse(JSON.stringify(base));
      c.play = { ...(c.play || {}), active_spells: active };
      return RULES.calculate(c).skills.Athletics.bonus;
    };
    const known = athletics([]);
    expect(athletics([{ uid: "a", name }])).toBe(known + 2);
    expect(athletics([{ uid: "a", name }, { uid: "b", name }])).toBe(known + 2);
  } finally {
    row["Skill Bonus"] = saved;
  }
});
