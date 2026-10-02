/**
 * NOTIFICATION CENTER 2.0 — the system plane (desktop only).
 *
 * A floating liquid-glass plane above the workspace, opened from the Command
 * Deck's notification control. It renders STORIES (one per subject + causal
 * burst) from the aggregated read model; it never decides priority, lens, state
 * or eligibility — the server does. Every action and deep link goes through the
 * universal object registry (Open, Open beside, Inspect, Missions); Replay
 * opens the Time Machine where a subject has one.
 *
 * Not an app-rail item. The Notifications app (alert settings + Signals) stays
 * reachable from the plane's settings control.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { LCButton, LCEmpty, LCError, LCIconButton, LCSegmented, LCSkeleton, cx } from '../../../shared/lc'
import { Icon } from '../../../shared/icons'
import { handleObjectClick, inspectObject, MOD_KEY, openObject, openObjectBeside, startObjectMission, type ObjectRef } from '../../desktop/objects'
import { openReplay } from '../../desktop/replay/replay-store'
import { requestNotificationsSurface } from '../../mobile/shell-surface-bridge'
import {
  clearArrivals, loadMoreStories, markStories, retryStories, setPlaneOpen, useStoryStore,
} from './story-store'
import {
  clockTime, defaultLens, degradedText, EMPTY_COPY, LENS_LABEL, LENS_ORDER, relTime, runObject, storyObject, storyTone, visibleOrder,
  type Story, type StoryLens,
} from './story-model'
import './notification-plane.css'

export interface NotificationPlaneProps {
  open: boolean
  onClose: () => void
  /** px from the viewport top (below the Command Deck) */
  anchorTop?: number
}

const READING_PX = 24

export function NotificationPlane({ open, onClose, anchorTop = 84 }: NotificationPlaneProps) {
  if (!open || typeof document === 'undefined') return null
  return createPortal(<Plane onClose={onClose} anchorTop={anchorTop} />, document.body)
}

