import type { CampaignFailuresResult } from './campaigns.adapter'
import type { CampaignFailureGroup } from './campaigns.types'

/**
 * Campaign exceptions, in operator language.
 *
 * The failures API groups rows by a category code — `expired_before_send`,
 * `compliance_terminalization`. This turns each group into what happened, in
 * words, and whether anyone needs to do something about it.
 *
 *   calm       nothing to do: it expired, was a duplicate, had no textable number
 *   refused    the carrier said no because the seller opted out — compliance working
 *   attention  something an operator can fix, or should know is going wrong
 *
 * Every sentence here describes what the backend records, and nothing more,
 * and reads right at a count of one or of six hundred.
 * Expiry says "none reached a seller" because stale expiry only ever takes rows
 * with no send evidence; "not confirmed" says there's no record, not that the
 * message was lost.
 */

export type ExceptionTone = 'calm' | 'refused' | 'attention'
export type ExceptionScope = 'sending' | 'audience'

export type ExceptionCopy = {
  title: string
  body: string
  tone: ExceptionTone
  /** Show the carrier's own words from the sample reasons, when there are any. */
  quote: boolean
}

const SENDING: Record<string, ExceptionCopy> = {
  expired_before_send: {
    title: 'Expired before sending',
    body: 'Queued but never sent, then withdrawn. Nothing reached the seller.',
    tone: 'calm',
    quote: false,
  },
  compliance_terminalization: {
    title: 'Refused by the carrier',
    body: 'The seller opted out of texts from the sending number, so the carrier wouldn’t deliver.',
    tone: 'refused',
    quote: true,
  },
  provider_unconfirmed: {
    title: 'Not confirmed',
    body: 'The carrier didn’t return a message ID, so there’s no record of delivery.',
    tone: 'attention',
    quote: false,
  },
  provider_failure: {
    title: 'Carrier error',
    body: 'TextGrid rejected the send.',
    tone: 'attention',
    quote: true,
  },
  invalid_destination: {
    title: 'Not a textable number',
    body: 'The number can’t receive texts.',
    tone: 'calm',
    quote: false,
  },
  missing_template: {
    title: 'No message to send',
    body: 'No approved message matched the seller’s stage and language.',
    tone: 'attention',
    quote: false,
  },
  routing_failure: {
    title: 'No sender number',
    body: 'No sender number was available when it was time to send.',
    tone: 'attention',
    quote: false,
  },
  duplicate_prevention: {
    title: 'Stopped as duplicates',
    body: 'The seller already had this message on its way, so the copy was stopped.',
    tone: 'calm',
    quote: false,
  },
  retry_exhaustion: {
    title: 'Gave up after retrying',
    body: 'Sending kept failing, so it stopped retrying.',
    tone: 'attention',
    quote: true,
  },
  queue_validation: {
    title: 'Held by a safety check',
    body: 'A check before sending stopped it.',
    tone: 'attention',
    quote: true,
  },
  template_held: {
    title: 'Held by a template block',
    body: 'Its message template was on the blocked list, so it wasn’t sent.',
    tone: 'attention',
    quote: false,
  },
  sender_held: {
    title: 'Held by a sender block',
    body: 'The sending number was on the blocked list, so it wasn’t sent.',
    tone: 'attention',
    quote: false,
  },
  health_guard_hold: {
    title: 'Held by a sender check',
    body: 'A sender health check stopped it before sending.',
    tone: 'attention',
    quote: false,
  },
  held_incomplete: {
    title: 'Held for missing details',
    body: 'Something it needed was missing, such as the seller’s name, so it wasn’t sent.',
    tone: 'attention',
    quote: false,
  },
  content_filtered: {
    title: 'Stopped by the carrier’s filter',
    body: 'The carrier’s content filter blocked the message.',
    tone: 'attention',
    quote: true,
  },
  transport_failure: {
    title: 'Couldn’t reach the carrier',
    body: 'The send failed before the carrier accepted it.',
    tone: 'attention',
    quote: true,
  },
  undelivered: {
    title: 'Not delivered',
    body: 'The carrier took the message but reported it couldn’t be delivered.',
    tone: 'calm',
    quote: false,
  },
  incident_quarantine: {
    title: 'Quarantined',
    body: 'Held back while an incident was reviewed.',
    tone: 'attention',
    quote: false,
  },
  internal_execution_error: {
    title: 'Didn’t send',
    body: 'Something went wrong before it went out.',
    tone: 'attention',
    quote: true,
  },
}

