/**
 * Data accuracy: representative records — the kinds found in production on
 * 28 October 2026 — through the dashboards' calculations, each figure checked
 * against a count taken straight from the rows (docs/KPI-DEFINITIONS.md).
 *
 *   cd supabase/functions/api
 *   deno test --config deno.json data_accuracy_test.ts
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { buildAdminResults } from "./admin_impact.ts";
import { buildImpact, type ImpactInput } from "./impact.ts";
import { buildIntelligence } from "./intelligence.ts";
import { buildLibraryUsage } from "./library_usage.ts";
import { prepareReadings } from "./readings.ts";

const NOW = new Date("2026-10-15T12:00:00Z");
const T2 = { id: "2026-T2", label: "2026 Term 2", from: "2026-05-01", to: "2026-08-31" };
const T3 = { id: "2026-T3", label: "2026 Term 3", from: "2026-09-01", to: "2026-12-31" };
const at = (d: string) => `${d}T08:00:00Z`;

const SCHOOLS = [
  { id: "s1", name: "Aitong", county: "Narok", code: "NRK-001" },
  { id: "s2", name: "Olesere", county: "Narok", code: "NRK-012" },
  { id: "s3", name: "Kianda", county: "Meru", code: "MRU-007" },
];
const PROFILES = [
  { id: "t1", role: "teacher", status: "active", school_id: "s1", county: "Narok" },
  { id: "t2", role: "teacher", status: "active", school_id: "s2", county: "Narok" },
  { id: "t3", role: "teacher", status: "active", school_id: "s3", county: "Meru" },
  { id: "t4", role: "teacher", status: "deactivated", school_id: "s1", county: "Narok" },
  { id: "h1", role: "school_leader", status: "active", school_id: "s1", county: "Narok" },
  { id: "fo1", role: "field_officer", status: "active", school_id: null, county: "Narok" },
  { id: "fo2", role: "field_officer", status: "deactivated", school_id: null, county: "Narok" },
  { id: "ed1", role: "education_team", status: "active", school_id: null, county: null },
  { id: "sa1", role: "super_admin", status: "active", school_id: null, county: null },
];
const LEARNERS = [
  { id: "l1", school_id: "s1", class_id: "c1", grade: "Grade 4", enrollment_status: "ACTIVE" },
  { id: "l2", school_id: "s1", class_id: "c1", grade: "Grade 4", enrollment_status: "ACTIVE" },
  { id: "l3", school_id: "s2", class_id: null, grade: "Grade 5", enrollment_status: "ACTIVE" },
  { id: "l4", school_id: "s3", class_id: null, grade: "Grade 4", enrollment_status: "ACTIVE" },
  { id: "l5", school_id: "s1", class_id: null, grade: "Grade 4", enrollment_status: "TRANSFERRED" },
];
/** Library opens as recorded: one under a stale name ("meru"), HPF staff's (one recorded under their old role), one with no time. */
const OPENS = [
  { id: "o1", library_item_id: "b1", actor_kind: "learner", actor_id: "l3", role: "learner", school: "meru", started_at: at("2026-09-10"), duration_seconds: 600 },
  { id: "o2", library_item_id: "b1", actor_kind: "learner", actor_id: "l3", role: "learner", school: "Olesere", started_at: at("2026-09-11"), duration_seconds: 300 },
  { id: "o3", library_item_id: "b2", actor_kind: "staff", actor_id: "t1", role: "teacher", school: "Aitong", started_at: at("2026-09-12"), duration_seconds: 120 },
  { id: "o4", library_item_id: "b2", actor_kind: "staff", actor_id: "t3", role: "teacher", school: "Kianda", started_at: at("2026-09-13"), duration_seconds: null },
  { id: "o5", library_item_id: "b1", actor_kind: "staff", actor_id: "ed1", role: "education_team", school: "HPF", started_at: at("2026-09-14"), duration_seconds: 60 },
  { id: "o6", library_item_id: "b1", actor_kind: "staff", actor_id: "sa1", role: "education_team", school: "HPF", started_at: at("2026-09-15"), duration_seconds: 60 },
  { id: "o7", library_item_id: "b2", actor_kind: "learner", actor_id: "l1", role: "learner", school: "Aitong", started_at: at("2026-09-16"), duration_seconds: 900 },
];

