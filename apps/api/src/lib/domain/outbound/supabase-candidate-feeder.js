import crypto from "node:crypto";

import { child } from "@/lib/logging/logger.js";
import { normalizePhone } from "@/lib/providers/textgrid.js";
import { hasSupabaseConfig, supabase as defaultSupabase } from "@/lib/supabase/client.js";
import { evaluateContactWindow, insertSupabaseSendQueueRow, buildSendQueueDedupeKey } from "@/lib/supabase/sms-engine.js";
import { normalizeTimestamp } from "@/lib/utils/normalize-timestamp.js";
import {
  SEND_QUEUE_HISTORY_SELECT,
  MESSAGE_EVENTS_HISTORY_SELECT,
  collectRecentTemplateIdsFromRows,
  isPostgrestQueryError,
} from "@/lib/domain/outbound/outreach-history-projection.js";
import { getSystemFlag, getSystemValue, buildDisabledResponse } from "@/lib/system-control.js";
import {
  blockedRuntimeBrakeResult,
  evaluateQueueCreationRuntimeBrakes,
} from "@/lib/domain/queue/queue-control-safety.js";
import { evaluateSmsHealthGuard } from "@/lib/domain/delivery/sms-health-guard.js";
import { checkOutreachSuppression, checkPhoneLevelCooldown } from "@/lib/domain/outreach/outreach-service.js";
import { calculateOwnerProspectAlignment, isIdentityEligibleForLiveOutbound } from "@/lib/identity/ownerProspectAlignment.js";
import { isInternalTestPhone } from "@/lib/config/internal-phones.js";

const SEND_QUEUE_TABLE = "send_queue";
const TEXTGRID_NUMBERS_TABLE = "textgrid_numbers";
const IDENTITY_QUARANTINE_TABLE = "outbound_identity_quarantine";
// outbound_feeder_candidates is the default live feeder source: a materialized table
// refreshed before campaigns from v_sms_campaign_queue_candidates + prospects join +
// contact_outreach_state join. Fast, indexed, and safe at scale.
const DEFAULT_CANDIDATE_SOURCE = "outbound_feeder_candidates";
const ALLOWED_CANDIDATE_SOURCE_OVERRIDES = new Set([
  "outbound_feeder_candidates",
  "v_feeder_candidates_fast",
  "v_outbound_discovery_open_now",
  "v_outbound_discovery_fresh",
  "v_outbound_candidate_freshness",
  "outbound_candidate_snapshot",
  "v_sms_ready_contacts",
  "v_sms_ready_contacts_clean",
  "v_sms_ready_contacts_expanded",
  "v_sms_campaign_queue_candidates",
  "v_launch_sms_tier1",
]);
const CANDIDATE_SOURCE_AVAILABLE_HINT = [
  "outbound_feeder_candidates",
  "v_sms_campaign_queue_candidates",
  "v_outbound_discovery_fresh",
  "v_sms_ready_contacts",
  "v_launch_sms_tier1",
];

// Sources that carry outreach-state enrichment columns (never_contacted, touch_count, suppression_until).
// For these we push ordering down to the DB and can apply pre-filters in the query.
const ENRICHED_SOURCES = new Set([
  "outbound_feeder_candidates",
  "v_feeder_candidates_fast",
  "v_outbound_discovery_fresh",
  "v_outbound_candidate_freshness",
  "v_outbound_discovery_open_now",
]);

const REASON_CODES = Object.freeze({
  NO_MASTER_OWNER: "NO_MASTER_OWNER",
  NO_BEST_PHONE: "NO_BEST_PHONE",
  NO_PROPERTY: "NO_PROPERTY",
  NO_PHONE: "NO_PHONE",
  NO_VALID_PHONE: "NO_VALID_PHONE",
  TRUE_OPT_OUT: "TRUE_OPT_OUT",
  SUPPRESSED: "SUPPRESSED",
  OUTSIDE_CONTACT_WINDOW: "OUTSIDE_CONTACT_WINDOW",
  PENDING_PRIOR_TOUCH: "PENDING_PRIOR_TOUCH",
  DUPLICATE_QUEUE_ITEM: "DUPLICATE_QUEUE_ITEM",
  RECENTLY_CONTACTED: "RECENTLY_CONTACTED",
  INTERNAL_TEST_PHONE: "INTERNAL_TEST_PHONE",
  COLD_OUTBOUND_TOUCH_CAP: "COLD_OUTBOUND_TOUCH_CAP",
  PHONE_LEVEL_COOLDOWN: "PHONE_LEVEL_COOLDOWN",
  NO_TEMPLATE: "NO_TEMPLATE",
  TEMPLATE_RENDER_FAILED: "TEMPLATE_RENDER_FAILED",
  NO_VALID_TEXTGRID_NUMBER: "NO_VALID_TEXTGRID_NUMBER",
  ROUTING_BLOCKED: "ROUTING_BLOCKED",
  CAMPAIGN_LIMIT_REACHED: "CAMPAIGN_LIMIT_REACHED",
  SCHEDULE_WINDOW_FULL: "SCHEDULE_WINDOW_FULL",
  SCHEDULE_OVERFLOW_BLOCKED: "SCHEDULE_OVERFLOW_BLOCKED",
  NAME_HYDRATION_FAILURE: "NAME_HYDRATION_FAILURE",
  TEMPLATE_RENDER_LINT_FAILURE: "TEMPLATE_RENDER_LINT_FAILURE",
  IDENTITY_MISMATCH: "IDENTITY_MISMATCH",
  IDENTITY_NOT_VERIFIED: "IDENTITY_NOT_VERIFIED",
  MARKET_IDENTITY_QUARANTINE: "MARKET_IDENTITY_QUARANTINE",
  ACTIVE_QUEUE_ITEM: "ACTIVE_QUEUE_ITEM",
  PRIOR_TOUCH_COOLDOWN: "PRIOR_TOUCH_COOLDOWN",
  OUTREACH_HISTORY_UNAVAILABLE: "OUTREACH_HISTORY_UNAVAILABLE",
});

const logger = child({ module: "domain.outbound.supabase_candidate_feeder" });
const RELATIONSHIP_PROBE_TEMPLATE_IDS = new Set(["840801", "840802"]);
const RESIDENTIAL_PROPERTY_GROUPS = new Set([
  "sfr",
  "duplex",
  "triplex",
  "fourplex",
  "small_multifamily",
]);
const RELATIONSHIP_PROBE_ALLOWED_PROSPECT_FLAGS = new Set([
  "Family",
  "Resident",
  "Potential Owner",
  "Likely Renting",
  "Potentially Linked To Company",
]);
const STANDARD_OWNERSHIP_ONLY_PROSPECT_FLAGS = new Set([
  "Likely Owner",
  "Linked To Company",
]);
const EXACT_PROSPECT_MATCHING_FLAG_LOOKUP = new Map(
  [
    "Family",
    "Resident",
    "Potential Owner",
    "Likely Renting",
    "Potentially Linked To Company",
    "Likely Owner",
    "Linked To Company",
  ].map((flag) => [normalizeProspectMatchingFlagToken(flag), flag])
);

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function normalizeProspectMatchingFlagToken(value) {
  return lower(value).replace(/\s+/g, " ");
}

function asBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  const normalized = lower(value);
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function asNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function toTimestamp(value) {
  return normalizeTimestamp(value);
}

function classifyInsertedQueueScheduling(queueResult = {}, scheduledFor = null) {
  const persistedScheduledFor =
    queueResult?.inserted?.raw?.scheduled_for ??
    queueResult?.inserted?.scheduled_for ??
    scheduledFor;
  const scheduledAtMs = normalizeTimestamp(persistedScheduledFor);
  const persistedStatus = clean(
    queueResult?.inserted?.raw?.queue_status ?? queueResult?.inserted?.queue_status
  );
  const isScheduled =
    lower(persistedStatus) === "scheduled" ||
    (scheduledAtMs !== null && scheduledAtMs > Date.now());
  return {
    persistedScheduledFor,
    scheduledAtMs,
    persistedStatus,
    isScheduled,
  };
}

function asPositiveInteger(value, fallback = null) {
  const parsed = asNumber(value, fallback);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function totalCreatedCount(summary = {}) {
  return Number(summary.queued_count || 0) + Number(summary.scheduled_count || 0);
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (!clean(value)) return [];
  return clean(value)
    .split(",")
    .map((entry) => clean(entry))
    .filter(Boolean);
}

function isTruthyDataFlag(value) {
  const normalized = lower(value);
  return ["1", "true", "yes", "active", "confirmed", "suppressed"].includes(normalized);
}

function pick(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined && clean(value) !== "") return value;
  }
  return null;
}

