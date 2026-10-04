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
import { localDay } from "./notifications.ts";

import {
  Row, Db, fakeAdmin, STAFF, ROLES, R, ALL, NON_ACTIVE, CRON_SECRET, SCHOOL, SCHOOL_B, idOf, USERS, freshWorld, call, tokenFor, SCHOOL_C, twoCounties, assign, app, __setAdminClientForTests, __setMailerForTests, __setPwnedCheckForTests, LEAKED_PASSWORDS,
} from "./test_world.ts";

/* ------------------------------------------------------------ the expected access table
   Hand-written spec. `who` = the roles that must get PAST authorization. */

/* Named after responsibilities (docs/RBAC.md). Super Admin is in every
   management group: they keep every right. */
const SA_ONLY: R[] = ["super_admin"];
const ADMINS: R[] = ["super_admin", "admin"];                                  // organisation, people, operations
const ME_ROLES: R[] = ["super_admin", "me"];                                   // results framework, indicator results, M&E reports
const CONTENT: R[] = ["super_admin", "education_team"];                        // content, training register, subjects
const FORM_MANAGERS: R[] = ["super_admin", "admin", "education_team"];         // build and send forms
const DATA_QUALITY: R[] = ["super_admin", "admin", "me"];                      // data quality, Kobo review and results
const STATS: R[] = ["super_admin", "admin", "me"];
const DASHBOARDS: R[] = ["super_admin", "me"];                                 // programme performance
const LEARNING_DASHBOARDS: R[] = ["super_admin", "me", "education_team"];      // the learning side
const ANALYSTS: R[] = ["super_admin", "admin", "education_team", "me"];        // read programme data within their scope
const PLACE_VIEWERS: R[] = [...ANALYSTS, "field_officer", "school_leader"];    // schools and teachers within scope
const LEARNER_VIEWERS: R[] = [...ANALYSTS, "school_leader", "teacher"];
const LEARNER_MANAGERS: R[] = ["super_admin", "admin", "school_leader", "teacher"];
const CLASS_MANAGERS: R[] = ["super_admin", "admin", "school_leader"];
const USER_ADMIN = ADMINS;

/* Every allowed role must get a real success (2xx), not just get past the
   guard — so a route whose work needs records (an M&E programme, a started
   assignment, a connected Kobo…) has a `setup` that makes them in that
   call's fresh world, usually through the API itself. It runs for EVERY
   role, so the refusals are also checked against real records. Its ids
   fill `{name}` placeholders in the path, and a body can be a function of
   them. `refused` lists the rare allowed-role cases where a finer rule than
   the route's permission legitimately says no, with the status expected. */
type Ids = Record<string, string>;
type Setup = (db: Db, role: R) => Promise<Ids | void> | Ids | void;
type RouteSpec = {
  method: string; path: string; route: string; who: R[];
  body?: unknown | ((ids: Ids) => unknown); setup?: Setup; refused?: Partial<Record<R, number>>;
};
const r = (method: string, route: string, who: R[], body?: unknown, path?: string, more: Pick<RouteSpec, "setup" | "refused"> = {}): RouteSpec =>
  ({ method, route, path: path ?? route.replace(":id", "x1").replace(":name", "Nowhere").replace(":uid", "aAbCdEfGh123"), who, body, ...more });
/** Placeholders not made by a setup become "x1" (an id that doesn't exist). */
const withDefaults = (ids: Ids): Ids => new Proxy(ids, { get: (t, k) => (typeof k === "string" ? t[k] ?? "x1" : undefined) });
const pathFor = (spec: RouteSpec, ids: Ids = {}) => spec.path.replace(/\{(\w+)\}/g, (_, k) => withDefaults(ids)[k]);
const bodyFor = (spec: RouteSpec, ids: Ids = {}) => (typeof spec.body === "function" ? (spec.body as (i: Ids) => unknown)(withDefaults(ids)) : spec.body);
/** Cleanups a setup registers (e.g. the Kobo stand-in), run after the call. */
let afterCall: (() => void)[] = [];
const idOfRole = (role: R) => (role === "learner" ? "learner-id" : `${role}-id`);
const SA = "tok_super_admin";
async function made(method: string, path: string, body: unknown, token = SA): Promise<Row> {
  const res = await call(method, path, token, body);
  if (res.status < 200 || res.status > 299) throw new Error(`setup ${method} ${path} → ${res.status} ${JSON.stringify(res.json)}`);
  return res.json;
}
/* Setups shared by several routes. */
async function koboConnected(db: Db) {
  connectKobo(db);
  afterCall.push(stubKobo(() => [kRow(1)]));
}
async function koboSynced(db: Db): Promise<Ids> {
  await koboConnected(db);
  await made("POST", "/kobo/sync", {});
  return { record: db.kobo_records[0].id };
}
async function meFramework(): Promise<Ids> {
  const programme = (await made("POST", "/mel/programmes", { name: "Teach2030" })).id;
  const outcome = (await made("POST", "/mel/outcomes", { programmeId: programme, title: "Teachers use ICT" })).id;
  const indicator = (await made("POST", "/mel/indicators", { outcomeId: outcome, name: "Head teachers trained", unit: "count", source: "manual" })).id;
  return { programme, outcome, indicator };
}
/** An actual recorded by a second M&E officer, so both M&E and the Super Admin may verify it. */
async function meActual(db: Db): Promise<Ids> {
  const ids = await meFramework();
  USERS["tok_me2"] = { id: "me2-id", email: "me2@test.org" };
  db.profiles.push({ id: "me2-id", role: "me", status: "active", full_name: "Second M&E", email: "me2@test.org", school: "", school_id: null, county: "" });
  const actual = (await made("POST", "/mel/actuals", { indicatorId: ids.indicator, period: "2026-T3", scopeType: "programme", value: 12 }, "tok_me2")).id;
  return { ...ids, actual };
}
async function meReport(): Promise<Ids> {
  const ids = await meFramework();
  const report = (await made("POST", "/mel/reports", { programmeId: ids.programme, period: "2026-T3", scopeType: "programme" })).id;
  return { ...ids, report };
}
/** A learner's started (and optionally handed-in) attempt at asg_1. */
async function startedWork(submit = false): Promise<Ids> {
  const started = await made("POST", "/learner/assignments/asg_1/start", {}, "hpl_learnertoken");
  if (submit) await made("POST", "/learner/assignments/asg_1/submit", {}, "hpl_learnertoken");
  return { submission: started.submission?.id ?? started.id };
}

