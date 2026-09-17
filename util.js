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

let toastHost = null;
export function toast(title, body = "", kind = "info") {
  if (!toastHost) {
    toastHost = document.createElement("div");
    toastHost.className = "toast-host";
    document.body.appendChild(toastHost);
  }
  const el = document.createElement("div");
  el.className = `toast${kind === "error" ? " error" : ""}`;
  el.setAttribute("role", kind === "error" ? "alert" : "status");
  el.innerHTML = `<strong>${esc(title)}</strong>${body ? `<div>${esc(body)}</div>` : ""}`;
  toastHost.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}
