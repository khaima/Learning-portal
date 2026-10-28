// The detail tables' search and download (tables.js). Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { csvOf, matches } from "../tables.js";

test("search: every word must appear, in any case and order", () => {
  assert.equal(matches("Aitong Primary Narok 34", "narok aitong"), true);
  assert.equal(matches("Aitong Primary Narok 34", "narok nyeri"), false);
  assert.equal(matches("anything", ""), true, "an empty search keeps every row");
  assert.equal(matches("anything", "   "), true);
});

test("CSV: quoted where needed, and nothing a spreadsheet would run as a formula", () => {
  assert.equal(csvOf([["School", "Learners"], ["Aitong Primary", "34"]]), "School,Learners\r\nAitong Primary,34");
  assert.equal(csvOf([["Mara, Ripoi", 'He said "hi"']]), '"Mara, Ripoi","He said ""hi"""');
  assert.equal(csvOf([['=HYPERLINK("x")']]), `"'=HYPERLINK(""x"")"`, "a formula is kept as text (and quoted for its quotes)");
  assert.equal(csvOf([["+254 700"], ["@sum"], ["-cmd"]]), "'+254 700\r\n'@sum\r\n'-cmd");
  assert.equal(csvOf([["-5"], ["−11.7 pts"]]), "-5\r\n−11.7 pts", "a negative number stays a number");
});