function world(over: Partial<ImpactInput> = {}): ImpactInput {
  return {
    schools: SCHOOLS, profiles: PROFILES, learners: LEARNERS, enrollments: [],
    terms: [
      { id: "2026-T2", academic_year_id: "2026", term_no: 2, starts_on: T2.from, ends_on: T2.to },
      { id: "2026-T3", academic_year_id: "2026", term_no: 3, starts_on: T3.from, ends_on: T3.to },
    ],
    classes: [{ id: "c1", school_id: "s1", academic_year_id: "2026", grade: "Grade 4", archived_at: null }],
    classTeachers: [], subjects: [], assignments: [], submissions: [],
    fieldReports: [
      { id: "v1", school_id: "s1", school: "Aitong", county: "Narok", visit_type: "Learning", officer_id: "fo1", created_at: at("2026-09-09") },
      { id: "v2", school_id: "s1", school: "Aitong", county: "Narok", visit_type: "ICT", officer_id: "fo2", created_at: at("2026-09-20") },
      { id: "v3", school_id: null, school: "Narok Grace Primary", county: "Narok", visit_type: "Learning", officer_id: "fo1", created_at: at("2026-09-14") },
    ],
    forms: [{ id: "f1", title: "Teacher survey", audience: "teacher", county: null, visit_type: null, archived_at: null }],
    responses: [
      { id: "r1", form_id: "f1", respondent_id: "t1", respondent_role: "teacher", submitted_at: at("2026-09-20") },
      { id: "r2", form_id: "f1", respondent_id: "t3", respondent_role: "teacher", submitted_at: at("2026-09-21") },
      { id: "r3", form_id: "f1", respondent_id: "t4", respondent_role: "teacher", submitted_at: at("2026-09-22") },
    ],
    koboForms: [{ id: "k1", title: "Classroom observation", active: true, synced_at: at("2026-10-15"), last_sync_error: "KoboToolbox rejected the API token" }],
    koboSubmissions: [],
    koboRecords: [
      { id: "kr1", kobo_form_id: "k1", status: "valid", review: null, school_id: "s1", county: "Narok", submitted_at: at("2026-09-10") },
      { id: "kr2", kobo_form_id: "k1", status: "valid", review: null, school_id: null, county: null, submitted_at: at("2026-09-11") },
      { id: "kr3", kobo_form_id: "k1", status: "invalid", review: null, school_id: null, county: null, submitted_at: at("2026-09-12") },
    ],
    koboIssues: [],
    libraryItems: [{ id: "b1", title: "Fractions", audience: "library", published: true }, { id: "b2", title: "Lesson guide", audience: "staff", published: true }],
    // As the API loads them (index.ts): attributed and HPF staff marked.
    libraryInteractions: prepareReadings(OPENS, SCHOOLS, [...PROFILES, ...LEARNERS]),
    bands: [{ code: "ME", label: "Meeting", minPercent: 50 }, { code: "BE", label: "Below", minPercent: 0 }],
    trainings: [{ id: "tr1", title: "Cluster", kind: "cluster", held_on: "2026-10-07", county: "Narok", school_id: null, archived_at: "2026-10-08T00:00:00Z" }],
    trainingAttendance: [{ training_id: "tr1", teacher_id: "t1", attended: true }],
    ...over,
  };
}
const TERM = { from: T3.from, to: "2026-10-15" };

