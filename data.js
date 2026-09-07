/* ============================================================
   HPF Digital Learning Portal — static constants and UI copy.

   Real data lives in Postgres and is fetched through the `api` Edge
   Function (see api.js / store.js). This file only holds the fixed
   lists the UI needs — roles, subjects, content types, question types —
   plus a few legacy per-account demo dictionaries that no longer match
   any real account (kept only so the dashboards still render their
   empty states; slated for removal).
   ============================================================ */

export const ROLES = [
  { value: "teacher", label: "Teacher", desc: "Classes, assignments, results" },
  { value: "learner", label: "Learner", desc: "Coursework and library" },
  { value: "school_leader", label: "School Leader", desc: "Termly returns, oversight" },
  { value: "field_officer", label: "Field Officer", desc: "Visit reports by county" },
  { value: "education_team", label: "Education Team", desc: "Content, forms & insights" },
];

/* Legacy per-account demo content, keyed by the old text ids. Nothing
   matches these keys any more (accounts are auth.users UUIDs now), so
   every lookup falls through to the dashboard's empty state — which is
   the intended behaviour for a fresh account. */
export const TEACHER_CONTENT = {
  u_teacher_demo: {
    stats: { classes: 3, learners: 128, toGrade: 6, avgScore: 74, attendance: 91 },
    classes: [
      { id: "c1", code: "5A", swatch: "var(--panel)", name: "Grade 5A · Mathematics", learners: 42, coverage: 82 },
      { id: "c2", code: "4B", swatch: "var(--accent)", name: "Grade 4B · English", learners: 38, coverage: 64 },
      { id: "c3", code: "6C", swatch: "#6C8FBF", name: "Grade 6C · Science", learners: 48, coverage: 71 },
    ],
    tasks: [
      { id: "t1", state: "due", title: "Grade 5A — Fractions quiz", detail: "6 submissions to grade" },
      { id: "t2", state: "due", title: "Grade 4B — Reading log", detail: "due Friday" },
      { id: "t3", state: "done", title: "Grade 6C — Ecosystems test", detail: "graded · results published" },
    ],
    results: [
      { id: "r1", label: "Grade 5A — Fractions quiz", score: 86, kind: "good" },
      { id: "r2", label: "Grade 6C — Ecosystems test", score: 69, kind: "mid" },
      { id: "r3", label: "Grade 4B — Comprehension", score: 78, kind: "good" },
    ],
  },
};

export const LEARNER_CONTENT = {
  u_learner_demo: {
    classes: [
      { id: "l1", subject: "Mathematics", teacher: "Mrs. Mwangi", swatch: "var(--panel)",
        next: { label: "Fractions quiz", due: "Fri" }, lastResult: null },
      { id: "l2", subject: "English", teacher: "Mr. Otieno", swatch: "var(--accent)",
        next: { label: "Reading log", due: "Mon" }, lastResult: null },
      { id: "l3", subject: "Science", teacher: "Ms. Chebet", swatch: "#6C8FBF",
        next: null, lastResult: { label: "Ecosystems test", score: 78 } },
    ],
    assignments: [
      { id: "a1", title: "Fractions quiz", subject: "Mathematics", due: "Friday", done: false },
      { id: "a2", title: "Reading log", subject: "English", due: "Monday", done: false },
      { id: "a3", title: "Times tables practice", subject: "Mathematics", due: "Wednesday", done: true },
      { id: "a4", title: "Comprehension worksheet", subject: "English", due: "Tuesday", done: true },
    ],
  },
};

/* School Leader: oversight of one school — enrolment/staffing at a
   glance, the termly return cycle, and what field officers have found on
   their last few visits. */
