/**
 * The change history (docs/RBAC.md §15): every add, edit and delete of the
 * portal's records — who made it, when, before and after.
 *
 * The database writes it: a trigger on each watched table
 * (supabase/migrations/20261029090000_change_history.sql, capture_change()),
 * so nothing is missed. This file is what the API needs to read it: what
 * each watched table is called, who may see it, and whether a deleted one
 * can be put back or an edit undone. KINDS is kept in step with the
 * migration's list of tables (history_test.ts checks it).
 *
 *   Super Admin (changes.view.all)  every change, and puts back anything that can be
 *   given changes.view by the       learning and education records in their area, and
 *   Super Admin (a grant)           with changes.restore, puts back what they manage
 */
import type { Permission } from "./permissions.ts";

export type Kind = {
  label: string;
  plural: string;
  /** programme: learning and education; system: the Super Admin's; me: the M&E framework. */
  area: "programme" | "system" | "me";
  /** The record's key column(s). */
  key: string[];
  /** A deleted one can be put back from the history. */
  restore?: boolean;
  /** An edit can be undone from the history. */
  undo?: boolean;
  /** Besides the Super Admin, who may put one back: whoever manages it. */
  manage?: Permission;
  /** Why it isn't put back from here (shown instead of the button). */
  why?: string;
  /** Columns whose change alone isn't recorded (as in the migration). */
  noise?: string[];
  /** Only edits and deletes are recorded, not each new one (as in the migration). */
  editsOnly?: boolean;
};

const ACCOUNTS = "Accounts are changed on Users & roles, where the account rules apply.";
const FRAMEWORK = "Changed in the results framework, where results are checked and verified.";

