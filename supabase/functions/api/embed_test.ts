/**
 * Content shown inside the portal, and usage by topic and sub-topic.
 *
 *   cd supabase/functions/api
 *   deno test --allow-env --allow-read --config deno.json embed_test.ts
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { checkEmbeddable, cleanTopic, frameAllowed, privateHost } from "./embed.ts";
import { __setFrameFetchForTests, call, freshWorld } from "./test_world.ts";

const EDU = "tok_education_team";
const headers = (h: Record<string, string>) => new Headers(h);
/** Sites that answer from a table, keyed by host; anything else is "unreachable". */
function sites(table: Record<string, { status?: number; headers?: Record<string, string> }>) {
  const asked: string[] = [];
  __setFrameFetchForTests((input) => {
    const url = new URL(String(input));
    asked.push(url.href);
    const site = table[url.host];
    if (!site) return Promise.reject(new TypeError("unreachable"));
    return Promise.resolve(new Response("", { status: site.status ?? 200, headers: site.headers ?? {} }));
  });
  return asked;
}
const reset = () => __setFrameFetchForTests(() => Promise.resolve(new Response("", { status: 200 })));

Deno.test("what a site's headers say about being shown in the portal", () => {
  assertEquals(frameAllowed(headers({})), true, "nothing said: allowed");
  assertEquals(frameAllowed(headers({ "x-frame-options": "SAMEORIGIN" })), false, "Kenya Education Cloud says this");
  assertEquals(frameAllowed(headers({ "x-frame-options": "DENY" })), false);
  assertEquals(frameAllowed(headers({ "content-security-policy": "default-src 'self'; frame-ancestors 'self'" })), false);
  assertEquals(frameAllowed(headers({ "content-security-policy": "frame-ancestors *" })), true);
  assertEquals(frameAllowed(headers({ "content-security-policy": "frame-ancestors 'self' https://learning-portal-mu-two.vercel.app" })), true, "names the portal");
  assertEquals(frameAllowed(headers({ "content-security-policy": "frame-ancestors https://*.github.io" })), true);
  assertEquals(frameAllowed(headers({ "content-security-policy": "frame-ancestors https://other.example" })), false);
});

Deno.test("only public addresses are asked; redirects are followed and checked hop by hop", async () => {
  for (const h of ["localhost", "127.0.0.1", "10.1.2.3", "192.168.0.4", "169.254.169.254", "172.20.0.1", "[::1]", "intranet", "x.internal"]) {
    assert(privateHost(h.replace(/^\[|\]$/g, "")), h);
  }
  assert(!privateHost("lms.kec.ac.ke") && !privateHost("8.8.8.8"));
  const asked = sites({
    "lms.kec.ac.ke": { headers: { "x-frame-options": "SAMEORIGIN" } },
    "open.example": {},
    "short.example": { status: 302, headers: { location: "https://open.example/page" } },
    "sneaky.example": { status: 301, headers: { location: "http://169.254.169.254/latest/meta-data" } },
    "gone.example": { status: 404 },
  });
  assertEquals(await checkEmbeddable("https://lms.kec.ac.ke/"), false);
  assertEquals(await checkEmbeddable("https://open.example/"), true);
  assertEquals(await checkEmbeddable("https://short.example/x"), true, "followed to a site that allows it");
  assertEquals(await checkEmbeddable("https://sneaky.example/"), null, "a redirect inside the network is never followed");
  assertEquals(await checkEmbeddable("https://gone.example/"), null);
  assertEquals(await checkEmbeddable("https://nowhere.example/"), null, "no answer");
  assertEquals(await checkEmbeddable("http://localhost:8080/admin"), null);
  assertEquals(await checkEmbeddable("https://www.youtube.com/watch?v=abc"), true, "YouTube's own player");
  assert(!asked.some((u) => u.includes("169.254") || u.includes("localhost")), "never asked");
  reset();
  assertEquals(cleanTopic("  Numbers   and  operations "), "Numbers and operations");
  assertEquals(cleanTopic(""), null);
});

