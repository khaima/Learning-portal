/* ============================================================
   HPF Digital Learning Portal — offline work and sync.

     ONLINE → download assigned content → work offline on this device →
     stored locally → network back → SYNC → server

   send() is how an activity that can be done offline is sent (answers,
   hand-ins, marks, visits, form responses, reading time). Online, it goes
   straight to the server. Offline — or when the connection drops mid-way —
   it joins the QUEUE on this device and the page carries on with the
   change shown locally ("waiting to sync").

   The queue is sent in order whenever the connection is back: on load,
   when the browser says it's online, every few minutes, and on "Sync now".
     • Every queued activity has its own id, sent as an Idempotency-Key:
       if a send arrived but its reply was lost, the retry gets the first
       reply back instead of doing it twice.
     • A connection failure is retried — never dropped.
     • A REFUSAL (the assignment was closed, the account changed…) is kept,
       shown, and waits for the person: try again, or discard.
     • A CONFLICT (the same work changed somewhere else meanwhile) is kept
       with the server's copy; the person chooses which to keep. Later
       activities on the same thing wait until that's settled.
   Files chosen offline wait here too, and are uploaded first at sync.

   After the queue, the registered DOWNLOADS run (each dashboard says what
   it needs offline — a learner's open assignments, a teacher's marking),
   and that is "Last sync".
   ============================================================ */

import * as store from "./offline.js";
import { rawRequest } from "./api.js";
import { supabase } from "./supabase.js";

const BUCKET = "library";
const FIVE_MIN = 5 * 60_000;
/** Shown to the Education Team next to each device, to spot an old copy of the app. */
export const APP_VERSION = "2026.10.03b";

/* What each kind of queued activity counts as, in the Sync center. */
const AREA = {
  "learner-work": "learning", mark: "learning", reading: "learning",
  "field-visit": "school", "form-response": "school",
};
export const areaOf = (kind) => AREA[kind] || "other";

let owner = null;
let ownerRole = null;
let items = [];            // this owner's queue, in order (kept in memory for quick checks)
let savedFiles = new Map(); // key → { itemId, name, size, title, savedAt }
let lastSync = null;
let flushing = false;
let needsSignIn = false;
let networkFailedAt = 0;
let reachedAt = 0;         // the last time a request actually got a reply from the server
let lastPrefetch = 0;
const prefetchers = [];
const kinds = {};

/* ------------------------------------------------------------ connection */

/** A failure of the connection itself — not a refusal from the server. */
export function isNetworkError(err) {
  return !!err && (err.offline === true || err.name === "AbortError" || err instanceof TypeError ||
    /failed to fetch|networkerror|load failed|network request failed|connection was lost|internet connection appears|timed? ?out/i.test(err.message || ""));
}

/** Online as far as we can tell: the browser says so and nothing has just failed. */
export const isOnline = () => navigator.onLine && Date.now() - networkFailedAt > 15_000;

/** api.js reports every request's outcome here. */
export function noteNetwork(ok) {
  const was = isOnline();
  networkFailedAt = ok ? 0 : Date.now();
  if (ok) reachedAt = Date.now();
  if (was !== isOnline()) { emit(); if (ok) kick(); }
}

/* ------------------------------------------------------------ who */

export const currentOwner = () => owner;

/** Called once the signed-in account is known (online or from this device). */
export async function setOwner(id, role = null) {
  if (role) ownerRole = role;
  if (!id || id === owner) return;
  owner = id;
  lastSync = await store.getMeta(`lastSync:${owner}`);
  await refresh();
  emit();
  setTimeout(() => sync(), 1500); // after the page's own first loads
}

async function refresh() {
  items = await store.queueFor(owner).catch(() => []);
  savedFiles = new Map((await store.blobsFor(owner).catch(() => []))
    .filter((r) => r.kind === "file").map((r) => [r.key, { itemId: r.itemId, name: r.name, size: r.size, title: r.title, savedAt: r.savedAt }]));
}

/* ------------------------------------------------------------ status */

