/**
 * HPF Digital Learning Portal — backend API.
 *
 * The static frontend never touches Postgres or Storage directly. Every
 * read and write goes through this one Edge Function, which:
 *   - verifies the caller's Supabase Auth JWT (magic-link sessions),
 *   - loads their role from `public.profiles` (never from user_metadata),
 *   - does all data access with the service-role key, which bypasses the
 *     deny-all RLS on every table.
 *
 * Deployed with verify_jwt = false: auth is enforced here, per route, so
 * the health check and CORS preflight get through.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SECRET_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/** Service-role client — bypasses RLS. Never expose this key to a browser. */
const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const ROLES = [
  "teacher",
  "learner",
  "school_leader",
  "field_officer",
  "education_team",
] as const;
type Role = (typeof ROLES)[number];

const LIBRARY_BUCKET = "library";
const DOWNLOAD_TTL = 60 * 60; // 1 h signed download URLs

// ---------------------------------------------------------------- helpers

const safeSegment = (s: string) =>
  String(s).replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, " ").trim() || "file";
const safePath = (p: string) => String(p).split("/").map(safeSegment).join("/");

const rid = (prefix: string) =>
  prefix + "_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);

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

type Vars = { userId: string; email: string; profile: Profile };
type Profile = {
  id: string;
  role: Role;
  full_name: string;
  email: string;
  school: string;
  county: string;
  grade: string;
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

/** Everything below needs a valid Supabase Auth session. */
app.use("*", async (c, next) => {
  const token = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return c.json({ error: "Not signed in" }, 401);
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return c.json({ error: "Invalid session" }, 401);
  c.set("userId", data.user.id);
  c.set("email", data.user.email ?? "");
  await next();
});

async function loadProfile(userId: string): Promise<Profile | null> {
  const { data } = await admin
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle();
  return (data as Profile) ?? null;
}

/** Route guard: require an onboarded profile, optionally of a given role. */
function withProfile(...roles: Role[]) {
  return async (c: any, next: any) => {
    const profile = await loadProfile(c.get("userId"));
    if (!profile) {
      return c.json({ needsOnboarding: true, email: c.get("email") }, 428);
    }
    if (roles.length && !roles.includes(profile.role)) {
      return c.json({ error: "Not allowed for your role" }, 403);
    }
    c.set("profile", profile);
    await next();
  };
}

// ---- session / onboarding ----

app.get("/me", async (c) => {
  const profile = await loadProfile(c.get("userId"));
  if (!profile) return c.json({ needsOnboarding: true, email: c.get("email") });
  return c.json({ profile: mapProfile(profile) });
});

app.post("/me", async (c) => {
  if (await loadProfile(c.get("userId"))) {
    return c.json({ error: "Profile already exists" }, 409);
  }
  const b = await c.req.json().catch(() => ({}));
  if (!ROLES.includes(b.role)) return c.json({ error: "Pick a role" }, 400);
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

// ---- content library ----

app.get("/library", withProfile(), async (c) => {
  const role = c.get("profile").role;
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
      uploaded_by: c.get("profile").full_name,
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

// ---- forms & responses ----

app.get("/forms", withProfile(), async (c) => {
  const p = c.get("profile");
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
      created_by: c.get("profile").full_name,
      questions: Array.isArray(b.questions) ? b.questions : [],
    })
    .select()
    .single();
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ form: mapForm(data) });
});

app.get("/responses", withProfile(), async (c) => {
  const p = c.get("profile");
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
  const p = c.get("profile");
  if (!b.formId) return c.json({ error: "Missing form" }, 400);
  const { data, error } = await admin
    .from("responses")
    .upsert(
      {
        id: b.id ?? rid("resp"),
        form_id: b.formId,
        respondent_id: p.id,
        respondent_name: p.full_name,
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

// ---- learner assignments ----

app.get("/assignments", withProfile(), async (c) => {
  const p = c.get("profile");
  if (p.role !== "learner" && p.role !== "education_team") {
    return c.json({ assignments: [] });
  }
  let q = admin.from("assignments").select("*").order("id");
  if (p.role === "learner") q = q.eq("learner_id", p.id);
  const { data, error } = await q;
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ assignments: (data ?? []).map(mapAssignment) });
});

app.patch("/assignments/:id", withProfile("learner"), async (c) => {
  const p = c.get("profile");
  const b = await c.req.json().catch(() => ({}));
  const { data, error } = await admin
    .from("assignments")
    .update({ done: b.done !== false })
    .eq("id", c.req.param("id"))
    .eq("learner_id", p.id)
    .select()
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 400);
  if (!data) return c.json({ error: "Assignment not found" }, 404);
  return c.json({ assignment: mapAssignment(data) });
});

// ---- field reports ----

app.get("/field-reports", withProfile(), async (c) => {
  const p = c.get("profile");
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
      officer_id: c.get("profile").id,
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
  const [profs, asg, reports, forms, responses] = await Promise.all([
    admin.from("profiles").select("role"),
    admin.from("assignments").select("done"),
    admin.from("field_reports").select("id", { count: "exact", head: true }),
    admin.from("forms").select("id"),
    admin.from("responses").select("id", { count: "exact", head: true }),
  ]);
  const byRole: Record<string, number> = {
    teacher: 0,
    learner: 0,
    school_leader: 0,
    field_officer: 0,
    education_team: 0,
  };
  for (const p of profs.data ?? []) {
    if (p.role in byRole) byRole[p.role as string]++;
  }
  const assignments = asg.data ?? [];
  return c.json({
    accounts: (profs.data ?? []).length,
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
