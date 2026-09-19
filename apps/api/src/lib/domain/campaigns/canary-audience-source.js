/**
 * THE INTERNAL-CANARY AUDIENCE SOURCE (§2-§6).
 *
 * THE PROBLEM THIS SOLVES. `campaign_target_graph` holds 169,797 production
 * seller rows and zero approved internal canaries — it is a projection of the
 * real seller universe, which is exactly what it should be. But it is also the
 * candidate source for BOTH dynamic cohorts and explicit id targeting, so the
 * normal Campaign Command audience resolver could not reach a single safe
 * destination. Certifying campaign execution therefore meant either messaging a
 * real seller or not certifying it at all.
 *
 * WHAT THIS IS NOT. It does not put canaries into the graph. Manufacturing fake
 * owners and properties so internal handsets appear alongside real sellers
 * would corrupt every production count that reads it — addressable universe,
 * deliverable, readiness — to make a test convenient. The semantic difference
 * between a production audience and an internal proof audience is preserved by
 * keeping them in different sources that converge only AFTER resolution.
 *
 * WHERE IT CONVERGES. This returns rows in the graph's own projection shape, so
 * `buildCampaignTargets` collapses them, dedupes them, resolves languages and
 * persists them as ORDINARY `campaign_targets`. From that point there is no
 * such thing as a canary campaign object: normal queue materialization, normal
 * sender authority, normal suppression, contact window and emergency stop. The
 * only special fact is where the audience came from.
 *
 * THE FENCE. The registry is the authority and the request is not. This
 * enumerates `INTERNAL_TEST_PHONE_SET` itself and matches the phone graph
 * against it; a caller cannot hand in a phone number and have it treated as a
 * canary, because no caller-supplied destination is ever read. Every returned
 * row must clear BOTH the approved registry AND a canonical internal marker on
 * its phone-graph row — registration alone is not enough, and neither is a
 * marker on an unregistered number.
 */
import { supabase as defaultSupabase } from "@/lib/supabase/client.js";
import { INTERNAL_TEST_PHONE_SET, isInternalTestPhone } from "@/lib/config/internal-phones.js";
import { resolveContactTimezone } from "@/lib/domain/campaigns/contact-window-timezone.js";

export const INTERNAL_CANARY_SOURCE = "internal_canary";

/** The marker a phone-graph row must carry, in addition to being registered. */
export const INTERNAL_CANARY_ACTIVITY_STATUS = "internal_canary";

const clean = (value) => String(value ?? "").trim();

/** "Minneapolis, MN" -> "MN". Anything else -> "". */
const marketState = (market) => {
  const match = clean(market).match(/,\s*([A-Za-z]{2})\s*$/);
  return match ? match[1].toUpperCase() : "";
};

export function isInternalCanaryAudienceRequested(options = {}) {
  const requested = clean(options.candidate_source || options.source || options.audience_source);
  return requested.toLowerCase() === INTERNAL_CANARY_SOURCE;
}

/**
 * Explicit internal intent, not an ambient default.
 *
 * A canary audience is proof infrastructure. It is reachable only when the
 * caller states that intent AND carries internal authorization — the same
 * posture the rest of the internal proof lane uses. An ordinary Campaign
 * Command user has neither, so the source is invisible to normal audience
 * discovery rather than merely discouraged.
 */
export function evaluateCanaryAudienceAuthorization(options = {}, context = {}) {
  if (context.internal_authorized !== true) {
    return { ok: false, reason: "internal_authorization_required" };
  }
  if (options.internal_proof_intent !== true) {
    return { ok: false, reason: "explicit_internal_proof_intent_required" };
  }
  return { ok: true, reason: null };
}

/**
 * The approved destinations, as the registry defines them.
 *
 * Deliberately derived from the registry rather than from any request field.
 * An optional `only` list may NARROW the set for a smaller proof; it can never
 * widen it, because each entry is re-checked against the registry.
 */
export function resolveApprovedCanaryDestinations(options = {}) {
  const registry = [...INTERNAL_TEST_PHONE_SET];
  const only = Array.isArray(options.canary_phones) ? options.canary_phones.map(clean) : null;
  if (!only || only.length === 0) return registry;
  // Intersection only. An unregistered number in `only` is dropped, never added.
  return registry.filter((phone) => only.includes(phone));
}

/**
 * Resolve the canary audience into graph-shaped rows.
 *
 * Returns the same `{ ok, rows, warnings }` contract the graph path returns, so
 * the caller does not branch on source beyond choosing the resolver.
 */
