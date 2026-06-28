import type { RealtimeChannel } from '@supabase/supabase-js'
import { getSupabaseClient, hasSupabaseEnv } from '../../lib/supabaseClient'
import type { SellerAutomationExecutionStep } from './seller-automation.types'

export type SellerAutomationRealtimeStatus = 'disabled' | 'connecting' | 'connected' | 'error'

export interface SellerAutomationRealtimeHandlers {
  onStep?: (step: SellerAutomationExecutionStep) => void
  onExecutionUpsert?: (execution: Record<string, unknown>) => void
  onStatus?: (status: SellerAutomationRealtimeStatus) => void
}

function mapStepRow(row: Record<string, unknown>): SellerAutomationExecutionStep {
  return {
    id: String(row.id),
    execution_id: String(row.execution_id),
    action_key: String(row.action_key),
    node_id: String(row.node_id),
    property_id: (row.property_id as string | null) ?? null,
    participant_id: (row.participant_id as string | null) ?? null,
    thread_id: (row.thread_id as string | null) ?? null,
    source_message_id: (row.source_message_id as string | null) ?? null,
    lifecycle_stage: (row.lifecycle_stage as string | null) ?? null,
    execution_status: row.execution_status as SellerAutomationExecutionStep['execution_status'],
    started_at: String(row.started_at),
    completed_at: (row.completed_at as string | null) ?? null,
    duration_ms: (row.duration_ms as number | null) ?? null,
    input_summary: (row.input_summary as Record<string, unknown>) ?? {},
    output_summary: (row.output_summary as Record<string, unknown>) ?? {},
    selected_template: (row.selected_template as string | null) ?? null,
    rendered_response_preview: (row.rendered_response_preview as string | null) ?? null,
    queue_id: (row.queue_id as string | null) ?? null,
    provider_status: (row.provider_status as string | null) ?? null,
    block_reason: (row.block_reason as string | null) ?? null,
    retry_count: Number(row.retry_count ?? 0),
    error_details: (row.error_details as Record<string, unknown> | null) ?? null,
    next_action: (row.next_action as string | null) ?? null,
    manual: Boolean(row.manual),
  }
}

export function subscribeSellerAutomationRealtime(
  filters: {
    executionId?: string | null
    threadId?: string | null
    propertyId?: string | null
  },
  handlers: SellerAutomationRealtimeHandlers,
): () => void {
  if (!hasSupabaseEnv || (!filters.executionId && !filters.threadId && !filters.propertyId)) {
    handlers.onStatus?.('disabled')
    return () => undefined
  }

  const supabase = getSupabaseClient()
  const channelKey = [
    'seller-automation',
    filters.executionId || 'all',
    filters.threadId || 'all',
    filters.propertyId || 'all',
  ].join(':')

  handlers.onStatus?.('connecting')

  const channel: RealtimeChannel = supabase.channel(channelKey)

  const stepFilter = filters.executionId
    ? `execution_id=eq.${filters.executionId}`
    : filters.threadId
      ? `thread_id=eq.${filters.threadId}`
      : `property_id=eq.${filters.propertyId}`

  channel.on(
    'postgres_changes',
    {
      event: 'INSERT',
      schema: 'public',
      table: 'seller_automation_execution_steps',
      filter: stepFilter,
    },
    (payload) => {
      if (!payload.new) return
      handlers.onStep?.(mapStepRow(payload.new as Record<string, unknown>))
    },
  )

  if (filters.executionId || filters.threadId || filters.propertyId) {
    const executionFilter = filters.executionId
      ? `id=eq.${filters.executionId}`
      : filters.threadId
        ? `thread_id=eq.${filters.threadId}`
        : `property_id=eq.${filters.propertyId}`

    channel.on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'seller_automation_executions',
        filter: executionFilter,
      },
      (payload) => {
        const row = (payload.new ?? payload.old) as Record<string, unknown> | null
        if (row) handlers.onExecutionUpsert?.(row)
      },
    )
  }

  channel.subscribe((status) => {
    if (status === 'SUBSCRIBED') handlers.onStatus?.('connected')
    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') handlers.onStatus?.('error')
  })

  return () => {
    void supabase.removeChannel(channel)
  }
}