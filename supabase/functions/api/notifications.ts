/**
 * Notifications — the rules, pure (no database). Each rule looks at the
 * portal's own rows and says who should be told what:
 *
 *   assignments_due   teacher, learner  "3 assignments are due tomorrow."
 *   to_mark           teacher           "5 pieces of work are waiting to be marked."
 *   work_marked       learner           "Your “Fractions quiz” was marked: 75%."
 *   form_due          staff it reaches  "Term return is due."  (forms with a due date)
 *   visit_incomplete  field officer     "Your ICT visit form is incomplete."
 *   kobo_received     Kobo managers     "12 Kobo submissions received."
 *   accounts_pending  approvers         "4 staff accounts awaiting approval."
 *
 * Every candidate carries a DEDUPE KEY: the same thing is never notified
 * twice to the same person (the database refuses a second row with that
 * key). Index.ts stores what's new; nothing here sends anything.
 */

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

export type Candidate = {
  recipientKind: "staff" | "learner";
  recipientId: string;
  kind: string;
  severity: "info" | "action" | "warning";
  title: string;
  body: string;
  link: string;
  data: Record<string, unknown>;
  dedupeKey: string;
};

export type NotifyInput = {
  profiles: Row[];        // id, role, status, county, school_id
  learners: Row[];        // id, class_id, enrollment_status
  classTeachers: Row[];   // class_id, teacher_id, ended_at
  classes: Row[];         // id, name
  assignments: Row[];     // id, class_id, title, status, due_at, created_by
  submissions: Row[];     // id, assignment_id, learner_id, status, submitted_at, marked_at, percentage, band
  forms: Row[];           // id, title, audience, county, visit_type, due_on, archived_at, created_at
  responses: Row[];       // form_id, respondent_id, visit_id
  fieldReports: Row[];    // id, officer_id, school, county, visit_type, created_at
  koboForms: Row[];       // id, title
  koboReceived: Row[];    // raw submissions recently received: id, kobo_form_id, received_at, needs_review
  koboLastNotified: Record<string, string>; // recipient → when they were last told about Kobo submissions
  /** may this person …? (their role's permissions plus any grants) */
  can: (person: Row, permission: string) => boolean;
};

/** Kenya time (EAT, UTC+3, no daylight saving): "tomorrow" is a Kenyan day. */
export const PORTAL_UTC_OFFSET_MIN = 180;
export function localDay(d: Date, offsetMin = PORTAL_UTC_OFFSET_MIN): string {
  return new Date(d.getTime() + offsetMin * 60_000).toISOString().slice(0, 10);
}
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const fmtDay = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (xs: string[], max = 4) => xs.length <= max ? xs.join(", ") : `${xs.slice(0, max).join(", ")} and ${xs.length - max} more`;

const PAGE: Record<string, string> = { teacher: "teacher.html", school_leader: "leader.html", field_officer: "field.html", learner: "learner.html" };
/** Each management role's own workspace (permissions.ts WORKSPACE). */
const WORKSPACE_PAGE: Record<string, string> = { super_admin: "platform.html", admin: "admin.html", me: "me.html", education_team: "education.html" };
const FORMS_PAGE: Record<string, string> = { teacher: "teacher.html#assignments", school_leader: "leader.html#overview", field_officer: "field.html#reports" };

/** A visit's forms that weren't filled in: the visit type's forms (for its
    county or every county) that existed at the visit, without a response
    for that visit. */
export function missingVisitForms(visit: Row, forms: Row[], responses: Row[]): Row[] {
  const done = new Set(responses.filter((r) => r.visit_id === visit.id).map((r) => r.form_id));
  return forms.filter((f) => f.visit_type && f.visit_type === visit.visit_type && !f.archived_at &&
    (!f.county || f.county === visit.county) && (!f.created_at || String(f.created_at) <= String(visit.created_at)) && !done.has(f.id));
}

