/**
 * notification-action-executor.js
 *
 * Executes operator actions from notification HUD.
 * Wires to REAL mutations; audits every action.
 * NEVER retry/reactivate STOP/opt-out/DNC/blacklist recipients.
 */

import { supabase } from '@/lib/supabase/client.js'
import { child } from '@/lib/logging/logger.js'
import { applyCampaignLifecycleAction } from '@/lib/domain/campaigns/campaign-automation-service.js'
import { transitionCampaignStatus } from '@/lib/domain/campaigns/campaign-state-machine.js'
import {
  writeNotificationActionAudit,
  dismissNotification,
  clearNotification,
  markRead,
  snoozeNotification,
  resolveNotificationByGroupingKey,
  __setDeps as __setServiceDeps,
  __resetDeps as __resetServiceDeps,
} from './notification-intelligence-service.js'

const logger = child({ module: 'domain.notifications.action-executor' })

const FORBIDDEN_REACTIVATION_ACTIONS = new Set([
  'retry_opt_out',
  'reactivate_opt_out',
  'retry_stop',
  'reactivate_stop',
  'retry_dnc',
  'reactivate_dnc',
  'retry_blacklist',
  'reactivate_blacklist',
  'unsuppress',
])

let _deps = { supabase_override: null }

export function __setDeps(overrides = {}) {
  _deps = { ..._deps, ...overrides }
  if (overrides.supabase_override) {
    __setServiceDeps({ supabase_override: overrides.supabase_override })
  }
}

export function __resetDeps() {
  _deps = { supabase_override: null }
  __resetServiceDeps()
}

function getDb() {
  return _deps.supabase_override ?? supabase
}

function clean(value) {
  return String(value ?? '').trim()
}

function navigationPayload(notification, route) {
  return {
    ok: true,
    action_type: 'navigate',
    navigation: { route, params: buildRouteParams(notification) },
  }
}

function buildRouteParams(notification = {}) {
  const params = {}
  if (notification.campaign_id) params.campaign_id = notification.campaign_id
  if (notification.template_id) params.template_id = notification.template_id
  if (notification.sender_number_id) params.sender_number_id = notification.sender_number_id
  if (notification.market_id) params.market_id = notification.market_id
  if (notification.workflow_id) params.workflow_id = notification.workflow_id
  if (notification.closing_id) params.closing_id = notification.closing_id
  if (notification.property_id) params.property_id = notification.property_id
  if (notification.participant_id) params.thread_key = notification.participant_id
  return params
}

function inspectRoute(domain, notification) {
  const routes = {
    campaigns: '/campaigns',
    templates: '/queue/templates',
    numbers: '/queue/senders',
    markets: '/entity-graph',
    inbox: '/inbox',
    workflow: '/workflow-studio',
    closing: '/closing-desk',
    acquisition: '/properties',
    platform: '/queue',
    intelligence: '/metrics',
  }
  const base = routes[domain] || '/'
  return navigationPayload(notification, base)
}

async function loadNotification(notificationId) {
  const db = getDb()
  const { data, error } = await db
    .from('notification_events')
    .select('*')
    .eq('id', notificationId)
    .maybeSingle()

  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: false, error: 'notification_not_found' }
  return { ok: true, notification: data }
}

async function pauseTemplate(templateId, operatorId) {
  const db = getDb()
  const { data, error } = await db
    .from('templates')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', templateId)
    .select('id,is_active')
    .maybeSingle()

  if (error) return { ok: false, error: error.message, outcome: 'template_pause_failed' }
  return { ok: true, outcome: 'template_paused', template: data, operator_id: operatorId }
}

async function resumeTemplate(templateId, operatorId) {
  const db = getDb()
  const { data, error } = await db
    .from('templates')
    .update({ is_active: true, updated_at: new Date().toISOString() })
    .eq('id', templateId)
    .select('id,is_active')
    .maybeSingle()

  if (error) return { ok: false, error: error.message, outcome: 'template_resume_failed' }
  return { ok: true, outcome: 'template_resumed', template: data, operator_id: operatorId }
}

