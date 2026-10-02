/**
 * The M&E layer's rules — pure, no database.
 *
 *   PROGRAMME → OUTCOMES → INDICATORS → TARGETS → ACTUALS → EVIDENCE → REPORT
 *
 * An indicator's actual for a period (a term or a school year) and a scope
 * (the whole programme, a county, or a school) comes from one of:
 *   - kobo:   the portal's VALIDATED Kobo records (counted ones only) — a
 *             count, a share choosing given options, an average, or a share
 *             at/above a threshold;
 *   - portal: a measure the portal already computes (intelligence.ts) —
 *             completion, marks, reach, visits…;
 *   - manual: a value someone enters, with evidence.
 * Achievement compares the actual with the target, the right way round for
 * indicators that should go down.
 */

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

export const UNITS = ["percent", "count", "number"] as const;
export type Unit = (typeof UNITS)[number];
export const SOURCES = ["kobo", "portal", "manual"] as const;
export type Source = (typeof SOURCES)[number];
export const KOBO_MEASURES = ["count", "percent_choice", "mean", "percent_at_least"] as const;
export type KoboMeasure = (typeof KOBO_MEASURES)[number];
export type Scope = { type: "programme" | "county" | "school"; id: string; label: string };
export type Computed = { value: number | null; numerator: number | null; denominator: number | null; n: number; method: string };

const r1 = (n: number) => Math.round(n * 10) / 10;
const pct = (num: number, den: number) => (den > 0 ? r1((num / den) * 100) : null);

/* ------------------------------------------------------------ portal measures */

/** Measures the portal already computes, by key. `intel` is one
    buildIntelligence() result for the period and scope. */
export const PORTAL_METRICS: Record<string, { label: string; unit: Unit; get: (intel: Row, cfg: Row) => Computed }> = {
  completion_rate: {
    label: "Work handed in (% of assignments set)", unit: "percent",
    get: (i) => { const c = i.learning.completion; return { value: c.rate, numerator: c.submitted, denominator: c.assigned, n: c.assigned, method: "Assignments handed in ÷ learner × assignment pairs expected" }; },
  },
  average_mark: {
    label: "Average mark on marked work (%)", unit: "percent",
    get: (i) => { const a = i.learning.achievement; return { value: a.averagePercent, numerator: null, denominator: null, n: a.marked, method: "Mean percentage of marked submissions" }; },
  },
  meeting_expectations: {
    label: "Marked work at Meeting or Exceeding Expectations (%)", unit: "percent",
    get: (i) => { const a = i.learning.achievement; const ok = (a.bands.EE ?? 0) + (a.bands.ME ?? 0); return { value: pct(ok, a.marked), numerator: ok, denominator: a.marked, n: a.marked, method: "Marked submissions in bands EE or ME ÷ marked submissions" }; },
  },
  learners_enrolled: {
    label: "Learners enrolled (active)", unit: "count",
    get: (i) => ({ value: i.learning.totals.learners, numerator: null, denominator: null, n: i.learning.totals.learners, method: "Active learners on roll" }),
  },
  teachers_active: {
    label: "Teachers active on the portal (%)", unit: "percent",
    get: (i) => { const p = i.impact.teacherParticipation; return { value: p.active.rate, numerator: p.active.count, denominator: p.teachers, n: p.teachers, method: "Teachers who set work, marked, used the library or answered a form ÷ active teachers" }; },
  },
  teachers_setting_work: {
    label: "Teachers setting work on the portal (%)", unit: "percent",
    get: (i) => { const p = i.impact.teacherParticipation; return { value: p.settingWork.rate, numerator: p.settingWork.count, denominator: p.teachers, n: p.teachers, method: "Teachers who published an assignment ÷ active teachers" }; },
  },
  library_learner_reach: {
    label: "Learners using the Digital Library (%)", unit: "percent",
    get: (i) => { const l = i.learning.library; return { value: l.learnerReach, numerator: l.learnersUsing, denominator: i.learning.totals.learners, n: i.learning.totals.learners, method: "Learners who opened a library resource ÷ active learners" }; },
  },
  schools_visited: {
    label: "Schools visited by field officers (%)", unit: "percent",
    get: (i, cfg) => {
      const s = i.implementation.schools;
      if (cfg.visitType) {
        const t = i.implementation.byType.find((x: Row) => x.label === cfg.visitType);
        return { value: pct(t?.schools ?? 0, s.total), numerator: t?.schools ?? 0, denominator: s.total, n: s.total, method: `Schools with a ${cfg.visitType} visit ÷ schools` };
      }
      return { value: s.coverage, numerator: s.visited, denominator: s.total, n: s.total, method: "Schools with a field visit ÷ schools" };
    },
  },
  field_visits: {
    label: "Field visits made", unit: "count",
    get: (i, cfg) => {
      const n = cfg.visitType ? (i.implementation.byType.find((x: Row) => x.label === cfg.visitType)?.visits ?? 0) : i.implementation.visits;
      return { value: n, numerator: null, denominator: null, n, method: cfg.visitType ? `${cfg.visitType} visits recorded` : "Field visits recorded" };
    },
  },
};

