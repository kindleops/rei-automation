/**
 * Simplified inbox data layer.
 *
 * Phase 1 — base query: fetch 500 message_events, normalize direction, group into threads.
 * Phase 2 — hydration:  enrich from send_queue / master_owners / properties / prospects.
 *
 * Hydration failure MUST NOT blank the inbox.  Base threads are always the floor.
 */

import { getSupabaseClient } from '../supabaseClient'
import { formatRelativeTime } from '../../shared/formatters'
import type { InboxThread } from '../../modules/inbox/inbox.adapter'

// ── A. Columns ─────────────────────────────────────────────────────────────

const BASE_SELECT = [
  'id',
  'direction',
  'event_type',
  'message_body',
  'to_phone_number',
  'from_phone_number',
  'thread_key',
  'master_owner_id',
  'property_id',
  'prospect_id',
  'queue_id',
  'created_at',
  'sent_at',
  'received_at',
  'delivery_status',
].join(',')

// ── Types ──────────────────────────────────────────────────────────────────

export interface RawMessageEvent {
  id: string
  direction: string | null
  event_type: string | null
  message_body: string | null
  to_phone_number: string | null
  from_phone_number: string | null
  thread_key: string | null
  master_owner_id: string | null
  property_id: string | null
  prospect_id: string | null
  queue_id: string | null
  created_at: string | null
  sent_at: string | null
  received_at: string | null
  delivery_status: string | null
}

export type NormalizedDirection = 'inbound' | 'outbound'

export interface BaseThread {
  thread_key: string
  seller_phone: string
  direction: NormalizedDirection
  latest_event: RawMessageEvent
  last_inbound_at: string | null
  last_outbound_at: string | null
  message_count: number
  inbound_count: number
  outbound_count: number
  master_owner_id: string | null
  property_id: string | null
  prospect_id: string | null
  queue_id: string | null
}

export interface ThreadEnrichment {
  ownerName?: string
  propertyAddress?: string
  propertyAddressFull?: string
  market?: string
  sellerName?: string
  acquisitionScore?: number
  propertyType?: string
  queueStage?: string
}

// ── B. Normalize Direction ─────────────────────────────────────────────────

export function normalizeDirection(ev: RawMessageEvent): NormalizedDirection {
  if (
    ev.direction === 'inbound' ||
    (ev.event_type != null && ev.event_type.toLowerCase().includes('inbound')) ||
    ev.received_at != null
  ) return 'inbound'
  return 'outbound'
}

// ── C. Group Threads ───────────────────────────────────────────────────────

function sellerKey(ev: RawMessageEvent, dir: NormalizedDirection): string {
  if (ev.thread_key) return ev.thread_key
  const phone = dir === 'inbound' ? ev.from_phone_number : ev.to_phone_number
  if (phone) return phone
  const both = [ev.from_phone_number, ev.to_phone_number].filter(Boolean).sort().join(':')
  return both || 'unknown'
}

export function groupIntoThreads(events: RawMessageEvent[]): BaseThread[] {
  const map = new Map<string, BaseThread>()

  for (const ev of events) {
    const dir = normalizeDirection(ev)
    const key = sellerKey(ev, dir)
    const existing = map.get(key)

    if (!existing) {
      map.set(key, {
        thread_key: key,
        seller_phone: dir === 'inbound' ? (ev.from_phone_number ?? '') : (ev.to_phone_number ?? ''),
        direction: dir,
        latest_event: ev,
        last_inbound_at: dir === 'inbound' ? (ev.received_at ?? ev.created_at) : null,
        last_outbound_at: dir === 'outbound' ? (ev.sent_at ?? ev.created_at) : null,
        message_count: 1,
        inbound_count: dir === 'inbound' ? 1 : 0,
        outbound_count: dir === 'outbound' ? 1 : 0,
        master_owner_id: ev.master_owner_id,
        property_id: ev.property_id,
        prospect_id: ev.prospect_id,
        queue_id: ev.queue_id,
      })
    } else {
      existing.message_count++
      if (dir === 'inbound') {
        existing.inbound_count++
        if (!existing.last_inbound_at) existing.last_inbound_at = ev.received_at ?? ev.created_at
      } else {
        existing.outbound_count++
        if (!existing.last_outbound_at) existing.last_outbound_at = ev.sent_at ?? ev.created_at
      }
      // Accumulate missing IDs from older events in the same thread
      existing.master_owner_id = existing.master_owner_id ?? ev.master_owner_id
      existing.property_id = existing.property_id ?? ev.property_id
      existing.prospect_id = existing.prospect_id ?? ev.prospect_id
      existing.queue_id = existing.queue_id ?? ev.queue_id
    }
  }

  return Array.from(map.values())
}

