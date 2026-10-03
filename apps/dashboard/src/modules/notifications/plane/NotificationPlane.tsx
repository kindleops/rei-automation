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
 * Not an app-rail item. Alert settings + Signal Center open INSIDE the plane
 * (PlaneSettings); the legacy Notifications panel is a rollback flag only
 * (plane-host.ts).
 *
 * Look: calm by default. Each story wears its app's glyph tile (the Command Rail's
 * own icon, a quiet per-app tint). Semantic colour only where it means something:
 * red = a real failure / critical, amber = the one "needs your decision" marker,
 * green = resolved, accent = unread / selected. Sections by time.
 *
 * Act: swipe a story (trackpad, drag or touch) — left reveals Read / Resolve,
 * right reveals Open; past the commit line it runs the primary, else it springs
 * back. Multi-select with the shared LC selection grammar (checkbox, ⇧ range,
 * ⌘ toggle while selecting) and the shared bulk bar. "Clear all" resolves a
 * lens behind a confirm. Nothing is deleted: every action is the story-state
 * endpoint, and a toast offers Undo (the inverse action).
 *
 * Instant: the plane renders the last-known stories (session cache) at once and
 * reconciles; the badge is the server's cheap summary until stories load.
 * Keyboard (scoped to the plane, never window-level): ↑/↓ Home/End move through
 * stories, Enter opens, Shift+Enter inspects, ⌘/Ctrl+Enter opens beside,
 * →/← expand/collapse, Space selects, Esc steps back (selection → settings →
 * stories → closed).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { LCBulkBar, LCButton, LCEmpty, LCError, LCIconButton, LCSegmented, LCSkeleton, cx, lcConfirm, useLcReducedMotion, useLcSelection, type LcSelection } from '../../../shared/lc'
import { Icon } from '../../../shared/icons'
import { handleObjectClick, inspectObject, MOD_KEY, openObject, openObjectBeside, startObjectMission, type ObjectRef } from '../../desktop/objects'
import { openReplay } from '../../desktop/replay/replay-store'
import { requestNotificationsSurface } from '../../mobile/shell-surface-bridge'
import { resolveSignal } from '../signals/signals-api'
import {
  actOnStories, clearArrivals, loadMoreStories, markStories, retryStories, setPlaneOpen, useStoryStore,
} from './story-store'
import {
  clockTime, dampSwipe, defaultLens, degradedText, EMPTY_COPY, LENS_LABEL, LENS_ORDER, nextStoryIndex, relTime, runObject, settleSwipe, storyObject, storySource, storyTone,
  SWIPE_TRAY_PX, TIME_GROUP_LABEL, timeGroup, visibleOrder,
  type Story, type StoryLens, type SwipeSide,
} from './story-model'
import { dialogLayerOpen, legacyNotificationsPanel, pressDismissesPlane, registerPlaneHost } from './plane-host'
import { PlaneSettings } from './PlaneSettings'
import { useSettingsFace } from './settings-face'
import './notification-plane.css'

export interface NotificationPlaneProps {
  open: boolean
  onClose: () => void
  /** px from the viewport top (below the Command Deck) */
  anchorTop?: number
}

const READING_PX = 24
const NOUN = { one: 'story', many: 'stories' }

export function NotificationPlane({ open, onClose, anchorTop = 84 }: NotificationPlaneProps) {
  // while mounted, every "notifications" request on this desktop opens the plane (plane-host.ts)
  useEffect(() => registerPlaneHost(), [])
  if (!open || typeof document === 'undefined') return null
  return createPortal(<Plane onClose={onClose} anchorTop={anchorTop} />, document.body)
}

