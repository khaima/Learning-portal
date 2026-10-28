// "Key findings" (insights-ui.js): which few are shown, and how. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";

// util.js listens on the page when it loads: a stand-in page is enough here.
globalThis.document = { addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, createElement() { return {}; } };
globalThis.window = globalThis;
const { insightHtml, insightsAll, insightsPanel, pickInsights } = await import("../insights-ui.js");

const item = (key, kind, rank, o = {}) => ({
  key, kind, rank, measure: "participation", area: "learning", tone: "neutral", text: `Finding ${key}.`,
  period: "2026 Term 3 so far", base: "12 schools", source: "the portal's records", note: "", links: [], ...o,
});
const ITEMS = [
  item("t1", "target", 100), item("t2", "target", 110), item("t3", "target", 120),
  item("r1", "reporting", 105, { area: "field" }), item("g1", "gap", 230, { area: "field" }),
  item("c1", "change", 150), item("e1", "evidence", 400),
];

test("findings: one of each kind first, then the most pressing — in order of importance", () => {
  const keys = pickInsights(ITEMS, { max: 4 }).map((i) => i.key);
  assert.deepEqual(keys, ["t1", "r1", "c1", "g1"], "a second target waits until each kind has had a turn");
  assert.deepEqual(pickInsights(ITEMS, { max: 6 }).map((i) => i.key), ["t1", "r1", "t2", "t3", "c1", "g1"]);
  assert.ok(pickInsights(ITEMS, { max: 7 }).some((i) => i.key === "e1"), "an evidence note only when there's room");
});

test("findings: a dashboard's own, and none the page already lists", () => {
  assert.deepEqual(pickInsights(ITEMS, { area: "field" }).map((i) => i.key), ["r1", "g1"]);
  assert.equal(pickInsights(ITEMS, { skip: ["gap"], max: 10 }).some((i) => i.kind === "gap"), false);
  const withCard = [...ITEMS, item("k1", "change", 90, { card: true })];
  assert.equal(pickInsights(withCard, { max: 10 })[0].key, "k1");
  assert.equal(pickInsights(withCard, { max: 10, cards: false }).some((i) => i.card), false, "what a card above already says");
});

test("findings: text people typed is escaped, and the period, base and source are shown", () => {
  const html = insightHtml(item("x", "reporting", 1, { text: "1 of 2 schools hasn't sent “<img src=x onerror=alert(1)>”.", base: "Not sent: <b>Aitong</b>" }));
  assert.ok(!html.includes("<img"), "no markup from a form title");
  assert.ok(html.includes("&lt;img") && html.includes("&lt;b&gt;Aitong"));
  assert.match(html, /2026 Term 3 so far · Not sent: &lt;b&gt;Aitong&lt;\/b&gt; · Source: the portal&#39;s records|Source: the portal/);
  assert.match(html, /Taking part/);
});

test("findings: a link only to a page this person may open — an indicator opens on the M&E page", () => {
  const f = item("x", "gap", 1, { links: [{ page: "field-visits", label: "Field visits" }, { page: "field-operations", label: "Field operations" }] });
  assert.match(insightHtml(f, { canOpen: () => true, via: "overview" }), /href="#field-visits\?via=overview"/);
  assert.match(insightHtml(f, { canOpen: (p) => p === "field-operations" }), /href="#field-operations"/, "the next page it may open");
  assert.ok(!insightHtml(f, { canOpen: () => false }).includes("btn"), "no page it may open: no link");
  const ind = item("y", "target", 1, { links: [{ page: "me-dashboard", label: "Indicator", indicator: "i1" }] });
  assert.match(insightHtml(ind), /data-mel-dash-ind="i1"/);
});

test("findings: a dashboard with none shows nothing; an overview says so; an error never hides the figures", () => {
  assert.equal(insightsPanel({ period: "2026 Term 3 so far", items: [] }, { quiet: true }), "");
  assert.match(insightsPanel({ period: "2026 Term 3 so far", items: [] }), /Nothing stands out in the records for 2026 Term 3 so far yet/);
  assert.match(insightsPanel({ error: "boom" }), /couldn't be worked out just now \(boom\)\. The figures above are unaffected/);
  assert.equal(insightsPanel({ error: "boom" }, { quiet: true }), "");
  const all = insightsAll({ period: "2026 Term 3 so far", against: "the same point of 2026 Term 2", items: ITEMS });
  assert.match(all, /<span class="count-badge">7<\/span>/);
  assert.match(all, /None says what caused a change/);
});

test("findings: the Education Team's side — learning, teachers, resources and the forms they send", () => {
  const items = [item("l", "gap", 1, { area: "learning" }), item("t", "gap", 2, { area: "teachers" }), item("r", "gap", 3, { area: "resources" }),
    item("reporting:form:f1", "reporting", 4, { area: "field" }), item("gap:not-visited", "gap", 5, { area: "field" }), item("m", "reporting", 6, { area: "me" })];
  assert.deepEqual(pickInsights(items, { area: "education", max: 10 }).map((i) => i.key).sort(), ["l", "r", "reporting:form:f1", "t"]);
});