// ── A. Base Fetch ──────────────────────────────────────────────────────────

export async function fetchBaseEvents(signal?: AbortSignal): Promise<RawMessageEvent[]> {
  const supabase = getSupabaseClient()
  let q = (supabase as any)
    .from('message_events')
    .select(BASE_SELECT)
    .order('created_at', { ascending: false })
    .limit(500)
  if (signal) q = q.abortSignal(signal)
  const { data, error } = await q
  if (error) throw error
  return (data ?? []) as RawMessageEvent[]
}

// ── D. Map to InboxThread ──────────────────────────────────────────────────

export function baseThreadToInboxThread(t: BaseThread, enrichment?: ThreadEnrichment): InboxThread {
  const ev = t.latest_event
  const isInbound = t.direction === 'inbound'
  const timeLabel = ev.created_at ? formatRelativeTime(ev.created_at) : ''
  const inboxCat = isInbound ? 'new_inbound' : 'outbound_active'

  return {
    id: t.thread_key,
    leadId: t.master_owner_id ?? '',
    marketId: enrichment?.market ?? '',
    ownerName: enrichment?.ownerName ?? '',
    sellerName: enrichment?.sellerName,
    subject: t.seller_phone || t.thread_key,
    preview: ev.message_body ?? '',
    status: isInbound ? 'unread' : 'read',
    priority: 'normal',
    sentiment: 'neutral',
    messageCount: t.message_count,
    lastMessageLabel: timeLabel,
    lastMessageIso: ev.created_at ?? '',
    unreadCount: isInbound ? 1 : 0,
    aiDraft: null,
    labels: [],
    threadKey: t.thread_key,
    ownerId: t.master_owner_id ?? undefined,
    prospectId: t.prospect_id ?? undefined,
    propertyId: t.property_id ?? undefined,
    sellerPhone: t.seller_phone,
    latestDirection: t.direction,
    directionUsed: t.direction,
    deliveryStatus: ev.delivery_status ?? undefined,
    propertyAddress: enrichment?.propertyAddress,
    propertyAddressFull: enrichment?.propertyAddressFull,
    market: enrichment?.market,
    lastInboundAt: t.last_inbound_at ?? undefined,
    lastOutboundAt: t.last_outbound_at ?? undefined,
    needsResponse: isInbound,
    unread: isInbound,
    latestMessageBody: ev.message_body ?? undefined,
    latestMessageAt: ev.created_at ?? undefined,
    latest_message_body: ev.message_body ?? undefined,
    latest_message_direction: t.direction,
    latest_activity_at: ev.created_at ?? undefined,
    queueId: t.queue_id ?? undefined,
    inbound_count: t.inbound_count,
    outbound_count: t.outbound_count,
    ownerDisplayName: enrichment?.ownerName,
    finalAcquisitionScore: enrichment?.acquisitionScore,
    propertyType: enrichment?.propertyType,
    inboxCategory: inboxCat,
    inbox_category: inboxCat,
    // Set uiIntent so resolveInboxThreadState doesn't catch inbound threads
    // in the needs_review gate (which fires when intent is empty/unknown).
    uiIntent: isInbound ? 'new_reply' : 'sent',
    hydrationSource: 'base_query',
    hydrationConfidence: 'low',
  } as InboxThread
}