function hasOwn(value = {}, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractExactProspectMatchingFlags(value) {
  if (!clean(value)) return [];
  const seen = new Set();
  const flags = [];
  for (const token of clean(value).split(/[,\n;|]+/)) {
    const canonical = EXACT_PROSPECT_MATCHING_FLAG_LOOKUP.get(normalizeProspectMatchingFlagToken(token));
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    flags.push(canonical);
  }
  return flags;
}

function getTemplateReferenceId(template = {}) {
  return clean(pick(template?.template_id, template?.id, template?.item_id, template?.podio_template_id)) || null;
}

function isRelationshipProbeTemplate(template = {}) {
  const template_id = getTemplateReferenceId(template);
  return Boolean(template_id && RELATIONSHIP_PROBE_TEMPLATE_IDS.has(template_id));
}

function isGenericOwnershipTemplateBody(template = {}) {
  const body = lower(pick(template?.template_body, template?.english_translation, ""));
  if (!body) return false;
  if (body.includes("duplex") || body.includes("triplex") || body.includes("fourplex")) return false;
  if (body.includes("units") && !body.includes("units?")) return false;
  return true;
}

function canRenderOwnershipTemplateWithoutPropertyType(template = {}, candidate = {}, selector = {}) {
  if (lower(selector.use_case) !== "ownership_check") return false;

  const property_type = clean(
    pick(candidate.property_type, candidate.raw?.property_type, candidate.raw?.property_class)
  );
  if (property_type) return false;

  const property_address_full = clean(
    pick(candidate.property_address_full, candidate.property_address, candidate.raw?.property_address_full)
  );
  if (!property_address_full) return false;

  const allowed = Array.isArray(template.allowed_property_groups)
    ? template.allowed_property_groups.map((group) => lower(group)).filter(Boolean)
    : [];
  if (!allowed.length) return false;
  if (!allowed.every((group) => RESIDENTIAL_PROPERTY_GROUPS.has(group))) return false;

  return isGenericOwnershipTemplateBody(template);
}

function logTemplateRenderFailure(candidate = {}, reason = "", details = {}) {
  logger.warn("feeder.template_render_failed", {
    module: "domain.outbound.supabase_candidate_feeder",
    master_owner_id: candidate.master_owner_id,
    property_id: candidate.property_id,
    template_id: clean(details.template_id) || null,
    selected_template_id: clean(details.selected_template_id || details.template_id) || null,
    reason: clean(reason) || null,
    missing_variables: Array.isArray(details.missing_variables) ? details.missing_variables : [],
    template_routing_reason: clean(details.template_routing_reason) || null,
    candidate_group: clean(details.candidate_group) || null,
    property_type: clean(details.property_type) || null,
  });
}

function isLikelyPhoneValue(value) {
  const raw = clean(value);
  if (!raw) return false;
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 7;
}

function isInvalidSellerNameValue(value) {
  const raw = clean(value);
  if (!raw) return true;

  const lowered = raw.toLowerCase();

  if (isLikelyPhoneValue(raw)) return true;

  if (
    [
      "unknown",
      "owner",
      "current owner",
      "property owner",
      "homeowner",
      "seller",
      "there",
      "investor",
      "n/a",
      "na",
      "null",
      "none",
    ].includes(lowered)
  ) {
    return true;
  }

  if (
    /\b(llc|l\.l\.c|inc|corp|corporation|company|co\.|trust|estate|holdings|properties|property|partners|investments|capital|group|fund|bank|lender)\b/i.test(raw)
  ) {
    return true;
  }

  return false;
}

function titleCaseNameToken(value) {
  const raw = clean(value);
  if (!raw) return "";
  return raw
    .toLowerCase()
    .replace(/(^|[-'\s])([a-z])/g, (_, prefix, letter) => `${prefix}${letter.toUpperCase()}`);
}

/**
 * Determine the canonical property group for template matching.
 */
export function getCanonicalPropertyGroup(hints = {}) {
  let pt = lower(typeof hints === "string" ? hints : hints.property_type);
  if (!pt && typeof hints === "object" && hints !== null) {
    const raw_pt = lower(hints.raw_payload_json?.property_type || hints.raw?.raw_payload_json?.property_type);
    const p_class = lower(hints.property_class || hints.raw?.property_class);
    const options = lower(hints.options || hints.raw?.options);
    const podio_tags = lower(hints.podio_tags || hints.raw?.podio_tags);
    const units = asNumber(hints.units_count || hints.raw?.units_count, null);

    pt = pick(pt, raw_pt, p_class);

    if (!pt) {
       if (units === 1) pt = "sfr";
       else if (units === 2) pt = "duplex";
       else if (units === 3) pt = "triplex";
       else if (units === 4) pt = "fourplex";
       else if (units > 4 && units <= 10) pt = "small_multifamily";
       else if (units > 10) pt = "multifamily_5_plus";
    }

    if (!pt && options) {
      if (options.includes("sfr") || options.includes("single family")) pt = "sfr";
      else if (options.includes("duplex")) pt = "duplex";
      else if (options.includes("triplex")) pt = "triplex";
      else if (options.includes("fourplex")) pt = "fourplex";
      else if (options.includes("multifamily")) pt = "multifamily_5_plus";
    }

    if (!pt && podio_tags) {
       if (podio_tags.includes("sfr")) pt = "sfr";
       else if (podio_tags.includes("duplex")) pt = "duplex";
       else if (podio_tags.includes("triplex")) pt = "triplex";
       else if (podio_tags.includes("fourplex")) pt = "fourplex";
       else if (podio_tags.includes("multifamily")) pt = "multifamily_5_plus";
    }
  }

  if (!pt) return "other_commercial";

  if (pt === "single family" || pt === "sfr" || pt === "residential" || pt === "single-family") return "sfr";
  if (pt === "duplex") return "duplex";
  if (pt === "triplex") return "triplex";
  if (pt === "fourplex") return "fourplex";
  if (pt.includes("multifamily") && pt.includes("small")) return "small_multifamily";
  if (pt.includes("multifamily")) return "multifamily_5_plus";
  if (pt.includes("retail") || pt.includes("strip")) return "retail";
  if (pt.includes("office")) return "office";
  if (pt.includes("industrial") || pt.includes("warehouse")) return "industrial";
  if (pt.includes("storage")) return "self_storage";
  if (pt.includes("hotel") || pt.includes("motel")) return "hotel_motel";
  if (pt.includes("mobile home")) return "mobile_home_park";
  if (pt.includes("land") || pt.includes("lot") || pt.includes("parcel")) return "land";

  return "other_commercial";
}

function extractFirstName(value, { allow_single_token = true } = {}) {
  const raw = clean(value);
  if (isInvalidSellerNameValue(raw)) return "";

  const stripped = raw
    .replace(/\s+/g, " ")
    .replace(/[,;|].*$/g, "")
    .trim();

  if (!allow_single_token) {
    const token_count = stripped.split(/\s+/).filter(Boolean).length;
    if (token_count < 2) return "";
  }

  const first = stripped.split(/\s+/).find(Boolean) || "";
  if (isInvalidSellerNameValue(first)) return "";

  if (!/^[a-zA-Z][a-zA-Z'-]{1,}$/i.test(first)) return "";

  return titleCaseNameToken(first);
}

export function resolveSellerIdentity(candidate = {}) {
  const alignment = candidate.identity_alignment || { status: "unknown" };
  const is_untrusted = ["mismatch", "weak", "unknown", "household_associated"].includes(alignment.status);
  const skip_prospect_names = ["household_associated"].includes(alignment.status);

  const sources = [
    { source: "seller_first_name", value: candidate.seller_first_name, allow_single_token: true, skip_if_untrusted: is_untrusted },
    { source: "prospect_first_name", value: candidate.prospect_first_name, allow_single_token: true, skip_if_untrusted: is_untrusted || skip_prospect_names },
    { source: "prospect_display_name", value: candidate.prospect_display_name, allow_single_token: false, skip_if_untrusted: is_untrusted || skip_prospect_names },
    { source: "owner_first_name", value: candidate.owner_first_name, allow_single_token: true },
    { source: "owner_display_name", value: candidate.owner_display_name, allow_single_token: false },
    { source: "master_owner_first_name", value: candidate.master_owner_first_name, allow_single_token: true },
    { source: "master_owner_display_name", value: candidate.master_owner_display_name, allow_single_token: false },
    { source: "seller_full_name", value: candidate.seller_full_name, allow_single_token: false, skip_if_untrusted: is_untrusted },
    { source: "phone_first_name", value: candidate.phone_first_name, allow_single_token: true, skip_if_untrusted: skip_prospect_names, guard: () => hasMultipleNameTokens(candidate.phone_full_name || "") },
    { source: "phone_full_name", value: candidate.phone_full_name, allow_single_token: false, skip_if_untrusted: skip_prospect_names },
  ];

  for (const { source, value, allow_single_token, guard, skip_if_untrusted } of sources) {
    if (!value) continue;
    if (skip_if_untrusted) continue;
    if (guard && !guard()) continue;
    const first_name = extractFirstName(value, { allow_single_token });
    if (first_name) {
      return {
        seller_first_name: first_name,
        seller_display_name: clean(value),
        seller_full_name: clean(value),
        seller_name_source: source,
        seller_name_missing: false,
      };
    }
  }

  return {
    seller_first_name: null,
    seller_display_name: null,
    seller_full_name: null,
    seller_name_source: "none",
    seller_name_missing: true,
  };
}

function maskPhone(value) {
  const phone = normalizePhone(value);
  if (!phone) return null;
  return `${phone.slice(0, 2)}******${phone.slice(-2)}`;
}

function getSupabase(deps = {}) {
  if (deps.supabase) return deps.supabase;
  if (!hasSupabaseConfig()) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return defaultSupabase;
}

function normalizeMarket(value) {
  return lower(value)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const REGIONAL_ROUTING_RULES = [
  {
    name: "ca_to_los_angeles",
    states: ["ca"],
    target_markets: ["Los Angeles, CA"],
  },
  {
    name: "west_mountain_to_los_angeles",
    states: ["or", "wa", "nv", "az", "id", "ut"],
    target_markets: ["Los Angeles, CA"],
  },
  {
    name: "midwest_to_minneapolis",
    states: ["mn", "wi", "ia", "nd", "sd", "ne", "il", "in", "mi", "oh", "mo"],
    target_markets: ["Minneapolis, MN"],
  },
  {
    name: "southern_plains_to_dallas",
    states: ["ok", "ar", "ks"],
    target_markets: ["Dallas, TX"],
  },
  {
    name: "louisiana_to_houston",
    states: ["la"],
    target_markets: ["Houston, TX"],
  },
  {
    name: "texas_to_dallas_then_houston",
    states: ["tx"],
    target_markets: ["Dallas, TX", "Houston, TX"],
  },
  {
    name: "georgia_to_atlanta",
    states: ["ga"],
    target_markets: ["Atlanta, GA"],
  },
  {
    name: "carolinas_to_charlotte",
    states: ["nc", "sc"],
    target_markets: ["Charlotte, NC"],
  },
  {
    name: "florida_to_jacksonville_then_miami",
    states: ["fl"],
    target_markets: ["Jacksonville, FL", "Miami, FL"],
  },
  {
    name: "northeast_to_miami",
    states: ["ny", "nj", "pa", "md", "va", "dc", "de", "ct", "ri", "ma", "nh", "vt", "me"],
    target_markets: ["Miami, FL"],
  },
  {
    name: "southeast_inland_to_atlanta_then_charlotte",
    states: ["al", "ms", "tn", "ky"],
    target_markets: ["Atlanta, GA", "Charlotte, NC"],
  },
];

function findRegionalRoutingRule(state) {
  const normalized_state = lower(state);
  return REGIONAL_ROUTING_RULES.find((rule) => rule.states.includes(normalized_state)) || null;
}

function buildIdempotencyKey({
  master_owner_id,
  property_id,
  phone_id,
  template_use_case,
  touch_number,
  campaign_session_id,
}) {
  return [
    clean(master_owner_id),
    clean(property_id),
    clean(phone_id),
    clean(template_use_case),
    clean(touch_number),
    clean(campaign_session_id),
  ].join(":");
}

function buildQueueKeyFromIdempotencyKey(idempotency_key) {
  return `feed:${crypto.createHash("sha1").update(clean(idempotency_key)).digest("hex")}`;
}

export function normalizeCandidateRow(row = {}, defaults = {}) {
  const normalized_touch_number = asPositiveInteger(
    pick(row.touch_number, row.next_touch_number, defaults.touch_number),
    1
  );
  const template_lookup_use_case =
    clean(pick(row.template_use_case, row.use_case, row.selected_use_case, defaults.template_use_case)) ||
    "ownership_check";
  const stage_code = clean(pick(row.stage_code, defaults.stage_code, "S1")) || "S1";
  const stage_label =
    clean(pick(row.stage_label, defaults.stage_label, "Ownership Confirmation")) ||
    "Ownership Confirmation";
  const is_first_touch = normalized_touch_number === 1;

  // Accept any non-empty string for IDs (mo_..., prop_..., ph_..., numeric, etc.)
  const master_owner_id =
    pick(row.normalized_master_owner_id, row.master_owner_id, row.owner_id, row.owner_podio_item_id) || null;
  const property_id =
    pick(row.normalized_property_id, row.property_id, row.property_export_id, row.property_item_id) || null;
  const property_export_id = pick(row.property_export_id) || null;
  const best_phone_id = pick(row.best_phone_id) || null;
  const phone_id = pick(row.normalized_phone_id, row.phone_id, row.phone_item_id, row.best_phone_id) || null;
  const primary_prospect_id = pick(row.primary_prospect_id) || null;
  const canonical_prospect_id = pick(row.canonical_prospect_id) || null;

  const canonical_e164 =
    normalizePhone(
      pick(
        row.normalized_phone_e164,
        row.canonical_e164,
        row.best_phone_e164,
        row.phone,
        row.best_phone,
        row.phone_e164,
        row.phone_hidden,
        row.phone_number
      )
    ) || "";

  const market = clean(
    pick(row.market, row.normalized_market, row.market_name, row.seller_market, row.canonical_market_slug, row.market_label, defaults.market)
  );
  const state = clean(
    pick(row.state_code, row.property_address_state, row.normalized_state, row.property_state, row.seller_state, row.state, defaults.state)
  );
  const owner_display_name = clean(pick(row.owner_display_name, row.display_name, row.owner_name));
  const phone_full_name = clean(pick(row.phone_full_name, row.seller_full_name));
  const phone_first_name = clean(
    pick(
      row.phone_first_name,
      row.seller_first_name,
      phone_full_name ? phone_full_name.split(/\s+/).filter(Boolean)[0] : null
    )
  );
  const seller_first_name = clean(pick(row.seller_first_name, row.phone_first_name, phone_first_name));
  const seller_full_name = clean(pick(row.seller_full_name, row.phone_full_name, phone_full_name));
  const prospect_matching_flags = clean(pick(row.prospect_matching_flags, row.matching_flags, row.person_flags_text));

  const candidate = {
    raw: row,
    master_owner_id,
    property_id,
    property_export_id,
    best_phone_id,
    phone_id,
    primary_prospect_id,
    canonical_prospect_id,
    canonical_e164,
    market,
    state,
    state_code: state,
    owner_display_name,
    display_name: owner_display_name,
    phone_first_name,
    phone_full_name,
    seller_first_name,
    seller_full_name,
    prospect_first_name: clean(pick(row.prospect_first_name)),
    prospect_display_name: clean(pick(row.prospect_display_name, row.primary_display_name)),
    property_owner_name: clean(pick(row.property_owner_name)),
    master_owner_first_name: clean(pick(row.master_owner_first_name)),
    master_owner_display_name: clean(pick(row.master_owner_display_name)),
    joined_property_source: clean(pick(row.joined_property_source, row.property_join_source, "master_owner_property_relation")),
    property_address_full: clean(pick(row.property_address_full, row.property_address, row.address, row.title)),
    property_city: clean(pick(row.property_address_city, row.property_city)),
    property_state: state,
    property_zip: clean(pick(row.property_address_zip, row.property_zip)),
    timezone: clean(pick(row.timezone, row.seller_timezone, "America/Chicago")) || "America/Chicago",
    contact_window: clean(
      pick(row.contact_window, row.contact_window_local, row.allowed_contact_window, "")
    ),
    true_post_contact_suppression: asBoolean(
      pick(row.true_post_contact_suppression, row.post_contact_suppression, row.is_suppressed),
      false
    ),
    active_opt_out: asBoolean(pick(row.active_opt_out, row.opt_out_active, row.is_opted_out), false),
    pending_prior_touch: asBoolean(pick(row.pending_prior_touch), false),
    template_use_case: template_lookup_use_case,
    template_lookup_use_case,
    stage_code,
    stage_label,
    touch_number: normalized_touch_number,
    is_first_touch,
    is_follow_up: !is_first_touch,
    campaign_session_id:
      clean(pick(row.campaign_session_id, defaults.campaign_session_id)) ||
      `session-${new Date().toISOString().slice(0, 10)}`,
    property_address: clean(pick(row.property_address_full, row.property_address, row.address, row.title)),
    owner_first_name: clean(pick(row.owner_first_name, row.first_name)),
    owner_last_name: clean(pick(row.owner_last_name, row.last_name)),
    language: clean(pick(row.best_language, row.language, row.preferred_language, "English")) || "English",
    seller_name: clean(pick(row.seller_name, row.owner_display_name, row.display_name, row.owner_name)) || "",
    market_id: asPositiveInteger(pick(row.market_id), null),
    // Agent
    agent_persona: clean(pick(row.agent_persona)),
    agent_family: clean(pick(row.agent_family)),
    best_language: clean(pick(row.best_language, row.language)),
    // Scores & financials
    final_acquisition_score: asNumber(row.final_acquisition_score, null),
    best_phone_score: asNumber(row.best_phone_score, null),
    cash_offer: asNumber(row.cash_offer, null),
    estimated_value: asNumber(row.estimated_value, null),
    equity_amount: asNumber(row.equity_amount, null),
    equity_percent: asNumber(row.equity_percent, null),
    // v_sms_campaign_queue_candidates extras
    property_address_county_name: clean(pick(row.property_address_county_name)),
    estimated_repair_cost: asNumber(row.estimated_repair_cost, null),
    rehab_level: clean(pick(row.rehab_level)),
    contact_status: clean(pick(row.contact_status)),
    ownership_years: asNumber(row.ownership_years, null),
    // Priority / campaign
    priority_tier: clean(pick(row.priority_tier)),
    follow_up_cadence: clean(pick(row.follow_up_cadence)),
    // Phone metadata
    phone_type: clean(pick(row.phone_type)),
    activity_status: clean(pick(row.activity_status)),
    sms_eligible: asBoolean(pick(row.sms_eligible), true),
    // Progression & Audit fields
    last_touch_number: asPositiveInteger(pick(row.last_touch_number, row.last_sent_touch_number), 0),
    last_outbound_at: clean(pick(row.last_outbound_at)),
    last_inbound_at: clean(pick(row.last_inbound_at)),
    latest_contact_at: clean(pick(row.latest_contact_at, row.latest_message_at)),
    conversation_stage: clean(pick(row.conversation_stage)),
    use_case_template: clean(pick(row.use_case_template)),
    next_eligible_at: clean(pick(row.next_eligible_at)),
    // Enriched fields from v_sms_ready_contacts (appended in view update)
    property_type: clean(pick(row.property_type)),
    seller_status: clean(pick(row.seller_status, row.contact_status, row.activity_status)),
    pipeline_stage: clean(pick(row.pipeline_stage, row.conversation_stage, row.stage_code)),
    conversation_status: clean(pick(row.conversation_status, row.status)),
    latest_message_at: clean(pick(row.latest_message_at)),
    never_contacted: asBoolean(row.never_contacted, null),
    freshness_score: asNumber(row.freshness_score, null),
    last_sms_at: row.last_sms_at || null,
    canonical_property_group: getCanonicalPropertyGroup(row),
    // Identity alignment fields
    likely_owner: asBoolean(pick(row.likely_owner), null),
    likely_renting: asBoolean(pick(row.likely_renting), null),
    matching_flags: prospect_matching_flags,
    prospect_matching_flags,
    person_flags_text: clean(pick(row.person_flags_text)),
    person_flags_json: row.person_flags_json ?? null,
    owner_type_guess: clean(pick(row.owner_type_guess)),
    phone_owner: clean(pick(row.phone_owner)),
    prospect_cnam: clean(pick(row.prospect_cnam, row.cnam)),
    prospect_full_name: clean(pick(row.prospect_full_name, row.prospect_display_name, row.full_name)),
    linked_property_ids_text: clean(pick(row.linked_property_ids_text, row.property_ids_text)),
  };

  // ── Identity Alignment Check ───────────────────────────────────────────
  const identity_alignment =
    row.identity_alignment &&
    typeof row.identity_alignment === "object" &&
    clean(row.identity_alignment.status)
      ? row.identity_alignment
      : calculateOwnerProspectAlignment({
          masterOwnerName: candidate.owner_display_name,
          ownerDisplayName: candidate.owner_display_name,
          ownerName: candidate.owner_display_name,
          prospectFullName: candidate.prospect_full_name,
          phoneFullName: candidate.phone_full_name,
          phoneOwner: candidate.phone_owner,
          cnam: candidate.prospect_cnam,
          likelyOwner: candidate.likely_owner,
          likelyRenting: candidate.likely_renting,
          matchingFlags: candidate.matching_flags,
          personFlagsText: candidate.person_flags_text,
          bestPhoneScore: candidate.best_phone_score,
          contactScoreFinal: candidate.contact_score_final,
          linkedPropertyIdsText: candidate.linked_property_ids_text,
          joinedPropertySource: candidate.joined_property_source,
          smsEligible: candidate.sms_eligible,
          canonicalProspectId: candidate.canonical_prospect_id,
          primaryProspectId: candidate.primary_prospect_id,
          normalizedPhoneId: pick(row.normalized_phone_id, row.phone_id),
          bestPhoneId: candidate.best_phone_id,
          phoneId: candidate.phone_id,
          sellerFullName: candidate.seller_full_name,
          sellerFirstName: candidate.seller_first_name,
        });
  candidate.identity_alignment = identity_alignment;
  // ─────────────────────────────────────────────────────────────────────────

  const seller_identity = resolveSellerIdentity(candidate);
  const hydrated_seller_full_name = clean(
    pick(
      candidate.seller_full_name,
      candidate.phone_full_name,
      candidate.owner_display_name,
      seller_identity.seller_full_name,
      seller_identity.seller_display_name
    )
  );
  return {
    ...candidate,
    ...seller_identity,
    seller_full_name: hydrated_seller_full_name || "",
    seller_name: seller_identity.seller_first_name || "",
  };
}

function mapReasonToDiagnosticCounter(reason) {
  if (reason === REASON_CODES.SUPPRESSED || reason === REASON_CODES.TRUE_OPT_OUT) {
    return "suppression_block_count";
  }
  if (reason === REASON_CODES.OUTSIDE_CONTACT_WINDOW) {
    return "contact_window_block_count";
  }
  if (reason === REASON_CODES.PENDING_PRIOR_TOUCH) {
    return "pending_prior_touch_block_count";
  }
  if (reason === REASON_CODES.ACTIVE_QUEUE_ITEM) {
    return "active_queue_block_count";
  }
  if (reason === REASON_CODES.PRIOR_TOUCH_COOLDOWN) {
    return "prior_touch_cooldown_block_count";
  }
  if (reason === REASON_CODES.DUPLICATE_QUEUE_ITEM) {
    return "duplicate_queue_block_count";
  }
  if (reason === REASON_CODES.NO_TEMPLATE || reason === REASON_CODES.TEMPLATE_RENDER_FAILED || reason === REASON_CODES.TEMPLATE_RENDER_LINT_FAILURE) {
    return "template_block_count";
  }
  if (reason === REASON_CODES.NAME_HYDRATION_FAILURE) {
    return "hydration_failure_count";
  }
  if (reason === REASON_CODES.ROUTING_BLOCKED || reason === REASON_CODES.NO_VALID_TEXTGRID_NUMBER) {
    return "routing_block_count";
  }
  if (reason === REASON_CODES.SCHEDULE_WINDOW_FULL) {
    return "schedule_window_full_count";
  }
  if (reason === REASON_CODES.SCHEDULE_OVERFLOW_BLOCKED) {
    return "schedule_overflow_blocked_count";
  }
  return null;
}

function buildCandidateNormalizedPreview(raw, candidate) {
  return {
    raw_keys: Object.keys(raw || {}).slice(0, 50),
    best_phone_id: candidate.best_phone_id || null,
    normalized_master_owner_id: candidate.master_owner_id,
    normalized_property_id: candidate.property_id,
    normalized_phone_id: candidate.phone_id,
    normalized_phone_e164: candidate.canonical_e164 || null,
    phone_first_name: candidate.phone_first_name || null,
    phone_full_name: candidate.phone_full_name || null,
    seller_first_name: candidate.seller_first_name || null,
    seller_full_name: candidate.seller_full_name || null,
    joined_property_source: candidate.joined_property_source || null,
    normalized_market: candidate.market || null,
    normalized_state: candidate.state || null,
    identity_resolution: candidate.identity_alignment?.status || null,
    identity_alignment_status: candidate.identity_alignment?.status || null,
  };
}

function buildTemplateContext(candidate = {}) {
  return {
    owner_name: candidate.seller_name || "",
    owner_first_name: candidate.owner_first_name || null,
    owner_last_name: candidate.owner_last_name || null,
    property_address: candidate.property_address || "your property",
    market_name: candidate.market || null,
    state: candidate.state || null,
  };
}

function decodeBasicHtmlEntities(text = "") {
  return String(text)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function stripHtml(text = "") {
  return String(text).replace(/<[^>]*>/g, " ");
}

function formatCurrency(value) {
  const numeric = asNumber(value, null);
  if (!Number.isFinite(numeric)) return "";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(numeric);
}

function isLikelyCorporateName(name = "") {
  const normalized = lower(name);
  return ["llc", "inc", "property", "management", "trust", "holdings"].some((token) =>
    normalized.includes(token)
  );
}

// Entity tokens that are not valid person first names.
const ENTITY_NAME_TOKENS = new Set([
  "llc", "inc", "corp", "corporation", "trust", "estate", "bank", "fund",
  "holdings", "holding", "group", "realty", "properties", "property",
  "investment", "investments", "partners", "partnership", "foundation",
  "management", "enterprises", "international", "associates", "assoc",
  "company", "co", "ltd", "limited", "services", "systems",
]);

// Patterns that indicate non-person names.
const PHONE_NUMBER_RE = /^\+?[\d\s\-().]{7,}$/;
const NUMERIC_ONLY_RE = /^\d+$/;
const EMAIL_RE = /@/;

/**
 * Validates that `raw` is a usable person first name.
 * Returns the trimmed first name, or null if it looks like an entity, phone,
 * email, or otherwise non-personal value.
 *
 * @param {string|null|undefined} raw
 * @returns {string|null}
 */
function safePersonFirstName(raw) {
  const value = clean(String(raw ?? ""));
  if (!value) return null;
  if (value.length <= 1) return null;
  if (value.length > 50) return null;
  if (PHONE_NUMBER_RE.test(value)) return null;
  if (NUMERIC_ONLY_RE.test(value)) return null;
  if (EMAIL_RE.test(value)) return null;
  
  const lower_value = value.toLowerCase();
  if (lower_value === "there" || lower_value === "current resident") return null;
  if (lower_value.includes("{") || lower_value.includes("[")) return null;
  if (lower_value === "undefined" || lower_value === "null") return null;
  
  if (ENTITY_NAME_TOKENS.has(lower_value)) return null;
  // reject if first token of a multi-word value is an entity token
  const first_token = lower_value.split(/[\s,]+/)[0];
  if (ENTITY_NAME_TOKENS.has(first_token)) return null;
  return value;
}

function deriveSellerFirstName(candidate = {}) {
  // Priority: prospect_first_name → phone_first_name → seller_first_name
  // → first token of full name fields → owner display first token → null (no fallback to phone)
  const sources = [
    candidate.prospect_first_name,
    candidate.phone_first_name,
    candidate.seller_first_name,
    candidate.owner_first_name,
  ];
  for (const src of sources) {
    const result = safePersonFirstName(src);
    if (result) return result;
  }

  // Try parsing first token out of full name fields.
  const full_name_sources = [
    candidate.seller_full_name,
    candidate.phone_full_name,
    candidate.owner_display_name,
    candidate.display_name,
    candidate.seller_name,
  ];
  for (const full of full_name_sources) {
    const trimmed = clean(String(full ?? ""));
    if (!trimmed) continue;
    const first_token = trimmed.split(/\s+/).filter(Boolean)[0] || "";
    const result = safePersonFirstName(first_token);
    if (result) return result;
  }

  return "";
}

function firstNameOnly(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  return raw
    .replace(/\s+/g, " ")
    .split(" ")[0]
    .replace(/[^\p{L}\p{M}'-]/gu, "")
    .trim();
}

function hasMultipleNameTokens(value) {
  return clean(value).replace(/\s+/g, " ").split(" ").filter(Boolean).length >= 2;
}

function parseCityStateFromAddress(address = "") {
  const text = clean(address);
  if (!text) {
    return { city: "", state: "" };
  }

  // Common pattern: "123 Main St, Houston, TX 77002"
  const comma_parts = text.split(",").map((part) => clean(part)).filter(Boolean);
  if (comma_parts.length >= 2) {
    const city = clean(comma_parts[comma_parts.length - 2]);
    const trailing = clean(comma_parts[comma_parts.length - 1]);
    const state_match = trailing.match(/^([A-Za-z]{2})\b/);
    return {
      city,
      state: state_match ? clean(state_match[1]).toUpperCase() : "",
    };
  }

  return { city: "", state: "" };
}

function getStreetAddress(value = "") {
  const normalized = clean(String(value || "").replace(/\s+/g, " "));
  if (!normalized) return "";

  const comma_index = normalized.indexOf(",");
  if (comma_index === -1) {
    return normalized;
  }

  return clean(normalized.slice(0, comma_index).replace(/\s+/g, " "));
}

function hasRenderedFullAddressSuffix(rendered_text = "", full_address = "", street_address = "") {
  const rendered = lower(clean(rendered_text));
  const full = clean(full_address);
  const street = clean(street_address);

  if (!rendered || !full || !street) return false;
  if (full.length <= street.length) return false;

  const comma_index = full.indexOf(",");
  if (comma_index === -1) return false;

  const suffix = clean(full.slice(comma_index));
  if (!suffix) return false;

  return rendered.includes(lower(suffix));
}

function isColdOutboundS1OwnershipCheck(selector = {}) {
  const use_case = clean(selector.use_case);
  const is_first_touch = Boolean(selector.is_first_touch);
  const stage_code = clean(selector.stage_code).toUpperCase();
  return use_case === "ownership_check" && is_first_touch && stage_code === "S1";
}

function rewriteAddressPlaceholdersForColdS1(template_body = "", selector = {}) {
  if (!isColdOutboundS1OwnershipCheck(selector)) {
    return template_body;
  }

  return String(template_body || "")
    .replace(/\{\{\s*property_address_full\s*\}\}/gi, "{{property_street_address}}")
    .replace(/\{\s*property_address_full\s*\}/gi, "{property_street_address}");
}

function hasBlankLocationPattern(text = "") {
  const normalized = String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  if (!normalized) return false;

  const direct_patterns = [
    " en .",
    " em .",
    " in .",
    "zai zhao",
  ];

  if (direct_patterns.some((pattern) => normalized.includes(pattern))) {
    return true;
  }

  // Detect language-specific "in <blank>." patterns with optional spaces.
  if (/\b(en|em|in)\s*\./i.test(normalized)) {
    return true;
  }

  // Mandarin romanization pattern where location token disappears.
  if (/\bzai\s{2,}zhao\b/i.test(String(text || ""))) {
    return true;
  }

  return false;
}

export function hasBlankSellerGreeting(text = "") {
  const normalized = clean(text).replace(/\s+/g, " ");
  // Blank greeting patterns (e.g. "Hey ," or trailing "Hi,") — not "Hi, this is {name}".
  if (/^(hi|hey|hello|hola|ola|marhaba)\s+,/i.test(normalized)) return true;
  if (/^(hi|hey|hello|hola|ola|marhaba)\s*,\s*$/i.test(normalized)) return true;
  
  // Unresolved variable patterns
  if (normalized.includes(", ,")) return true;
  if (normalized.includes("[]")) return true;
  if (normalized.includes("{}")) return true;
  if (normalized.includes("{{")) return true;
  if (normalized.includes("}}")) return true;
  
  // Literal "undefined" or "null" usually indicating code failure
  if (/\bundefined\b/i.test(normalized)) return true;
  if (/\bnull\b/i.test(normalized)) return true;
  
  return false;
}

/**
 * Final production blocker called immediately before createSendQueueItem().
 * Catches issues that must never reach the DB insert:
 *  - batch-level phone/owner/owner+phone+touch duplicates
 *  - unsafe seller name that would produce a blank greeting
 *  - schedule_spread requested but scheduler is null (window full or inactive)
 *
 * Items 1–3 are defense-in-depth; the primary batch checks happen earlier in the loop.
 * Items 4–5 are the new enforcement gates not covered elsewhere.
 */
function runOutboundSafetyGate(candidate, rendered, options, batchState = {}) {
  const { seenPhones, seenOwnerPhoneTouch, seenOwners, allow_multiple_per_owner, spread_scheduler } = batchState;

  const phoneKey = clean(candidate.canonical_e164 || "");
  const ownerKey = clean(candidate.master_owner_id);
  const ownerPhoneTouchKey = `${ownerKey}:${phoneKey}:${options.touch_number}`;

  // 1. Duplicate phone in current batch
  if (phoneKey && seenPhones && seenPhones.has(phoneKey)) {
    return { ok: false, reason: "outbound_gate_batch_duplicate_phone", reason_code: REASON_CODES.DUPLICATE_QUEUE_ITEM, gate_block_type: "batch_duplicate" };
  }
  // 2. Duplicate master_owner_id + to_phone_number + touch_number in current batch
  if (ownerPhoneTouchKey && seenOwnerPhoneTouch && seenOwnerPhoneTouch.has(ownerPhoneTouchKey)) {
    return { ok: false, reason: "outbound_gate_batch_duplicate_owner_phone_touch", reason_code: REASON_CODES.DUPLICATE_QUEUE_ITEM, gate_block_type: "batch_duplicate" };
  }
  // 3. Duplicate master_owner_id in current batch (unless multi-property mode)
  if (!allow_multiple_per_owner && ownerKey && seenOwners && seenOwners.has(ownerKey)) {
    return { ok: false, reason: "outbound_gate_batch_duplicate_owner", reason_code: REASON_CODES.DUPLICATE_QUEUE_ITEM, gate_block_type: "batch_duplicate" };
  }
  // 4. Unsafe seller name — rendered body must not produce a blank greeting ("Hey ,", "Hi ,", "Hey there")
  const msg_body = rendered?.rendered_message_body || "";
  if (hasBlankSellerGreeting(msg_body)) {
    return { ok: false, reason: "outbound_gate_unsafe_seller_name_blank_greeting", reason_code: REASON_CODES.TEMPLATE_RENDER_LINT_FAILURE, gate_block_type: "unsafe_name" };
  }

  // ── Phase B: Property Group Wording Lint ────────────────────────────────
  const group = candidate.canonical_property_group;
  const body_lower = lower(msg_body);
  
  if (group === 'sfr') {
    if (body_lower.includes('duplex') || body_lower.includes('triplex') || body_lower.includes('fourplex')) {
        return { ok: false, reason: "outbound_gate_property_type_mismatch_sfr_as_multi", reason_code: REASON_CODES.TEMPLATE_RENDER_LINT_FAILURE, gate_block_type: "property_mismatch" };
    }
  }

  if (group !== 'sfr' && group !== 'duplex' && group !== 'triplex' && group !== 'fourplex' && !group.includes('multifamily')) {
    // Commercial logic
    if (body_lower.includes(' house ') || body_lower.includes(' home ')) {
        return { ok: false, reason: "outbound_gate_property_type_mismatch_comm_as_house", reason_code: REASON_CODES.TEMPLATE_RENDER_LINT_FAILURE, gate_block_type: "property_mismatch" };
    }
  }

  // 5. schedule_spread requested but scheduler was not activated (overflow or window closed)
  if (options.schedule_spread && !spread_scheduler) {
    return { ok: false, reason: "outbound_gate_schedule_spread_inactive", reason_code: REASON_CODES.SCHEDULE_OVERFLOW_BLOCKED, gate_block_type: "schedule" };
  }

  return { ok: true };
}

function buildNeutralGreetingMessage(variable_payload = {}) {
  const agent = clean(
    pick(
      variable_payload.agent_name,
      variable_payload.agent_first_name,
      variable_payload.sms_agent_name,
      variable_payload.sender_name,
      "Alex"
    )
  ) || "Alex";
  const address = clean(
    pick(
      variable_payload.property_street_address,
      variable_payload.property_address,
      variable_payload.property_address_full,
      "this property"
    )
  ) || "this property";
  return `Hi, this is ${agent}. Quick question - do you still own ${address}?`;
}

function buildTemplateVariablePayload(candidate = {}) {
  const seller_identity = resolveSellerIdentity(candidate);
  const resolved_seller_full_name = clean(
    pick(
      candidate.seller_full_name,
      candidate.phone_full_name,
      candidate.owner_display_name,
      seller_identity.seller_full_name,
      seller_identity.seller_display_name
    )
  );
  const owner_display_name = clean(
    pick(candidate.raw?.display_name, candidate.owner_display_name, candidate.raw?.owner_display_name)
  );
  const language = clean(pick(candidate.best_language, candidate.language, "English")) || "English";
  const property_address_full = clean(
    pick(candidate.property_address_full, candidate.property_address, candidate.raw?.property_address_full)
  );
  const property_street_address = getStreetAddress(property_address_full);
  const parsed_location = parseCityStateFromAddress(
    property_address_full
  );

  const property_city = clean(
    pick(
      candidate.raw?.property_address_city,
      candidate.property_city,
      candidate.raw?.property_city,
      candidate.raw?.city,
      parsed_location.city,
      ""
    )
  );

  const seller_market = clean(
    pick(
      candidate.seller_market,
      candidate.market,
      candidate.normalized_market,
      candidate.raw?.seller_market,
      candidate.raw?.market,
      candidate.raw?.normalized_market,
      property_city,
      ""
    )
  );

  const market = clean(
    pick(
      candidate.market,
      candidate.seller_market,
      candidate.normalized_market,
      candidate.raw?.market,
      candidate.raw?.seller_market,
      candidate.raw?.normalized_market,
      property_city,
      ""
    )
  );

  const city = clean(pick(property_city, seller_market, market, ""));

  const property_state = clean(
    pick(
      candidate.property_state,
      candidate.state,
      candidate.raw?.property_address_state,
      candidate.raw?.property_state,
      candidate.raw?.seller_state,
      parsed_location.state,
      ""
    )
  );

  const agent_name_raw = clean(
    pick(
      candidate.agent_persona,
      candidate.agent_name_raw,
      candidate.agent_full_name_raw,
      candidate.selected_agent_display_name,
      candidate.agent_name,
      candidate.sms_agent_name,
      candidate.assigned_agent_name,
      candidate.raw?.agent_persona,
      candidate.raw?.agent_name,
      candidate.raw?.sms_agent_name,
      candidate.raw?.assigned_agent_name,
      candidate.raw?.acquisition_agent_name,
      candidate.raw?.agent_family,
      candidate.agent_family,
      "Alex"
    )
  ) || "Alex";
  const agent_first_name = firstNameOnly(
    pick(
      candidate.agent_first_name,
      candidate.sms_agent_first_name,
      candidate.raw?.agent_first_name,
      candidate.raw?.sms_agent_first_name,
      agent_name_raw
    )
  ) || "Alex";
  const property_zip = clean(
    pick(
      candidate.property_zip,
      candidate.raw?.property_address_zip,
      candidate.raw?.property_zip,
      ""
    )
  );
  const property_county_name = clean(
    pick(
      candidate.property_address_county_name,
      candidate.raw?.property_address_county_name,
      candidate.raw?.property_county_name,
      ""
    )
  );
  const payload = {
    seller_first_name: seller_identity.seller_first_name || "",
    first_name: seller_identity.seller_first_name || "",
    owner_first_name: seller_identity.seller_first_name || "",
    seller_name: seller_identity.seller_display_name || "",
    seller_display_name: seller_identity.seller_display_name || "",
    owner_display_name,
    owner_name: owner_display_name || candidate.seller_name || "",
    seller_full_name: resolved_seller_full_name || "",
    seller_name_source: seller_identity.seller_name_source,
    seller_name_missing: seller_identity.seller_name_missing,
    property_address_full,
    property_address: property_street_address || property_address_full,
    property_street_address: property_street_address || property_address_full,
    property_city,
    city,
    property_address_city: property_city,
    market,
    seller_market,
    normalized_market: clean(pick(candidate.normalized_market, candidate.raw?.normalized_market, market)),
    property_state,
    state: property_state,
    property_address_state: property_state,
    seller_state: property_state,
    property_zip,
    property_address_zip: property_zip,
    zip: property_zip,
    property_address_county_name: property_county_name,
    county: property_county_name,
    offer_price: formatCurrency(candidate.cash_offer),
    cash_offer: candidate.cash_offer,
    agent_name: agent_first_name,
    agent_first_name,
    sender_name: agent_first_name,
    sms_agent_name: agent_first_name,
    acquisition_agent_name: agent_first_name,
    rep_name: agent_first_name,
    agent_name_raw,
    agent_full_name_raw: agent_name_raw,
    selected_agent_display_name: agent_name_raw,
    language,
  };

  return payload;
}

function applyTemplatePlaceholders(template_text = "", payload = {}) {
  const missing = new Set();

  const resolveKey = (key) => {
    const normalized_key = clean(key);
    if (!normalized_key) return "";
    const value = payload[normalized_key];
    if (value === null || value === undefined || clean(value) === "") {
      missing.add(normalized_key);
      return "";
    }
    return String(value);
  };

  let rendered = String(template_text || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => resolveKey(key));
  rendered = rendered.replace(/\{\s*([a-zA-Z0-9_]+)\s*\}/g, (_, key) => resolveKey(key));

  return {
    rendered_text: rendered,
    missing_variables: [...missing],
  };
}

function scoreTemplateCandidate(template = {}, selector = {}) {
  const preferred_language = lower(selector.preferred_language || "English");
  const template_language = lower(template.language || "English");
  const preferred_persona = lower(selector.preferred_agent_persona || "");
  const template_persona = lower(template.agent_persona || "");
  const persona_exact = Boolean(preferred_persona) && template_persona === preferred_persona;
  const persona_null = !clean(template.agent_persona);
  const use_case_exact = lower(template.use_case) === lower(selector.use_case);
  const language_exact = template_language === preferred_language;
  const language_english = template_language === "english";

  let ranking_group = 7;
  if (use_case_exact && language_exact && persona_exact) ranking_group = 1;
  else if (use_case_exact && language_exact && persona_null) ranking_group = 2;
  else if (use_case_exact && language_exact) ranking_group = 3;
  else if (use_case_exact && language_english && persona_exact) ranking_group = 4;
  else if (use_case_exact && language_english && persona_null) ranking_group = 5;
  else if (use_case_exact && language_english) ranking_group = 6;

  const stage_bonus =
    lower(selector.use_case) === "ownership_check" && lower(selector.stage_code) === lower(template.stage_code)
      ? 1
      : 0;
  const touch_bonus = selector.is_first_touch
    ? asBoolean(template.is_first_touch, false)
      ? 1
      : 0
    : asBoolean(template.is_follow_up, false)
      ? 1
      : 0;

  return {
    ranking_group,
    stage_bonus,
    touch_bonus,
    success_rate: asNumber(template.success_rate, 0),
    usage_count: asNumber(template.usage_count, 0),
    version: asNumber(template.version, 0),
    updated_at_ts: new Date(template.updated_at || template.created_at || 0).getTime() || 0,
  };
}

function sortTemplateCandidates(left, right, selector) {
  const l = scoreTemplateCandidate(left, selector);
  const r = scoreTemplateCandidate(right, selector);
  if (l.ranking_group !== r.ranking_group) return l.ranking_group - r.ranking_group;
  if (l.stage_bonus !== r.stage_bonus) return r.stage_bonus - l.stage_bonus;
  if (l.touch_bonus !== r.touch_bonus) return r.touch_bonus - l.touch_bonus;
  if (l.success_rate !== r.success_rate) return r.success_rate - l.success_rate;
  if (l.usage_count !== r.usage_count) return r.usage_count - l.usage_count;
  if (l.version !== r.version) return r.version - l.version;
  return r.updated_at_ts - l.updated_at_ts;
}

function computeTemplateQualityScore(template = {}, selector = {}) {
  const ranked = scoreTemplateCandidate(template, selector);
  const quality_floor = 200;
  const ranking_score = Math.max(0, 100 - ranked.ranking_group * 12);
  const stage_score = ranked.stage_bonus * 6;
  const touch_score = ranked.touch_bonus * 5;
  const success_score = Math.max(0, Math.min(30, Number(ranked.success_rate || 0) * 30));
  const usage_score = Math.min(10, Math.log10(Math.max(1, Number(ranked.usage_count || 0))) * 4);
  const recency_score = ranked.updated_at_ts > 0 ? 1 : 0;
  return quality_floor + ranking_score + stage_score + touch_score + success_score + usage_score + recency_score;
}

function buildTemplateRotationSeed({
  master_owner_id,
  property_id,
  phone_id,
  language,
  use_case,
  stage_code,
  campaign_key,
  day_bucket,
} = {}) {
  const utc_bucket = clean(day_bucket) || new Date().toISOString().slice(0, 10);
  return [
    clean(master_owner_id),
    clean(property_id),
    clean(phone_id),
    clean(language),
    clean(use_case),
    clean(stage_code),
    clean(campaign_key),
    utc_bucket,
  ].join("|");
}

function stableSeedModulo(seed = "", modulo = 1) {
  const safe_modulo = Math.max(1, Number(modulo) || 1);
  const digest = crypto.createHash("sha1").update(clean(seed)).digest("hex");
  const numeric = Number.parseInt(digest.slice(0, 8), 16);
  return Number.isFinite(numeric) ? numeric % safe_modulo : 0;
}

function chooseRotatingTemplate(candidates = [], seed = "") {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return {
      selected: null,
      selected_index: -1,
      selected_hash_index: -1,
      rotation_pool: [],
    };
  }

  const index = stableSeedModulo(seed, candidates.length);
  const selected = candidates[index] || candidates[0] || null;
  return {
    selected,
    selected_index: candidates.findIndex((template) => {
      const left = clean(template?.template_id || template?.id || template?.item_id);
      const right = clean(selected?.template_id || selected?.id || selected?.item_id);
      return left && right ? left === right : template === selected;
    }),
    selected_hash_index: index,
    rotation_pool: candidates,
  };
}

function shouldEnableTemplateRotation(selector = {}) {
  return isColdOutboundS1OwnershipCheck(selector);
}

function normalizeLanguageToken(value = "") {
  return lower(clean(value));
}

function filterTemplatesByPreferredLanguage(templates = [], selector = {}) {
  const preferred_language = clean(pick(selector.preferred_language, selector.language, "English")) || "English";
  const preferred_language_normalized = normalizeLanguageToken(preferred_language);
  const rows = Array.isArray(templates) ? templates : [];
  const matching = rows.filter((template) =>
    normalizeLanguageToken(pick(template?.language, template?.metadata?.language, "")) === preferred_language_normalized
  );

  return {
    preferred_language,
    preferred_language_normalized,
    templates: matching,
    had_mixed_languages: new Set(
      rows
        .map((template) => clean(pick(template?.language, template?.metadata?.language, "")))
        .filter(Boolean)
    ).size > 1,
  };
}

function resolveProspectTemplateRouting(candidate = {}, selector = {}, templates = []) {
  const prospect_matching_flags = extractExactProspectMatchingFlags(candidate.matching_flags);
  const identity_unknown = lower(candidate?.identity_alignment?.status) === "unknown";
  const normalized_use_case = lower(selector.use_case);
  const rows = Array.isArray(templates) ? templates : [];

  if (normalized_use_case !== "ownership_check") {
    return {
      blocked: false,
      templates: rows,
      prospect_matching_flags,
      template_routing_reason: "template_routing_not_applicable",
    };
  }

  const use_case_templates = rows.filter((template) => lower(template?.use_case) === normalized_use_case);
  const standard_templates = use_case_templates.filter((template) => !isRelationshipProbeTemplate(template));
  const relationship_probe_templates = use_case_templates.filter((template) => isRelationshipProbeTemplate(template));
  const has_standard_only_flag = prospect_matching_flags.some((flag) =>
    STANDARD_OWNERSHIP_ONLY_PROSPECT_FLAGS.has(flag)
  );
  const has_relationship_probe_flag = prospect_matching_flags.some((flag) =>
    RELATIONSHIP_PROBE_ALLOWED_PROSPECT_FLAGS.has(flag)
  );

  if (has_standard_only_flag) {
    return {
      blocked: false,
      templates: standard_templates,
      prospect_matching_flags,
      template_routing_reason: "exact_prospect_flag_standard_ownership_only",
    };
  }

  if (has_relationship_probe_flag) {
    return {
      blocked: false,
      templates: relationship_probe_templates.length ? relationship_probe_templates : standard_templates,
      prospect_matching_flags,
      template_routing_reason: relationship_probe_templates.length
        ? "exact_prospect_flag_relationship_probe"
        : "exact_prospect_flag_standard_ownership_fallback",
    };
  }

  if (identity_unknown) {
    return {
      blocked: true,
      templates: [],
      prospect_matching_flags,
      template_routing_reason: "identity_unknown_without_exact_prospect_flag",
      reason_code: REASON_CODES.NO_TEMPLATE,
      reason: "no_safe_template_for_identity_unknown",
    };
  }

  return {
    blocked: false,
    templates: standard_templates,
    prospect_matching_flags,
    template_routing_reason: "no_exact_prospect_flag_standard_ownership_only",
  };
}

function isS1OwnershipCheckRotation(selector = {}) {
  const use_case = lower(clean(pick(selector.use_case, selector.template_use_case, "")));
  const stage_code = clean(selector.stage_code).toUpperCase();
  const preferred_language = lower(clean(pick(selector.preferred_language, selector.language, "English")));
  return use_case === "ownership_check" && stage_code === "S1" && preferred_language === "english";
}

async function getRecentTemplateIds(candidate = {}, selector = {}, options = {}, deps = {}) {
  if (typeof deps.getRecentTemplateIds === "function") {
    const custom = await deps.getRecentTemplateIds(candidate, selector, options);
    if (custom && typeof custom === "object" && !Array.isArray(custom)) return custom;
    return {
      ok: true,
      template_ids: Array.isArray(custom) ? custom.map((value) => clean(value)).filter(Boolean) : [],
      errors: [],
    };
  }

  let supabase;
  try {
    supabase = getSupabase(deps);
  } catch (error) {
    if (process.env.NODE_ENV === "test" && !deps.supabase) {
      return { ok: true, template_ids: [], errors: [] };
    }
    return {
      ok: false,
      template_ids: [],
      errors: [{ source: "supabase_client", message: error?.message || "supabase_unavailable" }],
    };
  }

  const lookback_ms = 30 * 24 * 60 * 60 * 1000;
  const cutoff_ms = Date.now() - lookback_ms;
  const errors = [];
  const rows = [];

  const queue_query = await supabase
    .from(SEND_QUEUE_TABLE)
    .select(SEND_QUEUE_HISTORY_SELECT)
    .eq("master_owner_id", candidate.master_owner_id)
    .limit(200);
  if (isPostgrestQueryError(queue_query)) {
    errors.push({
      source: "send_queue",
      message: queue_query.error?.message || "send_queue_history_query_failed",
      code: queue_query.error?.code || null,
    });
  } else if (Array.isArray(queue_query?.data)) {
    rows.push(...queue_query.data);
  }

  const events_query = await supabase
    .from("message_events")
    .select(MESSAGE_EVENTS_HISTORY_SELECT)
    .eq("master_owner_id", candidate.master_owner_id)
    .limit(200);
  if (isPostgrestQueryError(events_query)) {
    errors.push({
      source: "message_events",
      message: events_query.error?.message || "message_events_history_query_failed",
      code: events_query.error?.code || null,
    });
  } else if (Array.isArray(events_query?.data)) {
    rows.push(...events_query.data);
  }

  if (errors.length) {
    logger.warn("feeder.outreach_history_query_failed", {
      master_owner_id: candidate.master_owner_id,
      property_id: candidate.property_id,
      errors,
    });
    return { ok: false, template_ids: [], errors };
  }

  const template_ids = collectRecentTemplateIdsFromRows(rows, {
    cutoff_ms,
    selector: { ...selector, canonical_e164: candidate.canonical_e164 },
    normalizePhoneFn: normalizePhone,
  });

  return { ok: true, template_ids, errors: [] };
}

function buildRotationPool(sorted_templates = [], selector = {}) {
  const is_s1_ownership_rotation = isS1OwnershipCheckRotation(selector);
  const strategy = is_s1_ownership_rotation
    ? "cold_s1_wide_window"
    : "default_top_window";
  const score_window = is_s1_ownership_rotation ? 35 : 10;
  const min_pool_size = is_s1_ownership_rotation ? 16 : 0;
  const cap = is_s1_ownership_rotation ? 35 : 50;
  const scored = sorted_templates.map((template) => ({
    template,
    score: computeTemplateQualityScore(template, selector),
  }));

  if (!scored.length) {
    return {
      pool: [],
      best_score: null,
      min_score: null,
      strategy,
      min_pool_size,
      cap,
    };
  }

  const has_scores = scored.some((entry) => Number.isFinite(entry.score));
  if (!has_scores) {
    const fallback_pool = sorted_templates.slice(0, Math.min(Math.max(min_pool_size, 25), cap));
    return {
      pool: fallback_pool,
      best_score: null,
      min_score: null,
      strategy,
      min_pool_size,
      cap,
    };
  }

  const best_score = Math.max(...scored.map((entry) => Number(entry.score || 0)));
  const min_score = best_score - score_window;
  let pool = scored
    .filter((entry) => Number(entry.score || 0) >= min_score)
    .map((entry) => entry.template);

  if (is_s1_ownership_rotation && pool.length < min_pool_size) {
    const existing_ids = new Set(
      pool
        .map((template) => clean(template?.template_id || template?.id || template?.item_id))
        .filter(Boolean)
    );

    for (const entry of scored) {
      if (pool.length >= min_pool_size) break;
      const template = entry.template;
      const template_id = clean(template?.template_id || template?.id || template?.item_id);
      if (template_id && existing_ids.has(template_id)) continue;
      pool.push(template);
      if (template_id) existing_ids.add(template_id);
    }
  }

  if (!pool.length) {
    pool = sorted_templates.slice(0, Math.min(Math.max(min_pool_size, 25), cap));
  }

  return {
    pool: pool.slice(0, cap),
    best_score,
    min_score,
    strategy,
    min_pool_size,
    cap,
  };
}

function buildTemplateRotationDiagnostics({
  rotation_enabled = false,
  rotation_seed = "",
  eligible_template_count = 0,
  excluded_recent_template_ids = [],
  rotation_choice = {},
  selected_template = null,
  pool_result = {},
  preferred_language = "English",
  fetch_diagnostics = {},
} = {}) {
  const rotation_pool = Array.isArray(rotation_choice?.rotation_pool)
    ? rotation_choice.rotation_pool
    : [];
  const rotation_candidate_languages = [...new Set(
    rotation_pool
      .map((template) => clean(pick(template?.language, template?.metadata?.language, "")))
      .filter(Boolean)
  )];
  const selected_template_language = clean(
    pick(selected_template?.language, selected_template?.metadata?.language, "")
  ) || null;
  const preferred_language_normalized = normalizeLanguageToken(preferred_language);
  const mismatch_detected = rotation_candidate_languages.some(
    (language) => normalizeLanguageToken(language) !== preferred_language_normalized
  );

  return {
    enabled: rotation_enabled,
    seed: rotation_seed,
    preferred_language: clean(preferred_language) || "English",
    requested_language: clean(preferred_language) || "English",
    selected_template_language,
    rotation_candidate_languages,
    rotation_language_mismatch_detected: mismatch_detected,
    rotation_strategy: clean(pool_result?.strategy) || "default_top_window",
    rotation_best_score: Number.isFinite(Number(pool_result?.best_score))
      ? Number(pool_result.best_score)
      : null,
    rotation_min_score: Number.isFinite(Number(pool_result?.min_score))
      ? Number(pool_result.min_score)
      : null,
    eligible_template_count: Number(eligible_template_count || 0),
    rotation_pool_size: rotation_pool.length,
    rotation_candidate_template_ids: rotation_pool
      .map((template) => clean(template?.template_id || template?.id || template?.item_id))
      .filter(Boolean),
    excluded_recent_template_ids: Array.isArray(excluded_recent_template_ids)
      ? excluded_recent_template_ids
      : [],
    selected_template_id:
      clean(selected_template?.template_id || selected_template?.id || selected_template?.item_id) || null,
    selected_index: Number.isFinite(Number(rotation_choice?.selected_index))
      ? Number(rotation_choice.selected_index)
      : -1,
    template_fetch_limit: Number(fetch_diagnostics?.template_fetch_limit) || null,
    template_fetch_language_filter_applied: Boolean(fetch_diagnostics?.template_fetch_language_filter_applied),
    template_fetch_use_case_filter_applied: fetch_diagnostics?.template_fetch_use_case_filter_applied !== false,
    template_fetch_stage_filter_applied: Boolean(fetch_diagnostics?.template_fetch_stage_filter_applied),
    template_fetch_fallback_used: Boolean(fetch_diagnostics?.template_fetch_fallback_used),
    raw_template_count_before_language_filter: Number(fetch_diagnostics?.raw_template_count_before_language_filter || 0),
    template_count_after_language_filter: Number(fetch_diagnostics?.template_count_after_language_filter || 0),
  };
}

function parseWindowTime(value) {
  const matched = clean(value).match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i);
  if (!matched) return null;
  let hours = Number(matched[1]);
  const minutes = Number(matched[2] || 0);
  const period = matched[3].toUpperCase();
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours < 1 || hours > 12 || minutes < 0 || minutes > 59) return null;
  if (period === "AM" && hours === 12) hours = 0;
  if (period === "PM" && hours !== 12) hours += 12;
  return hours * 60 + minutes;
}

function parseContactWindowRange(window_text = "") {
  const cleaned = clean(window_text)
    .replace(/\s+/g, " ")
    .replace(/\b(CT|ET|MT|PT|CST|CDT|EST|EDT|MST|MDT|PST|PDT|LOCAL)\b/gi, "")
    .trim();
  if (!cleaned) return null;
  const parts = cleaned.split(/\s*-\s*|\s+to\s+/i);
  if (!Array.isArray(parts) || parts.length !== 2) return null;
  const start = parseWindowTime(parts[0]);
  const end = parseWindowTime(parts[1]);
  if (start === null || end === null) return null;
  return { start, end };
}

function getLocalMinutesNow(timezone) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone || "America/Chicago",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date());
    const hh = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
    const mm = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
    return hh * 60 + mm;
  } catch {
    return null;
  }
}

function computeNextSchedulableTime(candidate = {}, now_iso = new Date().toISOString()) {
  const range = parseContactWindowRange(candidate.contact_window);
  if (!range) return now_iso;
  const local_minutes = getLocalMinutesNow(candidate.timezone);
  if (local_minutes === null) return now_iso;
  if (local_minutes <= range.start) {
    const now = new Date();
    now.setUTCMinutes(now.getUTCMinutes() + Math.max(range.start - local_minutes, 0));
    return now.toISOString();
  }
  const next_day = new Date();
  next_day.setUTCDate(next_day.getUTCDate() + 1);
  next_day.setUTCHours(14, 0, 0, 0);
  return next_day.toISOString();
}

function getLocalMinutesAt(date, timezone) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone || "America/Chicago",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const hh = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
    const mm = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
    return hh * 60 + mm;
  } catch {
    return null;
  }
}

function getLocalDateTimeParts(date, timezone) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone || "America/Chicago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const value = (type) => Number(parts.find((p) => p.type === type)?.value);
    const result = {
      year: value("year"),
      month: value("month"),
      day: value("day"),
      hour: value("hour"),
      minute: value("minute"),
      second: value("second"),
    };
    return Object.values(result).every(Number.isFinite) ? result : null;
  } catch {
    return null;
  }
}

