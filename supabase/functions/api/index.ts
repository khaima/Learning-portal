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
  ACCOUNT_STATUSES, can, canManageAccount, COUNTY_ROLES, grantableRoles, type Permission,
  permissionsFor, type Role, ROLE_LABEL, SELF_REQUESTABLE_ROLES,
  STAFF_ROLES, STATUS_TRANSITIONS, GRADES, nextGrade, type EnrollmentStatus,
} from "./permissions.ts";
import {
  ASSIGNMENT_STATUSES, type AssignmentStatus, autoMark, type Band, bandFor, cleanQuestions, cleanResponse,
  groupResults, isAutoMarked, isLate, MAX_FILES_PER_ANSWER, pairsOf, percentOf, type Question,
  RESULT_DIMENSIONS, type ResultAssignment, type ResultDimension, type ResultSubmission, round2, summarize,
} from "./lms.ts";

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

type KoboConfig = { base_url: string; api_token: string; officer_field: string };

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

/** Kobo labels are a translation array, a bare string, or missing. */
function koboLabel(label: unknown, fallback: string): string {
  if (Array.isArray(label)) return String(label[0] ?? fallback);
  if (typeof label === "string" && label.trim()) return label;
  return fallback;
}

/** Every answer to a question in one submission: a plain or grouped
    question gives one value; a question inside a repeat group gives one
    per repeat (Kobo nests those as an array of objects under the
    repeat's own key). Kobo's own `_…` fields are never searched. */
function rowValues(row: Record<string, unknown>, name: string): unknown[] {
  const out: unknown[] = [];
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith("_")) continue;
    if (k === name || k.endsWith("/" + name)) out.push(v);
    else if (Array.isArray(v)) {
      for (const item of v) {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          out.push(...rowValues(item as Record<string, unknown>, name));
        }
      }
    }
  }
  return out;
}

/** A submission a reviewer marked "Not approved" in KoboToolbox. */
function koboRejected(row: Record<string, unknown>): boolean {
  const vs = row._validation_status as { uid?: string } | undefined;
  return vs?.uid === "validation_status_not_approved";
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

const KOBO_SKIP_TYPES = new Set([
  "start", "end", "today", "deviceid", "subscriberid", "simserial", "phonenumber",
  "username", "note", "calculate", "begin_group", "end_group", "begin_repeat",
  "end_repeat", "begin_kobomatrix", "end_kobomatrix", "audit", "background-audio",
  "hidden",
]);

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
function canSeeLibrary(audience: string | null | undefined, role: Role): boolean {
  if (can(role, "library.manage")) return true;
  const dest = normalizeAudience(audience);
  if (dest === "school_leader") return can(role, "library.read.head");
  if (dest === "staff") return can(role, "library.read.staff");
  return can(role, "library.read.learner");
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
const mapProfile = (r: Record<string, unknown>) => ({
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
  // What the signed-in person may do — the app uses this only to decide
  // what to show; every route checks again on the server.
  permissions: r.status === "active" || r.status == null ? [...permissionsFor(r.role as string)] : [],
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
const VISIT_TYPES = ["Learning", "Infrastructure", "ICT", "MEP"];
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

type Actor = { id: string; role: Role; fullName: string; grade: string; school: string; county: string; schoolId: string | null };
type Vars = {
  actorKind: "staff" | "learner";
  userId: string;
  email: string;
  learnerId: string;
  actor: Actor;
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
    allowHeaders: ["authorization", "content-type"],
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
  await next();
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
    c.set("actor", { id: l.id, role: "learner", fullName: l.full_name, grade: l.grade, school: l.school, county: l.county, schoolId: l.school_id ?? null });
    return null;
  }
  const p = await loadStaffProfile(c.get("userId"));
  if (!p) return c.json({ needsOnboarding: true, email: c.get("email") }, 428);
  const status = p.status ?? "active";
  if (status !== "active") {
    return c.json({ error: STATUS_MESSAGE[status] ?? "Your account is not active.", accountStatus: status }, 403);
  }
  if (!STAFF_ROLES.includes(p.role)) return c.json({ error: "Your account has no valid role." }, 403);
  c.set("actor", { id: p.id, role: p.role, fullName: p.full_name, grade: p.grade, school: p.school, county: p.county, schoolId: p.school_id ?? null });
  return null;
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
    const role = c.get("actor").role;
    if (!perms.some((p) => can(role, p))) return c.json({ error: NO_PERMISSION }, 403);
    return next();
  };
}

/** For a handler that's already past a guard. */
// deno-lint-ignore no-explicit-any
const actorCan = (c: any, p: Permission) => can(c.get("actor")?.role, p);

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
  return c.json({ profile: mapProfile(profile) });
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
  // Head counts per school only for an active account that manages schools.
  const me = c.get("actorKind") === "staff" ? await loadStaffProfile(c.get("userId")) : null;
  if (me && (me.status ?? "active") === "active" && can(me.role, "schools.manage")) {
    const [{ data: profs }, { data: learners }] = await Promise.all([
      selectAll(() => admin.from("profiles").select("school_id, role").not("school_id", "is", null).order("id")),
      selectAll(() => admin.from("learners").select("school_id").not("school_id", "is", null).eq("enrollment_status", "ACTIVE").order("id")),
    ]);
    const count = (rows: Record<string, unknown>[] | null, id: unknown, role?: string) =>
      (rows ?? []).filter((r) => r.school_id === id && (!role || r.role === role)).length;
    for (const s of schools) {
      s.teachers = count(profs, s.id, "teacher");
      s.heads = count(profs, s.id, "school_leader");
      s.learners = count(learners, s.id);
    }
  }
  return c.json({
    counties: counties.map((co) => co.name),
    countyCodes: Object.fromEntries(counties.map((co) => [co.name, co.code])),
    schools,
  });
});

