/**
 * The test world for the `api` Edge Function: the real Hono app, run
 * against an in-memory stand-in for Supabase (no database, no network).
 * Shared by authz_test.ts and isolation_test.ts.
 *
 * Accounts — every role, signed in with `tok_<role>` (learners: `hpl_learnertoken`):
 *   super_admin, admin, education_team, me, field_officer (assigned Narok),
 *   school_leader and teacher (Aitong Primary, sch_1), learner (Kid One, sch_1),
 *   plus teacher2, a second school's head and teacher (head_b, teacher_b, sch_2),
 *   and one account in each non-active state: pending, suspended, rejected, deactivated.
 * twoCounties() adds Meru County with its own school (sch_3), teacher and learner.
 */
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
Deno.env.set("HPF_API_TEST", "1");
export const { app, __setAdminClientForTests, __setMailerForTests, __setPwnedCheckForTests, __setSigningKeysForTests, __setFrameFetchForTests, changeContext } = await import("./index.ts");
import { isSecret, KINDS } from "./history.ts";
// A link's site, asked whether it may be shown in the portal (embed.ts): it says yes unless a test says otherwise.
__setFrameFetchForTests(() => Promise.resolve(new Response("", { status: 200 })));
/** Passwords the stand-in breach list knows. The real list (pwned.ts) is never called in tests. */
export const LEAKED_PASSWORDS = new Set(["password123", "qwertyuiop"]);
__setPwnedCheckForTests((pw: string) => Promise.resolve(LEAKED_PASSWORDS.has(pw) ? 1_000_000 : 0));

/* ------------------------------------------------------------ in-memory Supabase */

// deno-lint-ignore no-explicit-any
export type Row = Record<string, any>;
export type Db = Record<string, Row[]>;

/* The database's change history (capture_change() in the change_history
   migration, checked on real Postgres by tests/change-history.test.mjs), as
   the stand-in keeps it: who, from which request, before and after, secrets
   left out, bookkeeping alone skipped, and the record's school and county. */
function recordChange(db: Db, table: string, op: "insert" | "update" | "delete", before: Row | null, after: Row | null) {
  const k = KINDS[table];
  if (!k || (op === "insert" && k.editsOnly)) return;
  let changed: string[] = [];
  if (op === "update") {
    changed = Object.keys(after!).filter((f) => JSON.stringify(before![f] ?? null) !== JSON.stringify(after![f] ?? null) && !(k.noise ?? []).includes(f)).sort();
    if (!changed.length) return;
  }
  const clean = (r: Row | null) => (r ? Object.fromEntries(Object.entries(r).filter(([f]) => !isSecret(f)).map(([f, v]) => [f, structuredClone(v)])) : null);
  const r = (after ?? before)!;
  let sid: string | null = table === "schools" ? r.id : r.school_id ?? null;
  let cty: string | null = table === "counties" ? r.name : r.county ?? null;
  if (!sid) {
    const via = r.class_id ? db.classes?.find((x) => x.id === r.class_id)
      : r.assignment_id ? db.assignments?.find((x) => x.id === r.assignment_id)
      : r.register_id ? db.attendance_registers?.find((x) => x.id === r.register_id)
      : r.visit_id ? db.field_reports?.find((x) => x.id === r.visit_id)
      : r.training_id ? db.trainings?.find((x) => x.id === r.training_id) : null;
    sid = via?.school_id ?? null;
    if (r.training_id && !cty) cty = via?.county ?? null;
  }
  if (!cty && sid) cty = db.schools?.find((s) => s.id === sid)?.county ?? null;
  const ctx = changeContext();
  const log = (db.change_log ??= []);
  log.push({
    id: log.length + 1, at: new Date(Date.now() + log.length).toISOString(), table_name: table, record_id: k.key.map((f) => r[f] ?? "").join(":"),
    op, changed, old_row: clean(before), new_row: clean(after),
    actor_id: ctx?.["x-hpf-actor-id"] || null, actor_role: ctx?.["x-hpf-actor-role"] || null,
    actor_kind: ctx ? ctx["x-hpf-actor-kind"] : "database", request_id: ctx?.["x-hpf-request-id"] ?? null, route: ctx?.["x-hpf-route"] ?? null,
    school_id: sid, county: cty,
  });
}

