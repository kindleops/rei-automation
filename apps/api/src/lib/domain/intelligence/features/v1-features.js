/**
 * IC8 v1 FEATURES for the first model family, `seller_first_touch_reply`
 * (architecture §12.1, extended by the owner decision of 2026-10-01).
 *
 * Point-in-time rules applied here:
 *   - local hour/weekday use the PROPERTY time zone (canonical
 *     deriveTimezoneFromGeography), never the stored send_queue.timezone or
 *     local_send_hour (wrong for 366 legacy sends) and never anything about
 *     the person;
 *   - prior-touch features read only sends placed strictly before the decision,
 *     and a prior send counts as delivered only if its receipt arrived before
 *     the decision;
 *   - recorded sales / mortgages are dated documents (end of their date < T);
 *   - owner entity class and the personal_attribute fields come from imports
 *     frozen since 2026-04 (static_fact with a documented as_of);
 *   - absentee and lien counts have no dated source (properties is rewritten in
 *     place; 95% of seller.property_lien rows carry no recording/filing date),
 *     so they are decision_snapshot_only: captured online at decision time,
 *     never part of a historical training set.
 *
 * Feature sets (historical training, family seller_first_touch_reply):
 *   seller_first_touch@1      permitted inputs only (the baseline arm)
 *   seller_first_touch_all@1  + the eight personal_attribute fields (gender,
 *                             marital status, owner language, agent persona,
 *                             age band, household income band, education,
 *                             occupation). Models built on it ship a fairness
 *                             report (fairness/group-audit.js).
 */

import {
  CONTACT_WINDOW_POLICY_VERSION,
  deriveTimezoneFromGeography,
} from "../../campaigns/contact-window-timezone.js";
import { createFeatureRegistry } from "../registry/feature-registry.js";
import { DAY_MS, dateOnlyEndMs, toMs } from "../util/time.js";

/** Version of the helper functions below; part of every lineage that uses them. */
export const V1_HELPERS_VERSION = "ic8_v1_feature_helpers@1";
const YEAR_MS = 365.25 * DAY_MS;

// ── helpers (pure) ───────────────────────────────────────────────────────

const ZONE_CACHE = new Map();
/** IANA zone of the PROPERTY (state + ZIP3), or null when it cannot be derived confidently. */
export function propertyTimeZone(property) {
  if (!property) return null;
  const state = String(property.property_address_state ?? "").trim().toUpperCase();
  const zip = String(property.property_address_zip ?? "").trim();
  if (!state) return null;
  const cacheKey = `${state}|${zip.slice(0, 3)}`;
  if (!ZONE_CACHE.has(cacheKey)) {
    const resolved = deriveTimezoneFromGeography(state, zip);
    ZONE_CACHE.set(cacheKey, resolved && resolved.confident ? resolved.iana || null : null);
  }
  return ZONE_CACHE.get(cacheKey);
}

const CLOCK_FORMATTERS = new Map();
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** { hour 0-23, weekday 0=Sun..6=Sat } of an instant in a zone. */
export function localClock(ms, zone) {
  if (!zone || !Number.isFinite(ms)) return null;
  if (!CLOCK_FORMATTERS.has(zone)) {
    CLOCK_FORMATTERS.set(
      zone,
      new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", hour: "2-digit", weekday: "short" }),
    );
  }
  const parts = {};
  for (const { type, value } of CLOCK_FORMATTERS.get(zone).formatToParts(new Date(ms))) parts[type] = value;
  const hour = Number(parts.hour);
  const weekday = WEEKDAYS.indexOf(parts.weekday);
  if (!Number.isInteger(hour) || weekday < 0) return null;
  return { hour: hour === 24 ? 0 : hour, weekday };
}

export function normalizeCategory(value, maxLength = 60) {
  const text = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[$,]/g, "")
    .replace(/[^a-z0-9+]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return text ? text.slice(0, maxLength) : null;
}

export function normalizeAssetFamily(propertyType) {
  const raw = String(propertyType ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (["sfr", "single family", "single-family", "single_family"].includes(raw)) return "single_family";
  if (["multi-family", "multifamily", "multi family", "multifamily 2-4", "multi-family (2-4)"].includes(raw)) return "multifamily_2_4";
  if (["multifamily 5+", "apartment", "apartments", "apartment / 5+"].includes(raw)) return "multifamily_5_plus";
  return normalizeCategory(raw, 40);
}

export function boundedNumber(value, { min, max, integer = false }) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return integer ? Math.round(n) : n;
}

