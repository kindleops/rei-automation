import type { IconName } from '../../../shared/icons'
import type { Home, OpState, ThreadSummary } from '../mobile/email-command-api'
import { ROLE_LABEL, ago, human, until, where, who } from '../mobile/email-format'

/**
 * EMAIL COMMAND DESK — the desktop's lenses over the one Email Command read
 * model. Pure: every view, count and signal below is derived from the payload
 * the server returns; nothing is invented, and a lens with no data says so.
 */

export type ViewKey =
  | 'overview' | 'needs_you' | 'system_handling' | 'waiting' | 'failed' | 'recent'
  | 'seller' | 'buyer' | 'title' | 'closings'
  | 'automations' | 'escalated' | 'unresolved'

export type QuickKey = 'all' | 'needs_you' | 'system_handling' | 'waiting' | 'failed' | 'seller' | 'buyer' | 'title' | 'closing' | 'automated' | 'manual'

export interface ViewDef { key: ViewKey; label: string; icon: IconName; group: 'inbox' | 'parties' | 'automation'; hint: string }

export const VIEWS: ViewDef[] = [
  { key: 'overview', label: 'Overview', icon: 'grid', group: 'inbox', hint: 'Everything open, by what it needs' },
  { key: 'needs_you', label: 'Needs you', icon: 'flag', group: 'inbox', hint: 'Exceptions only a person can decide' },
  { key: 'system_handling', label: 'System handling', icon: 'cpu', group: 'inbox', hint: 'LeadCommand owns the next move' },
  { key: 'waiting', label: 'Waiting', icon: 'clock', group: 'inbox', hint: 'We did our part — watch mode' },
  { key: 'failed', label: 'Failed', icon: 'alert', group: 'inbox', hint: 'What failed and what happens next' },
  { key: 'recent', label: 'Recent', icon: 'activity', group: 'inbox', hint: 'Operational history, newest first' },
  { key: 'seller', label: 'Sellers', icon: 'home', group: 'parties', hint: 'Reply-driven seller conversations' },
  { key: 'buyer', label: 'Buyers', icon: 'briefcase', group: 'parties', hint: 'Transactional buyer threads' },
  { key: 'title', label: 'Title', icon: 'file-text', group: 'parties', hint: 'Deadline-sensitive title threads' },
  { key: 'closings', label: 'Closings', icon: 'key', group: 'parties', hint: 'Every thread on a closing' },
  { key: 'automations', label: 'Active automations', icon: 'bolt', group: 'automation', hint: 'Automation owns these conversations' },
  { key: 'escalated', label: 'Escalated', icon: 'arrow-up-right', group: 'automation', hint: 'Automation stopped and handed you the decision' },
  { key: 'unresolved', label: 'Unresolved', icon: 'user', group: 'automation', hint: 'Senders not yet tied to a seller or deal' },
]
export const VIEW_BY_KEY = Object.fromEntries(VIEWS.map((v) => [v.key, v])) as Record<ViewKey, ViewDef>
export const isViewKey = (v: string | null | undefined): v is ViewKey => Boolean(v && v in VIEW_BY_KEY)

export const QUICK: Array<{ key: QuickKey; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'needs_you', label: 'Needs you' },
  { key: 'system_handling', label: 'System handling' },
  { key: 'waiting', label: 'Waiting' },
  { key: 'failed', label: 'Failed' },
  { key: 'seller', label: 'Seller' },
  { key: 'buyer', label: 'Buyer' },
  { key: 'title', label: 'Title' },
  { key: 'closing', label: 'Closing' },
  { key: 'automated', label: 'Automated' },
  { key: 'manual', label: 'Manual' },
]

/** Label + icon + weight for every operating state — never colour alone. */
export const STATE_META: Record<OpState | 'escalated', { label: string; icon: IconName; tone: 'gold' | 'cyan' | 'quiet' | 'red' | 'green' | 'muted' }> = {
  needs_you: { label: 'Needs you', icon: 'flag', tone: 'gold' },
  escalated: { label: 'Escalated', icon: 'arrow-up-right', tone: 'gold' },
  system_handling: { label: 'System handling', icon: 'cpu', tone: 'cyan' },
  waiting: { label: 'Waiting', icon: 'clock', tone: 'quiet' },
  failed: { label: 'Failed', icon: 'alert', tone: 'red' },
  unresolved: { label: 'Unresolved', icon: 'user', tone: 'muted' },
  done: { label: 'Resolved', icon: 'check', tone: 'green' },
}

