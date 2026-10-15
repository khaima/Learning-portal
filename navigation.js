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
           item is a page; several make an area that opens in the sidebar
           to list them (docs/NAVIGATION.md §15).
   Item:  { page, label, icon, needs?: [any of these permissions],
           hash?: "#page?param=…" (a filtered view of a page),
           hidden?: true (opens — old links, links from inside the area —
           but isn't listed: its job moved onto another page),
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
  "platform-overview": { label: "Platform overview", icon: "dashboard", needs: ["platform.view"], purpose: "The platform at a glance, and what's waiting on someone." },
  "admin-overview": { label: "Administration overview", icon: "dashboard", needs: ["users.view"], purpose: "How the programme is organised, and what needs attention." },
  "me-dashboard": { label: "M&E overview", icon: "target", needs: ["me.view"], filters: ["county", "school"], purpose: "Every indicator against its target." },
  overview: { label: "Executive overview", icon: "dashboard", needs: ["intelligence.view"], filters: true, purpose: "The programme at a glance." },
  reach: { label: "Reach", icon: "globe", needs: ["intelligence.view"], filters: true, purpose: "Where the programme reaches: counties, schools, learners and teachers." },
  learning: { label: "Learning", icon: "results", needs: ["intelligence.view", "learning.dashboard.view"], filters: true, purpose: "How learners are doing: work handed in, marks and progress." },
  "teacher-development": { label: "Teacher development", icon: "teacher", needs: ["intelligence.view", "learning.dashboard.view"], filters: true, purpose: "Teachers' training, resource use and support." },
  "field-operations": { label: "Field operations", icon: "pin", needs: ["intelligence.view"], filters: true, purpose: "Field visits, visit forms and Kobo submissions." },
  "digital-resources": { label: "Digital resources", icon: "book", needs: ["intelligence.view", "learning.dashboard.view"], filters: true, purpose: "How the library is used." },
  "mel-framework": { label: "Results framework", icon: "layers", needs: ["me.view"], purpose: "Each programme's outcomes, indicators and targets." },
  "mel-results": { label: "Indicator results", icon: "target", needs: ["me.view"], filters: ["county", "school"], purpose: "Each indicator's target and actual. Record actuals here." },
  "mel-reports": { label: "M&E reports", icon: "log", needs: ["me.view"], filters: ["county", "school"], purpose: "Reports that keep a period's results." },
  "data-quality": { label: "Data quality", icon: "check", needs: ["data_quality.view"], badge: "dataQuality", filters: true, purpose: "Find and fix duplicate, missing or wrong records." },
  schools: { label: "Schools & counties", icon: "school", needs: ["schools.manage"], filters: true, purpose: "The counties and schools every list in the portal uses." },
  calendar: { label: "Academic calendar", icon: "calendar", needs: ["calendar.manage"], purpose: "The current school year, and starting the next." },
  classes: { label: "Classes", icon: "classes", needs: ["classes.manage.all", "learners.view.all"], purpose: "This year's classes in each school." },
  subjects: { label: "Subjects", icon: "tag", needs: ["subjects.manage"], purpose: "The subjects classes take and work is set in." },
  users: { label: "Staff accounts", icon: "users", needs: ["users.view"], badge: "approvals", heading: "Staff accounts", purpose: "Invite staff, approve requests, and change roles or access." },
  learners: { label: "Find a learner", icon: "cap", needs: ["learners.view.all"], purpose: "Find any learner, see their history, or move them." },
  teachers: { label: "All teachers", icon: "teacher", needs: ["teachers.view"], filters: ["county", "school"], purpose: "Where teachers and school heads work, and what they teach." },
  "school-profiles": { label: "All schools", icon: "school", needs: ["schools.profile.view"], filters: ["county", "school"], purpose: "Each school's teachers, learners, classes and visits." },
  assignments: { label: "Assignments & assessments", icon: "assignment", needs: ["assignments.view.all"], filters: ["county", "term"], purpose: "All work set in your area's schools (read-only)." },
  results: { label: "Results", icon: "results", needs: ["assignments.view.all"], purpose: "Work handed in and marks, by school, class or subject." },
  content: { label: "Content library", icon: "book", needs: ["library.manage", "library.usage.view"], filters: ["school"], heading: "Content library", purpose: "Upload resources, choose who sees them, see their use." },
  training: { label: "Training register", icon: "star", needs: ["trainings.manage", "intelligence.view"], purpose: "Training sessions and who attended." },
  forms: { label: "Forms", icon: "form", needs: ["forms.manage", "forms.responses.view"], purpose: "Send forms to staff, and read their responses." },
  "field-visits": { label: "Field visits", icon: "pin", needs: ["field_reports.view.all"], filters: ["county", "school", "term"], purpose: "Every visit filed in your area, newest first." },
  kobo: { label: "KoboToolbox", icon: "survey", needs: ["kobo.configure", "kobo.manage", "kobo.review", "kobo.results.view"], badge: "koboReview", purpose: "Connect KoboToolbox, choose the surveys to collect, and review submissions." },
  "survey-results": { label: "Survey results", icon: "chart", needs: ["kobo.results.view"], filters: ["county", "school"], purpose: "What each Kobo survey's counted submissions say, question by question." },
  reports: { label: "Reports & exports", icon: "download", needs: ["reports.export"], purpose: "Download the portal's data as Excel, CSV or PDF." },
  notifications: { label: "Notifications log", icon: "bell", needs: ["notifications.view.all"], filters: ["term"], heading: "Notifications sent", purpose: "Every notification sent, and whether it was read." },
  "sync-problems": { label: "Device sync", icon: "sync", needs: ["sync.problems.view"], purpose: "Devices with unsent work, and syncs that failed." },
  permissions: { label: "Permissions", icon: "shield", needs: ["permissions.manage"], purpose: "What each role may do, plus individual grants." },
  audit: { label: "Audit log", icon: "log", needs: ["audit.view"], purpose: "Every recorded change: who made it and when." },
  "account-activity": { label: "Account activity", icon: "activity", needs: ["audit.view"], purpose: "Who signs in and when, and learners locked out." },
};
/** A console page as a menu item, optionally relabelled or as a filtered view. */
const c = (page, extra = {}) => ({ page, ...PAGES[page], ...extra });

/* ---- the menus: one entry per area (docs/NAVIGATION.md §15) ----
   A workspace's `groups` are its sidebar entries, in order — at most seven.
   An entry with one item is a page; an entry with several is an AREA that
   opens in the sidebar to list its pages (nav.js), with a breadcrumb above
   each page. A page has one home per workspace: it's in one entry only
   (navigation_test.ts holds that). The same page has the same name in
   every workspace, unless what the role does there is different (Kobo
   review for M&E). Names are plain words, not the portal's internals.
   Account things — profile, notifications, the Sync center, sign out — are
   in the menu under the person's name, not here. */
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
        c("users", { label: "Approvals", icon: "approve", hash: "#users?status=pending", heading: "Waiting for approval",
          purpose: "People who asked to join. Approve or reject each request." }),
        c("permissions"),
        c("notifications", { label: "Notifications sent" }),
      ], { badge: "approvals" }),
      entry("organisation", "Organisation setup", "school", [
        c("schools", { label: "Counties & schools" }), c("calendar"), c("classes"), c("subjects"),
      ]),
      entry("integrations", "Data & integrations", "plug", [
        c("kobo"), c("forms"), c("data-quality"), c("sync-problems"),
      ]),
      entry("analytics", "Dashboards & reports", "chart", [
        c("overview"), c("reach"), c("learning"), c("teacher-development"), c("field-operations"), c("digital-resources"),
        c("survey-results"), c("mel-reports"), c("reports", { label: "Exports" }),
      ]),
      entry("security", "Audit & security", "shield", [
        c("audit"), c("audit", { label: "Security events", icon: "alert", hash: "#audit?kind=security",
          purpose: "Changes to who can sign in and what they may do." }), c("account-activity"),
      ]),
    ],
  },
  admin: {
    title: "Programme Administration", page: "admin.html", roles: ["admin", "super_admin"],
    question: "Is the programme organised and running correctly?",
    groups: [
      entry("dashboard", "Dashboard", "dashboard", [c("admin-overview", { label: "Dashboard" })]),
      entry("schools", "Schools", "school", [
        c("school-profiles"), c("teachers"), c("learners"), c("field-visits"),
        c("classes", { hidden: true }), // a school's classes are on its page; the old address still works
        c("schools", { label: "Counties & schools" }), c("calendar"),
      ]),
      entry("teaching", "Teaching & learning", "cap", [c("assignments"), c("results"), c("content")]),
      entry("surveys", "Surveys & forms", "survey", [c("forms"), c("kobo", { label: "Kobo surveys" }), c("survey-results")], { badge: "koboReview" }),
      entry("data-quality", "Data quality", "check", [c("data-quality", { label: "Data issues" }), c("sync-problems")], { badge: "dataQuality" }),
      entry("reports", "Reports", "download", [c("reports", { label: "Reports" })]),
      entry("users", "Users", "users", [
        c("users", { label: "Accounts", badge: undefined }), // the approvals count belongs on Approvals
        c("users", { label: "Approvals", icon: "approve", hash: "#users?status=pending", heading: "Waiting for approval",
          purpose: "People who asked to join. Approve or reject each request." }),
        c("notifications", { label: "Notifications sent" }),
      ], { badge: "approvals" }),
    ],
  },
  me: {
    title: "Monitoring & Evaluation", page: "me.html", roles: ["me", "super_admin"],
    question: "Are HPF programmes achieving their intended results?",
    groups: [
      entry("overview", "M&E overview", "target", [c("me-dashboard", { label: "M&E overview" })]),
      entry("framework", "Results framework", "layers", [c("mel-framework", { label: "Programmes & indicators" }), c("mel-results")]),
      entry("analytics", "Dashboards & reports", "chart", [
        c("overview"), c("reach"), c("learning"), c("teacher-development"), c("field-operations"), c("digital-resources"),
        c("mel-reports"), c("reports", { label: "Exports" }),
      ]),
      entry("data-quality", "Data quality", "check", [c("data-quality")], { badge: "dataQuality" }),
      entry("surveys", "Surveys & forms", "survey", [c("survey-results"), c("kobo", { label: "Kobo review", purpose: "Kobo submissions waiting for a decision before they are counted." }),
        c("forms", { label: "Form responses", purpose: "The forms sent to staff, and their responses." })], { badge: "koboReview" }),
      entry("schools", "Schools", "school", [
        c("school-profiles"), c("teachers"), c("learners"), c("field-visits"), c("classes", { hidden: true }),
      ]),
      entry("teaching", "Teaching & learning", "cap", [c("assignments"), c("results"), c("training"), c("content")]),
    ],
  },
  education: {
    title: "Learning & Education", page: "education.html", roles: ["education_team", "super_admin"],
    question: "How is learning going, and what support is needed?",
    groups: [
      entry("dashboard", "Dashboard", "dashboard", [c("learning", { label: "Dashboard" })]),
      entry("schools", "Schools", "school", [
        c("school-profiles"), c("teachers"), c("learners"), c("field-visits"), c("classes", { hidden: true }), c("sync-problems"),
      ]),
      entry("teaching", "Teaching & learning", "cap", [c("assignments"), c("results"), c("training")]),
      entry("content", "Content library", "book", [c("content", { label: "Library" }), c("subjects")]),
      entry("forms", "Forms", "form", [c("forms")]),
      entry("analytics", "Dashboards & reports", "chart", [c("teacher-development"), c("digital-resources"), c("reports", { label: "Exports" })]),
    ],
  },
  field: {
    title: "Field Operations", page: "field.html", roles: ["field_officer"],
    // Older links (notifications already sent, bookmarks) still land on the right page.
    aliases: { reports: "forms", "school-profiles": "schools" },
    question: "What needs to happen at the schools I support?",
    groups: [
      entry("dashboard", "Dashboard", "dashboard", [{ page: "dashboard", label: "Dashboard", icon: "dashboard" }]),
      entry("schools", "My schools", "school", [
        { page: "schools", label: "Schools", icon: "school", heading: "My schools", purpose: "The schools you support." },
        { page: "teachers", label: "Teachers", icon: "teacher", needs: ["teachers.view"], heading: "Teachers at my schools",
          purpose: "Who teaches what at your schools, and their training." },
      ]),
      entry("visits", "My visits", "pin", [{ page: "visits", label: "My visits", icon: "pin", purpose: "Record a school visit, and see the visits you've filed." }]),
      entry("surveys", "Surveys & forms", "survey", [
        { page: "kobo-surveys", label: "Kobo surveys", icon: "survey", needs: ["kobo.surveys.fill"], purpose: "The field surveys assigned to you." },
        { page: "forms", label: "Forms", icon: "form", purpose: "Forms the Education Team has sent you to fill in." },
      ]),
      entry("reports", "Reports", "download", [{ page: "activity", label: "Reports", icon: "download", purpose: "Download your visits and forms as Excel, CSV or PDF." }]),
    ],
  },
  school: {
    title: "School Management", page: "leader.html", roles: ["school_leader"],
    question: "What is happening in my school?",
    groups: [
      entry("dashboard", "Dashboard", "dashboard", [{ page: "overview", label: "Dashboard", icon: "dashboard" }]),
      entry("school", "My school", "school", [
        { page: "school-profile", label: "Profile", icon: "school", heading: "School profile", purpose: "Your school's classes, learners by grade, and recent visits." },
        { page: "teachers", label: "Teachers", icon: "teacher", purpose: "Your school's teachers, by type." },
        { page: "learners", label: "Learners & classes", icon: "cap", purpose: "Your school's learners and classes." },
        { page: "learning", label: "Assignments & results", icon: "results", purpose: "Work set in your school: handed in, and marks." },
        { page: "visits", label: "Visits", icon: "pin", purpose: "Field officers' visits to your school." },
      ]),
      entry("resources", "Learning resources", "book", [{ page: "resources", label: "Learning resources", icon: "book",
        purpose: "Resources for you, your teachers and your learners." }]),
      entry("reports", "Reports", "download", [{ page: "reports", label: "Reports", icon: "download", purpose: "Download your school's data as Excel, CSV or PDF." }]),
    ],
  },
  teacher: {
    title: "Teaching & Learning", page: "teacher.html", roles: ["teacher"],
    question: "What is happening in my classes and with my learners?",
    groups: [
      entry("dashboard", "Dashboard", "dashboard", [{ page: "home", label: "Dashboard", icon: "dashboard" }]),
      entry("classes", "My classes", "classes", [
        { page: "my-classes", label: "Classes", icon: "classes", heading: "My classes", purpose: "The classes you teach this year." },
        { page: "my-learners", label: "Class roster", icon: "cap", purpose: "Your learners and their sign-ins." },
      ]),
      entry("assessments", "Assessments", "assignment", [{ page: "assignments", label: "Assessments", icon: "assignment", badge: "toMark",
        purpose: "Set work for your classes, and mark what learners hand in." }], { badge: "toMark" }),
      entry("results", "Results", "results", [{ page: "results", label: "Results & progress", icon: "results",
        purpose: "How your learners are doing: work handed in and marks." }]),
      entry("resources", "Learning resources", "book", [
        { page: "resources", label: "Library", icon: "book", purpose: "Resources for you, and the library your learners see." },
        { page: "activity", label: "Reading activity", icon: "clock", purpose: "What you've read in the library, and for how long." },
      ]),
      entry("reports", "Reports", "download", [{ page: "reports", label: "Reports", icon: "download", purpose: "Download your classes' data as Excel, CSV or PDF." }]),
    ],
  },
  learner: {
    title: "My Learning", page: "learner.html", roles: ["learner"],
    question: "What do I need to learn, complete and improve?",
    groups: [
      entry("home", "Home", "home", [{ page: "home", label: "Home", icon: "home" }]),
      entry("classes", "My classes", "classes", [{ page: "my-learning", label: "My classes", icon: "classes", purpose: "Your classes, their subjects and your teachers." }]),
      entry("assignments", "My assignments", "assignment", [{ page: "assignments", label: "My assignments", icon: "assignment",
        purpose: "Work your teachers have set. Open one to start." }]),
      entry("progress", "My progress", "results", [
        { page: "my-progress", label: "Progress", icon: "results", heading: "My progress", purpose: "How much of your work is handed in, and your marks." },
        { page: "activity", label: "Reading activity", icon: "clock", purpose: "What you've read in the library, and for how long." },
      ]),
      entry("library", "Library", "book", [{ page: "resources", label: "Library", icon: "book", purpose: "Readings, videos and worksheets for you to explore." }]),
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
