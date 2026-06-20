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
  state: 'active' | 'paused' | 'degraded' | 'blocked'
  health: string
  lastUsed: string | null
}

const STATE_LABEL: Record<string, string> = {
  active: 'Active', paused: 'Paused', degraded: 'Degraded', blocked: 'Blocked',
}

interface SenderFleetOverviewProps {
  senders: SenderCardData[]
  selectedPhone: string | null
  onSelect: (phone: string | null) => void
}

export function SenderFleetOverview({ senders, selectedPhone, onSelect }: SenderFleetOverviewProps) {
  if (senders.length === 0) return null

  return (
    <div className="occ-fleet-cards">
      <header className="occ-fleet-cards__head">
        <span className="occ-fleet-cards__title">Sender Fleet</span>
        <span className="occ-fleet-cards__count">{senders.length} numbers</span>
      </header>
      <div className="occ-fleet-cards__grid">
        {senders.map(s => (
          <button
            key={s.phone}
            type="button"
            className={cls('occ-fleet-card', `is-${s.state}`, selectedPhone === s.phone && 'is-selected', s.violations21610 > 0 && 'is-critical')}
            onClick={() => onSelect(selectedPhone === s.phone ? null : s.phone)}
          >
            <div className="occ-fleet-card__head">
              <span className="occ-fleet-card__number">{s.phone}</span>
              <span className={cls('occ-fleet-card__state', `is-${s.state}`)}>{STATE_LABEL[s.state] ?? s.state}</span>
            </div>
            <span className="occ-fleet-card__market">{s.market}</span>
            <div className="occ-fleet-card__metrics">
              <span className="is-green">{s.deliveryPct}% del</span>
              <span className={s.failPct > 10 ? 'is-red' : ''}>{s.failPct}% fail</span>
              {s.violations21610 > 0 && <span className="is-red">21610: {s.violations21610}</span>}
            </div>
            <div className="occ-fleet-card__foot">
              <span>{s.sent} sent</span>
              {s.lastUsed && <span>{s.lastUsed}</span>}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}