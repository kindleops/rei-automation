/**
 * resolve-inbound-thread.js
 *
 * WHICH CONVERSATION DOES THIS REPLY BELONG TO?
 *
 * This is the most dangerous question in EMAIL-3, because the wrong answer is
 * silent. A reply attached to the wrong property does not error; it appears in a
 * deal, an operator reads it, and they negotiate about the wrong house. There is
 * no alert for that. So the resolver is built to REFUSE far more readily than to
 * guess.
 *
 * THE CONVERSATION IS THE OPPORTUNITY, NOT THE CHANNEL.
 *   acquisition_opportunities is the canonical seller relationship, keyed on
 *   (master_owner_id, primary_property_id) and already carrying
 *   related_thread_keys so more than one thread can belong to one relationship.
 *   Channel belongs to a COMMUNICATION (EMAIL-1 put it in the communication
 *   identity, correctly); it must not climb up into the conversation identity,
 *   or a seller who moves from SMS to email becomes two relationships.
 *
 * FOUR TIERS, STRICTLY ORDERED BY STRENGTH OF EVIDENCE.
 *
 *   TIER 1  REPLY ALIAS      128 random bits that only ever appeared in mail we
 *                            sent to this conversation. Nothing else comes close.
 *   TIER 2  RFC HEADERS      In-Reply-To / References naming a Message-ID we
 *                            issued. Strong, and survives subject rewriting,
 *                            translation and client quirks -- which is exactly
 *                            why subject is never used at all.
 *   TIER 3  PROVIDER THREAD  Only if the provider documents a stable thread id.
 *                            Brevo does NOT, so this tier is present and inert,
 *                            with the reason recorded rather than a pretend
 *                            implementation.
 *   TIER 4  SENDER CONTEXT   The address, and only when it maps to EXACTLY ONE
 *                            active conversation.
 *
 * WHY TIER 4 IS SO NARROW.
 *   A sender address is not an identity. One landlord emails us about six
 *   properties; a family shares a mailbox; an assistant handles three estates.
 *   The moment an address maps to more than one candidate, "most recent" and
 *   "closest subject" are both just guesses dressed as logic -- and the cost of
 *   being wrong is a seller negotiating about the wrong house.
 *
 *   AMBIGUOUS IS A CORRECT ANSWER. An operator spending thirty seconds attaching
 *   a reply is cheap. Discovering three weeks later that an offer was discussed
 *   against the wrong property is not.
 *
 * WHAT THIS FILE NEVER USES: subject line, owner name, nearest timestamp, or
 * "the only one that looks active". Each is a plausible-sounding correlation
 * with no evidential weight, and each has a failure mode that is invisible.
 *
 * PURE. Every candidate is supplied by the caller, so the precedence rules are
 * testable without a database and a verdict can be replayed from its inputs.
 */

export const INBOUND_THREAD_RESOLUTION_POLICY_VERSION = "inbound_thread_resolution_v1";

export const RESOLUTION_STATUS = Object.freeze({
  RESOLVED: "resolved",
  UNMATCHED: "unmatched",
  AMBIGUOUS: "ambiguous",
});

export const RESOLUTION_TIER = Object.freeze({
  REPLY_ALIAS: "tier1_reply_alias",
  RFC_HEADERS: "tier2_rfc_headers",
  PROVIDER_THREAD: "tier3_provider_thread",
  SENDER_CONTEXT: "tier4_sender_context",
  NONE: "none",
});

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

/** The conversation facts every tier must produce, so callers never branch on tier. */
function conversationFrom(source = {}) {
  return {
    opportunity_id: clean(source.opportunity_id) || null,
    master_owner_id: clean(source.master_owner_id) || null,
    property_id: clean(source.property_id) || null,
    prospect_id: clean(source.prospect_id) || null,
    thread_key: clean(source.thread_key) || null,
  };
}

/** Two candidates are the same conversation when their strongest anchors agree. */
function sameConversation(a, b) {
  if (a.opportunity_id && b.opportunity_id) return a.opportunity_id === b.opportunity_id;
  if (a.master_owner_id && b.master_owner_id && a.property_id && b.property_id) {
    return a.master_owner_id === b.master_owner_id && a.property_id === b.property_id;
  }
  if (a.thread_key && b.thread_key) return a.thread_key === b.thread_key;
  // Not provably the same. Treated as different, which pushes the caller towards
  // ambiguity rather than towards a merge nobody authorised.
  return false;
}

function distinctConversations(candidates) {
  const distinct = [];
  for (const candidate of candidates) {
    if (!distinct.some((existing) => sameConversation(existing, candidate))) {
      distinct.push(candidate);
    }
  }
  return distinct;
}

function verdict(status, tier, reason, conversation = null, extra = {}) {
  return {
    ok: status === RESOLUTION_STATUS.RESOLVED,
    status,
    tier,
    reason,
    conversation,
    policy_version: INBOUND_THREAD_RESOLUTION_POLICY_VERSION,
    ...extra,
  };
}

