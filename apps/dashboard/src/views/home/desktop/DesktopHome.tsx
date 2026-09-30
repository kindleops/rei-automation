import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Icon, type IconName } from '../../../shared/icons'
import { useNotificationIntelligence } from '../../../domain/notifications/useNotificationIntelligence'
import { useOperatorName } from '../../../shared/useOperatorName'
import { resolveSystemState, useHomeSignals } from '../useHomeSignals'
import { buildFocusItems, dataOf, formatCount, greetingFor, relativeTime, type HomeLoad } from '../home-signals'
import { buildActivity } from '../home-activity'
import { goTo, openTarget, openThread } from '../home-navigation'
import { fetchZones, localClock, windowTone, type ZonesResponse } from '../../map/world/world-api'
import { WIDGETS, useDesktopHomeLayout, type WidgetId, type WidgetSize } from './desktop-home-layout'
import './desktop-home.css'

/**
 * HOME — THE DESKTOP DASHBOARD.
 *
 * A board of widgets the operator arranges: drag to reorder, S/M/L/XL width,
 * remove, add back from the catalog. Every figure comes from the same honest
 * sources the phone's Home reads (useHomeSignals): a source that is still
 * loading says so, one that failed says it is unavailable — nothing is
 * estimated to fill a tile.
 */

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')
const SIZES: Array<{ w: WidgetSize; label: string }> = [{ w: 4, label: 'S' }, { w: 6, label: 'M' }, { w: 8, label: 'L' }, { w: 12, label: 'XL' }]

function useMinute() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => { const t = window.setInterval(() => setNow(new Date()), 30_000); return () => window.clearInterval(t) }, [])
  return now
}

/** The board's refresh, so a widget that could not load can offer to try again. */
const HomeRetry = createContext<(() => void) | null>(null)

/** Loading / unavailable envelope for a widget body. */
function Gate<T>({ load, children }: { load: HomeLoad<T>; children: (data: T) => ReactNode }) {
  const retry = useContext(HomeRetry)
  if (load.status === 'loading') return <div className="dh-skel"><i /><i /><i /></div>
  if (load.status === 'unavailable') {
    return (
      <div className="dh-unavail" role="status">
        <Icon name="alert-circle" size={18} />
        <strong>Couldn’t load</strong>
        <small>{load.reason}</small>
        {retry ? <button type="button" className="dh-btn is-ghost dh-unavail__retry" onClick={() => retry()}>Try again</button> : null}
      </div>
    )
  }
  return <>{children(load.data)}</>
}

function Stat({ label, value, tone, hint }: { label: string; value: string; tone?: 'good' | 'warn' | 'bad'; hint?: string }) {
  return (
    <div className={cls('dh-stat', tone && `is-${tone}`)} title={hint}>
      <b>{value}</b>
      <span>{label}</span>
    </div>
  )
}

function Row({ icon, title, detail, meta, tone, onClick }: { icon?: IconName; title: string; detail?: string | null; meta?: string | null; tone?: string; onClick?: () => void }) {
  return (
    <button type="button" className={cls('dh-row', tone && `is-${tone}`)} onClick={onClick} disabled={!onClick}>
      {icon ? <span className="dh-row__icon"><Icon name={icon} size={13} /></span> : <span className="dh-row__dot" />}
      <span className="dh-row__copy"><strong>{title}</strong>{detail ? <small>{detail}</small> : null}</span>
      {meta ? <em>{meta}</em> : null}
    </button>
  )
}

