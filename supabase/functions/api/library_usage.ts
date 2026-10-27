/**
 * The Content usage report (GET /library/usage) — pure, no database.
 *
 * Every "open" of a library resource is a row in library_interactions; a
 * timed one also has how long it stayed open (an estimate of time spent,
 * never reading attention). From those rows, narrowed to the caller's area
 * and the county / school / dates chosen, this works out:
 *
 *   totals       people, opens, timed opens, time — and learners vs staff
 *   recent       the last 30 days beside the 30 before (only when no dates
 *                are chosen: two whole, equal stretches of time)
 *   byPeriod     opens, people and time by week (or by month over a long range)
 *   byRole       who opens resources
 *   when         day of the week × three-hour block, Kenyan time
 *   byResource   each resource: opens, people, time, typical open, quick exits, last opened
 *   bySchool     each school compared (the school filter itself left off)
 *   byTopic      topic › sub-topic, as each item was tagged when it was opened
 *   attention    what someone could act on: published resources nobody
 *                opened, resources usually closed within 30 seconds, schools
 *                that never opened one, schools that went quiet
 *
 * Nothing is estimated or filled in: a resource with too few timed opens
 * isn't judged, and a comparison needs two periods that really exist.
 * Opens by HPF's own staff (Education Team, M&E, administrators checking
 * content) aren't programme use: every figure leaves them out, and
 * `hpfStaff` says how much of it there was.
 */
import { DAY_BLOCKS, dayBlocks } from "./impact.ts";
import { HPF_STAFF_ROLES } from "./permissions.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

export type UsageFilter = { school: string | null; county: string | null; from: string | null; to: string | null };
export type UsageInput = {
  items: Row[];        // library_items
  interactions: Row[]; // library_interactions, already narrowed to the caller's area
  schools: Row[];      // the schools in the caller's area: name, county
  now: Date;
};

/** An open closed within this many seconds is a "quick exit". */
export const QUICK_SECONDS = 30;
/** A resource is judged on quick exits only with at least this many timed opens. */
export const QUICK_MIN_TIMED = 5;
/** "Recent" and "gone quiet": the last 30 days. */
export const RECENT_DAYS = 30;
const LIST_CAP = 50;
const DAY_MS = 864e5;
const EAT_MS = 3 * 3600e3;

const day = (v: unknown) => String(v ?? "").slice(0, 10);
const ms = (v: unknown) => { const t = Date.parse(String(v ?? "")); return Number.isNaN(t) ? null : t; };
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
/** Which shelf a resource is on, in the words the library uses. */
export const shelfOf = (audience: unknown) =>
  audience === "staff" ? "Teacher Resources" : audience === "school_leader" ? "For School Head" : "Digital Library";

type Agg = { people: Set<string>; opens: number; seconds: number; timed: number; durations: number[]; last: number | null };
const agg = (): Agg => ({ people: new Set(), opens: 0, seconds: 0, timed: 0, durations: [], last: null });
function add(a: Agg, r: Row) {
  a.people.add(r.actor_id as string);
  a.opens++;
  if (r.duration_seconds != null) {
    a.seconds += Number(r.duration_seconds);
    a.timed++;
    a.durations.push(Number(r.duration_seconds));
  }
  const t = ms(r.started_at);
  if (t != null && (a.last == null || t > a.last)) a.last = t;
}
const sum = (rows: Row[]) => { const a = agg(); for (const r of rows) add(a, r); return a; };
const figures = (a: Agg) => ({ users: a.people.size, sessions: a.opens, totalSeconds: a.seconds });

/** The Monday a moment falls in, in Kenyan time, as YYYY-MM-DD. */
function weekOf(t: number) {
  const local = new Date(t + EAT_MS);
  const back = (local.getUTCDay() + 6) % 7;
  return isoDay(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - back));
}

