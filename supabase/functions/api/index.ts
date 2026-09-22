/**
 * HPF Digital Learning Portal — backend API.
 *
 * The static frontend never touches Postgres or Storage directly. Every
 * read and write goes through this one Edge Function, which:
 *   - authenticates the caller (staff: Supabase Auth JWT; learners: an
 *     opaque PIN-issued session token, "hpl_<token>"),
 *   - loads their role from `public.profiles` / `public.learners` (never
 *     from a JWT claim),
 *   - does all data access with the service-role key, which bypasses the
 *     deny-all RLS on every table.
 *
 * Deployed with verify_jwt = false: auth is enforced here, per route.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SECRET_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/** Service-role client — bypasses RLS. Never expose this key to a browser. */
const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const STAFF_ROLES = [
  "teacher",
  "school_leader",
  "field_officer",
  "education_team",
] as const;
const ALL_ROLES = [...STAFF_ROLES, "learner"] as const;
type Role = (typeof ALL_ROLES)[number];

const LIBRARY_BUCKET = "library";
const DOWNLOAD_TTL = 60 * 60; // 1 h signed download URLs
const LEARNER_SESSION_TTL_DAYS = 30;
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

/** Read a question's value off a submission row (bare or group-prefixed name). */
function rowValue(row: Record<string, unknown>, name: string): unknown {
  if (row[name] !== undefined) return row[name];
  const k = Object.keys(row).find((kk) => kk === name || kk.endsWith("/" + name));
  return k ? row[k] : undefined;
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
function canSeeLibrary(audience: string | null | undefined, role: Role): boolean {
  if (role === "education_team") return true;
  const dest = normalizeAudience(audience);
  if (dest === "school_leader") return role === "school_leader";
  if (dest === "staff") return role === "teacher" || role === "school_leader";
  return role === "teacher" || role === "school_leader" || role === "learner";
}

type LibFile = { name: string; path: string; size: number };

/* Signed URLs with no `download` option: the object is served with its
   real content-type and no attachment disposition, so a browser opens
   a PDF/image/text/video right in the tab instead of saving it to disk.
   (`download: true` — used until now — forces "Content-Disposition:
   attachment", which is exactly what made every open a download.) The
   field is still called downloadUrl for the frontend, but it's a "view
   this in the portal" link now. */
async function signFiles(files: LibFile[]) {
  return await Promise.all(
    (files ?? []).map(async (f) => {
      const { data } = await admin.storage
        .from(LIBRARY_BUCKET)
        .createSignedUrl(f.path, DOWNLOAD_TTL);
      return { ...f, downloadUrl: data?.signedUrl ?? null };
    }),
  );
}

const mapLibrary = async (r: Record<string, unknown>) => ({
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
  files: await signFiles((r.files as LibFile[]) ?? []),
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
  grade: r.grade,
  teacherType: r.teacher_type ?? null,
});
const mapLearnerSelf = (r: Record<string, unknown>) => ({
  id: r.id,
  role: "learner" as const,
  fullName: r.full_name,
  username: r.username,
  grade: r.grade,
  school: r.school,
});
const mapRosterLearner = (r: Record<string, unknown>) => ({
  id: r.id,
  username: r.username,
  fullName: r.full_name,
  grade: r.grade,
  school: r.school,
  county: r.county,
  createdAt: r.created_at,
  locked: !!(r.locked_until && new Date(r.locked_until as string) > new Date()),
});
const mapForm = (r: Record<string, unknown>) => ({
  id: r.id,
  title: r.title,
  description: r.description,
  audience: r.audience,
  createdBy: r.created_by,
  questions: r.questions ?? [],
});
const mapResponse = (r: Record<string, unknown>) => ({
  id: r.id,
  formId: r.form_id,
  respondentId: r.respondent_id,
  respondentName: r.respondent_name,
  respondentRole: r.respondent_role,
  answers: r.answers ?? [],
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

type Actor = { id: string; role: Role; fullName: string; grade: string; school: string; county: string };
type Vars = {
  actorKind: "staff" | "learner";
  userId: string;
  email: string;
  learnerId: string;
  actor: Actor;
};

const app = new Hono<{ Variables: Vars }>().basePath("/api");

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
    expires_at: new Date(
      Date.now() + LEARNER_SESSION_TTL_DAYS * 86400_000,
    ).toISOString(),
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
      .select("learner_id, expires_at")
      .eq("token", raw.slice(4))
      .maybeSingle();
    if (!data || new Date(data.expires_at) < new Date()) {
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

/** Staff-only guard. Learners are refused (403), un-onboarded staff get 428. */
function withProfile(...roles: Role[]) {
  return async (c: any, next: any) => {
    if (c.get("actorKind") === "learner") {
      return c.json({ error: "Not allowed for your role" }, 403);
    }
    const profile = await loadStaffProfile(c.get("userId"));
    if (!profile) {
      return c.json({ needsOnboarding: true, email: c.get("email") }, 428);
    }
    if (roles.length && !roles.includes(profile.role)) {
      return c.json({ error: "Not allowed for your role" }, 403);
    }
    c.set("actor", {
      id: profile.id,
      role: profile.role,
      fullName: profile.full_name,
      grade: profile.grade,
      school: profile.school,
      county: profile.county,
    });
    return next();
  };
}

/** Guard that accepts staff OR learners, resolved into a common actor. */
function withActor(...roles: Role[]) {
  return async (c: any, next: any) => {
    let actor: Actor | null = null;
    if (c.get("actorKind") === "learner") {
      const l = await loadLearner(c.get("learnerId"));
      if (l) actor = { id: l.id, role: "learner", fullName: l.full_name, grade: l.grade, school: l.school };
    } else {
      const p = await loadStaffProfile(c.get("userId"));
      if (!p) return c.json({ needsOnboarding: true, email: c.get("email") }, 428);
      actor = { id: p.id, role: p.role, fullName: p.full_name, grade: p.grade, school: p.school };
    }
    if (!actor) return c.json({ error: "Invalid session" }, 401);
    if (roles.length && !roles.includes(actor.role)) {
      return c.json({ error: "Not allowed for your role" }, 403);
    }
    c.set("actor", actor);
    return next();
  };
}

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

app.post("/me", async (c) => {
  if (c.get("actorKind") === "learner") {
    return c.json({ error: "Learners are added by a teacher" }, 403);
  }
  if (await loadStaffProfile(c.get("userId"))) {
    return c.json({ error: "Profile already exists" }, 409);
  }
  const b = await c.req.json().catch(() => ({}));
  if (!STAFF_ROLES.includes(b.role)) return c.json({ error: "Pick a role" }, 400);
  if (!String(b.fullName ?? "").trim()) {
    return c.json({ error: "Full name is required" }, 400);
  }
  if (!String(b.school ?? "").trim()) return c.json({ error: "School / institution is required" }, 400);
  if (!String(b.county ?? "").trim()) return c.json({ error: "County is required" }, 400);
  const teacherType = String(b.teacherType ?? "").trim().toUpperCase();
  if (teacherType && !["BOM", "TSC"].includes(teacherType)) {
    return c.json({ error: "Teacher type must be BOM or TSC" }, 400);
  }
  const { data, error } = await admin
    .from("profiles")
    .insert({
      id: c.get("userId"),
      role: b.role,
      full_name: String(b.fullName).trim(),
      email: c.get("email"),
      school: String(b.school ?? "").trim(),
      county: String(b.county ?? "").trim(),
      grade: String(b.grade ?? "").trim(),
      teacher_type: b.role === "teacher" && teacherType ? teacherType : null,
    })
    .select()
    .single();
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ profile: mapProfile(data) });
});

// ---- teacher's learner roster ----

app.get("/learners", withProfile("teacher"), async (c) => {
  const { data, error } = await admin
    .from("learners")
    .select("id, username, full_name, grade, school, county, created_at, locked_until")
    .eq("teacher_id", c.get("actor").id)
    .order("full_name");
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ learners: (data ?? []).map(mapRosterLearner) });
});

