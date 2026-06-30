const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

export interface SenderCardData {
  phone: string
  friendlyName?: string | null
  market: string
  stateCode?: string | null
  sent: number
  delivered: number
  failed: number
  blocked?: number
  deliveryPct: number
  failPct: number
  violations21610: number
  optOuts: number
  state: 'active' | 'paused' | 'degraded' | 'blocked' | 'unregistered'
  health: string
  performanceLabel: string
  operationalLabel: string
  lastUsed: string | null
  dailyCap?: number | null
  messagesSentToday?: number
  rangeRows?: number
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
    <div className="occ-fleet-strip occ-fleet-strip--v2">
      <span className="occ-fleet-strip__label">Sender Fleet · {senders.length} numbers</span>
      <div className="occ-fleet-strip__track">
        {senders.map(s => (
          <button
            key={s.phone}
            type="button"
            className={cls('occ-fleet-strip__card', `is-${s.state}`, selectedPhone === s.phone && 'is-selected', s.violations21610 > 0 && 'is-critical')}
            onClick={() => onSelect(selectedPhone === s.phone ? null : s.phone)}
          >
            <span className="occ-fleet-strip__num">{s.friendlyName || s.phone}</span>
            {s.friendlyName && <span className="occ-fleet-strip__sub occ-mono">{s.phone}</span>}
            <span className="occ-fleet-strip__market">
              {s.market}{s.stateCode ? ` · ${s.stateCode}` : ''}
            </span>
            <span className={cls('occ-fleet-strip__state', `is-${s.state}`)}>{STATE_LABEL[s.state] ?? s.state}</span>
            <span className="occ-fleet-strip__ops">{s.operationalLabel}</span>
            <span className="occ-fleet-strip__metrics">
              <span className="is-green">{s.deliveryPct}% del</span>
              <span className={s.failPct > 10 ? 'is-red' : ''}>{s.failPct}% fail</span>
              <span>{(s.messagesSentToday ?? 0) > 0 ? `${s.messagesSentToday} today` : `${s.sent} sent`}</span>
            </span>
            <span className="occ-fleet-strip__metrics is-sub">
              <span>{s.delivered} del</span>
              <span>{s.failed} fail</span>
              {(s.blocked ?? 0) > 0 && <span className="is-amber">{s.blocked} blk</span>}
              {s.violations21610 > 0 && <span className="is-red">21610 ×{s.violations21610}</span>}
              {s.optOuts > 0 && <span className="is-red">{s.optOuts} opt-out</span>}
              {s.dailyCap != null && <span className="is-muted">cap {s.dailyCap}</span>}
            </span>
            {s.lastUsed && <span className="occ-fleet-strip__used">Last {s.lastUsed}</span>}
          </button>
        ))}
      </div>
    </div>
  )
}