import { useCallback, useRef, useState } from 'react'
import type { ColumnPreset, TableDensity, TemplateIntelligenceRow } from '../../../../domain/templates/template-intelligence.types'
import { COLUMN_PRESETS } from '../../../../lib/data/templateIntelligenceData'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const ROW_HEIGHT: Record<TableDensity, number> = { compact: 44, comfortable: 56 }
const OVERSCAN = 6

function truncate(s: string, max: number) {
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function cellValue(row: TemplateIntelligenceRow, col: string): string {
  const id = row.identity
  const m = row.metrics.current as Record<string, number>
  const rates = row.metrics.comparison.rates
  const ap = row.autopilot as Record<string, unknown> | null
  const intel = ap?.intelligence as Record<string, unknown> | undefined
  const dq = row.data_quality as Record<string, unknown>

  switch (col) {
    case 'identity': return id.canonical_display_name
    case 'rotation_state': return String(ap?.rotation_state ?? '—')
    case 'sends': return String(m.sends ?? 0)
    case 'delivery': {
      const r = rates.delivery?.current as { value?: number; numerator?: number; denominator?: number } | undefined
      return r?.value != null ? `${r.value}% (${r.numerator}/${r.denominator})` : '—'
    }
    case 'replies': return String(m.replies ?? 0)
    case 'positive': return String(m.positive_replies ?? 0)
    case 'stage_advancement': return String(m.selling_interest ?? 0)
    case 'opt_out': {
      const r = rates.opt_out?.current as { value?: number } | undefined
      return r?.value != null ? `${r.value}%` : '—'
    }
    case 'confidence': return String(row.metrics.confidence.current_range.bucket)
    case 'trend': return String(intel?.trend ?? '—')
    case 'sent': return String(m.sends ?? 0)
    case 'delivered': return String(m.delivered ?? 0)
    case 'failed': return String(m.failed ?? 0)
    case 'state': return String(ap?.rotation_state ?? '—')
    case 'weight': return String(ap?.traffic_weight ?? '—')
    case 'daily_cap': return String(ap?.daily_cap ?? '—')
    case 'proposed_weight': return String(ap?.proposed_weight ?? '—')
    case 'proposed_state': return String(ap?.proposed_state ?? '—')
    case 'decision': return truncate(String(ap?.decision_reason ?? '—'), 32)
    case 'reevaluation': return ap?.next_evaluation ? new Date(String(ap.next_evaluation)).toLocaleString() : '—'
    case 'variable_contract': return (id.variable_contract?.length ?? 0) > 0 ? 'ok' : 'missing'
    case 'asset_scope': return dq.asset_scope_match === false ? 'mismatch' : 'ok'
    case 'attribution': return String(dq.attribution_status ?? '—')
    case 'render_failures': return String(dq.render_failures ?? 0)
    default: return '—'
  }
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
  height?: number
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
  height = 480,
}: TemplateIntelligenceTableProps) {
  const columns = COLUMN_PRESETS[preset]
  const rowHeight = ROW_HEIGHT[density]
  const bodyRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)

  const onScroll = useCallback(() => {
    if (bodyRef.current) setScrollTop(bodyRef.current.scrollTop)
  }, [])

  const totalHeight = rows.length * rowHeight
  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN)
  const visibleCount = Math.ceil(height / rowHeight) + OVERSCAN * 2
  const endIndex = Math.min(rows.length, startIndex + visibleCount)
  const offsetY = startIndex * rowHeight
  const visibleRows = rows.slice(startIndex, endIndex)

  if (error) {
    return <div className="occ-module-empty occ-tpl-state is-error">{error}</div>
  }

  return (
    <div className={cls('occ-tpl-table', stale && 'is-stale', loading && 'is-loading')}>
      <div
        className="occ-tpl-table__head"
        style={{ gridTemplateColumns: `minmax(240px, 1.4fr) repeat(${Math.max(columns.length - 1, 1)}, minmax(88px, 1fr))` }}
      >
        <div className="occ-tpl-table__cell occ-tpl-table__cell--frozen">
          <button type="button" className="occ-tpl-sort" onClick={() => onSort('template_name')}>
            Template {sort === 'template_name' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
          </button>
        </div>
        {columns.filter((c) => c !== 'identity').map((col) => (
          <div key={col} className="occ-tpl-table__cell">
            <button type="button" className="occ-tpl-sort" onClick={() => onSort(col)}>
              {col.replace(/_/g, ' ')} {sort === col ? (sortDir === 'asc' ? '↑' : '↓') : ''}
            </button>
          </div>
        ))}
      </div>
      {rows.length === 0 && !loading ? (
        <div className="occ-module-empty">No templates match current filters.</div>
      ) : (
        <div
          ref={bodyRef}
          className="occ-tpl-table__body occ-tpl-table__body--virtual"
          style={{ height, overflow: 'auto' }}
          onScroll={onScroll}
        >
          <div style={{ height: totalHeight, position: 'relative' }}>
            <div style={{ transform: `translateY(${offsetY}px)` }}>
              {visibleRows.map((row) => {
                const id = row.identity.template_id
                const selected = selectedId === id
                return (
                  <button
                    key={id}
                    type="button"
                    style={{ height: rowHeight, display: 'grid', gridTemplateColumns: `minmax(240px, 1.4fr) repeat(${Math.max(columns.length - 1, 1)}, minmax(88px, 1fr))`, width: '100%' }}
                    className={cls('occ-tpl-vrow', selected && 'is-selected', density === 'compact' && 'is-compact')}
                    onClick={() => onSelect(selected ? null : id)}
                  >
                    <div className="occ-tpl-vrow__identity occ-tpl-vrow__cell--frozen">
                      <strong>{row.identity.canonical_display_name}</strong>
                      <small className="occ-mono">{row.identity.template_id}</small>
                      <p className="occ-tpl-vrow__preview">{truncate(row.identity.canonical_body, 72)}</p>
                      <div className="occ-tpl-vrow__badges">
                        {row.identity.asset_scope && <span className="occ-tag is-muted">{row.identity.asset_scope}</span>}
                        {row.identity.persona && <span className="occ-tag">{row.identity.persona}</span>}
                      </div>
                    </div>
                    {columns.filter((c) => c !== 'identity').map((col) => (
                      <div key={col} className="occ-tpl-vrow__cell">{cellValue(row, col)}</div>
                    ))}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )}
      {loading && <div className="occ-tpl-table__loading">Loading template catalog…</div>}
      {stale && <div className="occ-tpl-table__stale">Data may be stale — refresh to reconcile.</div>}
    </div>
  )
}