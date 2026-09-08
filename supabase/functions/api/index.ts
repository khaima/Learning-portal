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

function hashPin(pin: string, salt: string) {
  return scryptSync(pin, salt, 32).toString("hex");
}
function pinMatches(pin: string, salt: string, hash: string) {
  const a = Buffer.from(hashPin(pin, salt), "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Two content destinations; legacy values fold in. */
function normalizeAudience(a: string | null | undefined): "staff" | "library" {
  return a === "staff" || a === "teacher" ? "staff" : "library";
}
function canSeeLibrary(audience: string | null | undefined, role: Role): boolean {
  if (role === "education_team") return true;
  const dest = normalizeAudience(audience);
  if (dest === "staff") return role === "teacher" || role === "school_leader";
  return role === "teacher" || role === "school_leader" || role === "learner";
}

type LibFile = { name: string; path: string; size: number };

async function signFiles(files: LibFile[]) {
  return await Promise.all(
    (files ?? []).map(async (f) => {
      const { data } = await admin.storage
        .from(LIBRARY_BUCKET)
        .createSignedUrl(f.path, DOWNLOAD_TTL, {
          download: f.name.split("/").pop() || true,
        });
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
});
const mapProfile = (r: Record<string, unknown>) => ({
  id: r.id,
  role: r.role,
  fullName: r.full_name,
  email: r.email,
  school: r.school,
  county: r.county,
  grade: r.grade,
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

type Actor = { id: string; role: Role; fullName: string; grade: string; school: string };
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
      return null;
    },
    allowHeaders: ["authorization", "content-type"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
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
    .select("id, username, full_name, grade, created_at, locked_until")
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
  const { data, error } = await admin
    .from("learners")
    .insert({
      teacher_id: teacher.id,
      username,
      pin_hash: hashPin(pin, salt),
      pin_salt: salt,
      full_name: fullName,
      grade: String(b.grade ?? "").trim(),
      school: teacher.school ?? "",
    })
    .select("id, username, full_name, grade, created_at, locked_until")
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
    .select("id, username, full_name, grade, created_at, locked_until")
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

// ---- content library ----

app.get("/library", withActor(), async (c) => {
  const role = c.get("actor").role;
  const { data, error } = await admin
    .from("library_items")
    .select("*")
    .order("uploaded_at", { ascending: false });
  if (error) return c.json({ error: error.message }, 500);
  const visible = (data ?? []).filter((it) =>
    canSeeLibrary(it.audience as string, role),
  );
  const items = await Promise.all(visible.map(mapLibrary));
  return c.json({ items });
});

app.post("/library", withProfile("education_team"), async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (!String(b.title ?? "").trim()) return c.json({ error: "Title is required" }, 400);
  const id = rid("lib");

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
      audience: b.audience === "staff" ? "staff" : "library",
      description: String(b.description ?? "").trim(),
      uploaded_by: c.get("actor").fullName,
      file_name: b.fileName ?? files[0]?.name ?? null,
      file_size: files.reduce((s, f) => s + (f.size || 0), 0),
      is_folder: isFolder,
      files,
    })
    .select()
    .single();
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ item: await mapLibrary(data), uploads });
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

app.patch("/assignments/:id", withActor("learner"), async (c) => {
  const a = c.get("actor");
  const b = await c.req.json().catch(() => ({}));
  const { data, error } = await admin
    .from("assignments")
    .update({ done: b.done !== false })
    .eq("id", c.req.param("id"))
    .eq("learner_id", a.id)
    .select()
    .maybeSingle();
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

app.get("/stats", withProfile("education_team"), async (c) => {
  const [profs, learners, asg, reports, forms, responses] = await Promise.all([
    admin.from("profiles").select("role"),
    admin.from("learners").select("id", { count: "exact", head: true }),
    admin.from("assignments").select("done"),
    admin.from("field_reports").select("id", { count: "exact", head: true }),
    admin.from("forms").select("id"),
    admin.from("responses").select("id", { count: "exact", head: true }),
  ]);
  const byRole: Record<string, number> = {
    teacher: 0,
    learner: learners.count ?? 0,
    school_leader: 0,
    field_officer: 0,
    education_team: 0,
  };
  for (const p of profs.data ?? []) {
    if (p.role in byRole) byRole[p.role as string]++;
  }
  const assignments = asg.data ?? [];
  return c.json({
    accounts: (profs.data ?? []).length + (learners.count ?? 0),
    byRole,
    assignmentsTotal: assignments.length,
    assignmentsDone: assignments.filter((a) => a.done).length,
    reportsFiled: reports.count ?? 0,
    formsSent: (forms.data ?? []).length,
    responsesReceived: responses.count ?? 0,
  });
});

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Server error" }, 500);
});

Deno.serve(app.fetch);
