/* ============================================================
   HPF Digital Learning Portal — tables on every screen.

   Sorting. A table marked data-sortable (the table helpers mark any with
   more than three rows) sorts by a column when its heading is pressed:
   once for ascending, again for descending. The heading says which way
   it is sorted (aria-sort), and a table that is drawn again — a filter
   changed, the data refreshed — keeps the sort its reader chose. A cell's
   data-sort, when there is one, is what it sorts by; otherwise its text,
   read as a number, a duration ("3h 20m"), a date or words.

   Phones. Every table's cells carry their column's name (data-label), so
   on a narrow screen a row reads as a card — "County  Narok" — instead of
   a strip that has to be scrolled sideways (app.css). The headings are
   off-screen there, so a sortable table gets a "Sort by" list instead.
   A long table, or a list marked data-clamp, shows its first rows and a
   "Show all" button; nothing is left out of a search or a sort.

   Finding and paging. A table marked data-find gets a search box above it
   and, past 25 rows, pages ("Rows 26–50 of 80", Previous, Next): the search
   covers every row, and a sort reorders all of them before the page is
   cut. Exporting. A table marked data-export="name" gets "Download CSV":
   the rows the search leaves, every page of them, as plain text. The page
   that draws the table decides who may export (reports.export); the
   figures are the ones already on screen. Search and page survive a
   redraw, like the sort.
   ============================================================ */

const chosen = new Map(); // table → { col, dir } by its page and headings
const keyOf = (t) => `${location.hash.split("?")[0]}|${[...(t.tHead?.rows[0]?.cells || [])].map((c) => c.textContent.trim()).join("|")}`;
const LONG = 15; // rows a phone shows before "Show all"
const PAGE = 25; // rows a page of a findable table shows
const found = new Map(); // table → { q, page } by its page and headings, like `chosen`
const toolsOf = new WeakMap(); // table → its search box, status line and pager

/** Does a row's text hold every word of the search? */
export function matches(text, query) {
  const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  const t = String(text || "").toLowerCase();
  return words.every((w) => t.includes(w));
}
/** Rows of plain values as CSV: quoted where needed, and a value a
    spreadsheet would run as a formula (=, +, -, @) kept as text. */
export function csvOf(rows) {
  const safe = (v) => {
    let x = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(x) && !/^-?\d/.test(x)) x = `'${x}`;
    return /[",\n\r]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x;
  };
  return rows.map((r) => r.map(safe).join(",")).join("\r\n");
}
/** A cell's words as a reader sees them: no screen-reader-only extras ("…: show only this county"). */
function cellText(cell) {
  const c = cell.cloneNode(true);
  c.querySelectorAll(".sr-only, .th-arrow").forEach((x) => x.remove());
  return c.textContent.replace(/\s+/g, " ").trim();
}

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

/** The heading cell over each column, row by row (a group heading spans its columns). */
function headGrid(t) {
  const grid = [];
  [...(t.tHead?.rows || [])].forEach((tr, r) => {
    grid[r] ??= [];
    let c = 0;
    for (const cell of tr.cells) {
      while (grid[r][c]) c++;
      for (let i = 0; i < cell.colSpan; i++) for (let j = 0; j < cell.rowSpan; j++) (grid[r + j] ??= [])[c + i] = cell;
      c += cell.colSpan;
    }
  });
  return grid;
}

/** Each column's name, reading every heading row: "Completion · Rate". */
function columnLabels(t) {
  const grid = headGrid(t);
  const n = Math.max(0, ...grid.map((g) => g.length));
  return Array.from({ length: n }, (_, c) => {
    const parts = [];
    for (const g of grid) if (g[c] && !parts.includes(g[c])) parts.push(g[c]);
    // A group heading ("Completion — work handed in") is named by its first words.
    return parts.map((x) => (x.colSpan > 1 ? x.textContent.split(" — ")[0] : x.textContent).trim()).filter(Boolean).join(" · ");
  });
}

