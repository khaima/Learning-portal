/* ============================================================
   HPF Digital Learning Portal — field officers and their schools.

   Admin › Schools › Field officers: which schools each field officer
   supports, and each school's officers — both ways round. Give an officer
   one school, several, or a whole county; take one away; a school nobody
   supports is flagged. Every change is the officer's data scope
   (PUT /users/:id/scope): what's taken away is ended, never deleted, and
   each change is in the audit log. Their visit form offers only their
   schools, and their dashboards show only them.
   ============================================================ */

import { esc, skeleton, errorState, friendlyError, toast, confirmDialog } from "./util.js";
import { apiGet, apiSend } from "./api.js";
import { kpiCard } from "./kpi.js";
import { openContentPanel, closeViewer } from "./viewer.js";

const plural = (n, w, ws = `${w}s`) => `${Number(n).toLocaleString()} ${n === 1 ? w : ws}`;
const dayOf = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");

let state = { view: "officer", q: "", county: "", only: "" };

/** The page: figures, then officers (or schools) with their assignments. */
export async function renderFieldOfficers(el) {
  el.innerHTML = skeleton(5);
  let d;
  try { d = await apiGet("/field-officers"); } catch (err) {
    el.innerHTML = errorState(friendlyError(err), () => renderFieldOfficers(el));
    return;
  }
  const nobody = d.schools.filter((s) => !s.officers.length);
  const idle = d.officers.filter((o) => !o.covers);
  const visits = d.officers.reduce((t, o) => t + o.visits, 0);
  el.innerHTML = `
    <div class="stat-row">
      ${kpiCard({ label: "Field officers", icon: "pin", value: String(d.officers.length), sub: idle.length ? `${idle.length} with no schools yet` : "each with schools to support", tone: idle.length ? "warn" : "" })}
      ${kpiCard({ label: "Schools supported", icon: "school", value: `${d.schools.length - nobody.length}/${d.schools.length}`, sub: "with at least one field officer" })}
      ${kpiCard({ label: "Schools with nobody", icon: "alert", value: String(nobody.length), tone: nobody.length ? "warn" : "",
        sub: nobody.length ? "no field officer assigned" : "every school has an officer", href: nobody.length ? "#field-officers" : "", attrs: nobody.length ? "data-fo-nobody" : "" })}
      ${kpiCard({ label: "Visits this term", icon: "activity", value: visits.toLocaleString(), sub: d.term || "this term" })}
    </div>
    <div class="filter-bar-row fo-filters">
      <div class="field"><label for="fo_q">Find</label><input id="fo_q" type="search" placeholder="An officer or a school…" value="${esc(state.q)}"></div>
      <div class="field"><label for="fo_county">County</label><select id="fo_county"><option value="">All counties</option>${
        d.counties.map((c) => `<option${c === state.county ? " selected" : ""}>${esc(c)}</option>`).join("")}</select></div>
      <div class="field"><label for="fo_view">Show</label><select id="fo_view">
        <option value="officer"${state.view === "officer" ? " selected" : ""}>By field officer</option>
        <option value="school"${state.view === "school" && !state.only ? " selected" : ""}>By school</option>
        <option value="nobody"${state.only ? " selected" : ""}>Schools with nobody</option></select></div>
    </div>
    <div data-fo-list></div>`;
  const list = el.querySelector("[data-fo-list]");
  const draw = () => { list.innerHTML = state.view === "officer" ? officersHtml(d) : schoolsHtml(d); };
  draw();
  el.querySelector("#fo_q").addEventListener("input", (e) => { state.q = e.target.value; draw(); });
  el.querySelector("#fo_county").addEventListener("change", (e) => { state.county = e.target.value; draw(); });
  el.querySelector("#fo_view").addEventListener("change", (e) => {
    state.only = e.target.value === "nobody" ? "nobody" : "";
    state.view = e.target.value === "officer" ? "officer" : "school";
    draw();
  });
  el.querySelector("[data-fo-nobody]")?.addEventListener("click", (e) => {
    e.preventDefault();
    Object.assign(state, { view: "school", only: "nobody" });
    el.querySelector("#fo_view").value = "nobody";
    draw();
  });
  const again = () => renderFieldOfficers(el);
  list.addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const officer = (id) => d.officers.find((o) => o.id === id);
    if (b.dataset.assign) openOfficerSchools(officer(b.dataset.assign), d, again);
    else if (b.dataset.addOfficer) openSchoolOfficers(d.schools.find((s) => s.id === b.dataset.addOfficer), d, again);
    else if (b.dataset.unassign) {
      const o = officer(b.dataset.unassign);
      const [kind, value] = [b.dataset.kind, b.dataset.value];
      const what = kind === "county" ? `all of ${value} County` : d.schools.find((s) => s.id === value)?.name || "this school";
      if (!(await confirmDialog({ title: `Take ${what} away from ${o.name}?`, body: "They stop seeing it on their dashboards and visit form. Their visits stay on record.", confirmLabel: "Take it away", danger: true }))) return;
      const next = { counties: o.counties.filter((c) => !(kind === "county" && c === value)), schoolIds: o.schools.map((s) => s.id).filter((id) => !(kind === "school" && id === value)) };
      if (await saveScope(o, next)) again();
    }
  });
}

