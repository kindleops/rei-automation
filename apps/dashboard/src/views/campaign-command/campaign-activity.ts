import type { CampaignActivityEvent } from '../../lib/api/backendClient'

/**
 * Campaign activity, in operator language.
 *
 * The event log is written by the backend for the backend: "Campaign launch
 * blocked — Blocked by campaign_status_not_queueable:paused,
 * auto_send_must_remain_disabled", and "Campaign launch planned — 0 targets
 * planned; 0 queue rows created." once every five minutes, 10,330 times for
 * Miami alone. This says what happened in words, marks the scheduler's idle
 * checks as quiet, and folds runs of the same event into one line.
 *
 * Numbers are only ever read out of the event's own text; nothing is inferred.
 */

export type ActivityTone = 'good' | 'warn' | 'bad' | 'neutral' | 'quiet'

export type ActivityEntry = {
  key: string
  title: string
  detail: string | null
  tone: ActivityTone
  /** How many identical events this line stands for (runs are folded). */
  count: number
  /** Newest and oldest event in the run. */
  at: string
  firstAt: string
}

const BLOCKER_WORDS: Array<[RegExp, string]> = [
  [/^campaign_status_not_queueable:paused$/, 'the campaign is paused'],
  [/^campaign_status_not_queueable:(\w+)$/, 'the campaign is $1'],
  [/^auto_send_must_remain_disabled$/, 'auto-send has to stay off'],
  [/^auto_reply_must_remain_disabled$/, 'auto-reply has to stay off'],
  [/^global_emergency_stop_active$/, 'the emergency stop is on'],
  [/^queue_emergency_stop_active$/, 'the emergency stop is on'],
  [/^no_ready_targets$/, 'nobody in the audience is ready'],
  [/^outside_contact_window$/, 'it’s outside texting hours'],
]

function humanizeCode(code: string): string {
  return code.replace(/[_:.-]+/g, ' ').trim().toLowerCase()
}

/** "a, b, c" → "a, b and c" */
function listOf(items: string[]): string {
  const unique = Array.from(new Set(items))
  if (unique.length <= 1) return unique[0] ?? ''
  return `${unique.slice(0, -1).join(', ')} and ${unique[unique.length - 1]}`
}

function blockerSentence(description: string): string | null {
  const m = description.match(/blocked by\s+(.+)$/i)
  if (!m) return null
  const reasons = m[1].split(',').map((code) => {
    const c = code.trim()
    for (const [re, words] of BLOCKER_WORDS) if (re.test(c)) return c.replace(re, words)
    return humanizeCode(c)
  }).filter(Boolean)
  return reasons.length ? `Held because ${listOf(reasons)}.` : null
}

const n = (s: string | undefined) => Number(s ?? 0)
const plural = (count: number, one: string, many: string) => `${count.toLocaleString()} ${count === 1 ? one : many}`

function sentenceCase(text: string): string {
  const t = text.trim()
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t
}

/** A description is worth showing as-is only if it reads like a sentence. */
function readable(description: string): string | null {
  const d = description.trim()
  if (!d) return null
  if (!/\s/.test(d)) return null
  return d
}

