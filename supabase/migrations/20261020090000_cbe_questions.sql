-- Competency-based question formats (CBE): matching, ordering, fill in the
-- blanks, a number, and a task marked against a rubric. Each question gets
-- `meta` — its CBE details (strand, sub-strand, learning outcome, core
-- competencies, level), its settings (shuffle, part marks, feedback for each
-- option, the rubric) and the explanation learners read once it's marked —
-- and each answer room for the rubric levels a teacher chose. Additive only:
-- every existing question and answer keeps working as it is.
alter table public.assignment_questions drop constraint if exists assignment_questions_type_check;
alter table public.assignment_questions add constraint assignment_questions_type_check check (type in (
  'multiple_choice', 'multiple_response', 'short_answer', 'true_false', 'file_upload', 'teacher_marked',
  'matching', 'ordering', 'fill_blanks', 'numeric', 'rubric'));
alter table public.assignment_questions add column if not exists meta jsonb not null default '{}'::jsonb;
alter table public.submission_answers add column if not exists rubric jsonb;
comment on column public.assignment_questions.meta is 'CBE details and settings: strand, subStrand, outcome, competencies, level, explanation, optionFeedback, shuffle, partial, unit, rubric';
comment on column public.submission_answers.rubric is 'Rubric tasks: the level chosen for each criterion (4 EE, 3 ME, 2 AE, 1 BE)';
