/**
 * Who can see what — the walls between schools, field officers' assigned
 * schools, learner PIN lockout, and accounts that aren't active.
 *
 *   cd supabase/functions/api
 *   deno test --allow-env --allow-read --config deno.json isolation_test.ts
 *
 * Runs the real API against the in-memory world in test_world.ts (no
 * database, no network). The role × route access matrix — every endpoint,
 * every role — is in authz_test.ts.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { FakeTime } from "jsr:@std/testing@1/time";
import { app, assign, call, type Db, freshWorld, NON_ACTIVE, type Row, SCHOOL, SCHOOL_B, SCHOOL_C, twoCounties } from "./test_world.ts";

/** Asserts a reply mentions none of another school's people, classes, work or names. */
function noneOf(res: { status: number; json: Row }, markers: string[], what: string) {
  assertEquals(res.status, 200, `${what}: ${res.status} ${JSON.stringify(res.json).slice(0, 200)}`);
  const text = JSON.stringify(res.json);
  for (const m of markers) assert(!text.includes(m), `${what} leaks "${m}"`);
}

/* ------------------------------------------------------------ teachers: their own school only */

/** Both schools have a learner who has handed in work; returns each submission's id. */
async function bothSchoolsHandIn(db: Db) {
  const now = new Date().toISOString();
  db.learner_sessions.push({ token: "learnerb", learner_id: "learner-b-id", created_at: now, expires_at: new Date(Date.now() + 3600e3).toISOString() });
  const hand = async (token: string, asg: string, answers: Row[]) => {
    const s = await call("POST", `/learner/assignments/${asg}/start`, token);
    assertEquals(s.status, 200, JSON.stringify(s.json));
    assertEquals((await call("POST", `/learner/assignments/${asg}/submit`, token, { answers })).status, 200);
    return (s.json.submission?.id ?? s.json.id) as string;
  };
  return {
    a: await hand("hpl_learnertoken", "asg_1", [{ questionId: "q_mc", response: 0 }, { questionId: "q_tm", response: "Two quarters" }]),
    b: await hand("hpl_learnerb", "asg_b", [{ questionId: "q_b", response: true }]),
  };
}

const SCHOOL_A_MARKERS = ["learner-id\"", "kid.one", "Kid One", "\"cls_1\"", "Grade 4 East", "asg_1", "Fractions quiz", SCHOOL.name];
const SCHOOL_B_MARKERS = ["learner-b-id", "kid.b", "Kid B", "cls_2", "Grade 4 B", "asg_b", "Reading check", SCHOOL_B.name];

/** Everything a teacher reads about learners, classes, work and results — for their school only. */
async function teacherSeesOnlyOwnSchool(token: string, own: { learner: string; cls: string; asg: string; sub: string },
  other: { learner: string; cls: string; asg: string; sub: string; school: string; markers: string[] }) {
  const lists: [string, (j: Row) => unknown[]][] = [
    ["/learners?status=all", (j) => j.learners.map((x: Row) => x.id)],
    [`/learners?status=all&schoolId=${other.school}`, (j) => j.learners.map((x: Row) => x.id)],
    ["/classes", (j) => j.classes.map((x: Row) => x.id)],
    [`/classes?schoolId=${other.school}`, (j) => j.classes.map((x: Row) => x.id)],
    ["/assignments", (j) => j.assignments.map((x: Row) => x.id)],
    [`/assignments?schoolId=${other.school}`, (j) => j.assignments.map((x: Row) => x.id)],
    ["/submissions", (j) => j.submissions.map((x: Row) => x.id)],
    [`/submissions?schoolId=${other.school}`, (j) => j.submissions.map((x: Row) => x.id)],
  ];
  for (const [path, pick] of lists) {
    const res = await call("GET", path, token);
    noneOf(res, other.markers, `${token} GET ${path}`);
    assert(pick(res.json).length > 0, `${token} GET ${path} shows their own school's records`);
  }
  // Their own records are there.
  assert((await call("GET", "/learners?status=all", token)).json.learners.some((x: Row) => x.id === own.learner));
  assert((await call("GET", "/classes", token)).json.classes.some((x: Row) => x.id === own.cls));
  assert((await call("GET", "/submissions", token)).json.submissions.some((x: Row) => x.id === own.sub));
  // Results and exports: same wall, whatever is asked for.
  for (const path of [
    "/results?by=learner", "/results?by=class", "/results?by=school", `/results?by=learner&learnerId=${other.learner}`, `/results?by=school&schoolId=${other.school}`,
    "/reports/learner-register", `/reports/learner-register?school=${other.school}`, "/reports/assignment-report", "/reports/assessment-report",
  ]) noneOf(await call("GET", path, token), other.markers, `${token} GET ${path}`);
  // The other school's records, asked for by id: as if they don't exist.
  for (const [m, path, body] of [
    ["GET", `/learners/${other.learner}/history`], ["GET", `/learners/${other.learner}/activity`],
    ["GET", `/assignments/${other.asg}`], ["GET", `/submissions/${other.sub}`],
    ["POST", `/submissions/${other.sub}/mark`, { answers: [] }],
    ["PATCH", `/learners/${other.learner}`, { fullName: "Changed" }],
    ["POST", `/classes/${other.cls}/learners`, { learnerIds: [own.learner] }],
  ] as [string, string, unknown?][]) {
    const res = await call(m, path, token, body);
    assert(res.status === 404 || res.status === 403, `${token} ${m} ${path} should be refused, got ${res.status}`);
  }
  // …while their own are reachable.
  assertEquals((await call("GET", `/learners/${own.learner}/history`, token)).status, 200);
  assertEquals((await call("GET", `/assignments/${own.asg}`, token)).status, 200);
  assertEquals((await call("GET", `/submissions/${own.sub}`, token)).status, 200);
}

