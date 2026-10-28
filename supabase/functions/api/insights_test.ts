/**
 * The dashboards' findings (insights.ts) — hand-made figures and rows, no database.
 *
 *   cd supabase/functions/api
 *   deno test --config deno.json insights_test.ts
 */
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { buildInsights, formsOverdue, type Insight, type InsightInput, type MelRow, someOf, value } from "./insights.ts";
import type { ImpactInput } from "./impact.ts";

const NOW = new Date("2026-10-15T12:00:00Z");

/** Two schools in Narok, nothing else: each test adds what it needs. */
function rows(over: Partial<ImpactInput> = {}): ImpactInput {
  return {
    schools: [{ id: "s1", name: "Aitong", county: "Narok", code: "NRK-001" }, { id: "s2", name: "Olpusimoru", county: "Narok", code: "NRK-002" }],
    profiles: [], learners: [], enrollments: [], terms: [], classes: [], classTeachers: [], subjects: [],
    assignments: [], submissions: [], fieldReports: [], forms: [], responses: [],
    koboForms: [], koboSubmissions: [], koboRecords: [], koboIssues: [], libraryItems: [], libraryInteractions: [],
    bands: [], trainings: [], trainingAttendance: [],
    ...over,
  };
}

// deno-lint-ignore no-explicit-any
type Any = any;
const kpi = (key: string, label: string, value: number | null, before: number | null, base: number, unit = "percent"): Any => ({
  key, label, definition: "", value, unit, of: `of ${base}`, base, period: "2026 Term 3 so far",
  previous: { value: before, period: "the same point of 2026 Term 2" }, target: null, note: "", readout: "", caveat: "What it doesn't show.",
});
/** Programme results as admin_impact.ts gives them: Term 3 under way, against the same point of Term 2. */
function results(over: Any = {}): Any {
  return {
    period: { id: "2026-T3", label: "2026 Term 3", from: "2026-09-01", to: "2026-10-15", underway: true, day: 45, days: 122 },
    previous: { id: "2026-T2", label: "2026 Term 2", from: "2026-05-01", to: "2026-06-14" },
    kpis: [], targets: null, reach: [], marks: null, schools: [], schoolsTotal: 0, support: [],
    rules: { completionBelow: 50, minAssigned: 10, minMarked: 10, lowBands: [] },
    ...over,
  };
}
const school = (name: string, o: Any = {}) => ({ id: name, school: name, code: null, county: "Narok", learners: 10, teachers: 1, assigned: 0, completionRate: null, marked: 0, averagePercent: null, visits: 1, flags: [], ...o });
const run = (o: Partial<InsightInput> & { results: Any }) =>
  buildInsights({ input: rows(), place: {}, mel: null, schoolTargets: [], melReporting: null, now: NOW, ...o });
const byKey = (list: Insight[], key: string) => list.find((i) => i.key === key);
const ind = (o: Partial<MelRow> & { id: string }): MelRow => ({
  code: o.id.toUpperCase(), name: "Indicator", unit: "percent", direction: "increase", source: "manual", dashboardTheme: null,
  target: null, value: null, valueSource: "none", achievement: { percent: null, status: "no_data" }, baselineValue: null, baselinePeriod: null, history: [], ...o,
});
const MEL = (indicators: MelRow[], scope = { type: "programme", id: "", label: "Whole programme" }) => ({ period: { id: "2026-T3", label: "2026 Term 3" }, scope, indicators });

