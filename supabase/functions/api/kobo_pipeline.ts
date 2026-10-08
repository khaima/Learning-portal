/**
 * KoboToolbox ingestion pipeline — the rules, with no database or network.
 *
 *   KOBO ─→ API (raw submission stored as received)
 *        ─→ VALIDATION   required fields · data types · school code · county ·
 *                        officer · duplicates · dates
 *        ─→ NORMALIZATION  trimmed text, numbers, choice lists, ISO dates,
 *                          canonical school / county / officer links
 *        ─→ PORTAL DATA MODEL (kobo_records + kobo_record_issues)
 *        ─→ DASHBOARDS   (only records that pass, or that a person accepted)
 *
 * Postgres is the source of truth: the raw payload is kept for audit and
 * re-processing, and every dashboard reads the normalized records.
 *
 * Every problem is an ISSUE with a severity. An ERROR keeps the record off
 * the dashboards until someone reviews it; a WARNING is shown but doesn't.
 */
import { createHash } from "node:crypto";

// deno-lint-ignore no-explicit-any
type Any = any;

export type KoboField = {
  xpath: string;            // the data column, e.g. "school_info/school_code"
  name: string;
  label: string;
  type: string;             // text, integer, decimal, select_one, select_multiple, date, …
  listName: string | null;
  orOther: boolean;
  required: boolean;
  relevant: string | null;  // skip logic (its own, or an enclosing group's)
  repeats: string[];        // enclosing repeat groups, outermost first
};
export type KoboChoice = { name: string; label: string };
export type KoboSchema = {
  version: string | null;
  fields: KoboField[];
  choices: Record<string, KoboChoice[]>;
  meta: { start?: string; end?: string; today?: string };
};
export type KoboMapping = {
  school: string | null;      // xpath holding the school (code or name)
  schoolRequired: boolean;
  county: string | null;
  officer: string | null;     // xpath holding the portal officer id
  officerRequired: boolean;
  date: string | null;        // xpath holding the visit / observation date
};
export type Severity = "error" | "warning";
export const RULES = ["required", "type", "school", "county", "officer", "duplicate", "date"] as const;
export type Rule = (typeof RULES)[number];
export type Issue = { rule: Rule; severity: Severity; field: string | null; message: string; value: string | null };
export const RECORD_STATUSES = ["valid", "invalid", "duplicate", "rejected", "removed"] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];

/* ------------------------------------------------------------ schema */

// Question types that hold no answer worth validating or charting.
const NON_ANSWER = new Set([
  "note", "calculate", "begin_group", "end_group", "begin_repeat", "end_repeat",
  "begin_kobomatrix", "end_kobomatrix", "deviceid", "subscriberid", "simserial",
  "phonenumber", "username", "audit", "background-audio", "xml-external", "csv-external",
]);
const META = new Set(["start", "end", "today"]);
const truthy = (v: unknown) => v === true || /^(true|yes|1)$/i.test(String(v ?? "").trim());

export function koboLabel(label: unknown, fallback: string): string {
  if (Array.isArray(label)) return String(label.find((x) => x != null && String(x).trim()) ?? fallback);
  if (typeof label === "string" && label.trim()) return label;
  return fallback;
}

/** The survey's questions (with their full data paths) and choice lists,
    from a KoboToolbox asset's `content`. */
