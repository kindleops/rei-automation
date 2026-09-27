/**
 * COMPOSITION — what the cohort on screen is made of, on any dimension.
 *
 * Every bar is an exact server-side count under the SAME filters as the list
 * (record and buyer filters included), so the chart can never describe a
 * different cohort than the rows beneath it. Tapping a bar applies that
 * bucket as a real field filter; tapping it again removes it.
 *
 *   ranked bars   categorical dimensions and signals (signals do not add up;
 *                 the chart says so)
 *   histogram     banded numeric dimensions (value, equity, rate, years…)
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../../shared/icons'
import { CountUp } from '../../../shared/motion/CountUp'
import type { Composition, CompositionBucket, CompositionDimension } from '../../../domain/entity-graph/entity-graph-intel-api'
import type { EntityGraphFieldFilter } from '../../../domain/entity-graph/entity-graph-field-filters'
import { ARCHETYPE_LABEL, ASSET_FAMILY_LABEL, HOLD_FLIP_LABEL } from '../../../domain/entity-graph/entity-graph-intel-api'
import './entity-graph-composition.css'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

/** One restrained hue per dimension group — colour carries meaning, not decoration. */
const GROUP_HUE: Record<string, string> = {
  Asset: '#5ee7ff',
  Geography: '#7c9dff',
  Value: '#3ee6a4',
  Owner: '#f7c75b',
  Records: '#ff9f6b',
  Activity: '#34e8c4',
  Behaviour: '#a98bff',
  Assets: '#5ee7ff',
  Price: '#3ee6a4',
  Roles: '#f7c75b',
  Identity: '#7cc4ff',
}

const ENUM_LABEL: Record<string, string> = {
  ...ARCHETYPE_LABEL,
  ...HOLD_FLIP_LABEL,
  ...ASSET_FAMILY_LABEL,
  active: 'Active',
  inactive: 'Inactive',
  slowing: 'Slowing',
  unknown: 'Unknown',
  company: 'Company',
  person: 'Individual',
}

function bucketLabel(dimension: Composition['dimension'], bucket: CompositionBucket): string {
  if (!dimension) return bucket.label
  if (ENUM_LABEL[bucket.label]) return ENUM_LABEL[bucket.label]
  if (dimension.key === 'market' && bucket.label.includes('|')) return bucket.label.split('|').reverse().join(', ')
  return bucket.label
}

function sameFilter(a: EntityGraphFieldFilter, b: EntityGraphFieldFilter): boolean {
  return a.field_key === b.field_key && a.operator === b.operator && JSON.stringify(a.value ?? null) === JSON.stringify(b.value ?? null)
}

type Props = {
  scopeNoun: string
  total: number | null
  dimensions: CompositionDimension[]
  dimensionKey: string | null
  composition: Composition | null
  loading: boolean
  error: boolean
  collapsed: boolean
  fieldFilters: EntityGraphFieldFilter[]
  cohortLabel: string
  onToggleCollapsed: () => void
  onPickDimension: (key: string) => void
  onToggleFilter: (filter: EntityGraphFieldFilter) => void
  onRetry: () => void
}

