/* ============================================================
   HPF Digital Learning Portal — class attendance: the daily register.

   The teacher's register — pick a class and a day, mark each learner
   present, late or absent (with a reason when the school accepts it),
   save; online or offline, corrected any time — and what the registers
   add up to: a class's term, a school's, the day's registers at a glance.

   The API (attendance.ts) works out every figure and decides who may see
   and change what; these are only the screens.
   ============================================================ */

import { esc, toast, friendlyError, skeleton, errorState, confirmDialog, emptyState } from "./util.js";
import { getRegister, saveRegister, getAttendanceSummary, getAttendanceToday } from "./store.js";
import { barList, lineChart, periodChip } from "./charts.js";
import { kpiCard } from "./kpi.js";
import { openContentPanel } from "./viewer.js";

const STATUS = { present: "Present", late: "Late", absent: "Absent", excused: "Excused" };
const REASON = { sick: "Sick", family: "Family", permission: "With permission", other: "Other reason" };
const pct = (v) => (v == null ? "—" : `${Math.round(v)}%`);
const plural = (n, w, ws = `${w}s`) => `${Number(n).toLocaleString()} ${n === 1 ? w : ws}`;
const dayName = (iso, opts = { weekday: "short", day: "numeric", month: "short" }) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, opts);
const timeOf = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "");
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const isWeekend = (iso) => [0, 6].includes(new Date(`${iso}T00:00:00Z`).getUTCDay());
/** The school day before (-1) or after (1), skipping the weekend. */
const stepDay = (iso, dir) => { let d = addDays(iso, dir); while (isWeekend(d)) d = addDays(d, dir); return d; };
/** Today in Kenya — the day a register is for. */
export const todayEAT = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
const there = (s) => s === "present" || s === "late";

/** A learner's last five school days as dots, oldest first, with words for screen readers. */
function dots(recent = []) {
  if (!recent.length) return "";
  return `<span class="reg-dots" role="img" aria-label="${esc(`Last ${recent.length} days: ${recent.map((s) => STATUS[s] || s).join(", ")}`)}">${
    recent.map((s) => `<i class="reg-dot is-${esc(s)}"></i>`).join("")}</span>`;
}
/** Under a learner's name: their days before this one — the dots, the rate, and why to follow them up. */
function before(l, rule) {
  const b = l.before || {};
  if (!b.days) return "";
  const why = b.streak >= rule.streak ? `Away ${b.streak} days running` : b.followUp ? `${pct(b.rate)} this term` : "";
  return `<span class="reg-before">${dots(b.recent)}<span>${pct(b.rate)} of ${plural(b.days, "day")}</span>${why ? ` <span class="pill danger reg-flag">${esc(why)}</span>` : ""}</span>`;
}

/* ------------------------------------------------------------ the register */

/** A register's counts as a strip of figures. `unmarked` learners not yet marked. */
function countsStrip(t, unmarked = 0, total = 0) {
  const cell = (n, label, cls = "") => `<div class="reg-count ${cls}"><b>${n}</b><span>${label}</span></div>`;
  return `<div class="reg-counts" aria-live="polite">
    ${cell(t.present, "Present", "is-present")}${cell(t.late, "Late", "is-late")}${cell(t.absent, "Absent", "is-absent")}${cell(t.excused, "Excused", "is-excused")}
    ${unmarked ? cell(unmarked, "Not marked", "is-unmarked") : cell(t.marks ? pct((t.present + t.late) / t.marks * 100) : "—", `of ${plural(total, "learner")} here`, "is-rate")}
  </div>`;
}