export function parseKoboSchema(content: Any, version: string | null = null): KoboSchema {
  const fields: KoboField[] = [];
  const meta: KoboSchema["meta"] = {};
  const stack: { name: string; repeat: boolean; relevant: string | null }[] = [];
  for (const row of content?.survey ?? []) {
    const rawType = String(row.type ?? "").trim();
    const name = String(row.name ?? row.$autoname ?? "").trim();
    if (rawType === "begin_group" || rawType === "begin_repeat" || rawType === "begin group" || rawType === "begin repeat") {
      stack.push({ name, repeat: rawType.includes("repeat"), relevant: row.relevant ? String(row.relevant) : null });
      continue;
    }
    if (rawType === "end_group" || rawType === "end_repeat" || rawType === "end group" || rawType === "end repeat") {
      stack.pop();
      continue;
    }
    if (!name || !rawType) continue;
    const path = [...stack.map((g) => g.name), name].filter(Boolean).join("/");
    if (META.has(rawType)) { meta[rawType as "start"] = path; continue; }
    if (NON_ANSWER.has(rawType)) continue;
    let type = rawType;
    let listName: string | null = row.select_from_list_name ?? null;
    let orOther = false;
    const sel = /^(select_one|select_multiple)\s+(\S+)(\s+or_other)?$/.exec(rawType);
    if (sel) { type = sel[1]; listName = sel[2]; orOther = !!sel[3]; }
    if (/^select_(one|multiple)_from_file/.test(type)) { type = "text"; listName = null; }
    const repeats: string[] = [];
    for (let i = 0; i < stack.length; i++) {
      if (stack[i].repeat) repeats.push(stack.slice(0, i + 1).map((g) => g.name).join("/"));
    }
    fields.push({
      xpath: path, name, label: koboLabel(row.label, name), type, listName, orOther,
      required: truthy(row.required),
      relevant: row.relevant ? String(row.relevant) : [...stack].reverse().find((g) => g.relevant)?.relevant ?? null,
      repeats,
    });
  }
  const choices: Record<string, KoboChoice[]> = {};
  for (const ch of content?.choices ?? []) {
    if (!ch.list_name) continue;
    (choices[ch.list_name] ||= []).push({ name: String(ch.name ?? ch.$autovalue ?? ""), label: koboLabel(ch.label, String(ch.name ?? "")) });
  }
  return { version, fields, choices, meta };
}

/** A first guess at which questions hold the school, county, officer and
    date. The Education Team can change it. */
export function detectMapping(schema: KoboSchema, officerField: string): KoboMapping {
  const top = schema.fields.filter((f) => !f.repeats.length);
  const byName = (names: string[]) => top.find((f) => names.includes(f.name.toLowerCase()));
  const byLabel = (re: RegExp, types?: string[]) => top.find((f) => re.test(f.label) && (!types || types.includes(f.type)));
  const officer = top.find((f) => f.name === officerField) ?? null;
  const school = byName(["school_code", "schoolcode", "school_id", "emis_code", "emis", "school", "school_name", "schoolname", "name_of_school", "name_of_the_school"])
    ?? byLabel(/^(name of (the )?school|school( name| code)?)\b/i, ["text", "select_one", "hidden", "barcode"]) ?? null;
  const county = byName(["county", "county_name", "countyname"])
    ?? byLabel(/^(name of (the )?)?county\b(?!.*sub)/i, ["text", "select_one"]) ?? null;
  const date = byName(["visit_date", "date_of_visit", "observation_date", "date_of_observation", "assessment_date", "survey_date", "date"])
    ?? top.find((f) => f.type === "date") ?? null;
  return {
    school: school?.xpath ?? null, schoolRequired: !!school,
    county: county?.xpath ?? null,
    officer: officer?.xpath ?? null, officerRequired: !!officer,
    date: date?.xpath ?? null,
  };
}

/* ------------------------------------------------------------ reading a submission */

const lastSeg = (k: string) => k.split("/").pop() ?? k;

/** A value at a full data path, tolerating exports that drop group names. */
function pick(obj: Any, xpath: string): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  if (xpath in obj) return obj[xpath];
  const name = lastSeg(xpath);
  if (name in obj) return obj[name];
  const key = Object.keys(obj).find((k) => !k.startsWith("_") && (k.endsWith("/" + name)));
  return key ? obj[key] : undefined;
}
/** The instances of a (possibly nested) repeat group in a submission. */
function repeatItems(obj: Any, chain: string[]): Any[] {
  if (!chain.length) return [obj];
  const arr = pick(obj, chain[0]);
  if (!Array.isArray(arr)) return [];
  return arr.flatMap((it) => repeatItems(it, chain.slice(1)));
}
/** One value for a plain question; one per repeat for a question in a repeat. */
export function readField(row: Any, f: KoboField): unknown[] {
  return f.repeats.length ? repeatItems(row, f.repeats).map((it) => pick(it, f.xpath)) : [pick(row, f.xpath)];
}

