/**
 * Findings for the impact dashboards — pure, no database
 * (GET /impact/insights and GET /admin/overview → insights; docs/INSIGHTS.md).
 *
 * A finding is one sentence worked out from records by the rules below,
 * never written freely: each names its reporting period, what it rests on
 * (how many schools, people or records) and where those records are, and —
 * where it is a gap someone can act on — the page that already deals with
 * it. The rules (28 October 2026):
 *   - only from the figures handed in: a target only where M&E approved one
 *     for this place and period; a change only against a comparable point
 *     (the same day of the term before, or two recorded actuals, or a
 *     recorded baseline); a comparison of schools only among schools with
 *     enough behind them;
 *   - never a cause: a finding says what the records show, not why;
 *   - reach, taking part, resource use, skills and learning outcomes are
 *     named apart (`measure`), and teacher-marked classwork is never called
 *     a change in learning — different work is set each term;
 *   - nothing missing is filled in: no value is "no value", never 0;
 *   - no new tasks or reminders: a gap links to an existing page, and
 *     overdue forms are already reminded by notifications.ts.
 */
import type { buildAdminResults } from "./admin_impact.ts";
import type { ImpactInput } from "./impact.ts";
import { missingVisitForms } from "./notifications.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;
type Results = ReturnType<typeof buildAdminResults>;

/** What kind of finding: how it was worked out. */
export type Kind = "target" | "change" | "schools" | "reporting" | "gap" | "baseline" | "evidence";
/** What it is about. Kept apart so taking part is never read as learning. */
export type Measure = "reach" | "participation" | "resources" | "skills" | "learning" | "implementation" | "reporting" | "indicator";
/** Which dashboard it belongs on (besides the overviews). */
export type Area = "reach" | "learning" | "teachers" | "field" | "resources" | "me";
/** Where to act or see the records: the first of these the viewer may open. */
export type Link = { page: string; label: string; params?: Record<string, string>; indicator?: string };

export type Insight = {
  key: string;
  kind: Kind;
  measure: Measure;
  area: Area;
  tone: "attention" | "positive" | "neutral";
  text: string;
  /** The reporting period, in words. */
  period: string;
  /** What it rests on: the schools, people or records behind it. */
  base: string;
  /** Where the records are. */
  source: string;
  /** A caveat that keeps it from being over-read, or "". */
  note: string;
  links: Link[];
  /** It says what a headline card already shows (its target, its change on the
      term before): a page with those cards leaves it out (insights-ui.js). */
  card?: boolean;
  /** Smaller first. */
  rank: number;
};

/** One M&E indicator for the period and place, as GET /mel/dashboard returns it. */
export type MelRow = {
  id: string; code?: string; name: string; unit: string; direction?: string; source?: string;
  dashboardTheme?: string | null; sourceConfig?: Row;
  baselineValue?: number | null; baselinePeriod?: string | null;
  target: { value: number; from: string } | null;
  value: number | null;
  valueSource: string;
  achievement: { percent: number | null; status: string };
  basis?: { n: number | null; numerator: number | null; denominator: number | null } | null;
  /** Recorded actuals for this place, oldest first, up to this period (rejected ones left out). */
  history?: { period: string; label: string; value: number; status: string }[];
};
export type MelForInsights = { period: { id: string; label: string } | null; scope: { type: string; id: string; label: string }; indicators: MelRow[] };
/** An indicator with approved targets for single schools this period, and each school's value. */
export type SchoolTargets = {
  indicator: Pick<MelRow, "id" | "code" | "name" | "unit" | "dashboardTheme" | "source" | "sourceConfig">;
  rows: { schoolId: string; school: string; target: number; value: number | null; percent: number | null; status: string }[];
};
/** M&E reporting for the last term that has ended (the whole programme's). */
export type MelReporting = {
  period: { id: string; label: string };
  withTarget: number;
  missing: { code: string; name: string }[];
  unverified: number;
  /** null: no M&E report has ever been made, so none is expected. */
  report: "final" | "draft" | "none" | null;
};

export type InsightInput = {
  results: Results;
  /** The rows the dashboards read, already narrowed to the viewer's area. */
  input: ImpactInput;
  place: { county?: string | null; school?: string | null };
  mel: MelForInsights | null;
  schoolTargets: SchoolTargets[];
  melReporting: MelReporting | null;
  now?: Date;
};

