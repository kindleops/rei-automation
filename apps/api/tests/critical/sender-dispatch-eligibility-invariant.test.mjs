/**
 * THE SENDER DISPATCH INVARIANT (owner, 2026-10-02):
 *   No production send path may dispatch from a number the canonical sender
 *   eligibility function (evaluateSenderDispatchEligibility) rejects —
 *   Sender Routing 2.0 gate ON or OFF.
 *
 * Structural half: the seam has exactly two production entries, and each is
 * preceded by the canonical function on the sender it will dispatch from.
 * Behavioural half: every path, given an operator-blocked number, refuses it.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateSenderDispatchEligibility, loadDispatchBlockedSenders, SENDER_BLOCKED_REASON } from "@/lib/domain/delivery/sender-dispatch-eligibility.js";
import { selectAvailableTextgridNumber } from "@/lib/supabase/sms-engine.js";
import { createInboxSendNowQueueRow } from "@/lib/domain/inbox/send-now-service.js";
import { selectCleanupReplySender } from "@/lib/domain/inbox/cleanup-reply-sender.js";
import { chooseTextgridNumber } from "@/lib/domain/outbound/supabase-candidate-feeder.js";
import { buildRoutingGraph, selectSender, AFFINITY_TIERS as T } from "@/lib/domain/routing/sender-routing/sender-routing-policy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, "../../src");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (e.name.endsWith(".js")) acc.push(full);
  }
  return acc;
}
const code = (src) => src.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
/** Source of one top-level function, by name. */
function fnBody(src, name) {
  const start = src.search(new RegExp(`(export )?async function ${name}\\(`));
  assert.ok(start >= 0, `function ${name} not found`);
  const next = src.slice(start + 10).search(/\n(export )?(async )?function \w+\(/);
  return src.slice(start, next < 0 ? undefined : start + 10 + next);
}

const BLOCKED = "+13058975670";
const CLEAN = "+16128060495";
const fleetRow = (phone, extra = {}) => ({ id: `id-${phone.slice(-4)}`, phone_number: phone, market: "Minneapolis, MN", status: "active", health_state: "unverified", daily_limit: 800, messages_sent_today: 0, last_used_at: null, ...extra });
const blocklistReader = async (key) => (key === "sms_blocked_sender_numbers" ? BLOCKED : null);

// ── structure ──────────────────────────────────────────────────────────────

test("the canonical dispatch seam has exactly two production entries", () => {
  const files = walk(SRC).map((f) => [path.relative(SRC, f), code(fs.readFileSync(f, "utf8"))]);
  const callers = (re) => files.filter(([, c]) => re.test(c)).map(([r]) => r).sort();
  assert.deepEqual(callers(/\bexecuteSellerCommunicationAttempt\(/), [
    "lib/domain/communications/canonical-communication-dispatch.js",
    "lib/domain/communications/dispatch-manual-operator-send.js",
    "lib/domain/communications/dispatch-seller-queue-row.js",
  ]);
  assert.deepEqual(callers(/\bdispatchSellerQueueRow\(/), ["lib/domain/communications/dispatch-seller-queue-row.js", "lib/domain/queue/process-send-queue.js"]);
  assert.deepEqual(callers(/\bdispatchManualOperatorSend\(/), ["lib/domain/communications/dispatch-manual-operator-send.js", "lib/domain/inbox/send-now-service.js"]);
});

test("queue runner: every queued row passes the canonical function before dispatchSellerQueueRow", () => {
  const runner = fnBody(code(read("lib/domain/queue/process-send-queue.js")), "processSupabaseQueueItem");
  const sel = runner.indexOf("selectAvailableTextgridNumber(queue_row");
  const dispatch = runner.indexOf("dispatchSellerQueueRow(");
  assert.ok(sel > 0 && dispatch > sel, "sender selection/revalidation precedes the seam");
  const engine = code(read("lib/supabase/sms-engine.js"));
  const selector = fnBody(engine, "selectAvailableTextgridNumber");
  assert.ok((selector.match(/evaluateSenderDispatchEligibility\(/g) || []).length >= 2, "both branches (pinned + rotation) use the canonical function");
  assert.ok(!/evaluateOutboundNumberEligibility\(/.test(selector), "no branch uses the partial evaluator alone");
  const v2 = selector.indexOf("routeQueueRowViaPolicy");
  assert.ok(v2 > 0, "gate-on path is inside the same selector");
});

test("manual send: the canonical function runs before the row dispatchManualOperatorSend sends from", () => {
  const svc = code(read("lib/domain/inbox/send-now-service.js"));
  const create = fnBody(svc, "createInboxSendNowQueueRow");
  assert.ok(create.indexOf("evaluateManualSendSender(") > 0);
  assert.ok(create.indexOf("evaluateManualSendSender(") < create.indexOf("insertImpl("), "refused before any row exists");
  assert.match(fnBody(svc, "evaluateManualSendSender"), /evaluateSenderDispatchEligibility\(/);
  assert.match(fnBody(svc, "executeManualInboxSendNow"), /createQueueRowImpl = createInboxSendNowQueueRow/);
});

test("Sender Routing 2.0 eligibility is a superset of the canonical function", () => {
  const policy = code(read("lib/domain/routing/sender-routing/sender-routing-policy.js"));
  assert.match(policy, /evaluateSenderDispatchEligibility\(/);
});

test("the remaining provider call sites are fenced, not seller paths", () => {
  const runner = code(read("lib/domain/queue/process-send-queue.js"));
  assert.ok(!/[^\w]processLegacyQueueItemUnreachable\(/.test(runner.replace(/async function processLegacyQueueItemUnreachable\(/, "")), "the legacy Podio send path stays unreachable");
  assert.match(code(read("lib/verification/live-textgrid.js")), /verification_textgrid_send_enabled[\s\S]*ALLOW_LIVE_TEXTGRID_VERIFICATION_SENDS/);
  assert.match(code(read("app/api/dev/force-send/route.js")), /status: 404/);
});

// ── behaviour, gate OFF (env -i: no SENDER_ROUTING_V2_ENABLED) ──────────────

test("canonical function: blocked, unreadable list, not in fleet", async () => {
  const blocked = await loadDispatchBlockedSenders({ getSystemValue: blocklistReader, env: {} });
  assert.deepEqual(evaluateSenderDispatchEligibility(fleetRow(BLOCKED), { blocked }).reason, SENDER_BLOCKED_REASON);
  assert.equal(evaluateSenderDispatchEligibility(fleetRow(CLEAN), { blocked }).ok, true);
  assert.equal(evaluateSenderDispatchEligibility(fleetRow(CLEAN), { blocked: null }).reason, "sender_blocklist_unreadable");
  assert.equal(evaluateSenderDispatchEligibility(null, { blocked }).reason, "outbound_number_not_in_fleet");
  assert.equal(await loadDispatchBlockedSenders({ getSystemValue: async () => { throw new Error("down"); }, env: {} }), null);
});

const pinnedRow = (from, extra = {}) => ({ id: "q1", queue_key: "k1", queue_status: "queued", to_phone_number: "+16125550142", thread_key: "+16125550142", market: "Minneapolis, MN", from_phone_number: from, ...extra });
const FALLBACK = "+16125092382";
const runnerDeps = (over = {}) => {
  const persisted = [];
  return {
    persisted,
    deps: {
      env: {},
      getSystemValue: blocklistReader,
      loadOutboundNumberByPhone: async (p) => fleetRow(p),
      routeThreadFallback: async () => ({ phone: FALLBACK, via: "campaign_router" }),
      persistThreadSenderChange: async (change) => { persisted.push(change); return { ok: true }; },
      ...over,
    },
  };
};

test("runner, campaign row: a blocked pinned sender is refused (parked, no retry, never sent, never replaced)", async () => {
  const { deps, persisted } = runnerDeps();
  const r = await selectAvailableTextgridNumber(pinnedRow(BLOCKED, { campaign_id: "c1", touch_number: 1 }), deps);
  assert.equal(r.ok, false);
  assert.equal(r.ineligible_sender, true);
  assert.equal(r.reason, SENDER_BLOCKED_REASON);
  assert.equal(persisted.length, 0);
  const ok = await selectAvailableTextgridNumber(pinnedRow(CLEAN, { campaign_id: "c1" }), deps);
  assert.equal(ok.reason, "queue_row_from_phone_number_revalidated", "gate-off behaviour otherwise unchanged");
});

for (const [label, extra] of [
  ["auto-reply (pinned to the number the seller texted)", { metadata: { source: "seller_inbound_orchestrator" } }],
  ["late reply (repair-queued)", { metadata: { source: "classifier_cleanup_20261001" } }],
  ["queued inbox reply", { metadata: { source: "inbox" } }],
]) {
  test(`runner, ${label}: never sends from the blocked number; sticky fallback is persisted with a reason`, async () => {
    const { deps, persisted } = runnerDeps();
    const r = await selectAvailableTextgridNumber(pinnedRow(BLOCKED, extra), deps);
    assert.equal(r.ok, true);
    assert.equal(r.from_phone_number, FALLBACK);
    assert.notEqual(r.from_phone_number, BLOCKED);
    assert.deepEqual(persisted.map((c) => [c.from, c.to, c.reason]), [[BLOCKED, FALLBACK, "thread_sender_blocked_by_operator"]]);
    const none = runnerDeps({ routeThreadFallback: async () => null });
    const parked = await selectAvailableTextgridNumber(pinnedRow(BLOCKED, extra), none.deps);
    assert.equal(parked.ok, false);
    assert.equal(parked.ineligible_sender, true);
    assert.equal(parked.reason, "no_eligible_sender_for_thread");
    const kept = await selectAvailableTextgridNumber(pinnedRow(CLEAN, extra), deps);
    assert.equal(kept.reason, "queue_row_from_phone_number_revalidated");
  });
}

test("runner: an unreadable blocklist defers a pinned row (no send, no retry)", async () => {
  const r = await selectAvailableTextgridNumber(pinnedRow(CLEAN), runnerDeps({ getSystemValue: async () => { throw new Error("down"); } }).deps);
  assert.equal(r.deferred, true);
  assert.equal(r.reason, "sender_blocklist_unreadable");
});

const numbersSupabase = (rows) => ({ from() { const q = { select: () => q, order: () => q, eq: () => q, in: () => q, gte: () => q, not: () => q, limit: () => Promise.resolve({ data: rows, error: null }) }; return q; } });

test("runner, follow-up with no sender on a thread: the thread's own sender, never a fleet-wide pick", async () => {
  const { deps } = runnerDeps({ loadThreadSender: async () => CLEAN });
  const r = await selectAvailableTextgridNumber(pinnedRow(null), deps);
  assert.equal(r.from_phone_number, CLEAN);
  assert.equal(r.reason, "sticky_thread_sender:thread_continuity");
  const blockedThread = runnerDeps({ loadThreadSender: async () => BLOCKED });
  const moved = await selectAvailableTextgridNumber(pinnedRow(null), blockedThread.deps);
  assert.equal(moved.from_phone_number, FALLBACK);
  assert.equal(blockedThread.persisted.length, 1);
});

test("runner, unassigned row with no thread: the rotation skips the least-used blocked number", async () => {
  const rows = [fleetRow(BLOCKED, { messages_sent_today: 0, last_used_at: null }), fleetRow(CLEAN, { messages_sent_today: 5, last_used_at: "2026-10-01T00:00:00Z" })];
  const r = await selectAvailableTextgridNumber({ id: "q2", queue_key: "k2" }, { env: {}, getSystemValue: blocklistReader, supabase: numbersSupabase(rows), loadSenderSentToday: async () => new Map() });
  assert.equal(r.ok, true);
  assert.equal(r.from_phone_number, CLEAN);
  const all = await selectAvailableTextgridNumber({ id: "q3", queue_key: "k3" }, { env: {}, getSystemValue: blocklistReader, supabase: numbersSupabase([fleetRow(BLOCKED)]), loadSenderSentToday: async () => new Map() });
  assert.equal(all.reason, "outbound_number_all_eligible_senders_blocked");
});

test("manual Send Now: a blocked sender is refused 423 before any row", async () => {
  let inserted = 0;
  const out = await createInboxSendNowQueueRow(
    { thread_key: "+16125550142", to_phone_number: "+16125550142", from_phone_number: BLOCKED, message_body: "hi there", action: "send_now" },
    { env: {}, getSystemValue: blocklistReader, loadOutboundNumberByPhone: async (p) => fleetRow(p), loadThreadSender: async () => null, insertImpl: async () => { inserted += 1; return { ok: true }; } }
  );
  assert.equal(out.status, 423);
  assert.equal(out.reason, "blocked_sender_number");
  assert.equal(inserted, 0);
});

test("campaign planning: the router never selects a blocked number", async () => {
  const r = await chooseTextgridNumber(
    { market: "Minneapolis, MN", state: "MN", touch_number: 1 },
    { first_touch: true, blocked_sender_numbers: new Set([BLOCKED]) },
    { env: {}, textgridNumberRows: [fleetRow(BLOCKED, { market: "Minneapolis, MN" }), fleetRow(CLEAN, { messages_sent_today: 9 })] }
  );
  assert.equal(r.selected_textgrid_number, CLEAN);
});

test("late reply executor: a fleet of only blocked numbers yields no sender", async () => {
  const r = await selectCleanupReplySender(
    { market: "Minneapolis, MN", state: "MN", template_id: "t1" },
    { env: {}, getSystemValue: async (k) => (k === "sms_blocked_sender_numbers" ? BLOCKED : null), chooseTextgridNumber, textgridNumberRows: [fleetRow(BLOCKED)] }
  );
  assert.equal(r.routing_allowed, false);
  assert.equal(r.phone_number, null);
});

test("gate ON (Sender Routing 2.0 policy): a blocked thread number is never kept", () => {
  const graph = buildRoutingGraph({
    markets: [{ id: "minneapolis-mn", display_name: "Minneapolis, MN" }],
    pools: [{ pool_key: "minneapolis", display_name: "Minneapolis", home_market_id: "minneapolis-mn" }],
    pool_numbers: [{ pool_key: "minneapolis", textgrid_number_id: "id-5670" }, { pool_key: "minneapolis", textgrid_number_id: "id-0495" }],
    routes: [{ market_id: "minneapolis-mn", pool_key: "minneapolis", priority: 10, affinity_tier: T.PRIMARY }],
  });
  const fleet = [fleetRow(BLOCKED, { registration_status: "registered", metadata: { sms_webhook_status: "verified" } }), fleetRow(CLEAN, { registration_status: "registered", metadata: { sms_webhook_status: "verified" } })];
  const r = selectSender({ market_id: "minneapolis-mn", purpose: "reply", thread_number: BLOCKED }, { graph, fleet, blocked: new Set([BLOCKED]) });
  assert.equal(r.number.phone_number, CLEAN);
  assert.equal(r.thread_reroute.reason, "thread_number_blocked_by_operator");
});
