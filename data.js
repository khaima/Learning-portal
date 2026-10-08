/* ============================================================
   HPF Digital Learning Portal — static constants and UI copy.

   Real data lives in Postgres and is fetched through the `api` Edge
   Function (see api.js / store.js). This file only holds the fixed
   lists the UI needs — roles, grades, visit types, content types,
   question types. Grades and visit types are also checked by the API;
   lists_test.ts fails if the two copies ever differ.
   ============================================================ */

export const ROLES = [
  { value: "teacher", label: "Teacher", desc: "Classes, assignments, results" },
  { value: "learner", label: "Learner", desc: "Coursework and library" },
  { value: "school_leader", label: "School Leader", desc: "Termly returns, oversight" },
  { value: "field_officer", label: "Field Officer", desc: "Visit reports by county" },
  { value: "education_team", label: "Education Team", desc: "Content, forms & insights" },
  // Given only by an administrator (invitation or role change), never
  // chosen at sign-up. They use the Education Team dashboard, which shows
  // each of them only what their permissions allow.
  { value: "me", label: "M&E", desc: "Monitoring & evaluation" },
  { value: "admin", label: "Admin", desc: "Staff accounts & portal" },
  { value: "super_admin", label: "Super Admin", desc: "Everything, including admins" },
];

/* Grades a class can be, in order — promotion moves a class to the next one.
   Matches the API (permissions.ts GRADES). */
export const GRADES = [
  "PP1", "PP2", "Grade 1", "Grade 2", "Grade 3", "Grade 4", "Grade 5", "Grade 6",
  "Grade 7", "Grade 8", "Grade 9", "Grade 10", "Grade 11", "Grade 12",
];
export const nextGrade = (g) => { const i = GRADES.indexOf(g); return i < 0 ? null : GRADES[i + 1] ?? null; };

/* Roles that open the Education Team dashboard. */
export const PORTAL_ADMIN_ROLES = ["education_team", "me", "admin", "super_admin"];

/* Field Officer visit types. Counties and schools are not listed here —
   they come from the Education Team's school list (GET /api/schools). */
export const VISIT_TYPES = ["Learning", "Infrastructure", "ICT", "MEP", "Teacher support"];

export const CONTENT_TYPES = ["Video", "Worksheet", "Reading", "Lesson plan", "Assessment"];
export const LIBRARY_SUBJECTS = ["Mathematics", "English", "Science"];

/* Where a piece of content goes. Three destinations:

     staff         — "Teacher Resources": teachers and the head of
                     institution (school leader) only. Never shown to learners.
     school_leader — "For School Head": the head of institution only —
                     not teachers, not learners. For things addressed
                     specifically to school leadership (e.g. a leadership
                     memo) that teachers shouldn't see mixed into their
                     own resources.
     library       — "Digital Library": for learners, and also visible to
                     teachers and the head of institution.

   Distinct from FORM_AUDIENCES below — content and forms are addressed
   independently. */
export const LIBRARY_AUDIENCES = [
  { value: "library", label: "Digital Library — for learners (teachers & head of institution see it too)" },
  { value: "staff", label: "Teacher Resources — teachers & head of institution only" },
  { value: "school_leader", label: "For School Head — head of institution only" },
];

/* Legacy rows used ('both' | 'teacher' | 'learner'); map them onto the
   current destinations. 'learner' ("learners only") folds into the
   Digital Library, which teachers and heads can now see as well. */
export function normalizeLibraryAudience(audience) {
  if (audience === "school_leader") return "school_leader";
  return audience === "staff" || audience === "teacher" ? "staff" : "library";
}

/* Can this role open this library item? */
export function canSeeLibraryItem(item, role) {
  const dest = normalizeLibraryAudience(item && item.audience);
  if (dest === "school_leader") return role === "school_leader";
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
