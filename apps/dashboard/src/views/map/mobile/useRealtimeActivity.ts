/**
 * Live Activity, live.
 *
 * The map's own feed is derived from the pins it already loaded, so it only
 * changes when pins refresh. This hook adds the real stream:
 *   · on open, the last 24h of message_events (replies, opt-outs, sends,
 *     deliveries, failures, stage moves) — so the feed is never empty for no
 *     reason;
 *   · then Supabase realtime on message_events (INSERT + UPDATE) and
 *     inbox_thread_state (stage changes), each mapped to one activity event.
 * Every event is placed at its property (one batched properties read), so a
 * new one pulses on the map. Read-only; ids are stable per source row + state,
 * so a delivery receipt after a send is a new event but a replayed row is not.
 */
import { useEffect, useRef, useState } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { getSupabaseClient } from '../../../lib/supabaseClient'
import { shouldUseSupabase } from '../../../lib/data/shared'
import type { LiveActivityEvent, LiveActivitySeverity } from '../live-activity-engine'
import type { CommandMapActivityPriority, CommandMapActivityType } from '../commandMapLiveActivity'

type Row = Record<string, unknown>
const str = (v: unknown) => (v == null ? '' : String(v).trim())
const MAX_EVENTS = 200
const BACKFILL_HOURS = 24

const STAGE_LABEL = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

function make(
  id: string,
  type: CommandMapActivityType,
  severity: LiveActivitySeverity,
  priority: CommandMapActivityPriority,
  title: string,
  row: Row,
  at: string,
  detail?: string,
): LiveActivityEvent {
  const propertyId = str(row.property_id) || undefined
  return {
    id,
    type,
    priority,
    severity,
    title,
    detail: detail || undefined,
    subtitle: str(row.seller_display_name) || undefined,
    market: str(row.market) || undefined,
    address: str(row.property_address) || undefined,
    createdAt: at,
    occurredAt: at,
    receivedAt: at,
    propertyId,
    threadKey: str(row.thread_key) || undefined,
    messageEventId: type !== 'stage_change' ? str(row.id) || undefined : undefined,
    // "Show on map" selects the property; the card hydrates from property_id.
    targetType: propertyId ? 'seller' : 'system',
    targetId: propertyId,
    channel: 'live',
    summary: title,
    primaryAction: 'Show on map',
    secondaryAction: null,
    source: 'realtime',
    isUnread: true,
    isPinned: false,
    isAcknowledged: false,
    rankScore: 0,
    isGlobalCritical: severity === 'urgent' || severity === 'blocked',
  } as LiveActivityEvent
}

/** One message_events row → at most one event, keyed by row + state. */
export function eventFromMessage(row: Row): LiveActivityEvent | null {
  const id = str(row.id)
  if (!id) return null
  const dir = str(row.direction).toLowerCase()
  const status = str(row.delivery_status).toLowerCase()
  const body = str(row.message_body)
  const snippet = body.length > 140 ? `${body.slice(0, 137)}…` : body
  const before = str(row.stage_before)
  const after = str(row.stage_after)
  if (dir === 'inbound') {
    const at = str(row.received_at) || str(row.created_at)
    if (row.is_opt_out === true) return make(`me:${id}:optout`, 'opt_out', 'blocked', 'critical', 'Seller opted out', row, at, snippet)
    const moved = after && after !== before ? ` · ${STAGE_LABEL(after)}` : ''
    return make(`me:${id}:in`, 'new_reply', 'urgent', 'hot', `Seller replied${moved}`, row, at, snippet)
  }
  if (dir === 'outbound') {
    if (status === 'delivered') return make(`me:${id}:delivered`, 'message_delivered', 'success', 'normal', 'Message delivered', row, str(row.delivered_at) || str(row.updated_at) || str(row.created_at), snippet)
    if (status === 'failed' || str(row.event_type).includes('failed')) {
      return make(`me:${id}:failed`, 'message_failed', 'blocked', 'critical', 'Message failed', row, str(row.failed_at) || str(row.updated_at) || str(row.created_at), str(row.failure_reason) || str(row.error_message) || snippet)
    }
    return make(`me:${id}:sent`, 'message_sent', 'info', 'info', 'Message sent', row, str(row.sent_at) || str(row.created_at), snippet)
  }
  return null
}

/** inbox_thread_state UPDATE whose stage differs from the last one seen. */
export function eventFromStage(row: Row, previous: string | undefined): LiveActivityEvent | null {
  const stage = str(row.seller_stage) || str(row.stage)
  const key = str(row.thread_key) || str(row.id)
  if (!stage || !key || previous === undefined || previous === stage) return null
  const at = str(row.updated_at) || new Date().toISOString()
  const hot = row.is_hot_lead === true
  const s = stage.toLowerCase()
  const type: CommandMapActivityType = s.includes('contract') ? 'contract' : s.includes('offer') ? 'offer' : s.includes('clos') ? 'closing' : hot ? 'hot_lead' : 'stage_change'
  const title = previous ? `Moved to ${STAGE_LABEL(stage)}` : `New conversation · ${STAGE_LABEL(stage)}`
  return make(`its:${key}:${stage}:${at}`, type, hot ? 'urgent' : 'attention', hot ? 'hot' : 'normal', title, row, at, previous ? `from ${STAGE_LABEL(previous)}` : undefined)
}

