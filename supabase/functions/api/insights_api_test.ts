/**
 * The dashboards' findings through the API: GET /impact/insights (the
 * Executive overview and area dashboards) and GET /admin/overview → insights.
 * The real app on the in-memory test world (test_world.ts).
 *
 *   cd supabase/functions/api
 *   deno test --allow-env --allow-read --config deno.json insights_api_test.ts
 */
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { call, freshWorld, SCHOOL } from "./test_world.ts";

const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
type Item = { key: string; kind: string; text: string; period: string; source: string; base: string; links: { page: string }[] };
const find = (items: Item[], key: string) => items.find((i) => i.key === key);

/** A programme with a learning indicator: a baseline, Term 2's verified actual, targets for Term 2, this term and Aitong. */
function withMel() {
  const db = freshWorld();
  db.me_programmes.push({ id: "p1", code: "HPF", name: "Digital learning", status: "active" });
  db.me_outcomes.push({ id: "o1", programme_id: "p1", code: "1", title: "Learners read", position: 0, archived_at: null });
  db.me_indicators.push(
    { id: "i1", outcome_id: "o1", code: "L1", name: "Reading at grade level", unit: "percent", direction: "increase", source: "manual", source_config: {},
      baseline_value: 34, baseline_period: "2025", dashboard_theme: "learning", position: 0, archived_at: null },
    { id: "i2", outcome_id: "o1", code: "L2", name: "Learners assessed", unit: "count", direction: "increase", source: "manual", source_config: {},
      dashboard_theme: "learning", position: 1, archived_at: null },
  );
  db.me_targets.push(
    { id: "tg1", indicator_id: "i1", period: "2026-T2", scope_type: "programme", scope_id: "", target_value: 45 },
    { id: "tg2", indicator_id: "i2", period: "2026-T2", scope_type: "programme", scope_id: "", target_value: 200 },
    { id: "tg3", indicator_id: "i1", period: "2026-T3", scope_type: "programme", scope_id: "", target_value: 50 },
    { id: "tg4", indicator_id: "i1", period: "2026-T3", scope_type: "school", scope_id: SCHOOL.id, target_value: 50 },
  );
  db.me_actuals.push(
    { id: "a1", indicator_id: "i1", period: "2026-T2", scope_type: "programme", scope_id: "", value: 41, source: "manual", status: "verified", superseded_at: null },
    { id: "a2", indicator_id: "i1", period: "2026-T3", scope_type: "school", scope_id: SCHOOL.id, value: 30, source: "manual", status: "recorded", superseded_at: null },
  );
  return db;
}

Deno.test("insights API: for whoever sees the impact dashboards (the Education Team: their learning side) — not admin or school roles", async () => {
  freshWorld();
  for (const [token, status] of [["tok_me", 200], ["tok_super_admin", 200], ["tok_education_team", 200], ["tok_admin", 200], ["tok_teacher", 403], ["tok_field_officer", 403]] as const) {
    const res = await call("GET", "/impact/insights", token);
    assertEquals(res.status, status, token);
  }
  const res = await call("GET", "/impact/insights", "tok_me");
  assertEquals(res.json.term, "2026-T3");
  assertMatch(res.json.period, /^2026 Term 3/);
  assert(Array.isArray(res.json.items));
});

