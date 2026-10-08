/* ---- staff access tokens, checked here ----
   Supabase Auth signs every access token with the project's private key
   (ES256) and publishes the matching public keys (the JWKS). Checking the
   signature here, in the function, is as strict as asking Auth each time —
   and saves a round trip on every request (docs/AUDIT.md, P1-3).

   Only a token that passes every check below is accepted here. Anything
   else — another algorithm, a key not in the set, a bad signature, an
   expired token, an unexpected issuer — is "unverified", and the caller
   asks Supabase Auth instead, so nothing that Auth would refuse gets in.
   Who the person is (role, status, school) still comes only from the
   database, never from the token. */

export type Jwk = JsonWebKey & { kid?: string };
export type AccessClaims = {
  sub: string;
  email?: string;
  exp: number;
  iat?: number;
  amr?: unknown;
  session_id?: string;
};
export type Verdict = { ok: true; claims: AccessClaims } | { ok: false; reason: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SKEW_S = 30; // allowed clock difference, seconds

function b64urlBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
}
function b64urlJson(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(new TextDecoder().decode(b64urlBytes(s)));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const imported = new Map<string, Promise<CryptoKey>>();
function publicKey(jwk: Jwk): Promise<CryptoKey> {
  const id = `${jwk.kid}|${jwk.x}|${jwk.y}`;
  let key = imported.get(id);
  if (!key) {
    key = crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true },
      { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    key.catch(() => imported.delete(id));
    imported.set(id, key);
  }
  return key;
}

/** Checks a Supabase access token against the project's public keys:
    an ES256 signature by a key in `keys`, not expired, issued by `issuer`
    for a signed-in user (aud and role "authenticated"), with a user id. */
export async function verifyAccessToken(token: string, keys: Jwk[], issuer: string, nowMs = Date.now()): Promise<Verdict> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "not a JWT" };
  const header = b64urlJson(parts[0]);
  if (!header) return { ok: false, reason: "unreadable header" };
  if (header.alg !== "ES256") return { ok: false, reason: `algorithm ${String(header.alg)}` };
  const jwk = keys.find((k) => k.kid === header.kid && k.kty === "EC" && k.crv === "P-256" && k.x && k.y);
  if (!jwk) return { ok: false, reason: "unknown key" };
  let signature: Uint8Array<ArrayBuffer>;
  try {
    signature = b64urlBytes(parts[2]);
  } catch {
    return { ok: false, reason: "unreadable signature" };
  }
  if (signature.length !== 64) return { ok: false, reason: "bad signature" };
  let good = false;
  try {
    good = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, await publicKey(jwk), signature,
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch {
    good = false;
  }
  if (!good) return { ok: false, reason: "bad signature" };
  const claims = b64urlJson(parts[1]);
  if (!claims) return { ok: false, reason: "unreadable claims" };
  const now = nowMs / 1000;
  const exp = Number(claims.exp);
  if (!Number.isFinite(exp) || exp <= now - SKEW_S) return { ok: false, reason: "expired" };
  if (claims.nbf != null && Number(claims.nbf) > now + SKEW_S) return { ok: false, reason: "not yet valid" };
  if (claims.iss !== issuer) return { ok: false, reason: "issuer" };
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes("authenticated") || claims.role !== "authenticated") return { ok: false, reason: "not a signed-in user" };
  if (typeof claims.sub !== "string" || !UUID_RE.test(claims.sub)) return { ok: false, reason: "no user id" };
  return { ok: true, claims: claims as unknown as AccessClaims };
}
