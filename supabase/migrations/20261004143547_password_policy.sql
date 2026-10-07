-- Production sign-in: temporary passwords that must be changed.
--
-- An administrator no longer picks someone's password. They either send a
-- reset link (the person chooses their own), or generate a one-time
-- temporary password for someone who can't receive email. A temporary
-- password sets must_change_password: until the person chooses their own
-- (POST /me/password), the API refuses everything else, and sign-in sends
-- them straight to "choose your own password". Every step is in the audit
-- log (password.reset_link_sent, password.temporary_set, password.changed).
--
--   must_change_password     the next thing this person does is choose a password
--   temporary_password_at    when the temporary password was made — only a
--                            session signed in after it may replace it
--   temporary_password_hash  scrypt "salt:hash" of the temporary password, so
--                            it can't be kept as the "new" one; cleared once
--                            changed. Never the password itself, never sent out.
--   password_changed_at      when the person last chose their own password here
--
-- Additive only; nothing existing changes. profiles stays deny-all (RLS on,
-- no policies): only the api Edge Function reads these.

alter table public.profiles add column if not exists must_change_password boolean not null default false;
alter table public.profiles add column if not exists temporary_password_at timestamptz;
alter table public.profiles add column if not exists temporary_password_hash text;
alter table public.profiles add column if not exists password_changed_at timestamptz;
