// PACKAGE A composition root (hotfix/research-runtime): the non-contacting AI research runtime.
//
// The ONLY place the provider client, the agent_api pool, the guarded GET-only read client and the
// research / operations handlers meet. A backport of rc-8.5.21 (71479867) mission-runtime-wiring.js +
// operations-runtime-wiring.js restricted to RESEARCH_PACKAGE_KINDS:
//
//   property.research        internal dossier / comps / economics / offer plan (internal_only); the
//                            bounded web step only with AGENT_WEB_RESEARCH_ENABLED=1 AND the paid-call gate
//                            (RESEARCH_PAID_CALLS_APPROVED=1 + RESEARCH_PAID_APPROVAL_REF + ceiling)
//   property.research_sweep  enqueues ≤ limit property.research jobs (missing / stale valuation, new ask)
//   valuation.refresh        the EXISTING engine in DRY RUN (write-refusing client; no write path here)
//   recovery.sweep           historical recovery → findings + operator work items + research requests
//   inbox.action_center      one action state per conversation + lost-conversation work items
//   ops.supervisor           deterministic supervisor checks → findings + remediation work items
//   conversation.review_digest  the daily operating brief (digest.morning finding)
//   ops.health_check         (production's own R2 handler, unchanged registration)
//
// NOT here, by construction (no import, no handler): mission.research / mission.supervisor (capability
// plane), acquisition.discovery (campaign drafts), pipeline.reconcile (stage approvals),
// conversation.decide / conversation.turn (AI messaging), followup.* (follow-up sends), auto-recovery
// (queue / attempt repairs), valuation write mode, the capability plane itself.
// tests/critical/research-runtime-no-send-path.test.mjs proves this file and every handler it builds
// has NO import path to the send stack.
//
// Code gates (each default OFF; absent ⇒ {}): AGENT_ENABLED + AGENT_RUNTIME_ENABLED (runtimeGate), then
//   PROPERTY_RESEARCH_ENABLED=1   property.research + property.research_sweep
//   VALUATION_REFRESH_ENABLED=1   valuation.refresh (dry run)
//   AGENT_OPERATIONS_ENABLED=1    recovery.sweep, inbox.action_center, ops.supervisor, the daily brief + the Operations API
// DB gates (the authority): agent.runtime_limits.runtime_enabled, emergency_stop, and kind_limits —
// a kind is claimed only when it is enabled + armed there; schedules are born disabled.
import { createAnthropicProvider } from './anthropic-provider.js'
import { getAgentPgPool } from '@/lib/agent/live/live-agent.js'
import { getRuntimeStore, runtimeGate } from '@/lib/agent/runtime/runtime-service.js'
import { createModelResolver } from '@/lib/agent/research/models.js'
import { createAskService } from '@/lib/agent/research/ask-service.js'
import { createResearchToolRegistry } from '@/lib/agent/research/research-tools.js'
import { createQuickScanReadClient } from '@/lib/agent/quick-scan/read-client.js'
import { createQuickScanServices } from '@/lib/agent/quick-scan/services.js'
import { createMissionPgReads } from '@/lib/agent/missions/mission-reads.js'
import { REVIEW_DIGEST_KIND, PROPERTY_RESEARCH_KIND } from '@/lib/agent/missions/mission-kinds.js'
import { createPropertyResearchHandler } from '@/lib/agent/missions/property-research-handler.js'
import { propertyResearchEnabled, enqueuePropertyResearch, createPropertyResearchSweepHandler, createPropertyResearchSweepSupabaseSource, PROPERTY_RESEARCH_SWEEP } from '@/lib/agent/missions/property-research-triggers.js'
import { createValuationRefreshHandler, valuationRefreshEnabled, recoveryValuationCandidates, VALUATION_REFRESH_KIND } from '@/lib/agent/missions/valuation-refresh-handler.js'
import { createReviewDigestHandler } from '@/lib/agent/missions/review-digest-handler.js'
import { isExcludedRow, researchExclusionFor, ResearchExcludedError } from '@/lib/agent/missions/research-exclusions.js'
import { createResearchSupabaseSource } from '@/lib/domain/property-research/research-source.js'
import { createValuationSupabaseSource } from '@/lib/domain/valuation-refresh/valuation-source.js'
import { runValuationRefresh } from '@/lib/domain/valuation-refresh/dry-run.js'
import { assessOpportunityEconomics } from '@/lib/domain/opportunity-economics/economics-service.js'
import { operationsEnabled, RECOVERY_SWEEP_KIND, ACTION_CENTER_KIND, OPS_SUPERVISOR_KIND } from '@/lib/agent/operations/operations-kinds.js'
import { buildOperationsHandlers } from '@/lib/agent/operations/operations-handlers.js'
import { createOperationsPgSource } from '@/lib/agent/operations/operations-source.js'
import { createOperationsPgStore } from '@/lib/agent/operations/operations-store.js'
import { OPS_HEALTH_CHECK_KIND } from '@/lib/agent/runtime/handlers/ops-health-check.js'

