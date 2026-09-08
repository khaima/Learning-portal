# HPF Digital Learning Portal

A standalone build for Human Practice Foundation's Teacher, Learner,
School Leader (head of institution), Field Officer, and Education Team
experience — a genuinely separate system from the existing
`HPF-digital-portal-2026` project and its real accounts, with its own
dedicated Supabase project (see "The backend" below).

## What this is

A **static, no-build, dependency-free front end** — plain HTML, CSS, and
vanilla ES-module JavaScript — talking to a **real backend**: a Supabase
Edge Function API in front of a locked-down Postgres database. Six pages:

- **`index.html`** — sign-in. Pick a role, then sign in — staff with an
  email + password, learners with a username + 4-digit PIN. New staff
  create an account (no email verification) and a one-step form captures
  name and role.
- **`teacher.html`** — a teacher's classes, this week's grading queue,
  recent results, forms sent by the Education Team, Teacher Resources and
  the Digital Library, plus **My Learners**: an editable roster where the
  teacher adds learner accounts (name, username, grade, 4-digit PIN) and
  can edit them, reset a PIN, unlock, or remove.
- **`learner.html`** — signed in with a username + PIN. A learner's
  classes, assignments (with a working "Mark done" that persists
  server-side), and the Digital Library.
- **`leader.html`** — a head of institution's enrolment/staffing snapshot,
  the termly return cycle, recent field visits, forms from the Education
  Team, and **both** content shelves — Teacher Resources and the Digital
  Library.
- **`field.html`** — a field officer's stats and the flagship flow: pick a
  county, the school list narrows, pick a visit type, submit — the report
  saves and appears immediately. Plus forms addressed to Field Officers.
- **`education.html`** — the Education Team's dashboard: upload content —
  attach a real file or a whole folder from your computer (drag-and-drop
  or the file/folder picker) — to one of two destinations:
  **Teacher Resources** (teachers and the head of institution only) or the
  **Digital Library** (learner-facing, also visible to teachers and
  heads). Build and send a form (1–5 rating and short-answer questions) to
  Teachers, School Leaders, or Field Officers, watch responses roll in
  with live rating averages, and see org-wide stats aggregated
  server-side.

## The backend

Three parts, all in the project's own dedicated Supabase project
(`hpf-learning-portal`, ref `fwpqytrdlmxymvegvgji`) — entirely separate
from `HPF-digital-portal-2026`:

1. **Auth** — two paths, **no email is ever sent**:
   - **Staff** (teacher / school head / field officer / education team) use
     an **email + password**. The API creates the account
     already-confirmed, so sign-in is a plain Supabase Auth password
     check. (Trade-off: no email means no self-service password reset.)
   - **Learners** use a **username + 4-digit PIN**. Their teacher creates
     the account from the teacher dashboard; the API verifies the PIN
     (scrypt-hashed, locks after 5 wrong tries) and issues its own session
     token.
2. **API** — one Edge Function, [`supabase/functions/api`](supabase/functions/api/index.ts)
   (Deno + Hono). Every read and write goes through it. It verifies the
   caller's JWT, loads their role from the `profiles` table (never trusts
   a JWT claim for authorisation), and does all data access with the
   service-role key.
3. **Database** — Postgres, **locked down**. Every table has RLS enabled
   with **no policies**, and the `anon`/`authenticated` roles have every
   privilege revoked. The browser cannot touch a table directly — the
   only way in is the API. Storage (`library` bucket) is private too;
   the API hands out short-lived signed upload and download URLs.

The publishable key in [`config.js`](config.js) is safe to ship: it can
only reach Supabase Auth, and the database ignores it entirely.

See [`supabase-schema.sql`](supabase-schema.sql) for the full schema and
the lock-down. Apply it to a fresh project, deploy the `api` function,
point `config.js` at the new project, and the app works unmodified.

## The content → form → feedback loop

Worth trying end to end:

1. Create a staff account → onboard as **Education Team**.
2. Upload content — attach a file or folder — to **Teacher Resources** or
   the **Digital Library**, and/or send a form to Teachers, School
   Leaders, or Field Officers.
3. Sign out. Create another staff account → onboard as a **Teacher**. Add
   a learner from **My Learners**. Sign out, pick **Learner** on the
   sign-in screen, and sign in with that username + PIN — a Teacher
   Resources item never shows for them, a Digital Library item does.
4. Back as the Teacher / a Field Officer / School Leader: the form
   appears as *Pending*; fill it in and submit.
5. Back as Education Team — the response is there, with a live average for
   rating questions and the respondent's name against short answers.

Do steps 3–5 on a different device to see what a real backend buys you:
same data everywhere, because the database is the source of truth.

## What it does NOT have yet

- **No M&E or Admin roles.** Scoped to the five roles above.
- **Staff role is self-selected at onboarding.** Fine for a pilot; a real
  deployment would have an admin assign or approve roles rather than let
  anyone pick "Education Team". (Learners don't self-onboard — a teacher
  creates them.)
- **Learner PINs are 4 digits — intentionally weak.** They're
  teacher-managed and locked after 5 wrong tries; fine for coursework and
  library access, not for anything sensitive.
- **A learner belongs to the teacher who created them.** No school-wide
  roster for the school head yet, and no way to move a learner between
  teachers.
- **No password reset for staff.** No email is sent, so a forgotten
  password can only be fixed by an admin resetting it in the Supabase
  dashboard (or a future admin screen).
- **Open staff sign-up.** Anyone who reaches the page can create a staff
  account and pick any role. Fine for a closed pilot; a real deployment
  needs an invite / approval step.
- **No "create class" / "assign homework" UI.** A fresh teacher or learner
  account has an honest empty dashboard until those exist.

## Try it

**Live:** <https://khaima.github.io/Learning-portal/> — deployed from
`main` via GitHub Pages ([`.github/workflows/pages.yml`](.github/workflows/pages.yml)).

Run it locally:

```
python serve.py
```

then open the printed `http://localhost:<port>`. It talks to the live
API immediately — no Supabase dashboard setup needed (email is never
used).

## File map

| File | Purpose |
|---|---|
| `index.html` / `index.js` | Sign-in: role → staff password / learner PIN → onboarding |
| `teacher.html` / `teacher.js` | Teacher dashboard |
| `learner.html` / `learner.js` | Learner dashboard |
| `leader.html` / `leader.js` | Head-of-institution dashboard |
| `field.html` / `field.js` | Field Officer dashboard (county → school → visit report) |
| `education.html` / `education.js` | Education Team dashboard (upload, form builder, results, stats) |
| `supabase.js` | The Supabase Auth client — used only for staff email + password sign-in |
| `api.js` | Thin fetch wrapper over the `api` Edge Function; attaches the JWT |
| `auth.js` | Sessions, the profile, `requireRole` for each dashboard |
| `store.js` | Every data call — library, forms, responses, assignments, reports, stats |
| `config.js` | Supabase URL, publishable key, API base URL |
| `data.js` | Static UI constants (roles, subjects, question types) |
| `util.js` | Tiny shared DOM / escaping / toast helpers |
| `styles.css` | The whole design system (light + dark, one file) |
| `serve.py` | Local static server (honours `$PORT`) |
| `supabase/functions/api/` | The backend API (Deno + Hono) |
| `supabase-schema.sql` | Full schema + the database lock-down |

## Where this could go next

- Invite-only staff sign-up + an admin screen to assign/approve roles and
  reset passwords (right now staff sign-up is open and there's no reset).
- Optional custom SMTP if you later want password-reset or notification
  email — the code path is gone but easy to re-add.
- The missing "create class", "set assignment", "record result" flows, so
  Teacher and Learner dashboards fill from real activity.
- Per-row authorisation could move partly into RLS if the app ever needs
  the database reachable by anything other than this one API.
