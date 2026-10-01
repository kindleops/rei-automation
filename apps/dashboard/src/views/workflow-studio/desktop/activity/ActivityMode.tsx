import { useMemo, useState } from 'react'
import { LCActivityFeed, LCError, LCSearch, LCSegmented, LCSelect, LCToolbar, type LCActivityEvent } from '../../../../shared/lc'
import { fetchActivity, fetchRuns } from '../lib/api'
import { WORKFLOW_FAMILY } from '../lib/families'
import { words } from '../lib/format'
import { useResource } from '../lib/resource'
import type { ActivityGroup, ActivityResponse, RunsResponse, WorkflowFamily } from '../lib/types'
import { useStudio } from '../studio-context'

type Kind = 'all' | 'human' | 'held' | 'failed' | 'waiting' | 'approvals' | 'domain'
const KINDS: Array<{ value: Kind; label: string }> = [
  { value: 'all', label: 'All runs' }, { value: 'human', label: 'Needs a person' }, { value: 'approvals', label: 'Approvals' },
  { value: 'waiting', label: 'Waits' }, { value: 'held', label: 'Holds' }, { value: 'failed', label: 'Failures' }, { value: 'domain', label: 'Domain events' },
]
const WINDOWS = [{ value: '24', label: '24h' }, { value: '72', label: '3d' }, { value: '168', label: '7d' }] as const
const TONE: Record<string, 'ok' | 'exec' | 'attn' | 'crit' | 'neutral' | 'flow'> = { completed: 'ok', running: 'exec', waiting: 'exec', held: 'attn', needs_you: 'attn', failed: 'crit', cancelled: 'neutral' }
const WORD: Record<string, string> = { completed: 'Handled', running: 'Running', waiting: 'Waiting', held: 'Held', needs_you: 'Needs you', failed: 'Failed', cancelled: 'Withdrawn' }

/**
 * ACTIVITY — what automation did, system-wide, as meaning: one entry per run,
 * repetition collapsed ("287 campaign passes · nothing placed"), expandable to
 * the exact entries. A click opens the run where it lives — on its canvas.
 */