const ROUTES: RouteSpec[] = [
  // Only someone whose account predates school codes still picks a school.
  r("PUT", "/me/school", ["teacher", "school_leader"], { schoolId: "sch_1" }, undefined, {
    setup: (db, role) => { const p = db.profiles.find((x) => x.id === idOfRole(role)); if (p) p.school_id = null; },
  }),
  r("POST", "/counties", ADMINS, { name: "Kajiado", code: "KJD" }),
  r("DELETE", "/counties/:name", ADMINS, undefined, "/counties/Kajiado", { setup: async () => { await made("POST", "/counties", { name: "Kajiado", code: "KJD" }); } }),
  r("POST", "/schools", ADMINS, { name: "New School", county: "Narok" }),
  r("PATCH", "/schools/:id", ADMINS, { name: "Renamed" }, "/schools/sch_1"),
  r("DELETE", "/schools/:id", ADMINS, undefined, "/schools/{school}", { setup: async () => ({ school: (await made("POST", "/schools", { name: "Spare School", county: "Narok" })).school?.id }) }),
  r("GET", "/learners", LEARNER_VIEWERS),
  r("POST", "/learners", LEARNER_MANAGERS, { fullName: "Kid Two", username: "kid.two", pin: "1234", schoolId: "sch_1" }),
  r("PATCH", "/learners/:id", LEARNER_MANAGERS, { fullName: "Kid" }, "/learners/learner-id"),
  r("DELETE", "/learners/:id", LEARNER_MANAGERS, undefined, "/learners/learner-id"),
  r("POST", "/learners/:id/status", LEARNER_MANAGERS, { status: "INACTIVE" }, "/learners/learner-id/status"),
  r("POST", "/learners/:id/transfer", ADMINS, { toSchoolId: "sch_2" }, "/learners/learner-id/transfer"),
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
  r("POST", "/library", CONTENT, { title: "T", subject: "English", type: "Reading" }),
  r("PATCH", "/library/:id", CONTENT, { published: true }, "/library/lib_1"),
  r("DELETE", "/library/:id", CONTENT, undefined, "/library/lib_1"),
  r("GET", "/library/folders", ALL),
  r("POST", "/library/folders", CONTENT, { name: "F" }),
  r("DELETE", "/library/folders/:id", CONTENT),
  // On the staff shelf, which every staff role reads; learners read the library
  // shelf. Field officers read no shelf at all, so to them it doesn't exist.
  r("POST", "/library/:id/interactions", ALL, {}, "/library/lib_1/interactions", {
    setup: (db, role) => { if (role !== "learner") db.library_items[0].audience = "staff"; }, refused: { field_officer: 404 },
  }),
  r("PATCH", "/library/interactions/:id/complete", ALL, {}, "/library/interactions/li_1/complete", { setup: (db, role) => { db.library_interactions[0].actor_id = idOfRole(role); } }),
  r("GET", "/library/interactions/mine", ALL),
  r("POST", "/library/:id/badge", ALL, {}, "/library/lib_1/badge", {
    setup: (db, role) => { if (role !== "learner") db.library_items[0].audience = "staff"; }, refused: { field_officer: 404 },
  }),
  r("GET", "/library/usage", ANALYSTS),
  r("GET", "/forms", [...ANALYSTS, "field_officer", "school_leader", "teacher"]),
  r("POST", "/forms", FORM_MANAGERS, { title: "F", audience: "teacher", questions: [{ id: "q1", prompt: "P", type: "text" }] }),
  r("DELETE", "/forms/:id", FORM_MANAGERS, undefined, "/forms/form_1"),
  r("POST", "/forms/:id/archive", FORM_MANAGERS, {}, "/forms/form_1/archive"),
  r("POST", "/forms/:id/restore", FORM_MANAGERS, {}, "/forms/form_1/restore"),
  // A file-upload form sent to the caller's own role.
  r("POST", "/forms/:id/response-upload", ["field_officer", "school_leader", "teacher"], { name: "a.pdf" }, "/forms/form_1/response-upload", { setup: (db, role) => { Object.assign(db.forms[0], { audience: role, kind: "file" }); } }),
  r("GET", "/responses", [...ANALYSTS, "field_officer", "school_leader", "teacher"]),
  r("POST", "/responses", ["field_officer", "school_leader", "teacher"], { formId: "form_1", answers: [{ questionId: "q1", value: "x" }] }, undefined, { setup: (db, role) => { db.forms[0].audience = role; } }),
  r("GET", "/subjects", [...STAFF]),
  r("POST", "/subjects", CONTENT, { name: "Music" }),
  r("POST", "/classes/:id/subjects", CLASS_MANAGERS, { subjectId: "english" }, "/classes/cls_1/subjects"),
  r("DELETE", "/classes/:id/subjects/:subjectId", CLASS_MANAGERS, undefined, "/classes/cls_1/subjects/mathematics"),
  r("POST", "/classes/:id/learners", LEARNER_MANAGERS, { learnerIds: ["learner-id"] }, "/classes/cls_1/learners"),
  r("DELETE", "/classes/:id/learners/:learnerId", LEARNER_MANAGERS, undefined, "/classes/cls_1/learners/learner-id"),
  r("GET", "/assignments", LEARNER_VIEWERS),
  r("POST", "/assignments", ["teacher"], { classId: "cls_1", subjectId: "mathematics", title: "New work" }),
  r("GET", "/assignments/:id", LEARNER_VIEWERS, undefined, "/assignments/asg_1"),
  r("PATCH", "/assignments/:id", ["teacher"], { title: "Renamed" }, "/assignments/asg_1"),
  r("POST", "/assignments/:id/status", ["teacher"], { status: "closed" }, "/assignments/asg_1/status"),
  // Only a draft can be deleted.
  r("DELETE", "/assignments/:id", ["teacher"], undefined, "/assignments/{draft}", {
    setup: async () => ({ draft: (await made("POST", "/assignments", { classId: "cls_1", subjectId: "mathematics", title: "Draft" }, "tok_teacher")).assignment.id }),
  }),
  r("GET", "/submissions", LEARNER_VIEWERS),
  r("GET", "/submissions/:id", LEARNER_VIEWERS, undefined, "/submissions/{submission}", { setup: () => startedWork(true) }),
  r("POST", "/submissions/:id/mark", ["teacher"], { answers: [{ questionId: "q_tm", marks: 2 }] }, "/submissions/{submission}/mark", { setup: () => startedWork(true) }),
  r("GET", "/learner/assignments", ["learner"]),
  r("GET", "/learner/assignments/:id", ["learner"], undefined, "/learner/assignments/asg_1"),
  r("POST", "/learner/assignments/:id/start", ["learner"], {}, "/learner/assignments/asg_1/start"),
  r("PUT", "/learner/assignments/:id/answers", ["learner"], { answers: [] }, "/learner/assignments/asg_1/answers", { setup: () => startedWork() }),
  r("POST", "/learner/assignments/:id/upload", ["learner"], { questionId: "q_up", name: "a.pdf" }, "/learner/assignments/asg_1/upload", {
    setup: (db) => {
      db.assignment_questions.push({ id: "q_up", assignment_id: "asg_1", position: 3, type: "file_upload", prompt: "Upload your working", options: [], answer_key: null, max_marks: 2 });
      return startedWork();
    },
  }),
  r("POST", "/learner/assignments/:id/submit", ["learner"], {}, "/learner/assignments/asg_1/submit", { setup: () => startedWork() }),
  r("GET", "/results", [...LEARNER_VIEWERS, "learner"]),
  r("GET", "/field-reports", [...ANALYSTS, "field_officer"]),
  r("POST", "/field-reports", ["field_officer"], { schoolId: "sch_1", visitType: "Learning", responses: [] }),
  r("GET", "/stats", STATS),
  r("GET", "/intelligence", DASHBOARDS),
  r("GET", "/impact", LEARNING_DASHBOARDS),
  r("GET", "/sync/status", ALL),
  r("GET", "/notifications", ALL),
  r("POST", "/notifications/:id/read", ALL, {}, "/notifications/ntf_1/read", {
    setup: (db, role) => { db.notifications.push({ id: "ntf_1", recipient_id: idOfRole(role), recipient_kind: role === "learner" ? "learner" : "staff", kind: "form_due", title: "A form is due", body: "", link: null, dedupe_key: "k1", created_at: new Date().toISOString(), read_at: null }); },
  }),
  r("POST", "/notifications/read-all", ALL, {}),
  r("GET", "/notifications/log", ADMINS),
  r("POST", "/notifications/run-now", ADMINS, {}),
  r("PATCH", "/forms/:id", FORM_MANAGERS, { dueOn: "2026-10-10" }, "/forms/form_1"),
  r("POST", "/sync/report", [...STAFF], { deviceId: "device-0001" }),
  r("GET", "/sync/devices", ADMINS),
  // Reports export: each report's own permissions decide who may export it.
  r("GET", "/reports", [...STAFF]),
  r("GET", "/reports/:id", LEARNER_VIEWERS, undefined, "/reports/learner-register"),
  r("GET", "/reports/:id", PLACE_VIEWERS, undefined, "/reports/teacher-register"),
  r("GET", "/reports/:id", PLACE_VIEWERS, undefined, "/reports/school-register"),
  r("GET", "/reports/:id", LEARNER_VIEWERS, undefined, "/reports/assignment-report"),
  r("GET", "/reports/:id", LEARNER_VIEWERS, undefined, "/reports/assessment-report"),
  r("GET", "/reports/:id", [...ANALYSTS, "field_officer"], undefined, "/reports/field-visit-report"),
  r("GET", "/reports/:id", DATA_QUALITY, undefined, "/reports/kobo-report"),
  r("GET", "/reports/:id", ANALYSTS, undefined, "/reports/library-usage"),
  r("GET", "/reports/:id", ME_ROLES, undefined, "/reports/me-indicator-report"),
  r("GET", "/reports/:id", ["super_admin", "admin", "me", "school_leader"], undefined, "/reports/term-report"),
  r("GET", "/reports/:id", STATS, undefined, "/reports/county-report"),
  r("GET", "/trainings", LEARNING_DASHBOARDS),
  r("GET", "/trainings/teachers", CONTENT),
  r("GET", "/trainings/:id", LEARNING_DASHBOARDS, undefined, "/trainings/{training}", { setup: async () => ({ training: (await made("POST", "/trainings", { title: "ICT workshop", heldOn: "2026-09-10" })).training.id }) }),
  r("POST", "/trainings", CONTENT, { title: "ICT workshop", heldOn: "2026-09-10" }),
  r("PATCH", "/trainings/:id", CONTENT, { title: "Renamed" }, "/trainings/{training}", { setup: async () => ({ training: (await made("POST", "/trainings", { title: "ICT workshop", heldOn: "2026-09-10" })).training.id }) }),
  r("POST", "/data-quality/scan", DATA_QUALITY, {}),
  r("GET", "/data-quality/summary", DATA_QUALITY),
  r("GET", "/data-quality/issues", DATA_QUALITY),
  r("GET", "/data-quality/issues/:id", DATA_QUALITY, undefined, "/data-quality/issues/{issue}", { setup: async (db) => { db.learners[0].grade = "Grade 99"; await made("POST", "/data-quality/scan", {}); return { issue: db.dq_issues.find((i) => i.type === "invalid_grade")!.id }; } }),
  r("PATCH", "/data-quality/issues/:id", DATA_QUALITY, { status: "UNDER_REVIEW" }, "/data-quality/issues/{issue}", { setup: async (db) => { db.learners[0].grade = "Grade 99"; await made("POST", "/data-quality/scan", {}); return { issue: db.dq_issues.find((i) => i.type === "invalid_grade")!.id }; } }),
  r("POST", "/data-quality/issues/bulk", DATA_QUALITY, (ids: Ids) => ({ ids: [ids.issue], status: "UNDER_REVIEW" }), undefined, { setup: async (db) => { db.learners[0].grade = "Grade 99"; await made("POST", "/data-quality/scan", {}); return { issue: db.dq_issues.find((i) => i.type === "invalid_grade")!.id }; } }),
  // Correcting the learner itself needs learners.manage.all, which M&E doesn't have.
  r("POST", "/data-quality/issues/:id/fix", DATA_QUALITY, { action: "set_learner_grade", grade: "Grade 4" }, "/data-quality/issues/{issue}/fix", { setup: async (db) => { db.learners[0].grade = "Grade 99"; await made("POST", "/data-quality/scan", {}); return { issue: db.dq_issues.find((i) => i.type === "invalid_grade")!.id }; }, refused: { me: 403 } }),
  r("GET", "/mel/programmes", ME_ROLES),
  r("POST", "/mel/programmes", ME_ROLES, { name: "Teach2030" }),
  r("PATCH", "/mel/programmes/:id", ME_ROLES, { name: "x" }, "/mel/programmes/{programme}", { setup: meFramework }),
  r("GET", "/mel/programmes/:id", ME_ROLES, undefined, "/mel/programmes/{programme}", { setup: meFramework }),
  r("GET", "/mel/programmes/:id/results", ME_ROLES, undefined, "/mel/programmes/{programme}/results?period=2026-T3", { setup: meFramework }),
  r("POST", "/mel/outcomes", ME_ROLES, (ids: Ids) => ({ programmeId: ids.programme, title: "O" }), undefined, { setup: meFramework }),
  r("PATCH", "/mel/outcomes/:id", ME_ROLES, { title: "O" }, "/mel/outcomes/{outcome}", { setup: meFramework }),
  r("POST", "/mel/indicators", ME_ROLES, (ids: Ids) => ({ outcomeId: ids.outcome, name: "I", unit: "count", source: "manual" }), undefined, { setup: meFramework }),
  r("PATCH", "/mel/indicators/:id", ME_ROLES, { name: "I" }, "/mel/indicators/{indicator}", { setup: meFramework }),
  r("GET", "/mel/indicators/:id/breakdown", ME_ROLES, undefined, "/mel/indicators/{indicator}/breakdown?period=2026-T3", { setup: meFramework }),
  r("GET", "/mel/indicators/:id/trend", ME_ROLES, undefined, "/mel/indicators/{indicator}/trend", { setup: meFramework }),
  r("GET", "/mel/dashboard", ME_ROLES),
  r("PUT", "/mel/targets", ME_ROLES, (ids: Ids) => ({ indicatorId: ids.indicator, period: "2026-T3", scopeType: "programme", value: 75 }), undefined, { setup: meFramework }),
  r("POST", "/mel/actuals", ME_ROLES, (ids: Ids) => ({ indicatorId: ids.indicator, period: "2026-T3", scopeType: "programme", value: 1 }), undefined, { setup: meFramework }),
  r("GET", "/mel/actuals/:id", ME_ROLES, undefined, "/mel/actuals/{actual}", { setup: meActual }),
  r("POST", "/mel/actuals/:id/verify", ME_ROLES, { decision: "verified", note: "Checked the register" }, "/mel/actuals/{actual}/verify", { setup: meActual }),
  r("POST", "/mel/actuals/:id/evidence", ME_ROLES, { kind: "note", title: "N" }, "/mel/actuals/{actual}/evidence", { setup: meActual }),
  r("POST", "/mel/actuals/:id/evidence-upload", ME_ROLES, { name: "a.pdf" }, "/mel/actuals/{actual}/evidence-upload", { setup: meActual }),
  r("GET", "/mel/reports", ME_ROLES),
  r("POST", "/mel/reports", ME_ROLES, (ids: Ids) => ({ programmeId: ids.programme, period: "2026-T3", scopeType: "programme" }), undefined, { setup: meFramework }),
  r("GET", "/mel/reports/:id", ME_ROLES, undefined, "/mel/reports/{report}", { setup: meReport }),
  r("POST", "/mel/reports/:id/refresh", ME_ROLES, {}, "/mel/reports/{report}/refresh", { setup: meReport }),
  r("POST", "/mel/reports/:id/finalize", ME_ROLES, {}, "/mel/reports/{report}/finalize", { setup: meReport }),
  r("GET", "/school/overview", ["school_leader"]),
  r("GET", "/users", ADMINS),
  r("GET", "/users/invitations", USER_ADMIN),
  r("POST", "/users/invitations", USER_ADMIN, { email: "fresh@test.org", role: "teacher", schoolId: "sch_1" }),
  r("DELETE", "/users/invitations/:id", USER_ADMIN, undefined, "/users/invitations/{invitation}", { setup: async () => ({ invitation: (await made("POST", "/users/invitations", { email: "fresh@test.org", role: "teacher", schoolId: "sch_1" })).invitation.id }) }),
  r("POST", "/users/invitations/:id/renew", USER_ADMIN, {}, "/users/invitations/{invitation}/renew", { setup: async () => ({ invitation: (await made("POST", "/users/invitations", { email: "fresh@test.org", role: "teacher", schoolId: "sch_1" })).invitation.id }) }),
  r("POST", "/users/:id/approve", USER_ADMIN, {}, "/users/pending-id/approve"),
  r("POST", "/users/:id/reject", USER_ADMIN, {}, "/users/pending-id/reject"),
  r("POST", "/users/:id/status", USER_ADMIN, { action: "suspend" }, "/users/teacher2-id/status"),
  r("PATCH", "/users/:id", USER_ADMIN, { fullName: "Renamed" }, "/users/teacher2-id"),
  r("POST", "/users/:id/reset-link", USER_ADMIN, {}, "/users/teacher2-id/reset-link"),
  r("POST", "/users/:id/temporary-password", USER_ADMIN, {}, "/users/teacher2-id/temporary-password"),
  r("GET", "/audit", SA_ONLY),
  r("GET", "/kobo/config", DATA_QUALITY),
  r("PUT", "/kobo/config", SA_ONLY, { apiToken: "test-token", baseUrl: "https://kobo.test" }, undefined, { setup: () => { afterCall.push(stubKobo(() => [])); } }),
  r("GET", "/kobo/assets", ADMINS, undefined, undefined, { setup: koboConnected }),
  r("GET", "/kobo/forms", DATA_QUALITY),
  r("POST", "/kobo/forms", ADMINS, { assetUid: "aNewSurvey77" }, undefined, { setup: koboConnected }),
  r("GET", "/kobo/assets/:uid/preview", ADMINS, undefined, undefined, {
    setup: (db) => { connectKobo(db); afterCall.push(stubKobo(() => [], { ...KOBO_ASSET, deployment__links: { url: "https://ee.kobo.test/x/aAbC" } })); },
  }),
  r("DELETE", "/kobo/forms/:id", ADMINS, undefined, "/kobo/forms/kb_1"),
  r("POST", "/kobo/forms/:id/restore", ADMINS, {}, "/kobo/forms/kb_1/restore"),
  r("POST", "/kobo/sync", ADMINS, {}, undefined, { setup: koboConnected }),
  r("GET", "/kobo/forms/:id/results", DATA_QUALITY, undefined, "/kobo/forms/kb_1/results"),
  r("GET", "/kobo/forms/:id/pipeline", DATA_QUALITY, undefined, "/kobo/forms/kb_1/pipeline"),
  r("PUT", "/kobo/forms/:id/mapping", ADMINS, { school: null }, "/kobo/forms/kb_1/mapping", { setup: koboSynced }),
  r("POST", "/kobo/forms/:id/reprocess", ADMINS, {}, "/kobo/forms/kb_1/reprocess", { setup: koboSynced }),
  r("GET", "/kobo/records", DATA_QUALITY, undefined, "/kobo/records?formId=kb_1"),
  r("GET", "/kobo/records/:id", DATA_QUALITY, undefined, "/kobo/records/{record}", { setup: koboSynced }),
  r("POST", "/kobo/records/:id/review", DATA_QUALITY, { decision: "accepted", note: "Checked by phone" }, "/kobo/records/{record}/review", { setup: koboSynced }),
  r("GET", "/kobo/school-aliases", DATA_QUALITY),
  r("POST", "/kobo/school-aliases", DATA_QUALITY, { value: "Aitong Pri", schoolId: "sch_1" }),
  r("DELETE", "/kobo/school-aliases/:key", DATA_QUALITY, undefined, "/kobo/school-aliases/aitong%20pri", { setup: async () => { await made("POST", "/kobo/school-aliases", { value: "Aitong Pri", schoolId: "sch_1" }); } }),
  r("POST", "/kobo/webhook", SA_ONLY, {}, undefined, { setup: (db) => connectKobo(db) }),
  r("DELETE", "/kobo/webhook", SA_ONLY),
  // Workspaces: badges, overviews, people, scope, grants.
  r("GET", "/nav/badges", ALL),
  r("GET", "/me/access", ALL),
  r("GET", "/platform/overview", SA_ONLY),
  r("GET", "/admin/overview", ADMINS),
  r("GET", "/teachers", PLACE_VIEWERS),
  r("GET", "/schools/:id/profile", PLACE_VIEWERS, undefined, "/schools/sch_1/profile"),
  r("GET", "/users/:id/access", ADMINS, undefined, "/users/teacher2-id/access"),
  r("GET", "/users/:id/history", ADMINS, undefined, "/users/teacher2-id/history"),
  r("PUT", "/users/:id/scope", ADMINS, { counties: ["Narok"] }, "/users/field_officer-id/scope"),
  r("POST", "/users/:id/grants", SA_ONLY, { permission: "kobo.review", reason: "Covering M&E" }, "/users/education_team-id/grants"),
  r("POST", "/users/:id/grants/:grantId/revoke", SA_ONLY, { reason: "Done" }, "/users/education_team-id/grants/{grant}/revoke", {
    setup: async () => ({ grant: (await made("POST", "/users/education_team-id/grants", { permission: "kobo.review", reason: "Covering M&E" })).grant?.id }),
  }),
  r("GET", "/permissions", SA_ONLY),
  r("GET", "/security/activity", SA_ONLY),
  r("GET", "/kobo/my-surveys", ["field_officer"]),
  r("POST", "/kobo/my-surveys/:id/submitted", ["field_officer"], {}, "/kobo/my-surveys/kb_1/submitted"),
];
/** Need a sign-in but no particular permission (sign-up, own profile, school list). */
const SIGNED_IN_ONLY = ["GET /me", "POST /me", "POST /me/accept-invite", "GET /schools", "POST /me/password"];
const PUBLIC = ["GET /health", "POST /auth/register", "POST /learner/login", "POST /learner/logout", "GET /invitations/:token", "POST /kobo/hook", "POST /notifications/run"];

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
  Deno.test(`${spec.method} ${spec.path} — ${spec.who.join(", ")} succeed; everyone else is refused`, async () => {
    for (const role of ROLES) {
      const db = freshWorld();
      afterCall = [];
      try {
        const ids = (await spec.setup?.(db, role)) ?? {};
        const { status, json } = await call(spec.method, pathFor(spec, ids), tokenFor(role), bodyFor(spec, ids));
        const what = `${role} on ${spec.method} ${pathFor(spec, ids)}: ${status} ${JSON.stringify(json).slice(0, 200)}`;
        if (!spec.who.includes(role)) assertEquals(status, 403, `should be refused — ${what}`);
        else if (spec.refused?.[role]) assertEquals(status, spec.refused[role], `a finer rule should refuse — ${what}`);
        else assert(status >= 200 && status < 300, `should succeed — ${what}`);
      } finally {
        afterCall.forEach((f) => f());
      }
    }
  });
}

/* ------------------------------------------------------------ 3. no session / bad session / non-active accounts */

Deno.test("no session and invalid tokens are refused on every protected route", async () => {
  for (const spec of ROUTES) {
    freshWorld();
    assertEquals((await call(spec.method, pathFor(spec), undefined, bodyFor(spec))).status, 401, `${spec.method} ${spec.route} without a token`);
    assertEquals((await call(spec.method, pathFor(spec), "tok_forged", bodyFor(spec))).status, 401, `${spec.method} ${spec.route} with a forged token`);
    assertEquals((await call(spec.method, pathFor(spec), "hpl_forged", bodyFor(spec))).status, 401, `${spec.method} ${spec.route} with a forged learner token`);
  }
});

Deno.test("pending, suspended, rejected and deactivated accounts reach no protected route", async () => {
  for (const st of NON_ACTIVE) {
    for (const spec of ROUTES) {
      freshWorld();
      const { status, json } = await call(spec.method, pathFor(spec), `tok_${st}`, bodyFor(spec));
      assertEquals(status, 403, `${st} account on ${spec.method} ${spec.route}`);
      assertEquals(json.accountStatus, st);
    }
  }
});

