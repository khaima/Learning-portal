/**
 * The menus (navigation.js) agree with the permissions (permissions.ts),
 * and keep to the navigation rules (docs/NAVIGATION.md):
 *   - each role reaches every page its permissions open, and nothing else;
 *   - one home per function: a page sits in one menu entry of a workspace
 *     (its tabs may be filtered views of it), and no two rows share a label;
 *   - at most 7 rows, so no menu turns into a list of everything.
 *
 *   cd supabase/functions/api
 *   deno test --allow-env --config deno.json navigation_test.ts
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { ROLE_PERMISSIONS } from "./permissions.ts";
// @ts-ignore — plain browser module, no types
import { consolePagesFor, menuFor, ROLE_WORKSPACE, WORKSPACES, workspacesFor } from "../../../navigation.js";

type Item = { page?: string; hash?: string; label: string; needs?: string[] };
type Entry = { id: string; label: string; items: Item[] };
const pagesIn = (groups: Entry[]) => new Set<string>(groups.flatMap((g) => g.items.map((i) => i.page ?? "").filter(Boolean)));
const permsOf = (role: string) => [...(ROLE_PERMISSIONS as Record<string, readonly string[]>)[role]];

Deno.test("menus: each management role reaches every page its permissions open, and only those", () => {
  for (const role of ["super_admin", "admin", "me", "education_team"] as const) {
    const perms = permsOf(role);
    // A Super Admin reaches the operational pages by switching workspace.
    const menu = new Set(workspacesFor(role).flatMap((ws: string) => [...pagesIn(menuFor(ws, perms))]));
    const opens: string[] = consolePagesFor(perms);
    assertEquals(opens.filter((p) => !menu.has(p)), [], `${role}: pages they may open but can't find in their menus`);
    const extra = [...menu].filter((p) => p !== "profile" && !opens.includes(p));
    assertEquals(extra, [], `${role}: menu items they may not open`);
  }
});

Deno.test("menus: the Super Admin's own menu is the system; the operational areas are a workspace switch away", () => {
  assertEquals(workspacesFor("super_admin"), ["platform", "admin", "me", "education"]);
  for (const role of ["admin", "me", "education_team", "field_officer", "school_leader", "teacher", "learner"]) {
    assertEquals(workspacesFor(role), [(ROLE_WORKSPACE as Record<string, string>)[role]], `${role} has one workspace`);
  }
  const platform = pagesIn(menuFor("platform", permsOf("super_admin")));
  for (const p of ["users", "permissions", "schools", "kobo", "sync-problems", "reports", "audit", "account-activity"]) assert(platform.has(p), `platform has ${p}`);
  for (const p of ["admin-overview", "me-dashboard", "learners", "assignments", "mel-framework", "field-visits"]) assert(!platform.has(p), `platform leaves ${p} to its workspace`);
});

Deno.test("menus: at most 7 rows, one home per page, and no two rows with the same name — for every role", () => {
  for (const [role, ws] of Object.entries(ROLE_WORKSPACE) as [string, string][]) {
    const groups: Entry[] = menuFor(ws, permsOf(role));
    assert(groups.length <= 7, `${role}: ${groups.length} rows`);
    const home = new Map<string, string>();
    for (const g of groups) {
      for (const i of g.items) {
        if (!i.page) continue;
        assertEquals(home.get(i.page) ?? g.id, g.id, `${role}: ${i.page} is in "${home.get(i.page)}" and "${g.id}"`);
        home.set(i.page, g.id);
      }
      const tabs = g.items.map((i) => i.label);
      assertEquals(new Set(tabs).size, tabs.length, `${role}: two tabs named alike in ${g.label}`);
    }
    const labels = groups.map((g) => g.label);
    assertEquals(new Set(labels).size, labels.length, `${role}: two rows named alike`);
  }
});

Deno.test("menus: the field officer's menu is the small, task-focused one", () => {
  const rows = menuFor("field", permsOf("field_officer")).map((g: Entry) => g.label);
  assertEquals(rows, ["Dashboard", "My schools", "My visits", "Field surveys", "Reports"]);
});

Deno.test("menus: a granted page shows up for that person only, in an entry of its own", () => {
  const perms = [...permsOf("education_team"), "kobo.results.view"];
  const groups = menuFor("education", perms, ["kobo.results.view"]);
  const granted = groups.find((g: Entry) => g.label === "Granted to you");
  assertEquals(granted?.items.map((i: Item) => i.page).sort(), ["kobo", "survey-results"]);
  assertEquals(menuFor("education", permsOf("education_team")).some((g: Entry) => g.label === "Granted to you"), false);
});

Deno.test("menus: the workspaces are the eight known ones", () => {
  assertEquals(Object.keys(WORKSPACES).sort(), ["admin", "education", "field", "learner", "me", "platform", "school", "teacher"]);
});
