// The rules engine gives the same answer in every browser.
//
// rules.js runs unchanged under Node, so Node's output is the reference: each
// fixture is calculated there and in the browser, and the two must match to
// the last field. A difference means an engine-specific behaviour leaked into
// the maths (regex features, sort stability, number formatting, Intl, ...).
const { test, expect } = require("@playwright/test");
const { ALL_FIXTURES, fixture, watchErrors, expectNoErrors, openWith } = require("./helpers");

global.DATA_BUNDLE = require("../../static/data.js");
const RULES = require("../../static/rules.js");

function nodeResult(char) {
  return JSON.parse(JSON.stringify(RULES.calculate(JSON.parse(JSON.stringify(char)))));
}

test("RULES.calculate matches Node for every fixture", async ({ page }) => {
  const errors = watchErrors(page);
  await openWith(page);
  for (const name of ALL_FIXTURES) {
    const char = fixture(name);
    const inBrowser = await page.evaluate(
      c => JSON.parse(JSON.stringify(RULES.calculate(c))), char);
    expect(inBrowser, `calculate(${name})`).toEqual(nodeResult(char));
  }
  expectNoErrors(errors);
});
