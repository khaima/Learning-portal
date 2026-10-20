/**
 * Class attendance: the daily register, and what it adds up to.
 *
 * A teacher of a class takes its register for a school day: each learner
 * present, late, absent, or absent with a reason the school accepts
 * (excused: sick, family, permission, other). One register per class per
 * day; taking it again corrects it — nothing is deleted, and every change
 * is in the audit log.
 *
 * The rate is the share of marks that are present or late. A learner below
 * 90% (missing one school day in ten or more — the usual line for
 * "chronically absent") or absent three school days running is one to
 * follow up. Neither is said of a learner with fewer than five days on the
 * register: two absences in three days isn't a pattern yet.
 *
 * Pure functions: index.ts loads the rows and checks who may see them.
 */

export const ATTENDANCE_STATUSES = ["present", "late", "absent", "excused"] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];
export const ABSENCE_REASONS = ["sick", "family", "permission", "other"] as const;
/** At school that day (on time or not). */
export const isThere = (s: string) => s === "present" || s === "late";

/** Below this share of days at school, a learner is followed up. */
export const FOLLOW_UP_RATE = 90;
/** …or absent this many school days running (the most recent ones). */
export const FOLLOW_UP_STREAK = 3;
/** Days on the register before a learner's rate is judged. */
export const MIN_DAYS = 5;
export const MAX_NOTE = 200;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const isDay = (v: unknown): v is string => typeof v === "string" && DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

const round1 = (n: number) => Math.round(n * 10) / 10;
const pct = (part: number, whole: number) => (whole ? round1((part / whole) * 100) : null);

