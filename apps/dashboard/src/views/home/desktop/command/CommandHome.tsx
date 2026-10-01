import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Icon, type IconName } from '../../../../shared/icons'
import { loadSettings, subscribeSettings } from '../../../../shared/settings'
import { useNotificationIntelligence } from '../../../../domain/notifications/useNotificationIntelligence'
import { useOperatorName } from '../../../../shared/useOperatorName'
import { openInboxDealIntelligence, openInboxThread } from '../../../../modules/mobile/mobile-inbox-bridge'
import type { PipelineCommandCard } from '../../../../domain/pipeline/pipeline-command-api'
import { Counter } from '../../HomeCounter'
import { buildFocusItems, dataOf, formatCount, greetingFor, relativeTime, type FocusItem, type HomeLoad } from '../../home-signals'
import { resolveSystemState, useHomeSignals, type SourceKey } from '../../useHomeSignals'
import { goTo, openTarget } from '../../home-navigation'
import {
  FEED_LANES,
  activeMarketCount,
  groupActivity,
  heroTelemetry,
  money,
  moneyModel,
  resolveHomeMode,
  summarizeFocus,
  systemPulses,
  type FeedGroup,
  type FeedLane,
  type HomeMode,
  type MapLayerId,
  type SystemPulse,
} from './home-command-model'
import { HOME_RANGES, useHomeCommand, type HomeRange } from './useHomeCommand'
import { HomeHeatMap } from './HomeHeatMap'
import { AutomationRibbon, FlowChart, HeroWave, RateDial, StageFlow } from './HomeCharts'
import { ExternalIntelligence } from './ExternalIntelligence'
import './command-home.css'

/**
 * HOME · THE COMMAND CENTER (desktop).
 *
 * Opens on the machine, not on a grid of tiles. It answers, in reading order:
 * what is the machine doing (the header and the feed), what needs me (Focus),
 * where is it happening (the market field), what money is in motion, how the
 * systems are running, and what to open next — every row deep-links.
 *
 * The composition rebalances with the operation (`data-mode`): an incident
 * brings Focus up beside the header, a quiet night folds it away and gives the
 * map and the feed the room. Every figure is read from a live source; a source
 * that is loading or failed says so in place, and nothing is estimated to fill
 * a space.
 */

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

function useClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => { const t = window.setInterval(() => setNow(new Date()), 30_000); return () => window.clearInterval(t) }, [])
  return now
}

const readStill = () => {
  try {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return true
    return loadSettings().animationsEnabled === false
  } catch { return false }
}

const MODE_LINE: Record<HomeMode, string> = {
  incident: 'Incident mode',
  busy: 'High activity',
  normal: 'Running',
  quiet: 'Quiet',
}

/** What the desktop Home reads from the shared Home sources (markets, pins and the calendar are the phone's). */
const COMMAND_SOURCES: readonly SourceKey[] = ['inbox', 'queue', 'messaging', 'campaigns', 'pipeline', 'closings']

const LANE_ICON: Record<FeedLane, IconName> = { seller: 'message', campaign: 'send', orchestrator: 'cpu', closing: 'key' }

const APP_ICON: Record<string, IconName> = {
  Inbox: 'inbox', Queue: 'send', Campaigns: 'bolt', Pipeline: 'trending-up', Closings: 'key', 'Closing Desk': 'key', Calendar: 'calendar', Notifications: 'bell',
}

// ── Header ──────────────────────────────────────────────────────────────────

