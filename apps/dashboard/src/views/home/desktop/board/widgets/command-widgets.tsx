import { useMemo, useSyncExternalStore } from 'react'
import { Icon, type IconName } from '../../../../../shared/icons'
import { loadSettings, subscribeSettings } from '../../../../../shared/settings'
import { LCStatus } from '../../../../../shared/lc'
import { useNotificationIntelligence } from '../../../../../domain/notifications/useNotificationIntelligence'
import { useOperatorName } from '../../../../../shared/useOperatorName'
import { openInboxThread } from '../../../../../modules/mobile/mobile-inbox-bridge'
import { buildFocusItems, greetingFor, relativeTime, type FocusItem, type HomeLoad } from '../../../home-signals'
import { resolveSystemState, type HomeSignals } from '../../../useHomeSignals'
import { activeMarketCount, FEED_LANES, groupActivity, heroTelemetry, summarizeFocus, type FeedGroup, type FeedLane } from '../../command/home-command-model'
import { HeroWave } from '../../command/HomeCharts'
import { evaluatorState, SEVERITY_LABEL } from '../../../../../modules/notifications/signals/signals-model'
import { retryStories, useStoryStore } from '../../../../../modules/notifications/plane/story-store'
import { visibleOrder, type Story } from '../../../../../modules/notifications/plane/story-model'
import { homeMetricsSource, SOURCES } from '../board-data'
import { cx, fmt, openPath, useNow, useWidgetSource } from '../widget-runtime'
import { WEmpty, WFigure, WState } from '../widget-ui'
import type { WidgetRenderProps } from '../widget-registry'

/* ── shared: the canonical "needs you" model (the same one Home always used) ── */

const ready = <T,>(l: HomeLoad<T>): T | null => (l.status === 'ready' ? l.data : null)

/**
 * Focus = operator-required items from Inbox, Queue, Campaigns, Pipeline,
 * Closings and the notification stream, deduplicated and ranked by the one
 * Home model (buildFocusItems). Every source is a shared read: the Brief and
 * Focus widgets together make one request per source.
 */
const STORY_APP: Record<string, { app: string; icon: IconName }> = {
  seller: { app: 'Inbox', icon: 'message' }, campaign: { app: 'Campaigns', icon: 'bolt' }, closing: { app: 'Closings', icon: 'key' },
  workflow: { app: 'Workflows', icon: 'layers' }, deal: { app: 'Pipeline', icon: 'trending-up' }, property: { app: 'Pipeline', icon: 'home' },
}
const STORY_TONE: Record<Story['priority'], FocusItem['tone']> = { critical: 'critical', action: 'high', important: 'opportunity', info: 'normal' }
const BAND: Record<FocusItem['tone'], number> = { critical: 4000, high: 3000, opportunity: 2000, normal: 1000 }

/** A Notification Center 2.0 story that needs the operator, as a Focus row (its canonical deep link). */
function storyItem(st: Story, now: number): FocusItem {
  const where = STORY_APP[st.subject.type] ?? { app: 'System', icon: 'cpu' as IconName }
  const tone = STORY_TONE[st.priority]
  const age = Math.max(0, now - Date.parse(st.updated_at))
  return {
    id: `story:${st.id}`,
    tone,
    icon: where.icon,
    app: where.app,
    title: st.title,
    // the story title usually names its subject already; never say it twice
    detail: [st.subject.label && !st.title.includes(st.subject.label) ? st.subject.label : null, st.reason ?? st.summary ?? st.state.label].filter(Boolean).join(' · '),
    at: st.updated_at,
    target: { kind: 'route', path: st.deep_link || '/notifications' },
    weight: BAND[tone] + Math.max(0, 999 - Math.round(age / 180_000)),
  }
}

