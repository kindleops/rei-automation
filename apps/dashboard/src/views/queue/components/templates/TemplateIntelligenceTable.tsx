import type { ColumnPreset, TableDensity, TemplateIntelligenceRow } from '../../../../domain/templates/template-intelligence.types'
import {
  formatAttributionStatus,
  formatConfidence,
  formatDecisionReason,
  formatOptimizationState,
  formatRateDisplay,
} from '../../../../domain/templates/template-operator-labels'
import { COLUMN_PRESETS } from '../../../../lib/data/templateIntelligenceData'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const COL_LABELS: Record<string, string> = {
  queue_rows: 'Queue Rows',
  sent: 'Sent',
  delivered: 'Delivered',
  failed: 'Failed',
  blocked: 'Blocked',
  retries: 'Retries',
  senders_used: 'Senders Used',
  sender_concentration: 'Sender Concentration',
  cost: 'Estimated Cost',
  last_used: 'Last Used',
  variables: 'Variables',
  property_match: 'Property Match',
  language: 'Language',
  reply_tracking: 'Reply Tracking',
  message_errors: 'Message Errors',
  issues: 'Issues',
  recommended_fix: 'Recommended Fix',
  optimization_state: 'State',
  traffic_share: 'Current Share',
  recommended_share: 'Recommended Share',
  reason: 'Reason',
  next_review: 'Next Review',
  delivery_rate: 'Delivery Rate',
  reply_rate: 'Reply Rate',
  avg_reply_time: 'Avg Reply Time',
  positive_replies: 'Positive',
  positive_rate: 'Positive Rate',
  negative_replies: 'Negative',
  negative_rate: 'Negative Rate',
  ownership_confirmed: 'Ownership',
  stage_advanced: 'Stage Adv',
  opt_outs: 'Opt-Outs',
  opt_out_rate: 'Opt-Out Rate',
  wrong_numbers: 'Wrong #',
  confidence: 'Confidence',
  trend: 'Trend',
}

