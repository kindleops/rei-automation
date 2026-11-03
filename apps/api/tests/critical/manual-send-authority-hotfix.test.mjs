/**
 * manual-send-authority-hotfix.test.mjs
 *
 * P0 (2026-11-02): an authenticated operator reply from the Inbox composer was
 * refused in production with HTTP 423 queue_emergency_stop_active, because the
 * one brake that stops campaign/queue automation also stopped the human. The
 * only thing that had ever let a manual send through was an adapter excuse keyed
 * on request metadata (source === "manual_inbox"), which any caller could write.
 *
 * This file pins the separated control model:
 *
 *   automation (AI, campaign, queue)  -> queue_emergency_stop_at / processor / execution mode (UNCHANGED)
 *   authenticated human manual SMS    -> manual_send_mode=enabled + a SERVER-SIDE operator principal
 *   true global shutdown              -> global_send_shutdown_at denies BOTH
 *
 * and the adversarial half: nothing a request can carry manufactures a principal,
 * the adapter no longer excuses the brake on metadata, compliance still blocks,
 * duplicates still collapse to one provider call, and failures are recorded as
 * failures.
 */

import "../helpers/critical-test-environment.mjs";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  evaluateManualSendAuthority,
  isAuthenticatedOperatorPrincipal,
  isManualSendAuthorityVerdict,
  normalizeManualSendMode,
  MANUAL_SEND_AUTHORITY,
  MANUAL_SEND_AUTHORITY_VERSION,
  MANUAL_SEND_CONTROL_KEYS,
} from "@/lib/domain/queue/manual-send-authority.js";
import {
  evaluateCanonicalSendAuthority,
  REQUIRED_CONTROL_KEYS,
} from "@/lib/domain/queue/canonical-send-authority.js";
import { OPERATOR_OWNED_SYSTEM_KEYS, assertNoOperatorOwnedSystemKeys } from "@/lib/domain/queue/operator-brake-authority.js";
import { evaluateQueueSendRuntimeBrakes } from "@/lib/domain/queue/queue-control-safety.js";
import { executeManualInboxSendNow } from "@/lib/domain/inbox/send-now-service.js";
import { drainPostSendProjections } from "@/lib/domain/inbox/post-send-projection.js";
import { processSendQueueItem } from "@/lib/domain/queue/process-send-queue.js";
import { dispatchManualOperatorSend } from "@/lib/domain/communications/dispatch-manual-operator-send.js";
import { evaluateTextgridRuntimeBrakeForSend, sendTextgridSMS } from "@/lib/providers/textgrid.js";
import { resetTextgridConfigCache } from "@/lib/config/textgrid-config.js";
import { ensureMutationAuth, resolveOperatorPrincipal } from "../../src/app/api/cockpit/_shared.js";
import { createMemoryS11Store } from "../helpers/s11-memory-store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, "../../src");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

// ── fixtures ─────────────────────────────────────────────────────────────────

const EMERGENCY_AT = "2026-10-31T12:00:00.000Z";
const SHUTDOWN_AT = "2026-11-02T00:00:00.000Z";
const THREAD = "+15005550006";
const FROM = "+15005550001";

/** What the server's auth layer mints for a verified ops-dashboard session. */
const OPERATOR = Object.freeze({
  kind: "ops_dashboard_operator",
  authenticated: true,
  auth_source: "ops_dashboard_session",
  via: "header:x-ops-dashboard-secret",
  id: "11111111-1111-4111-8111-111111111111",
  email: null,
});

/** Production posture at the incident: automation fully stopped, operator sends enabled. */
const AUTOMATION_STOPPED_MANUAL_ENABLED = Object.freeze({
  queue_emergency_stop_at: EMERGENCY_AT,
  queue_processor_mode: "off",
  queue_execution_mode: "stopped",
  campaign_mode: "paused",
  manual_send_mode: "enabled",
  global_send_shutdown_at: null,
});

/** Automation healthy (what the canonical authority needs to permit). */
const AUTOMATION_HEALTHY = Object.freeze({
  queue_emergency_stop_at: null,
  queue_processor_mode: "live",
  queue_execution_mode: "normal",
  campaign_mode: "live_limited",
  manual_send_mode: "enabled",
  global_send_shutdown_at: null,
});

const controlPlane = (values) => async (key) =>
  Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;

const PAYLOAD = Object.freeze({
  thread_key: THREAD,
  to_phone_number: THREAD,
  from_phone_number: FROM,
  message_body: "Operator reply typed in the composer",
  queue_key: "inbox:send_now:hotfix-proof",
  source: "manual_inbox",
  action: "send_now",
});

