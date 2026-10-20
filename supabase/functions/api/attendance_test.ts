/**
 * Class attendance — the daily register — and comparing subjects' results.
 *
 *   cd supabase/functions/api
 *   deno test --allow-env --allow-read --config deno.json attendance_test.ts
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  attendanceAndMarks, cleanMarks, eatDay, learnerRecord, type RegisterRow, schoolDays, summarizeAttendance,
} from "./attendance.ts";
import { compareResults, type Pair } from "./lms.ts";
import { call, type Db, freshWorld } from "./test_world.ts";

const TEACHER = "tok_teacher";
const TODAY = eatDay();
const daysBefore = (n: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * 864e5).toISOString().slice(0, 10);
/** The last n school days (Monday–Friday) before today, oldest first. */
const lastSchoolDays = (n: number) => {
  const out: string[] = [];
  for (let k = 1; out.length < n; k++) { const d = daysBefore(k); const wd = new Date(`${d}T00:00:00Z`).getUTCDay(); if (wd !== 0 && wd !== 6) out.unshift(d); }
  return out;
};
/** Grade 4 East with four more learners (five in all). */
function classOfFive(db: Db) {
  for (const [i, name] of ["Amina", "Baraka", "Daudi", "Chebet"].entries()) {
    db.learners.push({ ...db.learners[0], id: `l${i + 2}`, username: `kid.${i + 2}`, full_name: `${name} K.`, learner_code: `NRK-001-L000${i + 2}` });
  }
}
const take = (date: string, marks: Record<string, string>, token = TEACHER, more: Record<string, unknown> = {}) =>
  call("PUT", "/attendance/register", token, { classId: "cls_1", date, marks: Object.entries(marks).map(([learnerId, status]) => ({ learnerId, status })), ...more });

/* ------------------------------------------------------------ the pure parts */

Deno.test("marks: learners on the class list, a known status, a reason only with an absence", () => {
  const roster = new Set(["a", "b"]);
  assertEquals(cleanMarks([{ learnerId: "a", status: "present" }, { learnerId: "b", status: "excused", reason: "sick", note: " Fever " }], roster),
    [{ learnerId: "a", status: "present", reason: null, note: null }, { learnerId: "b", status: "excused", reason: "sick", note: "Fever" }]);
  assertEquals(cleanMarks([{ learnerId: "x", status: "present" }], roster), "Someone on the list isn't in this class");
  assertEquals(cleanMarks([{ learnerId: "a", status: "here" }], roster), "Mark each learner present, late, absent or excused");
  assertEquals(cleanMarks([{ learnerId: "a", status: "present", reason: "sick" }], roster), "A reason goes only with an absence");
  assertEquals(cleanMarks([], roster), "Mark at least one learner");
  assertEquals((cleanMarks([{ learnerId: "a", status: "absent" }, { learnerId: "a", status: "late" }], roster) as unknown[]).length, 1, "the last mark for a learner counts");
});

Deno.test("school days: Monday to Friday, inside a term", () => {
  // 2026-10-16 is a Friday, 2026-10-19 a Monday.
  assertEquals(schoolDays("2026-10-16", "2026-10-20"), ["2026-10-16", "2026-10-19", "2026-10-20"]);
  assertEquals(schoolDays("2026-10-16", "2026-10-20", [{ starts_on: "2026-10-19", ends_on: "2026-12-01" }]), ["2026-10-19", "2026-10-20"]);
});

Deno.test("a learner's record: rate, the run of absences, and when to follow them up", () => {
  const days = (statuses: string[]) => statuses.map((status, i) => ({ day: `2026-10-${String(i + 1).padStart(2, "0")}`, status }));
  const steady = learnerRecord(days(["present", "late", "present", "present", "present", "present", "present", "present", "present", "absent"]));
  assertEquals([steady.rate, steady.streak, steady.followUp], [90, 1, false], "90% is not below the line");
  const missing = learnerRecord(days(["present", "absent", "present", "absent", "present", "present", "present", "present", "present", "present"]));
  assertEquals([missing.rate, missing.followUp], [80, true], "one day in five missed");
  const run = learnerRecord(days(["present", "absent", "excused", "absent"]));
  assertEquals([run.streak, run.followUp], [3, true], "three school days running, even before five days are on the register");
  const early = learnerRecord(days(["absent", "present"]));
  assertEquals(early.followUp, false, "two days aren't a pattern");
  assertEquals(run.recent, ["present", "absent", "excused", "absent"]);
});

