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

The role → permission table after this change is in §5 (generated from code).

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

## 5. Role hierarchy and permissions (after)

```
SUPER_ADMIN ── every right below, plus the platform: permissions and grants,
│              the full audit log, security events, account activity,
│              the Kobo connection, platform overview and health
├─ ADMIN ───── organisation, people (staff accounts below Admin), learning and
│              programme operations, data quality — within their scope
├─ M&E ─────── programme performance, results framework, indicator results,
│              evidence, data quality, reporting — reads programme data, changes none
├─ EDUCATION_TEAM ─ learners, teachers, classes, assignments and results (read),
│              content, training, subjects, field support, forms — within scope
├─ FIELD_OFFICER ── their assigned schools: visits, forms, Kobo surveys
├─ SCHOOL_HEAD ──── their own school
├─ TEACHER ──────── their own classes
└─ LEARNER ──────── their own learning
```

Authority over accounts is separate from permissions: an Admin manages
accounts below Admin only, and hands out only roles below Admin; a Super
Admin manages everyone, except that the last active Super Admin can't be
removed. Nobody manages their own account.

Generated from `permissions.ts` (role permissions; explicit grants come on top):

| Permission | SUPER_ADMIN | ADMIN | M&E | EDUCATION_TEAM | FIELD_OFFICER | SCHOOL_HEAD | TEACHER | LEARNER |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| **Organisation** |||||||||
| Add, rename and remove schools and counties <br>`schools.manage` | ✓ | ✓ |  |  |  |  |  |  |
| See school profiles <br>`schools.profile.view` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |
| Set up academic years and terms <br>`calendar.manage` | ✓ | ✓ |  |  |  |  |  |  |
| Manage classes in every school in scope <br>`classes.manage.all` | ✓ | ✓ |  |  |  |  |  |  |
| Manage classes in their own school <br>`classes.manage.school` |  |  |  |  |  | ✓ |  |  |
| Manage subjects <br>`subjects.manage` | ✓ |  |  | ✓ |  |  |  |  |
| **People** |||||||||
| See staff accounts <br>`users.view` | ✓ | ✓ |  |  |  |  |  |  |
| Invite staff <br>`users.invite` | ✓ | ✓ |  |  |  |  |  |  |
| Approve or reject new accounts <br>`users.approve` | ✓ | ✓ |  |  |  |  |  |  |
| Edit staff details <br>`users.edit` | ✓ | ✓ |  |  |  |  |  |  |
| Change staff roles <br>`users.roles.assign` | ✓ | ✓ |  |  |  |  |  |  |
| Change where staff work, and their data scope <br>`users.placement.assign` | ✓ | ✓ |  |  |  |  |  |  |
| Suspend, deactivate and reactivate accounts <br>`users.status.manage` | ✓ | ✓ |  |  |  |  |  |  |
| Send someone a password reset link, or a temporary password <br>`users.password.reset` | ✓ | ✓ |  |  |  |  |  |  |
| See teachers and school heads (no account actions) <br>`teachers.view` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |
| See learners in every school in scope <br>`learners.view.all` | ✓ | ✓ | ✓ | ✓ |  |  |  |  |
| See learners in their own school <br>`learners.view.school` |  |  |  |  |  | ✓ |  |  |
| Add and change learners in every school in scope <br>`learners.manage.all` | ✓ | ✓ |  |  |  |  |  |  |
| Add and change learners in their own school <br>`learners.manage.school` |  |  |  |  |  | ✓ |  |  |
| Manage learners in the classes they teach <br>`learners.manage` |  |  |  |  |  |  | ✓ |  |
| Move learners between schools <br>`learners.transfer` | ✓ | ✓ |  |  |  |  |  |  |
| **Learning** |||||||||
| See assignments and results in every school in scope <br>`assignments.view.all` | ✓ | ✓ | ✓ | ✓ |  |  |  |  |
| See assignments and results in their own school <br>`assignments.view.school` |  |  |  |  |  | ✓ |  |  |
| Set and run assignments for their classes <br>`assignments.manage` |  |  |  |  |  |  | ✓ |  |
| Mark work for their classes <br>`assignments.grade` |  |  |  |  |  |  | ✓ |  |
| See their own assignments and results <br>`assignments.view.own` |  |  |  |  |  |  |  | ✓ |
| Do and hand in assignments <br>`assignments.submit` |  |  |  |  |  |  |  | ✓ |
| Upload, publish and edit content <br>`library.manage` | ✓ |  |  | ✓ |  |  |  |  |
| Read the Digital Library <br>`library.read.learner` | ✓ | ✓ | ✓ | ✓ |  | ✓ | ✓ | ✓ |
| Read Teacher Resources <br>`library.read.staff` | ✓ | ✓ | ✓ | ✓ |  | ✓ | ✓ |  |
| Read the For School Head shelf <br>`library.read.head` | ✓ | ✓ | ✓ | ✓ |  | ✓ |  |  |
| See how content is used <br>`library.usage.view` | ✓ | ✓ | ✓ | ✓ |  |  |  |  |
| Keep the training register <br>`trainings.manage` | ✓ |  |  | ✓ |  |  |  |  |
| **Programme operations** |||||||||
| Build and send forms <br>`forms.manage` | ✓ | ✓ |  | ✓ |  |  |  |  |
| See form responses <br>`forms.responses.view` | ✓ | ✓ | ✓ | ✓ |  |  |  |  |
| Answer forms sent to them <br>`forms.respond` |  |  |  |  | ✓ | ✓ | ✓ |  |
| See field visits in scope <br>`field_reports.view.all` | ✓ | ✓ | ✓ | ✓ |  |  |  |  |
| See their own field visits <br>`field_reports.view.own` |  |  |  |  | ✓ |  |  |  |
| File field visits at assigned schools <br>`field_reports.create` |  |  |  |  | ✓ |  |  |  |
| Connect KoboToolbox (server, API token, live push) <br>`kobo.configure` | ✓ |  |  |  |  |  |  |  |
| Attach Kobo surveys, sync, map fields <br>`kobo.manage` | ✓ | ✓ |  |  |  |  |  |  |
| Accept or exclude flagged Kobo submissions <br>`kobo.review` | ✓ | ✓ | ✓ |  |  |  |  |  |
| See Kobo survey results <br>`kobo.results.view` | ✓ | ✓ | ✓ |  |  |  |  |  |
| Fill Kobo surveys <br>`kobo.surveys.fill` |  |  |  |  | ✓ |  |  |  |
| See field-team devices in the Sync center <br>`sync.monitor` | ✓ | ✓ |  |  |  |  |  |  |
| See devices with work stuck for 48 hours or more, and sync failures <br>`sync.problems.view` (added 7 Oct 2026) | ✓ | ✓ |  | ✓ |  |  |  |  |
| See the notifications log <br>`notifications.view.all` | ✓ | ✓ |  |  |  |  |  |  |
| **Dashboards and M&E** |||||||||
| Platform overview and system health <br>`platform.view` | ✓ |  |  |  |  |  |  |  |
| Programme performance dashboards <br>`intelligence.view` | ✓ |  | ✓ |  |  |  |  |  |
| Learning dashboards <br>`learning.dashboard.view` | ✓ |  | ✓ | ✓ |  |  |  |  |
| Their own school's overview <br>`school.overview.view` |  |  |  |  |  | ✓ |  |  |
| Programme statistics <br>`stats.view` | ✓ | ✓ | ✓ |  |  |  |  |  |
| See M&E results, evidence and reports <br>`me.view` | ✓ |  | ✓ |  |  |  |  |  |
| Manage the results framework (programmes, outcomes, indicators, targets) <br>`me.framework.manage` | ✓ |  | ✓ |  |  |  |  |  |
| Record indicator results and evidence <br>`me.actuals.record` | ✓ |  | ✓ |  |  |  |  |  |
| Verify indicator results <br>`me.actuals.verify` | ✓ |  | ✓ |  |  |  |  |  |
| Generate and finalize M&E reports <br>`me.reports.manage` | ✓ |  | ✓ |  |  |  |  |  |
| See data quality issues <br>`data_quality.view` | ✓ | ✓ | ✓ |  |  |  |  |  |
| Resolve and correct data quality issues <br>`data_quality.manage` | ✓ | ✓ | ✓ |  |  |  |  |  |
| **Reports and governance** |||||||||
| Export reports (Excel, CSV, PDF) <br>`reports.export` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| Export programme reports (term, county) <br>`reports.programme` | ✓ | ✓ | ✓ |  |  |  |  |  |
| Audit log, security events and account activity <br>`audit.view` | ✓ |  |  |  |  |  |  |  |
| Grant and revoke individual permissions <br>`permissions.manage` | ✓ |  |  |  |  |  |  |  |

