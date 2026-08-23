/**
 * W8C Buyer Intelligence — read-only shadow client.
 *
 * The ONLY sanctioned way for REI Automation to read W8C. Every statement here
 * targets the approved `reivesti.buyer_*` / `reivesti.property_historical_buyers`
 * serving views. `comp_private.w8c_*` is never referenced from application code,
 * and `assertServingLayerOnly()` enforces that at runtime.
 *
 * TRANSPORT: direct Postgres, not PostgREST. This is not a style preference —
 * the project exposes only `public` and `graphql_public` to PostgREST, so
 * `supabase.schema('reivesti')` fails with PGRST106 no matter what grants exist.
 * Reaching the views through the REST client would require widening the
 * project's public API surface, so we use the existing `pg` pool instead.
 *
 * W8C is OBSERVATIONAL. Nothing here may influence MAO, offer price, offer
 * generation, campaign targeting, outreach, send_queue, suppressions, seller
 * priority, or autonomous execution. Every statement runs inside a
 * `BEGIN READ ONLY` transaction, so a write is refused by the database itself
 * rather than merely being absent from the code.
 *
 * PRIVACY, exactly as the serving layer defines it:
 *   - natural-person names are never exposed; `displayName` is company-only
 *   - buyer entity IDs are OPAQUE — never parse them, they are not names
 *   - no individual_key, phone, email, contact payload or raw provider payload
 *   - `property_historical_buyers` is service-role only; a per-property buyer
 *     roster is re-identifying and must not reach an untrusted client
 *
 * AVAILABILITY: no accessor throws. A missing database URL, an unpromoted run,
 * a revoked grant or a dead connection all resolve to `{ available: false }`.
 * W8C being unavailable must never break a seller workflow.
 */

import { createHash } from "node:crypto";

import { hasDatabaseUrl, getPgPool } from "@/lib/postgres/client.js";

export const W8C_SOURCE = "shadow_buyer_intelligence";
const SCHEMA = "reivesti";
const DEFAULT_TIMEOUT_MS = 8_000;

export const W8C_VIEWS = Object.freeze({
  version: "buyer_intelligence_version",
  summary: "buyer_summary",
  behavior: "buyer_behavior",
  buybox: "buyer_buybox",
  companyLinks: "buyer_company_links",
  propertyHistoricalBuyers: "property_historical_buyers",
});

/** Views that require the service role and must not reach an untrusted client. */
export const SERVICE_ROLE_ONLY_VIEWS = Object.freeze(["property_historical_buyers"]);

/** Columns the serving layer withholds. Referencing one is a privacy defect. */
const FORBIDDEN_SQL_PATTERNS = [
  /comp_private/i,
  /individual_key/i,
  /\bphone\b/i,
  /\bemail\b/i,
  /owner_name/i,
  /raw_payload/i,
];

/**
 * Defense in depth. The serving views already withhold these, but a future edit
 * that reaches past them should fail loudly here instead of quietly leaking.
 */
export function assertServingLayerOnly(sql) {
  for (const pattern of FORBIDDEN_SQL_PATTERNS) {
    if (pattern.test(sql)) {
      throw new Error(`w8c_privacy_violation: query references ${pattern}`);
    }
  }
  if (!new RegExp(`\\b${SCHEMA}\\.`, "i").test(sql)) {
    throw new Error("w8c_privacy_violation: query does not target the reivesti serving layer");
  }
  if (!/^\s*(with|select)\b/i.test(sql)) {
    throw new Error("w8c_read_only_violation: only SELECT statements are permitted");
  }
  return true;
}

