/**
 * Observability: error reports (telemetry.ts and the routes that use it),
 * the health check, sync events, and the stuck-devices page.
 *
 *   cd supabase/functions/api && deno task test
 *
 * Error reports go to a recording stand-in for Sentry, never the network.
 */
import { assert, assertEquals, assertFalse, assertMatch } from "jsr:@std/assert@1";
import { __setAdminClientForTests, app, assign, call, fakeAdmin, freshWorld, type Row, tokenFor, USERS } from "./test_world.ts";
import { __setTelemetryForTests, flushTelemetry, parseDsn, parseStack, routePattern, scrub } from "./telemetry.ts";

const DSN = "https://abc123@o1.ingest.sentry.io/4507";
const LEARNER = tokenFor("learner");

/** Turns reporting on, recording each event sent. */
function recordReports() {
  const sent: Row[] = [];
  __setTelemetryForTests({
    dsn: DSN,
    fetch: (_url, init) => {
      const lines = String(init?.body).trim().split("\n");
      sent.push({ url: String(_url), auth: new Headers(init?.headers).get("X-Sentry-Auth"), header: JSON.parse(lines[0]), event: JSON.parse(lines[2]) });
      return Promise.resolve(new Response("{}", { status: 200 }));
    },
  });
  return sent;
}
const reportingOff = () => __setTelemetryForTests({ dsn: null });

/** The usual world, with one table that fails when it's read. */
function worldWhere(table: string, fail: () => never) {
  const db = freshWorld();
  const base = fakeAdmin(db, USERS);
  __setAdminClientForTests({ ...base, from: (t: string) => (t === table ? fail() : base.from(t)) });
  return db;
}

/* ------------------------------------------------------------ telemetry.ts */

Deno.test("telemetry: a DSN becomes the envelope address; anything else turns reporting off", () => {
  assertEquals(parseDsn(DSN)?.envelopeUrl, "https://o1.ingest.sentry.io/api/4507/envelope/");
  assertEquals(parseDsn(DSN)?.publicKey, "abc123");
  // GlitchTip, self-hosted under a path
  assertEquals(parseDsn("https://k@errors.example.org/glitchtip/12")?.envelopeUrl, "https://errors.example.org/glitchtip/api/12/envelope/");
  for (const bad of [null, "", "not a url", "https://o1.ingest.sentry.io/4507", "https://k@host/notanumber", "ftp://k@host/1"]) {
    assertEquals(parseDsn(bad), null, String(bad));
  }
});

Deno.test("telemetry: messages lose emails, tokens, PINs, phone numbers and query strings", () => {
  const out = scrub(
    "Learner kid.one@school.org PIN 4821 failed; pin=1234 Bearer eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.abcdefghijk hpl_s3cr3t " +
      "call +254 712 345 678 at https://x.supabase.co/storage/v1/object/sign/a.pdf?token=abc Key (username)=(kid.one) duplicate key value",
  );
  for (const gone of ["kid.one@school.org", "4821", "1234", "eyJhbGci", "s3cr3t", "712 345 678", "token=abc", "(kid.one)"]) {
    assertFalse(out.includes(gone), `${gone} in: ${out}`);
  }
  assertMatch(out, /\[email\]/);
  assertMatch(out, /duplicate key value/, "ordinary words survive");
  assertEquals(scrub("Grade 4 closed on 2026-10-07"), "Grade 4 closed on 2026-10-07", "dates and small numbers stay");
  assertEquals(scrub("x".repeat(900)).length, 500);
});

Deno.test("telemetry: stacks become frames from Chrome and Firefox/Safari, oldest call first, no query strings", () => {
  const chrome = parseStack("TypeError: x is undefined\n    at render (https://learning-portal.vercel.app/static/console-AB12.js?v=1:3:1405)\n    at https://khaima.github.io/Learning-portal/static/index-Z9.js:1:88");
  assertEquals(chrome.map((f) => [f.function, f.filename, f.lineno, f.colno]), [
    [undefined, "static/index-Z9.js", 1, 88],
    ["render", "static/console-AB12.js", 3, 1405],
  ]);
  const gecko = parseStack("render@https://learning-portal.vercel.app/static/console-AB12.js:3:1405\n@https://learning-portal.vercel.app/static/index-Z9.js:1:88");
  assertEquals(gecko.map((f) => f.filename), ["static/index-Z9.js", "static/console-AB12.js"]);
  assertEquals(parseStack(undefined), []);
});

