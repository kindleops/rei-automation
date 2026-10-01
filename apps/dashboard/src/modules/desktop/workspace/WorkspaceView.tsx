import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { Icon } from '../../../shared/icons'
import { LCMenu, LCTooltip, cx, useLcReducedMotion, type LCMenuEntry } from '../../../shared/lc'
import { getApp, NEXUS_APPS, type AppId } from '../../../domain/app-registry/app-registry'
import { appHue } from '../../mobile/app-hues'
import { setSoundSurface, sound } from '../../../shared/sound'
import { AppInstanceHost } from './AppInstanceHost'
import { beginDrag, useDrag } from './drag'
import * as L from './layout'
import {
  activateTab, closeApp, closePaneApps, focusPane, markPaneInteraction, movePane, onWorkspaceEvent, openApp,
  resetSplit, setPinned, setSplitSizes, startWorkspace, toggleMaximize, useWorkspace, type WorkspaceSnapshot,
} from './workspace-store'
import { useWorkspaceKeys } from './keys'
import './workspace.css'

/**
 * THE WORKSPACE — one environment, several intelligence planes.
 *
 * Renders the layout tree: splits lay out by flex-grow (so a closing pane can
 * give its space back smoothly), panes carry minimal chrome only when there is
 * more than one thing to tell apart, and every app instance mounts inside a
 * `.dsk-pane__body` — the size container every desktop surface already lays
 * itself out against. Visible panes and the last-used background tab of each
 * stack stay mounted (state and scroll survive a tab switch); older background
 * tabs unmount and come back from their own path.
 */

const appMeta = (app: string) => { try { return getApp(app as AppId) } catch { return null } }
const label = (app: string) => appMeta(app)?.label ?? (app === 'settings' ? 'Settings' : app)
const shortLabel = (app: string) => appMeta(app)?.shortLabel ?? label(app)

/* ── minimum sizes of a subtree, for divider clamping ─────────────────── */

function minPx(node: L.LayoutNode, axis: 'w' | 'h', ws: WorkspaceSnapshot): number {
  if (node.kind === 'pane') {
    const g = L.geometryFor(ws.layout.instances[node.active]?.app ?? '')
    return axis === 'w' ? g.minW * 0.8 : g.minH * 0.8
  }
  const along = (node.dir === 'row') === (axis === 'w')
  const kids = node.children.map((c) => minPx(c, axis, ws))
  return along ? kids.reduce((a, b) => a + b, 0) : Math.max(...kids)
}

/* ── stable close handlers (memoized hosts must not re-render on layout) ── */

const closeFns = new Map<string, () => void>()
function closerFor(id: string) {
  let fn = closeFns.get(id)
  if (!fn) { fn = () => closeApp(id); closeFns.set(id, fn) }
  return fn
}

/* ── keep-alive: the active tab plus the one used just before it ────────── */

const recentTabs = new Map<string, string[]>()
function mountedTabs(pane: L.PaneNode): string[] {
  const prev = (recentTabs.get(pane.id) ?? []).filter((t) => pane.tabs.includes(t) && t !== pane.active)
  const next = [pane.active, ...prev].slice(0, 2)
  recentTabs.set(pane.id, next)
  return pane.tabs.filter((t) => next.includes(t))
}

/* ── divider ───────────────────────────────────────────────────────────── */

