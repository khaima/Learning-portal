/* The change history's database side (supabase/migrations/…_change_history.sql),
   run on real Postgres (PGlite — Postgres compiled to WebAssembly, no server).
   The API's own tests (supabase/functions/api/history_test.ts) use a stand-in
   database; this checks the trigger itself: who made the change, what it was,
   secrets left out, bookkeeping skipped, and that writing the history can
   never stop a change. */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const dir = new URL("../supabase/migrations/", import.meta.url);
const file = readdirSync(dir).find((f) => f.endsWith("_change_history.sql"));
const MIGRATION = readFileSync(new URL(file, dir), "utf8");

let db;
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;
const log = () => rows("select * from change_log order by id");
/** The headers the API sends with each request (index.ts, withActor). */
const as = (h) => db.query("select set_config('request.headers', $1, false)", [h ? JSON.stringify(h) : ""]);
const STAFF = { "x-hpf-actor-id": "u-sa", "x-hpf-actor-role": "super_admin", "x-hpf-actor-kind": "staff", "x-hpf-request-id": "req-1", "x-hpf-route": "PATCH /api/schools/sch_1" };

before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated;
    create table counties (name text primary key, code text);
    create table schools (id text primary key, name text, county text references counties(name) on update cascade on delete restrict, code text);
    create table classes (id text primary key, school_id text references schools(id), name text, grade text);
    create table learners (id text primary key, full_name text, pin_hash text, pin_salt text, school_id text, class_id text, county text,
      updated_at timestamptz, failed_attempts int default 0, locked_until timestamptz);
    create table library_folders (id text primary key, name text);
    create table library_items (id text primary key, title text, folder_id text references library_folders(id) on delete set null,
      files jsonb, embed_checked_at timestamptz, embeddable boolean);
    create table attendance_registers (id text primary key, class_id text, school_id text, taken_on date);
    create table attendance_marks (register_id text, learner_id text, status text, updated_at timestamptz, primary key (register_id, learner_id));
    create table kobo_config (id int primary key, base_url text, api_token text, webhook_secret_hash text, updated_at timestamptz);
    create table grade_bands (code text primary key, label text);
    insert into counties values ('Narok', 'NRK');
  `);
  await db.exec(MIGRATION);
});

test("an edit records who made it, from which request, and the fields before and after", async () => {
  await as(STAFF);
  await db.query("insert into schools values ('sch_1', 'Aitong Pri', 'Narok', 'NRK-001')");
  await db.query("update schools set name = 'Aitong Primary' where id = 'sch_1'");
  const [add, edit] = (await log()).filter((r) => r.table_name === "schools");
  assert.equal(add.op, "insert");
  assert.deepEqual([edit.op, edit.record_id, edit.changed], ["update", "sch_1", ["name"]]);
  assert.deepEqual([edit.old_row.name, edit.new_row.name], ["Aitong Pri", "Aitong Primary"]);
  assert.deepEqual([edit.actor_id, edit.actor_role, edit.actor_kind, edit.request_id, edit.route],
    ["u-sa", "super_admin", "staff", "req-1", "PATCH /api/schools/sch_1"]);
  assert.deepEqual([edit.school_id, edit.county], ["sch_1", "Narok"], "a school is its own place");
});

test("a record with only a class is placed at the class's school and county", async () => {
  await as({ ...STAFF, "x-hpf-actor-id": "u-head", "x-hpf-actor-role": "school_leader", "x-hpf-request-id": "req-2" });
  await db.query("insert into classes values ('cls_1', 'sch_1', 'Grade 4 East', 'Grade 4')");
  await db.query("insert into learners (id, full_name, pin_hash, pin_salt, class_id) values ('l1', 'Kid One', 'h1', 's1', 'cls_1')");
  const l = (await log()).find((r) => r.table_name === "learners");
  assert.deepEqual([l.school_id, l.county, l.actor_role], ["sch_1", "Narok", "school_leader"]);
});

test("secrets are never copied — the field's name is kept, not its value", async () => {
  await as({ ...STAFF, "x-hpf-request-id": "req-3" });
  await db.query("update learners set pin_hash = 'h2', pin_salt = 's2' where id = 'l1'");
  const e = (await log()).filter((r) => r.table_name === "learners").at(-1);
  assert.deepEqual(e.changed, ["pin_hash", "pin_salt"]);
  assert.ok(!("pin_hash" in e.old_row) && !("pin_hash" in e.new_row) && !("pin_salt" in e.new_row));
  assert.equal(e.new_row.full_name, "Kid One");

  await db.query("insert into kobo_config values (1, 'https://kf.kobotoolbox.org', 'secret-token-1', 'hash-1', now())");
  await db.query("update kobo_config set api_token = 'secret-token-2' where id = 1");
  const all = JSON.stringify(await log());
  for (const s of ["secret-token-1", "secret-token-2", "hash-1", "h1", "h2", "s1", "s2"]) assert.ok(!all.includes(`"${s}"`), `${s} leaked into the history`);
});

test("bookkeeping alone isn't a change", async () => {
  const n = (await log()).length;
  await db.query("update learners set updated_at = now(), failed_attempts = 3 where id = 'l1'");
  await db.query("update learners set full_name = full_name where id = 'l1'"); // nothing different
  assert.equal((await log()).length, n);
  await db.query("update learners set full_name = 'Kid Uno', updated_at = now() where id = 'l1'");
  assert.deepEqual((await log()).at(-1).changed, ["full_name"], "the real change, without the bookkeeping");
});

test("a delete keeps the whole record, and what it set to nothing in the same action is beside it", async () => {
  await as({ ...STAFF, "x-hpf-request-id": "req-5", "x-hpf-route": "DELETE /api/library/folders/fld_1" });
  await db.query("insert into library_folders values ('fld_1', 'Grade 4 maths')");
  await db.query("insert into library_items values ('lib_1', 'Fractions', 'fld_1', '[{\"path\":\"a.pdf\"}]', null, null)");
  await db.query("delete from library_folders where id = 'fld_1'");
  const same = (await log()).filter((r) => r.request_id === "req-5");
  const del = same.find((r) => r.op === "delete");
  assert.deepEqual([del.table_name, del.record_id, del.old_row.name, del.new_row], ["library_folders", "fld_1", "Grade 4 maths", null]);
  const unfiled = same.find((r) => r.table_name === "library_items" && r.op === "update");
  assert.deepEqual([unfiled.changed, unfiled.old_row.folder_id, unfiled.new_row.folder_id], [["folder_id"], "fld_1", null]);
});

test("a record with a two-part key is named by both; a register's marks count only when corrected", async () => {
  await db.query("insert into attendance_registers values ('reg_1', 'cls_1', 'sch_1', '2026-10-29')");
  const n = (await log()).length;
  await db.query("insert into attendance_marks values ('reg_1', 'l1', 'present', now())");
  assert.equal((await log()).length, n, "taking the register is the register's entry, not one per learner");
  await db.query("update attendance_marks set status = 'absent', updated_at = now() where register_id = 'reg_1'");
  const e = (await log()).at(-1);
  assert.deepEqual([e.table_name, e.record_id, e.changed, e.school_id], ["attendance_marks", "reg_1:l1", ["status"], "sch_1"]);
});

test("a change with no portal headers was made directly in the database", async () => {
  await as(null);
  await db.query("update schools set code = 'NRK-009' where id = 'sch_1'");
  const e = (await log()).at(-1);
  assert.deepEqual([e.actor_kind, e.actor_id, e.actor_role, e.request_id], ["database", null, null, null]);
});

test("tables it doesn't watch get no trigger", async () => {
  const n = (await log()).length;
  await db.query("insert into grade_bands values ('EE', 'Exceeding')");
  assert.equal((await log()).length, n);
});

test("the history can't be edited or deleted", async () => {
  await assert.rejects(db.query("update change_log set actor_id = 'someone-else'"), /append-only/);
  await assert.rejects(db.query("delete from change_log"), /append-only/);
});

test("if the history can't be written, the change still goes ahead", async () => {
  await db.query("alter table change_log add constraint refuse_all check (table_name = 'nothing') not valid");
  try {
    await db.query("update schools set name = 'Aitong Primary School' where id = 'sch_1'");
    assert.equal((await rows("select name from schools where id = 'sch_1'"))[0].name, "Aitong Primary School");
  } finally {
    await db.query("alter table change_log drop constraint refuse_all");
  }
});