Deno.test("telemetry: routes lose their ids", () => {
  assertEquals(routePattern("/api/learners/9f0c2a1e-1b2c-4d5e-8f90-1234567890ab/history"), "/api/learners/:id/history");
  assertEquals(routePattern("/assignments/asg_1/submit?x=1"), "/assignments/:id/submit");
  assertEquals(routePattern("/reports/learner-register"), "/reports/learner-register");
});

/* ------------------------------------------------------------ the API's own errors */

Deno.test("API errors: a 5xx is reported with role and school from the database, never the person", async () => {
  const sent = recordReports();
  worldWhere("library_items", () => { throw new Error("boom near kid.one@test.org with PIN 4821"); });
  assertEquals((await call("GET", "/sync/status", "tok_teacher")).status, 500);
  assertEquals((await call("GET", "/sync/status", LEARNER)).status, 500);
  await flushTelemetry();
  assertEquals(sent.length, 1, "the same error from one place goes once a minute");
  const { event, url, auth, header } = sent[0];
  assertEquals(url, "https://o1.ingest.sentry.io/api/4507/envelope/");
  assertMatch(auth, /sentry_key=abc123/);
  assertEquals(header.dsn, DSN);
  assertEquals([event.tags.side, event.tags.role, event.tags.account, event.tags.school, event.tags.status], ["api", "teacher", "staff", "NRK-001", "500"]);
  assertEquals(event.transaction, "GET /api/sync/status");
  assertEquals(event.exception.values[0].type, "Error");
  assertMatch(event.exception.values[0].value, /^boom near \[email\] with PIN \[number\]$/);
  assertMatch(event.user.id, /^[0-9a-f]{16}$/);
  const raw = JSON.stringify(event);
  for (const secret of ["teacher-id", "teacher person", "teacher@test.org", "Aitong Primary", "4821"]) assertFalse(raw.includes(secret), secret);
  reportingOff();
});

Deno.test("API errors: a learner's error is tagged learner and their school; a refused request (4xx) isn't an error", async () => {
  const sent = recordReports();
  worldWhere("library_items", () => { throw new Error("learner side"); });
  assertEquals((await call("GET", "/sync/status", LEARNER)).status, 500);
  assertEquals((await call("GET", "/sync/devices", "tok_teacher")).status, 403);
  assertEquals((await call("GET", "/sync/status")).status, 401);
  await flushTelemetry();
  assertEquals(sent.length, 1);
  assertEquals([sent[0].event.tags.role, sent[0].event.tags.account, sent[0].event.tags.school], ["learner", "learner", "NRK-001"]);
  assertFalse(JSON.stringify(sent[0].event).includes("Kid One"));
  reportingOff();
});

Deno.test("API errors: nothing is sent without a DSN", async () => {
  let calls = 0;
  __setTelemetryForTests({ dsn: null, fetch: () => { calls++; return Promise.resolve(new Response("{}")); } });
  worldWhere("library_items", () => { throw new Error("off"); });
  assertEquals((await call("GET", "/sync/status", "tok_teacher")).status, 500);
  await flushTelemetry();
  assertEquals(calls, 0);
});

/* ------------------------------------------------------------ the browser's errors */

Deno.test("browser errors: who sent it comes from the session, not the report", async () => {
  const sent = recordReports();
  freshWorld();
  const crash = { type: "TypeError", message: "Cannot read properties of undefined (reading 'name')", stack: "at go (https://khaima.github.io/Learning-portal/static/learner-X1.js:1:20)", page: "learner.html", source: "window.error", release: "abc1234", role: "super_admin", school: "FORGED" };
  assertEquals((await call("POST", "/telemetry/error", LEARNER, crash)).status, 202);
  assertEquals((await call("POST", "/telemetry/error", undefined, { ...crash, message: "signed out one", page: "index.html" })).status, 202);
  assertEquals((await call("POST", "/telemetry/error", "tok_not_a_session", { ...crash, message: "bad session" })).status, 202);
  await flushTelemetry();
  assertEquals(sent.length, 3);
  // Sent in the background, so not necessarily in order.
  const byMessage = (m: string) => sent.map((s) => s.event).find((e) => e.exception.values[0].value === m)!;
  const [learner, anon, bad] = [crash.message, "signed out one", "bad session"].map(byMessage);
  assertEquals([learner.tags.side, learner.tags.role, learner.tags.school, learner.platform, learner.release, learner.transaction], ["browser", "learner", "NRK-001", "javascript", "abc1234", "learner.html"]);
  assertEquals(learner.exception.values[0].stacktrace.frames[0].filename, "static/learner-X1.js");
  assertEquals([anon.tags.role, anon.tags.account, anon.user], ["signed-out", "none", undefined]);
  assertEquals(bad.tags.role, "signed-out", "a session that doesn't check out counts as none");
  reportingOff();
});

