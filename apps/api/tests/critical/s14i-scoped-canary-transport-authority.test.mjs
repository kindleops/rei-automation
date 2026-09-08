/**
 * s14i-scoped-canary-transport-authority.test.mjs
 *
 * §11 Slice 4I. The ONE exception to the TextGrid adapter's emergency brake.
 *
 * The property under test is narrow and adversarial: a send may cross an ACTIVE
 * global emergency stop if, and only if, durable state proves it is the exact
 * send an operator authorized and the claim transaction already spent. Every
 * other send, including every manual and campaign send, still stops dead.
 *
 * The mutation that matters most: replacing durable verification with
 * `scopedCanary === true` must fail. A boolean any caller can set is a
 * description of intent, never a grant of authority.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildScopedCanaryTransportAuthority,
  bindScopedCanaryTransportAuthority,
  verifyScopedCanaryTransportAuthority,
  SCOPED_CANARY_TRANSPORT_AUTHORITY_VERSION,
  TRANSPORT_AUTHORIZED_SCOPE,
  ENQUEUE_SCOPE,
  scopeMayReachTransport,
  assertTransportAuthorityIssuable,
} from "@/lib/domain/queue/scoped-canary-transport-authority.js";
import { sendTextgridSMS } from "@/lib/providers/textgrid.js";
import { resetTextgridConfigCache } from "@/lib/config/textgrid-config.js";
import { classifyTextGridProviderError } from "@/lib/domain/messaging/textgrid-provider-error-classifier.js";
import { mapTransportOutcome } from "@/lib/domain/communications/transport-outcome-mapping.js";
import { DELIVERY_POSSIBILITY } from "@/lib/domain/communications/communication-transition-authority.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, "../../src");

const TOKEN = "operator-held-canary-secret-value";
const TOKEN_HASH = crypto.createHash("sha256").update(TOKEN, "utf8").digest("hex");

const AUTH_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "s11_slice4i_test_run";
const LEG = "outbound_effectively_once";
const CAMPAIGN = "b7c9a000-7ad3-468b-9b9b-4647dbefc35f";
const ROW = "fa38ec50-56f1-4b11-b1ae-c8f371ec9ac6";
const LOGICAL = "22222222-2222-4222-8222-222222222222";
const CONSUMED_AT = "2026-09-08T01:00:00.000Z";
const DEST = "+15550000000";
const SENDER = "+15550000001";

const CANONICAL_OK = Object.freeze({
  ok: true,
  authority: "scoped_canary_authorization",
  authority_version: "canonical_send_authority_v1",
});

function authorizationRow(overrides = {}) {
  return {
    id: AUTH_ID,
    canary_run_id: RUN_ID,
    campaign_id: CAMPAIGN,
    queue_row_ids: [ROW],
    claimed_row_ids: [ROW],
    authorization_token_hash: TOKEN_HASH,
    consumed_at: CONSUMED_AT,
    metadata: { scope: TRANSPORT_AUTHORIZED_SCOPE, canary_leg: LEG },
    ...overrides,
  };
}

function lockRow(overrides = {}) {
  return { owner_type: "scoped_canary", canary_run_id: RUN_ID, ...overrides };
}

/** Minimal supabase stub covering exactly the two reads the verifier performs. */
function fakeSupabase({
  auth = authorizationRow(), lock = lockRow(),
  authError = null, lockError = null,
  mode = "scoped_canary_only", modeError = null,
} = {}) {
  return {
    from(table) {
      let result;
      if (table === "queue_canary_authorizations") {
        result = { data: authError ? null : auth, error: authError };
      } else if (table === "system_control") {
        result = { data: modeError ? null : { value: mode }, error: modeError };
      } else {
        result = { data: lockError ? null : lock, error: lockError };
      }
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => result,
      };
      return chain;
    },
  };
}

function validFacts(overrides = {}) {
  return {
    scoped_canary: true,
    authorization_id: AUTH_ID,
    authorization_token: TOKEN,
    authorization_consumed_at: CONSUMED_AT,
    canary_run_id: RUN_ID,
    canary_leg: LEG,
    campaign_id: CAMPAIGN,
    queue_row_id: ROW,
    queue_execution_mode: "scoped_canary_only",
    ...overrides,
  };
}

