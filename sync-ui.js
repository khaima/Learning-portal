/* ============================================================
   HPF Digital Learning Portal — sync status and the Sync center.

     ● Online   Last sync 10:42 AM · Pending 0
     ● Offline  Last sync 10:42 AM · 3 activities waiting to sync

   Tapping it opens the Sync center: Kobo, school data, learning activity
   and content at a glance, what's waiting, anything that needs a decision
   (a conflict, a refusal), "Sync now", and the resources saved on this
   device for reading offline.
   ============================================================ */

import { esc, toast, confirmDialog } from "./util.js";
import * as sync from "./sync.js";
import { openContentPanel } from "./viewer.js";
import { getProfile } from "./auth.js";
import { apiGet } from "./api.js";
import { syncKobo } from "./store.js";
import { cacheIndex } from "./offline.js";

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
  return `<li class="sync-item sync-${esc(it.status)}"><b>${esc(it.label)}</b><span class="hint-inline"> · ${esc(AREA_LABEL[sync.areaOf(it.kind)] || "")} · done ${esc(when)}</span>${body}</li>`;
}

/* ------------------------------------------------------------ the Sync center

     Kobo               ✓ Connected · Last sync 10:32
     School data        ✓ Synced
     Learning activity  ⚠ 14 pending
     Content            ✓ Synced
     [Sync now]

   Each row says what's wrong in words and what to do about it. Below:
   what needs a decision, what's waiting, Kobo survey by survey (and, for
   a field officer, what Kobo has from them and why some needs review),
   the resources saved on this device — and, for the Education Team, every
   field officer's, teacher's and school head's device. */

const SCHOOL_PATHS = ["/schools", "/forms", "/responses", "/field-reports", "/school/overview", "/learners", "/classes", "/kobo/my-surveys"];
const LEARNING_PATHS = ["/learner/assignments", "/assignments", "/submissions", "/results"];
const AREA_LABEL = { school: "School data", learning: "Learning activity", other: "Other" };
const ICON = { ok: "✓", warn: "⚠", error: "✕", none: "○", update: "↻" };
const newest = (index, prefixes) => index
  .filter((e) => prefixes.some((p) => e.path === p || e.path.startsWith(`${p}/`) || e.path.startsWith(`${p}?`)))
  .map((e) => e.savedAt).sort().at(-1) ?? null;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function row(area, title, state, value, detail = "", tip = "") {
  return `<div class="sc-row sc-${state}" data-area="${area}">
    <span class="sc-icon" aria-hidden="true">${ICON[state]}</span>
    <div class="sc-main"><div class="sc-line"><b>${title}</b><span class="sc-value">${value}</span></div>
      ${detail ? `<span class="sc-detail">${detail}</span>` : ""}
      ${tip ? `<p class="sc-tip">${tip}</p>` : ""}</div>
  </div>`;
}