export const KINDS: Record<string, Kind> = {
  // Learning and education
  counties: { label: "County", plural: "Counties", area: "programme", key: ["name"], restore: true, manage: "schools.manage",
    why: "A county's name is changed on Counties & schools." },
  schools: { label: "School", plural: "Schools", area: "programme", key: ["id"], restore: true, undo: true, manage: "schools.manage" },
  academic_years: { label: "School year", plural: "School years", area: "programme", key: ["id"], restore: true, manage: "calendar.manage",
    why: "Which year is current is set on Calendar." },
  terms: { label: "Term", plural: "Terms", area: "programme", key: ["id"], restore: true, undo: true, manage: "calendar.manage" },
  subjects: { label: "Subject", plural: "Subjects", area: "programme", key: ["id"], restore: true, undo: true, manage: "subjects.manage" },
  classes: { label: "Class", plural: "Classes", area: "programme", key: ["id"], restore: true, undo: true, manage: "classes.manage.all" },
  class_teachers: { label: "Class teacher", plural: "Class teachers", area: "programme", key: ["id"], restore: true, undo: true, manage: "classes.manage.all" },
  class_subjects: { label: "Class subject", plural: "Class subjects", area: "programme", key: ["id"], restore: true, undo: true, manage: "classes.manage.all" },
  learners: { label: "Learner", plural: "Learners", area: "programme", key: ["id"], noise: ["updated_at", "failed_attempts", "locked_until"],
    why: "Learners are archived, never deleted, and changed on Learners, where their enrolment is kept right." },
  learner_enrollments: { label: "Enrolment", plural: "Enrolments", area: "programme", key: ["id"],
    why: "An enrolment follows the learner: change it on Learners." },
  assignments: { label: "Assignment", plural: "Assignments", area: "programme", key: ["id"], restore: true, manage: "assignments.manage", noise: ["updated_at"],
    why: "An assignment is opened and closed by its teacher." },
  assignment_questions: { label: "Assignment question", plural: "Assignment questions", area: "programme", key: ["id"], restore: true, manage: "assignments.manage",
    why: "Questions are changed by the assignment's teacher." },
  assignment_submissions: { label: "Learner's work", plural: "Learners' work", area: "programme", key: ["id"], noise: ["last_saved_at", "started_at"], editsOnly: true,
    why: "A learner's work is marked by their teacher." },
  attendance_registers: { label: "Attendance register", plural: "Attendance registers", area: "programme", key: ["id"], noise: ["client_saved_at", "updated_at"],
    why: "Attendance is corrected on the class register." },
  attendance_marks: { label: "Attendance mark", plural: "Attendance marks", area: "programme", key: ["register_id", "learner_id"], noise: ["updated_at"], editsOnly: true,
    why: "Attendance is corrected on the class register." },
  library_folders: { label: "Library folder", plural: "Library folders", area: "programme", key: ["id"], restore: true, undo: true, manage: "library.manage" },
  library_items: { label: "Library item", plural: "Library items", area: "programme", key: ["id"], restore: true, undo: true, manage: "library.manage",
    noise: ["embed_checked_at", "embeddable"] },
  forms: { label: "Form", plural: "Forms", area: "programme", key: ["id"], restore: true, undo: true, manage: "forms.manage" },
  responses: { label: "Form response", plural: "Form responses", area: "programme", key: ["id"], restore: true, manage: "forms.manage",
    why: "A response is the respondent's own." },
  field_reports: { label: "Field visit", plural: "Field visits", area: "programme", key: ["id"], restore: true,
    why: "A visit is the field officer's own." },
  trainings: { label: "Training session", plural: "Training sessions", area: "programme", key: ["id"], restore: true, undo: true, manage: "trainings.manage" },
  training_attendance: { label: "Training attendance", plural: "Training attendance", area: "programme", key: ["training_id", "teacher_id"], restore: true, undo: true,
    manage: "trainings.manage", noise: ["recorded_at"] },
  // The system: the Super Admin's
  profiles: { label: "Staff account", plural: "Staff accounts", area: "system", key: ["id"], why: ACCOUNTS },
  staff_scopes: { label: "Where someone works", plural: "Where people work", area: "system", key: ["id"],
    why: "Changed on the person's Access panel, or on Field officers." },
  permission_grants: { label: "Extra permission", plural: "Extra permissions", area: "system", key: ["id"], why: "Granted and taken back on Permissions." },
  staff_invitations: { label: "Invitation", plural: "Invitations", area: "system", key: ["id"], why: "Invite again, or renew the invitation, on Users & roles." },
  kobo_config: { label: "Kobo connection", plural: "Kobo connection", area: "system", key: ["id"], noise: ["updated_at"], why: "Set on KoboToolbox." },
  kobo_forms: { label: "Kobo survey", plural: "Kobo surveys", area: "system", key: ["id"],
    noise: ["synced_at", "submission_count", "rejected_count", "unattributed_count", "schema", "schema_version", "schema_synced_at", "processed_at", "last_sync_attempt_at", "last_sync_error"],
    why: "Surveys are archived and brought back on KoboToolbox." },
  kobo_school_aliases: { label: "Kobo school match", plural: "Kobo school matches", area: "system", key: ["value_key"],
    why: "Matches are saved on Kobo review, which checks the submissions again." },
  // The M&E results framework
  me_programmes: { label: "M&E programme", plural: "M&E programmes", area: "me", key: ["id"], noise: ["updated_at"], why: FRAMEWORK },
  me_outcomes: { label: "M&E outcome", plural: "M&E outcomes", area: "me", key: ["id"], why: FRAMEWORK },
  me_indicators: { label: "Indicator", plural: "Indicators", area: "me", key: ["id"], noise: ["updated_at"], why: FRAMEWORK },
  me_targets: { label: "Indicator target", plural: "Indicator targets", area: "me", key: ["id"], why: FRAMEWORK },
  me_actuals: { label: "Indicator result", plural: "Indicator results", area: "me", key: ["id"], why: FRAMEWORK },
  me_evidence: { label: "Evidence", plural: "Evidence", area: "me", key: ["id"], why: FRAMEWORK },
  me_reports: { label: "M&E report", plural: "M&E reports", area: "me", key: ["id"], why: FRAMEWORK },
};

/** Columns never copied into the history (as in the migration): PINs, hashes, salts, tokens, secrets. */
export const SECRET = /(^pin_|_hash$|_salt$|token|secret)/;
export const isSecret = (field: string) => SECRET.test(field);

/** The tables this person's history covers. */
export function tablesFor(perms: ReadonlySet<string>): string[] {
  if (perms.has("changes.view.all")) return Object.keys(KINDS);
  if (perms.has("changes.view")) return Object.entries(KINDS).filter(([, k]) => k.area === "programme").map(([t]) => t);
  return [];
}

/** May this person put back (restore or undo) this kind of record? */
export function mayPutBack(perms: ReadonlySet<string>, kind: Kind): boolean {
  if (!perms.has("changes.restore")) return false;
  if (perms.has("changes.view.all")) return true;
  return kind.area === "programme" && !!kind.manage && perms.has(kind.manage);
}

/* ---- words for what changed ---- */