/** Claimable send_queue + suppression list (empty or opted-out) for the final guard. */
function makeClaimableSupabase(queue_row, { suppressed = false } = {}) {
  const rows = new Map([[String(queue_row.id), { ...queue_row }]]);
  const calls = { updates: 0 };
  const suppression = suppressed
    ? [{ id: "sup-hotfix", suppression_reason: "opt_out", is_active: true }]
    : [];
  const suppressionTail = { limit: async () => ({ data: suppression, error: null, count: suppression.length }) };
  return {
    rows,
    calls,
    from(table) {
      if (table === "send_queue") {
        return {
          select() {
            return {
              eq(_col, val) {
                return { maybeSingle: async () => ({ data: rows.get(String(val)) || null, error: null }) };
              },
            };
          },
          update(patch) {
            calls.updates += 1;
            const apply = async (id) => {
              const row = rows.get(String(id));
              if (!row) return { data: null, error: null };
              Object.assign(row, patch);
              if (patch.metadata) row.metadata = { ...(row.metadata || {}), ...patch.metadata };
              return { data: row, error: null };
            };
            return {
              eq(_col, val) {
                return {
                  in(_col2, statuses) {
                    return {
                      select() {
                        return {
                          maybeSingle: async () => {
                            const row = rows.get(String(val));
                            if (!row || !statuses.includes(row.queue_status)) return { data: null, error: null };
                            return { data: (await apply(val)).data, error: null };
                          },
                        };
                      },
                    };
                  },
                  then(resolve, reject) {
                    return apply(val).then(resolve, reject);
                  },
                };
              },
            };
          },
        };
      }
      if (table === "sms_suppression_list") {
        return {
          select: () => ({
            eq: () => ({ or: () => ({ eq: () => suppressionTail }) }),
            or: () => ({ eq: () => suppressionTail }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null }),
            or: () => ({ eq: () => Promise.resolve({ count: 0 }) }),
          }),
          or: () => ({ eq: () => Promise.resolve({ count: 0 }) }),
        }),
      };
    },
  };
}

/**
 * A full manual-send harness: §11 memory store, a stable operator action, a
 * claimable queue row, and spies on the provider + bookkeeping. `operator` is
 * passed only when a test says so; it is never inside the payload.
 */
function makeHarness({
  queue_row_id = "hotfix-row-1",
  suppressed = false,
  values = AUTOMATION_STOPPED_MANUAL_ENABLED,
  provider = null,
  store = createMemoryS11Store(),
  action_id = "op-action-hotfix-1",
  overrides = {},
} = {}) {
  const events = [];
  const provider_args = [];
  const supabase = makeClaimableSupabase(
    {
      id: queue_row_id,
      thread_key: THREAD,
      to_phone_number: THREAD,
      from_phone_number: FROM,
      queue_status: "queued",
      message_body: PAYLOAD.message_body,
      metadata: { source: "manual_inbox", manual_operator_send: true },
    },
    { suppressed }
  );
  const deps = {
    store,
    resolveOperatorAction: async () => ({ ok: true, operator_action_id: action_id, reused: false }),
    supabase,
    getSystemValue: controlPlane(values),
    createQueueRowImpl: async (input) => ({
      ok: true,
      queue_row_id,
      queue_id: queue_row_id,
      queue_key: input.queue_key,
      result: { raw: { metadata: input.metadata } },
    }),
    sendTextgridImpl: async (args) => {
      provider_args.push(args);
      events.push("provider");
      if (provider) return provider(args);
      return { ok: true, sid: "SMhotfix1", provider_message_id: "SMhotfix1" };
    },
    finalizeSendQueueSuccessImpl: async (row) => {
      events.push("finalize");
      return { ...row, queue_status: "sent", provider_message_id: "SMhotfix1" };
    },
    writeOutboundSuccessMessageEventImpl: async () => {
      events.push("message_event");
      return { id: "evt-hotfix-1" };
    },
    promoteFirstContactOnProviderAcceptance: async () => ({ ok: true, promoted: false, reason: "test" }),
    finalizeSendQueueFailureImpl: async (row) => {
      events.push("finalize_failure");
      return { ...row, queue_status: "failed" };
    },
    writeOutboundFailureMessageEventImpl: async () => {
      events.push("failure_event");
      return null;
    },
    ...overrides,
  };
  return { deps, events, provider_args, supabase, store };
}

afterEach(async () => {
  await drainPostSendProjections();
});

// ═════════════════════════════════════════════════════════════════════════════
// 1 + 9. THE FIX: an authenticated manual send under an active emergency stop
// ═════════════════════════════════════════════════════════════════════════════

test("1. an authenticated manual send is AUTHORIZED under an active queue emergency stop and reaches the provider", async () => {
  const h = makeHarness();
  const result = await executeManualInboxSendNow(PAYLOAD, { ...h.deps, operator: OPERATOR });

  assert.equal(result.ok, true, `expected success, got ${result.reason}`);
  assert.equal(result.status, 200);
  assert.equal(result.queue_status, "sent");
  assert.equal(result.provider_message_id, "SMhotfix1");
  assert.equal(h.provider_args.length, 1, "the provider is called exactly once");

  // Transport received the ISSUED verdict, not a flag, not metadata.
  const verdict = h.provider_args[0].send_authority;
  assert.equal(isManualSendAuthorityVerdict(verdict), true);
  assert.equal(verdict.authority, MANUAL_SEND_AUTHORITY);
  assert.equal(verdict.operator.id, OPERATOR.id);

  // The authority is durable on the claimed row.
  const row = h.supabase.rows.get("hotfix-row-1");
  assert.equal(row.metadata.send_authority, "manual_operator");
  assert.equal(row.metadata.send_authority_version, MANUAL_SEND_AUTHORITY_VERSION);
  assert.equal(row.metadata.operator_id, OPERATOR.id);
});

