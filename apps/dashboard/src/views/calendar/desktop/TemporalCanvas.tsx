import { memo, useMemo, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { Icon } from '../../../shared/icons'
import { LCPopover, cx } from '../../../shared/lc'
import type { DeskBrief, DeskEvent } from '../../../domain/calendar/calendar-timeline-api'
import { humanReason } from '../../../domain/calendar/calendar-timeline-api'
import {
  LANES, LANE_ICON, LOAD_KEYS, axisTicks, bandDensity, eventLabel, laneLayout, laneOf, loadSeries, pct, statusOf, STATUS_LABEL, timeText, toneOf,
  type Domain, type LaneKey, type LoadKey, type Shape,
} from './temporal-model'
import { HOUR, MIN, addDays, clock, clockShort, dayBounds, dayKey, dayNum, span, weekday, zoneAbbr } from './temporal-time'

/**
 * THE TEMPORAL CANVAS — every lane against one time axis (§8–11, §72–77).
 *
 *   window    a duration band (campaign send window) with time elapsed, the
 *             queue's real send density inside it, and audience progress
 *   wait      a workflow timer: a dashed run from its anchor to the moment it
 *             resumes
 *   point     a follow-up / message / email at its instant
 *   deadline  a flag at the exact due time
 *   milestone a diamond (closing, campaign start, offer)
 *   group     a count capsule (a day's campaign texts, a burst of messages)
 *
 * Future is hollow, past is solid, completed is quiet with a check; marks that
 * would collide become one cluster. NOW is a line through every lane. Nothing
 * here moves on its own except the line, once a minute.
 */

const ROW = { band: 44, span: 28, marks: 44, allDay: 30 }

export interface CanvasProps {
  events: DeskEvent[]
  /** overdue items whose time is before this canvas, carried in per lane (today) */
  carry?: DeskEvent[]
  domain: Domain
  tz: string
  now: number
  /** single day (Today) or the multi-day Timeline */
  days: string[]
  selectedId: string | null
  arrived: ReadonlySet<string>
  next?: { system: DeskBrief | null; you: DeskBrief | null }
  widthPx: number
  onOpen: (e: DeskEvent) => void
  onZoom?: (d: Domain | null) => void
  zoomed?: boolean
  /** drag-to-reschedule result (only events the read model grants) */
  onDrop?: (e: DeskEvent, toMs: number) => void
  reduced: boolean
}

export const TemporalCanvas = memo(function TemporalCanvas(p: CanvasProps) {
  const { domain, tz, now, widthPx } = p
  const multi = domain.to - domain.from > 36 * HOUR
  const lanes = useMemo(() => laneLayout(p.events, { domain, widthPx, days: p.days }), [p.events, domain, widthPx, p.days])
  const carryBy = useMemo(() => {
    const m = new Map<LaneKey, DeskEvent[]>()
    for (const e of p.carry ?? []) { const k = laneOf(e); if (!m.has(k)) m.set(k, []); m.get(k)!.push(e) }
    return m
  }, [p.carry])
  const laneList = useMemo(() => {
    const shown = new Set(lanes.map((l) => l.key))
    const extra = LANES.filter((l) => !shown.has(l.key) && carryBy.has(l.key)).map((l) => ({ key: l.key, label: l.label, bands: [], rows: 0, spans: [], marks: [], clusters: [], allDay: [], count: 0 }))
    const order = LANES.map((l) => l.key)
    return [...lanes, ...extra].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
  }, [lanes, carryBy])
  const ticks = useMemo<Tick[]>(() => (multi ? dayTicks(domain, tz) : axisTicks(domain, tz, widthPx).map((x) => ({ ...x, major: false }))), [multi, domain, tz, widthPx])
  const load = useMemo(() => loadSeries(p.events, { domain, tz, binMinutes: multi ? 180 : 30 }), [p.events, domain, tz, multi])
  const nowIn = now >= domain.from && now <= domain.to
  const nowPct = pct(now, domain)
  const [drag, setDrag] = useState<{ id: string; at: number; ok: boolean; lead: number } | null>(null)

  const nextMarks = [p.next?.system ? { key: 'system', brief: p.next.system, label: 'Next' } : null, p.next?.you ? { key: 'you', brief: p.next.you, label: 'Yours' } : null]
    .filter((x): x is { key: string; brief: DeskBrief; label: string } => Boolean(x))
    .filter((x) => { const t = Date.parse(x.brief.at); return t >= domain.from && t <= domain.to })

  return (
    <section className={cx('tcc-canvas', multi && 'is-multi')} aria-label={multi ? 'Timeline' : 'Day canvas'} style={{ ['--now' as string]: `${nowPct}%` } as CSSProperties}>
      {/* the axis: hours (or days), the operator zone, NOW, and the next actions as first-class marks */}
      <div className="tcc-axis" aria-hidden="true">
        <div className="tcc-gutter tcc-axis__zone"><span className="lc-eyebrow">Operator · {zoneAbbr(tz)}</span></div>
        <div className="tcc-axis__track">
          {ticks.map((t) => (
            <span key={t.t} className={cx('tcc-tick', t.label && 'has-label', t.major && 'is-major')} style={{ left: `${t.pct}%` }}>
              {t.label && !(nowIn && !t.major && Math.abs(t.pct - nowPct) * widthPx / 100 < 46) ? <b>{t.text ?? clockShort(t.t, tz)}</b> : null}
            </span>
          ))}
          {nextMarks.map((n, i) => {
            const left = pct(Date.parse(n.brief.at), domain)
            // two markers near each other: the second reads leftward, never on top of the first
            const flip = i > 0 && Math.abs(left - pct(Date.parse(nextMarks[0].brief.at), domain)) * widthPx / 100 < 120
            return (
              <button key={n.key} type="button" className={cx('tcc-next', `is-${n.key}`, (flip || left > 82) && 'is-flip')} style={{ left: `${left}%` }} title={`${n.label} · ${clock(n.brief.at, tz)} · ${n.brief.title}`}
                onClick={() => { const e = p.events.find((x) => x.id === n.brief.id); if (e) p.onOpen(e) }} tabIndex={-1}>
                <i aria-hidden="true" />{multi ? null : <span>{n.label} · {clock(n.brief.at, tz)}</span>}
              </button>
            )
          })}
          {nowIn ? <span className="tcc-now__pill" style={{ left: `${nowPct}%` }}>{clock(now, tz)}</span> : null}
        </div>
      </div>

      <div className="tcc-lanes" role="list" aria-label="Temporal lanes">
        {laneList.map((lane) => {
          const carry = carryBy.get(lane.key) ?? []
          const tracks = (lane.allDay.length ? 1 : 0) + lane.rows + (lane.spans.length ? Math.max(...lane.spans.map((s) => s.row)) + 1 : 0) + (lane.marks.length || lane.clusters.length ? 1 : 0)
          const height = Math.max(carry.length ? 70 : 52, (lane.allDay.length ? ROW.allDay : 0) + lane.rows * ROW.band + (lane.spans.length ? (Math.max(...lane.spans.map((s) => s.row)) + 1) * ROW.span : 0) + (lane.marks.length || lane.clusters.length ? ROW.marks : 0))
          let y = 0
          const allDayY = y; if (lane.allDay.length) y += ROW.allDay
          const bandY = y; y += lane.rows * ROW.band
          const spanY = y; if (lane.spans.length) y += (Math.max(...lane.spans.map((s) => s.row)) + 1) * ROW.span
          const markY = y
          return (
            <div key={lane.key} className="tcc-lane" role="listitem" data-lane={lane.key} style={{ height }} aria-label={`${lane.label}: ${lane.count} on this view${carry.length ? `, ${carry.length} overdue carried in` : ''}`}>
              <div className="tcc-gutter tcc-lane__label">
                <span className="tcc-lane__head">
                  <span className="tcc-lane__glyph" aria-hidden="true"><Icon name={LANE_ICON[lane.key]} size={13} /></span>
                  <span className="tcc-lane__name">{lane.label}</span>
                  {lane.count ? <span className="tcc-lane__n">{lane.count}</span> : null}
                </span>
                {carry.length ? <CarryChip items={carry} tz={tz} now={now} onOpen={p.onOpen} /> : null}
              </div>
              <div className="tcc-lane__track" data-tracks={tracks}>
                {ticks.map((t) => <span key={t.t} className={cx('tcc-grid', t.major && 'is-major')} style={{ left: `${t.pct}%` }} aria-hidden="true" />)}
                {!tracks && carry.length ? <span className="tcc-lane__quiet">Nothing scheduled in view · {carry.length} overdue from earlier</span> : null}
                {lane.allDay.length ? (
                  <div className="tcc-allday" style={{ top: allDayY }}>
                    {multi ? groupByDate(lane.allDay).map((list) => <AllDaySpan key={list[0].id} list={list} domain={domain} tz={tz} selectedId={p.selectedId} onOpen={p.onOpen} />) : lane.allDay.map((e) => <button key={e.id} type="button" className={cx('tcc-dayfact', p.selectedId === e.id && 'is-selected')} data-tone={toneOf(e)} onClick={() => p.onOpen(e)} aria-label={eventLabel(e, tz)}>
                        <Icon name="flag" size={11} /><b>{e.title}</b>{e.subtitle || e.place ? <span>{e.subtitle || e.place}</span> : null}<em>{e.time_kind === 'due' ? 'Due · date only' : 'All day'}</em>
                      </button>)}
                  </div>
                ) : null}
                {lane.bands.map((b) => (
                  <WindowBand key={b.e.id} b={b} top={bandY + b.row * ROW.band} domain={domain} tz={tz} now={now} widthPx={widthPx}
                    selected={p.selectedId === b.e.id} arrived={p.arrived.has(b.e.id)} onOpen={p.onOpen} />
                ))}
                {lane.spans.map((s) => (
                  <button key={s.e.id} type="button" className={cx('tcc-wait', p.selectedId === s.e.id && 'is-selected', p.arrived.has(s.e.id) && 'is-arrived')} data-tone={toneOf(s.e)}
                    style={{ left: `${s.left}%`, width: `${s.width}%`, top: spanY + s.row * ROW.span }} onClick={() => p.onOpen(s.e)} aria-label={eventLabel(s.e, tz)}>
                    <span className="tcc-wait__run" aria-hidden="true" />
                    <span className={cx('tcc-wait__label', s.left + s.width > 78 && 'is-left')}>{s.e.state === 'overdue' ? 'Timer ran out' : 'Resumes'} {clock(s.e.start, tz)} · {String((s.e.detail as { workflow_name?: string })?.workflow_name || s.e.title)}</span>
                  </button>
                ))}
                {lane.marks.map((m) => (
                  <MarkObject key={m.e.id} e={m.e} shape={m.shape} left={m.left} top={markY} label={m.label} room={m.room} tz={tz} now={now} domain={domain} widthPx={widthPx}
                    selected={p.selectedId === m.e.id} arrived={p.arrived.has(m.e.id)} onOpen={p.onOpen}
                    drag={drag?.id === m.e.id ? drag : null} setDrag={setDrag} onDrop={p.onDrop} />
                ))}
                {lane.clusters.map((c) => (
                  <ClusterObject key={c.id} members={c.members} left={c.left} top={markY} tz={tz} now={now} selectedId={p.selectedId} label={c.room >= 150 ? c.label : c.room >= 70 ? clockShort(c.at, tz) : ''}
                    arrived={c.members.some((m) => p.arrived.has(m.id))} onOpen={p.onOpen} />
                ))}
              </div>
            </div>
          )
        })}
      </div>

      <LoadGraph load={load} domain={domain} tz={tz} multi={multi} onZoom={p.onZoom} zoomed={Boolean(p.zoomed)} />

      {/* NOW runs through the machine: every lane and the load graph */}
      {nowIn ? (
        <div className="tcc-nowlayer" aria-hidden="true">
          <span className="tcc-elapsed" />
          <span className="tcc-now" />
        </div>
      ) : null}
      {drag ? <div className="tcc-droptime" style={{ left: `calc(var(--tcc-gutter) + (100% - var(--tcc-gutter) - var(--tcc-pad-r)) * ${pct(drag.at, domain) / 100})` }} data-ok={drag.ok || undefined} aria-live="polite">
        {drag.ok ? `Move to ${clock(drag.at, tz)}` : `Too soon — pick a time at least ${drag.lead} min out`}
      </div> : null}
    </section>
  )
})

/** One axis tick: an hour (Today) or a day boundary (Timeline). */
interface Tick { t: number; pct: number; label: boolean; text?: string; major: boolean }

/** Day ticks for the multi-day Timeline: each local midnight, with 6-hour minor marks. */
function dayTicks(d: Domain, tz: string): Tick[] {
  const out: Tick[] = []
  let day = dayKey(d.from, tz)
  for (let i = 0; i < 12; i += 1) {
    const b = dayBounds(day, tz)
    if (b.start > d.to) break
    if (b.start >= d.from) out.push({ t: b.start, pct: pct(b.start, d), label: true, text: `${weekday(day)} ${dayNum(day)}`, major: true })
    for (const h of [6, 12, 18]) {
      const t = b.start + h * HOUR
      if (t > d.from && t < d.to && t < b.end) out.push({ t, pct: pct(t, d), label: false, major: false })
    }
    day = addDays(day, 1)
  }
  return out
}

/* ── window band ─────────────────────────────────────────────────────── */

function WindowBand({ b, top, domain, tz, now, widthPx, selected, arrived, onOpen }: {
  b: ReturnType<typeof laneLayout>[number]['bands'][number]; top: number; domain: Domain; tz: string; now: number; widthPx: number; selected: boolean; arrived: boolean; onOpen: (e: DeskEvent) => void
}) {
  const e = b.e
  const d = e.detail as { eligible?: number | null; sent?: number | null; remaining?: number | null; scheduled?: number | null; committed?: number | null; day_index?: number; projected_days?: number; daily_pace?: number; halted?: string | null; feeder?: { reason?: string | null; at?: string | null } | null }
  const s = Date.parse(e.start)
  const end = Date.parse(e.end || e.start)
  const parts = String(e.subtitle || 'Campaign').split(' · ')
  const name = parts.length > 1 ? parts[1] : parts[0]
  const kind = parts.length > 1 ? [parts[0], ...parts.slice(2)].join(' · ') : null
  const day = (e.source_id || '').split(':').pop() || dayKey(s, tz)
  const density = bandDensity(b.sends, { domain, tz, day })
  // time elapsed inside the window (not audience progress — that is the meter)
  const elapsed = now <= s ? 0 : now >= end ? 100 : ((now - s) / (end - s)) * 100
  const eligible = Number(d?.eligible ?? 0)
  const sent = Number(d?.sent ?? 0)
  const audience = eligible > 0 ? Math.min(100, (sent / eligible) * 100) : null
  const px = (b.width / 100) * widthPx
  const sendsDetail = b.sends?.detail as { next_send_at?: string | null; counts?: { scheduled?: number; sent?: number; blocked?: number } } | undefined
  const nextSend = sendsDetail?.next_send_at ? Date.parse(sendsDetail.next_send_at) : null
  const t = timeText(e, tz)
  return (
    <button type="button" className={cx('tcc-band', selected && 'is-selected', arrived && 'is-arrived', b.clipped.start && 'is-clip-start', b.clipped.end && 'is-clip-end')}
      data-state={e.state} data-tone={toneOf(e)} data-size={px < 90 ? 'xs' : px < 300 ? 's' : px < 660 ? 'm' : 'l'} title={px < 300 ? `${name} · ${t.main}` : undefined}
      style={{ left: `${b.left}%`, width: `${b.width}%`, top }} onClick={() => onOpen(e)} aria-label={`${eventLabel(e, tz)}. ${sent} sent of ${eligible} eligible.`}>
      <span className="tcc-band__elapsed" style={{ width: `${elapsed}%` }} aria-hidden="true" />
      {density.bars.length ? (
        <span className="tcc-band__density" aria-hidden="true">
          {density.bars.map((bar, i) => {
            const left = ((bar.left - b.left) / b.width) * 100
            const w = (bar.width / b.width) * 100
            if (left + w < 0 || left > 100) return null
            const h = (n: number) => `${(n / density.max) * 100}%`
            return (
              <span key={i} className="tcc-band__slot" style={{ left: `${left}%`, width: `${w}%` }}>
                {bar.failed ? <i className="is-failed" style={{ height: h(bar.failed) }} /> : null}
                {bar.waiting ? <i className="is-waiting" style={{ height: h(bar.waiting) }} /> : null}
                {bar.done ? <i className="is-done" style={{ height: h(bar.done) }} /> : null}
              </span>
            )
          })}
        </span>
      ) : null}
      {nextSend && nextSend > s && nextSend < end ? <span className="tcc-band__next" style={{ left: `${((nextSend - s) / (end - s)) * 100}%` }} title={`Next queued send ${clock(nextSend, tz)}`} aria-hidden="true" /> : null}
      <span className="tcc-band__text">
        <span className="tcc-band__name">{name}</span>
        {kind ? <span className="tcc-band__kind">{kind}</span> : null}
        <span className="tcc-band__time">{t.main}{t.alt ? <em> · {t.alt}</em> : null}</span>
      </span>
      <span className="tcc-band__facts">
        {e.state === 'live' ? <span className="tcc-band__live"><i aria-hidden="true" />Sending</span> : e.state === 'completed' ? <span>Closed</span> : <span>Opens {clockShort(s, tz)}</span>}
        <span><b>{sent.toLocaleString('en-US')}</b> sent</span>
        <span><b>{Number(d?.remaining ?? 0).toLocaleString('en-US')}</b> ready</span>
        <span><b>{Number(d?.scheduled ?? 0).toLocaleString('en-US')}</b> queued</span>
        {d?.projected_days && d.projected_days > 1 ? <span>Day {d.day_index} of {d.projected_days}</span> : null}
      </span>
      {audience !== null ? <span className="tcc-band__meter" aria-hidden="true"><i style={{ width: `${audience}%` }} /></span> : null}
    </button>
  )
}

/* ── marks ───────────────────────────────────────────────────────────── */

const SHAPE_GLYPH: Record<Shape, string> = { window: '', point: 'tcc-g-point', deadline: 'tcc-g-flag', milestone: 'tcc-g-diamond', wait: 'tcc-g-ring', group: 'tcc-g-capsule' }

function markTitle(e: DeskEvent) {
  if (e.type === 'campaign_sends') return `${e.count.toLocaleString('en-US')} texts`
  if (e.type === 'scheduled_message_group') return e.title
  return e.subtitle || e.title
}

function MarkObject({ e, shape, left, top, label, room, tz, now, domain, widthPx, selected, arrived, onOpen, drag, setDrag, onDrop }: {
  e: DeskEvent; shape: Shape; left: number; top: number; label: boolean; room: number; tz: string; now: number; domain: Domain; widthPx: number; selected: boolean; arrived: boolean
  onOpen: (e: DeskEvent) => void; drag: { at: number; ok: boolean; lead: number } | null; setDrag: (d: { id: string; at: number; ok: boolean; lead: number } | null) => void; onDrop?: (e: DeskEvent, toMs: number) => void
}) {
  const movable = Boolean(e.actions?.reschedule && onDrop)
  const at = Date.parse(e.start)
  const past = at < now
  const lead = (e.actions?.reschedule?.min_lead_minutes ?? 10) * MIN
  const [origin, setOrigin] = useState<{ x: number; moved: boolean } | null>(null)
  const onDown = (ev: ReactPointerEvent<HTMLButtonElement>) => {
    if (!movable || ev.button !== 0) return
    ev.currentTarget.setPointerCapture(ev.pointerId)
    setOrigin({ x: ev.clientX, moved: false })
  }
  const onMove = (ev: ReactPointerEvent<HTMLButtonElement>) => {
    if (!origin) return
    const dx = ev.clientX - origin.x
    if (!origin.moved && Math.abs(dx) < 4) return
    if (!origin.moved) setOrigin({ ...origin, moved: true })
    // snap to 5 minutes on the visible axis
    const raw = at + (dx / Math.max(1, widthPx)) * (domain.to - domain.from)
    const snapped = Math.round(raw / (5 * MIN)) * 5 * MIN
    setDrag({ id: e.id, at: snapped, ok: snapped - Date.now() > lead && Date.parse(e.start) - Date.now() > lead, lead: lead / MIN })
  }
  const onUp = () => {
    if (!origin) return
    const moved = origin.moved
    setOrigin(null)
    const target = drag
    setDrag(null)
    if (moved && target && target.ok && Math.abs(target.at - at) >= 5 * MIN) onDrop?.(e, target.at)
  }
  const shownLeft = drag ? pct(drag.at, domain) : left
  return (
    <button type="button"
      className={cx('tcc-mark', SHAPE_GLYPH[shape], past && 'is-past', e.history && 'is-history', selected && 'is-selected', arrived && 'is-arrived', movable && 'is-movable', drag && 'is-lifted', label && 'has-label')}
      data-state={e.state} data-tone={toneOf(e)} data-owner={e.owner === 'you' ? 'you' : e.owner === 'system' ? 'system' : 'external'}
      style={{ left: `${shownLeft}%`, top }}
      onClick={() => { if (!origin?.moved) onOpen(e) }}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => { setOrigin(null); setDrag(null) }}
      aria-label={`${eventLabel(e, tz)}${movable ? '. Drag to reschedule.' : ''}`}>
      <span className="tcc-mark__glyph" aria-hidden="true">{e.state === 'completed' ? <Icon name="check" size={9} strokeWidth={2.4} /> : null}</span>
      {label ? (
        <span className="tcc-mark__label" style={{ maxWidth: Math.min(260, room) }}>
          <b>{clockShort(at, tz)}</b>
          {room >= 96 ? <span>{markTitle(e)}</span> : null}
          {e.owner === 'you' && !e.history && room >= 140 ? <em className="tcc-you">You</em> : null}
        </span>
      ) : null}
    </button>
  )
}

