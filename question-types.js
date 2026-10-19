/* ============================================================
   HPF Digital Learning Portal — the kinds of question.

   Everything that differs by question type, in one place: how a teacher
   builds it, how a learner answers it, how an answer reads to the teacher
   (with ✓ / ✗ where it's marked automatically) and to the learner once it's
   marked, and the key. assignments-ui.js lays the screens out.

   Competency-based (CBE) formats beside the classic ones: matching, putting
   in order, filling in blanks, a number, and a task marked against a rubric
   (a project, a practical, an oral) with the four CBE levels. Any question
   can say where it sits in the curriculum (strand, sub-strand, learning
   outcome), which core competencies it builds and how much thinking it asks
   for, and carry an explanation the learner reads once it's marked. Choice
   questions can shuffle their options for each learner and explain each
   option; multiple response, matching, ordering and blanks can give part
   marks. The API checks and marks every one of them (lms.ts).
   ============================================================ */

import { esc } from "./util.js";

export const QUESTION_GROUPS = [
  ["Choose or arrange", [
    ["multiple_choice", "Multiple choice (one answer)"],
    ["multiple_response", "Multiple response (tick all that apply)"],
    ["true_false", "True / false"],
    ["matching", "Matching"],
    ["ordering", "Put in order"],
  ]],
  ["Write the answer", [
    ["short_answer", "Short answer"],
    ["fill_blanks", "Fill in the blanks"],
    ["numeric", "Number answer"],
  ]],
  ["You mark it", [
    ["teacher_marked", "Written task"],
    ["file_upload", "File upload"],
    ["rubric", "Task with a rubric (project, practical, oral)"],
  ]],
];
export const QUESTION_TYPES = QUESTION_GROUPS.flatMap(([, list]) => list.map(([value, label]) => ({ value, label })));
export const TYPE_LABEL = Object.fromEntries(QUESTION_TYPES.map((t) => [t.value, t.label]));