## 6. Feature matrix

FULL · CREATE · EDIT · VIEW · OWN · SCOPED (within their data scope) · NONE.

| Feature | SUPER_ADMIN | ADMIN | M&E | EDUCATION_TEAM | FIELD_OFFICER | SCHOOL_HEAD | TEACHER | LEARNER |
|---|---|---|---|---|---|---|---|---|
| Platform overview, system health | FULL | NONE | NONE | NONE | NONE | NONE | NONE | NONE |
| Administration overview | VIEW | VIEW (scoped) | NONE | NONE | NONE | NONE | NONE | NONE |
| Staff accounts (invite, approve, edit, role, school, suspend/deactivate/reactivate, password) | FULL | FULL below Admin (scoped) | NONE | NONE | NONE | VIEW own school's teachers | NONE | NONE |
| Data scope assignments | FULL | EDIT below Admin, within own scope | OWN (see) | OWN (see) | OWN (see) | NONE | NONE | NONE |
| Permission grants | FULL | NONE | NONE | NONE | NONE | NONE | NONE | NONE |
| Audit log, security events, account activity | VIEW | VIEW one account's history (scoped) | NONE | NONE | NONE | NONE | NONE | NONE |
| Schools & counties | FULL | FULL (scoped; counties: global Admin only) | NONE | NONE | NONE | NONE | NONE | NONE |
| School profiles | VIEW | VIEW (scoped) | VIEW (scoped) | VIEW (scoped) | VIEW (assigned) | VIEW (own) | NONE | NONE |
| Academic calendar | FULL | FULL (global Admin only) | VIEW | VIEW | VIEW | VIEW | VIEW | NONE |
| Classes | FULL | FULL (scoped) | VIEW (scoped) | VIEW (scoped) | NONE | FULL (own school) | OWN | OWN |
| Subjects | FULL | VIEW | VIEW | FULL | VIEW | VIEW | VIEW | NONE |
| Learners | FULL | FULL (scoped) | VIEW (scoped) | VIEW (scoped) | NONE | FULL (own school) | EDIT (own classes) | OWN |
| Learner transfers | FULL | FULL (scoped) | NONE | NONE | NONE | NONE | NONE | NONE |
| Teachers directory | VIEW | VIEW (scoped) | VIEW (scoped) | VIEW (scoped) | VIEW (assigned) | VIEW (own school) | NONE | NONE |
| Assignments & assessments | VIEW | VIEW (scoped) | VIEW (scoped) | VIEW (scoped) | NONE | VIEW (own school) | FULL (own classes) | OWN (do and hand in) |
| Marking | NONE | NONE | NONE | NONE | NONE | NONE | FULL (own classes) | NONE |
| Results | VIEW | VIEW (scoped) | VIEW (scoped) | VIEW (scoped) | NONE | VIEW (own school) | VIEW (own classes) | OWN |
| Content library | FULL | VIEW | VIEW | FULL | NONE | VIEW (shelves) | VIEW (shelves) | VIEW (library) |
| Content usage | VIEW | VIEW (scoped) | VIEW (scoped) | VIEW (scoped) | NONE | NONE | OWN | OWN |
| Training register | FULL | NONE | VIEW (scoped) | FULL (scoped) | NONE | NONE | NONE | NONE |
| Forms (build, send) | FULL | FULL (scoped) | NONE | FULL (scoped) | OWN (answer) | OWN (answer) | OWN (answer) | NONE |
| Form responses | VIEW | VIEW (scoped) | VIEW (scoped) | VIEW (scoped) | OWN | OWN | OWN | NONE |
| Field visits | VIEW | VIEW (scoped) | VIEW (scoped) | VIEW (scoped) | CREATE + OWN (assigned schools) | VIEW (own school) | NONE | NONE |
| Kobo connection (server, API token, live push) | FULL | NONE | NONE | NONE | NONE | NONE | NONE | NONE |
| Kobo surveys (attach, sync, field mapping) | FULL | FULL | NONE | NONE | OWN (fill) | NONE | NONE | NONE |
| Kobo review (accept / exclude, school matches) | FULL | EDIT (scoped) | EDIT (scoped) | NONE | NONE | NONE | NONE | NONE |
| Survey results | VIEW | VIEW (scoped) | VIEW (scoped) | NONE | NONE | NONE | NONE | NONE |
| Programme performance (executive, reach, field operations) | VIEW | NONE | VIEW (scoped) | NONE | NONE | NONE | NONE | NONE |
| Learning dashboards (learning, teacher development, digital resources) | VIEW | NONE | VIEW (scoped) | VIEW (scoped) | NONE | OWN (school overview) | OWN | OWN |
| Results framework (programmes, outcomes, indicators, targets) | FULL | NONE | FULL | NONE | NONE | NONE | NONE | NONE |
| Indicator results (record, verify, evidence) | FULL | NONE | FULL (scoped; never verify own) | NONE | NONE | NONE | NONE | NONE |
| M&E reports | FULL | NONE | FULL (scoped) | NONE | NONE | NONE | NONE | NONE |
| Data Quality Center | FULL | FULL (scoped) | FULL (scoped) | NONE | NONE | NONE | NONE | NONE |
| Reports & exports | FULL | SCOPED (operational, programme) | SCOPED (all incl. M&E) | SCOPED (learning) | OWN (visits, assigned schools) | OWN (school) | OWN (classes) | NONE |
| Notifications (own) | OWN | OWN | OWN | OWN | OWN | OWN | OWN | OWN |
| Notifications log | VIEW | VIEW (scoped) | NONE | NONE | NONE | NONE | NONE | NONE |
| Sync center: own device / field-team devices | OWN / VIEW | OWN / VIEW (scoped) | OWN / NONE | OWN / NONE | OWN / NONE | OWN / NONE | OWN / NONE | OWN / NONE |
| Stuck devices (work unsent 48 h+, sync failures and conflicts) | VIEW | VIEW (scoped) | NONE | VIEW (scoped) | NONE | NONE | NONE | NONE |
| My profile (and own password) | OWN | OWN | OWN | OWN | OWN | OWN | OWN | OWN (no password; the teacher sets the PIN) |