function boundAuthority(factOverrides = {}, bindOverrides = {}) {
  const built = buildScopedCanaryTransportAuthority(validFacts(factOverrides));
  return bindScopedCanaryTransportAuthority(built, {
    logical_communication_id: LOGICAL,
    destination: DEST,
    queue_row_id: ROW,
    canonical_authority: CANONICAL_OK,
    ...bindOverrides,
  });
}

async function verify(authority, { supabase = null, mode = null, to = DEST, logical = LOGICAL } = {}) {
  return verifyScopedCanaryTransportAuthority(authority, {
    to,
    logical_communication_id: logical,
    supabase: supabase || fakeSupabase(mode ? { mode } : {}),
  });
}

// ══════════════════════════════════════════════════════════════════════════
// 1. THE HAPPY PATH EXISTS AT ALL
// ══════════════════════════════════════════════════════════════════════════

test("a fully evidenced scoped-canary authority is accepted", async () => {
  const verdict = await verify(boundAuthority());
  assert.equal(verdict.ok, true, `refused: ${verdict.reason}`);
  assert.equal(verdict.evidence.authorization_id, AUTH_ID);
  assert.equal(verdict.evidence.canary_leg, LEG);
  assert.equal(verdict.evidence.logical_communication_id, LOGICAL);
  // Evidence is for an audit trail and must never carry the secret.
  assert.ok(!JSON.stringify(verdict.evidence).includes(TOKEN));
  assert.ok(!JSON.stringify(verdict.evidence).includes(TOKEN_HASH));
});

// ══════════════════════════════════════════════════════════════════════════
// 2. PART 4 - A BOOLEAN IS NOT AUTHORITY
// ══════════════════════════════════════════════════════════════════════════

test("MUTATION: scopedCanary=true alone grants nothing", async () => {
  // The mutant: durable validation replaced by the caller-supplied flag.
  const mutant = { scopedCanary: true, scoped_canary: true };
  const verdict = await verify(mutant);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "transport_authority_absent");
});

test("MUTATION: a hand-rolled object shaped like an authority is rejected", async () => {
  // Correct version marker, correct field names, entirely fabricated values.
  const forged = {
    version: SCOPED_CANARY_TRANSPORT_AUTHORITY_VERSION,
    authorization_id: AUTH_ID,
    authorization_token: "guessed-not-held",
    authorization_consumed_at: CONSUMED_AT,
    canary_run_id: RUN_ID,
    canary_leg: LEG,
    campaign_id: CAMPAIGN,
    queue_row_id: ROW,
    logical_communication_id: LOGICAL,
    destination: DEST,
    canonical_authority: "scoped_canary_authorization",
  };
  const verdict = await verify(forged);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "transport_authority_token_invalid",
    "possession of the operator secret must be proven against the stored hash");
});

test("the builder refuses to mint authority without the claim's consumption proof", () => {
  assert.equal(buildScopedCanaryTransportAuthority(validFacts({ authorization_consumed_at: null })), null);
  assert.equal(buildScopedCanaryTransportAuthority(validFacts({ scoped_canary: false })), null);
  assert.equal(buildScopedCanaryTransportAuthority(validFacts({ authorization_token: "" })), null);
  assert.equal(buildScopedCanaryTransportAuthority(validFacts({ canary_leg: "" })), null);
  assert.ok(buildScopedCanaryTransportAuthority(validFacts()));
});

test("binding requires a canonical approval that something actually granted", () => {
  const built = buildScopedCanaryTransportAuthority(validFacts());
  assert.equal(bindScopedCanaryTransportAuthority(built, {
    logical_communication_id: LOGICAL, destination: DEST, queue_row_id: ROW,
  }), null, "no verdict means no authority");
  assert.equal(bindScopedCanaryTransportAuthority(built, {
    logical_communication_id: LOGICAL, destination: DEST, queue_row_id: ROW,
    canonical_authority: { ok: false, reason: "queue_emergency_stop_active" },
  }), null, "a denial must not be laundered into approval");
  assert.equal(bindScopedCanaryTransportAuthority(built, {
    logical_communication_id: LOGICAL, destination: DEST, queue_row_id: "other-row",
    canonical_authority: CANONICAL_OK,
  }), null, "an authority may not be re-pointed at another row");
  assert.equal(bindScopedCanaryTransportAuthority(built, {
    destination: DEST, queue_row_id: ROW, canonical_authority: CANONICAL_OK,
  }), null, "unbound to a communication is unbound");
});

test("an unbound authority never reaches transport", async () => {
  const unbound = buildScopedCanaryTransportAuthority(validFacts());
  const verdict = await verify(unbound);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "transport_authority_incomplete");
});

