// ─── context-resolution-result.js ───────────────────────────────────────────
// SELF-HEALING CONTEXT RESOLUTION (supersprint §6, P0 #3).
//
// Identity/property/conversation resolution on the inbound path was a chain of
// single-source lookups with lossy outcomes: a multi-owner tie in the as-of
// deal-context resolver returned a bare null (indistinguishable from "no
// context"), the outbound-pair matcher picked sent_rows[0] without recording
// what it rejected, and nothing compared the ids two sources produced. The
// "dirty canary" was exactly that: two contexts, one silently chosen.
//
// This module is the PURE ranking + ambiguity core. It takes the evidence each
// source produced (explicit ids, the as-of deal context, the outbound-pair
// match) and returns ONE ContextResolutionResult:
//
//   status       resolved | ambiguous | none
//   chosen       { property_id, master_owner_id, prospect_id } or null
//   confidence   high | medium | low | unverified | null
//   evidence     every source consulted, with the ids it produced + strategy
//   rejected     candidates that lost the ranking (never silently discarded)
//   disagreement cross-source conflict on property or owner, if any
//   repair       when one authoritative lineage clearly dominates, the
//                lower-ranked disagreeing source it overrides (recorded)
//   reason       machine-readable
//
// FAIL CLOSED ON GENUINE AMBIGUITY: two VERIFIED sources that disagree on the
// property or the owner produce `ambiguous`, never a guess. A lower-confidence
// source disagreeing with a higher one is a REPAIR (the authoritative lineage
// dominates) and is recorded, not hidden.

export const CONTEXT_RESOLUTION_VERSION = "context_resolution_result_v1";

export const RESOLUTION_STATUS = Object.freeze({
  RESOLVED: "resolved",
  AMBIGUOUS: "ambiguous",
  NONE: "none",
});

/** Source priority: higher wins. Explicit ids from the event/campaign are authoritative. */
export const SOURCE_RANK = Object.freeze({
  explicit_ids: 4,
  deal_context_as_of: 3,
  outbound_pair_linked: 3,
  outbound_pair_sent: 2,
  outbound_pair_latest: 1,
});

const CONFIDENCE_BY_RANK = Object.freeze({ 4: "high", 3: "high", 2: "medium", 1: "low", 0: "unverified" });

function clean(value) {
  return String(value ?? "").trim();
}

function idsOf(source = {}) {
  return {
    property_id: clean(source.property_id) || null,
    master_owner_id: clean(source.master_owner_id) || null,
    prospect_id: clean(source.prospect_id) || null,
  };
}

function hasAnyId(ids) {
  return Boolean(ids.property_id || ids.master_owner_id || ids.prospect_id);
}