function rowsHtml({ st, server, perms, index, busy }) {
  const out = [];
  const role = st.role;
  const k = server?.kobo;
  const manage = perms.has("kobo.manage");
  // Connecting Kobo (and its API token) is the Super Admin's: Platform → Data & integrations → Kobo.
  const configure = perms.has("kobo.configure");

  // ---- Kobo
  if (k) {
    if (busy.kobo) out.push(row("kobo", "Kobo", "update", "Syncing with KoboToolbox…", "This can take a minute for big surveys."));
    else if (!k.connected) {
      out.push(row("kobo", "Kobo", "error", "Not connected", "",
        configure ? `Connect KoboToolbox on <a href="platform.html#kobo">Data &amp; integrations → Kobo</a> with the account's API token.` : "KoboToolbox isn't connected to the portal yet — a Super Admin connects it."));
    } else {
      const tips = [];
      if (k.failing) {
        tips.push(manage ? `${plural(k.failing, "survey")} couldn't sync — the reason is below.`
          : "Some surveys couldn't be fetched from KoboToolbox at the last sync. Your submissions are safe in Kobo and arrive once it works again.");
      }
      if (k.mine?.needsReview) tips.push(`${plural(k.mine.needsReview, "of your submissions needs", "of your submissions need")} review — why is below; M&E reviews them.`);
      if (!k.pushConfigured && (!k.lastSyncedAt || Date.now() - Date.parse(k.lastSyncedAt) > 24 * 3600e3)) {
        tips.push(`What you send from Kobo Collect reaches the portal at the next Kobo sync${manage ? " — press Sync now" : ""}.`);
      }
      const detail = [
        k.lastSyncedAt ? `Last sync ${esc(fmtSyncTime(k.lastSyncedAt))}` : "Not synced yet",
        k.lastPushAt ? `last pushed submission ${esc(fmtSyncTime(k.lastPushAt))}` : "",
        k.mine ? `Kobo has ${plural(k.mine.received, "submission")} from you${k.mine.lastSubmittedAt ? `, latest ${esc(fmtSyncTime(k.mine.lastSubmittedAt))}` : ""}` : "",
      ].filter(Boolean).join(" · ");
      out.push(row("kobo", "Kobo", k.failing ? "warn" : "ok", k.failing ? `Connected · ${k.failing} failing` : "Connected", detail, tips.join(" ")));
    }
  }

  // ---- School data (staff)
  if (role && role !== "learner") {
    const a = st.byArea.school || { pending: 0, stuck: 0 };
    const fresh = newest(index, SCHOOL_PATHS);
    const s = server?.school;
    const facts = [fresh ? `Copies on this device from ${esc(fmtSyncTime(fresh))}` : "",
      s ? `the server has ${plural(s.visits, "visit")} from you${s.lastVisitAt ? `, latest ${esc(fmtSyncTime(s.lastVisitAt))}` : ""}` : ""].filter(Boolean).join(" · ");
    if (a.stuck) out.push(row("school", "School data", "error", `${a.stuck} to check`, facts, "A visit or form couldn't be sent as it is — decide what to do with it below."));
    else if (a.pending) out.push(row("school", "School data", "warn", `${a.pending} pending`, facts, st.online ? "Sending now." : "Saved on this device — sent when you're back online."));
    else out.push(row("school", "School data", fresh ? "ok" : "none", fresh ? "Synced" : "Not on this device yet", facts));
  }

  // ---- Learning activity (learners, teachers)
  if (role === "learner" || perms.has("assignments.grade")) {
    const a = st.byArea.learning || { pending: 0, stuck: 0 };
    const fresh = newest(index, LEARNING_PATHS);
    const l = server?.learning;
    const facts = [fresh ? `Copies on this device from ${esc(fmtSyncTime(fresh))}` : "",
      l?.handedIn != null ? `the server has ${plural(l.handedIn, "piece")} of work from you${l.lastHandedInAt ? `, latest ${esc(fmtSyncTime(l.lastHandedInAt))}` : ""}` : "",
      l?.marked != null ? `the server has your marks for ${plural(l.marked, "piece")} of work${l.lastMarkedAt ? `, latest ${esc(fmtSyncTime(l.lastMarkedAt))}` : ""}` : ""].filter(Boolean).join(" · ");
    if (a.stuck) out.push(row("learning", "Learning activity", "error", `${a.stuck} to check`, facts, "Something changed elsewhere, or was refused — decide below."));
    else if (a.pending) out.push(row("learning", "Learning activity", "warn", `${a.pending} pending`, facts, st.online ? "Sending now." : "Saved on this device — sent when you're back online."));
    else out.push(row("learning", "Learning activity", fresh ? "ok" : "none", fresh ? "Synced" : "Not on this device yet", facts));
  }

  // ---- Content (for those with a library)
  if (role !== "learner" && ![...perms].some((x) => x.startsWith("library."))) return out.join("");
  const lib = index.find((e) => e.path === "/library");
  const c = server?.content;
  const saved = st.savedFiles.length;
  const savedText = saved ? ` · ${plural(saved, "resource")} saved for offline reading` : "";
  if (!lib) out.push(row("content", "Content", "none", "Not on this device yet", `Open the library once while online${savedText}`));
  else if (c && (c.items !== lib.size || (c.latestAt && c.latestAt > lib.savedAt))) {
    out.push(row("content", "Content", "update", "Updates available", `Library list from ${esc(fmtSyncTime(lib.savedAt))}${savedText}`, "Sync now to get the latest list."));
  } else out.push(row("content", "Content", "ok", "Synced", `${lib.size != null ? `${plural(lib.size, "resource")} · ` : ""}list from ${esc(fmtSyncTime(lib.savedAt))}${savedText}`));
  return out.join("");
}

