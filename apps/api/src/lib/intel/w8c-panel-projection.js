/**
 * Projection of W8C shadow intelligence into the bounded payload the property
 * Buyer Intelligence panel renders.
 *
 * OBSERVATIONAL ONLY. Nothing produced here may influence buyer-match ranking
 * or scores, MAO, offer pricing, offers, seller priority, campaigns, outreach,
 * suppressions, send_queue, or autonomous workflows. It is display data.
 *
 * Why an explicit projection instead of forwarding the client envelope:
 *
 *  1. PRIVACY. The behaviour rows carry jsonb profiles whose `provenance`
 *     arrays name internal sources (e.g. "comp_private", raw column paths).
 *     Those must not reach a browser, so every field below is named
 *     individually — raw jsonb is never passed through.
 *  2. BOUNDEDNESS. A full behaviour row is large; the panel needs a handful of
 *     scalars per buyer.
 *  3. PERSON IDS. The comparator has already redacted them to
 *     `person:anon_<hash>`; keeping one projection point makes that auditable.
 *
 * `property_historical_buyers` is service-role only, so this runs server-side
 * exclusively and the panel receives only the sanitized subset below.
 */

import { compareBuyerIntelligenceForProperty } from "./w8c-shadow-comparison.js";
import { W8C_SOURCE } from "./w8c-buyer-intelligence.js";
import { loadFitCandidates, loadSubjectProperty } from "./w8c-fit-candidates.js";
import { normalizeSubject, rankBuyerFits } from "./w8c-buyer-fit-evaluator.js";

export const PANEL_LABEL = "Buyer Intelligence — Shadow";

/** Panel-level states. Uncertainty is a state, not an absence. */
export const PANEL_STATUS = Object.freeze({
  AVAILABLE: "available",
  NO_HISTORY: "no_canonical_buyer_history",
  UNAVAILABLE: "unavailable",
});

const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
const pct = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 1000) / 10);

/** Pull a named scalar out of a jsonb profile without forwarding the profile. */
const pick = (profile, ...path) => {
  let node = profile;
  for (const key of path) {
    if (!node || typeof node !== "object") return null;
    node = node[key];
  }
  return node === undefined ? null : node;
};

/** Top N entries of a W8B `[[label, count, share], ...]` distribution. */
function topEntries(list, limit = 3) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((entry) => Array.isArray(entry) && entry.length >= 2)
    .slice(0, limit)
    .map(([label, count, share]) => ({
      label: String(label),
      count: num(count),
      sharePct: share === undefined ? null : pct(share),
    }));
}

function projectBehavior(behavior) {
  if (!behavior) return null;
  return {
    acquisitionCount: num(behavior.acquisitionCount),
    dispositionCount: num(behavior.dispositionCount),
    firstAcquisition: behavior.firstAcquisition ?? null,
    lastAcquisition: behavior.lastAcquisition ?? null,
    daysSinceLast: num(behavior.daysSinceLast),
    trailing365d: num(behavior.trailing365d),
    acquisitionsPerYear: num(behavior.acquisitionsPerYear),
    activityStatus: behavior.activityStatus ?? null,
    activityScore: num(behavior.activityScore),
    archetype: behavior.archetype ?? null,
    archetypeReasons: Array.isArray(behavior.archetypeReasons) ? behavior.archetypeReasons.slice(0, 4) : [],

    holdFlip: {
      classification: behavior.holdFlipClassification ?? null,
      medianHoldDays: num(pick(behavior.holdFlipProfile, "median_hold_days")),
      dispositions: num(pick(behavior.holdFlipProfile, "dispositions")),
      dispositionRatePct: pct(pick(behavior.holdFlipProfile, "disposition_rate")),
      // Hold/flip is often inferred from a thin slice of the record; surfacing
      // its own confidence stops a 9%-coverage signal reading as settled fact.
      confidence: num(pick(behavior.holdFlipProfile, "confidence")),
    },

    geography: {
      primaryMarkets: (pick(behavior.geographyProfile, "primary_markets") ?? []).slice(0, 3),
      topCounties: topEntries(pick(behavior.geographyProfile, "counties")),
      distinctCounties: num(pick(behavior.geographyProfile, "distinct_counties")),
      distinctStates: num(pick(behavior.geographyProfile, "distinct_states")),
      concentrationIndex: num(pick(behavior.geographyProfile, "concentration_index")),
    },

    priceMedian: num(
      pick(behavior.priceProfile, "recent_365d", "median") ?? pick(behavior.priceProfile, "lifetime", "p50"),
    ),
    cashSharePct: pct(pick(behavior.priceProfile, "cash_share")),

    // 'empty' means we asked and the buyer holds nothing — that is evidence.
    // 'unknown' means we never asked (portfolio capture is person-scoped, so
    // every company reads unknown). The panel must not conflate them.
    portfolioState: behavior.portfolioState ?? "unknown",
    portfolioPropertyCount: num(behavior.portfolioPropertyCount),
    inCorpusHoldings: num(behavior.inCorpusHoldings),
    outOfCorpusHoldings: num(behavior.outOfCorpusHoldings),

    evidenceCount: num(behavior.evidenceCount),
    evidenceCoveragePct: pct(behavior.evidenceCoverage),
    confidence: num(behavior.confidence),
  };
}