/* ------------------------------------------------------------------ wording */

const fmt = (v: number) => Math.round(v).toLocaleString("en");
/** A percentage as the cards show it: one decimal where there is one (53.9%, 60%). */
const pct1 = (v: number) => `${(Math.round(v * 10) / 10).toLocaleString("en")}%`;
const plural = (v: number, one: string, many = `${one}s`) => `${fmt(v)} ${v === 1 ? one : many}`;
const day = (v: unknown) => String(v ?? "").slice(0, 10);
const joinAnd = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
/** "A, B and C" — or "A, B, C and 4 more". */
export const someOf = (names: string[], max = 3) =>
  names.length <= max ? joinAnd(names) : `${names.slice(0, max).join(", ")} and ${fmt(names.length - max)} more`;
export function value(v: number | null | undefined, unit: string) {
  if (v == null) return "no value";
  if (unit === "percent") return pct1(v);
  if (unit === "number") return (Math.round(v * 10) / 10).toLocaleString("en");
  return fmt(v);
}
function delta(d: number, unit: string) {
  const a = Math.round(Math.abs(d) * 10) / 10;
  if (unit === "percent") return `${a.toLocaleString("en")} ${a === 1 ? "point" : "points"}`;
  if (unit === "number") return (Math.round(a * 10) / 10).toLocaleString("en");
  return fmt(a);
}
const dayWords = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const nameOf = (i: { code?: string; name: string }) => [i.code, i.name].filter(Boolean).join(" ");

/* ------------------------------------------------------------------ what each figure is about */

const THEME: Record<string, [Measure, Area]> = {
  reach: ["reach", "reach"], learning: ["learning", "learning"], teacher_development: ["skills", "teachers"],
  field_operations: ["implementation", "field"], digital_resources: ["resources", "resources"],
};
/** An indicator not tagged for a dashboard: by the portal measure it counts. */
const METRIC: Record<string, [Measure, Area]> = {
  completion_rate: ["participation", "learning"], average_mark: ["learning", "learning"], meeting_expectations: ["learning", "learning"],
  learners_enrolled: ["reach", "reach"], teachers_active: ["participation", "teachers"], teachers_setting_work: ["participation", "teachers"],
  library_learner_reach: ["resources", "resources"], schools_visited: ["implementation", "field"], field_visits: ["implementation", "field"],
};
export function aboutIndicator(i: Pick<MelRow, "dashboardTheme" | "source" | "sourceConfig">): [Measure, Area] {
  return THEME[i.dashboardTheme ?? ""] ?? (i.source === "portal" ? METRIC[i.sourceConfig?.metric ?? ""] : undefined) ?? ["indicator", "me"];
}

/** The programme results that can change term to term (admin_impact.ts), and what each is about. */
const KPI: Record<string, { measure: Measure; area: Area; source: string; links: Link[] }> = {
  participation: {
    measure: "participation", area: "reach", source: "work started or handed in, and Digital Library opens, on the portal",
    links: [{ page: "learners", label: "Learners" }, { page: "reach", label: "Reach" }],
  },
  teachers_trained: {
    measure: "participation", area: "teachers", source: "the training register",
    links: [{ page: "training", label: "Training register" }, { page: "teacher-development", label: "Teacher development" }],
  },
  teachers_digital: {
    measure: "participation", area: "teachers", source: "assignments published on the portal",
    links: [{ page: "assignments", label: "Assignments" }, { page: "teacher-development", label: "Teacher development" }],
  },
  schools_supported: {
    measure: "implementation", area: "field", source: "field visits filed on the portal",
    links: [{ page: "field-visits", label: "Field visits" }, { page: "field-operations", label: "Field operations" }],
  },
  teacher_resources: {
    measure: "resources", area: "teachers", source: "Digital Library and Teacher Resources opens",
    links: [{ page: "teacher-development", label: "Teacher development" }, { page: "digital-resources", label: "Digital resources" }],
  },
};

/** Where a change on the term before is big enough to say: 5 points on a share,
    or for a count 3 or more and a fifth of what it was — and never on fewer than 5. */
export const CHANGE_RULE = { points: 5, count: 3, countShare: 0.2, minBase: 5 } as const;
/** Schools are compared only when 3 or more have enough work set, and only a gap of 20 points or more is said. */
export const SPREAD_RULE = { minSchools: 3, gap: 20 } as const;