/* ------------------------------------------------------------ Kobo measures */

const blank = (v: unknown) => v == null || v === "" || (Array.isArray(v) && !v.length);

/** An indicator from validated Kobo records already narrowed to the form,
    period and scope. */
export function koboMeasure(records: Row[], cfg: Row): Computed {
  const q = cfg.question as string | undefined;
  const label = cfg.questionLabel ? `“${cfg.questionLabel}”` : q ? `“${q}”` : "";
  switch (cfg.measure as KoboMeasure) {
    case "count":
      return { value: records.length, numerator: null, denominator: null, n: records.length, method: "Validated submissions" };
    case "percent_choice": {
      const want = new Set((cfg.choices ?? []).map(String));
      const answered = records.filter((r) => !blank(r.answers?.[q!]));
      const hit = answered.filter((r) => {
        const v = r.answers[q!];
        return Array.isArray(v) ? v.some((x) => want.has(String(x))) : want.has(String(v));
      });
      return {
        value: pct(hit.length, answered.length), numerator: hit.length, denominator: answered.length, n: answered.length,
        method: `Submissions answering ${label} with ${[...want].join(" / ")} ÷ submissions answering it`,
      };
    }
    case "mean": {
      const nums = records.map((r) => Number(r.answers?.[q!])).filter((n) => Number.isFinite(n));
      return {
        value: nums.length ? r1(nums.reduce((a, b) => a + b, 0) / nums.length) : null, numerator: null, denominator: null,
        n: nums.length, method: `Average of ${label}`,
      };
    }
    case "percent_at_least": {
      const nums = records.map((r) => Number(r.answers?.[q!])).filter((n) => Number.isFinite(n));
      const hit = nums.filter((n) => n >= Number(cfg.threshold)).length;
      return {
        value: pct(hit, nums.length), numerator: hit, denominator: nums.length, n: nums.length,
        method: `Submissions with ${label} ≥ ${cfg.threshold} ÷ submissions answering it`,
      };
    }
  }
  return { value: null, numerator: null, denominator: null, n: 0, method: "Unknown measure" };
}

/** Kobo records that count (valid, or accepted by a person), in the
    period and scope. */
export function koboInScope(records: Row[], formId: string, range: { from: string; to: string }, scope: Scope): Row[] {
  return records.filter((r) =>
    r.kobo_form_id === formId && r.status !== "removed" && r.review !== "excluded" &&
    (r.status === "valid" || r.review === "accepted") &&
    !!r.observed_on && String(r.observed_on) >= range.from && String(r.observed_on) <= range.to &&
    (scope.type === "programme" || (scope.type === "county" ? r.county === scope.id : r.school_id === scope.id)));
}