function ClusterObject({ members, left, top, tz, now, selectedId, label, arrived, onOpen }: {
  members: DeskEvent[]; left: number; top: number; tz: string; now: number; selectedId: string | null; label: string; arrived: boolean; onOpen: (e: DeskEvent) => void
}) {
  const [open, setOpen] = useState(false)
  const at = Date.parse(members[0].start)
  const attn = members.some((m) => m.attention && !m.history)
  const done = members.every((m) => m.history)
  return (
    <LCPopover open={open} onOpenChange={setOpen} side="bottom" align="center" material="smoke" width={340} label={`${clock(at, tz)} · ${members.length} actions`}
      trigger={
        <button type="button" className={cx('tcc-cluster', at < now && 'is-past', done && 'is-history', arrived && 'is-arrived', members.some((m) => m.id === selectedId) && 'is-selected')}
          data-tone={attn ? 'attn' : 'exec'} style={{ left: `${left}%`, top }} aria-label={`${clock(at, tz)}, ${members.length} actions — expand`}>
          <b className="tcc-cluster__n">{members.length}</b>
          {label ? <span className="tcc-cluster__label">{label.includes('actions') ? `${clockShort(at, tz)} · ${label}` : label}</span> : null}
        </button>
      }>
      <div className="tcc-pop">
        <header className="tcc-pop__head"><span className="lc-eyebrow">{clock(at, tz)} · {members.length} actions</span></header>
        <ul className="tcc-pop__list">
          {members.map((m) => (
            <li key={m.id}>
              <button type="button" className={cx('tcc-pop__row', m.id === selectedId && 'is-selected')} onClick={() => { setOpen(false); onOpen(m) }}>
                <span className="tcc-dot" data-tone={toneOf(m)} aria-hidden="true" />
                <span className="tcc-pop__main"><b>{m.subtitle || m.title}</b><em>{m.title}{m.place ? ` · ${m.place}` : ''}</em></span>
                <span className="tcc-pop__when">{clock(m.start, tz)}<em>{STATUS_LABEL[statusOf(m)]}</em></span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </LCPopover>
  )
}

/** Overdue items from before this canvas, carried in at the lane's edge (§75). */
function CarryChip({ items, tz, now, onOpen }: { items: DeskEvent[]; tz: string; now: number; onOpen: (e: DeskEvent) => void }) {
  const [open, setOpen] = useState(false)
  const missed = items.filter((e) => statusOf(e) === 'missed').length
  const word = missed === items.length ? 'missed' : 'overdue'
  return (
    <LCPopover open={open} onOpenChange={setOpen} side="right" align="start" material="smoke" width={360} label={`${items.length} ${word}`}
      trigger={<button type="button" className="tcc-carry" aria-label={`${items.length} ${word} from earlier — list`}><Icon name="alert" size={11} />{items.length} {word}</button>}>
      <div className="tcc-pop">
        <header className="tcc-pop__head"><span className="lc-eyebrow">Carried into today · {items.length} {word}</span></header>
        <ul className="tcc-pop__list">
          {[...items].sort((a, b) => Date.parse(a.start || '') - Date.parse(b.start || '')).map((m) => (
            <li key={m.id}>
              <button type="button" className="tcc-pop__row" onClick={() => { setOpen(false); onOpen(m) }}>
                <span className="tcc-dot" data-tone={toneOf(m)} aria-hidden="true" />
                <span className="tcc-pop__main"><b>{m.subtitle || m.title}</b><em>{humanReason(m.reason) || m.title}</em></span>
                <span className="tcc-pop__when">{m.undated ? 'No date' : `${statusOf(m) === 'missed' ? 'Missed' : 'Overdue'} ${span(now - Date.parse(m.start))}`}<em>{m.undated ? '' : `${weekday(dayKey(m.start, tz))} ${clock(m.start, tz)}`}</em></span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </LCPopover>
  )
}

const groupByDate = (list: DeskEvent[]) => {
  const m = new Map<string, DeskEvent[]>()
  for (const e of list) { const k = e.date || ''; if (!m.has(k)) m.set(k, []); m.get(k)!.push(e) }
  return [...m.values()]
}

/** One day-long span per date (several date-only facts on a day read as one, opening the first). */
function AllDaySpan({ list, domain, tz, selectedId, onOpen }: { list: DeskEvent[]; domain: Domain; tz: string; selectedId: string | null; onOpen: (e: DeskEvent) => void }) {
  const e = list[0]
  const b = dayBounds(e.date as string, tz)
  const left = Math.max(0, pct(b.start, domain))
  const right = Math.min(100, pct(b.end, domain))
  if (right <= 0 || left >= 100) return null
  const tone = list.some((x) => toneOf(x) === 'crit') ? 'crit' : list.some((x) => toneOf(x) === 'attn') ? 'attn' : toneOf(e)
  return (
    <button type="button" className={cx('tcc-dayspan', list.some((x) => x.id === selectedId) && 'is-selected')} data-tone={tone} style={{ left: `${left}%`, width: `${right - left}%` }} onClick={() => onOpen(e)}
      aria-label={list.map((x) => eventLabel(x, tz)).join('; ')} title={list.map((x) => `${x.title}${x.subtitle ? ` · ${x.subtitle}` : ''}`).join('\n')}>
      <Icon name="flag" size={10} /><span>{list.length === 1 ? e.title : `${list.length} date-only deadlines`}</span>
    </button>
  )
}

/* ── operations load (§66–68, §132) ──────────────────────────────────── */

const LOAD_WORD: Record<LoadKey, string> = { campaigns: 'Campaign texts', sellers: 'Seller actions', workflows: 'Workflow', deals: 'Deals', closings: 'Closings', email: 'Email' }

function LoadGraph({ load, domain, tz, multi, onZoom, zoomed }: { load: ReturnType<typeof loadSeries>; domain: Domain; tz: string; multi: boolean; onZoom?: (d: Domain | null) => void; zoomed: boolean }) {
  const [hover, setHover] = useState<number | null>(null)
  const present = LOAD_KEYS.filter((k) => load.bins.some((b) => b.values[k] > 0))
  const h = 52
  const bin = hover !== null ? load.bins[hover] : null
  const label = (b: { from: number; to: number }) => (multi ? `${weekday(dayKey(b.from, tz))} ${clockShort(b.from, tz)}–${clockShort(b.to, tz)}` : `${clock(b.from, tz)}–${clock(b.to, tz)}`)
  let readout: ReactNode
  if (bin) {
    readout = (
      <>
        <b>{label(bin)}</b>
        {bin.total ? present.filter((k) => bin.values[k]).map((k) => <span key={k} data-k={k}><i aria-hidden="true" />{bin.values[k].toLocaleString('en-US')} {LOAD_WORD[k].toLowerCase()}</span>) : <span>Nothing timed in this {load.binMinutes >= 60 ? `${load.binMinutes / 60}-hour` : `${load.binMinutes}-minute`} slot</span>}
        {onZoom && bin.total ? <em>Click to focus this interval</em> : null}
      </>
    )
  } else if (load.peak) {
    readout = <><b>Busiest {label(load.peak)}</b><span>{load.peak.total.toLocaleString('en-US')} timed actions</span>{present.map((k) => <span key={k} data-k={k} className="is-legend"><i aria-hidden="true" />{LOAD_WORD[k]}</span>)}</>
  } else {
    readout = <span>{load.coverage.length ? 'No timed actions in view — campaign windows shown as coverage' : 'No timed actions in view'}</span>
  }
  return (
    <div className="tcc-load" role="group" aria-label="Operations load">
      <div className="tcc-gutter tcc-load__label">
        <span className="lc-eyebrow">Load</span>
        {zoomed && onZoom ? <button type="button" className="tcc-load__reset" onClick={() => onZoom(null)}>Reset</button> : null}
      </div>
      <div className="tcc-load__track" onPointerLeave={() => setHover(null)}>
        <p className="tcc-load__readout" aria-live="polite" title={`Timed actions per ${load.binMinutes}-minute slot. Campaign texts are the queue's own per-row schedule; each other event counts once at its time; windows are drawn as coverage, not load.`}>{readout}</p>
        <svg className="tcc-load__svg" viewBox={`0 0 1000 ${h}`} preserveAspectRatio="none" aria-hidden="true">
          {load.coverage.map((c, i) => <rect key={`c${i}`} className="tcc-load__cov" x={pct(c.from, domain) * 10} y={h - 3} width={Math.max(1, (pct(c.to, domain) - pct(c.from, domain)) * 10)} height={3} />)}
          {load.bins.map((b, i) => {
            const x = pct(b.from, domain) * 10
            const w = Math.max(1, (pct(b.to, domain) - pct(b.from, domain)) * 10 - 2)
            let y = h - 4
            return (
              <g key={i} className={cx('tcc-load__bin', hover === i && 'is-hover')}>
                {present.map((k) => {
                  const v = b.values[k]
                  if (!v || !load.max) return null
                  const bh = Math.max(1.5, (v / load.max) * (h - 8))
                  y -= bh
                  return <rect key={k} data-k={k} x={x + 1} y={y} width={w} height={bh} rx={1.5} />
                })}
              </g>
            )
          })}
        </svg>
        <div className="tcc-load__hits">
          {load.bins.map((b, i) => (
            <button key={i} type="button" tabIndex={-1} className="tcc-load__hit" style={{ left: `${pct(b.from, domain)}%`, width: `${pct(b.to, domain) - pct(b.from, domain)}%` }}
              onPointerEnter={() => setHover(i)} onFocus={() => setHover(i)}
              onClick={() => { if (onZoom && b.total) onZoom({ from: Math.max(domain.from, b.from - (multi ? 6 : 1) * HOUR), to: Math.min(domain.to, b.to + (multi ? 6 : 1) * HOUR) }) }}
              aria-label={`${label(b)}: ${b.total} timed actions`} />
          ))}
        </div>
      </div>
    </div>
  )
}
