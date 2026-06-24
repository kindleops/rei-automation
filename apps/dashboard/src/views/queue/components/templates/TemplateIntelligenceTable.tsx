import type { ColumnPreset, TableDensity, TemplateIntelligenceRow } from '../../../../domain/templates/template-intelligence.types'
import { COLUMN_PRESETS } from '../../../../lib/data/templateIntelligenceData'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

function formatRate(rate: { value?: number | null; numerator?: number; denominator?: number } | undefined, sample?: number) {
  if (!rate || rate.denominator === 0) return '—'
  if (rate.value == null) return sample != null && sample < 10 ? 'Insufficient data' : '—'
  const num = rate.numerator ?? 0
  const den = rate.denominator ?? 0
  return `${rate.value}% (${num}/${den})`
}

function cellValue(row: TemplateIntelligenceRow, col: string): string {
  const m = row.metrics.current as Record<string, number>
  const rates = row.metrics.comparison.rates as Record<string, { current?: { value?: number | null; numerator?: number; denominator?: number } }>
  const ap = row.autopilot as Record<string, unknown> | null
  const intel = ap?.intelligence as Record<string, unknown> | undefined
  const dq = row.data_quality as Record<string, unknown>
  const exec = row.execution as Record<string, unknown>
  const sample = Number(m.sends ?? 0)
  const funnel = (row as { funnel?: Array<{ key: string; value: number }> }).funnel

  switch (col) {
    case 'rotation_state': return String(ap?.rotation_state ?? '—')
    case 'sends': return String(m.sends ?? 0)
    case 'delivery': return formatRate(rates.delivery?.current, sample)
    case 'replies': return String(m.replies ?? 0)
    case 'reply_rate': return formatRate(rates.reply?.current, sample)
    case 'positive': return String(m.positive_replies ?? 0)
    case 'positive_rate': return formatRate(rates.positive_reply?.current, Number(m.replies ?? 0))
    case 'stage_advancement': return String(m.stage_advanced ?? 0)
    case 'stage_rate': return formatRate(rates.stage_advancement?.current, Number(m.replies ?? 0))
    case 'opt_out': return formatRate(rates.opt_out?.current, sample)
    case 'confidence': {
      const bucket = row.metrics.confidence.current_range.bucket
      return bucket === 'insufficient_data' ? 'Insufficient data' : bucket.replace(/_/g, ' ')
    }
    case 'trend': {
      const t = String(intel?.trend ?? '')
      if (t && t !== 'stable') return t
      const delta = row.metrics.comparison.rates?.reply?.current
        ? (rates.reply as { delta_absolute?: number })?.delta_absolute
        : null
      if (delta == null) return sample < 10 ? 'Insufficient data' : 'Stable'
      if (delta > 1) return 'Improving'
      if (delta < -1) return 'Declining'
      return 'Stable'
    }
    case 'selected': return String(exec.selected ?? 0)
    case 'queued': return String(exec.queued ?? 0)
    case 'sent': return String(m.sends ?? 0)
    case 'delivered': return String(m.delivered ?? 0)
    case 'failed': return String(m.failed ?? 0)
    case 'blocked': return String(exec.blocked ?? 0)
    case 'retries': return String(exec.retries ?? m.retries ?? 0)
    case 'sender_diversity': return String(exec.sender_mix ?? (exec.sender_diversity as { label?: string })?.label ?? '—')
    case 'cost': return exec.cost_available ? `$${Number(exec.cost ?? 0).toFixed(2)}` : '—'
    case 'last_used': return exec.last_used ? new Date(String(exec.last_used)).toLocaleString() : '—'
    case 'state': return String(ap?.rotation_state ?? '—')
    case 'weight': return String(ap?.traffic_weight ?? '—')
    case 'daily_cap': return String(ap?.daily_cap ?? '—')
    case 'proposed_weight': return String(ap?.proposed_weight ?? '—')
    case 'proposed_state': return String(ap?.proposed_state ?? '—')
    case 'decision': return String(ap?.decision_reason ?? '—').replace(/_/g, ' ')
    case 'reevaluation': return ap?.next_evaluation ? new Date(String(ap.next_evaluation)).toLocaleString() : '—'
    case 'variable_contract': return String(dq.variable_contract_detail ?? (dq.variable_contract_valid ? 'ok' : 'missing'))
    case 'asset_scope': return String(dq.asset_scope_detail ?? 'ok')
    case 'language_quality': return String(dq.language_quality ?? '—')
    case 'attribution': return String(dq.attribution_status ?? '—').replace(/_/g, ' ')
    case 'render_failures': return String(dq.render_failures ?? 0)
    case 'metadata_issues': return String((dq.metadata_issues as unknown[])?.length ?? 0)
    case 'recommended_fix': return String(dq.recommended_fix ?? '—')
    default: {
      const step = funnel?.find((s) => s.key === col)
      if (step) return String(step.value ?? 0)
      return '—'
    }
  }
}

