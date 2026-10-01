-- Programme Intelligence dashboard: data-quality counts from each Kobo sync.
--   rejected_count     — submissions marked "not approved" in KoboToolbox
--                        (left out of the portal's results)
--   unattributed_count — submissions with no valid field-officer reference
-- Additive only. Safe to re-run.
alter table public.kobo_forms add column if not exists rejected_count int not null default 0;
alter table public.kobo_forms add column if not exists unattributed_count int not null default 0;
