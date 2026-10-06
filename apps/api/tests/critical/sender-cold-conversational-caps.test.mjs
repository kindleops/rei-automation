/**
 * COLD vs CONVERSATIONAL sender caps (owner rule 2026-10-05):
 *   "We only do 800 in terms of outbound campaigns, but any replies that come
 *    in don't count towards that 800."
 *
 * Prod evidence: Dallas ••1600 (daily_limit 800) sent 784 campaign + 11
 * auto_reply + 5 inbox = 800, then parked 2 seller auto-replies as
 * outbound_number_daily_limit_reached. daily_limit now caps COLD sends only;
 * a per-number total ceiling (default 2000) is the carrier-safety guard.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { SEND_CLASS, classifySend } from "@/lib/domain/delivery/send-class.js";
import {
  DEFAULT_CONVERSATIONAL_CEILING,
  applyDerivedSentToday,
  loadSenderSentToday,
  withDerivedSentToday,
} from "@/lib/domain/delivery/sender-sent-today.js";
import { evaluateOutboundNumberEligibility, selectAvailableTextgridNumber } from "@/lib/supabase/sms-engine.js";
import {
  CAP_HOLD_REASON,
  STALE_REPLY_REVIEW_REASON,
  decideCapHoldRelease,
  releaseConversationalCapHolds,
} from "@/lib/domain/queue/release-conversational-cap-holds.js";

const NOW = new Date("2026-10-05T23:55:00.000Z"); // 18:55 Chicago
const DALLAS = "+14693131600";
const SELLER = "+12145550199";

const fleetRow = (over = {}) => ({
  id: "dal-1", phone_number: DALLAS, market: "Dallas, TX", status: "active", health_state: "unverified",
  daily_limit: 800, messages_sent_today: 800, messages_sent_today_conversational: 16, messages_sent_today_total: 816,
  ...over,
});

const campaignRow = { id: "q-c", source: "campaign_launch_execution", type: "campaign_launch", campaign_id: "camp-1", thread_key: SELLER, to_phone_number: SELLER, from_phone_number: DALLAS, message_body: "hi" };
const autoReplyRow = {
  id: "q-a", source: "auto_reply", type: "auto_reply", message_type: "Follow-Up", campaign_id: "camp-1", thread_key: SELLER,
  queue_key: `inbound_auto_reply:x:400065:${SELLER}`, to_phone_number: SELLER, from_phone_number: DALLAS, message_body: "Thanks!",
};
const operatorRow = { id: "q-o", source: "inbox", type: "outbound", message_type: "manual_reply", thread_key: SELLER, to_phone_number: SELLER, from_phone_number: DALLAS, message_body: "Calling you now" };

// No thread fallback in these tests: a thread row whose sender is refused is refused.
const noBlocks = { loadDispatchBlockedSenders: async () => new Set(), loadThreadSender: async () => null, routeThreadFallback: async () => null };
// Thread rows outside a campaign (operator sends) go through the sticky-sender
// rule, which reports a refused sender as no_eligible_sender_for_thread.
const select = (row, number, extra = {}) =>
  selectAvailableTextgridNumber(row, { ...noBlocks, now: NOW, loadOutboundNumberByPhone: async () => number, ...extra });

test("the predicate: provenance first, then 'seller replied on this thread within 30 days', else COLD", () => {
  assert.equal(classifySend(autoReplyRow).send_class, SEND_CLASS.CONVERSATIONAL);
  assert.equal(classifySend(operatorRow).send_class, SEND_CLASS.CONVERSATIONAL);
  assert.equal(classifySend({ source: "seller_inbound_orchestrator", type: "followup" }).send_class, SEND_CLASS.CONVERSATIONAL);
  assert.equal(classifySend({ source: "x", message_type: "missed_call_autotext", queue_key: "missed_call:CA1" }).send_class, SEND_CLASS.CONVERSATIONAL);
  assert.equal(classifySend({ source: "inbox_bulk_follow_up", metadata: { created_from: "leadcommand_inbox" } }).send_class, SEND_CLASS.CONVERSATIONAL);

  // Campaign touches: cold unless the seller replied on the thread in the last 30 days, before the send.
  assert.equal(classifySend(campaignRow, { at: NOW }).send_class, SEND_CLASS.COLD);
  assert.equal(classifySend(campaignRow, { last_inbound_at: "2026-09-20T00:00:00Z", at: NOW }).basis, "thread_replied_30d");
  assert.equal(classifySend(campaignRow, { last_inbound_at: "2026-08-01T00:00:00Z", at: NOW }).send_class, SEND_CLASS.COLD);
  assert.equal(classifySend(campaignRow, { last_inbound_at: "2026-10-06T00:00:00Z", at: NOW }).send_class, SEND_CLASS.COLD, "a reply AFTER the send does not reclassify it");
  // A cleanup follow-up with no thread is cold.
  assert.equal(classifySend({ source: "classifier_cleanup_20261001", type: "followup" }).send_class, SEND_CLASS.COLD);
});

test("campaign sends cap at 800 cold", async () => {
  const at_cap = await select(campaignRow, fleetRow({ messages_sent_today: 800, messages_sent_today_total: 816 }));
  assert.equal(at_cap.ok, false);
  assert.equal(at_cap.reason, "outbound_number_daily_limit_reached");
  assert.equal(at_cap.send_class, SEND_CLASS.COLD);

  const under = await select(campaignRow, fleetRow({ messages_sent_today: 799, messages_sent_today_total: 900 }));
  assert.equal(under.ok, true, "replies sent today do not consume cold capacity");
});

test("an auto_reply at cold=800 still sends (the prod Dallas case)", async () => {
  const out = await select(autoReplyRow, fleetRow());
  assert.equal(out.ok, true);
  assert.equal(out.from_phone_number, DALLAS);
  assert.equal(out.send_class, SEND_CLASS.CONVERSATIONAL);
});

test("an operator inbox send at cold=800 still sends", async () => {
  const out = await select(operatorRow, fleetRow());
  assert.equal(out.ok, true);
});

test("a campaign follow-up to a seller who replied within 30 days is conversational at dispatch", async () => {
  const out = await select(campaignRow, fleetRow(), {
    loadThreadLastInbound: async () => new Map([[SELLER, "2026-10-04T15:00:00Z"]]),
  });
  assert.equal(out.ok, true);
  assert.equal(out.send_class_basis, "thread_replied_30d");
});

test("the total ceiling blocks a runaway — every class, default 2000, per-number metadata override, fleet setting", async () => {
  const runaway = fleetRow({ messages_sent_today: 120, messages_sent_today_total: DEFAULT_CONVERSATIONAL_CEILING });
  for (const row of [autoReplyRow, operatorRow, campaignRow]) {
    const out = await select(row, runaway);
    assert.equal(out.ok, false);
    if (row === operatorRow) assert.equal(out.reason, "no_eligible_sender_for_thread");
    else assert.equal(out.reason, "outbound_number_total_ceiling_reached");
  }
  assert.equal((await select(autoReplyRow, fleetRow({ messages_sent_today_total: 1999 }))).ok, true);

  const tight = fleetRow({ messages_sent_today_total: 50, metadata: { conversational_ceiling: 50 } });
  assert.equal((await select(autoReplyRow, tight)).reason, "outbound_number_total_ceiling_reached");

  // Fleet-wide system_control sender_conversational_ceiling, via the derived rows.
  const [derived] = await withDerivedSentToday(null, [{ phone_number: DALLAS, market: "Dallas, TX", daily_limit: 800, messages_sent_today: 0 }], {
    now: NOW,
    loadConversationalCeiling: async () => 30,
    loadSenderSentToday: async () => new Map([[DALLAS, { cold: 10, conversational: 20 }]]),
  });
  assert.equal(derived.conversational_ceiling, 30);
  assert.equal(evaluateOutboundNumberEligibility(derived, NOW, { send_class: "conversational" }).reason, "outbound_number_total_ceiling_reached");
});

test("a cooling, spam-flagged or paused number blocks everything, replies included", async () => {
  const cases = [
    [{ health_state: "cooling" }, "outbound_number_health_cooling"],
    [{ health_state: "spam_flagged" }, "outbound_number_health_spam_flagged"],
    [{ cooling_until: "2026-10-06T10:00:00Z" }, "outbound_number_cooling_until"],
    [{ status: "paused" }, "outbound_number_status_paused"],
  ];
  for (const [over, reason] of cases) {
    const number = fleetRow({ messages_sent_today: 0, messages_sent_today_total: 0, ...over });
    for (const row of [autoReplyRow, operatorRow, campaignRow]) {
      const out = await select(row, number);
      assert.equal(out.ok, false, `${reason} must block ${row.source}`);
      if (row === operatorRow) assert.equal(out.reason, "no_eligible_sender_for_thread");
      else assert.equal(out.reason, reason);
    }
  }
});

function fakeSupabase(tables) {
  return {
    from(table) {
      const b = {
        select: () => b, eq: () => b, in: () => b, gte: () => b, order: () => b, limit: () => b, range: () => b,
        then: (resolve, reject) => Promise.resolve({ data: tables[table] || [], error: null }).then(resolve, reject),
      };
      return b;
    },
  };
}

test("'sent today' splits cold / conversational from the ledger (prod Dallas shape)", async () => {
  const at = "2026-10-05T18:00:00Z";
  const rows = [];
  for (let i = 0; i < 784; i += 1) rows.push({ id: `c${i}`, from_phone_number: DALLAS, sent_at: at, source: "campaign_launch_execution", type: "campaign_launch", thread_key: `+1214000${String(i).padStart(4, "0")}` });
  for (let i = 0; i < 11; i += 1) rows.push({ id: `a${i}`, from_phone_number: DALLAS, sent_at: at, source: "auto_reply", type: "auto_reply", thread_key: SELLER });
  for (let i = 0; i < 5; i += 1) rows.push({ id: `m${i}`, from_phone_number: DALLAS, sent_at: at, source: "inbox", type: "outbound", message_type: "manual_reply", thread_key: SELLER });
  // A campaign follow-up to a seller who had replied the day before = conversational.
  rows.push({ id: "f1", from_phone_number: DALLAS, sent_at: at, source: "campaign_launch_execution", type: "campaign_launch", thread_key: "+12145550001" });
  // Yesterday (Chicago) does not count at all.
  rows.push({ id: "y1", from_phone_number: DALLAS, sent_at: "2026-10-05T04:59:00Z", source: "campaign_launch_execution" });
  const supabase = fakeSupabase({
    send_queue: rows,
    inbox_thread_state: [{ thread_key: "+12145550001", last_inbound_at: "2026-10-04T20:00:00Z" }],
  });
  const counts = await loadSenderSentToday(supabase, [{ phone_number: DALLAS, market: "Dallas, TX" }], { now: NOW });
  assert.deepEqual(counts.get(DALLAS), { cold: 784, conversational: 17, total: 801 });

  const [row] = applyDerivedSentToday([{ phone_number: DALLAS, daily_limit: 800, messages_sent_today: 5000 }], counts);
  assert.equal(row.messages_sent_today, 784, "the cap's count is COLD");
  assert.equal(row.messages_sent_today_conversational, 17);
  assert.equal(row.messages_sent_today_total, 801);
  assert.equal(row.messages_sent_today_counter, 5000);
  assert.equal(row.conversational_ceiling, DEFAULT_CONVERSATIONAL_CEILING);

  // Unreadable thread state => those rows are COLD (never under-counts the cap).
  const blind = await loadSenderSentToday(supabase, [{ phone_number: DALLAS, market: "Dallas, TX" }], {
    now: NOW,
    loadThreadLastInbound: async () => { throw new Error("down"); },
  });
  assert.deepEqual(blind.get(DALLAS), { cold: 785, conversational: 16, total: 801 });

  // Legacy loaders returning a bare number are treated as all-cold.
  const [legacy] = applyDerivedSentToday([{ phone_number: DALLAS }], new Map([[DALLAS, 12]]));
  assert.equal(legacy.messages_sent_today, 12);
  assert.equal(legacy.messages_sent_today_total, 12);
});

test("rotation: cold sends rank by COLD usage, replies by TOTAL usage", async () => {
  const A = { id: "a", phone_number: "+14690000001", market: "Dallas, TX", status: "active", daily_limit: 800 };
  const B = { id: "b", phone_number: "+14690000002", market: "Dallas, TX", status: "active", daily_limit: 800 };
  const supabase = fakeSupabase({ textgrid_numbers: [A, B] });
  const loadSenderSentToday = async () => new Map([
    [A.phone_number, { cold: 100, conversational: 0 }], // total 100
    [B.phone_number, { cold: 10, conversational: 300 }], // total 310
  ]);
  const base = { id: "r", to_phone_number: SELLER, message_body: "x" };
  const cold = await selectAvailableTextgridNumber({ ...base, source: "campaign_launch_execution" }, { ...noBlocks, supabase, now: NOW, loadSenderSentToday, resolveSendClass: async () => ({ send_class: "cold" }) });
  assert.equal(cold.from_phone_number, B.phone_number);
  const reply = await selectAvailableTextgridNumber({ ...base, source: "auto_reply" }, { ...noBlocks, supabase, now: NOW, loadSenderSentToday, resolveSendClass: async () => ({ send_class: "conversational" }) });
  assert.equal(reply.from_phone_number, A.phone_number);
});

const parked = (over = {}) => ({
  ...autoReplyRow, id: "237d05da", queue_status: "blocked_sender_ineligible", guard_reason: CAP_HOLD_REASON, failed_reason: CAP_HOLD_REASON,
  created_at: "2026-10-05T23:29:05Z", scheduled_for_utc: "2026-10-05T23:30:05Z", metadata: { skip_reason: CAP_HOLD_REASON }, ...over,
});
const thread = { last_inbound_at: "2026-10-05T23:28:50Z", last_outbound_at: "2026-10-05T22:00:00Z" };

test("cap-parked replies: fresh -> release; stale / overtaken -> review; cold -> stays capped", () => {
  assert.equal(decideCapHoldRelease(parked(), { thread, now: NOW }).action, "release");
  assert.deepEqual(
    [decideCapHoldRelease(parked(), { thread, now: new Date("2026-10-06T14:00:00Z") }).action, decideCapHoldRelease(parked(), { thread, now: new Date("2026-10-06T14:00:00Z") }).reason],
    ["review", "stale_reply"]
  );
  assert.equal(decideCapHoldRelease(parked(), { thread: { ...thread, last_inbound_at: "2026-10-05T23:40:00Z" }, now: NOW }).reason, "seller_wrote_again");
  assert.equal(decideCapHoldRelease(parked(), { thread: { ...thread, last_outbound_at: "2026-10-05T23:45:00Z" }, now: NOW }).reason, "newer_outbound_on_thread");
  const coldParked = { ...campaignRow, queue_status: "blocked_sender_ineligible", guard_reason: CAP_HOLD_REASON, created_at: "2026-10-05T23:00:00Z" };
  assert.equal(decideCapHoldRelease(coldParked, { thread: null, now: NOW }).action, "skip");
  assert.equal(decideCapHoldRelease(coldParked, { thread: null, now: NOW }).reason, "cold_send_stays_capped");
  assert.equal(decideCapHoldRelease(parked({ guard_reason: "outbound_number_health_cooling" }), { thread, now: NOW }).action, "skip");
});

test("release writes compare-and-set to 'queued' (never sends); review re-labels and alerts; dry run writes nothing", async () => {
  const writes = [];
  const alerts = [];
  const deps = {
    now: NOW,
    env: {},
    loadParkedRows: async () => [parked(), parked({ id: "960cca0e", created_at: "2026-10-05T12:00:00Z", scheduled_for_utc: "2026-10-05T12:01:00Z" })],
    loadThreads: async () => new Map([[SELLER, thread]]),
    applyDecision: async (id, payload) => (writes.push({ id, payload }), true),
    notify: async (p) => (alerts.push(p), { ok: true }),
  };
  const dry = await releaseConversationalCapHolds({ dry_run: true }, deps);
  assert.equal(writes.length, 0);
  assert.equal(dry.released, 1);
  assert.equal(dry.review, 1);

  const out = await releaseConversationalCapHolds({}, deps);
  assert.equal(out.released, 1);
  assert.equal(out.review, 1);
  const release = writes.find((w) => w.id === "237d05da").payload;
  assert.equal(release.queue_status, "queued");
  assert.equal(release.guard_reason, null);
  assert.equal(release.metadata.conversational_cap_release.previous_reason, CAP_HOLD_REASON);
  const review = writes.find((w) => w.id === "960cca0e").payload;
  assert.equal(review.queue_status, undefined, "stays parked");
  assert.equal(review.guard_reason, STALE_REPLY_REVIEW_REASON);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].deduplicationKey, "conversational_cap_review:960cca0e");

  assert.equal((await releaseConversationalCapHolds({}, { ...deps, env: { CONVERSATIONAL_CAP_RELEASE: "off" } })).skipped, true);
  const blind = await releaseConversationalCapHolds({}, { ...deps, loadThreads: async () => { throw new Error("down"); } });
  assert.equal(blind.ok, false);
  assert.equal(blind.released, 0);
});