/* ------------------------------------------------------------------ building it */

export function buildInsights(x: InsightInput): Insight[] {
  const { results: r, mel } = x;
  const now = x.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const period = r.period.underway ? `${r.period.label} so far` : r.period.label;
  const out: Insight[] = [];
  const add = (i: Omit<Insight, "note" | "links" | "base"> & Partial<Pick<Insight, "note" | "links" | "base">>) =>
    out.push({ note: "", links: [], base: "", ...i });

  // ---- 1. change on the same point of the term before (programme results)
  for (const k of r.kpis) {
    const about = KPI[k.key];
    const before = k.previous?.value;
    if (!about || k.value == null || before == null || (k.base ?? 0) < CHANGE_RULE.minBase) continue;
    const d = k.value - before;
    const big = k.unit === "percent"
      ? Math.abs(d) >= CHANGE_RULE.points
      : Math.abs(d) >= CHANGE_RULE.count && Math.abs(d) >= CHANGE_RULE.countShare * Math.max(before, 1);
    if (!big) continue;
    add({
      key: `change:${k.key}`, kind: "change", measure: about.measure, area: about.area, tone: d > 0 ? "positive" : "attention",
      text: `${k.label}: ${value(k.value, k.unit)}, ${d > 0 ? "up" : "down"} from ${value(before, k.unit)} at ${k.previous!.period}.`,
      period, base: k.of, source: about.source, note: k.caveat, links: about.links, card: true,
      rank: (d > 0 ? 240 : 150) + Math.max(0, 40 - Math.round(Math.abs(d))),
    });
  }

  // ---- 2. against the approved targets for this place (M&E)
  const own = (i: MelRow) => !!i.target && (mel!.scope.type === "programme" || i.target.from === "scope");
  if (mel?.period) {
    const where = mel.scope.type === "programme" ? "" : mel.scope.label;
    const noValue: MelRow[] = [];
    for (const i of mel.indicators.filter(own)) {
      if (i.value == null) { noValue.push(i); continue; }
      const [measure, area] = aboutIndicator(i);
      const p = i.achievement.percent;
      const t = i.target!.value;
      const met = i.achievement.status === "met";
      const text = where
        ? met ? `${where} has met its approved target for ${nameOf(i)}: ${value(i.value, i.unit)} against ${value(t, i.unit)}.`
          : `${where} has achieved ${pct1(p ?? 0)} of its approved target for ${nameOf(i)} (${value(i.value, i.unit)} against ${value(t, i.unit)}).`
        : met ? `${nameOf(i)}: ${value(i.value, i.unit)}, meeting its approved target of ${value(t, i.unit)} (${pct1(p ?? 0)} of the target).`
          : `${nameOf(i)}: ${value(i.value, i.unit)} against an approved target of ${value(t, i.unit)}, ${pct1(p ?? 0)} of the target.`;
      add({
        key: `target:${i.id}`, kind: "target", measure, area,
        tone: met ? "positive" : i.achievement.status === "close" ? "neutral" : "attention",
        text, period: mel.period.label, base: basisWords(i), source: sourceWords(i), links: indicatorLinks(i),
        // The Administration overview's cards carry this target already.
        card: r.kpis.some((k) => k.target?.indicator === nameOf(i)),
        rank: met ? 320 : i.achievement.status === "close" ? 200 + Math.round(100 - (p ?? 0)) : 100 + Math.min(79, Math.round(p ?? 0)),
      });
    }
    if (noValue.length) {
      add({
        key: "reporting:no-value", kind: "reporting", measure: "reporting", area: "me", tone: "neutral",
        text: `${fmt(noValue.length)} of ${plural(mel.indicators.filter(own).length, "indicator")} with an approved target for ${mel.period.label} ${noValue.length === 1 ? "has" : "have"} no value yet: ${someOf(noValue.map(nameOf))}.`,
        period: mel.period.label, source: "M&E targets and actuals",
        note: "An indicator recorded by hand has a value once an actual is recorded.",
        links: [{ page: "mel-results", label: "Indicator results" }], rank: 270,
      });
    }
  }

  // ---- 3. schools against their own approved targets
  for (const st of x.schoolTargets) {
    const rows = st.rows;
    if (!rows.length) continue;
    const [measure, area] = aboutIndicator(st.indicator);
    const label = nameOf(st.indicator);
    const assessment = measure === "learning";
    const known = rows.filter((s) => s.value != null);
    const pPeriod = mel?.period?.label ?? period;
    if (known.length < rows.length) {
      const missing = rows.filter((s) => s.value == null).map((s) => s.school);
      add({
        key: `reporting:school-targets:${st.indicator.id}`, kind: "reporting", measure: assessment ? "learning" : "reporting", area,
        tone: "attention",
        text: `${assessment ? "Assessment results are" : "Values are"} available for ${fmt(known.length)} of ${plural(rows.length, "school")} with an approved target for ${label}.`,
        period: pPeriod, base: `No ${assessment ? "results" : "value"} yet: ${someOf(missing)}`, source: `M&E indicator ${st.indicator.code || label}: school targets and actuals`,
        links: indicatorLinks(st.indicator), rank: 140,
      });
    }
    if (!known.length) continue;
    const met = known.filter((s) => s.status === "met").length;
    const furthest = [...known].filter((s) => s.status !== "met" && s.percent != null).sort((a, b) => a.percent! - b.percent!)[0];
    const one = known.length === 1 ? known[0] : null;
    add({
      key: `schools:target:${st.indicator.id}`, kind: "schools", measure, area,
      tone: met === known.length ? "positive" : "attention",
      text: one
        ? one.status === "met" ? `${one.school} has met its approved target for ${label}: ${value(one.value, st.indicator.unit)} against ${value(one.target, st.indicator.unit)}.`
          : `${one.school} has achieved ${pct1(one.percent ?? 0)} of its approved target for ${label} (${value(one.value, st.indicator.unit)} against ${value(one.target, st.indicator.unit)}).`
        : `${fmt(met)} of ${plural(known.length, "school")} with ${assessment ? "results" : "a value"} ${met === 1 ? "has" : "have"} met ${met === 1 ? "its" : "their"} approved target for ${label}${
          furthest ? `; furthest from it: ${furthest.school}, at ${pct1(furthest.percent!)} of its target` : ""}.`,
      period: pPeriod, base: `${plural(rows.length, "school")} with an approved target`,
      source: `M&E indicator ${st.indicator.code || label}: school targets and actuals`, links: indicatorLinks(st.indicator),
      rank: met === known.length ? 330 : 160,
    });
  }

  // ---- 4. differences between schools: work handed in, where enough was set
  const minSet = r.rules.minAssigned;
  const enough = r.schools.filter((s) => s.assigned >= minSet && s.completionRate != null);
  if (enough.length >= SPREAD_RULE.minSchools) {
    const sorted = [...enough].sort((a, b) => a.completionRate! - b.completionRate! || a.school.localeCompare(b.school));
    const lo = sorted[0], hi = sorted.at(-1)!;
    if (hi.completionRate! - lo.completionRate! >= SPREAD_RULE.gap) {
      add({
        key: "schools:completion", kind: "schools", measure: "participation", area: "learning", tone: "neutral",
        text: `Work handed in ranges from ${value(lo.completionRate, "percent")} at ${lo.school} to ${value(hi.completionRate, "percent")} at ${hi.school}.`,
        period, base: `${plural(enough.length, "school")} with ${fmt(minSet)} or more pieces of work set`,
        source: "assignments and work handed in on the portal",
        note: "Handing work in is taking part, not a learning result.",
        links: [{ page: "admin-detail", label: "School by school" }, { page: "learning", label: "Learning" }], rank: 210,
      });
    }
  }

  // ---- 5. gaps between what the programme expects and what the records show
  const withLearners = r.schools.filter((s) => s.learners > 0);
  const rule = (name: string) => r.support.find((s) => s.rule === name);
  const notVisited = r.schools.filter((s) => !s.visits);
  if (r.schools.length && notVisited.length) {
    add({
      key: "gap:not-visited", kind: "gap", measure: "implementation", area: "field", tone: "attention",
      text: `${fmt(notVisited.length)} of ${plural(r.schools.length, "school")} ${notVisited.length === 1 ? "has" : "have"} had no field visit in ${period}.`,
      period, base: someOf(notVisited.map((s) => s.school)), source: "field visits filed on the portal",
      note: r.period.underway ? `Day ${fmt(r.period.day)} of ${fmt(r.period.days)} of the term.` : "",
      links: [{ page: "field-visits", label: "Field visits" }, { page: "field-operations", label: "Field operations" }],
      rank: 230 + Math.round(30 * (1 - notVisited.length / r.schools.length)),
    });
  }
  const noWork = rule("No work set");
  if (noWork && withLearners.length) {
    add({
      key: "gap:no-work", kind: "gap", measure: "implementation", area: "learning", tone: "attention",
      text: `${fmt(noWork.count)} of ${plural(withLearners.length, "school")} with learners ${noWork.count === 1 ? "has" : "have"} had no work set on the portal in ${period}.`,
      period, base: someOf(noWork.schools), source: "assignments published on the portal",
      links: [{ page: "admin-detail", label: "School by school" }, { page: "assignments", label: "Assignments" }, { page: "learning", label: "Learning" }],
      rank: 235,
    });
  }
  const noTeacher = rule("No active teacher");
  if (noTeacher) {
    add({
      key: "gap:no-teacher", kind: "gap", measure: "implementation", area: "reach", tone: "attention",
      text: `${plural(noTeacher.count, "school")} with learners on roll ${noTeacher.count === 1 ? "has" : "have"} no active teacher account.`,
      period: "On roll now", base: someOf(noTeacher.schools), source: "learner and staff accounts",
      links: [{ page: "teachers", label: "Teachers" }], rank: 225,
    });
  }

  // ---- 6. programme reports that are overdue or missing
  const since = r.previous?.from ?? r.period.from;
  for (const f of formsOverdue(x.input, x.place, since, today)) {
    const who = f.unit === "school" ? "school" : f.unit;
    const verb = f.unit === "school" ? (f.missing.length === 1 ? "hasn't sent" : "haven't sent") : (f.missing.length === 1 ? "hasn't answered" : "haven't answered");
    add({
      key: `reporting:form:${f.id}`, kind: "reporting", measure: "reporting", area: "field", tone: "attention",
      text: `${fmt(f.missing.length)} of ${plural(f.expected, who)} ${verb} “${f.title}”, due ${dayWords(f.dueOn)}.`,
      period: `Due ${dayWords(f.dueOn)}`,
      base: f.unit === "school" ? `Not sent: ${someOf(f.missing)} · of the schools with an active head` : `Of the active ${f.unit}s it was sent to`,
      source: "forms and their responses on the portal", note: "The portal already reminds each of them.",
      links: [{ page: "forms", label: "Forms" }], rank: 110 + Math.round(20 * (1 - f.missing.length / f.expected)),
    });
  }
  const v = visitsWithoutForms(x.input, x.place, r.period.from, r.period.to);
  if (v.missing) {
    add({
      key: "reporting:visit-forms", kind: "reporting", measure: "reporting", area: "field", tone: "attention",
      text: `${fmt(v.missing)} of ${plural(v.visits, "field visit")} in ${period} ${v.missing === 1 ? "was" : "were"} filed without all ${v.missing === 1 ? "its" : "their"} forms.`,
      period, base: someOf(v.schools), source: "field visits and the visit forms filled in",
      note: "Field officers are reminded for 30 days after each visit.",
      links: [{ page: "field-visits", label: "Field visits" }], rank: 130,
    });
  }
  const m = x.melReporting;
  if (m) {
    if (m.missing.length) {
      add({
        key: "reporting:actuals", kind: "reporting", measure: "reporting", area: "me", tone: "attention",
        text: `${m.period.label} has ended, and ${fmt(m.missing.length)} of ${plural(m.withTarget, "indicator")} with an approved target ${m.missing.length === 1 ? "has" : "have"} no recorded actual.`,
        period: m.period.label, base: someOf(m.missing.map(nameOf)), source: "M&E targets and recorded actuals",
        links: [{ page: "mel-results", label: "Record actuals" }], rank: 105,
      });
    }
    if (m.unverified) {
      add({
        key: "reporting:unverified", kind: "reporting", measure: "reporting", area: "me", tone: "attention",
        text: `${plural(m.unverified, "recorded actual")} for ${m.period.label} ${m.unverified === 1 ? "is" : "are"} waiting to be verified.`,
        period: m.period.label, source: "M&E recorded actuals", links: [{ page: "mel-results", label: "Verify" }], rank: 125,
      });
    }
    if (m.report === "draft" || m.report === "none") {
      add({
        key: "reporting:report", kind: "reporting", measure: "reporting", area: "me", tone: "attention",
        text: m.report === "draft" ? `The ${m.period.label} M&E report is still a draft.` : `No M&E report has been made for ${m.period.label} yet.`,
        period: m.period.label, source: "M&E reports", note: m.report === "none" ? "Earlier periods have one." : "",
        links: [{ page: "mel-reports", label: "M&E reports" }], rank: 135,
      });
    }
  }

  // ---- 7. baseline to follow-up, and one recorded period to the next (M&E).
  // An indicator's baseline is the whole programme's: it is set against the
  // programme's own follow-up only, never one county's or school's.
  const programme = mel?.scope.type === "programme";
  let learningBaseline = false;
  for (const i of mel?.indicators ?? []) {
    const h = (i.history ?? []).filter((p) => p.value != null);
    const last = h.at(-1);
    if (!last) continue;
    const [measure, area] = aboutIndicator(i);
    const good = (d: number) => (i.direction === "decrease" ? d < 0 : d > 0);
    if (programme && i.baselineValue != null && (!i.baselinePeriod || i.baselinePeriod !== last.label)) {
      const d = last.value - i.baselineValue;
      if (measure === "learning") learningBaseline = true;
      add({
        key: `baseline:${i.id}`, kind: "baseline", measure, area, tone: d === 0 ? "neutral" : good(d) ? "positive" : "attention",
        text: `${nameOf(i)}: ${value(last.value, i.unit)} in ${last.label}, from ${value(i.baselineValue, i.unit)} at baseline${i.baselinePeriod ? ` (${i.baselinePeriod})` : ""}${
          d === 0 ? ": no change." : `: ${d > 0 ? "up" : "down"} ${delta(d, i.unit)}.`}`,
        period: `${i.baselinePeriod ? `${i.baselinePeriod} to ` : "Baseline to "}${last.label}`,
        source: `M&E indicator ${i.code || i.name}: baseline and a ${last.status === "verified" ? "verified" : "recorded (not yet verified)"} actual`,
        note: "The same indicator at both points; this alone doesn't show what caused the change.",
        links: indicatorLinks(i), rank: measure === "learning" ? 170 : 190,
      });
      continue;
    }
    const prev = h.at(-2);
    if (!prev || !/-T\d$/.test(prev.period) || !/-T\d$/.test(last.period)) continue;
    const d = last.value - prev.value;
    const big = i.unit === "percent" ? Math.abs(d) >= CHANGE_RULE.points : Math.abs(d) >= CHANGE_RULE.countShare * Math.max(Math.abs(prev.value), 1);
    if (!big) continue;
    add({
      key: `change:mel:${i.id}`, kind: "change", measure, area, tone: good(d) ? "positive" : "attention",
      text: `${nameOf(i)}: ${value(last.value, i.unit)} in ${last.label}, ${d > 0 ? "up" : "down"} from ${value(prev.value, i.unit)} in ${prev.label}.`,
      period: `${prev.label} to ${last.label}`, source: `M&E indicator ${i.code || i.name}: recorded actuals`,
      note: last.status === "verified" && prev.status === "verified" ? "" : "Not every value here is verified yet.",
      links: indicatorLinks(i), rank: 220,
    });
  }
  // Said once, so a learning change is never read into classwork marks.
  if (programme && !learningBaseline) {
    add({
      key: "evidence:learning", kind: "evidence", measure: "learning", area: "learning", tone: "neutral",
      text: "No learning assessment has both a baseline and a follow-up result yet, so no change in learning outcomes can be reported.",
      period: mel.period?.label ?? period, source: "M&E indicators about learning",
      note: "Classwork marks aren't a like-for-like measure from term to term: different work is set each term.",
      links: [{ page: "mel-framework", label: "Results framework" }], rank: 400,
    });
  }

  return out.sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key));
}