// ── E. Hydrate After ───────────────────────────────────────────────────────

export async function hydrateEnrichments(
  threads: BaseThread[],
): Promise<Map<string, ThreadEnrichment>> {
  const supabase = getSupabaseClient()
  const result = new Map<string, ThreadEnrichment>()

  // Recover missing IDs from send_queue first
  const queueIds = [...new Set(threads.map(t => t.queue_id).filter(Boolean))] as string[]
  const queueById: Record<string, any> = {}
  if (queueIds.length > 0) {
    const { data } = await supabase
      .from('send_queue')
      .select('id, master_owner_id, property_id, prospect_id, seller_display_name, property_address, market, current_stage, pipeline_stage')
      .in('id', queueIds)
    for (const row of data ?? []) queueById[row.id] = row
  }

  // Merge queue-recovered IDs into a working copy
  const resolved = threads.map(t => {
    const q = t.queue_id ? queueById[t.queue_id] : null
    return {
      thread_key: t.thread_key,
      master_owner_id: t.master_owner_id ?? q?.master_owner_id ?? null,
      property_id: t.property_id ?? q?.property_id ?? null,
      prospect_id: t.prospect_id ?? q?.prospect_id ?? null,
      queue_id: t.queue_id,
      queue: q ?? null,
    }
  })

  const ownerIds = [...new Set(resolved.map(r => r.master_owner_id).filter(Boolean))] as string[]
  const propIds  = [...new Set(resolved.map(r => r.property_id).filter(Boolean))] as string[]
  const prospIds = [...new Set(resolved.map(r => r.prospect_id).filter(Boolean))] as string[]

  const [ownersR, propsR, prospectsR] = await Promise.allSettled([
    ownerIds.length
      ? supabase.from('master_owners').select('id, display_name, final_acquisition_score').in('id', ownerIds)
      : Promise.resolve({ data: [] }),
    propIds.length
      ? supabase.from('properties').select('property_id, property_address_full, property_address, market, property_type, estimated_value, equity_percent').in('property_id', propIds)
      : Promise.resolve({ data: [] }),
    prospIds.length
      ? supabase.from('prospects').select('id, full_name, first_name').in('id', prospIds)
      : Promise.resolve({ data: [] }),
  ])

  const owners   = new Map((ownersR.status    === 'fulfilled' ? ownersR.value.data    ?? [] : []).map((r: any) => [r.id,          r]))
  const props    = new Map((propsR.status     === 'fulfilled' ? propsR.value.data     ?? [] : []).map((r: any) => [r.property_id, r]))
  const suspects = new Map((prospectsR.status === 'fulfilled' ? prospectsR.value.data ?? [] : []).map((r: any) => [r.id,          r]))

  for (const r of resolved) {
    const o = r.master_owner_id ? owners.get(r.master_owner_id)   : null
    const p = r.property_id     ? props.get(r.property_id)         : null
    const s = r.prospect_id     ? suspects.get(r.prospect_id)      : null
    const q = r.queue

    result.set(r.thread_key, {
      ownerName:           o?.display_name        ?? q?.seller_display_name ?? undefined,
      propertyAddress:     p?.property_address     ?? q?.property_address    ?? undefined,
      propertyAddressFull: p?.property_address_full ?? q?.property_address   ?? undefined,
      market:              p?.market               ?? q?.market              ?? undefined,
      sellerName:          s?.full_name            ?? s?.first_name          ?? undefined,
      acquisitionScore:    o?.final_acquisition_score                        ?? undefined,
      propertyType:        p?.property_type                                  ?? undefined,
      queueStage:          q?.current_stage        ?? q?.pipeline_stage      ?? undefined,
    })
  }

  return result
}
