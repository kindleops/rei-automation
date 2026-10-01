import { encodeB64Url } from '../../../domain/analytics/analytics-lab-api'

/**
 * CAMPAIGN COMMAND — the subject it publishes and the doors it opens.
 *
 * SUBJECT CONTRACT (Shell 6.0 linked context)
 *   produce   campaign  — `?campaign=<uuid>` on /campaign-command (pane-aware:
 *                         written through replaceRoutePath only when this app
 *                         owns the address bar), plus a `nexus:campaign-subject`
 *                         window event and the same value in sessionStorage
 *                         (`nexus:campaign-subject:v1`) for panes that follow.
 *             property  — selecting a target publishes the existing property
 *                         locator (domain/locator/property-locator), so linked
 *                         Map / Entity Graph / Deal Intelligence panes follow.
 *   consume   campaign  — the app follows `?campaign=` in its own location
 *                         (a pane re-pointed by the shell selects that campaign).
 *
 * Every door below opens a route and parameter the destination already reads,
 * except Queue, which has no campaign filter yet: it opens with `campaign_id`
 * carried for when it does, and the control says so.
 */

export const CAMPAIGN_SUBJECT_EVENT = 'nexus:campaign-subject'
const SUBJECT_KEY = 'nexus:campaign-subject:v1'

export type CampaignSubject = {
  campaignId: string
  name: string | null
  status: string | null
  markets: string[]
  timezone: string | null
  setAt: number
}

export function publishCampaignSubject(subject: Omit<CampaignSubject, 'setAt'>): void {
  const value: CampaignSubject = { ...subject, setAt: Date.now() }
  try { window.sessionStorage.setItem(SUBJECT_KEY, JSON.stringify(value)) } catch { /* storage blocked */ }
  try { window.dispatchEvent(new CustomEvent(CAMPAIGN_SUBJECT_EVENT, { detail: value })) } catch { /* non-DOM */ }
}

export function readCampaignSubject(): CampaignSubject | null {
  try {
    const raw = window.sessionStorage.getItem(SUBJECT_KEY)
    const v = raw ? (JSON.parse(raw) as CampaignSubject) : null
    return v?.campaignId ? v : null
  } catch { return null }
}

/* ── doors ─────────────────────────────────────────────────────────────── */

/** Queue owns dispatch. It has no campaign filter yet — the id rides along for when it does. */
export const queuePath = (campaignId: string) => `/queue?campaign_id=${encodeURIComponent(campaignId)}`

/** Analytics Lab: this campaign's sellers/messages/replies over its own lifetime, optionally one market. */
export function analyticsPath(campaignId: string, opts: { start?: string | null; end?: string | null; tz?: string | null; market?: string | null } = {}): string {
  const filters: Array<{ field: string; op: string; value: unknown }> = [{ field: 'campaign', op: 'in', value: [campaignId] }]
  if (opts.market) filters.push({ field: 'market', op: 'in', value: [opts.market] })
  const range = opts.start ? { preset: 'custom', start: opts.start, end: opts.end ?? new Date().toISOString() } : { preset: '30d' }
  const ctx = {
    v: 1, tz: opts.tz || 'America/Chicago', mode: 'campaigns', metric: 'reply_rate', groupBy: null,
    filters, segment: [], range, compare: { mode: 'none' }, grain: 'auto',
  }
  return `/analytics?lab=${encodeB64Url(ctx)}`
}

/** Calendar: the campaign's start, or today's send window, in the event's own zone. */
export function calendarPath(campaignId: string, opts: { scheduledFor?: string | null; tz?: string | null; status: string; now: number }): string {
  const day = (ms: number) => {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: opts.tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms)) } catch { return new Date(ms).toISOString().slice(0, 10) }
  }
  const scheduled = Date.parse(String(opts.scheduledFor ?? ''))
  if (['scheduled', 'queued'].includes(opts.status) && Number.isFinite(scheduled)) {
    return `/calendar?date=${day(scheduled)}&tz=event&event=${encodeURIComponent(`campaign:${campaignId}:start`)}`
  }
  const today = day(opts.now)
  return `/calendar?date=${today}&tz=event&event=${encodeURIComponent(`campaign:${campaignId}:window:${today}`)}`
}

/** Workflow Studio observes campaign execution as the system workflow `campaign_execution`; each feeder pass is a run. */
export function workflowPath(runId?: string | null): string {
  const q = new URLSearchParams({ wf: 'campaign_execution', mode: runId ? 'canvas' : 'live' })
  if (runId) q.set('run', runId)
  return `/workflow-studio?${q.toString()}`
}

export const entityGraphPath = (propertyId: string) => `/entity-graph/property/${encodeURIComponent(propertyId)}`

export function dealIntelligencePath(propertyId: string, masterOwnerId?: string | null): string {
  const q = new URLSearchParams({ property_id: propertyId })
  if (masterOwnerId) q.set('master_owner_id', masterOwnerId)
  return `/deal-intelligence?${q.toString()}`
}

export const pipelinePath = (opportunityId: string) => `/pipeline?opp=${encodeURIComponent(opportunityId)}`
