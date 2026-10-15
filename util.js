/* ============================================================
   HPF Digital Learning Portal — tiny shared helpers.
   ============================================================ */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (s = "") =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const initials = (name = "") =>
  name.trim().split(/\s+/).slice(0, 2).map((p) => p[0] || "").join("").toUpperCase() || "?";

/* "Aitong Primary (NRK-003) · Narok" — the school line under a dashboard
   title. A personal code is the school code plus a suffix
   (NRK-003-T02), so the school's code is its first two parts. */
export function schoolLine(user) {
  if (!user.school) return "No school set";
  const schoolCode = user.userCode ? user.userCode.split("-").slice(0, 2).join("-") : "";
  return `${user.school}${schoolCode ? ` (${schoolCode})` : ""}${user.county ? ` · ${user.county}` : ""}`;
}

/* "1h 24m" / "24m" / "45s" — used everywhere library-usage time is shown. */
export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}

/* Buckets library items into "folders" by content type — Video, Reading,
   etc. — in a fixed order (unrecognized/blank types trail at the end as
   "Other"), skipping any type with nothing in it. Every dashboard that
   lists the content library uses this so the folders line up the same
   way everywhere. */
export function groupByType(items, order) {
  const buckets = new Map();
  for (const it of items) {
    const key = (it.type || "").trim() || "Other";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(it);
  }
  const known = order.filter((k) => buckets.has(k));
  const rest = [...buckets.keys()].filter((k) => !order.includes(k)).sort();
  return [...known, ...rest].map((type) => ({ type, items: buckets.get(type) }));
}

/* Buckets library items into the organizational folders the education
   team created (see library_folders) — a real, named grouping, distinct
   from groupByType's by-content-type buckets. Items with no folder, or
   whose folder got deleted, land in a trailing "Unfiled" group; folders
   with nothing in them are skipped. */
export function groupByFolder(items, folders) {
  const known = new Map((folders || []).map((f) => [f.id, f]));
  const buckets = new Map();
  const unfiled = [];
  for (const it of items) {
    const f = it.folderId && known.has(it.folderId) ? known.get(it.folderId) : null;
    if (!f) { unfiled.push(it); continue; }
    if (!buckets.has(f.id)) buckets.set(f.id, []);
    buckets.get(f.id).push(it);
  }
  const groups = (folders || [])
    .filter((f) => buckets.has(f.id))
    .map((f) => ({ id: f.id, name: f.name, items: buckets.get(f.id) }));
  if (unfiled.length) groups.push({ id: null, name: "Unfiled", items: unfiled });
  return groups;
}

let toastHost = null;
export function toast(title, body = "", kind = "info") {
  if (!toastHost) {
    toastHost = document.createElement("div");
    toastHost.className = "toast-host";
    document.body.appendChild(toastHost);
  }
  const el = document.createElement("div");
  el.className = `toast${kind === "error" ? " error" : kind === "success" ? " success" : ""}`;
  el.setAttribute("role", kind === "error" ? "alert" : "status");
  el.innerHTML = `<div class="toast-text"><strong>${esc(title)}</strong>${body ? `<div>${esc(body)}</div>` : ""}</div>`
    + `<button type="button" class="toast-close" aria-label="Dismiss">×</button>`;
  toastHost.appendChild(el);
  // A problem stays long enough to be read (and while it's pointed at); anything can be dismissed.
  const ms = kind === "error" ? 10000 : 5000;
  let timer = setTimeout(() => el.remove(), ms);
  el.addEventListener("mouseenter", () => clearTimeout(timer));
  el.addEventListener("mouseleave", () => { timer = setTimeout(() => el.remove(), 2500); });
  el.querySelector(".toast-close").addEventListener("click", () => el.remove());
}

/* ============================================================
   Shared state kit — one vocabulary for "what's happening with this
   data" so every dashboard list looks and behaves the same way while
   it loads, comes back empty, fails, or is being written to. See
   app.css's "state kit" block for the CSS these render into.
   ============================================================ */

/* Loading skeletons, each shaped like what is about to replace it, so
   the layout doesn't jump when the real content lands. Screen readers
   hear "Loading…" once (role=status); the grey blocks are hidden from them.
     skeleton(rows, { avatar })   a list: a name and a line of detail per row
     skeletonTable(rows, cols)    a table: a heading row, then rows of cells
     skeletonCards(n)             a row of key figures
     skeletonCharts(n)            chart cards
     skeletonDashboard()          key figures, then chart cards
   Static pages name the shape instead: <div data-skeleton="table"></div>
   (fillSkeletons() draws them; data-rows / data-cols say how many). */
