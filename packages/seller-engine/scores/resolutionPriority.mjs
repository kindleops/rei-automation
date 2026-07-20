// Phase 5 resolution_priority — decides which UNRESOLVED identities to work
// first. It READS seller-pressure/foreclosure/equity/expected-value as inputs
// but NEVER writes or alters them. It is a separate axis from motivation:
// motivation says "how much of a seller lead"; resolution_priority says "how
// worthwhile + how tractable is resolving who to contact". Pure/deterministic.
export const RESOLUTION_PRIORITY_VERSION = 'resolution-priority-v5';

// weights are for the RESOLUTION ranking only — not seller-pressure weights
export const RP_CONFIG = {
  value_pressure_w: 0.5,       // share of value from motivation (read-only)
  value_foreclosure_w: 0.3,    // foreclosure urgency accelerates
  value_equity_w: 0.2,         // monetizable equity / expected value
  resolvability_floor: 0.3,    // even hard cases keep some priority
  complexity_penalty: { owner_resolved: 0, owner_candidate_found: 0.1, owner_unresolved: 0.25,
    conflicting_owner_evidence: 0.35, entity_authority_required: 0.5, probate_authority_required: 0.6,
    listing_agent_controls_contact: 0.7, no_reachable_owner_contact: 0.55 },
  time_sensitive_stages: ['nod', 'nos_nts', 'auction_scheduled'],
  time_sensitive_mult: 1.4,
};

// inputs: read-only signals already computed by the engine
export function resolutionPriority(inp, cfg = RP_CONFIG) {
  const pressure = clamp01((inp.seller_pressure_raw ?? 0) / (inp.pressure_scale ?? 120));
  const foreclosure = clamp01((inp.foreclosure_urgency ?? 0) / 100);
  const equity = clamp01((inp.monetizable_equity_pct ?? inp.equity_pct ?? 0) / 100);
  const value = cfg.value_pressure_w * pressure + cfg.value_foreclosure_w * foreclosure + cfg.value_equity_w * equity;

  // resolvability: higher resolution confidence + more contact evidence + lower
  // complexity = easier to resolve => rank sooner among equal value
  const complexityPenalty = cfg.complexity_penalty[inp.owner_resolution_status] ?? 0.4;
  const contactEvidence = clamp01((inp.available_contact_methods ?? 0) / 3);
  const resolvability = Math.max(cfg.resolvability_floor,
    0.5 * (inp.resolution_confidence ?? 0.3) + 0.3 * contactEvidence + 0.2 * (1 - complexityPenalty));

  const timeMult = cfg.time_sensitive_stages.includes(inp.foreclosure_stage) ? cfg.time_sensitive_mult : 1;

  const raw = value * (cfg.resolvability_floor + (1 - cfg.resolvability_floor) * resolvability) * timeMult;
  return {
    resolution_priority: Math.round(raw * 10000) / 100,   // 0..~140 scale
    resolution_priority_0_100: Math.round(Math.min(100, raw * 100) * 100) / 100,
    components: { value: round2(value), resolvability: round2(resolvability), time_mult: timeMult,
      complexity_penalty: complexityPenalty },
    version: RESOLUTION_PRIORITY_VERSION,
    note: 'reads seller-pressure signals; does not alter motivation/distress scores',
  };
}

const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));
const round2 = (x) => Math.round(x * 100) / 100;