Deno.test("signed-in-only routes still need a valid session", async () => {
  freshWorld();
  for (const [m, p] of [["GET", "/me"], ["POST", "/me"], ["POST", "/me/accept-invite"], ["GET", "/schools"], ["POST", "/me/password"]]) {
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
  assertEquals((await call("POST", "/users/teacher2-id/reset-link", "tok_admin", {})).status, 200);
  const temp = await call("POST", "/users/teacher2-id/temporary-password", "tok_admin", {});
  assertEquals(temp.status, 200);
  const byAction = (x: string) => db.audit_log.filter((a) => a.action === x && a.target_id === "teacher2-id");
  assertEquals(byAction("password.reset_link_sent").length, 1);
  assertEquals(byAction("password.temporary_set").length, 1);
  assert(!JSON.stringify(db.audit_log).includes(temp.json.temporaryPassword), "the password must never be logged");
  assertEquals(byAction("role.changed")[0].details, { from: "teacher", to: "school_leader" });
  assertEquals(byAction("school.changed")[0].details.to, "sch_2");
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

/* Invitation email: the portal sends the same one-time link the administrator can copy. */
const MAIL_ENV = { MAIL_PROVIDER: "resend", MAIL_API_KEY: "re_test_not_real", MAIL_FROM: "no-reply@humanpractice.org" };
async function withMail(fn: (sent: Row[], fail: (e: string | null) => void) => Promise<void>, configured = true) {
  const sent: Row[] = [];
  let failure: string | null = null;
  __setMailerForTests((m) => {
    if (failure) return Promise.resolve({ ok: false, error: failure });
    sent.push(m);
    return Promise.resolve({ ok: true, id: `m${sent.length}` });
  });
  for (const [k, v] of Object.entries(MAIL_ENV)) configured ? Deno.env.set(k, v) : Deno.env.delete(k);
  try {
    await fn(sent, (e) => (failure = e));
  } finally {
    for (const k of Object.keys(MAIL_ENV)) Deno.env.delete(k);
    __setMailerForTests(null);
  }
}

Deno.test("invitation email: not set up yet — the invitation is still made, to copy", () => withMail(async (sent) => {
  const db = freshWorld();
  assertEquals((await call("GET", "/users/invitations", "tok_admin")).json.emailReady, false);
  const res = await call("POST", "/users/invitations", "tok_admin", { email: "new@test.org", role: "teacher", schoolId: "sch_1", send: true });
  assertEquals(res.status, 200);
  assertEquals(res.json.emailed, false);
  assert(/isn't set up/.test(res.json.emailError), res.json.emailError);
  assert(res.json.token, "the link can still be copied");
  assertEquals(sent.length, 0);
  assertEquals(db.staff_invitations.length, 1);
  assert(!db.audit_log.some((a) => a.action === "invitation.emailed"));
}, false));

Deno.test("invitation email: sent to the invited address with the same one-time link, and audited", () => withMail(async (sent) => {
  const db = freshWorld();
  assertEquals((await call("GET", "/users/invitations", "tok_admin")).json.emailReady, true);
  const res = await call("POST", "/users/invitations", "tok_admin",
    { email: "New@Test.org", role: "teacher", schoolId: "sch_1", send: true, portalUrl: "https://khaima.github.io/Learning-portal/" });
  assertEquals([res.status, res.json.emailed], [200, true]);
  assertEquals(res.cache, "no-store");
  const token = res.json.token as string;
  assertEquals(sent.length, 1);
  const m = sent[0];
  assertEquals([m.to, m.replyTo], ["new@test.org", "admin@test.org"]);
  const link = `https://khaima.github.io/Learning-portal/index.html?invite=${encodeURIComponent(token)}`;
  assert(m.html.includes(link) && m.text.includes(link), "the email carries the invitation link");
  assert(m.text.includes("Teacher") && m.text.includes("Aitong Primary (NRK-001)") && m.text.includes("admin person"));
  // The link in the email is the real one…
  assertEquals((await call("GET", `/invitations/${token}`)).json.invitation.email, "new@test.org");
  // …and it's never stored or logged.
  for (const table of ["staff_invitations", "audit_log", "sync_requests"]) {
    assert(!JSON.stringify(db[table]).includes(token), `the link token leaked into ${table}`);
  }
  const a = db.audit_log.find((x) => x.action === "invitation.emailed")!;
  assertEquals([a.actor_id, a.target_id, a.details.email], ["admin-id", db.staff_invitations[0].id, "new@test.org"]);
  // Without "send", nothing is emailed.
  await call("POST", "/users/invitations", "tok_admin", { email: "copy@test.org", role: "teacher", schoolId: "sch_1" });
  assertEquals(sent.length, 1);
  // A link only ever points at the portal itself.
  await call("POST", "/users/invitations", "tok_admin", { email: "x@test.org", role: "teacher", schoolId: "sch_1", send: true, portalUrl: "https://evil.example/" });
  assert(sent[1].text.includes("https://learning-portal-mu-two.vercel.app/index.html?invite="));
}));

Deno.test("invitation email: when the mail provider refuses, the invitation stands and the link can be copied", () => withMail(async (sent, fail) => {
  const db = freshWorld();
  fail("the mail provider refused the API key");
  const res = await call("POST", "/users/invitations", "tok_admin", { email: "new@test.org", role: "teacher", schoolId: "sch_1", send: true });
  assertEquals([res.status, res.json.emailed], [200, false]);
  assert(res.json.emailError.includes("refused the API key") && res.json.token);
  assertEquals(db.staff_invitations.length, 1);
  assertEquals(sent.length, 0);
  assert(!db.audit_log.some((a) => a.action === "invitation.emailed"));
}));

Deno.test("renewing an invitation: a new link (emailed or to copy), the old one stops working", () => withMail(async (sent) => {
  const db = freshWorld();
  const first = await call("POST", "/users/invitations", "tok_admin", { email: "new@test.org", role: "field_officer", county: "Narok" });
  const id = first.json.invitation.id as string;
  const oldToken = first.json.token as string;
  db.staff_invitations[0].expires_at = new Date(Date.now() - 864e5).toISOString(); // lapsed

  const renewed = await call("POST", `/users/invitations/${id}/renew`, "tok_admin", { send: true, portalUrl: "https://learning-portal-mu-two.vercel.app/index.html" });
  assertEquals([renewed.status, renewed.json.emailed, renewed.json.invitation.status], [200, true, "open"]);
  const newToken = renewed.json.token as string;
  assert(newToken && newToken !== oldToken);
  assertEquals((await call("GET", `/invitations/${oldToken}`)).status, 404, "the old link stops working");
  assertEquals((await call("GET", `/invitations/${newToken}`)).status, 200);
  assert(sent[0].text.includes(`https://learning-portal-mu-two.vercel.app/index.html?invite=${encodeURIComponent(newToken)}`));
  assert(Date.parse(renewed.json.invitation.expiresAt) > Date.now() + 13 * 864e5, "another 14 days");
  const r = db.audit_log.find((x) => x.action === "invitation.renewed")!;
  assertEquals([r.actor_id, r.target_id], ["admin-id", id]);
  assert(!JSON.stringify(db.audit_log).includes(newToken));

  // Renew without emailing: a link to copy.
  const copy = await call("POST", `/users/invitations/${id}/renew`, "tok_admin", {});
  assertEquals([copy.status, copy.json.emailed], [200, false]);
  assertEquals(sent.length, 1);

  // Not once it's used…
  assertEquals((await call("POST", "/me/accept-invite", "tok_new", { token: copy.json.token, fullName: "New Officer" })).status, 200);
  assertEquals((await call("POST", `/users/invitations/${id}/renew`, "tok_admin", {})).status, 409);
  // …or revoked, or for a role above yours, or not there.
  const other = await call("POST", "/users/invitations", "tok_admin", { email: "other@test.org", role: "teacher", schoolId: "sch_1" });
  await call("DELETE", `/users/invitations/${other.json.invitation.id}`, "tok_admin");
  assertEquals((await call("POST", `/users/invitations/${other.json.invitation.id}/renew`, "tok_admin", {})).status, 409);
  const adminInvite = await call("POST", "/users/invitations", "tok_super_admin", { email: "boss@test.org", role: "admin" });
  assertEquals((await call("POST", `/users/invitations/${adminInvite.json.invitation.id}/renew`, "tok_admin", {})).status, 403);
  assertEquals((await call("POST", "/users/invitations/inv_none/renew", "tok_admin", {})).status, 404);
}));

Deno.test("audit history is readable only with audit.view, and shows the entries", async () => {
  const db = freshWorld();
  await call("POST", "/users/teacher2-id/temporary-password", "tok_admin", {});
  const res = await call("GET", "/audit?targetId=teacher2-id", "tok_super_admin");
  assertEquals(res.status, 200);
  assertEquals(res.json.entries[0].action, "password.temporary_set");
  const security = await call("GET", "/audit?kind=security", "tok_super_admin");
  assert(security.json.entries.some((e: Row) => e.action === "password.temporary_set"), "password actions are security events");
  assertEquals((await call("GET", "/audit", "tok_education_team")).status, 403);
  assertEquals((await call("GET", "/audit", "tok_me")).status, 403);
  assert(db.audit_log.length > 0);
});

/* ------------------------------------------------------------ 5b. passwords: reset links, temporary passwords */

/** A token shaped like Supabase's, signed in at `at` (ms) — only its amr claim is read. */
function sessionToken(userId: string, email: string, at: number) {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const jwt = `${b64({ alg: "HS256" })}.${b64({ sub: userId, amr: [{ method: "password", timestamp: Math.floor(at / 1000) }] })}.sig`;
  USERS[jwt] = { id: userId, email };
  return jwt;
}

Deno.test("a reset link is emailed by Supabase Auth to the account's own address, and audited", async () => {
  const db = freshWorld();
  let res = await call("POST", "/users/teacher2-id/reset-link", "tok_admin", { redirectTo: "https://khaima.github.io/Learning-portal/index.html?flow=recovery" });
  assertEquals(res.status, 200);
  assertEquals(db.auth_emails, [{ email: "teacher2@test.org", redirectTo: "https://khaima.github.io/Learning-portal/index.html?flow=recovery" }]);
  const a = db.audit_log.find((x) => x.action === "password.reset_link_sent")!;
  assertEquals([a.actor_id, a.target_id, a.details.email], ["admin-id", "teacher2-id", "teacher2@test.org"]);
  // The link only ever leads back to the portal itself.
  await call("POST", "/users/teacher2-id/reset-link", "tok_admin", { redirectTo: "https://evil.example/index.html" });
  await call("POST", "/users/teacher2-id/reset-link", "tok_admin", { redirectTo: "https://learning-portal-mu-two.vercel.app/" });
  await call("POST", "/users/teacher2-id/reset-link", "tok_admin", { redirectTo: "https://khaima.github.io/Other/index.html" });
  assertEquals(db.auth_emails.slice(1).map((e: Row) => e.redirectTo), [
    "https://learning-portal-mu-two.vercel.app/index.html?flow=recovery",
    "https://learning-portal-mu-two.vercel.app/index.html?flow=recovery",
    "https://learning-portal-mu-two.vercel.app/index.html?flow=recovery",
  ]);
  // Never to someone the caller can't manage, or an account that can't sign in.
  assertEquals((await call("POST", "/users/super_admin-id/reset-link", "tok_admin", {})).status, 403);
  assertEquals((await call("POST", "/users/admin-id/reset-link", "tok_admin", {})).status, 403, "not your own account");
  assertEquals((await call("POST", "/users/suspended-id/reset-link", "tok_admin", {})).status, 409);
  assertEquals((await call("POST", "/users/no-such-id/reset-link", "tok_admin", {})).status, 404);
  assertEquals(db.auth_emails.length, 4);
  // The mail server refusing is reported, and nothing is audited for it.
  db.auth_mail_error = [{ status: 429, message: "email rate limit exceeded" }];
  res = await call("POST", "/users/teacher2-id/reset-link", "tok_admin", {});
  assertEquals(res.status, 429);
  db.auth_mail_error = [{ status: 500, message: "Error sending recovery email" }];
  assertEquals((await call("POST", "/users/teacher2-id/reset-link", "tok_admin", {})).status, 502);
  assertEquals(db.audit_log.filter((x) => x.action === "password.reset_link_sent").length, 4);
});

Deno.test("the old 'set a new password' route is gone", async () => {
  freshWorld();
  assertEquals((await call("POST", "/users/teacher2-id/reset-password", "tok_super_admin", { password: "a-new-password" })).status, 404);
});

Deno.test("a temporary password is shown once, must be changed at next sign-in, and is never stored or logged", async () => {
  const db = freshWorld();
  const issued = Date.now();
  const res = await call("POST", "/users/teacher2-id/temporary-password", "tok_admin", {}, { "Idempotency-Key": "temp-pass-key-1" });
  assertEquals(res.status, 200);
  const temp = res.json.temporaryPassword as string;
  assert(/^[A-HJ-NP-Za-hj-np-z2-9]{4}(-[A-HJ-NP-Za-hj-np-z2-9]{4}){3}$/.test(temp), temp);
  assertEquals(res.cache, "no-store");
  assertEquals(db.auth_passwords.at(-1), { id: "teacher2-id", password: temp });
  const prof = db.profiles.find((p) => p.id === "teacher2-id")!;
  assertEquals(prof.must_change_password, true);
  assert(!String(prof.temporary_password_hash).includes(temp), "only a hash is kept");
  // Not in the audit log, and not kept for an offline-retry replay.
  const a = db.audit_log.find((x) => x.action === "password.temporary_set")!;
  assertEquals([a.actor_id, a.target_id], ["admin-id", "teacher2-id"]);
  for (const table of ["audit_log", "sync_requests", "notifications"]) {
    assert(!JSON.stringify(db[table] ?? []).includes(temp), `the temporary password leaked into ${table}`);
  }
  assertEquals(db.sync_requests.length, 0);

  // Until it's changed, the account reaches nothing — every protected route.
  const me = await call("GET", "/me", "tok_teacher2");
  assertEquals(me.json.profile.mustChangePassword, true);
  for (const spec of ROUTES) {
    const r = await call(spec.method, pathFor(spec), "tok_teacher2", bodyFor(spec));
    assertEquals(r.status, 403, `${spec.method} ${spec.route}`);
    assertEquals(r.json.mustChangePassword, true, `${spec.method} ${spec.route}`);
  }
  // A session left open from before can't replace it…
  const old = await call("POST", "/me/password", "tok_teacher2", { password: "my-own-password" });
  assertEquals([old.status, old.json.signInAgain], [401, true]);
  // …and signing in with it, the temporary one can't be kept, nor a short one.
  const fresh = sessionToken("teacher2-id", "teacher2@test.org", issued + 1000);
  assertEquals((await call("POST", "/me/password", fresh, { password: temp })).status, 400);
  assertEquals((await call("POST", "/me/password", fresh, { password: "short" })).status, 400);
  assertEquals((await call("POST", "/me/password", fresh, { password: "x".repeat(73) })).status, 400);
  assertEquals(db.profiles.find((p) => p.id === "teacher2-id")!.must_change_password, true);

  const done = await call("POST", "/me/password", fresh, { password: "my-own-password" });
  assertEquals(done.status, 200);
  assertEquals(db.auth_passwords.at(-1), { id: "teacher2-id", password: "my-own-password" });
  const after = db.profiles.find((p) => p.id === "teacher2-id")!;
  assertEquals([after.must_change_password, after.temporary_password_hash], [false, null]);
  assert(after.password_changed_at);
  const changed = db.audit_log.find((x) => x.action === "password.changed")!;
  assertEquals([changed.actor_id, changed.target_id, changed.details.afterTemporary], ["teacher2-id", "teacher2-id", true]);
  assert(!JSON.stringify(db.audit_log).includes("my-own-password"));
  // Back to work.
  assertEquals((await call("GET", "/forms", fresh)).status, 200);
  assertEquals((await call("GET", "/me", fresh)).json.profile.mustChangePassword, false);
  // The admin's list shows it waiting, then done.
  const list = await call("GET", "/users", "tok_admin");
  assertEquals(list.json.users.find((u: Row) => u.id === "teacher2-id").mustChangePassword, false);
});

Deno.test("temporary passwords follow the same authority rules as other account changes", async () => {
  const db = freshWorld();
  assertEquals((await call("POST", "/users/super_admin-id/temporary-password", "tok_admin", {})).status, 403);
  assertEquals((await call("POST", "/users/admin-id/temporary-password", "tok_admin", {})).status, 403, "not your own account");
  assertEquals((await call("POST", "/users/pending-id/temporary-password", "tok_admin", {})).status, 409);
  assertEquals((await call("POST", "/users/teacher2-id/temporary-password", "tok_education_team", {})).status, 403);
  assertEquals(db.auth_passwords ?? [], []);
  assert(!db.profiles.some((p) => p.must_change_password), "a refused request changes nothing");
  // A Super Admin can for an admin.
  assertEquals((await call("POST", "/users/admin-id/temporary-password", "tok_super_admin", {})).status, 200);
  assertEquals((await call("GET", "/users", "tok_admin")).status, 403, "and that admin is held at the password step");
});

Deno.test("a password known from a data breach is refused at sign-up and when changing it", async () => {
  const db = freshWorld();
  const reg = await call("POST", "/auth/register", undefined, { email: "fresh@test.org", password: "password123" });
  assertEquals(reg.status, 400);
  assert(/data breach/.test(reg.json.error));
  assertEquals((await call("POST", "/auth/register", undefined, { email: "fresh@test.org", password: "a-long-unusual-phrase" })).status, 200);
  const change = await call("POST", "/me/password", "tok_teacher", { password: "qwertyuiop" });
  assertEquals(change.status, 400);
  assertEquals(db.auth_passwords ?? [], [], "nothing was changed");
  assert(!db.audit_log.some((a) => a.action === "password.changed"));
  assertEquals((await call("POST", "/me/password", "tok_teacher", { password: "a-long-unusual-phrase" })).status, 200);
  // If the breach list can't be reached, people can still choose a password.
  __setPwnedCheckForTests(() => Promise.resolve(null));
  try {
    assertEquals((await call("POST", "/me/password", "tok_admin", { password: "password123" })).status, 200);
  } finally {
    __setPwnedCheckForTests((pw: string) => Promise.resolve(LEAKED_PASSWORDS.has(pw) ? 1_000_000 : 0));
  }
});

Deno.test("changing your own password: staff only, any account state, audited", async () => {
  const db = freshWorld();
  assertEquals((await call("POST", "/me/password", "hpl_learnertoken", { password: "learner-pass" })).status, 403);
  assertEquals((await call("POST", "/me/password", "tok_teacher", { password: "a-better-password" })).status, 200);
  const a = db.audit_log.find((x) => x.action === "password.changed")!;
  assertEquals([a.actor_id, a.target_id, a.details.afterTemporary], ["teacher-id", "teacher-id", false]);
  // A pending account (e.g. after "forgot password") can still choose one.
  assertEquals((await call("POST", "/me/password", "tok_pending", { password: "pending-pass-1" })).status, 200);
  // Signed in but no profile yet: Supabase Auth only, nothing to audit.
  assertEquals((await call("POST", "/me/password", "tok_new", { password: "brand-new-pass" })).status, 200);
  assertEquals(db.auth_passwords.map((p: Row) => p.id), ["teacher-id", "pending-id", "new-id"]);
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
  assertEquals((await call("GET", "/stats", "tok_me")).json.byRole.learner, 1, "only learner-b-id is active");
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
  const stats = await call("GET", `/stats?school=${encodeURIComponent(SCHOOL.name)}`, "tok_me");
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
  const a = await call("GET", `/intelligence?school=${encodeURIComponent(SCHOOL.name)}`, "tok_me");
  assertEquals([a.json.learning.totals.schools, a.json.learning.completion.assigned, a.json.learning.completion.submitted], [1, 1, 1]);
  // "Teacher support" is a visit type now; made-up types are refused.
  const visit = { schoolId: "sch_1", responses: [], clientRef: "ref-ts-1" };
  assertEquals((await call("POST", "/field-reports", "tok_field_officer", { ...visit, visitType: "Teacher support" })).status, 200);
  assertEquals((await call("POST", "/field-reports", "tok_field_officer", { ...visit, clientRef: "ref-x", visitType: "Picnic" })).status, 400);
  const after = await call("GET", "/intelligence", "tok_super_admin");
  assertEquals(after.json.implementation.byType.find((t: Row) => t.label === "Teacher support").visits, 1);
  assertEquals(after.json.implementation.schools.visited, 1);
});

/* ------------------------------------------------------------ 10. Kobo ingestion pipeline */

const KOBO_ASSET = {
  name: "Classroom observation", version_id: "v7", deployment__active: true,
  content: {
    survey: [
      { type: "start", name: "start" }, { type: "end", name: "end" },
      { type: "hidden", name: "officer_ref" },
      { type: "text", name: "school_code", label: ["School code"], required: true },
      { type: "date", name: "visit_date", label: ["Date of visit"], required: true },
      { type: "integer", name: "learners_present", label: ["Learners present"], required: true },
      { type: "select_one yn", name: "tablets_used", label: ["Tablets used?"] },
    ],
    choices: [{ list_name: "yn", name: "yes", label: ["Yes"] }, { list_name: "yn", name: "no", label: ["No"] }],
  },
};
const kRow = (id: number, over: Row = {}): Row => ({
  _id: id, _uuid: `u${id}`, "meta/instanceID": `uuid:${id}`, _xform_id_string: "aAbCdEfGh123",
  _submission_time: "2026-09-20T10:00:00", start: `2026-09-20T08:0${id % 10}:00.000+03:00`, end: "2026-09-20T09:00:00.000+03:00",
  officer_ref: "field_officer-id", school_code: "NRK-001", visit_date: "2026-09-20", learners_present: "30", tablets_used: "yes",
  ...over,
});
/** Plays KoboToolbox: the asset (questions) and its submissions. */
function stubKobo(rows: () => Row[], asset: Row = KOBO_ASSET) {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/data/")) return Promise.resolve(new Response(JSON.stringify({ count: rows().length, next: null, results: rows() })));
    if (url.includes("/api/v2/assets/")) return Promise.resolve(new Response(JSON.stringify(asset)));
    return real(input);
  }) as typeof fetch;
  return () => { globalThis.fetch = real; };
}
function connectKobo(db: Db, secret?: string) {
  db.kobo_config.push({
    id: 1, base_url: "https://kobo.test", api_token: "test-token", officer_field: "officer_ref",
    webhook_secret_hash: secret ? createHashForTest(secret) : null,
  });
}
// The API stores sha256(secret) hex.
import { createHash as createHashForTest0 } from "node:crypto";
const createHashForTest = (s: string) => createHashForTest0("sha256").update(s).digest("hex");
const recByKobo = (db: Db, id: number) => db.kobo_records.find((r) => r.kobo_id === id)!;

Deno.test("Kobo pipeline: sync stores raw, validates, normalizes; dashboards count only what passes", async () => {
  const db = freshWorld();
  connectKobo(db);
  let rows = [
    kRow(1),                                                    // valid
    kRow(2, { school_code: "Aitong Pri" }),                      // school not recognised
    { ...kRow(1), _id: 3, _uuid: "u3", "meta/instanceID": "uuid:3" }, // the same submission sent twice
    kRow(4, { _validation_status: { uid: "validation_status_not_approved" } }),
    kRow(5, { learners_present: "thirty" }),                     // not a number
  ];
  const restore = stubKobo(() => rows);
  try {
    const sync = await call("POST", "/kobo/sync", "tok_admin");
    assertEquals(sync.status, 200, JSON.stringify(sync.json));
    const st = sync.json.forms[0];
    assertEquals([st.received, st.valid, st.invalid, st.duplicate, st.rejected], [5, 1, 2, 1, 1]);
    assertEquals(db.kobo_raw_submissions.length, 5, "every submission is kept exactly as received");
    assertEquals(db.kobo_raw_submissions.find((r) => r.kobo_id === 5)!.payload.learners_present, "thirty");
    const r1 = recByKobo(db, 1);
    assertEquals([r1.status, r1.school_id, r1.county, r1.officer_id, r1.observed_on], ["valid", "sch_1", "Narok", "field_officer-id", "2026-09-20"]);
    assertEquals(r1.answers.learners_present, 30, "normalized to a number");
    assertEquals(recByKobo(db, 3).duplicate_of, r1.id);
    assert(db.kobo_forms[0].schema && db.kobo_forms[0].mapping.school === "school_code", "schema saved, mapping guessed");
    assertEquals(db.kobo_submissions.filter((s) => s.officer_id === "field_officer-id").length, 1, "the officer has done it — once");

    // The dashboards: only what passes.
    let res = await call("GET", "/kobo/forms/kb_1/results", "tok_me");
    assertEquals([res.json.submissionCount, res.json.received], [1, 5]);
    assertEquals(res.json.excluded, { invalid: 2, duplicate: 1, rejected: 1, byReview: 0 });
    assertEquals(res.json.questions.find((q: Row) => q.name === "tablets_used").data, [{ label: "Yes", value: 1 }, { label: "No", value: 0 }]);

    // What needs looking at, by rule; the school it couldn't place, with a suggestion.
    const pipe = await call("GET", "/kobo/forms/kb_1/pipeline", "tok_admin");
    assertEquals(pipe.json.stats.needsReview, 3);
    assertEquals(pipe.json.unknownSchools, [{ value: "Aitong Pri", count: 1, suggestion: { id: "sch_1", name: "Aitong Primary", code: "NRK-001" } }]);
    assertEquals((await call("GET", "/kobo/records?formId=kb_1&rule=type", "tok_me")).json.records.map((r: Row) => r.koboId), [5]);

    // Normalization: teach it the alias once; every survey is re-checked.
    assertEquals((await call("POST", "/kobo/school-aliases", "tok_me", { value: "Aitong Pri", schoolId: "sch_1" })).status, 200);
    assertEquals([recByKobo(db, 2).status, recByKobo(db, 2).school_id], ["valid", "sch_1"]);

    // A person's decision: accepted with a reason, and audited.
    const rec5 = recByKobo(db, 5);
    assertEquals((await call("POST", `/kobo/records/${rec5.id}/review`, "tok_me", { decision: "accepted" })).status, 400, "a reason is required");
    assertEquals((await call("POST", `/kobo/records/${rec5.id}/review`, "tok_me", { decision: "accepted", note: "Confirmed 30 with the head teacher" })).status, 200);
    assert(db.audit_log.some((a) => a.action === "kobo.record_accepted" && a.target_id === rec5.id));
    res = await call("GET", "/kobo/forms/kb_1/results", "tok_me");
    assertEquals(res.json.submissionCount, 3);
    assertEquals((await call("GET", "/intelligence", "tok_me")).json.dataCollection.kobo.counted, 3);
    // Re-syncing leaves the decision alone.
    await call("POST", "/kobo/sync", "tok_admin");
    assertEquals(recByKobo(db, 5).review, "accepted");

    // Deleted in Kobo → removed here too (kept, never counted).
    rows = rows.filter((r) => r._id !== 1);
    await call("POST", "/kobo/sync", "tok_admin");
    assertEquals(recByKobo(db, 1).status, "removed");
    assertEquals(db.kobo_raw_submissions.length, 5, "nothing is deleted");
    assertEquals(recByKobo(db, 3).status, "valid", "with the original gone, its copy is the one that counts");
    assertEquals((await call("GET", "/kobo/forms/kb_1/results", "tok_me")).json.submissionCount, 3);
  } finally {
    restore();
  }
});

/** A KoboToolbox REST Service call. */
async function hook(body: unknown, auth: string | null, raw?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth) headers.authorization = auth;
  const res = await app.request("/api/kobo/hook", { method: "POST", headers, body: raw ?? JSON.stringify(body) });
  let json: Row = {};
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}
const basic = (pw: string) => `Basic ${btoa(`hpf:${pw}`)}`;

Deno.test("Kobo push: only with the right secret; stored and validated; repeats are harmless", async () => {
  const db = freshWorld();
  connectKobo(db);
  const restore = stubKobo(() => []);
  try {
    assertEquals((await hook(kRow(1), basic("anything"))).status, 401, "no secret set yet");
    const made = await call("POST", "/kobo/webhook", "tok_super_admin");
    assertEquals(made.status, 200);
    assertEquals(made.json.username, "hpf");
    const pw = made.json.password as string;
    assert(db.kobo_config[0].webhook_secret_hash && db.kobo_config[0].webhook_secret_hash !== pw, "only the hash is stored");
    assert(!JSON.stringify((await call("GET", "/kobo/config", "tok_super_admin")).json).includes(pw), "never shown again");

    assertEquals((await hook(kRow(1), null)).status, 401);
    assertEquals((await hook(kRow(1), basic("wrong"))).status, 401);
    assertEquals((await hook(kRow(1), `Bearer ${pw}`)).status, 401, "a bearer token isn't the hook password");
    assertEquals((await hook(null, basic(pw), "not json")).status, 400);
    assertEquals((await hook({ hello: 1 }, basic(pw))).status, 400, "not a Kobo submission");
    assertEquals((await hook(null, basic(pw), JSON.stringify({ ...kRow(9), pad: "x".repeat(1_000_001) }))).status, 413);
    const other = await hook({ ...kRow(2), _xform_id_string: "someOtherSurvey" }, basic(pw));
    assertEquals([other.status, db.kobo_raw_submissions.length], [202, 0], "a survey that isn't attached is ignored");

    assertEquals((await hook(kRow(1), basic(pw))).status, 200);
    assertEquals((await hook(kRow(1), basic(pw))).status, 200, "Kobo retries are fine");
    assertEquals(db.kobo_raw_submissions.length, 1);
    assertEquals(db.kobo_raw_submissions[0].source, "webhook");
    assertEquals([db.kobo_records.length, db.kobo_records[0].status], [1, "valid"]);
    assertEquals((await hook(kRow(2, { visit_date: "2099-01-01" }), basic(pw))).status, 200);
    assert(db.kobo_record_issues.some((i) => i.rule === "date" && i.severity === "error"), "the push is validated like a sync");

    // Revoking the password stops the push.
    await call("DELETE", "/kobo/webhook", "tok_super_admin");
    assertEquals((await hook(kRow(3), basic(pw))).status, 401);
  } finally {
    restore();
  }
});

Deno.test("Kobo field mapping: only the survey's own questions; saving re-checks every submission", async () => {
  const db = freshWorld();
  connectKobo(db);
  const restore = stubKobo(() => [kRow(1, { school_code: "Nowhere Primary" })]);
  try {
    assertEquals((await call("PUT", "/kobo/forms/kb_1/mapping", "tok_admin", { school: "school_code" })).status, 409, "not synced yet");
    await call("POST", "/kobo/sync", "tok_admin");
    assertEquals(recByKobo(db, 1).status, "invalid");
    assertEquals((await call("PUT", "/kobo/forms/kb_1/mapping", "tok_admin", { school: "no_such_question" })).status, 400);
    assertEquals((await call("PUT", "/kobo/forms/kb_1/mapping", "tok_me", { school: null })).status, 403, "M&E can look, not change");
    const saved = await call("PUT", "/kobo/forms/kb_1/mapping", "tok_admin",
      { school: null, county: null, officer: "officer_ref", date: "visit_date" });
    assertEquals(saved.status, 200, JSON.stringify(saved.json));
    assertEquals([recByKobo(db, 1).status, recByKobo(db, 1).school_id], ["valid", null], "no school question, no school check");
    assert(db.audit_log.some((a) => a.action === "kobo.mapping_changed"));
    // Excluding a valid record takes it off the dashboards.
    await call("POST", `/kobo/records/${recByKobo(db, 1).id}/review`, "tok_me", { decision: "excluded", note: "Training entry" });
    assertEquals((await call("GET", "/kobo/forms/kb_1/results", "tok_me")).json.submissionCount, 0);
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------ 11. Data Quality Center */

/** A world with known problems: a duplicate learner, one with no class, one with a bad grade. */
function dqWorld() {
  const db = freshWorld();
  const base = db.learners[0];
  db.learners.push(
    { ...base, id: "dup-id", username: "kid.dup", user_code: "NRK-001-L0007", learner_code: "NRK-001-L0007", created_at: "2026-09-05T00:00:00Z" },
    { ...base, id: "noclass-id", username: "kid.nc", full_name: "Kid Noclass", class_id: null, user_code: "NRK-001-L0008", learner_code: "NRK-001-L0008" },
    { ...base, id: "badgrade-id", username: "kid.bg", full_name: "Kid Badgrade", grade: "Std 4", user_code: "NRK-001-L0009", learner_code: "NRK-001-L0009" },
  );
  for (const id of ["dup-id", "noclass-id", "badgrade-id"]) {
    db.learner_enrollments.push({ id: `enr-${id}`, learner_id: id, school_id: SCHOOL.id, class_id: "cls_1", status: "ACTIVE", enrollment_date: "2026-09-01" });
  }
  return db;
}
const dqByKey = (db: Db, key: string) => db.dq_issues.find((i) => i.issue_key === key)!;

Deno.test("data quality: scans open issues, keep first-detected dates, resolve what's fixed at the source, reopen what comes back", async () => {
  const db = dqWorld();
  const scan = await call("POST", "/data-quality/scan", "tok_me");
  assertEquals(scan.status, 200, JSON.stringify(scan.json));
  const nc = dqByKey(db, "learner_without_class:learner:noclass-id");
  const bg = dqByKey(db, "invalid_grade:learner:badgrade-id");
  assert(nc && bg && dqByKey(db, `duplicate_learner:${SCHOOL.id}|kid one`), "the three planted problems are found");
  assertEquals([nc.status, nc.severity, nc.school_id, nc.county], ["OPEN", "LOW", SCHOOL.id, "Narok"]);
  assert(db.dq_issue_events.some((e) => e.issue_id === nc.id && e.action === "detected"));
  const first = nc.first_detected_at;
  const sum = await call("GET", "/data-quality/summary", "tok_me");
  assert(sum.json.score.value < 100);
  assertEquals(sum.json.byType.find((t: Row) => t.type === "learner_without_class").OPEN, 1);
  // Fixed elsewhere (e.g. by the school head): the next scan resolves it — by the scan, not a person.
  db.learners.find((l) => l.id === "noclass-id")!.class_id = "cls_1";
  await call("POST", "/data-quality/scan", "tok_me");
  assertEquals([nc.status, nc.resolved_by, nc.resolution, nc.still_present], ["RESOLVED", null, "No longer found — fixed at the source", false]);
  assert(db.dq_issue_events.some((e) => e.issue_id === nc.id && e.action === "auto_resolved"));
  // It comes back: the same issue reopens, with its history and first-detected date.
  db.learners.find((l) => l.id === "noclass-id")!.class_id = null;
  await call("POST", "/data-quality/scan", "tok_me");
  assertEquals([nc.status, nc.reopened_count, nc.first_detected_at], ["OPEN", 1, first]);
  assertEquals(db.dq_issues.filter((i) => i.issue_key === nc.issue_key).length, 1);
  assertEquals(db.dq_scans.length, 3);
  assertEquals(db.learners.length, 5, "a scan never deletes or changes records");
});

Deno.test("data quality: status workflow with reasons, ignore sticks, filters by county/school/type/severity/status/date", async () => {
  const db = dqWorld();
  db.learners.push({ ...db.learners[1], id: "b-noclass", username: "kid.bnc", full_name: "Kid B Noclass", class_id: null, learner_code: "NRK-002-L0009" });
  db.learner_enrollments.push({ id: "enr-bnc", learner_id: "b-noclass", school_id: SCHOOL_B.id, class_id: null, status: "ACTIVE", enrollment_date: "2026-09-01" });
  await call("POST", "/data-quality/scan", "tok_me");
  const nc = dqByKey(db, "learner_without_class:learner:noclass-id");
  assertEquals((await call("PATCH", `/data-quality/issues/${nc.id}`, "tok_me", { status: "UNDER_REVIEW" })).status, 200);
  assertEquals((await call("PATCH", `/data-quality/issues/${nc.id}`, "tok_me", { status: "IGNORED" })).status, 400, "a reason is required");
  assertEquals((await call("PATCH", `/data-quality/issues/${nc.id}`, "tok_me", { status: "IGNORED", note: "Joins a class next term" })).status, 200);
  assertEquals((await call("PATCH", `/data-quality/issues/${nc.id}`, "tok_me", { status: "UNDER_REVIEW" })).status, 400, "reopen it first");
  assert(db.audit_log.some((a) => a.action === "dq.status_changed" && a.target_id === nc.id && a.details.to === "IGNORED"));
  await call("POST", "/data-quality/scan", "tok_me");
  assertEquals(nc.status, "IGNORED", "a scan never overrides a person's decision to ignore");
  // Resolving by hand while it's still there: the next scan reopens it.
  const bg = dqByKey(db, "invalid_grade:learner:badgrade-id");
  await call("PATCH", `/data-quality/issues/${bg.id}`, "tok_me", { status: "RESOLVED", note: "Told the school" });
  assertEquals([bg.status, bg.resolved_by], ["RESOLVED", "me-id"]);
  await call("POST", "/data-quality/scan", "tok_me");
  assertEquals(bg.status, "OPEN");
  // Filters.
  const list = async (qs: string) => (await call("GET", `/data-quality/issues?${qs}`, "tok_me")).json.issues.map((i: Row) => i.entity.id).sort();
  assertEquals(await list(`school=${encodeURIComponent(SCHOOL_B.name)}&type=learner_without_class`), ["b-noclass"]);
  assertEquals(await list(`county=Narok&type=learner_without_class&status=OPEN`), ["b-noclass"], "ignored ones drop out of OPEN");
  assertEquals(await list("type=invalid_grade&severity=MEDIUM"), ["badgrade-id"]);
  assertEquals(await list("status=IGNORED"), ["noclass-id"]);
  assertEquals(await list("from=2099-01-01"), [], "first detected in that range");
  const today = new Date().toISOString().slice(0, 10);
  assert((await list(`from=${today}&to=${today}`)).length >= 4);
  const ignoredSummary = (await call("GET", "/data-quality/summary?status=IGNORED", "tok_me")).json;
  assertEquals(ignoredSummary.totals.byStatus.IGNORED, 1);
  // Bulk: several at once, each audited.
  const ids = db.dq_issues.filter((i) => i.status === "OPEN").map((i) => i.id);
  const bulk = await call("POST", "/data-quality/issues/bulk", "tok_me", { ids, status: "UNDER_REVIEW" });
  assertEquals(bulk.json.changed, ids.length);
  assertEquals(db.dq_issue_events.filter((e) => e.action === "status_changed" && e.to_status === "UNDER_REVIEW").length, ids.length + 1);
});

Deno.test("data quality corrections: through the normal edit, audited before/after, never a deletion, permission-checked", async () => {
  const db = dqWorld();
  await call("POST", "/data-quality/scan", "tok_admin");
  const bg = dqByKey(db, "invalid_grade:learner:badgrade-id");
  // The fixes offered depend on who's asking.
  assertEquals((await call("GET", `/data-quality/issues/${bg.id}`, "tok_me")).json.fixes, [], "M&E can triage, not edit learners");
  assertEquals((await call("POST", `/data-quality/issues/${bg.id}/fix`, "tok_education_team", { action: "set_learner_grade", grade: "Grade 4" })).status, 403);
  const offered = (await call("GET", `/data-quality/issues/${bg.id}`, "tok_admin")).json.fixes.map((f: Row) => f.action);
  assertEquals(offered, ["set_learner_grade"]);
  assertEquals((await call("POST", `/data-quality/issues/${bg.id}/fix`, "tok_admin", { action: "set_learner_grade", grade: "Grade 99" })).status, 400);
  const fixed = await call("POST", `/data-quality/issues/${bg.id}/fix`, "tok_admin", { action: "set_learner_grade", grade: "Grade 4", note: "Checked the register" });
  assertEquals(fixed.status, 200, JSON.stringify(fixed.json));
  assertEquals(db.learners.find((l) => l.id === "badgrade-id")!.grade, "Grade 4");
  assertEquals([bg.status, bg.resolved_by], ["RESOLVED", "admin-id"]);
  assert(String(bg.resolution).startsWith("Corrected: Grade set to Grade 4"));
  const ev = db.dq_issue_events.find((e) => e.issue_id === bg.id && e.action === "corrected")!;
  assertEquals([ev.details.before, ev.details.after, ev.actor_id], [{ grade: "Std 4" }, { grade: "Grade 4" }, "admin-id"]);
  assert(db.audit_log.some((a) => a.action === "dq.corrected" && a.target_id === bg.id));
  assert(db.audit_log.some((a) => a.action === "learner.updated" && a.target_id === "badgrade-id" && a.details.via === "data_quality"));
  assertEquals(fixed.json.issue.status, "RESOLVED", "the re-scan agrees it's fixed");
  // Place the class-less learner; archive the duplicate (kept, reversible).
  const nc = dqByKey(db, "learner_without_class:learner:noclass-id");
  assertEquals((await call("POST", `/data-quality/issues/${nc.id}/fix`, "tok_admin", { action: "place_learner_in_class", classId: "cls_1" })).status, 200);
  assertEquals(db.learners.find((l) => l.id === "noclass-id")!.class_id, "cls_1");
  const dup = dqByKey(db, `duplicate_learner:${SCHOOL.id}|kid one`);
  assertEquals((await call("POST", `/data-quality/issues/${dup.id}/fix`, "tok_admin", { action: "archive_duplicate_learner", learnerId: "learner-b-id" })).status, 400, "only one of the duplicates");
  assertEquals((await call("POST", `/data-quality/issues/${dup.id}/fix`, "tok_admin", { action: "archive_duplicate_learner", learnerId: "dup-id" })).status, 200);
  const d = db.learners.find((l) => l.id === "dup-id")!;
  assertEquals([d.enrollment_status, db.learners.length], ["INACTIVE", 5], "archived, never deleted");
  assert(String(d.exit_reason).includes("Duplicate record of NRK-001-L0001"));
  assertEquals(dup.status, "RESOLVED");
  // A correction that isn't on offer for this issue is refused.
  assertEquals((await call("POST", `/data-quality/issues/${nc.id}/fix`, "tok_admin", { action: "set_learner_grade", grade: "Grade 4" })).status, 403);
  // The issue's own history reads in order.
  const hist = (await call("GET", `/data-quality/issues/${bg.id}`, "tok_me")).json.events.map((e: Row) => `${e.action}:${e.by}`);
  assertEquals(hist, ["detected:Scan", "corrected:admin person"]);
});

/* ------------------------------------------------------------ 12. M&E layer */

/** Validated classroom observations in Term 3: was ICT integrated? */
function melWorld() {
  const db = freshWorld();
  db.kobo_forms[0] = {
    ...db.kobo_forms[0], title: "Teacher observation form",
    schema: { version: "v1", meta: {}, choices: { yn: [{ name: "yes", label: "Yes" }, { name: "no", label: "No" }] },
      fields: [{ xpath: "ict_used", name: "ict_used", label: "ICT integrated in the lesson?", type: "select_one", listName: "yn", orOther: false, required: true, relevant: null, repeats: [] }] },
  };
  const rec = (id: string, ict: string, o: Row = {}) => ({
    id, kobo_form_id: "kb_1", kobo_id: Number(id.slice(1)), status: "valid", review: null, observed_on: "2026-09-15",
    county: "Narok", school_id: SCHOOL.id, answers: { ict_used: ict }, ...o,
  });
  db.kobo_records.push(
    rec("r1", "yes"), rec("r2", "yes"), rec("r3", "no"),
    rec("r4", "yes", { school_id: SCHOOL_B.id }),
    rec("r5", "no", { status: "invalid" }),                   // failed validation: not counted
    rec("r6", "yes", { observed_on: "2026-06-01" }),          // Term 2
  );
  return db;
}

Deno.test("M&E: framework, targets, live actuals from validated data, by county and school", async () => {
  const db = melWorld();
  assertEquals((await call("POST", "/mel/programmes", "tok_education_team", { name: "X" })).status, 403, "the framework is M&E's");
  const prog = (await call("POST", "/mel/programmes", "tok_me", { name: "Teach2030", code: "T2030" })).json.id;
  const out = (await call("POST", "/mel/outcomes", "tok_me", { programmeId: prog, code: "1", title: "Teachers use ICT in teaching" })).json.id;
  const bad = await call("POST", "/mel/indicators", "tok_me", { outcomeId: out, name: "x", source: "kobo", sourceConfig: { formId: "kb_1", measure: "percent_choice", question: "nope", choices: ["yes"] } });
  assertEquals(bad.status, 400, "the question must be in the survey");
  const ind = await call("POST", "/mel/indicators", "tok_me", {
    outcomeId: out, code: "1.1", name: "% of teachers integrating ICT", unit: "percent", evidenceHint: "Teacher observation form",
    source: "kobo", sourceConfig: { formId: "kb_1", measure: "percent_choice", question: "ict_used", choices: ["yes"] }, baselineValue: 40, baselinePeriod: "2026-T1",
  });
  assertEquals(ind.status, 200, JSON.stringify(ind.json));
  assertEquals((await call("PUT", "/mel/targets", "tok_me", { indicatorId: ind.json.id, period: "2026-T3", scopeType: "programme", value: 75 })).status, 200);
  assertEquals((await call("PUT", "/mel/targets", "tok_me", { indicatorId: ind.json.id, period: "2026-T3", scopeType: "school", scopeId: SCHOOL.id, value: 60 })).status, 200);
  assertEquals((await call("PUT", "/mel/targets", "tok_me", { indicatorId: ind.json.id, period: "2031-T9", scopeType: "programme", value: 1 })).status, 400);
  assert(db.audit_log.some((a) => a.action === "me.target_set" && a.details.to === 75));

  const row = async (qs: string) => (await call("GET", `/mel/programmes/${prog}/results?period=2026-T3${qs}`, "tok_me")).json.outcomes[0].indicators[0];
  const all = await row("");
  assertEquals([all.value, all.live.numerator, all.live.denominator, all.valueSource], [75, 3, 4, "live"], "r1, r2, r4 of r1–r4; r5 failed checks, r6 is Term 2");
  assertEquals([all.target.value, all.achievement.status], [75, "met"]);
  const aitong = await row(`&school=${encodeURIComponent(SCHOOL.name)}`);
  assertEquals([aitong.value, aitong.target, aitong.achievement.status], [66.7, { value: 60, from: "scope" }, "met"]);
  const narok = await row("&county=Narok");
  assertEquals([narok.value, narok.target.from], [75, "programme"], "no county target: the programme's applies");
  const t2 = (await call("GET", `/mel/programmes/${prog}/results?period=2026-T2`, "tok_me")).json.outcomes[0].indicators[0];
  assertEquals(t2.live.denominator, 1);
  const bd = (await call("GET", `/mel/indicators/${ind.json.id}/breakdown?period=2026-T3`, "tok_me")).json.rows;
  assertEquals(bd.find((r: Row) => r.scopeId === SCHOOL_B.id).value, 100);
  assertEquals(bd.find((r: Row) => r.scopeType === "county" && r.scopeId === "Narok").value, 75);
});

Deno.test("M&E: actuals are recorded as snapshots with evidence, verified by someone else, versions kept", async () => {
  const db = melWorld();
  const prog = (await call("POST", "/mel/programmes", "tok_me", { name: "Teach2030" })).json.id;
  const out = (await call("POST", "/mel/outcomes", "tok_me", { programmeId: prog, title: "ICT" })).json.id;
  const ind = (await call("POST", "/mel/indicators", "tok_me", { outcomeId: out, name: "% integrating ICT", source: "kobo", sourceConfig: { formId: "kb_1", measure: "percent_choice", question: "ict_used", choices: ["yes"] } })).json.id;
  const rec = await call("POST", "/mel/actuals", "tok_super_admin", { indicatorId: ind, period: "2026-T3", scopeType: "programme" });
  assertEquals([rec.status, rec.json.value], [200, 75]);
  const a = db.me_actuals.find((x) => x.id === rec.json.id)!;
  assertEquals([a.numerator, a.denominator, a.status, a.recorded_by], [3, 4, "recorded", "super_admin-id"]);
  const ev = db.me_evidence.find((e) => e.actual_id === a.id)!;
  assertEquals([ev.kind, ev.title, ev.record_count, ev.kobo_form_id], ["kobo_form", "Teacher observation form", 4, "kb_1"]);
  // The data changes later; the recorded value doesn't.
  db.kobo_records.find((r) => r.id === "r3")!.answers.ict_used = "yes";
  const res = (await call("GET", `/mel/programmes/${prog}/results?period=2026-T3`, "tok_me")).json.outcomes[0].indicators[0];
  assertEquals([res.value, res.valueSource, res.live.value], [75, "recorded", 100]);
  // Verification: not by the recorder; a rejection needs a reason.
  assertEquals((await call("POST", `/mel/actuals/${a.id}/verify`, "tok_education_team", { decision: "verified" })).status, 403, "the Education Team has no M&E rights");
  const own = await call("POST", "/mel/actuals", "tok_me", { indicatorId: ind, period: "2026-T3", scopeType: "school", scopeId: SCHOOL.id });
  assertEquals((await call("POST", `/mel/actuals/${own.json.id}/verify`, "tok_me", { decision: "verified" })).status, 403, "nobody verifies their own");
  assertEquals((await call("POST", `/mel/actuals/${a.id}/verify`, "tok_me", { decision: "rejected" })).status, 400);
  assertEquals((await call("POST", `/mel/actuals/${a.id}/verify`, "tok_me", { decision: "verified", note: "Checked 4 observation forms" })).status, 200);
  assertEquals([a.status, a.verified_by], ["verified", "me-id"]);
  assert(db.audit_log.some((x) => x.action === "me.actual_verified"));
  // Re-recording keeps the old version.
  const again = await call("POST", "/mel/actuals", "tok_super_admin", { indicatorId: ind, period: "2026-T3", scopeType: "programme" });
  assertEquals(again.json.value, 100);
  assertEquals([a.superseded_by, !!a.superseded_at], [again.json.id, true]);
  const versions = (await call("GET", `/mel/actuals/${again.json.id}`, "tok_me")).json.versions;
  assertEquals(versions.map((v: Row) => [v.value, v.status, v.current]), [[100, "recorded", true], [75, "verified", false]]);
  // Evidence a person adds.
  assertEquals((await call("POST", `/mel/actuals/${again.json.id}/evidence`, "tok_super_admin", { kind: "link", title: "Photos", url: "ftp://x" })).status, 400);
  assertEquals((await call("POST", `/mel/actuals/${again.json.id}/evidence`, "tok_super_admin", { kind: "link", title: "Observation photos", url: "https://drive.example/obs" })).status, 200);
  assertEquals((await call("POST", `/mel/actuals/${a.id}/evidence`, "tok_super_admin", { kind: "note", title: "x" })).status, 409, "only on the current version");
  // Portal and manual sources.
  const comp = (await call("POST", "/mel/indicators", "tok_me", { outcomeId: out, name: "Work handed in", source: "portal", sourceConfig: { metric: "completion_rate" } })).json.id;
  assertEquals(db.me_indicators.find((x) => x.id === comp)!.unit, "percent", "the unit comes from the measure");
  const man = (await call("POST", "/mel/indicators", "tok_me", { outcomeId: out, name: "Head teachers trained", unit: "count", source: "manual" })).json.id;
  assertEquals((await call("POST", "/mel/actuals", "tok_super_admin", { indicatorId: man, period: "2026-T3", scopeType: "programme" })).status, 400, "enter the value");
  assertEquals((await call("POST", "/mel/actuals", "tok_super_admin", { indicatorId: man, period: "2026-T3", scopeType: "programme", value: 12, note: "Training register" })).status, 200);
});

Deno.test("M&E reports: generated from the results, frozen once final", async () => {
  const db = melWorld();
  const prog = (await call("POST", "/mel/programmes", "tok_me", { name: "Teach2030" })).json.id;
  const out = (await call("POST", "/mel/outcomes", "tok_me", { programmeId: prog, title: "ICT" })).json.id;
  const ind = (await call("POST", "/mel/indicators", "tok_me", { outcomeId: out, name: "% integrating ICT", source: "kobo", sourceConfig: { formId: "kb_1", measure: "percent_choice", question: "ict_used", choices: ["yes"] } })).json.id;
  await call("PUT", "/mel/targets", "tok_me", { indicatorId: ind, period: "2026-T3", scopeType: "county", scopeId: "Narok", value: 80 });
  await call("POST", "/mel/actuals", "tok_super_admin", { indicatorId: ind, period: "2026-T3", scopeType: "county", scopeId: "Narok" });
  assertEquals((await call("POST", "/mel/reports", "tok_education_team", { programmeId: prog, period: "2026-T3", scopeType: "county", scopeId: "Narok" })).status, 403);
  const made = await call("POST", "/mel/reports", "tok_me", { programmeId: prog, period: "2026-T3", scopeType: "county", scopeId: "Narok" });
  assertEquals(made.status, 200, JSON.stringify(made.json));
  const r = (await call("GET", `/mel/reports/${made.json.id}`, "tok_super_admin")).json;
  assertEquals(r.report.title, "Teach2030 — 2026 Term 3 — Narok County");
  const i = r.content.outcomes[0].indicators[0];
  assertEquals([i.value, i.target.value, i.achievement.status, i.valueSource, i.recorded.evidence[0].kind], [75, 80, "close", "recorded", "kobo_form"]);
  assertEquals((await call("POST", `/mel/reports/${made.json.id}/finalize`, "tok_me", { note: "Submitted to the board" })).status, 200);
  assertEquals((await call("POST", `/mel/reports/${made.json.id}/refresh`, "tok_me")).status, 409, "a final report never changes");
  assertEquals((await call("POST", `/mel/reports/${made.json.id}/finalize`, "tok_me")).status, 409);
  assert(db.audit_log.some((x) => x.action === "me.report_finalized"));
  assertEquals((await call("GET", `/mel/reports?programmeId=${prog}`, "tok_super_admin")).json.reports.map((x: Row) => x.status), ["final"]);
});

/* ------------------------------------------------------------ impact dashboards */

Deno.test("impact dashboards: analysts only, the six areas, gender kept optional and hidden when small", async () => {
  const db = freshWorld();
  for (const tok of ["tok_teacher", "tok_school_leader", "tok_field_officer", "hpl_learnertoken"]) {
    assertEquals((await call("GET", "/impact", tok)).status, 403, tok);
  }
  const r = await call("GET", "/impact", "tok_me");
  assertEquals(r.status, 200, JSON.stringify(r.json));
  for (const k of ["executive", "reach", "learning", "teachers", "fieldOps", "resources"]) assert(k in r.json, k);
  // The Education Team gets the learning side only — never reach or field operations.
  const learning = (await call("GET", "/impact", "tok_education_team")).json;
  assertEquals(Object.keys(learning).filter((k) => ["executive", "reach", "learning", "teachers", "fieldOps", "resources"].includes(k)).sort(),
    ["executive", "learning", "resources", "teachers"]);
  assertEquals((await call("GET", "/impact", "tok_admin")).status, 403, "administration isn't programme analysis");
  assertEquals([r.json.executive.schools, r.json.executive.learners], [2, 2]);
  // Gender: optional, checked, and never shown for fewer than 5 people.
  assertEquals((await call("POST", "/learners", "tok_teacher", { fullName: "Kid Two", username: "kid.two", pin: "1234", classId: "cls_1", gender: "boy" })).status, 400);
  const made = await call("POST", "/learners", "tok_teacher", { fullName: "Kid Two", username: "kid.two", pin: "1234", classId: "cls_1", gender: "female" });
  assertEquals([made.status, made.json.learner.gender], [200, "female"]);
  assertEquals((await call("PATCH", "/learners/learner-id", "tok_teacher", { gender: "prefer not to say" })).json.learner.gender, "prefer_not_to_say");
  assertEquals((await call("PATCH", "/learners/learner-id", "tok_teacher", { gender: "" })).json.learner.gender, null, "it can be cleared");
  assert(db.audit_log.some((x) => x.action === "learner.updated" && x.details?.fields?.includes("gender")));
  assertEquals((await call("PATCH", "/users/teacher2-id", "tok_admin", { gender: "male" })).json.user.gender, "male");
  const g = (await call("GET", "/impact", "tok_me")).json.reach.gender.learners;
  assertEquals([g.total, g.recorded], [3, 1]);
  assertEquals(g.overall.find((x: Row) => x.key === "female").value, null, "one girl is shown as fewer than 5");
  // Filters narrow it.
  const b = (await call("GET", `/impact?school=${encodeURIComponent(SCHOOL_B.name)}`, "tok_me")).json;
  assertEquals([b.executive.schools, b.executive.learners], [1, 1]);
});

Deno.test("training register: sessions and attendance, never deleted, every change audited, counted on Teacher development", async () => {
  const db = freshWorld();
  assertEquals((await call("POST", "/trainings", "tok_education_team", { title: "", heldOn: "2026-09-10" })).status, 400);
  assertEquals((await call("POST", "/trainings", "tok_education_team", { title: "ICT workshop", heldOn: "2026-09-10", endsOn: "2026-09-01" })).status, 400);
  assertEquals((await call("POST", "/trainings", "tok_education_team", { title: "ICT workshop", heldOn: "2026-09-10", teacherIds: ["school_leader-id"] })).status, 400,
    "only teachers on the list");
  const made = await call("POST", "/trainings", "tok_education_team", {
    title: "ICT workshop", kind: "workshop", heldOn: "2026-09-10", county: "Narok", teacherIds: ["teacher-id", "teacher-b-id"],
  });
  assertEquals(made.status, 200, JSON.stringify(made.json));
  const id = made.json.training.id;
  assertEquals(made.json.training.attendance.length, 2);
  const picker = (await call("GET", "/trainings/teachers", "tok_education_team")).json.teachers.map((t: Row) => t.id);
  assert(picker.includes("teacher-id") && !picker.includes("pending-id"), "active teachers only");
  let t = (await call("GET", "/impact", "tok_me")).json.teachers.training;
  assertEquals([t.sessions, t.teachersTrained], [1, 2]);
  // Taking a teacher off the list keeps the row.
  const off = await call("PATCH", `/trainings/${id}`, "tok_education_team", { attendance: [{ teacherId: "teacher-b-id", attended: false }, { teacherId: "teacher2-id" }] });
  assertEquals(off.status, 200, JSON.stringify(off.json));
  assertEquals(db.training_attendance.length, 3);
  assertEquals(db.training_attendance.find((a) => a.teacher_id === "teacher-b-id")!.attended, false);
  assert(db.audit_log.some((x) => x.action === "training.attendance_changed" && x.details.removed.includes("teacher-b-id") && x.details.added.includes("teacher2-id")));
  t = (await call("GET", `/impact?school=${encodeURIComponent(SCHOOL.name)}`, "tok_me")).json.teachers.training;
  assertEquals([t.sessions, t.teachersTrained], [1, 2], "a county workshop shows for the school its teachers went from");
  // Archived, not deleted.
  assertEquals((await call("PATCH", `/trainings/${id}`, "tok_education_team", { archived: true })).status, 200);
  assertEquals(db.trainings.length, 1);
  assertEquals((await call("GET", "/trainings", "tok_me")).json.trainings.length, 0);
  assertEquals((await call("GET", "/trainings?archived=1", "tok_me")).json.trainings.length, 1);
  assertEquals((await call("GET", "/impact", "tok_me")).json.teachers.training.sessions, 0);
  assert(db.audit_log.some((x) => x.action === "training.archived"));
});

Deno.test("M&E dashboard: indicators tagged for a dashboard, target vs actual, trend over terms", async () => {
  melWorld();
  const prog = (await call("POST", "/mel/programmes", "tok_me", { name: "Teach2030" })).json.id;
  const out = (await call("POST", "/mel/outcomes", "tok_me", { programmeId: prog, title: "ICT" })).json.id;
  assertEquals((await call("POST", "/mel/indicators", "tok_me", { outcomeId: out, name: "x", source: "manual", dashboardTheme: "nowhere" })).status, 400);
  const ind = (await call("POST", "/mel/indicators", "tok_me", {
    outcomeId: out, name: "% of teachers integrating ICT", dashboardTheme: "teacher_development",
    source: "kobo", sourceConfig: { formId: "kb_1", measure: "percent_choice", question: "ict_used", choices: ["yes"] },
  })).json.id;
  await call("POST", "/mel/indicators", "tok_me", { outcomeId: out, name: "Untagged", unit: "count", source: "manual" });
  await call("PUT", "/mel/targets", "tok_me", { indicatorId: ind, period: "2026-T3", scopeType: "programme", value: 75 });
  await call("PUT", "/mel/targets", "tok_me", { indicatorId: ind, period: "2026-T2", scopeType: "programme", value: 60 });
  const all = (await call("GET", "/mel/dashboard?period=2026-T3", "tok_me")).json;
  assertEquals(all.indicators.length, 2);
  const tagged = (await call("GET", "/mel/dashboard?period=2026-T3&theme=teacher_development", "tok_me")).json;
  assertEquals(tagged.indicators.map((i: Row) => [i.name, i.dashboardTheme, i.target.value, i.value, i.achievement.status]),
    [["% of teachers integrating ICT", "teacher_development", 75, 75, "met"]]);
  assertEquals((await call("GET", "/mel/dashboard?theme=reach", "tok_me")).json.indicators.length, 0);
  assertEquals((await call("GET", "/mel/dashboard?theme=bogus", "tok_me")).status, 400);
  const school = (await call("GET", `/mel/dashboard?period=2026-T3&school=${encodeURIComponent(SCHOOL_B.name)}&theme=teacher_development`, "tok_me")).json;
  assertEquals([school.scope.type, school.indicators[0].value], ["school", 100]);
  const trend = (await call("GET", `/mel/indicators/${ind}/trend`, "tok_me")).json;
  assertEquals(trend.points.map((p: Row) => [p.period, p.target, p.value]), [["2026-T1", null, null], ["2026-T2", 60, 100], ["2026-T3", 75, 75]]);
  const narok = (await call("GET", `/mel/indicators/${ind}/trend?school=${encodeURIComponent(SCHOOL.name)}`, "tok_me")).json;
  assertEquals(narok.points.map((p: Row) => p.value), [null, 100, 66.7]);
});

/* ------------------------------------------------------------ offline sync */

const key = (k: string) => ({ "Idempotency-Key": k });

Deno.test("offline queue: a retried write happens once, and a key belongs to whoever first used it", async () => {
  const db = freshWorld();
  const first = await call("POST", "/learner/assignments/asg_1/start", LEARNER, {}, key("start-asg1-0001"));
  const again = await call("POST", "/learner/assignments/asg_1/start", LEARNER, {}, key("start-asg1-0001"));
  assertEquals([first.status, again.status, first.replay, again.replay], [200, 200, false, true], "the second gets the first reply back");
  assertEquals(again.json, first.json);
  assertEquals(db.assignment_submissions.filter((s) => s.learner_id === "learner-id").length, 1);
  // A visit sent twice — once on a bad connection, then again from the queue — is filed once.
  const visit = { schoolId: "sch_1", visitType: "Learning", responses: [] };
  const v1 = await call("POST", "/field-reports", "tok_field_officer", visit, key("visit-0000-0001"));
  const v2 = await call("POST", "/field-reports", "tok_field_officer", visit, key("visit-0000-0001"));
  assertEquals([v1.status, v2.status, v2.replay], [200, 200, true]);
  assertEquals(db.field_reports.length, 1);
  assertEquals((await call("POST", "/field-reports", "tok_teacher", visit, key("visit-0000-0001"))).status, 422, "someone else's key");
  assertEquals((await call("POST", "/field-reports", "tok_field_officer", visit, key("bad key!"))).status, 400);
  // A refusal is kept too: retrying the same key gives the same answer, not a second try.
  const no1 = await call("PUT", "/learner/assignments/asg_b/answers", LEARNER, { answers: [] }, key("answers-asgb-01"));
  const no2 = await call("PUT", "/learner/assignments/asg_b/answers", LEARNER, { answers: [] }, key("answers-asgb-01"));
  assertEquals([no1.status, no2.status, no2.replay], [404, 404, true]);
  // Without a key nothing changes: the online path is untouched.
  assertEquals((await call("POST", "/learner/assignments/asg_1/start", LEARNER, {})).status, 200);
});

Deno.test("offline answers: changes made elsewhere since the device saw them are a conflict, unless the learner keeps theirs", async () => {
  const db = freshWorld();
  const started = await call("POST", "/learner/assignments/asg_1/start", LEARNER, {});
  const seen = started.json.submission.lastSavedAt;
  const ok = await call("PUT", "/learner/assignments/asg_1/answers", LEARNER, { answers: [{ questionId: "q_tm", response: "From the tablet" }], baseSavedAt: seen });
  assertEquals(ok.status, 200, "nothing changed since: saved");
  // Another device saves later…
  const sub = db.assignment_submissions.find((s) => s.learner_id === "learner-id")!;
  sub.last_saved_at = new Date(Date.now() + 60_000).toISOString();
  const stale = await call("PUT", "/learner/assignments/asg_1/answers", LEARNER, { answers: [{ questionId: "q_tm", response: "From the phone" }], baseSavedAt: ok.json.submission.lastSavedAt });
  assertEquals([stale.status, stale.json.conflict?.kind], [409, "changed_elsewhere"]);
  assertEquals(stale.json.conflict.server.answers.find((x: Row) => x.questionId === "q_tm").response, "From the tablet", "the server's copy comes back");
  assertEquals(db.submission_answers.find((x) => x.question_id === "q_tm")!.response, "From the tablet", "nothing overwritten");
  // A device that never saw saved answers conflicts only if some exist.
  assertEquals((await call("PUT", "/learner/assignments/asg_1/answers", LEARNER, { answers: [], baseSavedAt: null })).json.conflict?.kind, "changed_elsewhere");
  // Keep mine.
  const forced = await call("PUT", "/learner/assignments/asg_1/answers", LEARNER, { answers: [{ questionId: "q_tm", response: "From the phone" }], baseSavedAt: seen, force: true });
  assertEquals(forced.status, 200);
  assertEquals(db.submission_answers.find((x) => x.question_id === "q_tm")!.response, "From the phone");
});

Deno.test("offline hand-in: lateness goes by when it was handed in on the device, if plausible; already handed in is a conflict", async () => {
  const db = freshWorld();
  const asg = db.assignments.find((a) => a.id === "asg_1")!;
  asg.due_at = new Date(Date.now() - 2 * 864e5).toISOString(); // due two days ago
  await call("POST", "/learner/assignments/asg_1/start", LEARNER, {});
  const handedIn = new Date(Date.now() - 3 * 864e5).toISOString(); // on the device, before it was due
  const res = await call("POST", "/learner/assignments/asg_1/submit", LEARNER, { answers: [{ questionId: "q_mc", response: 0 }], clientSubmittedAt: handedIn, baseSavedAt: null });
  assertEquals(res.status, 200, JSON.stringify(res.json));
  const sub = db.assignment_submissions.find((s) => s.learner_id === "learner-id")!;
  assertEquals([sub.is_late, sub.offline_submitted_at], [false, handedIn]);
  assertEquals(res.json.submission.offlineSubmittedAt, handedIn);
  assert(db.audit_log.some((x) => x.action === "submission.submitted" && x.details?.handedInOffline === handedIn));
  // Sent again from another device that still had it open: the server's copy comes back.
  const late = await call("PUT", "/learner/assignments/asg_1/answers", LEARNER, { answers: [], baseSavedAt: null });
  assertEquals([late.status, late.json.conflict?.kind, late.json.conflict?.server?.completion], [409, "already_handed_in", "submitted"]);
  // A time in the future (a wrong clock) isn't believed.
  const w2 = freshWorld();
  w2.assignments.find((a) => a.id === "asg_1")!.due_at = new Date(Date.now() - 864e5).toISOString();
  await call("POST", "/learner/assignments/asg_1/start", LEARNER, {});
  await call("POST", "/learner/assignments/asg_1/submit", LEARNER, { answers: [], clientSubmittedAt: new Date(Date.now() + 864e5).toISOString() });
  const s2 = w2.assignment_submissions.find((s) => s.learner_id === "learner-id")!;
  assertEquals([s2.is_late, s2.offline_submitted_at], [true, null]);
});

Deno.test("offline marking: marks given while someone else marked it are a conflict; keep mine overrides", async () => {
  const db = freshWorld();
  await call("POST", "/learner/assignments/asg_1/start", LEARNER, {});
  await call("POST", "/learner/assignments/asg_1/submit", LEARNER, { answers: [{ questionId: "q_mc", response: 0 }, { questionId: "q_tm", response: "Because" }] });
  const sub = db.assignment_submissions.find((s) => s.learner_id === "learner-id")!;
  const marks = (m: number) => ({ answers: [{ questionId: "q_tm", marks: m }] });
  // Downloaded unmarked (baseMarkedAt null); marked online meanwhile.
  const online = await call("POST", `/submissions/${sub.id}/mark`, "tok_teacher", marks(1));
  assertEquals(online.status, 200);
  const offline = await call("POST", `/submissions/${sub.id}/mark`, "tok_teacher", { ...marks(2), baseMarkedAt: null });
  assertEquals([offline.status, offline.json.conflict?.kind, offline.json.conflict?.server?.submission?.marks], [409, "marked_elsewhere", 3]);
  assertEquals(sub.marks, 3, "unchanged");
  // Saw the latest marks: no conflict.
  assertEquals((await call("POST", `/submissions/${sub.id}/mark`, "tok_teacher", { ...marks(2), baseMarkedAt: online.json.submission.markedAt })).status, 200);
  assertEquals(sub.marks, 4);
  // Keep mine.
  assertEquals((await call("POST", `/submissions/${sub.id}/mark`, "tok_teacher", { ...marks(0), baseMarkedAt: null, force: true })).status, 200);
  assertEquals(sub.marks, 2);
});

Deno.test("offline reading: a session read without a connection arrives later with its own times, if plausible", async () => {
  const db = freshWorld();
  const start = new Date(Date.now() - 3 * 3600e3), end = new Date(Date.now() - 3 * 3600e3 + 20 * 60e3);
  const r = await call("POST", "/library/lib_1/interactions", LEARNER, { startedAt: start.toISOString(), completedAt: end.toISOString() });
  assertEquals(r.status, 200);
  const row = db.library_interactions.find((x) => x.id === r.json.interaction.id)!;
  assertEquals([row.started_at, row.duration_seconds], [start.toISOString(), 1200]);
  // A clock in the future isn't believed: it's recorded as starting now, like an online open.
  const bad = await call("POST", "/library/lib_1/interactions", LEARNER, { startedAt: new Date(Date.now() + 864e5).toISOString(), completedAt: new Date(Date.now() + 2 * 864e5).toISOString() });
  assertEquals(db.library_interactions.find((x) => x.id === bad.json.interaction.id)!.duration_seconds, undefined);
});

/* ------------------------------------------------------------ sync center */

Deno.test("sync center: Kobo connection, last sync and each survey's error; what Kobo has from an officer and why some needs review", async () => {
  const db = freshWorld();
  let status = (await call("GET", "/sync/status", "tok_field_officer")).json;
  assertEquals([status.kobo.connected, status.kobo.lastSyncedAt], [false, null], "not connected yet");
  connectKobo(db);
  const restore = stubKobo(() => [kRow(1), kRow(2, { school_code: "Aitong Pri" })]);
  try {
    assertEquals((await call("POST", "/kobo/sync", "tok_admin")).status, 200);
  } finally { restore(); }
  status = (await call("GET", "/sync/status", "tok_field_officer")).json;
  assert(status.kobo.connected && status.kobo.lastSyncedAt);
  assertEquals([status.kobo.mine.received, status.kobo.mine.counted, status.kobo.mine.needsReview], [2, 1, 1]);
  assert(status.kobo.mine.issues.length && /school/i.test(status.kobo.mine.issues[0].message), JSON.stringify(status.kobo.mine.issues));
  assertEquals(status.kobo.surveys, undefined, "an officer doesn't get the survey-by-survey admin view");
  assertEquals(status.school.visits, 0);
  await call("POST", "/field-reports", "tok_field_officer", { schoolId: "sch_1", visitType: "Learning", responses: [] });
  assertEquals((await call("GET", "/sync/status", "tok_field_officer")).json.school.visits, 1);

  // A failed sync is kept per survey, in words — never the token.
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("kobo.test")) return Promise.resolve(new Response("{}", { status: 401 }));
    return real(input);
  }) as typeof fetch;
  try { await call("POST", "/kobo/sync", "tok_admin"); } finally { globalThis.fetch = real; }
  assertEquals(db.kobo_forms[0].last_sync_error, "KoboToolbox rejected the API token");
  const admin = (await call("GET", "/sync/status", "tok_admin")).json.kobo;
  assertEquals([admin.failing, admin.surveys[0].error, admin.surveys[0].received], [1, "KoboToolbox rejected the API token", 2]);
  assert(!JSON.stringify(admin).includes("test-token"));
});

Deno.test("sync center: learners and teachers see their own work as the server has it, and the content they can open", async () => {
  freshWorld();
  await call("POST", "/learner/assignments/asg_1/start", LEARNER, {});
  await call("POST", "/learner/assignments/asg_1/submit", LEARNER, { answers: [{ questionId: "q_mc", response: 0 }] });
  const learner = (await call("GET", "/sync/status", LEARNER)).json;
  assertEquals([learner.kobo, learner.learning.handedIn, learner.content.items], [undefined, 1, 1]);
  assert(learner.learning.lastHandedInAt);
  const teacher = (await call("GET", "/sync/status", "tok_teacher")).json;
  assertEquals([teacher.kobo, teacher.learning.marked], [undefined, 0]);
});

Deno.test("sync center: staff devices report their sync state; administrators see who needs a look", async () => {
  const db = freshWorld();
  const old = new Date(Date.now() - 3 * 864e5).toISOString();
  const report = { deviceId: "phone-0001", deviceLabel: "Android · Chrome", pending: 2, oldestPendingAt: old, lastSyncAt: old };
  assertEquals((await call("POST", "/sync/report", "tok_field_officer", report)).status, 200);
  assertEquals((await call("POST", "/sync/report", "tok_field_officer", { ...report, pending: 3 })).status, 200);
  assertEquals(db.device_sync_status.length, 1, "one row per device");
  assertEquals(db.device_sync_status[0].pending, 3);
  assertEquals((await call("POST", "/sync/report", "tok_field_officer", { deviceId: "x" })).status, 400);
  assertEquals((await call("POST", "/sync/report", LEARNER, report)).status, 403, "learners' shared tablets don't report");
  await call("POST", "/sync/report", "tok_teacher", { deviceId: "laptop-0001", lastSyncAt: new Date().toISOString(), lastSyncAtFuture: true });
  const res = await call("GET", "/sync/devices", "tok_admin");
  assertEquals(res.status, 200);
  const fo = res.json.people.find((p: Row) => p.id === "field_officer-id");
  assertEquals([fo.pending, fo.devices[0].deviceLabel], [3, "Android · Chrome"]);
  assertEquals(fo.attention, "3 waiting on the device for 3+ day(s)");
  assertEquals(res.json.people[0].id, "field_officer-id", "the ones needing a look come first");
  assertEquals(res.json.people.find((p: Row) => p.id === "teacher-id").attention, null, "synced just now");
  assertEquals(res.json.people.find((p: Row) => p.id === "teacher2-id").attention, "No device has reported yet");
  assertEquals((await call("GET", "/sync/devices?role=field_officer", "tok_admin")).json.people.length, 1);
});

/* ------------------------------------------------------------ notifications */

const tomorrowAt = (hhmmUtc = "09:00") => {
  const d = new Date(Date.parse(`${localDay(new Date())}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
  return `${d}T${hhmmUtc}:00.000Z`;
};

Deno.test("notifications: stored per person, never twice, read with a record of when", async () => {
  const db = freshWorld();
  db.assignments.find((a) => a.id === "asg_1")!.due_at = tomorrowAt();
  const teacher = await call("GET", "/notifications", "tok_teacher");
  assertEquals(teacher.status, 200);
  const due = teacher.json.notifications.find((n: Row) => n.kind === "assignments_due");
  assertEquals([due.title, due.link, teacher.json.unread], ["1 assignment is due tomorrow.", "teacher.html#assignments", 1]);
  const learner = (await call("GET", "/notifications", LEARNER)).json;
  assertEquals(learner.notifications.map((n: Row) => n.title), ["1 assignment is due tomorrow."]);
  // Again (and a manual run): nothing new.
  assertEquals((await call("POST", "/notifications/run-now", "tok_admin", {})).json.created >= 0, true);
  const before = db.notifications.length;
  await call("POST", "/notifications/run-now", "tok_admin", {});
  assertEquals(db.notifications.length, before, "the same thing is never said twice");
  assertEquals(db.notification_events.filter((e) => e.notification_id === due.id).map((e) => e.action), ["created"]);
  // Reading: only your own; recorded once.
  assertEquals((await call("POST", `/notifications/${due.id}/read`, LEARNER, {})).status, 404);
  const r = await call("POST", `/notifications/${due.id}/read`, "tok_teacher", {});
  assertEquals([r.status, r.json.unread], [200, 0]);
  await call("POST", `/notifications/${due.id}/read`, "tok_teacher", {});
  assertEquals(db.notification_events.filter((e) => e.notification_id === due.id).map((e) => [e.action, e.actor_id]), [["created", null], ["read", "teacher-id"]]);
  assert(db.notifications.find((n) => n.id === due.id)!.read_at);
  // Approvers: pending accounts. The Education Team can't approve, so isn't told.
  assertEquals((await call("GET", "/notifications", "tok_admin")).json.notifications.find((n: Row) => n.kind === "accounts_pending")?.title, "1 staff account awaiting approval.");
  assertEquals((await call("GET", "/notifications", "tok_education_team")).json.notifications.some((n: Row) => n.kind === "accounts_pending"), false);
  // Mark all read.
  await call("POST", "/notifications/read-all", "tok_admin", {});
  assertEquals((await call("GET", "/notifications", "tok_admin")).json.unread, 0);
});

Deno.test("notifications: 'Term return is due.' from a form's due date; dates checked", async () => {
  const db = freshWorld();
  const tomorrow = tomorrowAt().slice(0, 10);
  const made = await call("POST", "/forms", "tok_education_team", { title: "Term return", audience: "school_leader", kind: "questions", questions: [{ prompt: "Enrolment?" }], dueOn: tomorrow });
  assertEquals(made.json.form.dueOn, tomorrow);
  const head = (await call("GET", "/notifications", "tok_school_leader")).json.notifications;
  assertEquals(head.map((n: Row) => n.title), ["Term return is due."]);
  assertEquals(head[0].link, "leader.html#overview");
  assertEquals((await call("PATCH", `/forms/${made.json.form.id}`, "tok_education_team", { dueOn: "next week" })).status, 400);
  assertEquals((await call("PATCH", `/forms/${made.json.form.id}`, "tok_education_team", { dueOn: null })).status, 200);
  assertEquals(db.forms.find((f) => f.id === made.json.form.id)!.due_on, null);
  assert(db.audit_log.some((x) => x.action === "form.due_date_set"));
  assertEquals((await call("POST", "/forms", "tok_education_team", { title: "V", audience: "field_officer", visitType: "ICT", kind: "questions", questions: [{ prompt: "x" }], dueOn: tomorrow })).status, 400);
});

Deno.test("notifications: 'Your ICT visit form is incomplete.' — and the officer can finish it afterwards", async () => {
  const db = freshWorld();
  const form = (await call("POST", "/forms", "tok_education_team", { title: "ICT checklist", audience: "field_officer", visitType: "ICT", kind: "questions", questions: [{ id: "q1", prompt: "Tablets working?" }] })).json.form;
  db.forms.find((f) => f.id === form.id)!.created_at = new Date(Date.now() - 864e5).toISOString();
  const visit = (await call("POST", "/field-reports", "tok_field_officer", { schoolId: "sch_1", visitType: "ICT", responses: [] })).json.report;
  const mine = (await call("GET", "/notifications", "tok_field_officer")).json.notifications;
  assertEquals(mine.find((n: Row) => n.kind === "visit_incomplete")?.title, "Your ICT visit form is incomplete.");
  const reports = (await call("GET", "/field-reports", "tok_field_officer")).json.reports;
  assertEquals(reports[0].missingForms, [{ id: form.id, title: "ICT checklist" }]);
  // Finish it: only for your own visit, and only that visit type's forms.
  const body = { formId: form.id, visitId: reports[0].id, answers: [{ questionId: "q1", value: "Yes" }] };
  assertEquals((await call("POST", "/responses", "tok_field_officer", { ...body, visitId: undefined })).status, 400, "a visit form needs its visit");
  assertEquals((await call("POST", "/responses", "tok_field_officer", body)).status, 200);
  assertEquals((await call("GET", "/field-reports", "tok_field_officer")).json.reports[0].missingForms, []);
  assertEquals(db.responses.filter((r) => r.visit_id === reports[0].id).length, 1);
  assert(db.audit_log.some((x) => x.action === "visit.form_completed"));
  void visit;
});

Deno.test("notifications: the hourly run needs the database's secret; Kobo receipts are told once", async () => {
  const db = freshWorld();
  assertEquals((await app.request("/api/notifications/run", { method: "POST" })).status, 401);
  assertEquals((await app.request("/api/notifications/run", { method: "POST", headers: { "X-Cron-Secret": "d".repeat(64) } })).status, 401);
  const now = new Date().toISOString();
  for (let i = 0; i < 12; i++) db.kobo_raw_submissions.push({ id: `kraw${i}`, kobo_form_id: "kb_1", kobo_id: i, source: "sync", received_at: now, payload: {} });
  const ok = await app.request("/api/notifications/run", { method: "POST", headers: { "X-Cron-Secret": CRON_SECRET } });
  assertEquals(ok.status, 200);
  assert((await ok.json()).created > 0);
  assertEquals(db.notification_runs.at(-1)!.trigger, "schedule");
  const me = db.notifications.filter((n) => n.recipient_id === "me-id" && n.kind === "kobo_received");
  assertEquals(me.map((n) => [n.title, n.link]), [["12 Kobo submissions received.", "me.html#kobo"]]);
  assertEquals(db.notifications.filter((n) => n.recipient_id === "education_team-id" && n.kind === "kobo_received").length, 0, "not the Education Team's work any more");
  await app.request("/api/notifications/run", { method: "POST", headers: { "X-Cron-Secret": CRON_SECRET } });
  assertEquals(db.notifications.filter((n) => n.recipient_id === "me-id" && n.kind === "kobo_received").length, 1, "told once");
  // The log: who was told what, and whether they've read it.
  const log = (await call("GET", "/notifications/log?kind=kobo_received&status=unread", "tok_admin")).json;
  assert(log.notifications.some((n: Row) => n.recipient.name === "me person" && !n.readAt));
  assertEquals(log.runs[0].trigger, "schedule");
});

/* ------------------------------------------------------------ reports export */

/** A world with something in every report: marked work, visits, Kobo, reading, an indicator. */
function reportWorld() {
  const db = freshWorld();
  const now = new Date().toISOString();
  db.assignment_submissions.push(
    { id: "sub_1", assignment_id: "asg_1", learner_id: "learner-id", school_id: SCHOOL.id, class_id: "cls_1", status: "marked", started_at: now, last_saved_at: now,
      submitted_at: now, is_late: false, marks: 3, max_marks: 4, percentage: 75, band: "ME", marked_at: now, marked_by: "teacher-id", auto_marked: false },
    { id: "sub_b", assignment_id: "asg_b", learner_id: "learner-b-id", school_id: SCHOOL_B.id, class_id: "cls_2", status: "marked", started_at: now, last_saved_at: now,
      submitted_at: now, is_late: true, marks: 1, max_marks: 1, percentage: 100, band: "EE", marked_at: now, marked_by: "teacher-b-id", auto_marked: true },
  );
  db.field_reports.push(
    { id: "fr_1", officer_id: "field_officer-id", school: SCHOOL.name, county: "Narok", visit_type: "ICT", school_id: SCHOOL.id, created_at: now },
    { id: "fr_2", officer_id: "other-officer-id", school: SCHOOL_B.name, county: "Narok", visit_type: "ICT", school_id: SCHOOL_B.id, created_at: now },
  );
  db.profiles.push({ id: "other-officer-id", role: "field_officer", status: "active", full_name: "Other Officer", email: "other@test.org", school: "", school_id: null, county: "Narok" });
  db.kobo_records.push({ id: "kr_1", raw_id: "kraw_1", kobo_form_id: "kb_1", kobo_id: 101, submitted_at: now, observed_on: now.slice(0, 10), school_id: SCHOOL.id,
    school_value: SCHOOL.name, county: "Narok", officer_id: "field_officer-id", status: "invalid", review: null, answers: {}, record_hash: "h" });
  db.kobo_record_issues.push({ id: 1, record_id: "kr_1", kobo_form_id: "kb_1", rule: "required", severity: "error", field: "q1", message: "q1 is required", value: null });
  db.library_interactions[0] = { ...db.library_interactions[0], actor_kind: "learner", school: SCHOOL.name, duration_seconds: 600, completed_at: now };
  db.trainings.push({ id: "tr_1", title: "ICT workshop", held_on: "2026-09-10", county: "Narok", school_id: null, archived_at: null });
  db.training_attendance.push({ training_id: "tr_1", teacher_id: "teacher-id", attended: true });
  db.me_programmes.push({ id: "prog_1", code: "P1", name: "Digital learning", status: "active" });
  db.me_outcomes.push({ id: "out_1", programme_id: "prog_1", code: "O1", title: "Learners use digital content", position: 1, archived_at: null });
  db.me_indicators.push({ id: "ind_1", outcome_id: "out_1", code: "1.1", name: "Learners reading digitally", unit: "number", direction: "increase",
    source: "manual", source_config: {}, baseline_value: 10, position: 1, archived_at: null });
  db.me_targets.push({ id: "tg_1", indicator_id: "ind_1", period: "2026-T3", scope_type: "programme", scope_id: null, target_value: 100 });
  db.me_actuals.push({ id: "act_1", indicator_id: "ind_1", period: "2026-T3", scope_type: "programme", scope_id: null, value: 80, status: "verified", superseded_at: null, recorded_by: "me-id" });
  return db;
}
const sectionRows = (json: Row, title: string) => (json.sections as Row[]).find((x) => x.title === title)?.rows as Row[];

Deno.test("reports: the catalogue lists only the reports a person may export", async () => {
  reportWorld();
  const ids = async (tok: string) => ((await call("GET", "/reports", tok)).json.reports as Row[]).map((x) => x.id);
  assertEquals((await ids("tok_super_admin")).length, 11, "the Super Admin keeps every right");
  assertEquals(await ids("tok_education_team"), ["learner-register", "teacher-register", "school-register", "assignment-report",
    "assessment-report", "field-visit-report", "library-usage"], "learning reports");
  assertEquals((await ids("tok_admin")).includes("me-indicator-report"), false, "not the M&E results framework");
  assertEquals(await ids("tok_teacher"), ["learner-register", "assignment-report", "assessment-report"]);
  assertEquals(await ids("tok_field_officer"), ["teacher-register", "school-register", "field-visit-report"], "their assigned schools");
  assertEquals(await ids("tok_school_leader"), ["learner-register", "teacher-register", "school-register", "assignment-report", "assessment-report", "term-report"]);
  const head = (await call("GET", "/reports", "tok_school_leader")).json;
  assert(head.reports.every((x: Row) => x.scope === "Your school"), "a head's exports are their school");
  assertEquals((await call("GET", "/reports/no-such-report", "tok_education_team")).status, 404);
});

Deno.test("reports: every report builds for the Super Admin, and every export is audited", async () => {
  const db = reportWorld();
  for (const id of ["learner-register", "teacher-register", "school-register", "assignment-report", "assessment-report", "field-visit-report",
    "kobo-report", "library-usage", "me-indicator-report", "term-report", "county-report"]) {
    const res = await call("GET", `/reports/${id}?format=xlsx&period=2026-T3`, "tok_super_admin");
    assertEquals(res.status, 200, `${id}: ${JSON.stringify(res.json)}`);
    assert(Array.isArray(res.json.sections) && res.json.sections.length > 0, id);
    for (const sec of res.json.sections as Row[]) {
      for (const row of sec.rows as Row[]) for (const col of sec.columns as Row[]) assert(col.key in row, `${id} / ${sec.title}: ${col.key}`);
    }
    assertEquals(res.json.generatedBy, "super_admin person");
    const entry = db.audit_log.at(-1)!;
    assertEquals([entry.action, entry.target_id, entry.details.format], ["report.exported", id, "xlsx"]);
  }
  const mel = (await call("GET", "/reports/me-indicator-report?period=2026-T3", "tok_super_admin")).json;
  const ind = sectionRows(mel, "Indicators")[0];
  assertEquals([ind.indicator, ind.baseline, ind.target, ind.actual, ind.achievement, ind.status], ["Learners reading digitally", 10, 100, 80, 80, "Close"]);
  const kobo = (await call("GET", "/reports/kobo-report", "tok_super_admin")).json;
  assertEquals(sectionRows(kobo, "Submissions")[0].issues, "q1 is required");
  assertEquals(sectionRows(kobo, "Surveys")[0].review, 1);
});

Deno.test("reports: never PINs or usernames; staff emails only for those who manage accounts", async () => {
  reportWorld();
  const learners = (await call("GET", "/reports/learner-register", "tok_education_team")).json;
  const text = JSON.stringify(learners);
  assert(!text.includes("kid.one") && !text.includes("pin_") && !text.includes("username"), "no usernames or PINs");
  assertEquals(sectionRows(learners, "Learners").map((x) => x.name), ["Kid One", "Kid B"], "by school, then name");
  const ed = (await call("GET", "/reports/teacher-register", "tok_admin")).json;
  assert(sectionRows(ed, "Teachers").every((x) => String(x.email).endsWith("@test.org")));
  const me = (await call("GET", "/reports/teacher-register", "tok_me")).json;
  assert(!JSON.stringify(me).includes("@test.org"), "the M&E team sees the register, not emails");
  assertEquals(sectionRows(me, "Teachers").length, 3, "all schools' active teachers");
  assertEquals(sectionRows(me, "Teachers").find((x) => x.name === "teacher person")!.trainings, 1);
});

Deno.test("reports: a school head's exports are their own school, whatever they ask for", async () => {
  reportWorld();
  const other = `school=${encodeURIComponent(SCHOOL.name)}`;
  const learners = (await call("GET", `/reports/learner-register?${other}`, "tok_head_b")).json;
  assertEquals(sectionRows(learners, "Learners").map((x) => x.name), ["Kid B"], "never the other school's learners");
  assertEquals([learners.scope, learners.limitedTo, learners.filters.school], [SCHOOL_B.name, "Your school", SCHOOL_B.name]);
  const schools = (await call("GET", `/reports/school-register?${other}`, "tok_head_b")).json;
  assertEquals(sectionRows(schools, "Schools").map((x) => x.name), [SCHOOL_B.name]);
  const teachers = (await call("GET", `/reports/teacher-register?${other}&status=all`, "tok_head_b")).json;
  assertEquals(sectionRows(teachers, "Teachers").map((x) => x.name), ["Teacher B"]);
  assertEquals(sectionRows(teachers, "School heads").map((x) => x.name), ["Head B"]);
  assert(!JSON.stringify(teachers).includes("@test.org"));
  const work = (await call("GET", `/reports/assignment-report?${other}`, "tok_head_b")).json;
  assertEquals(sectionRows(work, "Assignments").map((x) => x.title), ["Reading check"]);
  const term = (await call("GET", `/reports/term-report?period=2026-T3&${other}`, "tok_head_b")).json;
  assertEquals(sectionRows(term, "By school").map((x) => x.school), [SCHOOL_B.name]);
  assertEquals(term.limitedTo, "Your school");
});

Deno.test("reports: a teacher's exports are their classes; a field officer's are their own visits", async () => {
  reportWorld();
  // teacher-id first added Kid B, but Kid B is in another school now.
  assertEquals(sectionRows((await call("GET", "/reports/learner-register", "tok_teacher")).json, "Learners").map((x) => x.name), ["Kid One"]);
  const work = (await call("GET", "/reports/assignment-report", "tok_teacher")).json;
  assertEquals(sectionRows(work, "Assignments").map((x) => [x.title, x.handedIn, x.completion, x.average]), [["Fractions quiz", 1, 100, 75]]);
  const marked = sectionRows((await call("GET", "/reports/assessment-report", "tok_teacher")).json, "Marked work");
  assertEquals(marked.map((x) => [x.learner, x.percent, x.band, x.markedBy]), [["Kid One", 75, "ME", "teacher person"]]);
  assertEquals((await call("GET", "/reports/assignment-report", "tok_teacher2")).json.sections[0].rows, [], "teaches no class");
  const visits = sectionRows((await call("GET", "/reports/field-visit-report", "tok_field_officer")).json, "Field visits");
  assertEquals(visits.map((x) => x.school), [SCHOOL.name]);
  const all = sectionRows((await call("GET", "/reports/field-visit-report", "tok_education_team")).json, "Field visits");
  assertEquals(all.length, 2);
});

/* ------------------------------------------------------------ role-based access: workspaces, scope, grants */


Deno.test("access: /me says which workspace, what scope and which permissions — a Super Admin keeps them all", async () => {
  freshWorld();
  const me = async (tok: string) => (await call("GET", "/me", tok)).json.profile;
  const sa = await me("tok_super_admin");
  assertEquals([sa.workspace.page, sa.workspace.title, sa.scope.global], ["platform.html", "Platform Administration", true]);
  assertEquals(sa.workspaces, ["platform", "admin", "me", "education"], "a Super Admin can open every management workspace");
  for (const p of ["users.roles.assign", "me.framework.manage", "library.manage", "kobo.configure", "permissions.manage", "audit.view"]) assert(sa.permissions.includes(p), p);
  assertEquals([(await me("tok_admin")).workspace.page, (await me("tok_me")).workspace.page, (await me("tok_education_team")).workspace.page],
    ["admin.html", "me.html", "education.html"]);
  assertEquals((await me("tok_admin")).workspaces, ["admin"], "no other workspace");
  const fo = await me("tok_field_officer");
  assertEquals([fo.workspace.title, fo.scope.global, fo.scope.label], ["Field Operations", false, "Narok County"]);
});

Deno.test("access: separation of duties holds at the API, whatever the browser shows", async () => {
  freshWorld();
  const st = async (method: string, path: string, tok: string, body?: unknown) => (await call(method, path, tok, body)).status;
  // Education Team: learning work, no account administration, security or integrations.
  assertEquals(await st("GET", "/users", "tok_education_team"), 403);
  assertEquals(await st("PUT", "/kobo/config", "tok_education_team", { apiToken: "x" }), 403);
  assertEquals(await st("GET", "/audit", "tok_education_team"), 403);
  assertEquals(await st("POST", "/schools", "tok_education_team", { name: "X", county: "Narok" }), 403);
  // M&E: measures, never changes accounts or records.
  assertEquals(await st("PATCH", "/users/teacher2-id", "tok_me", { fullName: "X" }), 403);
  assertEquals(await st("POST", "/learners/learner-id/transfer", "tok_me", { toSchoolId: "sch_2" }), 403);
  assertEquals(await st("POST", "/kobo/sync", "tok_me", {}), 403);
  // Admin: not the M&E framework, not the platform.
  assertEquals(await st("POST", "/mel/programmes", "tok_admin", { name: "X" }), 403);
  assertEquals(await st("GET", "/platform/overview", "tok_admin"), 403);
  assertEquals(await st("GET", "/permissions", "tok_admin"), 403);
  assertEquals(await st("PUT", "/kobo/config", "tok_admin", { apiToken: "x" }), 403);
  // Working roles: never another workspace's data.
  assertEquals(await st("GET", "/admin/overview", "tok_teacher"), 403);
  assertEquals(await st("GET", "/users", "tok_school_leader"), 403);
  assertEquals(await st("GET", "/learners", "tok_field_officer"), 403);
  assertEquals(await st("GET", "/assignments", LEARNER), 403);
  // The Super Admin can do all of it.
  for (const [m, path] of [["GET", "/users"], ["GET", "/audit"], ["GET", "/platform/overview"], ["GET", "/admin/overview"], ["GET", "/mel/programmes"], ["GET", "/permissions"]]) {
    assertEquals(await st(m, path, "tok_super_admin"), 200, path);
  }
});

Deno.test("scope: M&E narrowed to one county sees only that county — lists, dashboards, data quality, M&E, reports", async () => {
  const db = twoCounties();
  assign(db, "me-id", [{ county: "Meru" }]);
  const get = async (path: string) => (await call("GET", path, "tok_me")).json;
  assertEquals((await get("/me")).profile.scope.label, "Meru County");
  assertEquals((await get("/learners")).learners.map((l: Row) => l.fullName), ["Kid C"]);
  assertEquals((await get("/schools")).schools.map((s: Row) => s.name), ["Meru Central"]);
  assertEquals((await get("/schools")).counties, ["Meru"]);
  assertEquals((await get("/field-reports")).reports.map((r: Row) => r.id), ["fr_m"]);
  assertEquals((await get("/data-quality/issues")).issues.map((i: Row) => i.summary), ["Meru issue"]);
  assertEquals((await call("GET", "/data-quality/issues/dq_n", "tok_me")).status, 404, "another county's issue doesn't exist for them");
  assertEquals((await call("PATCH", "/data-quality/issues/dq_n", "tok_me", { status: "UNDER_REVIEW" })).status, 404);
  assertEquals((await get("/impact")).executive.schools, 1, "dashboards count only their county");
  assertEquals((await get("/intelligence")).learning.totals.schools, 1);
  assertEquals((await get("/teachers")).teachers.map((t: Row) => t.name), ["Teacher C"]);
  assertEquals((await call("GET", `/schools/${SCHOOL.id}/profile`, "tok_me")).status, 404);
  assertEquals((await get(`/schools/${SCHOOL_C.id}/profile`)).school.name, "Meru Central");
  // M&E: never the whole programme or another county.
  const prog = (await call("POST", "/mel/programmes", "tok_me", { name: "P" })).json.id;
  assertEquals((await call("GET", `/mel/programmes/${prog}/results?period=2026-T3`, "tok_me")).status, 403, "the whole programme is wider than Meru");
  assertEquals((await call("GET", `/mel/programmes/${prog}/results?period=2026-T3&county=Narok`, "tok_me")).status, 403);
  assertEquals((await call("GET", `/mel/programmes/${prog}/results?period=2026-T3&county=Meru`, "tok_me")).status, 200);
  // Exports: the same.
  const reg = await get("/reports/learner-register");
  assertEquals([reg.sections[0].rows.map((r: Row) => r.name), reg.limitedTo], [["Kid C"], "Meru County"]);
  // A data-quality scan covers the whole portal: whole-portal staff only.
  assertEquals((await call("POST", "/data-quality/scan", "tok_me", {})).status, 403);
});

Deno.test("scope: an Admin narrowed to a county manages people there, and only in school or field roles", async () => {
  const db = twoCounties();
  assign(db, "admin-id", [{ county: "Meru" }]);
  const users = (await call("GET", "/users", "tok_admin")).json.users;
  assertEquals(users.map((u: Row) => u.fullName).sort(), ["Teacher C"], "only people placed in Meru");
  assertEquals((await call("PATCH", "/users/teacher2-id", "tok_admin", { fullName: "X" })).status, 404, "a Narok teacher isn't theirs");
  assertEquals((await call("PATCH", "/users/teacher-c-id", "tok_admin", { fullName: "Teacher Cee" })).status, 200);
  assertEquals((await call("POST", "/users/invitations", "tok_admin", { email: "n@test.org", role: "teacher", schoolId: SCHOOL.id })).status, 403, "not in their area");
  assertEquals((await call("POST", "/users/invitations", "tok_admin", { email: "m@test.org", role: "teacher", schoolId: SCHOOL_C.id })).status, 200);
  assertEquals((await call("POST", "/users/invitations", "tok_admin", { email: "e@test.org", role: "education_team" })).status, 403,
    "a programme-wide role would see more than they do");
  assertEquals((await call("POST", "/schools", "tok_admin", { name: "Narok New", county: "Narok" })).status, 403);
  assertEquals((await call("POST", "/schools", "tok_admin", { name: "Meru New", county: "Meru" })).status, 200);
  assertEquals((await call("POST", "/counties", "tok_admin", { name: "Kajiado", code: "KJD" })).status, 403, "counties are for whole-portal admins");
  assertEquals((await call("POST", "/academic-years", "tok_admin", { id: "2027" })).status, 403, "so is the calendar");
  assertEquals((await call("POST", "/learners/learner-id/transfer", "tok_admin", { toSchoolId: SCHOOL_C.id })).status, 404, "a Narok learner isn't theirs");
});

Deno.test("scope: a field officer works only at assigned schools", async () => {
  const db = twoCounties();
  db.staff_scopes.length = 0;
  const visit = (schoolId: string, ref: string) => call("POST", "/field-reports", "tok_field_officer", { schoolId, visitType: "ICT", responses: [], clientRef: ref });
  // Nothing assigned: no schools, no visits.
  assertEquals((await call("GET", "/schools", "tok_field_officer")).json.schools, []);
  assertEquals((await call("GET", "/me", "tok_field_officer")).json.profile.scope.label, "No schools assigned yet");
  assertEquals((await visit(SCHOOL.id, "ref-a-0001")).status, 403);
  // One school assigned.
  assign(db, "field_officer-id", [{ school_id: SCHOOL_C.id }]);
  assertEquals((await call("GET", "/schools", "tok_field_officer")).json.schools.map((s: Row) => s.name), ["Meru Central"]);
  assertEquals((await visit(SCHOOL.id, "ref-b-0001")).status, 403, "not assigned");
  assertEquals((await visit(SCHOOL_C.id, "ref-c-0001")).status, 200);
  assertEquals((await call("GET", "/teachers", "tok_field_officer")).json.teachers.map((t: Row) => t.name), ["Teacher C"]);
  assertEquals((await call("GET", `/schools/${SCHOOL.id}/profile`, "tok_field_officer")).status, 404);
  assertEquals((await call("GET", `/schools/${SCHOOL_C.id}/profile`, "tok_field_officer")).json.learners, 1);
});

Deno.test("scope: assignments are set on the Users page, ended (never deleted) and audited", async () => {
  const db = twoCounties();
  const put = (tok: string, id: string, body: unknown) => call("PUT", `/users/${id}/scope`, tok, body);
  assertEquals((await put("tok_admin", "teacher-id", { counties: ["Meru"] })).status, 400, "a teacher's data comes from their classes");
  const res = await put("tok_admin", "field_officer-id", { counties: ["Meru"], schoolIds: [SCHOOL.id] });
  assertEquals([res.status, res.json.scope.label], [200, "Meru County and Aitong Primary"]);
  const ended = db.staff_scopes.filter((x) => x.profile_id === "field_officer-id" && x.ended_at);
  assertEquals(ended.map((x) => [x.county, x.ended_by]), [["Narok", "admin-id"]], "the old Narok assignment is kept, ended");
  assert(db.audit_log.some((a) => a.action === "scope.changed" && a.target_id === "field_officer-id"));
  const access = (await call("GET", "/users/field_officer-id/access", "tok_admin")).json;
  assertEquals([access.scope.label, access.canEditScope, access.scope.rows.length], ["Meru County and Aitong Primary", true, 3]);
  // Narrowed admins hand out only what they hold, and never manage programme staff.
  assign(db, "admin-id", [{ county: "Meru" }]);
  assign(db, "me-id", [{ county: "Meru" }]);
  assertEquals((await put("tok_admin", "me-id", { counties: ["Meru"] })).status, 404, "programme staff aren't placed in their area");
  assertEquals((await put("tok_super_admin", "me-id", { counties: [] })).status, 200, "a Super Admin can make M&E global again");
  assertEquals((await call("GET", "/me", "tok_me")).json.profile.scope.global, true);
});

Deno.test("grants: a Super Admin gives one person one extra permission, with a reason, and takes it back", async () => {
  const db = freshWorld();
  const grant = (tok: string, body: unknown, id = "education_team-id") => call("POST", `/users/${id}/grants`, tok, body);
  assertEquals((await grant("tok_admin", { permission: "kobo.results.view", reason: "Covering" })).status, 403, "only a Super Admin grants");
  assertEquals((await grant("tok_super_admin", { permission: "kobo.results.view" })).status, 400, "a reason is required");
  assertEquals((await grant("tok_super_admin", { permission: "permissions.manage", reason: "No" })).status, 400, "the power to grant can't be granted");
  assertEquals((await grant("tok_super_admin", { permission: "assignments.grade", reason: "No" })).status, 400, "a teacher's own work can't be granted");
  assertEquals((await grant("tok_super_admin", { permission: "library.manage", reason: "Has it" })).status, 409, "their role already includes it");
  assertEquals((await grant("tok_super_admin", { permission: "users.view", reason: "Mine" }, "super_admin-id")).status, 403, "not to yourself");
  assertEquals((await call("GET", "/kobo/records?formId=kb_1", "tok_education_team")).status, 403);
  const made = await grant("tok_super_admin", { permission: "kobo.results.view", reason: "Covering M&E during leave" });
  assertEquals(made.status, 200);
  assertEquals((await call("GET", "/kobo/records?formId=kb_1", "tok_education_team")).status, 200, "the grant takes effect");
  assert((await call("GET", "/me", "tok_education_team")).json.profile.permissions.includes("kobo.results.view"));
  assertEquals((await grant("tok_super_admin", { permission: "kobo.results.view", reason: "Again" })).status, 409);
  const id = made.json.grant.id;
  assertEquals((await call("POST", `/users/education_team-id/grants/${id}/revoke`, "tok_super_admin", {})).status, 400, "say why");
  assertEquals((await call("POST", `/users/education_team-id/grants/${id}/revoke`, "tok_super_admin", { reason: "Back from leave" })).status, 200);
  assertEquals((await call("GET", "/kobo/records?formId=kb_1", "tok_education_team")).status, 403, "revoked");
  assertEquals(db.permission_grants.length, 1, "kept, marked revoked");
  assertEquals(db.audit_log.filter((a) => a.action.startsWith("permission.")).map((a) => a.action), ["permission.granted", "permission.revoked"]);
  const sec = (await call("GET", "/audit?kind=security", "tok_super_admin")).json.entries.map((e: Row) => e.action);
  assert(sec.includes("permission.granted") && sec.includes("permission.revoked"));
  const model = (await call("GET", "/permissions", "tok_super_admin")).json;
  assertEquals(model.roles.find((x: Row) => x.role === "admin").workspace.title, "Programme Administration");
});

Deno.test("access: overviews, badges, the users list and account activity", async () => {
  freshWorld();
  const pf = (await call("GET", "/platform/overview", "tok_super_admin")).json;
  assertEquals(pf.accounts.pending, 1);
  assert(pf.checks.some((x: Row) => x.label === "More than one active Super Admin" && !x.ok), "one Super Admin is a risk");
  assert(pf.checks.some((x: Row) => x.label === "Every field officer has assigned schools" && x.ok));
  const ad = (await call("GET", "/admin/overview", "tok_admin")).json;
  assertEquals([ad.organisation.schools, ad.people.learners, ad.people.pending], [2, 2, 1]);
  assertEquals((await call("GET", "/nav/badges", "tok_admin")).json.badges.approvals, 1);
  assertEquals((await call("GET", "/nav/badges", "tok_education_team")).json.badges.approvals, undefined, "only badges they may see");
  const users = (await call("GET", "/users", "tok_admin")).json.users;
  const t = users.find((u: Row) => u.id === "teacher-id");
  assertEquals([t.lastSignInAt, t.scope.label], ["2026-10-02T08:00:00.000Z", "Aitong Primary"]);
  assertEquals(users.find((u: Row) => u.id === "field_officer-id").scope.label, "Narok County");
  const act = (await call("GET", "/security/activity", "tok_super_admin")).json;
  assertEquals(act.staff[0].lastSignInAt, "2026-10-02T08:00:00.000Z", "most recent first");
  assertEquals((await call("GET", "/users/teacher2-id/history", "tok_admin")).status, 200);
});
