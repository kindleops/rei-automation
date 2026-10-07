// ─── contact-history-truths.js ───────────────────────────────────────────────
// Acquisition OS v1 §61–62: FOUR distinct contact-history truths, never one
// boolean, and the retext (second opener) rule.
//
//   PROPERTY EVER TOUCHED        any send about this property, to any phone
//   PERSON EVER CONTACTED        any send to this person (person key), any phone
//   PHONE CONTACTED              any send to this exact number
//   CURRENT BEST CONTACT TOUCHED the phone we are about to text was texted
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

export function propertyTouchHoldMode(env = process.env) {
  const v = clean(env?.[PROPERTY_TOUCH_HOLD_FLAG]).toLowerCase();
  if (["on", "1", "true", "enforce"].includes(v)) return "on";
  if (v === "shadow") return "shadow";
  return "off";
}

/** A send row counts as a touch when its status says it went (or may have gone) out. */
function isTouch(row = {}) {
  const status = clean(row.queue_status).toLowerCase();
  return Boolean(clean(row.sent_at)) || TOUCH_STATUSES.includes(status);
}

/**
 * The four truths for one candidate (property P, person K, phone E).
 * @param {object} p
 * @param {Array} p.prior_rows     prior sends that name P OR E OR K
 * @param {string} p.property_id
 * @param {string|null} p.person_key  the candidate's seller person key (prospect_id)
 * @param {string} p.phone         the candidate phone (current best contact)
 */
export function contactHistoryTruths({ prior_rows = [], property_id = null, person_key = null, phone = null } = {}) {
  const P = clean(property_id);
  const K = clean(person_key);
  const E = digits10(phone);
  const touches = (Array.isArray(prior_rows) ? prior_rows : []).filter(isTouch);
  const about_property = P ? touches.filter((r) => clean(r.property_id) === P) : [];
  const to_person = K ? touches.filter((r) => clean(r.prospect_id) === K) : [];
  const to_phone = E ? touches.filter((r) => digits10(r.to_phone_number) === E) : [];
  return {
    property_ever_touched: about_property.length > 0,
    person_ever_contacted: K ? to_person.length > 0 : null, // null = person unknown, never "false"
    phone_contacted: to_phone.length > 0,
    current_best_contact_touched: to_phone.length > 0,
    counts: { property: about_property.length, person: to_person.length, phone: to_phone.length },
    prior_property_phones: [...new Set(about_property.map((r) => digits10(r.to_phone_number)).filter(Boolean))],
    prior_property_person_keys: [...new Set(about_property.map((r) => clean(r.prospect_id)).filter(Boolean))],
    prior_property_person_unknown: about_property.some((r) => !clean(r.prospect_id)),
  };
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
} = {}) {
  const truths = contactHistoryTruths({ prior_rows, property_id, person_key, phone });
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
    return { hold: false, reason: null, release: "known_different_person", why: "different_person_proven", truths };
  }
  return {
    hold: true,
    reason: PROPERTY_TOUCH_HOLD_REASON,
    release: null,
    why: !K
      ? "candidate_person_unknown"
      : truths.prior_property_person_unknown
        ? "prior_recipient_unknown"
        : truths.prior_property_person_keys.some((k) => aliases.has(k))
          ? "same_person_new_phone"
          : !phone_owned_by_person
            ? "phone_ownership_unproven"
            : "different_number_is_not_proof",
    truths,
  };
}