function getTimezoneOffsetMs(date, timezone) {
  const parts = getLocalDateTimeParts(date, timezone);
  if (!parts) return null;
  const local_as_utc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  return local_as_utc - date.getTime();
}

function localDateTimeToUtcMs(parts, timezone) {
  let guess = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second || 0,
    0
  );

  for (let i = 0; i < 3; i += 1) {
    const offset = getTimezoneOffsetMs(new Date(guess), timezone);
    if (offset === null) return null;
    const next = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second || 0,
      0
    ) - offset;
    if (Math.abs(next - guess) < 1000) return next;
    guess = next;
  }

  return guess;
}

function parseTimeLocal(value) {
  const cleaned = clean(value);
  const ampm_result = parseWindowTime(cleaned);
  if (ampm_result !== null) return ampm_result;
  const hhmm = cleaned.match(/^(\d{1,2}):(\d{2})$/);
  if (hhmm) {
    const hours = Number(hhmm[1]);
    const minutes = Number(hhmm[2]);
    if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
      return hours * 60 + minutes;
    }
  }
  return null;
}

function snapToNextWindowOpen(date_ms, timezone, start_minutes, end_minutes) {
  const date = new Date(date_ms);
  const local_minutes = getLocalMinutesAt(date, timezone);
  if (local_minutes === null) return date;
  if (local_minutes >= start_minutes && local_minutes < end_minutes) {
    return date;
  }
  if (local_minutes < start_minutes) {
    const delta_minutes = start_minutes - local_minutes;
    return new Date(date_ms + delta_minutes * 60 * 1000);
  }
  const minutes_to_tomorrow_start = (24 * 60 - local_minutes) + start_minutes;
  return new Date(date_ms + minutes_to_tomorrow_start * 60 * 1000);
}

function createSpreadScheduler({
  now_iso,
  schedule_start_local = "09:00",
  schedule_end_local = "20:00",
  schedule_interval_seconds_min = 45,
  schedule_interval_seconds_max = 180,
} = {}) {
  const start_minutes = parseTimeLocal(schedule_start_local) ?? (9 * 60);
  const end_minutes = parseTimeLocal(schedule_end_local) ?? (20 * 60);
  const min_seconds = Math.max(1, Number(schedule_interval_seconds_min) || 45);
  const max_seconds = Math.max(min_seconds, Number(schedule_interval_seconds_max) || min_seconds);
  const now_ms = new Date(now_iso).getTime();
  const overflow_guard_ms = now_ms + 18 * 60 * 60 * 1000;
  const cursors_by_timezone = new Map();

  function getTodayWindowUtc(timezone) {
    const requested_timezone = clean(timezone) || "America/Chicago";
    const effective_timezone = getLocalDateTimeParts(new Date(now_ms), requested_timezone)
      ? requested_timezone
      : "America/Chicago";
    const now_parts = getLocalDateTimeParts(new Date(now_ms), effective_timezone);
    if (!now_parts) return null;

    const start_utc = localDateTimeToUtcMs({
      year: now_parts.year,
      month: now_parts.month,
      day: now_parts.day,
      hour: Math.floor(start_minutes / 60),
      minute: start_minutes % 60,
      second: 0,
    }, effective_timezone);
    const end_utc = localDateTimeToUtcMs({
      year: now_parts.year,
      month: now_parts.month,
      day: now_parts.day,
      hour: Math.floor(end_minutes / 60),
      minute: end_minutes % 60,
      second: 0,
    }, effective_timezone);

    if (start_utc === null || end_utc === null) return null;
    return {
      timezone: effective_timezone,
      start_utc,
      end_utc,
    };
  }

  return {
    nextScheduledFor(candidate) {
      const window = getTodayWindowUtc(candidate.timezone || "America/Chicago");
      if (!window || window.end_utc <= window.start_utc) {
        return { scheduled_for: null, reason_code: REASON_CODES.SCHEDULE_WINDOW_FULL };
      }

      const previous_cursor = cursors_by_timezone.get(window.timezone);
      const interval_ms = (Math.floor(Math.random() * (max_seconds - min_seconds + 1)) + min_seconds) * 1000;
      const cursor_ms = previous_cursor === undefined
        ? Math.max(now_ms + 10 * 60 * 1000, window.start_utc)
        : previous_cursor + interval_ms;
      cursors_by_timezone.set(window.timezone, cursor_ms);

      if (cursor_ms > overflow_guard_ms) {
        return { scheduled_for: null, reason_code: REASON_CODES.SCHEDULE_OVERFLOW_BLOCKED };
      }

      if (cursor_ms > window.end_utc) {
        return { scheduled_for: null, reason_code: REASON_CODES.SCHEDULE_WINDOW_FULL };
      }

      return { scheduled_for: new Date(cursor_ms).toISOString(), reason_code: null };
    },
  };
}

function matchesTimezoneFilter(candidate_timezone, filter) {
  if (!filter) return true;
  const tz = lower(clean(candidate_timezone));
  const f = lower(clean(filter));
  if (f === "eastern" || f === "et" || f === "est" || f === "edt") {
    return tz.includes("new_york") || tz.includes("eastern") ||
      tz === "america/detroit" ||
      tz.startsWith("america/indiana/") ||
      tz.startsWith("america/kentucky/");
  }
  if (f === "central" || f === "ct" || f === "cst" || f === "cdt") {
    return tz === "america/chicago" || tz.includes("central");
  }
  return tz === f || tz.includes(f);
}