/** The register, read only: each learner and their mark (the school head's view, a past register). */
export function registerReadHtml(v) {
  if (!v.register) return `<div class="empty-state"><b>Not taken for ${esc(dayName(v.date, { weekday: "long", day: "numeric", month: "long" }))}.</b></div>`;
  const by = v.register.updatedBy && v.register.updatedAt !== v.register.takenAt ? ` · changed ${esc(timeOf(v.register.updatedAt))} by ${esc(v.register.updatedBy)}` : "";
  return `<p class="hint" style="margin-top:0">Taken ${esc(timeOf(v.register.takenAt))}${v.register.takenBy ? ` by ${esc(v.register.takenBy)}` : ""}${by}</p>
    ${countsStrip(v.counts, 0, v.learners.length)}
    <ol class="reg-list is-read">${v.learners.map((l) => `<li class="reg-row" data-status="${esc(l.status || "")}">
      <div class="reg-who"><b>${esc(l.fullName)}</b>${l.left ? ' <span class="pill">Left the class</span>' : ""}${before(l, v.followUp)}</div>
      <span class="reg-mark is-${esc(l.status || "none")}">${esc(l.status ? STATUS[l.status] : "Not marked")}${l.reason ? ` · ${esc(REASON[l.reason] || l.reason)}` : ""}</span>
    </li>`).join("")}</ol>`;
}

/** The teacher's register page: a class and a day, each learner's mark, save; below, the class's
    term so far. `classes` are the classes this teacher teaches. Returns { open(classId, date) }. */
