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

test("parts of one whole: bars by default; a ring only for 2–5 parts, every number in its key", () => {
  const parts = C.proportion([{ label: "TSC", value: 11 }, { label: "BOM", value: 4 }], { noun: "teachers" });
  assert.doesNotMatch(parts, /donut|<svg/);
  assert.match(text(parts), /TSC 11 73%/);
  const ring = C.donut([{ label: "Exceeding", value: 20, colour: "var(--band-1)" }, { label: "Meeting", value: 45, colour: "var(--band-2)" }, { label: "Below", value: 0, colour: "var(--band-4)" }],
    { noun: "pieces", title: "Marked work by band" });
  assert.match(ring, /class="donut"/);
  assert.match(text(ring), /Exceeding 20 31%.*Meeting 45 69%.*Below 0 0%/, "every part's count and share in the key, a part with none included");
  assert.equal((ring.match(/class="dn-seg"/g) || []).length, 2, "no slice for a part with nothing");
  assert.match(ring, /aria-label="Marked work by band: Exceeding 20 \(31%\), Meeting 45 \(69%\), Below 0 \(0%\), of 65 pieces"/);
  assert.match(ring, /<b>65<\/b>/, "the total in the middle");
  const many = C.donut(["A", "B", "C", "D", "E", "F"].map((label, i) => ({ label, value: i + 1 })), { noun: "x" });
  assert.doesNotMatch(many, /class="donut"/, "six parts are bars");
  assert.match(C.donut([], { empty: "Nothing yet." }), /Nothing yet/);
});

