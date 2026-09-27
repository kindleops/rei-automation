import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Icon, type IconName } from '../../shared/icons'
import type { NotificationEvent } from '../../domain/notifications/notification-contract'
import {
  dataOf,
  formatCount,
  initials,
  relativeTime,
  type FocusItem,
  type HomeLoad,
  type PipelineBucket,
} from './home-signals'
import { resolveSystemState, type HomeSignals } from './useHomeSignals'
import { buildActivity } from './home-activity'
import { Counter } from './HomeCounter'
import { useRevealed } from './home-motion'
import { MarketConstellation } from './MarketConstellation'
import { goTo, openNotifications, openSearch, openTarget, openThread } from './home-navigation'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

interface ModuleProps {
  index: number
  compact: boolean
  signals: HomeSignals
}

// ── Module chrome ───────────────────────────────────────────────────────────

interface ModuleCardProps {
  title: string
  index: number
  compact?: boolean
  /** `tile` is a glass pane; `bare` floats directly over the liquid field. */
  variant?: 'tile' | 'bare'
  span?: 'full' | 'half'
  tall?: boolean
  /** The hue of the tile's inner light leak. */
  hue?: string
  count?: number | null
  countTone?: 'bad'
  link?: { label: string; onClick: () => void }
  className?: string
  children: ReactNode
}

export const ModuleCard = ({
  title, index, compact, variant = 'tile', span = 'full', tall, hue, count, countTone, link, className, children,
}: ModuleCardProps) => {
  const [ref, revealed] = useRevealed<HTMLElement>()
  return (
    <section
      ref={ref}
      className={cls(
        'nx-home-card',
        `is-${variant}`,
        `is-span-${span}`,
        tall && 'is-tall',
        compact && 'is-compact',
        revealed && 'is-in',
        className,
      )}
      style={{ '--home-index': index, ...(hue ? { '--tile-hue': hue } : {}) } as CSSProperties}
      aria-label={title}
    >
      {variant === 'tile' ? (
        <>
          <span className="nx-home-card__leak" aria-hidden />
          <span className="nx-home-card__rim" aria-hidden><i /></span>
          <span className="nx-home-card__light" aria-hidden />
        </>
      ) : null}
      <header className="nx-home-card__head">
        <h2 className="nx-home-card__title">
          {title}
          {count ? <span className={cls('nx-home-count', countTone === 'bad' && 'is-bad')}>{count > 99 ? '99+' : count}</span> : null}
        </h2>
        {link ? (
          <button type="button" className="nx-home-card__link" onClick={link.onClick} aria-label={link.label || `Open ${title}`}>
            {link.label}
            <Icon name={link.label ? 'chevron-right' : 'arrow-up-right'} size={13} />
          </button>
        ) : null}
      </header>
      <div className="nx-home-card__body">{children}</div>
    </section>
  )
}

const Loading = ({ lines = 2 }: { lines?: number }) => (
  <div aria-busy="true" aria-label="Loading">
    {Array.from({ length: lines }, (_, i) => (
      <span key={i} className="nx-home-skeleton" style={{ width: `${88 - i * 22}%` }} />
    ))}
  </div>
)

const Unavailable = ({ what }: { what: string }) => (
  <div className="nx-home-state" role="status">
    <Icon name="slash" size={16} />
    <span>
      <strong>{what} unavailable</strong>
      The source did not answer. Figures will appear when it does.
    </span>
  </div>
)

function whenReady<T>(load: HomeLoad<T>, what: string, render: (data: T) => ReactNode, lines = 2): ReactNode {
  if (load.status === 'loading') return <Loading lines={lines} />
  if (load.status === 'unavailable') return <Unavailable what={what} />
  return render(load.data)
}

/** A figure that counts in, or an honest dash when it was not measured. */
const Figure = ({ value, format }: { value: number | null | undefined; format?: (n: number) => string }) =>
  value == null ? <span className="nx-home-unavailable">—</span> : <Counter value={value} format={format} />

// ── Automation: the reactor ─────────────────────────────────────────────────

const RING = 112
const INNER = 94
const circumference = (r: number) => 2 * Math.PI * r

/**
 * The machine's heartbeat, as an instrument. The outer arc is today's delivery
 * rate, the inner arc the share of delivered messages that drew a reply, and the
 * core is the day's sends. The whole reactor takes the engine's colour: calm
 * accent when healthy, amber with issues, red when it needs a person, and grey
 * and still when the engine cannot be read.
 */
