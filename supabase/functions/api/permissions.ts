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
  // reference data
  "schools.manage",
  // learners (a teacher's own roster)
  "learners.manage",
  // content library
  "library.read.learner", // Digital Library shelf
  "library.read.staff",   // Teacher Resources shelf
  "library.read.head",    // For School Head shelf
  "library.manage",       // upload, publish, edit, delete; sees drafts; downloads
  "library.usage.view",
  // forms
  "forms.respond",
  "forms.manage",
  "forms.responses.view",
  // assignments
  "assignments.view.own",
  "assignments.view.all",
  "assignments.manage.learners",
  // field visits
  "field_reports.create",
  "field_reports.view.own",
  "field_reports.view.all",
  // dashboards
  "stats.view",
  "school.overview.view",
  // KoboToolbox
  "kobo.manage",
  "kobo.results.view",
  "kobo.surveys.fill",
  // staff accounts
  "users.view",
  "users.invite",
  "users.approve",        // approve or reject a pending account
  "users.roles.assign",
  "users.status.manage",  // suspend, deactivate, reactivate
  "users.password.reset",
  "users.placement.assign", // county and school
  "users.edit",           // name, email, teacher type
  "audit.view",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const USER_ADMIN: Permission[] = [
  "users.view", "users.invite", "users.approve", "users.roles.assign", "users.status.manage",
  "users.password.reset", "users.placement.assign", "users.edit", "audit.view",
];

const EDUCATION_TEAM: Permission[] = [
  "schools.manage",
  "library.read.learner", "library.read.staff", "library.read.head", "library.manage", "library.usage.view",
  "forms.manage", "forms.responses.view",
  "assignments.view.all",
  "field_reports.view.all",
  "stats.view",
  "kobo.manage", "kobo.results.view",
  "users.view",
];

/* Super Admin and Admin hold the same permissions; what separates them is
   authority over other accounts (rank and grantable roles, below). Neither
   gets the working-role permissions (a teacher's roster, filing a field
   visit, answering forms): administrators manage the portal, they don't
   act as a teacher or field officer inside it. */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  super_admin: [...EDUCATION_TEAM, ...USER_ADMIN],
  admin: [...EDUCATION_TEAM, ...USER_ADMIN],
  education_team: EDUCATION_TEAM,
  me: [
    "library.read.learner", "library.read.staff", "library.read.head", "library.usage.view",
    "forms.responses.view",
    "assignments.view.all",
    "field_reports.view.all",
    "stats.view",
    "kobo.results.view",
  ],
  field_officer: ["forms.respond", "field_reports.create", "field_reports.view.own", "kobo.surveys.fill"],
  school_leader: [
    "forms.respond", "school.overview.view",
    "library.read.learner", "library.read.staff", "library.read.head",
  ],
  teacher: [
    "forms.respond", "learners.manage", "assignments.manage.learners",
    "library.read.learner", "library.read.staff",
  ],
  learner: ["library.read.learner", "assignments.view.own"],
};

export function permissionsFor(role: string | null | undefined): readonly Permission[] {
  return ROLE_PERMISSIONS[role as Role] ?? [];
}

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
