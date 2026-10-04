# Role-based access control

How the HPF Digital Learning Portal decides **who sees which workspace,
which pages, which actions and which data**. One model, enforced in five
layers that must agree:

1. **Visible menu** — each role's sidebar is generated from its role and
   permissions (`navigation.js`).
2. **Route protection** — a page (and each section inside it) opens only for
   the roles and permissions it belongs to; typing a URL doesn't get round it.
3. **API authorization** — every endpoint checks the caller's permission,
   worked out on the server from their own account, never from the browser.
4. **Database** — every table is deny-all (RLS on, no policies, no grants to
   browser roles); only the API (service role) reaches data.
5. **Data scope** — the API limits every list and every change to the
   counties, schools, classes or records the caller is assigned to.

---

## 1. Audit: the portal before this change (3 Oct 2026)

### Where roles live and how they are checked

| Layer | Before |
|---|---|
| Role storage | `profiles.role` for staff (`super_admin`, `admin`, `me`, `education_team`, `field_officer`, `school_leader`, `teacher`) with `profiles.status` (`pending` / `active` / `suspended` / `rejected` / `deactivated`); learners in their own `learners` table. |
| Sign-in | Staff: Supabase Auth (email + password, optional Google). Learners: username + 4-digit PIN, session token issued by the API. |
| API | One Edge Function. Every protected route asks for a **permission** (`requirePermission`), worked out from the caller's own `profiles` row (`ROLE_PERMISSIONS` in `permissions.ts`); inactive accounts reach nothing. Solid. |
| Database | 52 tables, all with RLS on, **no policies**, no privileges for `anon` / `authenticated`. Two trigger functions were still executable by those roles (harmless, but untidy). |
| Navigation | Five HTML dashboards. **Super Admin, Admin, M&E and Education Team all used `education.html`** ("Education Team workspace"), with links hidden by permission. |
| Route protection | Per page file by role (`requireRole`). Inside `education.html`, a hidden link's section was still a valid page: typing `#users` after the page loaded showed it (the API still refused the data). |
| Data scope | School head = own school; teacher = the classes they teach; learner = own records; field officer = own visits **but could file a visit at any school in any county**; Education Team, M&E, Admin and Super Admin = every school, with no way to narrow it. |
| Audit | Append-only `audit_log` (accounts, learners, data quality, Kobo, exports); shown only inside the Users page. |

### Live accounts (counts only)

1 Super Admin · 1 Admin · 1 Education Team · 0 M&E · 4 Field Officers ·
2 School Heads (one not yet linked to a school) · 2 Teachers (one
deactivated) · 2 Learners.

**Roles map one-to-one** to the eight HPF roles — no account changes role and
no stored value is renamed:

| HPF role | Stored value |
|---|---|
| SUPER_ADMIN | `super_admin` |
| ADMIN | `admin` |
| M&E | `me` |
| EDUCATION_TEAM | `education_team` |
| FIELD_OFFICER | `field_officer` |
| SCHOOL_HEAD | `school_leader` (already shown as "School Head") |
| TEACHER | `teacher` |
| LEARNER | `learners` table |

**What does not map cleanly — field officers' schools.** Officers only had a
free-text county: *Meru*, *Isiolo*, *isiolo* and *Nanyuki*. The first three
are counties in the school list; **Nanyuki is not** (it's a town, and there
is no county of that name). So "assigned schools" can be derived for three
officers (their whole county) but not for the fourth — see §8.

### Permissions before (generated from `permissions.ts`)

