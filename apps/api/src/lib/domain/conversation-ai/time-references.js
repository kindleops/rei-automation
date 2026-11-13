// TIME REFERENCES a seller gives ("this winter", "by December", "in the spring", "after the holidays"), read
// deterministically. Shared by the writer-safety stale-time rule and the canonical fact ledger, so what the ledger
// records as the seller's timeline and what the stale-time rule checks are the same words.
//
// Owner rules (2026-10-30):
//   - a seasonal or month reference is a STATED timeline, never an urgency: nothing here classifies urgency;
//   - a relative reference is resolved only from the message's own timestamp (and the recipient's time zone when
//     it is known), only to a month or a season, never to a day: no exact deadline is invented;
//   - an ambiguous reference ("next winter" said before this winter started) keeps both readings;
//   - LeadCommand's markets are in the United States: seasons are northern-hemisphere meteorological seasons.

const norm = (t) => String(t || '').replace(/[\u2018\u2019\u02bc]/g, "'").replace(/\s+/g, ' ').trim()

// relative times a seller gives, resolved against the date they said it
export const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
export const SEASONS = { spring: [2, 4], summer: [5, 7], fall: [8, 10], autumn: [8, 10], winter: [11, 13] }
const NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12 }
const TIME_PATTERNS = [
  // "fall" only with a time word before it ("the roof could fall in" is not a season); the others bare (lowercase:
  // "Summer" as a first name is not a season) or after a time word
  [/\b(?:(next|this|in\s+the|in|by|until|till|after|before|around|come|early|late|mid|over\s+the|the|it'?s|is|for)\s+)(?:early\s+|late\s+|mid-?\s*)?(spring|summer|fall|autumn|winter)\b|\b(spring|summer|fall|autumn|winter)\s*(?:time|season)\b/gi, (m) => ({ key: `season:${(m[2] || m[3]).toLowerCase().replace('autumn', 'fall')}`, next: /^next$/i.test(m[1] || '') })],
  [/\b(spring|summer|autumn|winter)\b|(?:^|[.!?]\s+)(Spring|Summer|Autumn|Winter)\b/g, (m) => ({ key: `season:${(m[1] || m[2]).toLowerCase().replace('autumn', 'fall')}` })],
  // a capitalised month name is a month (bare "May" is too often the verb)
  [/\b(January|February|March|April|June|July|August|September|October|November|December)\b/g, (m) => ({ key: `month:${m[1].toLowerCase()}` })],
  [new RegExp(String.raw`\b(?:(next|in|by|until|till|after|before|around|early|late|mid|end\s+of|beginning\s+of|start\s+of|this|come)\s+)(?:mid-?\s*)?(${MONTHS.join('|')})\b`, 'gi'), (m) => ({ key: `month:${m[2].toLowerCase()}`, next: /^next$/i.test(m[1] || '') })],
  [/\b(next|this)\s+(week|month|year)\b/gi, (m) => ({ key: `rel:${m[1].toLowerCase()}_${m[2].toLowerCase()}` })],
  [/\bin\s+(a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve|[0-9]{1,2})\s+(day|week|month|year)s?\b/gi, (m) => ({ key: `in:${NUM[m[1].toLowerCase()] ?? Number(m[1])}_${m[2].toLowerCase()}` })],
  [/\b(?:in\s+)?a\s+(few|couple(?:\s+of)?)\s+(day|week|month)s\b/gi, (m) => ({ key: `few:${/^few/i.test(m[1]) ? 'few' : 'couple'}_${m[2].toLowerCase()}` })],
  [/\b(?:after|past|over|through)\s+the\s+holidays\b|\bafter\s+(?:the\s+)?new\s+year\b|\b(?:first|beginning|start)\s+of\s+(?:the|next)\s+year\b|\bearly\s+next\s+year\b/gi, () => ({ key: 'holidays' })],
  [/\b(?:end\s+of\s+(?:the|this)\s+year|year[\s-]end|later\s+this\s+year)\b/gi, () => ({ key: 'year_end' })],
]
/** Every relative time reference in a text: [{ key, next? }]. */
export function timeReferencesIn(text) {
  const t = norm(text)
  const out = []
  for (const [re, f] of TIME_PATTERNS) for (const m of t.matchAll(new RegExp(re.source, re.flags))) out.push(f(m))
  return out
}
const endOfMonth = (y, mo) => Date.UTC(y, mo + 1, 1) - 1
/** The last moment the reference can still be in the future, for a statement made at `saidAt` (ms), or null. */
export function timeReferenceEnd(ref, saidAt) {
  if (!Number.isFinite(saidAt)) return null
  const d = new Date(saidAt)
  const y = d.getUTCFullYear()
  const [kind, val] = String(ref.key).split(':')
  if (kind === 'season' || kind === 'month') {
    const [a, b] = kind === 'season' ? SEASONS[val] : [MONTHS.indexOf(val), MONTHS.indexOf(val)]
    const occ = [y - 1, y, y + 1, y + 2].map((yy) => ({ start: Date.UTC(yy, a, 1), end: endOfMonth(yy, b) })).filter((o) => o.end >= saidAt)
    const first = occ[0]
    if (!first) return null
    return ref.next && first.start <= saidAt ? occ[1]?.end ?? null : first.end
  }
  const DAY = 864e5
  if (kind === 'rel') return { this_week: saidAt + 7 * DAY, next_week: saidAt + 14 * DAY, this_month: endOfMonth(y, d.getUTCMonth()), next_month: endOfMonth(y, d.getUTCMonth() + 1), this_year: endOfMonth(y, 11), next_year: endOfMonth(y + 1, 11) }[val] ?? null
  if (kind === 'in' || kind === 'few') {
    const [n, unit] = val.split('_')
    const count = kind === 'few' ? ({ few: { day: 7, week: 6, month: 4 }, couple: { day: 3, week: 3, month: 3 } }[n]?.[unit]) : Number(n)
    const per = { day: DAY, week: 7 * DAY, month: 31 * DAY, year: 366 * DAY }[unit]
    return count && per ? saidAt + count * per : null
  }
  if (kind === 'holidays') return d.getUTCMonth() === 0 ? endOfMonth(y, 2) : endOfMonth(y + 1, 2)
  if (kind === 'year_end') return endOfMonth(y, 11)
  return null
}

// ── a SELLER's stated timeline (the fact ledger) ────────────────────────────────────────────────────────────────
// Stricter than timeReferencesIn (which flags any time word in OUR text): a seller's timeline needs a time word
// that places it ("this winter", "by December", "in the spring", "after school's out"), and a mention in a past
// context ("we bought it last winter", "since March", "back in December 2019") is not a timeline.
const MONTH_ALT = MONTHS.join('|')
const REL_WORD = String.raw`this|next|by|before|until|till|til|after|around|in\s+the|in|come|sometime\s+in(?:\s+the)?|early|late|mid|over\s+the|end\s+of|beginning\s+of|start\s+of|not\s+(?:until|till|before)|not\s+this|not\s+in(?:\s+the)?`
const SELLER_TIMELINE_PATTERNS = [
  [new RegExp(String.raw`\b(${REL_WORD})\s+(?:early\s+|late\s+|mid-?\s*)?(spring|summer|fall|autumn|winter)\b`, 'gi'), (m) => ({ key: `season:${m[2].toLowerCase().replace('autumn', 'fall')}`, relation: m[1] })],
  [new RegExp(String.raw`\b(${REL_WORD})\s+(?:mid-?\s*)?(${MONTH_ALT})\b(?:\s*,?\s*((?:19|20)[0-9]{2}))?`, 'gi'), (m) => ({ key: `month:${m[2].toLowerCase()}`, relation: m[1], year: m[3] ? Number(m[3]) : null })],
  [/\b(?:after|past|over|through)\s+the\s+holidays\b|\bafter\s+(?:the\s+)?new\s+year\b|\b(?:first|beginning|start)\s+of\s+(?:the|next)\s+year\b|\bearly\s+next\s+year\b/gi, (m) => ({ key: 'holidays', relation: 'after' })],
  [/\b(?:by\s+|before\s+|at\s+)?(?:the\s+)?end\s+of\s+(?:the|this)\s+year\b|\byear[\s-]end\b|\blater\s+this\s+year\b/gi, () => ({ key: 'year_end', relation: 'by' })],
  [/\b(this|next)\s+(month|year)\b/gi, (m) => ({ key: `rel:${m[1].toLowerCase()}_${m[2].toLowerCase()}`, relation: m[1] })],
  [/\b(?:after|when|once|by|before)\s+(?:the\s+)?(?:kids?\s+(?:are|get)\s+out\s+of\s+school|school(?:'s|\s+is|\s+gets|\s+lets)?\s+out|(?:the\s+)?end\s+of\s+(?:the\s+)?school\s+year)\b/gi, () => ({ key: 'school_year_end', relation: 'after' })],
]
// "back in December" is the past; "get back to me in the spring" is not (only "back" right before the time words)
const PAST_CONTEXT_RE = /(?:\b(?:since|last|ago|bought|purchased|inherited|moved\s+in|built|was|were|had|did|used\s+to)\b[^.?!;]*|\bback\s*)$/i

/**
 * The timeline references a seller states in one message: [{ key, relation, negated, stated, year? }].
 * Each is evidence of what they SAID, never an urgency.
 */
export function sellerTimelineMentions(text) {
  const t = norm(text)
  const out = []
  for (const [re, f] of SELLER_TIMELINE_PATTERNS) {
    for (const m of t.matchAll(new RegExp(re.source, re.flags))) {
      const before = t.slice(Math.max(0, m.index - 48), m.index)
      if (PAST_CONTEXT_RE.test(before)) continue
      const r = f(m)
      const relation = String(r.relation || '').toLowerCase().replace(/\s+/g, ' ')
      if (out.some((o) => o.key === r.key)) continue
      out.push({ key: r.key, relation, negated: /^not\b/.test(relation), stated: m[0].trim().toLowerCase(), ...(r.year ? { year: r.year } : {}) })
    }
  }
  return out
}

const pad = (n) => String(n).padStart(2, '0')
const ym = (y, mo) => `${y + Math.floor(mo / 12)}-${pad((mo % 12) + 1)}`
function localYearMonth(at, timeZone) {
  if (timeZone) {
    try {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric' }).formatToParts(new Date(at)).map((x) => [x.type, x.value]))
      return { y: Number(p.year), mo: Number(p.month) - 1 }
    } catch { return null }
  }
  // no time zone: the month is known only when every US time zone agrees on it (UTC−10 … UTC−4)
  const a = new Date(at - 10 * 3600e3); const b = new Date(at - 4 * 3600e3)
  if (a.getUTCFullYear() !== b.getUTCFullYear() || a.getUTCMonth() !== b.getUTCMonth()) return null
  return { y: a.getUTCFullYear(), mo: a.getUTCMonth() }
}

/**
 * Resolve one seller timeline reference against the moment the seller wrote it, to a MONTH or SEASON period, never a
 * day. { period: { from: 'YYYY-MM', to: 'YYYY-MM' } | null, ambiguous, alternatives?, basis }.
 * @param {{ key: string, relation?: string, year?: number|null }} ref
 * @param {{ saidAt?: number|string|null, timeZone?: string|null }} [o]
 */
export function resolveTimeReference(ref, { saidAt = null, timeZone = null } = {}) {
  const at = typeof saidAt === 'string' ? Date.parse(saidAt) : saidAt
  if (!Number.isFinite(at)) return { period: null, ambiguous: false, basis: 'no_message_timestamp' }
  const local = localYearMonth(at, timeZone)
  if (!local) return { period: null, ambiguous: false, basis: 'month_unknown_without_time_zone' }
  const { y, mo } = local
  const rel = String(ref.relation || '')
  const isNext = /^next$/.test(rel)
  const [kind, val] = String(ref.key).split(':')
  const span = (y0, a, b) => ({ from: ym(y0, a), to: ym(y0, b) })
  if (kind === 'month') {
    const m = MONTHS.indexOf(val)
    if (m < 0) return { period: null, ambiguous: false, basis: 'unknown_month' }
    // a stated year already behind the message is the past, not a timeline
    if (ref.year) return ref.year * 12 + m < y * 12 + mo ? { period: null, ambiguous: false, past: true, basis: 'stated_year_before_message' } : { period: span(ref.year, m, m), ambiguous: false, basis: 'stated_year' }
    const yr = m > mo || (m === mo && !isNext) ? y : y + 1
    return { period: span(yr, m, m), ambiguous: false, basis: 'next_occurrence_from_message_time' }
  }
  if (kind === 'season') {
    const [a, b] = SEASONS[val] || []
    if (a == null) return { period: null, ambiguous: false, basis: 'unknown_season' }
    // the occurrence that contains the message month, or else the next one to start (winter spans the new year)
    const occ = [y - 1, y, y + 1].map((yy) => ({ yy, s: yy * 12 + a, e: yy * 12 + b })).filter((o) => o.e >= y * 12 + mo)
    const now = y * 12 + mo
    const current = occ.find((o) => o.s <= now && now <= o.e)
    const upcoming = occ.find((o) => o.s > now)
    const following = upcoming ? occ.find((o) => o.s > upcoming.s) || { yy: upcoming.yy + 1 } : null
    if (current && !isNext) return { period: span(current.yy, a, b), ambiguous: false, basis: 'current_season' }
    if (current && isNext) return { period: span(current.yy + 1, a, b), ambiguous: false, basis: 'season_after_current' }
    if (!upcoming) return { period: null, ambiguous: false, basis: 'unresolved' }
    // "next winter" said before this winter began: the coming one or the one after
    if (isNext) return { period: span(upcoming.yy, a, b), ambiguous: true, alternatives: [span(following.yy, a, b)], basis: 'next_before_season_began' }
    return { period: span(upcoming.yy, a, b), ambiguous: false, basis: 'upcoming_season' }
  }
  if (kind === 'holidays') return { period: mo === 0 ? span(y, 0, 2) : span(y + 1, 0, 2), ambiguous: false, basis: 'after_the_holidays' }
  if (kind === 'year_end') return { period: span(y, Math.min(mo + 1, 11), 11), ambiguous: false, basis: 'rest_of_the_year' }
  if (kind === 'rel') {
    if (val === 'this_month') return { period: span(y, mo, mo), ambiguous: false, basis: 'message_month' }
    if (val === 'next_month') return { period: span(y, mo + 1, mo + 1), ambiguous: false, basis: 'month_after_message' }
    if (val === 'this_year') return { period: span(y, mo, 11), ambiguous: false, basis: 'rest_of_the_year' }
    if (val === 'next_year') return { period: span(y + 1, 0, 11), ambiguous: false, basis: 'year_after_message' }
  }
  return { period: null, ambiguous: false, basis: kind === 'school_year_end' ? 'local_school_calendar_unknown' : 'not_resolved' }
}
