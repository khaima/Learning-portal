/**
 * Staff access tokens checked in the function (jwt.ts), against a key pair
 * made here — the same ES256 kind Supabase Auth signs with. First the
 * check itself, then through the real app: a genuine token gets in without
 * asking Auth; anything else is asked of Auth (and refused, here); who the
 * person is still comes from the database.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { type Jwk, verifyAccessToken } from "./jwt.ts";
import { __setAdminClientForTests, __setSigningKeysForTests, call, fakeAdmin, freshWorld, USERS } from "./test_world.ts";

const ISSUER = "http://localhost:54321/auth/v1"; // the test world's SUPABASE_URL + /auth/v1
const USER_ID = "6f1c2b8e-3d4a-4e5f-8a9b-0c1d2e3f4a5b";

async function keyPair(kid: string) {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const pub = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const jwk: Jwk = { kty: "EC", crv: "P-256", x: pub.x, y: pub.y, kid, alg: "ES256", use: "sig", key_ops: ["verify"] };
  return { privateKey: pair.privateKey, jwk };
}
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const part = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)));

async function sign(privateKey: CryptoKey, claims: Record<string, unknown>, header: Record<string, unknown>) {
  const body = `${part(header)}.${part(claims)}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, new TextEncoder().encode(body)));
  return `${body}.${b64url(sig)}`;
}
function claimsFor(over: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ISSUER, sub: USER_ID, aud: "authenticated", role: "authenticated", email: "jwt.person@test.org",
    iat: now, exp: now + 3600, session_id: "8e0f7d6c-5b4a-4c3d-9e2f-1a0b9c8d7e6f",
    amr: [{ method: "password", timestamp: now }], ...over,
  };
}

const auth = await keyPair("key-1");
const stranger = await keyPair("key-1"); // same key id, different key: a forgery
const genuine = (over: Record<string, unknown> = {}) => sign(auth.privateKey, claimsFor(over), { alg: "ES256", typ: "JWT", kid: "key-1" });

Deno.test("access token check: a genuine token passes, with its user id and email", async () => {
  const v = await verifyAccessToken(await genuine(), [auth.jwk], ISSUER);
  assert(v.ok);
  assertEquals(v.claims.sub, USER_ID);
  assertEquals(v.claims.email, "jwt.person@test.org");
});

Deno.test("access token check: forged, altered, expired, foreign or anonymous tokens never pass", async () => {
  const reason = async (token: string, keys = [auth.jwk]) => {
    const v = await verifyAccessToken(token, keys, ISSUER);
    return v.ok ? "passed" : v.reason;
  };
  // Signed by another key that claims the same key id.
  assertEquals(await reason(await sign(stranger.privateKey, claimsFor(), { alg: "ES256", kid: "key-1" })), "bad signature");
  // A genuine token with its claims changed afterwards.
  const [h, , s] = (await genuine()).split(".");
  assertEquals(await reason(`${h}.${part(claimsFor({ sub: "00000000-0000-4000-8000-000000000000" }))}.${s}`), "bad signature");
  assertEquals(await reason(await genuine({ exp: Math.floor(Date.now() / 1000) - 120 })), "expired");
  assertEquals(await reason(await genuine({ exp: undefined })), "expired");
  assertEquals(await reason(await genuine({ iss: "https://elsewhere.supabase.co/auth/v1" })), "issuer");
  assertEquals(await reason(await genuine({ role: "anon", aud: "anon" })), "not a signed-in user");
  assertEquals(await reason(await genuine({ role: "service_role" })), "not a signed-in user");
  assertEquals(await reason(await genuine({ sub: "not-a-user-id" })), "no user id");
  assertEquals(await reason(await genuine({ nbf: Math.floor(Date.now() / 1000) + 600 })), "not yet valid");
  // Only ES256, and only keys in the set.
  assertEquals(await reason(`${part({ alg: "none", kid: "key-1" })}.${part(claimsFor())}.`), "algorithm none");
  assertEquals(await reason(`${part({ alg: "HS256", kid: "key-1" })}.${part(claimsFor())}.c2ln`), "algorithm HS256");
  assertEquals(await reason(await genuine(), []), "unknown key");
  assertEquals(await reason(await sign(auth.privateKey, claimsFor(), { alg: "ES256", kid: "key-2" })), "unknown key");
  assertEquals(await reason("tok_admin"), "not a JWT");
  assertEquals(await reason("a.b.c"), "unreadable header");
});

/** The world, plus one staff member whose id is a real user id (the token's subject). */
function worldWithJwtPerson(status = "active") {
  const db = freshWorld();
  db.profiles.push({ id: USER_ID, role: "admin", status, full_name: "Jwt Person", email: "jwt.person@test.org", school: "", school_id: null, county: "" });
  __setSigningKeysForTests([auth.jwk]);
  return db;
}

Deno.test("API: a genuine token is accepted without asking Supabase Auth; the role still comes from the database", async () => {
  const db = worldWithJwtPerson();
  const me = await call("GET", "/me", await genuine());
  assertEquals(me.status, 200);
  assertEquals(me.json.profile.role, "admin");
  assertEquals(me.json.profile.email, "jwt.person@test.org");
  assertEquals((await call("GET", "/users", await genuine())).status, 200, "past the admin guard");
  assertEquals(db.auth_lookups ?? [], [], "Auth was never asked");
  assert(/auth;desc="local";dur=\d+, total;dur=\d+/.test(me.headers.get("server-timing") ?? ""), me.headers.get("server-timing") ?? "no Server-Timing");
  // A role in the token means nothing: the database says admin, so Super Admin pages stay shut.
  assertEquals((await call("GET", "/me", await genuine({ user_role: "super_admin", app_metadata: { role: "super_admin" } }))).json.profile.role, "admin");
});

Deno.test("API: forged and expired tokens are refused — after asking Auth, which doesn't know them either", async () => {
  const db = worldWithJwtPerson();
  const forged = await sign(stranger.privateKey, claimsFor(), { alg: "ES256", kid: "key-1" });
  assertEquals((await call("GET", "/me", forged)).status, 401);
  assertEquals((await call("GET", "/me", await genuine({ exp: Math.floor(Date.now() / 1000) - 120 }))).status, 401);
  assertEquals((db.auth_lookups ?? []).length, 2, "each one asked of Auth, not let in");
});

Deno.test("API: a suspended account with a genuine token is still refused (status comes from the database)", async () => {
  worldWithJwtPerson("suspended");
  const res = await call("GET", "/users", await genuine());
  assertEquals(res.status, 403);
  assertEquals(res.json.accountStatus, "suspended");
});

Deno.test("API: tokens Auth knows (no key here to check them) still work, by asking Auth", async () => {
  const db = freshWorld();
  __setSigningKeysForTests([]);
  assertEquals((await call("GET", "/me", "tok_admin")).status, 200);
  assertEquals((db.auth_lookups ?? []).length, 1);
});

Deno.test("API: if the scope rows can't be read, an administrator is refused — never shown everything", async () => {
  const db = freshWorld();
  const base = fakeAdmin(db, USERS);
  // deno-lint-ignore no-explicit-any
  const broken: any = new Proxy({}, {
    get: (_t, k) => k === "then" ? (ok: (v: unknown) => unknown) => ok({ data: null, error: { message: "connection reset" } }) : () => broken,
  });
  __setAdminClientForTests({ ...base, from: (t: string) => t === "staff_scopes" ? broken : base.from(t) });
  for (const path of ["/users", "/me", "/schools"]) {
    const res = await call("GET", path, "tok_admin");
    assertEquals(res.status, 503, path);
  }
});
