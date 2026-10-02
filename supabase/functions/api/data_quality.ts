/**
 * The Data Quality Center's checks — pure, no database access.
 *
 * detectAll() looks at a snapshot of the portal's records and returns every
 * problem it finds, each with a STABLE key (the same problem found again
 * gets the same key, so its history, status and first-detected date carry
 * over between scans), the record(s) it affects, and where it is (school,
 * county). It also counts how many records each check looked at, for the
 * quality score. Nothing here changes or deletes anything.
 */

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

export const SEVERITIES = ["HIGH", "MEDIUM", "LOW"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const STATUSES = ["OPEN", "UNDER_REVIEW", "RESOLVED", "IGNORED"] as const;
export type DqStatus = (typeof STATUSES)[number];

export const ISSUE_TYPES = {
  duplicate_learner: { label: "Duplicate learner records", severity: "MEDIUM" },
  duplicate_staff: { label: "Duplicate staff records", severity: "MEDIUM" },
  missing_school: { label: "Missing school", severity: "HIGH" },
  missing_county: { label: "Missing county", severity: "MEDIUM" },
  school_county_mismatch: { label: "Invalid school / county combination", severity: "HIGH" },
  missing_grade: { label: "Missing grade", severity: "MEDIUM" },
  invalid_grade: { label: "Invalid grade", severity: "MEDIUM" },
  duplicate_kobo_submission: { label: "Duplicate Kobo submissions", severity: "MEDIUM" },
  unmatched_kobo_officer: { label: "Unmatched Kobo officer references", severity: "MEDIUM" },
  missing_kobo_required: { label: "Missing required Kobo fields", severity: "MEDIUM" },
  orphaned_record: { label: "Orphaned records", severity: "HIGH" },
  invalid_date: { label: "Invalid dates", severity: "MEDIUM" },
  inactive_user_active_assignment: { label: "Inactive users with active assignments", severity: "HIGH" },
  learner_without_class: { label: "Learners without a class", severity: "LOW" },
  staff_without_school: { label: "Teachers / school heads without a school", severity: "HIGH" },
} as const satisfies Record<string, { label: string; severity: Severity }>;
export type IssueType = keyof typeof ISSUE_TYPES;
export const ISSUE_TYPE_IDS = Object.keys(ISSUE_TYPES) as IssueType[];
export const SEVERITY_WEIGHT: Record<Severity, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };

export type EntityRef = { type: string; id: string; label: string };
export type DetectedIssue = {
  key: string;
  type: IssueType;
  severity: Severity;
  kind: string;                 // the specific case, e.g. "no_active_enrollment"
  summary: string;
  entity: EntityRef;            // the record to look at first
  related: EntityRef[];         // the other records involved (e.g. the duplicates)
  schoolId: string | null;
  county: string | null;
  details: Record<string, unknown>;
};
export type Snapshot = {
  schools: Row[]; counties: Row[]; profiles: Row[]; learners: Row[]; enrollments: Row[];
  classes: Row[]; classTeachers: Row[]; assignments: Row[]; terms: Row[];
  fieldReports: Row[]; koboRecords: Row[]; koboIssues: Row[]; koboForms: Row[];
  libraryItems: Row[]; libraryInteractions: Row[];
  grades: readonly string[];
};
/** How many records each check looked at, by school ("" = no school). */
export type Checked = Record<IssueType, Record<string, number>>;

const blank = (v: unknown) => v == null || String(v).trim() === "";
export const nameKey = (v: unknown) => String(v ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "")
  .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const day = (v: unknown) => String(v ?? "").slice(0, 10);
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

