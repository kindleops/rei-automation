import type { QueueItem } from '../../domain/queue/queue.types'
import { FAILURE_LABEL } from '../../domain/queue/classifyFailure'

export type QueueDensity = 'comfortable' | 'compact' | 'command'
export type QueueSection = 'queue' | 'templates' | 'senders' | 'market' | 'failures' | 'events'

export const BLOCKED_STATUSES = new Set([
  'blocked', 'paused_invalid_queue_row', 'paused_name_missing', 'paused_max_retries',
  'paused_duplicate', 'paused_global_lock', 'duplicate_blocked', 'incident_quarantine',
])

const DELIVERED_STATUSES = new Set(['delivered'])
const FAILED_STATUSES = new Set(['failed', 'retry', 'retrying'])
const SENT_STATUSES = new Set(['sent', 'delivered', 'failed', 'retry', 'retrying'])

export const isDelivered = (s: string) => DELIVERED_STATUSES.has(s)
export const isFailed = (s: string) => FAILED_STATUSES.has(s)
export const isSent = (s: string) => SENT_STATUSES.has(s)

const INVALID_NAMES = new Set(['unknown contact', 'unknown seller', 'unknown', '—', '-'])

const clean = (v: string | null | undefined): string => String(v ?? '').trim()

const looksLikePhone = (v: string) => /^\+?\d[\d\s().-]{6,}$/.test(v)

const isTrustedFullName = (name: string): boolean => {
  const t = clean(name)
  if (!t || INVALID_NAMES.has(t.toLowerCase())) return false
  if (looksLikePhone(t)) return false
  const parts = t.split(/\s+/).filter(Boolean)
  return parts.length >= 2 || t.length >= 14
}

export interface SellerIdentity {
  primary: string
  secondary: string | null
  masterOwner: string | null
  phoneEnding: string | null
  glyph: 'person' | 'property' | 'unknown'
}

export const resolveSellerIdentity = (item: QueueItem): SellerIdentity => {
  const md = (item.metadata && typeof item.metadata === 'object' ? item.metadata : {}) as Record<string, unknown>
  const targetSnap = (md.target_snapshot && typeof md.target_snapshot === 'object' ? md.target_snapshot : {}) as Record<string, unknown>
  const candidateSnap = (md.candidate_snapshot && typeof md.candidate_snapshot === 'object' ? md.candidate_snapshot : {}) as Record<string, unknown>

  const activeProspect = clean(
    item.activeProspectFullName
    || String(targetSnap.prospect_full_name ?? targetSnap.active_prospect_full_name ?? ''),
  )
  const bestProspect = clean(
    item.sellerFullNameResolved
    || item.sellerFullName
    || item.sellerDisplayName
    || String(targetSnap.seller_full_name ?? ''),
  )
  const masterOwner = clean(
    item.masterOwnerDisplayName
    || String(candidateSnap.owner_display_name ?? targetSnap.owner_display_name ?? ''),
  )
  const phone = clean(item.toPhoneNumber || item.phone)
  const phoneEnding = phone ? `…${phone.replace(/\D/g, '').slice(-4)}` : null

  const ordered = [activeProspect, bestProspect, masterOwner, phone, 'Unknown Contact']
  let primary = 'Unknown Contact'
  for (const candidate of ordered) {
    const t = clean(candidate)
    if (!t) continue
    if (candidate === phone || looksLikePhone(t)) {
      primary = t
      break
    }
    if (isTrustedFullName(t) || candidate === 'Unknown Contact') {
      primary = t
      break
    }
    if (!primary || primary === 'Unknown Contact') primary = t
  }

  let secondary: string | null = null
  if (activeProspect && primary !== activeProspect && isTrustedFullName(activeProspect)) {
    secondary = activeProspect
  } else if (masterOwner && primary !== masterOwner && isTrustedFullName(masterOwner)) {
    secondary = masterOwner
  } else if (bestProspect && primary !== bestProspect && isTrustedFullName(bestProspect)) {
    secondary = bestProspect
  }

  const glyph: SellerIdentity['glyph'] = item.linkedPropertyId ? 'property' : primary !== 'Unknown Contact' ? 'person' : 'unknown'

  return { primary, secondary, masterOwner: masterOwner || null, phoneEnding, glyph }
}

export const displayName = (item: QueueItem): string => resolveSellerIdentity(item).primary

