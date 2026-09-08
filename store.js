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

const LIBRARY_BUCKET = "library";

/* ---------------------------------------------------------------- library */

export async function getLibrary() {
  const { items } = await apiGet("/library");
  return items || [];
}

/* Create a library item. `files` is the manifest [{ name, size }] the
   caller intends to upload; the API returns a signed upload URL per
   file, which uploadLibraryFiles() then PUTs to. */
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
  });
  return saved;
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

/* Download affordance for a library item, shared by every dashboard.
   The API already put a signed `downloadUrl` on each file. */
export function libraryFilesHtml(item) {
  const files = item.files || [];
  if (!files.length) return "";
  if (files.length === 1) {
    const f = files[0];
    return `<a class="lib-download" href="${esc(f.downloadUrl || "#")}" target="_blank" rel="noopener">
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14"/></svg>
      Download${f.size ? ` <span class="lib-size">${esc(formatBytes(f.size))}</span>` : ""}</a>`;
  }
  const rows = files.map((f) => `<li><a href="${esc(f.downloadUrl || "#")}" target="_blank" rel="noopener">${esc(f.name)}</a>${
    f.size ? ` <span class="lib-size">${esc(formatBytes(f.size))}</span>` : ""}</li>`).join("");
  return `<details class="lib-folder">
    <summary><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>
    ${files.length} files${item.fileSize ? ` <span class="lib-size">${esc(formatBytes(item.fileSize))}</span>` : ""}</summary>
    <ul>${rows}</ul></details>`;
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

export async function getStats() {
  return apiGet("/stats");
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
