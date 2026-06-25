import type { ClosingDeskSummary, ClosingDataSource } from '../../../domain/closing-desk/closing-desk.types'
import type { ClosingDeskFilters } from '../hooks/useClosingDesk'

const money = (v: number) => `$${Math.round(v).toLocaleString()}`

type MetricKey = keyof ClosingDeskSummary

interface PrimaryDef {
  key: MetricKey
  label: string
  context?: string
  tone?: 'healthy' | 'warning' | 'critical' | 'revenue' | 'unknown'
  format?: 'money'
  filterKey?: keyof ClosingDeskFilters
  filterValue?: string
}

const PRIMARY: PrimaryDef[] = [
  { key: 'underContract', label: 'Active Under Contract', context: 'Stages 6–7', tone: 'healthy' },
  { key: 'closingsThisWeek', label: 'Closings This Week', context: 'Next 7 days', tone: 'healthy' },
  { key: 'clearToClose', label: 'Clear to Close', context: 'Readiness gate', tone: 'healthy' },
  { key: 'titleBlocked', label: 'At-Risk / Title Blocked', context: 'Title + curative', tone: 'warning', filterKey: 'risk', filterValue: 'high' },
  { key: 'expectedRevenue', label: 'Expected Revenue', context: 'Assignment spread', tone: 'revenue', format: 'money' },
]

const SECONDARY: PrimaryDef[] = [
  { key: 'sellerActionRequired', label: 'Seller Action', tone: 'warning' },
  { key: 'buyerActionRequired', label: 'Buyer Action', tone: 'warning' },
  { key: 'emdOverdue', label: 'EMD Overdue', tone: 'critical' },
  { key: 'confirmedRevenueThisMonth', label: 'Confirmed MTD', tone: 'healthy', format: 'money' },
]

function sourceLabel(source: ClosingDataSource | undefined): string {
  if (!source || source === 'absent') return 'Not projected'
  if (source === 'derived') return 'Derived'
  if (source === 'fixture') return 'Fixture'
  return source.replace(/_/g, ' ')
}

function toneClass(raw: number, tone?: PrimaryDef['tone'], unknown?: boolean): string {
  if (unknown) return 'is-unknown'
  if (tone === 'warning' && raw > 0) return 'is-warning'
  if (tone === 'critical' && raw > 0) return 'is-critical'
  if (tone === 'healthy' && raw > 0) return 'is-healthy'
  if (tone === 'revenue') return 'is-revenue'
  return ''
}

export interface ClosingDeskMetricsProps {
  summary: ClosingDeskSummary | null
  loading: boolean
  onFilter?: (patch: Partial<ClosingDeskFilters>) => void
}

export function ClosingDeskMetrics({ summary, loading, onFilter }: ClosingDeskMetricsProps) {
  const renderPrimary = (def: PrimaryDef) => {
    const raw = summary ? (summary[def.key] as number) : 0
    const source = summary?.metricSources?.[def.key]
    const unknown = source === 'absent'
    const value = loading ? '…' : unknown ? '—' : def.format === 'money' ? money(raw) : String(raw)
    const clickable = def.filterKey && onFilter && raw > 0

    return (
      <div
        key={def.key}
        className={`cd-kpi cd-kpi--primary ${toneClass(raw, def.tone, unknown)}`}
        data-testid={`cd-metric-${def.key}`}
        role={clickable ? 'button' : undefined}
        tabIndex={clickable ? 0 : undefined}
        onClick={clickable ? () => onFilter({ [def.filterKey!]: def.filterValue ?? 'all' }) : undefined}
        onKeyDown={clickable ? (e) => { if (e.key === 'Enter') onFilter({ [def.filterKey!]: def.filterValue ?? 'all' }) } : undefined}
      >
        <span className="cd-kpi__value">{value}</span>
        <span className="cd-kpi__label">{def.label}</span>
        {def.context ? <span className="cd-kpi__context">{def.context}</span> : null}
        <span className="cd-kpi__provenance">{sourceLabel(source)}</span>
      </div>
    )
  }

  const renderSignal = (def: PrimaryDef) => {
    const raw = summary ? (summary[def.key] as number) : 0
    const source = summary?.metricSources?.[def.key]
    const unknown = source === 'absent'
    const value = loading ? '…' : unknown ? '—' : def.format === 'money' ? money(raw) : String(raw)

    return (
      <div key={def.key} className={`cd-signal ${toneClass(raw, def.tone, unknown)}`} data-testid={`cd-metric-${def.key}`}>
        <span className="cd-signal__value">{value}</span>
        <span className="cd-signal__label">{def.label}</span>
      </div>
    )
  }

  return (
    <section className="cd-metrics-command" data-testid="cd-metrics" aria-label="Portfolio metrics">
      <div className="cd-kpi-row">{PRIMARY.map(renderPrimary)}</div>
      <div className="cd-signal-row">{SECONDARY.map(renderSignal)}</div>
    </section>
  )
}