/**
 * Repeat-asking-price guard, END TO END on a DISPOSABLE PostgreSQL (rc-8.5.15.1):
 * the real app row builders (canonical writer payload, send-now service) write
 * into a send_queue that carries the LIVE production triggers
 * (scripts/db/fixtures/send_queue_live_baseline.sql), first with the live guard
 * (the gap is reproduced), then with PROPOSED_20261015120000 applied.
 *
 * AGENT_PG_TEST_DB_URL must be a loopback scratch server (skipped — reported,
 * never vacuous — without it). Production is refused by scripts/db/db-target-guard.mjs.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { assertDisposableTarget } from "../../../../scripts/db/db-target-guard.mjs";
import { buildSendQueueInsertPayload } from "@/lib/supabase/sms-engine.js";
import { createInboxSendNowQueueRow } from "@/lib/domain/inbox/send-now-service.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const FILES = {
  shim: path.join(REPO, "apps/api/tests/pg/supabase-shim.sql"),
  baseline: path.join(REPO, "scripts/db/fixtures/send_queue_live_baseline.sql"),
  migration: path.join(REPO, "supabase/migrations/PROPOSED_20261015120000_repeat_asking_price_question_kind.sql"),
  rollback: path.join(REPO, "supabase/migrations/PROPOSED_20261015120000_repeat_asking_price_question_kind_rollback.sql"),
};
const ADMIN = String(process.env.AGENT_PG_TEST_DB_URL || "").trim();
const skip = ADMIN ? false : "AGENT_PG_TEST_DB_URL not set (disposable local PostgreSQL 17)";
if (ADMIN) assertDisposableTarget(ADMIN);

async function freshDb() {
  const name = `rap_${crypto.randomBytes(5).toString("hex")}`;
  const admin = new pg.Pool({ connectionString: ADMIN, max: 1 });
  await admin.query(`create database ${name}`);
  await admin.end();
  const u = new URL(ADMIN);
  u.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: u.toString(), max: 4 });
  pool.on("error", () => {});
  for (const f of [FILES.shim, FILES.baseline]) await pool.query(fs.readFileSync(f, "utf8"));
  return {
    pool,
    async drop() {
      await pool.end().catch(() => {});
      const a = new pg.Pool({ connectionString: ADMIN, max: 1 });
      await a.query(`drop database if exists ${name} with (force)`).catch(() => {});
      await a.end();
    },
  };
}

const SELLER = "+16125550188";
const SENDER = "+16128060495";

/** Insert exactly what the canonical writer would send to PostgREST. */
async function insertCanonical(pool, row) {
  const payload = buildSendQueueInsertPayload({ to_phone_number: SELLER, from_phone_number: SENDER, thread_key: SELLER, queue_status: "queued", ...row });
  const cols = Object.keys(payload);
  const { rows } = await pool.query(
    `insert into public.send_queue (${cols.map((c) => `"${c}"`).join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning *`,
    cols.map((c) => (payload[c] !== null && typeof payload[c] === "object" ? JSON.stringify(payload[c]) : payload[c])),
  );
  return rows[0];
}

// the send-now duplicate-fingerprint lookup reads send_queue through PostgREST; here: none
const noDuplicates = { from: () => { const c = { select: () => c, eq: () => c, in: () => c, contains: () => c, gte: async () => ({ count: 0 }) }; return c; } };

const sendNowDeps = (pool) => ({
  supabase: noDuplicates,
  getSystemValue: async () => null,
  env: {},
  loadOutboundNumberByPhone: async (phone) => ({ id: "n1", phone_number: phone, status: "active", health_state: "unverified", daily_limit: 800, messages_sent_today: 0 }),
  loadThreadSender: async () => null,
  routeThreadFallback: async () => null,
  resolveOperatorAction: async () => ({ ok: true, operator_action_id: "opa-1" }),
  hardComplianceCheckImpl: async () => ({ blocked: false }),
  canSendImpl: async () => ({ ok: true }),
  checkBlacklistPriorFailureImpl: async () => ({ blocked: false }),
  recentDeliveryFailuresImpl: async () => ({ suppress: false }),
  insertImpl: async (row) => {
    const raw = await insertCanonical(pool, row);
    return { ok: true, queue_row_id: raw.id, queue_item_id: raw.id, raw };
  },
});

const typedAsk = (extra = {}) => ({
  thread_key: SELLER, to_phone_number: SELLER, from_phone_number: SENDER,
  message_body: "Do you have an asking price in mind?", action: "send_now", source: "manual_inbox", ...extra,
});

