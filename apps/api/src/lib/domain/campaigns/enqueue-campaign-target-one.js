/**
 * Target-addressed single-row campaign enqueue.
 *
 * THE GAP THIS CLOSES
 * Campaign targets had no door into send_queue. `queue_one` takes a
 * campaign_session_id plus market/state and resolves its recipient through
 * `runSupabaseCandidateFeeder` against `v_feeder_candidates_fast` — a legacy
 * property/prospect view with no campaign linkage at all (20,738 rows, zero
 * overlap with the 2,161 campaign targets). Every send action
 * (`send_one_queue_row`, `run_targeted_queue_row`) takes a queue_row_id that
 * must already exist. `campaign_target_id` appears nowhere in the queue control
 * route.
 *
 * So a campaign target could be built, repaired, governed and validated, and
 * still had no way to become an outbound message.
 *
 * This is the missing primitive, and deliberately nothing more:
 *
 *     exactly one campaign_target_id in  ->  exactly zero or one queue row out
 *
 * It is not a feeder, not a bulk path, not auto-enqueue, and it does not send.
 *
 * WHAT IT REUSES
 * Every eligibility rule comes from the modules shipped in #91/#92 rather than
 * being reimplemented, so preflight and enqueue cannot drift apart:
 *   - template governance ....... template-governance.js
 *   - contact-window timezone ... contact-window-timezone.js
 *   - render validation ......... template-render-validation.js
 *   - agent identity ............ outbound-agent-identity.js
 *   - send-readiness semantics .. template-status-semantics.js
 * The row itself is inserted through the canonical helper
 * (`insertSupabaseSendQueueRow`), so provenance stamping, sanitisation and
 * internal-canary quarantine all still apply.
 *
 * WHY NOT enqueueCanonicalOutboundSms
 * That wrapper builds a fixed payload literal which drops `campaign_target_id`
 * and `seller_first_name` — the first is the whole point of this primitive, and
 * the second is required by the pre-claim validator. It also derives an
 * auto-reply-shaped idempotency key. We use the same underlying insert helper
 * it uses, one level down, rather than duplicating queue semantics.
 *
 * WHY NOT the feeder's routing resolver
 * `buildRoutingSelection` is module-private to supabase-candidate-feeder.js.
 * Importing it would pull the feeder into this path, which is precisely what
 * this primitive must never touch. Sender selection here reads the same
 * `textgrid_numbers` table the feeder ultimately selects from.
 */

import {
  applyGovernance,
  indexGovernance,
} from '@/lib/domain/campaigns/template-governance.js'
import {
  TZ_STATUS,
  isWithinContactWindow,
  resolveContactTimezone,
} from '@/lib/domain/campaigns/contact-window-timezone.js'
import { renderTemplateBody } from '@/lib/domain/campaigns/template-render-validation.js'
import { buildOutboundMergeValues } from '@/lib/domain/campaigns/outbound-agent-identity.js'
import { insertSupabaseSendQueueRow } from '@/lib/supabase/sms-engine.js'
import { child } from '@/lib/logging/logger.js'

const logger = child({ module: 'domain.campaigns.enqueue_campaign_target_one' })

const clean = (value) => String(value ?? '').trim()

/** Queue statuses that mean a row is still in play for this target. */
const LIVE_QUEUE_STATUSES = [
  'queued', 'pending', 'processing', 'scheduled', 'locked', 'retry',
]

/** Terminal statuses that still count as "this target was already contacted". */
const CONSUMED_QUEUE_STATUSES = ['sent', 'delivered']

/** Contact window — the operator setting, not a value invented here. */
const WINDOW_START_HOUR = 8
const WINDOW_END_HOUR = 21

export const ENQUEUE_REASON = {
  TARGET_NOT_FOUND: 'target_not_found',
  CAMPAIGN_MISSING: 'campaign_row_missing',
  TARGET_NOT_READY: 'target_not_ready',
  BLOCKED: 'target_blocked',
  SUPPRESSED: 'target_suppressed',
  DNC: 'recipient_on_suppression_list',
  AUTOMATION_SUPPRESSED: 'automation_suppression_active',
  PRIOR_CONTACT: 'prior_contact_exists',
  ALREADY_QUEUED: 'already_queued',
  INVALID_RECIPIENT: 'invalid_recipient_number',
  NO_SENDER: 'no_eligible_sender',
  SENDER_IS_RECIPIENT: 'sender_equals_recipient',
  TEMPLATE_MISSING: 'template_not_assigned',
  TEMPLATE_NOT_FOUND: 'template_not_in_catalog',
  TEMPLATE_UNGOVERNED: 'template_not_governed',
  LANGUAGE_MISMATCH: 'template_language_mismatch',
  IDENTITY_MISSING: 'agent_identity_unresolved',
  RENDER_FAILED: 'render_failed',
  TZ_UNRESOLVED: 'timezone_unresolved',
  OUTSIDE_WINDOW: 'outside_contact_window',
  INSERT_FAILED: 'queue_insert_failed',
  INVARIANT_VIOLATION: 'campaign_target_id_invariant_violation',
}