/** First segment of master_owners.owner_type_guess ("LLC/CORP | ABSENTEE" -> company). */
export function normalizeOwnerEntityClass(ownerTypeGuess) {
  const head = String(ownerTypeGuess ?? "").split("|")[0].trim().toUpperCase();
  if (!head) return null;
  if (head === "INDIVIDUAL") return "individual";
  if (head === "LLC/CORP" || head === "CORPORATE") return "company";
  if (head === "TRUST/ESTATE") return "trust_estate";
  if (head === "BANK/INSTITUTION") return "bank_institution";
  return "other";
}

/** Age band at the decision instant from a yyyymm month of birth (Tier R). */
export function ageBandAt(mob, asOfMs) {
  const match = /^(\d{4})(\d{2})$/.exec(String(mob ?? "").trim());
  if (!match || !Number.isFinite(asOfMs)) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  const at = new Date(asOfMs);
  const months = (at.getUTCFullYear() - year) * 12 + (at.getUTCMonth() + 1 - month);
  const age = Math.floor(months / 12);
  if (age < 18 || age > 110) return null;
  if (age < 35) return "18_34";
  if (age < 45) return "35_44";
  if (age < 55) return "45_54";
  if (age < 65) return "55_64";
  if (age < 75) return "65_74";
  return "75_plus";
}

const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;

// ── definitions ──────────────────────────────────────────────────────────

const SEND_TIME_SOURCES = Object.freeze([
  "send_queue.sent_at",
  "send_queue.created_at",
  "properties.property_address_state",
  "properties.property_address_zip",
]);

