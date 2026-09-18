/**
 * THE BUYER BOUNDARY, ON THE LIVE INBOUND PATH (§13, §15, §19-§23).
 *
 * `routeInboundBuyerReply` could answer "whose reply is this" from the day it
 * was written, but nothing asked it. The production inbound handler still
 * assumed every inbound SMS was a seller, because sellers were the only thing
 * the system had ever texted. This is the call site that makes the boundary
 * real: the handler consults it before any seller work, and a buyer reply stops
 * here instead of being classified as a homeowner's answer and advancing S1-S10.
 *
 * WHY IT RUNS BEFORE THE IDEMPOTENCY CLAIM. A claim marks the message as
 * processed. If classification then deferred the message, the retry would be
 * refused as a duplicate and the reply would be lost. Asking first costs one
 * indexed read on a phone number.
 *
 * THE FOUR ANSWERS, AND WHAT EACH DOES:
 *
 *   buyer      Handled here and NOT passed to the seller pipeline. The outreach
 *              target records the reply.
 *   ambiguous  Also diverted, and deliberately NOT resolved by guessing. A buyer
 *              firm contacted about five properties gets its reply attached to
 *              all five as candidates for an operator to resolve. Picking the
 *              newest would silently attribute an investor's "yes" to an
 *              arbitrary property.
 *   unknown    Buyer outreach was UNREADABLE. Fail closed and defer: the message
 *              is neither dropped nor attributed. `mayMutateSellerLifecycle`
 *              already states that an unknown domain must not enter the seller
 *              lifecycle, and deferring rather than discarding is what makes
 *              that safe — a transient read error delays a seller reply by one
 *              retry instead of losing it.
 *   not_buyer  The only answer that lets the seller pipeline proceed.
 *
 * OPT-OUT IS HONOURED REGARDLESS OF DOMAIN (§22). "STOP" from a buyer is a
 * carrier-level instruction, not a disposition signal, and it is written to the
 * same destination-keyed `sms_suppression_list` seller traffic uses. There is no
 * separate buyer suppression policy to get out of step.
 */
import { supabase as defaultSupabase } from "@/lib/supabase/client.js";
import { normalizePhone } from "@/lib/providers/textgrid.js";
import {
  isBuyerOptOut,
  mayMutateSellerLifecycle,
  routeInboundBuyerReply,
} from "@/lib/domain/buyers/route-inbound-buyer-reply.js";

const OUTREACH_TABLE = "buyer_outreach_targets";

/** Destination-level suppression — the same authority, not a buyer copy of it. */
async function suppressBuyerNumber(db, phone, now, deps = {}) {
  if (typeof deps.suppressPhone === "function") return deps.suppressPhone(phone);
  await db.from("sms_suppression_list").upsert(
    {
      phone_e164: phone,
      sender_phone_e164: null,
      phone_number: phone,
      suppression_type: "recipient_opt_out",
      suppression_reason: "buyer_replied_stop",
      is_active: true,
      suppressed_at: now,
      source: "inbound_buyer_opt_out",
    },
    { onConflict: "phone_e164,sender_phone_e164", ignoreDuplicates: false }
  );
}

/**
 * Classify an inbound and, when it is buyer traffic, deal with it.
 *
 * Returns `{ handled }`. `handled: false` means the seller pipeline should
 * continue exactly as before — the overwhelmingly common case, and the one this
 * must not slow down or change.
 */
export async function handleInboundBuyerReply(
  { from_phone_number, body = "", now = new Date().toISOString() } = {},
  deps = {}
) {
  const db = deps.supabase || defaultSupabase;
  const classification = await routeInboundBuyerReply(
    { from_phone_number, body, now: new Date(now) },
    deps
  );

  if (mayMutateSellerLifecycle(classification)) {
    return { handled: false, domain: classification.domain };
  }

  const phone = normalizePhone(from_phone_number);

  if (classification.domain === "unknown") {
    // Nothing is written and nothing is claimed. The caller defers.
    return {
      handled: true,
      defer: true,
      domain: "unknown",
      reason: classification.reason || "buyer_domain_unresolved",
    };
  }

  const opt_out = isBuyerOptOut(body);
  const errors = [];

  if (opt_out && phone) {
    try {
      await suppressBuyerNumber(db, phone, now, deps);
    } catch (error) {
      // A failed suppression write is reported, never swallowed: silently
      // failing to honour STOP is a compliance failure, not a bookkeeping one.
      errors.push(`suppression_failed:${error?.message || "unknown"}`);
    }
  }

  const targets = classification.domain === "ambiguous"
    ? (classification.candidates || []).map((c) => c.buyer_outreach_target_id)
    : [classification.target?.buyer_outreach_target_id];

  for (const target_id of targets.filter(Boolean)) {
    try {
      if (typeof deps.recordBuyerReply === "function") {
        await deps.recordBuyerReply({ target_id, body, opt_out, ambiguous: classification.domain === "ambiguous", now });
        continue;
      }
      await db.from(OUTREACH_TABLE).update({
        replied_at: now,
        reply_body: String(body ?? "").slice(0, 2000),
        reply_is_opt_out: opt_out,
        // An ambiguous reply is marked as such on every candidate, so no
        // surface can present one of them as the confirmed answer.
        reply_attribution: classification.domain === "ambiguous" ? "ambiguous" : "attributed",
        updated_at: now,
      }).eq("id", target_id);
    } catch (error) {
      errors.push(`reply_write_failed:${error?.message || "unknown"}`);
    }
  }

  return {
    handled: true,
    defer: false,
    domain: classification.domain,
    opt_out,
    phone,
    target_ids: targets.filter(Boolean),
    candidates: classification.candidates || null,
    errors: errors.length ? errors : null,
  };
}
