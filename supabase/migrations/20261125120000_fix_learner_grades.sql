-- Two learners at Olesere (NRK-012) were saved with grades the portal
-- doesn't have: the API used to accept any text as a learner's grade when
-- there was no class. It now accepts only the portal's grades. Corrected
-- with the owner's OK (25 Nov 2026):
--   ken  "5"         -> "Grade 5"
--   john "Grade 4 E" -> "Grade 4" (the stream letter; the portal has no stream field)
-- Only these exact values are touched, so running it again changes nothing.

update public.learners set grade = 'Grade 5' where username = 'ken' and grade = '5';
update public.learners set grade = 'Grade 4' where username = 'john' and grade = 'Grade 4 E';

update public.learner_enrollments set grade = 'Grade 5'
  where grade = '5' and learner_id = (select id from public.learners where username = 'ken');
update public.learner_enrollments set grade = 'Grade 4'
  where grade = 'Grade 4 E' and learner_id = (select id from public.learners where username = 'john');