export const V1_FEATURE_SPECS = Object.freeze([
  {
    key: "send.recipient_local_hour",
    version: 1,
    scope: "time",
    domain: "operational",
    valueType: "integer",
    mode: "both",
    pitClass: "event_time",
    fairnessClass: "permitted",
    lineage: {
      sources: SEND_TIME_SOURCES,
      keys: ["send_queue.property_id"],
      calc: "hour 0-23 of coalesce(sent_at, created_at) in the PROPERTY time zone (state + ZIP3); null when the zone is not confidently derivable",
      tz_resolver: `contact-window-timezone.deriveTimezoneFromGeography/${CONTACT_WINDOW_POLICY_VERSION}`,
      helpers: V1_HELPERS_VERSION,
    },
    owner: "intelligence",
    freshnessSla: null,
    compute: ({ asOf, read }) => {
      const [property] = read("property");
      const clock = localClock(asOf, propertyTimeZone(property));
      return clock ? clock.hour : null;
    },
  },
  {
    key: "send.recipient_local_weekday",
    version: 1,
    scope: "time",
    domain: "operational",
    valueType: "integer",
    mode: "both",
    pitClass: "event_time",
    fairnessClass: "permitted",
    lineage: {
      sources: SEND_TIME_SOURCES,
      keys: ["send_queue.property_id"],
      calc: "weekday 0=Sun..6=Sat of coalesce(sent_at, created_at) in the PROPERTY time zone",
      tz_resolver: `contact-window-timezone.deriveTimezoneFromGeography/${CONTACT_WINDOW_POLICY_VERSION}`,
      helpers: V1_HELPERS_VERSION,
    },
    owner: "intelligence",
    freshnessSla: null,
    compute: ({ asOf, read }) => {
      const [property] = read("property");
      const clock = localClock(asOf, propertyTimeZone(property));
      return clock ? clock.weekday : null;
    },
  },
  {
    key: "property.market",
    version: 1,
    scope: "market",
    domain: "property",
    valueType: "categorical",
    mode: "both",
    pitClass: "static_fact",
    fairnessClass: "permitted",
    lineage: {
      sources: ["properties.canonical_market_id", "properties.market"],
      keys: ["send_queue.property_id"],
      calc: "canonical market of the PROPERTY (canonical_market_id, else market), lower-cased",
      as_of: "properties re-imported 2026-08 (documented caveat)",
      helpers: V1_HELPERS_VERSION,
    },
    owner: "intelligence",
    freshnessSla: null,
    compute: ({ read }) => {
      const [property] = read("property");
      return property ? normalizeCategory(property.canonical_market_id ?? property.market, 80) : null;
    },
  },
  {
    key: "property.asset_family",
    version: 1,
    scope: "property",
    domain: "property",
    valueType: "categorical",
    mode: "both",
    pitClass: "static_fact",
    fairnessClass: "permitted",
    lineage: {
      sources: ["properties.property_type"],
      keys: ["send_queue.property_id"],
      calc: "property_type normalised: single_family | multifamily_2_4 | multifamily_5_plus | <snake_case raw>",
      as_of: "properties re-imported 2026-08 (documented caveat)",
      helpers: V1_HELPERS_VERSION,
    },
    owner: "intelligence",
    freshnessSla: null,
    compute: ({ read }) => {
      const [property] = read("property");
      return property ? normalizeAssetFamily(property.property_type) : null;
    },
  },
  {
    key: "property.unit_count",
    version: 1,
    scope: "property",
    domain: "property",
    valueType: "integer",
    mode: "both",
    pitClass: "static_fact",
    fairnessClass: "permitted",
    lineage: {
      sources: ["properties.units_count"],
      keys: ["send_queue.property_id"],
      calc: "units_count within [0, 5000], else null",
      as_of: "properties re-imported 2026-08 (documented caveat)",
      helpers: V1_HELPERS_VERSION,
    },
    owner: "intelligence",
    freshnessSla: null,
    compute: ({ read }) => {
      const [property] = read("property");
      return property ? boundedNumber(property.units_count, { min: 0, max: 5000, integer: true }) : null;
    },
  },
  {
    key: "property.living_sqft",
    version: 1,
    scope: "property",
    domain: "property",
    valueType: "number",
    mode: "both",
    pitClass: "static_fact",
    fairnessClass: "permitted",
    lineage: {
      sources: ["properties.building_square_feet"],
      keys: ["send_queue.property_id"],
      calc: "building_square_feet within (0, 1e6], else null",
      as_of: "properties re-imported 2026-08 (documented caveat)",
      helpers: V1_HELPERS_VERSION,
    },
    owner: "intelligence",
    freshnessSla: null,
    compute: ({ read }) => {
      const [property] = read("property");
      return property ? boundedNumber(property.building_square_feet, { min: 1, max: 1e6 }) : null;
    },
  },
  {
    key: "property.bedrooms",
    version: 1,
    scope: "property",
    domain: "property",
    valueType: "number",
    mode: "both",
    pitClass: "static_fact",
    fairnessClass: "permitted",
    lineage: {
      sources: ["properties.total_bedrooms"],
      keys: ["send_queue.property_id"],
      calc: "total_bedrooms within [0, 200], else null",
      as_of: "properties re-imported 2026-08 (documented caveat)",
      helpers: V1_HELPERS_VERSION,
    },
    owner: "intelligence",
    freshnessSla: null,
    compute: ({ read }) => {
      const [property] = read("property");
      return property ? boundedNumber(property.total_bedrooms, { min: 0, max: 200 }) : null;
    },
  },
  {
    key: "property.bathrooms",
    version: 1,
    scope: "property",
    domain: "property",
    valueType: "number",
    mode: "both",
    pitClass: "static_fact",
    fairnessClass: "permitted",
    lineage: {
      sources: ["properties.total_baths"],
      keys: ["send_queue.property_id"],
      calc: "total_baths within [0, 200], else null",
      as_of: "properties re-imported 2026-08 (documented caveat)",
      helpers: V1_HELPERS_VERSION,
    },
    owner: "intelligence",
    freshnessSla: null,
    compute: ({ read }) => {
      const [property] = read("property");
      return property ? boundedNumber(property.total_baths, { min: 0, max: 200 }) : null;
    },
  },
  {
    key: "property.year_built",
    version: 1,
    scope: "property",
    domain: "property",
    valueType: "integer",
    mode: "both",
    pitClass: "static_fact",
    fairnessClass: "permitted",
    lineage: {
      sources: ["properties.year_built"],
      keys: ["send_queue.property_id"],
      calc: "year_built within [1700, 2030], else null",
      as_of: "properties re-imported 2026-08 (documented caveat)",
      helpers: V1_HELPERS_VERSION,
    },
    owner: "intelligence",
    freshnessSla: null,
    compute: ({ read }) => {
      const [property] = read("property");
      return property ? boundedNumber(property.year_built, { min: 1700, max: 2030, integer: true }) : null;
    },
  },
  {
    key: "template.use_case",
    version: 1,
    scope: "template",
    domain: "operational",
    valueType: "categorical",
    mode: "both",
    pitClass: "event_time",
    fairnessClass: "permitted",
    lineage: {
      sources: ["send_queue.use_case_template"],
      calc: "use case of the template chosen for this send (the action), lower-cased",
      helpers: V1_HELPERS_VERSION,
    },
    owner: "intelligence",
    freshnessSla: null,
    compute: ({ entity }) => normalizeCategory(entity.use_case_template, 80),
  },
  {
    key: "template.template_id",
    version: 1,
    scope: "template",
    domain: "operational",
    valueType: "categorical",
    mode: "both",
    pitClass: "event_time",
    fairnessClass: "permitted",
    lineage: {
      sources: ["send_queue.template_id"],
      calc: "template id chosen for this send (the action)",
    },
    owner: "intelligence",
    freshnessSla: null,
    compute: ({ entity }) => {
      const id = String(entity.template_id ?? "").trim();
      return id ? id.slice(0, 200) : null;
    },
  },
  {
    key: "seller.prior_touch_count",
    version: 1,
    scope: "seller",
    domain: "operational",
    valueType: "integer",
    mode: "both",
    pitClass: "event_time",
    fairnessClass: "permitted",
    lineage: {
      sources: ["send_queue.sent_at", "send_queue.created_at"],
      keys: ["send_queue.thread_key"],
      calc: "sends on the same thread with sent_at set and placed strictly before the decision",
    },
    owner: "intelligence",
    freshnessSla: null,
    compute: ({ entity, read }) =>
      read("sends").filter((s) => s.sent_at !== null && (!entity.thread_key || s.thread_key === entity.thread_key)).length,
  },
  {
    key: "seller.days_since_last_touch",
    version: 1,
    scope: "seller",
    domain: "operational",
    valueType: "number",
    mode: "both",
    pitClass: "event_time",
    fairnessClass: "permitted",
    lineage: {
      sources: ["send_queue.sent_at"],
      keys: ["send_queue.thread_key"],
      calc: "(decision time - latest prior sent_at on the thread) in days, 4 decimals; null with no prior touch",
    },
    owner: "intelligence",
    freshnessSla: null,
    compute: ({ asOf, entity, read }) => {
      let latest = null;
      for (const s of read("sends")) {
        if (entity.thread_key && s.thread_key !== entity.thread_key) continue;
        const t = toMs(s.sent_at);
        if (t !== null && (latest === null || t > latest)) latest = t;
      }
      return latest === null ? null : round((asOf - latest) / DAY_MS, 4);
    },
  },
  {
    key: "seller.prior_delivered_count",
    version: 1,
    scope: "seller",
    domain: "operational",
    valueType: "integer",
    mode: "both",
    pitClass: "event_time",
    fairnessClass: "permitted",
    lineage: {
      sources: ["send_queue.sent_at", "send_queue.delivered_at"],
      keys: ["send_queue.thread_key"],
      calc: "prior sends on the thread whose delivered_at is ALSO strictly before the decision",
    },
    owner: "intelligence",
    freshnessSla: null,
    compute: ({ entity, read }) =>
      read("sends").filter(
        (s) => s.sent_at !== null && s.delivered_at !== null && (!entity.thread_key || s.thread_key === entity.thread_key),
      ).length,
  },
  {
    key: "owner.entity_class",
    version: 1,
    scope: "seller",
    domain: "ownership_prospect",
    valueType: "categorical",
    mode: "both",
    pitClass: "static_fact",
    fairnessClass: "permitted",
    lineage: {
      sources: ["master_owners.owner_type_guess"],
      keys: ["send_queue.master_owner_id"],
      calc: "entity segment of owner_type_guess: individual | company | trust_estate | bank_institution | other",
      as_of: "master_owners import 2026-04-24/25 (+2026-05-30); frozen since",
      helpers: V1_HELPERS_VERSION,
    },
    owner: "intelligence",
    freshnessSla: null,
    compute: ({ read }) => {
      const [owner] = read("owner_profile");
      return owner ? normalizeOwnerEntityClass(owner.owner_type_guess) : null;
    },
  },
  {
    key: "property.years_since_last_recorded_sale",
    version: 1,
    scope: "property",
    domain: "ownership_prospect",
    valueType: "number",
    mode: "both",
    pitClass: "event_time",
    fairnessClass: "permitted",
    lineage: {
      sources: ["seller.property_sale.event_date"],
      keys: ["seller.property_sale.property_id"],
      calc: "ownership duration: (decision time - end of the latest recorded sale date before it) in years, 2 decimals; null with no dated sale",
      as_of: "seller.property_sale 2026-08-31 snapshot; 3% undated rows invisible; placeholder dates (<1901) invalid",
    },
    owner: "intelligence",
    freshnessSla: null,
    compute: ({ asOf, read }) => {
      let latest = null;
      for (const sale of read("recorded_sales")) {
        const t = dateOnlyEndMs(sale.event_date);
        if (t !== null && (latest === null || t > latest)) latest = t;
      }
      return latest === null ? null : round((asOf - latest) / YEAR_MS, 2);
    },
  },
  {
    key: "property.recorded_mortgage_count",
    version: 1,
    scope: "property",
    domain: "financial_title",
    valueType: "integer",
    mode: "both",
    pitClass: "event_time",
    fairnessClass: "permitted",
    lineage: {
      sources: ["seller.property_mortgage.recording_date"],
      keys: ["seller.property_mortgage.property_id"],
      calc: "mortgage records with recording_date before the decision (lower bound: open status at T is not reconstructable and ~16% of rows are undated)",
      as_of: "seller.property_mortgage 2026-08-31 snapshot",
    },
    owner: "intelligence",
    freshnessSla: null,
    compute: ({ read }) => read("recorded_mortgages").length,
  },
  {
    key: "owner.absentee",
    version: 1,
    scope: "seller",
    domain: "ownership_prospect",
    valueType: "boolean",
    mode: "online",
    pitClass: "decision_snapshot_only",
    fairnessClass: "permitted",
    lineage: {
      sources: [
        "properties.out_of_state_owner",
        "properties.owner_address_state",
        "properties.owner_address_zip",
        "properties.property_address_state",
        "properties.property_address_zip",
      ],
      keys: ["send_queue.property_id"],
      calc: "true when the mailing address is out of state or in a different ZIP5 than the property, captured at decision time",
      pit_note: "no dated source: properties is rewritten in place; never reconstructed for history",
    },
    owner: "intelligence",
    freshnessSla: "5m",
    compute: ({ read }) => {
      const [state] = read("decision_state");
      if (!state) return null;
      if (state.out_of_state_owner === true) return true;
      const ownerState = String(state.owner_address_state ?? "").trim().toUpperCase();
      const propertyState = String(state.property_address_state ?? "").trim().toUpperCase();
      const ownerZip = String(state.owner_address_zip ?? "").trim().slice(0, 5);
      const propertyZip = String(state.property_address_zip ?? "").trim().slice(0, 5);
      if (!ownerState || !propertyState) return null;
      if (ownerState !== propertyState) return true;
      if (/^\d{5}$/.test(ownerZip) && /^\d{5}$/.test(propertyZip)) return ownerZip !== propertyZip;
      return null;
    },
  },
  {
    key: "property.recorded_lien_count",
    version: 1,
    scope: "property",
    domain: "financial_title",
    valueType: "integer",
    mode: "online",
    pitClass: "decision_snapshot_only",
    fairnessClass: "permitted",
    lineage: {
      sources: ["seller.property.lien_count"],
      keys: ["seller.property.property_id"],
      calc: "vendor lien_count captured at decision time",
      pit_note: "27,664 of 29,185 seller.property_lien rows have no recording or filing date, so a count as of T cannot be reconstructed",
    },
    owner: "intelligence",
    freshnessSla: "5m",
    compute: ({ read }) => {
      const [state] = read("decision_state");
      return state ? boundedNumber(state.lien_count, { min: 0, max: 1000, integer: true }) : null;
    },
  },
  // ── personal_attribute: targeting_response families; models using them ship a fairness report ──
  {
    key: "prospect.age_band",
    version: 1,
    scope: "seller",
    domain: "ownership_prospect",
    valueType: "categorical",
    mode: "both",
    pitClass: "static_fact",
    fairnessClass: "personal_attribute",
    lineage: {
      sources: ["prospects.mob"],
      keys: ["phones.primary_prospect_id", "phones.canonical_e164"],
      calc: "age band at the decision instant from the yyyymm month of birth: 18_34 | 35_44 | 45_54 | 55_64 | 65_74 | 75_plus",
      as_of: "prospects import 2026-04-24/25; frozen since",
      helpers: V1_HELPERS_VERSION,
    },
    owner: "intelligence",
    freshnessSla: null,
    compute: ({ asOf, read }) => {
      const [person] = read("prospect_person");
      return person ? ageBandAt(person.mob, asOf) : null;
    },
  },
  {
    key: "prospect.household_income_band",
    version: 1,
    scope: "seller",
    domain: "ownership_prospect",
    valueType: "categorical",
    mode: "both",
    pitClass: "static_fact",
    fairnessClass: "personal_attribute",
    lineage: {
      sources: ["prospects.est_household_income"],
      keys: ["phones.primary_prospect_id", "phones.canonical_e164"],
      calc: "vendor modeled household income band, normalised to snake_case",
      as_of: "prospects import 2026-04-24/25; frozen since",
      helpers: V1_HELPERS_VERSION,
    },
    owner: "intelligence",
    freshnessSla: null,
    compute: ({ read }) => {
      const [person] = read("prospect_person");
      return person ? normalizeCategory(person.est_household_income) : null;
    },
  },
  {
    key: "prospect.education_level",
    version: 1,
    scope: "seller",
    domain: "ownership_prospect",
    valueType: "categorical",
    mode: "both",
    pitClass: "static_fact",
    fairnessClass: "personal_attribute",
    lineage: {
      sources: ["prospects.education_model"],
      keys: ["phones.primary_prospect_id", "phones.canonical_e164"],
      calc: "vendor modeled education, normalised to snake_case",
      as_of: "prospects import 2026-04-24/25; frozen since",
      helpers: V1_HELPERS_VERSION,
    },
    owner: "intelligence",
    freshnessSla: null,
    compute: ({ read }) => {
      const [person] = read("prospect_person");
      return person ? normalizeCategory(person.education_model) : null;
    },
  },
  {
    key: "prospect.occupation_group",
    version: 1,
    scope: "seller",
    domain: "ownership_prospect",
    valueType: "categorical",
    mode: "both",
    pitClass: "static_fact",
    fairnessClass: "personal_attribute",
    lineage: {
      sources: ["prospects.occupation_group"],
      keys: ["phones.primary_prospect_id", "phones.canonical_e164"],
      calc: "vendor occupation group, normalised to snake_case",
      as_of: "prospects import 2026-04-24/25; frozen since",
      helpers: V1_HELPERS_VERSION,
    },
    owner: "intelligence",
    freshnessSla: null,
    compute: ({ read }) => {
      const [person] = read("prospect_person");
      return person ? normalizeCategory(person.occupation_group) : null;
    },
  },
  {
    key: "prospect.gender",
    version: 1,
    scope: "seller",
    domain: "ownership_prospect",
    valueType: "categorical",
    mode: "both",
    pitClass: "static_fact",
    fairnessClass: "personal_attribute",
    lineage: {
      sources: ["prospects.gender"],
      keys: ["phones.primary_prospect_id", "phones.canonical_e164"],
      calc: "vendor gender, normalised to snake_case",
      as_of: "prospects import 2026-04-24/25; frozen since",
      helpers: V1_HELPERS_VERSION,
    },
    owner: "intelligence",
    freshnessSla: null,
    compute: ({ read }) => {
      const [person] = read("prospect_person");
      return person ? normalizeCategory(person.gender) : null;
    },
  },
  {
    key: "prospect.marital_status",
    version: 1,
    scope: "seller",
    domain: "ownership_prospect",
    valueType: "categorical",
    mode: "both",
    pitClass: "static_fact",
    fairnessClass: "personal_attribute",
    lineage: {
      sources: ["prospects.marital_status"],
      keys: ["phones.primary_prospect_id", "phones.canonical_e164"],
      calc: "vendor marital status, normalised to snake_case",
      as_of: "prospects import 2026-04-24/25; frozen since",
      helpers: V1_HELPERS_VERSION,
    },
    owner: "intelligence",
    freshnessSla: null,
    compute: ({ read }) => {
      const [person] = read("prospect_person");
      return person ? normalizeCategory(person.marital_status) : null;
    },
  },
  {
    key: "owner.language",
    version: 1,
    scope: "seller",
    domain: "ownership_prospect",
    valueType: "categorical",
    mode: "both",
    pitClass: "static_fact",
    fairnessClass: "personal_attribute",
    lineage: {
      sources: ["master_owners.best_language"],
      keys: ["send_queue.master_owner_id"],
      calc: "owner best_language (a person attribute), normalised to snake_case",
      as_of: "master_owners import 2026-04-24/25 (+2026-05-30); frozen since",
      helpers: V1_HELPERS_VERSION,
    },
    owner: "intelligence",
    freshnessSla: null,
    compute: ({ read }) => {
      const [owner] = read("owner_person");
      return owner ? normalizeCategory(owner.best_language) : null;
    },
  },
  {
    key: "owner.agent_persona",
    version: 1,
    scope: "seller",
    domain: "ownership_prospect",
    valueType: "categorical",
    mode: "both",
    pitClass: "static_fact",
    fairnessClass: "personal_attribute",
    lineage: {
      sources: ["master_owners.agent_persona"],
      keys: ["send_queue.master_owner_id"],
      calc: "sender persona assigned from the owner's language + market, normalised to snake_case",
      as_of: "master_owners import 2026-04-24/25 (+2026-05-30); frozen since",
      helpers: V1_HELPERS_VERSION,
    },
    owner: "intelligence",
    freshnessSla: null,
    compute: ({ read }) => {
      const [owner] = read("owner_person");
      return owner ? normalizeCategory(owner.agent_persona) : null;
    },
  },
]);

