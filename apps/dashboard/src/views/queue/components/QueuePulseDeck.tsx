import { Icon } from '../../../shared/icons'
import {
  FLOW_EXCEPTIONS,
  FLOW_STAGES,
  KPI_TOOLTIPS,
  buildOperationsPulse,
  pct,
  type OperationsPulseData,
  type QueueKpiCounts,
} from '../queue-ui-helpers'
import type { QueueItem } from '../../../domain/queue/queue.types'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

interface QueuePulseDeckProps {
  kpi: QueueKpiCounts
  loading: boolean
  isRange: boolean
  rangeLabel: string
  statusFilter: string
  items: QueueItem[]
  model: { sentTodayCount?: number; safeCapacityRemaining?: number } | null
  layoutMode: string
  onFilter: (key: string) => void
}

function PulseKpi({
  label, value, tone, pctOfTotal, active, loading, pulse, onClick,
}: {
  label: string
  value: number
  tone?: string
  pctOfTotal?: number
  active?: boolean
  loading?: boolean
  pulse?: boolean
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      className={cls('occ-pulse-kpi', tone && `is-${tone}`, active && 'is-active', pulse && 'is-pulsing', loading && 'is-loading', onClick && 'is-clickable')}
      onClick={onClick}
      disabled={!onClick || loading}
      title={KPI_TOOLTIPS[label] ?? label}
    >
      <span className="occ-pulse-kpi__glow" aria-hidden="true" />
      <span className={cls('occ-pulse-kpi__value', loading && 'is-pending')}>{loading ? '—' : value.toLocaleString()}</span>
      <span className="occ-pulse-kpi__label">{label}</span>
      {pctOfTotal != null && !loading && <span className="occ-pulse-kpi__pct">{pctOfTotal}%</span>}
    </button>
  )
}

function OperationsPulse({ data, compact }: { data: OperationsPulseData; compact?: boolean }) {
  const stateTone: Record<string, string> = {
    running: 'cyan', idle: 'muted', paused: 'amber', degraded: 'amber', blocked: 'red', unknown: 'muted',
  }
  return (
    <div className={cls('occ-ops-pulse', compact && 'is-compact')}>
      <div className="occ-ops-pulse__head">
        <span className={cls('occ-ops-pulse__state', `is-${stateTone[data.processorState]}`)}>
          <span className="occ-ops-pulse__dot" />
          {data.processorLabel}
        </span>
        <span className="occ-ops-pulse__title">Operations Pulse</span>
      </div>
      <div className="occ-ops-pulse__grid">
        <div className="occ-ops-stat"><span className="occ-ops-stat__val">{data.jobsLastHour}</span><span className="occ-ops-stat__lbl">Processed / hr</span></div>
        <div className="occ-ops-stat"><span className="occ-ops-stat__val">{data.activeSenders}</span><span className="occ-ops-stat__lbl">Active senders</span></div>
        <div className="occ-ops-stat"><span className="occ-ops-stat__val">{data.pendingRetries}</span><span className="occ-ops-stat__lbl">Pending retry</span></div>
        <div className="occ-ops-stat"><span className="occ-ops-stat__val">{data.approvalRequired}</span><span className="occ-ops-stat__lbl">Approval</span></div>
        <div className="occ-ops-stat"><span className="occ-ops-stat__val">{data.blockedRows}</span><span className="occ-ops-stat__lbl">Blocked</span></div>
        {!compact && data.throughputLabel && (
          <div className="occ-ops-stat is-wide"><span className="occ-ops-stat__val">{data.throughputLabel}</span><span className="occ-ops-stat__lbl">Throughput</span></div>
        )}
      </div>
      <div className="occ-ops-pulse__footer">
        {data.nextScheduled && <span>Next: {new Date(data.nextScheduled).toLocaleString()}</span>}
        {data.latestReceiptAge && <span>Last receipt: {data.latestReceiptAge}</span>}
        {data.capacityLabel && <span>{data.capacityLabel}</span>}
      </div>
    </div>
  )
}