export function buildNotifications(d: NotifyInput, now = new Date(), onlyRecipient: string | null = null): Candidate[] {
  const out: Candidate[] = [];
  const want = (id: string) => !onlyRecipient || id === onlyRecipient;
  const today = localDay(now);
  const tomorrow = addDays(today, 1);
  const staff = d.profiles.filter((p) => (p.status ?? "active") === "active");
  const className = new Map(d.classes.map((c) => [c.id, c.name]));
  const isTomorrow = (iso: unknown) => !!iso && localDay(new Date(String(iso))) === tomorrow;

  // ---- teachers: work due tomorrow in classes they teach (or set), and work waiting to be marked
  const openCT = d.classTeachers.filter((t) => !t.ended_at);
  for (const t of staff.filter((p) => p.role === "teacher" && want(p.id))) {
    const classes = new Set(openCT.filter((x) => x.teacher_id === t.id).map((x) => x.class_id));
    const mine = d.assignments.filter((a) => a.status === "published" && (classes.has(a.class_id) || a.created_by === t.id));
    const due = mine.filter((a) => isTomorrow(a.due_at));
    if (due.length) {
      out.push({
        recipientKind: "staff", recipientId: t.id, kind: "assignments_due", severity: "info",
        title: `${plural(due.length, "assignment")} ${due.length === 1 ? "is" : "are"} due tomorrow.`,
        body: list(due.map((a) => `${a.title}${className.get(a.class_id) ? ` (${className.get(a.class_id)})` : ""}`)),
        link: "teacher.html#assignments", data: { date: tomorrow, assignmentIds: due.map((a) => a.id) },
        dedupeKey: `assignments_due:${tomorrow}`,
      });
    }
    const ids = new Set(d.assignments.filter((a) => classes.has(a.class_id) || a.created_by === t.id).map((a) => a.id));
    const waiting = d.submissions.filter((s) => ids.has(s.assignment_id) && s.status === "submitted");
    const old = waiting.filter((s) => s.submitted_at && now.getTime() - Date.parse(s.submitted_at) > 3 * 864e5);
    if (old.length) {
      out.push({
        recipientKind: "staff", recipientId: t.id, kind: "to_mark", severity: "action",
        title: `${plural(waiting.length, "piece")} of work ${waiting.length === 1 ? "is" : "are"} waiting to be marked.`,
        body: `${old.length} ${old.length === 1 ? "has" : "have"} been waiting more than 3 days.`,
        link: "teacher.html#assignments", data: { waiting: waiting.length, overThreeDays: old.length },
        dedupeKey: `to_mark:${today}`,
      });
    }
  }

  // ---- learners: due tomorrow (not handed in yet), and work just marked
  for (const l of d.learners.filter((x) => (x.enrollment_status ?? "ACTIVE") === "ACTIVE" && want(x.id))) {
    const subs = new Map(d.submissions.filter((s) => s.learner_id === l.id).map((s) => [s.assignment_id, s]));
    const due = d.assignments.filter((a) => a.status === "published" && a.class_id === l.class_id && isTomorrow(a.due_at) &&
      (!subs.get(a.id) || subs.get(a.id)!.status === "in_progress"));
    if (due.length) {
      out.push({
        recipientKind: "learner", recipientId: l.id, kind: "assignments_due", severity: "info",
        title: `${plural(due.length, "assignment")} ${due.length === 1 ? "is" : "are"} due tomorrow.`,
        body: list(due.map((a) => a.title)), link: "learner.html#assignments",
        data: { date: tomorrow, assignmentIds: due.map((a) => a.id) }, dedupeKey: `assignments_due:${tomorrow}`,
      });
    }
    for (const s of subs.values()) {
      if (s.status !== "marked" || !s.marked_at || now.getTime() - Date.parse(s.marked_at) > 7 * 864e5) continue;
      const a = d.assignments.find((x) => x.id === s.assignment_id);
      out.push({
        recipientKind: "learner", recipientId: l.id, kind: "work_marked", severity: "info",
        title: `Your “${a?.title ?? "assignment"}” was marked${s.percentage != null ? `: ${Math.round(Number(s.percentage))}%` : ""}.`,
        body: s.band ? `Band: ${s.band}.` : "", link: "learner.html#assignments",
        data: { submissionId: s.id, assignmentId: s.assignment_id }, dedupeKey: `work_marked:${s.id}:${s.marked_at}`,
      });
    }
  }

  // ---- forms with a due date, for everyone they reach who hasn't answered
  for (const f of d.forms.filter((x) => !x.archived_at && !x.visit_type && x.due_on)) {
    const dueOn = String(f.due_on).slice(0, 10);
    const phase = today > dueOn ? "overdue" : addDays(today, 3) >= dueOn ? "soon" : null;
    if (!phase) continue;
    const answered = new Set(d.responses.filter((r) => r.form_id === f.id && !r.visit_id).map((r) => r.respondent_id));
    for (const p of staff.filter((x) => x.role === f.audience && (!f.county || x.county === f.county) && want(x.id) && !answered.has(x.id))) {
      out.push({
        recipientKind: "staff", recipientId: p.id, kind: "form_due", severity: phase === "overdue" ? "warning" : "action",
        title: phase === "overdue" ? `${f.title} is overdue.` : `${f.title} is due.`,
        body: `${phase === "overdue" ? "It was due" : "Due"} ${fmtDay(dueOn)}. Fill it in on the Forms list.`,
        link: FORMS_PAGE[p.role] ?? PAGE[p.role] ?? "index.html", data: { formId: f.id, dueOn },
        dedupeKey: `form_due:${f.id}:${phase}`,
      });
    }
  }

  // ---- field officers: visits filed without all their forms (last 30 days)
  for (const v of d.fieldReports) {
    if (!v.officer_id || !want(v.officer_id) || now.getTime() - Date.parse(v.created_at) > 30 * 864e5) continue;
    const officer = staff.find((p) => p.id === v.officer_id && p.role === "field_officer");
    if (!officer) continue;
    const missing = missingVisitForms(v, d.forms, d.responses);
    if (!missing.length) continue;
    out.push({
      recipientKind: "staff", recipientId: officer.id, kind: "visit_incomplete", severity: "action",
      title: `Your ${v.visit_type} visit ${missing.length === 1 ? "form is" : "forms are"} incomplete.`,
      body: `${v.school} on ${fmtDay(localDay(new Date(v.created_at)))}: ${list(missing.map((f) => f.title))}. Open the visit to finish ${missing.length === 1 ? "it" : "them"}.`,
      link: "field.html#visits", data: { visitId: v.id, formIds: missing.map((f) => f.id) },
      dedupeKey: `visit_incomplete:${v.id}`,
    });
  }

  // ---- Kobo managers: submissions received since they were last told
  const koboTitle = new Map(d.koboForms.map((f) => [f.id, f.title]));
  for (const p of staff.filter((x) => d.can(x, "kobo.review") && want(x.id))) {
    const since = d.koboLastNotified[p.id] ?? new Date(now.getTime() - 864e5).toISOString();
    const fresh = d.koboReceived.filter((r) => String(r.received_at) > since);
    if (!fresh.length) continue;
    const by = new Map<string, number>();
    for (const r of fresh) by.set(r.kobo_form_id, (by.get(r.kobo_form_id) ?? 0) + 1);
    const review = fresh.filter((r) => r.needs_review).length;
    const latest = fresh.map((r) => String(r.received_at)).sort().at(-1)!;
    out.push({
      recipientKind: "staff", recipientId: p.id, kind: "kobo_received", severity: review ? "action" : "info",
      title: `${plural(fresh.length, "Kobo submission")} received.`,
      body: [...by.entries()].map(([id, n]) => `${koboTitle.get(id) ?? "A survey"}: ${n}`).join(" · ") + (review ? ` — ${review} need${review === 1 ? "s" : ""} review.` : "."),
      link: `${WORKSPACE_PAGE[p.role] ?? "index.html"}#kobo`, data: { count: fresh.length, needsReview: review, since, until: latest },
      dedupeKey: `kobo_received:${latest}`,
    });
  }

  // ---- approvers: accounts waiting for approval (once a day while there are any)
  const pending = d.profiles.filter((p) => p.status === "pending");
  if (pending.length) {
    for (const p of staff.filter((x) => d.can(x, "users.approve") && want(x.id))) {
      out.push({
        recipientKind: "staff", recipientId: p.id, kind: "accounts_pending", severity: "action",
        title: `${plural(pending.length, "staff account")} awaiting approval.`,
        body: list(pending.map((x) => x.full_name || x.email || "Someone")),
        link: `${WORKSPACE_PAGE[p.role] ?? "index.html"}#users`, data: { profileIds: pending.map((x) => x.id) },
        dedupeKey: `accounts_pending:${today}`,
      });
    }
  }
  return out;
}
