/**
 * Data-scope rules (scope.ts) and the permission model (permissions.ts).
 *
 *   cd supabase/functions/api
 *   deno test --allow-env --config deno.json scope_test.ts
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { countiesInScope, inPlaceScope, matchCounty, type PlaceScope, placeScopeFor } from "./scope.ts";
import {
  effectivePermissions, GRANTABLE_PERMISSIONS, PERMISSIONS, permissionsFor, ROLE_PERMISSIONS,
} from "./permissions.ts";

const ids = (s: PlaceScope) => (s.global ? null : [...s.schoolIds].sort());

const SCHOOLS = [
  { id: "s1", name: "Aitong Primary", county: "Narok" },
  { id: "s2", name: "Olpusimoru Primary", county: "Narok" },
  { id: "s3", name: "Meru Central", county: "Meru" },
  { id: "s4", name: "Isiolo Boys", county: "Isiolo" },
];

Deno.test("scope: Super Admin is global, always — even with assignments", () => {
  assert(placeScopeFor({ role: "super_admin" }, [{ scope_type: "county", county: "Narok" }], SCHOOLS).global);
});

Deno.test("scope: Admin, M&E and Education Team are global until given an assignment", () => {
  for (const role of ["admin", "me", "education_team"]) {
    const open = placeScopeFor({ role }, [], SCHOOLS);
    assert(open.global, role);
    assert(placeScopeFor({ role }, [{ scope_type: "county", county: "Narok", ended_at: "2026-01-01" }], SCHOOLS).global, "ended assignments don't count");
    const narrowed = placeScopeFor({ role }, [{ scope_type: "county", county: "narok" }], SCHOOLS);
    assert(!narrowed.global);
    assertEquals(ids(narrowed), ["s1", "s2"], "a whole county, matched without regard to case");
    assertEquals(narrowed.label, "narok County");
  }
});

Deno.test("scope: a field officer sees nothing until assigned, then exactly what's assigned", () => {
  const none = placeScopeFor({ role: "field_officer" }, [], SCHOOLS);
  assert(!none.global);
  assertEquals(ids(none), []);
  assertEquals(none.label, "No schools assigned yet");
  const some = placeScopeFor({ role: "field_officer" }, [
    { scope_type: "county", county: "Meru" }, { scope_type: "school", school_id: "s4" },
  ], SCHOOLS);
  assertEquals(ids(some), ["s3", "s4"]);
  assertEquals(some.label, "Meru County and Isiolo Boys");
  assert(inPlaceScope(some, "s3"));
  assert(!inPlaceScope(some, "s1"), "another county's school");
  assert(inPlaceScope(some, null, "MERU"), "a record with only a county: the whole county is assigned");
  assert(!inPlaceScope(some, null, "Isiolo"), "one school in Isiolo doesn't make the whole county visible");
  assertEquals(countiesInScope(some, SCHOOLS, ["Narok", "Meru", "Isiolo"]), ["Meru", "Isiolo"]);
});

Deno.test("scope: school heads, teachers and learners are their own school", () => {
  for (const role of ["school_leader", "teacher", "learner"]) {
    const s = placeScopeFor({ role, schoolId: "s2" }, [{ scope_type: "county", county: "Meru" }], SCHOOLS);
    assert(!s.global);
    assertEquals(ids(s), ["s2"], `${role}: assignments never widen it`);
    assertEquals(ids(placeScopeFor({ role, schoolId: null }, [], SCHOOLS)), []);
  }
});

Deno.test("scope: old free-text counties map only when they match a real county", () => {
  const counties = ["Narok", "Laikipia", "Meru", "Isiolo"];
  assertEquals(matchCounty("Meru", counties), "Meru");
  assertEquals(matchCounty(" isiolo ", counties), "Isiolo");
  assertEquals(matchCounty("Nanyuki", counties), null, "a town is not a county — not guessed");
  assertEquals(matchCounty("", counties), null);
});

Deno.test("permissions: every role's permissions are real permissions", () => {
  for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) {
    for (const p of perms) assert((PERMISSIONS as readonly string[]).includes(p), `${role}: ${p}`);
  }
});

Deno.test("permissions: the HPF separation of duties", () => {
  const has = (role: string, p: string) => permissionsFor(role).includes(p as never);
  // Admin is not Super Admin.
  for (const p of ["platform.view", "permissions.manage", "audit.view", "kobo.configure", "kobo.manage"]) {
    assert(has("super_admin", p) && !has("admin", p), p);
  }
  // Admin syncs the Kobo surveys; attaching them and mapping their fields is the Super Admin's (7 Oct 2026).
  assert(has("admin", "kobo.sync") && has("super_admin", "kobo.sync"));
  // Admin doesn't run the M&E results framework.
  for (const p of ["me.view", "me.framework.manage", "me.actuals.verify", "me.reports.manage"]) assert(!has("admin", p), p);
  // M&E measures; it doesn't manage accounts, settings, integrations or records.
  for (const p of ["users.view", "users.roles.assign", "users.status.manage", "permissions.manage", "kobo.configure",
    "kobo.manage", "schools.manage", "learners.transfer", "learners.manage.all", "library.manage", "audit.view", "platform.view"]) {
    assert(!has("me", p), p);
  }
  // Education Team: learning work, not administration or security.
  for (const p of ["users.view", "users.invite", "users.roles.assign", "schools.manage", "audit.view", "platform.view",
    "permissions.manage", "kobo.configure", "kobo.manage", "notifications.view.all", "sync.monitor", "me.view", "data_quality.manage"]) {
    assert(!has("education_team", p), p);
  }
  // Administrators don't act as a teacher, head, field officer or learner.
  for (const p of ["learners.manage", "assignments.manage", "assignments.grade", "field_reports.create", "forms.respond",
    "school.overview.view", "assignments.submit"]) {
    assert(!has("super_admin", p) && !has("admin", p), p);
  }
  // Super Admin holds everything any management role holds.
  for (const role of ["admin", "me", "education_team"]) {
    for (const p of permissionsFor(role)) assert(has("super_admin", p), `${role}: ${p}`);
  }
});

Deno.test("permissions: grants add management permissions only, and never the power to grant", () => {
  assert(!GRANTABLE_PERMISSIONS.includes("permissions.manage"));
  assert(!GRANTABLE_PERMISSIONS.includes("assignments.grade"), "a teacher's own work can't be granted");
  const admin = effectivePermissions("admin", ["me.framework.manage", "permissions.manage", "assignments.grade", "nonsense"]);
  assert(admin.has("me.framework.manage"), "explicitly granted");
  assert(!admin.has("permissions.manage"));
  assert(!admin.has("assignments.grade"));
  assert(!effectivePermissions("learner", ["users.view"]).has("users.view"), "learners never get grants");
});

Deno.test("scope: dashboard input is cut to the scope before anything is counted", async () => {
  const { narrowInput } = await import("./scope.ts");
  const d = {
    schools: SCHOOLS, terms: [{ id: "2026-T3" }], subjects: [{ id: "maths" }],
    profiles: [
      { id: "t1", role: "teacher", school_id: "s1" }, { id: "t3", role: "teacher", school_id: "s3" },
      { id: "fo1", role: "field_officer", school_id: null, county: "Narok" }, { id: "et", role: "education_team", school_id: null, county: "" },
    ],
    learners: [{ id: "l1", school_id: "s1" }, { id: "l3", school_id: "s3" }],
    enrollments: [{ id: "e1", school_id: "s1" }, { id: "e3", school_id: "s3" }],
    classes: [{ id: "c1", school_id: "s1" }, { id: "c3", school_id: "s3" }],
    classTeachers: [{ class_id: "c1", teacher_id: "t1" }, { class_id: "c3", teacher_id: "t3" }],
    assignments: [{ id: "a1", school_id: "s1" }, { id: "a3", school_id: "s3" }],
    submissions: [{ id: "x1", school_id: "s1" }, { id: "x3", school_id: "s3" }],
    fieldReports: [{ id: "v1", school_id: "s1" }, { id: "v-old", school_id: null, county: "Narok" }, { id: "v3", school_id: "s3" }],
    forms: [{ id: "f-all", county: null }, { id: "f-narok", county: "Narok" }, { id: "f-meru", county: "Meru" }],
    responses: [{ id: "r1", respondent_id: "t1" }, { id: "r3", respondent_id: "t3" }],
    koboForms: [{ id: "k" }], koboSubmissions: [{ officer_id: "fo1" }, { officer_id: "elsewhere" }],
    koboRecords: [{ id: "kr1", school_id: "s1" }, { id: "kr3", school_id: "s3" }],
    koboIssues: [{ id: 1, record_id: "kr1" }, { id: 2, record_id: "kr3" }],
    libraryItems: [{ id: "b" }],
    libraryInteractions: [{ id: "i1", school: "Aitong Primary" }, { id: "i3", school: "Meru Central" }],
    trainings: [{ id: "tr1", school_id: null, county: "Narok" }, { id: "tr3", school_id: "s3" }],
    trainingAttendance: [{ training_id: "tr1", teacher_id: "t1" }, { training_id: "tr3", teacher_id: "t3" }],
    bands: [],
  };
  const narok = placeScopeFor({ role: "me" }, [{ scope_type: "county", county: "Narok" }], SCHOOLS);
  const n = narrowInput(d, narok);
  const idsOf = (k: string) => (n as Record<string, Record<string, unknown>[]>)[k].map((r) => r.id ?? r.class_id ?? r.officer_id ?? r.training_id);
  assertEquals(idsOf("schools"), ["s1", "s2"]);
  assertEquals(idsOf("profiles"), ["t1", "fo1"], "programme staff without a place aren't in any area");
  assertEquals(idsOf("learners"), ["l1"]);
  assertEquals(idsOf("classTeachers"), ["c1"]);
  assertEquals(idsOf("fieldReports"), ["v1", "v-old"], "an older visit with only a county, in an assigned county");
  assertEquals(idsOf("forms"), ["f-all", "f-narok"]);
  assertEquals(idsOf("responses"), ["r1"]);
  assertEquals(idsOf("koboIssues"), [1]);
  assertEquals(idsOf("libraryInteractions"), ["i1"]);
  assertEquals(idsOf("trainingAttendance"), ["tr1"]);
  assertEquals(n.terms, d.terms, "reference data stays whole");
  assertEquals(narrowInput(d, placeScopeFor({ role: "me" }, [], SCHOOLS)), d, "global: untouched");
});

Deno.test("permissions: every permission is described for people to read", async () => {
  const { PERMISSION_LABEL } = await import("./permissions.ts");
  for (const p of PERMISSIONS) assert(PERMISSION_LABEL[p], p);
});