// ══════════════════════════════════════════════════════════════════════════
// 3. PART 3 - EVERY DURABLE FACT IS LOAD-BEARING
// ══════════════════════════════════════════════════════════════════════════

test("each durable fact, when wrong, refuses with its own reason", async () => {
  const cases = [
    ["authorization row absent", { supabase: fakeSupabase({ auth: null }) }, "transport_authority_authorization_not_found"],
    ["authorization read fails", { supabase: fakeSupabase({ authError: { message: "boom" } }) }, "transport_authority_read_failed"],
    ["different authorization id", { supabase: fakeSupabase({ auth: authorizationRow({ id: "33333333-3333-4333-8333-333333333333" }) }) }, "transport_authority_authorization_id_mismatch"],
    ["different campaign", { supabase: fakeSupabase({ auth: authorizationRow({ campaign_id: "44444444-4444-4444-8444-444444444444" }) }) }, "transport_authority_campaign_mismatch"],
    ["enqueue-scoped authorization", { supabase: fakeSupabase({ auth: authorizationRow({ metadata: { scope: "campaign_enqueue_target_one", canary_leg: LEG } }) }) }, "transport_authority_wrong_scope"],
    ["different canary leg", { supabase: fakeSupabase({ auth: authorizationRow({ metadata: { scope: TRANSPORT_AUTHORIZED_SCOPE, canary_leg: "inbound_reply" } }) }) }, "transport_authority_canary_leg_mismatch"],
    ["token hash mismatch", { supabase: fakeSupabase({ auth: authorizationRow({ authorization_token_hash: "deadbeef" }) }) }, "transport_authority_token_invalid"],
    ["never consumed", { supabase: fakeSupabase({ auth: authorizationRow({ consumed_at: null }) }) }, "transport_authority_not_consumed"],
    ["consumed by another execution", { supabase: fakeSupabase({ auth: authorizationRow({ consumed_at: "2026-09-08T09:99:00.000Z".replace("99", "30") }) }) }, "transport_authority_consumed_by_other_execution"],
    ["row not on the manifest", { supabase: fakeSupabase({ auth: authorizationRow({ queue_row_ids: ["someone-else"] }) }) }, "transport_authority_row_not_allowlisted"],
    ["empty manifest is not a wildcard", { supabase: fakeSupabase({ auth: authorizationRow({ queue_row_ids: [] }) }) }, "transport_authority_no_rows_authorized"],
    ["row never actually claimed", { supabase: fakeSupabase({ auth: authorizationRow({ claimed_row_ids: [] }) }) }, "transport_authority_row_not_claimed"],
    ["execution lock released", { supabase: fakeSupabase({ lock: null }) }, "transport_authority_lock_absent"],
    ["execution lock held by the runner", { supabase: fakeSupabase({ lock: lockRow({ owner_type: "unrestricted" }) }) }, "transport_authority_lock_not_scoped_canary"],
    ["execution lock held for a different run", { supabase: fakeSupabase({ lock: lockRow({ canary_run_id: "other_run" }) }) }, "transport_authority_lock_run_mismatch"],
    ["lock read fails", { supabase: fakeSupabase({ lockError: { message: "boom" } }) }, "transport_authority_lock_unreadable"],
    ["mode moved back to stopped", { mode: "stopped" }, "transport_authority_execution_mode_not_scoped_canary_only"],
    ["mode moved to normal", { mode: "normal" }, "transport_authority_execution_mode_not_scoped_canary_only"],
    ["message to a different destination", { to: "+15559999999" }, "transport_authority_destination_mismatch"],
    ["message for a different communication", { logical: "99999999-9999-4999-8999-999999999999" }, "transport_authority_logical_mismatch"],
  ];

  for (const [label, options, expected] of cases) {
    const verdict = await verify(boundAuthority(), options);
    assert.equal(verdict.ok, false, `${label}: must refuse`);
    assert.equal(verdict.reason, expected, label);
  }
});