function koboDetailHtml(k, perms) {
  if (!k?.connected) return "";
  let html = "";
  if (k.surveys?.length) {
    html += `<h3>Kobo surveys</h3><div class="lms-table-wrap"><table class="lms-table intel-table">
      <thead><tr><th class="lms-name">Survey</th><th>Last sync</th><th>Received</th><th>Counted</th><th>Need review</th></tr></thead>
      <tbody>${k.surveys.map((f) => `<tr>
        <td class="lms-name">${esc(f.title)}${f.error ? `<br><span class="field-error">${esc(f.error)}${f.lastAttemptAt ? ` (${esc(fmtSyncTime(f.lastAttemptAt))})` : ""}</span>` : ""}</td>
        <td>${f.syncedAt ? esc(fmtSyncTime(f.syncedAt)) : "never"}</td><td>${f.received}</td><td>${f.counted}</td><td>${f.needsReview}</td></tr>`).join("")}</tbody></table></div>
      ${k.surveys.some((f) => /token/i.test(f.error || "")) && perms.has("kobo.configure") ? `<p class="field-hint">Update the API token on <a href="platform.html#kobo">Data &amp; integrations → Kobo</a>.</p>` : ""}
      ${k.surveys.some((f) => f.needsReview) && perms.has("kobo.review") ? `<p class="field-hint">Review flagged submissions on <a href="#kobo">the Kobo page</a> → Data pipeline.</p>` : ""}`;
  }
  if (k.mine) {
    const m = k.mine;
    html += `<h3>Your Kobo submissions</h3>
      <p class="hint">${plural(m.received, "submission")} received · ${m.counted} counted on the dashboards${m.needsReview ? ` · ${m.needsReview} need review` : ""}.</p>
      ${m.surveys.length ? `<ul class="sync-list">${m.surveys.map((s) => `<li class="sync-item"><b>${esc(s.title)}</b><span class="hint-inline"> · ${s.received ? `${plural(s.received, "submission")}${s.lastSubmittedAt ? `, latest ${esc(fmtSyncTime(s.lastSubmittedAt))}` : ""}` : "none from you yet"}${s.needsReview ? ` · ${s.needsReview} need review` : ""}</span></li>`).join("")}</ul>` : ""}
      ${m.issues.length ? `<p><b>Why some need review</b></p><ul class="mel-evidence">${m.issues.map((i) => `<li>${esc(i.message)}${i.count > 1 ? ` <span class="hint-inline">× ${i.count}</span>` : ""}</li>`).join("")}</ul>
        <p class="field-hint">Usually a school name or code Kobo didn't recognise — check it next time, and tell the Education Team which school it was.</p>` : ""}
      <p class="field-hint">Sent something in Kobo Collect that isn't here? It arrives at the next Kobo sync${k.lastSyncedAt ? ` (last: ${esc(fmtSyncTime(k.lastSyncedAt))})` : ""}. If Kobo Collect still shows it under "Ready to send", it hasn't left your phone yet — send it from there with a connection.</p>`;
  }
  return html;
}

function devicesHtml(data, roleFilter) {
  if (!data) return `<div class="empty-state">Loading the field team…</div>`;
  const people = data.people.filter((p) => !roleFilter || p.role === roleFilter);
  if (!people.length) return `<p class="hint">Nobody here yet.</p>`;
  return `<div class="lms-table-wrap"><table class="lms-table intel-table sc-team">
    <thead><tr><th class="lms-name">Who</th><th>Device</th><th>Last sync</th><th>Waiting</th><th class="lms-name">Status</th></tr></thead>
    <tbody>${people.map((p) => {
      const d = p.devices[0];
      return `<tr class="${p.attention && p.devices.length ? "sc-attn" : ""}">
        <td class="lms-name"><b>${esc(p.name)}</b><br><span class="hint-inline">${esc(p.roleLabel)}${p.school ? ` · ${esc(p.school)}` : p.county ? ` · ${esc(p.county)}` : ""}</span></td>
        <td>${d ? `${esc(d.deviceLabel || "Device")}${p.devices.length > 1 ? ` <span class="hint-inline">+${p.devices.length - 1}</span>` : ""}` : "—"}</td>
        <td>${p.lastSyncAt ? esc(fmtSyncTime(p.lastSyncAt)) : "—"}</td>
        <td>${p.pending || "0"}</td>
        <td class="lms-name">${p.attention ? `<span class="${p.devices.length ? "field-error" : "hint-inline"}">${esc(p.attention)}</span>` : `<span class="pill ok">OK</span>`}</td></tr>`;
    }).join("")}</tbody></table></div>
    <p class="field-hint">Each staff device reports after it syncs — counts only, never the work. Someone whose device has work waiting for days may need help getting a connection, or to open the portal once.</p>`;
}

export function openSyncPanel() {
  const busy = { all: false, kobo: false };
  let server = null;
  let devices = null;
  let roleFilter = "field_officer";
  let perms = new Set();
  const panel = openContentPanel({ title: "Sync center", html: `<div class="empty-state">Loading…</div>` }, () => stop());

  let renderSeq = 0;
  const render = async () => {
    const seq = ++renderSeq;
    const st = sync.status();
    const [index, est] = await Promise.all([cacheIndex(sync.currentOwner()), navigator.storage?.estimate?.().catch(() => null)]);
    if (seq !== renderSeq) return;
    const stuck = st.items.filter((i) => i.status === "conflict" || i.status === "failed");
    const waiting = st.items.filter((i) => i.status === "pending" || i.status === "syncing");
    const asOf = !st.online && server?.serverTime ? `<p class="sync-note"><i class="sync-dot" aria-hidden="true"></i> Offline — showing what this device knew at ${esc(fmtSyncTime(server.serverTime))}. Your work is kept and sent when you're back online.</p>` : "";
    panel.innerHTML = `
      <div class="sync-card" data-state="${chipState(st).cls}">
        <div class="sc-head">
          <p class="sync-big"><i class="sync-dot" aria-hidden="true"></i> ${st.online ? "Online" : "Offline"}</p>
          <span class="hint-inline">Last sync ${esc(fmtSyncTime(st.lastSync))}</span>
        </div>
        ${asOf}
        <div class="sc-rows">${rowsHtml({ st, server, perms, index, busy })}</div>
        <button type="button" class="btn btn-primary btn-block" data-act="sync" ${navigator.onLine && !busy.all && !st.syncing ? "" : "disabled"}>${busy.all || st.syncing ? "Syncing…" : "Sync now"}</button>
        ${st.needsSignIn ? `<p class="field-error">Your sign-in has expired. <a href="index.html">Sign in again</a> to send what's waiting — it's kept until then.</p>` : ""}
      </div>
      ${stuck.length ? `<h3>Needs your decision</h3><ul class="sync-list">${stuck.map(itemHtml).join("")}</ul>` : ""}
      <h3>Waiting to sync</h3>
      ${waiting.length ? `<ul class="sync-list">${waiting.map(itemHtml).join("")}</ul>` : `<p class="hint">Nothing — everything done on this device has been sent.</p>`}
      ${koboDetailHtml(server?.kobo, perms)}
      <h3>Saved for offline reading</h3>
      ${st.savedFiles.length ? `<ul class="sync-list">${st.savedFiles.map((f) => `
        <li class="sync-item"><b>${esc(f.title || f.name)}</b><span class="hint-inline"> · ${esc(f.name)} · ${esc(fmtBytes(f.size))}</span>
          <div class="lms-actions"><button type="button" class="btn btn-ghost q-small" data-act="unsave" data-key="${esc(f.key)}">Remove from this device</button></div></li>`).join("")}</ul>`
        : `<p class="hint">Nothing saved yet. Use <b>Save offline</b> on a resource to read it without a connection.</p>`}
      ${perms.has("sync.monitor") ? `
        <div class="panel-head" style="margin-top:1.2rem"><h3 style="margin:0">Field team devices</h3>
          <select data-role-filter aria-label="Whose devices">
            ${[["field_officer", "Field officers"], ["teacher", "Teachers"], ["school_leader", "School heads"], ["", "Everyone"]].map(([v, l]) => `<option value="${v}"${v === roleFilter ? " selected" : ""}>${l}</option>`).join("")}
          </select></div>
        ${st.online ? devicesHtml(devices, roleFilter) : `<p class="hint">Needs a connection.</p>`}` : ""}
      <p class="field-hint" style="margin-top:1rem">This device: ${esc(sync.deviceLabel())} · app ${esc(sync.APP_VERSION)}${est?.usage != null ? ` · using ${esc(fmtBytes(est.usage))}` : ""}.
        Signing out removes this account's offline copies and saved resources from the device — never work that hasn't been sent.</p>`;
  };

  const loadServer = async () => {
    try { server = await apiGet("/sync/status"); } catch { /* offline with no copy yet */ }
  };
  const loadDevices = async () => {
    if (!perms.has("sync.monitor") || !sync.isOnline()) return;
    try { devices = await apiGet("/sync/devices"); } catch { devices = { people: [] }; }
  };

  const stop = sync.onChange(() => render());
  (async () => {
    perms = new Set((await getProfile().catch(() => null))?.permissions || []);
    await render();
    await loadServer();
    await render();
    await loadDevices();
    await render();
  })();

  panel.addEventListener("change", (e) => {
    if (e.target.matches("[data-role-filter]")) { roleFilter = e.target.value; render(); }
  });
  panel.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const id = b.dataset.id;
    try {
      if (b.dataset.act === "sync") {
        busy.all = true; await render();
        const st = await sync.sync({ manual: true });
        let koboNote = "";
        if (perms.has("kobo.manage") && server?.kobo?.connected && sync.isOnline()) {
          busy.kobo = true; await render();
          try {
            const res = await syncKobo();
            koboNote = res.failed?.length ? ` Kobo: ${plural(res.failed.length, "survey")} couldn't sync.` : " Kobo synced.";
          } catch (err) {
            koboNote = ` Kobo: ${err?.message || "couldn't sync"}.`;
          } finally { busy.kobo = false; }
        }
        await loadServer();
        await loadDevices();
        busy.all = false;
        await render();
        toast(st.pending ? "Not everything could be sent" : "Synced",
          `${st.pending ? "The rest goes when the connection is better." : `Last sync ${fmtSyncTime(st.lastSync)}.`}${koboNote}`, st.pending ? "error" : "success");
      } else if (b.dataset.act === "mine") await sync.keepMine(id);
      else if (b.dataset.act === "retry") await sync.retry(id);
      else if (b.dataset.act === "theirs") await sync.discard(id);
      else if (b.dataset.act === "discard") {
        if (await confirmDialog({ title: "Discard this activity?", body: "It's deleted from this device and never sent.", confirmLabel: "Discard", danger: true })) await sync.discard(id);
      } else if (b.dataset.act === "unsave") await sync.removeSavedFile(b.dataset.key);
    } catch (err) {
      busy.all = false; busy.kobo = false;
      render();
      toast("Couldn't do that", err?.message || "", "error");
    }
  });
}