/**
 * @param {object} input
 * @param {object|null|undefined} input.alias
 *        The email_reply_aliases row the presented token resolved to. `null`
 *        means looked-and-absent; `undefined` means NOT LOOKED, which is treated
 *        as absent here because a token that was never presented cannot be
 *        looked up. A token that WAS presented and failed to resolve arrives as
 *        null with `presented_token` set, which is a different, louder outcome.
 * @param {string|null} input.presented_token
 * @param {Array} input.header_matches
 *        Outbound communications whose Message-ID appears in In-Reply-To or
 *        References. Supplied by the caller; this module does not query.
 * @param {object|null} input.provider_thread
 * @param {Array} input.sender_candidates
 *        Active conversations associated with the sender address.
 * @param {string|null} input.from_email
 */
export function resolveInboundThread(raw_input) {
  // `= {}` only defaults an UNDEFINED argument. The identical omission was the
  // SMS resolver's null-throw defect, repaired in this phase's pre-flight -- and
  // it reappeared here the moment the same shape was written again, which is why
  // the hostile-input test exists in both files rather than in neither.
  const input = raw_input && typeof raw_input === "object" ? raw_input : {};
  const presented_token = clean(input.presented_token);

  // ── TIER 1: the reply alias ──────────────────────────────────────────────
  if (input.alias) {
    const alias = input.alias;
    if (alias.is_active === false) {
      // A revoked alias is a deliberate decision that this address should stop
      // working. Honouring it anyway would make revocation meaningless; guessing
      // past it would make it dangerous.
      return verdict(
        RESOLUTION_STATUS.UNMATCHED,
        RESOLUTION_TIER.REPLY_ALIAS,
        "reply_alias_revoked",
        null,
        { alias_id: alias.id || null, revoked_reason: alias.revoked_reason || null }
      );
    }
    return verdict(
      RESOLUTION_STATUS.RESOLVED,
      RESOLUTION_TIER.REPLY_ALIAS,
      "reply_alias_resolved",
      conversationFrom(alias),
      { alias_id: alias.id || null }
    );
  }

  if (presented_token) {
    // A token was presented and did not resolve. That is NOT the same as no
    // token: it means someone replied to an address we minted and we cannot find
    // it, which is worth surfacing loudly rather than quietly falling through to
    // weaker evidence that might attach it somewhere plausible and wrong.
    return verdict(
      RESOLUTION_STATUS.UNMATCHED,
      RESOLUTION_TIER.REPLY_ALIAS,
      "reply_token_unknown",
      null,
      { presented_token_unknown: true }
    );
  }

  // ── TIER 2: RFC threading headers ────────────────────────────────────────
  const header_matches = Array.isArray(input.header_matches) ? input.header_matches : [];
  if (header_matches.length) {
    const conversations = distinctConversations(header_matches.map(conversationFrom));
    if (conversations.length === 1) {
      return verdict(
        RESOLUTION_STATUS.RESOLVED,
        RESOLUTION_TIER.RFC_HEADERS,
        "rfc_header_match",
        conversations[0],
        { matched_message_count: header_matches.length }
      );
    }
    // Headers naming messages from two different conversations happens when a
    // seller forwards one thread into another. There is no correct pick.
    return verdict(
      RESOLUTION_STATUS.AMBIGUOUS,
      RESOLUTION_TIER.RFC_HEADERS,
      "rfc_headers_span_multiple_conversations",
      null,
      { candidate_count: conversations.length }
    );
  }

  // ── TIER 3: provider thread identity ─────────────────────────────────────
  // Present and deliberately inert. Brevo's inbound parse payload documents no
  // stable conversation identifier, and building on an undocumented field would
  // be building on something they can change without telling anyone.
  if (input.provider_thread) {
    return verdict(
      RESOLUTION_STATUS.UNMATCHED,
      RESOLUTION_TIER.PROVIDER_THREAD,
      "provider_thread_identity_not_proven_stable",
      null,
      { provider_thread_ignored: true }
    );
  }

  // ── TIER 4: sender context, and only when it is unambiguous ──────────────
  const sender_candidates = Array.isArray(input.sender_candidates) ? input.sender_candidates : [];
  if (!sender_candidates.length) {
    // "We looked and there is nothing" and "we could not look" both end here,
    // and both are correctly UNMATCHED -- but they are different incidents, and
    // reporting the second as the first hides a broken query behind a routine
    // outcome that nobody investigates.
    if (input.sender_lookup_failed === true) {
      return verdict(
        RESOLUTION_STATUS.UNMATCHED,
        RESOLUTION_TIER.SENDER_CONTEXT,
        "sender_lookup_failed",
        null,
        { lookup_failed: true }
      );
    }
    return verdict(
      RESOLUTION_STATUS.UNMATCHED,
      RESOLUTION_TIER.NONE,
      clean(input.from_email) ? "no_conversation_for_sender" : "no_resolution_evidence"
    );
  }

  const conversations = distinctConversations(sender_candidates.map(conversationFrom));
  if (conversations.length === 1) {
    return verdict(
      RESOLUTION_STATUS.RESOLVED,
      RESOLUTION_TIER.SENDER_CONTEXT,
      "sole_active_conversation_for_sender",
      conversations[0],
      { candidate_count: 1 }
    );
  }

  // The case this whole file exists for. One address, several properties, no way
  // to tell which. Recency and subject similarity are both available here and
  // both deliberately unused.
  return verdict(
    RESOLUTION_STATUS.AMBIGUOUS,
    RESOLUTION_TIER.SENDER_CONTEXT,
    "sender_maps_to_multiple_conversations",
    null,
    { candidate_count: conversations.length }
  );
}

export default resolveInboundThread;
