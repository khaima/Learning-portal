// Reading the learners CSV (csv.js). Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv } from "../csv.js";

test("plain rows, with the header and blank lines as they come", () => {
  assert.deepEqual(parseCsv("Full name,Username,Grade\r\nAmina Otieno,amina.o,Grade 4\r\n\r\n"), [
    ["Full name", "Username", "Grade"],
    ["Amina Otieno", "amina.o", "Grade 4"],
  ]);
});

test("a quoted cell keeps its commas, doubled quotes and line breaks", () => {
  assert.deepEqual(parseCsv('"Wanjiru, Grace",grace.w,Grade 5\n"Ken ""KJ"" Mwangi",,5\n"Two\nLines",x,PP1'), [
    ["Wanjiru, Grace", "grace.w", "Grade 5"],
    ['Ken "KJ" Mwangi', "", "5"],
    ["Two\nLines", "x", "PP1"],
  ]);
});

test("a spreadsheet's byte-order mark and a last line with no line break", () => {
  assert.deepEqual(parseCsv("\uFEFFFull name,PIN\nBrian,2580"), [["Full name", "PIN"], ["Brian", "2580"]]);
});