export function mountRegister(root, { classes = [], classId = "", date = "" } = {}) {
  if (!classes.length) {
    root.innerHTML = `<div class="panel">${emptyState("No classes yet", "Your school head assigns teachers to classes. Their registers appear here.")}</div>`;
    return { open() {} };
  }
  const today = todayEAT();
  let cls = classes.some((c) => c.id === classId) ? classId : classes[0].id;
  let day = date && date <= today ? date : today;
  let view = null;            // the register as the server (or this device) has it
  let marks = new Map();      // learnerId → { status, reason } as marked on the page
  let dirty = false;
  let seq = 0;
  root.innerHTML = `
    <div class="panel reg-panel">
      <div class="filter-bar-row reg-pick">
        <div class="field"><label for="reg_class">Class</label>
          <select id="reg_class">${classes.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}${c.grade && !c.name.includes(c.grade) ? ` (${esc(c.grade)})` : ""}</option>`).join("")}</select></div>
        <div class="field"><label for="reg_date">Day</label>
          <div class="reg-daynav">
            <button type="button" class="q-icon" data-day="-1" aria-label="The school day before">‹</button>
            <input type="date" id="reg_date" max="${esc(today)}">
            <button type="button" class="q-icon" data-day="1" aria-label="The next school day">›</button>
            <button type="button" class="btn btn-ghost q-small" data-day="0">Today</button>
          </div></div>
      </div>
      <div data-register>${skeleton(6)}</div>
    </div>
    <div class="panel">
      <div class="panel-head"><h2>This class this term</h2><span class="chart-meta" data-summary-meta style="margin:0"></span></div>
      <div data-summary>${skeleton(3, { avatar: false })}</div>
    </div>`;
  const box = root.querySelector("[data-register]");
  const classSel = root.querySelector("#reg_class");
  const dateIn = root.querySelector("#reg_date");
  classSel.value = cls;
  dateIn.value = day;

  const editable = () => !!view?.canTake;
  const statusOf = (l) => marks.get(l.id)?.status ?? null;
  const markedCounts = () => {
    const t = { marks: 0, present: 0, late: 0, absent: 0, excused: 0 };
    for (const l of view.learners) { const s = statusOf(l); if (s) { t.marks++; t[s]++; } }
    return t;
  };
  const unmarked = () => view.learners.filter((l) => !l.left && !statusOf(l)).length;
  const leaving = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } };
  const setDirty = (on) => {
    dirty = on;
    if (on) addEventListener("beforeunload", leaving); else removeEventListener("beforeunload", leaving);
    const note = box.querySelector("[data-save-note]");
    if (note) note.textContent = on ? "Not saved yet" : view?.pendingSync ? "Saved on this device — sent when you're back online" : view?.register ? "Saved" : "";
  };

  function rowHtml(l) {
    const m = marks.get(l.id) || {};
    const s = m.status;
    const away = s === "absent" || s === "excused";
    const name = `m-${esc(l.id)}`;
    const opt = (value, label, cls) => `<label class="reg-opt ${cls}"><input type="radio" name="${name}" value="${value}"${
      (value === "absent" ? away : s === value) ? " checked" : ""}><span>${label}</span></label>`;
    return `<li class="reg-row" data-id="${esc(l.id)}" data-status="${esc(s || "")}" data-name="${esc(String(l.fullName).toLowerCase())}">
      <div class="reg-who"><b>${esc(l.fullName)}</b>${l.left ? ' <span class="pill">Left the class</span>' : ""}${before(l, view.followUp)}</div>
      <div class="reg-marks" role="radiogroup" aria-label="${esc(l.fullName)}">
        ${opt("present", "✓ Present", "is-present")}${opt("late", "Late", "is-late")}${opt("absent", "✗ Absent", "is-absent")}
      </div>
      <select class="reg-why" data-why aria-label="${esc(`Why ${l.fullName} is away`)}"${away ? "" : " hidden"}>
        <option value="">No reason given</option>${Object.entries(REASON).map(([k, t]) => `<option value="${k}"${m.reason === k ? " selected" : ""}>Excused — ${esc(t.toLowerCase())}</option>`).join("")}
      </select>
    </li>`;
  }

  function drawRegister() {
    const v = view;
    const r = v.register;
    const state = v.pendingSync
      ? `<span class="pill warm">Waiting to sync</span>`
      : r ? `<span class="pill ok">Taken ${esc(timeOf(r.takenAt))}</span>${r.takenBy ? ` <span class="hint-inline">by ${esc(r.takenBy)}${
          r.updatedAt !== r.takenAt && r.updatedBy ? ` · changed ${esc(timeOf(r.updatedAt))}${r.updatedBy !== r.takenBy ? ` by ${esc(r.updatedBy)}` : ""}` : ""}</span>` : ""}`
      : `<span class="pill">Not taken yet</span>`;
    const sub = [dayName(v.date, { weekday: "long", day: "numeric", month: "long" }), v.term?.label, !v.schoolDay ? "not a school day" : ""].filter(Boolean).join(" · ");
    if (!editable()) {
      box.innerHTML = `<div class="reg-head"><div><h2 class="reg-title">${esc(v.class.name)}</h2><p class="reg-sub">${esc(sub)}</p></div><div>${state}</div></div>
        ${v.date < v.earliest ? `<p class="field-hint">That's before this class's school year.</p>` : ""}
        ${registerReadHtml(v)}`;
      return;
    }
    const many = v.learners.length > 12;
    box.innerHTML = `
      <div class="reg-head"><div><h2 class="reg-title">${esc(v.class.name)}</h2><p class="reg-sub">${esc(sub)}</p></div><div>${state}</div></div>
      ${v.pendingSync ? `<p class="sync-note"><i class="sync-dot" aria-hidden="true"></i> Saved on this device — waiting to sync. It's sent when you're back online.</p>` : ""}
      ${!v.learners.length ? emptyState("No learners in this class yet", "Learners added to the class appear here.") : `
      <div data-counts>${countsStrip(markedCounts(), unmarked(), v.learners.length)}</div>
      <div class="reg-tools">
        <button type="button" class="btn btn-outline q-small" data-all>Mark the rest present</button>
        ${many ? `<input type="search" class="reg-find" data-find placeholder="Find a learner…" aria-label="Find a learner">` : ""}
      </div>
      <ol class="reg-list">${v.learners.map(rowHtml).join("")}</ol>
      <div class="field-error" data-error hidden></div>
      <div class="reg-save">
        <span class="hint-inline" data-save-note></span>
        <button type="button" class="btn btn-primary" data-save>Save register</button>
      </div>`}`;
    setDirty(dirty);
  }

  function redrawCounts() {
    const c = box.querySelector("[data-counts]");
    if (c) c.innerHTML = countsStrip(markedCounts(), unmarked(), view.learners.length);
  }

  async function load() {
    const mine = ++seq;
    box.innerHTML = skeleton(6);
    let v;
    try { v = await getRegister(cls, day); } catch (err) {
      if (mine === seq) box.innerHTML = errorState(friendlyError(err), load);
      return;
    }
    if (mine !== seq) return;
    view = v;
    marks = new Map(v.learners.filter((l) => l.status).map((l) => [l.id, { status: l.status, reason: l.reason || null, note: l.note || null }]));
    dateIn.min = v.earliest || "";
    setDirty(false);
    drawRegister();
  }

  async function loadSummary() {
    const el = root.querySelector("[data-summary]");
    const meta = root.querySelector("[data-summary-meta]");
    el.innerHTML = skeleton(3, { avatar: false });
    let s;
    try { s = await getAttendanceSummary({ classId: cls }); } catch (err) {
      el.innerHTML = errorState(friendlyError(err), loadSummary);
      return;
    }
    meta.textContent = `${s.term?.label ? `${s.term.label} · ` : ""}${dayName(s.from)} – ${dayName(s.to)}`;
    el.innerHTML = attendanceSummaryHtml(s, { scope: "class" });
  }

  /** Leaving unsaved marks behind needs a yes. */
  async function okToLeave() {
    if (!dirty) return true;
    return confirmDialog({ title: "Leave without saving?", body: "The marks on this register aren't saved yet.", confirmLabel: "Leave without saving", danger: true });
  }
  async function open(classId2 = cls, date2 = day) {
    if ((classId2 !== cls || date2 !== day) && !(await okToLeave())) { classSel.value = cls; dateIn.value = day; return; }
    const newClass = classId2 !== cls;
    cls = classes.some((c) => c.id === classId2) ? classId2 : cls;
    day = date2 > today ? today : date2;
    classSel.value = cls;
    dateIn.value = day;
    load();
    if (newClass || !root.querySelector("[data-summary] .stat-row")) loadSummary();
  }

  classSel.addEventListener("change", () => open(classSel.value, day));
  dateIn.addEventListener("change", () => { if (dateIn.value) open(cls, dateIn.value); });
  root.querySelector(".reg-daynav").addEventListener("click", (e) => {
    const b = e.target.closest("[data-day]");
    if (!b) return;
    const step = Number(b.dataset.day);
    const next = step === 0 ? today : stepDay(day, step);
    if (next > today) { toast("That day hasn't come yet", "", "info"); return; }
    open(cls, next);
  });

  box.addEventListener("change", (e) => {
    const row = e.target.closest(".reg-row");
    if (!row || !view) return;
    const id = row.dataset.id;
    const m = marks.get(id) || { status: null, reason: null, note: null };
    if (e.target.matches("input[type=radio]")) {
      const v = e.target.value;
      const why = row.querySelector("[data-why]");
      if (v === "absent") { m.status = why.value ? "excused" : "absent"; m.reason = why.value || null; why.hidden = false; }
      else { m.status = v; m.reason = null; why.hidden = true; why.value = ""; }
    } else if (e.target.matches("[data-why]")) {
      m.reason = e.target.value || null;
      m.status = m.reason ? "excused" : "absent";
    } else return;
    marks.set(id, m);
    row.dataset.status = m.status;
    redrawCounts();
    setDirty(true);
  });
  box.addEventListener("input", (e) => {
    if (!e.target.matches("[data-find]")) return;
    const q = e.target.value.trim().toLowerCase();
    for (const row of box.querySelectorAll(".reg-row")) row.hidden = !!q && !row.dataset.name.includes(q);
  });
  box.addEventListener("click", async (e) => {
    if (e.target.closest("[data-all]")) {
      let n = 0;
      for (const l of view.learners) if (!l.left && !statusOf(l)) { marks.set(l.id, { status: "present", reason: null, note: null }); n++; }
      if (!n) { toast("Everyone is marked already", "", "info"); return; }
      for (const row of box.querySelectorAll(".reg-row")) {
        const m = marks.get(row.dataset.id);
        if (m?.status === "present" && !row.querySelector("input:checked")) {
          row.querySelector('input[value="present"]').checked = true;
          row.dataset.status = "present";
        }
      }
      redrawCounts();
      setDirty(true);
      return;
    }
    const btn = e.target.closest("[data-save]");
    if (!btn) return;
    const err = box.querySelector("[data-error]");
    err.hidden = true;
    const left = view.learners.filter((l) => !l.left && !statusOf(l));
    if (left.length) {
      const ok = await confirmDialog({
        title: `${plural(left.length, "learner")} not marked`,
        body: `${left.slice(0, 4).map((l) => l.fullName).join(", ")}${left.length > 4 ? ` and ${left.length - 4} more` : ""} — save ${left.length === 1 ? "them" : "them all"} as absent?`,
        confirmLabel: "Save — mark them absent",
      });
      if (!ok) return;
      for (const l of left) marks.set(l.id, { status: "absent", reason: null, note: null });
    }
    const list = [...marks.entries()].map(([learnerId, m]) => ({ learnerId, status: m.status, reason: m.reason || null, note: m.note || null }));
    btn.disabled = true;
    try {
      const res = await saveRegister({
        classId: cls, date: day, marks: list, baseUpdatedAt: view.register?.updatedAt ?? null,
        label: `Register — ${view.class.name}, ${dayName(day)}`,
      });
      view = res;
      marks = new Map(res.learners.filter((l) => l.status).map((l) => [l.id, { status: l.status, reason: l.reason || null, note: l.note || null }]));
      setDirty(false);
      drawRegister();
      const t = res.counts;
      toast(res.queued ? "Saved on this device" : "Register saved",
        res.queued ? "It's sent when you're back online." : `${t.present + t.late} of ${t.marks} here${t.late ? ` (${t.late} late)` : ""}.`, "success");
      if (!res.queued) loadSummary();
    } catch (ex) {
      btn.disabled = false;
      const server = ex?.body?.conflict?.server;
      if (server) {
        view = server;
        marks = new Map(server.learners.filter((l) => l.status).map((l) => [l.id, { status: l.status, reason: l.reason || null, note: l.note || null }]));
        setDirty(false);
        drawRegister();
        const e2 = box.querySelector("[data-error]");
        if (e2) { e2.textContent = "Someone else changed this register after you opened it — here it is with their marks. Make your changes again and save."; e2.hidden = false; }
        return;
      }
      err.textContent = friendlyError(ex, "Couldn't save the register.");
      err.hidden = false;
    }
  });

  load();
  loadSummary();
  return { open };
}

/* ------------------------------------------------------------ what the registers add up to */

/** A stretch of registers, as GET /attendance/summary gives them: the figures, then the pictures.
    scope: "class" (a teacher's class), "school" (a school head's), "programme" (by school). */
export function attendanceSummaryHtml(s, { scope = "class" } = {}) {
  const t = s.totals;
  if (!t.registers) {
    return `<div class="empty-state"><b>No registers taken ${scope === "class" ? "for this class " : ""}since ${esc(dayName(s.from, { day: "numeric", month: "long" }))}.</b>
      <div>${scope === "class" ? "Take today's register above — what they add up to appears here." : "Once teachers take their registers, attendance appears here."}</div></div>`;
  }
  const rule = s.followUp || { rate: 90, streak: 3, minDays: 5 };
  const groupWord = { class: "class", grade: "grade", school: "school" }[s.by] || "class";
  const kpis = [
    kpiCard({ label: "Attendance", icon: "check", value: pct(t.rate),
      sub: `${(t.present + t.late).toLocaleString()} of ${plural(t.marks, "learner-day")} here${t.late ? ` · ${t.late} late` : ""}` }),
    kpiCard({ label: "Registers taken", icon: "form", value: t.due ? `${t.taken}/${t.due}` : String(t.registers),
      sub: t.due ? `${pct(t.coverage)} of school days${scope === "class" ? "" : " × classes"}` : "no school days in this stretch" }),
    s.learnersShown !== false && scope !== "programme" ? kpiCard({ label: "To follow up", icon: "alert", value: String(t.followUp), tone: t.followUp ? "warn" : "",
      sub: `below ${rule.rate}% or away ${rule.streak} days running` }) : "",
    kpiCard({ label: "Absent", icon: "user", value: (t.absent + t.excused).toLocaleString(),
      sub: t.excused ? `${t.excused} excused, with a reason` : "learner-days missed" }),
  ].join("");
  // Every chart here covers the registers between these dates.
  const period = s.from && s.to ? `${dayName(s.from, { day: "numeric", month: "short" })} – ${dayName(s.to, { day: "numeric", month: "short", year: "numeric" })}` : "";
  const card = (title, meta, body, wide = false) => `<div class="chart-card${wide ? " intel-wide" : ""}"><div class="chart-card-head"><b>${esc(title)}</b>${meta ? `<span>${esc(meta)}</span>` : ""}${periodChip(period)}</div>${body}</div>`;
  const parts = [];
  // By day: a line once there are three days, bars before that.
  const days = s.byDay.filter((d) => d.marks);
  if (days.length >= 3) {
    const step = Math.ceil(days.length / 5); // five dates under the line at most: they stay readable on a phone
    const last = days.length - 1;
    parts.push(card("Attendance, day by day", `% of learners here · ${plural(days.length, "day")} with a register`, lineChart(days.map((d) => ({
      label: dayName(d.day, { day: "numeric", month: "short" }), full: dayName(d.day, { weekday: "long", day: "numeric", month: "long" }), value: d.rate,
      note: `${d.present + d.late} of ${d.marks} here`,
    })), { unit: "%", noun: "here", title: "Attendance by day", insight: true, ticks: days.map((_, i) => i).filter((i) => i === last || (i % step === 0 && last - i >= step / 2)) })));
  } else if (days.length) {
    parts.push(card("Attendance, day by day", "% of learners here", barList(days.map((d) => ({ label: dayName(d.day), value: d.rate, note: `${d.present + d.late} of ${d.marks}` })), { unit: "%", noun: "here", period })));
  }
  if (s.byWeekday.filter((d) => d.marks).length >= 2) {
    parts.push(card("Which weekdays learners miss most", "% of learners here, by day of the week",
      barList(s.byWeekday.filter((d) => d.marks).map((d) => ({ label: d.label, value: d.rate, base: d.marks, note: `${(d.present + d.late).toLocaleString()} of ${d.marks.toLocaleString()}` })), { unit: "%", noun: "here", insight: true, period })));
  }
  if (scope !== "class" && s.groups.length > 1) {
    parts.push(card(`Attendance in each ${groupWord}`, "% of learners here · registers taken", barList(s.groups.filter((g) => g.marks || g.due).map((g) => ({
      label: g.label, value: g.rate ?? 0, base: g.marks, note: g.due ? `${g.taken} of ${g.due} registers` : `${g.registers} registers`,
    })), { unit: "%", noun: "here", zeros: "No registers yet", sort: true, insight: true, period }), true));
  }
  // Learners to follow up.
  if (s.learnersShown !== false && s.learners?.length) {
    const follow = s.learners.filter((l) => l.followUp);
    parts.push(card("Learners to follow up", `below ${rule.rate}% (after ${rule.minDays} days) or away ${rule.streak} days running`, follow.length
      ? `<ul class="reg-follow">${follow.slice(0, 30).map((l) => `<li>
          <div><b>${esc(l.name)}</b>${scope !== "class" && l.className ? `<span class="hint-inline"> · ${esc(l.className)}</span>` : ""}${l.left ? ' <span class="pill">Left</span>' : ""}
            <span class="reg-follow-meta">${dots(l.recent)} ${esc(`${l.absent + l.excused} of ${plural(l.days, "day")} away`)}${l.lastAbsent ? esc(` · last ${dayName(l.lastAbsent)}`) : ""}</span></div>
          <span class="reg-follow-fig"><b>${pct(l.rate)}</b>${l.streak >= rule.streak ? `<span class="pill danger">${l.streak} days running</span>` : ""}</span>
        </li>`).join("")}</ul>${follow.length > 30 ? `<p class="chart-note">And ${follow.length - 30} more.</p>` : ""}`
      : `<div class="chart-empty">Nobody — every learner is above ${rule.rate}% and none has been away ${rule.streak} days running.</div>`));
  }
  if (s.reasons && t.absent + t.excused > 0) {
    const r = s.reasons;
    parts.push(card("Why learners were away", "Learner-days missed, by reason", barList([
      { label: "No reason given", value: r.none }, { label: "Sick", value: r.sick }, { label: "Family", value: r.family },
      { label: "With permission", value: r.permission }, { label: "Other reason", value: r.other },
    ], { share: true, noun: "learner-days", zeros: "None", period })));
  }
  if (s.attendanceAndMarks) {
    parts.push(card("Average mark, by how often learners came", "Learners grouped by their attendance", barList(s.attendanceAndMarks.map((g) => ({
      label: `Came ${g.label === "Below 80%" ? "below 80%" : g.label} of days`, value: g.averagePercent, note: plural(g.learners, "learner"),
    })), { unit: "%", noun: "average mark", period }) + `<p class="chart-note">Marks on work handed in over the same days. Groups of fewer than 3 learners are left out. This shows the two side by side, not that one causes the other.</p>`));
  }
  if (s.grid?.days?.length) parts.push(sheetHtml(s.grid));
  return `<div class="stat-row">${kpis}</div><div class="chart-grid">${parts.join("")}</div>`;
}

/** The register sheet: a learner per row, a register per column, a letter in each cell. */
function sheetHtml(g) {
  const letter = { present: "P", late: "L", absent: "A", excused: "E" };
  const head = g.days.map((d) => `<th scope="col" title="${esc(dayName(d, { weekday: "long", day: "numeric", month: "long" }))}">${esc(dayName(d, { day: "numeric" }))}<small>${esc(dayName(d, { weekday: "narrow" }))}</small></th>`).join("");
  const rows = g.rows.map((r) => {
    const here = r.marks.filter((m) => there(m)).length, known = r.marks.filter(Boolean).length;
    return `<tr><th scope="row">${esc(r.name)}</th>${r.marks.map((m) => `<td class="sheet-${esc(m || "none")}">${m ? letter[m] : ""}${m ? `<span class="sr-only"> ${STATUS[m]}</span>` : ""}</td>`).join("")}<td class="sheet-rate">${known ? pct((here / known) * 100) : "—"}</td></tr>`;
  }).join("");
  return `<details class="chart-card intel-wide reg-sheet"><summary class="chart-card-head"><b>Register sheet</b><span>${plural(g.days.length, "day")} · P present · L late · A absent · E excused</span></summary>
    <div class="sheet-wrap"><table class="sheet"><thead><tr><th scope="col">Learner</th>${head}<th scope="col">Here</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
}