const fail = (reason, detail) => ({ created: false, reason, ...(detail ? { detail } : {}) })

/**
 * Deterministic queue_key, and the concurrency mechanism.
 *
 * `send_queue.queue_key` carries a UNIQUE index (send_queue_queue_key_key).
 * Deriving the key from (target, touch) means two simultaneous requests for the
 * same target cannot both insert: Postgres rejects the second with a unique
 * violation, which we translate into `already_queued`. This is a database
 * guarantee, not an application-level check-then-insert, so it holds under
 * genuine concurrency.
 *
 * Touch number is included so a legitimate later touch is still possible; only
 * a duplicate of the SAME touch is impossible.
 */
export function buildCampaignTargetQueueKey(campaignTargetId, touchNumber = 1) {
  return `campaign_target_one:${clean(campaignTargetId)}:t${Number(touchNumber) || 1}`
}

/**
 * Select a sender for the target's market.
 *
 * Deliberately narrow: active, healthy, with remaining daily capacity, and
 * never equal to the recipient. Lowest usage first so canary traffic spreads.
 */
async function resolveSender(supabase, { market, recipient }) {
  const { data, error } = await supabase
    .from('textgrid_numbers')
    .select('id, phone_number, market, status, daily_limit, messages_sent_today, health_score')
    .eq('status', 'active')
    .eq('market', market)
    .order('messages_sent_today', { ascending: true })
    .range(0, 99)

  if (error) throw error

  const candidates = (Array.isArray(data) ? data : []).filter((row) => {
    const phone = clean(row.phone_number)
    if (!phone || phone === recipient) return false
    const limit = Number(row.daily_limit)
    const used = Number(row.messages_sent_today ?? 0)
    if (!Number.isFinite(limit) || limit <= 0) return false
    if (Number.isFinite(used) && used >= limit) return false
    return true
  })

  return candidates[0] || null
}

/**
 * Enqueue exactly one send_queue row for exactly one campaign target.
 *
 * @param {string} campaignTargetId
 * @param {object} deps  { supabase, insertQueueImpl?, now? }
 * @returns {Promise<object>} { created, queue_row_id?, reason?, review? }
 */