Deno.test("accuracy: unique learners and teachers — active only, and the counties add up to the whole", () => {
  const all = buildImpact(world(), TERM, NOW);
  const activeLearners = LEARNERS.filter((l) => l.enrollment_status === "ACTIVE").length;
  const activeTeachers = PROFILES.filter((p) => p.role === "teacher" && p.status === "active").length;
  assertEquals(all.executive.learners, activeLearners, "a transferred learner isn't on roll");
  assertEquals(all.executive.teachers, activeTeachers, "a deactivated teacher isn't counted");
  const narok = buildImpact(world(), { ...TERM, county: "Narok" }, NOW), meru = buildImpact(world(), { ...TERM, county: "Meru" }, NOW);
  assertEquals(narok.executive.learners + meru.executive.learners, all.executive.learners);
  assertEquals(narok.executive.teachers + meru.executive.teachers, all.executive.teachers);
  assertEquals(all.reach.learnersByCounty.reduce((t, c) => t + c.value, 0), activeLearners);
  assertEquals(all.executive.schools, SCHOOLS.length);
});

Deno.test("accuracy: library opens — a stale school name counted at the reader's school; HPF staff never counted", () => {
  const programme = OPENS.filter((o) => !["ed1", "sa1"].includes(o.actor_id));
  const all = buildImpact(world(), TERM, NOW);
  assertEquals(all.resources.opens, programme.length);
  assertEquals(all.resources.hpf.opens, 2, "including the open recorded as education_team by someone now a super admin");
  const narok = buildImpact(world(), { ...TERM, county: "Narok" }, NOW).resources.opens;
  const meru = buildImpact(world(), { ...TERM, county: "Meru" }, NOW).resources.opens;
  assertEquals(narok + meru, all.resources.opens, "every programme open is in exactly one county");
  assertEquals(narok, 4, "the open recorded under “meru” is Olesere's (Narok)");
  // Without the attribution, it fell out of every county's view.
  const raw = buildImpact(world({ libraryInteractions: OPENS.map((o) => ({ ...o })) }), { ...TERM, county: "Narok" }, NOW).resources.opens;
  assertEquals(raw, 3);
  const olesere = buildIntelligence(world(), TERM, NOW).impact.schoolPerformance.find((s) => s.school === "Olesere")!;
  assertEquals(olesere.libraryMinutes, 15, "both of Olesere's opens: 10 + 5 minutes");
  // Usage time: an open with no time recorded adds nothing (never an estimate).
  const minutes = programme.reduce((t, o) => t + (o.duration_seconds ?? 0), 0) / 60;
  assertEquals(all.resources.hours, Math.round((minutes / 60) * 10) / 10);
  // Learner reach: learners who opened something, of the learners on roll.
  assertEquals(buildIntelligence(world(), TERM, NOW).learning.library.learnerReach, 50, "l1 and l3, of 4");
});

const NONE = { school: null, county: null, from: null, to: null };
Deno.test("accuracy: Content usage counts the same opens as the dashboards", () => {
  const d = world();
  const usage = buildLibraryUsage({ items: d.libraryItems, interactions: d.libraryInteractions, schools: SCHOOLS, now: NOW }, NONE);
  assertEquals(usage.totals.sessions, buildImpact(d, {}, NOW).resources.opens);
  assertEquals(usage.hpfStaff.sessions, 2);
  const narok = buildLibraryUsage({ items: d.libraryItems, interactions: d.libraryInteractions, schools: SCHOOLS, now: NOW }, { ...NONE, county: "Narok" });
  assertEquals(narok.totals.sessions, buildImpact(d, { county: "Narok" }, NOW).resources.opens);
});

Deno.test("accuracy: form response rates — answers counted only from those the form was expected from", () => {
  const all = buildIntelligence(world(), TERM, NOW).dataCollection.responseRates[0];
  assertEquals([all.expected, all.received, all.rate], [3, 2, 66.67], "3 active teachers; the deactivated teacher's answer isn't counted");
  const narok = buildIntelligence(world(), { ...TERM, county: "Narok" }, NOW).dataCollection.responseRates[0];
  assertEquals([narok.expected, narok.received, narok.rate], [2, 1, 50], "Narok's 2 teachers, 1 answered — not Meru's answer too");
  for (const f of [all, narok]) assert(f.received <= f.expected);
});