export async function resolveInternalCanaryAudience({
  supabase = defaultSupabase,
  options = {},
  context = {},
  loadPhoneRows = null,
  loadCanaryIdentities = null,
  loadCanaryFacts = null,
} = {}) {
  const authorization = evaluateCanaryAudienceAuthorization(options, context);
  if (!authorization.ok) {
    return { ok: false, rows: [], counts: {}, warnings: [`canary_audience_denied:${authorization.reason}`] };
  }

  const approved = resolveApprovedCanaryDestinations(options);
  if (approved.length === 0) {
    return { ok: true, rows: [], counts: { approved: 0, resolved: 0, blocked: 0 }, warnings: ["canary_audience_empty_after_registry_intersection"] };
  }

  /**
   * IDENTITY COMES FROM RECORDS THAT ALREADY EXIST.
   *
   * A campaign target must clear identity governance before it can carry a
   * rendered template, and an internal handset legitimately has no seller
   * identity. Synthesising one — inventing an owner and a property so the
   * checks pass — is exactly the fabrication §1 forbids, and it would also
   * defeat the point: a target that skipped identity governance would not be
   * proving the production pipeline.
   *
   * So identity is LOOKED UP, not created. Prior commissioning work already
   * established verified canary identity records for the approved handsets
   * (`prop_internal_canary_1b`, `canaryprop_offerauth_v2_75060`, and their
   * owners). This reads the most recent verified target per destination and
   * reuses it. A handset with no such record resolves to nothing rather than
   * to an invented one — which is why the count can be smaller than the
   * registry, and that is the honest answer.
   */
  let identityByPhone = new Map();
  try {
    if (typeof loadCanaryIdentities === "function") {
      identityByPhone = new Map(Object.entries((await loadCanaryIdentities(approved)) || {}));
    } else {
      const { data, error } = await supabase
        .from("campaign_targets")
        .select("to_phone_number,property_id,master_owner_id,prospect_id,identity_status,state,timezone,created_at")
        .in("to_phone_number", approved)
        .eq("identity_status", "verified")
        .order("created_at", { ascending: false });
      if (error) throw error;
      for (const row of data || []) {
        const phone = clean(row.to_phone_number);
        if (phone && !identityByPhone.has(phone)) identityByPhone.set(phone, row);
      }
    }
  } catch (error) {
    return { ok: false, rows: [], counts: {}, warnings: [`canary_audience_identity_unreadable:${error?.message || "unknown"}`] };
  }

  let phoneRows = [];
  try {
    if (typeof loadPhoneRows === "function") {
      phoneRows = (await loadPhoneRows(approved)) || [];
    } else {
      const { data, error } = await supabase
        .from("phones")
        .select("canonical_e164,phone_id,master_owner_id,primary_prospect_id,canonical_prospect_id,primary_market,timezone,activity_status,phone_contact_status,best_phone_score,phone_owner,wrong_number_at")
        .in("canonical_e164", approved);
      if (error) throw error;
      phoneRows = data || [];
    }
  } catch (error) {
    // An unreadable phone graph is not permission to synthesise a destination.
    return { ok: false, rows: [], counts: {}, warnings: [`canary_audience_phone_graph_unreadable:${error?.message || "unknown"}`] };
  }

  /**
   * The REAL property and person rows behind each canary identity.
   *
   * Template governance lints the rendered body — a blank greeting ("Hey ,")
   * and a property-type/wording mismatch are both hard failures. Those checks
   * need a first name and a property type, and they are facts that already
   * exist on the commissioned canary records. Reading them is not inventing
   * seller data; omitting them would make the canary fail a lint for a reason
   * that is not true of it.
   */
  let propertyByToken = new Map();
  let prospectByToken = new Map();
  try {
    const propertyIds = [...new Set([...identityByPhone.values()].map((r) => clean(r.property_id)).filter(Boolean))];
    const prospectIds = [...new Set(phoneRows.map((r) => clean(r.primary_prospect_id)).filter(Boolean))];

    if (typeof loadCanaryFacts === "function") {
      const facts = (await loadCanaryFacts({ propertyIds, prospectIds })) || {};
      propertyByToken = new Map(Object.entries(facts.properties || {}));
      prospectByToken = new Map(Object.entries(facts.prospects || {}));
    } else {
      if (propertyIds.length > 0) {
        const { data } = await supabase
          .from("properties")
          .select("property_id,property_address_full,property_address_city,property_address_state,property_address_zip,market,property_type,normalized_asset_class")
          .in("property_id", propertyIds);
        for (const row of data || []) propertyByToken.set(clean(row.property_id), row);
      }
      if (prospectIds.length > 0) {
        const { data } = await supabase
          .from("prospects")
          .select("prospect_id,first_name,full_name,language_preference,timezone,primary_market")
          .in("prospect_id", prospectIds);
        for (const row of data || []) prospectByToken.set(clean(row.prospect_id), row);
      }
    }
  } catch {
    // Missing facts are not fatal; the row will simply fail the lint it
    // genuinely fails, which is the honest outcome.
  }

  const rows = [];
  const blocked = [];
  for (const phoneRow of phoneRows) {
    const phone = clean(phoneRow.canonical_e164);

    // BOTH fences, independently. Registration without the marker is a number
    // someone registered but never prepared; the marker without registration is
    // a row anyone with table access could have written.
    if (!isInternalTestPhone(phone)) {
      blocked.push({ phone, reason: "not_in_approved_registry" });
      continue;
    }
    if (clean(phoneRow.activity_status).toLowerCase() !== INTERNAL_CANARY_ACTIVITY_STATUS) {
      blocked.push({ phone, reason: "missing_internal_canary_marker" });
      continue;
    }
    if (clean(phoneRow.wrong_number_at)) {
      blocked.push({ phone, reason: "marked_wrong_number" });
      continue;
    }

    // No pre-established canary identity means no target. Nothing is invented.
    const identity = identityByPhone.get(phone);
    if (!identity) {
      blocked.push({ phone, reason: "no_verified_canary_identity_record" });
      continue;
    }

    rows.push({
      graph_id: `canary:${phone}`,
      property_id: clean(identity.property_id) || null,
      master_owner_id: clean(identity.master_owner_id) || clean(phoneRow.master_owner_id) || null,
      prospect_id: clean(identity.prospect_id) || clean(phoneRow.primary_prospect_id) || null,
      canonical_prospect_id: clean(phoneRow.canonical_prospect_id) || null,
      seller_person_key: null,
      phone_id: clean(phoneRow.phone_id) || null,
      canonical_e164: phone,
      market: clean(phoneRow.primary_market) || null,

      /**
       * Timezone through the CANONICAL resolver, not a guess. It governs the
       * contact window, so getting it wrong is how a proof message arrives at
       * 2 AM on a real handset. The phone graph has none for these rows, so it
       * is derived from the same geography inputs every other target uses.
       */
      timezone: clean(phoneRow.timezone)
        || clean(identity.timezone)
        || clean(resolveContactTimezone({
             // The canary property is an internal record and is not in
             // `properties`, so state comes from the identity record, or from
             // the phone graph's market suffix ("Minneapolis, MN") as a last
             // resort. A market with no parsable state yields nothing and the
             // target blocks on `missing_timezone`, which is the honest answer.
             propertyState: clean(identity.state) || marketState(phoneRow.primary_market),
           })?.iana)
        || null,

      /**
       * `verified` is CARRIED, not asserted. The identity record this row was
       * built from is one this source selected BY its `identity_status =
       * 'verified'` — established by prior commissioning, not by this code. The
       * alternative would be to leave it unknown and have the build block a
       * destination whose identity is, in fact, already established.
       */
      identity_alignment: clean(identity.identity_status) || "unknown",
      phone_owner: clean(phoneRow.phone_owner) || null,

      // Facts carried from the commissioned records, never synthesised.
      seller_first_name: clean(prospectByToken.get(clean(phoneRow.primary_prospect_id))?.first_name) || null,
      first_name: clean(prospectByToken.get(clean(phoneRow.primary_prospect_id))?.first_name) || null,
      seller_full_name: clean(prospectByToken.get(clean(phoneRow.primary_prospect_id))?.full_name) || null,
      owner_name: clean(prospectByToken.get(clean(phoneRow.primary_prospect_id))?.full_name) || null,
      property_address_full: clean(propertyByToken.get(clean(identity.property_id))?.property_address_full) || null,
      property_city: clean(propertyByToken.get(clean(identity.property_id))?.property_address_city) || null,
      property_zip: clean(propertyByToken.get(clean(identity.property_id))?.property_address_zip) || null,
      state: clean(propertyByToken.get(clean(identity.property_id))?.property_address_state) || null,
      property_type: clean(propertyByToken.get(clean(identity.property_id))?.property_type) || null,
      canonical_property_group: clean(propertyByToken.get(clean(identity.property_id))?.normalized_asset_class) || null,
      phone_activity_status: clean(phoneRow.activity_status) || null,
      best_phone_score: phoneRow.best_phone_score ?? null,

      /**
       * Eligibility flags describe THIS row, they do not grant anything. Every
       * one of them is re-derived downstream by the same code that governs a
       * production target: suppression, contact window, sender eligibility and
       * canonical send authority all still run at materialization and again at
       * dispatch. Marking a canary `sms_eligible` here only says "the audience
       * source has no objection", which is exactly what the graph's own column
       * means for a seller.
       */
      sms_eligible: true,
      true_post_contact_suppression: false,
      wrong_number: false,
      pending_prior_touch: false,
      active_queue_item: false,
      sender_covered: true,
      queue_eligible: true,

      // Provenance, so nothing downstream has to guess where this came from.
      audience_source: INTERNAL_CANARY_SOURCE,
      internal_canary: true,
    });
  }

  return {
    ok: true,
    rows,
    counts: { approved: approved.length, resolved: rows.length, blocked: blocked.length },
    blocked,
    warnings: [],
  };
}
