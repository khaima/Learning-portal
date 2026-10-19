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
  // Competency-based formats (CBE): matching, putting in order, filling in blanks, a number, and a
  // task the teacher marks against a rubric (performance, project, practical, oral).
  "matching", "ordering", "fill_blanks", "numeric", "rubric",
] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const ASSIGNMENT_STATUSES = ["draft", "published", "closed"] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

/** Kenya's CBE core competencies — a question can say which ones it builds. */
export const CORE_COMPETENCIES = [
  "communication", "critical_thinking", "creativity", "citizenship", "digital_literacy", "learning_to_learn", "self_efficacy",
] as const;
/** How much thinking a question asks for (Bloom's levels, as CBE item-writing uses them). */
export const COGNITIVE_LEVELS = ["remember", "understand", "apply", "analyse", "evaluate", "create"] as const;
/** A rubric's four levels, best first: EE 4 · ME 3 · AE 2 · BE 1. */
export const RUBRIC_LEVELS = 4;

/** What a question carries besides its answer: where it sits in the CBE curriculum, which
    competencies it builds, how it's marked, and what the learner reads once it's marked. */
export type QuestionMeta = {
  strand?: string; subStrand?: string; outcome?: string;
  competencies?: string[]; level?: string;
  explanation?: string;          // shown to the learner once marked
  optionFeedback?: string[];     // choice questions: why each option is right or wrong (once marked)
  shuffle?: boolean;             // choice and matching questions: each learner sees the options in their own order
  partial?: boolean;             // part marks for part of the answer (multiple response, matching, ordering, blanks)
  unit?: string;                 // numeric
  rubric?: { criterion: string; levels: string[] }[]; // rubric: what each level looks like, best first
};

export type Question = {
  id: string;
  type: QuestionType;
  prompt: string;
  options: unknown;              // a list of choices; for matching { left, right }
  answerKey: unknown;
  maxMarks: number;
  meta?: QuestionMeta;
};

export type Band = { code: string; label: string; minPercent: number };

const MAX_QUESTIONS = 100;
const MAX_OPTIONS = 10;
const MAX_MATCH_ANSWERS = 12;
const MAX_BLANKS = 20;
const MAX_CRITERIA = 8;
const MAX_PROMPT = 2000;
const MAX_OPTION = 300;
const MAX_TEXT_ANSWER = 5000;
export const MAX_FILES_PER_ANSWER = 5;

export const round2 = (n: number) => Math.round(n * 100) / 100;
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const normText = (s: unknown) => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const texts = (v: unknown) => (Array.isArray(v) ? v : []).map((o: unknown) => String(o ?? "").trim());
const choiceTypes = new Set(["multiple_choice", "multiple_response"]);
const partialTypes = new Set(["multiple_response", "matching", "ordering", "fill_blanks"]);

/** A blank in a fill-in-the-blanks question, as stored: the teacher writes [answer/also accepted]. */
const TOKEN = /\{\{(\d+)\}\}/g;
export const blankCount = (prompt: unknown) => (String(prompt ?? "").match(TOKEN) ?? []).length;

/** The same jumbled order every time for the same items, never the right order (two or more). */
function jumble(n: number, seed: string): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    const j = h % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  if (n > 1 && order.every((v, i) => v === i)) order.push(order.shift()!);
  return order;
}

function listError(n: string, items: string[], min: number, max: number, what: string): string | null {
  if (items.length < min || items.length > max) return `${n}: give between ${min} and ${max} ${what}`;
  if (items.some((o) => !o || o.length > MAX_OPTION)) return `${n}: every one needs text (up to ${MAX_OPTION} characters)`;
  if (new Set(items.map((o) => o.toLowerCase())).size !== items.length) return `${n}: they must be different`;
  return null;
}

