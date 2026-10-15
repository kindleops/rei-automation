// Domain service bindings for the capability plane.
//
// Every entry delegates to an EXISTING exported service — the same function a
// cockpit route calls — so validation and business rules exist exactly once.
// Imports are lazy: building the registry never loads Supabase/provider code,
// and tests inject fakes with the same names. The capability definitions see
// ONLY this object: there is no `from()`, `rpc()`, `query()` or SQL string in it.
//
//   capability                      service (module#export)
//   campaigns.search                campaigns/campaign-automation-service#listCampaigns
//   campaigns.inspect               campaigns/campaign-automation-service#getCampaign (incl. evaluateCampaignLaunchReadiness)
//   campaigns.create_draft          campaigns/campaign-composer#saveComposerDraft → createCampaign
//   campaigns.build_proposed_cohort campaigns/campaign-composer#readComposerCohort → countCampaignAudienceCohort (planner, read-only)
//   campaigns.prepare_launch_*      campaigns/campaign-composer#launchComposedCampaign (on human approval only)
//   inbox.find_conversations        inbox/live-inbox-service#getLiveInbox
//   inbox.read_thread               inbox/live-inbox-service#getThreadMessages (message_events)
//   inbox.prepare_reply             inbox/send-now-service#canSend + resolveFromPhoneNumber,
//                                   queue/send-time-contact-guard#runSendTimeContactGuard,
//                                   supabase/sms-engine#evaluateContactWindow,
//                                   templates/template-authority#lookupSupabaseTemplate,
//                                   campaigns/template-render-validation#renderTemplateBody;
//                                   on approval: cockpit/cockpit-service#runInboxAction('send-now')
//   pipeline.inspect_stage_evidence opportunity/pipeline-command-service#getPipelineDealStory + opportunity-service#getOpportunityById
//   pipeline.propose_stage_change   opportunity/opportunity-service#transitionOpportunityStage (on approval only)
//   platform.health                 system-control#getSystemValue, ops/system-watchdog#collectWatchdogSnapshot+evaluateWatchdog,
//                                   agent/runtime/handlers/ops-health-check#evaluateHealthSnapshot
//   missions.create                 agent/runtime/job-runtime (agent.runtime_enqueue, PROPOSED R2 schema)

// Static import specifiers (bundler-analysable); resolved on first use only.
const lazy = (load, name) => async (...args) => {
  const mod = await load()
  const fn = mod[name]
  if (typeof fn !== 'function') throw Object.assign(new Error(`${name} unavailable`), { code: 'SERVICE_UNAVAILABLE' })
  return fn(...args)
}

const CAMPAIGNS = () => import('@/lib/domain/campaigns/campaign-automation-service.js')
const COMPOSER = () => import('@/lib/domain/campaigns/campaign-composer.js')
const INBOX = () => import('@/lib/domain/inbox/live-inbox-service.js')
const SEND_NOW = () => import('@/lib/domain/inbox/send-now-service.js')
const OPP = () => import('@/lib/domain/opportunity/opportunity-service.js')
// the shared server client; the old self-call (`() => SUPABASE()`) recursed forever, so every
// inbox capability binding that needs the database would have thrown on first use
const SUPABASE = () => import('@/lib/supabase/client.js')

export const HEARTBEAT_KEYS = Object.freeze(['queue_processor_heartbeat_at', 'campaign_feeder_heartbeat_at', 'followup_no_response_heartbeat_at', 'seller_state_reconcile_heartbeat_at', 'webhook_delivery_recovery_last_at', 'queue_processor_mode', 'queue_execution_mode'])
export const FEEDER_KEYS = Object.freeze(['campaign_feeder_last_batch_at', 'campaign_feeder_last_inserted_count', 'campaign_feeder_last_blocked_count', 'campaign_feeder_last_campaign_count', 'campaign_feeder_last_stalled_count', 'campaign_feeder_last_reason'])

/**
 * @param {{ runtimeStore?: () => Promise<object> }} [opts] runtimeStore: the R2 runtime store (agent_api pool)
 */
