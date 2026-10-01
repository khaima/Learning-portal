/**
 * Server-side authorization tests for the `api` Edge Function.
 *
 *   cd supabase/functions/api
 *   deno test --allow-env --config deno.json authz_test.ts
 *
 * Runs the real Hono app against an in-memory stand-in for Supabase, so no
 * database or network is touched. Three kinds of check:
 *   1. Every protected route, called as every role: allowed roles get past
 *      authorization (anything but 401/403), everyone else gets 403. The
 *      expected roles are written out by hand below — NOT derived from
 *      permissions.ts — so a wrong permission shows up as a failure.
 *   2. No session, a learner, and every non-active account state are
 *      refused on every protected route.
 *   3. Governance rules and audit entries for the account workflows.
 * A route that exists in the app but not in ROUTES below fails the suite,
 * so a new endpoint can't ship without an authorization test.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";

Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
Deno.env.set("HPF_API_TEST", "1");
const { app, __setAdminClientForTests } = await import("./index.ts");

/* ------------------------------------------------------------ in-memory Supabase */

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;
type Db = Record<string, Row[]>;

function fakeAdmin(db: Db, users: Record<string, { id: string; email: string }>) {
  let seq = 1;
  const from = (table: string) => {
    db[table] ??= [];
    const filters: ((r: Row) => boolean)[] = [];
    let op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
    let payload: Row | Row[] | null = null;
    let one: "single" | "maybe" | null = null;
    let head = false;
    let limit: number | null = null;
    let range: [number, number] | null = null;
    // Embedded-resource filters ("learners.teacher_id") aren't modelled.
    const f = (k: string, test: (v: unknown) => boolean) => { if (!k.includes(".")) filters.push((r) => test(r[k])); return api; };
    const run = () => {
      const rows = db[table];
      const match = (r: Row) => filters.every((t) => t(r));
      let out: Row[] = [];
      if (op === "insert" || op === "upsert") {
        const list = (Array.isArray(payload) ? payload : [payload]) as Row[];
        out = list.map((p) => {
          const row = { id: p.id ?? `${table}_${seq++}`, created_at: new Date().toISOString(), ...p };
          if (table === "audit_log") row.id = seq++;
          rows.push(row);
          return row;
        });
      } else if (op === "update") {
        out = rows.filter(match);
        for (const r of out) Object.assign(r, payload);
      } else if (op === "delete") {
        out = rows.filter(match);
        db[table] = rows.filter((r) => !match(r));
      } else {
        out = rows.filter(match);
      }
      if (range) out = out.slice(range[0], range[1] + 1);
      if (limit != null) out = out.slice(0, limit);
      const copy = out.map((r) => ({ ...r }));
      if (head) return { data: null, count: copy.length, error: null };
      if (one) {
        if (one === "single" && copy.length !== 1) return { data: null, error: { message: "not exactly one row", code: "PGRST116" } };
        return { data: copy[0] ?? null, error: null };
      }
      return { data: copy, error: null, count: copy.length };
    };
    // deno-lint-ignore no-explicit-any
    const api: any = {
      // deno-lint-ignore no-explicit-any
      select(_c?: string, opts?: any) { if (opts?.head) head = true; return api; },
      insert(p: Row) { op = "insert"; payload = p; return api; },
      upsert(p: Row) { op = "upsert"; payload = p; return api; },
      update(p: Row) { op = "update"; payload = p; return api; },
      delete() { op = "delete"; return api; },
      eq: (k: string, v: unknown) => f(k, (x) => x === v),
      neq: (k: string, v: unknown) => f(k, (x) => x !== v),
      is: (k: string, v: unknown) => f(k, (x) => (v === null ? x == null : x === v)),
      in: (k: string, vs: unknown[]) => f(k, (x) => vs.includes(x)),
      ilike: (k: string, v: string) => f(k, (x) => String(x ?? "").toLowerCase() === v.replace(/\\(.)/g, "$1").toLowerCase()),
      lt: (k: string, v: number) => f(k, (x) => (x as number) < v),
      gt: (k: string, v: number) => f(k, (x) => (x as number) > v),
      not: () => api, like: () => api, order: () => api,
      limit(n: number) { limit = n; return api; },
      range(a: number, b: number) { range = [a, b]; return api; },
      single() { one = "single"; return api; },
      maybeSingle() { one = "maybe"; return api; },
      then(res: (v: unknown) => unknown, rej: (e: unknown) => unknown) { return Promise.resolve().then(run).then(res, rej); },
    };
    return api;
  };
  const ok = { data: { user: { id: "new-user" } }, error: null };
  return {
    from,
    auth: {
      getUser: (jwt: string) => Promise.resolve(users[jwt]
        ? { data: { user: users[jwt] }, error: null }
        : { data: { user: null }, error: { message: "invalid" } }),
      admin: {
        createUser: () => Promise.resolve(ok),
        updateUserById: () => Promise.resolve(ok),
      },
    },
    storage: {
      from: () => ({
        createSignedUrl: () => Promise.resolve({ data: { signedUrl: "https://signed" }, error: null }),
        createSignedUploadUrl: () => Promise.resolve({ data: { token: "t", signedUrl: "https://up" }, error: null }),
        remove: () => Promise.resolve({ data: [], error: null }),
      }),
    },
  };
}

