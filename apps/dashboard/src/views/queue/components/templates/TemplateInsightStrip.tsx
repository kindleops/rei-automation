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
  isMobileLayout?: boolean
  onSelectTemplate?: (templateId: string) => void
}

export function TemplateInsightStrip({ data, loading, isMobileLayout = false, onSelectTemplate }: TemplateInsightStripProps) {
  if (loading) return <div className={cls('occ-tpl-insights', isMobileLayout && 'occ-tpl-insights--mobile', 'is-loading')}>Loading…</div>
  if (!data?.insights?.length) return null

  return (
    <div className={cls('occ-tpl-insights', isMobileLayout && 'occ-tpl-insights--mobile')} role="region" aria-label="Template insights">
      {!isMobileLayout && (
        <span className="occ-tpl-insights__label">
          {data.templates_with_activity ?? data.tracked_templates ?? 0} templates with activity
        </span>
      )}
      <div className="occ-tpl-insights__track">
        {data.insights.map((insight) => {
          const label = INSIGHT_LABELS[insight.metric ?? ''] ?? insight.metric
          const clickable = Boolean(insight.template_id && insight.display_name)
          const shortName = insight.display_name
            ? (insight.display_name.length > 28 ? `${insight.display_name.slice(0, 28)}…` : insight.display_name)
            : 'Not enough data'
          return (
            <button
              key={insight.metric}
              type="button"
              className={cls('occ-tpl-insight-chip', isMobileLayout && 'occ-tpl-insight-chip--mobile')}
              disabled={!clickable}
              title={insight.reason ?? insight.display_name ?? undefined}
              onClick={() => insight.template_id && onSelectTemplate?.(insight.template_id)}
            >
              <span className="occ-tpl-insight-chip__label">{isMobileLayout ? label.replace(' rate', '').replace('response', 'resp.') : label}</span>
              <span className="occ-tpl-insight-chip__value">{shortName}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function cls(...t: Array<string | false | null | undefined>) {
  return t.filter(Boolean).join(' ')
}