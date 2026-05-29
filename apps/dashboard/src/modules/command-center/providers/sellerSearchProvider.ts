import type { CommandResult, GlobalCommandProvider } from '../command.types'
import { canUseSupabaseSearch, getSupabaseSearchClient, limitResults, sanitizeIlike, withScoredResult } from './providerUtils'

type SellerRow = Record<string, unknown>

const asText = (value: unknown): string => String(value ?? '').trim()

const sellerNameFor = (row: SellerRow): string =>
  asText(row.seller_display_name)
  || asText(row.owner_display_name)
  || asText(row.owner_name)
  || asText(row.contact_name)
  || 'Owner not resolved'

const mapSellerRows = (rows: SellerRow): CommandResult[] => {
  const sellerName = sellerNameFor(rows)
  const address = asText(rows.property_address_full || rows.property_address) || 'Address not resolved'
  const market = asText(rows.market)
  const sellerState = asText(rows.seller_state || rows.seller_status) || 'unknown'
  const executionState = asText(rows.execution_state || rows.queue_status)
  const threadId = asText(rows.thread_key || rows.thread_id || rows.id)
  const phone = asText(rows.canonical_e164 || rows.phone || rows.phone_number)
  const email = asText(rows.email)

  const commonPayload = {
    kind: 'focus_thread',
    threadId,
    propertyId: asText(rows.property_id),
  }

  return [
    {
      id: `seller-${asText(rows.master_owner_id || rows.owner_id || rows.id)}`,
      type: 'seller',
      title: sellerName,
      subtitle: [address, market].filter(Boolean).join(' · '),
      description: [sellerState, executionState].filter(Boolean).join(' · '),
      badge: sellerState || 'Seller',
      icon: 'user',
      route: '/inbox',
      score: 24,
      payload: commonPayload,
      preview: {
        eyebrow: 'Seller',
        title: sellerName,
        summary: address,
        details: [
          { label: 'Market', value: market || '—' },
          { label: 'Seller State', value: sellerState || '—' },
          { label: 'Phone', value: phone || '—' },
          { label: 'Email', value: email || '—' },
        ],
      },
      meta: {
        provider: 'seller',
        groupLabel: 'Sellers',
        keywords: [sellerName, address, market, phone, email].filter(Boolean),
      },
    },
    {
      id: `conversation-${threadId || asText(rows.id)}`,
      type: 'conversation',
      title: sellerName,
      subtitle: [address, market].filter(Boolean).join(' · '),
      description: asText(rows.inbox_category || rows.pipeline_stage || rows.queue_status || rows.latest_message_body) || 'Conversation',
      badge: 'Conversation',
      icon: 'message',
      route: '/inbox',
      score: 22,
      payload: {
        ...commonPayload,
        kind: 'focus_thread',
        view: 'sms_thread',
      },
      preview: {
        eyebrow: 'Conversation',
        title: sellerName,
        summary: asText(rows.latest_message_body) || address,
        details: [
          { label: 'Category', value: asText(rows.inbox_category) || '—' },
          { label: 'Stage', value: asText(rows.pipeline_stage) || '—' },
          { label: 'Queue', value: asText(rows.queue_status) || '—' },
        ],
      },
      meta: {
        provider: 'seller',
        groupLabel: 'Sellers',
        keywords: [sellerName, address, market, sellerState, executionState].filter(Boolean),
      },
    },
  ]
}

export const sellerSearchProvider: GlobalCommandProvider = {
  id: 'seller',
  search: async (query, context) => {
    if (!canUseSupabaseSearch(query)) return []
    const supabase = getSupabaseSearchClient()
    const safe = sanitizeIlike(query)
    const term = `%${safe}%`
    const { data, error } = await supabase
      .from('v_operator_inbox_threads')
      .select('id,thread_key,property_id,master_owner_id,owner_id,seller_display_name,owner_display_name,owner_name,contact_name,property_address_full,property_address,market,seller_state,seller_status,execution_state,queue_status,canonical_e164,phone,phone_number,email,pipeline_stage,inbox_category,latest_message_body')
      .or([
        `seller_display_name.ilike.${term}`,
        `owner_display_name.ilike.${term}`,
        `owner_name.ilike.${term}`,
        `contact_name.ilike.${term}`,
        `canonical_e164.ilike.${term}`,
        `phone.ilike.${term}`,
        `email.ilike.${term}`,
        `market.ilike.${term}`,
        `property_address_full.ilike.${term}`,
      ].join(','))
      .limit(8)

    if (error || !data) return []
    const results = (data as SellerRow[]).flatMap((row) => mapSellerRows(row))
    return limitResults(results.map((result) => withScoredResult(result, query, context, result.title, result.subtitle, result.description)), 12)
  },
}
