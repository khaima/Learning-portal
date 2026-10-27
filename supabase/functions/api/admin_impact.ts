/**
 * The Administration overview's programme results — pure, no database
 * (GET /admin/overview → results; docs/DASHBOARD-HIERARCHY.md).
 *
 * Seven headline figures for one reporting period — the current term, up
 * to today — each with what it counts, its unit and period, the same point
 * of the term before beside it, and a target only where M&E has approved
 * one for the period; then where each school stands and which need a hand.
 *
 * Built on buildImpact(), so a figure here is the figure on the area
 * dashboards. The rules (27 October 2026):
 *   - nothing is estimated: a figure with nothing behind it is null
 *     ("No data"), never 0;
 *   - the comparison is the same number of days into the term before, so a
 *     term under way isn't set against a whole one;
 *   - taking part and using resources are never called learning outcomes;
 *   - no sign-ins, API calls, records, uptime, sync or errors: those are the
 *     Platform overview's.
 */
import { buildImpact, type ImpactInput } from "./impact.ts";
import { achievement } from "./me.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

export type ReportingTerm = { id: string; label: string; from: string; to: string };

export type Kpi = {
  key: string;
  label: string;
  /** What is counted, in plain words. */
  definition: string;
  value: number | null;
  unit: "count" | "percent";
  /** What a share is out of, or the wider figure it sits in. */
  of: string;
  period: string;
  /** The term before at the same point; null when there's no earlier term or the figure isn't comparable. */
  previous: { value: number | null; period: string } | null;
  /** M&E's approved target for the period, when one exists for this measure. */
  target: { value: number; indicator: string; percent: number | null; status: string } | null;
  /** One sentence the data supports, or "". */
  note: string;
  /** What the figure doesn't show. */
  caveat: string;
};

/** The rules that put a school under "needs support", in the order shown. */
export const SUPPORT_RULES = ["No active teacher", "No work set", "Under half of work handed in", "Marks below expectations", "Not visited"] as const;

const DAY = 864e5;
const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const fmt = (v: number) => v.toLocaleString("en");
const plural = (v: number, one: string, many = `${one}s`) => `${fmt(v)} ${v === 1 ? one : many}`;

/** M&E's targets for the portal's own measures, from one period's indicator
    rows (GET /mel/dashboard's). Only a plain measure counts: one narrowed to
    a visit type measures something else. The first indicator for a measure wins. */
export function portalTargets(indicators: Row[]) {
  const out = new Map<string, { value: number; indicator: string; unit: string; direction: "increase" | "decrease" }>();
  for (const i of indicators) {
    const cfg: Row = i.sourceConfig ?? {};
    const narrowed = Object.keys(cfg).some((k) => k !== "metric" && cfg[k] != null && cfg[k] !== "");
    if (i.source !== "portal" || !cfg.metric || !i.target || narrowed || out.has(cfg.metric)) continue;
    out.set(cfg.metric, {
      value: Number(i.target.value), indicator: [i.code, i.name].filter(Boolean).join(" "),
      unit: String(i.unit), direction: i.direction === "decrease" ? "decrease" : "increase",
    });
  }
  return out;
}

