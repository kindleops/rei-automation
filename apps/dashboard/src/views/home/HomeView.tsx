import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { Icon } from '../../shared/icons'
import { loadSettings, subscribeSettings, updateSetting } from '../../shared/settings'
import { useNotificationIntelligence } from '../../domain/notifications/useNotificationIntelligence'
import { useAuth } from '../../components/auth/AuthProvider'
import { MobileSheet } from '../../modules/mobile/MobileSheet'
import { buildFocusItems, dataOf, formatCount, greetingFor, relativeTime } from './home-signals'
import { resolveSystemState, useHomeSignals, type HomeSignals } from './useHomeSignals'
import { HOME_MODULE_LABELS, useHomeLayout, type HomeModuleId } from './home-layout-store'
import { openSearch } from './home-navigation'
import { STILL_CLASS, useLiquidTouch, useScrollDepth } from './home-motion'
import { LiquidField } from './LiquidField'
import { buildActivity, type ActivityEntry } from './home-activity'
import { openTarget } from './home-navigation'
import {
  ActivityModule,
  AutomationModule,
  CalendarModule,
  CampaignsModule,
  DealsModule,
  FocusModule,
  InboxModule,
  MarketsModule,
  PipelineModule,
  QuickActionsModule,
} from './HomeModules'
import './home.css'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

/**
 * HOME — the mobile command surface.
 *
 * Answers four questions in the order an operator asks them: what matters right
 * now (Focus), what the machine is doing (Automation), where to go next (every
 * module deep-links into its app), and what is one tap away (Quick actions).
 *
 * It sits inside the standard mobile shell — the portable command bar above and
 * the app dock below — so it reads as the top layer of one operating system rather
 * than a separate dashboard application.
 */

// ── Operator name ───────────────────────────────────────────────────────────

const INTRO_KEY = 'nx.home-intro.v1'

/**
 * The opening: once per session, a line of light draws across the dark and
 * opens onto the field. Never on a return visit within the session, never with
 * motion off, and never in the way — it takes no input and lasts 1.6s.
 */
const shouldPlayIntro = () => {
  try {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false
    if (loadSettings().animationsEnabled === false) return false
    return window.sessionStorage.getItem(INTRO_KEY) !== '1'
  } catch {
    return false
  }
}

const readAnimationsOff = () => loadSettings().animationsEnabled === false

const readOperatorName = () => loadSettings().operatorName?.trim() ?? ''

function useOperatorName(): string {
  const configured = useSyncExternalStore(subscribeSettings, readOperatorName, () => '')
  const { user } = useAuth()
  if (configured) return configured.split(/\s+/)[0]
  const meta = (user?.user_metadata ?? {}) as Record<string, unknown>
  const fromProfile = [meta.first_name, meta.full_name, meta.name].find((v): v is string => typeof v === 'string' && v.trim() !== '')
  return fromProfile ? fromProfile.trim().split(/\s+/)[0] : ''
}

// ── Clock (minute resolution, for the greeting and relative times) ─────────

function useMinuteClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(id)
  }, [])
  return now
}

// ── Greeting ────────────────────────────────────────────────────────────────

function buildSummary(signals: HomeSignals, focusCritical: number): ReactNode[] {
  const inbox = dataOf(signals.inbox)
  const campaigns = dataOf(signals.campaigns)
  const closings = dataOf(signals.closings)
  const messaging = dataOf(signals.messaging)
  const queue = dataOf(signals.queue)

  const needs: ReactNode[] = []
  if (focusCritical > 0) needs.push(<span key="crit"><b>{focusCritical}</b> urgent</span>)
  if (inbox?.newReplies) needs.push(<span key="replies"><b>{formatCount(inbox.newReplies)}</b> {inbox.newReplies === 1 ? 'reply' : 'replies'} waiting</span>)
  if (campaigns?.attention.length) needs.push(<span key="camp"><b>{campaigns.attention.length}</b> campaign{campaigns.attention.length === 1 ? '' : 's'} flagged</span>)
  if (closings?.closingsThisWeek) needs.push(<span key="close"><b>{closings.closingsThisWeek}</b> closing this week</span>)
  if (needs.length > 0) return needs.slice(0, 3)

  const calm: ReactNode[] = []
  if (queue && queue.status === 'healthy' && queue.failedToday === 0) calm.push(<span key="ok">Everything operational</span>)
  if (messaging?.sendersActive) calm.push(<span key="send"><b>{messaging.sendersActive}</b> senders active</span>)
  if (queue?.sentToday) calm.push(<span key="sent"><b>{formatCount(queue.sentToday)}</b> sent today</span>)
  if (messaging?.replies) calm.push(<span key="rep"><b>{formatCount(messaging.replies)}</b> replies</span>)
  return calm.slice(0, 3)
}