function Divider({ split, index, containerRef, ws, onResizing }: { split: L.SplitNode; index: number; containerRef: React.RefObject<HTMLDivElement | null>; ws: WorkspaceSnapshot; onResizing: (v: boolean) => void }) {
  const [active, setActive] = useState(false)
  const row = split.dir === 'row'

  const clampPair = useCallback((a: number, sizes: number[], length: number) => {
    const pair = sizes[index] + sizes[index + 1]
    const minA = minPx(split.children[index], row ? 'w' : 'h', ws) / length
    const minB = minPx(split.children[index + 1], row ? 'w' : 'h', ws) / length
    return Math.min(pair - Math.min(minB, pair / 2), Math.max(Math.min(minA, pair / 2), a))
  }, [index, row, split.children, ws])

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    const el = containerRef.current
    if (!el) return
    const box = el.getBoundingClientRect()
    const length = row ? box.width : box.height
    const start = [...split.sizes]
    const before = start.slice(0, index).reduce((s, v) => s + v, 0)
    let raf = 0
    let last = start
    setActive(true)
    onResizing(true)
    const move = (ev: PointerEvent) => {
      const at = ((row ? ev.clientX - box.left : ev.clientY - box.top) / length) - before
      const a = clampPair(at, start, length)
      const pair = start[index] + start[index + 1]
      last = [...start]
      last[index] = a
      last[index + 1] = pair - a
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; setSplitSizes(split.id, last) })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (raf) { cancelAnimationFrame(raf); setSplitSizes(split.id, last) }
      setActive(false)
      onResizing(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const nudge = (delta: number) => {
    const el = containerRef.current
    const length = el ? (row ? el.clientWidth : el.clientHeight) : 1000
    const sizes = [...split.sizes]
    const pair = sizes[index] + sizes[index + 1]
    const a = clampPair(sizes[index] + delta, sizes, length)
    sizes[index] = a
    sizes[index + 1] = pair - a
    setSplitSizes(split.id, sizes)
  }

  const share = Math.round((split.sizes[index] / (split.sizes[index] + split.sizes[index + 1])) * 100)
  return (
    <div
      className={cx('ws-divider', row ? 'is-row' : 'is-col', active && 'is-active')}
      role="separator"
      tabIndex={0}
      aria-orientation={row ? 'vertical' : 'horizontal'}
      aria-valuenow={share}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="Resize panes — double-click to reset"
      onPointerDown={onPointerDown}
      onDoubleClick={() => resetSplit(split.id)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 0.08 : 0.02
        if ((row && e.key === 'ArrowLeft') || (!row && e.key === 'ArrowUp')) { e.preventDefault(); nudge(-step) }
        else if ((row && e.key === 'ArrowRight') || (!row && e.key === 'ArrowDown')) { e.preventDefault(); nudge(step) }
        else if (e.key === 'Enter') { e.preventDefault(); resetSplit(split.id) }
      }}
    ><i aria-hidden="true" /></div>
  )
}

/* ── pane chrome ───────────────────────────────────────────────────────── */

function Glyph({ app, size = 13 }: { app: string; size?: number }) {
  const meta = appMeta(app)
  return <span className="ws-glyph" aria-hidden="true"><Icon name={meta?.icon ?? (app === 'settings' ? 'settings' : 'grid')} size={size} strokeWidth={1.75} /></span>
}

function MaxGlyph({ restore }: { restore: boolean }) {
  return restore ? (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="2.5" y="5.5" width="8" height="8" rx="1.6" /><path d="M5.5 5.5V3.9c0-.8.6-1.4 1.4-1.4h5.2c.8 0 1.4.6 1.4 1.4v5.2c0 .8-.6 1.4-1.4 1.4h-1.6" /></svg>
  ) : (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="2" /></svg>
  )
}