export const AutomationModule = ({ index, compact, signals }: ModuleProps) => {
  const system = resolveSystemState(signals)
  const queue = dataOf(signals.queue)
  const messaging = dataOf(signals.messaging)
  const campaigns = dataOf(signals.campaigns)
  const gradient = useId().replace(/:/g, '')

  const delivered = queue && queue.sentToday > 0 ? Math.min(1, queue.deliveredToday / queue.sentToday) : 0
  const replies = messaging?.replies ?? null
  const replyShare = queue && queue.deliveredToday > 0 && replies != null ? Math.min(1, replies / queue.deliveredToday) : 0

  const detail = [
    campaigns && `${formatCount(campaigns.live)} campaign${campaigns.live === 1 ? '' : 's'} live`,
    messaging?.sendersActive != null && `${formatCount(messaging.sendersActive)} sender${messaging.sendersActive === 1 ? '' : 's'} active`,
  ].filter(Boolean).join(' · ') || (queue ? `${formatCount(queue.inFlight)} messages in flight` : 'Waiting on the delivery engine')

  const outer = circumference(RING)
  const inner = circumference(INNER)

  return (
    <ModuleCard title="Automation" index={index} compact={compact} variant="bare" className="nx-home-automation" link={{ label: 'Queue', onClick: () => goTo('/queue') }}>
      <div className={cls('nx-home-reactor', `is-${system.tone}`, signals.queue.status === 'loading' && 'is-loading', compact && 'is-compact')}>
        <span className="nx-home-reactor__halo" aria-hidden />
        <span className="nx-home-reactor__sweep" aria-hidden />
        <svg className="nx-home-reactor__rings" viewBox="0 0 280 280" aria-hidden>
          <defs>
            <linearGradient id={`${gradient}-arc`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="var(--tone-2)" />
              <stop offset="100%" stopColor="var(--tone)" />
            </linearGradient>
          </defs>
          <circle className="nx-home-reactor__ticks" cx="140" cy="140" r="131" />
          <circle className="nx-home-reactor__track" cx="140" cy="140" r={RING} />
          <circle
            className="nx-home-reactor__arc"
            cx="140"
            cy="140"
            r={RING}
            stroke={`url(#${gradient}-arc)`}
            style={{ '--c': outer, '--off': outer * (1 - delivered) } as CSSProperties}
          />
          <g className="nx-home-reactor__head" style={{ '--deg': `${delivered * 360}deg` } as CSSProperties}>
            <circle cx="140" cy={140 - RING} r="7" />
          </g>
          <circle className="nx-home-reactor__track is-inner" cx="140" cy="140" r={INNER} />
          <circle
            className="nx-home-reactor__arc is-inner"
            cx="140"
            cy="140"
            r={INNER}
            style={{ '--c': inner, '--off': inner * (1 - replyShare) } as CSSProperties}
          />
          <circle className="nx-home-reactor__orbit" cx="140" cy="140" r="76" />
        </svg>
        <button type="button" className="nx-home-reactor__core" onClick={() => goTo('/queue')}>
          <span className="nx-home-reactor__value"><Figure value={queue?.sentToday} /></span>
          <span className="nx-home-reactor__label">sent today</span>
          {queue && queue.sentToday > 0 ? (
            <span className="nx-home-reactor__rate"><Counter value={Math.round(delivered * 100)} format={(n) => `${n}%`} /> delivered</span>
          ) : null}
        </button>
      </div>

      <div className="nx-home-system">
        <span className="nx-home-system__title">
          <span className={cls('nx-home-dot', system.tone !== 'unknown' && `is-${system.tone}`, system.tone !== 'unknown' && 'is-live')} aria-hidden />
          {system.label}
        </span>
        <span className="nx-home-system__detail">{detail}</span>
      </div>

      {compact ? null : whenReady(signals.queue, 'Delivery engine', (q) => (
        <div className="nx-home-chips">
          <Chip label="Replies" value={replies} onClick={() => goTo('/inbox')} />
          <Chip label="In queue" value={q.inFlight} onClick={() => goTo('/queue')} />
          <Chip label="Failed" value={q.failedToday} tone={q.failedToday > 0 ? 'bad' : undefined} onClick={() => goTo('/queue')} />
          <Chip label="Review" value={q.awaitingApproval} tone={q.awaitingApproval > 0 ? 'warn' : undefined} onClick={() => goTo('/queue')} />
        </div>
      ), 1)}
    </ModuleCard>
  )
}

const Chip = ({ label, value, tone, onClick }: { label: string; value: number | null; tone?: 'bad' | 'warn'; onClick: () => void }) => (
  <button type="button" className={cls('nx-home-chip', tone && `is-${tone}`)} onClick={onClick}>
    <span className="nx-home-chip__value"><Figure value={value} /></span>
    <span className="nx-home-chip__label">{label}</span>
  </button>
)

// ── Focus: a deck, not a list ───────────────────────────────────────────────

interface FocusModuleProps {
  index: number
  compact: boolean
  items: FocusItem[]
  settled: boolean
  anyAvailable: boolean
}

/**
 * The priorities as a swipeable deck. The card in front is full size; the ones
 * either side recede, dim and turn slightly away, so the deck reads as physical
 * objects in space rather than rows. Transforms are written in a scroll-linked
 * frame, never through React state.
 */
export const FocusModule = ({ index, compact, items, settled, anyAvailable }: FocusModuleProps) => {
  const deckRef = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(0)
  const cards = items.slice(0, 10)
  const urgent = items.filter((item) => item.tone === 'critical').length
  const signature = cards.map((item) => item.id).join('|')

  // Items arrive source by source and are re-ranked as they do. A snapped deck
  // stays glued to the card it snapped to, so without this it would open on
  // whichever card loaded first rather than on the most important one.
  useEffect(() => {
    deckRef.current?.scrollTo({ left: 0 })
  }, [signature])

  useEffect(() => {
    const deck = deckRef.current
    if (!deck) return
    let frame = 0
    const apply = () => {
      frame = 0
      const center = deck.scrollLeft + deck.clientWidth / 2
      let nearest = 0
      let nearestDistance = Infinity
      Array.from(deck.children).forEach((child, i) => {
        const card = child as HTMLElement
        const mid = card.offsetLeft + card.offsetWidth / 2
        const d = (mid - center) / card.offsetWidth
        const a = Math.min(1, Math.abs(d))
        card.style.setProperty('transform', `perspective(900px) rotateY(${(-d * 14).toFixed(2)}deg) scale(${(1 - a * 0.08).toFixed(3)})`)
        card.style.setProperty('opacity', (1 - a * 0.45).toFixed(3))
        if (Math.abs(d) < nearestDistance) { nearestDistance = Math.abs(d); nearest = i }
      })
      setActive((current) => (current === nearest ? current : nearest))
    }
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(apply) }
    onScroll()
    deck.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      deck.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [cards.length])

  let body: ReactNode
  if (cards.length > 0) {
    body = (
      <>
        <div className={cls('nx-home-deck', compact && 'is-compact')} ref={deckRef}>
          {cards.map((item, i) => (
            <button
              key={item.id}
              type="button"
              className={cls('nx-home-focus__item', `is-${item.tone}`)}
              style={{ '--i': i } as CSSProperties}
              onClick={() => openTarget(item.target)}
            >
              <span className="nx-home-focus__glow" aria-hidden />
              {item.tone === 'critical' ? <span className="nx-home-card__rim is-comet" aria-hidden><i /></span> : null}
              <span className="nx-home-focus__top">
                <span className="nx-home-glyph"><Icon name={item.icon} size={20} strokeWidth={1.7} /></span>
                <span className="nx-home-focus__app">{item.app}</span>
                <span className="nx-home-focus__time">{item.at ? relativeTime(item.at) : item.tone === 'critical' ? 'Now' : ''}</span>
              </span>
              <span className="nx-home-focus__title">{item.title}</span>
              <span className="nx-home-focus__detail">{item.detail}</span>
              <span className="nx-home-focus__cta">Open {item.app}<Icon name="arrow-up-right" size={13} /></span>
            </button>
          ))}
        </div>
        {cards.length > 1 ? (
          <div className="nx-home-pager" aria-hidden>
            {cards.map((item, i) => <i key={item.id} className={cls(i === active && 'is-on', `is-${item.tone}`)} />)}
          </div>
        ) : null}
      </>
    )
  } else if (!settled) {
    body = <div className="nx-home-deck-skeleton"><Loading lines={3} /></div>
  } else if (!anyAvailable) {
    body = <Unavailable what="Priorities" />
  } else {
    body = (
      <div className="nx-home-clear" role="status">
        <span className="nx-home-clear__mark" aria-hidden><Icon name="check" size={22} strokeWidth={2} /></span>
        <strong>You're clear</strong>
        <span>Nothing needs you right now. Automation is handling the rest.</span>
      </div>
    )
  }

  return (
    <ModuleCard title="Focus" index={index} compact={compact} variant="bare" count={items.length || null} countTone={urgent > 0 ? 'bad' : undefined}>
      {body}
    </ModuleCard>
  )
}

// ── Quick actions: a rail ───────────────────────────────────────────────────

interface QuickAction {
  id: string
  label: string
  icon: IconName
  onClick: () => void
  badge?: number | null
  primary?: boolean
}

export const QuickActionsModule = ({ index, compact, signals }: ModuleProps) => {
  const inbox = dataOf(signals.inbox)
  const queue = dataOf(signals.queue)
  const actions: QuickAction[] = [
    { id: 'inbox', label: 'Inbox', icon: 'inbox', onClick: () => goTo('/inbox'), badge: inbox?.newReplies, primary: true },
    { id: 'search', label: 'Search', icon: 'search', onClick: openSearch },
    { id: 'campaign', label: 'Launch', icon: 'bolt', onClick: () => goTo('/campaign-command?compose=1') },
    { id: 'queue', label: 'Queue', icon: 'send', onClick: () => goTo('/queue'), badge: queue?.failedToday },
    { id: 'map', label: 'Map', icon: 'map', onClick: () => goTo('/map') },
    { id: 'pipeline', label: 'Pipeline', icon: 'radar', onClick: () => goTo('/pipeline') },
    { id: 'deals', label: 'Deals', icon: 'briefcase', onClick: () => goTo('/closing-desk') },
    { id: 'calendar', label: 'Calendar', icon: 'calendar', onClick: () => goTo('/calendar') },
  ]
  return (
    <ModuleCard title="Quick actions" index={index} compact={compact} variant="bare">
      <div className="nx-home-actions">
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            className={cls('nx-home-action', action.primary && 'is-primary')}
            onClick={action.onClick}
          >
            <span className="nx-home-action__glyph">
              <span className="nx-home-action__well" />
              <Icon name={action.icon} size={20} strokeWidth={1.6} />
              {action.badge ? (
                <span className="nx-home-action__badge">{action.badge > 99 ? '99+' : action.badge}</span>
              ) : null}
            </span>
            <span className="nx-home-action__label">{action.label}</span>
          </button>
        ))}
      </div>
    </ModuleCard>
  )
}

