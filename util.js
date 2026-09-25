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
  el.innerHTML = `<strong>${esc(title)}</strong>${body ? `<div>${esc(body)}</div>` : ""}`;
  toastHost.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

/* ============================================================
   Shared state kit — one vocabulary for "what's happening with this
   data" so every dashboard list looks and behaves the same way while
   it loads, comes back empty, fails, or is being written to. See
   styles.css's "state kit" block for the CSS these render into.
   ============================================================ */

/* Loading skeleton: shaped like the rows about to replace it (a name +
   two lines of meta, by default) so the layout doesn't jump when the
   real content lands — pass `rows` to match how many you expect,
   `avatar:false` for a list with no leading circle/icon. */
export function skeleton(rows = 3, { avatar = true } = {}) {
  const row = `
    <div class="skeleton-row">
      ${avatar ? `<div class="skeleton-block skeleton-avatar"></div>` : ""}
      <div class="skeleton-lines"><div class="skeleton-block"></div><div class="skeleton-block"></div></div>
    </div>`;
  return `<div class="skeleton-list" aria-hidden="true">${row.repeat(rows)}</div>`;
}

/* Empty state: a title on its own is enough for a minor list; pass
   `detail` for the friendlier two-line version ("No assignments yet" /
   "Your teacher hasn't assigned anything here."). */
export function emptyState(title, detail = "") {
  return `<div class="empty-state"><b>${esc(title)}</b>${detail ? `<div>${esc(detail)}</div>` : ""}</div>`;
}

/* Error state, with an optional "Try again" button. `onRetry` is a
   plain callback (usually just "run the same loader again") — wired
   through a small click-delegated registry below, since every render
   function in this codebase returns an HTML string rather than a live
   element. Never pass a raw error's own text here — run it through
   friendlyError() first. */
let retrySeq = 0;
const retryRegistry = new Map();
export function errorState(detail, onRetry) {
  const html = `<div class="state-error">
    <div class="state-title">We couldn't load this information.</div>
    <div class="state-detail">${esc(detail || "Check your connection and try again.")}</div>
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
export function friendlyError(err, fallback = "We couldn't load this information. Check your connection and try again.") {
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
    confirmOverlay.innerHTML = `
      <div class="confirm-card" role="alertdialog" aria-modal="true">
        <b>${esc(title)}</b>
        ${body ? `<p>${esc(body)}</p>` : ""}
        <div class="confirm-actions">
          <button type="button" class="btn btn-outline" data-act="cancel">${esc(cancelLabel)}</button>
          <button type="button" class="btn ${danger ? "btn-danger" : "btn-primary"}" data-act="ok">${esc(confirmLabel)}</button>
        </div>
      </div>`;
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      confirmOverlay.classList.remove("is-open");
      document.removeEventListener("keydown", onKey);
      resolve(val);
    };
    const onKey = (e) => { if (e.key === "Escape") done(false); };
    confirmOverlay.querySelector('[data-act="cancel"]').addEventListener("click", () => done(false));
    confirmOverlay.querySelector('[data-act="ok"]').addEventListener("click", () => done(true));
    confirmOverlay.addEventListener("click", (e) => { if (e.target === confirmOverlay) done(false); });
    document.addEventListener("keydown", onKey);
    confirmOverlay.classList.add("is-open");
  });
}
