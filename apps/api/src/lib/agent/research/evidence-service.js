// Evidence normalization (DR §4.2). Observation(s) + source → governed finding.
//
//  * blocked / unavailable findings carry NO value and are never absence
//  * a negative ("none found") claim requires a successful, covering query
//    against a source with supports_negative=true; otherwise → unavailable
//  * confidence is a RULE output, not a model's self-report:
//      authority_weight(status) × match_weight × freshness_decay
//      × agreement_bonus − conflict_penalty, capped at 0.6 for model_inference
import {
  EVIDENCE_AUTHORITY_WEIGHT,
  MODEL_INFERENCE_CONFIDENCE_CAP,
  confidenceBand,
  findingViolations,
} from '../contracts/evidence.js'
import { AgentError } from '../runtime/store.js'

const MATCH_WEIGHT = Object.freeze({ exact: 1, review: 0.6, none: 0.3 })

export function computeConfidence({ evidence_status, match = 'exact', freshness_decay = 1, agreeing_sources = 0, open_conflict = false }) {
  const base = EVIDENCE_AUTHORITY_WEIGHT[evidence_status] ?? 0
  let c = base * (MATCH_WEIGHT[match] ?? 0.3) * Math.max(0, Math.min(1, freshness_decay))
  c *= 1 + Math.min(0.1, 0.05 * agreeing_sources)
  if (open_conflict) c -= 0.25
  if (evidence_status === 'model_inference') c = Math.min(c, MODEL_INFERENCE_CONFIDENCE_CAP)
  return Math.max(0, Math.min(1, Math.round(c * 1000) / 1000))
}

/**
 * @param {{ property_id, finding_type, key?, outcome: 'retrieved'|'blocked'|'unavailable'|'failed',
 *   evidence_status?: string, value?: any, display_value?: string, is_negative_claim?: boolean,
 *   source: { source_id, supports_negative: boolean }, match?: string, model_confidence?: number }} input
 */
export function normalizeFinding(input) {
  const { outcome, source } = input
  if (!source?.source_id) throw new AgentError('SOURCE_REQUIRED', 'findings cite a source')
  let status = input.evidence_status
  let value = input.value ?? null
  let negative = Boolean(input.is_negative_claim)
  if (outcome === 'blocked') {
    status = 'blocked'
    value = null
    negative = false
  } else if (outcome === 'unavailable' || outcome === 'failed') {
    status = 'unavailable'
    value = null
    negative = false
  } else if (negative && !source.supports_negative) {
    // "none found" from a non-covering source is not absence
    status = 'unavailable'
    value = null
    negative = false
  }
  const confidence = status === 'blocked' || status === 'unavailable' ? 0 : computeConfidence({ evidence_status: status, match: input.match || 'exact' })
  const finding = {
    property_id: input.property_id,
    finding_type: input.finding_type,
    key: input.key || input.finding_type,
    value,
    display_value: value === null ? null : input.display_value ?? null,
    evidence_status: status,
    confidence,
    confidence_band: confidenceBand(confidence),
    model_confidence: input.model_confidence ?? null, // stored, never used
    is_inference: status === 'model_inference',
    is_negative_claim: negative,
    source_id: source.source_id,
  }
  const v = findingViolations(finding, { supports_negative: source.supports_negative, query_succeeded: outcome === 'retrieved' })
  if (v.length) throw new AgentError('FINDING_INVARIANT', v.join(','), { violations: v })
  return finding
}
