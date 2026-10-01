/**
 * HPF Programme Intelligence — the Education Team's dashboard, computed
 * from raw rows with no database access (index.ts loads the rows; this
 * turns them into numbers). Four areas:
 *
 *   learning        — learners, teachers, schools, classes, assignments,
 *                     completion, results, library usage
 *   implementation  — field visits by type, school coverage
 *   dataCollection  — Kobo submissions, forms, feedback, response rates,
 *                     data quality checks
 *   impact          — learner growth, teacher participation, resource use,
 *                     assessment outcomes, school performance, reach
 *
 * Completion (work handed in) and achievement (marks on marked work) stay
 * separate everywhere, as in lms.ts. Every count comes from a real row;
 * where something can't be scoped (a form isn't tied to a school) the
 * result says so rather than pretending.
 */
import { counts as koboCounts, RULES as KOBO_RULES } from "./kobo_pipeline.ts";
import {
  type Band, groupResults, pairsOf, round2, summarize,
  type ResultAssignment, type ResultSubmission, expectedFrom,
} from "./lms.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

export const VISIT_TYPES = ["Learning", "Infrastructure", "ICT", "MEP", "Teacher support"] as const;

export type IntelligenceInput = {
  schools: Row[]; profiles: Row[]; learners: Row[]; enrollments: Row[]; terms: Row[];
  classes: Row[]; classTeachers: Row[]; subjects: Row[];
  assignments: Row[]; submissions: Row[];
  fieldReports: Row[]; forms: Row[]; responses: Row[];
  koboForms: Row[]; koboSubmissions: Row[];
  /** Validated, normalized Kobo submissions (kobo_records) and their issues. */
  koboRecords: Row[]; koboIssues: Row[];
  libraryItems: Row[]; libraryInteractions: Row[];
  bands: Band[];
};
export type IntelligenceFilter = { county?: string | null; school?: string | null; from?: string | null; to?: string | null };

const pct = (n: number, d: number) => (d > 0 ? round2((n / d) * 100) : null);
const day = (v: unknown) => String(v ?? "").slice(0, 10);
const termLabel = (id: string) => {
  const m = /^(\d{4})-T(\d)$/.exec(id);
  return m ? `${m[1]} Term ${m[2]}` : id;
};
function tally<T>(rows: T[], key: (r: T) => string | null | undefined, order?: readonly string[]) {
  const m = new Map<string, number>();
  for (const k of order ?? []) m.set(k, 0);
  for (const r of rows) {
    const k = key(r);
    if (k) m.set(k, (m.get(k) ?? 0) + 1);
  }
  const out = [...m.entries()].map(([label, value]) => ({ label, value }));
  return order ? out : out.sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}