function projectBuybox(buybox) {
  if (!buybox) return null;
  return {
    evidenceDepth: num(buybox.evidenceDepth),
    preferredCounties: (buybox.preferredCounties ?? []).slice(0, 4),
    acceptableStates: (buybox.acceptableStates ?? []).slice(0, 6),
    preferredAssetFamilies: (buybox.preferredAssetFamilies ?? []).slice(0, 4),

    // The robust band is the primary range: it covered 82.26% of held-out
    // acquisitions on the W8B temporal backtest versus 36.93% for p25-p75.
    // The core band is retained as secondary context only — the UI must not
    // present it as the recommended filter.
    priceRobustLow: num(buybox.priceRobustLow),
    priceRobustHigh: num(buybox.priceRobustHigh),
    priceCoreLow: num(buybox.priceLow),
    priceCoreHigh: num(buybox.priceHigh),
    priceBasis: buybox.priceBasis ?? null,

    buildingSqftP25: num(buybox.buildingSqftP25),
    buildingSqftP75: num(buybox.buildingSqftP75),
    unitsP25: num(buybox.unitsP25),
    unitsP75: num(buybox.unitsP75),
    recencyWeightingApplied: Boolean(buybox.recencyWeightingApplied),
    confidence: num(buybox.confidence),
  };
}

function projectBuyer(buyer) {
  const acquisitions = (buyer.acquisitions ?? []).map((a) => ({
    buyerRole: a.buyerRole ?? null,
    acquiredOn: a.acquiredOn ?? null,
    acquisitionPrice: num(a.acquisitionPrice),
    resolutionMethod: a.resolutionMethod ?? null,
    confidence: num(a.confidence),
  }));

  const strongest = acquisitions.reduce(
    (best, a) => ((a.confidence ?? 0) > (best?.confidence ?? -1) ? a : best),
    null,
  );

  return {
    // Already redacted upstream: company registry id, or person:anon_<hash>.
    buyerRef: buyer.w8cBuyerEntityId,
    entityType: buyer.summary?.entityType ?? acquisitions[0]?.entityType ?? "unknown",
    // Company names only. Natural-person names are never exposed by W8C.
    displayName: buyer.summary?.displayName ?? null,
    identityConfidence: num(buyer.summary?.identityConfidence),
    identityMethod: buyer.summary?.identityMethod ?? null,
    resolutionMethod: strongest?.resolutionMethod ?? null,
    resolutionConfidence: strongest?.confidence ?? null,
    occurrenceCount: acquisitions.length,
    acquisitions,
    behavior: projectBehavior(buyer.behavior),
    buybox: projectBuybox(buyer.buybox),
    buyboxStatus: buyer.buyboxStatus ?? "unavailable",
  };
}

/**
 * Observational side-by-side with REI's own buyer-match candidates.
 *
 * The two buyer namespaces are disjoint, so a REI candidate cannot be resolved
 * to a W8C buyer. What CAN be stated honestly is reported here: whether W8C has
 * evidence for the PROPERTY, and whether a company-name agreement was observed
 * for the candidate — always flagged as non-identity, with its ambiguity.
 */
function projectComparison(comparison, w8cBuyersById) {
  const rei = comparison.rei ?? {};
  const agreements = comparison.comparison?.nameAgreement ?? [];

  const rows = (rei.buyers ?? []).map((candidate) => {
    const matches = agreements.filter((a) => a.reiBuyerEntityId === candidate.reiBuyerEntityId);
    const unambiguous = matches.find((a) => !a.ambiguous) ?? null;
    const linked = unambiguous ? w8cBuyersById.get(unambiguous.w8cBuyerEntityId) : null;

    return {
      reiBuyerEntityId: candidate.reiBuyerEntityId,
      displayName: candidate.displayName ?? null,
      matchGrade: candidate.matchGrade ?? null,
      matchScore: num(candidate.matchScore),
      // Property-level facts — true regardless of buyer identity.
      w8cPropertyEvidence: Boolean(comparison.comparison?.w8cKnowsProperty),
      // Name-agreement observations. NEVER an identity assertion.
      nameAgreementObserved: matches.length > 0,
      nameAgreementAmbiguous: matches.length > 0 && !unambiguous,
      identityConfirmed: false,
      linkedByNameOnly: unambiguous
        ? {
            basis: unambiguous.basis,
            isIdentity: false,
            w8cBuyboxAvailable: Boolean(linked?.buybox),
            w8cBehaviorConfidence: num(linked?.behavior?.confidence),
          }
        : null,
    };
  });

  return {
    available: Boolean(rei.available),
    candidateCount: num(rei.candidateCount) ?? 0,
    rows,
    namespacesSeparate: true,
    note: "REI and W8C buyer identities are separate namespaces. Name agreement is an observational lead, not a confirmed identity match.",
  };
}

