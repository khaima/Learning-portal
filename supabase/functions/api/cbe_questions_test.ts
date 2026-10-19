/**
 * Competency-based question formats (CBE): matching, ordering, fill in the
 * blanks, a number, and a task marked against a rubric — plus the details a
 * question carries (strand, learning outcome, core competencies, level), the
 * explanation learners read once it's marked, shuffled options and part marks.
 *
 *   cd supabase/functions/api
 *   deno test --allow-env --allow-read --config deno.json cbe_questions_test.ts
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { autoMark, blankCount, cleanQuestions, cleanResponse, cleanRubricLevels, type Question, rubricMarks } from "./lms.ts";
import { call, freshWorld, type Row } from "./test_world.ts";

const LEARNER = "hpl_learnertoken";
const one = (q: Record<string, unknown>) => {
  const r = cleanQuestions([q]);
  if ("error" in r) throw new Error(r.error);
  return r.questions[0];
};
const err = (q: Record<string, unknown>) => {
  const r = cleanQuestions([q]);
  return "error" in r ? r.error : "";
};

Deno.test("matching: items, answers to match them with (extra ones allowed), a match for each", () => {
  const q = one({ type: "matching", prompt: "Match each animal to its group", maxMarks: 3,
    options: { left: ["Cow", "Hen", "Tilapia"], right: ["Mammal", "Bird", "Fish", "Insect"] }, answerKey: [0, 1, 2] });
  assertEquals(q.options, { left: ["Cow", "Hen", "Tilapia"], right: ["Mammal", "Bird", "Fish", "Insect"] });
  assertEquals(q.meta?.partial, true, "part marks are on by default");
  assertEquals(autoMark(q, [0, 1, 2]), 3);
  assertEquals(autoMark(q, [0, 3, 2]), 2, "two of three right");
  assertEquals(autoMark({ ...q, meta: { partial: false } }, [0, 3, 2]), 0, "all or nothing when part marks are off");
  assertEquals(cleanResponse(q, [1, null]), [1, null, null], "unanswered items are blank");
  assertEquals(cleanResponse(q, [0, 9, 1]), undefined, "not one of the answers");
  assert(err({ type: "matching", prompt: "Q", maxMarks: 1, options: { left: ["a", "b"], right: ["x", "y"] }, answerKey: [0] }).includes("right match"));
  assert(err({ type: "matching", prompt: "Q", maxMarks: 1, options: { left: ["a"], right: ["x", "y"] }, answerKey: [0] }).includes("items to match"));
});

Deno.test("ordering: given in the right order, stored jumbled, marked by position", () => {
  const steps = ["Collect materials", "Measure", "Mix", "Record results"];
  const q = one({ type: "ordering", prompt: "Put the steps of the experiment in order", maxMarks: 4, options: steps });
  const opts = q.options as string[];
  const key = q.answerKey as number[];
  assertEquals([...opts].sort(), [...steps].sort());
  assert(opts.join() !== steps.join(), "learners don't get them in the right order");
  assertEquals(key.map((k) => opts[k]), steps, "the key gives the right order back");
  assertEquals(autoMark(q, key), 4);
  const swapped = [key[1], key[0], key[2], key[3]];
  assertEquals(autoMark(q, swapped), 2, "two in the right place");
  assertEquals(cleanResponse(q, [0, 0, 1, 2]), undefined, "each item once");
  assertEquals(cleanResponse(q, [3, 2, 1, 0]), [3, 2, 1, 0]);
});

Deno.test("fill in the blanks: answers in square brackets, other accepted answers after a slash", () => {
  const q = one({ type: "fill_blanks", prompt: "Water boils at [100/hundred] °C and freezes at [0/zero] °C.", maxMarks: 2 });
  assertEquals(q.prompt, "Water boils at {{1}} °C and freezes at {{2}} °C.", "learners never see the answers");
  assertEquals(q.answerKey, [["100", "hundred"], ["0", "zero"]]);
  assertEquals(blankCount(q.prompt), 2);
  assertEquals(autoMark(q, [" Hundred ", "0"]), 2, "capitals and spaces don't matter");
  assertEquals(autoMark(q, ["100", "1"]), 1);
  assertEquals(cleanResponse(q, ["100"]), ["100", ""]);
  assertEquals(cleanResponse(q, ["a", "b", "c"]), undefined, "more answers than blanks");
  assert(err({ type: "fill_blanks", prompt: "No blanks here", maxMarks: 1 }).includes("square brackets"));
});

Deno.test("numeric: the right number, with an allowed difference and a unit", () => {
  const q = one({ type: "numeric", prompt: "Area of a 2.5 m by 2 m room?", maxMarks: 2, answerKey: { value: 5, tolerance: 0.1 }, meta: { unit: "m²" } });
  assertEquals([q.answerKey, q.meta?.unit], [{ value: 5, tolerance: 0.1 }, "m²"]);
  assertEquals([autoMark(q, 5), autoMark(q, "5,05"), autoMark(q, "4.8"), autoMark(q, null)], [2, 2, 0, 0], "a decimal comma counts");
  assertEquals([cleanResponse(q, "2.5"), cleanResponse(q, "abc")], [2.5, undefined]);
  assert(err({ type: "numeric", prompt: "Q", maxMarks: 1, answerKey: { value: "" } }).includes("right number"));
});

Deno.test("rubric tasks: criteria with four levels, marked by the level chosen for each", () => {
  const q = one({ type: "rubric", prompt: "Design a poster on saving water", maxMarks: 8, meta: { rubric: [
    { criterion: "Message is clear", levels: ["Clear and persuasive", "Clear", "Partly clear", "Unclear"] },
    { criterion: "Uses correct facts" },
  ] } });
  assertEquals(q.meta?.rubric?.length, 2);
  assertEquals(q.meta?.rubric?.[1].levels, ["", "", "", ""], "descriptions are optional");
  assertEquals(autoMark(q, "my poster"), null, "the teacher marks it");
  assertEquals([rubricMarks([4, 4], 8), rubricMarks([4, 2], 8), rubricMarks([1, 1], 8)], [8, 6, 2]);
  assertEquals([cleanRubricLevels([4, 3], 2), cleanRubricLevels([5, 3], 2), cleanRubricLevels([4], 2)], [[4, 3], null, null]);
  assert(err({ type: "rubric", prompt: "Q", maxMarks: 4 }).includes("criteria"));
});

Deno.test("advanced multiple choice: feedback per option, shuffling, part marks for multiple response", () => {
  const mc = one({ type: "multiple_choice", prompt: "2 + 3 × 4 = ?", maxMarks: 1, options: ["20", "14", "24"], answerKey: 1,
    meta: { shuffle: true, optionFeedback: ["Multiply before adding", "", ""], explanation: "× comes before +", partial: true } });
  assertEquals(mc.meta, { explanation: "× comes before +", shuffle: true, optionFeedback: ["Multiply before adding", "", ""] }, "no part marks on one-answer questions");
  const mr = one({ type: "multiple_response", prompt: "Which are prime?", maxMarks: 4, options: ["2", "4", "5", "7"], answerKey: [0, 2, 3], meta: { partial: true } });
  assertEquals([autoMark(mr, [0, 2, 3]), autoMark(mr, [0, 2]), autoMark(mr, [0, 1, 2]), autoMark(mr, [1])], [4, 2.67, 1.33, 0], "each wrong tick takes one right one away");
  const strict = one({ type: "multiple_response", prompt: "Which are prime?", maxMarks: 4, options: ["2", "4", "5", "7"], answerKey: [0, 2, 3] });
  assertEquals([strict.meta?.partial, autoMark(strict, [0, 2])], [false, 0], "all or nothing unless part marks are on, as before");
  assertEquals(one({ type: "true_false", prompt: "Q", maxMarks: 1, answerKey: true, meta: { shuffle: true } }).meta?.shuffle, undefined);
});

Deno.test("CBE details: strand, sub-strand, outcome, core competencies and level are kept; anything else dropped", () => {
  const q = one({ type: "short_answer", prompt: "Q", maxMarks: 1, answerKey: ["x"], meta: {
    strand: " Numbers ", subStrand: "Fractions", outcome: "Add fractions with the same denominator",
    competencies: ["critical_thinking", "critical_thinking", "not_a_competency", "communication"], level: "apply", colour: "red",
  } });
  assertEquals(q.meta, { strand: "Numbers", subStrand: "Fractions", outcome: "Add fractions with the same denominator", competencies: ["critical_thinking", "communication"], level: "apply" });
  assertEquals(one({ type: "teacher_marked", prompt: "Q", maxMarks: 1, meta: { level: "memorise" } }).meta, {}, "only the six levels");
});

Deno.test("a CBE assignment end to end: the learner never sees an answer, the rubric gives the marks, the explanation comes after", async () => {
  const db = freshWorld();
  const made = await call("POST", "/assignments", "tok_teacher", {
    classId: "cls_1", subjectId: "mathematics", title: "Fractions check", startsAt: "2026-09-15T08:00:00.000Z",
    dueAt: new Date(Date.now() + 3 * 864e5).toISOString(),
    questions: [
      { type: "fill_blanks", prompt: "½ + ½ = [1/one]", maxMarks: 1, meta: { explanation: "Two halves make a whole", competencies: ["critical_thinking"] } },
      { type: "matching", prompt: "Match", maxMarks: 2, options: { left: ["½", "¼"], right: ["0.5", "0.25"] }, answerKey: [0, 1] },
      { type: "numeric", prompt: "¾ as a percentage", maxMarks: 1, answerKey: { value: 75 }, meta: { unit: "%" } },
      { type: "rubric", prompt: "Explain how you would share 3 cakes among 4 people", maxMarks: 4, meta: { rubric: [
        { criterion: "Reasoning", levels: ["Full and clear", "Clear", "Partial", "Little"] }, { criterion: "Uses fractions correctly" },
      ] } },
    ],
  });
  assertEquals(made.status, 200, JSON.stringify(made.json));
  const id = made.json.assignment.id;
  assertEquals(made.json.questions[0].meta.explanation, "Two halves make a whole", "the teacher sees everything");
  assertEquals((await call("POST", `/assignments/${id}/status`, "tok_teacher", { status: "published" })).status, 200);

  const started = await call("POST", `/learner/assignments/${id}/start`, LEARNER);
  assertEquals(started.status, 200, JSON.stringify(started.json));
  const qs = started.json.questions as Row[];
  assert(qs.every((q) => q.answerKey === undefined), "no answer key");
  assertEquals(qs[0].prompt, "½ + ½ = {{1}}", "no answer in the blanks");
  assertEquals([qs[0].meta.explanation, qs[0].meta.competencies], [undefined, ["critical_thinking"]], "the explanation waits for the marking");
  assertEquals(qs[3].meta.rubric[0].levels[0], "Full and clear", "the learner can read the rubric");

  const sent = await call("POST", `/learner/assignments/${id}/submit`, LEARNER, { answers: [
    { questionId: qs[0].id, response: ["One"] },
    { questionId: qs[1].id, response: [0, 0] },
    { questionId: qs[2].id, response: "75" },
    { questionId: qs[3].id, response: "Cut each cake into four" },
  ] });
  assertEquals(sent.status, 200, JSON.stringify(sent.json));
  const auto = (qid: string) => db.submission_answers.find((x) => x.question_id === qid)!.auto_marks;
  assertEquals([auto(qs[0].id), auto(qs[1].id), auto(qs[2].id)], [1, 1, 1], "marked on hand-in: one match of two right");
  const sub = db.assignment_submissions.find((x) => x.assignment_id === id)!;
  assertEquals(sub.status, "submitted", "the rubric task waits for the teacher");

  assertEquals((await call("POST", `/submissions/${sub.id}/mark`, "tok_teacher", { answers: [{ questionId: qs[3].id, rubric: [4] }] })).status, 400, "a level for every criterion");
  const marked = await call("POST", `/submissions/${sub.id}/mark`, "tok_teacher", { answers: [{ questionId: qs[3].id, rubric: [4, 2] }] });
  assertEquals(marked.status, 200, JSON.stringify(marked.json));
  assertEquals(db.submission_answers.find((x) => x.question_id === qs[3].id)!.rubric, [4, 2]);
  assertEquals([marked.json.submission.marks, marked.json.submission.maxMarks], [6, 8], "1 + 1 + 1 + 3 (rubric 4 and 2 of 4 → 3 of 4 marks)");

  const seen = await call("GET", `/learner/assignments/${id}`, LEARNER);
  assertEquals(seen.json.questions[0].meta.explanation, "Two halves make a whole", "once marked, the learner reads why");
  assertEquals(seen.json.answers.find((x: Row) => x.questionId === qs[3].id).rubric, [4, 2]);
});