function QueueFlow({ kpi, loading, onFilter }: { kpi: QueueKpiCounts; loading: boolean; onFilter: (k: string) => void }) {
  const getCount = (key: string) => (kpi as unknown as Record<string, number>)[key] ?? 0
  return (
    <div className="occ-queue-flow">
      <div className="occ-queue-flow__label">
        <Icon name="activity" size={11} />
        Queue Flow
        <span className="occ-queue-flow__hint">current-state → cumulative dispatch</span>
      </div>
      <div className="occ-queue-flow__track">
        {FLOW_STAGES.map((stage, i) => {
          const count = getCount(stage.key)
          const active = stage.key === 'sending' && count > 0
          return (
            <div key={stage.key} className="occ-queue-flow__segment-wrap">
              {i > 0 && <span className="occ-queue-flow__arrow">→</span>}
              <button
                type="button"
                className={cls('occ-queue-flow__segment', active && 'is-active', stage.cumulative && 'is-cumulative')}
                onClick={() => onFilter(stage.key)}
                disabled={loading}
                title={stage.cumulative ? `${stage.label}: cumulative dispatch metric` : `${stage.label}: current pipeline state`}
              >
                <span className="occ-queue-flow__seg-val">{loading ? '—' : count}</span>
                <span className="occ-queue-flow__seg-lbl">{stage.label}</span>
              </button>
            </div>
          )
        })}
      </div>
      <div className="occ-queue-flow__exceptions">
        {FLOW_EXCEPTIONS.map(ex => (
          <button
            key={ex.key}
            type="button"
            className={cls('occ-queue-flow__ex', `is-${ex.tone}`)}
            onClick={() => onFilter(ex.key === 'optOuts' ? 'failed' : ex.key)}
            disabled={loading}
          >
            {ex.label} · {loading ? '—' : getCount(ex.key)}
          </button>
        ))}
      </div>
    </div>
  )
}

export function QueuePulseDeck({
  kpi, loading, isRange, rangeLabel, statusFilter, items, model, layoutMode, onFilter,
}: QueuePulseDeckProps) {
  const ops = buildOperationsPulse(items, kpi, model)
  const total = kpi.total || 1
  const compact = layoutMode === 'compact' || layoutMode === 'medium'

  const kpis: Array<{ key: string; label: string; tone?: string; pulse?: boolean }> = [
    { key: 'scheduled', label: 'Scheduled', tone: 'blue' },
    { key: 'queued', label: 'Queued', tone: 'blue' },
    { key: 'sending', label: 'Sending', tone: 'cyan', pulse: true },
    { key: 'delivered', label: 'Delivered', tone: 'green' },
    { key: 'sent', label: 'Sent', tone: 'green' },
    { key: 'failed', label: 'Failed', tone: 'red' },
    { key: 'blocked', label: 'Blocked', tone: 'amber' },
    { key: 'optOuts', label: 'Opt-Outs', tone: 'red' },
    { key: 'approval', label: 'Approval', tone: 'amber' },
  ]

  return (
    <section className={cls('occ-pulse-deck', compact && 'is-compact')}>
      <div className="occ-pulse-deck__atmo" aria-hidden="true" />
      <div className="occ-pulse-deck__kpis">
        {kpis.map(k => {
          const val = (kpi as unknown as Record<string, number>)[k.key] ?? 0
          const filterKey = k.key === 'optOuts' ? 'failed' : k.key
          return (
            <PulseKpi
              key={k.key}
              label={k.label}
              value={val}
              tone={val > 0 ? k.tone : undefined}
              pctOfTotal={k.key !== 'optOuts' ? pct(val, total) : undefined}
              active={statusFilter === filterKey}
              loading={loading}
              pulse={k.pulse && val > 0}
              onClick={() => onFilter(filterKey)}
            />
          )
        })}
        <span className={cls('occ-pulse-scope', isRange && 'is-range')} title={isRange ? 'Range-accurate counts' : 'Page-scoped counts'}>
          {isRange ? rangeLabel : 'page scope'}
        </span>
      </div>
      {!compact && <QueueFlow kpi={kpi} loading={loading} onFilter={onFilter} />}
      <OperationsPulse data={ops} compact={compact} />
    </section>
  )
}