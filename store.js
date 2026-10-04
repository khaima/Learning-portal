/* ============================================================
   HPF Digital Learning Portal — data access.

   Every call goes to the `api` Edge Function (see api.js). The browser
   has no direct database or storage access. File uploads use a signed
   upload URL the API hands back; downloads use signed URLs the API puts
   on each file.

   What can be done offline — answers, handing in, marks, form responses,
   visits, reading — goes through sync.js: sent now when there's a
   connection, otherwise queued on this device with the change shown
   locally until it's sent. Everything else needs a connection.
   ============================================================ */

import { esc, groupByFolder } from "./util.js";
import { supabase } from "./supabase.js";
import { apiGet, apiSend, keepOffline, offlineCopy, OfflineError } from "./api.js";
import { youTubeEmbedUrl, viewableKind } from "./viewer.js";
import * as sync from "./sync.js";

const LIBRARY_BUCKET = "library";

/* ---------------------------------------------------------------- library */

export async function getLibrary() {
  const { items } = await apiGet("/library");
  return items || [];
}

/* Organizational folders (e.g. "Grade 4 Maths") the education team
   sorts content into — separate from a folder UPLOAD (many files as one
   item, see uploadLibraryFiles below). Every role that can see the
   library can list folders (same audience rules as items); only the
   education team can create/delete them. */
export async function getLibraryFolders() {
  const { folders } = await apiGet("/library/folders");
  return folders || [];
}
export async function createLibraryFolder(name, audience) {
  const { folder } = await apiSend("POST", "/library/folders", { name, audience });
  return folder;
}
export async function deleteLibraryFolder(id) {
  await apiSend("DELETE", `/library/folders/${id}`);
}
/* Moves an item into a folder, or back out to "Unfiled" (folderId: null).
   The folder must share the item's own destination (staff/library/
   school_leader) — the API enforces it. */
export async function setLibraryFolder(id, folderId) {
  const { item } = await apiSend("PATCH", `/library/${id}`, { folderId });
  return item;
}

/* Create a library item. `files` is the manifest [{ name, size }] the
   caller intends to upload; the API returns a signed upload URL per
   file, which uploadLibraryFiles() then PUTs to. `externalUrl` is the
   other way in — a link to a YouTube video, an article, another site —
   used instead of a file, not alongside one. */
export async function addLibraryItem(item) {
  const { item: saved } = await apiSend("POST", "/library", {
    title: item.title,
    subject: item.subject,
    type: item.type,
    audience: item.audience,
    description: item.description,
    fileName: item.fileName || null,
    isFolder: !!item.isFolder,
    files: (item.files || []).map((f) => ({ name: f.name, size: f.size })),
    externalUrl: item.externalUrl || null,
    folderId: item.folderId || null,
  });
  return saved;
}

/* A freshly uploaded item is a draft — real to the education team right
   away, invisible to everyone else until this flips it to published. */
export async function setLibraryPublished(id, published) {
  const { item } = await apiSend("PATCH", `/library/${id}`, { published });
  return item;
}

/* Fixes a mistake on an already-uploaded item (wrong subject, a typo in
   the title, the wrong destination…) in place — same id, same published
   state, never a second row. Pass only the fields that changed; the API
   ignores anything else and, if the destination changes without a new
   folderId, automatically clears a now-mismatched folder rather than
   leaving it inconsistent. */
export async function updateLibraryItem(id, patch) {
  const { item } = await apiSend("PATCH", `/library/${id}`, patch);
  return item;
}

/* Deletes the row and every uploaded file behind it (server-side); a
   link-only or metadata-only item just removes the row. */
export async function deleteLibraryItem(id) {
  await apiSend("DELETE", `/library/${id}`);
}

const safeSegment = (s) =>
  String(s).replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, " ").trim() || "file";

/* Upload one File, or every File in a folder pick (webkitdirectory).
   Returns a manifest for addLibraryItem: { fileName, fileSize, isFolder,
   files: [{ name, size }] }. The actual bytes are pushed straight to
   Storage via the signed upload URLs the API returns. */
export async function uploadLibraryFiles(item, fileList, onProgress) {
  const list = [...(fileList || [])].filter((f) => f && f.size >= 0);
  if (!list.length) return { fileName: null, fileSize: 0, isFolder: false, files: [] };

  const isFolder = list.length > 1 || !!list[0].webkitRelativePath;
  const folderName = isFolder && list[0].webkitRelativePath
    ? list[0].webkitRelativePath.split("/")[0]
    : null;

  const manifest = list.map((f) => ({
    name: f.webkitRelativePath || f.name,
    size: f.size,
  }));

  // Create the row + get one signed upload URL per file.
  const { item: saved, uploads } = await apiSend("POST", "/library", {
    title: item.title,
    subject: item.subject,
    type: item.type,
    audience: item.audience,
    description: item.description,
    fileName: folderName || list[0].name,
    isFolder,
    files: manifest,
    folderId: item.folderId || null,
  });

  let done = 0;
  for (let i = 0; i < list.length; i++) {
    const up = uploads[i];
    const { error } = await supabase.storage
      .from(LIBRARY_BUCKET)
      .uploadToSignedUrl(up.path, up.token, list[i], {
        contentType: list[i].type || undefined,
      });
    if (error) {
      await apiSend("DELETE", `/library/${saved.id}`).catch(() => {});
      throw error;
    }
    done += 1;
    if (onProgress) onProgress(done, list.length);
  }

  return saved;
}