/* ------------------------------------------------------------ the day's registers */

/** The day's registers at a glance (GET /attendance/today): each class taken or not. A teacher's
    classes link to their register; a school head can open each one to read. */
export function todayHtml(d, { link = true } = {}) {
  if (!d.classes.length) return `<div class="empty-state">No classes yet.</div>`;
  const t = d.totals;
  return `<p class="hint" style="margin:0 0 .5rem">${t.taken} of ${plural(t.classes, "register")} taken${t.marks ? ` · <b>${pct(t.rate)}</b> here (${(t.present + t.late).toLocaleString()} of ${t.marks.toLocaleString()})` : ""}${d.schoolDay ? "" : " · not a school day"}</p>
    ${d.classes.map((k) => {
      const r = k.register;
      const go = k.canTake && link && (k.learners || r)
        ? `<a class="btn ${r ? "btn-ghost" : "btn-primary"} q-small" href="#attendance?class=${encodeURIComponent(k.id)}">${r ? "Change" : "Take register"}</a>`
        : r ? `<button type="button" class="btn btn-ghost q-small" data-read-register="${esc(k.id)}">View</button>` : "";
      return `<div class="task-row">
        <div style="flex:1;min-width:0"><b>${esc(k.name)}</b><span>${r
          ? `${pct(r.rate)} here · ${r.present + r.late} of ${r.marks}${r.late ? ` · ${r.late} late` : ""} · taken ${esc(timeOf(r.takenAt))}${r.takenBy ? ` by ${esc(r.takenBy)}` : ""}`
          : k.learners ? `<span class="pill warm">Not taken yet</span> · ${plural(k.learners, "learner")}` : "No learners in this class yet"}</span></div>
        <div class="roster-actions">${go}</div>
      </div>`;
    }).join("")}`;
}

