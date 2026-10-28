/**
 * Data accuracy through the API: the same records give the same figure on
 * every page that shows it, and a read that fails is an error — never zero.
 * The real app on the in-memory test world (test_world.ts).
 *
 *   cd supabase/functions/api
 *   deno test --allow-env --allow-read --config deno.json data_accuracy_api_test.ts
 */
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { call, freshWorld, SCHOOL, SCHOOL_B } from "./test_world.ts";

const now = new Date().toISOString();

/** Library opens like production's: one under a stale name, two by HPF staff (one recorded under an old role). */
function withOpens() {
  const db = freshWorld();
  db.library_interactions = [
    { id: "o1", library_item_id: "lib_1", actor_kind: "staff", actor_id: "teacher-id", role: "teacher", school: "meru", started_at: now, duration_seconds: 300 },
    { id: "o2", library_item_id: "lib_1", actor_kind: "staff", actor_id: "teacher-id", role: "teacher", school: SCHOOL.name, started_at: now, duration_seconds: 120 },
    { id: "o3", library_item_id: "lib_1", actor_kind: "staff", actor_id: "teacher_b-id", role: "teacher", school: SCHOOL_B.name, started_at: now, duration_seconds: 60 },
    { id: "o4", library_item_id: "lib_1", actor_kind: "staff", actor_id: "super_admin-id", role: "education_team", school: "HPF", started_at: now, duration_seconds: 60 },
    { id: "o5", library_item_id: "lib_1", actor_kind: "staff", actor_id: "education_team-id", role: "education_team", school: "", started_at: now, duration_seconds: 60 },
  ];
  return db;
}
type Section = { title: string; rows: { opens: number }[] };
const exportOpens = (json: Record<string, unknown>) =>
  (json.sections as Section[]).find((s) => s.title === "By resource")!.rows.reduce((t, r) => t + r.opens, 0);

Deno.test("accuracy API: library opens agree on the dashboards, Content usage and the export — HPF staff left out of all three", async () => {
  withOpens();
  const impact = (await call("GET", "/impact", "tok_super_admin")).json;
  const usage = (await call("GET", "/library/usage", "tok_super_admin")).json;
  const report = await call("GET", "/reports/library-usage", "tok_super_admin");
  assertEquals(report.status, 200);
  assertEquals(impact.resources.opens, 3);
  assertEquals(usage.totals.sessions, 3);
  assertEquals(exportOpens(report.json), 3, "the export no longer counts HPF staff checking content");
  assertEquals(impact.resources.hpf.opens, 2);
});

Deno.test("accuracy API: an open recorded under a stale name counts at the reader's school, on every page", async () => {
  withOpens();
  const q = `?school=${encodeURIComponent(SCHOOL.name)}`;
  const impact = (await call("GET", `/impact${q}`, "tok_super_admin")).json;
  const usage = (await call("GET", `/library/usage${q}`, "tok_super_admin")).json;
  const report = (await call("GET", `/reports/library-usage${q}`, "tok_super_admin")).json;
  assertEquals([impact.resources.opens, usage.totals.sessions, exportOpens(report)], [2, 2, 2], "the teacher's two opens at Aitong, one recorded as “meru”");
});

Deno.test("accuracy API: a new open records the school the reader's account is linked to, by its registered name", async () => {
  const db = freshWorld();
  const me = db.profiles.find((p) => p.id === "teacher-id")!;
  me.school = "aitong pri"; // a stale name typed on the account
  const res = await call("POST", "/library/lib_1/interactions", "tok_teacher", {});
  assert(res.status < 300, JSON.stringify(res.json));
  assertEquals(db.library_interactions.at(-1)!.school, SCHOOL.name);
});

Deno.test("accuracy API: the Administration overview — a read that fails is an error, never a page of zeros", async () => {
  const db = freshWorld();
  (db as unknown as { __fail_reads: string[] }).__fail_reads = ["class_teachers"];
  const res = await call("GET", "/admin/overview", "tok_admin");
  assertEquals(res.status, 500);
  assertMatch(res.json.error, /Couldn't read the programme's records/);
});

Deno.test("accuracy API: the Administration overview and the dashboards count the same learners, teachers and schools", async () => {
  freshWorld();
  const admin = (await call("GET", "/admin/overview", "tok_super_admin")).json;
  const impact = (await call("GET", "/impact", "tok_super_admin")).json;
  assertEquals(admin.people.learners, impact.executive.learners);
  assertEquals(admin.people.teachers, impact.executive.teachers);
  assertEquals(admin.organisation.schools, impact.executive.schools);
  assertEquals(admin.results.kpis.find((k: { key: string }) => k.key === "learners").value, impact.executive.learners);
});