const ME_COLUMNS = 'id, direction, event_type, delivery_status, message_body, created_at, sent_at, received_at, delivered_at, failed_at, updated_at, property_id, thread_key, seller_display_name, market, property_address, is_opt_out, stage_before, stage_after, failure_reason, error_message'

export function useRealtimeActivity(enabled: boolean): { events: LiveActivityEvent[]; live: boolean; coveredSince: number | null } {
  const [events, setEvents] = useState<LiveActivityEvent[]>([])
  const [live, setLive] = useState(false)
  const [coveredSince, setCoveredSince] = useState<number | null>(null)
  const coords = useRef(new Map<string, { lat: number; lng: number; address?: string } | null>())
  const stages = useRef(new Map<string, string>())

  useEffect(() => {
    if (!enabled || !shouldUseSupabase()) return
    const supabase = getSupabaseClient()
    let cancelled = false
    const channels: RealtimeChannel[] = []

    // Place events at their property: one batched read for unknown ids.
    const place = async (batch: LiveActivityEvent[]) => {
      const missing = [...new Set(batch.map((e) => e.propertyId).filter((id): id is string => Boolean(id) && !coords.current.has(id!)))]
      if (missing.length) {
        const { data } = await supabase.from('properties').select('property_id, latitude, longitude, property_address_full, market').in('property_id', missing.slice(0, 200))
        for (const id of missing) coords.current.set(id, null)
        for (const r of (data ?? []) as Row[]) {
          const lat = Number(r.latitude)
          const lng = Number(r.longitude)
          coords.current.set(str(r.property_id), Number.isFinite(lat) && Number.isFinite(lng) && (lat || lng) ? { lat, lng, address: str(r.property_address_full) || undefined } : null)
        }
      }
      return batch.map((e) => {
        const c = e.propertyId ? coords.current.get(e.propertyId) : null
        if (!c) return { ...e, targetType: 'system' as const, targetId: undefined }
        return { ...e, lat: c.lat, lng: c.lng, address: e.address || c.address }
      })
    }
    const push = async (batch: Array<LiveActivityEvent | null>) => {
      const real = batch.filter((e): e is LiveActivityEvent => Boolean(e))
      if (!real.length) return
      const placed = await place(real)
      if (cancelled) return
      setEvents((prev) => {
        const byId = new Map(prev.map((e) => [e.id, e]))
        for (const e of placed) byId.set(e.id, e)
        return [...byId.values()].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt)).slice(0, MAX_EVENTS)
      })
    }

    // Backfill the last day so the feed opens with what actually happened.
    void (async () => {
      const sinceMs = Date.now() - BACKFILL_HOURS * 3600_000
      const { data, error } = await supabase.from('message_events').select(ME_COLUMNS).gte('created_at', new Date(sinceMs).toISOString()).order('created_at', { ascending: false }).limit(200)
      if (cancelled || error) return
      await push(((data ?? []) as Row[]).map(eventFromMessage))
      // A full page means older rows were cut: the stream only vouches for what it holds.
      const rows = (data ?? []) as Row[]
      const oldest = rows.length >= 200 ? Date.parse(str(rows[rows.length - 1].created_at)) : sinceMs
      if (!cancelled) setCoveredSince(Number.isFinite(oldest) ? oldest : sinceMs)
    })()

    const me = supabase
      .channel(`nx-map-live:message_events:${Date.now()}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'message_events' }, (p) => { void push([eventFromMessage(p.new as Row)]) })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'message_events' }, (p) => {
        const row = p.new as Row
        // Only delivery outcomes are news on an update; the send itself arrived as an INSERT.
        const s = str(row.delivery_status).toLowerCase()
        if (s === 'delivered' || s === 'failed') void push([eventFromMessage(row)])
      })
      .subscribe((status) => { if (!cancelled) setLive(status === 'SUBSCRIBED') })
    channels.push(me)

    const its = supabase
      .channel(`nx-map-live:inbox_thread_state:${Date.now()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'inbox_thread_state' }, (p) => {
        const row = p.new as Row
        const key = str(row.thread_key) || str(row.id)
        const stage = str(row.seller_stage) || str(row.stage)
        if (!key || !stage) return
        const prev = stages.current.get(key)
        stages.current.set(key, stage)
        // A thread seen for the first time only seeds the cache (old values aren't replicated).
        void push([eventFromStage(row, p.eventType === 'INSERT' ? '' : prev)])
      })
      .subscribe()
    channels.push(its)

    return () => {
      cancelled = true
      setLive(false)
      setCoveredSince(null)
      for (const c of channels) void supabase.removeChannel(c)
    }
  }, [enabled])

  return { events, live, coveredSince }
}
