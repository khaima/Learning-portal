/* ============================================================
   HPF Digital Learning Portal — "Key findings": what the figures say.

   The findings come worked out from the API (insights.ts, docs/INSIGHTS.md):
   each is one sentence from the records, with its reporting period, what it
   rests on and its source. This file only chooses a few and lays them out:

     insightsPanel(ins, opts) — a handful, on an overview or a dashboard
     insightsAll(ins, opts)   — every finding, on the Administration's In detail

   A finding that is a gap links to the page that already deals with it,
   for whoever may open that page; nothing here makes a task or a reminder.
   Text is the API's, escaped here once (form titles and school names are
   typed by people).
   ============================================================ */

import { esc } from "./util.js";

/** What a finding is about: kept apart so taking part is never read as learning. */
export const MEASURE = {
  reach: "Reach", participation: "Taking part", resources: "Resource use", skills: "Skills",
  learning: "Learning outcomes", implementation: "Implementation", reporting: "Reporting", indicator: "Programme indicator",
};
/** How it was worked out. */
export const KIND = {
  target: "Against target", change: "Change", schools: "Across schools", reporting: "Overdue or missing",
  gap: "Gap", baseline: "Baseline to follow-up", evidence: "Evidence",
};
const TONE = { attention: "Needs a look", positive: "Going the right way", neutral: "For information" };
const MARK = { attention: "!", positive: "✓", neutral: "i" };

/** A few findings for one place on the page: the most pressing first, one of
    each kind before a second of any (an "evidence" note only if there's room),
    shown in order of importance. `area`: only this dashboard's. `skip`: kinds
    the page already lists (the Administration overview's Needs attention has the gaps).
    `cards: false`: none that only restate a headline card on the page (its target, its change). */
export function pickInsights(items, { max = 5, area = null, skip = [], cards = true } = {}) {
  const pool = (items || []).filter((i) => (!area || i.area === area) && !skip.includes(i.kind) && (cards || !i.card));
  const out = [];
  const kinds = new Set();
  for (const i of pool) {
    if (out.length >= max) break;
    if (i.kind === "evidence" || kinds.has(i.kind)) continue;
    out.push(i);
    kinds.add(i.kind);
  }
  for (const i of pool) {
    if (out.length >= max) break;
    if (!out.includes(i)) out.push(i);
  }
  return out.sort((a, b) => a.rank - b.rank);
}

/** The first of a finding's links this person may open, as a button (an M&E indicator opens on the M&E page). */
function linkHtml(i, { canOpen = () => true, via = "" } = {}) {
  const l = (i.links || []).find((x) => canOpen(x.page));
  if (!l) return "";
  const sr = `<span class="sr-only">: ${esc(i.text)}</span>`;
  if (l.indicator) return `<button type="button" class="btn btn-outline q-small" data-mel-dash-ind="${esc(l.indicator)}">${esc(l.label)}${sr}</button>`;
  const qs = new URLSearchParams(Object.entries({ ...(l.params || {}), via }).filter(([, v]) => v)).toString();
  return `<a class="btn btn-outline q-small" href="#${esc(l.page)}${qs ? `?${esc(qs)}` : ""}">${esc(l.label)}${sr}</a>`;
}

export function insightHtml(i, opts = {}) {
  const tone = TONE[i.tone] ? i.tone : "neutral";
  const meta = [i.period, i.base, i.source ? `Source: ${i.source}` : ""].filter(Boolean).map(esc).join(" · ");
  return `<li class="insight" data-tone="${tone}" data-key="${esc(i.key)}">
    <span class="insight-mark" aria-hidden="true">${MARK[tone]}</span>
    <div class="insight-body">
      <p class="insight-tags"><span class="sr-only">${TONE[tone]}: </span>${esc(MEASURE[i.measure] || "")}<span aria-hidden="true"> · </span><span class="sr-only">, </span>${esc(KIND[i.kind] || "")}</p>
      <p class="insight-text">${esc(i.text)}</p>
      <p class="insight-meta">${meta}${i.note ? `<br>${esc(i.note)}` : ""}</p>
    </div>
    ${linkHtml(i, opts)}
  </li>`;
}

const FOOT = "Worked out from the records named under each finding. None says what caused a change.";

/** The panel: a heading, a few findings and where they come from. With nothing
    to show, a dashboard's panel is nothing at all (`quiet`); an overview's says so. */
export function insightsPanel(ins, { title = "Key findings", level = 2, max = 5, area = null, skip = [], cards = true, canOpen, via = "", more = "", quiet = false, id = "" } = {}) {
  if (!ins || ins.error) {
    return quiet ? "" : `<section class="insights-panel"><div class="attn-head"><h${level}>${esc(title)}</h${level}></div>
      <p class="chart-few">The findings couldn't be worked out just now${ins?.error ? ` (${esc(ins.error)})` : ""}. The figures above are unaffected.</p></section>`;
  }
  const list = pickInsights(ins.items, { max, area, skip, cards });
  if (!list.length && quiet) return "";
  const head = `<div class="attn-head ao-head"><h${level}${id ? ` id="${esc(id)}"` : ""}>${esc(title)}</h${level}>${ins.period
    ? `<span class="chart-meta" style="margin:0">${esc(ins.period)}${ins.against ? ` · against ${esc(ins.against)}` : ""}</span>` : ""}</div>`;
  return `<section class="insights-panel"${id ? ` aria-labelledby="${esc(id)}"` : ""}>${head}
    ${list.length ? `<ul class="insights">${list.map((i) => insightHtml(i, { canOpen, via })).join("")}</ul>`
      : `<p class="chart-few">Nothing stands out in the records for ${esc(ins.period || "this term")} yet.</p>`}
    <p class="field-hint insight-foot">${FOOT}${more ? ` <a href="${esc(more)}">Every finding →</a>` : ""}</p>
  </section>`;
}

/** Every finding, grouped by what it's about, in order of importance within each. */
export function insightsAll(ins, { title = "Every finding", level = 3, canOpen, via = "", id = "" } = {}) {
  if (!ins || ins.error) return insightsPanel(ins, { title, level });
  const items = ins.items || [];
  const groups = Object.keys(MEASURE).map((m) => [m, items.filter((i) => i.measure === m)]).filter(([, l]) => l.length);
  return `<section class="insights-panel insights-all"${id ? ` aria-labelledby="${esc(id)}"` : ""}>
    <div class="attn-head ao-head"><h${level}${id ? ` id="${esc(id)}"` : ""}>${esc(title)}</h${level}>${items.length ? `<span class="count-badge">${items.length}</span>` : ""}</div>
    <p class="chart-meta">${esc(ins.period || "")}${ins.against ? ` · changes against ${esc(ins.against)}` : ""}. Reach, taking part, resource use, skills and learning outcomes are kept apart.</p>
    ${groups.length ? groups.map(([m, l]) => `<h${level + 1} class="insights-group">${esc(MEASURE[m])}</h${level + 1}>
      <ul class="insights">${l.map((i) => insightHtml(i, { canOpen, via })).join("")}</ul>`).join("")
      : `<p class="chart-few">Nothing stands out in the records for ${esc(ins.period || "this term")} yet.</p>`}
    <p class="field-hint insight-foot">${FOOT}</p>
  </section>`;
}
