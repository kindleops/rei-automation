import { FLOW_EXCEPTIONS, FLOW_STAGES, type QueueKpiCounts } from '../queue-ui-helpers'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

interface QueueInlineFlowProps {
  kpi: QueueKpiCounts
  loading: boolean
  onFilter: (key: string) => void
}

export function QueueInlineFlow({ kpi, loading, onFilter }: QueueInlineFlowProps) {
  const getCount = (key: string) => (kpi as unknown as Record<string, number>)[key] ?? 0

  return (
    <div className="occ-inline-flow" aria-label="Queue flow">
      {FLOW_STAGES.map((stage, i) => (
        <span key={stage.key} className="occ-inline-flow__stage-wrap">
          {i > 0 && <span className="occ-inline-flow__arrow">→</span>}
          <button
            type="button"
            className={cls('occ-inline-flow__stage', stage.cumulative && 'is-cumulative')}
            onClick={() => onFilter(stage.key)}
            disabled={loading}
            title={stage.cumulative ? `${stage.label} (cumulative)` : stage.label}
          >
            <span className="occ-inline-flow__val">{loading ? '—' : getCount(stage.key)}</span>
            <span className="occ-inline-flow__lbl">{stage.label}</span>
          </button>
        </span>
      ))}
      <span className="occ-inline-flow__sep">|</span>
      {FLOW_EXCEPTIONS.map(ex => (
        <button
          key={ex.key}
          type="button"
          className={cls('occ-inline-flow__ex', `is-${ex.tone}`)}
          onClick={() => onFilter(ex.key === 'optOuts' ? 'failed' : ex.key)}
          disabled={loading}
        >
          {ex.label} {loading ? '—' : getCount(ex.key)}
        </button>
      ))}
    </div>
  )
}