// ─── contact-history-truths.js ───────────────────────────────────────────────
// Acquisition OS v1 §61–62: FOUR distinct contact-history truths, never one
// boolean, and the retext (second opener) rule.
//
//   PROPERTY EVER TOUCHED        any send about this property, to any phone
//   PERSON EVER CONTACTED        any send to this person (person key), any phone
//   PHONE CONTACTED              any send to this exact number
//   CURRENT BEST CONTACT TOUCHED the (person, phone) pair we are about to text was texted
//                                (the number texted as SOMEONE ELSE's is phone history only)
//
// RETEXT RULE (owner): a property that already got an opener gets NO second
// opener just because its best phone changed — unless the new phone is
// CONFIDENTLY a genuinely different person. A different number alone is not
// proof; a different master_owner_id is not proof. Unclear → hold.
// Follow-ups are not openers and are never held by this rule.
//
// Pure (no I/O). The caller passes the prior send rows it already read
// (send_queue: property_id / to_phone_number / prospect_id / queue_status).
// Option B spec: tmp/touch-truth/OPTION_B_SPEC.txt (§2 identity evidence).
//
// Flag CAMPAIGN_PROPERTY_TOUCH_HOLD: "on" → enforce; "shadow" → evaluate and
// report only; anything else (default) → not evaluated. No master switch.

export const PROPERTY_TOUCH_HOLD_FLAG = "CAMPAIGN_PROPERTY_TOUCH_HOLD";
export const PROPERTY_TOUCH_HOLD_REASON = "property_prior_touch";

const clean = (v) => String(v ?? "").trim();
const digits10 = (v) => {
  const d = clean(v).replace(/\D/g, "");
  return d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
};

/** Statuses that mean a human may have received the message (sent, delivered, or in flight). */
export const TOUCH_STATUSES = Object.freeze(["sent", "delivered", "queued", "scheduled", "sending", "processing", "claimed", "pending", "retry"]);

/** Owner 2026-10-07 shadow categories. */
export const SHADOW_CATEGORY = Object.freeze({
  WOULD_HOLD: "would_hold",
  CONFIDENTLY_DIFFERENT: "confidently_different_person",
  AMBIGUOUS: "ambiguous_identity",
  SAME_PERSON_NEW_NUMBER: "same_person_new_number",
  SPOUSE_CO_OWNER: "spouse_co_owner",
  ENTITY_PRINCIPAL: "entity_principal",
});

export function propertyTouchHoldMode(env = process.env) {
  const v = clean(env?.[PROPERTY_TOUCH_HOLD_FLAG]).toLowerCase();
  if (["on", "1", "true", "enforce"].includes(v)) return "on";
  if (v === "shadow") return "shadow";
  return "off";
}

/** v2 (2026-10-08): the same definitions as public.contact_history_truths() in
 *  supabase/migrations/PROPOSED_20261008090000_contact_history_truths.sql. Change both or neither. */
export const CONTACT_TRUTHS_VERSION = "contact_history_truths.v2";
export const CONTACT_TRUTHS_FLAG = "CAMPAIGN_CONTACT_TRUTHS";

/**
 * A ledger row counts as a touch when it went (or may have gone) out.
 *   send_queue:      sent_at set, or a sent / in-flight status. failed / failed_transport /
 *                    cancelled / expired without sent_at are NOT touches (provably unsent).
 *   message_events:  direction outbound and not a failure event (rows carry `direction`).
 */
export function isTouch(row = {}) {
  const direction = clean(row.direction).toLowerCase();
  if (direction) {
    if (!direction.startsWith("out")) return false;
    return !/fail/.test(clean(row.event_type).toLowerCase()) && row.is_final_failure !== true;
  }
  const status = clean(row.queue_status).toLowerCase();
  return Boolean(clean(row.sent_at)) || TOUCH_STATUSES.includes(status);
}

/** The person a prior send reached: the resolved recipient key (SQL projection / loader),
 *  else the person key carried on the send (prospect_id). Empty = unknown. */
