/* ============================================================
   HPF Digital Learning Portal — sync status, on every dashboard.

     ● Online   Last sync 10:42 AM · Pending 0
     ● Offline  Last sync 10:42 AM · 3 activities waiting to sync

   Tapping it opens the Sync panel: what's waiting, anything that needs a
   decision (a conflict, a refusal), "Sync now", and the resources saved
   on this device for reading offline.
   ============================================================ */

import { esc, toast, confirmDialog } from "./util.js";
import * as sync from "./sync.js";
import { openContentPanel } from "./viewer.js";

export function fmtSyncTime(iso) {
  if (!iso) return "not yet on this device";
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}
const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n || 0} B`);
const waitingText = (n) => `${n} ${n === 1 ? "activity" : "activities"} waiting to sync`;

function chipState(st) {
  if (st.conflicts || st.failed) return { cls: "attention", label: st.online ? "Needs attention" : "Offline" };
  if (st.syncing) return { cls: "syncing", label: "Syncing…" };
  return st.online ? { cls: "online", label: "Online" } : { cls: "offline", label: "Offline" };
}

/** The chip in the top bar. */
export function mountSyncStatus() {
  const host = document.querySelector(".app-top-actions");
  if (!host || host.querySelector(".sync-chip")) return;
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "sync-chip";
  host.prepend(chip);
  const render = (st) => {
    const { cls, label } = chipState(st);
    const stuck = st.conflicts + st.failed;
    chip.dataset.state = cls;
    chip.innerHTML = `<i class="sync-dot" aria-hidden="true"></i><b>${label}</b>
      <span class="sync-meta">Last sync ${esc(fmtSyncTime(st.lastSync))} · ${st.online && !st.pending ? "Pending 0" : waitingText(st.pending)}${stuck ? ` · ${stuck} to check` : ""}</span>
      <span class="sync-count" aria-hidden="true">${st.pending || stuck ? st.pending + stuck : ""}</span>`;
    chip.title = `${label}. Last sync ${fmtSyncTime(st.lastSync)}. ${waitingText(st.pending)}.`;
  };
  render(sync.status());
  sync.onChange(render);
  chip.addEventListener("click", openSyncPanel);
}

/* ------------------------------------------------------------ the panel */

const STATUS_TEXT = {
  pending: (it) => it.attempts ? `Waiting to sync — will try again${it.nextAt > Date.now() ? ` at ${new Date(it.nextAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : " soon"}` : "Waiting to sync",
  syncing: () => "Sending…",
};

function conflictHtml(it) {
  const c = it.conflict || {};
  const btn = (act, label, cls = "btn-outline") => `<button type="button" class="btn ${cls} q-small" data-act="${act}" data-id="${esc(it.id)}">${label}</button>`;
  if (c.kind === "changed_elsewhere") {
    return `<p>These answers were changed on another device after this one last synced.</p>
      <div class="lms-actions">${btn("mine", "Keep mine", "btn-primary")}${btn("theirs", "Use the other device's")}</div>`;
  }
  if (c.kind === "already_handed_in") {
    return `<p>This was already handed in from another device, so this copy can't be sent. Your teacher has the version that was handed in.</p>
      <div class="lms-actions">${btn("theirs", "OK — remove this copy")}</div>`;
  }
  if (c.kind === "marked_elsewhere") {
    const s = c.server?.submission;
    return `<p>Someone marked this while you were offline${s?.marks != null ? ` (${s.marks}/${s.maxMarks}${s.markerName ? ` by ${esc(s.markerName)}` : ""})` : ""}.</p>
      <div class="lms-actions">${btn("mine", "Keep my marks", "btn-primary")}${btn("theirs", "Keep theirs")}</div>`;
  }
  return `<p>${esc(it.error || "This conflicts with a change made elsewhere.")}</p>
    <div class="lms-actions">${btn("mine", "Send mine anyway", "btn-primary")}${btn("theirs", "Discard mine")}</div>`;
}

