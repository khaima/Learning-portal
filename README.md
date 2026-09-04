# HPF Digital Learning Portal

A fresh, standalone build for Human Practice Foundation's Teacher,
Learner, School Leader, Field Officer, and Education Team experience —
separate from the existing `HPF-digital-portal-2026` project, its
Supabase backend, and its real accounts. Nothing here talks to that
system or its data.

## What this is

A static, no-build, dependency-free site: plain HTML, CSS, and vanilla
ES-module JavaScript. Six real pages:

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
  the new report is saved and appears in the list immediately.
- **`education.html`** — the Education Team's dashboard: upload content
  to the shared Digital Library, build and send a form (a mix of 1–5
  rating and short-answer questions) to Teachers or School Leaders, see
  responses roll in with a live average for rating questions, and a
  stats row aggregated live from every account recorded in this browser.

## The content → form → feedback loop

This is the part worth trying end to end:

1. Sign in as **Education Team** (`amina.hassan` / `demo1234`).
2. Upload something to the Digital Library, or create a form addressed
   to Teachers or School Leaders (add as many rating/short-answer
   questions as you like).
3. Sign out, sign in as **Teacher** (`grace.mwangi`) or **School Leader**
   (`peter.kamau`) — the new library item shows up, and the new form
   appears under "Forms from the Education Team" as *Pending*.
4. Fill it out and submit.
5. Sign back in as Education Team — the response is there, with a live
   average for any rating questions and the respondent's name against
   any short answers.

All of it — content, forms, and responses — is a **shared, org-wide**
store (`store.js`), not tied to one account, which is what makes step 3
and step 5 actually show each other's work within the same browser.

## What it does NOT have yet

- **No real backend.** There is no server, no database, no Supabase
  project. "Accounts" are a JSON array in `localStorage`
  (`auth.js`) — plausible for a demo, not secure, and not meant to hold
  real people's data. Passwords are stored in plain text because there is
  nothing to hash against; do not carry that pattern into anything real.
- **No M&E or Admin roles.** Scoped to the five roles above, per how this
  build was commissioned.
- **No cross-device sync.** Everything — accounts, library, forms,
  responses — lives in one browser's `localStorage`. Clearing site data
  (or opening a different browser) starts over, and "live across every
  account" only ever means every account recorded in *that* browser.
- **No real file upload.** "Upload content" records a title, subject,
  type, and description — not an actual file. Treat it as the mechanism
  a real content-management flow would sit behind, not the whole thing.
- **Sample content only.** The seed accounts below come with
  realistic-looking classes, assignments, returns, reports, library items
  and one already-answered form so the pages don't open empty — none of
  it is real. A freshly signed-up account gets an honest empty dashboard
  instead of someone else's demo data.

## Try it

```
python -m http.server 5174
```
then open `http://localhost:5174`.

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
| `field.html` / `field.js` | Field Officer dashboard, incl. the county → school → visit type report form |
| `education.html` / `education.js` | Education Team dashboard: content upload, form builder, results, live org-wide stats |
| `auth.js` | Demo, localStorage-only accounts and sessions |
| `store.js` | Shared, org-wide stores: content library, forms, responses |
| `data.js` | Roles, seed accounts, seed content, and form/library constants |
| `util.js` | Tiny shared DOM/escaping/toast helpers |
| `styles.css` | The whole design system (light + dark, one file) |

## Where this could go next

The obvious next step, if this is worth carrying forward, is a real
backend — the existing `HPF-digital-portal-2026` project already has one
(Supabase: auth, RLS, a permission matrix, an offline-first PWA for field
officers, and this exact county → school → visit-type cascade already
live in production) that this could plug into instead of reinventing it.
That is a deliberate choice to make later, not something this build
assumes.
