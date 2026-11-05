// Composition root for LeadCommand Workforce (Phase A, docs/WORKFORCE.md): the ONLY place the
// workforce store, the R2 runtime store, the agent_api read model, the guarded READ-ONLY data client
// and the Workforce handlers meet.
//
// workforceRuntimeHandlers(env) → {} unless WORKFORCE_ENABLED=1 and the runtime gate (AGENT_ENABLED +
//                                 AGENT_RUNTIME_ENABLED); the DB still claims a kind only when it is
//                                 armed + enabled in agent.runtime_limits.kind_limits (absent = off).
// getWorkforceRouteServices()   → the API's services, null unless Workforce is enabled.
//
// Every domain service is bound to createQuickScanReadClient (GET/HEAD on tables + allowlisted STABLE
// RPCs only; any write is refused at the transport), so even a service whose module graph contains a
// writer can only READ from here. Nothing here can send, offer, write a stage or launch a campaign.
// The workforce store module is loaded lazily: until it is deployed (and enabled) nothing imports it.
import { getAgentPgPool } from '@/lib/agent/live/live-agent.js'
import { getRuntimeStore, getVerifiedRuntimeStore, runtimeGate } from '@/lib/agent/runtime/runtime-service.js'
import { createMissionPgReads } from '@/lib/agent/missions/index.js'
import { propertyResearchEnabled } from '@/lib/agent/missions/property-research-triggers.js'
import { createQuickScanReadClient } from '@/lib/agent/quick-scan/read-client.js'
import { COO_PLAN_KIND, DISPATCH_KIND, MISSION_REVIEW_KIND, modelInterpretEnabled, workforceEnabled } from '@/lib/workforce/config.js'
import { createCooPlanHandler, createDispatchHandler, createMissionReviewHandler } from '@/lib/workforce/engine/handlers.js'

const HANDLERS = Symbol.for('lc.workforce.handlers')
const DEPS = Symbol.for('lc.workforce.deps')
const STORE = Symbol.for('lc.workforce.store')

async function loadWorkforceStore(env) {
  if (globalThis[STORE]) return globalThis[STORE]
  const { createWorkforcePgStore } = await import('@/lib/workforce/store/index.js')
  globalThis[STORE] = createWorkforcePgStore({ pool: getAgentPgPool(env) })
  return globalThis[STORE]
}

/** agent.conversation_action_state, read-only (BEGIN READ ONLY + statement_timeout) over the agent_api pool. */
function createActionStateRead(pool) {
  return async ({ property_ref = null, conversation_id = null } = {}) => {
    let client
    try { client = await pool.connect() } catch { return null }
    try {
      await client.query('begin read only')
      await client.query('set local statement_timeout = 5000')
      const { rows } = await client.query(`select state, owner, verified_stage, stage_verified, next_action, due_at, reasons, lost, pending_approvals, last_inbound_at, last_outbound_at
          from agent.conversation_action_state where ($1::uuid is not null and conversation_id = $1::uuid) or ($2::text is not null and property_ref = $2) order by computed_at desc limit 1`, [conversation_id, property_ref])
      await client.query('rollback')
      return rows[0] || null
    } catch {
      try { await client.query('rollback') } catch { /* broken */ }
      return null // not applied / unreadable ⇒ the action state is unknown, never invented
    } finally {
      client.release()
    }
  }
}

/**
 * The READ services the capability adapters call (docs/WORKFORCE.md §0 table). All bound to the guarded
 * read client. Imported lazily so the tick route never loads them while Workforce is off.
 */
export async function createWorkforceReadServices({ env = process.env, db = null, pool = null } = {}) {
  const read = db || createQuickScanReadClient({ env }).client
  const [dc, pc, tc, dd, holds, supp, phones] = await Promise.all([
    import('@/lib/domain/deal-context/deal-context-service.js'),
    import('@/lib/domain/opportunity/pipeline-command-service.js'),
    import('@/lib/domain/inbox/thread-context-service.js'),
    import('@/lib/domain/deal-intelligence/deal-decision-service.js'),
    import('@/lib/domain/holds/automation-hold.js'),
    import('@/lib/domain/compliance/query-active-suppression.js'),
    import('@/lib/utils/phones.js'),
  ])
  return Object.freeze({
    listDealContexts: (params) => dc.listDealContexts(params, { supabase: read }),
    getDealContextByProperty: (id) => dc.getDealContextByProperty(id, { supabase: read }),
    getPipelineCommandOverview: (params) => pc.getPipelineCommandOverview(params, { supabase: read }),
    loadThreadContext: ({ thread_key }) => tc.loadThreadContext({ thread_key, supabase: read }),
    getDealDecision: (args) => dd.getDealDecision(args, { supabase: read }),
    // the Decision Engine row itself (never ensurePropertyAcquisitionDecision: no write, no on-demand run)
    async loadAcquisitionScore({ property_id }) {
      const { data, error } = await read.from('property_acquisition_scores').select('*').eq('property_id', String(property_id)).order('computed_at', { ascending: false }).limit(1)
      if (error) throw Object.assign(new Error('DECISION_READ_FAILED'), { code: 'DECISION_READ_FAILED' })
      return Array.isArray(data) ? data[0] || null : null
    },
    listActiveHolds: () => holds.loadActiveAutomationHolds({ supabase: read }),
    checkHold: (scope) => holds.checkAutomationHold({ ...scope, capability: 'ai_action' }, { supabase: read }),
    async checkSuppression({ thread_key }) {
      const to = phones.normalizePhone(thread_key)
      if (!to) return { suppressed: null, lookup_error: 'no_contact_key' }
      const r = await supp.queryActiveSuppression(read, to)
      return { suppressed: r.lookup_error ? null : r.suppressed === true, lookup_error: r.lookup_error ? 'lookup_failed' : null }
    },
    storedActionState: pool ? createActionStateRead(pool) : null,
    researchEnabled: () => propertyResearchEnabled(env),
    // no calibrated close-rate source exists yet ⇒ EV stays unknown (never a fixed spread)
    closeCalibration: null,
  })
}

