import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react'
import { useAuth } from '../../../../components/auth/AuthProvider'
import { replaceRoutePath, useRouteLocation } from '../../../../app/router'
import { Icon } from '../../../../shared/icons'
import { LCButton, LCMenu, lcConfirm, lcPrompt, lcToast, useLcReducedMotion, type LCMenuEntry } from '../../../../shared/lc'
import { beginDrag, registerDropSurface, type DragSource } from '../../../../modules/desktop/workspace/drag'
import { useRail } from '../../../../modules/desktop/rail/rail-store'
import { httpHomeLayoutApi } from './home-layout-api'
import {
  activeLayout,
  bootBoard,
  commitActive,
  deleteLayout,
  duplicateLayout,
  newLayoutFromPreset,
  renameLayout,
  resetActiveLayout,
  restoreLayout,
  retryServer,
  saveLayoutAs,
  setActiveLayout,
  setDefaultLayout,
  setEditing,
  setLibrary,
  useBoard,
  type BoardDeps,
} from './board-store'
import { boardRows, cellToRect, colsOf, familyFor, metricsFor, nudge, placeItem, pointToCell, resizeItem, sanitize, snaplines, FAMILY_SPEC, type Cell, type GridItem } from './home-grid'
import { addInstance, duplicateInstance, itemsFor, PRESETS, PRESET_IDS, removeInstance, updateInstance, withGeometry } from './home-layout-model'
import { parseHomeCommand, pinFromQuery, type HomeCommand } from './home-commands'
import { HOME_PIN_EVENT, queueHomePin, takeHomePins } from '../../../../modules/desktop/objects'
import { homeSourceStats, refreshAllSources, refreshForApps } from './home-sources'
import { boundsOf, getHomeWidget, homeWidgetsVersion, listHomeWidgets, sizeModeFor, subscribeHomeWidgets, SIZE_CELLS, type ContextMode, type HomeWidgetDef, type PinnedSubject, type WidgetSize } from './widget-registry'
import { registerFirstPartyWidgets, RAIL_DEFAULT_WIDGET } from './widgets/register'
import { WidgetFrame, type FrameActions } from './WidgetFrame'
import { WidgetLibrary } from './WidgetLibrary'
import { cx } from './widget-runtime'
import '../command/command-home.css'
import './home-board.css'

/**
 * HOME 2.0 — THE PERSONAL COMMAND BOARD (desktop).
 *
 * The operator's board, not ours: they decide which instruments are on it,
 * where, how large, what each shows and which saved layout opens by default.
 * Open → see the operation → interact → expand into the full app (Open /
 * Open beside / missions from any object row).
 *
 * Arrangement reuses the shell's one drag system (workspace/drag): the board
 * registers as a drop surface, so moving a widget, dragging one in from the
 * library and dragging an app off the Command Rail all share the same
 * gesture, threshold, Esc-to-cancel and click suppression. Geometry is the
 * pure engine in ./home-grid; persistence is ./board-store.
 */

registerFirstPartyWidgets()

const DEPS: BoardDeps = {
  api: httpHomeLayoutApi,
  storage: typeof window !== 'undefined' ? window.localStorage : null,
  now: () => Date.now(),
  saveDelayMs: 900,
}

const NEW_ID = '__new__'

/** Read-only measurement seam (capture scripts): pointer-move → commit times during drags. */
const PERF_PROBE = { moves: [] as number[] }

interface DragView {
  id: string
  op: 'move' | 'resize' | 'add'
  type: string | null
  preview: GridItem[]
  cell: Cell
  ghost: { left: number; top: number; width: number; height: number }
  lines: { x: number[]; y: number[] }
}

const boundsForType = (type: string) => { const d = getHomeWidget(type); return d ? boundsOf(d) : undefined }