/* Counties: the education team can add one (with its short code, which
   prefixes every school code in it) or remove one that has no schools
   and no field officers in it yet. Names and codes can't be edited, so
   no existing code ever changes. */
app.post("/counties", requirePermission("schools.manage"), async (c) => {
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
  const name = decodeURIComponent(c.req.param("name"));
  if (!(await isCounty(name))) return c.json({ error: "County not found" }, 404);
  const [{ count: schools }, { count: officers }, { count: forms }] = await Promise.all([
    admin.from("schools").select("id", { count: "exact", head: true }).eq("county", name),
    admin.from("profiles").select("id", { count: "exact", head: true }).eq("role", "field_officer").eq("county", name),
    admin.from("forms").select("id", { count: "exact", head: true }).eq("county", name),
  ]);
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
  if (!school) return c.json({ error: "School not found" }, 404);
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
  if (!school) return c.json({ error: "School not found" }, 404);
  const [{ count: staff }, { count: learners }] = await Promise.all([
    admin.from("profiles").select("id", { count: "exact", head: true }).eq("school_id", school.id),
    admin.from("learners").select("id", { count: "exact", head: true }).eq("school_id", school.id),
  ]);
  if ((staff ?? 0) + (learners ?? 0) > 0) {
    return c.json({
      error: `${school.name} still has ${staff ?? 0} staff and ${learners ?? 0} learner(s) — move them to another school first`,
    }, 409);
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

type LearnerScope =
  | { kind: "all" }
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
  if (can(a.role, "learners.view.all") || can(a.role, "learners.manage.all")) return { kind: "all" };
  if (can(a.role, "learners.view.school")) return a.schoolId ? { kind: "school", schoolId: a.schoolId } : { kind: "none" };
  if (can(a.role, "learners.manage")) {
    return a.schoolId ? { kind: "teacher", teacherId: a.id, schoolId: a.schoolId, classIds: await classesTaughtBy(a.id) } : { kind: "none" };
  }
  return { kind: "none" };
}

function inLearnerScope(scope: LearnerScope, l: Record<string, unknown>): boolean {
  if (scope.kind === "all") return true;
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

  // The school is the caller's own — only an all-schools administrator
  // picks one. A client can never place a learner in someone else's school.
  const scope = await learnerScope(c);
  const schoolId = actorCan(c, "learners.manage.all") ? (b.schoolId ?? actor.schoolId) : actor.schoolId;
  const school = await loadSchool(schoolId);
  if (!school) return c.json({ error: actorCan(c, "learners.manage.all") ? "Choose a school" : "Choose your school first — reload the page to pick it" }, 409);

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
  if (!learner) return c.json({ error: "Learner not found" }, 404);
  const b = await c.req.json().catch(() => ({}));
  const to = await loadSchool(b.toSchoolId);
  if (!to) return c.json({ error: "Choose the school they're moving to" }, 400);
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
  if (actorCan(c, "classes.manage.all")) return true;
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
  const { data, error } = await selectAll(() => {
    let q = admin.from("classes").select("*").order("grade").order("name").order("id");
    if (schoolId) q = q.eq("school_id", schoolId);
    if (yearId && c.req.query("allYears") !== "1") q = q.eq("academic_year_id", yearId);
    if (!includeArchived) q = q.is("archived_at", null);
    return q;
  });
  if (error) return c.json({ error: error.message }, 500);
  let rows = data ?? [];
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
  if (scope.kind === "all") return true;
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
  const manages = from && (actorCan(c, "learners.manage.all") || (actorCan(c, "learners.manage.school") && c.get("actor").schoolId === from.school_id));
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
  const role = c.get("actor").role;
  const { data, error } = await selectAll(() => admin
    .from("library_items")
    .select("*")
    .order("uploaded_at", { ascending: false })
    .order("id"));
  if (error) return c.json({ error: error.message }, 500);
  // A draft is only visible to whoever manages the library — everyone else
  // only ever sees what's actually been published, same as the audience
  // check right next to it. Only they get download links, too.
  const manages = can(role, "library.manage");
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
  const role = c.get("actor").role;
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
    if (!can(role, "library.manage") && !it.published) continue;
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

app.post("/library/:id/interactions", requireActive(), async (c) => {
  const itemId = c.req.param("id");
  const actor = c.get("actor");
  const { data: item } = await admin
    .from("library_items").select("id, audience").eq("id", itemId).maybeSingle();
  if (!item || !canSeeLibrary(item.audience as string, actor.role)) {
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
  if (!item || !canSeeLibrary(item.audience as string, actor.role)) {
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

  const allRows = interRes.data ?? [];
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

// ---- forms & responses (staff only) ----

/* Who receives a form: its role, and its county (null = every county).
   A field officer's visit-type forms are the exception — they're filled
   during a visit to a school in any county, so the county check happens
   against that school when the visit is submitted, not here. */
function formReaches(f: Record<string, unknown>, actor: Actor) {
  if (can(actor.role, "forms.manage") || can(actor.role, "forms.responses.view")) return true;
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
      created_by: c.get("actor").fullName,
      questions: kind === "questions" ? questions : [],
    })
    .select()
    .single();
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ form: await mapForm(data), uploads });
});

/* Permanently removes a form nobody has answered, with its blank file.
   A form with responses is archived instead (below) — responses are
   programme records, including ones filed during past school visits, and
   the database refuses to delete a form that still has any. */
app.delete("/forms/:id", requirePermission("forms.manage"), async (c) => {
  const id = c.req.param("id");
  const { data: form } = await admin.from("forms").select("files").eq("id", id).maybeSingle();
  if (!form) return c.json({ error: "Form not found" }, 404);
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
  const { data, error } = await admin.from("forms")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", c.req.param("id")).select().maybeSingle();
  if (error) return c.json({ error: error.message }, 400);
  if (!data) return c.json({ error: "Form not found" }, 404);
  return c.json({ form: await mapForm(data) });
});

app.post("/forms/:id/restore", requirePermission("forms.manage"), async (c) => {
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
    if (!can(p.role, "forms.manage") && !can(p.role, "forms.responses.view")) q = q.eq("respondent_id", p.id);
    return q;
  });
  if (error) return c.json({ error: error.message }, 500);
  const responses = await Promise.all((data ?? []).map((r) => mapResponse(r, can(p.role, "forms.manage"))));
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
  if (form.visit_type) return c.json({ error: "This form is filled in during a school visit" }, 400);
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
  const { data: existing } = await admin.from("responses").select("id")
    .eq("form_id", form.id).eq("respondent_id", p.id).is("visit_id", null).maybeSingle();
  const { data, error } = existing
    ? await admin.from("responses").update(row).eq("id", existing.id).select().single()
    : await admin.from("responses")
      .insert({ id: rid("resp"), form_id: form.id, respondent_id: p.id, ...row }).select().single();
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
  | { kind: "all" }
  | { kind: "school"; schoolId: string }
  | { kind: "teacher"; teacherId: string; schoolId: string; classIds: string[] }
  | { kind: "none" };

/** Which assignments (and results) the caller may see: every school, their
    own school (school head), or the classes they teach (teacher). */
// deno-lint-ignore no-explicit-any
async function assignmentScope(c: any): Promise<AssignmentScope> {
  const a = c.get("actor") as Actor;
  if (actorCan(c, "assignments.view.all")) return { kind: "all" };
  if (actorCan(c, "assignments.view.school")) return a.schoolId ? { kind: "school", schoolId: a.schoolId } : { kind: "none" };
  if (actorCan(c, "assignments.manage") || actorCan(c, "assignments.grade")) {
    return a.schoolId ? { kind: "teacher", teacherId: a.id, schoolId: a.schoolId, classIds: await classesTaughtBy(a.id) } : { kind: "none" };
  }
  return { kind: "none" };
}
function inAssignmentScope(s: AssignmentScope, row: Record<string, unknown>): boolean {
  if (s.kind === "all") return true;
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
  const now = new Date().toISOString();
  const map = new Map<string, Set<string>>();
  for (const a of assignments) {
    const from = String(a.starts_at ?? a.published_at ?? a.created_at ?? now).slice(0, 10);
    const to = String(a.due_at ?? now).slice(0, 10);
    const set = new Set<string>();
    for (const e of enr) {
      if (e.class_id !== a.class_id) continue;
      if (e.enrollment_date && String(e.enrollment_date) > to) continue;
      if (e.exit_date && String(e.exit_date) < from) continue;
      set.add(e.learner_id);
    }
    map.set(a.id, set);
  }
  return map;
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

/** The learner's open (in-progress) submission, or why they can't work on it. */
async function openSubmission(me: Record<string, any>, a: Record<string, any>) {
  const { data: s } = await admin.from("assignment_submissions").select("*").eq("assignment_id", a.id).eq("learner_id", me.id).maybeSingle();
  if (!s) return { error: "Start the assignment first", status: 409 as const };
  if (s.status !== "in_progress") return { error: "You've already handed this in", status: 409 as const };
  const why = cannotWork(me, a);
  if (why) return { error: why, status: 409 as const };
  return { s };
}

app.put("/learner/assignments/:id/answers", requirePermission("assignments.submit"), async (c) => {
  const me = await learnerSelf(c);
  const a = me ? await learnerAssignment(me, c.req.param("id")) : null;
  if (!me || !a) return c.json({ error: "Assignment not found" }, 404);
  const open = await openSubmission(me, a);
  if ("error" in open) return c.json({ error: open.error }, open.status);
  const b = await c.req.json().catch(() => ({}));
  const err = await saveAnswers(me, a, open.s, b.answers);
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
  const open = await openSubmission(me, a);
  if ("error" in open) return c.json({ error: open.error }, open.status);
  const b = await c.req.json().catch(() => ({}));
  const err = await saveAnswers(me, a, open.s, b.answers);
  if (err) return c.json({ error: err }, 400);
  const questions = await questionsOf(a.id);
  const { data: answers } = await admin.from("submission_answers").select("*").eq("submission_id", open.s.id);
  const now = new Date();
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
    status: "submitted", submitted_at: at, last_saved_at: at, is_late: isLate(a.due_at, now), max_marks: round2(max),
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
  await audit(c, "submission.submitted", "submission", open.s.id, { assignmentId: a.id, late: patch.is_late, autoMarked: allAuto });
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
  const all = can(p.role, "field_reports.view.all");
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
  return c.json({ reports: (data ?? []).map(mapReport) });
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
  if (!school || !b.visitType) {
    return c.json({ error: "County, school and visit type are all required" }, 400);
  }

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
    selectAll(() => admin.from("profiles").select("id, role, county, school, teacher_type").order("id")),
    selectAll(() => admin.from("learners").select("id, teacher_id, grade, school, created_at").eq("enrollment_status", "ACTIVE").order("id")),
    loadWork({}).then((w) => ({ data: w, error: null }), (e) => ({ data: null, error: { message: (e as Error).message } })),
    selectAll(() => admin.from("field_reports").select("county, visit_type, school, created_at").order("id")),
    selectAll(() => admin.from("forms").select("id, audience").order("id")),
    selectAll(() => admin.from("responses").select("form_id").order("id")),
    selectAll(() => admin.from("library_items").select("audience, subject").order("id")),
    selectAll(() => admin.from("schools").select("id, name, county, code, seq").order("seq").order("id")),
    loadCounties().catch(() => [] as County[]),
  ]);
  // A failed read must not render as zeros on the dashboard.
  const statsErr = [profs, learnersRaw, asg, reportsRaw, forms, responses, library, schoolsReg]
    .find((r) => r.error)?.error;
  if (statsErr) return c.json({ error: statsErr.message }, 500);

  const allProfiles = profs.data ?? [];
  const allLearners = learnersRaw.data ?? [];
  const allReports = reportsRaw.data ?? [];

  // The filter dropdowns list the education team's live counties and
  // schools — the same list every other picker in the portal uses — not
  // whatever text happens to be in people's profiles.
  const counties = countiesReg.map((co) => co.name);
  const countyOrder = new Map(counties.map((n, i) => [n, i]));
  const schoolOptions = (schoolsReg.data ?? [])
    .filter((s) => !inCounty || s.county === county)
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
  createdAt: r.created_at,
  status: r.status ?? "active",
  statusReason: r.status_reason ?? null,
  statusChangedAt: r.status_changed_at ?? null,
  requestedRole: r.requested_role ?? null,
  approvedAt: r.approved_at ?? null,
  invitedBy: r.invited_by ?? null,
});

/** Loads the account named in :id and checks the caller has authority
    over it. Returns the row, or the response refusing the request. */
// deno-lint-ignore no-explicit-any
async function loadManagedAccount(c: any): Promise<Record<string, any> | Response> {
  const { data: target } = await admin.from("profiles").select("*").eq("id", c.req.param("id")).maybeSingle();
  if (!target) return c.json({ error: "User not found" }, 404);
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
  const { data, error } = await selectAll(() => admin
    .from("profiles")
    .select("*")
    .order("created_at", { ascending: false })
    .order("id"));
  if (error) return c.json({ error: error.message }, 500);
  return c.json({
    users: (data ?? []).map((r) => ({ ...mapUserRow(r), canManage: canManageAccount(actor, r as { id: string; role: string }) })),
    grantableRoles: grantableRoles(actor.role).map((r) => ({ value: r, label: ROLE_LABEL[r] })),
    statuses: ACCOUNT_STATUSES,
  });
});

