import { useMemo, useState } from 'react'
import { Icon } from '../../../../shared/icons'
import { WORKFLOW_FAMILY_ICON, WORKFLOW_FAMILY_LABEL } from '../families'
import type { LibraryGroup, RegistryEntry, WorkflowFamily } from '../observatory-types'
import { ago } from '../../mobile/workflow-format'

const GROUPS: Array<{ id: LibraryGroup; label: string; open: boolean }> = [
  { id: 'live_system', label: 'Live system', open: true },
  { id: 'studio', label: 'Studio', open: true },
  { id: 'drafts', label: 'Drafts', open: true },
  { id: 'paused', label: 'Paused', open: true },
  { id: 'archived', label: 'Archived', open: false },
  { id: 'not_running', label: 'Not running', open: false },
]

const FAMILY_ORDER: WorkflowFamily[] = ['SELLER', 'ACQUISITION', 'COMMUNICATION', 'DELIVERY', 'CAMPAIGN', 'EMAIL', 'CLOSING', 'BUYER', 'SYSTEM']

const STATUS_WORD: Record<string, string> = { live: 'Live', idle: 'Idle', armed: 'Armed', paused: 'Paused', off: 'Off', not_running: 'Not running', draft: 'Draft', archived: 'Archived' }

/** One spec line, in the order an operator scans it: state · volume · attention · recency · version. */
export function specLine(w: RegistryEntry): string[] {
  const s = w.stats
  const parts: string[] = [STATUS_WORD[w.status] || w.status]
  if (w.status === 'not_running' || (w.status === 'off' && !s.runs_7d)) { if (w.status_note) parts.push(w.status_note); return parts }
  if (s.runs_today !== null && s.runs_today !== undefined) parts.push(`${s.runs_today} run${s.runs_today === 1 ? '' : 's'} today`)
  if (s.needs_you) parts.push(`${s.needs_you} need you`)
  if (s.in_flight && w.family === 'CAMPAIGN') parts.push(`${s.in_flight} live`)
  if (s.last_run_at) parts.push(`last run ${ago(s.last_run_at)}`)
  else if (w.heartbeat?.at) parts.push(`heartbeat ${ago(w.heartbeat.at)}`)
  if (w.runtime_version && w.runtime_version !== '—') parts.push(w.runtime_version)
  return parts
}

/**
 * THE LIBRARY. Every automation, grouped by where it stands (live system,
 * studio, drafts, paused, archived, not running), and within a group by
 * family. Test fixtures never appear. A row is one spec line — no pills.
 */
export function LibraryRail({ workflows, selected, onSelect, compact = false }: {
  workflows: RegistryEntry[]
  selected: string | null
  onSelect: (key: string) => void
  compact?: boolean
}) {
  const [open, setOpen] = useState<Record<string, boolean>>(() => Object.fromEntries(GROUPS.map((g) => [g.id, g.open])))
  const [q, setQ] = useState('')
  const needle = q.trim().toLowerCase()
  const visible = useMemo(() => workflows.filter((w) => !w.test && (!needle || `${w.name} ${w.family} ${w.owner_app} ${w.runtime}`.toLowerCase().includes(needle))), [workflows, needle])
  return (
    <nav className={`ws3-lib${compact ? ' is-compact' : ''}`} aria-label="Workflow library">
      <div className="ws3-lib__search">
        <Icon name="search" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a workflow" aria-label="Find a workflow" />
      </div>
      <div className="ws3-lib__scroll">
        {GROUPS.map((g) => {
          const rows = visible.filter((w) => w.group === g.id)
          if (!rows.length) return null
          const isOpen = open[g.id] || Boolean(needle)
          const byFamily = FAMILY_ORDER.map((f) => [f, rows.filter((r) => r.family === f)] as const).filter(([, list]) => list.length)
          return (
            <section key={g.id} className={`ws3-lib__group is-${g.id}`}>
              <button type="button" className="ws3-lib__ghead" onClick={() => setOpen((o) => ({ ...o, [g.id]: !isOpen }))} aria-expanded={isOpen}>
                <span>{g.label}</span><em>{rows.length}</em><Icon name={isOpen ? 'chevron-up' : 'chevron-down'} />
              </button>
              {isOpen ? byFamily.map(([f, list]) => (
                <div key={f} className="ws3-lib__family">
                  <h5><Icon name={WORKFLOW_FAMILY_ICON[f]} />{WORKFLOW_FAMILY_LABEL[f]}</h5>
                  <ul>
                    {list.map((w) => {
                      const spec = specLine(w)
                      return (
                        <li key={w.workflow_key}>
                          <button type="button" className={`ws3-lib__row is-${w.status}${selected === w.workflow_key ? ' is-on' : ''}`} onClick={() => onSelect(w.workflow_key)} aria-current={selected === w.workflow_key ? 'true' : undefined} data-wf={w.workflow_key}>
                            <i className={`ws3-state is-${w.status}`} aria-hidden />
                            <span className="ws3-lib__text">
                              <strong>{w.name}</strong>
                              <small>{spec.map((p, i) => <span key={i} className={i === 0 ? `is-state is-${w.status}` : /need you/.test(p) ? 'is-needs' : undefined}>{p}</span>)}</small>
                            </span>
                            {w.stats.needs_you ? <b className="ws3-lib__needs" aria-label={`${w.stats.needs_you} need you`}>{w.stats.needs_you}</b> : null}
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )) : null}
            </section>
          )
        })}
        {!visible.length ? <p className="ws3-quiet">No workflow matches.</p> : null}
      </div>
    </nav>
  )
}
