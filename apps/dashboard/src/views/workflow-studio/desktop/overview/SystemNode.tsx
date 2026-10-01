import { memo } from 'react'
import { Icon } from '../../../../shared/icons'
import { WORKFLOW_FAMILY } from '../lib/families'
import type { RegistryEntry, SystemNode as SystemNodeData } from '../lib/types'
import { systemFacts, systemStatus } from './system-model'

export interface SystemNodeState { selected: boolean; dim: boolean; neighbour: boolean; arrived: boolean; exceptions: number }

const KIND_ICON = { external: 'globe', domain: 'database', studio: 'spark', system: 'cpu' } as const

/** A system module on the architecture map: status, name, role, compact live state. */
export const SystemNodeCard = memo(function SystemNodeCard({ n, w, window, state, onSelect, onOpen }: {
  n: SystemNodeData
  w: RegistryEntry | null
  window: '24h' | '7d'
  state: SystemNodeState
  onSelect: (key: string) => void
  onOpen: (key: string) => void
}) {
  const st = systemStatus(n, w)
  const facts = systemFacts(n, w, window)
  const icon = n.kind === 'system' && w ? WORKFLOW_FAMILY[w.family]?.icon || 'cpu' : KIND_ICON[n.kind]
  const cls = ['wss', `is-${n.kind}`, state.selected && 'is-selected', state.dim && 'is-dim', state.neighbour && 'is-neighbour', state.arrived && 'is-arrived', n.tier === 'support' && 'is-support'].filter(Boolean).join(' ')
  return (
    <div
      className={cls}
      data-tone={st.tone}
      role="button"
      tabIndex={0}
      aria-pressed={state.selected}
      aria-label={`${n.label} — ${st.word}${facts.length ? ` · ${facts.map((f) => `${f.v} ${f.l}`).join(' · ')}` : ''}`}
      onClick={(e) => { e.stopPropagation(); onSelect(n.key) }}
      onDoubleClick={(e) => { e.stopPropagation(); onOpen(n.key) }}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onSelect(n.key) } }}
    >
      <span className="wss__plate" aria-hidden />
      <span className="wss__top">
        <span className="wss__status"><i aria-hidden />{st.word}</span>
        {state.exceptions ? <b className="wss__exc" title={`${state.exceptions} exception${state.exceptions === 1 ? '' : 's'}`}>{state.exceptions}</b> : null}
        <span className="wss__icon" aria-hidden><Icon name={icon} size={12} /></span>
      </span>
      <strong className="wss__name">{n.label}</strong>
      <small className="wss__sub">{n.kind === 'external' ? 'External runtime' : n.kind === 'domain' ? 'Canonical state' : n.kind === 'studio' ? 'Studio workflows' : 'System workflow'}{n.sub ? ` · ${n.sub}` : ''}</small>
      <span className="wss__facts">
        {facts.map((f, i) => <span key={i} data-tone={f.tone}><b className="lc-num">{f.v}</b>{f.l ? <em>{f.l}</em> : null}</span>)}
      </span>
    </div>
  )
})