/** Kenya's CBE core competencies. */
export const COMPETENCIES = [
  ["communication", "Communication and collaboration"], ["critical_thinking", "Critical thinking and problem solving"],
  ["creativity", "Creativity and imagination"], ["citizenship", "Citizenship"], ["digital_literacy", "Digital literacy"],
  ["learning_to_learn", "Learning to learn"], ["self_efficacy", "Self-efficacy"],
];
const COMPETENCY = Object.fromEntries(COMPETENCIES);
export const LEVELS = [["remember", "Remember"], ["understand", "Understand"], ["apply", "Apply"], ["analyse", "Analyse"], ["evaluate", "Evaluate"], ["create", "Create"]];
const LEVEL = Object.fromEntries(LEVELS);
/** A rubric's four levels, best first, with their points. */
export const RUBRIC = [
  { code: "EE", label: "Exceeding expectations", points: 4 }, { code: "ME", label: "Meeting expectations", points: 3 },
  { code: "AE", label: "Approaching expectations", points: 2 }, { code: "BE", label: "Below expectations", points: 1 },
];
const CHOICE = new Set(["multiple_choice", "multiple_response"]);
const PARTIAL = new Set(["multiple_response", "matching", "ordering", "fill_blanks"]);
const TOKEN = /\{\{(\d+)\}\}/g;
const BRACKETS = /\[([^[\]]+)\]/g;
const letter = (k) => String.fromCharCode(65 + k);
const num = (v) => (v == null || v === "" ? "—" : String(Math.round(Number(v) * 100) / 100));
const tick = (ok) => (ok ? ' <span class="q-right">✓</span>' : ' <span class="q-wrong">✗</span>');
const norm = (s) => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** The same order every time for the same seed (a learner's own shuffle). */
function seeded(n, seed) {
  let h = 2166136261;
  for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    const j = h % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/* ------------------------------------------------------------ the teacher builds it */

/** A new question of this type, ready to fill in. */
export function blankQuestion(type = "multiple_choice") {
  const q = { type, prompt: "", maxMarks: 1, options: [], answerKey: null, meta: {} };
  if (type === "multiple_choice") { q.options = ["", ""]; q.answerKey = 0; }
  if (type === "multiple_response") { q.options = ["", ""]; q.answerKey = []; }
  if (type === "true_false") q.answerKey = true;
  if (type === "short_answer") q.answerKey = [];
  if (type === "matching") { q.options = { left: ["", ""], right: ["", ""] }; q.answerKey = [0, 1]; q.meta.partial = true; }
  if (type === "ordering") { q.options = ["", "", ""]; q.meta.partial = true; }
  if (type === "fill_blanks") q.meta.partial = true;
  if (type === "numeric") q.answerKey = { value: "", tolerance: "" };
  if (type === "rubric") { q.maxMarks = 4; q.meta.rubric = [{ criterion: "", levels: ["", "", "", ""] }]; }
  return q;
}
/** Changing a question's type keeps what still applies: the question, its marks, its CBE details. */
export function retype(q, type) {
  const next = blankQuestion(type);
  next.prompt = q.prompt;
  next.maxMarks = type === "rubric" && q.type !== "rubric" ? Math.max(q.maxMarks, 4) : q.maxMarks;
  for (const k of ["strand", "subStrand", "outcome", "competencies", "level", "explanation"]) if (q.meta?.[k]) next.meta[k] = clone(q.meta[k]);
  if (CHOICE.has(type) && Array.isArray(q.options) && q.options.length >= 2) next.options = [...q.options];
  next._open = q._open;
  return next;
}
/** A saved question as the editor holds it: an ordering's items in their right order, a fill-in's answers back in brackets. */
export function toEditable(q) {
  const e = { type: q.type, prompt: q.prompt, maxMarks: q.maxMarks, options: clone(q.options ?? []), answerKey: clone(q.answerKey ?? null), meta: clone(q.meta ?? {}) };
  if (q.type === "ordering" && Array.isArray(q.answerKey)) { e.options = q.answerKey.map((k) => q.options[k]); e.answerKey = null; }
  if (q.type === "fill_blanks" && Array.isArray(q.answerKey)) e.prompt = String(q.prompt).replace(TOKEN, (_, n) => `[${(q.answerKey[n - 1] || []).join("/")}]`);
  if (q.type === "numeric") e.answerKey = { value: q.answerKey?.value ?? "", tolerance: q.answerKey?.tolerance || "" };
  if (e.meta.optionFeedback?.some(Boolean)) e._fb = true;
  return e;
}
/** What the editor sends: its working notes left out. */
export function toSaved(q) {
  const { _open, _fb, ...out } = q;
  out.meta = { ...(q.meta || {}) };
  if (!_fb) delete out.meta.optionFeedback;
  out.maxMarks = Number(q.maxMarks);
  return out;
}

const blanksIn = (prompt) => (String(prompt || "").match(BRACKETS) || []).length;
const rmBtn = (act, j, what) => `<button type="button" class="q-icon" data-act="${act}" data-j="${j}" aria-label="Remove ${what}">✕</button>`;
const addBtn = (act, text) => `<button type="button" class="btn btn-ghost q-small" data-act="${act}">+ ${text}</button>`;

/** The part of a question's card that depends on its type. */
export function editorBody(q, i) {
  const t = q.type;
  if (CHOICE.has(t)) {
    const multi = t === "multiple_response";
    const fb = q.meta?.optionFeedback || [];
    return `
      <p class="field-hint" style="margin:.2rem 0 .4rem">${multi ? "Tick every right answer." : "Choose the right answer."}</p>
      ${q.options.map((o, j) => `
        <div class="q-opt-block">
          <div class="q-opt">
            <input type="${multi ? "checkbox" : "radio"}" name="key-${i}" data-key="${j}" aria-label="Right answer"
              ${multi ? ((q.answerKey || []).includes(j) ? "checked" : "") : q.answerKey === j ? "checked" : ""}>
            <span class="q-letter" aria-hidden="true">${letter(j)}</span>
            <input type="text" data-opt="${j}" value="${esc(o)}" placeholder="Option ${j + 1}" maxlength="300">
            ${q.options.length > 2 ? rmBtn("rm-opt", j, "option") : ""}
          </div>
          ${q._fb ? `<input type="text" class="q-opt-fb" data-ofb="${j}" value="${esc(fb[j] || "")}" maxlength="300" placeholder="Why ${letter(j)} is right or wrong — shown after marking">` : ""}
        </div>`).join("")}
      ${q.options.length < 10 ? addBtn("add-opt", "Add option") : ""}`;
  }
  if (t === "true_false") {
    return `<div class="q-opt-row">
        <label><input type="radio" name="tf-${i}" data-tf="true" ${q.answerKey === true ? "checked" : ""}> True is right</label>
        <label><input type="radio" name="tf-${i}" data-tf="false" ${q.answerKey === false ? "checked" : ""}> False is right</label>
      </div>`;
  }
  if (t === "short_answer") {
    return `<div class="field" style="margin:.4rem 0 0"><label>Accepted answers <span class="hint-inline">— optional, separate with ;</span></label>
        <input type="text" data-f="accepted" value="${esc((q.answerKey || []).join("; "))}" placeholder="e.g. 20; twenty">
        <p class="field-hint">Marked automatically when they match (capitals and spaces don't matter). Leave empty to mark it yourself.</p></div>`;
  }
  if (t === "matching") {
    const { left = [], right = [] } = q.options || {};
    return `
      <div class="q-match">
        <div class="q-match-col">
          <b class="q-col-title">Items</b>
          ${left.map((l, j) => `<div class="q-opt">
            <input type="text" data-left="${j}" value="${esc(l)}" placeholder="Item ${j + 1}" maxlength="300">
            <span class="q-arrow" aria-hidden="true">→</span>
            <select data-match="${j}" aria-label="Item ${j + 1} matches">${right.map((r, k) => `<option value="${k}"${(q.answerKey || [])[j] === k ? " selected" : ""}>${letter(k)}${r ? ` — ${esc(r.slice(0, 40))}` : ""}</option>`).join("")}</select>
            ${left.length > 2 ? rmBtn("rm-left", j, "item") : ""}</div>`).join("")}
          ${left.length < 10 ? addBtn("add-left", "Add item") : ""}
        </div>
        <div class="q-match-col">
          <b class="q-col-title">Answers to match with <span class="hint-inline">— extra ones make it harder</span></b>
          ${right.map((r, k) => `<div class="q-opt"><span class="q-letter" aria-hidden="true">${letter(k)}</span>
            <input type="text" data-right="${k}" value="${esc(r)}" placeholder="Answer ${letter(k)}" maxlength="300">
            ${right.length > 2 ? rmBtn("rm-right", k, "answer") : ""}</div>`).join("")}
          ${right.length < 12 ? addBtn("add-right", "Add answer") : ""}
        </div>
      </div>`;
  }
  if (t === "ordering") {
    const items = q.options || [];
    return `
      <p class="field-hint" style="margin:.2rem 0 .4rem">Write them in the right order — each learner gets them jumbled.</p>
      <ol class="q-steps">${items.map((s, j) => `<li class="q-opt">
        <input type="text" data-step="${j}" value="${esc(s)}" placeholder="Step ${j + 1}" maxlength="300">
        ${j > 0 ? `<button type="button" class="q-icon" data-act="step-up" data-j="${j}" aria-label="Move step ${j + 1} up">↑</button>` : ""}
        ${j < items.length - 1 ? `<button type="button" class="q-icon" data-act="step-down" data-j="${j}" aria-label="Move step ${j + 1} down">↓</button>` : ""}
        ${items.length > 2 ? rmBtn("rm-step", j, "step") : ""}</li>`).join("")}</ol>
      ${items.length < 10 ? addBtn("add-step", "Add step") : ""}`;
  }
  if (t === "fill_blanks") {
    const n = blanksIn(q.prompt);
    return `<p class="field-hint" style="margin:.3rem 0 0">Put each answer in [square brackets] in the sentence above; other accepted answers after a slash —
        e.g. <i>Water boils at [100/hundred] °C.</i> <b data-blanks>${n ? plural(n, "blank") : "No blanks yet"}</b></p>`;
  }
  if (t === "numeric") {
    const k = q.answerKey || {};
    return `<div class="lms-grid3 q-num">
        <div class="field" style="margin:0"><label>Right answer</label><input type="text" inputmode="decimal" data-num="value" value="${esc(k.value ?? "")}" placeholder="e.g. 7.5"></div>
        <div class="field" style="margin:0"><label>Allowed difference <span class="hint-inline">— ±, optional</span></label><input type="text" inputmode="decimal" data-num="tolerance" value="${esc(k.tolerance ?? "")}" placeholder="0"></div>
        <div class="field" style="margin:0"><label>Unit <span class="hint-inline">— optional</span></label><input type="text" data-f="unit" maxlength="20" value="${esc(q.meta?.unit || "")}" placeholder="e.g. cm, kg, %"></div>
      </div>`;
  }
  if (t === "rubric") {
    const crit = q.meta?.rubric || [];
    return `
      <p class="field-hint" style="margin:.2rem 0 .5rem">Learners read the rubric, then write and/or attach their work. You choose a level for each criterion; the marks follow.</p>
      ${crit.map((c, k) => `<div class="q-crit">
        <div class="q-opt"><b class="q-crit-n">${k + 1}</b><input type="text" data-crit="${k}" value="${esc(c.criterion)}" maxlength="200" placeholder="Criterion — e.g. Explains the reasoning">
          ${crit.length > 1 ? rmBtn("rm-crit", k, "criterion") : ""}</div>
        <div class="q-levels">${RUBRIC.map((L, l) => `<label class="q-level"><span class="q-lvl q-lvl-${L.code}" title="${L.label}">${L.code}</span>
          <input type="text" data-lvl="${k}:${l}" value="${esc(c.levels?.[l] || "")}" maxlength="300" placeholder="${L.label}…"></label>`).join("")}</div>
      </div>`).join("")}
      ${crit.length < 8 ? addBtn("add-crit", "Add criterion") : ""}`;
  }
  if (t === "file_upload") return `<p class="field-hint">Learners upload a file — a photo of their work, a document. You mark it.</p>`;
  return `<p class="field-hint">Learners write their answer. You mark it.</p>`;
}

/** "More": the CBE details and the settings, folded away until wanted. */
export function moreOptions(q) {
  const m = q.meta || {};
  const t = q.type;
  const said = [m.strand, LEVEL[m.level], ...(m.competencies || []).map((c) => COMPETENCY[c])].filter(Boolean);
  return `<details class="q-more"${q._open ? " open" : ""}>
    <summary>More <span class="hint-inline">— CBE details, explanation${CHOICE.has(t) || t === "matching" ? ", shuffling" : ""}${PARTIAL.has(t) ? ", part marks" : ""}${said.length ? ` · ${esc(said.slice(0, 3).join(" · "))}` : ""}</span></summary>
    <div class="q-more-body">
      <div class="field" style="margin:0"><label>Explanation <span class="hint-inline">— learners read it once it's marked</span></label>
        <textarea data-f="explanation" rows="2" maxlength="2000" placeholder="Why the answer is what it is">${esc(m.explanation || "")}</textarea></div>
      <div class="q-switches">
        ${CHOICE.has(t) || t === "matching" ? `<label><input type="checkbox" data-f="shuffle" ${m.shuffle ? "checked" : ""}> Shuffle the ${t === "matching" ? "answers" : "options"} for each learner</label>` : ""}
        ${CHOICE.has(t) ? `<label><input type="checkbox" data-fbtoggle ${q._fb ? "checked" : ""}> Explain each option (shown after marking)</label>` : ""}
        ${PARTIAL.has(t) ? `<label><input type="checkbox" data-f="partial" ${m.partial ? "checked" : ""}> Part marks for part of the answer${t === "multiple_response" ? " (a wrong tick takes one away)" : ""}</label>` : ""}
      </div>
      <div class="lms-grid3">
        <div class="field" style="margin:0"><label>Strand</label><input type="text" data-f="strand" maxlength="120" value="${esc(m.strand || "")}" placeholder="e.g. Numbers"></div>
        <div class="field" style="margin:0"><label>Sub-strand</label><input type="text" data-f="subStrand" maxlength="120" value="${esc(m.subStrand || "")}" placeholder="e.g. Fractions"></div>
        <div class="field" style="margin:0"><label>Level of thinking</label><select data-f="level"><option value="">—</option>${LEVELS.map(([v, l]) => `<option value="${v}"${m.level === v ? " selected" : ""}>${l}</option>`).join("")}</select></div>
      </div>
      <div class="field" style="margin:0"><label>Learning outcome <span class="hint-inline">— by the end, the learner should be able to…</span></label>
        <input type="text" data-f="outcome" maxlength="500" value="${esc(m.outcome || "")}"></div>
      <fieldset class="q-comps"><legend>Core competencies</legend>
        ${COMPETENCIES.map(([v, l]) => `<label><input type="checkbox" data-comp="${v}" ${(m.competencies || []).includes(v) ? "checked" : ""}> ${l}</label>`).join("")}
      </fieldset>
    </div>
  </details>`;
}

/** A typed or ticked change on a card. Returns "render" when the card should be drawn again, "total" when the marks changed. */
export function applyEdit(q, el, card) {
  const d = el.dataset;
  q.meta ||= {};
  if (d.f === "prompt") {
    q.prompt = el.value;
    if (q.type === "fill_blanks") { const n = blanksIn(q.prompt); const b = card.querySelector("[data-blanks]"); if (b) b.textContent = n ? plural(n, "blank") : "No blanks yet"; }
    return "";
  }
  if (d.f === "maxMarks") { q.maxMarks = Number(el.value); return "total"; }
  if (d.f === "accepted") { q.answerKey = el.value.split(";").map((s) => s.trim()).filter(Boolean); return ""; }
  if (d.f === "shuffle" || d.f === "partial") { q.meta[d.f] = el.checked; return ""; }
  if (["explanation", "strand", "subStrand", "outcome", "unit", "level"].includes(d.f)) { q.meta[d.f] = el.value; return ""; }
  if (d.comp) {
    const set = new Set(q.meta.competencies || []);
    if (el.checked) set.add(d.comp); else set.delete(d.comp);
    q.meta.competencies = COMPETENCIES.map(([v]) => v).filter((v) => set.has(v));
    return "";
  }
  if (d.fbtoggle !== undefined) { q._fb = el.checked; return "render"; }
  if (d.key !== undefined) {
    const j = Number(d.key);
    if (q.type === "multiple_choice") q.answerKey = j;
    else q.answerKey = el.checked ? [...new Set([...(q.answerKey || []), j])] : (q.answerKey || []).filter((k) => k !== j);
    return "";
  }
  if (d.tf !== undefined) { q.answerKey = d.tf === "true"; return ""; }
  if (d.opt !== undefined) { q.options[Number(d.opt)] = el.value; return ""; }
  if (d.ofb !== undefined) { const fb = q.meta.optionFeedback || []; fb[Number(d.ofb)] = el.value; q.meta.optionFeedback = Array.from({ length: q.options.length }, (_, j) => fb[j] || ""); return ""; }
  if (d.left !== undefined) { q.options.left[Number(d.left)] = el.value; return ""; }
  if (d.right !== undefined) {
    const k = Number(d.right);
    q.options.right[k] = el.value;
    for (const o of card.querySelectorAll(`select[data-match] option[value="${k}"]`)) o.textContent = `${letter(k)}${el.value ? ` — ${el.value.slice(0, 40)}` : ""}`;
    return "";
  }
  if (d.match !== undefined) { q.answerKey[Number(d.match)] = Number(el.value); return ""; }
  if (d.step !== undefined) { q.options[Number(d.step)] = el.value; return ""; }
  if (d.num) { q.answerKey = { ...(q.answerKey || {}), [d.num]: el.value }; return ""; }
  if (d.crit !== undefined) { q.meta.rubric[Number(d.crit)].criterion = el.value; return ""; }
  if (d.lvl) { const [k, l] = d.lvl.split(":").map(Number); q.meta.rubric[k].levels[l] = el.value; return ""; }
  return "";
}

/** A button on a card (adding or removing an option, an item, a step, a criterion). True when it changed something. */
export function applyAction(q, act, j) {
  q.meta ||= {};
  const fb = q.meta.optionFeedback;
  switch (act) {
    case "add-opt": q.options.push(""); if (fb) fb.push(""); return true;
    case "rm-opt":
      q.options.splice(j, 1);
      if (fb) fb.splice(j, 1);
      if (q.type === "multiple_choice") q.answerKey = q.answerKey === j ? 0 : q.answerKey > j ? q.answerKey - 1 : q.answerKey;
      else q.answerKey = (q.answerKey || []).filter((k) => k !== j).map((k) => (k > j ? k - 1 : k));
      return true;
    case "add-left": q.options.left.push(""); q.answerKey.push(0); return true;
    case "rm-left": q.options.left.splice(j, 1); q.answerKey.splice(j, 1); return true;
    case "add-right": q.options.right.push(""); return true;
    case "rm-right":
      q.options.right.splice(j, 1);
      q.answerKey = q.answerKey.map((k) => (k === j ? 0 : k > j ? k - 1 : k));
      return true;
    case "add-step": q.options.push(""); return true;
    case "rm-step": q.options.splice(j, 1); return true;
    case "step-up": if (j > 0) [q.options[j - 1], q.options[j]] = [q.options[j], q.options[j - 1]]; return true;
    case "step-down": if (j < q.options.length - 1) [q.options[j + 1], q.options[j]] = [q.options[j], q.options[j + 1]]; return true;
    case "add-crit": q.meta.rubric.push({ criterion: "", levels: ["", "", "", ""] }); return true;
    case "rm-crit": q.meta.rubric.splice(j, 1); return true;
  }
  return false;
}

/* ------------------------------------------------------------ how a question reads */

/** The question as text: a fill-in's blanks as lines. */
export const promptText = (q) => (q.type === "fill_blanks" ? String(q.prompt).replace(TOKEN, "_____") : q.prompt);

/** Its CBE details, as small tags: where it sits, the thinking it asks for, the competencies it builds. */
export function tagsHtml(q) {
  const m = q.meta || {};
  const tags = [
    m.strand ? `${m.strand}${m.subStrand ? ` › ${m.subStrand}` : ""}` : m.subStrand,
    LEVEL[m.level],
    ...(m.competencies || []).map((c) => COMPETENCY[c]),
  ].filter(Boolean);
  return tags.length || m.outcome ? `<div class="q-tags">${tags.map((t) => `<span class="q-tag">${esc(t)}</span>`).join("")}${
    m.outcome ? `<span class="q-outcome">Outcome: ${esc(m.outcome)}</span>` : ""}</div>` : "";
}

/** The rubric as a table: each criterion, what each level looks like. `chosen` highlights the levels given; `pick` makes them choosable (marking). */
export function rubricTable(q, { chosen = null, pick = false, name = "" } = {}) {
  const crit = q.meta?.rubric || [];
  if (!crit.length) return "";
  return `<div class="q-rubric-wrap"><table class="q-rubric">
    <thead><tr><th>Criterion</th>${RUBRIC.map((L) => `<th><span class="q-lvl q-lvl-${L.code}">${L.code}</span> <span class="q-rubric-l">${L.label}</span></th>`).join("")}</tr></thead>
    <tbody>${crit.map((c, k) => `<tr><th scope="row">${esc(c.criterion)}</th>${RUBRIC.map((L, l) => {
      const on = chosen?.[k] === L.points;
      const text = c.levels?.[l] ? esc(c.levels[l]) : `<span class="hint-inline">${L.label}</span>`;
      return `<td class="${on ? "is-chosen" : ""}">${pick
        ? `<label class="q-pick"><input type="radio" name="${esc(name)}-${k}" value="${L.points}" data-rubric="${k}" ${on ? "checked" : ""}> ${text}</label>`
        : `${text}${on ? ' <b class="q-chosen">✓</b>' : ""}`}</td>`;
    }).join("")}</tr>`).join("")}</tbody></table></div>`;
}
/** The marks a rubric gives (4 points a criterion at EE … 1 at BE), as the API works them out. */
export const rubricMarks = (levels, max) => (levels.length ? Math.round(((max * levels.reduce((t, l) => t + l, 0)) / (4 * levels.length)) * 100) / 100 : 0);

/** An answer as it reads to the teacher (`withKey`: ✓ / ✗) or to the learner. */
export function responseView(q, ans, { withKey = false } = {}) {
  const r = ans?.response;
  const files = (ans?.files || []).map((f) => `<a href="${esc(f.downloadUrl || f.viewUrl || "#")}" target="_blank" rel="noopener">${esc(f.name)}</a>`).join("<br>");
  if (!ans || (r == null && !(ans.files || []).length)) return `<span class="hint-inline">No answer</span>`;
  const key = q.answerKey;
  switch (q.type) {
    case "multiple_choice":
      return `${esc(q.options[r] ?? "—")}${withKey && key != null ? tick(r === key) : ""}`;
    case "multiple_response":
      return (Array.isArray(r) ? r : []).map((k) => `${esc(q.options[k] ?? "—")}${withKey ? tick((key || []).includes(k)) : ""}`).join(", ") || "—";
    case "true_false":
      return `${r ? "True" : "False"}${withKey && typeof key === "boolean" ? tick(r === key) : ""}`;
    case "file_upload":
      return files || "—";
    case "matching": {
      const { left = [], right = [] } = q.options || {};
      return `<ul class="q-list">${left.map((l, i) => `<li>${esc(l)} → ${r?.[i] == null ? '<span class="hint-inline">not matched</span>' : esc(right[r[i]] ?? "—")}${withKey ? tick(r?.[i] === key?.[i]) : ""}</li>`).join("")}</ul>`;
    }
    case "ordering":
      return `<ol class="q-list">${(Array.isArray(r) ? r : []).map((k, p) => `<li>${esc(q.options[k] ?? "—")}${withKey ? tick(key?.[p] === k) : ""}</li>`).join("")}</ol>`;
    case "fill_blanks":
      return `<span class="q-cloze-read">${esc(q.prompt).replace(TOKEN, (_, n) => {
        const got = r?.[n - 1] || "";
        return `<b class="q-fill">${got ? esc(got) : "____"}</b>${withKey ? tick((key?.[n - 1] || []).some((a) => norm(a) === norm(got))) : ""}`;
      })}</span>`;
    case "numeric": {
      const v = Number(String(r).replace(",", "."));
      return `${esc(r)}${q.meta?.unit ? ` ${esc(q.meta.unit)}` : ""}${withKey && key ? tick(Number.isFinite(v) && Math.abs(v - Number(key.value)) <= Number(key.tolerance || 0) + 1e-9) : ""}`;
    }
    case "rubric":
      return `${r ? `<span style="white-space:pre-wrap">${esc(r)}</span>` : ""}${r && files ? "<br>" : ""}${files}` || "—";
    default:
      return `<span style="white-space:pre-wrap">${esc(r)}</span>`;
  }
}

/** The right answer, in words, for the teacher. */
export function keyText(q) {
  const k = q.answerKey;
  switch (q.type) {
    case "multiple_choice": return k == null ? "" : `Answer: ${esc(q.options[k] ?? "")}`;
    case "multiple_response": return `Answers: ${(k || []).map((i) => esc(q.options[i] ?? "")).join(", ")}${q.meta?.partial ? " · part marks" : ""}`;
    case "true_false": return `Answer: ${k ? "True" : "False"}`;
    case "short_answer": return (k || []).length ? `Accepted: ${(k || []).map(esc).join("; ")}` : "Marked by the teacher";
    case "matching": {
      const { left = [], right = [] } = q.options || {};
      return `Matches: ${left.map((l, i) => `${esc(l)} → ${esc(right[k?.[i]] ?? "—")}`).join("; ")}${q.meta?.partial ? " · part marks" : ""}`;
    }
    case "ordering": return `Order: ${(k || []).map((i, p) => `${p + 1}. ${esc(q.options[i] ?? "")}`).join(" · ")}${q.meta?.partial ? " · part marks" : ""}`;
    case "fill_blanks": return `Blanks: ${(k || []).map((acc, i) => `${i + 1}. ${acc.map(esc).join(" / ")}`).join(" · ")}${q.meta?.partial ? " · part marks" : ""}`;
    case "numeric": return k ? `Answer: ${esc(k.value)}${q.meta?.unit ? ` ${esc(q.meta.unit)}` : ""}${Number(k.tolerance) ? ` (± ${esc(k.tolerance)})` : ""}` : "";
    case "rubric": return "Marked with the rubric";
    default: return "Marked by the teacher";
  }
}

/* ------------------------------------------------------------ the learner answers */

/** The inputs a learner answers with. `seed` gives each learner their own shuffled order. */
export function learnerInput(q, ans, { seed = "" } = {}) {
  const r = ans?.response;
  const t = q.type;
  const id = esc(q.id);
  if (CHOICE.has(t)) {
    const order = q.meta?.shuffle ? seeded(q.options.length, `${seed}|${q.id}`) : q.options.map((_, j) => j);
    const multi = t === "multiple_response";
    return order.map((j) => `<label class="q-choice"><input type="${multi ? "checkbox" : "radio"}" name="a-${id}" value="${j}" ${
      multi ? ((Array.isArray(r) ? r : []).includes(j) ? "checked" : "") : r === j ? "checked" : ""}> ${esc(q.options[j])}</label>`).join("");
  }
  if (t === "true_false") {
    return `<label class="q-choice"><input type="radio" name="a-${id}" value="true" ${r === true ? "checked" : ""}> True</label>
      <label class="q-choice"><input type="radio" name="a-${id}" value="false" ${r === false ? "checked" : ""}> False</label>`;
  }
  if (t === "file_upload" || t === "rubric") {
    const upload = `<div data-files>${(ans?.files || []).map((f) => `<span class="pill">${esc(f.name)}</span>`).join(" ") || '<span class="hint-inline">No file yet</span>'}</div>
      <label class="btn btn-outline q-small" style="margin-top:.4rem">Upload a file<input type="file" data-upload hidden></label>`;
    if (t === "file_upload") return upload;
    return `${rubricTable(q)}
      <textarea rows="5" maxlength="5000" placeholder="Your work — write it here, attach it, or both…">${esc(typeof r === "string" ? r : "")}</textarea>
      ${upload}`;
  }
  if (t === "matching") {
    const { left = [], right = [] } = q.options || {};
    const order = q.meta?.shuffle ? seeded(right.length, `${seed}|${q.id}`) : right.map((_, k) => k);
    return `<div class="q-match-learn">${left.map((l, i) => `<label class="q-match-row"><span>${esc(l)}</span>
      <select data-match="${i}"><option value="">Choose…</option>${order.map((k) => `<option value="${k}"${Array.isArray(r) && r[i] === k ? " selected" : ""}>${esc(right[k])}</option>`).join("")}</select></label>`).join("")}</div>`;
  }
  if (t === "ordering") {
    const n = q.options.length;
    const valid = Array.isArray(r) && r.length === n && new Set(r).size === n;
    const order = valid ? r : q.options.map((_, k) => k);
    return `<ol class="q-order">${order.map((k) => `<li data-oi="${k}"><span class="q-order-t">${esc(q.options[k])}</span>
      <span class="q-order-tools"><button type="button" class="q-icon" data-move="up" aria-label="Move up: ${esc(q.options[k])}">↑</button><button type="button" class="q-icon" data-move="down" aria-label="Move down: ${esc(q.options[k])}">↓</button></span></li>`).join("")}</ol>
      <p class="field-hint" style="margin:.3rem 0 0">Use ↑ and ↓ to put them in the right order.</p>`;
  }
  if (t === "fill_blanks") {
    return `<p class="q-cloze">${esc(q.prompt).replace(TOKEN, (_, n) => `<input type="text" class="q-blank" data-blank="${n - 1}" maxlength="300" aria-label="Blank ${n}" value="${esc(Array.isArray(r) ? r[n - 1] || "" : "")}">`)}</p>`;
  }
  if (t === "numeric") {
    return `<label class="q-num-in"><input type="text" inputmode="decimal" data-num maxlength="40" aria-label="Your answer" value="${esc(r ?? "")}">${q.meta?.unit ? ` <span>${esc(q.meta.unit)}</span>` : ""}</label>`;
  }
  return `<textarea rows="${t === "short_answer" ? 2 : 5}" maxlength="5000" placeholder="Your answer…">${esc(typeof r === "string" ? r : "")}</textarea>`;
}

/** The answer on a learner's card, as the API takes it. `files`: what's been uploaded for each question. */
export function collectAnswer(card, files = {}) {
  const qid = card.dataset.qid;
  const type = card.dataset.type;
  const one = (response) => ({ questionId: qid, response });
  switch (type) {
    case "multiple_choice": { const c = card.querySelector("input:checked"); return one(c ? Number(c.value) : null); }
    case "multiple_response": return one([...card.querySelectorAll("input:checked")].map((c) => Number(c.value)));
    case "true_false": { const c = card.querySelector("input:checked"); return one(c ? c.value === "true" : null); }
    case "file_upload": return { questionId: qid, response: null, files: files[qid] || [] };
    case "rubric": return { questionId: qid, response: card.querySelector("textarea")?.value ?? null, files: files[qid] || [] };
    case "matching": { const v = [...card.querySelectorAll("select[data-match]")].map((s) => (s.value === "" ? null : Number(s.value))); return one(v.some((x) => x != null) ? v : null); }
    case "ordering": return one([...card.querySelectorAll("[data-oi]")].map((li) => Number(li.dataset.oi)));
    case "fill_blanks": { const v = [...card.querySelectorAll("[data-blank]")].map((i) => i.value); return one(v.some((x) => x.trim()) ? v : null); }
    case "numeric": { const v = card.querySelector("[data-num]")?.value.trim(); return one(v || null); }
    default: return one(card.querySelector("textarea")?.value ?? null);
  }
}
/** Nothing given for this answer yet. */
export const isBlank = (x) => (!x.files || !x.files.length) && (x.response == null || x.response === "" || (Array.isArray(x.response) && !x.response.length));

/** Moves an ordering item up or down (the learner's ↑ ↓). */
export function moveItem(btn) {
  const li = btn.closest("[data-oi]");
  if (!li) return;
  if (btn.dataset.move === "up" && li.previousElementSibling) li.parentElement.insertBefore(li, li.previousElementSibling);
  else if (btn.dataset.move === "down" && li.nextElementSibling) li.parentElement.insertBefore(li.nextElementSibling, li);
  btn.focus();
}

/** What a learner reads under a marked question: the levels the teacher chose, the feedback on their option, the explanation. */
export function afterMarking(q, ans) {
  const m = q.meta || {};
  const parts = [];
  if (q.type === "rubric" && Array.isArray(ans?.rubric)) parts.push(rubricTable(q, { chosen: ans.rubric }));
  const fb = m.optionFeedback || [];
  const chosen = q.type === "multiple_choice" && Number.isInteger(ans?.response) ? [ans.response] : q.type === "multiple_response" && Array.isArray(ans?.response) ? ans.response : [];
  for (const j of chosen) if (fb[j]) parts.push(`<p class="q-explain"><b>${esc(q.options[j])}:</b> ${esc(fb[j])}</p>`);
  if (m.explanation) parts.push(`<p class="q-explain"><b>Why:</b> ${esc(m.explanation)}</p>`);
  return parts.join("");
}
/** The rubric levels a teacher has chosen on the marking form, or null until every criterion has one. */
export function chosenLevels(card, q) {
  const n = q.meta?.rubric?.length || 0;
  const levels = Array.from({ length: n }, (_, k) => {
    const c = card.querySelector(`input[data-rubric="${k}"]:checked`);
    return c ? Number(c.value) : null;
  });
  return n && levels.every((l) => l != null) ? levels : null;
}
