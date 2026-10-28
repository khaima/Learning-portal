// The chart rules (docs/CHARTS.md): what charts.js draws and the one
// sentence it may say. Run with `npm test` (Node's own test runner; CI runs it).
import { test } from "node:test";
import assert from "node:assert/strict";

// util.js listens on the page when it loads: a stand-in page is enough here.
globalThis.document = { addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, createElement() { return {}; } };
globalThis.window = globalThis;
const C = await import("../charts.js");

const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const insight = (html) => (/<p class="chart-insight">([^<]*)<\/p>/.exec(html) || [])[1] || "";
const grades = [{ label: "Grade 4", value: 60, base: 150 }, { label: "Grade 5", value: 60, base: 164 }, { label: "Grade 6", value: 62, base: 49 }];

test("bars: the highest and lowest, ties named together", () => {
  assert.equal(insight(C.barList(grades, { unit: "%", insight: true })), "Highest: Grade 6, 62%. Lowest: Grade 4 and Grade 5, 60%.");
  assert.equal(insight(C.barList([{ label: "A", value: 9 }, { label: "B", value: 0 }, { label: "C", value: 0 }], { insight: true })), "Most: A, 9. Fewest: B and C, 0.");
});

test("bars: a group resting on fewer than five isn't judged; fewer than three groups, no sentence", () => {
  assert.equal(insight(C.barList([...grades, { label: "Tiny", value: 99, base: 2 }], { unit: "%", insight: true })),
    "Highest: Grade 6, 62%. Lowest: Grade 4 and Grade 5, 60% (groups of 5 or more).");
  assert.equal(insight(C.barList(grades.slice(0, 2), { unit: "%", insight: true })), "");
  assert.equal(insight(C.barList(grades, { unit: "%" })), "", "only when asked");
});

test("bars: a long ranked list shows its top 10 and the rest behind 'Show all'; an ordered list is never cut", () => {
  const many = Array.from({ length: 15 }, (_, i) => ({ label: `School ${i}`, value: i + 1 }));
  const ranked = C.barList(many, { sort: true });
  assert.match(ranked, /Show all 15/);
  assert.equal((ranked.split("<details")[0].match(/bars-row/g) || []).length, 10);
  assert.equal((ranked.match(/bars-row/g) || []).length, 15, "every row is still there");
  assert.doesNotMatch(C.barList(many), /Show all/);
});

test("bars: the period is in every tooltip", () => {
  assert.match(C.barList(grades, { unit: "%", period: "1 Sep 2026 – 27 Oct 2026" }), /1 Sep 2026 – 27 Oct 2026/);
});

test("parts of one whole are bars with shares — no pies or donuts", () => {
  const parts = C.proportion([{ label: "TSC", value: 11 }, { label: "BOM", value: 4 }], { noun: "teachers" });
  assert.doesNotMatch(parts, /donut|<svg/);
  assert.match(text(parts), /TSC 11 73%/);
  assert.equal(C.donut, undefined);
});

test("grouped bars: two periods side by side, missing data said as such", () => {
  const two = [{ label: "Term 2" }, { label: "Term 3" }];
  const gb = C.groupedBars([{ label: "Maths", values: [57, 66] }, { label: "English", values: [57, 61] }], two,
    { unit: "%", noun: "average mark", insight: true, period: "All time" });
  assert.equal(insight(gb), "Higher in Term 3 than Term 2 in both.");
  assert.match(gb, /All time/);
  assert.match(C.groupedBars([{ label: "X", values: [null, 50] }], two, { unit: "%" }), /No data/);
  const mixed = C.groupedBars([{ label: "A", values: [50, 60] }, { label: "B", values: [50, 40] }, { label: "C", values: [50, 70] }], two, { unit: "%", insight: true });
  assert.equal(insight(mixed), "Higher in Term 3 than Term 2 in 2 of 3; lower in 1.");
});

test("a line: the period under way is open and dashed, and left out of the sentence", () => {
  const pts = [{ label: "Jul", full: "July", value: 4 }, { label: "Aug", full: "August", value: 2 },
    { label: "Sep", full: "September", value: 1 }, { label: "Oct", full: "October", value: 0, partial: true }];
  const lc = C.lineChart(pts, { noun: "visits", insight: true });
  assert.equal(insight(lc), "September: 1 visit, down from 2 in August.");
  assert.match(lc, /lc-line-partial/);
  assert.match(lc, /is-partial/);
  assert.match(text(lc), /October isn't over yet/);
  assert.equal(insight(C.lineChart(pts.slice(0, 3), { noun: "visits" })), "", "only when asked");
});

test("a heatmap: the busiest (or largest) cell, never a tie", () => {
  const cols = [{ label: "Grade 4" }, { label: "Grade 5" }];
  assert.equal(insight(C.heatmap([{ label: "Aitong", values: [17, 17] }, { label: "Chaka", values: [0, 21] }], cols, { noun: "learners", insight: "Largest" })),
    "Largest: Chaka, Grade 5 (21 learners).");
  assert.equal(insight(C.heatmap([{ label: "A", values: [3, 3] }], cols, { noun: "visits", insight: true })), "");
});

test("the reporting period's words", () => {
  assert.equal(C.periodLabel({}), "All time");
  assert.match(C.periodLabel({ from: "2026-09-01", to: "2026-10-27" }), /2026 – .*2026/);
  assert.equal(C.periodChip(""), "");
});

test("bars: a tooltip can carry the figure to compare with", () => {
  const html = C.barList([{ label: "Narok", value: 71 }], { unit: "%", compare: { value: 77, label: "all counties" } });
  assert.match(html, /77%/);
  assert.match(html, /all counties/);
  assert.doesNotMatch(C.barList([{ label: "Narok", value: 71 }], { unit: "%", compare: { value: null, label: "all counties" } }), /all counties/, "nothing to compare: no row");
});
