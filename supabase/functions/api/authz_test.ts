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
const SCHOOL_B = { id: "sch_2", name: "Olpusimoru Primary", county: "Narok", code: "NRK-002", seq: 2 };
const idOf = (role: string) => `00000000-0000-0000-0000-${role.padEnd(12, "0").slice(0, 12).replace(/[^0-9a-f]/g, "a")}`;

function freshWorld() {
  const now = new Date().toISOString();
  const inAWeek = new Date(Date.now() + 7 * 864e5).toISOString();
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
  // A second school with its own head and teacher.
  users["tok_head_b"] = { id: "head-b-id", email: "head-b@test.org" };
  users["tok_teacher_b"] = { id: "teacher-b-id", email: "teacher-b@test.org" };
  profiles.push(
    { id: "head-b-id", role: "school_leader", status: "active", full_name: "Head B", email: "head-b@test.org", school: SCHOOL_B.name, school_id: SCHOOL_B.id, county: "Narok" },
    { id: "teacher-b-id", role: "teacher", status: "active", full_name: "Teacher B", email: "teacher-b@test.org", school: SCHOOL_B.name, school_id: SCHOOL_B.id, county: "Narok" },
  );
  const db: Db = {
    profiles,
    schools: [SCHOOL, SCHOOL_B],
    academic_years: [{ id: "2026", label: "2026", starts_on: "2026-01-01", ends_on: "2026-12-31", is_current: true }],
    terms: [
      { id: "2026-T1", academic_year_id: "2026", term_no: 1, starts_on: "2026-01-01", ends_on: "2026-04-30" },
      { id: "2026-T2", academic_year_id: "2026", term_no: 2, starts_on: "2026-05-01", ends_on: "2026-08-31" },
      { id: "2026-T3", academic_year_id: "2026", term_no: 3, starts_on: "2026-09-01", ends_on: "2026-12-31" },
    ],
    classes: [
      { id: "cls_1", school_id: SCHOOL.id, academic_year_id: "2026", grade: "Grade 4", name: "Grade 4 East", archived_at: null },
      { id: "cls_1b", school_id: SCHOOL.id, academic_year_id: "2026", grade: "Grade 5", name: "Grade 5 East", archived_at: null },
      { id: "cls_2", school_id: SCHOOL_B.id, academic_year_id: "2026", grade: "Grade 4", name: "Grade 4 B", archived_at: null },
    ],
    class_teachers: [
      { id: "ct_1", class_id: "cls_1", teacher_id: "teacher-id", role: "class_teacher", ended_at: null },
      { id: "ct_2", class_id: "cls_2", teacher_id: "teacher-b-id", role: "class_teacher", ended_at: null },
    ],
    learner_enrollments: [
      { id: "enr_1", learner_id: "learner-id", school_id: SCHOOL.id, class_id: "cls_1", academic_year_id: "2026", term_id: "2026-T3", grade: "Grade 4", status: "ACTIVE", enrollment_date: "2026-09-01" },
      { id: "enr_b", learner_id: "learner-b-id", school_id: SCHOOL_B.id, class_id: "cls_2", academic_year_id: "2026", term_id: "2026-T3", grade: "Grade 4", status: "ACTIVE", enrollment_date: "2026-09-01" },
    ],
    counties: [{ name: "Narok", code: "NRK", created_at: now }],
    school_code_counters: [],
    learners: [
      { id: "learner-id", teacher_id: "teacher-id", current_teacher_id: "teacher-id", class_id: "cls_1", username: "kid.one", full_name: "Kid One", grade: "Grade 4", school: SCHOOL.name, school_id: SCHOOL.id, county: "Narok", pin_hash: "x", pin_salt: "y", user_code: "NRK-001-L0001", learner_code: "NRK-001-L0001", enrollment_status: "ACTIVE", academic_year_id: "2026", term_id: "2026-T3" },
      // In the OTHER school — and, to prove the school wall holds, still
      // carrying teacher-id as the teacher who first added them.
      { id: "learner-b-id", teacher_id: "teacher-id", current_teacher_id: "teacher-b-id", class_id: "cls_2", username: "kid.b", full_name: "Kid B", grade: "Grade 4", school: SCHOOL_B.name, school_id: SCHOOL_B.id, county: "Narok", pin_hash: "x", pin_salt: "y", user_code: "NRK-002-L0001", learner_code: "NRK-002-L0001", enrollment_status: "ACTIVE", academic_year_id: "2026", term_id: "2026-T3" },
    ],
    learner_sessions: [{ token: "learnertoken", learner_id: "learner-id", created_at: now, expires_at: new Date(Date.now() + 3600e3).toISOString() }],
    subjects: [
      { id: "mathematics", name: "Mathematics", sort_order: 1, archived_at: null },
      { id: "english", name: "English", sort_order: 2, archived_at: null },
    ],
    class_subjects: [{ id: "cs_1", class_id: "cls_1", subject_id: "mathematics", removed_at: null }],
    grade_bands: [
      { code: "EE", label: "Exceeding Expectations", min_percent: 80, sort_order: 1 },
      { code: "ME", label: "Meeting Expectations", min_percent: 50, sort_order: 2 },
      { code: "AE", label: "Approaching Expectations", min_percent: 30, sort_order: 3 },
      { code: "BE", label: "Below Expectations", min_percent: 0, sort_order: 4 },
    ],
    // A published quiz in each school: one auto-marked and one teacher-marked
    // question in school A, a true/false in school B.
    assignments: [
      { id: "asg_1", school_id: SCHOOL.id, class_id: "cls_1", subject_id: "mathematics", grade: "Grade 4", academic_year_id: "2026", term_id: "2026-T3",
        title: "Fractions quiz", description: "", instructions: "", resource_id: null, starts_at: null, due_at: inAWeek, estimated_minutes: 20,
        status: "published", max_marks: 4, created_by: "teacher-id", created_at: "2026-09-10T08:00:00.000Z", published_at: "2026-09-10T08:00:00.000Z" },
      { id: "asg_b", school_id: SCHOOL_B.id, class_id: "cls_2", subject_id: "english", grade: "Grade 4", academic_year_id: "2026", term_id: "2026-T3",
        title: "Reading check", description: "", instructions: "", resource_id: null, starts_at: null, due_at: inAWeek, estimated_minutes: 10,
        status: "published", max_marks: 1, created_by: "teacher-b-id", created_at: "2026-09-10T08:00:00.000Z", published_at: "2026-09-10T08:00:00.000Z" },
    ],
    assignment_questions: [
      { id: "q_mc", assignment_id: "asg_1", position: 1, type: "multiple_choice", prompt: "1/2 + 1/4 = ?", options: ["3/4", "2/6"], answer_key: 0, max_marks: 2 },
      { id: "q_tm", assignment_id: "asg_1", position: 2, type: "teacher_marked", prompt: "Explain how you worked it out.", options: [], answer_key: null, max_marks: 2 },
      { id: "q_b", assignment_id: "asg_b", position: 1, type: "true_false", prompt: "The story is set in Narok.", options: ["True", "False"], answer_key: true, max_marks: 1 },
    ],
    assignment_submissions: [],
    submission_answers: [],
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
const LEARNER_VIEWERS: R[] = [...ANALYSTS, "school_leader", "teacher"];
const LEARNER_MANAGERS: R[] = ["super_admin", "admin", "school_leader", "teacher"];
const CLASS_MANAGERS: R[] = ["super_admin", "admin", "school_leader"];

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
  r("GET", "/learners", LEARNER_VIEWERS),
  r("POST", "/learners", LEARNER_MANAGERS, { fullName: "Kid Two", username: "kid.two", pin: "1234", schoolId: "sch_1" }),
  r("PATCH", "/learners/:id", LEARNER_MANAGERS, { fullName: "Kid" }, "/learners/learner-id"),
  r("DELETE", "/learners/:id", LEARNER_MANAGERS, undefined, "/learners/learner-id"),
  r("POST", "/learners/:id/status", LEARNER_MANAGERS, { status: "INACTIVE" }, "/learners/learner-id/status"),
  r("POST", "/learners/:id/transfer", ["super_admin", "admin", "me"], { toSchoolId: "sch_2" }, "/learners/learner-id/transfer"),
  r("GET", "/learners/:id/history", LEARNER_VIEWERS, undefined, "/learners/learner-id/history"),
  r("GET", "/learners/:id/activity", LEARNER_VIEWERS, undefined, "/learners/learner-id/activity"),
  r("GET", "/enrollments", ["super_admin", "admin", "education_team", "me", "school_leader"], undefined, "/enrollments?schoolId=sch_1"),
  r("GET", "/academic-years", [...STAFF]),
  r("POST", "/academic-years", USER_ADMIN, { id: "2027" }),
  r("GET", "/classes", LEARNER_VIEWERS),
  r("POST", "/classes", CLASS_MANAGERS, { grade: "Grade 6", name: "Grade 6 West", schoolId: "sch_1" }),
  r("PATCH", "/classes/:id", CLASS_MANAGERS, { name: "Renamed" }, "/classes/cls_1"),
  r("POST", "/classes/:id/teachers", CLASS_MANAGERS, { teacherId: "teacher2-id" }, "/classes/cls_1/teachers"),
  r("DELETE", "/classes/:id/teachers/:teacherId", CLASS_MANAGERS, undefined, "/classes/cls_1/teachers/teacher-id"),
  r("POST", "/classes/:id/promote", CLASS_MANAGERS, { toClassId: "cls_1b" }, "/classes/cls_1/promote"),
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
  r("GET", "/subjects", [...STAFF]),
  r("POST", "/subjects", EDU_ADMIN, { name: "Music" }),
  r("POST", "/classes/:id/subjects", CLASS_MANAGERS, { subjectId: "english" }, "/classes/cls_1/subjects"),
  r("DELETE", "/classes/:id/subjects/:subjectId", CLASS_MANAGERS, undefined, "/classes/cls_1/subjects/mathematics"),
  r("POST", "/classes/:id/learners", LEARNER_MANAGERS, { learnerIds: ["learner-id"] }, "/classes/cls_1/learners"),
  r("DELETE", "/classes/:id/learners/:learnerId", LEARNER_MANAGERS, undefined, "/classes/cls_1/learners/learner-id"),
  r("GET", "/assignments", LEARNER_VIEWERS),
  r("POST", "/assignments", ["teacher"], { classId: "cls_1", subjectId: "mathematics", title: "New work" }),
  r("GET", "/assignments/:id", LEARNER_VIEWERS, undefined, "/assignments/asg_1"),
  r("PATCH", "/assignments/:id", ["teacher"], { title: "Renamed" }, "/assignments/asg_1"),
  r("POST", "/assignments/:id/status", ["teacher"], { status: "closed" }, "/assignments/asg_1/status"),
  r("DELETE", "/assignments/:id", ["teacher"], undefined, "/assignments/asg_1"),
  r("GET", "/submissions", LEARNER_VIEWERS),
  r("GET", "/submissions/:id", LEARNER_VIEWERS),
  r("POST", "/submissions/:id/mark", ["teacher"], { answers: [] }),
  r("GET", "/learner/assignments", ["learner"]),
  r("GET", "/learner/assignments/:id", ["learner"], undefined, "/learner/assignments/asg_1"),
  r("POST", "/learner/assignments/:id/start", ["learner"], {}, "/learner/assignments/asg_1/start"),
  r("PUT", "/learner/assignments/:id/answers", ["learner"], { answers: [] }, "/learner/assignments/asg_1/answers"),
  r("POST", "/learner/assignments/:id/upload", ["learner"], { questionId: "q_mc", name: "a.pdf" }, "/learner/assignments/asg_1/upload"),
  r("POST", "/learner/assignments/:id/submit", ["learner"], {}, "/learner/assignments/asg_1/submit"),
  r("GET", "/results", [...LEARNER_VIEWERS, "learner"]),
  r("GET", "/field-reports", [...ANALYSTS, "field_officer"]),
  r("POST", "/field-reports", ["field_officer"], { schoolId: "sch_1", visitType: "Learning", responses: [] }),
  r("GET", "/stats", ANALYSTS),
  r("GET", "/intelligence", ANALYSTS),
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

Deno.test("learner creation and removal are audited (removal archives, never deletes)", async () => {
  const db = freshWorld();
  assertEquals((await call("POST", "/learners", "tok_teacher", { fullName: "Kid Two", username: "kid.two", pin: "1234" })).status, 200);
  assertEquals((await call("DELETE", "/learners/learner-id", "tok_teacher")).status, 200);
  assert(db.learners.some((l) => l.id === "learner-id" && l.enrollment_status === "INACTIVE"), "the learner is archived, not deleted");
  const actions = db.audit_log.map((a) => a.action);
  assert(actions.includes("learner.created") && actions.includes("learner.archived"));
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

/* ------------------------------------------------------------ 6. schools, classes and enrollments */

const ids = (res: { json: Row }) => (res.json.learners ?? []).map((l: Row) => l.id).sort();

Deno.test("a teacher can't reach another school's learners — even one they once added", async () => {
  const db = freshWorld();
  const list = await call("GET", "/learners?status=all", "tok_teacher");
  assertEquals(ids(list), ["learner-id"]);
  // learner-b-id still has teacher-id as the teacher who added them, but is in sch_2.
  for (const [m, p, body] of [
    ["GET", "/learners/learner-b-id/history"],
    ["GET", "/learners/learner-b-id/activity"],
    ["PATCH", "/learners/learner-b-id", { fullName: "Hacked" }],
    ["POST", "/learners/learner-b-id/status", { status: "INACTIVE" }],
    ["DELETE", "/learners/learner-b-id"],
  ] as [string, string, unknown?][]) {
    assertEquals((await call(m, p, "tok_teacher", body)).status, 404, `${m} ${p}`);
  }
  assertEquals(db.learners.find((l) => l.id === "learner-b-id")!.full_name, "Kid B");
  // Can't add a learner to a class they don't teach, or to another school.
  assertEquals((await call("POST", "/learners", "tok_teacher", { fullName: "X", username: "kid.x", pin: "1234", classId: "cls_2" })).status, 400);
  assertEquals((await call("POST", "/learners", "tok_teacher", { fullName: "Y", username: "kid.y", pin: "1234", schoolId: "sch_2" })).json.learner.schoolId, "sch_1");
  // A class they don't teach in their own school is refused too.
  assertEquals((await call("POST", "/learners", "tok_teacher", { fullName: "Z", username: "kid.z", pin: "1234", classId: "cls_1b" })).status, 403);
});

Deno.test("a school head sees only their own school", async () => {
  const db = freshWorld();
  assertEquals(ids(await call("GET", "/learners?status=all", "tok_school_leader")), ["learner-id"]);
  // Asking for another school is ignored, never honoured.
  assertEquals(ids(await call("GET", "/learners?schoolId=sch_2", "tok_school_leader")), ["learner-id"]);
  const enr = await call("GET", "/enrollments?schoolId=sch_2", "tok_school_leader");
  assert(enr.json.enrollments.every((e: Row) => e.schoolId === "sch_1"));
  assertEquals((await call("GET", "/learners/learner-b-id/history", "tok_school_leader")).status, 404);
  assertEquals((await call("PATCH", "/learners/learner-b-id", "tok_school_leader", { fullName: "X" })).status, 404);
  const cls = await call("POST", "/classes", "tok_school_leader", { grade: "Grade 6", name: "Grade 6 B", schoolId: "sch_2" });
  assertEquals(cls.json.class.schoolId, "sch_1", "a head's new class is always in their own school");
  assertEquals((await call("PATCH", "/classes/cls_2", "tok_school_leader", { name: "X" })).status, 404);
  assertEquals((await call("POST", "/classes/cls_2/promote", "tok_school_leader", {})).status, 404);
  assertEquals((await call("POST", "/learners/learner-id/transfer", "tok_school_leader", { toSchoolId: "sch_2" })).status, 403);
  // …and the other school's head sees only theirs.
  assertEquals(ids(await call("GET", "/learners?status=all", "tok_head_b")), ["learner-b-id"]);
  assert(db.learners.length === 2);
});

Deno.test("an admin manages every school", async () => {
  freshWorld();
  assertEquals(ids(await call("GET", "/learners?status=all", "tok_admin")), ["learner-b-id", "learner-id"]);
  assertEquals(ids(await call("GET", "/learners?schoolId=sch_2", "tok_admin")), ["learner-b-id"]);
  assertEquals((await call("PATCH", "/learners/learner-b-id", "tok_admin", { fullName: "Kid Bee" })).status, 200);
  assertEquals((await call("POST", "/classes", "tok_admin", { grade: "Grade 6", name: "Grade 6 B", schoolId: "sch_2" })).json.class.schoolId, "sch_2");
  assertEquals((await call("POST", "/classes/cls_2/teachers", "tok_admin", { teacherId: "teacher-b-id" })).status, 200);
  assertEquals((await call("POST", "/learners", "tok_admin", { fullName: "New", username: "kid.new", pin: "1234", schoolId: "sch_2", classId: "cls_2" })).json.learner.schoolId, "sch_2");
  // M&E can see and transfer, but not edit.
  assertEquals((await call("PATCH", "/learners/learner-b-id", "tok_me", { fullName: "X" })).status, 403);
});

Deno.test("a transferred learner keeps their history, code, sign-in and work", async () => {
  const db = freshWorld();
  assertEquals((await call("POST", "/learner/assignments/asg_1/start", tokenFor("learner"))).status, 200);
  const res = await call("POST", "/learners/learner-id/transfer", "tok_admin", { toSchoolId: "sch_2", toClassId: "cls_2", reason: "Family moved" });
  assertEquals(res.status, 200);
  const l = db.learners.find((x) => x.id === "learner-id")!;
  assertEquals(l.school_id, "sch_2");
  assertEquals(l.class_id, "cls_2");
  assertEquals(l.enrollment_status, "ACTIVE");
  assertEquals(l.learner_code, "NRK-001-L0001", "the permanent learner code never changes");
  assert(String(l.user_code).startsWith("NRK-002-"), "the school code follows the new school");
  // History: the old enrollment is closed as TRANSFERRED, a new one is open.
  const mine = db.learner_enrollments.filter((e) => e.learner_id === "learner-id");
  assertEquals(mine.length, 2);
  const old = mine.find((e) => e.school_id === "sch_1")!;
  assertEquals(old.status, "TRANSFERRED");
  assert(old.exit_date && String(old.exit_reason).includes("Family moved"));
  assertEquals(mine.find((e) => e.school_id === "sch_2")!.status, "ACTIVE");
  // Their work and sign-in are untouched.
  assert(db.assignment_submissions.some((s) => s.learner_id === "learner-id" && s.school_id === "sch_1"), "work done at the old school stays there");
  assert(db.learner_sessions.some((s) => s.learner_id === "learner-id"));
  // The old school keeps the record, but no longer has the learner on its roster.
  const oldSchool = await call("GET", "/enrollments?status=past", "tok_school_leader");
  assert(oldSchool.json.enrollments.some((e: Row) => e.learnerId === "learner-id" && e.status === "TRANSFERRED"));
  assertEquals(ids(await call("GET", "/learners", "tok_school_leader")), []);
  assertEquals((await call("GET", "/learners/learner-id/history", "tok_teacher")).status, 404, "the old teacher loses access");
  // The new school sees them, with the full history.
  assert(ids(await call("GET", "/learners", "tok_head_b")).includes("learner-id"));
  assertEquals((await call("GET", "/learners/learner-id/history", "tok_head_b")).json.enrollments.length, 2);
  assert(db.audit_log.some((a) => a.action === "learner.transferred" && a.details.fromSchoolId === "sch_1" && a.details.toSchoolId === "sch_2"));
});

Deno.test("archived learners don't appear as active, can't sign in, and are never deleted", async () => {
  const db = freshWorld();
  assertEquals((await call("POST", "/learners/learner-id/status", "tok_teacher", { status: "DROPPED_OUT", reason: "Left school" })).status, 200);
  assertEquals(ids(await call("GET", "/learners", "tok_teacher")), [], "not on the active roster");
  const archived = await call("GET", "/learners?status=archived", "tok_teacher");
  assertEquals(archived.json.learners[0].status, "DROPPED_OUT");
  assert(db.learners.some((l) => l.id === "learner-id"), "the learner row still exists");
  assertEquals(db.learner_enrollments.find((e) => e.id === "enr_1")!.status, "DROPPED_OUT");
  assertEquals(db.learner_sessions.filter((s) => s.learner_id === "learner-id").length, 0, "signed out everywhere");
  assertEquals((await call("POST", "/learner/login", undefined, { username: "kid.one", pin: "1234" })).status, 403);
  // Not counted as an active learner anywhere.
  assertEquals((await call("GET", "/stats", "tok_education_team")).json.byRole.learner, 1, "only learner-b-id is active");
  // "Remove" archives instead of deleting.
  assertEquals((await call("DELETE", "/learners/learner-b-id", "tok_head_b")).status, 200);
  assertEquals(db.learners.find((l) => l.id === "learner-b-id")!.enrollment_status, "INACTIVE");
  assertEquals(db.learners.length, 2);
  // Reactivating opens a new enrollment; the old one stays.
  assertEquals((await call("POST", "/learners/learner-id/status", "tok_school_leader", { status: "ACTIVE" })).status, 200);
  assertEquals(db.learner_enrollments.filter((e) => e.learner_id === "learner-id").map((e) => e.status).sort(), ["ACTIVE", "DROPPED_OUT"]);
  assert(db.audit_log.some((a) => a.action === "learner.archived") && db.audit_log.some((a) => a.action === "learner.reactivated"));
});

Deno.test("a learner's profile never carries a staff account status", async () => {
  freshWorld();
  // The pages send anyone whose profile.status isn't "active" back to the
  // front door, so the enrollment status lives under its own name.
  const me = await call("GET", "/me", tokenFor("learner"));
  assertEquals(me.status, 200);
  assertEquals(me.json.profile.status, undefined);
  assertEquals(me.json.profile.enrollmentStatus, "ACTIVE");
  assertEquals(me.json.profile.className, "Grade 4 East");
});

Deno.test("promotion moves a class up a grade and keeps the year's record", async () => {
  const db = freshWorld();
  assertEquals((await call("POST", "/classes/cls_1/promote", "tok_school_leader", { toClassId: "cls_2" })).status, 400, "only a class in the same school");
  const res = await call("POST", "/classes/cls_1/promote", "tok_school_leader", { toClassId: "cls_1b" });
  assertEquals(res.json, { ok: true, promoted: 1, completed: 0 });
  const l = db.learners.find((x) => x.id === "learner-id")!;
  assertEquals([l.grade, l.class_id, l.enrollment_status], ["Grade 5", "cls_1b", "ACTIVE"]);
  const old = db.learner_enrollments.find((e) => e.id === "enr_1")!;
  assertEquals([old.status, old.exit_reason], ["COMPLETED", "Promoted to Grade 5"]);
});

/* ------------------------------------------------------------ 8. assignments, submissions, marking, results */

const LEARNER = tokenFor("learner");
const asgIds = (res: { json: Row }) => (res.json.assignments ?? []).map((a: Row) => a.id).sort();
/** A second learner in the same class (cls_1), enrolled like the first. */
function addClassmate(db: Db) {
  db.learners.push({ id: "learner-c-id", teacher_id: "teacher-id", current_teacher_id: "teacher-id", class_id: "cls_1", username: "kid.c", full_name: "Kid C", grade: "Grade 4", school: SCHOOL.name, school_id: SCHOOL.id, county: "Narok", pin_hash: "x", pin_salt: "y", user_code: "NRK-001-L0003", learner_code: "NRK-001-L0003", enrollment_status: "ACTIVE", academic_year_id: "2026", term_id: "2026-T3" });
  db.learner_enrollments.push({ id: "enr_c", learner_id: "learner-c-id", school_id: SCHOOL.id, class_id: "cls_1", academic_year_id: "2026", term_id: "2026-T3", grade: "Grade 4", status: "ACTIVE", enrollment_date: "2026-09-01" });
}
/** Start, answer and hand in asg_1 as the learner: right on the multiple choice. */
async function learnerHandsIn(answers: Row[] = [{ questionId: "q_mc", response: 0 }, { questionId: "q_tm", response: "Halves are two quarters." }]) {
  assertEquals((await call("POST", "/learner/assignments/asg_1/start", LEARNER)).status, 200);
  return await call("POST", "/learner/assignments/asg_1/submit", LEARNER, { answers });
}

Deno.test("assignment visibility: learners see published work for their own class only, never the answer key", async () => {
  const db = freshWorld();
  db.assignments.push({ ...db.assignments[0], id: "asg_draft", status: "draft", title: "Not ready" });
  const list = await call("GET", "/learner/assignments", LEARNER);
  assertEquals(asgIds(list), ["asg_1"], "own class, published — not the draft, not another school's");
  assertEquals((await call("GET", "/learner/assignments/asg_draft", LEARNER)).status, 404);
  assertEquals((await call("GET", "/learner/assignments/asg_b", LEARNER)).status, 404);
  const one = await call("GET", "/learner/assignments/asg_1", LEARNER);
  assertEquals(one.status, 200);
  assert(one.json.questions.every((q: Row) => !("answerKey" in q)), "no answer key for learners");
  // Staff: the teacher of the class and that school's head; nobody else at the school.
  assertEquals(asgIds(await call("GET", "/assignments", "tok_teacher")), ["asg_1", "asg_draft"]);
  assertEquals(asgIds(await call("GET", "/assignments", "tok_school_leader")), ["asg_1", "asg_draft"]);
  assertEquals(asgIds(await call("GET", "/assignments", "tok_teacher2")), [], "a teacher who doesn't teach the class");
  assertEquals((await call("GET", "/assignments/asg_1", "tok_teacher2")).status, 404);
  assertEquals((await call("GET", "/assignments/asg_1", "tok_teacher")).json.questions[0].answerKey, 0, "teachers do see the key");
  assertEquals(asgIds(await call("GET", "/assignments", "tok_admin")), ["asg_1", "asg_b", "asg_draft"]);
});

Deno.test("a teacher creates, edits and publishes an assignment for a class they teach", async () => {
  const db = freshWorld();
  const body = {
    classId: "cls_1", subjectId: "mathematics", title: "Times tables", description: "Practice", instructions: "Answer all",
    resourceId: "lib_1", startsAt: "2026-09-15T08:00:00.000Z", dueAt: new Date(Date.now() + 3 * 864e5).toISOString(), estimatedMinutes: 15,
    questions: [
      { type: "multiple_response", prompt: "Even numbers?", options: ["2", "3", "4"], answerKey: [0, 2], maxMarks: 2 },
      { type: "true_false", prompt: "3 x 3 = 9", answerKey: true, maxMarks: 1 },
      { type: "short_answer", prompt: "4 x 5 = ?", answerKey: ["20", "twenty"], maxMarks: 1 },
      { type: "file_upload", prompt: "Upload your working", maxMarks: 3 },
    ],
  };
  const made = await call("POST", "/assignments", "tok_teacher", body);
  assertEquals(made.status, 200, JSON.stringify(made.json));
  const a = made.json.assignment;
  assertEquals([a.status, a.maxMarks, a.termId, a.grade, a.estimatedMinutes], ["draft", 7, "2026-T3", "Grade 4", 15], "the term comes from the start date");
  assertEquals(made.json.questions.length, 4);
  // Not a class they teach; not a subject the class takes.
  assertEquals((await call("POST", "/assignments", "tok_teacher", { ...body, classId: "cls_1b" })).status, 400);
  assertEquals((await call("POST", "/assignments", "tok_teacher", { ...body, subjectId: "english" })).status, 400);
  // Edit, then publish; questions lock once published.
  assertEquals((await call("PATCH", `/assignments/${a.id}`, "tok_teacher", { title: "Times tables 2" })).json.assignment.title, "Times tables 2");
  assertEquals((await call("POST", `/assignments/${a.id}/status`, "tok_teacher", { status: "published" })).json.assignment.status, "published");
  assertEquals((await call("PATCH", `/assignments/${a.id}`, "tok_teacher", { questions: [] })).status, 409);
  assertEquals((await call("DELETE", `/assignments/${a.id}`, "tok_teacher")).status, 409, "published work is closed, not deleted");
  assert(db.audit_log.some((x) => x.action === "assignment.published" && x.target_id === a.id));
  // A draft with no questions can't be published.
  const empty = await call("POST", "/assignments", "tok_teacher", { classId: "cls_1", subjectId: "mathematics", title: "Empty", dueAt: body.dueAt });
  assertEquals((await call("POST", `/assignments/${empty.json.assignment.id}/status`, "tok_teacher", { status: "published" })).status, 409);
  assertEquals((await call("DELETE", `/assignments/${empty.json.assignment.id}`, "tok_teacher")).status, 200, "an unused draft can be deleted");
});

Deno.test("learner submission: start, save progress, hand in once, with a timestamp", async () => {
  const db = freshWorld();
  assertEquals((await call("POST", "/learner/assignments/asg_1/submit", LEARNER, {})).status, 409, "must start first");
  const started = await call("POST", "/learner/assignments/asg_1/start", LEARNER);
  assertEquals(started.json.completion, "in_progress");
  assertEquals((await call("PUT", "/learner/assignments/asg_1/answers", LEARNER, { answers: [{ questionId: "q_mc", response: 9 }] })).status, 400, "not one of the options");
  const saved = await call("PUT", "/learner/assignments/asg_1/answers", LEARNER, { answers: [{ questionId: "q_tm", response: "Draft answer" }] });
  assertEquals(saved.json.answers.find((x: Row) => x.questionId === "q_tm").response, "Draft answer", "progress is saved");
  const res = await call("POST", "/learner/assignments/asg_1/submit", LEARNER, { answers: [{ questionId: "q_mc", response: 0 }] });
  assertEquals(res.status, 200);
  const sub = db.assignment_submissions.find((x) => x.learner_id === "learner-id")!;
  assertEquals(sub.status, "submitted", "a teacher-marked question waits for the teacher");
  assert(sub.submitted_at && !sub.is_late);
  assertEquals(db.submission_answers.find((x) => x.question_id === "q_mc")!.auto_marks, 2, "the multiple choice is marked on submit");
  assertEquals(res.json.submission.marks, undefined, "no marks shown before marking");
  assertEquals((await call("POST", "/learner/assignments/asg_1/submit", LEARNER, {})).status, 409, "can't hand in twice");
  assertEquals((await call("PUT", "/learner/assignments/asg_1/answers", LEARNER, { answers: [] })).status, 409, "can't change it after handing in");
  assert(db.audit_log.some((x) => x.action === "submission.submitted" && x.actor_kind === "learner"));
});

Deno.test("work made only of auto-marked questions is marked on submission", async () => {
  const db = freshWorld();
  db.assignment_questions = db.assignment_questions.filter((q) => q.id !== "q_tm");
  const res = await learnerHandsIn([{ questionId: "q_mc", response: 1 }]);
  const sub = db.assignment_submissions.find((x) => x.learner_id === "learner-id")!;
  assertEquals([sub.status, sub.auto_marked, sub.marks, sub.percentage, sub.band], ["marked", true, 0, 0, "BE"]);
  assertEquals(res.json.submission.percentage, 0);
});

Deno.test("teacher grading: marks, maximum, percentage, band, feedback, date and marker", async () => {
  const db = freshWorld();
  await learnerHandsIn();
  const sub = db.assignment_submissions[0];
  assertEquals((await call("POST", `/submissions/${sub.id}/mark`, "tok_teacher", {})).status, 400, "the teacher-marked question still needs a mark");
  assertEquals((await call("POST", `/submissions/${sub.id}/mark`, "tok_teacher", { answers: [{ questionId: "q_tm", marks: 3 }] })).status, 400, "more than the question is worth");
  const res = await call("POST", `/submissions/${sub.id}/mark`, "tok_teacher", {
    answers: [{ questionId: "q_tm", marks: 1, feedback: "Show both steps." }], feedback: "Good start.",
  });
  assertEquals(res.status, 200, JSON.stringify(res.json));
  const s = db.assignment_submissions[0];
  assertEquals([s.status, s.marks, s.max_marks, s.percentage, s.band, s.feedback, s.marked_by], ["marked", 3, 4, 75, "ME", "Good start.", "teacher-id"]);
  assert(s.marked_at);
  assertEquals(res.json.submission.markerName, "teacher person");
  // The learner now sees the marks and feedback.
  const mine = await call("GET", "/learner/assignments/asg_1", LEARNER);
  assertEquals([mine.json.submission.marks, mine.json.submission.percentage, mine.json.submission.band], [3, 75, "ME"]);
  assertEquals(mine.json.answers.find((x: Row) => x.questionId === "q_tm").feedback, "Show both steps.");
  // Overriding an automatic mark is allowed, and re-marking is audited.
  await call("POST", `/submissions/${sub.id}/mark`, "tok_teacher", { answers: [{ questionId: "q_mc", marks: 1 }] });
  assertEquals(db.assignment_submissions[0].marks, 2);
  assert(db.audit_log.some((x) => x.action === "submission.marked") && db.audit_log.some((x) => x.action === "submission.remarked"));
});

Deno.test("unauthorized access: other teachers, heads, learners and schools can't reach the work", async () => {
  const db = freshWorld();
  await learnerHandsIn();
  const subId = db.assignment_submissions[0].id;
  // Another school's teacher and head: not found.
  for (const tok of ["tok_teacher_b", "tok_head_b"]) {
    assertEquals((await call("GET", "/assignments/asg_1", tok)).status, 404, tok);
    assertEquals((await call("GET", `/submissions/${subId}`, tok)).status, 404, tok);
  }
  assertEquals((await call("POST", `/submissions/${subId}/mark`, "tok_teacher_b", { answers: [{ questionId: "q_tm", marks: 1 }] })).status, 404);
  assertEquals((await call("PATCH", "/assignments/asg_1", "tok_teacher_b", { title: "x" })).status, 404);
  // Same school, not their class.
  assertEquals((await call("PATCH", "/assignments/asg_1", "tok_teacher2", { title: "x" })).status, 404);
  assertEquals((await call("POST", `/submissions/${subId}/mark`, "tok_teacher2", { answers: [{ questionId: "q_tm", marks: 1 }] })).status, 404);
  // The school head can look but not mark or edit.
  assertEquals((await call("GET", `/submissions/${subId}`, "tok_school_leader")).status, 200);
  assertEquals((await call("POST", `/submissions/${subId}/mark`, "tok_school_leader", {})).status, 403);
  assertEquals((await call("PATCH", "/assignments/asg_1", "tok_school_leader", { title: "x" })).status, 403);
  // A learner in another school can't open or start it; learners never reach staff routes.
  db.learner_sessions.push({ token: "learnerb", learner_id: "learner-b-id", created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600e3).toISOString() });
  assertEquals((await call("GET", "/learner/assignments/asg_1", "hpl_learnerb")).status, 404);
  assertEquals((await call("POST", "/learner/assignments/asg_1/start", "hpl_learnerb")).status, 404);
  assertEquals((await call("GET", "/assignments", LEARNER)).status, 403);
  assertEquals((await call("GET", `/submissions/${subId}`, LEARNER)).status, 403);
  assertEquals(db.assignment_submissions[0].status, "submitted", "nothing was marked by anyone unauthorised");
});

Deno.test("late submission is flagged; a closed assignment takes no more work", async () => {
  const db = freshWorld();
  db.assignments[0].due_at = new Date(Date.now() - 864e5).toISOString();
  const list = await call("GET", "/learner/assignments", LEARNER);
  assertEquals(list.json.assignments[0].overdue, true);
  await learnerHandsIn();
  assertEquals(db.assignment_submissions[0].is_late, true);
  // Closed: a classmate can no longer start it.
  addClassmate(db);
  db.learner_sessions.push({ token: "learnerc", learner_id: "learner-c-id", created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600e3).toISOString() });
  assertEquals((await call("POST", "/assignments/asg_1/status", "tok_teacher", { status: "closed" })).status, 200);
  assertEquals((await call("POST", "/learner/assignments/asg_1/start", "hpl_learnerc")).status, 409);
  const r = await call("GET", "/results?by=assignment", "tok_teacher");
  assertEquals(r.json.rows[0].completion, { assigned: 2, submitted: 1, onTime: 0, late: 1, missing: 1, rate: 50 });
});

Deno.test("result calculation keeps completion and achievement apart, by every dimension", async () => {
  const db = freshWorld();
  addClassmate(db);
  await learnerHandsIn();
  await call("POST", `/submissions/${db.assignment_submissions[0].id}/mark`, "tok_teacher", { answers: [{ questionId: "q_tm", marks: 1 }] });
  // Kid C never hands in; the work is now past due.
  db.assignments[0].due_at = new Date(Date.now() - 1000).toISOString();
  const byLearner = await call("GET", "/results?by=learner", "tok_teacher");
  const one = byLearner.json.rows.find((r: Row) => r.key === "learner-id");
  const c = byLearner.json.rows.find((r: Row) => r.key === "learner-c-id");
  assertEquals([one.label, one.completion.rate, one.achievement.averagePercent, one.achievement.band], ["Kid One", 100, 75, "ME"]);
  assertEquals([c.completion.rate, c.completion.missing, c.achievement.marked, c.achievement.averagePercent], [0, 1, 0, null],
    "not handing in is a completion gap, never a score of 0");
  for (const by of ["class", "subject", "grade", "term", "year"]) {
    const res = await call("GET", `/results?by=${by}`, "tok_teacher");
    assertEquals(res.status, 200, by);
    assertEquals(res.json.rows.length, 1, by);
    const row = res.json.rows[0];
    assertEquals(row.completion.assigned, 2, by);
    assertEquals(row.completion.rate, 50, `${by}: half the class handed in`);
    assertEquals(row.achievement.averagePercent, 75, `${by}: the marked work averages 75%`);
  }
  assertEquals((await call("GET", "/results?by=subject", "tok_teacher")).json.rows[0].label, "Mathematics");
  assertEquals((await call("GET", "/results?by=term", "tok_teacher")).json.rows[0].label, "2026 Term 3");
  // A learner sees only their own results.
  const mine = await call("GET", "/results?by=subject", LEARNER);
  assertEquals(mine.json.overall.completion.assigned, 1);
  assertEquals(mine.json.overall.achievement.averagePercent, 75);
  assertEquals((await call("GET", "/results?by=learner", LEARNER)).status, 400);
  // The dashboards report the two measures separately too.
  const overview = await call("GET", "/school/overview", "tok_school_leader");
  assertEquals([overview.json.completion.rate, overview.json.achievement.averagePercent], [50, 75]);
  const stats = await call("GET", `/stats?school=${encodeURIComponent(SCHOOL.name)}`, "tok_education_team");
  assertEquals(stats.json.gradeCompletion[0], { label: "Grade 4", value: 50, total: 2 });
  assertEquals(stats.json.gradeAchievement[0].value, 75);
  assertEquals(stats.json.gradePerformance, undefined, "completion is no longer reported as performance");
});

Deno.test("class filtering: assignments, submissions and results follow the class", async () => {
  const db = freshWorld();
  db.class_teachers.push({ id: "ct_3", class_id: "cls_1b", teacher_id: "teacher-id", role: "subject_teacher", ended_at: null });
  const other = await call("POST", "/assignments", "tok_teacher", { classId: "cls_1b", subjectId: "english", title: "Grade 5 essay", dueAt: new Date(Date.now() + 864e5).toISOString(), questions: [{ type: "teacher_marked", prompt: "Write", maxMarks: 10 }] });
  assertEquals(other.status, 200, JSON.stringify(other.json));
  await call("POST", `/assignments/${other.json.assignment.id}/status`, "tok_teacher", { status: "published" });
  await learnerHandsIn();
  assertEquals(asgIds(await call("GET", "/assignments?classId=cls_1", "tok_teacher")), ["asg_1"]);
  assertEquals(asgIds(await call("GET", "/assignments?classId=cls_1b", "tok_teacher")), [other.json.assignment.id]);
  assertEquals((await call("GET", "/submissions?classId=cls_1b", "tok_teacher")).json.submissions.length, 0);
  assertEquals((await call("GET", "/submissions?classId=cls_1&status=submitted", "tok_teacher")).json.submissions.length, 1);
  const r1b = await call("GET", "/results?by=class&classId=cls_1b", "tok_teacher");
  assertEquals(r1b.json.rows.map((r: Row) => r.key), [], "nobody is enrolled in Grade 5 East, so nothing is expected there");
  assertEquals((await call("GET", "/results?by=class&classId=cls_1", "tok_teacher")).json.rows[0].completion.submitted, 1);
  // The learner sees their class's work, not the other class's.
  assertEquals(asgIds(await call("GET", "/learner/assignments", LEARNER)), ["asg_1"]);
});

Deno.test("school isolation: results, submissions and assignments never cross schools", async () => {
  const db = freshWorld();
  await learnerHandsIn();
  db.learner_sessions.push({ token: "learnerb", learner_id: "learner-b-id", created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600e3).toISOString() });
  await call("POST", "/learner/assignments/asg_b/start", "hpl_learnerb");
  await call("POST", "/learner/assignments/asg_b/submit", "hpl_learnerb", { answers: [{ questionId: "q_b", response: true }] });
  const headB = await call("GET", "/results?by=school", "tok_head_b");
  assertEquals(headB.json.rows.map((r: Row) => r.key), ["sch_2"]);
  assertEquals(headB.json.rows[0].achievement.averagePercent, 100);
  assertEquals((await call("GET", "/results?by=school", "tok_school_leader")).json.rows.map((r: Row) => r.key), ["sch_1"]);
  assertEquals((await call("GET", "/results?by=school", "tok_admin")).json.rows.map((r: Row) => r.key).sort(), ["sch_1", "sch_2"]);
  // Even asking for the other school's learner or school by id gives nothing.
  assertEquals((await call("GET", "/results?by=learner&learnerId=learner-b-id", "tok_teacher")).json.rows, []);
  assertEquals((await call("GET", "/results?by=school&schoolId=sch_2", "tok_school_leader")).json.rows.map((r: Row) => r.key), ["sch_1"]);
  assertEquals((await call("GET", "/submissions", "tok_teacher_b")).json.submissions.map((s: Row) => s.learnerId), ["learner-b-id"]);
  assertEquals((await call("GET", "/submissions?schoolId=sch_1", "tok_head_b")).json.submissions.map((s: Row) => s.learnerId), ["learner-b-id"]);
  assertEquals(asgIds(await call("GET", "/assignments?schoolId=sch_1", "tok_head_b")), ["asg_b"]);
});

Deno.test("class management: subjects, grade, adding and removing learners", async () => {
  const db = freshWorld();
  assertEquals((await call("POST", "/classes/cls_1/subjects", "tok_school_leader", { subjectId: "english" })).status, 200);
  const cls = (await call("GET", "/classes", "tok_school_leader")).json.classes.find((x: Row) => x.id === "cls_1");
  assertEquals(cls.subjects.map((s: Row) => s.id), ["english", "mathematics"]);
  assertEquals((await call("POST", "/classes/cls_2/subjects", "tok_school_leader", { subjectId: "english" })).status, 404, "another school's class");
  assertEquals((await call("DELETE", "/classes/cls_1/subjects/english", "tok_school_leader")).status, 200);
  assert(db.class_subjects.some((x) => x.subject_id === "english" && x.removed_at), "removed, not deleted");
  // The grade can't change under active learners.
  assertEquals((await call("PATCH", "/classes/cls_1", "tok_school_leader", { grade: "Grade 6" })).status, 409);
  assertEquals((await call("PATCH", "/classes/cls_1b", "tok_school_leader", { grade: "Grade 6" })).status, 200);
  // Take a learner out of the class, then put them back.
  assertEquals((await call("DELETE", "/classes/cls_1/learners/learner-id", "tok_teacher")).status, 200);
  assertEquals(db.learners.find((l) => l.id === "learner-id")!.class_id, null);
  const back = await call("POST", "/classes/cls_1/learners", "tok_teacher", { learnerIds: ["learner-id", "learner-b-id"] });
  assertEquals([back.json.added, back.json.skipped], [1, 1], "the other school's learner is skipped");
  assertEquals(db.learners.find((l) => l.id === "learner-b-id")!.class_id, "cls_2");
  assertEquals((await call("POST", "/classes/cls_1b/learners", "tok_teacher", { learnerIds: ["learner-id"] })).status, 404, "not a class they teach");
  assert(db.audit_log.filter((a) => a.action === "learner.class_changed").length >= 2);
});

/* ------------------------------------------------------------ 9. programme intelligence */

Deno.test("programme intelligence: analysts only, real numbers, filters, visit types", async () => {
  const db = freshWorld();
  for (const tok of ["tok_teacher", "tok_school_leader", "tok_field_officer", LEARNER]) {
    assertEquals((await call("GET", "/intelligence", tok)).status, 403, tok);
  }
  await learnerHandsIn();
  await call("POST", `/submissions/${db.assignment_submissions[0].id}/mark`, "tok_teacher", { answers: [{ questionId: "q_tm", marks: 1 }] });
  const all = await call("GET", "/intelligence", "tok_me");
  assertEquals(all.status, 200, JSON.stringify(all.json));
  assertEquals(all.json.learning.totals.schools, 2);
  assertEquals(all.json.learning.achievement.averagePercent, 75);
  assertEquals(all.json.learning.completion.assigned, 2, "one learner per school expected");
  const a = await call("GET", `/intelligence?school=${encodeURIComponent(SCHOOL.name)}`, "tok_education_team");
  assertEquals([a.json.learning.totals.schools, a.json.learning.completion.assigned, a.json.learning.completion.submitted], [1, 1, 1]);
  // "Teacher support" is a visit type now; made-up types are refused.
  const visit = { schoolId: "sch_1", responses: [], clientRef: "ref-ts-1" };
  assertEquals((await call("POST", "/field-reports", "tok_field_officer", { ...visit, visitType: "Teacher support" })).status, 200);
  assertEquals((await call("POST", "/field-reports", "tok_field_officer", { ...visit, clientRef: "ref-x", visitType: "Picnic" })).status, 400);
  const after = await call("GET", "/intelligence", "tok_admin");
  assertEquals(after.json.implementation.byType.find((t: Row) => t.label === "Teacher support").visits, 1);
  assertEquals(after.json.implementation.schools.visited, 1);
});
