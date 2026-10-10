import { SOURCE_AUTHORITY_LABELS, EXTENDED_EVIDENCE_STATUS_META, type BriefClaim, type ExtendedEvidenceStatus, type OpportunityClass, type ContactReadinessClass } from '../contracts/contracts'
import type { FindingView, TimelineState } from '../model/research-model'
import type { SourceRef } from '../model/evidence-class'

export const fmtUsd = (n: number | null | undefined) => {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return n < 1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`
}

export const fmtClock = (iso: string | null | undefined) => {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })
}

export const fmtDur = (ms: number | null | undefined) => {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return ''
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  const m = Math.floor(ms / 60_000)
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`
}

export const fmtElapsed = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export const fmtDate = (iso: string | null | undefined) => {
  if (!iso) return ''
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export const fmtDay = (iso: string | null | undefined) => {
  if (!iso) return ''
  const d = new Date(iso.length <= 10 ? `${iso}T12:00:00Z` : iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/** The four verdicts the directive names: verified / contradicted / unavailable / awaiting review. */
export type Verdict = 'verified' | 'contradicted' | 'unavailable' | 'awaiting'
export const VERDICT_LABEL: Record<Verdict, string> = { verified: 'Verified', contradicted: 'Contradicted', unavailable: 'Unavailable', awaiting: 'Awaiting review' }

export function verdictOf(status: ExtendedEvidenceStatus, contradicted: boolean): Verdict {
  if (contradicted) return 'contradicted'
  if (status === 'unavailable' || status === 'blocked') return 'unavailable'
  if (status === 'county_confirmed' || status === 'recorded' || status === 'licensed_provider' || status === 'internal_record') return 'verified'
  return 'awaiting'
}

export const findingVerdict = (f: FindingView) => verdictOf(f.evidence_status, Boolean(f.contradicted_by))

export function claimVerdict(c: BriefClaim, findings: Record<string, FindingView>): Verdict {
  const contradicted = c.finding_ids.some((id) => findings[id]?.contradicted_by)
  return verdictOf(c.evidence_status, contradicted)
}

export const statusLabel = (s: ExtendedEvidenceStatus) => EXTENDED_EVIDENCE_STATUS_META[s]?.label ?? s

export const OPPORTUNITY_LABEL: Record<OpportunityClass, string> = { priority: 'Priority', strong: 'Strong', standard: 'Standard', weak: 'Weak', excluded: 'Excluded', unknown: 'Insufficient evidence' }
export const READINESS_LABEL: Record<ContactReadinessClass, string> = { ready: 'Ready to draft', held: 'Held', ineligible: 'Not eligible', unknown: 'Unknown' }

export const REASON_LABEL: Record<string, string> = {
  http_403: 'Refused automated access (HTTP 403)', captcha_detected: 'CAPTCHA presented to automated requests', login_required: 'Login required', robots_disallow: 'Disallowed by robots.txt', tos_restricted: 'Terms restrict automated use', not_in_registry: 'Not in the source registry',
  timeout: 'Timed out', http_5xx: 'Source error', parse_error: 'Could not parse the response', no_supported_source_for_jurisdiction: 'No supported source for this jurisdiction',
  interrupted_by_restart: 'Interrupted by an API restart — re-run as attempt 2', TOOL_TIMEOUT: 'The read timed out', SERVICE_UNAVAILABLE: 'The LeadCommand service did not answer',
}
export const reasonLabel = (r: string | null | undefined) => (r ? REASON_LABEL[r] ?? r : '')

export const authorityLabel = (s: Pick<SourceRef, 'authority_class'> | null) => (s ? (s.authority_class === 'unknown' ? 'Class not reported' : SOURCE_AUTHORITY_LABELS[s.authority_class]) : '')
export const TIMELINE_LABEL: Record<TimelineState, string> = { planned: 'Planned', running: 'Running', completed: 'Completed', failed: 'Failed', blocked: 'Blocked', needs_input: 'Needs input', unavailable: 'Unavailable', cancelled: 'Cancelled', skipped: 'Reused · fresh' }