Deno.test("a teacher sees only their own school's learners, classes and submissions", async () => {
  const db = freshWorld();
  const sub = await bothSchoolsHandIn(db);
  await teacherSeesOnlyOwnSchool("tok_teacher",
    { learner: "learner-id", cls: "cls_1", asg: "asg_1", sub: sub.a },
    { learner: "learner-b-id", cls: "cls_2", asg: "asg_b", sub: sub.b, school: SCHOOL_B.id, markers: [...SCHOOL_B_MARKERS, sub.b] });
  // …and the other way round.
  await teacherSeesOnlyOwnSchool("tok_teacher_b",
    { learner: "learner-b-id", cls: "cls_2", asg: "asg_b", sub: sub.b },
    { learner: "learner-id", cls: "cls_1", asg: "asg_1", sub: sub.a, school: SCHOOL.id, markers: [...SCHOOL_A_MARKERS, sub.a] });
  // Nothing was changed by the refused requests.
  assertEquals(db.learners.find((l) => l.id === "learner-b-id")!.full_name, "Kid B");
  assertEquals(db.learners.find((l) => l.id === "learner-id")!.full_name, "Kid One");
});

Deno.test("a teacher who once added a learner loses sight of them when they're in another school", async () => {
  freshWorld();
  // learner-b-id was added by teacher-id (teacher_id), but is at the other school now.
  const list = await call("GET", "/learners?status=all", "tok_teacher");
  assertEquals(list.json.learners.map((l: Row) => l.id), ["learner-id"]);
  assertEquals((await call("GET", "/learners/learner-b-id/history", "tok_teacher")).status, 404);
});

/* ------------------------------------------------------------ field officers: their assigned schools only */

const MERU = ["Meru Central", "sch_3", "Teacher C", "fr_m"];
const NAROK = [SCHOOL.name, SCHOOL_B.name, "sch_1", "sch_2", "Second Teacher", "Teacher B", "fr_n"];

async function fieldOfficerSees(expectSchools: string[], hidden: string[]) {
  const schools = await call("GET", "/schools", "tok_field_officer");
  assertEquals(schools.json.schools.map((s: Row) => s.id).sort(), expectSchools);
  for (const path of ["/schools", "/teachers", "/field-reports", "/reports/school-register", "/reports/teacher-register", "/reports/field-visit-report"]) {
    noneOf(await call("GET", path, "tok_field_officer"), hidden, `field officer GET ${path}`);
  }
}

