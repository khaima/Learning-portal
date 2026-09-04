/* ============================================================
   HPF Digital Learning Portal — demo data.
   This build has no backend yet (see README.md): everything lives in
   this file plus whatever the browser saves to localStorage. The five
   seed accounts below are clearly-labelled demo logins, not real people.
   ============================================================ */

export const ROLES = [
  { value: "teacher", label: "Teacher", desc: "Classes, assignments, results" },
  { value: "learner", label: "Learner", desc: "Coursework and library" },
  { value: "school_leader", label: "School Leader", desc: "Termly returns, oversight" },
  { value: "field_officer", label: "Field Officer", desc: "Visit reports by county" },
  { value: "education_team", label: "Education Team", desc: "Content, forms & insights" },
];

/* Seeded once into localStorage on first run — see auth.js. Passwords are
   plain text ON PURPOSE: this build has no server, so there is nothing to
   hash against. Never carry this pattern into a real backend. */
export const SEED_USERS = [
  {
    id: "u_teacher_demo",
    role: "teacher",
    username: "grace.mwangi",
    password: "demo1234",
    fullName: "Grace Mwangi",
    school: "Nyeri Hill Primary",
    county: "Nyeri",
  },
  {
    id: "u_learner_demo",
    role: "learner",
    username: "naomi.k",
    password: "demo1234",
    fullName: "Naomi Kiptoo",
    school: "Nyeri Hill Primary",
    county: "Nyeri",
    grade: "Grade 5A",
  },
  {
    id: "u_leader_demo",
    role: "school_leader",
    username: "peter.kamau",
    password: "demo1234",
    fullName: "Peter Kamau",
    school: "Nyeri Hill Primary",
    county: "Nyeri",
  },
  {
    id: "u_field_demo",
    role: "field_officer",
    username: "susan.wanjiru",
    password: "demo1234",
    fullName: "Susan Wanjiru",
    school: "",
    county: "Nyeri",
  },
  {
    id: "u_edu_demo",
    role: "education_team",
    username: "amina.hassan",
    password: "demo1234",
    fullName: "Amina Hassan",
    school: "",
    county: "",
  },
];

/* Sample content for the seed accounts, keyed by user id. A newly signed-up
   account gets none of this — an honest empty dashboard rather than
   borrowed demo content, same as the seed accounts once looked before
   anyone taught, enrolled, filed a return, filed a report, or published
   anything. */
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

/* ---------------------------------------------------------------- shared,
   org-wide resources. Unlike everything above (seeded PER account), these
   three are one shared list every account in this browser reads and
   writes — see store.js. This is what makes "the education team uploads
   a resource" or "creates a form" visible from a teacher or school leader
   account signed in on the same browser. */
export const SEED_LIBRARY = [
  { id: "lib1", title: "Fractions — visual walkthrough", subject: "Mathematics", type: "Video",
    description: "A short animated walkthrough of adding and subtracting fractions.",
    uploadedBy: "Amina Hassan", uploadedAt: "2026-08-01T09:00:00.000Z" },
  { id: "lib2", title: "Reading comprehension pack", subject: "English", type: "Worksheet",
    description: "Six short passages with comprehension questions, Grade 4 level.",
    uploadedBy: "Amina Hassan", uploadedAt: "2026-08-03T09:00:00.000Z" },
  { id: "lib3", title: "Life cycles explained", subject: "Science", type: "Reading",
    description: "An illustrated explainer of animal and plant life cycles.",
    uploadedBy: "Amina Hassan", uploadedAt: "2026-08-10T09:00:00.000Z" },
  { id: "lib4", title: "Times tables practice", subject: "Mathematics", type: "Worksheet",
    description: "Drill sheets for the 2–12 times tables.",
    uploadedBy: "Amina Hassan", uploadedAt: "2026-08-14T09:00:00.000Z" },
];
export const CONTENT_TYPES = ["Video", "Worksheet", "Reading", "Lesson plan", "Assessment"];
export const LIBRARY_SUBJECTS = ["Mathematics", "English", "Science"];

export const FORM_AUDIENCES = [
  { value: "teacher", label: "Teachers" },
  { value: "school_leader", label: "School Leaders" },
];
export const QUESTION_TYPES = [
  { value: "rating", label: "Rating (1–5)" },
  { value: "text", label: "Short answer" },
];

export const SEED_FORMS = [
  {
    id: "form1",
    title: "Term 2 curriculum feedback",
    description: "A quick check on how the new Mathematics materials are landing in class.",
    audience: "teacher",
    createdBy: "Amina Hassan",
    createdAt: "2026-08-20T09:00:00.000Z",
    questions: [
      { id: "q1", type: "rating", prompt: "How well are learners engaging with the new Mathematics materials?" },
      { id: "q2", type: "text", prompt: "What would make the materials more useful?" },
    ],
  },
];

export const SEED_RESPONSES = [
  {
    id: "resp1",
    formId: "form1",
    respondentId: "u_teacher_demo",
    respondentName: "Grace Mwangi",
    respondentRole: "teacher",
    submittedAt: "2026-08-25T14:00:00.000Z",
    answers: [
      { questionId: "q1", value: 4 },
      { questionId: "q2", value: "More worked examples for fractions would help — learners get stuck partway through." },
    ],
  },
];