async function pauseSender(senderNumberId, operatorId) {
  const db = getDb()
  const normalized = clean(senderNumberId)

  let query = db.from('textgrid_numbers').update({
    is_active: false,
    paused: true,
    updated_at: new Date().toISOString(),
  })

  if (normalized.startsWith('+')) {
    query = query.eq('phone_number', normalized)
  } else {
    query = query.or(`id.eq.${normalized},phone_number.eq.${normalized}`)
  }

  const { data, error } = await query.select('id,phone_number,is_active,paused').maybeSingle()
  if (error) return { ok: false, error: error.message, outcome: 'sender_pause_failed' }
  return { ok: true, outcome: 'sender_paused', sender: data, operator_id: operatorId }
}

async function resumeSender(senderNumberId, operatorId) {
  const db = getDb()
  const normalized = clean(senderNumberId)

  let query = db.from('textgrid_numbers').update({
    is_active: true,
    paused: false,
    updated_at: new Date().toISOString(),
  })

  if (normalized.startsWith('+')) {
    query = query.eq('phone_number', normalized)
  } else {
    query = query.or(`id.eq.${normalized},phone_number.eq.${normalized}`)
  }

  const { data, error } = await query.select('id,phone_number,is_active,paused').maybeSingle()
  if (error) return { ok: false, error: error.message, outcome: 'sender_resume_failed' }
  return { ok: true, outcome: 'sender_resumed', sender: data, operator_id: operatorId }
}

/**
 * Execute a notification action.
 *
 * @param {string} notificationId
 * @param {string} actionType
 * @param {string} operatorId
 * @param {object} [opts]
 * @returns {Promise<object>}
 */