export async function enqueueCampaignTargetOne(campaignTargetId, deps = {}) {
  const supabase = deps.supabase
  const insertQueue = deps.insertQueueImpl || insertSupabaseSendQueueRow
  const nowIso = deps.now || new Date().toISOString()
  const requestedId = clean(campaignTargetId)

  if (!requestedId) return fail(ENQUEUE_REASON.TARGET_NOT_FOUND, 'empty campaign_target_id')

  // ── 1. Load the target ──────────────────────────────────────────────────
  const { data: target, error: targetErr } = await supabase
    .from('campaign_targets')
    .select('*')
    .eq('id', requestedId)
    .maybeSingle()
  if (targetErr) throw targetErr
  if (!target) return fail(ENQUEUE_REASON.TARGET_NOT_FOUND, requestedId)

  // ── 2. Campaign identity ────────────────────────────────────────────────
  if (!clean(target.campaign_id)) return fail(ENQUEUE_REASON.CAMPAIGN_MISSING, 'no campaign_id')
  const { data: campaign, error: campErr } = await supabase
    .from('campaigns')
    .select('id, name')
    .eq('id', target.campaign_id)
    .maybeSingle()
  if (campErr) throw campErr
  if (!campaign) return fail(ENQUEUE_REASON.CAMPAIGN_MISSING, clean(target.campaign_id))

  // ── 3. Lifecycle ────────────────────────────────────────────────────────
  if (clean(target.target_status) !== 'ready') {
    return fail(ENQUEUE_REASON.TARGET_NOT_READY, clean(target.target_status) || 'unset')
  }
  if (clean(target.routing_status) !== 'ready' || clean(target.identity_status) !== 'verified') {
    return fail(ENQUEUE_REASON.BLOCKED, `routing=${target.routing_status} identity=${target.identity_status}`)
  }
  if (clean(target.suppression_status) !== 'clear') {
    return fail(ENQUEUE_REASON.SUPPRESSED, clean(target.suppression_status) || 'unset')
  }

  // ── 4. Recipient ────────────────────────────────────────────────────────
  const recipient = clean(target.to_phone_number)
  if (!/^\+1[2-9][0-9]{9}$/.test(recipient)) {
    return fail(ENQUEUE_REASON.INVALID_RECIPIENT, recipient || 'empty')
  }

  // ── 5. Compliance ───────────────────────────────────────────────────────
  const { data: dnc, error: dncErr } = await supabase
    .from('sms_suppression_list')
    .select('id, is_active')
    .eq('phone_e164', recipient)
    .range(0, 49)
  if (dncErr) throw dncErr
  if ((dnc || []).some((row) => row.is_active !== false)) {
    return fail(ENQUEUE_REASON.DNC, recipient.slice(-4))
  }

  const { data: autoSuppress, error: autoErr } = await supabase
    .from('automation_suppressions')
    .select('id, expires_at')
    .eq('phone_e164', recipient)
    .range(0, 49)
  if (autoErr) throw autoErr
  const activeSuppression = (autoSuppress || []).some((row) => {
    const expires = clean(row.expires_at)
    return !expires || new Date(expires).getTime() > new Date(nowIso).getTime()
  })
  if (activeSuppression) return fail(ENQUEUE_REASON.AUTOMATION_SUPPRESSED, recipient.slice(-4))

  // ── 6. Prior contact and live rows ──────────────────────────────────────
  // Checked by recipient number, not just by target: contacting the same human
  // twice is the harm, regardless of which target row initiated it.
  const { data: priorRows, error: priorErr } = await supabase
    .from('send_queue')
    .select('id, queue_status, campaign_target_id')
    .eq('to_phone_number', recipient)
    .in('queue_status', [...LIVE_QUEUE_STATUSES, ...CONSUMED_QUEUE_STATUSES])
    .range(0, 199)
  if (priorErr) throw priorErr

  const live = (priorRows || []).find((r) => LIVE_QUEUE_STATUSES.includes(clean(r.queue_status)))
  if (live) {
    return {
      created: false,
      reason: ENQUEUE_REASON.ALREADY_QUEUED,
      queue_row_id: live.id,
      requested_campaign_target_id: requestedId,
      resulting_campaign_target_id: live.campaign_target_id ?? null,
    }
  }
  if ((priorRows || []).length > 0) {
    return fail(ENQUEUE_REASON.PRIOR_CONTACT, `${priorRows.length} prior row(s)`)
  }

  // ── 7. Template + governance (reuses #91) ───────────────────────────────
  const metadata = target.metadata && typeof target.metadata === 'object' && !Array.isArray(target.metadata)
    ? target.metadata
    : {}
  const templateId = clean(metadata.template_id)
  if (!templateId) return fail(ENQUEUE_REASON.TEMPLATE_MISSING)

  const { data: template, error: tplErr } = await supabase
    .from('sms_templates')
    .select('*')
    .eq('template_id', templateId)
    .maybeSingle()
  if (tplErr) throw tplErr
  if (!template) return fail(ENQUEUE_REASON.TEMPLATE_NOT_FOUND, templateId)

  const { data: govRows, error: govErr } = await supabase
    .from('ownership_template_rotation_control')
    .select('template_id, rotation_status, language, daily_cap, last_40d_total_sent')
    .eq('template_id', templateId)
    .range(0, 9)
  if (govErr) throw govErr

  const useCase = clean(template.use_case) || 'ownership_check'
  const { eligible, rejected } = applyGovernance([template], indexGovernance(govRows || []), useCase)
  if (eligible.length !== 1) {
    return fail(ENQUEUE_REASON.TEMPLATE_UNGOVERNED, rejected[0]?.reason || 'not_eligible')
  }

  if (clean(template.language).toLowerCase() !== clean(target.language).toLowerCase()) {
    return fail(ENQUEUE_REASON.LANGUAGE_MISMATCH, `${template.language} vs ${target.language}`)
  }

  // ── 8. Contact window (reuses #91) ──────────────────────────────────────
  const { data: property, error: propErr } = await supabase
    .from('properties')
    .select('property_id, property_address_state, property_address_zip')
    .eq('property_id', target.property_id)
    .maybeSingle()
  if (propErr) throw propErr

  const tz = resolveContactTimezone({
    storedTimezone: target.timezone,
    propertyState: property?.property_address_state,
    propertyZip: property?.property_address_zip,
    targetState: target.state,
  })
  if (tz.status === TZ_STATUS.AMBIGUOUS || tz.status === TZ_STATUS.MISSING) {
    return fail(ENQUEUE_REASON.TZ_UNRESOLVED, tz.reason)
  }

  const window = isWithinContactWindow(new Date(nowIso), tz.iana, WINDOW_START_HOUR, WINDOW_END_HOUR)
  if (!window.ok) return fail(ENQUEUE_REASON.OUTSIDE_WINDOW, window.reason)

  // ── 9. Identity + render (reuses #92 and #91) ───────────────────────────
  const { data: owner, error: ownerErr } = await supabase
    .from('master_owners')
    .select('master_owner_id, agent_persona')
    .eq('master_owner_id', target.master_owner_id)
    .maybeSingle()
  if (ownerErr) throw ownerErr

  const merge = buildOutboundMergeValues({ target, masterOwner: owner })
  if (!merge.ok) return fail(ENQUEUE_REASON.IDENTITY_MISSING, merge.reason)

  const rendered = renderTemplateBody(template.template_body, merge.values)
  if (!rendered.ok) {
    return fail(ENQUEUE_REASON.RENDER_FAILED, `${rendered.reason}:${(rendered.missing || []).join(',')}`)
  }

  // ── 10. Sender ──────────────────────────────────────────────────────────
  const sender = await resolveSender(supabase, { market: clean(target.market), recipient })
  if (!sender) return fail(ENQUEUE_REASON.NO_SENDER, clean(target.market) || 'no_market')
  const senderPhone = clean(sender.phone_number)
  if (senderPhone === recipient) return fail(ENQUEUE_REASON.SENDER_IS_RECIPIENT)

  // ── 11. Build exactly one row ───────────────────────────────────────────
  const touchNumber = Number(target.touch_number) || 1
  const queueKey = buildCampaignTargetQueueKey(requestedId, touchNumber)

  const payload = {
    queue_key: queueKey,
    queue_status: 'queued',
    scheduled_for: nowIso,
    scheduled_for_utc: nowIso,
    timezone: tz.timezone,
    message_body: rendered.body,
    message_text: rendered.body,
    to_phone_number: recipient,
    from_phone_number: senderPhone,
    // The pre-claim validator rejects a non-canonical thread_key, so it must
    // equal the destination number.
    thread_key: recipient,
    type: 'outbound',
    message_type: useCase,
    use_case_template: useCase,
    template_id: templateId,
    selected_template_id: templateId,
    seller_first_name: merge.values.seller_first_name,
    agent_name: merge.values.agent_name,
    language: clean(target.language),
    touch_number: touchNumber,
    market: clean(target.market),
    property_address: clean(target.property_address),
    property_id: target.property_id || null,
    master_owner_id: target.master_owner_id || null,
    prospect_id: target.prospect_id || null,
    phone_id: target.phone_id || null,
    textgrid_number_id: sender.id || null,
    campaign_id: target.campaign_id,
    campaign_target_id: requestedId,
    source: 'campaign_target_one',
    metadata: {
      source: 'enqueue_campaign_target_one',
      campaign_target_id: requestedId,
      selected_template_id: templateId,
      template_id: templateId,
      template_name: template.template_name || null,
      agent_persona: merge.persona,
      agent_name: merge.values.agent_name,
      seller_first_name: merge.values.seller_first_name,
      language: clean(target.language),
      timezone_status: tz.status,
      timezone_basis: tz.basis,
      // Required by the pre-claim validator (getCandidateSnapshot).
      candidate_snapshot: {
        ...(metadata.candidate_snapshot && typeof metadata.candidate_snapshot === 'object'
          ? metadata.candidate_snapshot
          : {}),
        seller_first_name: merge.values.seller_first_name,
        property_address: merge.values.property_address,
        campaign_target_id: requestedId,
      },
      no_direct_provider_send: true,
    },
  }

  // ── 12. Insert, with the unique index as the concurrency guarantee ──────
  let insert
  try {
    insert = await insertQueue(payload, { supabase, ...deps })
  } catch (err) {
    // 23505 = unique_violation on send_queue_queue_key_key. Another request for
    // this exact target/touch won the race; by definition it created the row we
    // would have created, so this is `already_queued`, not an error.
    const code = err?.code || err?.details?.code
    const message = clean(err?.message)
    if (code === '23505' || message.includes('duplicate key') || message.includes('send_queue_queue_key_key')) {
      const { data: existing } = await supabase
        .from('send_queue')
        .select('id, campaign_target_id')
        .eq('queue_key', queueKey)
        .maybeSingle()
      return {
        created: false,
        reason: ENQUEUE_REASON.ALREADY_QUEUED,
        queue_row_id: existing?.id ?? null,
        requested_campaign_target_id: requestedId,
        resulting_campaign_target_id: existing?.campaign_target_id ?? null,
      }
    }
    logger.error('enqueue_campaign_target_one.insert_error', { error: message })
    return fail(ENQUEUE_REASON.INSERT_FAILED, message)
  }

  const queueRowId = insert?.queue_row_id || insert?.item_id || insert?.id || null
  if (!queueRowId) return fail(ENQUEUE_REASON.INSERT_FAILED, 'no queue_row_id returned')

  // ── 13. The invariant ───────────────────────────────────────────────────
  // Read back and prove the row we created belongs to the target we were asked
  // for. A mismatch means something substituted a different recipient, which is
  // the one failure mode this primitive exists to make impossible — so it is
  // fatal and loud rather than a warning.
  const { data: readback, error: readErr } = await supabase
    .from('send_queue')
    .select('id, campaign_target_id, queue_status, to_phone_number, from_phone_number')
    .eq('id', queueRowId)
    .maybeSingle()
  if (readErr) throw readErr

  const resultingId = clean(readback?.campaign_target_id)
  if (resultingId !== requestedId) {
    logger.error('enqueue_campaign_target_one.invariant_violation', {
      requested: requestedId,
      resulting: resultingId || null,
      queue_row_id: queueRowId,
    })
    return {
      created: false,
      reason: ENQUEUE_REASON.INVARIANT_VIOLATION,
      queue_row_id: queueRowId,
      requested_campaign_target_id: requestedId,
      resulting_campaign_target_id: resultingId || null,
      fatal: true,
    }
  }

  return {
    created: true,
    queue_row_id: queueRowId,
    requested_campaign_target_id: requestedId,
    resulting_campaign_target_id: resultingId,
    review: {
      queue_row_id: queueRowId,
      campaign_target_id: requestedId,
      campaign_id: target.campaign_id,
      campaign_name: campaign.name,
      property_address: clean(target.property_address),
      recipient_last4: recipient.slice(-4),
      sender_last4: senderPhone.slice(-4),
      template_id: templateId,
      language: clean(target.language),
      agent_name: merge.values.agent_name,
      timezone: tz.timezone,
      timezone_status: tz.status,
      rendered_body: rendered.body,
      suppression_status: clean(target.suppression_status),
      queue_status: clean(readback?.queue_status) || 'queued',
    },
  }
}