/* ------------------------------------------------------------ normalization */

const isBlank = (v: unknown) => v === undefined || v === null || (typeof v === "string" && !v.trim());
const squash = (v: unknown) => String(v).trim().replace(/\s+/g, " ");

/** One answer, normalized to its type — or the reason it doesn't fit. */
export function normalizeValue(f: KoboField, raw: unknown, choices: Record<string, KoboChoice[]>):
  { value: unknown; problem?: string } {
  if (isBlank(raw)) return { value: null };
  const s = squash(raw);
  const list = f.listName ? choices[f.listName] : undefined;
  const known = list ? new Set(list.map((c) => c.name)) : null;
  switch (f.type) {
    case "integer":
      return /^[-+]?\d+$/.test(s) ? { value: Number(s) } : { value: null, problem: "should be a whole number" };
    case "decimal":
    case "range": {
      const n = Number(s);
      return s !== "" && Number.isFinite(n) ? { value: n } : { value: null, problem: "should be a number" };
    }
    case "select_one":
      if (known && !known.has(s) && !f.orOther) return { value: s, problem: "isn't one of the survey's options" };
      return { value: s };
    case "select_multiple": {
      const toks = s.split(" ").filter(Boolean);
      const bad = known && !f.orOther ? toks.filter((t) => !known.has(t)) : [];
      return bad.length ? { value: toks, problem: `has options the survey doesn't list (${bad.join(", ")})` } : { value: toks };
    }
    case "date": {
      const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
      return m && validDate(m[1]) ? { value: m[1] } : { value: null, problem: "isn't a valid date" };
    }
    case "datetime": {
      const t = Date.parse(s);
      return Number.isFinite(t) ? { value: new Date(t).toISOString() } : { value: null, problem: "isn't a valid date and time" };
    }
    case "time":
      return /^\d{2}:\d{2}(:\d{2})?/.test(s) ? { value: s.slice(0, 8) } : { value: null, problem: "isn't a valid time" };
    case "geopoint": {
      const [lat, lon, alt, acc] = s.split(" ").map(Number);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        return { value: null, problem: "isn't a valid GPS point" };
      }
      return { value: { lat, lon, alt: Number.isFinite(alt) ? alt : null, accuracy: Number.isFinite(acc) ? acc : null } };
    }
    case "acknowledge":
      return { value: /^(ok|true|yes|1)$/i.test(s) };
    default:
      return { value: s };
  }
}
function validDate(d: string) {
  const t = Date.parse(d + "T00:00:00Z");
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d;
}

/** How school names are compared: case, accents and punctuation ignored. */
export function nameKey(v: unknown): string {
  return String(v ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}
const codeKey = (v: unknown) => String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/* ------------------------------------------------------------ the portal's reference data */

export type School = { id: string; name: string; code: string; county: string };
export type Profile = { role: string; status: string; county: string | null };
export type PipelineContext = {
  schema: KoboSchema;
  mapping: KoboMapping;
  schools: School[];
  counties: { name: string; code: string }[];
  aliases: Record<string, string>;      // nameKey(value) -> school id
  profiles: Record<string, Profile>;
  now: Date;
};

/** A school from a code, a known alias, or a name: the exact (normalized)
    name first, then the same name without the words that only say what kind
    of school it is — "Aitong primary school" is Aitong, "Olesere Pri." is
    Olesere. Both are exact word-for-word matches; anything looser (a
    misspelling) is only ever suggested (suggestSchool), never linked. */
export function resolveSchool(value: string, ctx: Pick<PipelineContext, "schools" | "aliases">, county: string | null = null):
  { school: School; via: "code" | "alias" | "name" } | { ambiguous: School[] } | null {
  const byCode = ctx.schools.find((s) => codeKey(s.code) === codeKey(value));
  if (byCode && codeKey(value)) return { school: byCode, via: "code" };
  const aliasId = ctx.aliases[nameKey(value)];
  const alias = aliasId ? ctx.schools.find((s) => s.id === aliasId) : undefined;
  if (alias) return { school: alias, via: "alias" };
  const pick = (match: (s: School) => boolean) => {
    let named = ctx.schools.filter(match);
    if (named.length > 1 && county) named = named.filter((s) => s.county === county);
    return named;
  };
  let named = pick((s) => nameKey(s.name) === nameKey(value));
  if (!named.length) {
    const core = distinctive(value).join(" ");
    if (core) named = pick((s) => distinctive(s.name).join(" ") === core);
  }
  if (named.length === 1) return { school: named[0], via: "name" };
  if (named.length > 1) return { ambiguous: named };
  return null;
}
// Words that say what kind of school it is, not which one.
const GENERIC = new Set(["school", "primary", "pri", "secondary", "sec", "junior", "senior", "comprehensive",
  "academy", "the", "of", "and", "public", "mixed", "boys", "girls", "day", "boarding", "pry", "sch"]);
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}
const distinctive = (v: string) => nameKey(v).split(" ").filter((w) => w.length > 2 && !GENERIC.has(w));
const near = (a: string, b: string) => a === b || (a.length >= 4 && b.length >= 4 && editDistance(a, b) <= 1);

