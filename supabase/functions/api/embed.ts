/**
 * May the portal show a link's site inside its own page?
 *
 * A site decides that, not us: with X-Frame-Options, or a Content-Security-
 * Policy frame-ancestors list, it can tell every browser never to show its
 * pages inside another site. When a link is added or changed — and about
 * once a week after — the API asks the site, and the portal opens it in its
 * own viewer only if the site allows it; otherwise in a new tab. The portal
 * never copies or relays another site's pages to get round its choice.
 *
 * Only public http(s) addresses are asked (never this server's own network),
 * redirects are followed by hand so each hop is checked too, and the page
 * itself is never read — only its headers.
 */

/** Where the portal itself is served from: a frame-ancestors list naming one of these allows us. */
export const PORTAL_ORIGINS = ["https://learning-portal-mu-two.vercel.app", "https://khaima.github.io"];
const TIMEOUT_MS = 5000;

let frameFetch: typeof fetch = (input, init) => fetch(input, init);
/** Tests answer for the sites instead of the network. */
export function __setFrameFetchForTests(f: typeof fetch) { frameFetch = f; }

/** A host that isn't on the public internet (this machine, a private network, cloud metadata). */
export function privateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (!h || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || !h.includes(".") && !h.includes(":")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (h.includes(":")) return h === "::" || h === "::1" || /^f[cd]/.test(h) || h.startsWith("fe80") || h.startsWith("::ffff:");
  return false;
}

/** What a site's reply headers say about being shown in our frame. */
export function frameAllowed(headers: Headers): boolean {
  const xfo = (headers.get("x-frame-options") || "").trim().toLowerCase();
  if (xfo && xfo !== "allowall") return false; // DENY, SAMEORIGIN, ALLOW-FROM (which no browser honours any more)
  const csp = headers.get("content-security-policy") || "";
  const ancestors = csp.split(";").map((d) => d.trim()).find((d) => /^frame-ancestors(\s|$)/i.test(d));
  if (!ancestors) return true;
  const sources = ancestors.split(/\s+/).slice(1).map((s) => s.toLowerCase().replace(/\/$/, ""));
  return sources.some((s) => s === "*" || s === "https:" || PORTAL_ORIGINS.some((o) => s === o ||
    (s.startsWith("https://*.") && o.endsWith(s.slice("https://*".length)))));
}

const YOUTUBE = /^https?:\/\/(www\.|m\.)?(youtube\.com|youtu\.be|youtube-nocookie\.com)\//i;

/** true: the site lets the portal show it; false: it doesn't; null: it couldn't be asked
    (not a public address, no answer in time, an error page) — treated as "not here". */
export async function checkEmbeddable(url: string): Promise<boolean | null> {
  if (YOUTUBE.test(url)) return true; // YouTube's own player, which is made to be embedded
  let next = url;
  for (let hop = 0; hop < 4; hop++) {
    let u: URL;
    try { u = new URL(next); } catch { return null; }
    if (!/^https?:$/.test(u.protocol) || u.username || u.password || privateHost(u.hostname)) return null;
    let res: Response;
    try {
      res = await frameFetch(u.href, {
        method: "GET", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "user-agent": "HPF-Learning-Portal/1 (can this page be shown in a frame?)" },
      });
    } catch {
      return null;
    }
    try { await res.body?.cancel(); } catch { /* nothing to read anyway */ }
    const to = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && to) { next = new URL(to, u).href; continue; }
    if (!res.ok) return null;
    return frameAllowed(res.headers);
  }
  return null;
}

/** A topic or sub-topic as typed: trimmed, at most 120 characters, or null. */
export const cleanTopic = (v: unknown): string | null => (v == null ? null : String(v).trim().replace(/\s+/g, " ").slice(0, 120) || null);
