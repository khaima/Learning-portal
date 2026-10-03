/**
 * Unit tests for the notification rules (notifications.ts) — hand-made
 * rows, no database.
 *
 *   cd supabase/functions/api
 *   deno test --config deno.json notifications_test.ts
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { buildNotifications, localDay, missingVisitForms, type NotifyInput } from "./notifications.ts";

// 3 Oct 2026, 09:00 in Kenya (06:00 UTC). "Tomorrow" is Sunday 4 Oct.
const NOW = new Date("2026-10-03T06:00:00Z");
const can = (role: string, p: string) =>
  (p === "kobo.manage" && ["education_team", "admin", "super_admin"].includes(role)) ||
  (p === "users.approve" && ["admin", "super_admin"].includes(role));

function world(): NotifyInput {
  return {
    profiles: [
      { id: "t1", role: "teacher", status: "active", county: "Narok", full_name: "Teacher One" },
      { id: "t2", role: "teacher", status: "active", county: "Narok", full_name: "Teacher Two" },
      { id: "h1", role: "school_leader", status: "active", county: "Narok", full_name: "Head One" },
      { id: "h2", role: "school_leader", status: "active", county: "Laikipia", full_name: "Head Two" },
      { id: "fo", role: "field_officer", status: "active", county: "Narok", full_name: "Officer" },
      { id: "ed", role: "education_team", status: "active", full_name: "Ed" },
      { id: "ad", role: "admin", status: "active", full_name: "Admin" },
      { id: "p1", role: "teacher", status: "pending", full_name: "New Teacher" },
      { id: "p2", role: "field_officer", status: "pending", full_name: "New Officer" },
    ],
    learners: [
      { id: "l1", class_id: "c1", enrollment_status: "ACTIVE" },
      { id: "l2", class_id: "c1", enrollment_status: "ACTIVE" },
      { id: "lx", class_id: "c1", enrollment_status: "TRANSFERRED" },
    ],
    classTeachers: [{ class_id: "c1", teacher_id: "t1", ended_at: null }, { class_id: "c1", teacher_id: "t2", ended_at: "2026-09-01" }],
    classes: [{ id: "c1", name: "Grade 4 East" }],
    assignments: [
      // Due tomorrow late evening in Kenya (20:30 UTC = 23:30 EAT) — still tomorrow.
      { id: "a1", class_id: "c1", title: "Fractions quiz", status: "published", due_at: "2026-10-04T20:30:00Z", created_by: "t1" },
      { id: "a2", class_id: "c1", title: "Reading log", status: "published", due_at: "2026-10-04T06:00:00Z", created_by: "t1" },
      // 22:00 UTC on the 4th is already the 5th in Kenya — not tomorrow.
      { id: "a3", class_id: "c1", title: "Spelling", status: "published", due_at: "2026-10-04T22:00:00Z", created_by: "t1" },
      { id: "a4", class_id: "c1", title: "Draft", status: "draft", due_at: "2026-10-04T08:00:00Z", created_by: "t1" },
      { id: "a5", class_id: "c1", title: "Old work", status: "closed", due_at: "2026-09-20T08:00:00Z", created_by: "t1" },
    ],
    submissions: [
      { id: "s1", assignment_id: "a1", learner_id: "l1", status: "submitted", submitted_at: "2026-10-02T08:00:00Z" },
      { id: "s2", assignment_id: "a5", learner_id: "l1", status: "submitted", submitted_at: "2026-09-25T08:00:00Z" },
      { id: "s3", assignment_id: "a5", learner_id: "l2", status: "marked", submitted_at: "2026-09-25T08:00:00Z", marked_at: "2026-10-02T10:00:00Z", percentage: 75, band: "ME" },
    ],
    forms: [
      { id: "f1", title: "Term return", audience: "school_leader", county: null, visit_type: null, due_on: "2026-10-05", archived_at: null, created_at: "2026-09-01" },
      { id: "f2", title: "Teacher survey", audience: "teacher", county: null, visit_type: null, due_on: "2026-10-01", archived_at: null, created_at: "2026-09-01" },
      { id: "f3", title: "Later survey", audience: "teacher", county: null, visit_type: null, due_on: "2026-10-20", archived_at: null, created_at: "2026-09-01" },
      { id: "fv1", title: "ICT checklist", audience: "field_officer", county: null, visit_type: "ICT", due_on: null, archived_at: null, created_at: "2026-09-01" },
      { id: "fv2", title: "Lab inventory", audience: "field_officer", county: "Narok", visit_type: "ICT", due_on: null, archived_at: null, created_at: "2026-09-01" },
      { id: "fv3", title: "New ICT form", audience: "field_officer", county: null, visit_type: "ICT", due_on: null, archived_at: null, created_at: "2026-10-02T12:00:00Z" },
    ],
    responses: [
      { form_id: "f1", respondent_id: "h2", visit_id: null },
      { form_id: "fv1", respondent_id: "fo", visit_id: "v1" },
    ],
    fieldReports: [
      { id: "v1", officer_id: "fo", school: "Aitong Primary", county: "Narok", visit_type: "ICT", created_at: "2026-10-01T09:00:00Z" },
      { id: "v2", officer_id: "fo", school: "Olpusimoru Primary", county: "Narok", visit_type: "Learning", created_at: "2026-10-01T09:00:00Z" },
      { id: "v3", officer_id: "fo", school: "Old visit", county: "Narok", visit_type: "ICT", created_at: "2026-08-01T09:00:00Z" },
    ],
    koboForms: [{ id: "k1", title: "Classroom observation" }, { id: "k2", title: "School infrastructure" }],
    koboReceived: [
      ...Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, kobo_form_id: "k1", received_at: "2026-10-03T05:00:00Z", needs_review: i < 3 })),
      { id: "r10", kobo_form_id: "k2", received_at: "2026-10-03T05:30:00Z", needs_review: false },
      { id: "r11", kobo_form_id: "k2", received_at: "2026-10-03T05:45:00Z", needs_review: false },
      { id: "old", kobo_form_id: "k2", received_at: "2026-10-01T05:45:00Z", needs_review: false },
    ],
    koboLastNotified: {},
    can,
  };
}
const forWho = (list: ReturnType<typeof buildNotifications>, id: string, kind?: string) => list.filter((n) => n.recipientId === id && (!kind || n.kind === kind));

Deno.test("a Kenyan day: due late tomorrow evening is tomorrow; just after midnight isn't", () => {
  assertEquals(localDay(new Date("2026-10-04T20:30:00Z")), "2026-10-04");
  assertEquals(localDay(new Date("2026-10-04T22:00:00Z")), "2026-10-05");
});

Deno.test("teacher: assignments due tomorrow in classes they teach, and work waiting to be marked", () => {
  const all = buildNotifications(world(), NOW);
  const [due] = forWho(all, "t1", "assignments_due");
  assertEquals(due.title, "2 assignments are due tomorrow.");
  assertEquals(due.body, "Fractions quiz (Grade 4 East), Reading log (Grade 4 East)", "not the draft, not the one due on the 5th");
  assertEquals([due.dedupeKey, due.link], ["assignments_due:2026-10-04", "teacher.html#assignments"]);
  assertEquals(forWho(all, "t2", "assignments_due").length, 0, "no longer teaches the class");
  const [mark] = forWho(all, "t1", "to_mark");
  assertEquals([mark.title, mark.body], ["2 pieces of work are waiting to be marked.", "1 has been waiting more than 3 days."]);
});

Deno.test("learner: due tomorrow unless handed in; told when work is marked", () => {
  const all = buildNotifications(world(), NOW);
  assertEquals(forWho(all, "l1", "assignments_due")[0].title, "1 assignment is due tomorrow.", "Fractions quiz is handed in already");
  assertEquals(forWho(all, "l2", "assignments_due")[0].title, "2 assignments are due tomorrow.");
  assertEquals(forWho(all, "lx").length, 0, "not someone who left");
  const [marked] = forWho(all, "l2", "work_marked");
  assertEquals([marked.title, marked.body, marked.recipientKind], ["Your “Old work” was marked: 75%.", "Band: ME.", "learner"]);
  assert(marked.dedupeKey.startsWith("work_marked:s3:"), "a re-mark is a new notification");
});

Deno.test("forms with a due date: 'Term return is due.' for those who haven't answered; overdue after", () => {
  const all = buildNotifications(world(), NOW);
  const [h1] = forWho(all, "h1", "form_due");
  assertEquals([h1.title, h1.severity, h1.link], ["Term return is due.", "action", "leader.html#overview"]);
  assertEquals(forWho(all, "h2", "form_due").length, 0, "already answered");
  assertEquals(forWho(all, "t1", "form_due").map((n) => n.title), ["Teacher survey is overdue."], "the one due on the 20th isn't close yet");
  assertEquals(forWho(all, "t1", "form_due")[0].dedupeKey, "form_due:f2:overdue");
});

Deno.test("field officer: 'Your ICT visit form is incomplete.' for a recent visit missing a form", () => {
  const w = world();
  assertEquals(missingVisitForms(w.fieldReports[0], w.forms, w.responses).map((f) => f.id), ["fv2"], "fv1 is filled; fv3 came after the visit");
  const all = buildNotifications(w, NOW);
  const mine = forWho(all, "fo", "visit_incomplete");
  assertEquals(mine.length, 1, "the Learning visit had no forms to fill; the old visit is past 30 days");
  assertEquals([mine[0].title, mine[0].link, mine[0].dedupeKey], ["Your ICT visit form is incomplete.", "field.html#visits", "visit_incomplete:v1"]);
  assert(mine[0].body.startsWith("Aitong Primary on Thu 1 Oct: Lab inventory."));
});

Deno.test("Kobo managers: '12 Kobo submissions received.' since they were last told", () => {
  const w = world();
  let all = buildNotifications(w, NOW);
  const [ed] = forWho(all, "ed", "kobo_received");
  assertEquals(ed.title, "12 Kobo submissions received.", "the one from two days ago is older than a day");
  assertEquals(ed.body, "Classroom observation: 10 · School infrastructure: 2 — 3 need review.");
  assertEquals(forWho(all, "ad", "kobo_received").length, 1, "admins manage Kobo too");
  assertEquals(forWho(all, "t1", "kobo_received").length, 0);
  w.koboLastNotified = { ed: "2026-10-03T05:40:00Z" };
  all = buildNotifications(w, NOW);
  assertEquals(forWho(all, "ed", "kobo_received")[0].title, "1 Kobo submission received.");
});

Deno.test("approvers: '2 staff accounts awaiting approval.' once a day", () => {
  const all = buildNotifications(world(), NOW);
  const [ad] = forWho(all, "ad", "accounts_pending");
  assertEquals([ad.title, ad.body, ad.dedupeKey], ["2 staff accounts awaiting approval.", "New Teacher, New Officer", "accounts_pending:2026-10-03"]);
  assertEquals(forWho(all, "ed", "accounts_pending").length, 0, "the Education Team can't approve");
});

Deno.test("one person's notifications only, and nothing twice within a run", () => {
  const all = buildNotifications(world(), NOW, "h1");
  assert(all.length > 0 && all.every((n) => n.recipientId === "h1"));
  const everyone = buildNotifications(world(), NOW);
  const keys = everyone.map((n) => `${n.recipientId}|${n.dedupeKey}`);
  assertEquals(new Set(keys).size, keys.length);
});
