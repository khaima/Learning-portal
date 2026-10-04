/**
 * Data scope — which counties and schools a person's data is limited to.
 *
 * Pure (no database), so the rules are unit-tested on their own
 * (scope_test.ts) and index.ts applies the same answer everywhere: lists,
 * dashboards, exports and every change.
 *
 *   SUPER_ADMIN            global, always
 *   ADMIN, M&E,
 *   EDUCATION_TEAM         global — or, once given any assignment, only the
 *                          counties / schools assigned to them
 *   FIELD_OFFICER          only the counties / schools assigned to them
 *                          (nothing until assigned)
 *   SCHOOL_HEAD, TEACHER   their own school (a teacher is further limited to
 *                          the classes they teach, elsewhere)
 *   LEARNER                their own school (and only their own records,
 *                          elsewhere)
 *
 * Assignments live in `staff_scopes`: a county (every school in it, now and
 * later) or one school. Ended assignments are kept and ignored here.
 */

export type ScopeRow = {
  scope_type: string;
  county?: string | null;
  school_id?: string | null;
  ended_at?: string | null;
};
export type SchoolRow = { id: string; name?: string; county?: string | null };

export type PlaceScope =
  | { global: true; label: string }
  | {
    global: false;
    /** Every school the person may see, including the schools of whole counties. */
    schoolIds: Set<string>;
    /** Counties assigned whole (lower case), for records that carry only a county. */
    counties: Set<string>;
    /** Counties with at least one school in scope (lower case) — for county-wide things like forms. */
    areaCounties: Set<string>;
    label: string;
  };

/** Roles whose data can be narrowed with assignments. */
export const ASSIGNABLE_ROLES = ["admin", "me", "education_team", "field_officer"] as const;
/** Of those, the ones that see everything until narrowed. */
const GLOBAL_UNTIL_ASSIGNED = new Set(["admin", "me", "education_team"]);

const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();

export function placeScopeFor(
  actor: { role: string; schoolId?: string | null; school?: string | null },
  rows: ScopeRow[],
  schools: SchoolRow[],
): PlaceScope {
  const role = actor.role;
  if (role === "super_admin") return { global: true, label: "All counties and schools" };
  if (role === "school_leader" || role === "teacher" || role === "learner") {
    const id = actor.schoolId ?? null;
    const name = schools.find((x) => x.id === id)?.name ?? actor.school ?? null;
    const county = schools.find((x) => x.id === id)?.county;
    return { global: false, schoolIds: new Set(id ? [id] : []), counties: new Set(), areaCounties: new Set(county ? [norm(county)] : []), label: id ? name || "Your school" : "No school yet" };
  }
  const open = rows.filter((r) => !r.ended_at);
  if (!open.length && GLOBAL_UNTIL_ASSIGNED.has(role)) return { global: true, label: "All counties and schools" };
  const counties = new Set(open.filter((r) => r.scope_type === "county" && r.county).map((r) => norm(r.county)));
  const schoolIds = new Set(open.filter((r) => r.scope_type === "school" && r.school_id).map((r) => String(r.school_id)));
  for (const s of schools) if (counties.has(norm(s.county))) schoolIds.add(s.id);
  const areaCounties = new Set(counties);
  for (const s of schools) if (schoolIds.has(s.id) && s.county) areaCounties.add(norm(s.county));
  return { global: false, schoolIds, counties, areaCounties, label: scopeLabel(open, schools) };
}

/** "Narok County", "Narok County and 2 schools", "3 schools", "No schools assigned yet". */
export function scopeLabel(open: ScopeRow[], schools: SchoolRow[]): string {
  const countyNames = [...new Set(open.filter((r) => r.scope_type === "county" && r.county).map((r) => String(r.county)))].sort();
  const schoolRows = open.filter((r) => r.scope_type === "school" && r.school_id);
  const parts: string[] = [];
  if (countyNames.length) parts.push(countyNames.length === 1 ? `${countyNames[0]} County` : `${countyNames.join(", ")} counties`);
  if (schoolRows.length) {
    const one = schoolRows.length === 1 ? schools.find((s) => s.id === schoolRows[0].school_id)?.name : null;
    parts.push(one ?? `${schoolRows.length} school${schoolRows.length === 1 ? "" : "s"}`);
  }
  return parts.length ? parts.join(" and ") : "No schools assigned yet";
}

