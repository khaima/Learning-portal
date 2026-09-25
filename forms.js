/* ============================================================
   HPF Digital Learning Portal — filling in Education Team forms.

   One implementation for every dashboard that receives forms (teacher,
   school leader, field officer — both the stand-alone forms list and
   the forms inside a school visit). A form is one of three kinds:
     questions — answered right here (1–5 ratings, short answers)
     file      — an uploaded form: view or download the blank, fill it,
                 then upload the filled copy (or just confirm it's done)
     link      — a form on another site: open it, fill it there, confirm
   ============================================================ */

import { $$, esc, toast, friendlyError, emptyState } from "./util.js";
import { addResponse, uploadFilledForm } from "./store.js";

export const FORM_KIND_LABEL = { questions: "Questions", file: "File form", link: "Link" };

/** Small tags describing a form: its kind, county and visit type. */
export function formTagsHtml(form) {
  return [
    `<span class="form-tag">${esc(FORM_KIND_LABEL[form.kind] || "Questions")}</span>`,
    `<span class="form-tag">${esc(form.county || "All counties")}</span>`,
    form.visitType ? `<span class="form-tag visit">${esc(form.visitType)} visits</span>` : "",
  ].join("");
}

/** The fill-in area for one form (no submit button — the caller adds it). */
export function formFillHtml(form) {
  if (form.kind === "link") {
    return `
      <a class="btn btn-outline form-open" href="${esc(form.externalUrl || "#")}" target="_blank" rel="noopener">Open form ↗</a>
      <p class="field-hint">It opens on another site — fill it in there, then tick the box.</p>
      <label class="form-done"><input type="checkbox" data-f-done> I've filled in this form</label>`;
  }
  if (form.kind === "file") {
    const f = form.files?.[0];
    return `
      <div class="form-file-actions">
        ${f?.viewUrl ? `<a class="lib-open" href="${esc(f.viewUrl)}" target="_blank" rel="noopener">View form</a>` : ""}
        ${f?.downloadUrl ? `<a class="lib-download" href="${esc(f.downloadUrl)}" download>Download to fill</a>` : ""}
      </div>
      <div class="field">
        <label>Upload the filled copy <span class="hint-inline">— optional</span></label>
        <input type="file" data-f-file>
      </div>
      <label class="form-done"><input type="checkbox" data-f-done> I've filled in this form</label>`;
  }
  return (form.questions || []).map((q) => `
    <div class="field">
      <label>${esc(q.prompt)}</label>
      ${q.type === "rating"
        ? `<select data-q="${esc(q.id)}"><option value="5">5 — Excellent</option><option value="4">4 — Good</option><option value="3" selected>3 — Okay</option><option value="2">2 — Weak</option><option value="1">1 — Poor</option></select>`
        : `<input type="text" data-q="${esc(q.id)}" placeholder="Your answer">`}
    </div>`).join("");
}

/** Has this fill-in area been completed? (A file form counts once a
    filled copy is chosen or the box is ticked; a question form once every
    short answer has something in it.) */
export function isFormFilled(box, form) {
  if (form.kind === "link") return !!box.querySelector("[data-f-done]")?.checked;
  if (form.kind === "file") {
    return !!box.querySelector("[data-f-done]")?.checked || !!box.querySelector("[data-f-file]")?.files?.length;
  }
  return [...box.querySelectorAll("input[data-q]")].every((i) => i.value.trim());
}

/** Reads a completed fill-in area into { formId, answers, files },
    uploading a filled copy first if one was chosen. */
export async function collectFormResponse(box, form) {
  const response = { formId: form.id, answers: [], files: [] };
  if (form.kind === "questions") {
    response.answers = (form.questions || []).map((q) => ({
      questionId: q.id,
      value: box.querySelector(`[data-q="${q.id}"]`)?.value ?? "",
    }));
  } else if (form.kind === "file") {
    const file = box.querySelector("[data-f-file]")?.files?.[0];
    if (file) response.files = [await uploadFilledForm(form.id, file)];
  }
  return response;
}

/* Keep a file form's "done" box in step with choosing a filled copy. */
function wireFileBoxes(root) {
  $$("[data-f-file]", root).forEach((input) => input.addEventListener("change", () => {
    const done = input.closest(".fill-form, .visit-form")?.querySelector("[data-f-done]");
    if (done && input.files.length) done.checked = true;
  }));
}

