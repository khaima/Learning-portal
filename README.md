# HPF Digital Learning Portal

A fresh, standalone build for Human Practice Foundation's Teacher and
Learner experience — separate from the existing `HPF-digital-portal-2026`
project, its Supabase backend, and its real accounts. Nothing here talks
to that system or its data.

## What this is

A static, no-build, dependency-free site: plain HTML, CSS, and vanilla
ES-module JavaScript. Three real pages:

- **`index.html`** — the landing / sign-in screen. Pick a role (Teacher
  or Learner), then sign in or create an account. Styled in the spirit of
  Zeraki Learning's role-first flow, in HPF's own branding — a deep-navy
  hero panel, warm terracotta accent, and the portal's real numbers.
- **`teacher.html`** — a teacher's classes, this week's grading queue,
  recent results, and Digital Library picks.
- **`learner.html`** — a learner's classes, assignments (with a working
  "Mark done" that actually persists), and Digital Library picks.

## What it does NOT have yet

- **No real backend.** There is no server, no database, no Supabase
  project. "Accounts" are a JSON array in `localStorage`
  (`auth.js`) — plausible for a demo, not secure, and not meant to hold
  real people's data. Passwords are stored in plain text because there is
  nothing to hash against; do not carry that pattern into anything real.
- **No School Leader, Field Officer, M&E, or Admin roles.** Scoped to
  Teacher and Learner only, per how this build was commissioned.
- **No cross-device sync.** Everything lives in one browser. Clearing
  site data (or opening a different browser) starts over.
- **Sample content only.** The two seed accounts below come with
  realistic-looking classes, assignments, and results so the pages don't
  open empty — none of it is real. A freshly signed-up account gets an
  honest empty dashboard instead of someone else's demo data.

## Try it

```
python -m http.server 5174
```
then open `http://localhost:5174`.

Two seed accounts (also offered as one-click fills on the sign-in page):

| Role    | Username      | Password   |
|---------|---------------|------------|
| Teacher | `grace.mwangi`| `demo1234` |
| Learner | `naomi.k`     | `demo1234` |

Or use "Create an account" to sign up fresh — the new account starts with
no classes or assignments, honestly, rather than fabricated content.

## File map

| File | Purpose |
|---|---|
| `index.html` / `index.js` | Landing page: role picker, sign in, sign up |
| `teacher.html` / `teacher.js` | Teacher dashboard |
| `learner.html` / `learner.js` | Learner dashboard |
| `auth.js` | Demo, localStorage-only accounts and sessions |
| `data.js` | Seed accounts and their sample content |
| `util.js` | Tiny shared DOM/escaping/toast helpers |
| `styles.css` | The whole design system (light + dark, one file) |

## Where this could go next

The obvious next step, if this is worth carrying forward, is a real
backend — the existing `HPF-digital-portal-2026` project already has one
(Supabase: auth, RLS, a permission matrix, an offline-first PWA for field
officers) that this could plug into instead of reinventing it. That is a
deliberate choice to make later, not something this build assumes.
