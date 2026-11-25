/**
 * A learner's grade is always one of the portal's grades (PP1, PP2,
 * Grade 1–12). Before 25 Nov 2026 any text was saved when the learner had
 * no class, which left grades like "5" and "Grade 4 E" in the database.
 *
 *   cd supabase/functions/api
 *   deno test --allow-env --allow-read --config deno.json grades_test.ts
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { call, freshWorld } from "./test_world.ts";
import { cleanGrade } from "./index.ts";

Deno.test("grades as people type them are put in the portal's form; anything else is refused", () => {
  assertEquals(cleanGrade("5"), "Grade 5");
  assertEquals(cleanGrade("grade 5"), "Grade 5");
  assertEquals(cleanGrade("  Grade   12 "), "Grade 12");
  assertEquals(cleanGrade("pp1"), "PP1");
  assertEquals(cleanGrade("PP 2"), "PP2");
  assertEquals(cleanGrade(""), "", "no grade is allowed");
  assertEquals(cleanGrade(undefined), "");
  assertEquals(cleanGrade("Grade 4 E"), null);
  assertEquals(cleanGrade("13"), null);
  assertEquals(cleanGrade("Form 2"), null);
});

Deno.test("adding a learner without a class: the grade is checked and saved in the portal's form", async () => {
  const db = freshWorld();
  const bad = await call("POST", "/learners", "tok_teacher", { fullName: "Bad Grade", username: "kid.bad", pin: "2580", grade: "Grade 4 E" });
  assertEquals(bad.status, 400);
  assert(/portal's grades/.test(bad.json.error));
  assert(!db.learners.some((l) => l.username === "kid.bad"), "nothing was saved");

  const ok = await call("POST", "/learners", "tok_teacher", { fullName: "Good Grade", username: "kid.good", pin: "2580", grade: "5" });
  assertEquals(ok.status, 200, JSON.stringify(ok.json));
  assertEquals(db.learners.find((l) => l.username === "kid.good")!.grade, "Grade 5");
});

Deno.test("editing a learner's grade: checked and saved in the portal's form", async () => {
  const db = freshWorld();
  assertEquals((await call("PATCH", "/learners/learner-id", "tok_teacher", { grade: "Grade 4 E" })).status, 400);
  assertEquals(db.learners.find((l) => l.id === "learner-id")!.grade, "Grade 4", "unchanged");
  assertEquals((await call("PATCH", "/learners/learner-id", "tok_teacher", { grade: "grade 4" })).status, 200);
  assertEquals(db.learners.find((l) => l.id === "learner-id")!.grade, "Grade 4");
});

Deno.test("a learner locked out by wrong PINs is in the audit log", async () => {
  const db = freshWorld();
  await call("POST", "/learners", "tok_teacher", { fullName: "Lock Me", username: "kid.lockme", pin: "2580", classId: "cls_1" });
  for (let i = 0; i < 5; i++) await call("POST", "/learner/login", undefined, { username: "kid.lockme", pin: "1470" });
  const id = db.learners.find((l) => l.username === "kid.lockme")!.id;
  const entry = db.audit_log.find((a) => a.action === "learner.locked" && a.target_id === id);
  assert(entry, "learner.locked recorded");
  assertEquals(entry.details.minutes, 15);
});