const matches = (text) => !state.q || String(text).toLowerCase().includes(state.q.trim().toLowerCase());

function officersHtml(d) {
  const rows = d.officers.filter((o) => (matches(o.name) || o.schools.some((s) => matches(s.name)) || o.counties.some(matches))
    && (!state.county || o.counties.includes(state.county) || o.schools.some((s) => s.county === state.county) || o.homeCounty === state.county));
  if (!rows.length) return `<div class="empty-state">${d.officers.length ? "No field officer matches." : "No field officers yet — invite them on Users › Accounts."}</div>`;
  return `<div class="fo-list">${rows.map((o) => `
    <div class="fo-row">
      <div class="fo-who"><b>${esc(o.name)}</b>
        <span>${esc([o.homeCounty, plural(o.covers, "school"), `${o.visits} visit${o.visits === 1 ? "" : "s"} this term`, o.lastVisit ? `last ${dayOf(o.lastVisit)}` : "no visits yet"].filter(Boolean).join(" · "))}</span></div>
      <div class="fo-chips">${o.counties.map((c) => chip(`All of ${c} County`, o.canEdit && { officer: o.id, kind: "county", value: c }, "is-county")).join("")}${
        o.schools.map((s) => chip(s.name, o.canEdit && { officer: o.id, kind: "school", value: s.id })).join("")}${
        o.counties.length || o.schools.length ? "" : `<span class="pill warm">No schools yet</span>`}</div>
      ${o.canEdit ? `<div class="fo-act"><button type="button" class="btn btn-outline q-small" data-assign="${esc(o.id)}">Assign schools</button></div>` : ""}
    </div>`).join("")}</div>`;
}

function schoolsHtml(d) {
  const rows = d.schools.filter((s) => (matches(s.name) || matches(s.code) || s.officers.some((o) => matches(o.name)))
    && (!state.county || s.county === state.county) && (!state.only || !s.officers.length));
  if (!rows.length) return `<div class="empty-state">${state.only ? "Every school here has a field officer." : "No school matches."}</div>`;
  const editable = d.officers.some((o) => o.canEdit);
  return `<div class="fo-list">${rows.map((s) => `
    <div class="fo-row">
      <div class="fo-who"><b>${esc(s.name)}</b><span>${esc([s.code, s.county, `${s.visits} visit${s.visits === 1 ? "" : "s"} this term`].filter(Boolean).join(" · "))}</span></div>
      <div class="fo-chips">${s.officers.length ? s.officers.map((o) => {
        const can = d.officers.find((x) => x.id === o.id)?.canEdit;
        return o.via === "county" ? chip(`${o.name} · whole county`, null, "is-county") : chip(o.name, can && { officer: o.id, kind: "school", value: s.id });
      }).join("") : `<span class="pill danger">Nobody yet</span>`}</div>
      ${editable ? `<div class="fo-act"><button type="button" class="btn btn-outline q-small" data-add-officer="${esc(s.id)}">Assign officer</button></div>` : ""}
    </div>`).join("")}</div>`;
}

