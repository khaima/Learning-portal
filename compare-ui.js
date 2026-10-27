/* ============================================================
   HPF Digital Learning Portal — which subject does best?

   Subjects side by side, from GET /results/compare (or the Learning
   dashboard's own copy of the same figures): the answer first — the
   subject doing best and the one needing most support — then each
   subject's average mark, where its learners are (the achievement bands),
   every subject in every grade, class or school on one grid, and the best
   subject in each of those.

   An average on fewer than `min` marked pieces of work is shown (with an
   asterisk) but never ranked: a few marks say more about those learners
   than about the subject. Used on the teacher's and school head's results
   pages, the programme's Results page and the Learning dashboard.
   ============================================================ */

import { esc, skeleton, errorState, friendlyError } from "./util.js";
import { barList, groupedBars, heatmap, stackRows } from "./charts.js";
import { kpiCard } from "./kpi.js";

const pct = (v) => (v == null ? "—" : `${Math.round(v)}%`);
const plural = (n, w) => `${Number(n).toLocaleString()} ${w}${n === 1 ? "" : "s"}`;
const ROW_WORD = { grade: ["Grade", "grade", "grades"], class: ["Class", "class", "classes"], school: ["School", "school", "schools"] };

/** How a subject moved between its last two terms with enough marked work: "↑ 6 pts on Term 2". */
function termMove(s) {
  const terms = (s.terms || []).filter((t) => t.enough && t.averagePercent != null);
  if (terms.length < 2) return "";
  const [before, now] = terms.slice(-2);
  const d = Math.round(now.averagePercent - before.averagePercent);
  const short = String(before.label || "").replace(/^\d{4} /, "");
  return d === 0 ? `same as ${short}` : `${d > 0 ? "↑" : "↓"}${Math.abs(d)} pts on ${short}`;
}
/** The share of a subject's marked work in its top two bands (meeting expectations or better). */
function meetingShare(s, bands) {
  if (bands.length < 2 || !s.marked) return null;
  const top = bands.slice(0, 2).reduce((t, b) => t + (s.bands?.[b.code] || 0), 0);
  return Math.round((top / s.marked) * 100);
}

