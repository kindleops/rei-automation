/**
 * email-inbound-attention.test.mjs
 *
 * THE INVARIANT: a real seller reply that needs a human cannot sit in a
 * database unnoticed.
 *
 * EMAIL-3 stored unmatched and ambiguous replies correctly and told nobody. The
 * documented fallback was a person remembering to run a query on a cadence,
 * which is not a control. These tests pin both halves of the replacement --
 * inline emission and the sweep that catches what emission drops -- and the
 * deduplication that stops the whole category becoming noise.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyInboundAttention,
  emitInboundAttention,
  buildInboundAttentionKey,
  INBOUND_ATTENTION_REASON,
} from "../../src/lib/domain/email/inbound/inbound-attention.js";
import { scanInboundEmailAttention } from "../../src/lib/domain/email/inbound/inbound-attention-scan.js";
import { ingestInboundEmail } from "../../src/lib/domain/email/inbound/ingest-inbound-email.js";
import { EVENT_CATALOG } from "../../src/lib/domain/notifications/notification-event-catalog.js";
import { TRUST_CLASS } from "../../src/lib/domain/communications/callback-trust-policy.js";
import { createBrevoInboundProvider } from "../../src/lib/domain/email/inbound/brevo-inbound-adapter.js";

// ── the events exist in the canonical catalog, not a parallel one ──────────

test("every attention event this module emits is a real catalog entry", () => {
  // A typo'd event type is refused by the emitter as `unknown_event_type` and
  // logged -- which is silent, and silence is the failure mode here.
  for (const type of [
    "inbox_unmatched_reply",
    "inbox_multi_property_match",
    "inbox_inbound_quarantined",
    "inbox_inbound_processing_failed",
    "inbox_attachment_quarantined",
  ]) {
    assert.ok(EVENT_CATALOG[type], `${type} is not in the catalog`);
    assert.equal(EVENT_CATALOG[type].domain, "inbox", `${type} left the inbox domain`);
  }
});

test("ambiguous reuses the event that already meant this, rather than a new one", () => {
  // inbox_multi_property_match predates this phase and means exactly "one
  // seller, several properties". A second event for the same meaning is how a
  // platform ends up with two attention vocabularies.
  const verdict = classifyInboundAttention({ needs_review: true, resolution_status: "ambiguous" });
  assert.equal(verdict.event_type, "inbox_multi_property_match");
});

test("no attention event is neutral, and none can only be dismissed", () => {
  // Each of these is a real seller waiting for an answer nobody knows is owed.
  for (const type of ["inbox_unmatched_reply", "inbox_inbound_quarantined", "inbox_inbound_processing_failed"]) {
    const entry = EVENT_CATALOG[type];
    assert.notEqual(entry.defaultSeverity, "neutral", type);
    assert.ok(entry.defaultActions.length >= 2, `${type} offers no real action`);
  }
});

test("a processing failure is CRITICAL, because that is the shape of a silent loss", () => {
  assert.equal(EVENT_CATALOG.inbox_inbound_processing_failed.defaultSeverity, "critical");
});

// ── which outcomes need a human ────────────────────────────────────────────

test("an unmatched reply needs a human", () => {
  const verdict = classifyInboundAttention({ ok: true, needs_review: true, resolution_status: "unmatched" });
  assert.equal(verdict.needed, true);
  assert.equal(verdict.reason, INBOUND_ATTENTION_REASON.UNMATCHED);
});

test("a retryable failure needs a human loudest of all", () => {
  const verdict = classifyInboundAttention({ ok: false, retryable: true, reason: "inbound_event_record_failed" });
  assert.equal(verdict.reason, INBOUND_ATTENTION_REASON.PROCESSING_FAILED);
});

test("a quarantined payload needs a human", () => {
  assert.equal(
    classifyInboundAttention({ processing_status: "quarantined" }).reason,
    INBOUND_ATTENTION_REASON.QUARANTINED
  );
});

test("a RESOLVED reply needs nobody", () => {
  // The ordinary case. If this fired, every seller reply would raise an alert
  // and the category would be muted within a day.
  const verdict = classifyInboundAttention({ ok: true, processing_status: "processed", resolution_status: "resolved" });
  assert.equal(verdict.needed, false);
});

test("a HELD reply needs nobody, because an operator switched it off themselves", () => {
  const verdict = classifyInboundAttention({ ok: true, held: true, reason: "inbound_ingestion_disabled" });
  assert.equal(verdict.needed, false);
});

test("a DUPLICATE needs nobody, because its first delivery already raised what it warranted", () => {
  const verdict = classifyInboundAttention({ ok: true, duplicate: true, needs_review: true, resolution_status: "unmatched" });
  assert.equal(verdict.needed, false);
});

test("classification never throws on hostile input", () => {
  for (const value of [null, undefined, "", 0, [], "string", { resolution_status: {} }]) {
    assert.doesNotThrow(() => classifyInboundAttention(value), String(value));
  }
});

// ── deduplication ──────────────────────────────────────────────────────────

test("the dedup key is stable for the life of an event, not for a day", () => {
  // The platform's default buildDedupKey appends today's date. A provider retry
  // that crosses midnight would produce a second alert for one seller reply.
  const a = buildInboundAttentionKey("brevo_in:abc", "unmatched");
  const b = buildInboundAttentionKey("brevo_in:abc", "unmatched");
  assert.equal(a, b);
  assert.equal(/\d{4}-\d{2}-\d{2}/.test(a), false, "a date leaked into the dedup key");
});

test("two reasons on one message stay two alerts", () => {
  // A message can be both quarantined for an attachment and unmatched for a
  // thread. Collapsing those hides one of them.
  assert.notEqual(
    buildInboundAttentionKey("brevo_in:abc", "unmatched"),
    buildInboundAttentionKey("brevo_in:abc", "attachment_quarantined")
  );
});

test("no event key means no emission, rather than an un-deduplicated one", () => {
  // A missing alert is recoverable by the sweep. An alert that fires again on
  // every retry trains operators to ignore the category.
  assert.equal(buildInboundAttentionKey("", "unmatched"), null);
  assert.equal(buildInboundAttentionKey(null, "unmatched"), null);
  assert.equal(buildInboundAttentionKey("brevo_in:abc", ""), null);
});

test("a retried callback raises ONE alert, not one per retry", async () => {
  const emitted = [];
  const emit = async (opts) => { emitted.push(opts.deduplicationKey); return { ok: true }; };
  const input = {
    event_key: "brevo_in:retry-1",
    from_email: "seller@example.org",
    outcome: { ok: true, needs_review: true, resolution_status: "unmatched" },
  };

  await emitInboundAttention(input, { emitNotification: emit });
  await emitInboundAttention(input, { emitNotification: emit });
  await emitInboundAttention(input, { emitNotification: emit });

  // Three emissions, ONE key -- upsertNotificationEvent collapses them onto one
  // row. The key being identical is what makes that true.
  assert.equal(new Set(emitted).size, 1);
});

// ── what an alert carries, and what it must not ───────────────────────────

test("no seller message body reaches a notification", async () => {
  // An operator needs to know a reply is waiting and where to find it. They
  // read it in the message row, behind the access control that already governs
  // the seller record. Copying prose into a second table widens exposure for
  // nothing.
  let captured = null;
  await emitInboundAttention(
    {
      event_key: "brevo_in:body-1",
      from_email: "seller@example.org",
      inbound_message_id: "msg-1",
      body_text: "I would take 185 if you close Friday",
      outcome: {
        ok: true, needs_review: true, resolution_status: "unmatched",
        body: { newest_reply: "I would take 185 if you close Friday" },
      },
    },
    { emitNotification: async (opts) => { captured = opts; return { ok: true }; } }
  );

  const serialized = JSON.stringify(captured);
  assert.equal(serialized.includes("185"), false, "seller prose reached the notification");
  assert.equal(serialized.includes("close Friday"), false);
});

test("an alert carries pointers an operator can follow", async () => {
  let captured = null;
  await emitInboundAttention(
    {
      event_key: "brevo_in:ptr-1",
      inbound_event_id: "evt-1",
      inbound_message_id: "msg-1",
      from_email: "Seller@Example.ORG",
      conversation: { property_id: "prop-1", opportunity_id: "opp-1" },
      outcome: { ok: true, needs_review: true, resolution_status: "unmatched", resolution_reason: "reply_token_unknown" },
    },
    { emitNotification: async (opts) => { captured = opts; return { ok: true }; } }
  );

  assert.equal(captured.metrics.inbound_event_id, "evt-1");
  assert.equal(captured.metrics.inbound_message_id, "msg-1");
  assert.equal(captured.metrics.resolution_reason, "reply_token_unknown");
  assert.equal(captured.metrics.channel, "email");
  assert.equal(captured.sourceEntityId, "brevo_in:ptr-1");
  assert.equal(captured.titleVars.from_email, "seller@example.org");
});

test("unmatched replies are never grouped, because each is a different seller", async () => {
  let captured = null;
  await emitInboundAttention(
    { event_key: "brevo_in:g-1", outcome: { needs_review: true, resolution_status: "unmatched" } },
    { emitNotification: async (opts) => { captured = opts; return { ok: true }; } }
  );
  // Grouping would render three waiting sellers as "(3 occurrences)", and the
  // third one is the one that gets missed.
  assert.equal(captured.group, false);
});

test("emission never throws, whatever the emitter does", async () => {
  const exploding = async () => { throw new Error("notification backend down"); };
  const result = await emitInboundAttention(
    { event_key: "brevo_in:x", outcome: { needs_review: true, resolution_status: "unmatched" } },
    { emitNotification: exploding }
  );
  assert.equal(result.ok, false);
  assert.equal(result.emitted, false);
});

// ── the ingest path raises attention structurally ─────────────────────────

function ingestStore({ resolves = false } = {}) {
  return {
    async getSystemFlag() { return true; },
    async recordInboundEvent() { return { ok: true, duplicate: false, inbound_event_id: "evt-1" }; },
    async updateInboundEvent() { return { ok: true }; },
    async recordMalformed() { return { ok: true }; },
    async findReplyAlias() {
      return resolves
        ? { id: "alias-1", is_active: true, opportunity_id: "opp-1", master_owner_id: "own-1", property_id: "prop-1" }
        : null;
    },
    async findCommunicationsByMessageIds() { return []; },
    async findConversationsForSender() { return []; },
    async createInboundMessage() { return { ok: true, inbound_message_id: "msg-1" }; },
    async ingestAttachments() { return { stored: 0, quarantined: 0, failed: 0 }; },
    async emitCommunicationEvent() { return { ok: true }; },
  };
}

const provider = createBrevoInboundProvider();

function normalizedReply() {
  const result = provider.normalizeInbound({
    Uuid: "attention-0001",
    From: { Address: "seller@example.org", Name: "Sam Seller" },
    To: [{ Address: "r1.aaaaaaaabbbbbbbbccccccccdddddddd@reply.example.net" }],
    RecipientAddress: "r1.aaaaaaaabbbbbbbbccccccccdddddddd@reply.example.net",
    Subject: "Re: your offer",
    RawTextBody: "Yes, still interested.",
  });
  assert.equal(result.ok, true);
  return result.normalized;
}

test("an unmatched reply raises attention from the ingest path itself", async () => {
  const raised = [];
  const outcome = await ingestInboundEmail(
    { normalized: normalizedReply(), trust_class: TRUST_CLASS.AUTHENTICATED },
    {
      ...ingestStore({ resolves: false }),
      emitInboundAttention: async (input) => {
        raised.push(input);
        return { ok: true, emitted: true, reason: "unmatched" };
      },
    }
  );

  assert.equal(outcome.needs_review, true);
  assert.equal(outcome.attention.emitted, true, "the reply was stored and nobody was told");
  assert.equal(raised.length, 1);
  assert.equal(raised[0].event_key, outcome.event_key);
});

test("a resolved reply raises nothing", async () => {
  const raised = [];
  const outcome = await ingestInboundEmail(
    { normalized: normalizedReply(), trust_class: TRUST_CLASS.AUTHENTICATED },
    {
      ...ingestStore({ resolves: true }),
      emitInboundAttention: async (input) => { raised.push(input); return { ok: true, emitted: false }; },
    }
  );
  assert.equal(outcome.needs_review, undefined);
  // The seam still runs -- that is what makes it structural -- but the verdict
  // it reaches is "nobody is owed anything".
  assert.equal(raised.length, 1);
  assert.equal(classifyInboundAttention(raised[0].outcome).needed, false);
  assert.equal(outcome.attention.emitted, false);
});

test("an attention failure never turns a stored reply into a retry", async () => {
  // This is the trade that must not be made: a notification problem must never
  // ask Brevo to send the message again. A missing alert is recovered by the
  // sweep; a duplicated seller message is recovered by nothing.
  const outcome = await ingestInboundEmail(
    { normalized: normalizedReply(), trust_class: TRUST_CLASS.AUTHENTICATED },
    {
      ...ingestStore({ resolves: false }),
      emitInboundAttention: async () => { throw new Error("notifications are down"); },
    }
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.retryable, undefined);
  assert.equal(outcome.inbound_message_id, "msg-1");
});

// ── the sweep: what emission alone cannot guarantee ───────────────────────

/**
 * A Supabase stand-in that serves the two reads the sweep makes and records
 * exactly what it was asked.
 */
