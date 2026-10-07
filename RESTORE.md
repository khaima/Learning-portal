# Restoring the database

The nightly backup ([`.github/workflows/backup.yml`](.github/workflows/backup.yml);
[`docs/OPERATIONS.md`](docs/OPERATIONS.md#4-backups) explains it) leaves one
file a night in the project's private `backups` bucket:

```
backups/daily/hpf-db-YYYY-MM-DD.tar.gz      the last 35 days
backups/monthly/hpf-db-YYYY-MM-01.tar.gz    the 1st of every month, kept
  roles.sql       database roles
  schema.sql      tables, functions, triggers, policies, grants
  data.sql        every row — the portal's tables, auth users, storage metadata
  manifest.json   when, from which project, and each table's row count
```

Before a backup is kept, the job restores it into a fresh local Supabase
(Postgres 17, with Auth and Storage) and checks every table's row count
against the dump. That is the same restore as below; each night's run summary
shows the table.

## 1. Get a backup

From the dashboard: **Storage → backups → daily →** the day you want **→ Download**.

Or with the CLI (signed in with `npx supabase login`):

```bash
npx supabase@2.114.0 storage cp --experimental --project-ref fwpqytrdlmxymvegvgji ss:///backups/daily/hpf-db-2026-10-08.tar.gz .
```
```bash
tar -xzf hpf-db-2026-10-08.tar.gz
```

The run's log lists each backup's SHA-256 (`sha256sum hpf-db-….tar.gz` to compare).

**An encrypted off-site copy**, if `BACKUP_AGE_RECIPIENT` is set: Actions →
the night's *Nightly database backup* run → artifact `hpf-db-encrypted`.
Decrypt it with the private key kept offline:

```bash
age -d -i backup-key.txt -o hpf-db.tar.gz hpf-db-2026-10-08.tar.gz.age
```

## 2. Choose how to restore

| What happened | Do this |
|---|---|
| The project is gone or unusable | **A.** Restore everything into a new project, and point the portal at it |
| Some data was changed or removed by mistake; the project is fine | **B.** Restore into a scratch database, and copy back only what's needed |
| Point-in-time recovery is on (paid plan) | **C.** Rewind the project in the dashboard |

Overwriting the live database with a backup undoes everything since the
backup, other people's work included. Don't do it to fix one mistake: use B.

### A. Everything, into a new project

1. Create a project in the organisation: region **eu-north-1** (as
   production), Postgres 17.
2. Copy its connection string: **Connect → Session pooler** (port 5432).
3. Restore it, with `psql` 17. If `psql` isn't installed, use the Postgres
   17 image: `docker run --rm -it -v "$PWD:/b" -w /b postgres:17 psql …`.
   ```bash
   psql --single-transaction --variable ON_ERROR_STOP=1 \
     --file roles.sql --file schema.sql \
     --command 'SET session_replication_role = replica' \
     --file data.sql \
     --dbname "postgresql://postgres.<new ref>:<password>@aws-0-eu-north-1.pooler.supabase.com:5432/postgres"
   ```
   `session_replication_role = replica` lets rows go in without firing
   triggers, so the append-only logs accept their history.
4. Check it: compare row counts with `manifest.json`.
   ```sql
   select count(*) from public.learners;  -- …and the other tables in the manifest
   ```
5. Put back what a database dump doesn't hold:
   - **The hourly notifications job and its secret**, both specific to a
     project. Run the *Notifications* section of
     [`supabase-schema.sql`](supabase-schema.sql), with `fwpqytrdlmxymvegvgji`
     replaced by the new ref in the job's URL. That section creates the Vault
     secret if it's missing.
   - **The API:**
     ```bash
     node scripts/deploy-api.mjs --project-ref=<new ref>
     ```
     Then its secrets: `SENTRY_DSN`, and the mail settings
     (`scripts/configure-auth.mjs` sets those, and the Auth settings below).
   - **Auth settings** (mail sender, sign-ups off, redirect URLs):
     ```bash
     SUPABASE_PROJECT_REF=<new ref> node --env-file=.env scripts/configure-auth.mjs --apply
     ```
   - **The Kobo connection:** its token is in `kobo_config`, so it came back
     with the data. Kobo's live push needs the new address: in Kobo, change
     the REST Service URL to `https://<new ref>.supabase.co/functions/v1/api/kobo/hook`.
   - **Files** (library uploads, attachments): see [Files](#files) below.
6. Point the portal at the new project. The old ref
   (`fwpqytrdlmxymvegvgji`) is in:
   - `environments.json` (production);
   - the CSP in `vercel.json`;
   - `scripts/deploy-api.mjs` and `scripts/bootstrap-staging.mjs`;
   - `.github/workflows/uptime.yml`, `backup.yml` and `release.yml`;
   - `telemetry.ts` (`environment()`).

   `grep -rl fwpqytrdlmxymvegvgji` finds them all. Release that change
   through staging, as any other.
7. People sign in as before: staff passwords and learners' PINs are in the
   restored data. Sessions open at the time of the backup still work until
   they expire.

### B. Some rows, from a backup, into the live project

1. Restore the backup somewhere that isn't production. Either:
   - **locally:** `npx supabase@2.114.0 start` in an empty folder (needs
     Docker), then step A3 with
     `--dbname postgresql://postgres:postgres@127.0.0.1:54322/postgres`;
   - **or into a new project** (step A1–A3), deleted afterwards.
2. Find the rows you need there, and export them:
   ```sql
   \copy (select * from public.learners where id in ('…')) to 'learners.csv' csv header
   ```
3. Bring them back in one transaction on production, and record why. Every
   correction is auditable:
   ```sql
   begin;
   \copy public.learners from 'learners.csv' csv header   -- or an insert … on conflict do update, for changed rows
   insert into public.audit_log (actor_kind, action, target_type, target_id, details)
     values ('system', 'data.restored', 'learner', '…', jsonb_build_object('backup', 'hpf-db-2026-10-08', 'reason', '…'));
   commit;
   ```
   On production, run SQL through the dashboard's SQL editor, or with
   `npx supabase@2.114.0 db query --linked -f file.sql`.

### C. Point-in-time recovery

Only with a paid plan and the PITR add-on. **Database → Backups → Point in
time:** choose the moment, then **Restore**. The whole project goes back to
that moment, and is unavailable while it does. Everything after that moment
is lost, so export anything needed first (as in B).

## Files

Uploads are kept by Supabase Storage (the `library` bucket), not in the
database. The dump has their *records* (`storage.objects`), not their
contents. They survive anything short of losing the project. To keep a copy
of them too:

```bash
npx supabase@2.114.0 storage cp --experimental -r --project-ref fwpqytrdlmxymvegvgji ss:///library ./library-copy
```

Into a new project, copy them back with the same command the other way:
`./library-copy` → `ss:///library` on the new ref.

## Restore tests

The restore in A3 runs **every night** inside the backup job. It restores the
roles, schema and data into a fresh Supabase, then checks every table's row
count. If a night's dump doesn't restore exactly, that run fails and the
backup isn't kept. The run's summary has the table.

| Date | Backup | Restored into | Result |
|---|---|---|---|
| — | — | — | **Not run yet.** The job needs the `SUPABASE_ACCESS_TOKEN` repository secret. The first night after it's added is the first test; add it here. |
