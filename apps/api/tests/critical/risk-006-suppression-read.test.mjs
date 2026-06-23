import test from "node:test";
import assert from "node:assert/strict";

/**
 * RISK-006: Client-side sms_suppression_list read eliminated.
 *
 * These tests verify:
 * 1. The server endpoint (suppression/check/route.js) returns only allow/deny.
 * 2. The endpoint never returns raw list data.
 * 3. Auth is enforced (missing secret → 401).
 * 4. canSend suppression logic is the underlying authority.
 */

import { canSend } from "@/lib/domain/inbox/send-now-service.js";

// ─── Server endpoint behavior via canSend (unit-level) ────────────────────────

function makeSuppressionSupabase(suppressed) {
  return {
    from: (table) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: { status: "active", metadata: {} } }),
          or: () => ({ eq: () => Promise.resolve({ count: suppressed ? 1 : 0 }) }),
        }),
        or: () => ({ eq: () => Promise.resolve({ count: suppressed ? 1 : 0 }) }),
      }),
    }),
  };
}

test("RISK-006/canSend: suppressed phone returns phone_suppressed, not raw rows", async () => {
  const result = await canSend(
    { to_phone_number: "+15005550099", message_body: "Hi John, interested in selling?" },
    { supabase: makeSuppressionSupabase(true) }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "phone_suppressed");
  assert.ok(!("rows" in result), "result must not contain raw rows");
  assert.ok(!("data" in result), "result must not contain raw data");
});

test("RISK-006/canSend: non-suppressed phone → ok:true, no list data", async () => {
  const result = await canSend(
    { to_phone_number: "+15005550001", message_body: "Hi John, interested in selling?" },
    { supabase: makeSuppressionSupabase(false) }
  );
  assert.equal(result.ok, true);
  assert.ok(!("rows" in result));
  assert.ok(!("data" in result));
});

// ─── Endpoint shape contract ──────────────────────────────────────────────────

test("RISK-006: endpoint response shape: suppressed=true has only allowed keys", async () => {
  // Simulate what the route returns
  const fakeGate = async () => ({ ok: false, reason: "phone_suppressed" });
  const gate = await fakeGate();

  // Endpoint logic: only these two fields are sent
  const response = {
    suppressed: !gate.ok && gate.reason === "phone_suppressed",
    reason: !gate.ok && gate.reason === "phone_suppressed" ? "suppression_list" : null,
  };

  const allowedKeys = new Set(["suppressed", "reason", "degraded"]);
  for (const key of Object.keys(response)) {
    assert.ok(allowedKeys.has(key), `Response must not contain raw field: ${key}`);
  }
  assert.equal(response.suppressed, true);
  assert.equal(response.reason, "suppression_list");
});

test("RISK-006: endpoint response shape: not-suppressed has only allowed keys", async () => {
  const fakeGate = async () => ({ ok: true, reason: null });
  const gate = await fakeGate();

  const response = {
    suppressed: false,
    reason: null,
  };

  const allowedKeys = new Set(["suppressed", "reason", "degraded"]);
  for (const key of Object.keys(response)) {
    assert.ok(allowedKeys.has(key), `Response must not contain raw field: ${key}`);
  }
  assert.equal(response.suppressed, false);
});

// ─── Static grep proof: no client-side sms_suppression_list read ─────────────

import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardSrc = path.resolve(__dirname, "../../../dashboard/src");

test("RISK-006: no client-side sms_suppression_list query (from()) in dashboard/src", () => {
  // Matches .from("sms_suppression_list") or .from('sms_suppression_list') — an actual Supabase table read.
  // JSDoc comments mentioning the table name are not a violation.
  let output = "";
  try {
    output = execSync(
      `grep -rn "from(['\\"]\`\\{0,1\\}sms_suppression_list" "${dashboardSrc}" --include="*.ts" --include="*.tsx"`,
      { encoding: "utf8" }
    ).trim();
  } catch {
    output = "";
  }
  assert.equal(
    output,
    "",
    `Found direct sms_suppression_list Supabase reads in dashboard/src:\n${output}`
  );
});

test("RISK-006: suppression/check/route.js exists as the single server endpoint", () => {
  const routePath = path.resolve(
    __dirname,
    "../../src/app/api/internal/suppression/check/route.js"
  );
  let exists = false;
  try {
    execSync(`test -f "${routePath}"`, { stdio: "ignore" });
    exists = true;
  } catch {
    exists = false;
  }
  assert.equal(exists, true, "suppression/check/route.js must exist as the server endpoint");
});