/** An assignment as a chip; `remove` makes it one tap to take away. */
function chip(label, remove, cls = "") {
  return `<span class="fo-chip ${cls}">${esc(label)}${remove ? `<button type="button" class="fo-x" data-unassign="${esc(remove.officer)}" data-kind="${remove.kind}" data-value="${esc(remove.value)}" aria-label="${esc(`Take away ${label}`)}">✕</button>` : ""}</span>`;
}

/** Saves an officer's whole list of counties and schools; says what changed. */
async function saveScope(o, { counties, schoolIds }) {
  try {
    const res = await apiSend("PUT", `/users/${encodeURIComponent(o.id)}/scope`, { counties, schoolIds });
    toast("Saved", res.added || res.ended ? `${o.name}: ${[res.added ? `${res.added} added` : "", res.ended ? `${res.ended} taken away` : ""].filter(Boolean).join(", ")}.` : "Nothing changed.", "success");
    return true;
  } catch (err) {
    toast("Couldn't save", friendlyError(err), "error");
    return false;
  }
}

/** One officer: tick the schools (or whole counties) they support. */
function openOfficerSchools(o, d, onDone) {
  const counties = new Set(o.counties);
  const schools = new Set(o.schools.map((s) => s.id));
  const panel = openContentPanel({ title: `Schools for ${o.name}`, html: "" });
  const byCounty = d.counties.map((c) => [c, d.schools.filter((s) => s.county === c)]);
  panel.innerHTML = `
    <p class="hint" style="margin-top:0">Tick one school or several. A whole county includes its schools — and any added to it later.</p>
    <input type="search" class="fo-find" data-find placeholder="Find a school…" aria-label="Find a school">
    <form data-pick>${byCounty.map(([c, list]) => `
      <fieldset class="fo-county" data-county="${esc(c)}">
        <legend><label><input type="checkbox" data-whole="${esc(c)}"${counties.has(c) ? " checked" : ""}> <b>All of ${esc(c)} County</b> <span class="hint-inline">${plural(list.length, "school")}</span></label></legend>
        ${list.map((s) => `<label class="fo-pick" data-name="${esc(s.name.toLowerCase())}"><input type="checkbox" data-school="${esc(s.id)}"${schools.has(s.id) || counties.has(c) ? " checked" : ""}${counties.has(c) ? " disabled" : ""}>
          <span>${esc(s.name)}<small>${esc(s.code || "")}${s.officers.filter((x) => x.id !== o.id).length ? ` · also ${esc(s.officers.filter((x) => x.id !== o.id).map((x) => x.name).join(", "))}` : ""}</small></span></label>`).join("")}
      </fieldset>`).join("")}
      <div class="lms-actions fo-save"><span class="hint-inline" data-count></span><button type="submit" class="btn btn-primary">Save</button><button type="button" class="btn btn-ghost" data-cancel>Cancel</button></div>
    </form>`;
  const form = panel.querySelector("[data-pick]");
  const count = () => {
    const n = d.schools.filter((s) => counties.has(s.county) || schools.has(s.id)).length;
    panel.querySelector("[data-count]").textContent = `${plural(n, "school")}`;
  };
  count();
  form.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.whole) {
      const c = t.dataset.whole;
      if (t.checked) counties.add(c); else counties.delete(c);
      for (const box of form.querySelectorAll(`[data-county="${CSS.escape(c)}"] [data-school]`)) {
        box.disabled = t.checked;
        box.checked = t.checked || schools.has(box.dataset.school);
      }
    } else if (t.dataset.school) {
      if (t.checked) schools.add(t.dataset.school); else schools.delete(t.dataset.school);
    }
    count();
  });
  panel.querySelector("[data-find]").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    for (const row of form.querySelectorAll(".fo-pick")) row.hidden = !!q && !row.dataset.name.includes(q);
  });
  panel.querySelector("[data-cancel]").addEventListener("click", () => closeViewer());
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    // A school inside a whole county isn't kept on its own as well.
    const schoolIds = [...schools].filter((id) => !counties.has(d.schools.find((s) => s.id === id)?.county));
    const before = d.schools.filter((s) => o.counties.includes(s.county) || o.schools.some((x) => x.id === s.id)).length;
    const after = d.schools.filter((s) => counties.has(s.county) || schools.has(s.id)).length;
    if (after < before && !(await confirmDialog({ title: `${plural(before - after, "school")} fewer for ${o.name}?`, body: "They stop seeing the schools taken away. Their visits stay on record.", confirmLabel: "Save" }))) return;
    form.querySelector("[type=submit]").disabled = true;
    if (await saveScope(o, { counties: [...counties], schoolIds })) { closeViewer(); onDone(); }
    else form.querySelector("[type=submit]").disabled = false;
  });
}