/* ---- invitations ---- */

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
  return c.json({ invitations: (data ?? []).map(mapInvitation) });
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
  // The token is returned once, here, to build the link — it is never stored.
  return c.json({ invitation: mapInvitation(data), token });
});

app.delete("/users/invitations/:id", requirePermission("users.invite"), async (c) => {
  const actor = c.get("actor");
  const { data: inv } = await admin.from("staff_invitations").select("*").eq("id", c.req.param("id")).maybeSingle();
  if (!inv) return c.json({ error: "Invitation not found" }, 404);
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

  const wantsDetails = b.fullName !== undefined || b.email !== undefined || b.teacherType !== undefined;
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
  const detailFields = ["full_name", "teacher_type"].filter((k) => k in patch && patch[k] !== existing[k]);
  if (detailFields.length) await audit(c, "account.updated", "profile", id, { fields: detailFields });

  return c.json({ user: mapUserRow(data!) });
});

app.post("/users/:id/reset-password", requirePermission("users.password.reset"), async (c) => {
  const target = await loadManagedAccount(c);
  if (target instanceof Response) return target;
  const b = await c.req.json().catch(() => ({}));
  const password = String(b.password ?? "");
  if (password.length < 8) {
    return c.json({ error: "Password must be at least 8 characters" }, 400);
  }
  const { error } = await admin.auth.admin.updateUserById(target.id, { password });
  if (error) return c.json({ error: error.message || "Could not set the new password" }, 400);
  await audit(c, "password.reset", "profile", target.id, { by: "administrator" }); // never the password
  return c.json({ ok: true });
});

