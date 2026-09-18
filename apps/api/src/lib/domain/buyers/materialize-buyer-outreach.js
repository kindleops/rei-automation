/**
 * BUYER OUTREACH, THROUGH THE CANONICAL QUEUE (§5, §13).
 *
 * What this replaces: `send-buyer-blast.js` picked recipients in memory and
 * called `sendTextgridSMS` directly. No queue row, so no claim, lease or lock;
 * no idempotency, so a retried request re-sent; no contact window, so nothing
 * stopped a 2 AM blast; no suppression check; and nothing durable for a delivery
 * receipt or an inbound reply to reconcile against.
 *
 * What this does instead: it persists what the operator INTENDS (a
 * `buyer_outreach_targets` row per buyer/property/touch), then hands execution
 * to `insertSupabaseSendQueueRow` — the one canonical queue writer every other
 * producer already uses. Buyer work then inherits, without re-implementing any
 * of it: sender selection and dispatch-time revalidation, the contact window,
 * canonical send authority including operator emergency stop, claim/lease
 * discipline, daily caps, provider reconciliation and retry semantics.
 *
 * IT IS NOT A SECOND QUEUE. `send_queue` executes; this table explains.
 *
 * Eligibility is decided here, at materialization, so the operator sees
 * "10 selected · 8 eligible · 2 blocked" with reasons BEFORE anything is
 * scheduled — rather than discovering it as silent failures afterwards.
 */
import { supabase as defaultSupabase } from "@/lib/supabase/client.js";
import { normalizePhone } from "@/lib/providers/textgrid.js";
import { insertSupabaseSendQueueRow } from "@/lib/supabase/sms-engine.js";
import { BUYER_DISPOSITION_SEND_KIND } from "@/lib/domain/buyers/buyer-send-kind.js";

const OUTREACH_TABLE = "buyer_outreach_targets";
const SUPPRESSION_TABLE = "sms_suppression_list";

const clean = (value) => String(value ?? "").trim();

/** Live statuses, matching the partial unique indexes on both tables. */
export const LIVE_OUTREACH_STATUSES = ["planned", "queued", "scheduled", "sending"];

/**
 * One deterministic identity for a buyer touch.
 *
 * Shared by the outreach row and the queue row, so `uq_send_queue_active_dedupe_key`
 * — which already prevents duplicate LIVE seller work — does the same job for
 * buyers without a second mechanism being invented. Deterministic rather than
 * random because a retried request must collide with its own earlier attempt.
 */
export function buyerOutreachDedupeKey({ property_id, buyer_key, touch_number = 1 }) {
  return `buyer:${clean(property_id)}:${clean(buyer_key)}:${Number(touch_number) || 1}`;
}

/**
 * Destination-level suppression, the same authority seller traffic uses.
 *
 * `sms_suppression_list` is keyed on `phone_e164`, not on any seller
 * relationship, so it already governs buyer destinations correctly. §7 is
 * explicit that being a buyer is not a reason to skip it, and inventing a
 * parallel buyer list would have created exactly the second policy the audit
 * spent this long removing elsewhere.
 */
async function loadSuppressedPhones(db, phones, deps = {}) {
  if (typeof deps.loadSuppressedPhones === "function") return deps.loadSuppressedPhones(phones);
  if (phones.length === 0) return new Set();

  const { data, error } = await db
    .from(SUPPRESSION_TABLE)
    .select("phone_e164,is_active")
    .in("phone_e164", phones);
  if (error) throw error;

  return new Set(
    (Array.isArray(data) ? data : [])
      .filter((row) => row.is_active !== false)
      .map((row) => normalizePhone(row.phone_e164))
      .filter(Boolean)
  );
}

/**
 * Decide each selected buyer's fate before anything is written.
 *
 * Returns eligible targets and blocked ones WITH REASONS. A buyer with no phone
 * is a real outcome the operator should see, not a row to drop quietly (§20).
 */
export function classifyBuyerTargets(buyers, { suppressed = new Set() } = {}) {
  const eligible = [];
  const blocked = [];
  const seen = new Set();

  for (const buyer of Array.isArray(buyers) ? buyers : []) {
    const buyer_key = clean(buyer.buyer_key);
    const phone = normalizePhone(buyer.to_phone_number ?? buyer.phone);

    if (!buyer_key) {
      blocked.push({ ...buyer, blocked_reason: "missing_buyer_identity" });
      continue;
    }
    // Contact resolution may already have decided this buyer's fate — a
    // do-not-contact flag must not be relabelled as a generic "no phone".
    if (clean(buyer.blocked_reason)) {
      blocked.push({ ...buyer, buyer_key });
      continue;
    }
    if (!phone) {
      blocked.push({ ...buyer, buyer_key, blocked_reason: "no_phone" });
      continue;
    }
    if (suppressed.has(phone)) {
      blocked.push({ ...buyer, buyer_key, to_phone_number: phone, blocked_reason: "suppressed" });
      continue;
    }
    // A selection that names the same buyer twice is the operator's slip, not a
    // reason to create two live touches.
    if (seen.has(buyer_key)) {
      blocked.push({ ...buyer, buyer_key, to_phone_number: phone, blocked_reason: "duplicate_selection" });
      continue;
    }

    seen.add(buyer_key);
    eligible.push({ ...buyer, buyer_key, to_phone_number: phone });
  }

  return { eligible, blocked };
}