app.post("/learners", withProfile("teacher"), async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const username = String(b.username ?? "").trim().toLowerCase();
  const pin = String(b.pin ?? "").trim();
  const fullName = String(b.fullName ?? "").trim();
  if (!fullName) return c.json({ error: "Full name is required" }, 400);
  if (!USERNAME_RE.test(username)) {
    return c.json({ error: "Username: 3–32 chars, lowercase letters, digits, . _ -" }, 400);
  }
  if (!PIN_RE.test(pin)) return c.json({ error: "PIN must be exactly 4 digits" }, 400);

  const { data: taken } = await admin
    .from("learners").select("id").eq("username", username).maybeSingle();
  if (taken) return c.json({ error: "That username is taken" }, 409);

  const salt = randomBytes(16).toString("hex");
  const teacher = c.get("actor");
  // Always the teacher's own school/county — placed there automatically,
  // never a free-text field a client could set to something else.
  const { data, error } = await admin
    .from("learners")
    .insert({
      teacher_id: teacher.id,
      username,
      pin_hash: hashPin(pin, salt),
      pin_salt: salt,
      full_name: fullName,
      grade: String(b.grade ?? "").trim(),
      school: teacher.school || "",
      county: teacher.county || "",
    })
    .select("id, username, full_name, grade, school, county, created_at, locked_until")
    .single();
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ learner: mapRosterLearner(data) });
});