Deno.test("field officers see only the schools assigned to them", async () => {
  const db = twoCounties(); // the officer has visited one school in each county (fr_n, fr_m)
  // Assigned Narok County: its two schools — nothing from Meru.
  await fieldOfficerSees([SCHOOL.id, SCHOOL_B.id], MERU);
  assertEquals((await call("GET", "/field-reports", "tok_field_officer")).json.reports.map((r: Row) => r.id), ["fr_n"]);
  assertEquals((await call("GET", `/schools/${SCHOOL_C.id}/profile`, "tok_field_officer")).status, 404);
  assertEquals((await call("POST", "/field-reports", "tok_field_officer", { schoolId: SCHOOL_C.id, visitType: "ICT", responses: [], clientRef: "ref-meru-001" })).status, 403);

  // Reassigned to one Meru school: Narok disappears — including their own earlier Narok visit.
  db.staff_scopes.length = 0;
  assign(db, "field_officer-id", [{ school_id: SCHOOL_C.id }]);
  await fieldOfficerSees([SCHOOL_C.id], NAROK);
  assertEquals((await call("GET", "/field-reports", "tok_field_officer")).json.reports.map((r: Row) => r.id), ["fr_m"]);
  assertEquals((await call("GET", `/schools/${SCHOOL.id}/profile`, "tok_field_officer")).status, 404);
  assertEquals((await call("GET", `/schools/${SCHOOL_C.id}/profile`, "tok_field_officer")).status, 200);
  assertEquals((await call("POST", "/field-reports", "tok_field_officer", { schoolId: SCHOOL.id, visitType: "ICT", responses: [], clientRef: "ref-narok-01" })).status, 403);
  assertEquals((await call("POST", "/field-reports", "tok_field_officer", { schoolId: SCHOOL_C.id, visitType: "ICT", responses: [], clientRef: "ref-meru-002" })).status, 200);

  // Nothing assigned: no schools, no teachers, no visits.
  db.staff_scopes.length = 0;
  await fieldOfficerSees([], [...NAROK, ...MERU]);
  assertEquals((await call("GET", "/field-reports", "tok_field_officer")).json.reports, []);
  assertEquals((await call("POST", "/field-reports", "tok_field_officer", { schoolId: SCHOOL_C.id, visitType: "ICT", responses: [], clientRef: "ref-none-001" })).status, 403);

  // Never learners, in any school.
  assertEquals((await call("GET", "/learners", "tok_field_officer")).status, 403);
});

/* ------------------------------------------------------------ learner PIN lockout */

const login = (username: string, pin: string) => call("POST", "/learner/login", undefined, { username, pin });

Deno.test("learner PIN: locked after 5 wrong tries, open again after 15 minutes", async () => {
  const time = new FakeTime(new Date("2026-10-05T08:00:00.000Z"));
  try {
    const db = freshWorld();
    const made = await call("POST", "/learners", "tok_teacher", { fullName: "Lock Test", username: "kid.lock", pin: "2468", classId: "cls_1" });
    assertEquals(made.status, 200, JSON.stringify(made.json));
    const kid = () => db.learners.find((l) => l.username === "kid.lock")!;

    // Four wrong tries: refused, counted, not locked.
    for (let i = 1; i <= 4; i++) {
      assertEquals((await login("kid.lock", "0000")).status, 401, `try ${i}`);
      assertEquals([kid().failed_attempts, kid().locked_until ?? null], [i, null]);
    }
    // The fifth locks it for 15 minutes.
    const fifth = await login("kid.lock", "0000");
    assertEquals(fifth.status, 423);
    assertEquals(kid().locked_until, "2026-10-05T08:15:00.000Z");
    // While locked even the right PIN is refused.
    assertEquals((await login("kid.lock", "2468")).status, 423);
    time.tick(14 * 60_000 + 59_000); // 08:14:59
    assertEquals((await login("kid.lock", "2468")).status, 423, "still locked at 14 min 59 s");
    // At 15 minutes it opens again by itself, and the right PIN works.
    time.tick(1_000); // 08:15:00
    const ok = await login("kid.lock", "2468");
    assertEquals(ok.status, 200, JSON.stringify(ok.json));
    assert(ok.json.token);
    assertEquals([kid().failed_attempts, kid().locked_until], [0, null]);

    // The count starts again from zero.
    for (let i = 1; i <= 4; i++) assertEquals((await login("kid.lock", "1111")).status, 401);
    assertEquals((await login("kid.lock", "1111")).status, 423, "five more wrong tries lock it again");
  } finally {
    time.restore();
  }
});

