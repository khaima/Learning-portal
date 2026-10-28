/**
 * The Administration overview's programme results (admin_impact.ts) — small
 * hand-made rows, no database.
 *
 *   cd supabase/functions/api
 *   deno test --config deno.json admin_impact_test.ts
 */
import { assertEquals } from "jsr:@std/assert@1";
import { buildAdminResults, readout, shareWords } from "./admin_impact.ts";
import type { ImpactInput } from "./impact.ts";

const NOW = new Date("2026-10-15T12:00:00Z");
const T2 = { id: "2026-T2", label: "2026 Term 2", from: "2026-05-01", to: "2026-08-31" };
const T3 = { id: "2026-T3", label: "2026 Term 3", from: "2026-09-01", to: "2026-12-31" };
const BANDS = [
  { code: "EE", label: "Exceeding", minPercent: 80 },
  { code: "ME", label: "Meeting", minPercent: 50 },
  { code: "AE", label: "Approaching", minPercent: 30 },
  { code: "BE", label: "Below", minPercent: 0 },
];

/** Aitong (two teachers, two learners) and Olpusimoru (one learner, no teacher), both in Narok. */
function world(over: Partial<ImpactInput> = {}): ImpactInput {
  return {
    schools: [
      { id: "s1", name: "Aitong", county: "Narok", code: "NRK-001" },
      { id: "s2", name: "Olpusimoru", county: "Narok", code: "NRK-002" },
    ],
    profiles: [
      { id: "t1", role: "teacher", status: "active", school_id: "s1", county: "Narok" },
      { id: "t2", role: "teacher", status: "active", school_id: "s1", county: "Narok" },
      { id: "fo", role: "field_officer", status: "active", school_id: null, county: "Narok" },
    ],
    learners: [
      { id: "l1", school_id: "s1", class_id: "c1", grade: "Grade 4", enrollment_status: "ACTIVE" },
      { id: "l2", school_id: "s1", class_id: "c1", grade: "Grade 4", enrollment_status: "ACTIVE" },
      { id: "l3", school_id: "s2", class_id: null, grade: "Grade 4", enrollment_status: "ACTIVE" },
    ],
    enrollments: [],
    terms: [
      { id: "2026-T2", academic_year_id: "2026", term_no: 2, starts_on: T2.from, ends_on: T2.to },
      { id: "2026-T3", academic_year_id: "2026", term_no: 3, starts_on: T3.from, ends_on: T3.to },
    ],
    classes: [{ id: "c1", school_id: "s1", academic_year_id: "2026", grade: "Grade 4", archived_at: null }],
    classTeachers: [],
    subjects: [{ id: "maths", name: "Mathematics" }],
    assignments: [], submissions: [], fieldReports: [], forms: [], responses: [],
    koboForms: [], koboSubmissions: [], koboRecords: [], koboIssues: [],
    libraryItems: [], libraryInteractions: [],
    bands: BANDS,
    trainings: [], trainingAttendance: [],
    ...over,
  };
}

const visit = (id: string, school: string, name: string, at: string) =>
  ({ id, school_id: school, school: name, county: "Narok", visit_type: "Learning", officer_id: "fo", created_at: `${at}T08:00:00Z` });
const kpi = (r: ReturnType<typeof buildAdminResults>, key: string) => r.kpis.find((k) => k.key === key)!;
const TERMS = { current: T3, previous: T2 };

Deno.test("admin results: no data is null, a real zero is 0", () => {
  const r = buildAdminResults(world(), TERMS, null, NOW);
  assertEquals(kpi(r, "teachers_trained").value, null, "no sessions in the register: no data");
  assertEquals(kpi(r, "assessment").value, null, "nothing marked: no data");
  assertEquals(kpi(r, "schools_supported").value, 0, "two schools, none visited: a real 0%");
  assertEquals(kpi(r, "learners").value, 3);
  assertEquals(kpi(r, "learners").previous, null, "the roll today isn't compared with a term ago");
  assertEquals(r.kpis.every((k) => k.target === null), true, "no M&E targets read: none shown");
  assertEquals(r.targets, null);
});

Deno.test("admin results: the term before is cut to the same point", () => {
  const r = buildAdminResults(world({
    fieldReports: [visit("v1", "s1", "Aitong", "2026-09-10"), visit("v2", "s1", "Aitong", "2026-05-20"), visit("v3", "s2", "Olpusimoru", "2026-08-01")],
  }), TERMS, null, NOW);
  assertEquals(r.period.underway, true);
  assertEquals(r.previous?.to, "2026-06-14", "44 days into Term 3, so 44 days into Term 2");
  const s = kpi(r, "schools_supported");
  assertEquals(s.value, 50);
  assertEquals(s.previous, { value: 50, period: "the same point of 2026 Term 2" }, "the August visit is after the same point");
});