function Plane({ onClose, anchorTop }: { onClose: () => void; anchorTop: number }) {
  const st = useStoryStore()
  const [lens, setLens] = useState<StoryLens>(() => defaultLens(st.counts))
  const [expanded, setExpanded] = useState<string | null>(null)
  const [frozen, setFrozen] = useState<string[] | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const planeRef = useRef<HTMLElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => { setPlaneOpen(true); return () => setPlaneOpen(false) }, [])
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t) }, [])

  // outside press closes — except the deck's own bell (it toggles) and portaled LC layers
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null
      if (!t || planeRef.current?.contains(t)) return
      if (t.closest('button.cd-btn[aria-label^="Notifications"], [data-radix-popper-content-wrapper], .lc-toast, .lc-inspector')) return
      onClose()
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [onClose])

  const all = useMemo(() => [...st.stories.values()], [st.stories])
  const held = useMemo(() => new Set(frozen ? st.arrivals.filter((id) => !frozen.includes(id)) : []), [frozen, st.arrivals])
  const heldInLens = useMemo(() => all.filter((s) => held.has(s.id) && s.lens === lens).length, [all, held, lens])
  const list = useMemo(() => visibleOrder(all, lens, frozen, held), [all, lens, frozen, held])
  const counts = st.counts
  const degraded = degradedText(st.degraded)

  const onScroll = () => {
    const top = listRef.current?.scrollTop ?? 0
    if (top > READING_PX && !frozen) setFrozen(list.map((s) => s.id))
    else if (top <= READING_PX && frozen) { setFrozen(null); clearArrivals() }
  }
  const reveal = () => {
    setFrozen(null)
    clearArrivals()
    listRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }
  const changeLens = (l: StoryLens) => {
    setLens(l); setExpanded(null); setFrozen(null); clearArrivals()
    listRef.current?.scrollTo({ top: 0 })
  }

  const unreadInLens = list.filter((s) => !s.read && !s.resolved).map((s) => s.id)
  const needs = counts?.needs_you ?? 0

  return (
    <section ref={planeRef} className="ncp" role="dialog" aria-label="Notifications" style={{ ['--ncp-top' as string]: `${anchorTop}px` }}>
      <span className="ncp__env" aria-hidden="true" />
      <header className="ncp__head">
        <div className="ncp__titles">
          <h2>Notifications</h2>
          <p>{counts ? (needs ? `${needs} ${needs === 1 ? 'needs' : 'need'} you` : counts.badge ? `${counts.badge} to look at` : 'Nothing waiting on you') : 'Reading…'}</p>
        </div>
        <div className="ncp__tools">
          {unreadInLens.length ? <LCButton variant="quiet" size="sm" onClick={() => void markStories(unreadInLens, 'read')}>Mark read</LCButton> : null}
          <LCIconButton icon="settings" label="Alert settings & Signals" size="sm" onClick={() => { onClose(); requestNotificationsSurface() }} />
        </div>
      </header>

      <div className="ncp__lenses">
        <LCSegmented<StoryLens>
          label="Notification lens"
          size="sm"
          value={lens}
          onChange={changeLens}
          options={LENS_ORDER.map((l) => ({ value: l, label: LENS_LABEL[l], accessory: lensCount(l, counts) }))}
        />
      </div>

      {degraded ? <p className="ncp__degraded" role="status"><Icon name="alert-circle" size={12} />{degraded}</p> : null}

      <div className="ncp__scroll" ref={listRef} onScroll={onScroll}>
        {frozen && heldInLens ? (
          <button type="button" className="ncp__new" onClick={reveal}>
            <Icon name="chevron-up" size={12} />{heldInLens} new
          </button>
        ) : null}

        {st.status === 'loading' || st.status === 'idle' ? (
          <div className="ncp__loading"><LCSkeleton shape="lines" count={5} label="Loading notifications" /></div>
        ) : st.status === 'error' && !all.length ? (
          <div className="ncp__pad"><LCError what={st.error || 'Notifications could not be read right now.'} onRetry={retryStories} /></div>
        ) : list.length === 0 ? (
          <div className="ncp__pad">
            <LCEmpty title={EMPTY_COPY[lens].title} body={EMPTY_COPY[lens].body} icon={EMPTY_COPY[lens].icon} tone="calm" />
          </div>
        ) : (
          <ol className="ncp__list">
            {list.map((s, i) => (
              <StoryRow
                key={s.id}
                story={s}
                now={now}
                expanded={expanded === s.id}
                divider={lens === 'resolved' && s.aged && (i === 0 || !list[i - 1].aged)}
                onToggle={() => setExpanded((cur) => (cur === s.id ? null : s.id))}
                onDone={onClose}
              />
            ))}
          </ol>
        )}

        {st.nextCursor && list.length ? (
          <div className="ncp__more">
            <LCButton variant="ghost" size="sm" loading={st.loadingMore} onClick={() => void loadMoreStories()}>Earlier</LCButton>
          </div>
        ) : null}
      </div>

      <footer className="ncp__foot">
        <span>{st.horizon ? `Since ${clockTime(st.horizon)}` : 'Last 7 days'}{st.truncated ? ' · older activity in the Machine Feed' : ''}</span>
        {st.error && all.length ? <span className="ncp__stale">Not refreshed · {st.error}</span> : <span>Resolved stories age into history after a day</span>}
      </footer>
    </section>
  )
}

function lensCount(l: StoryLens, c: ReturnType<typeof useStoryStore>['counts']) {
  if (!c) return null
  const n = l === 'needs_you' ? c.needs_you : l === 'now' ? c.now_unread : l === 'system' ? c.system_active : 0
  return n ? <span className={cx('ncp__count', l === 'needs_you' && 'is-needs')}>{n}</span> : null
}

/* ── one story ───────────────────────────────────────────────────────────── */