Deno.test("insights: a change on the term before only when it's big enough, on 5 or more", () => {
  const list = run({ results: results({ kpis: [
    kpi("participation", "Learners taking part", 62, 48, 40),
    kpi("teachers_digital", "Teachers teaching digitally", 33, 30, 20), // 3 points: not said
    kpi("teacher_resources", "Teachers using digital resources", 75, 25, 4), // only 4 teachers: not said
    kpi("teachers_trained", "Teachers trained", 12, 5, 20, "count"),
    kpi("schools_supported", "Schools supported", 40, 60, 10),
    kpi("assessment", "Average mark on marked classwork", 70, 50, 200), // classwork: never a change in learning
    kpi("learners", "Learners reached", 300, 100, 300, "count"),
  ] }) });
  const up = byKey(list, "change:participation")!;
  assertEquals(up.text, "Learners taking part: 62%, up from 48% at the same point of 2026 Term 2.");
  assertEquals([up.tone, up.measure, up.period], ["positive", "participation", "2026 Term 3 so far"]);
  assertEquals(up.note, "What it doesn't show.", "the figure's own caveat goes with it");
  assertEquals(up.card, true, "a card's own change: a page with the cards leaves it out");
  assertEquals(byKey(list, "change:teachers_trained")!.text, "Teachers trained: 12, up from 5 at the same point of 2026 Term 2.");
  const down = byKey(list, "change:schools_supported")!;
  assertEquals([down.tone, down.measure], ["attention", "implementation"]);
  for (const k of ["teachers_digital", "teacher_resources", "assessment", "learners"]) assertEquals(byKey(list, `change:${k}`), undefined, k);
  assert(list.indexOf(down) < list.indexOf(up), "a fall comes before a rise");
});