/**
 * The business, breathing: the latest events running past under the greeting in
 * a slow continuous marquee. Duplicated once so the loop is seamless.
 */
const Ticker = ({ entries }: { entries: ActivityEntry[] }) => {
  if (entries.length === 0) return null
  const run = (copy: number) => entries.map((entry) => (
    <button
      key={`${copy}-${entry.id}`}
      type="button"
      className="nx-home-ticker__item"
      tabIndex={copy === 0 ? 0 : -1}
      aria-hidden={copy === 0 ? undefined : true}
      onClick={() => openTarget(entry.target)}
    >
      <span className={cls('nx-home-dot', entry.tone !== 'neutral' && `is-${entry.tone}`)} />
      {entry.title}
      <small>{relativeTime(entry.at)}</small>
    </button>
  ))
  return (
    <div className="nx-home-ticker" aria-label="Latest activity">
      <div className="nx-home-ticker__track" style={{ '--n': entries.length } as CSSProperties}>
        {run(0)}
        {run(1)}
      </div>
    </div>
  )
}

const Greeting = ({
  now,
  name,
  signals,
  focusCritical,
  onCustomize,
  heroRef,
  ticker,
}: {
  now: Date
  name: string
  signals: HomeSignals
  focusCritical: number
  onCustomize: () => void
  heroRef: RefObject<HTMLElement>
  ticker: ActivityEntry[]
}) => {
  const system = resolveSystemState(signals)
  const summary = buildSummary(signals, focusCritical)
  const dateLabel = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
  return (
    <header className="nx-home-hello" ref={heroRef}>
      <div className="nx-home-hello__top">
        <span className="nx-home-pill" role="status">
          <span className={cls('nx-home-dot', system.tone !== 'unknown' && `is-${system.tone}`, system.tone !== 'unknown' && 'is-live')} aria-hidden />
          {system.label}
        </span>
        <div className="nx-home-hello__actions">
          <button type="button" className="nx-home-icon-btn" aria-label="Search sellers and properties" onClick={openSearch}>
            <Icon name="search" size={15} />
          </button>
          <button type="button" className="nx-home-icon-btn" aria-label="Customize Home" onClick={onCustomize}>
            <Icon name="grid" size={15} />
          </button>
        </div>
      </div>
      <span className="nx-home-hello__date">{dateLabel}</span>
      {/* Word by word, out of a soft focus. */}
      <h1 className="nx-home-hello__title" aria-label={`${greetingFor(now)}${name ? `, ${name}` : ''}`}>
        {/* Spaces sit between the spans: an inline-block swallows its own trailing space. */}
        {greetingFor(now).split(' ').map((word, i, words) => (
          <Fragment key={word}>
            {i > 0 ? ' ' : null}
            <span className="nx-home-word" style={{ '--w': i } as CSSProperties} aria-hidden>
              {word}{i === words.length - 1 && name ? ',' : ''}
            </span>
          </Fragment>
        ))}
        {name ? <>{' '}<em className="nx-home-word" style={{ '--w': 2 } as CSSProperties} aria-hidden>{name}</em></> : null}
      </h1>
      {summary.length > 0 ? <p className="nx-home-hello__summary">{summary}</p> : null}
      <Ticker entries={ticker} />
    </header>
  )
}

/**
 * The greeting, condensed. Fades in as the large title lifts away so the status
 * and the two header actions are never more than a glance from the thumb.
 */
const CondensedBar = ({ now, name, signals, focusCount, onCustomize }: {
  now: Date
  name: string
  signals: HomeSignals
  focusCount: number
  onCustomize: () => void
}) => {
  const system = resolveSystemState(signals)
  return (
    <div className="nx-home-condensed" aria-hidden>
      <span className={cls('nx-home-dot', system.tone !== 'unknown' && `is-${system.tone}`, system.tone !== 'unknown' && 'is-live')} />
      <strong>{greetingFor(now)}{name ? `, ${name}` : ''}</strong>
      {focusCount > 0 ? <span className="nx-home-count">{focusCount}</span> : null}
      <span className="nx-home-condensed__actions">
        <button type="button" tabIndex={-1} className="nx-home-icon-btn is-sm" onClick={openSearch}><Icon name="search" size={14} /></button>
        <button type="button" tabIndex={-1} className="nx-home-icon-btn is-sm" onClick={onCustomize}><Icon name="grid" size={14} /></button>
      </span>
    </div>
  )
}