export function buildIntelligence(d: IntelligenceInput, f: IntelligenceFilter = {}, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const inRange = (v: unknown) => {
    const x = day(v);
    if (!x) return !f.from && !f.to;
    return (!f.from || x >= f.from) && (!f.to || x <= f.to);
  };
  const dated = !!(f.from || f.to);

  // ---- scope: which schools (and counties) are in view
  const schools = d.schools.filter((s) => (!f.county || s.county === f.county) && (!f.school || s.name === f.school));
  const schoolIds = new Set(schools.map((s) => s.id));
  const schoolNames = new Set(schools.map((s) => s.name));
  const scoped = !!(f.county || f.school);
  const inSchools = (id: unknown) => !scoped || schoolIds.has(id);
  const schoolName = Object.fromEntries(d.schools.map((s) => [s.id, s.name]));

  // The current term (and its dates), for "this term" counts.
  const termsSorted = [...d.terms].sort((a, b) => String(a.starts_on).localeCompare(String(b.starts_on)));
  const currentTerm = termsSorted.find((t) => t.starts_on <= today && today <= t.ends_on) ?? null;
  const termOf = (v: unknown) => {
    const x = day(v);
    return termsSorted.find((t) => t.starts_on <= x && x <= t.ends_on)?.id ?? null;
  };

  const activeStaff = d.profiles.filter((p) => (p.status ?? "active") === "active");
  const teachers = activeStaff.filter((p) => p.role === "teacher" && inSchools(p.school_id));
  const heads = activeStaff.filter((p) => p.role === "school_leader" && inSchools(p.school_id));
  const officers = activeStaff.filter((p) => p.role === "field_officer" && (!f.county || p.county === f.county));
  const learners = d.learners.filter((l) => (l.enrollment_status ?? "ACTIVE") === "ACTIVE" && inSchools(l.school_id));
  const classes = d.classes.filter((c) => !c.archived_at && inSchools(c.school_id));
  const currentYear = currentTerm?.academic_year_id ?? null;
  const classesThisYear = currentYear ? classes.filter((c) => c.academic_year_id === currentYear) : classes;
  const openCT = d.classTeachers.filter((t) => !t.ended_at);

  // ---- assignments and results (published/closed; due date in range)
  const assignmentsAll = d.assignments.filter((a) => inSchools(a.school_id));
  const assignments = assignmentsAll.filter((a) => a.status !== "draft" && (!dated || inRange(a.due_at ?? a.published_at)));
  const asgIds = new Set(assignments.map((a) => a.id));
  const submissions = d.submissions.filter((s) => asgIds.has(s.assignment_id));
  const toRA = (a: Row): ResultAssignment => ({
    id: a.id, schoolId: a.school_id, classId: a.class_id, subjectId: a.subject_id, grade: a.grade,
    termId: a.term_id ?? null, yearId: a.academic_year_id, dueAt: a.due_at ?? null, status: a.status,
  });
  const toRS = (s: Row): ResultSubmission => ({
    assignmentId: s.assignment_id, learnerId: s.learner_id, status: s.status, isLate: !!s.is_late,
    percentage: s.percentage == null ? null : Number(s.percentage),
  });
  const pairs = pairsOf(assignments.map(toRA), expectedFrom(assignments, d.enrollments, now), submissions.map(toRS));
  const overall = summarize(pairs, d.bands, now);
  const subjectName = Object.fromEntries(d.subjects.map((s) => [s.id, s.name]));

  // ---- library usage (dated by start; scoped by the reader's school name)
  const libTitle = Object.fromEntries(d.libraryItems.map((i) => [i.id, i.title]));
  const lib = d.libraryInteractions.filter((i) => inRange(i.started_at) && (!scoped || schoolNames.has(i.school)));
  const libMinutes = (rows: Row[]) => Math.round(rows.reduce((t, i) => t + (Number(i.duration_seconds) || 0), 0) / 60);
  const learnerIdsInScope = new Set(learners.map((l) => l.id));
  const learnersUsingLibrary = new Set(lib.filter((i) => i.actor_kind === "learner" && learnerIdsInScope.has(i.actor_id)).map((i) => i.actor_id));
  const topResources = [...new Map(lib.map((i) => [i.library_item_id, 0])).keys()]
    .map((id) => {
      const rows = lib.filter((i) => i.library_item_id === id);
      return { title: libTitle[id] ?? "Removed item", sessions: rows.length, minutes: libMinutes(rows) };
    })
    .sort((a, b) => b.sessions - a.sessions || b.minutes - a.minutes).slice(0, 8);

  const learning = {
    totals: {
      learners: learners.length,
      teachers: teachers.length,
      schoolHeads: heads.length,
      schools: schools.length,
      classes: classesThisYear.length,
      classesWithoutTeacher: classesThisYear.filter((c) => !openCT.some((t) => t.class_id === c.id && t.role === "class_teacher")).length,
      learnersNotInClass: learners.filter((l) => !l.class_id).length,
      assignments: {
        published: assignmentsAll.filter((a) => a.status === "published").length,
        closed: assignmentsAll.filter((a) => a.status === "closed").length,
        draft: assignmentsAll.filter((a) => a.status === "draft").length,
      },
      awaitingMarking: submissions.filter((s) => s.status === "submitted").length,
    },
    completion: overall.completion,
    achievement: overall.achievement,
    bands: d.bands,
    byGrade: groupResults(pairs, "grade", d.bands, now).map((g) => ({
      label: g.key, learners: learners.filter((l) => l.grade === g.key).length,
      completionRate: g.completion.rate, assigned: g.completion.assigned,
      averagePercent: g.achievement.averagePercent, marked: g.achievement.marked, band: g.achievement.band,
    })).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })),
    bySubject: groupResults(pairs, "subject", d.bands, now).map((g) => ({
      label: subjectName[g.key] ?? g.key, completionRate: g.completion.rate, assigned: g.completion.assigned,
      averagePercent: g.achievement.averagePercent, marked: g.achievement.marked, band: g.achievement.band,
    })).sort((a, b) => a.label.localeCompare(b.label)),
    learnersByGrade: tally(learners, (l) => l.grade || "(not set)"),
    library: {
      sessions: lib.length,
      minutes: libMinutes(lib),
      readers: new Set(lib.map((i) => i.actor_id)).size,
      learnerSessions: lib.filter((i) => i.actor_kind === "learner").length,
      staffSessions: lib.filter((i) => i.actor_kind !== "learner").length,
      learnersUsing: learnersUsingLibrary.size,
      learnerReach: pct(learnersUsingLibrary.size, learners.length),
      completed: lib.filter((i) => i.completed_at).length,
      topResources,
    },
  };

  // ---- programme implementation: field visits
  const visits = d.fieldReports.filter((r) =>
    inRange(r.created_at) &&
    (!f.county || r.county === f.county) &&
    (!f.school || r.school === f.school || (r.school_id && schoolIds.has(r.school_id))));
  const visitedIds = new Set(visits.map((r) => r.school_id).filter((id) => id && schoolIds.has(id)));
  const visitedThisTerm = currentTerm
    ? new Set(d.fieldReports.filter((r) => day(r.created_at) >= currentTerm.starts_on && day(r.created_at) <= currentTerm.ends_on)
      .map((r) => r.school_id).filter((id) => id && schoolIds.has(id)))
    : new Set();
  const types = [...VISIT_TYPES, ...new Set(visits.map((r) => r.visit_type).filter((t) => !VISIT_TYPES.includes(t)))];
  const implementation = {
    visits: visits.length,
    officersReporting: new Set(visits.map((r) => r.officer_id)).size,
    officers: officers.length,
    byType: types.map((t) => {
      const rows = visits.filter((r) => r.visit_type === t);
      return { label: t, visits: rows.length, schools: new Set(rows.map((r) => r.school_id ?? r.school)).size };
    }),
    byCounty: tally(visits, (r) => r.county),
    byTerm: tally(visits, (r) => { const t = termOf(r.created_at); return t ? termLabel(t) : null; })
      .sort((a, b) => a.label.localeCompare(b.label)),
    schools: {
      total: schools.length,
      visited: visitedIds.size,
      coverage: pct(visitedIds.size, schools.length),
      visitedThisTerm: visitedThisTerm.size,
      currentTerm: currentTerm ? termLabel(currentTerm.id) : null,
      notVisited: schools.filter((s) => !visitedIds.has(s.id)).map((s) => s.name).sort().slice(0, 50),
    },
  };

  // ---- data collection
  // Forms reach a role (and maybe a county); expected respondents are the
  // active staff they reach. Visit forms are filled inside visits instead.
  const formsLive = d.forms.filter((fm) => !fm.archived_at && (!f.county || !fm.county || fm.county === f.county));
  const responses = d.responses.filter((r) => inRange(r.submitted_at) && formsLive.some((fm) => fm.id === r.form_id));
  const reach = (fm: Row) => activeStaff.filter((p) => p.role === fm.audience && (!fm.county || p.county === fm.county) && (!f.county || p.county === f.county)).length;
  const responseRates = formsLive.map((fm) => {
    const rs = responses.filter((r) => r.form_id === fm.id);
    if (fm.visit_type) {
      const due = visits.filter((v) => v.visit_type === fm.visit_type).length;
      const got = new Set(rs.map((r) => r.visit_id).filter(Boolean)).size;
      return { label: fm.title, audience: fm.audience, kind: "visit", expected: due, received: got, rate: pct(got, due) };
    }
    const expected = reach(fm);
    const got = new Set(rs.map((r) => r.respondent_id)).size;
    return { label: fm.title, audience: fm.audience, kind: "form", expected, received: got, rate: pct(Math.min(got, expected), expected) };
  });
  const koboForms = d.koboForms.filter((k) => k.active !== false);
  const officerIds = new Set(officers.map((o) => o.id));
  const koboSubs = d.koboSubmissions.filter((s) => inRange(s.submitted_at) && (!f.county || officerIds.has(s.officer_id)));
  // Kobo submissions, as the ingestion pipeline left them: linked to a
  // school (and county), so the county/school filters narrow them too.
  const activeKobo = new Set(koboForms.map((k) => k.id));
  const kRecs = d.koboRecords.filter((r) => r.status !== "removed" && activeKobo.has(r.kobo_form_id) &&
    inRange(r.submitted_at) && (!f.county || r.county === f.county) && (!f.school || schoolIds.has(r.school_id)));
  const kCounted = kRecs.filter((r) => koboCounts(r.status, r.review));
  const kBy = (s: string) => kRecs.filter((r) => r.status === s).length;
  const kNeedsReview = kRecs.filter((r) => (r.status === "invalid" || r.status === "duplicate") && !r.review).length;
  const kIds = new Set(kRecs.map((r) => r.id));
  const kIssues = d.koboIssues.filter((i) => kIds.has(i.record_id));
  const koboTotal = kRecs.length;
  const officerPairsExpected = koboForms.length * officers.length;
  const officerPairsDone = new Set(koboSubs.filter((s) => koboForms.some((k) => k.id === s.kobo_form_id)).map((s) => `${s.kobo_form_id}|${s.officer_id}`)).size;

  const allVisits = d.fieldReports.filter((r) => (!f.county || r.county === f.county));
  const quality = [
    {
      key: "kobo_needs_review", label: "Kobo submissions failing validation, not yet reviewed", value: kNeedsReview, total: koboTotal,
      rate: null as number | null, good: "low",
      note: "Kept off the dashboards until someone accepts or excludes them (Kobo Surveys → Data pipeline).",
    },
    {
      key: "kobo_no_school", label: "Kobo submissions not linked to a portal school",
      value: kRecs.filter((r) => !r.school_id && r.status !== "rejected").length, total: koboTotal,
      rate: null as number | null, good: "low",
      note: "The school in the survey didn't match a school code, name or saved alias.",
    },
    {
      key: "kobo_duplicates", label: "Kobo submissions sent twice", value: kBy("duplicate"), total: koboTotal,
      rate: null as number | null, good: "low",
      note: "Only the first copy counts.",
    },
    {
      key: "kobo_rejected", label: "Kobo submissions rejected in Kobo's own review", value: kBy("rejected"), total: koboTotal,
      rate: null as number | null, good: "low",
      note: "Marked “not approved” in KoboToolbox — left out of the portal's results.",
    },
    {
      key: "visits_unlinked", label: "Field visits not linked to a school record", value: allVisits.filter((r) => !r.school_id).length,
      total: allVisits.length, rate: pct(allVisits.filter((r) => !r.school_id).length, allVisits.length), good: "low",
      note: "Older visits typed by name, before schools had codes.",
    },
    {
      key: "learners_no_class", label: "Active learners not placed in a class", value: learning.totals.learnersNotInClass,
      total: learners.length, rate: pct(learning.totals.learnersNotInClass, learners.length), good: "low",
      note: "They can't be set work or counted in class results until a school head places them.",
    },
    {
      key: "classes_no_teacher", label: "Classes without a class teacher", value: learning.totals.classesWithoutTeacher,
      total: classesThisYear.length, rate: pct(learning.totals.classesWithoutTeacher, classesThisYear.length), good: "low",
      note: "This school year.",
    },
    {
      key: "unmarked_overdue", label: "Handed-in work waiting over 14 days for marking",
      value: submissions.filter((s) => s.status === "submitted" && s.submitted_at && (now.getTime() - new Date(s.submitted_at).getTime()) > 14 * 864e5).length,
      total: submissions.filter((s) => s.status !== "in_progress").length, rate: null as number | null, good: "low",
      note: "Results are only as current as the marking.",
    },
    {
      key: "staff_no_school", label: "Teachers and school heads with no school", value: activeStaff.filter((p) => ["teacher", "school_leader"].includes(p.role) && !p.school_id).length,
      total: activeStaff.filter((p) => ["teacher", "school_leader"].includes(p.role)).length, rate: null as number | null, good: "low",
      note: "Their work can't be counted under any school.",
    },
  ].map((q) => ({ ...q, rate: q.rate ?? pct(q.value, q.total) }));

  const dataCollection = {
    kobo: {
      forms: koboForms.map((k) => {
        const mine = kRecs.filter((r) => r.kobo_form_id === k.id);
        return {
          title: k.title, submissions: mine.length, counted: mine.filter((r) => koboCounts(r.status, r.review)).length,
          invalid: mine.filter((r) => r.status === "invalid").length, duplicate: mine.filter((r) => r.status === "duplicate").length,
          rejected: mine.filter((r) => r.status === "rejected").length, syncedAt: k.synced_at ?? null,
          officersDone: new Set(koboSubs.filter((s) => s.kobo_form_id === k.id).map((s) => s.officer_id)).size,
        };
      }),
      totalSubmissions: koboTotal,
      counted: kCounted.length,
      needsReview: kNeedsReview,
      byStatus: { valid: kBy("valid"), invalid: kBy("invalid"), duplicate: kBy("duplicate"), rejected: kBy("rejected") },
      withWarnings: kRecs.filter((r) => Number(r.warning_count) > 0).length,
      schoolsCovered: new Set(kCounted.map((r) => r.school_id).filter(Boolean)).size,
      issuesByRule: KOBO_RULES.map((rule) => ({
        rule,
        errors: new Set(kIssues.filter((i) => i.rule === rule && i.severity === "error").map((i) => i.record_id)).size,
        warnings: new Set(kIssues.filter((i) => i.rule === rule && i.severity === "warning").map((i) => i.record_id)).size,
      })),
      inRange: koboSubs.length,
      officerCompletion: { expected: officerPairsExpected, done: officerPairsDone, rate: pct(officerPairsDone, officerPairsExpected) },
      lastSynced: koboForms.map((k) => k.synced_at).filter(Boolean).sort().pop() ?? null,
    },
    forms: {
      active: formsLive.length,
      archived: d.forms.filter((fm) => fm.archived_at).length,
      byAudience: tally(formsLive, (fm) => fm.audience),
    },
    feedback: {
      responses: responses.length,
      thisTerm: currentTerm ? d.responses.filter((r) => day(r.submitted_at) >= currentTerm.starts_on && day(r.submitted_at) <= currentTerm.ends_on).length : 0,
      byRole: tally(responses, (r) => r.respondent_role),
    },
    responseRates,
    responseRateOverall: pct(
      responseRates.reduce((t, r) => t + Math.min(r.received, r.expected), 0),
      responseRates.reduce((t, r) => t + r.expected, 0),
    ),
    quality,
    // Forms aren't tied to a school: a school filter can't narrow them.
    // (Kobo submissions are, through the school each one names.)
    notSchoolScoped: !!f.school,
  };

  // ---- impact
  // Learners on roll per term: anyone enrolled (in scope) at some point in it.
  const enr = d.enrollments.filter((e) => inSchools(e.school_id));
  const learnerGrowth = termsSorted.filter((t) => t.starts_on <= today).map((t) => ({
    label: termLabel(t.id),
    learners: new Set(enr.filter((e) => (!e.enrollment_date || day(e.enrollment_date) <= t.ends_on) && (!e.exit_date || day(e.exit_date) >= t.starts_on))
      .map((e) => e.learner_id)).size,
    joined: new Set(enr.filter((e) => e.enrollment_date && day(e.enrollment_date) >= t.starts_on && day(e.enrollment_date) <= t.ends_on).map((e) => e.learner_id)).size,
  })).filter((t) => t.learners > 0 || t.joined > 0);

  const teacherIds = new Set(teachers.map((t) => t.id));
  const setWork = new Set(assignments.map((a) => a.created_by).filter((id) => teacherIds.has(id)));
  const marked = new Set(submissions.filter((s) => s.status === "marked" && s.marked_by).map((s) => s.marked_by).filter((id) => teacherIds.has(id)));
  const readers = new Set(lib.filter((i) => teacherIds.has(i.actor_id)).map((i) => i.actor_id));
  const answered = new Set(responses.filter((r) => teacherIds.has(r.respondent_id)).map((r) => r.respondent_id));
  const anyActivity = new Set([...setWork, ...marked, ...readers, ...answered]);
  const part = (s: Set<unknown>) => ({ count: s.size, rate: pct(s.size, teachers.length) });

  const assessmentByTerm = groupResults(pairs, "term", d.bands, now)
    .filter((g) => g.achievement.marked > 0 || g.completion.assigned > 0)
    .map((g) => ({
      label: termLabel(g.key), averagePercent: g.achievement.averagePercent, marked: g.achievement.marked,
      band: g.achievement.band, bands: g.achievement.bands, completionRate: g.completion.rate,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const usageByTerm = termsSorted.filter((t) => t.starts_on <= today).map((t) => {
    const rows = d.libraryInteractions.filter((i) => (!scoped || schoolNames.has(i.school)) && day(i.started_at) >= t.starts_on && day(i.started_at) <= t.ends_on);
    return { label: termLabel(t.id), sessions: rows.length, minutes: libMinutes(rows), readers: new Set(rows.map((i) => i.actor_id)).size };
  }).filter((t) => t.sessions > 0);

  const bySchool = new Map(groupResults(pairs, "school", d.bands, now).map((g) => [g.key, g]));
  const schoolPerformance = schools.map((s) => {
    const g = bySchool.get(s.id);
    const sLib = lib.filter((i) => i.school === s.name);
    return {
      school: s.name, code: s.code, county: s.county,
      learners: learners.filter((l) => l.school_id === s.id).length,
      teachers: teachers.filter((t) => t.school_id === s.id).length,
      completionRate: g?.completion.rate ?? null, assigned: g?.completion.assigned ?? 0,
      averagePercent: g?.achievement.averagePercent ?? null, marked: g?.achievement.marked ?? 0, band: g?.achievement.band ?? null,
      visits: visits.filter((r) => r.school_id === s.id).length,
      libraryMinutes: libMinutes(sLib),
    };
  }).sort((a, b) => (b.learners - a.learners) || a.school.localeCompare(b.school));

  const reachedSchools = new Set([...learners.map((l) => l.school_id), ...teachers.map((t) => t.school_id)].filter((id) => id && schoolIds.has(id)));
  const impact = {
    learnerGrowth,
    teacherParticipation: {
      teachers: teachers.length,
      active: part(anyActivity),
      settingWork: part(setWork),
      marking: part(marked),
      usingLibrary: part(readers),
      answeringForms: part(answered),
    },
    resourceUsage: {
      byTerm: usageByTerm,
      learnerReach: learning.library.learnerReach,
      minutesPerLearner: learnersUsingLibrary.size ? Math.round(libMinutes(lib.filter((i) => i.actor_kind === "learner")) / learnersUsingLibrary.size) : null,
    },
    assessment: {
      byTerm: assessmentByTerm,
      overall: overall.achievement,
      bandShare: Object.fromEntries(Object.entries(overall.achievement.bands).map(([k, v]) => [k, pct(v, overall.achievement.marked)])),
    },
    schoolPerformance,
    reach: {
      counties: new Set(schools.filter((s) => reachedSchools.has(s.id)).map((s) => s.county)).size,
      countiesTotal: new Set(schools.map((s) => s.county)).size,
      schoolsReached: reachedSchools.size,
      schoolsTotal: schools.length,
      schoolsVisited: visitedIds.size,
      learners: learners.length,
      teachers: teachers.length,
      fieldOfficers: officers.length,
      learnersEverEnrolled: new Set(enr.map((e) => e.learner_id)).size,
    },
  };

  return {
    scope: { county: f.county ?? null, school: f.school ?? null, from: f.from ?? null, to: f.to ?? null },
    currentTerm: currentTerm ? termLabel(currentTerm.id) : null,
    learning, implementation, dataCollection, impact,
    generatedAt: now.toISOString(),
  };
}
