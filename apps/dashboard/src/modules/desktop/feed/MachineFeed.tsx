import { useEffect, useMemo, useRef } from 'react'
import { Icon } from '../../../shared/icons'
import { LCButton, LCChip, LCEmpty, LCError, LCSegmented, LCSelect, LCSkeleton, LCTooltip, cx } from '../../../shared/lc'
import { pushRoutePath } from '../../../app/router'
import { sound } from '../../../shared/sound'
import { openInspector } from '../inspector/inspector-store'
import { openApp } from '../workspace/workspace-store'
import { machineState, runtimeHealth } from '../rail/rail-model'
import type { RailSnapshot } from '../rail/rail-store'
import { openReplay } from '../replay/replay-store'
import { FEED_APPS, FEED_KINDS, SYSTEM_LABEL, clockOf, glyphOf, groupByDay, inspectorRefs, replayFromEvent, sourceNotes, toneOf, type FeedKind, type FeedApp, type FeedSeverity, type FeedSubject, type FeedWindow, type PlatformEvent } from './feed-model'
import { attachFeed, loadFeed, loadMore, revealPending, setFeedAtTop, setFeedFilters, useFeed } from './feed-store'
import './machine-feed.css'

/**
 * THE MACHINE FEED — what LeadCommand is doing and did, as one stream.
 *
 *   ● Machine · live    Queue runner · Campaign execution · …        (runtime strip)
 *   [All apps ▾] [All events ▾] [All|Attention|Warnings] [1h|24h|7d|30d]  (filters)
 *   TODAY
 *   4:21 PM  ✉  Gale D. replied · unclear                 Seller ▸  Open  Replay
 *
 * Rows are ledger records the server projected (see the platform event
 * envelope); the feed decides nothing and plays no sound per event.
 */

export interface LinkedSubject { threadKey: string | null; propertyId: string | null; address: string | null }

const WINDOWS: ReadonlyArray<{ value: FeedWindow; label: string }> = [{ value: '1h', label: '1h' }, { value: '24h', label: '24h' }, { value: '7d', label: '7d' }, { value: '30d', label: '30d' }]
const SEVERITIES: ReadonlyArray<{ value: FeedSeverity; label: string }> = [{ value: 'all', label: 'All' }, { value: 'attention', label: 'Attention' }, { value: 'warning', label: 'Failures' }]