/* ---- audit history ---- */

app.get("/audit", requirePermission("audit.view"), async (c) => {
  const limit = Math.max(1, Math.min(200, Number(c.req.query("limit")) || 100));
  const before = Number(c.req.query("before")) || 0;
  const targetId = String(c.req.query("targetId") ?? "").trim();
  const action = String(c.req.query("action") ?? "").trim();
  let q = admin.from("audit_log").select("*").order("id", { ascending: false }).limit(limit);
  if (before) q = q.lt("id", before);
  if (targetId) q = q.eq("target_id", targetId);
  if (action) q = q.eq("action", action);
  const { data, error } = await q;
  if (error) return c.json({ error: error.message }, 500);
  const rows = data ?? [];
  // Names for the people involved, looked up once.
  const ids = [...new Set(rows.flatMap((r) => [r.actor_id, r.target_type === "profile" ? r.target_id : null]).filter(Boolean))];
  const names: Record<string, string> = {};
  if (ids.length) {
    const { data: people } = await admin.from("profiles").select("id, full_name, email").in("id", ids);
    for (const p of people ?? []) names[p.id] = p.full_name || p.email;
  }
  return c.json({
    entries: rows.map((r) => ({
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
    })),
    nextBefore: rows.length === limit ? rows[rows.length - 1].id : null,
  });
});

