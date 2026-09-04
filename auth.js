/* ============================================================
   HPF Digital Learning Portal — demo auth.
   No backend (see README.md): "sessions" and "accounts" are both plain
   localStorage. This is deliberately NOT secure — passwords sit in plain
   text in the browser — and exists only so the sign-in -> dashboard flow
   is real and clickable. Do not carry this file's approach into anything
   that handles real people's data.
   ============================================================ */

import { SEED_USERS } from "./data.js";

const USERS_KEY = "hpf_learning_portal_users";
const SESSION_KEY = "hpf_learning_portal_session";

function readJSON(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ?? fallback;
  } catch {
    return fallback;
  }
}
const writeJSON = (key, value) => localStorage.setItem(key, JSON.stringify(value));

export function allUsers() {
  const stored = readJSON(USERS_KEY, null);
  if (Array.isArray(stored) && stored.length) return stored;
  writeJSON(USERS_KEY, SEED_USERS);
  return SEED_USERS.slice();
}

function saveUsers(users) {
  writeJSON(USERS_KEY, users);
}

export function currentUser() {
  return readJSON(SESSION_KEY, null);
}

export function signIn(username, password) {
  const id = (username || "").trim().toLowerCase();
  const user = allUsers().find((u) => u.username.toLowerCase() === id);
  if (!user) return { error: "No account with that username." };
  if (user.password !== password) return { error: "Wrong password." };
  const { password: _pw, ...safe } = user;
  writeJSON(SESSION_KEY, safe);
  return { user: safe };
}

export function signUp({ fullName, role, username, password, school, county, grade }) {
  const id = (username || "").trim().toLowerCase();
  if (!id) return { error: "Choose a username." };
  if (!password || password.length < 4) return { error: "Password must be at least 4 characters." };
  const users = allUsers();
  if (users.some((u) => u.username.toLowerCase() === id)) {
    return { error: "That username is already taken." };
  }
  const user = {
    id: "u_" + Date.now().toString(36),
    role,
    username: id,
    password,
    fullName: fullName || id,
    school: school || "",
    county: county || "",
    grade: grade || "",
  };
  users.push(user);
  saveUsers(users);
  const { password: _pw, ...safe } = user;
  writeJSON(SESSION_KEY, safe);
  return { user: safe };
}

export function signOut() {
  localStorage.removeItem(SESSION_KEY);
}

/* Call at the top of teacher.html/learner.html: sends anyone who isn't
   signed in, or is signed in as the wrong role, back to the front door
   rather than showing them an empty shell with no explanation. */
export function requireRole(role) {
  const user = currentUser();
  if (!user || user.role !== role) {
    location.href = "index.html";
    return null;
  }
  return user;
}
