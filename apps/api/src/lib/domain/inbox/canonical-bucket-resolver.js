import { clean } from "@/lib/utils/strings.js";

function asTime(value) {
  const ts = new Date(value || 0).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

/**
 * Resolves the canonical inbox bucket based on thread state and classification.
 * This ensures the JS ingestion layer and the UI truth model are perfectly aligned.
 */
export function resolveCanonicalBucket({
  threadState = {},
  classification = {},
  direction = "inbound",
  nowMs = Date.now(),
} = {}) {
  const is_outbound = direction === "outbound";
  
  // 1. Combine flags from classification (if inbound) and existing state
  const primary = is_outbound ? clean(threadState.primary_intent) : clean(classification.primary_intent || threadState.primary_intent);
  const objection = is_outbound ? clean(threadState.objection) : clean(classification.objection || threadState.objection);
  const compliance = clean(classification.compliance_flag);

  const existingStatus = clean(threadState.universal_status || threadState.status);
  const existingBucket = clean(threadState.inbox_bucket);
  
  // Explicit hard flags
  const is_stop = compliance === "stop_texting" || primary === "opt_out" || threadState.opt_out === true;
  const is_hostile = primary === "hostile_or_legal" || primary === "legal_threat" || objection === "hostile_legal";
  const is_wrong_number = primary === "wrong_number" || objection === "wrong_number" || threadState.wrong_number === true;
  const property_status = clean(classification.property_status || threadState.property_status);

  // 1. SUPPRESSED (Terminal)
  // Rules: STOP, unsubscribe, wrong number, hostile, do not contact
  if (is_stop || is_hostile || is_wrong_number || existingStatus === "suppressed" || existingBucket === "suppressed") {
    return "suppressed";
  }

  // 2. DEAD (Terminal)
  // Rules: Only dead if explicitly marked dead previously, or sold with confirmation.
  // We no longer send "not interested" or "no" to dead aggressively.
  if (existingStatus === "dead" || existingBucket === "dead") {
    return "dead";
  }

  // 3. PRIORITY
  // Rules: Positive interest, yes, call me, under contract, active negotiation
  const priority_intents = [
    "seller_interested",
    "asking_price_provided",
    "asks_offer",
    "callback_requested",
    "latent_interest",
    "need_more_money",
    "send_offer_first"
  ];
  if (priority_intents.includes(primary) || priority_intents.includes(objection) || property_status === "under_contract") {
    return "priority";
  }

  // 4. FOLLOW UP
  // Rules: "Not for sale", "not interested", "no", "ownership confirmed"
  const follow_up_intents = [
    "ownership_confirmed", 
    "need_time", 
    "not_interested", 
    "not_for_sale",
    "negative"
  ];
  if (follow_up_intents.includes(primary) || follow_up_intents.includes(objection) || threadState.not_interested === true) {
    return "follow_up";
  }

  // 5. NEW REPLIES & NEEDS REVIEW (Inbound Active)
  // If we just received an inbound message, it must be bucketed properly.
  if (!is_outbound) {
    const review_intents = ["unclear", "property_correction", "reaction_only", "who_is_this", "is_tenant", "is_realtor"];
    
    // Catch-all for single letter C, sold, tenant, realtor, unless already mapped
    if (review_intents.includes(primary) || property_status === "sold" || clean(classification.is_tenant) === "true" || classification.is_tenant === true || clean(classification.is_realtor) === "true" || classification.is_realtor === true || clean(threadState.inbound_message) === "c") {
      return "needs_review";
    }
    
    // Any other inbound reply goes to new_replies within the recency window.
    // Assuming if it hit here, it's a recent inbound.
    return "new_replies";
  }

  // 6. COLD / WAITING (Outbound Fallback)
  // If the last message was outbound, and we're not in a terminal/priority state.
  if (is_outbound) {
    // If it was already in follow_up or priority, it might stay there depending on rules.
    // For now, if we send an outbound to a cold lead, it stays cold or follow_up.
    if (existingBucket === "follow_up" || existingBucket === "waiting_on_seller") {
      return "follow_up";
    }
    return "cold";
  }

  // Fallback
  return "cold";
}
