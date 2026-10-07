# Navigation: audit and plan

**Date:** 7 October 2026. **Status:** done — all eight stages of
the stages of [§11](#11-implementation-plan), with the decisions in
[§12](#12-decisions-taken-7-october-2026). [`docs/RBAC.md`](RBAC.md) is the access model this builds on;
none of its server-side rules change here.

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
| Admin — Administration overview | 6 tiles that link to their pages, a "Needs attention" list with Open links | Good pattern — keep |
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