Deno.test("insights API: a form past its due date, by who hasn't answered — on both overviews", async () => {
  const db = freshWorld();
  // Within this term or the last, and already past.
  db.forms[0].due_on = daysAgo(1) >= "2026-05-01" ? daysAgo(1) : today;
  const exec = (await call("GET", "/impact/insights", "tok_me")).json.items as Item[];
  const f = find(exec, "reporting:form:form_1")!;
  assertMatch(f.text, /^\d+ of \d+ teachers haven't answered “Survey”, due /);
  assertEquals(f.links[0].page, "forms");
  const admin = (await call("GET", "/admin/overview", "tok_admin")).json.insights;
  assertEquals(find(admin.items, "reporting:form:form_1")?.text, f.text, "the same finding on the Administration overview");
});

Deno.test("insights API: M&E — baseline to follow-up, a school against its own target, the last term's reporting", async () => {
  withMel();
  const items = (await call("GET", "/impact/insights", "tok_me")).json.items as Item[];
  const b = find(items, "baseline:i1")!;
  assertEquals(b.text, "L1 Reading at grade level: 41% in 2026 Term 2, from 34% at baseline (2025): up 7 points.");
  assertEquals(b.source, "M&E indicator L1: baseline and a verified actual");
  assertEquals(find(items, "schools:target:i1")?.text, "Aitong Primary has achieved 60% of its approved target for L1 Reading at grade level (30% against 50%).");
  assertEquals(find(items, "reporting:actuals")?.text, "2026 Term 2 has ended, and 1 of 2 indicators with an approved target has no recorded actual.");
  assertEquals(find(items, "reporting:actuals")?.base, "L2 Learners assessed");
  assertEquals(find(items, "reporting:no-value")?.text, "1 of 1 indicator with an approved target for 2026 Term 3 has no value yet: L1 Reading at grade level.");
  assertEquals(find(items, "evidence:learning"), undefined, "a learning baseline exists");
  assertEquals(items.filter((i) => i.key === "reporting:report").length, 0, "no M&E report has ever been made: none is expected");
});

Deno.test("insights API: one county — only its own targets, never the whole programme's", async () => {
  withMel();
  const items = (await call("GET", "/impact/insights?county=Narok", "tok_me")).json.items as Item[];
  assertEquals(items.filter((i) => i.kind === "target").length, 0, "Narok has no target of its own");
  assertEquals(find(items, "reporting:actuals"), undefined, "the programme's reporting isn't Narok's");
  assert(find(items, "schools:target:i1"), "Aitong's own target is in Narok");
});

Deno.test("insights API: the Administration overview — the programme's M&E findings, and for one school only its own", async () => {
  withMel();
  // The overview already shows the programme's M&E targets to its administrators; its findings say the same.
  const admin = (await call("GET", "/admin/overview", "tok_admin")).json.insights;
  assert(find(admin.items, "baseline:i1"), "the administrator's overview shows what its targets already show");
  const narrowed = (await call("GET", `/admin/overview?school=${encodeURIComponent(SCHOOL.name)}`, "tok_admin")).json.insights;
  assertEquals(find(narrowed.items, "baseline:i1"), undefined, "the baseline is the programme's: never set against one school");
  assertEquals(find(narrowed.items, "evidence:learning"), undefined, "nor is the programme's evidence note said of one school");
  assertEquals(find(narrowed.items, "target:i1")?.text,
    "Aitong Primary (NRK-001) has achieved 60% of its approved target for L1 Reading at grade level (30% against 50%).");
});

Deno.test("insights API: the Education Team gets the learning side only — training, marking, resources and the forms they send; no M&E, no field visits", async () => {
  const db = withMel();
  db.forms[0].due_on = daysAgo(1) >= "2026-05-01" ? daysAgo(1) : today;
  db.trainings.push({ id: "tr_live", title: "Workshop", kind: "workshop", held_on: "2026-09-10", county: "Narok", school_id: null, archived_at: null });
  const res = await call("GET", "/impact/insights", "tok_education_team");
  assertEquals(res.status, 200);
  assertEquals(res.json.learningOnly, true);
  const items = res.json.items as (Item & { area: string })[];
  assert(items.every((i) => ["learning", "teachers", "resources"].includes(i.area) || i.key.startsWith("reporting:form:")), JSON.stringify(items.map((i) => i.key)));
  assert(find(items, "reporting:form:form_1"), "the form they sent, past its due date");
  assert(find(items, "gap:untrained"), "teachers with no training this school year");
  assertEquals(items.filter((i) => /^(target|baseline|schools:target|reporting:actuals|reporting:no-value|evidence)/.test(i.key)), [], "nothing from M&E");
  assertEquals(find(items, "gap:not-visited"), undefined, "field visits aren't the learning side");
  // M&E sees the same programme with its M&E findings.
  const me = (await call("GET", "/impact/insights", "tok_me")).json.items as Item[];
  assert(find(me, "baseline:i1") && find(me, "gap:not-visited"));
});