const AUDIENCE: Record<string, ExceptionCopy> = {
  compliance_suppression: {
    title: 'On a do-not-text list',
    body: 'Left out because they opted out or are suppressed.',
    tone: 'calm',
    quote: false,
  },
  invalid_destination: {
    title: 'No textable number',
    body: 'None of their numbers can receive texts.',
    tone: 'calm',
    quote: false,
  },
  no_sender_coverage: {
    title: 'No sender number for their area',
    body: 'Add sender coverage for their market to reach them.',
    tone: 'attention',
    quote: false,
  },
  missing_template: {
    title: 'No message for them',
    body: 'No approved message matched their stage and language.',
    tone: 'attention',
    quote: false,
  },
  language_coverage_missing: {
    title: 'No message in their language',
    body: 'Add an approved message in their language to include them.',
    tone: 'attention',
    quote: false,
  },
  history_unavailable: {
    title: 'Contact history unavailable',
    body: 'Their history couldn’t be checked, so they were left out to be safe.',
    tone: 'attention',
    quote: false,
  },
  missing_canonical_linkage: {
    title: 'Not matched to a seller',
    body: 'They couldn’t be tied to a seller record, so they were left out.',
    tone: 'calm',
    quote: false,
  },
  eligibility_routing_failed: {
    title: 'Didn’t qualify',
    body: 'They didn’t pass this campaign’s checks.',
    tone: 'calm',
    quote: false,
  },
  target_preparation_failure: {
    title: 'Left out of the audience',
    body: 'They were excluded when the audience was built.',
    tone: 'calm',
    quote: false,
  },
}

/** `some_code` → "Some code". Only for categories this file doesn't know yet. */
function humanizeCode(code: string): string {
  const text = String(code ?? '').replace(/[_:.-]+/g, ' ').trim()
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Other'
}

export function describeException(scope: ExceptionScope, category: string): ExceptionCopy {
  const known = (scope === 'sending' ? SENDING : AUDIENCE)[category]
  if (known) return known
  // Unknown to this file, so nobody has decided it's harmless.
  return { title: humanizeCode(category), body: '', tone: 'attention', quote: true }
}

/**
 * The carrier's own words from a stored failure reason, or null when the reason
 * is one of ours — a code, or an all-caps internal message — rather than
 * something worth quoting to a person.
 *
 *   'TextGrid HTTP failure: {"code":"21610","message":"The message From/To …"}'
 *     → 'The message From/To …'
 *   'stale_runnable_row_expired' → null
 *   'SEND FAILED - NO SID'       → null
 */
export function carrierWords(raw: string | null | undefined): string | null {
  const text = String(raw ?? '').trim()
  if (!text) return null
  const json = text.match(/\{[\s\S]*\}/)
  if (json) {
    try {
      const parsed = JSON.parse(json[0]) as { message?: unknown }
      if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message.trim()
    } catch {
      // Not JSON after all; judge the text itself.
    }
    return null
  }
  if (!/\s/.test(text)) return null
  if (text === text.toUpperCase()) return null
  return text
}

export type ExceptionEntry = {
  key: string
  scope: ExceptionScope
  category: string
  count: number
  latestAt: string | null
  copy: ExceptionCopy
  quotes: string[]
}

export type ExceptionSummary = {
  sending: ExceptionEntry[]
  audience: ExceptionEntry[]
  sendingTotal: number
  audienceTotal: number
  /** A total that stopped at the scan limit is a floor, shown with "+". */
  sendingIsFloor: boolean
  audienceIsFloor: boolean
  /** Entries somebody can act on, across both scopes. */
  attentionCount: number
}

const TONE_ORDER: Record<ExceptionTone, number> = { attention: 0, refused: 1, calm: 2 }

function toEntries(scope: ExceptionScope, groups: CampaignFailureGroup[]): ExceptionEntry[] {
  return groups
    .filter((g) => Number(g.count) > 0)
    .map((g) => {
      const copy = describeException(scope, g.failure_category)
      const quotes = copy.quote
        ? Array.from(new Set((g.sample_reasons ?? []).map(carrierWords).filter((q): q is string => Boolean(q)))).slice(0, 2)
        : []
      return {
        key: `${scope}:${g.failure_category}`,
        scope,
        category: g.failure_category,
        count: Number(g.count),
        latestAt: g.latest_at ?? null,
        copy,
        quotes,
      }
    })
    // What needs someone first, then the rest, largest first within each.
    .sort((a, b) => TONE_ORDER[a.copy.tone] - TONE_ORDER[b.copy.tone] || b.count - a.count)
}

export function summarizeExceptions(result: CampaignFailuresResult): ExceptionSummary {
  const sending = toEntries('sending', result.execution)
  const audience = toEntries('audience', result.targetPreparation)
  const sum = (entries: ExceptionEntry[]) => entries.reduce((n, e) => n + e.count, 0)
  return {
    sending,
    audience,
    // The API total is authoritative; the group sum only stands in when it's missing.
    sendingTotal: Math.max(Number(result.executionTotal) || 0, sum(sending)),
    audienceTotal: Math.max(Number(result.targetTotal) || 0, sum(audience)),
    sendingIsFloor: result.executionTruncated === true,
    audienceIsFloor: result.targetTruncated === true,
    attentionCount: [...sending, ...audience].filter((e) => e.copy.tone === 'attention').length,
  }
}

/** "Jun 26", or "Jun 26, 2025" outside the current year. */
export function formatExceptionDate(iso: string | null, now: Date = new Date()): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const sameYear = d.getFullYear() === now.getFullYear()
  return d.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })
}
