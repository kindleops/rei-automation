/**
 * W8C ↔ REI property-level shadow comparison.
 *
 * Observational only. This module reports what the two systems independently
 * believe about a property. It never merges them, never writes, and its output
 * must not reach MAO, offer pricing, campaign targeting, outreach, send_queue,
 * suppressions, seller priority, or autonomous execution.
 *
 * ── The one thing to understand before editing this file ────────────────────
 * REI and W8C share a PROPERTY namespace but NOT a BUYER namespace.
 *
 *   property_id  — SHARED. Both sides carry DealMachine property IDs as text.
 *                  17,870 IDs overlap. Every independently checkable row agrees
 *                  (110/110 APN, 72/72 street address, 72/72 ZIP, 0 conflicts).
 *                  This is the ONLY join key used here.
 *
 *   buyer_entity_id — NOT SHARED, despite the identical column name.
 *                  REI: uuid, FK to public.buyer_entities_v2.id
 *                  W8C: text, 'company:{jurisdiction}:{number}' | 'person:{opaque}'
 *                  Zero overlap. REI's buyer tables carry no jurisdiction or
 *                  company-number columns, so no registry crosswalk is even
 *                  constructible. Joining these two columns because they share
 *                  a name would silently fabricate identities.
 *
 * Company-name agreement is reported as a WEAK, EXPLICITLY NON-IDENTITY signal,
 * ambiguity-checked against the full W8C and REI populations. It is a lead for
 * human review, never a merge. Person buyers are structurally unmatchable here
 * because W8C withholds natural-person names entirely — a privacy property, and
 * one worth keeping.
 */

import { getPgPool } from "@/lib/postgres/client.js";
import { normalizeEntityName } from "../acquisition/transactionClustering.js";
import { createW8cClient, redactShadowEnvelope, W8C_SOURCE } from "./w8c-buyer-intelligence.js";

export const COMPARISON_SOURCE = W8C_SOURCE;

export const IDENTITY_NAMESPACES = Object.freeze({
  property: {
    shared: true,
    basis: "dealmachine_property_id",
    evidence: "110/110 APN, 72/72 address, 72/72 zip, 0 conflicts",
  },
  buyer: {
    shared: false,
    rei: "uuid → public.buyer_entities_v2.id",
    w8c: "text → 'company:{jurisdiction}:{number}' | 'person:{opaque}'",
    crosswalk: "none_proven",
  },
});

