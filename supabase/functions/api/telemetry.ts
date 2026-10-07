/* ============================================================
   Error reporting to Sentry — or GlitchTip, which speaks the same
   protocol. Off until the function has a SENTRY_DSN secret
   (docs/OPERATIONS.md).

   Both sides of the portal report through here:
   - the API's own failures — a 5xx reply or an exception — from the
     middleware in index.ts;
   - the browser's: telemetry.js posts them to POST /telemetry/error and
     this passes them on. So the browser never needs the DSN, the CSP lets
     nothing new in, and what leaves the portal is decided in one place.

   What is sent: the error (type, message, stack), where it happened (the
   route or the page), the release and environment, and tags — the role,
   the school (its code), staff or learner. Never a name, email, phone
   number, PIN, token or request body: messages are scrubbed below, and the
   person is only a one-way hash (to count how many people an error hit).
   ============================================================ */

export type Side = "api" | "browser";
export type Level = "error" | "warning";
export type Frame = { function?: string; filename: string; lineno?: number; colno?: number; in_app: boolean };
export type Report = {
  side: Side;
  level?: Level;
  type: string;
  message: string;
  stack?: string;
  /** The API route (pattern, ids replaced) or the page. */
  transaction: string;
  tags: Record<string, string>;
  /** The person, before hashing (a profile or learner id). */
  actorId?: string | null;
  release?: string;
  environment?: string;
};

const MAX_MESSAGE = 500;
const MAX_FRAMES = 50;

/* ------------------------------------------------------------ settings */

let dsnOverride: string | null | undefined;
let fetchImpl: typeof fetch = (...a) => fetch(...a);
/** Tests: a DSN and a fetch that records instead of sending. */
export function __setTelemetryForTests(opts: { dsn: string | null; fetch?: typeof fetch }) {
  dsnOverride = opts.dsn;
  if (opts.fetch) fetchImpl = opts.fetch;
  recent.clear();
  sentThisMinute = 0;
}
const configuredDsn = () => (dsnOverride !== undefined ? dsnOverride : Deno.env.get("SENTRY_DSN") ?? null);
export const telemetryOn = () => !!parseDsn(configuredDsn());

/** "production" on the live project, otherwise what HPF_ENVIRONMENT says (staging), else "development". */
export function environment(): string {
  const set = Deno.env.get("HPF_ENVIRONMENT");
  if (set) return set;
  return (Deno.env.get("SUPABASE_URL") ?? "").includes("fwpqytrdlmxymvegvgji") ? "production" : "development";
}

/* ------------------------------------------------------------ the DSN */

