/**
 * Unit tests for the impact dashboards (impact.ts) — small hand-made rows,
 * no database.
 *
 *   cd supabase/functions/api
 *   deno test --config deno.json impact_test.ts
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { buildImpact, type ImpactInput, suppressRow } from "./impact.ts";

const NOW = new Date("2026-10-01T12:00:00Z");
const BANDS = [
  { code: "EE", label: "Exceeding", minPercent: 80 },
  { code: "ME", label: "Meeting", minPercent: 50 },
  { code: "AE", label: "Approaching", minPercent: 30 },
  { code: "BE", label: "Below", minPercent: 0 },
];

function world(): ImpactInput {
  const asg = (id: string, school: string, cls: string, term: string, due: string, by: string, subject = "maths") => ({
    id, school_id: school, class_id: cls, subject_id: subject, grade: "Grade 4", academic_year_id: "2026", term_id: term,
    starts_at: null, due_at: due, status: "closed", created_by: by, created_at: due, published_at: due,
  });
  const mark = (id: string, a: string, l: string, school: string, pc: number, at: string, by: string) => ({
    id, assignment_id: a, learner_id: l, school_id: school, status: "marked", is_late: false, percentage: pc,
    started_at: at, last_saved_at: at, submitted_at: at, marked_at: at, marked_by: by,
  });
  // Seven learners at Aitong: 5 girls, 1 boy, 1 not recorded.
  const aitong = ["female", "female", "female", "female", "female", "male", null].map((g, i) => ({
    id: `l${i + 1}`, school_id: "s1", class_id: "c1", grade: "Grade 4", enrollment_status: "ACTIVE", gender: g,
  }));
  return {
    schools: [
      { id: "s1", name: "Aitong", county: "Narok", code: "NRK-001" },
      { id: "s2", name: "Olpusimoru", county: "Narok", code: "NRK-002" },
      { id: "s3", name: "Ndaragwa", county: "Laikipia", code: "LKP-001" },
    ],
    profiles: [
      { id: "t1", role: "teacher", status: "active", school_id: "s1", county: "Narok", teacher_type: "TSC", gender: "female" },
      { id: "t2", role: "teacher", status: "active", school_id: "s1", county: "Narok", teacher_type: "BOM", gender: "male" },
      { id: "t3", role: "teacher", status: "active", school_id: "s3", county: "Laikipia", teacher_type: null, gender: null },
      { id: "tx", role: "teacher", status: "suspended", school_id: "s1", county: "Narok" },
      { id: "h1", role: "school_leader", status: "active", school_id: "s1", county: "Narok" },
      { id: "fo", role: "field_officer", status: "active", school_id: null, county: "Narok" },
      { id: "ed", role: "education_team", status: "active", school_id: null, county: null },
    ],
    learners: [
      ...aitong,
      { id: "l8", school_id: "s3", class_id: "c3", grade: "Grade 5", enrollment_status: "ACTIVE", gender: "male" },
      { id: "lx", school_id: "s1", class_id: "c1", grade: "Grade 4", enrollment_status: "TRANSFERRED_OUT", gender: "female" },
    ],
    enrollments: [],
    terms: [
      { id: "2026-T2", academic_year_id: "2026", term_no: 2, starts_on: "2026-05-01", ends_on: "2026-08-31" },
      { id: "2026-T3", academic_year_id: "2026", term_no: 3, starts_on: "2026-09-01", ends_on: "2026-12-31" },
    ],
    classes: [
      { id: "c1", school_id: "s1", academic_year_id: "2026", grade: "Grade 4", archived_at: null },
      { id: "c3", school_id: "s3", academic_year_id: "2026", grade: "Grade 5", archived_at: null },
    ],
    classTeachers: [],
    subjects: [{ id: "maths", name: "Mathematics" }, { id: "english", name: "English" }],
    assignments: [
      asg("a2", "s1", "c1", "2026-T2", "2026-06-20T00:00:00Z", "t1"),
      asg("a3", "s1", "c1", "2026-T3", "2026-09-20T00:00:00Z", "t1"),
      asg("b3", "s3", "c3", "2026-T3", "2026-09-22T00:00:00Z", "t3", "english"),
      { ...asg("d1", "s1", "c1", "2026-T3", "2026-09-28T00:00:00Z", "t2"), status: "draft", published_at: null },
    ],
    submissions: [
      // l1 improves (40 → 70), l2 declines (80 → 60), l3 has only one term.
      mark("x1", "a2", "l1", "s1", 40, "2026-06-15T00:00:00Z", "t1"),
      mark("x2", "a3", "l1", "s1", 70, "2026-09-15T00:00:00Z", "t1"),
      mark("x3", "a2", "l2", "s1", 80, "2026-06-15T00:00:00Z", "t1"),
      mark("x4", "a3", "l2", "s1", 60, "2026-09-15T00:00:00Z", "t1"),
      mark("x5", "a3", "l3", "s1", 50, "2026-09-16T00:00:00Z", "t1"),
      // l4 only started (still counts as activity); l8 marked at Ndaragwa.
      { id: "x6", assignment_id: "a3", learner_id: "l4", school_id: "s1", status: "in_progress", is_late: false, percentage: null,
        started_at: "2026-09-18T00:00:00Z", last_saved_at: "2026-09-18T00:00:00Z", submitted_at: null, marked_at: null, marked_by: null },
      mark("x7", "b3", "l8", "s3", 30, "2026-09-21T00:00:00Z", "t3"),
    ],
    fieldReports: [
      { id: "v1", school: "Aitong", school_id: "s1", county: "Narok", visit_type: "Learning", officer_id: "fo", created_at: "2026-09-05T08:00:00Z" },
      { id: "v2", school: "Aitong", school_id: "s1", county: "Narok", visit_type: "Teacher support", officer_id: "fo", created_at: "2026-06-05T08:00:00Z" },
      { id: "v3", school: "Ndaragwa", school_id: "s3", county: "Laikipia", visit_type: "ICT", officer_id: "fo", created_at: "2026-09-07T08:00:00Z" },
    ],
    forms: [
      { id: "f2", title: "Learning visit form", audience: "field_officer", county: null, visit_type: "Learning", archived_at: null },
    ],
    responses: [
      { id: "r2", form_id: "f2", respondent_id: "fo", respondent_role: "field_officer", submitted_at: "2026-09-05T08:00:00Z", visit_id: "v1" },
    ],
    koboForms: [{ id: "k1", title: "Classroom Observation", active: true, synced_at: "2026-09-30T00:00:00Z" }],
    koboSubmissions: [{ kobo_form_id: "k1", officer_id: "fo", submitted_at: "2026-09-12T00:00:00Z" }],
    koboRecords: [
      { id: "kr1", kobo_form_id: "k1", status: "valid", review: null, school_id: "s1", county: "Narok", submitted_at: "2026-09-12T00:00:00Z", warning_count: 0 },
      { id: "kr2", kobo_form_id: "k1", status: "valid", review: null, school_id: "s3", county: "Laikipia", submitted_at: "2026-08-12T00:00:00Z", warning_count: 0 },
      { id: "kr3", kobo_form_id: "k1", status: "removed", review: null, school_id: "s3", county: "Laikipia", submitted_at: "2026-09-12T00:00:00Z", warning_count: 0 },
    ],
    koboIssues: [],
    libraryItems: [
      { id: "b1", title: "Reading book", audience: "library", subject: "English", type: "Book", published: true },
      { id: "b2", title: "Lesson planning guide", audience: "staff", subject: "Pedagogy", type: "Guide", published: true },
      { id: "b3", title: "Never opened", audience: "library", subject: "Mathematics", type: "Video", published: true },
      { id: "b4", title: "Draft", audience: "library", subject: "Mathematics", type: "Video", published: false },
    ],
    libraryInteractions: [
      { id: "i1", library_item_id: "b1", actor_kind: "learner", actor_id: "l1", school: "Aitong", started_at: "2026-09-03T00:00:00Z", completed_at: "2026-09-03T01:00:00Z", duration_seconds: 3600 },
      { id: "i2", library_item_id: "b1", actor_kind: "learner", actor_id: "l5", school: "Aitong", started_at: "2026-09-20T00:00:00Z", completed_at: null, duration_seconds: 1800 },
      { id: "i3", library_item_id: "b2", actor_kind: "staff", actor_id: "t2", school: "Aitong", started_at: "2026-09-21T00:00:00Z", completed_at: null, duration_seconds: 1800 },
      { id: "i4", library_item_id: "b1", actor_kind: "learner", actor_id: "l8", school: "Ndaragwa", started_at: "2026-06-04T00:00:00Z", completed_at: null, duration_seconds: 3600 },
    ],
    bands: BANDS,
    trainings: [
      { id: "tr1", title: "ICT in the classroom", kind: "workshop", held_on: "2026-09-10", county: "Narok", school_id: null, archived_at: null },
      { id: "tr2", title: "Coaching visit", kind: "coaching", held_on: "2026-09-12", county: "Laikipia", school_id: "s3", archived_at: null },
      { id: "tr3", title: "Cancelled", kind: "cluster", held_on: "2026-09-14", county: "Narok", school_id: null, archived_at: "2026-09-13T00:00:00Z" },
    ],
    trainingAttendance: [
      { training_id: "tr1", teacher_id: "t1", attended: true },
      { training_id: "tr1", teacher_id: "t2", attended: false }, // taken off the list
      { training_id: "tr2", teacher_id: "t3", attended: true },
      { training_id: "tr3", teacher_id: "t2", attended: true }, // archived session
    ],
  };
}

Deno.test("small numbers are hidden, and a lone hidden cell takes the next smallest with it", () => {
  assertEquals(suppressRow({ female: 12, male: 9, x: 0 }), { female: 12, male: 9, x: 0 });
  assertEquals(suppressRow({ female: 7, male: 3, x: 0, y: 10 }), { female: null, male: null, x: 0, y: 10 },
    "3 alone would be total − 17; hiding 7 as well stops that");
  assertEquals(suppressRow({ female: 7, male: 3, x: 2, y: 10 }), { female: 7, male: null, x: null, y: 10 });
  assertEquals(suppressRow({ female: 23, male: 14, prefer_not_to_say: 4, not_recorded: 7 }),
    { female: 23, male: 14, prefer_not_to_say: null, not_recorded: null }, "whatever the key is called");
});

Deno.test("executive overview: the six headline numbers", () => {
  const r = buildImpact(world(), {}, NOW);
  const e = r.executive;
  assertEquals([e.schools, e.learners, e.teachers], [3, 8, 3], "active learners and teachers only");
  // Last 30 days (from 2026-09-01): learners l1 l2 l3 (marked), l4 (started), l5 (library), l8 (marked);
  // staff t1 (marked), t2 (library), t3 (marked), fo (visit, form, Kobo). l8's June reading is too old.
  assertEquals([e.activeUsers.learners, e.activeUsers.staff, e.activeUsers.total], [6, 4, 10]);
  assertEquals(e.activeUsers.window, "in the last 30 days");
  assertEquals(e.activeUsers.learnerShare, 75);
  assertEquals(e.libraryHours, 3, "3,600 + 1,800 + 1,800 + 3,600 seconds = 3 hours");
  assert(e.completion.assigned > 0);
});

Deno.test("active users follow the county filter and the dates picked", () => {
  const narok = buildImpact(world(), { county: "Narok" }, NOW).executive.activeUsers;
  assertEquals([narok.learners, narok.staff], [5, 3], "l8 and t3 are in Laikipia; the Education Team isn't in a county");
  const june = buildImpact(world(), { from: "2026-06-01", to: "2026-06-30" }, NOW).executive.activeUsers;
  assertEquals([june.learners, june.staff, june.window], [3, 2, "in the period"], "l1, l2 and l8; t1 marking and fo's visit");
});

Deno.test("reach: by county, gender with small numbers hidden, grades, teacher types", () => {
  const r = buildImpact(world(), {}, NOW).reach;
  assertEquals(r.learnersByCounty, [{ label: "Laikipia", value: 1 }, { label: "Narok", value: 7 }]);
  assertEquals(r.teachersByCounty, [{ label: "Laikipia", value: 1 }, { label: "Narok", value: 2 }]);
  assertEquals(r.schoolsByCounty, [{ label: "Laikipia", schools: 1, reached: 1 }, { label: "Narok", schools: 2, reached: 1 }]);
  const g = r.gender.learners;
  assertEquals([g.total, g.recorded, g.recordedShare], [8, 7, 87.5], "the transferred-out learner isn't counted");
  assertEquals(Object.fromEntries(g.overall.map((x) => [x.key, x.value])), { female: 5, male: null, prefer_not_to_say: 0, not_recorded: null },
    "2 boys and 1 unrecorded are under 5");
  const narok = g.byCounty.find((c) => c.county === "Narok")!;
  assertEquals([narok.values.female, narok.values.male, narok.values.not_recorded], [5, null, null]);
  assertEquals(r.gender.teachers.overall.every((x) => x.value === null || x.value === 0), true, "three teachers: all hidden");
  assertEquals(r.teachersByType, [{ label: "BOM", value: 1 }, { label: "Not specified", value: 1 }, { label: "TSC", value: 1 }]);
  assertEquals(r.grades, [{ label: "Grade 4", value: 7 }, { label: "Grade 5", value: 1 }]);
});

Deno.test("learning: learner progress between first and latest marked term", () => {
  const r = buildImpact(world(), {}, NOW).learning;
  assertEquals(r.progress.learners, { compared: 2, improved: 1, declined: 1, steady: 0, improvedShare: 50 },
    "l1 40 → 70 improved, l2 80 → 60 declined; l3 and l8 have one term");
  assertEquals(r.progress.byTerm.map((t) => t.label), ["2026 Term 2", "2026 Term 3"]);
  assertEquals([r.assignments.closed, r.assignments.draft], [3, 1]);
  assertEquals(r.assignments.bySubject, [{ label: "Mathematics", value: 2 }, { label: "English", value: 1 }], "drafts aren't counted");
  // Narrowed to Term 3 only, nobody has two terms to compare.
  const t3 = buildImpact(world(), { from: "2026-09-01", to: "2026-12-31" }, NOW).learning;
  assertEquals(t3.progress.learners.compared, 0);
});

Deno.test("teacher development: training register, digital use, activity", () => {
  const all = buildImpact(world(), {}, NOW).teachers;
  assertEquals([all.training.sessions, all.training.teachersTrained, all.training.share], [2, 2, 66.7],
    "tr3 is archived and t2 was taken off tr1's list");
  assertEquals(all.training.recent.map((t) => [t.id, t.attendees]), [["tr2", 1], ["tr1", 1]]);
  assertEquals(all.training.byCounty.find((c) => c.label === "Narok"), { label: "Narok", teachers: 2, trained: 1, share: 50 });
  assertEquals([all.digital.teachersUsingLibrary, all.digital.hours, all.digital.teacherResourceOpens], [1, 0.5, 1]);
  assertEquals(all.activity.supportVisits, { visits: 1, schools: 1 });
  // Seen from one school: the county workshop its teacher went to still shows.
  const aitong = buildImpact(world(), { school: "Aitong" }, NOW).teachers.training;
  assertEquals([aitong.sessions, aitong.teachersTrained], [1, 1]);
  const laikipia = buildImpact(world(), { county: "Laikipia" }, NOW).teachers.training;
  assertEquals(laikipia.recent.map((t) => t.id), ["tr2"]);
});

Deno.test("field operations: visits by month, completed visit forms, Kobo by county", () => {
  const r = buildImpact(world(), {}, NOW).fieldOps;
  assertEquals(r.visits.visits, 3);
  assertEquals(r.visitsByMonth.length, 12);
  assertEquals(r.visitsByMonth.at(-1)!.label, "2026-10");
  assertEquals(r.visitsByMonth.find((m) => m.label === "2026-09")!.value, 2);
  assertEquals([r.forms.visitFormsFilled, r.forms.visitsWithForms, r.forms.visitsWithFormsShare], [1, 1, 33.3]);
  assertEquals(r.kobo.byCounty, [{ label: "Laikipia", value: 1 }, { label: "Narok", value: 1 }], "the removed record isn't counted");
  assertEquals(buildImpact(world(), { county: "Narok" }, NOW).fieldOps.kobo.byCounty, [{ label: "Narok", value: 1 }]);
});

Deno.test("digital resources: published items, opens, hours, readers, most used", () => {
  const r = buildImpact(world(), {}, NOW).resources;
  assertEquals(r.items.total, 3, "the draft isn't a resource yet");
  assertEquals(r.items.byDestination, [{ label: "Digital Library", value: 2 }, { label: "Teacher Resources", value: 1 }]);
  assertEquals([r.opens, r.finished, r.hours], [4, 1, 3]);
  assertEquals([r.activeUsers.total, r.activeUsers.learners, r.activeUsers.staff], [4, 3, 1]);
  assertEquals(r.top[0], { id: "b1", title: "Reading book", destination: "Digital Library", opens: 3, readers: 3, minutes: 150 });
  assertEquals(r.neverOpened, 1);
  const school = buildImpact(world(), { school: "Ndaragwa" }, NOW).resources;
  assertEquals([school.opens, school.activeUsers.learners], [1, 1]);
});
