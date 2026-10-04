-- Supabase performance advisor: 42 foreign keys had no covering index.
--
-- Without one, deleting or re-keying the row a foreign key points at (a
-- profile, a school, a county, a term…) scans the whole referencing table,
-- and joins along the key can't use an index. Every table here is still
-- small (the largest, kobo_records, is ~1.4 MB), so these build instantly;
-- they matter as the programme's data grows.
--
-- Additive only: no data changes, no locks beyond the moment each builds.
-- Generated from pg_constraint (foreign keys in public whose columns aren't
-- the leading columns of any index).

create index if not exists assignment_submissions_band_fk_idx on public.assignment_submissions (band);
create index if not exists assignment_submissions_marked_by_fk_idx on public.assignment_submissions (marked_by);
create index if not exists assignments_academic_year_id_fk_idx on public.assignments (academic_year_id);
create index if not exists assignments_created_by_fk_idx on public.assignments (created_by);
create index if not exists assignments_resource_id_fk_idx on public.assignments (resource_id);
create index if not exists assignments_subject_id_fk_idx on public.assignments (subject_id);
create index if not exists class_subjects_added_by_fk_idx on public.class_subjects (added_by);
create index if not exists class_subjects_removed_by_fk_idx on public.class_subjects (removed_by);
create index if not exists class_subjects_subject_id_fk_idx on public.class_subjects (subject_id);
create index if not exists classes_academic_year_id_fk_idx on public.classes (academic_year_id);
create index if not exists dq_issue_events_actor_id_fk_idx on public.dq_issue_events (actor_id);
create index if not exists dq_issues_resolved_by_fk_idx on public.dq_issues (resolved_by);
create index if not exists dq_issues_status_changed_by_fk_idx on public.dq_issues (status_changed_by);
create index if not exists dq_scans_actor_id_fk_idx on public.dq_scans (actor_id);
create index if not exists forms_county_fk_idx on public.forms (county);
create index if not exists kobo_records_duplicate_of_fk_idx on public.kobo_records (duplicate_of);
create index if not exists kobo_records_reviewed_by_fk_idx on public.kobo_records (reviewed_by);
create index if not exists kobo_school_aliases_created_by_fk_idx on public.kobo_school_aliases (created_by);
create index if not exists kobo_school_aliases_school_id_fk_idx on public.kobo_school_aliases (school_id);
create index if not exists learner_enrollments_academic_year_id_fk_idx on public.learner_enrollments (academic_year_id);
create index if not exists learner_enrollments_term_id_fk_idx on public.learner_enrollments (term_id);
create index if not exists learners_academic_year_id_fk_idx on public.learners (academic_year_id);
create index if not exists learners_current_teacher_id_fk_idx on public.learners (current_teacher_id);
create index if not exists learners_term_id_fk_idx on public.learners (term_id);
create index if not exists me_actuals_recorded_by_fk_idx on public.me_actuals (recorded_by);
create index if not exists me_actuals_superseded_by_fk_idx on public.me_actuals (superseded_by);
create index if not exists me_actuals_verified_by_fk_idx on public.me_actuals (verified_by);
create index if not exists me_evidence_added_by_fk_idx on public.me_evidence (added_by);
create index if not exists me_evidence_kobo_form_id_fk_idx on public.me_evidence (kobo_form_id);
create index if not exists me_programmes_created_by_fk_idx on public.me_programmes (created_by);
create index if not exists me_reports_finalized_by_fk_idx on public.me_reports (finalized_by);
create index if not exists me_reports_generated_by_fk_idx on public.me_reports (generated_by);
create index if not exists me_targets_set_by_fk_idx on public.me_targets (set_by);
create index if not exists responses_respondent_id_fk_idx on public.responses (respondent_id);
create index if not exists staff_invitations_county_fk_idx on public.staff_invitations (county);
create index if not exists staff_invitations_school_id_fk_idx on public.staff_invitations (school_id);
create index if not exists staff_scopes_county_fk_idx on public.staff_scopes (county);
create index if not exists staff_scopes_school_id_fk_idx on public.staff_scopes (school_id);
create index if not exists submission_answers_question_id_fk_idx on public.submission_answers (question_id);
create index if not exists training_attendance_recorded_by_fk_idx on public.training_attendance (recorded_by);
create index if not exists trainings_created_by_fk_idx on public.trainings (created_by);
create index if not exists trainings_school_id_fk_idx on public.trainings (school_id);