/** A row's cells by column, counting a cell that spans several. */
function byColumn(tr) {
  const cols = [];
  let c = 0;
  for (const td of tr.cells) { if (td.colSpan === 1) cols[c] = td; c += td.colSpan; }
  return cols;
}
/* A value is a number when it's only figures and units: 42, 1,204, 85%, +3 pts, 8 of 10, 3h 20m. */
const isNumber = (v) => /\d/.test(v) && !v.replace(/(\d)\s*(pts?|hrs?|mins?|h|m)\b/gi, "$1").replace(/\bof\b/g, "").replace(/[\d\s.,%+\-−–·()/:]/g, "");
const PLAIN_PCT = /^(\d+(?:\.\d+)?)%$/;
/** Columns of numbers line up on the right, so they compare at a glance; words read from the left,
    and a column of long entries (a list of classes) wraps rather than pushing the table off the page. */
function alignColumns(t) {
  const rows = [...t.tBodies[0].rows].map(byColumn);
  const n = Math.max(0, ...rows.map((r) => r.length));
  const head = headGrid(t);
  const foot = [...(t.tFoot?.rows || [])].map(byColumn);
  for (let c = 0; c < n; c++) {
    const vals = rows.map((r) => r[c]?.textContent.trim()).filter((v) => v && v !== "—");
    const numeric = vals.length > 0 && vals.filter(isNumber).length >= vals.length * 0.7;
    for (const cell of [...rows.map((r) => r[c]), ...foot.map((r) => r[c]), ...head.map((g) => g[c])]) {
      if (cell && cell.colSpan === 1 && cell.classList.contains("num") !== numeric) cell.classList.toggle("num", numeric);
    }
    const long = !numeric && vals.some((v) => v.length > 40);
    for (const r of rows) if (r[c] && r[c].classList.contains("wrap") !== long) r[c].classList.toggle("wrap", long);
    // A column of rates ("71%"): each with a short bar, so they compare at a glance (the number stays what it sorts by).
    if (numeric && vals.length >= 2 && vals.every((v) => PLAIN_PCT.test(v))) {
      for (const r of rows) {
        const cell = r[c];
        const v = cell?.children.length ? null : PLAIN_PCT.exec(cell?.textContent.trim() || "");
        if (v) cell.innerHTML = `<span class="cell-rate">${v[0]}<i style="--w:${Math.min(100, Number(v[1])).toFixed(0)}%" aria-hidden="true"></i></span>`;
      }
    }
  }
}

/** The wrap a table sits in (or the table): where "Sort by" and "Show all" go. */
const shellOf = (t) => (t.parentElement?.classList.contains("lms-table-wrap") ? t.parentElement : t);

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
  const pick = shellOf(t).previousElementSibling?.querySelector?.("select[data-table-sort]");
  if (pick) pick.value = `${col}:${dir}`;
}

function enhance(t) {
  if (!t.tHead?.rows[0] || !t.tBodies[0]) return;
  // Each cell names its column, for the card a row becomes on a phone.
  if (t.dataset.labelled !== String(t.tBodies[0].rows.length)) {
    const labels = columnLabels(t);
    for (const tr of t.tBodies[0].rows) {
      let c = 0;
      for (const td of tr.cells) {
        if (td.colSpan === 1 && !td.hasAttribute("data-label")) td.dataset.label = labels[c] || "";
        if (td.querySelector(".roster-actions, button, .btn")) td.classList.add("td-actions");
        c += td.colSpan;
      }
    }
    alignColumns(t);
    t.dataset.labelled = String(t.tBodies[0].rows.length);
  }
  const shell = shellOf(t);
  const rows = t.tBodies[0].rows.length;
  // Long: the first rows on a phone, and a button for the rest (a findable table pages instead).
  const clamp = !t.hasAttribute("data-find");
  t.classList.toggle("is-long", clamp && rows > LONG);
  const more = shell.nextElementSibling?.matches?.(".table-more") ? shell.nextElementSibling : null;
  if (!clamp) { if (more) more.remove(); } // pages of its own: never a "Show all" (and never one made again next sweep)
  else if (rows > LONG && !more && !t.classList.contains("is-expanded")) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn btn-outline table-more";
    b.textContent = `Show all ${rows} rows`;
    shell.after(b);
  } else if (rows <= LONG && more) more.remove();
  else if (more && more.textContent !== `Show all ${rows} rows`) more.textContent = `Show all ${rows} rows`; // only a change: the observer sees every write

  if (!t.hasAttribute("data-sortable")) { tools(t); applyFind(t); return; }
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
  // On a phone the headings are off-screen: the same sorts, as a list.
  if (!shell.previousElementSibling?.matches?.(".table-sort-mobile")) {
    const box = document.createElement("label");
    box.className = "table-sort-mobile";
    const name = document.createElement("span");
    name.textContent = "Sort by";
    const sel = document.createElement("select");
    sel.dataset.tableSort = "";
    sel.add(new Option("As listed", ""));
    columnLabels(t).forEach((l, i) => {
      if (!l) return;
      sel.add(new Option(`${l} — first to last`, `${i}:1`));
      sel.add(new Option(`${l} — last to first`, `${i}:-1`));
    });
    box.append(name, sel);
    shell.before(box);
  }
  const was = chosen.get(keyOf(t));
  if (was) sortTable(t, was.col, was.dir);
  tools(t);
  applyFind(t);
}

