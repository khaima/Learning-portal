/**
 * Assignments, marking and results — the rules, with no database access.
 *
 * Two measures are kept apart everywhere:
 *   completion  — of the learners who were meant to do a piece of work,
 *                 how many submitted it (on time or late), and
 *   achievement — the marks earned on work that has been marked.
 * Submitting is not the same as doing well, so a completion rate is never
 * reported as performance, and unmarked work never counts as a score.
 */

export const QUESTION_TYPES = [
  "multiple_choice", "multiple_response", "short_answer", "true_false", "file_upload", "teacher_marked",
] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const ASSIGNMENT_STATUSES = ["draft", "published", "closed"] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export type Question = {
  id: string;
  type: QuestionType;
  prompt: string;
  options: string[];
  answerKey: unknown;
  maxMarks: number;
};

export type Band = { code: string; label: string; minPercent: number };

const MAX_QUESTIONS = 100;
const MAX_OPTIONS = 10;
const MAX_PROMPT = 2000;
const MAX_OPTION = 300;
const MAX_TEXT_ANSWER = 5000;
export const MAX_FILES_PER_ANSWER = 5;

export const round2 = (n: number) => Math.round(n * 100) / 100;
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const normText = (s: unknown) => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/** Validates a teacher's question list. Returns clean questions (without
    ids or positions — the caller assigns those) or the first problem. */
export function cleanQuestions(raw: unknown): { questions: Omit<Question, "id">[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: "Questions must be a list" };
  if (raw.length > MAX_QUESTIONS) return { error: `At most ${MAX_QUESTIONS} questions` };
  const out: Omit<Question, "id">[] = [];
  for (let i = 0; i < raw.length; i++) {
    const q = raw[i] ?? {};
    const n = `Question ${i + 1}`;
    const type = String(q.type ?? "") as QuestionType;
    if (!QUESTION_TYPES.includes(type)) return { error: `${n}: choose a question type` };
    const prompt = String(q.prompt ?? "").trim();
    if (!prompt) return { error: `${n}: write the question` };
    if (prompt.length > MAX_PROMPT) return { error: `${n}: the question is too long` };
    const maxMarks = Number(q.maxMarks);
    if (!Number.isFinite(maxMarks) || maxMarks <= 0 || maxMarks > 1000) return { error: `${n}: marks must be between 0.5 and 1000` };
    let options: string[] = [];
    let answerKey: unknown = null;
    if (type === "multiple_choice" || type === "multiple_response") {
      options = (Array.isArray(q.options) ? q.options : []).map((o: unknown) => String(o ?? "").trim());
      if (options.length < 2 || options.length > MAX_OPTIONS) return { error: `${n}: give between 2 and ${MAX_OPTIONS} options` };
      if (options.some((o) => !o || o.length > MAX_OPTION)) return { error: `${n}: every option needs text (up to ${MAX_OPTION} characters)` };
      if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) return { error: `${n}: options must be different` };
      if (type === "multiple_choice") {
        if (!isInt(q.answerKey) || q.answerKey < 0 || q.answerKey >= options.length) return { error: `${n}: mark the right option` };
        answerKey = q.answerKey;
      } else {
        const keys = Array.isArray(q.answerKey) ? q.answerKey : [];
        if (!keys.length || !keys.every((k: unknown) => isInt(k) && k >= 0 && k < options.length) || new Set(keys).size !== keys.length) {
          return { error: `${n}: mark at least one right option` };
        }
        answerKey = [...keys].sort((a: number, b: number) => a - b);
      }
    } else if (type === "true_false") {
      if (typeof q.answerKey !== "boolean") return { error: `${n}: choose whether the answer is true or false` };
      options = ["True", "False"];
      answerKey = q.answerKey;
    } else if (type === "short_answer") {
      const accepted = (Array.isArray(q.answerKey) ? q.answerKey : [])
        .map((a: unknown) => String(a ?? "").trim()).filter(Boolean).slice(0, 20);
      answerKey = accepted; // empty: the teacher marks it
    }
    out.push({ type, prompt, options, answerKey, maxMarks: round2(maxMarks) });
  }
  return { questions: out };
}

/** Does this question get a mark without a teacher? */
export function isAutoMarked(q: Pick<Question, "type" | "answerKey">): boolean {
  if (q.type === "multiple_choice" || q.type === "multiple_response" || q.type === "true_false") return true;
  return q.type === "short_answer" && Array.isArray(q.answerKey) && q.answerKey.length > 0;
}

/** A learner's answer, checked against the question. `undefined` = not a
    valid answer for this question (rejected); `null` = left blank. */
export function cleanResponse(q: Pick<Question, "type" | "options">, raw: unknown): unknown {
  if (raw === null || raw === undefined || raw === "") return null;
  switch (q.type) {
    case "multiple_choice":
      return isInt(raw) && raw >= 0 && raw < q.options.length ? raw : undefined;
    case "multiple_response": {
      if (!Array.isArray(raw)) return undefined;
      if (!raw.every((k) => isInt(k) && k >= 0 && k < q.options.length)) return undefined;
      return [...new Set(raw as number[])].sort((a, b) => a - b);
    }
    case "true_false":
      return typeof raw === "boolean" ? raw : undefined;
    case "short_answer":
    case "teacher_marked":
      return typeof raw === "string" ? raw.slice(0, MAX_TEXT_ANSWER) : undefined;
    case "file_upload":
      return null; // the files are the answer
  }
  return undefined;
}

/** Marks for an auto-marked question; null when a teacher has to mark it.
    Multiple response is all-or-nothing: every right option and no wrong one. */