test("9. a successful manual send produces the provider result AND the outbound message event, in order", async () => {
  const h = makeHarness();
  const result = await executeManualInboxSendNow(PAYLOAD, { ...h.deps, operator: OPERATOR });
  await drainPostSendProjections();

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.message_event_id, "evt-hotfix-1");
  assert.deepEqual(h.events.slice(0, 3), ["provider", "finalize", "message_event"]);
  assert.ok(!h.events.includes("failure_event"));
  assert.ok(!h.events.includes("finalize_failure"));
});

// ═════════════════════════════════════════════════════════════════════════════
// 2 + 3. AUTOMATION IS UNCHANGED: the stop still stops AI, campaign and queue
// ═════════════════════════════════════════════════════════════════════════════

test("2. AI / canonical automation stays denied by the emergency stop, processor off and scoped_canary_only", async () => {
  // manual_send_mode=enabled is irrelevant to automation: the canonical authority never reads it.
  const stopped = await evaluateCanonicalSendAuthority({ getSystemValue: controlPlane(AUTOMATION_STOPPED_MANUAL_ENABLED), action: "ai_reply" });
  assert.equal(stopped.ok, false);
  assert.equal(stopped.reason, "queue_emergency_stop_active");

  const off = await evaluateCanonicalSendAuthority({
    getSystemValue: controlPlane({ ...AUTOMATION_HEALTHY, queue_processor_mode: "off" }),
  });
  assert.equal(off.ok, false);
  assert.equal(off.reason, "queue_processor_paused");

  const canary_only = await evaluateCanonicalSendAuthority({
    getSystemValue: controlPlane({ ...AUTOMATION_HEALTHY, queue_execution_mode: "scoped_canary_only" }),
  });
  assert.equal(canary_only.ok, false);
  assert.equal(canary_only.reason, "queue_execution_mode_scoped_canary_only");

  // The same service, WITHOUT a server principal (internal route, agent
  // approval, workflow), is still automation and still stops dead.
  const h = makeHarness();
  const result = await executeManualInboxSendNow(PAYLOAD, h.deps);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "queue_emergency_stop_active");
  assert.equal(result.provider_attempted, false);
  assert.equal(h.provider_args.length, 0);
  assert.equal(h.supabase.calls.updates, 0, "no claim under the brake");
});