const isClosing = (t: ThreadSummary) => ['title', 'buyer', 'lender'].includes(t.category) || t.context?.kind === 'closing'
const ownedByOperator = (t: ThreadSummary) => t.automation === 'paused_you_own_it'
const automationOwns = (t: ThreadSummary) => ['system_handling', 'waiting'].includes(t.state) && !['paused', 'paused_you_own_it'].includes(t.automation)

/** Every thread the payload carries, once (active lists first, then history). */
export function allThreads(home: Home | null): ThreadSummary[] {
  if (!home) return []
  const seen = new Map<string, ThreadSummary>()
  for (const t of [...home.needs_you, ...home.system_handling, ...home.waiting, ...home.failed, ...home.unresolved, ...home.recent]) if (!seen.has(t.id)) seen.set(t.id, t)
  return [...seen.values()]
}

const byRecent = (a: ThreadSummary, b: ThreadSummary) => String(b.last_message.at || '').localeCompare(String(a.last_message.at || ''))
const STATE_ORDER: OpState[] = ['needs_you', 'failed', 'system_handling', 'waiting', 'unresolved', 'done']
const byState = (a: ThreadSummary, b: ThreadSummary) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || byRecent(a, b)

/** The rows a view shows, in the order the server ranked them where it ranked them. */
export function viewRows(home: Home | null, view: ViewKey): ThreadSummary[] {
  if (!home) return []
  const all = allThreads(home)
  switch (view) {
    case 'overview': return [...home.needs_you, ...home.failed, ...home.system_handling, ...home.waiting, ...home.unresolved]
    case 'needs_you': return home.needs_you
    case 'system_handling': return home.system_handling
    case 'waiting': return home.waiting
    case 'failed': return home.failed
    case 'recent': return [...home.recent].sort(byRecent)
    case 'seller': return all.filter((t) => t.category === 'seller').sort(byState)
    case 'buyer': return all.filter((t) => t.category === 'buyer').sort(byState)
    case 'title': return all.filter((t) => t.category === 'title').sort(byState)
    case 'closings': return all.filter(isClosing).sort(byState)
    case 'automations': return all.filter(automationOwns).sort(byState)
    case 'escalated': return home.needs_you.filter((t) => t.escalated ?? Boolean(t.needs && !ownedByOperator(t)))
    case 'unresolved': return all.filter((t) => t.state === 'unresolved' || t.resolution !== 'resolved').sort(byRecent)
  }
}

/** Rail counts: server counts where the server counts, otherwise the loaded rows. */
export function viewCount(home: Home | null, view: ViewKey): number {
  if (!home) return 0
  const c = home.counts
  switch (view) {
    case 'overview': return c.needs_you + c.system_handling + c.waiting + c.failed + c.unresolved
    case 'needs_you': case 'system_handling': case 'waiting': case 'failed': return c[view]
    case 'recent': return home.recent.length
    case 'seller': case 'buyer': case 'title': case 'closings': return home.parties ? home.parties[view] : viewRows(home, view).length
    case 'automations': return home.automation_counts ? home.automation_counts.active : viewRows(home, view).length
    case 'escalated': return home.automation_counts ? home.automation_counts.escalated : viewRows(home, view).length
    case 'unresolved': return viewRows(home, view).length
  }
}

export function quickMatch(t: ThreadSummary, q: QuickKey): boolean {
  switch (q) {
    case 'all': return true
    case 'needs_you': case 'system_handling': case 'waiting': case 'failed': return t.state === q
    case 'seller': case 'buyer': case 'title': return t.category === q
    case 'closing': return isClosing(t)
    case 'automated': return !ownedByOperator(t) && (Boolean(t.origin?.automated) || Boolean(t.next) || automationOwns(t))
    case 'manual': return ownedByOperator(t) || Boolean(t.origin?.manual)
  }
}

/** People · emails · properties · subjects · what was said. */
export function searchMatch(t: ThreadSummary, text: string): boolean {
  const q = text.trim().toLowerCase()
  if (!q) return true
  return [who(t), t.counterparty.email, t.counterparty.name, where(t), t.subject, t.last_message.preview, t.market, t.needs?.reason]
    .some((v) => String(v || '').toLowerCase().includes(q))
}