/**
 * Dry-run: run every validation and produce the exact row that WOULD be
 * created, without inserting.
 *
 * Shares the whole code path with the real call — the only difference is that
 * the insert is replaced by a capture. That is what makes the preview
 * trustworthy: it cannot validate differently from the thing it previews.
 */
export async function previewCampaignTargetOne(campaignTargetId, deps = {}) {
  let captured = null
  const result = await enqueueCampaignTargetOne(campaignTargetId, {
    ...deps,
    insertQueueImpl: async (payload) => {
      captured = payload
      return { queue_row_id: `dry-run:${clean(campaignTargetId)}` }
    },
    // Read-back is satisfied from the captured payload so the invariant check
    // still runs against what would have been written.
    supabase: wrapSupabaseForDryRun(deps.supabase, () => captured),
  })
  return { ...result, dry_run: true, would_insert: captured }
}

/**
 * Intercepts only the post-insert read-back of send_queue by id, so the
 * invariant check exercises the payload we would have written. Every other
 * query passes through untouched.
 */
function wrapSupabaseForDryRun(supabase, getCaptured) {
  return {
    ...supabase,
    from(table) {
      const builder = supabase.from(table)
      if (table !== 'send_queue') return builder
      return {
        ...builder,
        select(cols) {
          const inner = builder.select(cols)
          return {
            ...inner,
            eq(column, value) {
              const eqInner = inner.eq(column, value)
              if (column !== 'id' || !String(value).startsWith('dry-run:')) return eqInner
              return {
                ...eqInner,
                maybeSingle: async () => {
                  const captured = getCaptured()
                  return {
                    data: captured
                      ? {
                          id: value,
                          campaign_target_id: captured.campaign_target_id,
                          queue_status: captured.queue_status,
                          to_phone_number: captured.to_phone_number,
                          from_phone_number: captured.from_phone_number,
                        }
                      : null,
                    error: null,
                  }
                },
              }
            },
          }
        },
      }
    },
  }
}
