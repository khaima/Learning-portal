/**
 * The Content usage report: figures, trends, who and when, and what needs attention.
 *
 *   cd supabase/functions/api
 *   deno test --allow-env --allow-read --config deno.json library_usage_test.ts
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { buildLibraryUsage, QUICK_MIN_TIMED, type UsageFilter } from "./library_usage.ts";
import { call, freshWorld } from "./test_world.ts";

const NOW = new Date("2026-10-26T09:00:00Z"); // a Monday, 12:00 in Kenya
const daysAgo = (n: number, hour = 9) => new Date(NOW.getTime() - n * 864e5 + (hour - 9) * 3600e3).toISOString();
const NONE: UsageFilter = { school: null, county: null, from: null, to: null };
const SCHOOLS = [
  { name: "Aitong Primary", county: "Narok" },
  { name: "Ilkerin Primary", county: "Narok" },
  { name: "Nyeri Hill Primary", county: "Nyeri" },
  { name: "Chaka Primary", county: "Nyeri" },
];
const ITEMS = [
  { id: "lib_a", title: "Fractions", audience: "library", published: true, subject: "Mathematics", type: "Video", topic: "Numbers", uploaded_at: "2026-09-01" },
  { id: "lib_b", title: "Marking guide", audience: "staff", published: true, subject: "Mathematics", type: "Reading", uploaded_at: "2026-09-02" },
  { id: "lib_c", title: "Shapes", audience: "library", published: true, subject: "Mathematics", type: "Reading", uploaded_at: "2026-10-20" },
  { id: "lib_d", title: "Draft notes", audience: "library", published: false, subject: "English", type: "Reading", uploaded_at: "2026-10-21" },
];
let n = 0;
const open = (item: string, who: string, school: string, when: string, seconds: number | null, kind = "learner", role = "learner") =>
  ({ id: `li_${++n}`, library_item_id: item, actor_id: who, actor_kind: kind, role, school, started_at: when, duration_seconds: seconds });

function world() {
  n = 0;
  return [
    open("lib_a", "l1", "Aitong Primary", daysAgo(2, 9), 300),
    open("lib_a", "l2", "Aitong Primary", daysAgo(3, 14), 240),
    open("lib_a", "t1", "Nyeri Hill Primary", daysAgo(10, 10), 600, "staff", "teacher"),
    // Five quick looks at the marking guide: under 30 seconds each, typically.
    ...[5, 6, 7, 8, 9].map((d, i) => open("lib_b", `t${i + 1}`, "Nyeri Hill Primary", daysAgo(d), i === 4 ? 200 : 10, "staff", "teacher")),
    // Ilkerin used it, but not for six weeks: gone quiet.
    open("lib_a", "l3", "Ilkerin Primary", daysAgo(45), 120),
    open("lib_a", "l3", "Ilkerin Primary", daysAgo(50), null), // never came back: untimed
  ];
}

Deno.test("key figures: people, opens, time, learners and staff, the typical open", () => {
  const u = buildLibraryUsage({ items: ITEMS, interactions: world(), schools: SCHOOLS, now: NOW }, NONE);
  assertEquals(u.totals.sessions, 10);
  assertEquals(u.totals.completedSessions, 9, "the untimed open isn't timed");
  assertEquals(u.totals.totalSeconds, 300 + 240 + 600 + 4 * 10 + 200 + 120);
  assertEquals([u.totals.users, u.totals.learners, u.totals.staff], [8, 3, 5]);
  assertEquals(u.totals.typicalSeconds, 120, "the median timed open");
  assertEquals(u.library, { published: 3, opened: 2 }, "a draft isn't counted");
});

Deno.test("the last 30 days beside the 30 before — only when no dates are chosen", () => {
  const u = buildLibraryUsage({ items: ITEMS, interactions: world(), schools: SCHOOLS, now: NOW }, NONE);
  assertEquals(u.recent!.last.sessions, 8);
  assertEquals(u.recent!.before.sessions, 2);
  assertEquals(u.recent!.before.users, 1);
  const dated = buildLibraryUsage({ items: ITEMS, interactions: world(), schools: SCHOOLS, now: NOW }, { ...NONE, from: "2026-10-01", to: "2026-10-31" });
  assertEquals(dated.recent, null, "a chosen period may still be running: no comparison");
  assertEquals(dated.totals.sessions, 8, "the dates narrow everything");
});

Deno.test("over time: 12 weeks by Monday in Kenyan time, the current week marked as so far", () => {
  const u = buildLibraryUsage({ items: ITEMS, interactions: world(), schools: SCHOOLS, now: NOW }, NONE);
  assertEquals(u.byPeriod.unit, "week");
  assertEquals(u.byPeriod.points.length, 12);
  const last = u.byPeriod.points.at(-1)!;
  assertEquals(last.label, "2026-10-26");
  assertEquals(last.partial, true);
  assertEquals(u.byPeriod.points.reduce((t, p) => t + p.opens, 0), 10, "every open falls in a week shown");
  // Sunday 22:00 UTC is already Monday in Kenya.
  const late = buildLibraryUsage({ items: ITEMS, interactions: [open("lib_a", "x", "Aitong Primary", "2026-10-25T22:00:00Z", 60)], schools: SCHOOLS, now: NOW }, NONE);
  assertEquals(late.byPeriod.points.at(-1)!.opens, 1);
  // A long chosen range goes by month.
  const year = buildLibraryUsage({ items: ITEMS, interactions: world(), schools: SCHOOLS, now: NOW }, { ...NONE, from: "2026-01-01", to: "2026-12-31" });
  assertEquals(year.byPeriod.unit, "month");
  assertEquals(year.byPeriod.points.map((p) => p.label).slice(-2), ["2026-09", "2026-10"], "months after today aren't drawn");
});

Deno.test("who and when: roles by opens, and the day × time grid", () => {
  const u = buildLibraryUsage({ items: ITEMS, interactions: world(), schools: SCHOOLS, now: NOW }, NONE);
  assertEquals(u.byRole.map((r) => [r.role, r.sessions, r.users]), [["teacher", 6, 5], ["learner", 4, 3]]);
  assertEquals(u.when.total, 10);
  assertEquals(u.when.days.length, 7);
  // 09:00 UTC is 12:00 in Kenya: 2 and 9 days ago were Saturdays → Saturday, the 12–15 block.
  assertEquals(u.when.cells[5][4], 2);
});

Deno.test("each resource: opens, people, time, the typical open and quick exits", () => {
  const u = buildLibraryUsage({ items: ITEMS, interactions: world(), schools: SCHOOLS, now: NOW }, NONE);
  const a = u.byResource.find((r) => r.itemId === "lib_a")!;
  assertEquals([a.views, a.users, a.totalSeconds, a.timedViews], [5, 4, 1260, 4]);
  assertEquals(a.shelf, "Digital Library");
  assertEquals(a.lastOpened, daysAgo(2, 9));
  const b = u.byResource.find((r) => r.itemId === "lib_b")!;
  assertEquals([b.typicalSeconds, b.quickExits, b.shelf], [10, 4, "Teacher Resources"]);
  assertEquals(u.byResource[0].itemId, "lib_a", "most opened first");
});

Deno.test("needs attention: not opened, quick exits, schools that never or no longer use it", () => {
  const u = buildLibraryUsage({ items: ITEMS, interactions: world(), schools: SCHOOLS, now: NOW }, NONE);
  assertEquals(u.attention.notOpened.items.map((i) => i.title), ["Shapes"], "published and never opened; not the draft");
  assertEquals(u.attention.quickExits.items.map((i) => i.title), ["Marking guide"]);
  assertEquals(u.attention.noUse!.names, ["Chaka Primary"], "a school with no opens at all");
  assertEquals(u.attention.noUse!.schools, 4);
  assertEquals(u.attention.quiet!.schools.map((s) => s.school), ["Ilkerin Primary"], "last opened 45 days ago");
  // Fewer timed opens than the minimum: not judged.
  const few = buildLibraryUsage({ items: ITEMS, interactions: world().filter((r) => r.library_item_id !== "lib_b" || r.started_at > daysAgo(7)), schools: SCHOOLS, now: NOW }, NONE);
  assert(few.byResource.find((r) => r.itemId === "lib_b")!.timedViews < QUICK_MIN_TIMED);
  assertEquals(few.attention.quickExits.count, 0);
});

Deno.test("a county narrows everything; a school narrows the figures but schools are still compared", () => {
  const narok = buildLibraryUsage({ items: ITEMS, interactions: world(), schools: SCHOOLS, now: NOW }, { ...NONE, county: "Narok" });
  assertEquals(narok.totals.sessions, 4);
  assertEquals(narok.bySchool.map((s) => s.school), ["Aitong Primary", "Ilkerin Primary"]);
  assertEquals(narok.attention.noUse!.schools, 2);
  assertEquals(narok.attention.noUse!.count, 0);
  const one = buildLibraryUsage({ items: ITEMS, interactions: world(), schools: SCHOOLS, now: NOW }, { ...NONE, school: "Aitong Primary" });
  assertEquals(one.totals.sessions, 2);
  assertEquals(one.bySchool.length, 3, "every school that used it, to see this one against");
  assertEquals([one.attention.noUse, one.attention.quiet], [null, null], "nothing to compare inside one school");
  assertEquals(one.attention.notOpened.items.map((i) => i.title), ["Shapes", "Marking guide"], "not opened at this school, newest upload first");
});

Deno.test("GET /library/usage: the route answers with the report, filters applied", async () => {
  const db = freshWorld();
  const EDU = "tok_education_team";
  const made = await call("POST", "/library", EDU, { title: "Fractions", subject: "Mathematics", type: "Video", audience: "library", topic: "Numbers" });
  await call("PATCH", `/library/${made.json.item.id}`, EDU, { published: true });
  const r = await call("POST", `/library/${made.json.item.id}/interactions`, "hpl_learnertoken");
  assertEquals(r.status, 200, JSON.stringify(r.json));
  db.library_interactions.find((x) => x.id === r.json.interaction.id)!.duration_seconds = 90;
  const u = await call("GET", "/library/usage", EDU);
  assertEquals(u.status, 200, JSON.stringify(u.json));
  assert(u.json.totals.sessions >= 1);
  assert(u.json.byResource.some((x: { title: string; totalSeconds: number }) => x.title === "Fractions" && x.totalSeconds === 90));
  assert(Array.isArray(u.json.byPeriod.points) && u.json.byPeriod.points.length === 12);
  assert(u.json.attention && "notOpened" in u.json.attention);
  const bad = await call("GET", "/library/usage?from=yesterday", EDU);
  assertEquals(bad.status, 200, "a date that isn't one is ignored");
  assertEquals(bad.json.from, null);
  const learner = await call("GET", "/library/usage", "hpl_learnertoken");
  assertEquals(learner.status, 403, "learners don't see the report");
});

Deno.test("HPF staff opening resources aren't programme use: left out of every figure, reported apart", () => {
  const rows = [...world(),
    open("lib_c", "edu1", "", daysAgo(1), 40, "staff", "education_team"),
    open("lib_c", "adm1", "", daysAgo(2), 20, "staff", "super_admin"),
  ];
  const u = buildLibraryUsage({ items: ITEMS, interactions: rows, schools: SCHOOLS, now: NOW }, NONE);
  assertEquals(u.totals.sessions, 10, "as without them");
  assertEquals(u.hpfStaff, { users: 2, sessions: 2 });
  assertEquals(u.byRole.map((r) => r.role), ["teacher", "learner"], "no HPF roles among programme users");
  assertEquals(u.attention.notOpened.items.map((i) => i.title), ["Shapes"], "opened only by HPF staff: still not opened by the programme");
  const one = buildLibraryUsage({ items: ITEMS, interactions: rows, schools: SCHOOLS, now: NOW }, { ...NONE, school: "Aitong Primary" });
  assertEquals(one.hpfStaff.sessions, 0, "they aren't based at a school");
});