/** The comparison, for data shaped like GET /results/compare. `rowsBy`: what the grid's rows are. */
export function compareHtml(d, { rowsBy = d?.rowsBy || "grade", empty = "No marked work yet — subjects are compared once work is marked." } = {}) {
  const subjects = (d?.subjects || []).filter((s) => s.marked);
  if (!subjects.length) return `<div class="empty-state">${esc(empty)}</div>`;
  const bands = d.bands || []; // best first
  const bandName = Object.fromEntries(bands.map((b) => [b.code, b.label]));
  const ranked = subjects.filter((s) => s.enough);
  const few = subjects.filter((s) => !s.enough);
  const [Word, word, words] = ROW_WORD[rowsBy] || ROW_WORD.grade;
  const best = ranked[0];
  const weakest = ranked.length > 1 ? ranked[ranked.length - 1] : null;
  const atLeast = `at least ${d.min} marked pieces of work`;

  // 1. The answer.
  const said = (s) => `${pct(s.averagePercent)} average${s.band ? ` · ${s.band}` : ""} · ${plural(s.marked, "piece")} marked`;
  const answer = best
    ? `<div class="stat-row compare-answer">
        ${kpiCard({ label: "Does best", icon: "star", value: esc(best.label), sub: esc(said(best)) })}
        ${weakest ? kpiCard({ label: "Needs most support", icon: "alert", value: esc(weakest.label), sub: esc(said(weakest)) }) : ""}
        ${weakest ? kpiCard({ label: "Gap between them", icon: "results", value: `${Math.round(best.averagePercent - weakest.averagePercent)} pts`,
          sub: `average marks · ${ranked.length} subjects compared` }) : ""}
      </div>${weakest ? "" : `<p class="chart-note">Only ${esc(best.label)} has enough marked work to compare so far (${esc(atLeast)}).</p>`}`
    : `<p class="compare-none">Not enough marked work yet to say which subject does best — a subject needs ${esc(atLeast)}.</p>`;

  // 2. Average mark by subject, best first — last term beside this one, where at
  //    least one subject has enough marked work in both (a baseline and a follow-up).
  const enoughIn = (s, key) => (s.terms || []).find((t) => t.key === key && t.enough && t.averagePercent != null);
  const termKeys = [...new Set(ranked.flatMap((s) => (s.terms || []).filter((t) => t.enough && t.averagePercent != null).map((t) => t.key)))].sort().slice(-2);
  const termLabel = (key) => String(ranked.flatMap((s) => s.terms || []).find((t) => t.key === key)?.label || key);
  const paired = termKeys.length === 2 && ranked.some((s) => enoughIn(s, termKeys[0]) && enoughIn(s, termKeys[1]));
  const bars = !ranked.length ? ""
    : paired
      ? groupedBars(ranked.map((s) => ({
          label: s.label,
          values: termKeys.map((k) => enoughIn(s, k)?.averagePercent ?? null),
          notes: termKeys.map((k) => { const t = enoughIn(s, k); return t ? `${t.marked} marked` : `Fewer than ${d.min} marked: not compared`; }),
        })), termKeys.map((k) => ({ label: termLabel(k) })), { unit: "%", noun: "average mark", title: "Average mark by subject, term by term", insight: true })
      : barList(ranked.map((s) => ({
          label: s.label, value: s.averagePercent,
          note: [`${s.marked} marked`, termMove(s)].filter(Boolean).join(" · "),
        })), { unit: "%", noun: "average mark", insight: ranked.length >= 3 });
  const fewNote = few.length ? `<p class="chart-note">Too little marked to rank yet: ${esc(few.map((s) => `${s.label} (${s.marked})`).join(", "))}.</p>` : "";

  // 3. Where each subject's learners are: the bands, best first.
  const mix = bands.length ? stackRows(subjects.map((s) => ({
    label: s.label, parts: bands.map((b) => s.bands?.[b.code] || 0),
    figure: meetingShare(s, bands) != null ? `${meetingShare(s, bands)}%` : null,
    figureNote: bands.length >= 2 ? `at ${bands[1].code} or above` : "",
  })), bands.map((b, i) => ({ label: b.label, short: b.code, colour: `var(--band-${i + 1})` })), { noun: "marked", title: "Marked work by band, by subject" }) : "";

  // 4. Every subject in every row: the grid, and the best in each row.
  const rows = (d.rows || []).filter((r) => r.marked);
  const cols = subjects.map((s) => ({ key: s.key, label: s.label, short: s.label.slice(0, 4) }));
  const cell = (row, subject) => (d.cells || []).find((c) => c.row === row && c.subject === subject);
  let grid = "", bestIn = "";
  if (rows.length >= 2 && cols.length) {
    const scale = [...bands].reverse().map((b) => ({ from: b.minPercent, label: `${b.code} ${b.minPercent}%+` }));
    grid = heatmap(rows.map((r) => ({
      label: r.label,
      values: cols.map((c) => {
        const x = cell(r.key, c.key);
        return x?.marked ? { value: x.averagePercent, few: !x.enough, note: `${x.marked} marked${x.band ? ` · ${bandName[x.band] || x.band}` : ""}` } : null;
      }),
    })), cols, {
      corner: Word, caption: `Average mark in each subject, by ${word}`, noun: "average mark", totals: false,
      scale, unit: "%", fewNote: `fewer than ${d.min} marked — not compared`, empty: "No marked work yet.",
    });
    const lines = rows.map((r) => {
      const here = (d.cells || []).filter((c) => c.row === r.key && c.enough && c.averagePercent != null)
        .sort((a, b) => b.averagePercent - a.averagePercent);
      if (!here.length) return "";
      const name = (k) => subjects.find((s) => s.key === k)?.label || k;
      const top = here[0], low = here.length > 1 ? here[here.length - 1] : null;
      return `<li><b>${esc(r.label)}</b><span>Best: ${esc(name(top.subject))} ${pct(top.averagePercent)}${low ? ` · needs support: ${esc(name(low.subject))} ${pct(low.averagePercent)}` : ""}</span></li>`;
    }).filter(Boolean);
    bestIn = lines.length ? `<ul class="compare-best">${lines.join("")}</ul>` : "";
  }

  const part = (title, meta, body, wide = false) => `<div class="compare-part${wide ? " compare-wide" : ""}"><h3 class="chart-subhead">${esc(title)}${meta ? ` <span>${esc(meta)}</span>` : ""}</h3>${body}</div>`;
  return `<div class="compare">
    ${answer}
    <div class="compare-grid">
      ${bars ? part("Average mark by subject", paired ? `${termLabel(termKeys[0])} and ${termLabel(termKeys[1])}, best subject first` : "best first", bars + fewNote) : fewNote}
      ${mix ? part("Where learners are, by subject", "marked work by band", mix) : ""}
      ${grid ? part(`Each subject, by ${word}`, `average mark · ${rows.length} ${words}`, grid + bestIn, true) : ""}
    </div>
    <p class="field-hint">Averages count marked work only. A subject or cell needs ${esc(atLeast)} to be ranked.</p>
  </div>`;
}

/** A comparison that loads itself: `load(rowsBy)` resolves to /results/compare's data; `choices` are the
    rows a viewer can pick ([["grade", "Grade"], ["class", "Class"]]). Returns { refresh }. */
export function mountCompare(el, { load, choices = [["grade", "Grade"], ["class", "Class"]], rowsBy = choices[0][0] }) {
  let current = rowsBy;
  let seq = 0;
  el.innerHTML = `<div class="compare-head"><h3>Which subject does best?</h3>${choices.length > 1 ? `<label class="compare-pick"><span>Compare across</span>
      <select data-compare-rows>${choices.map(([v, l]) => `<option value="${esc(v)}"${v === current ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>` : ""}</div>
    <div data-compare-body>${skeleton(3, { avatar: false })}</div>`;
  const body = el.querySelector("[data-compare-body]");
  async function refresh() {
    const mine = ++seq;
    body.innerHTML = skeleton(3, { avatar: false });
    try {
      const d = await load(current);
      if (mine === seq) body.innerHTML = compareHtml(d, { rowsBy: current });
    } catch (err) {
      if (mine === seq) body.innerHTML = errorState(friendlyError(err), refresh);
    }
  }
  el.querySelector("[data-compare-rows]")?.addEventListener("change", (e) => { current = e.target.value; refresh(); });
  refresh();
  return { refresh };
}
