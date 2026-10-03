/**
 * Reports for export — the catalogue: what each report is, and the
 * permissions that let someone export it (any one of them). The rows a
 * person gets are then limited to what those permissions let them see
 * (index.ts builds each report with the same scope rules as the screens:
 * a school head's exports are their school, a teacher's their classes, a
 * field officer's their own visits).
 *
 * A report is sections of rows with typed columns; the browser turns it
 * into Excel, CSV or PDF (export.js).
 */

export type ColumnType = "text" | "number" | "percent" | "date" | "datetime";
export type Column = { key: string; label: string; type?: ColumnType };
export type Section = { title: string; columns: Column[]; rows: Record<string, unknown>[] };

/** The filters a report understands (the rest are ignored). */
export type ReportFilter = "place" | "dates" | "period" | "programme" | "status";

export type ReportDef = {
  id: string;
  title: string;
  description: string;
  /** Any one of these lets someone export it. */
  needs: string[];
  filters: ReportFilter[];
};

export const REPORTS: ReportDef[] = [
  { id: "learner-register", title: "Learner Register", needs: ["learners.view.all", "learners.view.school", "learners.manage"], filters: ["place", "status"],
    description: "Every learner with their code, grade, class, school, county, gender (where recorded) and enrollment status." },
  { id: "teacher-register", title: "Teacher Register", needs: ["users.view", "trainings.manage", "school.overview.view"], filters: ["place", "status"],
    description: "Teachers and school heads: staff code, school, county, employment type, classes taught and training attended." },
  { id: "school-register", title: "School Register", needs: ["stats.view", "schools.manage", "school.overview.view"], filters: ["place", "dates"],
    description: "Every school with its code and county, learners, teachers, classes, field visits and Kobo submissions." },
  { id: "assignment-report", title: "Assignment Report", needs: ["assignments.view.all", "assignments.view.school", "assignments.manage"], filters: ["place", "period", "dates"],
    description: "Each assignment set: class, subject, due date, how many handed it in (completion) and the average mark (achievement) — never combined." },
  { id: "assessment-report", title: "Assessment Report", needs: ["assignments.view.all", "assignments.view.school", "assignments.manage"], filters: ["place", "period", "dates"],
    description: "Results by subject and class, and every piece of marked work with its marks, band and marker." },
  { id: "field-visit-report", title: "Field Visit Report", needs: ["field_reports.view.all", "field_reports.view.own"], filters: ["place", "dates"],
    description: "Field visits by date, officer, school and type, with the visit forms filled and any still missing." },
  { id: "kobo-report", title: "Kobo Report", needs: ["kobo.results.view", "kobo.manage"], filters: ["place", "dates"],
    description: "Each Kobo survey's status, and every submission with its school, officer, validation status and issues." },
  { id: "library-usage", title: "Library Usage", needs: ["library.usage.view"], filters: ["place", "dates"],
    description: "How each resource is used — opens, readers, time — and use by school." },
  { id: "me-indicator-report", title: "M&E Indicator Report", needs: ["me.view"], filters: ["place", "period", "programme"],
    description: "Every indicator's baseline, target, actual, achievement and evidence for a period and place." },
  { id: "term-report", title: "Term Report", needs: ["intelligence.view", "school.overview.view"], filters: ["place", "period"],
    description: "A term at a glance: reach, completion, results, field visits, digital resources and training — overall and by school." },
  { id: "county-report", title: "County Report", needs: ["intelligence.view"], filters: ["place", "dates", "period"],
    description: "County by county: schools, learners, teachers, visits, completion, results, library use and training." },
];

/** The reports this person may export, given a permission check. */
export const reportsFor = (can: (p: string) => boolean) => REPORTS.filter((r) => r.needs.some(can));

export const GENDER_TEXT: Record<string, string> = { female: "Female", male: "Male", prefer_not_to_say: "Prefer not to say" };

/** Enrollment and account states in words. */
export const STATUS_TEXT: Record<string, string> = {
  ACTIVE: "Enrolled", TRANSFERRED: "Transferred", DROPPED_OUT: "Dropped out", COMPLETED: "Completed", INACTIVE: "Inactive",
  active: "Active", pending: "Awaiting approval", suspended: "Suspended", deactivated: "Deactivated", rejected: "Rejected",
};

/** Rows of a section, counted across a report. */
export const rowCount = (sections: Section[]) => sections.reduce((t, s) => t + s.rows.length, 0);