/** The search box and "Download CSV" above a table, the status line and pager under it — made once per table. */
function tools(t) {
  const find = t.hasAttribute("data-find"), csv = !!t.dataset.export;
  if ((!find && !csv) || toolsOf.has(t)) return;
  const shell = shellOf(t);
  const box = document.createElement("div");
  box.className = "table-tools";
  box.tableRef = t;
  let input = null;
  if (find) {
    const label = document.createElement("label");
    label.className = "table-find";
    const said = document.createElement("span");
    said.className = "sr-only";
    said.textContent = "Search this table";
    input = document.createElement("input");
    input.type = "search";
    input.autocomplete = "off";
    input.dataset.tableFind = "";
    label.append(said, input);
    box.append(label);
  }
  if (csv) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn btn-outline q-small";
    b.dataset.tableCsv = "";
    b.textContent = "Download CSV";
    box.append(b);
  }
  // Above the "Sort by" list a phone shows, or above the table.
  const above = shell.previousElementSibling?.matches?.(".table-sort-mobile") ? shell.previousElementSibling : shell;
  above.before(box);
  let status = null, pager = null;
  if (find) {
    status = document.createElement("p");
    status.className = "table-status";
    status.setAttribute("aria-live", "polite");
    pager = document.createElement("div");
    pager.className = "table-pager";
    pager.hidden = true;
    pager.tableRef = t;
    pager.innerHTML = `<button type="button" class="btn btn-outline q-small" data-table-page="-1">Previous page</button><button type="button" class="btn btn-outline q-small" data-table-page="1">Next page</button>`;
    shell.after(status, pager);
  }
  toolsOf.set(t, { input, status, pager });
}

/** Show the rows the search leaves, one page of them, and say so. */
function applyFind(t) {
  const k = toolsOf.get(t);
  if (!k?.status || !t.tBodies[0]) return;
  const st = found.get(keyOf(t)) || { q: "", page: 0 };
  if (k.input.value !== st.q) k.input.value = st.q;
  const rows = [...t.tBodies[0].rows];
  const hits = rows.filter((r) => matches(r.textContent, st.q));
  const pages = Math.max(1, Math.ceil(hits.length / PAGE));
  st.page = Math.max(0, Math.min(st.page, pages - 1));
  found.set(keyOf(t), st);
  const from = st.page * PAGE;
  const shown = new Set(hits.slice(from, from + PAGE));
  for (const r of rows) { const hide = !shown.has(r); if (r.hidden !== hide) r.hidden = hide; }
  const placeholder = `Search ${rows.length} rows`;
  if (k.input.placeholder !== placeholder) k.input.placeholder = placeholder;
  const q = st.q.trim();
  const text = !hits.length ? `No rows match “${q}”.`
    : hits.length > PAGE ? `Rows ${from + 1}–${from + shown.size} of ${hits.length}${q ? ` matching “${q}”` : ""}`
    : q ? `${hits.length} of ${rows.length} rows match “${q}”` : "";
  if (k.status.textContent !== text) k.status.textContent = text; // only a change: the observer sees every write
  const paged = hits.length > PAGE;
  if (k.pager.hidden === paged) k.pager.hidden = !paged;
  const [prev, next] = k.pager.querySelectorAll("button");
  prev.disabled = st.page === 0;
  next.disabled = st.page >= pages - 1;
}

