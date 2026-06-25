import type { ClosingDeskSummary, ClosingDataSource } from '../../../domain/closing-desk/closing-desk.types'

const money = (v: number) => `$${Math.round(v).toLocaleString()}`

interface MetricDef {
  key: keyof ClosingDeskSummary
  label: string
  shortLabel?: string
  tone?: 'alert' | 'good' | 'revenue'
  format?: 'money'
  primary?: boolean
}

const METRICS: MetricDef[] = [
  { key: 'underContract', label: 'Under Contract', primary: true },
  { key: 'closingsThisWeek', label: 'Closing This Week', shortLabel: 'This Week', primary: true },
  { key: 'clearToClose', label: 'Clear to Close', tone: 'good', primary: true },
  { key: 'titleBlocked', label: 'Title Blocked', tone: 'alert', primary: true },
  { key: 'expectedRevenue', label: 'Expected Revenue', format: 'money', tone: 'revenue', primary: true },
  { key: 'sellerActionRequired', label: 'Seller Action Required', shortLabel: 'Seller Action', tone: 'alert' },
  { key: 'buyerActionRequired', label: 'Buyer Action Required', shortLabel: 'Buyer Action', tone: 'alert' },
  { key: 'emdOverdue', label: 'EMD Overdue', tone: 'alert' },
  { key: 'confirmedRevenueThisMonth', label: 'Confirmed Revenue MTD', shortLabel: 'Confirmed (MTD)', format: 'money', tone: 'good' },
]

function formatMetricValue(raw: number, format?: 'money'): string {
  if (format === 'money') return money(raw)
  return String(raw)
}

function sourceLabel(source: ClosingDataSource | undefined): string {
  if (!source || source === 'absent') return 'Not projected'
  if (source === 'derived') return 'Derived'
  if (source === 'fixture') return 'Fixture'
  return source.replace(/_/g, ' ')
}

function MetricCard({
  def,
  raw,
  source,
  loading,
  compact,
}: {
  def: MetricDef
  raw: number
  source: ClosingDataSource | undefined
  loading: boolean
  compact?: boolean
}) {
  const unknown = source === 'absent'
  const value = loading ? '…' : unknown ? '—' : formatMetricValue(raw, def.format)
  const alertActive = def.tone === 'alert' && !unknown && raw > 0

  return (
    <div
      className={`cd-metric ${compact ? 'cd-metric--compact' : 'cd-metric--primary'} ${alertActive ? 'is-alert' : ''} ${def.tone === 'good' && !unknown ? 'is-good' : ''} ${def.tone === 'revenue' ? 'is-revenue' : ''} ${unknown ? 'is-unknown' : ''}`}
      data-testid={`cd-metric-${def.key}`}
    >
      <span className="cd-metric__value">{value}</span>
      <span className="cd-metric__label">{compact ? (def.shortLabel ?? def.label) : def.label}</span>
      <span className="cd-metric__source" title={`Source: ${sourceLabel(source)}`}>
        {sourceLabel(source)}
      </span>
    </div>
  )
}

export interface ClosingDeskMetricsProps {
  summary: ClosingDeskSummary | null
  loading: boolean
}

export function ClosingDeskMetrics({ summary, loading }: ClosingDeskMetricsProps) {
  const primary = METRICS.filter((m) => m.primary)
  const secondary = METRICS.filter((m) => !m.primary)

  return (
    <div className="cd-metrics-stack" data-testid="cd-metrics">
      <div className="cd-metrics cd-metrics--primary" aria-label="Primary closing metrics">
        {primary.map((m) => (
          <MetricCard
            key={m.key}
            def={m}
            raw={summary ? (summary[m.key] as number) : 0}
            source={summary?.metricSources?.[m.key]}
            loading={loading}
          />
        ))}
      </div>
      <div className="cd-metrics cd-metrics--secondary" aria-label="Operational signals">
        {secondary.map((m) => (
          <MetricCard
            key={m.key}
            def={m}
            raw={summary ? (summary[m.key] as number) : 0}
            source={summary?.metricSources?.[m.key]}
            loading={loading}
            compact
          />
        ))}
      </div>
    </div>
  )
}