// ── Inbox tile ──────────────────────────────────────────────────────────────

export const InboxModule = ({ index, compact, signals }: ModuleProps) => {
  const inbox = dataOf(signals.inbox)
  return (
    <ModuleCard title="Inbox" index={index} compact={compact} span="half" tall hue="var(--home-accent)" count={inbox?.newReplies ?? null} link={{ label: '', onClick: () => goTo('/inbox') }}>
      {whenReady(signals.inbox, 'Inbox', (data) => {
        return (
          <>
            <button type="button" className="nx-home-big" onClick={() => goTo('/inbox')}>
              <span className="nx-home-big__value"><Figure value={data.newReplies} /></span>
              <span className="nx-home-big__label">replies waiting</span>
            </button>
            {data.threads.length > 0 ? (
              <div className="nx-home-faces" aria-label="Latest sellers">
                {data.threads.slice(0, 4).map((thread, i) => (
                  <button
                    key={thread.id}
                    type="button"
                    className={cls('nx-home-avatar', thread.hot && 'is-hot')}
                    style={{ '--i': i } as CSSProperties}
                    aria-label={`Open ${thread.seller}`}
                    onClick={() => openThread(thread)}
                  >
                    {initials(thread.seller)}
                  </button>
                ))}
              </div>
            ) : null}
            {!compact && data.threads.length > 0 ? (
              <div className="nx-home-bubbles">
                {data.threads.slice(0, 3).map((thread, i) => (
                  <button
                    key={thread.id}
                    type="button"
                    className={cls('nx-home-bubble', thread.hot && 'is-hot')}
                    style={{ '--i': i } as CSSProperties}
                    onClick={() => openThread(thread)}
                  >
                    <span className="nx-home-bubble__who">
                      <b>{thread.seller}</b>
                      <span>{relativeTime(thread.at)}</span>
                    </span>
                    <span className="nx-home-bubble__text">{thread.preview || thread.address || 'Open the conversation'}</span>
                  </button>
                ))}
              </div>
            ) : null}
            <div className="nx-home-minis">
              <span><b className={cls((data.priority ?? 0) > 0 && 'is-warn')}><Figure value={data.priority} /></b>priority</span>
              <span><b><Figure value={data.needsAttention} /></b>attention</span>
            </div>
          </>
        )
      }, 4)}
    </ModuleCard>
  )
}

