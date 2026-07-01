import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { getSystemValue } from '@/lib/system-control.js'
import { resolveDeployGitSha } from '@/lib/domain/deploy/resolve-deploy-sha.js'
import { WEBHOOK_PROCESSOR_VERSION } from '@/lib/domain/webhooks/provider-event-state-machine.js'
import { CURSOR_KEY } from '@/lib/domain/delivery/delivery-webhook-recovery.js'

const DELIVERY_EVENT_TYPES = ['delivery', 'status', 'outbound']

function clean(value) {
  return String(value ?? '').trim()
}

async function countUnprocessedByStatus(supabase, event_types) {
  const { count, error } = await supabase
    .from('webhook_log')
    .select('id', { count: 'exact', head: true })
    .eq('processed', false)
    .in('event_type', event_types)

  if (error) throw error
  return Number(count || 0)
}

async function countUnprocessedInbound(supabase) {
  const { count, error } = await supabase
    .from('webhook_log')
    .select('id', { count: 'exact', head: true })
    .eq('processed', false)
    .eq('event_type', 'inbound')

  if (error) throw error
  return Number(count || 0)
}

async function oldestUnprocessed(supabase) {
  const { data, error } = await supabase
    .from('webhook_log')
    .select('id,event_type,created_at,provider_message_sid')
    .eq('processed', false)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (error) throw error
  return data || null
}

async function countUnmatchedRecent(supabase) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { count, error } = await supabase
    .from('webhook_log')
    .select('id', { count: 'exact', head: true })
    .eq('processed', true)
    .gte('processed_at', since)
    .eq('processing_error_code', 'unmatched_provider_id')

  if (error) {
    const { count: fallback } = await supabase
      .from('webhook_log')
      .select('id', { count: 'exact', head: true })
      .eq('processed', true)
      .gte('processed_at', since)
      .ilike('error_message', 'unmatched:%')
    return Number(fallback || 0)
  }
  return Number(count || 0)
}

export async function getWebhookProcessingStatus(options = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const now = options.now || new Date().toISOString()

  const [
    unprocessed_delivery,
    unprocessed_inbound,
    oldest,
    unmatched_24h,
    recovery_cursor,
    recovery_last_at,
    recovery_throughput,
    live_delivery_last_at,
    live_inbound_last_at,
  ] = await Promise.all([
    countUnprocessedByStatus(supabase, DELIVERY_EVENT_TYPES),
    countUnprocessedInbound(supabase),
    oldestUnprocessed(supabase),
    countUnmatchedRecent(supabase),
    getSystemValue(CURSOR_KEY, { supabase }),
    getSystemValue('webhook_delivery_recovery_last_at', { supabase }),
    getSystemValue('webhook_delivery_recovery_throughput_per_min', { supabase }),
    getSystemValue('webhook_live_delivery_last_at', { supabase }),
    getSystemValue('webhook_live_inbound_last_at', { supabase }),
  ])

  const alerts = []
  if (unprocessed_inbound > 0 && oldest?.event_type === 'inbound') {
    const age_sec = (Date.now() - new Date(oldest.created_at).getTime()) / 1000
    if (age_sec > 60) {
      alerts.push({
        code: 'inbound_unprocessed_over_60s',
        severity: 'critical',
        oldest_inbound_age_seconds: Math.round(age_sec),
      })
    }
  }

  if (unprocessed_delivery > 0 && oldest?.event_type !== 'inbound') {
    const age_sec = (Date.now() - new Date(oldest.created_at).getTime()) / 1000
    if (age_sec > 300) {
      alerts.push({
        code: 'terminal_delivery_unprocessed_over_5m',
        severity: 'warning',
        oldest_delivery_age_seconds: Math.round(age_sec),
      })
    }
  }

  if (unmatched_24h > 50) {
    alerts.push({ code: 'unmatched_provider_ids_spike', severity: 'warning', count: unmatched_24h })
  }

  return {
    ok: true,
    observed_at: now,
    processor_version: WEBHOOK_PROCESSOR_VERSION,
    deployed_sha: resolveDeployGitSha(),
    backlog: {
      unprocessed_delivery_events: unprocessed_delivery,
      unprocessed_inbound_events: unprocessed_inbound,
      oldest_unprocessed: oldest,
      unmatched_provider_ids_24h: unmatched_24h,
    },
    recovery: {
      cursor: recovery_cursor || null,
      last_successful_cycle_at: recovery_last_at || null,
      throughput_per_minute: Number(recovery_throughput || 0),
    },
    live: {
      last_successful_delivery_at: live_delivery_last_at || null,
      last_successful_inbound_at: live_inbound_last_at || null,
    },
    alerts,
  }
}