export const SELLER_FIRST_TOUCH_FAMILY = "seller_first_touch_reply";

export const V1_BASE_MEMBERS = Object.freeze([
  "send.recipient_local_hour@1",
  "send.recipient_local_weekday@1",
  "property.market@1",
  "property.asset_family@1",
  "property.unit_count@1",
  "property.living_sqft@1",
  "property.bedrooms@1",
  "property.bathrooms@1",
  "property.year_built@1",
  "template.use_case@1",
  "template.template_id@1",
  "seller.prior_touch_count@1",
  "seller.days_since_last_touch@1",
  "seller.prior_delivered_count@1",
  "owner.entity_class@1",
  "property.years_since_last_recorded_sale@1",
  "property.recorded_mortgage_count@1",
]);

export const V1_PERSONAL_MEMBERS = Object.freeze([
  "prospect.age_band@1",
  "prospect.household_income_band@1",
  "prospect.education_level@1",
  "prospect.occupation_group@1",
  "prospect.gender@1",
  "prospect.marital_status@1",
  "owner.language@1",
  "owner.agent_persona@1",
]);

/** Register every v1 feature and both v1 sets into a registry. */
export function registerV1Features(registry) {
  for (const spec of V1_FEATURE_SPECS) registry.register(spec);
  const base = registry.defineSet({
    name: "seller_first_touch",
    version: 1,
    members: V1_BASE_MEMBERS,
    purpose: "historical_training",
    family: SELLER_FIRST_TOUCH_FAMILY,
    description: "First-touch reply model inputs, no Tier R fields.",
  });
  const all = registry.defineSet({
    name: "seller_first_touch_all",
    version: 1,
    members: [...V1_BASE_MEMBERS, ...V1_PERSONAL_MEMBERS],
    purpose: "historical_training",
    family: SELLER_FIRST_TOUCH_FAMILY,
    description: "The base set plus the eight personal_attribute fields. Models built on it ship a fairness report.",
  });
  return { base, all };
}

export function createV1Registry() {
  const registry = createFeatureRegistry();
  registerV1Features(registry);
  return registry;
}
