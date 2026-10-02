/**
 * The impact dashboards — pure, no database. Built on buildIntelligence()
 * (which keeps doing the shared work: scope, completion, results, visits,
 * Kobo, library), adding what each dashboard needs:
 *
 *   executive  — schools, learners, teachers, active users, completion, library hours
 *   reach      — schools / learners / teachers by county, gender (where
 *                recorded, small numbers hidden), grades, accounts, teacher types
 *   learning   — assignments, completion, results, subjects, learner progress
 *   teachers   — training, digital resource use, activity (ICT integration
 *                comes from tagged M&E indicators, added by the page)
 *   fieldOps   — visits, visit types, completed forms, Kobo submissions
 *   resources  — resources, opens, usage time, active users, most-used content
 */
import { buildIntelligence, type IntelligenceFilter, type IntelligenceInput } from "./intelligence.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

export type ImpactInput = IntelligenceInput & { trainings: Row[]; trainingAttendance: Row[] };

/** Below this, a count is shown as "<5" so no individual can be picked out. */
export const SMALL_NUMBER = 5;
export const GENDERS = ["female", "male", "prefer_not_to_say"] as const;
const GENDER_LABEL: Record<string, string> = { female: "Female", male: "Male", prefer_not_to_say: "Prefer not to say", not_recorded: "Not recorded" };

const r1 = (n: number) => Math.round(n * 10) / 10;
const pct = (n: number, d: number) => (d > 0 ? r1((n / d) * 100) : null);
const day = (v: unknown) => String(v ?? "").slice(0, 10);
const month = (v: unknown) => String(v ?? "").slice(0, 7);
function tally<T>(rows: T[], key: (r: T) => string | null | undefined) {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = key(r);
    if (k) m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}

/** Hides small counts in one row of a table: any cell of 1–4 becomes null
    ("<5"), and if that leaves exactly one hidden cell, the next smallest is
    hidden too, so it can't be worked out from the total. */
export function suppressRow(cells: Record<string, number>): Record<string, number | null> {
  const out: Record<string, number | null> = { ...cells };
  const hidden = Object.keys(cells).filter((k) => cells[k] > 0 && cells[k] < SMALL_NUMBER);
  for (const k of hidden) out[k] = null;
  if (hidden.length === 1) {
    const next = Object.keys(cells).filter((k) => !hidden.includes(k) && cells[k] > 0).sort((a, b) => cells[a] - cells[b])[0];
    if (next !== undefined) out[next] = null;
  }
  return out;
}

function genderTable(people: Row[], countyOf: (p: Row) => string | null) {
  const keys = [...GENDERS, "not_recorded"] as const;
  const count = (rows: Row[]) => Object.fromEntries(keys.map((g) => [g, rows.filter((p) => (p.gender || "not_recorded") === g).length])) as Record<string, number>;
  const recorded = people.filter((p) => p.gender).length;
  const counties = [...new Set(people.map(countyOf).filter(Boolean))].sort() as string[];
  const overall = suppressRow(count(people));
  return {
    total: people.length,
    recorded,
    recordedShare: pct(recorded, people.length),
    overall: keys.map((g) => ({ key: g, label: GENDER_LABEL[g], value: overall[g] })),
    byCounty: counties.map((c) => {
      const rows = people.filter((p) => countyOf(p) === c);
      const cells = suppressRow(count(rows));
      const values: Record<string, number | null> = Object.fromEntries(keys.map((g) => [g, cells[g]]));
      return { county: c, total: rows.length, values };
    }),
  };
}