export function ActivityMode() {
  const s = useStudio()
  const [kind, setKind] = useState<Kind>('all')
  const [hours, setHours] = useState<'24' | '72' | '168'>('24')
  const [family, setFamily] = useState<WorkflowFamily | 'ALL'>('ALL')
  const [q, setQ] = useState('')
  const act = useResource<ActivityResponse>(`activity:${hours}:${family}:${kind === 'human'}`, (sig) => fetchActivity({ hours: Number(hours), family: family === 'ALL' ? null : family, human: kind === 'human', limit: 300 }, sig), { interval: 30_000 })
  const domain = useResource<RunsResponse>(kind === 'domain' ? `runs:event_bridge:${hours}` : null, (sig) => fetchRuns('event_bridge', { period: hours === '24' ? '24h' : '7d', limit: 200 }, sig), { interval: 60_000 })

  const needle = q.trim().toLowerCase()
  const events: LCActivityEvent[] = useMemo(() => {
    if (kind === 'domain') {
      return (domain.data?.runs || []).filter((r) => !needle || `${r.trigger} ${r.subject.id || ''}`.toLowerCase().includes(needle)).map((r) => ({
        id: r.run_id,
        at: Date.parse(r.started_at || ''),
        title: words(r.trigger || 'event'),
        subject: r.subject.id ? `${words(r.subject.kind)} ${r.subject.id}` : undefined,
        source: 'Canonical event bridge → workflow inbox',
        icon: 'activity' as const,
        tone: 'flow' as const,
        groupKey: `domain:${r.trigger}`,
        groupNoun: `${words(r.trigger || 'events').toLowerCase()} events bridged`,
        onOpen: () => s.openRun('event_bridge', r.run_id, null),
      }))
    }
    const groups: ActivityGroup[] = (act.data?.groups || []).filter((g) => {
      if (kind === 'held' && g.status !== 'held') return false
      if (kind === 'failed' && g.status !== 'failed') return false
      if (kind === 'waiting' && !['waiting', 'running'].includes(g.status)) return false
      if (kind === 'approvals' && !g.events.some((e) => /approval/.test(e.event_type))) return false
      if (needle && !`${g.workflow_name} ${g.headline} ${g.subject?.name || ''} ${g.subject?.address || ''} ${g.facts.join(' ')} ${g.run_id}`.toLowerCase().includes(needle)) return false
      return true
    })
    return groups.map((g) => {
      // repetition collapses: scheduler passes and transport failures by their reason, never by the run
      const burst = g.workflow_key === 'campaign_execution' ? `${g.workflow_key}:${g.status}:${g.facts[0] || ''}` : g.workflow_key === 'queue_dispatch' ? `${g.workflow_key}:${g.status}:${g.facts[1] || g.facts[0] || ''}` : undefined
      return {
        id: g.group_id,
        at: Date.parse(g.at),
        title: <><b>{g.subject?.name || g.subject?.address || g.subject?.id || g.workflow_name}</b><span className="ws4-feed__status" data-tone={TONE[g.status]}>{WORD[g.status] || words(g.status)}{g.human ? ' · person' : ''}</span></>,
        subject: undefined,
        source: <span className="ws4-feed__src">{g.workflow_name}{g.facts.filter(Boolean).slice(0, 4).map((f, i) => <span key={i}>{f}</span>)}</span>,
        icon: WORKFLOW_FAMILY[g.family]?.icon || 'cpu',
        tone: TONE[g.status] || 'neutral',
        groupKey: burst,
        groupNoun: burst ? `${g.workflow_key === 'campaign_execution' ? 'campaign passes' : 'sends'} · ${(g.facts[0] || WORD[g.status] || '').toLowerCase()}` : undefined,
        onOpen: () => s.openRun(g.workflow_key, g.run_id, g.focus_node),
      }
    })
  }, [act.data, domain.data, kind, needle, s])

  const fams = useMemo(() => {
    const m = new Map<WorkflowFamily, number>()
    for (const g of act.data?.groups || []) m.set(g.family, (m.get(g.family) || 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [act.data])
  const read = kind === 'domain' ? domain : act
  return (
    <div className="ws4-activity">
      <LCToolbar
        search={<LCSearch value={q} onChange={setQ} label="Search activity" placeholder="Seller, property, workflow, campaign, run id…" />}
        filters={<LCSegmented size="sm" label="What happened" value={kind} onChange={setKind} options={KINDS} />}
        controls={<>
          {kind !== 'domain' ? <LCSelect size="sm" variant="chip" label="Family" prefix="Family" value={family} onChange={setFamily} options={[{ value: 'ALL', label: 'Everything' }, ...fams.map(([f, n]) => ({ value: f, label: `${WORKFLOW_FAMILY[f].label} · ${n}` }))]} /> : null}
          <LCSegmented size="sm" label="Window" value={hours} onChange={setHours} options={WINDOWS.map((w) => ({ value: w.value, label: w.label }))} />
        </>}
      />
      <div className="ws4-activity__feed lc-scroll">
        {read.error && !read.data ? <LCError what="Activity could not be read" detail={read.error} onRetry={read.reload} /> : (
          <LCActivityFeed
            events={events}
            loading={read.loading}
            max={240}
            tz="America/Chicago"
            label="Automation activity"
            empty={{ title: kind === 'approvals' ? 'No approvals in the window' : kind === 'failed' ? 'No failures in the window' : 'Nothing in the window', body: kind === 'approvals' ? 'No approval was requested or resolved — the one armed Studio workflow has no approval node.' : undefined }}
          />
        )}
        {act.data?.degraded?.length && kind !== 'domain' ? <p className="ws4-note">Could not read: {act.data.degraded.join(', ')} — those runtimes are missing here, not quiet.</p> : null}
        <p className="ws4-note">Notifications and bridged events restate the run that raised them, so they are not repeated here — “Domain events” lists what crossed the canonical bus into the workflow inbox.</p>
      </div>
    </div>
  )
}
