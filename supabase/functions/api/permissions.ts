/**
 * Roles and permissions — the one place that says who may do what.
 *
 * Every protected route asks for a PERMISSION, never a role name, and the
 * role always comes from the caller's own row in `profiles` (or the
 * `learners` table), never from anything the browser sends.
 *
 * Stored role values (see supabase/migrations/…_role_governance.sql):
 *   super_admin · admin · education_team · me · field_officer ·
 *   school_leader (shown as "School Head") · teacher — and `learner`, which
 *   lives in its own table.
 */

export const STAFF_ROLES = [
  "super_admin",
  "admin",
  "education_team",
  "me",
  "field_officer",
  "school_leader",
  "teacher",
] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];
export type Role = StaffRole | "learner";

export const ROLE_LABEL: Record<Role, string> = {
  super_admin: "Super Admin",
  admin: "Admin",
  education_team: "Education Team",
  me: "M&E",
  field_officer: "Field Officer",
  school_leader: "School Head",
  teacher: "Teacher",
  learner: "Learner",
};

/** Roles a person may ask for when they register without an invitation.
    Asking is all it does: the account stays `pending` until approved. */
export const SELF_REQUESTABLE_ROLES: StaffRole[] = ["teacher", "school_leader", "field_officer"];

export const ACCOUNT_STATUSES = ["pending", "active", "suspended", "rejected", "deactivated"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const PERMISSIONS = [
  // organisation: schools, counties, the calendar, classes, subjects
  "schools.manage",           // add, rename and remove schools and counties
  "schools.profile.view",     // a school's profile: head, staff and learner counts, classes, visits (within scope)
  "subjects.manage",
  "calendar.manage",          // academic years and terms
  "classes.manage.school",    // school head: create classes and assign teachers in their own school
  "classes.manage.all",       // every school in scope
  // learners: a teacher's class roster, a school's roster, every school in scope
  "learners.manage",          // teacher: learners in the classes they teach (and ones they added, until placed in a class)
  "learners.view.school",     // school head: everyone enrolled in their own school
  "learners.manage.school",   // school head: add, move between classes, archive, promote — own school only
  "learners.view.all",        // every learner in scope
  "learners.manage.all",
  "learners.transfer",        // move a learner to another school
  // teachers (and school heads) as people the programme supports — not account administration
  "teachers.view",            // names, schools, classes, training attended — no emails, no account actions
  // content library
  "library.read.learner",     // Digital Library shelf
  "library.read.staff",       // Teacher Resources shelf
  "library.read.head",        // For School Head shelf
  "library.manage",           // upload, publish, edit, archive; sees drafts; downloads
  "library.usage.view",
  // forms
  "forms.respond",
  "forms.manage",
  "forms.responses.view",
  // assignments, assessments and results (an assessment is an assignment here)
  "assignments.view.own",     // learner: assignments for their class, and their own results
  "assignments.submit",       // learner: start, save and hand in work
  "assignments.manage",       // teacher: create and run assignments for the classes they teach
  "assignments.grade",        // teacher: mark submissions in the classes they teach
  "assignments.view.school",  // school head: every assignment and result in their school
  "assignments.view.all",     // every school in scope
  // field visits
  "field_reports.create",     // field officer: at an assigned school
  "field_reports.view.own",
  "field_reports.view.all",   // every visit in scope
  // dashboards
  "stats.view",
  "intelligence.view",        // programme performance: executive, reach, learning, teachers, field operations, resources
  "learning.dashboard.view",  // the learning side only: learning, teacher development, digital resources
  "school.overview.view",     // school head: their own school
  "platform.view",            // platform overview and system health
  // data quality
  "data_quality.view",        // the Data Quality Center: issues, score, history
  "data_quality.manage",      // move issues through review / resolve / ignore, and correct them
                              // (a correction also needs the permission for that edit itself)
  // M&E: programme → outcomes → indicators → targets → actuals → evidence → report
  "me.view",                  // results, actuals, evidence and reports
  "me.framework.manage",      // programmes, outcomes, indicators, targets
  "me.actuals.record",        // record actuals and add evidence
  "me.actuals.verify",        // verify actuals someone else recorded
  "me.reports.manage",        // generate and finalize reports
  "trainings.manage",         // the training register: sessions and who attended
  "sync.monitor",             // the Sync center's field-team view: every staff device's sync state
  "sync.problems.view",       // devices whose work has been stuck for 48 hours or more, and the sync failures and conflicts behind it
  "notifications.view.all",   // the notifications log: who was told what, when, and when they read it
  // KoboToolbox
  "kobo.configure",           // the connection itself: server, API token, officer field, live push
  "kobo.manage",              // attach and remove surveys, and map their fields (Super Admin)
  "kobo.sync",                // sync the attached surveys and re-check their data
  "kobo.review",              // accept or exclude flagged submissions, school name matches
  "kobo.results.view",
  "kobo.surveys.fill",
  // reports and exports
  "reports.export",           // export reports (each report also needs its own data permission)
  "reports.programme",        // programme reports (term, county) without the dashboards
  // staff accounts
  "users.view",
  "users.invite",
  "users.approve",            // approve or reject a pending account
  "users.roles.assign",
  "users.status.manage",      // suspend, deactivate, reactivate
  "users.password.reset",
  "users.placement.assign",   // county and school, and data scope (assigned counties / schools)
  "users.edit",               // name, email, teacher type
  // governance
  "audit.view",               // the full audit log, security events, account activity
  "permissions.manage",       // grant and revoke individual permissions
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const uniq = (list: Permission[]) => [...new Set(list)];

/* Each management role's set is written out in full, so the matrix in
   docs/RBAC.md can be checked line by line against it. */
const LIBRARY_READ: Permission[] = ["library.read.learner", "library.read.staff", "library.read.head"];
const USER_ADMIN: Permission[] = [
  "users.view", "users.invite", "users.approve", "users.roles.assign", "users.status.manage",
  "users.password.reset", "users.placement.assign", "users.edit",
];

/* Programme Administration: organisation, people, learning and programme
   operations, data quality. Not the M&E results framework, not the
   platform (audit log, permissions, the Kobo connection). */
const ADMIN: Permission[] = [
  "schools.manage", "schools.profile.view", "calendar.manage", "classes.manage.all",
  "learners.view.all", "learners.manage.all", "learners.transfer", "teachers.view",
  ...LIBRARY_READ, "library.usage.view",
  "forms.manage", "forms.responses.view",
  "assignments.view.all", "field_reports.view.all", "stats.view",
  "data_quality.view", "data_quality.manage",
  "kobo.sync", "kobo.review", "kobo.results.view",
  "sync.monitor", "sync.problems.view", "notifications.view.all",
  "reports.export", "reports.programme",
  ...USER_ADMIN,
];

/* Monitoring & Evaluation: reads programme data, owns the results
   framework, indicator results, evidence, data quality and reporting.
   Changes no learner, school, account or integration. */
const ME: Permission[] = [
  "intelligence.view", "learning.dashboard.view", "stats.view", "schools.profile.view",
  "learners.view.all", "teachers.view", ...LIBRARY_READ, "library.usage.view",
  "forms.responses.view", "assignments.view.all", "field_reports.view.all",
  "data_quality.view", "data_quality.manage",
  "me.view", "me.framework.manage", "me.actuals.record", "me.actuals.verify", "me.reports.manage",
  "kobo.review", "kobo.results.view",
  "reports.export", "reports.programme",
];

/* Learning & Education: learners, teachers, classes, assignments and
   results (read), content, training, subjects, field support, forms. */
const EDUCATION_TEAM: Permission[] = [
  "learning.dashboard.view", "schools.profile.view", "subjects.manage",
  "learners.view.all", "teachers.view",
  ...LIBRARY_READ, "library.manage", "library.usage.view",
  "forms.manage", "forms.responses.view",
  "assignments.view.all", "field_reports.view.all", "trainings.manage",
  "sync.problems.view",
  "reports.export",
];

/* Platform Administration on top of everything the management roles hold.
   Never the working-role permissions (a teacher's roster, filing a field
   visit, answering forms): administrators run the portal, they don't act as
   a teacher or field officer inside it. */
const PLATFORM: Permission[] = ["platform.view", "permissions.manage", "audit.view", "kobo.configure", "kobo.manage"];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  super_admin: uniq([...ADMIN, ...ME, ...EDUCATION_TEAM, ...PLATFORM]),
  admin: uniq(ADMIN),
  me: uniq(ME),
  education_team: uniq(EDUCATION_TEAM),
  field_officer: [
    "forms.respond", "field_reports.create", "field_reports.view.own", "kobo.surveys.fill",
    "schools.profile.view", "teachers.view", "reports.export",
  ],
  school_leader: [
    "forms.respond", "school.overview.view", "schools.profile.view", "teachers.view",
    "learners.view.school", "learners.manage.school", "classes.manage.school",
    "assignments.view.school", ...LIBRARY_READ, "reports.export",
  ],
  teacher: [
    "forms.respond", "learners.manage", "assignments.manage", "assignments.grade",
    "library.read.learner", "library.read.staff", "reports.export",
  ],
  learner: ["library.read.learner", "assignments.view.own", "assignments.submit"],
};

export function permissionsFor(role: string | null | undefined): readonly Permission[] {
  return ROLE_PERMISSIONS[role as Role] ?? [];
}

/* ---- explicit grants ----
   A Super Admin may give one person one extra management permission (and
   take it back). Working-role permissions are tied to a teacher's classes, a
   head's school or a learner's own work, so they make no sense for anyone
   else; and the power to grant can't itself be granted. */
export const GRANTABLE_PERMISSIONS: Permission[] = ROLE_PERMISSIONS.super_admin.filter((p) => p !== "permissions.manage");
export const isPermission = (p: unknown): p is Permission => (PERMISSIONS as readonly string[]).includes(String(p));

/** The role's permissions plus this person's open grants (staff only). */
export function effectivePermissions(role: string | null | undefined, granted: readonly string[] = []): Set<Permission> {
  const out = new Set<Permission>(permissionsFor(role));
  if (role && role !== "learner") for (const g of granted) if (GRANTABLE_PERMISSIONS.includes(g as Permission)) out.add(g as Permission);
  return out;
}

/* ---- workspaces ---- */
export const WORKSPACE: Record<Role, { id: string; title: string; page: string }> = {
  super_admin: { id: "platform", title: "Platform Administration", page: "platform.html" },
  admin: { id: "admin", title: "Programme Administration", page: "admin.html" },
  me: { id: "me", title: "Monitoring & Evaluation", page: "me.html" },
  education_team: { id: "education", title: "Learning & Education", page: "education.html" },
  field_officer: { id: "field", title: "Field Operations", page: "field.html" },
  school_leader: { id: "school", title: "School Management", page: "leader.html" },
  teacher: { id: "teacher", title: "Teaching & Learning", page: "teacher.html" },
  learner: { id: "learner", title: "My Learning", page: "learner.html" },
};

export function can(role: string | null | undefined, permission: Permission): boolean {
  return permissionsFor(role).includes(permission);
}

/* ---- governance between staff accounts ---- */

/** Higher number = more authority over other accounts. */
const RANK: Record<StaffRole, number> = {
  super_admin: 3,
  admin: 2,
  education_team: 1, me: 1, field_officer: 1, school_leader: 1, teacher: 1,
};
export const rankOf = (role: string | null | undefined) => RANK[role as StaffRole] ?? 0;

/** Roles this actor may hand out (invite as, approve as, change to). */
export function grantableRoles(actorRole: string | null | undefined): StaffRole[] {
  if (actorRole === "super_admin") return [...STAFF_ROLES];
  if (actorRole === "admin") return STAFF_ROLES.filter((r) => rankOf(r) < rankOf("admin"));
  return [];
}

/** May this actor manage (edit, approve, change, deactivate…) that account?
    Never their own account, and never one at or above their own level —
    except that a Super Admin may manage other Super Admins. */
export function canManageAccount(
  actor: { id: string; role: string },
  target: { id: string; role: string },
): boolean {
  if (actor.id === target.id) return false;
  if (actor.role === "super_admin") return true;
  return rankOf(target.role) < rankOf(actor.role);
}

/* Which status changes are allowed, by action. */
export const STATUS_TRANSITIONS: Record<string, { from: AccountStatus[]; to: AccountStatus }> = {
  approve:    { from: ["pending", "rejected"], to: "active" },
  reject:     { from: ["pending"], to: "rejected" },
  suspend:    { from: ["active"], to: "suspended" },
  deactivate: { from: ["active", "suspended", "pending"], to: "deactivated" },
  reactivate: { from: ["suspended", "deactivated"], to: "active" },
};

/** Roles that must be placed in a school / a county. */
export const SCHOOL_ROLES: StaffRole[] = ["teacher", "school_leader"];
export const COUNTY_ROLES: StaffRole[] = ["field_officer"];

/* ---- the school year ---- */
export const GRADES = [
  "PP1", "PP2", "Grade 1", "Grade 2", "Grade 3", "Grade 4", "Grade 5", "Grade 6",
  "Grade 7", "Grade 8", "Grade 9", "Grade 10", "Grade 11", "Grade 12",
] as const;
/** The grade after this one, or null at the top (the learner has completed school). */
export function nextGrade(grade: string): string | null {
  const i = GRADES.indexOf(grade as (typeof GRADES)[number]);
  if (i < 0) return null;
  return GRADES[i + 1] ?? null;
}

export const ENROLLMENT_STATUSES = ["ACTIVE", "TRANSFERRED", "DROPPED_OUT", "COMPLETED", "INACTIVE"] as const;
export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];