app.patch("/learners/:id", withProfile("teacher"), async (c) => {
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
    .select("id, username, full_name, grade, school, county, created_at, locked_until")
    .single();
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ learner: mapRosterLearner(data) });
});

app.delete("/learners/:id", withProfile("teacher"), async (c) => {
  const id = c.req.param("id");
  const { data: existing } = await admin
    .from("learners").select("id, teacher_id").eq("id", id).maybeSingle();
  if (!existing || existing.teacher_id !== c.get("actor").id) {
    return c.json({ error: "Learner not found" }, 404);
  }
  const { error } = await admin.from("learners").delete().eq("id", id);
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ ok: true });
});

/* A teacher's read-only look at one of their own learners' real activity —
   the same assignments-done and library-usage/badges data the learner
   sees on their own dashboard, so a teacher can check in on a learner
   remotely without needing the learner's device or PIN. Never exposes
   the PIN itself; "Reset PIN" (PATCH above) is the only way a teacher
   acts on a learner's account, and this route changes nothing. */
app.get("/learners/:id/activity", withProfile("teacher"), async (c) => {
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

app.get("/library", withActor(), async (c) => {
  const role = c.get("actor").role;
  const { data, error } = await admin
    .from("library_items")
    .select("*")
    .order("uploaded_at", { ascending: false });
  if (error) return c.json({ error: error.message }, 500);
  // A draft is only visible to the education team — everyone else only
  // ever sees what's actually been published, same as the audience check
  // right next to it.
  const visible = (data ?? []).filter((it) =>
    canSeeLibrary(it.audience as string, role) &&
    (role === "education_team" || it.published),
  );
  const items = await Promise.all(visible.map(mapLibrary));
  return c.json({ items });
});

const URL_RE = /^https?:\/\/[^\s]+$/i;

app.post("/library", withProfile("education_team"), async (c) => {
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
  return c.json({ item: await mapLibrary(data), uploads });
});

/* Publish/unpublish and folder reassignment — the only edits this route
   allows. A freshly uploaded item starts as a draft (see the table
   default); it's real to the education team immediately (their own
   GET /library shows drafts) but invisible to everyone else until
   explicitly published here. Moving to a folder requires the folder's
   audience to match the item's own — same rule as at upload time. */
app.patch("/library/:id", withProfile("education_team"), async (c) => {
  const id = c.req.param("id");
  const b = await c.req.json().catch(() => ({}));
  const patch: Record<string, unknown> = {};
  if (typeof b.published === "boolean") patch.published = b.published;
  if ("folderId" in b) {
    if (b.folderId === null) {
      patch.folder_id = null;
    } else {
      const { data: item } = await admin
        .from("library_items").select("audience").eq("id", id).maybeSingle();
      if (!item) return c.json({ error: "Content not found" }, 404);
      const { data: folder } = await admin
        .from("library_folders").select("id, audience").eq("id", b.folderId).maybeSingle();
      if (!folder) return c.json({ error: "Folder not found" }, 400);
      if (folder.audience !== item.audience) {
        return c.json({ error: "Folder is for a different destination" }, 400);
      }
      patch.folder_id = folder.id;
    }
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
  return c.json({ item: await mapLibrary(data) });
});

/* Organizational folders — a named bucket the education team sorts
   items into (e.g. "Grade 4 Maths"), separate from `isFolder` above
   (an uploaded folder of files becoming one item). Visible to the same
   audience rules as items; deleting a folder never deletes its
   contents (the FK is `on delete set null`, so items just fall back
   to "Unfiled"). */
app.get("/library/folders", withActor(), async (c) => {
  const role = c.get("actor").role;
  const [{ data: folders, error: fErr }, { data: items, error: iErr }] = await Promise.all([
    admin.from("library_folders").select("*").order("name"),
    admin.from("library_items").select("folder_id, audience, published"),
  ]);
  if (fErr) return c.json({ error: fErr.message }, 500);
  if (iErr) return c.json({ error: iErr.message }, 500);
  const counts = new Map<string, number>();
  for (const it of items ?? []) {
    if (!it.folder_id) continue;
    if (!canSeeLibrary(it.audience as string, role)) continue;
    if (role !== "education_team" && !it.published) continue;
    counts.set(it.folder_id as string, (counts.get(it.folder_id as string) ?? 0) + 1);
  }
  const visible = (folders ?? []).filter((f) => canSeeLibrary(f.audience as string, role));
  return c.json({ folders: visible.map((f) => mapFolder(f, counts.get(f.id as string) ?? 0)) });
});

app.post("/library/folders", withProfile("education_team"), async (c) => {
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

app.delete("/library/folders/:id", withProfile("education_team"), async (c) => {
  const id = c.req.param("id");
  const { error } = await admin.from("library_folders").delete().eq("id", id);
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ ok: true });
});

app.delete("/library/:id", withProfile("education_team"), async (c) => {
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

app.post("/library/:id/interactions", withActor(), async (c) => {
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

app.patch("/library/interactions/:id/complete", withActor(), async (c) => {
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
  const [{ data, error }, { data: badgeRows }] = await Promise.all([
    admin
      .from("library_interactions")
      .select("*, library_items(title)")
      .eq("actor_id", actorId)
      .order("started_at", { ascending: false })
      .limit(200),
    admin
      .from("library_badges")
      .select("id, badge, awarded_at, library_items(title)")
      .eq("actor_id", actorId)
      .order("awarded_at", { ascending: false }),
  ]);
  if (error) throw new Error(error.message);
  const rows = data ?? [];
  const completed = rows.filter((r) => r.duration_seconds != null);
  const badges = badgeRows ?? [];
  return {
    totalSeconds: completed.reduce((s, r) => s + (r.duration_seconds as number), 0),
    resourcesOpened: new Set(rows.map((r) => r.library_item_id)).size,
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
app.get("/library/interactions/mine", withActor(), async (c) => {
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
app.post("/library/:id/badge", withActor(), async (c) => {
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
app.get("/library/usage", withProfile("education_team"), async (c) => {
  const school = String(c.req.query("school") ?? "").trim();

  const [itemsRes, interRes] = await Promise.all([
    admin.from("library_items").select("id, title"),
    admin.from("library_interactions").select("*"),
  ]);
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

app.get("/forms", withProfile(), async (c) => {
  const p = c.get("actor");
  let q = admin.from("forms").select("*").order("created_at", { ascending: false });
  if (p.role !== "education_team") q = q.eq("audience", p.role);
  const { data, error } = await q;
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ forms: (data ?? []).map(mapForm) });
});

app.post("/forms", withProfile("education_team"), async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (!String(b.title ?? "").trim()) return c.json({ error: "Title is required" }, 400);
  if (!["teacher", "school_leader", "field_officer"].includes(b.audience)) {
    return c.json({ error: "Pick who the form is for" }, 400);
  }
  const { data, error } = await admin
    .from("forms")
    .insert({
      id: rid("form"),
      title: String(b.title).trim(),
      description: String(b.description ?? "").trim(),
      audience: b.audience,
      created_by: c.get("actor").fullName,
      questions: Array.isArray(b.questions) ? b.questions : [],
    })
    .select()
    .single();
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ form: mapForm(data) });
});

app.get("/responses", withProfile(), async (c) => {
  const p = c.get("actor");
  let q = admin
    .from("responses")
    .select("*")
    .order("submitted_at", { ascending: false });
  if (p.role !== "education_team") q = q.eq("respondent_id", p.id);
  const { data, error } = await q;
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ responses: (data ?? []).map(mapResponse) });
});

app.post("/responses", withProfile(), async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const p = c.get("actor");
  if (!b.formId) return c.json({ error: "Missing form" }, 400);
  const { data, error } = await admin
    .from("responses")
    .upsert(
      {
        id: b.id ?? rid("resp"),
        form_id: b.formId,
        respondent_id: p.id,
        respondent_name: p.fullName,
        respondent_role: p.role,
        answers: Array.isArray(b.answers) ? b.answers : [],
      },
      { onConflict: "form_id,respondent_id" },
    )
    .select()
    .single();
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ response: mapResponse(data) });
});

// ---- assignments (learner-facing) ----

app.get("/assignments", withActor(), async (c) => {
  const a = c.get("actor");
  if (a.role !== "learner" && a.role !== "education_team") {
    return c.json({ assignments: [] });
  }
  let q = admin.from("assignments").select("*").order("id");
  if (a.role === "learner") q = q.eq("learner_id", a.id);
  const { data, error } = await q;
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ assignments: (data ?? []).map(mapAssignment) });
});

/* Every assignment across a teacher's own roster, in one query — backs
   the teacher dashboard's grading queue / recent results, which need to
   scan all learners at once rather than one at a time (the per-learner
   "view activity" panel already covers that case via /learners/:id/activity). */
app.get("/teacher/assignments", withProfile("teacher"), async (c) => {
  const teacherId = c.get("actor").id;
  const { data, error } = await admin
    .from("assignments")
    .select("id, title, subject, due, done, learner_id, learners!inner(full_name, teacher_id)")
    .eq("learners.teacher_id", teacherId)
    .order("due");
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
app.patch("/assignments/:id", withActor("learner", "teacher"), async (c) => {
  const a = c.get("actor");
  const b = await c.req.json().catch(() => ({}));
  const id = c.req.param("id");

  if (a.role === "teacher") {
    const { data: assignment } = await admin.from("assignments").select("learner_id").eq("id", id).maybeSingle();
    if (!assignment) return c.json({ error: "Assignment not found" }, 404);
    const { data: learner } = await admin.from("learners").select("teacher_id").eq("id", assignment.learner_id).maybeSingle();
    if (!learner || learner.teacher_id !== a.id) return c.json({ error: "Assignment not found" }, 404);
  }

  let query = admin.from("assignments").update({ done: b.done !== false }).eq("id", id);
  if (a.role !== "teacher") query = query.eq("learner_id", a.id);
  const { data, error } = await query.select().maybeSingle();
  if (error) return c.json({ error: error.message }, 400);
  if (!data) return c.json({ error: "Assignment not found" }, 404);
  return c.json({ assignment: mapAssignment(data) });
});

// ---- field reports (staff only) ----

app.get("/field-reports", withProfile(), async (c) => {
  const p = c.get("actor");
  if (p.role !== "field_officer" && p.role !== "education_team") {
    return c.json({ reports: [] });
  }
  let q = admin
    .from("field_reports")
    .select("*")
    .order("created_at", { ascending: false });
  if (p.role === "field_officer") q = q.eq("officer_id", p.id);
  const { data, error } = await q;
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ reports: (data ?? []).map(mapReport) });
});

app.post("/field-reports", withProfile("field_officer"), async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (!b.county || !b.school || !b.visitType) {
    return c.json({ error: "County, school and visit type are all required" }, 400);
  }
  const { data, error } = await admin
    .from("field_reports")
    .insert({
      id: rid("fr"),
      officer_id: c.get("actor").id,
      school: b.school,
      county: b.county,
      visit_type: b.visitType,
    })
    .select()
    .single();
  if (error) return c.json({ error: error.message }, 400);
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

app.get("/stats", withProfile("education_team"), async (c) => {
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

  const [profs, learnersRaw, asg, reportsRaw, forms, responses, library] = await Promise.all([
    admin.from("profiles").select("id, role, county, school, teacher_type"),
    admin.from("learners").select("id, teacher_id, grade, school, created_at"),
    admin.from("assignments").select("learner_id, done"),
    admin.from("field_reports").select("county, visit_type, school, created_at"),
    admin.from("forms").select("id, audience"),
    admin.from("responses").select("form_id"),
    admin.from("library_items").select("audience, subject"),
  ]);

  const allProfiles = profs.data ?? [];
  const allLearners = learnersRaw.data ?? [];
  const allReports = reportsRaw.data ?? [];

  // Every county with data anywhere, for the filter dropdown — a staff
  // member's own county, or a county a field visit was logged in.
  const countySet = new Set<string>();
  for (const p of allProfiles) if (p.county) countySet.add(p.county as string);
  for (const r of allReports) if (r.county) countySet.add(r.county as string);
  const counties = [...countySet].sort();

  // A learner has no county (or school, in principle) of their own — they
  // inherit their teacher's, same as they inherit teacher.school at signup.
  const teacherCounty: Record<string, string> = {};
  for (const p of allProfiles) teacherCounty[p.id as string] = (p.county as string) || "";

  let staffRows = inCounty ? allProfiles.filter((p) => (p.county || "") === county) : allProfiles;
  let learnerRows = inCounty
    ? allLearners.filter((l) => teacherCounty[l.teacher_id as string] === county)
    : allLearners;
  let reportRows = inCounty ? allReports.filter((r) => r.county === county) : allReports;

  // Schools available in the current (county-scoped) view, for the school
  // filter dropdown — computed before the school filter itself narrows further.
  const schoolSet = new Set<string>();
  for (const p of staffRows) if (p.school) schoolSet.add(p.school as string);
  for (const l of learnerRows) if (l.school) schoolSet.add(l.school as string);
  for (const r of reportRows) if (r.school) schoolSet.add(r.school as string);
  const schools = [...schoolSet].sort();

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

app.get("/school/overview", withProfile("school_leader"), async (c) => {
  const actor = c.get("actor");
  const school = actor.school || "";
  const county = actor.county || "";

  const [profs, learnersRaw, reportsRaw] = await Promise.all([
    admin.from("profiles").select("id, teacher_type").eq("role", "teacher").eq("school", school).eq("county", county),
    admin.from("learners").select("id, grade").eq("school", school).eq("county", county),
    admin.from("field_reports").select("*").eq("school", school).eq("county", county).order("created_at", { ascending: false }),
  ]);
  if (profs.error || learnersRaw.error || reportsRaw.error) {
    return c.json({ error: "Could not load the school overview" }, 500);
  }

  const teacherRows = profs.data ?? [];
  const learnerRows = learnersRaw.data ?? [];
  const visitRows = reportsRaw.data ?? [];

  const learnerIds = learnerRows.map((l) => l.id as string);
  const asg = learnerIds.length
    ? await admin.from("assignments").select("learner_id, done").in("learner_id", learnerIds)
    : { data: [] as Record<string, unknown>[], error: null as unknown };
  if (asg.error) return c.json({ error: "Could not load the school overview" }, 500);
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

// ---- education-team: manage staff accounts ----
// Passwords are one-way hashed in auth.users — never readable, by anyone,
// including this service-role key. So "editable" here means: edit the
// profile fields, and set a *new* password/PIN — never view the old one.

const mapUserRow = (r: Record<string, unknown>) => ({
  id: r.id,
  role: r.role,
  fullName: r.full_name,
  email: r.email,
  school: r.school,
  county: r.county,
  teacherType: r.teacher_type ?? null,
  createdAt: r.created_at,
});

app.get("/users", withProfile("education_team"), async (c) => {
  const { data, error } = await admin
    .from("profiles")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ users: (data ?? []).map(mapUserRow) });
});

app.patch("/users/:id", withProfile("education_team"), async (c) => {
  const id = c.req.param("id");
  const { data: existing } = await admin
    .from("profiles").select("id, role").eq("id", id).maybeSingle();
  if (!existing) return c.json({ error: "User not found" }, 404);

  const b = await c.req.json().catch(() => ({}));
  const patch: Record<string, unknown> = {};

  if (b.fullName !== undefined) {
    const fn = String(b.fullName).trim();
    if (!fn) return c.json({ error: "Full name is required" }, 400);
    patch.full_name = fn;
  }
  const nextRole = b.role !== undefined ? b.role : existing.role;
  if (b.role !== undefined) {
    if (!STAFF_ROLES.includes(b.role)) return c.json({ error: "Invalid role" }, 400);
    patch.role = b.role;
  }
  if (b.school !== undefined) patch.school = String(b.school).trim();
  if (b.county !== undefined) patch.county = String(b.county).trim();
  if (b.teacherType !== undefined) {
    const tt = String(b.teacherType ?? "").trim().toUpperCase();
    if (tt && !["BOM", "TSC"].includes(tt)) {
      return c.json({ error: "Teacher type must be BOM or TSC" }, 400);
    }
    patch.teacher_type = tt || null;
  }
  if (nextRole !== "teacher") patch.teacher_type = null; // only teachers carry BOM/TSC

  let newEmail: string | null = null;
  if (b.email !== undefined) {
    const email = String(b.email).trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return c.json({ error: "Enter a valid email address" }, 400);
    newEmail = email;
  }

  if (!Object.keys(patch).length && !newEmail) return c.json({ error: "Nothing to update" }, 400);

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

  const { data, error } = await admin
    .from("profiles").update(patch).eq("id", id).select().single();
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ user: mapUserRow(data) });
});

app.post("/users/:id/reset-password", withProfile("education_team"), async (c) => {
  const id = c.req.param("id");
  const { data: existing } = await admin
    .from("profiles").select("id").eq("id", id).maybeSingle();
  if (!existing) return c.json({ error: "User not found" }, 404);
  const b = await c.req.json().catch(() => ({}));
  const password = String(b.password ?? "");
  if (password.length < 8) {
    return c.json({ error: "Password must be at least 8 characters" }, 400);
  }
  const { error } = await admin.auth.admin.updateUserById(id, { password });
  if (error) return c.json({ error: error.message || "Could not set the new password" }, 400);
  return c.json({ ok: true });
});

// ---- KoboToolbox: education-team config + attached surveys ----

app.get("/kobo/config", withProfile("education_team"), async (c) => {
  const cfg = await loadKoboConfig();
  return c.json({
    configured: !!cfg,
    baseUrl: cfg?.base_url ?? "https://eu.kobotoolbox.org",
    officerField: cfg?.officer_field ?? "officer_ref",
  });
});

app.put("/kobo/config", withProfile("education_team"), async (c) => {
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

app.get("/kobo/assets", withProfile("education_team"), async (c) => {
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

app.get("/kobo/forms", withProfile("education_team"), async (c) => {
  const { data } = await admin
    .from("kobo_forms").select("*").order("created_at", { ascending: false });
  const { data: subs } = await admin.from("kobo_submissions").select("kobo_form_id");
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

app.post("/kobo/forms", withProfile("education_team"), async (c) => {
  const cfg = await loadKoboConfig();
  if (!cfg) return c.json({ error: "Connect KoboToolbox first" }, 400);
  const b = await c.req.json().catch(() => ({}));
  const uid = String(b.assetUid ?? "").trim();
  if (!uid) return c.json({ error: "Pick a survey" }, 400);

  const { data: existing } = await admin
    .from("kobo_forms").select("id").eq("asset_uid", uid).maybeSingle();
  if (existing) return c.json({ error: "That survey is already attached" }, 409);

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
app.get("/kobo/assets/:uid/preview", withProfile("education_team"), async (c) => {
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

app.delete("/kobo/forms/:id", withProfile("education_team"), async (c) => {
  const { error } = await admin.from("kobo_forms").delete().eq("id", c.req.param("id"));
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ ok: true });
});

app.post("/kobo/sync", withProfile("education_team"), async (c) => {
  const cfg = await loadKoboConfig();
  if (!cfg) return c.json({ error: "Connect KoboToolbox first" }, 400);
  const { data: forms } = await admin.from("kobo_forms").select("*").eq("active", true);
  const { data: profs } = await admin.from("profiles").select("id");
  const validIds = new Set((profs ?? []).map((p) => p.id));

  let matched = 0;
  for (const f of forms ?? []) {
    let data;
    try {
      data = await koboJson(cfg, `/api/v2/assets/${f.asset_uid}/data/?format=json&limit=30000`);
    } catch {
      continue;
    }
    const rows: any[] = data.results ?? [];
    const upserts: any[] = [];
    for (const r of rows) {
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
      submission_count: data.count ?? rows.length,
      synced_at: new Date().toISOString(),
    }).eq("id", f.id);
  }
  return c.json({ ok: true, matched });
});

// ---- KoboToolbox: aggregated survey results (charts) ----

app.get("/kobo/forms/:id/results", withProfile("education_team"), async (c) => {
  const cfg = await loadKoboConfig();
  if (!cfg) return c.json({ error: "Connect KoboToolbox first" }, 400);
  const { data: form } = await admin
    .from("kobo_forms").select("*").eq("id", c.req.param("id")).maybeSingle();
  if (!form) return c.json({ error: "Survey not found" }, 404);

  let asset: any, sub: any;
  try {
    asset = await koboJson(cfg, `/api/v2/assets/${form.asset_uid}/?format=json`);
    sub = await koboJson(cfg, `/api/v2/assets/${form.asset_uid}/data/?format=json&limit=30000`);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }

  const rows: Record<string, unknown>[] = sub.results ?? [];
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
    const raw = rows.map((r) => rowValue(r, name));
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
        .map((r) => ({ v: rowValue(r, name), t: String(r._submission_time ?? "") }))
        .filter((x) => x.v !== undefined && x.v !== null && String(x.v).trim() !== "");
      withTime.sort((a, b) => b.t.localeCompare(a.t));
      questions.push({
        name, label, type, answered: withTime.length, chart: "list",
        data: withTime.slice(0, 50).map((x) => String(x.v)),
      });
    }
  }

  const times = rows.map((r) => String(r._submission_time ?? "")).filter(Boolean).sort();
  return c.json({
    id: form.id,
    title: form.title,
    submissionCount: rows.length,
    lastSubmission: times.length ? times[times.length - 1] : null,
    questions,
  });
});

// ---- KoboToolbox: field-officer surveys ----

app.get("/kobo/my-surveys", withProfile("field_officer"), async (c) => {
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

app.post("/kobo/my-surveys/:id/submitted", withProfile("field_officer"), async (c) => {
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

Deno.serve(app.fetch);