export function formatBytes(n = 0) {
  if (!n) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/* "Open" affordance for a library item, shared by every dashboard.
   Files are VIEW-ONLY for everyone except the education team: the API
   sends every role a signed `viewUrl` (rendered inside the portal's own
   viewer, see viewer.js / nav.js), and only the education team an extra
   `downloadUrl`, which is the one thing that renders a Download button
   here. The view URL rides in data-view-url on a button, not an <a
   href>, so there's no plain file link to right-click → "Save link as".

   data-track-item / data-file-name / data-item-title let the delegated
   listener in nav.js time the visit and open the viewer. An item that
   points at an external link has no files; a YouTube link plays in the
   viewer via data-yt-embed, anything else opens in a new tab since most
   sites block being framed. */
const OPEN_ICON = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>`;
const DOWNLOAD_ICON = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>`;

/* Saved on this device, to read without a connection — for what the
   portal's own viewer shows offline (PDF, images, video, audio, text).
   Word/Excel/PowerPoint go through Microsoft's online viewer, so they
   can't be. It's a copy for the viewer, never a download to keep. */
const OFFLINE_KINDS = new Set(["pdf", "image", "video", "audio", "text"]);
export function saveOfflineButton(item, f) {
  if (!OFFLINE_KINDS.has(viewableKind(f.name))) return "";
  const saved = sync.savedFile(item.id, f.name);
  return `<button type="button" class="lib-save${saved ? " is-saved" : ""}" data-save-offline="${esc(item.id)}" data-file-name="${esc(f.name)}"
    data-item-title="${esc(item.title)}" data-view-url="${esc(f.viewUrl || "")}" data-size="${Number(f.size) || 0}"
    title="${saved ? "Saved on this device — tap to remove" : "Save on this device to read without a connection"}">${saved ? "✓ Offline" : "Save offline"}</button>`;
}

function openButton(item, f, label, cls = "lib-open") {
  return `<button type="button" class="${cls}" data-track-item="${esc(item.id)}" data-file-name="${esc(f.name)}" data-item-title="${esc(item.title)}" data-view-url="${esc(f.viewUrl || "")}"${
    f.downloadUrl ? ` data-can-download="1"` : ""}>${label}</button>`;
}
function downloadLink(f) {
  return f.downloadUrl
    ? `<a class="lib-download" href="${esc(f.downloadUrl)}" download title="Download (Education Team only)">${DOWNLOAD_ICON}<span>Download</span></a>`
    : "";
}

export function libraryFilesHtml(item) {
  if (item.externalUrl) {
    const embed = youTubeEmbedUrl(item.externalUrl);
    return `<a class="lib-open" data-track-item="${esc(item.id)}" data-item-title="${esc(item.title)}"${
      embed ? ` data-yt-embed="${esc(embed)}"` : ""
    } href="${esc(item.externalUrl)}" target="_blank" rel="noopener">
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/></svg>
      ${embed ? "Watch video" : "Open link"}</a>`;
  }
  const files = item.files || [];
  if (!files.length) return "";
  if (files.length === 1) {
    const f = files[0];
    const size = f.size ? ` <span class="lib-size">${esc(formatBytes(f.size))}</span>` : "";
    return `<span class="lib-actions">${openButton(item, f, `${OPEN_ICON}<span>View</span>${size}`)}${saveOfflineButton(item, f)}${downloadLink(f)}</span>`;
  }
  const rows = files.map((f) => `<li>${openButton(item, f, esc(f.name), "lib-file-btn")}${
    f.size ? ` <span class="lib-size">${esc(formatBytes(f.size))}</span>` : ""}${saveOfflineButton(item, f)}${downloadLink(f)}</li>`).join("");
  return `<details class="lib-folder">
    <summary><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>
    ${files.length} files${item.fileSize ? ` <span class="lib-size">${esc(formatBytes(item.fileSize))}</span>` : ""}</summary>
    <ul>${rows}</ul></details>`;
}

/* ------------------------------------------------------------ library shelves
   One look for the library everywhere: the Education Team's Content
   Library and every other dashboard's Teacher Resources / Digital
   Library / For School Head shelves share the same folder sections and
   the same item row (type icon, title, subject · type, description,
   View). The education team's row adds management actions on top. */
const svgIcon = (paths) => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${paths}</svg>`;
const BOOK_ICON = '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/>';
const TYPE_ICON = {
  Video: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m10 9 5 3-5 3V9Z"/>',
  Worksheet: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  Reading: BOOK_ICON,
  "Lesson plan": '<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/>',
  Assessment: '<path d="m9 11 3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9"/>',
};
export const FOLDER_ICON_SVG = svgIcon('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>');

export function libraryTypeIcon(type) {
  return `<span class="lib-ic" data-type="${esc(type || "")}">${svgIcon(TYPE_ICON[type] || BOOK_ICON)}</span>`;
}

/* Read-only card, for everyone who uses the library rather than manages
   it. data-open-card makes the whole box clickable (nav.js forwards the
   click to its View / Open button). */
export function libraryItemCard(it) {
  return `
    <article class="lib-card" data-open-card>
      <div class="lib-card-top">
        ${libraryTypeIcon(it.type)}
        <span class="lib-card-type">${esc(it.type || "Other")}</span>
      </div>
      <b class="lib-card-title" title="${esc(it.title)}">${esc(it.title)}</b>
      <span class="lib-card-meta">${esc(it.subject)}</span>
      ${it.description ? `<p class="lib-card-desc">${esc(it.description)}</p>` : ""}
      <div class="lib-card-foot">${libraryFilesHtml(it)}</div>
    </article>`;
}

/* Folder sections (collapsible), "Unfiled" last, each a grid of cards —
   `rowFn` lets the education team pass its own card with management
   actions. */
export function librarySectionsHtml(items, folders, { rowFn = libraryItemCard, folderMeta } = {}) {
  return groupByFolder(items, folders).map(({ id, name, items: rows }) => `
    <details class="lib-section" open>
      <summary class="lib-section-head">
        <span class="lib-section-ic">${FOLDER_ICON_SVG}</span>
        <span class="lib-section-name">${esc(name)}</span>
        ${folderMeta && id ? `<span class="lib-section-dest">${esc(folderMeta(id) || "")}</span>` : ""}
        <span class="count">${rows.length}</span>
      </summary>
      <div class="lib-section-body lib-grid">${rows.map((r) => rowFn(r)).join("")}</div>
    </details>`).join("");
}

/* A Resources page: every shelf on it plus one search box that filters
   all of them together. Safe to call again (e.g. from a retry) — the
   search box keeps a single listener that always redraws the latest
   shelves. `shelves`: [{ el, countEl?, items, emptyMsg }]. */
export function mountLibraryShelves(shelves, folders, searchInput) {
  const draw = () => {
    const q = (searchInput?.value || "").trim().toLowerCase();
    for (const s of shelves) {
      const shown = q
        ? s.items.filter((it) => [it.title, it.subject, it.type, it.description]
            .some((v) => (v || "").toLowerCase().includes(q)))
        : s.items;
      if (s.countEl) s.countEl.textContent = s.items.length ? `${s.items.length} item${s.items.length === 1 ? "" : "s"}` : "";
      s.el.innerHTML = !s.items.length
        ? `<div class="empty-state">${esc(s.emptyMsg)}</div>`
        : shown.length
          ? librarySectionsHtml(shown, folders)
          : `<div class="empty-state">Nothing here matches “${esc(q)}”.</div>`;
    }
  };
  if (searchInput) {
    searchInput._drawShelves = draw;
    if (!searchInput._shelfListener) {
      searchInput._shelfListener = true;
      searchInput.addEventListener("input", () => searchInput._drawShelves());
    }
  }
  draw();
}

/* Home-page teaser: the newest few items as cards, then a link to the
   full shelf. */
export function libraryPreviewHtml(items, { emptyMsg, limit = 4, moreHref = "#resources" } = {}) {
  if (!items.length) return `<div class="empty-state">${esc(emptyMsg)}</div>`;
  const more = items.length - limit;
  return `<div class="lib-grid">${items.slice(0, limit).map(libraryItemCard).join("")}</div>${
    more > 0 ? `<a class="shelf-more" href="${esc(moreHref)}">+${more} more — see all</a>` : ""}`;
}

/* ------------------------------------------------------------ content-library usage
   Real, honest engagement tracking — see the long comment in the Edge
   Function for exactly what "duration" does and doesn't mean here. */

export async function startLibraryInteraction(itemId) {
  const { interaction } = await apiSend("POST", `/library/${itemId}/interactions`, {});
  return interaction;
}

export async function completeLibraryInteraction(interactionId) {
  const { interaction } = await apiSend("PATCH", `/library/interactions/${interactionId}/complete`, {});
  return interaction;
}

/* Called once, client-side, when a viewer session on one resource has
   stayed open past the celebration threshold — see nav.js. The server
   is the one that decides whether this is actually the first time (a
   repeat call just comes back {awarded:false, alreadyAwarded:true}). */
export async function awardLibraryBadge(itemId, secondsEngaged) {
  return apiSend("POST", `/library/${itemId}/badge`, { secondsEngaged });
}

/* The signed-in actor's own reading history — used for the "My learning
   activity" panel on every dashboard that has a library. */
export async function getMyLibraryUsage() {
  return apiGet("/library/interactions/mine");
}

/* Education team only: the portal-wide usage report, optionally scoped
   to one school (omit for every school combined). */
export async function getLibraryUsage({ school } = {}) {
  const qs = school ? `?school=${encodeURIComponent(school)}` : "";
  return apiGet(`/library/usage${qs}`);
}

/* ---------------------------------------------------------------- forms */

export async function getForms() {
  const { forms } = await apiGet("/forms");
  return forms || [];
}

/* A form is built in the portal (kind "questions"), an uploaded file
   ("file" — pass `file`, it's pushed to Storage through the signed URL
   the API returns), or a link to another site ("link"). `county` null =
   every county; `visitType` (field officers only) makes it part of that
   kind of school visit instead of a stand-alone form. */
export async function addForm(form) {
  const file = form.kind === "file" ? form.file : null;
  const { form: saved, uploads } = await apiSend("POST", "/forms", {
    title: form.title,
    description: form.description,
    audience: form.audience,
    kind: form.kind || "questions",
    county: form.county || null,
    visitType: form.visitType || null,
    externalUrl: form.externalUrl || null,
    questions: form.questions || [],
    files: file ? [{ name: file.name, size: file.size }] : [],
    dueOn: form.dueOn || null,
  });
  if (file && uploads?.[0]) {
    const { error } = await supabase.storage.from(LIBRARY_BUCKET)
      .uploadToSignedUrl(uploads[0].path, uploads[0].token, file, { contentType: file.type || undefined });
    if (error) {
      await apiSend("DELETE", `/forms/${saved.id}`).catch(() => {});
      throw error;
    }
  }
  return saved;
}

/* Only for a form nobody has answered — the API refuses otherwise. */
export async function deleteForm(id) {
  await apiSend("DELETE", `/forms/${id}`);
}

/* Archive: stops reaching anyone, keeps every response. Restore undoes it. */
export async function archiveForm(id) {
  const { form } = await apiSend("POST", `/forms/${id}/archive`);
  return form;
}
export async function restoreForm(id) {
  const { form } = await apiSend("POST", `/forms/${id}/restore`);
  return form;
}

/* Uploads a filled copy of a `file` form; returns the reference to send
   along with the response ({ name, path, size }). */
export async function uploadFilledForm(formId, file) {
  return uploadOrKeep(file, `/forms/${formId}/response-upload`, { name: file.name, size: file.size });
}

/** Uploads a file now, or — without a connection — keeps it on this device
    to upload at sync (the reference says so: { name, size, pendingUpload }). */
async function uploadOrKeep(file, uploadPath, uploadBody) {
  if (sync.isOnline()) {
    try {
      const { upload } = await apiSend("POST", uploadPath, uploadBody);
      const { error } = await supabase.storage.from(LIBRARY_BUCKET)
        .uploadToSignedUrl(upload.path, upload.token, file, { contentType: file.type || undefined });
      if (error) throw error;
      return { name: file.name, path: upload.path, size: file.size };
    } catch (err) {
      if (!sync.isNetworkError(err)) throw err;
    }
  }
  return sync.stashUpload(file, { uploadPath, uploadBody });
}

export async function getResponses() {
  const { responses } = await apiGet("/responses");
  return responses || [];
}

/** Sends a form response — or queues it offline: then { queued: true }. */
export async function addResponse(r) {
  const key = r.visitId ? `form:${r.formId}:${r.visitId}` : `form:${r.formId}`;
  const { data, queued } = await sync.send({
    method: "POST", path: "/responses",
    body: { formId: r.formId, answers: r.answers || [], files: r.files || [], ...(r.visitId ? { visitId: r.visitId } : {}) },
    label: `Form: ${r.title || "response"}`, kind: "form-response", group: key, dedupe: key,
  });
  return queued ? { queued: true } : data.response;
}
/** A form's due date (null clears it): everyone it reaches is reminded as it comes due. */
export async function setFormDue(id, dueOn) {
  const { form } = await apiSend("PATCH", `/forms/${id}`, { dueOn: dueOn || null });
  return form;
}

/* ---------------------------------------------------------------- notifications
   Stored on the server with when they were sent and read. Reading one
   offline is queued like any other offline activity. */
export const getNotifications = () => apiGet("/notifications");
export async function readNotification(id, title = "") {
  return sync.send({ method: "POST", path: `/notifications/${id}/read`, body: {}, label: `Read: ${title || "notification"}`, kind: "notification-read", dedupe: `nread:${id}` });
}
export const readAllNotifications = () => apiSend("POST", "/notifications/read-all", {});
export const notificationLog = (params = {}) => apiGet(`/notifications/log${qs(params)}`);
export const runNotificationsNow = () => apiSend("POST", "/notifications/run-now", {});

/* ---------------------------------------------------------------- assignments
   Teachers build assignments for the classes they teach; learners open,
   save and hand them in; teachers mark them. The API decides who sees
   what (class and school) — these are only the calls. */

export async function getSubjects() {
  const { subjects } = await apiGet("/subjects");
  return subjects || [];
}
export async function createSubject(name) {
  const { subject } = await apiSend("POST", "/subjects", { name });
  return subject;
}

// staff
export async function getStaffAssignments(params = {}) {
  const { assignments } = await apiGet(`/assignments${qs(params)}`);
  return assignments || [];
}
/** { assignment, questions, roster } */
export async function getAssignment(id) {
  return apiGet(`/assignments/${id}`);
}
export async function createAssignment(fields) {
  return apiSend("POST", "/assignments", fields);
}
export async function updateAssignment(id, fields) {
  return apiSend("PATCH", `/assignments/${id}`, fields);
}
export async function setAssignmentStatus(id, status) {
  return apiSend("POST", `/assignments/${id}/status`, { status });
}
export async function deleteAssignment(id) {
  return apiSend("DELETE", `/assignments/${id}`);
}
export async function getSubmissions(params = {}) {
  const { submissions } = await apiGet(`/submissions${qs(params)}`);
  return submissions || [];
}
/** { submission, learner, assignment, questions, answers } */
export async function getSubmission(id) {
  return apiGet(`/submissions/${id}`);
}
/** Saves marks — or queues them offline, with the marks this device last
    saw (baseMarkedAt) so a clash with someone else's marking is caught. */
export async function markSubmission(id, { answers, feedback }, { baseMarkedAt = null, label = "Marks" } = {}) {
  const { data, queued } = await sync.send({
    method: "POST", path: `/submissions/${id}/mark`,
    body: { answers, feedback }, offlineBody: { answers, feedback, baseMarkedAt },
    label, kind: "mark", group: `mark:${id}`, dedupe: `mark:${id}`, touches: [`/submissions/${id}`],
    meta: { submissionId: id },
    local: () => localMarks(id, answers, feedback),
  });
  if (queued && !data) throw new OfflineError("You're offline, and this work isn't saved on this device.");
  return queued ? { ...data, queued: true } : data;
}

/** This device's copy of a submission, marked locally until the marks are sent. */
async function localMarks(id, answers, feedback) {
  const d = await offlineCopy(`/submissions/${id}`);
  if (!d) return null;
  const v = structuredClone(d);
  const given = new Map((answers || []).map((x) => [x.questionId, x]));
  let total = 0, max = 0;
  for (const q of v.questions || []) {
    const g = given.get(q.id);
    let a = v.answers.find((x) => x.questionId === q.id);
    if (!a) { a = { questionId: q.id, response: null }; v.answers.push(a); }
    if (g) { a.marks = g.marks; a.feedback = g.feedback ?? a.feedback ?? null; }
    total += Number(a.marks ?? a.autoMarks ?? 0);
    max += Number(q.maxMarks) || 0;
  }
  v.submission = {
    ...v.submission, status: "marked", marks: total, maxMarks: max, percentage: max ? Math.round((total / max) * 1000) / 10 : 0,
    band: null, feedback: feedback ?? v.submission.feedback ?? null, localMarkedAt: new Date().toISOString(),
  };
  v.pendingSync = true;
  await keepOffline(`/submissions/${id}`, v);
  return v;
}

sync.registerKind("mark", {
  async applied(item, reply) { if (reply?.submission) await keepOffline(`/submissions/${item.meta.submissionId}`, reply); },
  async settled(item, server) {
    if (server?.submission) await keepOffline(`/submissions/${item.meta.submissionId}`, server);
    else if (sync.isOnline()) await getSubmission(item.meta.submissionId).catch(() => {});
  },
});

// learner
export async function getMyAssignments() {
  const { assignments } = await apiGet("/learner/assignments");
  return assignments || [];
}
/** { assignment, resource, questions, submission, completion, cannotWork, answers } */
export async function getMyAssignment(id) {
  return apiGet(`/learner/assignments/${id}`);
}
/* ---- a learner's work, online or offline ----
   Start, save and hand in go straight to the server when there's a
   connection. Without one they're queued (one queued copy of the answers
   per assignment — a later save or the hand-in replaces it) and this
   device's copy of the assignment shows them, marked "waiting to sync".
   The queued copy carries the time the device last heard from the server
   (baseSavedAt), so answers changed on another device meanwhile come
   back as a conflict instead of being overwritten. */
const asgPath = (id) => `/learner/assignments/${id}`;
const ASG_LIST = "/learner/assignments";

async function learnerWork(id, what, { method, path, answers, submit = false }) {
  const view = await offlineCopy(asgPath(id));
  const title = view?.assignment?.title ? `“${view.assignment.title}”` : "an assignment";
  const base = view?.submission?.lastSavedAt ?? null;
  const body = answers ? { answers } : {};
  const { data, queued } = await sync.send({
    method, path, body,
    offlineBody: answers ? { ...body, baseSavedAt: base, ...(submit ? { clientSubmittedAt: new Date().toISOString() } : {}) } : body,
    label: `${what} ${title}`, kind: "learner-work", group: `asg:${id}`,
    dedupe: answers ? `asg-work:${id}` : `asg-start:${id}`,
    touches: [asgPath(id), ASG_LIST], meta: { assignmentId: id },
    local: () => localAssignment(id, { start: !answers, answers, submit }),
  });
  if (queued && !data) throw new OfflineError("You're offline, and this assignment isn't saved on this device yet.");
  return queued ? { ...data, queued: true } : data;
}

/** This device's copy of an assignment (and the list), with the offline work on it. */
async function localAssignment(id, { start, answers, submit }) {
  const view = await offlineCopy(asgPath(id));
  if (!view) return null;
  const v = structuredClone(view);
  const now = new Date().toISOString();
  v.submission = v.submission || { status: "in_progress", startedAt: now, lastSavedAt: null, submittedAt: null, isLate: false };
  if (start && v.completion === "not_started") v.completion = "in_progress";
  if (answers) {
    const byQ = new Map((v.answers || []).map((a) => [a.questionId, a]));
    for (const a of answers) byQ.set(a.questionId, { ...(byQ.get(a.questionId) || {}), questionId: a.questionId, response: a.response ?? null, files: a.files ?? byQ.get(a.questionId)?.files ?? [] });
    v.answers = [...byQ.values()];
    v.completion = v.completion === "not_started" ? "in_progress" : v.completion;
    v.submission = { ...v.submission, localSavedAt: now };
  }
  if (submit) {
    v.completion = "submitted";
    v.submission = { ...v.submission, status: "submitted", submittedAt: now, offlineSubmittedAt: now };
  }
  v.pendingSync = true;
  await keepOffline(asgPath(id), v);
  await patchAssignmentList(id, v, { pendingSync: true });
  return v;
}
async function patchAssignmentList(id, view, extra = {}) {
  const list = await offlineCopy(ASG_LIST);
  const row = list?.assignments?.find((a) => a.id === id);
  if (!row) return;
  row.completion = view.completion;
  row.submission = view.submission ? { ...(row.submission || {}), ...view.submission } : row.submission;
  row.canWork = view.completion === "in_progress" || view.completion === "not_started" ? !view.cannotWork : false;
  row.pendingSync = !!extra.pendingSync;
  await keepOffline(ASG_LIST, list);
}

sync.registerKind("learner-work", {
  async applied(item, reply) {
    if (!reply?.assignment) return;
    await keepOffline(asgPath(item.meta.assignmentId), reply);
    await patchAssignmentList(item.meta.assignmentId, reply);
  },
  async settled(item, server) {
    const id = item.meta.assignmentId;
    if (server?.assignment) {
      await keepOffline(asgPath(id), server);
      await patchAssignmentList(id, server);
    } else if (sync.isOnline()) {
      await getMyAssignment(id).catch(() => {});
      await getMyAssignments().catch(() => {});
    }
  },
});

export async function startAssignment(id) {
  return learnerWork(id, "Started", { method: "POST", path: `${asgPath(id)}/start` });
}
export async function saveAssignmentAnswers(id, answers) {
  return learnerWork(id, "Answers for", { method: "PUT", path: `${asgPath(id)}/answers`, answers });
}
export async function submitAssignment(id, answers) {
  return learnerWork(id, "Handed in", { method: "POST", path: `${asgPath(id)}/submit`, answers, submit: true });
}
/** Uploads one file for a file-upload question — or keeps it on this device
    until there's a connection. Returns the reference to send with the answer. */
export async function uploadAnswerFile(assignmentId, questionId, file) {
  return uploadOrKeep(file, `${asgPath(assignmentId)}/upload`, { questionId, name: file.name, size: file.size });
}

/** Results grouped `by` learner | class | subject | grade | term | year |
    school | assignment. Each row has completion and achievement, kept
    apart: { by, bands, overall, rows }. */
export async function getResults(params = {}) {
  return apiGet(`/results${qs(params)}`);
}

/* A school leader's own school in one call: real teacher/learner counts,
   assignment completion, a grade-level breakdown, and recent field visits
   — aggregates only, never an individual learner's row. */
export async function getSchoolOverview() {
  return apiGet("/school/overview");
}

/* ---------------------------------------------------------------- field reports */

export async function getFieldReports() {
  const { reports } = await apiGet("/field-reports");
  return reports || [];
}

/* `responses`: the visit's forms as filled in during it —
   [{ formId, answers?, files? }] — saved together with the report. */
/* `clientRef` is the visit's own id from this device: sending the same
   visit again returns the saved one instead of a duplicate. */
/* Offline, the visit (with any filled copies, kept as files on this device)
   is queued and sent when the connection is back: then { queued: true }. */
export async function addFieldReport({ schoolId, visitType, responses = [], clientRef, label = "Field visit" }) {
  const { data, queued } = await sync.send({
    method: "POST", path: "/field-reports", body: { schoolId, visitType, responses, clientRef },
    label, kind: "field-visit", group: `visit:${clientRef || schoolId}`,
  });
  return queued ? { queued: true } : data.report;
}

/* ---------------------------------------------------------------- schools directory
   The fixed county list and the education team's school list — every
   County → School picker in the portal fills from here, never free text,
   so a school is always the same school everywhere. Each school has a
   code (NRK-001); everyone placed in it gets a personal code under it
   (NRK-001-T01 teacher, -H01 head, -L0001 learner) from the API. */
export async function getSchools() {
  const { counties, countyCodes, schools } = await apiGet("/schools");
  return { counties: counties || [], countyCodes: countyCodes || {}, schools: schools || [] };
}
export async function createCounty(name, code) {
  const { county } = await apiSend("POST", "/counties", { name, code });
  return county;
}
export async function deleteCounty(name) {
  await apiSend("DELETE", `/counties/${encodeURIComponent(name)}`);
}

/* Keeps a page's county/school lists live: loads now, then again every
   time the tab comes back into view and once a minute while it's being
   looked at — so a school the Education Team adds shows up in someone
   else's open dropdown without them reloading. `onData` gets every fresh
   copy; `onError` only the first-load failure (a later background
   refresh failing just keeps the list it already has). */
export function watchSchools(onData, onError) {
  let loaded = false;
  const refresh = async () => {
    try {
      const data = await getSchools();
      loaded = true;
      onData(data);
      return data;
    } catch (err) {
      if (!loaded) onError?.(err);
      return null;
    }
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && loaded) refresh();
  });
  setInterval(() => { if (document.visibilityState === "visible" && loaded) refresh(); }, 60 * 1000);
  refresh();
  return { refresh };
}
export async function createSchool(name, county) {
  const { school } = await apiSend("POST", "/schools", { name, county });
  return school;
}
export async function renameSchool(id, name) {
  const { school } = await apiSend("PATCH", `/schools/${id}`, { name });
  return school;
}
export async function deleteSchool(id) {
  await apiSend("DELETE", `/schools/${id}`);
}

/* Fills a County <select> and a School <select> that narrows to the
   picked county. Returns a small controller: `current()` is the chosen
   school record (or null), `county()` the chosen county, and
   `update(data)` swaps in a fresh list (see watchSchools) while keeping
   whatever is picked — unless that county/school was removed, in which
   case the pick is cleared. `onChange` fires after every update too. */
export function wireSchoolPicker(countySel, schoolSel, data, { countyId, schoolId, onChange } = {}) {
  let { counties, schools } = data;
  const fillCounties = (keep) => {
    countySel.innerHTML = `<option value="">Select county</option>${
      counties.map((c) => `<option>${esc(c)}</option>`).join("")}`;
    countySel.value = counties.includes(keep) ? keep : "";
  };
  const fillSchools = (keepId) => {
    const list = schools.filter((s) => s.county === countySel.value);
    schoolSel.disabled = !countySel.value || !list.length;
    schoolSel.innerHTML = !countySel.value
      ? `<option value="">Select a county first</option>`
      : list.length
        ? `<option value="">Select school</option>${list.map((s) =>
            `<option value="${esc(s.id)}">${esc(s.name)} (${esc(s.code)})</option>`).join("")}`
        : `<option value="">No schools listed for ${esc(countySel.value)} yet</option>`;
    schoolSel.value = list.some((s) => s.id === keepId) ? keepId : "";
  };
  const current = () => schools.find((s) => s.id === schoolSel.value) || null;
  const selectedSchool = schools.find((s) => s.id === schoolId) || null;
  fillCounties(selectedSchool?.county || countyId || "");
  fillSchools(selectedSchool?.id);
  countySel.addEventListener("change", () => { fillSchools(); onChange?.(current()); });
  schoolSel.addEventListener("change", () => onChange?.(current()));
  return {
    current,
    county: () => countySel.value,
    update(next) {
      const before = { county: countySel.value, school: schoolSel.value };
      ({ counties, schools } = next);
      fillCounties(before.county);
      fillSchools(before.school);
      onChange?.(current()); // the pick may be gone, or renamed (hints show its name/code)
    },
  };
}

/* ---------------------------------------------------------------- stats */

/* Pass a county and/or school to scope the whole Overview page —
   accounts, assignment completion, field visits, grade breakdowns — to
   that region or that one school; omit both for the portal-wide view.
   from/to (ISO yyyy-mm-dd) scope new-learner intake and field visits to a
   date range — the only two metrics with a real date to filter by; every
   other number (assignments, forms, library) has no date column and stays
   portal-wide regardless of from/to. topGrades caps the "grade
   performance" ranking to the top N grades (0 or omitted = show every
   grade). */
/* ---------------------------------------------------------------- M&E (/mel)
   Programme → outcomes → indicators → targets → actuals → evidence → report. */
export const melProgrammes = () => apiGet("/mel/programmes");
export const melProgramme = (id) => apiGet(`/mel/programmes/${id}`);
export const createMelProgramme = (body) => apiSend("POST", "/mel/programmes", body);
export const updateMelProgramme = (id, body) => apiSend("PATCH", `/mel/programmes/${id}`, body);
export const createMelOutcome = (body) => apiSend("POST", "/mel/outcomes", body);
export const updateMelOutcome = (id, body) => apiSend("PATCH", `/mel/outcomes/${id}`, body);
export const createMelIndicator = (body) => apiSend("POST", "/mel/indicators", body);
export const updateMelIndicator = (id, body) => apiSend("PATCH", `/mel/indicators/${id}`, body);
/** value null clears the target. */
export const setMelTarget = (body) => apiSend("PUT", "/mel/targets", body);
/** { programme, period, scope, outcomes: [{ indicators: [...] }], summary } */
export const melResults = (id, { period, county, school } = {}) => apiGet(`/mel/programmes/${id}/results${qs({ period, county, school })}`);
export const melBreakdown = (indicatorId, period) => apiGet(`/mel/indicators/${indicatorId}/breakdown${qs({ period })}`);
/** Every indicator (or those tagged for one dashboard: theme) with target, value and achievement. */
export const melDashboard = ({ period, county, school, theme } = {}) => apiGet(`/mel/dashboard${qs({ period, county, school, theme })}`);
export const melTrend = (indicatorId, { county, school } = {}) => apiGet(`/mel/indicators/${indicatorId}/trend${qs({ county, school })}`);
export const recordMelActual = (body) => apiSend("POST", "/mel/actuals", body);
export const verifyMelActual = (id, decision, note = "") => apiSend("POST", `/mel/actuals/${id}/verify`, { decision, note });
export const melActual = (id) => apiGet(`/mel/actuals/${id}`);
export const addMelEvidence = (id, body) => apiSend("POST", `/mel/actuals/${id}/evidence`, body);
/** Uploads a file as evidence for an actual; returns the evidence id. */
export async function uploadMelEvidence(actualId, file, title) {
  const { upload } = await apiSend("POST", `/mel/actuals/${actualId}/evidence-upload`, { name: file.name, size: file.size });
  const { error } = await supabase.storage.from(LIBRARY_BUCKET)
    .uploadToSignedUrl(upload.path, upload.token, file, { contentType: file.type || undefined });
  if (error) throw error;
  return addMelEvidence(actualId, { kind: "file", title: title || file.name, file: { name: file.name, path: upload.path, size: file.size } });
}
export const melReports = (programmeId) => apiGet(`/mel/reports${qs({ programmeId })}`);
export const createMelReport = (body) => apiSend("POST", "/mel/reports", body);
export const melReport = (id) => apiGet(`/mel/reports/${id}`);
export const refreshMelReport = (id) => apiSend("POST", `/mel/reports/${id}/refresh`, {});
export const finalizeMelReport = (id, note = "") => apiSend("POST", `/mel/reports/${id}/finalize`, { note });

/* ---------------------------------------------------------------- Data Quality Center */
/** Score, counts by status / severity / type, scan history. Filters:
    county, school, type, severity, status (or "active"), from, to. */
export async function dqSummary(params = {}) {
  return apiGet(`/data-quality/summary${qs(params)}`);
}
/** { total, issues } — same filters, plus q, limit, offset. */
export async function dqIssues(params = {}) {
  return apiGet(`/data-quality/issues${qs(params)}`);
}
/** { issue, details, events, fixes, moves } */
export async function dqIssue(id) {
  return apiGet(`/data-quality/issues/${id}`);
}
export async function dqSetStatus(id, status, note = "") {
  return apiSend("PATCH", `/data-quality/issues/${id}`, { status, note });
}
export async function dqBulkStatus(ids, status, note = "") {
  return apiSend("POST", "/data-quality/issues/bulk", { ids, status, note });
}
export async function dqFix(id, body) {
  return apiSend("POST", `/data-quality/issues/${id}/fix`, body);
}
export async function dqScan({ auto = false } = {}) {
  return apiSend("POST", `/data-quality/scan${auto ? "?auto=1" : ""}`, {});
}

/** The impact dashboards — executive overview, reach, learning, teacher
    development, field operations and digital resources — under the same
    filters as getStats. */
export async function getImpact({ county, school, from, to } = {}) {
  return apiGet(`/impact${qs({ county, school, from, to })}`);
}

/* ---------------------------------------------------------------- training register */
export async function getTrainings({ archived = false } = {}) {
  return apiGet(`/trainings${archived ? "?archived=1" : ""}`);
}
export async function getTraining(id) {
  const { training } = await apiGet(`/trainings/${id}`);
  return training;
}
export async function trainingTeachers() {
  const { teachers } = await apiGet("/trainings/teachers");
  return teachers || [];
}
export const createTraining = (body) => apiSend("POST", "/trainings", body);
export const updateTraining = (id, patch) => apiSend("PATCH", `/trainings/${id}`, patch);

export async function getStats({ county, school, from, to, topGrades } = {}) {
  const params = new URLSearchParams();
  if (county) params.set("county", county);
  if (school) params.set("school", school);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (topGrades) params.set("topGrades", String(topGrades));
  const qs = params.toString();
  return apiGet(`/stats${qs ? `?${qs}` : ""}`);
}

/* ---------------------------------------------------------------- staff accounts (education team) */

/* Every staff account (teacher, school leader, field officer, education
   team) — email, role, school, county. Passwords/PINs are one-way hashed
   server-side and never come back here. */
export async function getUsers() {
  const { users } = await apiGet("/users");
  return users || [];
}

export async function updateUser(id, patch) {
  const { user } = await apiSend("PATCH", `/users/${id}`, patch);
  return user;
}

/* Helping someone who can't sign in (both audited on the server):
   - a reset link, emailed to them — they choose their own password;
   - a temporary password, returned once to show the administrator; they
     must replace it the first time they sign in with it. */
export async function sendUserResetLink(id) {
  const redirectTo = new URL("index.html?flow=recovery", window.location.href).href;
  return apiSend("POST", `/users/${id}/reset-link`, { redirectTo });
}
export async function issueTemporaryPassword(id) {
  return apiSend("POST", `/users/${id}/temporary-password`, {});
}

/* ---- account governance (administrators) ----
   The API decides who may do each of these; these are just the calls. */

/** Every staff account plus, for the signed-in administrator, the roles
    they're allowed to give. Each user carries `canManage`. */
export async function getUserDirectory() {
  const res = await apiGet("/users");
  return { users: res.users || [], grantableRoles: res.grantableRoles || [] };
}
export async function approveUser(id, fields = {}) {
  const { user } = await apiSend("POST", `/users/${id}/approve`, fields);
  return user;
}
export async function rejectUser(id, reason = "") {
  const { user } = await apiSend("POST", `/users/${id}/reject`, { reason });
  return user;
}
/** action: "suspend" | "deactivate" | "reactivate" */
export async function setUserStatus(id, action, reason = "") {
  const { user } = await apiSend("POST", `/users/${id}/status`, { action, reason });
  return user;
}
/** { invitations, emailReady } — emailReady: the portal can email invitations. */
export async function getInvitations() {
  const { invitations, emailReady } = await apiGet("/users/invitations");
  return { invitations: invitations || [], emailReady: !!emailReady };
}
/* Invitations are a one-time link. Returns { invitation, token, emailed,
   emailError }: the token is shown once, to build the link to copy; with
   send, the portal also emails that same link (portalUrl says which copy
   of the portal it should point at — the server checks it's one of ours). */
const portalUrl = () => new URL(".", location.href).href;
export async function inviteStaff({ email, role, schoolId, county, send = false }) {
  return apiSend("POST", "/users/invitations", { email, role, schoolId, county, send, portalUrl: portalUrl() });
}
/** A fresh link for an unused invitation (the earlier one stops working), emailed or to copy. */
export async function renewInvitation(id, { send = false } = {}) {
  return apiSend("POST", `/users/invitations/${id}/renew`, { send, portalUrl: portalUrl() });
}
export async function revokeInvitation(id) {
  return apiSend("DELETE", `/users/invitations/${id}`);
}
/** Newest first; pass targetId for one account's history. */
export async function getAuditLog({ targetId, before } = {}) {
  const params = new URLSearchParams();
  if (targetId) params.set("targetId", targetId);
  if (before) params.set("before", String(before));
  const qs = params.toString();
  return apiGet(`/audit${qs ? `?${qs}` : ""}`);
}

/* ---------------------------------------------------------------- KoboToolbox */

/* Education Team: connection state (never returns the API token). */
export async function koboConfig() {
  return apiGet("/kobo/config");
}

/* Education Team: connect / update the KoboToolbox account. The token is
   verified against KoboToolbox server-side and stored only there. */
export async function saveKoboConfig({ baseUrl, apiToken, officerField }) {
  return apiSend("PUT", "/kobo/config", { baseUrl, apiToken, officerField });
}

/* Education Team: the account's deployed survey assets, to attach one. */
export async function koboAssets() {
  const { assets } = await apiGet("/kobo/assets");
  return assets || [];
}

/* Education Team: an in-portal preview link for one deployed survey
   (its actual questions), fetched on demand — kept out of koboAssets()
   above since it's only needed for the one being previewed right now. */
export async function koboAssetPreview(uid) {
  return apiGet(`/kobo/assets/${encodeURIComponent(uid)}/preview`);
}

/* Education Team: surveys attached to the portal, with submission counts. */
export async function koboForms() {
  const { forms } = await apiGet("/kobo/forms");
  return forms || [];
}

export async function attachKoboForm(assetUid) {
  const { form } = await apiSend("POST", "/kobo/forms", { assetUid });
  return form;
}

/* Archives the survey (hidden from field officers, history kept). */
export async function removeKoboForm(id) {
  return apiSend("DELETE", `/kobo/forms/${id}`);
}
export async function restoreKoboForm(id) {
  return apiSend("POST", `/kobo/forms/${id}/restore`);
}

/* Education Team: pull submissions from KoboToolbox and match officers. */
export async function syncKobo() {
  return apiSend("POST", "/kobo/sync");
}

/* Field Officer: the surveys to fill, each with a prefilled openUrl and
   a submitted flag (auto-detected from KoboToolbox, or set manually). */
export async function myKoboSurveys() {
  return apiGet("/kobo/my-surveys");
}

export async function markKoboSubmitted(id) {
  return apiSend("POST", `/kobo/my-surveys/${id}/submitted`);
}

/* Education Team / M&E: charts for one attached survey, from the portal's
   own validated records (only submissions that pass, or that someone
   accepted). County / school narrow it. */
export async function koboResults(id, { county, school } = {}) {
  return apiGet(`/kobo/forms/${id}/results${qs({ county, school })}`);
}

/* ---- the Kobo ingestion pipeline: validation, review, normalization ---- */
export async function koboPipeline(id) {
  return apiGet(`/kobo/forms/${id}/pipeline`);
}
export async function saveKoboMapping(id, mapping) {
  return apiSend("PUT", `/kobo/forms/${id}/mapping`, mapping);
}
export async function reprocessKobo(id) {
  return apiSend("POST", `/kobo/forms/${id}/reprocess`, {});
}
/** { total, records } — ?formId &status &rule &review=none|accepted|excluded &limit &offset */
export async function koboRecords(params) {
  return apiGet(`/kobo/records${qs(params)}`);
}
export async function koboRecord(id) {
  return apiGet(`/kobo/records/${id}`);
}
export async function reviewKoboRecord(id, decision, note = "") {
  return apiSend("POST", `/kobo/records/${id}/review`, { decision, note });
}
export async function koboSchoolAliases() {
  const { aliases } = await apiGet("/kobo/school-aliases");
  return aliases || [];
}
export async function saveKoboSchoolAlias(value, schoolId) {
  return apiSend("POST", "/kobo/school-aliases", { value, schoolId });
}
export async function removeKoboSchoolAlias(key) {
  return apiSend("DELETE", `/kobo/school-aliases/${encodeURIComponent(key)}`);
}
/** Creates (or replaces) the REST Service password. Shown once. */
export async function createKoboWebhook() {
  return apiSend("POST", "/kobo/webhook", {});
}
export async function removeKoboWebhook() {
  return apiSend("DELETE", "/kobo/webhook");
}

/* ---------------------------------------------------------------- learners, classes, enrollment
   The API decides which learners each person sees: a teacher their
   classes, a school head their school, administrators every school. */

const qs = (params) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

/** status: "active" (default) | "archived" | "all"; classId, schoolId, q optional. */
export async function getLearners(params = {}) {
  const { learners } = await apiGet(`/learners${qs(params)}`);
  return learners || [];
}

export async function addLearner({ fullName, username, grade, pin, classId, schoolId, gender }) {
  const { learner } = await apiSend("POST", "/learners", { fullName, username, grade, pin, classId, schoolId, gender });
  return learner;
}

export async function updateLearner(id, patch) {
  const { learner } = await apiSend("PATCH", `/learners/${id}`, patch);
  return learner;
}

/** Archives (status INACTIVE) — learners are never deleted. */
export async function deleteLearner(id) {
  return apiSend("DELETE", `/learners/${id}`);
}

/** status: ACTIVE (reactivate) | TRANSFERRED | DROPPED_OUT | COMPLETED | INACTIVE */
export async function setLearnerStatus(id, status, { reason, exitDate } = {}) {
  const { learner } = await apiSend("POST", `/learners/${id}/status`, { status, reason, exitDate });
  return learner;
}

export async function transferLearner(id, { toSchoolId, toClassId, reason, effectiveDate }) {
  const { learner } = await apiSend("POST", `/learners/${id}/transfer`, { toSchoolId, toClassId, reason, effectiveDate });
  return learner;
}

/** { learner, enrollments } — every school and class this learner has been in. */
export async function getLearnerHistory(id) {
  return apiGet(`/learners/${id}/history`);
}

/** A school's enrollment records; status "past" = everyone who has left or moved on. */
export async function getEnrollments({ schoolId, status } = {}) {
  const { enrollments } = await apiGet(`/enrollments${qs({ schoolId, status })}`);
  return enrollments || [];
}

/** { classes, schoolTeachers, academicYear } */
export async function getClasses(params = {}) {
  return apiGet(`/classes${qs(params)}`);
}
export async function createClass({ grade, name, schoolId }) {
  const { class: cls } = await apiSend("POST", "/classes", { grade, name, schoolId });
  return cls;
}
export async function updateClass(id, patch) {
  return apiSend("PATCH", `/classes/${id}`, patch);
}
export async function assignClassTeacher(classId, teacherId, role = "class_teacher") {
  return apiSend("POST", `/classes/${classId}/teachers`, { teacherId, role });
}
export async function removeClassTeacher(classId, teacherId) {
  return apiSend("DELETE", `/classes/${classId}/teachers/${teacherId}`);
}
export async function addClassSubject(classId, subjectId) {
  return apiSend("POST", `/classes/${classId}/subjects`, { subjectId });
}
export async function removeClassSubject(classId, subjectId) {
  return apiSend("DELETE", `/classes/${classId}/subjects/${encodeURIComponent(subjectId)}`);
}
export async function addLearnersToClass(classId, learnerIds) {
  return apiSend("POST", `/classes/${classId}/learners`, { learnerIds });
}
export async function removeLearnerFromClass(classId, learnerId) {
  return apiSend("DELETE", `/classes/${classId}/learners/${learnerId}`);
}
export async function promoteClass(classId, { toClassId, learnerIds } = {}) {
  return apiSend("POST", `/classes/${classId}/promote`, { toClassId, learnerIds });
}

export async function getAcademicYears() {
  return apiGet("/academic-years");
}
export async function createAcademicYear(id, { makeCurrent = false } = {}) {
  return apiSend("POST", "/academic-years", { id, makeCurrent });
}

/* "Term 3, 2026" — the school-calendar term today falls in, for dashboard
   headers. Picked by date rather than trusting currentTerm, so a copy saved
   on this device last term doesn't keep showing that term. "" when the
   calendar can't be loaded (offline before it was ever saved here) or
   today falls outside every term. */
export async function currentTermLabel() {
  try {
    const { years } = await getAcademicYears();
    const today = new Date().toISOString().slice(0, 10);
    for (const y of years || []) {
      const t = (y.terms || []).find((x) => x.startsOn <= today && today <= x.endsOn);
      if (t) return `Term ${t.termNo}, ${y.id}`;
    }
  } catch { /* header falls back to the school/county line */ }
  return "";
}

/* Read-only: this learner's real assignments + library usage/badges, for
   the teacher's "view a learner's activity" panel. */
export async function getLearnerActivity(id) {
  return apiGet(`/learners/${id}/activity`);
}