// ── Customize sheet ─────────────────────────────────────────────────────────

const CustomizeSheet = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const { layout, move, toggleHidden, toggleCompact, reset } = useHomeLayout()
  const [name, setName] = useState(() => loadSettings().operatorName ?? '')

  return (
    <MobileSheet open={open} title="Customize Home" subtitle="Order, show and size your modules" height="full" onClose={onClose}>
      <div className="nx-home-customize">
        <label className="nx-home-customize__name">
          Your name
          <input
            value={name}
            placeholder="Used in your greeting"
            autoComplete="given-name"
            onChange={(event) => setName(event.target.value)}
            onBlur={() => updateSetting('operatorName', name.trim())}
          />
        </label>
        {layout.order.map((id, i) => {
          const hidden = layout.hidden.includes(id)
          const compact = layout.compact.includes(id)
          const meta = HOME_MODULE_LABELS[id]
          return (
            <div key={id} className={cls('nx-home-customize__row', hidden && 'is-hidden')}>
              <span>
                <strong>{meta.title}</strong>
                <small>{meta.hint}</small>
              </span>
              <span className="nx-home-customize__controls">
                <button type="button" aria-label={`Move ${meta.title} up`} disabled={i === 0} onClick={() => move(id, -1)}>
                  <Icon name="chevron-up" size={15} />
                </button>
                <button type="button" aria-label={`Move ${meta.title} down`} disabled={i === layout.order.length - 1} onClick={() => move(id, 1)}>
                  <Icon name="chevron-down" size={15} />
                </button>
                <button
                  type="button"
                  className={cls(compact && 'is-on')}
                  aria-pressed={compact}
                  aria-label={`${meta.title} compact`}
                  disabled={hidden}
                  onClick={() => toggleCompact(id)}
                >
                  <Icon name="list" size={15} />
                </button>
                <button
                  type="button"
                  role="switch"
                  className={cls(!hidden && 'is-on')}
                  aria-checked={!hidden}
                  aria-label={`${meta.title} visible`}
                  onClick={() => toggleHidden(id)}
                >
                  <Icon name={hidden ? 'slash' : 'eye'} size={15} />
                </button>
              </span>
            </div>
          )
        })}
        <button type="button" className="nx-home-customize__reset" onClick={reset}>Restore default layout</button>
      </div>
    </MobileSheet>
  )
}

// ── Screen ──────────────────────────────────────────────────────────────────

