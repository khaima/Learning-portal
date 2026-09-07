/* ============================================================
   HPF Digital Learning Portal — shared, org-wide data.

   Content library, forms, and form responses live in the real
   `learning_portal.library_items` / `.forms` / `.responses` tables
   (Supabase) — genuinely shared across every browser and device now,
   not a per-browser localStorage copy. That's what makes "the education
   team uploads a resource" or "creates a form" show up for a teacher or
   school leader signed in anywhere, not just the same browser.
   ============================================================ */

import { supabase } from "./supabase.js";
import { esc } from "./util.js";

export async function getLibrary() {
  const { data, error } = await supabase
    .from("library_items").select("*").order("uploaded_at", { ascending: false });
  if (error) { console.warn("could not load library:", error.message); return []; }
  return data.map((r) => ({
    id: r.id, title: r.title, subject: r.subject, type: r.type, audience: r.audience,
    description: r.description, uploadedBy: r.uploaded_by,
    fileName: r.file_name, fileSize: r.file_size || 0,
    isFolder: !!r.is_folder, files: Array.isArray(r.files) ? r.files : [],
  }));
}

export async function addLibraryItem(item) {
  const { error } = await supabase.from("library_items").insert({
    id: item.id, title: item.title, subject: item.subject, type: item.type, audience: item.audience,
    description: item.description, uploaded_by: item.uploadedBy,
    file_name: item.fileName || null, file_size: item.fileSize || 0,
    is_folder: !!item.isFolder, files: item.files || [],
  });
  if (error) console.warn("could not save library item:", error.message);
  return getLibrary();
}

/* Content-library file storage lives in the public `library` Storage
   bucket. Uploads go under `<itemId>/<relative path>` so a single item's
   files (one file, or a whole folder) stay grouped and easy to clear. */
export const LIBRARY_BUCKET = "library";

const safeSegment = (s) =>
  String(s).replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, " ").trim() || "file";
const safePath = (p) => String(p).split("/").map(safeSegment).join("/");

/* Upload one File (from an <input type="file">) or every File in a folder
   pick (webkitdirectory). Returns a manifest the library row stores:
   { fileName, fileSize, isFolder, files: [{ name, path, size }] }. */
export async function uploadLibraryFiles(itemId, fileList, onProgress) {
  const list = [...(fileList || [])].filter((f) => f && f.size >= 0);
  if (!list.length) return { fileName: null, fileSize: 0, isFolder: false, files: [] };

  const isFolder = list.length > 1 || !!list[0].webkitRelativePath;
  const folderName = isFolder && list[0].webkitRelativePath
    ? list[0].webkitRelativePath.split("/")[0]
    : null;

  const files = [];
  let done = 0;
  for (const file of list) {
    const rel = file.webkitRelativePath || file.name;
    const path = `${itemId}/${safePath(rel)}`;
    const { error } = await supabase.storage
      .from(LIBRARY_BUCKET)
      .upload(path, file, { upsert: true, contentType: file.type || undefined });
    if (error) { console.warn("upload failed:", rel, error.message); throw error; }
    files.push({ name: rel, path, size: file.size });
    done += 1;
    if (onProgress) onProgress(done, list.length);
  }

  return {
    fileName: folderName || list[0].name,
    fileSize: files.reduce((s, f) => s + (f.size || 0), 0),
    isFolder,
    files,
  };
}

/* A ready-to-use download URL for a stored file (public bucket). */
export function libraryFileUrl(file) {
  return supabase.storage
    .from(LIBRARY_BUCKET)
    .getPublicUrl(file.path, { download: file.name?.split("/").pop() || true })
    .data.publicUrl;
}

export function formatBytes(n = 0) {
  if (!n) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/* Download affordance for a library item, shared by every dashboard that
   lists the library. Nothing when the item is metadata-only (no file). */
export function libraryFilesHtml(item) {
  const files = item.files || [];
  if (!files.length) return "";
  if (files.length === 1) {
    const f = files[0];
    return `<a class="lib-download" href="${esc(libraryFileUrl(f))}" target="_blank" rel="noopener" download>
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14"/></svg>
      Download${f.size ? ` <span class="lib-size">${esc(formatBytes(f.size))}</span>` : ""}</a>`;
  }
  const rows = files.map((f) => `<li><a href="${esc(libraryFileUrl(f))}" target="_blank" rel="noopener" download>${esc(f.name)}</a>${
    f.size ? ` <span class="lib-size">${esc(formatBytes(f.size))}</span>` : ""}</li>`).join("");
  return `<details class="lib-folder">
    <summary><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>
    ${files.length} files${item.fileSize ? ` <span class="lib-size">${esc(formatBytes(item.fileSize))}</span>` : ""}</summary>
    <ul>${rows}</ul></details>`;
}

export async function getForms() {
  const { data, error } = await supabase
    .from("forms").select("*").order("created_at", { ascending: false });
  if (error) { console.warn("could not load forms:", error.message); return []; }
  return data.map((r) => ({
    id: r.id, title: r.title, description: r.description, audience: r.audience,
    createdBy: r.created_by, questions: r.questions || [],
  }));
}

export async function addForm(form) {
  const { error } = await supabase.from("forms").insert({
    id: form.id, title: form.title, description: form.description, audience: form.audience,
    created_by: form.createdBy, questions: form.questions,
  });
  if (error) console.warn("could not save form:", error.message);
  return getForms();
}

export async function getResponses() {
  const { data, error } = await supabase
    .from("responses").select("*").order("submitted_at", { ascending: false });
  if (error) { console.warn("could not load responses:", error.message); return []; }
  return data.map((r) => ({
    id: r.id, formId: r.form_id, respondentId: r.respondent_id,
    respondentName: r.respondent_name, respondentRole: r.respondent_role, answers: r.answers || [],
  }));
}

export async function addResponse(r) {
  const { error } = await supabase.from("responses").upsert({
    id: r.id, form_id: r.formId, respondent_id: r.respondentId,
    respondent_name: r.respondentName, respondent_role: r.respondentRole, answers: r.answers,
  }, { onConflict: "form_id,respondent_id" });
  if (error) console.warn("could not save response:", error.message);
  return getResponses();
}
