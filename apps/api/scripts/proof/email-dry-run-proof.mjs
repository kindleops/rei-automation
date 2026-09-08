#!/usr/bin/env node
/**
 * email-dry-run-proof.mjs
 *
 * Proves that the email send path can be exercised end to end WITHOUT any
 * credential, and that nothing in it reaches a network.
 *
 * WHY THIS IS A PROOF AND NOT A TEST.
 *   The unit tests inject a transport double, so they demonstrate that the code
 *   calls what it was given. This runs the REAL dispatch bridge with the REAL
 *   Brevo transport constructed from the real factory, and asserts that no
 *   outbound request is attempted -- with global fetch replaced by a tripwire
 *   that fails the run if anything touches it.
 *
 *   The difference matters: a future refactor that moved a send outside the
 *   injected seam would still pass the unit tests and would fail here.
 */

import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

const results = [];
const check = (label, condition, detail = "") => {
  results.push({ label, ok: Boolean(condition), detail });
  console.log(`  ${condition ? "ok  " : "FAIL"}  ${label}${condition || !detail ? "" : ` -- ${detail}`}`);
};

// ── the tripwire ───────────────────────────────────────────────────────────
let network_attempts = 0;
const attempted_urls = [];
globalThis.fetch = async (url) => {
  network_attempts += 1;
  attempted_urls.push(String(url));
  throw new Error("network access attempted during a dry run");
};

const { dispatchEmailQueueRow } = await import("@/lib/domain/email/dispatch-email-queue-row.js");
const { createBrevoEmailTransport } = await import("@/lib/domain/email/transport/brevo-email-transport.js");

console.log("email-dry-run-proof");

const SENDER = {
  sender_key: "acq-primary",
  from_email: "acq@example.com",
  sender_name: "Acquisitions",
  domain: "example.com",
  domain_verified: true,
  is_active: true,
  sender_status: "active",
  warmup_status: "warmed",
  daily_limit: 500,
  messages_sent_today: 0,
};

const ROW = {
  id: "eq-dry-1",
  queue_status: "queued",
  to_email: "seller@example.com",
  subject: "About your property",
  email_body: "<p>Would you consider an offer?</p>",
  text_body: "Would you consider an offer?",
  campaign_target_id: "11111111-1111-4111-8111-111111111111",
  touch_number: 3,
  master_owner_id: "own-1",
  property_id: "prop-1",
};

/** A store that would happily allocate, so a dry run's restraint is its own. */
const permissiveStore = () => {
  const state = { communications: new Map(), attempts: [] };
  return {
    state,
    async getOrCreateLogicalCommunication({ logical_key, communication_type, lineage }) {
      const row = { id: `lc-${state.communications.size + 1}`, logical_key, communication_type, ...lineage,
        state: "created", delivery_possibility: "definitely_not_sent", retry_authority: "retry_allowed" };
      state.communications.set(logical_key, row);
      return { ok: true, reused: false, communication: row };
    },
    async getLogicalCommunicationById() { return { ok: false, reason: "not_found" }; },
    async allocateAttempt() {
      state.attempts.push({});
      return { ok: true, attempt_id: `att-${state.attempts.length}`, attempt_number: state.attempts.length };
    },
    async markProviderRequestStarted() { return { ok: true }; },
    async recordAttemptOutcome() { return { ok: true }; },
    async applyLogicalTransition() { return { ok: true }; },
    async bindQueueRow() { return { ok: true }; },
  };
};

const baseDeps = (over = {}) => ({
  store: permissiveStore(),
  // The REAL transport, from the real factory. Not a double.
  transport: createBrevoEmailTransport(),
  getSystemFlag: async () => true,
  getSystemValue: async (key) => (key === "queue_processor_mode" ? "live"
    : key === "queue_execution_mode" ? "normal" : null),
  resolveEligibility: async () => ({ ok: true, eligible: true, reason: null, blocking_reasons: [] }),
  sender: SENDER,
  now: "2026-09-08T18:00:00.000Z",
  ...over,
});

// ── 1. a dry run plans, and touches nothing ────────────────────────────────
const deps = baseDeps({ dry_run: true });
const dry = await dispatchEmailQueueRow(ROW, deps);

check("a dry run reports ok", dry.ok === true, dry.reason);
check("a dry run does NOT report a send", dry.sent === false);
check("a dry run marks itself as one", dry.dry_run === true);
check("a dry run never invokes a provider", dry.provider_invoked === false);
check("NO network request was attempted", network_attempts === 0, attempted_urls.join(", "));
check("a dry run allocates NO attempt", deps.store.state.attempts.length === 0);
check("a dry run creates NO logical communication", deps.store.state.communications.size === 0);

// ── 2. it still says what it would have done ───────────────────────────────
check("the plan names the recipient", dry.would_send?.to === "seller@example.com");
check("the plan names the sender", dry.would_send?.from === "acq@example.com");
check("the plan names the domain action", dry.would_send?.communication_type === "campaign_touch");
check("the plan reports remaining sender headroom", dry.would_send?.sender_remaining_today === 500);

// ── 3. a dry run cannot report a plan the real path would refuse ───────────
for (const [label, over] of [
  ["kill switch off", { getSystemFlag: async () => false }],
  ["sender suspended", { sender: { ...SENDER, sender_status: "suspended" } }],
  ["recipient opted out", {
    resolveEligibility: async () => ({ ok: true, eligible: false, reason: "opted_out", blocking_reasons: ["opted_out"] }),
  }],
]) {
  const refused = await dispatchEmailQueueRow(ROW, baseDeps({ dry_run: true, ...over }));
  check(`a dry run is refused when ${label}`, refused.stage !== "dry_run" && refused.sent === false, refused.stage);
}

// ── 4. the real path, with no credential, still never sends ────────────────
// EMAIL-2 ships with no Brevo key in this environment. The transport must refuse
// before opening a socket rather than failing somewhere inside one.
const live = await dispatchEmailQueueRow(ROW, baseDeps({ dry_run: false }));
check("a real dispatch with no credential does not send", live.sent === false, live.reason);
check("it refuses BEFORE the network, not during it", network_attempts === 0, attempted_urls.join(", "));
check("the refusal names the missing credential",
  live.reason === "provider_auth_failed", live.reason);

const failures = results.filter((r) => !r.ok);
console.log(failures.length ? `\nFAILED (${failures.length})` : "\nPASS");
assert.equal(network_attempts, 0, "the tripwire fired: something reached the network");
process.exit(failures.length ? 1 : 0);