const loading = (cls, inner) => `<div class="skeleton-list ${cls}" role="status"><span class="sr-only">Loading…</span><div class="skeleton-inner" aria-hidden="true">${inner}</div></div>`;
const block = (w = "", h = "") => `<div class="skeleton-block"${w || h ? ` style="${w ? `width:${w};` : ""}${h ? `height:${h};` : ""}"` : ""}></div>`;
export function skeleton(rows = 3, { avatar = true } = {}) {
  const row = `
    <div class="skeleton-row">
      ${avatar ? `<div class="skeleton-block skeleton-avatar"></div>` : ""}
      <div class="skeleton-lines"><div class="skeleton-block"></div><div class="skeleton-block"></div></div>
    </div>`;
  return loading("sk-list", row.repeat(rows));
}
export function skeletonTable(rows = 5, cols = 4) {
  const widths = ["70%", "55%", "40%", "60%", "45%", "35%"];
  const cells = (h) => Array.from({ length: cols }, (_, i) => `<div class="sk-cell">${block(i === 0 ? "75%" : widths[(i + h) % widths.length])}</div>`).join("");
  return loading("sk-table", `<div class="sk-tr sk-th">${cells(0)}</div>${Array.from({ length: rows }, (_, r) => `<div class="sk-tr">${cells(r + 1)}</div>`).join("")}`);
}
const cardBlocks = (n) => `<div class="sk-card">${block("55%")}${block("40%", "1.6rem")}${block("80%")}</div>`.repeat(n);
const chartBlocks = (n) => `<div class="sk-chart">${block("45%")}${block("70%")}<div class="skeleton-block sk-plot"></div></div>`.repeat(n);
export const skeletonCards = (n = 4) => loading("sk-cards", cardBlocks(n));
export const skeletonCharts = (n = 2) => loading("sk-charts", chartBlocks(n));
export const skeletonDashboard = ({ cards = 4, charts = 2 } = {}) =>
  loading("sk-dash", `<div class="sk-cards">${cardBlocks(cards)}</div><div class="sk-charts">${chartBlocks(charts)}</div>`);
const SHAPES = {
  list: (el) => skeleton(Number(el.dataset.rows) || 3, { avatar: false }),
  rows: (el) => skeleton(Number(el.dataset.rows) || 3),
  table: (el) => skeletonTable(Number(el.dataset.rows) || 5, Number(el.dataset.cols) || 4),
  cards: (el) => skeletonCards(Number(el.dataset.rows) || 4),
  charts: (el) => skeletonCharts(Number(el.dataset.rows) || 2),
  dashboard: () => skeletonDashboard(),
  // A line of text inside a sentence (a <p>): blocks that sit in a line.
  line: () => `<span class="sk-line" role="status"><span class="sr-only">Loading…</span><span class="skeleton-block" aria-hidden="true"></span></span>`,
};
/** A line of text still loading, inside a heading or a sentence. */
export const skeletonLine = () => SHAPES.line();
/** Draw the skeleton each [data-skeleton] placeholder asks for. */
export function fillSkeletons(root = document) {
  for (const el of root.querySelectorAll("[data-skeleton]")) {
    const shape = SHAPES[el.dataset.skeleton];
    if (shape) el.innerHTML = shape(el);
    el.removeAttribute("data-skeleton");
  }
}
if (typeof document !== "undefined") fillSkeletons(); // pages whose markup is already there

/* Empty state: say what is missing, and what to do next. A title on its
   own is enough for a minor list; pass `detail` for the next step ("No
   assignments yet" / "Your teacher hasn't set anything for your class.").
   When filters hid everything, say that instead — filteredEmpty(). */
export function emptyState(title, detail = "") {
  return `<div class="empty-state"><b>${esc(title)}</b>${detail ? `<div>${esc(detail)}</div>` : ""}</div>`;
}
/** Nothing left once the filters are applied. */
export const FILTERED_EMPTY = "Nothing matches your current filters.";
export const filteredEmpty = (detail = "Take a filter off, or choose “All”, to see more.") => emptyState(FILTERED_EMPTY, detail);

