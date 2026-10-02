/**
 * Unit tests for the M&E rules (me.ts).
 *
 *   cd supabase/functions/api
 *   deno test --config deno.json me_test.ts
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { achievement, cleanSourceConfig, koboInScope, koboMeasure, periodRange, PORTAL_METRICS, targetFor } from "./me.ts";

const TERMS = [
  { id: "2026-T2", starts_on: "2026-05-01", ends_on: "2026-08-31" },
  { id: "2026-T3", starts_on: "2026-09-01", ends_on: "2026-12-31" },
];
const YEARS = [{ id: "2026", starts_on: "2026-01-01", ends_on: "2026-12-31" }];
const rec = (id: string, o: Record<string, unknown>) => ({
  id, kobo_form_id: "f1", status: "valid", review: null, observed_on: "2026-06-10", county: "Narok", school_id: "s1", answers: {}, ...o,
});
const RECORDS = [
  rec("a", { answers: { ict: "yes", learners: 30, tools: ["tablet", "radio"] } }),
  rec("b", { answers: { ict: "no", learners: 20, tools: ["chalk"] } }),
  rec("c", { answers: { ict: "yes", learners: 40 }, school_id: "s2" }),
  rec("d", { answers: { ict: "yes" }, county: "Meru", school_id: "s9" }),
  rec("e", { answers: { ict: "no" }, status: "invalid" }),                     // failed checks: not counted
  rec("f", { answers: { ict: "no" }, status: "invalid", review: "accepted" }),  // a person accepted it: counted
  rec("g", { answers: { ict: "yes" }, review: "excluded" }),                    // excluded by a person
  rec("h", { answers: { ict: "yes" }, observed_on: "2026-09-15" }),             // Term 3
  rec("i", { answers: { ict: "yes" }, kobo_form_id: "f2" }),                    // another survey
];

Deno.test("periods: a term or a school year → dates and a label", () => {
  assertEquals(periodRange("2026-T2", TERMS, YEARS), { from: "2026-05-01", to: "2026-08-31", label: "2026 Term 2", kind: "term" });
  assertEquals(periodRange("2026", TERMS, YEARS)!.label, "2026 school year");
  assertEquals(periodRange("2031-T1", TERMS, YEARS), null);
});

Deno.test("Kobo actuals: only counted records, in the period and scope", () => {
  const t2 = periodRange("2026-T2", TERMS, YEARS)!;
  const all = koboInScope(RECORDS, "f1", t2, { type: "programme", id: "", label: "" });
  assertEquals(all.map((r) => r.id), ["a", "b", "c", "d", "f"]);
  assertEquals(koboInScope(RECORDS, "f1", t2, { type: "county", id: "Narok", label: "" }).map((r) => r.id), ["a", "b", "c", "f"]);
  assertEquals(koboInScope(RECORDS, "f1", t2, { type: "school", id: "s1", label: "" }).map((r) => r.id), ["a", "b", "f"]);
});

Deno.test("Kobo measures: count, share choosing an answer, average, share at a threshold", () => {
  const t2 = periodRange("2026-T2", TERMS, YEARS)!;
  const narok = koboInScope(RECORDS, "f1", t2, { type: "county", id: "Narok", label: "" });
  assertEquals(koboMeasure(narok, { measure: "count" }).value, 4);
  const ict = koboMeasure(narok, { measure: "percent_choice", question: "ict", choices: ["yes"], questionLabel: "ICT integrated?" });
  assertEquals([ict.value, ict.numerator, ict.denominator], [50, 2, 4], "a, c of a, b, c, f");
  assert(ict.method.includes("“ICT integrated?”"));
  assertEquals(koboMeasure(narok, { measure: "percent_choice", question: "tools", choices: ["tablet", "laptop"] }).value, 50, "a multi-select counts if any match; only a, b answered");
  assertEquals(koboMeasure(narok, { measure: "mean", question: "learners" }).value, 30);
  assertEquals(koboMeasure(narok, { measure: "percent_at_least", question: "learners", threshold: 30 }).value, 66.7);
  assertEquals(koboMeasure([], { measure: "percent_choice", question: "ict", choices: ["yes"] }).value, null, "no data is not 0%");
});

Deno.test("portal measures read the intelligence numbers, with their working", () => {
  const intel = {
    learning: {
      completion: { rate: 62.5, submitted: 5, assigned: 8 },
      achievement: { averagePercent: 71, marked: 4, bands: { EE: 1, ME: 2, AE: 1, BE: 0 } },
      totals: { learners: 40 }, library: { learnerReach: 25, learnersUsing: 10 },
    },
    impact: { teacherParticipation: { teachers: 5, active: { count: 4, rate: 80 }, settingWork: { count: 2, rate: 40 } } },
    implementation: { visits: 7, schools: { total: 10, visited: 6, coverage: 60 }, byType: [{ label: "ICT", visits: 3, schools: 2 }] },
  };
  assertEquals(PORTAL_METRICS.completion_rate.get(intel, {}).value, 62.5);
  assertEquals(PORTAL_METRICS.meeting_expectations.get(intel, {}), {
    value: 75, numerator: 3, denominator: 4, n: 4, method: "Marked submissions in bands EE or ME ÷ marked submissions",
  });
  assertEquals(PORTAL_METRICS.schools_visited.get(intel, { visitType: "ICT" }).value, 20);
  assertEquals(PORTAL_METRICS.field_visits.get(intel, { visitType: "ICT" }).value, 3);
  assertEquals(PORTAL_METRICS.teachers_active.get(intel, {}).value, 80);
});

Deno.test("targets: the scope's own, else the programme's", () => {
  const targets = [
    { indicator_id: "i1", period: "2026-T2", scope_type: "programme", scope_id: "", target_value: 75 },
    { indicator_id: "i1", period: "2026-T2", scope_type: "county", scope_id: "Meru", target_value: 60 },
  ];
  assertEquals(targetFor(targets, "i1", "2026-T2", { type: "county", id: "Meru", label: "" })?.value, 60);
  assertEquals(targetFor(targets, "i1", "2026-T2", { type: "county", id: "Narok", label: "" }), { value: 75, from: "programme", row: targets[0] });
  assertEquals(targetFor(targets, "i1", "2026-T3", { type: "programme", id: "", label: "" }), null);
});

Deno.test("achievement: actual against target, the right way round", () => {
  assertEquals(achievement(68, 75), { percent: 90.7, status: "close" }, "the example: 68% against 75%");
  assertEquals(achievement(80, 75).status, "met");
  assertEquals(achievement(40, 75).status, "not_met");
  assertEquals(achievement(10, 8, "decrease"), { percent: 80, status: "close" }, "dropout of 10% against a target of 8%");
  assertEquals(achievement(6, 8, "decrease").status, "met");
  assertEquals(achievement(null, 75).status, "no_data");
});

Deno.test("source settings are checked against the survey's own questions", () => {
  const kobo = { fields: [{ xpath: "grp/ict", label: "ICT integrated?", type: "select_one" }] };
  assertEquals(cleanSourceConfig("kobo", { formId: "f1", measure: "percent_choice", question: "grp/ict", choices: "yes, partly" }, kobo),
    { config: { formId: "f1", measure: "percent_choice", question: "grp/ict", questionLabel: "ICT integrated?", choices: ["yes", "partly"] } });
  assert("error" in cleanSourceConfig("kobo", { formId: "f1", measure: "percent_choice", question: "nope", choices: "yes" }, kobo));
  assert("error" in cleanSourceConfig("kobo", { formId: "f1", measure: "percent_choice", question: "grp/ict" }, kobo));
  assertEquals(cleanSourceConfig("kobo", { formId: "f1", measure: "count" }, null), { config: { formId: "f1", measure: "count" } });
  assertEquals(cleanSourceConfig("portal", { metric: "schools_visited", visitType: "ICT" }), { config: { metric: "schools_visited", visitType: "ICT" } });
  assert("error" in cleanSourceConfig("portal", { metric: "made_up" }));
});
