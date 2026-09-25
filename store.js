/* ============================================================
   HPF Digital Learning Portal — data access.

   Every call goes to the `api` Edge Function (see api.js). The browser
   has no direct database or storage access. File uploads use a signed
   upload URL the API hands back; downloads use signed URLs the API puts
   on each file.
   ============================================================ */

import { esc } from "./util.js";
import { supabase } from "./supabase.js";
import { apiGet, apiSend } from "./api.js";
import { youTubeEmbedUrl } from "./viewer.js";

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
    return `<span class="lib-actions">${openButton(item, f, `${OPEN_ICON}<span>View</span>${size}`)}${downloadLink(f)}</span>`;
  }
  const rows = files.map((f) => `<li>${openButton(item, f, esc(f.name), "lib-file-btn")}${
    f.size ? ` <span class="lib-size">${esc(formatBytes(f.size))}</span>` : ""}${downloadLink(f)}</li>`).join("");
  return `<details class="lib-folder">
    <summary><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>
    ${files.length} files${item.fileSize ? ` <span class="lib-size">${esc(formatBytes(item.fileSize))}</span>` : ""}</summary>
    <ul>${rows}</ul></details>`;
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

export async function addForm(form) {
  const { form: saved } = await apiSend("POST", "/forms", {
    title: form.title,
    description: form.description,
    audience: form.audience,
    questions: form.questions,
  });
  return saved;
}

export async function getResponses() {
  const { responses } = await apiGet("/responses");
  return responses || [];
}

export async function addResponse(r) {
  const { response } = await apiSend("POST", "/responses", {
    formId: r.formId,
    answers: r.answers,
  });
  return response;
}

/* ---------------------------------------------------------------- assignments */

export async function getAssignments() {
  const { assignments } = await apiGet("/assignments");
  return assignments || [];
}

export async function markAssignmentDone(id) {
  const { assignment } = await apiSend("PATCH", `/assignments/${id}`, { done: true });
  return assignment;
}

/* Same endpoint, either direction — used by a teacher toggling one of
   their own learners' assignments from the "view a learner" panel. */
export async function setAssignmentDone(id, done) {
  const { assignment } = await apiSend("PATCH", `/assignments/${id}`, { done });
  return assignment;
}

/* Every assignment across a teacher's own roster in one call — feeds the
   teacher dashboard's grading queue and recent-results sections. */
export async function getTeacherAssignments() {
  const { assignments } = await apiGet("/teacher/assignments");
  return assignments || [];
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

export async function addFieldReport({ school, county, visitType }) {
  const { report } = await apiSend("POST", "/field-reports", { school, county, visitType });
  return report;
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
   server-side and never come back here; see resetUserPassword(). */
export async function getUsers() {
  const { users } = await apiGet("/users");
  return users || [];
}

export async function updateUser(id, patch) {
  const { user } = await apiSend("PATCH", `/users/${id}`, patch);
  return user;
}

/* Sets a brand-new password for a staff account — the old one is never
   readable, so this is the only way to "reset" it. */
export async function resetUserPassword(id, password) {
  return apiSend("POST", `/users/${id}/reset-password`, { password });
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

export async function removeKoboForm(id) {
  return apiSend("DELETE", `/kobo/forms/${id}`);
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

/* Education Team: aggregated results for one attached survey — the API
   pulls submissions + the form schema from KoboToolbox and tallies each
   question into chart-ready data. */
export async function koboResults(id) {
  return apiGet(`/kobo/forms/${id}/results`);
}

/* ---------------------------------------------------------------- learner roster (teacher) */

export async function getLearners() {
  const { learners } = await apiGet("/learners");
  return learners || [];
}

export async function addLearner({ fullName, username, grade, pin }) {
  const { learner } = await apiSend("POST", "/learners", { fullName, username, grade, pin });
  return learner;
}

export async function updateLearner(id, patch) {
  const { learner } = await apiSend("PATCH", `/learners/${id}`, patch);
  return learner;
}

export async function deleteLearner(id) {
  return apiSend("DELETE", `/learners/${id}`);
}

/* Read-only: this learner's real assignments + library usage/badges, for
   the teacher's "view a learner's activity" panel. */
export async function getLearnerActivity(id) {
  return apiGet(`/learners/${id}/activity`);
}