/** The closest portal school, to suggest when a value doesn't match: the
    one whose distinctive words (not "primary", "school"…) it shares, with
    a one-letter slip allowed. Only a suggestion — never linked silently. */
export function suggestSchool(value: string, schools: School[]): School | null {
  const words = distinctive(value);
  if (!words.length) return null;
  let best: School | null = null, score = 0;
  for (const s of schools) {
    const sw = distinctive(s.name);
    if (!sw.length) continue;
    const hit = sw.filter((w) => words.some((x) => near(x, w))).length;
    const j = hit / Math.max(sw.length, words.length);
    if (j > score) { score = j; best = s; }
  }
  return score >= 0.5 ? best : null;
}
export function resolveCounty(value: string, counties: { name: string; code: string }[]): string | null {
  const v = nameKey(value).replace(/ county$/, "");
  const c = counties.find((x) => nameKey(x.name) === v || nameKey(x.code) === v);
  return c?.name ?? null;
}

/* ------------------------------------------------------------ one submission */

export type RawSubmission = {
  koboId: number;
  instanceId: string | null;
  submittedAt: string | null;
  koboValidation: string | null;   // e.g. "validation_status_not_approved"
  removed: boolean;                 // deleted in KoboToolbox since
  payload: Any;
};
export type ProcessedRecord = {
  koboId: number;
  instanceId: string | null;
  submittedAt: string | null;
  observedOn: string | null;
  schoolId: string | null;
  schoolValue: string | null;
  county: string | null;
  officerId: string | null;
  status: RecordStatus;
  duplicateOf: number | null;      // koboId of the earlier submission
  answers: Record<string, unknown>;
  answersHash: string;
  /** Identifies a re-sent copy: the answers plus the form's own start/end
      times. Null when that isn't distinctive enough to call a duplicate
      (a short form with no start time — two real visits can match). */
  identityHash: string | null;
  issues: Issue[];
  errorCount: number;
  warningCount: number;
};