export function autoMark(q: Pick<Question, "type" | "answerKey" | "maxMarks">, response: unknown): number | null {
  if (!isAutoMarked(q)) return null;
  const full = q.maxMarks;
  switch (q.type) {
    case "multiple_choice":
      return response === q.answerKey ? full : 0;
    case "multiple_response": {
      const want = (q.answerKey as number[]) ?? [];
      const got = Array.isArray(response) ? [...new Set(response as number[])].sort((a, b) => a - b) : [];
      return got.length === want.length && got.every((v, i) => v === want[i]) ? full : 0;
    }
    case "true_false":
      return response === q.answerKey ? full : 0;
    case "short_answer":
      return (q.answerKey as string[]).some((a) => normText(a) === normText(response)) ? full : 0;
  }
  return null;
}

export const percentOf = (marks: number, max: number) => (max > 0 ? round2(Math.min(100, Math.max(0, (marks / max) * 100))) : 0);

/** The highest band this percentage reaches. */
export function bandFor(percent: number | null, bands: Band[]): string | null {
  if (percent == null) return null;
  const sorted = [...bands].sort((a, b) => b.minPercent - a.minPercent);
  return sorted.find((b) => percent >= b.minPercent)?.code ?? sorted[sorted.length - 1]?.code ?? null;
}

/** Is a submission made at `at` late for this due date? */
export const isLate = (dueAt: string | null | undefined, at: Date) => !!dueAt && at.getTime() > new Date(dueAt).getTime();

/* ------------------------------------------------------------ results */

export type ResultAssignment = {
  id: string; schoolId: string; classId: string; subjectId: string; grade: string;
  termId: string | null; yearId: string; dueAt: string | null; status: string;
};
export type ResultSubmission = {
  assignmentId: string; learnerId: string; status: string; isLate: boolean; percentage: number | null;
};
export type Summary = {
  completion: {
    assigned: number;     // learner × assignment pairs that were expected
    submitted: number;    // of those, handed in (on time or late)
    onTime: number;
    late: number;
    missing: number;      // past the due date (or closed) and not handed in
    rate: number | null;  // submitted ÷ assigned, as a percentage
  };
  achievement: {
    marked: number;              // marked submissions
    averagePercent: number | null; // mean of their percentages
    band: string | null;         // band of that mean
    bands: Record<string, number>; // how many marked submissions fell in each band
  };
};

/** One expected learner × assignment pair, with its submission if any. */
export type Pair = { a: ResultAssignment; learnerId: string; sub: ResultSubmission | null };

/** Every pair: each learner expected to do each assignment, plus anyone
    who handed it in without being expected (e.g. moved class since). */
export function pairsOf(
  assignments: ResultAssignment[],
  expected: Map<string, Set<string>>,
  submissions: ResultSubmission[],
): Pair[] {
  const subs = new Map(submissions.map((s) => [`${s.assignmentId}|${s.learnerId}`, s]));
  const out: Pair[] = [];
  for (const a of assignments) {
    if (a.status === "draft") continue;
    const learners = new Set(expected.get(a.id) ?? []);
    for (const s of submissions) if (s.assignmentId === a.id) learners.add(s.learnerId);
    for (const learnerId of learners) out.push({ a, learnerId, sub: subs.get(`${a.id}|${learnerId}`) ?? null });
  }
  return out;
}

export function summarize(pairs: Pair[], bands: Band[], now = new Date()): Summary {
  let submitted = 0, onTime = 0, late = 0, missing = 0;
  const pcts: number[] = [];
  const byBand: Record<string, number> = Object.fromEntries(bands.map((b) => [b.code, 0]));
  for (const p of pairs) {
    const handedIn = p.sub && (p.sub.status === "submitted" || p.sub.status === "marked");
    if (handedIn) {
      submitted++;
      if (p.sub!.isLate) late++; else onTime++;
    } else if (p.a.status === "closed" || (p.a.dueAt && new Date(p.a.dueAt) < now)) {
      missing++;
    }
    if (p.sub?.status === "marked" && p.sub.percentage != null) {
      pcts.push(Number(p.sub.percentage));
      const b = bandFor(Number(p.sub.percentage), bands);
      if (b) byBand[b] = (byBand[b] ?? 0) + 1;
    }
  }
  const avg = pcts.length ? round2(pcts.reduce((x, y) => x + y, 0) / pcts.length) : null;
  return {
    completion: {
      assigned: pairs.length, submitted, onTime, late, missing,
      rate: pairs.length ? round2((submitted / pairs.length) * 100) : null,
    },
    achievement: { marked: pcts.length, averagePercent: avg, band: bandFor(avg, bands), bands: byBand },
  };
}

export const RESULT_DIMENSIONS = ["learner", "class", "subject", "grade", "term", "year", "school", "assignment"] as const;
export type ResultDimension = (typeof RESULT_DIMENSIONS)[number];

export function keyOf(p: Pair, by: ResultDimension): string {
  switch (by) {
    case "learner": return p.learnerId;
    case "class": return p.a.classId;
    case "subject": return p.a.subjectId;
    case "grade": return p.a.grade;
    case "term": return p.a.termId ?? "(no term)";
    case "year": return p.a.yearId;
    case "school": return p.a.schoolId;
    case "assignment": return p.a.id;
  }
}

/** Results grouped by one dimension: one Summary per group. */
export function groupResults(pairs: Pair[], by: ResultDimension, bands: Band[], now = new Date()) {
  const groups = new Map<string, Pair[]>();
  for (const p of pairs) {
    const k = keyOf(p, by);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(p);
  }
  return [...groups.entries()].map(([key, list]) => ({ key, ...summarize(list, bands, now) }));
}
