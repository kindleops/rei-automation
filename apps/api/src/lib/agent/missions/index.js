// Persistent missions (8.5.18): handler assembly from injected dependencies.
// The provider client is injected by the composition root (lib/ai/mission-runtime-wiring.js
// in the API, or a proof/test harness) — lib/agent never imports a provider SDK.
import { createAskService } from '../research/ask-service.js'
import { createResearchToolRegistry } from '../research/research-tools.js'
import { createResearchMissionHandler } from './research-mission-handler.js'
import { createSupervisorHandler } from './supervisor-handler.js'
import { createDiscoveryHandler } from './discovery-handler.js'
import { createReviewDigestHandler } from './review-digest-handler.js'
import { createPropertyResearchHandler } from './property-research-handler.js'
import { createPropertyResearchSweepHandler, PROPERTY_RESEARCH_SWEEP } from './property-research-triggers.js'
import { createValuationRefreshHandler, VALUATION_REFRESH_KIND } from './valuation-refresh-handler.js'
import { MISSION_RESEARCH_KIND, MISSION_SUPERVISOR_KIND, DISCOVERY_KIND, REVIEW_DIGEST_KIND, PROPERTY_RESEARCH_KIND } from './mission-kinds.js'

export * from './mission-kinds.js'
export { createMissionsService } from './missions-service.js'
export { createMissionPgReads, createMissionMemoryReads } from './mission-reads.js'
export { createPropertyResearchHandler } from './property-research-handler.js'
export { enqueuePropertyResearch, sweepPropertyResearch, propertyResearchEnabled, PROPERTY_RESEARCH_TRIGGERS, PROPERTY_RESEARCH_FLAG, PROPERTY_RESEARCH_SWEEP } from './property-research-triggers.js'
// 8.5.21-b: the turn-engine research hook (pure) and the valuation refresh queue (dry-run by default)
export { researchTriggerFromTurn, enqueueResearchForTurn, RESEARCH_TRIGGER_HOOK_VERSION, TURN_RESEARCH_TRIGGERS } from './research-trigger-hook.js'
export { createValuationRefreshHandler, VALUATION_REFRESH_KIND } from './valuation-refresh-handler.js'

/**
 * @param {{ env?: object, runtimeStore: object, reads: object, provider?: object|null, resolver?: object|null,
 *           getPlane?: () => Promise<object|null>, createServices?: (() => object)|null, registry?: object,
 *           discoverySource?: object|null, shadowSource?: object|null, operations?: { source?: object, store?: object }|null,
 *           log?: Function|null, now?: () => number }} deps
 * @returns {Record<string, { run: Function }>}
 */
export function buildMissionHandlers({ env = process.env, runtimeStore, reads, provider = null, resolver = null, getPlane = async () => null, createServices = null, registry = null, discoverySource = null, shadowSource = null, propertyResearchSource = null, propertyResearchSweepSource = null, zipLookup = null, zipPriorFor = null, valuationRefresh = null, operations = null, log = null, now = () => Date.now(), research = {} }) {
  const out = {}
  let buildAsk = null
  if (provider && resolver && typeof createServices === 'function') {
    const reg = registry || createResearchToolRegistry()
    buildAsk = ({ store, capabilityHook }) => createAskService({ store, registry: reg, provider, resolver, createServices, env, log, capabilityHook })
    out[MISSION_RESEARCH_KIND] = createResearchMissionHandler({ buildAsk, reads, getPlane, ...research })
  }
  // 8.5.20-b: property.research — present only when a read-only research source is wired
  if (propertyResearchSource) out[PROPERTY_RESEARCH_KIND] = createPropertyResearchHandler({ source: propertyResearchSource, reads, buildAsk, env, now, zipLookup, zipPriorFor })
  // 8.5.21-b: valuation.refresh — present only when its read-only source + dry-run runner are wired
  if (valuationRefresh?.source && valuationRefresh?.runDecision) out[VALUATION_REFRESH_KIND] = createValuationRefreshHandler({ ...valuationRefresh, env, now })
  if (propertyResearchSource && propertyResearchSweepSource) out[PROPERTY_RESEARCH_SWEEP.kind] = createPropertyResearchSweepHandler({ runtimeStore, sweepSource: propertyResearchSweepSource, env, now })
  out[MISSION_SUPERVISOR_KIND] = createSupervisorHandler({ runtimeStore, reads, provider, resolver, env, now })
  if (discoverySource) out[DISCOVERY_KIND] = createDiscoveryHandler({ source: discoverySource, reads, getPlane, provider, resolver, env, now })
  out[REVIEW_DIGEST_KIND] = createReviewDigestHandler({ reads, shadowSource, operations, now }) // 8.5.20 C: + the daily operating brief
  return out
}