export function EntityGraphComposition({
  scopeNoun,
  total,
  dimensions,
  dimensionKey,
  composition,
  loading,
  error,
  collapsed,
  fieldFilters,
  cohortLabel,
  onToggleCollapsed,
  onPickDimension,
  onToggleFilter,
  onRetry,
}: Props) {
  const [pressed, setPressed] = useState<string | null>(null)
  const pickerRef = useRef<HTMLDivElement | null>(null)
  const dimension = composition?.dimension ?? null
  const hue = GROUP_HUE[dimension?.group ?? dimensions.find((d) => d.key === dimensionKey)?.group ?? 'Asset'] ?? '#5ee7ff'

  // Keep the active dimension chip in view when it changes.
  useEffect(() => {
    const el = pickerRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    el?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' })
  }, [dimensionKey])

  const buckets = composition?.buckets ?? []
  const max = useMemo(() => Math.max(1, ...buckets.map((b) => b.value ?? 0)), [buckets])
  const histogram = dimension?.kind === 'banded'

  const grouped = useMemo(() => {
    const out: Array<{ group: string; items: CompositionDimension[] }> = []
    for (const d of dimensions) {
      const last = out[out.length - 1]
      if (last && last.group === d.group) last.items.push(d)
      else out.push({ group: d.group, items: [d] })
    }
    return out
  }, [dimensions])

  const isActive = (bucket: CompositionBucket) => Boolean(bucket.filter && fieldFilters.some((f) => sameFilter(f, bucket.filter as EntityGraphFieldFilter)))

  return (
    <section className={cls('egq', collapsed && 'is-collapsed')} style={{ ['--egq-hue' as string]: hue }}>
      <div className="egq__liquid" aria-hidden="true"><i /><i /></div>

      <button type="button" className="egq__head" onClick={onToggleCollapsed} aria-expanded={!collapsed}>
        <span className="egq__total">
          {total !== null ? <CountUp value={total} format={(v) => Math.round(v).toLocaleString()} /> : <span className="egq__dash">—</span>}
        </span>
        <span className="egq__noun">
          <b>{scopeNoun}</b>
          <small>{cohortLabel}</small>
        </span>
        <span className="egq__chev"><Icon name={collapsed ? 'chevron-down' : 'chevron-up'} /></span>
      </button>

      {!collapsed && dimensions.length > 0 ? (
        <>
          <div className="egq__picker" ref={pickerRef} role="tablist" aria-label="Break down by">
            {grouped.map((g) => (
              <div key={g.group} className="egq__group">
                <span className="egq__group-label">{g.group}</span>
                <div className="egq__chips">
                  {g.items.map((d) => (
                    <button
                      key={d.key}
                      type="button"
                      role="tab"
                      data-active={d.key === dimensionKey}
                      aria-selected={d.key === dimensionKey}
                      className={cls('egq__chip', d.key === dimensionKey && 'is-on')}
                      style={{ ['--chip-hue' as string]: GROUP_HUE[d.group] ?? hue }}
                      onClick={() => onPickDimension(d.key)}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className={cls('egq__chart', histogram ? 'is-histogram' : 'is-ranked', loading && 'is-loading')} key={`${dimension?.key ?? dimensionKey}`}>
            {loading && buckets.length === 0 ? (
              Array.from({ length: 6 }).map((_, i) => <div key={i} className="egq__ghost" style={{ ['--i' as string]: i }} />)
            ) : error ? (
              <div className="egq__error">
                <span>Couldn’t count this breakdown.</span>
                <button type="button" onClick={onRetry}>Retry</button>
              </div>
            ) : buckets.length === 0 ? (
              <div className="egq__error"><span>Nothing recorded for this cohort.</span></div>
            ) : histogram ? (
              <div className="egq__hist">
                {buckets.map((bucket, i) => {
                  const h = bucket.value ? Math.max(4, (bucket.value / max) * 100) : 2
                  const on = isActive(bucket)
                  const muted = bucket.key.startsWith('__')
                  return (
                    <button
                      key={bucket.key}
                      type="button"
                      className={cls('egq__col', on && 'is-on', muted && 'is-muted', pressed === bucket.key && 'is-pressed')}
                      style={{ ['--h' as string]: `${h}%`, ['--i' as string]: i }}
                      disabled={!bucket.filter}
                      onPointerDown={() => setPressed(bucket.key)}
                      onPointerUp={() => setPressed(null)}
                      onPointerLeave={() => setPressed(null)}
                      onClick={() => bucket.filter && onToggleFilter(bucket.filter)}
                      aria-label={`${bucketLabel(dimension, bucket)}: ${bucket.value?.toLocaleString() ?? 'not counted'}`}
                    >
                      <span className="egq__col-val">{bucket.value !== null ? compact(bucket.value) : '—'}</span>
                      <span className="egq__col-bar"><i /></span>
                      <span className="egq__col-label">{bucketLabel(dimension, bucket)}</span>
                      {pressed === bucket.key && bucket.share !== null ? (
                        <span className="egq__tip">{bucket.value?.toLocaleString()} · {(bucket.share * 100).toFixed(1)}%</span>
                      ) : null}
                    </button>
                  )
                })}
              </div>
            ) : (
              <ol className="egq__bars">
                {buckets.map((bucket, i) => {
                  const w = bucket.value ? Math.max(1.5, (bucket.value / max) * 100) : 0
                  const on = isActive(bucket)
                  const muted = bucket.key.startsWith('__')
                  return (
                    <li key={bucket.key} style={{ ['--w' as string]: `${w}%`, ['--i' as string]: i }}>
                      <button
                        type="button"
                        className={cls('egq__bar', on && 'is-on', muted && 'is-muted')}
                        disabled={!bucket.filter}
                        onClick={() => bucket.filter && onToggleFilter(bucket.filter)}
                      >
                        <span className="egq__bar-fill" aria-hidden="true" />
                        <span className="egq__bar-label">{bucketLabel(dimension, bucket)}</span>
                        <span className="egq__bar-num">
                          <b>{bucket.value !== null ? bucket.value.toLocaleString() : '—'}</b>
                          {bucket.share !== null ? <small>{formatShare(bucket.share)}</small> : null}
                        </span>
                        {on ? <span className="egq__bar-on"><Icon name="check" /></span> : null}
                      </button>
                    </li>
                  )
                })}
              </ol>
            )}
          </div>

          {composition?.note ? <p className="egq__note">{composition.note}</p> : null}
        </>
      ) : null}
    </section>
  )
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}K`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

function formatShare(share: number): string {
  const pct = share * 100
  if (pct > 0 && pct < 0.1) return '<0.1%'
  return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`
}
