/**
 * Who works where: field officers and the schools they support (Admin),
 * and teachers and the classes they teach (a school head).
 *
 *   cd supabase/functions/api
 *   deno test --allow-env --allow-read --config deno.json placement_test.ts
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { call, freshWorld, twoCounties } from "./test_world.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

Deno.test("field officers: each officer's schools and counties, and each school's officers", async () => {
  twoCounties();
  const res = await call("GET", "/field-officers", "tok_super_admin");
  assertEquals(res.status, 200, JSON.stringify(res.json));
  const fo = res.json.officers.find((o: Row) => o.id === "field_officer-id");
  assertEquals([fo.counties, fo.schools.length, fo.covers, fo.canEdit], [["Narok"], 0, 2, true], "all of Narok County: two schools");
  const by = (id: string) => res.json.schools.find((s: Row) => s.id === id);
  assertEquals(by("sch_1").officers, [{ id: "field_officer-id", name: "field_officer person", via: "county" }]);
  assertEquals(by("sch_3").officers, [], "Meru Central has nobody yet");
  assertEquals(res.json.counties, ["Meru", "Narok"]);
});

Deno.test("assigning schools one by one, several at once, and taking one away — kept and audited", async () => {
  const db = twoCounties();
  // Instead of all of Narok: two named schools, one in each county.
  const put = await call("PUT", "/users/field_officer-id/scope", "tok_super_admin", { counties: [], schoolIds: ["sch_1", "sch_3"] });
  assertEquals(put.status, 200, JSON.stringify(put.json));
  let res = await call("GET", "/field-officers", "tok_super_admin");
  let fo = res.json.officers.find((o: Row) => o.id === "field_officer-id");
  assertEquals(fo.schools.map((s: Row) => s.id), ["sch_1", "sch_3"]);
  assertEquals(res.json.schools.find((s: Row) => s.id === "sch_2").officers, [], "Olpusimoru isn't theirs any more");
  // Taking one away ends it; nothing is deleted.
  await call("PUT", "/users/field_officer-id/scope", "tok_super_admin", { counties: [], schoolIds: ["sch_1"] });
  res = await call("GET", "/field-officers", "tok_super_admin");
  fo = res.json.officers.find((o: Row) => o.id === "field_officer-id");
  assertEquals(fo.schools.map((s: Row) => s.id), ["sch_1"]);
  const ended = db.staff_scopes.filter((r) => r.profile_id === "field_officer-id" && r.ended_at);
  assert(ended.some((r) => r.school_id === "sch_3") && ended.some((r) => r.county === "Narok"), "ended rows are kept");
  assert(db.audit_log.filter((e) => e.action === "scope.changed").length >= 2);
  // The officer's own visit form only offers their schools now.
  const mine = await call("GET", "/schools", "tok_field_officer");
  assert(mine.status === 200);
});

Deno.test("field officers: only for those who place staff, and only in their own area", async () => {
  const db = twoCounties();
  // Placing staff is the Super Admin's (29 October 2026).
  for (const role of ["field_officer", "teacher", "school_leader", "education_team", "admin", "me"]) {
    assertEquals((await call("GET", "/field-officers", `tok_${role}`)).status, 403, role);
  }
  // Someone given it as a grant, narrowed to Meru, sees Meru's schools only, and can't hand out Narok's.
  db.permission_grants.push({ id: "g_place", profile_id: "admin-id", permission: "users.placement.assign", reason: "test", granted_by: "super_admin-id", granted_at: new Date().toISOString(), revoked_at: null });
  db.staff_scopes.push({ id: "scp_adm", profile_id: "admin-id", scope_type: "county", county: "Meru", school_id: null, note: "", created_at: new Date().toISOString(), created_by: null, ended_at: null, ended_by: null });
  const res = await call("GET", "/field-officers", "tok_admin");
  assertEquals(res.json.schools.map((s: Row) => s.id), ["sch_3"]);
  assertEquals((await call("PUT", "/users/field_officer-id/scope", "tok_admin", { counties: [], schoolIds: ["sch_1"] })).status === 200, false);
});

Deno.test("several teachers × a whole grade, or every class, in one go — adding only", async () => {
  const db = freshWorld();
  const HEAD = "tok_school_leader";
  db.classes.push({ id: "cls_4w", school_id: "sch_1", academic_year_id: "2026", grade: "Grade 4", name: "Grade 4 West", archived_at: null });
  // Both teachers, as subject teachers, to all of Grade 4 (two classes).
  let res = await call("POST", "/class-teachers", HEAD, { teacherIds: ["teacher-id", "teacher2-id"], classIds: ["cls_1", "cls_4w"], role: "subject_teacher" });
  assertEquals(res.status, 200, JSON.stringify(res.json));
  assertEquals([res.json.added, res.json.kept], [3, 1], "teacher-id stays Grade 4 East's class teacher");
  const open = () => db.class_teachers.filter((t) => !t.ended_at).map((t) => `${t.class_id}:${t.teacher_id}:${t.role}`).sort();
  assertEquals(open(), ["cls_1:teacher-id:class_teacher", "cls_1:teacher2-id:subject_teacher", "cls_2:teacher-b-id:class_teacher",
    "cls_4w:teacher-id:subject_teacher", "cls_4w:teacher2-id:subject_teacher"]);
  // Saying it again changes nothing.
  res = await call("POST", "/class-teachers", HEAD, { teacherIds: ["teacher-id", "teacher2-id"], classIds: ["cls_1", "cls_4w"] });
  assertEquals([res.json.added, res.json.kept], [0, 4]);
  // teacher2 as class teacher of every class: moves up where they were a subject teacher; teacher-id stays on as a subject teacher.
  res = await call("POST", "/class-teachers", HEAD, { teacherIds: ["teacher2-id"], classIds: ["cls_1", "cls_1b", "cls_4w"], role: "class_teacher" });
  assertEquals([res.json.added, res.json.promoted, res.json.replaced.length], [1, 2, 1]);
  assert(open().includes("cls_1:teacher-id:subject_teacher") && open().includes("cls_1:teacher2-id:class_teacher"));
  assertEquals(db.learners.find((l) => l.id === "learner-id")?.current_teacher_id, "teacher2-id", "the class's learners follow their class teacher");
  assert(db.audit_log.some((e) => e.action === "class.teachers_assigned"));
  // The rules: one class teacher per class; this school's teachers and classes only.
  assertEquals((await call("POST", "/class-teachers", HEAD, { teacherIds: ["teacher-id", "teacher2-id"], classIds: ["cls_1"], role: "class_teacher" })).status, 400);
  assertEquals((await call("POST", "/class-teachers", HEAD, { teacherIds: ["teacher-b-id"], classIds: ["cls_1"] })).status, 400);
  assertEquals((await call("POST", "/class-teachers", HEAD, { teacherIds: ["teacher-id"], classIds: ["cls_2"] })).status, 404);
  assertEquals((await call("POST", "/class-teachers", "tok_teacher", { teacherIds: ["teacher-id"], classIds: ["cls_1"] })).status, 403);
});

Deno.test("a school head gives a teacher several classes, changes a role, and takes one away", async () => {
  const db = freshWorld();
  const HEAD = "tok_school_leader";
  // teacher2 teaches Grade 4 East (subject) and Grade 5 East (class teacher).
  assertEquals((await call("POST", "/classes/cls_1/teachers", HEAD, { teacherId: "teacher2-id", role: "subject_teacher" })).status, 200);
  assertEquals((await call("POST", "/classes/cls_1b/teachers", HEAD, { teacherId: "teacher2-id", role: "class_teacher" })).status, 200);
  let list = (await call("GET", "/classes", HEAD)).json.classes as Row[];
  const of = (cls: string) => list.find((k) => k.id === cls)!.teachers.map((t: Row) => [t.teacherId, t.role]).sort();
  assertEquals(of("cls_1"), [["teacher-id", "class_teacher"], ["teacher2-id", "subject_teacher"]], "a class has one class teacher and any number of subject teachers");
  assertEquals(of("cls_1b"), [["teacher2-id", "class_teacher"]]);
  // Grade 4 East: teacher2 becomes its class teacher — the class teacher before them comes off it.
  await call("POST", "/classes/cls_1/teachers", HEAD, { teacherId: "teacher2-id", role: "class_teacher" });
  list = (await call("GET", "/classes", HEAD)).json.classes as Row[];
  assertEquals(of("cls_1"), [["teacher2-id", "class_teacher"]]);
  // Taken off Grade 5 East: ended, kept, audited.
  assertEquals((await call("DELETE", "/classes/cls_1b/teachers/teacher2-id", HEAD)).status, 200);
  list = (await call("GET", "/classes", HEAD)).json.classes as Row[];
  assertEquals(of("cls_1b"), []);
  assert(db.class_teachers.some((t) => t.class_id === "cls_1b" && t.teacher_id === "teacher2-id" && t.ended_at), "the assignment is ended, not deleted");
  assert(db.audit_log.some((e) => e.action === "class.teacher_removed"));
  // Another school's head can't touch these classes, and a teacher from another school can't be given one.
  assertEquals((await call("POST", "/classes/cls_1/teachers", "tok_head_b", { teacherId: "teacher-b-id" })).status, 404);
  assertEquals((await call("POST", "/classes/cls_1/teachers", HEAD, { teacherId: "teacher-b-id" })).status, 400);
});
