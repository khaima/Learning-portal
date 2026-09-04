/* ============================================================
   HPF Digital Learning Portal — demo data.
   This build has no backend yet (see README.md): everything lives in
   this file plus whatever the browser saves to localStorage. The two
   seed accounts below are clearly-labelled demo logins, not real people.
   ============================================================ */

export const ROLES = [
  { value: "teacher", label: "Teacher", desc: "Classes, assignments, results" },
  { value: "learner", label: "Learner", desc: "Coursework and library" },
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
];

/* Sample content for the two seed accounts, keyed by user id. A newly
   signed-up account gets none of this — an honest empty dashboard rather
   than borrowed demo content, same as the seed accounts once looked
   before anyone taught or enrolled in anything. */
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
    library: [
      { title: "Fractions — visual walkthrough", subject: "Mathematics · Grade 5" },
      { title: "Reading comprehension pack", subject: "English · Grade 4" },
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
    library: [
      { title: "Fractions — visual walkthrough", subject: "Mathematics" },
      { title: "Reading comprehension pack", subject: "English" },
      { title: "Life cycles explained", subject: "Science" },
      { title: "Times tables practice", subject: "Mathematics" },
    ],
  },
};

export const SUBJECT_ICON_PATHS = {
  Mathematics: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 8h6M9 12h6"/>',
  English: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/>',
  Science: '<path d="M12 3c-4 3-4 7 0 9M12 3c4 3 4 7 0 9M12 12v9M7 21h10"/>',
};