Deno.test("accuracy: field visits — officers reporting out of active officers; a visit to an unregistered school isn't a school visited", () => {
  const V = buildIntelligence(world(), TERM, NOW).implementation;
  assertEquals(V.visits, 3);
  assertEquals([V.officersReporting, V.officers], [1, 1], "the deactivated officer's visit counts as a visit, not as an active officer reporting");
  assertEquals(V.notLinked, 1);
  assertEquals([V.schools.visited, V.schools.total], [1, 3], "only Aitong: Narok Grace Primary isn't a portal school");
});

Deno.test("accuracy: training — no sessions in the register is no data, not 0%", () => {
  const none = buildImpact(world(), TERM, NOW).teachers.training;
  assertEquals([none.recorded, none.teachersTrained], [false, 0], "the only session is archived");
  const admin = buildAdminResults(world(), { current: T3, previous: T2 }, null, NOW);
  assertEquals(admin.kpis.find((k) => k.key === "teachers_trained")!.value, null, "the admin card says No data — the same rule");
  const held = world({ trainings: [{ id: "tr2", title: "Workshop", kind: "workshop", held_on: "2026-10-01", county: "Narok", school_id: null, archived_at: null }],
    trainingAttendance: [{ training_id: "tr2", teacher_id: "t1", attended: true }, { training_id: "tr2", teacher_id: "t2", attended: false }] });
  const t = buildImpact(held, TERM, NOW).teachers.training;
  assertEquals([t.recorded, t.teachersTrained, t.share], [true, 1, 33.3], "taken off the list (attended false) isn't trained; 1 of 3 active teachers");
  assertEquals(buildAdminResults(held, { current: T3, previous: T2 }, null, NOW).kpis.find((k) => k.key === "teachers_trained")!.value, 1);
});

Deno.test("accuracy: Kobo — records with no school are in the totals only; a failed sync is said", () => {
  const all = buildImpact(world(), TERM, NOW);
  assertEquals([all.fieldOps.kobo.counted, all.fieldOps.kobo.countedNoSchool], [2, 1], "the invalid record isn't counted");
  assertEquals(buildImpact(world(), { ...TERM, county: "Narok" }, NOW).fieldOps.kobo.counted, 1);
  assertEquals(all.freshness.koboSyncFailing, ["Classroom observation"]);
  assertEquals(all.freshness.koboLastSynced, at("2026-10-15"));
});

Deno.test("accuracy: zero is zero and missing is missing — completion and marks", () => {
  const empty = buildIntelligence(world(), TERM, NOW).learning;
  assertEquals([empty.completion.rate, empty.achievement.averagePercent], [null, null], "no work set: no data");
  const set = buildIntelligence(world({
    assignments: [{ id: "a1", school_id: "s1", class_id: "c1", subject_id: "m", grade: "Grade 4", academic_year_id: "2026", term_id: "2026-T3",
      status: "closed", due_at: at("2026-09-30"), created_by: "t1", created_at: at("2026-09-20"), published_at: at("2026-09-20") }],
    enrollments: [
      { id: "e1", learner_id: "l1", school_id: "s1", class_id: "c1", enrollment_date: "2026-01-10", exit_date: null, status: "ACTIVE" },
      { id: "e2", learner_id: "l2", school_id: "s1", class_id: "c1", enrollment_date: "2026-01-10", exit_date: null, status: "ACTIVE" },
    ],
  }), TERM, NOW).learning;
  assertEquals([set.completion.assigned, set.completion.submitted, set.completion.rate, set.completion.missing], [2, 0, 0, 2], "set and none handed in: a real 0%");
  assertEquals(set.achievement.averagePercent, null, "nothing marked: still no data");
});

Deno.test("accuracy: every share is a part of its own whole", () => {
  const I = buildIntelligence(world(), TERM, NOW);
  const P = I.impact.teacherParticipation;
  for (const k of ["active", "settingWork", "marking", "usingLibrary", "answeringForms"] as const) {
    assert(P[k].count <= P.teachers, k);
  }
  assert(I.implementation.schools.visited <= I.implementation.schools.total);
  assert(I.learning.library.learnersUsing <= I.learning.totals.learners);
  const K = I.dataCollection.kobo.officerCompletion;
  assert(K.done <= K.expected);
});