export function fakeAdmin(db: Db, users: Record<string, { id: string; email: string }>) {
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
    let conflict = "id";
    let ignoreDup = false;
    let orderBy: [string, boolean] | null = null; // modelled for the change history only
    // Embedded-resource filters ("learners.teacher_id") aren't modelled.
    const f = (k: string, test: (v: unknown) => boolean) => { if (!k.includes(".")) filters.push((r) => test(r[k])); return api; };
    const run = () => {
      // A test can make a table's reads fail (db.__fail_reads = ["profiles"]): a failed read must never show as zero.
      const failing = (db as unknown as { __fail_reads?: string[] }).__fail_reads;
      if (op === "select" && failing?.includes(table)) return { data: null, error: { message: `could not read ${table}` } };
      const rows = db[table];
      const match = (r: Row) => filters.every((t) => t(r));
      let out: Row[] = [];
      if (op === "upsert") {
        const keys = conflict.split(",").map((k) => k.trim());
        const list = (Array.isArray(payload) ? payload : [payload]) as Row[];
        out = [];
        for (const p of list) {
          const hit = keys.every((k) => p[k] !== undefined) ? rows.find((r) => keys.every((k) => r[k] === p[k])) : undefined;
          if (hit) {
            if (!ignoreDup) { const was = structuredClone(hit); Object.assign(hit, p); recordChange(db, table, "update", was, hit); }
            out.push(hit);
            continue;
          }
          const row = { id: p.id ?? `${table}_${seq++}`, created_at: new Date().toISOString(), ...p };
          rows.push(row);
          recordChange(db, table, "insert", null, row);
          out.push(row);
        }
      } else if (op === "insert") {
        const list = (Array.isArray(payload) ? payload : [payload]) as Row[];
        out = list.map((p) => {
          const row: Row = { id: p.id ?? `${table}_${seq++}`, created_at: new Date().toISOString(), ...p };
          if (table === "audit_log") row.id = seq++;
          // The database's own default: a visit starts when it's recorded.
          if (table === "library_interactions" && !row.started_at) row.started_at = row.created_at;
          rows.push(row);
          recordChange(db, table, "insert", null, row);
          return row;
        });
      } else if (op === "update") {
        out = rows.filter(match);
        for (const r of out) { const was = structuredClone(r); Object.assign(r, payload); recordChange(db, table, "update", was, r); }
      } else if (op === "delete") {
        out = rows.filter(match);
        db[table] = rows.filter((r) => !match(r));
        for (const r of out) recordChange(db, table, "delete", r, null);
        // The database's ON DELETE SET NULL: a deleted folder's items stay, unfiled.
        if (table === "library_folders") {
          for (const it of db.library_items ?? []) {
            if (out.some((f) => f.id === it.folder_id)) { const was = structuredClone(it); it.folder_id = null; recordChange(db, "library_items", "update", was, it); }
          }
        }
      } else {
        out = rows.filter(match);
      }
      if (orderBy) {
        const [col, asc] = orderBy;
        out = [...out].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
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
      // deno-lint-ignore no-explicit-any
      upsert(p: Row, o?: any) { op = "upsert"; payload = p; conflict = o?.onConflict ?? "id"; ignoreDup = !!o?.ignoreDuplicates; return api; },
      update(p: Row) { op = "update"; payload = p; return api; },
      delete() { op = "delete"; return api; },
      eq: (k: string, v: unknown) => f(k, (x) => x === v),
      neq: (k: string, v: unknown) => f(k, (x) => x !== v),
      is: (k: string, v: unknown) => f(k, (x) => (v === null ? x == null : x === v)),
      in: (k: string, vs: unknown[]) => f(k, (x) => vs.includes(x)),
      ilike: (k: string, v: string) => f(k, (x) => String(x ?? "").toLowerCase() === v.replace(/\\(.)/g, "$1").toLowerCase()),
      lt: (k: string, v: number) => f(k, (x) => (x as number) < v),
      gt: (k: string, v: number) => f(k, (x) => (x as number) > v),
      gte: (k: string, v: unknown) => f(k, (x) => (x as number) >= (v as number)),
      lte: (k: string, v: unknown) => f(k, (x) => (x as number) <= (v as number)),
      not: () => api, like: () => api, abortSignal: () => api,
      // deno-lint-ignore no-explicit-any
      order(col: string, o?: any) { if (table === "change_log") orderBy = [col, o?.ascending !== false]; return api; },
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
    // The database functions the API calls: only the cron secret check.
    rpc: (name: string, args: Row) => Promise.resolve(name === "notify_cron_secret_ok"
      ? { data: args.candidate === CRON_SECRET, error: null }
      : { data: null, error: { message: `no function ${name}` } }),
    auth: {
      // Every token Supabase Auth is asked about (jwt_test.ts: a token
      // checked in the function never comes here).
      getUser: (jwt: string) => {
        (db.auth_lookups ??= []).push({ jwt });
        return Promise.resolve(users[jwt]
          ? { data: { user: users[jwt] }, error: null }
          : { data: { user: null }, error: { message: "invalid" } });
      },
      // A reset email "sent" through the project's mail settings; a test
      // sets db.auth_mail_error to make the mail server refuse.
      resetPasswordForEmail: (email: string, opts: Row) => {
        if (db.auth_mail_error) return Promise.resolve({ data: null, error: db.auth_mail_error[0] });
        (db.auth_emails ??= []).push({ email, redirectTo: opts?.redirectTo });
        return Promise.resolve({ data: {}, error: null });
      },
      admin: {
        createUser: () => Promise.resolve(ok),
        updateUserById: (id: string, attrs: Row) => {
          if (attrs?.password) (db.auth_passwords ??= []).push({ id, password: attrs.password });
          return Promise.resolve(ok);
        },
        listUsers: () => Promise.resolve({
          data: { users: Object.values(users).map((u) => ({ ...u, last_sign_in_at: u.id === "teacher-id" ? "2026-10-02T08:00:00.000Z" : null })) },
          error: null,
        }),
      },
    },
    storage: {
      // db.storage_files: { bucket, folder, name } — what list() finds.
      from: (bucket: string) => ({
        list: (folder: string) => Promise.resolve({
          data: (db.storage_files ?? []).filter((f) => f.bucket === bucket && f.folder === folder).map((f) => ({ name: f.name })),
          error: null,
        }),
        createSignedUrl: () => Promise.resolve({ data: { signedUrl: "https://signed" }, error: null }),
        createSignedUploadUrl: () => Promise.resolve({ data: { token: "t", signedUrl: "https://up" }, error: null }),
        // Recorded, so a test can see what was removed (history_test.ts: nothing, on a delete).
        remove: (paths: string[]) => { ((db as unknown as { __storage_removed?: string[] }).__storage_removed ??= []).push(...paths); return Promise.resolve({ data: [], error: null }); },
      }),
    },
  };
}

/* ------------------------------------------------------------ fixtures */

export const STAFF = ["super_admin", "admin", "education_team", "me", "field_officer", "school_leader", "teacher"] as const;
export const ROLES = [...STAFF, "learner"] as const;
export type R = (typeof ROLES)[number];
export const ALL: R[] = [...ROLES];
export const NON_ACTIVE = ["pending", "suspended", "rejected", "deactivated"] as const;

export const CRON_SECRET = "c".repeat(64);
export const SCHOOL = { id: "sch_1", name: "Aitong Primary", county: "Narok", code: "NRK-001", seq: 1 };
export const SCHOOL_B = { id: "sch_2", name: "Olpusimoru Primary", county: "Narok", code: "NRK-002", seq: 2 };
export const idOf = (role: string) => `00000000-0000-0000-0000-${role.padEnd(12, "0").slice(0, 12).replace(/[^0-9a-f]/g, "a")}`;

export let USERS: Record<string, { id: string; email: string }> = {};
export function freshWorld() {
  const now = new Date().toISOString();
  const inAWeek = new Date(Date.now() + 7 * 864e5).toISOString();
  const users: Record<string, { id: string; email: string }> = {};
  USERS = users;
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
    schools: [{ ...SCHOOL }, { ...SCHOOL_B }], // copies: a test that renames one mustn't rename it for the next
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
    kobo_raw_submissions: [],
    kobo_records: [],
    kobo_record_issues: [],
    kobo_school_aliases: [],
    dq_issues: [],
    dq_issue_events: [],
    dq_scans: [],
    me_programmes: [], me_outcomes: [], me_indicators: [], me_targets: [], me_actuals: [], me_evidence: [], me_reports: [],
    trainings: [], training_attendance: [],
    attendance_registers: [], attendance_marks: [],
    sync_requests: [], device_sync_status: [], learner_device_sync_status: [], sync_events: [],
    notifications: [], notification_events: [], notification_runs: [],
    staff_invitations: [],
    // The field officer works in Narok (as the migration sets up from their profile county).
    staff_scopes: [{ id: "scp_fo", profile_id: "field_officer-id", scope_type: "county", county: "Narok", school_id: null, note: "", created_at: now, created_by: null, ended_at: null, ended_by: null }],
    permission_grants: [],
    audit_log: [],
  };
  __setAdminClientForTests(fakeAdmin(db, users));
  return db;
}