// ── Campaigns tile ──────────────────────────────────────────────────────────

export const CampaignsModule = ({ index, compact, signals }: ModuleProps) => {
  const campaigns = dataOf(signals.campaigns)
  return (
    <ModuleCard
      title="Campaigns"
      index={index}
      compact={compact}
      span="half"
      hue="color-mix(in srgb, var(--home-accent) 30%, #8b5cf6)"
      count={campaigns?.attention.length || null}
      countTone="bad"
      link={{ label: '', onClick: () => goTo('/campaign-command') }}
    >
      {whenReady(signals.campaigns, 'Campaigns', (data) => {
        const lead = data.highlighted[0]
        const progress = lead && lead.total > 0 ? Math.min(100, (lead.sent / lead.total) * 100) : 0
        return (
          <>
            <button type="button" className="nx-home-big" onClick={() => goTo('/campaign-command')}>
              <span className="nx-home-big__value is-live">
                {data.live > 0 ? <span className="nx-home-live" aria-hidden><i /><i /></span> : null}
                <Counter value={data.live} />
              </span>
              <span className="nx-home-big__label">live now</span>
            </button>
            <div className="nx-home-minis is-stack">
              <span><b><Counter value={data.readyTargets} /></b>sellers ready</span>
              {data.attention.length > 0 ? <span className="is-warn"><b>{data.attention.length}</b>flagged</span> : null}
            </div>
            {!compact && lead ? (
              <button type="button" className="nx-home-mini-campaign" onClick={() => goTo('/campaign-command')}>
                <span>{lead.name}</span>
                <span className="nx-home-progress"><i style={{ '--p': `${progress}%` } as CSSProperties} /></span>
              </button>
            ) : null}
          </>
        )
      }, 3)}
    </ModuleCard>
  )
}