function Plane({ onClose, anchorTop }: { onClose: () => void; anchorTop: number }) {
  const st = useStoryStore()
  const [lens, setLens] = useState<StoryLens>(() => defaultLens(st.counts))
  const [expanded, setExpanded] = useState<string | null>(null)
  const [frozen, setFrozen] = useState<string[] | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [view, setView] = useState<'stories' | 'settings'>('stories')
  const [swiped, setSwiped] = useState<{ id: string; side: SwipeSide } | null>(null)
  const [busy, setBusy] = useState<{ verb: string; done: number; total: number } | null>(null)
  const settings = useSettingsFace()
  const planeRef = useRef<HTMLElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  /** this Escape was pressed while a dialog layer was open (read in window capture, before the layer unmounts) */
  const escOwned = useRef(false)

  useEffect(() => { setPlaneOpen(true); return () => setPlaneOpen(false) }, [])
  // the plane takes focus so ↑/↓ work at once (Esc returns the operator to the workspace)
  useEffect(() => { planeRef.current?.focus({ preventScroll: true }) }, [])
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t) }, [])

  // outside press closes — except the deck's own bell (it toggles) and every portaled LC layer the plane
  // opens (a confirm's buttons live outside the plane's DOM: closing here unmounted the confirm before
  // its action ran — Arm rule closed everything and sent nothing)
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null
      if (pressDismissesPlane(t, Boolean(t && planeRef.current?.contains(t)))) onClose()
    }
    // Escape inside a dialog closes the dialog only. Whether a dialog owned it is read FIRST (window capture,
    // before the dialog's own handler can unmount it); the bubble then stops short of the shell's window Esc.
    const onKeyFirst = (e: globalThis.KeyboardEvent) => { escOwned.current = e.key === 'Escape' && dialogLayerOpen(document) }
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape' && escOwned.current) { escOwned.current = false; e.stopPropagation() } }
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKeyFirst, true)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKeyFirst, true); document.removeEventListener('keydown', onKey) }
  }, [onClose])

  const all = useMemo(() => [...st.stories.values()], [st.stories])
  const held = useMemo(() => new Set(frozen ? st.arrivals.filter((id) => !frozen.includes(id)) : []), [frozen, st.arrivals])
  const heldInLens = useMemo(() => all.filter((s) => held.has(s.id) && s.lens === lens).length, [all, held, lens])
  const list = useMemo(() => visibleOrder(all, lens, frozen, held), [all, lens, frozen, held])
  const order = useMemo(() => list.map((s) => s.id), [list])
  const sel = useLcSelection(order)
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
    setLens(l); setExpanded(null); setFrozen(null); setSwiped(null); sel.clear(); clearArrivals()
    listRef.current?.scrollTo({ top: 0 })
  }

  const unreadInLens = list.filter((s) => !s.read && !s.resolved).map((s) => s.id)
  const openInLens = list.filter((s) => !s.resolved).map((s) => s.id)
  const needs = counts?.needs_you ?? 0

  const openSettings = (rule: string | null = null) => {
    // rollback flag: the legacy Notifications panel (alert settings + Signals) instead
    if (legacyNotificationsPanel()) { onClose(); requestNotificationsSurface(); return }
    settings.setFocusRule(rule)
    settings.setFace('rules')
    setView('settings')
  }

  /** Resolve clears the stories' Signal Center ledger rows too (canonical signals API). */
  const resolveSignals = (ids: string[]) => {
    for (const id of ids) for (const sid of st.stories.get(id)?.signal?.signal_ids ?? []) void resolveSignal(sid).catch(() => { /* the ledger keeps it open; the story is resolved */ })
  }

  const runBulk = async (action: 'read' | 'resolve', ids: string[]) => {
    if (!ids.length) return
    setBusy({ verb: action === 'read' ? 'Marking read' : 'Resolving', done: 0, total: ids.length })
    const r = await actOnStories(ids, action)
    if (action === 'resolve') resolveSignals(r.ids)
    setBusy(null)
    sel.clear()
  }

  const clearAll = async () => {
    const ids = openInLens
    if (!ids.length) return
    const n = ids.length
    const ok = await lcConfirm({
      title: `Clear ${n} ${n === 1 ? 'story' : 'stories'} from ${LENS_LABEL[lens]}?`,
      effects: [
        { text: `Resolves ${n === 1 ? 'it' : `all ${n}`} — they move to Resolved and age into history. Nothing is deleted.`, kind: 'stops' },
        { text: 'Undo is offered right after. A story comes back by itself if something new happens on it.', kind: 'keeps' },
      ],
      confirmLabel: `Clear ${n}`,
      nativeText: `Clear ${n} stories from ${LENS_LABEL[lens]}? They are resolved, not deleted.`,
    })
    if (!ok) return
    await runBulk('resolve', ids)
  }

  // keyboard, scoped to the plane: ↑/↓ Home/End through the visible stories; Esc steps back
  const onPlaneKey = (e: KeyboardEvent<HTMLElement>) => {
    if (escOwned.current || dialogLayerOpen(document)) return // an LC dialog (arming a rule) owns its keys
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation()
      if (swiped) { setSwiped(null); return }
      if (sel.onKeyDown(e)) return
      if (view === 'settings') { setView('stories'); requestAnimationFrame(() => planeRef.current?.focus({ preventScroll: true })) }
      else onClose()
      return
    }
    if (view !== 'stories' || e.altKey || e.metaKey || e.ctrlKey) return
    const t = e.target as HTMLElement
    if (t.closest('input, textarea, select, [contenteditable="true"], .lc-seg, .lc-bulk')) return
    if (e.key === ' ' && t.classList.contains('ncs__main')) {
      const id = t.closest<HTMLElement>('.ncs')?.dataset.story
      if (id) { e.preventDefault(); sel.onRowClick(id, e, true) }
      return
    }
    const rows = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('.ncs__main') ?? [])]
    const cur = rows.findIndex((r) => r === t)
    const next = nextStoryIndex(cur, e.key, rows.length)
    if (next === null) return
    e.preventDefault()
    rows[next].focus()
    rows[next].scrollIntoView({ block: 'nearest' })
  }

  const subtitle = counts ? (needs ? `${needs} ${needs === 1 ? 'needs' : 'need'} you` : counts.badge ? `${counts.badge} to look at` : 'Nothing waiting on you') : 'Reading…'

  // sections by time (the list is newest-first, so each section is contiguous)
  const sections = useMemo(() => {
    const out: Array<{ key: string; label: string; items: Story[] }> = []
    for (const s of list) {
      const g = s.resolved && s.aged && lens === 'resolved' ? 'older' : timeGroup(s.updated_at, now)
      const last = out[out.length - 1]
      if (last && last.key === g) last.items.push(s)
      else out.push({ key: g, label: TIME_GROUP_LABEL[g], items: [s] })
    }
    return out
  }, [list, now, lens])

  const selectedIds = sel.ids
  const selUnread = selectedIds.filter((id) => !st.stories.get(id)?.read)
  const selOpen = selectedIds.filter((id) => !st.stories.get(id)?.resolved)

  return (
    <section ref={planeRef} className={cx('ncp', view === 'settings' && 'is-settings', sel.active && 'is-selecting')} role="dialog" aria-label="Notifications" tabIndex={-1} onKeyDown={onPlaneKey} style={{ ['--ncp-top' as string]: `${anchorTop}px` }}>
      <span className="ncp__env" aria-hidden="true" />
      {view === 'settings' ? (
        <PlaneSettings face={settings.face} onFace={settings.setFace} focusRule={settings.focusRule} onBack={() => setView('stories')} />
      ) : (<>
      <header className="ncp__head">
        <div className="ncp__titles">
          <h2>Notifications</h2>
          <p>
            {needs ? <i className="ncp__needs-dot" aria-hidden="true" /> : null}
            {subtitle}
            {st.reconciling ? <span className="ncp__sync" role="status"> · Updating</span> : null}
          </p>
        </div>
        <div className="ncp__tools">
          {unreadInLens.length ? <LCButton variant="quiet" size="sm" onClick={() => void actOnStories(unreadInLens, 'read')}>Mark read</LCButton> : null}
          {lens !== 'resolved' && openInLens.length ? <LCButton variant="quiet" size="sm" onClick={() => void clearAll()}>Clear all</LCButton> : null}
          <LCIconButton icon="settings" label="Alerts & Signals" size="sm" onClick={() => openSettings()} />
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

        {(st.status === 'loading' || st.status === 'idle') && !all.length ? (
          <div className="ncp__loading"><LCSkeleton shape="lines" count={5} label="Loading notifications" /></div>
        ) : st.status === 'error' && !all.length ? (
          <div className="ncp__pad"><LCError what={st.error || 'Notifications could not be read right now.'} onRetry={retryStories} /></div>
        ) : list.length === 0 ? (
          <div className="ncp__empty">
            <span className="ncp__empty-mark" aria-hidden="true"><Icon name={EMPTY_COPY[lens].icon} size={18} /></span>
            <LCEmpty title={EMPTY_COPY[lens].title} body={EMPTY_COPY[lens].body} tone="calm" />
          </div>
        ) : (
          sections.map((sec) => (
            <section key={sec.key} className="ncp__section" aria-label={sec.label}>
              <h3 className="ncp__section-title">{sec.label}</h3>
              <ol className="ncp__list">
                {sec.items.map((s) => (
                  <StoryRow
                    key={s.id}
                    story={s}
                    now={now}
                    expanded={expanded === s.id}
                    sel={sel}
                    swipe={swiped?.id === s.id ? swiped.side : null}
                    onSwipe={(side) => setSwiped(side ? { id: s.id, side } : null)}
                    onToggle={() => setExpanded((cur) => (cur === s.id ? null : s.id))}
                    onDone={onClose}
                    onRuleSettings={(rule) => openSettings(rule)}
                    onResolved={(ids) => resolveSignals(ids)}
                  />
                ))}
              </ol>
            </section>
          ))
        )}
        {st.reconciling && list.length ? <div className="ncp__reconcile" aria-hidden="true"><LCSkeleton shape="lines" count={2} label="Updating notifications" /></div> : null}

        {st.nextCursor && list.length ? (
          <div className="ncp__more">
            <LCButton variant="ghost" size="sm" loading={st.loadingMore} onClick={() => void loadMoreStories()}>Earlier</LCButton>
          </div>
        ) : null}
      </div>

      {sel.active ? (
        <LCBulkBar
          className="ncp__bulk"
          count={sel.count}
          inView={order.length}
          all={sel.all}
          noun={NOUN}
          onSelectAll={sel.selectAll}
          onClear={sel.clear}
          progress={busy}
          actions={[
            { id: 'read', label: 'Mark read', icon: 'check', onRun: () => void runBulk('read', selUnread), disabled: !selUnread.length, disabledReason: 'Already read' },
            { id: 'resolve', label: 'Resolve', icon: 'check-double', onRun: () => void runBulk('resolve', selOpen), disabled: !selOpen.length, disabledReason: 'Already resolved' },
          ]}
        />
      ) : (
        <footer className="ncp__foot">
          <span>{st.horizon ? `Since ${clockTime(st.horizon)}` : 'Last 7 days'}{st.truncated ? ' · older activity in the Machine Feed' : ''}</span>
          {st.error && all.length ? <span className="ncp__stale">Not refreshed · {st.error}</span> : <span className="ncp__keys">↑↓ move · ↵ open · ⇧↵ inspect · space select · swipe to act</span>}
        </footer>
      )}
      </>)}
    </section>
  )
}