/**
 * Focus = what needs the operator, from the canonical sources without
 * duplication:
 *   1. Notification Center 2.0 stories in the NEEDS YOU lens (already folded:
 *      one seller event is one story) — read from the shell's one story store,
 *      no extra request;
 *   2. the operational state stories do not carry (queue health, campaigns
 *      needing attention, pipeline blocks, closings needing action), from the
 *      one Home focus model (buildFocusItems);
 *   3. waiting seller replies — minus any thread a story already covers.
 * The legacy notification stream is only used when the story store is down.
 * Every source is a shared read: Brief + Focus make one request per source.
 */
function useFocusModel() {
  const inbox = useWidgetSource(SOURCES.inbox)
  const queue = useWidgetSource(SOURCES.queue)
  const campaigns = useWidgetSource(SOURCES.campaigns)
  const pipeline = useWidgetSource(SOURCES.pipeline)
  const closings = useWidgetSource(SOURCES.closings)
  const stories = useStoryStore()
  const { notifications } = useNotificationIntelligence()
  const now = useNow()
  const inboxD = ready(inbox.load), queueD = ready(queue.load), campD = ready(campaigns.load), pipeD = ready(pipeline.load), closeD = ready(closings.load)
  const storiesUp = stories.status === 'ready'
  const needStories = useMemo(() => (storiesUp ? visibleOrder([...stories.stories.values()], 'needs_you', null, new Set()) : []), [storiesUp, stories.stories])
  const items = useMemo(() => {
    const covered = new Set(needStories.map((st) => st.subject.thread_key).filter((k): k is string => Boolean(k)))
    const ops = buildFocusItems({ inbox: inboxD, queue: queueD, campaigns: campD?.summary ?? null, pipeline: pipeD, closings: closeD, notifications: storiesUp ? [] : notifications, now })
      .filter((f) => !(f.target.kind === 'thread' && f.target.thread.threadKey && covered.has(f.target.thread.threadKey)))
    return [...needStories.map((st) => storyItem(st, now)), ...ops]
  }, [needStories, inboxD, queueD, campD, pipeD, closeD, storiesUp, notifications, now])
  const summary = useMemo(() => summarizeFocus(items), [items])
  const sources = [['Inbox', inbox], ['Queue', queue], ['Campaigns', campaigns], ['Pipeline', pipeline], ['Closings', closings]] as const
  const down = [...sources.filter(([, s]) => s.load.status === 'unavailable').map(([n]) => n), ...(stories.status === 'error' ? ['Notifications'] : [])]
  const loading = sources.some(([, s]) => s.load.status === 'loading') || stories.status === 'loading' || stories.status === 'idle'
  const retry = () => { sources.forEach(([, s]) => { if (s.load.status === 'unavailable') s.reload() }); if (stories.status === 'error') retryStories() }
  return { summary, items, down, loading, known: !loading && !down.length, now, retry, queueLoad: queue.load, queue: queueD, inbox: inboxD, campaigns: campD, pipeline: pipeD }
}

/* ── Home Brief ─────────────────────────────────────────────────────── */

const readStill = () => {
  try {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return true
    return loadSettings().animationsEnabled === false
  } catch { return false }
}

