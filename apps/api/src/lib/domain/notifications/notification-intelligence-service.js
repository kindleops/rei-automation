/**
 * notification-intelligence-service.js
 *
 * Core service for LeadCommand Notification Intelligence.
 * Dedup-safe upsert, grouping evolution, operator state, rate limits, mutes.
 */

import { supabase } from '@/lib/supabase/client.js'
import { child } from '@/lib/logging/logger.js'
import {
  EVENT_CATALOG,
  NOTIFICATION_SEVERITIES,
  renderTitleTemplate,
  resolveEventCatalogEntry,
} from './notification-event-catalog.js'

const logger = child({ module: 'domain.notifications.intelligence-service' })

// ---------------------------------------------------------------------------
// Dependency injection (test support)
// ---------------------------------------------------------------------------

let _deps = {
  supabase_override: null,
  rate_limit_cache: new Map(),
  now_override: null,
}

export function __setDeps(overrides = {}) {
  _deps = { ..._deps, ...overrides }
}

export function __resetDeps() {
  _deps = {
    supabase_override: null,
    rate_limit_cache: new Map(),
    now_override: null,
  }
}

function getDb() {
  return _deps.supabase_override ?? supabase
}

function now() {
  return _deps.now_override ? new Date(_deps.now_override) : new Date()
}

function isMissingNotificationTableError(error) {
  const message = String(error?.message ?? error ?? '').toLowerCase()
  return (
    message.includes('schema cache')
    || message.includes('does not exist')
    || (message.includes('could not find the table') && (
      message.includes('notification_events')
      || message.includes('notification_preferences')
      || message.includes('notification_mutes')
      || message.includes('notification_audit')
    ))
  )
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

export const THRESHOLDS = {
  MIN_SAMPLE_SIZE: 50,
  SCALE_COOLDOWN_HOURS: 24,
  PAUSE_COOLDOWN_HOURS: 12,
  SCAN_COOLDOWN_MINUTES: 15,
  EMIT_COOLDOWN_MINUTES: 5,
  GROUP_EVOLUTION_WINDOW_HOURS: 24,
  MAX_ACTIVE_NOTIFICATIONS: 500,
  RATE_LIMIT_WINDOW_MS: 5 * 60 * 1000,
  DEFAULT_SNOOZE_MINUTES: 60,
  BULK_MAX_IDS: 200,
}

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

/**
 * Build a deterministic deduplication key.
 * Format: <event_type>:<entity_scope>:<YYYY-MM-DD> (UTC)
 */
export function buildDedupKey(eventType, entityScope = '', refDate = now()) {
  const dateStr = refDate.toISOString().slice(0, 10)
  const safeScope = String(entityScope).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120)
  return `${String(eventType)}:${safeScope}:${dateStr}`
}

/**
 * Build a grouping key for evolving grouped notifications.
 * Format: group:<event_type>:<entity_scope>
 */
export function buildGroupingKey(eventType, entityScope = '') {
  const safeScope = String(entityScope).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120)
  return `group:${String(eventType)}:${safeScope}`
}

function normalizeSeverity(value, fallback = 'neutral') {
  const v = String(value ?? '').trim().toLowerCase()
  return NOTIFICATION_SEVERITIES.includes(v) ? v : fallback
}

function interpolateDescription(description, groupCount) {
  if (!description) return description
  if (groupCount <= 1) return description
  return `${description} (${groupCount} occurrences)`
}

// ---------------------------------------------------------------------------
// Rate limiting (in-process, testable via __setDeps)
// ---------------------------------------------------------------------------

export function isRateLimited(dedupKey, windowMs = THRESHOLDS.RATE_LIMIT_WINDOW_MS) {
  const key = String(dedupKey ?? '')
  if (!key) return false
  const cache = _deps.rate_limit_cache
  const ts = cache.get(key)
  const current = now().getTime()
  if (ts && current - ts < windowMs) return true
  cache.set(key, current)
  return false
}

export function clearRateLimitCache() {
  _deps.rate_limit_cache.clear()
}

// ---------------------------------------------------------------------------
// Mute checks
// ---------------------------------------------------------------------------

/**
 * Check whether a notification should be suppressed for an operator.
 *
 * @param {string} scope - domain | event_type | entity
 * @param {string} targetId
 * @param {object} [preferences]
 * @returns {boolean}
 */
