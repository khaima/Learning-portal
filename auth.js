/* ============================================================
   HPF Digital Learning Portal — accounts and sessions.

   Accounts now live in the real `learning_portal.users` table (Supabase),
   not a localStorage array — that's what makes an account created on one
   device visible from another. What's still local, deliberately: which
   account *this browser* is currently signed in as. There is no real
   Supabase Auth session here (no JWT, no password hashing) — the "anon
   full access" policy on learning_portal is what the app's own
   plaintext-password check relies on, same posture the localStorage
   version always had. Do not carry this pattern into anything real.
   ============================================================ */

import { supabase } from "./supabase.js";

const SESSION_KEY = "hpf_learning_portal_session";

/* Some browser contexts (a locked-down embed, strict private-browsing,
   site data blocked outright) can make localStorage throw on every
   access rather than just come back empty. Fall back to an in-memory
   session for this page view so sign-in still works there — it just
   won't survive a reload, which is the best that's possible without
   real storage. */
const memorySession = Object.create(null);
function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw != null) return JSON.parse(raw);
  } catch {
    /* storage blocked or corrupt — fall through to memory */
  }
  return Object.prototype.hasOwnProperty.call(memorySession, key) ? memorySession[key] : fallback;
}
function writeJSON(key, value) {
  memorySession[key] = value;
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked — memory-only this visit */ }
}

export function currentUser() {
  return readJSON(SESSION_KEY, null);
}

function toSafeUser(row) {
  return {
    id: row.id, role: row.role, username: row.username, fullName: row.full_name,
    school: row.school, county: row.county, grade: row.grade,
  };
}

/* Every account actually recorded in the database — used by the
   Education Team dashboard's live, cross-account stat row. Real
   aggregation: it reflects whatever accounts exist right now, not a
   fixed number. */
export async function allUsers() {
  const { data, error } = await supabase.from("users").select("*").order("created_at");
  if (error) { console.warn("could not load accounts:", error.message); return []; }
  return data.map(toSafeUser);
}

export async function signIn(username, password) {
  const id = (username || "").trim().toLowerCase();
  const { data, error } = await supabase
    .from("users").select("*").eq("username", id).maybeSingle();
  if (error) return { error: "Could not reach the database — " + error.message };
  if (!data) return { error: "No account with that username." };
  if (data.password !== password) return { error: "Wrong password." };
  const safe = toSafeUser(data);
  writeJSON(SESSION_KEY, safe);
  return { user: safe };
}

export async function signUp({ fullName, role, username, password, school, county, grade }) {
  const id = (username || "").trim().toLowerCase();
  if (!id) return { error: "Choose a username." };
  if (!password || password.length < 4) return { error: "Password must be at least 4 characters." };

  const { data: existing, error: checkErr } = await supabase
    .from("users").select("id").eq("username", id).maybeSingle();
  if (checkErr) return { error: "Could not reach the database — " + checkErr.message };
  if (existing) return { error: "That username is already taken." };

  const row = {
    id: "u_" + Date.now().toString(36),
    role,
    username: id,
    password,
    full_name: fullName || id,
    school: school || "",
    county: county || "",
    grade: grade || "",
  };
  const { data, error } = await supabase.from("users").insert(row).select().maybeSingle();
  if (error) return { error: "Could not create the account — " + error.message };

  const safe = toSafeUser(data);
  writeJSON(SESSION_KEY, safe);
  return { user: safe };
}

export function signOut() {
  delete memorySession[SESSION_KEY];
  try { localStorage.removeItem(SESSION_KEY); } catch { /* storage blocked */ }
}

/* Call at the top of every dashboard page: sends anyone who isn't signed
   in, or is signed in as the wrong role, back to the front door rather
   than showing them an empty shell with no explanation. */
export function requireRole(role) {
  const user = currentUser();
  if (!user || user.role !== role) {
    location.href = "index.html";
    return null;
  }
  return user;
}