/** Today in Kenya (EAT, UTC+3): the day a register is for. */
export const eatDay = (at = new Date()) => new Date(at.getTime() + 3 * 3600e3).toISOString().slice(0, 10);
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
/** 1 Monday … 7 Sunday. */
const weekday = (day: string) => ((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];

/** School days from `from` to `to`: Monday to Friday, inside a term when there are terms. At most a year. */
export function schoolDays(from: string, to: string, terms: { starts_on: string; ends_on: string }[] = []): string[] {
  const out: string[] = [];
  for (let d = from, n = 0; d <= to && n < 400; d = addDays(d, 1), n++) {
    if (weekday(d) > 5) continue;
    if (terms.length && !terms.some((t) => d >= t.starts_on && d <= t.ends_on)) continue;
    out.push(d);
  }
  return out;
}

export type Mark = { learnerId: string; status: AttendanceStatus; reason: string | null; note: string | null };

/** The marks sent for a register, checked: learners on the class's list, a known status, and a
    reason only with an absence. A learner sent twice counts once (the last). The problem, or the marks. */
export function cleanMarks(raw: unknown, roster: Set<string>): Mark[] | string {
  if (!Array.isArray(raw) || !raw.length) return "Mark at least one learner";
  if (raw.length > 500) return "That's more learners than a class has";
  const out = new Map<string, Mark>();
  for (const x of raw as Record<string, unknown>[]) {
    const learnerId = String(x?.learnerId ?? "");
    if (!roster.has(learnerId)) return "Someone on the list isn't in this class";
    const status = String(x?.status ?? "") as AttendanceStatus;
    if (!ATTENDANCE_STATUSES.includes(status)) return "Mark each learner present, late, absent or excused";
    const reason = x?.reason == null || x.reason === "" ? null : String(x.reason);
    if (reason && (!(ABSENCE_REASONS as readonly string[]).includes(reason) || isThere(status))) return "A reason goes only with an absence";
    const note = x?.note == null ? null : String(x.note).trim().slice(0, MAX_NOTE) || null;
    out.set(learnerId, { learnerId, status, reason, note });
  }
  return [...out.values()];
}

/** What changed between the marks kept and the marks sent: each learner whose mark is new or different. */
export function changesOf(before: Map<string, { status: string; reason?: string | null; note?: string | null }>, marks: Mark[]) {
  return marks.filter((m) => {
    const b = before.get(m.learnerId);
    return !b || b.status !== m.status || (b.reason ?? null) !== m.reason || (b.note ?? null) !== m.note;
  }).map((m) => ({ learnerId: m.learnerId, from: before.get(m.learnerId)?.status ?? null, to: m.status }));
}

/* ------------------------------------------------------------ adding it up */

export type Counts = { marks: number; present: number; late: number; absent: number; excused: number };
const zero = (): Counts => ({ marks: 0, present: 0, late: 0, absent: 0, excused: 0 });
function add(t: Counts, status: string) {
  if (!(ATTENDANCE_STATUSES as readonly string[]).includes(status)) return;
  t.marks++;
  t[status as AttendanceStatus]++;
}
/** Present or late, of every mark — as a percentage (one decimal), or null with no marks. */
export const rateOf = (t: Counts) => pct(t.present + t.late, t.marks);
export const countsOf = (statuses: string[]) => { const t = zero(); for (const s of statuses) add(t, s); return { ...t, rate: rateOf(t) }; };

/** A register as stored: it keeps its own counts (set on every save), so totals by class, grade,
    school, day and weekday need only the registers — the learners' marks are read for one class or school. */
export type RegisterRow = { id: string; class_id: string; school_id: string; taken_on: string; present: number; late: number; absent: number; excused: number };
export type MarkRow = { register_id: string; learner_id: string; status: string; reason?: string | null };
export type LearnerInfo = { name: string; code?: string | null; className?: string | null; left?: boolean };

const countsOfRegister = (r: RegisterRow): Counts => {
  const present = Number(r.present) || 0, late = Number(r.late) || 0, absent = Number(r.absent) || 0, excused = Number(r.excused) || 0;
  return { marks: present + late + absent + excused, present, late, absent, excused };
};
const plus = (t: Counts, x: Counts) => { t.marks += x.marks; t.present += x.present; t.late += x.late; t.absent += x.absent; t.excused += x.excused; };

/** One learner's days in date order: their counts, rate, how many of the latest days in a row
    they were away, their last five days, and whether to follow them up. */
export function learnerRecord(days: { day: string; status: string; reason?: string | null }[]) {
  const ordered = [...days].sort((a, b) => a.day.localeCompare(b.day));
  const t = zero();
  for (const d of ordered) add(t, d.status);
  let streak = 0;
  for (let i = ordered.length - 1; i >= 0 && !isThere(ordered[i].status); i--) streak++;
  const rate = rateOf(t);
  const lastAway = [...ordered].reverse().find((d) => !isThere(d.status));
  return {
    ...t, days: t.marks, rate, streak,
    lastAbsent: lastAway?.day ?? null,
    recent: ordered.slice(-5).map((d) => d.status),
    followUp: (t.marks >= MIN_DAYS && rate != null && rate < FOLLOW_UP_RATE) || streak >= FOLLOW_UP_STREAK,
  };
}

/**
 * Registers over a stretch of school days, added up: overall, by day, by
 * weekday and by group (class, grade or school) — from the registers' own
 * counts. With the learners' marks too: each learner's record, the reasons
 * given for absences, and (grid) the register sheet, a row per learner and
 * a column per day with a register.
 *   days     the school days in the stretch (how many registers were due)
 *   groupOf  a register's group; groups: each group's label and how many classes it has
 *   learners names for the learners in the list (anyone without one is left out)
 */
export function summarizeAttendance(input: {
  registers: RegisterRow[];
  days: string[];
  groupOf: (r: RegisterRow) => string;
  groups: Map<string, { label: string; classes: number }>;
  marks?: MarkRow[];
  learners?: Map<string, LearnerInfo>;
  grid?: boolean;
}) {
  const { registers, days, groupOf, groups } = input;
  const dueDays = new Set(days);
  const totals = zero();
  const byDay = new Map<string, Counts>();
  const byWeekday = WEEKDAYS.map(() => zero());
  const byGroup = new Map<string, Counts & { registers: number; taken: number }>();
  for (const g of groups.keys()) byGroup.set(g, { ...zero(), registers: 0, taken: 0 });
  for (const r of registers) {
    const t = countsOfRegister(r);
    plus(totals, t);
    if (!byDay.has(r.taken_on)) byDay.set(r.taken_on, zero());
    plus(byDay.get(r.taken_on)!, t);
    const wd = weekday(r.taken_on);
    if (wd <= 5) plus(byWeekday[wd - 1], t);
    const g = groupOf(r);
    if (!byGroup.has(g)) byGroup.set(g, { ...zero(), registers: 0, taken: 0 });
    const row = byGroup.get(g)!;
    plus(row, t);
    row.registers++;
    if (dueDays.has(r.taken_on)) row.taken++;
  }
  const classes = [...groups.values()].reduce((n, g) => n + g.classes, 0);
  const taken = registers.filter((r) => dueDays.has(r.taken_on)).length;

  // From the learners' marks: each learner, the reasons, the sheet.
  const regById = new Map(registers.map((r) => [r.id, r]));
  const reasons: Record<string, number> = { sick: 0, family: 0, permission: 0, other: 0, none: 0 };
  const perLearner = new Map<string, { day: string; status: string; reason?: string | null }[]>();
  for (const m of input.marks ?? []) {
    const r = regById.get(m.register_id);
    if (!r) continue;
    if (!isThere(m.status)) reasons[m.reason && m.reason in reasons ? m.reason : "none"]++;
    if (!perLearner.has(m.learner_id)) perLearner.set(m.learner_id, []);
    perLearner.get(m.learner_id)!.push({ day: r.taken_on, status: m.status, reason: m.reason ?? null });
  }
  const who = input.learners;
  const learnerRows = who
    ? [...perLearner.entries()].filter(([id]) => who.has(id)).map(([id, list]) => {
        const w = who.get(id)!;
        return { id, name: w.name, code: w.code ?? null, className: w.className ?? null, left: !!w.left, ...learnerRecord(list) };
      }).sort((a, b) => (a.rate ?? 101) - (b.rate ?? 101) || b.streak - a.streak || a.name.localeCompare(b.name))
    : [];
  const registerDays = [...byDay.keys()].sort();
  return {
    totals: {
      ...totals, rate: rateOf(totals),
      registers: registers.length,
      due: days.length * classes,            // each class, each school day
      taken,                                 // of those, taken (a register on another day counts, but not here)
      coverage: pct(taken, days.length * classes),
      learners: perLearner.size,
      followUp: learnerRows.filter((l) => l.followUp).length,
    },
    byDay: registerDays.map((day) => ({ day, ...byDay.get(day)!, rate: rateOf(byDay.get(day)!) })),
    byWeekday: WEEKDAYS.map((label, i) => ({ label, ...byWeekday[i], rate: rateOf(byWeekday[i]) })),
    groups: [...byGroup.entries()].map(([key, t]) => ({
      key, label: groups.get(key)?.label ?? key, ...t, rate: rateOf(t),
      due: days.length * (groups.get(key)?.classes ?? 0),
      coverage: pct(t.taken, days.length * (groups.get(key)?.classes ?? 0)),
    })),
    reasons: input.marks ? reasons : null,
    learners: learnerRows,
    ...(input.grid ? {
      grid: {
        days: registerDays,
        rows: learnerRows.map((l) => ({
          id: l.id, name: l.name, left: l.left,
          marks: registerDays.map((day) => (perLearner.get(l.id) ?? []).find((x) => x.day === day)?.status ?? null),
        })).sort((a, b) => Number(a.left) - Number(b.left) || a.name.localeCompare(b.name)),
      },
    } : {}),
  };
}

/** Do learners who come more often do better? Learners' average marks, by how often they came —
    only where at least three learners fall in a group, and only when two groups can be compared. */
export const ATTENDANCE_BANDS = [
  { label: "90% or more", from: 90, to: 101 },
  { label: "80–89%", from: 80, to: 90 },
  { label: "Below 80%", from: 0, to: 80 },
];
export function attendanceAndMarks(rates: Map<string, number>, averages: Map<string, number>, minLearners = 3) {
  const groups = ATTENDANCE_BANDS.map((b) => {
    const marks = [...rates.entries()].filter(([id, r]) => r >= b.from && r < b.to && averages.has(id)).map(([id]) => averages.get(id)!);
    return { label: b.label, learners: marks.length, averagePercent: marks.length ? round1(marks.reduce((t, x) => t + x, 0) / marks.length) : null };
  });
  const usable = groups.filter((g) => g.learners >= minLearners);
  return usable.length >= 2 ? usable : null;
}
