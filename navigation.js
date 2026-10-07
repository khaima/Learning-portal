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

   Entry (a sidebar row): { id, label, icon, items: [Item…], badge? } — one
           item is a page; several make a module whose items are its tabs.
   Item:  { page, label, icon, needs?: [any of these permissions],
           hash?: "#page?param=…" (a filtered view of a page),
           badge?: key from GET /nav/badges, filters?: true (the page uses
           the county / school / term filter bar) }
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

/* ---- the menus: one entry per module (docs/NAVIGATION.md) ----
   A workspace's `groups` are its sidebar entries, in order. An entry with
   one item is a page; an entry with several is a MODULE — the sidebar
   shows it once, opening its first item the person may see, and the
   others are its tabs (nav.js draws them, with a breadcrumb, at the top of
   each of its pages). A page has one home per workspace: it's in one
   entry only (navigation_test.ts holds that). Account things — profile,
   notifications, the Sync center, sign out — are in the menu under the
   person's name, not here. */
const entry = (id, label, icon, items, extra = {}) => ({ id, label, icon, items, ...extra });

export const WORKSPACES = {
  platform: {
    title: "Platform Administration", page: "platform.html", roles: ["super_admin"],
    question: "Is the platform secure, healthy and correctly configured?",
    // The operational areas — administration, M&E, learning — are the other
    // workspaces, reached deliberately with "Switch workspace" (nav.js).
    groups: [
      entry("overview", "Overview", "dashboard", [c("platform-overview", { label: "Overview" })]),
      entry("users", "Users & roles", "users", [
        c("users", { label: "Accounts", badge: undefined }), // the approvals count belongs on Approvals
        c("users", { label: "Approvals", icon: "approve", hash: "#users?status=pending" }),
        c("permissions", { label: "Permissions & grants" }),
        c("notifications", { label: "Notifications sent" }),
      ], { badge: "approvals" }),
      entry("organisation", "Organisation setup", "school", [
        c("schools", { label: "Counties & schools" }), c("calendar"), c("classes", { label: "Classes & structure" }), c("subjects"),
      ]),
      entry("integrations", "Data & integrations", "plug", [
        c("kobo"), c("forms", { label: "Form registry" }), c("data-quality", { label: "Validation" }), c("sync-problems", { label: "Sync monitor" }),
      ]),
      entry("analytics", "Reports & analytics", "chart", [
        c("reports", { label: "Exports" }), c("overview", { label: "Executive" }), c("reach"), c("learning"), c("teacher-development"),
        c("field-operations"), c("digital-resources"), c("survey-results"), c("mel-reports"),
      ]),
      entry("security", "Audit & security", "shield", [
        c("audit"), c("audit", { label: "Security events", icon: "alert", hash: "#audit?kind=security" }), c("account-activity"),
      ]),
    ],
  },
  admin: {
    title: "Programme Administration", page: "admin.html", roles: ["admin", "super_admin"],
    question: "Is the programme operationally organised and running correctly?",
    groups: [
      entry("dashboard", "Dashboard", "dashboard", [c("admin-overview", { label: "Dashboard" })]),
      entry("schools", "Schools", "school", [
        c("school-profiles", { label: "Schools" }), c("teachers"), c("learners"), c("classes"),
        c("schools", { label: "Counties & schools" }), c("calendar"),
      ]),
      entry("field", "Field operations", "pin", [
        c("field-visits", { label: "Visits" }), c("forms"), c("kobo", { label: "Kobo surveys" }), c("survey-results"), c("sync-problems"),
      ]),
      entry("education", "Education programmes", "cap", [c("assignments"), c("results"), c("content", { label: "Content library" })]),
      entry("data-quality", "Data quality", "check", [c("data-quality")], { badge: "dataQuality" }),
      entry("reports", "Reports", "download", [c("reports", { label: "Reports" })]),
      entry("users", "Users", "users", [
        c("users", { label: "Accounts", badge: undefined }), // the approvals count belongs on Approvals
        c("users", { label: "Approvals", icon: "approve", hash: "#users?status=pending" }),
        c("notifications", { label: "Notifications sent" }),
      ], { badge: "approvals" }),
    ],
  },
  me: {
    title: "Monitoring & Evaluation", page: "me.html", roles: ["me", "super_admin"],
    question: "Are HPF programmes achieving their intended results — and can we show it with reliable data?",
    groups: [
      entry("overview", "M&E overview", "target", [c("me-dashboard", { label: "M&E overview" })]),
      entry("framework", "Results framework", "layers", [c("mel-framework", { label: "Programmes & indicators" }), c("mel-results")]),
      entry("analytics", "Reports & analytics", "chart", [
        c("overview", { label: "Executive" }), c("reach"), c("learning", { label: "Learning outcomes" }), c("teacher-development"),
        c("digital-resources"), c("field-operations"), c("mel-reports"), c("reports", { label: "Exports" }), c("content", { label: "Content library" }),
      ]),
      entry("data-quality", "Data quality", "check", [c("data-quality"), c("kobo", { label: "Kobo review" })], { badge: "dataQuality" }),
      entry("schools", "Schools", "school", [
        c("school-profiles", { label: "Schools" }), c("teachers"), c("learners"), c("classes"), c("assignments"), c("results"),
        c("field-visits", { label: "Visits" }), c("training"),
      ]),
      entry("surveys", "Surveys & forms", "survey", [c("survey-results"), c("forms", { label: "Form responses" })]),
    ],
  },
  education: {
    title: "Learning & Education", page: "education.html", roles: ["education_team", "super_admin"],
    question: "How is learning happening, and what support do teachers and learners need?",
    groups: [
      entry("dashboard", "Dashboard", "dashboard", [c("learning", { label: "Dashboard" })]),
      entry("schools", "Schools & learning", "school", [
        c("school-profiles", { label: "Schools" }), c("teachers"), c("learners"), c("classes"),
        c("field-visits", { label: "Visits" }), c("sync-problems", { label: "Devices" }),
      ]),
      entry("activities", "Activities", "star", [c("training"), c("teacher-development"), c("forms", { label: "Education forms" })]),
      entry("assessments", "Assessments", "assignment", [c("assignments"), c("results")]),
      entry("content", "Content & resources", "book", [c("content", { label: "Content library" }), c("digital-resources", { label: "Usage" }), c("subjects")]),
      entry("reports", "Education reports", "download", [c("reports", { label: "Reports" })]),
    ],
  },
  field: {
    title: "Field Operations", page: "field.html", roles: ["field_officer"],
    // Older links (notifications already sent) still land on the right page.
    aliases: { reports: "forms" },
    question: "What needs to happen at the schools I support?",
    groups: [
      entry("dashboard", "Dashboard", "dashboard", [{ page: "dashboard", label: "Dashboard", icon: "dashboard" }]),
      entry("schools", "My schools", "school", [
        { page: "schools", label: "My schools", icon: "school" },
        { page: "school-profiles", label: "School profiles", icon: "school", needs: ["schools.profile.view"] },
        { page: "teachers", label: "Teachers", icon: "teacher", needs: ["teachers.view"] },
      ]),
      entry("visits", "My visits", "pin", [{ page: "visits", label: "My visits", icon: "pin" }]),
      entry("surveys", "Field surveys", "survey", [
        { page: "kobo-surveys", label: "Kobo surveys", icon: "survey", needs: ["kobo.surveys.fill"] },
        { page: "forms", label: "Forms", icon: "form" },
      ]),
      entry("reports", "Reports", "download", [{ page: "activity", label: "Reports", icon: "download" }]),
    ],
  },
  school: {
    title: "School Management", page: "leader.html", roles: ["school_leader"],
    question: "What is happening in my school?",
    groups: [
      entry("dashboard", "Dashboard", "dashboard", [{ page: "overview", label: "Dashboard", icon: "dashboard" }]),
      entry("school", "My school", "school", [
        { page: "school-profile", label: "Profile", icon: "school" },
        { page: "teachers", label: "Teachers", icon: "teacher" },
        { page: "learners", label: "Learners & classes", icon: "cap" },
        { page: "learning", label: "Assignments & results", icon: "results" },
      ]),
      entry("resources", "Learning resources", "book", [{ page: "resources", label: "Learning resources", icon: "book" }]),
      entry("reports", "Reports", "download", [{ page: "reports", label: "Reports", icon: "download" }]),
    ],
  },
  teacher: {
    title: "Teaching & Learning", page: "teacher.html", roles: ["teacher"],
    question: "What is happening in my classes and with my learners?",
    groups: [
      entry("dashboard", "Dashboard", "dashboard", [{ page: "home", label: "Dashboard", icon: "dashboard" }]),
      entry("classes", "My classes", "classes", [
        { page: "my-classes", label: "My classes", icon: "classes" },
        { page: "my-learners", label: "Class roster", icon: "cap" },
      ]),
      entry("assessments", "Assessments", "assignment", [{ page: "assignments", label: "Assessments", icon: "assignment", badge: "toMark" }], { badge: "toMark" }),
      entry("results", "Results", "results", [{ page: "results", label: "Results & progress", icon: "results" }]),
      entry("resources", "Learning resources", "book", [
        { page: "resources", label: "Learning resources", icon: "book" },
        { page: "activity", label: "Reading activity", icon: "clock" },
      ]),
      entry("reports", "Reports", "download", [{ page: "reports", label: "Reports", icon: "download" }]),
    ],
  },
  learner: {
    title: "My Learning", page: "learner.html", roles: ["learner"],
    question: "What do I need to learn, complete and improve?",
    groups: [
      entry("home", "Home", "home", [{ page: "home", label: "Home", icon: "home" }]),
      entry("classes", "My classes", "classes", [{ page: "my-learning", label: "My classes", icon: "classes" }]),
      entry("assignments", "My assignments", "assignment", [{ page: "assignments", label: "My assignments", icon: "assignment" }]),
      entry("progress", "My progress", "results", [
        { page: "my-progress", label: "My progress", icon: "results" },
        { page: "activity", label: "Reading activity", icon: "clock" },
      ]),
      entry("library", "Library", "book", [{ page: "resources", label: "Library", icon: "book" }]),
    ],
  },
};