export async function getSupabaseFeederCandidates(
  {
    limit = 25,
    scan_limit = null,
    candidate_offset = 0,
    candidate_source = null,
    market = null,
    state = null,
    template_use_case = null,
    touch_number = 1,
    campaign_session_id = null,
    timezone_filter = null,
  } = {},
  deps = {}
) {
  const supabase = getSupabase(deps);

  const requested_source = clean(candidate_source);
  let source_name = DEFAULT_CANDIDATE_SOURCE;

  if (requested_source && ALLOWED_CANDIDATE_SOURCE_OVERRIDES.has(requested_source)) {
    source_name = requested_source;
  }

  if (requested_source && !ALLOWED_CANDIDATE_SOURCE_OVERRIDES.has(requested_source)) {
    return {
      ok: false,
      error: "CANDIDATE_SOURCE_UNAVAILABLE",
      source: source_name,
      requested_source,
      scanned_count: 0,
      rows: [],
      candidate_source_error: `candidate_source override not allowed: ${requested_source}`,
      available_hint: [...CANDIDATE_SOURCE_AVAILABLE_HINT],
    };
  }

  const requestedLimit = asPositiveInteger(limit, 25);
  const requestedScanLimit = asPositiveInteger(scan_limit, null);
  const effective_fetch_limit = requestedScanLimit !== null
    ? Math.min(requestedScanLimit, 5000)
    : Math.min(Math.max(requestedLimit * 5, 10), 2500);
  const effective_offset = Math.max(0, Math.trunc(Number(candidate_offset) || 0));

  const rows = [];
  const page_size = 1000;
  const last_index = effective_offset + effective_fetch_limit - 1;

  for (let page_start = effective_offset; page_start <= last_index; page_start += page_size) {
    const page_end = Math.min(page_start + page_size - 1, last_index);
    let query = supabase.from(source_name).select("*");

    if (ENRICHED_SOURCES.has(source_name)) {
      // Enriched views carry outreach-state columns — order fresh/high-value candidates first.
      // The REST layer does not guarantee VIEW ORDER BY, so we push ordering explicitly.
      query = query
        .order("never_contacted", { ascending: false, nullsFirst: false })
        .order("touch_count",     { ascending: true,  nullsFirst: true  })
        .order("final_acquisition_score", { ascending: false, nullsFirst: false })
        .order("best_phone_score",        { ascending: false, nullsFirst: false });
    } else if (source_name === "v_sms_campaign_queue_candidates") {
      // Base candidate view has no outreach state — order by score only.
      query = query
        .order("final_acquisition_score", { ascending: false, nullsFirst: false })
        .order("best_phone_score",        { ascending: false, nullsFirst: false });
    }

    const { data, error } = await query.range(page_start, page_end);

    if (error) {
      return {
        ok: false,
        error: "CANDIDATE_SOURCE_UNAVAILABLE",
        source: source_name,
        requested_source: requested_source || null,
        scanned_count: 0,
        rows: [],
        candidate_source_error: error?.message || String(error),
        available_hint: [...CANDIDATE_SOURCE_AVAILABLE_HINT],
      };
    }

    const page_rows = Array.isArray(data) ? data : [];
    rows.push(...page_rows);
    if (page_rows.length < page_end - page_start + 1) break;
  }

  const normalized = rows
    .map((row) =>
      normalizeCandidateRow(row, {
        template_use_case,
        touch_number,
        campaign_session_id,
        market,
        state,
      })
    )
    .filter((row) => {
      if (market && normalizeMarket(row.market) !== normalizeMarket(market)) return false;
      if (state && lower(row.state) !== lower(state)) return false;
      if (timezone_filter && !matchesTimezoneFilter(row.timezone, timezone_filter)) return false;
      return true;
    });

  return {
    ok: true,
    source: source_name,
    requested_source: requested_source || null,
    candidate_offset: effective_offset,
    scanned_count: normalized.length,
    rows: normalized,
    effective_fetch_limit,
  };
}

function getOrdinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

/**
 * getQueueRowUseCase
 * Extracts the normalized use case from various possible fields in a send_queue row.
 */
export function getQueueRowUseCase(row = {}) {
  const metadata = row.metadata || {};
  return clean(
    row.use_case_template ||
    metadata.selected_template_use_case ||
    metadata.template_use_case ||
    metadata.selected_use_case ||
    metadata.use_case ||
    metadata.template?.use_case ||
    ""
  );
}

/**
 * loadOutboundTouchHistory
 * Queries send_queue for authoritative history for a candidate.
 */
export async function loadOutboundTouchHistory(candidate = {}, options = {}, deps = {}) {
  const supabase = getSupabase(deps);
  const phone = normalizePhone(candidate.canonical_e164);
  
  if (!candidate.master_owner_id || !candidate.property_id || !phone) {
    return {
      rows: [],
      latest_sent_touch_number: 0,
      latest_sent_use_case: "",
      latest_outbound_at: "",
      has_touch_1_ownership_check: false,
      has_touch_2_consider_selling: false,
      has_touch_3_seller_asking_price: false
    };
  }

  const { data, error } = await supabase
    .from(SEND_QUEUE_TABLE)
    .select("id,queue_key,queue_status,touch_number,to_phone_number,use_case_template,metadata,scheduled_for,sent_at,created_at,updated_at")
    .eq("master_owner_id", candidate.master_owner_id)
    .eq("property_id", candidate.property_id)
    .in("queue_status", ["queued", "sending", "sent"])
    .order("created_at", { ascending: false });

  if (error) {
    logger.error("Failed to load outbound touch history", { error, candidate_id: candidate.master_owner_id });
    throw error;
  }

  const rows = (data || []).filter(row => normalizePhone(row.to_phone_number) === phone);
  
  const history = {
    rows,
    latest_sent_touch_number: 0,
    latest_sent_use_case: "",
    latest_outbound_at: "",
    has_touch_1_ownership_check: false,
    has_touch_2_consider_selling: false,
    has_touch_3_seller_asking_price: false
  };

  for (const row of rows) {
    const use_case = getQueueRowUseCase(row);
    row.template_use_case = use_case; // Compute property in JS
    const touch_number = asPositiveInteger(row.touch_number, 0);
    const outbound_at = row.sent_at || row.scheduled_for || row.created_at;

    if (touch_number > history.latest_sent_touch_number && row.queue_status === "sent") {
      history.latest_sent_touch_number = touch_number;
      history.latest_sent_use_case = use_case;
      history.latest_outbound_at = outbound_at;
    }

    if (touch_number === 1 && use_case === "ownership_check") history.has_touch_1_ownership_check = true;
    if (touch_number === 2 && use_case === "consider_selling") history.has_touch_2_consider_selling = true;
    if (touch_number === 3 && use_case === "seller_asking_price") history.has_touch_3_seller_asking_price = true;
  }

  return history;
}

export async function resolveNextOutboundTouch(candidate = {}, options = {}, deps = {}) {
  if (typeof deps.resolveNextOutboundTouch === "function") {
    return deps.resolveNextOutboundTouch(candidate, options, deps);
  }

  const raw = candidate.raw || {};
  
  // 1. Extract candidate state from view fields
  let last_sent_touch_number = asPositiveInteger(candidate.last_touch_number, 0);
  let last_sent_use_case = clean(pick(candidate.use_case_template, raw.use_case_template, raw.last_sent_use_case));
  let source = "progression_from_candidate_fields";
  let history_context = null;

  // 2. If candidate fields say no history, consult the authoritative send_queue
  if (last_sent_touch_number === 0) {
    const history = await loadOutboundTouchHistory(candidate, options, deps);
    history_context = {
      history_latest_sent_touch_number: history.latest_sent_touch_number,
      history_latest_sent_use_case: history.latest_sent_use_case,
      history_row_count: history.rows.length,
      has_touch_1_ownership_check: history.has_touch_1_ownership_check,
      has_touch_2_consider_selling: history.has_touch_2_consider_selling,
      has_touch_3_seller_asking_price: history.has_touch_3_seller_asking_price
    };

    if (history.latest_sent_touch_number > 0 || history.has_touch_1_ownership_check) {
      last_sent_touch_number = history.latest_sent_touch_number || (history.has_touch_1_ownership_check ? 1 : 0);
      last_sent_use_case = history.latest_sent_use_case || (history.has_touch_1_ownership_check ? "ownership_check" : "");
      source = "progression_from_send_queue_history";
    }
  }

  // 3. Progression Logic
  
  // Case A: No history found anywhere
  if (last_sent_touch_number === 0) {
    return {
      ok: true,
      reason_code: "OK",
      touch_number: 1,
      template_use_case: "ownership_check",
      stage_code: "S1",
      sequence_position: "1st Touch",
      is_first_touch: true,
      source: "progression_initial",
      history_context
    };
  }

  // Case B: Last sent was Touch 1 ownership_check
  if (last_sent_touch_number === 1 && (last_sent_use_case === "ownership_check" || last_sent_use_case === "")) {
     return {
      ok: true,
      reason_code: "OK",
      touch_number: 2,
      template_use_case: "consider_selling",
      stage_code: "S2",
      sequence_position: "2nd Touch",
      is_first_touch: false,
      source,
      history_context
    };
  }

  // Case C: Last sent was Touch 2 consider_selling
  if (last_sent_touch_number === 2 && last_sent_use_case === "consider_selling") {
    return {
      ok: true,
      reason_code: "OK",
      touch_number: 3,
      template_use_case: "seller_asking_price",
      stage_code: "S3",
      sequence_position: "3rd Touch",
      is_first_touch: false,
      source,
      history_context
    };
  }

  // Fallback to view defaults if we can't figure it out
  const current_touch_number = asPositiveInteger(candidate.touch_number, 1);
  const current_use_case = clean(candidate.template_lookup_use_case || candidate.template_use_case || "ownership_check");

  return {
    ok: true,
    reason_code: "OK",
    touch_number: current_touch_number,
    template_use_case: current_use_case,
    stage_code: candidate.stage_code || "S1",
    sequence_position: `${current_touch_number}${getOrdinal(current_touch_number)} Touch`,
    is_first_touch: current_touch_number === 1,
    source: "view_default",
    history_context
  };
}

async function hasDuplicateQueueItem(candidate = {}, options = {}, deps = {}) {
  if (typeof deps.hasDuplicateQueueItem === "function") {
    return deps.hasDuplicateQueueItem(candidate, options);
  }

  // Hard guard: null owner means dedup queries would match nothing and let everything through.
  if (!candidate.master_owner_id || !candidate.property_id) {
    return {
      duplicate: true,
      null_owner_block: true,
      reason_code: REASON_CODES.DUPLICATE_QUEUE_ITEM,
      reason: "cold_outbound_requires_owner_and_property",
    };
  }

  const supabase = getSupabase(deps);
  const active_statuses = ["queued", "scheduled", "pending", "approved", "ready", "sending"];
  // All terminal statuses that represent a recent send attempt — include failed/expired/cancelled
  // so a send that didn't deliver still blocks re-queue within the cooldown window.
  const terminal_cooldown_statuses = [
    "sent", "delivered",
    "expired", "failed", "failed_transport", "blocked", "carrier_blocked",
    "cancelled", "duplicate_blocked", "invalid_number", "opted_out",
    "paused_name_missing", "paused_global_lock", "paused_invalid_queue_row",
    "paused_review", "paused_max_retries", "paused_duplicate",
  ];
  const all_statuses = [...active_statuses, ...terminal_cooldown_statuses];
  const phone = normalizePhone(candidate.canonical_e164);
  const duplicate_body_cooldown_hours = asPositiveInteger(options.duplicate_body_cooldown_hours, 24);
  const cold_outbound_cooldown_days = asPositiveInteger(options.cold_outbound_cooldown_days, 30);

  // 1. Check send_queue for active or recently completed rows
  const { data, error, count } = await supabase
    .from(SEND_QUEUE_TABLE)
    .select("id,queue_status,queue_key,touch_number,to_phone_number,use_case_template,metadata,scheduled_for,sent_at,created_at,updated_at", { count: "exact" })
    .eq("master_owner_id", candidate.master_owner_id)
    .eq("property_id", candidate.property_id)
    .in("queue_status", all_statuses)
    .eq("touch_number", candidate.touch_number)
    .limit(20);

  if (error) throw error;

  const rows = Array.isArray(data) ? data : [];

  const matched_active = rows.find((row) => {
    const row_phone = normalizePhone(row?.to_phone_number);
    const template_use_case = getQueueRowUseCase(row);
    return row_phone === phone && template_use_case === clean(candidate.template_use_case) && active_statuses.includes(row.queue_status);
  });

  if (matched_active) {
    return {
      duplicate: true,
      active_queue_block: true,
      reason_code: REASON_CODES.ACTIVE_QUEUE_ITEM,
      policy: {
        match_basis: [
          "master_owner_id",
          "property_id",
          "touch_number",
          "to_phone_number",
          "template_use_case"
        ],
        blocking_statuses: active_statuses
      },
      matched_row: matched_active,
      scanned_duplicate_rows_count: count ?? rows.length
    };
  }

  const cooldown_ms = duplicate_body_cooldown_hours * 60 * 60 * 1000;
  const matched_completed_cooldown = rows.find((row) => {
    const row_phone = normalizePhone(row?.to_phone_number);
    const template_use_case = getQueueRowUseCase(row);
    if (row_phone !== phone || template_use_case !== clean(candidate.template_use_case) || !terminal_cooldown_statuses.includes(row.queue_status)) {
       return false;
    }
    const timestamp = new Date(row.sent_at || row.updated_at || row.created_at).getTime();
    return Date.now() - timestamp < cooldown_ms;
  });

  if (matched_completed_cooldown) {
    return {
      duplicate: true,
      duplicate_body_block: true,
      reason_code: REASON_CODES.DUPLICATE_QUEUE_ITEM,
      policy: {
        match_basis: [
          "master_owner_id",
          "property_id",
          "touch_number",
          "to_phone_number",
          "template_use_case"
        ],
        blocking_statuses: terminal_cooldown_statuses,
        cooldown_hours: duplicate_body_cooldown_hours
      },
      matched_row: matched_completed_cooldown,
      scanned_duplicate_rows_count: count ?? rows.length
    };
  }

  // 2. Hard phone+owner cold-outbound cooldown: check message_events for ANY prior
  // outbound contact within cold_outbound_cooldown_days. This is the backstop for when
  // contact_outreach_state is missing a row for this owner-phone pair.
  if (phone) {
    const cold_cutoff = new Date(Date.now() - cold_outbound_cooldown_days * 24 * 60 * 60 * 1000).toISOString();
    try {
      const { data: coldEvents, error: coldError } = await supabase
        .from("message_events")
        .select("id, created_at, to_phone_number, master_owner_id, property_id")
        .eq("direction", "outbound")
        .gte("created_at", cold_cutoff)
        .eq("to_phone_number", phone)
        .eq("master_owner_id", candidate.master_owner_id)
        .limit(1);

      if (!coldError && coldEvents?.length > 0) {
        const event = coldEvents[0];
        return {
          duplicate: true,
          recently_contacted: true,
          cold_outbound_cooldown_block: true,
          reason_code: REASON_CODES.RECENTLY_CONTACTED,
          cold_outbound_cooldown_days,
          matched_event: {
            id: event.id,
            created_at: event.created_at,
            phone_masked: maskPhone(event.to_phone_number),
            master_owner_id: event.master_owner_id,
            property_id: event.property_id
          }
        };
      }
    } catch {
      // Best-effort — fall through.
    }
  }

  return {
    duplicate: false,
    scanned_duplicate_rows_count: count ?? rows.length
  };
}

export async function evaluateCandidateEligibility(candidate = {}, options = {}, deps = {}) {
  if (typeof deps.evaluateCandidateEligibility === "function") {
    return deps.evaluateCandidateEligibility(candidate, options);
  }

  if (!candidate.master_owner_id) {
    return { ok: false, reason_code: REASON_CODES.NO_MASTER_OWNER, reason: "missing_master_owner_id" };
  }
  if (!candidate.property_id) {
    return { ok: false, reason_code: REASON_CODES.NO_PROPERTY, reason: "missing_property_id" };
  }
  if (!candidate.best_phone_id && !options.allow_phone_fallback) {
    return { ok: false, reason_code: REASON_CODES.NO_BEST_PHONE, reason: "missing_best_phone_id" };
  }
  if (!candidate.phone_id) {
    return { ok: false, reason_code: REASON_CODES.NO_VALID_PHONE, reason: "missing_phone_id" };
  }
  if (!candidate.canonical_e164) {
    return { ok: false, reason_code: REASON_CODES.NO_VALID_PHONE, reason: "missing_phone_e164" };
  }

  // ── Internal/test phone hard block ─────────────────────────────────────
  // Production feeder must never contact internal test numbers as seller candidates.
  if (isInternalTestPhone(candidate.canonical_e164) && !options.allow_internal_test_phones) {
    return {
      ok: false,
      reason_code: REASON_CODES.INTERNAL_TEST_PHONE,
      reason: "internal_test_phone_blocked_in_production",
      phone_masked: candidate.canonical_e164?.slice(-4),
    };
  }
  // ─────────────────────────────────────────────────────────────────────────

  if (candidate.true_post_contact_suppression) {
    return { ok: false, reason_code: REASON_CODES.SUPPRESSED, reason: "true_post_contact_suppression" };
  }
  if (candidate.active_opt_out) {
    return { ok: false, reason_code: REASON_CODES.TRUE_OPT_OUT, reason: "active_opt_out" };
  }
  if (candidate.pending_prior_touch) {
    return { ok: false, reason_code: REASON_CODES.PENDING_PRIOR_TOUCH, reason: "pending_prior_touch" };
  }

  // ── Identity Alignment Gate ─────────────────────────────────────────────
  const identity_policy = isIdentityEligibleForLiveOutbound(candidate.identity_alignment, options);
  
  if (!identity_policy.eligible) {
    if (identity_policy.reason === "identity_mismatch") {
      logger.info("outbound_identity_guard_blocked", {
        property_address: candidate.property_address_full,
        master_owner_id: candidate.master_owner_id,
        master_owner_name: candidate.owner_display_name,
        prospect_id: candidate.primary_prospect_id,
        prospect_full_name: candidate.prospect_full_name,
        phone_id: candidate.phone_id,
        phone: candidate.canonical_e164,
        identity_alignment_status: candidate.identity_alignment.status,
        identity_alignment_score: candidate.identity_alignment.score,
        identity_alignment_reasons: candidate.identity_alignment.reasons
      });

      if (!options.dry_run) {
        try {
          await quarantineIdentityMismatch(candidate, candidate.identity_alignment, deps);
        } catch (e) {
          logger.error("identity_quarantine_helper_unavailable", {
            error: e.message,
            master_owner_id: candidate.master_owner_id
          });
        }
      }

      return {
        ok: false,
        reason_code: REASON_CODES.IDENTITY_MISMATCH,
        reason: "owner_prospect_identity_mismatch",
        identity_alignment: candidate.identity_alignment
      };
    }

    return {
      ok: false,
      reason_code: REASON_CODES.IDENTITY_NOT_VERIFIED,
      reason: identity_policy.reason,
      identity_alignment: candidate.identity_alignment
    };
  }

  // ── Market Quarantine Gate ─────────────────────────────────────────────
  const blockedMarkets = asArray(options.identity_blocked_markets || process.env.IDENTITY_BLOCKED_MARKETS);
  if (blockedMarkets.length > 0 && blockedMarkets.includes(candidate.market)) {
    return {
      ok: false,
      reason_code: REASON_CODES.MARKET_IDENTITY_QUARANTINE,
      reason: "market_identity_quarantine",
      market: candidate.market
    };
  }
  // ─────────────────────────────────────────────────────────────────────────

  // ── Long-term outreach state suppression + touch cap ───────────────────
  const outreach_deps = deps.supabase ? { supabase: deps.supabase } : {};
  try {
    const outreach_suppression = await checkOutreachSuppression(
      candidate.master_owner_id,
      candidate.canonical_e164,
      outreach_deps
    );
    if (outreach_suppression.suppressed) {
      return {
        ok: false,
        reason_code: REASON_CODES.PENDING_PRIOR_TOUCH,
        reason: outreach_suppression.reason || "outreach_state_suppressed",
        suppression_until: outreach_suppression.until,
        touch_count: outreach_suppression.touch_count,
      };
    }
    // Touch cap: cold outbound (touch 1) is blocked after 5 confirmed sends.
    const cold_outbound_touch_cap = asPositiveInteger(options.cold_outbound_touch_cap, 5);
    const touch_count = outreach_suppression.touch_count ?? 0;
    if (Number(candidate.touch_number ?? 1) === 1 && touch_count >= cold_outbound_touch_cap) {
      return {
        ok: false,
        reason_code: REASON_CODES.COLD_OUTBOUND_TOUCH_CAP,
        reason: "cold_outbound_touch_cap_reached",
        touch_count,
        cold_outbound_touch_cap,
      };
    }
  } catch (suppressErr) {
    logger.warn("outreach.suppression_check_failed", {
      error: suppressErr?.message,
      master_owner_id: candidate.master_owner_id,
    });
  }

  // ── Phone-level cooldown (any owner, same phone, 14 days) ───────────────
  // Prevents contacting the same phone through multiple owner/property records.
  try {
    const phone_cooldown = await checkPhoneLevelCooldown(candidate.canonical_e164, {
      ...outreach_deps,
      phone_cooldown_days: asPositiveInteger(options.phone_cooldown_days, 14),
    });
    if (phone_cooldown.blocked) {
      return {
        ok: false,
        reason_code: REASON_CODES.PHONE_LEVEL_COOLDOWN,
        reason: "phone_level_cooldown",
        last_sms_at: phone_cooldown.last_sms_at,
        matching_owner_id: phone_cooldown.matching_owner_id,
      };
    }
  } catch (phoneCooldownErr) {
    logger.warn("outreach.phone_cooldown_check_failed", {
      error: phoneCooldownErr?.message,
      canonical_e164: candidate.canonical_e164?.slice(-4),
    });
  }
  // ─────────────────────────────────────────────────────────────────────────

  const duplicate_check = await hasDuplicateQueueItem(candidate, options, deps);
  if (duplicate_check.duplicate) {
    return { 
      ok: false, 
      reason_code: REASON_CODES.DUPLICATE_QUEUE_ITEM, 
      reason: "duplicate_queue_item",
      duplicate_check 
    };
  }

  if (candidate.next_eligible_at && new Date(candidate.next_eligible_at).getTime() > new Date(options.now || Date.now()).getTime()) {
    return { ok: false, reason_code: REASON_CODES.PENDING_PRIOR_TOUCH, reason: "next_eligible_at_future", next_eligible_at: candidate.next_eligible_at };
  }

  const window_check = evaluateContactWindow(
    {
      contact_window: candidate.contact_window || null,
      timezone: candidate.timezone || "America/Chicago",
      scheduled_for: options.now || new Date().toISOString(),
    },
    { now: options.now }
  );

  if (options.within_contact_window_now && !window_check.allowed) {
    return {
      ok: false,
      reason_code: REASON_CODES.OUTSIDE_CONTACT_WINDOW,
      reason: "outside_contact_window",
      contact_window: window_check,
    };
  }

  return {
    ok: true,
    reason_code: "OK",
    reason: "eligible",
    contact_window: window_check,
    scheduled_for: options.within_contact_window_now
      ? options.now || new Date().toISOString()
      : computeNextSchedulableTime(candidate, options.now || new Date().toISOString()),
  };
}

function isRoutingConfigEnabled(value) {
  return asBoolean(value, false) || isTruthyDataFlag(value);
}

function normalizeRoutingAliases(value) {
  return asArray(value).map((entry) => normalizeMarket(entry));
}

function normalizeTextgridNumberRow(row = {}) {
  const market = clean(pick(row.market_name, row.market, row.seller_market));
  const state_aliases = asArray(pick(row.allowed_states, row.cluster_states, row.routing_states));
  return {
    raw: row,
    id: pick(row.id, row.textgrid_number_id),
    phone_number: normalizePhone(pick(row.phone_number, row.number, row.e164)),
    market,
    market_normalized: normalizeMarket(market),
    aliases: normalizeRoutingAliases(pick(row.approved_market_aliases, row.routing_aliases)),
    status: lower(pick(row.status, row.number_status, "active")),
    allow_nationwide_fallback: isRoutingConfigEnabled(row.allow_nationwide_fallback),
    allow_cluster_fallback: isRoutingConfigEnabled(row.allow_cluster_fallback),
    is_nationwide: isRoutingConfigEnabled(pick(row.is_nationwide, row.nationwide, false)),
    state_aliases: state_aliases.map((entry) => lower(entry)),
    messages_sent_today: asNumber(pick(row.messages_sent_today, row.sent_today), 0),
    last_used_at: clean(row.last_used_at) || null,
  };
}

function buildRoutingSelection({
  selected,
  routing_tier,
  selection_reason,
  routing_rule_name = null,
  seller_market = null,
  seller_state = null,
  rejected_candidate_count = 0,
} = {}) {
  return {
    ok: true,
    reason_code: "OK",
    routing_allowed: true,
    routing_tier,
    selection_reason,
    routing_rule_name,
    selected_textgrid_market: selected?.market || null,
    selected_textgrid_number: selected?.phone_number || null,
    seller_market: seller_market || null,
    seller_state: seller_state || null,
    rejected_candidate_count,
    routing_block_reason: null,
    selected: {
      id: selected?.id || null,
      phone_number: selected?.phone_number || null,
      market: selected?.market || null,
    },
  };
}

function byUsageThenRecency(left, right) {
  const left_sent = asNumber(left.messages_sent_today, 0);
  const right_sent = asNumber(right.messages_sent_today, 0);
  if (left_sent !== right_sent) return left_sent - right_sent;

  const left_ts = left.last_used_at ? new Date(left.last_used_at).getTime() : 0;
  const right_ts = right.last_used_at ? new Date(right.last_used_at).getTime() : 0;
  return left_ts - right_ts;
}

