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
  STAFF_ROLES, STATUS_TRANSITIONS,
} from "./permissions.ts";

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
});
const LEARNER_ROSTER_COLS = "id, username, full_name, grade, school, county, user_code, created_at, locked_until";
const mapRosterLearner = (r: Record<string, unknown>) => ({
  id: r.id,
  username: r.username,
  fullName: r.full_name,
  grade: r.grade,
  school: r.school,
  county: r.county,
  userCode: r.user_code ?? null,
  createdAt: r.created_at,
  locked: !!(r.locked_until && new Date(r.locked_until as string) > new Date()),
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
const mapAssignment = (r: Record<string, unknown>) => ({
  id: r.id,
  title: r.title,
  subject: r.subject,
  due: r.due,
  done: !!r.done,
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
    if (!l) return c.json({ error: "Invalid session" }, 401);
    return c.json({ profile: mapLearnerSelf(l) });
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

/** Every learner of this teacher that isn't already in `school` joins it
    (with a code under it). */
async function moveTeachersLearners(teacherId: string, school: School) {
  const { data } = await admin.from("learners").select("id, school_id").eq("teacher_id", teacherId);
  for (const l of data ?? []) {
    if (l.school_id !== school.id) await placeInSchool("learners", l.id as string, school, "learner");
  }
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
      selectAll(() => admin.from("learners").select("school_id").not("school_id", "is", null).order("id")),
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

// ---- teacher's learner roster ----

app.get("/learners", requirePermission("learners.manage"), async (c) => {
  const { data, error } = await admin
    .from("learners")
    .select(LEARNER_ROSTER_COLS)
    .eq("teacher_id", c.get("actor").id)
    .order("full_name");
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ learners: (data ?? []).map(mapRosterLearner) });
});

app.post("/learners", requirePermission("learners.manage"), async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const username = String(b.username ?? "").trim().toLowerCase();
  const pin = String(b.pin ?? "").trim();
  const fullName = String(b.fullName ?? "").trim();
  if (!fullName) return c.json({ error: "Full name is required" }, 400);
  if (!USERNAME_RE.test(username)) {
    return c.json({ error: "Username: 3–32 chars, lowercase letters, digits, . _ -" }, 400);
  }
  if (!PIN_RE.test(pin)) return c.json({ error: "PIN must be exactly 4 digits" }, 400);

  const teacher = c.get("actor");
  // Always the teacher's own school — placed there automatically, never a
  // field a client could set to another school.
  const school = await loadSchool(teacher.schoolId);
  if (!school) return c.json({ error: "Choose your school first — reload the page to pick it" }, 409);

  const { data: taken } = await admin
    .from("learners").select("id").eq("username", username).maybeSingle();
  if (taken) return c.json({ error: "That username is taken" }, 409);

  const salt = randomBytes(16).toString("hex");
  const { data, error } = await admin
    .from("learners")
    .insert({
      teacher_id: teacher.id,
      username,
      pin_hash: hashPin(pin, salt),
      pin_salt: salt,
      full_name: fullName,
      grade: String(b.grade ?? "").trim(),
      school: school.name,
      county: school.county,
    })
    .select("id")
    .single();
  if (error) return c.json({ error: error.message }, 400);
  await audit(c, "learner.created", "learner", data.id,
    { username, fullName, grade: String(b.grade ?? "").trim(), schoolId: school.id, teacherId: teacher.id });
  try {
    return c.json({ learner: mapRosterLearner(await placeInSchool("learners", data.id, school, "learner")) });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

app.patch("/learners/:id", requirePermission("learners.manage"), async (c) => {
  const id = c.req.param("id");
  const { data: existing } = await admin
    .from("learners").select("id, teacher_id").eq("id", id).maybeSingle();
  if (!existing || existing.teacher_id !== c.get("actor").id) {
    return c.json({ error: "Learner not found" }, 404);
  }
  const b = await c.req.json().catch(() => ({}));
  const patch: Record<string, unknown> = {};

  if (b.fullName !== undefined) {
    const fn = String(b.fullName).trim();
    if (!fn) return c.json({ error: "Full name is required" }, 400);
    patch.full_name = fn;
  }
  if (b.grade !== undefined) patch.grade = String(b.grade).trim();
  // school/county are not editable here — a learner is always placed in
  // their teacher's own school/county, set once at creation.
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
  if (!Object.keys(patch).length) return c.json({ error: "Nothing to update" }, 400);

  const { data, error } = await admin
    .from("learners")
    .update(patch)
    .eq("id", id)
    .select(LEARNER_ROSTER_COLS)
    .single();
  if (error) return c.json({ error: error.message }, 400);
  // Never the PIN itself — only which fields changed.
  const changed = Object.keys(patch).filter((k) => !["pin_hash", "pin_salt", "failed_attempts", "locked_until"].includes(k));
  if (patch.pin_hash) await audit(c, "learner.pin_reset", "learner", id, {});
  else if (b.unlock) await audit(c, "learner.unlocked", "learner", id, {});
  if (changed.length) await audit(c, "learner.updated", "learner", id, { fields: changed });
  return c.json({ learner: mapRosterLearner(data) });
});

app.delete("/learners/:id", requirePermission("learners.manage"), async (c) => {
  const id = c.req.param("id");
  const { data: existing } = await admin
    .from("learners").select("id, teacher_id, username, full_name, school_id, user_code").eq("id", id).maybeSingle();
  if (!existing || existing.teacher_id !== c.get("actor").id) {
    return c.json({ error: "Learner not found" }, 404);
  }
  const { error } = await admin.from("learners").delete().eq("id", id);
  if (error) return c.json({ error: error.message }, 400);
  await audit(c, "learner.deleted", "learner", id, {
    username: existing.username, fullName: existing.full_name,
    schoolId: existing.school_id, userCode: existing.user_code,
  });
  return c.json({ ok: true });
});

/* A teacher's read-only look at one of their own learners' real activity —
   the same assignments-done and library-usage/badges data the learner
   sees on their own dashboard, so a teacher can check in on a learner
   remotely without needing the learner's device or PIN. Never exposes
   the PIN itself; "Reset PIN" (PATCH above) is the only way a teacher
   acts on a learner's account, and this route changes nothing. */
app.get("/learners/:id/activity", requirePermission("learners.manage"), async (c) => {
  const id = c.req.param("id");
  const { data: learner } = await admin
    .from("learners")
    .select("id, full_name, username, grade, school, county, teacher_id")
    .eq("id", id)
    .maybeSingle();
  if (!learner || learner.teacher_id !== c.get("actor").id) {
    return c.json({ error: "Learner not found" }, 404);
  }
  try {
    const [{ data: assignments, error: aErr }, library] = await Promise.all([
      admin.from("assignments").select("*").eq("learner_id", id).order("id"),
      loadLibraryUsage(id),
    ]);
    if (aErr) throw new Error(aErr.message);
    return c.json({
      learner: {
        id: learner.id, fullName: learner.full_name, username: learner.username,
        grade: learner.grade, school: learner.school, county: learner.county,
      },
      assignments: (assignments ?? []).map(mapAssignment),
      library,
    });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
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

// ---- assignments (learner-facing) ----

app.get("/assignments", requirePermission("assignments.view.own", "assignments.view.all"), async (c) => {
  const a = c.get("actor");
  const all = can(a.role, "assignments.view.all");
  const { data, error } = await selectAll(() => {
    let q = admin.from("assignments").select("*").order("id");
    if (!all) q = q.eq("learner_id", a.id);
    return q;
  });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ assignments: (data ?? []).map(mapAssignment) });
});

/* Every assignment across a teacher's own roster, in one query — backs
   the teacher dashboard's grading queue / recent results, which need to
   scan all learners at once rather than one at a time (the per-learner
   "view activity" panel already covers that case via /learners/:id/activity). */
app.get("/teacher/assignments", requirePermission("assignments.manage.learners"), async (c) => {
  const teacherId = c.get("actor").id;
  const { data, error } = await selectAll(() => admin
    .from("assignments")
    .select("id, title, subject, due, done, learner_id, learners!inner(full_name, teacher_id)")
    .eq("learners.teacher_id", teacherId)
    .order("due")
    .order("id"));
  if (error) return c.json({ error: error.message }, 500);
  const assignments = (data ?? []).map((r: Record<string, unknown>) => ({
    ...mapAssignment(r),
    learnerId: r.learner_id,
    learnerName: (r.learners as Record<string, unknown> | null)?.full_name ?? "",
  }));
  return c.json({ assignments });
});

/* A learner marks their own assignment done — or their teacher does it
   for them, from the "view a learner's activity" panel (helping remotely
   when a learner reports something's finished but couldn't do it
   themselves). Either way the write is scoped: a learner only ever
   touches their own row; a teacher only ever touches a row belonging to
   one of their own learners, checked here rather than assumed. */
app.patch("/assignments/:id", requirePermission("assignments.view.own", "assignments.manage.learners"), async (c) => {
  const a = c.get("actor");
  const b = await c.req.json().catch(() => ({}));
  const id = c.req.param("id");

  const asTeacher = can(a.role, "assignments.manage.learners");
  if (asTeacher) {
    const { data: assignment } = await admin.from("assignments").select("learner_id").eq("id", id).maybeSingle();
    if (!assignment) return c.json({ error: "Assignment not found" }, 404);
    const { data: learner } = await admin.from("learners").select("teacher_id").eq("id", assignment.learner_id).maybeSingle();
    if (!learner || learner.teacher_id !== a.id) return c.json({ error: "Assignment not found" }, 404);
  }

  let query = admin.from("assignments").update({ done: b.done !== false }).eq("id", id);
  if (!asTeacher) query = query.eq("learner_id", a.id);
  const { data, error } = await query.select().maybeSingle();
  if (error) return c.json({ error: error.message }, 400);
  if (!data) return c.json({ error: "Assignment not found" }, 404);
  return c.json({ assignment: mapAssignment(data) });
});

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
    selectAll(() => admin.from("learners").select("id, teacher_id, grade, school, created_at").order("id")),
    selectAll(() => admin.from("assignments").select("learner_id, done").order("id")),
    selectAll(() => admin.from("field_reports").select("county, visit_type, school, created_at").order("id")),
    selectAll(() => admin.from("forms").select("id, audience").order("id")),
    selectAll(() => admin.from("responses").select("form_id").order("id")),
    selectAll(() => admin.from("library_items").select("audience, subject").order("id")),
    selectAll(() => admin.from("schools").select("name, county, code, seq").order("seq").order("id")),
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

  const learnerIdSet = new Set(learnerRows.map((l) => l.id));
  const assignmentRows = (inCounty || inSchool)
    ? (asg.data ?? []).filter((a) => learnerIdSet.has(a.learner_id))
    : (asg.data ?? []);

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

  // Grade "performance" — the one real, comparable-across-grades signal the
  // portal actually records is assignment completion. Ranked, capped to the
  // requested top N (0 = show every grade). Not an academic score: there is
  // no gradebook/exam-results feature yet (see reply to Patrick).
  const gradeOfLearner: Record<string, string> = {};
  for (const l of learnerRows) gradeOfLearner[l.id as string] = (l.grade as string)?.trim() || "(not set)";
  const gradeAgg: Record<string, { total: number; done: number }> = {};
  for (const a of assignmentRows) {
    const g = gradeOfLearner[a.learner_id as string] ?? "(not set)";
    (gradeAgg[g] ??= { total: 0, done: 0 }).total++;
    if (a.done) gradeAgg[g].done++;
  }
  let gradePerformance = Object.entries(gradeAgg)
    .map(([label, v]) => ({ label, value: v.total ? Math.round((v.done / v.total) * 100) : 0, total: v.total }))
    .sort((a, b) => b.value - a.value || b.total - a.total);
  if (topN) gradePerformance = gradePerformance.slice(0, topN);

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
    assignmentsTotal: assignmentRows.length,
    assignmentsDone: assignmentRows.filter((a) => a.done).length,
    reportsFiled: reportRows.length,
    formsSent: formRows.length,
    responsesReceived: (responses.data ?? []).length,
    // Impact breakdowns for the Overview charts — county/school-scoped
    // when picked, portal-wide otherwise.
    learnersByGrade: tally(learnerRows, "grade"),
    learnersBySchool: tally(learnerRows, "school"),
    newLearnersByTerm: tallyChronological(learnerRows, (l) => schoolTermOf(l.created_at)),
    gradePerformance,
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
    selectAll(() => admin.from("learners").select("id, grade").eq("school_id", schoolRec.id).order("id")),
    selectAll(() => admin.from("field_reports").select("*").eq("school_id", schoolRec.id).order("id")),
    selectAll(() => admin.from("field_reports").select("*").is("school_id", null).eq("school", school).eq("county", county).order("id")),
    // Joined on the learner's school rather than an id list, which would
    // overflow the request URL for a large school.
    selectAll(() => admin.from("assignments").select("learner_id, done, learners!inner(school_id)")
      .eq("learners.school_id", schoolRec.id).order("id")),
  ]);
  if (profs.error || learnersRaw.error || reportsById.error || reportsByName.error || asg.error) {
    return c.json({ error: "Could not load the school overview" }, 500);
  }

  const teacherRows = profs.data ?? [];
  const learnerRows = learnersRaw.data ?? [];
  const visitRows = [...(reportsById.data ?? []), ...(reportsByName.data ?? [])]
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

  const assignmentRows = asg.data ?? [];

  const gradeOfLearner: Record<string, string> = {};
  for (const l of learnerRows) gradeOfLearner[l.id as string] = (l.grade as string)?.trim() || "(not set)";
  const gradeAgg: Record<string, { learners: number; total: number; done: number }> = {};
  for (const l of learnerRows) {
    const g = gradeOfLearner[l.id as string];
    (gradeAgg[g] ??= { learners: 0, total: 0, done: 0 }).learners++;
  }
  for (const a of assignmentRows) {
    const g = gradeOfLearner[a.learner_id as string] ?? "(not set)";
    (gradeAgg[g] ??= { learners: 0, total: 0, done: 0 }).total++;
    if (a.done) gradeAgg[g].done++;
  }
  const gradeBreakdown = Object.entries(gradeAgg)
    .map(([grade, v]) => ({ grade, learners: v.learners, assignmentsTotal: v.total, assignmentsDone: v.done }))
    .sort((a, b) => a.grade.localeCompare(b.grade));

  const currentTerm = schoolTermOf(new Date().toISOString());
  const visitedThisTerm = visitRows.some((r) => schoolTermOf(r.created_at) === currentTerm);

  return c.json({
    school, county,
    schoolCode: schoolRec.code,
    teacherCount: teacherRows.length,
    learnerCount: learnerRows.length,
    teachersByType: tally(teacherRows, "teacher_type"),
    assignmentsTotal: assignmentRows.length,
    assignmentsDone: assignmentRows.filter((a) => a.done).length,
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
      // A teacher's learners go wherever the teacher goes, so a class
      // never ends up split across two schools.
      if (nextRole === "teacher") await moveTeachersLearners(id, placeIn);
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