/** Is a record — known by its school and/or its county — inside the scope?
    A record with a school is judged by the school; one with only a county
    (an older visit, a Kobo submission not matched to a school) by whether
    that whole county is assigned. */
export function inPlaceScope(scope: PlaceScope, schoolId?: unknown, county?: unknown): boolean {
  if (scope.global) return true;
  if (schoolId) return scope.schoolIds.has(String(schoolId));
  return !!county && scope.counties.has(norm(county));
}

/** The counties that have at least one school in scope (for pickers). */
export function countiesInScope(scope: PlaceScope, schools: SchoolRow[], counties: string[]): string[] {
  if (scope.global) return counties;
  const seen = new Set(schools.filter((s) => scope.schoolIds.has(s.id)).map((s) => norm(s.county)));
  for (const c of scope.counties) seen.add(c);
  return counties.filter((c) => seen.has(norm(c)));
}

/** A field officer's old free-text county → a county in the list, matched
    exactly but for letter case; null when there's no such county. */
export function matchCounty(text: unknown, counties: string[]): string | null {
  const t = norm(text);
  if (!t) return null;
  return counties.find((c) => norm(c) === t) ?? null;
}

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

/** The programme-wide dashboard input (intelligence.ts / impact.ts), cut
    down to one person's scope before anything is counted — so a total, an
    average or a "not yet visited" list never includes a school they can't
    see. Reference data (terms, subjects, the library, Kobo surveys,
    grade bands) is kept whole. */
export function narrowInput<T extends Row>(d: T, scope: PlaceScope): T {
  if (scope.global) return d;
  const keep = (schoolId: unknown, county?: unknown) => inPlaceScope(scope, schoolId, county);
  const rows = (k: string): Row[] => (Array.isArray(d[k]) ? d[k] : []);
  const schools = rows("schools").filter((s) => keep(s.id));
  const schoolNames = new Set(schools.map((s) => s.name));
  // People in the area: anyone placed at a school in scope, and field
  // officers whose county is assigned whole. Programme staff without a
  // place (Education Team, M&E, administrators) aren't part of any area.
  const profiles = rows("profiles").filter((p) => p.school_id ? keep(p.school_id) : p.role === "field_officer" && keep(null, p.county));
  const people = new Set(profiles.map((p) => p.id));
  const classes = rows("classes").filter((x) => keep(x.school_id));
  const classIds = new Set(classes.map((x) => x.id));
  const records = rows("koboRecords").filter((r) => keep(r.school_id, r.county));
  const recordIds = new Set(records.map((r) => r.id));
  const trainings = rows("trainings").filter((t) => t.school_id ? keep(t.school_id) : keep(null, t.county));
  const trainingIds = new Set(trainings.map((t) => t.id));
  const out: Row = {
    ...d,
    schools,
    profiles,
    learners: rows("learners").filter((l) => keep(l.school_id)),
    enrollments: rows("enrollments").filter((e) => keep(e.school_id)),
    classes,
    classTeachers: rows("classTeachers").filter((t) => classIds.has(t.class_id)),
    assignments: rows("assignments").filter((a) => keep(a.school_id)),
    submissions: rows("submissions").filter((s) => keep(s.school_id)),
    fieldReports: rows("fieldReports").filter((r) => keep(r.school_id, r.county)),
    forms: rows("forms").filter((f) => !f.county || scope.areaCounties.has(norm(f.county))),
    responses: rows("responses").filter((r) => people.has(r.respondent_id)),
    koboSubmissions: rows("koboSubmissions").filter((k) => people.has(k.officer_id)),
    koboRecords: records,
    koboIssues: rows("koboIssues").filter((i) => recordIds.has(i.record_id)),
    libraryInteractions: rows("libraryInteractions").filter((i) => schoolNames.has(i.school)),
  };
  if ("trainings" in d) {
    out.trainings = trainings;
    out.trainingAttendance = rows("trainingAttendance").filter((a) => trainingIds.has(a.training_id) && people.has(a.teacher_id));
  }
  return out as T;
}
