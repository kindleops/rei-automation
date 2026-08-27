import { useMemo, useRef, useEffect } from 'react'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

export interface SpineStage {
  id: string
  label: string
  count: number
}

/**
 * The stage spine.
 *
 * S1 -> S10 is a genuine sequence, so the ordinal markers carry real
 * information here and are worth the space. What matters more is the shape of
 * the distribution: in live data 242 of 258 active leads sit in one stage. A row
 * of equal-width chips renders a stage holding 1 lead identically to the one
 * holding 242 and hides the only fact an operator needs at a glance.
 *
 * So each stage's bar is proportional to its share of the pipeline. The jam is
 * visible without reading a single number, and the numbers are still there for
 * anyone who wants them.
 */
export function PipelineMobileSpine({
  stages,
  activeId,
  onSelect,
}: {
  stages: SpineStage[]
  activeId: string
  onSelect: (id: string) => void
}) {
  const railRef = useRef<HTMLDivElement>(null)
  const total = useMemo(() => stages.reduce((sum, s) => sum + s.count, 0), [stages])
  const max = useMemo(() => Math.max(1, ...stages.map((s) => s.count)), [stages])

  // Keep the selected stage in view when it changes from outside the rail.
  useEffect(() => {
    const el = railRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    el?.scrollIntoView({ block: 'nearest', inline: 'center' })
  }, [activeId])

  return (
    <div className="plm-spine" ref={railRef} role="tablist" aria-label="Pipeline stages">
      {stages.map((stage, i) => {
        const share = total > 0 ? stage.count / total : 0
        // Square-root scale. Linear is mathematically honest but useless here:
        // with one stage at 242 and the rest at 1-6, every other bar collapses
        // to a hairline and the selected stage reads as empty. Sqrt keeps the
        // bottleneck clearly dominant while leaving small stages comparable, and
        // the exact count sits directly above every bar.
        const fill = max > 0 ? Math.sqrt(stage.count / max) : 0
        const selected = stage.id === activeId
        return (
          <button
            key={stage.id}
            type="button"
            role="tab"
            aria-selected={selected}
            className={cls('plm-stage', selected && 'is-active', stage.count === 0 && 'is-empty')}
            style={{ ['--plm-fill' as string]: `${Math.round(fill * 100)}%` }}
            onClick={() => onSelect(stage.id)}
            title={`${stage.label} — ${stage.count} (${Math.round(share * 100)}%)`}
          >
            <span className="plm-stage__head">
              <span className="plm-stage__ord">S{i + 1}</span>
              <span className="plm-stage__count">{stage.count}</span>
            </span>
            <span className="plm-stage__bar" aria-hidden="true" />
            <span className="plm-stage__label">{stage.label}</span>
          </button>
        )
      })}
    </div>
  )
}