/** Each role's own workspace. */
export const ROLE_WORKSPACE = {
  super_admin: "platform", admin: "admin", me: "me", education_team: "education",
  field_officer: "field", school_leader: "school", teacher: "teacher", learner: "learner",
};
export const workspacePage = (role) => WORKSPACES[ROLE_WORKSPACE[role]]?.page ?? "index.html";
/** The workspaces this role may open: its own first (a Super Admin can switch into the other management ones). */
export const workspacesFor = (role) => [ROLE_WORKSPACE[role], ...Object.keys(WORKSPACES).filter((id) => id !== ROLE_WORKSPACE[role] && WORKSPACES[id].roles.includes(role))]
  .filter((id) => WORKSPACES[id]);

/* Console pages someone reaches only through an explicit grant (e.g. an
   Education Team member granted kobo.results.view) are listed together, so
   a grant shows in the menu as well as being allowed by the API. Each
   role's own menu above already lists every page its role opens. */
const CONSOLE_WORKSPACES = new Set(["platform", "admin", "me", "education"]);

/** The menu for this person in this workspace: its entries, each with the
    items (tabs) their permissions allow — an entry with none is left out —
    plus pages opened to them by a grant, as an entry of their own. */
export function menuFor(workspaceId, permissions = [], grants = []) {
  const ws = WORKSPACES[workspaceId];
  if (!ws) return [];
  const held = new Set(permissions);
  const allowed = (it) => !it.needs || it.needs.some((p) => held.has(p));
  const groups = ws.groups.map((g) => ({ ...g, items: g.items.filter(allowed) })).filter((g) => g.items.length);
  if (CONSOLE_WORKSPACES.has(workspaceId) && grants.length) {
    const have = new Set(groups.flatMap((g) => g.items.map((i) => i.page)));
    const extra = Object.entries(PAGES).filter(([page, it]) => !have.has(page) && it.needs?.some((p) => grants.includes(p))).map(([page]) => c(page));
    if (extra.length) groups.push(entry("granted", "Granted to you", "star", extra));
  }
  return groups;
}

/** Every console page someone with these permissions may open (for the
    check that each role's menu lists all of them — navigation_test). */
export const consolePagesFor = (permissions) => Object.entries(PAGES)
  .filter(([, it]) => it.needs.some((p) => permissions.includes(p))).map(([page]) => page);