/* ------------------------------------------------------------ fixtures */

const STAFF = ["super_admin", "admin", "education_team", "me", "field_officer", "school_leader", "teacher"] as const;
const ROLES = [...STAFF, "learner"] as const;
type R = (typeof ROLES)[number];
const ALL: R[] = [...ROLES];
const NON_ACTIVE = ["pending", "suspended", "rejected", "deactivated"] as const;

const SCHOOL = { id: "sch_1", name: "Aitong Primary", county: "Narok", code: "NRK-001", seq: 1 };
const idOf = (role: string) => `00000000-0000-0000-0000-${role.padEnd(12, "0").slice(0, 12).replace(/[^0-9a-f]/g, "a")}`;

function freshWorld() {
  const now = new Date().toISOString();
  const users: Record<string, { id: string; email: string }> = {};
  const profiles: Row[] = [];
  for (const role of STAFF) {
    const id = `${role}-id`;
    users[`tok_${role}`] = { id, email: `${role}@test.org` };
    profiles.push({
      id, role, status: "active", full_name: `${role} person`, email: `${role}@test.org`,
      school: ["teacher", "school_leader"].includes(role) ? SCHOOL.name : "",
      school_id: ["teacher", "school_leader"].includes(role) ? SCHOOL.id : null,
      county: role === "field_officer" ? "Narok" : "", user_code: null, created_at: now,
    });
  }
  // A second teacher, for an admin to manage, plus one account per non-active state.
  users["tok_teacher2"] = { id: "teacher2-id", email: "teacher2@test.org" };
  profiles.push({ id: "teacher2-id", role: "teacher", status: "active", full_name: "Second Teacher", email: "teacher2@test.org", school: SCHOOL.name, school_id: SCHOOL.id, county: "Narok" });
  for (const st of NON_ACTIVE) {
    users[`tok_${st}`] = { id: `${st}-id`, email: `${st}@test.org` };
    profiles.push({ id: `${st}-id`, role: "teacher", requested_role: "teacher", status: st, full_name: `${st} person`, email: `${st}@test.org`, school: SCHOOL.name, school_id: SCHOOL.id, county: "Narok" });
  }
  users["tok_new"] = { id: "new-id", email: "new@test.org" }; // signed in, no profile yet
  const db: Db = {
    profiles,
    schools: [SCHOOL],
    counties: [{ name: "Narok", code: "NRK", created_at: now }],
    school_code_counters: [],
    learners: [{ id: "learner-id", teacher_id: "teacher-id", username: "kid.one", full_name: "Kid One", grade: "4", school: SCHOOL.name, school_id: SCHOOL.id, county: "Narok", pin_hash: "x", pin_salt: "y" }],
    learner_sessions: [{ token: "learnertoken", learner_id: "learner-id", created_at: now, expires_at: new Date(Date.now() + 3600e3).toISOString() }],
    assignments: [{ id: "asg_1", learner_id: "learner-id", title: "Read", subject: "English", due: "", done: false }],
    library_items: [{ id: "lib_1", title: "Book", subject: "English", type: "Reading", audience: "library", published: true, files: [] }],
    library_folders: [{ id: "fld_1", name: "Folder", audience: "library" }],
    library_interactions: [{ id: "li_1", library_item_id: "lib_1", actor_id: "learner-id", started_at: now, completed_at: null }],
    library_badges: [],
    forms: [{ id: "form_1", title: "Survey", audience: "teacher", kind: "questions", questions: [{ id: "q1", prompt: "How?", type: "text" }], files: [] }],
    responses: [],
    field_reports: [],
    kobo_config: [],
    kobo_forms: [{ id: "kb_1", asset_uid: "aAbCdEfGh123", title: "Kobo", active: true }],
    kobo_submissions: [],
    staff_invitations: [],
    audit_log: [],
  };
  __setAdminClientForTests(fakeAdmin(db, users));
  return db;
}