export async function chooseTextgridNumber(candidate = {}, options = {}, deps = {}) {
  if (typeof deps.chooseTextgridNumber === "function") {
    return deps.chooseTextgridNumber(candidate, options);
  }

  const supabase = getSupabase(deps);
  const { data, error } = await supabase
    .from(TEXTGRID_NUMBERS_TABLE)
    .select("*")
    .limit(200);

  if (error) throw error;

  const numbers = (Array.isArray(data) ? data : [])
    .map(normalizeTextgridNumberRow)
    .filter((row) => row.id && row.phone_number && (!row.status || row.status === "active"));

  if (!numbers.length) {
    return {
      ok: false,
      reason_code: REASON_CODES.NO_VALID_TEXTGRID_NUMBER,
      routing_allowed: false,
      routing_tier: "none",
      selection_reason: null,
      routing_rule_name: null,
      selected_textgrid_market: null,
      selected_textgrid_number: null,
      seller_market: candidate.market || null,
      seller_state: candidate.state || null,
      routing_block_reason: "NO_ACTIVE_TEXTGRID_NUMBERS",
      selected: null,
    };
  }

  const seller_market = normalizeMarket(candidate.market);
  const seller_state = lower(candidate.state);
  const has_explicit_touch = candidate.touch_number != null || candidate.is_first_touch != null;
  const first_touch = asBoolean(
    options.first_touch ?? candidate.is_first_touch,
    has_explicit_touch ? Number(candidate.touch_number || 1) === 1 : false
  );
  const require_local_routing = asBoolean(options.require_local_routing, false);
  const allow_regional_fallback_for_first_touch = asBoolean(
    options.allow_regional_fallback_for_first_touch,
    false
  );
  const exact_market_required =
    require_local_routing || (first_touch && !allow_regional_fallback_for_first_touch);

  const exact = numbers.filter((row) => row.market_normalized === seller_market).sort(byUsageThenRecency);
  const alias = numbers
    .filter((row) => row.aliases.includes(seller_market) && row.market_normalized !== seller_market)
    .sort(byUsageThenRecency);
  const regional_rule = findRegionalRoutingRule(seller_state);
  const regional = regional_rule
    ? regional_rule.target_markets
        .map((target_market) => {
          const target_market_normalized = normalizeMarket(target_market);
          const candidates = numbers
            .filter((row) => row.market_normalized === target_market_normalized)
            .sort(byUsageThenRecency);
          return candidates.length
            ? {
                target_market,
                selected: candidates[0],
              }
            : null;
        })
        .filter(Boolean)
    : [];
  const nationwide = numbers
    .filter((row) => row.is_nationwide && row.allow_nationwide_fallback)
    .sort(byUsageThenRecency);

  if (exact.length) {
    return buildRoutingSelection({
      selected: exact[0],
      routing_tier: "exact_market_match",
      selection_reason: "exact_market_match",
      routing_rule_name: "exact_market_match",
      seller_market: candidate.market,
      seller_state: candidate.state,
      rejected_candidate_count: Math.max(0, numbers.length - 1),
    });
  }

  if (exact_market_required) {
    return {
      ok: false,
      reason_code: REASON_CODES.ROUTING_BLOCKED,
      routing_allowed: false,
      routing_tier: "blocked",
      selection_reason: null,
      routing_rule_name: regional_rule?.name || null,
      selected_textgrid_market: null,
      selected_textgrid_number: null,
      seller_market: candidate.market || null,
      seller_state: candidate.state || null,
      rejected_candidate_count: numbers.length,
      routing_block_reason: "NO_VALID_LOCAL_TEXTGRID_NUMBER",
      selected: null,
      diagnostics: {
        require_local_routing,
        first_touch,
        allow_regional_fallback_for_first_touch,
        exact_market_required,
        seller_market: candidate.market || null,
        selected_textgrid_market: null,
        rejected_candidate_count: numbers.length,
      },
    };
  }

  if (alias.length) {
    return buildRoutingSelection({
      selected: alias[0],
      routing_tier: "approved_alias_match",
      selection_reason: "approved_alias_match",
      routing_rule_name: "approved_alias_match",
      seller_market: candidate.market,
      seller_state: candidate.state,
      rejected_candidate_count: Math.max(0, numbers.length - 1),
    });
  }

  if (regional.length) {
    return buildRoutingSelection({
      selected: regional[0].selected,
      routing_tier: "approved_regional_fallback",
      selection_reason: `approved_regional_fallback:${regional[0].target_market}`,
      routing_rule_name: regional_rule?.name || null,
      seller_market: candidate.market,
      seller_state: candidate.state,
      rejected_candidate_count: Math.max(0, numbers.length - 1),
    });
  }

  if (!options.routing_safe_only && nationwide.length) {
    return buildRoutingSelection({
      selected: nationwide[0],
      routing_tier: "approved_nationwide_fallback",
      selection_reason: "approved_nationwide_fallback",
      routing_rule_name: "approved_nationwide_fallback",
      seller_market: candidate.market,
      seller_state: candidate.state,
      rejected_candidate_count: Math.max(0, numbers.length - 1),
    });
  }

  return {
      ok: false,
      reason_code: REASON_CODES.ROUTING_BLOCKED,
      routing_allowed: false,
      routing_tier: "blocked",
      selection_reason: null,
      routing_rule_name: regional_rule?.name || null,
      selected_textgrid_market: null,
      selected_textgrid_number: null,
      seller_market: candidate.market || null,
      seller_state: candidate.state || null,
      rejected_candidate_count: numbers.length,
      routing_block_reason: "NO_APPROVED_ROUTING_PATH",
      selected: null,
    };
}

export async function renderOutboundTemplate(candidate = {}, options = {}, deps = {}) {
  if (typeof deps.renderOutboundTemplate === "function") {
    return deps.renderOutboundTemplate(candidate, options);
  }

  const selector = {
    use_case: clean(options.template_use_case || candidate.template_lookup_use_case || candidate.template_use_case) || "ownership_check",
    stage_code: clean(candidate.stage_code) || "S1",
    stage_label: clean(candidate.stage_label) || "Ownership Confirmation",
    touch_number: asPositiveInteger(candidate.touch_number, 1),
    is_first_touch: Number(candidate.touch_number || 1) === 1,
    preferred_language: clean(pick(candidate.best_language, candidate.language, "English")) || "English",
    preferred_agent_persona: clean(candidate.agent_persona) || "",
    property_type_scope: clean(candidate.raw?.property_type_scope) || null,
    deal_strategy: clean(candidate.raw?.deal_strategy) || null,
  };
  const template_routing_details = {
    prospect_matching_flags: extractExactProspectMatchingFlags(candidate.matching_flags),
    selected_template_id: null,
    template_routing_reason: lower(selector.use_case) === "ownership_check"
      ? "template_routing_pending"
      : "template_routing_not_applicable",
  };

  const is_cold_s1_fetch = isS1OwnershipCheckRotation(selector);
  const fetch_limit = is_cold_s1_fetch ? 500 : 200;
  const fetch_language = clean(selector.preferred_language) || null;

  let fetch_diagnostics = {
    template_fetch_limit: fetch_limit,
    template_fetch_language_filter_applied: Boolean(fetch_language),
    template_fetch_use_case_filter_applied: true,
    template_fetch_stage_filter_applied: false,
    template_fetch_fallback_used: false,
    raw_template_count_before_language_filter: 0,
    template_count_after_language_filter: 0,
  };

  let templates = [];
  if (typeof deps.fetchSmsTemplates === "function") {
    templates = await deps.fetchSmsTemplates(selector, candidate, options);
    fetch_diagnostics = {
      ...fetch_diagnostics,
      raw_template_count_before_language_filter: templates.length,
    };
  } else {
    const supabase = getSupabase(deps);

    let primary_query = supabase
      .from("sms_templates")
      .select("*")
      .eq("is_active", true)
      .eq("use_case", selector.use_case);

    if (fetch_language) {
      primary_query = primary_query.ilike("language", fetch_language);
    }

    primary_query = primary_query.limit(fetch_limit);

    const { data, error } = await primary_query;

    if (error) {
      return {
        ok: false,
        reason_code: REASON_CODES.TEMPLATE_RENDER_FAILED,
        reason: "template_query_failed",
        render_error_message: error?.message || String(error),
        template: null,
        rendered_message_body: null,
        missing_variables: [],
        variable_payload_preview: {},
        selected_template_preview: null,
        ...template_routing_details,
      };
    }

    const primary_rows = Array.isArray(data) ? data : [];
    fetch_diagnostics.raw_template_count_before_language_filter = primary_rows.length;
    templates = primary_rows;

    if (!templates.length) {
      let fallback_query = supabase
        .from("sms_templates")
        .select("*")
        .eq("is_active", true);

      if (fetch_language) {
        fallback_query = fallback_query.ilike("language", fetch_language);
      }

      fallback_query = fallback_query.limit(fetch_limit);

      const fallback_any_use_case = await fallback_query;
      const fallback_rows = Array.isArray(fallback_any_use_case?.data) ? fallback_any_use_case.data : [];

      if (fallback_rows.length) {
        fetch_diagnostics.template_fetch_fallback_used = true;
        fetch_diagnostics.raw_template_count_before_language_filter = fallback_rows.length;
      }
      templates = fallback_rows;
    }
  }

  // Save all fetched templates before language filter for English universal fallback
  const all_fetched_templates = templates.slice();

  const language_filtered = filterTemplatesByPreferredLanguage(templates, selector);
  fetch_diagnostics.template_count_after_language_filter = language_filtered.templates.length;
  templates = language_filtered.templates;
  const prospect_template_routing = resolveProspectTemplateRouting(candidate, selector, templates);
  template_routing_details.prospect_matching_flags = prospect_template_routing.prospect_matching_flags;
  template_routing_details.template_routing_reason = prospect_template_routing.template_routing_reason;

  if (prospect_template_routing.blocked) {
    logger.warn("feeder.template_routing_blocked", {
      master_owner_id: candidate.master_owner_id,
      property_id: candidate.property_id,
      prospect_matching_flags: template_routing_details.prospect_matching_flags,
      selected_template_id: null,
      template_routing_reason: template_routing_details.template_routing_reason,
    });
    return {
      ok: false,
      reason_code: prospect_template_routing.reason_code || REASON_CODES.NO_TEMPLATE,
      reason: prospect_template_routing.reason || "no_safe_template_for_identity_unknown",
      template: null,
      rendered_message_body: null,
      missing_variables: [],
      variable_payload_preview: buildTemplateVariablePayload(candidate),
      selected_template_preview: null,
      template_fallback_level: 0,
      ...template_routing_details,
    };
  }

  // ── Phase B: Property group filtering with 5-level fallback cascade ─────────
  const candidate_group = candidate.canonical_property_group || "other_commercial";
  const property_type = clean(
    pick(candidate.property_type, candidate.raw?.property_type, candidate.raw?.property_class)
  );

  // Reusable property group filter (same logic for all levels)
  const filterByPropertyGroup = (tmplList) => tmplList.filter((t) => {
    const allowed = Array.isArray(t.allowed_property_groups) ? t.allowed_property_groups : [];
    const prohibited = Array.isArray(t.prohibited_property_groups) ? t.prohibited_property_groups : [];
    if (prohibited.includes(candidate_group)) return false;
    if (allowed.length > 0 && !allowed.includes(candidate_group)) {
      if (!canRenderOwnershipTemplateWithoutPropertyType(t, candidate, selector)) return false;
    }
    if (candidate_group === "sfr" && !isGenericOwnershipTemplateBody(t)) return false;
    return true;
  });

  // Standard (non-relationship-probe) templates from the language-filtered set
  const use_case_lower = lower(selector.use_case);
  const all_standard_templates = language_filtered.templates.filter(
    (t) => lower(t.use_case || "") === use_case_lower && !isRelationshipProbeTemplate(t)
  );

  // Prospect-routed templates (the specific subset returned by prospect flag routing)
  const prospect_routed_templates = prospect_template_routing.templates;

  // Build fallback levels — stop at the first non-empty set
  let template_fallback_level = 0;
  let fallback_routing_reason = template_routing_details.template_routing_reason;

  // Level 1: exact prospect route + property group filter
  const lvl1 = filterByPropertyGroup(prospect_routed_templates);
  if (lvl1.length) {
    templates = lvl1;
    template_fallback_level = 1;
  } else if (prospect_routed_templates.length) {
    // Level 2: exact prospect route, relax property group filter
    templates = prospect_routed_templates;
    template_fallback_level = 2;
    fallback_routing_reason = fallback_routing_reason + "_property_relaxed";
  } else {
    // Level 3: standard ownership + property group filter (drop prospect specificity)
    const lvl3 = filterByPropertyGroup(all_standard_templates);
    if (lvl3.length) {
      templates = lvl3;
      template_fallback_level = 3;
      fallback_routing_reason = "standard_ownership_property_fallback";
    } else if (all_standard_templates.length) {
      // Level 4: standard ownership, relax property group filter
      templates = all_standard_templates;
      template_fallback_level = 4;
      fallback_routing_reason = "standard_ownership_fallback";
    } else {
      // Level 5: universal English ownership fallback (language-agnostic)
      const english_standard = all_fetched_templates.filter(
        (t) => lower(t.use_case || "") === use_case_lower &&
               !isRelationshipProbeTemplate(t) &&
               lower(t.language || "") === "english"
      );
      const lvl5 = filterByPropertyGroup(english_standard);
      templates = lvl5.length ? lvl5 : english_standard;
      template_fallback_level = 5;
      fallback_routing_reason = "universal_english_fallback";
    }
  }

  template_routing_details.template_routing_reason = fallback_routing_reason;
  template_routing_details.template_fallback_level = template_fallback_level;

  if (!templates.length) {
    logTemplateRenderFailure(candidate, "no_template_after_fallback", {
      selected_template_id: null,
      missing_variables: [],
      template_routing_reason: fallback_routing_reason,
      candidate_group,
      property_type,
    });
    logger.info("feeder.template_routing_no_template", {
      master_owner_id: candidate.master_owner_id,
      property_id: candidate.property_id,
      prospect_matching_flags: template_routing_details.prospect_matching_flags,
      selected_template_id: null,
      template_routing_reason: fallback_routing_reason,
      template_fallback_level,
    });
    return {
      ok: false,
      reason_code: REASON_CODES.NO_TEMPLATE,
      reason: "no_template_after_fallback",
      template: null,
      rendered_message_body: null,
      missing_variables: [],
      variable_payload_preview: buildTemplateVariablePayload(candidate),
      selected_template_preview: null,
      template_fallback_level,
      template_rotation: {
        enabled: false,
        preferred_language: language_filtered.preferred_language,
        requested_language: language_filtered.preferred_language,
        selected_template_language: null,
        rotation_candidate_languages: [],
        rotation_language_mismatch_detected: false,
        rotation_strategy: "no_template_after_fallback",
        rotation_best_score: null,
        rotation_min_score: null,
        eligible_template_count: 0,
        rotation_pool_size: 0,
        rotation_candidate_template_ids: [],
        excluded_recent_template_ids: [],
        selected_template_id: null,
        selected_index: -1,
        ...fetch_diagnostics,
      },
      ...template_routing_details,
    };
  }

  const sorted_templates = [...templates].sort((left, right) => sortTemplateCandidates(left, right, selector));
  let selected_template = sorted_templates[0] || null;
  const rotation_enabled = shouldEnableTemplateRotation(selector);
  const recent_history = rotation_enabled
    ? await getRecentTemplateIds(candidate, selector, options, deps)
    : { ok: true, template_ids: [], errors: [] };

  if (rotation_enabled && recent_history.ok === false) {
    return {
      ok: false,
      reason_code: REASON_CODES.OUTREACH_HISTORY_UNAVAILABLE,
      reason: "outreach_history_unavailable",
      history_errors: recent_history.errors || [],
      template_fallback_level,
      template_rotation: {
        enabled: false,
        history_query_failed: true,
        history_errors: recent_history.errors || [],
      },
      ...template_routing_details,
    };
  }

  const recent_template_ids = recent_history.template_ids || [];

  let eligible_rotation_candidates = sorted_templates;
  if (rotation_enabled && recent_template_ids.length) {
    const recent_id_set = new Set(recent_template_ids.map((value) => clean(value)));
    const without_recent = sorted_templates.filter((template) => {
      const template_id = clean(template?.template_id || template?.id || template?.item_id);
      return !template_id || !recent_id_set.has(template_id);
    });
    if (without_recent.length) {
      eligible_rotation_candidates = without_recent;
    }
  }

  const pool_result = rotation_enabled
    ? buildRotationPool(eligible_rotation_candidates, selector)
    : { pool: [selected_template].filter(Boolean), best_score: null };
  const rotation_seed = buildTemplateRotationSeed({
    master_owner_id: candidate.master_owner_id,
    property_id: candidate.property_id,
    phone_id: candidate.best_phone_id || candidate.phone_id,
    language: selector.preferred_language,
    use_case: selector.use_case,
    stage_code: selector.stage_code,
    campaign_key: clean(options.campaign_key || options.campaign_session_id || candidate.campaign_session_id),
    day_bucket: clean(options.day_bucket) || clean(options.now).slice(0, 10),
  });
  const rotation_choice = rotation_enabled
    ? chooseRotatingTemplate(pool_result.pool, rotation_seed)
    : {
        selected: selected_template,
        selected_index: selected_template ? 0 : -1,
        selected_hash_index: selected_template ? 0 : -1,
        rotation_pool: [selected_template].filter(Boolean),
      };

  selected_template = rotation_choice.selected || selected_template;
  template_routing_details.selected_template_id = getTemplateReferenceId(selected_template);
  const template_rotation = buildTemplateRotationDiagnostics({
    rotation_enabled,
    rotation_seed,
    eligible_template_count: sorted_templates.length,
    excluded_recent_template_ids: recent_template_ids,
    rotation_choice,
    selected_template,
    pool_result,
    preferred_language: language_filtered.preferred_language,
    fetch_diagnostics,
  });
  logger.info("feeder.template_routing_selected", {
    master_owner_id: candidate.master_owner_id,
    property_id: candidate.property_id,
    prospect_matching_flags: template_routing_details.prospect_matching_flags,
    selected_template_id: template_routing_details.selected_template_id,
    template_routing_reason: template_routing_details.template_routing_reason,
  });

  const selected_template_with_source = selected_template
    ? { ...selected_template, source: "sms_templates" }
    : null;
  const source_body = clean(pick(selected_template?.template_body, selected_template?.english_translation));
  const rewritten_source_body = rewriteAddressPlaceholdersForColdS1(source_body, selector);

  if (!rewritten_source_body) {
    logTemplateRenderFailure(candidate, "rendered_message_empty", {
      template_id: getTemplateReferenceId(selected_template),
      missing_variables: [],
      template_routing_reason: template_routing_details.template_routing_reason,
      candidate_group,
      property_type,
    });
    return {
      ok: false,
      reason_code: REASON_CODES.TEMPLATE_RENDER_FAILED,
      reason: "rendered_message_empty",
      render_error_message: "rendered_message_empty",
      template: selected_template_with_source,
      rendered_message_body: null,
      missing_variables: [],
      variable_payload_preview: buildTemplateVariablePayload(candidate),
      selected_template_preview: {
        id: selected_template?.id || null,
        template_id: selected_template?.template_id || null,
        podio_template_id: selected_template?.podio_template_id || null,
        template_name: selected_template?.template_name || null,
        use_case: selected_template?.use_case || null,
        language: selected_template?.language || null,
        stage_code: selected_template?.stage_code || null,
        stage_label: selected_template?.stage_label || null,
      },
      template_rotation,
      ...template_routing_details,
    };
  }

  const seller_identity = resolveSellerIdentity(candidate);
  const resolved_seller_full_name = clean(
    pick(
      candidate.seller_full_name,
      candidate.phone_full_name,
      candidate.owner_display_name,
      seller_identity.seller_full_name,
      seller_identity.seller_display_name
    )
  );
  const variable_payload = buildTemplateVariablePayload(candidate);
  variable_payload.seller_first_name = seller_identity.seller_first_name || "";
  variable_payload.first_name = seller_identity.seller_first_name || "";
  variable_payload.owner_first_name = seller_identity.seller_first_name || "";
  variable_payload.seller_name = seller_identity.seller_display_name || "";
  variable_payload.seller_display_name = seller_identity.seller_display_name || "";
  variable_payload.seller_full_name = resolved_seller_full_name || "";
  variable_payload.seller_name_source = seller_identity.seller_name_source;
  variable_payload.seller_name_missing = seller_identity.seller_name_missing;
  const raw_agent_name = clean(
    pick(
      variable_payload.agent_name_raw,
      variable_payload.agent_full_name_raw,
      variable_payload.selected_agent_display_name,
      variable_payload.agent_name,
      variable_payload.agent_first_name,
      variable_payload.sms_agent_name,
      variable_payload.sender_name,
      variable_payload.rep_name,
      variable_payload.acquisition_agent_name,
      "Alex"
    )
  ) || "Alex";
  const agent_first_name_safe = firstNameOnly(
    pick(
      variable_payload.agent_first_name,
      variable_payload.agent_name,
      variable_payload.sms_agent_name,
      variable_payload.sender_name,
      variable_payload.rep_name,
      variable_payload.acquisition_agent_name,
      raw_agent_name
    )
  ) || "Alex";
  variable_payload.agent_name = agent_first_name_safe;
  variable_payload.agent_first_name = agent_first_name_safe;
  variable_payload.sms_agent_name = agent_first_name_safe;
  variable_payload.sender_name = agent_first_name_safe;
  variable_payload.rep_name = agent_first_name_safe;
  variable_payload.acquisition_agent_name = agent_first_name_safe;
  variable_payload.agent_name_raw = raw_agent_name;
  variable_payload.agent_full_name_raw = raw_agent_name;
  variable_payload.selected_agent_display_name = raw_agent_name;
  const rendered = applyTemplatePlaceholders(rewritten_source_body, variable_payload);
  const normalized_rendered = clean(decodeBasicHtmlEntities(stripHtml(rendered.rendered_text || "")));

  if (hasBlankSellerGreeting(normalized_rendered)) {
    logger.warn("feeder.blank_greeting_rendered", {
        master_owner_id: candidate.master_owner_id,
        property_id: candidate.property_id,
        phone_id: candidate.phone_id || candidate.best_phone_id,
        template_id: selected_template?.template_id || selected_template?.id || null,
        rendered_preview: normalized_rendered.slice(0, 80),
      });
    logTemplateRenderFailure(candidate, "blank_greeting_rendered", {
      template_id: getTemplateReferenceId(selected_template),
      missing_variables: rendered.missing_variables,
      template_routing_reason: template_routing_details.template_routing_reason,
      candidate_group,
      property_type,
    });
    return {
      ok: false,
      reason_code: REASON_CODES.TEMPLATE_RENDER_LINT_FAILURE,
      reason: "blank_greeting_rendered",
      render_error_message: "Rendered message begins with blank seller-name greeting",
      rendered_preview: normalized_rendered.slice(0, 200),
      template: selected_template_with_source,
      template_id: selected_template?.template_id || selected_template?.id || null,
      rendered_message_body: null,
      missing_variables: rendered.missing_variables,
      variable_payload_preview: variable_payload,
      selected_template_preview: {
        id: selected_template?.id || null,
        template_id: selected_template?.template_id || null,
        podio_template_id: selected_template?.podio_template_id || null,
        template_name: selected_template?.template_name || null,
        use_case: selected_template?.use_case || null,
        language: selected_template?.language || null,
        stage_code: selected_template?.stage_code || null,
        stage_label: selected_template?.stage_label || null,
      },
      template_rotation,
      ...template_routing_details,
    };
  }

  // Hard block: if template uses a seller/owner name variable but it resolved empty,
  // drop the candidate — never queue a row with a blank greeting.
  const NAME_REQUIRED_VARIABLES = new Set(["seller_first_name", "first_name", "owner_first_name", "seller_name"]);
  const missing_name_vars = rendered.missing_variables.filter((v) => NAME_REQUIRED_VARIABLES.has(v));
  if (missing_name_vars.length > 0) {
    logger.warn("feeder.missing_required_variable", {
        master_owner_id: candidate.master_owner_id,
        property_id: candidate.property_id,
        phone_id: candidate.phone_id || candidate.best_phone_id,
        template_id: selected_template?.template_id || selected_template?.id || null,
        missing_vars: missing_name_vars,
      });
    logTemplateRenderFailure(candidate, "missing_required_name_variable", {
      template_id: getTemplateReferenceId(selected_template),
      missing_variables: rendered.missing_variables,
      template_routing_reason: template_routing_details.template_routing_reason,
      candidate_group,
      property_type,
    });
    return {
      ok: false,
      reason_code: REASON_CODES.TEMPLATE_RENDER_LINT_FAILURE,
      reason: "missing_required_name_variable",
      render_error_message: `Required name variables missing: ${missing_name_vars.join(", ")}`,
      template: selected_template_with_source,
      rendered_message_body: null,
      missing_variables: rendered.missing_variables,
      variable_payload_preview: variable_payload,
      template_rotation,
      ...template_routing_details,
    };
  }
  if (!normalized_rendered) {
    logTemplateRenderFailure(candidate, "rendered_message_empty", {
      template_id: getTemplateReferenceId(selected_template),
      missing_variables: rendered.missing_variables,
      template_routing_reason: template_routing_details.template_routing_reason,
      candidate_group,
      property_type,
    });
    return {
      ok: false,
      reason_code: REASON_CODES.TEMPLATE_RENDER_FAILED,
      reason: "rendered_message_empty",
      render_error_message: "rendered_message_empty",
      template: selected_template_with_source,
      rendered_message_body: null,
      missing_variables: rendered.missing_variables,
      variable_payload_preview: variable_payload,
      selected_template_preview: {
        id: selected_template?.id || null,
        template_id: selected_template?.template_id || null,
        podio_template_id: selected_template?.podio_template_id || null,
        template_name: selected_template?.template_name || null,
        use_case: selected_template?.use_case || null,
        language: selected_template?.language || null,
        stage_code: selected_template?.stage_code || null,
        stage_label: selected_template?.stage_label || null,
      },
      template_rotation,
      ...template_routing_details,
    };
  }

  if (hasBlankLocationPattern(normalized_rendered)) {
    logTemplateRenderFailure(candidate, "blank_location_placeholder", {
      template_id: getTemplateReferenceId(selected_template),
      missing_variables: rendered.missing_variables,
      template_routing_reason: template_routing_details.template_routing_reason,
      candidate_group,
      property_type,
    });
    return {
      ok: false,
      reason_code: REASON_CODES.TEMPLATE_RENDER_FAILED,
      reason: "template_render_failed",
      missing_placeholder_reason: "blank_location_placeholder",
      render_error_message: "blank_location_placeholder",
      template: selected_template_with_source,
      template_id: selected_template?.template_id || selected_template?.id || null,
      rendered_message_body: null,
      missing_variables: rendered.missing_variables,
      variable_payload_preview: variable_payload,
      selected_template_preview: {
        id: selected_template?.id || null,
        template_id: selected_template?.template_id || null,
        podio_template_id: selected_template?.podio_template_id || null,
        template_name: selected_template?.template_name || null,
        use_case: selected_template?.use_case || null,
        language: selected_template?.language || null,
        stage_code: selected_template?.stage_code || null,
        stage_label: selected_template?.stage_label || null,
      },
      template_rotation,
      ...template_routing_details,
    };
  }

  if (
    isColdOutboundS1OwnershipCheck(selector) &&
    hasRenderedFullAddressSuffix(
      normalized_rendered,
      variable_payload.property_address_full,
      variable_payload.property_street_address
    )
  ) {
    logTemplateRenderFailure(candidate, "full_address_rendered_in_cold_sms", {
      template_id: getTemplateReferenceId(selected_template),
      missing_variables: rendered.missing_variables,
      template_routing_reason: template_routing_details.template_routing_reason,
      candidate_group,
      property_type,
    });
    return {
      ok: false,
      reason_code: REASON_CODES.TEMPLATE_RENDER_FAILED,
      reason: "full_address_rendered_in_cold_sms",
      template: selected_template_with_source,
      template_id: selected_template?.template_id || selected_template?.id || null,
      rendered_preview: normalized_rendered.slice(0, 200),
      rendered_message_body: null,
      missing_variables: rendered.missing_variables,
      property_address_full: variable_payload.property_address_full,
      property_street_address: variable_payload.property_street_address,
      variable_payload_preview: variable_payload,
      selected_template_preview: {
        id: selected_template?.id || null,
        template_id: selected_template?.template_id || null,
        podio_template_id: selected_template?.podio_template_id || null,
        template_name: selected_template?.template_name || null,
        use_case: selected_template?.use_case || null,
        language: selected_template?.language || null,
        stage_code: selected_template?.stage_code || null,
        stage_label: selected_template?.stage_label || null,
      },
      template_rotation,
      ...template_routing_details,
    };
  }

  const agent_name_raw = clean(variable_payload.agent_name_raw);
  const agent_first_name = clean(variable_payload.agent_first_name);
  const has_full_agent_name = hasMultipleNameTokens(agent_name_raw);
  const rendered_lower = lower(normalized_rendered);
  if (
    has_full_agent_name &&
    rendered_lower.includes(lower(agent_name_raw))
  ) {
    logTemplateRenderFailure(candidate, "agent_full_name_rendered", {
      template_id: getTemplateReferenceId(selected_template),
      missing_variables: rendered.missing_variables,
      template_routing_reason: template_routing_details.template_routing_reason,
      candidate_group,
      property_type,
    });
    return {
      ok: false,
      reason_code: REASON_CODES.TEMPLATE_RENDER_FAILED,
      reason: "agent_full_name_rendered",
      template: selected_template_with_source,
      template_id: selected_template?.template_id || selected_template?.id || null,
      rendered_preview: normalized_rendered.slice(0, 200),
      rendered_message_body: null,
      missing_variables: rendered.missing_variables,
      agent_name_raw,
      agent_first_name,
      variable_payload_preview: variable_payload,
      selected_template_preview: {
        id: selected_template?.id || null,
        template_id: selected_template?.template_id || null,
        podio_template_id: selected_template?.podio_template_id || null,
        template_name: selected_template?.template_name || null,
        use_case: selected_template?.use_case || null,
        language: selected_template?.language || null,
        stage_code: selected_template?.stage_code || null,
        stage_label: selected_template?.stage_label || null,
      },
      template_rotation,
      ...template_routing_details,
    };
  }

  return {
    ok: true,
    reason_code: "OK",
    template: selected_template_with_source,
    template_use_case: selector.use_case,
    selected_template_use_case: selected_template?.use_case || selector.use_case,
    selected_template_stage: selected_template?.stage_code || selector.stage_code,
    rendered_message_body: normalized_rendered,
    missing_variables: rendered.missing_variables,
    variable_payload_preview: variable_payload,
    selected_template_preview: {
      id: selected_template?.id || null,
      template_id: selected_template?.template_id || null,
      podio_template_id: selected_template?.podio_template_id || null,
      template_name: selected_template?.template_name || null,
      use_case: selected_template?.use_case || null,
      language: selected_template?.language || null,
      stage_code: selected_template?.stage_code || null,
      stage_label: selected_template?.stage_label || null,
    },
    template_fallback_level,
    template_rotation,
    stage_code: selected_template?.stage_code || selector.stage_code,
    stage_label: selected_template?.stage_label || selector.stage_label,
    language: selected_template?.language || selector.preferred_language,
    ...template_routing_details,
  };
}

