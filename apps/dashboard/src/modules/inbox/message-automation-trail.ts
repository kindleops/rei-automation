/**
 * WHAT THE AUTOMATION DID WITH A MESSAGE — read, never inferred.
 *
 * Every inbound message carries the inbound-intelligence verdict and the
 * automation decision the webhook recorded (message_events.metadata): the
 * classified intent and its confidence, the seller's emotional state, the
 * stage before and after, any price the parser extracted, and what the
 * engine decided to do next. This turns that record into the short trail
 * shown under the message. A step appears only when its field is present;
 * a decision is labelled as planned, never as done — execution can be gated.
 */

export type TrailTone = 'accent' | 'good' | 'warn' | 'bad' | 'muted'

export interface TrailStep {
  key: string
  label: string
  value: string
  tone: TrailTone
}

type Rec = Record<string, unknown>

const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

/** "not_interested" → "Not interested"; "ownership_check" → "Ownership check". */
export function humanize(code: string): string {
  const s = code.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
  return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : ''
}

const NEGATIVE_EMOTION = /angr|frustrat|hostile|annoy|upset|irritat|rude|threat/i
const POSITIVE_EMOTION = /excit|motivat|eager|happy|interest|warm|positive/i
const NEGATIVE_INTENT = /not.?interested|wrong.?number|opt.?out|stop|hostile|not.?owner|do.?not/i
const POSITIVE_INTENT = /interested|asking.?price|asks.?offer|ownership.?confirmed|price|consider/i

const money = (n: number, currency?: string) => {
  const c = (currency || 'USD').toUpperCase()
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: c, maximumFractionDigits: 0 }).format(n)
  } catch {
    return `$${Math.round(n).toLocaleString('en-US')}`
  }
}

/** The engine's next-action codes, in the operator's words; anything else is humanized. */
const NEXT_ACTION_LABEL: Record<string, string> = {
  schedule_later_followup: 'Later follow-up',
  schedule_followup: 'Follow-up',
  send_safe_clarifier: 'Clarifying question',
  await_human: 'Waiting on you',
  manual_reply: 'Your reply',
  mark_not_interested: 'Mark not interested',
  reclassify_with_context: 'Re-read with context',
}

