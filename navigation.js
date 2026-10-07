/* ============================================================
   HPF Digital Learning Portal — who sees which menu.

   One place for every role's sidebar: workspace → groups → items. nav.js
   builds the sidebar from it after sign-in, keeping only the items the
   person's permissions allow (from GET /me — role permissions plus any
   explicit grants), and opens only those pages: typing another page's
   address sends them back to their own landing page.

   This decides what is SHOWN. The API checks every request again —
   permission and data scope — so hiding something here is never the
   security; it just keeps each workspace about one responsibility.
   (docs/RBAC.md has the full model.)

   Item: { page, label, icon, needs?: [any of these permissions],
           hash?: "#page?param=…" (a filtered view of a page),
           badge?: key from GET /nav/badges, filters?: true (the page uses
           the county / school / term filter bar), action?: "sync" | "notifications" }
   ============================================================ */

const P = (d) => d;
export const ICON = {
  dashboard: P('<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>'),
  users: P('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
  approve: P('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="m16 11 2 2 4-4"/>'),
  school: P('<path d="M4 21V8l8-5 8 5v13"/><path d="M9 21v-6h6v6"/>'),
  calendar: P('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>'),
  cap: P('<path d="M22 10 12 5 2 10l10 5 10-5Z"/><path d="M6 12v5c0 1.5 3 3 6 3s6-1.5 6-3v-5"/>'),
  teacher: P('<path d="M4 19V6a2 2 0 0 1 2-2h13v14H6a2 2 0 0 0-2 2Zm0 0a2 2 0 0 0 2 2h13"/><path d="M9 8h7M9 11h7"/>'),
  classes: P('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'),
  assignment: P('<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/>'),
  results: P('<path d="M12 20V10M18 20V4M6 20v-6"/>'),
  book: P('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/>'),
  chart: P('<path d="M3 3v18h18"/><rect x="7" y="10" width="3" height="7"/><rect x="12" y="6" width="3" height="11"/><rect x="17" y="13" width="3" height="4"/>'),
  globe: P('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'),
  target: P('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>'),
  layers: P('<path d="m12 2 10 5-10 5L2 7l10-5Z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>'),
  check: P('<path d="M9 11l3 3 8-8"/><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/>'),
  pin: P('<path d="M12 21s7-6.1 7-11.5A7 7 0 0 0 5 9.5C5 14.9 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.5"/>'),
  form: P('<path d="M4 19V5a2 2 0 0 1 2-2h9l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/><path d="M9 13l2 2 4-4"/>'),
  survey: P('<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 14l2 2 4-4"/>'),
  sync: P('<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5M3 21v-5h5"/>'),
  bell: P('<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>'),
  download: P('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>'),
  shield: P('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>'),
  log: P('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>'),
  alert: P('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>'),
  activity: P('<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>'),
  plug: P('<path d="M12 22v-5M9 8V2M15 8V2M18 8v5a6 6 0 0 1-12 0V8Z"/>'),
  user: P('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  tag: P('<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z"/><circle cx="7.5" cy="7.5" r="1.5"/>'),
  clock: P('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>'),
  home: P('<path d="M3 11 12 3l9 8"/><path d="M5 10v10h14V10"/>'),
  star: P('<path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8-6.2-3.2L5.8 21 7 14.2 2 9.3l6.9-1Z"/>'),
};

/* ---- the console pages (platform / admin / me / education share them) ---- */
const PAGES = {
  "platform-overview": { label: "Platform overview", icon: "dashboard", needs: ["platform.view"] },
  "admin-overview": { label: "Administration overview", icon: "dashboard", needs: ["users.view"] },
  "me-dashboard": { label: "M&E overview", icon: "target", needs: ["me.view"], filters: true },
  overview: { label: "Executive overview", icon: "dashboard", needs: ["intelligence.view"], filters: true },
  reach: { label: "Reach", icon: "globe", needs: ["intelligence.view"], filters: true },
  learning: { label: "Learning", icon: "results", needs: ["intelligence.view", "learning.dashboard.view"], filters: true },
  "teacher-development": { label: "Teacher development", icon: "teacher", needs: ["intelligence.view", "learning.dashboard.view"], filters: true },
  "field-operations": { label: "Field operations", icon: "pin", needs: ["intelligence.view"], filters: true },
  "digital-resources": { label: "Digital resources", icon: "book", needs: ["intelligence.view", "learning.dashboard.view"], filters: true },
  "mel-framework": { label: "Results framework", icon: "layers", needs: ["me.view"] },
  "mel-results": { label: "Indicator results", icon: "target", needs: ["me.view"], filters: true },
  "mel-reports": { label: "M&E reports", icon: "log", needs: ["me.view"], filters: true },
  "data-quality": { label: "Data quality", icon: "check", needs: ["data_quality.view"], badge: "dataQuality", filters: true },
  schools: { label: "Schools & counties", icon: "school", needs: ["schools.manage"], filters: true },
  calendar: { label: "Academic calendar", icon: "calendar", needs: ["calendar.manage"] },
  classes: { label: "Classes", icon: "classes", needs: ["classes.manage.all", "learners.view.all"] },
  subjects: { label: "Subjects", icon: "tag", needs: ["subjects.manage"] },
  users: { label: "Staff accounts", icon: "users", needs: ["users.view"], badge: "approvals" },
  learners: { label: "Learners", icon: "cap", needs: ["learners.view.all"] },
  teachers: { label: "Teachers", icon: "teacher", needs: ["teachers.view"] },
  "school-profiles": { label: "School profiles", icon: "school", needs: ["schools.profile.view"] },
  assignments: { label: "Assignments & assessments", icon: "assignment", needs: ["assignments.view.all"] },
  results: { label: "Results", icon: "results", needs: ["assignments.view.all"] },
  content: { label: "Content library", icon: "book", needs: ["library.manage", "library.usage.view"], filters: true },
  training: { label: "Training register", icon: "star", needs: ["trainings.manage", "intelligence.view"] },
  forms: { label: "Forms", icon: "form", needs: ["forms.manage", "forms.responses.view"] },
  "field-visits": { label: "Field visits", icon: "pin", needs: ["field_reports.view.all"] },
  kobo: { label: "KoboToolbox", icon: "survey", needs: ["kobo.configure", "kobo.manage", "kobo.review", "kobo.results.view"], badge: "koboReview" },
  "survey-results": { label: "Survey results", icon: "chart", needs: ["kobo.results.view"], filters: true },
  reports: { label: "Reports & exports", icon: "download", needs: ["reports.export"] },
  notifications: { label: "Notifications log", icon: "bell", needs: ["notifications.view.all"], filters: true },
  "sync-problems": { label: "Stuck devices", icon: "sync", needs: ["sync.problems.view"] },
  permissions: { label: "Permissions", icon: "shield", needs: ["permissions.manage"] },
  audit: { label: "Audit log", icon: "log", needs: ["audit.view"] },
  "account-activity": { label: "Account activity", icon: "activity", needs: ["audit.view"] },
};
/** A console page as a menu item, optionally relabelled or as a filtered view. */
const c = (page, extra = {}) => ({ page, ...PAGES[page], ...extra });
const ACCOUNT = (more = []) => ({
  label: "Account",
  items: [
    { page: "profile", label: "My profile", icon: "user" },
    { action: "notifications", label: "Notifications", icon: "bell", badge: "notifications" },
    ...more,
  ],
});
const SYNC = { action: "sync", label: "Sync center", icon: "sync" };

export const WORKSPACES = {
  platform: {
    title: "Platform Administration", page: "platform.html", roles: ["super_admin"],
    question: "Is the platform secure, healthy and correctly configured?",
    groups: [
      { label: "Dashboard", items: [c("platform-overview"), c("admin-overview"), c("me-dashboard")] },
      { label: "System management", items: [c("users", { label: "Users & roles" }), c("schools"), c("calendar"), c("classes", { label: "Classes & structure" }), c("subjects")] },
      { label: "People & learning", items: [c("learners"), c("teachers"), c("school-profiles"), c("assignments"), c("results"), c("content"), c("training")] },
      { label: "Programme performance", items: [c("overview"), c("reach"), c("learning"), c("teacher-development"), c("field-operations"), c("digital-resources")] },
      { label: "M&E and data", items: [c("mel-framework"), c("mel-results"), c("mel-reports"), c("data-quality"), c("survey-results"), c("field-visits")] },
      { label: "Integrations", items: [c("kobo"), c("forms"), c("notifications"), c("sync-problems"), SYNC] },
      { label: "Security", items: [c("permissions"), c("audit"), c("audit", { label: "Security events", icon: "alert", hash: "#audit?kind=security" }), c("account-activity")] },
      { label: "Reports", items: [c("reports", { label: "System reports" })] },
      ACCOUNT(),
    ],
  },
  admin: {
    title: "Programme Administration", page: "admin.html", roles: ["admin", "super_admin"],
    question: "Is the programme operationally organised and running correctly?",
    groups: [
      { label: "Dashboard", items: [c("admin-overview")] },
      { label: "Organisation", items: [c("schools"), c("school-profiles"), c("calendar"), c("classes")] },
      { label: "People", items: [
        c("users", { label: "Staff accounts", badge: undefined }),
        c("teachers"),
        c("users", { label: "School heads", icon: "school", hash: "#users?role=school_leader", badge: undefined }),
        c("learners"),
        c("users", { label: "User approvals", icon: "approve", hash: "#users?status=pending" }),
      ] },
      { label: "Learning operations", items: [c("assignments"), c("results"), c("content", { label: "Learning resources" })] },
      { label: "Programme operations", items: [c("forms"), c("field-visits"), c("kobo", { label: "Kobo surveys" }), c("survey-results"), c("sync-problems"), SYNC] },
      { label: "Data", items: [c("data-quality"), c("reports", { label: "Reports & exports" })] },
      ACCOUNT([c("notifications")]),
    ],
  },
  me: {
    title: "Monitoring & Evaluation", page: "me.html", roles: ["me", "super_admin"],
    question: "Are HPF programmes achieving their intended results — and can we show it with reliable data?",
    groups: [
      { label: "Dashboard", items: [c("me-dashboard")] },
      { label: "Programme performance", items: [c("overview"), c("reach"), c("learning", { label: "Learning outcomes" }), c("teacher-development"),
        c("digital-resources", { label: "Digital resource usage" }), c("field-operations")] },
      { label: "Results framework", items: [c("mel-framework", { label: "Programmes & indicators" }), c("mel-results")] },
      { label: "Data quality", items: [c("data-quality", { label: "Data Quality Center" }), c("kobo", { label: "Kobo data quality" })] },
      { label: "Evidence", items: [c("survey-results"), c("field-visits"), c("forms", { label: "Form responses" })] },
      { label: "Programme data", items: [c("learners"), c("teachers"), c("classes"), c("school-profiles"), c("assignments"), c("results"),
        c("training"), c("content", { label: "Content usage" })] },
      { label: "Reporting", items: [c("mel-reports"), c("reports", { label: "Reports & exports" })] },
      ACCOUNT(),
    ],
  },
  education: {
    title: "Learning & Education", page: "education.html", roles: ["education_team", "super_admin"],
    question: "How is learning happening, and what support do teachers and learners need?",
    groups: [
      { label: "Dashboard", items: [c("learning", { label: "Learning overview", icon: "dashboard" })] },
      { label: "Learning", items: [c("learners"), c("teachers"), c("classes"), c("assignments"), c("results")] },
      { label: "Content & curriculum", items: [c("content"), c("digital-resources", { label: "Content usage" }), c("subjects")] },
      { label: "Teacher development", items: [c("teacher-development"), c("training")] },
      { label: "Field support", items: [c("school-profiles", { label: "School support" }), c("field-visits"), c("forms", { label: "Education forms" }), c("sync-problems")] },
      { label: "Reports", items: [c("reports", { label: "Learning reports" })] },
      ACCOUNT(),
    ],
  },
  field: {
    title: "Field Operations", page: "field.html", roles: ["field_officer"],
    // Older links (notifications already sent) still land on the right page.
    aliases: { reports: "forms" },
    question: "What needs to happen at the schools I support?",
    groups: [
      { label: "Dashboard", items: [{ page: "dashboard", label: "My dashboard", icon: "dashboard" }] },
      { label: "My work", items: [
        { page: "schools", label: "My schools", icon: "school" },
        { page: "visits", label: "My visits", icon: "pin" },
        { page: "forms", label: "Visit forms", icon: "form" },
        { page: "kobo-surveys", label: "Kobo surveys", icon: "survey", needs: ["kobo.surveys.fill"] },
      ] },
      { label: "Schools", items: [{ page: "school-profiles", label: "School profiles", icon: "school", needs: ["schools.profile.view"] }] },
      { label: "Learning support", items: [{ page: "teachers", label: "Teachers", icon: "teacher", needs: ["teachers.view"] }] },
      { label: "Reports", items: [{ page: "activity", label: "My activity", icon: "activity" }] },
      ACCOUNT([SYNC]),
    ],
  },
  school: {
    title: "School Management", page: "leader.html", roles: ["school_leader"],
    question: "What is happening in my school?",
    groups: [
      { label: "Dashboard", items: [{ page: "overview", label: "School overview", icon: "dashboard" }] },
      { label: "My school", items: [
        { page: "school-profile", label: "School profile", icon: "school" },
        { page: "teachers", label: "Teachers", icon: "teacher" },
        { page: "learners", label: "Learners & classes", icon: "cap" },
      ] },
      { label: "Learning", items: [
        { page: "learning", label: "Assignments & results", icon: "results" },
        { page: "resources", label: "Learning resources", icon: "book" },
      ] },
      { label: "Reports", items: [{ page: "reports", label: "School reports", icon: "download" }] },
      ACCOUNT(),
    ],
  },
  teacher: {
    title: "Teaching & Learning", page: "teacher.html", roles: ["teacher"],
    question: "What is happening in my classes and with my learners?",
    groups: [
      { label: "Dashboard", items: [{ page: "home", label: "My teaching", icon: "dashboard" }] },
      { label: "My teaching", items: [
        { page: "my-classes", label: "My classes", icon: "classes" },
        { page: "my-learners", label: "Class roster", icon: "cap" },
        { page: "assignments", label: "Assignments & assessments", icon: "assignment", badge: "toMark" },
        { page: "results", label: "Results & progress", icon: "results" },
      ] },
      { label: "Content", items: [{ page: "resources", label: "Learning resources", icon: "book" }] },
      { label: "Activity", items: [{ page: "activity", label: "My activity", icon: "clock" }] },
      ACCOUNT(),
    ],
  },
  learner: {
    title: "My Learning", page: "learner.html", roles: ["learner"],
    question: "What do I need to learn, complete and improve?",
    groups: [
      { label: "Dashboard", items: [{ page: "home", label: "My learning", icon: "home" }] },
      { label: "My learning", items: [
        { page: "my-learning", label: "My classes", icon: "classes" },
        { page: "assignments", label: "My assignments", icon: "assignment" },
        { page: "my-progress", label: "My progress", icon: "results" },
        { page: "activity", label: "My activity", icon: "clock" },
      ] },
      { label: "Library", items: [{ page: "resources", label: "Learning library", icon: "book" }] },
      ACCOUNT(),
    ],
  },
};

/** Each role's own workspace. */
export const ROLE_WORKSPACE = {
  super_admin: "platform", admin: "admin", me: "me", education_team: "education",
  field_officer: "field", school_leader: "school", teacher: "teacher", learner: "learner",
};
export const workspacePage = (role) => WORKSPACES[ROLE_WORKSPACE[role]]?.page ?? "index.html";

/* Console pages someone reaches only through an explicit grant (e.g. an
   Education Team member granted kobo.results.view) are listed together, so
   a grant shows in the menu as well as being allowed by the API. Each
   role's own menu above already lists every page its role opens. */
const CONSOLE_WORKSPACES = new Set(["platform", "admin", "me", "education"]);

/** The menu for this person in this workspace: groups of the items their
    permissions allow, plus pages opened to them by a grant. */
export function menuFor(workspaceId, permissions = [], grants = []) {
  const ws = WORKSPACES[workspaceId];
  if (!ws) return [];
  const held = new Set(permissions);
  const allowed = (it) => !it.needs || it.needs.some((p) => held.has(p));
  const groups = ws.groups.map((g) => ({ label: g.label, items: g.items.filter(allowed) })).filter((g) => g.items.length);
  if (CONSOLE_WORKSPACES.has(workspaceId) && grants.length) {
    const have = new Set(groups.flatMap((g) => g.items.map((i) => i.page)));
    const extra = Object.entries(PAGES).filter(([page, it]) => !have.has(page) && it.needs?.some((p) => grants.includes(p))).map(([page]) => c(page));
    if (extra.length) groups.splice(groups.length - 1, 0, { label: "Granted to you", items: extra });
  }
  return groups;
}

/** Every console page someone with these permissions may open (for the
    check that each role's menu lists all of them — navigation_test). */
export const consolePagesFor = (permissions) => Object.entries(PAGES)
  .filter(([, it]) => it.needs.some((p) => permissions.includes(p))).map(([page]) => page);
