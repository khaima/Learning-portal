/**
 * The admin dashboard's pictures (GET /admin/overview → charts): field visits
 * by place and month, class sizes, learners per teacher, enrolment by school
 * and grade — all within the caller's area.
 *
 *   cd supabase/functions/api
 *   deno test --allow-env --allow-read --config deno.json admin_overview_test.ts
 *
 * test_world.ts: Aitong (2 active teachers, Kid One in Grade 4 East) and
 * Olpusimoru (Teacher B, Kid B in Grade 4 B), both in Narok; three classes.
 */
import { assertEquals } from "jsr:@std/assert@1";
import { call, freshWorld, SCHOOL, SCHOOL_B } from "./test_world.ts";

const charts = async () => {
  const res = await call("GET", "/admin/overview", "tok_admin");
  assertEquals(res.status, 200);
  return res.json.charts;
};

Deno.test("admin overview: visits by school and month when the area is one county", async () => {
  const db = freshWorld();
  const month = new Date().toISOString().slice(0, 7);
  db.field_reports.push(
    { id: "fr_1", school_id: SCHOOL.id, school: SCHOOL.name, county: "Narok", visit_type: "ICT", officer_id: "field_officer-id", created_at: `${month}-02T08:00:00Z` },
    { id: "fr_2", school_id: SCHOOL.id, school: SCHOOL.name, county: "Narok", visit_type: "MEP", officer_id: "field_officer-id", created_at: `${month}-03T08:00:00Z` },
  );
  const v = (await charts()).visits;
  assertEquals(v.rowsAre, "school");
  assertEquals(v.months.length, 12);
  assertEquals(v.months.at(-1), month);
  assertEquals(v.rows.map((r: { label: string; total: number }) => [r.label, r.total]), [[SCHOOL.name, 2], [SCHOOL_B.name, 0]], "every school, the most visited first");
  assertEquals(v.rows[0].values.at(-1), 2);
});

Deno.test("admin overview: class sizes, learners per teacher, enrolment by school and grade", async () => {
  freshWorld();
  const c = await charts();
  // Grade 4 East 1, Grade 5 East 0, Grade 4 B 1: three classes under ten.
  assertEquals(c.classSizes.map((b: { value: number }) => b.value), [3, 0, 0, 0, 0, 0, 0]);
  assertEquals([c.classSizes[6].from, c.classSizes[6].to], [60, null], "the last range is open: 60 or more");
  assertEquals(c.perTeacher.map((r: { label: string; value: number; teachers: number }) => [r.label, r.value, r.teachers]),
    [[SCHOOL_B.name, 1, 1], [SCHOOL.name, 0.5, 2]], "non-active teacher accounts don't count");
  assertEquals(c.enrolment.grades, ["Grade 4"]);
  assertEquals(c.enrolment.rows.map((r: { label: string; values: number[] }) => [r.label, r.values]), [[SCHOOL.name, [1]], [SCHOOL_B.name, [1]]]);
});

Deno.test("school head overview: the school's marks as a histogram in tens", async () => {
  freshWorld();
  const res = await call("GET", "/school/overview", "tok_school_leader");
  assertEquals(res.status, 200);
  const m = res.json.marks;
  assertEquals(m.bins.length, 10);
  assertEquals(m.bins.reduce((t: number, b: { value: number }) => t + b.value, 0), m.learners, "every learner with marked work is in one range");
  assertEquals([m.bins[0].from, m.bins[9].to], [0, 100]);
});

Deno.test("admin overview: gaps to fill — schools without a teacher, not visited this term, forms nobody answered", async () => {
  const db = freshWorld();
  db.schools.push({ id: "sch_new", name: "Ilkerin", county: "Narok", code: "NRK-099" });
  db.field_reports.push({ id: "fr_t", school_id: SCHOOL.id, school: SCHOOL.name, county: "Narok", visit_type: "ICT", officer_id: "field_officer-id", created_at: new Date().toISOString() });
  db.forms.push({ id: "form_quiet", title: "Term 3 check-in", audience: "teacher", county: null, archived_at: null });
  const res = await call("GET", "/admin/overview", "tok_admin");
  assertEquals(res.status, 200, JSON.stringify(res.json));
  const { organisation: o, operations: ops, charts: c, people: p } = res.json;
  assertEquals(o.schoolsWithoutTeacher, { count: 1, names: ["Ilkerin"] });
  assertEquals(c.perTeacher.map((r: { label: string }) => r.label), [SCHOOL_B.name, SCHOOL.name], "a school without a teacher isn't drawn as a ratio");
  assertEquals(c.enrolment.rows.length, 2, "only schools with learners");
  assertEquals(c.enrolment.schoolsWithout, 1);
  assertEquals([ops.visitsThisTerm, ops.schoolsVisitedThisTerm], [1, 1]);
  assertEquals(ops.schoolsNotVisitedThisTerm.names, ["Ilkerin", SCHOOL_B.name].sort());
  assertEquals(ops.formsWithoutResponses.titles.includes("Term 3 check-in"), true);
  assertEquals(p.learnerSchools, 2);
});

Deno.test("admin overview: a county or school filter narrows every figure alike, inside the caller's area", async () => {
  const db = freshWorld();
  db.schools.push({ id: "sch_ny", name: "Nyeri Hill", county: "Nyeri", code: "NYR-001" });
  const get = async (qs: string) => {
    const res = await call("GET", `/admin/overview${qs}`, "tok_admin");
    assertEquals(res.status, 200, JSON.stringify(res.json));
    return res.json;
  };
  const all = await get("");
  assertEquals([all.organisation.schools, all.people.learners, all.filter], [3, 2, { county: null, school: null }]);

  const one = await get(`?school=${encodeURIComponent(SCHOOL_B.name)}`);
  assertEquals(one.scope.label, SCHOOL_B.name);
  assertEquals([one.organisation.schools, one.people.learners, one.people.teachers], [1, 1, 1], "Olpusimoru: Kid B and Teacher B only");
  assertEquals(one.charts.perTeacher.map((r: { label: string }) => r.label), [SCHOOL_B.name]);
  assertEquals(one.people.programmeStaff, null, "HPF staff belong to no one school");
  if (one.results && !one.results.error) {
    assertEquals(one.results.schoolsTotal, 1, "the school table: that school only");
    assertEquals(one.results.kpis.find((k: { key: string }) => k.key === "learners").value, 1, "the KPI agrees with the count above");
    assertEquals(one.results.targets, null, "whole-programme targets aren't put against one school");
  }

  const nyeri = await get("?county=Nyeri");
  assertEquals([nyeri.organisation.schools, nyeri.people.learners, nyeri.scope.label], [1, 0, "Nyeri County"]);
  assertEquals(nyeri.organisation.schoolsWithoutTeacher.names, ["Nyeri Hill"]);

  const nowhere = await get("?school=Not%20a%20school");
  assertEquals([nowhere.organisation.schools, nowhere.people.learners], [0, 0], "an unknown school: nothing, not everything");
});
