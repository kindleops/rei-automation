// Composition root for the 8.5.20 part C operations jobs: the ONLY place the agent_api
// pool, the guarded read client (economics) and the operations handlers meet.
//
// operationsRuntimeHandlers() → {} unless AGENT_OPERATIONS_ENABLED and the runtime gate;
//                               the DB still claims a kind only when it is armed + enabled
//                               in agent.runtime_limits.kind_limits (default: absent = off).
// getOperationsServices()     → { source, store } for the API routes and the daily brief.
import { getAgentPgPool } from '@/lib/agent/live/live-agent.js'
import { runtimeGate, getRuntimeStore } from '@/lib/agent/runtime/runtime-service.js'
import { enqueuePropertyResearch } from '@/lib/agent/missions/property-research-triggers.js'
import { getCapabilityPlane } from '@/lib/agent/capabilities/index.js'
import { createQuickScanReadClient } from '@/lib/agent/quick-scan/read-client.js'
import { createMissionPgReads } from '@/lib/agent/missions/index.js'
import { buildOperationsHandlers, createOperationsPgSource, createOperationsPgStore, operationsEnabled } from '@/lib/agent/operations/index.js'
import { assessOpportunityEconomics } from '@/lib/domain/opportunity-economics/economics-service.js'

const HANDLERS = Symbol.for('lc.agent.operations.handlers')
const SERVICES = Symbol.for('lc.agent.operations.services')

export function getOperationsServices(env = process.env) {
  if (!operationsEnabled(env)) return null
  if (globalThis[SERVICES]) return globalThis[SERVICES]
  const pool = getAgentPgPool(env)
  globalThis[SERVICES] = { source: createOperationsPgSource({ pool }), store: createOperationsPgStore({ pool }) }
  return globalThis[SERVICES]
}

/**
 * 8.5.19 economics for a recovery candidate with a stated ask: the read-only economics
 * service over the guarded GET-only read client. The ask is the opportunity's recorded
 * asking price (seller-stated evidence); the engine's own row decides everything else.
 */
export function createEconomicsFor(db) {
  if (!db) return null
  return async (f) => {
    const ledger = { asking_price: { current: { value: { amount: f.opportunity.asking_price }, origin: 'seller_stated', source_message_id: f.inbound.last_meaningful?.message_event_id || null }, history: [] } }
    return assessOpportunityEconomics({ supabase: db, property_id: f.property_id, ledger, seller_facts: {} })
  }
}

export function operationsRuntimeHandlers(env = process.env) {
  if (!operationsEnabled(env) || !runtimeGate(env).enabled) return {}
  if (globalThis[HANDLERS]) return globalThis[HANDLERS]
  const services = getOperationsServices(env)
  let readDb = null
  try { readDb = createQuickScanReadClient({ env }).client } catch { readDb = null } // READ_CLIENT_UNCONFIGURED ⇒ economics not evaluated (reported)
  globalThis[HANDLERS] = buildOperationsHandlers({
    source: services.source,
    store: services.store,
    reads: createMissionPgReads({ pool: getAgentPgPool(env) }),
    getPlane: () => getCapabilityPlane(env),
    economicsFor: createEconomicsFor(readDb),
    // 8.5.21-b: recovery → property.research (OFF unless PROPERTY_RESEARCH_ENABLED=1 and the kind is armed)
    linkage: { enqueueResearch: (req) => enqueuePropertyResearch({ store: getRuntimeStore(env), env, trigger: req.trigger, property_id: req.property_id, discriminator: req.discriminator }) },
  })
  return globalThis[HANDLERS]
}

/** The Operations API's services: the store + the operator membership read (agent_api pool). */
export async function getOperationsRouteServices({ env = process.env } = {}) {
  const services = getOperationsServices(env)
  if (!services) return null
  const reads = createMissionPgReads({ pool: getAgentPgPool(env) })
  return { store: services.store, membership: (org_id, user_id) => reads.membership(org_id, user_id) }
}

export function __resetOperationsWiring() {
  delete globalThis[HANDLERS]
  delete globalThis[SERVICES]
}