/**
 * Persist intent, then queue it.
 *
 * `dry_run` produces the full eligibility verdict and writes nothing, which is
 * what the mobile outreach sheet reads to show its counts before the operator
 * commits.
 */
export async function materializeBuyerOutreach({
  property_id,
  buyers = [],
  message_body = null,
  template_id = null,
  scheduled_at = null,
  touch_number = 1,
  outreach_source = "buyer_match",
  dry_run = true,
} = {}, deps = {}) {
  const db = deps.supabase || defaultSupabase;
  const insert_queue_row = deps.insertSupabaseSendQueueRow || insertSupabaseSendQueueRow;
  const now = deps.now || new Date().toISOString();

  if (!clean(property_id)) {
    return { ok: false, reason: "missing_property_id", eligible: 0, blocked: [] };
  }

  const phones = buyers
    .map((b) => normalizePhone(b.to_phone_number ?? b.phone))
    .filter(Boolean);

  let suppressed;
  try {
    suppressed = await loadSuppressedPhones(db, phones, deps);
  } catch (error) {
    // Unreadable suppression is NOT permission to send. Refuse the whole batch
    // rather than queue work whose eligibility was never established.
    return {
      ok: false,
      reason: "suppression_unavailable",
      detail: error?.message || "suppression_read_failed",
      eligible: 0,
      blocked: [],
    };
  }

  const { eligible, blocked } = classifyBuyerTargets(buyers, { suppressed });

  if (dry_run) {
    return {
      ok: true,
      dry_run: true,
      selected: buyers.length,
      eligible: eligible.length,
      blocked,
      targets: [],
    };
  }

  const targets = [];
  for (const buyer of eligible) {
    const dedupe_key = buyerOutreachDedupeKey({ property_id, buyer_key: buyer.buyer_key, touch_number });

    const row = {
      property_id: clean(property_id),
      buyer_key: buyer.buyer_key,
      buyer_entity_id: clean(buyer.buyer_entity_id) || null,
      buyer_name: clean(buyer.buyer_name) || null,
      buyer_match_run_id: buyer.buyer_match_run_id || null,
      buyer_match_candidate_id: buyer.buyer_match_candidate_id || null,
      to_phone_number: buyer.to_phone_number,
      touch_number,
      outreach_source,
      template_id,
      message_body,
      scheduled_at,
      status: scheduled_at ? "scheduled" : "planned",
      dedupe_key,
      created_at: now,
      updated_at: now,
    };

    // The partial unique index decides duplicates, not this code. A collision
    // means a live touch already exists, which is the correct answer.
    const { data, error } = await db.from(OUTREACH_TABLE).insert(row).select().limit(1);
    if (error) {
      blocked.push({ ...buyer, blocked_reason: /duplicate|unique/i.test(error.message || "")
        ? "duplicate_touch"
        : "outreach_write_failed" });
      continue;
    }

    const target = Array.isArray(data) && data.length > 0 ? data[0] : { ...row };

    /**
     * Seller columns stay NULL on purpose (§15). thread_key, prospect_id and
     * master_owner_id describe a seller conversation that does not exist here,
     * and faking one to satisfy old validation is precisely what the brief
     * forbids. Identity travels in metadata; `property_id` is legitimately the
     * subject of the disposition.
     */
    const queue_result = await insert_queue_row({
      queue_key: dedupe_key,
      queue_id: dedupe_key,
      dedupe_key,
      to_phone_number: buyer.to_phone_number,
      message_body,
      property_id: clean(property_id),
      touch_number,
      queue_status: scheduled_at ? "scheduled" : "queued",
      scheduled_for: scheduled_at,
      /**
       * The send kind travels in METADATA, not as a column.
       *
       * `send_queue` has no `send_kind` column — `manual_inbox` is carried the
       * same way. A top-level field would not fail the insert (the canonical
       * writer sweeps unknown keys into `metadata.unknown_payload_fields`), it
       * would do something worse: silently move the marker somewhere nothing
       * reads, so every buyer row would come back out of the database looking
       * like seller traffic.
       */
      metadata: {
        send_kind: BUYER_DISPOSITION_SEND_KIND,
        outreach_domain: "buyer",
        outreach_source,
        buyer_outreach_target_id: target.id ?? null,
        buyer_key: buyer.buyer_key,
        buyer_entity_id: buyer.buyer_entity_id ?? null,
        buyer_name: buyer.buyer_name ?? null,
        subject_property_id: clean(property_id),
        buyer_match_run_id: buyer.buyer_match_run_id ?? null,
        touch_number,
      },
    }, deps);

    if (queue_result?.ok === false) {
      await db.from(OUTREACH_TABLE)
        .update({ status: "blocked", blocked_reason: "queue_write_failed", updated_at: now })
        .eq("id", target.id);
      blocked.push({ ...buyer, blocked_reason: "queue_write_failed" });
      continue;
    }

    await db.from(OUTREACH_TABLE)
      .update({
        status: scheduled_at ? "scheduled" : "queued",
        send_queue_key: dedupe_key,
        send_queue_id: queue_result?.row?.id ?? queue_result?.id ?? null,
        updated_at: now,
      })
      .eq("id", target.id);

    targets.push({ ...target, send_queue_key: dedupe_key });
  }

  return {
    ok: true,
    dry_run: false,
    selected: buyers.length,
    eligible: targets.length,
    blocked,
    targets,
  };
}