function lensCount(l: StoryLens, c: ReturnType<typeof useStoryStore>['counts']) {
  if (!c) return null
  const n = l === 'needs_you' ? c.needs_you : l === 'now' ? c.now_unread : l === 'system' ? c.system_active : 0
  return n ? <span className={cx('ncp__count', l === 'needs_you' && 'is-needs')}>{n}</span> : null
}

/* ── swipe: pointer drag (mouse / pen / touch) + trackpad horizontal scroll ── */

function useStorySwipe({ side, onSettle, canEnd }: { side: SwipeSide | null; onSettle: (r: { open: SwipeSide | null; commit: SwipeSide | null }) => void; canEnd: boolean }) {
  const slideRef = useRef<HTMLDivElement>(null)
  const [dx, setDx] = useState(0)
  const [dragging, setDragging] = useState(false)
  const g = useRef<{ x: number; y: number; id: number; live: boolean; base: number } | null>(null)
  const suppressClick = useRef(false)
  const wheel = useRef<{ acc: number; t: ReturnType<typeof setTimeout> | null }>({ acc: 0, t: null })
  const base = side === 'start' ? SWIPE_TRAY_PX * 0.55 : side === 'end' ? -SWIPE_TRAY_PX : 0
  const width = () => slideRef.current?.getBoundingClientRect().width ?? 400
  const opts = { canStart: true, canEnd }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as Element).closest('.ncs__check, .ncs__toggle, .ncs__more, .ncs__tray')) return
    g.current = { x: e.clientX, y: e.clientY, id: e.pointerId, live: false, base }
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = g.current
    if (!s || s.id !== e.pointerId) return
    const mx = e.clientX - s.x
    const my = e.clientY - s.y
    if (!s.live) {
      if (Math.abs(mx) < 8 || Math.abs(mx) < Math.abs(my) * 1.2) { if (Math.abs(my) > 10) g.current = null; return }
      s.live = true
      setDragging(true)
      try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* ignore */ }
    }
    let next = s.base + mx
    if (!canEnd && next < 0) next = next * 0.15
    setDx(dampSwipe(next, width()))
  }
  const end = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = g.current
    g.current = null
    if (!s || !s.live) return
    suppressClick.current = true
    setDragging(false)
    const r = settleSwipe(dx, width(), opts)
    setDx(0)
    onSettle(r)
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch { /* ignore */ }
  }
  // the click that ends a drag is not an Open
  const onClickCapture = (e: MouseEvent) => { if (suppressClick.current) { suppressClick.current = false; e.preventDefault(); e.stopPropagation() } }

  // trackpad: a horizontal two-finger scroll moves the row; it settles when the gesture stops
  useEffect(() => {
    const el = slideRef.current
    if (!el) return
    const w = wheel.current
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) || Math.abs(e.deltaX) < 1) return
      e.preventDefault()
      w.acc = (w.t ? w.acc : base) - e.deltaX
      setDragging(true)
      setDx(dampSwipe(!canEnd && w.acc < 0 ? w.acc * 0.15 : w.acc, el.getBoundingClientRect().width))
      if (w.t) clearTimeout(w.t)
      w.t = setTimeout(() => {
        w.t = null
        setDragging(false)
        const r = settleSwipe(w.acc, el.getBoundingClientRect().width, { canStart: true, canEnd })
        w.acc = 0
        setDx(0)
        onSettle(r)
      }, 140)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => { el.removeEventListener('wheel', onWheel); if (w.t) clearTimeout(w.t) }
  }, [base, canEnd, onSettle])

  const offset = dragging ? dx : base
  return { slideRef, offset, dragging, onPointerDown, onPointerMove, onPointerUp: end, onPointerCancel: end, onClickCapture }
}