function basisWords(i: MelRow) {
  const b = i.basis;
  if (!b) return "";
  if (b.denominator != null && b.numerator != null) return `${fmt(b.numerator)} of ${fmt(b.denominator)}`;
  if (b.n) return `${plural(b.n, i.source === "kobo" ? "survey record" : "record")}`;
  return "";
}
function sourceWords(i: MelRow) {
  const code = `M&E indicator ${i.code || i.name}`;
  if (i.valueSource === "verified") return `${code}: verified actual`;
  if (i.valueSource === "recorded") return `${code}: recorded actual, not yet verified`;
  return `${code}: worked out from ${i.source === "kobo" ? "Kobo survey records" : "the portal's records"}, not yet recorded`;
}
const indicatorLinks = (i: { id: string }): Link[] => [{ page: "me-dashboard", label: "Indicator", indicator: i.id }, { page: "mel-results", label: "Indicator results" }];

/* ------------------------------------------------------------------ reporting, from the rows */

/** The schools in view: the area's, narrowed to the county or school picked. */
function placeSchools(d: ImpactInput, place: InsightInput["place"]) {
  const same = (a: unknown, b: unknown) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
  return d.schools.filter((s) => (!place.county || same(s.county, place.county)) && (!place.school || s.name === place.school));
}

/** Forms with a due date that has passed (since `since`), and who hasn't answered:
    a school head's form by school (any active head answering counts for the
    school), a teacher's or field officer's by person. Visit forms aren't due on a date. */