const FIELD_LABEL: Record<string, string> = {
  school_id: "School", class_id: "Class", subject_id: "Subject", folder_id: "Folder", academic_year_id: "School year", term_id: "Term",
  learner_id: "Learner", teacher_id: "Teacher", current_teacher_id: "Current teacher", profile_id: "Person", officer_id: "Field officer",
  training_id: "Training", assignment_id: "Assignment", register_id: "Register", form_id: "Form", visit_id: "Visit", resource_id: "Library item",
  respondent_id: "Respondent", full_name: "Name", school: "School name (as written)", term_no: "Term", is_current: "Current year", pin_hash: "PIN", pin_salt: "PIN",
  temporary_password_hash: "Temporary password", token_hash: "Invitation link", api_token: "Kobo API token", webhook_secret_hash: "Kobo push secret",
  webhook_secret_set_at: "Kobo push secret set", value_key: "Value", external_url: "Link", file_name: "File", files: "Files",
  enrollment_status: "Enrolment", exit_reason: "Reason for leaving", user_code: "User code", learner_code: "Learner code",
  must_change_password: "Must change password", status_reason: "Reason", due_on: "Due", due_at: "Due", held_on: "Held on",
  ends_on: "Ends on", starts_on: "Starts on", starts_at: "Opens", archived_at: "Archived", ended_at: "Ended", revoked_at: "Revoked",
  removed_at: "Removed", closed_at: "Closed", published_at: "Published", marked_at: "Marked", taken_on: "Day",
};
export function fieldLabel(field: string): string {
  if (FIELD_LABEL[field]) return FIELD_LABEL[field];
  const words = field.replace(/_id$/, "").replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Columns that point at another record, and where its name is. */
export const REFS: Record<string, { table: string; name: string }> = {
  school_id: { table: "schools", name: "name" },
  class_id: { table: "classes", name: "name" },
  subject_id: { table: "subjects", name: "name" },
  folder_id: { table: "library_folders", name: "name" },
  academic_year_id: { table: "academic_years", name: "label" },
  term_id: { table: "terms", name: "term_no" },
  learner_id: { table: "learners", name: "full_name" },
  training_id: { table: "trainings", name: "title" },
  assignment_id: { table: "assignments", name: "title" },
  form_id: { table: "forms", name: "title" },
  resource_id: { table: "library_items", name: "title" },
  register_id: { table: "attendance_registers", name: "taken_on" },
  visit_id: { table: "field_reports", name: "school" },
};
/** Columns that hold a staff member's id. */
export const isPersonField = (field: string) =>
  /_by$/.test(field) || ["teacher_id", "current_teacher_id", "profile_id", "officer_id", "respondent_id"].includes(field);

/** A record's own name, when it has one. */
export function ownName(table: string, row: Record<string, unknown> | null): string | null {
  if (!row) return null;
  if (table === "terms" && row.term_no != null) return `Term ${row.term_no}`;
  if (table === "attendance_registers" && row.taken_on) return `Register of ${row.taken_on}`;
  if (table === "permission_grants" && row.permission) return String(row.permission);
  const v = row.name ?? row.title ?? row.full_name ?? row.label ?? row.email ?? row.value ?? row.code;
  return v == null || v === "" ? null : String(v);
}

/** One value, in words. `names` holds what ids stand for. */
export function showValue(field: string, value: unknown, names: Record<string, string>): string {
  if (value == null || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) {
    if (!value.length) return "none";
    if (value.every((v) => typeof v !== "object")) {
      const s = value.join(", ");
      return s.length <= 120 ? s : `${value.length} items`;
    }
    return `${value.length} ${value.length === 1 ? "item" : "items"}`;
  }
  if (typeof value === "object") {
    const s = JSON.stringify(value);
    return s.length <= 120 ? s : `${Object.keys(value as object).length} entries`;
  }
  const s = String(value);
  if (field === "term_id" && names[s]) return `Term ${names[s]}`;
  if ((REFS[field] || isPersonField(field)) && names[s]) return names[s];
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

/** What it was: added, edited, deleted — or put back from the history. */
export function actionOf(r: { op: string; route?: string | null }): "added" | "edited" | "deleted" | "restored" | "undone" {
  if (r.route && /^POST \/api\/changes\/\d+\/restore\b/.test(r.route)) return "restored";
  if (r.route && /^POST \/api\/changes\/\d+\/undo\b/.test(r.route)) return "undone";
  return r.op === "insert" ? "added" : r.op === "delete" ? "deleted" : "edited";
}
