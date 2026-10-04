/**
 * The menus (navigation.js) agree with the permissions (permissions.ts):
 * each role's menu lists every page its permissions open, and nothing else.
 *
 *   cd supabase/functions/api
 *   deno test --allow-env --config deno.json navigation_test.ts
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { ROLE_PERMISSIONS } from "./permissions.ts";
// @ts-ignore — plain browser module, no types
import { consolePagesFor, menuFor, ROLE_WORKSPACE, WORKSPACES } from "../../../navigation.js";

type Item = { page?: string; action?: string; needs?: string[] };
const pagesIn = (groups: { items: Item[] }[]) => new Set<string>(groups.flatMap((g) => g.items.map((i) => i.page ?? "").filter(Boolean)));

Deno.test("menus: each management role's menu lists every page its permissions open, and only those", () => {
  for (const role of ["super_admin", "admin", "me", "education_team"] as const) {
    const perms = [...ROLE_PERMISSIONS[role]];
    const menu = pagesIn(menuFor(ROLE_WORKSPACE[role], perms));
    const opens: string[] = consolePagesFor(perms);
    assertEquals(opens.filter((p) => !menu.has(p)), [], `${role}: pages they may open but can't find in their menu`);
    const extra = [...menu].filter((p) => p !== "profile" && !opens.includes(p));
    assertEquals(extra, [], `${role}: menu items they may not open`);
  }
});

Deno.test("menus: the Super Admin's menu reaches every console page", () => {
  const all = consolePagesFor([...ROLE_PERMISSIONS.super_admin]);
  const menu = pagesIn(menuFor("platform", [...ROLE_PERMISSIONS.super_admin]));
  for (const p of all) assert(menu.has(p), p);
});

Deno.test("menus: a granted page shows up for that person only, in its own group", () => {
  const perms = [...ROLE_PERMISSIONS.education_team, "kobo.results.view"];
  const groups = menuFor("education", perms, ["kobo.results.view"]);
  const granted = groups.find((g: { label: string }) => g.label === "Granted to you");
  assertEquals(granted?.items.map((i: Item) => i.page).sort(), ["kobo", "survey-results"]);
  assertEquals(menuFor("education", [...ROLE_PERMISSIONS.education_team]).some((g: { label: string }) => g.label === "Granted to you"), false);
});

Deno.test("menus: no more than eight groups in any role's own workspace, except the Super Admin's full one", () => {
  for (const [role, ws] of Object.entries(ROLE_WORKSPACE) as [string, string][]) {
    const n = menuFor(ws, [...(ROLE_PERMISSIONS as Record<string, readonly string[]>)[role]]).length;
    assert(role === "super_admin" ? n <= 9 : n <= 8, `${role}: ${n} groups`);
  }
  assertEquals(Object.keys(WORKSPACES).sort(), ["admin", "education", "field", "learner", "me", "platform", "school", "teacher"]);
});
