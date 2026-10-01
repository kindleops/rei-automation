/**
 * CAPABILITY CATALOG — the only actions a workflow may take.
 *
 * Each capability is a typed contract around an EXISTING canonical domain
 * function that enforces its own guards (suppression, contact window,
 * lifecycle authority, closing guard, send authority). Workflow Studio never
 * writes a domain table itself, never runs raw SQL, never runs custom code.
 *
 * Contract:
 *   inputs     typed fields (entity refs, strings, enums, durations, money)
 *   outputs    what later nodes may reference
 *   policy     AUTO | APPROVAL | MANUAL_ONLY  (declared by the owning domain)
 *   retry      which failures are retryable, max attempts, backoff
 *   skippable  may an operator skip this node on a stuck run
 *   idempotencyKey(input, ctx) → the logical-action key (a transport retry
 *              reuses it; a business follow-up is a new node → new key)
 *   availability(env) → AVAILABLE | CONFIG_REQUIRED | UNAVAILABLE
 *   invoke(input, ctx) → { status, outputs, reason }
 *      status ∈ SUCCESS · BLOCKED · RETRYABLE_FAILURE · PERMANENT_FAILURE · WAITING_EXTERNAL
 *   simulate(input, ctx) → same shape, no side effects (for simulation)
 *
 * Capabilities the spec expects but that have no canonical implementation yet
 * are listed as UNAVAILABLE with the reason, never faked.
 */

const clean = (v) => String(v ?? '').trim()

export const STATUS = Object.freeze({ SUCCESS: 'SUCCESS', BLOCKED: 'BLOCKED', RETRYABLE: 'RETRYABLE_FAILURE', PERMANENT: 'PERMANENT_FAILURE', WAITING: 'WAITING_EXTERNAL' })
export const POLICY = Object.freeze({ AUTO: 'AUTO', APPROVAL: 'APPROVAL', MANUAL: 'MANUAL_ONLY' })

const RETRY_NONE = Object.freeze({ max: 1, backoffSeconds: 0, retryable: [] })
const RETRY_TRANSIENT = Object.freeze({ max: 3, backoffSeconds: 60, retryable: ['timeout', 'network', 'rate_limited', 'unavailable'] })

/** Map a canonical `{ok, reason|code|error}` result onto an orchestration status. */
export function mapResult(r, { blockedCodes = [], waitingCodes = [] } = {}) {
  if (!r) return { status: STATUS.RETRYABLE, reason: 'no_result' }
  if (r.ok) return { status: STATUS.SUCCESS, outputs: r, reason: r.duplicate ? 'duplicate_idempotent' : null }
  const code = clean(r.code || r.reason || r.error).toLowerCase()
  if (waitingCodes.some((c) => code.includes(c))) return { status: STATUS.WAITING, reason: code }
  if (blockedCodes.some((c) => code.includes(c)) || r.blocked) return { status: STATUS.BLOCKED, reason: code || 'blocked' }
  if (RETRY_TRANSIENT.retryable.some((c) => code.includes(c))) return { status: STATUS.RETRYABLE, reason: code }
  return { status: STATUS.PERMANENT, reason: code || 'failed' }
}

const T = { entity: (kind) => ({ type: 'entity', kind }), string: { type: 'string' }, text: { type: 'text' }, enum: (values) => ({ type: 'enum', values }), duration: { type: 'duration' }, bool: { type: 'boolean' }, money: { type: 'money' }, date: { type: 'datetime' } }

/**
 * ensurePropertyAcquisitionDecision reports failure as
 * DECISION_STATUS.ENGINE_FAILED === 'decision_engine_failed' (decisionAuthority.js).
 * The step used to compare against the constant's NAME ('ENGINE_FAILED'), so a
 * failed engine run was recorded as a successful refresh.
 */
const DECISION_ENGINE_FAILED = 'decision_engine_failed'
export function decisionRefreshResult(r) {
  const status = r?.status || null
  if (status === DECISION_ENGINE_FAILED || status === 'ENGINE_FAILED') return { status: STATUS.RETRYABLE, reason: 'engine_failed' }
  return { status: STATUS.SUCCESS, outputs: { decision_state: status } }
}

