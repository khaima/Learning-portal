/* ============================================================
   HPF Digital Learning Portal — Change history.

   Every record added, edited or deleted: who did it (name and role), when,
   where, and what it was before and after (GET /changes; the API's
   history.ts, written by the database's own trigger so nothing is missed).
   The Super Admin sees every change in the portal; the Programme Admin,
   learning and education records in their area.

   A deleted record can be put back, and an edit undone, by the Super Admin
   or by whoever manages that kind of record — with anything the same action
   deleted alongside it. Doing so is itself in the history. What can't be put
   back from here says where it's changed instead.
   ============================================================ */

import { esc, skeleton, errorState, friendlyError, toast, confirmDialog, emptyState, filteredEmpty } from "./util.js";
import { apiGet, apiSend } from "./api.js";

const ROLES = [
  ["super_admin", "Super Admin"], ["education_team", "Programme Admin (Education Team)"], ["me", "M&E"],
  ["field_officer", "Field Officer"], ["school_leader", "School Head"], ["teacher", "Teacher"], ["learner", "Learner"],
];
const SHOW = [["", "All changes"], ["insert", "Added"], ["update", "Edited"], ["delete", "Deleted"], ["deleted", "Deleted, not put back yet"]];
const ACTION = {
  added: { label: "Added", tone: "ok" }, edited: { label: "Edited", tone: "warm" }, deleted: { label: "Deleted", tone: "danger" },
  restored: { label: "Put back", tone: "ok" }, undone: { label: "Undone", tone: "" },
};

const state = { show: "", table: "", actorId: "", role: "", from: "", to: "" };
let filters = null; // kinds and people, from the first page

const when = (iso) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
/** A value as people read it: dates and times in local time. */
function shown(v) {
  if (v == null) return "—";
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) && !Number.isNaN(Date.parse(s))) return when(s);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  return s;
}

function who(e) {
  const a = e.actor;
  if (a.kind === "database") return "made directly in the database, outside the portal";
  if (a.kind === "system") return "by the portal itself (an automatic job)";
  const name = a.name || (a.kind === "learner" ? "a learner" : "a staff member no longer on the portal");
  return `by <b>${esc(name)}</b>${a.roleLabel ? ` <span class="ch-role">${esc(a.roleLabel)}</span>` : ""}`;
}
const where = (p) => [p.school, p.county ? `${p.county} County` : ""].filter(Boolean).join(", ");

function fieldsHtml(e) {
  if (!e.fields.length && !e.hidden.length) return "";
  const li = e.fields.map((f) => {
    if (e.op === "update") return `<li><span class="ch-f">${esc(f.label)}</span> <del>${esc(shown(f.before))}</del> <span aria-hidden="true">→</span><span class="sr-only">changed to</span> <ins>${esc(shown(f.after))}</ins></li>`;
    return `<li><span class="ch-f">${esc(f.label)}</span> ${esc(shown(e.op === "insert" ? f.after : f.before))}</li>`;
  });
  if (e.hidden.length) li.push(`<li><span class="ch-f">${esc(e.hidden.join(", "))}</span> changed <span class="hint-inline">(never shown)</span></li>`);
  return `<ul class="ch-fields">${li.join("")}</ul>`;
}

function actsHtml(e, canPutBack) {
  const pb = e.putBack;
  const parts = [`<button type="button" class="link-btn" data-ch-detail aria-expanded="false">Details</button>`];
  if (pb.action && canPutBack) {
    if (pb.can) parts.push(`<button type="button" class="btn btn-outline q-small" data-ch-put="${pb.action}">${pb.action === "restore" ? "Put back" : "Undo this edit"}</button>`);
  }
  return `<div class="ch-acts">${parts.join("")}</div>`;
}

function rowHtml(e, canPutBack) {
  const a = ACTION[e.action] || ACTION.edited;
  const place = where(e.place);
  return `<article class="ch-row" data-id="${e.id}">
    <div class="ch-main">
      <div class="ch-head"><span class="pill ${a.tone}">${a.label}</span> <span class="ch-kind">${esc(e.kind)}</span> <b class="ch-name">${esc(e.record.name)}</b></div>
      <div class="ch-who">${who(e)}${place ? ` · ${esc(place)}` : ""}</div>
      ${fieldsHtml(e)}
      ${e.together ? `<p class="ch-also">And ${e.together.toLocaleString()} more ${e.together === 1 ? "change" : "changes"} made by the same action — see Details.</p>` : ""}
      ${e.backAgain ? `<p class="ch-back">Put back${e.backAgain.by ? ` by ${esc(e.backAgain.by)}` : ""} on ${esc(when(e.backAgain.at))}.</p>` : ""}
      <div class="ch-detail" hidden></div>
    </div>
    <div class="ch-side">
      <time datetime="${esc(e.at)}">${esc(when(e.at))}</time>
      ${actsHtml(e, canPutBack)}
    </div>
  </article>`;
}