function PaneHeader({ pane, ws, rects }: { pane: L.PaneNode; ws: WorkspaceSnapshot; rects: () => Record<string, L.Rect> }) {
  const active = ws.layout.instances[pane.active]
  const isMax = ws.layout.maximized === pane.id
  const multiPane = L.panes(ws.layout.root).length > 1
  const overflow = pane.tabs.length > 4
  const shown = overflow ? pane.tabs.filter((t, i) => i < 3 || t === pane.active) : pane.tabs
  const hidden = overflow ? pane.tabs.filter((t) => !shown.includes(t)) : []

  const others = L.panes(ws.layout.root).filter((p) => p.id !== pane.id)
  const openApps = new Set(Object.values(ws.layout.instances).map((i) => i.app))
  const splittable = NEXUS_APPS.filter((a) => a.desktop && !a.action && !a.route.startsWith('__') && !openApps.has(a.id))
  const menu: LCMenuEntry[] = [
    ...(multiPane ? [
      { kind: 'sub' as const, id: 'move', label: 'Move', items: (['left', 'right', 'top', 'bottom'] as L.Side[]).map((side) => ({ id: `mv-${side}`, label: side === 'top' ? 'Up' : side === 'bottom' ? 'Down' : side[0].toUpperCase() + side.slice(1), disabled: !L.neighbour(ws.layout, pane.id, side, rects()), reason: 'Nothing on that side', onSelect: () => movePane(pane.id, side, rects()) })) },
      { kind: 'sub' as const, id: 'stack', label: 'Add to stack of…', items: others.map((p) => ({ id: `st-${p.id}`, label: label(ws.layout.instances[p.active]?.app ?? ''), onSelect: () => { openApp(active.path, { pane: p.id, zone: 'stack' }); sound.workspace.drop('stack') } })) },
    ] : []),
    { kind: 'sub' as const, id: 'split', label: 'Open beside…', items: splittable.map((a) => ({ id: `sp-${a.id}`, label: a.label, icon: a.icon, onSelect: () => { openApp(a.route, { pane: pane.id, zone: 'right' }); sound.workspace.drop('split') } })) },
    { kind: 'separator', id: 's1' },
    active?.pinned
      ? { id: 'unpin', label: 'Follow selection again', icon: 'link', onSelect: () => setPinned(active.id, false) }
      : { id: 'pin', label: 'Pin to this subject', hint: 'Stops following the workspace selection', icon: 'pin', onSelect: () => setPinned(active.id, true) },
    ...(multiPane ? [{ id: 'max', label: isMax ? 'Restore layout' : 'Maximize', shortcut: '⌥⏎', onSelect: () => toggleMaximize(pane.id) }] : []),
    { kind: 'separator', id: 's2' },
    { id: 'close', label: pane.tabs.length > 1 ? `Close ${label(active?.app ?? '')}` : 'Close pane', onSelect: () => closeApp(active.id) },
    ...(pane.tabs.length > 1 && multiPane ? [{ id: 'closeall', label: 'Close pane and its stack', onSelect: () => closePaneApps(pane.id) }] : []),
  ]

  const startTabDrag = (e: ReactPointerEvent, instanceId: string) => {
    const inst = ws.layout.instances[instanceId]
    if (!inst) return
    beginDrag(e, { kind: 'instance', path: inst.path, app: inst.app, label: label(inst.app), instanceId })
  }

  return (
    <header className="ws-head" onDoubleClick={(e) => { if ((e.target as HTMLElement).closest('button')) return; if (multiPane) toggleMaximize(pane.id) }}>
      <div className="ws-tabs" role="tablist" aria-label="Applications in this pane">
        {shown.map((id) => {
          const inst = ws.layout.instances[id]
          if (!inst) return null
          const on = id === pane.active
          const closing = Boolean(ws.closing[id])
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={on}
              className={cx('ws-tab', on && 'is-active', closing && 'is-closing', inst.pinned && 'is-pinned')}
              style={{ ['--app' as string]: appHue(inst.app) }}
              onPointerDown={(e) => startTabDrag(e, id)}
              onClick={() => { if (!on) { activateTab(pane.id, id); sound.workspace.tab() } }}
              onAuxClick={(e) => { if (e.button === 1 && pane.tabs.length > 1) closeApp(id) }}
              title={pane.tabs.length > 1 ? `${label(inst.app)} — drag out to split` : label(inst.app)}
            >
              <Glyph app={inst.app} />
              <span className="ws-tab__name">{pane.tabs.length > 2 ? shortLabel(inst.app) : label(inst.app)}</span>
              {inst.pinned ? <Icon name="pin" size={10} className="ws-tab__pin" /> : null}
              {pane.tabs.length > 1 && on ? (
                <span className="ws-tab__x" role="button" tabIndex={-1} aria-label={`Close ${label(inst.app)}`} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); closeApp(id) }}><Icon name="x" size={10} /></span>
              ) : null}
            </button>
          )
        })}
        {hidden.length ? (
          <LCMenu
            trigger={<button type="button" className="ws-tab ws-tab--more" aria-label={`${hidden.length} more in this stack`}>+{hidden.length}<Icon name="chevron-down" size={10} /></button>}
            items={hidden.map((id) => ({ id, label: label(ws.layout.instances[id]?.app ?? ''), onSelect: () => activateTab(pane.id, id) }))}
            align="start"
          />
        ) : null}
      </div>
      {active?.pinned && active.pinLabel ? <span className="ws-head__pin" title="Pinned — this pane keeps its subject"><Icon name="pin" size={10} />{active.pinLabel}</span> : null}
      <span className="ws-head__tools">
        {multiPane ? (
          <LCTooltip content={isMax ? 'Restore layout' : 'Maximize'} side="bottom">
            <button type="button" className="ws-tool" aria-label={isMax ? 'Restore layout' : 'Maximize pane'} onClick={() => toggleMaximize(pane.id)}><MaxGlyph restore={isMax} /></button>
          </LCTooltip>
        ) : null}
        <LCMenu trigger={<button type="button" className="ws-tool" aria-label="Pane options"><Icon name="more" size={14} /></button>} items={menu} />
        {multiPane || pane.tabs.length > 1 ? (
          <LCTooltip content={pane.tabs.length > 1 ? `Close ${label(active?.app ?? '')}` : 'Close pane'} side="bottom">
            <button type="button" className="ws-tool" aria-label={`Close ${label(active?.app ?? '')}`} onClick={() => active && closeApp(active.id)}><Icon name="x" size={13} /></button>
          </LCTooltip>
        ) : null}
      </span>
    </header>
  )
}