async function buildDeps(env) {
  const pool = getAgentPgPool(env)
  const reads = createMissionPgReads({ pool })
  const [store, services] = await Promise.all([loadWorkforceStore(env), createWorkforceReadServices({ env, pool })])
  let modelCallFor = null
  let parseJson = null
  if (modelInterpretEnabled(env)) {
    const [{ createAnthropicProvider }, { createModelResolver }, mm] = await Promise.all([import('./anthropic-provider.js'), import('@/lib/agent/research/models.js'), import('@/lib/agent/missions/mission-model.js')])
    const provider = createAnthropicProvider({ env })
    const resolver = createModelResolver({ provider, env })
    parseJson = mm.parseJsonObject
    // one bounded, job-owned model call (ctx.reserve → provider → ctx.settle); it can only CHOOSE an intent
    modelCallFor = (ctx) => (o) => mm.jobModelCall({ ctx, provider, resolver, reads, env, identity: { verified: true, named: true, user_id: ctx.job.requested_by }, system: o.system, messages: o.messages, max_tokens: o.max_tokens, purpose: o.purpose })
  }
  return { store, runtimeStore: getRuntimeStore(env), reads, services, env, modelCallFor, parseJson }
}

export function workforceRuntimeHandlers(env = process.env) {
  if (!workforceEnabled(env) || !runtimeGate(env).enabled) return {}
  if (globalThis[HANDLERS]) return globalThis[HANDLERS]
  const deps = async () => {
    if (!globalThis[DEPS]) globalThis[DEPS] = buildDeps(env).catch((e) => { delete globalThis[DEPS]; throw e })
    return globalThis[DEPS]
  }
  const lazy = (kind, make) => Object.freeze({ kind, async run(ctx) { return make(await deps()).run(ctx) } })
  globalThis[HANDLERS] = Object.freeze({
    [COO_PLAN_KIND]: lazy(COO_PLAN_KIND, createCooPlanHandler),
    [DISPATCH_KIND]: lazy(DISPATCH_KIND, createDispatchHandler),
    [MISSION_REVIEW_KIND]: lazy(MISSION_REVIEW_KIND, createMissionReviewHandler),
  })
  return globalThis[HANDLERS]
}

/** The Workforce API's services (null ⇒ the route answers 503 after its gate; the gate itself 404s while off). */
export async function getWorkforceRouteServices({ env = process.env } = {}) {
  if (!workforceEnabled(env)) return null
  const pool = getAgentPgPool(env)
  const reads = createMissionPgReads({ pool })
  const [store, runtimeStore] = await Promise.all([loadWorkforceStore(env), getVerifiedRuntimeStore(env)])
  let latestBrief = null
  try {
    const { getOperationsServices } = await import('./operations-runtime-wiring.js')
    const ops = getOperationsServices(env)
    if (ops?.store) latestBrief = () => ops.store.latestFinding({ finding_type: 'digest.morning' })
  } catch { latestBrief = null }
  // the Authority Center lists active holds (ids / types only; never a thread key) through the guarded read client
  let listActiveHolds = null
  try {
    const read = createQuickScanReadClient({ env }).client
    const holds = await import('@/lib/domain/holds/automation-hold.js')
    listActiveHolds = () => holds.loadActiveAutomationHolds({ supabase: read })
  } catch { listActiveHolds = null }
  return { store, runtimeStore, reads, membership: (org_id, user_id) => reads.membership(org_id, user_id), latestBrief, listActiveHolds }
}

export function __resetWorkforceWiring() {
  delete globalThis[HANDLERS]
  delete globalThis[DEPS]
  delete globalThis[STORE]
}