function filtersHtml() {
  const opt = (v, label, cur) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(label)}</option>`;
  return `<div class="filter-bar-row ch-filters">
    <div class="field"><label for="ch_show">Show</label><select id="ch_show">${SHOW.map(([v, l]) => opt(v, l, state.show)).join("")}</select></div>
    <div class="field"><label for="ch_table">Kind of record</label><select id="ch_table">${opt("", "All kinds", state.table)}${
      (filters?.kinds || []).map((k) => opt(k.table, k.label, state.table)).join("")}</select></div>
    <div class="field"><label for="ch_actor">Who</label><select id="ch_actor">${opt("", "Anyone", state.actorId)}${
      (filters?.people || []).map((p) => opt(p.id, p.name, state.actorId)).join("")}</select></div>
    <div class="field"><label for="ch_role">Their role</label><select id="ch_role">${opt("", "Any role", state.role)}${ROLES.map(([v, l]) => opt(v, l, state.role)).join("")}</select></div>
    <div class="field"><label for="ch_from">From</label><input id="ch_from" type="date" value="${esc(state.from)}"></div>
    <div class="field"><label for="ch_to">To</label><input id="ch_to" type="date" value="${esc(state.to)}"></div>
    <button type="button" class="link-btn" data-ch-clear${Object.values(state).some(Boolean) ? "" : " hidden"}>Clear filters</button>
  </div>
  <p class="chart-meta ch-summary" data-ch-summary></p>
  <div class="ch-list" data-ch-list></div>
  <button type="button" class="btn btn-outline" data-ch-more hidden>Load older changes</button>`;
}

function query(before) {
  const p = new URLSearchParams();
  if (state.show === "deleted") p.set("show", "deleted");
  else if (state.show) p.set("op", state.show);
  for (const k of ["table", "actorId", "role", "from", "to"]) if (state[k]) p.set(k, state[k]);
  if (before) p.set("before", before);
  return p.toString();
}

/** The page. `scopeEl` shows what this person's history covers. */
export async function renderChanges(el, { scopeEl } = {}) {
  if (!el.querySelector("[data-ch-list]")) {
    el.innerHTML = skeleton(5, { avatar: false });
    let first;
    try { first = await apiGet(`/changes?${query()}`); } catch (err) {
      el.innerHTML = errorState(friendlyError(err), () => renderChanges(el, { scopeEl }));
      return;
    }
    filters = first.filters || filters;
    el.innerHTML = filtersHtml();
    wire(el, scopeEl);
    show(el, first, { scopeEl });
    return;
  }
  await reload(el, scopeEl);
}

let run = 0;
let nextBefore = null;
let canPutBack = false;
async function reload(el, scopeEl, { more = false } = {}) {
  const list = el.querySelector("[data-ch-list]");
  const mine = ++run;
  if (!more) list.innerHTML = skeleton(4, { avatar: false });
  let res;
  try { res = await apiGet(`/changes?${query(more ? nextBefore : "")}`); } catch (err) {
    if (mine !== run) return;
    if (more) { toast("Couldn't load older changes", friendlyError(err), "error"); return; }
    list.innerHTML = errorState(friendlyError(err), () => reload(el, scopeEl));
    return;
  }
  if (mine !== run) return; // the filters changed while this was being read
  show(el, res, { more, scopeEl });
}

function show(el, res, { more = false, scopeEl } = {}) {
  const list = el.querySelector("[data-ch-list]");
  canPutBack = !!res.canPutBack;
  nextBefore = res.nextBefore;
  if (scopeEl) scopeEl.textContent = res.scope || "";
  const html = res.entries.map((e) => rowHtml(e, canPutBack)).join("");
  if (more) list.insertAdjacentHTML("beforeend", html);
  else {
    const filtered = Object.values(state).some(Boolean);
    list.innerHTML = html || (filtered ? filteredEmpty() : emptyState("No changes recorded yet.", "Each record added, edited or deleted appears here, with who did it."));
  }
  const n = list.querySelectorAll(".ch-row").length;
  el.querySelector("[data-ch-summary]").textContent = n
    ? `${n.toLocaleString()} ${n === 1 ? "change" : "changes"} shown, newest first${nextBefore ? " — older ones below" : ""}.`
    : "";
  el.querySelector("[data-ch-more]").hidden = !nextBefore;
}

function wire(el, scopeEl) {
  const set = (k, v) => {
    state[k] = v;
    el.querySelector("[data-ch-clear]").hidden = !Object.values(state).some(Boolean);
    reload(el, scopeEl);
  };
  for (const [id, k] of [["ch_show", "show"], ["ch_table", "table"], ["ch_actor", "actorId"], ["ch_role", "role"], ["ch_from", "from"], ["ch_to", "to"]]) {
    el.querySelector(`#${id}`).addEventListener("change", (e) => set(k, e.target.value));
  }
  el.querySelector("[data-ch-clear]").addEventListener("click", () => {
    for (const k of Object.keys(state)) state[k] = "";
    for (const f of el.querySelectorAll(".ch-filters select, .ch-filters input")) f.value = "";
    set("show", "");
  });
  el.querySelector("[data-ch-more]").addEventListener("click", () => reload(el, scopeEl, { more: true }));
  el.querySelector("[data-ch-list]").addEventListener("click", async (ev) => {
    const row = ev.target.closest(".ch-row");
    if (!row) return;
    if (ev.target.closest("[data-ch-detail]")) toggleDetail(row, ev.target.closest("[data-ch-detail]"));
    const put = ev.target.closest("[data-ch-put]");
    if (put) putBack(row, put, el, scopeEl);
  });
}