/** Opens one class's register for a day to read (the school head's view). */
export async function openRegisterToRead(classId, date) {
  const panel = openContentPanel({ title: "Register", html: skeleton(6) });
  try {
    const v = await getRegister(classId, date);
    panel.innerHTML = `<h2 style="margin:0 0 .2rem">${esc(v.class.name)}</h2>
      <p class="hint" style="margin-top:0">${esc(dayName(v.date, { weekday: "long", day: "numeric", month: "long" }))}${v.term ? ` · ${esc(v.term.label)}` : ""}</p>
      ${registerReadHtml(v)}`;
  } catch (err) {
    panel.innerHTML = errorState(friendlyError(err), () => openRegisterToRead(classId, date));
  }
}

/** The school head's attendance page: the day's registers, then the school's term so far. */
export function mountSchoolAttendance(root) {
  const today = todayEAT();
  root.innerHTML = `
    <div class="panel">
      <div class="panel-head"><h2>Registers</h2>
        <div class="reg-daynav"><button type="button" class="q-icon" data-day="-1" aria-label="The school day before">‹</button>
          <input type="date" id="sa_date" max="${esc(today)}" value="${esc(today)}" aria-label="Day">
          <button type="button" class="q-icon" data-day="1" aria-label="The next school day">›</button></div></div>
      <div data-today>${skeleton(4)}</div>
    </div>
    <div class="panel">
      <div class="panel-head"><h2>This term</h2>
        <div class="field" style="margin:0"><label for="sa_by" class="sr-only">Show by</label>
          <select id="sa_by"><option value="class">By class</option><option value="grade">By grade</option></select></div></div>
      <div data-term>${skeleton(3, { avatar: false })}</div>
    </div>`;
  const dateIn = root.querySelector("#sa_date");
  async function drawToday() {
    const el = root.querySelector("[data-today]");
    el.innerHTML = skeleton(4);
    try { el.innerHTML = todayHtml(await getAttendanceToday({ date: dateIn.value || today }), { link: false }); } catch (err) {
      el.innerHTML = errorState(friendlyError(err), drawToday);
    }
  }
  async function drawTerm() {
    const el = root.querySelector("[data-term]");
    el.innerHTML = skeleton(3, { avatar: false });
    try { el.innerHTML = attendanceSummaryHtml(await getAttendanceSummary({ by: root.querySelector("#sa_by").value }), { scope: "school" }); } catch (err) {
      el.innerHTML = errorState(friendlyError(err), drawTerm);
    }
  }
  dateIn.addEventListener("change", drawToday);
  root.querySelector(".reg-daynav").addEventListener("click", (e) => {
    const b = e.target.closest("[data-day]");
    if (!b) return;
    const next = stepDay(dateIn.value || today, Number(b.dataset.day));
    if (next > today) return;
    dateIn.value = next;
    drawToday();
  });
  root.querySelector("#sa_by").addEventListener("change", drawTerm);
  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-read-register]");
    if (b) openRegisterToRead(b.dataset.readRegister, dateIn.value || today);
  });
  drawToday();
  drawTerm();
  return { refresh() { drawToday(); drawTerm(); } };
}