Deno.test("adding registers up: from their own counts; registers due and taken; the sheet from the marks", () => {
  const reg = (id: string, cls: string, day: string, p: number, l: number, a: number, e: number): RegisterRow =>
    ({ id, class_id: cls, school_id: "s", taken_on: day, present: p, late: l, absent: a, excused: e });
  const registers = [reg("r1", "c1", "2026-10-19", 8, 1, 1, 0), reg("r2", "c1", "2026-10-20", 9, 0, 0, 1), reg("r3", "c2", "2026-10-19", 5, 0, 5, 0)];
  const s = summarizeAttendance({
    registers, days: ["2026-10-19", "2026-10-20"], groupOf: (r) => r.class_id,
    groups: new Map([["c1", { label: "Grade 4 East", classes: 1 }], ["c2", { label: "Grade 5 East", classes: 1 }]]),
    marks: [{ register_id: "r1", learner_id: "k", status: "absent", reason: null }, { register_id: "r2", learner_id: "k", status: "excused", reason: "sick" }],
    learners: new Map([["k", { name: "Kid" }]]), grid: true,
  });
  assertEquals(s.totals.marks, 30);
  assertEquals(s.totals.rate, 76.7, "23 of 30 there (present or late)");
  assertEquals([s.totals.due, s.totals.taken, s.totals.coverage], [4, 3, 75], "two classes × two days due; three taken");
  assertEquals(s.groups.map((g) => [g.label, g.rate, g.coverage]), [["Grade 4 East", 90, 100], ["Grade 5 East", 50, 50]]);
  assertEquals(s.byWeekday.map((d) => d.rate), [70, 90, null, null, null], "Monday: 14 of 20; Tuesday: 9 of 10");
  assertEquals(s.reasons, { sick: 1, family: 0, permission: 0, other: 0, none: 1 });
  assertEquals(s.learners[0].streak, 2);
  assertEquals(s.grid?.rows[0].marks, ["absent", "excused"]);
});

Deno.test("attendance and marks: compared only when two groups each have three learners", () => {
  const rates = new Map([["a", 95], ["b", 92], ["c", 100], ["d", 70], ["e", 60], ["f", 75], ["g", 85]]);
  const marks = new Map([["a", 80], ["b", 70], ["c", 75], ["d", 50], ["e", 40], ["f", 45], ["g", 60]]);
  assertEquals(attendanceAndMarks(rates, marks), [
    { label: "90% or more", learners: 3, averagePercent: 75 },
    { label: "Below 80%", learners: 3, averagePercent: 45 },
  ], "80–89% has one learner: left out");
  assertEquals(attendanceAndMarks(new Map([["a", 95]]), marks), null);
});