export function buildImpact(d: ImpactInput, f: IntelligenceFilter = {}, now = new Date()) {
  const intel = buildIntelligence(d, f, now);
  const today = now.toISOString().slice(0, 10);
  const dated = !!(f.from || f.to);
  // Activity window: the period picked, or the last 30 days.
  const winFrom = f.from ?? new Date(now.getTime() - 30 * 864e5).toISOString().slice(0, 10);
  const winTo = f.to ?? today;
  const inWin = (v: unknown) => { const x = day(v); return !!x && x >= winFrom && x <= winTo; };
  const inRange = (v: unknown) => { const x = day(v); return !dated || (!!x && (!f.from || x >= f.from) && (!f.to || x <= f.to)); };

  // The same scope as buildIntelligence: schools in the county / the school.
  const schools = d.schools.filter((s) => (!f.county || s.county === f.county) && (!f.school || s.name === f.school));
  const schoolIds = new Set(schools.map((s) => s.id));
  const schoolNames = new Set(schools.map((s) => s.name));
  const scoped = !!(f.county || f.school);
  const inSchools = (id: unknown) => !scoped || schoolIds.has(id);
  const countyOfSchool = new Map(d.schools.map((s) => [s.id, s.county as string]));
  const activeStaff = d.profiles.filter((p) => (p.status ?? "active") === "active");
  const teachers = activeStaff.filter((p) => p.role === "teacher" && inSchools(p.school_id));
  const heads = activeStaff.filter((p) => p.role === "school_leader" && inSchools(p.school_id));
  const officers = activeStaff.filter((p) => p.role === "field_officer" && (!f.county || p.county === f.county));
  const learners = d.learners.filter((l) => (l.enrollment_status ?? "ACTIVE") === "ACTIVE" && inSchools(l.school_id));
  const staffInScope = [...teachers, ...heads, ...officers];
  const learnerIds = new Set(learners.map((l) => l.id));
  const staffIds = new Set(staffInScope.map((p) => p.id));
  const teacherIds = new Set(teachers.map((t) => t.id));
  const countyOf = (p: Row) => countyOfSchool.get(p.school_id) ?? p.county ?? null;

  // ---- active users: did something in the window
  const activeLearners = new Set<string>();
  const activeStaffIds = new Set<string>();
  // Portal-wide, every active staff account counts (the Education Team too);
  // narrowed to a county or school, only the people based there.
  const anyStaffIds = new Set(activeStaff.map((p) => p.id));
  const touch = (id: unknown) => {
    const k = String(id ?? "");
    if (!k) return;
    if (learnerIds.has(k)) activeLearners.add(k);
    else if (scoped ? staffIds.has(k) : anyStaffIds.has(k)) activeStaffIds.add(k);
  };
  for (const i of d.libraryInteractions) if (inWin(i.started_at)) touch(i.actor_id);
  for (const s of d.submissions) if (inWin(s.submitted_at) || inWin(s.last_saved_at) || inWin(s.started_at)) touch(s.learner_id);
  for (const s of d.submissions) if (s.marked_by && inWin(s.marked_at)) touch(s.marked_by);
  for (const a of d.assignments) if (inWin(a.published_at) || inWin(a.created_at)) touch(a.created_by);
  for (const r of d.fieldReports) if (inWin(r.created_at)) touch(r.officer_id);
  for (const r of d.responses) if (inWin(r.submitted_at)) touch(r.respondent_id);
  for (const k of d.koboSubmissions) if (inWin(k.submitted_at)) touch(k.officer_id);

  // ---- library (scoped by the reader's school name, like buildIntelligence)
  const lib = d.libraryInteractions.filter((i) => inRange(i.started_at) && (!scoped || schoolNames.has(i.school)));
  const minutesOf = (rows: Row[]) => Math.round(rows.reduce((t, i) => t + (Number(i.duration_seconds) || 0), 0) / 60);
  const itemById = new Map(d.libraryItems.map((i) => [i.id, i]));

  const executive = {
    schools: schools.length,
    learners: learners.length,
    teachers: teachers.length,
    activeUsers: {
      total: activeLearners.size + activeStaffIds.size, learners: activeLearners.size, staff: activeStaffIds.size,
      window: dated ? "in the period" : "in the last 30 days",
      learnerShare: pct(activeLearners.size, learners.length),
    },
    completion: intel.learning.completion,
    averageMark: intel.learning.achievement.averagePercent,
    libraryHours: r1(minutesOf(lib) / 60),
    schoolsVisited: intel.implementation.schools,
    currentTerm: intel.currentTerm,
  };

  // ---- reach
  const counties = [...new Set(schools.map((s) => s.county))].sort() as string[];
  const reach = {
    schoolsByCounty: counties.map((c) => {
      const ids = schools.filter((s) => s.county === c).map((s) => s.id);
      const reached = ids.filter((id) => learners.some((l) => l.school_id === id) || teachers.some((t) => t.school_id === id)).length;
      return { label: c, schools: ids.length, reached };
    }),
    learnersByCounty: counties.map((c) => ({ label: c, value: learners.filter((l) => countyOfSchool.get(l.school_id) === c).length })),
    teachersByCounty: counties.map((c) => ({ label: c, value: teachers.filter((t) => countyOfSchool.get(t.school_id) === c).length })),
    gender: {
      threshold: SMALL_NUMBER,
      learners: genderTable(learners, (l) => countyOfSchool.get(l.school_id) ?? null),
      teachers: genderTable(teachers, countyOf),
    },
    grades: intel.learning.learnersByGrade,
    accountsByRole: [
      { label: "Learners", value: learners.length }, { label: "Teachers", value: teachers.length },
      { label: "School heads", value: heads.length }, { label: "Field officers", value: officers.length },
    ],
    teachersByType: tally(teachers, (t) => t.teacher_type || "Not specified"),
    summary: intel.impact.reach,
    growth: intel.impact.learnerGrowth,
  };

  // ---- learning
  const assignments = d.assignments.filter((a) => inSchools(a.school_id));
  const subjectName = new Map(d.subjects.map((s) => [s.id, s.name]));
  // Learner progress: of learners with marks in 2+ terms, how many improved
  // from their first term's average to their latest.
  const asgTerm = new Map(assignments.filter((a) => a.status !== "draft" && (!dated || inRange(a.due_at ?? a.published_at)))
    .map((a) => [a.id, a.term_id]));
  const marks = new Map<string, Map<string, number[]>>();
  for (const s of d.submissions) {
    if (s.status !== "marked" || s.percentage == null || !learnerIds.has(s.learner_id)) continue;
    const term = asgTerm.get(s.assignment_id);
    if (!term) continue;
    if (!marks.has(s.learner_id)) marks.set(s.learner_id, new Map());
    const t = marks.get(s.learner_id)!;
    if (!t.has(term)) t.set(term, []);
    t.get(term)!.push(Number(s.percentage));
  }
  let compared = 0, improved = 0, declined = 0;
  for (const terms of marks.values()) {
    if (terms.size < 2) continue;
    const ordered = [...terms.keys()].sort();
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const first = avg(terms.get(ordered[0])!), last = avg(terms.get(ordered[ordered.length - 1])!);
    compared++;
    if (last > first + 0.5) improved++;
    else if (last < first - 0.5) declined++;
  }
  const learning = {
    assignments: {
      published: assignments.filter((a) => a.status === "published").length,
      closed: assignments.filter((a) => a.status === "closed").length,
      draft: assignments.filter((a) => a.status === "draft").length,
      bySubject: tally(assignments.filter((a) => a.status !== "draft"), (a) => subjectName.get(a.subject_id) ?? a.subject_id),
      awaitingMarking: intel.learning.totals.awaitingMarking,
    },
    completion: intel.learning.completion,
    completionByGrade: intel.learning.byGrade.map((g) => ({ label: g.label, value: g.completionRate, n: g.assigned })),
    results: intel.learning.achievement,
    bands: intel.learning.bands,
    resultsByGrade: intel.learning.byGrade.filter((g) => g.marked).map((g) => ({ label: g.label, value: g.averagePercent, n: g.marked, band: g.band })),
    subjects: intel.learning.bySubject,
    progress: {
      byTerm: intel.impact.assessment.byTerm,
      learners: { compared, improved, declined, steady: compared - improved - declined, improvedShare: pct(improved, compared) },
    },
    schools: intel.impact.schoolPerformance,
  };

  // ---- teacher development
  // A session is in view if it was held at a school / in a county in view,
  // or a teacher in view attended it (e.g. a county workshop, seen from one
  // school). Taken-off-the-list attendance (attended = false) never counts.
  const present = d.trainingAttendance.filter((a) => a.attended !== false);
  const attendedBy = new Map<string, Set<string>>();
  for (const a of present) {
    if (!attendedBy.has(a.training_id)) attendedBy.set(a.training_id, new Set());
    attendedBy.get(a.training_id)!.add(a.teacher_id);
  }
  const trainings = d.trainings.filter((t) => !t.archived_at && inRange(t.held_on) && (!scoped ||
    (t.school_id && schoolIds.has(t.school_id)) || (!f.school && !t.school_id && t.county === f.county) ||
    [...(attendedBy.get(t.id) ?? [])].some((id) => teacherIds.has(id))));
  const trainingIds = new Set(trainings.map((t) => t.id));
  const attended = present.filter((a) => trainingIds.has(a.training_id) && teacherIds.has(a.teacher_id));
  const trained = new Set(attended.map((a) => a.teacher_id).filter((id) => teacherIds.has(id)));
  const staffItems = new Set(d.libraryItems.filter((i) => i.audience === "staff").map((i) => i.id));
  const teacherLib = lib.filter((i) => teacherIds.has(i.actor_id));
  const p = intel.impact.teacherParticipation;
  const supportVisits = intel.implementation.byType.find((t) => t.label === "Teacher support");
  const teachersOut = {
    total: teachers.length,
    byType: tally(teachers, (t) => t.teacher_type || "Not specified"),
    training: {
      sessions: trainings.length,
      attendances: attended.length,
      teachersTrained: trained.size,
      share: pct(trained.size, teachers.length),
      byKind: tally(trainings, (t) => t.kind),
      byCounty: counties.map((c) => {
        const ts = teachers.filter((t) => countyOfSchool.get(t.school_id) === c);
        return { label: c, teachers: ts.length, trained: ts.filter((t) => trained.has(t.id)).length, share: pct(ts.filter((t) => trained.has(t.id)).length, ts.length) };
      }),
      recent: [...trainings].sort((a, b) => String(b.held_on).localeCompare(String(a.held_on))).slice(0, 8).map((t) => ({
        id: t.id, title: t.title, kind: t.kind, heldOn: t.held_on, county: t.county ?? countyOfSchool.get(t.school_id) ?? null,
        attendees: attendedBy.get(t.id)?.size ?? 0,
      })),
    },
    digital: {
      teachersUsingLibrary: new Set(teacherLib.map((i) => i.actor_id)).size,
      share: pct(new Set(teacherLib.map((i) => i.actor_id)).size, teachers.length),
      hours: r1(minutesOf(teacherLib) / 60),
      teacherResourceOpens: teacherLib.filter((i) => staffItems.has(i.library_item_id)).length,
      settingWork: p.settingWork,
    },
    activity: {
      participation: p,
      byCounty: counties.map((c) => {
        const ts = teachers.filter((t) => countyOfSchool.get(t.school_id) === c);
        const act = ts.filter((t) => activeStaffIds.has(t.id)).length;
        return { label: c, teachers: ts.length, active: act, share: pct(act, ts.length) };
      }),
      activeInWindow: teachers.filter((t) => activeStaffIds.has(t.id)).length,
      window: executive.activeUsers.window,
      supportVisits: { visits: supportVisits?.visits ?? 0, schools: supportVisits?.schools ?? 0 },
    },
  };

  // ---- field operations
  const visits = d.fieldReports.filter((r) => inRange(r.created_at) && (!f.county || r.county === f.county) &&
    (!f.school || r.school === f.school || (r.school_id && schoolIds.has(r.school_id))));
  const visitIds = new Set(visits.map((v) => v.id));
  const visitForms = d.responses.filter((r) => r.visit_id && visitIds.has(r.visit_id));
  const kobo = d.koboRecords.filter((r) => r.status !== "removed" && inRange(r.submitted_at) &&
    (!f.county || r.county === f.county) && (!f.school || schoolIds.has(r.school_id)));
  const last12 = Array.from({ length: 12 }, (_, i) => {
    const dt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11 + i, 1));
    return dt.toISOString().slice(0, 7);
  });
  const fieldOps = {
    visits: intel.implementation,
    visitsByMonth: last12.map((m) => ({ label: m, value: visits.filter((v) => month(v.created_at) === m).length })),
    forms: {
      responses: intel.dataCollection.feedback.responses,
      visitFormsFilled: visitForms.length,
      visitsWithForms: new Set(visitForms.map((r) => r.visit_id)).size,
      visitsWithFormsShare: pct(new Set(visitForms.map((r) => r.visit_id)).size, visits.length),
      responseRates: intel.dataCollection.responseRates,
      responseRateOverall: intel.dataCollection.responseRateOverall,
      byAudience: intel.dataCollection.forms.byAudience,
    },
    kobo: {
      ...intel.dataCollection.kobo,
      byMonth: last12.map((m) => ({ label: m, value: kobo.filter((r) => month(r.submitted_at) === m).length })),
      byCounty: tally(kobo, (r) => r.county || "(no county)"),
    },
  };

  // ---- digital resources
  const items = d.libraryItems.filter((i) => i.published !== false);
  const readers = new Set(lib.map((i) => i.actor_id));
  const opensByItem = new Map<string, Row[]>();
  for (const i of lib) {
    if (!opensByItem.has(i.library_item_id)) opensByItem.set(i.library_item_id, []);
    opensByItem.get(i.library_item_id)!.push(i);
  }
  const everOpened = new Set(d.libraryInteractions.map((x) => x.library_item_id));
  const dest = (a: unknown) => (a === "staff" ? "Teacher Resources" : a === "school_leader" ? "For School Head" : "Digital Library");
  const resources = {
    items: {
      total: items.length,
      byDestination: tally(items, (i) => dest(i.audience)),
      bySubject: tally(items, (i) => i.subject || "No subject"),
      byType: tally(items, (i) => i.type || "Other"),
    },
    opens: lib.length,
    finished: lib.filter((i) => i.completed_at).length,
    hours: r1(minutesOf(lib) / 60),
    activeUsers: {
      total: readers.size,
      learners: new Set(lib.filter((i) => i.actor_kind === "learner").map((i) => i.actor_id)).size,
      staff: new Set(lib.filter((i) => i.actor_kind !== "learner").map((i) => i.actor_id)).size,
      learnerReach: intel.learning.library.learnerReach,
    },
    byTerm: intel.impact.resourceUsage.byTerm,
    byMonth: last12.map((m) => ({ label: m, opens: lib.filter((i) => month(i.started_at) === m).length, minutes: minutesOf(lib.filter((i) => month(i.started_at) === m)) })),
    top: [...opensByItem.entries()].map(([id, rows]) => ({
      id, title: itemById.get(id)?.title ?? "Removed resource", destination: dest(itemById.get(id)?.audience),
      opens: rows.length, readers: new Set(rows.map((r) => r.actor_id)).size, minutes: minutesOf(rows),
    })).sort((a, b) => b.opens - a.opens || b.minutes - a.minutes).slice(0, 10),
    neverOpened: items.filter((i) => !everOpened.has(i.id)).length,
  };

  return {
    scope: intel.scope, currentTerm: intel.currentTerm, generatedAt: now.toISOString(),
    executive, reach, learning, teachers: teachersOut, fieldOps, resources,
    // Still used by the overview's "needs attention" and the Data quality link.
    dataCollection: { notSchoolScoped: intel.dataCollection.notSchoolScoped },
  };
}