/** Two id sets disagree when both name a value for the same key and the values differ. */
export function detectDisagreement(a = {}, b = {}) {
  const out = {};
  for (const key of ["property_id", "master_owner_id"]) {
    const va = clean(a?.[key]);
    const vb = clean(b?.[key]);
    if (va && vb && va !== vb) out[key] = { a: va, b: vb };
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Normalize one source into an evidence entry.
 * @param {string} source   one of SOURCE_RANK keys
 * @param {object} payload  { property_id, master_owner_id, prospect_id, verified, strategy, ambiguous, distinct_owners, candidates }
 */
export function evidenceFrom(source, payload = null) {
  if (!payload) return { source, present: false, ids: idsOf({}), rank: SOURCE_RANK[source] ?? 0, verified: false };
  const ids = idsOf(payload);
  return {
    source,
    present: hasAnyId(ids) || payload.ambiguous === true,
    ids,
    rank: payload.verified === false ? 0 : (SOURCE_RANK[source] ?? 0),
    verified: payload.verified !== false,
    strategy: clean(payload.strategy) || null,
    ambiguous: payload.ambiguous === true,
    distinct_owners: Array.isArray(payload.distinct_owners) ? payload.distinct_owners : null,
    candidates: Number.isFinite(Number(payload.candidates)) ? Number(payload.candidates) : null,
  };
}

/**
 * Build the result from the evidence the caller gathered. Pure; total.
 *
 * @param {object} args
 * @param {object} [args.explicit_ids]          ids carried by the event / campaign target
 * @param {object} [args.deal_context]          as-of deal context ({..ids, ambiguous, distinct_owners})
 * @param {object} [args.outbound_pair]         pair match ({..ids, strategy, verified, candidates})
 */
export function buildContextResolutionResult({ explicit_ids = null, deal_context = null, outbound_pair = null } = {}) {
  const pairSource = !outbound_pair
    ? "outbound_pair_latest"
    : outbound_pair.strategy === "linked" || outbound_pair.context_linked === true
      ? "outbound_pair_linked"
      : outbound_pair.verified === false || outbound_pair.strategy === "fallback_latest_pair_match"
        ? "outbound_pair_latest"
        : "outbound_pair_sent";

  const evidence = [
    evidenceFrom("explicit_ids", explicit_ids),
    evidenceFrom("deal_context_as_of", deal_context),
    evidenceFrom(pairSource, outbound_pair),
  ];

  // ── genuine ambiguity from a source itself (multi-owner tie) ─────────────
  const tied = evidence.find((e) => e.ambiguous);
  if (tied && !evidence.some((e) => e.source === "explicit_ids" && e.present && !e.ambiguous)) {
    return Object.freeze({
      version: CONTEXT_RESOLUTION_VERSION,
      status: RESOLUTION_STATUS.AMBIGUOUS,
      chosen: null,
      confidence: null,
      evidence,
      rejected: [],
      disagreement: null,
      repair: null,
      reason: "multi_owner_tie_at_as_of_instant",
      review_reason: "conflicting_property",
    });
  }

  const present = evidence.filter((e) => e.present && !e.ambiguous && hasAnyId(e.ids));
  if (!present.length) {
    return Object.freeze({
      version: CONTEXT_RESOLUTION_VERSION,
      status: RESOLUTION_STATUS.NONE,
      chosen: null,
      confidence: null,
      evidence,
      rejected: [],
      disagreement: null,
      repair: null,
      reason: "no_source_produced_identity",
      review_reason: "missing_context",
    });
  }

  // ── rank: highest source wins; ties broken by declaration order ──────────
  const ranked = [...present].sort((a, b) => b.rank - a.rank);
  const winner = ranked[0];
  const losers = ranked.slice(1);

  // ── cross-source disagreement ─────────────────────────────────────────────
  let repair = null;
  for (const loser of losers) {
    const disagreement = detectDisagreement(winner.ids, loser.ids);
    if (!disagreement) continue;
    // Two sources of EQUAL authority that disagree = genuine ambiguity. Fail closed.
    if (loser.rank === winner.rank && loser.verified && winner.verified) {
      return Object.freeze({
        version: CONTEXT_RESOLUTION_VERSION,
        status: RESOLUTION_STATUS.AMBIGUOUS,
        chosen: null,
        confidence: null,
        evidence,
        rejected: ranked.map((e) => ({ source: e.source, ids: e.ids, rank: e.rank })),
        disagreement: { between: [winner.source, loser.source], ...disagreement },
        repair: null,
        reason: "equal_authority_sources_disagree",
        review_reason: "conflicting_property",
      });
    }
    // A clearly dominant lineage overrides a weaker disagreeing source: REPAIR,
    // recorded with what was overridden. Never silent.
    repair = repair || {
      dominant: winner.source,
      overrode: loser.source,
      ...disagreement,
    };
  }

  // Backfill missing keys on the winner from lower-ranked sources that do NOT
  // disagree (identity is a property of the thread; a missing prospect_id on
  // the authority row may legitimately come from a weaker row).
  const chosen = { ...winner.ids };
  for (const loser of losers) {
    if (detectDisagreement(winner.ids, loser.ids)) continue;
    for (const key of Object.keys(chosen)) if (!chosen[key] && loser.ids[key]) chosen[key] = loser.ids[key];
  }

  return Object.freeze({
    version: CONTEXT_RESOLUTION_VERSION,
    status: RESOLUTION_STATUS.RESOLVED,
    chosen,
    confidence: CONFIDENCE_BY_RANK[winner.rank] || "unverified",
    winner: winner.source,
    evidence,
    rejected: losers.map((e) => ({ source: e.source, ids: e.ids, rank: e.rank, disagreed: Boolean(detectDisagreement(winner.ids, e.ids)) })),
    disagreement: repair ? { property_id: repair.property_id, master_owner_id: repair.master_owner_id } : null,
    repair,
    reason: repair ? "dominant_lineage_repaired_weaker_source" : "single_lineage",
    review_reason: null,
  });
}

export default buildContextResolutionResult;