export function DesktopHome() {
  const now = useMinute()
  const name = useOperatorName()
  const { signals, refresh, refreshing } = useHomeSignals()
  const { notifications } = useNotificationIntelligence()
  const { slots, move, resize, remove, add, reset } = useDesktopHomeLayout()
  const [editing, setEditing] = useState(false)
  const [catalog, setCatalog] = useState(false)
  const [drag, setDrag] = useState<WidgetId | null>(null)
  const [over, setOver] = useState<{ id: WidgetId; after: boolean } | null>(null)
  const [zones, setZones] = useState<HomeLoad<ZonesResponse>>({ status: 'loading' })

  useEffect(() => {
    if (!slots.some((s) => s.id === 'windows')) return
    let live = true
    const load = () => fetchZones().then((z) => { if (live) setZones({ status: 'ready', data: z, at: Date.now() }) }, (e: unknown) => { if (live) setZones({ status: 'unavailable', reason: e instanceof Error ? e.message : 'Unavailable' }) })
    load()
    const t = window.setInterval(load, 5 * 60_000)
    return () => { live = false; window.clearInterval(t) }
  }, [slots])

  const system = resolveSystemState(signals)
  const inbox = dataOf(signals.inbox)
  const focus = useMemo(() => buildFocusItems({
    inbox, queue: dataOf(signals.queue), campaigns: dataOf(signals.campaigns), pipeline: dataOf(signals.pipeline),
    closings: dataOf(signals.closings), notifications, now: now.getTime(),
  }), [inbox, signals.queue, signals.campaigns, signals.pipeline, signals.closings, notifications, now])
  const activity = useMemo(() => buildActivity(notifications, inbox, 10), [notifications, inbox])
  // "Nothing is waiting on you" is a claim about every source the list reads — only make it when they all loaded.
  const focusSources = [['Inbox', signals.inbox], ['Queue', signals.queue], ['Campaigns', signals.campaigns], ['Pipeline', signals.pipeline], ['Closings', signals.closings]] as const
  const focusDown = focusSources.filter(([, s]) => s.status === 'unavailable').map(([label]) => label)
  const focusLoading = focusSources.some(([, s]) => s.status === 'loading')

  // FLIP: widgets glide to their new place after a reorder or resize.
  const gridRef = useRef<HTMLDivElement | null>(null)
  const rects = useRef(new Map<string, DOMRect>())
  useLayoutEffect(() => {
    const grid = gridRef.current
    if (!grid) return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    grid.querySelectorAll<HTMLElement>('[data-widget]').forEach((el) => {
      const id = el.dataset.widget as string
      const prev = rects.current.get(id)
      const next = el.getBoundingClientRect()
      rects.current.set(id, next)
      if (!prev || reduce) return
      const dx = prev.left - next.left
      const dy = prev.top - next.top
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 320, easing: 'cubic-bezier(0.25, 0.8, 0.25, 1)' })
    })
  }, [slots])

  const hidden = (Object.keys(WIDGETS) as WidgetId[]).filter((id) => !slots.some((s) => s.id === id))

  const body = (id: WidgetId): ReactNode => {
    switch (id) {
      case 'status':
        return (
          <Gate load={signals.queue}>{(q) => (
            <div className="dh-status">
              <div className={cls('dh-status__state', `is-${system.tone}`)}><i /><span>{system.label}</span></div>
              <div className="dh-stats dh-stats--3">
                <Stat label="Sent today" value={formatCount(q.sentToday)} />
                <Stat label="In flight" value={formatCount(q.inFlight)} />
                <Stat label="Failed" value={formatCount(q.failedToday)} tone={q.failedToday > 0 ? 'bad' : undefined} />
              </div>
              <p className="dh-foot">{q.latestSentAt ? `Last send ${relativeTime(q.latestSentAt, now.getTime())} ago` : 'No sends recorded today'}{q.lagging > 0 ? ` · ${formatCount(q.lagging)} behind the lag window` : ''}</p>
            </div>
          )}</Gate>
        )
      case 'today':
        return (
          <Gate load={signals.messaging}>{(m) => (
            <div className="dh-stats dh-stats--5">
              <Stat label="Sent" value={formatCount(m.sent)} />
              <Stat label="Delivered" value={formatCount(m.delivered)} />
              <Stat label="Delivery rate" value={m.deliveryRate === null || !m.sent ? '—' : `${m.deliveryRate.toFixed(1)}%`} hint={!m.sent ? 'No sends yet today' : undefined} />
              <Stat label="Replies" value={formatCount(m.replies)} />
              <Stat label="Failed" value={formatCount(m.failed)} tone={(m.failed ?? 0) > 0 ? 'bad' : undefined} />
            </div>
          )}</Gate>
        )
      case 'focus':
        if (focus.length) {
          return (
            <>
              <div className="dh-list">
                {focus.slice(0, 7).map((f) => (
                  <Row key={f.id} icon={f.icon} title={f.title} detail={`${f.app} · ${f.detail}`} meta={relativeTime(f.at, now.getTime()) || null} tone={f.tone} onClick={() => openTarget(f.target)} />
                ))}
              </div>
              {focusDown.length ? <p className="dh-foot">{focusDown.join(', ')} didn’t load — there may be more.</p> : null}
            </>
          )
        }
        if (focusLoading) return <div className="dh-skel"><i /><i /><i /></div>
        if (focusDown.length) {
          return (
            <div className="dh-unavail" role="status">
              <Icon name="alert-circle" size={18} />
              <strong>Couldn’t check everything</strong>
              <small>{focusDown.join(', ')} didn’t load</small>
              <button type="button" className="dh-btn is-ghost dh-unavail__retry" onClick={() => refresh()}>Try again</button>
            </div>
          )
        }
        return <p className="dh-empty"><Icon name="check" size={14} /> Nothing is waiting on you.</p>
      case 'replies':
        return (
          <Gate load={signals.inbox}>{(i) => i.threads.length ? (
            <div className="dh-list">
              {i.threads.slice(0, 7).map((t) => (
                <Row key={t.id} title={t.seller} detail={t.preview || t.address} meta={relativeTime(t.at, now.getTime()) || null} tone={t.hot ? 'hot' : t.unread ? 'unread' : undefined} onClick={() => openThread(t)} />
              ))}
            </div>
          ) : <p className="dh-empty"><Icon name="inbox" size={14} /> No new replies.</p>}</Gate>
        )
      case 'pipeline':
        return (
          <Gate load={signals.pipeline}>{(p) => {
            const total = p.buckets.reduce((a, b) => a + b.count, 0)
            return (
              <div className="dh-pipe">
                <div className="dh-pipe__head"><b>{formatCount(p.active)}</b><span>active deals</span></div>
                <div className="dh-pipe__bar" role="img" aria-label="Deals by stage">
                  {p.buckets.map((b) => <i key={b.id} style={{ flexGrow: Math.max(b.count, total ? 0 : 1), ['--seg' as string]: b.color }} title={`${b.label}: ${b.count}`} />)}
                </div>
                <div className="dh-pipe__legend">
                  {p.buckets.map((b) => <span key={b.id}><i style={{ ['--seg' as string]: b.color }} />{b.label}<b>{b.count}</b></span>)}
                </div>
                <div className="dh-stats dh-stats--3 dh-stats--quiet">
                  <Stat label="Follow-ups due" value={formatCount(p.followUpsDue)} tone={(p.followUpsDue ?? 0) > 0 ? 'warn' : undefined} />
                  <Stat label="Offers out" value={formatCount(p.offers)} />
                  <Stat label="Under contract" value={formatCount(p.underContract)} />
                </div>
              </div>
            )
          }}</Gate>
        )
      case 'campaigns':
        return (
          <Gate load={signals.campaigns}>{(c) => (
            <div className="dh-camps">
              <div className="dh-stats dh-stats--3 dh-stats--quiet">
                <Stat label="Live" value={formatCount(c.live)} tone={c.live > 0 ? 'good' : undefined} />
                <Stat label="Paused" value={formatCount(c.paused)} />
                <Stat label="Ready targets" value={formatCount(c.readyTargets)} />
              </div>
              <div className="dh-list">
                {(c.attention.length ? c.attention : c.highlighted).slice(0, 3).map((k) => (
                  <Row key={k.id} icon="bolt" title={k.name} detail={k.issue || `${formatCount(k.sent)} sent · ${formatCount(k.replies)} replies`} meta={k.market} tone={k.issue ? 'warn' : undefined} onClick={() => goTo('/campaign-command')} />
                ))}
              </div>
            </div>
          )}</Gate>
        )
      case 'agenda':
        return (
          <Gate load={signals.calendar}>{(cal) => {
            const items = cal.days.flatMap((d) => d.agenda.map((a) => ({ ...a, day: d.date }))).slice(0, 6)
            return items.length ? (
              <div className="dh-list">
                {cal.overdue > 0 ? <Row icon="alert" title={`${cal.overdue} overdue`} tone="warn" onClick={() => goTo('/calendar')} /> : null}
                {items.map((a) => (
                  <Row key={a.id} icon="calendar" title={a.title} detail={a.who} meta={a.allDay ? a.day.toLocaleDateString(undefined, { weekday: 'short' }) : new Date(a.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} tone={a.overdue ? 'warn' : a.hot ? 'hot' : undefined} onClick={() => goTo('/calendar')} />
                ))}
              </div>
            ) : <p className="dh-empty"><Icon name="calendar" size={14} /> Nothing scheduled in the next three days.</p>
          }}</Gate>
        )
      case 'closings':
        return (
          <Gate load={signals.closings}>{(c) => (
            <div>
              <div className="dh-stats dh-stats--2">
                <Stat label="Under contract" value={formatCount(c.underContract)} />
                <Stat label="Closing this week" value={formatCount(c.closingsThisWeek)} />
                <Stat label="Title blocked" value={formatCount(c.titleBlocked)} tone={(c.titleBlocked ?? 0) > 0 ? 'warn' : undefined} />
                <Stat label="Action required" value={formatCount(c.actionRequired)} tone={(c.actionRequired ?? 0) > 0 ? 'warn' : undefined} />
              </div>
              {c.next ? <Row icon="file-text" title={c.next.name} detail={c.next.address} meta={new Date(c.next.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} onClick={() => goTo('/closing-desk')} /> : null}
            </div>
          )}</Gate>
        )
      case 'markets':
        return (
          <Gate load={signals.markets}>{(rows) => rows.length ? (
            <table className="dh-table">
              <thead><tr><th>Market</th><th>Sent</th><th>Replied</th><th>Positive</th></tr></thead>
              <tbody>{rows.slice(0, 6).map((r) => <tr key={`${r.market}-${r.state}`}><td>{r.market}</td><td>{formatCount(r.sent)}</td><td>{formatCount(r.replied)}</td><td>{formatCount(r.positive)}</td></tr>)}</tbody>
            </table>
          ) : <p className="dh-empty">No market activity yet.</p>}</Gate>
        )
      case 'activity':
        return activity.length ? (
          <div className="dh-list">
            {activity.map((a) => <Row key={a.id} title={a.title} detail={a.detail} meta={relativeTime(a.at, now.getTime()) || null} tone={a.tone} onClick={() => openTarget(a.target)} />)}
          </div>
        ) : <p className="dh-empty">No activity yet today.</p>
      case 'windows':
        return (
          <Gate load={zones}>{(z) => (
            <div className="dh-zones">
              {z.zones.map((zone) => {
                const tone = windowTone(zone.contact_window, now.getTime())
                return (
                  <div key={zone.iana} className={cls('dh-zone', `is-${tone}`)}>
                    <span>{zone.label}</span>
                    <b>{localClock(zone.iana, now)}</b>
                    <em>{tone === 'quiet' ? 'Quiet' : tone === 'closing' ? 'Closing' : tone === 'open' ? 'Open' : '—'}</em>
                  </div>
                )
              })}
            </div>
          )}</Gate>
        )
      default:
        return null
    }
  }

  const link: Partial<Record<WidgetId, string>> = { replies: '/inbox', pipeline: '/pipeline', campaigns: '/campaign-command', agenda: '/calendar', closings: '/closing-desk', markets: '/analytics', status: '/queue', windows: '/map' }

  return (
    <HomeRetry.Provider value={refresh}>
    <div className={cls('dh', editing && 'is-editing')}>
      <header className="dh-head">
        <div>
          <h1>{greetingFor(now)}{name ? `, ${name}` : ''}</h1>
          <p>
            {now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
            <span className={cls('dh-head__state', `is-${system.tone}`)}><i />{system.label}</span>
            {focus.length ? <span className="dh-head__need">{focus.length} need{focus.length === 1 ? 's' : ''} you</span> : null}
          </p>
        </div>
        <div className="dh-head__tools">
          <button type="button" className="dh-btn is-ghost" onClick={() => refresh()} disabled={refreshing} aria-label="Refresh"><Icon name="refresh-cw" size={14} /></button>
          {editing ? <button type="button" className="dh-btn is-ghost" onClick={() => reset()}>Reset</button> : null}
          {editing ? <button type="button" className="dh-btn" onClick={() => setCatalog((v) => !v)} aria-expanded={catalog}><Icon name="grid" size={14} /> Add widget</button> : null}
          <button type="button" className={cls('dh-btn', editing && 'is-primary')} onClick={() => { setEditing((v) => !v); setCatalog(false) }}>
            {editing ? 'Done' : <><Icon name="layout-split" size={14} /> Customize</>}
          </button>
        </div>
        {catalog ? (
          <div className="dh-catalog" role="dialog" aria-label="Add a widget">
            {hidden.length ? hidden.map((id) => (
              <button key={id} type="button" className="dh-catalog__item" onClick={() => { add(id); if (hidden.length === 1) setCatalog(false) }}>
                <b>{WIDGETS[id].title}</b><small>{WIDGETS[id].hint}</small><Icon name="chevron-right" size={13} />
              </button>
            )) : <p className="dh-empty">Every widget is already on your board.</p>}
          </div>
        ) : null}
      </header>

      <div className="dh-grid" ref={gridRef}>
        {slots.map((slot, i) => {
          const meta = WIDGETS[slot.id]
          const isOver = over?.id === slot.id
          return (
            <section
              key={slot.id}
              data-widget={slot.id}
              className={cls('dh-w', drag === slot.id && 'is-dragging', isOver && (over?.after ? 'is-drop-after' : 'is-drop-before'))}
              style={{ ['--w' as string]: slot.w, ['--h' as string]: meta.rows, ['--i' as string]: i }}
              draggable={editing}
              onDragStart={(e) => { setDrag(slot.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', slot.id) }}
              onDragEnd={() => { setDrag(null); setOver(null) }}
              onDragOver={(e) => {
                if (!drag || drag === slot.id) return
                e.preventDefault()
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                setOver({ id: slot.id, after: e.clientX > r.left + r.width / 2 })
              }}
              onDrop={(e) => {
                e.preventDefault()
                if (!drag || !over) return
                const idx = slots.findIndex((s) => s.id === over.id)
                const before = over.after ? slots[idx + 1]?.id ?? null : over.id
                move(drag, before === drag ? slots[idx + 2]?.id ?? null : before)
                setDrag(null); setOver(null)
              }}
              aria-label={meta.title}
            >
              <header className="dh-w__head">
                {editing ? <span className="dh-w__grip" aria-hidden><i /><i /><i /><i /><i /><i /></span> : null}
                <h2>{meta.title}</h2>
                {!editing && link[slot.id] ? <button type="button" className="dh-w__open" onClick={() => goTo(link[slot.id] as string)} aria-label={`Open ${meta.title}`}>Open <Icon name="arrow-up-right" size={12} /></button> : null}
                {editing ? (
                  <span className="dh-w__tools">
                    <span className="dh-seg" role="radiogroup" aria-label="Width">
                      {SIZES.map((s) => <button key={s.w} type="button" role="radio" aria-checked={slot.w === s.w} className={cls(slot.w === s.w && 'is-on')} onClick={() => resize(slot.id, s.w)}>{s.label}</button>)}
                    </span>
                    <button type="button" className="dh-w__x" onClick={() => remove(slot.id)} aria-label={`Remove ${meta.title}`}><Icon name="x" size={13} /></button>
                  </span>
                ) : null}
              </header>
              <div className="dh-w__body">{body(slot.id)}</div>
            </section>
          )
        })}
        {!slots.length ? <p className="dh-empty dh-empty--board">Your board is empty. Choose <b>Customize → Add widget</b>.</p> : null}
      </div>
    </div>
    </HomeRetry.Provider>
  )
}
