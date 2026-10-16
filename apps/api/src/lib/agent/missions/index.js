// Persistent missions (8.5.18): handler assembly from injected dependencies.
// The provider client is injected by the composition root (lib/ai/mission-runtime-wiring.js
// in the API, or a proof/test harness) — lib/agent never imports a provider SDK.
import { createAskService } from '../research/ask-service.js'
import { createResearchToolRegistry } from '../research/research-tools.js'
import { createResearchMissionHandler } from './research-mission-handler.js'
import { createSupervisorHandler } from './supervisor-handler.js'
import { createDiscoveryHandler } from './discovery-handler.js'
import { createReviewDigestHandler } from './review-digest-handler.js'
import { MISSION_RESEARCH_KIND, MISSION_SUPERVISOR_KIND, DISCOVERY_KIND, REVIEW_DIGEST_KIND } from './mission-kinds.js'

export * from './mission-kinds.js'
export { createMissionsService } from './missions-service.js'
export { createMissionPgReads, createMissionMemoryReads } from './mission-reads.js'

/**
 * @param {{ env?: object, runtimeStore: object, reads: object, provider?: object|null, resolver?: object|null,
 *           getPlane?: () => Promise<object|null>, createServices?: (() => object)|null, registry?: object,
 *           discoverySource?: object|null, shadowSource?: object|null, log?: Function|null, now?: () => number }} deps
 * @returns {Record<string, { run: Function }>}
 */
export function buildMissionHandlers({ env = process.env, runtimeStore, reads, provider = null, resolver = null, getPlane = async () => null, createServices = null, registry = null, discoverySource = null, shadowSource = null, log = null, now = () => Date.now(), research = {} }) {
  const out = {}
  if (provider && resolver && typeof createServices === 'function') {
    const reg = registry || createResearchToolRegistry()
    const buildAsk = ({ store, capabilityHook }) => createAskService({ store, registry: reg, provider, resolver, createServices, env, log, capabilityHook })
    out[MISSION_RESEARCH_KIND] = createResearchMissionHandler({ buildAsk, reads, getPlane, ...research })
  }
  out[MISSION_SUPERVISOR_KIND] = createSupervisorHandler({ runtimeStore, reads, provider, resolver, env, now })
  if (discoverySource) out[DISCOVERY_KIND] = createDiscoveryHandler({ source: discoverySource, reads, getPlane, provider, resolver, env, now })
  out[REVIEW_DIGEST_KIND] = createReviewDigestHandler({ reads, shadowSource, now })
  return out
}