| Permission | super_admin | admin | me | education_team | field_officer | school_leader | teacher | learner |
|---|---|---|---|---|---|---|---|---|
| `schools.manage` | ✓ | ✓ |  | ✓ |  |  |  |  |
| `subjects.manage` | ✓ | ✓ |  | ✓ |  |  |  |  |
| `learners.manage` |  |  |  |  |  |  | ✓ |  |
| `learners.view.school` |  |  |  |  |  | ✓ |  |  |
| `learners.manage.school` |  |  |  |  |  | ✓ |  |  |
| `learners.view.all` | ✓ | ✓ | ✓ | ✓ |  |  |  |  |
| `learners.manage.all` | ✓ | ✓ |  |  |  |  |  |  |
| `learners.transfer` | ✓ | ✓ | ✓ |  |  |  |  |  |
| `classes.manage.school` |  |  |  |  |  | ✓ |  |  |
| `classes.manage.all` | ✓ | ✓ |  |  |  |  |  |  |
| `calendar.manage` | ✓ | ✓ |  |  |  |  |  |  |
| `library.read.learner` | ✓ | ✓ | ✓ | ✓ |  | ✓ | ✓ | ✓ |
| `library.read.staff` | ✓ | ✓ | ✓ | ✓ |  | ✓ | ✓ |  |
| `library.read.head` | ✓ | ✓ | ✓ | ✓ |  | ✓ |  |  |
| `library.manage` | ✓ | ✓ |  | ✓ |  |  |  |  |
| `library.usage.view` | ✓ | ✓ | ✓ | ✓ |  |  |  |  |
| `forms.respond` |  |  |  |  | ✓ | ✓ | ✓ |  |
| `forms.manage` | ✓ | ✓ |  | ✓ |  |  |  |  |
| `forms.responses.view` | ✓ | ✓ | ✓ | ✓ |  |  |  |  |
| `assignments.view.own` |  |  |  |  |  |  |  | ✓ |
| `assignments.submit` |  |  |  |  |  |  |  | ✓ |
| `assignments.manage` |  |  |  |  |  |  | ✓ |  |
| `assignments.grade` |  |  |  |  |  |  | ✓ |  |
| `assignments.view.school` |  |  |  |  |  | ✓ |  |  |
| `assignments.view.all` | ✓ | ✓ | ✓ | ✓ |  |  |  |  |
| `field_reports.create` |  |  |  |  | ✓ |  |  |  |
| `field_reports.view.own` |  |  |  |  | ✓ |  |  |  |
| `field_reports.view.all` | ✓ | ✓ | ✓ | ✓ |  |  |  |  |
| `stats.view` | ✓ | ✓ | ✓ | ✓ |  |  |  |  |
| `intelligence.view` | ✓ | ✓ | ✓ | ✓ |  |  |  |  |
| `data_quality.view` | ✓ | ✓ | ✓ | ✓ |  |  |  |  |
| `data_quality.manage` | ✓ | ✓ | ✓ | ✓ |  |  |  |  |
| `me.view` | ✓ | ✓ | ✓ | ✓ |  |  |  |  |
| `me.framework.manage` | ✓ | ✓ | ✓ |  |  |  |  |  |
| `me.actuals.record` | ✓ | ✓ | ✓ | ✓ |  |  |  |  |
| `me.actuals.verify` | ✓ | ✓ | ✓ |  |  |  |  |  |
| `me.reports.manage` | ✓ | ✓ | ✓ |  |  |  |  |  |
| `trainings.manage` | ✓ | ✓ | ✓ | ✓ |  |  |  |  |
| `sync.monitor` | ✓ | ✓ |  | ✓ |  |  |  |  |
| `notifications.view.all` | ✓ | ✓ |  | ✓ |  |  |  |  |
| `school.overview.view` |  |  |  |  |  | ✓ |  |  |
| `kobo.manage` | ✓ | ✓ |  | ✓ |  |  |  |  |
| `kobo.results.view` | ✓ | ✓ | ✓ | ✓ |  |  |  |  |
| `kobo.surveys.fill` |  |  |  |  | ✓ |  |  |  |
| `users.view` | ✓ | ✓ |  | ✓ |  |  |  |  |
| `users.invite` | ✓ | ✓ |  |  |  |  |  |  |
| `users.approve` | ✓ | ✓ |  |  |  |  |  |  |
| `users.roles.assign` | ✓ | ✓ |  |  |  |  |  |  |
| `users.status.manage` | ✓ | ✓ |  |  |  |  |  |  |
| `users.password.reset` | ✓ | ✓ |  |  |  |  |  |  |
| `users.placement.assign` | ✓ | ✓ |  |  |  |  |  |  |
| `users.edit` | ✓ | ✓ |  |  |  |  |  |  |
| `audit.view` | ✓ | ✓ |  |  |  |  |  |  |

### Gaps against the HPF model

1. Four management roles shared one "Education Team" dashboard and landing page.
2. Admin held exactly the Super Admin permission set, including the M&E results framework and the full audit log.
3. The Education Team could browse every staff account, add and remove schools and counties, configure the Kobo connection (API token, live push), run M&E and data-quality work and read the notifications log.
4. M&E could transfer learners between schools (a write on learner records).
5. No data scope for management roles, and none for field officers.
6. No way to grant one person one extra permission ("unless explicitly granted").
7. Hidden sections were reachable by typing their URL hash.
8. No Platform or Administration overview, no audit log page, no "my access" view.

---

## 2. Roles, workspaces and landing pages