async function readOnlyQuery(sql, params = [], timeoutMs = 8_000) {
  if (!/^\s*(with|select)\b/i.test(sql)) {
    throw new Error("w8c_read_only_violation: only SELECT statements are permitted");
  }
  const client = await getPgPool().connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${Math.trunc(timeoutMs)}`);
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

function normalizeForAgreement(value) {
  const normalized = normalizeEntityName(String(value ?? ""));
  return normalized && normalized.length >= 3 ? normalized : null;
}

/**
 * REI's own buyer-match output for a property. Read-only, and deliberately
 * limited to the columns needed for a count/name comparison.
 */
async function readReiCandidates(query, propertyId) {
  try {
    const { rows } = await query(
      `SELECT c.buyer_entity_id, c.buyer_display_name, c.buyer_type,
              c.match_grade, c.match_score, e.buyer_key, e.normalized_buyer_name
         FROM public.buyer_match_candidates c
         LEFT JOIN public.buyer_entities_v2 e ON e.id = c.buyer_entity_id
        WHERE c.property_id = $1
        ORDER BY c.match_score DESC NULLS LAST
        LIMIT 200`,
      [String(propertyId)],
    );
    return {
      available: true,
      candidateCount: rows.length,
      buyers: rows.map((r) => ({
        reiBuyerEntityId: r.buyer_entity_id,   // uuid — NOT a W8C buyer_entity_id
        reiBuyerKey: r.buyer_key ?? null,
        displayName: r.buyer_display_name ?? null,
        normalizedBuyerName: r.normalized_buyer_name ?? null,
        buyerType: r.buyer_type ?? null,
        matchGrade: r.match_grade ?? null,
        matchScore: r.match_score === null || r.match_score === undefined ? null : Number(r.match_score),
      })),
    };
  } catch (error) {
    return { available: false, reason: `rei_unavailable:${error?.code ?? "unknown"}`, candidateCount: 0, buyers: [] };
  }
}

/**
 * How many distinct entities on each side carry a given normalized name.
 * A name held by more than one entity cannot identify anybody, so we check the
 * whole population rather than just the two rosters being compared.
 */
/**
 * SQL mirror of normalizeEntityName() from transactionClustering.js. Postgres
 * uses \y rather than \b for word boundaries; the alternation is otherwise
 * identical, so both sides collapse names the same way.
 */
const SQL_NORMALIZE = (expr) => `
  trim(regexp_replace(
    regexp_replace(
      regexp_replace(lower(coalesce(${expr},'')), '[.,#&''"\`]', ' ', 'g'),
      '\\y(llc|l\\.l\\.c|inc|incorporated|corp|corporation|co|company|lp|l\\.p|llp|ltd|limited|trust|tr|holdings|properties|property|investments|invest|capital|group|partners|enterprises|homes|realty|management|mgmt|fund|reit)\\y', ' ', 'g'),
    '\\s+', ' ', 'g'))`;

/**
 * How many distinct entities on each side carry a given normalized name.
 * A name held by more than one entity cannot identify anybody, so this counts
 * the whole population rather than just the two rosters being compared.
 */
async function readNameAmbiguity(query, names) {
  if (!names.length) return new Map();
  try {
    const { rows } = await query(
      `WITH n(name) AS (SELECT unnest($1::text[])),
            w AS (SELECT ${SQL_NORMALIZE("s.display_name")} AS nm, s.buyer_entity_id
                    FROM reivesti.buyer_summary s
                   WHERE s.entity_type = 'company' AND s.display_name IS NOT NULL),
            r AS (SELECT ${SQL_NORMALIZE("coalesce(e.normalized_buyer_name, e.buyer_name)")} AS nm, e.id
                    FROM public.buyer_entities_v2 e
                   WHERE coalesce(e.normalized_buyer_name, e.buyer_name) IS NOT NULL)
       SELECT n.name,
              (SELECT count(DISTINCT w.buyer_entity_id) FROM w WHERE w.nm = n.name) AS w8c_matches,
              (SELECT count(DISTINCT r.id) FROM r WHERE r.nm = n.name) AS rei_matches
         FROM n`,
      [names],
    );
    return new Map(rows.map((r) => [r.name, { w8c: Number(r.w8c_matches), rei: Number(r.rei_matches) }]));
  } catch {
    // Ambiguity unknown → every pair is treated as ambiguous downstream.
    return new Map();
  }
}

/**
 * @param {string|number} propertyId REI/W8C shared property id
 * @param {object} [deps] { query, w8c } for injection in tests
 */
export async function compareBuyerIntelligenceForProperty(propertyId, deps = {}) {
  const query = deps.query ?? readOnlyQuery;
  const w8cClient = deps.w8c ?? createW8cClient(deps.query ? { query: deps.query } : {});

  const base = {
    source: COMPARISON_SOURCE,
    observationalOnly: true,
    influencesPricingOrTargeting: false,
    propertyId: String(propertyId ?? ""),
    namespaces: IDENTITY_NAMESPACES,
  };

  if (!propertyId) return { ...base, available: false, reason: "missing_property_id" };

  const [shadow, rei] = await Promise.all([
    w8cClient.getShadowIntelligenceForProperty(propertyId, { limit: deps.limit ?? 25 }),
    readReiCandidates(query, propertyId),
  ]);

  // W8C company names present on this property, for the weak agreement check.
  const w8cCompanies = (shadow.buyers ?? [])
    .filter((b) => b.summary?.entityType === "company" && b.summary?.displayName)
    .map((b) => ({ w8cBuyerEntityId: b.buyerEntityId, name: b.summary.displayName, normalized: normalizeForAgreement(b.summary.displayName) }))
    .filter((b) => b.normalized);

  const reiCompanies = (rei.buyers ?? [])
    .map((b) => ({ ...b, normalized: normalizeForAgreement(b.normalizedBuyerName ?? b.displayName) }))
    .filter((b) => b.normalized);

  const candidateNames = [...new Set(w8cCompanies.map((c) => c.normalized))]
    .filter((n) => reiCompanies.some((r) => r.normalized === n));
  const ambiguity = candidateNames.length ? await readNameAmbiguity(query, candidateNames) : new Map();

  const nameAgreement = [];
  for (const name of candidateNames) {
    const counts = ambiguity.get(name) ?? { w8c: null, rei: null };
    const ambiguous = counts.w8c === null || counts.rei === null || counts.w8c > 1 || counts.rei > 1;
    for (const w of w8cCompanies.filter((c) => c.normalized === name)) {
      for (const r of reiCompanies.filter((c) => c.normalized === name)) {
        nameAgreement.push({
          normalizedName: name,
          w8cBuyerEntityId: w.w8cBuyerEntityId,
          reiBuyerEntityId: r.reiBuyerEntityId,
          reiBuyerKey: r.reiBuyerKey,
          basis: "company_legal_name_agreement",
          isIdentity: false,
          ambiguous,
          populationMatches: counts,
          note: ambiguous
            ? "name is held by more than one entity on at least one side — not usable as identity"
            : "unique on both sides in this population, but still name agreement, not a proven crosswalk",
        });
      }
    }
  }

  // Both systems are in scope from here on, so W8C buyer IDs are renamed to
  // w8cBuyerEntityId. A bare `buyerEntityId` next to REI's `reiBuyerEntityId`
  // reads like the same namespace, and it is not.
  const w8cBuyers = (shadow.buyers ?? []).map(({ buyerEntityId, ...rest }) => ({
    w8cBuyerEntityId: buyerEntityId,
    ...rest,
    acquisitions: (rest.acquisitions ?? []).map(({ buyerEntityId: acqId, ...acq }) => ({
      w8cBuyerEntityId: acqId,
      ...acq,
    })),
  }));

  const envelope = {
    ...base,
    available: shadow.available || rei.available,
    w8c: shadow.available
      ? { available: true, version: shadow.version, buyerCount: shadow.buyerCount, buyers: w8cBuyers }
      : { available: false, reason: shadow.reason, buyerCount: 0, buyers: [] },
    rei,
    comparison: {
      // Coverage, not agreement. Neither side is treated as ground truth.
      w8cKnowsProperty: Boolean(shadow.available && shadow.buyerCount > 0),
      reiKnowsProperty: Boolean(rei.available && rei.candidateCount > 0),
      bothKnowProperty: Boolean(shadow.available && shadow.buyerCount > 0 && rei.available && rei.candidateCount > 0),
      w8cBuyerCount: shadow.available ? shadow.buyerCount : 0,
      reiCandidateCount: rei.available ? rei.candidateCount : 0,
      personBuyersUnmatchable: (shadow.buyers ?? []).filter((b) => b.summary?.entityType === "person").length,
      nameAgreement,
      identityOverlap: {
        count: 0,
        reason: "buyer identity namespaces are disjoint and no crosswalk is proven",
      },
    },
  };

  // The comparison envelope is caller-facing, so raw person IDs are stripped
  // here rather than relying on the route to remember. Redaction is idempotent,
  // so the route shielding it again costs nothing.
  return redactShadowEnvelope(envelope);
}

export default compareBuyerIntelligenceForProperty;
