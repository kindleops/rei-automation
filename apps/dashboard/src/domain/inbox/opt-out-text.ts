// ─── opt-out-text.ts ────────────────────────────────────────────────────────
// WHOLE-WORD opt-out wording for DISPLAY heuristics only (timeline labels,
// keyword chips, persona hints). P0 2026-10-09: "chriSTOPher", "Kristopher",
// "Stopher", "Christophe" contain the substring "stop", and every
// `text.includes('stop')` in the inbox turned a greeting ("Hi Christopher, …")
// into a suppressed thread with a disabled composer.
//
// Two rules:
//   1. Suppression is SERVER STATE (is_suppressed / is_opt_out / inbox_bucket /
//      a canonical opt-out intent). The UI never re-scans message text to
//      decide a thread is suppressed — see `isServerSuppressed`.
//   2. Where the UI does read words (labels, highlights), it reads WORDS, never
//      substrings, and only the message text — never names or addresses.
//
// The semantics mirror the server classifier (apps/api classify.js
// detectComplianceFlag): a bare carrier keyword, a leading keyword, a
// sentence-final "stop" that is not "bus stop" / "don't stop", or an explicit
// stop-communication phrase. "non-stop", "bus stop near the house",
// "weekend", "Paramount", "Endicott" are not opt-outs.

const CARRIER_KEYWORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'optout', 'opt-out', 'opt out'])
const TRAILING_KEYWORDS = new Set(['stop', 'stopall', 'unsubscribe', 'optout', 'opt-out'])
const TRAILING_BLOCKERS = new Set(['bus', 'pit', 'non', 'dont', "don't", 'never', 'wont', "won't", 'cant', "can't", 'doesnt', "doesn't", 'didnt', "didn't", 'full', 'one', 'first', 'last', 'next'])

// Explicit stop-communication phrases. Every term is word-bounded on both
// sides; "stop" may not be glued to a hyphen ("non-stop").
const OPT_OUT_PHRASES: RegExp[] = [
  /(?<![\w-])stop\s+(?:all\s+)?(?:texting|text|texts|messaging|messages|message|contacting|contact|calling|sending|bothering|bugging)\b/i,
  /(?<![\w-])(?:unsubscribe|stopall|opt[\s-]?out)(?![\w-])/i,
  /\bremove\s+(?:me|my\s+(?:number|name|info))\b/i,
  /\btake\s+me\s+off\b/i,
  /\b(?:do\s+not|don'?t|dont)\s+(?:text|contact|message)\s+(?:me|us|this\s+number)\b/i,
  /\bplease\s+stop\b(?!\s+by\b)/i,
]

const normalize = (value: unknown): string => String(value ?? '')
  .replace(/[‘’]/g, "'")
  .trim()
  .toLowerCase()

const strip = (value: string): string => value.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '')

/** True when a single message's own wording asks to stop messages. Never pass names/addresses. */
export function isOptOutWording(messageText: unknown): boolean {
  const text = normalize(messageText)
  if (!text) return false
  const bare = strip(text).replace(/\s+/g, ' ')
  if (CARRIER_KEYWORDS.has(bare)) return true

  // Leading carrier keyword as its own token: "STOP please", "STOP. Also …".
  const lead = /^([a-z]+(?:[\s-]out)?)(?=[\s,.!;:]|$)/.exec(bare)
  if (lead && (lead[1] === 'stop' || lead[1] === 'stopall' || lead[1] === 'unsubscribe' || lead[1] === 'opt out' || lead[1] === 'opt-out')) {
    // "Stop by the house" / "stop over" are visits, not opt-outs.
    if (!/^stop\s+(?:by|over|in|at)\b/.test(bare)) return true
  }

  // Sentence-final standalone keyword: "NFS. Stop", "please stop!!!".
  const tokens = bare.split(/[\s,.;:!?]+/).filter(Boolean)
  const last = tokens[tokens.length - 1] || ''
  const prev = tokens[tokens.length - 2] || ''
  if (TRAILING_KEYWORDS.has(last) && !TRAILING_BLOCKERS.has(prev) && !/-stop$/.test(bare)) return true
  if (last === 'out' && prev === 'opt') return true

  return OPT_OUT_PHRASES.some((re) => re.test(text))
}

/** Whole-word / whole-phrase test. Use instead of `haystack.includes(term)` for keyword lists. */
export function containsWord(haystack: unknown, term: string): boolean {
  const text = normalize(haystack)
  const needle = normalize(term)
  if (!text || !needle) return false
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'iu').test(text)
}

export const containsAnyWord = (haystack: unknown, terms: readonly string[]): boolean =>
  terms.some((term) => containsWord(haystack, term))

export const countWordHits = (haystack: unknown, terms: readonly string[]): number =>
  terms.reduce((n, term) => n + (containsWord(haystack, term) ? 1 : 0), 0)

const OPT_OUT_INTENT_CODES = new Set([
  'stop', 'stop_texting', 'opt_out', 'optout', 'opted_out', 'unsubscribe', 'unsubscribed',
  'dnc', 'do_not_contact', 'dnc_opt_out', 'permanent_suppression',
])

/** An intent/bucket CODE (not prose) that the server uses for opt-out. Exact match only. */
export const isOptOutCode = (code: unknown): boolean =>
  OPT_OUT_INTENT_CODES.has(String(code ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_'))

const truthy = (v: unknown): boolean => v === true || v === 'true' || v === 1 || v === '1' || v === 'yes'

/**
 * Server suppression truth for a thread-like record. Reads flags and codes the
 * server wrote; never message bodies, names or addresses.
 */
export function isServerSuppressed(record: Record<string, unknown> | null | undefined): boolean {
  if (!record) return false
  const r = record
  if (truthy(r.is_suppressed) || truthy(r.isSuppressed) || truthy(r.threadIsSuppressed)) return true
  if (truthy(r.is_opt_out) || truthy(r.isOptOut) || truthy(r.opt_out) || truthy(r.optOut)) return true
  if (truthy(r.is_dnc) || truthy(r.isDnc) || truthy(r.dnc)) return true
  for (const key of ['inbox_bucket', 'inboxBucket', 'priority_bucket', 'priorityBucket', 'inboxStatus', 'inbox_status', 'status_bucket', 'inbox_category', 'inboxCategory', 'contactability_status', 'contactabilityStatus']) {
    const v = String(r[key] ?? '').trim().toLowerCase()
    if (v === 'suppressed' || v === 'opted_out' || isOptOutCode(v)) return true
  }
  return false
}
