/**
 * The lists the pages offer and the API accepts are the same lists. The
 * pages keep their own copy in data.js (a field officer's visit form must
 * work offline, without asking the API for them); this test fails the
 * build if the two ever drift apart.
 */
import { assertEquals } from "jsr:@std/assert@1";
import { GRADES as PAGE_GRADES, VISIT_TYPES as PAGE_VISIT_TYPES } from "../../../data.js";
import { GRADES } from "./permissions.ts";
import { VISIT_TYPES } from "./intelligence.ts";

Deno.test("lists: the grades the pages offer are the grades the API accepts", () => {
  assertEquals([...PAGE_GRADES], [...GRADES]);
});

Deno.test("lists: the visit types the pages offer are the visit types the API accepts", () => {
  assertEquals([...PAGE_VISIT_TYPES], [...VISIT_TYPES]);
});