/* ── one story ───────────────────────────────────────────────────────────── */

interface RowProps {
  story: Story
  now: number
  expanded: boolean
  sel: LcSelection
  swipe: SwipeSide | null
  onSwipe: (side: SwipeSide | null) => void
  onToggle: () => void
  onDone: () => void
  onRuleSettings: (rule: string | null) => void
  onResolved: (ids: string[]) => void
}

function StoryRow({ story: s, now, expanded, sel, swipe, onSwipe, onToggle, onDone, onRuleSettings, onResolved }: RowProps) {
  const ref = useMemo(() => storyObject(s), [s])
  const run = useMemo(() => runObject(s), [s])
  const src = useMemo(() => storySource(s), [s])
  const tone = storyTone(s)
  const reduced = useLcReducedMotion()
  const selected = sel.isSelected(s.id)
  const summary = s.summary || subjectLine(s)
  // the chip says why it matters — unless the title already says exactly that
  const showReason = Boolean(s.reason) && !s.title.toLowerCase().endsWith((s.reason || '').replace(/\s*✓$/, '').toLowerCase())
  const signalRule = s.signal?.rule_keys?.[0] ?? null
  // colour carries meaning only: red failure, green resolved; everything else is a calm neutral chip
  const chipTone = s.state.tone === 'red' ? 'red' : s.state.tone === 'green' || s.resolved ? 'green' : 'neutral'
  const marker = s.resolved ? null : s.priority === 'critical' || tone === 'red' ? 'crit' : s.requires_operator ? 'needs' : null

  const open = useCallback(() => {
    if (!ref) { onToggle(); return }
    if (!s.read) void markStories([s.id], 'read')
    if (openObject(ref).ok) onDone()
  }, [ref, s.id, s.read, onToggle, onDone])
  const resolve = useCallback(() => { void actOnStories([s.id], 'resolve').then((r) => onResolved(r.ids)) }, [s.id, onResolved])
  const toggleRead = useCallback(() => { void actOnStories([s.id], s.read ? 'unread' : 'read') }, [s.id, s.read])

  const onSettle = useCallback((r: { open: SwipeSide | null; commit: SwipeSide | null }) => {
    if (r.commit === 'end') { onSwipe(null); if (!s.resolved) resolve(); return }
    if (r.commit === 'start') { onSwipe(null); open(); return }
    onSwipe(r.open)
  }, [onSwipe, resolve, open, s.resolved])
  const { slideRef, offset, dragging, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClickCapture } = useStorySwipe({ side: swipe, onSettle, canEnd: true })

  // Open marks the story read; Inspect is a look, not a read (the registry owns any object-side effects)
  const act = (fn: (r: ObjectRef) => { ok: boolean }, target: ObjectRef | null = ref, { reads = true } = {}) => {
    if (!target) return
    if (reads && !s.read) void markStories([s.id], 'read')
    const r = fn(target)
    if (r.ok) onDone()
  }
  const activate = (e: MouseEvent | KeyboardEvent) => {
    if (swipe) { onSwipe(null); return }
    // selecting: ⌘ toggles, ⇧ extends (only while a selection is active; otherwise they keep their object meaning)
    if (sel.onRowClick(s.id, e)) { e.preventDefault(); return }
    if (!ref) { onToggle(); return }
    const g = handleObjectClick(e, ref)
    if (g !== 'inspect' && !s.read) void markStories([s.id], 'read')
    if (g) onDone()
  }
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); activate(e) }
    else if (e.key === 'ArrowRight' && !expanded) { e.preventDefault(); onToggle() }
    else if (e.key === 'ArrowLeft' && expanded) { e.preventDefault(); onToggle() }
  }
  const onCheck = (e: MouseEvent) => { e.stopPropagation(); sel.onRowClick(s.id, e, true) }

  return (
    <li
      className={cx('ncs', `is-${tone}`, `app-${src.app}`, !s.read && !s.resolved && 'is-unread', expanded && 'is-open', s.resolved && 'is-resolved', selected && 'is-selected', swipe && `is-swiped-${swipe}`, dragging && 'is-dragging', reduced && 'is-still')}
      data-story={s.id}
      data-lens={s.lens}
    >
      {/* the trays behind the row: right swipe → Open · left swipe → Read / Resolve */}
      <div className="ncs__tray is-start" aria-hidden={swipe !== 'start'}>
        {ref ? <button type="button" className="ncs__tray-btn is-open-btn" tabIndex={swipe === 'start' ? 0 : -1} onClick={() => { onSwipe(null); open() }}><Icon name="arrow-up-right" size={14} /><span>Open</span></button> : null}
      </div>
      <div className="ncs__tray is-end" aria-hidden={swipe !== 'end'}>
        {!s.resolved ? <button type="button" className="ncs__tray-btn" tabIndex={swipe === 'end' ? 0 : -1} onClick={() => { onSwipe(null); toggleRead() }}><Icon name={s.read ? 'eye' : 'check'} size={14} /><span>{s.read ? 'Unread' : 'Read'}</span></button> : null}
        {!s.resolved ? <button type="button" className="ncs__tray-btn is-resolve-btn" tabIndex={swipe === 'end' ? 0 : -1} onClick={() => { onSwipe(null); resolve() }}><Icon name="check-double" size={14} /><span>Resolve</span></button> : null}
      </div>

      <div
        ref={slideRef}
        className="ncs__slide"
        style={{ transform: offset ? `translate3d(${offset}px,0,0)` : undefined }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onClickCapture={onClickCapture}
      >
        <div className="ncs__row">
          <span className="ncs__lead">
            <span className="ncs__glyph" title={src.label} aria-hidden="true">
              <Icon name={src.icon} size={14} />
              {marker ? <i className={cx('ncs__marker', `is-${marker}`)} /> : null}
            </span>
            <input
              type="checkbox"
              className="ncs__check"
              checked={selected}
              aria-label={`Select ${s.title}`}
              onClick={onCheck}
              onChange={() => { /* the click carries the gesture (⇧ range) */ }}
              tabIndex={-1}
            />
          </span>
          <button
            type="button"
            className="ncs__main"
            onClick={activate}
            onKeyDown={onKey}
            title={ref ? `Open · ⇧ Inspect · ${MOD_KEY} Open beside` : undefined}
            aria-describedby={summary ? `ncs-${s.id}-sum` : undefined}
          >
            <span className="ncs__body">
              <span className="ncs__top">
                <b className="ncs__title">{s.title}</b>
                <span className="ncs__when">
                  {!s.read && !s.resolved ? <i className="ncs__unread" aria-label="Unread" /> : null}
                  <time dateTime={s.updated_at} title={clockTime(s.updated_at)}>{relTime(s.updated_at, now)}</time>
                </span>
              </span>
              {summary ? <span id={`ncs-${s.id}-sum`} className="ncs__summary">{summary}</span> : null}
              {showReason || signalRule ? (
                <span className="ncs__tags">
                  {showReason ? <span key={s.state.code} className={cx('ncs__reason', `is-${chipTone}`)}>{s.reason}</span> : null}
                  {signalRule ? <span className="ncs__signal"><Icon name="radar" size={10} />Signal</span> : null}
                </span>
              ) : null}
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
                <li key={c.id} className={cx(`is-${c.tone === 'red' || c.tone === 'green' ? c.tone : 'neutral'}`, c.role === 'trigger' && 'is-trigger')}>
                  <time dateTime={c.at}>{clockTime(c.at)}</time>
                  <span><b>{c.label}</b>{c.detail ? <em>{c.detail}</em> : null}</span>
                </li>
              ))}
            </ol>
            <div className="ncs__actions">
              {ref ? <LCButton size="sm" variant="secondary" icon="layout-split" onClick={() => act(openObjectBeside)}>Open beside</LCButton> : null}
              {ref ? <LCButton size="sm" variant="quiet" icon="eye" onClick={() => act(inspectObject, ref, { reads: false })}>Inspect</LCButton> : null}
              {signalRule ? <LCButton size="sm" variant="quiet" icon="radar" onClick={() => onRuleSettings(signalRule)}>Rule settings</LCButton> : null}
              {run ? <LCButton size="sm" variant="quiet" icon="activity" onClick={() => act(openObject, run)}>Review run</LCButton> : null}
              {ref ? s.missions.map((m) => <LCButton key={m.kind} size="sm" variant="quiet" icon="target" onClick={() => act((r) => startObjectMission(r, m.kind))}>{m.label}</LCButton>) : null}
              {s.replay ? <LCButton size="sm" variant="quiet" icon="clock" onClick={() => { if (!s.read) void markStories([s.id], 'read'); openReplay(s.replay!); onDone() }}>Replay</LCButton> : null}
              <span className="ncs__spacer" />
              {!s.resolved ? <LCButton size="sm" variant="ghost" onClick={toggleRead}>{s.read ? 'Mark unread' : 'Mark read'}</LCButton> : null}
              {s.resolved && s.resolved_by === 'operator' ? <LCButton size="sm" variant="ghost" onClick={() => void actOnStories([s.id], 'reopen')}>Reopen</LCButton> : null}
              {!s.resolved ? <LCButton size="sm" variant="ghost" icon="check" onClick={resolve}>Resolve</LCButton> : null}
            </div>
          </div>
        ) : null}
      </div>
    </li>
  )
}

/** Only real context — never filler. */
function subjectLine(s: Story): string {
  if (s.resolved_by === 'superseded') return 'Newer activity on this conversation carries it forward'
  return ''
}