/**
 * Observed Buybox Fits: which evidenced W8C buyers best match this subject.
 *
 * Shadow ranking only — it orders nothing outside this payload. Returns a
 * labelled unavailable/not-evaluable state rather than an empty list when the
 * subject or candidate population cannot support an evaluation.
 */
export async function buildObservedFits(propertyId, deps = {}) {
  const limit = deps.fitLimit ?? 8;
  const [subjectRes, candidateRes] = await Promise.all([
    loadSubjectProperty(propertyId, deps),
    loadFitCandidates(deps),
  ]);

  if (!candidateRes.available) {
    return { available: false, reason: candidateRes.reason ?? "w8c_unavailable", fits: [] };
  }
  if (!subjectRes.available) {
    return { available: false, reason: subjectRes.reason ?? "subject_unavailable", fits: [] };
  }

  const subject = normalizeSubject(subjectRes.subject);
  // Geography is the dominant dimension; without a state nothing defensible
  // can be ranked, so say so rather than emitting a meaningless ordering.
  if (!subject.state) {
    return { available: false, reason: "insufficient_subject_data", fits: [], eligibleCandidates: candidateRes.candidates.length };
  }

  const fits = rankBuyerFits(subject, candidateRes.candidates, { limit });
  return {
    available: true,
    source: W8C_SOURCE,
    observationalOnly: true,
    eligibleCandidates: candidateRes.candidates.length,
    evaluatedCandidates: candidateRes.candidates.length,
    subject: {
      state: subject.state,
      county: subject.county,
      zip: subject.zip,
      assetFamily: subject.assetFamily,
      referencePrice: subject.referencePrice,
      buildingSqft: subject.buildingSqft,
      units: subject.units,
    },
    fits,
  };
}

/**
 * Build the sanitized panel payload for a property.
 * Never throws: any failure resolves to an `unavailable` panel.
 */
export async function buildBuyerIntelligencePanel(propertyId, deps = {}) {
  const base = {
    source: W8C_SOURCE,
    label: PANEL_LABEL,
    observationalOnly: true,
    influencesRankingOrPricing: false,
    propertyId: String(propertyId ?? ""),
  };

  if (!propertyId) {
    return { ...base, status: PANEL_STATUS.UNAVAILABLE, reason: "missing_property_id", buyers: [] };
  }

  let comparison;
  try {
    comparison = await compareBuyerIntelligenceForProperty(propertyId, deps);
  } catch {
    return { ...base, status: PANEL_STATUS.UNAVAILABLE, reason: "w8c_unavailable", buyers: [] };
  }

  const w8c = comparison.w8c ?? { available: false, buyers: [] };
  if (!w8c.available) {
    return {
      ...base,
      status: PANEL_STATUS.UNAVAILABLE,
      reason: w8c.reason ?? "w8c_unavailable",
      buyers: [],
      reiComparison: projectComparison(comparison, new Map()),
    };
  }

  const buyers = (w8c.buyers ?? []).map(projectBuyer);
  const byId = new Map((w8c.buyers ?? []).map((b) => [b.w8cBuyerEntityId, b]));
  const observedFits = await buildObservedFits(propertyId, deps).catch(() => ({
    available: false, reason: "w8c_unavailable", fits: [],
  }));

  const version = w8c.version ?? {};
  return {
    ...base,
    status: buyers.length ? PANEL_STATUS.AVAILABLE : PANEL_STATUS.NO_HISTORY,
    reason: buyers.length ? null : "no_canonical_buyer_history",
    version: {
      runId: version.runId ?? null,
      modelVersion: version.modelVersion ?? null,
      w8aVersion: version.w8aVersion ?? null,
      w8bVersion: version.w8bVersion ?? null,
      completedAt: version.completedAt ?? null,
    },
    occurrenceCount: buyers.reduce((total, b) => total + b.occurrenceCount, 0),
    buyerCount: buyers.length,
    buyersWithBuybox: buyers.filter((b) => b.buybox).length,
    buyers,
    observedFits,
    reiComparison: projectComparison(comparison, byId),
  };
}

export default buildBuyerIntelligencePanel;
