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

export async function getLibrary() {
  const { data, error } = await supabase
    .from("library_items").select("*").order("uploaded_at", { ascending: false });
  if (error) { console.warn("could not load library:", error.message); return []; }
  return data.map((r) => ({
    id: r.id, title: r.title, subject: r.subject, type: r.type, audience: r.audience,
    description: r.description, uploadedBy: r.uploaded_by,
  }));
}

export async function addLibraryItem(item) {
  const { error } = await supabase.from("library_items").insert({
    id: item.id, title: item.title, subject: item.subject, type: item.type, audience: item.audience,
    description: item.description, uploaded_by: item.uploadedBy,
  });
  if (error) console.warn("could not save library item:", error.message);
  return getLibrary();
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