const personOf = (row) => clean(row.recipient_person_key) || clean(row.prospect_id);

/**
 * The four truths for one candidate (property P, person K, phone E).
 * @param {object} p
 * @param {Array} p.prior_rows     prior sends that name P OR E OR K (send_queue and/or message_events rows)
 * @param {string} p.property_id
 * @param {string|null} p.person_key  the candidate's seller person key (prospect_id)
 * @param {string} p.phone         the candidate phone (current best contact)
 * @param {string[]} [p.person_phones] K's OWN plaintext numbers (seller.owner_phone). A send to any of
 *                                 them reached K about some property, whatever key the send carried.
 */
export function contactHistoryTruths({ prior_rows = [], property_id = null, person_key = null, phone = null, person_phones = [] } = {}) {
  const P = clean(property_id);
  const K = clean(person_key);
  const E = digits10(phone);
  const kPhones = new Set((Array.isArray(person_phones) ? person_phones : []).map(digits10).filter(Boolean));
  const touches = (Array.isArray(prior_rows) ? prior_rows : []).filter(isTouch);
  const about_property = P ? touches.filter((r) => clean(r.property_id) === P) : [];
  const to_person = K ? touches.filter((r) => personOf(r) === K || kPhones.has(digits10(r.to_phone_number))) : [];
  const to_phone = E ? touches.filter((r) => digits10(r.to_phone_number) === E) : [];
  // The CURRENT best contact is the (K, E) pair: E was texted and the recipient was K or unknown.
  // E texted as somebody else's number (a different resolved key) is phone history, not K's.
  const to_pair = to_phone.filter((r) => !K || !personOf(r) || personOf(r) === K);
  return {
    version: CONTACT_TRUTHS_VERSION,
    property_ever_touched: about_property.length > 0,
    person_ever_contacted: K ? to_person.length > 0 : null, // null = person unknown, never "false"
    phone_contacted: to_phone.length > 0,
    current_best_contact_touched: to_pair.length > 0,
    counts: { property: about_property.length, person: to_person.length, phone: to_phone.length, pair: to_pair.length },
    person_contacted_about_other_property: to_person.some((r) => clean(r.property_id) !== P),
    prior_property_phones: [...new Set(about_property.map((r) => digits10(r.to_phone_number)).filter(Boolean))],
    prior_property_person_keys: [...new Set(about_property.map(personOf).filter(Boolean))],
    prior_property_person_unknown: about_property.some((r) => !personOf(r)),
  };
}

export function contactTruthsMode(env = process.env) {
  const v = clean(env?.[CONTACT_TRUTHS_FLAG]).toLowerCase();
  if (["on", "1", "true", "enforce"].includes(v)) return "on";
  if (v === "shadow") return "shadow";
  return "off";
}

/**
 * The truths as projected on a campaign_target_graph row by
 * refresh_campaign_target_graph_contact_truths() (PROPOSED_20261008090000). Before that
 * migration the columns are absent → every property/person truth is null (unknown) and the
 * caller keeps the legacy phone-level behaviour.
 */
export function contactTruthsFromGraphRow(row = {}) {
  const b = (v) => (v === true ? true : v === false ? false : null);
  return {
    property_ever_touched: b(row.property_ever_contacted),
    person_ever_contacted: b(row.person_ever_contacted),
    phone_contacted: row.never_contacted === true ? false : row.never_contacted === false ? true : null,
    current_best_contact_touched: b(row.current_best_contact_touched),
    retext_hold: b(row.retext_hold),
    projected: typeof row.property_ever_contacted === "boolean",
  };
}

/**
 * ONE answer to "may this row get a FIRST-TOUCH opener as never contacted?" for Composer/Build
 * (filters.never_contacted_only), the graph projection and the retext hold.
 *   phone_contacted                      → not fresh (legacy reason, unchanged)
 *   property touched on another phone     → not fresh unless the projection proved a different person
 *   person reached about another property → not fresh (owner reached via another property)
 * mode 'off' or no projection → legacy: fresh ⇔ never_contacted === true.
 * Returns { fresh, reason, legacy_fresh, would_change }.
 */