test("3. processSendQueueItem (campaign/queue processing) stays denied under the stop, manual_send_mode notwithstanding", async () => {
  let provider_calls = 0;
  const row = {
    id: "queue-row-hotfix-3",
    queue_status: "queued",
    thread_key: THREAD,
    to_phone_number: THREAD,
    from_phone_number: FROM,
    message_body: "campaign touch",
    metadata: {},
  };
  const result = await processSendQueueItem(row, {
    getSystemValue: controlPlane(AUTOMATION_STOPPED_MANUAL_ENABLED),
    supabaseClient: { from() { throw new Error("must not touch the database under the brake"); } },
    sendTextgridSMS: async () => { provider_calls += 1; return { sid: "SMnope" }; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "queue_emergency_stop_active");
  assert.equal(provider_calls, 0);
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. TRUE GLOBAL SHUTDOWN: one key denies BOTH
// ═════════════════════════════════════════════════════════════════════════════

test("4. global_send_shutdown_at denies the manual authority, the canonical authority, the service and the queue processor", async () => {
  const shutdown = { ...AUTOMATION_HEALTHY, global_send_shutdown_at: SHUTDOWN_AT };

  const manual = await evaluateManualSendAuthority({ getSystemValue: controlPlane(shutdown), operator: OPERATOR });
  assert.equal(manual.ok, false);
  assert.equal(manual.reason, "global_send_shutdown_active");
  assert.equal(manual.status, 423);

  const canonical = await evaluateCanonicalSendAuthority({ getSystemValue: controlPlane(shutdown) });
  assert.equal(canonical.ok, false);
  assert.equal(canonical.reason, "global_send_shutdown_active");
  assert.ok(REQUIRED_CONTROL_KEYS.includes("global_send_shutdown_at"));

  const h = makeHarness({ values: shutdown });
  const result = await executeManualInboxSendNow(PAYLOAD, { ...h.deps, operator: OPERATOR });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "global_send_shutdown_active");
  assert.equal(result.status, 423);
  assert.equal(h.provider_args.length, 0);
  assert.equal(h.supabase.calls.updates, 0);

  const queued = await processSendQueueItem(
    { id: "queue-row-hotfix-4", queue_status: "queued", to_phone_number: THREAD, from_phone_number: FROM, message_body: "x", metadata: {} },
    { getSystemValue: controlPlane(shutdown), supabaseClient: { from() { throw new Error("no db under shutdown"); } }, sendTextgridSMS: async () => { throw new Error("no provider under shutdown"); } }
  );
  assert.equal(queued.ok, false);
  assert.equal(queued.reason, "global_send_shutdown_active");

  // The same truthiness rule as the emergency stop: clear markers are clear.
  for (const cleared of ["", "0", "false", "off", "none", "null", "cleared", "clear", null, undefined]) {
    const r = await evaluateManualSendAuthority({ getSystemValue: controlPlane({ ...AUTOMATION_STOPPED_MANUAL_ENABLED, global_send_shutdown_at: cleared }), operator: OPERATOR });
    assert.equal(r.ok, true, `global_send_shutdown_at=${JSON.stringify(cleared)} must be clear`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. AUTHORITY IS NOT PERMISSION: compliance still blocks the operator
// ═════════════════════════════════════════════════════════════════════════════

test("5. a suppressed / opted-out seller is still blocked on the manual path even with authority", async () => {
  const h = makeHarness({ suppressed: true });
  const result = await executeManualInboxSendNow(PAYLOAD, { ...h.deps, operator: OPERATOR });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "compliance_blocked_at_send_time");
  assert.equal(result.hard_block, true);
  assert.equal(result.status, 423);
  assert.equal(h.provider_args.length, 0, "an opted-out seller never reaches the provider");

  // And at enqueue time (opt-out known before any row exists): the REAL queue
  // row creator runs its hard compliance check before any insert.
  const h2 = makeHarness({
    overrides: {
      createQueueRowImpl: undefined,
      hardComplianceCheckImpl: async () => ({ blocked: true, reason: "opt_out" }),
      loadOutboundNumberByPhone: async (phone) => ({ id: "fleet-hotfix", phone_number: phone, status: "active", health_state: "unverified", daily_limit: 800, messages_sent_today: 0 }),
      insertImpl: async () => { throw new Error("no row may be inserted for an opted-out seller"); },
    },
  });
  const r2 = await executeManualInboxSendNow(PAYLOAD, { ...h2.deps, operator: OPERATOR });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, "compliance_blocked");
  assert.equal(r2.detail_reason, "opt_out");
  assert.equal(r2.queue_inserted, false);
  assert.equal(h2.provider_args.length, 0);
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. NOTHING IN A REQUEST MANUFACTURES A PRINCIPAL
// ═════════════════════════════════════════════════════════════════════════════

test("6a. request fields cannot manufacture a manual principal: without deps.operator the stop denies", async () => {
  const forged = [
    { source: "manual_inbox" },
    { send_source: "manual_inbox" },
    { manual_operator_send: true },
    { metadata: { source: "manual_inbox", send_source: "manual_inbox", manual_operator_send: true } },
    { operator_email: "ryan@reivesti.com" },
    { operator: OPERATOR },                                           // a principal-shaped body field
    { send_authority: { ok: true, authority: "manual_operator" } },  // a verdict-shaped body field
    { headers: { "x-ops-user-id": OPERATOR.id } },
    { created_from: "leadcommand_inbox", action: "send_now", send_source: "map_command" },
  ];
  for (const extra of forged) {
    const h = makeHarness();
    const result = await executeManualInboxSendNow({ ...PAYLOAD, ...extra }, h.deps);
    assert.equal(result.ok, false, JSON.stringify(extra));
    assert.equal(result.reason, "queue_emergency_stop_active", JSON.stringify(extra));
    assert.equal(h.provider_args.length, 0, JSON.stringify(extra));
    assert.equal(h.supabase.calls.updates, 0, JSON.stringify(extra));
  }
});

test("6b. the manual authority refuses anything that is not a server-minted principal", async () => {
  const not_principals = [
    null, undefined, "operator", true, 42, [],
    {},
    { authenticated: "true", auth_source: "ops_dashboard_session", via: "header:x-ops-dashboard-secret" }, // string, not boolean
    { authenticated: true },                                                                              // no auth source / via
    { authenticated: true, auth_source: "ops_dashboard_session" },                                        // no via
    { authenticated: true, via: "header:x-ops-dashboard-secret" },                                        // no auth source
    { id: OPERATOR.id, email: "ryan@reivesti.com" },                                                      // identity without authentication
    { ...OPERATOR, authenticated: false },
  ];
  for (const operator of not_principals) {
    assert.equal(isAuthenticatedOperatorPrincipal(operator), false, JSON.stringify(operator));
    const r = await evaluateManualSendAuthority({ getSystemValue: controlPlane(AUTOMATION_STOPPED_MANUAL_ENABLED), operator });
    assert.equal(r.ok, false, JSON.stringify(operator));
    assert.equal(r.reason, "manual_send_requires_authenticated_operator", JSON.stringify(operator));
    assert.equal(r.status, 423);
  }
  // Presenting an invalid principal does NOT fall back to the automation
  // authority either: it is refused on its own terms.
  const h = makeHarness({ values: AUTOMATION_HEALTHY });
  const result = await executeManualInboxSendNow(PAYLOAD, { ...h.deps, operator: { id: "someone", email: "x@y.z" } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "manual_send_requires_authenticated_operator");
  assert.equal(h.provider_args.length, 0);
});

test("6c. the principal is minted only by the auth layer, from the verified session, never from the body", () => {
  const request = (headers = {}, cookies = {}) => ({
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    cookies: { get: (name) => (cookies[name] ? { value: cookies[name] } : undefined) },
    url: "https://api.example/api/cockpit/inbox/send-now",
  });

  // OPS_DASHBOARD_SECRET=test in the critical environment (package.json test:critical).
  const good = ensureMutationAuth(request({ "x-ops-dashboard-secret": "test", "x-ops-user-id": OPERATOR.id }));
  assert.equal(good.ok, true);
  assert.equal(isAuthenticatedOperatorPrincipal(good.operator), true);
  assert.equal(good.operator.id, OPERATOR.id);
  assert.equal(good.operator.via, "header:x-ops-dashboard-secret");
  assert.equal(Object.isFrozen(good.operator), true);

  // Without the Worker-stamped id the principal still exists (the session is
  // what was verified); the id is provenance, never authority.
  const anon = ensureMutationAuth(request({ "x-ops-dashboard-secret": "test" }));
  assert.equal(anon.ok, true);
  assert.equal(isAuthenticatedOperatorPrincipal(anon.operator), true);
  assert.equal(anon.operator.id, null);

  // A wrong secret yields no principal and no access, whatever else is sent.
  const bad = ensureMutationAuth(request({ "x-ops-dashboard-secret": "wrong", "x-ops-user-id": OPERATOR.id }));
  assert.equal(bad.ok, false);
  assert.equal(bad.operator, null);

  // An unauthenticated-but-permitted dev session (no secret configured) is not a principal.
  assert.equal(resolveOperatorPrincipal(request(), { ok: true, authenticated: false, via: null }), null);
  assert.equal(resolveOperatorPrincipal(request(), { ok: true, authenticated: true, via: "" }), null);
  assert.equal(resolveOperatorPrincipal(request(), null), null);

  // Structural: the route hands the AUTH LAYER's principal to runInboxAction,
  // never a payload field, and runInboxAction forwards its own argument only.
  const route = read("app/api/cockpit/inbox/send-now/route.js");
  assert.match(route, /const operator = auth\.operator/);
  assert.match(route, /runInboxAction\(\{ action: 'send-now', payload: \{ \.\.\.payload, dry_run: false \}, operator \}\)/);
  assert.ok(!/operator:\s*payload/.test(route));
  const service = read("lib/cockpit/cockpit-service.js");
  assert.match(service, /operator = null,/);
  assert.match(service, /\{ supabase, operator \}/);
  const service_code = service.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  // (payload.operator_override is a pre-existing, unrelated intent flag.)
  assert.ok(!/payload\.operator(?![A-Za-z0-9_])/.test(service_code), "runInboxAction must never read payload.operator");
  // The send service discards body copies of the server concepts before use.
  const send_now = read("lib/domain/inbox/send-now-service.js");
  assert.match(send_now, /operator: _client_operator_ignored, send_authority: _client_verdict_ignored/);
  assert.match(send_now, /const operator = deps\.operator \?\? null/);
  // The agent approval path passes no principal: it stays automation.
  const agent = read("lib/agent/capabilities/services.js");
  assert.ok(!/operator/.test(agent.split("runInboxAction({ action: 'send-now'")[1]?.split(")")[0] || ""));
});

test("6d. the textgrid adapter no longer excuses the brake on metadata, and only an ISSUED verdict counts", async () => {
  const brake = evaluateQueueSendRuntimeBrakes(
    { queue_processor_mode: "off", queue_emergency_stop_at: EMERGENCY_AT },
    { action: "sendTextgridSMS", failClosed: false }
  );
  assert.equal(brake.ok, false);
  for (const context of [
    {},
    { source: "manual_inbox" },
    { send_source: "manual_inbox" },
    { manual_operator_send: true },
    { metadata: { source: "manual_inbox", send_source: "manual_inbox", manual_operator_send: true } },
    { source: "map_command", manual_operator_send: "true", metadata: { manual_operator_send: "1" } },
  ]) {
    const decision = evaluateTextgridRuntimeBrakeForSend(brake, context);
    assert.equal(decision.ok, false, JSON.stringify(context));
    assert.equal(decision.blocked, true, JSON.stringify(context));
    assert.equal(decision.reason, "queue_emergency_stop_active", JSON.stringify(context));
    assert.ok(!("bypassed_queue_emergency_stop_for_manual_send" in decision));
  }

  // A verdict-shaped object from anywhere but the authority is not a verdict.
  const forged = { ok: true, authority: MANUAL_SEND_AUTHORITY, authority_version: MANUAL_SEND_AUTHORITY_VERSION, operator: { id: OPERATOR.id } };
  assert.equal(isManualSendAuthorityVerdict(forged), false);
  assert.equal(isManualSendAuthorityVerdict(Object.freeze(forged)), false);
  const genuine = await evaluateManualSendAuthority({ getSystemValue: controlPlane(AUTOMATION_STOPPED_MANUAL_ENABLED), operator: OPERATOR });
  assert.equal(isManualSendAuthorityVerdict(genuine), true);
  assert.equal(isManualSendAuthorityVerdict({ ...genuine }), false, "a copy is not the issued verdict");
  const denied = await evaluateManualSendAuthority({ getSystemValue: controlPlane({}), operator: OPERATOR });
  assert.equal(isManualSendAuthorityVerdict(denied), false);

  // Structural: the metadata exemption is gone from the adapter.
  const adapter = read("lib/providers/textgrid.js");
  for (const gone of ["isManualInboxSendContext", "shouldBypassTextgridRuntimeBrakeForManualSend", "bypassed_queue_emergency_stop_for_manual_send"]) {
    assert.ok(!adapter.includes(gone), `${gone} must no longer exist in the adapter`);
  }
  assert.match(adapter, /isManualSendAuthorityVerdict\(send_authority\)/);
  assert.match(adapter, /global_send_shutdown_active/);
});

// ── 6e. the adapter itself, under a stub Supabase config and an ACTIVE brake ──

async function sendThroughAdapter({ send_authority = null, metadata = null, source = null, manual_operator_send = false, values = {} }) {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role";
  process.env.TEXTGRID_ACCOUNT_SID = "AC_test_account";
  process.env.TEXTGRID_AUTH_TOKEN = "test_token";
  resetTextgridConfigCache();
  const { primeSystemControlValue, primeSystemControlCache, clearSystemControlCache } = await import("@/lib/system-control.js");
  clearSystemControlCache();
  const control = {
    queue_processor_mode: "off",
    queue_emergency_stop_at: EMERGENCY_AT,
    queue_execution_mode: "stopped",
    global_send_shutdown_at: "",
    manual_send_mode: "enabled",
    ...values,
  };
  for (const [key, value] of Object.entries(control)) primeSystemControlValue(key, value);
  primeSystemControlCache("outbound_sms_enabled", true);
  const provider_calls = [];
  globalThis.fetch = async (url) => {
    const href = String(url?.url || url || "");
    if (href.includes("api.textgrid.com")) provider_calls.push(href);
    else throw new Error(`unexpected fetch in adapter proof: ${href}`);
    return { status: 201, ok: true, text: async () => JSON.stringify({ sid: "SMadapterproof1", status: "queued" }) };
  };
  try {
    const result = await sendTextgridSMS({
      to: THREAD, from: FROM, body: "Hi Dana, following up on your property.",
      bypass_system_control: true,
      source, manual_operator_send, metadata,
      send_authority,
    });
    return { result, error: null, provider_calls };
  } catch (error) {
    return { result: null, error, provider_calls };
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
    resetTextgridConfigCache();
    clearSystemControlCache();
  }
}

test("6e. adapter: an issued manual verdict crosses the automation brake; metadata and forged verdicts do not; global shutdown stops all", async () => {
  const genuine = await evaluateManualSendAuthority({ getSystemValue: controlPlane(AUTOMATION_STOPPED_MANUAL_ENABLED), operator: OPERATOR });
  assert.equal(genuine.ok, true);

  const ok = await sendThroughAdapter({ send_authority: genuine });
  assert.equal(ok.error, null, `unexpected refusal: ${ok.error?.message}`);
  assert.equal(ok.provider_calls.length, 1);
  assert.equal(ok.result.sid, "SMadapterproof1");
  assert.equal(ok.result.metadata.send_authority, "manual_operator", "the authority is recorded on the send");
  assert.equal(ok.result.metadata.send_authority_version, MANUAL_SEND_AUTHORITY_VERSION);
  assert.equal(ok.result.metadata.operator_id, OPERATOR.id);

  const claimed = await sendThroughAdapter({ source: "manual_inbox", manual_operator_send: true, metadata: { source: "manual_inbox", manual_operator_send: true } });
  assert.equal(claimed.result, null);
  assert.equal(claimed.error.local_refusal, true);
  assert.equal(claimed.error.local_refusal_reason, "queue_emergency_stop_active");
  assert.equal(claimed.provider_calls.length, 0);

  const forged = await sendThroughAdapter({ send_authority: { ...genuine } });
  assert.equal(forged.result, null);
  assert.equal(forged.error.local_refusal_reason, "queue_emergency_stop_active");
  assert.equal(forged.provider_calls.length, 0);

  const shutdown_manual = await sendThroughAdapter({ send_authority: genuine, values: { global_send_shutdown_at: SHUTDOWN_AT } });
  assert.equal(shutdown_manual.result, null);
  assert.equal(shutdown_manual.error.local_refusal, true);
  assert.equal(shutdown_manual.error.local_refusal_reason, "global_send_shutdown_active");
  assert.equal(shutdown_manual.provider_calls.length, 0);

  const shutdown_automation = await sendThroughAdapter({
    values: { queue_processor_mode: "live", queue_emergency_stop_at: "", queue_execution_mode: "normal", global_send_shutdown_at: SHUTDOWN_AT },
  });
  assert.equal(shutdown_automation.result, null);
  assert.equal(shutdown_automation.error.local_refusal_reason, "global_send_shutdown_active");
  assert.equal(shutdown_automation.provider_calls.length, 0);

  // Without a verdict and without a brake: exactly today's behaviour.
  const plain = await sendThroughAdapter({ values: { queue_processor_mode: "live", queue_emergency_stop_at: "", queue_execution_mode: "normal" } });
  assert.equal(plain.error, null, plain.error?.message);
  assert.equal(plain.provider_calls.length, 1);
  assert.equal(plain.result.metadata.send_authority, undefined);
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. DUPLICATES: one operator action, one provider call
// ═════════════════════════════════════════════════════════════════════════════

test("7a. two dispatches with the same operator_action_id send once (the §11 seam, manual authority)", async () => {
  const store = createMemoryS11Store();
  let count = 0;
  const sendProvider = async () => { count += 1; return { sid: `SM_${count}` }; };
  const common = {
    operator_action_id: "op-double-click-1",
    store,
    operator: OPERATOR,
    getSystemValue: controlPlane(AUTOMATION_STOPPED_MANUAL_ENABLED),
    sendProvider,
    message: { to: THREAD, from: FROM, body: "One reply, please." },
  };
  const first = await dispatchManualOperatorSend(common);
  assert.equal(first.provider_invoked, true);
  assert.equal(first.send_authority, "manual_operator");
  const second = await dispatchManualOperatorSend(common);
  assert.equal(second.provider_invoked, false, `second dispatch must not reach the provider (${second.reason})`);
  assert.equal(count, 1);

  // A truly concurrent double-click collapses the same way.
  const store2 = createMemoryS11Store();
  let count2 = 0;
  const race = { ...common, store: store2, operator_action_id: "op-double-click-2", sendProvider: async () => { count2 += 1; await new Promise((r) => setTimeout(r, 5)); return { sid: `SM_r${count2}` }; } };
  const [a, b] = await Promise.all([dispatchManualOperatorSend(race), dispatchManualOperatorSend(race)]);
  assert.equal([a, b].filter((r) => r.provider_invoked).length, 1);
  assert.equal(count2, 1);
});

test("7b. a double-click through executeManualInboxSendNow produces one provider call", async () => {
  const store = createMemoryS11Store();
  let count = 0;
  const provider = async () => { count += 1; return { ok: true, sid: `SMdc_${count}`, provider_message_id: `SMdc_${count}` }; };
  const h1 = makeHarness({ store, provider, queue_row_id: "dc-row-1", action_id: "op-dc-e2e" });
  const h2 = makeHarness({ store, provider, queue_row_id: "dc-row-2", action_id: "op-dc-e2e" });
  const first = await executeManualInboxSendNow(PAYLOAD, { ...h1.deps, operator: OPERATOR });
  assert.equal(first.ok, true, first.reason);
  const second = await executeManualInboxSendNow(PAYLOAD, { ...h2.deps, operator: OPERATOR });
  assert.equal(second.ok, false, "the second click must not be reported as a second send");
  assert.equal(second.provider_attempted, false);
  assert.equal(count, 1, "exactly one provider call for one operator action");
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. A PROVIDER FAILURE IS A FAILURE
// ═════════════════════════════════════════════════════════════════════════════

test("8. a provider failure under manual authority is recorded as a failure: no success event, row failed", async () => {
  const { TextGridError } = await import("@/lib/providers/textgrid.js");
  const h = makeHarness({
    provider: async () => {
      throw new TextGridError("Carrier rejected message", { status: 400, to: THREAD, from: FROM, body: "x" });
    },
  });
  const result = await executeManualInboxSendNow(PAYLOAD, { ...h.deps, operator: OPERATOR });
  await drainPostSendProjections();

  assert.equal(result.ok, false);
  assert.equal(result.queue_status, "failed");
  assert.equal(result.provider_message_id, null);
  assert.equal(result.delivery_status_display, "failed");
  assert.equal(h.provider_args.length, 1, "the provider was attempted exactly once");
  assert.ok(h.events.includes("finalize_failure"), "the row is finalized failed");
  assert.ok(h.events.includes("failure_event"), "the failure is written as an event");
  assert.ok(!h.events.includes("message_event"), "no outbound success event");
  assert.ok(!h.events.includes("finalize"), "no success finalization");
});

// ═════════════════════════════════════════════════════════════════════════════
// 10. THE RECOVERY SWITCH FAILS CLOSED
// ═════════════════════════════════════════════════════════════════════════════

test("10. manual_send_mode absent or anything but exactly 'enabled' denies; an unreadable control plane denies", async () => {
  for (const mode of [undefined, null, "", "disabled", "Enabled", "ENABLED", "true", "on", "1", "yes", "live", "enabled;", " enabled!"]) {
    const r = await evaluateManualSendAuthority({
      getSystemValue: controlPlane({ ...AUTOMATION_STOPPED_MANUAL_ENABLED, manual_send_mode: mode }),
      operator: OPERATOR,
    });
    assert.equal(r.ok, false, `manual_send_mode=${JSON.stringify(mode)} must deny`);
    assert.equal(r.reason, "manual_send_disabled", JSON.stringify(mode));
    assert.equal(r.status, 423);
  }
  const enabled = await evaluateManualSendAuthority({ getSystemValue: controlPlane(AUTOMATION_STOPPED_MANUAL_ENABLED), operator: OPERATOR });
  assert.equal(enabled.ok, true);
  assert.equal(enabled.authority, "manual_operator");
  assert.equal(enabled.authority_version, MANUAL_SEND_AUTHORITY_VERSION);
  assert.deepEqual(Object.keys(enabled.operator).sort(), ["auth_source", "email", "id", "via"]);

  const thrown = await evaluateManualSendAuthority({ getSystemValue: async () => { throw new Error("control plane down"); }, operator: OPERATOR });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.reason, "control_plane_unreadable");
  const missing = await evaluateManualSendAuthority({ operator: OPERATOR });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "control_plane_unreadable");

  // Through the service: an absent switch denies BEFORE any row, claim or provider call.
  const h = makeHarness({ values: { ...AUTOMATION_STOPPED_MANUAL_ENABLED, manual_send_mode: null } });
  const result = await executeManualInboxSendNow(PAYLOAD, { ...h.deps, operator: OPERATOR });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "manual_send_disabled");
  assert.equal(result.status, 423);
  assert.equal(result.provider_attempted, false);
  assert.equal(h.provider_args.length, 0);
  assert.equal(h.supabase.calls.updates, 0);

  // The control route normalizes the switch: only the exact word turns it on.
  assert.equal(normalizeManualSendMode("enabled"), "enabled");
  assert.equal(normalizeManualSendMode(" ENABLED "), "enabled");
  for (const v of ["", "on", "true", "live", "disabled", null]) assert.equal(normalizeManualSendMode(v), "disabled");
});

// ═════════════════════════════════════════════════════════════════════════════
// The control plane: operator-owned keys, and the authority reads only its own
// ═════════════════════════════════════════════════════════════════════════════

test("the new keys are operator-owned: campaign automation can never write them", () => {
  for (const key of MANUAL_SEND_CONTROL_KEYS) {
    assert.ok(OPERATOR_OWNED_SYSTEM_KEYS.includes(key), `${key} must be operator-owned`);
    assert.throws(() => assertNoOperatorOwnedSystemKeys({ [key]: "enabled" }, "campaign_rails"), /operator_owned_system_key_write_blocked/);
  }
  const route = read("app/api/cockpit/queue/control/route.js");
  assert.match(route, /GLOBAL_SEND_SHUTDOWN_KEY,\n\s*MANUAL_SEND_MODE_KEY,\n\]/, "both keys are exposed through the operator control route");
  // The automation brake and the one-send re-arm do NOT touch the new keys.
  const rearm = route.slice(route.indexOf("async function rearmEmergencyStopAfterOneSend"), route.indexOf("function parseBody"));
  assert.ok(!rearm.includes("global_send_shutdown_at") && !rearm.includes("manual_send_mode"));
  const stop = route.slice(route.indexOf("if (action === 'emergency_stop')"), route.indexOf("if (action === 'run_dry_run_feeder')"));
  assert.ok(!stop.includes("global_send_shutdown_at") && !stop.includes("manual_send_mode"));
  // The manual authority's CODE never names the automation brake (its header
  // comment documents the separation, which is prose, not a code path).
  const authority_code = read("lib/domain/queue/manual-send-authority.js")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.ok(!authority_code.includes("queue_emergency_stop_at"), "the manual authority never reads or writes the automation brake");
});

test("the manual authority reads ONLY its two keys; the request surface cannot influence it", async () => {
  const seen = [];
  const r = await evaluateManualSendAuthority({
    getSystemValue: async (key) => { seen.push(key); return key === "manual_send_mode" ? "enabled" : null; },
    operator: OPERATOR,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(seen.sort(), ["global_send_shutdown_at", "manual_send_mode"]);
  const src = read("lib/domain/queue/manual-send-authority.js")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  for (const forbidden of ["queue_emergency_stop_at", "queue_processor_mode", "queue_execution_mode", "OPS_DASHBOARD_SECRET", "INTERNAL_API_SECRET", "req.headers", "searchParams", "metadata", "send_source"]) {
    assert.ok(!src.includes(forbidden), `manual authority must not consult ${forbidden}`);
  }
});
