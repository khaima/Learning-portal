/**
 * Unit tests for the Programme Intelligence numbers (intelligence.ts) —
 * built from small hand-made rows, no database.
 *
 *   cd supabase/functions/api
 *   deno test --config deno.json intelligence_test.ts
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { buildIntelligence, type IntelligenceInput } from "./intelligence.ts";

const NOW = new Date("2026-10-01T12:00:00Z");
const BANDS = [
  { code: "EE", label: "Exceeding", minPercent: 80 },
  { code: "ME", label: "Meeting", minPercent: 50 },
  { code: "AE", label: "Approaching", minPercent: 30 },
  { code: "BE", label: "Below", minPercent: 0 },
];

function world(): IntelligenceInput {
  return {
    schools: [
      { id: "s1", name: "Aitong", county: "Narok", code: "NRK-001" },
      { id: "s2", name: "Olpusimoru", county: "Narok", code: "NRK-002" },
      { id: "s3", name: "Ndaragwa", county: "Laikipia", code: "LKP-001" },
    ],
    profiles: [
      { id: "t1", role: "teacher", status: "active", school_id: "s1", county: "Narok" },
      { id: "t2", role: "teacher", status: "active", school_id: "s1", county: "Narok" },
      { id: "t3", role: "teacher", status: "active", school_id: "s3", county: "Laikipia" },
      { id: "tx", role: "teacher", status: "suspended", school_id: "s1", county: "Narok" },
      { id: "h1", role: "school_leader", status: "active", school_id: "s1", county: "Narok" },
      { id: "fo", role: "field_officer", status: "active", school_id: null, county: "Narok" },
    ],
    learners: [
      { id: "l1", school_id: "s1", class_id: "c1", grade: "Grade 4", enrollment_status: "ACTIVE" },
      { id: "l2", school_id: "s1", class_id: "c1", grade: "Grade 4", enrollment_status: "ACTIVE" },
      { id: "l3", school_id: "s1", class_id: null, grade: "Grade 5", enrollment_status: "ACTIVE" },
      { id: "l4", school_id: "s3", class_id: "c3", grade: "Grade 4", enrollment_status: "ACTIVE" },
      { id: "l5", school_id: "s1", class_id: "c1", grade: "Grade 4", enrollment_status: "DROPPED_OUT" },
    ],
    enrollments: [
      { id: "e1", learner_id: "l1", school_id: "s1", class_id: "c1", enrollment_date: "2026-01-10", exit_date: null, status: "ACTIVE" },
      { id: "e2", learner_id: "l2", school_id: "s1", class_id: "c1", enrollment_date: "2026-09-02", exit_date: null, status: "ACTIVE" },
      { id: "e3", learner_id: "l3", school_id: "s1", class_id: null, enrollment_date: "2026-05-05", exit_date: null, status: "ACTIVE" },
      { id: "e4", learner_id: "l4", school_id: "s3", class_id: "c3", enrollment_date: "2026-01-10", exit_date: null, status: "ACTIVE" },
      { id: "e5", learner_id: "l5", school_id: "s1", class_id: "c1", enrollment_date: "2026-01-10", exit_date: "2026-04-15", status: "DROPPED_OUT" },
    ],
    terms: [
      { id: "2026-T1", academic_year_id: "2026", term_no: 1, starts_on: "2026-01-01", ends_on: "2026-04-30" },
      { id: "2026-T2", academic_year_id: "2026", term_no: 2, starts_on: "2026-05-01", ends_on: "2026-08-31" },
      { id: "2026-T3", academic_year_id: "2026", term_no: 3, starts_on: "2026-09-01", ends_on: "2026-12-31" },
    ],
    classes: [
      { id: "c1", school_id: "s1", academic_year_id: "2026", grade: "Grade 4", archived_at: null },
      { id: "c2", school_id: "s1", academic_year_id: "2026", grade: "Grade 5", archived_at: null },
      { id: "c3", school_id: "s3", academic_year_id: "2026", grade: "Grade 4", archived_at: null },
    ],
    classTeachers: [
      { id: "ct1", class_id: "c1", teacher_id: "t1", role: "class_teacher", ended_at: null },
      { id: "ct3", class_id: "c3", teacher_id: "t3", role: "class_teacher", ended_at: null },
    ],
    subjects: [{ id: "maths", name: "Mathematics" }, { id: "english", name: "English" }],
    assignments: [
      { id: "a1", school_id: "s1", class_id: "c1", subject_id: "maths", grade: "Grade 4", academic_year_id: "2026", term_id: "2026-T3",
        starts_at: null, due_at: "2026-09-20T00:00:00Z", status: "closed", created_by: "t1", created_at: "2026-09-10T00:00:00Z", published_at: "2026-09-10T00:00:00Z" },
      { id: "a3", school_id: "s3", class_id: "c3", subject_id: "english", grade: "Grade 4", academic_year_id: "2026", term_id: "2026-T3",
        starts_at: null, due_at: "2026-09-25T00:00:00Z", status: "published", created_by: "t3", created_at: "2026-09-10T00:00:00Z", published_at: "2026-09-10T00:00:00Z" },
      { id: "draft", school_id: "s1", class_id: "c1", subject_id: "maths", grade: "Grade 4", academic_year_id: "2026", term_id: "2026-T3",
        starts_at: null, due_at: null, status: "draft", created_by: "t2", created_at: "2026-09-12T00:00:00Z", published_at: null },
    ],
    submissions: [
      { id: "s-1", assignment_id: "a1", learner_id: "l1", school_id: "s1", status: "marked", is_late: false, percentage: 90, submitted_at: "2026-09-15T00:00:00Z", marked_by: "t1" },
      { id: "s-2", assignment_id: "a1", learner_id: "l2", school_id: "s1", status: "submitted", is_late: true, percentage: null, submitted_at: "2026-09-12T00:00:00Z", marked_by: null },
      { id: "s-4", assignment_id: "a3", learner_id: "l4", school_id: "s3", status: "marked", is_late: false, percentage: 40, submitted_at: "2026-09-20T00:00:00Z", marked_by: "t3" },
    ],
    fieldReports: [
      { id: "v1", school: "Aitong", school_id: "s1", county: "Narok", visit_type: "Learning", officer_id: "fo", created_at: "2026-09-05T08:00:00Z" },
      { id: "v2", school: "Aitong", school_id: "s1", county: "Narok", visit_type: "Teacher support", officer_id: "fo", created_at: "2026-06-05T08:00:00Z" },
      { id: "v3", school: "Old Name", school_id: null, county: "Narok", visit_type: "ICT", officer_id: "fo", created_at: "2026-02-05T08:00:00Z" },
    ],
    forms: [
      { id: "f1", title: "Teacher survey", audience: "teacher", county: null, visit_type: null, archived_at: null },
      { id: "f2", title: "Learning visit form", audience: "field_officer", county: null, visit_type: "Learning", archived_at: null },
    ],
    responses: [
      { id: "r1", form_id: "f1", respondent_id: "t1", respondent_role: "teacher", submitted_at: "2026-09-10T00:00:00Z", visit_id: null },
      { id: "r2", form_id: "f2", respondent_id: "fo", respondent_role: "field_officer", submitted_at: "2026-09-05T08:00:00Z", visit_id: "v1" },
    ],
    koboForms: [
      { id: "k1", title: "Classroom Observation", active: true, submission_count: 20, rejected_count: 2, unattributed_count: 3, synced_at: "2026-09-30T00:00:00Z" },
      { id: "k2", title: "Old survey", active: false, submission_count: 99, rejected_count: 9, unattributed_count: 9, synced_at: null },
    ],
    koboSubmissions: [{ kobo_form_id: "k1", officer_id: "fo", submitted_at: "2026-09-12T00:00:00Z" }],
    libraryItems: [{ id: "b1", title: "Reading book" }, { id: "b2", title: "Maths video" }],
    libraryInteractions: [
      { id: "i1", library_item_id: "b1", actor_kind: "learner", actor_id: "l1", school: "Aitong", started_at: "2026-09-03T00:00:00Z", completed_at: "2026-09-03T00:10:00Z", duration_seconds: 600 },
      { id: "i2", library_item_id: "b1", actor_kind: "learner", actor_id: "l1", school: "Aitong", started_at: "2026-09-04T00:00:00Z", completed_at: null, duration_seconds: 300 },
      { id: "i3", library_item_id: "b2", actor_kind: "staff", actor_id: "t2", school: "Aitong", started_at: "2026-06-04T00:00:00Z", completed_at: null, duration_seconds: 120 },
      { id: "i4", library_item_id: "b2", actor_kind: "learner", actor_id: "l4", school: "Ndaragwa", started_at: "2026-09-04T00:00:00Z", completed_at: null, duration_seconds: 60 },
    ],
    bands: BANDS,
  };
}

Deno.test("learning: totals, completion and achievement kept apart, library use", () => {
  const r = buildIntelligence(world(), {}, NOW);
  const t = r.learning.totals;
  assertEquals([t.learners, t.teachers, t.schools, t.classes, t.classesWithoutTeacher, t.learnersNotInClass], [4, 3, 3, 3, 1, 1],
    "only active learners and staff; c2 has no class teacher; l3 isn't in a class");
  assertEquals(t.assignments, { published: 1, closed: 1, draft: 1 });
  assertEquals(t.awaitingMarking, 1);
  // a1 expects l1 and l2 (l5 left before it opened); a3 expects l4.
  assertEquals(r.learning.completion, { assigned: 3, submitted: 3, onTime: 2, late: 1, missing: 0, rate: 100 });
  assertEquals([r.learning.achievement.marked, r.learning.achievement.averagePercent], [2, 65], "(90 + 40) / 2 — l2's unmarked work isn't a score");
  assertEquals(r.learning.bySubject.map((x) => [x.label, x.averagePercent]), [["English", 40], ["Mathematics", 90]]);
  assertEquals([r.learning.library.sessions, r.learning.library.minutes, r.learning.library.learnersUsing, r.learning.library.learnerReach], [4, 18, 2, 50]);
  assertEquals(r.learning.library.topResources[0], { title: "Reading book", sessions: 2, minutes: 15 });
});

Deno.test("implementation: visits by type (incl. teacher support) and school coverage", () => {
  const r = buildIntelligence(world(), {}, NOW);
  const byType = Object.fromEntries(r.implementation.byType.map((x) => [x.label, x.visits]));
  assertEquals(byType, { Learning: 1, Infrastructure: 0, ICT: 1, MEP: 0, "Teacher support": 1 });
  assertEquals([r.implementation.visits, r.implementation.officersReporting], [3, 1]);
  assertEquals(r.implementation.schools, {
    total: 3, visited: 1, coverage: 33.33, visitedThisTerm: 1, currentTerm: "2026 Term 3", notVisited: ["Ndaragwa", "Olpusimoru"],
  });
});

Deno.test("data collection: response rates, Kobo, and data-quality checks", () => {
  const r = buildIntelligence(world(), {}, NOW);
  const rates = Object.fromEntries(r.dataCollection.responseRates.map((x) => [x.label, [x.expected, x.received, x.rate]]));
  assertEquals(rates["Teacher survey"], [3, 1, 33.33], "3 active teachers, 1 answered");
  assertEquals(rates["Learning visit form"], [1, 1, 100], "one Learning visit, its form filled");
  assertEquals(r.dataCollection.kobo.totalSubmissions, 20, "inactive Kobo forms are left out");
  assertEquals(r.dataCollection.kobo.officerCompletion, { expected: 1, done: 1, rate: 100 });
  const q = Object.fromEntries(r.dataCollection.quality.map((x) => [x.key, [x.value, x.total]]));
  assertEquals(q.kobo_rejected, [2, 20]);
  assertEquals(q.kobo_unattributed, [3, 20]);
  assertEquals(q.visits_unlinked, [1, 3]);
  assertEquals(q.learners_no_class, [1, 4]);
  assertEquals(q.classes_no_teacher, [1, 3]);
  assertEquals(q.unmarked_overdue, [1, 3], "l2's work has waited since 12 Sep");
});

Deno.test("impact: learner growth, teacher participation, outcomes, schools, reach", () => {
  const r = buildIntelligence(world(), {}, NOW);
  assertEquals(r.impact.learnerGrowth, [
    { label: "2026 Term 1", learners: 3, joined: 3 },
    { label: "2026 Term 2", learners: 3, joined: 1 },
    { label: "2026 Term 3", learners: 4, joined: 1 },
  ], "l5 left in Term 1; l3 joined in Term 2; l2 in Term 3");
  const p = r.impact.teacherParticipation;
  assertEquals([p.teachers, p.settingWork.count, p.marking.count, p.usingLibrary.count, p.answeringForms.count, p.active.count], [3, 2, 2, 1, 1, 3]);
  assertEquals(r.impact.assessment.byTerm[0].averagePercent, 65);
  const aitong = r.impact.schoolPerformance.find((s) => s.school === "Aitong")!;
  assertEquals([aitong.learners, aitong.completionRate, aitong.averagePercent, aitong.visits], [3, 100, 90, 2]);
  assertEquals(r.impact.reach, {
    counties: 2, countiesTotal: 2, schoolsReached: 2, schoolsTotal: 3, schoolsVisited: 1,
    learners: 4, teachers: 3, fieldOfficers: 1, learnersEverEnrolled: 5,
  });
});

Deno.test("filters: a county or school narrows every area; dates narrow dated rows", () => {
  const laikipia = buildIntelligence(world(), { county: "Laikipia" }, NOW);
  assertEquals([laikipia.learning.totals.learners, laikipia.learning.totals.schools, laikipia.learning.achievement.averagePercent], [1, 1, 40]);
  assertEquals(laikipia.implementation.visits, 0);
  assertEquals(laikipia.impact.schoolPerformance.map((s) => s.school), ["Ndaragwa"]);
  const aitong = buildIntelligence(world(), { school: "Aitong" }, NOW);
  assertEquals([aitong.learning.totals.learners, aitong.learning.library.sessions], [3, 3]);
  assert(aitong.dataCollection.notSchoolScoped);
  const term3 = buildIntelligence(world(), { from: "2026-09-01", to: "2026-12-31" }, NOW);
  assertEquals([term3.implementation.visits, term3.learning.library.sessions], [1, 3]);
});
