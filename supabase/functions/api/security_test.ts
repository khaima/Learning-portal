/**
 * Guessing limits on the doors anyone can knock on: learner PIN sign-in and
 * staff sign-up. PINs anyone would try first can't be set, a reply never says
 * whether a username exists, and one network address can't keep guessing.
 *
 *   cd supabase/functions/api
 *   deno test --allow-env --allow-read --config deno.json security_test.ts
 *
 * Runs the real API against the in-memory world in test_world.ts.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { FakeTime } from "jsr:@std/testing@1/time";
import { call, freshWorld } from "./test_world.ts";

/** A request from one network address, as the platform's proxy reports it. */
const from = (address: string) => ({ "x-forwarded-for": address });
const login = (username: string, pin: string, address?: string) =>
  call("POST", "/learner/login", undefined, { username, pin }, address ? from(address) : {});

Deno.test("learner PIN: one digit four times or a straight run can't be set", async () => {
  freshWorld();
  for (const pin of ["0000", "7777", "1234", "6789", "9876", "3210", "0123"]) {
    const res = await call("POST", "/learners", "tok_teacher", { fullName: "Easy Pin", username: `kid.e${pin}`, pin, classId: "cls_1" });
    assertEquals(res.status, 400, pin);
    assert(/harder to guess/.test(res.json.error), pin);
  }
  for (const pin of ["2580", "1357", "2468", "7890", "1470"]) {
    const res = await call("POST", "/learners", "tok_teacher", { fullName: "Fine Pin", username: `kid.f${pin}`, pin, classId: "cls_1" });
    assertEquals(res.status, 200, `${pin}: ${JSON.stringify(res.json)}`);
  }
  assertEquals((await call("PATCH", "/learners/learner-id", "tok_teacher", { pin: "1111" })).status, 400, "a new PIN too");
  assertEquals((await call("PATCH", "/learners/learner-id", "tok_teacher", { pin: "3907" })).status, 200);
});

Deno.test("learner sign-in: a wrong username and a wrong PIN get the same answer; only the right PIN learns an account is archived", async () => {
  const db = freshWorld();
  await call("POST", "/learners", "tok_teacher", { fullName: "Arch Ive", username: "kid.arch", pin: "2580", classId: "cls_1" });
  const nobody = await login("no.such.kid", "2580");
  const wrong = await login("kid.arch", "1470");
  assertEquals([nobody.status, nobody.json.error], [401, "Wrong username or PIN"]);
  assertEquals([wrong.status, wrong.json.error], [nobody.status, nobody.json.error], "no way to tell which usernames exist");

  const id = db.learners.find((l) => l.username === "kid.arch")!.id;
  assertEquals((await call("POST", `/learners/${id}/status`, "tok_teacher", { status: "DROPPED_OUT", reason: "Left school" })).status, 200);
  assertEquals((await login("kid.arch", "1470")).status, 401, "a wrong PIN gets no hint");
  assertEquals((await login("kid.arch", "2580")).status, 403, "the right PIN is told why");
});

Deno.test("learner sign-in: one network address is stopped after 40 wrong PINs in 15 minutes; others carry on", async () => {
  const time = new FakeTime(new Date("2026-10-05T08:00:00.000Z"));
  try {
    freshWorld();
    await call("POST", "/learners", "tok_teacher", { fullName: "Real Kid", username: "kid.real", pin: "2580", classId: "cls_1" });
    // Spraying one PIN across many usernames, from one address.
    for (let i = 1; i <= 40; i++) assertEquals((await login(`guess.${i}`, "1470", "203.0.113.9")).status, 401, `try ${i}`);
    const stopped = await login("kid.real", "2580", "203.0.113.9");
    assertEquals(stopped.status, 429, "even the right PIN waits");
    assert(/Wait 15 minutes/.test(stopped.json.error));
    assertEquals((await login("kid.real", "2580", "198.51.100.7")).status, 200, "another network isn't affected");
    time.tick(15 * 60_000 + 1);
    assertEquals((await login("kid.real", "2580", "203.0.113.9")).status, 200, "open again after 15 minutes");
  } finally {
    time.restore();
  }
});

Deno.test("learner sign-in: right PINs don't count towards the limit", async () => {
  freshWorld();
  await call("POST", "/learners", "tok_teacher", { fullName: "Busy Kid", username: "kid.busy", pin: "2580", classId: "cls_1" });
  for (let i = 1; i <= 45; i++) assertEquals((await login("kid.busy", "2580", "203.0.113.9")).status, 200, `sign-in ${i}`);
});

Deno.test("staff sign-up: 20 new accounts an hour from one network address, then refused", async () => {
  const time = new FakeTime(new Date("2026-10-05T08:00:00.000Z"));
  try {
    freshWorld();
    const signUp = (n: number, address: string) =>
      call("POST", "/auth/register", undefined, { email: `t${n}@test.org`, password: "a-long-unusual-phrase" }, from(address));
    for (let i = 1; i <= 20; i++) assertEquals((await signUp(i, "203.0.113.9")).status, 200, `sign-up ${i}`);
    const refused = await signUp(21, "203.0.113.9");
    assertEquals(refused.status, 429);
    assert(/ask for an invitation/.test(refused.json.error));
    assertEquals((await signUp(22, "198.51.100.7")).status, 200, "another network isn't affected");
    time.tick(60 * 60_000 + 1);
    assertEquals((await signUp(23, "203.0.113.9")).status, 200, "open again after an hour");
  } finally {
    time.restore();
  }
});