export function status() {
  const open = items.filter((i) => i.status === "pending" || i.status === "syncing");
  const byArea = {};
  for (const i of items) {
    const a = (byArea[areaOf(i.kind)] ||= { pending: 0, stuck: 0 });
    if (i.status === "conflict" || i.status === "failed") a.stuck += 1; else a.pending += 1;
  }
  return {
    byArea,
    oldestPendingAt: open.map((i) => i.createdAt).sort()[0] ?? null,
    role: ownerRole,
    online: isOnline(),
    lastSync,
    syncing: flushing,
    needsSignIn,
    pending: items.filter((i) => i.status === "pending" || i.status === "syncing").length,
    failed: items.filter((i) => i.status === "failed").length,
    conflicts: items.filter((i) => i.status === "conflict").length,
    items: items.map((i) => ({ ...i })),
    savedFiles: [...savedFiles.entries()].map(([key, f]) => ({ key, ...f })),
  };
}
function emit() {
  try { window.dispatchEvent(new CustomEvent("hpf-sync", { detail: status() })); } catch { /* not in a page */ }
}
export const onChange = (fn) => { const h = (e) => fn(e.detail); window.addEventListener("hpf-sync", h); return () => window.removeEventListener("hpf-sync", h); };

/** Is something about this (an assignment, a form…) still waiting to sync? */
export const waiting = (group) => items.find((i) => i.group === group) || null;
/** A cached page has local changes on top that haven't synced: don't overwrite it. */
export const isDirty = (path) => items.some((i) => (i.touches || []).includes(path));

/* ------------------------------------------------------------ registries */

/** What a kind of activity does when it lands, or is settled another way:
    { applied(item, reply), settled(item, serverCopy|null) }. */
export function registerKind(kind, handlers) { kinds[kind] = handlers; }
/** A download to run at each sync (what this page needs offline). */
export function registerPrefetch(fn) { prefetchers.push(fn); }

