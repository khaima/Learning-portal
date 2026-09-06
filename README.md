# HPF Digital Learning Portal

A fresh, standalone build for Human Practice Foundation's Teacher,
Learner, School Leader, Field Officer, and Education Team experience —
a genuinely separate system from the existing `HPF-digital-portal-2026`
project and its real accounts, with its own dedicated Supabase project
(see "The database" below), not just a different table or schema in the
same one.

## What this is

A static, no-build, dependency-free site: plain HTML, CSS, and vanilla
ES-module JavaScript, backed by a real Postgres database (Supabase). Six
real pages:

- **`index.html`** — the landing / sign-in screen. Pick a role, then sign
  in or create an account. Styled in the spirit of Zeraki Learning's
  role-first flow, in HPF's own branding — a deep-navy hero panel, warm
  terracotta accent, and the portal's real numbers.
- **`teacher.html`** — a teacher's classes, this week's grading queue,
  recent results, forms sent by the Education Team, and the shared
  Digital Library.
- **`learner.html`** — a learner's classes, assignments (with a working
  "Mark done" that actually persists), and the shared Digital Library.
- **`leader.html`** — a school leader's enrolment/staffing snapshot, the
  termly return cycle (filed / due / upcoming), recent field visits to
  their school, and forms sent by the Education Team.
- **`field.html`** — a field officer's assigned-school stats and a real,
  working version of the production app's flagship flow: pick a county,
  the school list narrows to that county, pick a visit type, submit —
  the new report is saved and appears in the list immediately. Also
  shows any forms the Education Team has addressed to Field Officers,
  to be filled out in the field, same loop as Teachers and School
  Leaders get.
- **`education.html`** — the Education Team's dashboard: upload content
  to the shared Digital Library — addressed to Teachers, Learners, or
  both — build and send a form (a mix of 1–5 rating and short-answer
  questions) to Teachers, School Leaders, or Field Officers, see
  responses roll in with a live average for rating questions, and a
  stats row aggregated live from every account in the database.

## The database

Real Postgres, via Supabase — its own dedicated Supabase **project**
(`hpf-learning-portal`), entirely separate from `HPF-digital-portal-2026`
(the production portal, a different Supabase project altogether). There
is no shared infrastructure between the two: nothing here can read,
write, or join against the production portal's data, and nothing there
can see this. Every table lives in the default `public` schema, since
this whole project *is* the Learning Portal's database — no schema-level
split needed. See [`supabase-schema.sql`](supabase-schema.sql) for the
exact migration (tables, RLS, seed data) — apply it to a fresh project
and this app works against it unmodified, just change `config.js`.

Because "accounts" and their data are real database rows now, not
per-browser `localStorage`, everything is genuinely shared: an account
created on one device signs in from another; content the Education Team
uploads or a form they send shows up for anyone, anywhere, not just the
browser that created it.

**Security posture is still a demo's, deliberately.** There is no real
Supabase Auth here — no JWT, no password hashing — the app's own
plaintext-password check (`auth.js`) is what it always was, just checked
against a real table instead of a JS array. This project's tables are
open to the Supabase anon key (RLS enabled, with an "allow everything"
policy), the same trust level the old `localStorage` version had. Do not
carry this pattern into anything holding real people's data — it needs
real Supabase Auth and RLS scoped to `auth.uid()` instead.

## The content → form → feedback loop

This is the part worth trying end to end:

1. Sign in as **Education Team** (`amina.hassan` / `demo1234`).
2. Upload something to the Digital Library — choose whether it's for
   Teachers only, Learners only, or both — or create a form addressed
   to Teachers, School Leaders, or Field Officers (add as many
   rating/short-answer questions as you like).
3. Sign out, sign in as whichever role you addressed content or a form
   to (**Teacher** `grace.mwangi`, **Learner** `naomi.k`, **School
   Leader** `peter.kamau`, or **Field Officer** `susan.wanjiru`) — a
   library item shows up only if it was addressed to that role (or to
   both), and the new form appears under "Forms from the Education
   Team" as *Pending*.
4. Fill it out and submit.
5. Sign back in as Education Team — the response is there, with a live
   average for any rating questions and the respondent's name against
   any short answers.

Try steps 3–5 from a *different browser* (or a private window) to see
the part `localStorage` could never do: it's the same data everywhere,
because it's a real database now.

## What it does NOT have yet

- **No M&E or Admin roles.** Scoped to the five roles above, per how this
  build was commissioned.
- **No real file upload.** "Upload content" records a title, subject,
  type, and description — not an actual file. Treat it as the mechanism
  a real content-management flow would sit behind, not the whole thing.
- **No real authentication.** See "Security posture" above — this is a
  demo, and should not be treated as a place for real people's data.
- **Sample content only.** The seed accounts below come with
  realistic-looking classes, assignments, returns, reports, library items
  and a couple of already-answered forms so the pages don't open empty —
  none of it is real. A freshly signed-up account gets an honest empty
  dashboard instead of someone else's demo data.

## Try it

```
python -m http.server 5174
```
then open `http://localhost:5174`. It talks to the live database
immediately — no setup needed unless you're pointing it at a different
Supabase project (see `config.js` and `supabase-schema.sql`).

Five seed accounts (also offered as one-click fills on the sign-in page):

| Role           | Username        | Password   |
|----------------|-----------------|------------|
| Teacher        | `grace.mwangi`  | `demo1234` |
| Learner        | `naomi.k`       | `demo1234` |
| School Leader  | `peter.kamau`   | `demo1234` |
| Field Officer  | `susan.wanjiru` | `demo1234` |
| Education Team | `amina.hassan`  | `demo1234` |

Or use "Create an account" to sign up fresh — the new account starts with
no classes, assignments, returns, or reports, honestly, rather than
fabricated content.

## File map

| File | Purpose |
|---|---|
| `index.html` / `index.js` | Landing page: role picker, sign in, sign up |
| `teacher.html` / `teacher.js` | Teacher dashboard |
| `learner.html` / `learner.js` | Learner dashboard |
| `leader.html` / `leader.js` | School Leader dashboard |
| `field.html` / `field.js` | Field Officer dashboard, incl. the county → school → visit type report form and forms from the Education Team |
| `education.html` / `education.js` | Education Team dashboard: content upload, form builder, results, live org-wide stats |
| `config.js` / `supabase.js` | Supabase connection — its own dedicated project |
| `auth.js` | Accounts and sessions — real database rows, demo-level security |
| `store.js` | Shared, org-wide data: content library, forms, responses |
| `data.js` | Roles, form/library constants (seed *data* now lives in the database, not here) |
| `util.js` | Tiny shared DOM/escaping/toast helpers |
| `styles.css` | The whole design system (light + dark, one file) |
| `supabase-schema.sql` | The exact migration applied to create and seed this project's tables |

## Where this could go next

The obvious next step, if this is worth carrying forward for real, is
real Supabase Auth (email/password or magic link) with RLS rewritten
against `auth.uid()` instead of the current "anon, wide open" policy —
the schema and the app's data flow would barely change, only who's
allowed to read and write what.
