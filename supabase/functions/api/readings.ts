/**
 * Library opens, read the same way everywhere they are counted — the impact
 * dashboards (intelligence.ts, impact.ts), Content usage (library_usage.ts)
 * and the library export (index.ts) — docs/KPI-DEFINITIONS.md. Pure, no database.
 *
 * An open records the reader's school as a name typed on their account at
 * the time (library_interactions.school). Two rules make that dependable:
 *
 *   school — the name recorded, when it is a registered school's; otherwise
 *            the school the reader's account is linked to now (school_id);
 *            otherwise left as recorded, so it counts only in the "every
 *            school" totals. (28 October 2026: 16 of the 21 programme opens
 *            were recorded under "meru" — a county, from before the readers'
 *            accounts were linked to Olesere — and fell out of every county
 *            and school view.) The stored rows are not changed.
 *   hpf    — HPF's own staff opening resources to check them: the role
 *            recorded on the open, or the reader's role now, is an HPF staff
 *            role. Never programme use.
 */
import { HPF_STAFF_ROLES } from "./permissions.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

export type Reading = Row & { school: string; recordedSchool: string; hpf: boolean };

export function prepareReadings(rows: Row[], schools: Row[], people: Row[]): Reading[] {
  const registered = new Set(schools.map((s) => String(s.name)));
  const nameOf = new Map(schools.map((s) => [String(s.id), String(s.name)]));
  const hpfRoles = new Set<string>(HPF_STAFF_ROLES);
  const byId = new Map(people.map((p) => [String(p.id), p]));
  return rows.map((r) => {
    const recorded = String(r.school ?? "");
    const who = byId.get(String(r.actor_id));
    const linked = who?.school_id ? nameOf.get(String(who.school_id)) : undefined;
    return {
      ...r,
      school: registered.has(recorded) ? recorded : linked ?? recorded,
      recordedSchool: recorded,
      hpf: hpfRoles.has(String(r.role ?? "")) || hpfRoles.has(String(who?.role ?? "")),
    };
  });
}
