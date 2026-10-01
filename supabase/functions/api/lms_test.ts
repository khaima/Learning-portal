/**
 * Unit tests for the marking and results rules (lms.ts) — no database.
 *
 *   cd supabase/functions/api
 *   deno test --config deno.json lms_test.ts
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  autoMark, bandFor, cleanQuestions, cleanResponse, groupResults, isLate, pairsOf, percentOf, summarize,
  type Band, type ResultAssignment, type ResultSubmission,
} from "./lms.ts";

const BANDS: Band[] = [
  { code: "EE", label: "Exceeding", minPercent: 80 },
  { code: "ME", label: "Meeting", minPercent: 50 },
  { code: "AE", label: "Approaching", minPercent: 30 },
  { code: "BE", label: "Below", minPercent: 0 },
];

Deno.test("question checks: every type, and the mistakes a teacher can make", () => {
  const ok = cleanQuestions([
    { type: "multiple_choice", prompt: "Q", options: ["a", "b"], answerKey: 1, maxMarks: 1 },
    { type: "multiple_response", prompt: "Q", options: ["a", "b", "c"], answerKey: [2, 0], maxMarks: 2 },
    { type: "true_false", prompt: "Q", answerKey: false, maxMarks: 1 },
    { type: "short_answer", prompt: "Q", answerKey: [" Nairobi ", ""], maxMarks: 1 },
    { type: "file_upload", prompt: "Q", maxMarks: 5 },
    { type: "teacher_marked", prompt: "Q", maxMarks: 5 },
  ]);
  assert("questions" in ok);
  assertEquals(ok.questions[1].answerKey, [0, 2]);
  assertEquals(ok.questions[2].options, ["True", "False"]);
  assertEquals(ok.questions[3].answerKey, ["Nairobi"]);
  for (const bad of [
    { type: "essay", prompt: "Q", maxMarks: 1 },
    { type: "multiple_choice", prompt: "", options: ["a", "b"], answerKey: 0, maxMarks: 1 },
    { type: "multiple_choice", prompt: "Q", options: ["a"], answerKey: 0, maxMarks: 1 },
    { type: "multiple_choice", prompt: "Q", options: ["a", "A"], answerKey: 0, maxMarks: 1 },
    { type: "multiple_choice", prompt: "Q", options: ["a", "b"], answerKey: 2, maxMarks: 1 },
    { type: "multiple_response", prompt: "Q", options: ["a", "b"], answerKey: [], maxMarks: 1 },
    { type: "true_false", prompt: "Q", answerKey: "yes", maxMarks: 1 },
    { type: "teacher_marked", prompt: "Q", maxMarks: 0 },
  ]) assert("error" in cleanQuestions([bad]), JSON.stringify(bad));
});

Deno.test("auto-marking: right, wrong, blank, and all-or-nothing multiple response", () => {
  const mc = { type: "multiple_choice" as const, answerKey: 1, maxMarks: 2 };
  assertEquals([autoMark(mc, 1), autoMark(mc, 0), autoMark(mc, null)], [2, 0, 0]);
  const mr = { type: "multiple_response" as const, answerKey: [0, 2], maxMarks: 3 };
  assertEquals([autoMark(mr, [2, 0]), autoMark(mr, [0]), autoMark(mr, [0, 1, 2])], [3, 0, 0]);
  const tf = { type: "true_false" as const, answerKey: false, maxMarks: 1 };
  assertEquals([autoMark(tf, false), autoMark(tf, true)], [1, 0]);
  const sa = { type: "short_answer" as const, answerKey: ["Nairobi"], maxMarks: 1 };
  assertEquals([autoMark(sa, "  nairobi "), autoMark(sa, "Mombasa")], [1, 0]);
  assertEquals(autoMark({ type: "short_answer", answerKey: [], maxMarks: 1 }, "x"), null, "no key: the teacher marks it");
  assertEquals(autoMark({ type: "teacher_marked", answerKey: null, maxMarks: 5 }, "x"), null);
  assertEquals(autoMark({ type: "file_upload", answerKey: null, maxMarks: 5 }, null), null);
});

Deno.test("learner answers are checked against the question", () => {
  const mc = { type: "multiple_choice" as const, options: ["a", "b"] };
  assertEquals([cleanResponse(mc, 1), cleanResponse(mc, 2), cleanResponse(mc, "1"), cleanResponse(mc, null)], [1, undefined, undefined, null]);
  assertEquals(cleanResponse({ type: "multiple_response", options: ["a", "b", "c"] }, [2, 0, 2]), [0, 2]);
  assertEquals(cleanResponse({ type: "true_false", options: [] }, "true"), undefined);
});

Deno.test("percentages, bands and lateness", () => {
  assertEquals([percentOf(3, 4), percentOf(0, 0), percentOf(1, 3)], [75, 0, 33.33]);
  assertEquals([bandFor(100, BANDS), bandFor(80, BANDS), bandFor(79.99, BANDS), bandFor(30, BANDS), bandFor(0, BANDS), bandFor(null, BANDS)],
    ["EE", "EE", "ME", "AE", "BE", null]);
  assert(isLate("2026-10-01T10:00:00Z", new Date("2026-10-01T10:00:01Z")));
  assert(!isLate("2026-10-01T10:00:00Z", new Date("2026-10-01T10:00:00Z")));
  assert(!isLate(null, new Date()));
});

const A = (id: string, over: Partial<ResultAssignment> = {}): ResultAssignment => ({
  id, schoolId: "s1", classId: "c1", subjectId: "maths", grade: "Grade 4", termId: "2026-T3", yearId: "2026",
  dueAt: "2026-09-20T00:00:00Z", status: "published", ...over,
});
const S = (assignmentId: string, learnerId: string, status: string, percentage: number | null = null, late = false): ResultSubmission =>
  ({ assignmentId, learnerId, status, isLate: late, percentage });
const NOW = new Date("2026-10-01T00:00:00Z");

Deno.test("results: completion counts handed-in work; achievement averages only marked work", () => {
  const assignments = [A("a1"), A("a2", { subjectId: "english" }), A("draft", { status: "draft" })];
  const expected = new Map([["a1", new Set(["l1", "l2", "l3"])], ["a2", new Set(["l1", "l2"])], ["draft", new Set(["l1"])]]);
  const subs = [
    S("a1", "l1", "marked", 90), S("a1", "l2", "submitted", null, true), // l3 never hands in
    S("a2", "l1", "marked", 40), S("a2", "l2", "in_progress"),
  ];
  const pairs = pairsOf(assignments, expected, subs);
  assertEquals(pairs.length, 5, "drafts never count");
  const all = summarize(pairs, BANDS, NOW);
  assertEquals(all.completion, { assigned: 5, submitted: 3, onTime: 2, late: 1, missing: 2, rate: 60 });
  assertEquals(all.achievement.marked, 2);
  assertEquals(all.achievement.averagePercent, 65, "(90 + 40) / 2 — unmarked and missing work don't count as zero");
  assertEquals(all.achievement.band, "ME");
  assertEquals(all.achievement.bands, { EE: 1, ME: 0, AE: 1, BE: 0 });
  const byLearner = Object.fromEntries(groupResults(pairs, "learner", BANDS, NOW).map((r) => [r.key, r]));
  assertEquals([byLearner.l1.completion.rate, byLearner.l1.achievement.averagePercent], [100, 65]);
  assertEquals([byLearner.l3.completion.rate, byLearner.l3.achievement.averagePercent], [0, null]);
  const bySubject = Object.fromEntries(groupResults(pairs, "subject", BANDS, NOW).map((r) => [r.key, r]));
  assertEquals([bySubject.maths.completion.rate, bySubject.english.completion.rate], [66.67, 50]);
  assertEquals([bySubject.maths.achievement.averagePercent, bySubject.english.achievement.averagePercent], [90, 40]);
});

Deno.test("results: work not yet due isn't missing; someone who left the class still counts if they handed in", () => {
  const future = A("a1", { dueAt: "2026-12-01T00:00:00Z" });
  const pairs = pairsOf([future], new Map([["a1", new Set(["l1"])]]), [S("a1", "l9", "submitted")]);
  assertEquals(pairs.map((p) => p.learnerId).sort(), ["l1", "l9"]);
  assertEquals(summarize(pairs, BANDS, NOW).completion, { assigned: 2, submitted: 1, onTime: 1, late: 0, missing: 0, rate: 50 });
  assertEquals(summarize([], BANDS, NOW).completion.rate, null);
});
