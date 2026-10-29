/**
 * Each role's dashboard, tested as that role (Prompt 9, docs/DASHBOARD-HIERARCHY.md):
 * leadership's Administration overview, the Education Team's overview data,
 * M&E's data completeness, the technical Platform overview — and that each
 * read is refused, by the API, to roles it isn't for.
 *
 *   cd supabase/functions/api
 *   deno test --allow-env --allow-read --config deno.json role_views_test.ts
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { buildMelCoverage, TARGET_RULE } from "./coverage.ts";
import { call, freshWorld, SCHOOL } from "./test_world.ts";

const ROLES = ["super_admin", "admin", "me", "education_team", "field_officer", "school_leader", "teacher"] as const;
const status = async (path: string) => Object.fromEntries(await Promise.all(ROLES.map(async (r) => [r, (await call("GET", path, `tok_${r}`)).status])));

Deno.test("roles: each dashboard's read is the API's to refuse, not only the menu's", async () => {
  freshWorld();
  const ok = (s: number) => s >= 200 && s < 300;
  const admin = await status("/admin/overview");
  assertEquals(ROLES.filter((r) => ok(admin[r])), ["super_admin", "admin", "education_team"], "the Programme Admin (Education Team)");
  const impact = await status("/impact");
  assertEquals(ROLES.filter((r) => ok(impact[r])), ["super_admin", "admin", "me", "education_team"], "the impact dashboards (the Programme Admin: the learning side)");
  const coverage = await status("/mel/coverage");
  assertEquals(ROLES.filter((r) => ok(coverage[r])), ["super_admin", "me"], "M&E data completeness");
  const platform = await status("/platform/overview");
  assertEquals(ROLES.filter((r) => ok(platform[r])), ["super_admin"], "the technical overview");
});

Deno.test("roles: the Education Team's overview data — school by school progress, the learning side only", async () => {
  freshWorld();
  const d = (await call("GET", "/impact", "tok_education_team")).json;
  assertEquals(d.learningOnly, true);
  assert(Array.isArray(d.schoolProgress) && d.schoolProgress.length >= 1);
  const aitong = d.schoolProgress.find((s: { school: string }) => s.school === SCHOOL.name);
  assertEquals(aitong.teachers, 2, "Aitong's two active teachers (not the suspended or pending accounts)");
  assertEquals(d.schoolProgress.reduce((t: number, s: { teachers: number }) => t + s.teachers, 0), d.teachers.total, "the schools add up to the total");
  assertEquals(d.fieldOps, undefined, "field operations aren't the learning side");
  assertEquals(d.reach, undefined);
});

Deno.test("roles: M&E data completeness — indicators, reporting coverage, exceptions, surveys", async () => {
  const db = freshWorld();
  db.me_programmes.push({ id: "p1", code: "HPF", name: "Digital learning", status: "active" });
  db.me_outcomes.push({ id: "o1", programme_id: "p1", code: "1", title: "Learners read", position: 0, archived_at: null });
  db.me_indicators.push(
    { id: "i1", outcome_id: "o1", code: "L1", name: "Reading", definition: "Share of learners reading at grade level.", unit: "percent", direction: "increase",
      source: "manual", source_config: {}, baseline_value: 34, baseline_period: "2025", dashboard_theme: "learning", position: 0, archived_at: null },
    { id: "i2", outcome_id: "o1", code: "L2", name: "Assessed", definition: "", unit: "count", direction: "increase", source: "manual", source_config: {}, position: 1, archived_at: null },
  );
  db.me_targets.push({ id: "tg1", indicator_id: "i1", period: "2026-T3", scope_type: "programme", scope_id: "", target_value: 50 });
  db.me_actuals.push({ id: "a1", indicator_id: "i1", period: "2026-T3", scope_type: "programme", scope_id: "", value: 41, source: "manual", status: "verified", superseded_at: null });
  db.me_evidence.push({ id: "e1", actual_id: "a1", kind: "note", title: "Assessment summary" });
  db.me_reports.push({ id: "r1", programme_id: "p1", period: "2026-T2", scope_type: "programme", scope_id: "", title: "T2", status: "final" });
  const res = await call("GET", "/mel/coverage", "tok_me");
  assertEquals(res.status, 200, JSON.stringify(res.json));
  const I = res.json.indicators;
  assertEquals([I.total, I.withDefinition, I.withTarget, I.withValue, I.verified, I.withEvidence, I.withBaseline], [2, 1, 1, 1, 1, 1, 1]);
  const l1 = I.rows.find((r: { code: string }) => r.code === "L1");
  assertEquals([l1.target, l1.value, l1.valueSource, l1.percent, l1.evidence], [50, 41, "verified", 82, 1]);
  assertEquals(I.rule, TARGET_RULE);
  assertEquals(res.json.reporting.reports, [{ period: "2026-T2", label: "2026 Term 2", status: "final" }]);
  assert(Array.isArray(res.json.surveys) && Array.isArray(res.json.exceptions));
});

Deno.test("roles: data completeness, worked out — a county sees only its own targets; exceptions only where there are some", () => {
  const ind = (o: Record<string, unknown>) => ({ id: "x", code: "X", name: "X", unit: "percent", definition: "Defined.", value: 40, valueSource: "live",
    achievement: { percent: 80, status: "close" }, history: [], ...o });
  const cov = buildMelCoverage({
    mel: { period: { id: "2026-T3", label: "2026 Term 3" }, scope: { type: "county", id: "Narok", label: "Narok County" },
      indicators: [ind({ id: "a", target: { value: 50, from: "programme" } }), ind({ id: "b", target: { value: 50, from: "scope" } })] },
    intel: { implementation: { schools: { total: 4, visited: 1 } }, dataCollection: { responseRateOverall: null, responseRates: [],
      quality: [{ key: "kobo_no_school", value: 3 }, { key: "visits_unlinked", value: 0 }], kobo: { schoolsCovered: 2, forms: [], issuesByRule: [] } } },
    evidence: {}, dq: { HIGH: 1, MEDIUM: 0, LOW: 2 }, reports: [],
  });
  assertEquals(cov.indicators.rows.map((r) => r.target), [null, 50], "the programme's target isn't Narok's");
  assertEquals(cov.indicators.rows.map((r) => r.percent), [null, 80]);
  assertEquals(cov.exceptions.map((e) => e!.key), ["dq_open", "kobo_no_school"], "a check with nothing to report isn't listed");
  assertEquals([cov.reporting.schools, cov.reporting.visited, cov.reporting.koboSchools], [4, 1, 2]);
});

Deno.test("roles: the technical overview — availability, sign-in problems, sync failures", async () => {
  const db = freshWorld();
  const week = new Date(Date.now() - 2 * 864e5).toISOString();
  db.sync_events = [
    { id: 1, event: "failed", received_at: week }, { id: 2, event: "conflict", received_at: week },
    { id: 3, event: "retried", received_at: week }, { id: 4, event: "failed", received_at: "2020-01-01T00:00:00Z" },
  ];
  db.audit_log.push({ id: 900, action: "password.reset_link_sent", at: week }, { id: 901, action: "password.reset", at: "2020-01-01T00:00:00Z" });
  const d = (await call("GET", "/platform/overview", "tok_super_admin")).json;
  assertEquals(d.availability.database, "ok");
  assert(typeof d.availability.databaseMs === "number");
  assertEquals(d.syncFailures7d, { failed: 1, conflicts: 1 }, "this week's only");
  assertEquals(d.signIn.passwordResets7d, 1);
  assertEquals(typeof d.signIn.learnersLocked, "number");
});
