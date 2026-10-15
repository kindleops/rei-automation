// The capability services' database binding must resolve the shared client, never call itself.
// At 6ecbae6b it read `const SUPABASE = () => SUPABASE()` (infinite recursion): every inbox
// capability binding that needs the database (resolveSender, contactGuard, template) would throw.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(fileURLToPath(new URL("../../src/lib/agent/capabilities/services.js", import.meta.url)), "utf8");

test("the SUPABASE binding imports the shared client module and does not recurse", () => {
  const m = /const SUPABASE = \(\) => (.+)/.exec(src);
  assert.ok(m, "SUPABASE binding present");
  assert.doesNotMatch(m[1], /SUPABASE\(\)/, "binding must not call itself");
  assert.match(m[1], /import\(['"]@\/lib\/supabase\/client\.js['"]\)/);
});