function StoryRow({ story: s, now, expanded, divider, onToggle, onDone }: { story: Story; now: number; expanded: boolean; divider: boolean; onToggle: () => void; onDone: () => void }) {
  const ref = useMemo(() => storyObject(s), [s])
  const run = useMemo(() => runObject(s), [s])
  const tone = storyTone(s)
  const summary = s.summary || subjectLine(s)
  // the chip says why it matters — unless the title already says exactly that
  const showReason = Boolean(s.reason) && !s.title.toLowerCase().endsWith((s.reason || '').replace(/\s*✓$/, '').toLowerCase())

  const act = (fn: (r: ObjectRef) => { ok: boolean }, target: ObjectRef | null = ref) => {
    if (!target) return
    if (!s.read) void markStories([s.id], 'read')
    const r = fn(target)
    if (r.ok) onDone()
  }
  const activate = (e: MouseEvent | KeyboardEvent) => {
    if (!ref) { onToggle(); return }
    if (!s.read) void markStories([s.id], 'read')
    const g = handleObjectClick(e, ref)
    if (g) onDone()
  }
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); activate(e) }
    else if (e.key === 'ArrowRight' && !expanded) { e.preventDefault(); onToggle() }
    else if (e.key === 'ArrowLeft' && expanded) { e.preventDefault(); onToggle() }
  }

  return (
    <>
      {divider ? <li className="ncp__history" role="presentation">Earlier</li> : null}
      <li className={cx('ncs', `is-${tone}`, !s.read && !s.resolved && 'is-unread', expanded && 'is-open', s.resolved && 'is-resolved')} data-story={s.id} data-lens={s.lens}>
        <div className="ncs__row">
          <button
            type="button"
            className="ncs__main"
            onClick={activate}
            onKeyDown={onKey}
            title={ref ? `Open · ⇧ Inspect · ${MOD_KEY} Open beside` : undefined}
            aria-describedby={summary ? `ncs-${s.id}-sum` : undefined}
          >
            <span className="ncs__glyph" aria-hidden="true"><i /></span>
            <span className="ncs__body">
              <span className="ncs__top">
                <b className="ncs__title">{s.title}</b>
                <time dateTime={s.updated_at} title={clockTime(s.updated_at)}>{relTime(s.updated_at, now)}</time>
              </span>
              {summary ? <span id={`ncs-${s.id}-sum`} className="ncs__summary">{summary}</span> : null}
              {showReason ? <span key={s.state.code} className={cx('ncs__reason', `is-${s.state.tone || (s.requires_operator ? 'gold' : 'neutral')}`)}>{s.reason}</span> : null}
            </span>
          </button>
          <button type="button" className="ncs__toggle" aria-expanded={expanded} aria-label={expanded ? 'Hide what happened' : `Show what happened (${s.chain.length})`} onClick={onToggle}>
            {s.chain.length > 1 ? <span>{s.chain.length}</span> : null}
            <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={13} />
          </button>
        </div>
        {expanded ? (
          <div className="ncs__more">
            <ol className="ncs__chain" aria-label="What happened">
              {s.chain.map((c) => (
                <li key={c.id} className={cx(`is-${c.tone}`, c.role === 'trigger' && 'is-trigger')}>
                  <time dateTime={c.at}>{clockTime(c.at)}</time>
                  <span><b>{c.label}</b>{c.detail ? <em>{c.detail}</em> : null}</span>
                </li>
              ))}
            </ol>
            <div className="ncs__actions">
              {ref ? <LCButton size="sm" variant="secondary" icon="layout-split" onClick={() => act(openObjectBeside)}>Open beside</LCButton> : null}
              {ref ? <LCButton size="sm" variant="quiet" icon="eye" onClick={() => act(inspectObject)}>Inspect</LCButton> : null}
              {run ? <LCButton size="sm" variant="quiet" icon="activity" onClick={() => act(openObject, run)}>Review run</LCButton> : null}
              {ref ? s.missions.map((m) => <LCButton key={m.kind} size="sm" variant="quiet" icon="target" onClick={() => act((r) => startObjectMission(r, m.kind))}>{m.label}</LCButton>) : null}
              {s.replay ? <LCButton size="sm" variant="quiet" icon="clock" onClick={() => { if (!s.read) void markStories([s.id], 'read'); openReplay(s.replay!); onDone() }}>Replay</LCButton> : null}
              <span className="ncs__spacer" />
              {!s.resolved ? <LCButton size="sm" variant="ghost" onClick={() => void markStories([s.id], s.read ? 'unread' : 'read')}>{s.read ? 'Mark unread' : 'Mark read'}</LCButton> : null}
              {s.resolved && s.resolved_by === 'operator' ? <LCButton size="sm" variant="ghost" onClick={() => void markStories([s.id], 'reopen')}>Reopen</LCButton> : null}
              {!s.resolved ? <LCButton size="sm" variant="ghost" icon="check" onClick={() => void markStories([s.id], 'resolve')}>Resolve</LCButton> : null}
            </div>
          </div>
        ) : null}
      </li>
    </>
  )
}

/** Only real context — never filler. */
function subjectLine(s: Story): string {
  if (s.resolved_by === 'superseded') return 'Newer activity on this conversation carries it forward'
  return ''
}
