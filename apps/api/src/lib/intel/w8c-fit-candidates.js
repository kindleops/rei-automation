/**
 * Loads the eligible W8C buyer population for shadow fit evaluation.
 *
 * ELIGIBILITY: a candidate must have a real W8B-derived buybox. That is 528 of
 * 40,487 buyers today. No profile is manufactured for the remaining 39,959 —
 * absent a buybox the correct answer is `insufficient_evidence`, not a guess.
 *
 * Reads only the approved `reivesti.buyer_*` serving views, inside the same
 * database-enforced read-only transaction the rest of the W8C layer uses, and
 * reuses the shared pg pool rather than opening another client.
 *
 * Person entity IDs are redacted at load, so a raw `person:{individual_key}`
 * never exists in evaluator input, output, or any downstream payload.
 */

import { getPgPool } from "@/lib/postgres/client.js";
import { assertServingLayerOnly, redactBuyerEntityId, W8C_SOURCE } from "./w8c-buyer-intelligence.js";

const TIMEOUT_MS = 8_000;

/**
 * Geography at the finest precision W8C publishes: ZIPs come from the W8B
 * geography profile (present for 525/528), counties and states from the buybox.
 */
const CANDIDATE_SQL = `
  SELECT bb.buyer_entity_id,
         s.entity_type,
         s.display_name,
         bb.acceptable_states,
         bb.preferred_counties,
         bb.preferred_asset_families,
         bb.price_robust_low,
         bb.price_robust_high,
         bb.price_low,
         bb.price_high,
         bb.building_sqft_p25,
         bb.building_sqft_p75,
         bb.units_p25,
         bb.units_p75,
         bb.evidence_depth,
         bb.confidence      AS buybox_confidence,
         b.confidence       AS behavior_confidence,
         b.days_since_last,
         b.activity_status,
         b.archetype,
         b.acquisition_count,
         (SELECT array_agg(elem ->> 0)
            FROM jsonb_array_elements(coalesce(b.geography_profile -> 'zips', '[]'::jsonb)) elem) AS zips
    FROM reivesti.buyer_buybox bb
    JOIN reivesti.buyer_summary  s ON s.buyer_entity_id = bb.buyer_entity_id
    JOIN reivesti.buyer_behavior b ON b.buyer_entity_id = bb.buyer_entity_id`;

const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

async function defaultQuery(sql, params = []) {
  const client = await getPgPool().connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${TIMEOUT_MS}`);
    const result = await client.query(sql, params);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function mapCandidate(row = {}) {
  return {
    // Redacted at the boundary: company registry ids pass through, person ids
    // become person:anon_<hash>.
    buyerRef: redactBuyerEntityId(row.buyer_entity_id),
    entityType: row.entity_type ?? "unknown",
    // Company names only; W8C withholds natural-person names entirely.
    displayName: row.entity_type === "company" ? (row.display_name ?? null) : null,
    states: row.acceptable_states ?? [],
    counties: row.preferred_counties ?? [],
    zips: row.zips ?? [],
    assetFamilies: row.preferred_asset_families ?? [],
    priceRobustLow: num(row.price_robust_low),
    priceRobustHigh: num(row.price_robust_high),
    priceCoreLow: num(row.price_low),
    priceCoreHigh: num(row.price_high),
    buildingSqftP25: num(row.building_sqft_p25),
    buildingSqftP75: num(row.building_sqft_p75),
    unitsP25: num(row.units_p25),
    unitsP75: num(row.units_p75),
    evidenceDepth: num(row.evidence_depth),
    buyboxConfidence: num(row.buybox_confidence),
    behaviorConfidence: num(row.behavior_confidence),
    daysSinceLast: num(row.days_since_last),
    activityStatus: row.activity_status ?? null,
    archetype: row.archetype ?? null,
    acquisitionCount: num(row.acquisition_count),
  };
}

/**
 * Load every buyer with a derived buybox. Never throws: an unavailable W8C
 * resolves to an empty, labelled result so the panel degrades quietly.
 */
export async function loadFitCandidates(deps = {}) {
  const query = deps.query ?? defaultQuery;
  try {
    assertServingLayerOnly(CANDIDATE_SQL);
    const result = await query(CANDIDATE_SQL, []);
    const rows = result?.rows ?? [];
    return { available: true, source: W8C_SOURCE, candidates: rows.map(mapCandidate) };
  } catch (error) {
    const code = error?.code ? String(error.code) : "unknown";
    return { available: false, source: W8C_SOURCE, reason: `w8c_unavailable:${code}`, candidates: [] };
  }
}

export default loadFitCandidates;

/**
 * Load the subject property's evaluable features.
 *
 * Reads `public.properties` (REI's own table, not W8C), so the serving-layer
 * guard does not apply — but the read-only transaction still does. Only the
 * columns the evaluator can actually use are selected; bedrooms, bathrooms and
 * year built are deliberately excluded because W8C publishes no counterpart.
 */
export async function loadSubjectProperty(propertyId, deps = {}) {
  const query = deps.query ?? defaultQuery;
  if (!propertyId) return { available: false, reason: "missing_property_id", subject: null };
  try {
    const { rows } = await query(
      `SELECT property_id,
              property_address_state  AS state,
              property_address_county_name AS county,
              property_address_zip    AS zip,
              property_type,
              units_count,
              building_square_feet,
              estimated_value
         FROM public.properties
        WHERE property_id = $1
        LIMIT 1`,
      [String(propertyId)],
    );
    const row = rows?.[0];
    if (!row) return { available: false, reason: "subject_not_found", subject: null };
    return { available: true, subject: row };
  } catch (error) {
    return { available: false, reason: `subject_unavailable:${error?.code ?? "unknown"}`, subject: null };
  }
}