function itemHtml(it) {
  const when = new Date(it.createdAt).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  let body = "";
  if (it.status === "conflict") body = conflictHtml(it);
  else if (it.status === "failed") {
    body = `<p class="field-error" style="margin:.2rem 0 .4rem">Couldn't be sent: ${esc(it.error || "the server refused it")}</p>
      <div class="lms-actions"><button type="button" class="btn btn-outline q-small" data-act="retry" data-id="${esc(it.id)}">Try again</button>
      <button type="button" class="btn btn-ghost q-small" data-act="discard" data-id="${esc(it.id)}">Discard</button></div>`;
  } else body = `<p class="hint-inline" style="margin:.15rem 0 0">${esc((STATUS_TEXT[it.status] || STATUS_TEXT.pending)(it))}</p>`;
  return `<li class="sync-item sync-${esc(it.status)}"><b>${esc(it.label)}</b><span class="hint-inline"> · done ${esc(when)}</span>${body}</li>`;
}

export function openSyncPanel() {
  const panel = openContentPanel({ title: "Offline & sync", html: "" }, () => stop());
  const render = async (st = sync.status()) => {
    const est = await navigator.storage?.estimate?.().catch(() => null);
    const stuck = st.items.filter((i) => i.status === "conflict" || i.status === "failed");
    const waiting = st.items.filter((i) => i.status === "pending" || i.status === "syncing");
    panel.innerHTML = `
      <div class="sync-card" data-state="${chipState(st).cls}">
        <p class="sync-big"><i class="sync-dot" aria-hidden="true"></i> ${st.online ? "Online" : "Offline"}</p>
        <dl class="sync-facts">
          <dt>Last sync</dt><dd>${esc(fmtSyncTime(st.lastSync))}</dd>
          <dt>Pending</dt><dd>${st.pending ? esc(waitingText(st.pending)) : "0"}</dd>
          ${stuck.length ? `<dt>To check</dt><dd>${stuck.length}</dd>` : ""}
        </dl>
        <button type="button" class="btn btn-primary" data-act="sync" ${navigator.onLine && !st.syncing ? "" : "disabled"}>${st.syncing ? "Syncing…" : "Sync now"}</button>
        ${st.online ? "" : `<p class="field-hint">You can keep working: what you do is saved on this device and sent automatically when the connection is back.</p>`}
        ${st.needsSignIn ? `<p class="field-error">Your sign-in has expired. <a href="index.html">Sign in again</a> to send what's waiting — it's kept until then.</p>` : ""}
      </div>
      ${stuck.length ? `<h3>Needs your decision</h3><ul class="sync-list">${stuck.map(itemHtml).join("")}</ul>` : ""}
      <h3>Waiting to sync</h3>
      ${waiting.length ? `<ul class="sync-list">${waiting.map(itemHtml).join("")}</ul>` : `<p class="hint">Nothing — everything done on this device has been sent.</p>`}
      <h3>Saved for offline reading</h3>
      ${st.savedFiles.length ? `<ul class="sync-list">${st.savedFiles.map((f) => `
        <li class="sync-item"><b>${esc(f.title || f.name)}</b><span class="hint-inline"> · ${esc(f.name)} · ${esc(fmtBytes(f.size))}</span>
          <div class="lms-actions"><button type="button" class="btn btn-ghost q-small" data-act="unsave" data-key="${esc(f.key)}">Remove from this device</button></div></li>`).join("")}</ul>`
        : `<p class="hint">Nothing saved yet. Use <b>Save offline</b> on a resource to read it without a connection.</p>`}
      ${est?.usage != null ? `<p class="field-hint">This portal is using ${esc(fmtBytes(est.usage))} on this device.</p>` : ""}
      <p class="field-hint">Signing out removes this account's offline copies and saved resources from the device — but never work that hasn't been sent yet.</p>`;
  };
  const stop = sync.onChange((st) => render(st));
  render();
  panel.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const id = b.dataset.id;
    try {
      if (b.dataset.act === "sync") {
        const st = await sync.sync({ manual: true });
        toast(st.pending ? "Not everything could be sent" : "Synced", st.pending ? "The rest goes when the connection is better." : `Last sync ${fmtSyncTime(st.lastSync)}.`, st.pending ? "error" : "success");
      } else if (b.dataset.act === "mine") await sync.keepMine(id);
      else if (b.dataset.act === "retry") await sync.retry(id);
      else if (b.dataset.act === "theirs") await sync.discard(id);
      else if (b.dataset.act === "discard") {
        if (await confirmDialog({ title: "Discard this activity?", body: "It's deleted from this device and never sent.", confirmLabel: "Discard", danger: true })) await sync.discard(id);
      } else if (b.dataset.act === "unsave") await sync.removeSavedFile(b.dataset.key);
    } catch (err) {
      toast("Couldn't do that", err?.message || "", "error");
    }
  });
}