async function toggleDetail(row, btn) {
  const box = row.querySelector(".ch-detail");
  const open = box.hidden;
  box.hidden = !open;
  btn.setAttribute("aria-expanded", String(open));
  btn.textContent = open ? "Hide details" : "Details";
  if (!open || box.dataset.loaded) return;
  box.innerHTML = skeleton(2, { avatar: false });
  try {
    const d = await apiGet(`/changes/${row.dataset.id}`);
    const e = d.entry;
    const cols = e.op === "update" ? ["Field", "Before", "After"] : e.op === "insert" ? ["Field", "Added as"] : ["Field", "When it was deleted"];
    const rows = d.fields.map((f) => `<tr${f.changed && e.op === "update" ? ' class="is-changed"' : ""}><th scope="row">${esc(f.label)}</th>${
      e.op === "update" ? `<td class="wrap">${esc(shown(f.before))}</td><td class="wrap">${esc(shown(f.after))}</td>` : `<td class="wrap">${esc(shown(e.op === "insert" ? f.after : f.before))}</td>`}</tr>`).join("");
    const extra = (d.togetherCount || 0) - d.together.length;
    const together = d.together.length
      ? `<p class="ch-together-head">Done in the same action</p><ul class="ch-together">${d.together.map((t) =>
          `<li><span class="pill ${(ACTION[t.action] || ACTION.edited).tone}">${(ACTION[t.action] || ACTION.edited).label}</span> ${esc(t.kind)} · ${esc(t.record.name)}${
            t.op === "update" && t.fields.length ? ` <span class="hint-inline">(${esc(t.fields.map((f) => f.label).join(", "))})</span>` : ""}</li>`).join("")}${
          extra > 0 ? `<li class="hint-inline">and ${extra.toLocaleString()} more</li>` : ""}</ul>`
      : "";
    const pb = e.putBack;
    const why = pb.action && !pb.can && pb.why ? `<p class="ch-why">${pb.action === "restore" ? "Not put back from here" : "Not undone from here"}: ${esc(pb.why)}</p>` : "";
    box.innerHTML = `<div class="lms-table-wrap ch-table"><table class="lms-table"><thead><tr>${cols.map((c) => `<th scope="col">${c}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>
      ${e.hidden.length ? `<p class="hint-inline">${esc(e.hidden.join(", "))} changed too — never shown.</p>` : ""}${why}${together}`;
    box.dataset.loaded = "1";
  } catch (err) {
    box.innerHTML = `<p class="field-error">${esc(friendlyError(err))}</p>`;
  }
}

async function putBack(row, btn, el, scopeEl) {
  const action = btn.dataset.chPut;
  const name = row.querySelector(".ch-name")?.textContent || "this record";
  const kind = row.querySelector(".ch-kind")?.textContent || "Record";
  const ok = await confirmDialog(action === "restore"
    ? { title: `Put back ${kind.toLowerCase()} “${name}”?`, confirmLabel: "Put it back",
        body: "It comes back as it was when it was deleted, with anything the same action deleted alongside it. The history will show that you put it back." }
    : { title: `Undo this edit to “${name}”?`, confirmLabel: "Undo the edit",
        body: "The fields this edit changed go back to what they were before it. The history will show that you undid it." });
  if (!ok) return;
  btn.disabled = true;
  try {
    const res = await apiSend("POST", `/changes/${row.dataset.id}/${action}`, {});
    if (action === "restore") {
      const extra = (res.restored > 1 ? ` ${res.restored - 1} more deleted with it came back too.` : "") + (res.relinked ? ` ${res.relinked} linked ${res.relinked === 1 ? "record was" : "records were"} reconnected.` : "");
      toast("Put back", `${kind} “${name}” is back.${extra}`, "success");
    } else {
      toast("Edit undone", `${(res.fields || []).join(", ") || "The fields"} on “${name}” are as they were before.`, "success");
    }
    reload(el, scopeEl);
  } catch (err) {
    btn.disabled = false;
    toast(action === "restore" ? "Not put back" : "Not undone", friendlyError(err), "error");
  }
}
