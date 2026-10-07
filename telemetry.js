/* ============================================================
   HPF Digital Learning Portal — reporting errors.

   An error the page doesn't catch is sent to the portal's API, which
   passes it on to the error tracker (Sentry, or GlitchTip) when one is set
   up — see supabase/functions/api/telemetry.ts. This file stays tiny on
   purpose: no tracker library is downloaded, and nothing new is allowed
   in the CSP.

   What goes: the error's type, message and stack, the page's file name,
   the version of the app, and whether the device was online. Not the
   address's query (invitation links), anything anyone typed, names or
   PINs — the API adds the role and school from the session itself, and
   scrubs the message again.

   The API's refusals (an ApiError with a status) are shown to the person
   and aren't faults in the code, and the API reports its own 5xx, so
   neither is sent from here; nor is a dropped connection. At most 5
   reports a page, each error once.
   ============================================================ */

import { API_BASE } from "./config.js";
import { authHeader } from "./api.js";

const MAX_PER_PAGE = 5;
// A dropped connection isn't a fault in the code — on school connections it's
// the weather. The sync center shows connectivity; these aren't reported.
const CONNECTION = /failed to fetch|networkerror|load failed|network request failed|importing a module script failed|dynamically imported module|aborterror|operation was aborted|timed? ?out/i;
const seen = new Set();
let sent = 0;
let version = null;

/** The build this page runs: the service worker's version (build-sw.mjs writes version.json). */
async function appVersion() {
  if (version) return version;
  try {
    const res = await fetch("./version.json", { cache: "no-cache" });
    version = res.ok ? (await res.json()).version : "dev";
  } catch {
    version = "unknown";
  }
  return version;
}

const describe = (v) => {
  try { return typeof v === "string" ? v : JSON.stringify(v); } catch { return String(v); }
};

/** Report an error. Never throws, never slows the page. */
export function reportError(err, { source = "report", level = "error" } = {}) {
  try {
    if (!err || (typeof err === "object" && err.status != null)) return; // the API's own replies
    const e = err instanceof Error ? err : new Error(describe(err));
    if (CONNECTION.test(`${e.name} ${e.message}`)) return;
    const key = `${e.name}|${e.message}`;
    if (seen.has(key) || sent >= MAX_PER_PAGE) return;
    seen.add(key);
    sent += 1;
    send({
      type: e.name || "Error", message: String(e.message || "").slice(0, 1000), stack: String(e.stack || "").slice(0, 6000),
      page: location.pathname.split("/").pop() || "index.html", source, level, online: navigator.onLine,
    });
  } catch { /* reporting must never break the page */ }
}

async function send(report) {
  const headers = { "content-type": "application/json" };
  try {
    // Signed in, the API tags the report with the role and school.
    Object.assign(headers, await authHeader());
  } catch { /* report it anonymously */ }
  const body = JSON.stringify({ ...report, release: await appVersion() });
  fetch(`${API_BASE}/telemetry/error`, { method: "POST", headers, body, keepalive: true }).catch(() => {});
}

if (typeof window !== "undefined") {
  window.addEventListener("error", (e) => {
    // Only the portal's own code: not browser extensions, not other sites' scripts.
    if (e.error && (!e.filename || e.filename.startsWith(location.origin))) reportError(e.error, { source: "window.error" });
  });
  window.addEventListener("unhandledrejection", (e) => reportError(e.reason, { source: "unhandledrejection" }));
}