export const RESEARCH_PACKAGE_VERSION = 'research-package-a.v1'

/** The ONLY runtime kinds Package A registers (and the only ones its arming SQL arms). */
export const RESEARCH_PACKAGE_KINDS = Object.freeze([
  PROPERTY_RESEARCH_KIND,
  PROPERTY_RESEARCH_SWEEP.kind,
  VALUATION_REFRESH_KIND,
  RECOVERY_SWEEP_KIND,
  ACTION_CENTER_KIND,
  OPS_SUPERVISOR_KIND,
  REVIEW_DIGEST_KIND,
  OPS_HEALTH_CHECK_KIND,
])

const HANDLERS = Symbol.for('lc.agent.research_package.handlers')
const SERVICES = Symbol.for('lc.agent.operations.services')

function logLine(o) {
  try { console.info(JSON.stringify({ source: 'agent.research_package', ...o })) } catch { /* never throw from logging */ }
}

/** Owner exclusions at the source: an excluded property is never loaded, swept or valued. */
export function excludingResearchSource(source) {
  return Object.freeze({
    ...source,
    property: async (id) => { if (researchExclusionFor({ property_id: id })) throw new ResearchExcludedError(); return source.property(id) },
  })
}
export function excludingCandidates(source) {
  return Object.freeze({ ...source, candidates: async (o) => (await source.candidates(o)).filter((c) => !isExcludedRow(c)) })
}

/** { source, store } over the agent_api pool for the operations handlers, the brief and the Operations API. */
export function getOperationsServices(env = process.env) {
  if (!operationsEnabled(env)) return null
  if (globalThis[SERVICES]) return globalThis[SERVICES]
  const pool = getAgentPgPool(env)
  const src = createOperationsPgSource({ pool })
  // agent.ops_research_valuation_snapshot (rc-8.5.21-b) reads the negotiation tables, which Package A does
  // not ship: the supervisor reports that section 'RESEARCH_VALUATION_SOURCE_NOT_CONFIGURED' instead.
  const { researchValuationSnapshot: _omitted, ...source } = src
  globalThis[SERVICES] = { source: Object.freeze(source), store: createOperationsPgStore({ pool }) }
  return globalThis[SERVICES]
}

/** The Operations API's services: the store + the operator membership read (agent_api pool). */
export async function getOperationsRouteServices({ env = process.env } = {}) {
  const services = getOperationsServices(env)
  if (!services) return null
  const reads = createMissionPgReads({ pool: getAgentPgPool(env) })
  return { store: services.store, membership: (org_id, user_id) => reads.membership(org_id, user_id) }
}

/** Economics for a recovery candidate with a stated ask (read-only, guarded GET-only client). */
export function createEconomicsFor(db) {
  if (!db) return null
  return async (f) => {
    const ledger = { asking_price: { current: { value: { amount: f.opportunity.asking_price }, origin: 'seller_stated', source_message_id: f.inbound.last_meaningful?.message_event_id || null }, history: [] } }
    return assessOpportunityEconomics({ supabase: db, property_id: f.property_id, ledger, seller_facts: {} })
  }
}

/**
 * Pure assembly from injected dependencies (the tests call this with memory stores and fakes).
 * @returns {Record<string, { run: Function }>} only RESEARCH_PACKAGE_KINDS
 */
