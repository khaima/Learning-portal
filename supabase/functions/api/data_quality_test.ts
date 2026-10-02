/**
 * Unit tests for the Data Quality Center's checks (data_quality.ts).
 *
 *   cd supabase/functions/api
 *   deno test --config deno.json data_quality_test.ts
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { checkedIn, detectAll, ISSUE_TYPE_IDS, qualityScore, type Snapshot } from "./data_quality.ts";
import { GRADES } from "./permissions.ts";

const NOW = new Date("2026-10-02T12:00:00Z");
const L = (id: string, o: Record<string, unknown> = {}) => ({
  id, full_name: `Learner ${id}`, learner_code: `NRK-001-L${id}`, grade: "Grade 4", school_id: "s1", county: "Narok",
  class_id: "c1", current_teacher_id: "t1", enrollment_status: "ACTIVE", created_at: `2026-01-0${id.length}T00:00:00Z`, ...o,
});
const E = (id: string, learner: string, o: Record<string, unknown> = {}) => ({
  id, learner_id: learner, school_id: "s1", class_id: "c1", status: "ACTIVE", enrollment_date: "2026-01-10", exit_date: null, ...o,
});

function world(): Snapshot {
  return {
    schools: [
      { id: "s1", name: "Aitong Primary", code: "NRK-001", county: "Narok" },
      { id: "s2", name: "Kianjai Primary", code: "MRU-001", county: "Meru" },
      { id: "s3", name: "Lost Primary", code: "XXX-001", county: "Atlantis" },
    ],
    counties: [{ name: "Narok" }, { name: "Meru" }],
    profiles: [
      { id: "t1", role: "teacher", status: "active", full_name: "Tina Teacher", email: "tina@hpf.org", school_id: "s1", county: "Narok" },
      { id: "t2", role: "teacher", status: "active", full_name: "Tina  teacher", email: "tina.t@hpf.org", school_id: "s1", county: "Narok" },
      { id: "t3", role: "teacher", status: "suspended", full_name: "Sam Suspended", email: "sam@hpf.org", school_id: "s1", county: "Narok" },
      { id: "t4", role: "teacher", status: "active", full_name: "Nora Noschool", email: "nora@hpf.org", school_id: null, county: "" },
      { id: "e1", role: "education_team", status: "active", full_name: "Patrick K", email: "patrick@hpf.org", school_id: null, county: "" },
      { id: "e2", role: "education_team", status: "active", full_name: "Parick Kaima", email: "parick@hpf.org", school_id: null, county: "" },
      { id: "fo", role: "field_officer", status: "active", full_name: "Fiona Field", email: "fiona@hpf.org", school_id: null, county: "" },
      { id: "h2", role: "school_leader", status: "active", full_name: "Hugo Head", email: "hugo@hpf.org", school_id: "s2", county: "Narok" },
      { id: "gone", role: "teacher", status: "deactivated", full_name: "Tina Teacher", email: "tina2@hpf.org", school_id: "s1", county: "Narok" },
    ],
    learners: [
      L("1"),
      L("2", { full_name: "Learner 1" }),                        // same name as #1 in the same school
      L("3", { grade: "" }),                                      // missing grade
      L("4", { grade: "Std 4" }),                                 // not a grade
      L("5", { grade: "Grade 5" }),                               // not the class's grade
      L("6", { class_id: null }),                                 // no class
      L("7", { school_id: null, class_id: null, county: "" }),    // no school (and so no class)
      L("8", { county: "Meru" }),                                 // wrong county for the school
      L("9", { enrollment_status: "DROPPED_OUT" }),               // left, enrollment still open
      L("10"),                                                    // active, no enrollment
      L("11", { class_id: "c_old" }),                             // in an archived class
    ],
    enrollments: [
      E("e1", "1"), E("e2", "2"), E("e3", "3"), E("e4", "4"), E("e5", "5"), E("e6", "6"), E("e7", "7", { school_id: null }),
      E("e8", "8"), E("e9", "9"), E("e11", "11"),
      E("e_bad", "1", { status: "COMPLETED", enrollment_date: "2026-03-01", exit_date: "2026-02-01" }),
      E("e_future", "2", { status: "COMPLETED", enrollment_date: "2027-01-01", exit_date: null }),
    ],
    classes: [
      { id: "c1", school_id: "s1", grade: "Grade 4", name: "Grade 4 East", archived_at: null },
      { id: "c_old", school_id: "s1", grade: "Grade 3", name: "Grade 3 (2025)", archived_at: "2026-01-01" },
    ],
    classTeachers: [
      { id: "ct1", class_id: "c1", teacher_id: "t1", role: "class_teacher", ended_at: null },
      { id: "ct2", class_id: "c1", teacher_id: "t3", role: "subject_teacher", ended_at: null },     // suspended teacher
      { id: "ct3", class_id: "c_old", teacher_id: "t1", role: "class_teacher", ended_at: null },   // archived class
      { id: "ct4", class_id: "c1", teacher_id: "t1", role: "class_teacher", ended_at: "2026-05-01" },
    ],
    assignments: [
      { id: "a1", class_id: "c1", school_id: "s1", status: "published", created_by: "t3", title: "Fractions" }, // class still has t1
      { id: "a2", class_id: "c_x", school_id: "s1", status: "published", created_by: "t3", title: "Reading" },   // nobody left
    ],
    terms: [
      { id: "2026-T1", academic_year_id: "2026", starts_on: "2026-01-01", ends_on: "2026-04-30" },
      { id: "2026-T9", academic_year_id: "2026", starts_on: "2026-12-01", ends_on: "2026-11-01" },
    ],
    fieldReports: [
      { id: "v1", school: "Aitong Primary", school_id: "s1", county: "Narok", visit_type: "Learning", created_at: "2026-09-01T00:00:00Z" },
      { id: "v2", school: "Old name school", school_id: null, county: "Narok", visit_type: "ICT", created_at: "2026-02-01T00:00:00Z" },
      { id: "v3", school: "Aitong Primary", school_id: "s1", county: "Meru", visit_type: "MEP", created_at: "2026-09-02T00:00:00Z" },
    ],
    koboRecords: [
      { id: "k1", kobo_form_id: "f1", kobo_id: 1, status: "valid", review: null, school_id: "s1", county: "Narok" },
      { id: "k2", kobo_form_id: "f1", kobo_id: 2, status: "duplicate", review: null, school_id: "s1", county: "Narok" },
      { id: "k3", kobo_form_id: "f1", kobo_id: 3, status: "invalid", review: null, school_id: null, county: null, school_value: "Aitong Pri" },
      { id: "k4", kobo_form_id: "f1", kobo_id: 4, status: "invalid", review: "accepted", school_id: "s1", county: "Narok" },
      { id: "k5", kobo_form_id: "f1", kobo_id: 5, status: "duplicate", review: "excluded", school_id: "s1", county: "Narok" },
    ],
    koboIssues: [
      { record_id: "k2", rule: "duplicate", severity: "error", message: "Same answers as submission #1" },
      { record_id: "k3", rule: "school", severity: "error", message: "School “Aitong Pri” isn't a portal school" },
      { record_id: "k3", rule: "officer", severity: "error", message: "The officer reference doesn't match any portal account" },
      { record_id: "k3", rule: "required", severity: "error", field: "visit_date", message: "“Date” is required but empty" },
      { record_id: "k3", rule: "date", severity: "error", message: "Date is in the future" },
      { record_id: "k4", rule: "officer", severity: "error", message: "accepted by a person — not an issue any more" },
    ],
    koboForms: [{ id: "f1", title: "Classroom observation", active: true }],
    libraryItems: [{ id: "b1" }],
    libraryInteractions: [{ id: "i1", library_item_id: "b1" }, { id: "i2", library_item_id: "deleted" }, { id: "i3", library_item_id: "deleted" }],
    grades: GRADES,
  };
}

const run = () => detectAll(world(), NOW);
const keys = (type: string) => run().issues.filter((i) => i.type === type).map((i) => i.key).sort();

Deno.test("1–2. duplicate learners (same name, same school) and staff (same name, or a one-letter email slip)", () => {
  const dl = run().issues.filter((i) => i.type === "duplicate_learner");
  assertEquals(dl.length, 1);
  assertEquals([dl[0].entity.id, dl[0].related.map((r) => r.id)], ["1", ["2"]], "the older record comes first");
  const ds = run().issues.filter((i) => i.type === "duplicate_staff").map((i) => i.kind).sort();
  assertEquals(ds, ["same_name", "similar_email"], "Tina ×2 (the deactivated one doesn't count); patrick@ vs parick@");
});

Deno.test("3–5. missing school, missing county, and school/county that don't agree", () => {
  assertEquals(keys("missing_school"), ["missing_school:kobo:k3", "missing_school:learner:7", "missing_school:visit:v2"]);
  assertEquals(keys("missing_county"), ["missing_county:profile:fo"], "the field officer needs a county");
  assertEquals(keys("school_county_mismatch"), [
    "school_county_mismatch:learner:8", "school_county_mismatch:profile:h2",
    "school_county_mismatch:school:s3", "school_county_mismatch:visit:v3",
  ]);
});

Deno.test("6–7. grades: missing, not a portal grade, or not the class's grade", () => {
  assertEquals(keys("missing_grade"), ["missing_grade:learner:3"]);
  const inv = run().issues.filter((i) => i.type === "invalid_grade");
  assertEquals(inv.map((i) => [i.entity.id, i.kind]).sort(), [["4", "not_a_grade"], ["5", "class_mismatch"]]);
});

Deno.test("8–10. Kobo: only submissions nobody has decided on yet", () => {
  assertEquals(keys("duplicate_kobo_submission"), ["duplicate_kobo_submission:kobo:k2"], "k5 was excluded by a person");
  assertEquals(keys("unmatched_kobo_officer"), ["unmatched_kobo_officer:kobo:k3"], "k4 was accepted");
  assertEquals(keys("missing_kobo_required"), ["missing_kobo_required:kobo:k3"]);
});

Deno.test("11. orphaned records", () => {
  const o = run().issues.filter((i) => i.type === "orphaned_record").map((i) => i.kind).sort();
  assertEquals(o, ["archived_class_teacher", "class_gone", "library_item_gone", "no_active_enrollment", "stale_enrollment"]);
  const lib = run().issues.find((i) => i.kind === "library_item_gone")!;
  assertEquals(lib.details.sessions, 2, "one issue per deleted resource, not per session");
});

Deno.test("12. invalid dates", () => {
  assertEquals(run().issues.filter((i) => i.type === "invalid_date").map((i) => i.kind).sort(),
    ["enrollment_exit_before_start", "enrollment_in_future", "kobo", "term_ends_before_start"]);
});

Deno.test("13. inactive users with active assignments", () => {
  const x = run().issues.filter((i) => i.type === "inactive_user_active_assignment");
  assertEquals(x.map((i) => i.key).sort(), ["inactive_user_active_assignment:assignment:a2", "inactive_user_active_assignment:class_teacher:ct2"],
    "a1's class still has an active teacher; ct4 has ended");
});

Deno.test("14–15. learners without a class; teachers and heads without a school", () => {
  assertEquals(keys("learner_without_class"), ["learner_without_class:learner:6", "learner_without_class:learner:7"]);
  assertEquals(keys("staff_without_school"), ["staff_without_school:profile:t4"]);
});

Deno.test("every issue has a stable key, a location and something to look at", () => {
  const a = run().issues;
  const b = run().issues;
  assertEquals(a.map((i) => i.key), b.map((i) => i.key), "same data, same keys");
  assertEquals(new Set(a.map((i) => i.key)).size, a.length, "keys are unique");
  assert(a.every((i) => i.entity.id && i.summary && ["HIGH", "MEDIUM", "LOW"].includes(i.severity)));
  assertEquals(a.find((i) => i.key === "missing_grade:learner:3")!.county, "Narok", "county comes from the school");
  const types = new Set(a.map((i) => i.type));
  assertEquals(ISSUE_TYPE_IDS.filter((t) => !types.has(t)), [], "the fixture exercises all 15 checks");
});

Deno.test("score: weighted pass rates; scoped to schools; ignored and resolved don't count", () => {
  const { checked } = run();
  const all = checkedIn(checked, null);
  assertEquals(all.learner_without_class, 10, "every active learner was checked");
  assertEquals(checkedIn(checked, new Set(["s2"])).learner_without_class, 0);
  const perfect = qualityScore(all, {});
  assertEquals([perfect.score, perfect.label], [100, "Good"]);
  const some = qualityScore(all, { learner_without_class: 5, staff_without_school: 1 });
  assert(some.score < 100 && some.score > 75, String(some.score));
  assertEquals(some.perType.find((t) => t.type === "learner_without_class")!.passRate, 50);
  // A HIGH check failing costs more than a LOW one failing as badly.
  const high = qualityScore({ ...all, staff_without_school: 10, learner_without_class: 10 }, { staff_without_school: 5 });
  const low = qualityScore({ ...all, staff_without_school: 10, learner_without_class: 10 }, { learner_without_class: 5 });
  assert(high.score < low.score);
});