function sweepSupabase({ events = [], notified = [] } = {}) {
  const seen = { event_filters: {}, notification_keys: [], limit: null };
  return {
    seen,
    from(table) {
      if (table === "email_inbound_events") {
        const chain = {
          select: () => chain,
          gte: (col, value) => { seen.event_filters[col] = value; return chain; },
          in: (col, values) => { seen.event_filters[col] = values; return chain; },
          order: () => chain,
          limit: (n) => { seen.limit = n; return Promise.resolve({ data: events, error: null }); },
        };
        return chain;
      }
      if (table === "notification_events") {
        const chain = {
          select: () => chain,
          in: (_col, keys) => {
            seen.notification_keys.push(...keys);
            return Promise.resolve({
              data: notified.filter((k) => keys.includes(k)).map((k) => ({ deduplication_key: k })),
              error: null,
            });
          },
        };
        return chain;
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

const UNMATCHED_ROW = {
  id: "evt-sweep-1",
  event_key: "brevo_in:sweep-1",
  from_email: "seller@example.org",
  resolution_status: "unmatched",
  resolution_reason: "reply_token_unknown",
  processing_status: "received",
  inbound_message_id: "msg-sweep-1",
  received_at: "2026-09-14T10:00:00.000Z",
};

test("the sweep recovers a reply whose inline emit was dropped", async () => {
  // The whole reason the sweep exists: emitNotificationFromBusinessEvent
  // swallows its errors, a container can die between the write and the emit,
  // and a deploy can land in between.
  const emitted = [];
  const result = await scanInboundEmailAttention({
    supabase: sweepSupabase({ events: [UNMATCHED_ROW], notified: [] }),
    emitInboundAttention: async (input) => { emitted.push(input); return { ok: true, emitted: true }; },
  });

  assert.equal(result.scanned, 1);
  assert.equal(result.emitted.length, 1);
  assert.equal(emitted[0].event_key, "brevo_in:sweep-1");
  assert.equal(emitted[0].inbound_event_id, "evt-sweep-1");
});

test("the sweep does NOT re-emit something an operator can already see", async () => {
  // Blind re-emission looks safe because the upsert deduplicates. It is not:
  // the upsert increments group_count on every write, so Monday's unmatched
  // reply would read "(288 occurrences)" by Tuesday.
  const emitted = [];
  const result = await scanInboundEmailAttention({
    supabase: sweepSupabase({
      events: [UNMATCHED_ROW],
      notified: ["inbound_email:unmatched:brevo_in:sweep-1"],
    }),
    emitInboundAttention: async (input) => { emitted.push(input); return { ok: true, emitted: true }; },
  });

  assert.equal(result.already_visible, 1);
  assert.equal(emitted.length, 0);
});

test("the sweep does not resurrect a DISMISSED alert", async () => {
  // upsertNotificationEvent revives a dismissed row: `status: existing.status
  // === 'dismissed' ? 'active' : ...`. An operator who dismissed an alert
  // because they had already filed the reply by hand would watch it return on
  // every sweep, which is how a whole category gets muted.
  //
  // A dismissed notification still HAS its dedup key, so the existence check
  // covers this without needing to read status.
  const emitted = [];
  await scanInboundEmailAttention({
    supabase: sweepSupabase({
      events: [UNMATCHED_ROW],
      notified: ["inbound_email:unmatched:brevo_in:sweep-1"],
    }),
    emitInboundAttention: async (input) => { emitted.push(input); return { ok: true, emitted: true }; },
  });
  assert.equal(emitted.length, 0, "a dismissal was overridden");
});

test("an ambiguous row sweeps under its own reason, not the unmatched one", async () => {
  const emitted = [];
  await scanInboundEmailAttention({
    supabase: sweepSupabase({
      events: [{ ...UNMATCHED_ROW, resolution_status: "ambiguous", event_key: "brevo_in:sweep-2" }],
      // The unmatched key for the same event is present; the ambiguous one is
      // not, so it must still emit.
      notified: ["inbound_email:unmatched:brevo_in:sweep-2"],
    }),
    emitInboundAttention: async (input, options) => { emitted.push(options.verdict); return { ok: true, emitted: true }; },
  });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].reason, INBOUND_ATTENTION_REASON.AMBIGUOUS);
});

test("the sweep is BOUNDED in time and in rows", async () => {
  // A sweep that walked all of history would grow without limit and resurrect
  // ancient rows nobody is going to action.
  const supabase = sweepSupabase({ events: [] });
  await scanInboundEmailAttention({ supabase, emitInboundAttention: async () => ({ ok: true, emitted: true }) });

  assert.ok(supabase.seen.limit > 0 && supabase.seen.limit <= 500, `limit was ${supabase.seen.limit}`);
  const since = Date.parse(supabase.seen.event_filters.received_at);
  assert.ok(Number.isFinite(since), "no lookback bound was applied");
  assert.ok(Date.now() - since <= 8 * 24 * 3600_000, "the lookback window is unbounded in practice");
});

test("the sweep asks the database to narrow, not the process", async () => {
  const supabase = sweepSupabase({ events: [] });
  await scanInboundEmailAttention({ supabase, emitInboundAttention: async () => ({ ok: true }) });
  assert.deepEqual(supabase.seen.event_filters.resolution_status, ["unmatched", "ambiguous"]);
});

test("a failed notification lookup emits NOTHING rather than everything", async () => {
  // Emitting anyway would revive every dismissal in the window at once -- the
  // one case where doing nothing is safer than alerting.
  const emitted = [];
  const broken = {
    from(table) {
      if (table === "email_inbound_events") {
        const chain = {
          select: () => chain, gte: () => chain, in: () => chain, order: () => chain,
          limit: () => Promise.resolve({ data: [UNMATCHED_ROW], error: null }),
        };
        return chain;
      }
      const chain = { select: () => chain, in: () => Promise.resolve({ data: null, error: { message: "boom" } }) };
      return chain;
    },
  };

  const result = await scanInboundEmailAttention({
    supabase: broken,
    emitInboundAttention: async (input) => { emitted.push(input); return { ok: true, emitted: true }; },
  });

  assert.equal(emitted.length, 0);
  assert.ok(result.errors.includes("notification_lookup_failed"));
});

test("a failed event read reports an error rather than a clean empty sweep", async () => {
  // A sweep that returns {scanned: 0} on a broken query looks exactly like a
  // sweep that found nothing to do, which is the silent-emptiness shape.
  const broken = {
    from() {
      const chain = {
        select: () => chain, gte: () => chain, in: () => chain, order: () => chain,
        limit: () => Promise.resolve({ data: null, error: { message: "boom" } }),
      };
      return chain;
    },
  };
  const result = await scanInboundEmailAttention({ supabase: broken });
  assert.equal(result.scanned, 0);
  assert.ok(result.errors.includes("inbound_event_read_failed"));
});

test("the sweep never throws, whatever it is handed", async () => {
  for (const supabase of [null, undefined, {}, { from: null }]) {
    await assert.doesNotReject(() => scanInboundEmailAttention({ supabase }), String(supabase));
  }
});

test("the sweep is registered in the platform's existing scan cadence", async () => {
  // Not on a schedule of its own. A backstop nobody runs is not a backstop.
  const source = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../../src/lib/domain/notifications/notification-scanners.js", import.meta.url), "utf8")
  );
  assert.match(source, /scanInboundEmailAttention/);
  assert.match(source, /\['inbound_email', scanInboundEmailAttention\]/);
});