Deno.test("comparing subjects: best and weakest only on enough marked work", () => {
  const a = (id: string, subjectId: string, grade: string) => ({ id, schoolId: "s", classId: grade, subjectId, grade, termId: "2026-T3", yearId: "2026", dueAt: null, status: "published" });
  const pairs: Pair[] = [];
  const marked = (asg: ReturnType<typeof a>, pcts: number[]) => pcts.forEach((p, i) => pairs.push({ a: asg, learnerId: `k${i}`, sub: { assignmentId: asg.id, learnerId: `k${i}`, status: "marked", isLate: false, percentage: p } }));
  marked(a("m4", "maths", "Grade 4"), [80, 90, 70, 85, 75]);
  marked(a("e4", "english", "Grade 4"), [50, 60, 40, 55, 45]);
  marked(a("s5", "science", "Grade 5"), [100, 100]); // too little to rank
  const bands = [{ code: "EE", label: "Exceeding", minPercent: 80 }, { code: "ME", label: "Meeting", minPercent: 50 }, { code: "BE", label: "Below", minPercent: 0 }];
  const c = compareResults(pairs, "grade", bands);
  assertEquals([c.best, c.weakest], ["maths", "english"], "science's two marks are 100% but aren't enough to rank");
  assertEquals(c.subjects.find((s) => s.key === "science")?.enough, false);
  assertEquals(c.cells.find((x) => x.row === "Grade 4" && x.subject === "maths")?.averagePercent, 80);
  assertEquals(c.rows.map((r) => r.key).sort(), ["Grade 4", "Grade 5"]);
  assertEquals(c.subjects.find((s) => s.key === "maths")?.terms.map((t) => t.key), ["2026-T3"]);
});

/* ------------------------------------------------------------ the register, through the API */

Deno.test("taking a register: the teacher ticks who is present; it's kept, counted and audited", async () => {
  const db = freshWorld();
  classOfFive(db);
  const before = await call("GET", "/attendance/register?classId=cls_1", TEACHER);
  assertEquals(before.status, 200);
  assertEquals(before.json.register, null, "not taken yet");
  assertEquals(before.json.canTake, true);
  assertEquals(before.json.learners.length, 5);
  assert(before.json.learners.every((l: Row) => l.status === null));

  const res = await call("PUT", "/attendance/register", TEACHER, { classId: "cls_1", date: TODAY, baseUpdatedAt: null, marks: [
    { learnerId: "learner-id", status: "present" }, { learnerId: "l2", status: "present" }, { learnerId: "l3", status: "late" },
    { learnerId: "l4", status: "absent" }, { learnerId: "l5", status: "excused", reason: "sick" },
  ] });
  assertEquals(res.status, 200, JSON.stringify(res.json));
  assertEquals(res.json.counts, { marks: 5, present: 2, late: 1, absent: 1, excused: 1, rate: 60 });
  assertEquals(res.json.register.takenBy, "teacher person");
  assertEquals(db.attendance_registers.length, 1);
  assertEquals([db.attendance_registers[0].present, db.attendance_registers[0].late, db.attendance_registers[0].absent, db.attendance_registers[0].excused], [2, 1, 1, 1],
    "the register keeps its own counts");
  assertEquals(db.attendance_marks.find((m) => m.learner_id === "l5")?.reason, "sick");
  const taken = db.audit_log.find((x) => x.action === "attendance.taken");
  assertEquals(taken?.details.present, 2);

  // A correction: Daudi came in late after all. Only his mark changes; the change is audited.
  const fixed = await call("PUT", "/attendance/register", TEACHER, { classId: "cls_1", date: TODAY, baseUpdatedAt: res.json.register.updatedAt,
    marks: [{ learnerId: "l4", status: "late" }] });
  assertEquals(fixed.status, 200);
  assertEquals(fixed.json.counts, { marks: 5, present: 2, late: 2, absent: 0, excused: 1, rate: 80 }, "the others keep their marks");
  assertEquals(db.attendance_registers.length, 1, "still one register for the day");
  const corrected = db.audit_log.find((x) => x.action === "attendance.corrected");
  assertEquals(corrected?.details.changes, [{ learnerId: "l4", from: "absent", to: "late" }]);
  assertEquals(db.attendance_registers[0].late, 2);

  // Saving the same marks again changes nothing, and audits nothing.
  const n = db.audit_log.length;
  await call("PUT", "/attendance/register", TEACHER, { classId: "cls_1", date: TODAY, marks: [{ learnerId: "l4", status: "late" }] });
  assertEquals(db.audit_log.length, n);
});