## 7. Data-scope matrix

| Role | Scope | Where it comes from |
|---|---|---|
| SUPER_ADMIN | Global | Always |
| ADMIN | Global, or assigned counties / schools | `staff_scopes` (none = global) |
| M&E | Global, or assigned counties / schools | `staff_scopes` (none = global) |
| EDUCATION_TEAM | Global, or assigned counties / schools | `staff_scopes` (none = global) |
| FIELD_OFFICER | Assigned counties / schools only | `staff_scopes` (none = nothing) |
| SCHOOL_HEAD | Own school | `profiles.school_id` |
| TEACHER | Classes they teach, in their own school | `class_teachers` (+ `profiles.school_id`) |
| LEARNER | Own account and work | the learner session |

Someone narrowed to an area also can't: add or remove counties, start a new
school year, run a portal-wide data-quality scan, see whole-programme M&E
results, place anyone outside their area or in a programme-wide role, or
widen someone to "everywhere" by removing all their assignments.

## 8. The menus

Built by `nav.js` from `navigation.js`, keeping only what the person's
permissions allow; groups collapse (remembered per workspace on the device),
show badges for what's waiting (approvals, data-quality issues, Kobo reviews,
work to mark, unread notifications) and fold to an icon rail on wide screens
or a drawer on phones. Pages opened to someone by a grant appear in a
**Granted to you** group. A test (`navigation_test.ts`) checks every
management role's menu lists every page its permissions open — and nothing
else.

