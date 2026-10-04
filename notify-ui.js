/* ============================================================
   HPF Digital Learning Portal — notifications (the bell).

   Every dashboard's bell shows how many notifications are unread and
   opens the list: what it's about, when, and a link to the page to act
   on it. Opening or "mark as read" records that it was read (server-side,
   with the time — notifications are stored and auditable, never just a
   browser alert). Offline, the list on this device is shown and reading
   is synced later like any other offline activity.
   ============================================================ */

import { esc, toast } from "./util.js";
import { getNotifications, readNotification, readAllNotifications } from "./store.js";
import { openContentPanel, closeViewer } from "./viewer.js";
import * as sync from "./sync.js";

const SEVERITY_LABEL = { action: "To do", warning: "Overdue", info: "" };
let state = { notifications: [], unread: 0, loaded: false };
let bell = null;

function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString([], { day: "numeric", month: "short" });
}

function renderBell() {
  if (!bell) return;
  const n = state.unread;
  bell.querySelector(".dot")?.remove();
  let badge = bell.querySelector(".bell-count");
  if (n) {
    if (!badge) { badge = document.createElement("span"); badge.className = "bell-count"; bell.appendChild(badge); }
    badge.textContent = n > 99 ? "99+" : String(n);
  } else badge?.remove();
  bell.setAttribute("aria-label", n ? `Notifications — ${n} unread` : "Notifications");
  bell.title = n ? `${n} unread notification${n === 1 ? "" : "s"}` : "Notifications";
}

async function load() {
  try {
    const res = await getNotifications();
    state = { notifications: res.notifications || [], unread: res.unread ?? 0, loaded: true };
  } catch {
    // Not signed in yet, or offline with nothing on this device: keep what we have.
  }
  renderBell();
  return state;
}

/** Marks one read here and on the server (or queued, offline). */
async function markRead(n) {
  if (n.readAt) return;
  n.readAt = new Date().toISOString();
  state.unread = Math.max(0, state.unread - 1);
  renderBell();
  try { await readNotification(n.id, n.title); } catch { /* it stays unread on the server; shown read here until the next load */ }
  document.dispatchEvent(new Event("hpf-notifications-read"));
}

function itemHtml(n) {
  const tag = SEVERITY_LABEL[n.severity];
  return `<li class="notif ${n.readAt ? "is-read" : "is-unread"} notif-${esc(n.severity)}" data-id="${esc(n.id)}">
    <div class="notif-main">
      <b>${esc(n.title)}</b>
      ${n.body ? `<span class="notif-body">${esc(n.body)}</span>` : ""}
      <span class="notif-meta">${esc(ago(n.createdAt))}${tag ? ` · <span class="pill ${n.severity === "warning" ? "danger" : "warm"}">${esc(tag)}</span>` : ""}${n.readAt ? " · read" : ""}</span>
    </div>
    <div class="notif-actions">
      ${n.link ? `<button type="button" class="btn btn-outline q-small" data-open>Open</button>` : ""}
      ${n.readAt ? "" : `<button type="button" class="btn btn-ghost q-small" data-read>Mark as read</button>`}
    </div>
  </li>`;
}

export function openNotifications() {
  const panel = openContentPanel({ title: "Notifications", html: `<div class="empty-state">Loading…</div>` });
  const render = () => {
    const list = state.notifications;
    panel.innerHTML = `
      <div class="lms-actions" style="justify-content:space-between;margin-bottom:.8rem">
        <span class="hint-inline">${state.unread ? `${state.unread} unread` : "All read"}${sync.isOnline() ? "" : " · offline: showing what's on this device"}</span>
        ${state.unread ? `<button type="button" class="btn btn-ghost q-small" data-read-all>Mark all as read</button>` : ""}
      </div>
      ${list.length ? `<ul class="notif-list">${list.map(itemHtml).join("")}</ul>`
        : `<div class="empty-state">No notifications yet. Reminders about work due, forms to fill, visits to finish and things to approve appear here.</div>`}
      <p class="field-hint">Notifications are kept as a record — when each was sent and when you read it.</p>`;
  };
  render();
  load().then(render);
  panel.addEventListener("click", async (e) => {
    const li = e.target.closest("[data-id]");
    const n = li && state.notifications.find((x) => x.id === li.dataset.id);
    if (e.target.closest("[data-read-all]")) {
      state.notifications.forEach((x) => { x.readAt ||= new Date().toISOString(); });
      state.unread = 0;
      renderBell(); render();
      try { await readAllNotifications(); } catch (err) { toast("Couldn't mark them all read", err?.message || "", "error"); }
      document.dispatchEvent(new Event("hpf-notifications-read"));
      return;
    }
    if (!n) return;
    if (e.target.closest("[data-read]")) { await markRead(n); render(); return; }
    if (e.target.closest("[data-open]")) {
      await markRead(n);
      closeViewer();
      // Same page: just switch section. Another dashboard: go there.
      const [page, hash] = String(n.link).split("#");
      const here = location.pathname.split("/").pop() || "index.html";
      setTimeout(() => {
        if (!page || page === here) location.hash = hash ? `#${hash}` : location.hash;
        else location.href = n.link;
      }, 50);
    }
  });
}

/** The bell on this dashboard: count, list, and a refresh every few minutes. */
export function mountBell() {
  bell = document.querySelector('.app-top-actions [aria-label="Notifications"], .app-top-actions .icon-btn');
  if (!bell) return;
  bell.querySelector(".dot")?.remove();
  bell.addEventListener("click", openNotifications);
  // After the page has signed in and loaded its own data.
  setTimeout(load, 2500);
  setInterval(() => { if (document.visibilityState === "visible") load(); }, 5 * 60_000);
  window.addEventListener("online", () => setTimeout(load, 3000));
}