export const formatDisplayStatus = (status: string): string => {
  if (status === 'approval') return 'Approval Required'
  if (status === 'held') return 'Paused'
  return status.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

export interface StatusPresentation {
  primary: string
  tone: string
  blocking: string | null
  historicalWarnings: string[]
}

export const resolveStatusPresentation = (item: QueueItem): StatusPresentation => {
  const toneMap: Record<string, string> = {
    scheduled: 'blue', queued: 'blue', sending: 'cyan', sent: 'green',
    delivered: 'green', failed: 'red', retry: 'red', blocked: 'amber',
    held: 'amber', approval: 'amber', cancelled: 'muted',
    paused_name_missing: 'amber', paused_invalid_queue_row: 'amber',
    paused_max_retries: 'amber', paused_duplicate: 'amber',
    paused_global_lock: 'amber', duplicate_blocked: 'muted',
    incident_quarantine: 'red', expired: 'muted', replied_before_send: 'green',
  }

  const historicalWarnings: string[] = []
  for (const flag of item.diagnosticFlags) {
    if (flag === 'MISSING_TEMPLATE' && item.status === 'delivered') historicalWarnings.push('Missing Template (historical)')
    else if (flag === 'MISSING_MESSAGE_EVENT' && ['delivered', 'sent'].includes(item.status)) historicalWarnings.push('Message Event Missing')
    else if (flag === 'MISSING_PROVIDER_ID' && item.status === 'delivered') historicalWarnings.push('Missing Provider ID')
    else if (!['MISSING_TEMPLATE', 'MISSING_MESSAGE_EVENT', 'MISSING_PROVIDER_ID'].includes(flag)) {
      historicalWarnings.push(flag.replace(/_/g, ' '))
    }
  }

  let blocking: string | null = null
  if (BLOCKED_STATUSES.has(item.status)) {
    blocking = item.blockedReason || item.pausedReason || item.guardReason || 'Blocked by queue guard'
  } else if (isFailed(item.status) && item.failureCategory) {
    blocking = FAILURE_LABEL[item.failureCategory] ?? item.failureCategory.replace(/_/g, ' ')
  } else if (item.status === 'approval') {
    blocking = item.approvalReason || 'Operator approval required'
  }

  return {
    primary: formatDisplayStatus(item.status),
    tone: toneMap[item.status] ?? 'muted',
    blocking,
    historicalWarnings,
  }
}

export const NON_RETRYABLE_CATEGORIES = new Set([
  'blacklist_pair_21610',
  'recipient_opted_out',
  'suppression_blocked',
  'invalid_number',
])

export const isNonRetryableRow = (item: QueueItem): boolean =>
  NON_RETRYABLE_CATEGORIES.has(item.failureCategory ?? '')
  || item.failureCategory === 'blacklist_pair_21610'
  || (item.failedReason ?? '').includes('21610')
  || !item.retryEligible

export interface BulkActionPreview {
  action: string
  affected: number
  eligible: number
  excluded: number
  markets: string[]
  senders: string[]
  retryable: number
  nonRetryable: number
  irreversible: boolean
  requiresPhrase: boolean
}

export const buildBulkActionPreview = (
  action: string,
  items: QueueItem[],
  rangeFailed?: number,
): BulkActionPreview => {
  const failedRows = items.filter(i => isFailed(i.status) || BLOCKED_STATUSES.has(i.status))
  const retryCandidates = items.filter(i => isFailed(i.status) && i.retryEligible && !isNonRetryableRow(i))
  const excluded = items.filter(i => isFailed(i.status) && isNonRetryableRow(i))

  const markets = [...new Set(items.map(i => i.market).filter(m => m && m !== 'Market unknown'))].sort()
  const senders = [...new Set(items.map(i => i.fromPhoneNumber).filter(Boolean))].sort()

  if (action === 'retry-all-failed') {
    const affected = rangeFailed ?? failedRows.length
    return {
      action,
      affected,
      eligible: retryCandidates.length,
      excluded: excluded.length,
      markets,
      senders,
      retryable: retryCandidates.length,
      nonRetryable: excluded.length,
      irreversible: false,
      requiresPhrase: affected > 25,
    }
  }

  if (action === 'run-queue-now') {
    const runnable = items.filter(i => ['scheduled', 'queued', 'ready'].includes(i.status))
    return {
      action,
      affected: runnable.length,
      eligible: runnable.length,
      excluded: 0,
      markets,
      senders,
      retryable: 0,
      nonRetryable: 0,
      irreversible: false,
      requiresPhrase: false,
    }
  }

  return {
    action,
    affected: items.length,
    eligible: items.length,
    excluded: 0,
    markets,
    senders,
    retryable: 0,
    nonRetryable: 0,
    irreversible: action.includes('suppress') || action.includes('cancel'),
    requiresPhrase: action.includes('suppress'),
  }
}

export const templateHealthWithSample = (
  sent: number,
  failPct: number,
): { health: 'healthy' | 'watch' | 'degraded' | 'critical' | 'insufficient'; label: string } => {
  if (sent < 5) return { health: 'insufficient', label: 'Low sample' }
  if (failPct >= 30) return { health: 'critical', label: 'Critical' }
  if (failPct >= 15) return { health: 'degraded', label: 'Degraded' }
  if (failPct >= 5) return { health: 'watch', label: 'Watch' }
  return { health: 'healthy', label: 'Healthy' }
}

export const pct = (num: number, den: number) => den > 0 ? Math.round((num / den) * 100) : 0