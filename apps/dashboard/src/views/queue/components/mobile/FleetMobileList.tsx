import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../../shared/icons'
import { MobileBottomSheet } from '../../../../modules/mobile/MobileBottomSheet'
import type { ConfiguredMarket, QueueItem, TextgridFleetNumber } from '../../../../domain/queue/queue.types'
import { buildMarketStats, filterMarketStats, summarizeMarketFleet, type MarketHealthFilter, type MarketStat } from '../../market-fleet-stats'
import { buildSenderStats, summarizeSenderFleet, type SenderStat } from '../../sender-fleet-stats'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const shortMarket = (m: string | null | undefined) => (m ? m.replace(/,\s*[A-Z]{2}$/, '') : '—')

const relTime = (iso: string | null | undefined): string | null => {
  if (!iso) return null
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60000)
  if (min < 60) return `${Math.max(min, 1)}m`
  const h = Math.floor(min / 60)
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`
}

const fmtPhone = (p: string) => {
  const d = p.replace(/\D/g, '')
  if (d.length < 10) return p
  return `+1 ${d.slice(-10, -7)} ${d.slice(-7, -4)} ${d.slice(-4)}`
}

const HEALTH_LABEL: Record<string, string> = {
  healthy: 'Healthy', watch: 'Watch', degraded: 'Degraded', critical: 'Degraded', idle: 'Idle',
}

const HEALTH_TONE: Record<string, string> = {
  healthy: 'green', watch: 'cyan', degraded: 'amber', critical: 'red', idle: 'muted',
}

const STATE_TONE: Record<string, string> = {
  active: 'green', paused: 'muted', degraded: 'amber', blocked: 'red', unregistered: 'muted',
}

const STATE_LABEL: Record<string, string> = {
  active: 'Active', paused: 'Paused', degraded: 'Degraded', blocked: 'Blocked', unregistered: 'Unregistered',
}

/** Small key/value grid used only inside the detail sheets. */
function Stats({ rows }: { rows: Array<{ k: string; v: string; tone?: string }> }) {
  if (rows.length === 0) return null
  return (
    <div className="qm-fleet-stats">
      {rows.map((r) => (
        <div key={r.k} className="qm-fleet-stats__row">
          <span>{r.k}</span>
          <strong className={cls(r.tone && `is-${r.tone}`)}>{r.v}</strong>
        </div>
      ))}
    </div>
  )
}

// ── Markets ─────────────────────────────────────────────────────────────────

const MARKET_FILTERS: Array<{ key: MarketHealthFilter; label: string }> = [
  { key: 'configured', label: 'Configured' },
  { key: 'ready', label: 'Ready' },
  { key: 'degraded', label: 'Degraded' },
  { key: 'no-sender', label: 'No sender' },
  { key: 'idle', label: 'Idle' },
  { key: 'all', label: 'All' },
]

interface MarketsMobileListProps {
  items: QueueItem[]
  directory: ConfiguredMarket[]
  fleet: TextgridFleetNumber[]
  rangeLabel: string
  selectedMarket: string | null
  onSelectMarket: (market: string | null) => void
  onViewRows: (market: string) => void
}

export function MarketsMobileList({
  items,
  directory,
  fleet,
  rangeLabel,
  selectedMarket,
  onSelectMarket,
  onViewRows,
}: MarketsMobileListProps) {
  const [healthFilter, setHealthFilter] = useState<MarketHealthFilter>('configured')
  const stats = useMemo(() => buildMarketStats(items, directory, fleet), [items, directory, fleet])
  const filtered = useMemo(() => filterMarketStats(stats, healthFilter), [stats, healthFilter])
  const summary = useMemo(() => summarizeMarketFleet(stats), [stats])
  const selected = stats.find((s) => s.market === selectedMarket) ?? null

  const senderLine = (m: MarketStat) => {
    if (!m.senderExists) return 'No sender configured'
    const senders = `${m.senderCount} sender${m.senderCount === 1 ? '' : 's'}`
    return m.dailyCapTotal != null ? `${senders} · Cap ${m.dailyCapTotal.toLocaleString()}/day` : senders
  }

  const activityLine = (m: MarketStat) => {
    if (m.total === 0) return `No queue activity in ${rangeLabel}`
    if (m.sent === 0) return `${m.total} row${m.total === 1 ? '' : 's'} · none dispatched yet`
    return `${m.messagesSentToday || m.sent} sent · ${m.deliveryPct}% delivered`
  }

  const detail = selected && typeof document !== 'undefined' ? createPortal(
    <MobileBottomSheet open snap="half" onClose={() => onSelectMarket(null)} className="qm-fleet-sheet">
      <header className="qm-faildetail__head">
        <div>
          <strong>{shortMarket(selected.market)}</strong>
          <span>{selected.senderReadiness}</span>
        </div>
        <button type="button" className="qms-chrome__btn is-close" onClick={() => onSelectMarket(null)} aria-label="Close">
          <Icon name="close" size={14} />
        </button>
      </header>
      <div className="qm-faildetail__body">
        <div className="qm-faildetail__tags">
          <span className={cls('qm-tag', `is-${HEALTH_TONE[selected.health] ?? 'muted'}`)}>
            {selected.total === 0 ? 'Idle' : HEALTH_LABEL[selected.health] ?? selected.health}
          </span>
          {selected.stateCode && <span className="qm-tag is-quiet">{selected.stateCode}</span>}
          {!selected.configured && <span className="qm-tag is-amber">Unregistered</span>}
        </div>
        <p className="qm-faildetail__action">{selected.suggestedAction}</p>
        <Stats
          rows={[
            { k: 'Rows in range', v: selected.total.toLocaleString() },
            { k: 'Sent', v: selected.sent.toLocaleString() },
            { k: 'Delivered', v: selected.sent > 0 ? `${selected.delivered} · ${selected.deliveryPct}%` : '—', tone: 'green' },
            { k: 'Failed', v: selected.sent > 0 ? `${selected.failed} · ${selected.failPct}%` : String(selected.failed), tone: selected.failed > 0 ? 'red' : undefined },
            { k: 'Blocked', v: String(selected.blocked), tone: selected.blocked > 0 ? 'amber' : undefined },
            ...(selected.optOuts > 0 ? [{ k: 'Opt-outs', v: String(selected.optOuts), tone: 'red' }] : []),
            ...(selected.violations21610 > 0 ? [{ k: '21610', v: String(selected.violations21610), tone: 'red' }] : []),
            { k: 'Sent today', v: String(selected.messagesSentToday) },
          ]}
        />
      </div>
      <footer className="qm-faildetail__foot">
        <button
          type="button"
          className="qms-action is-primary"
          disabled={selected.total === 0}
          onClick={() => { onViewRows(selected.market); onSelectMarket(null) }}
        >
          {selected.total > 0 ? `View ${selected.total} row${selected.total === 1 ? '' : 's'}` : 'No rows in range'}
        </button>
      </footer>
    </MobileBottomSheet>,
    document.body,
  ) : null

  return (
    <div className="qm-fleet">
      <header className="qm-failures__head">
        <p className="qm-events__counts">
          <span className="has-value">{summary.configuredCount} configured</span>
          <em>·</em>
          <span className="is-green">{summary.readyCount} ready</span>
          {summary.noSenderCount > 0 && (<><em>·</em><span className="is-red has-value">{summary.noSenderCount} no sender</span></>)}
        </p>
      </header>

      <div className="qm-events__bar" role="tablist" aria-label="Filter markets">
        {MARKET_FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            role="tab"
            aria-selected={healthFilter === f.key}
            className={cls('qm-chip', healthFilter === f.key && 'is-active')}
            onClick={() => setHealthFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="qm-empty">No markets match this filter.</div>
      ) : (
        <div className="qm-fleet__list">
          {filtered.map((m) => (
            <article
              key={m.market}
              className={cls('qm-fleetrow', `is-${HEALTH_TONE[m.health] ?? 'muted'}`, selectedMarket === m.market && 'is-open')}
              role="button"
              tabIndex={0}
              aria-pressed={selectedMarket === m.market}
              onClick={() => onSelectMarket(m.market)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectMarket(m.market) } }}
            >
              <span className="qm-fleetrow__accent" aria-hidden="true" />
              <div className="qm-fleetrow__body">
                <div className="qm-fleetrow__lead">
                  <strong>{shortMarket(m.market)}</strong>
                  <span className={cls('qm-fleetrow__health', `is-${HEALTH_TONE[m.health] ?? 'muted'}`)}>
                    {m.total === 0 ? 'Idle' : HEALTH_LABEL[m.health] ?? m.health}
                  </span>
                </div>
                <p className="qm-fleetrow__cap">{senderLine(m)}</p>
                <p className="qm-fleetrow__activity">{activityLine(m)}</p>
              </div>
              <Icon name="chevron-right" size={14} />
            </article>
          ))}
        </div>
      )}
      {detail}
    </div>
  )
}

// ── Senders ─────────────────────────────────────────────────────────────────

interface SendersMobileListProps {
  items: QueueItem[]
  fleet: TextgridFleetNumber[]
  rangeLabel: string
  selectedPhone: string | null
  onSelectPhone: (phone: string | null) => void
}

export function SendersMobileList({
  items,
  fleet,
  rangeLabel,
  selectedPhone,
  onSelectPhone,
}: SendersMobileListProps) {
  const [marketFilter, setMarketFilter] = useState<string | null>(null)
  const stats = useMemo(() => buildSenderStats(items, fleet), [items, fleet])
  const filtered = useMemo(
    () => (marketFilter ? stats.filter((s) => s.market === marketFilter) : stats),
    [stats, marketFilter],
  )
  const summary = useMemo(() => summarizeSenderFleet(stats), [stats])
  const selected = stats.find((s) => s.phone === selectedPhone) ?? null

  const capLine = (s: SenderStat) => {
    const parts: string[] = []
    if (s.dailyCap != null) parts.push(`Cap ${s.dailyCap.toLocaleString()}/day`)
    const last = relTime(s.lastUsed || s.registryLastUsedAt)
    if (last) parts.push(`Last used ${last}`)
    if (parts.length === 0) parts.push('No activity logged')
    return parts.join(' · ')
  }

  const detail = selected && typeof document !== 'undefined' ? createPortal(
    <MobileBottomSheet open snap="half" onClose={() => onSelectPhone(null)} className="qm-fleet-sheet">
      <header className="qm-faildetail__head">
        <div>
          <strong className="is-mono">{fmtPhone(selected.phone)}</strong>
          <span>{selected.friendlyName || shortMarket(selected.market)}</span>
        </div>
        <button type="button" className="qms-chrome__btn is-close" onClick={() => onSelectPhone(null)} aria-label="Close">
          <Icon name="close" size={14} />
        </button>
      </header>
      <div className="qm-faildetail__body">
        <div className="qm-faildetail__tags">
          <span className={cls('qm-tag', `is-${STATE_TONE[selected.state] ?? 'muted'}`)}>
            {STATE_LABEL[selected.state] ?? selected.state}
          </span>
          <span className={cls('qm-tag', `is-${HEALTH_TONE[selected.health] ?? 'muted'}`)}>
            {HEALTH_LABEL[selected.health] ?? selected.health}
          </span>
          {!selected.registered && <span className="qm-tag is-amber">Unregistered</span>}
        </div>
        <p className="qm-faildetail__action">{selected.operationalLabel}</p>
        <Stats
          rows={[
            { k: 'Market', v: shortMarket(selected.market) },
            ...(selected.dailyCap != null ? [{ k: 'Daily cap', v: `${selected.dailyCap.toLocaleString()}/day` }] : []),
            { k: 'Sent today', v: String(selected.messagesSentToday) },
            { k: 'Sent in range', v: selected.sent.toLocaleString() },
            { k: 'Delivered', v: selected.sent > 0 ? `${selected.delivered} · ${selected.deliveryPct}%` : '—', tone: 'green' },
            { k: 'Failed', v: selected.sent > 0 ? `${selected.failed} · ${selected.failPct}%` : String(selected.failed), tone: selected.failed > 0 ? 'red' : undefined },
            ...(selected.optOuts > 0 ? [{ k: 'Opt-outs', v: String(selected.optOuts), tone: 'red' }] : []),
            ...(selected.violations21610 > 0 ? [{ k: '21610', v: String(selected.violations21610), tone: 'red' }] : []),
            ...(selected.healthScore != null ? [{ k: 'Health score', v: String(Math.round(selected.healthScore * 100)) }] : []),
          ]}
        />
      </div>
    </MobileBottomSheet>,
    document.body,
  ) : null

  return (
    <div className="qm-fleet">
      <header className="qm-failures__head">
        <p className="qm-events__counts">
          <span className="has-value">{summary.fleetTotal} number{summary.fleetTotal === 1 ? '' : 's'}</span>
          <em>·</em>
          <span className="is-green">{summary.active} active</span>
          {summary.blocked > 0 && (<><em>·</em><span className="is-red has-value">{summary.blocked} blocked</span></>)}
        </p>
      </header>

      {summary.markets.length > 1 && (
        <div className="qm-events__bar" role="tablist" aria-label="Filter senders by market">
          <button
            type="button"
            role="tab"
            aria-selected={!marketFilter}
            className={cls('qm-chip', !marketFilter && 'is-active')}
            onClick={() => setMarketFilter(null)}
          >
            All
          </button>
          {summary.markets.map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={marketFilter === m}
              className={cls('qm-chip', marketFilter === m && 'is-active')}
              onClick={() => setMarketFilter(m)}
            >
              {shortMarket(m)}
            </button>
          ))}
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="qm-empty">No TextGrid numbers match this filter in the last {rangeLabel}.</div>
      ) : (
        <div className="qm-fleet__list">
          {filtered.map((s) => (
            <article
              key={s.phone}
              className={cls('qm-fleetrow', `is-${STATE_TONE[s.state] ?? 'muted'}`, selectedPhone === s.phone && 'is-open')}
              role="button"
              tabIndex={0}
              aria-pressed={selectedPhone === s.phone}
              onClick={() => onSelectPhone(s.phone)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectPhone(s.phone) } }}
            >
              <span className="qm-fleetrow__accent" aria-hidden="true" />
              <div className="qm-fleetrow__body">
                <div className="qm-fleetrow__lead">
                  <strong>{s.friendlyName || shortMarket(s.market)}</strong>
                  <span className={cls('qm-fleetrow__health', `is-${STATE_TONE[s.state] ?? 'muted'}`)}>
                    {STATE_LABEL[s.state] ?? s.state}
                  </span>
                </div>
                <p className="qm-fleetrow__cap is-mono">{fmtPhone(s.phone)}</p>
                <p className="qm-fleetrow__activity">{capLine(s)}</p>
              </div>
              <Icon name="chevron-right" size={14} />
            </article>
          ))}
        </div>
      )}
      {detail}
    </div>
  )
}