// ── Deals tile ──────────────────────────────────────────────────────────────

const formatClosingDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })

export const DealsModule = ({ index, compact, signals }: ModuleProps) => {
  const pipeline = dataOf(signals.pipeline)
  const closings = dataOf(signals.closings)
  const bothSettled = signals.pipeline.status !== 'loading' && signals.closings.status !== 'loading'

  let body: ReactNode
  if (!pipeline && !closings) {
    body = bothSettled ? <Unavailable what="Deal flow" /> : <Loading lines={3} />
  } else {
    body = (
      <>
        <button type="button" className="nx-home-big" onClick={() => goTo('/pipeline')}>
          <span className="nx-home-big__value"><Figure value={pipeline?.offers} /></span>
          <span className="nx-home-big__label">offers out</span>
        </button>
        <ul className="nx-home-ledger">
          <li><i style={{ '--dot': '#34d399' } as CSSProperties} />Contracts<b><Figure value={pipeline?.contractsOut} /></b></li>
          <li><i style={{ '--dot': '#60a5fa' } as CSSProperties} />Under contract<b><Figure value={closings?.underContract ?? pipeline?.underContract} /></b></li>
          <li><i style={{ '--dot': '#f472b6' } as CSSProperties} />This week<b><Figure value={closings?.closingsThisWeek} /></b></li>
        </ul>
        {!compact && closings?.next ? (
          <button type="button" className="nx-home-next" onClick={() => goTo('/closing-desk')}>
            <Icon name="calendar" size={13} />
            <span>{closings.next.name}</span>
            <b>{formatClosingDate(closings.next.date)}</b>
          </button>
        ) : null}
      </>
    )
  }

  return (
    <ModuleCard title="Deals" index={index} compact={compact} span="half" hue="color-mix(in srgb, var(--home-accent) 25%, #10b981)" link={{ label: '', onClick: () => goTo('/closing-desk') }}>
      {body}
    </ModuleCard>
  )
}