/* ---- in words, for the Permissions page and "My access" ---- */
export const PERMISSION_GROUPS: { group: string; items: [Permission, string][] }[] = [
  { group: "Organisation", items: [
    ["schools.manage", "Add, rename and remove schools and counties"],
    ["schools.profile.view", "See school profiles"],
    ["calendar.manage", "Set up academic years and terms"],
    ["classes.manage.all", "Manage classes in every school in scope"],
    ["classes.manage.school", "Manage classes in their own school"],
    ["subjects.manage", "Manage subjects"],
  ] },
  { group: "People", items: [
    ["users.view", "See staff accounts"],
    ["users.invite", "Invite staff"],
    ["users.approve", "Approve or reject new accounts"],
    ["users.edit", "Edit staff details"],
    ["users.roles.assign", "Change staff roles"],
    ["users.placement.assign", "Change where staff work, and their data scope"],
    ["users.status.manage", "Suspend, deactivate and reactivate accounts"],
    ["users.password.reset", "Send someone a password reset link, or a temporary password"],
    ["teachers.view", "See teachers and school heads (no account actions)"],
    ["learners.view.all", "See learners in every school in scope"],
    ["learners.view.school", "See learners in their own school"],
    ["learners.manage.all", "Add and change learners in every school in scope"],
    ["learners.manage.school", "Add and change learners in their own school"],
    ["learners.manage", "Manage learners in the classes they teach"],
    ["learners.transfer", "Move learners between schools"],
  ] },
  { group: "Learning", items: [
    ["assignments.view.all", "See assignments and results in every school in scope"],
    ["assignments.view.school", "See assignments and results in their own school"],
    ["assignments.manage", "Set and run assignments for their classes"],
    ["assignments.grade", "Mark work for their classes"],
    ["assignments.view.own", "See their own assignments and results"],
    ["assignments.submit", "Do and hand in assignments"],
    ["library.manage", "Upload, publish and edit content"],
    ["library.read.learner", "Read the Digital Library"],
    ["library.read.staff", "Read Teacher Resources"],
    ["library.read.head", "Read the For School Head shelf"],
    ["library.usage.view", "See how content is used"],
    ["trainings.manage", "Keep the training register"],
  ] },
  { group: "Programme operations", items: [
    ["forms.manage", "Build and send forms"],
    ["forms.responses.view", "See form responses"],
    ["forms.respond", "Answer forms sent to them"],
    ["field_reports.view.all", "See field visits in scope"],
    ["field_reports.view.own", "See their own field visits"],
    ["field_reports.create", "File field visits at assigned schools"],
    ["kobo.configure", "Connect KoboToolbox (server, API token, live push)"],
    ["kobo.manage", "Attach Kobo surveys and map their fields"],
    ["kobo.sync", "Sync Kobo surveys and re-check their data"],
    ["kobo.review", "Accept or exclude flagged Kobo submissions"],
    ["kobo.results.view", "See Kobo survey results"],
    ["kobo.surveys.fill", "Fill Kobo surveys"],
    ["sync.monitor", "See field-team devices in the Sync center"],
    ["sync.problems.view", "See devices with work stuck for 48 hours or more, and sync failures"],
    ["notifications.view.all", "See the notifications log"],
  ] },
  { group: "Dashboards and M&E", items: [
    ["platform.view", "Platform overview and system health"],
    ["intelligence.view", "Programme performance dashboards"],
    ["learning.dashboard.view", "Learning dashboards"],
    ["school.overview.view", "Their own school's overview"],
    ["stats.view", "Programme statistics"],
    ["me.view", "See M&E results, evidence and reports"],
    ["me.framework.manage", "Manage the results framework (programmes, outcomes, indicators, targets)"],
    ["me.actuals.record", "Record indicator results and evidence"],
    ["me.actuals.verify", "Verify indicator results"],
    ["me.reports.manage", "Generate and finalize M&E reports"],
    ["data_quality.view", "See data quality issues"],
    ["data_quality.manage", "Resolve and correct data quality issues"],
  ] },
  { group: "Reports and governance", items: [
    ["reports.export", "Export reports (Excel, CSV, PDF)"],
    ["reports.programme", "Export programme reports (term, county)"],
    ["audit.view", "Audit log, security events and account activity"],
    ["permissions.manage", "Grant and revoke individual permissions"],
  ] },
];
export const PERMISSION_LABEL: Record<string, string> = Object.fromEntries(PERMISSION_GROUPS.flatMap((g) => g.items));