function cellValue(row: TemplateIntelligenceRow, col: string): { primary: string; secondary?: string } {
  const m = row.metrics.current as Record<string, number | null>
  const rates = row.metrics.comparison.rates as Record<string, { current?: { value?: number | null; numerator?: number | null; denominator?: number; unavailable?: boolean; unattributed?: boolean } }>
  const ap = row.autopilot as Record<string, unknown> | null
  const intel = ap?.intelligence as Record<string, unknown> | undefined
  const dq = row.data_quality as Record<string, unknown>
  const exec = row.execution as Record<string, unknown>
  const sample = Number(m.sends ?? 0)
  const funnel = (row as { funnel?: Array<{ key: string; value: number }> }).funnel

  switch (col) {
    case 'sends': return { primary: String(m.sends ?? 0) }
    case 'delivered': return { primary: String(m.delivered ?? 0) }
    case 'failed': return { primary: String(m.failed ?? 0) }
    case 'delivery':
    case 'delivery_rate': return formatRateDisplay(rates.delivery?.current, sample)
    case 'replies': return m.replies == null ? { primary: 'Unattributed' } : { primary: String(m.replies) }
    case 'reply_rate': return formatRateDisplay(rates.reply?.current, sample)
    case 'positive':
    case 'positive_replies': return m.positive_replies == null ? { primary: '—' } : { primary: String(m.positive_replies) }
    case 'positive_rate': return formatRateDisplay(rates.positive_reply?.current, Number(m.replies ?? 0))
    case 'negative_replies': return m.negative_replies == null ? { primary: '—' } : { primary: String(m.negative_replies ?? 0) }
    case 'negative_rate': return formatRateDisplay((rates as Record<string, { current?: { value?: number | null; numerator?: number | null; denominator?: number } }>).negative_reply?.current, Number(m.replies ?? 0))
    case 'stage_advancement':
    case 'stage_advanced': return m.stage_advanced == null ? { primary: '—' } : { primary: String(m.stage_advanced) }
    case 'stage_rate': return formatRateDisplay(rates.stage_advancement?.current, Number(m.replies ?? 0))
    case 'opt_out':
    case 'opt_outs': return m.opt_outs == null ? { primary: '—' } : { primary: String(m.opt_outs) }
    case 'opt_out_rate': return formatRateDisplay(rates.opt_out?.current, sample)
    case 'wrong_numbers': return m.wrong_numbers == null ? { primary: '—' } : { primary: String(m.wrong_numbers) }
    case 'avg_reply_time': {
      const hrs = m.average_response_time ?? m.median_response_time
      return hrs != null ? { primary: `${Number(hrs).toFixed(1)}h` } : { primary: '—' }
    }
    case 'confidence': return { primary: formatConfidence(row.metrics.confidence.current_range.bucket) }
    case 'trend': {
      const t = String(intel?.trend ?? '')
      if (t && t !== 'stable') return { primary: t }
      const delta = (rates.reply as { delta_absolute?: number })?.delta_absolute
      if (delta == null) return { primary: sample < 10 ? 'Not enough data' : 'Stable' }
      if (delta > 1) return { primary: 'Improving' }
      if (delta < -1) return { primary: 'Declining' }
      return { primary: 'Stable' }
    }
    case 'queue_rows':
    case 'selected': return { primary: String(exec.queue_rows ?? exec.selected ?? 0), secondary: 'All queue rows using template' }
    case 'queued': return { primary: String(exec.queued ?? 0) }
    case 'sent': return { primary: String(m.sends ?? 0) }
    case 'blocked': return { primary: String(exec.blocked ?? 0) }
    case 'retries': return { primary: String(exec.retries ?? m.retries ?? 0) }
    case 'senders_used':
    case 'sender_diversity': {
      const div = exec.sender_diversity as { distinct?: number; label?: string } | undefined
      return { primary: String(div?.distinct ?? 0) }
    }
    case 'sender_concentration': {
      const div = exec.sender_diversity as { concentration_pct?: number | null; label?: string } | undefined
      return div?.concentration_pct != null
        ? { primary: `${div.concentration_pct}%`, secondary: div.label }
        : { primary: '—' }
    }
    case 'cost': return exec.cost_available ? { primary: `$${Number(exec.cost ?? 0).toFixed(2)}` } : { primary: '—' }
    case 'last_used': return exec.last_used ? { primary: new Date(String(exec.last_used)).toLocaleString() } : { primary: '—' }
    case 'optimization_state':
    case 'state': return { primary: formatOptimizationState(String(ap?.rotation_state ?? '')) }
    case 'traffic_share':
    case 'weight': return { primary: ap?.traffic_weight != null ? `${Math.round(Number(ap.traffic_weight) * 100)}%` : '—' }
    case 'recommended_share':
    case 'proposed_weight': return { primary: ap?.proposed_weight != null ? `${Math.round(Number(ap.proposed_weight) * 100)}%` : '—' }
    case 'reason':
    case 'decision': return { primary: formatDecisionReason(String(ap?.decision_reason ?? '')) }
    case 'next_review':
    case 'reevaluation': return ap?.next_evaluation ? { primary: new Date(String(ap.next_evaluation)).toLocaleString() } : { primary: '—' }
    case 'variables':
    case 'variable_contract': return { primary: dq.variable_contract_valid ? 'OK' : 'Missing' }
    case 'property_match':
    case 'asset_scope': return { primary: dq.asset_scope_match ? 'Matched' : 'Not set' }
    case 'language':
    case 'language_quality': return { primary: String(dq.language_quality ?? '—') }
    case 'reply_tracking':
    case 'attribution': return { primary: formatAttributionStatus(String(dq.attribution_status ?? '')) }
    case 'message_errors':
    case 'render_failures': return { primary: String(dq.render_failures ?? 0) }
    case 'issues':
    case 'metadata_issues': return { primary: String((dq.metadata_issues as unknown[])?.length ?? 0) }
    case 'recommended_fix': return { primary: String(dq.recommended_fix ?? '—') }
    default: {
      const step = funnel?.find((s) => s.key === col)
      if (step) return { primary: String(step.value ?? 0) }
      return { primary: '—' }
    }
  }
}