/** Checks an indicator's source settings; returns the clean config or a problem. */
export function cleanSourceConfig(source: string, raw: Row, kobo?: { fields: { xpath: string; label: string; type: string }[] } | null):
  { config: Row } | { error: string } {
  if (source === "manual") return { config: {} };
  if (source === "portal") {
    const key = String(raw.metric ?? "");
    if (!PORTAL_METRICS[key]) return { error: "Choose a portal measure" };
    const config: Row = { metric: key };
    if (raw.visitType) config.visitType = String(raw.visitType);
    return { config };
  }
  if (source === "kobo") {
    if (!raw.formId) return { error: "Choose a Kobo survey" };
    const measure = String(raw.measure ?? "") as KoboMeasure;
    if (!KOBO_MEASURES.includes(measure)) return { error: "Choose how to measure it" };
    const config: Row = { formId: String(raw.formId), measure };
    if (measure !== "count") {
      const f = kobo?.fields.find((x) => x.xpath === raw.question);
      if (!f) return { error: "Choose a question from the survey (sync it first if the list is empty)" };
      config.question = f.xpath;
      config.questionLabel = f.label;
      if (measure === "percent_choice") {
        const choices = (Array.isArray(raw.choices) ? raw.choices : String(raw.choices ?? "").split(",")).map((x: unknown) => String(x).trim()).filter(Boolean);
        if (!choices.length) return { error: "Say which answer(s) count" };
        config.choices = choices;
      }
      if (measure === "percent_at_least") {
        const t = Number(raw.threshold);
        if (!Number.isFinite(t)) return { error: "Give the threshold as a number" };
        config.threshold = t;
      }
    }
    return { config };
  }
  return { error: "Source must be kobo, portal or manual" };
}

/* ------------------------------------------------------------ periods, targets, achievement */

/** A term id ("2026-T2") or a school year ("2026") → its dates and a label. */
export function periodRange(period: string, terms: Row[], years: Row[]) {
  const t = terms.find((x) => x.id === period);
  if (t) {
    const m = /^(\d{4})-T(\d)$/.exec(t.id);
    return { from: String(t.starts_on), to: String(t.ends_on), label: m ? `${m[1]} Term ${m[2]}` : t.id, kind: "term" as const };
  }
  const y = years.find((x) => x.id === period);
  if (y) return { from: String(y.starts_on), to: String(y.ends_on), label: `${y.id} school year`, kind: "year" as const };
  return null;
}

/** The target that applies: the scope's own, else the programme-wide one. */
export function targetFor(targets: Row[], indicatorId: string, period: string, scope: Scope) {
  const own = targets.find((t) => t.indicator_id === indicatorId && t.period === period && t.scope_type === scope.type && (t.scope_id ?? "") === scope.id);
  if (own) return { value: Number(own.target_value), from: "scope" as const, row: own };
  if (scope.type !== "programme") {
    const prog = targets.find((t) => t.indicator_id === indicatorId && t.period === period && t.scope_type === "programme");
    if (prog) return { value: Number(prog.target_value), from: "programme" as const, row: prog };
  }
  return null;
}

/** How much of the target is achieved (%), the right way round for
    indicators meant to go down; and a traffic light: met (≥ 100%),
    close (≥ 80%), not met. */
export function achievement(actual: number | null, target: number | null, direction: "increase" | "decrease" = "increase") {
  if (actual == null || target == null) return { percent: null, status: "no_data" as const };
  let ratio: number;
  if (direction === "decrease") ratio = actual <= 0 ? 1 : target / actual;
  else ratio = target === 0 ? (actual >= 0 ? 1 : 0) : actual / target;
  const percent = r1(ratio * 100);
  return { percent, status: percent >= 100 ? "met" as const : percent >= 80 ? "close" as const : "not_met" as const };
}