/* ------------------------------------------------------------ send */

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`).replace(/[^A-Za-z0-9_-]/g, "");

/**
 * Sends an activity, or queues it if there's no connection.
 * op: { method, path, body, offlineBody?, label, kind, group?, dedupe?, touches?, meta?, local? }
 *   offlineBody — what to send if it's queued (adds what the device last
 *                 saw, so the server can spot a conflict)
 *   dedupe      — a newer queued copy replaces an older one (answers saved twice)
 *   touches     — cached pages this changes locally; local() writes them
 * Resolves { data, queued }. A refusal while online is thrown, as before.
 */
export async function send(op) {
  const id = newId();
  const resolved = new Map();
  if (isOnline() && !(op.group && waiting(op.group))) {
    try {
      const body = await resolveUploads(op.body, resolved);
      const data = await rawRequest(op.method, op.path, body, { idempotencyKey: id });
      for (const key of resolved.keys()) await store.removeBlob(key).catch(() => {});
      // Keep this device's copy in step, so work done offline next starts from it.
      await kinds[op.kind]?.applied?.({ ...op, id, meta: op.meta || {} }, data)?.catch?.(() => {});
      return { data, queued: false };
    } catch (err) {
      if (!isNetworkError(err)) throw err;
      // The connection dropped: queue it under the same id, so if it did arrive the retry is harmless.
    }
  }
  const local = op.local ? await op.local() : null;
  await enqueue({ id, ...op, body: swapRefs(op.offlineBody ?? op.body, resolved), local: undefined });
  for (const key of resolved.keys()) await store.removeBlob(key).catch(() => {});
  return { data: local, queued: true };
}

async function enqueue(op) {
  const now = new Date().toISOString();
  const item = {
    id: op.id, owner, method: op.method, path: op.path, body: op.body, label: op.label || "Activity",
    kind: op.kind || "", group: op.group || null, dedupe: op.dedupe || null, touches: op.touches || [], meta: op.meta || {},
    seq: Date.now() * 1000 + Math.floor(Math.random() * 1000), status: "pending", attempts: 0, nextAt: 0, createdAt: now, updatedAt: now,
  };
  if (item.dedupe) {
    const older = items.find((i) => i.dedupe === item.dedupe && i.status !== "syncing");
    if (older) { item.seq = older.seq; item.createdAt = older.createdAt; await store.removeItem(older.id); }
  }
  await store.putItem(item);
  keepStorage();
  await refresh();
  emit();
  kick();
}

/* ------------------------------------------------------------ files chosen offline */

/** Keeps a file chosen without a connection; returns the reference to put in
    the activity ({ name, size, pendingUpload }). It's uploaded at sync via
    uploadPath (the API's signed-upload route) before the activity is sent. */
export async function stashUpload(file, { uploadPath, uploadBody }) {
  const key = `${owner}|up|${newId()}`;
  await store.putBlob({ key, owner, kind: "upload", blob: file, name: file.name, size: file.size, type: file.type, uploadPath, uploadBody });
  keepStorage();
  return { name: file.name, size: file.size, pendingUpload: key };
}

/** Puts uploaded files' references in place of their { pendingUpload } stand-ins. */
function swapRefs(v, resolved) {
  if (!resolved.size) return v;
  if (Array.isArray(v)) return v.map((x) => swapRefs(x, resolved));
  if (v && typeof v === "object") {
    if (typeof v.pendingUpload === "string") return resolved.get(v.pendingUpload) ?? v;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swapRefs(x, resolved)]));
  }
  return v;
}

/** Uploads every file still waiting in a body; returns the body with their
    references. What did upload is in `resolved` even if a later one fails. */
async function resolveUploads(body, resolved) {
  const keys = [];
  const find = (v) => {
    if (Array.isArray(v)) v.forEach(find);
    else if (v && typeof v === "object") { if (typeof v.pendingUpload === "string") keys.push(v.pendingUpload); else Object.values(v).forEach(find); }
  };
  find(body);
  if (!keys.length) return body;
  for (const key of keys) {
    if (resolved.has(key)) continue;
    const rec = await store.getBlob(key);
    if (!rec) throw Object.assign(new Error("A file chosen offline is no longer on this device — choose it again."), { status: 410 });
    const { upload } = await rawRequest("POST", rec.uploadPath, rec.uploadBody);
    const { error } = await supabase.storage.from(BUCKET).uploadToSignedUrl(upload.path, upload.token, rec.blob, { contentType: rec.type || undefined });
    if (error) throw isNetworkError(error) ? Object.assign(new Error(error.message), { offline: true }) : error;
    resolved.set(key, { name: rec.name, path: upload.path, size: rec.size });
  }
  return swapRefs(body, resolved);
}
const uploadKeysIn = (body) => JSON.stringify(body ?? null).match(/"pendingUpload":"([^"]+)"/g)?.map((m) => m.slice(17, -1)) ?? [];

/* ------------------------------------------------------------ sync */

let kickTimer = null;
function kick() {
  clearTimeout(kickTimer);
  kickTimer = setTimeout(() => sync(), 400);
}
const backoff = (n) => Math.min(30 * 60_000, 15_000 * 2 ** Math.min(n, 7));

/** One sync: send the queue in order, then refresh what's kept offline. */
export async function sync({ manual = false } = {}) {
  if (flushing || !owner) return status();
  if (!navigator.onLine) { emit(); return status(); }
  flushing = true;
  needsSignIn = false;
  emit();
  const started = Date.now();
  let cut = false; // the connection failed part-way
  try {
    const queue = await store.queueFor(owner);
    const blocked = new Set();
    for (const it of queue) {
      if (it.status === "conflict" || it.status === "failed") { if (it.group) blocked.add(it.group); continue; }
      if (it.group && blocked.has(it.group)) continue;
      if (!manual && it.nextAt > Date.now()) { if (it.group) blocked.add(it.group); continue; }
      it.status = "syncing";
      await store.putItem(it);
      await refresh(); emit();
      const resolved = new Map();
      try {
        it.body = await resolveUploads(it.body, resolved);
        if (resolved.size) await store.putItem(it); // uploaded: never upload twice
        const reply = await rawRequest(it.method, it.path, it.body, { idempotencyKey: it.id, timeoutMs: 60_000 });
        await store.removeItem(it.id);
        for (const key of resolved.keys()) await store.removeBlob(key).catch(() => {});
        await refresh();
        await kinds[it.kind]?.applied?.(it, reply);
      } catch (err) {
        it.updatedAt = new Date().toISOString();
        if (resolved.size) {
          // Files that did upload stay uploaded: keep their references, drop the copies.
          it.body = swapRefs(it.body, resolved);
          for (const key of resolved.keys()) await store.removeBlob(key).catch(() => {});
        }
        if (isNetworkError(err)) {
          Object.assign(it, { status: "pending", attempts: it.attempts + 1, nextAt: Date.now() + backoff(it.attempts) });
          await store.putItem(it);
          cut = true;
          break;
        }
        if (err.status === 401) { it.status = "pending"; await store.putItem(it); needsSignIn = true; cut = true; break; }
        if (it.group) blocked.add(it.group);
        if (err.status === 409 && err.body?.retryable) {
          Object.assign(it, { status: "pending", nextAt: Date.now() + 30_000 });
        } else if (err.status === 409 && err.body?.conflict) {
          Object.assign(it, { status: "conflict", conflict: err.body.conflict, error: err.message });
        } else if (err.status >= 500 || err.status === 429) {
          it.attempts += 1;
          Object.assign(it, { status: it.attempts >= 6 ? "failed" : "pending", error: err.message, nextAt: Date.now() + backoff(it.attempts) });
        } else {
          Object.assign(it, { status: "failed", error: err.message || "The server refused it" });
        }
        await store.putItem(it);
      }
      await refresh(); emit();
    }
    if (!cut) await runPrefetch(manual);
    // "Last sync" only when the server really answered during this sync —
    // downloads fall back to this device's copies, so they can't tell.
    if (!cut && !needsSignIn && reachedAt >= started) await markSynced();
    if (reachedAt >= started) await reportDevice();
  } catch (err) {
    if (!isNetworkError(err)) console.error("sync:", err);
    cut = true;
  } finally {
    flushing = false;
    await refresh();
    emit();
  }
  return status();
}

async function runPrefetch(manual) {
  if (!manual && Date.now() - lastPrefetch < 2 * 60_000) {
    // Downloaded a moment ago: just check the server is there.
    await rawRequest("GET", "/me", undefined, { timeoutMs: 20_000 }).catch(() => {});
    return;
  }
  const t0 = Date.now();
  for (const fn of prefetchers) {
    try { await fn(); } catch (err) {
      if (isNetworkError(err)) return; // not a complete sync
      console.warn("download for offline:", err);
    }
  }
  if (!prefetchers.length) await rawRequest("GET", "/me", undefined, { timeoutMs: 20_000 }).catch(() => {});
  if (reachedAt >= t0) lastPrefetch = Date.now();
}
async function markSynced() {
  lastSync = new Date().toISOString();
  await store.setMeta(`lastSync:${owner}`, lastSync);
}

/* ------------------------------------------------------------ this device, for the field team view
   Staff devices tell the server how they're doing after each sync —
   counts and times only, never the work — so the Education Team can see,
   say, that an officer's phone has had visits waiting for three days.
   Learners' (often shared) tablets don't report. */
function deviceId() {
  try {
    let id = localStorage.getItem("hpf_device_id");
    if (!id) { id = newId(); localStorage.setItem("hpf_device_id", id); }
    return id;
  } catch { return null; }
}
export function deviceLabel() {
  const ua = navigator.userAgent || "";
  const os = /Android/i.test(ua) ? "Android" : /iPhone|iPad|iPod/i.test(ua) ? "iPhone/iPad" : /CrOS/i.test(ua) ? "Chromebook"
    : /Windows/i.test(ua) ? "Windows" : /Mac OS X/i.test(ua) ? "Mac" : /Linux/i.test(ua) ? "Linux" : "Device";
  const browser = /SamsungBrowser/i.test(ua) ? "Samsung Internet" : /Edg\//i.test(ua) ? "Edge" : /OPR\//i.test(ua) ? "Opera"
    : /Firefox\//i.test(ua) ? "Firefox" : /Chrome\//i.test(ua) ? "Chrome" : /Safari\//i.test(ua) ? "Safari" : "browser";
  const installed = window.matchMedia?.("(display-mode: standalone)").matches ? " · installed" : "";
  return `${os} · ${browser}${installed}`;
}
async function reportDevice() {
  const id = deviceId();
  if (!id || !ownerRole || ownerRole === "learner") return;
  const st = status();
  await rawRequest("POST", "/sync/report", {
    deviceId: id, deviceLabel: deviceLabel(), appVersion: APP_VERSION, online: true, lastSyncAt: st.lastSync,
    pending: st.pending, failed: st.failed, conflicts: st.conflicts, savedFiles: st.savedFiles.length, oldestPendingAt: st.oldestPendingAt,
  }, { timeoutMs: 20_000 }).catch(() => {});
}

/* ------------------------------------------------------------ settling what's stuck */

async function replaceItem(it, patch) {
  await store.removeItem(it.id);
  // A new id: the old one's reply (a refusal, a conflict) is already on record.
  await store.putItem({ ...it, ...patch, id: newId(), status: "pending", attempts: 0, nextAt: 0, error: null, conflict: null, updatedAt: new Date().toISOString() });
  await refresh(); emit(); kick();
}
const find = (id) => items.find((i) => i.id === id);

/** Conflict: send mine anyway. */
export async function keepMine(id) {
  const it = find(id); if (!it) return;
  await replaceItem(it, { body: { ...it.body, force: true } });
}
/** Refused: try again (e.g. after the problem was fixed). */
export async function retry(id) {
  const it = find(id); if (!it) return;
  await replaceItem(it, {});
}
/** Conflict: use the server's copy. Refused: give up on it. Either way this
    device's version is dropped (with any files it was holding). */
export async function discard(id) {
  const it = find(id); if (!it) return;
  await store.removeItem(it.id);
  for (const key of uploadKeysIn(it.body)) await store.removeBlob(key).catch(() => {});
  await refresh();
  await kinds[it.kind]?.settled?.(it, it.conflict?.server ?? null);
  emit();
}

/* ------------------------------------------------------------ resources saved for offline */

const fileKey = (itemId, name) => `${owner}|file|${itemId}|${name}`;
export const savedFile = (itemId, name) => savedFiles.get(fileKey(itemId, name)) || null;

/** Downloads a library file onto this device, to open in the portal's
    viewer without a connection (never as a file to keep elsewhere). */
export async function saveFile({ itemId, title, name, size, url }) {
  if (!owner) throw new Error("Sign in first");
  const res = await fetch(url);
  if (!res.ok) throw new Error(res.status === 400 || res.status === 403 ? "The link has expired — refresh the page and try again." : `Couldn't download it (${res.status})`);
  const blob = await res.blob();
  await store.putBlob({ key: fileKey(itemId, name), owner, kind: "file", blob, name, size: size || blob.size, type: blob.type, itemId, title });
  keepStorage();
  await refresh(); emit();
}
export async function removeSavedFile(key) {
  await store.removeBlob(key);
  await refresh(); emit();
}
/** A saved file as an object URL (the caller revokes it), or null. */
export async function savedFileUrl(itemId, name) {
  const rec = await store.getBlob(fileKey(itemId, name)).catch(() => null);
  return rec?.blob ? URL.createObjectURL(rec.blob) : null;
}

/** Ask the browser not to clear what's kept here when space runs low. */
let askedPersist = false;
function keepStorage() {
  if (askedPersist) return;
  askedPersist = true;
  navigator.storage?.persist?.().catch(() => {});
}

/* ------------------------------------------------------------ signing out */

/** Before signing out: how much hasn't been sent. */
export const unsentCount = () => items.length;
export async function forgetThisDevice() {
  await store.forgetOwner(owner).catch(() => {});
  owner = null; items = []; savedFiles = new Map(); lastSync = null;
  emit();
}

/* ------------------------------------------------------------ triggers */

if (typeof window !== "undefined") {
  window.addEventListener("online", () => { networkFailedAt = 0; emit(); kick(); });
  window.addEventListener("offline", () => emit());
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") kick(); });
  setInterval(() => {
    if (document.visibilityState !== "visible" || !owner) return;
    if (items.some((i) => i.status === "pending") || Date.now() - lastPrefetch > FIVE_MIN) sync();
  }, 60_000);
}
