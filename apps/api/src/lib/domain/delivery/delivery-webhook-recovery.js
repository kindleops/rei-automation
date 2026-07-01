import { randomUUID } from 'node:crypto'

import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { getSystemValue, setSystemValues } from '@/lib/system-control.js'
import { resolveDeployGitSha } from '@/lib/domain/deploy/resolve-deploy-sha.js'
import {
  groupDeliveryEventsByProvider,
  WEBHOOK_PROCESSOR_VERSION,
} from '@/lib/domain/webhooks/provider-event-state-machine.js'
import {
  processDeliveryProviderGroup,
  processDeliveryProviderIds,
} from '@/lib/domain/webhooks/webhook-event-processor.js'

const DELIVERY_EVENT_TYPES = ['delivery', 'status', 'outbound']
const DEFAULT_BATCH_PROVIDER_IDS = 500
const DEFAULT_MAX_DURATION_MS = 55_000
const CURSOR_KEY = 'webhook_delivery_recovery_cursor'

function clean(value) {
  return String(value ?? '').trim()
}

/**
 * Legacy entry point — thin wrapper for reconcile cron small pass.
 */
export async function recoverUnprocessedDeliveryWebhooks(options = {}, deps = {}) {
  const result = await recoverDeliveryWebhookBacklog(
    {
      provider_id_batch_size: Math.min(Number(options.limit ?? 25), 100),
      max_duration_ms: 25_000,
      max_provider_groups: Math.min(Number(options.limit ?? 25), 100),
      lane: 'reconcile_pass',
    },
    deps
  )

  return {
    ok: true,
    scanned: result.provider_groups_scanned || 0,
    recovered: result.webhooks_marked_processed || 0,
    failed: result.groups_failed || 0,
    results: (result.group_results || []).slice(0, 25),
  }
}

/**
 * Cursor-based compact historical delivery recovery worker.
 */
export async function recoverDeliveryWebhookBacklog(options = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const now = options.now || new Date().toISOString()
  const execution_id = options.execution_id || randomUUID()
  const started = Date.now()

  const provider_id_batch_size = Math.max(
    Number(options.provider_id_batch_size ?? DEFAULT_BATCH_PROVIDER_IDS),
    1
  )
  const max_duration_ms = Math.max(Number(options.max_duration_ms ?? DEFAULT_MAX_DURATION_MS), 5_000)
  const max_provider_groups = Math.max(Number(options.max_provider_groups ?? provider_id_batch_size), 1)
  const concurrency = Math.min(Math.max(Number(options.concurrency ?? 10), 1), 25)

  if (Array.isArray(options.provider_message_sids) && options.provider_message_sids.length > 0) {
    const targeted = await processDeliveryProviderIds(options.provider_message_sids, options, deps)
    return {
      ok: true,
      mode: 'targeted',
      execution_id: targeted.execution_id,
      provider_groups_scanned: targeted.targeted,
      webhooks_marked_processed: targeted.matched + targeted.unmatched,
      groups_matched: targeted.matched,
      groups_unmatched: targeted.unmatched,
      groups_failed: targeted.failed,
      group_results: targeted.results,
      duration_ms: Date.now() - started,
      processor_version: WEBHOOK_PROCESSOR_VERSION,
      deployed_sha: resolveDeployGitSha(),
    }
  }

  let cursor = clean(options.cursor || (await getSystemValue(CURSOR_KEY, { supabase })))
  const page_size = Math.min(provider_id_batch_size * 4, 4000)

  const query = supabase
    .from('webhook_log')
    .select('id,provider_message_sid,payload,event_type,processed,created_at,direction')
    .eq('processed', false)
    .in('event_type', DELIVERY_EVENT_TYPES)
    .order('created_at', { ascending: true })
    .limit(page_size)

  if (cursor) {
    query.gt('created_at', cursor)
  }

  const { data: rows, error } = await query
  if (error) throw error

  const groups = groupDeliveryEventsByProvider(rows || [])
  const group_entries = [...groups.values()].slice(0, max_provider_groups)

  let groups_processed = 0
  let groups_matched = 0
  let groups_unmatched = 0
  let groups_failed = 0
  let webhooks_marked = 0
  const group_results = []

  for (let i = 0; i < group_entries.length; i += concurrency) {
    if (Date.now() - started >= max_duration_ms) break

    const chunk = group_entries.slice(i, i + concurrency)
    const outcomes = await Promise.all(
      chunk.map((group) =>
        processDeliveryProviderGroup(group, { ...options, execution_id, now }, deps)
      )
    )

    for (const outcome of outcomes) {
      groups_processed += 1
      if (outcome.ok && outcome.matched) groups_matched += 1
      else if (outcome.ok && !outcome.matched) groups_unmatched += 1
      else groups_failed += 1
      webhooks_marked += Number(outcome.recovered || 0)
      group_results.push(outcome)
    }
  }

  const last_row = (rows || [])[rows.length - 1]
  const new_cursor = last_row?.created_at || cursor || null
  const duration_ms = Date.now() - started
  const throughput_per_minute =
    duration_ms > 0 ? Math.round((groups_processed / duration_ms) * 60_000 * 10) / 10 : 0

  if (!options.dry_run && new_cursor) {
    await setSystemValues(
      {
        [CURSOR_KEY]: new_cursor,
        webhook_delivery_recovery_last_at: now,
        webhook_delivery_recovery_last_execution_id: execution_id,
        webhook_delivery_recovery_last_groups: String(groups_processed),
        webhook_delivery_recovery_last_webhooks: String(webhooks_marked),
        webhook_delivery_recovery_throughput_per_min: String(throughput_per_minute),
      },
      { supabase }
    ).catch(() => {})
  }

  return {
    ok: true,
    mode: 'cursor_backfill',
    execution_id,
    cursor_before: cursor || null,
    cursor_after: new_cursor,
    rows_fetched: (rows || []).length,
    provider_groups_scanned: groups_processed,
    provider_groups_available: group_entries.length,
    webhooks_marked_processed: webhooks_marked,
    groups_matched,
    groups_unmatched,
    groups_failed,
    throughput_per_minute,
    duration_ms,
    processor_version: WEBHOOK_PROCESSOR_VERSION,
    deployed_sha: resolveDeployGitSha(),
    group_results: group_results.slice(0, 25),
  }
}

export { processDeliveryProviderIds, CURSOR_KEY }