export function formsOverdue(d: ImpactInput, place: InsightInput["place"], since: string, today: string) {
  const schools = placeSchools(d, place);
  const ids = new Set(schools.map((s) => s.id));
  const countyOfSchool = new Map(d.schools.map((s) => [s.id, s.county as string]));
  const nameOfSchool = new Map(d.schools.map((s) => [s.id, s.name as string]));
  const active = d.profiles.filter((p) => (p.status ?? "active") === "active");
  const same = (a: unknown, b: unknown) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
  const out: { id: string; title: string; dueOn: string; unit: "school" | "teacher" | "field officer"; expected: number; missing: string[] }[] = [];
  for (const f of d.forms) {
    const due = day(f.due_on);
    if (f.archived_at || f.visit_type || !due || due >= today || due < since) continue;
    const forForm = (p: Row) => !f.county || same(p.county ?? countyOfSchool.get(p.school_id), f.county);
    const answered = new Set(d.responses.filter((x) => x.form_id === f.id && !x.visit_id).map((x) => x.respondent_id));
    if (f.audience === "school_leader") {
      const heads = active.filter((p) => p.role === "school_leader" && ids.has(p.school_id) && forForm(p));
      const bySchool = new Map<string, Row[]>();
      for (const h of heads) bySchool.set(h.school_id, [...(bySchool.get(h.school_id) ?? []), h]);
      const missing = [...bySchool.entries()].filter(([, hs]) => !hs.some((h) => answered.has(h.id))).map(([id]) => nameOfSchool.get(id) ?? id).sort();
      if (bySchool.size && missing.length) out.push({ id: f.id, title: String(f.title ?? ""), dueOn: due, unit: "school", expected: bySchool.size, missing });
    } else if (f.audience === "teacher" || f.audience === "field_officer") {
      // A field officer works across schools: their forms count for the whole area or a county, never one school.
      if (f.audience === "field_officer" && place.school) continue;
      const people = active.filter((p) => p.role === f.audience && forForm(p) &&
        (f.audience === "teacher" ? ids.has(p.school_id) : !place.county || same(p.county, place.county)));
      const missing = people.filter((p) => !answered.has(p.id)).map((p) => p.id);
      if (people.length && missing.length) {
        out.push({ id: f.id, title: String(f.title ?? ""), dueOn: due, unit: f.audience === "teacher" ? "teacher" : "field officer", expected: people.length, missing });
      }
    }
  }
  return out.sort((a, b) => b.missing.length / b.expected - a.missing.length / a.expected || a.dueOn.localeCompare(b.dueOn));
}

/** Field visits in the period that were filed without all their visit forms (notifications.ts). */
export function visitsWithoutForms(d: ImpactInput, place: InsightInput["place"], from: string, to: string) {
  const schools = placeSchools(d, place);
  const ids = new Set(schools.map((s) => s.id));
  const scoped = !!(place.county || place.school);
  const visits = d.fieldReports.filter((v) => day(v.created_at) >= from && day(v.created_at) <= to &&
    (!scoped || ids.has(v.school_id) || (!place.school && !v.school_id && String(v.county ?? "").toLowerCase() === String(place.county ?? "").toLowerCase())));
  const without = visits.filter((v) => missingVisitForms(v, d.forms, d.responses).length);
  return { visits: visits.length, missing: without.length, schools: [...new Set(without.map((v) => String(v.school ?? "")).filter(Boolean))].sort() };
}
