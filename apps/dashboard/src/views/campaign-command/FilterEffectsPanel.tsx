/**
 * "Why this audience": every applied filter with the rows it removed, what is
 * left after it (and how much of that can queue), its column coverage, and
 * every filter that could NOT be applied with the reason. One component for
 * the desktop Composer and the mobile Reach screen.
 */
import { useEffect, useState } from 'react'
import { coverageWarning, describeFilterCondition, loadFilterEffects, type FilterEffectsResult } from './filter-effects'
import './filter-effects.css'

const COVERAGE_WARNS_FOR = new Set(['is_any_of', 'eq', 'gte', 'lte', 'between', 'contains', 'on_or_after', 'on_or_before', 'is_true'])

function hasAnyFilter(filters: Record<string, unknown> | null): boolean {
  if (!filters) return false
  return Object.values(filters).some((group) => Array.isArray(group) && group.length > 0)
}

export function FilterEffectsList({ result, format }: { result: FilterEffectsResult; format: (n: number) => string }) {
  if (!result.ok) {
    return <p className="cfx__note is-warn" role="status">Per-filter counts unavailable — {result.message}</p>
  }
  const n = (value: number | null) => (value === null ? '—' : format(value))
  return (
    <>
      <ol className="cfx__list">
        <li className="cfx__row is-base">
          <span className="cfx__label">Campaign audience</span>
          <span className="cfx__cond">every property with a seller path</span>
          <span className="cfx__nums"><b>{n(result.base_count)}</b></span>
        </li>
        {result.effects.map((effect, index) => {
          const warn = COVERAGE_WARNS_FOR.has(effect.operator) ? coverageWarning(effect, format) : null
          return (
            <li key={`${effect.field_key}:${index}`} className={`cfx__row${effect.failed ? ' is-failed' : ''}`}>
              <span className="cfx__label">{effect.label}</span>
              <span className="cfx__cond">{describeFilterCondition(effect)}</span>
              <span className="cfx__nums">
                {effect.failed ? (
                  <em>count failed</em>
                ) : (
                  <>
                    <span className="cfx__removed">{effect.removed ? `−${format(effect.removed)}` : 'no change'}</span>
                    <b>{n(effect.count_after)}</b>
                    <em>{n(effect.eligible_after)} eligible</em>
                  </>
                )}
              </span>
              {effect.coverage && (
                <span className={`cfx__cov${warn ? ' is-low' : ''}`}>
                  {effect.coverage.pct}% of {format(effect.coverage.of)} have a value
                </span>
              )}
              {warn && <span className="cfx__warn">{warn}</span>}
            </li>
          )
        })}
      </ol>
      {result.refused.length > 0 && (
        <ul className="cfx__refused" aria-label="Filters not applied">
          {result.refused.map((item, index) => (
            <li key={`${item.field_key}:${index}`} className="cfx__note is-warn">
              <strong>{item.label}</strong> can’t be applied — {item.message.replace(/^Not applied: /, '')}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

export function FilterEffectsPanel({
  filters,
  format,
  className = '',
}: {
  /** The serialized filter groups Reach counted. */
  filters: Record<string, unknown> | null
  format: (n: number) => string
  className?: string
}) {
  const key = filters ? JSON.stringify(filters) : ''
  const [state, setState] = useState<{ key: string; result: FilterEffectsResult } | null>(null)
  const active = hasAnyFilter(filters)

  useEffect(() => {
    if (!active) return
    const ctl = new AbortController()
    const timer = window.setTimeout(() => {
      loadFilterEffects(JSON.parse(key) as Record<string, unknown>, ctl.signal)
        .then((result) => { if (!ctl.signal.aborted) setState({ key, result }) })
        .catch((error: unknown) => {
          if (!ctl.signal.aborted) setState({ key, result: { ok: false, message: error instanceof Error ? error.message : String(error) } })
        })
    }, 400)
    return () => { ctl.abort(); window.clearTimeout(timer) }
  }, [key, active])

  if (!active) return null
  const current = state && state.key === key ? state.result : null
  return (
    <section className={`cfx ${className}`.trim()} aria-label="Why this audience" aria-busy={!current}>
      <header className="cfx__head">
        <span className="cfx__kicker">Why this audience</span>
        {current?.ok && (
          <span className="cfx__total">
            {current.final_count === null ? '—' : format(current.final_count)} properties
            {current.final_eligible !== null ? ` · ${format(current.final_eligible)} eligible` : ''}
          </span>
        )}
      </header>
      {current ? <FilterEffectsList result={current} format={format} /> : <p className="cfx__note">Counting each filter…</p>}
    </section>
  )
}