// ── Property Hydration: resolve property_id for v_sms_ready_contacts rows ────────
// When a candidate row is missing property_id but has master_owner_id, attempt a
// deterministic lookup against the properties table before marking as ineligible.

function buildPropertyHydrationPayload(prop, source) {
  const property_id = clean(
    pick(prop.property_id, prop.property_export_id, String(prop.id ?? ""))
  );
  if (!property_id) return { ok: false, reason: "property_row_missing_id" };

  return {
    ok: true,
    strategy: source,
    hydration_source: source,
    property_id,
    property_address_full: clean(pick(prop.property_address_full, prop.address_full)),
    property_address_city: clean(pick(prop.property_address_city, prop.address_city, prop.city)),
    property_address_state: clean(pick(prop.property_address_state, prop.address_state, prop.state)),
    property_address_zip: clean(pick(prop.property_address_zip, prop.address_zip, prop.zip)),
    market: clean(pick(prop.market, prop.market_name, prop.seller_market)),
    property_type: clean(prop.property_type),
    property_class: clean(prop.property_class),
    units_count: asNumber(prop.units_count, null),
    options: clean(prop.options),
    podio_tags: clean(prop.podio_tags),
    estimated_value: asNumber(prop.estimated_value, null),
    cash_offer: asNumber(prop.cash_offer, null),
    final_acquisition_score: asNumber(prop.final_acquisition_score, null),
  };
}