test("no supabase client means no exception, ever", async () => {
  const verdict = await verifyScopedCanaryTransportAuthority(boundAuthority(), {
    to: DEST, logical_communication_id: LOGICAL, supabase: null,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "transport_authority_unverifiable_no_client");
});

test("an unreadable control plane denies rather than throws", async () => {
  const verdict = await verifyScopedCanaryTransportAuthority(boundAuthority(), {
    to: DEST, logical_communication_id: LOGICAL,
    supabase: fakeSupabase({ modeError: { message: "control plane down" } }),
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "transport_authority_execution_mode_unreadable");
});

// ══════════════════════════════════════════════════════════════════════════
// 4. PART 5 - NO GENERIC BYPASS EXISTS
// ══════════════════════════════════════════════════════════════════════════

test("structural: no general brake-bypass flag was introduced", () => {
  const banned = [
    "ignoreEmergencyStop", "ignore_emergency_stop",
    "bypassEmergencyStop", "bypass_emergency_stop",
    "forceThroughBrake", "force_through_brake",
    "forceSend", "force_send_through_brake",
    "skipEmergencyBrake", "disableEmergencyStop",
  ];
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) files.push(full);
    }
  })(SRC);

  // Comments are stripped first. A module that DOCUMENTS the flags it refuses
  // to provide is the opposite of a violation, and scanning prose would make
  // the honest explanation the thing that fails.
  const stripComments = (text) =>
    text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

  const hits = [];
  for (const file of files) {
    const text = stripComments(fs.readFileSync(file, "utf8"));
    for (const flag of banned) {
      if (text.includes(flag)) hits.push(`${path.relative(SRC, file)}: ${flag}`);
    }
  }
  assert.deepEqual(hits, [], "the exception is the scoped-canary mechanism, not a flag");
});

test("structural: the adapter brake is excused only via the verifier", () => {
  const adapter = fs.readFileSync(path.join(SRC, "lib/providers/textgrid.js"), "utf8");
  const start = adapter.indexOf("const runtime_brake_decision =");
  const end = adapter.indexOf("// ── System control gate", start);
  assert.ok(start > 0 && end > start);
  const region = adapter.slice(start, end);
  assert.ok(
    region.includes("verifyScopedCanaryTransportAuthority"),
    "the only path past the brake must be the durable verifier"
  );
  // No shortcut on a bare flag anywhere in the brake region.
  assert.ok(!/if\s*\(\s*scoped_?[Cc]anary\s*\)/.test(region));
  assert.ok(!/scopedCanary\s*===?\s*true/.test(region));
});

// ══════════════════════════════════════════════════════════════════════════
// 5. THE ADAPTER ITSELF, WITH THE BRAKE GENUINELY ACTIVE
// ══════════════════════════════════════════════════════════════════════════

const PROD_BRAKE = {
  queue_processor_mode: "off",
  queue_emergency_stop_at: "2026-08-18T03:18:33.928Z",
};

async function sendUnderActiveBrake({ transport_authority, supabaseClient, fetchImpl }) {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role";
  process.env.TEXTGRID_ACCOUNT_SID = "AC_test_account";
  process.env.TEXTGRID_AUTH_TOKEN = "test_token";
  resetTextgridConfigCache();
  const { primeSystemControlValue, clearSystemControlCache } =
    await import("@/lib/system-control.js");
  clearSystemControlCache();
  primeSystemControlValue("queue_processor_mode", PROD_BRAKE.queue_processor_mode);
  primeSystemControlValue("queue_emergency_stop_at", PROD_BRAKE.queue_emergency_stop_at);
  primeSystemControlValue("queue_execution_mode", "scoped_canary_only");
  if (fetchImpl) globalThis.fetch = fetchImpl;
  try {
    const result = await sendTextgridSMS({
      to: DEST,
      from: SENDER,
      body: "Hi Dana, quick question about your property.",
      bypass_system_control: true,
      logical_communication_id: LOGICAL,
      transport_authority,
      supabaseClient,
    });
    return { result, error: null };
  } catch (error) {
    return { result: null, error };
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
    resetTextgridConfigCache();
    clearSystemControlCache();
  }
}

test("adapter: an ordinary send still stops dead at an active brake", async () => {
  const { result, error } = await sendUnderActiveBrake({
    transport_authority: null,
    supabaseClient: fakeSupabase(),
  });
  assert.equal(result, null);
  assert.equal(error.local_refusal, true);
  assert.equal(error.local_refusal_reason, "queue_emergency_stop_active");
  assert.equal(error.transport_authority_reason, "transport_authority_absent");

  const outcome = mapTransportOutcome(classifyTextGridProviderError(error));
  assert.equal(outcome.delivery_possibility, DELIVERY_POSSIBILITY.DEFINITELY_NOT_SENT);
});