/** One school: tick the field officers who support it. */
function openSchoolOfficers(s, d, onDone) {
  const panel = openContentPanel({ title: `Field officers for ${s.name}`, html: "" });
  const officers = d.officers.filter((o) => o.canEdit);
  const has = new Set(s.officers.filter((o) => o.via === "school").map((o) => o.id));
  const viaCounty = new Set(s.officers.filter((o) => o.via === "county").map((o) => o.id));
  panel.innerHTML = officers.length ? `
    <p class="hint" style="margin-top:0">${esc(s.county)} · tick one officer or several.</p>
    <form data-pick>${officers.map((o) => `<label class="fo-pick"><input type="checkbox" data-officer="${esc(o.id)}"${has.has(o.id) || viaCounty.has(o.id) ? " checked" : ""}${viaCounty.has(o.id) ? " disabled" : ""}>
        <span>${esc(o.name)}<small>${viaCounty.has(o.id) ? `has all of ${esc(s.county)} County` : esc([o.homeCounty, plural(o.covers, "school")].filter(Boolean).join(" · "))}</small></span></label>`).join("")}
      <div class="lms-actions fo-save"><button type="submit" class="btn btn-primary">Save</button><button type="button" class="btn btn-ghost" data-cancel>Cancel</button></div>
    </form>` : `<div class="empty-state">No field officers you can assign.</div>`;
  panel.querySelector("[data-cancel]")?.addEventListener("click", () => closeViewer());
  panel.querySelector("[data-pick]")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const want = new Set([...e.target.querySelectorAll("[data-officer]:checked:not(:disabled)")].map((x) => x.dataset.officer));
    const changes = officers.filter((o) => !viaCounty.has(o.id) && want.has(o.id) !== has.has(o.id));
    if (!changes.length) { closeViewer(); return; }
    const off = changes.filter((o) => !want.has(o.id));
    if (off.length && !(await confirmDialog({ title: `Take ${s.name} away from ${off.map((o) => o.name).join(", ")}?`, body: "Their visits stay on record.", confirmLabel: "Save" }))) return;
    e.target.querySelector("[type=submit]").disabled = true;
    let ok = true;
    for (const o of changes) {
      const schoolIds = want.has(o.id) ? [...new Set([...o.schools.map((x) => x.id), s.id])] : o.schools.map((x) => x.id).filter((id) => id !== s.id);
      ok = (await saveScope(o, { counties: o.counties, schoolIds })) && ok;
    }
    closeViewer();
    onDone();
    if (!ok) toast("Some changes weren't saved", "Check the list and try again.", "error");
  });
}
