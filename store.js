/* ============================================================
   HPF Digital Learning Portal — shared, org-wide demo stores.

   Content library, forms, and form responses are not tied to one
   account — every account signed in on THIS browser reads and writes
   the same localStorage-backed lists. That's what makes "the education
   team uploads a resource" or "creates a form" show up on a teacher or
   school leader account, as long as it's the same browser. Across
   different browsers or devices there is nothing to share — see
   README.md; a real backend is the obvious next step if this is worth
   carrying forward.
   ============================================================ */

import { SEED_LIBRARY, SEED_FORMS, SEED_RESPONSES } from "./data.js";

const LIBRARY_KEY = "hpf_learning_portal_library";
const FORMS_KEY = "hpf_learning_portal_forms";
const RESPONSES_KEY = "hpf_learning_portal_responses";

function readJSON(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}
const writeJSON = (key, value) => localStorage.setItem(key, JSON.stringify(value));

function seeded(key, seed) {
  const stored = readJSON(key, null);
  if (Array.isArray(stored)) return stored;
  writeJSON(key, seed);
  return seed.slice();
}

export const getLibrary = () => seeded(LIBRARY_KEY, SEED_LIBRARY);
export function addLibraryItem(item) {
  const list = [item, ...getLibrary()];
  writeJSON(LIBRARY_KEY, list);
  return list;
}

export const getForms = () => seeded(FORMS_KEY, SEED_FORMS);
export function addForm(form) {
  const list = [form, ...getForms()];
  writeJSON(FORMS_KEY, list);
  return list;
}

export const getResponses = () => seeded(RESPONSES_KEY, SEED_RESPONSES);
export function addResponse(response) {
  const list = [response, ...getResponses()];
  writeJSON(RESPONSES_KEY, list);
  return list;
}