// ── Pipeline: a liquid funnel ───────────────────────────────────────────────

const FUNNEL_W = 320
const FUNNEL_H = 104
const FUNNEL_MID = FUNNEL_H / 2

/** A smooth band whose thickness follows each stage's count. */
function funnelPath(buckets: PipelineBucket[]) {
  const peak = Math.max(1, ...buckets.map((bucket) => bucket.count))
  const points = buckets.map((bucket, i) => ({
    x: (FUNNEL_W * (i + 0.5)) / buckets.length,
    t: 10 + 84 * Math.sqrt(bucket.count / peak),
  }))
  const edge = [{ x: 0, t: points[0].t }, ...points, { x: FUNNEL_W, t: points[points.length - 1].t }]
  const curve = (pts: typeof edge, sign: 1 | -1) =>
    pts.slice(1).map((p, i) => {
      const prev = pts[i]
      const dx = (p.x - prev.x) / 2
      return `C${prev.x + dx},${FUNNEL_MID + (sign * prev.t) / 2} ${p.x - dx},${FUNNEL_MID + (sign * p.t) / 2} ${p.x},${FUNNEL_MID + (sign * p.t) / 2}`
    }).join(' ')
  const reversed = [...edge].reverse()
  return `M0,${FUNNEL_MID - edge[0].t / 2} ${curve(edge, -1)} L${FUNNEL_W},${FUNNEL_MID + reversed[0].t / 2} ${curve(reversed, 1)} Z`
}

/**
 * The pipeline as one body of liquid: its thickness at each stage is that stage's
 * share (square-root scaled, so a thin late stage stays visible beside a fat top
 * of funnel), with light washing through it and particles flowing downstream.
 */