function CommandHero(props: {
  now: Date
  name: string
  system: { tone: string; label: string }
  mode: HomeMode
  markets: number | null
  replies: number | null
  needYou: number | null
  telemetry: ReturnType<typeof heroTelemetry>
  range: HomeRange
  onRange: (r: HomeRange) => void
  live: boolean
  onLive: (v: boolean) => void
  refreshing: boolean
  onRefresh: () => void
  clear: boolean
  wave: { series: import('../../../../domain/analytics/analytics-performance-api').AnalyticsPerformance['series']; label: string } | null
  still: boolean
}) {
  const { now, name, system, mode, markets, replies, needYou, telemetry } = props
  const first = name?.trim().split(/\s+/)[0] || null
  return (
    <header className="ch-hero" data-tone={system.tone}>
      <div className="ch-hero__aura" aria-hidden="true" />
      {props.wave ? <HeroWave series={props.wave.series} label={props.wave.label} still={props.still} /> : null}
      <div className="ch-hero__top">
        <p className="ch-hero__status">
          <span className={cls('ch-orb', `is-${system.tone}`)} aria-hidden="true" />
          <span>{system.label}</span>
          {mode !== 'normal' ? <><span className="ch-sep" aria-hidden="true" /><span className={cls('ch-mode', `is-${mode}`)}>{MODE_LINE[mode]}</span></> : null}
          <span className="ch-sep" aria-hidden="true" />
          <time dateTime={now.toISOString()}>{now.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })} · {now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>
        </p>
        <div className="ch-hero__controls">
          <div className="ch-seg" role="radiogroup" aria-label="Time range">
            {HOME_RANGES.map((r) => (
              <button key={r.key} type="button" role="radio" aria-checked={props.range === r.key} className={cls(props.range === r.key && 'is-on')} onClick={() => props.onRange(r.key)}>{r.label}</button>
            ))}
          </div>
          <button type="button" className={cls('ch-live', props.live && 'is-on')} aria-pressed={props.live} onClick={() => props.onLive(!props.live)} title={props.live ? 'Live: the machine feed refreshes every 20 seconds' : 'Paused: the feed refreshes every 90 seconds'}>
            <i aria-hidden="true" />{props.live ? 'Live' : 'Paused'}
          </button>
          <button type="button" className={cls('ch-icon-btn', props.refreshing && 'is-spinning')} aria-label="Refresh everything" title="Refresh everything" onClick={props.onRefresh}>
            <Icon name="refresh-cw" size={15} />
          </button>
        </div>
      </div>

      <h1 className="ch-hero__greeting">{greetingFor(now)}{first ? `, ${first}` : ''}.</h1>
      <p className="ch-hero__line">
        {markets ? <>LeadCommand is running across <b>{markets} market{markets === 1 ? '' : 's'}</b></> : <>LeadCommand is running</>}
        {replies != null ? <> — <b>{formatCount(replies)}</b> seller {replies === 1 ? 'reply' : 'replies'} today</> : null}
        {needYou != null ? (needYou ? <>, and <b className="is-need">{needYou} need{needYou === 1 ? 's' : ''} you</b>.</> : <>, and nothing needs you.</>) : '.'}
      </p>

      {telemetry.length ? (
        <div className="ch-telemetry" role="list" aria-label="Live telemetry">
          {telemetry.map((t) => (
            <button key={t.key} type="button" role="listitem" className={cls('ch-tel', t.tone && `is-${t.tone}`, t.key === 'value' && 'is-money')} onClick={() => goTo(t.path)} title={t.hint}>
              <b>{t.value == null ? '—' : t.display ?? <Counter value={t.value} />}</b>
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      ) : null}
      {props.clear ? <p className="ch-hero__clear"><Icon name="check" size={13} /> You’re clear — nothing is waiting on you.</p> : null}
      <span className="ch-hero__signal" aria-hidden="true" />
    </header>
  )
}

// ── Focus ───────────────────────────────────────────────────────────────────

function FocusDeck({ summary, loading, down, now }: { summary: ReturnType<typeof summarizeFocus>; loading: boolean; down: string[]; now: number }) {
  const tone = summary.critical ? 'critical' : summary.high ? 'high' : summary.total ? 'normal' : 'clear'
  return (
    <section className="ch-focus ch-glass is-raised" data-tone={tone} aria-label="Needs you">
      <span className="ch-focus__spine" aria-hidden="true" />
      <header className="ch-zone-head">
        <div className="ch-zone-title">
          <span className="ch-eyebrow">Focus</span>
          <h2>Needs you {summary.total ? <span className="ch-count">{summary.total}</span> : null}</h2>
        </div>
        {summary.critical ? <span className="ch-pill is-bad">{summary.critical} critical</span> : summary.high ? <span className="ch-pill is-warn">{summary.high} high</span> : null}
      </header>
      {summary.total ? (
        <div className="ch-focus__groups">
          {summary.groups.slice(0, 5).map((g) => (
            <div key={g.app} className={cls('ch-focus__group', `is-${g.tone}`)}>
              <p className="ch-focus__app"><Icon name={APP_ICON[g.app] ?? 'alert'} size={13} /> {g.app} <span>{g.items.length}</span></p>
              <ul>
                {g.items.slice(0, 3).map((f: FocusItem) => (
                  <li key={f.id}>
                    <button type="button" className={cls('ch-focus__row', `is-${f.tone}`)} onClick={() => openTarget(f.target)}>
                      <i aria-hidden="true" />
                      <span className="ch-focus__copy"><strong>{f.title}</strong><small>{f.detail}</small></span>
                      {f.at ? <em>{relativeTime(f.at, now)}</em> : null}
                    </button>
                  </li>
                ))}
                {g.items.length > 3 ? <li className="ch-muted ch-focus__more">+{g.items.length - 3} more in {g.app}</li> : null}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        <div className="ch-focus__clear">
          <span className="ch-focus__check" aria-hidden="true"><Icon name="check" size={18} /></span>
          <p>{loading ? 'Checking every source…' : down.length ? `Nothing open in what loaded — ${down.join(', ')} could not be checked.` : 'Nothing is waiting on you across Inbox, Queue, Campaigns, Pipeline and Closings.'}</p>
        </div>
      )}
    </section>
  )
}

// ── Machine feed ────────────────────────────────────────────────────────────

function openGroup(g: FeedGroup) {
  if (g.threadKey) { openInboxThread({ threadKey: g.threadKey }); return }
  if (g.link) goTo(g.link)
}

function MachineFeed({ load, live, now }: { load: HomeLoad<import('./home-command-model').StudioActivity>; live: boolean; now: number }) {
  const [lane, setLane] = useState<FeedLane | 'all'>('all')
  const data = load.status === 'ready' ? load.data : null
  const groups = useMemo(() => (data ? groupActivity(data.items) : []), [data])
  const shown = groups.filter((g) => lane === 'all' || g.lane === lane).slice(0, 18)
  // New moments since the last poll glow once as they arrive.
  const seen = useRef<Set<string> | null>(null)
  const fresh = useMemo(() => {
    const prev = seen.current
    const ids = new Set(groups.map((g) => g.id))
    seen.current = ids
    if (!prev) return new Set<string>()
    return new Set([...ids].filter((id) => !prev.has(id)))
  }, [groups])

  return (
    <section className="ch-feed ch-glass" aria-label="Machine feed">
      <header className="ch-zone-head">
        <div className="ch-zone-title">
          <span className="ch-eyebrow">The machine</span>
          <h2>Live activity</h2>
        </div>
        <span className={cls('ch-feed__pulse', live && 'is-live')} title="Moments in the last hour / last 24 hours">
          <i aria-hidden="true" />
          {data ? <>{formatCount(data.pulse.last_hour)} <small>/ hr</small> · {formatCount(data.pulse.last_24h)} <small>/ 24h</small></> : '—'}
        </span>
      </header>
      <div className="ch-feed__lanes" role="tablist" aria-label="Filter the feed">
        {FEED_LANES.map((l) => (
          <button key={l.key} type="button" role="tab" aria-selected={lane === l.key} className={cls('ch-chip is-small', lane === l.key && 'is-on')} onClick={() => setLane(l.key)}>{l.label}</button>
        ))}
      </div>
      {load.status === 'loading' ? <div className="ch-skel"><i /><i /><i /><i /></div> : null}
      {load.status === 'unavailable' ? <p className="ch-unavail"><Icon name="alert-circle" size={14} /> The machine feed couldn’t load · {load.reason}</p> : null}
      {data && !shown.length ? <p className="ch-muted ch-feed__empty">Nothing in the last 24 hours{lane === 'all' ? '' : ` for ${FEED_LANES.find((l) => l.key === lane)?.label.toLowerCase()}`}.</p> : null}
      {shown.length ? (
        <ol className="ch-stream">
          {shown.map((g) => {
            const clickable = Boolean(g.threadKey || g.link)
            return (
              <li key={g.id} className={cls('ch-moment', `is-${g.tone}`, fresh.has(g.id) && 'is-new')}>
                <span className="ch-moment__node" aria-hidden="true"><Icon name={LANE_ICON[g.lane]} size={12} /></span>
                <button type="button" className="ch-moment__body" onClick={() => openGroup(g)} disabled={!clickable}>
                  <span className="ch-moment__top">
                    <strong>{g.title}</strong>
                    <time dateTime={g.at}>{relativeTime(g.at, now)}</time>
                  </span>
                  <span className="ch-moment__who">{[g.subject.name, g.subject.address].filter(Boolean).join(' · ') || g.workflowName}</span>
                  {g.steps.length > 1 ? (
                    <span className="ch-moment__steps">
                      {[...g.steps].reverse().slice(-5).map((s) => <i key={s.id} className={`is-${s.tone}`} title={s.detail ? `${s.title} — ${s.detail}` : s.title}>{s.title}</i>)}
                    </span>
                  ) : g.steps[0]?.detail ? <span className="ch-moment__detail">{g.steps[0].detail}</span> : null}
                </button>
              </li>
            )
          })}
        </ol>
      ) : null}
      <footer className="ch-zone-foot">
        <span className="ch-muted">{data?.degraded.length ? `Partial: ${data.degraded.join(', ')} unavailable` : 'Seller automation · campaigns · workflows · closings'}</span>
        <button type="button" className="ch-link" onClick={() => goTo('/workflow-studio')}>Workflow Studio <Icon name="arrow-up-right" size={13} /></button>
      </footer>
    </section>
  )
}

// ── Money ───────────────────────────────────────────────────────────────────

function MoneyPanel({ overview, top }: { overview: HomeLoad<import('../../../../domain/pipeline/pipeline-command-api').PipelineCommandOverview>; top: HomeLoad<PipelineCommandCard[]> }) {
  const m = moneyModel(dataOf(overview))
  const ribbonTotal = m ? m.bands.reduce((n, b) => n + (b.value ?? 0), 0) : 0
  const byValue = ribbonTotal > 0
  const countTotal = m ? m.bands.reduce((n, b) => n + b.count, 0) : 0
  const topRows = dataOf(top) ?? []
  return (
    <section className="ch-money ch-glass" aria-label="Opportunity in motion">
      <header className="ch-zone-head">
        <div className="ch-zone-title">
          <span className="ch-eyebrow">Opportunity in motion</span>
          <h2>Pipeline value</h2>
        </div>
        <button type="button" className="ch-link" onClick={() => goTo('/pipeline')}>Pipeline <Icon name="arrow-up-right" size={13} /></button>
      </header>
      {overview.status === 'loading' ? <div className="ch-skel"><i /><i /></div> : null}
      {overview.status === 'unavailable' ? <p className="ch-unavail"><Icon name="alert-circle" size={14} /> Pipeline couldn’t load · {overview.reason}</p> : null}
      {m ? (
        <>
          <div className="ch-money__hero">
            <b className="ch-money__value">{m.value ? money(m.value) : '—'}</b>
            <span>estimated property value across live deals</span>
            <small>{m.valued} of {m.opportunities} deals carry a valuation</small>
          </div>
          <dl className="ch-money__facts">
            <div><dt>Seller asking</dt><dd>{money(m.asking)}</dd></div>
            <div><dt>Offers out</dt><dd>{formatCount(m.offersOut)}</dd></div>
            <div><dt>Moved today</dt><dd>{formatCount(m.movedToday)}</dd></div>
          </dl>
          {m.bands.length ? (
            <div className="ch-ribbon" aria-label={`By stage, by ${byValue ? 'value' : 'deal count'}`}>
              <div className="ch-ribbon__bar">
                {m.bands.map((b, i) => {
                  const share = byValue ? (b.value ?? 0) / ribbonTotal : b.count / Math.max(1, countTotal)
                  return share > 0 ? <i key={b.key} style={{ flexGrow: share, ['--band' as string]: BAND_COLORS[i % BAND_COLORS.length] }} title={`${b.label}: ${b.count} deals${b.value ? ` · ${money(b.value)}` : ''}`} /> : null
                })}
              </div>
              <ul className="ch-ribbon__legend">
                {m.bands.map((b, i) => <li key={b.key} style={{ ['--band' as string]: BAND_COLORS[i % BAND_COLORS.length] }}><i />{b.label} <b>{byValue ? money(b.value) : b.count}</b></li>)}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}
      {topRows.length ? (
        <div className="ch-money__top">
          <span className="ch-eyebrow">Largest live deals</span>
          <ol>
            {topRows.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => openInboxDealIntelligence({ propertyId: c.propertyId, threadKey: c.threadKey, masterOwnerId: c.masterOwnerId })} title="Open in Deal Intelligence">
                  <span className="ch-money__deal"><strong>{c.address || c.seller || 'Deal'}</strong><small>{[c.stageLabel, c.market].filter(Boolean).join(' · ')}</small></span>
                  <b>{money(c.money.value)}</b>
                  {c.money.asking ? <em>ask {money(c.money.asking)}</em> : c.money.offer ? <em>offer {money(c.money.offer)}</em> : <em />}
                </button>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  )
}

// ── Systems ─────────────────────────────────────────────────────────────────

/** Lifecycle palette for the stage ribbon: cool early, violet contract, gold closing. */
const BAND_COLORS = ['#5ac8fa', '#34d399', '#818cf8', '#a78bfa', '#22d3ee', '#fbbf24', '#94a3b8']

const PULSE_ICON: Record<string, IconName> = { inbox: 'inbox', pipeline: 'trending-up', campaigns: 'bolt', queue: 'send', automation: 'cpu', closings: 'key' }

function SystemRail({ pulses }: { pulses: SystemPulse[] }) {
  if (!pulses.length) return null
  return (
    <nav className="ch-systems" aria-label="Systems">
      {pulses.map((p, i) => (
        <button key={p.key} type="button" className={cls('ch-sys', `is-${p.tone}`)} style={{ ['--i' as string]: i }} onClick={() => goTo(p.path)}>
          <span className="ch-sys__head"><Icon name={PULSE_ICON[p.key] ?? 'activity'} size={14} /><b>{p.app}</b><i className="ch-sys__orb" aria-hidden="true" /></span>
          <span className="ch-sys__metrics">
            {p.metrics.map((m) => <span key={m.label} className={cls(m.tone && `is-${m.tone}`)}><b>{formatCount(m.value)}</b> {m.label}</span>)}
          </span>
        </button>
      ))}
    </nav>
  )
}

// ── Charts ──────────────────────────────────────────────────────────────────

function ChartsBand({ load, still, rangeLabel }: { load: HomeLoad<import('../../../../domain/analytics/analytics-performance-api').AnalyticsPerformance>; still: boolean; rangeLabel: string }) {
  const perf = dataOf(load)
  return (
    <section className="ch-charts ch-glass is-flat" aria-label="Performance">
      <header className="ch-zone-head">
        <div className="ch-zone-title">
          <span className="ch-eyebrow">Performance · {rangeLabel}</span>
          <h2>Messaging flow</h2>
        </div>
        <button type="button" className="ch-link" onClick={() => goTo('/analytics')}>Analytics <Icon name="arrow-up-right" size={13} /></button>
      </header>
      {load.status === 'loading' ? <div className="ch-skel is-chart"><i /><i /><i /></div> : null}
      {load.status === 'unavailable' ? <p className="ch-unavail"><Icon name="alert-circle" size={14} /> Performance couldn’t load · {load.reason}</p> : null}
      {perf ? (
        <div className="ch-charts__grid">
          <figure className="ch-chart is-flow"><FlowChart series={perf.series} bucket={perf.period.bucket} still={still} /></figure>
          <figure className="ch-chart is-rates">
            <figcaption>Health</figcaption>
            <RateDial label="delivery rate" rate={perf.rates.delivery_rate} />
            <RateDial label="reply rate" rate={perf.rates.reply_rate} />
          </figure>
          <figure className="ch-chart is-stages"><figcaption>Lifecycle</figcaption><StageFlow flow={perf.flow} /></figure>
          <figure className="ch-chart is-auto"><figcaption>Automation</figcaption><AutomationRibbon automation={perf.automation} /></figure>
        </div>
      ) : null}
    </section>
  )
}

// ── The page ────────────────────────────────────────────────────────────────

export function CommandHome() {
  const now = useClock()
  const name = useOperatorName()
  const { signals, refresh, refreshing } = useHomeSignals(COMMAND_SOURCES)
  const cmd = useHomeCommand()
  const { notifications } = useNotificationIntelligence()
  const still = useSyncExternalStore(subscribeSettings, readStill, () => false)
  const [layer, setLayer] = useState<MapLayerId>('replies')

  const inbox = dataOf(signals.inbox)
  const queue = dataOf(signals.queue)
  const focusItems = useMemo(() => buildFocusItems({
    inbox, queue, campaigns: dataOf(signals.campaigns), pipeline: dataOf(signals.pipeline),
    closings: dataOf(signals.closings), notifications, now: now.getTime(),
  }), [inbox, queue, signals.campaigns, signals.pipeline, signals.closings, notifications, now])
  const focus = useMemo(() => summarizeFocus(focusItems), [focusItems])
  const focusSources = [['Inbox', signals.inbox], ['Queue', signals.queue], ['Campaigns', signals.campaigns], ['Pipeline', signals.pipeline], ['Closings', signals.closings]] as const
  const focusDown = focusSources.filter(([, s]) => s.status === 'unavailable').map(([label]) => label)
  const focusLoading = focusSources.some(([, s]) => s.status === 'loading')
  const focusKnown = !focusLoading && !focusDown.length

  const system = resolveSystemState(signals)
  const activity = dataOf(cmd.activity)
  const mode = resolveHomeMode({ system: system.tone, critical: focus.critical, high: focus.high, lastHour: activity?.pulse.last_hour ?? null })
  const perf = dataOf(cmd.performance)
  const overview = dataOf(cmd.overview)
  const rangeLabel = cmd.range === 'today' ? 'Today' : cmd.range === '7d' ? 'Last 7 days' : 'Last 30 days'

  const telemetry = heroTelemetry({
    focus: focusKnown ? focus : null,
    inbox,
    messaging: dataOf(signals.messaging),
    queue,
    campaigns: dataOf(signals.campaigns),
    pipeline: dataOf(signals.pipeline),
    overview,
  })
  const pulses = systemPulses({ overview, campaigns: dataOf(signals.campaigns), queue, closings: dataOf(signals.closings), inbox, performance: perf })
  const quietClear = mode === 'quiet' && focusKnown && focus.total === 0

  return (
    <div className={cls('ch', still && 'is-still')} data-mode={mode}>
      <div className="ch-grid">
        <div className="ch-area-hero">
          <CommandHero
            now={now}
            name={name}
            system={system}
            mode={mode}
            markets={activeMarketCount(perf)}
            replies={dataOf(signals.messaging)?.replies ?? null}
            needYou={focusKnown ? focus.critical + focus.high : null}
            telemetry={telemetry}
            range={cmd.range}
            onRange={cmd.setRange}
            live={cmd.live}
            onLive={cmd.setLive}
            refreshing={refreshing}
            onRefresh={() => { void refresh(); cmd.refresh() }}
            clear={quietClear}
            wave={perf ? { series: perf.series, label: rangeLabel.toLowerCase() } : null}
            still={still}
          />
        </div>
        {quietClear ? null : (
          <div className="ch-area-focus">
            <FocusDeck summary={focus} loading={focusLoading} down={focusDown} now={now.getTime()} />
          </div>
        )}
        <div className="ch-area-map">
          <HomeHeatMap layer={layer} onLayer={setLayer} performance={cmd.performance} deals={cmd.deals} rangeLabel={rangeLabel} live={cmd.live} still={still} />
        </div>
        <div className="ch-area-feed">
          <MachineFeed load={cmd.activity} live={cmd.live} now={now.getTime()} />
        </div>
        <div className="ch-area-money">
          <MoneyPanel overview={cmd.overview} top={cmd.top} />
        </div>
        <div className="ch-area-charts">
          <ChartsBand load={cmd.performance} still={still} rangeLabel={rangeLabel} />
        </div>
        <div className="ch-area-systems">
          <SystemRail pulses={pulses} />
        </div>
        <ExternalIntelligence />
      </div>
    </div>
  )
}