Deno.test("learner PIN: a lockout is one learner's only; a wrong username locks nobody; a teacher can unlock early", async () => {
  const time = new FakeTime(new Date("2026-10-05T08:00:00.000Z"));
  try {
    const db = freshWorld();
    await call("POST", "/learners", "tok_teacher", { fullName: "Lock Test", username: "kid.lock", pin: "2468", classId: "cls_1" });
    await call("POST", "/learners", "tok_teacher", { fullName: "Next Kid", username: "kid.next", pin: "1357", classId: "cls_1" });
    for (let i = 0; i < 5; i++) await login("kid.lock", "0000");
    assertEquals((await login("kid.lock", "2468")).status, 423);
    assertEquals((await login("kid.next", "1357")).status, 200, "another learner on the same device isn't affected");
    for (let i = 0; i < 6; i++) assertEquals((await login("no.such.kid", "0000")).status, 401);
    assert(db.learners.every((l) => l.username === "kid.lock" || !l.locked_until), "an unknown username locks nobody");
    // Their teacher unlocks it before the 15 minutes are up (audited).
    const id = db.learners.find((l) => l.username === "kid.lock")!.id;
    assertEquals((await call("PATCH", `/learners/${id}`, "tok_teacher", { unlock: true })).status, 200);
    assert(db.audit_log.some((a) => a.action === "learner.unlocked" && a.target_id === id));
    assertEquals((await login("kid.lock", "2468")).status, 200);
  } finally {
    time.restore();
  }
});

/* ------------------------------------------------------------ pending and suspended accounts */

/** Routes that need no account at all (they check their own credentials). */
const PUBLIC = new Set(["GET /health", "POST /auth/register", "POST /learner/login", "POST /learner/logout", "GET /invitations/:token", "POST /kobo/hook", "POST /notifications/run"]);

/* What a signed-in but non-active account may still do — only about itself:
   see its own status (to be told why it's waiting or blocked), change its
   own password, and — pending only — finish joining through an invitation. */
async function selfService(state: string, key: string, res: { status: number; json: Row }) {
  switch (key) {
    case "GET /me":
      assertEquals([res.status, res.json.profile.status, res.json.profile.permissions], [200, state, []], `${state} ${key}`);
      return;
    case "POST /me": // making a second profile
      assertEquals(res.status, 409, `${state} ${key}`);
      return;
    case "POST /me/accept-invite": // "x1" isn't a real invitation
      assert(res.status === 404 || res.status === 403 || res.status === 409, `${state} ${key}: ${res.status}`);
      return;
    case "POST /me/password": // an empty password
      assertEquals(res.status, 400, `${state} ${key}`);
      return;
  }
  throw new Error(`${state} reached ${key}: ${res.status} ${JSON.stringify(res.json).slice(0, 160)}`);
}

Deno.test("pending and suspended accounts are refused by every endpoint", async () => {
  // deno-lint-ignore no-explicit-any
  const routes = (app.routes as any[]).filter((x) => x.method !== "ALL").map((x) => ({ method: x.method as string, route: (x.path as string).replace(/^\/api/, "") }));
  const unique = [...new Map(routes.map((x) => [`${x.method} ${x.route}`, x])).values()];
  assert(unique.length > 150, `found ${unique.length} routes`);
  let refused = 0;
  for (const state of NON_ACTIVE) { // pending, suspended — and rejected, deactivated
    for (const { method, route } of unique) {
      const key = `${method} ${route}`;
      if (PUBLIC.has(key)) continue;
      freshWorld();
      const path = route.replace(/:\w+/g, "x1");
      const res = await call(method, path, `tok_${state}`, method === "GET" || method === "DELETE" ? undefined : {});
      if (res.status === 403 && res.json.accountStatus === state) { refused++; continue; }
      await selfService(state, key, res);
    }
  }
  assert(refused > 600, `refused ${refused}`);
});

Deno.test("a suspended account can't sign in again with a fresh session either", async () => {
  // Suspending also blocks sign-in at Supabase Auth (a ban); and the API
  // refuses the account whatever token it brings.
  const db = freshWorld();
  assertEquals((await call("POST", "/users/teacher2-id/status", "tok_admin", { action: "suspend", reason: "Investigation" })).status, 200);
  assertEquals(db.profiles.find((p) => p.id === "teacher2-id")!.status, "suspended");
  for (const path of ["/forms", "/learners", "/classes", "/schools", "/library", "/notifications"]) {
    const res = await call("GET", path, "tok_teacher2");
    assertEquals([res.status, res.json.accountStatus], [403, "suspended"], path);
  }
});