export function detectAll(s: Snapshot, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const school = new Map(s.schools.map((x) => [x.id, x]));
  const countyNames = new Set(s.counties.map((c) => c.name));
  const profile = new Map(s.profiles.map((p) => [p.id, p]));
  const cls = new Map(s.classes.map((c) => [c.id, c]));
  const libItems = new Set(s.libraryItems.map((i) => i.id));
  const koboForm = new Map(s.koboForms.map((f) => [f.id, f]));
  const issues: DetectedIssue[] = [];
  const checked = Object.fromEntries(ISSUE_TYPE_IDS.map((t) => [t, {}])) as Checked;
  const count = (type: IssueType, schoolId: unknown) => {
    const k = String(schoolId ?? "");
    checked[type][k] = (checked[type][k] ?? 0) + 1;
  };
  const where = (schoolId: unknown, county?: unknown) => ({
    schoolId: (schoolId as string) || null,
    county: (school.get(schoolId)?.county as string) || (county as string) || null,
  });
  const add = (type: IssueType, kind: string, key: string, summary: string, entity: EntityRef,
    loc: { schoolId: string | null; county: string | null }, extra: Partial<DetectedIssue> = {}) => {
    issues.push({
      key: `${type}:${key}`, type, kind, severity: extra.severity ?? ISSUE_TYPES[type].severity, summary, entity,
      related: extra.related ?? [], ...loc, details: extra.details ?? {},
    });
  };
  const learnerRef = (l: Row): EntityRef => ({ type: "learner", id: l.id, label: `${l.full_name || "Unnamed learner"}${l.learner_code || l.user_code ? ` (${l.learner_code || l.user_code})` : ""}` });
  const profileRef = (p: Row): EntityRef => ({ type: "profile", id: p.id, label: `${p.full_name || "Unnamed"}${p.email ? ` <${p.email}>` : ""}` });
  const schoolLabel = (id: unknown) => school.get(id)?.name ?? "no school";

  const activeLearners = s.learners.filter((l) => (l.enrollment_status ?? "ACTIVE") === "ACTIVE");
  const liveStaff = s.profiles.filter((p) => !["rejected", "deactivated"].includes(p.status ?? "active"));

  // 1. Duplicate learner records: the same name twice among a school's active
  //    learners. (Archiving one copy — never deleting — settles it.)
  for (const l of activeLearners) count("duplicate_learner", l.school_id);
  const byName = new Map<string, Row[]>();
  for (const l of activeLearners) {
    const k = nameKey(l.full_name);
    if (!k) continue;
    const g = `${l.school_id ?? ""}|${k}`;
    if (!byName.has(g)) byName.set(g, []);
    byName.get(g)!.push(l);
  }
  for (const [g, list] of byName) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")) || String(a.id).localeCompare(String(b.id)));
    add("duplicate_learner", "same_name_same_school", g,
      `${sorted.length} active learner records named “${sorted[0].full_name}” at ${schoolLabel(sorted[0].school_id)}`,
      learnerRef(sorted[0]), where(sorted[0].school_id),
      { related: sorted.slice(1).map(learnerRef), details: { learnerIds: sorted.map((l) => l.id), grades: sorted.map((l) => l.grade ?? null) } });
  }

  // 2. Duplicate staff records: the same name, or an email one letter apart.
  for (const p of s.profiles) count("duplicate_staff", p.school_id);
  const staffByName = new Map<string, Row[]>();
  for (const p of liveStaff) {
    const k = nameKey(p.full_name);
    if (k.length < 3) continue;
    if (!staffByName.has(k)) staffByName.set(k, []);
    staffByName.get(k)!.push(p);
  }
  const grouped = new Set<string>();
  for (const [k, list] of staffByName) {
    if (list.length < 2) continue;
    const ids = list.map((p) => p.id).sort();
    ids.forEach((id) => grouped.add(id));
    add("duplicate_staff", "same_name", `name:${k}`, `${list.length} staff accounts named “${list[0].full_name}”`,
      profileRef(list[0]), where(list[0].school_id, list[0].county), { related: list.slice(1).map(profileRef), details: { profileIds: ids } });
  }
  const emails = liveStaff.filter((p) => p.email && String(p.email).includes("@"));
  for (let i = 0; i < emails.length; i++) {
    for (let j = i + 1; j < emails.length; j++) {
      const [la, da] = String(emails[i].email).toLowerCase().split("@");
      const [lb, db] = String(emails[j].email).toLowerCase().split("@");
      if (da !== db || la === lb || Math.min(la.length, lb.length) < 4 || editDistance(la, lb) > 1) continue;
      if (grouped.has(emails[i].id) && grouped.has(emails[j].id)) continue;
      const pair = [emails[i], emails[j]].sort((a, b) => String(a.id).localeCompare(String(b.id)));
      add("duplicate_staff", "similar_email", `email:${pair[0].id}|${pair[1].id}`,
        `Two staff accounts with nearly the same email: ${pair[0].email} and ${pair[1].email}`,
        profileRef(pair[0]), where(pair[0].school_id, pair[0].county), { related: [profileRef(pair[1])], details: { profileIds: pair.map((p) => p.id) } });
    }
  }

  // 3. Missing school (learners, field visits, Kobo submissions; staff are check 15).
  for (const l of activeLearners) {
    count("missing_school", l.school_id);
    if (!l.school_id) add("missing_school", "learner", `learner:${l.id}`, `${l.full_name} isn't in any school`, learnerRef(l), where(null, l.county));
  }
  for (const r of s.fieldReports) {
    count("missing_school", r.school_id);
    if (!r.school_id) {
      const kind = r.visit_type ? `${/^[aeiou]/i.test(r.visit_type) ? "An" : "A"} ${r.visit_type} visit` : "A field visit";
      add("missing_school", "field_visit", `visit:${r.id}`, `${kind} to “${r.school || "?"}” isn't linked to a school record`,
        { type: "field_report", id: r.id, label: `${r.visit_type || "Visit"} · ${r.school || "?"} · ${day(r.created_at)}` }, where(null, r.county),
        { severity: "MEDIUM", details: { school: r.school } });
    }
  }
  const koboLive = s.koboRecords.filter((r) => r.status !== "removed" && r.status !== "rejected" && r.review !== "excluded" && koboForm.get(r.kobo_form_id)?.active !== false);
  const koboIssuesOf = new Map<string, Row[]>();
  for (const i of s.koboIssues) {
    if (!koboIssuesOf.has(i.record_id)) koboIssuesOf.set(i.record_id, []);
    koboIssuesOf.get(i.record_id)!.push(i);
  }
  const koboRef = (r: Row): EntityRef => ({ type: "kobo_record", id: r.id, label: `${koboForm.get(r.kobo_form_id)?.title ?? "Kobo survey"} #${r.kobo_id}` });
  for (const r of koboLive) {
    count("missing_school", r.school_id);
    const schoolErr = (koboIssuesOf.get(r.id) ?? []).find((i) => i.rule === "school" && i.severity === "error");
    if (schoolErr && !r.review) {
      add("missing_school", "kobo", `kobo:${r.id}`, schoolErr.message, koboRef(r), where(null, r.county), { details: { value: r.school_value ?? null } });
    }
  }

  // 4. Missing county.
  for (const sc of s.schools) {
    count("missing_county", sc.id);
    if (blank(sc.county)) add("missing_county", "school", `school:${sc.id}`, `${sc.name} has no county`, { type: "school", id: sc.id, label: `${sc.name} (${sc.code})` }, { schoolId: sc.id, county: null });
  }
  for (const p of liveStaff.filter((p) => p.role === "field_officer")) {
    count("missing_county", "");
    if (blank(p.county)) add("missing_county", "field_officer", `profile:${p.id}`, `Field officer ${p.full_name} has no county`, profileRef(p), { schoolId: null, county: null });
  }
  for (const l of activeLearners.filter((l) => l.school_id)) {
    count("missing_county", l.school_id);
    if (blank(l.county)) add("missing_county", "learner", `learner:${l.id}`, `${l.full_name} has a school but no county`, learnerRef(l), where(l.school_id), { severity: "LOW" });
  }
  for (const r of s.fieldReports) {
    count("missing_county", r.school_id);
    if (blank(r.county)) add("missing_county", "field_visit", `visit:${r.id}`, `A visit to “${r.school || "?"}” has no county`,
      { type: "field_report", id: r.id, label: `${r.visit_type || "Visit"} · ${r.school || "?"} · ${day(r.created_at)}` }, where(r.school_id));
  }

  // 5. Invalid school / county combinations.
  for (const sc of s.schools) {
    count("school_county_mismatch", sc.id);
    if (!blank(sc.county) && countyNames.size && !countyNames.has(sc.county)) {
      add("school_county_mismatch", "unknown_county", `school:${sc.id}`, `${sc.name} is in “${sc.county}”, which isn't one of the portal's counties`,
        { type: "school", id: sc.id, label: `${sc.name} (${sc.code})` }, { schoolId: sc.id, county: sc.county });
    }
  }
  const mismatch = (rowCounty: unknown, schoolId: unknown) => {
    const sc = school.get(schoolId);
    return sc && !blank(rowCounty) && !blank(sc.county) && rowCounty !== sc.county ? sc : null;
  };
  for (const p of liveStaff.filter((p) => p.school_id)) {
    count("school_county_mismatch", p.school_id);
    const sc = mismatch(p.county, p.school_id);
    if (sc) add("school_county_mismatch", "profile", `profile:${p.id}`, `${p.full_name} is at ${sc.name} (${sc.county}) but recorded in ${p.county}`,
      profileRef(p), where(p.school_id), { details: { recorded: p.county, expected: sc.county } });
  }
  for (const l of activeLearners.filter((l) => l.school_id)) {
    count("school_county_mismatch", l.school_id);
    const sc = mismatch(l.county, l.school_id);
    if (sc) add("school_county_mismatch", "learner", `learner:${l.id}`, `${l.full_name} is at ${sc.name} (${sc.county}) but recorded in ${l.county}`,
      learnerRef(l), where(l.school_id), { details: { recorded: l.county, expected: sc.county } });
  }
  for (const r of s.fieldReports.filter((r) => r.school_id)) {
    count("school_county_mismatch", r.school_id);
    const sc = mismatch(r.county, r.school_id);
    if (sc) add("school_county_mismatch", "field_visit", `visit:${r.id}`, `A visit to ${sc.name} (${sc.county}) is recorded in ${r.county}`,
      { type: "field_report", id: r.id, label: `${r.visit_type || "Visit"} · ${sc.name} · ${day(r.created_at)}` }, where(r.school_id),
      { details: { recorded: r.county, expected: sc.county } });
  }
  for (const r of koboLive) {
    count("school_county_mismatch", r.school_id);
    const err = (koboIssuesOf.get(r.id) ?? []).find((i) => i.rule === "county" && i.severity === "error");
    if (err && !r.review) add("school_county_mismatch", "kobo", `kobo:${r.id}`, err.message, koboRef(r), where(r.school_id, r.county));
  }

  // 6–7. Grades: missing, not a portal grade, or not the learner's class grade.
  const liveClass = (l: Row) => {
    const c = cls.get(l.class_id);
    return c && !c.archived_at && c.school_id === l.school_id ? c : null;
  };
  for (const l of activeLearners) {
    count("missing_grade", l.school_id);
    count("invalid_grade", l.school_id);
    if (blank(l.grade)) {
      add("missing_grade", "learner", `learner:${l.id}`, `${l.full_name} has no grade`, learnerRef(l), where(l.school_id),
        { details: { classGrade: cls.get(l.class_id)?.grade ?? null } });
      continue;
    }
    if (!s.grades.includes(String(l.grade))) {
      add("invalid_grade", "not_a_grade", `learner:${l.id}`, `${l.full_name}'s grade “${l.grade}” isn't one of the portal's grades`,
        learnerRef(l), where(l.school_id), { details: { grade: l.grade, classGrade: cls.get(l.class_id)?.grade ?? null } });
    } else if (liveClass(l) && liveClass(l)!.grade !== l.grade) {
      // (A class that's archived or elsewhere is an orphan — check 11 — not this.)
      const c = liveClass(l)!;
      add("invalid_grade", "class_mismatch", `learner:${l.id}`, `${l.full_name} is recorded in ${l.grade} but is in ${c.name} (${c.grade})`,
        learnerRef(l), where(l.school_id), { severity: "LOW", details: { grade: l.grade, classGrade: c.grade } });
    }
  }

  // 8–10. Kobo: duplicates, unmatched officers, required fields — those
  // nobody has decided on yet in the Kobo data pipeline.
  for (const r of koboLive) {
    count("duplicate_kobo_submission", r.school_id);
    count("unmatched_kobo_officer", r.school_id);
    count("missing_kobo_required", r.school_id);
    if (r.review) continue;
    const mine = koboIssuesOf.get(r.id) ?? [];
    if (r.status === "duplicate") {
      add("duplicate_kobo_submission", "copy", `kobo:${r.id}`, mine.find((i) => i.rule === "duplicate")?.message ?? "Sent twice", koboRef(r), where(r.school_id, r.county));
    }
    const officer = mine.find((i) => i.rule === "officer" && i.severity === "error");
    if (officer) add("unmatched_kobo_officer", "officer", `kobo:${r.id}`, officer.message, koboRef(r), where(r.school_id, r.county));
    const required = mine.filter((i) => i.rule === "required");
    if (required.length) {
      add("missing_kobo_required", "required", `kobo:${r.id}`, required.length === 1 ? required[0].message : `${required.length} required answers are empty`,
        koboRef(r), where(r.school_id, r.county), { details: { fields: required.map((i) => i.field) } });
    }
  }

  // 11. Orphaned records: links that point at nothing, or at something gone.
  const activeEnr = new Map<string, Row>();
  for (const e of s.enrollments) if (e.status === "ACTIVE") activeEnr.set(e.learner_id, e);
  for (const l of s.learners) {
    count("orphaned_record", l.school_id);
    const active = (l.enrollment_status ?? "ACTIVE") === "ACTIVE";
    if (active && !activeEnr.has(l.id)) {
      add("orphaned_record", "no_active_enrollment", `learner:${l.id}`, `${l.full_name} is active but has no current enrollment record`, learnerRef(l), where(l.school_id));
    }
    if (!active && activeEnr.has(l.id)) {
      add("orphaned_record", "stale_enrollment", `enrollment:${activeEnr.get(l.id)!.id}`, `${l.full_name} has left (${String(l.enrollment_status).toLowerCase().replace("_", " ")}) but their enrollment is still open`,
        learnerRef(l), where(l.school_id), { details: { enrollmentId: activeEnr.get(l.id)!.id } });
    }
    if (active && l.class_id) {
      const c = cls.get(l.class_id);
      if (!c || c.archived_at || c.school_id !== l.school_id) {
        add("orphaned_record", "class_gone", `learner_class:${l.id}`, `${l.full_name} is in a class that is ${!c ? "missing" : c.archived_at ? "archived" : "in another school"}`,
          learnerRef(l), where(l.school_id), { details: { classId: l.class_id } });
      }
    }
    if (active && l.current_teacher_id && !profile.has(l.current_teacher_id)) {
      add("orphaned_record", "teacher_gone", `learner_teacher:${l.id}`, `${l.full_name}'s current teacher account no longer exists`, learnerRef(l), where(l.school_id));
    }
  }
  for (const t of s.classTeachers.filter((t) => !t.ended_at)) {
    const c = cls.get(t.class_id);
    count("orphaned_record", c?.school_id);
    if (!c || c.archived_at) {
      const p = profile.get(t.teacher_id);
      add("orphaned_record", "archived_class_teacher", `class_teacher:${t.id}`, `${p?.full_name ?? "A teacher"} is still assigned to ${c ? `${c.name}, which is archived` : "a class that no longer exists"}`,
        { type: "class_teacher", id: t.id, label: `${p?.full_name ?? "Teacher"} → ${c?.name ?? "missing class"}` }, where(c?.school_id),
        { details: { classId: t.class_id, teacherId: t.teacher_id } });
    }
  }
  const lostItems = new Map<string, Row[]>();
  for (const i of s.libraryInteractions) {
    count("orphaned_record", "");
    if (!libItems.has(i.library_item_id)) {
      if (!lostItems.has(i.library_item_id)) lostItems.set(i.library_item_id, []);
      lostItems.get(i.library_item_id)!.push(i);
    }
  }
  for (const [itemId, list] of lostItems) {
    add("orphaned_record", "library_item_gone", `library_item:${itemId}`, `${list.length} library reading session${list.length === 1 ? "" : "s"} point to a resource that was deleted`,
      { type: "library_item", id: itemId, label: `Deleted resource ${itemId}` }, { schoolId: null, county: null }, { severity: "LOW", details: { sessions: list.length } });
  }

  // 12. Invalid dates.
  const learnerById = new Map(s.learners.map((l) => [l.id, l]));
  for (const e of s.enrollments) {
    const l = learnerById.get(e.learner_id);
    count("invalid_date", e.school_id);
    if (e.exit_date && e.enrollment_date && day(e.exit_date) < day(e.enrollment_date)) {
      add("invalid_date", "enrollment_exit_before_start", `enrollment:${e.id}`, `${l?.full_name ?? "A learner"} left (${day(e.exit_date)}) before they enrolled (${day(e.enrollment_date)})`,
        l ? learnerRef(l) : { type: "enrollment", id: e.id, label: e.id }, where(e.school_id), { details: { enrollmentId: e.id } });
    } else if (e.enrollment_date && day(e.enrollment_date) > today) {
      add("invalid_date", "enrollment_in_future", `enrollment:${e.id}`, `${l?.full_name ?? "A learner"}'s enrollment starts in the future (${day(e.enrollment_date)})`,
        l ? learnerRef(l) : { type: "enrollment", id: e.id, label: e.id }, where(e.school_id), { details: { enrollmentId: e.id } });
    }
  }
  for (const t of s.terms) {
    count("invalid_date", "");
    if (t.ends_on && t.starts_on && day(t.ends_on) < day(t.starts_on)) {
      add("invalid_date", "term_ends_before_start", `term:${t.id}`, `Term ${t.id} ends before it starts`, { type: "term", id: t.id, label: t.id }, { schoolId: null, county: null }, { severity: "HIGH" });
    } else if (t.academic_year_id && !String(t.starts_on ?? "").startsWith(String(t.academic_year_id))) {
      add("invalid_date", "term_outside_year", `term:${t.id}`, `Term ${t.id} starts outside its school year`, { type: "term", id: t.id, label: t.id }, { schoolId: null, county: null });
    }
  }
  for (const r of koboLive) {
    count("invalid_date", r.school_id);
    const err = (koboIssuesOf.get(r.id) ?? []).find((i) => i.rule === "date" && i.severity === "error");
    if (err && !r.review) add("invalid_date", "kobo", `kobo:${r.id}`, err.message, koboRef(r), where(r.school_id, r.county));
  }

  // 13. Inactive users with active assignments: classes and work with nobody behind them.
  for (const t of s.classTeachers.filter((t) => !t.ended_at)) {
    const c = cls.get(t.class_id);
    if (!c || c.archived_at) continue; // that's an orphan (check 11)
    count("inactive_user_active_assignment", c.school_id);
    const p = profile.get(t.teacher_id);
    const status = p?.status ?? "missing";
    if (!p || status !== "active") {
      add("inactive_user_active_assignment", "class_teacher", `class_teacher:${t.id}`,
        `${p?.full_name ?? "A deleted account"} (${status}) is still ${t.role === "class_teacher" ? "class teacher of" : "teaching"} ${c.name}`,
        { type: "class_teacher", id: t.id, label: `${p?.full_name ?? "Teacher"} → ${c.name}` }, where(c.school_id),
        { related: p ? [profileRef(p)] : [], details: { classId: c.id, teacherId: t.teacher_id, status } });
    }
  }
  const teachingNow = new Map<string, Set<string>>();
  for (const t of s.classTeachers.filter((t) => !t.ended_at && (profile.get(t.teacher_id)?.status ?? "") === "active")) {
    if (!teachingNow.has(t.class_id)) teachingNow.set(t.class_id, new Set());
    teachingNow.get(t.class_id)!.add(t.teacher_id);
  }
  for (const a of s.assignments.filter((a) => a.status === "published")) {
    count("inactive_user_active_assignment", a.school_id);
    const p = profile.get(a.created_by);
    if ((p?.status ?? "missing") !== "active" && !teachingNow.get(a.class_id)?.size) {
      add("inactive_user_active_assignment", "assignment_owner", `assignment:${a.id}`,
        `“${a.title}” is open, but its teacher (${p?.full_name ?? "a deleted account"}) is ${p?.status ?? "gone"} and the class has no active teacher to mark it`,
        { type: "assignment", id: a.id, label: a.title }, where(a.school_id), { related: p ? [profileRef(p)] : [] });
    }
  }

  // 14. Learners without a class.
  for (const l of activeLearners) {
    count("learner_without_class", l.school_id);
    if (!l.class_id) add("learner_without_class", "learner", `learner:${l.id}`, `${l.full_name} isn't in a class`, learnerRef(l), where(l.school_id));
  }

  // 15. Teachers and school heads without a school (it's required for them).
  for (const p of liveStaff.filter((p) => p.role === "teacher" || p.role === "school_leader")) {
    count("staff_without_school", p.school_id);
    if (!p.school_id) {
      add("staff_without_school", p.role, `profile:${p.id}`, `${p.role === "teacher" ? "Teacher" : "School head"} ${p.full_name} has no school`,
        profileRef(p), { schoolId: null, county: (p.county as string) || null }, { details: { status: p.status ?? "active" } });
    }
  }

  return { issues, checked };
}

