/* ============================================================
   HPF Digital Learning Portal — tables that sort.

   A table marked data-sortable (the table helpers mark any with more than
   three rows) sorts by a column when its heading is pressed: once for
   ascending, again for descending. The heading says which way it is
   sorted (aria-sort), and a table that is drawn again — a filter changed,
   the data refreshed — keeps the sort its reader chose.

   A cell's data-sort, when there is one, is what it sorts by; otherwise
   its text, read as a number, a duration ("3h 20m"), a date or words.
   ============================================================ */

const chosen = new Map(); // table → { col, dir } by its page and headings
const keyOf = (t) => `${location.hash.split("?")[0]}|${[...(t.tHead?.rows[0]?.cells || [])].map((c) => c.textContent.trim()).join("|")}`;

function valueOf(cell) {
  const raw = (cell?.dataset.sort ?? cell?.textContent ?? "").trim();
  if (!raw || raw === "—") return null;
  const dur = /^(?:(\d+)h)?\s*(?:(\d+)m)?$/.exec(raw);
  if (dur && (dur[1] || dur[2])) return Number(dur[1] || 0) * 60 + Number(dur[2] || 0);
  if (/[a-z]/i.test(raw) && /\b\d{4}\b/.test(raw) && raw.length < 24) {
    const t = Date.parse(raw);
    if (!Number.isNaN(t)) return t;
  }
  const n = /^-?\d[\d,]*(\.\d+)?/.exec(raw);
  if (n) return Number(n[0].replace(/,/g, ""));
  return raw.toLowerCase();
}
const compare = (a, b) => {
  if (a == null || b == null) return (a == null) - (b == null); // nothing recorded: last either way
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
};

function sortTable(t, col, dir) {
  const body = t.tBodies[0];
  if (!body) return;
  const rows = [...body.rows];
  const sorted = rows.map((r, i) => ({ r, i, v: valueOf(r.cells[col]) }))
    .sort((x, y) => (x.v == null || y.v == null ? compare(x.v, y.v) : compare(x.v, y.v) * dir) || x.i - y.i)
    .map((x) => x.r);
  if (sorted.some((r, i) => r !== rows[i])) body.append(...sorted);
  [...t.tHead.rows[0].cells].forEach((c, i) => {
    if (i === col) c.setAttribute("aria-sort", dir > 0 ? "ascending" : "descending");
    else c.removeAttribute("aria-sort");
  });
}

/** Headings become buttons; a sort chosen earlier is put back. */
function enhance(t) {
  if (!t.tHead?.rows[0] || !t.tBodies[0]) return;
  for (const th of t.tHead.rows[0].cells) {
    if (th.querySelector(".th-sort") || !th.textContent.trim()) continue;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "th-sort";
    b.append(...th.childNodes);
    const arrow = document.createElement("span");
    arrow.className = "th-arrow";
    arrow.setAttribute("aria-hidden", "true");
    b.append(arrow);
    th.append(b);
  }
  const was = chosen.get(keyOf(t));
  if (was) sortTable(t, was.col, was.dir);
}

let busy = false;
export function enableSortableTables(root = document.body) {
  root.querySelectorAll("table[data-sortable]").forEach(enhance);
  root.addEventListener("click", (e) => {
    const b = e.target instanceof Element ? e.target.closest(".th-sort") : null;
    if (!b) return;
    const th = b.closest("th"), t = th.closest("table");
    const col = [...th.parentElement.cells].indexOf(th);
    const dir = th.getAttribute("aria-sort") === "ascending" ? -1 : 1;
    chosen.set(keyOf(t), { col, dir });
    busy = true;
    sortTable(t, col, dir);
    busy = false;
  });
  // Tables drawn again keep their reader's sort.
  new MutationObserver(() => {
    if (busy) return;
    busy = true;
    root.querySelectorAll("table[data-sortable]").forEach(enhance);
    busy = false;
  }).observe(root, { childList: true, subtree: true });
}