export function createDomainServices({ runtimeStore = null } = {}) {
  return Object.freeze({
    campaigns: Object.freeze({
      list: lazy(CAMPAIGNS, 'listCampaigns'),
      get: lazy(CAMPAIGNS, 'getCampaign'),
      saveDraft: lazy(COMPOSER, 'saveComposerDraft'),
      cohort: lazy(COMPOSER, 'readComposerCohort'),
      prepare: lazy(COMPOSER, 'prepareComposerLaunch'),
      launch: lazy(COMPOSER, 'launchComposedCampaign'),
    }),
    inbox: Object.freeze({
      threads: lazy(INBOX, 'getLiveInbox'),
      messages: lazy(INBOX, 'getThreadMessages'),
      /** One thread's inbox row via the server-backed inbox search (exact thread_key match only). */
      async threadRow(thread_key) {
        const { getLiveInbox } = await INBOX()
        const res = await getLiveInbox({ q: thread_key, limit: 10, skip_counts: true, skip_delivery: true }, { skipCounts: true, skipDelivery: true })
        return (res?.threads || []).find((t) => t?.thread_key === thread_key || t?.canonical_e164 === thread_key) || null
      },
      async canSend(input) {
        const { canSend } = await SEND_NOW()
        return canSend(input)
      },
      async resolveSender(input) {
        const [{ resolveFromPhoneNumber }, { supabase }] = await Promise.all([SEND_NOW(), SUPABASE()])
        return resolveFromPhoneNumber({ ...input, supabase })
      },
      async contactGuard(row) {
        const [{ runSendTimeContactGuard }, { supabase }] = await Promise.all([import('@/lib/domain/queue/send-time-contact-guard.js'), SUPABASE()])
        return runSendTimeContactGuard(row, { supabase })
      },
      async contactWindow(row) {
        const { evaluateContactWindow } = await import('@/lib/supabase/sms-engine.js')
        return evaluateContactWindow(row)
      },
      async template(template_id) {
        const [{ lookupSupabaseTemplate }, { supabase }] = await Promise.all([import('@/lib/domain/templates/template-authority.js'), SUPABASE()])
        return lookupSupabaseTemplate(supabase, template_id)
      },
      async render(body, values) {
        const { renderTemplateBody } = await import('@/lib/domain/campaigns/template-render-validation.js')
        return renderTemplateBody(body, values)
      },
      async sendNow(payload) {
        const { runInboxAction } = await import('@/lib/cockpit/cockpit-service.js')
        return runInboxAction({ action: 'send-now', payload: { ...payload, dry_run: false } })
      },
    }),
    pipeline: Object.freeze({
      story: lazy(() => import('@/lib/domain/opportunity/pipeline-command-service.js'), 'getPipelineDealStory'),
      get: lazy(OPP, 'getOpportunityById'),
      transition: lazy(OPP, 'transitionOpportunityStage'),
      validate: lazy(() => import('@/lib/domain/opportunity/universal-pipeline-registry.js'), 'validateStageTransition'),
    }),
    platform: Object.freeze({
      async systemValues(keys) {
        const { getSystemValue } = await import('@/lib/system-control.js')
        const vals = await Promise.all(keys.map((k) => getSystemValue(k).catch(() => null)))
        return Object.fromEntries(keys.map((k, i) => [k, vals[i] == null ? null : String(vals[i])]))
      },
      async watchdog() {
        const w = await import('@/lib/domain/ops/system-watchdog.js')
        const { getSystemFlag } = await import('@/lib/system-control.js')
        const snap = await w.collectWatchdogSnapshot({ readOutboundEnabled: () => getSystemFlag('outbound_sms_enabled') })
        return { snapshot: snap, evaluation: w.evaluateWatchdog(snap, w.DEFAULT_THRESHOLDS) }
      },
    }),
    missions: Object.freeze({
      async enqueue(o) {
        if (typeof runtimeStore !== 'function') throw Object.assign(new Error('runtime store not configured'), { code: 'RUNTIME_STORE_UNAVAILABLE' })
        return (await runtimeStore()).enqueue(o)
      },
      async events(job_id) {
        if (typeof runtimeStore !== 'function') throw Object.assign(new Error('runtime store not configured'), { code: 'RUNTIME_STORE_UNAVAILABLE' })
        return (await runtimeStore()).jobEvents(job_id, { after: 0, limit: 5 })
      },
    }),
  })
}

/** Production-only wiring (agent_api pool, R2 runtime store, system_control), loaded on first use. */
export async function loadProductionDeps() {
  const [{ getAgentPgPool, assertAgentPoolTls }, { getVerifiedRuntimeStore }, { getSystemValue }] = await Promise.all([
    import('../live/live-agent.js'),
    import('../runtime/runtime-service.js'),
    import('@/lib/system-control.js'),
  ])
  return { getAgentPgPool, assertAgentPoolTls, getVerifiedRuntimeStore, getSystemValue }
}