export function buildResearchPackageHandlers({ env = process.env, runtimeStore, reads, buildAsk = null, readDb = null, valuationDb = null, operations = null, sources = {}, now = () => Date.now() } = {}) {
  const out = {}
  // sources: test seams ({ research, sweep, valuation, valuationClient }); production builds them from the guarded GET-only read client.
  // Whatever is injected, the owner exclusions wrap it.
  const researchSource = sources.research || (readDb ? createResearchSupabaseSource({ db: readDb }) : null)
  const sweepSource = sources.sweep || (readDb ? createPropertyResearchSweepSupabaseSource({ db: readDb }) : null)
  const valuationSource = sources.valuation || (readDb ? createValuationSupabaseSource({ db: readDb }) : null)
  const valuationClient = sources.valuationClient || valuationDb
  if (propertyResearchEnabled(env) && researchSource && sweepSource && reads) {
    out[PROPERTY_RESEARCH_KIND] = createPropertyResearchHandler({ source: excludingResearchSource(researchSource), reads, buildAsk, env, now })
    out[PROPERTY_RESEARCH_SWEEP.kind] = createPropertyResearchSweepHandler({ runtimeStore, sweepSource: excludingCandidates(sweepSource), env, now })
  }
  if (valuationRefreshEnabled(env) && valuationSource && valuationClient) {
    out[VALUATION_REFRESH_KIND] = createValuationRefreshHandler({
      source: excludingCandidates(valuationSource),
      // DRY RUN ONLY: write is hard-coded false, and the client is the GET-only read client (writes are physically refused)
      runDecision: ({ property_id, now: at }) => runValuationRefresh({ property_id, client: valuationClient, now: at, write: false, env }),
      extraCandidates: operations?.store ? async () => (await recoveryValuationCandidates(operations.store)).filter((c) => !isExcludedRow(c)) : null,
      env,
      now,
    })
  }
  if (operations?.source && operations?.store && reads) {
    Object.assign(out, buildOperationsHandlers({
      source: operations.source,
      store: operations.store,
      reads,
      economicsFor: createEconomicsFor(readDb),
      // research requests only (recovery_finding → property.research); no follow-up intent linkage exists
      linkage: { enqueueResearch: (req) => enqueuePropertyResearch({ store: runtimeStore, env, trigger: req.trigger, property_id: req.property_id, discriminator: req.discriminator }) },
      now,
    }))
    out[REVIEW_DIGEST_KIND] = createReviewDigestHandler({ reads, shadowSource: null, operations, now })
  }
  for (const k of Object.keys(out)) if (!RESEARCH_PACKAGE_KINDS.includes(k)) delete out[k] // belt and braces
  return out
}

/** The tick's handler map for Package A ({} unless the runtime gate and at least one package flag are on). */
export function researchRuntimeHandlers(env = process.env) {
  if (!runtimeGate(env).enabled) return {}
  if (!propertyResearchEnabled(env) && !valuationRefreshEnabled(env) && !operationsEnabled(env)) return {}
  if (globalThis[HANDLERS]) return globalThis[HANDLERS]
  const pool = getAgentPgPool(env)
  const reads = createMissionPgReads({ pool })
  let readDb = null
  try { readDb = createQuickScanReadClient({ env }).client } catch { readDb = null } // READ_CLIENT_UNCONFIGURED ⇒ no research / valuation source
  let valuationDb = null
  try { valuationDb = readDb ? createQuickScanReadClient({ env, extraReadRpcs: ['get_comp_candidates_for_subject'] }).client : null } catch { valuationDb = null }
  let buildAsk = null
  if (readDb) {
    const provider = createAnthropicProvider({ env })
    const resolver = createModelResolver({ provider, env, log: logLine })
    const registry = createResearchToolRegistry()
    // the existing research ask service, no capability hook: research tools only (read-only registry)
    buildAsk = ({ store }) => createAskService({ store, registry, provider, resolver, createServices: () => createQuickScanServices({ db: createQuickScanReadClient({ env }).client }), env, log: logLine, capabilityHook: null })
  }
  globalThis[HANDLERS] = Object.freeze(buildResearchPackageHandlers({ env, runtimeStore: getRuntimeStore(env), reads, buildAsk, readDb, valuationDb, operations: getOperationsServices(env) }))
  return globalThis[HANDLERS]
}

export function __resetResearchWiring() {
  delete globalThis[HANDLERS]
  delete globalThis[SERVICES]
}
