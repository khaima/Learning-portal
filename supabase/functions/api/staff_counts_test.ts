/**
 * "On staff" means an active account. Every place that counts a school's
 * teachers — the head's dashboard and Teachers page (/school/overview), the
 * Counties & schools list (/schools), the school's profile, the education
 * dashboard (/stats) and the admin overview — leaves out pending,
 * suspended, rejected and deactivated accounts, so they all agree.
 *
 *   cd supabase/functions/api
 *   deno test --allow-env --allow-read --config deno.json staff_counts_test.ts
 *
 * Aitong Primary (test_world.ts) has two active teachers, one head, one
 * learner and one teacher account in each non-active state.
 */
import { assertEquals } from "jsr:@std/assert@1";
import { call, type Db, freshWorld, type Row, SCHOOL } from "./test_world.ts";

/** Gives Aitong's teachers a type: the active two are TSC and BOM. */
function typedWorld(): Db {
  const db = freshWorld();
  const type: Record<string, string> = {
    "teacher-id": "TSC", "teacher2-id": "BOM",
    "pending-id": "BOM", "suspended-id": "TSC", "rejected-id": "TSC", "deactivated-id": "BOM",
  };
  for (const p of db.profiles) if (type[p.id]) p.teacher_type = type[p.id];
  return db;
}

const byType = (rows: Row[]) => Object.fromEntries(rows.map((t) => [t.label, t.value]));

/** Aitong's teacher numbers as each page gets them. */
async function aitong() {
  const get = async (path: string, token: string) => {
    const res = await call("GET", path, token);
    assertEquals(res.status, 200, `${path}: ${JSON.stringify(res.json).slice(0, 200)}`);
    return res.json;
  };
  const overview = await get("/school/overview", "tok_school_leader");
  const listed = (await get("/schools", "tok_admin")).schools.find((s: Row) => s.id === SCHOOL.id);
  const profile = await get(`/schools/${SCHOOL.id}/profile`, "tok_admin");
  const stats = await get(`/stats?school=${encodeURIComponent(SCHOOL.name)}`, "tok_admin");
  const admin = await get("/admin/overview", "tok_admin");
  return {
    counts: {
      overview: overview.teacherCount, list: listed.teachers, profile: profile.teachers,
      stats: stats.byRole.teacher, admin: admin.people.teachers - 1, // less Teacher B at Olpusimoru
    },
    types: { overview: byType(overview.teachersByType), stats: byType(stats.teachersByType) },
    listed,
  };
}
const everywhere = (n: number) => ({ overview: n, list: n, profile: n, stats: n, admin: n });

Deno.test("staff counts: only active teacher accounts are on staff, on every page", async () => {
  typedWorld();
  const a = await aitong();
  assertEquals(a.counts, everywhere(2), "6 teacher accounts at Aitong, 2 of them active");
  assertEquals(a.types, { overview: { TSC: 1, BOM: 1 }, stats: { TSC: 1, BOM: 1 } });
  assertEquals([a.listed.teachers, a.listed.heads, a.listed.learners], [2, 1, 1], "the list reads 2 teachers · 1 head · 1 learner");
  // Removal is still blocked by everyone placed there, active or not.
  assertEquals(a.listed.placed, 8, "7 staff accounts (any status) and 1 learner");
});

Deno.test("staff counts: a suspended teacher drops off, and is back once reactivated", async () => {
  typedWorld();
  const res = await call("POST", "/users/teacher2-id/status", "tok_super_admin", { action: "suspend", reason: "On leave" });
  assertEquals(res.status, 200, JSON.stringify(res.json));
  let a = await aitong();
  assertEquals(a.counts, everywhere(1));
  assertEquals(a.types, { overview: { TSC: 1 }, stats: { TSC: 1 } }, "the suspended BOM teacher isn't counted by type");
  assertEquals(a.listed.placed, 8, "a suspended teacher is still in the school, so it can't be removed");

  assertEquals((await call("POST", "/users/teacher2-id/status", "tok_super_admin", { action: "reactivate" })).status, 200);
  a = await aitong();
  assertEquals(a.counts, everywhere(2));
  assertEquals(a.types.overview, { TSC: 1, BOM: 1 });
});

Deno.test("staff counts: a pending teacher isn't on staff until approved", async () => {
  const db = typedWorld();
  assertEquals(db.profiles.find((p) => p.id === "pending-id")!.status, "pending");
  assertEquals((await aitong()).counts, everywhere(2), "waiting for approval: not counted");

  const res = await call("POST", "/users/pending-id/approve", "tok_super_admin", {});
  assertEquals(res.status, 200, JSON.stringify(res.json));
  const a = await aitong();
  assertEquals(a.counts, everywhere(3));
  assertEquals(a.types, { overview: { TSC: 1, BOM: 2 }, stats: { TSC: 1, BOM: 2 } });
});
