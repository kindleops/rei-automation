// Composition root for persistent missions (8.5.18): the ONLY place the provider
// client, the agent_api pool, the guarded read client and the mission handlers meet.
//
// missionRuntimeHandlers()  → {} unless AGENT_MISSIONS_ENABLED (and the runtime gate);
//                             the DB still claims a kind only when it is armed + enabled
//                             in agent.runtime_limits.kind_limits (default: absent = off).
// getMissionsService()      → the Missions API service (agent_api pool, R2 runtime store).
import { createAnthropicProvider } from './anthropic-provider.js'
import { getAgentPgPool } from '@/lib/agent/live/live-agent.js'
import { getRuntimeStore, getVerifiedRuntimeStore, runtimeGate } from '@/lib/agent/runtime/runtime-service.js'
import { createModelResolver } from '@/lib/agent/research/models.js'
import { createQuickScanReadClient } from '@/lib/agent/quick-scan/read-client.js'
import { createQuickScanServices } from '@/lib/agent/quick-scan/services.js'
import { getCapabilityPlane } from '@/lib/agent/capabilities/index.js'
import { buildMissionHandlers, createMissionPgReads, createMissionsService, missionsEnabled } from '@/lib/agent/missions/index.js'
import { createDiscoverySupabaseSource } from '@/lib/agent/missions/discovery-source.js'
import { createShadowSupabaseSource } from '@/lib/agent/missions/review-digest-handler.js'
import { propertyResearchEnabled, createPropertyResearchSweepSupabaseSource } from '@/lib/agent/missions/property-research-triggers.js'
import { createResearchSupabaseSource } from '@/lib/domain/property-research/research-source.js'
import { getOperationsServices } from '@/lib/ai/operations-runtime-wiring.js'
import { valuationRefreshEnabled, recoveryValuationCandidates } from '@/lib/agent/missions/valuation-refresh-handler.js'
import { createValuationSupabaseSource } from '@/lib/domain/valuation-refresh/valuation-source.js'
import { runValuationRefresh } from '@/lib/domain/valuation-refresh/dry-run.js'
import { failClosedHoldCheck } from '@/lib/agent/operations/automation-hold-gate.js'

const HANDLERS = Symbol.for('lc.agent.missions.handlers')
const SERVICE = Symbol.for('lc.agent.missions.service')

function logLine(o) {
  try { console.info(JSON.stringify({ source: 'agent.missions', ...o })) } catch { /* never throw from logging */ }
}

export function missionRuntimeHandlers(env = process.env) {
  if (!missionsEnabled(env) || !runtimeGate(env).enabled) return {}
  if (globalThis[HANDLERS]) return globalThis[HANDLERS]
  const pool = getAgentPgPool(env)
  const reads = createMissionPgReads({ pool })
  const provider = createAnthropicProvider({ env })
  const resolver = createModelResolver({ provider, env, log: logLine })
  let readDb = null
  try { readDb = createQuickScanReadClient({ env }).client } catch { readDb = null } // READ_CLIENT_UNCONFIGURED ⇒ no research tools / discovery source
  globalThis[HANDLERS] = buildMissionHandlers({
    env,
    runtimeStore: getRuntimeStore(env),
    reads,
    provider,
    resolver,
    getPlane: () => getCapabilityPlane(env),
    createServices: readDb ? () => createQuickScanServices({ db: createQuickScanReadClient({ env }).client }) : null,
    discoverySource: readDb ? createDiscoverySupabaseSource({ db: readDb }) : null,
    shadowSource: readDb ? createShadowSupabaseSource({ db: readDb }) : null,
    // 8.5.20-b: OFF unless PROPERTY_RESEARCH_ENABLED=1 (and the kind armed + enabled in kind_limits)
    propertyResearchSource: readDb && propertyResearchEnabled(env) ? createResearchSupabaseSource({ db: readDb }) : null,
    propertyResearchSweepSource: readDb && propertyResearchEnabled(env) ? createPropertyResearchSweepSupabaseSource({ db: readDb }) : null,
    // 8.5.20 C: the daily operating brief (null ⇒ its operations sections read "unavailable")
    operations: getOperationsServices(env),
    // 8.5.21-b: valuation.refresh — OFF unless VALUATION_REFRESH_ENABLED=1; DRY RUN ONLY in this wiring
    // (the guarded GET-only read client + get_comp_candidates_for_subject, a STABLE read): no write path exists here.
    valuationRefresh: readDb && valuationRefreshEnabled(env) ? (() => {
      const valDb = createQuickScanReadClient({ env, extraReadRpcs: ['get_comp_candidates_for_subject'] }).client
      const ops = getOperationsServices(env)
      return {
        source: createValuationSupabaseSource({ db: readDb }),
        runDecision: ({ property_id, now }) => runValuationRefresh({ property_id, client: valDb, now, write: false, env }),
        extraCandidates: ops?.store ? () => recoveryValuationCandidates(ops.store) : null,
        // owner P0: fail closed until rc-8.5.20-holds' checkAutomationHold is integrated
        checkAutomationHold: failClosedHoldCheck,
      }
    })() : null,
    log: logLine,
  })
  return globalThis[HANDLERS]
}

export async function getMissionsService({ env = process.env } = {}) {
  if (globalThis[SERVICE]) return globalThis[SERVICE]
  const runtimeStore = await getVerifiedRuntimeStore(env)
  globalThis[SERVICE] = createMissionsService({ runtimeStore, reads: createMissionPgReads({ pool: getAgentPgPool(env) }), getPlane: () => getCapabilityPlane(env) })
  return globalThis[SERVICE]
}

export function __resetMissionWiring() {
  delete globalThis[HANDLERS]
  delete globalThis[SERVICE]
}