export const CAPABILITIES = Object.freeze({
  'notify.operator': {
    domain: 'notifications', label: 'Notify operator', description: 'Create a canonical LeadCommand notification (deduplicated, rate limited).',
    inputs: { event_type: { ...T.enum(['email_needs_operator', 'closing_case_at_risk', 'closing_party_unreachable', 'inbox_needs_call', 'intelligence_automation_alert']), required: true }, title: { ...T.string, required: true }, description: T.text, entity: T.entity('any') },
    outputs: { notification_id: T.string },
    policy: POLICY.AUTO, retry: RETRY_TRANSIENT, skippable: true,
    idempotencyKey: (i, ctx) => `wf:${ctx.runId}:${ctx.nodeId}:notify`,
    availability: () => ({ state: 'AVAILABLE' }),
    async invoke(i, ctx) {
      const { emitNotificationFromBusinessEvent } = await import('@/lib/domain/notifications/notification-emitter.js')
      const r = await (ctx.deps?.notify || emitNotificationFromBusinessEvent)({ eventType: i.event_type, title: i.title, description: i.description, sourceEntityType: i.entity?.kind || 'workflow_run', sourceEntityId: i.entity?.id || ctx.runId, titleVars: i.entity?.kind === 'seller_thread' ? { thread_key: i.entity.id } : {}, recommendation: `Raised by workflow ${ctx.workflowKey} v${ctx.version}`, deduplicationKey: this.idempotencyKey(i, ctx) })
      if (r?.ok) return { status: STATUS.SUCCESS, outputs: { notification_id: r.id || null } }
      // Same per-run key already emitted inside the rate window: the notification exists.
      if (r?.skipped && r.reason === 'rate_limited') return { status: STATUS.SUCCESS, outputs: { notification_id: null }, reason: 'rate_limited_duplicate' }
      if (r?.skipped && ['unknown_event_type', 'missing_event_type'].includes(r.reason)) return { status: STATUS.PERMANENT, reason: r.reason }
      // A write that did not land is not a notification: retry, never record success.
      return { status: STATUS.RETRYABLE, reason: r?.reason || r?.error || 'notification_write_failed' }
    },
    simulate: (i) => ({ status: STATUS.SUCCESS, outputs: { notification_id: 'simulated' }, preview: `Notification: ${i.title}` }),
  },

  'seller.schedule_follow_up': {
    domain: 'seller', label: 'Schedule seller follow-up', description: 'Schedule the seller follow-up through the canonical follow-up scheduler (deduplicated per thread+intent; cancelled automatically on any seller reply; contact window and suppression enforced at dispatch).',
    inputs: { seller: { ...T.entity('seller_thread'), required: true }, intent: { ...T.enum(['no_reply', 'consider_selling', 'offer_follow_up', 'nurture']), required: true } },
    outputs: { queue_row_id: T.string, scheduled_for: T.date },
    policy: POLICY.AUTO, retry: RETRY_TRANSIENT, skippable: false,
    idempotencyKey: (i) => `seller_followup:${i.seller?.thread_key}:${i.intent}`,
    availability: () => ({ state: 'AVAILABLE' }),
    async invoke(i, ctx) {
      const { scheduleFollowUp } = await import('@/lib/domain/seller-flow/seller-followup-scheduler.js')
      const r = await scheduleFollowUp(i.intent, i.seller?.thread_key, { source: `workflow:${ctx.workflowKey}@${ctx.version}`, master_owner_id: i.seller?.master_owner_id, property_id: i.seller?.property_id }, ctx.deps?.supabase)
      return mapResult(r, { blockedCodes: ['suppressed', 'duplicate_followup_exists', 'opt'] })
    },
    simulate: (i) => ({ status: STATUS.SUCCESS, outputs: { scheduled_for: 'per canonical cadence' }, preview: `Follow-up (${i.intent}) scheduled on the seller's conversation` }),
  },

  'seller.cancel_follow_ups': {
    domain: 'seller', label: 'Cancel pending seller follow-ups', description: 'Withdraw pending follow-ups and auto-replies on the seller conversation (canonical inbound-takeover policy).',
    inputs: { seller: { ...T.entity('seller_thread'), required: true }, reason: { ...T.string, required: true }, keep_nurture_follow_ups: T.bool },
    outputs: { cancelled: { type: 'number' } },
    policy: POLICY.AUTO, retry: RETRY_TRANSIENT, skippable: true,
    idempotencyKey: (i, ctx) => `wf:${ctx.runId}:${ctx.nodeId}:cancel`,
    availability: () => ({ state: 'AVAILABLE' }),
    async invoke(i, ctx) {
      const { cancelPendingFollowUpsForThread } = await import('@/lib/domain/seller-flow/seller-followup-scheduler.js')
      const r = await cancelPendingFollowUpsForThread({ thread_key: i.seller?.thread_key, reason: i.reason, keep_nurture_follow_ups: i.keep_nurture_follow_ups === true, supabase: ctx.deps?.supabase })
      return mapResult(r)
    },
    simulate: () => ({ status: STATUS.SUCCESS, outputs: { cancelled: 0 }, preview: 'Pending follow-ups on this conversation withdrawn' }),
  },

  'seller.set_next_action': {
    domain: 'seller', label: 'Set seller next action', description: 'Update next action / snooze / temperature through the universal lead-state authority (manual locks and suppression evidence enforced).',
    inputs: { seller: { ...T.entity('seller_thread'), required: true }, next_action: T.string, snoozed_until: T.date, temperature: T.enum(['hot', 'warm', 'cold']) },
    outputs: {},
    policy: POLICY.AUTO, retry: RETRY_TRANSIENT, skippable: true,
    idempotencyKey: (i, ctx) => `wf:${ctx.runId}:${ctx.nodeId}:lead_state`,
    availability: () => ({ state: 'AVAILABLE' }),
    async invoke(i, ctx) {
      const { patchUniversalLeadState } = await import('@/lib/domain/lead-state/patch-universal-lead-state.js')
      const patch = {}
      for (const k of ['next_action', 'snoozed_until', 'temperature']) if (i[k]) patch[k] = i[k]
      const r = await patchUniversalLeadState({ threadKey: i.seller?.thread_key, patch, meta: { change_source: 'workflow', actor: `workflow:${ctx.workflowKey}@${ctx.version}`, idempotency_key: this.idempotencyKey(i, ctx) }, supabase: ctx.deps?.supabase })
      return mapResult(r, { blockedCodes: ['locked', 'invalid_canonical_thread_key', 'suppression'] })
    },
    simulate: (i) => ({ status: STATUS.SUCCESS, outputs: {}, preview: `Lead state → ${Object.entries(i).filter(([k]) => k !== 'seller').map(([k, v]) => `${k}: ${v}`).join(', ')}` }),
  },

  'outbound.send_sms': {
    domain: 'outbound', label: 'Send SMS (canonical queue)', description: 'Enqueue an approved SMS through the canonical queue writer. Emergency stop, campaign mode, contact window, suppression and sender health are enforced by the queue and the runner — a workflow cannot bypass them.',
    inputs: { seller: { ...T.entity('seller_thread'), required: true }, template_id: { ...T.string, required: true }, message_body: { ...T.text, required: true }, use_case: T.string },
    outputs: { queue_row_id: T.string },
    policy: POLICY.APPROVAL, retry: RETRY_TRANSIENT, skippable: false,
    idempotencyKey: (i, ctx) => `wf:${ctx.runId}:${ctx.nodeId}:sms`,
    availability: () => ({ state: 'AVAILABLE' }),
    async invoke(i, ctx) {
      const { enqueueCanonicalOutboundSms } = await import('@/lib/domain/queue/canonical-queue-writer.js')
      const r = await enqueueCanonicalOutboundSms({ to_phone_number: i.seller?.phone || i.seller?.thread_key, from_phone_number: i.seller?.from_phone, message_body: i.message_body, thread_key: i.seller?.thread_key, source_event_id: this.idempotencyKey(i, ctx), template_id: i.template_id, use_case: i.use_case, metadata: { idempotency_key: this.idempotencyKey(i, ctx), source: 'workflow', workflow: ctx.workflowKey, workflow_version: ctx.version, run_id: ctx.runId } }, { supabase: ctx.deps?.supabase })
      return mapResult(r, { blockedCodes: ['suppress', 'paused', 'stop', 'brake', 'blocked', 'campaign_mode'] })
    },
    simulate: (i) => ({ status: STATUS.SUCCESS, outputs: { queue_row_id: 'simulated' }, preview: `SMS queued: “${clean(i.message_body).slice(0, 80)}”` }),
  },

  'closing.request_email': {
    domain: 'closing', label: 'Request closing email', description: 'Ask Email Command for a title/buyer email on a closing (idempotent per closing+category+sequence). Email Command owns sending; Closing Authority owns truth.',
    inputs: { closing: { ...T.entity('closing_case'), required: true }, action: { ...T.enum(['title_open', 'title_followup', 'title_commitment_reminder', 'clear_to_close_followup', 'closing_confirmation', 'settlement_request', 'buyer_emd_reminder', 'buyer_agreement_followup']), required: true }, category: { ...T.string, required: true }, sequence: { type: 'number' } },
    outputs: { request_key: T.string },
    policy: POLICY.AUTO, retry: RETRY_TRANSIENT, skippable: false,
    idempotencyKey: (i) => `closing_email:${i.closing?.closing_case_id}:${i.category}:${i.sequence || 1}`,
    availability: () => ({ state: 'AVAILABLE' }),
    async invoke(i, ctx) {
      const { requestClosingEmail } = await import('@/lib/domain/closings/closing-email-requests.js')
      const { loadClosingCase } = await import('@/lib/domain/closings/closing-authority.js')
      const db = ctx.deps?.supabase || (await import('@/lib/supabase/client.js')).supabase
      const c = await loadClosingCase(db, i.closing?.closing_case_id)
      if (!c) return { status: STATUS.PERMANENT, reason: 'closing_not_found' }
      if (c.terminal_outcome || c.closed_at) return { status: STATUS.BLOCKED, reason: 'closing_not_open' }
      const email = i.action.startsWith('buyer') ? null : c.title_company_email
      const r = await requestClosingEmail(db, c, { action: i.action, category: i.category, sequence: i.sequence || 1, recipientEmail: email, requestedBy: `workflow:${ctx.workflowKey}@${ctx.version}` })
      return { status: r.status === 'skipped' ? STATUS.BLOCKED : STATUS.SUCCESS, outputs: { request_key: r.requestKey }, reason: r.status === 'skipped' ? 'no_recipient_address' : r.duplicate ? 'duplicate_idempotent' : null }
    },
    simulate: (i) => ({ status: STATUS.SUCCESS, outputs: { request_key: `closing_email:${i.closing?.closing_case_id}:${i.category}:${i.sequence || 1}` }, preview: `Email Command asked to send ${i.action.replace(/_/g, ' ')}` }),
  },

  'closing.pause_automation': {
    domain: 'closing', label: 'Pause closing automation', description: 'Pause the closing\'s automated follow-ups through Closing Authority (reason required, audited).',
    inputs: { closing: { ...T.entity('closing_case'), required: true }, reason: { ...T.string, required: true } },
    outputs: {},
    policy: POLICY.AUTO, retry: RETRY_TRANSIENT, skippable: true,
    idempotencyKey: (i) => `closing_pause:${i.closing?.closing_case_id}`,
    availability: () => ({ state: 'AVAILABLE' }),
    async invoke(i, ctx) {
      const { setAutomationPaused } = await import('@/lib/domain/closings/closing-authority.js')
      return mapResult(await setAutomationPaused({ closingCaseId: i.closing?.closing_case_id, paused: true, reason: i.reason, actor: `workflow:${ctx.workflowKey}` }, { supabase: ctx.deps?.supabase }))
    },
    simulate: (i) => ({ status: STATUS.SUCCESS, outputs: {}, preview: `Closing automation paused: ${i.reason}` }),
  },

  'campaign.pause': {
    domain: 'campaign', label: 'Pause campaign', description: 'Pause a campaign through Campaign Command lifecycle authority (idempotent).',
    inputs: { campaign: { ...T.entity('campaign'), required: true }, reason: { ...T.string, required: true } },
    outputs: {},
    policy: POLICY.AUTO, retry: RETRY_TRANSIENT, skippable: false,
    idempotencyKey: (i) => `campaign_pause:${i.campaign?.id}`,
    availability: () => ({ state: 'AVAILABLE' }),
    async invoke(i, ctx) {
      const { applyCampaignLifecycleAction } = await import('@/lib/domain/campaigns/campaign-automation-service.js')
      return mapResult(await applyCampaignLifecycleAction(i.campaign?.id, { action: 'pause', reason: i.reason }, { supabase: ctx.deps?.supabase }))
    },
    simulate: (i) => ({ status: STATUS.SUCCESS, outputs: {}, preview: `Campaign paused: ${i.reason}` }),
  },

  'campaign.resume': {
    domain: 'campaign', label: 'Resume campaign', description: 'Resume a campaign (readiness-gated by Campaign Command).',
    inputs: { campaign: { ...T.entity('campaign'), required: true }, reason: { ...T.string, required: true } },
    outputs: {},
    policy: POLICY.APPROVAL, retry: RETRY_TRANSIENT, skippable: false,
    idempotencyKey: (i) => `campaign_resume:${i.campaign?.id}`,
    availability: () => ({ state: 'AVAILABLE' }),
    async invoke(i, ctx) {
      const { applyCampaignLifecycleAction } = await import('@/lib/domain/campaigns/campaign-automation-service.js')
      return mapResult(await applyCampaignLifecycleAction(i.campaign?.id, { action: 'resume', reason: i.reason }, { supabase: ctx.deps?.supabase }), { blockedCodes: ['campaign_blocked'] })
    },
    simulate: () => ({ status: STATUS.SUCCESS, outputs: {}, preview: 'Campaign resumed (if Campaign Command readiness passes)' }),
  },

  'pipeline.request_transition': {
    domain: 'pipeline', label: 'Request lifecycle transition', description: 'Request a stage change through the canonical lifecycle authority (closed requires the closing guard; backward/skip moves need a reason).',
    inputs: { opportunity: { ...T.entity('opportunity'), required: true }, to_stage: { ...T.enum(['offer_interest', 'asking_price', 'property_condition', 'offer', 'formal_contract', 'disposition', 'under_contract', 'prepared_to_close']), required: true }, reason: { ...T.string, required: true } },
    outputs: {},
    policy: POLICY.APPROVAL, retry: RETRY_NONE, skippable: false,
    idempotencyKey: (i, ctx) => `wf:${ctx.runId}:${ctx.nodeId}:stage`,
    availability: () => ({ state: 'AVAILABLE' }),
    async invoke(i, ctx) {
      const { transitionOpportunityStage } = await import('@/lib/domain/opportunity/opportunity-service.js')
      return mapResult(await transitionOpportunityStage(i.opportunity?.id, { to_stage: i.to_stage, reason: i.reason, actor: `workflow:${ctx.workflowKey}@${ctx.version}`, source: 'workflow', idempotency_key: this.idempotencyKey(i, ctx) }), { blockedCodes: ['closing_blocked', 'invalid_transition', 'locked'] })
    },
    simulate: (i) => ({ status: STATUS.SUCCESS, outputs: {}, preview: `Lifecycle authority asked to move to ${i.to_stage.replace(/_/g, ' ')}` }),
  },

  'deal.ensure_decision': {
    domain: 'deal', label: 'Refresh deal decision', description: 'Ensure a current acquisition decision for the property (recomputes through the decision authority when stale).',
    inputs: { property: { ...T.entity('property'), required: true }, max_age_days: { type: 'number' } },
    outputs: { decision_state: T.string },
    policy: POLICY.AUTO, retry: RETRY_TRANSIENT, skippable: true,
    idempotencyKey: (i) => `deal_decision:${i.property?.id}`,
    availability: () => ({ state: 'AVAILABLE' }),
    async invoke(i) {
      const { ensurePropertyAcquisitionDecision } = await import('@/lib/acquisition/decisionAuthority.js')
      const r = await ensurePropertyAcquisitionDecision(i.property?.id, { maxAgeDays: i.max_age_days || 14 })
      return decisionRefreshResult(r)
    },
    simulate: () => ({ status: STATUS.SUCCESS, outputs: { decision_state: 'CURRENT' }, preview: 'Deal decision refreshed if stale' }),
  },

  'email.send': {
    domain: 'email', label: 'Send email (Email Command)', description: 'Queue an email through Email Command (suppression, sender, threading, revalidation and telemetry owned by Email Command).',
    inputs: { recipient: { ...T.entity('contact'), required: true }, subject: { ...T.string, required: true }, body: { ...T.text, required: true }, thread: T.entity('email_thread') },
    outputs: { message_id: T.string, thread_id: T.string },
    policy: POLICY.APPROVAL, retry: RETRY_TRANSIENT, skippable: false,
    idempotencyKey: (i, ctx) => `wf:${ctx.runId}:${ctx.nodeId}:email`,
    availability: (env = {}) => (env.emailPlane ? { state: 'AVAILABLE' } : { state: 'CONFIG_REQUIRED', reason: 'Email Command migrations and sender are not configured yet' }),
    async invoke(i, ctx) {
      const { sendManualEmail } = await import('@/lib/domain/email/email-service.js')
      return mapResult(await sendManualEmail({ to: i.recipient?.email, subject: i.subject, text_body: i.body, html_body: `<p>${clean(i.body).replace(/</g, '&lt;')}</p>`, thread_id: i.thread?.id, idempotency_key: this.idempotencyKey(i, ctx) }, { actor: `workflow:${ctx.workflowKey}` }), { blockedCodes: ['suppressed', 'sender_identity_missing'] })
    },
    simulate: (i) => ({ status: STATUS.SUCCESS, outputs: { message_id: 'simulated' }, preview: `Email queued: “${i.subject}”` }),
  },

  // ── expected by the spec, not yet a canonical capability (never faked) ──
  'seller.pause_automation': {
    domain: 'seller', label: 'Pause seller automation', description: 'Durable per-seller pause honoured by the send path.',
    inputs: {}, outputs: {}, policy: POLICY.AUTO, retry: RETRY_NONE, skippable: false, idempotencyKey: () => null,
    availability: () => ({ state: 'UNAVAILABLE', reason: 'No canonical writer yet: the contactability guard honours thread status "paused_review", but nothing writes it. Needs a Seller Automation capability first.' }),
    async invoke() { return { status: STATUS.PERMANENT, reason: 'capability_unavailable' } },
    simulate: () => ({ status: STATUS.BLOCKED, reason: 'capability_unavailable' }),
  },
  'campaign.add_properties': {
    domain: 'campaign', label: 'Add exact properties to campaign', description: 'Append an exact property-ID cohort to a campaign.',
    inputs: {}, outputs: {}, policy: POLICY.APPROVAL, retry: RETRY_NONE, skippable: false, idempotencyKey: () => null,
    availability: () => ({ state: 'UNAVAILABLE', reason: 'Campaign Command only replaces targets from filters today; an append-by-ID capability is required.' }),
    async invoke() { return { status: STATUS.PERMANENT, reason: 'capability_unavailable' } },
    simulate: () => ({ status: STATUS.BLOCKED, reason: 'capability_unavailable' }),
  },
})

export function capabilityCatalog(env = {}) {
  return Object.entries(CAPABILITIES).map(([key, c]) => ({
    key, domain: c.domain, label: c.label, description: c.description, policy: c.policy, skippable: c.skippable,
    retry: { max: c.retry.max, backoffSeconds: c.retry.backoffSeconds },
    inputs: c.inputs, outputs: c.outputs, availability: c.availability(env),
  }))
}