/** The question's CBE details and settings, cleaned; or the first problem. */
function cleanMeta(raw: unknown, type: QuestionType, optionCount: number, n: string): { meta: QuestionMeta } | { error: string } {
  const m = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const text = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
  const meta: QuestionMeta = {};
  for (const [k, max] of [["strand", 120], ["subStrand", 120], ["outcome", 500], ["explanation", 2000]] as const) {
    const v = text(m[k], max);
    if (v) meta[k] = v;
  }
  const comps = [...new Set(texts(m.competencies))].filter((c) => (CORE_COMPETENCIES as readonly string[]).includes(c));
  if (comps.length) meta.competencies = comps;
  if ((COGNITIVE_LEVELS as readonly string[]).includes(String(m.level ?? ""))) meta.level = String(m.level);
  if ((choiceTypes.has(type) || type === "matching") && m.shuffle === true) meta.shuffle = true;
  // Part marks: on by default for matching, ordering and blanks; multiple response stays all-or-nothing unless asked.
  if (partialTypes.has(type)) meta.partial = m.partial === undefined ? type !== "multiple_response" : m.partial === true;
  if (choiceTypes.has(type) && Array.isArray(m.optionFeedback)) {
    const fb = Array.from({ length: optionCount }, (_, i) => text((m.optionFeedback as unknown[])[i], MAX_OPTION));
    if (fb.some(Boolean)) meta.optionFeedback = fb;
  }
  if (type === "numeric") { const u = text(m.unit, 20); if (u) meta.unit = u; }
  if (type === "rubric") {
    const rows = Array.isArray(m.rubric) ? m.rubric : [];
    if (!rows.length || rows.length > MAX_CRITERIA) return { error: `${n}: give the rubric between 1 and ${MAX_CRITERIA} criteria` };
    const rubric = rows.map((r: Record<string, unknown>) => ({
      criterion: text(r?.criterion, 200),
      levels: Array.from({ length: RUBRIC_LEVELS }, (_, i) => text((Array.isArray(r?.levels) ? r.levels : [])[i], MAX_OPTION)),
    }));
    if (rubric.some((r) => !r.criterion)) return { error: `${n}: name every rubric criterion` };
    meta.rubric = rubric;
  }
  return { meta };
}

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
    let prompt = String(q.prompt ?? "").trim();
    if (!prompt) return { error: `${n}: write the question` };
    if (prompt.length > MAX_PROMPT) return { error: `${n}: the question is too long` };
    const maxMarks = Number(q.maxMarks);
    if (!Number.isFinite(maxMarks) || maxMarks <= 0 || maxMarks > 1000) return { error: `${n}: marks must be between 0.5 and 1000` };
    let options: unknown = [];
    let answerKey: unknown = null;
    if (choiceTypes.has(type)) {
      const opts = texts(q.options);
      const bad = listError(n, opts, 2, MAX_OPTIONS, "options");
      if (bad) return { error: bad.replace("they must", "options must").replace("every one", "every option") };
      options = opts;
      if (type === "multiple_choice") {
        if (!isInt(q.answerKey) || q.answerKey < 0 || q.answerKey >= opts.length) return { error: `${n}: mark the right option` };
        answerKey = q.answerKey;
      } else {
        const keys = Array.isArray(q.answerKey) ? q.answerKey : [];
        if (!keys.length || !keys.every((k: unknown) => isInt(k) && k >= 0 && k < opts.length) || new Set(keys).size !== keys.length) {
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
    } else if (type === "matching") {
      const left = texts(q.options?.left), right = texts(q.options?.right);
      const badL = listError(n, left, 2, MAX_OPTIONS, "items to match");
      if (badL) return { error: badL };
      const badR = listError(n, right, 2, MAX_MATCH_ANSWERS, "answers to match them with");
      if (badR) return { error: badR };
      const keys = Array.isArray(q.answerKey) ? q.answerKey : [];
      if (keys.length !== left.length || !keys.every((k: unknown) => isInt(k) && k >= 0 && k < right.length)) return { error: `${n}: choose the right match for every item` };
      options = { left, right };
      answerKey = keys;
    } else if (type === "ordering") {
      // The teacher gives the items in the right order; learners get them jumbled.
      const items = texts(q.options);
      const bad = listError(n, items, 2, MAX_OPTIONS, "items to put in order");
      if (bad) return { error: bad };
      const order = jumble(items.length, items.join("␟"));
      options = order.map((k) => items[k]);
      answerKey = items.map((_, k) => order.indexOf(k)); // the options, in the right order
    } else if (type === "fill_blanks") {
      const blanks: string[][] = [];
      const text = prompt.replace(/\[([^[\]]+)\]/g, (_, inner: string) => {
        blanks.push(inner.split("/").map((s) => s.trim()).filter(Boolean).slice(0, 10));
        return `{{${blanks.length}}}`;
      });
      if (!blanks.length) return { error: `${n}: put each blank's answer in square brackets — e.g. Water boils at [100] °C` };
      if (blanks.length > MAX_BLANKS) return { error: `${n}: at most ${MAX_BLANKS} blanks` };
      if (blanks.some((b) => !b.length)) return { error: `${n}: every blank needs an answer` };
      prompt = text;
      answerKey = blanks;
    } else if (type === "numeric") {
      const value = Number(q.answerKey?.value);
      const tolerance = q.answerKey?.tolerance == null || q.answerKey.tolerance === "" ? 0 : Number(q.answerKey.tolerance);
      if (q.answerKey?.value === "" || q.answerKey?.value == null || !Number.isFinite(value)) return { error: `${n}: give the right number` };
      if (!Number.isFinite(tolerance) || tolerance < 0) return { error: `${n}: the allowed difference can't be negative` };
      answerKey = { value, tolerance };
    }
    const optionCount = Array.isArray(options) ? options.length : 0;
    const m = cleanMeta(q.meta, type, optionCount, n);
    if ("error" in m) return m;
    out.push({ type, prompt, options, answerKey, maxMarks: round2(maxMarks), meta: m.meta });
  }
  return { questions: out };
}