test("columns: the value on each cap, the period under way paler, a reference line named in the key", () => {
  const pts = [{ label: "T3", full: "2025 Term 3", value: 66 }, { label: "T1", full: "2026 Term 1", value: 70 }, { label: "T2", full: "2026 Term 2", value: 78 }, { label: "T3", full: "2026 Term 3", value: 81, partial: true }];
  const cols = C.columnChart(pts, { unit: "%", noun: "handed in", title: "Handed in by term", time: true, insight: true, line: { value: 75, label: "All grades" } });
  assert.equal((cols.match(/class="col-val"/g) || []).length, 4, "each column carries its value");
  assert.match(cols, /class="col is-partial"/);
  assert.match(text(cols), /2026 Term 3 isn't over yet/);
  assert.match(cols, /2026 Term 2: 78%, up from 70% in 2026 Term 1\./, "the sentence leaves the period under way out");
  assert.match(text(cols), /All grades: 75%/, "the line is named in the key");
  assert.match(cols, /role="img" aria-label="Handed in by term: 2025 Term 3 66%, 2026 Term 1 70%, 2026 Term 2 78%, 2026 Term 3 81% so far; All grades 75%"/);
  const drill = C.columnChart([{ label: "Sep", value: 4, drill: { month: "2026-09" } }, { label: "Oct", value: 2, drill: { month: "2026-10" } }], { drill: true, noun: "visits" });
  assert.match(drill, /<button type="button" class="col is-drill" data-drill=/, "a column that narrows the page is a button");
  assert.match(drill, /role="group"/);
  assert.match(C.columnChart([{ label: "A", value: 0 }], { empty: "None." }), /None\./, "all zero: said, not drawn");
});

test("each group against its line: paler when short of it, how far in words, the line named", () => {
  const rows = [{ label: "Aitong", value: 69 }, { label: "Chaka", value: 58 }, { label: "Sipili", value: 63 }, { label: "Ilkerin", value: 63 }];
  const b = C.bulletList(rows, { unit: "%", noun: "average mark", line: { value: 63, label: "All schools" }, insight: true });
  assert.match(text(b), /^3 of 4 at or above the all schools line\./);
  assert.equal((b.match(/bul-row is-under/g) || []).length, 1, "only Chaka is short of the line");
  assert.match(text(b), /Chaka 58% 5 pts below/);
  assert.match(text(b), /Sipili 63% on the line/);
  const close = C.bulletList([{ label: "Chaka", value: 62.6 }], { unit: "%", line: { value: 63.2, label: "All schools" } });
  assert.match(text(close), /Chaka 63% on the line/, "figures that read the same are on the line — never “0 pts below”");
  assert.doesNotMatch(close, /bul-row is-under/);
  assert.match(text(b), /All schools: 63%/);
  const own = C.bulletList([{ label: "A", value: 40, line: 50, lineLabel: "its target" }, { label: "B", value: 60, line: 50 }], { unit: "%", line: { label: "Each school's approved target" } });
  assert.match(text(own), /A 40% 10 pts below/);
  assert.match(text(own), /Each school(&#39;|')s approved target$/);
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

test("before and after: two dots per measure, the change in words, a measure with no earlier figure only where it is now", () => {
  const db = C.dumbbell([
    { label: "Learners taking part", before: 48, after: 62 },
    { label: "Schools supported", before: 21, after: 3 },
    { label: "Teachers using resources", before: null, after: 40 },
  ], { from: "Same point of Term 2", to: "Term 3 so far", title: "How the results moved" });
  assert.match(text(db), /Learners taking part 48% → 62% ▲ \+14 pts/);
  assert.match(text(db), /Schools supported 21% → 3% ▼ −18 pts/);
  assert.match(text(db), /Teachers using resources 40% no earlier figure/);
  assert.equal((db.match(/db-dot db-before/g) || []).length, 2, "no hollow dot without an earlier figure");
  assert.match(db, /db-change good/);
  assert.match(db, /db-change bad/);
  assert.match(text(db), /Same point of Term 2 Term 3 so far$/, "the key names both points");
  assert.match(C.dumbbell([], { empty: "Nothing yet." }), /Nothing yet/);
});

test("inside a key figure: a trend needs three points; the meter marks the target", () => {
  assert.equal(C.sparkline([60, 70]), "", "two points aren't a trend");
  const sp = C.sparkline([60, 70, 65, 80], { partial: true });
  assert.match(sp, /class="spark"/);
  assert.match(sp, /spk-partial/, "the period under way is open");
  assert.match(sp, /aria-hidden="true"/, "decoration: the card says the numbers");
  assert.equal(C.meter(null, 50), "");
  assert.match(C.meter(54, 80), /class="s-meter"/);
  assert.match(C.meter(90, 80), /s-meter is-met/);
});

test("a picture inside each result's card: each a different form, each saying what it shows", () => {
  const cols = C.miniColumns([{ label: "T1", full: "2026 Term 1", value: 36 }, { label: "T2", value: 83 }, { label: "T3", full: "2026 Term 3", value: 127, partial: true }], { noun: "learners" });
  assert.match(cols, /aria-label="2026 Term 1: 36, T2: 83, 2026 Term 3: 127 so far"/);
  assert.match(cols, /class="mc is-partial is-last"/);
  assert.equal(C.miniColumns([{ label: "T3", value: 5 }]), "", "one period isn't a trend");
  assert.match(C.ringGauge(62, { part: 79, whole: 127, noun: "learners", did: "took part" }), /aria-label="62%: 79 of 127 learners took part"/);
  const pg = C.pictogram(5, 13, { noun: "teachers", partWord: "trained" });
  assert.equal((pg.match(/pg-fig is-on/g) || []).length, 5);
  assert.equal((pg.match(/class="pg-fig/g) || []).length, 13, "one figure per teacher up to 20");
  const many = C.pictogram(30, 90, { noun: "teachers", partWord: "trained" });
  assert.equal((many.match(/class="pg-fig/g) || []).length, 18);
  assert.match(text(many), /each figure 5 teachers/);
  const ld = C.ladder([{ label: "Active teachers", value: 13 }, { label: "Used the portal", value: 11 }, { label: "Set work", value: 7, key: true }], { noun: "teachers" });
  assert.match(ld, /aria-label="Active teachers: 13, Used the portal: 11, Set work: 7"/);
  assert.match(ld, /ld-bar ld-2 is-key" style="width:53.8%"/);
  const grid = C.unitGrid([{ label: "Aitong", on: true }, { label: "Chaka", on: false }], { on: "visited", off: "not yet", noun: "schools" });
  assert.match(grid, /aria-label="1 of 2 schools visited"/);
  assert.match(C.halfGauge(54, { label: "opened one" }), /stroke-dasharray="54.0 100"/);
  assert.equal(C.halfGauge(null), "");
});

test("columns and a line: each in the key, the line on its own scale, a period under way paler", () => {
  const pts = [{ label: "Aug", values: { visits: 4 }, line: 10 }, { label: "Sep", values: { visits: 6 }, line: 30 }, { label: "Oct", values: { visits: 2 }, line: 12, partial: true }];
  const html = C.comboChart(pts, { bars: [{ key: "visits", label: "Field visits" }], line: { label: "Kobo submissions" }, title: "Field work" });
  assert.equal((html.match(/class="cmb-g/g) || []).length, 3);
  assert.match(text(html), /Field visits.*Kobo submissions \(right scale\)/);
  assert.match(html, /aria-label="Field work: Aug Field visits 4, Kobo submissions 10; Sep Field visits 6, Kobo submissions 30; Oct Field visits 2, Kobo submissions 12 so far"/);
  assert.match(html, /Oct isn't over yet/);
  assert.match(C.comboChart([], { bars: [{ key: "a", label: "A" }] }), /chart-empty/);
  // Two series side by side: the earlier one lighter, both in the key.
  const two = C.comboChart([{ label: "Learners", values: { before: 50, now: 60 } }], { bars: [{ key: "before", label: "Term 2" }, { key: "now", label: "Term 3" }], unit: "%" });
  assert.match(two, /cmb-col is-earlier/);
  assert.match(two, /key-sw is-earlier/);
  assert.ok(!/cmb-line/.test(two), "no line unless asked");
});

test("two measures per group: a dot each, the overall figures dashed, and how many sit below both", () => {
  const pts = [{ label: "A", x: 90, y: 70, base: 20 }, { label: "B", x: 40, y: 30, base: 20 }, { label: "C", x: 50, y: 80, base: 20 }, { label: "Tiny", x: 10, y: 10, base: 2 }];
  const html = C.scatter(pts, { xAxis: { label: "Work handed in", unit: "%" }, yAxis: { label: "Average mark", unit: "%" }, avg: { x: 60, y: 60 }, noun: "schools", insight: true });
  assert.equal((html.match(/class="sc-dot/g) || []).length, 4);
  assert.equal(insight(html), "1 of 3 schools are at or above both overall figures; 1 is below both.", "a school resting on fewer than 5 isn't counted");
  assert.match(html, /sc-dot is-low/);
  assert.match(html, /Work handed in across, Average mark up\. A 90%, 70%/);
  assert.match(C.scatter([], {}), /chart-empty/);
});