| Role (lands on) | Menu |
|---|---|
| **Super Admin** — Platform overview | Dashboard: Platform overview, Administration overview, M&E overview · System management: Users & roles, Schools & counties, Academic calendar, Classes & structure, Subjects · People & learning: Learners, Teachers, School profiles, Assignments & assessments, Results, Content library, Training register · Programme performance: Executive overview, Reach, Learning, Teacher development, Field operations, Digital resources · M&E and data: Results framework, Indicator results, M&E reports, Data quality, Survey results, Field visits · Integrations: KoboToolbox, Forms, Notifications log, Stuck devices, Sync center · Security: Permissions, Audit log, Security events, Account activity · Reports: System reports · Account: My profile, Notifications |
| **Admin** — Administration overview | Dashboard · Organisation: Schools & counties, School profiles, Academic calendar, Classes · People: Staff accounts, Teachers, School heads, Learners, User approvals · Learning operations: Assignments & assessments, Results, Learning resources · Programme operations: Forms, Field visits, Kobo surveys, Survey results, Stuck devices, Sync center · Data: Data quality, Reports & exports · Account: My profile, Notifications, Notifications log |
| **M&E** — M&E overview | Dashboard · Programme performance: Executive overview, Reach, Learning outcomes, Teacher development, Digital resource usage, Field operations · Results framework: Programmes & indicators, Indicator results · Data quality: Data Quality Center, Kobo data quality · Evidence: Survey results, Field visits, Form responses · Programme data: Learners, Teachers, Classes, School profiles, Assignments & assessments, Results, Training register, Content usage · Reporting: M&E reports, Reports & exports · Account |
| **Education Team** — Learning overview | Dashboard · Learning: Learners, Teachers, Classes, Assignments & assessments, Results · Content & curriculum: Content library, Content usage, Subjects · Teacher development: Teacher development, Training register · Field support: School support, Field visits, Education forms, Stuck devices · Reports: Learning reports · Account |
| **Field Officer** — My dashboard | My work: My schools, My visits, Visit forms, Kobo surveys · Schools: School profiles · Learning support: Teachers · Reports: My activity · Account (with Sync center) |
| **School Head** — School overview | My school: School profile, Teachers, Learners & classes · Learning: Assignments & results, Learning resources · Reports: School reports · Account |
| **Teacher** — My teaching | My teaching: My classes, Class roster, Assignments & assessments, Results & progress · Content: Learning resources · Activity: My activity · Account |
| **Learner** — My learning | My learning: My classes, My assignments, My progress, My activity · Library: Learning library · Account |