/** Stable JSON (sorted keys), so equal data always hashes the same. */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as Any).sort().map((k) => `${JSON.stringify(k)}:${stableStringify((v as Any)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const DAY = 864e5;

/** Validate and normalize one submission (duplicates are judged in
    processBatch, which sees the others). */
export function processOne(raw: RawSubmission, ctx: PipelineContext): ProcessedRecord {
  const { schema, mapping } = ctx;
  const issues: Issue[] = [];
  const add = (rule: Rule, severity: Severity, field: string | null, message: string, value: unknown = null) =>
    issues.push({ rule, severity, field, message, value: value == null ? null : String(value).slice(0, 200) });
  const fieldBy = new Map(schema.fields.map((f) => [f.xpath, f]));

  // 1–2. Required fields and data types, question by question.
  const answers: Record<string, unknown> = {};
  for (const f of schema.fields) {
    const raws = readField(raw.payload, f);
    const vals: unknown[] = [];
    raws.forEach((r, i) => {
      const where = f.repeats.length ? ` (entry ${i + 1})` : "";
      if (isBlank(r)) {
        // KoboToolbox enforces "required" on every question it shows, so a
        // blank one with skip logic was hidden on purpose — not a problem.
        // Without skip logic, a blank required answer means the data was
        // edited or imported around the form's own checks.
        if (f.required && !f.relevant) add("required", "error", f.xpath, `“${f.label}”${where} is required but empty`);
        vals.push(null);
        return;
      }
      const n = normalizeValue(f, r, schema.choices);
      if (n.problem) add("type", "error", f.xpath, `“${f.label}”${where} ${n.problem}`, r);
      vals.push(n.value);
    });
    answers[f.xpath] = f.repeats.length ? vals : vals[0] ?? null;
  }
  const answerOf = (xpath: string | null) => (xpath && !fieldBy.get(xpath)?.repeats.length ? answers[xpath] : null);
  const choiceLabel = (xpath: string, v: unknown) => {
    const f = fieldBy.get(xpath);
    return f?.listName ? schema.choices[f.listName]?.find((c) => c.name === v)?.label ?? null : null;
  };

  // 3. County (canonical name), if the survey asks for it.
  let countyValue: string | null = null;
  let county: string | null = null;
  if (mapping.county) {
    const v = answerOf(mapping.county);
    if (!isBlank(v)) {
      countyValue = String(v);
      county = resolveCounty(countyValue, ctx.counties) ?? resolveCounty(choiceLabel(mapping.county, v) ?? "", ctx.counties);
      if (!county) add("county", "error", mapping.county, `County “${countyValue}” isn't one of the portal's counties`, countyValue);
    }
  }

  // 4. School code (or name, or a saved alias).
  let schoolId: string | null = null;
  let schoolValue: string | null = null;
  if (mapping.school) {
    const v = answerOf(mapping.school);
    if (isBlank(v)) {
      add("school", mapping.schoolRequired ? "error" : "warning", mapping.school, "No school given");
    } else {
      schoolValue = String(v);
      const label = choiceLabel(mapping.school, v);
      const tries = [schoolValue, label, schoolValue.replace(/_/g, " ")].filter((x): x is string => !!x);
      let found: ReturnType<typeof resolveSchool> = null;
      for (const t of tries) {
        found = resolveSchool(t, ctx, county);
        if (found) break;
      }
      if (found && "school" in found) {
        schoolId = found.school.id;
        if (county && county !== found.school.county) {
          add("county", "error", mapping.county, `County “${countyValue}” doesn't match ${found.school.name}, which is in ${found.school.county}`, countyValue);
        }
        county = found.school.county;
      } else if (found && "ambiguous" in found) {
        add("school", "error", mapping.school, `“${label ?? schoolValue}” matches more than one portal school (${found.ambiguous.map((s) => s.code).join(", ")}) — add the county or use the school code`, schoolValue);
      } else {
        const hint = suggestSchool(label ?? schoolValue, ctx.schools);
        add("school", "error", mapping.school, `School “${label ?? schoolValue}” isn't a portal school${hint ? ` — did you mean ${hint.name} (${hint.code})?` : ""}`, label ?? schoolValue);
      }
    }
  }
  if (mapping.county && !countyValue && !schoolId) add("county", "warning", mapping.county, "No county given");

  // 5. Officer: a real, active portal account.
  let officerId: string | null = null;
  if (mapping.officer) {
    const v = answerOf(mapping.officer);
    if (isBlank(v)) {
      add("officer", mapping.officerRequired ? "error" : "warning", mapping.officer, "Not linked to a field officer — the survey wasn't opened from the portal");
    } else {
      const p = ctx.profiles[String(v)];
      if (!p) add("officer", "error", mapping.officer, "The officer reference doesn't match any portal account", v);
      else {
        officerId = String(v);
        if (p.status !== "active") add("officer", "warning", mapping.officer, `Filled by an account that is now ${p.status}`);
        if (p.role !== "field_officer") add("officer", "warning", mapping.officer, `Filled by a ${p.role.replace("_", " ")} account, not a field officer`);
        if (p.county && county && p.county !== county) add("officer", "warning", mapping.officer, `The officer works in ${p.county}; the school is in ${county}`);
      }
    }
  }

  // 6. Dates: the visit date, against when Kobo received it.
  const submitted = raw.submittedAt && Number.isFinite(Date.parse(raw.submittedAt)) ? new Date(raw.submittedAt) : null;
  const metaVal = (p?: string) => (p ? pick(raw.payload, p) : undefined);
  const mapped = mapping.date ? answerOf(mapping.date) : null;
  const today = metaVal(schema.meta.today);
  const start = metaVal(schema.meta.start);
  const end = metaVal(schema.meta.end);
  const dateOf = (v: unknown) => {
    if (isBlank(v)) return null;
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v));
    return m && validDate(m[1]) ? m[1] : null;
  };
  const observedOn = dateOf(mapped) ?? dateOf(today) ?? dateOf(start) ?? (submitted ? submitted.toISOString().slice(0, 10) : null);
  if (observedOn) {
    const obs = Date.parse(observedOn + "T00:00:00Z");
    const label = mapping.date ? fieldBy.get(mapping.date)?.label ?? "Date" : "Date";
    if (obs > ctx.now.getTime() + DAY) add("date", "error", mapping.date, `${label} (${observedOn}) is in the future`, observedOn);
    else if (submitted && obs > submitted.getTime() + DAY) add("date", "error", mapping.date, `${label} (${observedOn}) is after the submission reached KoboToolbox`, observedOn);
    else if (submitted && submitted.getTime() - obs > 365 * DAY) add("date", "warning", mapping.date, `${label} (${observedOn}) is over a year before the submission — check the year`, observedOn);
  }
  if (!isBlank(start) && !isBlank(end) && Date.parse(String(end)) < Date.parse(String(start))) {
    add("date", "warning", null, "The form was finished before it was started — check the device clock");
  }

  const answersHash = sha256(stableStringify(answers));
  const filled = Object.values(answers).filter((v) => !isBlank(v) && !(Array.isArray(v) && v.every(isBlank))).length;
  const identityHash = !isBlank(start) || filled >= 5
    ? sha256(stableStringify({ answers, start: start ?? null, end: end ?? null }))
    : null;
  const errorCount = issues.filter((i) => i.severity === "error").length;
  return {
    koboId: raw.koboId, instanceId: raw.instanceId, submittedAt: submitted?.toISOString() ?? null, observedOn,
    schoolId, schoolValue, county, officerId,
    status: raw.removed ? "removed"
      : raw.koboValidation === "validation_status_not_approved" ? "rejected"
      : errorCount ? "invalid" : "valid",
    duplicateOf: null, answers, answersHash, identityHash, issues, errorCount, warningCount: issues.length - errorCount,
  };
}

