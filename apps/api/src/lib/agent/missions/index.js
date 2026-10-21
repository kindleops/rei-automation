// Persistent missions — PACKAGE A (hotfix/research-runtime) handler assembly.
//
// A backport of rc-8.5.21 (71479867) missions/index.js restricted to the non-contacting research
// kinds: property.research, property.research_sweep, valuation.refresh (dry run) and
// conversation.review_digest (the daily operating brief). mission.research / mission.supervisor
// (capability plane) and acquisition.discovery (campaign drafts) are NOT part of this package: their
// modules are absent, so they cannot be registered. The provider client is injected by the composition
// root (lib/ai/research-runtime-wiring.js) — lib/agent never imports a provider SDK.
import { createAskService } from '../research/ask-service.js'
import { createResearchToolRegistry } from '../research/research-tools.js'
import { createReviewDigestHandler } from './review-digest-handler.js'
import { createPropertyResearchHandler } from './property-research-handler.js'
import { createPropertyResearchSweepHandler, PROPERTY_RESEARCH_SWEEP } from './property-research-triggers.js'
import { createValuationRefreshHandler, VALUATION_REFRESH_KIND } from './valuation-refresh-handler.js'
import { REVIEW_DIGEST_KIND, PROPERTY_RESEARCH_KIND } from './mission-kinds.js'

export * from './mission-kinds.js'
export { createMissionPgReads, createMissionMemoryReads } from './mission-reads.js'
export { createPropertyResearchHandler } from './property-research-handler.js'
export { enqueuePropertyResearch, sweepPropertyResearch, propertyResearchEnabled, PROPERTY_RESEARCH_TRIGGERS, PROPERTY_RESEARCH_FLAG, PROPERTY_RESEARCH_SWEEP } from './property-research-triggers.js'
export { createValuationRefreshHandler, VALUATION_REFRESH_KIND } from './valuation-refresh-handler.js'
export { recordFindings } from './record-findings.js'

/** The kinds this assembly can ever return (Package A). */
export const PACKAGE_A_MISSION_KINDS = Object.freeze([PROPERTY_RESEARCH_KIND, PROPERTY_RESEARCH_SWEEP.kind, VALUATION_REFRESH_KIND, REVIEW_DIGEST_KIND])

/**
 * @param {{ env?: object, runtimeStore: object, reads: object, provider?: object|null, resolver?: object|null,
 *           createServices?: (() => object)|null, registry?: object, shadowSource?: object|null,
 *           propertyResearchSource?: object|null, propertyResearchSweepSource?: object|null,
 *           valuationRefresh?: object|null, operations?: { source?: object, store?: object }|null,
 *           log?: Function|null, now?: () => number }} deps
 * @returns {Record<string, { run: Function }>}
 */
export function buildMissionHandlers({ env = process.env, runtimeStore, reads, provider = null, resolver = null, createServices = null, registry = null, shadowSource = null, propertyResearchSource = null, propertyResearchSweepSource = null, zipLookup = null, zipPriorFor = null, valuationRefresh = null, operations = null, log = null, now = () => Date.now() }) {
  const out = {}
  let buildAsk = null
  if (provider && resolver && typeof createServices === 'function') {
    const reg = registry || createResearchToolRegistry()
    // research tools only: no capability hook exists in Package A
    buildAsk = ({ store }) => createAskService({ store, registry: reg, provider, resolver, createServices, env, log, capabilityHook: null })
  }
  if (propertyResearchSource) out[PROPERTY_RESEARCH_KIND] = createPropertyResearchHandler({ source: propertyResearchSource, reads, buildAsk, env, now, zipLookup, zipPriorFor })
  if (valuationRefresh?.source && valuationRefresh?.runDecision) out[VALUATION_REFRESH_KIND] = createValuationRefreshHandler({ ...valuationRefresh, env, now })
  if (propertyResearchSource && propertyResearchSweepSource) out[PROPERTY_RESEARCH_SWEEP.kind] = createPropertyResearchSweepHandler({ runtimeStore, sweepSource: propertyResearchSweepSource, env, now })
  out[REVIEW_DIGEST_KIND] = createReviewDigestHandler({ reads, shadowSource, operations, now })
  return out
}