test("adapter: a tampered authority does NOT lift the brake", async () => {
  const { result, error } = await sendUnderActiveBrake({
    transport_authority: boundAuthority(),
    // Durable state disagrees: the row was never claimed under this manifest.
    supabaseClient: fakeSupabase({ auth: authorizationRow({ claimed_row_ids: [] }) }),
  });
  assert.equal(result, null);
  assert.equal(error.local_refusal_reason, "queue_emergency_stop_active");
  assert.equal(error.transport_authority_reason, "transport_authority_row_not_claimed");
});

test("adapter: a verified authority lifts the brake and reaches the provider", async () => {
  // Counted by URL: unrelated infrastructure reads also go through fetch in
  // this environment, and "something called fetch" is not the claim being made.
  const provider_calls = [];
  const { result, error } = await sendUnderActiveBrake({
    transport_authority: boundAuthority(),
    supabaseClient: fakeSupabase(),
    fetchImpl: async (url) => {
      const href = String(url?.url || url || "");
      if (href.includes("api.textgrid.com")) provider_calls.push(href);
      return {
        status: 201,
        ok: true,
        text: async () => JSON.stringify({ sid: "SM0123456789abcdef012345678", status: "queued" }),
      };
    },
  });
  assert.equal(error, null, `unexpected refusal: ${error?.message}`);
  assert.equal(provider_calls.length, 1, "the provider must have been called exactly once");
  assert.ok(provider_calls[0].endsWith("/Messages.json"));
  assert.equal(result.sid, "SM0123456789abcdef012345678");
  assert.equal(
    result.metadata.scoped_canary_transport_authority.authorization_id,
    AUTH_ID,
    "the excusing evidence must be recorded on the send"
  );
  assert.equal(result.metadata.brake_excused_reason, "queue_emergency_stop_active");
});

test("adapter: the exception does not weaken any other guard", async () => {
  // A verified authority plus a blank greeting is still a refusal.
  const { result, error } = await sendUnderActiveBrake({
    transport_authority: boundAuthority(),
    supabaseClient: fakeSupabase(),
    fetchImpl: async () => { throw new Error("must not reach the provider"); },
  });
  assert.ok(result || error);

  const originalEnv = { ...process.env };
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role";
  process.env.TEXTGRID_ACCOUNT_SID = "AC_test_account";
  process.env.TEXTGRID_AUTH_TOKEN = "test_token";
  resetTextgridConfigCache();
  const { primeSystemControlValue, clearSystemControlCache } = await import("@/lib/system-control.js");
  clearSystemControlCache();
  primeSystemControlValue("queue_processor_mode", "off");
  primeSystemControlValue("queue_emergency_stop_at", PROD_BRAKE.queue_emergency_stop_at);
  primeSystemControlValue("queue_execution_mode", "scoped_canary_only");
  try {
    await assert.rejects(
      sendTextgridSMS({
        to: DEST, from: SENDER,
        body: "Hello , are you open to an offer?",
        bypass_system_control: true,
        logical_communication_id: LOGICAL,
        transport_authority: boundAuthority(),
        supabaseClient: fakeSupabase(),
      }),
      (e) => e.local_refusal === true && e.local_refusal_reason === "blank_seller_greeting"
    );
  } finally {
    process.env = originalEnv;
    resetTextgridConfigCache();
    clearSystemControlCache();
  }
});

// ══════════════════════════════════════════════════════════════════════════
// 6. THE ISSUANCE CONTRACT MUST ACTUALLY BE SATISFIABLE
//
// An earlier draft required metadata.scope === "queue_run_scoped_canary", a
// literal NO minting path wrote. The verifier was airtight and completely
// unreachable: every real canary would have burned its single-use
// authorization inside the claim transaction and still been refused at the
// brake, reproducing the exact §11 Slice 4H failure this exists to fix.
// These tests exist so that can never silently return.
// ══════════════════════════════════════════════════════════════════════════

test("a dispatch authorization that declares NO scope still reaches transport", async () => {
  // This is the historical shape: authorizationMatchesRequest treats a
  // dispatch authorization as "not enqueue-scoped", and it declared no scope.
  const verdict = await verify(boundAuthority(), {
    supabase: fakeSupabase({ auth: authorizationRow({ metadata: { canary_leg: LEG } }) }),
  });
  assert.equal(verdict.ok, true, `refused: ${verdict.reason}`);
});