/* ------------------------------------------------------------ a whole survey (duplicates) */

/** Every submission of one survey, oldest first, so the first copy of a
    duplicate is the one that counts. 7. Duplicates:
      - the same answers, or the same Kobo instance id, as an earlier
        submission → status "duplicate" (kept off the dashboards);
      - the same officer, school and date as an earlier one → a warning
        (two classroom observations at one school in a day are normal). */
export function processBatch(raws: RawSubmission[], ctx: PipelineContext): ProcessedRecord[] {
  const sorted = [...raws].sort((a, b) =>
    String(a.submittedAt ?? "").localeCompare(String(b.submittedAt ?? "")) || a.koboId - b.koboId);
  const byHash = new Map<string, number>();
  const byInstance = new Map<string, number>();
  const byVisit = new Map<string, number>();
  const out: ProcessedRecord[] = [];
  for (const raw of sorted) {
    const r = processOne(raw, ctx);
    if (r.status === "removed" || r.status === "rejected") { out.push(r); continue; }
    const sameAnswers = r.identityHash ? byHash.get(r.identityHash) : undefined;
    const first = sameAnswers ?? (r.instanceId ? byInstance.get(r.instanceId) : undefined);
    if (first !== undefined) {
      r.issues.push({ rule: "duplicate", severity: "error", field: null, message: `${sameAnswers !== undefined ? "Same answers" : "Same Kobo instance"} as submission #${first} — a copy sent twice`, value: String(first) });
      r.status = "duplicate";
      r.duplicateOf = first;
      r.errorCount++;
      out.push(r);
      continue;
    }
    if (r.identityHash) byHash.set(r.identityHash, r.koboId);
    if (r.instanceId) byInstance.set(r.instanceId, r.koboId);
    if (r.officerId && r.schoolId && r.observedOn) {
      const key = `${r.officerId}|${r.schoolId}|${r.observedOn}`;
      const prior = byVisit.get(key);
      if (prior !== undefined) {
        r.issues.push({ rule: "duplicate", severity: "warning", field: null, message: `Same officer, school and date as submission #${prior} — check it wasn't entered twice`, value: String(prior) });
        r.warningCount++;
      } else byVisit.set(key, r.koboId);
    }
    out.push(r);
  }
  return out;
}

