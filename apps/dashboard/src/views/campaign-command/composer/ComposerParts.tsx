import type { ReactNode } from 'react'
import { LCCounter, cx } from '../../../shared/lc'
import { Icon } from '../../../shared/icons'
import type { CheckState, Layer } from './composer-model'

/** A count that rolls to its new value (LCCounter: odometer, reduced-motion swap). */
export function RollingCount({ value }: { value: number }) {
  return <LCCounter value={value} />
}

const LAYER_INDEX: Record<Layer, string> = { audience: '01', strategy: '02', delivery: '03', schedule: '04', launch: '05' }

/**
 * One persistent layer of the composition. In a compact pane it collapses to
 * its header (the summary line keeps the composition legible); wider, every
 * layer stays open — earlier layers never disappear.
 */
export function Plane({ layer, title, summary, state, collapsed, onToggle, focused, children, className, aside }: {
  layer: Layer
  title: string
  summary: ReactNode
  state: CheckState | 'idle'
  collapsed: boolean
  onToggle: () => void
  focused?: boolean
  children: ReactNode
  className?: string
  aside?: ReactNode
}) {
  return (
    <section id={`ccz-${layer}`} className={cx('ccz-plane', `is-${layer}`, collapsed && 'is-collapsed', focused && 'is-focused', className)} aria-labelledby={`ccz-${layer}-title`} tabIndex={-1}>
      <header className="ccz-plane__head">
        <button type="button" className="ccz-plane__toggle" onClick={onToggle} aria-expanded={!collapsed} aria-controls={`ccz-${layer}-body`}>
          <span className="ccz-plane__idx">{LAYER_INDEX[layer]}</span>
          <span className="ccz-plane__title" id={`ccz-${layer}-title`}>{title}</span>
          <i className={cx('ccz-state', `is-${state}`)} aria-label={state === 'idle' ? undefined : `State: ${state}`} />
          <Icon name="chevron-down" size={13} />
        </button>
        <span className="ccz-plane__sum">{summary}</span>
        {aside ? <span className="ccz-plane__aside">{aside}</span> : null}
      </header>
      <div className="ccz-plane__body" id={`ccz-${layer}-body`}>{children}</div>
    </section>
  )
}

export function Kv({ k, v, tone }: { k: ReactNode; v: ReactNode; tone?: 'ok' | 'attn' | 'crit' | 'exec' | 'neutral' }) {
  return <div className={cx('ccz-kv', tone && `is-${tone}`)}><dt>{k}</dt><dd>{v}</dd></div>
}
