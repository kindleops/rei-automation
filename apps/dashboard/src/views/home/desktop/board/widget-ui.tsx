import type { ReactNode } from 'react'
import { Icon } from '../../../../shared/icons'
import { LCButton, LCError, LCSkeleton } from '../../../../shared/lc'
import type { HomeLoad } from '../../home-signals'
import { cx } from './widget-runtime'

/* ── widget UI kit (LC-built; one look for every instrument) ─────────── */



/**
 * Loading / failure / empty for one source, quietly, in place. Children render
 * only with data. A failed refresh after a good read keeps the data (the
 * source store never blanks it).
 */
export function WState<T>({ load, what, onRetry, shape = 'lines', children }: { load: HomeLoad<T>; what: string; onRetry: () => void; shape?: 'metric' | 'lines' | 'chart'; children: (data: T) => ReactNode }) {
  if (load.status === 'loading') return <LCSkeleton shape={shape} count={shape === 'metric' ? 1 : 3} className="hb-skel" label={`Loading ${what}`} />
  if (load.status === 'unavailable') return <LCError compact what={`Couldn’t load ${what}`} detail={load.reason} onRetry={onRetry} retryLabel="Retry" className="hb-err" />
  return <>{children(load.data)}</>
}

export function WEmpty({ children, icon = 'check' }: { children: ReactNode; icon?: 'check' | 'clock' | 'activity' }) {
  return <p className="hb-empty"><Icon name={icon} size={13} />{children}</p>
}

/** A large numeral with its label — the instrument's primary reading. */
export function WFigure({ value, label, tone, sub, onClick, size = 'md' }: { value: ReactNode; label: string; tone?: 'ok' | 'attn' | 'crit' | 'exec' | 'flow' | null; sub?: ReactNode; onClick?: () => void; size?: 'md' | 'lg' | 'xl' }) {
  const body = (
    <>
      <b className="hb-fig__v">{value}</b>
      <span className="hb-fig__l">{label}</span>
      {sub ? <small className="hb-fig__s">{sub}</small> : null}
    </>
  )
  return onClick
    ? <button type="button" className={cx('hb-fig', `is-${size}`, tone && `is-${tone}`)} onClick={onClick}>{body}</button>
    : <div className={cx('hb-fig', `is-${size}`, tone && `is-${tone}`)}>{body}</div>
}

/** A row of small readings. Null values say "—", never 0. */
export function WFacts({ items }: { items: Array<{ label: string; value: ReactNode; /** ok · attn · crit · exec · flow */ tone?: string | null; title?: string }> }) {
  return (
    <dl className="hb-facts">
      {items.map((f) => (
        <div key={f.label} className={cx(f.tone && `is-${f.tone}`)} title={f.title}>
          <dt>{f.label}</dt>
          <dd>{f.value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  )
}

export function WAction({ label, onClick, icon = 'arrow-up-right' }: { label: string; onClick: () => void; icon?: 'arrow-up-right' | 'bolt' | 'map' }) {
  return <LCButton variant="quiet" size="sm" trailingIcon={icon} onClick={onClick} className="hb-action">{label}</LCButton>
}