export async function call(method: string, path: string, token?: string, body?: unknown, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...extra };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await app.request(`/api${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: Row = {};
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json, headers: res.headers, replay: res.headers.get("idempotent-replay") === "true", cache: res.headers.get("cache-control") };
}
export const tokenFor = (role: R) => (role === "learner" ? "hpl_learnertoken" : `tok_${role}`);

/* ------------------------------------------------------------ a second county */

export const SCHOOL_C = { id: "sch_3", name: "Meru Central", county: "Meru", code: "MRU-001", seq: 1 };

/** The usual world plus a second county (Meru) with its own school, learner, teacher, visit and data issue. */
export function twoCounties() {
  const db = freshWorld();
  const now = new Date().toISOString();
  db.counties.push({ name: "Meru", code: "MRU", created_at: now });
  db.schools.push({ ...SCHOOL_C });
  db.learners.push({ id: "learner-c-id", teacher_id: "teacher-id", current_teacher_id: null, class_id: null, username: "kid.c", full_name: "Kid C", grade: "Grade 4",
    school: SCHOOL_C.name, school_id: SCHOOL_C.id, county: "Meru", pin_hash: "x", pin_salt: "y", user_code: "MRU-001-L0001", learner_code: "MRU-001-L0001",
    enrollment_status: "ACTIVE", academic_year_id: "2026", term_id: "2026-T3" });
  db.profiles.push({ id: "teacher-c-id", role: "teacher", status: "active", full_name: "Teacher C", email: "teacher-c@test.org", school: SCHOOL_C.name, school_id: SCHOOL_C.id, county: "Meru" });
  db.field_reports.push(
    { id: "fr_n", officer_id: "field_officer-id", school: SCHOOL.name, county: "Narok", visit_type: "ICT", school_id: SCHOOL.id, created_at: now },
    { id: "fr_m", officer_id: "field_officer-id", school: SCHOOL_C.name, county: "Meru", visit_type: "ICT", school_id: SCHOOL_C.id, created_at: now },
  );
  db.dq_issues.push(
    { id: "dq_n", issue_key: "k_n", type: "missing_grade", severity: "HIGH", status: "OPEN", summary: "Narok issue", entity_type: "learner", entity_id: "learner-id", entity_label: "Kid One", related: [], school_id: SCHOOL.id, county: "Narok", first_detected_at: now, last_detected_at: now, still_present: true },
    { id: "dq_m", issue_key: "k_m", type: "missing_grade", severity: "HIGH", status: "OPEN", summary: "Meru issue", entity_type: "learner", entity_id: "learner-c-id", entity_label: "Kid C", related: [], school_id: SCHOOL_C.id, county: "Meru", first_detected_at: now, last_detected_at: now, still_present: true },
  );
  return db;
}
export const assign = (db: Db, profileId: string, rows: { county?: string; school_id?: string }[]) => {
  for (const [i, x] of rows.entries()) {
    db.staff_scopes.push({ id: `scp_${profileId}_${i}`, profile_id: profileId, scope_type: x.county ? "county" : "school", county: x.county ?? null,
      school_id: x.school_id ?? null, note: "", created_at: new Date().toISOString(), created_by: "super_admin-id", ended_at: null, ended_by: null });
  }
};