/* ---------------------------------------------------------------- stand-alone forms list
   Pending/Submitted cards; "Fill out" opens the form in place. Only
   forms that aren't tied to a visit type — visit forms are filled inside
   a school visit (field.js). */
export function mountFormList(el, { forms, responses, userId, onSubmitted }) {
  const list = forms.filter((f) => !f.visitType);
  const done = new Set(responses.filter((r) => r.respondentId === userId && !r.visitId).map((r) => r.formId));
  el.innerHTML = list.length
    ? list.map((f) => `
        <div class="form-card" data-form="${esc(f.id)}">
          <div class="fc-head"><h3>${esc(f.title)}</h3>${done.has(f.id) ? `<span class="pill ok">Submitted</span>` : `<span class="pill warm">Pending</span>`}</div>
          <div class="fc-meta">${f.description ? esc(f.description) : "From " + esc(f.createdBy)}</div>
          <div class="form-tags">${formTagsHtml(f)}</div>
          ${done.has(f.id) ? "" : `<button class="btn btn-outline" type="button" data-fill-form>Fill out</button>
            <div class="fill-form" hidden>${formFillHtml(f)}
              <button class="btn btn-primary btn-block" type="button" data-submit-form>Submit</button>
            </div>`}
        </div>`).join("")
    : emptyState("No forms yet", "The Education Team hasn't sent anything here.");

  wireFileBoxes(el);
  $$("[data-fill-form]", el).forEach((btn) => btn.addEventListener("click", () => {
    btn.hidden = true;
    btn.closest(".form-card").querySelector(".fill-form").hidden = false;
  }));
  $$("[data-submit-form]", el).forEach((btn) => btn.addEventListener("click", async () => {
    const card = btn.closest("[data-form]");
    const form = list.find((f) => f.id === card.dataset.form);
    const box = card.querySelector(".fill-form");
    if (!isFormFilled(box, form)) {
      toast("Not finished yet", form.kind === "questions"
        ? "Answer every question before submitting."
        : "Upload the filled copy or tick \"I've filled in this form\".", "error");
      return;
    }
    btn.disabled = true;
    btn.classList.add("is-saving");
    btn.textContent = "Saving…";
    try {
      await addResponse(await collectFormResponse(box, form));
      toast("Form submitted successfully.", "", "success");
      onSubmitted?.();
    } catch (err) {
      console.error("could not submit form response:", err);
      toast("Couldn't submit that", friendlyError(err), "error");
      btn.disabled = false;
      btn.classList.remove("is-saving");
      btn.textContent = "Submit";
    }
  }));
}

/* ---------------------------------------------------------------- forms inside a visit
   All of a visit type's forms, open and ready to fill, one after
   another; collectVisitResponses() gathers the filled ones when the
   visit is submitted. */
export function renderVisitForms(el, forms) {
  el.innerHTML = forms.map((f, i) => `
    <div class="visit-form" data-visit-form="${esc(f.id)}">
      <div class="visit-form-head"><b>${i + 1}. ${esc(f.title)}</b><span class="form-tag">${esc(FORM_KIND_LABEL[f.kind] || "Questions")}</span></div>
      ${f.description ? `<p class="fc-meta">${esc(f.description)}</p>` : ""}
      ${formFillHtml(f)}
    </div>`).join("");
  wireFileBoxes(el);
}

const visitBox = (el, f) => el.querySelector(`[data-visit-form="${f.id}"]`);

/** Which of the visit's forms haven't been filled in yet. */
export function unfilledVisitForms(el, forms) {
  return forms.filter((f) => { const box = visitBox(el, f); return !box || !isFormFilled(box, f); });
}

/** The filled forms' responses (uploading any filled copies) — call only
    once the officer has decided to submit, so nothing is uploaded for a
    visit that then gets cancelled. */
export async function collectVisitResponses(el, forms) {
  const responses = [];
  for (const f of forms) {
    const box = visitBox(el, f);
    if (box && isFormFilled(box, f)) responses.push(await collectFormResponse(box, f));
  }
  return responses;
}
