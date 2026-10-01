/**
 * Unit tests for the Kobo ingestion pipeline (kobo_pipeline.ts): schema
 * parsing, every validation rule, normalization, duplicates, status.
 *
 *   cd supabase/functions/api
 *   deno test --config deno.json kobo_pipeline_test.ts
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  counts, detectMapping, type KoboMapping, normalizeValue, parseKoboSchema, type PipelineContext,
  processBatch, processOne, type RawSubmission, resolveSchool, summarizeAnswers,
} from "./kobo_pipeline.ts";

const CONTENT = {
  survey: [
    { type: "start", name: "start" },
    { type: "end", name: "end" },
    { type: "today", name: "today" },
    { type: "hidden", name: "officer_ref" },
    { type: "begin_group", name: "school_info", label: ["School"] },
    { type: "text", name: "school_code", label: ["School code"], required: true },
    { type: "select_one counties", name: "county", label: ["County"], required: "true" },
    { type: "date", name: "visit_date", label: ["Date of visit"], required: true },
    { type: "end_group" },
    { type: "integer", name: "learners_present", label: ["Learners present"], required: true },
    { type: "decimal", name: "hours", label: ["Hours taught"] },
    { type: "select_multiple resources", name: "resources", label: ["Resources used"] },
    { type: "text", name: "reason", label: ["Why not?"], required: true, relevant: "${learners_present} = 0" },
    { type: "geopoint", name: "gps", label: ["Location"] },
    { type: "note", name: "thanks", label: ["Thank you"] },
    { type: "begin_repeat", name: "lessons", label: ["Lessons"] },
    { type: "select_one yn", name: "used_tablet", label: ["Tablet used?"], required: true },
    { type: "end_repeat" },
  ],
  choices: [
    { list_name: "counties", name: "narok", label: ["Narok"] },
    { list_name: "counties", name: "meru", label: ["Meru"] },
    { list_name: "resources", name: "book", label: ["Book"] },
    { list_name: "resources", name: "tablet", label: ["Tablet"] },
    { list_name: "yn", name: "yes", label: ["Yes"] },
    { list_name: "yn", name: "no", label: ["No"] },
  ],
};
const schema = parseKoboSchema(CONTENT, "v1");
const mapping: KoboMapping = detectMapping(schema, "officer_ref");
const NOW = new Date("2026-10-01T12:00:00Z");
const ctx = (over: Partial<PipelineContext> = {}): PipelineContext => ({
  schema, mapping, now: NOW,
  schools: [
    { id: "s1", name: "Aitong Primary", code: "NRK-001", county: "Narok" },
    { id: "s2", name: "Kianjai Primary", code: "MRU-001", county: "Meru" },
    { id: "s3", name: "Twin Primary", code: "NRK-002", county: "Narok" },
    { id: "s4", name: "Twin Primary", code: "MRU-002", county: "Meru" },
  ],
  counties: [{ name: "Narok", code: "NRK" }, { name: "Meru", code: "MRU" }],
  aliases: { "aitong pri": "s1" },
  profiles: {
    fo1: { role: "field_officer", status: "active", county: "Narok" },
    fo2: { role: "field_officer", status: "suspended", county: "Meru" },
    t1: { role: "teacher", status: "active", county: "Narok" },
  },
  ...over,
});
const good = (over: Record<string, unknown> = {}) => ({
  _id: 1, _uuid: "u1", "meta/instanceID": "uuid:a1", _submission_time: "2026-09-20T10:00:00",
  start: "2026-09-20T08:00:00.000+03:00", end: "2026-09-20T09:00:00.000+03:00", today: "2026-09-20",
  officer_ref: "fo1",
  "school_info/school_code": " nrk-001 ", "school_info/county": "narok", "school_info/visit_date": "2026-09-20",
  learners_present: "34", hours: "2.5", resources: "book tablet", gps: "-1.08 35.87 1800 5",
  lessons: [{ "lessons/used_tablet": "yes" }, { "lessons/used_tablet": "no" }],
  ...over,
});
const raw = (payload: Record<string, unknown>, over: Partial<RawSubmission> = {}): RawSubmission => ({
  koboId: Number(payload._id), instanceId: String(payload["meta/instanceID"] ?? payload._uuid ?? ""),
  submittedAt: String(payload._submission_time), koboValidation: null, removed: false, payload, ...over,
});
const rules = (r: { issues: { rule: string; severity: string }[] }) => r.issues.map((i) => `${i.rule}:${i.severity}`).sort();

Deno.test("schema: full data paths, groups, repeats, required, skip logic, choices", () => {
  assertEquals(schema.meta, { start: "start", end: "end", today: "today" });
  const x = Object.fromEntries(schema.fields.map((f) => [f.xpath, f]));
  assert(!x.thanks, "notes aren't answers");
  assertEquals(x["school_info/county"].listName, "counties");
  assertEquals([x["school_info/visit_date"].required, x.hours.required], [true, false]);
  assertEquals(x.reason.relevant, "${learners_present} = 0");
  assertEquals(x["lessons/used_tablet"].repeats, ["lessons"]);
  assertEquals(schema.choices.resources.map((c) => c.label), ["Book", "Tablet"]);
});

Deno.test("mapping: school, county, officer and date are found by name", () => {
  assertEquals(mapping, {
    school: "school_info/school_code", schoolRequired: true, county: "school_info/county",
    officer: "officer_ref", officerRequired: true, date: "school_info/visit_date",
  });
});

Deno.test("a clean submission is valid and normalized", () => {
  const r = processOne(raw(good()), ctx());
  assertEquals(r.issues, []);
  assertEquals(r.status, "valid");
  assertEquals([r.schoolId, r.county, r.officerId, r.observedOn], ["s1", "Narok", "fo1", "2026-09-20"]);
  assertEquals(r.answers["school_info/school_code"], "nrk-001", "text is trimmed");
  assertEquals([r.answers.learners_present, r.answers.hours], [34, 2.5], "numbers are numbers");
  assertEquals(r.answers.resources, ["book", "tablet"], "multi-selects are lists");
  assertEquals(r.answers.gps, { lat: -1.08, lon: 35.87, alt: 1800, accuracy: 5 });
  assertEquals(r.answers["lessons/used_tablet"], ["yes", "no"], "one value per repeat");
});

Deno.test("required fields: an error — unless skip logic (its own or its group's) hid the question", () => {
  const r = processOne(raw(good({ learners_present: "", reason: undefined })), ctx());
  const req = r.issues.filter((i) => i.rule === "required");
  assertEquals(req.map((i) => [i.field, i.severity]), [["learners_present", "error"]], "“Why not?” has skip logic, so a blank one is fine");
  const grouped = parseKoboSchema({ survey: [
    { type: "begin_group", name: "g", relevant: "${x} = 'yes'" },
    { type: "text", name: "inner", required: true },
    { type: "end_group" },
  ] });
  assertEquals(grouped.fields[0].relevant, "${x} = 'yes'", "a question inherits its group's skip logic");
  const rep = processOne(raw(good({ lessons: [{ "lessons/used_tablet": "" }] })), ctx());
  assert(rep.issues.some((i) => i.rule === "required" && i.message.includes("entry 1")));
});

Deno.test("data types: numbers, options, dates and GPS are checked", () => {
  const r = processOne(raw(good({ learners_present: "34.5", hours: "two", resources: "book chalk", gps: "200 10", "lessons": [{ "lessons/used_tablet": "maybe" }] })), ctx());
  assertEquals(r.issues.filter((i) => i.rule === "type").map((i) => i.field).sort(),
    ["gps", "hours", "learners_present", "lessons/used_tablet", "resources"]);
  assertEquals(r.status, "invalid");
  assertEquals(normalizeValue(schema.fields.find((f) => f.name === "visit_date")!, "2026-02-30", schema.choices).problem, "isn't a valid date");
});

Deno.test("school code: code, alias and name all link; unknown and ambiguous don't", () => {
  const c = ctx();
  assertEquals((resolveSchool("NRK001", c) as { via: string }).via, "code");
  assertEquals((resolveSchool("Aitong Pri.", c) as { school: { id: string } }).school.id, "s1", "a saved alias");
  assertEquals((resolveSchool("  KIANJAI primary ", c) as { via: string }).via, "name");
  assert("ambiguous" in (resolveSchool("Twin Primary", c) as object));
  assertEquals((resolveSchool("Twin Primary", c, "Meru") as { school: { id: string } }).school.id, "s4", "the county settles it");
  const unknown = processOne(raw(good({ "school_info/school_code": "Aitong Primery School", "school_info/county": "" })), c);
  const school = unknown.issues.find((i) => i.rule === "school")!;
  assertEquals(school.severity, "error");
  assert(school.message.includes("did you mean Aitong Primary (NRK-001)"), school.message);
  assertEquals(processOne(raw(good({ "school_info/school_code": "" })), c).issues.find((i) => i.rule === "school")!.message, "No school given");
});

Deno.test("county: canonical names, unknown counties, and a county that contradicts the school", () => {
  assertEquals(processOne(raw(good({ "school_info/county": "NARok county" })), ctx()).county, "Narok");
  const mismatch = processOne(raw(good({ "school_info/county": "meru" })), ctx());
  assert(mismatch.issues.some((i) => i.rule === "county" && i.severity === "error" && i.message.includes("in Narok")));
  const unknown = processOne(raw(good({ "school_info/county": "Mombasa" })), ctx({ schema: { ...schema, choices: { ...schema.choices, counties: [] } } }));
  assert(unknown.issues.some((i) => i.rule === "county" && i.message.includes("isn't one of the portal's counties")));
});

Deno.test("officer: must be a portal account; inactive, wrong role or county are warnings", () => {
  assertEquals(rules(processOne(raw(good({ officer_ref: "" })), ctx())), ["officer:error"]);
  assertEquals(rules(processOne(raw(good({ officer_ref: "nobody" })), ctx())), ["officer:error"]);
  const fo2 = processOne(raw(good({ officer_ref: "fo2" })), ctx());
  assertEquals(rules(fo2), ["officer:warning", "officer:warning"], "suspended, and works in Meru");
  assertEquals(fo2.status, "valid", "warnings don't keep a record off the dashboards");
  assertEquals(rules(processOne(raw(good({ officer_ref: "t1" })), ctx())), ["officer:warning"]);
});

Deno.test("dates: future, after submission, over a year old, finished before started", () => {
  assert(processOne(raw(good({ "school_info/visit_date": "2026-12-01" })), ctx()).issues.some((i) => i.rule === "date" && i.message.includes("in the future")));
  assert(processOne(raw(good({ "school_info/visit_date": "2026-09-25" })), ctx()).issues.some((i) => i.message.includes("after the submission")));
  const old = processOne(raw(good({ "school_info/visit_date": "2024-09-20" })), ctx());
  assertEquals(rules(old), ["date:warning"]);
  assertEquals(rules(processOne(raw(good({ end: "2026-09-20T07:00:00.000+03:00" })), ctx())), ["date:warning"]);
  assertEquals(processOne(raw(good({ "school_info/visit_date": "" })), ctx()).observedOn, "2026-09-20", "falls back to Kobo's own date");
});

Deno.test("duplicates: a copy sent twice is a duplicate; same officer, school and day is only a warning", () => {
  const a = raw(good());
  const copy = raw(good({ _id: 2, _uuid: "u2", "meta/instanceID": "uuid:a2", _submission_time: "2026-09-20T10:05:00" }));
  const sameInstance = raw(good({ _id: 3, learners_present: "30", _submission_time: "2026-09-20T10:06:00" }));
  const secondClass = raw(good({ _id: 4, "meta/instanceID": "uuid:a4", start: "2026-09-20T09:30:00.000+03:00", end: "2026-09-20T10:00:00.000+03:00", learners_present: "28", _submission_time: "2026-09-20T11:00:00" }));
  const out = Object.fromEntries(processBatch([secondClass, copy, a, sameInstance], ctx()).map((r) => [r.koboId, r]));
  assertEquals([out[1].status, out[2].status, out[3].status, out[4].status], ["valid", "duplicate", "duplicate", "valid"]);
  assertEquals([out[2].duplicateOf, out[3].duplicateOf], [1, 1], "the earliest copy is the one that counts");
  assertEquals(rules(out[4]), ["duplicate:warning"]);
  // A short form with no start time: identical answers aren't proof of a copy.
  const shortSchema = parseKoboSchema({ survey: [{ type: "select_one yn", name: "ok" }], choices: CONTENT.choices });
  const short = ctx({ schema: shortSchema, mapping: detectMapping(shortSchema, "officer_ref") });
  const two = processBatch([raw({ _id: 10, _submission_time: "2026-09-01T00:00:00", ok: "yes" }), raw({ _id: 11, _submission_time: "2026-09-02T00:00:00", ok: "yes" })], short);
  assertEquals(two.map((r) => r.status), ["valid", "valid"]);
});

Deno.test("status: removed and rejected in Kobo come first; dashboards count valid or accepted", () => {
  assertEquals(processOne(raw(good(), { koboValidation: "validation_status_not_approved" }), ctx()).status, "rejected");
  assertEquals(processOne(raw(good({ officer_ref: "" }), { removed: true }), ctx()).status, "removed");
  assertEquals([counts("valid", null), counts("valid", "excluded"), counts("invalid", null), counts("invalid", "accepted"), counts("removed", "accepted")],
    [true, false, false, true, false]);
});

Deno.test("dashboards: charts come from the normalized answers", () => {
  const recs = [processOne(raw(good()), ctx()), processOne(raw(good({ _id: 2, resources: "book", learners_present: "20" })), ctx())];
  const q = Object.fromEntries(summarizeAnswers(schema, recs.map((r) => r.answers), new Set(["officer_ref"])).map((x) => [x.name, x]));
  assertEquals(q.resources.data, [{ label: "Book", value: 2 }, { label: "Tablet", value: 1 }]);
  assertEquals(q["lessons/used_tablet"].data, [{ label: "Yes", value: 2 }, { label: "No", value: 2 }]);
  assertEquals([q.learners_present.data.count, q.learners_present.data.mean], [2, 27]);
  assert(!q.officer_ref);
});