export async function executeNotificationAction(notificationId, actionType, operatorId, opts = {}) {
  const action = clean(actionType).toLowerCase()
  const operator = clean(operatorId) || 'operator'

  if (FORBIDDEN_REACTIVATION_ACTIONS.has(action)) {
    const blocked = {
      ok: false,
      error: 'forbidden_reactivation_action',
      outcome: 'blocked_compliance',
      message: 'Cannot retry or reactivate STOP/opt-out/DNC/blacklist recipients.',
    }
    await writeNotificationActionAudit({
      notification_id: notificationId,
      action_type: action,
      operator_id: operator,
      outcome: blocked.outcome,
      details: blocked,
    })
    return blocked
  }

  const loaded = await loadNotification(notificationId)
  if (!loaded.ok) return loaded
  const notification = loaded.notification

  let result = { ok: false, error: `unknown_action:${action}` }

  try {
    switch (action) {
      case 'pause_campaign': {
        if (!notification.campaign_id) {
          result = { ok: false, error: 'missing_campaign_id', outcome: 'missing_entity' }
          break
        }
        const lifecycle = await applyCampaignLifecycleAction(
          notification.campaign_id,
          { action: 'pause', reason: `notification:${notificationId}` },
          { supabase: getDb() },
        )
        result = lifecycle.ok
          ? { ok: true, outcome: 'campaign_paused', lifecycle }
          : { ok: false, error: lifecycle.error, outcome: 'campaign_pause_failed', lifecycle }
        break
      }

      case 'resume_campaign': {
        if (!notification.campaign_id) {
          result = { ok: false, error: 'missing_campaign_id', outcome: 'missing_entity' }
          break
        }
        const lifecycle = await applyCampaignLifecycleAction(
          notification.campaign_id,
          { action: 'resume', reason: `notification:${notificationId}` },
          { supabase: getDb() },
        )
        result = lifecycle.ok
          ? { ok: true, outcome: 'campaign_resumed', lifecycle }
          : { ok: false, error: lifecycle.error, outcome: 'campaign_resume_failed', lifecycle }
        break
      }

      case 'scale_campaign': {
        if (!notification.campaign_id) {
          result = { ok: false, error: 'missing_campaign_id', outcome: 'missing_entity' }
          break
        }
        const rec = notification.recommendation || {}
        const proposedCap = Number(rec.proposed_cap || 0)
        if (proposedCap > 0) {
          const { error } = await getDb()
            .from('campaigns')
            .update({ daily_cap: proposedCap, updated_at: new Date().toISOString() })
            .eq('id', notification.campaign_id)
          if (error) {
            result = { ok: false, error: error.message, outcome: 'scale_update_failed' }
            break
          }
        }
        const lifecycle = await transitionCampaignStatus(
          getDb(),
          notification.campaign_id,
          'active',
          { reason: `notification_scale:${notificationId}` },
        )
        result = lifecycle.ok
          ? { ok: true, outcome: 'campaign_scaled', proposed_cap: proposedCap, lifecycle }
          : { ok: false, error: lifecycle.error, outcome: 'campaign_scale_failed', lifecycle }
        break
      }

      case 'approve_scale':
        result = await executeNotificationAction(notificationId, 'scale_campaign', operator, opts)
        break

      case 'approve_pause':
        result = await executeNotificationAction(notificationId, 'pause_campaign', operator, opts)
        break

      case 'pause_template': {
        const templateId = notification.template_id || notification.source_entity_id
        if (!templateId) {
          result = { ok: false, error: 'missing_template_id', outcome: 'missing_entity' }
          break
        }
        result = await pauseTemplate(templateId, operator)
        break
      }

      case 'resume_template': {
        const templateId = notification.template_id || notification.source_entity_id
        if (!templateId) {
          result = { ok: false, error: 'missing_template_id', outcome: 'missing_entity' }
          break
        }
        result = await resumeTemplate(templateId, operator)
        break
      }

      case 'pause_sender': {
        const senderId = notification.sender_number_id || notification.source_entity_id
        if (!senderId) {
          result = { ok: false, error: 'missing_sender_id', outcome: 'missing_entity' }
          break
        }
        result = await pauseSender(senderId, operator)
        break
      }

      case 'resume_sender': {
        const senderId = notification.sender_number_id || notification.source_entity_id
        if (!senderId) {
          result = { ok: false, error: 'missing_sender_id', outcome: 'missing_entity' }
          break
        }
        result = await resumeSender(senderId, operator)
        break
      }

      case 'inspect_campaign':
        result = inspectRoute('campaigns', notification)
        break
      case 'inspect_template':
        result = inspectRoute('templates', notification)
        break
      case 'inspect_sender':
        result = inspectRoute('numbers', notification)
        break
      case 'inspect_thread':
        result = navigationPayload(notification, '/inbox')
        break
      case 'star_thread':
      case 'unstar_thread':
      case 'pin_thread':
      case 'unpin_thread':
      case 'archive_conversation':
      case 'archive_lead':
      case 'restore_lead':
      case 'snooze_thread': {
        const threadKey = clean(notification.participant_id || notification.thread_key || notification.source_entity_id)
        if (!threadKey) {
          result = { ok: false, error: 'missing_thread_key', outcome: 'missing_entity' }
          break
        }
        const { patchUniversalLeadState } = await import('@/lib/domain/lead-state/patch-universal-lead-state.js')
        const patch = {}
        if (action === 'star_thread') patch.is_starred = true
        if (action === 'unstar_thread') patch.is_starred = false
        if (action === 'pin_thread') patch.is_pinned = true
        if (action === 'unpin_thread') patch.is_pinned = false
        if (action === 'archive_conversation') {
          patch.is_archived = true
          patch.archive_scope = 'conversation'
        }
        if (action === 'archive_lead') {
          patch.is_archived = true
          patch.archive_scope = 'lead'
          patch.paused_reason = 'archived_lead'
        }
        if (action === 'restore_lead') {
          patch.is_archived = false
          patch.archive_scope = null
          patch.paused_reason = null
        }
        if (action === 'snooze_thread') {
          const until = opts.snoozed_until || opts.until || new Date(Date.now() + 60 * 60 * 1000).toISOString()
          patch.snoozed_until = until
          patch.snooze_reason = clean(opts.reason) || 'notification_snooze'
        }
        const leadPatch = await patchUniversalLeadState({
          threadKey,
          patch,
          supabase: db,
          meta: {
            operator_id: operator,
            source_view: 'notification_action',
            reason: `notification:${action}`,
            change_source: 'manual',
          },
        })
        result = leadPatch.ok
          ? { ok: true, outcome: action, thread_key: threadKey, realtime_event: leadPatch.realtime_event }
          : { ok: false, error: leadPatch.reason || 'lead_state_patch_failed', outcome: 'lead_state_patch_failed' }
        break
      }
      case 'inspect_market':
        result = inspectRoute('markets', notification)
        break
      case 'inspect_queue':
        result = inspectRoute('platform', notification)
        break
      case 'inspect_workflow':
        result = inspectRoute('workflow', notification)
        break
      case 'inspect_closing':
        result = inspectRoute('closing', notification)
        break
      case 'open_workflow':
        result = navigationPayload(notification, `/workflow-studio/${notification.workflow_id || ''}`)
        break
      case 'open_closing_case':
        result = navigationPayload(notification, `/closing-desk/${notification.closing_id || ''}`)
        break
      case 'navigate':
        result = inspectRoute(notification.domain, notification)
        break

      case 'dismiss':
        result = await dismissNotification(notificationId)
        result = { ...result, outcome: result.ok ? 'dismissed' : 'dismiss_failed' }
        break
      case 'mark_read':
        result = await markRead(notificationId)
        result = { ...result, outcome: result.ok ? 'marked_read' : 'mark_read_failed' }
        break
      case 'snooze':
        result = await snoozeNotification(notificationId, opts.snoozed_until || opts.until)
        result = { ...result, outcome: result.ok ? 'snoozed' : 'snooze_failed' }
        break
      case 'clear':
      case 'resolve':
        result = await clearNotification(notificationId)
        result = { ...result, outcome: result.ok ? 'cleared' : 'clear_failed' }
        if (result.ok && notification.grouping_key) {
          await resolveNotificationByGroupingKey(notification.grouping_key, `action:${action}`)
        }
        break
      case 'acknowledge':
        result = await markRead(notificationId)
        result = { ...result, outcome: result.ok ? 'acknowledged' : 'acknowledge_failed' }
        break
      case 'run_scan': {
        const { runNotificationIntelligenceScan } = await import('./notification-scanners.js')
        const scan = await runNotificationIntelligenceScan({ dry_run: false })
        result = { ok: true, outcome: 'scan_triggered', scan }
        break
      }
      case 'retry_queue_item':
        result = {
          ok: false,
          error: 'retry_queue_item_requires_explicit_queue_id',
          outcome: 'blocked_manual_retry',
          message: 'Queue retry must be initiated from queue inspector with explicit queue item ID.',
        }
        break
      case 'mute_domain':
      case 'mute_entity':
        result = {
          ok: true,
          outcome: 'mute_deferred_to_preferences',
          message: 'Use notification preferences endpoint to persist mutes.',
        }
        break
      default:
        result = { ok: false, error: `unknown_action:${action}`, outcome: 'unknown_action' }
    }
  } catch (err) {
    logger.warn('notification.action_failed', { action, error: String(err?.message ?? err) })
    result = { ok: false, error: String(err?.message ?? err), outcome: 'action_exception' }
  }

  await writeNotificationActionAudit({
    notification_id: notificationId,
    action_type: action,
    operator_id: operator,
    outcome: result.outcome || (result.ok ? 'success' : 'failed'),
    details: {
      result,
      notification_domain: notification.domain,
      event_type: notification.event_type,
    },
  })

  return { ...result, action_type: action, notification_id: notificationId }
}

export default executeNotificationAction