/** Plain-English operator labels for Template Intelligence UI. */

export const OPTIMIZATION_STATE_LABELS: Record<string, string> = {
  cold_start: 'Gathering data',
  testing: 'Testing',
  rising: 'Performing well',
  winner: 'Performing well',
  champion: 'Performing well',
  watch: 'Needs review',
  cooldown: 'Paused',
  paused: 'Paused',
  retired: 'Retired',
}

export const DECISION_REASON_LABELS: Record<string, string> = {
  within_policy_thresholds: 'Within normal thresholds',
  insufficient_delivered_volume: 'Not enough delivered messages yet',
  immediate_safety_pause: 'Paused for safety',
  attribution_unhealthy_hold: 'Reply tracking needs review',
  variable_rendering_unhealthy_hold: 'Variable issues detected',
  opt_out_rate_above_ceiling: 'Opt-out rate too high',
  hostile_rate_above_ceiling: 'Hostile response spike',
  execution_failure_not_copy: 'Delivery failures elevated',
  copy_below_cohort_baseline: 'Below peer performance',
  gradual_scale_up_copy_outperforming: 'Outperforming peers — scale up recommended',
}

export const CONFIDENCE_LABELS: Record<string, string> = {
  insufficient_data: 'Not enough data',
  low_confidence: 'Low confidence',
  medium_confidence: 'Medium confidence',
  high_confidence: 'High confidence',
}

export const ATTRIBUTION_STATUS_LABELS: Record<string, string> = {
  attributed: 'Tracked',
  partial: 'Partially tracked',
  unavailable: 'Unattributed',
  no_replies: 'No replies',
  no_sends: 'No sends',
}

export const COLUMN_PRESET_LABELS: Record<string, string> = {
  performance: 'Performance',
  execution: 'Execution',
  funnel: 'Funnel',
  optimization: 'Optimization',
  template_health: 'Template Health',
}

export const VIEW_TAB_LABELS: Record<string, string> = {
  Overview: 'Overview',
  Performance: 'Performance',
  Funnel: 'Funnel',
  Cohorts: 'Cohorts',
  Executions: 'Executions',
  'Selection Logic': 'Selection Logic',
  Optimization: 'Optimization',
  'Change History': 'Change History',
}

export function formatOptimizationState(state?: string | null): string {
  if (!state) return 'Gathering data'
  return OPTIMIZATION_STATE_LABELS[state] ?? state.replace(/_/g, ' ')
}

export function formatDecisionReason(reason?: string | null): string {
  if (!reason) return '—'
  const base = String(reason).split(':')[0]
  return DECISION_REASON_LABELS[base] ?? String(reason).replace(/_/g, ' ')
}

export function formatConfidence(bucket?: string | null): string {
  if (!bucket) return 'Not enough data'
  return CONFIDENCE_LABELS[bucket] ?? bucket.replace(/_/g, ' ')
}

export function formatAttributionStatus(status?: string | null): string {
  if (!status) return '—'
  return ATTRIBUTION_STATUS_LABELS[status] ?? status.replace(/_/g, ' ')
}

export function formatRateDisplay(
  rate: { value?: number | null; numerator?: number | null; denominator?: number; unavailable?: boolean; unattributed?: boolean } | undefined,
  sample?: number,
): { primary: string; secondary?: string } {
  if (!rate) return { primary: '—' }
  if (rate.unavailable || rate.unattributed) {
    return { primary: 'Unattributed', secondary: rate.denominator ? `of ${rate.denominator}` : undefined }
  }
  if (rate.denominator === 0) return { primary: '—' }
  if (rate.value == null) {
    return sample != null && sample < 10
      ? { primary: 'Not enough data' }
      : { primary: '—' }
  }
  const num = rate.numerator ?? 0
  const den = rate.denominator ?? 0
  return { primary: `${rate.value}%`, secondary: `${num}/${den}` }
}