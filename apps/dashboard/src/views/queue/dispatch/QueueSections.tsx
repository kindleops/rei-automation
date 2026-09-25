/**
 * Queue analytics views on mobile — Events, Failures, Markets, Senders — in
 * the dispatch material. Each view reads EVERY queue row in the selected
 * range (the page hands them over), never just the 25 rows on screen, and
 * every number here is computed by the same stats modules desktop uses.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { Icon } from '../../../shared/icons'
import type { ConfiguredMarket, QueueItem, TextgridFleetNumber } from '../../../domain/queue/queue.types'
import {
  buildEventTimelineItems,
  buildHourlyVelocity,
  eventTimestamp,
  isLiveEvent,
  matchesTimelineFilter,
  summarizeEventTimeline,
  TIMELINE_TYPE_FILTERS,
  type TimelineTypeFilter,
} from '../event-timeline-stats'
import {
  buildFailureStats,
  deriveFailureCause,
  filterFailureStats,
  summarizeFailureTaxonomy,
  type FailureCategoryFilter,
  type FailureCauseStat,
} from '../failure-taxonomy-stats'
import { buildMarketStats, filterMarketStats, summarizeMarketFleet  , type MarketHealthFilter } from '../market-fleet-stats'
import { buildSenderStats, summarizeSenderFleet, type SenderStat } from '../sender-fleet-stats'
import { resolveSellerIdentity } from '../queue-ui-helpers'
import { dispatchStatus, formatPhone, localWhen, relative } from './queue-dispatch-model'
import { QueueShell, type QueueShellProps } from './QueueShell'
import { QueueDispatchPicker } from './QueueDispatchSheet'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')
const shortMarket = (m: string | null | undefined) => (m ? m.replace(/,\s*[A-Z]{2}$/, '') : null)
const n = (v: number) => v.toLocaleString()

type ShellProps = Omit<QueueShellProps, 'view' | 'children' | 'controls' | 'scrollKey'>

// ── Shared pieces ────────────────────────────────────────────────────────────

export interface Kpi { label: string; value: string | number; tone?: 'green' | 'blue' | 'cyan' | 'amber' | 'red' | 'muted'; hint?: string }

export function KpiPanel({ kpis, footnote, children }: { kpis: Kpi[]; footnote?: string | null; children?: ReactNode }) {
  return (
    <section className="qx-panel" aria-label="Summary">
      <div className="qx-kpis" style={{ ['--qx-kpis' as string]: kpis.length }}>
        {kpis.map((k) => (
          <div key={k.label} className={cls('qx-kpi', k.tone && `tone-${k.tone}`)}>
            <strong className="qx-kpi__value">{typeof k.value === 'number' ? n(k.value) : k.value}</strong>
            <span className="qx-kpi__label">{k.label}</span>
          </div>
        ))}
      </div>
      {children}
      {footnote && <p className="qx-panel__foot">{footnote}</p>}
    </section>
  )
}

function Chips<T extends string>({ value, options, onChange, label }: {
  value: T
  options: Array<{ key: T; label: string; count?: number }>
  onChange: (v: T) => void
  label: string
}) {
  return (
    <div className="qx-chips" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          role="tab"
          aria-selected={value === o.key}
          className={cls('qx-chiptab', value === o.key && 'is-active')}
          onClick={() => onChange(o.key)}
        >
          {o.label}
          {typeof o.count === 'number' && <em>{n(o.count)}</em>}
        </button>
      ))}
    </div>
  )
}

function Empty({ icon, title, sub }: { icon: 'check' | 'activity' | 'shield' | 'map' | 'phone'; title: string; sub: string }) {
  return (
    <div className="qx-empty">
      <Icon name={icon} size={18} />
      <strong>{title}</strong>
      <span>{sub}</span>
    </div>
  )
}

function Skeletons() {
  return (
    <>
      <div className="qx-panel is-skeleton" aria-hidden="true"><span className="qx-skel is-tall" style={{ width: '100%' }} /></div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="qx-card is-skeleton" aria-hidden="true">
          <span className="qx-skel" style={{ width: '48%' }} />
          <span className="qx-skel" style={{ width: '76%' }} />
          <span className="qx-skel" style={{ width: '34%' }} />
        </div>
      ))}
    </>
  )
}

function Meter({ value, max, tone }: { value: number; max: number; tone: string }) {
  const pct = max > 0 ? Math.max(2, Math.min(100, (value / max) * 100)) : 0
  return (
    <span className={cls('qx-meter', `tone-${tone}`)} aria-hidden="true">
      <span style={{ width: `${pct}%` }} />
    </span>
  )
}

function Fact({ k, v, tone, mono }: { k: string; v: string | null | undefined; tone?: string; mono?: boolean }) {
  if (!v) return null
  return (
    <div className="qx-fact">
      <span className="qx-fact__k">{k}</span>
      <span className={cls('qx-fact__v', tone && `tone-${tone}`, mono && 'is-mono')}>{v}</span>
    </div>
  )
}

// ── Events ───────────────────────────────────────────────────────────────────

const EVENT_FILTERS: TimelineTypeFilter[] = ['all', 'failed', 'blocked', 'delivered', 'sent', 'sending', 'retry']

export function QueueEventsView({ shell, items, loading, rangeLabel, openId, onOpen }: {
  shell: ShellProps
  items: QueueItem[]
  loading: boolean
  rangeLabel: string
  openId: string | null
  onOpen: (item: QueueItem, list: QueueItem[]) => void
}) {
  const [filter, setFilter] = useState<TimelineTypeFilter>('all')
  const all = useMemo(() => buildEventTimelineItems(items), [items])
  const feed = useMemo(() => all.filter((i) => matchesTimelineFilter(i, filter)), [all, filter])
  const summary = useMemo(() => summarizeEventTimeline(all), [all])
  const velocity = useMemo(() => buildHourlyVelocity(all, 12), [all])
  const peak = Math.max(1, ...velocity.map((b) => b.count))
  const options = EVENT_FILTERS
    .map((key) => ({ key, label: TIMELINE_TYPE_FILTERS.find((f) => f.key === key)?.label ?? key, count: key === 'all' ? all.length : all.filter((i) => matchesTimelineFilter(i, key)).length }))
    .filter((o) => o.key === 'all' || o.count > 0)

  return (
    <QueueShell {...shell} view="events" scrollKey={filter} controls={<Chips value={filter} options={options} onChange={setFilter} label="Filter events" />}>
      <div className="qx-list">
        {loading && all.length === 0 ? <Skeletons /> : (
          <>
            <KpiPanel
              kpis={[
                { label: 'Live · 15m', value: summary.last15m, tone: summary.last15m > 0 ? 'cyan' : 'muted' },
                { label: 'Delivered', value: summary.delivered, tone: 'green' },
                { label: 'Failed', value: summary.failed, tone: summary.failed > 0 ? 'red' : 'muted' },
              ]}
              footnote={`${n(summary.total)} events · ${rangeLabel}`}
            >
              {velocity.length > 0 && (
                <div className="qx-spark" role="img" aria-label="Events per hour, last 12 hours">
                  {velocity.map((b, i) => (
                    <span
                      key={b.key}
                      className={cls('qx-spark__bar', `lvl-${b.tone}`)}
                      style={{ ['--h' as string]: `${Math.max(6, (b.count / peak) * 100)}%`, ['--i' as string]: i }}
                      title={`${b.label}: ${b.count}`}
                    />
                  ))}
                  <span className="qx-spark__axis"><em>{velocity[0]?.label}</em><em>now</em></span>
                </div>
              )}
            </KpiPanel>

            {feed.length === 0 ? (
              <Empty icon="activity" title="No events" sub={`Nothing matches this filter · ${rangeLabel}`} />
            ) : (
              <ol className="qx-timeline">
                {feed.slice(0, 150).map((item) => {
                  const identity = resolveSellerIdentity(item)
                  const status = dispatchStatus(item)
                  const ts = eventTimestamp(item)
                  const live = isLiveEvent(ts)
                  return (
                    <li key={item.id} className={cls('qx-tl', `tone-${status.tone}`, live && 'is-live')}>
                      <span className="qx-tl__dot" aria-hidden="true" />
                      <article
                        className={cls('qx-card', 'is-compact', `tone-${status.tone}`, openId === item.id && 'is-open')}
                        data-section-row
                        role="button"
                        tabIndex={0}
                        onClick={() => onOpen(item, feed)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(item, feed) } }}
                      >
                        <div className="qx-card__top">
                          <strong className="qx-card__name">{identity.primary}</strong>
                          <span className="qx-card__time">{relative(ts) ?? '—'}</span>
                        </div>
                        <p className="qx-card__addr">
                          {[item.propertyAddress || 'No property linked', shortMarket(item.market)].filter(Boolean).join(' · ')}
                        </p>
                        <div className="qx-card__row">
                          <span className={cls('qx-pill', `tone-${status.tone}`)}>
                            {status.tone === 'cyan' && <span className="qx-pill__pulse" aria-hidden="true" />}
                            {status.label}
                          </span>
                          <span className="qx-card__when-sub">{localWhen(ts, item.timezone)}</span>
                        </div>
                      </article>
                    </li>
                  )
                })}
                {feed.length > 150 && <li className="qx-more"><span>Showing the latest 150 of {n(feed.length)}</span></li>}
              </ol>
            )}
          </>
        )}
      </div>
    </QueueShell>
  )
}

// ── Failures ─────────────────────────────────────────────────────────────────

const CATEGORY_FILTERS: FailureCategoryFilter[] = ['all', 'Compliance', 'Carrier', 'Routing', 'Template', 'Payload', 'Webhook', 'Guard', 'Unknown']
const SEVERITY_TONE: Record<FailureCauseStat['severity'], 'red' | 'amber' | 'blue' | 'muted'> = { critical: 'red', high: 'red', medium: 'amber', low: 'muted' }
const SEVERITY_LABEL: Record<FailureCauseStat['severity'], string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' }

export function QueueFailuresView({ shell, items, loading, rangeLabel, onOpenItem, onViewRows }: {
  shell: ShellProps
  items: QueueItem[]
  loading: boolean
  rangeLabel: string
  onOpenItem: (item: QueueItem, list: QueueItem[]) => void
  onViewRows: (cause: string, label: string) => void
}) {
  const [category, setCategory] = useState<FailureCategoryFilter>('all')
  const [openCause, setOpenCause] = useState<string | null>(null)
  const stats = useMemo(() => buildFailureStats(items), [items])
  const summary = useMemo(() => summarizeFailureTaxonomy(stats), [stats])
  const filtered = useMemo(() => filterFailureStats(stats, category, 'all'), [stats, category])
  const options = CATEGORY_FILTERS
    .map((c) => ({ key: c, label: c === 'all' ? 'All' : c, count: c === 'all' ? stats.length : stats.filter((s) => s.category === c).length }))
    .filter((o) => o.key === 'all' || o.count > 0)
  const selected = stats.find((s) => s.cause === openCause) ?? null
  const affected = useMemo(() => (selected ? items.filter((i) => deriveFailureCause(i) === selected.cause) : []), [items, selected])
  const maxCount = Math.max(1, ...stats.map((s) => s.count))

  return (
    <QueueShell {...shell} view="failures" scrollKey={category} controls={options.length > 2 ? <Chips value={category} options={options} onChange={setCategory} label="Failure category" /> : undefined}>
      <div className="qx-list">
        {loading && items.length === 0 ? <Skeletons /> : (
          <>
            <KpiPanel
              kpis={[
                { label: 'Failed or held', value: summary.total, tone: summary.total > 0 ? 'red' : 'muted' },
                { label: 'Causes', value: summary.causeCount, tone: 'amber' },
                { label: 'Retryable', value: summary.retryable, tone: summary.retryable > 0 ? 'green' : 'muted' },
              ]}
              footnote={`Across ${n(items.length)} queue rows · ${rangeLabel}`}
            />
            {stats.length === 0 ? (
              <Empty icon="shield" title="No failures" sub={`Nothing failed or was held · ${rangeLabel}`} />
            ) : filtered.map((s) => {
              const tone = SEVERITY_TONE[s.severity]
              const markets = s.markets.map(shortMarket).filter(Boolean) as string[]
              return (
                <article
                  key={s.cause}
                  className={cls('qx-card', `tone-${tone}`)}
                  data-section-row
                  role="button"
                  tabIndex={0}
                  onClick={() => setOpenCause(s.cause)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenCause(s.cause) } }}
                >
                  <div className="qx-card__top">
                    <strong className="qx-card__name">{s.label}</strong>
                    <span className={cls('qx-pill', `tone-${tone}`)}>{SEVERITY_LABEL[s.severity]}</span>
                  </div>
                  <div className="qx-bigstat">
                    <strong>{n(s.count)}</strong>
                    <span>row{s.count === 1 ? '' : 's'} · {s.category}</span>
                    <Meter value={s.count} max={maxCount} tone={tone} />
                  </div>
                  <p className="qx-card__action">{s.action}</p>
                  <div className="qx-card__foot">
                    <span className="qx-card__when">
                      <span className="qx-card__when-main">{markets.slice(0, 2).join(' · ') || 'No market'}{markets.length > 2 ? ` +${markets.length - 2}` : ''}</span>
                      <span className="qx-card__when-sub">Last seen {relative(s.lastSeen) ?? '—'}</span>
                    </span>
                    <span className={cls('qx-chip', s.retryable ? 'tone-green' : 'tone-red')}>{s.retryable ? 'Retryable' : 'No retry'}</span>
                  </div>
                </article>
              )
            })}
          </>
        )}
      </div>

      {selected && (
        <QueueDispatchPicker
          title={selected.label}
          onClose={() => setOpenCause(null)}
          footer={(
            <button type="button" className="qx-act is-primary" onClick={() => { setOpenCause(null); onViewRows(selected.cause, selected.label) }}>
              View {n(selected.count)} row{selected.count === 1 ? '' : 's'} in Attention
            </button>
          )}
        >
          <div className="qx-tags">
            <span className={cls('qx-pill', `tone-${SEVERITY_TONE[selected.severity]}`)}>{SEVERITY_LABEL[selected.severity]}</span>
            <span className="qx-pill tone-muted">{selected.category}</span>
            <span className={cls('qx-pill', selected.retryable ? 'tone-green' : 'tone-red')}>{selected.retryable ? 'Retryable' : 'Will not retry'}</span>
            {selected.suppression && <span className="qx-pill tone-red">Suppression required</span>}
          </div>
          <div className={cls('qx-note', `tone-${SEVERITY_TONE[selected.severity] === 'muted' ? 'blue' : SEVERITY_TONE[selected.severity]}`)}>
            <Icon name="alert" size={15} />
            <div><strong>What to do</strong><p>{selected.action}</p></div>
          </div>
          <section className="qx-block">
            <h3 className="qx-block__title">Reach</h3>
            <div className="qx-facts">
              <Fact k="Rows" v={`${n(selected.count)} · ${selected.failedCount} failed · ${selected.blockedCount} held`} />
              <Fact k="Share" v={`${Math.round(selected.pctOfTotal)}% of failures`} />
              <Fact k="Markets" v={selected.markets.map(shortMarket).filter(Boolean).slice(0, 6).join(', ') || null} />
              <Fact k="Senders" v={selected.senders.slice(0, 4).map((p) => `··${p.slice(-4)}`).join('  ') || null} mono />
              <Fact k="First seen" v={localWhen(selected.firstSeen, null)} />
              <Fact k="Last seen" v={localWhen(selected.lastSeen, null)} />
            </div>
          </section>
          {affected.length > 0 && (
            <section className="qx-block">
              <h3 className="qx-block__title">Affected rows<em>{n(affected.length)}</em></h3>
              <div className="qx-rows">
                {affected.slice(0, 8).map((row) => (
                  <button key={row.id} type="button" className="qx-rowlink" onClick={() => { setOpenCause(null); onOpenItem(row, affected) }}>
                    <span className="qx-rowlink__copy">
                      <strong>{resolveSellerIdentity(row).primary}</strong>
                      <span>{row.propertyAddress || 'No address'}</span>
                    </span>
                    <Icon name="chevron-right" size={14} />
                  </button>
                ))}
              </div>
            </section>
          )}
        </QueueDispatchPicker>
      )}
    </QueueShell>
  )
}

// ── Markets ──────────────────────────────────────────────────────────────────

const MARKET_FILTERS: Array<{ key: MarketHealthFilter; label: string }> = [
  { key: 'configured', label: 'Configured' },
  { key: 'ready', label: 'Ready' },
  { key: 'degraded', label: 'Degraded' },
  { key: 'no-sender', label: 'No sender' },
  { key: 'idle', label: 'Idle' },
  { key: 'all', label: 'All' },
]
const HEALTH_TONE: Record<string, 'green' | 'cyan' | 'amber' | 'red' | 'muted'> = { healthy: 'green', watch: 'cyan', degraded: 'amber', critical: 'red', idle: 'muted' }
const HEALTH_LABEL: Record<string, string> = { healthy: 'Healthy', watch: 'Watch', degraded: 'Degraded', critical: 'Critical', idle: 'Idle' }

export function QueueMarketsView({ shell, items, directory, fleet, loading, rangeLabel, onViewRows }: {
  shell: ShellProps
  items: QueueItem[]
  directory: ConfiguredMarket[]
  fleet: TextgridFleetNumber[]
  loading: boolean
  rangeLabel: string
  onViewRows: (market: string) => void
}) {
  const [filter, setFilter] = useState<MarketHealthFilter>('configured')
  const [open, setOpen] = useState<string | null>(null)
  const stats = useMemo(() => buildMarketStats(items, directory, fleet), [items, directory, fleet])
  const summary = useMemo(() => summarizeMarketFleet(stats), [stats])
  const options = MARKET_FILTERS.map((f) => ({ ...f, count: filterMarketStats(stats, f.key).length })).filter((o) => o.key === 'configured' || o.key === 'all' || o.count > 0)
  const list = useMemo(() => filterMarketStats(stats, filter), [stats, filter])
  const selected = stats.find((s) => s.market === open) ?? null
  const maxTotal = Math.max(1, ...stats.map((s) => s.total))

  return (
    <QueueShell {...shell} view="market" scrollKey={filter} controls={<Chips value={filter} options={options} onChange={setFilter} label="Market health" />}>
      <div className="qx-list">
        {loading && items.length === 0 ? <Skeletons /> : (
          <>
            <KpiPanel
              kpis={[
                { label: 'Configured', value: summary.configuredCount },
                { label: 'Ready', value: summary.readyCount, tone: 'green' },
                { label: 'No sender', value: summary.noSenderCount, tone: summary.noSenderCount > 0 ? 'red' : 'muted' },
              ]}
              footnote={`Activity across ${n(items.length)} queue rows · ${rangeLabel}`}
            />
            {list.length === 0 ? <Empty icon="map" title="No markets" sub="Nothing matches this filter." /> : list.map((m) => {
              const tone = m.total === 0 ? 'muted' : HEALTH_TONE[m.health] ?? 'muted'
              return (
                <article
                  key={m.market}
                  className={cls('qx-card', `tone-${tone}`)}
                  data-section-row
                  role="button"
                  tabIndex={0}
                  onClick={() => setOpen(m.market)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(m.market) } }}
                >
                  <div className="qx-card__top">
                    <strong className="qx-card__name">{shortMarket(m.market)}{m.stateCode ? <em className="qx-card__state">{m.stateCode}</em> : null}</strong>
                    <span className={cls('qx-pill', `tone-${tone}`)}>{m.total === 0 ? 'Idle' : HEALTH_LABEL[m.health] ?? m.health}</span>
                  </div>
                  <div className="qx-trio">
                    <span><strong>{n(m.total)}</strong><em>rows</em></span>
                    <span><strong>{m.sent > 0 ? `${m.deliveryPct}%` : '—'}</strong><em>delivered</em></span>
                    <span className={cls(m.failed > 0 && 'tone-red')}><strong>{n(m.failed)}</strong><em>failed</em></span>
                  </div>
                  <Meter value={m.total} max={maxTotal} tone={tone === 'muted' ? 'accent' : tone} />
                  <p className="qx-card__addr">
                    {!m.senderExists ? 'No sender configured' : `${m.senderCount} sender${m.senderCount === 1 ? '' : 's'}${m.dailyCapTotal != null ? ` · cap ${n(m.dailyCapTotal)}/day` : ''}`}
                  </p>
                </article>
              )
            })}
          </>
        )}
      </div>

      {selected && (
        <QueueDispatchPicker
          title={shortMarket(selected.market) ?? selected.market}
          onClose={() => setOpen(null)}
          footer={(
            <button type="button" className="qx-act is-primary" disabled={selected.total === 0} onClick={() => { setOpen(null); onViewRows(selected.market) }}>
              {selected.total > 0 ? `View ${n(selected.total)} row${selected.total === 1 ? '' : 's'}` : 'No rows in range'}
            </button>
          )}
        >
          <div className="qx-tags">
            <span className={cls('qx-pill', `tone-${selected.total === 0 ? 'muted' : HEALTH_TONE[selected.health] ?? 'muted'}`)}>{selected.total === 0 ? 'Idle' : HEALTH_LABEL[selected.health] ?? selected.health}</span>
            {selected.stateCode && <span className="qx-pill tone-muted">{selected.stateCode}</span>}
            {!selected.configured && <span className="qx-pill tone-amber">Unregistered</span>}
          </div>
          <div className="qx-note tone-blue">
            <Icon name="map" size={15} />
            <div><strong>{selected.senderReadiness}</strong><p>{selected.suggestedAction}</p></div>
          </div>
          <section className="qx-block">
            <h3 className="qx-block__title">In range<em>{rangeLabel}</em></h3>
            <div className="qx-facts">
              <Fact k="Rows" v={n(selected.total)} />
              <Fact k="Sent" v={n(selected.sent)} />
              <Fact k="Delivered" v={selected.sent > 0 ? `${n(selected.delivered)} · ${selected.deliveryPct}%` : '—'} tone="green" />
              <Fact k="Failed" v={selected.sent > 0 ? `${n(selected.failed)} · ${selected.failPct}%` : n(selected.failed)} tone={selected.failed > 0 ? 'red' : undefined} />
              <Fact k="Held" v={n(selected.blocked)} tone={selected.blocked > 0 ? 'amber' : undefined} />
              {selected.optOuts > 0 && <Fact k="Opt-outs" v={n(selected.optOuts)} tone="red" />}
              {selected.violations21610 > 0 && <Fact k="21610" v={n(selected.violations21610)} tone="red" />}
              <Fact k="Sent today" v={n(selected.messagesSentToday)} />
            </div>
          </section>
        </QueueDispatchPicker>
      )}
    </QueueShell>
  )
}

// ── Senders ──────────────────────────────────────────────────────────────────

const STATE_TONE: Record<string, 'green' | 'amber' | 'red' | 'muted'> = { active: 'green', paused: 'muted', degraded: 'amber', blocked: 'red', unregistered: 'muted' }
const STATE_LABEL: Record<string, string> = { active: 'Active', paused: 'Paused', degraded: 'Degraded', blocked: 'Blocked', unregistered: 'Unregistered' }

export function QueueSendersView({ shell, items, fleet, loading, rangeLabel, onViewRows }: {
  shell: ShellProps
  items: QueueItem[]
  fleet: TextgridFleetNumber[]
  loading: boolean
  rangeLabel: string
  onViewRows: (phone: string) => void
}) {
  const [market, setMarket] = useState<string>('all')
  const [open, setOpen] = useState<string | null>(null)
  const stats = useMemo(() => buildSenderStats(items, fleet), [items, fleet])
  const summary = useMemo(() => summarizeSenderFleet(stats), [stats])
  const list = useMemo(() => (market === 'all' ? stats : stats.filter((s) => s.market === market)), [stats, market])
  const options = [{ key: 'all', label: 'All', count: stats.length }, ...summary.markets.map((m) => ({ key: m, label: shortMarket(m) ?? m, count: stats.filter((s) => s.market === m).length }))]
  const selected = stats.find((s) => s.phone === open) ?? null

  const usage = (s: SenderStat) => (s.dailyCap ? `${n(s.messagesSentToday)} / ${n(s.dailyCap)} today` : `${n(s.messagesSentToday)} today`)

  return (
    <QueueShell {...shell} view="senders" scrollKey={market} controls={options.length > 2 ? <Chips value={market} options={options} onChange={setMarket} label="Sender market" /> : undefined}>
      <div className="qx-list">
        {loading && items.length === 0 && fleet.length === 0 ? <Skeletons /> : (
          <>
            <KpiPanel
              kpis={[
                { label: 'Numbers', value: summary.fleetTotal },
                { label: 'Active', value: summary.active, tone: 'green' },
                { label: 'Blocked', value: summary.blocked, tone: summary.blocked > 0 ? 'red' : 'muted' },
              ]}
              footnote={`Sends across ${n(items.length)} queue rows · ${rangeLabel}`}
            />
            {list.length === 0 ? <Empty icon="phone" title="No sending numbers" sub="Nothing matches this filter." /> : list.map((s: SenderStat) => {
              const tone = STATE_TONE[s.state] ?? 'muted'
              const last = relative(s.lastUsed || s.registryLastUsedAt)
              return (
                <article
                  key={s.phone}
                  className={cls('qx-card', `tone-${tone}`)}
                  data-section-row
                  role="button"
                  tabIndex={0}
                  onClick={() => setOpen(s.phone)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(s.phone) } }}
                >
                  <div className="qx-card__top">
                    <strong className="qx-card__name">{s.friendlyName || shortMarket(s.market) || 'Sender'}</strong>
                    <span className={cls('qx-pill', `tone-${tone}`)}>{STATE_LABEL[s.state] ?? s.state}</span>
                  </div>
                  <p className="qx-card__phone is-mono">{formatPhone(s.phone)}</p>
                  <div className="qx-usage">
                    <span>{usage(s)}</span>
                    {s.dailyCap ? <Meter value={s.messagesSentToday} max={s.dailyCap} tone={s.messagesSentToday / s.dailyCap > 0.85 ? 'amber' : 'accent'} /> : null}
                  </div>
                  <div className="qx-card__foot">
                    <span className="qx-card__when">
                      <span className="qx-card__when-main">{s.sent > 0 ? `${n(s.sent)} sent · ${s.deliveryPct}% delivered` : 'No sends in range'}</span>
                      <span className="qx-card__when-sub">{last ? `Last used ${last}` : shortMarket(s.market)}</span>
                    </span>
                    {s.failed > 0 && <span className="qx-chip tone-red">{n(s.failed)} failed</span>}
                  </div>
                </article>
              )
            })}
          </>
        )}
      </div>

      {selected && (
        <QueueDispatchPicker
          title={formatPhone(selected.phone) ?? selected.phone}
          onClose={() => setOpen(null)}
          footer={selected.sent > 0 || selected.failed > 0 ? (
            <button type="button" className="qx-act is-primary" onClick={() => { setOpen(null); onViewRows(selected.phone) }}>
              View this number's rows
            </button>
          ) : undefined}
        >
          <div className="qx-tags">
            <span className={cls('qx-pill', `tone-${STATE_TONE[selected.state] ?? 'muted'}`)}>{STATE_LABEL[selected.state] ?? selected.state}</span>
            <span className={cls('qx-pill', `tone-${HEALTH_TONE[selected.health] ?? 'muted'}`)}>{HEALTH_LABEL[selected.health] ?? selected.health}</span>
            {!selected.registered && <span className="qx-pill tone-amber">Unregistered</span>}
          </div>
          <div className="qx-note tone-blue">
            <Icon name="phone" size={15} />
            <div><strong>{selected.friendlyName || shortMarket(selected.market)}</strong><p>{selected.operationalLabel}</p></div>
          </div>
          {selected.dailyCap ? (
            <section className="qx-block">
              <h3 className="qx-block__title">Today<em>{usage(selected)}</em></h3>
              <Meter value={selected.messagesSentToday} max={selected.dailyCap} tone="accent" />
            </section>
          ) : null}
          <section className="qx-block">
            <h3 className="qx-block__title">In range<em>{rangeLabel}</em></h3>
            <div className="qx-facts">
              <Fact k="Market" v={shortMarket(selected.market)} />
              <Fact k="Sent" v={n(selected.sent)} />
              <Fact k="Delivered" v={selected.sent > 0 ? `${n(selected.delivered)} · ${selected.deliveryPct}%` : '—'} tone="green" />
              <Fact k="Failed" v={selected.sent > 0 ? `${n(selected.failed)} · ${selected.failPct}%` : n(selected.failed)} tone={selected.failed > 0 ? 'red' : undefined} />
              {selected.optOuts > 0 && <Fact k="Opt-outs" v={n(selected.optOuts)} tone="red" />}
              {selected.violations21610 > 0 && <Fact k="21610" v={n(selected.violations21610)} tone="red" />}
              {selected.healthScore != null && <Fact k="Health score" v={String(Math.round(selected.healthScore * 100))} />}
              <Fact k="Last used" v={localWhen(selected.lastUsed || selected.registryLastUsedAt, null)} />
            </div>
          </section>
        </QueueDispatchPicker>
      )}
    </QueueShell>
  )
}
