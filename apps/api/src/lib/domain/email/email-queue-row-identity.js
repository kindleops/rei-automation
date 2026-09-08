/**
 * email-queue-row-identity.js
 *
 * Answers one question about an `email_queue` row: WHICH seller communication
 * does this row schedule?
 *
 * The SMS twin of this file is domain/communications/queue-row-identity.js, and
 * the rule it obeys is the same one: THE ANSWER MAY BE "I DO NOT KNOW", AND THAT
 * IS A REFUSAL. `queue_status = 'queued'` is a scheduling fact, not evidence
 * that a seller should receive a message. A row that cannot name its domain
 * action does not reach the provider.
 *
 * WHY A SEPARATE RESOLVER RATHER THAN A SHARED ONE.
 *   The two queues have different column names for the same ideas
 *   (`to_phone_number` / `to_email`, `metadata.decision_id` /
 *   `decision_id`), and they speak for different channels. A single resolver
 *   taking a channel argument would have to guess which shape it was reading,
 *   and a resolver that guesses is exactly what lck_v2 exists to remove. Each
 *   resolver states the channel it speaks for as a constant, so a row can never
 *   be resolved against the wrong one.
 *
 * ANCHORS COME FROM COLUMNS, NOT FROM METADATA.
 *   The SMS resolver reads several anchors out of `metadata` because the SMS
 *   queue predates §11 and those columns do not exist on it. `email_queue` was
 *   given real columns for every anchor in the EMAIL-1 migration, so this
 *   resolver reads columns and falls back to metadata only for rows written by
 *   an older enqueuer. Reading a column is a fact; reading metadata is a hope.
 */

import {
  COMMUNICATION_CHANNELS,
  COMMUNICATION_TYPES,
} from "@/lib/domain/communications/logical-communication-key.js";

/** This resolver reads email_queue, and nothing else. */
const QUEUE_CHANNEL = COMMUNICATION_CHANNELS.EMAIL;

/**
 * Use cases that state a price. Identity must be the OFFER and its VERSION, so a
 * transport retry cannot quietly deliver different terms than the ones
 * authorised. Kept in step with the SMS resolver's list on purpose: an offer is
 * an offer whichever pipe carries it.
 */
const MONETARY_USE_CASES = new Set([
  "initial_offer", "conditional_offer", "counter_offer", "final_offer", "offer_reveal_cash",
]);

function clean(value) {
  return String(value ?? "").trim();
}

function readMetadata(queue_row) {
  const md = queue_row?.metadata;
  return md && typeof md === "object" && !Array.isArray(md) ? md : {};
}

/** Column first, metadata second. Never a generated value. */
function anchor(queue_row, md, column, metadata_key = column) {
  return clean(queue_row?.[column]) || clean(md?.[metadata_key]);
}

/** offer_id has the shape `offer:<opportunity_id>:v<N>`; N is the version. */
function parseOfferVersion(offer_id) {
  const match = /:v(\d+)$/.exec(String(offer_id ?? ""));
  return match ? match[1] : null;
}

function readMonetaryIdentity(queue_row = {}, md = {}) {
  const use_case = clean(anchor(queue_row, md, "use_case", "use_case")).toLowerCase();
  const seller_offer_id = anchor(queue_row, md, "seller_offer_id", "offer_id");
  const seller_offer_version =
    anchor(queue_row, md, "seller_offer_version", "offer_version")
    || parseOfferVersion(seller_offer_id)
    || "";
  return {
    use_case,
    is_monetary: MONETARY_USE_CASES.has(use_case),
    present: Boolean(seller_offer_id),
    anchors: { seller_offer_id, seller_offer_version },
  };
}

/**
 * @returns {{ok:true, bound:true, logical_communication_id:string}
 *          |{ok:true, bound:false, communication_type:string, anchors:object, lineage:object}
 *          |{ok:false, reason:string}}
 */