export function buildLibraryUsage(input: UsageInput, f: UsageFilter) {
  const { items, interactions, schools, now } = input;
  const nowMs = now.getTime();
  const dated = !!(f.from || f.to);
  const countyNames = f.county ? new Set(schools.filter((s) => s.county === f.county).map((s) => s.name as string)) : null;
  const inRange = (r: Row) => {
    if (!dated) return true;
    const x = day(r.started_at);
    return !!x && (!f.from || x >= f.from) && (!f.to || x <= f.to);
  };

  // Three widths: the place (county, all time) · compared (+ dates: the
  // schools side by side) · shown (+ the school: everything else).
  const hpfRole = new Set<string>(HPF_STAFF_ROLES);
  const narrow = (list: Row[]) => {
    const place = list.filter((r) => !countyNames || countyNames.has(r.school));
    const compare = place.filter(inRange);
    return { place, compare, shown: f.school ? compare.filter((r) => (r.school || "") === f.school) : compare };
  };
  const { place: placeRows, compare: compareRows, shown: rows } = narrow(interactions.filter((r) => !hpfRole.has(r.role as string)));
  const hpfRows = narrow(interactions.filter((r) => hpfRole.has(r.role as string))).shown;

  const all = sum(rows);
  const learners = new Set(rows.filter((r) => r.actor_kind === "learner").map((r) => r.actor_id)).size;
  const totals = {
    ...figures(all),
    completedSessions: all.timed,
    learners,
    staff: all.people.size - learners,
    typicalSeconds: median(all.durations),
  };

  // The last 30 days beside the 30 before — whole stretches of equal length.
  // With dates chosen the period is someone's choice, possibly still running: no comparison.
  let recent = null;
  if (!dated) {
    const cut = nowMs - RECENT_DAYS * DAY_MS, cut2 = cut - RECENT_DAYS * DAY_MS;
    const between = (a: number, b: number) => sum(rows.filter((r) => { const t = ms(r.started_at); return t != null && t >= a && t < b; }));
    const last = between(cut, nowMs + 1), before = between(cut2, cut);
    recent = { days: RECENT_DAYS, last: figures(last), before: figures(before) };
  }

  // Over time: the last 12 weeks; a chosen range by week, or by month past ~4 months.
  const stamps = rows.map((r) => ms(r.started_at)).filter((t): t is number => t != null);
  const startMs = f.from ? Date.parse(`${f.from}T00:00:00Z`) : dated ? stamps.reduce((m, t) => Math.min(m, t), nowMs) : nowMs - 11 * 7 * DAY_MS;
  const endMs = Math.min(f.to ? Date.parse(`${f.to}T23:59:59Z`) : nowMs, nowMs);
  const unit = dated && endMs - startMs > 120 * DAY_MS ? "month" : "week";
  const keyOf = (t: number) => (unit === "month" ? isoDay(t + EAT_MS).slice(0, 7) : weekOf(t));
  const keys: string[] = [];
  if (Number.isFinite(startMs) && startMs <= endMs) {
    if (unit === "month") {
      const s = new Date(startMs + EAT_MS);
      for (let at = Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), 1); at <= endMs + EAT_MS;) {
        const d = new Date(at);
        keys.push(isoDay(at).slice(0, 7));
        at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
      }
    } else {
      for (let t = Date.parse(`${weekOf(startMs)}T00:00:00Z`); t <= endMs + EAT_MS; t += 7 * DAY_MS) keys.push(isoDay(t));
    }
  }
  const buckets = new Map(keys.slice(-24).map((k) => [k, agg()]));
  for (const r of rows) {
    const t = ms(r.started_at);
    if (t != null) { const b = buckets.get(keyOf(t)); if (b) add(b, r); }
  }
  const current = keyOf(nowMs);
  const byPeriod = {
    unit,
    points: [...buckets.entries()].map(([label, a]) => ({ label, opens: a.opens, users: a.people.size, totalSeconds: a.seconds, ...(label === current ? { partial: true } : {}) })),
  };

  // Who opens resources.
  const roles = new Map<string, Agg>();
  for (const r of rows) { const k = (r.role as string) || "unknown"; if (!roles.has(k)) roles.set(k, agg()); add(roles.get(k)!, r); }
  const byRole = [...roles.entries()].map(([role, a]) => ({ role, ...figures(a) }))
    .sort((a, b) => b.sessions - a.sessions || b.users - a.users || a.role.localeCompare(b.role));

  const cells = dayBlocks(rows.map((r) => r.started_at), () => true);
  const when = { ...DAY_BLOCKS, cells, total: cells.flat().reduce((t, n) => t + n, 0) };

  // Each resource.
  const itemById = new Map(items.map((i) => [i.id as string, i]));
  const perItem = new Map<string, Agg>();
  for (const r of rows) { const k = r.library_item_id as string; if (!perItem.has(k)) perItem.set(k, agg()); add(perItem.get(k)!, r); }
  const byResource = [...perItem.entries()].map(([id, a]) => {
    const it = itemById.get(id);
    const typical = median(a.durations);
    return {
      itemId: id,
      title: (it?.title as string) ?? "(deleted resource)",
      shelf: it ? shelfOf(it.audience) : "",
      subject: (it?.subject as string) ?? "",
      type: (it?.type as string) ?? "",
      views: a.opens,
      users: a.people.size,
      totalSeconds: a.seconds,
      timedViews: a.timed,
      typicalSeconds: typical,
      quickExits: a.durations.filter((s) => s < QUICK_SECONDS).length,
      lastOpened: a.last == null ? null : new Date(a.last).toISOString(),
    };
  }).sort((a, b) => b.views - a.views || b.totalSeconds - a.totalSeconds || a.title.localeCompare(b.title));

  // Each school, compared — the school filter itself left off, so one school can be seen against the rest.
  const perSchool = new Map<string, Agg>();
  for (const r of compareRows) { const k = (r.school as string) || "(not set)"; if (!perSchool.has(k)) perSchool.set(k, agg()); add(perSchool.get(k)!, r); }
  const bySchool = [...perSchool.entries()].map(([school, a]) => ({ school, ...figures(a), lastOpened: a.last == null ? null : new Date(a.last).toISOString() }))
    .sort((a, b) => b.sessions - a.sessions || b.totalSeconds - a.totalSeconds || a.school.localeCompare(b.school));

  // By topic and sub-topic: as the item was tagged when it was opened (older visits: as it is now).
  type TAgg = { users: Set<string>; sessions: number; seconds: number };
  const tagOf = (r: Row) => (r.topic != null || r.subtopic != null ? r : itemById.get(r.library_item_id as string) ?? {});
  const tAdd = (a: TAgg, r: Row) => { a.users.add(r.actor_id as string); a.sessions++; if (r.duration_seconds != null) a.seconds += Number(r.duration_seconds); };
  const tNew = (): TAgg => ({ users: new Set(), sessions: 0, seconds: 0 });
  const topics = new Map<string, TAgg & { subs: Map<string, TAgg> }>();
  for (const r of rows) {
    const tag = tagOf(r);
    const topic = (tag.topic as string) || "(no topic)", sub = (tag.subtopic as string) || "(no sub-topic)";
    if (!topics.has(topic)) topics.set(topic, { ...tNew(), subs: new Map() });
    const t = topics.get(topic)!;
    tAdd(t, r);
    if (!t.subs.has(sub)) t.subs.set(sub, tNew());
    tAdd(t.subs.get(sub)!, r);
  }
  const tOut = (a: TAgg) => ({ users: a.users.size, sessions: a.sessions, totalSeconds: a.seconds });
  const byTopic = [...topics.entries()]
    .map(([topic, t]) => ({
      topic, ...tOut(t),
      subtopics: [...t.subs.entries()].map(([subtopic, s]) => ({ subtopic, ...tOut(s) })).sort((a, b) => b.totalSeconds - a.totalSeconds || b.sessions - a.sessions),
    }))
    .sort((a, b) => Number(a.topic === "(no topic)") - Number(b.topic === "(no topic)") || b.totalSeconds - a.totalSeconds || b.sessions - a.sessions);

  // ---- what someone could act on
  const published = items.filter((i) => i.published !== false);
  const opened = new Set(rows.map((r) => r.library_item_id));
  const notOpened = published.filter((i) => !opened.has(i.id))
    .sort((a, b) => String(b.uploaded_at ?? "").localeCompare(String(a.uploaded_at ?? "")) || String(a.title).localeCompare(String(b.title)))
    .map((i) => ({ itemId: i.id as string, title: i.title as string, shelf: shelfOf(i.audience), uploadedAt: i.uploaded_at ?? null }));
  const quickExits = byResource
    .filter((r) => r.timedViews >= QUICK_MIN_TIMED && r.typicalSeconds != null && r.typicalSeconds < QUICK_SECONDS)
    .map((r) => ({ itemId: r.itemId, title: r.title, timedViews: r.timedViews, typicalSeconds: r.typicalSeconds }));
  // Schools: only when no single school is chosen (there's nothing to compare inside one).
  let noUse = null, quiet = null;
  if (!f.school) {
    const inPlace = schools.filter((s) => !f.county || s.county === f.county).map((s) => s.name as string);
    const used = new Set(compareRows.map((r) => r.school));
    const none = inPlace.filter((n) => !used.has(n)).sort((a, b) => a.localeCompare(b));
    noUse = { schools: inPlace.length, count: none.length, names: none.slice(0, LIST_CAP) };
    if (!dated) {
      const cut = nowMs - RECENT_DAYS * DAY_MS;
      const lastAt = new Map<string, number>();
      for (const r of placeRows) { const t = ms(r.started_at); if (r.school && t != null && t > (lastAt.get(r.school) ?? 0)) lastAt.set(r.school, t); }
      const went = [...lastAt.entries()].filter(([n, t]) => t < cut && inPlace.includes(n)).sort((a, b) => b[1] - a[1]);
      quiet = { days: RECENT_DAYS, count: went.length, schools: went.slice(0, LIST_CAP).map(([school, t]) => ({ school, lastOpened: new Date(t).toISOString() })) };
    }
  }

  return {
    school: f.school, county: f.county, from: f.from, to: f.to,
    generatedAt: now.toISOString(),
    schools: [...new Set(compareRows.map((r) => r.school).filter(Boolean) as string[])].sort(),
    totals,
    library: { published: published.length, opened: published.filter((i) => opened.has(i.id)).length },
    hpfStaff: { users: new Set(hpfRows.map((r) => r.actor_id)).size, sessions: hpfRows.length },
    recent,
    byPeriod,
    byRole,
    when,
    byResource,
    bySchool,
    byTopic,
    attention: {
      notOpened: { count: notOpened.length, items: notOpened.slice(0, LIST_CAP) },
      quickExits: { seconds: QUICK_SECONDS, minimum: QUICK_MIN_TIMED, count: quickExits.length, items: quickExits.slice(0, LIST_CAP) },
      noUse,
      quiet,
    },
  };
}
