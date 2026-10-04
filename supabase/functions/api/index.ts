/**
 * HPF Digital Learning Portal — backend API.
 *
 * The static frontend never touches Postgres or Storage directly. Every
 * read and write goes through this one Edge Function, which:
 *   - authenticates the caller (staff: Supabase Auth JWT; learners: an
 *     opaque PIN-issued session token, "hpl_<token>"),
 *   - loads their role and account status from `public.profiles` /
 *     `public.learners` (never from a JWT claim or anything the browser
 *     sends), and authorizes each route by PERMISSION (permissions.ts),
 *   - does all data access with the service-role key, which bypasses the
 *     deny-all RLS on every table.
 *
 * Deployed with verify_jwt = false: auth is enforced here, per route.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  ACCOUNT_STATUSES, can, canManageAccount, COUNTY_ROLES, effectivePermissions, GRANTABLE_PERMISSIONS, grantableRoles,
  isPermission, type Permission, PERMISSION_GROUPS, PERMISSION_LABEL, PERMISSIONS, permissionsFor, type Role, ROLE_LABEL, ROLE_PERMISSIONS, SELF_REQUESTABLE_ROLES,
  STAFF_ROLES, STATUS_TRANSITIONS, GRADES, nextGrade, type EnrollmentStatus, WORKSPACE,
} from "./permissions.ts";
import { ASSIGNABLE_ROLES, countiesInScope, inPlaceScope, matchCounty, narrowInput, type PlaceScope, placeScopeFor, type ScopeRow } from "./scope.ts";
import {
  ASSIGNMENT_STATUSES, type AssignmentStatus, autoMark, type Band, bandFor, cleanQuestions, cleanResponse,
  groupResults, isAutoMarked, isLate, MAX_FILES_PER_ANSWER, pairsOf, percentOf, type Question,
  RESULT_DIMENSIONS, type ResultAssignment, type ResultDimension, type ResultSubmission, round2, summarize,
  expectedFrom,
} from "./lms.ts";
import { buildIntelligence, VISIT_TYPES as INTEL_VISIT_TYPES } from "./intelligence.ts";
import { buildImpact, GENDERS } from "./impact.ts";
import { buildNotifications, missingVisitForms } from "./notifications.ts";
import { type Column, GENDER_TEXT, REPORTS, STATUS_TEXT, reportsFor, rowCount, type Section } from "./reports.ts";
import {
  counts as countsOnDashboards, detectMapping, type KoboMapping, type KoboSchema, nameKey, parseKoboSchema,
  type PipelineContext, processBatch, RULES as KOBO_RULES, sha256, stableStringify, suggestSchool, summarizeAnswers,
} from "./kobo_pipeline.ts";
import {
  checkedIn, detectAll as detectDataQuality, type DqStatus, ISSUE_TYPE_IDS as DQ_TYPE_IDS, ISSUE_TYPES as DQ_TYPES,
  type IssueType as DqIssueType, qualityScore, SEVERITIES as DQ_SEVERITIES, type Snapshot as DqSnapshot,
  STATUS_MOVES as DQ_STATUS_MOVES, STATUSES as DQ_STATUSES,
} from "./data_quality.ts";
import { invitationEmail, type MailMessage, mailReady, type MailResult, sendMail } from "./mail.ts";
import {
  achievement, cleanSourceConfig, type Computed, koboInScope, koboMeasure, periodRange, PORTAL_METRICS,
  type Scope as MeScope, targetFor, UNITS as ME_UNITS,
} from "./me.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SECRET_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/** Service-role client — bypasses RLS. Never expose this key to a browser. */
let admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
/** Tests only (authz_test.ts): swap in an in-memory stand-in. */
export function __setAdminClientForTests(client: unknown) {
  admin = client as SupabaseClient;
}
/** Invitation email (mail.ts). Tests swap in a recorder. */
let mailer: (m: MailMessage) => Promise<MailResult> = (m) => sendMail(m);
export function __setMailerForTests(fn: ((m: MailMessage) => Promise<MailResult>) | null) {
  mailer = fn ?? ((m) => sendMail(m));
}

const LIBRARY_BUCKET = "library";
const DOWNLOAD_TTL = 60 * 60; // 1 h signed download URLs
// Learners mostly sign in on shared school devices — keep a session to
// one school day rather than letting the next child inherit it.
const LEARNER_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCK_MINUTES = 15;
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const PIN_RE = /^\d{4}$/;

// ---------------------------------------------------------------- helpers

const safeSegment = (s: string) =>
  String(s).replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, " ").trim() || "file";
const safePath = (p: string) => String(p).split("/").map(safeSegment).join("/");

const rid = (prefix: string) =>
  prefix + "_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);

/* Supabase's API returns at most 1,000 rows per request and says nothing
   when it stops, so any read that feeds a total, a chart or a full list
   pages through with range() until a short page comes back. `build` must
   return a fresh query each call, ordered by a unique key (or ending with
   one as a tie-breaker) so pages never overlap or skip rows. */
const PAGE_SIZE = 1000;
// deno-lint-ignore no-explicit-any
async function selectAll(build: () => any): Promise<{ data: Record<string, any>[]; error: { message: string } | null }> {
  // deno-lint-ignore no-explicit-any
  const rows: Record<string, any>[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await build().range(from, from + PAGE_SIZE - 1);
    if (error) return { data: rows, error };
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) return { data: rows, error: null };
  }
}

// ---------------------------------------------------------------- schools & codes
/* Counties (`counties`) and the schools in each (`schools`) are both
   managed by the education team, and are the one source for every
   county/school list in the portal. Every county has a short code
   (NRK); every school gets a code from its county (NRK-001 = Narok's
   first school), and everyone placed in a school — teachers, school
   heads, learners — gets a personal code under it: NRK-001-T01,
   NRK-001-H01, NRK-001-L0001. The school row is the source of truth;
   the plain `school`/`county` text on profiles/learners is kept in sync
   with it so every existing report, filter and overview keeps working. */
type County = { name: string; code: string };
async function loadCounties(): Promise<County[]> {
  const { data, error } = await admin.from("counties").select("name, code").order("created_at").order("name");
  if (error) throw new Error(error.message);
  return (data ?? []) as County[];
}
async function isCounty(name: unknown) {
  if (!name) return false;
  const { data } = await admin.from("counties").select("name").eq("name", String(name)).maybeSingle();
  return !!data;
}
const SCHOOL_ROLES = ["teacher", "school_leader"];
const CODE_KIND: Record<string, { letter: string; width: number }> = {
  teacher: { letter: "T", width: 2 },
  school_leader: { letter: "H", width: 2 },
  learner: { letter: "L", width: 4 },
};
type School = { id: string; name: string; county: string; code: string };

const isUniqueViolation = (e: unknown) => (e as { code?: string } | null)?.code === "23505";

async function loadSchool(id: unknown): Promise<School | null> {
  if (!id) return null;
  const { data } = await admin.from("schools").select("id, name, county, code").eq("id", String(id)).maybeSingle();
  return (data as School) ?? null;
}

/** Next personal code in a school for this kind of person. Numbers come
    from a per-school counter that only ever goes up, so a code that was
    once someone's (who later moved school) is never handed to anyone
    else. The counter is bumped with a compare-and-set, retried if two
    requests race. */
async function nextUserCode(school: School, role: string) {
  const kind = CODE_KIND[role];
  const prefix = `${school.code}-${kind.letter}`;
  for (let attempt = 0; attempt < 8; attempt++) {
    const { data: row } = await admin.from("school_code_counters").select("last")
      .eq("school_id", school.id).eq("kind", kind.letter).maybeSingle();
    let next: number | null = null;
    if (!row) {
      const table = role === "learner" ? "learners" : "profiles";
      const { data } = await admin.from(table).select("user_code").like("user_code", `${prefix}%`);
      const used = (data ?? []).map((r) => parseInt(String(r.user_code).slice(prefix.length), 10) || 0);
      next = Math.max(0, ...used) + 1;
      const { error } = await admin.from("school_code_counters")
        .insert({ school_id: school.id, kind: kind.letter, last: next });
      if (error) { if (isUniqueViolation(error)) continue; throw new Error(error.message); }
    } else {
      const { data: bumped, error } = await admin.from("school_code_counters")
        .update({ last: (row.last as number) + 1 })
        .eq("school_id", school.id).eq("kind", kind.letter).eq("last", row.last)
        .select("last");
      if (error) throw new Error(error.message);
      if (!bumped?.length) continue; // someone else took that number — try again
      next = bumped[0].last as number;
    }
    return `${prefix}${String(next).padStart(kind.width, "0")}`;
  }
  throw new Error("Could not generate a code — please try again");
}

/** Writes a school placement (school_id, synced school/county text and a
    fresh personal code) onto one profile or learner row. Retries if two
    people were given the same code at the same moment. */
async function placeInSchool(table: "profiles" | "learners", id: string, school: School, role: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const user_code = await nextUserCode(school, role);
    const { data, error } = await admin.from(table)
      .update({ school_id: school.id, school: school.name, county: school.county, user_code })
      .eq("id", id).select().single();
    if (!error) return data;
    if (!isUniqueViolation(error)) throw new Error(error.message);
  }
  throw new Error("Could not generate a code — please try again");
}

// ---------------------------------------------------------------- KoboToolbox

type KoboConfig = { base_url: string; api_token: string; officer_field: string; webhook_secret_hash?: string | null; webhook_secret_set_at?: string | null };

async function loadKoboConfig(): Promise<KoboConfig | null> {
  const { data } = await admin.from("kobo_config").select("*").eq("id", 1).maybeSingle();
  return (data as KoboConfig) ?? null;
}

async function koboFetch(cfg: KoboConfig, path: string) {
  const url = cfg.base_url.replace(/\/+$/, "") + path;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    return await fetch(url, {
      signal: ctrl.signal,
      headers: { Authorization: `Token ${cfg.api_token}`, Accept: "application/json" },
    });
  } finally {
    clearTimeout(t);
  }
}

/** A Kobo failure in words for the Sync center — short, and never the token. */
function koboErrorText(e: unknown): string {
  const msg = String((e as Error)?.message ?? e ?? "Unknown error");
  if (/error sending request|fetch failed|failed to fetch|getaddrinfo|enotfound|dns|connect|unreachable|timed? ?out|network/i.test(msg)) {
    return "Couldn't reach KoboToolbox (network)";
  }
  return msg.replace(/token\s+\S+/gi, "token").slice(0, 300);
}

async function koboJson(cfg: KoboConfig, path: string) {
  const res = await koboFetch(cfg, path);
  if (!res.ok) {
    throw new Error(
      res.status === 401 || res.status === 403
        ? "KoboToolbox rejected the API token"
        : `KoboToolbox returned ${res.status}`,
    );
  }
  return res.json();
}

/** Read the officer-ref value off a Kobo submission row (handles grouped names). */
function pickOfficerRef(row: Record<string, unknown>, field: string): string | null {
  if (row[field] != null && String(row[field]).trim()) return String(row[field]).trim();
  const key = Object.keys(row).find((k) => k === field || k.endsWith("/" + field));
  return key && String(row[key]).trim() ? String(row[key]).trim() : null;
}

/* Every submission for one survey. Kobo returns at most 30,000 rows per
   request and signals more only through `next`, so read page by page. */
const KOBO_PAGE_SIZE = 5000;
async function koboAllSubmissions(cfg: KoboConfig, assetUid: string): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  const base = `/api/v2/assets/${encodeURIComponent(assetUid)}/data/?format=json&limit=${KOBO_PAGE_SIZE}`;
  for (let start = 0; ; start += KOBO_PAGE_SIZE) {
    const page = await koboJson(cfg, `${base}&start=${start}`);
    const batch: Record<string, unknown>[] = page.results ?? [];
    rows.push(...batch);
    if (!page.next || !batch.length) return rows;
  }
}

function hashPin(pin: string, salt: string) {
  return scryptSync(pin, salt, 32).toString("hex");
}
function pinMatches(pin: string, salt: string, hash: string) {
  const a = Buffer.from(hashPin(pin, salt), "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Three content destinations; legacy values fold in. */
function normalizeAudience(a: string | null | undefined): "staff" | "library" | "school_leader" {
  if (a === "school_leader") return "school_leader";
  return a === "staff" || a === "teacher" ? "staff" : "library";
}
/** Which shelf an item is on decides which read permission it needs;
    whoever manages the library sees every shelf. */
function canSeeLibrary(audience: string | null | undefined, who: Role | ReadonlySet<Permission>): boolean {
  const has = (p: Permission) => (typeof who === "string" ? can(who, p) : who.has(p));
  if (has("library.manage")) return true;
  const dest = normalizeAudience(audience);
  if (dest === "school_leader") return has("library.read.head");
  if (dest === "staff") return has("library.read.staff");
  return has("library.read.learner");
}

type LibFile = { name: string; path: string; size: number };

/* Every file gets `viewUrl` — signed with no `download` option, so it's
   served with its real content-type and no attachment disposition and
   renders inside the portal's viewer. Only the education team also gets
   `downloadUrl`, signed with `download` (Content-Disposition:
   attachment), which is what the frontend's Download button uses —
   every other role is view-only. The storage path is never sent. */
async function signFiles(files: LibFile[], canDownload: boolean) {
  return await Promise.all(
    (files ?? []).map(async (f) => {
      const bucket = admin.storage.from(LIBRARY_BUCKET);
      const { data: view } = await bucket.createSignedUrl(f.path, DOWNLOAD_TTL);
      const out: Record<string, unknown> = { name: f.name, size: f.size, viewUrl: view?.signedUrl ?? null };
      if (canDownload) {
        const { data: dl } = await bucket.createSignedUrl(f.path, DOWNLOAD_TTL, {
          download: f.name.split("/").pop() || true,
        });
        out.downloadUrl = dl?.signedUrl ?? null;
      }
      return out;
    }),
  );
}

const mapLibrary = async (r: Record<string, unknown>, canDownload = false) => ({
  id: r.id,
  title: r.title,
  subject: r.subject,
  type: r.type,
  audience: r.audience,
  description: r.description,
  uploadedBy: r.uploaded_by,
  fileName: r.file_name,
  fileSize: r.file_size ?? 0,
  isFolder: !!r.is_folder,
  files: await signFiles((r.files as LibFile[]) ?? [], canDownload),
  externalUrl: r.external_url ?? null,
  published: !!r.published,
  folderId: r.folder_id ?? null,
});
const mapFolder = (r: Record<string, unknown>, itemCount = 0) => ({
  id: r.id,
  name: r.name,
  audience: r.audience,
  itemCount,
});
const mapProfile = (r: Record<string, unknown>, access?: { grants: string[]; scope: PlaceScope }) => ({
  id: r.id,
  role: r.role,
  fullName: r.full_name,
  email: r.email,
  school: r.school,
  county: r.county,
  schoolId: r.school_id ?? null,
  userCode: r.user_code ?? null,
  // Teachers and heads made before schools had codes must pick theirs
  // once before using their dashboard.
  needsSchool: SCHOOL_ROLES.includes(r.role as string) && !r.school_id,
  grade: r.grade,
  teacherType: r.teacher_type ?? null,
  status: r.status ?? "active",
  statusReason: r.status_reason ?? null,
  requestedRole: r.requested_role ?? null,
  // Signed in with a temporary password: choose your own before anything else.
  mustChangePassword: !!r.must_change_password,
  // What the signed-in person may do (their role's permissions plus any
  // grants), where (their data scope) and in which workspace — the app uses
  // this only to decide what to show; every route checks again on the server.
  permissions: r.status === "active" || r.status == null ? [...effectivePermissions(r.role as string, access?.grants ?? [])] : [],
  grants: access?.grants ?? [],
  scope: access ? { global: access.scope.global, label: access.scope.label } : null,
  workspace: WORKSPACE[r.role as Role] ?? null,
  // A Super Admin may open every management workspace; everyone else only their own.
  workspaces: r.role === "super_admin" ? ["platform", "admin", "me", "education"] : [WORKSPACE[r.role as Role]?.id].filter(Boolean),
});
const mapLearnerSelf = (r: Record<string, unknown>) => ({
  id: r.id,
  role: "learner" as const,
  fullName: r.full_name,
  username: r.username,
  grade: r.grade,
  school: r.school,
  county: r.county,
  userCode: r.user_code ?? null,
  learnerCode: r.learner_code ?? r.user_code ?? null,
  classId: r.class_id ?? null,
  academicYear: r.academic_year_id ?? null,
  term: r.term_id ?? null,
  enrollmentStatus: r.enrollment_status ?? "ACTIVE",
});
const mapSchool = (r: Record<string, unknown>) => ({
  id: r.id, name: r.name, county: r.county, code: r.code,
});
/* A form is one of three kinds: `questions` (built in the portal and
   answered in it), `file` (an uploaded form — e.g. a PDF — that
   recipients open/download, fill, and optionally upload back) or `link`
   (a form on another site, e.g. a Google Form). It's addressed to one
   role, one county or all (county null), and — for field officers —
   optionally one visit type, in which case it's filled inside a visit
   of that type rather than on its own. Blank form files are signed for
   download too: recipients need a copy to fill. */
const FORM_KINDS = ["questions", "file", "link"];
const VISIT_TYPES: string[] = [...INTEL_VISIT_TYPES];
const mapForm = async (r: Record<string, unknown>) => ({
  id: r.id,
  title: r.title,
  description: r.description,
  audience: r.audience,
  kind: r.kind ?? "questions",
  county: r.county ?? null,
  visitType: r.visit_type ?? null,
  externalUrl: r.external_url ?? null,
  files: await signFiles((r.files as LibFile[]) ?? [], true),
  createdBy: r.created_by,
  createdAt: r.created_at,
  archivedAt: r.archived_at ?? null,
  dueOn: r.due_on ?? null,
  questions: r.questions ?? [],
});
/* Filled copies uploaded with a response: the education team can
   download them; everyone else (the respondent) only views. */
const mapResponse = async (r: Record<string, unknown>, canDownload = false) => ({
  id: r.id,
  formId: r.form_id,
  respondentId: r.respondent_id,
  respondentName: r.respondent_name,
  respondentRole: r.respondent_role,
  visitId: r.visit_id ?? null,
  school: r.school ?? "",
  submittedAt: r.submitted_at,
  answers: r.answers ?? [],
  files: await signFiles((r.files as LibFile[]) ?? [], canDownload),
});
const mapReport = (r: Record<string, unknown>) => ({
  school: r.school,
  county: r.county,
  visitType: r.visit_type,
  createdAt: r.created_at,
});

// ---------------------------------------------------------------- app

type Actor = {
  id: string; role: Role; fullName: string; grade: string; school: string; county: string; schoolId: string | null;
  /** The role's permissions plus this person's open grants — worked out here, never sent by the browser. */
  permissions: Set<Permission>;
  grants: string[];
  /** The counties / schools this person's data is limited to (scope.ts). */
  scope: PlaceScope;
};
type Vars = {
  actorKind: "staff" | "learner";
  userId: string;
  email: string;
  learnerId: string;
  actor: Actor;
  /** Staff: when this session was signed in (seconds), from the verified token. */
  signedInAt: number;
};

export const app = new Hono<{ Variables: Vars }>().basePath("/api");

app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return origin;
      if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
      if (origin === "https://khaima.github.io") return origin;
      // The Vercel mirror of this same site, plus its preview deployments
      // (e.g. learning-portal-<hash>-<user>.vercel.app for each branch/PR).
      if (/^https:\/\/learning-portal[\w-]*\.vercel\.app$/.test(origin)) return origin;
      return null;
    },
    allowHeaders: ["authorization", "content-type", "idempotency-key"],
    exposeHeaders: ["idempotent-replay"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  }),
);

app.get("/health", (c) => c.json({ ok: true }));

// ---- staff sign-up (email + password, no confirmation email) ----

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ---- audit trail ----
   Append-only (the table refuses updates and deletes, even from this
   service). Written after the change it describes; a failed write is
   logged rather than undoing a change the person already made. */
// deno-lint-ignore no-explicit-any
async function audit(c: any, action: string, targetType: string, targetId: unknown,
  details: Record<string, unknown> = {}, actorOverride?: { id: string; role?: string | null }) {
  const actor = actorOverride ?? c.get("actor");
  const kind = c.get("actorKind") === "learner" ? "learner" : actor ? "staff" : "system";
  const { error } = await admin.from("audit_log").insert({
    actor_id: actor?.id ?? null,
    actor_kind: kind,
    actor_role: actor?.role ?? null,
    action,
    target_type: targetType,
    target_id: targetId == null ? null : String(targetId),
    details,
  });
  if (error) console.error("audit write failed:", action, error.message);
}

/* ---- staff invitations ----
   The link holds a random token; only its SHA-256 hash is stored. */
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const INVITE_TTL_DAYS = 14;

async function loadOpenInvitation(token: string) {
  if (!token || token.length > 200) return null;
  const { data } = await admin.from("staff_invitations").select("*")
    .eq("token_hash", hashToken(token)).maybeSingle();
  if (!data || data.accepted_at || data.revoked_at) return null;
  if (new Date(data.expires_at).getTime() < Date.now()) return null;
  return data;
}

/* Public: what an invitation link is for, so the sign-up page can show it
   before an account exists. Reveals nothing without the token. */
app.get("/invitations/:token", async (c) => {
  const inv = await loadOpenInvitation(c.req.param("token"));
  if (!inv) return c.json({ error: "This invitation link is invalid, already used or expired." }, 404);
  const school = inv.school_id ? await loadSchool(inv.school_id) : null;
  return c.json({
    invitation: {
      email: inv.email,
      role: inv.role,
      roleLabel: ROLE_LABEL[inv.role as Role] ?? inv.role,
      county: inv.county ?? school?.county ?? null,
      school: school ? `${school.name} (${school.code})` : null,
      expiresAt: inv.expires_at,
    },
  });
});

app.post("/auth/register", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const email = String(b.email ?? "").trim().toLowerCase();
  const password = String(b.password ?? "");
  if (!EMAIL_RE.test(email)) return c.json({ error: "Enter a valid email address" }, 400);
  if (password.length < 8) {
    return c.json({ error: "Password must be at least 8 characters" }, 400);
  }
  const { error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) {
    const msg = error.message || "";
    if (/registered|already exists|duplicate/i.test(msg)) {
      return c.json({ error: "That email already has an account — sign in instead." }, 409);
    }
    return c.json({ error: msg || "Could not create the account" }, 400);
  }
  return c.json({ ok: true });
});

// ---- learner sign-in (no session required) ----

app.post("/learner/login", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const username = String(b.username ?? "").trim().toLowerCase();
  const pin = String(b.pin ?? "").trim();
  if (!username || !PIN_RE.test(pin)) {
    return c.json({ error: "Enter your username and 4-digit PIN" }, 400);
  }
  const { data: learner } = await admin
    .from("learners")
    .select("*")
    .eq("username", username)
    .maybeSingle();
  if (!learner) return c.json({ error: "Wrong username or PIN" }, 401);
  if ((learner.enrollment_status ?? "ACTIVE") !== "ACTIVE") {
    return c.json({ error: "This account isn't active any more. Ask your teacher." }, 403);
  }

  if (learner.locked_until && new Date(learner.locked_until) > new Date()) {
    return c.json({ error: "Too many tries. Ask your teacher to unlock it." }, 423);
  }

  if (!pinMatches(pin, learner.pin_salt, learner.pin_hash)) {
    const attempts = (learner.failed_attempts ?? 0) + 1;
    const lock = attempts >= PIN_MAX_ATTEMPTS
      ? new Date(Date.now() + PIN_LOCK_MINUTES * 60_000).toISOString()
      : null;
    await admin.from("learners").update({
      failed_attempts: lock ? 0 : attempts,
      locked_until: lock,
    }).eq("id", learner.id);
    return c.json({
      error: lock ? "Too many tries. Ask your teacher to unlock it." : "Wrong username or PIN",
    }, lock ? 423 : 401);
  }

  await admin.from("learners")
    .update({ failed_attempts: 0, locked_until: null })
    .eq("id", learner.id);
  const token = randomBytes(24).toString("hex");
  await admin.from("learner_sessions").insert({
    token,
    learner_id: learner.id,
    expires_at: new Date(Date.now() + LEARNER_SESSION_TTL_MS).toISOString(),
  });
  return c.json({ token, learner: mapLearnerSelf(learner) });
});

app.post("/learner/logout", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const token = String(b.token ?? "").replace(/^hpl_/, "");
  if (token) await admin.from("learner_sessions").delete().eq("token", token);
  return c.json({ ok: true });
});

// ---- KoboToolbox push (REST Service) ----
// KoboToolbox posts each new submission here the moment it arrives. Not a
// signed-in route: it carries the Basic-auth password the Education Team
// generated (only its SHA-256 hash is stored). The submission is stored as
// received and run through validation; nothing else is reachable from here.
const KOBO_HOOK_USER = "hpf";
const KOBO_HOOK_MAX_BYTES = 1_000_000;
// deno-lint-ignore no-explicit-any
function hookSecret(c: any): string {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(String(c.req.header("Authorization") ?? "").trim());
  if (m) {
    try {
      const decoded = atob(m[1]);
      const i = decoded.indexOf(":");
      return i >= 0 ? decoded.slice(i + 1) : "";
    } catch { return ""; }
  }
  return String(c.req.header("X-HPF-Hook-Secret") ?? "");
}

app.post("/kobo/hook", async (c) => {
  const cfg = await loadKoboConfig();
  const secret = hookSecret(c);
  if (!cfg?.webhook_secret_hash || !secret) return c.json({ error: "Not authorised" }, 401);
  const a = Buffer.from(hashToken(secret));
  const b = Buffer.from(String(cfg.webhook_secret_hash));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return c.json({ error: "Not authorised" }, 401);
  if (Number(c.req.header("content-length") ?? 0) > KOBO_HOOK_MAX_BYTES) return c.json({ error: "Too large" }, 413);
  const text = await c.req.text();
  if (text.length > KOBO_HOOK_MAX_BYTES) return c.json({ error: "Too large" }, 413);
  let row: Record<string, any>;
  try { row = JSON.parse(text); } catch { return c.json({ error: "Not JSON" }, 400); }
  if (!row || typeof row !== "object" || Array.isArray(row) || !Number.isSafeInteger(Number(row._id))) {
    return c.json({ error: "Not a KoboToolbox submission" }, 400);
  }
  // Kobo names the survey in _xform_id_string (its asset uid); ?asset= also works.
  const uid = String(row._xform_id_string ?? c.req.query("asset") ?? "").trim();
  const { data: attached } = uid ? await admin.from("kobo_forms").select("*").eq("asset_uid", uid).maybeSingle() : { data: null };
  if (!attached || !attached.active) return c.json({ ok: true, ignored: "This survey isn't attached in the portal" }, 202);
  try {
    const form = attached.schema ? attached : await refreshKoboSchema(cfg, attached);
    await storeKoboRaw(form, [row], "webhook");
    await processKoboForm(form, cfg.officer_field);
  } catch (e) {
    // What was stored is processed again at the next sync; Kobo retries too.
    console.error("kobo hook:", (e as Error).message);
    await admin.from("kobo_forms").update({
      last_sync_attempt_at: new Date().toISOString(), last_sync_error: `A pushed submission couldn't be processed: ${koboErrorText(e)}`,
    }).eq("id", attached.id);
    return c.json({ error: "Couldn't process the submission" }, 500);
  }
  return c.json({ ok: true });
});

/* ---- notifications: the hourly run ----
   Called by pg_cron (see the notifications migration) with a secret that
   lives in Vault; the database itself checks it. */
app.post("/notifications/run", async (c) => {
  const secret = c.req.header("X-Cron-Secret") ?? "";
  if (secret.length < 32) return c.json({ error: "Not allowed" }, 401);
  const { data: ok, error } = await admin.rpc("notify_cron_secret_ok", { candidate: secret });
  if (error || ok !== true) return c.json({ error: "Not allowed" }, 401);
  return c.json(await runNotifications("schedule"));
});

// ---- authentication ----

app.use("*", async (c, next) => {
  const raw = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!raw) return c.json({ error: "Not signed in" }, 401);

  if (raw.startsWith("hpl_")) {
    const { data } = await admin
      .from("learner_sessions")
      .select("learner_id, created_at, expires_at")
      .eq("token", raw.slice(4))
      .maybeSingle();
    // The created_at check also retires sessions issued under the old
    // 30-day expiry.
    const now = Date.now();
    if (
      !data ||
      new Date(data.expires_at).getTime() < now ||
      now - new Date(data.created_at).getTime() > LEARNER_SESSION_TTL_MS
    ) {
      return c.json({ error: "Invalid session" }, 401);
    }
    c.set("actorKind", "learner");
    c.set("learnerId", data.learner_id);
    await next();
    return;
  }

  const { data, error } = await admin.auth.getUser(raw);
  if (error || !data.user) return c.json({ error: "Invalid session" }, 401);
  c.set("actorKind", "staff");
  c.set("userId", data.user.id);
  c.set("email", data.user.email ?? "");
  c.set("signedInAt", sessionSignedInAt(raw));
  await next();
});

/** When this session was signed in (seconds since 1970), from the `amr`
    claim of a token Supabase Auth has just verified (getUser above). It
    survives token refreshes, so it's the sign-in itself, not the refresh. */
function sessionSignedInAt(jwt: string): number {
  try {
    const part = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(part + "=".repeat((4 - (part.length % 4)) % 4)));
    const times = (Array.isArray(claims.amr) ? claims.amr : []).map((a: { timestamp?: unknown }) => Number(a?.timestamp) || 0);
    return Math.max(0, ...times);
  } catch {
    return 0;
  }
}

/* ---- once only: retries from the offline queue ----
   A device that worked offline sends each queued activity with an
   Idempotency-Key. The first request with a key does the work and keeps
   the reply; a repeat — the first attempt arrived but its reply was lost
   on a bad connection — gets that reply back instead of doing it twice
   (two visits, two hand-ins). A key belongs to the account, method and
   path that first used it. Server errors (5xx) aren't kept, so those are
   retried for real. */
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{8,80}$/;
const IDEMPOTENCY_KEEP_MS = 30 * 864e5;
// Replies that hold a secret (a temporary password, an invitation link) are never stored for replay.
const NEVER_REPLAYED = /\/(temporary-password|users\/invitations|renew)$/;
app.use("*", async (c, next) => {
  const key = c.req.header("Idempotency-Key");
  if (!key || c.req.method === "GET" || c.req.method === "OPTIONS") return next();
  if (NEVER_REPLAYED.test(new URL(c.req.url).pathname)) return next();
  if (!IDEMPOTENCY_KEY_RE.test(key)) return c.json({ error: "Invalid Idempotency-Key" }, 400);
  const actorId = String(c.get("learnerId") ?? c.get("userId") ?? "");
  const path = new URL(c.req.url).pathname;
  const { data: prior } = await admin.from("sync_requests").select("*").eq("key", key).maybeSingle();
  if (prior) {
    if (prior.actor_id !== actorId || prior.method !== c.req.method || prior.path !== path) {
      return c.json({ error: "That Idempotency-Key was already used for something else" }, 422);
    }
    if (prior.status_code != null) {
      // deno-lint-ignore no-explicit-any
      return c.json(prior.response ?? {}, prior.status_code as any, { "Idempotent-Replay": "true" });
    }
    if (Date.now() - new Date(prior.created_at).getTime() < 120_000) {
      return c.json({ error: "Still being processed — it will be retried shortly.", retryable: true }, 409);
    }
    // The first attempt never finished (the function stopped): let this one do it.
    await admin.from("sync_requests").delete().eq("key", key);
  }
  const { error } = await admin.from("sync_requests").insert({ key, actor_id: actorId, method: c.req.method, path, created_at: new Date().toISOString() });
  if (error) {
    if (isUniqueViolation(error)) return c.json({ error: "Still being processed — it will be retried shortly.", retryable: true }, 409);
    return c.json({ error: error.message }, 500);
  }
  await next();
  if (c.res.status >= 500) {
    await admin.from("sync_requests").delete().eq("key", key);
    return;
  }
  let body: unknown = null;
  try { body = await c.res.clone().json(); } catch { body = null; }
  await admin.from("sync_requests").update({ status_code: c.res.status, response: body, completed_at: new Date().toISOString() }).eq("key", key);
  if (Math.random() < 0.02) {
    await admin.from("sync_requests").delete().lt("created_at", new Date(Date.now() - IDEMPOTENCY_KEEP_MS).toISOString());
  }
});

async function loadStaffProfile(userId: string) {
  const { data } = await admin
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle();
  return data;
}
async function loadLearner(learnerId: string) {
  const { data } = await admin
    .from("learners")
    .select("*")
    .eq("id", learnerId)
    .maybeSingle();
  return data;
}

/* ---- authorization ----
   Who the caller is comes only from the database: the learner session, or
   the staff member's own `profiles` row. Nothing the browser sends (a role,
   a status, an id) is ever trusted. Staff must also have an ACTIVE account
   — a pending, suspended, rejected or deactivated account reaches no route
   behind these guards. */

const STATUS_MESSAGE: Record<string, string> = {
  pending: "Your account is waiting for approval by an administrator.",
  rejected: "Your account request was not approved. Contact an administrator if you think this is a mistake.",
  suspended: "Your account is suspended. Contact an administrator.",
  deactivated: "Your account has been deactivated. Contact an administrator.",
};

/** Loads the caller into c.var.actor, or returns the response refusing them. */
// deno-lint-ignore no-explicit-any
async function resolveActor(c: any): Promise<Response | null> {
  if (c.get("actor")) return null;
  if (c.get("actorKind") === "learner") {
    const l = await loadLearner(c.get("learnerId"));
    if (!l) return c.json({ error: "Invalid session" }, 401);
    if ((l.enrollment_status ?? "ACTIVE") !== "ACTIVE") return c.json({ error: "Invalid session" }, 401);
    c.set("actor", {
      id: l.id, role: "learner", fullName: l.full_name, grade: l.grade, school: l.school, county: l.county, schoolId: l.school_id ?? null,
      permissions: effectivePermissions("learner"), grants: [],
      scope: placeScopeFor({ role: "learner", schoolId: l.school_id ?? null, school: l.school }, [], []),
    });
    return null;
  }
  const p = await loadStaffProfile(c.get("userId"));
  if (!p) return c.json({ needsOnboarding: true, email: c.get("email") }, 428);
  const status = p.status ?? "active";
  if (status !== "active") {
    return c.json({ error: STATUS_MESSAGE[status] ?? "Your account is not active.", accountStatus: status }, 403);
  }
  // Signed in with a temporary password: the only thing it can do is be
  // replaced (POST /me/password, which doesn't come through here).
  if (p.must_change_password) {
    return c.json({ error: "Choose your own password before carrying on.", mustChangePassword: true }, 403);
  }
  if (!STAFF_ROLES.includes(p.role)) return c.json({ error: "Your account has no valid role." }, 403);
  const { grants, scope } = await loadAccess(p);
  c.set("actor", {
    id: p.id, role: p.role, fullName: p.full_name, grade: p.grade, school: p.school, county: p.county, schoolId: p.school_id ?? null,
    permissions: effectivePermissions(p.role, grants), grants, scope,
  });
  return null;
}

/** A staff member's open permission grants and data scope, from the database. */
async function loadAccess(p: Record<string, any>): Promise<{ grants: string[]; scope: PlaceScope; rows: ScopeRow[] }> {
  const assignable = (ASSIGNABLE_ROLES as readonly string[]).includes(p.role);
  const [g, sc] = await Promise.all([
    admin.from("permission_grants").select("permission").eq("profile_id", p.id).is("revoked_at", null),
    assignable
      ? admin.from("staff_scopes").select("id, scope_type, county, school_id, ended_at, created_at").eq("profile_id", p.id).is("ended_at", null)
      : Promise.resolve({ data: [] as ScopeRow[] }),
  ]);
  const rows = (sc.data ?? []) as ScopeRow[];
  // The schools list is only needed to turn assigned counties into schools.
  const schools = rows.length ? (await admin.from("schools").select("id, name, county")).data ?? [] : [];
  const grants = (g.data ?? []).map((r) => String(r.permission));
  return { grants, rows, scope: placeScopeFor({ role: p.role, schoolId: p.school_id ?? null, school: p.school }, rows, schools) };
}

const NO_PERMISSION = "You don't have permission to do that.";

/** Any signed-in, active account (staff or learner). */
function requireActive() {
  // deno-lint-ignore no-explicit-any
  return async (c: any, next: any) => (await resolveActor(c)) ?? next();
}

/** Any active staff account (learners refused). */
function requireStaff() {
  // deno-lint-ignore no-explicit-any
  return async (c: any, next: any) => {
    if (c.get("actorKind") === "learner") return c.json({ error: NO_PERMISSION }, 403);
    return (await resolveActor(c)) ?? next();
  };
}

/** An active account holding at least one of these permissions. */
function requirePermission(...perms: Permission[]) {
  // deno-lint-ignore no-explicit-any
  return async (c: any, next: any) => {
    const refused = await resolveActor(c);
    if (refused) return refused;
    const held = (c.get("actor") as Actor).permissions;
    if (!perms.some((p) => held.has(p))) return c.json({ error: NO_PERMISSION }, 403);
    return next();
  };
}

/** For a handler that's already past a guard. */
// deno-lint-ignore no-explicit-any
const actorCan = (c: any, p: Permission) => !!(c.get("actor") as Actor | undefined)?.permissions.has(p);
/** The caller's data scope (needs a guard before it). */
// deno-lint-ignore no-explicit-any
const scopeOf = (c: any): PlaceScope => (c.get("actor") as Actor).scope;
/** Is this school (or, for a record without one, this county) inside the caller's scope? */
// deno-lint-ignore no-explicit-any
const inScope = (c: any, schoolId: unknown, county?: unknown) => inPlaceScope(scopeOf(c), schoolId, county);

// ---- session / onboarding ----

app.get("/me", async (c) => {
  if (c.get("actorKind") === "learner") {
    const l = await loadLearner(c.get("learnerId"));
    if (!l || (l.enrollment_status ?? "ACTIVE") !== "ACTIVE") return c.json({ error: "Invalid session" }, 401);
    const [cls, teacher] = await Promise.all([
      l.class_id ? admin.from("classes").select("name, grade").eq("id", l.class_id).maybeSingle() : { data: null },
      l.current_teacher_id ? admin.from("profiles").select("full_name").eq("id", l.current_teacher_id).maybeSingle() : { data: null },
    ]);
    return c.json({ profile: { ...mapLearnerSelf(l), className: cls.data?.name ?? null, teacherName: teacher.data?.full_name ?? null } });
  }
  const profile = await loadStaffProfile(c.get("userId"));
  if (!profile) return c.json({ needsOnboarding: true, email: c.get("email") });
  const access = (profile.status ?? "active") === "active" && STAFF_ROLES.includes(profile.role) ? await loadAccess(profile) : undefined;
  return c.json({ profile: mapProfile(profile, access) });
});

/* ---- passwords ----
   Nobody chooses or learns someone else's lasting password. An
   administrator can help someone who can't sign in in two ways, both
   written to the audit log:
   - a reset link (POST /users/:id/reset-link), emailed by Supabase Auth
     through the portal's own mail sender (docs/AUTH.md): the person
     chooses their own password;
   - a temporary password (POST /users/:id/temporary-password) for someone
     who can't receive email: random, shown to the administrator once,
     never stored, and good for one thing only — signing in to choose their
     own here. Until they do, every other route refuses them (resolveActor). */
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 72; // Supabase Auth's limit

function passwordProblem(pw: string): string | null {
  if (pw.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (pw.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  return null;
}

/* Four groups of four, from letters and digits that can't be mistaken for
   each other when read aloud or copied by hand (no 0/O, 1/l/I). About 90
   bits; always has a lower-case and a capital letter, a digit and a dash,
   so it passes any password-character rule set in Supabase Auth. */
const TEMP_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
function temporaryPassword(): string {
  for (;;) {
    const chars: string[] = [];
    while (chars.length < 16) {
      for (const byte of randomBytes(32)) {
        // Rejection sampling: no bias towards the start of the alphabet.
        if (byte < 256 - (256 % TEMP_ALPHABET.length) && chars.length < 16) chars.push(TEMP_ALPHABET[byte % TEMP_ALPHABET.length]);
      }
    }
    const pw = [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join("")).join("-");
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw) && /[0-9]/.test(pw)) return pw;
  }
}
const isTemporaryPassword = (pw: string, stored: unknown) => {
  const [salt, hash] = String(stored ?? "").split(":");
  return !!salt && !!hash && pinMatches(pw, salt, hash);
};

/* Change your own password — staff only (learners have a PIN). Also how a
   reset link and a temporary password end: the flag is cleared here and
   nowhere else. Works for any account state, as Supabase's own "change
   password" would; it only ever changes the caller's own password. */
app.post("/me/password", async (c) => {
  if (c.get("actorKind") === "learner") {
    return c.json({ error: "Learners sign in with a PIN — ask your teacher to reset it." }, 403);
  }
  const b = await c.req.json().catch(() => ({}));
  const password = String(b.password ?? "");
  const problem = passwordProblem(password);
  if (problem) return c.json({ error: problem }, 400);
  const p = await loadStaffProfile(c.get("userId"));
  if (p?.must_change_password) {
    // Only a session signed in after the temporary password was made (with
    // it, or with a reset link) may replace it — not one left open before.
    const madeAt = Date.parse(p.temporary_password_at ?? "") || 0;
    if (madeAt && (c.get("signedInAt") ?? 0) * 1000 < madeAt - 5000) {
      return c.json({ error: "Sign in again with the temporary password you were given, then choose your own.", signInAgain: true }, 401);
    }
    if (isTemporaryPassword(password, p.temporary_password_hash)) {
      return c.json({ error: "Choose a new password of your own — not the temporary one." }, 400);
    }
  }
  const { error } = await admin.auth.admin.updateUserById(c.get("userId"), { password });
  if (error) return c.json({ error: error.message || "Could not change your password" }, 400);
  if (p) {
    const { error: e2 } = await admin.from("profiles").update({
      must_change_password: false, temporary_password_hash: null, password_changed_at: new Date().toISOString(),
    }).eq("id", p.id);
    if (e2) return c.json({ error: e2.message }, 500);
    // Never the password.
    await audit(c, "password.changed", "profile", p.id, { afterTemporary: !!p.must_change_password }, { id: p.id, role: p.role });
  }
  return c.json({ ok: true });
});

/** Name and BOM/TSC type from a sign-up form, or the error to show. */
function readNameAndType(b: Record<string, unknown>, role: string): { fullName: string; teacherType: string | null } | { error: string } {
  const fullName = String(b.fullName ?? "").trim();
  if (!fullName) return { error: "Full name is required" };
  const teacherType = String(b.teacherType ?? "").trim().toUpperCase();
  if (teacherType && !["BOM", "TSC"].includes(teacherType)) return { error: "Teacher type must be BOM or TSC" };
  return { fullName, teacherType: role === "teacher" && teacherType ? teacherType : null };
}

/* Self-registration WITHOUT an invitation. The person says which working
   role they're asking for and where they work, but the account is created
   `pending`: it can reach nothing until an administrator approves it
   (and may change the role or placement while doing so). */
app.post("/me", async (c) => {
  if (c.get("actorKind") === "learner") {
    return c.json({ error: "Learners are added by a teacher" }, 403);
  }
  if (await loadStaffProfile(c.get("userId"))) {
    return c.json({ error: "Profile already exists" }, 409);
  }
  const b = await c.req.json().catch(() => ({}));
  if (!SELF_REQUESTABLE_ROLES.includes(b.role)) {
    return c.json({
      error: "Pick Teacher, School Head or Field Officer. Other roles are only given by an administrator's invitation.",
    }, 400);
  }
  const who = readNameAndType(b, b.role);
  if ("error" in who) return c.json({ error: who.error }, 400);

  // Where each role sits: teachers and heads in one school (picked from
  // the list — never typed); field officers in a county (they pick the
  // school per visit/form).
  let school: School | null = null;
  let county = "";
  if (SCHOOL_ROLES.includes(b.role)) {
    school = await loadSchool(b.schoolId);
    if (!school) return c.json({ error: "Choose your county and school" }, 400);
    county = school.county;
  } else if (b.role === "field_officer") {
    county = String(b.county ?? "").trim();
    if (!(await isCounty(county))) return c.json({ error: "Choose your county" }, 400);
  }

  const { data, error } = await admin
    .from("profiles")
    .insert({
      id: c.get("userId"),
      role: b.role,
      requested_role: b.role,
      status: "pending",
      full_name: who.fullName,
      email: c.get("email"),
      school: school?.name ?? "",
      school_id: school?.id ?? null,
      county,
      grade: String(b.grade ?? "").trim(),
      teacher_type: who.teacherType,
    })
    .select()
    .single();
  if (error) return c.json({ error: error.message }, 400);
  await audit(c, "account.created", "profile", data.id,
    { via: "self-registration", requestedRole: b.role, status: "pending", schoolId: school?.id ?? null, county },
    { id: data.id, role: null });
  return c.json({ profile: mapProfile(data) });
});

/* Registration WITH an invitation: the role and placement are the ones the
   administrator chose when inviting — never anything from this request —
   and the account is active straight away. Works for a brand-new account
   and for one that registered on its own and is still pending. */
app.post("/me/accept-invite", async (c) => {
  if (c.get("actorKind") === "learner") return c.json({ error: NO_PERMISSION }, 403);
  const b = await c.req.json().catch(() => ({}));
  const inv = await loadOpenInvitation(String(b.token ?? ""));
  if (!inv) return c.json({ error: "This invitation link is invalid, already used or expired." }, 404);
  const email = String(c.get("email") ?? "").toLowerCase();
  if (email !== String(inv.email).toLowerCase()) {
    return c.json({ error: `This invitation is for ${inv.email}. Sign in with that email address to accept it.` }, 403);
  }
  const existing = await loadStaffProfile(c.get("userId"));
  if (existing && existing.status !== "pending") {
    return c.json({ error: "This account is already set up. Ask an administrator to change its role instead." }, 409);
  }
  const who = readNameAndType({ ...b, fullName: b.fullName ?? existing?.full_name }, inv.role);
  if ("error" in who) return c.json({ error: who.error }, 400);

  const school = inv.school_id ? await loadSchool(inv.school_id) : null;
  if (SCHOOL_ROLES.includes(inv.role) && !school) {
    return c.json({ error: "The school on this invitation no longer exists. Ask for a new invitation." }, 409);
  }
  const now = new Date().toISOString();
  const fields = {
    role: inv.role,
    status: "active",
    full_name: who.fullName,
    email: c.get("email"),
    school: school?.name ?? "",
    school_id: school?.id ?? null,
    county: school?.county ?? (COUNTY_ROLES.includes(inv.role) ? inv.county ?? "" : ""),
    teacher_type: who.teacherType,
    invited_by: inv.invited_by,
    approved_at: now,
    approved_by: inv.invited_by,
    status_changed_at: now,
    status_changed_by: inv.invited_by,
  };
  // Claim the invitation first, so it can't be used twice at once.
  const { data: claimed } = await admin.from("staff_invitations")
    .update({ accepted_at: now, accepted_by: c.get("userId") })
    .eq("id", inv.id).is("accepted_at", null).is("revoked_at", null).select("id").maybeSingle();
  if (!claimed) return c.json({ error: "This invitation link is invalid, already used or expired." }, 409);

  const res = existing
    ? await admin.from("profiles").update(fields).eq("id", existing.id).select().single()
    : await admin.from("profiles").insert({ id: c.get("userId"), ...fields }).select().single();
  if (res.error) {
    await admin.from("staff_invitations").update({ accepted_at: null, accepted_by: null }).eq("id", inv.id);
    return c.json({ error: res.error.message }, 400);
  }
  let profile = res.data;
  if (school && (!profile.user_code || existing?.school_id !== school.id)) {
    try { profile = await placeInSchool("profiles", profile.id, school, inv.role); } catch { /* code can be set later */ }
  }
  const self = { id: profile.id, role: profile.role };
  await audit(c, existing ? "account.approved" : "account.created", "profile", profile.id,
    { via: "invitation", invitationId: inv.id, role: inv.role, invitedBy: inv.invited_by,
      schoolId: school?.id ?? null, county: fields.county }, self);
  await audit(c, "invitation.accepted", "invitation", inv.id, { email: inv.email, role: inv.role }, self);
  return c.json({ profile: mapProfile(profile) });
});

/* One-time: a teacher or head whose account predates school codes picks
   their school. Only while they have none — changing school afterwards
   is an administrator's job (Users page), so nobody can move themselves
   into another school's data. A teacher's existing learners join the same
   school and get their codes too. */
app.put("/me/school", requireStaff(), async (c) => {
  const actor = c.get("actor");
  if (!SCHOOL_ROLES.includes(actor.role)) return c.json({ error: NO_PERMISSION }, 403);
  if (actor.schoolId) return c.json({ error: "Your school is already set — ask the Education Team to change it" }, 409);
  const b = await c.req.json().catch(() => ({}));
  const school = await loadSchool(b.schoolId);
  if (!school) return c.json({ error: "Choose your county and school" }, 400);
  try {
    const profile = await placeInSchool("profiles", actor.id, school, actor.role);
    if (actor.role === "teacher") await moveTeachersLearners(actor.id, school);
    await audit(c, "school.changed", "profile", actor.id,
      { from: null, to: school.id, county: school.county, userCode: profile.user_code, via: "self (first school pick)" });
    return c.json({ profile: mapProfile(profile) });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

/** First school pick only: learners this teacher added before schools had
    codes (and so have no school) join the teacher's school. Learners that
    already belong to a school stay there — they belong to the school now,
    not the teacher. */
async function moveTeachersLearners(teacherId: string, school: School) {
  const { data } = await admin.from("learners").select("id, school_id").eq("teacher_id", teacherId);
  for (const l of data ?? []) {
    if (!l.school_id) await placeInSchool("learners", l.id as string, school, "learner");
  }
}

/** A teacher leaving a school: their class assignments there end and their
    learners there wait for a new teacher. The learners stay in the school. */
async function detachTeacherFromSchool(teacherId: string, schoolId: string | null, byId: string) {
  if (!schoolId) return;
  const { data: classes } = await admin.from("classes").select("id").eq("school_id", schoolId);
  const ids = (classes ?? []).map((x) => x.id);
  if (ids.length) {
    await admin.from("class_teachers").update({ ended_at: new Date().toISOString(), ended_by: byId })
      .eq("teacher_id", teacherId).in("class_id", ids).is("ended_at", null);
  }
  await admin.from("learners").update({ current_teacher_id: null }).eq("school_id", schoolId).eq("current_teacher_id", teacherId);
}

// ---- schools directory ----

/* `ilike` treats % and _ as wildcards — escape them so a name only ever
   matches itself (case-insensitively). */
const ilikeExact = (s: string) => s.replace(/[\\%_]/g, "\\$&");

/* Any signed-in account can read the list (onboarding needs it before a
   profile exists); only the education team adds, renames or removes.
   The education team also gets head counts per school. */
app.get("/schools", async (c) => {
  const [{ data, error }, counties] = await Promise.all([
    selectAll(() => admin.from("schools").select("*").order("seq").order("id")),
    loadCounties().catch(() => null),
  ]);
  if (error || !counties) return c.json({ error: error?.message || "Could not load counties" }, 500);
  const countyOrder = new Map(counties.map((co, i) => [co.name, i]));
  const schools = (data ?? [])
    .sort((a, b) => (countyOrder.get(a.county) ?? 99) - (countyOrder.get(b.county) ?? 99) || a.seq - b.seq)
    .map(mapSchool) as Record<string, unknown>[];
  // Field officers and narrowed administrators see only their own counties
  // and schools. Everyone else (and anyone still signing up) gets the whole
  // list of names and codes — no people, no records — to pick their school.
  const me = c.get("actorKind") === "staff" ? await loadStaffProfile(c.get("userId")) : null;
  const active = !!me && (me.status ?? "active") === "active" && STAFF_ROLES.includes(me.role);
  const access = active ? await loadAccess(me!) : null;
  let countyNames = counties.map((co) => co.name);
  let visible = schools;
  if (access && !access.scope.global && (ASSIGNABLE_ROLES as readonly string[]).includes(me!.role)) {
    const sc = access.scope;
    visible = schools.filter((s) => sc.schoolIds.has(String(s.id)));
    countyNames = countiesInScope(sc, visible as { id: string; county: string }[], countyNames);
  }
  // Head counts per school only for an active account that manages schools.
  if (active && effectivePermissions(me!.role, access!.grants).has("schools.manage")) {
    const [{ data: profs }, { data: learners }] = await Promise.all([
      selectAll(() => admin.from("profiles").select("school_id, role").not("school_id", "is", null).order("id")),
      selectAll(() => admin.from("learners").select("school_id").not("school_id", "is", null).eq("enrollment_status", "ACTIVE").order("id")),
    ]);
    const count = (rows: Record<string, unknown>[] | null, id: unknown, role?: string) =>
      (rows ?? []).filter((r) => r.school_id === id && (!role || r.role === role)).length;
    for (const s of visible) {
      s.teachers = count(profs, s.id, "teacher");
      s.heads = count(profs, s.id, "school_leader");
      s.learners = count(learners, s.id);
    }
  }
  return c.json({
    counties: countyNames,
    countyCodes: Object.fromEntries(counties.filter((co) => countyNames.includes(co.name)).map((co) => [co.name, co.code])),
    schools: visible,
    scope: access ? { global: access.scope.global, label: access.scope.label } : null,
  });
});

/* Counties: the education team can add one (with its short code, which
   prefixes every school code in it) or remove one that has no schools
   and no field officers in it yet. Names and codes can't be edited, so
   no existing code ever changes. */
const WHOLE_PORTAL_ONLY = "Only an administrator for every county can do that.";

app.post("/counties", requirePermission("schools.manage"), async (c) => {
  if (!scopeOf(c).global) return c.json({ error: WHOLE_PORTAL_ONLY }, 403);
  const b = await c.req.json().catch(() => ({}));
  const name = String(b.name ?? "").trim().replace(/\s+/g, " ");
  const code = String(b.code ?? "").trim().toUpperCase();
  if (!name) return c.json({ error: "County name is required" }, 400);
  if (!/^[A-Z]{2,4}$/.test(code)) return c.json({ error: "County code must be 2–4 letters, e.g. NRK" }, 400);
  const { data: dupName } = await admin.from("counties").select("name").ilike("name", ilikeExact(name)).maybeSingle();
  if (dupName) return c.json({ error: `${dupName.name} is already a county` }, 409);
  const { data: dupCode } = await admin.from("counties").select("name").eq("code", code).maybeSingle();
  if (dupCode) return c.json({ error: `${code} is already used by ${dupCode.name}` }, 409);
  const { data, error } = await admin.from("counties")
    .insert({ name, code, created_by: c.get("actor").fullName }).select("name, code").single();
  if (error) return c.json({ error: isUniqueViolation(error) ? "That county or code already exists" : error.message }, 400);
  return c.json({ county: data });
});

app.delete("/counties/:name", requirePermission("schools.manage"), async (c) => {
  if (!scopeOf(c).global) return c.json({ error: WHOLE_PORTAL_ONLY }, 403);
  const name = decodeURIComponent(c.req.param("name"));
  if (!(await isCounty(name))) return c.json({ error: "County not found" }, 404);
  const [{ count: schools }, { count: officers }, { count: forms }, { count: assigned }] = await Promise.all([
    admin.from("schools").select("id", { count: "exact", head: true }).eq("county", name),
    admin.from("profiles").select("id", { count: "exact", head: true }).eq("role", "field_officer").eq("county", name),
    admin.from("forms").select("id", { count: "exact", head: true }).eq("county", name),
    admin.from("staff_scopes").select("id", { count: "exact", head: true }).eq("county", name),
  ]);
  if ((assigned ?? 0) > 0) return c.json({ error: `${name} is (or was) assigned to staff, so it's kept in their history` }, 409);
  if ((schools ?? 0) > 0) return c.json({ error: `${name} still has ${schools} school(s) — remove them first` }, 409);
  if ((officers ?? 0) > 0) {
    return c.json({ error: `${name} still has ${officers} field officer(s) — move them to another county first` }, 409);
  }
  if ((forms ?? 0) > 0) return c.json({ error: `${forms} form(s) are sent to ${name} — delete them first` }, 409);
  const { error } = await admin.from("counties").delete().eq("name", name);
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ ok: true });
});

app.post("/schools", requirePermission("schools.manage"), async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const name = String(b.name ?? "").trim().replace(/\s+/g, " ");
  const county = String(b.county ?? "").trim();
  const { data: countyRow } = await admin.from("counties").select("code").eq("name", county).maybeSingle();
  if (!countyRow) return c.json({ error: "Choose a county" }, 400);
  const sc = scopeOf(c);
  if (!sc.global && !sc.counties.has(county.toLowerCase())) return c.json({ error: "You can add schools only in your own counties" }, 403);
  if (!name) return c.json({ error: "School name is required" }, 400);
  const { data: dup } = await admin.from("schools").select("id").eq("county", county).ilike("name", ilikeExact(name)).maybeSingle();
  if (dup) return c.json({ error: `${name} is already on the ${county} list` }, 409);

  for (let attempt = 0; attempt < 5; attempt++) {
    const { data: last } = await admin.from("schools").select("seq").eq("county", county)
      .order("seq", { ascending: false }).limit(1);
    const seq = ((last?.[0]?.seq as number) ?? 0) + 1;
    const { data, error } = await admin.from("schools").insert({
      id: rid("sch"), name, county, seq,
      code: `${countyRow.code}-${String(seq).padStart(3, "0")}`,
      created_by: c.get("actor").fullName,
    }).select().single();
    if (!error) return c.json({ school: mapSchool(data) });
    if (!isUniqueViolation(error)) return c.json({ error: error.message }, 400);
  }
  return c.json({ error: "Could not generate a school code — please try again" }, 500);
});

/* Rename only — the code never changes, so nobody's code changes either.
   The synced school name on its people follows the new name. */
app.patch("/schools/:id", requirePermission("schools.manage"), async (c) => {
  const school = await loadSchool(c.req.param("id"));
  if (!school || !inScope(c, school.id)) return c.json({ error: "School not found" }, 404);
  const b = await c.req.json().catch(() => ({}));
  const name = String(b.name ?? "").trim().replace(/\s+/g, " ");
  if (!name) return c.json({ error: "School name is required" }, 400);
  const { data: dup } = await admin.from("schools").select("id").eq("county", school.county)
    .ilike("name", ilikeExact(name)).neq("id", school.id).maybeSingle();
  if (dup) return c.json({ error: `${name} is already on the ${school.county} list` }, 409);
  const { data, error } = await admin.from("schools").update({ name }).eq("id", school.id).select().single();
  if (error) return c.json({ error: error.message }, 400);
  await Promise.all([
    admin.from("profiles").update({ school: name }).eq("school_id", school.id),
    admin.from("learners").update({ school: name }).eq("school_id", school.id),
  ]);
  return c.json({ school: mapSchool(data) });
});

/* Only an empty school can be removed — never strand people. */
app.delete("/schools/:id", requirePermission("schools.manage"), async (c) => {
  const school = await loadSchool(c.req.param("id"));
  if (!school || !inScope(c, school.id)) return c.json({ error: "School not found" }, 404);
  const [{ count: staff }, { count: learners }, { count: assigned }] = await Promise.all([
    admin.from("profiles").select("id", { count: "exact", head: true }).eq("school_id", school.id),
    admin.from("learners").select("id", { count: "exact", head: true }).eq("school_id", school.id),
    admin.from("staff_scopes").select("id", { count: "exact", head: true }).eq("school_id", school.id),
  ]);
  if ((assigned ?? 0) > 0) {
    return c.json({ error: `${school.name} is (or was) assigned to staff, so it can't be removed — rename it instead` }, 409);
  }
  if ((staff ?? 0) + (learners ?? 0) > 0) {
    return c.json({
      error: `${school.name} still has ${staff ?? 0} staff and ${learners ?? 0} learner(s) — move them to another school first`,
    }, 409);
  }
  const { count: surveys } = await admin.from("kobo_records").select("id", { count: "exact", head: true }).eq("school_id", school.id);
  if ((surveys ?? 0) > 0) {
    return c.json({ error: `${school.name} has ${surveys} Kobo survey submission(s) on record, so it can't be removed — rename it instead` }, 409);
  }
  const { error } = await admin.from("schools").delete().eq("id", school.id);
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ ok: true });
});

// ---- learners: school → academic year → term → class → enrollment ----
// Learners belong to a SCHOOL (and, once placed, a CLASS) — no longer to
// the teacher who created them. Who may see or change a learner:
//   - all schools:  learners.view.all / learners.manage.all (admin, M&E…)
//   - one school:   learners.view.school / .manage.school (the school head)
//   - a teacher:    learners in the classes they teach, plus ones they
//                   added that aren't in a class yet — always in their own
//                   school only.
// Learners are never deleted. Leaving is an enrollment status with a date
// and reason; every enrollment period is kept in learner_enrollments.

const ACTIVE = "ACTIVE";
const EXIT_STATUSES: EnrollmentStatus[] = ["TRANSFERRED", "DROPPED_OUT", "COMPLETED", "INACTIVE"];
const today = () => new Date().toISOString().slice(0, 10);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Gender is optional — female, male, prefer not to say, or left empty
    (not recorded). Returns false for anything else. Dashboards only ever
    show it as totals, with small numbers hidden. */
const GENDER_ERROR = "Gender is female, male, prefer not to say — or leave it empty";
function cleanGender(v: unknown): string | null | false {
  const g = String(v ?? "").trim().toLowerCase().replace(/\s+/g, "_");
  if (!g) return null;
  return (GENDERS as readonly string[]).includes(g) ? g : false;
}

type LearnerScope =
  | { kind: "all"; within: PlaceScope }
  | { kind: "school"; schoolId: string }
  | { kind: "teacher"; teacherId: string; schoolId: string; classIds: string[] }
  | { kind: "none" };

/** Classes this teacher currently teaches (any role). */
async function classesTaughtBy(teacherId: string): Promise<string[]> {
  const { data } = await admin.from("class_teachers").select("class_id")
    .eq("teacher_id", teacherId).is("ended_at", null);
  return (data ?? []).map((r) => r.class_id as string);
}

// deno-lint-ignore no-explicit-any
async function learnerScope(c: any): Promise<LearnerScope> {
  const a = c.get("actor") as Actor;
  if (a.permissions.has("learners.view.all") || a.permissions.has("learners.manage.all")) return { kind: "all", within: a.scope };
  if (a.permissions.has("learners.view.school")) return a.schoolId ? { kind: "school", schoolId: a.schoolId } : { kind: "none" };
  if (a.permissions.has("learners.manage")) {
    return a.schoolId ? { kind: "teacher", teacherId: a.id, schoolId: a.schoolId, classIds: await classesTaughtBy(a.id) } : { kind: "none" };
  }
  return { kind: "none" };
}

function inLearnerScope(scope: LearnerScope, l: Record<string, unknown>): boolean {
  if (scope.kind === "all") return inPlaceScope(scope.within, l.school_id, l.county);
  if (scope.kind === "none") return false;
  if (l.school_id !== scope.schoolId) return false; // never another school's learner
  if (scope.kind === "school") return true;
  return l.current_teacher_id === scope.teacherId ||
    (!!l.class_id && scope.classIds.includes(l.class_id as string)) ||
    (!l.class_id && l.teacher_id === scope.teacherId);
}

/** May the caller change this learner? View scope plus a manage permission. */
// deno-lint-ignore no-explicit-any
function canManageLearner(c: any, scope: LearnerScope, l: Record<string, unknown>): boolean {
  if (!inLearnerScope(scope, l)) return false;
  if (scope.kind === "all") return actorCan(c, "learners.manage.all");
  if (scope.kind === "school") return actorCan(c, "learners.manage.school");
  return actorCan(c, "learners.manage");
}

/** Loads :id and checks the caller may see (and, with `manage`, change) it.
    A learner outside the caller's scope is "not found", never "forbidden",
    so nobody can probe another school's learner ids. */
// deno-lint-ignore no-explicit-any
async function loadScopedLearner(c: any, manage: boolean): Promise<{ learner: Record<string, any>; scope: LearnerScope } | Response> {
  const scope = await learnerScope(c);
  const { data: learner } = await admin.from("learners").select("*").eq("id", c.req.param("id")).maybeSingle();
  if (!learner || !inLearnerScope(scope, learner)) return c.json({ error: "Learner not found" }, 404);
  if (manage && !canManageLearner(c, scope, learner)) return c.json({ error: NO_PERMISSION }, 403);
  return { learner, scope };
}

async function currentCalendar() {
  const { data: year } = await admin.from("academic_years").select("*").eq("is_current", true).maybeSingle();
  if (!year) return { yearId: null as string | null, termId: null as string | null };
  const { data: terms } = await admin.from("terms").select("*").eq("academic_year_id", year.id);
  const d = today();
  const term = (terms ?? []).find((t) => t.starts_on <= d && d <= t.ends_on) ??
    (terms ?? []).sort((a, b) => b.term_no - a.term_no)[0];
  return { yearId: year.id as string, termId: (term?.id as string) ?? null };
}

async function loadClass(id: unknown) {
  if (!id) return null;
  const { data } = await admin.from("classes").select("*").eq("id", String(id)).maybeSingle();
  return data;
}
async function classTeacherOf(classId: string): Promise<string | null> {
  const { data } = await admin.from("class_teachers").select("teacher_id")
    .eq("class_id", classId).eq("role", "class_teacher").is("ended_at", null).maybeSingle();
  return (data?.teacher_id as string) ?? null;
}

/** Closes the learner's ACTIVE enrollment (if any) with this status. */
// deno-lint-ignore no-explicit-any
async function closeEnrollment(c: any, learnerId: string, status: EnrollmentStatus, exitDate: string, reason: string | null) {
  await admin.from("learner_enrollments").update({
    status, exit_date: exitDate, exit_reason: reason, closed_by: c.get("actor").id, closed_at: new Date().toISOString(),
  }).eq("learner_id", learnerId).eq("status", ACTIVE);
}

/** Opens a new ACTIVE enrollment and copies it onto the learner row. */
// deno-lint-ignore no-explicit-any
async function openEnrollment(c: any, learnerId: string, e: {
  schoolId: string; classId: string | null; grade: string; teacherId: string | null;
  yearId: string; termId: string | null; date: string;
}) {
  const { error } = await admin.from("learner_enrollments").insert({
    id: rid("enr"), learner_id: learnerId, school_id: e.schoolId, class_id: e.classId,
    academic_year_id: e.yearId, term_id: e.termId, grade: e.grade, teacher_id: e.teacherId,
    status: ACTIVE, enrollment_date: e.date, created_by: c.get("actor").id,
  });
  if (error) throw new Error(error.message);
  const { error: lErr } = await admin.from("learners").update({
    school_id: e.schoolId, class_id: e.classId, grade: e.grade, current_teacher_id: e.teacherId,
    academic_year_id: e.yearId, term_id: e.termId, enrollment_status: ACTIVE, enrollment_date: e.date,
    exit_date: null, exit_reason: null, updated_at: new Date().toISOString(),
  }).eq("id", learnerId);
  if (lErr) throw new Error(lErr.message);
}

const LEARNER_ROSTER_COLS = "*";
const mapRosterLearner = (r: Record<string, unknown>, names: { classes?: Record<string, string>; teachers?: Record<string, string> } = {}) => ({
  id: r.id,
  username: r.username,
  fullName: r.full_name,
  grade: r.grade,
  gender: r.gender ?? null,
  school: r.school,
  schoolId: r.school_id ?? null,
  county: r.county,
  userCode: r.user_code ?? null,
  learnerCode: r.learner_code ?? r.user_code ?? null,
  classId: r.class_id ?? null,
  className: r.class_id ? names.classes?.[r.class_id as string] ?? null : null,
  currentTeacherId: r.current_teacher_id ?? null,
  currentTeacherName: r.current_teacher_id ? names.teachers?.[r.current_teacher_id as string] ?? null : null,
  academicYear: r.academic_year_id ?? null,
  term: r.term_id ?? null,
  status: r.enrollment_status ?? ACTIVE,
  enrollmentDate: r.enrollment_date ?? null,
  exitDate: r.exit_date ?? null,
  exitReason: r.exit_reason ?? null,
  createdAt: r.created_at,
  locked: !!(r.locked_until && new Date(r.locked_until as string) > new Date()),
});

/** Class and teacher names for a set of learner/enrollment rows. */
async function rosterNames(rows: Record<string, unknown>[]) {
  const classIds = [...new Set(rows.map((r) => r.class_id).filter(Boolean))] as string[];
  const teacherIds = [...new Set(rows.flatMap((r) => [r.current_teacher_id, r.teacher_id]).filter(Boolean))] as string[];
  const schoolIds = [...new Set(rows.map((r) => r.school_id).filter(Boolean))] as string[];
  const [cls, tch, sch] = await Promise.all([
    classIds.length ? admin.from("classes").select("id, name").in("id", classIds) : { data: [] },
    teacherIds.length ? admin.from("profiles").select("id, full_name").in("id", teacherIds) : { data: [] },
    schoolIds.length ? admin.from("schools").select("id, name, code").in("id", schoolIds) : { data: [] },
  ]);
  return {
    classes: Object.fromEntries((cls.data ?? []).map((x: Record<string, unknown>) => [x.id, x.name])) as Record<string, string>,
    teachers: Object.fromEntries((tch.data ?? []).map((x: Record<string, unknown>) => [x.id, x.full_name])) as Record<string, string>,
    schools: Object.fromEntries((sch.data ?? []).map((x: Record<string, unknown>) => [x.id, `${x.name} (${x.code})`])) as Record<string, string>,
  };
}

/* ---- the roster ----
   ?status=active (default) | archived | all, ?classId=, ?schoolId= (all-schools
   scope only), ?q= (name, username or code). */
app.get("/learners", requirePermission("learners.manage", "learners.view.school", "learners.view.all"), async (c) => {
  const scope = await learnerScope(c);
  if (scope.kind === "none") return c.json({ learners: [] });
  const status = c.req.query("status") ?? "active";
  const classId = c.req.query("classId") ?? "";
  const schoolFilter = scope.kind === "all" ? (c.req.query("schoolId") ?? "") : scope.schoolId;
  const q = String(c.req.query("q") ?? "").trim().toLowerCase();
  const { data, error } = await selectAll(() => {
    let query = admin.from("learners").select(LEARNER_ROSTER_COLS).order("full_name").order("id");
    if (schoolFilter) query = query.eq("school_id", schoolFilter);
    if (status === "active") query = query.eq("enrollment_status", ACTIVE);
    else if (status === "archived") query = query.neq("enrollment_status", ACTIVE);
    if (classId) query = query.eq("class_id", classId);
    return query;
  });
  if (error) return c.json({ error: error.message }, 500);
  const rows = (data ?? []).filter((l) => inLearnerScope(scope, l)).filter((l) => !q ||
    [l.full_name, l.username, l.learner_code, l.user_code].some((v) => String(v ?? "").toLowerCase().includes(q)));
  const names = await rosterNames(rows);
  return c.json({ learners: rows.map((r) => mapRosterLearner(r, names)) });
});

app.post("/learners", requirePermission("learners.manage", "learners.manage.school", "learners.manage.all"), async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const actor = c.get("actor");
  const username = String(b.username ?? "").trim().toLowerCase();
  const pin = String(b.pin ?? "").trim();
  const fullName = String(b.fullName ?? "").trim();
  if (!fullName) return c.json({ error: "Full name is required" }, 400);
  if (!USERNAME_RE.test(username)) {
    return c.json({ error: "Username: 3–32 chars, lowercase letters, digits, . _ -" }, 400);
  }
  if (!PIN_RE.test(pin)) return c.json({ error: "PIN must be exactly 4 digits" }, 400);
  const gender = cleanGender(b.gender);
  if (gender === false) return c.json({ error: GENDER_ERROR }, 400);

  // The school is the caller's own — only an all-schools administrator
  // picks one. A client can never place a learner in someone else's school.
  const scope = await learnerScope(c);
  const schoolId = actorCan(c, "learners.manage.all") ? (b.schoolId ?? actor.schoolId) : actor.schoolId;
  const school = await loadSchool(schoolId);
  if (!school) return c.json({ error: actorCan(c, "learners.manage.all") ? "Choose a school" : "Choose your school first — reload the page to pick it" }, 409);
  if (!inScope(c, school.id)) return c.json({ error: "Choose a school in your area" }, 403);

  let cls: Record<string, any> | null = null;
  if (b.classId) {
    cls = await loadClass(b.classId);
    if (!cls || cls.school_id !== school.id || cls.archived_at) return c.json({ error: "Choose a class in this school" }, 400);
    if (scope.kind === "teacher" && !scope.classIds.includes(cls.id)) return c.json({ error: "You can only add learners to classes you teach" }, 403);
  }

  const { data: taken } = await admin.from("learners").select("id").eq("username", username).maybeSingle();
  if (taken) return c.json({ error: "That username is taken" }, 409);

  const cal = await currentCalendar();
  if (!cal.yearId) return c.json({ error: "No current academic year is set — ask an administrator." }, 409);
  const grade = cls ? cls.grade : String(b.grade ?? "").trim();
  const teacherId = cls ? await classTeacherOf(cls.id) : (scope.kind === "teacher" ? actor.id : null);

  const salt = randomBytes(16).toString("hex");
  const { data, error } = await admin
    .from("learners")
    .insert({
      teacher_id: scope.kind === "teacher" ? actor.id : null, // who added them
      username,
      pin_hash: hashPin(pin, salt),
      pin_salt: salt,
      full_name: fullName,
      grade,
      gender,
      school: school.name,
      county: school.county,
      enrollment_status: ACTIVE,
    })
    .select("id")
    .single();
  if (error) return c.json({ error: error.message }, 400);
  try {
    const placed = await placeInSchool("learners", data.id, school, "learner");
    await admin.from("learners").update({ learner_code: placed.user_code }).eq("id", data.id);
    await openEnrollment(c, data.id, {
      schoolId: school.id, classId: cls?.id ?? null, grade, teacherId,
      yearId: cal.yearId, termId: cal.termId, date: today(),
    });
    await audit(c, "learner.created", "learner", data.id,
      { username, fullName, grade, schoolId: school.id, classId: cls?.id ?? null, learnerCode: placed.user_code });
    const { data: row } = await admin.from("learners").select("*").eq("id", data.id).single();
    return c.json({ learner: mapRosterLearner(row, await rosterNames([row])) });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

app.patch("/learners/:id", requirePermission("learners.manage", "learners.manage.school", "learners.manage.all"), async (c) => {
  const found = await loadScopedLearner(c, true);
  if (found instanceof Response) return found;
  const { learner: existing, scope } = found;
  const id = existing.id as string;
  const b = await c.req.json().catch(() => ({}));
  const patch: Record<string, unknown> = {};

  if (b.fullName !== undefined) {
    const fn = String(b.fullName).trim();
    if (!fn) return c.json({ error: "Full name is required" }, 400);
    patch.full_name = fn;
  }
  if (b.grade !== undefined) patch.grade = String(b.grade).trim();
  if (b.gender !== undefined) {
    const g = cleanGender(b.gender);
    if (g === false) return c.json({ error: GENDER_ERROR }, 400);
    patch.gender = g;
  }
  if (b.username !== undefined) {
    const u = String(b.username).trim().toLowerCase();
    if (!USERNAME_RE.test(u)) {
      return c.json({ error: "Username: 3–32 chars, lowercase letters, digits, . _ -" }, 400);
    }
    const { data: taken } = await admin
      .from("learners").select("id").eq("username", u).neq("id", id).maybeSingle();
    if (taken) return c.json({ error: "That username is taken" }, 409);
    patch.username = u;
  }
  if (b.pin !== undefined) {
    const pin = String(b.pin).trim();
    if (!PIN_RE.test(pin)) return c.json({ error: "PIN must be exactly 4 digits" }, 400);
    const salt = randomBytes(16).toString("hex");
    patch.pin_salt = salt;
    patch.pin_hash = hashPin(pin, salt);
    patch.failed_attempts = 0;
    patch.locked_until = null;
  }
  if (b.unlock) {
    patch.failed_attempts = 0;
    patch.locked_until = null;
  }
  // Moving between classes stays inside the learner's school. A teacher can
  // only move learners between classes they teach.
  let classMove: { from: unknown; to: string | null } | null = null;
  if (b.classId !== undefined && (b.classId || null) !== (existing.class_id ?? null)) {
    if (existing.enrollment_status !== ACTIVE) return c.json({ error: "Reactivate the learner before moving them to a class." }, 409);
    let cls: Record<string, any> | null = null;
    if (b.classId) {
      cls = await loadClass(b.classId);
      if (!cls || cls.school_id !== existing.school_id || cls.archived_at) return c.json({ error: "Choose a class in the learner's school" }, 400);
      if (scope.kind === "teacher" && !scope.classIds.includes(cls.id)) return c.json({ error: "You can only move learners into classes you teach" }, 403);
      patch.grade = b.grade !== undefined ? patch.grade : cls.grade;
      patch.current_teacher_id = await classTeacherOf(cls.id);
    } else {
      patch.current_teacher_id = scope.kind === "teacher" ? c.get("actor").id : null;
    }
    patch.class_id = cls?.id ?? null;
    classMove = { from: existing.class_id ?? null, to: cls?.id ?? null };
  }
  if (!Object.keys(patch).length) return c.json({ error: "Nothing to update" }, 400);
  patch.updated_at = new Date().toISOString();

  const { data, error } = await admin.from("learners").update(patch).eq("id", id).select(LEARNER_ROSTER_COLS).single();
  if (error) return c.json({ error: error.message }, 400);
  // The open enrollment follows the class and grade.
  if (classMove || patch.grade !== undefined) {
    await admin.from("learner_enrollments").update({
      ...(classMove ? { class_id: classMove.to, teacher_id: patch.current_teacher_id ?? null } : {}),
      ...(patch.grade !== undefined ? { grade: patch.grade } : {}),
    }).eq("learner_id", id).eq("status", ACTIVE);
  }
  // Never the PIN itself — only which fields changed.
  const changed = Object.keys(patch).filter((k) => !["pin_hash", "pin_salt", "failed_attempts", "locked_until", "updated_at", "class_id", "current_teacher_id"].includes(k));
  if (patch.pin_hash) await audit(c, "learner.pin_reset", "learner", id, {});
  else if (b.unlock) await audit(c, "learner.unlocked", "learner", id, {});
  if (classMove) await audit(c, "learner.class_changed", "learner", id, classMove);
  if (changed.length) await audit(c, "learner.updated", "learner", id, { fields: changed });
  return c.json({ learner: mapRosterLearner(data, await rosterNames([data])) });
});

/* Leaving, or coming back: archive with a status (never a deletion), or
   reactivate. Archiving signs the learner out everywhere. */
// deno-lint-ignore no-explicit-any
async function setLearnerStatus(c: any, learner: Record<string, any>, status: string, reasonIn: unknown, dateIn: unknown) {
  const id = learner.id as string;
  const reason = String(reasonIn ?? "").trim().slice(0, 300) || null;
  const date = DATE_RE.test(String(dateIn ?? "")) ? String(dateIn) : today();
  const from = learner.enrollment_status ?? ACTIVE;
  if (status === ACTIVE) {
    if (from === ACTIVE) return c.json({ error: "This learner is already active." }, 409);
    const cal = await currentCalendar();
    if (!cal.yearId) return c.json({ error: "No current academic year is set — ask an administrator." }, 409);
    const cls = await loadClass(learner.class_id);
    const classId = cls && !cls.archived_at && cls.school_id === learner.school_id ? cls.id : null;
    try {
      await openEnrollment(c, id, {
        schoolId: learner.school_id, classId, grade: learner.grade ?? "",
        teacherId: classId ? await classTeacherOf(classId) : (learner.teacher_id ?? null),
        yearId: cal.yearId, termId: cal.termId, date,
      });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    await audit(c, "learner.reactivated", "learner", id, { from, schoolId: learner.school_id });
  } else {
    if (!EXIT_STATUSES.includes(status as EnrollmentStatus)) {
      return c.json({ error: "Status must be ACTIVE, TRANSFERRED, DROPPED_OUT, COMPLETED or INACTIVE" }, 400);
    }
    if (from !== ACTIVE) return c.json({ error: "This learner is already archived. Reactivate them first to change it." }, 409);
    await closeEnrollment(c, id, status as EnrollmentStatus, date, reason);
    const { error } = await admin.from("learners").update({
      enrollment_status: status, exit_date: date, exit_reason: reason, updated_at: new Date().toISOString(),
    }).eq("id", id);
    if (error) return c.json({ error: error.message }, 400);
    await admin.from("learner_sessions").delete().eq("learner_id", id);
    await audit(c, "learner.archived", "learner", id, { status, reason, exitDate: date, schoolId: learner.school_id });
  }
  const { data } = await admin.from("learners").select("*").eq("id", id).single();
  return c.json({ learner: mapRosterLearner(data, await rosterNames([data])) });
}

app.post("/learners/:id/status", requirePermission("learners.manage", "learners.manage.school", "learners.manage.all"), async (c) => {
  const found = await loadScopedLearner(c, true);
  if (found instanceof Response) return found;
  const b = await c.req.json().catch(() => ({}));
  return setLearnerStatus(c, found.learner, String(b.status ?? "").toUpperCase(), b.reason, b.exitDate);
});

/* Kept for older pages: "Remove" now archives as INACTIVE. Nothing is deleted. */
app.delete("/learners/:id", requirePermission("learners.manage", "learners.manage.school", "learners.manage.all"), async (c) => {
  const found = await loadScopedLearner(c, true);
  if (found instanceof Response) return found;
  if (found.learner.enrollment_status !== ACTIVE) return c.json({ ok: true, archived: true });
  const res = await setLearnerStatus(c, found.learner, "INACTIVE", "Removed from the roster", today());
  return res.status === 200 ? c.json({ ok: true, archived: true }) : res;
});

/* Moving to another school: the old enrollment closes as TRANSFERRED and
   stays on record; a new one opens at the new school, with a new school
   code. The permanent learner code, sign-in, assignments and library
   history all stay with the learner. */
app.post("/learners/:id/transfer", requirePermission("learners.transfer"), async (c) => {
  const { data: learner } = await admin.from("learners").select("*").eq("id", c.req.param("id")).maybeSingle();
  if (!learner || !inScope(c, learner.school_id, learner.county)) return c.json({ error: "Learner not found" }, 404);
  const b = await c.req.json().catch(() => ({}));
  const to = await loadSchool(b.toSchoolId);
  if (!to) return c.json({ error: "Choose the school they're moving to" }, 400);
  if (!inScope(c, to.id)) return c.json({ error: "Choose a school in your area" }, 403);
  if (to.id === learner.school_id) return c.json({ error: "They're already in that school — move them to another class instead." }, 400);
  let cls: Record<string, any> | null = null;
  if (b.toClassId) {
    cls = await loadClass(b.toClassId);
    if (!cls || cls.school_id !== to.id || cls.archived_at) return c.json({ error: "Choose a class in the new school" }, 400);
  }
  const cal = await currentCalendar();
  if (!cal.yearId) return c.json({ error: "No current academic year is set." }, 409);
  const date = DATE_RE.test(String(b.effectiveDate ?? "")) ? String(b.effectiveDate) : today();
  const reason = String(b.reason ?? "").trim().slice(0, 300) || null;
  const from = { schoolId: learner.school_id, classId: learner.class_id ?? null, code: learner.user_code, status: learner.enrollment_status };

  if (learner.enrollment_status === ACTIVE) {
    await closeEnrollment(c, learner.id, "TRANSFERRED", date, reason ? `Moved to ${to.name}: ${reason}` : `Moved to ${to.name}`);
  }
  try {
    const placed = await placeInSchool("learners", learner.id, to, "learner");
    const grade = cls ? cls.grade : String(b.grade ?? learner.grade ?? "").trim();
    await openEnrollment(c, learner.id, {
      schoolId: to.id, classId: cls?.id ?? null, grade,
      teacherId: cls ? await classTeacherOf(cls.id) : null,
      yearId: cal.yearId, termId: cal.termId, date,
    });
    await admin.from("learners").update({ learner_code: learner.learner_code ?? from.code }).eq("id", learner.id);
    await audit(c, "learner.transferred", "learner", learner.id, {
      fromSchoolId: from.schoolId, toSchoolId: to.id, fromClassId: from.classId, toClassId: cls?.id ?? null,
      fromCode: from.code, toCode: placed.user_code, previousStatus: from.status, reason, effectiveDate: date,
    });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
  const { data } = await admin.from("learners").select("*").eq("id", learner.id).single();
  return c.json({ learner: mapRosterLearner(data, await rosterNames([data])) });
});

/* Every enrollment this learner has had, in any school — for whoever may
   see the learner now. */
app.get("/learners/:id/history", requirePermission("learners.manage", "learners.view.school", "learners.view.all"), async (c) => {
  const found = await loadScopedLearner(c, false);
  if (found instanceof Response) return found;
  const { data, error } = await admin.from("learner_enrollments").select("*")
    .eq("learner_id", found.learner.id).order("enrollment_date", { ascending: false }).order("created_at", { ascending: false });
  if (error) return c.json({ error: error.message }, 500);
  const rows = data ?? [];
  const names = await rosterNames(rows);
  return c.json({
    learner: mapRosterLearner(found.learner, await rosterNames([found.learner])),
    enrollments: rows.map((e) => mapEnrollment(e, names)),
  });
});

const mapEnrollment = (e: Record<string, unknown>, names: Awaited<ReturnType<typeof rosterNames>>) => ({
  id: e.id,
  learnerId: e.learner_id,
  schoolId: e.school_id,
  school: names.schools[e.school_id as string] ?? null,
  classId: e.class_id ?? null,
  className: e.class_id ? names.classes[e.class_id as string] ?? null : null,
  teacherName: e.teacher_id ? names.teachers[e.teacher_id as string] ?? null : null,
  academicYear: e.academic_year_id,
  term: e.term_id ?? null,
  grade: e.grade,
  status: e.status,
  enrollmentDate: e.enrollment_date,
  exitDate: e.exit_date ?? null,
  exitReason: e.exit_reason ?? null,
});

/* A school's enrollment records, past and present — including learners who
   have since left or moved to another school (their old rows stay here). */
app.get("/enrollments", requirePermission("learners.view.school", "learners.view.all"), async (c) => {
  const scope = await learnerScope(c);
  const schoolId = scope.kind === "school" ? scope.schoolId : String(c.req.query("schoolId") ?? "");
  if (scope.kind !== "all" && scope.kind !== "school") return c.json({ enrollments: [] });
  if (!schoolId) return c.json({ error: "Choose a school" }, 400);
  if (scope.kind === "all" && !inPlaceScope(scope.within, schoolId)) return c.json({ enrollments: [] });
  const status = c.req.query("status") ?? "";
  const { data, error } = await selectAll(() => {
    let q = admin.from("learner_enrollments").select("*").eq("school_id", schoolId)
      .order("enrollment_date", { ascending: false }).order("id");
    if (status === "past") q = q.neq("status", ACTIVE);
    else if (status) q = q.eq("status", status.toUpperCase());
    return q;
  });
  if (error) return c.json({ error: error.message }, 500);
  const rows = data ?? [];
  const learnerIds = [...new Set(rows.map((r) => r.learner_id))];
  const { data: learners } = learnerIds.length
    ? await admin.from("learners").select("id, full_name, learner_code, user_code").in("id", learnerIds)
    : { data: [] as Record<string, unknown>[] };
  const who = Object.fromEntries((learners ?? []).map((l) => [l.id, l]));
  const names = await rosterNames(rows);
  return c.json({
    enrollments: rows.map((e) => ({
      ...mapEnrollment(e, names),
      learnerName: who[e.learner_id]?.full_name ?? null,
      learnerCode: who[e.learner_id]?.learner_code ?? who[e.learner_id]?.user_code ?? null,
    })),
  });
});

/* A teacher's (or head's, or admin's) read-only look at one learner's real
   activity — their assignments (completion and marks, kept apart) and
   library usage/badges. Only work set in the caller's own scope. Never the PIN. */
app.get("/learners/:id/activity", requirePermission("learners.manage", "learners.view.school", "learners.view.all"), async (c) => {
  const found = await loadScopedLearner(c, false);
  if (found instanceof Response) return found;
  const learner = found.learner;
  const id = learner.id as string;
  try {
    const [work, library, scope, bands] = await Promise.all([loadWork({ learnerId: id }), loadLibraryUsage(id), assignmentScope(c), loadBands()]);
    const pairs = work.pairs.filter((p) => inAssignmentScope(scope, { school_id: p.a.schoolId, class_id: p.a.classId }));
    const byId = new Map(work.assignments.map((a) => [a.id, a]));
    const rows = pairs.map((p) => byId.get(p.a.id)!);
    const names = await assignmentNames(rows);
    const subs = new Map(work.submissions.filter((s) => s.learner_id === id).map((s) => [s.assignment_id, s]));
    return c.json({
      learner: {
        id: learner.id, fullName: learner.full_name, username: learner.username,
        grade: learner.grade, school: learner.school, county: learner.county,
      },
      summary: summarize(pairs, bands),
      assignments: rows.map((a) => {
        const s = subs.get(a.id);
        return {
          id: a.id, title: a.title, subject: names.subjects[a.subject_id] ?? a.subject_id,
          className: names.classes[a.class_id] ?? null, dueAt: a.due_at ?? null, status: a.status,
          completion: completionOf(s), submission: s ? mapSubmission(s) : null,
        };
      }).sort((x, y) => String(y.dueAt ?? "").localeCompare(String(x.dueAt ?? ""))),
      library,
    });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

// ---- academic calendar ----

app.get("/academic-years", requireStaff(), async (c) => {
  const [{ data: years }, { data: terms }] = await Promise.all([
    admin.from("academic_years").select("*").order("id", { ascending: false }),
    admin.from("terms").select("*").order("id"),
  ]);
  const cal = await currentCalendar();
  return c.json({
    currentYear: cal.yearId,
    currentTerm: cal.termId,
    years: (years ?? []).map((y) => ({
      id: y.id, label: y.label, startsOn: y.starts_on, endsOn: y.ends_on, isCurrent: !!y.is_current,
      terms: (terms ?? []).filter((t) => t.academic_year_id === y.id)
        .map((t) => ({ id: t.id, termNo: t.term_no, startsOn: t.starts_on, endsOn: t.ends_on })),
    })),
  });
});

/* A new academic year with its three terms (Jan–Apr, May–Aug, Sep–Dec
   unless dates are given). makeCurrent switches the whole portal to it. */
app.post("/academic-years", requirePermission("calendar.manage"), async (c) => {
  if (!scopeOf(c).global) return c.json({ error: WHOLE_PORTAL_ONLY }, 403);
  const b = await c.req.json().catch(() => ({}));
  const id = String(b.id ?? "").trim();
  if (!/^\d{4}$/.test(id)) return c.json({ error: "The year must be four digits, e.g. 2027" }, 400);
  const { data: exists } = await admin.from("academic_years").select("id").eq("id", id).maybeSingle();
  if (!exists) {
    const { error } = await admin.from("academic_years").insert({
      id, label: String(b.label ?? id), starts_on: `${id}-01-01`, ends_on: `${id}-12-31`, is_current: false,
    });
    if (error) return c.json({ error: error.message }, 400);
    const defaults = [["01-01", "04-30"], ["05-01", "08-31"], ["09-01", "12-31"]];
    const terms = (Array.isArray(b.terms) && b.terms.length === 3 ? b.terms : defaults.map(([s, e]) => ({ startsOn: `${id}-${s}`, endsOn: `${id}-${e}` })))
      .map((t: { startsOn: string; endsOn: string }, i: number) => ({
        id: `${id}-T${i + 1}`, academic_year_id: id, term_no: i + 1, starts_on: t.startsOn, ends_on: t.endsOn,
      }));
    const { error: tErr } = await admin.from("terms").insert(terms);
    if (tErr) return c.json({ error: tErr.message }, 400);
    await audit(c, "calendar.year_created", "academic_year", id, { terms: terms.map((t: { id: string }) => t.id) });
  }
  if (b.makeCurrent) {
    await admin.from("academic_years").update({ is_current: false }).eq("is_current", true);
    await admin.from("academic_years").update({ is_current: true }).eq("id", id);
    await audit(c, "calendar.year_made_current", "academic_year", id, {});
  }
  return c.json({ ok: true, id });
});

// ---- classes ----

/** Which school's classes the caller may manage: their own (school head)
    or any (administrator). */
// deno-lint-ignore no-explicit-any
function canManageClassesIn(c: any, schoolId: string) {
  if (actorCan(c, "classes.manage.all")) return inScope(c, schoolId);
  return actorCan(c, "classes.manage.school") && c.get("actor").schoolId === schoolId;
}

app.get("/classes", requirePermission("learners.manage", "learners.view.school", "learners.view.all", "classes.manage.school", "classes.manage.all"), async (c) => {
  const scope = await learnerScope(c);
  const actor = c.get("actor");
  const yearId = c.req.query("academicYearId") || (await currentCalendar()).yearId;
  const includeArchived = c.req.query("includeArchived") === "1";
  let schoolId = String(c.req.query("schoolId") ?? "");
  if (scope.kind === "school" || scope.kind === "teacher") schoolId = scope.schoolId;
  if (scope.kind === "none") return c.json({ classes: [] });
  if (scope.kind === "all" && schoolId && !inPlaceScope(scope.within, schoolId)) return c.json({ classes: [] });
  const { data, error } = await selectAll(() => {
    let q = admin.from("classes").select("*").order("grade").order("name").order("id");
    if (schoolId) q = q.eq("school_id", schoolId);
    if (yearId && c.req.query("allYears") !== "1") q = q.eq("academic_year_id", yearId);
    if (!includeArchived) q = q.is("archived_at", null);
    return q;
  });
  if (error) return c.json({ error: error.message }, 500);
  let rows = (data ?? []).filter((r) => scope.kind !== "all" || inPlaceScope(scope.within, r.school_id));
  // A teacher sees the classes they teach.
  if (scope.kind === "teacher" && c.req.query("mine") !== "0") rows = rows.filter((r) => scope.classIds.includes(r.id));
  const ids = rows.map((r) => r.id);
  const [{ data: ct }, { data: enrolled }, { data: cs }, { data: subjects }, { data: terms }] = await Promise.all([
    ids.length ? admin.from("class_teachers").select("*").in("class_id", ids).is("ended_at", null) : { data: [] },
    ids.length ? admin.from("learners").select("class_id").in("class_id", ids).eq("enrollment_status", ACTIVE) : { data: [] },
    ids.length ? admin.from("class_subjects").select("*").in("class_id", ids).is("removed_at", null) : { data: [] },
    admin.from("subjects").select("id, name, sort_order"),
    yearId ? admin.from("terms").select("*").eq("academic_year_id", yearId) : { data: [] },
  ]);
  const subjectName = Object.fromEntries((subjects ?? []).map((x: Record<string, unknown>) => [x.id, x.name]));
  const teacherIds = [...new Set((ct ?? []).map((t: Record<string, unknown>) => t.teacher_id))] as string[];
  const { data: profs } = teacherIds.length ? await admin.from("profiles").select("id, full_name").in("id", teacherIds) : { data: [] };
  const tName = Object.fromEntries((profs ?? []).map((p: Record<string, unknown>) => [p.id, p.full_name]));
  // Whoever manages this school's classes also gets its teachers, to assign.
  let schoolTeachers: { id: unknown; fullName: unknown }[] = [];
  if (schoolId && canManageClassesIn(c, schoolId)) {
    const { data: staff } = await admin.from("profiles").select("id, full_name")
      .eq("school_id", schoolId).eq("role", "teacher").eq("status", "active").order("full_name");
    schoolTeachers = (staff ?? []).map((t) => ({ id: t.id, fullName: t.full_name }));
  }
  return c.json({
    schoolTeachers,
    academicYear: yearId,
    terms: (terms ?? []).sort((x: Record<string, any>, y: Record<string, any>) => x.term_no - y.term_no)
      .map((t: Record<string, unknown>) => ({ id: t.id, termNo: t.term_no, label: termLabel(t.id), startsOn: t.starts_on, endsOn: t.ends_on })),
    classes: rows.map((r) => ({
      id: r.id, schoolId: r.school_id, academicYear: r.academic_year_id, grade: r.grade, name: r.name,
      archived: !!r.archived_at,
      learnerCount: (enrolled ?? []).filter((e: Record<string, unknown>) => e.class_id === r.id).length,
      teachers: (ct ?? []).filter((t: Record<string, unknown>) => t.class_id === r.id)
        .map((t: Record<string, unknown>) => ({ teacherId: t.teacher_id, name: tName[t.teacher_id as string] ?? null, role: t.role })),
      teachesIt: (ct ?? []).some((t: Record<string, unknown>) => t.class_id === r.id && t.teacher_id === actor.id),
      subjects: (cs ?? []).filter((x: Record<string, unknown>) => x.class_id === r.id)
        .map((x: Record<string, unknown>) => ({ id: x.subject_id, name: subjectName[x.subject_id as string] ?? x.subject_id }))
        .sort((x: { name: unknown }, y: { name: unknown }) => String(x.name).localeCompare(String(y.name))),
    })),
  });
});

app.post("/classes", requirePermission("classes.manage.school", "classes.manage.all"), async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const actor = c.get("actor");
  const schoolId = actorCan(c, "classes.manage.all") ? String(b.schoolId ?? actor.schoolId ?? "") : actor.schoolId;
  const school = await loadSchool(schoolId);
  if (!school || !canManageClassesIn(c, school.id)) return c.json({ error: "Choose a school you manage" }, 403);
  const grade = String(b.grade ?? "");
  if (!GRADES.includes(grade as never)) return c.json({ error: "Choose a grade" }, 400);
  const name = String(b.name ?? "").trim().replace(/\s+/g, " ") || grade;
  const yearId = String(b.academicYearId ?? "") || (await currentCalendar()).yearId;
  if (!yearId) return c.json({ error: "No current academic year is set — ask an administrator." }, 409);
  const { data, error } = await admin.from("classes").insert({
    id: rid("cls"), school_id: school.id, academic_year_id: yearId, grade, name, created_by: actor.id,
  }).select().single();
  if (error) return c.json({ error: isUniqueViolation(error) ? `${name} already exists this year` : error.message }, 400);
  await audit(c, "class.created", "class", data.id, { schoolId: school.id, academicYear: yearId, grade, name });
  return c.json({ class: { id: data.id, schoolId: data.school_id, academicYear: data.academic_year_id, grade, name } });
});

app.patch("/classes/:id", requirePermission("classes.manage.school", "classes.manage.all"), async (c) => {
  const cls = await loadClass(c.req.param("id"));
  if (!cls || !canManageClassesIn(c, cls.school_id)) return c.json({ error: "Class not found" }, 404);
  const b = await c.req.json().catch(() => ({}));
  const patch: Record<string, unknown> = {};
  if (b.name !== undefined) {
    const name = String(b.name).trim().replace(/\s+/g, " ");
    if (!name) return c.json({ error: "Class name is required" }, 400);
    patch.name = name;
  }
  if (b.grade !== undefined && b.grade !== cls.grade) {
    if (!GRADES.includes(String(b.grade) as never)) return c.json({ error: "Choose a grade" }, 400);
    const { count } = await admin.from("learners").select("id", { count: "exact", head: true })
      .eq("class_id", cls.id).eq("enrollment_status", ACTIVE);
    if ((count ?? 0) > 0) return c.json({ error: "The grade can only change while the class has no active learners — promote them instead." }, 409);
    patch.grade = String(b.grade);
  }
  if (b.archived === true && !cls.archived_at) {
    const { count } = await admin.from("learners").select("id", { count: "exact", head: true })
      .eq("class_id", cls.id).eq("enrollment_status", ACTIVE);
    if ((count ?? 0) > 0) return c.json({ error: `${count} active learner(s) are still in this class — move or promote them first.` }, 409);
    Object.assign(patch, { archived_at: new Date().toISOString(), archived_by: c.get("actor").id });
    await admin.from("class_teachers").update({ ended_at: new Date().toISOString(), ended_by: c.get("actor").id })
      .eq("class_id", cls.id).is("ended_at", null);
  }
  if (!Object.keys(patch).length) return c.json({ error: "Nothing to update" }, 400);
  const { error } = await admin.from("classes").update(patch).eq("id", cls.id);
  if (error) return c.json({ error: isUniqueViolation(error) ? "Another class already has that name" : error.message }, 400);
  await audit(c, patch.archived_at ? "class.archived" : "class.updated", "class", cls.id, { fields: Object.keys(patch) });
  return c.json({ ok: true });
});

/* Assign a teacher. A new class teacher replaces the previous one (that
   assignment is ended, not deleted) and becomes the current teacher of
   every active learner in the class. */
app.post("/classes/:id/teachers", requirePermission("classes.manage.school", "classes.manage.all"), async (c) => {
  const cls = await loadClass(c.req.param("id"));
  if (!cls || cls.archived_at || !canManageClassesIn(c, cls.school_id)) return c.json({ error: "Class not found" }, 404);
  const b = await c.req.json().catch(() => ({}));
  const role = b.role === "subject_teacher" ? "subject_teacher" : "class_teacher";
  const { data: teacher } = await admin.from("profiles").select("id, role, status, school_id, full_name").eq("id", String(b.teacherId ?? "")).maybeSingle();
  if (!teacher || teacher.role !== "teacher" || (teacher.status ?? "active") !== "active" || teacher.school_id !== cls.school_id) {
    return c.json({ error: "Choose an active teacher from this school" }, 400);
  }
  const now = new Date().toISOString();
  const actorId = c.get("actor").id;
  // Same teacher already on this class → change their role in place.
  await admin.from("class_teachers").update({ ended_at: now, ended_by: actorId })
    .eq("class_id", cls.id).eq("teacher_id", teacher.id).is("ended_at", null);
  if (role === "class_teacher") {
    await admin.from("class_teachers").update({ ended_at: now, ended_by: actorId })
      .eq("class_id", cls.id).eq("role", "class_teacher").is("ended_at", null);
  }
  const { error } = await admin.from("class_teachers").insert({
    id: rid("ct"), class_id: cls.id, teacher_id: teacher.id, role, assigned_by: actorId,
  });
  if (error) return c.json({ error: error.message }, 400);
  if (role === "class_teacher") {
    await admin.from("learners").update({ current_teacher_id: teacher.id }).eq("class_id", cls.id).eq("enrollment_status", ACTIVE);
    await admin.from("learner_enrollments").update({ teacher_id: teacher.id }).eq("class_id", cls.id).eq("status", ACTIVE);
  }
  await audit(c, "class.teacher_assigned", "class", cls.id, { teacherId: teacher.id, role });
  return c.json({ ok: true });
});

app.delete("/classes/:id/teachers/:teacherId", requirePermission("classes.manage.school", "classes.manage.all"), async (c) => {
  const cls = await loadClass(c.req.param("id"));
  if (!cls || !canManageClassesIn(c, cls.school_id)) return c.json({ error: "Class not found" }, 404);
  const teacherId = c.req.param("teacherId");
  const { data: ended } = await admin.from("class_teachers")
    .update({ ended_at: new Date().toISOString(), ended_by: c.get("actor").id })
    .eq("class_id", cls.id).eq("teacher_id", teacherId).is("ended_at", null).select("role");
  if (!ended?.length) return c.json({ error: "That teacher isn't assigned to this class" }, 404);
  if (ended.some((e: Record<string, unknown>) => e.role === "class_teacher")) {
    await admin.from("learners").update({ current_teacher_id: null }).eq("class_id", cls.id).eq("current_teacher_id", teacherId);
  }
  await audit(c, "class.teacher_removed", "class", cls.id, { teacherId });
  return c.json({ ok: true });
});

/* Which subjects a class takes. Teachers set assignments in these (a class
   with none yet can have work in any subject). Removed, never deleted. */
app.post("/classes/:id/subjects", requirePermission("classes.manage.school", "classes.manage.all"), async (c) => {
  const cls = await loadClass(c.req.param("id"));
  if (!cls || cls.archived_at || !canManageClassesIn(c, cls.school_id)) return c.json({ error: "Class not found" }, 404);
  const b = await c.req.json().catch(() => ({}));
  const { data: subject } = await admin.from("subjects").select("*").eq("id", String(b.subjectId ?? "")).maybeSingle();
  if (!subject || subject.archived_at) return c.json({ error: "Choose a subject" }, 400);
  const { data: open } = await admin.from("class_subjects").select("id").eq("class_id", cls.id).eq("subject_id", subject.id).is("removed_at", null).maybeSingle();
  if (!open) {
    const { error } = await admin.from("class_subjects").insert({ id: rid("csub"), class_id: cls.id, subject_id: subject.id, added_by: c.get("actor").id });
    if (error && !isUniqueViolation(error)) return c.json({ error: error.message }, 400);
    await audit(c, "class.subject_added", "class", cls.id, { subjectId: subject.id });
  }
  return c.json({ ok: true });
});

app.delete("/classes/:id/subjects/:subjectId", requirePermission("classes.manage.school", "classes.manage.all"), async (c) => {
  const cls = await loadClass(c.req.param("id"));
  if (!cls || !canManageClassesIn(c, cls.school_id)) return c.json({ error: "Class not found" }, 404);
  const { data: ended } = await admin.from("class_subjects")
    .update({ removed_at: new Date().toISOString(), removed_by: c.get("actor").id })
    .eq("class_id", cls.id).eq("subject_id", c.req.param("subjectId")).is("removed_at", null).select("id");
  if (!ended?.length) return c.json({ error: "This class doesn't take that subject" }, 404);
  await audit(c, "class.subject_removed", "class", cls.id, { subjectId: c.req.param("subjectId") });
  return c.json({ ok: true });
});

/** Is this class one the caller manages learners in? */
function classInLearnerScope(scope: LearnerScope, cls: Record<string, unknown>) {
  if (scope.kind === "all") return inPlaceScope(scope.within, cls.school_id);
  if (scope.kind === "school") return cls.school_id === scope.schoolId;
  if (scope.kind === "teacher") return cls.school_id === scope.schoolId && scope.classIds.includes(cls.id as string);
  return false;
}

/** Puts a learner into a class (or takes them out), within their school.
    The open enrollment follows, and the move is audited. */
// deno-lint-ignore no-explicit-any
async function setLearnerClass(c: any, l: Record<string, any>, cls: Record<string, any> | null) {
  const actor = c.get("actor");
  const teacherId = cls ? await classTeacherOf(cls.id) : (actor.role === "teacher" ? actor.id : null);
  const patch: Record<string, unknown> = { class_id: cls?.id ?? null, current_teacher_id: teacherId, updated_at: new Date().toISOString() };
  if (cls) patch.grade = cls.grade;
  await admin.from("learners").update(patch).eq("id", l.id);
  await admin.from("learner_enrollments").update({
    class_id: patch.class_id, teacher_id: teacherId, ...(cls ? { grade: cls.grade } : {}),
  }).eq("learner_id", l.id).eq("status", ACTIVE);
  await audit(c, "learner.class_changed", "learner", l.id, { from: l.class_id ?? null, to: patch.class_id });
}

/* Add learners to a class. A teacher: into a class they teach, learners on
   their own roster. A school head: any learner in their school. Always
   active learners of the class's own school. */
app.post("/classes/:id/learners", requirePermission("learners.manage", "learners.manage.school", "learners.manage.all"), async (c) => {
  const cls = await loadClass(c.req.param("id"));
  const scope = await learnerScope(c);
  if (!cls || cls.archived_at || !classInLearnerScope(scope, cls)) return c.json({ error: "Class not found" }, 404);
  const b = await c.req.json().catch(() => ({}));
  const ids = Array.isArray(b.learnerIds) ? [...new Set(b.learnerIds.map(String))].slice(0, 200) as string[] : [];
  if (!ids.length) return c.json({ error: "Choose learners to add" }, 400);
  const rows = await selectIn("learners", "id", ids);
  let added = 0, already = 0;
  for (const l of rows) {
    if (l.class_id === cls.id) { already++; continue; }
    if (!canManageLearner(c, scope, l) || l.school_id !== cls.school_id || (l.enrollment_status ?? ACTIVE) !== ACTIVE) continue;
    await setLearnerClass(c, l, cls);
    added++;
  }
  return c.json({ ok: true, added, already, skipped: ids.length - added - already });
});

app.delete("/classes/:id/learners/:learnerId", requirePermission("learners.manage", "learners.manage.school", "learners.manage.all"), async (c) => {
  const cls = await loadClass(c.req.param("id"));
  const scope = await learnerScope(c);
  if (!cls || !classInLearnerScope(scope, cls)) return c.json({ error: "Class not found" }, 404);
  const { data: l } = await admin.from("learners").select("*").eq("id", c.req.param("learnerId")).maybeSingle();
  if (!l || l.class_id !== cls.id || !canManageLearner(c, scope, l)) return c.json({ error: "That learner isn't in this class" }, 404);
  await setLearnerClass(c, l, null);
  return c.json({ ok: true });
});

/* Promotion: every active learner in the class (or the ones listed) moves
   up a grade. Their enrollment for this class closes (COMPLETED, "promoted
   to …") and a new one opens in the target class — or, from the top
   grade, they're marked COMPLETED (finished school). */
app.post("/classes/:id/promote", requirePermission("learners.manage.school", "learners.manage.all"), async (c) => {
  const from = await loadClass(c.req.param("id"));
  const manages = from && ((actorCan(c, "learners.manage.all") && inScope(c, from.school_id)) ||
    (actorCan(c, "learners.manage.school") && c.get("actor").schoolId === from.school_id));
  if (!from || !manages) return c.json({ error: "Class not found" }, 404);
  const b = await c.req.json().catch(() => ({}));
  const next = nextGrade(from.grade);
  let to: Record<string, any> | null = null;
  if (next) {
    to = await loadClass(b.toClassId);
    if (!to || to.school_id !== from.school_id || to.archived_at) return c.json({ error: "Choose the class they're moving up to, in the same school" }, 400);
    if (to.grade !== next) return c.json({ error: `Learners in ${from.grade} move up to ${next} — choose a ${next} class` }, 400);
  }
  const { data: rows } = await admin.from("learners").select("*").eq("class_id", from.id).eq("enrollment_status", ACTIVE);
  const only = Array.isArray(b.learnerIds) && b.learnerIds.length ? new Set(b.learnerIds.map(String)) : null;
  const learners = (rows ?? []).filter((l) => !only || only.has(l.id));
  if (!learners.length) return c.json({ error: "No active learners to promote in this class" }, 400);
  const date = DATE_RE.test(String(b.effectiveDate ?? "")) ? String(b.effectiveDate) : today();
  const cal = await currentCalendar();
  const toTeacher = to ? await classTeacherOf(to.id) : null;
  const toTerm = to && to.academic_year_id !== cal.yearId ? `${to.academic_year_id}-T1` : cal.termId;
  let promoted = 0, completed = 0;
  for (const l of learners) {
    if (to && next) {
      await closeEnrollment(c, l.id, "COMPLETED", date, `Promoted to ${next}`);
      await openEnrollment(c, l.id, {
        schoolId: l.school_id, classId: to.id, grade: next, teacherId: toTeacher,
        yearId: to.academic_year_id, termId: toTerm, date,
      });
      promoted++;
    } else {
      await closeEnrollment(c, l.id, "COMPLETED", date, `Completed ${from.grade}`);
      await admin.from("learners").update({
        enrollment_status: "COMPLETED", exit_date: date, exit_reason: `Completed ${from.grade}`, updated_at: new Date().toISOString(),
      }).eq("id", l.id);
      completed++;
    }
    await audit(c, "learner.promoted", "learner", l.id, { fromClassId: from.id, toClassId: to?.id ?? null, fromGrade: from.grade, toGrade: next });
  }
  return c.json({ ok: true, promoted, completed });
});

// ---- content library ----

app.get("/library", requireActive(), async (c) => {
  const role = c.get("actor").permissions;
  const { data, error } = await selectAll(() => admin
    .from("library_items")
    .select("*")
    .order("uploaded_at", { ascending: false })
    .order("id"));
  if (error) return c.json({ error: error.message }, 500);
  // A draft is only visible to whoever manages the library — everyone else
  // only ever sees what's actually been published, same as the audience
  // check right next to it. Only they get download links, too.
  const manages = role.has("library.manage");
  const visible = (data ?? []).filter((it) =>
    canSeeLibrary(it.audience as string, role) && (manages || it.published),
  );
  const items = await Promise.all(visible.map((it) => mapLibrary(it, manages)));
  return c.json({ items });
});

const URL_RE = /^https?:\/\/[^\s]+$/i;

app.post("/library", requirePermission("library.manage"), async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (!String(b.title ?? "").trim()) return c.json({ error: "Title is required" }, 400);
  const externalUrl = String(b.externalUrl ?? "").trim();
  if (externalUrl && !URL_RE.test(externalUrl)) {
    return c.json({ error: "Link must start with http:// or https://" }, 400);
  }
  const id = rid("lib");
  const audience = ["staff", "school_leader"].includes(b.audience) ? b.audience : "library";

  let folderId: string | null = null;
  if (b.folderId) {
    const { data: folder } = await admin
      .from("library_folders")
      .select("id, audience")
      .eq("id", b.folderId)
      .maybeSingle();
    if (!folder) return c.json({ error: "Folder not found" }, 400);
    if (folder.audience !== audience) {
      return c.json({ error: "Folder is for a different destination" }, 400);
    }
    folderId = folder.id as string;
  }

  const files: LibFile[] = [];
  const uploads: {
    name: string;
    path: string;
    token: string;
    signedUrl: string;
  }[] = [];
  for (const f of (b.files ?? []) as { name: string; size?: number }[]) {
    const path = `${id}/${safePath(f.name)}`;
    const { data, error } = await admin.storage
      .from(LIBRARY_BUCKET)
      .createSignedUploadUrl(path);
    if (error) return c.json({ error: error.message }, 500);
    files.push({ name: f.name, path, size: f.size ?? 0 });
    uploads.push({ name: f.name, path, token: data.token, signedUrl: data.signedUrl });
  }

  const isFolder = files.length > 1 || !!b.isFolder;
  const { data, error } = await admin
    .from("library_items")
    .insert({
      id,
      title: String(b.title).trim(),
      subject: b.subject,
      type: b.type,
      audience,
      description: String(b.description ?? "").trim(),
      uploaded_by: c.get("actor").fullName,
      file_name: b.fileName ?? files[0]?.name ?? null,
      file_size: files.reduce((s, f) => s + (f.size || 0), 0),
      is_folder: isFolder,
      files,
      external_url: externalUrl || null,
      folder_id: folderId,
    })
    .select()
    .single();
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ item: await mapLibrary(data, true), uploads });
});

/* Publish/unpublish, metadata edits, and folder reassignment — every
   edit this route allows, all on the SAME row (never a new one — this
   is how "picked the wrong subject" gets fixed, or a link gets swapped,
   without losing the item's published state or creating a duplicate).
   A freshly uploaded item starts as a draft (see the table default);
   it's real to the education team immediately (their own GET /library
   shows drafts) but invisible to everyone else until explicitly
   published here. Moving to a folder — explicitly, or implicitly by
   changing the destination away from the folder's own audience —
   requires the folder's audience to match; changing destination without
   picking a new folder auto-unfiles rather than leaving a mismatched,
   inconsistent state. */
app.patch("/library/:id", requirePermission("library.manage"), async (c) => {
  const id = c.req.param("id");
  const b = await c.req.json().catch(() => ({}));
  const { data: current } = await admin
    .from("library_items").select("audience, folder_id").eq("id", id).maybeSingle();
  if (!current) return c.json({ error: "Content not found" }, 404);

  const patch: Record<string, unknown> = {};
  if (typeof b.published === "boolean") patch.published = b.published;
  if (typeof b.title === "string") {
    const title = b.title.trim();
    if (!title) return c.json({ error: "Title is required" }, 400);
    patch.title = title;
  }
  if (typeof b.subject === "string" && b.subject.trim()) patch.subject = b.subject.trim();
  if (typeof b.type === "string" && b.type.trim()) patch.type = b.type.trim();
  if (typeof b.description === "string") patch.description = b.description.trim();
  if (typeof b.externalUrl === "string") {
    const url = b.externalUrl.trim();
    if (url && !URL_RE.test(url)) return c.json({ error: "Link must start with http:// or https://" }, 400);
    patch.external_url = url || null;
  }
  if (typeof b.audience === "string") {
    patch.audience = ["staff", "school_leader"].includes(b.audience) ? b.audience : "library";
  }
  const effectiveAudience = (patch.audience as string | undefined) ?? current.audience as string;

  if ("folderId" in b) {
    if (b.folderId === null) {
      patch.folder_id = null;
    } else {
      const { data: folder } = await admin
        .from("library_folders").select("id, audience").eq("id", b.folderId).maybeSingle();
      if (!folder) return c.json({ error: "Folder not found" }, 400);
      if (folder.audience !== effectiveAudience) {
        return c.json({ error: "Folder is for a different destination" }, 400);
      }
      patch.folder_id = folder.id;
    }
  } else if (patch.audience && current.folder_id) {
    const { data: folder } = await admin
      .from("library_folders").select("audience").eq("id", current.folder_id as string).maybeSingle();
    if (!folder || folder.audience !== effectiveAudience) patch.folder_id = null;
  }

  if (!Object.keys(patch).length) return c.json({ error: "Nothing to update" }, 400);
  const { data, error } = await admin
    .from("library_items")
    .update(patch)
    .eq("id", id)
    .select()
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 400);
  if (!data) return c.json({ error: "Content not found" }, 404);
  return c.json({ item: await mapLibrary(data, true) });
});

/* Organizational folders — a named bucket the education team sorts
   items into (e.g. "Grade 4 Maths"), separate from `isFolder` above
   (an uploaded folder of files becoming one item). Visible to the same
   audience rules as items; deleting a folder never deletes its
   contents (the FK is `on delete set null`, so items just fall back
   to "Unfiled"). */
app.get("/library/folders", requireActive(), async (c) => {
  const role = c.get("actor").permissions;
  const [{ data: folders, error: fErr }, { data: items, error: iErr }] = await Promise.all([
    selectAll(() => admin.from("library_folders").select("*").order("name").order("id")),
    selectAll(() => admin.from("library_items").select("folder_id, audience, published").order("id")),
  ]);
  if (fErr) return c.json({ error: fErr.message }, 500);
  if (iErr) return c.json({ error: iErr.message }, 500);
  const counts = new Map<string, number>();
  for (const it of items ?? []) {
    if (!it.folder_id) continue;
    if (!canSeeLibrary(it.audience as string, role)) continue;
    if (!role.has("library.manage") && !it.published) continue;
    counts.set(it.folder_id as string, (counts.get(it.folder_id as string) ?? 0) + 1);
  }
  const visible = (folders ?? []).filter((f) => canSeeLibrary(f.audience as string, role));
  return c.json({ folders: visible.map((f) => mapFolder(f, counts.get(f.id as string) ?? 0)) });
});

app.post("/library/folders", requirePermission("library.manage"), async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const name = String(b.name ?? "").trim();
  if (!name) return c.json({ error: "Folder name is required" }, 400);
  const audience = ["staff", "school_leader"].includes(b.audience) ? b.audience : "library";
  const { data, error } = await admin
    .from("library_folders")
    .insert({ id: rid("fld"), name, audience, created_by: c.get("actor").fullName })
    .select()
    .single();
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ folder: mapFolder(data, 0) });
});

app.delete("/library/folders/:id", requirePermission("library.manage"), async (c) => {
  const id = c.req.param("id");
  const { error } = await admin.from("library_folders").delete().eq("id", id);
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ ok: true });
});

app.delete("/library/:id", requirePermission("library.manage"), async (c) => {
  const id = c.req.param("id");
  const { data: item } = await admin
    .from("library_items")
    .select("files")
    .eq("id", id)
    .maybeSingle();
  const paths = ((item?.files as LibFile[]) ?? []).map((f) => f.path);
  if (paths.length) await admin.storage.from(LIBRARY_BUCKET).remove(paths);
  const { error } = await admin.from("library_items").delete().eq("id", id);
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ ok: true });
});

// ---- content library: usage tracking ----
// Honest measurement, not a fabricated number: "Open to read" launches a
// signed URL in a new tab (often a PDF/image/video the browser renders
// natively), so there is no way to see what happens inside it. What we
// CAN measure is wall-clock time from the moment someone opens a resource
// to the moment they come back to this tab (see the `visibilitychange`
// listener wired in nav.js) — a reasonable proxy for "time spent", not a
// literal reading-attention measurement. `completedAt`/`durationSeconds`
// stay null until that return trip happens; they're never guessed.

const mapInteraction = (r: Record<string, unknown>) => ({
  id: r.id,
  libraryItemId: r.library_item_id,
  title: (r as any).library_items?.title ?? null,
  role: r.role,
  school: r.school,
  startedAt: r.started_at,
  completedAt: r.completed_at,
  durationSeconds: r.duration_seconds,
});

/* A resource read on a device without a connection: the session arrives
   later with its own start and end (the device's clock) — kept only when
   plausible: not in the future, not more than 60 days old, at most 4 hours. */
function offlineReading(startedAt: unknown, completedAt: unknown) {
  if (typeof startedAt !== "string" || typeof completedAt !== "string") return null;
  const start = new Date(startedAt), end = new Date(completedAt), now = Date.now();
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return null;
  if (end < start || end.getTime() > now + 2 * 60_000 || start.getTime() < now - 60 * 864e5) return null;
  const seconds = Math.min(4 * 3600, Math.round((end.getTime() - start.getTime()) / 1000));
  return { started_at: start.toISOString(), completed_at: new Date(start.getTime() + seconds * 1000).toISOString(), duration_seconds: seconds };
}

app.post("/library/:id/interactions", requireActive(), async (c) => {
  const itemId = c.req.param("id");
  const actor = c.get("actor");
  const body = await c.req.json().catch(() => ({}));
  const offline = offlineReading(body.startedAt, body.completedAt);
  const { data: item } = await admin
    .from("library_items").select("id, audience").eq("id", itemId).maybeSingle();
  if (!item || !canSeeLibrary(item.audience as string, actor.permissions)) {
    return c.json({ error: "Resource not found" }, 404);
  }
  const { data, error } = await admin
    .from("library_interactions")
    .insert({
      id: rid("li"),
      library_item_id: itemId,
      actor_kind: c.get("actorKind") === "learner" ? "learner" : "staff",
      actor_id: actor.id,
      role: actor.role,
      full_name: actor.fullName,
      school: actor.school ?? "",
      ...(offline ?? {}),
    })
    .select()
    .single();
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ interaction: mapInteraction(data) });
});

app.patch("/library/interactions/:id/complete", requireActive(), async (c) => {
  const id = c.req.param("id");
  const actor = c.get("actor");
  const { data: existing } = await admin
    .from("library_interactions").select("id, actor_id, started_at, completed_at")
    .eq("id", id).maybeSingle();
  if (!existing || existing.actor_id !== actor.id) {
    return c.json({ error: "Interaction not found" }, 404);
  }
  if (existing.completed_at) {
    return c.json({ interaction: mapInteraction(existing) }); // already completed — no-op
  }
  const completedAt = new Date();
  const durationSeconds = Math.max(
    0,
    Math.round((completedAt.getTime() - new Date(existing.started_at as string).getTime()) / 1000),
  );
  const { data, error } = await admin
    .from("library_interactions")
    .update({ completed_at: completedAt.toISOString(), duration_seconds: durationSeconds })
    .eq("id", id)
    .select()
    .single();
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ interaction: mapInteraction(data) });
});

/* Shared by "my own activity" (below) and the teacher's read-only view of
   one of their learners (/learners/:id/activity) — same shape either way,
   just a different actorId. */
async function loadLibraryUsage(actorId: string) {
  // The list shows the latest 200 visits; the totals come from every visit.
  const [{ data, error }, all, { data: badgeRows }] = await Promise.all([
    admin
      .from("library_interactions")
      .select("*, library_items(title)")
      .eq("actor_id", actorId)
      .order("started_at", { ascending: false })
      .limit(200),
    selectAll(() => admin
      .from("library_interactions")
      .select("library_item_id, duration_seconds")
      .eq("actor_id", actorId)
      .order("id")),
    admin
      .from("library_badges")
      .select("id, badge, awarded_at, library_items(title)")
      .eq("actor_id", actorId)
      .order("awarded_at", { ascending: false }),
  ]);
  if (error) throw new Error(error.message);
  if (all.error) throw new Error(all.error.message);
  const rows = data ?? [];
  const completed = all.data.filter((r) => r.duration_seconds != null);
  const badges = badgeRows ?? [];
  return {
    totalSeconds: completed.reduce((s, r) => s + (r.duration_seconds as number), 0),
    resourcesOpened: new Set(all.data.map((r) => r.library_item_id)).size,
    interactions: rows.map(mapInteraction),
    badgesEarned: badges.length,
    badges: badges.map((b: any) => ({
      id: b.id,
      badge: b.badge,
      title: b.library_items?.title ?? "",
      awardedAt: b.awarded_at,
    })),
  };
}

/* An actor's own reading history — surfaced on their own dashboard. */
app.get("/library/interactions/mine", requireActive(), async (c) => {
  try {
    return c.json(await loadLibraryUsage(c.get("actor").id));
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

/* Awarded client-side, once, the moment a single viewer session on one
   resource stays open past the engagement threshold (see nav.js) — a
   real celebration for a real stretch of attention, not a claim about
   comprehension. The unique index makes a repeat call for the same
   resource a harmless no-op instead of a duplicate badge. */
app.post("/library/:id/badge", requireActive(), async (c) => {
  const itemId = c.req.param("id");
  const actor = c.get("actor");
  const b = await c.req.json().catch(() => ({}));
  const secondsEngaged = Math.max(0, Math.round(Number(b.secondsEngaged) || 0));

  const { data: item } = await admin
    .from("library_items").select("id, audience, title").eq("id", itemId).maybeSingle();
  if (!item || !canSeeLibrary(item.audience as string, actor.permissions)) {
    return c.json({ error: "Resource not found" }, 404);
  }

  const { data, error } = await admin
    .from("library_badges")
    .insert({
      id: rid("bdg"),
      library_item_id: itemId,
      actor_kind: c.get("actorKind") === "learner" ? "learner" : "staff",
      actor_id: actor.id,
      seconds_engaged: secondsEngaged,
    })
    .select()
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      return c.json({ awarded: false, alreadyAwarded: true });
    }
    return c.json({ error: error.message }, 400);
  }
  return c.json({
    awarded: true,
    badge: { id: data.id, badge: data.badge, title: item.title as string, awardedAt: data.awarded_at },
  });
});

/* Education-team rollup: every school's engagement with the library,
   scoped to one school or portal-wide, plus the ranked resource list and
   a per-school breakdown so "this school" and "all schools" are both one
   filter away — same pattern as the Portal impact dashboard's county/
   school filters. */
app.get("/library/usage", requirePermission("library.usage.view"), async (c) => {
  const school = String(c.req.query("school") ?? "").trim();

  const [itemsRes, interRes] = await Promise.all([
    selectAll(() => admin.from("library_items").select("id, title").order("id")),
    selectAll(() => admin.from("library_interactions")
      .select("library_item_id, actor_id, school, duration_seconds").order("id")),
  ]);
  // A failed read must not render as "nobody used the library".
  const usageErr = itemsRes.error || interRes.error;
  if (usageErr) return c.json({ error: usageErr.message }, 500);
  const items = itemsRes.data ?? [];
  const titleOf: Record<string, string> = {};
  for (const it of items) titleOf[it.id as string] = it.title as string;

  const areaNames = await schoolNamesInScope(c);
  const allRows = (interRes.data ?? []).filter((r) => !areaNames || areaNames.has(r.school));
  const schoolSet = new Set<string>();
  for (const r of allRows) if (r.school) schoolSet.add(r.school as string);
  const schools = [...schoolSet].sort();

  const rows = school ? allRows.filter((r) => (r.school || "") === school) : allRows;
  const completedRows = rows.filter((r) => r.duration_seconds != null);

  const secondsByItem: Record<string, number> = {};
  const viewsByItem: Record<string, number> = {};
  for (const r of rows) {
    const id = r.library_item_id as string;
    viewsByItem[id] = (viewsByItem[id] ?? 0) + 1;
    if (r.duration_seconds != null) secondsByItem[id] = (secondsByItem[id] ?? 0) + (r.duration_seconds as number);
  }
  const byResource = Object.keys(viewsByItem)
    .map((id) => ({
      itemId: id,
      title: titleOf[id] ?? "(deleted resource)",
      views: viewsByItem[id],
      totalSeconds: secondsByItem[id] ?? 0,
    }))
    .sort((a, b) => b.totalSeconds - a.totalSeconds || b.views - a.views);

  const bySchoolAgg: Record<string, { users: Set<string>; sessions: number; seconds: number }> = {};
  for (const r of allRows) {
    const s = (r.school as string) || "(not set)";
    const agg = (bySchoolAgg[s] ??= { users: new Set(), sessions: 0, seconds: 0 });
    agg.users.add(r.actor_id as string);
    agg.sessions++;
    if (r.duration_seconds != null) agg.seconds += r.duration_seconds as number;
  }
  const bySchool = Object.entries(bySchoolAgg)
    .map(([s, agg]) => ({ school: s, users: agg.users.size, sessions: agg.sessions, totalSeconds: agg.seconds }))
    .sort((a, b) => b.totalSeconds - a.totalSeconds);

  return c.json({
    school: school || null,
    schools,
    totals: {
      users: new Set(rows.map((r) => r.actor_id)).size,
      sessions: rows.length,
      completedSessions: completedRows.length,
      totalSeconds: completedRows.reduce((s, r) => s + (r.duration_seconds as number), 0),
    },
    byResource,
    bySchool,
  });
});

/** Names of the schools in the caller's area, or null for everywhere
    (reading is recorded against the reader's school name). */
// deno-lint-ignore no-explicit-any
async function schoolNamesInScope(c: any): Promise<Set<string> | null> {
  const sc = scopeOf(c);
  if (sc.global) return null;
  const { data } = await admin.from("schools").select("id, name");
  return new Set((data ?? []).filter((s) => sc.schoolIds.has(s.id)).map((s) => s.name as string));
}

// ---- forms & responses (staff only) ----

/* Who receives a form: its role, and its county (null = every county).
   A field officer's visit-type forms are the exception — they're filled
   during a visit to a school in any county, so the county check happens
   against that school when the visit is submitted, not here. */
function formReaches(f: Record<string, unknown>, actor: Actor) {
  if (actor.permissions.has("forms.manage") || actor.permissions.has("forms.responses.view")) {
    return actor.scope.global || !f.county || actor.scope.areaCounties.has(String(f.county).toLowerCase());
  }
  // An archived form keeps its responses but is no longer sent to anyone.
  if (f.archived_at) return false;
  if (f.audience !== actor.role) return false;
  if (actor.role === "field_officer" && f.visit_type) return true;
  return !f.county || f.county === actor.county;
}

app.get("/forms", requirePermission("forms.respond", "forms.manage", "forms.responses.view"), async (c) => {
  const p = c.get("actor");
  const { data, error } = await selectAll(() =>
    admin.from("forms").select("*").order("created_at", { ascending: false }).order("id"));
  if (error) return c.json({ error: error.message }, 500);
  const forms = await Promise.all((data ?? []).filter((f) => formReaches(f, p)).map(mapForm));
  return c.json({ forms });
});

app.post("/forms", requirePermission("forms.manage"), async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const title = String(b.title ?? "").trim();
  if (!title) return c.json({ error: "Title is required" }, 400);
  if (!["teacher", "school_leader", "field_officer"].includes(b.audience)) {
    return c.json({ error: "Pick who the form is for" }, 400);
  }
  const kind = FORM_KINDS.includes(b.kind) ? b.kind : "questions";
  const county = b.county ? String(b.county) : null;
  if (county && !(await isCounty(county))) return c.json({ error: "That county isn't on the list" }, 400);
  if (!formChangeable(c, { county })) return c.json({ error: "Send the form to one of your own counties" }, 403);
  const visitType = b.visitType ? String(b.visitType) : null;
  if (visitType && !VISIT_TYPES.includes(visitType)) return c.json({ error: "Pick a valid visit type" }, 400);
  if (visitType && b.audience !== "field_officer") {
    return c.json({ error: "Visit types only apply to forms for field officers" }, 400);
  }

  const questions = Array.isArray(b.questions)
    ? b.questions.filter((q: { prompt?: string }) => String(q?.prompt ?? "").trim())
    : [];
  const externalUrl = String(b.externalUrl ?? "").trim();
  const fileList = Array.isArray(b.files) ? (b.files as { name: string; size?: number }[]) : [];
  if (kind === "questions" && !questions.length) return c.json({ error: "Add at least one question" }, 400);
  if (kind === "link" && !URL_RE.test(externalUrl)) {
    return c.json({ error: "Link must start with http:// or https://" }, 400);
  }
  if (kind === "file" && !fileList.length) return c.json({ error: "Choose the form file to upload" }, 400);
  const dueOn = b.dueOn ? String(b.dueOn) : null;
  if (dueOn && (!DATE_RE.test(dueOn) || visitType)) return c.json({ error: visitType ? "Visit forms are filled in during visits — no due date" : "The due date looks like 2026-10-31" }, 400);

  const id = rid("form");
  const files: LibFile[] = [];
  const uploads: { name: string; path: string; token: string; signedUrl: string }[] = [];
  for (const f of kind === "file" ? fileList : []) {
    const path = `forms/${id}/${safePath(f.name)}`;
    const { data, error } = await admin.storage.from(LIBRARY_BUCKET).createSignedUploadUrl(path);
    if (error) return c.json({ error: error.message }, 500);
    files.push({ name: f.name, path, size: f.size ?? 0 });
    uploads.push({ name: f.name, path, token: data.token, signedUrl: data.signedUrl });
  }

  const { data, error } = await admin
    .from("forms")
    .insert({
      id,
      title,
      description: String(b.description ?? "").trim(),
      audience: b.audience,
      kind,
      county,
      visit_type: visitType,
      external_url: kind === "link" ? externalUrl : null,
      files,
      due_on: dueOn,
      created_by: c.get("actor").fullName,
      questions: kind === "questions" ? questions : [],
    })
    .select()
    .single();
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ form: await mapForm(data), uploads });
});

/* A form's due date — set, changed or cleared (dueOn: null). Everyone the
   form reaches who hasn't answered is reminded as it comes due. */
/** Changing a form: anyone for every county; someone narrowed, only forms sent to a county assigned to them whole. */
// deno-lint-ignore no-explicit-any
function formChangeable(c: any, f: Record<string, any>) {
  const sc = scopeOf(c);
  return sc.global || (!!f.county && sc.counties.has(String(f.county).toLowerCase()));
}

app.patch("/forms/:id", requirePermission("forms.manage"), async (c) => {
  const { data: form } = await admin.from("forms").select("*").eq("id", c.req.param("id")).maybeSingle();
  if (!form || !formChangeable(c, form)) return c.json({ error: "Form not found" }, 404);
  const b = await c.req.json().catch(() => ({}));
  if (b.dueOn === undefined) return c.json({ error: "Nothing to change" }, 400);
  const dueOn = b.dueOn ? String(b.dueOn) : null;
  if (dueOn && !DATE_RE.test(dueOn)) return c.json({ error: "The due date looks like 2026-10-31" }, 400);
  if (dueOn && form.visit_type) return c.json({ error: "Visit forms are filled in during visits — no due date" }, 400);
  await admin.from("forms").update({ due_on: dueOn }).eq("id", form.id);
  await audit(c, "form.due_date_set", "form", form.id, { from: form.due_on ?? null, to: dueOn });
  return c.json({ form: await mapForm({ ...form, due_on: dueOn }) });
});

/* Permanently removes a form nobody has answered, with its blank file.
   A form with responses is archived instead (below) — responses are
   programme records, including ones filed during past school visits, and
   the database refuses to delete a form that still has any. */
app.delete("/forms/:id", requirePermission("forms.manage"), async (c) => {
  const id = c.req.param("id");
  const { data: form } = await admin.from("forms").select("files, county").eq("id", id).maybeSingle();
  if (!form || !formChangeable(c, form)) return c.json({ error: "Form not found" }, 404);
  const { count } = await admin.from("responses")
    .select("id", { count: "exact", head: true }).eq("form_id", id);
  if ((count ?? 0) > 0) {
    return c.json({ error: `This form has ${count} response(s). Archive it instead so they're kept.` }, 409);
  }
  const { error } = await admin.from("forms").delete().eq("id", id);
  if (error) return c.json({ error: error.message }, 400);
  const paths = ((form.files as LibFile[]) ?? []).map((f) => f.path);
  if (paths.length) await admin.storage.from(LIBRARY_BUCKET).remove(paths);
  return c.json({ ok: true });
});

/* Archive: the form stops reaching anyone and can't be answered, but it
   and all its responses and files stay, visible to the Education Team.
   Restore sends it out again. */
app.post("/forms/:id/archive", requirePermission("forms.manage"), async (c) => {
  const { data: f0 } = await admin.from("forms").select("county").eq("id", c.req.param("id")).maybeSingle();
  if (f0 && !formChangeable(c, f0)) return c.json({ error: "Form not found" }, 404);
  const { data, error } = await admin.from("forms")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", c.req.param("id")).select().maybeSingle();
  if (error) return c.json({ error: error.message }, 400);
  if (!data) return c.json({ error: "Form not found" }, 404);
  return c.json({ form: await mapForm(data) });
});

app.post("/forms/:id/restore", requirePermission("forms.manage"), async (c) => {
  const { data: f0 } = await admin.from("forms").select("county").eq("id", c.req.param("id")).maybeSingle();
  if (f0 && !formChangeable(c, f0)) return c.json({ error: "Form not found" }, 404);
  const { data, error } = await admin.from("forms")
    .update({ archived_at: null })
    .eq("id", c.req.param("id")).select().maybeSingle();
  if (error) return c.json({ error: error.message }, 400);
  if (!data) return c.json({ error: "Form not found" }, 404);
  return c.json({ form: await mapForm(data) });
});

/* A signed upload slot for a filled copy of a `file` form. The response
   that references it must come from the same person (see cleanResponseFiles). */
app.post("/forms/:id/response-upload", requirePermission("forms.respond"), async (c) => {
  const actor = c.get("actor");
  const { data: form } = await admin.from("forms").select("*").eq("id", c.req.param("id")).maybeSingle();
  if (!form || form.archived_at || form.kind !== "file" || !formReaches(form, actor)) {
    return c.json({ error: "Form not found" }, 404);
  }
  const b = await c.req.json().catch(() => ({}));
  const name = String(b.name ?? "").trim();
  if (!name) return c.json({ error: "Missing file name" }, 400);
  const path = `form-responses/${form.id}/${actor.id}/${rid("f")}/${safePath(name)}`;
  const { data, error } = await admin.storage.from(LIBRARY_BUCKET).createSignedUploadUrl(path);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ upload: { name, path, token: data.token, signedUrl: data.signedUrl, size: Number(b.size) || 0 } });
});

/** Checks a question form's answers against its own questions: every
    question answered, ratings a whole number 1–5, short answers non-empty
    text (capped), and nothing for questions the form doesn't have. */
const MAX_ANSWER_LENGTH = 2000;
function cleanAnswers(form: Record<string, unknown>, raw: unknown):
  { answers: { questionId: string; value: string }[] } | { error: string } {
  const questions = (form.questions as { id: string; prompt?: string; type?: string }[]) ?? [];
  const given = new Map<string, unknown>();
  for (const a of Array.isArray(raw) ? raw : []) {
    if (a && typeof a === "object" && typeof (a as { questionId?: unknown }).questionId === "string") {
      given.set((a as { questionId: string }).questionId, (a as { value?: unknown }).value);
    }
  }
  const answers: { questionId: string; value: string }[] = [];
  for (const q of questions) {
    const value = String(given.get(q.id) ?? "").trim();
    const title = String(form.title ?? "this form");
    if (q.type === "rating") {
      if (!/^[1-5]$/.test(value)) return { error: `Choose a rating from 1 to 5 for every question in "${title}".` };
    } else if (!value) {
      return { error: `Answer every question in "${title}".` };
    }
    answers.push({ questionId: q.id, value: value.slice(0, MAX_ANSWER_LENGTH) });
  }
  return { answers };
}

/** Only keeps filled-copy files this person actually uploaded for this form. */
function cleanResponseFiles(raw: unknown, formId: string, actorId: string): LibFile[] {
  const prefix = `form-responses/${formId}/${actorId}/`;
  return (Array.isArray(raw) ? raw : [])
    .filter((f) => typeof f?.path === "string" && f.path.startsWith(prefix) && !f.path.includes(".."))
    .map((f) => ({ name: String(f.name ?? "file"), path: f.path, size: Number(f.size) || 0 }));
}

app.get("/responses", requirePermission("forms.respond", "forms.manage", "forms.responses.view"), async (c) => {
  const p = c.get("actor");
  // Every response: the Education Team's averages are computed from this list.
  const { data, error } = await selectAll(() => {
    let q = admin
      .from("responses")
      .select("*")
      .order("submitted_at", { ascending: false })
      .order("id");
    // Everyone's responses only with forms.manage / forms.responses.view;
    // otherwise just the caller's own.
    if (!actorCan(c, "forms.manage") && !actorCan(c, "forms.responses.view")) q = q.eq("respondent_id", p.id);
    return q;
  });
  if (error) return c.json({ error: error.message }, 500);
  let rows = data ?? [];
  // Someone else's response: only from a respondent inside the caller's scope.
  if (!scopeOf(c).global) {
    const others = [...new Set(rows.filter((r) => r.respondent_id !== p.id).map((r) => r.respondent_id as string))];
    const people = others.length ? await selectIn("profiles", "id", others, "id, school_id, county") : [];
    const where = new Map(people.map((x) => [x.id, x]));
    rows = rows.filter((r) => r.respondent_id === p.id || inScope(c, where.get(r.respondent_id)?.school_id, where.get(r.respondent_id)?.county));
  }
  const responses = await Promise.all(rows.map((r) => mapResponse(r, actorCan(c, "forms.manage"))));
  return c.json({ responses });
});

/* A general (not visit-linked) response: one per person per form,
   re-submitting replaces it. Visit-type forms are answered through
   POST /field-reports instead, once per visit. */
app.post("/responses", requirePermission("forms.respond"), async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const p = c.get("actor");
  const { data: form } = await admin.from("forms").select("*").eq("id", String(b.formId ?? "")).maybeSingle();
  if (!form || form.archived_at || !formReaches(form, p)) return c.json({ error: "Form not found" }, 404);
  // A visit's form can be finished after the visit, by the officer who made it.
  let visit: Record<string, any> | null = null;
  if (form.visit_type) {
    if (!b.visitId) return c.json({ error: "This form is filled in during a school visit" }, 400);
    const { data: v } = await admin.from("field_reports").select("*").eq("id", String(b.visitId)).maybeSingle();
    if (!v || v.officer_id !== p.id) return c.json({ error: "Visit not found" }, 404);
    if (v.visit_type !== form.visit_type || (form.county && form.county !== v.county)) return c.json({ error: "That form isn't for this visit" }, 400);
    visit = v;
  }
  let answers: { questionId: string; value: string }[] = [];
  if (form.kind === "questions") {
    const checked = cleanAnswers(form, b.answers);
    if ("error" in checked) return c.json({ error: checked.error }, 400);
    answers = checked.answers;
  }
  const row = {
    respondent_name: p.fullName,
    respondent_role: p.role,
    answers,
    files: form.kind === "file" ? cleanResponseFiles(b.files, form.id, p.id) : [],
    submitted_at: new Date().toISOString(),
  };
  const existingQ = admin.from("responses").select("id").eq("form_id", form.id).eq("respondent_id", p.id);
  const { data: existing } = visit ? await existingQ.eq("visit_id", visit.id).maybeSingle() : await existingQ.is("visit_id", null).maybeSingle();
  const { data, error } = existing
    ? await admin.from("responses").update(row).eq("id", existing.id).select().single()
    : await admin.from("responses")
      .insert({ id: rid("resp"), form_id: form.id, respondent_id: p.id, ...(visit ? { visit_id: visit.id } : {}), ...row }).select().single();
  if (!error && visit) await audit(c, "visit.form_completed", "field_report", visit.id, { formId: form.id });
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ response: await mapResponse(data) });
});

// ---------------------------------------------------------------- assignments, submissions, results
// A teacher builds an assignment for a class they teach (subject, term,
// questions, dates), publishes it, and every learner enrolled in that class
// can open it, save progress and hand it in. Auto-marked questions are
// marked on submission; anything else waits for the teacher. The rules
// themselves (question checks, marking, bands, results maths) are in lms.ts.
//
// Two measures, never mixed: COMPLETION (handed in, on time or late) and
// ACHIEVEMENT (marks on marked work).

const DEFAULT_BANDS: Band[] = [
  { code: "EE", label: "Exceeding Expectations", minPercent: 80 },
  { code: "ME", label: "Meeting Expectations", minPercent: 50 },
  { code: "AE", label: "Approaching Expectations", minPercent: 30 },
  { code: "BE", label: "Below Expectations", minPercent: 0 },
];
async function loadBands(): Promise<Band[]> {
  const { data } = await admin.from("grade_bands").select("*").order("sort_order");
  return data?.length
    ? data.map((b: Record<string, unknown>) => ({ code: b.code as string, label: b.label as string, minPercent: Number(b.min_percent) }))
    : DEFAULT_BANDS;
}

/** Rows whose `col` is one of `ids`, fetched in chunks so a long id list
    never overflows the request URL. */
async function selectIn(table: string, col: string, ids: string[], cols = "*"): Promise<Record<string, any>[]> {
  const out: Record<string, any>[] = [];
  for (let i = 0; i < ids.length; i += 150) {
    const chunk = ids.slice(i, i + 150);
    const { data, error } = await selectAll(() => admin.from(table).select(cols).in(col, chunk).order("id"));
    if (error) throw new Error(error.message);
    out.push(...data);
  }
  return out;
}

type AssignmentScope =
  | { kind: "all"; within: PlaceScope }
  | { kind: "school"; schoolId: string }
  | { kind: "teacher"; teacherId: string; schoolId: string; classIds: string[] }
  | { kind: "none" };

/** Which assignments (and results) the caller may see: every school, their
    own school (school head), or the classes they teach (teacher). */
// deno-lint-ignore no-explicit-any
async function assignmentScope(c: any): Promise<AssignmentScope> {
  const a = c.get("actor") as Actor;
  if (actorCan(c, "assignments.view.all")) return { kind: "all", within: a.scope };
  if (actorCan(c, "assignments.view.school")) return a.schoolId ? { kind: "school", schoolId: a.schoolId } : { kind: "none" };
  if (actorCan(c, "assignments.manage") || actorCan(c, "assignments.grade")) {
    return a.schoolId ? { kind: "teacher", teacherId: a.id, schoolId: a.schoolId, classIds: await classesTaughtBy(a.id) } : { kind: "none" };
  }
  return { kind: "none" };
}
function inAssignmentScope(s: AssignmentScope, row: Record<string, unknown>): boolean {
  if (s.kind === "all") return inPlaceScope(s.within, row.school_id);
  if (s.kind === "none") return false;
  if (row.school_id !== s.schoolId) return false; // never another school's work
  return s.kind === "school" || s.classIds.includes(row.class_id as string);
}
/** A teacher may change (and mark) only assignments for classes they teach. */
const teachesAssignment = (s: AssignmentScope, row: Record<string, unknown>) =>
  s.kind === "teacher" && inAssignmentScope(s, row);

/** Loads :id within the caller's scope — outside it, "not found". */
// deno-lint-ignore no-explicit-any
async function loadScopedAssignment(c: any, id: string, manage: boolean): Promise<{ a: Record<string, any>; scope: AssignmentScope } | Response> {
  const scope = await assignmentScope(c);
  const { data: a } = await admin.from("assignments").select("*").eq("id", id).maybeSingle();
  if (!a || !inAssignmentScope(scope, a)) return c.json({ error: "Assignment not found" }, 404);
  if (manage && !teachesAssignment(scope, a)) return c.json({ error: "Only a teacher of this class can change it" }, 403);
  return { a, scope };
}

const termLabel = (termId: unknown) => {
  const m = /^(\d{4})-T(\d)$/.exec(String(termId ?? ""));
  return m ? `${m[1]} Term ${m[2]}` : termId ? String(termId) : null;
};

/** Class, subject, resource and teacher names for assignment rows. */
async function assignmentNames(rows: Record<string, unknown>[]) {
  const ids = (k: string) => [...new Set(rows.map((r) => r[k]).filter(Boolean))] as string[];
  const [cls, subj, lib, prof] = await Promise.all([
    ids("class_id").length ? admin.from("classes").select("id, name").in("id", ids("class_id")) : { data: [] },
    ids("subject_id").length ? admin.from("subjects").select("id, name").in("id", ids("subject_id")) : { data: [] },
    ids("resource_id").length ? admin.from("library_items").select("id, title").in("id", ids("resource_id")) : { data: [] },
    ids("created_by").length ? admin.from("profiles").select("id, full_name").in("id", ids("created_by")) : { data: [] },
  ]);
  const m = (d: Record<string, unknown>[] | null, f: string) => Object.fromEntries((d ?? []).map((x) => [x.id, x[f]])) as Record<string, string>;
  return { classes: m(cls.data, "name"), subjects: m(subj.data, "name"), resources: m(lib.data, "title"), teachers: m(prof.data, "full_name") };
}

const mapAssignmentRow = (r: Record<string, any>, n: Awaited<ReturnType<typeof assignmentNames>>) => ({
  id: r.id,
  schoolId: r.school_id,
  classId: r.class_id,
  className: n.classes[r.class_id] ?? null,
  subjectId: r.subject_id,
  subject: n.subjects[r.subject_id] ?? r.subject_id,
  grade: r.grade,
  academicYear: r.academic_year_id,
  termId: r.term_id ?? null,
  term: termLabel(r.term_id),
  title: r.title,
  description: r.description ?? "",
  instructions: r.instructions ?? "",
  resourceId: r.resource_id ?? null,
  resourceTitle: r.resource_id ? n.resources[r.resource_id] ?? null : null,
  startsAt: r.starts_at ?? null,
  dueAt: r.due_at ?? null,
  estimatedMinutes: r.estimated_minutes ?? null,
  status: r.status,
  maxMarks: Number(r.max_marks ?? 0),
  createdBy: r.created_by,
  teacherName: n.teachers[r.created_by] ?? null,
  createdAt: r.created_at,
  updatedAt: r.updated_at ?? null,
  publishedAt: r.published_at ?? null,
  closedAt: r.closed_at ?? null,
});

const mapQuestion = (q: Record<string, any>, withKey: boolean) => ({
  id: q.id,
  position: q.position,
  type: q.type,
  prompt: q.prompt,
  options: q.options ?? [],
  maxMarks: Number(q.max_marks),
  autoMarked: isAutoMarked({ type: q.type, answerKey: q.answer_key }),
  ...(withKey ? { answerKey: q.answer_key ?? null } : {}),
});
const toQuestion = (q: Record<string, any>): Question => ({
  id: q.id, type: q.type, prompt: q.prompt, options: q.options ?? [], answerKey: q.answer_key ?? null, maxMarks: Number(q.max_marks),
});

/** A submission; the marks only when `showMarks` (staff, or the learner
    once it's marked). */
const mapSubmission = (s: Record<string, any>, showMarks = true) => ({
  id: s.id,
  assignmentId: s.assignment_id,
  learnerId: s.learner_id,
  classId: s.class_id,
  status: s.status,
  startedAt: s.started_at ?? null,
  lastSavedAt: s.last_saved_at ?? null,
  submittedAt: s.submitted_at ?? null,
  offlineSubmittedAt: s.offline_submitted_at ?? null,
  isLate: !!s.is_late,
  ...(showMarks ? {
    marks: s.marks == null ? null : Number(s.marks),
    maxMarks: s.max_marks == null ? null : Number(s.max_marks),
    percentage: s.percentage == null ? null : Number(s.percentage),
    band: s.band ?? null,
    feedback: s.feedback ?? null,
    markedAt: s.marked_at ?? null,
    markedBy: s.marked_by ?? null,
    autoMarked: !!s.auto_marked,
  } : {}),
});

async function questionsOf(assignmentId: string) {
  const { data } = await admin.from("assignment_questions").select("*").eq("assignment_id", assignmentId).order("position");
  return (data ?? []).sort((x: Record<string, any>, y: Record<string, any>) => x.position - y.position);
}

/** Learners expected to do each assignment: everyone enrolled in its class
    for some part of the time it was open (from its start — or publication —
    to its due date). Taken from the enrollment history, so a learner who
    has since moved on still counts for work set while they were there. */
async function expectedLearners(assignments: Record<string, any>[]): Promise<Map<string, Set<string>>> {
  const classIds = [...new Set(assignments.map((a) => a.class_id))] as string[];
  const enr = classIds.length ? await selectIn("learner_enrollments", "class_id", classIds) : [];
  return expectedFrom(assignments, enr);
}

const toResultAssignment = (a: Record<string, any>): ResultAssignment => ({
  id: a.id, schoolId: a.school_id, classId: a.class_id, subjectId: a.subject_id, grade: a.grade,
  termId: a.term_id ?? null, yearId: a.academic_year_id, dueAt: a.due_at ?? null, status: a.status,
});
const toResultSubmission = (s: Record<string, any>): ResultSubmission => ({
  assignmentId: s.assignment_id, learnerId: s.learner_id, status: s.status, isLate: !!s.is_late,
  percentage: s.percentage == null ? null : Number(s.percentage),
});

/** Published and closed work (never drafts), its submissions and the
    expected learner × assignment pairs — for one school, some classes, or
    one learner (every class they've been enrolled in). */
async function loadWork(filter: { schoolId?: string | null; classIds?: string[] | null; learnerId?: string | null }) {
  let assignments: Record<string, any>[];
  if (filter.learnerId) {
    const [enr, subs] = await Promise.all([
      selectAll(() => admin.from("learner_enrollments").select("*").eq("learner_id", filter.learnerId).order("id")),
      selectAll(() => admin.from("assignment_submissions").select("*").eq("learner_id", filter.learnerId).order("id")),
    ]);
    if (enr.error || subs.error) throw new Error((enr.error ?? subs.error)!.message);
    const classIds = [...new Set(enr.data.map((e) => e.class_id).filter(Boolean))] as string[];
    const byClass = classIds.length ? await selectIn("assignments", "class_id", classIds) : [];
    const known = new Set(byClass.map((a) => a.id));
    const others = [...new Set(subs.data.map((s) => s.assignment_id as string))].filter((id) => !known.has(id));
    assignments = [...byClass, ...(others.length ? await selectIn("assignments", "id", others) : [])];
  } else {
    const r = await selectAll(() => {
      let q = admin.from("assignments").select("*").order("id");
      if (filter.schoolId) q = q.eq("school_id", filter.schoolId);
      return q;
    });
    if (r.error) throw new Error(r.error.message);
    assignments = r.data;
  }
  assignments = assignments.filter((a) => a.status !== "draft" && (!filter.classIds || filter.classIds.includes(a.class_id)));
  const ids = assignments.map((a) => a.id as string);
  const submissions = ids.length ? await selectIn("assignment_submissions", "assignment_id", ids) : [];
  const expected = await expectedLearners(assignments);
  let pairs = pairsOf(assignments.map(toResultAssignment), expected, submissions.map(toResultSubmission));
  if (filter.learnerId) pairs = pairs.filter((p) => p.learnerId === filter.learnerId);
  return { assignments, submissions, pairs };
}

/** Per-assignment counts for a teacher's list: who was expected, who has
    started, handed in, is waiting to be marked, has been marked. */
async function assignmentCounts(rows: Record<string, any>[]) {
  const live = rows.filter((a) => a.status !== "draft");
  const ids = live.map((a) => a.id as string);
  const subs = ids.length ? await selectIn("assignment_submissions", "assignment_id", ids) : [];
  const expected = await expectedLearners(live);
  const out = new Map<string, Record<string, number>>();
  for (const a of rows) {
    const mine = subs.filter((s) => s.assignment_id === a.id);
    const who = new Set([...(expected.get(a.id) ?? []), ...mine.map((s) => s.learner_id)]);
    out.set(a.id, {
      expected: a.status === "draft" ? 0 : who.size,
      started: mine.length,
      submitted: mine.filter((s) => s.status !== "in_progress").length,
      toMark: mine.filter((s) => s.status === "submitted").length,
      marked: mine.filter((s) => s.status === "marked").length,
      late: mine.filter((s) => s.is_late).length,
    });
  }
  return out;
}

const parseWhen = (v: unknown): string | null | undefined => {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};

/** Validates the editable fields of an assignment (create or update). */
// deno-lint-ignore no-explicit-any
async function readAssignmentFields(b: Record<string, any>, cls: Record<string, any>, existing: Record<string, any> | null):
  Promise<{ row: Record<string, unknown> } | { error: string }> {
  const row: Record<string, unknown> = {};
  const isNew = !existing;
  if (isNew || b.title !== undefined) {
    const title = String(b.title ?? "").trim().replace(/\s+/g, " ");
    if (!title) return { error: "Give the assignment a title" };
    if (title.length > 200) return { error: "The title is too long (200 characters at most)" };
    row.title = title;
  }
  for (const [k, col, max] of [["description", "description", 5000], ["instructions", "instructions", 10000]] as const) {
    if (b[k] !== undefined) {
      const v = String(b[k] ?? "").trim();
      if (v.length > max) return { error: `The ${k} is too long` };
      row[col] = v;
    }
  }
  if (isNew || b.subjectId !== undefined) {
    const { data: subject } = await admin.from("subjects").select("*").eq("id", String(b.subjectId ?? "")).maybeSingle();
    if (!subject || subject.archived_at) return { error: "Choose a subject" };
    const { data: taught } = await admin.from("class_subjects").select("subject_id").eq("class_id", cls.id).is("removed_at", null);
    if ((taught ?? []).length && !(taught ?? []).some((t: Record<string, unknown>) => t.subject_id === subject.id)) {
      return { error: `${cls.name} doesn't take ${subject.name} — ask your school head to add it to the class` };
    }
    row.subject_id = subject.id;
  }
  if (b.resourceId !== undefined) {
    if (!b.resourceId) row.resource_id = null;
    else {
      const { data: item } = await admin.from("library_items").select("id, audience, published").eq("id", String(b.resourceId)).maybeSingle();
      if (!item || !item.published || !canSeeLibrary(item.audience, "learner")) return { error: "Attach a published Digital Library resource — learners can't open Teacher Resources" };
      row.resource_id = item.id;
    }
  }
  const startsAt = parseWhen(b.startsAt);
  const dueAt = parseWhen(b.dueAt);
  if (startsAt === undefined && b.startsAt !== undefined) return { error: "The start date isn't a valid date" };
  if (dueAt === undefined && b.dueAt !== undefined) return { error: "The due date isn't a valid date" };
  if (startsAt !== undefined) row.starts_at = startsAt;
  if (dueAt !== undefined) row.due_at = dueAt;
  const s = (row.starts_at !== undefined ? row.starts_at : existing?.starts_at) as string | null;
  const d = (row.due_at !== undefined ? row.due_at : existing?.due_at) as string | null;
  if (s && d && new Date(d) <= new Date(s)) return { error: "The due date must be after the start date" };
  if (b.estimatedMinutes !== undefined) {
    if (b.estimatedMinutes === null || b.estimatedMinutes === "") row.estimated_minutes = null;
    else {
      const m = Number(b.estimatedMinutes);
      if (!Number.isInteger(m) || m < 1 || m > 1440) return { error: "Estimated time: whole minutes, 1 to 1440" };
      row.estimated_minutes = m;
    }
  }
  // The term: chosen, or the term of the class's year the work starts in.
  if (isNew || b.termId !== undefined || row.starts_at !== undefined) {
    const { data: terms } = await admin.from("terms").select("*").eq("academic_year_id", cls.academic_year_id);
    if (b.termId) {
      const t = (terms ?? []).find((x: Record<string, unknown>) => x.id === b.termId);
      if (!t) return { error: `Choose a term of the ${cls.academic_year_id} school year` };
      row.term_id = t.id;
    } else if (isNew || b.termId !== undefined) {
      const day = String(s ?? new Date().toISOString()).slice(0, 10);
      const t = (terms ?? []).find((x: Record<string, unknown>) => String(x.starts_on) <= day && day <= String(x.ends_on));
      row.term_id = t?.id ?? null;
    }
  }
  return { row };
}

/** Replaces a draft's questions and its total marks. */
async function saveQuestions(assignmentId: string, questions: Omit<Question, "id">[]) {
  await admin.from("assignment_questions").delete().eq("assignment_id", assignmentId);
  if (questions.length) {
    const { error } = await admin.from("assignment_questions").insert(questions.map((q, i) => ({
      id: rid("q"), assignment_id: assignmentId, position: i + 1, type: q.type, prompt: q.prompt,
      options: q.options, answer_key: q.answerKey, max_marks: q.maxMarks,
    })));
    if (error) throw new Error(error.message);
  }
  const max = round2(questions.reduce((t, q) => t + q.maxMarks, 0));
  await admin.from("assignments").update({ max_marks: max }).eq("id", assignmentId);
}

/** Full detail for staff: questions with their answer keys, and the class
    roster with each learner's submission. */
async function assignmentDetail(a: Record<string, any>) {
  const [names, questions, counts] = await Promise.all([assignmentNames([a]), questionsOf(a.id), assignmentCounts([a])]);
  const { data: subs } = await admin.from("assignment_submissions").select("*").eq("assignment_id", a.id);
  const expected = a.status === "draft" ? new Set<string>() : (await expectedLearners([a])).get(a.id) ?? new Set<string>();
  const learnerIds = [...new Set([...expected, ...(subs ?? []).map((s: Record<string, unknown>) => s.learner_id as string)])];
  const learners = learnerIds.length ? await selectIn("learners", "id", learnerIds) : [];
  const roster = learners.map((l) => {
    const s = (subs ?? []).find((x: Record<string, unknown>) => x.learner_id === l.id);
    return {
      learnerId: l.id, fullName: l.full_name, learnerCode: l.learner_code ?? l.user_code ?? null,
      enrollmentStatus: l.enrollment_status ?? ACTIVE, submission: s ? mapSubmission(s) : null,
    };
  }).sort((x, y) => String(x.fullName).localeCompare(String(y.fullName)));
  return {
    assignment: { ...mapAssignmentRow(a, names), counts: counts.get(a.id) },
    questions: questions.map((q) => mapQuestion(q, true)),
    roster,
  };
}

// ---- subjects ----

app.get("/subjects", requireStaff(), async (c) => {
  const { data, error } = await admin.from("subjects").select("*").is("archived_at", null).order("sort_order").order("name");
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ subjects: (data ?? []).map((s) => ({ id: s.id, name: s.name })) });
});

app.post("/subjects", requirePermission("subjects.manage"), async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const name = String(b.name ?? "").trim().replace(/\s+/g, " ");
  if (!name || name.length > 80) return c.json({ error: "Give the subject a name (80 characters at most)" }, 400);
  const id = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || rid("subj");
  const { data, error } = await admin.from("subjects").insert({ id, name, sort_order: 100 }).select().single();
  if (error) return c.json({ error: isUniqueViolation(error) ? `${name} is already a subject` : error.message }, 400);
  await audit(c, "subject.created", "subject", data.id, { name });
  return c.json({ subject: { id: data.id, name: data.name } });
});

// ---- assignments (staff) ----

/* ?classId= &subjectId= &status=draft|published|closed &termId= */
app.get("/assignments", requirePermission("assignments.manage", "assignments.view.school", "assignments.view.all"), async (c) => {
  const scope = await assignmentScope(c);
  if (scope.kind === "none") return c.json({ assignments: [] });
  const f = (k: string) => String(c.req.query(k) ?? "");
  const schoolId = scope.kind === "all" ? f("schoolId") : scope.schoolId;
  const { data, error } = await selectAll(() => {
    let q = admin.from("assignments").select("*").order("id");
    if (schoolId) q = q.eq("school_id", schoolId);
    if (f("classId")) q = q.eq("class_id", f("classId"));
    if (f("subjectId")) q = q.eq("subject_id", f("subjectId"));
    if (f("status")) q = q.eq("status", f("status"));
    if (f("termId")) q = q.eq("term_id", f("termId"));
    return q;
  });
  if (error) return c.json({ error: error.message }, 500);
  const rows = data.filter((a) => inAssignmentScope(scope, a))
    .sort((x, y) => String(y.due_at ?? y.created_at).localeCompare(String(x.due_at ?? x.created_at)));
  const [names, counts] = await Promise.all([assignmentNames(rows), assignmentCounts(rows)]);
  return c.json({ assignments: rows.map((a) => ({ ...mapAssignmentRow(a, names), counts: counts.get(a.id) })) });
});

app.post("/assignments", requirePermission("assignments.manage"), async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const scope = await assignmentScope(c);
  const cls = await loadClass(b.classId);
  if (!cls || cls.archived_at || scope.kind !== "teacher" || cls.school_id !== scope.schoolId || !scope.classIds.includes(cls.id)) {
    return c.json({ error: "Choose a class you teach" }, 400);
  }
  const fields = await readAssignmentFields(b, cls, null);
  if ("error" in fields) return c.json({ error: fields.error }, 400);
  const qs = cleanQuestions(b.questions ?? []);
  if ("error" in qs) return c.json({ error: qs.error }, 400);
  const id = rid("asg");
  const { data, error } = await admin.from("assignments").insert({
    id, school_id: cls.school_id, class_id: cls.id, grade: cls.grade, academic_year_id: cls.academic_year_id,
    status: "draft", created_by: c.get("actor").id, ...fields.row,
  }).select().single();
  if (error) return c.json({ error: error.message }, 400);
  try { await saveQuestions(id, qs.questions); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  await audit(c, "assignment.created", "assignment", id, { classId: cls.id, subjectId: data.subject_id, questions: qs.questions.length });
  const { data: fresh } = await admin.from("assignments").select("*").eq("id", id).single();
  return c.json(await assignmentDetail(fresh));
});

app.get("/assignments/:id", requirePermission("assignments.manage", "assignments.view.school", "assignments.view.all"), async (c) => {
  const found = await loadScopedAssignment(c, c.req.param("id"), false);
  if (found instanceof Response) return found;
  return c.json(await assignmentDetail(found.a));
});

/* Edit. Questions (and the class) can only change while it's a draft —
   once learners have it, the marks they're working towards stay fixed. */
app.patch("/assignments/:id", requirePermission("assignments.manage"), async (c) => {
  const found = await loadScopedAssignment(c, c.req.param("id"), true);
  if (found instanceof Response) return found;
  const { a, scope } = found;
  const b = await c.req.json().catch(() => ({}));
  let cls = await loadClass(a.class_id);
  const patch: Record<string, unknown> = {};
  if (b.classId !== undefined && b.classId !== a.class_id) {
    if (a.status !== "draft") return c.json({ error: "The class can only change while the assignment is a draft" }, 409);
    const next = await loadClass(b.classId);
    if (!next || next.archived_at || scope.kind !== "teacher" || !scope.classIds.includes(next.id)) return c.json({ error: "Choose a class you teach" }, 400);
    cls = next;
    Object.assign(patch, { class_id: next.id, grade: next.grade, academic_year_id: next.academic_year_id, school_id: next.school_id });
    if (b.termId === undefined) b.termId = "";
  }
  const fields = await readAssignmentFields(b, cls!, a);
  if ("error" in fields) return c.json({ error: fields.error }, 400);
  Object.assign(patch, fields.row);
  let questions: Omit<Question, "id">[] | null = null;
  if (b.questions !== undefined) {
    if (a.status !== "draft") return c.json({ error: "Questions can only change while the assignment is a draft" }, 409);
    const qs = cleanQuestions(b.questions);
    if ("error" in qs) return c.json({ error: qs.error }, 400);
    questions = qs.questions;
  }
  if (!Object.keys(patch).length && !questions) return c.json({ error: "Nothing to update" }, 400);
  patch.updated_at = new Date().toISOString();
  const { error } = await admin.from("assignments").update(patch).eq("id", a.id);
  if (error) return c.json({ error: error.message }, 400);
  if (questions) {
    try { await saveQuestions(a.id, questions); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  }
  await audit(c, "assignment.updated", "assignment", a.id, { fields: Object.keys(patch).filter((k) => k !== "updated_at"), questions: questions?.length ?? undefined });
  const { data: fresh } = await admin.from("assignments").select("*").eq("id", a.id).single();
  return c.json(await assignmentDetail(fresh));
});

/* draft → published (needs questions and a due date) → closed → published
   again; back to draft only if nobody has started it. */
app.post("/assignments/:id/status", requirePermission("assignments.manage"), async (c) => {
  const found = await loadScopedAssignment(c, c.req.param("id"), true);
  if (found instanceof Response) return found;
  const { a } = found;
  const b = await c.req.json().catch(() => ({}));
  const to = String(b.status ?? "") as AssignmentStatus;
  if (!ASSIGNMENT_STATUSES.includes(to)) return c.json({ error: "Status must be draft, published or closed" }, 400);
  if (to === a.status) return c.json(await assignmentDetail(a));
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { status: to, updated_at: now };
  if (to === "published") {
    const qs = await questionsOf(a.id);
    if (!qs.length) return c.json({ error: "Add at least one question before publishing" }, 409);
    if (!a.due_at) return c.json({ error: "Set a due date before publishing" }, 409);
    const cls = await loadClass(a.class_id);
    if (!cls || cls.archived_at) return c.json({ error: "This class has been archived" }, 409);
    if (!a.published_at) patch.published_at = now;
    patch.closed_at = null;
  } else if (to === "closed") {
    if (a.status !== "published") return c.json({ error: "Only a published assignment can be closed" }, 409);
    patch.closed_at = now;
  } else {
    const { count } = await admin.from("assignment_submissions").select("id", { count: "exact", head: true }).eq("assignment_id", a.id);
    if ((count ?? 0) > 0) return c.json({ error: "Learners have already started this — close it instead" }, 409);
    patch.published_at = null;
    patch.closed_at = null;
  }
  const { error } = await admin.from("assignments").update(patch).eq("id", a.id);
  if (error) return c.json({ error: error.message }, 400);
  await audit(c, `assignment.${to === "draft" ? "unpublished" : to}`, "assignment", a.id, { from: a.status, to });
  return c.json(await assignmentDetail({ ...a, ...patch }));
});

/* Only an unpublished draft nobody has seen can be deleted; anything else
   is closed instead, so learners' work is never lost. */
app.delete("/assignments/:id", requirePermission("assignments.manage"), async (c) => {
  const found = await loadScopedAssignment(c, c.req.param("id"), true);
  if (found instanceof Response) return found;
  const { a } = found;
  if (a.status !== "draft") return c.json({ error: "Only a draft can be deleted — close a published assignment instead" }, 409);
  const { count } = await admin.from("assignment_submissions").select("id", { count: "exact", head: true }).eq("assignment_id", a.id);
  if ((count ?? 0) > 0) return c.json({ error: "Learners have work on this assignment — close it instead" }, 409);
  await admin.from("assignment_questions").delete().eq("assignment_id", a.id);
  const { error } = await admin.from("assignments").delete().eq("id", a.id);
  if (error) return c.json({ error: error.message }, 400);
  await audit(c, "assignment.deleted", "assignment", a.id, { title: a.title });
  return c.json({ ok: true });
});

// ---- submissions (staff) ----

/* ?status=submitted (the marking queue) | marked | in_progress, ?classId=, ?assignmentId= */
app.get("/submissions", requirePermission("assignments.manage", "assignments.view.school", "assignments.view.all"), async (c) => {
  const scope = await assignmentScope(c);
  if (scope.kind === "none") return c.json({ submissions: [] });
  const f = (k: string) => String(c.req.query(k) ?? "");
  const { data, error } = await selectAll(() => {
    let q = admin.from("assignment_submissions").select("*").order("id");
    if (scope.kind !== "all") q = q.eq("school_id", scope.schoolId);
    else if (f("schoolId")) q = q.eq("school_id", f("schoolId"));
    if (f("status")) q = q.eq("status", f("status"));
    if (f("classId")) q = q.eq("class_id", f("classId"));
    if (f("assignmentId")) q = q.eq("assignment_id", f("assignmentId"));
    return q;
  });
  if (error) return c.json({ error: error.message }, 500);
  const asgIds = [...new Set(data.map((s) => s.assignment_id as string))];
  const asgs = asgIds.length ? await selectIn("assignments", "id", asgIds) : [];
  const byId = new Map(asgs.map((a) => [a.id, a]));
  // Scope by the assignment's class (a teacher sees the classes they teach).
  const rows = data.filter((s) => byId.has(s.assignment_id) && inAssignmentScope(scope, byId.get(s.assignment_id)!))
    .sort((x, y) => String(y.marked_at ?? y.submitted_at ?? y.started_at).localeCompare(String(x.marked_at ?? x.submitted_at ?? x.started_at)))
    .slice(0, Math.max(1, Math.min(500, Number(c.req.query("limit")) || 200)));
  const names = await assignmentNames(rows.map((s) => byId.get(s.assignment_id)!));
  const learners = rows.length ? await selectIn("learners", "id", [...new Set(rows.map((s) => s.learner_id as string))], "id, full_name, learner_code, user_code") : [];
  const lName = new Map(learners.map((l) => [l.id, l]));
  return c.json({
    submissions: rows.map((s) => {
      const a = byId.get(s.assignment_id)!;
      return {
        ...mapSubmission(s),
        learnerName: lName.get(s.learner_id)?.full_name ?? null,
        learnerCode: lName.get(s.learner_id)?.learner_code ?? lName.get(s.learner_id)?.user_code ?? null,
        assignmentTitle: a.title, subject: names.subjects[a.subject_id] ?? a.subject_id,
        className: names.classes[a.class_id] ?? null, dueAt: a.due_at ?? null,
      };
    }),
  });
});

async function submissionDetail(s: Record<string, any>, a: Record<string, any>) {
  const [questions, { data: answers }, { data: learner }, names] = await Promise.all([
    questionsOf(a.id),
    admin.from("submission_answers").select("*").eq("submission_id", s.id),
    admin.from("learners").select("id, full_name, learner_code, user_code").eq("id", s.learner_id).maybeSingle(),
    assignmentNames([a]),
  ]);
  const { data: marker } = s.marked_by ? await admin.from("profiles").select("full_name").eq("id", s.marked_by).maybeSingle() : { data: null };
  return {
    submission: { ...mapSubmission(s), markerName: marker?.full_name ?? (s.auto_marked ? "Marked automatically" : null) },
    learner: learner ? { id: learner.id, fullName: learner.full_name, learnerCode: learner.learner_code ?? learner.user_code ?? null } : null,
    assignment: mapAssignmentRow(a, names),
    questions: questions.map((q) => mapQuestion(q, true)),
    answers: await Promise.all((answers ?? []).map(async (x: Record<string, any>) => ({
      questionId: x.question_id,
      response: x.response ?? null,
      files: await signFiles((x.files ?? []) as LibFile[], true),
      autoMarks: x.auto_marks == null ? null : Number(x.auto_marks),
      marks: x.marks == null ? null : Number(x.marks),
      feedback: x.feedback ?? null,
    }))),
  };
}

app.get("/submissions/:id", requirePermission("assignments.manage", "assignments.view.school", "assignments.view.all"), async (c) => {
  const { data: s } = await admin.from("assignment_submissions").select("*").eq("id", c.req.param("id")).maybeSingle();
  if (!s) return c.json({ error: "Submission not found" }, 404);
  const found = await loadScopedAssignment(c, s.assignment_id, false);
  if (found instanceof Response) return c.json({ error: "Submission not found" }, 404);
  return c.json(await submissionDetail(s, found.a));
});

/* Marking. Every question needs a mark — the teacher's, or the automatic
   one where there is one. The teacher can override any automatic mark. */
app.post("/submissions/:id/mark", requirePermission("assignments.grade"), async (c) => {
  const { data: s } = await admin.from("assignment_submissions").select("*").eq("id", c.req.param("id")).maybeSingle();
  if (!s) return c.json({ error: "Submission not found" }, 404);
  const scope = await assignmentScope(c);
  const { data: a } = await admin.from("assignments").select("*").eq("id", s.assignment_id).maybeSingle();
  if (!a || !inAssignmentScope(scope, a)) return c.json({ error: "Submission not found" }, 404);
  if (!teachesAssignment(scope, a)) return c.json({ error: "Only a teacher of this class can mark it" }, 403);
  if (s.status === "in_progress") return c.json({ error: "This hasn't been handed in yet" }, 409);
  const b = await c.req.json().catch(() => ({}));
  // Marks given offline: if it was marked (or re-marked) since this device
  // last saw it, the teacher chooses which marks stand.
  if (b.force !== true && "baseMarkedAt" in b && changedSince(s.marked_at, b.baseMarkedAt)) {
    return c.json({
      error: "Someone marked this while you were offline.",
      conflict: { kind: "marked_elsewhere", server: await submissionDetail(s, a) },
    }, 409);
  }
  const given = new Map<string, { marks?: unknown; feedback?: unknown }>();
  for (const x of Array.isArray(b.answers) ? b.answers : []) if (x && typeof x.questionId === "string") given.set(x.questionId, x);
  const questions = await questionsOf(a.id);
  const { data: answers } = await admin.from("submission_answers").select("*").eq("submission_id", s.id);
  const now = new Date().toISOString();
  let total = 0, max = 0;
  const writes: { id: string | null; questionId: string; marks: number; feedback: string | null }[] = [];
  for (const q of questions) {
    const ans = (answers ?? []).find((x: Record<string, unknown>) => x.question_id === q.id);
    const g = given.get(q.id);
    const qMax = Number(q.max_marks);
    let m: number | null = null;
    if (g?.marks !== undefined && g.marks !== null && g.marks !== "") {
      const v = Number(g.marks);
      if (!Number.isFinite(v) || v < 0 || v > qMax) return c.json({ error: `Question ${q.position}: marks must be between 0 and ${qMax}` }, 400);
      m = round2(v);
    } else if (ans?.marks != null) m = Number(ans.marks);
    else if (ans?.auto_marks != null) m = Number(ans.auto_marks);
    else if (!ans && isAutoMarked({ type: q.type, answerKey: q.answer_key })) m = 0; // left blank
    if (m == null) return c.json({ error: `Question ${q.position} still needs a mark` }, 400);
    const fb = g?.feedback !== undefined ? (String(g.feedback ?? "").trim().slice(0, 2000) || null) : (ans?.feedback ?? null);
    writes.push({ id: ans?.id ?? null, questionId: q.id, marks: m, feedback: fb });
    total += m;
    max += qMax;
  }
  for (const w of writes) {
    if (w.id) await admin.from("submission_answers").update({ marks: w.marks, feedback: w.feedback, updated_at: now }).eq("id", w.id);
    else await admin.from("submission_answers").insert({ id: rid("ans"), submission_id: s.id, question_id: w.questionId, response: null, marks: w.marks, feedback: w.feedback });
  }
  const pct = percentOf(total, max);
  const patch = {
    status: "marked", marks: round2(total), max_marks: round2(max), percentage: pct, band: bandFor(pct, await loadBands()),
    feedback: b.feedback !== undefined ? (String(b.feedback ?? "").trim().slice(0, 5000) || null) : (s.feedback ?? null),
    marked_at: now, marked_by: c.get("actor").id, auto_marked: false,
  };
  const { error } = await admin.from("assignment_submissions").update(patch).eq("id", s.id);
  if (error) return c.json({ error: error.message }, 400);
  await audit(c, s.status === "marked" ? "submission.remarked" : "submission.marked", "submission", s.id,
    { assignmentId: a.id, learnerId: s.learner_id, marks: patch.marks, maxMarks: patch.max_marks, percentage: pct });
  return c.json(await submissionDetail({ ...s, ...patch }, a));
});

// ---- the learner's side ----

/** The learner's own row (class, school) — the session only carries the id. */
// deno-lint-ignore no-explicit-any
async function learnerSelf(c: any) {
  return await loadLearner(c.get("actor").id);
}

/** An assignment this learner may open: published or closed, for their
    current class — or one they already have work on. */
async function learnerAssignment(me: Record<string, any>, id: string) {
  const { data: a } = await admin.from("assignments").select("*").eq("id", id).maybeSingle();
  if (!a || a.status === "draft") return null;
  if (me.class_id && a.class_id === me.class_id) return a;
  const { data: sub } = await admin.from("assignment_submissions").select("id").eq("assignment_id", a.id).eq("learner_id", me.id).maybeSingle();
  return sub ? a : null;
}

/** Why this learner can't work on it right now, or null if they can. */
function cannotWork(me: Record<string, any>, a: Record<string, any>): string | null {
  if (a.status === "closed") return "This assignment is closed.";
  if (a.status !== "published") return "This assignment isn't open.";
  if (a.class_id !== me.class_id) return "This assignment is for a class you're no longer in.";
  if (a.starts_at && new Date(a.starts_at) > new Date()) return `This assignment opens on ${new Date(a.starts_at).toDateString()}.`;
  return null;
}

/** Where the learner is with it: not_started · in_progress · submitted · marked. */
const completionOf = (s: Record<string, any> | null | undefined) => (s ? s.status : "not_started");

/** A learner sees marks only once the work is marked. */
const learnerSubmission = (s: Record<string, any> | null | undefined) =>
  s ? mapSubmission(s, s.status === "marked") : null;

app.get("/learner/assignments", requirePermission("assignments.view.own"), async (c) => {
  const me = await learnerSelf(c);
  if (!me) return c.json({ error: "Learner not found" }, 404);
  const [{ data: mine }, { data: subs }] = await Promise.all([
    me.class_id ? admin.from("assignments").select("*").eq("class_id", me.class_id).neq("status", "draft") : { data: [] },
    admin.from("assignment_submissions").select("*").eq("learner_id", me.id),
  ]);
  const rows = [...(mine ?? [])];
  const have = new Set(rows.map((a) => a.id));
  const elsewhere = (subs ?? []).map((s: Record<string, unknown>) => s.assignment_id as string).filter((id: string) => !have.has(id));
  if (elsewhere.length) rows.push(...(await selectIn("assignments", "id", elsewhere)).filter((a) => a.status !== "draft"));
  const names = await assignmentNames(rows);
  const now = new Date();
  return c.json({
    assignments: rows.map((a) => {
      const s = (subs ?? []).find((x: Record<string, unknown>) => x.assignment_id === a.id);
      return {
        ...mapAssignmentRow(a, names),
        completion: completionOf(s),
        submission: learnerSubmission(s),
        opensLater: !!(a.starts_at && new Date(a.starts_at) > now),
        overdue: !!(a.due_at && new Date(a.due_at) < now && (!s || s.status === "in_progress")),
        canWork: !cannotWork(me, a) && (!s || s.status === "in_progress"),
      };
    }).sort((x, y) => String(x.dueAt ?? "9999").localeCompare(String(y.dueAt ?? "9999"))),
  });
});

async function learnerAssignmentView(me: Record<string, any>, a: Record<string, any>) {
  const [names, questions, { data: s }] = await Promise.all([
    assignmentNames([a]), questionsOf(a.id),
    admin.from("assignment_submissions").select("*").eq("assignment_id", a.id).eq("learner_id", me.id).maybeSingle(),
  ]);
  const { data: answers } = s ? await admin.from("submission_answers").select("*").eq("submission_id", s.id) : { data: [] };
  const marked = s?.status === "marked";
  let resource = null;
  if (a.resource_id) {
    const { data: item } = await admin.from("library_items").select("*").eq("id", a.resource_id).maybeSingle();
    if (item && item.published && canSeeLibrary(item.audience, "learner")) resource = await mapLibrary(item, false);
  }
  return {
    assignment: mapAssignmentRow(a, names),
    resource,
    // Never the answer key.
    questions: questions.map((q) => mapQuestion(q, false)),
    submission: learnerSubmission(s),
    completion: completionOf(s),
    cannotWork: cannotWork(me, a),
    answers: await Promise.all((answers ?? []).map(async (x: Record<string, any>) => ({
      questionId: x.question_id,
      response: x.response ?? null,
      files: await signFiles((x.files ?? []) as LibFile[], false),
      ...(marked ? { marks: x.marks != null ? Number(x.marks) : x.auto_marks != null ? Number(x.auto_marks) : null, feedback: x.feedback ?? null } : {}),
    }))),
  };
}

app.get("/learner/assignments/:id", requirePermission("assignments.view.own"), async (c) => {
  const me = await learnerSelf(c);
  const a = me ? await learnerAssignment(me, c.req.param("id")) : null;
  if (!me || !a) return c.json({ error: "Assignment not found" }, 404);
  return c.json(await learnerAssignmentView(me, a));
});

app.post("/learner/assignments/:id/start", requirePermission("assignments.submit"), async (c) => {
  const me = await learnerSelf(c);
  const a = me ? await learnerAssignment(me, c.req.param("id")) : null;
  if (!me || !a) return c.json({ error: "Assignment not found" }, 404);
  const { data: existing } = await admin.from("assignment_submissions").select("*").eq("assignment_id", a.id).eq("learner_id", me.id).maybeSingle();
  if (!existing) {
    const why = cannotWork(me, a);
    if (why) return c.json({ error: why }, 409);
    const { error } = await admin.from("assignment_submissions").insert({
      id: rid("sub"), assignment_id: a.id, learner_id: me.id, school_id: me.school_id, class_id: me.class_id, status: "in_progress",
      started_at: new Date().toISOString(), last_saved_at: new Date().toISOString(),
    });
    if (error && !isUniqueViolation(error)) return c.json({ error: error.message }, 400);
  }
  return c.json(await learnerAssignmentView(me, a));
});

/** Saves the given answers onto an in-progress submission. */
async function saveAnswers(me: Record<string, any>, a: Record<string, any>, s: Record<string, any>, raw: unknown): Promise<string | null> {
  if (!Array.isArray(raw)) return null;
  const questions = await questionsOf(a.id);
  const { data: existing } = await admin.from("submission_answers").select("*").eq("submission_id", s.id);
  const prefix = `submissions/${a.id}/${me.id}/`;
  const now = new Date().toISOString();
  for (const x of raw) {
    const q = questions.find((y) => y.id === x?.questionId);
    if (!q) return "That answer is for a question this assignment doesn't have";
    const response = cleanResponse({ type: q.type, options: q.options ?? [] }, x.response);
    if (response === undefined) return `Question ${q.position}: that isn't a valid answer`;
    let files: LibFile[] = [];
    if (q.type === "file_upload") {
      files = (Array.isArray(x.files) ? x.files : [])
        .filter((f: Record<string, unknown>) => typeof f?.path === "string" && (f.path as string).startsWith(prefix) && !(f.path as string).includes(".."))
        .slice(0, MAX_FILES_PER_ANSWER)
        .map((f: Record<string, unknown>) => ({ name: String(f.name ?? "file").slice(0, 200), path: f.path as string, size: Number(f.size) || 0 }));
    }
    const prev = (existing ?? []).find((y: Record<string, unknown>) => y.question_id === q.id);
    if (prev) await admin.from("submission_answers").update({ response, files, updated_at: now }).eq("id", prev.id);
    else await admin.from("submission_answers").insert({ id: rid("ans"), submission_id: s.id, question_id: q.id, response, files });
  }
  await admin.from("assignment_submissions").update({ last_saved_at: now }).eq("id", s.id);
  return null;
}

/* ---- offline work arriving later ----
   The device says which version it worked from: the time it last saw
   (baseSavedAt / baseMarkedAt — null when it had none). If the work was
   changed since, somewhere else, that's a conflict: the reply carries the
   server's copy, and the person decides which to keep (resending with
   force: true keeps theirs). Requests without a base are online edits and
   are never checked. */
function changedSince(serverAt: unknown, base: unknown): boolean {
  const server = serverAt ? Date.parse(String(serverAt)) : null;
  const seen = base ? Date.parse(String(base)) : null;
  if (server == null) return false;
  if (seen == null || !Number.isFinite(seen)) return true;
  return server - seen > 1000;
}

/** Answers changed on another device since this one saw them. */
async function answersChangedElsewhere(s: Record<string, any>, b: Record<string, any>) {
  if (b.force === true || !("baseSavedAt" in b)) return false;
  if (b.baseSavedAt == null) {
    // This device never saw saved answers: only a conflict if some exist.
    const { data } = await admin.from("submission_answers").select("id").eq("submission_id", s.id).limit(1);
    return !!data?.length;
  }
  return changedSince(s.last_saved_at, b.baseSavedAt);
}

/** The learner's open submission — or the refusal, with the server's copy
    when the work was handed in already (so an offline device can show it). */
// deno-lint-ignore no-explicit-any
async function openForWork(c: any, me: Record<string, any>, a: Record<string, any>, b: Record<string, any>) {
  const open = await openSubmission(me, a);
  if ("error" in open) {
    return c.json({
      error: open.error,
      ...("handedIn" in open ? { conflict: { kind: "already_handed_in", server: await learnerAssignmentView(me, a) } } : {}),
    }, open.status);
  }
  if (await answersChangedElsewhere(open.s, b)) {
    return c.json({
      error: "These answers were changed on another device.",
      conflict: { kind: "changed_elsewhere", server: await learnerAssignmentView(me, a) },
    }, 409);
  }
  return open.s as Record<string, any>;
}

/** When work handed in offline was handed in: the device's time, if it's
    plausible — not in the future, not before the assignment was out. */
function offlineHandInTime(raw: unknown, a: Record<string, any>, now: Date): Date | null {
  if (typeof raw !== "string") return null;
  const t = new Date(raw);
  if (!Number.isFinite(t.getTime())) return null;
  if (t.getTime() > now.getTime() + 2 * 60_000) return null;
  const opened = a.starts_at ?? a.published_at ?? a.created_at;
  if (opened && t.getTime() < new Date(opened).getTime()) return null;
  return t;
}

/** The learner's open (in-progress) submission, or why they can't work on it. */
async function openSubmission(me: Record<string, any>, a: Record<string, any>) {
  const { data: s } = await admin.from("assignment_submissions").select("*").eq("assignment_id", a.id).eq("learner_id", me.id).maybeSingle();
  if (!s) return { error: "Start the assignment first", status: 409 as const };
  if (s.status !== "in_progress") return { error: "You've already handed this in", status: 409 as const, handedIn: true };
  const why = cannotWork(me, a);
  if (why) return { error: why, status: 409 as const };
  return { s };
}

app.put("/learner/assignments/:id/answers", requirePermission("assignments.submit"), async (c) => {
  const me = await learnerSelf(c);
  const a = me ? await learnerAssignment(me, c.req.param("id")) : null;
  if (!me || !a) return c.json({ error: "Assignment not found" }, 404);
  const b = await c.req.json().catch(() => ({}));
  const s = await openForWork(c, me, a, b);
  if (s instanceof Response) return s;
  const err = await saveAnswers(me, a, s, b.answers);
  if (err) return c.json({ error: err }, 400);
  return c.json(await learnerAssignmentView(me, a));
});

const MAX_SUBMISSION_FILE = 25 * 1024 * 1024;
app.post("/learner/assignments/:id/upload", requirePermission("assignments.submit"), async (c) => {
  const me = await learnerSelf(c);
  const a = me ? await learnerAssignment(me, c.req.param("id")) : null;
  if (!me || !a) return c.json({ error: "Assignment not found" }, 404);
  const open = await openSubmission(me, a);
  if ("error" in open) return c.json({ error: open.error }, open.status);
  const b = await c.req.json().catch(() => ({}));
  const { data: q } = await admin.from("assignment_questions").select("*").eq("id", String(b.questionId ?? "")).maybeSingle();
  if (!q || q.assignment_id !== a.id || q.type !== "file_upload") return c.json({ error: "That question doesn't take a file" }, 400);
  const name = String(b.name ?? "").trim();
  if (!name) return c.json({ error: "Missing file name" }, 400);
  if (Number(b.size) > MAX_SUBMISSION_FILE) return c.json({ error: "Files can be up to 25 MB" }, 400);
  const path = `submissions/${a.id}/${me.id}/${rid("f")}/${safePath(name)}`;
  const { data, error } = await admin.storage.from(LIBRARY_BUCKET).createSignedUploadUrl(path);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ upload: { name, path, token: data.token, signedUrl: data.signedUrl, size: Number(b.size) || 0 } });
});

/* Hand it in. Saves any answers sent with it, records the time and whether
   it was late, marks what can be marked automatically — and if every
   question can, the work is marked straight away. */
app.post("/learner/assignments/:id/submit", requirePermission("assignments.submit"), async (c) => {
  const me = await learnerSelf(c);
  const a = me ? await learnerAssignment(me, c.req.param("id")) : null;
  if (!me || !a) return c.json({ error: "Assignment not found" }, 404);
  const b = await c.req.json().catch(() => ({}));
  const sub = await openForWork(c, me, a, b);
  if (sub instanceof Response) return sub;
  const open = { s: sub };
  const err = await saveAnswers(me, a, open.s, b.answers);
  if (err) return c.json({ error: err }, 400);
  const questions = await questionsOf(a.id);
  const { data: answers } = await admin.from("submission_answers").select("*").eq("submission_id", open.s.id);
  const now = new Date();
  const offlineAt = offlineHandInTime(b.clientSubmittedAt, a, now);
  let total = 0, max = 0, allAuto = questions.length > 0;
  for (const q of questions) {
    const qq = toQuestion(q);
    const ans = (answers ?? []).find((x: Record<string, unknown>) => x.question_id === q.id);
    const m = autoMark(qq, ans?.response ?? null);
    max += qq.maxMarks;
    if (m == null) { allAuto = false; continue; }
    total += m;
    if (ans) await admin.from("submission_answers").update({ auto_marks: m }).eq("id", ans.id);
    else await admin.from("submission_answers").insert({ id: rid("ans"), submission_id: open.s.id, question_id: q.id, response: null, auto_marks: m });
  }
  const at = now.toISOString();
  const patch: Record<string, unknown> = {
    status: "submitted", submitted_at: at, last_saved_at: at, is_late: isLate(a.due_at, offlineAt ?? now), max_marks: round2(max),
    offline_submitted_at: offlineAt ? offlineAt.toISOString() : null,
  };
  if (allAuto) {
    const pct = percentOf(total, max);
    Object.assign(patch, { status: "marked", marks: round2(total), percentage: pct, band: bandFor(pct, await loadBands()), marked_at: at, marked_by: null, auto_marked: true });
  }
  // Only an in-progress submission moves on — a second click can't resubmit.
  const { data: done, error: uErr } = await admin.from("assignment_submissions").update(patch)
    .eq("id", open.s.id).eq("status", "in_progress").select().maybeSingle();
  if (uErr) return c.json({ error: uErr.message }, 400);
  if (!done) return c.json({ error: "You've already handed this in" }, 409);
  await audit(c, "submission.submitted", "submission", open.s.id,
    { assignmentId: a.id, late: patch.is_late, autoMarked: allAuto, ...(offlineAt ? { handedInOffline: patch.offline_submitted_at } : {}) });
  return c.json(await learnerAssignmentView(me, a));
});

// ---- results ----
/* ?by=learner|class|subject|grade|term|year|school|assignment, filtered by
   ?classId= ?subjectId= ?grade= ?termId= ?academicYearId= ?schoolId= ?learnerId=.
   Each row carries completion and achievement side by side, never merged. */
app.get("/results", requirePermission("assignments.view.own", "assignments.manage", "assignments.view.school", "assignments.view.all"), async (c) => {
  const by = String(c.req.query("by") ?? "subject") as ResultDimension;
  if (!RESULT_DIMENSIONS.includes(by)) return c.json({ error: `by must be one of ${RESULT_DIMENSIONS.join(", ")}` }, 400);
  const f = (k: string) => String(c.req.query(k) ?? "");
  const isLearner = c.get("actor").role === "learner";
  let work: Awaited<ReturnType<typeof loadWork>>;
  try {
    if (isLearner) {
      if (by === "learner" || by === "school") return c.json({ error: "Not available" }, 400);
      work = await loadWork({ learnerId: c.get("actor").id });
    } else {
      const scope = await assignmentScope(c);
      if (scope.kind === "none") return c.json({ by, rows: [], overall: null, bands: await loadBands() });
      work = await loadWork({
        schoolId: scope.kind === "all" ? (f("schoolId") || null) : scope.schoolId,
        classIds: scope.kind === "teacher" ? scope.classIds : null,
        learnerId: f("learnerId") || null,
      });
      // Only work set in the caller's school / classes — whichever learner.
      work.pairs = work.pairs.filter((p) => inAssignmentScope(scope, { school_id: p.a.schoolId, class_id: p.a.classId }));
    }
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
  const pairs = work.pairs.filter((p) =>
    (!f("classId") || p.a.classId === f("classId")) &&
    (!f("subjectId") || p.a.subjectId === f("subjectId")) &&
    (!f("grade") || p.a.grade === f("grade")) &&
    (!f("termId") || p.a.termId === f("termId")) &&
    (!f("academicYearId") || p.a.yearId === f("academicYearId")));
  const bands = await loadBands();
  const rows = groupResults(pairs, by, bands);
  const labels = await resultLabels(by, rows.map((r) => r.key), work.assignments);
  return c.json({
    by,
    bands,
    overall: summarize(pairs, bands),
    rows: rows.map((r) => ({ ...r, label: labels[r.key] ?? r.key }))
      .sort((x, y) => String(x.label).localeCompare(String(y.label))),
  });
});

async function resultLabels(by: ResultDimension, keys: string[], assignments: Record<string, any>[]): Promise<Record<string, string>> {
  if (!keys.length) return {};
  const pick = async (table: string, col: string) =>
    Object.fromEntries((await selectIn(table, "id", keys, `id, ${col}`)).map((r) => [r.id, r[col]]));
  switch (by) {
    case "learner": return await pick("learners", "full_name");
    case "class": return await pick("classes", "name");
    case "subject": return await pick("subjects", "name");
    case "school": return await pick("schools", "name");
    case "assignment": return Object.fromEntries(assignments.map((a) => [a.id, a.title]));
    case "term": return Object.fromEntries(keys.map((k) => [k, termLabel(k) ?? k]));
    default: return Object.fromEntries(keys.map((k) => [k, k]));
  }
}

// ---- field reports (staff only) ----

app.get("/field-reports", requirePermission("field_reports.view.own", "field_reports.view.all"), async (c) => {
  const p = c.get("actor");
  const all = actorCan(c, "field_reports.view.all");
  const { data, error } = await selectAll(() => {
    let q = admin
      .from("field_reports")
      .select("*")
      .order("created_at", { ascending: false })
      .order("id");
    if (!all) q = q.eq("officer_id", p.id);
    return q;
  });
  if (error) return c.json({ error: error.message }, 500);
  if (all && !scopeOf(c).global) data.splice(0, data.length, ...data.filter((r) => inScope(c, r.school_id, r.county)));
  // For the officer's own visits: which of the visit's forms are still to fill.
  let missing: Map<string, Record<string, any>[]> = new Map();
  if (!all && data?.length) {
    const [{ data: forms }, responses] = await Promise.all([
      admin.from("forms").select("id, title, kind, audience, county, visit_type, archived_at, created_at, questions, external_url").not("visit_type", "is", null),
      selectIn("responses", "visit_id", data.map((r) => r.id as string), "id, form_id, visit_id"),
    ]);
    missing = new Map(data.map((r) => [r.id as string, missingVisitForms(r, forms ?? [], responses)]));
  }
  // Everyone's visits: who filed each one.
  const officers = all && data.length ? await selectIn("profiles", "id", [...new Set(data.map((r) => r.officer_id as string))], "id, full_name") : [];
  const officerName = new Map(officers.map((o) => [o.id, o.full_name]));
  return c.json({
    reports: (data ?? []).map((r) => ({
      ...mapReport(r), id: r.id, schoolId: r.school_id ?? null,
      ...(all ? { officer: officerName.get(r.officer_id) ?? null } : { missingForms: (missing.get(r.id as string) ?? []).map((f) => ({ id: f.id, title: f.title })) }),
    })),
  });
});

/* The visit's id from the device (made when the visit starts), so sending
   the same visit twice — a retry after the connection dropped mid-submit,
   or the offline queue — returns the visit already saved instead of
   filing a duplicate. */
const CLIENT_REF_RE = /^[A-Za-z0-9_-]{8,64}$/;
async function findVisitByClientRef(clientRef: string) {
  const { data } = await admin.from("field_reports").select("*").eq("client_ref", clientRef).maybeSingle();
  return data;
}

app.post("/field-reports", requirePermission("field_reports.create"), async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const actor = c.get("actor");
  const clientRef = b.clientRef ? String(b.clientRef) : null;
  if (clientRef && !CLIENT_REF_RE.test(clientRef)) return c.json({ error: "Invalid visit reference" }, 400);
  if (clientRef) {
    const existing = await findVisitByClientRef(clientRef);
    if (existing) {
      if (existing.officer_id !== actor.id) return c.json({ error: "Invalid visit reference" }, 409);
      return c.json({ report: mapReport(existing), alreadySaved: true });
    }
  }
  const school = await loadSchool(b.schoolId);
  if (b.visitType && !VISIT_TYPES.includes(String(b.visitType))) return c.json({ error: "Pick a valid visit type" }, 400);
  if (!school || !b.visitType) {
    return c.json({ error: "County, school and visit type are all required" }, 400);
  }
  if (!inScope(c, school.id)) return c.json({ error: "That school isn't one of your assigned schools" }, 403);

  // The visit's forms: each must be a field-officer form for this visit
  // type that covers this school's county.
  const filled = Array.isArray(b.responses) ? b.responses : [];
  const formIds = [...new Set(filled.map((r: { formId?: string }) => String(r?.formId ?? "")))];
  const { data: formRows } = formIds.length
    ? await admin.from("forms").select("*").in("id", formIds)
    : { data: [] as Record<string, unknown>[] };
  const formById = new Map((formRows ?? []).map((f) => [f.id, f]));
  for (const id of formIds) {
    const f = formById.get(id);
    if (!f || f.archived_at || f.audience !== "field_officer" || f.visit_type !== b.visitType || (f.county && f.county !== school.county)) {
      return c.json({ error: "One of the forms doesn't belong to this visit — reload and try again" }, 400);
    }
  }
  // Check every question form's answers before anything is saved.
  const answersByForm = new Map<string, { questionId: string; value: string }[]>();
  for (const id of formIds) {
    const f = formById.get(id)!;
    if (f.kind !== "questions") continue;
    const r = filled.find((x: { formId?: string }) => x?.formId === id);
    const checked = cleanAnswers(f, r?.answers);
    if ("error" in checked) return c.json({ error: checked.error }, 400);
    answersByForm.set(id as string, checked.answers);
  }

  const { data, error } = await admin
    .from("field_reports")
    .insert({
      id: rid("fr"),
      officer_id: actor.id,
      school_id: school.id,
      school: school.name,
      county: school.county,
      visit_type: b.visitType,
      client_ref: clientRef,
    })
    .select()
    .single();
  if (error) {
    // Two copies of the same visit arrived at once: the other one won.
    if (clientRef && isUniqueViolation(error)) {
      const existing = await findVisitByClientRef(clientRef);
      if (existing?.officer_id === actor.id) return c.json({ report: mapReport(existing), alreadySaved: true });
    }
    return c.json({ error: error.message }, 400);
  }

  if (formIds.length) {
    const rows = formIds.map((id) => {
      const f = formById.get(id)!;
      const r = filled.find((x: { formId?: string }) => x?.formId === id);
      return {
        id: rid("resp"),
        form_id: id,
        respondent_id: actor.id,
        respondent_name: actor.fullName,
        respondent_role: actor.role,
        visit_id: data.id,
        school: `${school.name} (${school.code})`,
        answers: answersByForm.get(id as string) ?? [],
        files: f.kind === "file" ? cleanResponseFiles(r?.files, id as string, actor.id) : [],
      };
    });
    const { error: rErr } = await admin.from("responses").insert(rows);
    if (rErr) {
      await admin.from("field_reports").delete().eq("id", data.id); // keep report + forms all-or-nothing
      return c.json({ error: rErr.message }, 400);
    }
  }
  return c.json({ report: mapReport(data) });
});

// ---- education-team dashboard stats ----

/** Count rows by a column, most-common first, blank/missing folded into "(not set)". */
function tally(rows: Record<string, unknown>[], key: string): { label: string; value: number }[] {
  const counts: Record<string, number> = {};
  for (const r of rows) {
    const label = String(r[key] ?? "").trim() || "(not set)";
    counts[label] = (counts[label] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);
}

const FORM_AUDIENCE_LABEL: Record<string, string> = {
  teacher: "Teachers", school_leader: "School Leaders", field_officer: "Field Officers",
};

/** Kenya's 3-term school year, derived from a signup timestamp — Jan-Apr,
    May-Aug, Sep-Dec. Not an official calendar lookup, just a fixed rule;
    chronological (not count) order matters for this one. */
function schoolTermOf(dateStr: unknown): string {
  const d = new Date(String(dateStr ?? ""));
  if (Number.isNaN(d.getTime())) return "(not set)";
  const term = d.getMonth() <= 3 ? 1 : d.getMonth() <= 7 ? 2 : 3;
  return `${d.getFullYear()} Term ${term}`;
}
function tallyChronological(rows: Record<string, unknown>[], toKey: (r: Record<string, unknown>) => string) {
  const counts: Record<string, number> = {};
  for (const r of rows) {
    const label = toKey(r);
    counts[label] = (counts[label] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => a.label.localeCompare(b.label)); // "2026 Term 1" < "2026 Term 2" sorts correctly as text
}

app.get("/stats", requirePermission("stats.view"), async (c) => {
  const county = String(c.req.query("county") ?? "").trim();
  const school = String(c.req.query("school") ?? "").trim();
  const inCounty = !!county;
  const inSchool = !!school;
  const topN = Math.max(0, Math.min(50, Number(c.req.query("topGrades")) || 0)); // 0 = no cap

  // Optional date range (Term is just a friendly preset for this same pair,
  // computed client-side). Only applied to rows that actually carry a
  // created_at — new-learner intake and field visits — never invented for
  // metrics with no date column (assignments, forms, library).
  const fromStr = String(c.req.query("from") ?? "").trim();
  const toStr = String(c.req.query("to") ?? "").trim();
  const fromDate = fromStr && !Number.isNaN(Date.parse(fromStr)) ? new Date(fromStr) : null;
  const toDate = toStr && !Number.isNaN(Date.parse(toStr)) ? new Date(toStr) : null;
  const inDateRange = (dateStr: unknown) => {
    if (!fromDate && !toDate) return true;
    const d = new Date(String(dateStr ?? ""));
    if (Number.isNaN(d.getTime())) return false;
    if (fromDate && d < fromDate) return false;
    if (toDate) { const end = new Date(toDate); end.setDate(end.getDate() + 1); if (d >= end) return false; }
    return true;
  };

  const [profs, learnersRaw, asg, reportsRaw, forms, responses, library, schoolsReg, countiesReg] = await Promise.all([
    selectAll(() => admin.from("profiles").select("id, role, county, school, school_id, teacher_type").order("id")),
    selectAll(() => admin.from("learners").select("id, teacher_id, grade, school, school_id, created_at").eq("enrollment_status", "ACTIVE").order("id")),
    loadWork({}).then((w) => ({ data: w, error: null }), (e) => ({ data: null, error: { message: (e as Error).message } })),
    selectAll(() => admin.from("field_reports").select("county, visit_type, school, school_id, created_at").order("id")),
    selectAll(() => admin.from("forms").select("id, audience").order("id")),
    selectAll(() => admin.from("responses").select("form_id, respondent_id").order("id")),
    selectAll(() => admin.from("library_items").select("audience, subject").order("id")),
    selectAll(() => admin.from("schools").select("id, name, county, code, seq").order("seq").order("id")),
    loadCounties().catch(() => [] as County[]),
  ]);
  // A failed read must not render as zeros on the dashboard.
  const statsErr = [profs, learnersRaw, asg, reportsRaw, forms, responses, library, schoolsReg]
    .find((r) => r.error)?.error;
  if (statsErr) return c.json({ error: statsErr.message }, 500);

  // Only the caller's area, before anything is counted.
  const area = scopeOf(c);
  const allProfiles = (profs.data ?? []).filter((p) => area.global ||
    (p.school_id ? inPlaceScope(area, p.school_id) : p.role === "field_officer" && inPlaceScope(area, null, p.county)));
  const allLearners = (learnersRaw.data ?? []).filter((l) => inPlaceScope(area, l.school_id));
  const allReports = (reportsRaw.data ?? []).filter((r) => inPlaceScope(area, r.school_id, r.county));
  if (!area.global) {
    const peopleHere = new Set(allProfiles.map((p) => p.id));
    if (responses.data) responses.data.splice(0, responses.data.length, ...responses.data.filter((r) => peopleHere.has(r.respondent_id)));
    if (asg.data) {
      asg.data.assignments = asg.data.assignments.filter((a) => inPlaceScope(area, a.school_id));
      asg.data.submissions = asg.data.submissions.filter((x) => inPlaceScope(area, x.school_id));
      asg.data.pairs = asg.data.pairs.filter((x) => inPlaceScope(area, x.a.schoolId));
    }
  }

  // The filter dropdowns list the education team's live counties and
  // schools — the same list every other picker in the portal uses — not
  // whatever text happens to be in people's profiles.
  const counties = countiesInScope(area, (schoolsReg.data ?? []) as { id: string; county: string }[], countiesReg.map((co) => co.name));
  const countyOrder = new Map(counties.map((n, i) => [n, i]));
  const schoolOptions = (schoolsReg.data ?? [])
    .filter((s) => (!inCounty || s.county === county) && inPlaceScope(area, s.id))
    .sort((a, b) => (countyOrder.get(a.county) ?? 99) - (countyOrder.get(b.county) ?? 99) || a.seq - b.seq)
    .map((s) => ({ name: s.name as string, code: s.code as string, county: s.county as string }));

  // A learner has no county (or school, in principle) of their own — they
  // inherit their teacher's, same as they inherit teacher.school at signup.
  const teacherCounty: Record<string, string> = {};
  for (const p of allProfiles) teacherCounty[p.id as string] = (p.county as string) || "";

  let staffRows = inCounty ? allProfiles.filter((p) => (p.county || "") === county) : allProfiles;
  let learnerRows = inCounty
    ? allLearners.filter((l) => teacherCounty[l.teacher_id as string] === county)
    : allLearners;
  let reportRows = inCounty ? allReports.filter((r) => r.county === county) : allReports;

  // Schools in the current (county-scoped) view — every listed school,
  // including ones with no activity yet.
  const schools = schoolOptions.map((s) => s.name);

  if (inSchool) {
    staffRows = staffRows.filter((p) => (p.school || "") === school);
    learnerRows = learnerRows.filter((l) => (l.school || "") === school);
    reportRows = reportRows.filter((r) => r.school === school);
  }
  if (fromDate || toDate) {
    learnerRows = learnerRows.filter((l) => inDateRange(l.created_at));
    reportRows = reportRows.filter((r) => inDateRange(r.created_at));
  }

  // Assignment work, scoped by the school it was set in.
  const schoolById = new Map((schoolsReg.data ?? []).map((s) => [s.id, s]));
  let pairs = asg.data?.pairs ?? [];
  if (inCounty) pairs = pairs.filter((p) => schoolById.get(p.a.schoolId)?.county === county);
  if (inSchool) pairs = pairs.filter((p) => schoolById.get(p.a.schoolId)?.name === school);
  const bands = await loadBands();
  const work = summarize(pairs, bands);

  const byRole: Record<string, number> = {
    teacher: 0,
    learner: learnerRows.length,
    school_leader: 0,
    field_officer: 0,
    education_team: 0,
  };
  for (const p of staffRows) {
    if (p.role in byRole) byRole[p.role as string]++;
  }
  const teachersByType = tally(staffRows.filter((p) => p.role === "teacher"), "teacher_type");

  // By grade, two separate rankings: COMPLETION (share of expected work
  // handed in) and ACHIEVEMENT (average mark on marked work). Handing work
  // in is not doing well in it, so neither stands in for the other.
  const byGrade = groupResults(pairs, "grade", bands);
  let gradeCompletion = byGrade
    .map((g) => ({ label: g.key, value: Math.round(g.completion.rate ?? 0), total: g.completion.assigned }))
    .sort((a, b) => b.value - a.value || b.total - a.total);
  let gradeAchievement = byGrade.filter((g) => g.achievement.marked > 0)
    .map((g) => ({ label: g.key, value: Math.round(g.achievement.averagePercent ?? 0), marked: g.achievement.marked, band: g.achievement.band }))
    .sort((a, b) => b.value - a.value || b.marked - a.marked);
  if (topN) {
    gradeCompletion = gradeCompletion.slice(0, topN);
    gradeAchievement = gradeAchievement.slice(0, topN);
  }

  const formRows = forms.data ?? [];
  const libraryRows = library.data ?? [];

  // Forms & feedback engagement, and the content library: neither is tied
  // to a school or county, so these stay portal-wide regardless of the
  // filter (the frontend labels them as such).
  const formAudience: Record<string, string> = {};
  const sentByAudience: Record<string, number> = {};
  for (const f of formRows) {
    formAudience[f.id as string] = f.audience as string;
    sentByAudience[f.audience as string] = (sentByAudience[f.audience as string] ?? 0) + 1;
  }
  const respByAudience: Record<string, number> = {};
  for (const r of responses.data ?? []) {
    const aud = formAudience[r.form_id as string];
    if (aud) respByAudience[aud] = (respByAudience[aud] ?? 0) + 1;
  }
  const formsEngagement = Object.keys(FORM_AUDIENCE_LABEL).map((k) => ({
    label: FORM_AUDIENCE_LABEL[k], sent: sentByAudience[k] ?? 0, responses: respByAudience[k] ?? 0,
  }));

  const libByDest = { "Teacher Resources": 0, "Digital Library": 0 };
  for (const it of libraryRows) {
    const dest = normalizeAudience(it.audience as string);
    libByDest[dest === "staff" ? "Teacher Resources" : "Digital Library"]++;
  }

  return c.json({
    county: inCounty ? county : null,
    school: inSchool ? school : null,
    from: fromDate ? fromStr : null,
    to: toDate ? toStr : null,
    counties,
    schools,
    schoolOptions,
    accounts: staffRows.length + learnerRows.length,
    byRole,
    teachersByType,
    // Completion: expected learner × assignment pairs, and how many were handed in.
    assignmentsTotal: work.completion.assigned,
    assignmentsDone: work.completion.submitted,
    completion: work.completion,
    achievement: work.achievement,
    bands,
    reportsFiled: reportRows.length,
    formsSent: formRows.length,
    responsesReceived: (responses.data ?? []).length,
    // Impact breakdowns for the Overview charts — county/school-scoped
    // when picked, portal-wide otherwise.
    learnersByGrade: tally(learnerRows, "grade"),
    learnersBySchool: tally(learnerRows, "school"),
    newLearnersByTerm: tallyChronological(learnerRows, (l) => schoolTermOf(l.created_at)),
    gradeCompletion,
    gradeAchievement,
    fieldReportsByCounty: tally(allReports, "county"), // always portal-wide: the "pick a county" overview
    fieldReportsBySchool: tally(reportRows, "school"),
    fieldReportsByVisitType: tally(reportRows, "visit_type"),
    libraryByDestination: Object.entries(libByDest).map(([label, value]) => ({ label, value })),
    libraryBySubject: tally(libraryRows, "subject"),
    formsEngagement,
  });
});

// ---- school leader: own-school overview ----
// Aggregates only — counts and grade-level rollups, never an individual
// learner's name or row, so the leader dashboard can be real without
// turning into a second learner roster. Scoped strictly to the leader's
// own school+county, unlike /stats (education team, portal-wide).

app.get("/school/overview", requirePermission("school.overview.view"), async (c) => {
  const actor = c.get("actor");
  const school = actor.school || "";
  const county = actor.county || "";
  const schoolRec = await loadSchool(actor.schoolId);
  if (!schoolRec) return c.json({ error: "Choose your school first — reload the page to pick it" }, 409);

  // Scoped by the school record itself, so two schools that happen to
  // share a name never get mixed together. Visits logged before schools
  // had records are matched by name + county as a fallback.
  const [profs, learnersRaw, reportsById, reportsByName, asg] = await Promise.all([
    selectAll(() => admin.from("profiles").select("id, teacher_type").eq("role", "teacher").eq("school_id", schoolRec.id).order("id")),
    selectAll(() => admin.from("learners").select("id, grade").eq("school_id", schoolRec.id).eq("enrollment_status", "ACTIVE").order("id")),
    selectAll(() => admin.from("field_reports").select("*").eq("school_id", schoolRec.id).order("id")),
    selectAll(() => admin.from("field_reports").select("*").is("school_id", null).eq("school", school).eq("county", county).order("id")),
    loadWork({ schoolId: schoolRec.id }).then((w) => ({ data: w, error: null }), (e) => ({ data: null, error: { message: (e as Error).message } })),
  ]);
  if (profs.error || learnersRaw.error || reportsById.error || reportsByName.error || asg.error) {
    return c.json({ error: "Could not load the school overview" }, 500);
  }

  const teacherRows = profs.data ?? [];
  const learnerRows = learnersRaw.data ?? [];
  const visitRows = [...(reportsById.data ?? []), ...(reportsByName.data ?? [])]
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

  const pairs = asg.data?.pairs ?? [];
  const bands = await loadBands();
  const work = summarize(pairs, bands);

  // Per grade: learners, completion (work handed in) and achievement (marks
  // on marked work) — reported side by side, never combined.
  const learnersInGrade: Record<string, number> = {};
  for (const l of learnerRows) {
    const g = (l.grade as string)?.trim() || "(not set)";
    learnersInGrade[g] = (learnersInGrade[g] ?? 0) + 1;
  }
  const workByGrade = new Map(groupResults(pairs, "grade", bands).map((g) => [g.key, g]));
  const gradeBreakdown = [...new Set([...Object.keys(learnersInGrade), ...workByGrade.keys()])]
    .map((grade) => {
      const g = workByGrade.get(grade);
      return {
        grade,
        learners: learnersInGrade[grade] ?? 0,
        assignmentsTotal: g?.completion.assigned ?? 0,
        assignmentsDone: g?.completion.submitted ?? 0,
        completionRate: g?.completion.rate ?? null,
        marked: g?.achievement.marked ?? 0,
        averagePercent: g?.achievement.averagePercent ?? null,
        band: g?.achievement.band ?? null,
      };
    })
    .sort((a, b) => a.grade.localeCompare(b.grade));

  const currentTerm = schoolTermOf(new Date().toISOString());
  const visitedThisTerm = visitRows.some((r) => schoolTermOf(r.created_at) === currentTerm);

  return c.json({
    school, county,
    schoolCode: schoolRec.code,
    teacherCount: teacherRows.length,
    learnerCount: learnerRows.length,
    teachersByType: tally(teacherRows, "teacher_type"),
    assignmentsTotal: work.completion.assigned,
    assignmentsDone: work.completion.submitted,
    completion: work.completion,
    achievement: work.achievement,
    bands,
    gradeBreakdown,
    visits: visitRows.slice(0, 10).map(mapReport),
    visitsTotal: visitRows.length,
    visitedThisTerm,
  });
});

// ---- programme intelligence (Education Team dashboard) ----
// Learning, programme implementation, data collection and impact in one
// read, computed by intelligence.ts from the raw rows. Filters: ?county=
// ?school= (name, as in /stats) ?from= ?to= (YYYY-MM-DD; applied to rows
// that carry a real date).
/** Everything buildIntelligence() reads, loaded once. Throws on a failed read
    (a failed read must never show up as zeros). */
async function loadIntelligenceInput(): Promise<Parameters<typeof buildIntelligence>[0]> {
  const read = (table: string, cols: string, order = "id") =>
    selectAll(() => admin.from(table).select(cols).order(order));
  const r = await Promise.all([
    read("schools", "id, name, county, code"),
    read("profiles", "id, role, status, school_id, county, teacher_type, gender"),
    read("learners", "id, school_id, class_id, grade, enrollment_status, gender"),
    read("learner_enrollments", "id, learner_id, school_id, class_id, enrollment_date, exit_date, status"),
    read("terms", "id, academic_year_id, term_no, starts_on, ends_on"),
    read("classes", "id, school_id, academic_year_id, grade, archived_at"),
    read("class_teachers", "id, class_id, teacher_id, role, ended_at"),
    read("subjects", "id, name"),
    read("assignments", "id, school_id, class_id, subject_id, grade, academic_year_id, term_id, starts_at, due_at, status, created_by, created_at, published_at"),
    read("assignment_submissions", "id, assignment_id, learner_id, school_id, status, is_late, percentage, started_at, last_saved_at, submitted_at, marked_at, marked_by"),
    read("field_reports", "id, school, school_id, county, visit_type, officer_id, created_at"),
    read("forms", "id, title, audience, county, visit_type, archived_at"),
    read("responses", "id, form_id, respondent_id, respondent_role, submitted_at, visit_id"),
    read("kobo_forms", "id, title, active, submission_count, rejected_count, unattributed_count, synced_at"),
    read("kobo_submissions", "kobo_form_id, officer_id, submitted_at", "kobo_form_id"),
    read("library_items", "id, title, audience, subject, type, published"),
    read("library_interactions", "id, library_item_id, actor_kind, actor_id, school, started_at, completed_at, duration_seconds"),
    read("kobo_records", "id, kobo_form_id, status, review, school_id, county, officer_id, submitted_at, warning_count"),
    read("kobo_record_issues", "id, record_id, rule, severity"),
  ]);
  const failed = r.find((x) => x.error);
  if (failed) throw new Error(failed.error!.message);
  const [schools, profiles, learners, enrollments, terms, classes, classTeachers, subjects, assignments, submissions,
    fieldReports, forms, responses, koboForms, koboSubmissions, libraryItems, libraryInteractions, koboRecords, koboIssues] = r.map((x) => x.data);
  return {
    schools, profiles, learners, enrollments, terms, classes, classTeachers, subjects, assignments, submissions,
    fieldReports, forms, responses, koboForms, koboSubmissions, libraryItems, libraryInteractions, koboRecords, koboIssues,
    bands: await loadBands(),
  };
}

app.get("/intelligence", requirePermission("intelligence.view"), async (c) => {
  const q = (k: string) => String(c.req.query(k) ?? "").trim() || null;
  const date = (k: string) => { const v = q(k); return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null; };
  let input;
  try { input = await loadIntelligenceInput(); } catch (e) { return c.json({ error: (e as Error).message }, 500); }
  return c.json(buildIntelligence(narrowInput(input, scopeOf(c)), { county: q("county"), school: q("school"), from: date("from"), to: date("to") }));
});

// ---- impact dashboards ----
// Executive overview, reach, learning, teacher development, field
// operations and digital resources in one read, computed by impact.ts (on
// top of buildIntelligence). Same filters as /intelligence. M&E indicators
// tagged for a dashboard come from /mel/dashboard?theme=.
async function loadImpactInput() {
  const [base, trainings, attendance] = await Promise.all([
    loadIntelligenceInput(),
    selectAll(() => admin.from("trainings").select("id, title, kind, held_on, ends_on, county, school_id, archived_at").order("id")),
    selectAll(() => admin.from("training_attendance").select("training_id, teacher_id, attended").order("training_id").order("teacher_id")),
  ]);
  const failed = [trainings, attendance].find((x) => x.error);
  if (failed) throw new Error(failed.error!.message);
  return { ...base, trainings: trainings.data, trainingAttendance: attendance.data };
}

/* The programme dashboards (intelligence.view), or only their learning side
   — learning, teacher development, digital resources — for the Education
   Team (learning.dashboard.view). Always within the caller's area. */
app.get("/impact", requirePermission("intelligence.view", "learning.dashboard.view"), async (c) => {
  const q = (k: string) => String(c.req.query(k) ?? "").trim() || null;
  const date = (k: string) => { const v = q(k); return v && DATE_RE.test(v) ? v : null; };
  let input;
  try { input = await loadImpactInput(); } catch (e) { return c.json({ error: (e as Error).message }, 500); }
  const d = buildImpact(narrowInput(input, scopeOf(c)), { county: q("county"), school: q("school"), from: date("from"), to: date("to") });
  if (actorCan(c, "intelligence.view")) return c.json(d);
  const { schoolsVisited: _v, ...executive } = d.executive;
  return c.json({ scope: d.scope, currentTerm: d.currentTerm, generatedAt: d.generatedAt, learningOnly: true,
    executive, learning: d.learning, teachers: d.teachers, resources: d.resources });
});

// ---- training register (Teacher development) ----
// Sessions and the teachers who attended. Nothing is deleted: a session is
// archived, and taking a teacher off the list marks them not attended.
// Every change is in the audit log.
const TRAINING_KINDS = ["workshop", "cluster", "coaching", "online", "other"];

async function readTraining(b: Record<string, any>, existing: Record<string, any> | null): Promise<Record<string, unknown> | { error: string }> {
  const out: Record<string, unknown> = {};
  if (!existing || b.title !== undefined) {
    const t = String(b.title ?? "").trim();
    if (!t || t.length > 200) return { error: "Give the session a title" };
    out.title = t;
  }
  if (b.topic !== undefined) out.topic = String(b.topic ?? "").trim().slice(0, 300);
  if (b.facilitator !== undefined) out.facilitator = String(b.facilitator ?? "").trim().slice(0, 200);
  if (b.notes !== undefined) out.notes = String(b.notes ?? "").trim().slice(0, 4000);
  if (b.kind !== undefined) {
    if (!TRAINING_KINDS.includes(b.kind)) return { error: "Choose the kind of session" };
    out.kind = b.kind;
  }
  if (!existing || b.heldOn !== undefined) {
    if (!DATE_RE.test(String(b.heldOn ?? ""))) return { error: "When was it held? (a date like 2026-09-14)" };
    out.held_on = b.heldOn;
  }
  if (b.endsOn !== undefined) {
    if (b.endsOn && !DATE_RE.test(String(b.endsOn))) return { error: "The end date looks like 2026-09-16" };
    out.ends_on = b.endsOn || null;
  }
  const start = String(out.held_on ?? existing?.held_on ?? "");
  const end = out.ends_on !== undefined ? out.ends_on : existing?.ends_on;
  if (end && String(end) < start) return { error: "It can't end before it starts" };
  // Where: a school (its county follows), or a county, or neither (online).
  if (b.schoolId !== undefined || b.county !== undefined) {
    if (b.schoolId) {
      const school = await loadSchool(b.schoolId);
      if (!school) return { error: "Choose a school from the list" };
      out.school_id = school.id;
      out.county = school.county;
    } else {
      const county = String(b.county ?? "").trim();
      if (county && !(await isCounty(county))) return { error: "Choose a county from the list" };
      out.school_id = null;
      out.county = county || null;
    }
  }
  return out;
}

/** Only real teacher accounts can be on an attendance list. */
async function teacherIdsIn(ids: unknown): Promise<string[] | { error: string }> {
  const list = Array.isArray(ids) ? [...new Set(ids.map(String))].slice(0, 500) : [];
  if (!list.length) return [];
  const rows = await selectIn("profiles", "id", list, "id, role");
  const ok = new Set(rows.filter((r) => r.role === "teacher").map((r) => r.id as string));
  const bad = list.filter((id) => !ok.has(id));
  return bad.length ? { error: "Only teachers can be on the attendance list" } : list;
}

async function trainingDetail(id: string) {
  const { data: t } = await admin.from("trainings").select("*").eq("id", id).maybeSingle();
  if (!t) return null;
  const rows = await selectIn("training_attendance", "training_id", [id]);
  const people = rows.length ? await selectIn("profiles", "id", rows.map((r) => r.teacher_id as string), "id, full_name, school, county") : [];
  const who = new Map(people.map((p) => [p.id, p]));
  const school = t.school_id ? await loadSchool(t.school_id) : null;
  return {
    id: t.id, title: t.title, topic: t.topic, kind: t.kind, heldOn: t.held_on, endsOn: t.ends_on ?? null,
    county: t.county ?? null, schoolId: t.school_id ?? null, school: school?.name ?? null,
    facilitator: t.facilitator, notes: t.notes, archived: !!t.archived_at, createdAt: t.created_at,
    attendance: rows.map((r) => ({
      teacherId: r.teacher_id, name: who.get(r.teacher_id)?.full_name ?? "Former account",
      school: who.get(r.teacher_id)?.school ?? "", county: who.get(r.teacher_id)?.county ?? "",
      attended: r.attended !== false, recordedAt: r.recorded_at,
    })).sort((a, b) => Number(b.attended) - Number(a.attended) || String(a.name).localeCompare(String(b.name))),
  };
}

/* Teachers to pick from for an attendance list. */
app.get("/trainings/teachers", requirePermission("trainings.manage"), async (c) => {
  const { data, error } = await selectAll(() => admin.from("profiles").select("id, full_name, school, school_id, county, status")
    .eq("role", "teacher").order("full_name").order("id"));
  if (error) return c.json({ error: error.message }, 500);
  return c.json({
    teachers: (data ?? []).filter((p) => (p.status ?? "active") === "active" && inScope(c, p.school_id))
      .map((p) => ({ id: p.id, name: p.full_name, school: p.school ?? "", schoolId: p.school_id ?? null, county: p.county ?? "" })),
  });
});

/** A session belongs to its school, else its county; one with neither is programme-wide. */
// deno-lint-ignore no-explicit-any
const trainingInScope = (c: any, t: Record<string, any>) =>
  t.school_id ? inScope(c, t.school_id) : t.county ? inScope(c, null, t.county) : scopeOf(c).global;

/* ?archived=1 includes archived sessions. */
app.get("/trainings", requirePermission("intelligence.view", "trainings.manage"), async (c) => {
  const [{ data, error }, { data: att }, { data: schools }] = await Promise.all([
    selectAll(() => admin.from("trainings").select("*").order("held_on", { ascending: false }).order("id")),
    selectAll(() => admin.from("training_attendance").select("training_id, attended").order("training_id").order("teacher_id")),
    selectAll(() => admin.from("schools").select("id, name").order("id")),
  ]);
  if (error) return c.json({ error: error.message }, 500);
  const schoolName = new Map((schools ?? []).map((s) => [s.id, s.name]));
  const archived = c.req.query("archived") === "1";
  return c.json({
    canManage: actorCan(c, "trainings.manage"),
    kinds: TRAINING_KINDS,
    trainings: (data ?? []).filter((t) => (archived || !t.archived_at) && trainingInScope(c, t))
      .sort((a, b) => String(b.held_on).localeCompare(String(a.held_on)) || String(a.id).localeCompare(String(b.id))).map((t) => ({
      id: t.id, title: t.title, topic: t.topic, kind: t.kind, heldOn: t.held_on, endsOn: t.ends_on ?? null,
      county: t.county ?? null, schoolId: t.school_id ?? null, school: t.school_id ? schoolName.get(t.school_id) ?? null : null,
      facilitator: t.facilitator, archived: !!t.archived_at,
      attendees: (att ?? []).filter((a) => a.training_id === t.id && a.attended !== false).length,
    })),
  });
});

app.get("/trainings/:id", requirePermission("intelligence.view", "trainings.manage"), async (c) => {
  const t = await trainingDetail(c.req.param("id"));
  return t && trainingInScope(c, { school_id: t.schoolId, county: t.county }) ? c.json({ training: t }) : c.json({ error: "Session not found" }, 404);
});

app.post("/trainings", requirePermission("trainings.manage"), async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const fields = await readTraining(b, null);
  if ("error" in fields) return c.json(fields, 400);
  if (!trainingInScope(c, fields)) return c.json({ error: OUTSIDE_AREA }, 403);
  const teachers = await teacherIdsIn(b.teacherIds);
  if ("error" in teachers) return c.json(teachers, 400);
  const id = rid("trn");
  const actorId = c.get("actor").id;
  const { error } = await admin.from("trainings").insert({
    id, kind: "workshop", topic: "", facilitator: "", notes: "", ...fields, created_by: actorId, created_at: new Date().toISOString(),
  });
  if (error) return c.json({ error: error.message }, 400);
  if (teachers.length) {
    const { error: aErr } = await admin.from("training_attendance").insert(teachers.map((t) => ({
      training_id: id, teacher_id: t, attended: true, recorded_by: actorId, recorded_at: new Date().toISOString(),
    })));
    if (aErr) return c.json({ error: aErr.message }, 400);
  }
  await audit(c, "training.created", "training", id, { title: fields.title, heldOn: fields.held_on, attendees: teachers.length });
  return c.json({ training: await trainingDetail(id) });
});

/* Change the details, archive / restore (archived: true/false), and mark
   attendance: attendance = [{ teacherId, attended }] — adding a teacher, or
   taking one off the list (kept, as not attended). */
app.patch("/trainings/:id", requirePermission("trainings.manage"), async (c) => {
  const { data: t } = await admin.from("trainings").select("*").eq("id", c.req.param("id")).maybeSingle();
  if (!t || !trainingInScope(c, t)) return c.json({ error: "Session not found" }, 404);
  const b = await c.req.json().catch(() => ({}));
  const fields = await readTraining(b, t);
  if ("error" in fields) return c.json(fields, 400);
  if (!trainingInScope(c, { ...t, ...fields })) return c.json({ error: OUTSIDE_AREA }, 403);
  // Only what actually changes is written (and audited).
  for (const k of Object.keys(fields)) if (String(fields[k] ?? "") === String(t[k] ?? "")) delete fields[k];
  if (b.archived !== undefined && !!b.archived !== !!t.archived_at) fields.archived_at = b.archived ? new Date().toISOString() : null;
  const changes = Array.isArray(b.attendance) ? b.attendance.slice(0, 500) : [];
  const ids = await teacherIdsIn(changes.map((x: Record<string, unknown>) => x?.teacherId));
  if ("error" in ids) return c.json(ids, 400);
  if (Object.keys(fields).length) {
    const { error } = await admin.from("trainings").update(fields).eq("id", t.id);
    if (error) return c.json({ error: error.message }, 400);
    await audit(c, b.archived === true ? "training.archived" : b.archived === false ? "training.restored" : "training.updated",
      "training", t.id, { fields: Object.keys(fields) });
  }
  if (changes.length) {
    const actorId = c.get("actor").id;
    const existing = await selectIn("training_attendance", "training_id", [t.id]);
    const added: string[] = [], removed: string[] = [], restored: string[] = [];
    for (const ch of changes) {
      const teacherId = String(ch.teacherId);
      const attended = ch.attended !== false;
      const row = existing.find((r) => r.teacher_id === teacherId);
      const now = new Date().toISOString();
      if (!row) {
        if (!attended) continue;
        const { error } = await admin.from("training_attendance").insert({ training_id: t.id, teacher_id: teacherId, attended: true, recorded_by: actorId, recorded_at: now });
        if (error) return c.json({ error: error.message }, 400);
        added.push(teacherId);
      } else if ((row.attended !== false) !== attended) {
        const { error } = await admin.from("training_attendance").update({ attended, recorded_by: actorId, recorded_at: now })
          .eq("training_id", t.id).eq("teacher_id", teacherId);
        if (error) return c.json({ error: error.message }, 400);
        (attended ? restored : removed).push(teacherId);
      }
    }
    if (added.length || removed.length || restored.length) {
      await audit(c, "training.attendance_changed", "training", t.id, { added, removed, restored });
    }
  }
  return c.json({ training: await trainingDetail(t.id) });
});

// ---------------------------------------------------------------- Data Quality Center
// A register of every data problem the portal finds (data_quality.ts),
// kept in step by scans: new problems open, problems found again after
// being resolved reopen, problems no longer found resolve themselves (as
// "fixed at the source"). People move issues through OPEN → UNDER_REVIEW →
// RESOLVED / IGNORED, and can correct some directly — always through the
// same audited code paths as normal edits, never by deleting anything.
// Every step is an append-only event on the issue, and corrections also
// go to the main audit log.

const DQ_STALE_MS = 15 * 60 * 1000;
const DQ_COLS = [
  "id", "issue_key", "type", "kind", "severity", "status", "summary", "entity_type", "entity_id", "entity_label",
  "related", "school_id", "county", "details", "first_detected_at", "last_detected_at", "still_present",
  "status_changed_at", "status_changed_by", "resolved_at", "resolved_by", "resolution", "note", "reopened_count",
] as const;
/** A complete dq_issues row (every column), so batched upserts never null anything out. */
function dqRow(base: Record<string, unknown>, patch: Record<string, unknown>) {
  const merged = { ...base, ...patch };
  return Object.fromEntries(DQ_COLS.map((k) => [k, merged[k] ?? null]));
}

async function dqSnapshot(): Promise<DqSnapshot> {
  const read = (table: string, cols: string, order = "id") => selectAll(() => admin.from(table).select(cols).order(order));
  const r = await Promise.all([
    read("schools", "id, name, code, county"),
    read("counties", "name, code", "name"),
    read("profiles", "id, role, status, full_name, email, school_id, county, created_at"),
    read("learners", "id, full_name, learner_code, user_code, grade, school_id, county, class_id, current_teacher_id, enrollment_status, created_at"),
    read("learner_enrollments", "id, learner_id, school_id, class_id, status, enrollment_date, exit_date"),
    read("classes", "id, school_id, grade, name, archived_at"),
    read("class_teachers", "id, class_id, teacher_id, role, ended_at"),
    read("assignments", "id, class_id, school_id, status, created_by, title"),
    read("terms", "id, academic_year_id, starts_on, ends_on"),
    read("field_reports", "id, school, school_id, county, visit_type, created_at"),
    read("kobo_records", "id, kobo_form_id, kobo_id, status, review, school_id, county, school_value"),
    read("kobo_record_issues", "id, record_id, rule, severity, field, message"),
    read("kobo_forms", "id, title, active"),
    read("library_items", "id"),
    read("library_interactions", "id, library_item_id"),
  ]);
  const failed = r.find((x) => x.error);
  if (failed) throw new Error(failed.error!.message);
  const [schools, counties, profiles, learners, enrollments, classes, classTeachers, assignments, terms,
    fieldReports, koboRecords, koboIssues, koboForms, libraryItems, libraryInteractions] = r.map((x) => x.data);
  return {
    schools, counties, profiles, learners, enrollments, classes, classTeachers, assignments, terms,
    fieldReports, koboRecords, koboIssues, koboForms, libraryItems, libraryInteractions, grades: GRADES,
  };
}

/** Finds every problem, brings the register up to date, and records the
    scan (with its score). Returns the scan's counts. */
async function runDqScan(actorId: string | null, trigger: "manual" | "auto" | "correction") {
  const scanId = rid("dqs");
  const started = new Date().toISOString();
  const { issues, checked } = detectDataQuality(await dqSnapshot());
  const { data: existing, error } = await selectAll(() => admin.from("dq_issues").select("*").order("id"));
  if (error) throw new Error(error.message);
  const byKey = new Map(existing.map((e) => [e.issue_key as string, e]));
  const now = new Date().toISOString();
  const rows: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let opened = 0, reopened = 0, autoResolved = 0;
  for (const d of issues) {
    seen.add(d.key);
    const e = byKey.get(d.key);
    const fields = {
      type: d.type, kind: d.kind, severity: d.severity, summary: d.summary,
      entity_type: d.entity.type, entity_id: d.entity.id, entity_label: d.entity.label, related: d.related,
      school_id: d.schoolId, county: d.county, details: d.details, still_present: true,
    };
    if (!e) {
      const id = rid("dq");
      rows.push(dqRow({ id, issue_key: d.key, status: "OPEN", first_detected_at: now, reopened_count: 0 }, { ...fields, last_detected_at: now }));
      events.push({ issue_id: id, action: "detected", to_status: "OPEN", details: { scan: scanId } });
      opened++;
    } else if (e.status === "RESOLVED") {
      rows.push(dqRow(e, {
        ...fields, last_detected_at: now, status: "OPEN", reopened_count: (e.reopened_count ?? 0) + 1,
        resolved_at: null, resolved_by: null, resolution: null, status_changed_at: now, status_changed_by: null,
      }));
      events.push({ issue_id: e.id, action: "reopened", from_status: "RESOLVED", to_status: "OPEN", note: "Found again by a scan", details: { scan: scanId } });
      reopened++;
    } else if (stableStringify(Object.fromEntries(Object.keys(fields).map((k) => [k, e[k] ?? null]))) !== stableStringify(fields)) {
      rows.push(dqRow(e, { ...fields, last_detected_at: now }));
    }
  }
  for (const e of existing) {
    if (seen.has(e.issue_key) || !e.still_present) continue;
    if (e.status === "OPEN" || e.status === "UNDER_REVIEW") {
      rows.push(dqRow(e, {
        still_present: false, status: "RESOLVED", resolved_at: now, resolved_by: null,
        resolution: "No longer found — fixed at the source", status_changed_at: now, status_changed_by: null,
      }));
      events.push({ issue_id: e.id, action: "auto_resolved", from_status: e.status, to_status: "RESOLVED", note: "No longer found by a scan", details: { scan: scanId } });
      autoResolved++;
    } else {
      rows.push(dqRow(e, { still_present: false }));
    }
  }
  for (let i = 0; i < rows.length; i += 300) {
    const { error: uErr } = await admin.from("dq_issues").upsert(rows.slice(i, i + 300), { onConflict: "id" });
    if (uErr) throw new Error(uErr.message);
  }
  for (let i = 0; i < events.length; i += 500) {
    const { error: eErr } = await admin.from("dq_issue_events").insert(events.slice(i, i + 500));
    if (eErr) throw new Error(eErr.message);
  }
  // The portal-wide score after this scan.
  const { data: all } = await selectAll(() => admin.from("dq_issues").select("type, status, still_present").order("id"));
  const score = qualityScore(checkedIn(checked, null), openCountsByType(all ?? []));
  await admin.from("dq_scans").insert({
    id: scanId, started_at: started, finished_at: new Date().toISOString(), actor_id: actorId, trigger,
    found: issues.length, opened, reopened, auto_resolved: autoResolved, checked, score: score.score,
  });
  return { scanId, found: issues.length, opened, reopened, autoResolved, score: score.score };
}

/** OPEN + UNDER_REVIEW issues still present, by type — what the score counts. */
function openCountsByType(rows: Record<string, any>[]) {
  const out: Record<string, number> = {};
  for (const r of rows) if ((r.status === "OPEN" || r.status === "UNDER_REVIEW") && r.still_present !== false) out[r.type] = (out[r.type] ?? 0) + 1;
  return out as Partial<Record<DqIssueType, number>>;
}

async function latestDqScan() {
  const { data } = await selectAll(() => admin.from("dq_scans").select("*").order("id"));
  return (data ?? []).sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
}

/** ?county= ?school= (name) ?type= ?severity= ?status= (or "active": OPEN +
    UNDER_REVIEW) ?from= ?to= (first detected), ?q= */
// deno-lint-ignore no-explicit-any
async function dqFiltered(c: any) {
  const f = (k: string) => String(c.req.query(k) ?? "").trim();
  const { data: everyIssue, error } = await selectAll(() => admin.from("dq_issues").select("*").order("id"));
  if (error) throw new Error(error.message);
  // Only issues inside the caller's own area, before any filter they pick.
  const sc = scopeOf(c);
  const issues = everyIssue.filter((i) => inPlaceScope(sc, i.school_id, i.county));
  let schoolIds: Set<string> | null = sc.global ? null : new Set(sc.schoolIds);
  if (f("school") || f("county")) {
    const { data: schools } = await selectAll(() => admin.from("schools").select("id, name, county").order("id"));
    schoolIds = new Set(schools.filter((s) => (!f("school") || s.name === f("school")) && (!f("county") || s.county === f("county")) &&
      inPlaceScope(sc, s.id)).map((s) => s.id as string));
  }
  const picked = (i: Record<string, any>) =>
    (!f("county") || i.county === f("county") || (i.school_id && schoolIds!.has(i.school_id))) &&
    (!f("school") || (i.school_id && schoolIds!.has(i.school_id)));
  const q = f("q").toLowerCase();
  const scoped = issues.filter(picked);
  const filtered = scoped.filter((i) =>
    (!f("type") || i.type === f("type")) && (!f("severity") || i.severity === f("severity")) &&
    (!f("status") || i.status === f("status") || (f("status") === "active" && (i.status === "OPEN" || i.status === "UNDER_REVIEW"))) &&
    (!f("from") || String(i.first_detected_at).slice(0, 10) >= f("from")) &&
    (!f("to") || String(i.first_detected_at).slice(0, 10) <= f("to")) &&
    (!q || `${i.summary} ${i.entity_label}`.toLowerCase().includes(q)));
  return { scoped, filtered, schoolIds };
}

async function dqNames(ids: unknown[]) {
  const list = [...new Set(ids.filter(Boolean))] as string[];
  if (!list.length) return new Map<string, string>();
  const { data } = await admin.from("profiles").select("id, full_name").in("id", list);
  return new Map((data ?? []).map((p: Record<string, unknown>) => [p.id as string, p.full_name as string]));
}
const SEVERITY_ORDER: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
const mapDqIssue = (i: Record<string, any>, names: Map<string, string>, schoolName: Map<string, string>) => ({
  id: i.id, type: i.type, typeLabel: DQ_TYPES[i.type as DqIssueType]?.label ?? i.type, kind: i.kind,
  severity: i.severity, status: i.status, summary: i.summary,
  entity: { type: i.entity_type, id: i.entity_id, label: i.entity_label }, related: i.related ?? [],
  schoolId: i.school_id ?? null, school: i.school_id ? schoolName.get(i.school_id) ?? null : null, county: i.county ?? null,
  firstDetectedAt: i.first_detected_at, lastDetectedAt: i.last_detected_at, stillPresent: i.still_present !== false,
  statusChangedAt: i.status_changed_at ?? null, statusChangedBy: i.status_changed_by ? names.get(i.status_changed_by) ?? null : null,
  resolvedAt: i.resolved_at ?? null,
  resolvedBy: i.resolved_by ? names.get(i.resolved_by) ?? "—" : i.resolved_at ? "Scan (fixed at the source)" : null,
  resolution: i.resolution ?? null, note: i.note ?? null, reopenedCount: i.reopened_count ?? 0,
});
async function schoolNameMap() {
  const { data } = await selectAll(() => admin.from("schools").select("id, name").order("id"));
  return new Map((data ?? []).map((s) => [s.id as string, s.name as string]));
}

app.post("/data-quality/scan", requirePermission("data_quality.view"), async (c) => {
  // A scan re-checks every record in the portal, so it's for whole-portal staff.
  if (!scopeOf(c).global) return c.json({ error: WHOLE_PORTAL_ONLY }, 403);
  try {
    const res = await runDqScan(c.get("actor").id, c.req.query("auto") ? "auto" : "manual");
    return c.json(res);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

app.get("/data-quality/summary", requirePermission("data_quality.view"), async (c) => {
  let scoped: Record<string, any>[], filtered: Record<string, any>[], schoolIds: Set<string> | null;
  try { ({ scoped, filtered, schoolIds } = await dqFiltered(c)); } catch (e) { return c.json({ error: (e as Error).message }, 500); }
  const scans = await latestDqScan();
  const last = scans[0] ?? null;
  // The score is about the data as it is now, within the county/school picked.
  const checked = last ? checkedIn(last.checked as never, schoolIds) : null;
  const score = checked ? qualityScore(checked, openCountsByType(scoped)) : null;
  const by = <K extends string>(rows: Record<string, any>[], k: string, keys: readonly K[]) =>
    Object.fromEntries(keys.map((x) => [x, rows.filter((r) => r[k] === x).length])) as Record<K, number>;
  const live = filtered.filter((i) => i.status === "OPEN" || i.status === "UNDER_REVIEW");
  const affected = new Set<string>();
  for (const i of live) {
    affected.add(`${i.entity_type}:${i.entity_id}`);
    for (const r of i.related ?? []) affected.add(`${r.type}:${r.id}`);
  }
  const names = await schoolNameMap();
  const bySchool = new Map<string, number>();
  for (const i of live) bySchool.set(i.school_id ?? "", (bySchool.get(i.school_id ?? "") ?? 0) + 1);
  return c.json({
    lastScan: last ? { at: last.finished_at ?? last.started_at, found: last.found, opened: last.opened, reopened: last.reopened, autoResolved: last.auto_resolved, trigger: last.trigger } : null,
    stale: !last || Date.now() - new Date(last.started_at).getTime() > DQ_STALE_MS,
    score: score ? { value: score.score, label: score.label } : null,
    history: scans.slice(0, 30).reverse().map((s) => ({ at: s.started_at, score: s.score == null ? null : Number(s.score) })),
    totals: {
      issues: filtered.length,
      byStatus: by(filtered, "status", DQ_STATUSES),
      bySeverity: by(live, "severity", DQ_SEVERITIES),
      affectedRecords: affected.size,
    },
    byType: DQ_TYPE_IDS.map((t) => {
      const rows = filtered.filter((i) => i.type === t);
      const p = score?.perType.find((x) => x.type === t);
      return {
        type: t, label: DQ_TYPES[t].label, severity: DQ_TYPES[t].severity, checked: p?.checked ?? 0, passRate: p?.passRate ?? null,
        ...by(rows, "status", DQ_STATUSES),
      };
    }),
    bySchool: [...bySchool.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([id, n]) => ({ schoolId: id || null, school: id ? names.get(id) ?? id : "(no school)", open: n })),
  });
});

app.get("/data-quality/issues", requirePermission("data_quality.view"), async (c) => {
  let filtered: Record<string, any>[];
  try { ({ filtered } = await dqFiltered(c)); } catch (e) { return c.json({ error: (e as Error).message }, 500); }
  filtered.sort((a, b) =>
    (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) ||
    String(b.first_detected_at).localeCompare(String(a.first_detected_at)) || String(a.id).localeCompare(String(b.id)));
  const offset = Math.max(0, Number(c.req.query("offset")) || 0);
  const page = filtered.slice(offset, offset + Math.max(1, Math.min(200, Number(c.req.query("limit")) || 50)));
  const [names, schools] = await Promise.all([dqNames(page.flatMap((i) => [i.resolved_by, i.status_changed_by])), schoolNameMap()]);
  return c.json({ total: filtered.length, issues: page.map((i) => mapDqIssue(i, names, schools)) });
});

/* ---- corrections ----
   Each is the smallest change that fixes the problem, through the same
   code path (and permission) as the normal edit. None deletes anything. */
type DqFix = { action: string; label: string; description: string; params: { name: string; label: string; options: { value: string; label: string }[]; value?: string }[] };

// deno-lint-ignore no-explicit-any
async function dqFixesFor(c: any, i: Record<string, any>): Promise<DqFix[]> {
  if (!actorCan(c, "data_quality.manage") || i.status === "RESOLVED" || i.status === "IGNORED" || !i.still_present) return [];
  const fixes: DqFix[] = [];
  const actor = c.get("actor");
  const learner = i.entity_type === "learner" ? (await admin.from("learners").select("*").eq("id", i.entity_id).maybeSingle()).data : null;
  const prof = i.entity_type === "profile" ? (await admin.from("profiles").select("*").eq("id", i.entity_id).maybeSingle()).data : null;
  const canLearners = actorCan(c, "learners.manage.all");
  const canPlace = actorCan(c, "users.placement.assign") && prof && canManageAccount(actor, prof);
  if ((i.type === "missing_grade" || i.type === "invalid_grade") && learner && canLearners) {
    fixes.push({
      action: "set_learner_grade", label: "Set the grade", description: "Updates the learner's grade (and their current enrollment).",
      params: [{ name: "grade", label: "Grade", options: GRADES.map((g) => ({ value: g, label: g })), value: (i.details?.classGrade as string) ?? undefined }],
    });
  }
  if (i.type === "learner_without_class" && learner?.school_id && canLearners) {
    const yearId = (await currentCalendar()).yearId;
    const { data: classes } = await admin.from("classes").select("id, name, grade, academic_year_id, archived_at").eq("school_id", learner.school_id);
    const open = (classes ?? []).filter((x: Record<string, unknown>) => !x.archived_at && (!yearId || x.academic_year_id === yearId));
    if (open.length) {
      fixes.push({
        action: "place_learner_in_class", label: "Place in a class", description: "Puts the learner in one of their school's classes this year.",
        params: [{ name: "classId", label: "Class", options: open.map((x: Record<string, unknown>) => ({ value: x.id as string, label: `${x.name} (${x.grade})` })),
          value: (open.find((x: Record<string, unknown>) => x.grade === learner.grade)?.id as string) ?? undefined }],
      });
    }
  }
  if (i.type === "staff_without_school" && prof && canPlace) {
    const { data: schools } = await selectAll(() => admin.from("schools").select("id, name, code, county").order("id"));
    fixes.push({
      action: "set_profile_school", label: "Place in a school", description: "Gives the account its school (and its county and code).",
      params: [{ name: "schoolId", label: "School", options: schools.map((s) => ({ value: s.id as string, label: `${s.name} (${s.code}, ${s.county})` })) }],
    });
  }
  if (i.type === "school_county_mismatch" && ((learner && canLearners) || canPlace) && i.details?.expected) {
    fixes.push({ action: "align_county", label: `Use the school's county (${i.details.expected})`, description: "Sets the recorded county to the school's county.", params: [] });
  }
  if (i.type === "duplicate_learner" && canLearners) {
    const ids = (i.details?.learnerIds as string[]) ?? [];
    const { data: rows } = ids.length ? await admin.from("learners").select("id, full_name, learner_code, user_code, grade, enrollment_status").in("id", ids) : { data: [] };
    const active = (rows ?? []).filter((l: Record<string, unknown>) => (l.enrollment_status ?? ACTIVE) === ACTIVE);
    if (active.length >= 2) {
      fixes.push({
        action: "archive_duplicate_learner", label: "Archive the duplicate", description: "Archives one record as Inactive (“duplicate record”) — kept, reversible, never deleted.",
        params: [{ name: "learnerId", label: "Which record is the duplicate?", options: active.map((l: Record<string, unknown>) => ({ value: l.id as string, label: `${l.full_name} — ${l.learner_code ?? l.user_code ?? ""}${l.grade ? `, ${l.grade}` : ""}` })) }],
      });
    }
  }
  if (i.type === "orphaned_record" && canLearners && i.kind === "no_active_enrollment") {
    fixes.push({ action: "open_enrollment", label: "Open an enrollment record", description: "Records the learner's current school and class as an enrollment.", params: [] });
  }
  if (i.type === "orphaned_record" && canLearners && i.kind === "stale_enrollment") {
    fixes.push({ action: "close_enrollment", label: "Close the enrollment", description: "Closes it with the learner's own leaving status and date.", params: [] });
  }
  if (i.entity_type === "class_teacher" && actorCan(c, "classes.manage.all") && ["inactive_user_active_assignment", "orphaned_record"].includes(i.type)) {
    fixes.push({ action: "end_class_assignment", label: "End this class assignment", description: "Ends the teacher's assignment to the class (kept in history).", params: [] });
  }
  if (i.entity_type === "kobo_record" && actorCan(c, "kobo.manage")) {
    fixes.push({ action: "kobo_accept", label: "Accept the submission anyway", description: "Counts it on the dashboards despite the check (Kobo data pipeline).", params: [] });
    fixes.push({ action: "kobo_exclude", label: "Exclude the submission", description: "Keeps it off the dashboards (Kobo data pipeline).", params: [] });
  }
  return fixes;
}

/** Applies one correction. Returns what changed, or a refusal. */
// deno-lint-ignore no-explicit-any
async function applyDqFix(c: any, i: Record<string, any>, b: Record<string, any>, note: string):
  Promise<{ before: Record<string, unknown>; after: Record<string, unknown>; description: string } | Response> {
  const actor = c.get("actor");
  const loadLearnerRow = async () => (await admin.from("learners").select("*").eq("id", i.entity_id).maybeSingle()).data;
  switch (b.action) {
    case "set_learner_grade": {
      const l = await loadLearnerRow();
      if (!l) return c.json({ error: "Learner not found" }, 404);
      const grade = String(b.grade ?? "");
      if (!GRADES.includes(grade as never)) return c.json({ error: "Choose a grade" }, 400);
      await admin.from("learners").update({ grade, updated_at: new Date().toISOString() }).eq("id", l.id);
      await admin.from("learner_enrollments").update({ grade }).eq("learner_id", l.id).eq("status", ACTIVE);
      await audit(c, "learner.updated", "learner", l.id, { fields: ["grade"], from: l.grade ?? null, to: grade, via: "data_quality", issueId: i.id });
      return { before: { grade: l.grade ?? null }, after: { grade }, description: `Grade set to ${grade}` };
    }
    case "place_learner_in_class": {
      const l = await loadLearnerRow();
      const cls = await loadClass(b.classId);
      if (!l || !cls || cls.archived_at || cls.school_id !== l.school_id) return c.json({ error: "Choose a class in the learner's school" }, 400);
      await setLearnerClass(c, l, cls);
      return { before: { classId: l.class_id ?? null }, after: { classId: cls.id, class: cls.name }, description: `Placed in ${cls.name}` };
    }
    case "set_profile_school": {
      const { data: p } = await admin.from("profiles").select("*").eq("id", i.entity_id).maybeSingle();
      if (!p) return c.json({ error: "Account not found" }, 404);
      if (!canManageAccount(actor, p)) return c.json({ error: NO_PERMISSION }, 403);
      const school = await loadSchool(b.schoolId);
      if (!school) return c.json({ error: "Choose a school" }, 400);
      await placeInSchool("profiles", p.id, school, p.role);
      await audit(c, "school.changed", "profile", p.id, { from: p.school_id ?? null, to: school.id, via: "data_quality", issueId: i.id });
      return { before: { schoolId: p.school_id ?? null, county: p.county ?? null }, after: { schoolId: school.id, school: school.name, county: school.county }, description: `Placed in ${school.name}` };
    }
    case "align_county": {
      const expected = String(i.details?.expected ?? "");
      if (!expected) return c.json({ error: "Nothing to align" }, 400);
      if (i.entity_type === "learner") {
        if (!actorCan(c, "learners.manage.all")) return c.json({ error: NO_PERMISSION }, 403);
        const l = await loadLearnerRow();
        if (!l) return c.json({ error: "Learner not found" }, 404);
        await admin.from("learners").update({ county: expected, updated_at: new Date().toISOString() }).eq("id", l.id);
        await audit(c, "learner.updated", "learner", l.id, { fields: ["county"], from: l.county ?? null, to: expected, via: "data_quality", issueId: i.id });
        return { before: { county: l.county ?? null }, after: { county: expected }, description: `County set to ${expected}` };
      }
      if (i.entity_type === "profile") {
        const { data: p } = await admin.from("profiles").select("*").eq("id", i.entity_id).maybeSingle();
        if (!p) return c.json({ error: "Account not found" }, 404);
        if (!actorCan(c, "users.placement.assign") || !canManageAccount(actor, p)) return c.json({ error: NO_PERMISSION }, 403);
        await admin.from("profiles").update({ county: expected }).eq("id", p.id);
        await audit(c, "county.changed", "profile", p.id, { from: p.county ?? null, to: expected, via: "data_quality", issueId: i.id });
        return { before: { county: p.county ?? null }, after: { county: expected }, description: `County set to ${expected}` };
      }
      return c.json({ error: "This record's county can't be corrected here" }, 400);
    }
    case "archive_duplicate_learner": {
      const ids = (i.details?.learnerIds as string[]) ?? [];
      if (!ids.includes(String(b.learnerId))) return c.json({ error: "Choose one of the duplicate records" }, 400);
      const { data: l } = await admin.from("learners").select("*").eq("id", String(b.learnerId)).maybeSingle();
      const keep = ids.find((x) => x !== l?.id);
      const { data: other } = keep ? await admin.from("learners").select("learner_code, user_code").eq("id", keep).maybeSingle() : { data: null };
      if (!l) return c.json({ error: "Learner not found" }, 404);
      const res: Response = await setLearnerStatus(c, l, "INACTIVE", `Duplicate record${other ? ` of ${other.learner_code ?? other.user_code}` : ""} (Data Quality Center)`, today());
      if (res.status >= 400) return res;
      return { before: { learnerId: l.id, status: l.enrollment_status ?? ACTIVE }, after: { learnerId: l.id, status: "INACTIVE" }, description: `Archived ${l.full_name} (${l.learner_code ?? l.user_code}) as a duplicate` };
    }
    case "open_enrollment": {
      const l = await loadLearnerRow();
      if (!l || (l.enrollment_status ?? ACTIVE) !== ACTIVE) return c.json({ error: "Only an active learner can have an open enrollment" }, 409);
      const { data: openRow } = await admin.from("learner_enrollments").select("id").eq("learner_id", l.id).eq("status", ACTIVE).maybeSingle();
      if (openRow) return c.json({ error: "This learner already has an open enrollment" }, 409);
      const cal = await currentCalendar();
      if (!cal.yearId) return c.json({ error: "No current academic year is set" }, 409);
      const id = rid("enr");
      await admin.from("learner_enrollments").insert({
        id, learner_id: l.id, school_id: l.school_id, class_id: l.class_id ?? null, academic_year_id: l.academic_year_id ?? cal.yearId,
        term_id: l.term_id ?? cal.termId, grade: l.grade ?? "", teacher_id: l.current_teacher_id ?? null, status: ACTIVE,
        enrollment_date: l.enrollment_date ?? today(), created_by: actor.id,
      });
      await audit(c, "learner.enrollment_opened", "learner", l.id, { enrollmentId: id, via: "data_quality", issueId: i.id });
      return { before: { enrollment: null }, after: { enrollmentId: id }, description: "Opened an enrollment record from the learner's current school and class" };
    }
    case "close_enrollment": {
      const l = await loadLearnerRow();
      if (!l || (l.enrollment_status ?? ACTIVE) === ACTIVE) return c.json({ error: "This learner is still active" }, 409);
      await closeEnrollment(c, l.id, l.enrollment_status, l.exit_date ?? today(), l.exit_reason ?? "Closed by a data quality correction");
      await audit(c, "learner.enrollment_closed", "learner", l.id, { status: l.enrollment_status, via: "data_quality", issueId: i.id });
      return { before: { enrollment: "ACTIVE" }, after: { enrollment: l.enrollment_status }, description: `Closed the open enrollment as ${l.enrollment_status}` };
    }
    case "end_class_assignment": {
      const { data: ct } = await admin.from("class_teachers").select("*").eq("id", i.entity_id).maybeSingle();
      if (!ct || ct.ended_at) return c.json({ error: "That assignment has already ended" }, 409);
      const now = new Date().toISOString();
      await admin.from("class_teachers").update({ ended_at: now, ended_by: actor.id }).eq("id", ct.id);
      if (ct.role === "class_teacher") {
        await admin.from("learners").update({ current_teacher_id: null }).eq("class_id", ct.class_id).eq("current_teacher_id", ct.teacher_id);
      }
      await audit(c, "class.teacher_removed", "class", ct.class_id, { teacherId: ct.teacher_id, via: "data_quality", issueId: i.id });
      return { before: { ended: false }, after: { ended: true, endedAt: now }, description: "Ended the class assignment" };
    }
    case "kobo_accept":
    case "kobo_exclude": {
      if (note.length < 3) return c.json({ error: "Say why, for the record" }, 400);
      const { data: r } = await admin.from("kobo_records").select("id, status, review, kobo_form_id, kobo_id").eq("id", i.entity_id).maybeSingle();
      if (!r || r.status === "removed") return c.json({ error: "Submission not found" }, 404);
      const decision = b.action === "kobo_accept" ? "accepted" : "excluded";
      await admin.from("kobo_records").update({ review: decision, review_note: note, reviewed_by: actor.id, reviewed_at: new Date().toISOString() }).eq("id", r.id);
      await audit(c, `kobo.record_${decision}`, "kobo_record", r.id, { formId: r.kobo_form_id, koboId: r.kobo_id, status: r.status, note, via: "data_quality", issueId: i.id });
      return { before: { review: r.review ?? null }, after: { review: decision }, description: decision === "accepted" ? "Accepted in the Kobo data pipeline" : "Excluded in the Kobo data pipeline" };
    }
  }
  return c.json({ error: "That correction isn't available" }, 400);
}

// deno-lint-ignore no-explicit-any
async function dqIssueDetail(c: any, id: string) {
  const { data: i } = await admin.from("dq_issues").select("*").eq("id", id).maybeSingle();
  if (!i || !inScope(c, i.school_id, i.county)) return null;
  const { data: events } = await admin.from("dq_issue_events").select("*").eq("issue_id", id);
  const sorted = (events ?? []).sort((a: Record<string, any>, b: Record<string, any>) => String(a.created_at).localeCompare(String(b.created_at)) || Number(a.id) - Number(b.id));
  const [names, schools] = await Promise.all([
    dqNames([i.resolved_by, i.status_changed_by, ...sorted.map((e: Record<string, any>) => e.actor_id)]), schoolNameMap(),
  ]);
  return {
    issue: mapDqIssue(i, names, schools),
    details: i.details ?? {},
    events: sorted.map((e: Record<string, any>) => ({
      at: e.created_at, action: e.action, from: e.from_status ?? null, to: e.to_status ?? null,
      by: e.actor_id ? names.get(e.actor_id) ?? "—" : "Scan", note: e.note ?? null, details: e.details ?? {},
    })),
    fixes: await dqFixesFor(c, i),
    moves: actorCan(c, "data_quality.manage") ? DQ_STATUS_MOVES[i.status as DqStatus] : [],
  };
}

app.get("/data-quality/issues/:id", requirePermission("data_quality.view"), async (c) => {
  const d = await dqIssueDetail(c, c.req.param("id"));
  return d ? c.json(d) : c.json({ error: "Issue not found" }, 404);
});

/** One status change, with its event and audit entry. */
// deno-lint-ignore no-explicit-any
async function moveDqIssue(c: any, i: Record<string, any>, to: DqStatus, note: string): Promise<string | null> {
  if (!DQ_STATUS_MOVES[i.status as DqStatus]?.includes(to)) return `An issue that is ${i.status} can't become ${to}`;
  if ((to === "RESOLVED" || to === "IGNORED") && note.length < 3) return "Say why, for the record";
  const now = new Date().toISOString();
  const actorId = c.get("actor").id;
  const patch: Record<string, unknown> = { status: to, status_changed_at: now, status_changed_by: actorId, note: note || i.note || null };
  if (to === "RESOLVED") Object.assign(patch, { resolved_at: now, resolved_by: actorId, resolution: note });
  if (to === "OPEN") Object.assign(patch, { resolved_at: null, resolved_by: null, resolution: null });
  const { error } = await admin.from("dq_issues").update(patch).eq("id", i.id);
  if (error) return error.message;
  await admin.from("dq_issue_events").insert({ issue_id: i.id, action: "status_changed", from_status: i.status, to_status: to, actor_id: actorId, note: note || null });
  await audit(c, "dq.status_changed", "dq_issue", i.id, { type: i.type, from: i.status, to, note: note || undefined });
  return null;
}

app.patch("/data-quality/issues/:id", requirePermission("data_quality.manage"), async (c) => {
  const { data: i } = await admin.from("dq_issues").select("*").eq("id", c.req.param("id")).maybeSingle();
  if (!i || !inScope(c, i.school_id, i.county)) return c.json({ error: "Issue not found" }, 404);
  const b = await c.req.json().catch(() => ({}));
  const to = String(b.status ?? "") as DqStatus;
  if (!DQ_STATUSES.includes(to)) return c.json({ error: "Status must be OPEN, UNDER_REVIEW, RESOLVED or IGNORED" }, 400);
  const err = await moveDqIssue(c, i, to, String(b.note ?? "").trim().slice(0, 1000));
  if (err) return c.json({ error: err }, 400);
  return c.json(await dqIssueDetail(c, i.id));
});

app.post("/data-quality/issues/bulk", requirePermission("data_quality.manage"), async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const ids = Array.isArray(b.ids) ? [...new Set(b.ids.map(String))].slice(0, 500) as string[] : [];
  const to = String(b.status ?? "") as DqStatus;
  if (!ids.length) return c.json({ error: "Pick some issues" }, 400);
  if (!DQ_STATUSES.includes(to)) return c.json({ error: "Status must be OPEN, UNDER_REVIEW, RESOLVED or IGNORED" }, 400);
  const note = String(b.note ?? "").trim().slice(0, 1000);
  const rows = (await selectIn("dq_issues", "id", ids)).filter((i) => inScope(c, i.school_id, i.county));
  let changed = 0;
  const skipped: string[] = [];
  for (const i of rows) {
    const err = await moveDqIssue(c, i, to, note);
    if (err) skipped.push(`${i.summary}: ${err}`); else changed++;
  }
  return c.json({ changed, skipped });
});

app.post("/data-quality/issues/:id/fix", requirePermission("data_quality.manage"), async (c) => {
  const { data: i } = await admin.from("dq_issues").select("*").eq("id", c.req.param("id")).maybeSingle();
  if (!i || !inScope(c, i.school_id, i.county)) return c.json({ error: "Issue not found" }, 404);
  const b = await c.req.json().catch(() => ({}));
  const offered = await dqFixesFor(c, i);
  if (!offered.some((f) => f.action === b.action)) return c.json({ error: "That correction isn't available for this issue (or to you)" }, 403);
  const note = String(b.note ?? "").trim().slice(0, 1000);
  const res = await applyDqFix(c, i, b, note);
  if (res instanceof Response) return res;
  const now = new Date().toISOString();
  const actorId = c.get("actor").id;
  const resolution = `Corrected: ${res.description}${note ? ` — ${note}` : ""}`;
  await admin.from("dq_issues").update({
    status: "RESOLVED", resolved_at: now, resolved_by: actorId, resolution, note: note || i.note || null,
    status_changed_at: now, status_changed_by: actorId,
  }).eq("id", i.id);
  await admin.from("dq_issue_events").insert({
    issue_id: i.id, action: "corrected", from_status: i.status, to_status: "RESOLVED", actor_id: actorId, note: note || null,
    details: { correction: b.action, before: res.before, after: res.after, description: res.description },
  });
  await audit(c, "dq.corrected", "dq_issue", i.id, { type: i.type, correction: b.action, entity: `${i.entity_type}:${i.entity_id}`, before: res.before, after: res.after });
  // Check the data again: if the problem is still there, the issue reopens.
  try { await runDqScan(actorId, "correction"); } catch (e) { console.error("dq scan after correction:", (e as Error).message); }
  return c.json(await dqIssueDetail(c, i.id));
});

// ---------------------------------------------------------------- reports (export)
/* The Reports export: a report is built from the same rows the screens
   use, limited by the same scope rules — so an export never holds more
   than its person could see in the portal. A school head's exports are
   their school, whatever filter is sent; a teacher's are their classes; a
   field officer's are their own visits. Every export is in the audit log
   (who, which report, filters, how many rows, which format). The browser
   writes the file (Excel, CSV or PDF) from what comes back. */

type RF = {
  county: string | null; school: string | null; from: string | null; to: string | null;
  period: string | null; programme: string | null; status: string | null;
};
type RCtx = { c: any; f: RF; actor: Actor; schools: Map<string, Record<string, any>>; inPlace: (schoolId: unknown) => boolean; now: Date };

function reportFilters(c: any): RF {
  const q = (k: string) => String(c.req.query(k) ?? "").trim();
  const date = (k: string) => (DATE_RE.test(q(k)) ? q(k) : null);
  return {
    county: q("county") || null, school: q("school") || null, from: date("from"), to: date("to"),
    period: q("period") || null, programme: q("programme") || null, status: q("status") || null,
  };
}
const rDay = (v: unknown) => String(v ?? "").slice(0, 10);
const inDates = (f: RF, v: unknown) => { const d = rDay(v); return (!f.from || (!!d && d >= f.from)) && (!f.to || (!!d && d <= f.to)); };
const pct1 = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
const nameMap = (rows: Record<string, any>[] | null | undefined, field = "full_name") => new Map((rows ?? []).map((r) => [r.id, r[field]]));
/** Registers read county, then school, then class, then name. */
const byPlace = (a: Record<string, any>, b: Record<string, any>) =>
  ["county", "school", "class", "name"].reduce((d, k) => d || String(a[k] ?? "").localeCompare(String(b[k] ?? ""), undefined, { numeric: true }), 0);

async function reportContext(c: any, id: string): Promise<RCtx> {
  const f = reportFilters(c);
  const actor = c.get("actor") as Actor;
  const { data } = await selectAll(() => admin.from("schools").select("id, name, code, county").order("id"));
  // Only schools in the caller's area exist, as far as a report is concerned.
  const schools = new Map((data ?? []).filter((s) => inPlaceScope(actor.scope, s.id)).map((s) => [s.id as string, s]));
  // Below the all-schools level the place is always their own school, whatever was asked for.
  const limited = scopeNote(c, id);
  if (limited === "Your school" || limited === "Your classes") {
    const own = actor.schoolId ? schools.get(actor.schoolId) : null;
    f.school = own?.name ?? "__none__";
    f.county = own?.county ?? null;
  }
  const inPlace = (schoolId: unknown) => {
    if (!inPlaceScope(actor.scope, schoolId)) return false;
    const s = schools.get(String(schoolId ?? ""));
    if (!f.county && !f.school) return true;
    return !!s && (!f.county || s.county === f.county) && (!f.school || s.name === f.school);
  };
  return { c, f, actor, schools, inPlace, now: new Date() };
}

// ---- 1. learner register
async function reportLearners(x: RCtx): Promise<Section[]> {
  const scope = await learnerScope(x.c);
  const [{ data: learners }, { data: classes }] = await Promise.all([
    selectAll(() => admin.from("learners").select("id, full_name, gender, grade, class_id, school_id, school, county, learner_code, user_code, " +
      "teacher_id, current_teacher_id, enrollment_status, enrollment_date, exit_date, exit_reason").order("full_name").order("id")),
    selectAll(() => admin.from("classes").select("id, name").order("id")),
  ]);
  const cls = nameMap(classes, "name");
  const status = x.f.status ?? "active";
  const rows = (learners ?? [])
    .filter((l) => inLearnerScope(scope, l) && x.inPlace(l.school_id) &&
      (status === "all" || (status === "archived" ? l.enrollment_status !== ACTIVE : (l.enrollment_status ?? ACTIVE) === ACTIVE)))
    .map((l) => ({
      code: l.learner_code ?? l.user_code ?? "", name: l.full_name, gender: GENDER_TEXT[l.gender] ?? "", grade: l.grade ?? "",
      class: l.class_id ? cls.get(l.class_id) ?? "" : "", school: x.schools.get(l.school_id)?.name ?? l.school ?? "",
      county: x.schools.get(l.school_id)?.county ?? l.county ?? "", status: STATUS_TEXT[l.enrollment_status ?? ACTIVE] ?? l.enrollment_status,
      enrolled: l.enrollment_date ?? null, left: l.exit_date ?? null, reason: l.exit_reason ?? "",
    })).sort(byPlace);
  return [{
    title: "Learners",
    columns: [
      { key: "code", label: "Learner code" }, { key: "name", label: "Full name" }, { key: "gender", label: "Gender" },
      { key: "grade", label: "Grade" }, { key: "class", label: "Class" }, { key: "school", label: "School" }, { key: "county", label: "County" },
      { key: "status", label: "Status" }, { key: "enrolled", label: "Enrolled", type: "date" }, { key: "left", label: "Left", type: "date" },
      { key: "reason", label: "Reason left" },
    ],
    rows,
  }];
}

// ---- 2. teacher register (teachers and school heads)
async function reportTeachers(x: RCtx): Promise<Section[]> {
  const withEmail = actorCan(x.c, "users.view");
  const [{ data: staff }, { data: ct }, { data: classes }, { data: attendance }] = await Promise.all([
    selectAll(() => admin.from("profiles").select("id, role, full_name, email, gender, teacher_type, school, school_id, county, status, user_code")
      .in("role", ["teacher", "school_leader"]).order("full_name").order("id")),
    selectAll(() => admin.from("class_teachers").select("class_id, teacher_id, ended_at").order("class_id")),
    selectAll(() => admin.from("classes").select("id, name, archived_at").order("id")),
    selectAll(() => admin.from("training_attendance").select("training_id, teacher_id, attended").order("training_id")),
  ]);
  const cls = nameMap(classes, "name");
  const status = x.f.status ?? "active";
  const people = (staff ?? []).filter((p) => x.inPlace(p.school_id) && (status === "all" || (p.status ?? "active") === "active"));
  const row = (p: Record<string, any>) => ({
    code: p.user_code ?? "", name: p.full_name, ...(withEmail ? { email: p.email ?? "" } : {}), gender: GENDER_TEXT[p.gender] ?? "",
    type: p.role === "teacher" ? p.teacher_type ?? "" : "", school: x.schools.get(p.school_id)?.name ?? p.school ?? "",
    county: x.schools.get(p.school_id)?.county ?? p.county ?? "", status: STATUS_TEXT[p.status ?? "active"] ?? p.status,
    classes: (ct ?? []).filter((t) => t.teacher_id === p.id && !t.ended_at).map((t) => cls.get(t.class_id)).filter(Boolean).join(", "),
    trainings: (attendance ?? []).filter((a) => a.teacher_id === p.id && a.attended !== false).length,
  });
  const columns: Column[] = [
    { key: "code", label: "Staff code" }, { key: "name", label: "Full name" }, ...(withEmail ? [{ key: "email", label: "Email" }] : []),
    { key: "gender", label: "Gender" }, { key: "type", label: "Employment type" }, { key: "school", label: "School" }, { key: "county", label: "County" },
    { key: "status", label: "Status" }, { key: "classes", label: "Classes taught" }, { key: "trainings", label: "Trainings attended", type: "number" },
  ];
  return [
    { title: "Teachers", columns, rows: people.filter((p) => p.role === "teacher").map(row).sort(byPlace) },
    { title: "School heads", columns: columns.filter((c) => !["type", "classes"].includes(c.key)), rows: people.filter((p) => p.role === "school_leader").map(row).sort(byPlace) },
  ];
}

// ---- 3. school register
async function reportSchools(x: RCtx): Promise<Section[]> {
  const [{ data: learners }, { data: staff }, { data: classes }, { data: visits }, { data: kobo }] = await Promise.all([
    selectAll(() => admin.from("learners").select("id, school_id, enrollment_status").order("id")),
    selectAll(() => admin.from("profiles").select("id, role, status, school_id").order("id")),
    selectAll(() => admin.from("classes").select("id, school_id, archived_at").order("id")),
    selectAll(() => admin.from("field_reports").select("id, school_id, created_at").order("id")),
    selectAll(() => admin.from("kobo_records").select("id, school_id, status, review, submitted_at").order("id")),
  ]);
  const rows = [...x.schools.values()].filter((s) => x.inPlace(s.id)).sort((a, b) => String(a.county).localeCompare(String(b.county)) || String(a.name).localeCompare(String(b.name))).map((s) => {
    const v = (visits ?? []).filter((r) => r.school_id === s.id && inDates(x.f, r.created_at));
    return {
      code: s.code, name: s.name, county: s.county,
      learners: (learners ?? []).filter((l) => l.school_id === s.id && (l.enrollment_status ?? ACTIVE) === ACTIVE).length,
      teachers: (staff ?? []).filter((p) => p.school_id === s.id && p.role === "teacher" && (p.status ?? "active") === "active").length,
      heads: (staff ?? []).filter((p) => p.school_id === s.id && p.role === "school_leader" && (p.status ?? "active") === "active").length,
      classes: (classes ?? []).filter((k) => k.school_id === s.id && !k.archived_at).length,
      visits: v.length, lastVisit: v.map((r) => r.created_at).sort().at(-1) ?? null,
      kobo: (kobo ?? []).filter((r) => r.school_id === s.id && countsOnDashboards(r.status, r.review) && inDates(x.f, r.submitted_at)).length,
    };
  });
  return [{
    title: "Schools",
    columns: [
      { key: "code", label: "School code" }, { key: "name", label: "School" }, { key: "county", label: "County" },
      { key: "learners", label: "Learners", type: "number" }, { key: "teachers", label: "Teachers", type: "number" },
      { key: "heads", label: "School heads", type: "number" }, { key: "classes", label: "Classes", type: "number" },
      { key: "visits", label: "Field visits", type: "number" }, { key: "lastVisit", label: "Last visit", type: "date" },
      { key: "kobo", label: "Kobo submissions (counted)", type: "number" },
    ],
    rows,
  }];
}

// ---- 4 & 5. assignments and assessment — the same scope as the Results screens
async function scopedWork(x: RCtx) {
  const scope = await assignmentScope(x.c);
  if (scope.kind === "none") return null;
  const work = await loadWork({ schoolId: scope.kind === "all" ? null : scope.schoolId, classIds: scope.kind === "teacher" ? scope.classIds : null });
  const inPeriod = (a: Record<string, any>) => !x.f.period || a.term_id === x.f.period || a.academic_year_id === x.f.period;
  const assignments = work.assignments.filter((a) => inAssignmentScope(scope, a) && x.inPlace(a.school_id) && inPeriod(a) &&
    (!x.f.from && !x.f.to ? true : inDates(x.f, a.due_at ?? a.published_at)));
  const ids = new Set(assignments.map((a) => a.id as string));
  return { assignments, pairs: work.pairs.filter((p) => ids.has(p.a.id)), submissions: work.submissions.filter((s) => ids.has(s.assignment_id)), bands: await loadBands() };
}

async function reportAssignments(x: RCtx): Promise<Section[]> {
  const w = await scopedWork(x);
  const columns: Column[] = [
    { key: "title", label: "Assignment" }, { key: "subject", label: "Subject" }, { key: "class", label: "Class" }, { key: "school", label: "School" },
    { key: "county", label: "County" }, { key: "teacher", label: "Set by" }, { key: "term", label: "Term" }, { key: "status", label: "Status" },
    { key: "due", label: "Due", type: "datetime" }, { key: "expected", label: "Learners set", type: "number" }, { key: "handedIn", label: "Handed in", type: "number" },
    { key: "late", label: "Late", type: "number" }, { key: "missing", label: "Missing", type: "number" }, { key: "completion", label: "Completion %", type: "percent" },
    { key: "marked", label: "Marked", type: "number" }, { key: "average", label: "Average mark %", type: "percent" },
  ];
  if (!w) return [{ title: "Assignments", columns, rows: [] }];
  const names = await assignmentNames(w.assignments);
  const groups = new Map(groupResults(w.pairs, "assignment", w.bands, x.now).map((g) => [g.key, g]));
  const rows = w.assignments.sort((a, b) => String(a.due_at ?? "").localeCompare(String(b.due_at ?? ""))).map((a) => {
    const g = groups.get(a.id);
    return {
      title: a.title, subject: names.subjects[a.subject_id] ?? a.subject_id, class: names.classes[a.class_id] ?? "", school: x.schools.get(a.school_id)?.name ?? "",
      county: x.schools.get(a.school_id)?.county ?? "", teacher: names.teachers[a.created_by] ?? "", term: termLabel(a.term_id) ?? "",
      status: a.status === "published" ? "Open" : a.status === "closed" ? "Closed" : a.status,
      due: a.due_at ?? null, expected: g?.completion.assigned ?? 0, handedIn: g?.completion.submitted ?? 0, late: g?.completion.late ?? 0,
      missing: g?.completion.missing ?? 0, completion: g?.completion.rate ?? null, marked: g?.achievement.marked ?? 0, average: g?.achievement.averagePercent ?? null,
    };
  });
  return [{ title: "Assignments", columns, rows }];
}

async function reportAssessment(x: RCtx): Promise<Section[]> {
  const w = await scopedWork(x);
  const groupCols: Column[] = [
    { key: "label", label: "" }, { key: "assigned", label: "Work set", type: "number" }, { key: "completion", label: "Completion %", type: "percent" },
    { key: "marked", label: "Marked", type: "number" }, { key: "average", label: "Average mark %", type: "percent" }, { key: "band", label: "Band" },
  ];
  const workCols: Column[] = [
    { key: "learner", label: "Learner" }, { key: "code", label: "Learner code" }, { key: "class", label: "Class" }, { key: "school", label: "School" },
    { key: "subject", label: "Subject" }, { key: "assignment", label: "Assignment" }, { key: "marks", label: "Marks", type: "number" },
    { key: "max", label: "Out of", type: "number" }, { key: "percent", label: "%", type: "percent" }, { key: "band", label: "Band" },
    { key: "late", label: "Late" }, { key: "markedBy", label: "Marked by" }, { key: "markedAt", label: "Marked", type: "date" },
  ];
  if (!w) return [{ title: "Marked work", columns: workCols, rows: [] }];
  const names = await assignmentNames(w.assignments);
  const by = (dim: ResultDimension, label: (k: string) => string, title: string): Section => ({
    title, columns: groupCols.map((col) => (col.key === "label" ? { ...col, label: title.replace(/^By /, "").replace(/^\w/, (m) => m.toUpperCase()) } : col)),
    rows: groupResults(w.pairs, dim, w.bands, x.now).map((g) => ({
      label: label(g.key), assigned: g.completion.assigned, completion: g.completion.rate, marked: g.achievement.marked,
      average: g.achievement.averagePercent, band: g.achievement.band ?? "",
    })).sort((a, b) => String(a.label).localeCompare(String(b.label), undefined, { numeric: true })),
  });
  const marked = w.submissions.filter((s) => s.status === "marked");
  const [learners, markers] = await Promise.all([
    marked.length ? selectIn("learners", "id", [...new Set(marked.map((s) => s.learner_id as string))], "id, full_name, learner_code, user_code") : [],
    marked.length ? selectIn("profiles", "id", [...new Set(marked.map((s) => s.marked_by as string).filter(Boolean))], "id, full_name") : [],
  ]);
  const lName = new Map(learners.map((l) => [l.id, l]));
  const mName = nameMap(markers);
  const asg = new Map(w.assignments.map((a) => [a.id, a]));
  return [
    by("subject", (k) => names.subjects[k] ?? k, "By subject"),
    by("class", (k) => names.classes[k] ?? k, "By class"),
    {
      title: "Marked work", columns: workCols,
      rows: marked.map((s) => {
        const a = asg.get(s.assignment_id)!;
        const l = lName.get(s.learner_id);
        return {
          learner: l?.full_name ?? "", code: l?.learner_code ?? l?.user_code ?? "", class: names.classes[a.class_id] ?? "", school: x.schools.get(a.school_id)?.name ?? "",
          subject: names.subjects[a.subject_id] ?? a.subject_id, assignment: a.title, marks: s.marks == null ? null : Number(s.marks),
          max: s.max_marks == null ? null : Number(s.max_marks), percent: s.percentage == null ? null : Number(s.percentage), band: s.band ?? "",
          late: s.is_late ? "Late" : "", markedBy: s.auto_marked ? "Marked automatically" : mName.get(s.marked_by) ?? "", markedAt: s.marked_at ?? null,
        };
      }).sort((a, b) => String(a.learner).localeCompare(String(b.learner)) || String(a.assignment).localeCompare(String(b.assignment))),
    },
  ];
}

// ---- 6. field visits
async function reportVisits(x: RCtx): Promise<Section[]> {
  const all = actorCan(x.c, "field_reports.view.all");
  const [{ data: visits }, { data: officers }, { data: forms }] = await Promise.all([
    selectAll(() => {
      let q = admin.from("field_reports").select("*").order("created_at", { ascending: false }).order("id");
      if (!all) q = q.eq("officer_id", x.actor.id);
      return q;
    }),
    selectAll(() => admin.from("profiles").select("id, full_name").eq("role", "field_officer").order("id")),
    admin.from("forms").select("id, title, kind, county, visit_type, archived_at, created_at").not("visit_type", "is", null),
  ]);
  const place = (r: Record<string, any>) => !inScope(x.c, r.school_id, r.county) ? false : !x.f.county && !x.f.school ? true
    : r.school_id ? x.inPlace(r.school_id) : (!x.f.county || r.county === x.f.county) && (!x.f.school || r.school === x.f.school);
  const mine = (visits ?? []).filter((r) => place(r) && inDates(x.f, r.created_at));
  const responses = mine.length ? await selectIn("responses", "visit_id", mine.map((r) => r.id as string), "id, form_id, visit_id") : [];
  const formTitle = nameMap(forms ?? [], "title");
  const officer = nameMap(officers);
  return [{
    title: "Field visits",
    columns: [
      { key: "date", label: "Date", type: "datetime" }, { key: "officer", label: "Field officer" }, { key: "school", label: "School" },
      { key: "code", label: "School code" }, { key: "county", label: "County" }, { key: "type", label: "Visit type" },
      { key: "filled", label: "Forms filled" }, { key: "missing", label: "Forms still to fill" },
    ],
    rows: mine.map((r) => ({
      date: r.created_at, officer: officer.get(r.officer_id) ?? "", school: x.schools.get(r.school_id)?.name ?? r.school ?? "",
      code: x.schools.get(r.school_id)?.code ?? "", county: r.county ?? "", type: r.visit_type,
      filled: responses.filter((p) => p.visit_id === r.id).map((p) => formTitle.get(p.form_id) ?? "Form").join(", "),
      missing: missingVisitForms(r, forms ?? [], responses).map((f) => f.title).join(", "),
    })),
  }];
}

// ---- 7. Kobo
async function reportKobo(x: RCtx): Promise<Section[]> {
  const [{ data: forms }, { data: records }, { data: officers }] = await Promise.all([
    selectAll(() => admin.from("kobo_forms").select("id, title, active, synced_at, last_sync_error").order("id")),
    selectAll(() => admin.from("kobo_records").select("id, kobo_form_id, kobo_id, submitted_at, observed_on, school_id, school_value, county, officer_id, status, review").order("id")),
    selectAll(() => admin.from("profiles").select("id, full_name").order("id")),
  ]);
  const recs = (records ?? []).filter((r) => r.status !== "removed" && inScope(x.c, r.school_id, r.county) &&
    (!x.f.county && !x.f.school ? true : x.inPlace(r.school_id)) && inDates(x.f, r.submitted_at));
  const issues = recs.length ? await selectIn("kobo_record_issues", "record_id", recs.map((r) => r.id as string), "record_id, severity, message") : [];
  const survey = nameMap(forms, "title");
  const officer = nameMap(officers);
  const needsReview = (r: Record<string, any>) => (r.status === "invalid" || r.status === "duplicate") && !r.review;
  return [
    {
      title: "Surveys",
      columns: [
        { key: "title", label: "Survey" }, { key: "active", label: "Attached" }, { key: "synced", label: "Last sync", type: "datetime" },
        { key: "error", label: "Last sync problem" }, { key: "received", label: "Received", type: "number" }, { key: "counted", label: "Counted", type: "number" },
        { key: "invalid", label: "Failing checks", type: "number" }, { key: "duplicate", label: "Duplicates", type: "number" },
        { key: "rejected", label: "Rejected in Kobo", type: "number" }, { key: "review", label: "Need review", type: "number" },
      ],
      rows: (forms ?? []).map((f) => {
        const mine = recs.filter((r) => r.kobo_form_id === f.id);
        return {
          title: f.title, active: f.active === false ? "No" : "Yes", synced: f.synced_at ?? null, error: f.last_sync_error ?? "",
          received: mine.length, counted: mine.filter((r) => countsOnDashboards(r.status, r.review)).length,
          invalid: mine.filter((r) => r.status === "invalid").length, duplicate: mine.filter((r) => r.status === "duplicate").length,
          rejected: mine.filter((r) => r.status === "rejected").length, review: mine.filter(needsReview).length,
        };
      }),
    },
    {
      title: "Submissions",
      columns: [
        { key: "survey", label: "Survey" }, { key: "koboId", label: "Kobo ID", type: "number" }, { key: "submitted", label: "Submitted", type: "datetime" },
        { key: "observed", label: "Visit date", type: "date" }, { key: "school", label: "School" }, { key: "county", label: "County" },
        { key: "officer", label: "Field officer" }, { key: "status", label: "Status" }, { key: "review", label: "Review" }, { key: "issues", label: "Issues" },
      ],
      rows: recs.sort((a, b) => String(b.submitted_at ?? "").localeCompare(String(a.submitted_at ?? ""))).map((r) => ({
        survey: survey.get(r.kobo_form_id) ?? "", koboId: r.kobo_id == null ? null : Number(r.kobo_id), submitted: r.submitted_at ?? null, observed: r.observed_on ?? null,
        school: x.schools.get(r.school_id)?.name ?? (r.school_value ? `${r.school_value} (not matched)` : ""), county: r.county ?? "",
        officer: officer.get(r.officer_id) ?? "", status: KOBO_STATUS_TEXT[r.status] ?? r.status,
        review: r.review === "accepted" ? "Accepted" : r.review === "excluded" ? "Excluded" : needsReview(r) ? "Needs review" : "",
        issues: issues.filter((i) => i.record_id === r.id).map((i) => i.message).join("; "),
      })),
    },
  ];
}

const KOBO_STATUS_TEXT: Record<string, string> = { valid: "Passed checks", invalid: "Failing checks", duplicate: "Duplicate", rejected: "Rejected in Kobo" };

// ---- 8. library usage
async function reportLibrary(x: RCtx): Promise<Section[]> {
  const [{ data: items }, { data: interactions }] = await Promise.all([
    selectAll(() => admin.from("library_items").select("id, title, subject, type, audience, published").order("id")),
    selectAll(() => admin.from("library_interactions").select("id, library_item_id, actor_kind, actor_id, school, started_at, completed_at, duration_seconds").order("id")),
  ]);
  const placeNames = new Set([...x.schools.values()].filter((s) => x.inPlace(s.id)).map((s) => s.name));
  const area = await schoolNamesInScope(x.c);
  const rows = (interactions ?? []).filter((i) => inDates(x.f, i.started_at) && (!area || area.has(i.school)) &&
    (!x.f.county && !x.f.school ? true : placeNames.has(i.school)));
  const hours = (rs: Record<string, any>[]) => Math.round(rs.reduce((t, i) => t + (Number(i.duration_seconds) || 0), 0) / 360) / 10;
  const shelf = (a: unknown) => (a === "staff" ? "Teacher Resources" : a === "school_leader" ? "For School Head" : "Digital Library");
  const bySchool = new Map<string, Record<string, any>[]>();
  for (const i of rows) { const k = i.school || "(no school)"; if (!bySchool.has(k)) bySchool.set(k, []); bySchool.get(k)!.push(i); }
  return [
    {
      title: "By resource",
      columns: [
        { key: "title", label: "Resource" }, { key: "shelf", label: "Shelf" }, { key: "subject", label: "Subject" }, { key: "type", label: "Type" },
        { key: "opens", label: "Opens", type: "number" }, { key: "readers", label: "Readers", type: "number" },
        { key: "learnerOpens", label: "Opens by learners", type: "number" }, { key: "staffOpens", label: "Opens by staff", type: "number" },
        { key: "hours", label: "Hours", type: "number" }, { key: "finished", label: "Read to the end", type: "number" },
      ],
      rows: (items ?? []).filter((it) => it.published).map((it) => {
        const rs = rows.filter((i) => i.library_item_id === it.id);
        return {
          title: it.title, shelf: shelf(it.audience), subject: it.subject ?? "", type: it.type ?? "", opens: rs.length,
          readers: new Set(rs.map((i) => i.actor_id)).size, learnerOpens: rs.filter((i) => i.actor_kind === "learner").length,
          staffOpens: rs.filter((i) => i.actor_kind !== "learner").length, hours: hours(rs), finished: rs.filter((i) => i.completed_at).length,
        };
      }).sort((a, b) => b.opens - a.opens || String(a.title).localeCompare(String(b.title))),
    },
    {
      title: "By school",
      columns: [{ key: "school", label: "School" }, { key: "opens", label: "Opens", type: "number" }, { key: "readers", label: "Readers", type: "number" }, { key: "hours", label: "Hours", type: "number" }],
      rows: [...bySchool.entries()].map(([school, rs]) => ({ school, opens: rs.length, readers: new Set(rs.map((i) => i.actor_id)).size, hours: hours(rs) }))
        .sort((a, b) => b.opens - a.opens),
    },
  ];
}

// ---- 9. M&E indicators
async function reportMel(x: RCtx): Promise<{ sections: Section[]; note: string }> {
  const cal = await melCalendar();
  const terms = cal.periods.filter((p) => /-T\d$/.test(p.id));
  const period = x.f.period || (terms.find((p) => p.current) ?? terms.at(-1))?.id || "";
  const range = periodRange(period, cal.terms, cal.years);
  const scopeRow = x.f.school ? (await admin.from("schools").select("id").eq("name", x.f.school).maybeSingle()).data : null;
  const scope = x.f.school ? (scopeRow ? await melScope("school", scopeRow.id) : null) : x.f.county ? await melScope("county", x.f.county) : await melScope("programme", "");
  const columns: Column[] = [
    { key: "programme", label: "Programme" }, { key: "outcome", label: "Outcome" }, { key: "code", label: "Code" }, { key: "indicator", label: "Indicator" },
    { key: "unit", label: "Unit" }, { key: "baseline", label: "Baseline", type: "number" }, { key: "target", label: "Target", type: "number" },
    { key: "actual", label: "Actual", type: "number" }, { key: "achievement", label: "Achievement %", type: "percent" }, { key: "status", label: "Status" },
    { key: "source", label: "Value" }, { key: "evidence", label: "Evidence" },
  ];
  if (!range || !scope) return { sections: [{ title: "Indicators", columns, rows: [] }], note: "Choose a term or school year, and a county or school in the portal." };
  if (!melScopeAllowed(x.c, scope)) return { sections: [{ title: "Indicators", columns, rows: [] }], note: OUTSIDE_AREA };
  const { data: progs } = await admin.from("me_programmes").select("id, name, status");
  const chosen = (progs ?? []).filter((p) => (x.f.programme ? p.id === x.f.programme : p.status === "active"));
  const STATUS: Record<string, string> = { met: "Met", close: "Close", not_met: "Not met", no_data: "No data" };
  const SOURCE: Record<string, string> = { live: "Live from the portal", verified: "Recorded, verified", recorded: "Recorded, not yet verified" };
  const rows: Record<string, unknown>[] = [];
  for (const p of chosen) {
    const res = await melResults(p.id, period, scope);
    if ("error" in res) continue;
    for (const o of res.outcomes) {
      for (const i of o.indicators as Record<string, any>[]) {
        rows.push({
          programme: p.name, outcome: `${o.code ? `${o.code} ` : ""}${o.title}`, code: i.code ?? "", indicator: i.name, unit: i.unit,
          baseline: i.baselineValue, target: i.target?.value ?? null, actual: i.value, achievement: i.achievement?.percent ?? null,
          status: STATUS[i.achievement?.status] ?? "", source: SOURCE[i.valueSource] ?? (i.valueSource === "none" ? "" : i.valueSource),
          evidence: (i.recorded?.evidence ?? []).map((e: Record<string, any>) => e.title).join("; "),
        });
      }
    }
  }
  return { sections: [{ title: "Indicators", columns, rows }], note: `${range.label} · ${scope.label}` };
}

// ---- 10. term report
async function reportTerm(x: RCtx): Promise<{ sections: Section[]; note: string }> {
  const cal = await melCalendar();
  const terms = cal.periods.filter((p) => /-T\d$/.test(p.id));
  const period = x.f.period || (terms.find((p) => p.current) ?? terms.at(-1))?.id || "";
  const range = periodRange(period, cal.terms, cal.years);
  if (!range) return { sections: [], note: "Choose a term." };
  const d = buildImpact(narrowInput(await loadImpactInput(), x.actor.scope), { county: x.f.county, school: x.f.school, from: range.from, to: range.to });
  const E = d.executive;
  const kv = (measure: string, value: unknown) => ({ measure, value });
  const summary = [
    kv("Schools", E.schools), kv("Learners", E.learners), kv("Teachers", E.teachers),
    kv("Active users in the term", E.activeUsers.total), kv("Work handed in (completion %)", E.completion.rate),
    kv("Average mark on marked work %", E.averageMark), kv("Library use (hours)", E.libraryHours),
    kv("Field visits", d.fieldOps.visits.visits), kv("Schools visited", d.fieldOps.visits.schools.visited),
    kv("Kobo submissions counted", d.fieldOps.kobo.counted), kv("Teachers trained", d.teachers.training.teachersTrained),
    kv("Learners improving term to term %", d.learning.progress.learners.improvedShare),
  ];
  return {
    note: `${range.label} (${range.from} to ${range.to})`,
    sections: [
      { title: "Summary", columns: [{ key: "measure", label: "Measure" }, { key: "value", label: "Value", type: "number" }], rows: summary },
      {
        title: "By school",
        columns: [
          { key: "school", label: "School" }, { key: "county", label: "County" }, { key: "learners", label: "Learners", type: "number" },
          { key: "teachers", label: "Teachers", type: "number" }, { key: "completion", label: "Completion %", type: "percent" },
          { key: "average", label: "Average mark %", type: "percent" }, { key: "band", label: "Band" }, { key: "visits", label: "Field visits", type: "number" },
          { key: "library", label: "Library minutes", type: "number" },
        ],
        rows: d.learning.schools.map((s: Record<string, any>) => ({
          school: s.school, county: s.county, learners: s.learners, teachers: s.teachers, completion: s.assigned ? s.completionRate : null,
          average: s.marked ? s.averagePercent : null, band: s.band ?? "", visits: s.visits, library: s.libraryMinutes,
        })),
      },
      {
        title: "By subject",
        columns: [{ key: "subject", label: "Subject" }, { key: "completion", label: "Completion %", type: "percent" }, { key: "average", label: "Average mark %", type: "percent" }, { key: "marked", label: "Marked", type: "number" }],
        rows: d.learning.subjects.map((s: Record<string, any>) => ({ subject: s.label, completion: s.completionRate, average: s.averagePercent, marked: s.marked })),
      },
      {
        title: "Field visits by type",
        columns: [{ key: "type", label: "Visit type" }, { key: "visits", label: "Visits", type: "number" }, { key: "schools", label: "Schools", type: "number" }],
        rows: d.fieldOps.visits.byType.map((t: Record<string, any>) => ({ type: t.label, visits: t.visits, schools: t.schools })),
      },
    ],
  };
}

// ---- 11. county report
async function reportCounties(x: RCtx): Promise<{ sections: Section[]; note: string }> {
  let from = x.f.from, to = x.f.to, note = "";
  if (x.f.period) {
    const cal = await melCalendar();
    const range = periodRange(x.f.period, cal.terms, cal.years);
    if (range) { from = range.from; to = range.to; note = range.label; }
  }
  const input = narrowInput(await loadImpactInput(), x.actor.scope);
  const counties = [...new Set([...x.schools.values()].map((s) => s.county as string))].filter((c) => !x.f.county || c === x.f.county).sort();
  const rows = counties.map((county) => {
    const d = buildImpact(input, { county, from, to });
    return {
      county, schools: d.executive.schools, reached: d.reach.summary.schoolsReached, learners: d.executive.learners, teachers: d.executive.teachers,
      visits: d.fieldOps.visits.visits, visited: d.fieldOps.visits.schools.visited, completion: d.executive.completion.rate,
      average: d.executive.averageMark, library: d.executive.libraryHours, trained: d.teachers.training.share, kobo: d.fieldOps.kobo.counted,
    };
  });
  const sections: Section[] = [{
    title: "Counties",
    columns: [
      { key: "county", label: "County" }, { key: "schools", label: "Schools", type: "number" }, { key: "reached", label: "Schools reached", type: "number" },
      { key: "learners", label: "Learners", type: "number" }, { key: "teachers", label: "Teachers", type: "number" }, { key: "visits", label: "Field visits", type: "number" },
      { key: "visited", label: "Schools visited", type: "number" }, { key: "completion", label: "Completion %", type: "percent" },
      { key: "average", label: "Average mark %", type: "percent" }, { key: "library", label: "Library hours", type: "number" },
      { key: "trained", label: "Teachers trained %", type: "percent" }, { key: "kobo", label: "Kobo counted", type: "number" },
    ],
    rows,
  }];
  if (x.f.county) {
    const d = buildImpact(input, { county: x.f.county, from, to });
    sections.push({
      title: `Schools in ${x.f.county}`,
      columns: [
        { key: "school", label: "School" }, { key: "learners", label: "Learners", type: "number" }, { key: "teachers", label: "Teachers", type: "number" },
        { key: "completion", label: "Completion %", type: "percent" }, { key: "average", label: "Average mark %", type: "percent" },
        { key: "visits", label: "Field visits", type: "number" }, { key: "library", label: "Library minutes", type: "number" },
      ],
      rows: d.learning.schools.map((s: Record<string, any>) => ({
        school: s.school, learners: s.learners, teachers: s.teachers, completion: s.assigned ? s.completionRate : null,
        average: s.marked ? s.averagePercent : null, visits: s.visits, library: s.libraryMinutes,
      })),
    });
  }
  return { sections, note: note || (from || to ? `${from ?? "start"} to ${to ?? "today"}` : "All time") };
}

const REPORT_BUILDERS: Record<string, (x: RCtx) => Promise<Section[] | { sections: Section[]; note: string }>> = {
  "learner-register": reportLearners, "teacher-register": reportTeachers, "school-register": reportSchools,
  "assignment-report": reportAssignments, "assessment-report": reportAssessment, "field-visit-report": reportVisits,
  "kobo-report": reportKobo, "library-usage": reportLibrary, "me-indicator-report": reportMel,
  "term-report": reportTerm, "county-report": reportCounties,
};

/** What a person's exports are limited to, in words, for the file and the screen. */
function scopeNote(c: any, id: string): string {
  const a = c.get("actor") as Actor;
  if (id === "field-visit-report") {
    if (!actorCan(c, "field_reports.view.all")) return "Your visits";
    return a.scope.global ? "All field visits" : `Visits in ${a.scope.label}`;
  }
  if (a.role === "school_leader") return "Your school";
  if (a.role === "teacher") return "Your classes";
  return a.scope.global ? "All schools" : a.scope.label;
}

/* The reports this person can export, with what they'd cover. */
app.get("/reports", requirePermission("reports.export"), async (c) => {
  const list = reportsFor((p) => actorCan(c, p as Permission));
  const cal = list.some((r) => r.filters.includes("period")) ? await melCalendar() : null;
  const { data: progs } = list.some((r) => r.filters.includes("programme")) ? await admin.from("me_programmes").select("id, name, status") : { data: [] };
  return c.json({
    reports: list.map((r) => ({ id: r.id, title: r.title, description: r.description, filters: r.filters, scope: scopeNote(c, r.id) })),
    periods: cal?.periods ?? [],
    programmes: (progs ?? []).map((p) => ({ id: p.id, name: p.name, active: p.status === "active" })),
  });
});

/* One report's rows (?county= &school= &from= &to= &period= &programme= &status= &format=). */
app.get("/reports/:id", requirePermission("reports.export"), async (c) => {
  const def = REPORTS.find((r) => r.id === c.req.param("id"));
  if (!def) return c.json({ error: "Report not found" }, 404);
  if (!def.needs.some((p) => actorCan(c, p as Permission))) return c.json({ error: NO_PERMISSION }, 403);
  const x = await reportContext(c, def.id);
  let built;
  try { built = await REPORT_BUILDERS[def.id](x); } catch (e) { return c.json({ error: (e as Error).message }, 500); }
  const sections = Array.isArray(built) ? built : built.sections;
  const note = Array.isArray(built) ? "" : built.note;
  const rows = rowCount(sections);
  const format = ["xlsx", "csv", "pdf"].includes(String(c.req.query("format"))) ? String(c.req.query("format")) : "view";
  const filters = Object.fromEntries(Object.entries(x.f).filter(([, v]) => v && v !== "__none__"));
  await audit(c, "report.exported", "report", def.id, { format, filters, rows });
  const place = x.f.school && x.f.school !== "__none__" ? x.f.school : x.f.county ? `${x.f.county} County` : scopeNote(c, def.id);
  return c.json({
    id: def.id, title: def.title, description: def.description,
    scope: [place, note, x.f.from || x.f.to ? `${x.f.from ?? "start"} to ${x.f.to ?? "today"}` : ""].filter(Boolean).join(" · "),
    limitedTo: scopeNote(c, def.id), filters,
    generatedAt: new Date().toISOString(), generatedBy: x.actor.fullName, role: ROLE_LABEL[x.actor.role] ?? x.actor.role,
    sections,
  });
});

// ---------------------------------------------------------------- notifications
/* Stored and auditable: the rules (notifications.ts) run hourly, and for
   one person when they open their notifications if nothing has run for
   them in the last quarter hour. What's new is stored — never twice for
   the same thing — with a "created" event; reading one records a "read"
   event. Nothing is ever deleted or rewritten (the database refuses). */

async function runNotifications(trigger: "schedule" | "user" | "manual", onlyRecipient: string | null = null) {
  const runId = rid("nrun");
  const startedAt = new Date().toISOString();
  await admin.from("notification_runs").insert({ id: runId, trigger, scope: onlyRecipient ? `user:${onlyRecipient}` : "all", started_at: startedAt, created: 0 });
  try {
    const now = new Date();
    const read = (table: string, cols: string) => selectAll(() => admin.from(table).select(cols).order("id"));
    const since = (days: number) => new Date(now.getTime() - days * 864e5).toISOString();
    const results = await Promise.all([
      read("profiles", "id, role, status, county, full_name, email"),
      read("learners", "id, class_id, enrollment_status"),
      read("class_teachers", "id, class_id, teacher_id, ended_at"),
      read("classes", "id, name"),
      read("assignments", "id, class_id, title, status, due_at, created_by"),
      read("assignment_submissions", "id, assignment_id, learner_id, status, submitted_at, marked_at, percentage, band"),
      read("forms", "id, title, audience, county, visit_type, due_on, archived_at, created_at"),
      read("responses", "id, form_id, respondent_id, visit_id"),
      selectAll(() => admin.from("field_reports").select("id, officer_id, school, county, visit_type, created_at").gt("created_at", since(31)).order("id")),
      read("kobo_forms", "id, title"),
      selectAll(() => admin.from("kobo_raw_submissions").select("id, kobo_form_id, received_at").gt("received_at", since(2)).order("id")),
      selectAll(() => admin.from("notifications").select("id, recipient_id, data, created_at").eq("kind", "kobo_received").order("id")),
    ]);
    const failed = results.find((r) => r.error);
    if (failed) throw new Error(failed.error!.message);
    const [profiles, learners, classTeachers, classes, assignments, submissions, forms, responses, fieldReports, koboForms, raw, told] = results.map((r) => r.data);
    // Explicit grants count for notifications too (e.g. someone granted kobo.review).
    const { data: openGrants } = await admin.from("permission_grants").select("profile_id, permission").is("revoked_at", null);
    const grantsOf = new Map<string, string[]>();
    for (const g of openGrants ?? []) grantsOf.set(g.profile_id, [...(grantsOf.get(g.profile_id) ?? []), g.permission]);
    const recs = raw.length ? await selectIn("kobo_records", "raw_id", raw.map((r) => r.id as string), "raw_id, status, review") : [];
    const review = new Set(recs.filter((r) => (r.status === "invalid" || r.status === "duplicate") && !r.review).map((r) => r.raw_id));
    const koboLastNotified: Record<string, string> = {};
    for (const n of told) {
      const until = String(n.data?.until ?? n.created_at);
      if (!koboLastNotified[n.recipient_id] || until > koboLastNotified[n.recipient_id]) koboLastNotified[n.recipient_id] = until;
    }
    const candidates = buildNotifications({
      profiles, learners, classTeachers, classes, assignments, submissions, forms, responses, fieldReports, koboForms,
      koboReceived: raw.map((r) => ({ ...r, needs_review: review.has(r.id) })), koboLastNotified,
      can: (person, perm) => effectivePermissions(person.role, grantsOf.get(person.id) ?? []).has(perm as Permission),
    }, now, onlyRecipient);

    // Only what's new: one row per person per dedupe key, ever.
    const recipients = [...new Set(candidates.map((x) => x.recipientId))];
    const existing = recipients.length ? await selectIn("notifications", "recipient_id", recipients, "id, recipient_id, dedupe_key") : [];
    const have = new Set(existing.map((e) => `${e.recipient_id}|${e.dedupe_key}`));
    const rows = candidates.filter((x) => !have.has(`${x.recipientId}|${x.dedupeKey}`)).map((x) => ({
      id: rid("ntf"), recipient_kind: x.recipientKind, recipient_id: x.recipientId, kind: x.kind, severity: x.severity,
      title: x.title.slice(0, 300), body: x.body.slice(0, 2000), link: x.link, data: x.data, dedupe_key: x.dedupeKey,
      run_id: runId, created_at: now.toISOString(),
    }));
    let created = 0;
    for (let i = 0; i < rows.length; i += 200) {
      const { data: inserted, error } = await admin.from("notifications")
        .upsert(rows.slice(i, i + 200), { onConflict: "recipient_id,dedupe_key", ignoreDuplicates: true }).select("id");
      if (error) throw new Error(error.message);
      const ids = (inserted ?? []).map((r: Record<string, unknown>) => r.id as string);
      created += ids.length;
      if (ids.length) {
        await admin.from("notification_events").insert(ids.map((id) => ({
          notification_id: id, action: "created", actor_kind: "system", actor_id: null, details: { run: runId, trigger }, at: now.toISOString(),
        })));
      }
    }
    await admin.from("notification_runs").update({ finished_at: new Date().toISOString(), created }).eq("id", runId);
    return { run: runId, created };
  } catch (e) {
    const msg = (e as Error).message;
    console.error("notifications run:", msg);
    await admin.from("notification_runs").update({ finished_at: new Date().toISOString(), error: msg.slice(0, 500) }).eq("id", runId);
    return { run: runId, created: 0, error: msg };
  }
}

const mapNotification = (n: Record<string, any>) => ({
  id: n.id, kind: n.kind, severity: n.severity, title: n.title, body: n.body, link: n.link ?? null,
  data: n.data ?? {}, createdAt: n.created_at, readAt: n.read_at ?? null,
});

async function unreadCount(me: string) {
  const { count } = await admin.from("notifications").select("id", { count: "exact", head: true }).eq("recipient_id", me).is("read_at", null);
  return count ?? 0;
}

/* My notifications, newest first (the latest 60), with the unread count. */
app.get("/notifications", requireActive(), async (c) => {
  const me = c.get("actor").id as string;
  const recent = new Date(Date.now() - 15 * 60_000).toISOString();
  const { data: runs } = await admin.from("notification_runs").select("id").in("scope", ["all", `user:${me}`]).gt("started_at", recent).limit(1);
  if (!runs?.length) await runNotifications("user", me);
  const { data } = await admin.from("notifications").select("*").eq("recipient_id", me).order("created_at", { ascending: false }).limit(60);
  const list = (data ?? []).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(b.id).localeCompare(String(a.id)));
  return c.json({ notifications: list.map(mapNotification), unread: await unreadCount(me) });
});

// deno-lint-ignore no-explicit-any
async function markRead(c: any, n: Record<string, any>) {
  if (n.read_at) return;
  const at = new Date().toISOString();
  const { error } = await admin.from("notifications").update({ read_at: at }).eq("id", n.id).is("read_at", null);
  if (error) throw new Error(error.message);
  await admin.from("notification_events").insert({
    notification_id: n.id, action: "read", actor_kind: c.get("actorKind") === "learner" ? "learner" : "staff", actor_id: c.get("actor").id, at,
  });
}

app.post("/notifications/:id/read", requireActive(), async (c) => {
  const me = c.get("actor").id as string;
  const { data: n } = await admin.from("notifications").select("*").eq("id", c.req.param("id")).maybeSingle();
  if (!n || n.recipient_id !== me) return c.json({ error: "Notification not found" }, 404);
  await markRead(c, n);
  return c.json({ ok: true, unread: await unreadCount(me) });
});

app.post("/notifications/read-all", requireActive(), async (c) => {
  const me = c.get("actor").id as string;
  const { data } = await selectAll(() => admin.from("notifications").select("*").eq("recipient_id", me).is("read_at", null).order("id"));
  for (const n of data ?? []) await markRead(c, n);
  return c.json({ ok: true, read: data?.length ?? 0, unread: 0 });
});

/* Who was told what, when — and when they read it. ?kind= ?role= ?status=read|unread ?from= ?to= */
app.get("/notifications/log", requirePermission("notifications.view.all"), async (c) => {
  const q = (k: string) => String(c.req.query(k) ?? "").trim();
  const [{ data, error }, { data: people }, { data: learners }, { data: runs }] = await Promise.all([
    selectAll(() => admin.from("notifications").select("*").order("created_at", { ascending: false }).order("id")),
    selectAll(() => admin.from("profiles").select("id, full_name, role, school, school_id, county").order("id")),
    selectAll(() => admin.from("learners").select("id, full_name, school, school_id").order("id")),
    admin.from("notification_runs").select("*").order("started_at", { ascending: false }).limit(10),
  ]);
  if (error) return c.json({ error: error.message }, 500);
  const who = new Map<string, { name: string; role: string; place: string }>();
  for (const p of people ?? []) who.set(p.id, { name: p.full_name, role: p.role, place: p.school || p.county || "" });
  for (const l of learners ?? []) who.set(l.id, { name: l.full_name, role: "learner", place: l.school || "" });
  const placeOf = new Map<string, [unknown, unknown]>();
  for (const p of people ?? []) placeOf.set(p.id, [p.school_id, p.role === "field_officer" ? p.county : null]);
  for (const l of learners ?? []) placeOf.set(l.id, [l.school_id, null]);
  const inArea = (id: string) => scopeOf(c).global || inScope(c, placeOf.get(id)?.[0], placeOf.get(id)?.[1]);
  const day = (v: unknown) => String(v ?? "").slice(0, 10);
  const rows = (data ?? []).filter((n) => inArea(n.recipient_id) &&
    (!q("kind") || n.kind === q("kind")) &&
    (!q("role") || who.get(n.recipient_id)?.role === q("role")) &&
    (!q("status") || (q("status") === "read" ? !!n.read_at : !n.read_at)) &&
    (!q("from") || day(n.created_at) >= q("from")) && (!q("to") || day(n.created_at) <= q("to")))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return c.json({
    total: rows.length,
    unread: rows.filter((n) => !n.read_at).length,
    notifications: rows.slice(0, 300).map((n) => ({
      ...mapNotification(n), recipient: who.get(n.recipient_id) ?? { name: "Former account", role: n.recipient_kind, place: "" },
    })),
    runs: (runs ?? []).sort((a, b) => String(b.started_at).localeCompare(String(a.started_at))).map((r) => ({
      id: r.id, trigger: r.trigger, scope: r.scope, startedAt: r.started_at, finishedAt: r.finished_at ?? null, created: r.created, error: r.error ?? null,
    })),
  });
});

app.post("/notifications/run-now", requirePermission("notifications.view.all"), async (c) => {
  const res = await runNotifications("manual");
  await audit(c, "notifications.run", "notification_runs", res.run, { created: res.created });
  return c.json(res);
});

// ---------------------------------------------------------------- Sync center
/* What's synced and what isn't, by area, for the person asking:
     kobo     — the connection, each survey's last sync and error; for a
                field officer, what Kobo has received from them and what
                of it needs review (and why)
     school   — a field officer's visits as the server has them
     learning — a learner's hand-ins, a teacher's marking, as received
     content  — how much is in the library for them, and its newest item
   The device adds its own side (what's waiting on it). Devices of staff
   report their sync state here, and the Education Team sees them all. */

app.get("/sync/status", requireActive(), async (c) => {
  const actor = c.get("actor");
  const me = actor.id as string;
  const isLearner = c.get("actorKind") === "learner";
  const out: Record<string, unknown> = { serverTime: new Date().toISOString() };

  // ---- Kobo
  const manages = actorCan(c, "kobo.manage") || actorCan(c, "kobo.results.view");
  const fills = actorCan(c, "kobo.surveys.fill");
  if (manages || fills) {
    const cfg = await loadKoboConfig();
    const { data: forms } = await admin.from("kobo_forms").select("*").eq("active", true);
    const { data: lastPush } = await admin.from("kobo_raw_submissions").select("received_at")
      .eq("source", "webhook").order("received_at", { ascending: false }).limit(1);
    const live = (forms ?? []);
    const synced = live.map((f) => f.synced_at).filter(Boolean).sort();
    const kobo: Record<string, unknown> = {
      connected: !!cfg,
      pushConfigured: !!cfg?.webhook_secret_hash,
      lastSyncedAt: synced.at(-1) ?? null,
      lastPushAt: lastPush?.[0]?.received_at ?? null,
      failing: live.filter((f) => f.last_sync_error).length,
    };
    const counted = (r: Record<string, any>) => countsOnDashboards(r.status, r.review);
    const needsReview = (r: Record<string, any>) => (r.status === "invalid" || r.status === "duplicate") && !r.review;
    if (manages) {
      const { data: recs } = await selectAll(() => admin.from("kobo_records").select("id, kobo_form_id, status, review").order("id"));
      kobo.surveys = live.map((f) => {
        const mine = (recs ?? []).filter((r) => r.kobo_form_id === f.id && r.status !== "removed");
        return {
          id: f.id, title: f.title, syncedAt: f.synced_at ?? null, lastAttemptAt: f.last_sync_attempt_at ?? null,
          error: f.last_sync_error ?? null, received: mine.length, counted: mine.filter(counted).length, needsReview: mine.filter(needsReview).length,
        };
      }).sort((a, b) => String(a.title).localeCompare(String(b.title)));
    }
    if (fills) {
      const { data: recs } = await selectAll(() => admin.from("kobo_records").select("id, kobo_form_id, status, review, submitted_at")
        .eq("officer_id", me).order("id"));
      const mine = (recs ?? []).filter((r) => r.status !== "removed");
      const review = mine.filter(needsReview);
      const issues = review.length ? await selectIn("kobo_record_issues", "record_id", review.map((r) => r.id as string), "record_id, severity, message") : [];
      const byMessage = new Map<string, number>();
      for (const i of issues.filter((x) => x.severity === "error")) byMessage.set(i.message, (byMessage.get(i.message) ?? 0) + 1);
      kobo.mine = {
        received: mine.length, counted: mine.filter(counted).length, needsReview: review.length,
        lastSubmittedAt: mine.map((r) => r.submitted_at).filter(Boolean).sort().at(-1) ?? null,
        surveys: live.map((f) => {
          const rs = mine.filter((r) => r.kobo_form_id === f.id);
          return { title: f.title, received: rs.length, needsReview: rs.filter(needsReview).length, lastSubmittedAt: rs.map((r) => r.submitted_at).filter(Boolean).sort().at(-1) ?? null };
        }),
        issues: [...byMessage.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([message, count]) => ({ message, count })),
      };
    }
    out.kobo = kobo;
  }

  // ---- school work, as the server has it
  if (actorCan(c, "field_reports.create")) {
    const { data: visits } = await selectAll(() => admin.from("field_reports").select("id, created_at").eq("officer_id", me).order("id"));
    out.school = { visits: visits?.length ?? 0, lastVisitAt: (visits ?? []).map((v) => v.created_at).sort().at(-1) ?? null };
  }

  // ---- learning work, as the server has it
  if (isLearner) {
    const { data: subs } = await admin.from("assignment_submissions").select("status, submitted_at").eq("learner_id", me);
    const handed = (subs ?? []).filter((s) => s.status !== "in_progress");
    out.learning = { handedIn: handed.length, lastHandedInAt: handed.map((s) => s.submitted_at).filter(Boolean).sort().at(-1) ?? null };
  } else if (actorCan(c, "assignments.grade")) {
    const { data: marked } = await admin.from("assignment_submissions").select("marked_at").eq("marked_by", me);
    out.learning = { marked: marked?.length ?? 0, lastMarkedAt: (marked ?? []).map((s) => s.marked_at).filter(Boolean).sort().at(-1) ?? null };
  }

  // ---- content they can see
  const { data: items } = await selectAll(() => admin.from("library_items").select("id, audience, published, uploaded_at").order("id"));
  const mine = (items ?? []).filter((i) => (actorCan(c, "library.manage") || i.published) && canSeeLibrary(i.audience as string, actor.permissions));
  out.content = { items: mine.length, latestAt: mine.map((i) => i.uploaded_at).filter(Boolean).sort().at(-1) ?? null };
  return c.json(out);
});

/* A staff device's own sync state, sent after it syncs. Numbers only —
   never the work itself. */
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,80}$/;
app.post("/sync/report", requireStaff(), async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (!DEVICE_ID_RE.test(String(b.deviceId ?? ""))) return c.json({ error: "Invalid device" }, 400);
  const n = (v: unknown) => Math.max(0, Math.min(100_000, Math.round(Number(v) || 0)));
  const when = (v: unknown) => {
    const t = typeof v === "string" ? new Date(v) : null;
    return t && Number.isFinite(t.getTime()) && t.getTime() <= Date.now() + 5 * 60_000 ? t.toISOString() : null;
  };
  const row = {
    actor_id: c.get("actor").id, device_id: String(b.deviceId),
    device_label: String(b.deviceLabel ?? "").slice(0, 120), app_version: String(b.appVersion ?? "").slice(0, 40),
    online: b.online !== false, last_sync_at: when(b.lastSyncAt),
    pending: n(b.pending), failed: n(b.failed), conflicts: n(b.conflicts), saved_files: n(b.savedFiles),
    oldest_pending_at: when(b.oldestPendingAt), reported_at: new Date().toISOString(),
  };
  const { error } = await admin.from("device_sync_status").upsert(row, { onConflict: "actor_id,device_id" });
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ ok: true });
});

/** Why a device needs a look, in words — or null. */
function deviceAttention(d: Record<string, any>, now = Date.now()): string | null {
  const stuck = Number(d.conflicts) + Number(d.failed);
  if (stuck) return `${stuck} ${stuck === 1 ? "activity needs" : "activities need"} a decision on the device`;
  if (Number(d.pending) > 0 && d.oldest_pending_at && now - Date.parse(d.oldest_pending_at) > 24 * 3600e3) {
    return `${d.pending} waiting on the device for ${Math.floor((now - Date.parse(d.oldest_pending_at)) / 864e5) || 1}+ day(s)`;
  }
  if (!d.last_sync_at) return "Hasn't synced yet";
  const days = Math.floor((now - Date.parse(d.last_sync_at)) / 864e5);
  if (days >= 7) return `Hasn't synced for ${days} days`;
  return null;
}

/* The field team at a glance: every field officer, teacher and school head
   with the devices they use — last sync, what's waiting, what needs a look. */
app.get("/sync/devices", requirePermission("sync.monitor"), async (c) => {
  const roleFilter = String(c.req.query("role") ?? "");
  const [{ data: reports, error }, { data: staff, error: e2 }] = await Promise.all([
    selectAll(() => admin.from("device_sync_status").select("*").order("actor_id").order("device_id")),
    selectAll(() => admin.from("profiles").select("id, full_name, role, status, school, school_id, county").order("id")),
  ]);
  if (error || e2) return c.json({ error: (error ?? e2)!.message }, 500);
  const now = Date.now();
  const people = (staff ?? []).filter((p) => (p.status ?? "active") === "active" && inScope(c, p.school_id, p.county) &&
    ["field_officer", "teacher", "school_leader"].includes(p.role) && (!roleFilter || p.role === roleFilter));
  const rows = people.map((p) => {
    // The device that needs a look first, then the most recently heard from.
    const devices = (reports ?? []).filter((d) => d.actor_id === p.id)
      .map((d) => ({
        deviceLabel: d.device_label, appVersion: d.app_version, online: d.online, lastSyncAt: d.last_sync_at ?? null,
        pending: d.pending, failed: d.failed, conflicts: d.conflicts, savedFiles: d.saved_files,
        oldestPendingAt: d.oldest_pending_at ?? null, reportedAt: d.reported_at, attention: deviceAttention(d, now),
      }))
      .sort((a, b) => Number(!!b.attention) - Number(!!a.attention) || String(b.reportedAt).localeCompare(String(a.reportedAt)));
    return {
      id: p.id, name: p.full_name, role: p.role, roleLabel: ROLE_LABEL[p.role as Role] ?? p.role, school: p.school ?? "", county: p.county ?? "",
      devices, attention: devices.find((d) => d.attention)?.attention ?? (devices.length ? null : "No device has reported yet"),
      pending: devices.reduce((t, d) => t + d.pending + d.failed + d.conflicts, 0),
      lastSyncAt: devices.map((d) => d.lastSyncAt).filter(Boolean).sort().at(-1) ?? null,
    };
  }).sort((a, b) => Number(!!b.attention && b.devices.length > 0) - Number(!!a.attention && a.devices.length > 0)
    || b.pending - a.pending || String(a.lastSyncAt ?? "").localeCompare(String(b.lastSyncAt ?? "")) || String(a.name).localeCompare(String(b.name)));
  return c.json({ people: rows, generatedAt: new Date().toISOString() });
});

// ---------------------------------------------------------------- M&E layer (/mel)
// PROGRAMME → OUTCOMES → INDICATORS → TARGETS → ACTUALS → EVIDENCE → REPORT.
// The rules are in me.ts. Framework and targets: M&E (and admins). Actuals
// are RECORDED (a snapshot of the value and how it was worked out, with
// evidence attached automatically) and VERIFIED by someone else. Reports
// freeze the results for a period; a final one can never change.

type MelScope = MeScope & { schoolName?: string; county?: string };

async function melScope(type: unknown, id: unknown): Promise<MelScope | null> {
  const t = String(type ?? "programme");
  const v = String(id ?? "").trim();
  if (t === "programme") return { type: "programme", id: "", label: "Whole programme" };
  if (t === "county") {
    const counties = await loadCounties().catch(() => [] as County[]);
    return counties.some((c) => c.name === v) ? { type: "county", id: v, label: `${v} County`, county: v } : null;
  }
  if (t === "school") {
    const s = await loadSchool(v);
    return s ? { type: "school", id: s.id, label: `${s.name} (${s.code})`, schoolName: s.name, county: s.county } : null;
  }
  return null;
}

async function melCalendar() {
  const [{ data: terms }, { data: years }] = await Promise.all([
    admin.from("terms").select("*").order("id"),
    admin.from("academic_years").select("*").order("id"),
  ]);
  const t = (terms ?? []).sort((a: Record<string, any>, b: Record<string, any>) => String(a.starts_on).localeCompare(String(b.starts_on)));
  const y = (years ?? []).sort((a: Record<string, any>, b: Record<string, any>) => String(a.id).localeCompare(String(b.id)));
  const today = new Date().toISOString().slice(0, 10);
  const periods: { id: string; label: string; current: boolean }[] = [];
  for (const yr of y) {
    for (const term of t.filter((x: Record<string, any>) => x.academic_year_id === yr.id)) {
      periods.push({ id: term.id, label: periodRange(term.id, t, y)!.label, current: term.starts_on <= today && today <= term.ends_on });
    }
    periods.push({ id: yr.id, label: `${yr.id} school year`, current: false });
  }
  return { terms: t, years: y, periods };
}

const mapIndicator = (i: Record<string, any>) => ({
  id: i.id, outcomeId: i.outcome_id, code: i.code, name: i.name, definition: i.definition, unit: i.unit, direction: i.direction,
  source: i.source, sourceConfig: i.source_config ?? {}, evidenceHint: i.evidence_hint ?? "",
  baselineValue: i.baseline_value == null ? null : Number(i.baseline_value), baselinePeriod: i.baseline_period ?? null,
  dashboardTheme: i.dashboard_theme ?? null,
  archived: !!i.archived_at,
});

/** Impact dashboards an indicator can be shown on (besides M&E's own). */
const DASHBOARD_THEMES = ["reach", "learning", "teacher_development", "field_operations", "digital_resources"];

/** Live values for indicators in one period and scope, from Kobo records
    and the portal's own measures. Loads only what the indicators need. */
async function melLive(indicators: Record<string, any>[], range: { from: string; to: string }, scopes: MelScope[]) {
  return melCompute(await melLoad(indicators), indicators, range, scopes);
}

/** The rows melCompute() needs for these indicators — loaded once, so a
    trend can work out many periods from one read. */
async function melLoad(indicators: Record<string, any>[]) {
  const needIntel = indicators.some((i) => i.source === "portal");
  const formIds = [...new Set(indicators.filter((i) => i.source === "kobo").map((i) => i.source_config?.formId).filter(Boolean))] as string[];
  const [input, kobo] = await Promise.all([
    needIntel ? loadIntelligenceInput() : null,
    formIds.length ? selectIn("kobo_records", "kobo_form_id", formIds, "id, kobo_form_id, status, review, observed_on, county, school_id, answers") : [],
  ]);
  return { input, kobo };
}

function melCompute(loaded: Awaited<ReturnType<typeof melLoad>>, indicators: Record<string, any>[], range: { from: string; to: string }, scopes: MelScope[]) {
  const { input, kobo } = loaded;
  const out = new Map<string, Computed>(); // `${indicatorId}|${scopeType}|${scopeId}`
  for (const scope of scopes) {
    const intel = input ? buildIntelligence(input, {
      county: scope.type === "county" ? scope.id : null, school: scope.type === "school" ? scope.schoolName : null, from: range.from, to: range.to,
    }) : null;
    for (const i of indicators) {
      let v: Computed | null = null;
      if (i.source === "portal" && intel) v = PORTAL_METRICS[i.source_config?.metric]?.get(intel, i.source_config ?? {}) ?? null;
      if (i.source === "kobo") v = koboMeasure(koboInScope(kobo, i.source_config?.formId, range, scope), i.source_config ?? {});
      if (v) out.set(`${i.id}|${scope.type}|${scope.id}`, v);
    }
  }
  return out;
}

async function melProgrammeTree(programmeId: string, includeArchived = false) {
  const { data: programme } = await admin.from("me_programmes").select("*").eq("id", programmeId).maybeSingle();
  if (!programme) return null;
  const { data: outcomes } = await admin.from("me_outcomes").select("*").eq("programme_id", programmeId);
  const oIds = (outcomes ?? []).map((o: Record<string, any>) => o.id as string);
  const indicators = oIds.length ? await selectIn("me_indicators", "outcome_id", oIds) : [];
  const live = (x: Record<string, any>) => includeArchived || !x.archived_at;
  const byPos = (a: Record<string, any>, b: Record<string, any>) => (a.position - b.position) || String(a.code).localeCompare(String(b.code), undefined, { numeric: true }) || String(a.created_at).localeCompare(String(b.created_at));
  return {
    programme,
    outcomes: (outcomes ?? []).filter(live).sort(byPos).map((o: Record<string, any>) => ({
      ...o, indicators: indicators.filter((i) => i.outcome_id === o.id && live(i)).sort(byPos),
    })),
    indicators: indicators.filter(live),
  };
}

/** The results table for a programme, period and scope: target, live value,
    recorded (and verified) value, achievement and evidence per indicator. */
async function melResults(programmeId: string, period: string, scope: MelScope) {
  const tree = await melProgrammeTree(programmeId);
  if (!tree) return { error: "Programme not found", status: 404 as const };
  const cal = await melCalendar();
  const range = periodRange(period, cal.terms, cal.years);
  if (!range) return { error: "Choose a term or school year", status: 400 as const };
  const ids = tree.indicators.map((i) => i.id as string);
  const [targets, actuals, live] = await Promise.all([
    ids.length ? selectIn("me_targets", "indicator_id", ids) : [],
    ids.length ? selectIn("me_actuals", "indicator_id", ids) : [],
    melLive(tree.indicators, range, [scope]),
  ]);
  const current = actuals.filter((a) => !a.superseded_at && a.period === period && a.scope_type === scope.type && (a.scope_id ?? "") === scope.id);
  const evidence = current.length ? await selectIn("me_evidence", "actual_id", current.map((a) => a.id as string)) : [];
  const people = await dqNames([...current.flatMap((a) => [a.recorded_by, a.verified_by])]);
  const summary = { met: 0, close: 0, not_met: 0, no_data: 0 };
  const outcomes = tree.outcomes.map((o: Record<string, any>) => ({
    id: o.id, code: o.code, title: o.title, description: o.description,
    indicators: o.indicators.map((i: Record<string, any>) => {
      const rec = current.find((a) => a.indicator_id === i.id) ?? null;
      const lv = live.get(`${i.id}|${scope.type}|${scope.id}`) ?? null;
      const tgt = targetFor(targets, i.id, period, scope);
      const value = rec?.status !== "rejected" && rec?.value != null ? Number(rec.value) : lv?.value ?? null;
      const valueSource = rec && rec.status !== "rejected" ? rec.status : lv?.value != null ? "live" : "none";
      const ach = achievement(value, tgt?.value ?? null, i.direction);
      summary[ach.status]++;
      return {
        ...mapIndicator(i),
        target: tgt ? { value: tgt.value, from: tgt.from } : null,
        live: lv,
        recorded: rec ? {
          id: rec.id, value: rec.value == null ? null : Number(rec.value), numerator: rec.numerator == null ? null : Number(rec.numerator),
          denominator: rec.denominator == null ? null : Number(rec.denominator), n: rec.n, method: rec.method, note: rec.note, status: rec.status,
          recordedBy: people.get(rec.recorded_by) ?? null, recordedById: rec.recorded_by ?? null, recordedAt: rec.recorded_at,
          verifiedBy: rec.verified_by ? people.get(rec.verified_by) ?? null : null, verifiedAt: rec.verified_at ?? null, verificationNote: rec.verification_note ?? null,
          evidence: evidence.filter((e) => e.actual_id === rec.id).map((e) => ({
            id: e.id, kind: e.kind, title: e.title, recordCount: e.record_count ?? null, url: e.url ?? null,
            fileName: e.file?.name ?? null, details: e.details ?? {}, addedAt: e.added_at,
          })),
        } : null,
        value, valueSource, achievement: ach,
      };
    }),
  }));
  return {
    programme: { id: tree.programme.id, code: tree.programme.code, name: tree.programme.name, description: tree.programme.description },
    period: { id: period, label: range.label, from: range.from, to: range.to },
    scope: { type: scope.type, id: scope.id, label: scope.label },
    outcomes, summary,
  };
}

// ---- framework: programmes, outcomes, indicators, targets ----

app.get("/mel/programmes", requirePermission("me.view"), async (c) => {
  const { data: programmes } = await selectAll(() => admin.from("me_programmes").select("*").order("id"));
  const { data: outcomes } = await selectAll(() => admin.from("me_outcomes").select("id, programme_id, archived_at").order("id"));
  const { data: indicators } = await selectAll(() => admin.from("me_indicators").select("id, outcome_id, archived_at").order("id"));
  const cal = await melCalendar();
  return c.json({
    periods: cal.periods,
    programmes: (programmes ?? []).sort((a, b) => String(a.name).localeCompare(String(b.name))).map((p) => {
      const os = (outcomes ?? []).filter((o) => o.programme_id === p.id && !o.archived_at);
      return {
        id: p.id, code: p.code, name: p.name, description: p.description, status: p.status, startDate: p.start_date, endDate: p.end_date,
        outcomes: os.length, indicators: (indicators ?? []).filter((i) => !i.archived_at && os.some((o) => o.id === i.outcome_id)).length,
      };
    }),
  });
});

function readProgramme(b: Record<string, any>, partial: boolean): Record<string, unknown> | { error: string } {
  const out: Record<string, unknown> = {};
  if (!partial || b.name !== undefined) {
    const name = String(b.name ?? "").trim();
    if (!name || name.length > 200) return { error: "Give the programme a name" };
    out.name = name;
  }
  if (b.code !== undefined) out.code = String(b.code ?? "").trim().slice(0, 40);
  if (b.description !== undefined) out.description = String(b.description ?? "").trim().slice(0, 4000);
  for (const [k, col] of [["startDate", "start_date"], ["endDate", "end_date"]] as const) {
    if (b[k] !== undefined) {
      if (b[k] && !DATE_RE.test(String(b[k]))) return { error: "Dates look like 2026-01-31" };
      out[col] = b[k] || null;
    }
  }
  if (b.status !== undefined) {
    if (!["active", "closed"].includes(b.status)) return { error: "Status is active or closed" };
    out.status = b.status;
  }
  return out;
}

app.post("/mel/programmes", requirePermission("me.framework.manage"), async (c) => {
  const fields = readProgramme(await c.req.json().catch(() => ({})), false);
  if ("error" in fields) return c.json(fields, 400);
  const id = rid("prog");
  const { error } = await admin.from("me_programmes").insert({ id, status: "active", ...fields, created_by: c.get("actor").id });
  if (error) return c.json({ error: error.message }, 400);
  await audit(c, "me.programme_created", "me_programme", id, { name: fields.name });
  return c.json({ id });
});

app.patch("/mel/programmes/:id", requirePermission("me.framework.manage"), async (c) => {
  const { data: p } = await admin.from("me_programmes").select("id").eq("id", c.req.param("id")).maybeSingle();
  if (!p) return c.json({ error: "Programme not found" }, 404);
  const fields = readProgramme(await c.req.json().catch(() => ({})), true);
  if ("error" in fields) return c.json(fields, 400);
  await admin.from("me_programmes").update({ ...fields, updated_at: new Date().toISOString() }).eq("id", p.id);
  await audit(c, "me.programme_updated", "me_programme", p.id, { fields: Object.keys(fields) });
  return c.json({ ok: true });
});

/* The whole framework of one programme, with what's needed to edit it:
   periods, scopes, and the sources an indicator can draw on. */
app.get("/mel/programmes/:id", requirePermission("me.view"), async (c) => {
  const tree = await melProgrammeTree(c.req.param("id"), c.req.query("archived") === "1");
  if (!tree) return c.json({ error: "Programme not found" }, 404);
  const ids = tree.indicators.map((i) => i.id as string);
  const [targets, cal, { data: forms }, { data: schools }, counties] = await Promise.all([
    ids.length ? selectIn("me_targets", "indicator_id", ids) : [],
    melCalendar(),
    admin.from("kobo_forms").select("id, title, active, schema"),
    selectAll(() => admin.from("schools").select("id, name, code, county").order("id")),
    loadCounties().catch(() => [] as County[]),
  ]);
  const p = tree.programme;
  return c.json({
    programme: { id: p.id, code: p.code, name: p.name, description: p.description, status: p.status, startDate: p.start_date, endDate: p.end_date },
    outcomes: tree.outcomes.map((o: Record<string, any>) => ({
      id: o.id, code: o.code, title: o.title, description: o.description, archived: !!o.archived_at,
      indicators: o.indicators.map(mapIndicator),
    })),
    targets: targets.map((t) => ({ indicatorId: t.indicator_id, period: t.period, scopeType: t.scope_type, scopeId: t.scope_id, value: Number(t.target_value), note: t.note ?? null })),
    periods: cal.periods,
    scopes: { counties: counties.map((x) => x.name), schools: (schools ?? []).map((s) => ({ id: s.id, name: s.name, code: s.code, county: s.county })) },
    sources: {
      portal: Object.entries(PORTAL_METRICS).map(([key, m]) => ({ key, label: m.label, unit: m.unit })),
      visitTypes: [...INTEL_VISIT_TYPES],
      kobo: (forms ?? []).filter((f: Record<string, any>) => f.active !== false).map((f: Record<string, any>) => {
        const schema = f.schema as KoboSchema | null;
        return {
          id: f.id, title: f.title, synced: !!schema,
          fields: (schema?.fields ?? []).filter((x) => !x.repeats.length && x.type !== "hidden").map((x) => ({
            xpath: x.xpath, label: x.label, type: x.type,
            choices: x.listName ? (schema!.choices[x.listName] ?? []).map((ch) => ({ name: ch.name, label: ch.label })) : [],
          })),
        };
      }),
    },
  });
});

async function melOutcomeOf(id: unknown) {
  const { data } = await admin.from("me_outcomes").select("*").eq("id", String(id ?? "")).maybeSingle();
  return data;
}

app.post("/mel/outcomes", requirePermission("me.framework.manage"), async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const { data: p } = await admin.from("me_programmes").select("id").eq("id", String(b.programmeId ?? "")).maybeSingle();
  if (!p) return c.json({ error: "Programme not found" }, 404);
  const title = String(b.title ?? "").trim();
  if (!title || title.length > 300) return c.json({ error: "Give the outcome a title" }, 400);
  const id = rid("out");
  const { error } = await admin.from("me_outcomes").insert({
    id, programme_id: p.id, code: String(b.code ?? "").trim().slice(0, 20), title,
    description: String(b.description ?? "").trim().slice(0, 4000), position: Number(b.position) || 0,
  });
  if (error) return c.json({ error: error.message }, 400);
  await audit(c, "me.outcome_created", "me_outcome", id, { programmeId: p.id, title });
  return c.json({ id });
});

app.patch("/mel/outcomes/:id", requirePermission("me.framework.manage"), async (c) => {
  const o = await melOutcomeOf(c.req.param("id"));
  if (!o) return c.json({ error: "Outcome not found" }, 404);
  const b = await c.req.json().catch(() => ({}));
  const patch: Record<string, unknown> = {};
  if (b.title !== undefined) {
    const t = String(b.title).trim();
    if (!t) return c.json({ error: "Give the outcome a title" }, 400);
    patch.title = t.slice(0, 300);
  }
  if (b.code !== undefined) patch.code = String(b.code).trim().slice(0, 20);
  if (b.description !== undefined) patch.description = String(b.description).trim().slice(0, 4000);
  if (b.position !== undefined) patch.position = Number(b.position) || 0;
  if (b.archived !== undefined) patch.archived_at = b.archived ? new Date().toISOString() : null;
  await admin.from("me_outcomes").update(patch).eq("id", o.id);
  await audit(c, "me.outcome_updated", "me_outcome", o.id, { fields: Object.keys(patch) });
  return c.json({ ok: true });
});

/** Indicator fields, checked — including where its actuals come from. */
async function readIndicator(b: Record<string, any>, existing: Record<string, any> | null): Promise<Record<string, unknown> | { error: string }> {
  const out: Record<string, unknown> = {};
  if (!existing || b.name !== undefined) {
    const name = String(b.name ?? "").trim();
    if (!name || name.length > 300) return { error: "Give the indicator a name" };
    out.name = name;
  }
  if (b.code !== undefined) out.code = String(b.code ?? "").trim().slice(0, 20);
  if (b.definition !== undefined) out.definition = String(b.definition ?? "").trim().slice(0, 4000);
  if (b.evidenceHint !== undefined) out.evidence_hint = String(b.evidenceHint ?? "").trim().slice(0, 300);
  if (b.unit !== undefined) {
    if (!ME_UNITS.includes(b.unit)) return { error: "Unit is percent, count or number" };
    out.unit = b.unit;
  }
  if (b.direction !== undefined) {
    if (!["increase", "decrease"].includes(b.direction)) return { error: "Direction is increase or decrease" };
    out.direction = b.direction;
  }
  if (b.baselineValue !== undefined) {
    if (b.baselineValue === null || b.baselineValue === "") out.baseline_value = null;
    else if (!Number.isFinite(Number(b.baselineValue))) return { error: "The baseline is a number" };
    else out.baseline_value = Number(b.baselineValue);
  }
  if (b.baselinePeriod !== undefined) out.baseline_period = String(b.baselinePeriod ?? "").trim().slice(0, 40) || null;
  if (b.dashboardTheme !== undefined) {
    const t = String(b.dashboardTheme ?? "").trim();
    if (t && !DASHBOARD_THEMES.includes(t)) return { error: "Choose a dashboard to show it on, or none" };
    out.dashboard_theme = t || null;
  }
  if (!existing || b.source !== undefined || b.sourceConfig !== undefined) {
    const source = String(b.source ?? existing?.source ?? "manual");
    const raw = b.sourceConfig ?? existing?.source_config ?? {};
    let kobo = null;
    if (source === "kobo" && raw.formId) {
      const { data: f } = await admin.from("kobo_forms").select("id, schema").eq("id", String(raw.formId)).maybeSingle();
      if (!f) return { error: "That Kobo survey isn't attached" };
      kobo = { fields: ((f.schema as KoboSchema | null)?.fields ?? []).filter((x) => !x.repeats.length) };
    }
    const clean = cleanSourceConfig(source, raw, kobo);
    if ("error" in clean) return clean;
    out.source = source;
    out.source_config = clean.config;
    if (source === "portal" && b.unit === undefined && !existing) out.unit = PORTAL_METRICS[clean.config.metric].unit;
  }
  return out;
}

app.post("/mel/indicators", requirePermission("me.framework.manage"), async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const o = await melOutcomeOf(b.outcomeId);
  if (!o) return c.json({ error: "Outcome not found" }, 404);
  const fields = await readIndicator(b, null);
  if ("error" in fields) return c.json(fields, 400);
  const id = rid("ind");
  const { error } = await admin.from("me_indicators").insert({ id, outcome_id: o.id, position: Number(b.position) || 0, unit: "percent", direction: "increase", ...fields });
  if (error) return c.json({ error: error.message }, 400);
  await audit(c, "me.indicator_created", "me_indicator", id, { outcomeId: o.id, name: fields.name, source: fields.source });
  return c.json({ id });
});

app.patch("/mel/indicators/:id", requirePermission("me.framework.manage"), async (c) => {
  const { data: i } = await admin.from("me_indicators").select("*").eq("id", c.req.param("id")).maybeSingle();
  if (!i) return c.json({ error: "Indicator not found" }, 404);
  const b = await c.req.json().catch(() => ({}));
  const fields = await readIndicator(b, i);
  if ("error" in fields) return c.json(fields, 400);
  if (b.archived !== undefined) fields.archived_at = b.archived ? new Date().toISOString() : null;
  await admin.from("me_indicators").update({ ...fields, updated_at: new Date().toISOString() }).eq("id", i.id);
  await audit(c, "me.indicator_updated", "me_indicator", i.id, { fields: Object.keys(fields) });
  return c.json({ ok: true });
});

/* Set (or clear, with value null) a target for an indicator, period and
   scope. Every change is in the audit log, with the old and new value. */
app.put("/mel/targets", requirePermission("me.framework.manage"), async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const { data: i } = await admin.from("me_indicators").select("id").eq("id", String(b.indicatorId ?? "")).maybeSingle();
  if (!i) return c.json({ error: "Indicator not found" }, 404);
  const cal = await melCalendar();
  if (!periodRange(String(b.period ?? ""), cal.terms, cal.years)) return c.json({ error: "Choose a term or school year" }, 400);
  const scope = await melScope(b.scopeType, b.scopeId);
  if (!scope) return c.json({ error: "Choose the whole programme, a county or a school" }, 400);
  if (!melScopeAllowed(c, scope)) return c.json({ error: OUTSIDE_AREA }, 403);
  const { data: existing } = await admin.from("me_targets").select("*").eq("indicator_id", i.id).eq("period", b.period)
    .eq("scope_type", scope.type).eq("scope_id", scope.id).maybeSingle();
  if (b.value === null || b.value === "") {
    if (existing) {
      await admin.from("me_targets").delete().eq("id", existing.id);
      await audit(c, "me.target_cleared", "me_indicator", i.id, { period: b.period, scope: `${scope.type}:${scope.id}`, from: Number(existing.target_value) });
    }
    return c.json({ ok: true });
  }
  const value = Number(b.value);
  if (!Number.isFinite(value)) return c.json({ error: "The target is a number" }, 400);
  const row = { target_value: value, note: String(b.note ?? "").trim().slice(0, 1000) || null, set_by: c.get("actor").id, set_at: new Date().toISOString() };
  const { error } = existing
    ? await admin.from("me_targets").update(row).eq("id", existing.id)
    : await admin.from("me_targets").insert({ id: rid("tgt"), indicator_id: i.id, period: b.period, scope_type: scope.type, scope_id: scope.id, ...row });
  if (error) return c.json({ error: error.message }, 400);
  await audit(c, "me.target_set", "me_indicator", i.id, { period: b.period, scope: `${scope.type}:${scope.id}`, from: existing ? Number(existing.target_value) : null, to: value });
  return c.json({ ok: true });
});

// ---- results, actuals, evidence ----

/** The place picked in the dashboard filters: ?school= (name) or ?county=. */
// deno-lint-ignore no-explicit-any
async function melScopeFromQuery(c: any): Promise<MelScope | null> {
  const schoolName = String(c.req.query("school") ?? "").trim();
  if (schoolName) {
    const { data: s } = await admin.from("schools").select("id").eq("name", schoolName).maybeSingle();
    return s ? await melScope("school", s.id) : null;
  }
  if (c.req.query("county")) return await melScope("county", c.req.query("county"));
  return await melScope("programme", "");
}

/** For someone narrowed to an area: only a county assigned whole, or a
    school in scope — never the whole programme. */
// deno-lint-ignore no-explicit-any
function melScopeAllowed(c: any, m: MelScope): boolean {
  const sc = scopeOf(c);
  if (sc.global) return true;
  if (m.type === "county") return sc.counties.has(String(m.id).toLowerCase());
  if (m.type === "school") return sc.schoolIds.has(String(m.id));
  return false;
}
const OUTSIDE_AREA = "Choose a county or school in your area";

/* ?period= &county= &school= (name, like the dashboard filters) */
app.get("/mel/programmes/:id/results", requirePermission("me.view"), async (c) => {
  const scope = await melScopeFromQuery(c);
  if (!scope) return c.json({ error: "That county or school isn't in the portal" }, 400);
  if (!melScopeAllowed(c, scope)) return c.json({ error: OUTSIDE_AREA }, 403);
  try {
    const res = await melResults(c.req.param("id"), String(c.req.query("period") ?? ""), scope);
    if ("error" in res) return c.json({ error: res.error }, res.status);
    return c.json(res);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

/* The M&E dashboard: every indicator in the active programmes — or only
   those tagged for one impact dashboard (?theme=) — for a period (default:
   the current term) and place (?county= / ?school=): target, value
   (recorded, else live) and achievement. */
app.get("/mel/dashboard", requirePermission("me.view"), async (c) => {
  const scope = await melScopeFromQuery(c);
  if (!scope) return c.json({ error: "That county or school isn't in the portal" }, 400);
  if (!melScopeAllowed(c, scope)) return c.json({ error: OUTSIDE_AREA }, 403);
  const theme = String(c.req.query("theme") ?? "").trim();
  if (theme && !DASHBOARD_THEMES.includes(theme)) return c.json({ error: "Unknown dashboard" }, 400);
  const cal = await melCalendar();
  const terms = cal.periods.filter((p) => /-T\d$/.test(p.id));
  const period = String(c.req.query("period") ?? "") || (terms.find((p) => p.current) ?? terms.at(-1))?.id || "";
  const range = periodRange(period, cal.terms, cal.years);
  const summary = { met: 0, close: 0, not_met: 0, no_data: 0 };
  const empty = { periods: cal.periods, period: range ? { id: period, label: range.label } : null, scope: { type: scope.type, id: scope.id, label: scope.label }, indicators: [], summary };
  if (!range) return c.json(empty);
  const { data: programmes } = await selectAll(() => admin.from("me_programmes").select("id, code, name, status").order("id"));
  const progs = (programmes ?? []).filter((p) => p.status === "active");
  if (!progs.length) return c.json(empty);
  const outcomes = (await selectIn("me_outcomes", "programme_id", progs.map((p) => p.id as string))).filter((o) => !o.archived_at);
  const indicators = outcomes.length
    ? (await selectIn("me_indicators", "outcome_id", outcomes.map((o) => o.id as string))).filter((i) => !i.archived_at && (!theme || i.dashboard_theme === theme))
    : [];
  if (!indicators.length) return c.json(empty);
  const ids = indicators.map((i) => i.id as string);
  let targets, actuals, live;
  try {
    [targets, actuals, live] = await Promise.all([
      selectIn("me_targets", "indicator_id", ids), selectIn("me_actuals", "indicator_id", ids), melLive(indicators, range, [scope]),
    ]);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
  const outcomeOf = new Map(outcomes.map((o) => [o.id, o]));
  const progOf = new Map(progs.map((p) => [p.id, p]));
  const rows = indicators.map((i) => {
    const o = outcomeOf.get(i.outcome_id)!;
    const p = progOf.get(o.programme_id)!;
    const rec = actuals.find((a) => !a.superseded_at && a.indicator_id === i.id && a.period === period && a.scope_type === scope.type && (a.scope_id ?? "") === scope.id);
    const lv = live.get(`${i.id}|${scope.type}|${scope.id}`) ?? null;
    const tgt = targetFor(targets, i.id, period, scope);
    const value = rec && rec.status !== "rejected" && rec.value != null ? Number(rec.value) : lv?.value ?? null;
    const ach = achievement(value, tgt?.value ?? null, i.direction);
    summary[ach.status]++;
    return {
      ...mapIndicator(i),
      programme: { id: p.id, name: p.name }, outcome: { id: o.id, code: o.code, title: o.title },
      target: tgt ? { value: tgt.value, from: tgt.from } : null,
      value, valueSource: rec && rec.status !== "rejected" ? rec.status : lv?.value != null ? "live" : "none",
      detail: lv ? { numerator: lv.numerator ?? null, denominator: lv.denominator ?? null, n: lv.n ?? null, method: lv.method } : null,
      achievement: ach,
      sort: [String(p.name), Number(o.position) || 0, String(o.code), Number(i.position) || 0, String(i.code)],
    };
  }).sort((a, b) => {
    for (let k = 0; k < a.sort.length; k++) {
      const x = a.sort[k], y = b.sort[k];
      const d = typeof x === "number" ? x - (y as number) : String(x).localeCompare(String(y), undefined, { numeric: true });
      if (d) return d;
    }
    return 0;
  }).map(({ sort: _s, ...r }) => r);
  return c.json({ ...empty, indicators: rows, summary });
});

/* One indicator over time, for the place picked (?county= / ?school=):
   each term so far — the value (recorded, else live) against its target. */
app.get("/mel/indicators/:id/trend", requirePermission("me.view"), async (c) => {
  const { data: i } = await admin.from("me_indicators").select("*").eq("id", c.req.param("id")).maybeSingle();
  if (!i) return c.json({ error: "Indicator not found" }, 404);
  const scope = await melScopeFromQuery(c);
  if (!scope) return c.json({ error: "That county or school isn't in the portal" }, 400);
  if (!melScopeAllowed(c, scope)) return c.json({ error: OUTSIDE_AREA }, 403);
  const cal = await melCalendar();
  const today = new Date().toISOString().slice(0, 10);
  const terms = cal.terms.filter((t: Record<string, any>) => String(t.starts_on) <= today).slice(-9);
  const [targets, actuals] = await Promise.all([selectIn("me_targets", "indicator_id", [i.id]), selectIn("me_actuals", "indicator_id", [i.id])]);
  let loaded;
  try { loaded = await melLoad([i]); } catch (e) { return c.json({ error: (e as Error).message }, 500); }
  const points = terms.map((t: Record<string, any>) => {
    const range = periodRange(t.id, cal.terms, cal.years)!;
    const lv = melCompute(loaded, [i], range, [scope]).get(`${i.id}|${scope.type}|${scope.id}`) ?? null;
    const rec = actuals.find((a) => !a.superseded_at && a.period === t.id && a.scope_type === scope.type && (a.scope_id ?? "") === scope.id);
    const tgt = targetFor(targets, i.id, t.id, scope);
    const value = rec && rec.status !== "rejected" && rec.value != null ? Number(rec.value) : lv?.value ?? null;
    return {
      period: t.id, label: range.label, target: tgt?.value ?? null, value,
      valueSource: rec && rec.status !== "rejected" ? rec.status : lv?.value != null ? "live" : "none",
      achievement: achievement(value, tgt?.value ?? null, i.direction),
    };
  });
  return c.json({ indicator: mapIndicator(i), scope: { type: scope.type, id: scope.id, label: scope.label }, points });
});

/* One indicator in one period, by county and by school: target, live and recorded. */
app.get("/mel/indicators/:id/breakdown", requirePermission("me.view"), async (c) => {
  const { data: i } = await admin.from("me_indicators").select("*").eq("id", c.req.param("id")).maybeSingle();
  if (!i) return c.json({ error: "Indicator not found" }, 404);
  const period = String(c.req.query("period") ?? "");
  const cal = await melCalendar();
  const range = periodRange(period, cal.terms, cal.years);
  if (!range) return c.json({ error: "Choose a term or school year" }, 400);
  const [counties, { data: schools }, targets, actuals] = await Promise.all([
    loadCounties().catch(() => [] as County[]),
    selectAll(() => admin.from("schools").select("id, name, code, county").order("id")),
    selectIn("me_targets", "indicator_id", [i.id]),
    selectIn("me_actuals", "indicator_id", [i.id]),
  ]);
  const scopes: MelScope[] = [
    { type: "programme", id: "", label: "Whole programme" },
    ...counties.map((x) => ({ type: "county" as const, id: x.name, label: `${x.name} County`, county: x.name })),
    ...(schools ?? []).map((s) => ({ type: "school" as const, id: s.id as string, label: `${s.name} (${s.code})`, schoolName: s.name as string, county: s.county as string })),
  ];
  let live: Map<string, Computed>;
  try { live = await melLive([i], range, scopes); } catch (e) { return c.json({ error: (e as Error).message }, 500); }
  return c.json({
    indicator: mapIndicator(i), period: { id: period, label: range.label },
    rows: scopes.filter((s) => melScopeAllowed(c, s)).map((s) => {
      const rec = actuals.find((a) => !a.superseded_at && a.period === period && a.scope_type === s.type && (a.scope_id ?? "") === s.id);
      const lv = live.get(`${i.id}|${s.type}|${s.id}`) ?? null;
      const tgt = targetFor(targets, i.id, period, s);
      const value = rec && rec.status !== "rejected" && rec.value != null ? Number(rec.value) : lv?.value ?? null;
      return {
        scopeType: s.type, scopeId: s.id, label: s.label, county: s.county ?? null,
        target: tgt ? { value: tgt.value, from: tgt.from } : null, live: lv,
        recorded: rec ? { id: rec.id, value: rec.value == null ? null : Number(rec.value), status: rec.status } : null,
        value, achievement: achievement(value, tgt?.value ?? null, i.direction),
      };
    }),
  });
});

/* Record an actual: a snapshot of the value now and how it was worked
   out (computed sources), or the value someone enters (manual). It replaces
   any earlier version for the same indicator, period and scope — which is
   kept, marked superseded. Evidence for computed values is attached
   automatically. */
app.post("/mel/actuals", requirePermission("me.actuals.record"), async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const { data: i } = await admin.from("me_indicators").select("*").eq("id", String(b.indicatorId ?? "")).maybeSingle();
  if (!i || i.archived_at) return c.json({ error: "Indicator not found" }, 404);
  const cal = await melCalendar();
  const period = String(b.period ?? "");
  const range = periodRange(period, cal.terms, cal.years);
  if (!range) return c.json({ error: "Choose a term or school year" }, 400);
  const scope = await melScope(b.scopeType, b.scopeId);
  if (!scope) return c.json({ error: "Choose the whole programme, a county or a school" }, 400);
  if (!melScopeAllowed(c, scope)) return c.json({ error: OUTSIDE_AREA }, 403);
  const note = String(b.note ?? "").trim().slice(0, 2000) || null;
  let snap: Computed;
  if (i.source === "manual") {
    const value = Number(b.value);
    if (b.value === undefined || b.value === null || b.value === "" || !Number.isFinite(value)) return c.json({ error: "Enter the value" }, 400);
    const num = b.numerator === undefined || b.numerator === "" ? null : Number(b.numerator);
    const den = b.denominator === undefined || b.denominator === "" ? null : Number(b.denominator);
    if ((num != null && !Number.isFinite(num)) || (den != null && !Number.isFinite(den))) return c.json({ error: "Numerator and denominator are numbers" }, 400);
    snap = { value, numerator: num, denominator: den, n: den ?? 0, method: "Entered by hand" };
  } else {
    let live: Map<string, Computed>;
    try { live = await melLive([i], range, [scope]); } catch (e) { return c.json({ error: (e as Error).message }, 500); }
    const v = live.get(`${i.id}|${scope.type}|${scope.id}`);
    if (!v || v.value == null) return c.json({ error: "There's no data to record for this period and scope yet" }, 409);
    snap = v;
  }
  const actorId = c.get("actor").id;
  const now = new Date().toISOString();
  const { data: prev } = await admin.from("me_actuals").select("id").eq("indicator_id", i.id).eq("period", period)
    .eq("scope_type", scope.type).eq("scope_id", scope.id).is("superseded_at", null).maybeSingle();
  if (prev) await admin.from("me_actuals").update({ superseded_at: now }).eq("id", prev.id);
  const id = rid("act");
  const { error } = await admin.from("me_actuals").insert({
    id, indicator_id: i.id, period, scope_type: scope.type, scope_id: scope.id,
    value: snap.value, numerator: snap.numerator, denominator: snap.denominator, n: snap.n,
    source: i.source, method: snap.method, note, status: "recorded", recorded_by: actorId, recorded_at: now,
  });
  if (error) {
    if (prev) await admin.from("me_actuals").update({ superseded_at: null }).eq("id", prev.id);
    return c.json({ error: error.message }, 400);
  }
  if (prev) await admin.from("me_actuals").update({ superseded_by: id }).eq("id", prev.id);
  // Evidence that comes with a computed value.
  if (i.source === "kobo") {
    const { data: f } = await admin.from("kobo_forms").select("id, title").eq("id", i.source_config?.formId).maybeSingle();
    await admin.from("me_evidence").insert({
      id: rid("evd"), actual_id: id, kind: "kobo_form", title: f?.title ?? "Kobo survey", kobo_form_id: f?.id ?? null, record_count: snap.n,
      details: { measure: i.source_config?.measure, question: i.source_config?.questionLabel ?? i.source_config?.question ?? null, choices: i.source_config?.choices ?? null,
        numerator: snap.numerator, denominator: snap.denominator, period: range.label, scope: scope.label, validated: true },
      added_by: actorId,
    });
  } else if (i.source === "portal") {
    await admin.from("me_evidence").insert({
      id: rid("evd"), actual_id: id, kind: "portal_data", title: PORTAL_METRICS[i.source_config?.metric]?.label ?? "Portal data",
      details: { method: snap.method, numerator: snap.numerator, denominator: snap.denominator, n: snap.n, period: range.label, scope: scope.label },
      added_by: actorId,
    });
  }
  await audit(c, "me.actual_recorded", "me_indicator", i.id, {
    actualId: id, period, scope: `${scope.type}:${scope.id}`, value: snap.value, source: i.source, replaced: prev?.id ?? null,
  });
  return c.json({ id, value: snap.value });
});

/* Verification: someone other than the person who recorded it confirms it
   (or rejects it, with a reason). */
app.post("/mel/actuals/:id/verify", requirePermission("me.actuals.verify"), async (c) => {
  const { data: a } = await admin.from("me_actuals").select("*").eq("id", c.req.param("id")).maybeSingle();
  if (!a) return c.json({ error: "Actual not found" }, 404);
  if (a.superseded_at) return c.json({ error: "A newer version has been recorded — verify that one" }, 409);
  if (a.status !== "recorded") return c.json({ error: `This actual is already ${a.status}` }, 409);
  if (a.recorded_by === c.get("actor").id) return c.json({ error: "Someone other than the person who recorded it must verify it" }, 403);
  const b = await c.req.json().catch(() => ({}));
  const decision = String(b.decision ?? "");
  if (!["verified", "rejected"].includes(decision)) return c.json({ error: "Decision is verified or rejected" }, 400);
  const note = String(b.note ?? "").trim().slice(0, 2000);
  if (decision === "rejected" && note.length < 3) return c.json({ error: "Say why it's rejected" }, 400);
  await admin.from("me_actuals").update({
    status: decision, verified_by: c.get("actor").id, verified_at: new Date().toISOString(), verification_note: note || null,
  }).eq("id", a.id);
  await audit(c, `me.actual_${decision}`, "me_indicator", a.indicator_id, { actualId: a.id, period: a.period, scope: `${a.scope_type}:${a.scope_id}`, value: a.value, note: note || undefined });
  return c.json({ ok: true });
});

/* One recorded actual: its versions, verification and evidence (files signed). */
app.get("/mel/actuals/:id", requirePermission("me.view"), async (c) => {
  const { data: a } = await admin.from("me_actuals").select("*").eq("id", c.req.param("id")).maybeSingle();
  if (!a) return c.json({ error: "Actual not found" }, 404);
  const { data: versions } = await admin.from("me_actuals").select("*").eq("indicator_id", a.indicator_id).eq("period", a.period)
    .eq("scope_type", a.scope_type).eq("scope_id", a.scope_id);
  const vs = (versions ?? []).sort((x: Record<string, any>, y: Record<string, any>) => String(y.recorded_at).localeCompare(String(x.recorded_at)));
  const evidence = await selectIn("me_evidence", "actual_id", vs.map((v: Record<string, any>) => v.id as string));
  const people = await dqNames(vs.flatMap((v: Record<string, any>) => [v.recorded_by, v.verified_by]).concat(evidence.map((e) => e.added_by)));
  return c.json({
    versions: await Promise.all(vs.map(async (v: Record<string, any>) => ({
      id: v.id, value: v.value == null ? null : Number(v.value), numerator: v.numerator == null ? null : Number(v.numerator),
      denominator: v.denominator == null ? null : Number(v.denominator), n: v.n, method: v.method, note: v.note, status: v.status,
      recordedBy: people.get(v.recorded_by) ?? null, recordedAt: v.recorded_at, current: !v.superseded_at,
      verifiedBy: v.verified_by ? people.get(v.verified_by) ?? null : null, verifiedAt: v.verified_at, verificationNote: v.verification_note,
      evidence: await Promise.all(evidence.filter((e) => e.actual_id === v.id).map(async (e) => ({
        id: e.id, kind: e.kind, title: e.title, recordCount: e.record_count, url: e.url, details: e.details ?? {},
        addedBy: people.get(e.added_by) ?? null, addedAt: e.added_at,
        file: e.file?.path ? (await signFiles([e.file as LibFile], true))[0] : null,
      }))),
    }))),
  });
});

/* Evidence a person adds: a link, a note, or an uploaded file. */
app.post("/mel/actuals/:id/evidence", requirePermission("me.actuals.record"), async (c) => {
  const { data: a } = await admin.from("me_actuals").select("id, superseded_at, indicator_id").eq("id", c.req.param("id")).maybeSingle();
  if (!a) return c.json({ error: "Actual not found" }, 404);
  if (a.superseded_at) return c.json({ error: "Add evidence to the current version" }, 409);
  const b = await c.req.json().catch(() => ({}));
  const kind = String(b.kind ?? "");
  const title = String(b.title ?? "").trim().slice(0, 300);
  if (!["link", "note", "file"].includes(kind)) return c.json({ error: "Evidence is a link, a note or a file" }, 400);
  if (!title) return c.json({ error: "Give the evidence a title" }, 400);
  const row: Record<string, unknown> = { id: rid("evd"), actual_id: a.id, kind, title, added_by: c.get("actor").id, details: {} };
  if (kind === "link") {
    const url = String(b.url ?? "").trim();
    if (!/^https?:\/\/\S+$/.test(url)) return c.json({ error: "The link starts with https://" }, 400);
    row.url = url;
  }
  if (kind === "note") row.details = { text: String(b.text ?? "").trim().slice(0, 4000) };
  if (kind === "file") {
    const f = b.file ?? {};
    const prefix = `me-evidence/${a.id}/`;
    if (typeof f.path !== "string" || !f.path.startsWith(prefix) || f.path.includes("..")) return c.json({ error: "Upload the file first" }, 400);
    row.file = { name: String(f.name ?? "file").slice(0, 200), path: f.path, size: Number(f.size) || 0 };
  }
  const { error } = await admin.from("me_evidence").insert(row);
  if (error) return c.json({ error: error.message }, 400);
  await audit(c, "me.evidence_added", "me_indicator", a.indicator_id, { actualId: a.id, kind, title });
  return c.json({ id: row.id });
});

app.post("/mel/actuals/:id/evidence-upload", requirePermission("me.actuals.record"), async (c) => {
  const { data: a } = await admin.from("me_actuals").select("id, superseded_at").eq("id", c.req.param("id")).maybeSingle();
  if (!a || a.superseded_at) return c.json({ error: "Actual not found" }, 404);
  const b = await c.req.json().catch(() => ({}));
  const name = String(b.name ?? "").trim();
  if (!name) return c.json({ error: "Missing file name" }, 400);
  if (Number(b.size) > 50 * 1024 * 1024) return c.json({ error: "Files can be up to 50 MB" }, 400);
  const path = `me-evidence/${a.id}/${rid("f")}/${safePath(name)}`;
  const { data, error } = await admin.storage.from(LIBRARY_BUCKET).createSignedUploadUrl(path);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ upload: { name, path, token: data.token, signedUrl: data.signedUrl, size: Number(b.size) || 0 } });
});

// ---- reports ----

const mapMelReport = (r: Record<string, any>, people: Map<string, string>) => ({
  id: r.id, programmeId: r.programme_id, period: r.period, scopeType: r.scope_type, scopeId: r.scope_id, title: r.title,
  status: r.status, generatedAt: r.generated_at, generatedBy: people.get(r.generated_by) ?? null,
  finalizedAt: r.finalized_at ?? null, finalizedBy: r.finalized_by ? people.get(r.finalized_by) ?? null : null, note: r.note ?? null,
});

app.get("/mel/reports", requirePermission("me.view"), async (c) => {
  const { data } = await selectAll(() => {
    let q = admin.from("me_reports").select("id, programme_id, period, scope_type, scope_id, title, status, generated_at, generated_by, finalized_at, finalized_by, note").order("id");
    if (c.req.query("programmeId")) q = q.eq("programme_id", String(c.req.query("programmeId")));
    return q;
  });
  const people = await dqNames((data ?? []).flatMap((r) => [r.generated_by, r.finalized_by]));
  return c.json({ reports: (data ?? []).sort((a, b) => String(b.generated_at).localeCompare(String(a.generated_at))).map((r) => mapMelReport(r, people)) });
});

/* A report: the results for a programme, period and scope, frozen as they
   are now. A draft can be refreshed; a final one never changes. */
app.post("/mel/reports", requirePermission("me.reports.manage"), async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const scope = await melScope(b.scopeType, b.scopeId);
  if (!scope) return c.json({ error: "Choose the whole programme, a county or a school" }, 400);
  if (!melScopeAllowed(c, scope)) return c.json({ error: OUTSIDE_AREA }, 403);
  let res;
  try { res = await melResults(String(b.programmeId ?? ""), String(b.period ?? ""), scope); } catch (e) { return c.json({ error: (e as Error).message }, 500); }
  if ("error" in res) return c.json({ error: res.error }, res.status);
  const id = rid("rpt");
  const title = String(b.title ?? "").trim().slice(0, 200) || `${res.programme.name} — ${res.period.label} — ${scope.label}`;
  const { error } = await admin.from("me_reports").insert({
    id, programme_id: res.programme.id, period: res.period.id, scope_type: scope.type, scope_id: scope.id, title, status: "draft",
    content: res, generated_by: c.get("actor").id, generated_at: new Date().toISOString(),
  });
  if (error) return c.json({ error: error.message }, 400);
  await audit(c, "me.report_generated", "me_report", id, { programmeId: res.programme.id, period: res.period.id, scope: `${scope.type}:${scope.id}` });
  return c.json({ id });
});

app.get("/mel/reports/:id", requirePermission("me.view"), async (c) => {
  const { data: r } = await admin.from("me_reports").select("*").eq("id", c.req.param("id")).maybeSingle();
  if (!r) return c.json({ error: "Report not found" }, 404);
  const people = await dqNames([r.generated_by, r.finalized_by]);
  return c.json({ report: mapMelReport(r, people), content: r.content });
});

app.post("/mel/reports/:id/refresh", requirePermission("me.reports.manage"), async (c) => {
  const { data: r } = await admin.from("me_reports").select("*").eq("id", c.req.param("id")).maybeSingle();
  if (!r) return c.json({ error: "Report not found" }, 404);
  if (r.status === "final") return c.json({ error: "A final report can't change" }, 409);
  const scope = await melScope(r.scope_type, r.scope_id);
  if (!scope) return c.json({ error: "That county or school no longer exists" }, 409);
  if (!melScopeAllowed(c, scope)) return c.json({ error: OUTSIDE_AREA }, 403);
  const res = await melResults(r.programme_id, r.period, scope);
  if ("error" in res) return c.json({ error: res.error }, res.status);
  const { error } = await admin.from("me_reports").update({ content: res, generated_by: c.get("actor").id, generated_at: new Date().toISOString() }).eq("id", r.id);
  if (error) return c.json({ error: error.message }, 400);
  await audit(c, "me.report_refreshed", "me_report", r.id, {});
  return c.json({ ok: true });
});

app.post("/mel/reports/:id/finalize", requirePermission("me.reports.manage"), async (c) => {
  const { data: r } = await admin.from("me_reports").select("*").eq("id", c.req.param("id")).maybeSingle();
  if (!r) return c.json({ error: "Report not found" }, 404);
  if (r.status === "final") return c.json({ error: "This report is already final" }, 409);
  const b = await c.req.json().catch(() => ({}));
  const note = String(b.note ?? "").trim().slice(0, 2000) || null;
  const { error } = await admin.from("me_reports").update({ status: "final", finalized_by: c.get("actor").id, finalized_at: new Date().toISOString(), note }).eq("id", r.id);
  if (error) return c.json({ error: error.message }, 400);
  await audit(c, "me.report_finalized", "me_report", r.id, { note });
  return c.json({ ok: true });
});

// ---- staff accounts: invitations, approval, roles, status, audit ----
// Who may do what is in permissions.ts (users.* and audit.view). On top of
// the permission, every change to an account also needs authority over it:
// never your own account, never one at or above your own level (a Super
// Admin may manage other Super Admins), and a role can only be given by
// someone allowed to grant it. The portal always keeps at least one
// active Super Admin.
//
// Passwords are one-way hashed in auth.users — never readable, by anyone,
// including this service-role key. "Reset" means setting a *new* one.

const mapUserRow = (r: Record<string, unknown>) => ({
  id: r.id,
  role: r.role,
  roleLabel: ROLE_LABEL[r.role as Role] ?? r.role,
  fullName: r.full_name,
  email: r.email,
  school: r.school,
  county: r.county,
  schoolId: r.school_id ?? null,
  userCode: r.user_code ?? null,
  teacherType: r.teacher_type ?? null,
  gender: r.gender ?? null,
  createdAt: r.created_at,
  status: r.status ?? "active",
  statusReason: r.status_reason ?? null,
  statusChangedAt: r.status_changed_at ?? null,
  requestedRole: r.requested_role ?? null,
  approvedAt: r.approved_at ?? null,
  invitedBy: r.invited_by ?? null,
  mustChangePassword: !!r.must_change_password,
  temporaryPasswordAt: r.must_change_password ? r.temporary_password_at ?? null : null,
  passwordChangedAt: r.password_changed_at ?? null,
});

/** Loads the account named in :id and checks the caller has authority
    over it. Returns the row, or the response refusing the request. */
// deno-lint-ignore no-explicit-any
async function loadManagedAccount(c: any): Promise<Record<string, any> | Response> {
  const { data: target } = await admin.from("profiles").select("*").eq("id", c.req.param("id")).maybeSingle();
  if (!target || !inScope(c, target.school_id, target.county)) return c.json({ error: "User not found" }, 404);
  if (!canManageAccount(c.get("actor"), target)) {
    return c.json({ error: "You can't change this account — it's your own, or at or above your level." }, 403);
  }
  return target;
}

/** True when removing this account's Super Admin role or active status
    would leave nobody able to administer the portal. */
async function isLastActiveSuperAdmin(target: Record<string, unknown>) {
  if (target.role !== "super_admin" || (target.status ?? "active") !== "active") return false;
  const { count } = await admin.from("profiles").select("id", { count: "exact", head: true })
    .eq("role", "super_admin").eq("status", "active");
  return (count ?? 0) <= 1;
}
const LAST_SUPER_ADMIN = "This is the last active Super Admin. Make someone else Super Admin first.";

/* Someone narrowed to an area only places people inside it, and only in
   roles that belong to a place — never a programme-wide role, which would
   see more than they do. */
const PLACE_ROLES = ["teacher", "school_leader", "field_officer"];
// deno-lint-ignore no-explicit-any
function placementAllowed(c: any, role: string, place: { school: School | null; county: string }): boolean {
  const sc = scopeOf(c);
  if (sc.global) return true;
  if (!PLACE_ROLES.includes(role)) return false;
  return place.school ? sc.schoolIds.has(place.school.id) : sc.counties.has(place.county.toLowerCase());
}
const OUTSIDE_YOUR_AREA = "You can only place people in your own area, in a school or field role.";

/** Blocks or unblocks signing in at Supabase Auth itself, on top of the
    status check every API route makes. */
async function setSignInBlocked(userId: string, blocked: boolean) {
  const { error } = await admin.auth.admin.updateUserById(userId, { ban_duration: blocked ? "876000h" : "none" });
  if (error) console.error("could not update sign-in block:", userId, error.message);
}

/** Validates where an account with this role sits. Returns the school (for
    teachers/heads), the county, or the error to show. */
async function resolvePlacement(role: string, schoolId: unknown, county: unknown):
  Promise<{ school: School | null; county: string } | { error: string }> {
  if (SCHOOL_ROLES.includes(role)) {
    const school = await loadSchool(schoolId);
    if (!school) return { error: "Choose a county and school for this account" };
    return { school, county: school.county };
  }
  if (COUNTY_ROLES.includes(role as never)) {
    const c = String(county ?? "").trim();
    if (!(await isCounty(c))) return { error: "Choose a county for this field officer" };
    return { school: null, county: c };
  }
  return { school: null, county: "" };
}

app.get("/users", requirePermission("users.view"), async (c) => {
  const actor = c.get("actor");
  const [{ data, error }, signIns, scopes, { data: grants }] = await Promise.all([
    selectAll(() => admin.from("profiles").select("*").order("created_at", { ascending: false }).order("id")),
    authUsers(),
    scopeLabels(),
    admin.from("permission_grants").select("profile_id, permission").is("revoked_at", null),
  ]);
  if (error) return c.json({ error: error.message }, 500);
  // Someone narrowed to an area sees the people placed in it.
  const rows = (data ?? []).filter((r) => inScope(c, r.school_id, r.county));
  return c.json({
    users: rows.map((r) => {
      const sc = scopes.get(r.id as string);
      return {
        ...mapUserRow(r), canManage: canManageAccount(actor, r as { id: string; role: string }),
        lastSignInAt: signIns.get(r.id as string)?.lastSignInAt ?? null,
        scope: sc ? { global: sc.global, label: sc.label } : null,
        grants: (grants ?? []).filter((g) => g.profile_id === r.id).map((g) => g.permission),
      };
    }),
    grantableRoles: grantableRoles(actor.role).map((r) => ({ value: r, label: ROLE_LABEL[r] })),
    statuses: ACCOUNT_STATUSES,
  });
});

/* ---- invitations ----
   An invitation is a one-time link (only its hash is kept). The
   administrator copies it and sends it themselves, or has the portal email
   it (mail.ts) — the same link either way. */

/* The portal's own addresses (PORTAL_URLS secret, comma-separated; the two
   live sites by default). Links the server puts in an email or a reset
   redirect only ever point at one of these. */
const PORTAL_URLS = (Deno.env.get("PORTAL_URLS") ?? "https://learning-portal-mu-two.vercel.app/,https://khaima.github.io/Learning-portal/")
  .split(",").map((s) => s.trim()).filter(Boolean);
/** The portal address the browser asked for (its folder, or its index.html), if it's one of ours; else the first. */
function portalBase(asked: unknown): string {
  const bases = PORTAL_URLS.map((u) => new URL(u.endsWith("/") ? u : u + "/"));
  try {
    const u = new URL(String(asked ?? ""));
    const hit = bases.find((b) => u.origin === b.origin && (u.pathname === b.pathname || u.pathname === b.pathname + "index.html"));
    if (hit) return `${hit.origin}${hit.pathname}`;
  } catch { /* not a URL: the default below */ }
  return `${bases[0].origin}${bases[0].pathname}`;
}

/* Email an invitation's link. The invitation stands whether or not the
   email goes — the administrator can still copy the link. */
// deno-lint-ignore no-explicit-any
async function emailInvitation(c: any, inv: Record<string, any>, token: string, portalUrl: unknown): Promise<{ emailed: boolean; emailError?: string }> {
  if (!mailReady()) {
    return { emailed: false, emailError: "Email sending isn't set up for the portal yet — copy the link and send it yourself." };
  }
  const school = inv.school_id ? await loadSchool(inv.school_id) : null;
  const place = school ? `${school.name} (${school.code})` : inv.county ? `${inv.county} County` : null;
  const message = invitationEmail({
    link: `${portalBase(portalUrl)}index.html?invite=${encodeURIComponent(token)}`,
    roleLabel: ROLE_LABEL[inv.role as Role] ?? inv.role, place,
    inviterName: (c.get("actor") as Actor)?.fullName || null, expiresAt: inv.expires_at,
  });
  // Replies go to the administrator who sent it.
  const sent = await mailer({ to: inv.email, ...message, replyTo: c.get("email") || null });
  if (!sent.ok) return { emailed: false, emailError: `The email couldn't be sent: ${sent.error}. Copy the link and send it yourself.` };
  await audit(c, "invitation.emailed", "invitation", inv.id, { email: inv.email, role: inv.role }); // never the link
  return { emailed: true };
}

const mapInvitation = (r: Record<string, unknown>) => ({
  id: r.id,
  email: r.email,
  role: r.role,
  roleLabel: ROLE_LABEL[r.role as Role] ?? r.role,
  county: r.county ?? null,
  schoolId: r.school_id ?? null,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  status: r.accepted_at ? "accepted" : r.revoked_at ? "revoked"
    : new Date(r.expires_at as string).getTime() < Date.now() ? "expired" : "open",
});

app.get("/users/invitations", requirePermission("users.invite"), async (c) => {
  const { data, error } = await admin.from("staff_invitations").select("*")
    .order("created_at", { ascending: false }).limit(100);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({
    invitations: (data ?? []).filter((i) => inScope(c, i.school_id, i.county)).map(mapInvitation),
    // Whether "Send invitation email" can work (mail.ts); copying the link always does.
    emailReady: mailReady(),
  });
});

app.post("/users/invitations", requirePermission("users.invite"), async (c) => {
  const actor = c.get("actor");
  const b = await c.req.json().catch(() => ({}));
  const email = String(b.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return c.json({ error: "Enter a valid email address" }, 400);
  const role = String(b.role ?? "");
  if (!grantableRoles(actor.role).includes(role as never)) {
    return c.json({ error: "You can't invite someone with that role." }, 403);
  }
  const place = await resolvePlacement(role, b.schoolId, b.county);
  if ("error" in place) return c.json({ error: place.error }, 400);
  if (!placementAllowed(c, role, place)) return c.json({ error: OUTSIDE_YOUR_AREA }, 403);

  const { data: existing } = await admin.from("profiles").select("id, status").ilike("email", ilikeExact(email)).maybeSingle();
  if (existing && existing.status !== "pending") {
    return c.json({ error: "That email already has an account. Change its role on the Users page instead." }, 409);
  }

  // Re-inviting the same address replaces the earlier open invitation.
  const { data: open } = await admin.from("staff_invitations").select("id")
    .ilike("email", ilikeExact(email)).is("accepted_at", null).is("revoked_at", null);
  for (const o of open ?? []) {
    await admin.from("staff_invitations").update({ revoked_at: new Date().toISOString(), revoked_by: actor.id }).eq("id", o.id);
    await audit(c, "invitation.revoked", "invitation", o.id, { email, reason: "replaced by a new invitation" });
  }

  const token = randomBytes(24).toString("base64url");
  const { data, error } = await admin.from("staff_invitations").insert({
    id: rid("inv"),
    email,
    role,
    county: place.county || null,
    school_id: place.school?.id ?? null,
    token_hash: hashToken(token),
    invited_by: actor.id,
    expires_at: new Date(Date.now() + INVITE_TTL_DAYS * 86400_000).toISOString(),
  }).select().single();
  if (error) return c.json({ error: error.message }, 400);
  await audit(c, "invitation.created", "invitation", data.id,
    { email, role, schoolId: data.school_id, county: data.county, expiresAt: data.expires_at });
  const delivery = b.send === true ? await emailInvitation(c, data, token, b.portalUrl) : { emailed: false };
  // The token is returned once, here, to build the link — it is never stored.
  c.header("Cache-Control", "no-store");
  return c.json({ invitation: mapInvitation(data), token, ...delivery });
});

/* A fresh link for an invitation not yet used — to email again, or to copy
   again. Only the link's hash is kept, so the earlier link can't be shown
   again: it stops working now, and the new one runs 14 days from today. */
app.post("/users/invitations/:id/renew", requirePermission("users.invite"), async (c) => {
  const actor = c.get("actor");
  const { data: inv } = await admin.from("staff_invitations").select("*").eq("id", c.req.param("id")).maybeSingle();
  if (!inv || !inScope(c, inv.school_id, inv.county)) return c.json({ error: "Invitation not found" }, 404);
  if (!grantableRoles(actor.role).includes(inv.role)) {
    return c.json({ error: "You can't renew an invitation for that role." }, 403);
  }
  if (inv.accepted_at || inv.revoked_at) return c.json({ error: "That invitation is already used or revoked." }, 409);
  const { data: existing } = await admin.from("profiles").select("id, status").ilike("email", ilikeExact(inv.email)).maybeSingle();
  if (existing && existing.status !== "pending") {
    return c.json({ error: "That email already has an account. Change its role on the Users page instead." }, 409);
  }
  const b = await c.req.json().catch(() => ({}));
  const token = randomBytes(24).toString("base64url");
  const { data, error } = await admin.from("staff_invitations").update({
    token_hash: hashToken(token),
    expires_at: new Date(Date.now() + INVITE_TTL_DAYS * 86400_000).toISOString(),
  }).eq("id", inv.id).is("accepted_at", null).is("revoked_at", null).select().single();
  if (error || !data) return c.json({ error: "That invitation is already used or revoked." }, 409);
  await audit(c, "invitation.renewed", "invitation", inv.id,
    { email: inv.email, role: inv.role, expiresAt: data.expires_at, previousExpiresAt: inv.expires_at });
  const delivery = b.send === true ? await emailInvitation(c, data, token, b.portalUrl) : { emailed: false };
  c.header("Cache-Control", "no-store");
  return c.json({ invitation: mapInvitation(data), token, ...delivery });
});

app.delete("/users/invitations/:id", requirePermission("users.invite"), async (c) => {
  const actor = c.get("actor");
  const { data: inv } = await admin.from("staff_invitations").select("*").eq("id", c.req.param("id")).maybeSingle();
  if (!inv || !inScope(c, inv.school_id, inv.county)) return c.json({ error: "Invitation not found" }, 404);
  if (!grantableRoles(actor.role).includes(inv.role)) {
    return c.json({ error: "You can't revoke an invitation for that role." }, 403);
  }
  if (inv.accepted_at || inv.revoked_at) return c.json({ error: "That invitation is already used or revoked." }, 409);
  await admin.from("staff_invitations").update({ revoked_at: new Date().toISOString(), revoked_by: actor.id }).eq("id", inv.id);
  await audit(c, "invitation.revoked", "invitation", inv.id, { email: inv.email, role: inv.role });
  return c.json({ ok: true });
});

/* ---- approval ---- */

app.post("/users/:id/approve", requirePermission("users.approve"), async (c) => {
  const actor = c.get("actor");
  const target = await loadManagedAccount(c);
  if (target instanceof Response) return target;
  const status = target.status ?? "active";
  if (!STATUS_TRANSITIONS.approve.from.includes(status)) {
    return c.json({ error: `Only a pending or rejected account can be approved (this one is ${status}).` }, 409);
  }
  const b = await c.req.json().catch(() => ({}));
  const role = String(b.role ?? target.requested_role ?? target.role);
  if (!grantableRoles(actor.role).includes(role as never)) {
    return c.json({ error: "You can't approve an account with that role." }, 403);
  }
  const place = await resolvePlacement(role, b.schoolId ?? target.school_id, b.county ?? target.county);
  if ("error" in place) return c.json({ error: place.error }, 400);
  if (!placementAllowed(c, role, place)) return c.json({ error: OUTSIDE_YOUR_AREA }, 403);

  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    role, status: "active", status_reason: null,
    approved_at: now, approved_by: actor.id, status_changed_at: now, status_changed_by: actor.id,
    county: place.county, teacher_type: role === "teacher" ? target.teacher_type : null,
  };
  if (!place.school) Object.assign(patch, { school: "", school_id: null, user_code: null });
  const res = await admin.from("profiles").update(patch).eq("id", target.id).select().single();
  if (res.error) return c.json({ error: res.error.message }, 400);
  let row = res.data;
  if (place.school && (row.school_id !== place.school.id || !row.user_code || role !== target.role)) {
    try { row = await placeInSchool("profiles", target.id, place.school, role); } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  }
  await setSignInBlocked(target.id, false);
  await audit(c, "account.approved", "profile", target.id,
    { role, requestedRole: target.requested_role ?? null, previousStatus: status,
      schoolId: place.school?.id ?? null, county: place.county });
  if (role !== target.role) await audit(c, "role.changed", "profile", target.id, { from: target.role, to: role, via: "approval" });
  if ((place.school?.id ?? null) !== (target.school_id ?? null)) {
    await audit(c, "school.changed", "profile", target.id, { from: target.school_id ?? null, to: place.school?.id ?? null, via: "approval" });
  }
  return c.json({ user: mapUserRow(row) });
});

app.post("/users/:id/reject", requirePermission("users.approve"), async (c) => {
  const actor = c.get("actor");
  const target = await loadManagedAccount(c);
  if (target instanceof Response) return target;
  const status = target.status ?? "active";
  if (!STATUS_TRANSITIONS.reject.from.includes(status)) {
    return c.json({ error: `Only a pending account can be rejected (this one is ${status}).` }, 409);
  }
  const b = await c.req.json().catch(() => ({}));
  const reason = String(b.reason ?? "").trim().slice(0, 500) || null;
  const now = new Date().toISOString();
  const res = await admin.from("profiles").update({
    status: "rejected", status_reason: reason, status_changed_at: now, status_changed_by: actor.id,
  }).eq("id", target.id).select().single();
  if (res.error) return c.json({ error: res.error.message }, 400);
  await audit(c, "account.rejected", "profile", target.id, { requestedRole: target.requested_role ?? target.role, reason });
  return c.json({ user: mapUserRow(res.data) });
});

/* ---- suspend / deactivate / reactivate ---- */

app.post("/users/:id/status", requirePermission("users.status.manage"), async (c) => {
  const actor = c.get("actor");
  const target = await loadManagedAccount(c);
  if (target instanceof Response) return target;
  const b = await c.req.json().catch(() => ({}));
  const action = String(b.action ?? "");
  if (!["suspend", "deactivate", "reactivate"].includes(action)) {
    return c.json({ error: "Action must be suspend, deactivate or reactivate" }, 400);
  }
  const rule = STATUS_TRANSITIONS[action];
  const status = target.status ?? "active";
  if (!rule.from.includes(status)) {
    return c.json({ error: `A ${status} account can't be ${action === "reactivate" ? "reactivated" : action + "d"}.` }, 409);
  }
  if (rule.to !== "active" && await isLastActiveSuperAdmin(target)) return c.json({ error: LAST_SUPER_ADMIN }, 409);
  const reason = String(b.reason ?? "").trim().slice(0, 500) || null;
  const now = new Date().toISOString();
  const res = await admin.from("profiles").update({
    status: rule.to, status_reason: rule.to === "active" ? null : reason,
    status_changed_at: now, status_changed_by: actor.id,
  }).eq("id", target.id).select().single();
  if (res.error) return c.json({ error: res.error.message }, 400);
  await setSignInBlocked(target.id, rule.to !== "active");
  await audit(c, `account.${action === "reactivate" ? "reactivated" : action + "d"}`, "profile", target.id,
    { from: status, to: rule.to, reason });
  return c.json({ user: mapUserRow(res.data) });
});

/* ---- edit an account: details, role, placement ---- */

app.patch("/users/:id", requirePermission("users.edit", "users.roles.assign", "users.placement.assign"), async (c) => {
  const actor = c.get("actor");
  const existing = await loadManagedAccount(c);
  if (existing instanceof Response) return existing;
  const id = existing.id as string;
  const b = await c.req.json().catch(() => ({}));

  const wantsDetails = b.fullName !== undefined || b.email !== undefined || b.teacherType !== undefined || b.gender !== undefined;
  const wantsRole = b.role !== undefined && b.role !== existing.role;
  const wantsPlacement = (b.schoolId !== undefined && b.schoolId !== existing.school_id) ||
    (b.county !== undefined && String(b.county).trim() !== (existing.county ?? ""));
  if (wantsDetails && !actorCan(c, "users.edit")) return c.json({ error: NO_PERMISSION }, 403);
  if (wantsRole && !actorCan(c, "users.roles.assign")) return c.json({ error: NO_PERMISSION }, 403);
  // A role change moves the account in or out of a school/county, so it
  // needs placement rights too.
  if ((wantsPlacement || wantsRole) && !actorCan(c, "users.placement.assign")) return c.json({ error: NO_PERMISSION }, 403);

  const patch: Record<string, unknown> = {};
  if (b.fullName !== undefined) {
    const fn = String(b.fullName).trim();
    if (!fn) return c.json({ error: "Full name is required" }, 400);
    patch.full_name = fn;
  }
  const nextRole = wantsRole ? String(b.role) : existing.role;
  if (wantsRole) {
    if (!grantableRoles(actor.role).includes(nextRole as never)) {
      return c.json({ error: "You can't give that role." }, 403);
    }
    if (await isLastActiveSuperAdmin(existing)) return c.json({ error: LAST_SUPER_ADMIN }, 409);
    patch.role = nextRole;
  }

  // Placement follows the role: teachers/heads need a school from the
  // list (a new school or a new role letter means a new code); field
  // officers a county; everyone else neither.
  let placeIn: School | null = null;
  if (wantsRole || wantsPlacement) {
    const place = await resolvePlacement(nextRole,
      b.schoolId !== undefined ? b.schoolId : existing.school_id,
      b.county !== undefined ? b.county : existing.county);
    if ("error" in place) return c.json({ error: place.error }, 400);
    if (!placementAllowed(c, nextRole, place)) return c.json({ error: OUTSIDE_YOUR_AREA }, 403);
    if (place.school) {
      if (place.school.id !== existing.school_id || nextRole !== existing.role) placeIn = place.school;
    } else {
      Object.assign(patch, { school_id: null, user_code: null, school: "" });
    }
    patch.county = place.county;
  }
  if (b.teacherType !== undefined) {
    const tt = String(b.teacherType ?? "").trim().toUpperCase();
    if (tt && !["BOM", "TSC"].includes(tt)) {
      return c.json({ error: "Teacher type must be BOM or TSC" }, 400);
    }
    patch.teacher_type = tt || null;
  }
  if (nextRole !== "teacher" && existing.teacher_type) patch.teacher_type = null; // only teachers carry BOM/TSC
  if (b.gender !== undefined) {
    const g = cleanGender(b.gender);
    if (g === false) return c.json({ error: GENDER_ERROR }, 400);
    patch.gender = g;
  }

  let newEmail: string | null = null;
  if (b.email !== undefined) {
    const email = String(b.email).trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return c.json({ error: "Enter a valid email address" }, 400);
    if (email !== String(existing.email ?? "").toLowerCase()) newEmail = email;
  }

  if (!Object.keys(patch).length && !newEmail && !placeIn) return c.json({ error: "Nothing to update" }, 400);

  if (newEmail) {
    const { error: authErr } = await admin.auth.admin.updateUserById(id, {
      email: newEmail,
      email_confirm: true,
    });
    if (authErr) {
      const msg = authErr.message || "";
      return c.json({
        error: /registered|already exists|duplicate/i.test(msg)
          ? "That email already has an account"
          : msg || "Could not update the email",
      }, 400);
    }
    patch.email = newEmail;
  }

  let data: Record<string, unknown> | null = existing;
  if (Object.keys(patch).length) {
    const res = await admin.from("profiles").update(patch).eq("id", id).select().single();
    if (res.error) return c.json({ error: res.error.message }, 400);
    data = res.data;
  }
  if (placeIn) {
    try {
      data = await placeInSchool("profiles", id, placeIn, nextRole);
      // Learners belong to the school: they stay; the teacher's classes in
      // the old school lose them as teacher.
      if (existing.school_id && existing.school_id !== placeIn.id) {
        await detachTeacherFromSchool(id, existing.school_id, actor.id);
      }
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  }

  if (wantsRole) await audit(c, "role.changed", "profile", id, { from: existing.role, to: nextRole });
  const newSchoolId = (data?.school_id as string | null) ?? null;
  if (newSchoolId !== (existing.school_id ?? null)) {
    await audit(c, "school.changed", "profile", id, { from: existing.school_id ?? null, to: newSchoolId, userCode: data?.user_code ?? null });
  }
  if ((data?.county ?? "") !== (existing.county ?? "")) {
    await audit(c, "county.changed", "profile", id, { from: existing.county ?? "", to: data?.county ?? "" });
  }
  if (newEmail) await audit(c, "email.changed", "profile", id, { from: existing.email, to: newEmail });
  const detailFields = ["full_name", "teacher_type", "gender"].filter((k) => k in patch && patch[k] !== existing[k]);
  if (detailFields.length) await audit(c, "account.updated", "profile", id, { fields: detailFields });

  return c.json({ user: mapUserRow(data!) });
});

/* Where a reset link may send someone: index.html of one of the portal's
   own addresses (portalBase, above). Supabase Auth's redirect allow-list
   checks it again. */
const recoveryRedirect = (asked: unknown) => `${portalBase(asked)}index.html?flow=recovery`;

const ACTIVE_ONLY = "Only an active account can sign in. Reactivate it first.";

app.post("/users/:id/reset-link", requirePermission("users.password.reset"), async (c) => {
  const target = await loadManagedAccount(c);
  if (target instanceof Response) return target;
  if ((target.status ?? "active") !== "active") return c.json({ error: ACTIVE_ONLY }, 409);
  if (!target.email) return c.json({ error: "This account has no email address." }, 400);
  const b = await c.req.json().catch(() => ({}));
  const redirectTo = recoveryRedirect(b.redirectTo);
  const { error } = await admin.auth.resetPasswordForEmail(String(target.email), { redirectTo });
  if (error) {
    const busy = error.status === 429 || /rate limit|too many|security purposes/i.test(error.message ?? "");
    return c.json({
      error: busy
        ? "Too many emails have gone out just now. Wait a minute and try again."
        : `The email couldn't be sent (${error.message || "mail server error"}). Check the portal's mail settings — docs/AUTH.md.`,
    }, busy ? 429 : 502);
  }
  await audit(c, "password.reset_link_sent", "profile", target.id, { email: target.email, redirectTo });
  return c.json({ ok: true, email: target.email });
});

app.post("/users/:id/temporary-password", requirePermission("users.password.reset"), async (c) => {
  const target = await loadManagedAccount(c);
  if (target instanceof Response) return target;
  if ((target.status ?? "active") !== "active") return c.json({ error: ACTIVE_ONLY }, 409);
  const password = temporaryPassword();
  const salt = randomBytes(16).toString("hex");
  const before = {
    must_change_password: !!target.must_change_password,
    temporary_password_at: target.temporary_password_at ?? null,
    temporary_password_hash: target.temporary_password_hash ?? null,
  };
  // The flag first: if setting the password then fails, it's put back.
  const { error: e1 } = await admin.from("profiles").update({
    must_change_password: true, temporary_password_at: new Date().toISOString(), temporary_password_hash: `${salt}:${hashPin(password, salt)}`,
  }).eq("id", target.id);
  if (e1) return c.json({ error: e1.message }, 500);
  const { error } = await admin.auth.admin.updateUserById(target.id, { password });
  if (error) {
    await admin.from("profiles").update(before).eq("id", target.id);
    return c.json({ error: error.message || "Could not set a temporary password" }, 400);
  }
  // Never the password.
  await audit(c, "password.temporary_set", "profile", target.id, { mustChangeAtSignIn: true });
  c.header("Cache-Control", "no-store");
  return c.json({ ok: true, email: target.email, temporaryPassword: password });
});

// ---------------------------------------------------------------- access: badges, overviews, people, scope, grants
/* The menus themselves are built in the browser (navigation.js) from the
   permissions /me returns, and only decide what to show. Every route below
   checks the caller's permission and scope again. */

/** Last sign-in for every staff account (Supabase Auth), by user id. */
async function authUsers(): Promise<Map<string, { lastSignInAt: string | null }>> {
  const out = new Map<string, { lastSignInAt: string | null }>();
  try {
    for (let page = 1; page <= 20; page++) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
      const users = data?.users ?? [];
      if (error || !users.length) break;
      for (const u of users) out.set(u.id, { lastSignInAt: u.last_sign_in_at ?? null });
      if (users.length < 1000) break;
    }
  } catch (e) {
    console.error("could not read sign-ins:", (e as Error).message);
  }
  return out;
}

/** The open scope rows of every staff member, as their label. */
async function scopeLabels(): Promise<Map<string, PlaceScope>> {
  const [{ data: rows }, { data: schools }, { data: people }] = await Promise.all([
    admin.from("staff_scopes").select("profile_id, scope_type, county, school_id, ended_at").is("ended_at", null),
    admin.from("schools").select("id, name, county"),
    selectAll(() => admin.from("profiles").select("id, role, school_id, school").order("id")),
  ]);
  const out = new Map<string, PlaceScope>();
  for (const p of people ?? []) {
    out.set(p.id, placeScopeFor({ role: p.role, schoolId: p.school_id, school: p.school },
      (rows ?? []).filter((r) => r.profile_id === p.id), schools ?? []));
  }
  return out;
}

/* "My access" on My profile: what this person may do (in words), where
   (their data scope) and anything granted to them on top of their role. */
app.get("/me/access", requireActive(), async (c) => {
  const a = c.get("actor") as Actor;
  const { data: grants } = a.role === "learner" ? { data: [] as Record<string, any>[] }
    : await admin.from("permission_grants").select("permission, reason, granted_at, granted_by").eq("profile_id", a.id).is("revoked_at", null);
  const names = await dqNames((grants ?? []).map((g) => g.granted_by));
  return c.json({
    role: a.role, roleLabel: ROLE_LABEL[a.role] ?? a.role, workspace: WORKSPACE[a.role] ?? null,
    scope: { global: a.scope.global, label: a.scope.label },
    groups: PERMISSION_GROUPS.map((g) => ({ group: g.group, items: g.items.filter(([p]) => a.permissions.has(p)).map(([p, label]) => ({ permission: p, label })) }))
      .filter((g) => g.items.length),
    grants: (grants ?? []).map((g) => ({ permission: g.permission, label: PERMISSION_LABEL[g.permission] ?? g.permission, reason: g.reason,
      grantedAt: g.granted_at, grantedBy: names.get(g.granted_by) ?? null })),
  });
});

/* Counts for the sidebar badges — only the ones this person may see. */
app.get("/nav/badges", requireActive(), async (c) => {
  const a = c.get("actor") as Actor;
  const out: Record<string, number> = {};
  const jobs: Promise<void>[] = [(async () => {
    const { count } = await admin.from("notifications").select("id", { count: "exact", head: true })
      .eq("recipient_id", a.id).is("read_at", null);
    out.notifications = count ?? 0;
  })()];
  if (a.permissions.has("users.approve")) {
    jobs.push((async () => {
      const { data } = await admin.from("profiles").select("id, school_id, county").eq("status", "pending");
      out.approvals = (data ?? []).filter((p) => a.scope.global || inPlaceScope(a.scope, p.school_id, p.county)).length;
    })());
  }
  if (a.permissions.has("data_quality.view")) {
    jobs.push((async () => {
      const { data } = await selectAll(() => admin.from("dq_issues").select("id, school_id, county, severity").eq("status", "OPEN").order("id"));
      out.dataQuality = (data ?? []).filter((i) => i.severity === "HIGH" && inPlaceScope(a.scope, i.school_id, i.county)).length;
    })());
  }
  if (a.permissions.has("kobo.review")) {
    jobs.push((async () => {
      const { data } = await selectAll(() => admin.from("kobo_records").select("id, school_id, county, status, review")
        .in("status", ["invalid", "duplicate"]).order("id"));
      out.koboReview = (data ?? []).filter((r) => !r.review && inPlaceScope(a.scope, r.school_id, r.county)).length;
    })());
  }
  if (a.permissions.has("assignments.grade")) {
    jobs.push((async () => {
      const classIds = await classesTaughtBy(a.id);
      const rows = classIds.length ? await selectIn("assignment_submissions", "class_id", classIds, "id, status") : [];
      out.toMark = rows.filter((x) => x.status === "submitted").length;
    })());
  }
  await Promise.all(jobs);
  return c.json({ badges: out });
});

/* Platform overview (Super Admin): accounts, sign-ins, integrations,
   devices, data quality, access — and a short list of health checks. */
app.get("/platform/overview", requirePermission("platform.view"), async (c) => {
  const now = Date.now();
  const ago = (days: number) => new Date(now - days * 864e5).toISOString();
  const [profs, learners, schools, counties, koboCfg, koboForms, runs, devices, dqScans, dqOpen, signIns, grants, scopes, security] = await Promise.all([
    selectAll(() => admin.from("profiles").select("id, full_name, email, role, status, school_id, county").order("id")),
    selectAll(() => admin.from("learners").select("id, enrollment_status, locked_until").order("id")),
    selectAll(() => admin.from("schools").select("id, name, county").order("id")),
    loadCounties().catch(() => [] as County[]),
    loadKoboConfig(),
    selectAll(() => admin.from("kobo_forms").select("id, title, active, synced_at, last_sync_error").order("id")),
    admin.from("notification_runs").select("*").order("started_at", { ascending: false }).limit(1),
    selectAll(() => admin.from("device_sync_status").select("*").order("actor_id").order("device_id")),
    latestDqScan(),
    selectAll(() => admin.from("dq_issues").select("id, severity").in("status", ["OPEN", "UNDER_REVIEW"]).order("id")),
    authUsers(),
    admin.from("permission_grants").select("id, profile_id, permission").is("revoked_at", null),
    admin.from("staff_scopes").select("profile_id").is("ended_at", null),
    admin.from("audit_log").select("*").in("action", SECURITY_ACTIONS).order("id", { ascending: false }).limit(8),
  ]);
  const staff = profs.data ?? [];
  const byRole = Object.fromEntries(STAFF_ROLES.map((r) => [r, Object.fromEntries(ACCOUNT_STATUSES.map((s) => [s, 0]))]));
  for (const p of staff) if (byRole[p.role]) byRole[p.role][p.status ?? "active"] = (byRole[p.role][p.status ?? "active"] ?? 0) + 1;
  const active = staff.filter((p) => (p.status ?? "active") === "active");
  const last = (p: Record<string, any>) => signIns.get(p.id)?.lastSignInAt ?? null;
  const assigned = new Set((scopes.data ?? []).map((r) => r.profile_id));
  const unplacedOfficers = active.filter((p) => p.role === "field_officer" && !assigned.has(p.id));
  const headless = active.filter((p) => p.role === "school_leader" && !p.school_id);
  const superAdmins = active.filter((p) => p.role === "super_admin").length;
  const liveForms = (koboForms.data ?? []).filter((f) => f.active !== false);
  const failing = liveForms.filter((f) => f.last_sync_error);
  const lastSync = liveForms.map((f) => f.synced_at).filter(Boolean).sort().at(-1) ?? null;
  const run = runs.data?.[0] ?? null;
  const attention = (devices.data ?? []).filter((d) => deviceAttention(d, now));
  const scan = dqScans[0] ?? null;
  const open = dqOpen.data ?? [];
  const pending = staff.filter((p) => p.status === "pending").length;
  const check = (label: string, ok: boolean, detail: string, link = "") => ({ label, ok, detail, link });
  return c.json({
    accounts: {
      byRole: STAFF_ROLES.map((r) => ({ role: r, label: ROLE_LABEL[r], ...byRole[r] })),
      total: staff.length, active: active.length, pending,
      signedIn7d: active.filter((p) => (last(p) ?? "") >= ago(7)).length,
      neverSignedIn: active.filter((p) => !last(p)).length,
    },
    learners: {
      total: (learners.data ?? []).length,
      enrolled: (learners.data ?? []).filter((l) => (l.enrollment_status ?? ACTIVE) === ACTIVE).length,
      lockedNow: (learners.data ?? []).filter((l) => l.locked_until && new Date(l.locked_until).getTime() > now).length,
    },
    organisation: { counties: counties.length, schools: (schools.data ?? []).length },
    integrations: {
      kobo: { connected: !!koboCfg, server: koboCfg?.base_url ?? null, pushConfigured: !!koboCfg?.webhook_secret_hash,
        surveys: liveForms.length, lastSync, failing: failing.map((f) => ({ title: f.title, error: koboErrorText(f.last_sync_error) })) },
      notifications: run ? { lastRunAt: run.started_at, trigger: run.trigger, created: run.created, error: run.error ?? null } : null,
    },
    devices: { reporting: new Set((devices.data ?? []).map((d) => d.actor_id)).size, needAttention: attention.length },
    dataQuality: { score: scan?.score == null ? null : Number(scan.score), lastScanAt: scan?.started_at ?? null,
      open: open.length, high: open.filter((i) => i.severity === "HIGH").length },
    access: { grants: (grants.data ?? []).length, scopedStaff: assigned.size,
      fieldOfficersWithoutSchools: unplacedOfficers.map((p) => ({ id: p.id, name: p.full_name || p.email, county: p.county || "" })) },
    checks: [
      check("More than one active Super Admin", superAdmins > 1,
        superAdmins > 1 ? `${superAdmins} active` : "Only one — if that account is lost, nobody can administer the portal", "#users"),
      check("Every field officer has assigned schools", !unplacedOfficers.length,
        unplacedOfficers.length ? `${unplacedOfficers.length} without: ${unplacedOfficers.map((p) => p.full_name || p.email).join(", ")}` : "All assigned", "#users"),
      check("Every school head is linked to a school", !headless.length,
        headless.length ? `${headless.length} not linked yet (they pick it at next sign-in)` : "All linked", "#users"),
      check("No accounts waiting for approval", !pending, pending ? `${pending} waiting` : "None waiting", "#users"),
      check("KoboToolbox connected and syncing", !!koboCfg && !failing.length,
        !koboCfg ? "Not connected" : failing.length ? `${failing.length} survey(s) failing to sync` : lastSync ? `Last sync ${String(lastSync).slice(0, 16).replace("T", " ")}` : "Connected, not synced yet", "#kobo"),
      check("Hourly notifications running", !!run && now - new Date(run.started_at).getTime() < 3 * 3600e3 && !run.error,
        run ? `Last run ${String(run.started_at).slice(0, 16).replace("T", " ")}${run.error ? " — failed" : ""}` : "Never run", "#notifications"),
      check("Data quality scanned this week", !!scan && now - new Date(scan.started_at).getTime() < 7 * 864e5,
        scan ? `Last scan ${String(scan.started_at).slice(0, 10)}` : "Never scanned", "#data-quality"),
      check("No devices needing attention", !attention.length, attention.length ? `${attention.length} device(s)` : "All fine", ""),
    ],
    recentSecurity: await auditEntries(security.data ?? []),
  });
});

/* Administration overview (Admin, and Super Admin): the programme's
   organisation and operations, within the caller's area. */
app.get("/admin/overview", requirePermission("users.view"), async (c) => {
  const sc = scopeOf(c);
  const here = (schoolId: unknown, county?: unknown) => inPlaceScope(sc, schoolId, county);
  const cal = await currentCalendar();
  const [profs, learners, schools, classes, ct, visits, forms, kobo, dq] = await Promise.all([
    selectAll(() => admin.from("profiles").select("id, role, status, school_id, county").order("id")),
    selectAll(() => admin.from("learners").select("id, school_id, enrollment_status, class_id").order("id")),
    selectAll(() => admin.from("schools").select("id, name, county").order("id")),
    selectAll(() => admin.from("classes").select("id, school_id, academic_year_id, archived_at").order("id")),
    selectAll(() => admin.from("class_teachers").select("class_id, teacher_id, ended_at").order("class_id")),
    selectAll(() => admin.from("field_reports").select("id, school_id, county, created_at").order("id")),
    selectAll(() => admin.from("forms").select("id, county, archived_at").order("id")),
    actorCan(c, "kobo.review")
      ? selectAll(() => admin.from("kobo_records").select("id, school_id, county, status, review").in("status", ["invalid", "duplicate"]).order("id"))
      : Promise.resolve({ data: [] as Record<string, any>[], error: null }),
    actorCan(c, "data_quality.view")
      ? selectAll(() => admin.from("dq_issues").select("id, school_id, county, severity").eq("status", "OPEN").order("id"))
      : Promise.resolve({ data: [] as Record<string, any>[], error: null }),
  ]);
  const people = (profs.data ?? []).filter((p) => sc.global || (p.school_id ? here(p.school_id) : here(null, p.county)));
  const active = people.filter((p) => (p.status ?? "active") === "active");
  const mySchools = (schools.data ?? []).filter((s) => here(s.id));
  const yearClasses = (classes.data ?? []).filter((k) => here(k.school_id) && !k.archived_at && k.academic_year_id === cal.yearId);
  const teaching = new Set((ct.data ?? []).filter((t) => !t.ended_at).map((t) => t.teacher_id));
  const { data: assigned } = await admin.from("staff_scopes").select("profile_id").is("ended_at", null);
  const placed = new Set((assigned ?? []).map((r) => r.profile_id));
  const termStart = cal.termId ? (await admin.from("terms").select("starts_on").eq("id", cal.termId).maybeSingle()).data?.starts_on ?? null : null;
  const count = (role: string) => active.filter((p) => p.role === role).length;
  return c.json({
    scope: { global: sc.global, label: sc.label },
    currentTerm: cal.termId,
    people: {
      teachers: count("teacher"), heads: count("school_leader"), fieldOfficers: count("field_officer"),
      programmeStaff: sc.global ? active.filter((p) => ["admin", "me", "education_team", "super_admin"].includes(p.role)).length : null,
      pending: people.filter((p) => p.status === "pending").length,
      learners: (learners.data ?? []).filter((l) => here(l.school_id) && (l.enrollment_status ?? ACTIVE) === ACTIVE).length,
      learnersWithoutClass: (learners.data ?? []).filter((l) => here(l.school_id) && (l.enrollment_status ?? ACTIVE) === ACTIVE && !l.class_id).length,
    },
    organisation: {
      counties: new Set(mySchools.map((s) => s.county)).size, schools: mySchools.length, classes: yearClasses.length,
      schoolsWithoutHead: mySchools.filter((s) => !active.some((p) => p.role === "school_leader" && p.school_id === s.id)).length,
      teachersWithoutClasses: active.filter((p) => p.role === "teacher" && !teaching.has(p.id)).length,
      fieldOfficersWithoutSchools: active.filter((p) => p.role === "field_officer" && !placed.has(p.id)).length,
    },
    operations: {
      visitsThisTerm: (visits.data ?? []).filter((v) => here(v.school_id, v.county) && (!termStart || String(v.created_at) >= termStart)).length,
      openForms: (forms.data ?? []).filter((f) => !f.archived_at && (sc.global || !f.county || sc.areaCounties.has(String(f.county).toLowerCase()))).length,
      koboNeedsReview: actorCan(c, "kobo.review") ? (kobo.data ?? []).filter((r) => !r.review && here(r.school_id, r.county)).length : null,
      dataQualityHigh: actorCan(c, "data_quality.view") ? (dq.data ?? []).filter((i) => i.severity === "HIGH" && here(i.school_id, i.county)).length : null,
    },
  });
});

/* Teachers and school heads as people the programme supports: where they
   work, their classes and the training they attended — never an email or
   an account action (that's the Users page). Within the caller's area. */
app.get("/teachers", requirePermission("teachers.view"), async (c) => {
  const showAll = c.req.query("status") === "all";
  const [{ data: people, error }, { data: ct }, { data: classes }, { data: att }] = await Promise.all([
    selectAll(() => admin.from("profiles").select("id, full_name, role, status, school, school_id, county, teacher_type, user_code")
      .in("role", ["teacher", "school_leader"]).order("full_name").order("id")),
    selectAll(() => admin.from("class_teachers").select("class_id, teacher_id, ended_at").order("class_id")),
    selectAll(() => admin.from("classes").select("id, name, archived_at").order("id")),
    selectAll(() => admin.from("training_attendance").select("teacher_id, attended").order("training_id")),
  ]);
  if (error) return c.json({ error: error.message }, 500);
  const className = new Map((classes ?? []).filter((k) => !k.archived_at).map((k) => [k.id, k.name]));
  const rows = (people ?? []).filter((p) => p.school_id && inScope(c, p.school_id) && (showAll || (p.status ?? "active") === "active"));
  return c.json({
    scope: scopeOf(c).label,
    teachers: rows.map((p) => ({
      id: p.id, name: p.full_name, role: p.role, roleLabel: ROLE_LABEL[p.role as Role] ?? p.role, status: p.status ?? "active",
      school: p.school ?? "", schoolId: p.school_id, county: p.county ?? "", teacherType: p.teacher_type ?? null, code: p.user_code ?? null,
      classes: (ct ?? []).filter((t) => t.teacher_id === p.id && !t.ended_at).map((t) => className.get(t.class_id)).filter(Boolean),
      trainings: (att ?? []).filter((a) => a.teacher_id === p.id && a.attended !== false).length,
    })),
  });
});

/* One school's profile: head, staff and learner numbers, this year's
   classes, recent visits and who supports it. Within the caller's area. */
app.get("/schools/:id/profile", requirePermission("schools.profile.view"), async (c) => {
  const school = await loadSchool(c.req.param("id"));
  if (!school || !inScope(c, school.id)) return c.json({ error: "School not found" }, 404);
  const cal = await currentCalendar();
  const [{ data: staff }, { data: learners }, { data: classes }, { data: visits }, { data: kobo }, { data: support }] = await Promise.all([
    admin.from("profiles").select("id, full_name, role, status").eq("school_id", school.id),
    admin.from("learners").select("id, grade, class_id, enrollment_status").eq("school_id", school.id),
    admin.from("classes").select("id, name, grade, academic_year_id, archived_at").eq("school_id", school.id),
    admin.from("field_reports").select("id, visit_type, officer_id, created_at").eq("school_id", school.id),
    admin.from("kobo_records").select("id, status, review").eq("school_id", school.id),
    admin.from("staff_scopes").select("profile_id, scope_type, county, school_id").is("ended_at", null),
  ]);
  const activeStaff = (staff ?? []).filter((p) => (p.status ?? "active") === "active");
  const enrolled = (learners ?? []).filter((l) => (l.enrollment_status ?? ACTIVE) === ACTIVE);
  const yearClasses = (classes ?? []).filter((k) => !k.archived_at && k.academic_year_id === cal.yearId);
  const supporters = (support ?? []).filter((r) => r.school_id === school.id || (r.county && String(r.county).toLowerCase() === String(school.county).toLowerCase()))
    .map((r) => r.profile_id);
  const officerIds = [...new Set([...supporters, ...(visits ?? []).map((v) => v.officer_id)].filter(Boolean))];
  const officers = officerIds.length ? await selectIn("profiles", "id", officerIds, "id, full_name, role") : [];
  const nameOf = new Map(officers.map((p) => [p.id, p.full_name]));
  const sortedVisits = (visits ?? []).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const byGrade = new Map<string, number>();
  for (const l of enrolled) byGrade.set(l.grade || "(not set)", (byGrade.get(l.grade || "(not set)") ?? 0) + 1);
  return c.json({
    school: { id: school.id, name: school.name, code: school.code, county: school.county },
    heads: activeStaff.filter((p) => p.role === "school_leader").map((p) => p.full_name),
    teachers: activeStaff.filter((p) => p.role === "teacher").length,
    learners: enrolled.length,
    learnersByGrade: [...byGrade.entries()].map(([grade, n]) => ({ grade, learners: n })).sort((a, b) => a.grade.localeCompare(b.grade, undefined, { numeric: true })),
    classes: yearClasses.map((k) => ({ name: k.name, grade: k.grade, learners: enrolled.filter((l) => l.class_id === k.id).length }))
      .sort((a, b) => String(a.grade).localeCompare(String(b.grade), undefined, { numeric: true }) || a.name.localeCompare(b.name)),
    visits: { total: sortedVisits.length, last: sortedVisits[0]?.created_at ?? null,
      recent: sortedVisits.slice(0, 8).map((v) => ({ date: v.created_at, type: v.visit_type, officer: nameOf.get(v.officer_id) ?? null })) },
    kobo: { submissions: (kobo ?? []).length, counted: (kobo ?? []).filter((r) => countsOnDashboards(r.status, r.review)).length },
    supportedBy: officers.filter((p) => supporters.includes(p.id) && p.role === "field_officer").map((p) => p.full_name),
  });
});

/* ---- one account's access: role, scope, grants ---- */

const mapScopeRow = (r: Record<string, any>, schoolName: Map<string, string>, names: Map<string, string>) => ({
  id: r.id, type: r.scope_type, county: r.county ?? null, schoolId: r.school_id ?? null,
  school: r.school_id ? schoolName.get(r.school_id) ?? r.school_id : null, note: r.note || "",
  createdAt: r.created_at, createdBy: r.created_by ? names.get(r.created_by) ?? null : "Set up from their profile",
  endedAt: r.ended_at ?? null, endedBy: r.ended_by ? names.get(r.ended_by) ?? null : null,
});

app.get("/users/:id/access", requirePermission("users.view"), async (c) => {
  const { data: target } = await admin.from("profiles").select("*").eq("id", c.req.param("id")).maybeSingle();
  if (!target || !inScope(c, target.school_id, target.county)) return c.json({ error: "User not found" }, 404);
  const [{ data: rows }, { data: grants }, { data: schools }] = await Promise.all([
    admin.from("staff_scopes").select("*").eq("profile_id", target.id),
    admin.from("permission_grants").select("*").eq("profile_id", target.id),
    admin.from("schools").select("id, name, county"),
  ]);
  const names = await dqNames([...(rows ?? []).flatMap((r) => [r.created_by, r.ended_by]), ...(grants ?? []).flatMap((g) => [g.granted_by, g.revoked_by])]);
  const schoolName = new Map((schools ?? []).map((s) => [s.id, s.name]));
  const open = (grants ?? []).filter((g) => !g.revoked_at).map((g) => g.permission);
  const scope = placeScopeFor({ role: target.role, schoolId: target.school_id, school: target.school }, (rows ?? []).filter((r) => !r.ended_at), schools ?? []);
  const assignable = (ASSIGNABLE_ROLES as readonly string[]).includes(target.role);
  const manages = canManageAccount(c.get("actor"), target as { id: string; role: string });
  return c.json({
    id: target.id, role: target.role, roleLabel: ROLE_LABEL[target.role as Role] ?? target.role, workspace: WORKSPACE[target.role as Role] ?? null,
    rolePermissions: [...permissionsFor(target.role)],
    permissions: [...effectivePermissions(target.role, open)],
    grants: (grants ?? []).sort((a, b) => String(b.granted_at).localeCompare(String(a.granted_at))).map((g) => ({
      id: g.id, permission: g.permission, label: PERMISSION_LABEL[g.permission] ?? g.permission, reason: g.reason,
      grantedAt: g.granted_at, grantedBy: names.get(g.granted_by) ?? null,
      revokedAt: g.revoked_at ?? null, revokedBy: g.revoked_by ? names.get(g.revoked_by) ?? null : null, revokeReason: g.revoke_reason ?? null,
    })),
    scope: {
      assignable, global: scope.global, label: scope.label,
      rule: target.role === "super_admin" ? "Every county and school, always."
        : target.role === "field_officer" ? "Only the counties and schools assigned below."
        : assignable ? "Every county and school until narrowed below."
        : target.role === "school_leader" ? "Their own school." : "The classes they teach, in their own school.",
      rows: (rows ?? []).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).map((r) => mapScopeRow(r, schoolName, names)),
    },
    canEditScope: assignable && manages && actorCan(c, "users.placement.assign"),
    canGrant: actorCan(c, "permissions.manage") && target.id !== c.get("actor").id && target.role !== "super_admin",
    grantable: actorCan(c, "permissions.manage")
      ? GRANTABLE_PERMISSIONS.filter((p) => !permissionsFor(target.role).includes(p) && !open.includes(p)).map((p) => ({ value: p, label: PERMISSION_LABEL[p] ?? p }))
      : [],
  });
});

/* Set the counties / schools an account's data is limited to. The list
   sent replaces the open assignments: what's gone is ended (kept, with who
   and when), what's new is added; every change is in the audit log. */
app.put("/users/:id/scope", requirePermission("users.placement.assign"), async (c) => {
  const target = await loadManagedAccount(c);
  if (target instanceof Response) return target;
  if (!(ASSIGNABLE_ROLES as readonly string[]).includes(target.role)) {
    return c.json({ error: "This role's data comes from their school or classes, not from assignments." }, 400);
  }
  const b = await c.req.json().catch(() => ({}));
  const wantCounties = [...new Set((Array.isArray(b.counties) ? b.counties : []).map((x: unknown) => String(x).trim()).filter(Boolean))] as string[];
  const wantSchools = [...new Set((Array.isArray(b.schoolIds) ? b.schoolIds : []).map((x: unknown) => String(x).trim()).filter(Boolean))] as string[];
  if (wantCounties.length + wantSchools.length > 200) return c.json({ error: "That's too many at once" }, 400);
  const known = new Set((await loadCounties()).map((x) => x.name));
  if (wantCounties.some((x) => !known.has(x))) return c.json({ error: "One of those counties isn't on the list" }, 400);
  const schoolRows = wantSchools.length ? await selectIn("schools", "id", wantSchools, "id, name, county") : [];
  if (schoolRows.length !== wantSchools.length) return c.json({ error: "One of those schools isn't on the list" }, 400);
  // Someone narrowed to an area can only hand out what they hold — and can't
  // widen a person to everything by taking all their assignments away.
  const sc = scopeOf(c);
  if (!sc.global) {
    if (wantCounties.some((x) => !sc.counties.has(x.toLowerCase())) || wantSchools.some((x) => !sc.schoolIds.has(x))) {
      return c.json({ error: "You can only assign counties and schools in your own area" }, 403);
    }
    if (!wantCounties.length && !wantSchools.length && target.role !== "field_officer") {
      return c.json({ error: "Removing every assignment would let them see every county — ask a Super Admin" }, 403);
    }
  }
  const { data: openRows } = await admin.from("staff_scopes").select("*").eq("profile_id", target.id).is("ended_at", null);
  const keyOf = (r: { scope_type: string; county?: string | null; school_id?: string | null }) => `${r.scope_type}:${r.county ?? r.school_id}`;
  const wanted = new Set([...wantCounties.map((x) => `county:${x}`), ...wantSchools.map((x) => `school:${x}`)]);
  const toEnd = (openRows ?? []).filter((r) => !wanted.has(keyOf(r)));
  const have = new Set((openRows ?? []).map(keyOf));
  const toAdd = [...wanted].filter((k) => !have.has(k));
  const actor = c.get("actor");
  const now = new Date().toISOString();
  for (const r of toEnd) {
    const { error } = await admin.from("staff_scopes").update({ ended_at: now, ended_by: actor.id }).eq("id", r.id).is("ended_at", null);
    if (error) return c.json({ error: error.message }, 400);
  }
  if (toAdd.length) {
    const { error } = await admin.from("staff_scopes").insert(toAdd.map((k) => {
      const [type, value] = [k.slice(0, k.indexOf(":")), k.slice(k.indexOf(":") + 1)];
      return { id: rid("scp"), profile_id: target.id, scope_type: type, county: type === "county" ? value : null,
        school_id: type === "school" ? value : null, note: "", created_at: now, created_by: actor.id };
    }));
    if (error) return c.json({ error: isUniqueViolation(error) ? "That assignment already exists" : error.message }, 400);
  }
  if (toEnd.length || toAdd.length) {
    const label = (k: string) => k.startsWith("county:") ? `${k.slice(7)} County` : schoolRows.find((s) => s.id === k.slice(7))?.name ?? k.slice(7);
    await audit(c, "scope.changed", "profile", target.id, {
      added: toAdd.map(label), removed: toEnd.map((r) => (r.county ? `${r.county} County` : r.school_id)),
    });
  }
  const { data: rows } = await admin.from("staff_scopes").select("*").eq("profile_id", target.id).is("ended_at", null);
  const { data: schools } = await admin.from("schools").select("id, name, county");
  const scope = placeScopeFor({ role: target.role }, rows ?? [], schools ?? []);
  return c.json({ scope: { global: scope.global, label: scope.label }, added: toAdd.length, ended: toEnd.length });
});

/* ---- explicit permission grants (Super Admin) ---- */

app.post("/users/:id/grants", requirePermission("permissions.manage"), async (c) => {
  const { data: target } = await admin.from("profiles").select("id, role, full_name").eq("id", c.req.param("id")).maybeSingle();
  if (!target) return c.json({ error: "User not found" }, 404);
  const actor = c.get("actor");
  if (target.id === actor.id) return c.json({ error: "You can't grant permissions to yourself" }, 403);
  if (target.role === "super_admin") return c.json({ error: "A Super Admin already holds every permission" }, 409);
  const b = await c.req.json().catch(() => ({}));
  const permission = String(b.permission ?? "");
  if (!isPermission(permission) || !GRANTABLE_PERMISSIONS.includes(permission)) return c.json({ error: "That permission can't be granted" }, 400);
  if (permissionsFor(target.role).includes(permission)) return c.json({ error: "Their role already includes that" }, 409);
  const reason = String(b.reason ?? "").trim();
  if (reason.length < 3 || reason.length > 500) return c.json({ error: "Say why, for the record (3–500 characters)" }, 400);
  const { data: open } = await admin.from("permission_grants").select("id").eq("profile_id", target.id).eq("permission", permission).is("revoked_at", null);
  if (open?.length) return c.json({ error: "They already have that permission" }, 409);
  const row = { id: rid("grt"), profile_id: target.id, permission, reason, granted_by: actor.id, granted_at: new Date().toISOString() };
  const { error } = await admin.from("permission_grants").insert(row);
  if (error) return c.json({ error: isUniqueViolation(error) ? "They already have that permission" : error.message }, 400);
  await audit(c, "permission.granted", "profile", target.id, { permission, reason });
  return c.json({ grant: { id: row.id, permission, label: PERMISSION_LABEL[permission], reason, grantedAt: row.granted_at } });
});

app.post("/users/:id/grants/:grantId/revoke", requirePermission("permissions.manage"), async (c) => {
  const { data: g } = await admin.from("permission_grants").select("*").eq("id", c.req.param("grantId")).maybeSingle();
  if (!g || g.profile_id !== c.req.param("id")) return c.json({ error: "Grant not found" }, 404);
  if (g.revoked_at) return c.json({ error: "Already revoked" }, 409);
  const b = await c.req.json().catch(() => ({}));
  const reason = String(b.reason ?? "").trim().slice(0, 500);
  if (reason.length < 3) return c.json({ error: "Say why, for the record" }, 400);
  const { error } = await admin.from("permission_grants")
    .update({ revoked_at: new Date().toISOString(), revoked_by: c.get("actor").id, revoke_reason: reason }).eq("id", g.id).is("revoked_at", null);
  if (error) return c.json({ error: error.message }, 400);
  await audit(c, "permission.revoked", "profile", g.profile_id, { permission: g.permission, reason });
  return c.json({ ok: true });
});

/* The whole model in one place: every role's permissions (from code), what
   can be granted, and every open grant. */
app.get("/permissions", requirePermission("permissions.manage", "audit.view"), async (c) => {
  const { data: grants } = await admin.from("permission_grants").select("*").is("revoked_at", null);
  const ids = [...new Set((grants ?? []).flatMap((g) => [g.profile_id, g.granted_by]))];
  const people = ids.length ? await selectIn("profiles", "id", ids, "id, full_name, email, role") : [];
  const who = new Map(people.map((p) => [p.id, p]));
  const roles = [...STAFF_ROLES, "learner"] as Role[];
  return c.json({
    groups: PERMISSION_GROUPS.map((g) => ({ group: g.group, items: g.items.map(([p, label]) => ({ permission: p, label })) })),
    roles: roles.map((r) => ({ role: r, label: ROLE_LABEL[r], workspace: WORKSPACE[r], permissions: [...ROLE_PERMISSIONS[r]] })),
    grantable: GRANTABLE_PERMISSIONS,
    grants: (grants ?? []).map((g) => ({
      id: g.id, profileId: g.profile_id, person: who.get(g.profile_id)?.full_name || who.get(g.profile_id)?.email || g.profile_id,
      role: who.get(g.profile_id)?.role ?? null, permission: g.permission, label: PERMISSION_LABEL[g.permission] ?? g.permission,
      reason: g.reason, grantedAt: g.granted_at, grantedBy: who.get(g.granted_by)?.full_name ?? null,
    })),
    canGrant: actorCan(c, "permissions.manage"),
  });
});

/* One account's history, for administrators without the full audit log. */
app.get("/users/:id/history", requirePermission("users.view"), async (c) => {
  const { data: target } = await admin.from("profiles").select("id, school_id, county").eq("id", c.req.param("id")).maybeSingle();
  if (!target || !inScope(c, target.school_id, target.county)) return c.json({ error: "User not found" }, 404);
  const { data } = await admin.from("audit_log").select("*").eq("target_type", "profile").eq("target_id", target.id)
    .order("id", { ascending: false }).limit(100);
  return c.json({ entries: await auditEntries(data ?? []) });
});

/* Account activity (Super Admin): every staff account's last sign-in, and
   learner sign-ins and lockouts. */
app.get("/security/activity", requirePermission("audit.view"), async (c) => {
  const now = Date.now();
  const [{ data: staff }, signIns, { data: learners }, { data: sessions }] = await Promise.all([
    selectAll(() => admin.from("profiles").select("id, full_name, email, role, status, school, county, created_at").order("id")),
    authUsers(),
    selectAll(() => admin.from("learners").select("id, enrollment_status, locked_until, failed_attempts").order("id")),
    admin.from("learner_sessions").select("learner_id, created_at").gt("created_at", new Date(now - 7 * 864e5).toISOString()),
  ]);
  return c.json({
    staff: (staff ?? []).map((p) => ({
      id: p.id, name: p.full_name || p.email, email: p.email, role: p.role, roleLabel: ROLE_LABEL[p.role as Role] ?? p.role,
      status: p.status ?? "active", place: p.school || p.county || "", createdAt: p.created_at,
      lastSignInAt: signIns.get(p.id)?.lastSignInAt ?? null,
    })).sort((a, b) => String(b.lastSignInAt ?? "").localeCompare(String(a.lastSignInAt ?? "")) || a.name.localeCompare(b.name)),
    learners: {
      enrolled: (learners ?? []).filter((l) => (l.enrollment_status ?? ACTIVE) === ACTIVE).length,
      signedIn7d: new Set((sessions ?? []).map((s) => s.learner_id)).size,
      lockedNow: (learners ?? []).filter((l) => l.locked_until && new Date(l.locked_until).getTime() > now).length,
      withFailedAttempts: (learners ?? []).filter((l) => (l.failed_attempts ?? 0) > 0).length,
    },
  });
});

/* ---- audit history ---- */

/** Changes to who can sign in and what they can reach. */
const SECURITY_ACTIONS = [
  "account.created", "account.approved", "account.rejected", "account.suspended", "account.deactivated", "account.reactivated",
  "role.changed", "school.changed", "county.changed", "email.changed",
  "password.reset", "password.reset_link_sent", "password.temporary_set", "password.changed",
  "permission.granted", "permission.revoked", "scope.changed", "scope.assigned",
  "invitation.created", "invitation.emailed", "invitation.renewed", "invitation.revoked", "invitation.accepted",
  "kobo.connection_saved", "kobo.webhook_secret_created", "kobo.webhook_secret_removed", "learner.pin_reset", "learner.unlocked",
];

app.get("/audit", requirePermission("audit.view"), async (c) => {
  const limit = Math.max(1, Math.min(200, Number(c.req.query("limit")) || 100));
  const before = Number(c.req.query("before")) || 0;
  const targetId = String(c.req.query("targetId") ?? "").trim();
  const action = String(c.req.query("action") ?? "").trim();
  const actorId = String(c.req.query("actorId") ?? "").trim();
  let q = admin.from("audit_log").select("*").order("id", { ascending: false }).limit(limit);
  if (before) q = q.lt("id", before);
  if (targetId) q = q.eq("target_id", targetId);
  if (actorId) q = q.eq("actor_id", actorId);
  if (action) q = q.eq("action", action);
  else if (c.req.query("kind") === "security") q = q.in("action", SECURITY_ACTIONS);
  const { data, error } = await q;
  if (error) return c.json({ error: error.message }, 500);
  const rows = data ?? [];
  return c.json({ entries: await auditEntries(rows), nextBefore: rows.length === limit ? rows[rows.length - 1].id : null });
});

/** Audit rows with the names of the people involved. */
async function auditEntries(rows: Record<string, any>[]) {
  // Names for the people involved, looked up once.
  const ids = [...new Set(rows.flatMap((r) => [r.actor_id, r.target_type === "profile" ? r.target_id : null]).filter(Boolean))];
  const names: Record<string, string> = {};
  if (ids.length) {
    const { data: people } = await admin.from("profiles").select("id, full_name, email").in("id", ids);
    for (const p of people ?? []) names[p.id] = p.full_name || p.email;
  }
  return rows.map((r) => ({
      id: r.id,
      at: r.at,
      action: r.action,
      actorId: r.actor_id,
      actorName: r.actor_id ? names[r.actor_id] ?? null : null,
      actorKind: r.actor_kind,
      actorRole: r.actor_role,
      targetType: r.target_type,
      targetId: r.target_id,
      targetName: r.target_type === "profile" && r.target_id ? names[r.target_id] ?? null : null,
      details: r.details ?? {},
    }));
}

// ---- KoboToolbox: education-team config + attached surveys ----

// Whether Kobo is connected, and how — never the token. Results viewers need it too.
app.get("/kobo/config", requirePermission("kobo.manage", "kobo.results.view"), async (c) => {
  const cfg = await loadKoboConfig();
  return c.json({
    configured: !!cfg,
    baseUrl: cfg?.base_url ?? "https://eu.kobotoolbox.org",
    officerField: cfg?.officer_field ?? "officer_ref",
    webhook: {
      configured: !!cfg?.webhook_secret_hash,
      setAt: cfg?.webhook_secret_set_at ?? null,
      url: `${SUPABASE_URL}/functions/v1/api/kobo/hook`,
      username: KOBO_HOOK_USER,
    },
  });
});

app.put("/kobo/config", requirePermission("kobo.configure"), async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const apiToken = String(b.apiToken ?? "").trim();
  const baseUrl = String(b.baseUrl ?? "https://eu.kobotoolbox.org").trim().replace(/\/+$/, "");
  const officerField = (String(b.officerField ?? "").trim() || "officer_ref");
  if (!apiToken) return c.json({ error: "Paste your KoboToolbox API token" }, 400);
  if (!/^https:\/\/[^\s]+$/.test(baseUrl)) return c.json({ error: "Server URL must start with https://" }, 400);
  if (!/^[A-Za-z_][\w./-]*$/.test(officerField)) return c.json({ error: "Hidden question name looks invalid" }, 400);

  const test = await koboFetch(
    { base_url: baseUrl, api_token: apiToken, officer_field: officerField },
    "/api/v2/assets/?limit=1&format=json",
  ).catch(() => null);
  if (!test || !test.ok) {
    const s = test?.status;
    return c.json({
      error: s === 401 || s === 403 ? "That API token was rejected by KoboToolbox"
        : s ? `KoboToolbox returned ${s}` : "Couldn't reach KoboToolbox",
    }, 400);
  }
  const { error } = await admin.from("kobo_config").upsert({
    id: 1, base_url: baseUrl, api_token: apiToken, officer_field: officerField,
    updated_by: c.get("actor").fullName, updated_at: new Date().toISOString(),
  });
  if (error) return c.json({ error: error.message }, 400);
  await audit(c, "kobo.connection_saved", "kobo_config", 1, { server: baseUrl, officerField }); // never the token
  return c.json({ ok: true, officerField });
});

app.get("/kobo/assets", requirePermission("kobo.manage"), async (c) => {
  const cfg = await loadKoboConfig();
  if (!cfg) return c.json({ error: "Connect KoboToolbox first" }, 400);
  let data;
  try {
    data = await koboJson(cfg, "/api/v2/assets/?q=asset_type:survey&limit=300&format=json");
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }
  const assets = (data.results ?? [])
    .filter((a: any) => a.asset_type === "survey")
    .map((a: any) => ({
      uid: a.uid,
      name: a.name || "(untitled survey)",
      deployed: !!a.deployment__active,
      submissionCount: a.deployment__submission_count ?? 0,
    }));
  return c.json({ assets });
});

app.get("/kobo/forms", requirePermission("kobo.manage", "kobo.results.view"), async (c) => {
  const { data } = await admin
    .from("kobo_forms").select("*").order("created_at", { ascending: false });
  const { data: subs } = await selectAll(() =>
    admin.from("kobo_submissions").select("kobo_form_id").order("kobo_form_id").order("officer_id"));
  const counts: Record<string, number> = {};
  for (const s of subs ?? []) counts[s.kobo_form_id] = (counts[s.kobo_form_id] ?? 0) + 1;
  // What the pipeline made of each survey.
  const { data: recs } = await selectAll(() =>
    admin.from("kobo_records").select("id, kobo_form_id, status, review").order("id"));
  const pipe: Record<string, { received: number; counted: number; needsReview: number }> = {};
  for (const r of recs ?? []) {
    if (r.status === "removed") continue;
    const p = (pipe[r.kobo_form_id] ||= { received: 0, counted: 0, needsReview: 0 });
    p.received++;
    if (countsOnDashboards(r.status, r.review)) p.counted++;
    if ((r.status === "invalid" || r.status === "duplicate") && !r.review) p.needsReview++;
  }
  return c.json({
    forms: (data ?? []).map((f) => ({
      id: f.id,
      assetUid: f.asset_uid,
      title: f.title,
      active: f.active,
      submissionCount: f.submission_count,
      officerSubmissions: counts[f.id] ?? 0,
      syncedAt: f.synced_at,
      processed: !!f.schema,
      pipeline: pipe[f.id] ?? { received: 0, counted: 0, needsReview: 0 },
    })),
  });
});

app.post("/kobo/forms", requirePermission("kobo.manage"), async (c) => {
  const cfg = await loadKoboConfig();
  if (!cfg) return c.json({ error: "Connect KoboToolbox first" }, 400);
  const b = await c.req.json().catch(() => ({}));
  const uid = String(b.assetUid ?? "").trim();
  if (!uid) return c.json({ error: "Pick a survey" }, 400);

  const { data: existing } = await admin
    .from("kobo_forms").select("id, title, asset_uid, active").eq("asset_uid", uid).maybeSingle();
  if (existing?.active) return c.json({ error: "That survey is already attached" }, 409);
  if (existing) {
    // Attaching an archived survey again restores it, with its history.
    await admin.from("kobo_forms").update({ active: true }).eq("id", existing.id);
    return c.json({ form: { id: existing.id, title: existing.title, assetUid: existing.asset_uid } });
  }

  let asset;
  try {
    asset = await koboJson(cfg, `/api/v2/assets/${uid}/?format=json`);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }
  if (!asset.deployment__active) {
    return c.json({ error: "That survey isn't deployed in KoboToolbox yet" }, 400);
  }
  const links = asset.deployment__links ?? {};
  const enketo = links.offline_url || links.url || links.iframe_url || null;

  const { data, error } = await admin
    .from("kobo_forms")
    .insert({
      id: rid("kb"),
      asset_uid: uid,
      title: asset.name || "(untitled survey)",
      enketo_url: enketo,
      submission_count: asset.deployment__submission_count ?? 0,
      created_by: c.get("actor").fullName,
    })
    .select()
    .single();
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ form: { id: data.id, title: data.title, assetUid: data.asset_uid } });
});

/* An in-portal look at the actual survey questions before deciding to
   attach it — the iframe-friendly Enketo webform link, never KoboToolbox's
   own web app (which refuses to be framed and needs a separate Kobo
   login anyway). Nothing here notifies or reaches a field officer: that
   only happens once "Attach" turns the survey into a fillable link. */
app.get("/kobo/assets/:uid/preview", requirePermission("kobo.manage"), async (c) => {
  const cfg = await loadKoboConfig();
  if (!cfg) return c.json({ error: "Connect KoboToolbox first" }, 400);
  const uid = c.req.param("uid");
  let asset;
  try {
    asset = await koboJson(cfg, `/api/v2/assets/${uid}/?format=json`);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }
  if (!asset.deployment__active) {
    return c.json({ error: "That survey isn't deployed in KoboToolbox yet" }, 400);
  }
  const links = asset.deployment__links ?? {};
  const previewUrl = links.iframe_url || links.offline_url || links.url || null;
  if (!previewUrl) return c.json({ error: "KoboToolbox didn't provide a preview link for this survey" }, 502);
  return c.json({ previewUrl, title: asset.name || "(untitled survey)" });
});

/* "Remove" archives: field officers stop seeing the survey and sync skips
   it, but which officers submitted it stays on record. Restore (or
   attaching the same survey again) brings it back. */
app.delete("/kobo/forms/:id", requirePermission("kobo.manage"), async (c) => {
  const { data, error } = await admin.from("kobo_forms")
    .update({ active: false }).eq("id", c.req.param("id")).select("id").maybeSingle();
  if (error) return c.json({ error: error.message }, 400);
  if (!data) return c.json({ error: "Survey not found" }, 404);
  return c.json({ ok: true, archived: true });
});

app.post("/kobo/forms/:id/restore", requirePermission("kobo.manage"), async (c) => {
  const { data, error } = await admin.from("kobo_forms")
    .update({ active: true }).eq("id", c.req.param("id")).select("id").maybeSingle();
  if (error) return c.json({ error: error.message }, 400);
  if (!data) return c.json({ error: "Survey not found" }, 404);
  return c.json({ ok: true });
});

// ---- KoboToolbox: the ingestion pipeline ----
// Kobo → API (raw, as received) → validation → normalization → kobo_records
// → dashboards. The rules are in kobo_pipeline.ts; this part moves data.

/** Kobo's _submission_time is UTC without a zone ("2026-09-20T10:00:00"). */
function koboTime(v: unknown): string | null {
  if (v == null || v === "") return null;
  const s = String(v);
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s + "Z");
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** The survey's questions and choice lists, refreshed from KoboToolbox. A
    first guess at the field mapping is saved only if there isn't one yet. */
async function refreshKoboSchema(cfg: KoboConfig, form: Record<string, any>) {
  const asset = await koboJson(cfg, `/api/v2/assets/${encodeURIComponent(form.asset_uid)}/?format=json`);
  const schema = parseKoboSchema(asset.content ?? {}, asset.version_id ?? null);
  const patch: Record<string, unknown> = { schema, schema_version: schema.version, schema_synced_at: new Date().toISOString() };
  if (!form.mapping) patch.mapping = detectMapping(schema, cfg.officer_field);
  const { error } = await admin.from("kobo_forms").update(patch).eq("id", form.id);
  if (error) throw new Error(error.message);
  return { ...form, ...patch };
}

/** Stores submissions exactly as Kobo sent them. On a complete pull,
    anything Kobo no longer has was deleted there and is marked removed. */
async function storeKoboRaw(form: Record<string, any>, rows: Record<string, any>[], source: "sync" | "webhook", { complete = false } = {}) {
  const { data: existing, error } = await selectAll(() => admin.from("kobo_raw_submissions")
    .select("id, kobo_id, payload_hash, removed_at").eq("kobo_form_id", form.id).order("id"));
  if (error) throw new Error(error.message);
  const byKoboId = new Map(existing.map((e) => [Number(e.kobo_id), e]));
  const now = new Date().toISOString();
  const seen = new Set<number>();
  const inserts: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  for (const row of rows) {
    const kid = Number(row?._id);
    if (!Number.isSafeInteger(kid)) continue;
    seen.add(kid);
    const hash = sha256(stableStringify(row));
    const e = byKoboId.get(kid);
    const fields = {
      instance_id: String(row["meta/instanceID"] ?? row._uuid ?? "") || null,
      payload: row, payload_hash: hash, kobo_submitted_at: koboTime(row._submission_time),
      kobo_validation: row._validation_status?.uid ?? null, updated_at: now, removed_at: null,
    };
    if (!e) inserts.push({ id: rid("kraw"), kobo_form_id: form.id, kobo_id: kid, source, received_at: now, ...fields });
    else if (e.payload_hash !== hash || e.removed_at) updates.push({ id: e.id, ...fields });
  }
  for (let i = 0; i < inserts.length; i += 200) {
    // A webhook and a sync can race: the second copy is simply skipped.
    const { error: iErr } = await admin.from("kobo_raw_submissions")
      .upsert(inserts.slice(i, i + 200), { onConflict: "kobo_form_id,kobo_id", ignoreDuplicates: true });
    if (iErr) throw new Error(iErr.message);
  }
  for (const u of updates) {
    const { error: uErr } = await admin.from("kobo_raw_submissions").update(u).eq("id", u.id as string);
    if (uErr) throw new Error(uErr.message);
  }
  let removed = 0;
  // An empty pull with history on file looks like an outage, not a purge.
  if (complete && (rows.length || !existing.length)) {
    const gone = existing.filter((e) => !seen.has(Number(e.kobo_id)) && !e.removed_at).map((e) => e.id as string);
    for (let i = 0; i < gone.length; i += 150) {
      await admin.from("kobo_raw_submissions").update({ removed_at: now }).in("id", gone.slice(i, i + 150));
    }
    removed = gone.length;
  }
  return { added: inserts.length, changed: updates.length, removed };
}

/** The portal's reference data the rules check against. */
async function koboContext(form: Record<string, any>, officerField: string): Promise<PipelineContext> {
  const [schools, aliases, profiles, counties] = await Promise.all([
    selectAll(() => admin.from("schools").select("id, name, code, county").order("id")),
    selectAll(() => admin.from("kobo_school_aliases").select("value_key, school_id").order("value_key")),
    selectAll(() => admin.from("profiles").select("id, role, status, county").order("id")),
    loadCounties(),
  ]);
  const failed = [schools, aliases, profiles].find((r) => r.error);
  if (failed) throw new Error(failed.error!.message);
  const schema = form.schema as KoboSchema;
  return {
    schema,
    mapping: (form.mapping as KoboMapping) ?? detectMapping(schema, officerField),
    schools: schools.data as PipelineContext["schools"],
    counties: counties.map((c) => ({ name: c.name, code: c.code })),
    aliases: Object.fromEntries(aliases.data.map((a) => [a.value_key, a.school_id])),
    profiles: Object.fromEntries(profiles.data.map((p) => [p.id, { role: p.role, status: p.status ?? "active", county: p.county || null }])),
    now: new Date(),
  };
}

/** Runs every stored submission of one survey through the rules and writes
    the records that changed (with their issues). People's review decisions
    are never touched. Returns the counts by status. */
async function processKoboForm(form: Record<string, any>, officerField: string) {
  if (!form.schema) return null;
  const [raws, recs] = await Promise.all([
    selectAll(() => admin.from("kobo_raw_submissions").select("*").eq("kobo_form_id", form.id).order("id")),
    selectAll(() => admin.from("kobo_records").select("id, kobo_id, record_hash").eq("kobo_form_id", form.id).order("id")),
  ]);
  if (raws.error || recs.error) throw new Error((raws.error ?? recs.error)!.message);
  const ctx = await koboContext(form, officerField);
  const results = processBatch(raws.data.map((r) => ({
    koboId: Number(r.kobo_id), instanceId: r.instance_id ?? null,
    submittedAt: r.kobo_submitted_at ?? koboTime(r.payload?._submission_time),
    koboValidation: r.kobo_validation ?? null, removed: !!r.removed_at, payload: r.payload,
  })), ctx);
  const rawIdByKobo = new Map(raws.data.map((r) => [Number(r.kobo_id), r.id as string]));
  const existing = new Map(recs.data.map((r) => [Number(r.kobo_id), r]));
  const idByKobo = new Map(results.map((r) => [r.koboId, (existing.get(r.koboId)?.id as string) ?? rid("krec")]));
  const now = new Date().toISOString();
  const changed: Record<string, unknown>[] = [];
  const issues: Record<string, unknown>[] = [];
  for (const res of results) {
    const id = idByKobo.get(res.koboId)!;
    const row = {
      id, raw_id: rawIdByKobo.get(res.koboId), kobo_form_id: form.id, kobo_id: res.koboId,
      submitted_at: res.submittedAt, observed_on: res.observedOn, school_id: res.schoolId, school_value: res.schoolValue,
      county: res.county, officer_id: res.officerId, status: res.status,
      duplicate_of: res.duplicateOf != null ? idByKobo.get(res.duplicateOf) ?? null : null,
      error_count: res.errorCount, warning_count: res.warningCount, answers: res.answers,
    };
    const recordHash = sha256(stableStringify({ ...row, issues: res.issues }));
    if (existing.get(res.koboId)?.record_hash === recordHash) continue;
    changed.push({ ...row, record_hash: recordHash, processed_at: now });
    for (const i of res.issues) issues.push({ record_id: id, kobo_form_id: form.id, ...i });
  }
  // Oldest first, so a duplicate's original is always written before it.
  for (let i = 0; i < changed.length; i += 200) {
    const { error } = await admin.from("kobo_records").upsert(changed.slice(i, i + 200), { onConflict: "id" });
    if (error) throw new Error(error.message);
  }
  const changedIds = changed.map((r) => r.id as string);
  for (let i = 0; i < changedIds.length; i += 150) {
    await admin.from("kobo_record_issues").delete().in("record_id", changedIds.slice(i, i + 150));
  }
  for (let i = 0; i < issues.length; i += 500) {
    const { error } = await admin.from("kobo_record_issues").insert(issues.slice(i, i + 500));
    if (error) throw new Error(error.message);
  }
  const live = results.filter((r) => r.status !== "removed");
  const by = (s: string) => results.filter((r) => r.status === s).length;
  await admin.from("kobo_forms").update({
    submission_count: live.length,
    rejected_count: by("rejected"),
    unattributed_count: live.filter((r) => r.status !== "rejected" && !r.officerId).length,
    processed_at: now,
  }).eq("id", form.id);
  // Which officers have done this survey (the field officer's "Submitted").
  const officers = [...new Set(live.filter((r) => r.officerId && r.status !== "rejected" && r.status !== "duplicate").map((r) => r.officerId!))];
  if (officers.length) {
    await admin.from("kobo_submissions").upsert(officers.map((officer) => {
      const first = live.find((r) => r.officerId === officer)!;
      return { kobo_form_id: form.id, officer_id: officer, kobo_submission_id: String(first.koboId), source: "sync", submitted_at: first.submittedAt ?? now };
    }), { onConflict: "kobo_form_id,officer_id", ignoreDuplicates: true });
  }
  return {
    received: live.length, valid: by("valid"), invalid: by("invalid"), duplicate: by("duplicate"),
    rejected: by("rejected"), removed: by("removed"), withWarnings: live.filter((r) => r.warningCount > 0).length,
    updated: changed.length,
  };
}

/* Pull every attached survey: refresh its questions, store what Kobo has,
   and run it all through validation. */
app.post("/kobo/sync", requirePermission("kobo.manage"), async (c) => {
  const cfg = await loadKoboConfig();
  if (!cfg) return c.json({ error: "Connect KoboToolbox first" }, 400);
  const { data: forms } = await admin.from("kobo_forms").select("*").eq("active", true);
  const done: Record<string, unknown>[] = [];
  const failed: string[] = [];
  for (const f0 of forms ?? []) {
    try {
      const f = await refreshKoboSchema(cfg, f0);
      const rows = await koboAllSubmissions(cfg, f.asset_uid as string);
      const stored = await storeKoboRaw(f, rows, "sync", { complete: true });
      const stats = await processKoboForm(f, cfg.officer_field);
      const at = new Date().toISOString();
      await admin.from("kobo_forms").update({ synced_at: at, last_sync_attempt_at: at, last_sync_error: null }).eq("id", f.id);
      done.push({ id: f.id, title: f.title, ...stored, ...stats });
    } catch (e) {
      console.error("kobo sync failed for", f0.title, (e as Error).message);
      failed.push(f0.title as string);
      // Kept for the Sync center (the message never carries the token).
      await admin.from("kobo_forms").update({
        last_sync_attempt_at: new Date().toISOString(), last_sync_error: koboErrorText(e),
      }).eq("id", f0.id);
    }
  }
  await audit(c, "kobo.synced", "kobo_forms", null, { forms: done.length, failed });
  return c.json({ ok: true, forms: done, failed });
});

/** What the pipeline made of one survey: counts, issues by rule, school
    values it couldn't match, and the field mapping. */
async function koboPipelineSummary(form: Record<string, any>, scope?: PlaceScope) {
  const [recs, issues, schools] = await Promise.all([
    selectAll(() => admin.from("kobo_records").select("id, status, review, warning_count, school_id, county").eq("kobo_form_id", form.id).order("id")),
    selectAll(() => admin.from("kobo_record_issues").select("record_id, rule, severity, value, message").eq("kobo_form_id", form.id).order("id")),
    selectAll(() => admin.from("schools").select("id, name, code, county").order("id")),
  ]);
  const failed = [recs, issues, schools].find((r) => r.error);
  if (failed) throw new Error(failed.error!.message);
  const live = recs.data.filter((r) => r.status !== "removed" && (!scope || inPlaceScope(scope, r.school_id, r.county)));
  const by = (s: string) => live.filter((r) => r.status === s).length;
  const liveIds = new Set(live.map((r) => r.id));
  const liveIssues = issues.data.filter((i) => liveIds.has(i.record_id));
  const unknown = new Map<string, number>();
  for (const i of liveIssues) {
    if (i.rule === "school" && i.severity === "error" && i.value && /isn't a portal school/.test(i.message)) {
      unknown.set(i.value, (unknown.get(i.value) ?? 0) + 1);
    }
  }
  const schema = form.schema as KoboSchema | null;
  return {
    form: {
      id: form.id, title: form.title, active: form.active, syncedAt: form.synced_at ?? null,
      processedAt: form.processed_at ?? null, schemaSyncedAt: form.schema_synced_at ?? null,
    },
    fields: (schema?.fields ?? []).filter((f) => !f.repeats.length).map((f) => ({ xpath: f.xpath, label: f.label, type: f.type })),
    mapping: form.mapping ?? null,
    stats: {
      received: live.length, valid: by("valid"), invalid: by("invalid"), duplicate: by("duplicate"),
      rejected: by("rejected"), removed: recs.data.length - live.length,
      accepted: live.filter((r) => r.review === "accepted").length,
      excluded: live.filter((r) => r.review === "excluded").length,
      counted: live.filter((r) => countsOnDashboards(r.status, r.review)).length,
      needsReview: live.filter((r) => (r.status === "invalid" || r.status === "duplicate") && !r.review).length,
      withWarnings: live.filter((r) => r.warning_count > 0).length,
    },
    issuesByRule: KOBO_RULES.map((rule) => ({
      rule,
      errors: new Set(liveIssues.filter((i) => i.rule === rule && i.severity === "error").map((i) => i.record_id)).size,
      warnings: new Set(liveIssues.filter((i) => i.rule === rule && i.severity === "warning").map((i) => i.record_id)).size,
    })),
    unknownSchools: [...unknown.entries()].sort((a, b) => b[1] - a[1]).slice(0, 100).map(([value, count]) => {
      const s = suggestSchool(value, schools.data as PipelineContext["schools"]);
      return { value, count, suggestion: s ? { id: s.id, name: s.name, code: s.code } : null };
    }),
  };
}

async function loadKoboForm(id: string) {
  const { data } = await admin.from("kobo_forms").select("*").eq("id", id).maybeSingle();
  return data;
}

app.get("/kobo/forms/:id/pipeline", requirePermission("kobo.manage", "kobo.results.view"), async (c) => {
  const form = await loadKoboForm(c.req.param("id"));
  if (!form) return c.json({ error: "Survey not found" }, 404);
  try { return c.json(await koboPipelineSummary(form, scopeOf(c))); } catch (e) { return c.json({ error: (e as Error).message }, 500); }
});

/* Which questions hold the school, county, officer and date. Saving it
   re-runs the survey's stored submissions through the rules. */
app.put("/kobo/forms/:id/mapping", requirePermission("kobo.manage"), async (c) => {
  const form = await loadKoboForm(c.req.param("id"));
  if (!form) return c.json({ error: "Survey not found" }, 404);
  if (!form.schema) return c.json({ error: "Sync this survey first, so the portal knows its questions" }, 409);
  const b = await c.req.json().catch(() => ({}));
  const top = new Set((form.schema as KoboSchema).fields.filter((f) => !f.repeats.length).map((f) => f.xpath));
  const pickField = (v: unknown) => (v == null || v === "" ? null : String(v));
  const mapping: KoboMapping = {
    school: pickField(b.school), schoolRequired: b.schoolRequired !== false,
    county: pickField(b.county),
    officer: pickField(b.officer), officerRequired: b.officerRequired !== false,
    date: pickField(b.date),
  };
  for (const k of ["school", "county", "officer", "date"] as const) {
    if (mapping[k] && !top.has(mapping[k]!)) return c.json({ error: `“${mapping[k]}” isn't a question in this survey` }, 400);
  }
  if (!mapping.school) mapping.schoolRequired = false;
  if (!mapping.officer) mapping.officerRequired = false;
  await admin.from("kobo_forms").update({ mapping }).eq("id", form.id);
  await audit(c, "kobo.mapping_changed", "kobo_form", form.id, { mapping });
  const cfg = await loadKoboConfig();
  try {
    await processKoboForm({ ...form, mapping }, cfg?.officer_field ?? "officer_ref");
    return c.json(await koboPipelineSummary(await loadKoboForm(form.id)));
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

app.post("/kobo/forms/:id/reprocess", requirePermission("kobo.manage"), async (c) => {
  const form = await loadKoboForm(c.req.param("id"));
  if (!form) return c.json({ error: "Survey not found" }, 404);
  if (!form.schema) return c.json({ error: "Sync this survey first, so the portal knows its questions" }, 409);
  const cfg = await loadKoboConfig();
  try {
    await processKoboForm(form, cfg?.officer_field ?? "officer_ref");
    return c.json(await koboPipelineSummary(await loadKoboForm(form.id)));
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

/* The review queue: ?formId= &status= (or needs_review: failing or duplicate,
   no decision yet) &rule= &review=none|accepted|excluded &limit= &offset=.
   Newest first; each with its issues, without answers. */
app.get("/kobo/records", requirePermission("kobo.manage", "kobo.results.view"), async (c) => {
  const f = (k: string) => String(c.req.query(k) ?? "");
  if (!f("formId")) return c.json({ error: "Pick a survey" }, 400);
  const { data, error } = await selectAll(() => {
    let q = admin.from("kobo_records")
      .select("id, kobo_id, kobo_form_id, submitted_at, observed_on, school_id, school_value, county, officer_id, status, duplicate_of, error_count, warning_count, review, review_note, reviewed_at")
      .eq("kobo_form_id", f("formId")).order("id");
    if (f("status") && f("status") !== "needs_review") q = q.eq("status", f("status"));
    return q;
  });
  if (error) return c.json({ error: error.message }, 500);
  let rows = data.filter((r) => (r.status !== "removed" || f("status") === "removed") && inScope(c, r.school_id, r.county));
  if (f("status") === "needs_review") rows = rows.filter((r) => (r.status === "invalid" || r.status === "duplicate") && !r.review);
  if (f("review") === "none") rows = rows.filter((r) => !r.review);
  else if (f("review")) rows = rows.filter((r) => r.review === f("review"));
  let issues: Record<string, any>[] = [];
  if (rows.length) issues = await selectIn("kobo_record_issues", "record_id", rows.map((r) => r.id as string));
  if (f("rule")) {
    const hit = new Set(issues.filter((i) => i.rule === f("rule")).map((i) => i.record_id));
    rows = rows.filter((r) => hit.has(r.id));
  }
  rows.sort((a, b) => String(b.submitted_at ?? "").localeCompare(String(a.submitted_at ?? "")));
  const total = rows.length;
  const offset = Math.max(0, Number(f("offset")) || 0);
  const page = rows.slice(offset, offset + Math.max(1, Math.min(200, Number(f("limit")) || 50)));
  const ids = (k: string) => [...new Set(page.map((r) => r[k]).filter(Boolean))] as string[];
  const [schools, officers] = await Promise.all([
    ids("school_id").length ? admin.from("schools").select("id, name, code").in("id", ids("school_id")) : { data: [] },
    ids("officer_id").length ? admin.from("profiles").select("id, full_name").in("id", ids("officer_id")) : { data: [] },
  ]);
  const sName = new Map((schools.data ?? []).map((s: Record<string, unknown>) => [s.id, `${s.name} (${s.code})`]));
  const oName = new Map((officers.data ?? []).map((p: Record<string, unknown>) => [p.id, p.full_name]));
  return c.json({
    total,
    records: page.map((r) => ({
      id: r.id, koboId: Number(r.kobo_id), submittedAt: r.submitted_at, observedOn: r.observed_on,
      school: r.school_id ? sName.get(r.school_id) ?? null : null, schoolValue: r.school_value, county: r.county,
      officer: r.officer_id ? oName.get(r.officer_id) ?? null : null, status: r.status,
      counted: countsOnDashboards(r.status, r.review),
      review: r.review ?? null, reviewNote: r.review_note ?? null, reviewedAt: r.reviewed_at ?? null,
      issues: issues.filter((i) => i.record_id === r.id)
        .map((i) => ({ rule: i.rule, severity: i.severity, field: i.field, message: i.message })),
    })),
  });
});

/** An answer for people to read: choice labels, not codes. */
function displayAnswer(f: Record<string, any>, v: unknown, choices: Record<string, { name: string; label: string }[]>): string {
  if (v == null || v === "") return "";
  const label = (x: unknown) => choices[f.listName ?? ""]?.find((c) => c.name === x)?.label ?? String(x);
  if (Array.isArray(v)) return v.map((x) => (f.type === "select_multiple" || f.type === "select_one" ? label(x) : x == null ? "" : typeof x === "object" ? JSON.stringify(x) : String(x))).join(f.repeats?.length ? " | " : ", ");
  if (f.type === "select_one") return label(v);
  if (f.type === "geopoint" && typeof v === "object") return `${(v as { lat: number }).lat}, ${(v as { lon: number }).lon}`;
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

app.get("/kobo/records/:id", requirePermission("kobo.manage", "kobo.results.view"), async (c) => {
  const { data: r } = await admin.from("kobo_records").select("*").eq("id", c.req.param("id")).maybeSingle();
  if (!r || !inScope(c, r.school_id, r.county)) return c.json({ error: "Record not found" }, 404);
  const form = await loadKoboForm(r.kobo_form_id);
  const schema = (form?.schema ?? { fields: [], choices: {} }) as KoboSchema;
  const [{ data: issues }, school, officer, reviewer, original] = await Promise.all([
    admin.from("kobo_record_issues").select("*").eq("record_id", r.id),
    r.school_id ? admin.from("schools").select("name, code").eq("id", r.school_id).maybeSingle() : { data: null },
    r.officer_id ? admin.from("profiles").select("full_name").eq("id", r.officer_id).maybeSingle() : { data: null },
    r.reviewed_by ? admin.from("profiles").select("full_name").eq("id", r.reviewed_by).maybeSingle() : { data: null },
    r.duplicate_of ? admin.from("kobo_records").select("kobo_id").eq("id", r.duplicate_of).maybeSingle() : { data: null },
  ]);
  return c.json({
    record: {
      id: r.id, koboId: Number(r.kobo_id), survey: form?.title ?? "", submittedAt: r.submitted_at, observedOn: r.observed_on,
      school: school.data ? `${school.data.name} (${school.data.code})` : null, schoolValue: r.school_value, county: r.county,
      officer: officer.data?.full_name ?? null, status: r.status, counted: countsOnDashboards(r.status, r.review),
      duplicateOf: original.data ? Number(original.data.kobo_id) : null,
      review: r.review ?? null, reviewNote: r.review_note ?? null, reviewedAt: r.reviewed_at ?? null,
      reviewedBy: reviewer.data?.full_name ?? null,
    },
    issues: (issues ?? []).map((i: Record<string, unknown>) => ({ rule: i.rule, severity: i.severity, field: i.field, message: i.message, value: i.value })),
    answers: schema.fields.map((f) => ({ xpath: f.xpath, label: f.label, type: f.type, value: displayAnswer(f, (r.answers ?? {})[f.xpath], schema.choices) }))
      .filter((a) => a.value !== ""),
  });
});

/* A person's decision on a flagged record: accept it onto the dashboards
   anyway, exclude it, or clear the decision. A reason is required. */
app.post("/kobo/records/:id/review", requirePermission("kobo.review"), async (c) => {
  const { data: r } = await admin.from("kobo_records").select("id, status, review, kobo_form_id, kobo_id, school_id, county").eq("id", c.req.param("id")).maybeSingle();
  if (!r || !inScope(c, r.school_id, r.county)) return c.json({ error: "Record not found" }, 404);
  const b = await c.req.json().catch(() => ({}));
  const decision = String(b.decision ?? "");
  if (!["accepted", "excluded", "clear"].includes(decision)) return c.json({ error: "Decision must be accepted, excluded or clear" }, 400);
  if (r.status === "removed") return c.json({ error: "This submission was deleted in KoboToolbox" }, 409);
  const note = String(b.note ?? "").trim().slice(0, 1000);
  if (decision !== "clear" && note.length < 3) return c.json({ error: "Say why, for the record" }, 400);
  const patch = decision === "clear"
    ? { review: null, review_note: null, reviewed_by: null, reviewed_at: null }
    : { review: decision, review_note: note, reviewed_by: c.get("actor").id, reviewed_at: new Date().toISOString() };
  const { error } = await admin.from("kobo_records").update(patch).eq("id", r.id);
  if (error) return c.json({ error: error.message }, 400);
  await audit(c, `kobo.record_${decision === "clear" ? "review_cleared" : decision}`, "kobo_record", r.id,
    { formId: r.kobo_form_id, koboId: r.kobo_id, status: r.status, note: decision === "clear" ? undefined : note });
  return c.json({ ok: true, counted: countsOnDashboards(r.status, patch.review) });
});

/* School aliases: a value a survey uses for a school → the portal school.
   Saving or removing one re-runs every survey. */
async function reprocessAllKobo() {
  const cfg = await loadKoboConfig();
  const { data: forms } = await admin.from("kobo_forms").select("*").eq("active", true);
  let n = 0;
  for (const f of forms ?? []) if (f.schema) { await processKoboForm(f, cfg?.officer_field ?? "officer_ref"); n++; }
  return n;
}

app.get("/kobo/school-aliases", requirePermission("kobo.manage", "kobo.results.view"), async (c) => {
  const { data, error } = await selectAll(() => admin.from("kobo_school_aliases").select("*").order("value_key"));
  if (error) return c.json({ error: error.message }, 500);
  const ids = [...new Set(data.map((a) => a.school_id as string))];
  const { data: schools } = ids.length ? await admin.from("schools").select("id, name, code").in("id", ids) : { data: [] };
  const s = new Map((schools ?? []).map((x: Record<string, unknown>) => [x.id, x]));
  return c.json({ aliases: data.map((a) => ({ key: a.value_key, value: a.value, schoolId: a.school_id, school: s.get(a.school_id) ? `${(s.get(a.school_id) as { name: string }).name} (${(s.get(a.school_id) as { code: string }).code})` : null })) });
});

app.post("/kobo/school-aliases", requirePermission("kobo.review"), async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const value = String(b.value ?? "").trim().slice(0, 200);
  const key = nameKey(value);
  if (!key) return c.json({ error: "Which value?" }, 400);
  const school = await loadSchool(b.schoolId);
  if (!school || !inScope(c, school.id)) return c.json({ error: "Choose a portal school" }, 400);
  const { data: existing } = await admin.from("kobo_school_aliases").select("value_key").eq("value_key", key).maybeSingle();
  const row = { value_key: key, value, school_id: school.id, created_by: c.get("actor").id };
  const { error } = existing
    ? await admin.from("kobo_school_aliases").update({ school_id: school.id }).eq("value_key", key)
    : await admin.from("kobo_school_aliases").insert(row);
  if (error) return c.json({ error: error.message }, 400);
  await audit(c, "kobo.school_alias_saved", "kobo_school_alias", key, { value, schoolId: school.id });
  try { return c.json({ ok: true, reprocessed: await reprocessAllKobo() }); } catch (e) { return c.json({ error: (e as Error).message }, 500); }
});

app.delete("/kobo/school-aliases/:key", requirePermission("kobo.review"), async (c) => {
  const key = c.req.param("key");
  const { data } = await admin.from("kobo_school_aliases").delete().eq("value_key", key).select("value_key");
  if (!data?.length) return c.json({ error: "Alias not found" }, 404);
  await audit(c, "kobo.school_alias_removed", "kobo_school_alias", key, {});
  try { return c.json({ ok: true, reprocessed: await reprocessAllKobo() }); } catch (e) { return c.json({ error: (e as Error).message }, 500); }
});

/* The REST Service password for Kobo's push. Shown once; only its hash
   is stored. Creating a new one replaces the old. */
app.post("/kobo/webhook", requirePermission("kobo.configure"), async (c) => {
  if (!(await loadKoboConfig())) return c.json({ error: "Connect KoboToolbox first" }, 400);
  const secret = randomBytes(24).toString("base64url");
  const { error } = await admin.from("kobo_config")
    .update({ webhook_secret_hash: hashToken(secret), webhook_secret_set_at: new Date().toISOString() }).eq("id", 1);
  if (error) return c.json({ error: error.message }, 400);
  await audit(c, "kobo.webhook_secret_created", "kobo_config", 1, {});
  return c.json({ url: `${SUPABASE_URL}/functions/v1/api/kobo/hook`, username: KOBO_HOOK_USER, password: secret });
});

app.delete("/kobo/webhook", requirePermission("kobo.configure"), async (c) => {
  await admin.from("kobo_config").update({ webhook_secret_hash: null, webhook_secret_set_at: null }).eq("id", 1);
  await audit(c, "kobo.webhook_secret_removed", "kobo_config", 1, {});
  return c.json({ ok: true });
});

// ---- KoboToolbox: survey results (charts), from the portal's own records ----
/* ?county= ?school= (name) narrow it to records linked there. Only records
   that pass validation (or a person accepted) are counted. */
app.get("/kobo/forms/:id/results", requirePermission("kobo.manage", "kobo.results.view"), async (c) => {
  const form = await loadKoboForm(c.req.param("id"));
  if (!form) return c.json({ error: "Survey not found" }, 404);
  const county = String(c.req.query("county") ?? "").trim();
  const schoolName = String(c.req.query("school") ?? "").trim();
  const base = { id: form.id, title: form.title, syncedAt: form.synced_at ?? null };
  if (!form.schema) {
    return c.json({ ...base, needsSync: true, submissionCount: 0, received: 0, excluded: null, questions: [], lastSubmission: null });
  }
  const { data: recs, error } = await selectAll(() => admin.from("kobo_records")
    .select("id, status, review, answers, officer_id, school_id, county, submitted_at").eq("kobo_form_id", form.id).order("id"));
  if (error) return c.json({ error: error.message }, 500);
  const area = scopeOf(c);
  if (!area.global) recs.splice(0, recs.length, ...recs.filter((r) => inPlaceScope(area, r.school_id, r.county)));
  let schoolIds: Set<string> | null = null;
  if (schoolName) {
    const { data: s } = await admin.from("schools").select("id, county").eq("name", schoolName);
    schoolIds = new Set((s ?? []).filter((x: Record<string, unknown>) => !county || x.county === county).map((x: Record<string, unknown>) => x.id as string));
  }
  const inScope = recs.filter((r) => r.status !== "removed" && (!county || r.county === county) && (!schoolIds || schoolIds.has(r.school_id)));
  const counted = inScope.filter((r) => countsOnDashboards(r.status, r.review));
  const schema = form.schema as KoboSchema;
  const mapping = (form.mapping ?? {}) as KoboMapping;
  const questions: Record<string, unknown>[] = [];
  const tallyBy = async (key: "officer_id" | "school_id", label: string, table: string, nameOf: (x: Record<string, any>) => string) => {
    const per = new Map<string, number>();
    for (const r of counted) per.set(r[key] ?? "", (per.get(r[key] ?? "") ?? 0) + 1);
    const ids = [...per.keys()].filter(Boolean);
    const { data: rows } = ids.length ? await admin.from(table).select("*").in("id", ids) : { data: [] };
    const names = new Map((rows ?? []).map((x: Record<string, any>) => [x.id, nameOf(x)]));
    questions.push({
      name: `_${key}`, label, type: "meta", chart: "bar", answered: counted.length,
      data: [...per.entries()].map(([k, v]) => ({ label: k ? names.get(k) ?? "Unknown" : "(not linked)", value: v })).sort((a, b) => b.value - a.value),
    });
  };
  if (counted.length) {
    if (mapping.school) await tallyBy("school_id", "Submissions by school", "schools", (s) => `${s.name} (${s.code})`);
    if (mapping.officer) await tallyBy("officer_id", "Submissions by field officer", "profiles", (p) => p.full_name || "Unnamed officer");
  }
  questions.push(...summarizeAnswers(schema, counted.map((r) => r.answers ?? {}), new Set([mapping.officer, mapping.school].filter(Boolean) as string[])));
  const n = (s: string) => inScope.filter((r) => r.status === s && !countsOnDashboards(r.status, r.review)).length;
  const times = counted.map((r) => String(r.submitted_at ?? "")).filter(Boolean).sort();
  return c.json({
    ...base,
    submissionCount: counted.length,
    received: inScope.length,
    excluded: {
      invalid: n("invalid"), duplicate: n("duplicate"), rejected: n("rejected"),
      byReview: inScope.filter((r) => r.review === "excluded").length,
    },
    excludedNotApproved: n("rejected"),
    filtered: !!(county || schoolName),
    lastSubmission: times.length ? times[times.length - 1] : null,
    questions,
  });
});

// ---- KoboToolbox: field-officer surveys ----

app.get("/kobo/my-surveys", requirePermission("kobo.surveys.fill"), async (c) => {
  const officerId = c.get("actor").id;
  const cfg = await loadKoboConfig();
  const { data: forms } = await admin
    .from("kobo_forms").select("*").eq("active", true).order("created_at", { ascending: false });
  const { data: mine } = await admin
    .from("kobo_submissions").select("*").eq("officer_id", officerId);
  const done = new Map((mine ?? []).map((s) => [s.kobo_form_id, s]));

  if (cfg) {
    for (const f of forms ?? []) {
      if (done.has(f.id)) continue;
      try {
        const q = encodeURIComponent(JSON.stringify({ [cfg.officer_field]: officerId }));
        const data = await koboJson(cfg, `/api/v2/assets/${f.asset_uid}/data/?format=json&query=${q}&limit=1`);
        const rows: any[] = data.results ?? [];
        if ((data.count ?? rows.length) > 0) {
          const row = rows[0] ?? {};
          const rec = {
            kobo_form_id: f.id,
            officer_id: officerId,
            kobo_submission_id: String(row._id ?? ""),
            source: "sync",
            submitted_at: row._submission_time ?? new Date().toISOString(),
          };
          await admin.from("kobo_submissions").upsert(rec, {
            onConflict: "kobo_form_id,officer_id",
            ignoreDuplicates: true,
          });
          done.set(f.id, rec);
        }
      } catch { /* leave as pending */ }
    }
  }

  const field = cfg?.officer_field ?? "officer_ref";
  return c.json({
    configured: !!cfg,
    surveys: (forms ?? []).map((f) => {
      const s = done.get(f.id);
      const sep = (f.enketo_url ?? "").includes("?") ? "&" : "?";
      return {
        id: f.id,
        title: f.title,
        openUrl: f.enketo_url
          ? `${f.enketo_url}${sep}d[${field}]=${encodeURIComponent(officerId)}`
          : null,
        submitted: !!s,
        submittedAt: s?.submitted_at ?? null,
        source: s?.source ?? null,
      };
    }),
  });
});

app.post("/kobo/my-surveys/:id/submitted", requirePermission("kobo.surveys.fill"), async (c) => {
  const officerId = c.get("actor").id;
  const id = c.req.param("id");
  const { data: form } = await admin.from("kobo_forms").select("id").eq("id", id).maybeSingle();
  if (!form) return c.json({ error: "Survey not found" }, 404);
  const { error } = await admin.from("kobo_submissions").upsert({
    kobo_form_id: id,
    officer_id: officerId,
    source: "manual",
    submitted_at: new Date().toISOString(),
  }, { onConflict: "kobo_form_id,officer_id", ignoreDuplicates: true });
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ ok: true });
});

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Server error" }, 500);
});

// The authorization tests import `app` directly instead of serving it.
if (!Deno.env.get("HPF_API_TEST")) Deno.serve(app.fetch);
