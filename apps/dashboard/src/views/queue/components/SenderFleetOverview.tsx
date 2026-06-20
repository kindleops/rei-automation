const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

export interface SenderCardData {
  phone: string
  market: string
  sent: number
  delivered: number
  failed: number
  deliveryPct: number
  failPct: number
  violations21610: number
  optOuts: number
  state: 'active' | 'paused' | 'degraded' | 'blocked' | 'unregistered'
  health: string
  performanceLabel: string
  operationalLabel: string
  lastUsed: string | null
}

const STATE_LABEL: Record<string, string> = {
  active: 'Active', paused: 'Paused', degraded: 'Degraded', blocked: 'Blocked', unregistered: 'Unregistered',
}

interface SenderFleetOverviewProps {
  senders: SenderCardData[]
  selectedPhone: string | null
  onSelect: (phone: string | null) => void
}

export function SenderFleetOverview({ senders, selectedPhone, onSelect }: SenderFleetOverviewProps) {
  if (senders.length === 0) return null

  return (
    <div className="occ-fleet-strip">
      <span className="occ-fleet-strip__label">Sender Fleet · {senders.length}</span>
      <div className="occ-fleet-strip__track">
        {senders.map(s => (
          <button
            key={s.phone}
            type="button"
            className={cls('occ-fleet-strip__card', `is-${s.state}`, selectedPhone === s.phone && 'is-selected', s.violations21610 > 0 && 'is-critical')}
            onClick={() => onSelect(selectedPhone === s.phone ? null : s.phone)}
          >
            <span className="occ-fleet-strip__num">{s.phone}</span>
            <span className="occ-fleet-strip__market">{s.market}</span>
            <span className={cls('occ-fleet-strip__state', `is-${s.state}`)}>{STATE_LABEL[s.state] ?? s.state}</span>
            <span className="occ-fleet-strip__ops">{s.operationalLabel}</span>
            <span className="occ-fleet-strip__metrics">
              <span className="is-green">{s.deliveryPct}% del</span>
              <span className={s.failPct > 10 ? 'is-red' : ''}>{s.failPct}% fail</span>
              <span>{s.sent} sent</span>
            </span>
            <span className="occ-fleet-strip__metrics is-sub">
              <span>{s.delivered} del</span>
              <span>{s.failed} fail</span>
              {s.violations21610 > 0 && <span className="is-red">21610 ×{s.violations21610}</span>}
              {s.optOuts > 0 && <span className="is-red">{s.optOuts} opt-out</span>}
            </span>
            {s.lastUsed && <span className="occ-fleet-strip__used">Last {s.lastUsed}</span>}
          </button>
        ))}
      </div>
    </div>
  )
}