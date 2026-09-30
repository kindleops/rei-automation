import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../../../../shared/icons'
import { fetchActivity } from '../observatory-api'
import type { ActivityGroup, RegistryEntry, WorkflowFamily } from '../observatory-types'
import { WORKFLOW_FAMILY_LABEL } from '../families'
import { usePoll } from '../use-studio-data'
import { ago, clock } from '../../mobile/workflow-format'

const FAMILIES: Array<WorkflowFamily | 'ALL'> = ['ALL', 'SELLER', 'DELIVERY', 'CAMPAIGN', 'ACQUISITION', 'COMMUNICATION', 'CLOSING', 'EMAIL', 'BUYER', 'SYSTEM']
const WINDOWS = [{ h: 24, l: '24h' }, { h: 72, l: '3d' }, { h: 168, l: '7d' }]
const STATUS_WORD: Record<string, string> = { completed: 'Handled', waiting: 'Waiting', running: 'Running', held: 'Held', needs_you: 'Needs you', failed: 'Failed', cancelled: 'Stopped' }

function dayOf(at: string) {
  const d = new Date(at); const now = new Date()
  if (d.toDateString() === now.toDateString()) return 'Today'
  if (d.toDateString() === new Date(Date.now() - 86400e3).toDateString()) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
}

/**
 * ACTIVITY — meaningful domain events, grouped per run: one line per run with
 * the facts that matter ("Intent not interested 92% · Stage Ownership
 * confirmation → Offer interest · Follow-up Oct 30"). Filter by family or
 * "needs a person", search anything; a click opens the canvas at that run.
 */
export function ActivityMode({ workflows, onOpenRun }: { workflows: RegistryEntry[]; onOpenRun: (wf: string, run: string, node: string | null) => void }) {
  const [family, setFamily] = useState<WorkflowFamily | 'ALL'>('ALL')
  const [human, setHuman] = useState(false)
  const [hours, setHours] = useState(24)
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  useEffect(() => { const t = window.setTimeout(() => setDebounced(q), 280); return () => window.clearTimeout(t) }, [q])
  const act = usePoll((s) => fetchActivity({ hours, family: family === 'ALL' ? null : family, human, q: debounced, limit: 200 }, s), [hours, family, human, debounced], 20_000)
  const groups = act.data?.groups || []
  const byDay = useMemo(() => {
    const out: Array<[string, ActivityGroup[]]> = []
    for (const g of groups) { const d = dayOf(g.at); const last = out[out.length - 1]; if (last && last[0] === d) last[1].push(g); else out.push([d, [g]]) }
    return out
  }, [groups])
  const counts = useMemo(() => { const m: Record<string, number> = {}; for (const w of workflows) if (w.stats.runs_today) m[w.family] = (m[w.family] || 0) + (w.stats.runs_today || 0); return m }, [workflows])
  return (
    <div className="ws3-activity">
      <div className="ws3-bar">
        <div className="ws3-find is-inline is-wide"><Icon name="search" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search seller, property, workflow, campaign, run id…" aria-label="Search activity" /></div>
        <div className="ws3-seg" role="tablist" aria-label="Window">{WINDOWS.map((w) => <button key={w.h} type="button" role="tab" aria-selected={hours === w.h} className={hours === w.h ? 'is-on' : ''} onClick={() => setHours(w.h)}>{w.l}</button>)}</div>
        <button type="button" className={`ws3-btn${human ? ' is-on' : ''}`} aria-pressed={human} onClick={() => setHuman((v) => !v)}><Icon name="user" />Needs a person</button>
      </div>
      <div className="ws3-chips" role="tablist" aria-label="Family">
        {FAMILIES.map((f) => <button key={f} type="button" role="tab" aria-selected={family === f} className={`ws3-chip${family === f ? ' is-on' : ''}`} onClick={() => setFamily(f)}>{f === 'ALL' ? 'Everything' : WORKFLOW_FAMILY_LABEL[f]}{f !== 'ALL' && counts[f] ? <b>{counts[f]}</b> : null}</button>)}
      </div>
      <div className="ws3-activity__feed">
        {act.loading && !groups.length ? <div className="ws3-skel-rows" aria-busy="true">{Array.from({ length: 8 }, (_, i) => <span key={i} />)}</div> : null}
        {act.error && !groups.length ? <p className="ws3-quiet is-error">Activity could not be read — {act.error}.</p> : null}
        {!act.loading && !act.error && !groups.length ? <p className="ws3-quiet">Nothing matches in the last {WINDOWS.find((w) => w.h === hours)?.l}.</p> : null}
        {byDay.map(([day, list]) => (
          <section key={day} className="ws3-daygroup">
            <h4>{day}<em>{list.length}</em></h4>
            <ol>
              {list.map((g) => (
                <li key={g.group_id}>
                  <button type="button" className={`ws3-actrow is-${g.status}`} onClick={() => onOpenRun(g.workflow_key, g.run_id, g.focus_node)}>
                    <time title={clock(g.at)}>{new Date(g.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</time>
                    <i className={`ws3-dot is-${g.status}`} aria-hidden />
                    <span className="ws3-actrow__main">
                      <span className="ws3-actrow__wf">{g.workflow_name}{g.subject?.name || g.subject?.address ? <b> · {g.subject.name || g.subject.address}</b> : null}</span>
                      <span className="ws3-actrow__facts">{g.facts.filter(Boolean).slice(0, 5).map((f, i) => <span key={i}>{f}</span>)}</span>
                    </span>
                    <span className={`ws3-actrow__status is-${g.status}`}>{STATUS_WORD[g.status] || g.status}{g.human ? ' · person' : ''}</span>
                    <small>{ago(g.at)}</small>
                  </button>
                </li>
              ))}
            </ol>
          </section>
        ))}
        {act.data?.degraded?.length ? <p className="ws3-quiet is-error">Could not read: {act.data.degraded.join(', ')} — those runtimes are missing here, not quiet.</p> : null}
      </div>
    </div>
  )
}
