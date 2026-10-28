/**
 * Library opens, read the same way everywhere (readings.ts).
 *
 *   cd supabase/functions/api
 *   deno test --config deno.json readings_test.ts
 */
import { assertEquals } from "jsr:@std/assert@1";
import { prepareReadings } from "./readings.ts";

const SCHOOLS = [{ id: "s1", name: "Aitong" }, { id: "s2", name: "Olesere" }];
const PEOPLE = [
  { id: "l3", school_id: "s2" },                       // a learner (no role on the learner row)
  { id: "h1", role: "school_leader", school_id: "s1" }, // a head, since moved to Aitong
  { id: "sa1", role: "super_admin", school_id: null },
  { id: "fo1", role: "field_officer", school_id: null },
];
const open = (o: Record<string, unknown>) => ({ id: "x", actor_id: "l3", role: "learner", school: "", ...o });

Deno.test("readings: a registered school's name is kept as recorded", () => {
  const [r] = prepareReadings([open({ actor_id: "h1", role: "school_leader", school: "Olesere" })], SCHOOLS, PEOPLE);
  assertEquals([r.school, r.recordedSchool], ["Olesere", "Olesere"], "read at Olesere, before the move: it stays Olesere's");
});

Deno.test("readings: a name that isn't a school's is the reader's linked school now", () => {
  const [r] = prepareReadings([open({ school: "meru" })], SCHOOLS, PEOPLE);
  assertEquals([r.school, r.recordedSchool], ["Olesere", "meru"]);
});

Deno.test("readings: with no school to link, the name stays as recorded (counted only in the totals)", () => {
  const [a, b] = prepareReadings([open({ actor_id: "fo1", role: "field_officer", school: "Narok" }), open({ actor_id: "gone", school: "" })], SCHOOLS, PEOPLE);
  assertEquals([a.school, b.school], ["Narok", ""]);
});

Deno.test("readings: HPF staff by the role recorded on the open, or the reader's role now", () => {
  const rows = prepareReadings([
    open({ actor_id: "sa1", role: "education_team", school: "HPF" }), // recorded as Education Team, now Super Admin
    open({ actor_id: "sa1", role: "teacher", school: "HPF" }),        // recorded otherwise, but HPF staff now
    open({ actor_id: "nobody", role: "me", school: "" }),             // the account is gone: the recorded role decides
    open({}),
  ], SCHOOLS, PEOPLE);
  assertEquals(rows.map((r) => r.hpf), [true, true, true, false]);
});

Deno.test("readings: the stored rows are not changed", () => {
  const row = open({ school: "meru" });
  prepareReadings([row], SCHOOLS, PEOPLE);
  assertEquals(row.school, "meru");
});