Deno.test("a link is asked when it's added and when it changes; topics are kept", async () => {
  const db = freshWorld();
  sites({ "lms.kec.ac.ke": { headers: { "x-frame-options": "SAMEORIGIN" } }, "open.example": {} });
  const kec = await call("POST", "/library", EDU, { title: "Kenya Education Cloud", subject: "English", type: "Reading", audience: "library",
    externalUrl: "https://lms.kec.ac.ke/", topic: " Numbers ", subtopic: "Fractions" });
  assertEquals(kec.status, 200, JSON.stringify(kec.json));
  assertEquals([kec.json.item.embeddable, kec.json.item.topic, kec.json.item.subtopic], [false, "Numbers", "Fractions"]);
  const id = kec.json.item.id;
  // Pointed at a site that allows it: asked again, and now it opens inside the portal.
  const moved = await call("PATCH", `/library/${id}`, EDU, { externalUrl: "https://open.example/lesson", subtopic: "Decimals" });
  assertEquals([moved.json.item.embeddable, moved.json.item.topic, moved.json.item.subtopic], [true, "Numbers", "Decimals"]);
  assertEquals((await call("PATCH", `/library/${id}`, EDU, { topic: "" })).json.item.topic, null, "a topic can be cleared");
  // A file has no link to ask about.
  const file = await call("POST", "/library", EDU, { title: "Worksheet", subject: "Mathematics", type: "Worksheet", audience: "library" });
  assertEquals(file.json.item.embeddable, null);
  // A link that hasn't been asked for a week is asked again when the library is read.
  const row = db.library_items.find((r) => r.id === id)!;
  row.embed_checked_at = new Date(Date.now() - 8 * 864e5).toISOString();
  sites({ "open.example": { headers: { "x-frame-options": "DENY" } } });
  await call("PATCH", `/library/${id}`, EDU, { published: true });
  const list = await call("GET", "/library", "tok_teacher");
  assertEquals(list.json.items.find((x: { id: string }) => x.id === id).embeddable, false, "the site changed its mind");
  reset();
});

Deno.test("usage by topic and sub-topic: each visit keeps the topic it was opened under", async () => {
  const db = freshWorld();
  const a = await call("POST", "/library", EDU, { title: "Fractions", subject: "Mathematics", type: "Video", audience: "library", topic: "Numbers", subtopic: "Fractions" });
  const b = await call("POST", "/library", EDU, { title: "Shapes", subject: "Mathematics", type: "Reading", audience: "library", topic: "Geometry" });
  for (const x of [a, b]) await call("PATCH", `/library/${x.json.item.id}`, EDU, { published: true });
  const open = async (id: string, token: string, seconds: number) => {
    const r = await call("POST", `/library/${id}/interactions`, token);
    assertEquals(r.status, 200, JSON.stringify(r.json));
    const row = db.library_interactions.find((x) => x.id === r.json.interaction.id)!;
    row.duration_seconds = seconds;
    return row;
  };
  const first = await open(a.json.item.id, "hpl_learnertoken", 300);
  await open(a.json.item.id, "tok_teacher", 120);
  await open(b.json.item.id, "hpl_learnertoken", 60);
  assertEquals([first.topic, first.subtopic], ["Numbers", "Fractions"], "kept on the visit");
  // Re-tagged later: the earlier visits stay under the topic they were opened under.
  await call("PATCH", `/library/${a.json.item.id}`, EDU, { topic: "Number sense" });
  const u = await call("GET", "/library/usage", EDU);
  assertEquals(u.status, 200, JSON.stringify(u.json));
  const numbers = u.json.byTopic.find((t: { topic: string }) => t.topic === "Numbers");
  assertEquals([numbers.sessions, numbers.users, numbers.totalSeconds], [2, 2, 420]);
  assertEquals(numbers.subtopics, [{ subtopic: "Fractions", sessions: 2, users: 2, totalSeconds: 420 }]);
  const geo = u.json.byTopic.find((t: { topic: string }) => t.topic === "Geometry");
  assertEquals(geo.subtopics[0].subtopic, "(no sub-topic)");
  assertEquals(u.json.byTopic[0].topic, "Numbers", "most time first");
});
