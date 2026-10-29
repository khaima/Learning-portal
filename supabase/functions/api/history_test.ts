/**
 * The change history (history.ts; docs/RBAC.md §15): every add, edit and
 * delete, by every role — who, when, before and after — and putting back
 * what was deleted or undoing an edit.
 *
 * Runs on the stand-in database (test_world.ts), which keeps the history the
 * way the database's trigger does; the trigger itself is checked on real
 * Postgres by tests/change-history.test.mjs.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { call, freshWorld, twoCounties, assign, type Row, type Db } from "./test_world.ts";
import { KINDS } from "./history.ts";

const log = (db: Db) => (db.change_log ?? []) as Row[];
const last = (db: Db, table: string, op?: string) => log(db).findLast((x) => x.table_name === table && (!op || x.op === op))!;
const history = async (tok: string, qs = "") => (await call("GET", `/changes${qs ? `?${qs}` : ""}`, tok)).json;

Deno.test("every change is recorded with who made it, their role and the request — whoever they are", async () => {
  const db = freshWorld();
  assertEquals((await call("PATCH", "/schools/sch_1", "tok_super_admin", { name: "Aitong Primary School" })).status, 200);
  assertEquals((await call("POST", "/library/folders", "tok_education_team", { name: "Term 3 worksheets" })).status, 200);
  assertEquals((await call("PATCH", "/learners/learner-id", "tok_teacher", { fullName: "Kid Uno" })).status, 200);
  const school = last(db, "schools", "update");
  assertEquals([school.actor_id, school.actor_role, school.actor_kind, school.changed], ["super_admin-id", "super_admin", "staff", ["name"]]);
  assertEquals([school.old_row.name, school.new_row.name, school.route], ["Aitong Primary", "Aitong Primary School", "PATCH /api/schools/sch_1"]);
  const folder = last(db, "library_folders", "insert");
  assertEquals([folder.actor_id, folder.actor_role], ["education_team-id", "education_team"]);
  const kid = last(db, "learners", "update");
  assertEquals([kid.actor_id, kid.actor_role, kid.school_id, kid.county], ["teacher-id", "teacher", "sch_1", "Narok"]);
  assert(new Set([school.request_id, folder.request_id, kid.request_id]).size === 3, "each request is its own action");

  // The Super Admin reads it: names, roles, the record, before and after.
  const h = await history("tok_super_admin");
  const e = h.entries.find((x: Row) => x.table === "schools" && x.action === "edited");
  assertEquals([e.actor.name, e.actor.roleLabel, e.kind, e.record.name], ["super_admin person", "Super Admin", "School", "Aitong Primary School"]);
  assertEquals(e.fields, [{ field: "name", label: "Name", before: "Aitong Primary", after: "Aitong Primary School", changed: true }]);
  const t = h.entries.find((x: Row) => x.table === "learners");
  assertEquals([t.actor.name, t.actor.roleLabel, t.place.school, t.place.county], ["teacher person", "Teacher", "Aitong Primary School", "Narok"], "the school as it's called now");
  assertEquals(h.entries.map((x: Row) => x.id), [...h.entries.map((x: Row) => x.id)].sort((a: number, b: number) => b - a), "newest first");
});

Deno.test("a PIN change is recorded as a change, never with the PIN", async () => {
  const db = freshWorld();
  assertEquals((await call("PATCH", "/learners/learner-id", "tok_teacher", { pin: "5678" })).status, 200);
  const e = last(db, "learners", "update");
  assert(e.changed.includes("pin_hash"), JSON.stringify(e.changed));
  assert(!JSON.stringify(log(db)).includes("pin_hash\":"), "no PIN hash in the history");
  const shown = (await history("tok_super_admin", "table=learners")).entries[0];
  assertEquals(shown.hidden, ["PIN"]);
  assertEquals(shown.putBack.can, false);
});

Deno.test("who sees what: the Super Admin everything; the Programme Admin learning and education in their area; nobody else", async () => {
  const db = twoCounties();
  await call("PATCH", "/users/teacher2-id", "tok_super_admin", { fullName: "Teacher Two" });
  await call("PATCH", "/schools/sch_1", "tok_super_admin", { name: "Aitong Primary School" });
  await call("PATCH", `/schools/${"sch_3"}`, "tok_super_admin", { name: "Meru Central School" });
  const sa = await history("tok_super_admin");
  assert(sa.entries.some((x: Row) => x.table === "profiles"), "accounts: the Super Admin's");
  assert(sa.filters.kinds.some((k: Row) => k.table === "profiles") && sa.filters.kinds.some((k: Row) => k.table === "me_indicators"));
  for (const tok of ["tok_admin", "tok_education_team"]) {
    const pa = await history(tok);
    assert(!pa.entries.some((x: Row) => x.table === "profiles"), `${tok}: no accounts`);
    assertEquals(pa.entries.filter((x: Row) => x.table === "schools").length, 2, tok);
    assert(!pa.filters.kinds.some((k: Row) => ["profiles", "kobo_config", "permission_grants", "me_indicators"].includes(k.table)), tok);
    assertEquals((await call("GET", "/changes?table=profiles", tok)).json.entries, [], `${tok}: asking for accounts by name gets nothing`);
  }
  // Narrowed to Meru: Meru's changes only.
  assign(db, "admin-id", [{ county: "Meru" }]);
  const meru = await history("tok_admin");
  assert(meru.entries.every((x: Row) => x.place.county === "Meru"), JSON.stringify(meru.entries.map((x: Row) => x.place)));
  // Renaming a school also renames it on its learners' records: one action, one row.
  const renamed = meru.entries.find((x: Row) => x.table === "schools");
  assertEquals([renamed.record.name, renamed.together >= 1], ["Meru Central School", true]);
  const parts = (await call("GET", `/changes/${renamed.id}`, "tok_admin")).json;
  assert(parts.together.some((x: Row) => x.table === "learners" && x.record.name === "Kid C"), "Kid C's record, renamed with it");
  assertEquals(parts.togetherCount, parts.together.length);
  assertEquals(meru.scope, "Learning and education — Meru County");
  const other = log(db).findLast((x) => x.table_name === "schools" && x.record_id === "sch_1")!;
  assertEquals((await call("GET", `/changes/${other.id}`, "tok_admin")).status, 404, "another county's change doesn't exist for them");
  for (const tok of ["tok_me", "tok_field_officer", "tok_school_leader", "tok_teacher", "hpl_learnertoken"]) {
    assertEquals((await call("GET", "/changes", tok)).status, 403, tok);
  }
});

Deno.test("a deleted folder comes back, with its items back in it — once", async () => {
  const db = freshWorld();
  const { folder } = (await call("POST", "/library/folders", "tok_education_team", { name: "Grade 4 maths" })).json;
  db.library_items.push({ id: "lib_f1", title: "Fractions sheet", audience: "library", folder_id: folder.id, files: [{ path: "f1.pdf" }], published: true });
  assertEquals((await call("DELETE", `/library/folders/${folder.id}`, "tok_education_team")).status, 200);
  assertEquals(db.library_items.find((i) => i.id === "lib_f1")!.folder_id, null, "the database leaves its items unfiled");
  const del = last(db, "library_folders", "delete");

  // In the Deleted list, with a way back.
  const deleted = await history("tok_education_team", "show=deleted");
  const d = deleted.entries.find((x: Row) => x.id === del.id);
  assertEquals([d.action, d.record.name, d.putBack.action, d.putBack.can], ["deleted", "Grade 4 maths", "restore", true]);
  const detail = (await call("GET", `/changes/${del.id}`, "tok_education_team")).json;
  assertEquals(detail.together.map((x: Row) => [x.table, x.action]), [["library_items", "edited"]], "what the same action did beside it");

  const res = await call("POST", `/changes/${del.id}/restore`, "tok_education_team", { note: "Deleted by mistake" });
  assertEquals([res.status, res.json.restored, res.json.relinked], [200, 1, 1], JSON.stringify(res.json));
  assert(db.library_folders.some((f) => f.id === folder.id && f.name === "Grade 4 maths"));
  assertEquals(db.library_items.find((i) => i.id === "lib_f1")!.folder_id, folder.id, "its item is back in it");
  const a = db.audit_log.findLast((x) => x.action === "change.restored")!;
  assertEquals([a.actor_id, a.details.changeId, a.details.note], ["education_team-id", del.id, "Deleted by mistake"]);

  // Putting it back is itself in the history, and it leaves the Deleted list.
  const after = await history("tok_super_admin");
  const back = after.entries.find((x: Row) => x.table === "library_folders" && x.action === "restored");
  assertEquals([back.actor.name, back.record.name], ["education_team person", "Grade 4 maths"]);
  const was = after.entries.find((x: Row) => x.id === del.id);
  assertEquals([was.backAgain.by, was.putBack.can, was.putBack.why], ["education_team person", false, "It's back already."]);
  assert(!(await history("tok_super_admin", "show=deleted")).entries.some((x: Row) => x.id === del.id));
  assertEquals((await call("POST", `/changes/${del.id}/restore`, "tok_education_team", {})).status, 409, "only once");
});

Deno.test("a deleted library item keeps its files, so it comes back whole", async () => {
  const db = freshWorld();
  db.library_items.push({ id: "lib_x", title: "Reading cards", audience: "library", folder_id: null, files: [{ path: "lib/x.pdf", name: "x.pdf" }], published: true });
  let removed: string[] = [];
  const storage = (db as unknown as { __storage_removed?: string[] });
  assertEquals((await call("DELETE", "/library/lib_x", "tok_education_team")).status, 200);
  removed = storage.__storage_removed ?? [];
  assertEquals(removed, [], "nothing removed from storage");
  const del = last(db, "library_items", "delete");
  assertEquals((await call("POST", `/changes/${del.id}/restore`, "tok_super_admin", {})).status, 200);
  assertEquals(db.library_items.find((i) => i.id === "lib_x")!.files, [{ path: "lib/x.pdf", name: "x.pdf" }]);
  assertEquals((await call("DELETE", "/library/lib_none", "tok_education_team")).status, 404);
});

Deno.test("an edit is undone only while nothing has changed it since", async () => {
  const db = freshWorld();
  await call("PATCH", "/schools/sch_1", "tok_super_admin", { name: "Aitong Primary School" });
  const first = last(db, "schools", "update");
  await call("PATCH", "/schools/sch_1", "tok_education_team", { name: "Aitong Pri. School" });
  const second = last(db, "schools", "update");
  const early = await call("POST", `/changes/${first.id}/undo`, "tok_education_team", {});
  assertEquals(early.status, 409);
  assert(/changed again since \(Name\)/.test(early.json.error), early.json.error);
  assertEquals((await call("POST", `/changes/${second.id}/undo`, "tok_education_team", {})).status, 200);
  assertEquals(db.schools.find((s) => s.id === "sch_1")!.name, "Aitong Primary School");
  assertEquals((await call("POST", `/changes/${first.id}/undo`, "tok_education_team", { note: "Old name" })).status, 200);
  assertEquals(db.schools.find((s) => s.id === "sch_1")!.name, "Aitong Primary");
  const undone = (await history("tok_super_admin", "table=schools")).entries[0];
  assertEquals([undone.action, undone.actor.name, undone.fields[0].after], ["undone", "education_team person", "Aitong Primary"]);
  assert(db.audit_log.some((x) => x.action === "change.undone" && x.details.note === "Old name"));
  assertEquals((await call("POST", `/changes/${first.id}/restore`, "tok_super_admin", {})).status, 404, "an edit is undone, not restored");
});

Deno.test("what can't be put back from here says why; a Programme Admin puts back only what they manage", async () => {
  const db = freshWorld();
  // A learner's details: changed on Learners, where enrolment is kept right.
  await call("PATCH", "/learners/learner-id", "tok_teacher", { fullName: "Kid Uno" });
  const kid = last(db, "learners", "update");
  const shown = (await history("tok_super_admin", "table=learners")).entries[0];
  assertEquals([shown.putBack.can, shown.putBack.why], [false, KINDS.learners.why]);
  assertEquals((await call("POST", `/changes/${kid.id}/undo`, "tok_super_admin", {})).status, 409);
  // A teacher's draft assignment and its questions: the Super Admin can put them back; a Programme Admin can't.
  db.assignments.push({ id: "asg_d", school_id: "sch_1", class_id: "cls_1", subject_id: "mathematics", grade: "Grade 4", title: "Draft quiz", status: "draft",
    max_marks: 2, created_by: "teacher-id", created_at: new Date().toISOString() });
  db.assignment_questions.push({ id: "q_d1", assignment_id: "asg_d", position: 1, type: "teacher_marked", prompt: "Why?", options: [], answer_key: null, max_marks: 2 });
  assertEquals((await call("DELETE", "/assignments/asg_d", "tok_teacher")).status, 200);
  const del = last(db, "assignments", "delete");
  const pa = (await history("tok_education_team", "show=deleted")).entries.find((x: Row) => x.id === del.id);
  assertEquals([pa.putBack.can, pa.actor.name], [false, "teacher person"]);
  assertEquals((await call("POST", `/changes/${del.id}/restore`, "tok_education_team", {})).status, 403);
  const res = await call("POST", `/changes/${del.id}/restore`, "tok_super_admin", {});
  assertEquals([res.status, res.json.restored], [200, 2], "the assignment and its question");
  assert(db.assignments.some((a) => a.id === "asg_d") && db.assignment_questions.some((q) => q.id === "q_d1"));
  // Staff accounts: changed on Users & roles.
  await call("PATCH", "/users/teacher2-id", "tok_super_admin", { fullName: "Teacher Two" });
  const acct = last(db, "profiles", "update");
  assertEquals((await call("POST", `/changes/${acct.id}/undo`, "tok_super_admin", {})).status, 409);
  // M&E, teachers: no history at all.
  assertEquals((await call("POST", `/changes/${del.id}/restore`, "tok_me", {})).status, 403);
});

Deno.test("filters: kind of record, what happened, who, their role, dates; and older pages", async () => {
  const db = freshWorld();
  for (let i = 0; i < 4; i++) await call("PATCH", "/schools/sch_1", "tok_super_admin", { name: `Aitong ${i}` });
  await call("PATCH", "/schools/sch_1", "tok_admin", { name: "Aitong Primary" });
  await call("POST", "/library/folders", "tok_education_team", { name: "F" });
  const ids = async (qs: string) => (await history("tok_super_admin", qs)).entries.map((x: Row) => x.id);
  assertEquals((await ids("table=library_folders")).length, 1);
  assertEquals((await ids("op=update&table=schools")).length, 5);
  assertEquals((await ids("actorId=super_admin-id&table=schools")).length, 4);
  const pa = (await history("tok_super_admin", "role=education_team")).entries;
  assertEquals([...new Set(pa.map((x: Row) => x.actor.role))].sort(), ["admin", "education_team"], "the Programme Admin under either role code");
  const today = new Date().toISOString().slice(0, 10);
  assertEquals((await ids(`from=${today}&to=${today}&table=schools`)).length, 5);
  assertEquals((await ids("to=2020-01-01")).length, 0);
  const page1 = await history("tok_super_admin", "limit=2&table=schools");
  assertEquals(page1.entries.length, 2);
  assert(page1.nextBefore && page1.filters);
  const page2 = await history("tok_super_admin", `limit=2&table=schools&before=${page1.nextBefore}`);
  assert(page2.entries.every((x: Row) => x.id < page1.entries[1].id) && page2.filters === null);
  assert(log(db).length >= 6);
});

Deno.test("the migration watches exactly the tables history.ts describes, with the same keys and bookkeeping", () => {
  const sql = Deno.readTextFileSync(new URL("../../migrations/20261029090000_change_history.sql", import.meta.url));
  const list = sql.slice(sql.indexOf("from (values"), sql.indexOf(") as x(name, keys, noise, ops)"));
  const rows = [...list.matchAll(/\('(\w+)',\s*'([\w,]+)',\s*'([^']*)',\s*'([a-z ]+)'\)/g)]
    .map(([, table, keys, noise, ops]) => ({ table, keys: keys.split(","), noise: noise ? noise.split(",") : [], editsOnly: ops === "update or delete" }));
  assertEquals(rows.map((r) => r.table).sort(), Object.keys(KINDS).sort());
  for (const r of rows) {
    const k = KINDS[r.table];
    assertEquals([r.keys, r.noise, r.editsOnly], [k.key, k.noise ?? [], !!k.editsOnly], r.table);
  }
});
