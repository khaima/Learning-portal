import "./nav.js";
import { $, $$, esc, initials, toast, formatDuration, groupByType } from "./util.js";
import { requireRole, signOut } from "./auth.js";
import { TEACHER_CONTENT, normalizeLibraryAudience, CONTENT_TYPES } from "./data.js";
import {
  getLibrary, getForms, getResponses, addResponse, libraryFilesHtml,
  getLearners, addLearner, updateLearner, deleteLearner, getMyLibraryUsage, getLearnerActivity,
  setAssignmentDone,
} from "./store.js";
import { openContentPanel } from "./viewer.js";

const ICON = {
  classes: '<path d="M22 10 12 5 2 10l10 5 10-5Z"/><path d="M6 12v5c0 1.5 3 3 6 3s6-1.5 6-3v-5"/>',
  grade: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/>',
  score: '<path d="M4 19V5a2 2 0 0 1 2-2h9l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/><path d="M9 13l2 2 4-4"/>',
  attendance: '<path d="M12 20V10M18 20V4M6 20v-6"/>',
};
const svg = (paths) => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${paths}</svg>`;

async function main() {
  const user = await requireRole("teacher");
  if (!user) return;
  const content = TEACHER_CONTENT[user.id] || {
    stats: { classes: 0, learners: 0, toGrade: 0, avgScore: 0, attendance: 0 },
    classes: [], tasks: [], results: [],
  };

  $("#sideAvatar").textContent = initials(user.fullName);
  $("#sideName").textContent = user.fullName;
  $("#sideMeta").textContent = `Teacher · ${user.county || "—"}`;
  $("#greeting").textContent = `Habari, ${(user.fullName || "there").split(" ")[0]}`;
  $("#topSub").textContent = `${user.school || "No school set"} · Term 2, 2026`;

  const { stats } = content;
  $("#statRow").innerHTML = `
    <div class="stat-tile"><div class="s-label">${svg(ICON.classes)}Classes</div><div class="s-num">${stats.classes}</div><div class="s-sub">${stats.learners} learners total</div></div>
    <div class="stat-tile"><div class="s-label">${svg(ICON.grade)}To grade</div><div class="s-num">${stats.toGrade}</div><div class="s-sub">this week</div></div>
    <div class="stat-tile"><div class="s-label">${svg(ICON.score)}Avg. score</div><div class="s-num">${stats.avgScore}%</div><div class="s-sub">this term</div></div>
    <div class="stat-tile"><div class="s-label">${svg(ICON.attendance)}Attendance</div><div class="s-num">${stats.attendance}%</div><div class="s-sub">avg. this week</div></div>
  `;

  $("#classList").innerHTML = content.classes.length
    ? content.classes.map((c) => `
      <div class="class-row">
        <div class="class-swatch" style="background:${c.swatch}">${esc(c.code)}</div>
        <div class="class-info"><b>${esc(c.name)}</b><span>${c.learners} learners</span>
          <div class="class-bar"><i style="width:${c.coverage}%"></i></div></div>
        <div class="class-meta"><b>${c.coverage}%</b>coverage</div>
      </div>`).join("")
    : `<div class="empty-state">No classes yet. A real build would let you create one here.</div>`;

  $("#taskList").innerHTML = content.tasks.length
    ? content.tasks.map((t) => `
      <div class="task-row ${t.state}"><span class="task-dot"></span><div><b>${esc(t.title)}</b><span>${esc(t.detail)}</span></div></div>`).join("")
    : `<div class="empty-state">Nothing due this week.</div>`;

  $("#resultList").innerHTML = content.results.length
    ? content.results.map((r) => `
      <div class="result-row"><span>${esc(r.label)}</span><span class="score ${r.kind}">${r.score}%</span></div>`).join("")
    : `<div class="empty-state">No results recorded yet.</div>`;

  /* ------------------------------------------------------------ my learners
     Learners sign in with a username + 4-digit PIN. This teacher creates
     and manages the accounts; the roster below is the whole editable list. */
  const roster = $("#learnerRoster");
  const pager = $("#learnerRosterPager");
  const addForm = $("#addLearnerForm");
  const addError = $("#addLearnerError");

  const LEARNER_PAGE_SIZE = 8;
  let learnerPage = 0;
  let learnerCache = [];

  function learnerRow(l) {
    return `
      <div class="task-row" data-learner="${esc(l.id)}" data-username="${esc(l.username)}" data-grade="${esc(l.grade || "")}">
        <div style="flex:1">
          <button type="button" data-act="view" style="background:none;border:0;padding:0;font:inherit;cursor:pointer;color:var(--brand-fg);text-align:left"><b>${esc(l.fullName)}</b></button>
          <span>@${esc(l.username)}${l.grade ? " · " + esc(l.grade) : ""}${l.locked ? ' · <span class="pill warm">Locked</span>' : ""}</span>
        </div>
        <div class="roster-actions">
          <button type="button" data-act="view">View activity</button>
          <button type="button" data-act="edit">Edit</button>
          <button type="button" data-act="pin">Reset PIN</button>
          ${l.locked ? '<button type="button" data-act="unlock">Unlock</button>' : ""}
          <button type="button" data-act="remove" class="danger">Remove</button>
        </div>
      </div>`;
  }

  // The roster is fully loaded already (getLearners() has no server paging),
  // so "next page" here is just a compact client-side slice — a class of 30
  // shows 8 at a time instead of one long scroll.
  function renderRosterPage() {
    const totalPages = Math.max(1, Math.ceil(learnerCache.length / LEARNER_PAGE_SIZE));
    if (learnerPage > totalPages - 1) learnerPage = totalPages - 1;
    if (learnerPage < 0) learnerPage = 0;
    const start = learnerPage * LEARNER_PAGE_SIZE;
    const pageItems = learnerCache.slice(start, start + LEARNER_PAGE_SIZE);

    roster.innerHTML = learnerCache.length
      ? pageItems.map(learnerRow).join("")
      : `<div class="empty-state">No learners yet. Add one to give them a sign-in.</div>`;

    pager.innerHTML = learnerCache.length > LEARNER_PAGE_SIZE
      ? `<span>${start + 1}–${Math.min(learnerCache.length, start + LEARNER_PAGE_SIZE)} of ${learnerCache.length}</span>
         <div style="display:flex;gap:.4rem">
           <button type="button" class="btn btn-outline" data-learner-page="prev" style="padding:.25rem .7rem;font-size:.8rem" ${learnerPage <= 0 ? "disabled" : ""}>← Prev</button>
           <button type="button" class="btn btn-outline" data-learner-page="next" style="padding:.25rem .7rem;font-size:.8rem" ${learnerPage >= totalPages - 1 ? "disabled" : ""}>Next →</button>
         </div>`
      : "";
  }

  pager.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-learner-page]");
    if (!btn) return;
    learnerPage += btn.dataset.learnerPage === "next" ? 1 : -1;
    renderRosterPage();
  });

  async function renderRoster() {
    roster.innerHTML = `<div class="empty-state">Loading…</div>`;
    try { learnerCache = await getLearners(); } catch { learnerCache = []; }
    renderRosterPage();
  }

  $("#addLearnerBtn").addEventListener("click", () => {
    addForm.hidden = false;
    addError.hidden = true;
    $("#nl_name").focus();
  });
  $("#cancelLearnerBtn").addEventListener("click", () => {
    addForm.hidden = true;
    addForm.reset();
  });

  addForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    addError.hidden = true;
    const btn = addForm.querySelector("[type=submit]");
    btn.disabled = true;
    try {
      await addLearner({
        fullName: $("#nl_name").value.trim(),
        username: $("#nl_user").value.trim().toLowerCase(),
        grade: $("#nl_grade").value.trim(),
        pin: $("#nl_pin").value.trim(),
      });
      addForm.reset();
      addForm.hidden = true;
      toast("Learner added", `They can sign in with @${$("#nl_user").value.trim().toLowerCase()}`);
      renderRoster();
    } catch (err) {
      addError.textContent = err?.body?.error || err?.message || "Could not add the learner.";
      addError.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });

  // ---------------------------------------------------------------- bulk add (CSV)
  // A blank template to fill in offline and bring back — matches exactly
  // what the parser below reads, so a filled-in copy round-trips cleanly.
  $("#downloadLearnerTemplate").addEventListener("click", () => {
    const csv = "﻿Full name,Username,Grade,PIN\r\n";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = "learners-template.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  function suggestUsername(fullName, taken) {
    const base = fullName.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9\s]/g, "").trim().split(/\s+/).filter(Boolean);
    const stem = base.length > 1 ? `${base[0]}.${base[1][0]}` : (base[0] || "learner");
    let candidate = stem.slice(0, 28);
    let n = 1;
    while (taken.has(candidate)) candidate = `${stem.slice(0, 26)}${++n}`;
    taken.add(candidate);
    return candidate;
  }
  const randomPin = () => String(Math.floor(1000 + Math.random() * 9000));

  function parseLearnerCsv(text) {
    return text
      .split(/\r?\n/)
      .map((line) => line.replace(/^﻿/, "").trim())
      .filter(Boolean)
      .map((line) => line.split(",").map((cell) => cell.trim().replace(/^"|"$/g, "")))
      .filter((cells) => cells[0] && cells[0].toLowerCase() !== "full name")
      .map(([fullName, username, grade, pin]) => ({
        fullName, username: (username || "").toLowerCase(), grade: grade || "", pin: pin || "",
      }));
  }

  $("#learnerCsvInput").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const resultEl = $("#bulkLearnerResult");
    resultEl.innerHTML = `<div class="empty-state">Reading file…</div>`;

    const text = await file.text().catch(() => "");
    const rows = parseLearnerCsv(text);
    e.target.value = "";
    if (!rows.length) {
      resultEl.innerHTML = `<div class="field-error">That file had no learners in it — the first column of each row should be a full name.</div>`;
      return;
    }

    resultEl.innerHTML = `<div class="empty-state">Adding ${rows.length} learner(s)…</div>`;
    const taken = new Set(learnerCache.map((l) => l.username));
    const created = []; // { fullName, username, pin }
    const failed = []; // { fullName, error }
    for (const row of rows) {
      const username = row.username && !taken.has(row.username) ? row.username : suggestUsername(row.fullName || "learner", taken);
      const pin = /^\d{4}$/.test(row.pin) ? row.pin : randomPin();
      try {
        await addLearner({ fullName: row.fullName, username, grade: row.grade, pin });
        taken.add(username);
        created.push({ fullName: row.fullName, username, pin });
      } catch (err) {
        failed.push({ fullName: row.fullName, error: err?.body?.error || err?.message || "Could not add" });
      }
    }

    resultEl.innerHTML = `
      ${created.length ? `<p class="hint" style="margin-bottom:.3rem"><b>${created.length} learner(s) added.</b> Sign-ins generated for anyone who didn't have one — write these down:</p>
        <div style="max-height:12rem;overflow:auto;border:1px solid var(--line);border-radius:.5rem;padding:.5rem .7rem;font-size:.85rem">
          ${created.map((c) => `<div>${esc(c.fullName)} — <b>@${esc(c.username)}</b> · PIN ${esc(c.pin)}</div>`).join("")}
        </div>` : ""}
      ${failed.length ? `<p class="field-error" style="margin-top:.5rem">${failed.length} row(s) couldn't be added: ${failed.map((f) => `${esc(f.fullName)} (${esc(f.error)})`).join(", ")}</p>` : ""}
    `;
    toast("Bulk add finished", `${created.length} added${failed.length ? `, ${failed.length} failed` : ""}.`, failed.length ? "error" : "success");
    renderRoster();
  });

  roster.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const rowEl = btn.closest("[data-learner]");
    const id = rowEl.dataset.learner;
    const nameEl = rowEl.querySelector("b");
    const act = btn.dataset.act;
    if (act === "view") return openLearnerActivity(id, nameEl.textContent);

    try {
      if (act === "edit") {
        const fullName = prompt("Full name", nameEl.textContent);
        if (fullName === null) return;
        const username = prompt("Username (lowercase, 3–32 chars)", rowEl.dataset.username);
        if (username === null) return;
        const grade = prompt("Grade / class", rowEl.dataset.grade);
        if (grade === null) return;
        await updateLearner(id, {
          fullName: fullName.trim(),
          username: username.trim().toLowerCase(),
          grade: grade.trim(),
        });
        toast("Learner updated", "");
      } else if (act === "pin") {
        const pin = prompt("New 4-digit PIN");
        if (!pin) return;
        await updateLearner(id, { pin: pin.trim() });
        toast("PIN reset", "Tell the learner their new PIN.");
      } else if (act === "unlock") {
        await updateLearner(id, { unlock: true });
        toast("Unlocked", "");
      } else if (act === "remove") {
        if (!confirm(`Remove ${nameEl.textContent}? Their sign-in stops working.`)) return;
        await deleteLearner(id);
        toast("Learner removed", "");
      }
      renderRoster();
    } catch (err) {
      toast("Couldn't do that", err?.body?.error || err?.message || "", "error");
    }
  });

  /* "View activity" — a read-only look at what this specific learner has
     actually done (their real assignments and library usage/badges),
     the same data they'd see on their own dashboard. Nothing here can be
     edited; changing a PIN or details stays in the roster row itself. */
  async function openLearnerActivity(id, fallbackName) {
    const panel = openContentPanel({
      title: fallbackName || "Learner activity",
      html: `<div class="empty-state">Loading…</div>`,
    });
    let learner, assignments, library;
    try {
      ({ learner, assignments, library } = await getLearnerActivity(id));
    } catch (err) {
      panel.innerHTML = `<div class="empty-state is-error">Couldn't load their activity — ${esc(err?.body?.error || err?.message || "")}</div>`;
      return;
    }

    function render() {
      const done = assignments.filter((a) => a.done).length;

      const assignmentRows = assignments.length
        ? assignments.map((a) => `
          <div class="task-row">
            <span class="task-dot"></span>
            <div><b>${esc(a.title)}</b><span>${esc(a.subject)} · due ${esc(a.due)}</span></div>
            <button type="button" class="pill ${a.done ? "ok" : "warm"}" style="border:0;cursor:pointer" data-toggle-assign="${esc(a.id)}" data-done="${a.done ? "1" : "0"}">${a.done ? "Done" : "Not yet"}</button>
          </div>`).join("")
        : `<div class="empty-state">No assignments yet.</div>`;

      const usageRows = library.interactions.length
        ? library.interactions.slice(0, 10).map((it) => `
          <div class="task-row">
            <div style="flex:1"><b>${esc(it.title || "Resource")}</b><span>Started ${new Date(it.startedAt).toLocaleString()}${
              it.completedAt ? " · Finished " + new Date(it.completedAt).toLocaleString() : " · In progress"}</span></div>
            <span class="bar-num">${it.durationSeconds != null ? formatDuration(it.durationSeconds) : "—"}</span>
          </div>`).join("")
        : `<div class="empty-state">Nothing opened from the library yet.</div>`;
      const badgeChips = (library.badges || []).slice(0, 6).map((b) => `
        <span class="pill" style="display:inline-flex;align-items:center;gap:.3rem;margin:0 .3rem .3rem 0">&#127942; ${esc(b.title || "Resource")}</span>`).join("");

      panel.innerHTML = `
        <p class="hint" style="margin-top:0">${esc(learner.school || "")}${learner.county ? " · " + esc(learner.county) : ""}${learner.grade ? " · " + esc(learner.grade) : ""} · @${esc(learner.username)}</p>
        <div class="chart-stats" style="grid-template-columns:repeat(2,1fr)">
          <div><b>${done}/${assignments.length}</b><span>Assignments done</span></div>
          <div><b>${formatDuration(library.totalSeconds)}</b><span>Library time</span></div>
        </div>
        <h3 style="margin:1rem 0 .4rem">Assignments</h3>
        <p class="hint" style="margin:0 0 .4rem">Tap the status pill to mark something done or not yet, on their behalf.</p>
        ${assignmentRows}
        <h3 style="margin:1.1rem 0 .4rem">Digital Library activity</h3>
        <div class="chart-stats" style="grid-template-columns:repeat(2,1fr);margin-bottom:.6rem">
          <div><b>${library.resourcesOpened}</b><span>Resources opened</span></div>
          <div><b>${library.badgesEarned || 0}</b><span>Badges earned</span></div>
        </div>
        ${badgeChips ? `<div style="margin-bottom:.6rem">${badgeChips}</div>` : ""}
        ${usageRows}
      `;
    }
    render();

    panel.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-toggle-assign]");
      if (!btn) return;
      const assignId = btn.dataset.toggleAssign;
      const nextDone = btn.dataset.done !== "1";
      btn.disabled = true;
      try {
        await setAssignmentDone(assignId, nextDone);
        assignments = assignments.map((a) => (a.id === assignId ? { ...a, done: nextDone } : a));
        render();
        toast(nextDone ? "Marked done" : "Marked not yet done", "");
      } catch (err) {
        btn.disabled = false;
        toast("Couldn't update that", err?.body?.error || err?.message || "", "error");
      }
    });
  }

  renderRoster();

  /* Content library lives in the real database (education.js writes it).
     Teacher Resources go to teachers and the head of institution only —
     never the Learner dashboard; the Digital Library is the learner-facing
     shelf, which teachers and heads can see too. */
  $("#teacherResourceList").innerHTML = `<div class="empty-state">Loading…</div>`;
  $("#libraryList").innerHTML = `<div class="empty-state">Loading…</div>`;
  getLibrary().then((library) => {
    const row = (l) => `
        <div class="task-row"><div><b>${esc(l.title)}</b><span>${esc(l.subject)}${l.description ? " — " + esc(l.description) : ""}</span>${libraryFilesHtml(l)}</div></div>`;
    const folders = (list) => groupByType(list, CONTENT_TYPES).map(({ type, items }) => `
      <div class="list-group">
        <div class="list-group-title">${esc(type)}<span class="count">${items.length}</span></div>
        ${items.map(row).join("")}
      </div>`).join("");
    const resources = library.filter((l) => normalizeLibraryAudience(l.audience) === "staff");
    const shared = library.filter((l) => normalizeLibraryAudience(l.audience) === "library");
    $("#teacherResourceList").innerHTML = resources.length
      ? folders(resources)
      : `<div class="empty-state">No teacher resources uploaded yet.</div>`;
    $("#libraryList").innerHTML = shared.length
      ? folders(shared)
      : `<div class="empty-state">Nothing in the library yet.</div>`;
  });

  /* My learning activity — every "Open to read" click above is timed
     from open to return; see nav.js. */
  renderUsageSummary();
  async function renderUsageSummary() {
    const el = $("#usageSummary");
    el.innerHTML = `<div class="empty-state">Loading…</div>`;
    let u;
    try { u = await getMyLibraryUsage(); } catch {
      el.innerHTML = `<div class="empty-state is-error">Couldn't load your activity.</div>`;
      return;
    }
    if (!u.interactions.length) {
      el.innerHTML = `<div class="empty-state">Open something from the library to start tracking your activity here.</div>`;
      return;
    }
    const rows = u.interactions.slice(0, 10).map((it) => `
      <div class="task-row">
        <div style="flex:1"><b>${esc(it.title || "Resource")}</b><span>Started ${new Date(it.startedAt).toLocaleString()}${
          it.completedAt ? " · Finished " + new Date(it.completedAt).toLocaleString() : " · In progress"}</span></div>
        <span class="bar-num">${it.durationSeconds != null ? formatDuration(it.durationSeconds) : "—"}</span>
      </div>`).join("");
    const badgeChips = (u.badges || []).slice(0, 6).map((b) => `
      <span class="pill" style="display:inline-flex;align-items:center;gap:.3rem;margin:0 .3rem .3rem 0">&#127942; ${esc(b.title || "Resource")}</span>`).join("");
    el.innerHTML = `
      <div class="chart-stats" style="grid-template-columns:repeat(3,1fr)">
        <div><b>${formatDuration(u.totalSeconds)}</b><span>Time spent</span></div>
        <div><b>${u.resourcesOpened}</b><span>Resources opened</span></div>
        <div><b>${u.badgesEarned || 0}</b><span>Badges earned</span></div>
      </div>
      ${badgeChips ? `<div style="margin:.7rem 0 .1rem">${badgeChips}</div>` : ""}
      ${rows}
    `;
  }

  /* Forms the Education Team has sent to teachers — same
     create-once-fill-once loop as the field officer's report form, just
     addressed at this account instead of built into it. */
  renderForms();
  async function renderForms() {
    $("#formsList").innerHTML = `<div class="empty-state">Loading…</div>`;
    const [forms, responses] = await Promise.all([getForms(), getResponses()]);
    const teacherForms = forms.filter((f) => f.audience === "teacher");
    const answeredFormIds = new Set(responses.filter((r) => r.respondentId === user.id).map((r) => r.formId));

    $("#formsList").innerHTML = teacherForms.length
      ? teacherForms.map((f) => {
          const done = answeredFormIds.has(f.id);
          return `
            <div class="form-card">
              <div class="fc-head"><h3>${esc(f.title)}</h3>${done ? `<span class="pill ok">Submitted</span>` : `<span class="pill warm">Pending</span>`}</div>
              <div class="fc-meta">${f.description ? esc(f.description) : "From " + esc(f.createdBy)}</div>
              ${done ? "" : `<button class="btn btn-outline" type="button" data-fill-form="${esc(f.id)}">Fill out</button>
                <div class="fill-form" id="fill-${esc(f.id)}" hidden></div>`}
            </div>`;
        }).join("")
      : `<div class="empty-state">No forms from the Education Team yet.</div>`;

    $$("[data-fill-form]").forEach((btn) =>
      btn.addEventListener("click", () => openFormFill(btn.dataset.fillForm, teacherForms, btn))
    );
  }

  function openFormFill(formId, forms, btn) {
    const form = forms.find((f) => f.id === formId);
    const box = $("#fill-" + formId);
    if (!form || !box) return;
    btn.hidden = true;
    box.hidden = false;
    box.innerHTML = form.questions.map((q) => `
      <div class="field">
        <label>${esc(q.prompt)}</label>
        ${q.type === "rating"
          ? `<select data-q="${esc(q.id)}"><option value="5">5 — Excellent</option><option value="4">4 — Good</option><option value="3" selected>3 — Okay</option><option value="2">2 — Weak</option><option value="1">1 — Poor</option></select>`
          : `<input type="text" data-q="${esc(q.id)}" placeholder="Your answer">`}
      </div>`).join("") +
      `<button class="btn btn-primary btn-block" type="button" id="submit-${esc(formId)}">Submit feedback</button>`;

    $("#submit-" + formId).addEventListener("click", async () => {
      const submitBtn = $("#submit-" + formId);
      submitBtn.disabled = true;
      submitBtn.textContent = "Submitting…";
      const answers = form.questions.map((q) => ({
        questionId: q.id,
        value: box.querySelector(`[data-q="${q.id}"]`).value,
      }));
      await addResponse({
        id: "resp_" + Date.now().toString(36),
        formId: form.id,
        respondentId: user.id,
        respondentName: user.fullName,
        respondentRole: "teacher",
        answers,
      });
      renderForms();
    });
  }
}
main();

async function doSignOut() {
  await signOut();
  location.href = "index.html";
}
$("#signOutBtn")?.addEventListener("click", doSignOut);
$("#signOutBtn2")?.addEventListener("click", doSignOut);
