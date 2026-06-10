import type { CommandResult, GlobalCommandProvider } from '../../../domain/command-center/command.types'
import { canUseSupabaseSearch, getSupabaseSearchClient, limitResults, sanitizeIlike, withScoredResult } from './providerUtils'

type QueueRow = Record<string, unknown>

const asText = (value: unknown): string => String(value ?? '').trim()

const mapQueueRow = (row: QueueRow): CommandResult => {
  const propertyAddress = asText(row.property_address) || 'Property not resolved'
  const status = asText(row.queue_status) || 'unknown'
  const market = asText(row.market)
  const phone = asText(row.to_phone_number)
  const scheduledFor = asText(row.scheduled_for || row.scheduled_for_local)
  const blockedReason = asText(row.blocked_reason || row.failed_reason || row.paused_reason)

  return {
    id: `queue-${asText(row.queue_id || row.id || phone)}`,
    type: 'queue',
    title: propertyAddress,
    subtitle: [market, phone].filter(Boolean).join(' · '),
    description: [status, blockedReason || scheduledFor].filter(Boolean).join(' · '),
    badge: status,
    icon: 'send',
    route: '/inbox',
    score: 24,
    payload: {
      kind: 'focus_queue_row',
      queueId: asText(row.queue_id || row.id),
    },
    preview: {
      eyebrow: 'Queue',
      title: propertyAddress,
      summary: [status, blockedReason].filter(Boolean).join(' · ') || 'Queue item',
      details: [
        { label: 'Market', value: market || '—' },
        { label: 'Phone', value: phone || '—' },
        { label: 'Scheduled', value: scheduledFor || '—' },
        { label: 'Blocked / Failed', value: blockedReason || '—' },
      ],
    },
    meta: {
      provider: 'queue',
      groupLabel: 'Queue',
      keywords: [propertyAddress, market, phone, status, blockedReason].filter(Boolean),
    },
  }
}

export const queueSearchProvider: GlobalCommandProvider = {
  id: 'queue',
  search: async (query, context) => {
    if (!canUseSupabaseSearch(query)) return []
    const supabase = getSupabaseSearchClient()
    const term = `%${sanitizeIlike(query)}%`
    const { data, error } = await supabase
      .from('send_queue')
      .select('id,queue_id,queue_status,to_phone_number,property_address,market,scheduled_for,scheduled_for_local,failed_reason,blocked_reason,paused_reason')
      .or([
        `queue_status.ilike.${term}`,
        `to_phone_number.ilike.${term}`,
        `property_address.ilike.${term}`,
        `market.ilike.${term}`,
        `failed_reason.ilike.${term}`,
        `blocked_reason.ilike.${term}`,
      ].join(','))
      .limit(10)

    if (error || !data) return []
    return limitResults((data as QueueRow[]).map((row) => withScoredResult(mapQueueRow(row), query, context, asText(row.property_address), asText(row.market), asText(row.queue_status), asText(row.to_phone_number))), 10)
  },
}