Deno.test("admin results: a target only where M&E approved one for the same measure and unit", () => {
  const mel = {
    summary: { met: 0, close: 0, not_met: 1, no_data: 1 },
    indicators: [
      { source: "portal", sourceConfig: { metric: "schools_visited", visitType: "ICT" }, unit: "percent", direction: "increase", code: "1.1", name: "ICT visits", target: { value: 100 } },
      { source: "portal", sourceConfig: { metric: "schools_visited" }, unit: "percent", direction: "increase", code: "1.2", name: "Schools visited", target: { value: 80 } },
      { source: "portal", sourceConfig: { metric: "learners_enrolled" }, unit: "percent", direction: "increase", code: "2.1", name: "Wrong unit", target: { value: 10 } },
      { source: "manual", sourceConfig: {}, unit: "count", direction: "increase", code: "3.1", name: "Manual", target: null },
    ],
  };
  const r = buildAdminResults(world({ fieldReports: [visit("v1", "s1", "Aitong", "2026-09-10")] }), TERMS, mel, NOW);
  assertEquals(kpi(r, "schools_supported").target, { value: 80, indicator: "1.2 Schools visited", percent: 62.5, status: "not_met" });
  assertEquals(kpi(r, "learners").target, null, "a percent target can't apply to a count");
  assertEquals([r.targets?.summary, r.targets?.indicators], [mel.summary, 4]);
  // Every indicator against its target, for the overview's picture: a missing value or target is null, never 0.
  assertEquals(r.targets?.rows.map((x) => [x.code, x.target, x.value]), [["1.1", 100, null], ["1.2", 80, null], ["2.1", 10, null], ["3.1", null, null]]);
});

Deno.test("admin results: the overview's pictures — reach by county and the marks spread — from the same figures as the cards", () => {
  const r = buildAdminResults(world({ fieldReports: [visit("v1", "s1", "Aitong", "2026-09-10")] }), TERMS, null, NOW);
  const learners = kpi(r, "learners").value;
  assertEquals(r.reach.reduce((t, c) => t + c.learners, 0), learners, "the counties add up to the learners card");
  assertEquals(r.reach.reduce((t, c) => t + c.schools, 0), r.schoolsTotal, "every school is in one county");
  assertEquals(Array.isArray(r.marks?.bins) && Array.isArray(r.marks?.bands), true);
});

Deno.test("admin results: schools needing support, the most rules first", () => {
  const r = buildAdminResults(world({ fieldReports: [visit("v1", "s1", "Aitong", "2026-09-10")] }), TERMS, null, NOW);
  assertEquals(r.schools.map((s) => [s.school, s.flags]), [
    ["Olpusimoru", ["No active teacher", "No work set", "Not visited"]],
    ["Aitong", ["No work set"]],
  ]);
  assertEquals(r.support.map((x) => [x.rule, x.count]), [["No active teacher", 1], ["No work set", 2], ["Not visited", 1]]);
});

Deno.test("admin results: teachers trained, from the register", () => {
  const r = buildAdminResults(world({
    trainings: [{ id: "tr1", title: "ICT in the classroom", kind: "workshop", held_on: "2026-09-10", ends_on: null, county: "Narok", school_id: null, archived_at: null }],
    trainingAttendance: [{ training_id: "tr1", teacher_id: "t1", attended: true }],
  }), TERMS, null, NOW);
  const t = kpi(r, "teachers_trained");
  assertEquals([t.value, t.previous?.value], [1, 0], "the register has sessions, so none by the same point of Term 2 is a real 0");
});

Deno.test("admin results: share words are honest at the edges", () => {
  assertEquals(shareWords(0, "schools"), "None of the schools");
  assertEquals(shareWords(24.9, "schools"), "Fewer than 1 in 4 schools");
  assertEquals(shareWords(50, "schools"), "Half of the schools", "exactly half isn't over half");
  assertEquals(shareWords(50.1, "schools"), "Over half of the schools");
  assertEquals(shareWords(99.9, "schools"), "Most schools", "only 100 is all");
  assertEquals(shareWords(100, "schools"), "All the schools");
});

Deno.test("admin results: a readout only from the figure in front of it", () => {
  const share = { value: 40, base: 20, who: "active teachers", did: "set work on the portal" };
  const k = { value: 40, unit: "percent" as const, target: null, note: "" };
  assertEquals(readout(k, share), "Under half of the active teachers set work on the portal.");
  assertEquals(readout({ ...k, value: null }, share), "", "no data: nothing to read");
  assertEquals(readout({ ...k, note: "Too few to judge." }, share), "", "a warning stands alone");
  assertEquals(readout(k, { ...share, base: 4 }), "", "a share of fewer than five isn't put into words");
  assertEquals(readout({ ...k, target: { value: 60, indicator: "1.1", percent: 66.7, status: "not_met" } }, share),
    "Under half of the active teachers set work on the portal. Short of the approved target, by 20 points.");
  assertEquals(readout({ ...k, value: 52, target: { value: 60, indicator: "1.1", percent: 86.7, status: "close" } }),
    "Close to the approved target, by 8 points.");
  assertEquals(readout({ value: 120, unit: "count", note: "", target: { value: 100, indicator: "2.1", percent: 120, status: "met" } }),
    "The approved target is met.");
});

Deno.test("admin results: the cards carry readouts, never on missing data", () => {
  const r = buildAdminResults(world({ fieldReports: [visit("v1", "s1", "Aitong", "2026-09-10")] }), TERMS, null, NOW);
  assertEquals(kpi(r, "schools_supported").readout, "", "two schools: too few to put a share into words");
  assertEquals(kpi(r, "teachers_trained").readout, "", "no register: no data, no reading");
  assertEquals(kpi(r, "assessment").readout, "", "nothing marked: no reading");
  assertEquals(r.kpis.every((k) => !/improv|because|led to|caused/i.test(k.readout)), true, "no causal or learning claims");
});