/** Every W8C read runs inside a database-enforced read-only transaction. */
async function defaultQuery(sql, params = [], timeoutMs = DEFAULT_TIMEOUT_MS) {
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

function unavailable(reason, extra = {}) {
  return { available: false, source: W8C_SOURCE, reason, ...extra };
}

const num = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * @param {object} [deps]
 * @param {(sql: string, params: any[], timeoutMs: number) => Promise<{rows: any[]}>} [deps.query]
 * @param {boolean} [deps.enabled] explicit kill switch
 */
export function createW8cClient(deps = {}) {
  const query = deps.query ?? defaultQuery;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const enabled =
    deps.enabled ??
    (!/^(0|false|off)$/i.test(String(process.env.W8C_SHADOW_INTELLIGENCE_ENABLED ?? "1")) &&
      (deps.query ? true : hasDatabaseUrl()));

  async function run(sql, params = []) {
    if (!enabled) return { ok: false, reason: "w8c_shadow_disabled", rows: [] };
    try {
      assertServingLayerOnly(sql);
    } catch (error) {
      // A privacy/read-only violation is a programming error, not a data
      // condition. Surface it rather than degrading silently.
      throw error;
    }
    try {
      const result = await query(sql, params, timeoutMs);
      return { ok: true, rows: result?.rows ?? [] };
    } catch (error) {
      const code = error?.code ? String(error.code) : "unknown";
      // 42P01 undefined_table, 42501 insufficient_privilege, 3D000/28P01 connection
      return { ok: false, reason: `w8c_unavailable:${code}`, rows: [] };
    }
  }

  /** Which W8C run the serving layer is pinned to. No promoted run is a legitimate state. */
  async function getVersion() {
    const res = await run(
      `SELECT run_id, model_version, w8a_params_version, w8b_params_version,
              git_sha, completed_at, row_counts
         FROM ${SCHEMA}.${W8C_VIEWS.version} LIMIT 1`,
    );
    if (!res.ok) return unavailable(res.reason);
    const row = res.rows[0];
    if (!row) return unavailable("no_current_w8c_run");
    return {
      available: true,
      source: W8C_SOURCE,
      runId: row.run_id,
      modelVersion: row.model_version,
      w8aVersion: row.w8a_params_version,
      w8bVersion: row.w8b_params_version,
      gitSha: row.git_sha,
      completedAt: row.completed_at ?? null,
      rowCounts: row.row_counts ?? null,
    };
  }

  async function getBuyerSummary(buyerEntityId) {
    if (!buyerEntityId) return unavailable("missing_buyer_entity_id");
    const res = await run(
      `SELECT * FROM ${SCHEMA}.${W8C_VIEWS.summary} WHERE buyer_entity_id = $1 LIMIT 1`,
      [buyerEntityId],
    );
    if (!res.ok) return unavailable(res.reason);
    const row = res.rows[0];
    if (!row) return unavailable("buyer_not_in_w8c", { buyerEntityId });
    return { available: true, source: W8C_SOURCE, ...mapSummary(row) };
  }

  async function getBuyerBehavior(buyerEntityId) {
    if (!buyerEntityId) return unavailable("missing_buyer_entity_id");
    const res = await run(
      `SELECT * FROM ${SCHEMA}.${W8C_VIEWS.behavior} WHERE buyer_entity_id = $1 LIMIT 1`,
      [buyerEntityId],
    );
    if (!res.ok) return unavailable(res.reason);
    const row = res.rows[0];
    if (!row) return unavailable("buyer_not_in_w8c", { buyerEntityId });
    return { available: true, source: W8C_SOURCE, ...mapBehavior(row) };
  }

  /**
   * Derived buybox. Absence means INSUFFICIENT EVIDENCE (fewer than three
   * canonical acquisitions) — it never means "buys anything". Only 528 of
   * 40,487 buyers clear the bar.
   */
  async function getBuyerBuybox(buyerEntityId) {
    if (!buyerEntityId) return unavailable("missing_buyer_entity_id");
    const res = await run(
      `SELECT * FROM ${SCHEMA}.${W8C_VIEWS.buybox} WHERE buyer_entity_id = $1 LIMIT 1`,
      [buyerEntityId],
    );
    if (!res.ok) return unavailable(res.reason);
    const row = res.rows[0];
    if (!row) {
      return { available: false, source: W8C_SOURCE, reason: "insufficient_evidence", buyerEntityId, hasBuybox: false };
    }
    return { available: true, source: W8C_SOURCE, hasBuybox: true, ...mapBuybox(row) };
  }

  /** Canonical principal↔company relationships. Principal IDs stay opaque. */
  async function getBuyerCompanyLinks({ companyEntityId, principalEntityId } = {}) {
    if (!companyEntityId && !principalEntityId) return unavailable("missing_entity_id");
    const res = await run(
      `SELECT * FROM ${SCHEMA}.${W8C_VIEWS.companyLinks}
        WHERE ($1::text IS NULL OR company_entity_id = $1)
          AND ($2::text IS NULL OR principal_entity_id = $2)`,
      [companyEntityId ?? null, principalEntityId ?? null],
    );
    if (!res.ok) return unavailable(res.reason);
    return {
      available: true,
      source: W8C_SOURCE,
      links: res.rows.map((row) => ({
        principalEntityId: row.principal_entity_id,
        companyEntityId: row.company_entity_id,
        officerRole: row.officer_role ?? null,
        relationshipType: row.relationship_type ?? null,
        confidence: num(row.confidence),
        matchBasis: row.match_basis ?? null,
      })),
    };
  }

  /**
   * Canonical historical buyers of a property.
   * SERVICE ROLE ONLY — do not hand this to an untrusted client.
   */
  async function getPropertyHistoricalBuyers(propertyId, { limit = 50 } = {}) {
    if (!propertyId) return unavailable("missing_property_id");
    const res = await run(
      `SELECT * FROM ${SCHEMA}.${W8C_VIEWS.propertyHistoricalBuyers}
        WHERE property_id = $1
        ORDER BY acquired_on DESC NULLS LAST
        LIMIT $2`,
      [String(propertyId), Math.max(1, Math.min(500, Number(limit) || 50))],
    );
    if (!res.ok) return unavailable(res.reason, { propertyId: String(propertyId) });
    return {
      available: true,
      source: W8C_SOURCE,
      serviceRoleOnly: true,
      propertyId: String(propertyId),
      buyers: res.rows.map((row) => ({
        buyerEntityId: row.buyer_entity_id,
        buyerRole: row.buyer_role,
        entityType: row.entity_type,
        displayName: row.entity_type === "company" ? (row.display_name ?? null) : null,
        resolutionMethod: row.resolution_method ?? null,
        confidence: num(row.confidence),
        acquiredOn: row.acquired_on ?? null,
        acquisitionPrice: num(row.acquisition_price),
      })),
    };
  }

  /**
   * Batched lookups keyed by buyer id.
   *
   * These exist so a property panel costs a FIXED number of statements. Fetching
   * summary/behavior/buybox per buyer was an N+1: a property with 4 canonical
   * buyers issued 12 statements just for enrichment. Set-oriented reads make it
   * 3 regardless of buyer count, with byte-identical output.
   */
  async function fetchByIds(view, ids) {
    if (!ids.length) return new Map();
    const res = await run(
      `SELECT * FROM ${SCHEMA}.${view} WHERE buyer_entity_id = ANY($1::text[])`,
      [ids],
    );
    if (!res.ok) return null; // unavailable, distinct from "found nothing"
    return new Map(res.rows.map((row) => [row.buyer_entity_id, row]));
  }

  /** Everything W8C knows about one property, as a single labelled envelope. */
  async function getShadowIntelligenceForProperty(propertyId, { limit = 25 } = {}) {
    const version = await getVersion();
    if (!version.available) {
      return { source: W8C_SOURCE, available: false, reason: version.reason, propertyId: String(propertyId ?? ""), buyers: [] };
    }
    const historical = await getPropertyHistoricalBuyers(propertyId, { limit });
    if (!historical.available) {
      return { source: W8C_SOURCE, available: false, reason: historical.reason, version, propertyId: String(propertyId ?? ""), buyers: [] };
    }
    const ids = [...new Set(historical.buyers.map((b) => b.buyerEntityId))];
    const [summaries, behaviors, buyboxes] = await Promise.all([
      fetchByIds(W8C_VIEWS.summary, ids),
      fetchByIds(W8C_VIEWS.behavior, ids),
      fetchByIds(W8C_VIEWS.buybox, ids),
    ]);

    const buyers = ids.map((id) => {
      const summaryRow = summaries?.get(id);
      const behaviorRow = behaviors?.get(id);
      const buyboxRow = buyboxes?.get(id);
      // A missing buybox ROW means insufficient evidence; a failed READ means
      // unavailable. The two must not collapse into one another.
      const buyboxStatus = buyboxRow
        ? "derived"
        : buyboxes === null
          ? "w8c_unavailable"
          : "insufficient_evidence";
      return {
        buyerEntityId: id,
        summary: summaryRow ? { available: true, source: W8C_SOURCE, ...mapSummary(summaryRow) } : null,
        behavior: behaviorRow ? { available: true, source: W8C_SOURCE, ...mapBehavior(behaviorRow) } : null,
        buybox: buyboxRow ? { available: true, source: W8C_SOURCE, hasBuybox: true, ...mapBuybox(buyboxRow) } : null,
        buyboxStatus,
        acquisitions: historical.buyers.filter((b) => b.buyerEntityId === id),
      };
    });
    return {
      source: W8C_SOURCE,
      available: true,
      observationalOnly: true,
      propertyId: String(propertyId),
      version,
      buyerCount: buyers.length,
      buyers,
    };
  }

  return {
    enabled,
    getVersion,
    getBuyerSummary,
    getBuyerBehavior,
    getBuyerBuybox,
    getBuyerCompanyLinks,
    getPropertyHistoricalBuyers,
    getShadowIntelligenceForProperty,
  };
}

/**
 * Person buyer entity IDs are NOT opaque: W8A mints them as
 * `person:{individual_key}`, so the ID embeds the identifier verbatim. The
 * serving layer's own guard says as much ("buyer_entity_id embeds
 * individual_key for people; anon must not read it"), which is why every W8C
 * view is revoked from anon.
 *
 * Anything that externalises a buyer ID — a UI, an API response, a log line —
 * must pass it through here first. Company IDs are registry identifiers and
 * pass through unchanged; person IDs become a stable, non-reversible handle
 * that still supports "is this the same buyer?" comparisons.
 */
export function redactBuyerEntityId(buyerEntityId) {
  const id = String(buyerEntityId ?? "");
  if (!id.startsWith("person:")) return id || null;
  if (id.startsWith("person:anon_")) return id; // already redacted — idempotent
  const digest = createHash("sha256").update(id).digest("hex").slice(0, 16);
  return `person:anon_${digest}`;
}

/**
 * Matches a raw person entity ID anywhere inside a string.
 *
 * Keyed redaction alone is not enough: a raw ID can ride out inside a `reason`
 * string, a Postgres error message that echoes a bound parameter, or a key some
 * future edit spells differently. Matching on the VALUE closes those routes.
 *
 * The negative lookahead keeps redaction idempotent — an already-anonymised ID
 * is left alone rather than hashed a second time. `person:seller:{key}` (the
 * W8A.2 provisional form) is captured whole, so it anonymises too.
 */
const RAW_PERSON_ID_PATTERN = /person:(?!anon_)[A-Za-z0-9_:.-]+/g;

/** Replace every raw person ID inside an arbitrary string. */
export function scrubPersonIds(value) {
  if (typeof value !== "string" || !value) return value;
  return value.replace(RAW_PERSON_ID_PATTERN, (match) => redactBuyerEntityId(match));
}

/**
 * Redact person IDs throughout any payload before it leaves the server.
 *
 * Scrubs every string value (and every object key) at any depth, so this is
 * safe for responses, error envelopes, log payloads and telemetry alike.
 * Returns a copy; the input is never mutated.
 */
export function redactShadowEnvelope(payload) {
  if (typeof payload === "string") return scrubPersonIds(payload);
  if (!payload || typeof payload !== "object") return payload;

  const seen = new WeakMap();
  const walk = (node) => {
    if (typeof node === "string") return scrubPersonIds(node);
    if (!node || typeof node !== "object") return node;
    if (node instanceof Date) return node;
    if (seen.has(node)) return seen.get(node); // tolerate cycles
    if (Array.isArray(node)) {
      const arr = [];
      seen.set(node, arr);
      for (const item of node) arr.push(walk(item));
      return arr;
    }
    const out = {};
    seen.set(node, out);
    for (const [key, value] of Object.entries(node)) {
      out[scrubPersonIds(key)] = walk(value);
    }
    return out;
  };
  return walk(payload);
}

export function mapSummary(row = {}) {
  return {
    buyerEntityId: row.buyer_entity_id,
    entityType: row.entity_type,
    // NULL for natural persons by design. Never infer or backfill a name.
    displayName: row.entity_type === "company" ? (row.display_name ?? null) : null,
    jurisdictionCode: row.jurisdiction_code ?? null,
    companyNumber: row.company_number ?? null,
    identityConfidence: num(row.identity_confidence),
    identityMethod: row.identity_method ?? null,
    acquisitionCount: num(row.acquisition_count),
    firstAcquisition: row.first_acquisition ?? null,
    lastAcquisition: row.last_acquisition ?? null,
    daysSinceLast: num(row.days_since_last),
    activityStatus: row.activity_status ?? null,
    activityScore: num(row.activity_score),
    archetype: row.archetype ?? null,
    behaviorConfidence: num(row.behavior_confidence),
    hasBuybox: Boolean(row.has_buybox),
    modelVersion: row.model_version ?? null,
  };
}

export function mapBehavior(row = {}) {
  return {
    buyerEntityId: row.buyer_entity_id,
    acquisitionCount: num(row.acquisition_count),
    datableAcquisitions: num(row.datable_acquisitions),
    dispositionCount: num(row.disposition_count),
    firstAcquisition: row.first_acquisition ?? null,
    lastAcquisition: row.last_acquisition ?? null,
    daysSinceLast: num(row.days_since_last),
    trailing90d: num(row.trailing_90d),
    trailing180d: num(row.trailing_180d),
    trailing365d: num(row.trailing_365d),
    acquisitionsPerYear: num(row.acquisitions_per_year),
    activityStatus: row.activity_status ?? null,
    activityScore: num(row.activity_score),
    activityComponents: row.activity_components ?? null,
    geographyProfile: row.geography_profile ?? null,
    assetProfile: row.asset_profile ?? null,
    priceProfile: row.price_profile ?? null,
    characteristicProfile: row.characteristic_profile ?? null,
    holdFlipClassification: row.hold_flip_classification ?? null,
    holdFlipProfile: row.hold_flip_profile ?? null,
    archetype: row.archetype ?? null,
    archetypeReasons: row.archetype_reasons ?? [],
    evidenceCount: num(row.evidence_count),
    evidenceCoverage: num(row.evidence_coverage),
    confidence: num(row.confidence),
    windowStart: row.window_start ?? null,
    windowEnd: row.window_end ?? null,
    // 'empty' means we asked and the buyer holds nothing — that is EVIDENCE.
    // 'unknown' means we never asked, which is also the honest label for the
    // 24,637 companies: portfolio capture is person-scoped, so they have no row.
    portfolioState: row.portfolio_state ?? "unknown",
    portfolioPropertyCount: num(row.portfolio_property_count),
    inCorpusHoldings: num(row.in_corpus_holdings),
    outOfCorpusHoldings: num(row.out_of_corpus_holdings),
    portfolioCapturedAt: row.portfolio_captured_at ?? null,
    modelVersion: row.model_version ?? null,
  };
}

export function mapBuybox(row = {}) {
  return {
    buyerEntityId: row.buyer_entity_id,
    evidenceDepth: num(row.evidence_depth),
    preferredCounties: row.preferred_counties ?? [],
    acceptableStates: row.acceptable_states ?? [],
    preferredAssetFamilies: row.preferred_asset_families ?? [],
    priceLow: num(row.price_low),
    priceHigh: num(row.price_high),
    priceBasis: row.price_basis ?? null,
    // The robust band is the one to filter on: 82.26% coverage on the W8B
    // temporal holdout versus 36.93% for the p25-p75 core band.
    priceRobustLow: num(row.price_robust_low),
    priceRobustHigh: num(row.price_robust_high),
    buildingSqftP25: num(row.building_sqft_p25),
    buildingSqftP75: num(row.building_sqft_p75),
    unitsP25: num(row.units_p25),
    unitsP75: num(row.units_p75),
    recencyWindowDays: num(row.recency_window_days),
    recencyWeightingApplied: Boolean(row.recency_weighting_applied),
    confidence: num(row.confidence),
    windowStart: row.window_start ?? null,
    windowEnd: row.window_end ?? null,
    modelVersion: row.model_version ?? null,
  };
}

export default createW8cClient;
