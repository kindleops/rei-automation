// Alias-only loader for ops scripts: resolves the @/ import alias WITHOUT the
// critical-test fetch guard, so read-only production tooling (e.g.
// scripts/ops/inbound-replay-harness.mjs) can reach Supabase.
// Usage: node --import ./scripts/register-aliases-ops.mjs scripts/ops/<tool>.mjs
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./tests/alias-loader.mjs", pathToFileURL("./"));