/* Error state, with an optional "Try again" button. `onRetry` is a
   plain callback (usually just "run the same loader again") — wired
   through a small click-delegated registry below, since every render
   function in this codebase returns an HTML string rather than a live
   element. Never pass a raw error's own text here — run it through
   friendlyError() first. */
let retrySeq = 0;
const retryRegistry = new Map();
export function errorState(detail, onRetry) {
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  const said = offline ? "You're offline. This needs a connection — try again once you're back online."
    : String(detail || "").replace(/^We couldn't load this information\.\s*/, "") || "Check your connection and try again.";
  const html = `<div class="state-error" role="alert">
    <div class="state-title">We couldn't load this information.</div>
    <div class="state-detail">${esc(said)}</div>
    ${onRetry ? `<button type="button" class="state-retry" data-retry-id="${retrySeq}">Try again</button>` : ""}
  </div>`;
  if (onRetry) retryRegistry.set(String(retrySeq++), onRetry);
  return html;
}
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-retry-id]");
  if (!btn) return;
  retryRegistry.get(btn.dataset.retryId)?.();
});

/* The one place that decides whether an error's own message is safe to
   show. ApiError (api.js) always carries either a message the backend
   deliberately wrote for a user to read (bad password, missing field,
   "that email already exists" — genuinely helpful) or an already-generic
   "Request failed (nnn)" fallback — never a stack trace or raw SQL/fetch
   error, so it's identified here by duck-typing a numeric `.status`
   rather than importing ApiError (avoids a circular import with api.js).
   Anything else — a dropped connection, an unexpected JS error — is not
   safe to print: log the real thing to console for debugging, show a
   calm generic message instead. */
export function friendlyError(err, fallback = "Check your connection and try again.") {
  if (err && typeof err.status === "number" && err.message) return err.message;
  console.error(err);
  return fallback;
}

/* In-app confirm dialog — replaces the native window.confirm() for
   destructive actions (deleting content, removing a folder). The native
   dialog is blocking and browser-styled, which is both inconsistent with
   the rest of the UI and, in some embedded/automated contexts, silently
   auto-dismissed as "cancel" without the caller ever finding out. This
   is a real Promise the caller awaits, so there's no ambiguity about
   whether the user actually chose to proceed. */
let confirmOverlay = null;
export function confirmDialog({ title = "Are you sure?", body = "", confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false } = {}) {
  return new Promise((resolve) => {
    if (!confirmOverlay) {
      confirmOverlay = document.createElement("div");
      confirmOverlay.className = "confirm-overlay";
      document.body.appendChild(confirmOverlay);
    }
    // Focus goes into the dialog and stays there until it's answered — on
    // Cancel when the action can't easily be undone, so Enter doesn't do it
    // by accident — then back to whatever opened it.
    const opener = document.activeElement;
    confirmOverlay.innerHTML = `
      <div class="confirm-card${danger ? " is-danger" : ""}" role="alertdialog" aria-modal="true" aria-labelledby="confirmTitle"${body ? ' aria-describedby="confirmBody"' : ""}>
        <b id="confirmTitle">${danger ? '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>' : ""}${esc(title)}</b>
        ${body ? `<p id="confirmBody">${esc(body)}</p>` : ""}
        <div class="confirm-actions">
          <button type="button" class="btn btn-outline" data-act="cancel">${esc(cancelLabel)}</button>
          <button type="button" class="btn ${danger ? "btn-danger" : "btn-primary"}" data-act="ok">${esc(confirmLabel)}</button>
        </div>
      </div>`;
    const cancelBtn = confirmOverlay.querySelector('[data-act="cancel"]');
    const okBtn = confirmOverlay.querySelector('[data-act="ok"]');
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      confirmOverlay.classList.remove("is-open");
      document.removeEventListener("keydown", onKey);
      if (opener && opener.isConnected && typeof opener.focus === "function") opener.focus();
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); done(false); }
      if (e.key === "Tab") { // two buttons: keep the focus on them
        e.preventDefault();
        (document.activeElement === cancelBtn ? okBtn : cancelBtn).focus();
      }
    };
    cancelBtn.addEventListener("click", () => done(false));
    okBtn.addEventListener("click", () => done(true));
    confirmOverlay.onclick = (e) => { if (e.target === confirmOverlay) done(false); };
    document.addEventListener("keydown", onKey);
    confirmOverlay.classList.add("is-open");
    (danger ? cancelBtn : okBtn).focus();
  });
}