| Role | Workspace | Page | Lands on | Main question |
|---|---|---|---|---|
| SUPER_ADMIN | Platform Administration | `platform.html` | Platform overview | Is the platform secure, healthy and correctly configured? |
| ADMIN | Programme Administration | `admin.html` | Administration overview | Is the programme operationally organised and running correctly? |
| M&E | Monitoring & Evaluation | `me.html` | M&E overview | Are HPF programmes achieving their intended results, and can we show it with reliable data? |
| EDUCATION_TEAM | Learning & Education | `education.html` | Learning overview | How is learning happening, and what support do teachers and learners need? |
| FIELD_OFFICER | Field Operations | `field.html` | My dashboard | What needs to happen at the schools I support? |
| SCHOOL_HEAD | School Management | `leader.html` | School overview | What is happening in my school? |
| TEACHER | Teaching & Learning | `teacher.html` | My teaching | What is happening in my classes and learners? |
| LEARNER | My Learning | `learner.html` | My learning | What do I need to learn, complete and improve? |

A Super Admin can also open the Admin, M&E and Education workspaces (they
hold those permissions) from the account menu; it is never their landing
page. No other role can open another role's workspace.

---

## 3. Permissions

Existing permission names are kept (they are already granular and covered by
the tests); new ones fill the gaps. Requested names map like this:

| Requested | Implemented as |
|---|---|
| users.view / create / update / suspend | `users.view` · `users.invite` + `users.approve` · `users.edit` + `users.roles.assign` + `users.placement.assign` · `users.status.manage` |
| schools.view / create / update | `schools.profile.view` · `schools.manage` |
| learners.view / create / update / transfer | `learners.view.all` (`.school`, teacher's `learners.manage`) · `learners.manage.all` (`.school`) · `learners.transfer` |
| classes.view / create / update | class lists follow the learner view permissions · `classes.manage.all` (`.school`) |
| content.view / create / publish / archive | `library.read.*` · `library.manage` |
| assignments / assessments .view / create / grade | `assignments.view.all` (`.school`, `.own`) · `assignments.manage` · `assignments.grade` (assessments are assignments in this portal) |
| m_and_e.view / m_and_e.manage / indicators.view / indicators.manage | `me.view` · `me.framework.manage` |
| indicator_results.record / verify | `me.actuals.record` · `me.actuals.verify` |
| data_quality.view / resolve | `data_quality.view` · `data_quality.manage` |
| kobo.view / sync / configure | `kobo.results.view` · `kobo.manage` (+ `kobo.review`) · **`kobo.configure`** (new) |
| audit.view | `audit.view` |
| system_settings.manage | **`platform.view`** + **`permissions.manage`** (new) and `subjects.manage` / `calendar.manage` |
| reports.view / reports.export | **`reports.export`** (new) + each report's own data permission; **`reports.programme`** (new) for programme reports |
| notifications.view | every active account (own notifications); `notifications.view.all` for the log |

New permissions: `platform.view`, `permissions.manage`, `kobo.configure`,
`kobo.review`, `reports.export`, `reports.programme`,
`learning.dashboard.view`, `teachers.view`, `schools.profile.view`.

**Explicit grants.** A Super Admin can grant one person one extra
management permission (with a reason), and revoke it; both are in the audit
log. Effective permissions = the role's permissions + that person's open
grants. `permissions.manage` itself can't be granted, and working-role
permissions (a teacher's classes, a head's school, a learner's work) can't be
granted to other roles.

The role → permission table after this change is in §5 (generated from code
at the end of the work).

---

## 4. Data scope

| Role | Scope |
|---|---|
| SUPER_ADMIN | Global — always. |
| ADMIN | Global, or the counties / schools assigned to them. |
| M&E | Global, or the counties / schools assigned to them. |
| EDUCATION_TEAM | Global, or the counties / schools assigned to them. |
| FIELD_OFFICER | Only the counties / schools assigned to them. Nothing until assigned. |
| SCHOOL_HEAD | Their own school. |
| TEACHER | The classes they teach (in their own school). |
| LEARNER | Their own account and work. |

Assignments are stored in `staff_scopes` (county or school, never deleted —
ended, with who and when) and managed on the Users page by Admins and Super
Admins (`users.placement.assign`), within their own scope and authority. A
county assignment covers every school in that county, including schools
added later. "No programme" scope: schools aren't linked to M&E programmes
in the data, so programme-level scope isn't possible yet (§10).

The API applies scope to every list and every change: schools, school
profiles, learners, classes, teachers, assignments, submissions, results,
field visits, Kobo records and results, data-quality issues, impact
dashboards, M&E results, library usage, form responses, reports and exports,
staff accounts, the notifications log and field-team devices.

---

## 5–9

Filled in when the work is done: final permission table, feature matrix,
sidebars, enforcement, migration and tests.