export function HomeBoard() {
  const { user } = useAuth()
  const operatorKey = user?.id ?? 'local'
  useEffect(() => { void bootBoard(operatorKey, DEPS) }, [operatorKey])
  const board = useBoard()
  const layout = activeLayout(board)
  const regVersion = useSyncExternalStore(subscribeHomeWidgets, homeWidgetsVersion, homeWidgetsVersion)
  const reduced = useLcReducedMotion()
  const editing = board.editing

  /* ── geometry ── */
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null)
  const scrollRef = useCallback((el: HTMLDivElement | null) => { rootRef.current = el; setScrollEl(el) }, [])
  const gridRef = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = gridRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(Math.round(el.clientWidth)))
    ro.observe(el)
    setWidth(Math.round(el.clientWidth))
    return () => ro.disconnect()
  }, [board.ready])
  const family = familyFor(width || 1200)
  const metrics = useMemo(() => metricsFor(width || 1200, family), [width, family])
  const items = useMemo(() => {
    void regVersion
    return layout ? itemsFor(layout, family, boundsForType) : []
  }, [layout, family, regVersion])

  /* ── live events: the rail's ledger stream refreshes the sources of its app ── */
  const rail = useRail()
  const lastEvent = useRef<string | null>(null)
  useEffect(() => {
    const recent = rail.recent
    if (!recent.length) return
    const prev = lastEvent.current
    lastEvent.current = recent[0].id
    if (prev === null) return
    const fresh: string[] = []
    for (const e of recent) { if (e.id === prev) break; fresh.push(e.app) }
    if (fresh.length) refreshForApps(fresh)
  }, [rail.recent])
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') retryServer() }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  /* ── changes ── */
  const itemsRef = useRef(items)
  useEffect(() => { itemsRef.current = items })
  const familyRef = useRef(family)
  useEffect(() => { familyRef.current = family })

  const arrange = useCallback((next: GridItem[]) => { commitActive((l) => withGeometry(l, familyRef.current, next)) }, [])

  const addWidget = useCallback((type: string, opts: { at?: Cell; preview?: GridItem[]; subject?: PinnedSubject | null; mode?: ContextMode } = {}) => {
    const def = getHomeWidget(type)
    if (!def) return null
    let newId: string | null = null
    commitActive((l) => {
      const fam = familyRef.current
      const cur = itemsFor(l, fam, boundsForType)
      const size = def.defaultSize
      const res = addInstance(l, { type: def.id, ownerApp: def.ownerApp, size, config: { ...def.defaultConfig }, configVersion: def.configVersion ?? 1, context: { mode: opts.mode ?? 'global', subject: opts.subject ?? null } }, fam, cur, opts.at)
      newId = res.id
      const base = opts.preview ? opts.preview.map((p) => (p.id === NEW_ID ? { ...p, id: res.id } : p)) : [...cur, { id: res.id, cell: res.layout.widgets.at(-1)!.geometry[fam]!, locked: false }]
      return withGeometry(res.layout, fam, sanitize(base, colsOf(fam), (id) => (id === res.id ? boundsOf(def) : boundsForType(res.layout.widgets.find((w) => w.id === id)?.type ?? ''))))
    })
    if (newId) window.setTimeout(() => document.querySelector<HTMLElement>(`[data-widget="${newId}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 60)
    return newId
  }, [])

  const removeWidget = useCallback((id: string) => {
    const prev = activeLayout()
    const inst = prev?.widgets.find((w) => w.id === id)
    if (!prev || !inst) return
    commitActive((l) => removeInstance(l, id))
    const name = getHomeWidget(inst.type)?.name ?? 'Widget'
    lcToast({ title: `${name} removed`, severity: 'info', source: 'home', action: { label: 'Undo', onClick: () => restoreLayout(prev) } })
  }, [])

  /* ── pins (object menus / deck) ── */
  const applyPins = useCallback(() => {
    if (!activeLayout()) return
    // the pin action already confirmed it; placing it is silent
    for (const p of takeHomePins()) addWidget(p.widget, { mode: 'pinned', subject: p.subject })
  }, [addWidget])
  useEffect(() => { if (board.ready) applyPins() }, [board.ready, applyPins])
  useEffect(() => {
    window.addEventListener(HOME_PIN_EVENT, applyPins)
    return () => window.removeEventListener(HOME_PIN_EVENT, applyPins)
  }, [applyPins])

  /* ── route commands (/home?home=…) ── */
  const location = useRouteLocation()
  const libraryOpen = board.library
  const runCommand = useCallback(async (cmd: HomeCommand) => {
    switch (cmd.kind) {
      case 'customize': setEditing(true); break
      case 'library': setLibrary(true); break
      case 'add': if (addWidget(cmd.type)) setEditing(true); break
      case 'layout': setActiveLayout(cmd.id); break
      case 'preset': newLayoutFromPreset(cmd.preset); break
      case 'reset': await confirmReset(); break
    }
  }, [addWidget])
  useEffect(() => {
    if (!board.ready) return
    const q = location.includes('?') ? location.slice(location.indexOf('?')) : ''
    if (!q.includes('home=')) return
    const pin = pinFromQuery(q)
    const cmd = parseHomeCommand(q)
    replaceRoutePath('/home')
    if (pin) { queueHomePin(pin); lcToast({ title: 'Pinned to Home', detail: pin.subject.label, severity: 'success', source: 'home' }) }
    else if (cmd) void runCommand(cmd)
  }, [location, board.ready, runCommand])

  /* ── drag surface (one DnD system: workspace/drag) ── */
  const [drag, setDrag] = useState<DragView | null>(null)
  // measurement seam: pointer move → committed frame, for the performance pass
  const dragT0 = useRef(0)
  useLayoutEffect(() => {
    if (!drag || !dragT0.current) return
    const probe = PERF_PROBE.moves
    probe.push(performance.now() - dragT0.current)
    if (probe.length > 400) probe.splice(0, probe.length - 400)
    dragT0.current = 0
  }, [drag])
  const dragRef = useRef<DragView | null>(null)
  const setDragView = useCallback((v: DragView | null) => { dragRef.current = v; setDrag(v) }, [])
  const editingRef = useRef(editing)
  useEffect(() => { editingRef.current = editing })
  const metricsRef = useRef(metrics)
  useEffect(() => { metricsRef.current = metrics })

  useEffect(() => registerDropSurface({
    id: 'home',
    accepts(src: DragSource, x: number, y: number) {
      if (src.kind === 'widget') return true
      if (src.kind !== 'app' || !editingRef.current) return false
      const r = gridRef.current?.getBoundingClientRect()
      const root = rootRef.current?.getBoundingClientRect()
      const inside = (b: DOMRect | undefined) => Boolean(b && x >= b.left && x <= b.right && y >= b.top && y <= b.bottom)
      return Boolean(RAIL_DEFAULT_WIDGET[src.app] && getHomeWidget(RAIL_DEFAULT_WIDGET[src.app]) && (inside(r) || inside(root)))
    },
    over(src: DragSource, x: number, y: number) {
      dragT0.current = performance.now()
      const grid = gridRef.current?.getBoundingClientRect()
      if (!grid) return
      const m = metricsRef.current
      const cur = itemsRef.current
      const op = src.kind === 'widget' ? src.widget!.op : 'add'
      const type = src.kind === 'widget' ? (src.widget!.type ?? null) : RAIL_DEFAULT_WIDGET[src.app]
      autoScroll(rootRef.current, y)
      if (op === 'resize') {
        const id = src.widget!.id!
        const it = cur.find((i) => i.id === id)
        if (!it) return
        const start = cellToRect(it.cell, m)
        const w = Math.max(1, Math.round((x - grid.left - start.left + m.gap / 2) / (m.colW + m.gap)))
        const h = Math.max(1, Math.round((y - grid.top - start.top + m.gap / 2) / (m.rowH + m.gap)))
        const def = getHomeWidget(layoutType(id) ?? '')
        const preview = resizeItem(cur, id, { w, h }, m.cols, def ? boundsOf(def) : undefined)
        const cell = preview.find((i) => i.id === id)!.cell
        const px = cellToRect(cell, m)
        setDragView({ id, op, type: null, preview, cell, ghost: { left: start.left, top: start.top, width: Math.max(px.width, x - grid.left - start.left), height: Math.max(px.height, y - grid.top - start.top) }, lines: snaplines(preview, id, cell) })
        return
      }
      const id = op === 'move' ? src.widget!.id! : NEW_ID
      const base = op === 'move' ? cur : [...cur, { id: NEW_ID, cell: { x: 0, y: boardRows(cur) + 1, ...sizeOf(type) }, locked: false }]
      const it = base.find((i) => i.id === id)!
      const grabX = src.kind === 'widget' ? src.widget!.grabX : 24
      const grabY = src.kind === 'widget' ? src.widget!.grabY : 16
      const left = x - grid.left - grabX
      const top = y - grid.top - grabY
      const cell = pointToCell(left, top, Math.min(it.cell.w, m.cols), it.cell.h, m)
      const prevView = dragRef.current
      const preview = prevView && prevView.id === id && sameCell(prevView.cell, cell) ? prevView.preview : placeItem(base, id, cell, m.cols)
      const r = cellToRect(it.cell, m)
      setDragView({ id, op, type, preview, cell, ghost: { left, top, width: r.width, height: r.height }, lines: snaplines(preview, id, preview.find((i) => i.id === id)!.cell) })
    },
    leave() { setDragView(null) },
    drop() {
      const v = dragRef.current
      setDragView(null)
      if (!v) return false
      if (v.op === 'add') {
        if (!v.type) return false
        const cell = v.preview.find((i) => i.id === NEW_ID)?.cell
        return Boolean(addWidget(v.type, { at: cell, preview: v.preview }))
      }
      arrange(v.preview)
      return true
    },
  }), [addWidget, arrange, setDragView])

  /* ── frame actions ── */
  const actions = useMemo<FrameActions>(() => ({
    moveStart: (id, e) => {
      const el = (e.currentTarget as HTMLElement).closest<HTMLElement>('[data-widget]')
      const box = el?.getBoundingClientRect()
      beginDrag(e, () => ({ kind: 'widget', path: '/home', app: 'home', label: getHomeWidget(layoutType(id) ?? '')?.name ?? 'Widget', widget: { id, op: 'move', grabX: box ? e.clientX - box.left : 20, grabY: box ? e.clientY - box.top : 14 } }))
    },
    resizeStart: (id, e) => {
      e.stopPropagation()
      beginDrag(e, () => ({ kind: 'widget', path: '/home', app: 'home', label: 'Resize', widget: { id, op: 'resize', grabX: 0, grabY: 0 } }))
    },
    remove: removeWidget,
    duplicate: (id) => commitActive((l) => {
      const fam = familyRef.current
      const res = duplicateInstance(l, id, fam, itemsFor(l, fam, boundsForType))
      return res ? withGeometry(res.layout, fam, itemsFor(res.layout, fam, boundsForType)) : l
    }),
    key: (id, e) => {
      const dir = e.key === 'ArrowLeft' ? 'left' : e.key === 'ArrowRight' ? 'right' : e.key === 'ArrowUp' ? 'up' : e.key === 'ArrowDown' ? 'down' : null
      if (dir && e.target === e.currentTarget) {
        e.preventDefault()
        const def = getHomeWidget(layoutType(id) ?? '')
        arrange(nudge(itemsRef.current, id, dir, metricsRef.current.cols, e.shiftKey ? 'resize' : 'move', def ? boundsOf(def) : undefined))
        return
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && e.target === e.currentTarget) { e.preventDefault(); removeWidget(id) }
      if (e.key === 'Escape' && e.target === e.currentTarget) { e.preventDefault(); setEditing(false) }
    },
    config: (id, patch) => commitActive((l) => {
      const w = l.widgets.find((x) => x.id === id)
      if (!w) return l
      const def = getHomeWidget(w.type)
      return updateInstance(l, id, { config: { ...w.config, ...patch }, configVersion: def?.configVersion ?? w.configVersion })
    }),
    context: (id, mode, subject) => commitActive((l) => updateInstance(l, id, { context: { mode, subject: mode === 'pinned' ? subject : null } })),
    lock: (id, locked) => commitActive((l) => withGeometry(updateInstance(l, id, { locked }), familyRef.current, itemsRef.current.map((i) => (i.id === id ? { ...i, locked } : i)))),
    refresh: (id, ms) => commitActive((l) => updateInstance(l, id, { refreshMs: ms })),
    size: (id, size) => {
      const def = getHomeWidget(layoutType(id) ?? '')
      const next = resizeItem(itemsRef.current, id, SIZE_CELLS[size], metricsRef.current.cols, def ? boundsOf(def) : undefined)
      commitActive((l) => withGeometry(updateInstance(l, id, { size }), familyRef.current, next))
    },
  }), [arrange, removeWidget])

  /* ── layouts menu ── */
  const layoutMenu: LCMenuEntry[] = useMemo(() => {
    const cur = layout
    const out: LCMenuEntry[] = board.layouts.map((l) => ({ id: `l-${l.id}`, label: l.name, hint: l.isDefault ? 'Opens by default' : `${l.widgets.length} widget${l.widgets.length === 1 ? '' : 's'}`, checked: l.id === board.activeId, onSelect: () => setActiveLayout(l.id) }))
    out.push({ kind: 'separator', id: 'sep-1' })
    out.push({
      id: 'save-as', label: 'Save as…', icon: 'bookmark', onSelect: async () => {
        const name = await lcPrompt({ title: 'Save layout as', label: 'Name', initialValue: cur ? `${cur.name} copy` : 'My layout', confirmLabel: 'Save', nativeText: 'Name for this layout' })
        if (name?.trim()) saveLayoutAs(name)
      },
    })
    if (cur) {
      out.push({
        id: 'rename', label: 'Rename…', onSelect: async () => {
          const name = await lcPrompt({ title: 'Rename layout', label: 'Name', initialValue: cur.name, confirmLabel: 'Rename', nativeText: 'New name for this layout' })
          if (name?.trim()) renameLayout(cur.id, name)
        },
      })
      out.push({ id: 'duplicate', label: 'Duplicate', onSelect: () => { duplicateLayout(cur.id) } })
      out.push({ id: 'default', label: 'Set as default', disabled: cur.isDefault, reason: cur.isDefault ? 'This layout already opens by default' : undefined, onSelect: () => setDefaultLayout(cur.id) })
      out.push({
        id: 'delete', label: 'Delete…', tone: 'danger', disabled: board.layouts.length <= 1, reason: board.layouts.length <= 1 ? 'Home keeps at least one layout' : undefined, onSelect: async () => {
          const ok = await lcConfirm({ title: `Delete “${cur.name}”?`, effects: [{ text: 'This saved layout and its widget settings are removed.', kind: 'danger' }, { text: 'Your other layouts are not touched.', kind: 'keeps' }], confirmLabel: 'Delete layout', tone: 'danger', nativeText: `Delete the layout ${cur.name}?` })
          if (ok) deleteLayout(cur.id)
        },
      })
    }
    out.push({ kind: 'separator', id: 'sep-2' })
    out.push({ kind: 'sub', id: 'presets', label: 'New from preset', icon: 'grid', items: PRESET_IDS.map((p) => ({ id: `p-${p}`, label: PRESETS[p].name, hint: PRESETS[p].description, onSelect: () => { newLayoutFromPreset(p) } })) })
    return out
  }, [board.layouts, board.activeId, layout])

  /* ── library ── */
  const defs = useMemo(() => { void regVersion; return listHomeWidgets() }, [regVersion])
  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const w of layout?.widgets ?? []) c[w.type] = (c[w.type] ?? 0) + 1
    return c
  }, [layout])
  const libDragStart = (type: string, e: ReactPointerEvent) => {
    const d = getHomeWidget(type)
    if (!d) return
    beginDrag(e, () => ({ kind: 'widget', path: '/home', app: 'home', label: d.name, widget: { id: null, op: 'add', type, grabX: 24, grabY: 16 } }))
  }
  const capOf = (def: HomeWidgetDef | null, id: string) => {
    if (!def?.maxInstances || !layout) return false
    const same = layout.widgets.filter((w) => w.type === def.id).map((w) => w.id)
    return same.indexOf(id) >= def.maxInstances
  }

  /* ── render ── */
  const view = drag?.preview ?? items
  const rows = Math.max(boardRows(view), 4)
  const height = rows * (metrics.rowH + metrics.gap)
  const instById = useMemo(() => new Map((layout?.widgets ?? []).map((w) => [w.id, w])), [layout])

  // perf seam for the capture scripts (read-only)
  useEffect(() => { (window as unknown as { __homeBoard?: unknown }).__homeBoard = { stats: homeSourceStats, widgets: () => layout?.widgets.length ?? 0, family, dragMoves: () => PERF_PROBE.moves.slice() } }, [layout, family])

  if (!board.ready || !layout) {
    return <div className="ch hb"><div className="hb-scroll"><div className="hb-grid-wrap" ref={gridRef} /></div></div>
  }

  return (
    <div className={cx('ch hb', editing && 'is-editing', drag && 'is-dragging', reduced && 'is-still', editing && libraryOpen && 'has-library')} data-family={family}>
      <div ref={scrollRef} className="hb-scroll">
      <header className="hb-bar">
        <LCMenu
          label="Home layouts"
          title="Layouts"
          items={layoutMenu}
          trigger={<button type="button" className="hb-bar__layout" aria-label={`Layout: ${layout.name}`}><span>{layout.name}</span><Icon name="chevron-down" size={12} /></button>}
        />
        {board.persistence === 'local' ? <span className="hb-bar__note" title={board.note ?? undefined}>Saved on this device</span> : null}
        <span className="hb-bar__spacer" />
        {editing ? (
          <>
            <span className="hb-bar__hint">{FAMILY_SPEC[family].label} · arrangement saved for this width</span>
            <LCButton size="sm" variant="secondary" icon="grid" onClick={() => setLibrary(!libraryOpen)} aria-expanded={libraryOpen}>Add widget</LCButton>
            <LCButton size="sm" variant="quiet" onClick={() => arrange(sanitize(items, metrics.cols, (id) => boundsForType(instById.get(id)?.type ?? '')))} title="Close gaps and settle every widget upward">Tidy</LCButton>
            <LCButton size="sm" variant="quiet" icon="refresh-cw" onClick={() => void confirmReset()}>Reset…</LCButton>
            <LCButton size="sm" variant="primary" onClick={() => setEditing(false)}>Done</LCButton>
          </>
        ) : (
          <>
            <LCButton size="sm" variant="ghost" icon="refresh-cw" onClick={refreshAllSources} aria-label="Refresh every widget">Refresh</LCButton>
            <LCButton size="sm" variant="ghost" icon="grid" onClick={() => setEditing(true)}>Customize</LCButton>
          </>
        )}
      </header>

      <div className="hb-grid-wrap" ref={gridRef}>
        {layout.widgets.length === 0 ? (
          <div className="hb-blank">
            <span className="hb-blank__glyph" aria-hidden="true"><Icon name="grid" size={20} /></span>
            <p>Add widgets to build your command board.</p>
            <LCButton variant="secondary" icon="grid" onClick={() => setLibrary(true)}>Add widget</LCButton>
          </div>
        ) : null}
        <div className="hb-grid" style={{ height }} role="list" aria-label="Home widgets">
          {editing ? <GridGuides cols={metrics.cols} rows={rows} m={metrics} /> : null}
          {drag ? <Snaplines lines={drag.lines} m={metrics} height={height} /> : null}
          {drag ? (() => { const c = drag.preview.find((i) => i.id === drag.id)?.cell; return c ? <div className="hb-settle" style={rectStyle(cellToRect(c, metrics))} aria-hidden="true" /> : null })() : null}
          {view.filter((it) => it.id !== NEW_ID).map((it) => {
            const inst = instById.get(it.id)
            if (!inst) return null
            const def = getHomeWidget(inst.type)
            const lifted = drag?.id === it.id && drag.op === 'move'
            const resizing = drag?.id === it.id && drag.op === 'resize'
            const rect = lifted ? drag!.ghost : resizing ? drag!.ghost : cellToRect(it.cell, metrics)
            const size: WidgetSize = def ? sizeModeFor(it.cell.w, it.cell.h, def.sizes) : 'medium'
            return (
              <div key={it.id} role="listitem" className="hb-slot">
                <WidgetFrame inst={inst} def={def} size={size} left={rect.left} top={rect.top} width={rect.width} height={rect.height} cw={it.cell.w} ch={it.cell.h} editing={editing} lifted={lifted || resizing} scrollRoot={scrollEl} actions={actions} capped={capOf(def, inst.id)} />
              </div>
            )
          })}
          {drag && drag.op === 'add' ? <div className="hb-ghost-new" style={rectStyle(drag.ghost)} aria-hidden="true"><Icon name={getHomeWidget(drag.type ?? '')?.icon ?? 'grid'} size={16} /><b>{getHomeWidget(drag.type ?? '')?.name}</b></div> : null}
        </div>
      </div>
      </div>

      {editing && libraryOpen ? <WidgetLibrary defs={defs} metrics={rail.telemetry?.metrics ?? null} counts={counts} onAdd={(t) => { addWidget(t) }} onDragStart={libDragStart} onClose={() => setLibrary(false)} /> : null}
      <div className="lc-sr-only" role="status" aria-live="polite">{drag ? `${drag.op === 'resize' ? 'Resizing' : 'Moving'} to column ${drag.cell.x + 1}, row ${drag.cell.y + 1}` : ''}</div>
    </div>
  )
}

/** Reset the active layout to its preset — always confirmed, always undoable. */
async function confirmReset() {
  const cur = activeLayout()
  if (!cur) return
  const preset = PRESETS[cur.preset ?? 'command']
  const ok = await lcConfirm({
    title: `Reset “${cur.name}”?`,
    effects: [{ text: `Widgets, sizes and positions go back to the ${preset.name} preset.`, kind: 'stops' }, { text: 'Your other saved layouts are not touched.', kind: 'keeps' }],
    confirmLabel: 'Reset layout',
    tone: 'danger',
    nativeText: `Reset ${cur.name} to the ${preset.name} preset?`,
  })
  if (!ok) return
  const prev = cur
  resetActiveLayout()
  lcToast({ title: 'Layout reset', detail: preset.name, severity: 'info', source: 'home', action: { label: 'Undo', onClick: () => restoreLayout(prev) } })
}

const layoutType = (id: string) => activeLayout()?.widgets.find((w) => w.id === id)?.type ?? null
const rectStyle = (r: { left: number; top: number; width: number; height: number }) => ({ transform: `translate3d(${r.left}px, ${r.top}px, 0)`, width: r.width, height: r.height })
const sameCell = (a: Cell, b: Cell) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
const sizeOf = (type: string | null) => { const d = type ? getHomeWidget(type) : null; return SIZE_CELLS[d?.defaultSize ?? 'medium'] }

function autoScroll(root: HTMLElement | null, y: number) {
  if (!root) return
  const r = root.getBoundingClientRect()
  const edge = 56
  if (y > r.bottom - edge) root.scrollTop += Math.ceil((y - (r.bottom - edge)) / 4)
  else if (y < r.top + edge) root.scrollTop -= Math.ceil((r.top + edge - y) / 4)
}

/** The hidden grid, shown only as a faint field of cell corners while editing — never boxes. */
function GridGuides({ cols, rows, m }: { cols: number; rows: number; m: ReturnType<typeof metricsFor> }) {
  return <div className="hb-guides" aria-hidden="true" style={{ ['--hb-col' as string]: `${m.colW + m.gap}px`, ['--hb-row' as string]: `${m.rowH + m.gap}px`, height: rows * (m.rowH + m.gap), width: cols * (m.colW + m.gap) }} />
}

function Snaplines({ lines, m, height }: { lines: { x: number[]; y: number[] }; m: ReturnType<typeof metricsFor>; height: number }) {
  return (
    <div className="hb-snaps" aria-hidden="true">
      {lines.x.map((x) => <i key={`x${x}`} className="is-v" style={{ left: x * (m.colW + m.gap) - m.gap / 2, height }} />)}
      {lines.y.map((y) => <i key={`y${y}`} className="is-h" style={{ top: y * (m.rowH + m.gap) - m.gap / 2 }} />)}
    </div>
  )
}

