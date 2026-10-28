/* ============================================================
   HPF Digital Learning Portal — the key-figure card.

   One card for every key figure in the portal, so they read the same
   everywhere (docs/CHARTS.md, "Key figures"):

     title                 what is counted, in plain words (no icon:
                           the words say it; docs/DESIGN-SYSTEM.md)
     the value             big
     a change              only where the data has an earlier period to
                           compare with — never estimated
     context               what the number means: "8 this week",
                           "3 need review", "of 105 set"

   A card that opens a page is a link and shows it: an arrow beside the
   title, and its border darkens when pointed at. A card that doesn't,
   doesn't.
   ============================================================ */

import { esc } from "./util.js";
import { ICON } from "./navigation.js";

/** A key figure.
      label    the title (plain text)
      value    the figure (HTML: callers format it)
      unit     a small word after it ("hrs")
      icon     accepted and ignored: key figures carry no decorative icon
      trend    a change against an earlier period — trendTag() — or ""
      sub      context (HTML)
      tone     "warn" when the figure itself is something waiting on someone
               (work to mark, forms to finish) — not when only its context is
      href     the page it opens; with it the card is a link
      attrs    extra attributes for the link (e.g. data-open-sync-center) */
export function kpiCard({ label, value, unit = "", icon = "", trend = "", sub = "", tone = "", href = "", attrs = "", spark = "", meter = "" }) {
  const cls = `stat-tile${href ? " stat-link" : ""}${tone ? ` intel-${tone}` : ""}`;
  // What the figure is about, as a small picture beside its name (decoration: the name says it).
  const pic = icon && ICON[icon] ? `<span class="s-ico" aria-hidden="true"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${ICON[icon]}</svg></span>` : "";
  const body = `
    <div class="s-label">${pic}<span class="s-title">${esc(label)}</span>${href ? `<span class="s-go" aria-hidden="true">→</span>` : ""}</div>
    <div class="s-num">${value}${unit ? `<small class="s-unit"> ${esc(unit)}</small>` : ""}</div>
    ${spark ? `<div class="s-spark">${spark}</div>` : ""}${meter}
    ${trend ? `<div class="s-trend">${trend}</div>` : ""}
    ${sub ? `<div class="s-sub">${sub}</div>` : ""}`;
  return href
    ? `<a class="${cls}" href="${esc(href)}"${attrs ? ` ${attrs}` : ""}>${body}</a>`
    : `<div class="${cls}">${body}</div>`;
}

/** A change, with its direction in words for screen readers: "▲ +4.9 pts on Term 2".
      better  "up" or "down" — which way is good (colours it)
      what    what it's compared with ("on Term 2", "since the last scan") */
export function trendTag(diff, { unit = "", better = "up", what = "" } = {}) {
  if (diff == null || Number.isNaN(diff)) return "";
  const r = Math.round(diff * 10) / 10;
  if (!r) return `<span class="trend flat">No change${what ? ` ${esc(what)}` : ""}</span>`;
  const good = better === "up" ? r > 0 : r < 0;
  return `<span class="trend ${good ? "good" : "bad"}"><span class="trend-delta"><span aria-hidden="true">${r > 0 ? "▲" : "▼"}</span>`
    + `<span class="sr-only">${r > 0 ? "Up" : "Down"} </span> ${r > 0 ? "+" : "−"}${Math.abs(r)}${esc(unit)}</span>${what ? ` <span class="trend-what">${esc(what)}</span>` : ""}</span>`;
}

/** "2026 Term 3" → "Term 3" (the year only when it isn't this one). */
export const termName = (label) => {
  const m = /^(\d{4}) Term (\d)$/.exec(String(label));
  return m ? (Number(m[1]) === new Date().getFullYear() ? `Term ${m[2]}` : `Term ${m[2]} ${m[1]}`) : String(label);
};

/** The latest period against the one before, from a series that has them
    ([{ label, … }], oldest first): "Term 3: 58% · ▲ +4.9 pts on Term 2".
    Nothing when there aren't two periods with a value — no comparison is
    better than an invented one. For rates and averages, not counts: a term
    still under way has fewer of everything. */
export function periodTrend(series, pick, { format = (v) => `${Math.round(v)}%`, unit = " pts", better = "up" } = {}) {
  const known = (series || []).filter((p) => pick(p) != null);
  if (known.length < 2) return "";
  const [prev, last] = known.slice(-2);
  return `${esc(termName(last.label))}: ${format(pick(last))} · ${trendTag(pick(last) - pick(prev), { unit, better, what: `on ${termName(prev.label)}` })}`;
}