export function buildAdminResults(
  d: ImpactInput,
  terms: { current: ReportingTerm; previous: ReportingTerm | null },
  mel: { indicators: Row[]; summary: Record<string, number> } | null,
  now = new Date(),
) {
  const today = now.toISOString().slice(0, 10);
  const { current, previous } = terms;
  const to = current.to < today ? current.to : today;
  const underway = to < current.to;
  const elapsed = daysBetween(current.from, to);
  // The term before, cut to the same number of days in while this one is under way.
  const prevTo = previous ? (underway ? [previous.to, addDays(previous.from, elapsed)].sort()[0] : previous.to) : null;
  const a = buildImpact(d, { from: current.from, to }, now);
  const b = previous && prevTo ? buildImpact(d, { from: previous.from, to: prevTo }, now) : null;
  const period = underway ? `${current.label} so far` : current.label;
  const prevPeriod = previous ? (underway ? `the same point of ${previous.label}` : previous.label) : "";
  const targets = portalTargets(mel?.indicators ?? []);

  const make = (k: Omit<Kpi, "period" | "previous" | "target">, prev: number | null | undefined, metric = "", comparable = true): Kpi => {
    const t = metric ? targets.get(metric) : undefined;
    let target: Kpi["target"] = null;
    if (t && t.unit === k.unit) {
      const x = achievement(k.value, t.value, t.direction);
      target = { value: t.value, indicator: t.indicator, percent: x.percent, status: x.status };
    }
    return { ...k, period, previous: b && comparable ? { value: prev ?? null, period: prevPeriod } : null, target };
  };

  const E = a.executive, EB = b?.executive;
  const teachers = a.teachers.total;
  const reach = a.reach.summary;
  const learners = make({
    key: "learners", label: "Learners reached",
    definition: "Learners on roll now (active enrolment) at the programme's schools.",
    value: E.learners, unit: "count",
    of: `at ${plural(reach.schoolsReached, "school")} with learners or teachers on the portal, of ${plural(reach.schoolsTotal, "school")}`,
    note: E.learners ? "" : "No learners are on roll in your area yet.",
    caveat: "A count of the roll today, so it isn't compared with an earlier term.",
  }, null, "learners_enrolled", false);

  const taking = make({
    key: "participation", label: "Learners taking part",
    definition: "Learners on roll who started or handed in work, or opened a Digital Library resource, in the period.",
    value: E.activeUsers.learnerShare, unit: "percent",
    of: E.learners ? `${plural(E.activeUsers.learners, "learner")} of ${fmt(E.learners)}` : "",
    note: "", caveat: "Taking part shows use of the portal, not what learners learned.",
  }, EB?.activeUsers.learnerShare);

  // Training: null when the register has no sessions at all — that's no data, not no training.
  const register = d.trainings.some((t) => !t.archived_at);
  const T = a.teachers.training;
  const trained = make({
    key: "teachers_trained", label: "Teachers trained",
    definition: "Active teachers who attended at least one session held in the period, from the training register.",
    value: register ? T.teachersTrained : null, unit: "count",
    of: register && teachers ? `${T.share ?? 0}% of ${plural(teachers, "teacher")} · ${plural(T.sessions, "session")}` : "",
    note: register ? "" : "No training sessions are in the register yet.",
    caveat: "Attendance at training, not what changed in the classroom.",
  }, register ? b?.teachers.training.teachersTrained : null);

  const S = a.teachers.digital.settingWork;
  const digital = make({
    key: "teachers_digital", label: "Teachers teaching digitally",
    definition: "Active teachers who published at least one assignment on the portal in the period.",
    value: teachers ? S.rate : null, unit: "percent",
    of: teachers ? `${fmt(S.count)} of ${plural(teachers, "teacher")}` : "",
    note: teachers ? "" : "No active teachers in your area yet.",
    caveat: "Counted apart from training: a trained teacher counts here only once they set work.",
  }, b?.teachers.digital.settingWork.rate, "teachers_setting_work");

  const V = E.schoolsVisited;
  const schools = make({
    key: "schools_supported", label: "Schools supported",
    definition: "Programme schools with at least one field visit in the period.",
    value: V.total ? V.coverage : null, unit: "percent",
    of: V.total ? `${fmt(V.visited)} of ${plural(V.total, "school")}` : "",
    note: V.total ? "" : "No schools in your area yet.",
    caveat: "Out of the schools on the portal: the portal holds no separate list of target schools.",
  }, EB?.schoolsVisited.coverage, "schools_visited");

  const R = a.learning.results;
  const top = [...d.bands].sort((x, y) => y.minPercent - x.minPercent).slice(0, 2).map((x) => x.code);
  const meeting = R.marked ? pct(top.reduce((t, c) => t + Number((R.bands as Row)[c] ?? 0), 0), R.marked) : null;
  const RB = b?.learning.results;
  const marks = make({
    key: "assessment", label: "Average mark on marked classwork",
    definition: "The mean percentage of the work teachers marked on the portal in the period.",
    value: R.marked ? R.averagePercent : null, unit: "percent",
    of: R.marked ? `${plural(R.marked, "piece")} of marked work · ${meeting ?? 0}% meeting or exceeding expectations` : "",
    note: !R.marked ? "No work has been marked in the period."
      : R.marked < 30 ? `Based on only ${plural(R.marked, "piece")} of marked work: too few to draw conclusions.` : "",
    caveat: "Teacher-marked classwork, not a standardised assessment. Kobo learner assessments aren't included yet.",
  }, RB?.marked ? RB.averagePercent : null, "average_mark");

  const G = a.teachers.digital;
  const resources = make({
    key: "teacher_resources", label: "Teachers using digital resources",
    definition: "Active teachers who opened a Digital Library or Teacher Resources item in the period.",
    value: teachers ? G.share : null, unit: "percent",
    of: teachers ? `${fmt(G.teachersUsingLibrary)} of ${plural(teachers, "teacher")} · ${G.hours} hours · ${plural(G.teacherResourceOpens, "Teacher Resources open")}` : "",
    note: teachers ? "" : "No active teachers in your area yet.",
    caveat: "Use of resources, not evidence of better teaching or learning.",
  }, b?.teachers.digital.share);

  // ---- school by school, and the schools that need a hand
  const low = new Set([...d.bands].sort((x, y) => x.minPercent - y.minPercent).slice(0, 2).map((x) => x.code));
  const rows = (a.learning.schools as Row[]).map((s) => {
    const flags: string[] = [];
    if (s.learners && !s.teachers) flags.push(SUPPORT_RULES[0]);
    if (s.learners && !s.assigned) flags.push(SUPPORT_RULES[1]);
    if (s.assigned >= 10 && s.completionRate != null && s.completionRate < 50) flags.push(SUPPORT_RULES[2]);
    if (s.marked >= 10 && low.has(s.band)) flags.push(SUPPORT_RULES[3]);
    if (!s.visits) flags.push(SUPPORT_RULES[4]);
    return {
      school: String(s.school), code: s.code ?? null, county: s.county ?? null, learners: Number(s.learners), teachers: Number(s.teachers),
      assigned: Number(s.assigned), completionRate: s.assigned ? (s.completionRate as number | null) : null,
      marked: Number(s.marked), averagePercent: s.marked ? (s.averagePercent as number | null) : null,
      visits: Number(s.visits), flags,
    };
  }).sort((x, y) => y.flags.length - x.flags.length || y.learners - x.learners || x.school.localeCompare(y.school));
  const support = SUPPORT_RULES.map((rule) => {
    const at = rows.filter((s) => s.flags.includes(rule));
    return { rule, count: at.length, schools: at.slice(0, 50).map((s) => s.school) };
  }).filter((x) => x.count);

  return {
    period: { id: current.id, label: current.label, from: current.from, to, underway, day: elapsed + 1, days: daysBetween(current.from, current.to) + 1 },
    previous: previous && prevTo ? { id: previous.id, label: previous.label, from: previous.from, to: prevTo } : null,
    kpis: [learners, taking, trained, digital, schools, marks, resources],
    targets: mel ? { summary: mel.summary, indicators: mel.indicators.length } : null,
    schools: rows.slice(0, 200), schoolsTotal: rows.length,
    support,
    rules: { completionBelow: 50, minAssigned: 10, minMarked: 10, lowBands: [...low] },
  };
}
