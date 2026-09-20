import "./nav.js";
import { $, $$, esc, initials, formatDuration, groupByType } from "./util.js";
import { requireRole, signOut } from "./auth.js";
import { LEADER_CONTENT, normalizeLibraryAudience, CONTENT_TYPES } from "./data.js";
import { getForms, getResponses, addResponse, getLibrary, libraryFilesHtml, getMyLibraryUsage } from "./store.js";

const ICON = {
  learners: '<path d="M22 10 12 5 2 10l10 5 10-5Z"/><path d="M6 12v5c0 1.5 3 3 6 3s6-1.5 6-3v-5"/>',
  teachers: '<path d="M4 19V6a2 2 0 0 1 2-2h13v14H6a2 2 0 0 0-2 2Zm0 0a2 2 0 0 0 2 2h13"/><path d="M9 8h7M9 11h7"/>',
  classes: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/>',
  attendance: '<path d="M12 20V10M18 20V4M6 20v-6"/>',
};
const svg = (paths) => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${paths}</svg>`;
const RETURN_PILL = { ok: "pill ok", due: "pill warm", upcoming: "pill" };
const RETURN_LABEL = { ok: "Filed", due: "Due soon", upcoming: "Upcoming" };

async function main() {
  const user = await requireRole("school_leader");
  if (!user) return;
  const content = LEADER_CONTENT[user.id] || {
    stats: { learners: 0, teachers: 0, classes: 0, attendance: 0 },
    classes: [], returns: [], visits: [],
  };

  $("#sideAvatar").textContent = initials(user.fullName);
  $("#sideName").textContent = user.fullName;
  $("#sideMeta").textContent = `School Leader · ${user.county || "—"}`;
  $("#greeting").textContent = `Habari, ${(user.fullName || "there").split(" ")[0]}`;
  $("#topSub").textContent = `${user.school || "No school set"} · Term 2, 2026`;

  const { stats } = content;
  $("#statRow").innerHTML = `
    <div class="stat-tile"><div class="s-label">${svg(ICON.learners)}Learners</div><div class="s-num">${stats.learners}</div><div class="s-sub">enrolled</div></div>
    <div class="stat-tile"><div class="s-label">${svg(ICON.teachers)}Teachers</div><div class="s-num">${stats.teachers}</div><div class="s-sub">on staff</div></div>
    <div class="stat-tile"><div class="s-label">${svg(ICON.classes)}Classes</div><div class="s-num">${stats.classes}</div><div class="s-sub">running this term</div></div>
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
    : `<div class="empty-state">No classes recorded yet.</div>`;

  $("#returnList").innerHTML = content.returns.length
    ? content.returns.map((r) => `
      <div class="task-row"><div style="flex:1"><b>${esc(r.term)}</b><span>${esc(r.detail)}</span></div>
        <span class="${RETURN_PILL[r.state] || "pill"}">${RETURN_LABEL[r.state] || r.state}</span></div>`).join("")
    : `<div class="empty-state">No returns on record yet.</div>`;

  $("#visitList").innerHTML = content.visits.length
    ? content.visits.map((v) => `
      <div class="task-row"><div><b>${esc(v.label)}</b><span>${esc(v.detail)}</span></div></div>`).join("")
    : `<div class="empty-state">No field visits recorded yet.</div>`;

  /* Content library. As head of institution, the school leader sees all
     three shelves: Teacher Resources (staff-only), the learner-facing
     Digital Library, and anything addressed specifically to school
     leadership. */
  $("#resourceList").innerHTML = `<div class="empty-state">Loading…</div>`;
  $("#libraryList").innerHTML = `<div class="empty-state">Loading…</div>`;
  $("#headOnlyList").innerHTML = `<div class="empty-state">Loading…</div>`;
  getLibrary().then((library) => {
    const row = (l) => `
      <div class="task-row"><div><b>${esc(l.title)}</b><span>${esc(l.subject)}${
        l.description ? " — " + esc(l.description) : ""}</span>${libraryFilesHtml(l)}</div></div>`;
    const folders = (list) => groupByType(list, CONTENT_TYPES).map(({ type, items }) => `
      <div class="list-group">
        <div class="list-group-title">${esc(type)}<span class="count">${items.length}</span></div>
        ${items.map(row).join("")}
      </div>`).join("");
    const resources = library.filter((l) => normalizeLibraryAudience(l.audience) === "staff");
    const shared = library.filter((l) => normalizeLibraryAudience(l.audience) === "library");
    const headOnly = library.filter((l) => normalizeLibraryAudience(l.audience) === "school_leader");
    $("#resourceList").innerHTML = resources.length
      ? folders(resources)
      : `<div class="empty-state">No teacher resources uploaded yet.</div>`;
    $("#libraryList").innerHTML = shared.length
      ? folders(shared)
      : `<div class="empty-state">Nothing in the library yet.</div>`;
    $("#headOnlyList").innerHTML = headOnly.length
      ? folders(headOnly)
      : `<div class="empty-state">Nothing addressed to school heads yet.</div>`;
  });

  /* My learning activity — every "Open to read" click above (and on the
     other shelves) is timed from open to return; see nav.js. */
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

  /* Forms the Education Team has sent to school heads — same
     create-once-fill-once loop as the teacher dashboard. */
  renderForms();
  async function renderForms() {
    $("#formsList").innerHTML = `<div class="empty-state">Loading…</div>`;
    const [allForms, responses] = await Promise.all([getForms(), getResponses()]);
    const forms = allForms.filter((f) => f.audience === "school_leader");
    const answeredFormIds = new Set(responses.filter((r) => r.respondentId === user.id).map((r) => r.formId));

    $("#formsList").innerHTML = forms.length
      ? forms.map((f) => {
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
      btn.addEventListener("click", () => openFormFill(btn.dataset.fillForm, forms, btn))
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
        respondentRole: "school_leader",
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