export function describeEvent(event: CampaignActivityEvent): Omit<ActivityEntry, 'key' | 'count' | 'at' | 'firstAt'> {
  const type = String(event.event_type ?? '')
  const description = String(event.description ?? '')
  const severity = String(event.severity ?? '').toLowerCase()
  const toneFor = (): ActivityTone =>
    severity === 'error' ? 'bad' : severity === 'warning' ? 'warn' : severity === 'success' ? 'good' : 'neutral'

  switch (type) {
    case 'campaign.launch_scheduled':
    case 'campaign.launch_no_send_planned': {
      const m = description.match(/(\d+)\s+targets? planned;\s*(\d+)\s+queue rows? created/i)
      const planned = n(m?.[1])
      const created = n(m?.[2])
      if (m && planned === 0 && created === 0) {
        return { title: 'Checked for sellers to queue', detail: 'Nothing new to queue.', tone: 'quiet' }
      }
      if (m && created > 0) {
        return { title: `Queued ${plural(created, 'message', 'messages')}`, detail: null, tone: 'good' }
      }
      if (m) {
        return {
          title: `Planned ${plural(planned, 'seller', 'sellers')}`,
          detail: type === 'campaign.launch_no_send_planned' ? 'Test mode — nothing was queued to send.' : 'Nothing was queued yet.',
          tone: 'neutral',
        }
      }
      return { title: 'Launch planned', detail: readable(description), tone: toneFor() }
    }
    case 'campaign.launch_blocked':
      return { title: 'Launch held', detail: blockerSentence(description) ?? readable(description), tone: 'warn' }
    case 'campaign.queue_plan_blocked':
      return { title: 'Queueing held', detail: blockerSentence(description) ?? readable(description), tone: 'warn' }
    case 'campaign.activated': {
      const m = description.match(/(\d+)\s+queue rows? inserted.*?(\d+)\s+total queue rows?/i)
      const detail = m
        ? (n(m[1]) > 0
            ? `${plural(n(m[1]), 'message', 'messages')} added to the queue.`
            : `${plural(n(m[2]), 'message', 'messages')} already in the queue.`)
        : readable(description)
      return { title: 'Campaign started', detail, tone: 'good' }
    }
    case 'campaign.converted_to_live': {
      const purge = description.match(/purged\s+(\d+)\s+proof rows?,\s*inserted\s+(\d+)\s+live rows?/i)
        ?? description.match(/test rows purged \((\d+)\)/i)
      const detail = purge
        ? (purge[2] !== undefined
            ? `Cleared ${plural(n(purge[1]), 'test message', 'test messages')} and queued ${plural(n(purge[2]), 'live one', 'live ones')}.`
            : `Cleared ${plural(n(purge[1]), 'test message', 'test messages')}.`)
        : null
      return { title: 'Switched to live', detail, tone: 'good' }
    }
    case 'campaign.targets_built': {
      const m = description.match(/(\d+)\s+target snapshots? written/i)
      return {
        title: m ? `Audience built · ${plural(n(m[1]), 'seller', 'sellers')}` : 'Audience built',
        detail: null,
        tone: 'good',
      }
    }
    case 'campaign.targets_build_skipped':
      return { title: 'Audience not rebuilt', detail: 'The seller graph was unavailable, so the audience stayed as it was.', tone: 'warn' }
    case 'campaign.targets_build_refused':
      return { title: 'Audience build refused', detail: readable(description), tone: 'warn' }
    case 'campaign.created':
      return { title: 'Draft saved', detail: null, tone: 'neutral' }
    case 'campaign.updated':
      return { title: 'Settings changed', detail: null, tone: 'neutral' }
    case 'campaign.cloned': {
      const m = description.match(/cloned from\s+"(.+)"/i)
      return { title: 'Duplicated', detail: m ? `Copied from “${m[1]}”.` : null, tone: 'neutral' }
    }
    case 'campaign.archived': {
      const m = description.match(/(\d+)\s+pending queue rows? cancelled/i)
      return {
        title: 'Archived',
        detail: m ? `${plural(n(m[1]), 'waiting message was', 'waiting messages were')} cancelled.` : null,
        tone: 'neutral',
      }
    }
    case 'campaign.queue_plan_refused_target_integrity': {
      const m = description.match(/(\d+)\s+candidate target\(s\) fall outside the\s+(\d+)\s+explicitly selected/i)
      return {
        title: 'Queueing refused',
        detail: m
          ? `${plural(n(m[1]), 'seller falls', 'sellers fall')} outside the ${plural(n(m[2]), 'property', 'properties')} you selected, so nothing was queued.`
          : readable(description),
        tone: 'bad',
      }
    }
    case 'campaign.quarantined_target_integrity': {
      const m = String(event.title ?? '').match(/widened by\s+(\d+)\s+unselected/i)
      return {
        title: 'Quarantined',
        detail: m ? `The audience included ${plural(n(m[1]), 'property', 'properties')} you didn’t select.` : readable(description),
        tone: 'bad',
      }
    }
    default: {
      const title = event.title?.trim() || sentenceCase(humanizeCode(type.replace(/^campaign\./, '')))
      return { title, detail: readable(description), tone: toneFor() }
    }
  }
}

/**
 * Newest first, with runs of identical lines folded into one. Only adjacent
 * repeats fold, so the order of what happened is never rearranged.
 */
export function buildActivity(events: CampaignActivityEvent[]): ActivityEntry[] {
  const sorted = [...events].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
  const out: ActivityEntry[] = []
  for (const event of sorted) {
    const d = describeEvent(event)
    const prev = out[out.length - 1]
    if (prev && prev.title === d.title && prev.detail === d.detail && prev.tone === d.tone) {
      prev.count += 1
      prev.firstAt = event.created_at
      continue
    }
    out.push({ key: event.id, ...d, count: 1, at: event.created_at, firstAt: event.created_at })
  }
  return out
}

/** Entries grouped under "Today", "Yesterday", or a date. */
export function groupActivityByDay(entries: ActivityEntry[], now: Date = new Date()): Array<{ day: string; entries: ActivityEntry[] }> {
  const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
  const today = dayKey(now)
  const y = new Date(now)
  y.setDate(now.getDate() - 1)
  const yesterday = dayKey(y)
  const groups: Array<{ day: string; entries: ActivityEntry[] }> = []
  for (const entry of entries) {
    const d = new Date(entry.at)
    const k = dayKey(d)
    const label = k === today
      ? 'Today'
      : k === yesterday
        ? 'Yesterday'
        : d.toLocaleDateString(undefined, d.getFullYear() === now.getFullYear()
          ? { weekday: 'short', month: 'short', day: 'numeric' }
          : { month: 'short', day: 'numeric', year: 'numeric' })
    const last = groups[groups.length - 1]
    if (last && last.day === label) last.entries.push(entry)
    else groups.push({ day: label, entries: [entry] })
  }
  return groups
}