## 9. The five layers

| Layer | How it's enforced |
|---|---|
| Visible menu | `navigation.js` → `nav.js`: only items the person's permissions (role + grants, from `GET /me`) allow. |
| Route protection | Each workspace page admits only its roles (`requireRole`); anyone else goes to their own workspace. Inside a page, only pages in that person's menu open — any other address returns them to their landing page with a message. Pages outside the menu never load their data. |
| API authorization | Every route: `requirePermission(...)` against the caller's **effective permissions** (role + open grants), worked out on the server from their own account. Account changes also check authority (rank). |
| Database | Every table deny-all: RLS on, no policies, no privileges for `anon` / `authenticated`; only the API's service role reaches data. New tables follow the same rule; trigger functions aren't callable by browser roles. Scope assignments and grants can't be deleted or edited in place (database triggers). |
| Data scope | `scope.ts` resolves each person's scope once per request; every list, dashboard, export and change filters by it (`inScope`, `narrowInput`, learner and assignment scopes). Outside your scope a record is "not found", never "forbidden". |

## 10. Migration (applied 4 Oct 2026)

1. **Backup** — every public table except session tokens and the
   idempotency log was copied into schema `backup_20261004_rbac` (locked
   down like the rest) before anything changed.
2. **Roles** inspected (§1): all map one-to-one; no account's role or id changed.
3. **`20261004095853_rbac_scopes_grants.sql`** — new `staff_scopes` and
   `permission_grants`, deny-all, with guard triggers; field officers' profile
   counties backfilled where they name a real county (Meru, Isiolo, and
   "isiolo" → Isiolo), each recorded in the audit log as `scope.assigned`.
   The officer whose profile says **Nanyuki** was not assigned — an
   administrator must assign their county or schools on Users & roles.
4. Nothing deleted, nothing renamed, no existing row edited.

Role changes for existing accounts (from §1 to §5): the Admin no longer holds
M&E framework, audit-log or Kobo-connection rights; the Education Team no
longer administers staff accounts, schools, Kobo, M&E or data quality; M&E
can no longer transfer learners. A Super Admin can grant any of these back to
one person, with a reason.

## 11. Tests

`supabase/functions/api`: 340 tests, run by GitHub Actions on every push
(`.github/workflows/test.yml`; locally `deno task test`), against the
in-memory world in `test_world.ts`.
- `authz_test.ts` — every route, called as every role, against a hand-written
  table of who may reach it (so a wrong permission fails). Allowed roles must
  get a real success (2xx): a route whose work needs records gets them made
  first, in that call's own world; everyone else gets 403. No session,
  learners and inactive accounts refused everywhere; scenario tests for
  narrowed M&E and Admin scope, field-officer assignments, assignment
  history, grants (give, revoke, refused cases), separation of duties,
  overviews, badges, the users list and account activity.