export function BriefWidget({ size }: WidgetRenderProps) {
  const name = useOperatorName()
  const focus = useFocusModel()
  const messaging = useWidgetSource(SOURCES.messaging)
  const big = size === 'wide' || size === 'feature' || size === 'large'
  const perf = useWidgetSource(big || size === 'medium' ? homeMetricsSource('7d', null, true) : null)
  const overview = useWidgetSource(big ? SOURCES.pipelineOverview : null)
  const still = useSyncExternalStore(subscribeSettings, readStill, () => false)
  const now = new Date(focus.now)
  const first = name?.trim().split(/\s+/)[0] || null
  const queue = focus.queue
  // resolveSystemState reads only the queue source
  const system = resolveSystemState({ queue: focus.queueLoad } as unknown as HomeSignals)
  const needYou = focus.known ? focus.summary.critical + focus.summary.high : null
  const replies = ready(messaging.load)?.replies ?? null
  const perfD = ready(perf.load)
  const markets = activeMarketCount(perfD)
  const telemetry = big ? heroTelemetry({ focus: focus.known ? focus.summary : null, inbox: focus.inbox, messaging: ready(messaging.load), queue, campaigns: focus.campaigns?.summary ?? null, pipeline: focus.pipeline, overview: ready(overview.load) }).slice(0, size === 'feature' ? 8 : 5) : []

  return (
    <div className={cx('hb-brief', `is-${size}`)} data-tone={system.tone}>
      {size === 'feature' && perfD ? <div className="hb-brief__wave" aria-hidden="true"><HeroWave series={perfD.series} label="last 7 days" still={still} /></div> : null}
      <p className="hb-brief__status">
        <span className={cx('hb-orb', `is-${system.tone}`)} aria-hidden="true" />
        <span>{system.label}</span>
        <span className="hb-sep" aria-hidden="true" />
        <time dateTime={now.toISOString()}>{now.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}</time>
      </p>
      <h2 className="hb-brief__greeting">{greetingFor(now)}{first ? `, ${first}` : ''}.</h2>
      {size === 'compact' || size === 'small' ? (
        <p className="hb-brief__line">
          {needYou === null ? 'Checking what needs you…' : needYou ? <><b className="is-need">{needYou}</b> need{needYou === 1 ? 's' : ''} you.</> : 'Nothing needs you.'}
        </p>
      ) : (
        <p className="hb-brief__line">
          {markets ? <>LeadCommand is running across <b>{markets} market{markets === 1 ? '' : 's'}</b></> : <>LeadCommand is running</>}
          {replies != null ? <> — <b>{fmt(replies)}</b> seller {replies === 1 ? 'reply' : 'replies'} today</> : null}
          {needYou != null ? (needYou ? <>, and <b className="is-need">{needYou} need{needYou === 1 ? 's' : ''} you</b>.</> : <>, and nothing needs you.</>) : '.'}
        </p>
      )}
      {telemetry.length ? (
        <div className="hb-tele" role="list" aria-label="Live telemetry">
          {telemetry.map((t) => (
            <button key={t.key} type="button" role="listitem" className={cx('hb-tele__i', t.tone && `is-${t.tone}`)} onClick={() => openPath(t.path)} title={t.hint}>
              <b>{t.value == null ? '—' : t.display ?? fmt(t.value)}</b>
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      ) : null}
      {focus.down.length && size !== 'compact' ? <p className="hb-brief__note">Partial: {focus.down.join(', ')} unavailable</p> : null}
    </div>
  )
}

/* ── Focus / Needs you ──────────────────────────────────────────────── */

const APP_ICON: Record<string, IconName> = {
  Inbox: 'inbox', Queue: 'send', Campaigns: 'bolt', Pipeline: 'trending-up', Closings: 'key', 'Closing Desk': 'key', Closing: 'key', Calendar: 'calendar', Notifications: 'bell', Map: 'map', Workflows: 'layers', System: 'cpu', Analytics: 'stats',
}

function FocusRow({ f, now }: { f: FocusItem; now: number }) {
  return (
    <li>
      <button type="button" className={cx('hb-focus__row', `is-${f.tone}`)} onClick={() => (f.target.kind === 'thread' ? openInboxThread({ threadKey: f.target.thread.threadKey ?? f.target.thread.id }) : openPath(f.target.path))}>
        <i aria-hidden="true" />
        <span className="hb-focus__copy"><strong>{f.title}</strong><small>{f.detail}</small></span>
        {f.at ? <em>{relativeTime(f.at, now)}</em> : null}
      </button>
    </li>
  )
}

export function FocusWidget({ size }: WidgetRenderProps) {
  const m = useFocusModel()
  const s = m.summary
  const tone = s.critical ? 'critical' : s.high ? 'high' : s.total ? 'normal' : 'clear'
  if (m.loading && !s.total) return <div className="hb-focus"><WState load={{ status: 'loading' }} what="what needs you" onRetry={m.retry}>{() => null}</WState></div>
  if (!s.total) {
    return (
      <div className="hb-focus is-clear">
        <span className="hb-focus__check" aria-hidden="true"><Icon name="check" size={size === 'compact' ? 14 : 18} /></span>
        <p>{m.down.length ? `Nothing open in what loaded — ${m.down.join(', ')} could not be checked.` : 'Nothing is waiting on you.'}</p>
        {m.down.length ? <button type="button" className="hb-link" onClick={m.retry}>Retry</button> : null}
      </div>
    )
  }
  if (size === 'compact' || size === 'small') {
    const top = s.groups[0]?.items[0]
    return (
      <div className={cx('hb-focus', `is-${tone}`)}>
        <WFigure value={s.total} label={`need${s.total === 1 ? 's' : ''} you`} tone={s.critical ? 'crit' : s.high ? 'attn' : null} sub={s.critical ? `${s.critical} critical` : s.high ? `${s.high} high` : null} />
        {size === 'small' && top ? <ul className="hb-focus__list"><FocusRow f={top} now={m.now} /></ul> : null}
      </div>
    )
  }
  const wide = size === 'large' || size === 'feature' || size === 'wide'
  const perGroup = size === 'tall' || size === 'large' || size === 'feature' ? 3 : 2
  return (
    <div className={cx('hb-focus', `is-${tone}`, wide && 'is-cols')}>
      <div className="hb-focus__head">
        <b>{s.total}</b><span>open</span>
        {s.critical ? <LCStatus state="blocked" label={`${s.critical} critical`} tone="crit" quiet /> : s.high ? <LCStatus state="needs_you" label={`${s.high} high`} tone="attn" quiet /> : null}
      </div>
      <div className="hb-focus__groups">
        {s.groups.slice(0, wide ? 6 : 4).map((g) => (
          <section key={g.app} className={cx('hb-focus__group', `is-${g.tone}`)} aria-label={g.app}>
            <p className="hb-focus__app"><Icon name={APP_ICON[g.app] ?? 'alert'} size={12} /> {g.app} <span>{g.items.length}</span></p>
            <ul className="hb-focus__list">
              {g.items.slice(0, perGroup).map((f) => <FocusRow key={f.id} f={f} now={m.now} />)}
            </ul>
            {g.items.length > perGroup ? <p className="hb-muted hb-focus__more">+{g.items.length - perGroup} more</p> : null}
          </section>
        ))}
      </div>
      {m.down.length ? <p className="hb-muted hb-focus__note">Partial: {m.down.join(', ')} unavailable</p> : null}
    </div>
  )
}

/* ── Machine Feed ───────────────────────────────────────────────────── */

const LANE_ICON: Record<FeedLane, IconName> = { seller: 'message', campaign: 'send', orchestrator: 'cpu', closing: 'key' }

function openGroup(g: FeedGroup) {
  if (g.threadKey) { openInboxThread({ threadKey: g.threadKey }); return }
  if (g.link) openPath(g.link)
}

export function MachineFeedWidget({ size, config, setConfig }: WidgetRenderProps<{ lane: string; count: string }>) {
  const { load, reload } = useWidgetSource(SOURCES.activity)
  const lane = (config.lane || 'all') as FeedLane | 'all'
  const limit = Number(config.count) || 8
  const data = load.status === 'ready' ? load.data : null
  const groups = useMemo(() => (data ? groupActivity(data.items) : []), [data])
  const shown = groups.filter((g) => lane === 'all' || g.lane === lane).slice(0, size === 'compact' ? 0 : size === 'small' ? 3 : limit)
  const now = useNow(30_000)
  return (
    <div className={cx('hb-feed', `is-${size}`)}>
      <div className="hb-feed__pulse">
        <i aria-hidden="true" className={cx(data && data.pulse.last_hour > 0 && 'is-live')} />
        {data ? <><b>{fmt(data.pulse.last_hour)}</b><span>/ hr</span><b>{fmt(data.pulse.last_24h)}</b><span>/ 24h</span></> : <span>—</span>}
      </div>
      {size !== 'compact' && size !== 'small' ? (
        <div className="hb-feed__lanes" role="radiogroup" aria-label="Lane">
          {FEED_LANES.map((l) => (
            <button key={l.key} type="button" role="radio" aria-checked={lane === l.key} className={cx('hb-chip', lane === l.key && 'is-on')} onClick={() => setConfig({ lane: l.key })}>{l.label}</button>
          ))}
        </div>
      ) : null}
      <WState load={load} what="the machine feed" onRetry={reload}>
        {() => (size === 'compact' ? null : shown.length ? (
          <ol className="hb-stream">
            {shown.map((g) => (
              <li key={g.id} className={cx('hb-moment', `is-${g.tone}`)}>
                <span className="hb-moment__node" aria-hidden="true"><Icon name={LANE_ICON[g.lane]} size={11} /></span>
                <button type="button" className="hb-moment__body" onClick={() => openGroup(g)} disabled={!g.threadKey && !g.link}>
                  <span className="hb-moment__top"><strong>{g.title}</strong><time dateTime={g.at}>{relativeTime(g.at, now)}</time></span>
                  <span className="hb-moment__who">{[g.subject.name, g.subject.address].filter(Boolean).join(' · ') || g.workflowName}</span>
                </button>
              </li>
            ))}
          </ol>
        ) : <WEmpty icon="clock">Nothing in the last 24 hours{lane === 'all' ? '' : ' in this lane'}.</WEmpty>)}
      </WState>
    </div>
  )
}

/* ── Signal Center ──────────────────────────────────────────────────── */

export function SignalsWidget({ size }: WidgetRenderProps) {
  const { load, reload } = useWidgetSource(SOURCES.signals)
  return (
    <WState load={load} what="signals" onRetry={reload} shape="metric">
      {(m) => {
        const state = evaluatorState(m)
        const open = m.signals.filter((x) => x.status !== 'resolved')
        return (
          <div className={cx('hb-signals', `is-${size}`)}>
            <div className="hb-signals__state">
              <LCStatus state={state.tone === 'exec' ? 'running' : 'inactive'} label={state.label} tone={state.tone} quiet />
            </div>
            <div className="hb-row">
              <WFigure value={fmt(m.counts.open)} label="open" tone={m.counts.open ? 'attn' : null} />
              {size !== 'compact' ? <WFigure value={fmt(m.counts.fired_24h)} label="fired · 24h" /> : null}
              {size !== 'compact' && size !== 'small' ? <WFigure value={fmt(m.counts.armed_rules)} label="rules armed" /> : null}
            </div>
            {size === 'compact' || size === 'small' ? null : open.length ? (
              <ul className="hb-list">
                {open.slice(0, size === 'medium' ? 3 : 6).map((x) => (
                  <li key={x.id}>
                    <button type="button" className="hb-list__row" onClick={() => openPath(x.deep_link || '/notifications')} disabled={!x.deep_link}>
                      <span className={cx('hb-dot', x.severity === 'critical' ? 'is-crit' : x.severity === 'info' ? '' : 'is-attn')} aria-hidden="true" />
                      <span className="hb-list__main"><strong>{x.title}</strong><small>{SEVERITY_LABEL[x.severity]}</small></span>
                      <em>{relativeTime(x.fired_at)}</em>
                    </button>
                  </li>
                ))}
              </ul>
            ) : <WEmpty>{state.detail}</WEmpty>}
          </div>
        )
      }}
    </WState>
  )
}