/** Does this record count on the dashboards? Valid ones do, unless a
    person excluded it; anything else only if a person accepted it. */
export function counts(status: string, review: string | null | undefined): boolean {
  if (status === "removed") return false;
  if (review === "excluded") return false;
  return status === "valid" || review === "accepted";
}

/* ------------------------------------------------------------ dashboards: charts per question */

/** One chart per question, tallied from normalized records — the same
    shape the Survey results page has always drawn. */
export function summarizeAnswers(schema: KoboSchema, answersList: Record<string, unknown>[], skip: Set<string> = new Set()) {
  const questions: Any[] = [];
  for (const f of schema.fields) {
    if (skip.has(f.xpath) || f.type === "hidden") continue;
    const vals = answersList.flatMap((a) => {
      const v = a?.[f.xpath];
      return f.repeats.length && Array.isArray(v) ? v : [v];
    }).filter((v) => !isBlank(v) && !(Array.isArray(v) && !v.length));
    if (f.type === "select_one" || f.type === "select_multiple") {
      const opts = schema.choices[f.listName ?? ""] ?? [];
      const tally: Record<string, number> = Object.fromEntries(opts.map((o) => [o.name, 0]));
      let other = 0;
      for (const v of vals) {
        for (const t of Array.isArray(v) ? v : [v]) {
          if (String(t) in tally) tally[String(t)]++;
          else other++;
        }
      }
      const data = opts.map((o) => ({ label: o.label, value: tally[o.name] }));
      if (other) data.push({ label: "Other", value: other });
      questions.push({
        name: f.xpath, label: f.label, type: f.type, answered: vals.length,
        chart: f.type === "select_one" && opts.length > 0 && opts.length <= 6 ? "donut" : "bar", data,
      });
    } else if (f.type === "integer" || f.type === "decimal" || f.type === "range") {
      const nums = vals.map(Number).filter((n) => Number.isFinite(n));
      let data: unknown = null;
      if (nums.length) {
        let min = Infinity, max = -Infinity, sum = 0;
        for (const n of nums) { if (n < min) min = n; if (n > max) max = n; sum += n; }
        const buckets = Math.min(8, Math.max(1, new Set(nums).size));
        const step = (max - min) / buckets || 1;
        const hist = Array.from({ length: buckets }, (_, i) => ({
          label: step >= 1 ? `${Math.round(min + i * step)}–${Math.round(min + (i + 1) * step)}` : `${(min + i * step).toFixed(1)}`,
          value: 0,
        }));
        for (const n of nums) hist[Math.min(buckets - 1, Math.max(0, Math.floor((n - min) / step)))].value++;
        data = { count: nums.length, mean: Math.round((sum / nums.length) * 100) / 100, min, max, histogram: hist };
      }
      questions.push({ name: f.xpath, label: f.label, type: f.type, answered: nums.length, chart: "number", data });
    } else if (f.type === "geopoint") {
      questions.push({ name: f.xpath, label: f.label, type: f.type, answered: vals.length, chart: "list", data: [`${vals.length} GPS point${vals.length === 1 ? "" : "s"} recorded`] });
    } else {
      questions.push({
        name: f.xpath, label: f.label, type: f.type, answered: vals.length, chart: "list",
        data: vals.slice(-50).reverse().map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v))),
      });
    }
  }
  return questions;
}
