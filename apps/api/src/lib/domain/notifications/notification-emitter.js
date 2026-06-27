/**
 * notification-emitter.js
 *
 * Non-blocking emitter for business events → notification_events rows.
 */

import { child } from '@/lib/logging/logger.js'
import {
  resolveEventCatalogEntry,
  renderTitleTemplate,
} from './notification-event-catalog.js'
import {
  buildDedupKey,
  buildGroupingKey,
  isRateLimited,
  upsertNotificationEvent,
} from './notification-intelligence-service.js'

const logger = child({ module: 'domain.notifications.emitter' })

/**
 * Emit a notification from a business event. Non-blocking; errors are logged
 * silently and never thrown to callers.
 *
 * @param {object} opts
 * @param {string}   opts.eventType
 * @param {string}   [opts.severity]
 * @param {string}   [opts.title]
 * @param {string}   [opts.description]
 * @param {object}   [opts.metrics]
 * @param {object}   [opts.recommendation]
 * @param {object}   [opts.titleVars]
 * @param {boolean}  [opts.group]
 * @param {string}   [opts.campaignId]
 * @param {string}   [opts.templateId]
 * @param {string}   [opts.senderNumberId]
 * @param {string}   [opts.marketId]
 * @param {string}   [opts.workflowId]
 * @param {string}   [opts.propertyId]
 * @param {string}   [opts.participantId]
 * @param {string}   [opts.dealId]
 * @param {string}   [opts.closingId]
 * @param {string}   [opts.sourceEntityType]
 * @param {string}   [opts.sourceEntityId]
 * @param {string[]} [opts.availableActions]
 * @returns {Promise<{ ok: boolean, id?: string, skipped?: boolean }>}
 */
export async function emitNotificationFromBusinessEvent(opts = {}) {
  try {
    const eventType = String(opts.eventType ?? opts.event_type ?? '').trim()
    if (!eventType) return { ok: false, skipped: true, reason: 'missing_event_type' }

    const catalog = resolveEventCatalogEntry(eventType)
    if (!catalog) {
      logger.warn('notification.emit_unknown_event', { event_type: eventType })
      return { ok: false, skipped: true, reason: 'unknown_event_type' }
    }

    const entityScope =
      opts.sourceEntityId ||
      opts.campaignId ||
      opts.templateId ||
      opts.senderNumberId ||
      opts.marketId ||
      opts.workflowId ||
      opts.propertyId ||
      'global'

    const dedupKey = opts.deduplicationKey || buildDedupKey(eventType, entityScope)
    if (isRateLimited(dedupKey)) {
      return { ok: false, skipped: true, reason: 'rate_limited' }
    }

    const titleVars = opts.titleVars || {}
    const title = opts.title
      || renderTitleTemplate(catalog.titleTemplate, titleVars)

    const result = await upsertNotificationEvent({
      event_type: eventType,
      domain: catalog.domain,
      severity: opts.severity || catalog.defaultSeverity,
      title,
      description: opts.description || null,
      source_entity_type: opts.sourceEntityType || catalog.domain,
      source_entity_id: String(entityScope),
      property_id: opts.propertyId || null,
      participant_id: opts.participantId || null,
      campaign_id: opts.campaignId || null,
      market_id: opts.marketId || null,
      template_id: opts.templateId || null,
      sender_number_id: opts.senderNumberId || null,
      workflow_id: opts.workflowId || null,
      deal_id: opts.dealId || null,
      closing_id: opts.closingId || null,
      metrics_snapshot: opts.metrics || {},
      recommendation: opts.recommendation || null,
      available_actions: opts.availableActions || catalog.defaultActions,
      sound_category: catalog.soundCategory,
      deduplication_key: dedupKey,
      grouping_key: opts.group !== false ? buildGroupingKey(eventType, entityScope) : null,
      group: opts.group !== false,
      title_vars: titleVars,
    })

    return result
  } catch (err) {
    logger.warn('notification.emit_failed', { error: String(err?.message ?? err) })
    return { ok: false, skipped: true, reason: 'emit_exception' }
  }
}

export default emitNotificationFromBusinessEvent