export function isMuted(scope, targetId, preferences = {}) {
  const mutes = Array.isArray(preferences.mutes) ? preferences.mutes : []
  const current = now()

  for (const mute of mutes) {
    if (String(mute.mute_scope) !== String(scope)) continue
    if (String(mute.mute_target_id) !== String(targetId)) continue
    if (mute.muted_until) {
      const until = new Date(mute.muted_until)
      if (Number.isFinite(until.getTime()) && until > current) return true
      continue
    }
    return true
  }

  const domainMutes = preferences.muted_domains
  if (scope === 'domain' && domainMutes && typeof domainMutes === 'object') {
    if (domainMutes[targetId] === true) return true
  }

  return false
}

// ---------------------------------------------------------------------------
// Upsert + grouping evolution
// ---------------------------------------------------------------------------

/**
 * Upsert a notification event. Dedupes by deduplication_key; evolves grouped
 * notifications by incrementing group_count and updating description.
 *
 * @param {object} fields
 * @returns {Promise<{ ok: boolean, id?: string, evolved?: boolean, skipped?: boolean, error?: string }>}
 */
export async function upsertNotificationEvent(fields = {}) {
  const db = getDb()
  const eventType = String(fields.event_type ?? '')
  const catalog = resolveEventCatalogEntry(eventType)
  const dedupKey = String(fields.deduplication_key ?? buildDedupKey(eventType, fields.source_entity_id || fields.campaign_id || ''))
  const groupingKey = fields.grouping_key != null
    ? String(fields.grouping_key)
    : (fields.group ? buildGroupingKey(eventType, fields.source_entity_id || fields.campaign_id || '') : null)

  if (!eventType) return { ok: false, error: 'event_type_required' }
  if (!dedupKey) return { ok: false, error: 'deduplication_key_required' }

  const titleVars = fields.title_vars || {}
  const titleTemplate = fields.title || catalog?.titleTemplate || eventType
  const title = titleTemplate.includes('{{')
    ? renderTitleTemplate(titleTemplate, titleVars)
    : String(titleTemplate)

  const baseRow = {
    event_type: eventType,
    domain: String(fields.domain ?? catalog?.domain ?? 'platform'),
    severity: normalizeSeverity(fields.severity, catalog?.defaultSeverity ?? 'neutral'),
    title,
    description: fields.description != null ? String(fields.description) : null,
    source_entity_type: fields.source_entity_type ?? null,
    source_entity_id: fields.source_entity_id != null ? String(fields.source_entity_id) : null,
    property_id: fields.property_id != null ? String(fields.property_id) : null,
    participant_id: fields.participant_id != null ? String(fields.participant_id) : null,
    campaign_id: fields.campaign_id ?? null,
    market_id: fields.market_id != null ? String(fields.market_id) : null,
    template_id: fields.template_id != null ? String(fields.template_id) : null,
    sender_number_id: fields.sender_number_id != null ? String(fields.sender_number_id) : null,
    workflow_id: fields.workflow_id != null ? String(fields.workflow_id) : null,
    deal_id: fields.deal_id != null ? String(fields.deal_id) : null,
    closing_id: fields.closing_id != null ? String(fields.closing_id) : null,
    metrics_snapshot: fields.metrics_snapshot ?? fields.metrics ?? {},
    recommendation: fields.recommendation ?? null,
    available_actions: fields.available_actions ?? catalog?.defaultActions ?? [],
    action_state: fields.action_state ?? {},
    sound_category: fields.sound_category ?? catalog?.soundCategory ?? 'ops',
    deduplication_key: dedupKey,
    grouping_key: groupingKey,
    status: fields.status ?? 'active',
    updated_at: now().toISOString(),
  }

  try {
    const { data: existing, error: readError } = await db
      .from('notification_events')
      .select('id, group_count, description, status, grouping_key')
      .eq('deduplication_key', dedupKey)
      .maybeSingle()

    if (readError) {
      logger.warn('notification.upsert_read_error', { error: readError.message })
      return { ok: false, error: readError.message }
    }

    if (existing) {
      const evolvedCount = Number(existing.group_count ?? 1) + 1
      const patch = {
        ...baseRow,
        group_count: evolvedCount,
        description: interpolateDescription(baseRow.description ?? existing.description, evolvedCount),
        status: existing.status === 'dismissed' ? 'active' : (baseRow.status || existing.status),
        dismissed_at: existing.status === 'dismissed' ? null : undefined,
        updated_at: now().toISOString(),
      }
      const { data, error } = await db
        .from('notification_events')
        .update(patch)
        .eq('id', existing.id)
        .select('id')
        .maybeSingle()

      if (error) {
        logger.warn('notification.upsert_evolve_error', { error: error.message })
        return { ok: false, error: error.message }
      }
      return { ok: true, id: data?.id ?? existing.id, evolved: true }
    }

    const insertRow = {
      ...baseRow,
      group_count: 1,
      created_at: now().toISOString(),
    }

    const { data, error } = await db
      .from('notification_events')
      .insert(insertRow)
      .select('id')
      .maybeSingle()

    if (error) {
      if (error.code === '23505' && groupingKey) {
        return evolveGroupedNotification(db, groupingKey, baseRow)
      }
      logger.warn('notification.upsert_insert_error', { error: error.message })
      return { ok: false, error: error.message }
    }

    return { ok: true, id: data?.id ?? null, evolved: false }
  } catch (err) {
    logger.warn('notification.upsert_exception', { error: String(err?.message ?? err) })
    return { ok: false, error: String(err?.message ?? err) }
  }
}

