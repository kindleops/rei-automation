import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { Icon } from '../../../shared/icons'
import { LCButton, LCEmpty, LCError, LCIconButton, LCInspector, LCSegmented, LCSkeleton, LCStatus, cx } from '../../../shared/lc'
import { callBackend } from '../../../lib/api/backendClient'
import { pushRoutePath } from '../../../app/router'
import { sound } from '../../../shared/sound'
import { openInspector } from '../inspector/inspector-store'
import { openApp } from '../workspace/workspace-store'
import { SYSTEM_LABEL, glyphOf, inspectorRefs, sourceNotes, toneOf, type EventsResponse, type FeedSubject, type PlatformEvent } from '../feed/feed-model'
import { buildTimeline, causalLinks, laneCounts, nearestIndex, rangeOf, stepTo, SUBJECT_NOUN, ticksFor, type ReplayRange } from './replay-model'
import { closeReplay, useReplaySubject } from './replay-store'
import './time-machine.css'

/**
 * THE TIME MACHINE — read-only replay of one subject's recorded history.
 *
 *   subject header · range 72h / 7d / 30d / custom
 *   lanes (Inbox · Queue · Campaign · Workflow · Pipeline · Closing · Alerts)
 *   ──●────●──●──────────●───  scrubber over the real time axis
 *   ◀  ▶ play  ▶▶   step player — event to event
 *   selected event: summary, provenance, deep link
 *
 * No mutation controls exist here. Arrows are drawn only where two ledgers link
 * the events deterministically (the run that handled a reply, steps of one run,
 * one queue row).
 */

const PATH = '/api/cockpit/platform/events'
const MAX_PAGES = 4
const PLAY_MS = 900
const RANGES: ReadonlyArray<{ value: ReplayRange; label: string }> = [{ value: '72h', label: '72h' }, { value: '7d', label: '7d' }, { value: '30d', label: '30d' }, { value: 'custom', label: 'Custom' }]

interface Loaded { key: string; events: PlatformEvent[]; meta: EventsResponse | null; error: string | null; truncated: boolean }

async function loadHistory(subject: FeedSubject, from: number, to: number, signal: AbortSignal): Promise<Omit<Loaded, 'key'>> {
  const events: PlatformEvent[] = []
  let cursor: string | null = null
  let meta: EventsResponse | null = null
  for (let i = 0; i < MAX_PAGES; i++) {
    const q = new URLSearchParams({ subject_type: subject.type, subject_id: subject.id, since: new Date(from).toISOString(), until: new Date(to).toISOString(), limit: '200' })
    if (cursor) q.set('cursor', cursor)
    const res = await callBackend<EventsResponse>(`${PATH}?${q.toString()}`, { timeoutMs: 60_000, signal })
    if (!res.ok) return { events, meta, error: res.status === 404 ? 'This subject has no recorded history the envelope can resolve.' : res.status === 400 ? (res.message || 'This subject cannot be replayed.') : 'Event history could not be resolved right now.', truncated: false }
    const data = res.data as EventsResponse
    meta = meta ?? data
    events.push(...data.events)
    cursor = data.next_cursor
    if (!cursor) break
  }
  return { events, meta, error: null, truncated: Boolean(cursor) }
}

const fmt = (t: number) => new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const fmtLong = (iso: string) => new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' })
const toLocalInput = (t: number) => { const d = new Date(t - new Date(t).getTimezoneOffset() * 60e3); return d.toISOString().slice(0, 16) }
/** Ledger codes ("inbox_needs_call", "decision_engine_failed") read as words, never as identifiers. */
const plainValue = (v: unknown): string => {
  const text = String(v)
  return /^[a-z][a-z0-9]*(?:[_.][a-z0-9]+)+$/.test(text) ? (text.charAt(0).toUpperCase() + text.slice(1)).replace(/[_.]+/g, ' ') : text
}

const detailRows = (d: Record<string, unknown> | null | undefined) => Object.entries(d ?? {}).filter(([k, v]) => v !== null && v !== '' && !['preview', 'facts'].includes(k) && (typeof v !== 'object')).slice(0, 10)

export function TimeMachine() {
  const subject = useReplaySubject()
  if (!subject) return null
  return <TimeMachinePlane key={`${subject.type}:${subject.id}`} subject={subject} />
}