/** Records checked by each check, within a set of schools (null = all). */
export function checkedIn(checked: Checked, schoolIds: Set<string> | null): Record<IssueType, number> {
  return Object.fromEntries(ISSUE_TYPE_IDS.map((t) => [t,
    Object.entries(checked[t] ?? {}).reduce((sum, [k, n]) => (!schoolIds || schoolIds.has(k) ? sum + n : sum), 0),
  ])) as Record<IssueType, number>;
}

/** The data quality score, 0–100: each check's pass rate (records without
    an OPEN or UNDER_REVIEW issue), weighted by how serious the check is.
    IGNORED and RESOLVED issues don't count against it. */
export function qualityScore(checked: Record<IssueType, number>, openByType: Partial<Record<IssueType, number>>) {
  let num = 0, den = 0;
  const perType = ISSUE_TYPE_IDS.map((t) => {
    const n = checked[t] ?? 0;
    const open = openByType[t] ?? 0;
    const pass = n ? Math.max(0, 1 - Math.min(n, open) / n) : null;
    if (pass != null) {
      const w = SEVERITY_WEIGHT[ISSUE_TYPES[t].severity];
      num += w * pass;
      den += w;
    }
    return { type: t, checked: n, open, passRate: pass == null ? null : Math.round(pass * 1000) / 10 };
  });
  const score = den ? Math.round((num / den) * 1000) / 10 : 100;
  return { score, label: score >= 90 ? "Good" : score >= 75 ? "Fair" : "Needs attention", perType };
}

/** Which status changes a person may make. */
export const STATUS_MOVES: Record<DqStatus, DqStatus[]> = {
  OPEN: ["UNDER_REVIEW", "RESOLVED", "IGNORED"],
  UNDER_REVIEW: ["OPEN", "RESOLVED", "IGNORED"],
  RESOLVED: ["OPEN"],
  IGNORED: ["OPEN"],
};
