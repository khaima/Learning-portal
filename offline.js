/* ============================================================
   HPF Digital Learning Portal — what this device keeps (IndexedDB).

   Four stores, every record tagged with its OWNER (the signed-in
   account), because school devices are shared:

     cache  — copies of what the server sent (assignments, the library
              list, class lists…), so pages open without a connection.
     queue  — activities done offline, waiting to be sent (sync.js).
     blobs  — files: ones chosen offline that still have to be uploaded,
              and library resources saved for reading offline.
     meta   — small settings: who was signed in, when the last sync was.

   Nothing here is sent anywhere by itself; sync.js does the sending.
   Signing out clears the owner's copies and saved files, but never work
   that hasn't been sent yet.
   ============================================================ */

const DB_NAME = "hpf_learning_offline";
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!("indexedDB" in globalThis)) { reject(new Error("This browser can't keep data offline")); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("cache")) db.createObjectStore("cache", { keyPath: "key" }).createIndex("owner", "owner");
      if (!db.objectStoreNames.contains("queue")) db.createObjectStore("queue", { keyPath: "id" }).createIndex("owner", "owner");
      if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs", { keyPath: "key" }).createIndex("owner", "owner");
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("Close the portal's other tabs and reload"));
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

const done = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

/** Runs fn(store) in one transaction; resolves with fn's result once committed. */
async function tx(name, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(name, mode);
    let out;
    Promise.resolve(fn(t.objectStore(name))).then((v) => { out = v; }, reject);
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("Storage full or blocked"));
  });
}
const byOwner = (name, owner) => tx(name, "readonly", (s) => done(s.index("owner").getAll(owner)));

/* ------------------------------------------------------------ cache */

const cacheKey = (owner, path) => `${owner}|${path}`;
export async function getCached(owner, path) {
  if (!owner) return null;
  try { return (await tx("cache", "readonly", (s) => done(s.get(cacheKey(owner, path))))) ?? null; } catch { return null; }
}
/** When each of this owner's copies was last refreshed: [{ path, savedAt }]. */
export async function cacheIndex(owner) {
  if (!owner) return [];
  try { return (await byOwner("cache", owner)).map((r) => ({ path: r.path, savedAt: r.savedAt, size: Array.isArray(r.data?.items) ? r.data.items.length : null })); } catch { return []; }
}
export async function putCached(owner, path, data) {
  if (!owner) return;
  try { await tx("cache", "readwrite", (s) => done(s.put({ key: cacheKey(owner, path), owner, path, data, savedAt: new Date().toISOString() }))); } catch { /* full or blocked */ }
}

/* ------------------------------------------------------------ queue */

export const queueFor = async (owner) => (owner ? (await byOwner("queue", owner)).sort((a, b) => a.seq - b.seq) : []);
export const putItem = (item) => tx("queue", "readwrite", (s) => done(s.put(item)));
export const getItem = (id) => tx("queue", "readonly", (s) => done(s.get(id)));
export const removeItem = (id) => tx("queue", "readwrite", (s) => done(s.delete(id)));

/* ------------------------------------------------------------ blobs */

export const putBlob = (rec) => tx("blobs", "readwrite", (s) => done(s.put({ savedAt: new Date().toISOString(), ...rec })));
export const getBlob = (key) => tx("blobs", "readonly", (s) => done(s.get(key)));
export const removeBlob = (key) => tx("blobs", "readwrite", (s) => done(s.delete(key)));
export const blobsFor = async (owner) => (owner ? byOwner("blobs", owner) : []);

/* ------------------------------------------------------------ meta */

export async function getMeta(key) {
  try { return (await tx("meta", "readonly", (s) => done(s.get(key))))?.value ?? null; } catch { return null; }
}
export async function setMeta(key, value) {
  try { await tx("meta", "readwrite", (s) => done(s.put({ key, value }))); } catch { /* ignore */ }
}

/** Signing out on a shared device: the owner's copies and saved files go;
    work still waiting to be sent (and the files it needs) stays. */
export async function forgetOwner(owner) {
  if (!owner) return;
  await tx("cache", "readwrite", async (s) => {
    for (const key of await done(s.index("owner").getAllKeys(owner))) s.delete(key);
  });
  await tx("blobs", "readwrite", async (s) => {
    for (const r of await done(s.index("owner").getAll(owner))) if (r.kind === "file") s.delete(r.key);
  });
}