async function evolveGroupedNotification(db, groupingKey, baseRow) {
  const { data: grouped, error } = await db
    .from('notification_events')
    .select('id, group_count, description, status')
    .eq('grouping_key', groupingKey)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error || !grouped) return { ok: false, error: error?.message || 'group_evolve_failed' }

  const evolvedCount = Number(grouped.group_count ?? 1) + 1
  const patch = {
    ...baseRow,
    group_count: evolvedCount,
    description: interpolateDescription(baseRow.description ?? grouped.description, evolvedCount),
    metrics_snapshot: baseRow.metrics_snapshot,
    updated_at: now().toISOString(),
  }

  const { data, error: updateError } = await db
    .from('notification_events')
    .update(patch)
    .eq('id', grouped.id)
    .select('id')
    .maybeSingle()

  if (updateError) return { ok: false, error: updateError.message }
  return { ok: true, id: data?.id ?? grouped.id, evolved: true }
}

/**
 * Resolve all active notifications sharing a grouping key.
 */
export async function resolveNotificationByGroupingKey(groupingKey, reason = 'auto_resolved') {
  const db = getDb()
  if (!groupingKey) return { ok: false, error: 'grouping_key_required' }

  const nowIso = now().toISOString()
  try {
    const { data, error } = await db
      .from('notification_events')
      .update({
        status: 'resolved',
        resolved_at: nowIso,
        updated_at: nowIso,
        action_state: { resolve_reason: reason },
      })
      .eq('grouping_key', groupingKey)
      .eq('status', 'active')
      .select('id')

    if (error) return { ok: false, error: error.message }
    return { ok: true, resolved_count: data?.length ?? 0 }
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) }
  }
}

// ---------------------------------------------------------------------------
// Operator state mutations
// ---------------------------------------------------------------------------

async function patchNotification(id, patch) {
  const db = getDb()
  const { data, error } = await db
    .from('notification_events')
    .update({ ...patch, updated_at: now().toISOString() })
    .eq('id', id)
    .select('*')
    .maybeSingle()

  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: false, error: 'notification_not_found' }
  return { ok: true, notification: data }
}

export async function markRead(notificationId) {
  return patchNotification(notificationId, { read_at: now().toISOString() })
}

export async function markUnread(notificationId) {
  return patchNotification(notificationId, { read_at: null })
}

export async function dismissNotification(notificationId) {
  return patchNotification(notificationId, {
    status: 'dismissed',
    dismissed_at: now().toISOString(),
    read_at: now().toISOString(),
  })
}

export async function clearNotification(notificationId) {
  return patchNotification(notificationId, {
    status: 'resolved',
    resolved_at: now().toISOString(),
    read_at: now().toISOString(),
  })
}

export async function snoozeNotification(notificationId, until) {
  const snoozeUntil = until
    ? new Date(until).toISOString()
    : new Date(now().getTime() + THRESHOLDS.DEFAULT_SNOOZE_MINUTES * 60 * 1000).toISOString()
  return patchNotification(notificationId, { snoozed_until: snoozeUntil })
}

export async function bulkNotificationAction(ids = [], action = 'mark_read') {
  const db = getDb()
  const safeIds = [...new Set((ids || []).map(String))].slice(0, THRESHOLDS.BULK_MAX_IDS)
  if (!safeIds.length) return { ok: false, error: 'ids_required' }

  const nowIso = now().toISOString()
  let patch = {}

  switch (action) {
    case 'mark_read':
      patch = { read_at: nowIso }
      break
    case 'mark_unread':
      patch = { read_at: null }
      break
    case 'dismiss':
      patch = { status: 'dismissed', dismissed_at: nowIso, read_at: nowIso }
      break
    case 'clear':
      patch = { status: 'resolved', resolved_at: nowIso, read_at: nowIso }
      break
    default:
      return { ok: false, error: `unknown_bulk_action:${action}` }
  }

  try {
    const { data, error } = await db
      .from('notification_events')
      .update({ ...patch, updated_at: nowIso })
      .in('id', safeIds)
      .select('id')

    if (error) return { ok: false, error: error.message }
    return { ok: true, updated_count: data?.length ?? 0, ids: data?.map((r) => r.id) ?? [] }
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) }
  }
}

