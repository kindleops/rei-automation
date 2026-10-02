/** The metrics the Analytics widget offers — each is a canonical contract of /api/cockpit/analytics/performance. */
export type MetricKey = 'replied' | 'delivered' | 'sent' | 'failed' | 'optOuts' | 'advancements' | 'reply_rate' | 'delivery_rate' | 'opt_out_rate'

/** Widget metric → the server's metric contract key (compare / totals / metrics) and its time-series field. */
export const METRIC_CONTRACT: Record<MetricKey, { contract: string; series: 'replied' | 'delivered' | 'failed' | 'optOuts' | 'advancements' | null }> = {
  replied: { contract: 'replied_conversations', series: 'replied' },
  delivered: { contract: 'delivered', series: 'delivered' },
  sent: { contract: 'sent', series: null },
  failed: { contract: 'failed', series: 'failed' },
  optOuts: { contract: 'opt_out_conversations', series: 'optOuts' },
  advancements: { contract: 'stage_advancements', series: 'advancements' },
  reply_rate: { contract: 'reply_rate', series: null },
  delivery_rate: { contract: 'delivery_rate', series: null },
  opt_out_rate: { contract: 'opt_out_rate', series: null },
}

export const ANALYTICS_METRICS: Array<{ value: MetricKey; label: string; kind: 'count' | 'rate'; good: 'up' | 'down' }> = [
  { value: 'replied', label: 'Seller conversations replied', kind: 'count', good: 'up' },
  { value: 'delivered', label: 'Delivered', kind: 'count', good: 'up' },
  { value: 'sent', label: 'Sent', kind: 'count', good: 'up' },
  { value: 'failed', label: 'Failed sends', kind: 'count', good: 'down' },
  { value: 'optOuts', label: 'Opt-outs', kind: 'count', good: 'down' },
  { value: 'advancements', label: 'Stage advancements', kind: 'count', good: 'up' },
  { value: 'reply_rate', label: 'Reply rate', kind: 'rate', good: 'up' },
  { value: 'delivery_rate', label: 'Delivery rate', kind: 'rate', good: 'up' },
  { value: 'opt_out_rate', label: 'Opt-out rate', kind: 'rate', good: 'down' },
]