export const LEADER_CONTENT = {
  u_leader_demo: {
    stats: { learners: 412, teachers: 18, classes: 12, attendance: 89 },
    classes: [
      { id: "sc1", code: "5A", swatch: "var(--panel)", name: "Grade 5A · Mrs. Mwangi", learners: 42, coverage: 82 },
      { id: "sc2", code: "4B", swatch: "var(--accent)", name: "Grade 4B · Mr. Otieno", learners: 38, coverage: 64 },
      { id: "sc3", code: "6C", swatch: "#6C8FBF", name: "Grade 6C · Ms. Chebet", learners: 48, coverage: 71 },
    ],
    returns: [
      { id: "ret1", term: "Term 1, 2026", state: "ok", detail: "Filed 12 Feb" },
      { id: "ret2", term: "Term 2, 2026", state: "due", detail: "Due in 5 days" },
      { id: "ret3", term: "Term 3, 2026", state: "upcoming", detail: "Opens 1 Sep" },
    ],
    visits: [
      { id: "v1", label: "Field visit — Learning", detail: "Susan Wanjiru · 3 days ago" },
      { id: "v2", label: "Field visit — Infrastructure", detail: "Susan Wanjiru · 3 weeks ago" },
    ],
  },
};

/* Field Officer: schools assigned by county, and a real (if small)
   version of the production app's flagship flow — pick a county, the
   school list narrows to that county, pick a visit type, submit. See
   field.js for the interactive form; this is just the seed list it
   appends to. */
export const FIELD_SCHOOLS_BY_COUNTY = {
  Nyeri: ["Nyeri Hill Primary", "Chaka Primary"],
  Narok: ["Narok Hope Primary", "Narok Grace Primary"],
  Nairobi: ["Nairobi Faith Academy"],
};
export const VISIT_TYPES = ["Learning", "Infrastructure", "ICT", "MEP"];

export const FIELD_CONTENT = {
  u_field_demo: {
    stats: { schools: 5, counties: 3, visitsThisTerm: 12 },
    reports: [
      { id: "fr1", school: "Nyeri Hill Primary", county: "Nyeri", visitType: "Learning", detail: "3 days ago" },
      { id: "fr2", school: "Chaka Primary", county: "Nyeri", visitType: "Infrastructure", detail: "1 week ago" },
      { id: "fr3", school: "Narok Hope Primary", county: "Narok", visitType: "ICT", detail: "2 weeks ago" },
    ],
  },
};

export const SUBJECT_ICON_PATHS = {
  Mathematics: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 8h6M9 12h6"/>',
  English: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/>',
  Science: '<path d="M12 3c-4 3-4 7 0 9M12 3c4 3 4 7 0 9M12 12v9M7 21h10"/>',
};

export const CONTENT_TYPES = ["Video", "Worksheet", "Reading", "Lesson plan", "Assessment"];
export const LIBRARY_SUBJECTS = ["Mathematics", "English", "Science"];

/* Where a piece of content goes. Two destinations:

     staff   — "Teacher Resources": teachers and the head of institution
               (school leader) only. Never shown to learners.
     library — "Digital Library": for learners, and also visible to
               teachers and the head of institution.

   Distinct from FORM_AUDIENCES below — content and forms are addressed
   independently. */
export const LIBRARY_AUDIENCES = [
  { value: "library", label: "Digital Library — for learners (teachers & head of institution see it too)" },
  { value: "staff", label: "Teacher Resources — teachers & head of institution only" },
];

/* Legacy rows used ('both' | 'teacher' | 'learner'); map them onto the
   two current destinations. 'learner' ("learners only") folds into the
   Digital Library, which teachers and heads can now see as well. */
export function normalizeLibraryAudience(audience) {
  return audience === "staff" || audience === "teacher" ? "staff" : "library";
}

/* Can this role open this library item? */
export function canSeeLibraryItem(item, role) {
  const dest = normalizeLibraryAudience(item && item.audience);
  if (dest === "staff") return role === "teacher" || role === "school_leader";
  return role === "teacher" || role === "school_leader" || role === "learner";
}

export const FORM_AUDIENCES = [
  { value: "teacher", label: "Teachers" },
  { value: "school_leader", label: "School Leaders" },
  { value: "field_officer", label: "Field Officers" },
];
export const QUESTION_TYPES = [
  { value: "rating", label: "Rating (1–5)" },
  { value: "text", label: "Short answer" },
];