const ago = (iso: string | null | undefined, now: number) => {
  if (!iso) return null
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  return s < 45 ? 'just now' : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`
}

function Row({ e, fresh, onLeave }: { e: PlatformEvent; fresh: boolean; onLeave: () => void }) {
  const refs = inspectorRefs(e).slice(0, 2)
  const replay = replayFromEvent(e)
  const tone = toneOf(e)
  const actor = e.actor.kind === 'operator' ? 'You' : e.actor.label || (e.actor.kind === 'seller' ? 'Seller' : e.actor.kind === 'automation' ? 'Automation' : 'System')
  return (
    <li className={cx('mf-row', fresh && 'is-fresh')} data-tone={tone}>
      <time className="mf-row__t lc-t-stamp" dateTime={e.occurred_at} title={new Date(e.occurred_at).toLocaleString()}>{clockOf(e.occurred_at)}</time>
      <span className="mf-row__g" aria-hidden="true"><Icon name={glyphOf(e.event_type)} size={13} strokeWidth={1.8} /></span>
      <span className="mf-row__body">
        <b className="mf-row__sum">{e.summary}</b>
        <small className="mf-row__meta">
          <span>{SYSTEM_LABEL[e.source_system] ?? e.source_system}</span>
          <span aria-hidden="true">·</span>
          <span>{actor}</span>
          {refs.map((r) => (
            <button key={`${r.type}:${r.id}`} type="button" className="mf-ref" onClick={() => { openInspector(r); sound.ui.select() }} title={`Inspect ${r.type}`}>
              {r.label || r.type}
            </button>
          ))}
        </small>
      </span>
      <span className="mf-row__acts">
        {e.deep_link ? (
          <>
            <LCTooltip content="Open in its app" side="top"><button type="button" className="mf-act" onClick={() => { pushRoutePath(e.deep_link!); onLeave() }} aria-label="Open"><Icon name="arrow-up-right" size={12} /></button></LCTooltip>
            <LCTooltip content="Open beside" side="top"><button type="button" className="mf-act" onClick={() => { if (openApp(e.deep_link!, 'beside') !== 'refused') sound.workspace.drop('split'); onLeave() }} aria-label="Open beside"><Icon name="layout-split" size={12} /></button></LCTooltip>
          </>
        ) : null}
        {replay ? <LCTooltip content="Replay this subject" side="top"><button type="button" className="mf-act" onClick={() => { openReplay(replay); onLeave() }} aria-label="Replay"><Icon name="clock" size={12} /></button></LCTooltip> : null}
      </span>
    </li>
  )
}

export function MachineFeed({ rail, linked, onLeave }: { rail: RailSnapshot; linked: LinkedSubject | null; onLeave: () => void }) {
  const feed = useFeed()
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => attachFeed(), [])
  const now = feed.updatedAt ?? rail.updatedAt ?? 0
  const m = machineState(rail.telemetry, rail.updatedAt ?? 0)
  const runtimes = (rail.telemetry?.runtimes ?? []).map((r) => ({ r, h: runtimeHealth(r, rail.updatedAt ?? 0) })).filter((x) => x.h !== 'never')
  const groups = useMemo(() => groupByDay(feed.events, now), [feed.events, now])
  const notes = sourceNotes(feed.meta)
  const markets = useMemo(() => [...new Set(feed.events.map((e) => e.market).filter((x): x is string => Boolean(x)))].sort(), [feed.events])
  const f = feed.filters
  const linkedSubject: FeedSubject | null = linked?.threadKey ? { type: 'seller', id: linked.threadKey, label: linked.address } : linked?.propertyId ? { type: 'property', id: linked.propertyId, label: linked.address } : null

  const onScroll = () => { const el = listRef.current; if (el) setFeedAtTop(el.scrollTop < 12) }
  const showNew = () => { revealPending(); listRef.current?.scrollTo({ top: 0 }) }

  return (
    <div className="mf" aria-label="Machine activity">
      <header className="mf-strip">
        <span className={cx('mf-state', `is-${m.state}`)}><i aria-hidden="true" />{m.state === 'degraded' ? 'Degraded' : m.state === 'live' ? 'Machine · live' : m.state === 'idle' ? 'Machine · idle' : 'Machine'}</span>
        <ul className="mf-rts" aria-label="Runtimes">
          {runtimes.map(({ r, h }) => (
            <li key={r.key} className={cx('mf-rt', `is-${h}`)} title={`${r.name} · ${h === 'current' ? `beat ${ago(r.heartbeat_at, rail.updatedAt ?? 0)}` : h === 'event' ? (r.last_run_at ? `ran ${ago(r.last_run_at, rail.updatedAt ?? 0)}` : 'event-driven') : h}`}>
              <i aria-hidden="true" />{r.name}
            </li>
          ))}
        </ul>
      </header>
      {m.reason ? <p className="mf-reason">{m.reason}</p> : null}

      <div className="mf-filters" role="toolbar" aria-label="Filter machine activity">
        <LCSelect<FeedApp> size="sm" variant="chip" label="App" value={f.app} onChange={(v) => setFeedFilters({ app: v })} options={FEED_APPS.map((a) => ({ value: a.value, label: a.label }))} />
        <LCSelect<FeedKind> size="sm" variant="chip" label="Event type" value={f.kind} onChange={(v) => setFeedFilters({ kind: v })} options={FEED_KINDS.map((k) => ({ value: k.value, label: k.label }))} />
        {markets.length || f.market ? (
          <LCSelect<string> size="sm" variant="chip" label="Market" value={f.market ?? '__all'} onChange={(v) => setFeedFilters({ market: v === '__all' ? null : v })} options={[{ value: '__all', label: 'All markets' }, ...[...new Set([...(f.market ? [f.market] : []), ...markets])].map((x) => ({ value: x, label: x }))]} />
        ) : null}
        <span className="mf-filters__gap" />
        <LCSegmented<FeedSeverity> size="sm" label="Severity" value={f.severity} onChange={(v) => setFeedFilters({ severity: v })} options={SEVERITIES} />
        <LCSegmented<FeedWindow> size="sm" label="Time window" value={f.window} onChange={(v) => setFeedFilters({ window: v })} options={WINDOWS} />
      </div>

      {f.subject || linkedSubject ? (
        <div className="mf-subject">
          {f.subject ? (
            <LCChip field={f.subject.type === 'seller' ? 'Seller' : 'Property'} value={f.subject.label || f.subject.id} onRemove={() => setFeedFilters({ subject: null })} />
          ) : linkedSubject ? (
            <button type="button" className="mf-subject__offer" onClick={() => setFeedFilters({ subject: linkedSubject })}>
              <Icon name="link" size={11} /> Only {linkedSubject.label || (linkedSubject.type === 'seller' ? 'the linked seller' : 'the linked property')}
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="mf-list" ref={listRef} onScroll={onScroll}>
        {feed.pending.length ? (
          <button type="button" className="mf-new" onClick={showNew}>{feed.pending.length} new · show</button>
        ) : null}
        {feed.status === 'loading' || feed.status === 'idle' ? <LCSkeleton shape="lines" count={7} label="Resolving machine activity" /> : null}
        {feed.status === 'error' ? <LCError what="Machine activity could not be read" detail={feed.error ?? undefined} onRetry={() => void loadFeed()} compact /> : null}
        {feed.status === 'ready' && !feed.events.length ? (
          <LCEmpty compact icon="activity" title="Nothing recorded in this window" body={f.app !== 'all' || f.kind !== 'all' || f.severity !== 'all' || f.subject || f.market ? 'No ledger recorded an event that matches these filters.' : 'No ledger recorded an operator-level event in this window.'} />
        ) : null}
        {feed.status === 'ready' && groups.map((g) => (
          <section key={g.day} className="mf-day" aria-label={g.day}>
            <h4 className="mf-day__h lc-eyebrow">{g.day}</h4>
            <ol className="mf-rows">
              {g.events.map((e) => <Row key={e.event_id} e={e} fresh={feed.fresh.has(e.event_id)} onLeave={onLeave} />)}
            </ol>
          </section>
        ))}
        {feed.status === 'ready' && feed.cursor ? (
          <div className="mf-more"><LCButton variant="ghost" size="sm" loading={feed.loadingMore} onClick={() => void loadMore()}>Load older</LCButton></div>
        ) : null}
        {feed.status === 'ready' && feed.events.length && !feed.cursor ? <p className="mf-end">Start of this window</p> : null}
      </div>

      <footer className="mf-foot">
        {notes.degraded.length ? <span className="mf-foot__warn"><Icon name="alert-circle" size={11} /> Not read: {notes.degraded.join(', ')}</span> : null}
        <span className="mf-foot__meta">
          {feed.updatedAt ? `Updated ${clockOf(new Date(feed.updatedAt).toISOString())} · live every 15 s` : 'Live every 15 s while open'}
          {notes.quiet.length && feed.status === 'ready' ? <span title={`No events in this window from: ${notes.quiet.join(', ')}`}> · {notes.quiet.length} quiet {notes.quiet.length === 1 ? 'source' : 'sources'}</span> : null}
        </span>
      </footer>
    </div>
  )
}