/** "Download CSV": the column names, then every row the search leaves. */
function download(t) {
  const st = found.get(keyOf(t)) || { q: "" };
  const head = columnLabels(t);
  const rows = [...t.tBodies[0].rows].filter((r) => matches(r.textContent, st.q)).map((r) => [...r.cells].map(cellText));
  const blob = new Blob([`\ufeff${csvOf([head, ...rows])}`], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${t.dataset.export}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/** "Reset view": every table back as drawn — no sort, search or page kept. */
export function resetTables(root = document.body) {
  chosen.clear();
  found.clear();
  root.querySelectorAll("table.lms-table").forEach((t) => applyFind(t));
}

/** A list (data-clamp="10") shows its first rows on a phone, then "Show all". */
function clampList(el) {
  const n = Number(el.dataset.clamp) || 10;
  const more = el.lastElementChild?.matches(".table-more") ? el.lastElementChild : null;
  const items = el.children.length - (more ? 1 : 0);
  el.classList.toggle("is-long", items > n);
  el.style.setProperty("--clamp", n);
  if (items > n && !more && !el.classList.contains("is-expanded")) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn btn-outline table-more";
    b.textContent = `Show all ${items}`;
    el.append(b);
  } else if (items <= n && more) more.remove();
}

let busy = false;
const sweep = (root) => {
  root.querySelectorAll("table.lms-table").forEach(enhance);
  root.querySelectorAll("[data-clamp]").forEach(clampList);
};
/** Sorting, phone layouts and "Show all" for every table under `root`, now and as they're drawn. */
export function enableSortableTables(root = document.body) {
  sweep(root);
  root.addEventListener("click", (e) => {
    const target = e.target instanceof Element ? e.target : null;
    const more = target?.closest(".table-more");
    if (more) {
      const prev = more.previousElementSibling;
      const list = prev?.matches?.(".lms-table-wrap") ? prev.querySelector("table") : prev?.matches?.("table") ? prev : more.parentElement;
      list?.classList.add("is-expanded");
      more.remove();
      return;
    }
    const step = target?.closest("[data-table-page]");
    if (step) {
      const t = step.closest(".table-pager")?.tableRef;
      const st = t && found.get(keyOf(t));
      if (!st) return;
      st.page += Number(step.dataset.tablePage);
      busy = true;
      applyFind(t);
      busy = false;
      t.closest(".lms-table-wrap, table")?.scrollIntoView({ block: "nearest" });
      return;
    }
    const csv = target?.closest("[data-table-csv]");
    if (csv) { const t = csv.closest(".table-tools")?.tableRef; if (t) download(t); return; }
    const b = target?.closest(".th-sort");
    if (!b) return;
    const th = b.closest("th"), t = th.closest("table");
    const col = [...th.parentElement.cells].indexOf(th);
    const dir = th.getAttribute("aria-sort") === "ascending" ? -1 : 1;
    chosen.set(keyOf(t), { col, dir });
    busy = true;
    sortTable(t, col, dir);
    applyFind(t);
    busy = false;
  });
  root.addEventListener("input", (e) => {
    const box = e.target instanceof Element ? e.target.closest("input[data-table-find]") : null;
    const t = box?.closest(".table-tools")?.tableRef;
    if (!t) return;
    found.set(keyOf(t), { q: box.value, page: 0 });
    busy = true;
    applyFind(t);
    busy = false;
  });
  root.addEventListener("change", (e) => {
    const sel = e.target instanceof Element ? e.target.closest("select[data-table-sort]") : null;
    if (!sel) return;
    const next = sel.closest(".table-sort-mobile")?.nextElementSibling;
    const t = next instanceof HTMLTableElement ? next : next?.querySelector?.("table");
    if (!t) return;
    if (!sel.value) { chosen.delete(keyOf(t)); return; }
    const [col, dir] = sel.value.split(":").map(Number);
    chosen.set(keyOf(t), { col, dir });
    busy = true;
    sortTable(t, col, dir);
    applyFind(t);
    busy = false;
  });
  // Tables drawn again keep their reader's sort, and get their labels.
  new MutationObserver(() => {
    if (busy) return;
    busy = true;
    sweep(root);
    busy = false;
  }).observe(root, { childList: true, subtree: true });
}
