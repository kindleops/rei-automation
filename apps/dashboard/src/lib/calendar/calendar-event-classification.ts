import type { CalendarEvent } from '../data/calendarData'

const HISTORICAL_TYPES = new Set([
  'sms_sent', 'sms_delivered', 'inbound_reply', 'positive_intent',
  'offer_created', 'offer_sent', 'fully_executed_contract', 'contract_sent',
  'buyer_packet_sent', 'underwriting_completed', 'historical_event',
])

const SCHEDULED_TYPES = new Set([
  'scheduled_sms', 'queue_retry', 'workflow_wake', 'workflow_task',
  'seller_follow_up', 'offer_expiration', 'offer_follow_up',
  'contract_signature_deadline', 'pipeline_next_action',
  'title_milestone', 'title_opened', 'clear_to_close', 'closing_scheduled',
  'buyer_follow_up', 'campaign_scheduled', 'manual_task', 'manual_reminder',
  'automation_blocked', 'workflow_blocked',
])

export type CalendarEventTiming = 'scheduled' | 'due' | 'completed' | 'historical' | 'canceled' | 'failed' | 'blocked' | 'overdue'

export function classifyEventTiming(event: CalendarEvent): CalendarEventTiming {
  if (event.overdue && !isHistoricalEvent(event)) return 'overdue'
  if (event.riskState === 'failed' || event.type === 'sms_failed') return 'failed'
  if (event.automationBlocked || event.type.includes('blocked')) return 'blocked'
  if (['cancelled', 'canceled', 'suppressed'].includes(event.status)) return 'canceled'
  if (isHistoricalEvent(event)) return 'historical'
  if (event.riskState === 'completed' || ['completed', 'delivered', 'sent', 'executed', 'signed'].includes(event.status)) {
    return 'completed'
  }
  if (SCHEDULED_TYPES.has(event.type)) return 'scheduled'
  return 'due'
}

export function isHistoricalEvent(event: CalendarEvent): boolean {
  if (HISTORICAL_TYPES.has(event.type)) return true
  if (event.readOnlyReason?.includes('historical')) return true
  if (event.riskState === 'historical' || event.riskState === 'completed') {
    if (!SCHEDULED_TYPES.has(event.type)) return true
  }
  if (['sms_sent', 'sms_delivered', 'inbound_reply'].includes(event.type)) return true
  const ts = new Date(event.timestamp).getTime()
  if (Number.isFinite(ts) && ts < Date.now() - 86400000) {
    if (!event.reschedulable && !SCHEDULED_TYPES.has(event.type)) return true
  }
  return false
}

export function isActionableEvent(event: CalendarEvent): boolean {
  if (isHistoricalEvent(event)) return false
  if (classifyEventTiming(event) === 'completed') return false
  if (classifyEventTiming(event) === 'historical') return false
  return true
}

export function filterViewEvents(events: CalendarEvent[], viewMode: 'month' | 'week' | 'day' | 'agenda' | 'timeline', includeHistorical = false): CalendarEvent[] {
  if (viewMode === 'timeline') return events
  if (viewMode === 'agenda' && includeHistorical) return events
  if (viewMode === 'agenda') return events.filter((e) => isActionableEvent(e) || e.overdue)
  return events.filter(isActionableEvent)
}