export function freshOpenerVerdict(row = {}, mode = "off") {
  const legacy_fresh = row.never_contacted === true;
  const t = contactTruthsFromGraphRow(row);
  if (mode === "off" || !t.projected) return { fresh: legacy_fresh, reason: legacy_fresh ? null : "filter_never_contacted", legacy_fresh, would_change: false };
  let reason = null;
  if (t.phone_contacted !== false) reason = "filter_never_contacted";
  else if (t.property_ever_touched && t.retext_hold !== false) reason = "filter_never_contacted_property_prior_touch";
  else if (t.person_ever_contacted === true) reason = "filter_never_contacted_person_prior_touch";
  const fresh = reason === null;
  const would_change = fresh !== legacy_fresh;
  if (mode === "shadow") return { fresh: legacy_fresh, reason: legacy_fresh ? null : "filter_never_contacted", legacy_fresh, would_change, shadow_reason: reason };
  return { fresh, reason, legacy_fresh, would_change };
}

/**
 * The retext rule for an OPENER. Returns { hold, reason, release, truths, evidence }.
 *   - not an opener (touch_number > 1 / follow-up / nurture) → never held here;
 *   - property never touched → no hold;
 *   - the candidate phone itself was touched → no hold HERE (the phone rules already govern);
 *   - property touched on another phone → HOLD unless known_different_person:
 *       every prior send about P resolved to a person key, none equals K,
 *       K is known, and the caller proved E belongs to K (phone_owned_by_person).
 */
export function evaluatePropertyTouchHold({
  prior_rows = [],
  property_id = null,
  person_key = null,
  phone = null,
  is_opener = true,
  phone_owned_by_person = false,
  same_person_keys = [],
  candidate_relationship = null, // 'spouse_co_owner' | 'entity_principal' (identity evidence, when known)
  person_phones = [],
} = {}) {
  const truths = contactHistoryTruths({ prior_rows, property_id, person_key, phone, person_phones });
  const none = (why) => ({ hold: false, reason: null, release: null, why, truths });
  if (!is_opener) return none("not_an_opener");
  if (!truths.property_ever_touched) return none("property_never_touched");
  if (truths.phone_contacted) return none("phone_rules_govern");
  const K = clean(person_key);
  const aliases = new Set([K, ...(same_person_keys || []).map(clean)].filter(Boolean));
  const known_different_person =
    Boolean(K) &&
    !truths.prior_property_person_unknown &&
    truths.prior_property_person_keys.length > 0 &&
    !truths.prior_property_person_keys.some((k) => aliases.has(k)) &&
    phone_owned_by_person === true;
  if (known_different_person) {
    return { hold: false, reason: null, release: "known_different_person", why: "different_person_proven", category: SHADOW_CATEGORY.CONFIDENTLY_DIFFERENT, truths };
  }
  const why = !K
    ? "candidate_person_unknown"
    : truths.prior_property_person_unknown
      ? "prior_recipient_unknown"
      : truths.prior_property_person_keys.some((k) => aliases.has(k))
        ? "same_person_new_phone"
        : !phone_owned_by_person
          ? "phone_ownership_unproven"
          : "different_number_is_not_proof";
  const category =
    why === "same_person_new_phone"
      ? SHADOW_CATEGORY.SAME_PERSON_NEW_NUMBER
      : candidate_relationship === SHADOW_CATEGORY.ENTITY_PRINCIPAL || candidate_relationship === SHADOW_CATEGORY.SPOUSE_CO_OWNER
        ? candidate_relationship
        : why === "candidate_person_unknown" || why === "prior_recipient_unknown"
          ? SHADOW_CATEGORY.AMBIGUOUS
          : SHADOW_CATEGORY.WOULD_HOLD;
  return {
    hold: true,
    category,
    reason: PROPERTY_TOUCH_HOLD_REASON,
    release: null,
    why,
    truths,
  };
}
