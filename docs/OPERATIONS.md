# Running the portal in production

How the portal is watched, backed up and released. Five parts:

1. [Error reporting](#1-error-reporting) — Sentry or GlitchTip, for the browser and the API
2. [Sync problems](#2-sync-problems) — failures and conflicts from devices, and the **Stuck devices** page
3. [Uptime](#3-uptime) — a check on the API's health every 10 minutes
4. [Backups](#4-backups) — a nightly dump, restore-checked; [`RESTORE.md`](../RESTORE.md) brings one back
5. [Staging and releases](#5-staging-and-releases) — nothing reaches production before the tests pass

[What needs setting, and by whom](#what-needs-setting-and-by-whom) is at the end.

---

## 1. Error reporting

Both sides of the portal report errors through the API
([`telemetry.ts`](../supabase/functions/api/telemetry.ts)):

- **The API** reports every reply of 500 or more and every exception, from a
  middleware that wraps every route.
- **The browser** reports errors no page caught
  ([`telemetry.js`](../telemetry.js), loaded on every page). It posts them to
  `POST /api/telemetry/error`, and the API passes them on.

The browser never needs the DSN, no tracker library is downloaded (the
schools' connections are slow), and the CSP stays as it is: everything goes
to the portal's own API.

**What is sent.** The error's type, message and stack (file names without
query strings), the API route with ids replaced (`GET /api/learners/:id`) or
the page (`teacher.html`), the release and the environment, and these tags:

| tag | value |
|---|---|
| `role` | the caller's role as the database has it (`teacher`, `learner`…), or `signed-out` |
| `school` | the school's code (`NRK-001`), or `none` |
| `account` | `staff`, `learner` or `none` |
| `side` | `api` or `browser` |
| `method`, `status` | API errors |
| `page`, `source`, `online` | browser errors |

The person is only a one-way hash of their id, enough to count how many people
an error hit. The role and school are always worked out on the server from the
session; a report that claims a role is ignored.

**What is never sent.** Names, emails, phone numbers, PINs, passwords, tokens,
request bodies, query strings. Messages are scrubbed on the way out
(`scrub()`, tested in
[`observability_test.ts`](../supabase/functions/api/observability_test.ts)):
emails become `[email]`, any number of 4 digits or more becomes `[number]`,
and session tokens become `[token]`.

**What isn't an error.** The API's refusals (401/403/404/409) are expected,
so they aren't reported, and nor are dropped connections. Each API instance
sends the same error at most once a minute, and at most 60 a minute in all.
Each page sends at most 5.

**Release.** API errors carry the git commit it was deployed from: the
deploy script writes it into
[`release.ts`](../supabase/functions/api/release.ts). Browser errors carry
the build's version (`version.json`, the same version as the service
worker's).

### Turning it on

Reporting is off until the function has a DSN:

1. Make a project:
   - **Sentry** (sentry.io, free tier): *Create project → Browser
     JavaScript*.
   - **GlitchTip** (glitchtip.com, or self-hosted): *New project*.

   Copy its **DSN**.
2. In Sentry, also tick *Settings → Security & Privacy → Prevent storing of
   IP addresses* and keep the default data scrubbers on, as a second layer.
3. Give the DSN to the function. It's read on each cold start, so there's no
   redeploy:
   ```bash
   npx supabase@2.114.0 secrets set SENTRY_DSN=https://…@….ingest.sentry.io/… --project-ref fwpqytrdlmxymvegvgji
   ```
   For staging, set the same DSN on the staging project. Its events are tagged
   `environment: staging`.
4. Set up alerts in the tracker, e.g. email on a new issue, or on more than
   20 events an hour.

Until a DSN is set, browser errors still reach the API and are written to the
function's log (Supabase dashboard → Edge Functions → api → Logs) as
`browser error: …`.

---

## 2. Sync problems

Work done offline waits on the device until it syncs ([`sync.js`](../sync.js)).
Two things now come back to the server:

- **Every device's queue.** After each sync, each device reports its counts
  and times: what's waiting, refused or in conflict, and the age of the oldest
  unsent item (`POST /sync/report`). This now includes learners' devices,
  often shared tablets: one row per learner and device, in
  `learner_device_sync_status`.
- **What went wrong** (`POST /sync/events` → `sync_events`):
  - a refusal (`failed`);
  - a conflict (`conflict`);
  - what the person chose next (`kept_mine`, `retried`, `discarded`).

  Events are noted on the device and sent in batches after the next sync that
  reaches the server. Each has its own id, so a batch sent twice is stored
  once. The table is append-only: a database trigger refuses edits and
  deletes, even from the service role. Who and where come from the session.
  The device only says what happened: the kind of activity, the route with
  ids replaced, the status and the server's own message.

**The Stuck devices page** (`GET /sync/problems`). It's in the Education
Team's *Field support* menu, the Admin's *Programme operations* menu, and
Super Admin's *Integrations* menu. It needs the `sync.problems.view`
permission.

- **Stuck devices:** devices that have had something unsent for 48 hours or
  more (1 day, 3 days or a week on request), oldest first, with the latest
  reason.
  - It goes by each device's last report, so a device that has gone quiet
    stays on the list. That's usually the one to chase.
- **The last 7 days' events:** a count of each kind and the list.
- **Scope:** only within the viewer's own scope.

A device that has never synced since this release hasn't reported its
oldest item yet. Older copies of the app report only their oldest *waiting*
item, which the page uses until they update.

---

## 3. Uptime

[`.github/workflows/uptime.yml`](../.github/workflows/uptime.yml) runs every 10
minutes and checks:

- `https://fwpqytrdlmxymvegvgji.supabase.co/functions/v1/api/health`: 200 only
  when the function runs **and** the database answers. It returns 503 if the
  database doesn't, with `{ ok, database, ms, release, environment }` and no
  data;
- the site on Vercel and on GitHub Pages.

Each address gets three tries, 15 seconds apart. If one is down:
- an issue labelled **uptime** is opened, and GitHub emails whoever watches
  the repository;
- it's updated at most hourly while the outage lasts;
- the next good check closes it.

**Its limits.** GitHub's scheduled runs can start several minutes late when
GitHub is busy. On a public repository, GitHub also pauses scheduled
workflows after 60 days without a commit; the Actions tab then offers to
re-enable them. For alerts that don't depend on GitHub, add an outside
monitor on the same health URL. A free one is enough, e.g. UptimeRobot,
Better Stack, or Sentry's own uptime monitor once Sentry is set up. That
needs an account of yours.

---

## 4. Backups

**Where things stand.** The project is on the Free plan, which has **no
backups of its own** (`supabase backups list` shows none) and no
point-in-time recovery. The nightly dump below is the only backup, and it
starts once the `SUPABASE_ACCESS_TOKEN` secret is set.

**Nightly dump** ([`.github/workflows/backup.yml`](../.github/workflows/backup.yml)),
at 02:15 Kenya time:
1. The Supabase CLI dumps the roles, the schema and all data.
2. The dump is **restored into a fresh local Supabase** (Postgres 17, with Auth
   and Storage), and every table's row count is compared with the dump. A
   backup that doesn't restore exactly fails the run, and isn't kept.
3. It's stored in the project's private `backups` bucket: `daily/` is kept 35
   days, and the copy from the 1st of each month is kept in `monthly/`.
   `manifest.json` inside lists every table's rows.
4. Optionally, an encrypted copy is also kept outside Supabase, as a 30-day
   GitHub artifact. Set the repository variable `BACKUP_AGE_RECIPIENT` to an
   [age](https://age-encryption.org) public key whose private key is kept
   offline. The repository is public, so the copy is never stored
   unencrypted there.

The dump has every table, auth users (with their password hashes) included.
It doesn't have the *files* in Storage (library uploads, attachments), the
function's secrets or the Auth settings. [`RESTORE.md`](../RESTORE.md) covers
each.

**Point-in-time recovery** needs a paid plan: Pro, plus the PITR add-on on
Small compute or larger. It's billed. If you upgrade, it's switched on under
*Database → Backups*, and Pro adds daily backups (7 days) on its own. The
nightly dump stays useful even then: it's restore-checked, and it can live
outside Supabase.

---

## 5. Staging and releases

```
push to staging ─► tests (API suite, lint, build, CSP, size budget)
                ─► staging: migrations, API, Vercel preview of the branch
                ─► production: migrations, API, then main moves to the commit
                       └─► Vercel publishes main · GitHub Pages deploy starts
```

[`.github/workflows/release.yml`](../.github/workflows/release.yml) does all of
it:
- **Gated:** production comes only after the tests pass, and after staging
  has taken the same change when staging exists.
- **`main` only moves forward to a tested commit.** If `main` ever has a
  commit `staging` lacks, the release stops: merge `main` into `staging` and
  push again.
- **Approval step (optional):** *Settings → Environments → release →
  Required reviewers*.

**Day to day:**
- Work happens on `staging`: `git push origin <branch>:staging`, then watch
  the run under Actions.
- Don't push to `main`. To make that a rule, add a branch ruleset on `main`
  that allows only GitHub Actions to push.
- Database changes are a new file in `supabase/migrations/`; the release
  applies it with `supabase db push`.

**Until the `SUPABASE_ACCESS_TOKEN` secret is set**, the release promotes the
site only, and warns that the API and migrations weren't deployed. Deploy
those by hand, before pushing:
```bash
node scripts/deploy-api.mjs
```
```bash
npx supabase@2.114.0 db push --linked
```

**Migration history.** Production's history now matches
`supabase/migrations/` exactly (`supabase migration list --linked`). The
files carry the versions production recorded. The 13 migrations from before
the folder existed are placeholder files; their SQL is in production's
history and in `supabase-schema.sql`.

### Staging

**Vercel side (no setup).** Vercel builds a preview of every branch, and
`staging` gets a fixed address: `learning-portal-git-staging-<team>.vercel.app`.
A preview build talks to the project named `staging` in
[`environments.json`](../environments.json) (`vite.config.js` decides). Until
that's filled in, previews use production, as they always have. A staging
build shows **Staging — test data** at the top of every page.

**Supabase side (one-time setup).** A staging project is a second Supabase
project. **The Free plan allows two active projects, and both are in use**
(this one and "khaima's Project"). A staging project needs one of these:
- the organisation on **Pro** (billed; also gives daily backups);
- one of the two projects paused;
- the staging project in another Supabase account's free allowance.

Once it exists:
1. Bootstrap it:
   ```bash
   node scripts/bootstrap-staging.mjs <staging ref> --site=https://learning-portal-git-staging-<team>.vercel.app/
   ```
   It copies production's **structure, never its data**:
   - `supabase-schema.sql`, with only reference lists (counties, terms,
     subjects, grade bands);
   - the migration history;
   - the API, with `HPF_ENVIRONMENT=staging` and staging's own `PORTAL_URLS`.

   It also fills in `environments.json` and adds the project to the CSP in
   `vercel.json` (`npm run check` fails if a project isn't in the CSP).
   It refuses production's ref. Not yet run: there's no staging project to
   run it on.
2. Commit those two files and push to `staging`.
3. Add the repository variable `STAGING_PROJECT_REF`. From then on every
   release goes through staging first.
4. Configure staging's sign-in settings, and create its first Super Admin.
   The script prints both commands.

---

## What needs setting, and by whom

| What | Where | Why | Who |
|---|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | GitHub → Settings → Secrets and variables → Actions → **Secrets** | Backups; the release's migrations and API deploys | You: a personal access token from supabase.com/dashboard/account/tokens |
| `SENTRY_DSN` | Supabase function secret, production (and staging) | Turns error reporting on | You: from your Sentry or GlitchTip project |
| `STAGING_PROJECT_REF` | GitHub → Actions → **Variables** | Turns the staging stage on | After the staging project exists |
| `BACKUP_AGE_RECIPIENT` | GitHub → Actions → **Variables** (optional) | Encrypted off-site copy of each backup | You: `age-keygen`; keep the private key offline |
| Plan / PITR | Supabase → Organization → Billing | Point-in-time recovery; room for a staging project | You (billed) |
| An outside uptime monitor (optional) | UptimeRobot / Better Stack / Sentry | Alerts that don't depend on GitHub | You (an account) |
