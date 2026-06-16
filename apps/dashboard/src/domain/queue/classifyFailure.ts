import { asString, getFirst, type AnyRecord } from '../../lib/data/shared'

export const FAILURE_LABEL: Record<string, string> = {
  textgrid_content_filter: 'TextGrid Content Filter',
  blacklist_pair_21610: 'Blacklist Rule (21610)',
  recipient_opted_out: 'Recipient Opted Out',
  invalid_number: 'Invalid Phone Number',
  suppression_blocked: 'Suppression Blocked',
  no_valid_sender: 'No Valid Sender',
  missing_template: 'Missing Template',
  blank_message_body: 'Blank Message Body',
  message_event_missing: 'Message Event Missing',
  carrier_failure: 'Carrier Failure',
  stale_runnable_row: 'Stale Queue Item',
  unknown: 'Unknown Failure'
}

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
  const combined = `${failedReason} ${providerMsg}`

  if (combined.includes('blocked by textgrid content filter') || combined.includes('textgrid_error')) return 'textgrid_content_filter'
  if (combined.includes('21610') || combined.includes('blacklist rule')) return 'blacklist_pair_21610'
  if (combined.includes('recipient opted out') || status === 'paused_opt_out' || combined.includes('opted out')) return 'recipient_opted_out'
  if (combined.includes('to number invalid') || combined.includes('invalid number') || combined.includes('invalid_phone')) return 'invalid_number'
  if (guardReason.includes('suppression')) return 'suppression_blocked'
  if (guardReason.includes('no_valid_local_textgrid_number') || guardReason.includes('no valid sender')) return 'no_valid_sender'
  if (!hasTemplate || combined.includes('template_missing')) return 'missing_template'
  if (!hasBody || combined.includes('sync_error')) return 'blank_message_body'
  if (status === 'sent' && !event) return 'message_event_missing'
  if (deliveryStatus === 'failed' || combined.includes('carrier_error')) return 'carrier_failure'
  
  if (status === 'paused_max_retries' || status === 'stale') return 'stale_runnable_row'

  if (failedReason || guardReason || deliveryStatus === 'failed') return 'unknown'
  return null
}