export type Dsn = { envelopeUrl: string; publicKey: string; dsn: string };
/** https://<public key>@<host>[/<path>]/<project id> → where envelopes go. */
export function parseDsn(dsn: string | null | undefined): Dsn | null {
  if (!dsn) return null;
  try {
    const u = new URL(dsn);
    const parts = u.pathname.split("/").filter(Boolean);
    const project = parts.pop();
    if (!u.username || !project || !/^\d+$/.test(project) || !/^https?:$/.test(u.protocol)) return null;
    const prefix = parts.length ? `/${parts.join("/")}` : "";
    return { envelopeUrl: `${u.protocol}//${u.host}${prefix}/api/${project}/envelope/`, publicKey: decodeURIComponent(u.username), dsn };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ privacy */

/** Takes out anything that could identify a person or open an account. */
export function scrub(text: unknown, max = MAX_MESSAGE): string {
  let s = String(text ?? "");
  s = s
    .replace(/\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]{6,}/g, "[token]")             // JWTs (staff sessions)
    .replace(/\bhpl_[\w-]+/g, "hpl_[token]")                                 // learner sessions
    .replace(/\bbearer\s+\S+/gi, "Bearer [token]")
    .replace(/(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/g, "$1?[…]")           // query strings (signed URLs, invites)
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]")
    .replace(/\bKey \(([^)]*)\)=\(([^)]*)\)/g, "Key ($1)=(…)")              // Postgres puts the clashing value here
    .replace(/\b(token|access_token|refresh_token|apikey|api_key|key|secret|password|pin)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s,;&]+)/gi, "$1=[redacted]")
    .replace(/\+?\d[\d ()-]{7,}\d/g, (m) => (m.replace(/\D/g, "").length >= 9 ? "[number]" : m)) // phone numbers
    .replace(/(^|[^\w-])\d{4,}(?![\w-])/g, "$1[number]");                    // PINs and other long numbers
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** A URL or path as a short, query-free file name: ./static/console-COGfuUhY.js?x → static/console-COGfuUhY.js */
function cleanFile(file: string): string {
  const noQuery = file.replace(/[?#].*$/, "");
  try {
    const u = new URL(noQuery);
    return u.pathname.replace(/^\/(Learning-portal\/)?/, "") || u.host;
  } catch {
    return noQuery;
  }
}

/** The stack as Sentry frames (oldest call first), from Chrome's or Firefox/Safari's format. */
export function parseStack(stack: string | undefined): Frame[] {
  if (!stack) return [];
  const frames: Frame[] = [];
  for (const raw of stack.split("\n").slice(0, MAX_FRAMES + 1)) {
    const line = raw.trim();
    const chrome = /^at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    const gecko = !chrome && /^(.*?)@(.+?):(\d+):(\d+)$/.exec(line);
    const m = chrome || gecko;
    if (!m) continue;
    const filename = cleanFile(m[2]);
    frames.push({
      function: m[1] ? scrub(m[1], 120) : undefined,
      filename,
      lineno: Number(m[3]),
      colno: Number(m[4]),
      in_app: !/^(node:|ext:|chrome-extension:|moz-extension:|safari-extension:|<anonymous>)/.test(filename) && !filename.includes("node_modules"),
    });
  }
  return frames.reverse();
}

/** An API path as a route pattern: ids (anything with a digit, uuids) become :id. */
export function routePattern(path: string): string {
  return path.replace(/[?#].*$/, "").split("/").map((seg) => (/\d/.test(seg) && seg.length > 1 ? ":id" : seg)).join("/") || "/";
}

export async function hashPerson(id: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`hpf-person:${id}`)));
  return [...bytes.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ------------------------------------------------------------ the event */

const hex32 = () => crypto.randomUUID().replace(/-/g, "");
const TAG_KEY = /^[a-z_]{1,32}$/;

export async function buildEvent(r: Report) {
  const tags: Record<string, string> = { side: r.side };
  for (const [k, v] of Object.entries(r.tags)) if (TAG_KEY.test(k) && v != null && v !== "") tags[k] = scrub(v, 120);
  const frames = parseStack(r.stack);
  return {
    event_id: hex32(),
    timestamp: Date.now() / 1000,
    platform: r.side === "browser" ? "javascript" : "node",
    level: r.level ?? "error",
    logger: r.side,
    release: r.release || undefined,
    environment: r.environment || environment(),
    transaction: scrub(r.transaction, 200),
    tags,
    user: r.actorId ? { id: await hashPerson(r.actorId) } : undefined,
    exception: {
      values: [{
        type: scrub(r.type || "Error", 80),
        value: scrub(r.message),
        stacktrace: frames.length ? { frames } : undefined,
      }],
    },
    sdk: { name: "hpf.telemetry", version: "1.0.0" },
  };
}

export function envelope(event: { event_id: string }, dsn: Dsn): string {
  const header = { event_id: event.event_id, sent_at: new Date().toISOString(), dsn: dsn.dsn };
  return `${JSON.stringify(header)}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(event)}\n`;
}

/* ------------------------------------------------------------ sending */

// One isolate never floods the error tracker: the same error once a minute,
// and no more than 60 events a minute in all.
const recent = new Map<string, number>();
let minuteStart = 0;
let sentThisMinute = 0;
function allowed(fingerprint: string): boolean {
  const now = Date.now();
  if (now - minuteStart > 60_000) { minuteStart = now; sentThisMinute = 0; }
  if ((recent.get(fingerprint) ?? 0) > now - 60_000) return false;
  if (sentThisMinute >= 60) return false;
  recent.set(fingerprint, now);
  if (recent.size > 500) recent.delete(recent.keys().next().value!);
  sentThisMinute += 1;
  return true;
}

/** Sends one report; resolves true if it went. Never throws. */
export async function sendReport(r: Report): Promise<boolean> {
  const dsn = parseDsn(configuredDsn());
  if (!dsn) return false;
  if (!allowed(`${r.side}|${r.type}|${scrub(r.message, 120)}|${r.transaction}`)) return false;
  try {
    const event = await buildEvent(r);
    const res = await fetchImpl(dsn.envelopeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${dsn.publicKey}, sentry_client=hpf.telemetry/1.0.0`,
      },
      body: envelope(event, dsn),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch (err) {
    console.warn("telemetry: couldn't send:", (err as Error)?.message);
    return false;
  }
}

const pending = new Set<Promise<unknown>>();
/** Reports in the background: the reply isn't held up, and the runtime keeps the work alive. */
export function report(r: Report | Promise<Report>): void {
  const p: Promise<unknown> = Promise.resolve(r).then(sendReport).catch(() => false).finally(() => pending.delete(p));
  pending.add(p);
  // deno-lint-ignore no-explicit-any
  (globalThis as any).EdgeRuntime?.waitUntil?.(p);
}
/** Tests: wait for reports still on their way. */
export async function flushTelemetry() {
  while (pending.size) await Promise.all([...pending]);
}