// ---- KoboToolbox: education-team config + attached surveys ----

// Whether Kobo is connected, and how — never the token. Results viewers need it too.
app.get("/kobo/config", requirePermission("kobo.manage", "kobo.results.view"), async (c) => {
  const cfg = await loadKoboConfig();
  return c.json({
    configured: !!cfg,
    baseUrl: cfg?.base_url ?? "https://eu.kobotoolbox.org",
    officerField: cfg?.officer_field ?? "officer_ref",
  });
});

app.put("/kobo/config", requirePermission("kobo.manage"), async (c) => {
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
  return c.json({
    forms: (data ?? []).map((f) => ({
      id: f.id,
      assetUid: f.asset_uid,
      title: f.title,
      active: f.active,
      submissionCount: f.submission_count,
      officerSubmissions: counts[f.id] ?? 0,
      syncedAt: f.synced_at,
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

app.post("/kobo/sync", requirePermission("kobo.manage"), async (c) => {
  const cfg = await loadKoboConfig();
  if (!cfg) return c.json({ error: "Connect KoboToolbox first" }, 400);
  const { data: forms } = await admin.from("kobo_forms").select("*").eq("active", true);
  const { data: profs } = await selectAll(() => admin.from("profiles").select("id").order("id"));
  const validIds = new Set((profs ?? []).map((p) => p.id));

  let matched = 0;
  const failed: string[] = [];
  for (const f of forms ?? []) {
    let rows: Record<string, unknown>[];
    try {
      rows = await koboAllSubmissions(cfg, f.asset_uid as string);
    } catch {
      failed.push(f.title as string);
      continue;
    }
    const upserts: Record<string, unknown>[] = [];
    for (const r of rows) {
      if (koboRejected(r)) continue;
      const ref = pickOfficerRef(r, cfg.officer_field);
      if (ref && validIds.has(ref)) {
        upserts.push({
          kobo_form_id: f.id,
          officer_id: ref,
          kobo_submission_id: String(r._id ?? ""),
          source: "sync",
          submitted_at: r._submission_time ?? new Date().toISOString(),
        });
      }
    }
    if (upserts.length) {
      await admin.from("kobo_submissions").upsert(upserts, {
        onConflict: "kobo_form_id,officer_id",
        ignoreDuplicates: true,
      });
      matched += upserts.length;
    }
    await admin.from("kobo_forms").update({
      submission_count: rows.length,
      synced_at: new Date().toISOString(),
    }).eq("id", f.id);
    koboResultsCache.delete(f.id as string);
  }
  return c.json({ ok: true, matched, failed });
});

// ---- KoboToolbox: aggregated survey results (charts) ----

/* The results panel refreshes every couple of minutes per open dashboard.
   A short per-instance cache stops each refresh re-downloading every
   submission from Kobo; the Refresh button asks for ?fresh=1. */
const KOBO_RESULTS_TTL_MS = 60_000;
const koboResultsCache = new Map<string, { at: number; body: Record<string, unknown> }>();

app.get("/kobo/forms/:id/results", requirePermission("kobo.manage", "kobo.results.view"), async (c) => {
  const cfg = await loadKoboConfig();
  if (!cfg) return c.json({ error: "Connect KoboToolbox first" }, 400);
  const { data: form } = await admin
    .from("kobo_forms").select("*").eq("id", c.req.param("id")).maybeSingle();
  if (!form) return c.json({ error: "Survey not found" }, 404);

  const cached = koboResultsCache.get(form.id);
  if (cached && !c.req.query("fresh") && Date.now() - cached.at < KOBO_RESULTS_TTL_MS) {
    return c.json(cached.body);
  }

  let asset: any, allRows: Record<string, unknown>[];
  try {
    asset = await koboJson(cfg, `/api/v2/assets/${encodeURIComponent(form.asset_uid)}/?format=json`);
    allRows = await koboAllSubmissions(cfg, form.asset_uid);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }

  // Submissions a reviewer rejected in Kobo don't count; say how many.
  const rows = allRows.filter((r) => !koboRejected(r));
  const excludedNotApproved = allRows.length - rows.length;
  const content = asset.content ?? {};
  const surveyDef: any[] = content.survey ?? [];

  // choice-list name -> [{ name, label }]
  const lists: Record<string, { name: string; label: string }[]> = {};
  for (const ch of content.choices ?? []) {
    const list = ch.list_name;
    if (!list) continue;
    (lists[list] ||= []).push({ name: String(ch.name), label: koboLabel(ch.label, String(ch.name)) });
  }

  const questions: any[] = [];

  // Synthetic: submissions per field officer (from the prefilled officer_ref).
  if (rows.length) {
    const perOfficer: Record<string, number> = {};
    for (const r of rows) {
      const ref = pickOfficerRef(r, cfg.officer_field);
      const key = ref || " unlinked";
      perOfficer[key] = (perOfficer[key] ?? 0) + 1;
    }
    const ids = Object.keys(perOfficer).filter((k) => k !== " unlinked");
    let names: Record<string, string> = {};
    if (ids.length) {
      const { data: profs } = await admin.from("profiles").select("id, full_name").in("id", ids);
      names = Object.fromEntries((profs ?? []).map((p) => [p.id, p.full_name || "Unnamed officer"]));
    }
    questions.push({
      name: "_officer", label: "Submissions by field officer", type: "meta", chart: "bar",
      answered: rows.length,
      data: Object.entries(perOfficer)
        .map(([k, v]) => ({ label: k === " unlinked" ? "(unlinked)" : (names[k] || "Unknown officer"), value: v }))
        .sort((a, b) => b.value - a.value),
    });
  }

  for (const q of surveyDef) {
    let type = String(q.type ?? "");
    if (!type || KOBO_SKIP_TYPES.has(type)) continue;
    let listName: string | undefined = q.select_from_list_name;
    if (type.startsWith("select_one ")) { listName = type.slice(11); type = "select_one"; }
    else if (type.startsWith("select_multiple ")) { listName = type.slice(16); type = "select_multiple"; }

    const name = String(q.name ?? q.$autoname ?? "");
    if (!name || name === cfg.officer_field) continue;
    const label = koboLabel(q.label, name);
    // Repeat-group questions contribute one answer per repeat.
    const raw = rows.flatMap((r) => rowValues(r, name));
    const answered = raw.filter((v) => v !== undefined && v !== null && String(v).trim() !== "");

    if (type === "select_one" || type === "select_multiple") {
      const opts = lists[listName ?? ""] ?? [];
      const counts: Record<string, number> = {};
      for (const o of opts) counts[o.name] = 0;
      let other = 0;
      for (const v of answered) {
        const toks = type === "select_multiple" ? String(v).split(/\s+/).filter(Boolean) : [String(v)];
        for (const t of toks) {
          if (t in counts) counts[t]++;
          else other++;
        }
      }
      const data = opts.map((o) => ({ label: o.label, value: counts[o.name] }));
      if (other) data.push({ label: "Other", value: other });
      questions.push({
        name, label, type, answered: answered.length,
        chart: type === "select_one" && opts.length > 0 && opts.length <= 6 ? "donut" : "bar",
        data,
      });
    } else if (type === "integer" || type === "decimal" || type === "range") {
      const nums = answered.map(Number).filter((n) => Number.isFinite(n));
      let data: unknown = null;
      if (nums.length) {
        let min = Infinity, max = -Infinity, sum = 0;
        for (const n of nums) { if (n < min) min = n; if (n > max) max = n; sum += n; }
        const buckets = Math.min(8, Math.max(1, new Set(nums).size));
        const step = (max - min) / buckets || 1;
        const hist = Array.from({ length: buckets }, (_, i) => ({
          label: step >= 1
            ? `${Math.round(min + i * step)}–${Math.round(min + (i + 1) * step)}`
            : `${(min + i * step).toFixed(1)}`,
          value: 0,
        }));
        for (const n of nums) {
          let idx = Math.floor((n - min) / step);
          if (idx < 0) idx = 0;
          if (idx >= buckets) idx = buckets - 1;
          hist[idx].value++;
        }
        data = {
          count: nums.length,
          mean: Math.round((sum / nums.length) * 100) / 100,
          min, max, histogram: hist,
        };
      }
      questions.push({ name, label, type, answered: answered.length, chart: "number", data });
    } else {
      // text / date / time / datetime / geopoint / etc. -> recent answers
      const withTime = rows
        .flatMap((r) => rowValues(r, name).map((v) => ({ v, t: String(r._submission_time ?? "") })))
        .filter((x) => x.v !== undefined && x.v !== null && String(x.v).trim() !== "");
      withTime.sort((a, b) => b.t.localeCompare(a.t));
      questions.push({
        name, label, type, answered: withTime.length, chart: "list",
        data: withTime.slice(0, 50).map((x) => String(x.v)),
      });
    }
  }

  const times = rows.map((r) => String(r._submission_time ?? "")).filter(Boolean).sort();
  const body = {
    id: form.id,
    title: form.title,
    submissionCount: rows.length,
    excludedNotApproved,
    lastSubmission: times.length ? times[times.length - 1] : null,
    questions,
  };
  koboResultsCache.set(form.id, { at: Date.now(), body });
  return c.json(body);
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