/* ── pane ──────────────────────────────────────────────────────────────── */

const PaneView = memo(function PaneView({ pane, ws, chrome, rects }: { pane: L.PaneNode; ws: WorkspaceSnapshot; chrome: boolean; rects: () => Record<string, L.Rect> }) {
  const ref = useRef<HTMLElement | null>(null)
  const active = ws.layout.instances[pane.active]
  const multiPane = L.panes(ws.layout.root).length > 1
  const focused = multiPane && ws.layout.focus === pane.id
  const isMax = ws.layout.maximized === pane.id
  const behindMax = Boolean(ws.layout.maximized) && !isMax
  const closing = pane.tabs.length === 1 && Boolean(ws.closing[pane.tabs[0]])
  const entering = Boolean(ws.entering[pane.id])
  const [box, setBox] = useState<{ w: number; h: number } | null>(null)
  const [toRail, setToRail] = useState<{ x: number; y: number } | null>(null)
  const tabs = mountedTabs(pane)

  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect
      setBox((prev) => (prev && Math.abs(prev.w - r.width) < 1 && Math.abs(prev.h - r.height) < 1 ? prev : { w: r.width, h: r.height }))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // the closing pane resolves toward its app in the command rail
  useLayoutEffect(() => {
    if (!closing || !active) return
    const el = ref.current
    const row = document.querySelector<HTMLElement>(`.cr-row[data-app="${active.app}"]`)
    if (!el || !row) return
    const a = el.getBoundingClientRect()
    const b = row.getBoundingClientRect()
    setToRail({ x: (b.left + b.width / 2 - (a.left + a.width / 2)) * 0.06, y: (b.top + b.height / 2 - (a.top + a.height / 2)) * 0.06 })
  }, [closing, active])

  const g = L.geometryFor(active?.app ?? '')
  const cramped = Boolean(box && multiPane && !isMax && (box.w < g.minW * 0.72 || box.h < g.minH * 0.72))
  const style = {
    '--app': appHue(active?.app ?? ''),
    ...(toRail ? { '--to-rail-x': `${toRail.x}px`, '--to-rail-y': `${toRail.y}px` } : {}),
  } as CSSProperties

  return (
    <section
      ref={ref}
      data-ws-pane={pane.id}
      className={cx('ws-pane', focused && 'is-focused', isMax && 'is-maximized', behindMax && 'is-behind', closing && 'is-closing', entering && 'is-entering', chrome && 'has-chrome')}
      style={style}
      aria-label={label(active?.app ?? '')}
      onPointerDownCapture={() => { markPaneInteraction(pane.id); if (ws.layout.focus !== pane.id) focusPane(pane.id) }}
      onKeyDownCapture={() => markPaneInteraction(pane.id)}
      onFocusCapture={() => { if (ws.layout.focus !== pane.id) focusPane(pane.id) }}
    >
      <div className="ws-pane__frame">
        {chrome ? <PaneHeader pane={pane} ws={ws} rects={rects} /> : null}
        <div className="ws-pane__stage">
          {tabs.map((id) => {
            const inst = ws.layout.instances[id]
            if (!inst) return null
            const background = id !== pane.active
            const bgProps = background ? ({ inert: '', 'aria-hidden': true } as Record<string, unknown>) : {}
            return (
              <div key={id} className={cx('dsk-pane__body', background && 'is-background')} {...bgProps}>
                <AppInstanceHost
                  inst={inst}
                  primary={id === ws.layout.primary}
                  visible={!background && !behindMax}
                  follows={ws.linked}
                  onClose={multiPane || pane.tabs.length > 1 ? closerFor(id) : null}
                />
              </div>
            )
          })}
          {cramped ? (
            <div className="ws-cramped">
              <Glyph app={active?.app ?? ''} size={16} />
              <strong>Needs more space</strong>
              <span>{label(active?.app ?? '')} needs about {g.minW}px to stay usable.</span>
              <div className="ws-cramped__actions">
                <button type="button" onClick={() => toggleMaximize(pane.id)}>Expand pane</button>
                {L.panes(ws.layout.root).length > 1 ? (
                  <button type="button" onClick={() => {
                    const host = L.panes(ws.layout.root).filter((p) => p.id !== pane.id).sort((x, y) => (rects()[y.id]?.w ?? 0) - (rects()[x.id]?.w ?? 0))[0]
                    if (host && active) openApp(active.path, { pane: host.id, zone: 'stack' })
                  }}>Stack instead</button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
})

/* ── tree ──────────────────────────────────────────────────────────────── */

function NodeView({ node, ws, chrome, rects, onResizing }: { node: L.LayoutNode; ws: WorkspaceSnapshot; chrome: boolean; rects: () => Record<string, L.Rect>; onResizing: (v: boolean) => void }) {
  const ref = useRef<HTMLDivElement | null>(null)
  if (node.kind === 'pane') return <PaneView pane={node} ws={ws} chrome={chrome} rects={rects} />
  const closingCell = (c: L.LayoutNode) => c.kind === 'pane' && c.tabs.length === 1 && Boolean(ws.closing[c.tabs[0]])
  const enteringCell = (c: L.LayoutNode) => c.kind === 'pane' && Boolean(ws.entering[c.id])
  return (
    <div ref={ref} className={cx('ws-split', node.dir === 'row' ? 'is-row' : 'is-col')}>
      {node.children.map((c, i) => (
        <Fragment key={c.id}>
          {i > 0 ? <Divider split={node} index={i - 1} containerRef={ref} ws={ws} onResizing={onResizing} /> : null}
          <div className={cx('ws-cell', closingCell(c) && 'is-closing', enteringCell(c) && 'is-entering')} style={{ ['--g' as string]: node.sizes[i] }}>
            <NodeView node={c} ws={ws} chrome={chrome} rects={rects} onResizing={onResizing} />
          </div>
        </Fragment>
      ))}
    </div>
  )
}

/* ── drop overlay ──────────────────────────────────────────────────────── */

function DropOverlay() {
  const drag = useDrag()
  if (!drag.active || !drag.source) return null
  const ox = drag.root?.x ?? 0
  const oy = drag.root?.y ?? 0
  const t = drag.target
  const hoverPane = t ? drag.rects[t.pane] : null
  const rel = (r: L.Rect) => ({ left: r.x - ox, top: r.y - oy, width: r.w, height: r.h })
  const zoneLabel = t ? (t.blocked ? t.blocked : t.zone === 'stack' ? 'Add to stack' : t.zone === 'replace' ? 'Replace' : `${Math.round(t.share * 100)}%`) : null
  const pill = hoverPane && drag.replaceRect ? drag.replaceRect : null
  return (
    <div className="ws-drop" aria-hidden="true">
      {hoverPane ? (
        <div className="ws-drop__pane" style={rel(hoverPane)}>
          <i className="ws-drop__edge is-l" /><i className="ws-drop__edge is-r" /><i className="ws-drop__edge is-t" /><i className="ws-drop__edge is-b" />
          <span className={cx('ws-drop__centre', t?.zone === 'stack' && !t.blocked && 'is-on')}>Stack</span>
        </div>
      ) : null}
      {pill ? <span className={cx('ws-drop__replace', t?.zone === 'replace' && 'is-on')} style={rel(pill)}>Replace</span> : null}
      {t ? (
        <div className={cx('ws-drop__preview', `is-${t.zone}`, t.blocked && 'is-blocked')} style={rel(t.preview)}>
          {zoneLabel ? <span className="ws-drop__label">{zoneLabel}</span> : null}
        </div>
      ) : null}
      <div className="ws-drag-chip" style={{ transform: `translate(${drag.x - ox + 14}px, ${drag.y - oy + 12}px)`, ['--app' as string]: appHue(drag.source.app) }}>
        <Glyph app={drag.source.app} size={14} />
        <b>{drag.source.label}</b>
      </div>
    </div>
  )
}

/* ── the workspace ─────────────────────────────────────────────────────── */

export function WorkspaceView() {
  const ws = useWorkspace()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [resizing, setResizing] = useState(false)
  const reduced = useLcReducedMotion()

  useEffect(() => startWorkspace(), [])
  useWorkspaceKeys()
  // claimed before paint, so settings that depend on who speaks never flash the legacy controls
  useLayoutEffect(() => { setSoundSurface('desktop'); return () => setSoundSurface('other') }, [])

  // sounds and the rail's resolve highlight follow workspace events
  useEffect(() => onWorkspaceEvent((e) => {
    if (e.type === 'opened' && e.how === 'navigate') sound.navigation.change()
    else if (e.type === 'closed') sound.workspace.close()
    else if (e.type === 'maximized') sound.workspace.maximize()
    else if (e.type === 'restored') sound.workspace.restore()
    else if (e.type === 'switched') sound.workspace.switch()
  }), [])

  // a workspace switch recedes and resolves as one surface, not six flying apps
  const gen = useRef(ws.generation)
  useEffect(() => {
    if (gen.current === ws.generation) return
    gen.current = ws.generation
    if (reduced) return
    rootRef.current?.animate(
      [{ opacity: 0.4, transform: 'scale(0.985)', filter: 'blur(6px)' }, { opacity: 1, transform: 'none', filter: 'none' }],
      { duration: 420, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
    )
  }, [ws.generation, reduced])

  // the focused app names the window
  const focused = L.focusedInstance(ws.layout)
  useEffect(() => { if (focused) document.title = `${label(focused.app)} · LeadCommand` }, [focused])

  const rects = useCallback(() => {
    const out: Record<string, L.Rect> = {}
    rootRef.current?.querySelectorAll<HTMLElement>('[data-ws-pane]').forEach((el) => {
      const r = el.getBoundingClientRect()
      out[el.dataset.wsPane!] = { x: r.left, y: r.top, w: r.width, h: r.height }
    })
    return out
  }, [])

  const all = L.panes(ws.layout.root)
  const chrome = all.length > 1 || all.some((p) => p.tabs.length > 1)
  const max = useMemo(() => Boolean(ws.layout.maximized), [ws.layout.maximized])

  return (
    <div
      ref={rootRef}
      data-ws-root
      className={cx('ws', resizing && 'is-resizing', max && 'is-max', chrome && 'has-chrome', all.length > 1 && 'is-multi')}
    >
      <NodeView node={ws.layout.root} ws={ws} chrome={chrome} rects={rects} onResizing={setResizing} />
      <DropOverlay />
      <div className="lc-sr-only" role="status" aria-live="polite">{ws.announce}</div>
    </div>
  )
}