Deno.test("browser errors: too big, not JSON, or too many — and always 202 otherwise", async () => {
  const sent = recordReports();
  freshWorld();
  assertEquals((await call("POST", "/telemetry/error", undefined, { message: "x".repeat(17_000) })).status, 413);
  const res = await app.request("/api/telemetry/error", { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
  assertEquals(res.status, 400);
  for (let i = 0; i < 25; i++) await call("POST", "/telemetry/error", "tok_teacher", { message: `error ${String.fromCharCode(97 + i)}`, page: "teacher.html" });
  await flushTelemetry();
  assertEquals(sent.length, 20, "20 a minute from one person");
  reportingOff();
  const off = await call("POST", "/telemetry/error", "tok_admin", { message: "with reporting off" });
  assertEquals([off.status, off.json.sent], [202, false]);
});

/* ------------------------------------------------------------ health */

Deno.test("health: up when the database answers, 503 when it doesn't — and never cached", async () => {
  freshWorld();
  const ok = await call("GET", "/health");
  assertEquals([ok.status, ok.json.ok, ok.json.database, ok.json.release, ok.cache], [200, true, "ok", "dev", "no-store"]);
  worldWhere("counties", () => { throw new Error("connection refused"); });
  const down = await call("GET", "/health");
  assertEquals([down.status, down.json.ok, down.json.database], [503, false, "unreachable"]);
});

/* ------------------------------------------------------------ sync events */

const ev = (id: string, more: Row = {}) => ({ id, event: "failed", kind: "learner-work", method: "POST", path: "/assignments/9f0c2a1e-1b2c-4d5e-8f90-1234567890ab/submit", status: 409, message: "The assignment is closed", attempts: 1, at: new Date().toISOString(), ...more });

Deno.test("sync events: stored once each, with who and where from the session", async () => {
  const db = freshWorld();
  const batch = { deviceId: "tablet-0001", appVersion: "2026.10.07a", role: "admin", events: [ev("evt-000001"), ev("evt-000002", { event: "conflict", message: "Changed on another device by kid.one@test.org" }), ev("bad"), ev("evt-000003", { event: "hacked" })] };
  const res = await call("POST", "/sync/events", LEARNER, batch);
  assertEquals([res.status, res.json.stored], [200, 2], "two valid events; a bad id and an unknown event are dropped");
  await call("POST", "/sync/events", LEARNER, batch);
  assertEquals(db.sync_events.length, 2, "sent twice, stored once");
  const [first, second] = db.sync_events;
  assertEquals([first.actor_kind, first.learner_id, first.profile_id, first.role, first.school_id], ["learner", "learner-id", null, "learner", "sch_1"]);
  assertEquals([first.route, first.status, first.device_id, first.app_version], ["/assignments/:id/submit", 409, "tablet-0001", "2026.10.07a"]);
  assertEquals(second.message, "Changed on another device by [email]");
  assertEquals((await call("POST", "/sync/events", "tok_field_officer", { deviceId: "x", events: [] })).status, 400);
  const fo = await call("POST", "/sync/events", "tok_field_officer", { deviceId: "phone-0001", events: [ev("evt-000004", { kind: "field-visit", at: "2999-01-01T00:00:00Z" })] });
  assertEquals(fo.status, 200);
  const staffRow = db.sync_events.find((e) => e.event_key === "evt-000004")!;
  assertEquals([staffRow.actor_kind, staffRow.profile_id, staffRow.role, staffRow.county], ["staff", "field_officer-id", "field_officer", "Narok"]);
  assert(Date.parse(staffRow.occurred_at) <= Date.now() + 1000, "a time in the future is replaced by the time it arrived");
});

Deno.test("device reports: a learner's school is the learner's, whatever the device says", async () => {
  const db = freshWorld();
  await call("POST", "/sync/report", LEARNER, { deviceId: "tablet-0001", pending: 1, oldestQueuedAt: new Date().toISOString(), schoolId: "sch_2" });
  assertEquals([db.learner_device_sync_status[0].learner_id, db.learner_device_sync_status[0].school_id], ["learner-id", "sch_1"]);
});

/* ------------------------------------------------------------ stuck devices */

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600e3).toISOString();

Deno.test("stuck devices: work unsent for 48 hours or more, staff and learners, oldest first, with the latest reason", async () => {
  const db = freshWorld();
  await call("POST", "/sync/report", "tok_field_officer", { deviceId: "phone-0001", deviceLabel: "Android · Chrome", pending: 2, oldestQueuedAt: hoursAgo(50), lastSyncAt: hoursAgo(60) });
  await call("POST", "/sync/report", "tok_teacher", { deviceId: "laptop-0001", pending: 1, oldestQueuedAt: hoursAgo(47) });                // not yet
  await call("POST", "/sync/report", "tok_school_leader", { deviceId: "phone-0002", pending: 0, oldestQueuedAt: hoursAgo(90) });          // nothing waiting
  await call("POST", "/sync/report", LEARNER, { deviceId: "tablet-0001", deviceLabel: "Android · Chrome", failed: 1, oldestQueuedAt: hoursAgo(80) });
  await call("POST", "/sync/events", LEARNER, { deviceId: "tablet-0001", events: [ev("evt-000010", { message: "The assignment is closed" })] });
  // An older copy of the app reports only its oldest WAITING item.
  db.device_sync_status.push({ actor_id: "teacher2-id", device_id: "old-app-0001", pending: 3, failed: 0, conflicts: 0, oldest_pending_at: hoursAgo(72), oldest_queued_at: null, reported_at: hoursAgo(70) });

  const res = await call("GET", "/sync/problems", "tok_education_team");
  assertEquals(res.status, 200);
  assertEquals(res.json.hours, 48);
  assertEquals(res.json.stuck.map((d: Row) => [d.kind, d.name, d.waitingHours]), [
    ["learner", "Kid One", 80],
    ["staff", "Second Teacher", 72],
    ["staff", "field_officer person", 50],
  ]);
  const kid = res.json.stuck[0];
  assertEquals([kid.roleLabel, kid.school, kid.failed, kid.lastEvent.event, kid.lastEvent.message], ["Learner · Grade 4", "Aitong Primary", 1, "failed", "The assignment is closed"]);
  assertEquals(res.json.summary.failed, 1);
  assertEquals([res.json.events[0].name, res.json.events[0].route], ["Kid One", "/assignments/:id/submit"]);
  assertEquals((await call("GET", "/sync/problems?hours=72", "tok_education_team")).json.stuck.length, 2);
});

Deno.test("stuck devices: only within the caller's scope", async () => {
  const db = freshWorld();
  await call("POST", "/sync/report", "tok_teacher_b", { deviceId: "laptop-000b", pending: 1, oldestQueuedAt: hoursAgo(60) });  // school B
  await call("POST", "/sync/report", "tok_teacher", { deviceId: "laptop-000a", pending: 1, oldestQueuedAt: hoursAgo(60) });    // school A
  await call("POST", "/sync/events", "tok_teacher_b", { deviceId: "laptop-000b", events: [ev("evt-00000b", { kind: "mark" })] });
  assertEquals((await call("GET", "/sync/problems", "tok_admin")).json.stuck.length, 2, "programme-wide until a scope is set");
  assign(db, "education_team-id", [{ school_id: "sch_1" }]);
  const scoped = (await call("GET", "/sync/problems", "tok_education_team")).json;
  assertEquals(scoped.stuck.map((d: Row) => d.name), ["teacher person"]);
  assertEquals([scoped.events.length, scoped.summary.failed], [0, 0], "school B's events stay out of sight too");
});
