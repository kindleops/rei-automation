import { asString, getFirst, type AnyRecord } from '../../lib/data/shared'

export const classifyQueueFailure = (
  row: AnyRecord,
  event: AnyRecord | null,
  status: string,
  deliveryStatus: string,
  hasTemplate: boolean,
  hasBody: boolean
): string | null => {
  const failedReason = asString(getFirst(row, ['failed_reason', 'failure_reason', 'error_code']), '').toLowerCase()
  const providerMsg = asString(getFirst(row, ['provider_message']), asString(getFirst(event || {}, ['error_message', 'provider_message']), '')).toLowerCase()
  const guardReason = asString(getFirst(row, ['guard_reason']), '').toLowerCase()
  const pausedReason = asString(getFirst(row, ['paused_reason']), '').toLowerCase()
  const combined = `${failedReason} ${providerMsg}`

  // 21610 / blacklist
  if (combined.includes('21610') || combined.includes('blacklist rule')) return 'blacklist_pair_21610'

  // Opt-out / suppression
  if (combined.includes('recipient opted out') || combined.includes('opted out') || status === 'paused_opt_out') return 'recipient_opted_out'
  if (guardReason.includes('suppression') || combined.includes('suppression')) return 'suppression_blocked'

  // Carrier / TextGrid content filter
  if (combined.includes('blocked by textgrid content filter') || combined.includes('textgrid_error')) return 'textgrid_content_filter'

  // Invalid phone
  if (combined.includes('to number invalid') || combined.includes('invalid number') || combined.includes('invalid_phone')) return 'invalid_number'

  // No sender available
  if (guardReason.includes('no_valid_local_textgrid_number') || guardReason.includes('no valid sender') || status === 'paused_invalid_queue_row') return 'no_valid_sender'

  // Paused statuses
  if (status === 'paused_name_missing' || pausedReason.includes('name_missing') || pausedReason.includes('seller_first_name')) return 'paused_name_missing'
  if (status === 'paused_duplicate' || pausedReason.includes('duplicate')) return 'paused_duplicate'
  if (status === 'paused_global_lock' || pausedReason.includes('global_lock')) return 'paused_global_lock'
  if (status === 'paused_max_retries' || pausedReason.includes('max_retries')) return 'stale_runnable_row'

  // Guard-based
  if (guardReason.includes('market')) return 'market_guard_blocked'
  if (guardReason.includes('queue')) return 'queue_guard_blocked'

  // Template / payload
  if (!hasTemplate || combined.includes('template_missing')) return 'missing_template'
  if (!hasBody || combined.includes('sync_error')) return 'blank_message_body'

  // Webhook / event missing
  if (status === 'sent' && !event) return 'message_event_missing'

  // Carrier
  if (deliveryStatus === 'failed' || combined.includes('carrier_error')) return 'carrier_failure'

  // Stale
  if (status === 'stale') return 'stale_runnable_row'

  if (failedReason || guardReason || deliveryStatus === 'failed') return 'unknown'
  return null
}

export const FAILURE_LABEL: Record<string, string> = {
  blacklist_pair_21610:   '21610 Blacklist Pair',
  recipient_opted_out:    'Opt-Out Suppressed',
  suppression_blocked:    'Suppression Blocked',
  textgrid_content_filter:'Carrier Rejected',
  invalid_number:         'Invalid Number',
  no_valid_sender:        'No Sender Available',
  paused_name_missing:    'Paused — Name Missing',
  paused_duplicate:       'Paused — Duplicate',
  paused_global_lock:     'Paused — Global Lock',
  market_guard_blocked:   'Blocked By Market Guard',
  queue_guard_blocked:    'Blocked By Queue Guard',
  missing_template:       'Missing Template',
  blank_message_body:     'Blank Message Body',
  message_event_missing:  'Webhook Missing',
  carrier_failure:        'Carrier Rejected',
  stale_runnable_row:     'Max Retries / Stale',
  routing_failure:        'Routing Failure',
  unknown:                'Unknown Failure',
}
