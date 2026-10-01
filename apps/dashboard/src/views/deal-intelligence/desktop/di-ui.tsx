import type { ReactNode } from 'react'
import { Icon, type IconName } from '../../../shared/icons'
import { cx } from '../../../shared/lc'

/**
 * Decision-room primitives. Planes are glass over the liquid environment;
 * semantic money tags keep MODELED / ESTIMATED / SUPPORTED / AUTHORIZED /
 * SELLER / ACTUAL from ever reading as the same kind of number.
 */

export type Under = 'exec' | 'ok' | 'attn' | 'crit' | 'flow' | 'neutral' | null

export function Plane({ id, eyebrow, title, aside, under, depth = 2, className, children, onHeaderClick, headerLabel }: {
  id: string
  eyebrow?: ReactNode
  title?: ReactNode
  aside?: ReactNode
  under?: Under
  depth?: 1 | 2 | 3
  className?: string
  children: ReactNode
  onHeaderClick?: () => void
  headerLabel?: string
}) {
  return (
    <section className={cx('dr-plane', `is-d${depth}`, className)} data-plane={id} data-under={under || undefined} aria-label={headerLabel ?? (typeof title === 'string' ? title : undefined)}>
      {eyebrow || title || aside ? (
        <header className="dr-plane__head">
          <div className="dr-plane__titles">
            {eyebrow ? <span className="dr-eyebrow">{eyebrow}</span> : null}
            {title ? (onHeaderClick ? <button type="button" className="dr-plane__title is-link" onClick={onHeaderClick}>{title}</button> : <h3 className="dr-plane__title">{title}</h3>) : null}
          </div>
          {aside ? <div className="dr-plane__aside">{aside}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  )
}

export type MoneyTag = 'modeled' | 'estimated' | 'supported' | 'authorized' | 'seller' | 'actual' | 'record' | 'policy' | 'scenario'

const TAG_LABEL: Record<MoneyTag, string> = {
  modeled: 'Modeled',
  estimated: 'Estimated',
  supported: 'Supported',
  authorized: 'Authorized',
  seller: 'Seller said',
  actual: 'Actual',
  record: 'Record',
  policy: 'Policy',
  scenario: 'Scenario',
}

export function Tag({ kind, children }: { kind: MoneyTag; children?: ReactNode }) {
  return <span className="dr-tag" data-kind={kind}>{children ?? TAG_LABEL[kind]}</span>
}

export function Prov({ p }: { p: string }) {
  const label = p === 'seller' ? 'Seller said' : p === 'record' ? 'Record' : p === 'system' || p === 'engine' ? 'System' : p === 'mls' ? 'MLS' : p
  return <span className="dr-prov" data-p={p}>{label}</span>
}

/** A labelled figure: the number, what kind of number it is, and its basis. */
export function Figure({ label, value, tag, basis, tone, size = 'md', onClick, selected }: {
  label: ReactNode
  value: ReactNode
  tag?: MoneyTag | null
  basis?: ReactNode
  tone?: 'exec' | 'ok' | 'attn' | 'crit' | 'flow' | null
  size?: 'sm' | 'md' | 'lg'
  onClick?: () => void
  selected?: boolean
}) {
  const body = (
    <>
      <span className="dr-fig__label">{label}{tag ? <Tag kind={tag} /> : null}</span>
      <span className="dr-fig__value lc-num" data-tone={tone || undefined}>{value}</span>
      {basis ? <span className="dr-fig__basis">{basis}</span> : null}
    </>
  )
  return onClick
    ? <button type="button" className={cx('dr-fig', `is-${size}`, 'is-link', selected && 'is-selected')} onClick={onClick} aria-pressed={selected}>{body}</button>
    : <div className={cx('dr-fig', `is-${size}`)}>{body}</div>
}

/** Thin meter 0..max with an optional threshold tick. */
export function Meter({ value, max = 100, threshold, tone, label }: { value: number | null; max?: number; threshold?: number | null; tone?: 'exec' | 'ok' | 'attn' | 'crit' | 'flow' | 'neutral'; label: string }) {
  const pct = value === null ? 0 : Math.max(0, Math.min(100, (value / max) * 100))
  return (
    <span className="dr-meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value ?? undefined}>
      <i className="dr-meter__fill" data-tone={tone || undefined} style={{ width: `${pct}%` }} />
      {typeof threshold === 'number' ? <b className="dr-meter__tick" style={{ left: `${Math.min(100, (threshold / max) * 100)}%` }} /> : null}
    </span>
  )
}

/** A semicircle gauge (seller signal), drawn once — no idle animation. */
export function Gauge({ value, tone, size = 132 }: { value: number | null; tone: string; size?: number }) {
  const v = Math.max(0, Math.min(100, value ?? 0))
  const r = 52
  const len = Math.PI * r
  return (
    <svg className="dr-gauge" width={size} height={size * 0.6} viewBox="0 0 132 78" style={{ ['--g' as string]: tone }} aria-hidden="true">
      <path d="M 14 70 A 52 52 0 0 1 118 70" className="dr-gauge__track" />
      <path d="M 14 70 A 52 52 0 0 1 118 70" className="dr-gauge__arc" strokeDasharray={len} strokeDashoffset={len * (1 - v / 100)} />
    </svg>
  )
}

export function Empty({ icon = 'database', title, body }: { icon?: IconName; title: string; body?: ReactNode }) {
  return (
    <div className="dr-empty">
      <span className="dr-empty__glyph" aria-hidden="true"><Icon name={icon} size={15} /></span>
      <div>
        <b>{title}</b>
        {body ? <p>{body}</p> : null}
      </div>
    </div>
  )
}

/** Inspector-facing label/value rows; values may be nodes. */
export function Facts({ rows }: { rows: ReadonlyArray<[ReactNode, ReactNode] | null | false> }) {
  const list = rows.filter(Boolean) as Array<[ReactNode, ReactNode]>
  return (
    <dl className="dr-facts">
      {list.map(([k, v], i) => (
        <div key={i} className="dr-facts__row">
          <dt>{k}</dt>
          <dd className="lc-num">{v === null || v === undefined || v === '' ? <span className="dr-none">Not recorded</span> : v}</dd>
        </div>
      ))}
    </dl>
  )
}
