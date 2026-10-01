import { useMemo, useState } from 'react'
import { Icon } from '../../../../shared/icons'
import { LCSearch } from '../../../../shared/lc'
import { WORKFLOW_FAMILY } from '../lib/families'
import { ago, count } from '../lib/format'
import type { LibraryGroup, RegistryEntry, WorkflowFamily } from '../lib/types'
import { stateOf } from './system-model'

const SECTIONS: Array<{ id: string; label: string; groups: LibraryGroup[]; open: boolean }> = [
  { id: 'system', label: 'System workflows', groups: ['live_system'], open: true },
  { id: 'studio', label: 'Studio workflows', groups: ['studio', 'drafts', 'paused'], open: true },
  { id: 'archived', label: 'Archived', groups: ['archived'], open: false },
  { id: 'not_running', label: 'Built · not running', groups: ['not_running'], open: false },
]
const FAMILY_ORDER: WorkflowFamily[] = ['SELLER', 'ACQUISITION', 'DELIVERY', 'CAMPAIGN', 'COMMUNICATION', 'CLOSING', 'EMAIL', 'BUYER', 'SYSTEM']

function spec(w: RegistryEntry): string[] {
  const s = w.stats
  const out: string[] = []
  if (w.group === 'not_running') { if (w.status_note) out.push(w.status_note); return out }
  if (w.workflow_key === 'campaign_execution') { if (s.runs_today !== null) out.push(`${count(s.runs_today)} passes today`); if (s.placed_today !== undefined) out.push(`${count(s.placed_today)} placed`) }
  else if (s.runs_today !== null && s.runs_today !== undefined) out.push(`${count(s.runs_today)} run${s.runs_today === 1 ? '' : 's'} today`)
  if (s.executing) out.push(`${count(s.executing)} executing`)
  if (s.last_run_at) out.push(`last ${ago(s.last_run_at).replace(' ago', '')}`)
  else if (w.heartbeat?.at) out.push(`beat ${ago(w.heartbeat.at).replace(' ago', '')}`)
  else if (w.status_note && w.status !== 'live') out.push(w.status_note)
  return out
}

/**
 * THE AUTOMATION RAIL — every automation, production first. System workflows
 * (by family), Studio workflows (armed · drafts · paused), then the archive
 * and what is built but not driven — collapsed, never mistaken for live.
 * Test fixtures never appear; their count is said once.
 */
export function AutomationRail({ workflows, selected, onSelect, exceptionsByWorkflow, onCollapse, onCreate }: {
  workflows: RegistryEntry[]
  selected: string | null
  onSelect: (key: string) => void
  exceptionsByWorkflow: Record<string, number>
  onCollapse?: () => void
  /** start a new Studio workflow from a blueprint */
  onCreate?: () => void
}) {
  const [open, setOpen] = useState<Record<string, boolean>>(() => Object.fromEntries(SECTIONS.map((s) => [s.id, s.open])))
  const [q, setQ] = useState('')
  const needle = q.trim().toLowerCase()
  const tests = workflows.filter((w) => w.test).length
  const visible = useMemo(() => workflows.filter((w) => !w.test && (!needle || `${w.name} ${w.family} ${w.owner_app} ${w.runtime}`.toLowerCase().includes(needle))), [workflows, needle])
  return (
    <nav className="ws4-rail" aria-label="Automations">
      <div className="ws4-rail__head">
        <LCSearch value={q} onChange={setQ} label="Find an automation" placeholder="Find an automation" />
        {onCollapse ? <button type="button" className="ws4-rail__collapse" onClick={onCollapse} aria-label="Hide the automation rail"><Icon name="chevron-left" size={14} /></button> : null}
      </div>
      <div className="ws4-rail__scroll lc-scroll">
        {SECTIONS.map((sec) => {
          const rows = visible.filter((w) => sec.groups.includes(w.group))
          if (!rows.length && !(sec.id === 'studio' && onCreate && !needle)) return null
          const isOpen = open[sec.id] || Boolean(needle)
          const fams = FAMILY_ORDER.map((f) => [f, rows.filter((r) => r.family === f)] as const).filter(([, l]) => l.length)
          const live = rows.filter((r) => ['live', 'armed'].includes(r.status)).length
          return (
            <section key={sec.id} className={`ws4-rail__sec is-${sec.id}`}>
              <button type="button" className="ws4-rail__sechead" onClick={() => setOpen((o) => ({ ...o, [sec.id]: !isOpen }))} aria-expanded={isOpen}>
                <span>{sec.label}</span>
                <em className="lc-num">{sec.id === 'system' || sec.id === 'studio' ? `${live} live · ${rows.length}` : rows.length}</em>
                <Icon name={isOpen ? 'chevron-up' : 'chevron-down'} size={12} />
              </button>
              {sec.id === 'studio' && onCreate && isOpen ? <button type="button" className="ws4-rail__new" onClick={onCreate}><Icon name="spark" size={12} />New workflow<span>from a blueprint · starts as a draft</span></button> : null}
              {isOpen ? fams.map(([f, list]) => (
                <div key={f} className="ws4-rail__fam">
                  {sec.id === 'system' ? <h5><Icon name={WORKFLOW_FAMILY[f].icon} size={11} />{WORKFLOW_FAMILY[f].label}</h5> : null}
                  <ul>
                    {list.map((w) => {
                      const st = stateOf(w)
                      const exc = exceptionsByWorkflow[w.workflow_key] || 0
                      return (
                        <li key={w.workflow_key}>
                          <button type="button" className={`ws4-row${selected === w.workflow_key ? ' is-on' : ''}${w.parent ? ' is-child' : ''}`} data-tone={st.tone} onClick={() => onSelect(w.workflow_key)} aria-current={selected === w.workflow_key ? 'true' : undefined} data-wf={w.workflow_key}>
                            <i className="ws4-row__dot" aria-hidden />
                            <span className="ws4-row__text">
                              <strong>{w.parent ? w.short_name : w.name.split(' · ')[0]}</strong>
                              <small><span className="is-state">{st.word}</span>{spec(w).map((p, i) => <span key={i}>{p}</span>)}</small>
                            </span>
                            {exc ? <b className="ws4-row__needs" title={`${exc} exception${exc === 1 ? '' : 's'}`}>{exc}</b> : null}
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
        {!visible.length ? <p className="ws4-quiet">No automation matches “{q}”.</p> : null}
        {tests ? <p className="ws4-rail__foot">{tests} test fixture{tests === 1 ? '' : 's'} hidden — never counted as operations</p> : null}
      </div>
    </nav>
  )
}