/** Does this question get a mark without a teacher? */
export function isAutoMarked(q: Pick<Question, "type" | "answerKey">): boolean {
  if (["multiple_choice", "multiple_response", "true_false", "matching", "ordering", "fill_blanks", "numeric"].includes(q.type)) return true;
  return q.type === "short_answer" && Array.isArray(q.answerKey) && q.answerKey.length > 0;
}

/** A typed number: "2.5", "2,5" or " 3 " — or null. */
const parseNumber = (v: unknown) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const t = String(v ?? "").trim().replace(/\s/g, "");
  if (!t) return null;
  const n = Number(t.includes(".") ? t.replace(/,/g, "") : t.replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

/** A learner's answer, checked against the question. `undefined` = not a
    valid answer for this question (rejected); `null` = left blank. */
export function cleanResponse(q: Pick<Question, "type" | "options"> & { prompt?: string }, raw: unknown): unknown {
  if (raw === null || raw === undefined || raw === "") return null;
  const opts = Array.isArray(q.options) ? q.options : [];
  switch (q.type) {
    case "multiple_choice":
      return isInt(raw) && raw >= 0 && raw < opts.length ? raw : undefined;
    case "multiple_response": {
      if (!Array.isArray(raw)) return undefined;
      if (!raw.every((k) => isInt(k) && k >= 0 && k < opts.length)) return undefined;
      return [...new Set(raw as number[])].sort((a, b) => a - b);
    }
    case "true_false":
      return typeof raw === "boolean" ? raw : undefined;
    case "short_answer":
    case "teacher_marked":
    case "rubric":
      return typeof raw === "string" ? raw.slice(0, MAX_TEXT_ANSWER) : undefined;
    case "file_upload":
      return null; // the files are the answer
    case "matching": {
      const o = (q.options ?? {}) as { left?: unknown[]; right?: unknown[] };
      const left = o.left?.length ?? 0, right = o.right?.length ?? 0;
      if (!Array.isArray(raw) || raw.length > left) return undefined;
      if (!raw.every((k) => k == null || (isInt(k) && k >= 0 && k < right))) return undefined;
      return Array.from({ length: left }, (_, i) => (raw[i] == null ? null : raw[i]));
    }
    case "ordering": {
      if (!Array.isArray(raw) || raw.length !== opts.length) return undefined;
      const seen = new Set(raw);
      return seen.size === opts.length && raw.every((k) => isInt(k) && k >= 0 && k < opts.length) ? raw : undefined;
    }
    case "fill_blanks": {
      const count = blankCount(q.prompt);
      if (!Array.isArray(raw) || raw.length > count) return undefined;
      return Array.from({ length: count }, (_, i) => String(raw[i] ?? "").slice(0, MAX_OPTION));
    }
    case "numeric":
      return parseNumber(raw) ?? undefined;
  }
  return undefined;
}

/** Part of the marks for part of the answer, or all-or-nothing. */
const share = (right: number, of: number, full: number, partial: boolean) =>
  of <= 0 ? 0 : partial ? round2((full * Math.max(0, right)) / of) : right === of ? full : 0;

/** Marks for an auto-marked question; null when a teacher has to mark it.
    Multiple response is all-or-nothing unless part marks are on: then each
    right option ticked counts, and each wrong one ticked takes one away. */
export function autoMark(q: Pick<Question, "type" | "answerKey" | "maxMarks"> & { meta?: QuestionMeta }, response: unknown): number | null {
  if (!isAutoMarked(q)) return null;
  const full = q.maxMarks;
  const partial = q.meta?.partial === true;
  switch (q.type) {
    case "multiple_choice":
      return response === q.answerKey ? full : 0;
    case "multiple_response": {
      const want = (q.answerKey as number[]) ?? [];
      const got = Array.isArray(response) ? [...new Set(response as number[])].sort((a, b) => a - b) : [];
      if (!partial) return got.length === want.length && got.every((v, i) => v === want[i]) ? full : 0;
      const right = got.filter((k) => want.includes(k)).length, wrong = got.length - right;
      return share(right - wrong, want.length, full, true);
    }
    case "true_false":
      return response === q.answerKey ? full : 0;
    case "short_answer":
      return (q.answerKey as string[]).some((a) => normText(a) === normText(response)) ? full : 0;
    case "matching":
    case "ordering": {
      const key = (q.answerKey as number[]) ?? [];
      const got = Array.isArray(response) ? response : [];
      return share(key.filter((k, i) => got[i] === k).length, key.length, full, partial);
    }
    case "fill_blanks": {
      const key = (q.answerKey as string[][]) ?? [];
      const got = Array.isArray(response) ? response : [];
      return share(key.filter((acc, i) => acc.some((a) => normText(a) === normText(got[i]))).length, key.length, full, partial);
    }
    case "numeric": {
      const k = q.answerKey as { value: number; tolerance?: number };
      const got = parseNumber(response);
      return got != null && Math.abs(got - k.value) <= (k.tolerance ?? 0) + 1e-9 ? full : 0;
    }
  }
  return null;
}

/** A rubric-marked answer's marks from the level chosen for each criterion (4 = EE … 1 = BE). */
export function rubricMarks(levels: number[], maxMarks: number): number {
  if (!levels.length) return 0;
  return round2((maxMarks * levels.reduce((t, l) => t + l, 0)) / (RUBRIC_LEVELS * levels.length));
}
/** The levels a teacher chose, checked against the rubric: one 1–4 per criterion, or the problem. */
export function cleanRubricLevels(raw: unknown, criteria: number): number[] | null {
  if (!Array.isArray(raw) || raw.length !== criteria) return null;
  return raw.every((l) => isInt(l) && l >= 1 && l <= RUBRIC_LEVELS) ? (raw as number[]) : null;
}

export const percentOf = (marks: number, max: number) => (max > 0 ? round2(Math.min(100, Math.max(0, (marks / max) * 100))) : 0);

/** Each learner's average mark on their marked work (a learner with none isn't there). */
export function averagesOf(pairs: Pair[]): number[] {
  const marks = new Map<string, number[]>();
  for (const p of pairs) {
    if (p.sub?.status !== "marked" || p.sub.percentage == null) continue;
    if (!marks.has(p.learnerId)) marks.set(p.learnerId, []);
    marks.get(p.learnerId)!.push(Number(p.sub.percentage));
  }
  return [...marks.values()].map((m) => m.reduce((t, x) => t + x, 0) / m.length);
}

/** Learners' average marks in tens — how the marks spread, not only their mean — with the
    median and the band each range falls in. */
export function marksHistogram(averages: number[], bands: Band[]) {
  const sorted = [...averages].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  const median = sorted.length ? Math.round(sorted.length % 2 ? sorted[Math.floor(mid)] : (sorted[mid - 1] + sorted[mid]) / 2) : null;
  const bins = Array.from({ length: 10 }, (_, i) => ({
    from: i * 10, to: i === 9 ? 100 : i * 10 + 9,
    value: sorted.filter((v) => (i === 9 ? v >= 90 : v >= i * 10 && v < i * 10 + 10)).length,
    band: bandFor(i * 10, bands),
  }));
  return { learners: sorted.length, median, bins };
}

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

/** Learners expected to do each assignment: everyone enrolled in its class
    for some part of the time it was open (from its start — or publication —
    to its due date), from the enrollment history. */
// deno-lint-ignore no-explicit-any
export function expectedFrom(assignments: Record<string, any>[], enrollments: Record<string, any>[], now = new Date()): Map<string, Set<string>> {
  const iso = now.toISOString();
  // deno-lint-ignore no-explicit-any
  const byClass = new Map<string, Record<string, any>[]>();
  for (const e of enrollments) {
    if (!e.class_id) continue;
    if (!byClass.has(e.class_id)) byClass.set(e.class_id, []);
    byClass.get(e.class_id)!.push(e);
  }
  const map = new Map<string, Set<string>>();
  for (const a of assignments) {
    const from = String(a.starts_at ?? a.published_at ?? a.created_at ?? iso).slice(0, 10);
    const to = String(a.due_at ?? iso).slice(0, 10);
    const set = new Set<string>();
    for (const e of byClass.get(a.class_id) ?? []) {
      if (e.enrollment_date && String(e.enrollment_date).slice(0, 10) > to) continue;
      if (e.exit_date && String(e.exit_date).slice(0, 10) < from) continue;
      set.add(e.learner_id);
    }
    map.set(a.id, set);
  }
  return map;
}

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