const Funnel = ({ buckets }: { buckets: PipelineBucket[] }) => {
  const id = useId().replace(/:/g, '')
  const d = funnelPath(buckets)
  return (
    <svg className="nx-home-funnel" viewBox={`0 0 ${FUNNEL_W} ${FUNNEL_H}`} preserveAspectRatio="none" role="img" aria-label={buckets.map((b) => `${b.label} ${b.count}`).join(', ')}>
      <defs>
        <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="1" y2="0">
          {buckets.map((bucket, i) => (
            <stop key={bucket.id} offset={`${((i + 0.5) / buckets.length) * 100}%`} stopColor={bucket.color} />
          ))}
        </linearGradient>
        <linearGradient id={`${id}-sheen`} gradientUnits="userSpaceOnUse" x1="-90" y1="0" x2="0" y2="0">
          <stop offset="0%" stopColor="#fff" stopOpacity="0" />
          <stop offset="50%" stopColor="#fff" stopOpacity="0.5" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0" />
          <animateTransform attributeName="gradientTransform" type="translate" from="0 0" to={`${FUNNEL_W + 180} 0`} dur="4.5s" begin="1.2s" repeatCount="indefinite" />
        </linearGradient>
        <linearGradient id={`${id}-depth`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#fff" stopOpacity="0.38" />
          <stop offset="42%" stopColor="#fff" stopOpacity="0" />
          <stop offset="100%" stopColor="#000" stopOpacity="0.4" />
        </linearGradient>
      </defs>
      <g className="nx-home-funnel__body">
        <path d={d} fill={`url(#${id}-fill)`} className="nx-home-funnel__glow" />
        <path d={d} fill={`url(#${id}-fill)`} />
        <path d={d} fill={`url(#${id}-depth)`} />
        <path d={d} fill={`url(#${id}-sheen)`} />
        {Array.from({ length: 9 }, (_, i) => {
          const y = FUNNEL_MID + ((i % 3) - 1) * 2.4
          return (
            <circle key={i} className="nx-home-funnel__particle" r={i % 2 ? 1.2 : 1.7} cx="0" cy="0">
              <animateMotion path={`M-6,${y} L${FUNNEL_W + 6},${y}`} dur={`${3.4 + (i % 4) * 0.7}s`} begin={`${(i * 0.53).toFixed(2)}s`} repeatCount="indefinite" />
            </circle>
          )
        })}
      </g>
    </svg>
  )
}

export const PipelineModule = ({ index, compact, signals }: ModuleProps) => {
  const pipeline = dataOf(signals.pipeline)
  return (
    <ModuleCard
      title="Pipeline"
      index={index}
      compact={compact}
      hue="color-mix(in srgb, var(--home-accent) 40%, #6366f1)"
      link={{ label: pipeline?.active != null ? `${formatCount(pipeline.active)} active` : 'Open', onClick: () => goTo('/pipeline') }}
    >
      {whenReady(signals.pipeline, 'Pipeline', (data) => (
        <>
          <Funnel buckets={data.buckets} />
          <div className="nx-home-stages">
            {data.buckets.map((bucket) => (
              <button key={bucket.id} type="button" className="nx-home-stage" onClick={() => goTo('/pipeline')} style={{ '--seg': bucket.color } as CSSProperties}>
                <span className="nx-home-stage__value"><Counter value={bucket.count} /></span>
                <span className="nx-home-stage__label"><i />{bucket.label}</span>
              </button>
            ))}
          </div>
        </>
      ), 3)}
    </ModuleCard>
  )
}

// ── Markets: the constellation ──────────────────────────────────────────────

export const MarketsModule = ({ index, compact, signals }: ModuleProps) => (
  <ModuleCard title="Market signals" index={index} compact={compact} hue="color-mix(in srgb, var(--home-accent) 50%, #14b8a6)" link={{ label: 'Map', onClick: () => goTo('/map') }}>
    {whenReady(signals.markets, 'Market signals', (markets) => (
      <>
        <button type="button" className="nx-home-map" onClick={() => goTo('/map')} aria-label="Open the map">
          <MarketConstellation markets={markets} />
        </button>
        {markets.length === 0 ? (
          <div className="nx-home-state">
            <Icon name="map" size={16} />
            <span><strong>No market activity this week</strong>Signals appear once outreach is sending.</span>
          </div>
        ) : (
          <ol className="nx-home-leaders">
            {markets.slice(0, compact ? 2 : 3).map((row, i) => (
              <li key={`${row.market}-${i}`}>
                <button type="button" onClick={() => goTo('/map')}>
                  <span className="nx-home-rank">{i + 1}</span>
                  <span className="nx-home-leaders__name">{row.market}</span>
                  {row.positive > 0 ? <span className="nx-home-tag is-good">{row.positive} warm</span> : null}
                  <span className="nx-home-leaders__value"><Counter value={row.replied} /> <small>replies</small></span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </>
    ), 3)}
  </ModuleCard>
)

// ── Live activity ───────────────────────────────────────────────────────────

export const ActivityModule = ({
  index,
  compact,
  signals,
  notifications,
  notificationsReady,
}: ModuleProps & { notifications: NotificationEvent[]; notificationsReady: boolean }) => {
  const inbox = dataOf(signals.inbox)
  const entries = useMemo(() => buildActivity(notifications, inbox, compact ? 3 : 6), [compact, inbox, notifications])
  const settled = notificationsReady || signals.inbox.status !== 'loading'

  return (
    <ModuleCard title="Live activity" index={index} compact={compact} hue="var(--home-accent)" link={{ label: 'All', onClick: openNotifications }} className="nx-home-activity">
      <span className="nx-home-onair" aria-hidden><i />Live</span>
      {entries.length > 0 ? (
        <ul className="nx-home-feed" aria-live="polite">
          {entries.map((entry, i) => (
            <li key={entry.id} className="nx-home-feed__item" style={{ '--i': i } as CSSProperties}>
              <span className={cls('nx-home-dot', entry.tone !== 'neutral' && `is-${entry.tone}`, i === 0 && 'is-live')} aria-hidden />
              <button type="button" className="nx-home-feed__text" onClick={() => openTarget(entry.target)}>
                <b>{entry.title}</b>
                {entry.detail ? <small>{entry.detail}</small> : null}
              </button>
              <span className="nx-home-feed__time">{relativeTime(entry.at)}</span>
            </li>
          ))}
        </ul>
      ) : settled ? (
        <div className="nx-home-state">
          <Icon name="activity" size={16} />
          <span><strong>Quiet for now</strong>Replies, deliveries and stage changes stream in here.</span>
        </div>
      ) : (
        <Loading lines={3} />
      )}
    </ModuleCard>
  )
}