test("PG: the live guard misses an operator-typed repeat ask; the PROPOSED guard cancels it on every path, allows the S3 follow-up only after silence, honours the audited override, never raises; rollback restores the live body", { skip }, async () => {
  const db = await freshDb();
  try {
    const { pool } = db;
    // the first ask: a delivered template ask two hours ago
    const first = await insertCanonical(pool, { queue_key: "t:first", use_case_template: "seller_asking_price", message_body: "Do you have an asking price in mind for the property?" });
    await pool.query("update public.send_queue set queue_status = 'delivered', sent_at = now() - interval '2 hours' where id = $1", [first.id]);

    // THE GAP (live body): an operator-typed repeat ask goes through
    const gap = await createInboxSendNowQueueRow(typedAsk(), sendNowDeps(pool));
    assert.equal(gap.ok, true, "live guard: manual_reply is invisible to it");
    await pool.query("update public.send_queue set queue_status = 'cancelled' where id = $1", [gap.queue_row_id]);

    await pool.query(fs.readFileSync(FILES.migration, "utf8"));

    // manual send-now: blocked, reported as 409 (never ok:true), override offered
    const blocked = await createInboxSendNowQueueRow(typedAsk({ message_body: "Any asking price in mind?" }), sendNowDeps(pool));
    assert.equal(blocked.ok, false);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.reason, "repeat_asking_price_blocked");
    assert.equal(blocked.repeat_ask_override_allowed, true);
    const row = (await pool.query("select queue_status, paused_reason, metadata from public.send_queue where id = $1", [blocked.queue_row_id])).rows[0];
    assert.equal(row.queue_status, "cancelled");
    assert.equal(row.metadata.question_kind, "asking_price");
    assert.equal(row.metadata.repeat_ask_guard.rule, "repeat_asking_price");

    // Spanish, AI conversation, nurture, template: all cancelled
    for (const r of [
      { queue_key: "t:es", use_case_template: "manual_reply", message_body: "¿Cuánto pide por la propiedad?" },
      { queue_key: "t:ai", use_case_template: "ai_reply", source: "ai_conversation", message_body: "Thanks! What would you take for it?", metadata: { source: "ai_conversation" } },
      { queue_key: "t:nurture", queue_status: "scheduled", use_case_template: "nurture_not_interested", message_body: "Checking in — do you have a number in mind?" },
      { queue_key: "t:tpl", use_case_template: "asking_price_follow_up", message_body: "Just checking back on that." },
    ]) {
      const ins = await insertCanonical(pool, r);
      assert.equal(ins.queue_status, "cancelled", r.queue_key);
      assert.equal(ins.paused_reason, "blocked_repeat_asking_price", r.queue_key);
    }
    // a non-ask passes
    assert.equal((await insertCanonical(pool, { queue_key: "t:roof", use_case_template: "manual_reply", message_body: "How is the roof?" })).queue_status, "queued");

    // the audited override passes THIS guard and records actor / reason / at
    const ovr = await createInboxSendNowQueueRow(typedAsk({ message_body: "To clarify — what price would you be looking for?", repeat_ask_override: true, repeat_ask_override_actor: "op-uuid-1", override_reason: "Seller asked what we meant by price" }), sendNowDeps(pool));
    assert.equal(ovr.ok, true, JSON.stringify(ovr));
    const ovrRow = (await pool.query("select queue_status, metadata from public.send_queue where id = $1", [ovr.queue_row_id])).rows[0];
    assert.equal(ovrRow.queue_status, "queued");
    assert.equal(ovrRow.metadata.repeat_ask_override.actor, "op-uuid-1");
    assert.equal(ovrRow.metadata.operator_override, false);
    await pool.query("update public.send_queue set queue_status = 'cancelled' where id = $1", [ovr.queue_row_id]);

    // (c) the S3 no-response follow-up: allowed after silence …
    const fu1 = await insertCanonical(pool, { queue_key: "t:fu1", queue_status: "scheduled", use_case_template: "s3_no_response_fu1", message_body: "[deferred]", metadata: { no_response_followup: { kind: "s3_asking_price", step: 0 } } });
    assert.equal(fu1.queue_status, "scheduled");
    // … cancelled once the seller replied after the latest ask
    await pool.query("insert into public.message_events (thread_key, direction, message_body, event_timestamp) values ($1, 'inbound', 'not sure', now() - interval '1 hour')", [SELLER]);
    const fu2 = await insertCanonical(pool, { queue_key: "t:fu2", queue_status: "scheduled", use_case_template: "s3_no_response_fu2", message_body: "[deferred]", metadata: { no_response_followup: { kind: "s3_asking_price", step: 1 } } });
    assert.equal(fu2.queue_status, "cancelled");
    assert.equal(fu2.paused_reason, "blocked_repeat_asking_price_seller_replied");
    // and send-now never offers an override for that
    const replied = await createInboxSendNowQueueRow(typedAsk({ message_body: "What number are you at?" }), sendNowDeps(pool));
    assert.equal(replied.reason, "repeat_asking_price_blocked");

    // never raises on odd rows
    await pool.query("insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, thread_key, use_case_template, metadata) values ('t:null', 'queued', 'x', $1, $2, 'seller_asking_price', null)", [SELLER, SELLER]);

    // rollback restores the live body verbatim
    await pool.query(fs.readFileSync(FILES.rollback, "utf8"));
    const live = (await pool.query("select prosrc from pg_proc where proname = 'block_repeat_asking_price'")).rows[0].prosrc;
    const baselineBody = /FUNCTION public\.block_repeat_asking_price\(\)[\s\S]*?AS \$function\$([\s\S]*?)\$function\$;/.exec(fs.readFileSync(FILES.baseline, "utf8"));
    assert.ok(baselineBody, "baseline body found");
    assert.equal(live, baselineBody[1], "rollback body = live production body");
  } finally {
    await db.drop();
  }
});
