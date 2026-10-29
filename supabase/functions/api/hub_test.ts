/**
 * Programme impact, the M&E hub (GET /me/hub; hub-ui.js): every dashboard's
 * figures in one read, within the caller's area.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { assign, call, freshWorld, twoCounties, type Row } from "./test_world.ts";

Deno.test("the hub: every dashboard's figures, the term's results and the findings, in one read", async () => {
  freshWorld();
  const res = await call("GET", "/me/hub", "tok_me");
  assertEquals(res.status, 200, JSON.stringify(res.json).slice(0, 300));
  const d = res.json;
  for (const k of ["executive", "reach", "learning", "teachers", "fieldOps", "resources"]) assert(k in d.impact, `impact.${k}`);
  assert(d.results && !d.results.error, JSON.stringify(d.results));
  assertEquals(d.results.kpis.map((k: Row) => k.key),
    ["learners", "participation", "teachers_trained", "teachers_digital", "schools_supported", "assessment", "teacher_resources"]);
  assert(Array.isArray(d.results.schools), "each school's figures, for the table and the dots");
  assert(d.insights && !d.insights.error, "what the figures say");
  assertEquals(d.scope.label, "All counties and schools");
  // The same figures as the dashboards it gathers.
  const impact = (await call("GET", "/impact", "tok_me")).json;
  assertEquals([d.impact.executive.schools, d.impact.executive.learners], [impact.executive.schools, impact.executive.learners]);
});

Deno.test("the hub: only M&E and the Super Admin; within the caller's area, narrowed to a county when asked", async () => {
  const db = twoCounties();
  for (const tok of ["tok_education_team", "tok_admin", "tok_field_officer", "tok_school_leader", "tok_teacher", "hpl_learnertoken"]) {
    assertEquals((await call("GET", "/me/hub", tok)).status, 403, tok);
  }
  const all = (await call("GET", "/me/hub", "tok_super_admin")).json;
  const meru = (await call("GET", "/me/hub?county=Meru", "tok_super_admin")).json;
  assertEquals(meru.scope.label, "Meru County");
  assertEquals(meru.impact.executive.schools, 1);
  assert(all.impact.executive.schools > meru.impact.executive.schools);
  assertEquals(meru.results.targets, null, "targets are the whole programme's: never on one county's figures");
  // M&E narrowed to Meru sees Meru, whatever it asks for.
  assign(db, "me-id", [{ county: "Meru" }]);
  const mine = (await call("GET", "/me/hub", "tok_me")).json;
  assertEquals([mine.impact.executive.schools, mine.scope.label], [1, "Meru County"]);
  assertEquals((await call("GET", "/me/hub?county=Narok", "tok_me")).json.impact.executive.schools, 0, "not another county's");
});
