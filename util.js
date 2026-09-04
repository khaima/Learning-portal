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
