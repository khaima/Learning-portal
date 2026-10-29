# Navigation: audit and plan

**Date:** 7 October 2026. **Status:** done — all eight stages of
[§11](#11-implementation-plan) are released, with the decisions in
[§12](#12-decisions-taken-7-october-2026); [§14](#14-before-vs-after) is the
before and after. [`docs/RBAC.md`](RBAC.md) is the access model this builds on;
none of its server-side rules change here. **14 October:** [§15](#15-the-menus-14-october-2026)
— the sidebar lists each area's pages (the tabs are gone), one name per page
everywhere, a few pages regrouped, and a better phone menu.

The aim, in one line: **one function, one home.** A function may have several
contextual entry points (a button on a dashboard, a link on a school page),
but they all open the same module.

---

## 0. What exists already

The portal is further along than a typical rebuild starting point:

- **One navigation configuration.** [`navigation.js`](../navigation.js)
  (`WORKSPACES` → groups → items, and `PAGES` for the management console)
  builds every role's menu. No page hard-codes its own menu — `nav.js`
  generates it after sign-in from the person's permissions.
- **Route guards.** A page that isn't in the person's menu can't be opened:
  typing its address sends them to their own start page (`nav.js`, `show()`).
  Opening another role's workspace (`admin.html` as a field officer) sends
  them to their own (`auth.js`, `requireRole`).
- **Data-level authorization.** Every API route checks a permission and the
  person's data scope (county/schools); hiding a menu item is never the
  security (RBAC.md §9, "the five layers"). 356 tests hold this in place.
- **Routes** are `workspace.html#page?params` — 9 HTML pages (sign-in and 8
  workspaces), 35 console sections and 28 role-workspace sections.

So the gaps are not "add a config" or "add guards"; they are:

1. Items have no **id, order, parent, primary/contextual flag** — so there are
   no contextual (in-module) routes, no tabs, no breadcrumbs. Every
   destination has to be a sidebar item, which is why menus grew.
2. **Eight roles, not four.** The brief lists Super Admin, Admin, Education
   Team and Field Officer; the portal also has **M&E, School Head, Teacher and
   Learner**, with live users. They stay, and get the same treatment.
3. Some functions have **two implementations** (a field officer's schools list
   and the console's), and many have **several menu entries or names**.

---

## 1. Current navigation audit

### 1.1 Menus, as each role sees them today

Generated from `navigation.js` × `permissions.ts` (not from screenshots), so
these are exact.

| Role | Workspace | Entries | Groups | Menu |
|---|---|---|---|---|
| Super Admin | Platform Administration | **39** | 9 | Dashboard: Platform overview · Administration overview · M&E overview — System management: Users & roles · Schools & counties · Academic calendar · Classes & structure · Subjects — People & learning: Learners · Teachers · School profiles · Assignments & assessments · Results · Content library · Training register — Programme performance: Executive overview · Reach · Learning · Teacher development · Field operations · Digital resources — M&E and data: Results framework · Indicator results · M&E reports · Data quality · Survey results · Field visits — Integrations: KoboToolbox · Forms · Notifications log · Stuck devices · Sync center — Security: Permissions · Audit log · Security events · Account activity — Reports: System reports — Account: My profile · Notifications |
| Admin | Programme Administration | **24** | 7 | Dashboard: Administration overview — Organisation: Schools & counties · School profiles · Academic calendar · Classes — People: Staff accounts · Teachers · School heads · Learners · User approvals — Learning operations: Assignments & assessments · Results · Learning resources — Programme operations: Forms · Field visits · Kobo surveys · Survey results · Stuck devices · Sync center — Data: Data quality · Reports & exports — Account: My profile · Notifications · Notifications log |
| M&E | Monitoring & Evaluation | **26** | 8 | Dashboard: M&E overview — Programme performance: Executive overview · Reach · Learning outcomes · Teacher development · Digital resource usage · Field operations — Results framework: Programmes & indicators · Indicator results — Data quality: Data Quality Center · Kobo data quality — Evidence: Survey results · Field visits · Form responses — Programme data: Learners · Teachers · Classes · School profiles · Assignments & assessments · Results · Training register · Content usage — Reporting: M&E reports · Reports & exports — Account: My profile · Notifications |
| Education Team | Learning & Education | **18** | 7 | Dashboard: Learning overview — Learning: Learners · Teachers · Classes · Assignments & assessments · Results — Content & curriculum: Content library · Content usage · Subjects — Teacher development: Teacher development · Training register — Field support: School support · Field visits · Education forms · Stuck devices — Reports: Learning reports — Account: My profile · Notifications |
| Field Officer | Field Operations | **11** | 6 | Dashboard: My dashboard — My work: My schools · My visits · Visit forms · Kobo surveys — Schools: School profiles — Learning support: Teachers — Reports: My activity — Account: My profile · Notifications · Sync center |
| School Head | School Management | 9 | 5 | Dashboard: School overview — My school: School profile · Teachers · Learners & classes — Learning: Assignments & results · Learning resources — Reports: School reports — Account: My profile · Notifications |
| Teacher | Teaching & Learning | 9 | 5 | Dashboard: My teaching — My teaching: My classes · Class roster · Assignments & assessments · Results & progress — Content: Learning resources — Activity: My activity — Account: My profile · Notifications |
| Learner | My Learning | 8 | 4 | Dashboard: My learning — My learning: My classes · My assignments · My progress · My activity — Library: Learning library — Account: My profile · Notifications |

### 1.2 Pages and routes

| Where | Sections (routes `#…`) |
|---|---|
| Management console — `platform.html`, `admin.html`, `me.html`, `education.html` share [`workspace.html`](../workspace.html) | `platform-overview` `admin-overview` `me-dashboard` `overview` `reach` `learning` `teacher-development` `field-operations` `digital-resources` `mel-framework` `mel-results` `mel-reports` `data-quality` `schools` `calendar` `classes` `subjects` `users` `learners` `teachers` `school-profiles` `assignments` `results` `content` `training` `forms` `field-visits` `kobo` `survey-results` `reports` `notifications` `sync-problems` `permissions` `audit` `account-activity` (35) |
| `field.html` | `dashboard` `schools` `visits` `forms` `kobo-surveys` `school-profiles` `teachers` `activity` |
| `leader.html` | `overview` `school-profile` `teachers` `learners` `learning` `resources` `reports` |
| `teacher.html` | `home` `my-classes` `my-learners` `assignments` `results` `resources` `activity` |
| `learner.html` | `home` `my-learning` `assignments` `my-progress` `resources` `activity` |
| every workspace | `profile` (added by `nav.js`); panels: Sync center (top-bar chip), Notifications (bell), Export center |

### 1.3 Dashboards

| Dashboard | What's on it | Verdict |
|---|---|---|
| Super Admin | **4 dashboards in the menu** (Platform, Administration, M&E, Executive) + 5 more programme dashboards | Too many entry points; the other workspaces' dashboards belong in those workspaces |
| Admin — Administration overview | 6 tiles that link to their pages, a "Needs attention" list with Open links | Good pattern — keep (28 October 2026: Dashboard has two tabs, Overview and In detail — DASHBOARD-HIERARCHY.md) |
| Field Officer — My dashboard | 3 tiles (none clickable): "Schools in *county*", "Visits this term", "**Counties** in the programme"; the whole visit workflow; "Recent visits" | Tiles aren't actionable, one is irrelevant to the role, and "Schools in *county*" counts the profile's county although officers are now assigned *schools* (RBAC §4). The visit workflow belongs to Visits |
| School Head, Teacher, Learner | Panels with "View all" links to their pages | Good pattern — keep |

### 1.4 The same thing in two places on every page

| Thing | Places |
|---|---|
| Notifications | the bell in the top bar **and** Account › Notifications |
| Sync center | the sync chip in the top bar **and** a menu item (Super Admin, Admin, Field Officer) |
| Sign out | a top-bar button **and** the account menu under the name |
| My profile | Account › My profile (the name block, which looks like the way in, only offers Sign out) |

### 1.5 Dead links, loops and misleading pages

| # | Where | Problem |
|---|---|---|
| 1 | Sync center → "Connect KoboToolbox on **Kobo Surveys**" (`sync-ui.js`) | Links to `education.html#kobo`. Since RBAC the Kobo page isn't in the Education workspace: a Super Admin is bounced back with "That page isn't part of your workspace"; an Admin is redirected through it. The text says "ask the Education Team" — connecting Kobo is the Super Admin's job now |
| 2 | Field Officer › My visits → "+ Start a visit" | Goes back to the dashboard (the workflow lives there) — a loop between two pages showing the same "Recent visits" list |
| 3 | Field Officer › My schools | A list with no actions: you can't open a school or start a visit from it. The profile is a separate page with its own school dropdown |
| 4 | Field Officer dashboard tiles | Not links; see 1.3 |
| 5 | Field Officer › "My activity" | Is the **export** page; for a teacher or learner "My activity" is their **reading** activity — same label, different things |
| 6 | Teacher › Assignments | Also holds "Forms from the Education Team" — unrelated to assignments |
| 7 | Dashboard links to M&E pages (`#me-dashboard`, `#mel-framework`) inside shared dashboards | Shown only with M&E data, so they shouldn't reach roles without `me.view` — to be confirmed in the role tests (stage 8) |

No empty pages: the last full crawl (6 Oct, all 8 roles, 135 menu pages)
rendered every page without errors.

### 1.6 Confusing labels — one page, many names (and one name, many pages)

| Page | Names it has today |
|---|---|
| `users` | Users & roles / Staff accounts / School heads / User approvals |
| `kobo` | KoboToolbox / Kobo surveys / **Kobo data quality** |
| export center (`reports`, field `activity`, leader `reports`) | System reports / Reports & exports / Learning reports / School reports / **My activity** |
| `learning` (console) | Learning / Learning outcomes / Learning overview |
| `content` | Content library / **Learning resources** / **Content usage** |
| `digital-resources` | Digital resources / Digital resource usage / **Content usage** |
| `school-profiles` | School profiles / School support |
| `forms` | Forms / Education forms / Form responses (and the field officer's "Visit forms") |
| `audit` | Audit log / Security events |
| `mel-framework` | Results framework / Programmes & indicators |

The other way round: **"Learning resources"** is the Admin's library
*management* page and a teacher's or head's *reading* page; **"Content usage"**
is a dashboard for the Education Team and the library page for M&E.

### 1.7 Who sees what, against the brief

| Brief says | Today | Finding |
|---|---|---|
| Super Admin has system controls others don't | Permissions, Audit log, Account activity, Kobo *connection* are Super Admin only | ✓ already |
| Admin: operations, no technical controls | Admin has **Kobo surveys incl. field mapping** (`kobo.manage`), the Sync center's all-devices view, the Notifications log | Field mapping is technical — **decision 1** |
| Education Team: learning only; no Kobo, users, settings | No users, Kobo, security or settings | ✓ already (Stuck devices was added on request, 7 Oct) |
| Field Officer: small, task-focused | 11 entries, two Schools pages, two visit lists, two forms/survey pages | Too many, duplicated |
| Airtable | **No Airtable integration exists** (README: "fed from the portal", not built) | Not added to any menu until it exists |
| System Settings | No settings page exists (settings live in Supabase and `scripts/configure-auth.mjs`) | Not invented; "System health" (the Platform overview's checks) stands in |

---

## 2. Duplicate-function audit

A = remove the duplicate entry · B = make it a contextual link/action ·
C = make it a filtered view of the same module · D = keep, genuinely different.

| Function | Where it is today | Verdict | One home |
|---|---|---|---|
| **Schools list** | console `schools` (Schools & counties) · field `schools` (My schools — a second implementation) | C — the field list becomes the same module, filtered to assigned schools | **Schools** |
| **School profile** | console `school-profiles` (dropdown) · field `school-profiles` (dropdown) · leader `school-profile` · admin-overview links | B — opened from a row in Schools (`#schools?school=…`); one renderer (`renderSchoolProfile` is already shared) | Schools › *school* › Overview |
| **Classes** | console `classes` (own school dropdown) · leader "Learners & classes" | B/C — a tab of the school page; a cross-school view in Schools | Schools › *school* › Learners & classes |
| **Teachers** | console `teachers` · field `teachers` (same renderer) · leader `teachers` (own implementation) · `users?role=school_leader` (School heads) · school profile tile | C — "All teachers" view in Schools; per school a tab; School heads is a filter of it | Schools › Teachers / *school* › Teachers |
| **Learners** | console `learners` (finder) · leader "Learners & classes" · teacher "Class roster" | C for staff (Schools › Learners); D for the teacher's roster (it's where they *manage* their own class) | Schools › Learners; Teacher › My classes |
| **Visits** | field dashboard "Recent visits" + field `visits` (same list twice) · console `field-visits` · school profile "Recent visits" · leader overview + leader `reports` "Field visits" | A for the second field list; C for `field-visits` (everyone's, read-only) ; B on the school page | **Visits** (Field Officer: My visits) |
| **Start a visit** | only the field dashboard (county → school → type) | B — one workflow, opened from Dashboard, My schools, a school page; the school is pre-filled | Visits › Start visit |
| **Surveys** | field `kobo-surveys` (fill) · console `kobo` (connect/attach/map/review in one page) · `survey-results` · Kobo cards on Field operations | D for the two *systems* (Kobo is an outside tool, Forms are the portal's) — but **one place to find them** (decision 3); Kobo *setup* and *review* move to their technical homes | **Surveys & forms** |
| **Forms** | console `forms` (build) · field `forms` (Visit forms) · forms inside a visit · "finish the visit's forms" panel · leader overview panel · teacher Assignments panel | C — "To fill" for those who fill, "Build" / "Responses" for those who manage | Surveys & forms |
| **Reports / exports** | one module already (`reports-ui.js`), mounted 4 times under 5 names | A for the extra names; one entry "Reports" everywhere | **Reports** |
| **Programme dashboards** | 6 dashboards in Super Admin's and M&E's menus | B — tabs of Reports & analytics | Reports › Dashboards |
| **M&E reports** | `mel-reports` beside `reports` | D (narrative indicator reports, not exports) — a tab of Reports | Reports › M&E reports |
| **Content usage** | `content`'s usage report · `digital-resources` dashboard | C — one usage view (the dashboard) with the library page linking to it | Content & resources › Usage |
| **Users** | `users` ×3 entries (Admin), Users & roles (Super Admin) | C — tabs/filters inside one Users page (Approvals keeps its badge) | **Users** |
| **Permissions / grants** | `permissions` page; grants inside a user's View panel | D — keep both (overview vs one person), under Users & roles | Users & roles › Permissions |
| **Audit** | Audit log + Security events (same page, two entries) | C | Audit & security |
| **Data quality** | `data-quality`; Kobo review inside `kobo` | D — keep; Kobo's review queue moves next to it | **Data quality** |
| **Sync monitoring** | Sync center (chip + menu item), Stuck devices page, Platform overview "Field devices" | B/C — the chip opens the device's own sync; the all-devices view and Stuck devices become one Sync monitor | Data & integrations › Sync monitor (Education Team: Schools › Devices) |
| **Notifications** | bell + Account item; Notifications log page | A for the menu item (bell stays); the log moves under Users & roles / Users | — |
| **Dashboards of other workspaces in Super Admin's menu** | Administration overview, M&E overview in Platform | A — reached by switching workspace (decision 2) | their own workspace |

---

## 3. Recommended information architecture

**Modules** (each the one home of its function), and the contextual tabs inside them:

| Module | Inside it (tabs / views — not sidebar items) |
|---|---|
| **Home** (per role) | numbers that matter, tasks waiting, alerts, recent activity, the 2–3 most common actions — never a copy of the menu |
| **Schools** | views: Schools · Teachers · Learners · Classes · Devices (· Set up: counties, schools, calendar, subjects — `schools.manage`) → a school: **Overview · Teachers · Learners & classes · Visits · Assessments · Surveys · Devices · Reports**, with [Start visit] for field officers |
| **Visits** | My visits / all visits in scope · drafts on this device · **Start visit** (one workflow) · finish missing forms |
| **Surveys & forms** | To fill (Kobo surveys + portal forms) · Build (forms) · Responses & survey results |
| **Learning** (Education) | Assessments · Results · Activities (training register, teacher development) |
| **Content & resources** | Library (manage or read) · Usage · Subjects |
| **Reports** | Exports (every role, filtered by the API) · Dashboards (Executive, Reach, Learning, Teacher development, Field operations, Digital resources) · M&E reports |
| **M&E** | Results framework · Indicator results · M&E overview |
| **Data quality** | Issues · checks · history · Kobo review queue and school-name matches |
| **Users** | Staff accounts · Approvals · Permissions & grants · Account activity · Notifications sent |
| **Data & integrations** (Super Admin) | Kobo (connection, surveys, field mapping, live push) · Sync monitor (all devices, stuck devices) · System health (the checks on the Platform overview, uptime) |
| **Audit & security** (Super Admin) | Audit log (Security events = a filter) · Account activity |
| **Account** (everyone, under the name — not in the sidebar) | My profile · Notifications (also the bell) · Sync center (also the chip) · Sign out |

Every page shows **where you are** (active menu item + a breadcrumb such as
*Schools › Aitong Primary › Teachers*), **what you can do** (actions in the
page head) and **how to go back** (the breadcrumb, and the browser's Back —
routes are bookmarkable hashes).

---

## 4. Role / menu matrix (proposed)

| Role | Proposed sidebar | Entries |
|---|---|---|
| **Super Admin** | Overview · Users & roles · Organisation setup · Data & integrations · Reports & analytics · Audit & security — plus **Switch workspace** (Programme Administration · M&E · Learning & Education) | 39 → **6** |
| **Admin** | Dashboard · Schools · Field operations (Visits, Surveys & forms) · Education programmes (Assessments, Content) · Data quality · Reports · Users | 24 → **7** |
| **M&E** | M&E overview · Results framework · Reports & analytics · Data quality · Schools · Surveys & forms | 26 → **6** |
| **Education Team** | Dashboard · Schools & learning · Activities · Assessments · Content & resources · Education reports | 18 → **6** |
| **Field Officer** | Dashboard · My schools · My visits · Field surveys · Reports | 11 → **5** |
| **School Head** | Dashboard · My school · Learning resources · Reports | 9 → **4** |
| **Teacher** | Dashboard · My classes · Assessments · Results · Learning resources · Reports | 9 → **6** |
| **Learner** | Home · My classes · My assignments · My progress · Library | 8 → **5** |

Account actions (profile, notifications, sync, sign out) leave the sidebar
for the menu under the person's name, so they no longer count above.

**Field Officer, step by step** (the brief's workflow): Dashboard → My schools
→ *school* → **Start visit** → visit type (school already chosen) → forms →
saved on the device as it goes → Submit (sent now, or when back online) →
the visit appears in My visits and on the school's Visits tab. The brief's
separate "School Profiles" and "Teachers" items become the school page and
its Teachers tab — keeping them as menu items would contradict the brief's
own rule against a "My Schools" + "School Profiles" pair.

---

## 5. Permission matrix

Generated from [`permissions.ts`](../supabase/functions/api/permissions.ts)
— what the API enforces today; **this proposal changes no permission** except
where [§12](#12-decisions-taken-7-october-2026) decided.

| Feature | Super Admin | Admin | Education Team | Field Officer | M&E | School Head | Teacher | Learner |
|---|---|---|---|---|---|---|---|---|
| Users | FULL | FULL | NONE | NONE | NONE | NONE | NONE | NONE |
| Schools | FULL | FULL | VIEW (scoped) | VIEW (assigned) | VIEW (scoped) | VIEW (own) | NONE | NONE |
| Teachers | VIEW | VIEW (scoped) | VIEW (scoped) | VIEW (assigned) | VIEW (scoped) | VIEW (own) | NONE | NONE |
| Learners | FULL | FULL | VIEW (scoped) | NONE | VIEW (scoped) | CREATE/EDIT (own school) | CREATE/EDIT (own classes) | NONE |
| Visits | VIEW | VIEW (scoped) | VIEW (scoped) | CREATE/EDIT (own) | VIEW (scoped) | NONE | NONE | NONE |
| Surveys (Kobo) | FULL (connect, attach, map) | SYNC + results | NONE | FILL | REVIEW | NONE | NONE | NONE |
| Forms | CREATE/EDIT | CREATE/EDIT | CREATE/EDIT | FILL | VIEW responses | FILL | FILL | NONE |
| Assessments | VIEW | VIEW (scoped) | VIEW (scoped) | NONE | VIEW (scoped) | VIEW (own school) | CREATE/EDIT (own classes) | DO (own) |
| Education activities (training) | CREATE/EDIT | NONE | CREATE/EDIT | NONE | NONE | NONE | NONE | NONE |
| Learning resources | FULL | VIEW + usage | FULL | NONE | VIEW + usage | VIEW | VIEW | VIEW |
| Programme dashboards | FULL | NONE | Learning side | NONE | FULL | Own school | NONE | NONE |
| M&E framework / results | FULL | NONE | NONE | NONE | FULL | NONE | NONE | NONE |
| Reports / exports | Programme | Programme | Scoped | Own | Programme | Own school | Own classes | NONE |
| Field mapping (Kobo) | EDIT | NONE (decision 1) | NONE | NONE | NONE | NONE | NONE | NONE |
| Validation (data quality) | FULL | FULL | NONE | NONE | FULL | NONE | NONE | NONE |
| Sync monitor | All devices | All devices | Stuck devices | Own device | Own device | Own device | Own device | Own device |
| Audit logs | VIEW | NONE | NONE | NONE | NONE | NONE | NONE | NONE |
| System (permissions, health) | FULL | NONE | NONE | NONE | NONE | NONE | NONE | NONE |
| Airtable / system settings | — not built — |

**The brief's permission names**, against the ones the API already enforces
(renaming them would break grants and tests for no gain):

| Brief | Portal |
|---|---|
| `users.view/create/edit/delete` | `users.view`, `users.invite`, `users.approve`, `users.edit`, `users.roles.assign`, `users.status.manage` (accounts are deactivated, never deleted) |
| `schools.view/create/edit` | `schools.profile.view`, `schools.manage` |
| `visits.view/create/edit/submit` | `field_reports.view.all`, `field_reports.view.own`, `field_reports.create` |
| `surveys.view/create/submit` | `kobo.results.view`, `kobo.manage`, `kobo.surveys.fill`, `forms.manage`, `forms.respond`, `forms.responses.view` |
| `reports.view/export` | `reports.export`, `reports.programme`, `intelligence.view`, `learning.dashboard.view` |
| `integrations.view/manage` | `kobo.configure`, `kobo.manage`, `sync.monitor` |
| `system.settings`, `system.audit` | `platform.view`, `permissions.manage`, `audit.view` |

---

## 6. Proposed route structure

Routes stay hash routes on the same 9 pages. **Every old address keeps
working** — it's an alias that lands on the new home (`navigation.js`
already supports per-workspace `aliases`).

| New route | What it opens | Old routes that land here |
|---|---|---|
| `#schools` | the Schools list (scoped by role) | field `#schools` |
| `#schools?view=teachers\|learners\|classes\|devices\|setup` | cross-school views | `#teachers` `#learners` `#classes` `#sync-problems` (Education Team) `#calendar` `#subjects` |
| `#schools?school=<id>&tab=overview\|teachers\|learners\|visits\|assessments\|surveys\|devices\|reports` | one school | `#school-profiles?school=…` · field `#school-profiles` · leader `#school-profile` |
| `#visits` · `#visits?start=<schoolId>` · `#visits?finish=<visitId>` | visits; the visit workflow | field `#visits` · console `#field-visits` · field `#dashboard` "Start" |
| `#surveys?tab=fill\|build\|results` | Surveys & forms | `#forms` · field `#kobo-surveys` · field `#forms` · `#survey-results` |
| `#reports?tab=exports\|dashboards\|me` and `#reports?tab=dashboards&d=reach…` | Reports | `#reports` · field/teacher `#activity` (exports) · leader `#reports` · `#overview` `#reach` `#learning` `#teacher-development` `#field-operations` `#digital-resources` `#mel-reports` |
| `#users?tab=accounts\|approvals\|permissions\|activity\|notifications` | Users | `#users?status=pending` · `#permissions` · `#account-activity` · `#notifications` |
| `#integrations?tab=kobo\|sync\|health` | Data & integrations | `#kobo` · `#sync-problems` (Super Admin, Admin) · `#platform-overview` health |
| `#audit` · `#audit?kind=security` | Audit & security | unchanged |

---

## 7. Proposed navigation configuration

`navigation.js` stays the single source; each item gains the fields the brief
lists. Routes, roles and permissions come from one place:

```js
// One entry per destination. `parent` makes it contextual: a tab inside
// its module, allowed and highlighted through the parent, never a sidebar row.
export const NAV = [
  { id: "schools", label: "Schools", icon: "school", route: "#schools", order: 20, primary: true,
    needs: ["schools.profile.view", "schools.manage", "school.overview.view"],
    labelFor: { field_officer: "My schools", school_leader: "My school" } },
  { id: "schools.teachers", parent: "schools", label: "Teachers", route: "#schools?view=teachers", contextual: true, needs: ["teachers.view"] },
  { id: "school.visits", parent: "schools", label: "Visits", route: "#schools?school=:id&tab=visits", contextual: true,
    needs: ["field_reports.view.all", "field_reports.create"] },
  { id: "visits", label: "Visits", icon: "pin", route: "#visits", order: 30, primary: true,
    needs: ["field_reports.create", "field_reports.view.all"], labelFor: { field_officer: "My visits" } },
  { id: "visits.start", parent: "visits", label: "Start visit", route: "#visits?start", action: true, needs: ["field_reports.create"] },
  { id: "integrations", label: "Data & integrations", route: "#integrations", order: 60, primary: true,
    needs: ["kobo.configure"], workspaces: ["platform"] },
  // …
];
// Which items a workspace shows, in which order — the menu is derived, never hand-listed per page.
export const WORKSPACES = {
  field: { title: "Field Operations", page: "field.html", roles: ["field_officer"],
    menu: ["home", "schools", "visits", "surveys", "reports"] },
  // …
};
```

`nav.js` builds the sidebar from `primary` items, the tab strip and the
breadcrumb from `parent`, and the route guard from everything the person's
permissions allow — so a contextual page can't be opened without its
permission even by typing the address. `navigation_test.ts` keeps asserting
that each role's reachable pages are exactly what its permissions open.

---

## 8. To merge

| Merge | Into |
|---|---|
| Field `schools` + field `school-profiles` + console `school-profiles` + leader `school-profile` | Schools (list → school page) |
| Field `teachers` + console `teachers` + leader `teachers` + Admin's "School heads" | Schools › Teachers (all) / school › Teachers |
| Console `classes` + console `learners` + leader "Learners & classes" | Schools › Learners / Classes; school › Learners & classes |
| Field dashboard's visit workflow + field `visits` + console `field-visits` | Visits |
| Field `forms` + field `kobo-surveys` (+ leader/teacher forms panels) | Surveys & forms › To fill |
| Console `forms` + `survey-results` | Surveys & forms › Build / Results |
| All export centres + programme dashboards + `mel-reports` | Reports |
| `users` ×3 + `permissions` + `account-activity` + `notifications` (log) | Users (Super Admin: Users & roles) |
| Sync center's all-devices view + `sync-problems` | Sync monitor |
| `content` usage report + `digital-resources` | Content & resources › Usage |

## 9. To move

| What | From | To |
|---|---|---|
| Kobo connection, attached surveys, field mapping, live push | `kobo` (one page for three roles) | Data & integrations › Kobo (Super Admin; Admin per decision 1) |
| Kobo review queue, school-name matches | `kobo` | Data quality (M&E, Admin) |
| Notifications log | Admin's Account group / Super Admin's Integrations | Users › Notifications sent |
| Forms panel | Teacher › Assignments | Teacher dashboard ("Forms to fill") → Surveys & forms |
| Account items (profile, notifications, sync, sign out) | sidebar "Account" group + top-bar button | the menu under the person's name; the bell and the sync chip stay |
| Administration overview, M&E overview | Super Admin's Platform menu | their own workspaces, reached by Switch workspace |
| Kobo link in the Sync center | `education.html#kobo` | the Kobo page in the person's own workspace (dead link #1) |

## 10. To remove

Only **duplicate entries and labels** — no working function is removed:

- Duplicate sidebar rows: School heads, User approvals (→ Users filters/tabs), Security events (→ Audit filter), the second "Recent visits" list, the second "Start a visit" route.
- The extra names listed in §1.6 — one label per module, everywhere.
- The Field Officer's "Counties" tile, and dashboard tiles that don't open anything.
- The top-bar Sign out button (the account menu keeps it).

---

## 11. Implementation plan

Small stages, each one tested (API suite, the browser harness for the
affected roles, lint/build/CSP/size) and released through `staging` before
the next starts. Old addresses keep working at every stage.

| Stage | What | Proves |
|---|---|---|
| 1 | **Navigation core**: item `id/parent/order/primary/contextual`, tab strip + breadcrumbs from `parent`, contextual pages in the route guard, aliases; account actions under the name; fix dead link #1 | Every role reaches exactly what it did before; `navigation_test` updated |
| 2 | **Schools module**: one list (role-filtered) → school page with tabs; field officers' and heads' Schools use it | Field `schools`/`school-profiles` and leader `school-profile` retired into it |
| 3 | **Visits**: the workflow moves into Visits; Start visit from Dashboard / My schools / school page, school pre-filled; one list | The field officer's step-by-step flow, offline included |
| 4 | **Surveys & forms**: one "To fill" list (Kobo + forms), Build, Results; Kobo setup → Data & integrations, review → Data quality | No form or survey reachable twice |
| 5 | **Reports & analytics**: one Reports entry per role, tabs for exports / dashboards / M&E reports | Old dashboard addresses land on the right tab |
| 6 | **Users, Data & integrations, Audit & security**; Super Admin's Switch workspace | Super Admin menu at 6 entries; Admin without technical controls (per decision 1) |
| 7 | **Smart dashboards**: Field Officer (assigned schools, visits due, drafts on this device, submitted this week, sync status; Start visit / Resume draft / My schools), and the others' tiles all clickable | No tile without a destination |
| 8 | **All 8 roles tested** in the browser harness: dashboard, sidebar, every route (allowed and refused by typing it), data visibility, no duplicates, no broken links; the **Before vs After** table added here | |

---

## 12. Decisions (taken 7 October 2026)

1. **Admin and Kobo:** Admin keeps **syncing surveys and their results**;
   attaching surveys and field mapping move to Super Admin
   (`kobo.manage` splits — stage 4).
2. **Super Admin:** a **6-item system menu with Switch workspace** for the
   operational areas. Every right is unchanged.
3. **Surveys:** Kobo surveys and the portal's forms together under **Surveys &
   forms**; the two systems stay as they are underneath.
4. **Pace:** each stage is released as it passes its tests, then the next
   starts; the Before vs After table comes at the end.

---

## 13. Progress

**Stage 1 — navigation core (released 7 Oct 2026).**
- `navigation.js`: every workspace is a short list of entries; an entry with
  several items is a module whose items are tabs. Account items left the
  sidebar.
- `nav.js`: one sidebar row per entry, the module's tabs and a breadcrumb
  (*Workspace › Module › Tab*) above the page, **Switch workspace** for
  someone who may open more than one (a Super Admin), and My profile,
  Notifications and the Sync center in the menu under the person's name.
- Removed the second Sign out button from every top bar.
- The teacher's exports have their own Reports page.
- Dead link #1 is fixed: Kobo's connection link goes to Platform → Data &
  integrations → Kobo, and the text names the Super Admin and M&E.
- Menus: Super Admin 39 → 6, Admin 24 → 7, M&E 26 → 6, Education Team
  18 → 6, Field Officer 11 → 5, School Head 9 → 4, Teacher 9 → 6, Learner
  8 → 5. Every page each role could open before, it still can, and through
  one entry only.
- `navigation_test.ts` holds these rules.
- Checked in the browser for all 8 roles: every row and tab, typed addresses
  of other roles' pages refused, old links (`#reports`, `#users?role=…`)
  still working, the phone drawer.

**Stage 2 — one Schools module (released 7 Oct 2026).**
- `admin-ui.js` `renderSchoolsModule`: the list of the schools a person may
  see (the API scopes it), searchable and grouped by county, then one page
  per school with tabs: **Overview · Teachers · Learners & classes · Visits ·
  Assessments · Devices**. Each tab appears only with the permission its
  data needs; the breadcrumb goes down to *Schools › school › tab*.
- The console's Schools (`#school-profiles`, now the list, then
  `?school=<id>&tab=<tab>`) and a field officer's **My schools**
  (`field.html#schools`) are this one module.
- The field officer's separate School profiles page and its dropdown are
  gone. `#school-profiles` there now lands on `#schools`.
- In the Schools menus, the cross-school views are named **All teachers** and
  **Find a learner**. The per-school **Classes** picker is a hidden item: old
  links open it, but a school's classes are on its page.
- The school head's **My school** already was one school with tabs, and keeps
  its management pages.

**Stage 3 — one Visits workflow (released 7 Oct 2026).**
- The field officer's visit workflow moved from the dashboard to **My
  visits**, the one place a visit is started, filled in, saved on the device
  and submitted. The history is under it.
- **Start visit** is a link, `#visits?start=<school>`. The dashboard, every
  row of My schools and every school's page open the same workflow, with the
  school already chosen. It won't start on top of a visit already under way.
- The field officer's dashboard became a summary with actions:
  - tiles that open what they count: My schools, Visits this term (and this
    week), Forms to finish, Waiting to sync;
  - Start school visit, My schools, and Resume for an unfinished visit on
    the device;
  - only the visits whose forms still need finishing.

  The second "Recent visits" list, the irrelevant "Counties" tile, and the
  loop from My visits back to the dashboard are gone.
- Everyone else sees visits in the read-only Visits views and on each
  school's Visits tab: the same visits, from the same API.

**Stage 4 — Kobo split, Surveys & forms (released 7 Oct 2026).**
- Decision 1 is in place. `kobo.manage` (attach and remove surveys, map their
  fields) is now the **Super Admin's** alone. A new `kobo.sync` (sync the
  attached surveys, re-check their data) is what **Admin** holds, beside
  survey results and review.
  - On the Kobo page an Admin sees Sync and the data pipeline, without the
    attach form, archive or field mapping. The API refuses those too.
  - `authz_test` and `scope_test` hold it.
- Accepting or excluding a flagged Kobo submission from the Data Quality
  Center follows `kobo.review`, the permission the review itself uses.
- One place per role for surveys:
  - Field Officer: **Field surveys** (Kobo surveys and forms to fill);
  - Admin: Field operations › Forms, Kobo surveys, Survey results;
  - M&E: **Surveys & forms** (results, responses), and Data quality › Kobo
    review;
  - Education Team: Activities › Education forms;
  - Super Admin: Data & integrations › Kobo and Form registry.

**Stage 5 — one Reports home (released 7 Oct 2026).**
- Every role has exactly one reports entry:
  - **Reports & analytics** for Super Admin and M&E (exports, the programme
    dashboards and M&E reports as tabs);
  - **Reports** for Admin, Field Officer, School Head and Teacher;
  - **Education reports** for the Education Team.

  The same export centre (`reports-ui.js`) sits behind each, filtered by
  the API to what that person may export.
- The school head's field visits moved out of Reports into **My school ›
  Visits**, where a school's visits belong; the dashboard's "View all" opens
  it.
- Clearer names: the Education Team's usage tab is **Usage dashboard**, next
  to the library's own per-item usage report. M&E's library tab is **Content
  usage**.

**Stages 6 and 7 — Users, Data & integrations, Audit & security; dashboards
(released 7 Oct 2026).**
- **One Sync monitor.** The all-devices table moved out of the Sync center
  into the Sync monitor page, beside the stuck devices and the week's sync
  failures:
  - Super Admin: Data & integrations › Sync monitor;
  - Admin: Field operations › Sync monitor;
  - Education Team: Schools & learning › Devices, stuck devices only.

  The Sync center is now about the person's own device, with a link to the
  Sync monitor for those who may see it.
- Users (Accounts, Approvals, Permissions & grants, Notifications sent),
  Data & integrations (Kobo, Form registry, Validation, Sync monitor), and
  Audit & security (Audit log, Security events, Account activity) are the
  modules from stage 1, now with their final contents.
- **Dashboards:** every tile opens what it counts. The field officer's was
  rebuilt in stage 3. Super Admin's "Learners enrolled" now opens the
  learners page, in Programme Administration. Admin's tiles and "Needs
  attention" list, and the school head, teacher and learner dashboards'
  "View all" links already did.

**Stage 8 — all roles checked (7 Oct 2026).** In the browser, as each of
the 8 roles: every sidebar row and every tab (111 pages in all) opens the
right page, with the right row highlighted and no errors. Other roles'
addresses typed in are refused. Old addresses still land somewhere sensible
(`#school-profiles`, `#reports`, `#classes`, `#users?role=…`). On a phone,
the drawer works and the tabs scroll on their own, never the page.
`navigation_test.ts` holds the rules on every push.

---

## 14. Before vs after

### The menus

| Role | Before | After | What changed, and why |
|---|---|---|---|
| Super Admin | 39 entries, 9 groups: every page of every workspace, 4 dashboards | **6**: Overview · Users & roles · Organisation setup · Data & integrations · Reports & analytics · Audit & security, plus **Switch workspace** | System controls only. The operational areas are entered on purpose; every right is kept |
| Admin | 24 entries, 7 groups (Users ×3) | **7**: Dashboard · Schools · Field operations · Education programmes · Data quality · Reports · Users | One row per module. Accounts, Approvals and Notifications sent are tabs of Users |
| M&E | 26 entries, 8 groups | **6**: M&E overview · Results framework · Reports & analytics · Data quality · Schools · Surveys & forms | Six programme dashboards became tabs of Reports & analytics |
| Education Team | 18 entries, 7 groups | **6**: Dashboard · Schools & learning · Activities · Assessments · Content & resources · Education reports | The brief's five areas plus the dashboard; still no Kobo, users or settings |
| Field Officer | 11 entries, 6 groups | **5**: Dashboard · My schools · My visits · Field surveys · Reports | Task-focused; School profiles and Teachers live inside My schools |
| School Head | 9 | **4**: Dashboard · My school · Learning resources · Reports | The school's visits moved from Reports to My school |
| Teacher | 9 | **6**: Dashboard · My classes · Assessments · Results · Learning resources · Reports | Exports have their own Reports entry, out of Results |
| Learner | 8 | **5**: Home · My classes · My assignments · My progress · Library | "My activity" became "Reading activity", under My progress |
| Everyone | Account group: My profile, Notifications (± Sync center) + a Sign out button in the top bar | Under the person's name: My profile · Notifications · Sync center · Sign out (the bell and the sync chip stay) | One place for account things, not two |

### The functions

| Function | Before | After (one home) | Why |
|---|---|---|---|
| Schools | Console Schools & counties, School profiles (dropdown), Classes (dropdown); field My schools (no actions) and School profiles (another dropdown); head's School profile | **Schools**: one list, then one page per school with Overview · Teachers · Learners & classes · Visits · Assessments · Devices. The same module for a field officer (My schools) | The brief's "one Schools module", role-filtered by the API |
| Teachers | Teachers page, field Teachers, head's Teachers, "School heads" users filter | **All teachers** in Schools, and each school's Teachers tab | Same data, one directory |
| Visits | The workflow on the field dashboard, "Recent visits" twice, My visits looping back to the dashboard; console Field visits; head's Reports | **My visits** (the workflow and the history); Start visit from Dashboard, My schools and a school page, school pre-filled; Visits tab on every school | One workflow, many entry points |
| Surveys | Kobo page doing connection, attach, mapping, sync and review for three roles; field Kobo surveys and Visit forms apart | Super Admin: Data & integrations › Kobo (connect, attach, map); Admin: Field operations › Kobo surveys (sync, results); M&E: Data quality › Kobo review; field officer: **Field surveys** (Kobo and forms) | Decisions 1 and 3; Kobo setup is system configuration |
| Reports | One export centre under five names, in four places | One entry per role (**Reports**, **Education reports**, or **Reports & analytics** with dashboards and M&E reports as tabs) | Same module, filtered per person by the API |
| Users | `users` three times in Admin's menu | **Users**: Accounts · Approvals · Notifications sent (Super Admin adds Permissions & grants) | Filtered views are tabs, not rows |
| Sync monitoring | Sync center (chip and menu items) with the all-devices table inside, plus a Stuck devices page | Sync center = this device; **Sync monitor** = stuck devices, every device, the week's failures | One page for everyone's devices |
| Audit | Audit log and Security events as two rows | **Audit & security**: Audit log · Security events · Account activity | Security events is a filter of the log |
| Dashboards | Field officer: 3 tiles, none clickable, one about counties | Every tile opens what it counts; the field officer's shows assigned schools, visits this term and this week, forms to finish and waiting to sync, with Start school visit, Resume and My schools | Dashboards lead to work, they don't copy the menu |

### Still the same

The API's permission checks and data scope, every page's own functions,
offline work and sync, Kobo ingestion, and every role's data. One permission
changed: `kobo.manage` (decision 1, with the new `kobo.sync` for Admin).

### Left as found, on purpose

- The school head's Teachers and Learners & classes pages: they *manage*
  their own school (roster, classes, past learners), which the read-only
  school page doesn't do.
- The teacher's Class roster: where a teacher manages their own learners.
- Kobo surveys and the portal's forms: two systems underneath (decision 3),
  found in one place.
- No Airtable or System Settings page: neither exists in the portal.

---

## 15. The menus, 14 October 2026

A second pass, on how the menus read and work rather than on what is in
them. Every page and every permission is as it was; nothing was removed.

### What was wrong

- **Tabs that didn't fit.** An area's other pages were tabs above the page.
  Dashboards & reports had nine: on a laptop the last ones were cut off, and
  on a phone they were a strip you had to swipe sideways without knowing
  there was more.
- **The sidebar showed only the areas.** What was inside an area could be
  seen only by opening it, and in the phone drawer not at all.
- **The same page under different names.** The device sync page was "Sync
  monitor", "Devices" and "Stuck devices"; Data quality was "Validation" in
  one workspace; the M&E learning dashboard was "Learning outcomes" in one
  menu and "Learning" in another.
- **Things in unrelated places.** For M&E, assignments, results, visits and
  the training register sat under "Schools", and Kobo review sat under Data
  quality while the survey results sat under Surveys & forms. For Admin, the
  forms and Kobo surveys sat under "Field operations".
- **Vague or technical names:** "Activities", "Education programmes",
  "Form registry", "Validation", "Sync monitor", "Permissions & grants".
- **An area named like its own first page:** "My classes › My classes",
  "Learning resources › Learning resources", "My progress › My progress".

### What it is now

**The sidebar is the whole map.** Each row is an area. An area with one page
is a link; an area with several opens in place to list them, with a chevron.
The area you're in is open and lit; the page you're on has the orange edge.
(Superseded by §24: the sidebar now lists only the areas; an area's pages are tabs across the top of the page.) The tab strip above the
page is gone — its pages are in the sidebar instead, so nothing is listed
twice.

**Above every page, the breadcrumb:** Workspace › Area › Page, each step a
link back. On a phone the workspace step is left off (it's in the pill above).

**Folded menu (laptop):** the menu still folds to an icon rail; pointing at
or tabbing to an area shows its pages beside it, with the area's name.

**Phone:** the drawer lists the same areas, opening in place; rows are
finger-sized; it has its own close button as well as tapping beside it or
Escape; opening it puts the keyboard on the page you're on; closed, it is out
of the keyboard's way; picking a page closes it, opening an area doesn't.

**Counts** (waiting approvals, work to mark, Kobo submissions to review, data
issues) show on the area's row while it's closed, and on the page itself
once it's open — never twice.

### Naming rules

1. The same page has the same name in every workspace — unless the role
   does something different there (M&E's "Kobo review" is the review queue
   of the page Admin calls "Kobo surveys").
2. Plain words for what you do there, not how the portal is built.
3. A page isn't named like its area.
4. The same area name means the same kind of thing in every workspace:
   **Schools** (the directory), **Teaching & learning** (assignments,
   results, training, the content library), **Surveys & forms**, **Data
   quality**, **Dashboards & reports**, **Users**.

### The menus

| Workspace | Areas (pages inside) |
| --- | --- |
| Platform Administration | Overview · Users & roles (Accounts, Permissions, Notifications sent) · Organisation setup (Counties & schools, Academic calendar, Classes, Subjects) · Data & integrations (KoboToolbox, Forms, Data quality, Device sync) · Dashboards & reports (Executive overview, Survey results, M&E reports, Exports) · Audit & security (Audit log, Account activity) |
| Programme Administration | Dashboard · Schools (All schools, All teachers, Find a learner, Field visits, Counties & schools, Academic calendar) · Teaching & learning (Assignments & assessments, Results, Content library) · Surveys & forms (Forms, Kobo surveys, Survey results) · Data quality (Data issues, Device sync) · Reports · Users (Accounts, Notifications sent) |
| Monitoring & Evaluation | M&E overview · Results framework (Programmes & indicators, Indicator results) · Dashboards & reports (Executive overview, M&E reports, Exports) · Data quality · Surveys & forms (Survey results, Kobo review, Form responses) · Schools (All schools, All teachers, Find a learner, Field visits) · Teaching & learning (Assignments & assessments, Results, Training register, Content library) |
| Learning & Education | Dashboard · Schools (All schools, All teachers, Find a learner, Field visits, Device sync) · Teaching & learning (Assignments & assessments, Results, Training register) · Content library (Library, Subjects) · Forms · Dashboards & reports (Teacher development, Digital resources, Exports) |
| Field Operations | Dashboard · My schools (Schools, Teachers) · My visits · Surveys & forms (Kobo surveys, Forms) · Reports |
| School Management | Dashboard · My school (Teachers, Learners & classes, Assignments & results, Visits) · Learning resources · Reports |
| Teaching & Learning | Dashboard · My classes (Classes, Class roster) · Assessments · Results · Library · Reports |
| My Learning | Home · My classes · My assignments · My progress · Library |

Still at most seven areas for every role, and each page in one area of its
workspace (`navigation_test.ts`). A class's page (`#classes`) stays out of
the list, as before: it's reached from a school's page and is shown in the
menu only while it's open.

### Moved, and why

| Page | Was under | Now under | Why |
| --- | --- | --- | --- |
| M&E: Assignments & assessments, Results, Training register | Schools | Teaching & learning | They're about learning, not the school list — the same area as Admin's |
| M&E: Content usage | Reports & analytics | Teaching & learning › Content library | The library page, not a dashboard |
| M&E: Kobo review | Data quality | Surveys & forms | All of Kobo in one place (decision 3) |
| Admin: Forms, Kobo surveys, Survey results | Field operations | Surveys & forms | Forms reach teachers and heads too; the same area as M&E's and the field officer's |
| Admin: Field visits | Field operations | Schools | A visit is to a school; each school's page has its visits |
| Admin: Device sync | Field operations | Data quality | Both answer "is all the data in, and right?" |
| Education: Teacher development, Digital resources (dashboards) | Activities; Content & resources | Dashboards & reports | Dashboards together, as in the other workspaces |
| Education: Forms | Activities | its own row | "Activities" said nothing about what was in it |

### Renamed

| Was | Now |
| --- | --- |
| Reports & analytics | Dashboards & reports |
| Education programmes, Activities | Teaching & learning |
| Schools & learning | Schools |
| Content & resources | Content library |
| Education reports | Dashboards & reports (Exports inside) |
| Field surveys (field officer) | Surveys & forms |
| Validation | Data quality |
| Form registry, Education forms | Forms |
| Sync monitor, Devices, Stuck devices | Device sync |
| Permissions & grants | Permissions |
| Classes & structure | Classes |
| Learning outcomes | Learning |
| Executive | Executive overview |
| Usage dashboard | Digital resources |
| Schools (the list), School profiles | All schools |
| My classes › My classes | My classes › Classes |
| Learning resources › Learning resources | Learning resources › Library |
| My progress › My progress | My progress › Progress |
| My schools › My schools, All my teachers | My schools › Schools, Teachers |

## 16. How a page works, 14 October 2026

Every page follows the same five steps: open it, see what it is for, see
what matters, act, and see that it worked.

### 1. What the page is for

- **The page heading is the page's name.** On the start page the header
  greets the person ("Habari, Amina") and says who they are. On every other
  page it names the page, in large type, with one line under it on what the
  page is for ("Your learners and their sign-ins. Add learners, or edit,
  reset or archive one."). The browser tab says the same.
- Each page's name and purpose line are in `navigation.js`: `heading` when
  the page's name should be fuller than its menu label ("Accounts" in the
  menu, "Staff accounts" on the page), and `purpose`. A page that is the
  same everywhere has them once, in `PAGES`; a role's own pages have them
  on the menu item.
- A panel heading that only repeated the page's name is marked
  `data-page-title` and isn't shown under the page heading (it still shows
  on the start page). Hints that only repeated the purpose line were taken
  out; hints that add something were kept, shortened.

### 2. One main action

- A page has at most one main (filled, orange) button, for the thing most
  people came to do: Invite staff, Add learner, New assignment, New upload,
  Send form, Generate.
- An action repeated down a list (Start visit on every school) is an
  ordinary button in the list; on the school's own page it is the main one.
- Less common ways of doing the main thing fold away: adding many learners
  from a spreadsheet is under the roster's own controls, not above it.

### 3. Sensitive actions look sensitive, and ask first

- In a row of actions, the ones that change whether someone can sign in or
  take something away are in the warning colour, after the everyday ones —
  on Staff accounts, on a line of their own (Reset password in amber;
  Suspend, Deactivate and Reject in red).
- Each asks first, saying what will happen and what is kept. The question
  for something that can't easily be undone has a red edge and a warning
  sign, and the cursor starts on **Cancel**, so pressing Enter doesn't do
  it by accident. The dialog keeps the keyboard inside it until it is
  answered, closes with Escape, and puts the focus back where it was.
- Asking first was added where it was missing: sending the due
  notifications now ("Run now"), and applying a data-quality correction
  (which changes the record itself — the dialog says what will change).

### 4. Forms, not prompts

- Nothing uses the browser's own `prompt()` boxes any more. Editing a
  learner on the class roster is one form (name, username, grade, gender)
  checked the way the server checks it, with the problem shown beside the
  field. A new PIN is chosen, or suggested, in a form, then shown once to
  pass on.

### 5. Saying what happened

- A message after an action says what was done and to what: "Kid One is
  updated", "New PIN set", "Invitation link copied", "3 notifications
  sent" — in green. A failure says what failed: "Couldn't suspend the
  account", not "Couldn't do that".
- Problems stay on screen for 10 seconds (and while pointed at); other
  messages for 5. Every message can be dismissed.
- A search that finds nothing says what was searched for, and how to widen
  it ("No learner matches “otieno” in that school. Check the spelling, try
  their username or learner code, or search all schools.").

## 17. Filters and drill-downs, 15 October 2026

The dashboards lead to their detail, and the filters go along.

### The filters

- **One set of filters** — county, school, period — above every page
  whose data they narrow. A page shows only the ones it applies
  (navigation.js: `filters: true` for all three, or a list such as
  `["county", "school"]`; see §20).
- **They stay** while the tab is open: from page to page, and through a
  reload (sessionStorage, per workspace). They aren't shared with anyone
  and go when the tab closes.
- **Period**: all time, the last 30 days, a whole school year, a term, or
  a custom range. A custom range can't run backwards: each date limits the
  other, and a pair typed the wrong way round is swapped.
- **Each filter can be taken off on its own** with the × on its tag under
  the filters: without the school you see the county, without the county
  everywhere. "Clear filters" takes them all off.

### Drilling down

- **Within a dashboard**: a county's bar, a school's name, or a month or
  term on a chart narrows the dashboard to it. The tags say what is shown.
- **To the detail**: a key figure or a chart's category opens the existing
  page that holds the detail, already filtered. Nothing was duplicated to
  make this work:

  | From | Opens |
  | --- | --- |
  | Field operations · Visit types | Field visits, that type |
  | Field visits (key figure), Visits by month | Field visits |
  | Administration overview · Field visits this term | Field visits, this term |
  | Learning · Assignments by subject | Assignments, that subject |
  | Learning · Completion by grade, Subject performance | Results, by grade / by subject |
  | Digital resources · Most-used content, Resources by subject | Content library, searched for it |
  | Reach · Learners (key figure), with a school picked | Find a learner, that school's learners listed |
  | High-severity data issues (Administration, Platform) | Data quality, high-severity issues |

- Detail pages that list places and dates follow the filters above:
  Field visits (county, school, period), All teachers and All schools
  (county, school), Assignments (county, period; its own School list is
  set from the school picked above). Results can be narrowed to a school
  and a whole term only; when a county or other dates are chosen it says
  so above the table instead of showing figures that look like the
  dashboard's and aren't.
- A link can carry filters in its address (`?county=`, `?school=`,
  `?term=2026 Term 3`, `?month=2026-10`) and a page's own choices
  (`?type=`, `?subject=`, `?status=`, `?severity=`, `?by=`, `?q=`). Once
  applied, the carried filters become the filters above, and leave the
  address — so taking one off sticks.

### Getting back

- A page opened from a dashboard says so in its breadcrumb (`?via=`):
  "Monitoring & Evaluation › Dashboards & reports › Field operations ›
  Field visits". The dashboard's crumb is a link back, and the dashboard
  still has its filters. The browser's Back button works too.

## 18. Loading, empty, error and success, 15 October 2026

Every list, table, chart and dashboard goes through the same four states,
drawn by the same few functions in `util.js` so they look and read the
same everywhere.

### Loading — a skeleton in the shape of what's coming

| Shape | Function | For |
| --- | --- | --- |
| List | `skeleton(rows, { avatar })` | lists of people, items, rows |
| Table | `skeletonTable(rows, cols)` | tables |
| Key figures | `skeletonCards(n)` | a row of key-figure cards |
| Charts | `skeletonCharts(n)` | chart cards |
| Dashboard | `skeletonDashboard()` | key figures, then charts |
| Line | `skeletonLine()` | a line of text inside a heading or sentence |

- A page's first placeholder names its shape in the HTML —
  `<div data-skeleton="table" data-cols="5"></div>` — and `fillSkeletons()`
  draws it as the page opens. Nothing on a page says just "Loading…".
- Screen readers hear "Loading…" once (`role="status"`); the grey blocks are
  hidden from them, and don't shimmer for people who ask for less motion.
- A list never says it's empty before it has loaded: staff accounts, the
  teacher's work to mark and recently marked, and the content library keep
  their skeleton until the first answer arrives.

### Empty — what is missing, and what to do next

- `emptyState(title, detail)`: the title says what's missing ("No surveys
  attached yet."), the detail what to do ("Attach a deployed KoboToolbox
  survey above to start collecting it.") — only when this person can do
  it; otherwise who does, or what will appear.
- When filters hid everything: "Nothing matches your current filters.
  Take a filter off above to see more." (`FILTERED_EMPTY`, `filteredEmpty()`),
  the same words on every page.
- A dashboard chart with nothing to show says what and where, from the
  filters it was drawn with: "No visits recorded in Narok County for this
  period." / "No resources recorded yet."
- A search that finds nothing says what was searched for and how to widen
  it.

### Error — what happened, in plain words, and Try again

- `errorState(detail, retry)`: "We couldn't load this information." and
  one plain line under it — the server's own words when it wrote some for
  people, otherwise "Check your connection and try again." Offline, it
  says so: "You're offline. This needs a connection — try again once
  you're back online."
- A load that can be repeated has "Try again" (`retry`); added where it was
  missing (a learner's history, an M&E report, the learner search, the
  school year, a Kobo submission, the field officer's pages).
- A form keeps its error beside the form, so what was typed isn't lost.

### Success — short, and no more than needed

- A small message at the bottom of the screen that goes by itself: a short
  title in the past tense ("Changes saved", "Published", "Visit report
  sent"), no full stop, no "successfully"; a detail line only when it adds
  something ("They now sign in as @naomi.k.").
- No dialog to confirm that something worked: a dialog is only for asking
  first (§16).

## 19. Phones and tablets, 15 October 2026

The same pages and the same functions at every width — arranged for the
screen and the finger, not the desktop made smaller. Checked at 320, 375,
390, 768, 1024 and 1440 px.

| | Phone (up to 640 px) | Tablet (641–1024 px) | Laptop |
| --- | --- | --- | --- |
| Menu | Drawer from the ☰ button | Drawer up to 860 px, then the sidebar | Sidebar (or the icon rail) |
| Filters above a page | One **Filters** button with how many are chosen; the choices open in a sheet from the bottom; the tags of what's chosen stay on the page, each with its × | The filter bar | The filter bar |
| A page's own filters | Two to a row; a search across the row | In a row | In a row |
| Key figures | Two to a row, straight after the page heading | Three to a row | Up to six |
| Tables | Each row a card: the first cell its title, every other value with its column's name; actions along the bottom. A **Sort by** list for sortable tables; the first 15 rows, then **Show all** | Scroll sideways with the first column held, and a shadow at the edge while there's more | As tables |
| Charts | One to a row; a month chart names every other month (never the year) | Two to a row | Two or three |
| Long lists | The teacher's recently marked work: the first 10, then **Show all** | All | All |

- **Touch screens** (any width): every control at least 44 px — buttons,
  fields, the links in table rows and panel headings, menu rows, the ×
  on a filter tag. Text links get room round them rather than a bigger
  look. Fields use 16 px text so a phone doesn't zoom in on them.
- **Nothing is hidden because the screen is small.** A table that becomes
  cards keeps every column; "Show all" shows the rest; the sorts that are
  headings on a laptop are the Sort by list on a phone; the filters are one
  tap away, with what's chosen always on show.
- The permissions matrix stays a grid (it's read across), scrolling
  sideways.
- `tables.js` does the table part on every page (labels, Sort by, Show
  all); the rest is `app.css` (§ "PHONES AND TABLETS").

## 20. The final pass, 15 October 2026

Every page was looked at against ten questions — purpose clear, the most
important thing first, clutter, duplicates, one obvious action, readable
charts, a way on to related detail, consistent with the rest, works on a
phone, live told apart from unavailable. Most pages already passed. What
didn't, most harmful first:

| Problem | Where | Now |
| --- | --- | --- |
| A **Role** filter that changed nothing | Every page with the filter bar | Gone, kept value and all. Only the Staff accounts page read it, and that page has no filter bar — so a role kept from an earlier page could empty its list with nothing there to take it off |
| Filters a page ignores | Content (applies only School), Notifications sent (only Period), M&E overview, Indicator results, M&E reports, Survey results (County and School) | Each page lists the filters it applies (`navigation.js`); the rest aren't offered |
| Two Period controls | M&E overview, Indicator results, M&E reports | The page's own Period (a term or school year, as the results framework records them); the global one isn't shown there |
| Table columns all right-aligned, words included | Every table | Words read from the left; a column of numbers (counts, %, "8 of 10", "3h 20m") lines up on the right to compare (`tables.js` marks it `num`). The permission matrix's ticks and headings are centred |
| A wide table off the side of a laptop screen | All teachers (Classes taught) | A column of long entries wraps (`wrap`) instead of pushing the last columns out of view |
| An "Unfiled" heading over every resource | Libraries before any folder exists | Just the resources; folder headings appear once there are folders |
| "Last sync not yet on this device · Pending 0" | The sync status in the top bar | "Synced 11:00 PM · nothing waiting", "Nothing waiting to sync", or "2 activities waiting to sync · last sync 9:15 AM" |
| An Add subject button stretched across the page | Subjects | A button its own size beside the name |

Left as they are, on purpose: the Counties & schools page lists schools
in two panels — one to rename and remove, one with each school's figures
and a link to it. Merging them would remove one of those jobs.

Checked: 320, 390, 768 and 1440 px (no sideways scroll, every touch
target 44 px), axe on each changed page in light and dark (no
violations), lint, build, CSP check, size budget, API tests (370) and
navigation tests (6).

## 21. Less writing, 16 October 2026

Every block of explanation on the 55 pages was counted, then cut. Longer
notes (seven words or more) went from 1,607 words to 742; no table or
figure changed.

**How the portal writes now**

1. **One purpose line per page**, under the heading, about ten words:
   what the page is for (`navigation.js` `purpose`). No intro paragraph
   says it again.
2. **No describing the screen.** "The county and school filters at the
   top apply", "Open one to…", "Pick a county to see only it" under a
   chart whose names are already links — gone. A line chart, whose points
   don't look clickable, keeps its "Pick a month…".
3. **Keep what changes a decision or prevents a mistake**, in one
   sentence: something can't be undone ("Subjects can't be renamed or
   removed once added"), privacy ("Passwords are never visible"), what a
   figure counts ("The average counts marked work only — missing work
   isn't scored as 0"), live against recorded data.
4. **A key once, next to what it explains.** The results pages said
   "completion and achievement are separate" above the table and again
   below it, while the table's headings already say so; now only the
   band key and the one rule above remain.
5. **No "About this page" box for a single line.** The dashboards that
   still need one line show it plainly; the rest lost the box.

| Where | Before | After |
| --- | --- | --- |
| Indicator results | A 45-word intro and a 48-word key | The purpose line and a one-line key |
| Results (teacher, head, admin) | The two measures explained twice, about 80 words | One line under the table, then the bands |
| Device sync | Three paragraphs, 106 words | Three short lines |
| Notifications sent | 35 words on how they're made | "Sent hourly: work due, forms due, …" |
| M&E overview | 47-word About box + 40-word note | A link to record actuals, and the key |
| Content library | 43 words on "time spent" | "an estimate, not reading time" |
| Workspace questions | M&E 15 words, Education 13 | 7 and 9 (docs/RBAC.md updated) |

## 22. One action, one place in the menus, 16 October 2026

Every menu was checked for two entries that open the same page or do the
same thing. Each pair is now one entry; what the second one did is on the
page, so nothing can no longer be done.

| Was | Now | What the merged entry did, and where it is now |
| --- | --- | --- |
| Account menu **Notifications** and the bell | The bell | Same panel. The account menu keeps My profile and Sign out |
| Account menu **Sync center** and the sync chip | The sync chip | Same panel. The chip is named "Sync center — …" for screen readers |
| **Accounts** and **Approvals** (Super Admin, Admin) | Accounts, with the approvals count | Approvals was Accounts filtered to waiting requests. Those are listed first anyway, and "N waiting for approval" in the count line shows just them. Old `#users?status=pending` links still filter |
| **Audit log** and **Security events** (Super Admin) | Audit log | Security events was the log filtered. A **Show** choice on the page (All changes / Security events); `#audit?kind=security` still opens it filtered |
| School head's **Profile**, beside Learners & classes, Visits and the Dashboard | Not listed | Its classes and learners by grade are on Learners & classes, its headline numbers on the Dashboard. Its visit part — total, last visit, Kobo submissions, the latest visits with who made them, who supports the school — is now the **Visits** page, which shows the dashboard's saved copy first, so it still works offline. Old links to `#school-profile` still open it |
| Counties & schools: a second **Schools** list, to "View school" | The School list | The same schools twice. Choosing a school in the filters above still shows its figures under the list; the panel's "← All schools" was the × on the filter tag |

Checked by a script over every workspace: no page is listed twice
(`navigation_test.ts` holds the rule). Buttons repeated on a page are all
per-row (one per school, class or indicator).

## 23. Fewer words, fewer menu rows, 16 October 2026

"Too wordy, too many menus." What changed — every page, figure and action
is still there:

**Menus**
- The five area dashboards (Reach, Learning, Teacher development, Field
  operations, Digital resources) are cards on the Executive overview, so
  they open from there, not as five more rows: Super Admin and M&E list
  18 pages instead of 23. Old links and drill-downs still open them, and
  the sidebar shows the one you're on while you're there.
- Reading activity was a page of its own and a section of the dashboard
  for teachers and learners; it is now at the foot of the Library, as it
  already was for school heads (old `#activity` links go there).
- **One area open at a time.** Opening an area closes the one before, so
  the sidebar is the areas plus one short list — not every list you've
  ever opened.

**Words**
- No sentence under the page heading: the heading and breadcrumb say what
  the page is; the old sentence is the heading's tooltip.
- Under the greeting: who you are and the term — the workspace's question
  and the second "school · county · class" line (already said above it)
  are gone.
- The sync chip is a word and a time: "● Synced 8:52 PM", "2 waiting",
  "Offline". The full sentence is its tooltip and what a screen reader
  hears.
- Chart captions are numbers or nothing: "Last 12 months", "45 active",
  "1 of 3 schools" — no "Pick a month to see only it" (the names and
  points are the links), no caption that repeats the chart's title.
- Programme-area cards end in an arrow, not "Open reach →".
- Notes that only described the page went (notifications, schools,
  survey results, device sync, exports, training, classes); the ones that
  prevent a mistake stayed, shorter ("2–4 letters. Can't be changed
  later.", "Learners don't see these.").
- Repeats: the M&E overview's period and place said twice, two key lines
  for one chart, a reading session's date twice ("Started … · Finished …").
- The teacher's dashboard shows the first five pieces of work to mark and
  the last five marked, with "see all" — the whole queue is Assessments.
  On a phone the dashboard is 3,930 px long instead of 4,663.

Counted on the 55 pages: words other than data 4,387 → 3,839 (the top of
each page 668 → 448, notes 487 → 360, chart titles and captions 690 → 556).

## 24. Areas in the sidebar, their pages as tabs, 17 October 2026

Asked for: menus that don't drop down — click **Schools** and the Schools
pages appear across the top of the page.

**The sidebar is the areas, nothing else.** Each row is a link; clicking
an area opens its first page. Nothing opens under it, so the sidebar is
never longer than seven rows (plus the workspace switch for a Super Admin).
The phone drawer is the same short list, and the folded icon rail needs no
pop-outs.

**An area's pages are tabs across the top**, under its name:

    Schools
    All schools   All teachers   Find a learner   Field visits   Counties & schools   Academic calendar
    ───────────   ━━━━━━━━━━━━

- The area is the page heading; the tab you're on is underlined (and says
  which page it is to a screen reader, `aria-current="page"`). The page's
  one-line purpose is the tab's tooltip.
- A count (approvals, Kobo submissions to review) is on its tab while you're
  in the area, on the sidebar row otherwise — never twice.
- A page kept for old links, or opened from a dashboard's card (Reach and
  the other area dashboards), is a tab only while it's the one open.
- An area with one page has no tabs.
- On a phone the tabs wrap onto further rows as chips — every page in
  view, nothing to scroll sideways to find.

**The breadcrumb only where it adds something:** after drilling down from
a dashboard it is the way back ("Executive overview › Reach", keeping the
filters), and inside a school it is "All schools › Aitong Primary ›
Teachers" above the school's own tabs. Otherwise the lit sidebar row and
the tabs say where you are. (A school's page lost its "← All schools" link:
the breadcrumb and the All schools tab already go there.)

Built in `nav.js` (`drawTabs`), styled as `.area-tabs` in `app.css`; the
menus themselves (`navigation.js`) are unchanged.

## 25. Attendance, 20 October 2026

One more tab in an area each role already has — no new menu rows:

- **Teacher:** My classes › Classes · Class roster · **Attendance** (the
  register). Home's *Today's registers* panel and each class's *Register*
  button open it on that class (`#attendance?class=…`); a *Here today* card
  joins the figures on Home.
- **School head:** My school › Teachers · Learners & classes ·
  **Attendance** · Assignments & results · Visits. The dashboard gets a
  *Registers today* panel and a *Here today* card.
- **Which subject does best?** sits at the top of the results pages that
  exist already (teacher, school head, programme Results) and on the
  Learning dashboard — no page of its own.

## 26. Who works where, 20 October 2026

- **Admin › Schools › Field officers** (a tab, beside All teachers): field
  officers and their schools, by officer or by school. Needs
  `users.placement.assign`, so Admins and the Super Admin (through the
  Programme Administration workspace). The same assignments are still on a
  person's Access panel in Users › Accounts — one person at a time there,
  everyone at once here.
- **School head › My school › Teachers** now opens with *Teachers and their
  classes*. The class list on Learners & classes swaps its class-teacher
  drop-down for a line saying who teaches the class and a **Teachers…**
  button that opens the same choice for that class.
- **School head › Dashboard** gets *Teachers by grade* (under *Registers
  today*): each grade, its classes and their class teachers, and *Assign
  teachers* — the whole school's button in the heading, one per grade. The
  same dialog is the *Assign teachers* button on My school › Teachers.

## 27. The content library, a page of its own, 21 October 2026

- **Content library** (Education Team; Admin and M&E under Teaching &
  learning) is the library alone: *+ New upload* in its heading, the
  search and filters, then folders as small tiles and the items as compact
  tiles. The usage report moved to a **Usage** tab beside it (*Content
  usage* for Admin and M&E), which keeps the School filter the library no
  longer needed.
- Every library list — the Education Team's and each dashboard's shelves —
  opens a folder in place, with *All ›* to come back, instead of stacking
  every folder as a large open box.

## 28. One Programme Admin; the system is the Super Admin's, 29 October 2026

- The Programme Admin is the Education Team: one role, one workspace
  (**Programme Administration**, `admin.html`; `education.html` opens the
  same). Menu: Dashboard (Overview · Teaching progress · In detail) ·
  Schools (School profiles · Teachers · Learners · Field visits · Counties &
  schools · Calendar) · Teaching & learning (Assignments · Results ·
  Training) · Content library (Library · Usage · Subjects) · Forms ·
  Dashboards & reports (Learning · Teacher development · Digital resources ·
  Reports). The old Learning & Education workspace is gone.
- **Data quality** and **Device sync** appear in the Super Admin's
  *Data & integrations* only (no longer in M&E or the Programme Admin's
  menus). **Field officers** (who works where) moved to the Super Admin's
  *Users & roles*, beside Accounts and Permissions.
- The Super Admin's *Switch workspace* lists Programme Administration and
  M&E.
- Role permissions and the reasons: [RBAC.md §14](RBAC.md).

## 29. Change history, 29 October 2026

- **Change history** — every record added, edited or deleted, who did it
  and their role, when, and before → after, with *Put back* and *Undo this
  edit* ([RBAC.md §15](RBAC.md)). The Super Admin's: the first tab of
  *Audit & security* (before Audit log and Account activity). Anyone the
  Super Admin gives the right finds it under *Granted to you*; the
  Programme Admin's menu has no row for it.
- The Audit log keeps the actions that aren't a record changing (approvals,
  password resets, permissions, exports); its *Show* choice now reads
  "All actions".

## 30. Users & roles for the Programme Admin, 29 October 2026

- Programme Administration gets **Users & roles** (its seventh row): the
  accounts of teachers, school heads and field officers, to invite and
  edit ([RBAC.md §16](RBAC.md)). Its Role filter lists only the roles in
  the list.
- *Invite someone* and *Edit profile* are side panels now, for everyone who
  manages accounts (the Super Admin too), instead of a form above the list
  and an editor squeezed into a table row.
- Roles read "School Head" everywhere (the page's own list said "School
  Leader").
