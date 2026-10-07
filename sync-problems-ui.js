/* ============================================================
   HPF Digital Learning Portal — stuck devices (GET /sync/problems).

   Work done without a connection waits on the device until it syncs.
   This page lists the devices — staff phones and laptops, learners'
   tablets — that have had something unsent for 48 hours or more: waiting
   for a connection, refused by the server, or in conflict with a change
   made elsewhere. It's as of each device's last report, so one that has
   gone quiet stays on the list (that's usually the one to chase). Below:
   the last 7 days' sync failures and conflicts, and what people chose.

   Only within the viewer's own scope (the API decides). Loaded the first
   time the page opens (console.js).
   ============================================================ */
import { apiGet } from "./api.js";
import { esc, skeleton, errorState, friendlyError } from "./util.js";
import { fmtSyncTime } from "./sync-ui.js";

const KIND = { "learner-work": "Learner work", mark: "Marking", reading: "Reading time", "field-visit": "Field visit", "form-response": "Form response" };
const EVENT = {
  failed: ["Refused", "danger"], conflict: ["Conflict", "warm"],
  kept_mine: ["Kept their version", ""], retried: ["Tried again", ""], discarded: ["Discarded", ""],
};
const HOURS = [[24, "1 day"], [48, "2 days"], [72, "3 days"], [168, "a week"]];

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
function ago(iso) {
  if (!iso) return "never";
  const h = (Date.now() - Date.parse(iso)) / 3600e3;
  if (h < 1) return "just now";
  if (h < 48) return `${Math.floor(h)} h ago`;
  return `${Math.floor(h / 24)} days ago`;
}
const when = (iso) => new Date(iso).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
function waitingHtml(d) {
  const parts = [];
  if (d.pending) parts.push(`<span class="pill">${esc(plural(d.pending, "waiting", "waiting"))}</span>`);
  if (d.failed) parts.push(`<span class="pill danger">${esc(plural(d.failed, "refused", "refused"))}</span>`);
  if (d.conflicts) parts.push(`<span class="pill warm">${esc(plural(d.conflicts, "conflict"))}</span>`);
  return parts.join(" ");
}
function since(hours) {
  return hours >= 48 ? `${Math.floor(hours / 24)} days` : `${hours} h`;
}

function stuckHtml(d) {
  if (!d.stuck.length) {
    return `<div class="empty-state"><b>No device has work stuck for ${esc(HOURS.find(([h]) => h === d.hours)?.[1] ?? `${d.hours} hours`)} or more.</b>
      <div>Devices report after each sync; anything unsent for longer would show here.</div></div>`;
  }
  return `<div class="lms-table-wrap"><table class="lms-table intel-table">
    <thead><tr><th class="lms-name">Who</th><th class="lms-name">Device</th><th>Unsent</th><th>Waiting for</th><th>Last heard from</th><th class="lms-name">Latest problem</th></tr></thead>
    <tbody>${d.stuck.map((x) => `<tr>
      <td class="lms-name"><b>${esc(x.name)}</b><br><span class="hint-inline">${esc(x.roleLabel)}${x.school ? ` · ${esc(x.school)}` : ""}${x.county ? ` · ${esc(x.county)}` : ""}</span></td>
      <td class="lms-name">${esc(x.deviceLabel || "A device")}<br><span class="hint-inline">app ${esc(x.appVersion || "unknown")}</span></td>
      <td>${waitingHtml(x)}</td>
      <td><b>${esc(since(x.waitingHours))}</b><br><span class="hint-inline">since ${esc(when(x.waitingSince))}</span></td>
      <td>${esc(ago(x.reportedAt))}${x.lastSyncAt ? `<br><span class="hint-inline">last full sync ${esc(ago(x.lastSyncAt))}</span>` : ""}</td>
      <td class="lms-name">${x.lastEvent ? `<span class="pill ${EVENT[x.lastEvent.event]?.[1] ?? ""}">${esc(EVENT[x.lastEvent.event]?.[0] ?? x.lastEvent.event)}</span> ${esc(x.lastEvent.message || "")}`
        : `<span class="hint-inline">${x.pending && !x.failed && !x.conflicts ? "Waiting for a connection" : "—"}</span>`}</td>
    </tr>`).join("")}</tbody></table></div>`;
}