// ---------------------------------------------------------------------------
// List + preferences
// ---------------------------------------------------------------------------

export async function listNotificationEvents(filters = {}) {
  const db = getDb()
  const limit = Math.min(Number(filters.limit ?? 100), THRESHOLDS.MAX_ACTIVE_NOTIFICATIONS)
  const offset = Math.max(0, Number(filters.offset ?? 0))

  let query = db
    .from('notification_events')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (filters.status) query = query.eq('status', filters.status)
  else query = query.eq('status', 'active')

  if (filters.severity) {
    const severities = String(filters.severity).split(',').map((s) => s.trim()).filter(Boolean)
    if (severities.length === 1) query = query.eq('severity', severities[0])
    else if (severities.length > 1) query = query.in('severity', severities)
  }

  if (filters.domain) query = query.eq('domain', filters.domain)
  if (filters.unread === true || filters.unread === 'true') query = query.is('read_at', null)
  if (filters.campaign_id) query = query.eq('campaign_id', filters.campaign_id)

  if (filters.search) {
    const term = `%${String(filters.search).trim()}%`
    query = query.or(`title.ilike.${term},description.ilike.${term}`)
  }

  const snoozeCutoff = now().toISOString()
  query = query.or(`snoozed_until.is.null,snoozed_until.lte.${snoozeCutoff}`)

  const { data, error, count } = await query
  if (error) {
    if (isMissingNotificationTableError(error)) {
      return {
        ok: true,
        degraded: true,
        reason: 'notification_tables_missing',
        notifications: [],
        total: 0,
      }
    }
    return { ok: false, error: error.message, notifications: [] }
  }
  return { ok: true, notifications: data ?? [], total: count ?? data?.length ?? 0 }
}

export async function getNotificationPreferences(operatorId) {
  const db = getDb()
  if (!operatorId) return { ok: false, error: 'operator_id_required' }

  const { data, error } = await db
    .from('notification_preferences')
    .select('*')
    .eq('operator_id', operatorId)
    .maybeSingle()

  if (error) {
    if (isMissingNotificationTableError(error)) {
      return {
        ok: true,
        degraded: true,
        reason: 'notification_tables_missing',
        preferences: {},
        operator_id: operatorId,
        updated_at: null,
      }
    }
    return { ok: false, error: error.message }
  }
  return {
    ok: true,
    preferences: data?.preferences ?? {},
    operator_id: operatorId,
    updated_at: data?.updated_at ?? null,
  }
}

export async function upsertNotificationPreferences(operatorId, preferences = {}) {
  const db = getDb()
  if (!operatorId) return { ok: false, error: 'operator_id_required' }

  const row = {
    operator_id: operatorId,
    preferences,
    updated_at: now().toISOString(),
  }

  const { data, error } = await db
    .from('notification_preferences')
    .upsert(row, { onConflict: 'operator_id' })
    .select('*')
    .maybeSingle()

  if (error) return { ok: false, error: error.message }
  return { ok: true, preferences: data?.preferences ?? preferences, operator_id: operatorId }
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export async function writeNotificationActionAudit(fields = {}) {
  const db = getDb()
  try {
    await db.from('notification_action_audit').insert({
      notification_id: fields.notification_id,
      action_type: String(fields.action_type ?? ''),
      operator_id: fields.operator_id ?? null,
      outcome: String(fields.outcome ?? ''),
      details: fields.details ?? null,
      created_at: now().toISOString(),
    })
  } catch (err) {
    logger.warn('notification.audit_write_failed', { error: String(err?.message ?? err) })
  }
}

export function getCatalogStats() {
  const entries = Object.keys(EVENT_CATALOG)
  const byDomain = {}
  for (const [type, entry] of Object.entries(EVENT_CATALOG)) {
    byDomain[entry.domain] = (byDomain[entry.domain] || 0) + 1
  }
  return { event_types: entries.length, by_domain: byDomain }
}

export default {
  THRESHOLDS,
  upsertNotificationEvent,
  resolveNotificationByGroupingKey,
  markRead,
  markUnread,
  dismissNotification,
  clearNotification,
  snoozeNotification,
  bulkNotificationAction,
  listNotificationEvents,
  getNotificationPreferences,
  upsertNotificationPreferences,
  writeNotificationActionAudit,
  buildDedupKey,
  buildGroupingKey,
  isRateLimited,
  isMuted,
}