interface TemplateIntelligenceTableProps {
  rows: TemplateIntelligenceRow[]
  preset: ColumnPreset
  density: TableDensity
  visibleColumns?: string[]
  loading?: boolean
  error?: string | null
  stale?: boolean
  selectedId: string | null
  sort: string
  sortDir: 'asc' | 'desc'
  onSelect: (templateId: string | null) => void
  onSort: (col: string) => void
  stageCode?: string | null
}

export function TemplateIntelligenceTable({
  rows,
  preset,
  density,
  visibleColumns,
  loading,
  error,
  stale,
  selectedId,
  sort,
  sortDir,
  onSelect,
  onSort,
  stageCode,
}: TemplateIntelligenceTableProps) {
  let columns = COLUMN_PRESETS[preset](stageCode ?? undefined)
  if (preset === 'performance' && visibleColumns?.length) {
    columns = ['identity', ...visibleColumns]
  }

  if (error) {
    return <div className="occ-module-empty occ-tpl-state is-error">{error}</div>
  }

  const colCount = Math.max(columns.length - 1, 1)
  const gridCols = `minmax(240px, 1.6fr) repeat(${colCount}, minmax(88px, 1fr))`

  return (
    <div className={cls('occ-tpl-table', stale && 'is-stale', loading && 'is-loading', density === 'compact' && 'is-compact')}>
      {loading && <span className="occ-tpl-table__loading">Loading…</span>}
      {stale && <span className="occ-tpl-table__stale">Stale data</span>}
      <div className="occ-tpl-table__head" style={{ gridTemplateColumns: gridCols }}>
        <div className="occ-tpl-table__cell occ-tpl-table__cell--frozen">
          <button type="button" className="occ-tpl-sort" onClick={() => onSort('template_name')}>
            Template {sort === 'template_name' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
          </button>
        </div>
        {columns.filter((c) => c !== 'identity').map((col) => (
          <div key={col} className="occ-tpl-table__cell">
            <button type="button" className="occ-tpl-sort" onClick={() => onSort(col)}>
              {(COL_LABELS[col] ?? col.replace(/_/g, ' '))} {sort === col ? (sortDir === 'asc' ? '↑' : '↓') : ''}
            </button>
          </div>
        ))}
      </div>
      {rows.length === 0 && !loading ? (
        <div className="occ-module-empty">No templates match current filters.</div>
      ) : (
        <div className="occ-tpl-table__body">
          {rows.map((row) => {
            const id = row.identity.template_id
            const selected = selectedId === id
            const previewLines = density === 'comfortable' ? 2 : 1
            const displayName = row.identity.template_name || row.identity.canonical_display_name
            return (
              <button
                key={id}
                type="button"
                style={{ gridTemplateColumns: gridCols }}
                className={cls('occ-tpl-vrow', selected && 'is-selected', density === 'compact' && 'is-compact', density === 'comfortable' && 'is-comfortable')}
                onClick={() => onSelect(id)}
              >
                <div className="occ-tpl-vrow__identity occ-tpl-vrow__cell--frozen">
                  <div className="occ-tpl-vrow__meta">
                    <span className="occ-tpl-vrow__stage">{row.identity.stage_code ?? '—'}</span>
                    {row.identity.use_case && <span className="occ-tag is-muted">{row.identity.use_case}</span>}
                    <span className="occ-tag">{row.identity.language}</span>
                  </div>
                  <strong className="occ-tpl-vrow__name" title={displayName}>{displayName}</strong>
                  <code className="occ-tpl-vrow__id occ-mono" title={id}>{id}</code>
                  <p className="occ-tpl-vrow__preview" title={row.identity.canonical_body} style={{ WebkitLineClamp: previewLines }}>
                    {row.identity.canonical_body || '—'}
                  </p>
                </div>
                {columns.filter((c) => c !== 'identity').map((col) => {
                  const val = cellValue(row, col)
                  return (
                    <div key={col} className="occ-tpl-vrow__cell" title={val.secondary ? `${val.primary} (${val.secondary})` : val.primary}>
                      <span className="occ-tpl-vrow__cell-primary">{val.primary}</span>
                      {val.secondary && <span className="occ-tpl-vrow__cell-secondary">{val.secondary}</span>}
                    </div>
                  )
                })}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}