test("scope rule: enqueue authorizations are the ONLY disqualified scope", () => {
  assert.equal(scopeMayReachTransport(ENQUEUE_SCOPE), false);
  assert.equal(scopeMayReachTransport(""), true, "absent scope is the historical dispatch shape");
  assert.equal(scopeMayReachTransport(null), true);
  assert.equal(scopeMayReachTransport(TRANSPORT_AUTHORIZED_SCOPE), true);
  assert.equal(scopeMayReachTransport("queue_dispatch"), true);
  assert.equal(scopeMayReachTransport("something_invented"), false);
});

test("an enqueue-scoped authorization can never reach transport", async () => {
  const verdict = await verify(boundAuthority(), {
    supabase: fakeSupabase({
      auth: authorizationRow({ metadata: { scope: ENQUEUE_SCOPE, canary_leg: LEG } }),
    }),
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "transport_authority_wrong_scope");
});

test("issuability is decidable BEFORE the claim consumes anything", () => {
  assert.deepEqual(
    assertTransportAuthorityIssuable({ canary_leg: LEG, authorization_scope: null }),
    { ok: true }
  );
  assert.equal(
    assertTransportAuthorityIssuable({ canary_leg: "", authorization_scope: null }).reason,
    "authorization_missing_canary_leg",
    "a legless authorization must be refused before it is spent, not after"
  );
  assert.equal(
    assertTransportAuthorityIssuable({ canary_leg: LEG, authorization_scope: ENQUEUE_SCOPE }).reason,
    "authorization_scope_cannot_reach_transport"
  );
});

test("issuance stamps a scope and leg so the exception is reachable at all", async () => {
  const { createCanaryAuthorization } = await import("@/lib/domain/queue/queue-canary-authorization.js");
  let inserted = null;
  const supabase = {
    from: () => ({
      insert: (row) => {
        inserted = row;
        return { select: () => ({ single: async () => ({ data: { id: AUTH_ID }, error: null }) }) };
      },
    }),
  };
  await createCanaryAuthorization(supabase, {
    canary_run_id: RUN_ID, campaign_id: CAMPAIGN, queue_row_ids: [ROW],
    authorization_token: TOKEN, expires_at: "2026-09-09T00:00:00.000Z", canary_leg: LEG,
  });
  assert.equal(inserted.metadata.scope, TRANSPORT_AUTHORIZED_SCOPE);
  assert.equal(inserted.metadata.canary_leg, LEG);
  assert.equal(
    assertTransportAuthorityIssuable({
      canary_leg: inserted.metadata.canary_leg,
      authorization_scope: inserted.metadata.scope,
    }).ok,
    true,
    "what issuance mints must satisfy what transport demands"
  );

  // An explicit scope from a caller still wins, so enqueue authorizations keep theirs.
  await createCanaryAuthorization(supabase, {
    canary_run_id: RUN_ID, campaign_id: CAMPAIGN, queue_row_ids: [],
    authorization_token: TOKEN, expires_at: "2026-09-09T00:00:00.000Z",
    metadata: { scope: ENQUEUE_SCOPE },
  });
  assert.equal(inserted.metadata.scope, ENQUEUE_SCOPE);
});

// ══════════════════════════════════════════════════════════════════════════
// 7. ONE AUTHORIZATION BUYS EXACTLY ONE MESSAGE
//
// The claim RPC sets consumed_at only when the LAST row of a manifest is
// claimed, so on a multi-row manifest every earlier row carries a null
// consumption proof. Rather than let the final row alone slip through an
// active emergency stop, the whole shape is refused.
// ══════════════════════════════════════════════════════════════════════════

test("a multi-row manifest can never cross the brake", async () => {
  const verdict = await verify(boundAuthority(), {
    supabase: fakeSupabase({
      auth: authorizationRow({
        queue_row_ids: [ROW, "second-row-id"],
        claimed_row_ids: [ROW, "second-row-id"],
      }),
    }),
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "transport_authority_multi_row_manifest");
});

test("multi-row manifests are refused BEFORE anything is claimed", () => {
  assert.equal(
    assertTransportAuthorityIssuable({ canary_leg: LEG, authorization_scope: null, manifest_size: 2 }).reason,
    "transport_exception_requires_single_row_manifest"
  );
  assert.equal(
    assertTransportAuthorityIssuable({ canary_leg: LEG, authorization_scope: null, manifest_size: 0 }).reason,
    "transport_exception_requires_single_row_manifest"
  );
  assert.equal(
    assertTransportAuthorityIssuable({ canary_leg: LEG, authorization_scope: null, manifest_size: 1 }).ok,
    true
  );
});