export async function hydratePropertyForCandidate(candidate = {}, deps = {}) {
  const master_owner_id = clean(candidate.master_owner_id || candidate.normalized_master_owner_id);
  const property_id = clean(candidate.property_id || candidate.normalized_property_id);
  const property_export_id = clean(candidate.property_export_id);
  const address = clean(candidate.property_address_full || candidate.property_address);

  let supabase;
  try { supabase = getSupabase(deps); } catch { return { ok: false, reason: "supabase_unavailable" }; }

  // Strategy 0.1: exact property_id match
  if (property_id) {
    try {
      const { data, error } = await supabase
        .from("properties")
        .select("*")
        .eq("id", property_id)
        .maybeSingle();
      if (!error && data) return buildPropertyHydrationPayload(data, "property_id_match");
    } catch { /* fall through */ }
  }

  // Strategy 0.2: exact property_export_id match
  if (property_export_id) {
    try {
      const { data, error } = await supabase
        .from("properties")
        .select("*")
        .eq("property_export_id", property_export_id)
        .maybeSingle();
      if (!error && data) return buildPropertyHydrationPayload(data, "property_export_id_match");
    } catch { /* fall through */ }
  }

  if (!master_owner_id && !address) {
    return { ok: false, reason: "insufficient_identifiers" };
  }

  if (master_owner_id) {
    // Strategy 1: properties WHERE master_owner_id = candidate.master_owner_id
    try {
      const { data, error } = await supabase
        .from("properties")
        .select("*")
        .eq("master_owner_id", master_owner_id)
        .order("final_acquisition_score", { ascending: false, nullsFirst: false })
        .order("structured_motivation_score", { ascending: false, nullsFirst: false })
        .order("estimated_value", { ascending: false, nullsFirst: false })
        .order("updated_at", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();
      if (!error && data) return buildPropertyHydrationPayload(data, "master_owner_id_match");
    } catch { /* fall through */ }

    // Strategy 2: joined_property_ids_json on master_owners row
    try {
      const { data: moData, error: moError } = await supabase
        .from("master_owners")
        .select("joined_property_ids_json")
        .eq("id", master_owner_id)
        .maybeSingle();

      if (!moError && moData?.joined_property_ids_json) {
        const ids = Array.isArray(moData.joined_property_ids_json)
          ? moData.joined_property_ids_json.map(String).filter(Boolean)
          : [];
        if (ids.length > 0) {
          const { data: propData, error: propError } = await supabase
            .from("properties")
            .select("*")
            .in("id", ids.slice(0, 20))
            .order("final_acquisition_score", { ascending: false, nullsFirst: false })
            .order("estimated_value", { ascending: false, nullsFirst: false })
            .order("updated_at", { ascending: false, nullsFirst: false })
            .limit(1)
            .maybeSingle();
          if (!propError && propData) return buildPropertyHydrationPayload(propData, "joined_property_ids_json");
        }
      }
    } catch { /* fall through */ }
  }

  // Strategy 3: property_address match
  if (address) {
    try {
      const normalizedAddress = address.replace(/\s+/g, " ").trim().toLowerCase();
      // Match on title
      const { data, error } = await supabase
        .from("properties")
        .select("*")
        .ilike("title", `${normalizedAddress}%`)
        .order("updated_at", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();
      if (!error && data) return buildPropertyHydrationPayload(data, "address_match");
    } catch { /* fall through */ }
  }

  return { ok: false, reason: "no_property_found" };
}
// ─────────────────────────────────────────────────────────────────────────────────

export async function createSendQueueItem(candidate = {}, options = {}, deps = {}) {
  const campaign_session_id = clean(pick(options.campaign_session_id, candidate.campaign_session_id)) || null;
  const campaign_mode = clean(options.campaign_mode) || null;
  const approval_mode = clean(options.approval_mode) || null;
  const no_send_specified =
    hasOwn(options, "no_send") ||
    hasOwn(options, "noSend") ||
    hasOwn(options, "proof_no_send");
  const no_send = no_send_specified
    ? asBoolean(pick(options.no_send, options.noSend, options.proof_no_send), false)
    : false;
  const proof_mode = asBoolean(pick(options.proof_mode, options.proofMode, options.proof), false);
  const exclude_from_kpis = asBoolean(options.exclude_from_kpis, no_send || proof_mode);
  const cap_basis_snapshot = Array.isArray(options.cap_basis_snapshot)
    ? options.cap_basis_snapshot
    : Array.isArray(options.cap_basis)
      ? options.cap_basis
      : null;
  const effective_total_cap = numberOrNull(options.effective_total_cap);
  const remaining_cap_before_create = numberOrNull(options.remaining_cap_before_create);
  const selected_sender_diagnostics = {
    selected_textgrid_number_id: options.selected_textgrid_number_id || null,
    selected_textgrid_number: options.selected_textgrid_number || null,
    selected_textgrid_market: options.selected_textgrid_market || null,
    routing_tier: asNumber(options.routing_tier, null),
    selection_reason: options.selection_reason || null,
    routing_allowed: options.routing_allowed !== false,
    routing_block_reason: options.routing_block_reason || null,
  };
  const effective_phone_id = candidate.best_phone_id || candidate.phone_id;
  const idempotency_key = buildIdempotencyKey({
    master_owner_id: candidate.master_owner_id,
    property_id: candidate.property_id,
    phone_id: effective_phone_id,
    template_use_case: options.template_use_case,
    touch_number: candidate.touch_number,
    campaign_session_id,
  });

  const dedupe_key = buildSendQueueDedupeKey({
    master_owner_id: candidate.master_owner_id,
    property_id: candidate.property_id,
    to_phone_number: candidate.canonical_e164,
    template_use_case: options.template_use_case,
    touch_number: candidate.touch_number,
    campaign_session_id,
  });

  const queue_key = buildQueueKeyFromIdempotencyKey(idempotency_key);
  const scheduled_for = options.scheduled_for || new Date().toISOString();
  const queue_status = new Date(scheduled_for).getTime() > Date.now() ? "scheduled" : "queued";
  const seller_identity = resolveSellerIdentity(candidate);
  const agent_name_raw = clean(
    pick(
      candidate.agent_persona,
      candidate.agent_name_raw,
      candidate.agent_full_name_raw,
      candidate.selected_agent_display_name,
      candidate.agent_name,
      candidate.sms_agent_name,
      candidate.assigned_agent_name,
      candidate.raw?.agent_persona,
      candidate.raw?.agent_name,
      candidate.raw?.sms_agent_name,
      candidate.raw?.assigned_agent_name,
      candidate.raw?.acquisition_agent_name,
      candidate.raw?.agent_family,
      candidate.agent_family,
      ""
    )
  );
  const agent_first_name = firstNameOnly(
    pick(
      candidate.agent_first_name,
      candidate.sms_agent_first_name,
      candidate.raw?.agent_first_name,
      candidate.raw?.sms_agent_first_name,
      agent_name_raw
    )
  );
  const safety_diagnostics = {
    status: "passed",
    evaluated_at: options.now || new Date().toISOString(),
    campaign_session_id,
    campaign_mode,
    approval_mode,
    no_send,
    cap_basis: cap_basis_snapshot,
    effective_total_cap,
    dedupe_key,
    queue_key,
    checks: {
      internal_test_phone_blocked: true,
      suppression_checked: true,
      dnc_opt_out_checked: true,
      duplicate_checked: true,
      active_queue_checked: true,
      same_phone_active_queue_checked: true,
      identity_checked: true,
      routing_checked: true,
      template_checked: true,
    },
    routing: {
      allowed: options.routing_allowed !== false,
      tier: asNumber(options.routing_tier, null),
      block_reason: options.routing_block_reason || null,
      selected_textgrid_number_id: options.selected_textgrid_number_id || null,
      selected_textgrid_number: options.selected_textgrid_number || null,
      selected_textgrid_market: options.selected_textgrid_market || null,
    },
    template: {
      id: options.template_id || null,
      source: options.template_source || "supabase",
      use_case: options.template_use_case || null,
      language: options.selected_template_language || options.template_language || null,
    },
    identity: {
      status: candidate.identity_alignment?.status || null,
      hard_block: Boolean(candidate.identity_alignment?.hardBlock),
      seller_name_missing: Boolean(candidate.seller_name_missing || seller_identity.seller_name_missing),
    },
  };

  const payload = {
    queue_key,
    queue_id: queue_key,
    queue_status,
    scheduled_for,
    scheduled_for_utc: scheduled_for,
    scheduled_for_local: scheduled_for,
    message_body: options.rendered_message_body,
    message_text: options.rendered_message_body,
    to_phone_number: candidate.canonical_e164,
    from_phone_number: options.selected_textgrid_number,
    textgrid_number_id: options.selected_textgrid_number_id,
    master_owner_id: candidate.master_owner_id,
    property_id: candidate.property_id,
    market_id: candidate.market_id,
    template_id: options.template_id,
    touch_number: candidate.touch_number,
    timezone: candidate.timezone,
    contact_window: candidate.contact_window || null,
    use_case_template: options.template_use_case,
    dedupe_key,
    seller_first_name: clean(seller_identity.seller_first_name || candidate.owner_first_name || candidate.prospect_first_name || "") || null,
    seller_display_name: clean(seller_identity.seller_display_name || candidate.owner_display_name || candidate.seller_full_name || "") || null,
    // Top-level visibility fields — populated from candidate so Queue/Inbox/Pipeline/Map filters work
    market: clean(candidate.market) || null,
    thread_key: normalizePhone(candidate.canonical_e164) || null,
    property_type: clean(pick(candidate.property_type, candidate.raw?.property_type, candidate.raw?.property_class)) || null,
    property_address_state: clean(pick(candidate.state, candidate.property_state, candidate.state_code)) || null,
    property_address_city: clean(pick(candidate.property_city, candidate.raw?.property_address_city, candidate.raw?.property_city)) || null,
    property_address_zip: clean(pick(candidate.property_zip, candidate.raw?.property_address_zip, candidate.raw?.property_zip)) || null,
    seller_status: clean(pick(candidate.seller_status, candidate.contact_status, candidate.activity_status)) || null,
    pipeline_stage: clean(pick(candidate.pipeline_stage, candidate.conversation_stage, candidate.stage_code)) || null,
    agent_name: clean(pick(agent_first_name, candidate.agent_name, candidate.sms_agent_name)) || null,
    template_key: clean(pick(options.template_id, options.selected_template_id)) || null,
    language: clean(pick(candidate.language, candidate.best_language)) || null,
    routing_tier: asNumber(options.routing_tier, null),
    sms_eligible: no_send ? false : true,
    routing_allowed: no_send ? false : options.routing_allowed !== false,
    safety_status: no_send ? "blocked" : "passed",
    metadata: {
      idempotency_key,
      campaign_session_id,
      campaign_mode,
      approval_mode,
      ...(no_send_specified ? { no_send } : {}),
      ...(proof_mode ? { proof: true, proof_mode: true } : {}),
      ...(exclude_from_kpis ? { exclude_from_kpis: true } : {}),
      cap_basis: cap_basis_snapshot,
      cap_basis_snapshot,
      effective_total_cap,
      remaining_cap_before_create,
      queue_limited_request_context:
        options.queue_limited_request_context && typeof options.queue_limited_request_context === "object" && !Array.isArray(options.queue_limited_request_context)
          ? options.queue_limited_request_context
          : null,
      safety_diagnostics,
      template_use_case: options.template_use_case,
      selected_textgrid_number_id: options.selected_textgrid_number_id,
      selected_textgrid_number: options.selected_textgrid_number,
      selected_textgrid_market: options.selected_textgrid_market,
      selected_sender_diagnostics,
      seller_market: candidate.market,
      seller_state: candidate.state,
      routing_tier: options.routing_tier,
      selection_reason: options.selection_reason,
      routing_allowed: options.routing_allowed,
      routing_block_reason: options.routing_block_reason,
      batch_name: options.batch_name || null,
      agent_name: agent_first_name || null,
      agent_first_name: agent_first_name || null,
      agent_name_raw: agent_name_raw || null,
      agent_full_name_raw: agent_name_raw || null,
      selected_agent_display_name: agent_name_raw || null,
      seller_identity,
      phone_rotation_reason: candidate.phone_rank > 1 ? "wrong_number" : null,
      phone_rank: Number(candidate.phone_rank) || 1,
      candidate_confidence_score: candidate.candidate_confidence_score || null,
      prior_phone_id: options.prior_phone_id || null,
      rotated_from_thread_key: options.rotated_from_thread_key || null,
      duplicate_body_cooldown_applied: options.rotation_duplicate_cooldown_applied === true,
      candidate_snapshot: {
        master_owner_id: candidate.master_owner_id,
        property_id: candidate.property_id,
        best_phone_id: candidate.best_phone_id,
        phone_id: candidate.phone_id,
        canonical_phone_masked: maskPhone(candidate.canonical_e164),
        seller_market: candidate.market,
        seller_state: candidate.state,
        campaign_session_id,
        campaign_mode,
        approval_mode,
        ...(no_send_specified ? { no_send } : {}),
        touch_number: candidate.touch_number,
        template_use_case: options.template_use_case || null,
        template_key: clean(options.template_id) || null,
        property_address_city: clean(pick(candidate.property_city, candidate.raw?.property_address_city)) || null,
        property_address_zip: clean(pick(candidate.property_zip, candidate.raw?.property_address_zip)) || null,
        property_type: clean(pick(candidate.property_type, candidate.raw?.property_type)) || null,
        seller_status: clean(pick(candidate.seller_status, candidate.contact_status, candidate.activity_status)) || null,
        pipeline_stage: clean(pick(candidate.pipeline_stage, candidate.conversation_stage, candidate.stage_code)) || null,
        agent_name: agent_first_name || null,
        agent_first_name: agent_first_name || null,
        agent_name_raw: agent_name_raw || null,
        agent_full_name_raw: agent_name_raw || null,
        selected_agent_display_name: agent_name_raw || null,
        // Seller identity fields — required for re-render and audit.
        seller_first_name: clean(seller_identity.seller_first_name) || null,
        seller_full_name: clean(seller_identity.seller_full_name || candidate.seller_full_name || candidate.phone_full_name) || null,
        owner_display_name: clean(candidate.owner_display_name || candidate.display_name) || null,
        prospect_first_name: clean(candidate.prospect_first_name) || null,
        phone_first_name: clean(candidate.phone_first_name) || null,
        seller_name_source: clean(candidate.seller_name_source || seller_identity.seller_name_source) || (
          clean(candidate.seller_first_name)
          ? "seller_first_name"
          : clean(candidate.prospect_first_name)
          ? "prospect_first_name"
          : clean(candidate.phone_first_name)
          ? "phone_first_name"
          : clean(candidate.owner_first_name)
          ? "owner_first_name"
          : clean(candidate.owner_display_name)
          ? "owner_display_parsed"
          : null
        ),
        seller_name_missing: Boolean(candidate.seller_name_missing || seller_identity.seller_name_missing),
      },
      template: {
        id: options.template_id,
        source: options.template_source || "supabase",
        use_case: options.template_use_case,
      },
      template_rotation_enabled: Boolean(options.template_rotation_enabled),
      template_rotation_seed: clean(options.template_rotation_seed) || null,
      template_rotation_pool_size: asPositiveInteger(options.template_rotation_pool_size, 0),
      template_rotation_candidate_ids: Array.isArray(options.template_rotation_candidate_ids)
        ? options.template_rotation_candidate_ids
        : [],
      template_rotation_candidate_languages: Array.isArray(options.template_rotation_candidate_languages)
        ? options.template_rotation_candidate_languages
        : [],
      template_rotation_selected_index: Number.isFinite(Number(options.template_rotation_selected_index))
        ? Number(options.template_rotation_selected_index)
        : null,
      template_rotation_requested_language: clean(options.template_rotation_requested_language) || null,
      selected_template_language: clean(options.selected_template_language || options.template_language) || null,
      rotation_language_mismatch_detected: Boolean(options.rotation_language_mismatch_detected),
      template_rotation_strategy: clean(options.template_rotation_strategy) || null,
      template_rotation_best_score: Number.isFinite(Number(options.template_rotation_best_score))
        ? Number(options.template_rotation_best_score)
        : null,
      template_rotation_min_score: Number.isFinite(Number(options.template_rotation_min_score))
        ? Number(options.template_rotation_min_score)
        : null,
      rotation_strategy: clean(options.template_rotation_strategy) || null,
      rotation_best_score: Number.isFinite(Number(options.template_rotation_best_score))
        ? Number(options.template_rotation_best_score)
        : null,
      rotation_min_score: Number.isFinite(Number(options.template_rotation_min_score))
        ? Number(options.template_rotation_min_score)
        : null,
      selected_template_id: clean(options.selected_template_id || options.template_id) || null,
      selected_template_source: clean(options.selected_template_source || options.template_source || "supabase") || "supabase",
      selected_template_language: clean(options.selected_template_language || options.template_language) || null,
      selected_template_use_case: clean(options.selected_template_use_case || options.template_use_case) || null,
      selected_template_stage_code: clean(options.selected_template_stage_code || options.template_stage_code) || null,
      template_fetch_limit: Number.isFinite(Number(options.template_fetch_limit)) ? Number(options.template_fetch_limit) : null,
      template_fetch_language_filter_applied: Boolean(options.template_fetch_language_filter_applied),
      template_fetch_use_case_filter_applied: options.template_fetch_use_case_filter_applied !== false,
      template_fetch_stage_filter_applied: Boolean(options.template_fetch_stage_filter_applied),
      template_fetch_fallback_used: Boolean(options.template_fetch_fallback_used),
      raw_template_count_before_language_filter: Number(options.raw_template_count_before_language_filter || 0),
      template_count_after_language_filter: Number(options.template_count_after_language_filter || 0),
    },
  };

  if (options.dry_run) {
    return {
      ok: true,
      dry_run: true,
      queued: false,
      queue_key,
      queue_id: queue_key,
      idempotency_key,
      payload,
    };
  }

  if (typeof deps.createSendQueueItem === "function") {
    return deps.createSendQueueItem(payload, { idempotency_key, queue_key });
  }

  const inserted = await insertSupabaseSendQueueRow(payload, deps);
  if (!inserted?.ok && inserted?.reason === "duplicate_blocked") {
    return {
      ok: false,
      reason_code: REASON_CODES.DUPLICATE_QUEUE_ITEM,
      reason: "duplicate_queue_item",
      duplicate: true,
      queue_key,
      idempotency_key,
      inserted,
    };
  }

  return {
    ok: true,
    dry_run: false,
    queued: true,
    idempotent_replay: Boolean(inserted?.idempotent_replay),
    queue_key,
    queue_id: inserted?.queue_id || queue_key,
    queue_row_id: inserted?.queue_row_id || null,
    idempotency_key,
    inserted: {
      ...inserted,
      queue_status: inserted?.raw?.queue_status || inserted?.queue_status || payload.queue_status,
      scheduled_for: inserted?.raw?.scheduled_for || inserted?.scheduled_for || payload.scheduled_for,
    },
  };
}

export function buildFeederDiagnostics(summary = {}) {
  const diagnostics = {
    ok: summary.ok !== false,
    dry_run: Boolean(summary.dry_run),
    source: summary.source || null,
    candidate_source: summary.candidate_source || summary.source || null,
    requested_limit: Number(summary.requested_limit || 0),
    effective_candidate_fetch_limit: Number(summary.effective_candidate_fetch_limit || 0),
    requested_candidate_offset: Number(summary.requested_candidate_offset || 0),
    effective_candidate_offset: Number(summary.effective_candidate_offset || 0),
    fetched_candidate_count: Number(summary.fetched_candidate_count || 0),
    scanned_count: Number(summary.scanned_count || 0),
    eligible_count: Number(summary.eligible_count || 0),
    queued_count: Number(summary.queued_count || 0),
    scheduled_count: Number(summary.scheduled_count || 0),
    idempotent_replay_count: Number(summary.idempotent_replay_count || 0),
    total_created_count: totalCreatedCount(summary),
    skipped_count: Number(summary.skipped_count || 0),
    routing_block_count: Number(summary.routing_block_count || 0),
    suppression_block_count: Number(summary.suppression_block_count || 0),
    contact_window_block_count: Number(summary.contact_window_block_count || 0),
    pending_prior_touch_block_count: Number(summary.pending_prior_touch_block_count || 0),
    duplicate_queue_block_count: Number(summary.duplicate_queue_block_count || 0),
    active_queue_block_count: Number(summary.active_queue_block_count || 0),
    prior_touch_cooldown_block_count: Number(summary.prior_touch_cooldown_block_count || 0),
    batch_duplicate_block_count: Number(summary.batch_duplicate_block_count || 0),
    template_block_count: Number(summary.template_block_count || 0),
    no_template_count: Number(summary.no_template_count || 0),
    template_render_failed_count: Number(summary.template_render_failed_count || 0),
    hydration_failure_count: Number(summary.hydration_failure_count || 0),
    property_hydration_attempt_count: Number(summary.property_hydration_attempt_count || 0),
    property_hydration_success_count: Number(summary.property_hydration_success_count || 0),
    property_hydration_failed_count: Number(summary.property_hydration_failed_count || 0),
    missing_property_id_after_hydration_count: Number(summary.missing_property_id_after_hydration_count || 0),
    identity_mismatch_count: Number(summary.identity_mismatch_count || 0),
    identity_verified_count: Number(summary.identity_verified_count || 0),
    identity_probable_count: Number(summary.identity_probable_count || 0),
    identity_household_associated_count: Number(summary.identity_household_associated_count || 0),
    identity_weak_count: Number(summary.identity_weak_count || 0),
    identity_unknown_count: Number(summary.identity_unknown_count || 0),
    identity_hard_block_count: Number(summary.identity_hard_block_count || 0),
    identity_hold_count: Number(summary.identity_hold_count || 0),
    identity_live_eligible_count: Number(summary.identity_live_eligible_count || 0),
    identity_live_ineligible_count: Number(summary.identity_live_ineligible_count || 0),
    identity_weak_held_count: Number(summary.identity_weak_held_count || 0),
    identity_unknown_held_count: Number(summary.identity_unknown_held_count || 0),
    identity_household_held_count: Number(summary.identity_household_held_count || 0),
    identity_probable_allowed_count: Number(summary.identity_probable_allowed_count || 0),
    identity_verified_allowed_count: Number(summary.identity_verified_allowed_count || 0),
    identity_household_associated_allowed_count: Number(summary.identity_household_associated_allowed_count || 0),
    fresh_candidate_count: Number(summary.fresh_candidate_count || 0),
    exhausted_candidate_count: Number(summary.exhausted_candidate_count || 0),
    schedule_spread_enabled: Boolean(summary.schedule_spread_enabled),
    schedule_start_local: clean(summary.schedule_start_local) || null,
    schedule_end_local: clean(summary.schedule_end_local) || null,
    schedule_interval_seconds: Number(summary.schedule_interval_seconds || 0),
    schedule_window_full_count: Number(summary.schedule_window_full_count || 0),
    schedule_overflow_blocked_count: Number(summary.schedule_overflow_blocked_count || 0),
    invalid_scheduled_for_count: Number(summary.invalid_scheduled_for_count || 0),
    invalid_scheduled_for_examples: Array.isArray(summary.invalid_scheduled_for_examples)
      ? summary.invalid_scheduled_for_examples.slice(0, 3)
      : [],
    first_scheduled_for: summary.first_scheduled_for || null,
    last_scheduled_for: summary.last_scheduled_for || null,
    error: clean(summary.error) || null,
    candidate_source_error: clean(summary.candidate_source_error) || null,
    available_hint: Array.isArray(summary.available_hint) ? summary.available_hint : undefined,
    selected_textgrid_market_counts: summary.selected_textgrid_market_counts || {},
    routing_tier_counts: summary.routing_tier_counts || {},
    sample_created_queue_items: Array.isArray(summary.sample_created_queue_items)
      ? summary.sample_created_queue_items.slice(0, 50)
      : [],
    sample_skips: Array.isArray(summary.sample_skips) ? summary.sample_skips.slice(0, 50) : [],
  };

  diagnostics.eligible = diagnostics.eligible_count;
  diagnostics.skipped = diagnostics.skipped_count;
  diagnostics.routing_blocked_count = diagnostics.routing_block_count;
  diagnostics.suppressed_count = diagnostics.suppression_block_count;
  diagnostics.template_blocked_count = diagnostics.template_block_count;
  diagnostics.duplicate_blocked_count =
    diagnostics.duplicate_queue_block_count + diagnostics.batch_duplicate_block_count;
  diagnostics.active_queue_blocked_count = diagnostics.active_queue_block_count;
  diagnostics.identity_held_count =
    diagnostics.identity_hold_count +
    diagnostics.identity_weak_held_count +
    diagnostics.identity_unknown_held_count +
    diagnostics.identity_household_held_count;
  diagnostics.sample_candidates = diagnostics.sample_created_queue_items.map((item) => {
    const payload = item?.payload || {};
    const metadata = payload.metadata || {};
    return {
      queue_key: item?.queue_key || payload.queue_key || null,
      master_owner_id: item?.master_owner_id || payload.master_owner_id || metadata.candidate_snapshot?.master_owner_id || null,
      property_id: item?.property_id || payload.property_id || metadata.candidate_snapshot?.property_id || null,
      market: item?.market || item?.seller_market || payload.market || metadata.seller_market || null,
      state: item?.seller_state || payload.property_address_state || metadata.seller_state || null,
      template_id: item?.selected_template_id || item?.template_id || payload.template_id || metadata.selected_template_id || null,
      selected_textgrid_market: item?.selected_textgrid_market || metadata.selected_textgrid_market || null,
      scheduled_for: item?.scheduled_for || payload.scheduled_for || payload.scheduled_for_utc || null,
      safety_status: payload.safety_status || (item?.dry_run ? "preview" : null),
    };
  });
  const selectedTemplates = new Map();
  for (const item of diagnostics.sample_created_queue_items) {
    const payload = item?.payload || {};
    const metadata = payload.metadata || {};
    const template_id = clean(item?.selected_template_id || item?.template_id || payload.template_id || metadata.selected_template_id || metadata.template?.id);
    if (!template_id || selectedTemplates.has(template_id)) continue;
    selectedTemplates.set(template_id, {
      template_id,
      source: clean(metadata.selected_template_source || metadata.template?.source || "supabase") || "supabase",
      use_case: clean(item?.template_use_case || metadata.selected_template_use_case || metadata.template?.use_case || payload.use_case_template) || null,
      language: clean(item?.selected_template_language || item?.language || metadata.selected_template_language) || null,
    });
  }
  diagnostics.selected_templates = Array.from(selectedTemplates.values());

  return diagnostics;
}

function getSkipDiagnostics(candidate, options) {
  const alignment = candidate.identity_alignment || {};
  return {
    normalized_master_owner_id: candidate.master_owner_id,
    normalized_property_id: candidate.property_id,
    normalized_phone_id: candidate.phone_id || candidate.best_phone_id,
    normalized_phone_e164: candidate.canonical_e164,
    hydration_lookup_strategy: candidate.hydration_lookup_strategy || null,
    hydration_error: candidate.hydration_error || null,
    // Entity / linkage diagnostics
    owner_is_entity: alignment.ownerIsEntity ?? null,
    raw_matching_flags: candidate.matching_flags || null,
    normalized_linkage: alignment.normalizedLinkage ?? null,
    linkage_source: candidate.matching_flags ? "prospects.matching_flags" : null,
    identity_resolution: alignment.status || null,
    identity_reason: alignment.reasons || null,
    identity_inputs_used: {
      prospect_full_name: candidate.prospect_full_name || null,
      phone_full_name: candidate.phone_full_name || null,
      owner_display_name: candidate.owner_display_name || null,
      matching_flags: candidate.matching_flags || null,
      person_flags_text: candidate.person_flags_text || null,
      likely_owner: candidate.likely_owner ?? null,
    },
    property_type_source: candidate.hydration_lookup_strategy ? "hydration" : "view",
    canonical_property_group_source: candidate.hydration_lookup_strategy ? "hydration" : "view",
    ...(options.dry_run ? { candidate_preview: buildCandidateNormalizedPreview(candidate.raw, candidate) } : {})
  };
}

export async function runSupabaseCandidateFeeder(input = {}, deps = {}) {
  const now = input.now || new Date().toISOString();
  const get_system_value =
    deps.getSystemValue || (hasSupabaseConfig() ? getSystemValue : async () => null);
  const get_system_flag =
    deps.getSystemFlag ||
    (typeof getSystemFlag === "function" ? getSystemFlag : async () => true);

  // ── System control gate ────────────────────────────────────────────────
  if (!input.dry_run) {
    const runtime_brake = evaluateQueueCreationRuntimeBrakes(
      {
        campaign_mode: await get_system_value("campaign_mode"),
        queue_auto_enqueue_enabled: await get_system_value("queue_auto_enqueue_enabled"),
        queue_emergency_stop_at: await get_system_value("queue_emergency_stop_at"),
      },
      {
        action: "runSupabaseCandidateFeeder",
        requireAutoEnqueue: false,
        failClosed: false,
      }
    );
    if (!runtime_brake.ok) {
      return {
        status: 423,
        ...blockedRuntimeBrakeResult(runtime_brake, "runSupabaseCandidateFeeder"),
        queued_count: 0,
      };
    }

    const feeder_enabled = await get_system_flag("feeder_enabled");
    if (!feeder_enabled) {
      return { ok: false, status: 423, ...buildDisabledResponse("feeder_enabled", "runSupabaseCandidateFeeder"), queued_count: 0 };
    }
    const outbound_sms_enabled = await get_system_flag("outbound_sms_enabled");
    if (!outbound_sms_enabled) {
      return { ok: false, status: 423, ...buildDisabledResponse("outbound_sms_enabled", "runSupabaseCandidateFeeder"), queued_count: 0 };
    }
  }

  const limit = Math.max(1, Math.min(asPositiveInteger(input.max_created_count ?? input.limit, 25), 500));
  const scan_limit = Math.max(limit, Math.min(asPositiveInteger(input.scan_limit ?? input.candidate_fetch_limit, 500), 5000));
  const candidate_offset = Math.max(0, Math.trunc(Number(input.candidate_offset ?? input.scan_offset ?? input.offset) || 0));

  // ── Fetch Identity Policy Flags ───────────────────────────────────────
  const allow_weak_identity_outbound = asBoolean(
    input.allow_weak_identity_outbound ?? (await get_system_flag("allow_weak_identity_outbound")),
    asBoolean(process.env.ALLOW_WEAK_IDENTITY_OUTBOUND, false)
  );

  const identity_blocked_markets = input.identity_blocked_markets ?? (await get_system_flag("identity_blocked_markets")) ?? process.env.IDENTITY_BLOCKED_MARKETS;
  const identity_gate_mode = clean(input.identity_gate_mode || "strict").toLowerCase();
  const allow_identity_unknown = asBoolean(input.allow_identity_unknown, false);
  // ─────────────────────────────────────────────────────────────────────────

  const options = {
    dry_run: asBoolean(input.dry_run, false),
    limit,
    scan_limit,
    candidate_offset,
    candidate_source: clean(input.candidate_source) || null,
    market: clean(input.market) || null,
    state: clean(input.state) || null,
    routing_safe_only: asBoolean(input.routing_safe_only, true),
    require_local_routing: asBoolean(
      input.require_local_routing ?? await get_system_value("require_local_routing"),
      false
    ),
    allow_regional_fallback_for_first_touch: asBoolean(
      input.allow_regional_fallback_for_first_touch ??
        await get_system_value("allow_regional_fallback_for_first_touch"),
      false
    ),
    allow_phone_fallback: asBoolean(input.allow_phone_fallback, false),
    within_contact_window_now: asBoolean(input.within_contact_window_now, true),
    template_use_case: clean(input.template_use_case) || "ownership_check",
    touch_number: asPositiveInteger(input.touch_number, 1),
    campaign_session_id: clean(input.campaign_session_id) || `session-${now.slice(0, 10)}`,
    campaign_mode: clean(input.campaign_mode) || null,
    approval_mode: clean(input.approval_mode || input.approvalMode || input.approval) || null,
    ...(hasOwn(input, "no_send") ? { no_send: asBoolean(input.no_send, false) } : {}),
    ...(hasOwn(input, "noSend") ? { noSend: asBoolean(input.noSend, false) } : {}),
    ...(hasOwn(input, "proof_no_send") ? { proof_no_send: asBoolean(input.proof_no_send, false) } : {}),
    proof_mode: asBoolean(input.proof_mode ?? input.proofMode ?? input.proof, false),
    exclude_from_kpis: asBoolean(input.exclude_from_kpis ?? input.excludeFromKpis, false),
    cap_basis: Array.isArray(input.cap_basis) ? input.cap_basis : null,
    cap_basis_snapshot: Array.isArray(input.cap_basis_snapshot) ? input.cap_basis_snapshot : null,
    effective_total_cap: Number.isFinite(Number(input.effective_total_cap)) ? Number(input.effective_total_cap) : null,
    remaining_cap_before_create: Number.isFinite(Number(input.remaining_cap_before_create)) ? Number(input.remaining_cap_before_create) : null,
    queue_limited_request_context:
      input.queue_limited_request_context && typeof input.queue_limited_request_context === "object" && !Array.isArray(input.queue_limited_request_context)
        ? input.queue_limited_request_context
        : null,
    batch_name: clean(input.batch_name) || null,
    debug_templates: asBoolean(input.debug_templates, false),
    schedule_spread: asBoolean(input.schedule_spread, false),
    schedule_start_local: clean(input.schedule_start_local) || "09:00",
    schedule_end_local: clean(input.schedule_end_local) || "20:00",
    schedule_interval_seconds_min: asPositiveInteger(input.schedule_interval_seconds_min, 45),
    schedule_interval_seconds_max: asPositiveInteger(input.schedule_interval_seconds_max, 180),
    timezone_filter: clean(input.timezone_filter) || null,
    identity_gate_mode,
    allow_identity_unknown,
    allow_weak_identity_outbound,
    identity_blocked_markets,
    cold_outbound_cooldown_days: asPositiveInteger(input.cold_outbound_cooldown_days, 30),
    duplicate_body_cooldown_hours: asPositiveInteger(input.duplicate_body_cooldown_hours, 24),
    cold_outbound_touch_cap: asPositiveInteger(input.cold_outbound_touch_cap, 5),
    phone_cooldown_days: asPositiveInteger(input.phone_cooldown_days, 14),
    allow_internal_test_phones: asBoolean(input.allow_internal_test_phones, false),
    now,
  };

  const source = await getSupabaseFeederCandidates(options, deps);
  if (source?.ok === false) {
    return buildFeederDiagnostics({
      ok: false,
      dry_run: options.dry_run,
      source: source.source || DEFAULT_CANDIDATE_SOURCE,
      candidate_source: source.source || DEFAULT_CANDIDATE_SOURCE,
      requested_limit: options.limit,
      effective_candidate_fetch_limit: source.effective_fetch_limit || options.scan_limit,
      requested_candidate_offset: options.candidate_offset,
      effective_candidate_offset: options.candidate_offset,
      fetched_candidate_count: 0,
      scanned_count: 0,
      eligible_count: 0,
      queued_count: 0,
      scheduled_count: 0,
      idempotent_replay_count: 0,
      skipped_count: 0,
      routing_block_count: 0,
      suppression_block_count: 0,
      contact_window_block_count: 0,
      pending_prior_touch_block_count: 0,
      duplicate_queue_block_count: 0,
      active_queue_block_count: 0,
      prior_touch_cooldown_block_count: 0,
      batch_duplicate_block_count: 0,
      template_block_count: 0,
      no_template_count: 0,
      template_render_failed_count: 0,
      schedule_spread_enabled: options.schedule_spread,
      schedule_start_local: options.schedule_start_local || null,
      schedule_end_local: options.schedule_end_local || null,
      schedule_interval_seconds: options.schedule_interval_seconds_min || 0,
      schedule_window_full_count: 0,
      schedule_overflow_blocked_count: 0,
      invalid_scheduled_for_count: 0,
      invalid_scheduled_for_examples: [],
      first_scheduled_for: null,
      last_scheduled_for: null,
      selected_textgrid_market_counts: {},
      routing_tier_counts: {},
      sample_created_queue_items: [],
      sample_skips: [],
      error: "CANDIDATE_SOURCE_UNAVAILABLE",
      candidate_source_error: source.candidate_source_error || "candidate source unavailable",
      available_hint: Array.isArray(source.available_hint) ? source.available_hint : [...CANDIDATE_SOURCE_AVAILABLE_HINT],
    });
  }

  const use_spread = options.schedule_spread;
  const spread_scheduler = use_spread
    ? createSpreadScheduler({
        now_iso: options.now,
        schedule_start_local: options.schedule_start_local,
        schedule_end_local: options.schedule_end_local,
        schedule_interval_seconds_min: options.schedule_interval_seconds_min,
        schedule_interval_seconds_max: options.schedule_interval_seconds_max,
      })
    : null;

  const summary = {
    ok: true,
    dry_run: options.dry_run,
    source: source.source,
    candidate_source: source.source,
    requested_limit: options.limit,
    effective_candidate_fetch_limit: source.effective_fetch_limit || options.scan_limit,
    requested_candidate_offset: options.candidate_offset,
    effective_candidate_offset: source.candidate_offset ?? options.candidate_offset,
    fetched_candidate_count: source.scanned_count,
    scanned_count: source.scanned_count,
    eligible_count: 0,
    queued_count: 0,
    scheduled_count: 0,
    idempotent_replay_count: 0,
    skipped_count: 0,
    routing_block_count: 0,
    suppression_block_count: 0,
    contact_window_block_count: 0,
    pending_prior_touch_block_count: 0,
    duplicate_queue_block_count: 0,
    active_queue_block_count: 0,
    prior_touch_cooldown_block_count: 0,
    batch_duplicate_block_count: 0,
    template_block_count: 0,
    no_template_count: 0,
    template_render_failed_count: 0,
    hydration_failure_count: 0,
    property_hydration_attempt_count: 0,
    property_hydration_success_count: 0,
    property_hydration_failed_count: 0,
    missing_property_id_after_hydration_count: 0,
    identity_mismatch_count: 0,
    identity_verified_count: 0,
    identity_probable_count: 0,
    identity_household_associated_count: 0,
    identity_weak_count: 0,
    identity_unknown_count: 0,
    identity_hard_block_count: 0,
    identity_hold_count: 0,
    identity_live_eligible_count: 0,
    identity_live_ineligible_count: 0,
    identity_weak_held_count: 0,
    identity_unknown_held_count: 0,
    identity_household_held_count: 0,
    identity_probable_allowed_count: 0,
    identity_verified_allowed_count: 0,
    identity_household_associated_allowed_count: 0,
    fresh_candidate_count: 0,
    exhausted_candidate_count: 0,
    schedule_spread_enabled: use_spread,
    schedule_start_local: options.schedule_start_local || null,
    schedule_end_local: options.schedule_end_local || null,
    schedule_interval_seconds: options.schedule_interval_seconds_min || 0,
    schedule_window_full_count: 0,
    schedule_overflow_blocked_count: 0,
    invalid_scheduled_for_count: 0,
    invalid_scheduled_for_examples: [],
    first_scheduled_for: null,
    last_scheduled_for: null,
    selected_textgrid_market_counts: {},
    routing_tier_counts: {},
    sample_created_queue_items: [],
    sample_skips: [],
  };

  
  const seenPhones = new Set();
  const seenOwnerPhoneTouch = new Set();
  const seenOwners = new Set();
  const allow_multiple_per_owner = asBoolean(input.allow_multiple_per_owner, false);
  const only_first_touch = asBoolean(input.only_first_touch, false);

  for (const candidate of source.rows) {
    // Operational telemetry for freshness
    if (candidate.never_contacted === true) {
      summary.fresh_candidate_count += 1;
    } else if (candidate.never_contacted === false) {
      summary.exhausted_candidate_count += 1;
    }

    if (totalCreatedCount(summary) >= options.limit) {
      summary.skipped_count += 1;
      continue;
    }

    // ── First Touch Enforcer ────────────────────────────────────────────────
    if (only_first_touch && candidate.never_contacted !== true && candidate.last_touch_number > 0) {
       const first_touch_cooldown_days = asPositiveInteger(options.first_touch_cooldown_days, 30);
       const cooldown_ms = first_touch_cooldown_days * 24 * 60 * 60 * 1000;
       const last_contact_timestamp = candidate.latest_message_at || candidate.latest_contact_at;
       
       if (last_contact_timestamp && (Date.now() - new Date(last_contact_timestamp).getTime() < cooldown_ms)) {
         summary.skipped_count += 1;
         summary.prior_touch_cooldown_block_count += 1;
         summary.sample_skips.push({
           reason_code: REASON_CODES.PRIOR_TOUCH_COOLDOWN,
           reason: "first_touch_cooldown",
           master_owner_id: candidate.master_owner_id,
           property_id: candidate.property_id,
           ...getSkipDiagnostics(candidate, options)
         });
         continue;
       }
    }
    // ─────────────────────────────────────────────────────────────────────────

    const phoneKey = clean(candidate.canonical_e164 || candidate.phone_number || candidate.best_phone_id || "");
    const ownerKey = clean(candidate.master_owner_id);
    const ownerPhoneTouchKey = `${ownerKey}:${phoneKey}:${options.touch_number}`;

    if (totalCreatedCount(summary) >= options.limit) {
      summary.skipped_count += 1;
      summary.sample_skips.push({
        reason_code: REASON_CODES.CAMPAIGN_LIMIT_REACHED,
        master_owner_id: candidate.master_owner_id,
        property_id: candidate.property_id,
        ...getSkipDiagnostics(candidate, options)
      });
      continue;
    }

    candidate.touch_number = options.touch_number;
    candidate.template_use_case = options.template_use_case;
    candidate.campaign_session_id = options.campaign_session_id;

    // Property hydration: resolve property_id for candidates from views that omit it (e.g. v_sms_ready_contacts)
    if (!candidate.property_id && candidate.master_owner_id) {
      summary.property_hydration_attempt_count += 1;
      const hydration = await hydratePropertyForCandidate(candidate, deps);
      if (hydration.ok) {
        summary.property_hydration_success_count += 1;
        candidate._property_hydrated = true;
        candidate.hydration_lookup_strategy = hydration.hydration_source;
        candidate.property_id = hydration.property_id;
        if (hydration.property_address_full) candidate.property_address_full = hydration.property_address_full;
        if (hydration.property_address_full) candidate.property_address = hydration.property_address_full;
        if (hydration.property_address_city) candidate.property_address_city = hydration.property_address_city;
        if (hydration.property_address_state) candidate.property_address_state = hydration.property_address_state;
        if (hydration.property_address_zip) candidate.property_address_zip = hydration.property_address_zip;
        if (hydration.market) { candidate.market = hydration.market; candidate.routing_market = hydration.market; candidate.seller_market = hydration.market; }
        if (hydration.property_type) candidate.property_type = hydration.property_type;
        if (hydration.estimated_value != null) candidate.estimated_value = hydration.estimated_value;
        if (hydration.cash_offer != null) candidate.cash_offer = hydration.cash_offer;
        if (hydration.final_acquisition_score != null) candidate.final_acquisition_score = hydration.final_acquisition_score;
        
        const newGroup = getCanonicalPropertyGroup(hydration.property_type);
        if (!candidate.canonical_property_group || candidate.canonical_property_group === "other_commercial") {
           candidate.canonical_property_group = newGroup;
        }
      } else {
        summary.property_hydration_failed_count += 1;
        candidate._property_hydrated = false;
        candidate.hydration_error = hydration.reason;
      }
    }

    const _preview = getSkipDiagnostics(candidate, options);

    const eligibility = await evaluateCandidateEligibility(candidate, options, deps);

    // ── Identity Alignment Telemetry ──────────────────────────────────────────
    const id_status = candidate.identity_alignment?.status;
    const is_hard_blocked = Boolean(candidate.identity_alignment?.hardBlock);

    if (id_status === "verified") summary.identity_verified_count += 1;
    else if (id_status === "probable") summary.identity_probable_count += 1;
    else if (id_status === "household_associated") summary.identity_household_associated_count += 1;
    else if (id_status === "weak") summary.identity_weak_count += 1;
    else if (id_status === "unknown") summary.identity_unknown_count += 1;
    else if (id_status === "mismatch") summary.identity_mismatch_count += 1;

    if (is_hard_blocked) {
      summary.identity_hard_block_count += 1;
    }

    const identity_policy = isIdentityEligibleForLiveOutbound(candidate.identity_alignment, options);
    if (identity_policy.eligible) {
      summary.identity_live_eligible_count += 1;
      if (id_status === "verified") summary.identity_verified_allowed_count += 1;
      if (id_status === "probable") summary.identity_probable_allowed_count += 1;
      if (id_status === "household_associated") summary.identity_household_associated_allowed_count += 1;
    } else {
      summary.identity_live_ineligible_count += 1;
      if (id_status === "weak") summary.identity_weak_held_count += 1;
      if (id_status === "unknown") summary.identity_unknown_held_count += 1;
      if (id_status === "household_associated") summary.identity_household_held_count += 1;
    }
    // ──────────────────────────────────────────────────────────────────────────

    if (!eligibility.ok) {
      summary.skipped_count += 1;
      const counter = mapReasonToDiagnosticCounter(eligibility.reason_code);
      if (counter) summary[counter] += 1;
      if (eligibility.reason_code === REASON_CODES.NO_PROPERTY && candidate._property_hydrated === false) {
        summary.missing_property_id_after_hydration_count += 1;
      }
      summary.sample_skips.push({
        reason_code: eligibility.reason_code,
        reason: eligibility.reason,
        master_owner_id: candidate.master_owner_id,
        property_id: candidate.property_id,
        owner_name: candidate.owner_display_name,
        to_phone_number: candidate.canonical_e164,
        property_address: candidate.property_address,
        market: candidate.market,
        canonical_property_group: candidate.canonical_property_group,
        property_type: candidate.property_type,
        do_not_call: candidate.raw?.do_not_call,
        true_post_contact_suppression: candidate.true_post_contact_suppression,
        never_contacted: candidate.never_contacted,
        ..._preview,
      });
      continue;
    }

    summary.eligible_count += 1;

    // ── Hard Name Gate ───────────────────────────────────────────────────────
    if (candidate.seller_name_missing) {
      summary.skipped_count += 1;
      summary.hydration_failure_count += 1;
      summary.sample_skips.push({
        reason_code: REASON_CODES.NAME_HYDRATION_FAILURE,
        reason: "missing_seller_first_name",
        master_owner_id: candidate.master_owner_id,
        property_id: candidate.property_id,
        owner_name: candidate.owner_display_name,
        available_name_fields: {
          seller_first_name: candidate.seller_first_name,
          prospect_first_name: candidate.prospect_first_name,
          owner_first_name: candidate.owner_first_name,
          phone_first_name: candidate.phone_first_name,
          phone_full_name: candidate.phone_full_name,
          display_name: candidate.display_name,
        },
        ..._preview,
      });
      continue;
    }
    // ─────────────────────────────────────────────────────────────────────────

    const routing = await chooseTextgridNumber(candidate, options, deps);
    if (!routing.ok) {
      summary.skipped_count += 1;
      summary.routing_block_count += 1;
      summary.sample_skips.push({
        reason_code: routing.reason_code,
        reason: routing.routing_block_reason,
        master_owner_id: candidate.master_owner_id,
        property_id: candidate.property_id,
        routing_allowed: false,
        routing_tier: routing.routing_tier,
        selection_reason: routing.selection_reason,
        routing_rule_name: routing.routing_rule_name,
        selected_textgrid_market: routing.selected_textgrid_market,
        selected_textgrid_number: routing.selected_textgrid_number,
        seller_market: routing.seller_market || candidate.market,
        seller_state: routing.seller_state || candidate.state,
        routing_block_reason: routing.routing_block_reason,
        ..._preview,
      });
      continue;
    }

    const rendered = await renderOutboundTemplate(candidate, options, deps);
    if (!rendered.ok) {
      summary.skipped_count += 1;
      summary.template_block_count += 1;
      if (rendered.reason_code === REASON_CODES.NO_TEMPLATE) {
        summary.no_template_count += 1;
      }
      if (rendered.reason_code === REASON_CODES.TEMPLATE_RENDER_FAILED) {
        summary.template_render_failed_count += 1;
        if (rendered.reason === "blank_greeting_rendered") {
          summary.hydration_failure_count += 1;
        }
      }
      summary.sample_skips.push({
        reason_code: rendered.reason_code,
        reason: rendered.reason,
        master_owner_id: candidate.master_owner_id,
        property_id: candidate.property_id,
        prospect_matching_flags: rendered.prospect_matching_flags || [],
        selected_template_id:
          rendered.selected_template_id || rendered.template_rotation?.selected_template_id || rendered.template?.template_id || rendered.template?.id || null,
        template_routing_reason: rendered.template_routing_reason || null,
        ...(options.dry_run && options.debug_templates
          ? {
              template_lookup_use_case: candidate.template_lookup_use_case || candidate.template_use_case || null,
              template_id: rendered.template?.template_id || rendered.template?.id || null,
              podio_template_id: rendered.template?.podio_template_id || null,
              template_source: "sms_templates",
              template_name: rendered.template?.template_name || null,
              stage_code: rendered.template?.stage_code || candidate.stage_code || null,
              stage_label: rendered.template?.stage_label || candidate.stage_label || null,
              touch_number: candidate.touch_number,
              language: rendered.template?.language || candidate.best_language || candidate.language || "English",
              render_error_message: rendered.render_error_message || rendered.reason || null,
              missing_variables: rendered.missing_variables || [],
              variable_payload_preview: rendered.variable_payload_preview || {},
              selected_template_preview: rendered.selected_template_preview || null,
              eligible_template_count: Number(rendered.template_rotation?.eligible_template_count || 0),
              rotation_pool_size: Number(rendered.template_rotation?.rotation_pool_size || 0),
              rotation_strategy: clean(rendered.template_rotation?.rotation_strategy) || null,
              rotation_best_score: Number.isFinite(Number(rendered.template_rotation?.rotation_best_score))
                ? Number(rendered.template_rotation?.rotation_best_score)
                : null,
              rotation_min_score: Number.isFinite(Number(rendered.template_rotation?.rotation_min_score))
                ? Number(rendered.template_rotation?.rotation_min_score)
                : null,
              rotation_candidate_template_ids: rendered.template_rotation?.rotation_candidate_template_ids || [],
              rotation_candidate_languages: rendered.template_rotation?.rotation_candidate_languages || [],
              requested_language: rendered.template_rotation?.requested_language || null,
              selected_template_language: rendered.template_rotation?.selected_template_language || null,
              rotation_language_mismatch_detected: Boolean(rendered.template_rotation?.rotation_language_mismatch_detected),
              selected_template_id:
                rendered.template_rotation?.selected_template_id || rendered.template?.template_id || rendered.template?.id || null,
              rotation_seed: rendered.template_rotation?.seed || null,
              excluded_recent_template_ids: rendered.template_rotation?.excluded_recent_template_ids || [],
              template_fetch_limit: rendered.template_rotation?.template_fetch_limit ?? null,
              template_fetch_language_filter_applied: Boolean(rendered.template_rotation?.template_fetch_language_filter_applied),
              template_fetch_use_case_filter_applied: rendered.template_rotation?.template_fetch_use_case_filter_applied !== false,
              template_fetch_stage_filter_applied: Boolean(rendered.template_rotation?.template_fetch_stage_filter_applied),
              template_fetch_fallback_used: Boolean(rendered.template_rotation?.template_fetch_fallback_used),
              raw_template_count_before_language_filter: Number(rendered.template_rotation?.raw_template_count_before_language_filter || 0),
              template_count_after_language_filter: Number(rendered.template_rotation?.template_count_after_language_filter || 0),
            }
          : {}),
        ..._preview,
      });
      continue;
    }

    const selected_template_id =
      rendered.selected_template_id ||
      rendered.template_rotation?.selected_template_id ||
      rendered.template?.template_id ||
      rendered.template?.id ||
      null;
    const health_guard = evaluateSmsHealthGuard({
      from_phone_number: routing.selected_textgrid_number || routing.selected?.phone_number,
      template_id: selected_template_id,
      routing_tier: routing.routing_tier,
      first_touch: candidate.is_first_touch,
      require_local_routing: options.require_local_routing,
      allow_regional_fallback_for_first_touch: options.allow_regional_fallback_for_first_touch,
      metadata: {
        routing_tier: routing.routing_tier,
        touch_number: candidate.touch_number,
        selected_template_id,
      },
      system_control: {
        require_local_routing: options.require_local_routing,
        allow_regional_fallback_for_first_touch: options.allow_regional_fallback_for_first_touch,
      },
      now,
    });

    if (!health_guard.allowed) {
      summary.skipped_count += 1;
      summary.routing_block_count += 1;
      summary.sample_skips.push({
        reason_code: REASON_CODES.ROUTING_BLOCKED,
        reason: health_guard.reason,
        block_class: health_guard.block_class,
        master_owner_id: candidate.master_owner_id,
        property_id: candidate.property_id,
        routing_allowed: false,
        routing_tier: routing.routing_tier,
        selected_textgrid_market: routing.selected_textgrid_market,
        selected_textgrid_number: routing.selected_textgrid_number,
        selected_template_id,
        seller_market: routing.seller_market || candidate.market,
        seller_state: routing.seller_state || candidate.state,
        routing_block_reason: health_guard.reason,
        diagnostics: health_guard.diagnostics,
        ..._preview,
      });
      continue;
    }

    let scheduled_for;
    if (spread_scheduler) {
      const spread_result = spread_scheduler.nextScheduledFor(candidate);
      if (spread_result.reason_code) {
        summary.skipped_count += 1;
        const counter = mapReasonToDiagnosticCounter(spread_result.reason_code);
        if (counter) summary[counter] += 1;
        summary.sample_skips.push({
          reason_code: spread_result.reason_code,
          reason: spread_result.reason_code,
          master_owner_id: candidate.master_owner_id,
          property_id: candidate.property_id,
          ..._preview
        });
        continue;
      }
      scheduled_for = spread_result.scheduled_for;
    } else {
      scheduled_for = eligibility.scheduled_for;
    }

    // ── Final OutboundSafetyGate ──────────────────────────────────────────────
    // Must run BEFORE createSendQueueItem. Gates: batch duplicate (defense-in-depth),
    // unsafe seller name, schedule_spread inactive.
    const gate_result = runOutboundSafetyGate(candidate, rendered, options, {
      seenPhones,
      seenOwnerPhoneTouch,
      seenOwners,
      allow_multiple_per_owner,
      spread_scheduler,
    });
    if (!gate_result.ok) {
      summary.skipped_count += 1;
      if (gate_result.gate_block_type === "batch_duplicate") {
        summary.batch_duplicate_block_count += 1;
      } else if (gate_result.reason_code === REASON_CODES.TEMPLATE_RENDER_FAILED) {
        summary.template_block_count += 1;
        summary.template_render_failed_count += 1;
      } else if (
        gate_result.reason_code === REASON_CODES.SCHEDULE_OVERFLOW_BLOCKED ||
        gate_result.reason_code === REASON_CODES.SCHEDULE_WINDOW_FULL
      ) {
        const counter = mapReasonToDiagnosticCounter(gate_result.reason_code);
        if (counter) summary[counter] += 1;
      }
      summary.sample_skips.push({
        reason_code: gate_result.reason_code,
        reason: gate_result.reason,
        gate_block_type: gate_result.gate_block_type,
        master_owner_id: candidate.master_owner_id,
        property_id: candidate.property_id,
        owner_name: candidate.owner_display_name,
        to_phone_number: candidate.canonical_e164,
        property_address: candidate.property_address,
        market: candidate.market,
        never_contacted: candidate.never_contacted,
        ..._preview
      });
      continue;
    }
    // ── End OutboundSafetyGate ────────────────────────────────────────────────

    if (phoneKey) seenPhones.add(phoneKey);
    if (ownerPhoneTouchKey) seenOwnerPhoneTouch.add(ownerPhoneTouchKey);
    if (ownerKey) seenOwners.add(ownerKey);

    let prior_phone_id = null;
    let rotated_from_thread_key = null;
    if (candidate.phone_rank > 1) {
      const priorPhonesQuery = await defaultSupabase
        .from("phones")
        .select("phone_id, wrong_number_source_thread_key")
        .eq("master_owner_id", candidate.master_owner_id)
        .eq("phone_contact_status", "wrong_number")
        .order("wrong_number_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (priorPhonesQuery.data) {
        prior_phone_id = priorPhonesQuery.data.phone_id;
        rotated_from_thread_key = priorPhonesQuery.data.wrong_number_source_thread_key;
      }
    }

    const queue_result = await createSendQueueItem(
      candidate,
      {
        ...options,
        scheduled_for,
        rendered_message_body: rendered.rendered_message_body,
        template_id: rendered.template?.template_id || rendered.template?.item_id || null,
        template_source: rendered.template?.source || "supabase",
        prior_phone_id,
        rotated_from_thread_key,
        rotation_duplicate_cooldown_applied: eligibility.duplicate_body_cooldown_applied === true,
        template_use_case: rendered.template_use_case,
        template_name: rendered.template?.template_name || null,
        template_stage_code: rendered.stage_code || rendered.template?.stage_code || null,
        template_language: rendered.language || rendered.template?.language || null,
        template_rotation_enabled: Boolean(rendered.template_rotation?.enabled),
        template_rotation_seed: rendered.template_rotation?.seed || null,
        template_rotation_pool_size: rendered.template_rotation?.rotation_pool_size || 0,
        template_rotation_candidate_ids: rendered.template_rotation?.rotation_candidate_template_ids || [],
        template_rotation_candidate_languages: rendered.template_rotation?.rotation_candidate_languages || [],
        template_rotation_selected_index: rendered.template_rotation?.selected_index ?? null,
        template_rotation_requested_language: rendered.template_rotation?.requested_language || null,
        selected_template_language: rendered.template_rotation?.selected_template_language || rendered.language || rendered.template?.language || null,
        rotation_language_mismatch_detected: Boolean(rendered.template_rotation?.rotation_language_mismatch_detected),
        template_rotation_strategy: rendered.template_rotation?.rotation_strategy || null,
        template_rotation_best_score: rendered.template_rotation?.rotation_best_score ?? null,
        template_rotation_min_score: rendered.template_rotation?.rotation_min_score ?? null,
        selected_template_id: rendered.template_rotation?.selected_template_id || rendered.template?.template_id || rendered.template?.id || null,
        selected_template_source: rendered.template?.source || "sms_templates",
        selected_template_language: rendered.language || rendered.template?.language || null,
        template_fetch_limit: rendered.template_rotation?.template_fetch_limit ?? null,
        template_fetch_language_filter_applied: Boolean(rendered.template_rotation?.template_fetch_language_filter_applied),
        template_fetch_use_case_filter_applied: rendered.template_rotation?.template_fetch_use_case_filter_applied !== false,
        template_fetch_stage_filter_applied: Boolean(rendered.template_rotation?.template_fetch_stage_filter_applied),
        template_fetch_fallback_used: Boolean(rendered.template_rotation?.template_fetch_fallback_used),
        raw_template_count_before_language_filter: Number(rendered.template_rotation?.raw_template_count_before_language_filter || 0),
        template_count_after_language_filter: Number(rendered.template_rotation?.template_count_after_language_filter || 0),
        selected_template_use_case: rendered.template_use_case,
        selected_template_stage_code: rendered.stage_code || rendered.template?.stage_code || null,
        selected_textgrid_number_id: routing.selected.id,
        selected_textgrid_number: routing.selected.phone_number,
        selected_textgrid_market: routing.selected.market,
        routing_tier: routing.routing_tier,
        selection_reason: routing.selection_reason,
        routing_allowed: routing.routing_allowed,
        routing_block_reason: routing.routing_block_reason,
      },
      deps
    );

    if (!queue_result.ok) {
      summary.skipped_count += 1;
      const reason_code = queue_result.reason_code || REASON_CODES.DUPLICATE_QUEUE_ITEM;
      const counter = mapReasonToDiagnosticCounter(reason_code);
      if (counter) summary[counter] += 1;
      summary.sample_skips.push({
        reason_code,
        reason: queue_result.reason || "queue_create_failed",
        master_owner_id: candidate.master_owner_id,
        property_id: candidate.property_id,
        prospect_matching_flags: rendered.prospect_matching_flags || [],
        selected_template_id:
          rendered.selected_template_id || rendered.template_rotation?.selected_template_id || rendered.template?.template_id || rendered.template?.id || null,
        template_routing_reason: rendered.template_routing_reason || null,
        ..._preview,
      });
      continue;
    }

    if (queue_result.idempotent_replay) {
      summary.idempotent_replay_count = Number(summary.idempotent_replay_count || 0) + 1;
      continue;
    }

    const scheduling = classifyInsertedQueueScheduling(queue_result, scheduled_for);
    if (scheduling.persistedScheduledFor && scheduling.scheduledAtMs === null) {
      summary.invalid_scheduled_for_count += 1;
      logger.warn("feeder.invalid_scheduled_for_after_insert", {
        queue_row_id: queue_result.queue_row_id || queue_result.inserted?.queue_row_id || null,
        campaign_target_id: candidate.campaign_target_id || candidate.raw?.campaign_target_id || null,
        scheduled_for: String(scheduling.persistedScheduledFor),
        queue_status: scheduling.persistedStatus || null,
        route: "runSupabaseCandidateFeeder",
      });
      if (summary.invalid_scheduled_for_examples.length < 3) {
        summary.invalid_scheduled_for_examples.push({
          scheduled_for: String(scheduling.persistedScheduledFor),
          queue_key: queue_result.queue_key || null,
          queue_row_id: queue_result.queue_row_id || null,
          master_owner_id: candidate.master_owner_id || null,
          property_id: candidate.property_id || null,
        });
      }
    }
    if (scheduling.isScheduled) {
      summary.scheduled_count = (summary.scheduled_count || 0) + 1;
    } else {
      summary.queued_count += 1;
    }
    if (!summary.first_scheduled_for) summary.first_scheduled_for = scheduled_for;
    summary.last_scheduled_for = scheduled_for;
    summary.selected_textgrid_market_counts[routing.selected.market || "unknown"] =
      Number(summary.selected_textgrid_market_counts[routing.selected.market || "unknown"] || 0) + 1;
    summary.routing_tier_counts[routing.routing_tier || "unknown"] =
      Number(summary.routing_tier_counts[routing.routing_tier || "unknown"] || 0) + 1;

    summary.sample_created_queue_items.push({
      queue_row_id: queue_result.queue_row_id || null,
      queue_key: queue_result.queue_key,
      scheduled_for: scheduled_for || null,
      master_owner_id: candidate.master_owner_id,
      property_id: candidate.property_id,
      owner_name: candidate.owner_display_name,
      to_phone_number: candidate.canonical_e164,
      property_address: candidate.property_address,
      market: candidate.market,
      canonical_property_group: candidate.canonical_property_group,
      property_type: candidate.property_type,
      template_allowed_groups: rendered.template?.allowed_property_groups,
      do_not_call: candidate.raw?.do_not_call,
      true_post_contact_suppression: candidate.true_post_contact_suppression,
      never_contacted: candidate.never_contacted,
      phone_masked: maskPhone(candidate.canonical_e164),
      selected_textgrid_number_id: routing.selected.id,
      selected_textgrid_number: routing.selected.phone_number,
      selected_textgrid_market: routing.selected.market,
      seller_market: candidate.market,
      seller_state: candidate.state,
      identity_resolution: candidate.identity_alignment?.status || null,
      identity_alignment_status: candidate.identity_alignment?.status || null,
      identity_status: candidate.identity_alignment?.status || null,
      candidate_preview: options.dry_run ? buildCandidateNormalizedPreview(candidate.raw, candidate) : undefined,
      routing_tier: routing.routing_tier,
      selection_reason: routing.selection_reason,
      routing_rule_name: routing.routing_rule_name,
      routing_allowed: true,
      routing_block_reason: null,
      template_use_case: rendered.template_use_case,
      template_id: rendered.template?.template_id || rendered.template?.id || null,
      selected_template_id:
        rendered.selected_template_id || rendered.template_rotation?.selected_template_id || rendered.template?.template_id || rendered.template?.id || null,
      template_name: rendered.template?.template_name || null,
      prospect_matching_flags: rendered.prospect_matching_flags || [],
      template_routing_reason: rendered.template_routing_reason || null,
      stage_code: rendered.stage_code || rendered.template?.stage_code || null,
      language: rendered.language || rendered.template?.language || null,
      template_rotation_enabled: Boolean(rendered.template_rotation?.enabled),
      template_rotation_pool_size: Number(rendered.template_rotation?.rotation_pool_size || 0),
      template_rotation_selected_index: Number(rendered.template_rotation?.selected_index ?? -1),
      template_rotation_requested_language: clean(rendered.template_rotation?.requested_language) || null,
      selected_template_language: clean(rendered.template_rotation?.selected_template_language || rendered.language || rendered.template?.language) || null,
      rotation_language_mismatch_detected: Boolean(rendered.template_rotation?.rotation_language_mismatch_detected),
      rotation_candidate_languages: rendered.template_rotation?.rotation_candidate_languages || [],
      template_rotation_strategy: clean(rendered.template_rotation?.rotation_strategy) || null,
      template_rotation_best_score: Number.isFinite(Number(rendered.template_rotation?.rotation_best_score))
        ? Number(rendered.template_rotation?.rotation_best_score)
        : null,
      template_rotation_min_score: Number.isFinite(Number(rendered.template_rotation?.rotation_min_score))
        ? Number(rendered.template_rotation?.rotation_min_score)
        : null,
      template_fetch_limit: rendered.template_rotation?.template_fetch_limit ?? null,
      template_fetch_language_filter_applied: Boolean(rendered.template_rotation?.template_fetch_language_filter_applied),
      template_fetch_use_case_filter_applied: rendered.template_rotation?.template_fetch_use_case_filter_applied !== false,
      template_fetch_stage_filter_applied: Boolean(rendered.template_rotation?.template_fetch_stage_filter_applied),
      template_fetch_fallback_used: Boolean(rendered.template_rotation?.template_fetch_fallback_used),
      raw_template_count_before_language_filter: Number(rendered.template_rotation?.raw_template_count_before_language_filter || 0),
      template_count_after_language_filter: Number(rendered.template_rotation?.template_count_after_language_filter || 0),
      rendered_message_preview: clean(rendered.rendered_message_body).slice(0, 160),
      dry_run: options.dry_run,
    });
  }

  const diagnostics = buildFeederDiagnostics(summary);
  logger.info("outbound.supabase_feeder_completed", {
    source: diagnostics.source,
    dry_run: diagnostics.dry_run,
    scanned_count: diagnostics.scanned_count,
    eligible_count: diagnostics.eligible_count,
    queued_count: diagnostics.queued_count,
    skipped_count: diagnostics.skipped_count,
  });

  return diagnostics;
}

export { REASON_CODES };

async function quarantineIdentityMismatch(candidate, identity_alignment, deps = {}) {
  try {
    console.warn("[identity_mismatch.quarantine]", {
      master_owner_id: candidate?.master_owner_id,
      property_id: candidate?.property_id,
      phone_id: candidate?.best_phone_id || candidate?.phone_id,
      to_phone_number: candidate?.canonical_e164 || candidate?.phone,
      identity_alignment_status: identity_alignment?.status,
      identity_alignment_score: identity_alignment?.score,
    });

    return { ok: true, quarantined: true };
  } catch (error) {
    console.warn("[identity_mismatch.quarantine_failed]", {
      error: error?.message,
    });
    return { ok: false, quarantined: false, error: error?.message };
  }
}