async function call(method: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await app.request(`/api${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: Row = {};
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}
const tokenFor = (role: R) => (role === "learner" ? "hpl_learnertoken" : `tok_${role}`);

/* ------------------------------------------------------------ the expected access table
   Hand-written spec. `who` = the roles that must get PAST authorization. */

const EDU_ADMIN: R[] = ["super_admin", "admin", "education_team"];
const USER_ADMIN: R[] = ["super_admin", "admin"];
const ANALYSTS: R[] = ["super_admin", "admin", "education_team", "me"];

type RouteSpec = { method: string; path: string; route: string; who: R[]; body?: unknown };
const r = (method: string, route: string, who: R[], body?: unknown, path?: string): RouteSpec =>
  ({ method, route, path: path ?? route.replace(":id", "x1").replace(":name", "Nowhere").replace(":uid", "aAbCdEfGh123"), who, body });

const ROUTES: RouteSpec[] = [
  r("PUT", "/me/school", ["teacher", "school_leader"], { schoolId: "sch_1" }),
  r("POST", "/counties", EDU_ADMIN, { name: "Kajiado", code: "KJD" }),
  r("DELETE", "/counties/:name", EDU_ADMIN),
  r("POST", "/schools", EDU_ADMIN, { name: "New School", county: "Narok" }),
  r("PATCH", "/schools/:id", EDU_ADMIN, { name: "Renamed" }),
  r("DELETE", "/schools/:id", EDU_ADMIN),
  r("GET", "/learners", ["teacher"]),
  r("POST", "/learners", ["teacher"], { fullName: "Kid Two", username: "kid.two", pin: "1234" }),
  r("PATCH", "/learners/:id", ["teacher"], { fullName: "Kid" }, "/learners/learner-id"),
  r("DELETE", "/learners/:id", ["teacher"], undefined, "/learners/learner-id"),
  r("GET", "/learners/:id/activity", ["teacher"], undefined, "/learners/learner-id/activity"),
  r("GET", "/library", ALL),
  r("POST", "/library", EDU_ADMIN, { title: "T", subject: "English", type: "Reading" }),
  r("PATCH", "/library/:id", EDU_ADMIN, { published: true }, "/library/lib_1"),
  r("DELETE", "/library/:id", EDU_ADMIN, undefined, "/library/lib_1"),
  r("GET", "/library/folders", ALL),
  r("POST", "/library/folders", EDU_ADMIN, { name: "F" }),
  r("DELETE", "/library/folders/:id", EDU_ADMIN),
  r("POST", "/library/:id/interactions", ALL, {}, "/library/lib_1/interactions"),
  r("PATCH", "/library/interactions/:id/complete", ALL, {}, "/library/interactions/li_1/complete"),
  r("GET", "/library/interactions/mine", ALL),
  r("POST", "/library/:id/badge", ALL, {}, "/library/lib_1/badge"),
  r("GET", "/library/usage", ANALYSTS),
  r("GET", "/forms", [...ANALYSTS, "field_officer", "school_leader", "teacher"]),
  r("POST", "/forms", EDU_ADMIN, { title: "F", audience: "teacher", questions: [{ id: "q1", prompt: "P", type: "text" }] }),
  r("DELETE", "/forms/:id", EDU_ADMIN, undefined, "/forms/form_1"),
  r("POST", "/forms/:id/archive", EDU_ADMIN, {}, "/forms/form_1/archive"),
  r("POST", "/forms/:id/restore", EDU_ADMIN, {}, "/forms/form_1/restore"),
  r("POST", "/forms/:id/response-upload", ["field_officer", "school_leader", "teacher"], { name: "a.pdf" }, "/forms/form_1/response-upload"),
  r("GET", "/responses", [...ANALYSTS, "field_officer", "school_leader", "teacher"]),
  r("POST", "/responses", ["field_officer", "school_leader", "teacher"], { formId: "form_1", answers: [{ questionId: "q1", value: "x" }] }),
  r("GET", "/assignments", [...ANALYSTS, "learner"]),
  r("GET", "/teacher/assignments", ["teacher"]),
  r("PATCH", "/assignments/:id", ["teacher", "learner"], { done: true }, "/assignments/asg_1"),
  r("GET", "/field-reports", [...ANALYSTS, "field_officer"]),
  r("POST", "/field-reports", ["field_officer"], { schoolId: "sch_1", visitType: "Learning", responses: [] }),
  r("GET", "/stats", ANALYSTS),
  r("GET", "/school/overview", ["school_leader"]),
  r("GET", "/users", EDU_ADMIN),
  r("GET", "/users/invitations", USER_ADMIN),
  r("POST", "/users/invitations", USER_ADMIN, { email: "fresh@test.org", role: "teacher", schoolId: "sch_1" }),
  r("DELETE", "/users/invitations/:id", USER_ADMIN),
  r("POST", "/users/:id/approve", USER_ADMIN, {}, "/users/pending-id/approve"),
  r("POST", "/users/:id/reject", USER_ADMIN, {}, "/users/pending-id/reject"),
  r("POST", "/users/:id/status", USER_ADMIN, { action: "suspend" }, "/users/teacher2-id/status"),
  r("PATCH", "/users/:id", USER_ADMIN, { fullName: "Renamed" }, "/users/teacher2-id"),
  r("POST", "/users/:id/reset-password", USER_ADMIN, { password: "a-new-password" }, "/users/teacher2-id/reset-password"),
  r("GET", "/audit", USER_ADMIN),
  r("GET", "/kobo/config", ANALYSTS),
  r("PUT", "/kobo/config", EDU_ADMIN, {}),
  r("GET", "/kobo/assets", EDU_ADMIN),
  r("GET", "/kobo/forms", ANALYSTS),
  r("POST", "/kobo/forms", EDU_ADMIN, {}),
  r("GET", "/kobo/assets/:uid/preview", EDU_ADMIN),
  r("DELETE", "/kobo/forms/:id", EDU_ADMIN, undefined, "/kobo/forms/kb_1"),
  r("POST", "/kobo/forms/:id/restore", EDU_ADMIN, {}, "/kobo/forms/kb_1/restore"),
  r("POST", "/kobo/sync", EDU_ADMIN, {}),
  r("GET", "/kobo/forms/:id/results", ANALYSTS, undefined, "/kobo/forms/kb_1/results"),
  r("GET", "/kobo/my-surveys", ["field_officer"]),
  r("POST", "/kobo/my-surveys/:id/submitted", ["field_officer"], {}, "/kobo/my-surveys/kb_1/submitted"),
];
/** Need a sign-in but no particular permission (sign-up, own profile, school list). */
const SIGNED_IN_ONLY = ["GET /me", "POST /me", "POST /me/accept-invite", "GET /schools"];
const PUBLIC = ["GET /health", "POST /auth/register", "POST /learner/login", "POST /learner/logout", "GET /invitations/:token"];

const denied = (s: number) => s === 401 || s === 403;

/* ------------------------------------------------------------ 1. coverage */

Deno.test("every route in the app has an authorization test", () => {
  const inApp = new Set(
    // deno-lint-ignore no-explicit-any
    (app.routes as any[]).filter((x) => x.method !== "ALL").map((x) => `${x.method} ${x.path.replace(/^\/api/, "")}`),
  );
  const covered = new Set([...ROUTES.map((x) => `${x.method} ${x.route}`), ...SIGNED_IN_ONLY, ...PUBLIC]);
  const missing = [...inApp].filter((k) => !covered.has(k));
  assertEquals(missing, [], `routes without an authorization test: ${missing.join(", ")}`);
});

/* ------------------------------------------------------------ 2. role x route */

for (const spec of ROUTES) {
  Deno.test(`${spec.method} ${spec.route} — only ${spec.who.join(", ")}`, async () => {
    for (const role of ROLES) {
      freshWorld();
      const { status, json } = await call(spec.method, spec.path, tokenFor(role), spec.body);
      if (spec.who.includes(role)) {
        assert(!denied(status), `${role} should be allowed but got ${status} ${JSON.stringify(json)}`);
      } else {
        assertEquals(status, 403, `${role} should be refused but got ${status} ${JSON.stringify(json)}`);
      }
    }
  });
}

/* ------------------------------------------------------------ 3. no session / bad session / non-active accounts */

Deno.test("no session and invalid tokens are refused on every protected route", async () => {
  for (const spec of ROUTES) {
    freshWorld();
    assertEquals((await call(spec.method, spec.path, undefined, spec.body)).status, 401, `${spec.method} ${spec.route} without a token`);
    assertEquals((await call(spec.method, spec.path, "tok_forged", spec.body)).status, 401, `${spec.method} ${spec.route} with a forged token`);
    assertEquals((await call(spec.method, spec.path, "hpl_forged", spec.body)).status, 401, `${spec.method} ${spec.route} with a forged learner token`);
  }
});

Deno.test("pending, suspended, rejected and deactivated accounts reach no protected route", async () => {
  for (const st of NON_ACTIVE) {
    for (const spec of ROUTES) {
      freshWorld();
      const { status, json } = await call(spec.method, spec.path, `tok_${st}`, spec.body);
      assertEquals(status, 403, `${st} account on ${spec.method} ${spec.route}`);
      assertEquals(json.accountStatus, st);
    }
  }
});

Deno.test("signed-in-only routes still need a valid session", async () => {
  freshWorld();
  for (const [m, p] of [["GET", "/me"], ["POST", "/me"], ["POST", "/me/accept-invite"], ["GET", "/schools"]]) {
    assertEquals((await call(m, p)).status, 401, `${m} ${p}`);
  }
});

/* ------------------------------------------------------------ 4. the role is never taken from the browser */

Deno.test("a role sent by the browser is ignored", async () => {
  freshWorld();
  // A teacher claiming to be a Super Admin — in the query string, and in
  // the body of a write.
  assertEquals((await call("GET", "/stats?role=super_admin", "tok_teacher")).status, 403);
  assertEquals((await call("GET", "/users?role=admin&permissions=users.view", "tok_teacher")).status, 403);
  assertEquals((await call("POST", "/users/invitations", "tok_teacher", { email: "x@test.org", role: "teacher", actorRole: "super_admin" })).status, 403);
  assertEquals((await call("POST", "/forms", "tok_teacher", { title: "F", audience: "teacher", role: "education_team" })).status, 403);
});

Deno.test("self-registration can't pick an admin role and starts pending", async () => {
  for (const role of ["super_admin", "admin", "education_team", "me"]) {
    const db = freshWorld();
    const res = await call("POST", "/me", "tok_new", { role, fullName: "New Person", schoolId: "sch_1", county: "Narok" });
    assertEquals(res.status, 400, role);
    assert(!db.profiles.some((p) => p.id === "new-id"), `no profile may be created for ${role}`);
  }
  const db = freshWorld();
  const res = await call("POST", "/me", "tok_new", { role: "teacher", fullName: "New Teacher", schoolId: "sch_1" });
  assertEquals(res.status, 200);
  assertEquals(res.json.profile.status, "pending");
  assertEquals(res.json.profile.permissions, []);
  assert(db.audit_log.some((a) => a.action === "account.created" && a.target_id === "new-id"));
  // …and the new account can't use anything yet.
  assertEquals((await call("GET", "/forms", "tok_new")).status, 403);
});

/* ------------------------------------------------------------ 5. governance */

Deno.test("an admin can't manage admins or super admins, or give those roles", async () => {
  const db = freshWorld();
  db.profiles.push({ id: "admin2-id", role: "admin", status: "active", full_name: "Other Admin", email: "a2@test.org" });
  assertEquals((await call("PATCH", "/users/admin2-id", "tok_admin", { fullName: "x" })).status, 403);
  assertEquals((await call("PATCH", "/users/super_admin-id", "tok_admin", { fullName: "x" })).status, 403);
  assertEquals((await call("POST", "/users/super_admin-id/status", "tok_admin", { action: "suspend" })).status, 403);
  assertEquals((await call("PATCH", "/users/teacher2-id", "tok_admin", { role: "admin" })).status, 403);
  assertEquals((await call("PATCH", "/users/teacher2-id", "tok_admin", { role: "super_admin" })).status, 403);
  assertEquals((await call("POST", "/users/pending-id/approve", "tok_admin", { role: "super_admin" })).status, 403);
  assertEquals((await call("POST", "/users/invitations", "tok_admin", { email: "x@test.org", role: "admin" })).status, 403);
  // A Super Admin can.
  assertEquals((await call("PATCH", "/users/admin2-id", "tok_super_admin", { role: "education_team" })).status, 200);
});

Deno.test("nobody can change their own account", async () => {
  freshWorld();
  assertEquals((await call("PATCH", "/users/admin-id", "tok_admin", { role: "super_admin" })).status, 403);
  assertEquals((await call("POST", "/users/admin-id/status", "tok_admin", { action: "deactivate" })).status, 403);
  assertEquals((await call("PATCH", "/users/super_admin-id", "tok_super_admin", { role: "teacher" })).status, 403);
});

Deno.test("approve, reject, suspend, deactivate and reactivate follow the allowed transitions", async () => {
  let db = freshWorld();
  let res = await call("POST", "/users/pending-id/approve", "tok_admin", { role: "school_leader", schoolId: "sch_1" });
  assertEquals(res.status, 200);
  assertEquals(db.profiles.find((p) => p.id === "pending-id")!.status, "active");
  assertEquals(db.profiles.find((p) => p.id === "pending-id")!.role, "school_leader");
  assert(db.audit_log.some((a) => a.action === "account.approved" && a.target_id === "pending-id"));
  assert(db.audit_log.some((a) => a.action === "role.changed" && a.details.to === "school_leader"));

  db = freshWorld();
  res = await call("POST", "/users/pending-id/reject", "tok_admin", { reason: "Unknown person" });
  assertEquals(res.status, 200);
  assertEquals(db.profiles.find((p) => p.id === "pending-id")!.status, "rejected");
  assert(db.audit_log.some((a) => a.action === "account.rejected"));

  db = freshWorld();
  assertEquals((await call("POST", "/users/teacher2-id/approve", "tok_admin", {})).status, 409, "an active account can't be 'approved'");
  assertEquals((await call("POST", "/users/teacher2-id/status", "tok_admin", { action: "deactivate", reason: "Left" })).status, 200);
  assertEquals(db.profiles.find((p) => p.id === "teacher2-id")!.status, "deactivated");
  assertEquals((await call("GET", "/forms", "tok_teacher2")).status, 403, "deactivated account is locked out at once");
  assertEquals((await call("POST", "/users/teacher2-id/status", "tok_admin", { action: "reactivate" })).status, 200);
  assertEquals((await call("GET", "/forms", "tok_teacher2")).status, 200, "reactivated account works again");
  const actions = db.audit_log.map((a) => a.action);
  assert(actions.includes("account.deactivated") && actions.includes("account.reactivated"));
});

Deno.test("role, school and password changes are audited (never the password)", async () => {
  const db = freshWorld();
  db.schools.push({ id: "sch_2", name: "Other Primary", county: "Narok", code: "NRK-002", seq: 2 });
  assertEquals((await call("PATCH", "/users/teacher2-id", "tok_admin", { role: "school_leader", schoolId: "sch_2" })).status, 200);
  assertEquals((await call("POST", "/users/teacher2-id/reset-password", "tok_admin", { password: "a-new-password" })).status, 200);
  const byAction = (x: string) => db.audit_log.filter((a) => a.action === x && a.target_id === "teacher2-id");
  assertEquals(byAction("role.changed")[0].details, { from: "teacher", to: "school_leader" });
  assertEquals(byAction("school.changed")[0].details.to, "sch_2");
  assertEquals(byAction("password.reset").length, 1);
  assert(!JSON.stringify(db.audit_log).includes("a-new-password"), "the password must never be logged");
  assertEquals(byAction("role.changed")[0].actor_id, "admin-id");
});

Deno.test("learner creation and deletion are audited", async () => {
  const db = freshWorld();
  assertEquals((await call("POST", "/learners", "tok_teacher", { fullName: "Kid Two", username: "kid.two", pin: "1234" })).status, 200);
  assertEquals((await call("DELETE", "/learners/learner-id", "tok_teacher")).status, 200);
  const actions = db.audit_log.map((a) => a.action);
  assert(actions.includes("learner.created") && actions.includes("learner.deleted"));
  assert(!JSON.stringify(db.audit_log).includes("1234"), "the PIN must never be logged");
});

Deno.test("invitation: the role comes from the invitation, for the invited email only, once", async () => {
  const db = freshWorld();
  const created = await call("POST", "/users/invitations", "tok_admin", { email: "new@test.org", role: "field_officer", county: "Narok" });
  assertEquals(created.status, 200);
  const token = created.json.token as string;
  assert(token && !JSON.stringify(db.staff_invitations).includes(token), "only the hash of the token is stored");

  // The public preview works without signing in.
  assertEquals((await call("GET", `/invitations/${token}`)).json.invitation.role, "field_officer");
  // Someone else's account can't use it.
  assertEquals((await call("POST", "/me/accept-invite", "tok_pending", { token, fullName: "X" })).status, 403);
  // The invited person — whatever role they claim — gets exactly the invited one.
  const accepted = await call("POST", "/me/accept-invite", "tok_new", { token, fullName: "New Officer", role: "super_admin" });
  assertEquals(accepted.status, 200);
  assertEquals(accepted.json.profile.role, "field_officer");
  assertEquals(accepted.json.profile.status, "active");
  // Used once only.
  assertEquals((await call("GET", `/invitations/${token}`)).status, 404);
  assertEquals((await call("POST", "/me/accept-invite", "tok_new", { token, fullName: "Again" })).status, 404);
  const actions = db.audit_log.map((a) => a.action);
  assert(actions.includes("invitation.created") && actions.includes("invitation.accepted") && actions.includes("account.created"));
});

Deno.test("audit history is readable only with audit.view, and shows the entries", async () => {
  const db = freshWorld();
  await call("POST", "/users/teacher2-id/reset-password", "tok_admin", { password: "a-new-password" });
  const res = await call("GET", "/audit?targetId=teacher2-id", "tok_super_admin");
  assertEquals(res.status, 200);
  assertEquals(res.json.entries[0].action, "password.reset");
  assertEquals((await call("GET", "/audit", "tok_education_team")).status, 403);
  assertEquals((await call("GET", "/audit", "tok_me")).status, 403);
  assert(db.audit_log.length > 0);
});