const shortDate = (iso: string): string | null => {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function buildAutomationTrail(metadata: unknown): TrailStep[] {
  const meta = rec(metadata)
  const payload = rec(meta.payload)
  const cls = rec(payload.metadata)
  const seller = rec(cls.seller_state)
  const decision = { ...rec(payload.automation_decision), ...rec(meta.automation_decision) }
  const steps: TrailStep[] = []

  // 1 · intent, with the classifier's confidence
  const intent = str(meta.detected_intent) || str(payload.detected_intent) || str(cls.detected_intent) || str(cls.primary_intent)
  if (intent) {
    const conf = num(meta.classification_confidence) ?? num(payload.classification_confidence) ?? num(cls.confidence)
    const pct = conf !== null ? Math.round((conf <= 1 ? conf * 100 : conf)) : null
    steps.push({
      key: 'intent',
      label: 'Intent detected',
      value: pct !== null ? `${humanize(intent)} · ${pct}%` : humanize(intent),
      tone: 'accent',
    })
  }

  // 2 · sentiment (the classifier's emotional read of the seller)
  const emotion = str(cls.emotion) || str(seller.emotional_state)
  if (emotion) {
    steps.push({
      key: 'sentiment',
      label: 'Sentiment',
      value: humanize(emotion),
      tone: NEGATIVE_EMOTION.test(emotion) ? 'warn' : POSITIVE_EMOTION.test(emotion) ? 'good' : 'muted',
    })
  }

  // 3 · language, only when it is not English
  const language = str(meta.language) || str(payload.language) || str(cls.language)
  if (language && !/^en(glish)?\b/i.test(language)) {
    steps.push({ key: 'language', label: 'Language', value: humanize(language), tone: 'muted' })
  }

  // 4 · stage movement
  const before = str(payload.stage_before) || str(meta.stage_before)
  const after = str(payload.stage_after) || str(meta.stage_after)
  if (before && after && before.toLowerCase() !== after.toLowerCase()) {
    steps.push({ key: 'stage', label: 'Stage advanced', value: `${humanize(before)} → ${humanize(after)}`, tone: 'good' })
  } else if (after) {
    steps.push({ key: 'stage', label: 'Stage', value: humanize(after), tone: 'muted' })
  }

  // 5 · a price the parser actually extracted
  const pp = rec(cls.price_parse)
  const facts = rec(rec(rec(rec(cls.shadow_stage_engine).layers).semantic).orchestrator)
  const priceValue = num(pp.value) ?? num(seller.price_mentioned) ?? num(rec(facts.extracted_facts).asking_price)
  if (priceValue !== null && priceValue > 0) {
    const asking = pp.qualifies_as_seller_asking_price === true
    steps.push({ key: 'price', label: asking ? 'Asking price extracted' : 'Price extracted', value: money(priceValue, str(pp.currency)), tone: 'good' })
  }

  // 6 · lead temperature the engine assigned
  const temp = str(decision.lead_temperature)
  if (temp) {
    steps.push({ key: 'temperature', label: 'Lead', value: humanize(temp), tone: /hot|warm/i.test(temp) ? 'good' : 'muted' })
  }

  // 7 · what the engine decided next — planned, not claimed as done
  const next = str(decision.next_action)
  if (next) {
    const when = str(decision.follow_up_at) ? shortDate(str(decision.follow_up_at)) : null
    const label = NEXT_ACTION_LABEL[next] ?? humanize(next)
    steps.push({ key: 'next', label: 'Next · planned', value: when ? `${label} · ${when}` : label, tone: 'accent' })
  }

  // 8 · reply handling
  const queued = str(payload.auto_reply_queue_id)
  const replyMode = str(decision.reply_mode)
  if (queued) {
    steps.push({ key: 'reply', label: 'Auto-reply', value: 'Queued', tone: 'good' })
  } else if (replyMode === 'none' || str(decision.reply_disposition) === 'no_reply') {
    steps.push({ key: 'reply', label: 'Auto-reply', value: 'None', tone: 'muted' })
  }

  // 9 · anything that needs a person, or that stops outreach
  const review = meta.needs_human_review === true || meta.human_review_required === true || payload.needs_human_review === true || decision.should_mark_human_review === true
  if (review) {
    const why = str(decision.human_review_reason)
    steps.push({ key: 'review', label: 'Needs review', value: why ? humanize(why) : 'Routed to you', tone: 'warn' })
  }
  const suppress = str(cls.suppression_scope)
  if (decision.should_suppress_contact === true || (suppress && suppress !== 'none')) {
    steps.push({ key: 'suppressed', label: 'Suppressed', value: suppress && suppress !== 'none' ? humanize(suppress) : humanize(str(decision.suppression_reason) || 'contact'), tone: 'bad' })
  }
  const exception = rec(decision.exception_workflow)
  if (str(exception.label)) {
    const owner = str(exception.owner)
    steps.push({ key: 'workflow', label: 'Workflow', value: owner ? `${str(exception.label)} → ${humanize(owner)}` : str(exception.label), tone: 'muted' })
  }

  // tone the intent after the fact, so it reads with the other signals
  const first = steps[0]
  if (first?.key === 'intent') {
    if (NEGATIVE_INTENT.test(intent)) first.tone = 'warn'
    else if (POSITIVE_INTENT.test(intent)) first.tone = 'good'
  }
  return steps
}

/** One quiet line for a collapsed trail: intent · confidence · sentiment. */
export function summarizeTrail(steps: TrailStep[]): string {
  const pick = (k: string) => steps.find((s) => s.key === k)?.value
  return [pick('intent'), pick('sentiment'), pick('stage')].filter(Boolean).join(' · ')
}