export function resolveEmailQueueRowIdentity(input) {
  // `= {}` only defaults an UNDEFINED argument, so an explicit null would reach
  // the property reads and throw. A TypeError escaping an identity resolver is
  // worse than a refusal: a caller may catch it and mistake it for a transport
  // failure, which is the one reading that could justify a retry.
  const queue_row = input && typeof input === "object" ? input : {};
  const md = readMetadata(queue_row);

  const lineage = {
    channel: QUEUE_CHANNEL,
    thread_key: clean(queue_row.thread_key) || null,
    to_email: clean(queue_row.to_email).toLowerCase() || null,
    campaign_id: clean(queue_row.campaign_id) || null,
    property_id: clean(queue_row.property_id) || clean(md.property_id) || null,
    master_owner_id: clean(queue_row.master_owner_id) || clean(md.master_owner_id) || null,
  };

  const monetary = readMonetaryIdentity(queue_row, md);

  // ── already bound: the row names its action outright ─────────────────────
  const bound = clean(queue_row.logical_communication_id);
  if (bound) {
    return {
      ok: true,
      bound: true,
      logical_communication_id: bound,
      ...(monetary.present ? { monetary: monetary.anchors } : {}),
    };
  }

  // ── monetary offer: the OFFER and its VERSION are the action ─────────────
  // Checked before the campaign touch, for the same reason as SMS: a priced
  // message sent inside a campaign is still a monetary communication, and
  // binding it to the touch would let a retry deliver a different authorised
  // amount under the same identity.
  if (monetary.is_monetary) {
    const { seller_offer_id, seller_offer_version } = monetary.anchors;
    if (!seller_offer_id || !seller_offer_version) {
      return {
        ok: false,
        reason: "monetary_communication_without_offer_authority",
        queue_row_id: clean(queue_row.id) || null,
        use_case: monetary.use_case,
      };
    }
    return {
      ok: true,
      bound: false,
      communication_type: COMMUNICATION_TYPES.MONETARY_OFFER,
      anchors: {
        channel: QUEUE_CHANNEL,
        offer_id: seller_offer_id,
        offer_version: seller_offer_version,
      },
      lineage: { ...lineage, seller_offer_id, seller_offer_version },
      monetary: monetary.anchors,
    };
  }

  // ── campaign touch: target + touch number ARE the action ─────────────────
  const campaign_target_id = anchor(queue_row, md, "campaign_target_id");
  const touch_number = queue_row.touch_number ?? md.touch_number;
  if (campaign_target_id && Number.isInteger(Number(touch_number)) && Number(touch_number) >= 1) {
    return {
      ok: true,
      bound: false,
      communication_type: COMMUNICATION_TYPES.CAMPAIGN_TOUCH,
      anchors: {
        channel: QUEUE_CHANNEL,
        campaign_target_id,
        touch_number: String(touch_number),
      },
      lineage: { ...lineage, campaign_target_id, touch_number: String(touch_number) },
    };
  }

  const decision_id = anchor(queue_row, md, "decision_id");
  if (decision_id) {
    return {
      ok: true,
      bound: false,
      communication_type: COMMUNICATION_TYPES.AUTONOMOUS_REPLY,
      anchors: { channel: QUEUE_CHANNEL, decision_id },
      lineage: { ...lineage, decision_id },
    };
  }

  const follow_up_id = anchor(queue_row, md, "follow_up_id");
  if (follow_up_id) {
    return {
      ok: true,
      bound: false,
      communication_type: COMMUNICATION_TYPES.FOLLOW_UP,
      anchors: { channel: QUEUE_CHANNEL, follow_up_id },
      lineage: { ...lineage, follow_up_id },
    };
  }

  const operator_action_id = anchor(queue_row, md, "operator_action_id");
  if (operator_action_id) {
    return {
      ok: true,
      bound: false,
      communication_type: COMMUNICATION_TYPES.MANUAL_OPERATOR_SEND,
      anchors: { channel: QUEUE_CHANNEL, operator_action_id },
      lineage: { ...lineage, operator_action_id },
    };
  }

  const message_event_id = anchor(queue_row, md, "message_event_id");
  if (message_event_id) {
    return {
      ok: true,
      bound: false,
      communication_type: COMMUNICATION_TYPES.UNKNOWN_INBOUND_REPLY,
      anchors: { channel: QUEUE_CHANNEL, message_event_id },
      lineage: { ...lineage, message_event_id },
    };
  }

  // ── no derivable action: REFUSE ──────────────────────────────────────────
  // Not "send it anyway because it is queued".
  return {
    ok: false,
    reason: "email_queue_row_identity_underivable",
    queue_row_id: clean(queue_row.id) || null,
  };
}

export default resolveEmailQueueRowIdentity;