function eventsHtml(d) {
  const chips = Object.entries(EVENT).map(([k, [label, tone]]) => `<span class="pill ${tone}">${esc(label)}: ${d.summary[k] ?? 0}</span>`).join(" ");
  if (!d.events.length) return `<p class="hint">${chips}</p><div class="empty-state">No sync failures or conflicts in the last 7 days.</div>`;
  return `<p class="hint">${chips}</p>
    <div class="lms-table-wrap"><table class="lms-table intel-table">
    <thead><tr><th>When</th><th class="lms-name">Who</th><th class="lms-name">What</th><th class="lms-name">The server said</th></tr></thead>
    <tbody>${d.events.map((e) => `<tr>
      <td>${esc(when(e.at))}</td>
      <td class="lms-name">${esc(e.name)}<br><span class="hint-inline">${esc(e.roleLabel)}${e.school ? ` · ${esc(e.school)}` : ""}</span></td>
      <td class="lms-name"><span class="pill ${EVENT[e.event]?.[1] ?? ""}">${esc(EVENT[e.event]?.[0] ?? e.event)}</span> ${esc(KIND[e.kind] || e.kind || "Activity")}
        ${e.itemCreatedAt ? `<br><span class="hint-inline">done on the device ${esc(when(e.itemCreatedAt))}${e.attempts ? ` · ${esc(plural(e.attempts, "try", "tries"))}` : ""}</span>` : ""}</td>
      <td class="lms-name">${e.message ? esc(e.message) : `<span class="hint-inline">—</span>`}${e.status ? ` <span class="hint-inline">(${esc(e.status)})</span>` : ""}</td>
    </tr>`).join("")}</tbody></table></div>`;
}

/* Every staff device, last sync and what's waiting (sync.monitor) — moved here
   from the Sync center, which is now about the person's own device. */
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

/** Draws the page into `el`; `hours` is the threshold (48 by default). */
export async function renderSyncProblems(el, { hours = 48, perms = new Set() } = {}) {
  el.innerHTML = `
    <div class="panel">
      <div class="panel-head"><h2>Stuck devices</h2>
        <span class="dq-head-actions">
          <label class="hint-inline" for="spbHours">Unsent for</label>
          <select id="spbHours">${HOURS.map(([h, l]) => `<option value="${h}"${h === hours ? " selected" : ""}>${l} or more</option>`).join("")}</select>
          <button type="button" class="btn btn-outline q-small" id="spbRefresh">Refresh</button></span></div>
      <p class="hint" style="margin-top:0">Work done offline waits on the device until it syncs. These devices have had something unsent for longer than this — waiting for a connection, refused by the server, or in conflict with a change made elsewhere. As of each device's last report: one that has gone quiet stays here.</p>
      <div id="spbStuck">${skeleton(3, { avatar: false })}</div>
    </div>
    ${perms.has("sync.monitor") ? `<div class="panel">
      <div class="panel-head"><h2>Every device</h2>
        <span class="dq-head-actions"><label class="hint-inline" for="spbRole">Whose</label>
          <select id="spbRole">${[["field_officer", "Field officers"], ["teacher", "Teachers"], ["school_leader", "School heads"], ["", "Everyone"]]
            .map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></span></div>
      <div id="spbDevices">${skeleton(3, { avatar: false })}</div>
    </div>` : ""}
    <div class="panel">
      <div class="panel-head"><h2>Sync failures and conflicts</h2><span class="chart-meta" style="margin:0">Last 7 days</span></div>
      <p class="hint" style="margin-top:0">What the server refused or found in conflict when a device synced, and what the person then chose. Nothing here can be changed or deleted.</p>
      <div id="spbEvents">${skeleton(3, { avatar: false })}</div>
    </div>`;
  const load = async () => {
    const h = Number(el.querySelector("#spbHours").value) || 48;
    let d;
    try {
      d = await apiGet(`/sync/problems?hours=${h}`);
    } catch (err) {
      el.querySelector("#spbStuck").innerHTML = errorState(friendlyError(err), load);
      el.querySelector("#spbEvents").innerHTML = "";
      return;
    }
    el.querySelector("#spbStuck").innerHTML = stuckHtml(d);
    el.querySelector("#spbEvents").innerHTML = eventsHtml(d);
  };
  let devices = null;
  const drawDevices = () => { const box = el.querySelector("#spbDevices"); if (box) box.innerHTML = devicesHtml(devices, el.querySelector("#spbRole").value); };
  const loadDevices = async () => {
    if (!perms.has("sync.monitor")) return;
    try { devices = await apiGet("/sync/devices"); } catch (err) {
      el.querySelector("#spbDevices").innerHTML = errorState(friendlyError(err), loadDevices);
      return;
    }
    drawDevices();
  };
  el.querySelector("#spbRole")?.addEventListener("change", drawDevices);
  el.querySelector("#spbHours").addEventListener("change", load);
  el.querySelector("#spbRefresh").addEventListener("click", () => { load(); loadDevices(); });
  await Promise.all([load(), loadDevices()]);
}
