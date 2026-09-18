/**
 * WHOSE REPLY IS THIS? (§13, §14, §15)
 *
 * An inbound SMS arrives with a phone number and a body. Until now every inbound
 * was assumed to be a seller, because sellers were the only thing the system
 * ever texted. Once buyer outreach exists that assumption starts attributing
 * buyer replies to seller conversations — and worse, feeding them into the S1–S10
 * acquisition lifecycle, where "yes I'm interested" from an investor would read
 * as a homeowner agreeing to sell.
 *
 * This is the classifier that prevents it. It answers one question — does this
 * number belong to buyer outreach we actually sent — and answers it from durable
 * evidence rather than recency alone.
 *
 * THE AMBIGUITY RULE (§14). A buyer firm is contacted about many properties. If
 * the number matches live outreach for more than one property, this does NOT
 * pick the newest and move on: it returns `ambiguous` with every candidate, so
 * the reply can be persisted safely and surfaced for resolution. Attributing an
 * investor's "yes" to an arbitrary one of five properties is worse than
 * admitting the system cannot tell.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not mutate anything. It classifies
 * and returns; the caller decides. Keeping it pure is what makes the seller
 * boundary testable.
 */
import { supabase as defaultSupabase } from "@/lib/supabase/client.js";
import { normalizePhone } from "@/lib/providers/textgrid.js";

const OUTREACH_TABLE = "buyer_outreach_targets";

/** Outreach that could plausibly still receive a reply. */
const REPLYABLE_STATUSES = ["queued", "scheduled", "sending", "sent", "delivered"];

/**
 * How far back an outbound touch can still claim an inbound reply.
 *
 * Long enough for a real investor to answer days later, short enough that a
 * number reused for a different campaign months on does not silently inherit an
 * ancient disposition.
 */
export const BUYER_REPLY_ATTRIBUTION_WINDOW_DAYS = 30;

const clean = (value) => String(value ?? "").trim();

/**
 * Opt-out keywords, matched the way carriers require: the message IS the
 * keyword, not merely contains it. "Please stop sending me listings under
 * 200k" is a negotiation, not an opt-out, and treating it as one silently
 * suppresses a live buyer.
 */
const OPT_OUT_KEYWORDS = new Set([
  "stop", "stopall", "unsubscribe", "cancel", "end", "quit", "optout", "opt-out",
]);

export function isBuyerOptOut(body) {
  const normalized = clean(body).toLowerCase().replace(/[^a-z-]/g, "");
  return OPT_OUT_KEYWORDS.has(normalized);
}

/**
 * Classify an inbound message against buyer outreach.
 *
 * Returns one of:
 *   { domain: 'buyer',  target, opt_out }      exactly one live property matched
 *   { domain: 'ambiguous', candidates }        several — caller must not guess
 *   { domain: 'not_buyer' }                    no buyer outreach to this number
 */
export async function routeInboundBuyerReply({ from_phone_number, body = "", now = new Date() } = {}, deps = {}) {
  const db = deps.supabase || defaultSupabase;
  const phone = normalizePhone(from_phone_number);
  if (!phone) return { domain: "not_buyer", reason: "unparseable_phone" };

  const since = new Date(
    (now instanceof Date ? now.getTime() : new Date(now).getTime())
      - BUYER_REPLY_ATTRIBUTION_WINDOW_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  let rows = []
  try {
    const loader = deps.loadBuyerOutreachByPhone
      ? deps.loadBuyerOutreachByPhone(phone, since)
      : db
        .from(OUTREACH_TABLE)
        .select("*")
        .eq("to_phone_number", phone)
        .in("status", REPLYABLE_STATUSES)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(25)
        .then((r) => {
          if (r.error) throw r.error
          return r.data
        })
    rows = (await loader) || []
  } catch (error) {
    // Unreadable buyer outreach must not be reported as "definitely a seller".
    // An unknown domain is the honest answer and keeps the caller from
    // defaulting into the acquisition lifecycle.
    return { domain: "unknown", reason: "buyer_outreach_unreadable", detail: error?.message || null };
  }

  if (rows.length === 0) return { domain: "not_buyer", reason: "no_recent_buyer_outreach" };

  const opt_out = isBuyerOptOut(body);

  // Ambiguity is measured across PROPERTIES. Several touches about one property
  // is still one disposition and attributes cleanly.
  const byProperty = new Map();
  for (const row of rows) {
    const key = clean(row.property_id);
    if (!byProperty.has(key)) byProperty.set(key, row);
  }

  if (byProperty.size > 1) {
    return {
      domain: "ambiguous",
      opt_out,
      phone,
      // Every live candidate, so an operator resolving this sees the real set.
      candidates: [...byProperty.values()].map((row) => ({
        buyer_outreach_target_id: row.id,
        property_id: row.property_id,
        buyer_key: row.buyer_key,
        buyer_name: row.buyer_name,
        created_at: row.created_at,
      })),
      reason: "multiple_live_properties_for_buyer",
    };
  }

  const target = rows[0];
  return {
    domain: "buyer",
    opt_out,
    phone,
    target: {
      buyer_outreach_target_id: target.id,
      property_id: target.property_id,
      buyer_key: target.buyer_key,
      buyer_entity_id: target.buyer_entity_id,
      buyer_name: target.buyer_name,
      touch_number: target.touch_number,
      send_queue_key: target.send_queue_key,
    },
  };
}

/**
 * §15 — the boundary, stated as code so a test can hold it.
 *
 * Buyer traffic shares transport with seller traffic and shares nothing else.
 * Anything that would advance an acquisition stage, write seller facts or
 * schedule seller follow-up must consult this first.
 */
export function mayMutateSellerLifecycle(classification) {
  return classification?.domain === "not_buyer";
}
