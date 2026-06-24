interface InsightItem {
  template_id?: string
  display_name?: string | null
  metric?: string
  reason?: string
}

interface IntelligenceRailData {
  tracked_templates?: number
  templates_with_activity?: number
  insights?: InsightItem[]
  lacking_attribution?: number
}

const INSIGHT_LABELS: Record<string, string> = {
  best_reply_rate: 'Best reply rate',
  best_positive_rate: 'Best positive-response rate',
  best_stage_advancement: 'Best stage advancement',
  highest_opt_out_risk: 'Highest opt-out risk',
  largest_delivery_decline: 'Largest delivery decline',
  most_used_template: 'Most-used template',
  needs_data_review: 'Needs data review',
}

interface TemplateInsightStripProps {
  data: IntelligenceRailData | null
  loading?: boolean
  onSelectTemplate?: (templateId: string) => void
}

export function TemplateInsightStrip({ data, loading, onSelectTemplate }: TemplateInsightStripProps) {
  if (loading) return <div className="occ-tpl-insights is-loading">Loading insights…</div>
  if (!data?.insights?.length) return null

  return (
    <div className="occ-tpl-insights" role="region" aria-label="Template insights">
      <span className="occ-tpl-insights__label">
        {data.templates_with_activity ?? data.tracked_templates ?? 0} templates with activity
      </span>
      {data.insights.map((insight) => {
        const label = INSIGHT_LABELS[insight.metric ?? ''] ?? insight.metric
        const clickable = Boolean(insight.template_id && insight.display_name)
        return (
          <button
            key={insight.metric}
            type="button"
            className="occ-tpl-insight-chip"
            disabled={!clickable}
            title={insight.reason}
            onClick={() => insight.template_id && onSelectTemplate?.(insight.template_id)}
          >
            <span className="occ-tpl-insight-chip__label">{label}</span>
            <span className="occ-tpl-insight-chip__value">
              {insight.display_name ?? 'Not enough data'}
            </span>
          </button>
        )
      })}
    </div>
  )
}