function TimeMachinePlane({ subject }: { subject: FeedSubject }) {
  const [range, setRange] = useState<ReplayRange>(subject.type === 'campaign' ? '30d' : '7d')
  const [custom, setCustom] = useState<{ from: number; to: number } | null>(null)
  const [openedAt] = useState(() => Date.now())
  const win = useMemo(() => rangeOf(range, openedAt, custom), [range, openedAt, custom])
  const reqKey = `${subject.type}:${subject.id}:${win.from}:${win.to}`
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [sel, setSel] = useState<{ key: string; index: number } | null>(null)
  const [playing, setPlaying] = useState(false)
  const trackRef = useRef<HTMLDivElement>(null)
  const scrubbing = useRef(false)
  const started = useRef(false)

  useEffect(() => {
    const ac = new AbortController()
    if (!started.current) { started.current = true; sound.ui.tap() }
    loadHistory(subject, win.from, win.to, ac.signal).then((r) => { if (!ac.signal.aborted) setLoaded({ key: reqKey, ...r }) }).catch(() => { if (!ac.signal.aborted) setLoaded({ key: reqKey, events: [], meta: null, error: 'Event history could not be resolved right now.', truncated: false }) })
    return () => ac.abort()
  }, [subject, win.from, win.to, reqKey])

  const ready = loaded?.key === reqKey ? loaded : null
  const tl = useMemo(() => buildTimeline(ready?.events ?? [], win), [ready, win])
  const links = useMemo(() => causalLinks(ready?.events ?? []), [ready])
  const counts = laneCounts(tl)
  const count = tl.nodes.length
  // derived selection: defaults to the newest event of the current read
  const index = sel && sel.key === reqKey && sel.index < count ? sel.index : count - 1
  const current = index >= 0 ? tl.nodes[index] : null
  const select = (i: number) => setSel({ key: reqKey, index: i })

  // step player: event to event; a completed playthrough says so once
  useEffect(() => {
    if (!playing) return
    const t = window.setTimeout(() => {
      if (index >= count - 1) { setPlaying(false); sound.outcome.ready('subtle'); return }
      setSel({ key: reqKey, index: index + 1 })
    }, PLAY_MS)
    return () => window.clearTimeout(t)
  }, [playing, index, count, reqKey])

  const play = () => {
    if (!count) return
    if (playing) { setPlaying(false); return }
    sound.ui.tap()
    if (index >= count - 1) setSel({ key: reqKey, index: 0 })
    setPlaying(true)
  }
  const step = (dir: 1 | -1) => { setPlaying(false); select(stepTo(index, count, dir)) }

  const scrubAt = (clientX: number) => {
    const el = trackRef.current
    if (!el || !count) return
    const r = el.getBoundingClientRect()
    select(nearestIndex(tl, Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)))))
  }
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => { scrubbing.current = true; setPlaying(false); e.currentTarget.setPointerCapture(e.pointerId); scrubAt(e.clientX) }
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => { if (scrubbing.current) scrubAt(e.clientX) }
  const onUp = () => { scrubbing.current = false }
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target instanceof HTMLInputElement) return
    if (e.key === 'ArrowRight') { e.preventDefault(); step(1) }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1) }
    else if (e.key === 'Home') { e.preventDefault(); select(0) }
    else if (e.key === 'End') { e.preventDefault(); select(count - 1) }
  }

  const laneIndex = new Map(tl.lanes.map((l, i) => [l.key, i]))
  const LANE_H = 34
  const pos = new Map(tl.nodes.map((n) => [n.event.event_id, n]))
  const ticks = ticksFor(win.from, win.to)
  const notes = sourceNotes(ready?.meta ?? null)
  const label = subject.label || ready?.meta?.subject?.label || subject.id
  const related = current ? links.filter((l) => l.from === current.event.event_id || l.to === current.event.event_id) : []
  const e = current?.event ?? null

  return (
    <LCInspector open onClose={closeReplay} id="time-machine" mode="float" width={1080} minWidth={720} maxWidth={1600} resizable
      className="tm" eyebrow={<span className="tm__eyebrow"><Icon name="clock" size={11} /> Time Machine · {SUBJECT_NOUN[subject.type]}</span>}
      title={label} status={<LCStatus tone="neutral" quiet hollow label="Read-only replay" />} label={`Time Machine — ${label}`}>
      <div className="tm-body" onKeyDown={onKey}>
        <div className="tm-controls">
          <LCSegmented<ReplayRange> size="sm" label="Replay range" value={range} options={RANGES} onChange={(v) => { setPlaying(false); if (v === 'custom' && !custom) setCustom({ from: openedAt - 3 * 864e5, to: openedAt }); setRange(v) }} />
          {range === 'custom' && custom ? (
            <span className="tm-custom">
              <input type="datetime-local" aria-label="From" value={toLocalInput(custom.from)} max={toLocalInput(custom.to)} onChange={(ev) => { const t = Date.parse(ev.target.value); if (Number.isFinite(t) && t < custom.to) setCustom({ ...custom, from: t }) }} />
              <span aria-hidden="true">→</span>
              <input type="datetime-local" aria-label="To" value={toLocalInput(custom.to)} max={toLocalInput(openedAt)} onChange={(ev) => { const t = Date.parse(ev.target.value); if (Number.isFinite(t) && t > custom.from) setCustom({ ...custom, to: Math.min(t, openedAt) }) }} />
            </span>
          ) : null}
          <span className="tm-span">{fmt(win.from)} — {fmt(win.to)}</span>
          <span className="tm-counts">{tl.lanes.map((l) => <span key={l.key}><b>{counts[l.key]}</b> {l.label}</span>)}</span>
        </div>

        {!ready ? <div className="tm-loading"><LCSkeleton shape="lines" count={5} label="Resolving event history" /><p>Resolving event history</p></div> : null}
        {ready?.error ? <LCError what={ready.error} compact /> : null}
        {ready && !ready.error && !count ? (
          <LCEmpty icon="clock" title="No recorded events in this range" body={`No ledger recorded an operator-level event for this ${SUBJECT_NOUN[subject.type].toLowerCase()} between ${fmt(win.from)} and ${fmt(win.to)}. Try a longer range.`} />
        ) : null}

        {ready && count ? (
          <>
            <div className="tm-stage" style={{ ['--tm-lanes' as string]: tl.lanes.length }}>
              <ul className="tm-lanes" aria-hidden="true">{tl.lanes.map((l) => <li key={l.key} style={{ height: LANE_H }}>{l.label}</li>)}</ul>
              <div className="tm-track" ref={trackRef} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
                role="slider" tabIndex={0} aria-label="Replay position" aria-valuemin={1} aria-valuemax={count} aria-valuenow={index + 1} aria-valuetext={e ? `${fmtLong(e.occurred_at)} — ${e.summary}` : undefined}>
                <div className="tm-grid" style={{ height: tl.lanes.length * LANE_H }}>
                  {ticks.map((t) => <i key={t.t} className={cx('tm-tick', t.major && 'is-major')} style={{ left: `${t.x * 100}%` }} />)}
                  {tl.lanes.map((l, i) => <i key={l.key} className="tm-laneline" style={{ top: i * LANE_H + LANE_H / 2 }} />)}
                  <svg className="tm-arrows" viewBox={`0 0 1000 ${tl.lanes.length * LANE_H}`} preserveAspectRatio="none" aria-hidden="true">
                    {links.map((k) => {
                      const a = pos.get(k.from); const b = pos.get(k.to)
                      if (!a || !b) return null
                      const x1 = a.x * 1000; const y1 = (laneIndex.get(a.lane) ?? 0) * LANE_H + LANE_H / 2
                      const x2 = b.x * 1000; const y2 = (laneIndex.get(b.lane) ?? 0) * LANE_H + LANE_H / 2
                      const on = current && (k.from === current.event.event_id || k.to === current.event.event_id)
                      return <path key={`${k.from}>${k.to}`} className={cx('tm-arrow', on && 'is-on')} d={`M${x1},${y1} C${x1 + Math.max(8, (x2 - x1) / 2)},${y1} ${x2 - Math.max(8, (x2 - x1) / 2)},${y2} ${x2},${y2}`} vectorEffect="non-scaling-stroke" />
                    })}
                  </svg>
                  {tl.nodes.map((n, i) => (
                    <button key={n.event.event_id} type="button" tabIndex={-1} className={cx('tm-node', i === index && 'is-sel')} data-tone={toneOf(n.event)}
                      style={{ left: `${n.x * 100}%`, top: (laneIndex.get(n.lane) ?? 0) * LANE_H + LANE_H / 2 }}
                      onPointerDown={(ev) => ev.stopPropagation()} onClick={() => { setPlaying(false); select(i) }} title={`${new Date(n.event.occurred_at).toLocaleString()} · ${n.event.summary}`} aria-label={n.event.summary} />
                  ))}
                  {current ? <i className="tm-cursor" style={{ left: `${current.x * 100}%` }} /> : null}
                </div>
                <div className="tm-axis" aria-hidden="true">{ticks.filter((t) => t.x > 0.02 && t.x < 0.98).map((t) => <span key={t.t} className={cx(t.major && 'is-major')} style={{ left: `${t.x * 100}%` }}>{t.label}</span>)}</div>
              </div>
            </div>

            <div className="tm-player" role="group" aria-label="Step player">
              <LCIconButton icon="chevron-left" label="Previous event" size="sm" onClick={() => step(-1)} disabled={index <= 0} />
              <LCButton variant={playing ? 'secondary' : 'primary'} size="sm" icon={playing ? 'pause' : 'play'} onClick={play}>{playing ? 'Pause' : index >= count - 1 ? 'Replay from start' : 'Play'}</LCButton>
              <LCIconButton icon="chevron-right" label="Next event" size="sm" onClick={() => step(1)} disabled={index >= count - 1} />
              <span className="tm-player__pos"><b>{index + 1}</b> of {count}{ready.truncated ? '+' : ''}</span>
              {e ? <span className="tm-player__at">{fmtLong(e.occurred_at)}</span> : null}
              {notes.degraded.length ? <span className="tm-player__warn"><Icon name="alert-circle" size={11} /> Not read: {notes.degraded.join(', ')}</span> : null}
            </div>

            <div className="tm-split">
              <ol className="tm-list" aria-label="Events in order">
                {tl.nodes.map((n, i) => (
                  <li key={n.event.event_id}>
                    <button type="button" className={cx('tm-item', i === index && 'is-sel')} data-tone={toneOf(n.event)} onClick={() => { setPlaying(false); select(i) }}>
                      <span className="tm-item__g"><Icon name={glyphOf(n.event.event_type)} size={12} /></span>
                      <span className="tm-item__s">{n.event.summary}</span>
                      <time>{fmt(Date.parse(n.event.occurred_at))}</time>
                    </button>
                  </li>
                ))}
              </ol>
              {e ? (
                <section className="tm-detail" aria-label="Selected event">
                  <span className="lc-eyebrow">{SYSTEM_LABEL[e.source_system] ?? e.source_system} · {e.event_type}</span>
                  <h3 className="tm-detail__sum">{e.summary}</h3>
                  <p className="tm-detail__at">{fmtLong(e.occurred_at)} · {e.actor.kind === 'operator' ? 'You' : e.actor.label || e.actor.kind}</p>
                  {typeof e.details?.preview === 'string' ? <blockquote className="tm-detail__quote">{e.details.preview}</blockquote> : null}
                  {detailRows(e.details).length ? (
                    <dl className="tm-facts">{detailRows(e.details).map(([k, v]) => <div key={k}><dt>{k.replace(/_/g, ' ')}</dt><dd>{plainValue(v)}</dd></div>)}</dl>
                  ) : null}
                  {related.length ? (
                    <div className="tm-causal">
                      {related.map((l) => {
                        const other = l.from === e.event_id ? l.to : l.from
                        const oi = tl.nodes.findIndex((n) => n.event.event_id === other)
                        return <button key={`${l.from}>${l.to}`} type="button" onClick={() => oi >= 0 && select(oi)}><Icon name={l.from === e.event_id ? 'chevron-right' : 'chevron-left'} size={11} />{l.from === e.event_id ? 'Led to' : 'Caused by'} · {l.why}</button>
                      })}
                    </div>
                  ) : null}
                  <div className="tm-refs">{inspectorRefs(e).map((r) => <button key={`${r.type}:${r.id}`} type="button" onClick={() => { openInspector(r); sound.ui.select() }}>{r.type} · {r.label || r.id.slice(0, 12)}</button>)}</div>
                  <p className="tm-prov" title={e.provenance.ledger ?? undefined}>Source · {e.provenance.table} · {e.provenance.row_id.length > 24 ? `${e.provenance.row_id.slice(0, 24)}…` : e.provenance.row_id}{e.provenance.ledger ? ` · ${e.provenance.ledger}` : ''}</p>
                  {e.deep_link ? (
                    <div className="tm-open">
                      <LCButton size="sm" variant="secondary" icon="arrow-up-right" onClick={() => { pushRoutePath(e.deep_link!); closeReplay() }}>Open</LCButton>
                      <LCButton size="sm" variant="ghost" icon="layout-split" onClick={() => { if (openApp(e.deep_link!, 'beside') !== 'refused') sound.workspace.drop('split') }}>{e.deep_link.startsWith('/workflow-studio') ? 'Open Workflow beside' : 'Open beside'}</LCButton>
                    </div>
                  ) : null}
                </section>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </LCInspector>
  )
}
