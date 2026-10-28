/**
 * M&E data completeness — pure, no database (GET /mel/coverage; the M&E
 * workspace's "Data completeness" page; docs/KPI-DEFINITIONS.md).
 *
 * What the M&E team needs to trust and report the results, for one term
 * and place:
 *   indicators — each one's definition, approved target, value and whether
 *                that value is verified, recorded or only worked out live,
 *                its evidence and its baseline;
 *   reporting  — how many schools have the records reporting rests on this
 *                term (field visits, Kobo records), form responses, and
 *                which terms have a final M&E report;
 *   exceptions — data-quality problems that keep records out of the results;
 *   surveys    — each Kobo survey's records: counted, failing, duplicate,
 *                rejected, and when it last synced.
 * Nothing here is new data: it is the same figures as the dashboards,
 * gathered for checking. Counts, never people's names.
 */
// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

export type CoverageInput = {
  /** GET /mel/dashboard's read for the term and place. */
  mel: { period: { id: string; label: string } | null; scope: { type: string; id: string; label: string }; indicators: Row[] };
  /** buildIntelligence for the term so far and place. */
  intel: Row;
  /** Evidence items on each indicator's current recorded actual, by indicator id. */
  evidence: Record<string, number>;
  /** Open data-quality issues in the place by severity — null without data_quality.view. */
  dq: { HIGH: number; MEDIUM: number; LOW: number } | null;
  /** The whole programme's M&E reports: period, label, status. */
  reports: { period: string; label: string; status: string }[];
};

/** How achievement is worked out (me.ts achievement()), said once on the page. */
export const TARGET_RULE = "Achievement = actual ÷ target (target ÷ actual for an indicator meant to go down). Met at 100% or more, close at 80% or more. The target is the place's own for the period, or the whole programme's for the whole programme only.";

export function buildMelCoverage(x: CoverageInput) {
  const { mel, intel } = x;
  const programme = mel.scope.type === "programme";
  const rows = mel.indicators.map((i) => {
    const target = i.target && (programme || i.target.from === "scope") ? Number(i.target.value) : null;
    return {
      id: String(i.id), code: String(i.code ?? ""), name: String(i.name ?? ""), unit: String(i.unit ?? ""), direction: String(i.direction ?? "increase"),
      definition: String(i.definition ?? "").trim().length > 0,
      source: String(i.source ?? ""),
      target,
      value: i.value ?? null,
      valueSource: String(i.valueSource ?? "none"),
      percent: target != null ? i.achievement?.percent ?? null : null,
      evidence: x.evidence[String(i.id)] ?? 0,
      baseline: i.baselineValue != null ? { value: Number(i.baselineValue), period: i.baselinePeriod ?? null } : null,
      recordedTerms: (i.history ?? []).length,
    };
  });
  const count = (f: (r: (typeof rows)[number]) => boolean) => rows.filter(f).length;
  const I = intel.implementation ?? {}, D = intel.dataCollection ?? {}, K = D.kobo ?? {};
  const quality = (D.quality ?? []) as Row[];
  const qv = (key: string) => quality.find((q) => q.key === key)?.value ?? 0;
  const exceptions = [
    x.dq && x.dq.HIGH + x.dq.MEDIUM + x.dq.LOW
      ? { key: "dq_open", label: "Data issues open", value: x.dq.HIGH + x.dq.MEDIUM + x.dq.LOW, detail: `${x.dq.HIGH} high · ${x.dq.MEDIUM} medium · ${x.dq.LOW} low`, page: "data-quality" } : null,
    qv("kobo_needs_review") ? { key: "kobo_review", label: "Kobo records failing their checks, waiting for a decision", value: qv("kobo_needs_review"), detail: "Kept out of every result until accepted or excluded", page: "kobo" } : null,
    qv("kobo_no_school") ? { key: "kobo_no_school", label: "Kobo records naming no portal school", value: qv("kobo_no_school"), detail: "Register the school or save the name as an alias", page: "kobo" } : null,
    qv("visits_unlinked") ? { key: "visits_unlinked", label: "Field visits not linked to a portal school", value: qv("visits_unlinked"), detail: "Counted as visits, never as a school visited", page: "field-visits" } : null,
    qv("learners_no_class") ? { key: "learners_no_class", label: "Learners not placed in a class", value: qv("learners_no_class"), detail: "They can't be set work or counted in class results", page: "learners" } : null,
    qv("unmarked_overdue") ? { key: "unmarked_overdue", label: "Work waiting over 14 days for a mark", value: qv("unmarked_overdue"), detail: "Results are only as current as the marking", page: "assignments" } : null,
    qv("staff_no_school") ? { key: "staff_no_school", label: "Teachers and school heads with no school", value: qv("staff_no_school"), detail: "Their work can't be counted under any school", page: "teachers" } : null,
  ].filter(Boolean);
  return {
    period: mel.period, scope: mel.scope,
    indicators: {
      total: rows.length,
      withDefinition: count((r) => r.definition),
      withTarget: count((r) => r.target != null),
      withValue: count((r) => r.value != null),
      verified: count((r) => r.valueSource === "verified"),
      recorded: count((r) => r.valueSource === "recorded"),
      live: count((r) => r.valueSource === "live"),
      withEvidence: count((r) => r.evidence > 0),
      withBaseline: count((r) => !!r.baseline),
      rows,
      rule: TARGET_RULE,
    },
    reporting: {
      schools: I.schools?.total ?? 0,
      visited: I.schools?.visited ?? 0,
      koboSchools: K.schoolsCovered ?? 0,
      responseRate: D.responseRateOverall ?? null,
      formsSent: (D.responseRates ?? []).filter((f: Row) => f.kind === "form").length,
      reports: x.reports,
    },
    exceptions,
    surveys: ((K.forms ?? []) as Row[]).map((f) => ({
      title: String(f.title ?? ""), received: Number(f.submissions ?? 0), counted: Number(f.counted ?? 0),
      failing: Number(f.invalid ?? 0), duplicate: Number(f.duplicate ?? 0), rejected: Number(f.rejected ?? 0),
      syncedAt: f.syncedAt ?? null, syncError: f.syncError ?? null,
    })),
    issuesByRule: ((K.issuesByRule ?? []) as Row[]).filter((r) => r.errors || r.warnings),
  };
}
