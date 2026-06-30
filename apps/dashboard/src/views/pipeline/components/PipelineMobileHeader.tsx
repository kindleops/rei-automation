import type { PipelineMetrics } from '../../../domain/pipeline/pipeline-opportunity.types'
import { PIPELINE_SCOPE_OPTIONS, type PipelineScope } from '../../../domain/pipeline/pipeline-display-helpers'
import { Icon } from '../../../shared/icons'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

interface PipelineMobileHeaderProps {
  scope: PipelineScope
  onScopeChange?: (scope: PipelineScope) => void
  metrics: PipelineMetrics | Record<string, number>
  scopedTotal: number
  globalTotal: number
  refreshing?: boolean
}

export function PipelineMobileHeader({
  scope,
  onScopeChange,
  metrics,
  scopedTotal,
  globalTotal,
  refreshing,
}: PipelineMobileHeaderProps) {
  const m = metrics as PipelineMetrics
  const kpis = [
    { label: 'Active', value: m.active_opportunities ?? 0, tone: 'blue' },
    { label: 'Replies', value: m.new_replies ?? 0, tone: 'cyan' },
    { label: 'Due', value: m.follow_ups_due ?? 0, tone: 'amber' },
    { label: 'Offer', value: m.offer_ready ?? 0, tone: 'green' },
  ]

  return (
    <header className="plv-mobile-hero">
      <div className="plv-mobile-hero__top">
        <div className="plv-mobile-hero__title">
          <Icon name="radar" size={16} />
          <div>
            <strong>Pipeline</strong>
            <span>{scopedTotal} in view · {globalTotal} total</span>
          </div>
        </div>
        {refreshing && (
          <span className="plv-mobile-hero__sync" aria-live="polite">
            <span className="plv-mobile-hero__sync-dot" />
            Syncing
          </span>
        )}
      </div>

      <div className="plv-mobile-kpi-grid" role="group" aria-label="Pipeline metrics">
        {kpis.map((item) => (
          <div key={item.label} className="plv-mobile-kpi">
            <em>{item.label}</em>
            <strong className={cls(`is-${item.tone}`)}>{item.value}</strong>
          </div>
        ))}
      </div>

      {onScopeChange && (
        <div className="plv-mobile-scope" role="tablist" aria-label="Pipeline scope">
          {PIPELINE_SCOPE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="tab"
              aria-selected={scope === opt.value}
              className={cls('plv-mobile-scope__pill', scope === opt.value && 'is-active')}
              onClick={() => onScopeChange(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </header>
  )
}