export interface Group { key: string; label: string; icon: IconName; tone: string; rows: ThreadSummary[] }

/** Overview groups by what each conversation needs; every other lens is one list. */
export function groupRows(view: ViewKey, rows: ThreadSummary[]): Group[] {
  if (view !== 'overview') return [{ key: view, label: VIEW_BY_KEY[view].label, icon: VIEW_BY_KEY[view].icon, tone: 'plain', rows }]
  const order: Array<[OpState, string]> = [['needs_you', 'Needs you'], ['failed', 'Failed'], ['system_handling', 'System handling'], ['waiting', 'Waiting · watch mode'], ['unresolved', 'Unresolved senders']]
  return order.map(([s, label]) => ({ key: s, label, icon: STATE_META[s].icon, tone: STATE_META[s].tone, rows: rows.filter((r) => r.state === s) })).filter((g) => g.rows.length)
}

const NEEDS_SHORT: Record<string, string> = {
  title_issue: 'Title issue', wire_instructions_received: 'Wire details — verify by phone', legal_language: 'Legal language',
  approval_required: 'Terms change requested', closing_date_proposed: 'Closing date proposed', direction_requested: 'Direction requested',
  reply_needs_review: 'Unclear reply', identity_ambiguous: 'Which deal?', reply_on_taken_over_thread: 'Reply on your thread',
  seller_needs_review: 'Seller reply needs judgment', seller_brain_unavailable: 'Reply not processed', seller_email_no_conversation: 'Seller not linked',
  automation_failed: 'Automated email failed', address_bounced: 'Bounced — reroute', recipient_suppressed: 'Suppressed address',
  transport_outcome_unknown: 'Delivery unknown', stale_scheduled_message: 'Overdue email held', recipient_identity_uncertain: 'Recipient uncertain',
  business_state_changed: 'Deal changed', title_contact_changed: 'Title contact changed',
}
export const needsShort = (code: string | null | undefined) => (code ? NEEDS_SHORT[code] || human(code) : '')

/** The ONE key signal a row carries. */
export function rowSignal(t: ThreadSummary, now = Date.now()): string {
  switch (t.state) {
    case 'needs_you':
      if (t.approvals.length && !t.needs) return 'Draft to approve'
      return needsShort(t.needs?.code) || 'Your decision'
    case 'failed':
      return t.failure?.label || (t.last_failure ? human(t.last_failure.code) : 'Failed')
    case 'system_handling': {
      const n = t.next
      if (!n) return 'Processing a reply'
      if (n.status === 'sending') return 'Sending now'
      if (n.status === 'queued') return String(n.action || '').startsWith('seller.reply') ? 'Replying now' : 'Queued'
      if (n.status === 'retrying') return `Retrying · attempt ${(n.attempts || 0) + 1}`
      if (n.status === 'held') return 'Held by safety gate'
      const what = n.sequence && n.sequence > 1 ? `Follow-up #${n.sequence}` : 'Next send'
      return `${what} · ${until(n.at, now).replace(' · ', ' ')}`
    }
    case 'waiting': {
      const role = ROLE_LABEL[t.counterparty.role] || 'They'
      return `${role} has the ball${t.last_message.at ? ` · ${ago(t.last_message.at, now).replace(' ago', '')}` : ''}`
    }
    case 'unresolved': return t.resolution === 'ambiguous' ? 'Several possible matches' : 'Unidentified sender'
    default: return t.context?.kind === 'closing' && t.context.waiting_for ? t.context.waiting_for : 'Nothing pending'
  }
}

export const stateMetaFor = (t: ThreadSummary, view?: ViewKey) => (view === 'escalated' && t.state === 'needs_you' ? STATE_META.escalated : STATE_META[t.state])

export const initials = (t: ThreadSummary) => {
  const name = who(t)
  return (name.includes('@') ? name[0] : name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('')).toUpperCase()
}

/** Replace `{at}` with the operator's rendering of a timestamp. */
export function renderLine(text: string, at: string | null, fmt: 'ago' | 'until' | 'stamp' | null, now = Date.now()): string {
  if (!text.includes('{at}')) return text
  if (!at || !fmt) return text.replace(/\s*\{at\}/, '')
  const t = fmt === 'ago' ? ago(at, now) : fmt === 'until' ? until(at, now) : new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  return text.replace('{at}', t)
}