Deno.test("insights: progress against the approved targets — the place's own, with what each value is", () => {
  const list = run({ results: results(), mel: MEL([
    ind({ id: "r1", name: "Learners enrolled", unit: "count", target: { value: 1000, from: "scope" }, value: 720, valueSource: "verified", achievement: { percent: 72, status: "not_met" } }),
    ind({ id: "r2", name: "Schools visited", target: { value: 80, from: "scope" }, value: 90, valueSource: "live", source: "portal",
      achievement: { percent: 112.5, status: "met" }, basis: { n: 10, numerator: 9, denominator: 10 } }),
    ind({ id: "r3", name: "Teachers observed", target: { value: 50, from: "scope" }, value: null }),
    ind({ id: "r4", name: "No target", value: 30, valueSource: "recorded" }),
  ]) });
  const short = byKey(list, "target:r1")!;
  assertEquals(short.card, false, "no card carries this target here");
  assertEquals(short.text, "R1 Learners enrolled: 720 against an approved target of 1,000, 72% of the target.");
  assertEquals([short.tone, short.source, short.period], ["attention", "M&E indicator R1: verified actual", "2026 Term 3"]);
  const met = byKey(list, "target:r2")!;
  assertEquals(met.text, "R2 Schools visited: 90%, meeting its approved target of 80% (112.5% of the target).");
  assertEquals([met.tone, met.base], ["positive", "9 of 10"]);
  assertMatch(met.source, /worked out from the portal's records, not yet recorded/);
  assertEquals(byKey(list, "reporting:no-value")!.text, "1 of 3 indicators with an approved target for 2026 Term 3 has no value yet: R3 Teachers observed.");
  assertEquals(byKey(list, "target:r4"), undefined, "no target, no target finding");
  assert(list.indexOf(short) < list.indexOf(met), "short of a target before a target met");
});

Deno.test("insights: a county's or school's own target only — never the whole programme's against one place", () => {
  const scope = { type: "county", id: "Narok", label: "Narok County" };
  const list = run({ results: results(), mel: MEL([
    ind({ id: "r1", name: "Learners enrolled", unit: "count", target: { value: 1000, from: "scope" }, value: 720, valueSource: "recorded", achievement: { percent: 72, status: "not_met" } }),
    ind({ id: "r2", name: "Schools visited", target: { value: 80, from: "programme" }, value: 50, valueSource: "live", achievement: { percent: 62.5, status: "not_met" } }),
  ], scope) });
  assertEquals(byKey(list, "target:r1")!.text, "Narok County has achieved 72% of its approved target for R1 Learners enrolled (720 against 1,000).");
  assertEquals(byKey(list, "target:r2"), undefined, "the programme's target isn't Narok's");
});

Deno.test("insights: schools against their own targets — results available, met, and the furthest from it", () => {
  const rowsOf = (vals: (number | null)[]) => vals.map((v, i) => ({
    schoolId: `s${i}`, school: `School ${String.fromCharCode(65 + i)}`, target: 50, value: v,
    percent: v == null ? null : Math.round((v / 50) * 1000) / 10, status: v == null ? "no_data" : v >= 50 ? "met" : v >= 40 ? "close" : "not_met",
  }));
  const list = run({ results: results(), schoolTargets: [{ indicator: { id: "l1", code: "L1", name: "Reading at grade level", unit: "percent", dashboardTheme: "learning" },
    rows: rowsOf([60, 26, 55, 45, null, null]) }] });
  const cover = byKey(list, "reporting:school-targets:l1")!;
  assertEquals(cover.text, "Assessment results are available for 4 of 6 schools with an approved target for L1 Reading at grade level.");
  assertEquals([cover.base, cover.measure], ["No results yet: School E and School F", "learning"]);
  assertEquals(byKey(list, "schools:target:l1")!.text,
    "2 of 4 schools with results have met their approved target for L1 Reading at grade level; furthest from it: School B, at 52% of its target.");
  const one = run({ results: results(), schoolTargets: [{ indicator: { id: "r1", code: "R1", name: "Learners enrolled", unit: "count", dashboardTheme: "reach" },
    rows: [{ schoolId: "a", school: "School A", target: 100, value: 72, percent: 72, status: "not_met" }] }] });
  assertEquals(byKey(one, "schools:target:r1")!.text, "School A has achieved 72% of its approved target for R1 Learners enrolled (72 against 100).");
});

Deno.test("insights: schools apart on work handed in — only 3 or more with enough set, only a real gap", () => {
  const three = run({ results: results({ schools: [
    school("Aitong", { assigned: 40, completionRate: 91 }), school("Chaka", { assigned: 12, completionRate: 23 }),
    school("Sipili", { assigned: 30, completionRate: 60 }), school("Tiny", { assigned: 4, completionRate: 0 }),
  ] }) });
  const s = byKey(three, "schools:completion")!;
  assertEquals(s.text, "Work handed in ranges from 23% at Chaka to 91% at Aitong.");
  assertEquals(s.base, "3 schools with 10 or more pieces of work set", "a school with 4 pieces set is left out");
  assertEquals(s.note, "Handing work in is taking part, not a learning result.");
  const two = run({ results: results({ schools: [school("A", { assigned: 40, completionRate: 91 }), school("B", { assigned: 40, completionRate: 23 })] }) });
  assertEquals(byKey(two, "schools:completion"), undefined, "two schools aren't a spread");
  const close = run({ results: results({ schools: ["A", "B", "C"].map((n, i) => school(n, { assigned: 20, completionRate: 60 + i * 5 })) }) });
  assertEquals(byKey(close, "schools:completion"), undefined, "10 points apart: not said");
});

Deno.test("insights: gaps between what's expected and what the records show", () => {
  const list = run({ results: results({
    schools: [school("Aitong", { visits: 2 }), school("Chaka", { visits: 0 }), school("Sipili", { visits: 0, teachers: 0 })],
    support: [{ rule: "No active teacher", count: 1, schools: ["Sipili"] }, { rule: "No work set", count: 2, schools: ["Chaka", "Sipili"] }],
  }) });
  assertEquals(byKey(list, "gap:not-visited")!.text, "2 of 3 schools have had no field visit in 2026 Term 3 so far.");
  assertEquals(byKey(list, "gap:not-visited")!.note, "Day 45 of 122 of the term.");
  assertEquals(byKey(list, "gap:no-work")!.text, "2 of 3 schools with learners have had no work set on the portal in 2026 Term 3 so far.");
  assertEquals(byKey(list, "gap:no-teacher")!.text, "1 school with learners on roll has no active teacher account.");
  assertEquals(byKey(list, "gap:not-visited")!.links[0].page, "field-visits", "each gap leads to the page that deals with it");
});

Deno.test("insights: forms overdue — a head's form by school, a teacher's by person, only once due", () => {
  const people = [
    { id: "h1", role: "school_leader", status: "active", school_id: "s1", county: "Narok" },
    { id: "h2", role: "school_leader", status: "active", school_id: "s2", county: "Narok" },
    ...["t1", "t2", "t3", "t4", "t5"].map((id) => ({ id, role: "teacher", status: "active", school_id: "s1", county: "Narok" })),
    { id: "t6", role: "teacher", status: "suspended", school_id: "s1", county: "Narok" },
  ];
  const input = rows({
    profiles: people,
    forms: [
      { id: "f1", title: "Term return", audience: "school_leader", due_on: "2026-10-01" },
      { id: "f2", title: "Teacher survey", audience: "teacher", due_on: "2026-10-10" },
      { id: "f3", title: "Not due yet", audience: "teacher", due_on: "2026-10-20" },
      { id: "f4", title: "Archived", audience: "teacher", due_on: "2026-10-01", archived_at: "2026-10-02" },
      { id: "f5", title: "Visit form", audience: "field_officer", visit_type: "Learning", due_on: "2026-10-01" },
      { id: "f6", title: "Long ago", audience: "teacher", due_on: "2026-02-01" },
      { id: "f7", title: "Meru only", audience: "teacher", county: "Meru", due_on: "2026-10-01" },
    ],
    responses: [{ form_id: "f1", respondent_id: "h1" }, { form_id: "f2", respondent_id: "t1" }, { form_id: "f2", respondent_id: "t2" }],
  });
  const list = run({ results: results(), input });
  const heads = byKey(list, "reporting:form:f1")!;
  assertEquals(heads.text, "1 of 2 schools hasn't sent “Term return”, due 1 Oct 2026.");
  assertEquals([heads.base, heads.note], ["Not sent: Olpusimoru · of the schools with an active head", "The portal already reminds each of them."]);
  assertEquals(byKey(list, "reporting:form:f2")!.text, "3 of 5 teachers haven't answered “Teacher survey”, due 10 Oct 2026.", "a suspended teacher isn't expected to answer");
  for (const f of ["f3", "f4", "f5", "f6", "f7"]) assertEquals(byKey(list, `reporting:form:${f}`), undefined, f);
  assertEquals(formsOverdue(input, { school: "Aitong" }, "2026-05-01", "2026-10-15").map((f) => [f.id, f.expected, f.missing.length]), [["f2", 5, 3]],
    "narrowed to Aitong, whose head has answered");
});

Deno.test("insights: visits filed without all their forms, this term", () => {
  const input = rows({
    forms: [{ id: "vf", title: "Learning visit", audience: "field_officer", visit_type: "Learning", created_at: "2026-01-01T00:00:00Z" }],
    fieldReports: [
      { id: "v1", school_id: "s1", school: "Aitong", county: "Narok", visit_type: "Learning", created_at: "2026-09-10T08:00:00Z" },
      { id: "v2", school_id: "s2", school: "Olpusimoru", county: "Narok", visit_type: "Learning", created_at: "2026-09-12T08:00:00Z" },
      { id: "v3", school_id: "s2", school: "Olpusimoru", county: "Narok", visit_type: "Learning", created_at: "2026-06-12T08:00:00Z" },
    ],
    responses: [{ form_id: "vf", respondent_id: "fo", visit_id: "v1" }],
  });
  const v = byKey(run({ results: results(), input }), "reporting:visit-forms")!;
  assertEquals(v.text, "1 of 2 field visits in 2026 Term 3 so far was filed without all its forms.");
  assertEquals(v.base, "Olpusimoru");
});

Deno.test("insights: M&E reporting for the term that ended — actuals missing, waiting to be verified, the report", () => {
  const period = { id: "2026-T2", label: "2026 Term 2" };
  const list = run({ results: results(), melReporting: { period, withTarget: 3, missing: [{ code: "R1", name: "Learners" }, { code: "R3", name: "Visits" }], unverified: 1, report: "draft" } });
  assertEquals(byKey(list, "reporting:actuals")!.text, "2026 Term 2 has ended, and 2 of 3 indicators with an approved target have no recorded actual.");
  assertEquals(byKey(list, "reporting:actuals")!.base, "R1 Learners and R3 Visits");
  assertEquals(byKey(list, "reporting:unverified")!.text, "1 recorded actual for 2026 Term 2 is waiting to be verified.");
  assertEquals(byKey(list, "reporting:report")!.text, "The 2026 Term 2 M&E report is still a draft.");
  const never = run({ results: results(), melReporting: { period, withTarget: 0, missing: [], unverified: 0, report: null } });
  assertEquals(never.filter((i) => i.kind === "reporting"), [], "no reports ever made: none expected");
  assertEquals(byKey(run({ results: results(), melReporting: { period, withTarget: 0, missing: [], unverified: 0, report: "none" } }), "reporting:report")!.text,
    "No M&E report has been made for 2026 Term 2 yet.");
});

Deno.test("insights: baseline to follow-up, from recorded values only — and said plainly when there's none for learning", () => {
  const list = run({ results: results(), mel: MEL([
    ind({ id: "l1", name: "Reading at grade level", dashboardTheme: "learning", baselineValue: 34, baselinePeriod: "2025",
      history: [{ period: "2026-T2", label: "2026 Term 2", value: 41, status: "verified" }] }),
    ind({ id: "t1", name: "Teachers using ICT", dashboardTheme: "teacher_development",
      history: [{ period: "2026-T1", label: "2026 Term 1", value: 40, status: "verified" }, { period: "2026-T2", label: "2026 Term 2", value: 52, status: "recorded" }] }),
  ]) });
  const b = byKey(list, "baseline:l1")!;
  assertEquals(b.text, "L1 Reading at grade level: 41% in 2026 Term 2, from 34% at baseline (2025): up 7 points.");
  assertEquals([b.measure, b.area, b.tone, b.period], ["learning", "learning", "positive", "2025 to 2026 Term 2"]);
  assertEquals(b.note, "The same indicator at both points; this alone doesn't show what caused the change.");
  const c = byKey(list, "change:mel:t1")!;
  assertEquals(c.text, "T1 Teachers using ICT: 52% in 2026 Term 2, up from 40% in 2026 Term 1.");
  assertEquals([c.measure, c.note], ["skills", "Not every value here is verified yet."]);
  assertEquals(byKey(list, "evidence:learning"), undefined, "there is a learning baseline");

  const none = run({ results: results(), mel: MEL([ind({ id: "x", name: "Something" })]) });
  assertEquals(byKey(none, "evidence:learning")!.text, "No learning assessment has both a baseline and a follow-up result yet, so no change in learning outcomes can be reported.");
  assertEquals(byKey(run({ results: results() }), "evidence:learning"), undefined, "without M&E read, it isn't known: nothing said");
  const county = run({ results: results(), mel: MEL([ind({ id: "l1", name: "Reading", dashboardTheme: "learning", baselineValue: 34, baselinePeriod: "2025",
    history: [{ period: "2026-T2", label: "2026 Term 2", value: 20, status: "verified" }] })], { type: "county", id: "Narok", label: "Narok County" }) });
  assertEquals(county.filter((i) => i.kind === "baseline" || i.kind === "evidence"), [], "the programme's baseline is never set against one county");
});

Deno.test("insights: every finding has a period and a source, says no cause, and comes in order", () => {
  const list = run({
    results: results({
      kpis: [kpi("participation", "Learners taking part", 62, 48, 40), kpi("schools_supported", "Schools supported", 40, 60, 10)],
      schools: [school("A", { assigned: 40, completionRate: 91, visits: 0 }), school("B", { assigned: 40, completionRate: 23 }), school("C", { assigned: 40, completionRate: 50 })],
      support: [{ rule: "No work set", count: 1, schools: ["A"] }],
    }),
    mel: MEL([ind({ id: "r1", name: "Learners", unit: "count", target: { value: 10, from: "scope" }, value: 5, valueSource: "recorded", achievement: { percent: 50, status: "not_met" } })]),
    melReporting: { period: { id: "2026-T2", label: "2026 Term 2" }, withTarget: 1, missing: [{ code: "R1", name: "Learners" }], unverified: 0, report: "none" },
  });
  assert(list.length >= 6);
  for (const i of list) {
    assert(i.period && i.source && i.text, i.key);
    assert(!/\b(because|due to|caused by|led to|thanks to|as a result|improved learning|impact of)\b/i.test(`${i.text} ${i.note}`), `no cause: ${i.text}`);
    assert(!/undefined|NaN|null/.test(`${i.text} ${i.base} ${i.period}`), `no holes: ${i.text}`);
    assert(i.links.every((l) => l.page && l.label), i.key);
  }
  assertEquals(list.map((i) => i.rank), [...list.map((i) => i.rank)].sort((a, b) => a - b));
});

Deno.test("insights: the small wording helpers", () => {
  assertEquals(someOf(["A"]), "A");
  assertEquals(someOf(["A", "B"]), "A and B");
  assertEquals(someOf(["A", "B", "C", "D", "E"]), "A, B, C and 2 more");
  assertEquals([value(41.6, "percent"), value(60, "percent"), value(1234, "count"), value(2.345, "number"), value(null, "count")], ["41.6%", "60%", "1,234", "2.3", "no value"]);
});

Deno.test("insights: the Education Team's follow-ups — teachers with no training this year, work waiting for a mark, resources never opened", () => {
  const input = rows({
    terms: [{ id: "2026-T2", academic_year_id: "2026", starts_on: "2026-05-01", ends_on: "2026-08-31" }, { id: "2026-T3", academic_year_id: "2026", starts_on: "2026-09-01", ends_on: "2026-12-31" }],
    profiles: [
      { id: "t1", role: "teacher", status: "active", school_id: "s1" }, { id: "t2", role: "teacher", status: "active", school_id: "s1" },
      { id: "t3", role: "teacher", status: "active", school_id: "s2" }, { id: "t4", role: "teacher", status: "deactivated", school_id: "s2" },
    ],
    trainings: [{ id: "tr", held_on: "2026-06-01", archived_at: null }, { id: "old", held_on: "2025-06-01", archived_at: null }],
    trainingAttendance: [{ training_id: "tr", teacher_id: "t1", attended: true }, { training_id: "old", teacher_id: "t2", attended: true }, { training_id: "tr", teacher_id: "t3", attended: false }],
    assignments: [{ id: "a1", school_id: "s1" }],
    submissions: [
      { id: "x1", assignment_id: "a1", status: "submitted", submitted_at: "2026-09-20T08:00:00Z" },
      { id: "x2", assignment_id: "a1", status: "submitted", submitted_at: "2026-10-10T08:00:00Z" }, // under 14 days
      { id: "x3", assignment_id: "a1", status: "marked", submitted_at: "2026-09-01T08:00:00Z" },
    ],
    libraryItems: [{ id: "b1", title: "Fractions", published: true }, { id: "b2", title: "Phonics", published: true }, { id: "b3", title: "Draft", published: false }],
    libraryInteractions: [{ library_item_id: "b1", hpf: false, school: "Aitong" }, { library_item_id: "b2", hpf: true, school: "HPF" }],
  });
  const list = buildInsights({ results: results(), input, place: {}, mel: null, schoolTargets: [], melReporting: null, now: NOW });
  const untrained = byKey(list, "gap:untrained")!;
  assertEquals(untrained.text, "2 of 3 active teachers have attended no training session this school year.", "last year's session and a taken-off-the-list one don't count");
  assertEquals([untrained.base, untrained.area, untrained.links[0].page], ["Aitong (1) and Olpusimoru (1)", "teachers", "training"]);
  assertEquals(byKey(list, "gap:unmarked")!.text, "1 piece of handed-in work has waited more than 14 days for a mark.");
  const unopened = byKey(list, "gap:unopened")!;
  assertEquals(unopened.text, "1 of 2 published resources has never been opened.", "HPF staff checking Phonics isn't use; the draft isn't published");
  assertEquals(unopened.base, "Phonics");
  const noRegister = buildInsights({ results: results(), input: { ...input, trainings: [] }, place: {}, mel: null, schoolTargets: [], melReporting: null, now: NOW });
  assertEquals(byKey(noRegister, "gap:untrained"), undefined, "no register in use: nothing said about who wasn't trained");
});