const COLUMN_LABELS: Record<string, string> = {
  identity: 'Template',
  rotation_state: 'Rotation',
  reply_rate: 'Reply Rate',
  positive_rate: 'Positive Rate',
  stage_advancement: 'Stage Adv',
  stage_rate: 'Advance Rate',
  sender_diversity: 'Sender Diversity',
  last_used: 'Last Used',
  variable_contract: 'Variable Contract',
  asset_scope: 'Asset Scope',
  language_quality: 'Language',
  render_failures: 'Render Failures',
  metadata_issues: 'Issues',
  recommended_fix: 'Recommended Fix',
  proposed_weight: 'Proposed Wt',
  proposed_state: 'Proposed State',
  reevaluation: 'Next Review',
}

interface TemplateIntelligenceTableProps {
  rows: TemplateIntelligenceRow[]
  preset: ColumnPreset
  density: TableDensity
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
  const columns = COLUMN_PRESETS[preset](stageCode ?? undefined)

  if (error) {
    return <div className="occ-module-empty occ-tpl-state is-error">{error}</div>
  }

  const colCount = Math.max(columns.length - 1, 1)
  const gridCols = `minmax(260px, 1.5fr) repeat(${colCount}, minmax(92px, 1fr))`

  return (
    <div className={cls('occ-tpl-table', stale && 'is-stale', loading && 'is-loading', density === 'compact' && 'is-compact')}>
      <div className="occ-tpl-table__head" style={{ gridTemplateColumns: gridCols }}>
        <div className="occ-tpl-table__cell occ-tpl-table__cell--frozen">
          <button type="button" className="occ-tpl-sort" onClick={() => onSort('template_name')}>
            Template {sort === 'template_name' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
          </button>
        </div>
        {columns.filter((c) => c !== 'identity').map((col) => (
          <div key={col} className="occ-tpl-table__cell">
            <button type="button" className="occ-tpl-sort" onClick={() => onSort(col)}>
              {(COLUMN_LABELS[col] ?? col.replace(/_/g, ' '))} {sort === col ? (sortDir === 'asc' ? '↑' : '↓') : ''}
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
            return (
              <button
                key={id}
                type="button"
                style={{ gridTemplateColumns: gridCols }}
                className={cls('occ-tpl-vrow', selected && 'is-selected', density === 'compact' && 'is-compact', density === 'comfortable' && 'is-comfortable')}
                onClick={() => onSelect(selected ? null : id)}
              >
                <div className="occ-tpl-vrow__identity occ-tpl-vrow__cell--frozen">
                  <div className="occ-tpl-vrow__meta">
                    <span className="occ-tpl-vrow__stage">{row.identity.stage_code ?? '—'}</span>
                    {row.identity.use_case && <span className="occ-tag is-muted">{row.identity.use_case}</span>}
                    <span className="occ-tag">{row.identity.language}</span>
                    {(row.autopilot as { rotation_state?: string } | null)?.rotation_state && (
                      <span className="occ-tag is-accent">{(row.autopilot as { rotation_state: string }).rotation_state}</span>
                    )}
                  </div>
                  {row.identity.template_name && row.identity.template_name !== row.identity.canonical_display_name && (
                    <strong className="occ-tpl-vrow__name" title={row.identity.template_name}>{row.identity.template_name}</strong>
                  )}
                  <code className="occ-tpl-vrow__id occ-mono" title={id}>{id}</code>
                  <p
                    className="occ-tpl-vrow__preview"
                    title={row.identity.canonical_body}
                    style={{ WebkitLineClamp: previewLines }}
                  >
                    {row.identity.canonical_body || '—'}
                  </p>
                </div>
                {columns.filter((c) => c !== 'identity').map((col) => (
                  <div key={col} className="occ-tpl-vrow__cell" title={cellValue(row, col)}>{cellValue(row, col)}</div>
                ))}
              </button>
            )
          })}
        </div>
      )}
      {loading && <div className="occ-tpl-table__loading">Loading template catalog…</div>}
      {stale && <div className="occ-tpl-table__stale">Data may be stale — refresh to reconcile.</div>}
    </div>
  )
}