import { useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { Icon, type IconName } from '../../shared/icons'
import type { NotificationEvent } from '../../domain/notifications/notification-contract'
import {
  dataOf,
  formatCount,
  initials,
  notificationPath,
  relativeTime,
  type FocusItem,
  type HomeLoad,
  type HomeThread,
} from './home-signals'
import { resolveSystemState, type HomeSignals } from './useHomeSignals'
import { goTo, openNotifications, openSearch, openTarget, openThread } from './home-navigation'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

// ── Card chrome ─────────────────────────────────────────────────────────────

interface ModuleCardProps {
  title: string
  index: number
  compact?: boolean
  emphasis?: boolean
  count?: number | null
  countTone?: 'bad'
  link?: { label: string; onClick: () => void }
  children: ReactNode
}

export const ModuleCard = ({ title, index, compact, emphasis, count, countTone, link, children }: ModuleCardProps) => (
  <section
    className={cls('nx-home-card', compact && 'is-compact', emphasis && 'is-emphasis')}
    style={{ '--home-index': index } as CSSProperties}
    aria-label={title}
  >
    <header className="nx-home-card__head">
      <h2 className="nx-home-card__title">
        {title}
        {count ? <span className={cls('nx-home-count', countTone === 'bad' && 'is-bad')}>{count > 99 ? '99+' : count}</span> : null}
      </h2>
      {link ? (
        <button type="button" className="nx-home-card__link" onClick={link.onClick}>
          {link.label}
          <Icon name="chevron-right" size={13} />
        </button>
      ) : null}
    </header>
    <div className="nx-home-card__body">{children}</div>
  </section>
)

const Loading = ({ lines = 2 }: { lines?: number }) => (
  <div aria-busy="true" aria-label="Loading">
    {Array.from({ length: lines }, (_, i) => (
      <span key={i} className="nx-home-skeleton" style={{ width: `${88 - i * 22}%` }} />
    ))}
  </div>
)

const Unavailable = ({ what, reason }: { what: string; reason?: string }) => (
  <div className="nx-home-state" role="status">
    <Icon name="slash" size={16} />
    <span>
      <strong>{what} unavailable</strong>
      {reason ? 'The source did not answer. Figures will appear when it does.' : null}
    </span>
  </div>
)

/** Loading, unavailable, or the module body — the one branch every module needs. */
function whenReady<T>(load: HomeLoad<T>, what: string, render: (data: T) => ReactNode, lines = 2): ReactNode {
  if (load.status === 'loading') return <Loading lines={lines} />
  if (load.status === 'unavailable') return <Unavailable what={what} reason={load.reason} />
  return render(load.data)
}

interface MetricProps {
  label: string
  value: number | null | undefined
  tone?: 'bad' | 'warn' | 'good'
  onClick?: () => void
  suffix?: string
}

const Metric = ({ label, value, tone, onClick, suffix }: MetricProps) => {
  const content = (
    <>
      <span className={cls('nx-home-metric__value', tone && `is-${tone}`, value == null && 'nx-home-unavailable')}>
        {formatCount(value)}{value != null && suffix ? suffix : null}
      </span>
      <span className="nx-home-metric__label">{label}</span>
    </>
  )
  return onClick ? (
    <button type="button" className="nx-home-metric" onClick={onClick}>{content}</button>
  ) : (
    <div className="nx-home-metric">{content}</div>
  )
}

// ── Focus ───────────────────────────────────────────────────────────────────

interface FocusModuleProps {
  index: number
  compact: boolean
  items: FocusItem[]
  settled: boolean
  anyAvailable: boolean
}

export const FocusModule = ({ index, compact, items, settled, anyAvailable }: FocusModuleProps) => {
  const [expanded, setExpanded] = useState(false)
  const limit = compact ? 3 : 4
  const visible = expanded ? items.slice(0, 10) : items.slice(0, limit)
  const hiddenCount = Math.min(items.length, 10) - visible.length
  const urgent = items.filter((item) => item.tone === 'critical').length

  let body: ReactNode
  if (items.length > 0) {
    body = (
      <>
        <ul className="nx-home-focus">
          {visible.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className={cls('nx-home-focus__item', `is-${item.tone}`)}
                onClick={() => openTarget(item.target)}
              >
                <span className="nx-home-glyph"><Icon name={item.icon} size={17} strokeWidth={1.7} /></span>
                <span className="nx-home-focus__text">
                  <span className="nx-home-focus__title">{item.title}</span>
                  <span className="nx-home-focus__detail">
                    <span className="nx-home-focus__app">{item.app}</span>
                    {item.detail}
                  </span>
                </span>
                <span className="nx-home-focus__meta">
                  {item.at ? <span>{relativeTime(item.at)}</span> : <Icon name="chevron-right" size={14} />}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {hiddenCount > 0 || expanded ? (
          <button type="button" className="nx-home-more" onClick={() => setExpanded((open) => !open)}>
            {expanded ? 'Show less' : `${hiddenCount} more`}
            <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={13} />
          </button>
        ) : null}
      </>
    )
  } else if (!settled) {
    body = <Loading lines={3} />
  } else if (!anyAvailable) {
    body = <Unavailable what="Priorities" reason="sources" />
  } else {
    body = (
      <div className="nx-home-state is-calm" role="status">
        <span className="nx-home-glyph is-good"><Icon name="check" size={17} /></span>
        <span>
          <strong>You're clear</strong>
          Nothing needs you right now. Automation is handling the rest.
        </span>
      </div>
    )
  }

  return (
    <ModuleCard title="Focus" index={index} compact={compact} emphasis count={items.length || null} countTone={urgent > 0 ? 'bad' : undefined}>
      {body}
    </ModuleCard>
  )
}

// ── Quick actions ───────────────────────────────────────────────────────────

interface QuickAction {
  id: string
  label: string
  icon: IconName
  onClick: () => void
  badge?: number | null
  primary?: boolean
}

export const QuickActionsModule = ({ index, compact, signals }: { index: number; compact: boolean; signals: HomeSignals }) => {
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
    <ModuleCard title="Quick actions" index={index} compact={compact}>
      <div className="nx-home-actions">
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            className={cls('nx-home-action', action.primary && 'is-primary')}
            onClick={action.onClick}
          >
            <span className="nx-home-action__glyph">
              <Icon name={action.icon} size={19} strokeWidth={1.6} />
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

// ── Automation ──────────────────────────────────────────────────────────────

export const AutomationModule = ({ index, compact, signals }: { index: number; compact: boolean; signals: HomeSignals }) => {
  const system = resolveSystemState(signals)
  const queue = dataOf(signals.queue)
  const messaging = dataOf(signals.messaging)
  const campaigns = dataOf(signals.campaigns)

  const detail = [
    campaigns && `${formatCount(campaigns.live)} campaign${campaigns.live === 1 ? '' : 's'} live`,
    messaging?.sendersActive != null && `${formatCount(messaging.sendersActive)} sender${messaging.sendersActive === 1 ? '' : 's'} active`,
  ].filter(Boolean).join(' · ') || (queue ? `${formatCount(queue.inFlight)} messages in flight` : 'Waiting on the delivery engine')

  return (
    <ModuleCard title="Automation" index={index} compact={compact} link={{ label: 'Queue', onClick: () => goTo('/queue') }}>
      <div className="nx-home-system">
        <span className={cls('nx-home-system__orb', `is-${system.tone}`)} aria-hidden>
          <Icon name={system.tone === 'good' ? 'check' : system.tone === 'unknown' ? 'slash' : 'alert'} size={16} strokeWidth={2} />
        </span>
        <span>
          <span className="nx-home-system__title">{system.label}</span>
          <span className="nx-home-system__detail">{detail}</span>
        </span>
      </div>
      {compact ? null : whenReady(signals.queue, 'Delivery engine', (q) => (
        <div className="nx-home-metrics">
          <Metric label="Sent today" value={q.sentToday} onClick={() => goTo('/queue')} />
          <Metric label="Delivered" value={q.deliveredToday} onClick={() => goTo('/queue')} />
          <Metric label="Replies" value={messaging?.replies ?? null} onClick={() => goTo('/inbox')} />
          <Metric label="In queue" value={q.inFlight} onClick={() => goTo('/queue')} />
          <Metric label="Failed" value={q.failedToday} tone={q.failedToday > 0 ? 'bad' : undefined} onClick={() => goTo('/queue')} />
          <Metric label="Awaiting review" value={q.awaitingApproval} tone={q.awaitingApproval > 0 ? 'warn' : undefined} onClick={() => goTo('/queue')} />
        </div>
      ), 2)}
    </ModuleCard>
  )
}

// ── Inbox ───────────────────────────────────────────────────────────────────

const ThreadRow = ({ thread }: { thread: HomeThread }) => (
  <button type="button" className={cls('nx-home-row', thread.unread && 'is-unread')} onClick={() => openThread(thread)}>
    <span className={cls('nx-home-avatar', thread.hot && 'is-hot')} aria-hidden>{initials(thread.seller)}</span>
    <span className="nx-home-row__main">
      <span className="nx-home-row__title">
        <span>{thread.seller}</span>
        {thread.hot ? <span className="nx-home-tag is-warn">Hot</span> : null}
      </span>
      <span className="nx-home-row__sub">{thread.preview || thread.address || 'Open the conversation'}</span>
    </span>
    <span className="nx-home-row__meta">{relativeTime(thread.at)}</span>
  </button>
)

export const InboxModule = ({ index, compact, signals }: { index: number; compact: boolean; signals: HomeSignals }) => {
  const inbox = dataOf(signals.inbox)
  return (
    <ModuleCard title="Inbox" index={index} compact={compact} count={inbox?.newReplies ?? null} link={{ label: 'Open', onClick: () => goTo('/inbox') }}>
      {whenReady(signals.inbox, 'Inbox', (data) => (
        <>
          <div className="nx-home-metrics">
            <Metric label="New replies" value={data.newReplies} onClick={() => goTo('/inbox')} />
            <Metric label="Priority" value={data.priority} tone={(data.priority ?? 0) > 0 ? 'warn' : undefined} onClick={() => goTo('/inbox')} />
            <Metric label="Need attention" value={data.needsAttention} onClick={() => goTo('/inbox')} />
          </div>
          {!compact && data.threads.length > 0 ? (
            <div className="nx-home-rows">
              {data.threads.slice(0, 3).map((thread) => <ThreadRow key={thread.id} thread={thread} />)}
            </div>
          ) : null}
        </>
      ), 3)}
    </ModuleCard>
  )
}

// ── Pipeline ────────────────────────────────────────────────────────────────

export const PipelineModule = ({ index, compact, signals }: { index: number; compact: boolean; signals: HomeSignals }) => {
  const pipeline = dataOf(signals.pipeline)
  return (
    <ModuleCard title="Pipeline" index={index} compact={compact} link={{ label: pipeline?.active != null ? `${formatCount(pipeline.active)} active` : 'Open', onClick: () => goTo('/pipeline') }}>
      {whenReady(signals.pipeline, 'Pipeline', (data) => {
        const total = data.buckets.reduce((sum, bucket) => sum + bucket.count, 0)
        return (
          <>
            <div className={cls('nx-home-stagebar', total === 0 && 'is-empty')} role="img" aria-label={data.buckets.map((b) => `${b.label} ${b.count}`).join(', ')}>
              {data.buckets.map((bucket, i) => (
                <span
                  key={bucket.id}
                  className="nx-home-stagebar__seg"
                  style={{ flexGrow: total === 0 ? 1 : Math.max(bucket.count, total * 0.02), '--seg': bucket.color, '--i': i } as CSSProperties}
                />
              ))}
            </div>
            {compact ? null : (
              <div className="nx-home-stages">
                {data.buckets.map((bucket) => (
                  <button key={bucket.id} type="button" className="nx-home-stage" onClick={() => goTo('/pipeline')} style={{ '--seg': bucket.color } as CSSProperties}>
                    <span className="nx-home-stage__label"><i />{bucket.label}</span>
                    <span className="nx-home-stage__value">{formatCount(bucket.count)}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )
      })}
    </ModuleCard>
  )
}

// ── Campaigns ───────────────────────────────────────────────────────────────

export const CampaignsModule = ({ index, compact, signals }: { index: number; compact: boolean; signals: HomeSignals }) => {
  const campaigns = dataOf(signals.campaigns)
  const queue = dataOf(signals.queue)
  return (
    <ModuleCard
      title="Campaigns"
      index={index}
      compact={compact}
      count={campaigns?.attention.length || null}
      countTone="bad"
      link={{ label: 'Command', onClick: () => goTo('/campaign-command') }}
    >
      {whenReady(signals.campaigns, 'Campaigns', (data) => {
        const rows = [...data.attention.slice(0, 1), ...data.highlighted.filter((c) => !data.attention.some((a) => a.id === c.id))].slice(0, 2)
        return (
          <>
            <div className="nx-home-metrics">
              <Metric label="Live" value={data.live} tone={data.live > 0 ? 'good' : undefined} onClick={() => goTo('/campaign-command')} />
              <Metric label="Sellers ready" value={data.readyTargets} onClick={() => goTo('/campaign-command')} />
              <Metric label="Sent today" value={queue?.sentToday ?? null} onClick={() => goTo('/queue')} />
            </div>
            {!compact && rows.length > 0 ? (
              <div className="nx-home-rows">
                {rows.map((campaign) => {
                  const progress = campaign.total > 0 ? Math.min(100, (campaign.sent / campaign.total) * 100) : 0
                  return (
                    <button key={campaign.id} type="button" className="nx-home-row" onClick={() => goTo('/campaign-command')}>
                      <span className={cls('nx-home-glyph', campaign.issue ? 'is-warn' : undefined)} aria-hidden>
                        <Icon name={campaign.issue ? 'alert' : 'bolt'} size={16} />
                      </span>
                      <span className="nx-home-row__main">
                        <span className="nx-home-row__title">
                          <span>{campaign.name}</span>
                        </span>
                        <span className="nx-home-row__sub">
                          {campaign.issue ?? [campaign.market, `${formatCount(campaign.sent)} sent`, `${formatCount(campaign.replies)} replies`].filter(Boolean).join(' · ')}
                        </span>
                        <span className={cls('nx-home-progress', campaign.issue && 'is-warn')}>
                          <i style={{ '--p': `${progress}%` } as CSSProperties} />
                        </span>
                      </span>
                      <span className={cls('nx-home-tag', campaign.status === 'paused' || campaign.status === 'failed' ? 'is-warn' : 'is-good')}>
                        {campaign.status.replace(/_/g, ' ')}
                      </span>
                    </button>
                  )
                })}
              </div>
            ) : null}
            {data.live === 0 && data.attention.length === 0 && !compact ? (
              <div className="nx-home-state" style={{ marginTop: 12 }}>
                <Icon name="bolt" size={16} />
                <span><strong>No campaigns running</strong>Build one when you're ready to reach new sellers.</span>
              </div>
            ) : null}
          </>
        )
      }, 3)}
    </ModuleCard>
  )
}

// ── Deals ───────────────────────────────────────────────────────────────────

const formatClosingDate = (iso: string) => {
  const date = new Date(iso)
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

export const DealsModule = ({ index, compact, signals }: { index: number; compact: boolean; signals: HomeSignals }) => {
  const pipeline = dataOf(signals.pipeline)
  const closings = dataOf(signals.closings)
  const settled = signals.pipeline.status !== 'loading' || signals.closings.status !== 'loading'

  let body: ReactNode
  if (!pipeline && !closings) {
    body = settled && signals.pipeline.status !== 'loading' && signals.closings.status !== 'loading'
      ? <Unavailable what="Deal flow" reason="sources" />
      : <Loading lines={2} />
  } else {
    body = (
      <>
        <div className="nx-home-metrics is-two">
          <Metric label="Offers out" value={pipeline?.offers ?? null} onClick={() => goTo('/pipeline')} />
          <Metric label="Contracts sent" value={pipeline?.contractsOut ?? null} onClick={() => goTo('/pipeline')} />
          <Metric label="Under contract" value={closings?.underContract ?? pipeline?.underContract ?? null} onClick={() => goTo('/closing-desk')} />
          <Metric label="Closing this week" value={closings?.closingsThisWeek ?? null} tone={(closings?.closingsThisWeek ?? 0) > 0 ? 'good' : undefined} onClick={() => goTo('/closing-desk')} />
        </div>
        {!compact && closings?.next ? (
          <div className="nx-home-rows">
            <button type="button" className="nx-home-row" onClick={() => goTo('/closing-desk')}>
              <span className="nx-home-glyph is-good" aria-hidden><Icon name="calendar" size={16} /></span>
              <span className="nx-home-row__main">
                <span className="nx-home-row__title"><span>Next closing · {closings.next.name}</span></span>
                <span className="nx-home-row__sub">{closings.next.address ?? 'Address pending'}</span>
              </span>
              <span className="nx-home-row__meta">{formatClosingDate(closings.next.date)}</span>
            </button>
          </div>
        ) : null}
        {!compact && closings && closings.titleBlocked + closings.actionRequired > 0 ? (
          <div className="nx-home-rows">
            <button type="button" className="nx-home-row" onClick={() => goTo('/closing-desk')}>
              <span className="nx-home-glyph is-warn" aria-hidden><Icon name="shield" size={16} /></span>
              <span className="nx-home-row__main">
                <span className="nx-home-row__title"><span>Closing blockers</span></span>
                <span className="nx-home-row__sub">
                  {[closings.titleBlocked > 0 && `${closings.titleBlocked} title`, closings.actionRequired > 0 && `${closings.actionRequired} awaiting a party`].filter(Boolean).join(' · ')}
                </span>
              </span>
              <Icon name="chevron-right" size={14} />
            </button>
          </div>
        ) : null}
      </>
    )
  }

  return (
    <ModuleCard title="Deals" index={index} compact={compact} link={{ label: 'Closing desk', onClick: () => goTo('/closing-desk') }}>
      {body}
    </ModuleCard>
  )
}

// ── Markets ─────────────────────────────────────────────────────────────────

export const MarketsModule = ({ index, compact, signals }: { index: number; compact: boolean; signals: HomeSignals }) => (
  <ModuleCard title="Market signals" index={index} compact={compact} link={{ label: 'Map', onClick: () => goTo('/map') }}>
    {whenReady(signals.markets, 'Market signals', (markets) => {
      if (markets.length === 0) {
        return (
          <div className="nx-home-state">
            <Icon name="map" size={16} />
            <span><strong>No market activity this week</strong>Signals appear once outreach is sending.</span>
          </div>
        )
      }
      const rows = markets.slice(0, compact ? 3 : 4)
      const top = Math.max(1, ...rows.map((row) => row.replied))
      return (
        <div className="nx-home-rows is-ranked" style={{ marginTop: 4 }}>
          {rows.map((row, i) => (
            <button key={`${row.market}-${i}`} type="button" className="nx-home-row" onClick={() => goTo('/map')}>
              <span className="nx-home-rank">{i + 1}</span>
              <span className="nx-home-row__main">
                <span className="nx-home-row__title">
                  <span>{row.market}</span>
                  {row.positive > 0 ? <span className="nx-home-tag is-good">{row.positive} warm</span> : null}
                </span>
                <span className="nx-home-progress"><i style={{ '--p': `${(row.replied / top) * 100}%` } as CSSProperties} /></span>
              </span>
              <span className="nx-home-row__meta">{formatCount(row.replied)} replies</span>
            </button>
          ))}
        </div>
      )
    }, 3)}
  </ModuleCard>
)

// ── Live activity ───────────────────────────────────────────────────────────

interface ActivityEntry {
  id: string
  tone: 'good' | 'warn' | 'bad' | 'neutral'
  title: string
  detail: string
  at: string | null
  onClick: () => void
}

const NOTIFICATION_TONE: Record<NotificationEvent['severity'], ActivityEntry['tone']> = {
  positive: 'good',
  neutral: 'neutral',
  warning: 'warn',
  critical: 'bad',
}

export const ActivityModule = ({
  index,
  compact,
  signals,
  notifications,
  notificationsReady,
}: {
  index: number
  compact: boolean
  signals: HomeSignals
  notifications: NotificationEvent[]
  notificationsReady: boolean
}) => {
  const inbox = dataOf(signals.inbox)
  const entries = useMemo<ActivityEntry[]>(() => {
    const fromNotifications = notifications
      .filter((event) => event.status !== 'dismissed')
      .map((event): ActivityEntry => ({
        id: `n-${event.id}`,
        tone: NOTIFICATION_TONE[event.severity],
        title: event.title,
        detail: event.summary || event.body,
        at: event.createdAt,
        onClick: () => goTo(notificationPath(event)),
      }))
    const notifiedThreads = new Set(notifications.map((event) => event.threadKey).filter(Boolean))
    const fromReplies = (inbox?.threads ?? [])
      .filter((thread) => thread.at && !notifiedThreads.has(thread.threadKey))
      .map((thread): ActivityEntry => ({
        id: `r-${thread.id}`,
        tone: thread.hot ? 'warn' : 'good',
        title: `${thread.seller} replied`,
        detail: thread.preview || thread.address || '',
        at: thread.at,
        onClick: () => openThread(thread),
      }))
    return [...fromNotifications, ...fromReplies]
      .sort((a, b) => new Date(b.at ?? 0).getTime() - new Date(a.at ?? 0).getTime())
      .slice(0, compact ? 3 : 6)
  }, [compact, inbox?.threads, notifications])

  const settled = notificationsReady || signals.inbox.status !== 'loading'

  return (
    <ModuleCard title="Live activity" index={index} compact={compact} link={{ label: 'All', onClick: openNotifications }}>
      {entries.length > 0 ? (
        <ul className="nx-home-feed" aria-live="polite">
          {entries.map((entry, i) => (
            <li key={entry.id} className="nx-home-feed__item" style={{ animationDelay: `${i * 40}ms` }}>
              <span className={cls('nx-home-dot', entry.tone !== 'neutral' && `is-${entry.tone}`, i === 0 && 'is-live')} aria-hidden />
              <button type="button" className="nx-home-feed__text" onClick={entry.onClick} style={{ textAlign: 'left', padding: 0 }}>
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