export const HomeView = () => {
  const now = useMinuteClock()
  const name = useOperatorName()
  const { signals, refresh, refreshing } = useHomeSignals()
  const { notifications, loading: notificationsLoading, lastFetchedAt } = useNotificationIntelligence()
  const { layout } = useHomeLayout()
  const [customizing, setCustomizing] = useState(false)
  const [intro, setIntro] = useState(shouldPlayIntro)
  const still = useSyncExternalStore(subscribeSettings, readAnimationsOff, () => false)

  const rootRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const ambientRef = useRef<HTMLDivElement>(null)
  const heroRef = useRef<HTMLElement>(null)
  useLiquidTouch(rootRef)
  useEffect(() => {
    if (!intro) return
    try { window.sessionStorage.setItem(INTRO_KEY, '1') } catch { /* storage blocked: it simply plays again */ }
    const id = window.setTimeout(() => setIntro(false), 1700)
    return () => window.clearTimeout(id)
  }, [intro])
  useScrollDepth(scrollRef, rootRef, ambientRef, heroRef)

  const focusItems = useMemo(() => buildFocusItems({
    inbox: dataOf(signals.inbox),
    queue: dataOf(signals.queue),
    campaigns: dataOf(signals.campaigns),
    pipeline: dataOf(signals.pipeline),
    closings: dataOf(signals.closings),
    notifications,
    now: now.getTime(),
  }), [notifications, now, signals])

  const ticker = useMemo(() => buildActivity(notifications, dataOf(signals.inbox), 8), [notifications, signals.inbox])

  const sources = [signals.inbox, signals.queue, signals.campaigns, signals.pipeline, signals.closings]
  const focusSettled = sources.every((source) => source.status !== 'loading')
  const focusAnyAvailable = sources.some((source) => source.status === 'ready') || lastFetchedAt !== null
  const focusCritical = focusItems.filter((item) => item.tone === 'critical').length
  const notificationsReady = !notificationsLoading || lastFetchedAt !== null

  const lastUpdated = Math.max(0, ...Object.values(signals).map((load) => (load.status === 'ready' ? load.at : 0)))

  const visible = layout.order.filter((id) => !layout.hidden.includes(id))

  const renderModule = (id: HomeModuleId, index: number) => {
    const compact = layout.compact.includes(id)
    const props = { index: index + 1, compact, signals }
    switch (id) {
      case 'focus':
        return <FocusModule key={id} index={index + 1} compact={compact} items={focusItems} settled={focusSettled} anyAvailable={focusAnyAvailable} />
      case 'actions': return <QuickActionsModule key={id} {...props} />
      case 'automation': return <AutomationModule key={id} {...props} />
      case 'inbox': return <InboxModule key={id} {...props} />
      case 'pipeline': return <PipelineModule key={id} {...props} />
      case 'campaigns': return <CampaignsModule key={id} {...props} />
      case 'deals': return <DealsModule key={id} {...props} />
      case 'markets': return <MarketsModule key={id} {...props} />
      case 'calendar': return <CalendarModule key={id} {...props} clock={now} />
      case 'activity':
        return <ActivityModule key={id} {...props} notifications={notifications} notificationsReady={notificationsReady} />
    }
  }

  return (
    <div className={cls('nx-home', still && STILL_CLASS, intro && 'is-intro')} ref={rootRef}>
      {/*
        The liquid field: slow masses of the accent colour, drifting at different
        speeds under the glass, with an aurora turning beneath them. Everything
        here moves by transform alone, so the compositor carries it.
      */}
      <div className="nx-home__ambient" aria-hidden>
        <div className="nx-home__field" ref={ambientRef}>
          <span className="nx-home__aurora" />
          <span className="nx-home__blob nx-home__blob--a" />
          <span className="nx-home__blob nx-home__blob--b" />
          <span className="nx-home__blob nx-home__blob--c" />
          <span className="nx-home__blob nx-home__blob--d" />
          <span className="nx-home__blob nx-home__blob--e" />
        </div>
        <span className="nx-home__caustics" />
        <LiquidField scroller={scrollRef} touchRoot={rootRef} />
        <span className="nx-home__grain" />
        <span className="nx-home__vignette" />
      </div>

      <div className="nx-home__scroll" ref={scrollRef}>
        <div className="nx-home__column">
          <CondensedBar
            now={now}
            name={name}
            signals={signals}
            focusCount={focusItems.length}
            onCustomize={() => setCustomizing(true)}
          />
          <Greeting
            heroRef={heroRef}
            ticker={ticker}
            now={now}
            name={name}
            signals={signals}
            focusCritical={focusCritical}
            onCustomize={() => setCustomizing(true)}
          />

          <div className="nx-home__grid">
            {visible.map(renderModule)}
          </div>

          {visible.length === 0 ? (
            <div className="nx-home-state">
              <Icon name="grid" size={16} />
              <span><strong>Every module is hidden</strong>Customize Home to bring them back.</span>
            </div>
          ) : null}

          <footer className="nx-home-footer">
            <button type="button" onClick={() => void refresh()} disabled={refreshing}>
              <Icon name="refresh-cw" size={13} />
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
            {lastUpdated > 0 ? <span>Live · updated {new Date(lastUpdated).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span> : null}
          </footer>
        </div>
      </div>

      <span className="nx-home__film" aria-hidden />
      {intro ? (
        <div className="nx-home-intro" aria-hidden>
          <span className="nx-home-intro__line" />
          <span className="nx-home-intro__flare" />
        </div>
      ) : null}
      <span className="nx-home__scrim nx-home__scrim--top" aria-hidden />
      <span className="nx-home__scrim nx-home__scrim--bottom" aria-hidden />

      <CustomizeSheet open={customizing} onClose={() => setCustomizing(false)} />
    </div>
  )
}