- `isolation_test.ts` — a teacher sees only their own school's learners,
  classes and submissions (lists, results, exports, by id); field officers
  only their assigned schools (lists, visits, exports, profiles, new visits);
  learner PIN lockout after 5 wrong tries, open again at 15 minutes; pending
  and suspended accounts refused by every endpoint in the app.
- `scope_test.ts` — the scope rules, dashboard narrowing, county matching,
  the HPF separation of duties, grant limits, every permission labelled.
- `navigation_test.ts` — each role's menu matches its permissions exactly;
  the Super Admin's menu reaches every page; grants show in their own group.
- In the browser (local API on the test data): every role's workspace,
  menu, landing page and every menu page; addresses of other pages and other
  workspaces redirected; the account panel's scope and grant changes; the
  phone drawer and desktop rail.

## 12. What changed, and what moved

**Pages.** New workspace pages `platform.html`, `admin.html`, `me.html`;
`education.html` is now the Education Team's only. They share their sections
(`workspace.html`, loaded by `workspace.js`; logic in `console.js`, formerly
`education.js`). New console pages: Platform overview, Administration
overview, Academic calendar, Classes, Subjects, Learners, Teachers, School
profiles, Assignments & assessments, Results, Training register, Field
visits, Survey results, Permissions, Audit log / Security events, Account
activity. Field officers gained Visit forms (was Reports), School profiles,
Teachers and My activity; school heads gained School profile; every role
gained My profile.

**Moved, not removed.** Impact dashboards → M&E (all) and Education Team
(learning side) and Super Admin. Results framework, Indicator results, M&E
reports → M&E and Super Admin. Data quality → Admin, M&E, Super Admin.
Schools & counties, Academic calendar → Admin, Super Admin. Users → Admin
(Staff accounts) and Super Admin (Users & roles), redesigned. Content →
Education Team (manage), Admin and M&E (read, usage). Forms → Admin and
Education Team. Kobo → Super Admin (connection), Admin (surveys), M&E (review,
results). Survey results → own page. Reports → every workspace, each
limited to that person. Notifications log → Admin, Super Admin. Sync center →
everyone (own device), Admin and Super Admin (field team). The account
history panel → each account's View panel and the Audit log page.

**API.** Changed: every guard now checks effective permissions and scope;
`/me` adds workspace, scope, grants; `/users` adds last sign-in, scope and
grants; `/audit` adds `kind=security` and `actorId`; `/impact` serves the
learning side to `learning.dashboard.view`; Kobo connection routes need
`kobo.configure`, review routes `kobo.review`; reports need `reports.export`.
New: `/me/access`, `/nav/badges`, `/platform/overview`, `/admin/overview`,
`/teachers`, `/schools/:id/profile`, `/users/:id/access`,
`/users/:id/scope`, `/users/:id/grants`, `/users/:id/grants/:id/revoke`,
`/users/:id/history`, `/permissions`, `/security/activity`.

**Database.** New tables `staff_scopes`, `permission_grants` (RLS on, no
policies, no grants); backup schema `backup_20261004_rbac`. **RLS policies:**
none added or changed — every table stays deny-all, which is the strongest
setting; access is decided in the API, the only way in.

## 13. Not built, and open risks

- **Programme-level scope** (e.g. "M&E for Teach2030 only"): schools aren't
  linked to M&E programmes in the data, so scope is by county and school.
- **Menu items with no feature behind them** were left out rather than shown
  empty: Airtable / external integrations (there are none), Data recovery and
  Archive (archived records are restored where they live), My tasks, Support
  requests, Curriculum / learning programmes, Supporting evidence as its own
  list (evidence sits with each indicator result), Help & support.
- **The Nanyuki field officer** has no assigned schools until an
  administrator assigns them; until then they can't start a visit.
- **One active Super Admin** — the Platform overview flags it: if that account
  is lost, nobody can administer the portal.
- **Last sign-in** comes from Supabase Auth; learners' sign-ins are counted
  from their sessions (12-hour tokens), not kept as a history.
- **Grants take effect** on the person's next page load (their menu is built
  from `/me`); the API applies them at once.