Deno.test("register rules: only the class's teacher, its learners, no future days, nothing before the school year", async () => {
  const db = freshWorld();
  classOfFive(db);
  assertEquals((await take(TODAY, { "learner-b-id": "present" })).status, 400, "a learner from another school's class");
  const tomorrow = new Date(Date.parse(`${TODAY}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
  assertEquals((await take(tomorrow, { "learner-id": "present" })).status, 400, "a day that hasn't come");
  assertEquals((await take("2025-06-02", { "learner-id": "present" })).status, 400, "before the school year");
  assertEquals((await take(TODAY, { "learner-id": "present" }, "tok_teacher2")).status, 404, "teacher2 doesn't teach Grade 4 East: not theirs to see");
  assertEquals((await take(TODAY, { "learner-id": "present" }, "tok_teacher_b")).status, 404, "another school's teacher doesn't see the class");
  assertEquals((await take(TODAY, { "learner-id": "present" }, "tok_school_leader")).status, 403, "the head sees registers but doesn't take them");
  assertEquals((await call("GET", "/attendance/register?classId=cls_1", "tok_school_leader")).json.canTake, false);
  assertEquals((await call("GET", "/attendance/register?classId=cls_1", "tok_head_b")).status, 404, "another school's head");
  assertEquals(db.attendance_registers.length, 0);
});

Deno.test("a register changed by someone else since it was opened is a clash, not an overwrite", async () => {
  const db = freshWorld();
  classOfFive(db);
  db.class_teachers.push({ id: "ct_x", class_id: "cls_1", teacher_id: "teacher2-id", role: "subject_teacher", ended_at: null });
  const first = await take(TODAY, { "learner-id": "present", l2: "present" }, TEACHER, { baseUpdatedAt: null });
  assertEquals(first.status, 200);
  // The second teacher opened the register before it was taken (offline), and sends theirs now.
  const late = await take(TODAY, { "learner-id": "absent" }, "tok_teacher2", { baseUpdatedAt: null, clientSavedAt: daysBefore(0) + "T05:00:00.000Z" });
  assertEquals(late.status, 409);
  assertEquals(late.json.conflict.kind, "register_changed");
  assertEquals(late.json.conflict.server.counts.present, 2, "the register as it is now comes back with it");
  assertEquals(db.attendance_marks.find((m) => m.learner_id === "learner-id")?.status, "present", "nothing overwritten");
  // "Keep my marks" in the Sync center sends it again with force.
  const forced = await take(TODAY, { l2: "late" }, "tok_teacher2", { baseUpdatedAt: null, force: true });
  assertEquals(forced.status, 200);
  assertEquals(db.attendance_marks.find((m) => m.learner_id === "l2")?.status, "late");
  // Having seen it, they can change it.
  const ok = await take(TODAY, { "learner-id": "absent" }, "tok_teacher2", { baseUpdatedAt: first.json.register.updatedAt });
  assertEquals(ok.status, 200);
  assertEquals(ok.json.register.updatedBy, "Second Teacher");
});

Deno.test("today's registers and the term so far: classes taken or not, learners to follow up, the sheet", async () => {
  const db = freshWorld();
  classOfFive(db);
  const days = lastSchoolDays(5);
  for (const d of days) await take(d, { "learner-id": "present", l2: "present", l3: "present", l4: "absent", l5: d === days[0] ? "absent" : "present" });
  await take(TODAY, { "learner-id": "present", l2: "late", l3: "present", l4: "absent", l5: "present" });

  const today = await call("GET", "/attendance/today", TEACHER);
  assertEquals(today.status, 200);
  assertEquals(today.json.classes.map((k: Row) => k.name), ["Grade 4 East"], "the teacher's own classes");
  assertEquals(today.json.classes[0].register.rate, 80);
  const head = await call("GET", "/attendance/today", "tok_school_leader");
  assertEquals(head.json.classes.map((k: Row) => [k.name, !!k.register]), [["Grade 4 East", true], ["Grade 5 East", false]], "the head sees every class, taken or not");
  assertEquals([head.json.totals.taken, head.json.totals.classes], [1, 1], "Grade 5 East has no learners: no register due");

  // The register remembers each learner's days before today.
  const reg = await call("GET", "/attendance/register?classId=cls_1", TEACHER);
  const daudi = reg.json.learners.find((l: Row) => l.id === "l4");
  assertEquals([daudi.before.days, daudi.before.rate, daudi.before.streak, daudi.before.followUp], [5, 0, 5, true]);

  const from = days[0];
  const sum = await call("GET", `/attendance/summary?classId=cls_1&from=${from}`, TEACHER);
  assertEquals(sum.status, 200, JSON.stringify(sum.json));
  assertEquals(sum.json.totals.registers, 6);
  assertEquals(sum.json.learners[0].name, "Daudi K.", "the lowest attendance first");
  assertEquals(sum.json.totals.followUp, 2, "Daudi (never there) and Chebet, away one day in six (83%)");
  assertEquals(sum.json.grid.days.length, 6);
  assertEquals(sum.json.grid.rows.find((r: Row) => r.id === "l4").marks.every((m: string) => m === "absent"), true);

  // A school head: the school by class; another school's head: nothing of this one.
  const school = await call("GET", `/attendance/summary?from=${from}`, "tok_school_leader");
  assertEquals(school.json.groups.map((g: Row) => [g.label, g.registers, g.due > 0]), [["Grade 4 East", 6, true], ["Grade 5 East", 0, false]],
    "a class with no learners has no registers due");
  const other = await call("GET", `/attendance/summary?from=${from}`, "tok_head_b");
  assertEquals(other.json.totals.registers, 0);
  // The programme: by school, without the learners.
  const programme = await call("GET", `/attendance/summary?from=${from}`, "tok_education_team");
  assertEquals(programme.json.by, "school");
  assertEquals(programme.json.learnersShown, false);
  assertEquals(programme.json.groups.find((g: Row) => g.key === "sch_1")?.registers, 6);
});

Deno.test("comparing subjects through the API: which subject does best, by class", async () => {
  const db = freshWorld();
  classOfFive(db);
  const kids = ["learner-id", "l2", "l3", "l4", "l5"];
  for (const k of kids.slice(1)) db.learner_enrollments.push({ id: `enr_${k}`, learner_id: k, school_id: "sch_1", class_id: "cls_1", academic_year_id: "2026", term_id: "2026-T3", grade: "Grade 4", status: "ACTIVE", enrollment_date: "2026-09-01" });
  const asg = (id: string, subject: string) => db.assignments.push({ ...db.assignments[0], id, subject_id: subject, title: id });
  asg("asg_m", "mathematics");
  asg("asg_e", "english");
  kids.forEach((k, i) => {
    db.assignment_submissions.push({ id: `s_m${i}`, assignment_id: "asg_m", learner_id: k, status: "marked", is_late: false, percentage: 70 + i * 5, submitted_at: `${TODAY}T08:00:00Z` });
    db.assignment_submissions.push({ id: `s_e${i}`, assignment_id: "asg_e", learner_id: k, status: "marked", is_late: false, percentage: 40 + i * 5, submitted_at: `${TODAY}T08:00:00Z` });
  });
  const res = await call("GET", "/results/compare?rows=class", TEACHER);
  assertEquals(res.status, 200, JSON.stringify(res.json));
  assertEquals(res.json.best?.label, "Mathematics");
  assertEquals(res.json.weakest?.label, "English");
  assertEquals(res.json.subjects[0].label, "Mathematics", "best first");
  assertEquals(res.json.rows.map((r: Row) => r.label), ["Grade 4 East"]);
  assert(res.json.cells.some((x: Row) => x.subject === "english" && x.averagePercent === 50));
  // Another school's teacher sees none of it.
  const other = await call("GET", "/results/compare?rows=class", "tok_teacher_b");
  assertEquals(other.json.best, null);
  assertEquals((await call("GET", "/results/compare?rows=subject", TEACHER)).status, 400);
});

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;
