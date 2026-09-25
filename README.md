# HPF Digital Learning Portal

**🔗 Live: <https://khaima.github.io/Learning-portal/>**

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
  name, role and — for teachers and school heads — County → School from
  the school list (see "Schools and codes" below).
- **`teacher.html`** — a teacher's classes, this week's grading queue,
  recent results, forms sent by the Education Team, Teacher Resources and
  the Digital Library, plus **My Learners**: an editable roster where the
  teacher adds learner accounts (name, username, grade, 4-digit PIN) and
  can edit them, reset a PIN, unlock, or remove. A **My learning activity**
  panel shows their own content-library usage (see below).
- **`learner.html`** — signed in with a username + PIN. A learner's
  classes, assignments (with a working "Mark done" that persists
  server-side), the Digital Library, and their own **My learning
  activity** panel.
- **`leader.html`** — a head of institution's enrolment/staffing snapshot,
  the termly return cycle, recent field visits, forms from the Education
  Team, **all three** content shelves — Teacher Resources, the Digital
  Library, and **For School Head** (content addressed to school
  leadership specifically, never mixed into teachers' own resources) —
  and their own **My learning activity** panel.
- **`field.html`** — a field officer's stats and the flagship flow: pick a
  county, the school list (with codes) narrows, pick a visit type — the
  Education Team's forms for that programme (Learning, Infrastructure,
  ICT, MEP) appear straight away — start the visit, fill those forms in,
  submit — the report and its forms save together and appear immediately.
  Plus other forms addressed to Field Officers,
  and **Field surveys** — KoboToolbox surveys attached by the Education
  Team, each with an **Open survey** button that launches Kobo's own web
  form (prefilled with the officer's ID) and a status pill that flips to
  **Submitted** once the submission is detected.
- **`education.html`** — the Education Team's dashboard: upload content —
  attach a real file or a whole folder from your computer (drag-and-drop
  or the file/folder picker) — to one of three destinations:
  **Teacher Resources** (teachers and the head of institution only), the
  **Digital Library** (learner-facing, also visible to teachers and
  heads), or **For School Head** (head of institution only — for things
  addressed specifically to school leadership). Create a form — build
  questions (1–5 rating and short answer), upload a form file, or paste a
  link — and send it to Teachers, School Leaders, or Field Officers, in
  one county or all counties; a Field Officer form can be tied to a visit
  type so it's filled in during every visit of that type. Each form
  reaches exactly those people automatically. Watch responses roll in
  (live rating averages, filled copies to download, the school for visit
  forms),
  connect **KoboToolbox** to publish field surveys (see below), see a
  **Content usage report** (see below), and see a **Portal impact**
  dashboard (see below).

### Portal impact dashboard

The Education Team's Overview page charts what the portal has actually
collected, from all four operational roles, with a **Filter by county**
and **Filter by school** picker that rescopes everything at once — stat
tiles and charts alike — and updates every chart's title so it's never
ambiguous what you're looking at:

- **Accounts by role**, **assignment completion**, **learners by grade**
  (and, once a county's picked, **by school**), **new learners by term**
  (Kenya's Jan–Apr / May–Aug / Sep–Dec school year, bucketed from each
  account's sign-up date), **teachers by employment type** (BOM vs TSC,
  self-declared once at onboarding), **field visits** by type and county/
  school, **content library** makeup, and **forms & feedback engagement**
  (sent vs. actually answered, per role).
- **Grade performance** is ranked highest-first with a **Top 5 / Top 10 /
  All** picker. It measures **assignment completion rate**, the one
  real signal the portal currently records that's comparable across
  grades — **not an academic score**. There's no gradebook/exam-results
  feature yet, so this chart is honest about what it's actually showing.
- Forms & feedback engagement and the content library aren't tied to a
  school, so they stay portal-wide and say so rather than silently
  ignoring the filter.
- Every number is computed server-side in `GET /api/stats` (education-
  team only) from the live tables — nothing here is seeded or fabricated;
  an empty chart says "No answers yet" rather than faking a shape.

### Content usage tracking

Every "Open to read" click on any dashboard is timed:

- **On the reader's own dashboard** — Teacher, Learner, and School
  Leader all get a **My learning activity** panel: total time spent,
  resources opened, and a per-visit list with a start time and, once
  they've come back to the tab, a finish time and duration.
- **On the Education Team's dashboard** — the Digital Library page's
  **Content usage report** rolls every account's activity up into one
  view: total time spent, resources opened, timed sessions, and active
  users; the most-visited resources ranked by time; and a per-school
  breakdown. A **school filter** scopes the whole report to one school,
  or leave it on "All schools" to see everything combined.
- **Honesty about what "time spent" means**: "Open to read" launches a
  signed Storage URL in a new tab — often a PDF, image, or video the
  browser renders natively — so there is no way to see what happens
  inside it. What's actually measured is wall-clock time from the click
  to the moment the visitor comes back to the portal tab
  (`visibilitychange`, wired once in `nav.js` for every dashboard). This
  is a reasonable proxy for engagement, not a literal measurement of
  reading attention; a visit that never gets a return trip (they close
  the whole browser, say) simply stays open-ended with no completion
  time or duration, rather than guessing one.

### KoboToolbox field surveys

The Education Team's dashboard has a **Field surveys (KoboToolbox)** panel:

- **Connect once** — paste an EU KoboToolbox **API token**
  (`https://eu.kobotoolbox.org` → Account settings → Security). The token
  is verified against KoboToolbox and then stored **server-side only**
  (`kobo_config`) — it is never sent back to any browser.
- **Attach a survey** — pick any *deployed* survey from the account and
  attach it. It appears on every Field Officer dashboard.
- Each survey must contain a **hidden** question whose data column name is
  `officer_ref` (configurable). The portal prefills it with the field
  officer's profile id via the Enketo `?d[officer_ref]=<id>` URL param,
  and matches submissions back with
  `?query={"officer_ref":"<id>"}` on the Kobo data API.
- Submissions are detected automatically (on the officer's dashboard load
  and the Education Team's **Sync now**); officers also have a manual
  "I've submitted this" fallback.
- **Survey results** — a panel on the Education Team dashboard picks one
  attached survey and draws a live chart per question (bar / donut /
  number summary / recent-answers list, plus a submissions-by-officer
  breakdown) straight from the KoboToolbox submissions. It re-reads on
  survey change, on **Refresh**, when the tab regains focus, and every
  45 seconds while the tab is open. Answers are never stored in the
  portal database — they are fetched from Kobo each time.

### Schools and codes

Schools come from one list, so a school is always the same school
everywhere and no school's teachers or learners get mixed with another's.

- **Counties** are fixed: Narok, Laikipia, Meru, Isiolo.
- **Schools** are managed by the Education Team on **Schools → School
  list**: pick a county, type the name, and the portal gives the school a
  code from its county — `NRK-001` is Narok's first school (`NRK` Narok,
  `LKP` Laikipia, `MRU` Meru, `ISL` Isiolo). Schools can be renamed (codes
  never change) and removed once nobody is in them.
- **Personal codes**: everyone placed in a school gets their own code under
  it — `NRK-001-T01` for a teacher, `NRK-001-H01` for a school head,
  `NRK-001-L0001` for a learner. Numbers only ever count up, so a code is
  never given to a second person.
- **Who picks what**: teachers and school heads choose County → School when
  they set up their account; learners are placed automatically in the
  school of the teacher who adds them; field officers choose a county and
  pick the school per visit; the Education Team isn't tied to a school.
- **Existing accounts** made before codes are asked once, on their next
  sign-in, to choose their school (a teacher's learners join it too). Only
  the Education Team can move someone to a different school afterwards
  (Users → Edit), which gives them a new code — a teacher's learners move
  with them.

## The backend

Three parts, all in the project's own dedicated Supabase project
(`hpf-learning-portal`, ref `fwpqytrdlmxymvegvgji`) — entirely separate
from `HPF-digital-portal-2026`:

1. **Auth** — two paths, **no email is ever sent**:
   - **Staff** (teacher / school head / field officer / education team) sign
     in with an **email + password**, or **Continue with Google**. The API
     creates password accounts already-confirmed, so sign-in is a plain
     Supabase Auth check (no self-service password reset, since no email is
     sent). Google sign-in uses Supabase's own OAuth — first time through it
     lands in the same onboarding step as a password sign-up (role + name);
     after that it's a one-click return.
   - **Learners** use a **username + 4-digit PIN**. Their teacher creates
     the account from the teacher dashboard; the API verifies the PIN
     (scrypt-hashed, locks after 5 wrong tries) and issues its own session
     token.
   - **Remember me** — every sign-in form (password, learner PIN) has a
     "Remember me on this device" checkbox, checked by default. Checked, the
     session/token is kept in `localStorage` (survives closing the browser)
     and the last email/username used is remembered so the field is
     pre-filled next time. Unchecked, it goes in `sessionStorage` instead —
     gone the moment the tab or browser closes — and nothing is
     remembered for next time. No password or PIN is ever stored, only the
     identifier.
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

### Turning on Google sign-in

The **Continue with Google** button is already wired up on the frontend —
it fails gracefully ("Google sign-in isn't set up yet") until three
one-time, manual steps are done in the Google and Supabase dashboards
(no code or MCP tool does this part):

1. **Google Cloud Console** → APIs & Services → Credentials → Create
   Credentials → OAuth client ID → Web application. Add this Authorized
   redirect URI:
   `https://fwpqytrdlmxymvegvgji.supabase.co/auth/v1/callback`
2. **Supabase Dashboard** → Authentication → Sign In / Providers →
   Google → enable it, paste the Client ID and Client Secret from step 1.
3. **Supabase Dashboard** → Authentication → URL Configuration → set
   Site URL to `https://khaima.github.io/Learning-portal/` and add it
   (plus `http://localhost:*` for local dev) to Additional Redirect URLs.

Once enabled, no frontend change is needed — the button starts working
immediately for both new sign-ups and returning accounts.

## The content → form → feedback loop

Worth trying end to end:

1. Create a staff account → onboard as **Education Team**.
2. Upload content — attach a file or folder — to **Teacher Resources**,
   the **Digital Library**, or **For School Head**, and/or send a form to
   Teachers, School Leaders, or Field Officers.
3. Sign out. Create another staff account → onboard as a **Teacher**. Add
   a learner from **My Learners**. Sign out, pick **Learner** on the
   sign-in screen, and sign in with that username + PIN — a Teacher
   Resources item never shows for them, a Digital Library item does.
4. Back as the Teacher / a Field Officer / School Leader: the form
   appears as *Pending*; fill it in and submit.
5. Back as Education Team — the response is there, with a live average for
   rating questions and the respondent's name against short answers.
6. As the Teacher (or Learner, or School Leader), click **Open to read**
   on something in the library, then come back to that tab — check **My
   learning activity** on their dashboard for the timed visit. Back as
   Education Team, the same visit shows up in the Digital Library page's
   **Content usage report**, filterable by school.

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
- **No gradebook / exam-results feature.** The portal has nowhere to
  record a learner's actual score on a subject or exam, only whether an
  assignment was marked done. "Grade performance" on the Portal impact
  dashboard is completion rate as a proxy, clearly labelled as such —
  it is not academic performance.
- **Removing a learner is permanent — no drop-out tracking.** A teacher's
  "Remove" hard-deletes the row; there's no record of who left, when, or
  why, so the portal cannot report enrolment/drop-out trends over time.

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
| `supabase.js` | The Supabase Auth client (password + Google) and the "remember me" storage adapter |
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
