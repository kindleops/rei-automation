import { Component, memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ErrorInfo, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { Icon } from '../../../../shared/icons'
import { LCButton, LCIconButton, LCPopover, LCSegmented, LCSelect, LCSwitch } from '../../../../shared/lc'
import { useHomeSource } from './home-sources'
import { homeMetricsSource, SOURCES } from './board-data'
import type { WidgetInstance } from './home-layout-model'
import { cx, openPath, WidgetRuntimeContext } from './widget-runtime'
import { resolveConfig, SIZE_LABEL, type ContextMode, type HomeWidgetDef, type PinnedSubject, type WidgetConfig, type WidgetSize } from './widget-registry'

/**
 * ONE WIDGET ON THE BOARD — the frame every instrument shares.
 *
 * Near-invisible chrome at rest: a minimal title bar whose Open / Open beside
 * appear on hover or focus. In edit mode the bar becomes the handle, and the
 * settings, remove and resize affordances appear. The frame owns visibility
 * (a widget reads data only while on screen), failure isolation (one widget
 * throwing never takes the board down) and keyboard arrangement.
 */

export interface FrameActions {
  moveStart: (id: string, e: ReactPointerEvent) => void
  resizeStart: (id: string, e: ReactPointerEvent) => void
  remove: (id: string) => void
  duplicate: (id: string) => void
  key: (id: string, e: ReactKeyboardEvent) => void
  config: (id: string, patch: Record<string, unknown>) => void
  context: (id: string, mode: ContextMode, subject: PinnedSubject | null) => void
  lock: (id: string, locked: boolean) => void
  refresh: (id: string, ms: number | null) => void
  size: (id: string, size: WidgetSize) => void
}

interface FrameProps {
  inst: WidgetInstance
  def: HomeWidgetDef | null
  size: WidgetSize
  /** pixel geometry as primitives, so an unmoved widget never re-renders during a drag */
  left: number
  top: number
  width: number
  height: number
  cw: number
  ch: number
  editing: boolean
  lifted: boolean
  scrollRoot: HTMLElement | null
  actions: FrameActions
  /** a sibling instance cap was reached (heavyweight widgets) */
  capped: boolean
}

class WidgetBoundary extends Component<{ name: string; children: ReactNode }, { failed: boolean; reset: number }> {
  state = { failed: false, reset: 0 }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('home.widget_failed', this.props.name, error?.message, info.componentStack?.slice(0, 300)) }
  render() {
    if (this.state.failed) {
      return (
        <div className="hb-err-box" role="alert">
          <Icon name="alert-circle" size={14} />
          <span>Couldn’t load {this.props.name}</span>
          <button type="button" className="hb-link" onClick={() => this.setState((s) => ({ failed: false, reset: s.reset + 1 }))}>Retry</button>
        </div>
      )
    }
    return <div key={this.state.reset} className="hb-w__content-inner">{this.props.children}</div>
  }
}

/**
 * Is this widget on screen (with a 240px lead)? Geometry decides, not only an
 * IntersectionObserver: the first answer is measured on the next frame after
 * mount, then re-measured on scroll / resize of the board and on any observer
 * notification. A widget therefore mounts and fetches on first paint even
 * when an observer never delivers an intersecting entry (RC 8.3 regression:
 * the body stayed an empty placeholder and nothing fetched).
 */
function useInView(ref: React.RefObject<HTMLElement | null>, root: HTMLElement | null) {
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const LEAD = 240
    const check = () => {
      const r = el.getBoundingClientRect()
      const b = root ? root.getBoundingClientRect() : { top: 0, left: 0, bottom: window.innerHeight, right: window.innerWidth }
      setInView(r.width > 0 && r.height > 0 && r.bottom >= b.top - LEAD && r.top <= b.bottom + LEAD && r.right >= b.left && r.left <= b.right)
    }
    let raf = 0
    const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; check() }) }
    schedule()
    const scroller: HTMLElement | Window = root ?? window
    scroller.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    const io = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(schedule, { root, rootMargin: `${LEAD}px 0px` }) : null
    io?.observe(el)
    const ro = typeof ResizeObserver !== 'undefined' && root ? new ResizeObserver(schedule) : null
    ro?.observe(root!)
    return () => {
      cancelAnimationFrame(raf)
      scroller.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      io?.disconnect()
      ro?.disconnect()
    }
  }, [ref, root])
  return inView
}

const REFRESH_OPTIONS = [
  { value: 'auto', label: 'Automatic', hint: 'The widget’s own cadence, plus live events' },
  { value: '60000', label: 'Every minute' },
  { value: '300000', label: 'Every 5 minutes' },
  { value: '900000', label: 'Every 15 minutes' },
]

function SubjectPicker({ subject, onPick }: { subject: PinnedSubject | null; onPick: (s: PinnedSubject) => void }) {
  const { load } = useHomeSource(SOURCES.campaigns.key, SOURCES.campaigns.load, { everyMs: SOURCES.campaigns.everyMs, active: true, apps: SOURCES.campaigns.apps })
  const options = load.status === 'ready' ? load.data.list.filter((c) => !['archived'].includes(c.status)).slice(0, 200).map((c) => ({ value: c.id, label: c.campaign_name || 'Untitled campaign', hint: [c.status.replace(/_/g, ' '), c.market_label].filter(Boolean).join(' · ') })) : []
  return (
    <LCSelect
      label="Campaign"
      value={subject?.id ?? null}
      placeholder={load.status === 'loading' ? 'Loading campaigns…' : 'Choose a campaign'}
      options={options}
      disabled={!options.length}
      onChange={(id) => { const o = options.find((x) => x.value === id); if (o) onPick({ kind: 'campaign', id, label: o.label }) }}
    />
  )
}

function MarketOptions({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const src = homeMetricsSource('30d', null, true)
  const { load } = useHomeSource(src.key, src.load, { everyMs: src.everyMs, active: true })
  const markets = load.status === 'ready' ? [...(load.data.markets ?? [])].sort((a, b) => a.name.localeCompare(b.name)) : []
  const options = [{ value: '', label: 'All markets' }, ...markets.map((m) => ({ value: m.id, label: m.name, hint: m.state ?? undefined }))]
  return <LCSelect label="Market" value={value} options={options} onChange={onChange} disabled={load.status !== 'ready'} placeholder={load.status === 'loading' ? 'Loading markets…' : 'All markets'} />
}

function WidgetSettings({ inst, def, config, actions }: { inst: WidgetInstance; def: HomeWidgetDef; config: WidgetConfig; actions: FrameActions }) {
  const contexts = def.contexts ?? ['global']
  return (
    <div className="hb-settings">
      <header className="hb-settings__head"><Icon name={def.icon} size={14} /><b>{def.name}</b></header>
      {def.sizes.length > 1 ? (
        <label className="hb-settings__field"><span>Size</span>
          <LCSegmented size="sm" label="Size" value={inst.size} options={def.sizes.map((s) => ({ value: s, label: SIZE_LABEL[s] }))} onChange={(s) => actions.size(inst.id, s as WidgetSize)} />
        </label>
      ) : null}
      {(def.configSchema ?? []).map((f) => (
        <label key={f.key} className="hb-settings__field"><span>{f.label}</span>
          {f.kind === 'segmented' ? <LCSegmented size="sm" label={f.label} value={String(config[f.key] ?? '')} options={f.options} onChange={(v) => actions.config(inst.id, { [f.key]: v })} /> : null}
          {f.kind === 'select' && f.source === 'markets' ? <MarketOptions value={String(config[f.key] ?? '')} onChange={(v) => actions.config(inst.id, { [f.key]: v || null })} /> : null}
          {f.kind === 'select' && !f.source ? <LCSelect label={f.label} value={String(config[f.key] ?? '')} options={f.options} onChange={(v) => actions.config(inst.id, { [f.key]: v })} /> : null}
          {f.kind === 'switch' ? <LCSwitch checked={Boolean(config[f.key])} onCheckedChange={(v) => actions.config(inst.id, { [f.key]: v })} hint={f.hint} /> : null}
        </label>
      ))}
      {contexts.length > 1 ? (
        <div className="hb-settings__field"><span>Context</span>
          <LCSegmented size="sm" label="Context" value={inst.context.mode}
            options={contexts.map((c) => ({ value: c, label: c === 'global' ? 'Global' : c === 'pinned' ? 'Pinned' : 'Linked' }))}
            onChange={(m) => actions.context(inst.id, m as ContextMode, m === 'pinned' ? inst.context.subject : null)} />
          {inst.context.mode === 'pinned' ? <SubjectPicker subject={inst.context.subject} onPick={(s) => actions.context(inst.id, 'pinned', s)} /> : null}
          <small className="hb-muted">{inst.context.mode === 'global' ? 'The whole operation.' : inst.context.mode === 'pinned' ? 'Keeps this subject until you change it.' : 'Follows the campaign open in Campaign Command.'}</small>
        </div>
      ) : null}
      <label className="hb-settings__field"><span>Refresh</span>
        <LCSelect label="Refresh" value={inst.refreshMs ? String(inst.refreshMs) : 'auto'} options={REFRESH_OPTIONS} onChange={(v) => actions.refresh(inst.id, v === 'auto' ? null : Number(v))} />
      </label>
      <LCSwitch checked={inst.locked} onCheckedChange={(v) => actions.lock(inst.id, v)} label="Lock position" hint="Others flow around it" size="sm" />
      <p className="hb-settings__data"><Icon name="database" size={11} /> {def.data}</p>
      <footer className="hb-settings__foot">
        <LCButton size="sm" variant="quiet" onClick={() => actions.duplicate(inst.id)}>Duplicate</LCButton>
        <LCButton size="sm" variant="quiet" onClick={() => actions.remove(inst.id)}>Remove</LCButton>
      </footer>
    </div>
  )
}

/** The instrument itself — memoised apart from the frame, so a lifted widget following the pointer does not re-render its content. */
const WidgetBody = memo(function WidgetBody({ Comp, inst, size, config, active, cw, ch, editing, actions }: { Comp: HomeWidgetDef['component']; inst: WidgetInstance; size: WidgetSize; config: WidgetConfig; active: boolean; cw: number; ch: number; editing: boolean; actions: FrameActions }) {
  const context = useMemo(() => ({ mode: inst.context.mode, subject: inst.context.mode === 'pinned' ? inst.context.subject : null }), [inst.context])
  const cells = useMemo(() => ({ w: cw, h: ch }), [cw, ch])
  const id = inst.id
  const setConfig = useCallback((patch: Partial<WidgetConfig>) => actions.config(id, patch), [actions, id])
  return <Comp instanceId={id} size={size} config={config} context={context} active={active} cells={cells} editing={editing} setConfig={setConfig} />
})

export const WidgetFrame = memo(function WidgetFrame({ inst, def, size, left, top, width, height, cw, ch, editing, lifted, scrollRoot, actions, capped }: FrameProps) {
  const ref = useRef<HTMLElement | null>(null)
  const inView = useInView(ref, scrollRoot)
  // lazy: a widget mounts the first time it comes into view, then stays mounted (and idle) offscreen
  const [seen, setSeen] = useState(false)
  if (inView && !seen) setSeen(true)
  const config = useMemo(() => (def ? resolveConfig(def, inst.config, inst.configVersion) : {}), [def, inst.config, inst.configVersion])
  const runtime = useMemo(() => ({ active: inView && !capped, refreshMs: inst.refreshMs }), [inView, capped, inst.refreshMs])
  const subject = inst.context.mode === 'pinned' ? inst.context.subject : null
  const open = def?.openAction({ config, subject }) ?? null
  const beside = def?.openBesideAction?.({ config, subject }) ?? null
  const [settingsOpen, setSettingsOpen] = useState(false)
  const title = def ? (subject ? `${def.name} · ${subject.label}` : def.name) : 'Unavailable widget'
  const style: CSSProperties = { transform: `translate3d(${left}px, ${top}px, 0)`, width, height }

  const Comp = def?.component
  return (
    <section
      ref={ref}
      className={cx('hb-w', `is-${size}`, editing && 'is-editing', lifted && 'is-lifted', inst.locked && 'is-locked', !def && 'is-missing')}
      style={style}
      aria-label={`${title}${editing ? ` — ${cw} by ${ch}. Arrows move, Shift+arrows resize, Delete removes.` : ''}`}
      tabIndex={editing ? 0 : -1}
      data-widget={inst.id}
      onKeyDown={editing ? (e) => actions.key(inst.id, e) : undefined}
    >
      <header className="hb-w__bar" onPointerDown={editing ? (e) => { if (!(e.target as HTMLElement).closest('button')) actions.moveStart(inst.id, e) } : undefined}>
        {editing ? <Icon name="drag" size={13} className="hb-w__grip" /> : null}
        <Icon name={def?.icon ?? 'alert-circle'} size={13} className="hb-w__icon" />
        <h3 className="hb-w__title">{title}</h3>
        {inst.context.mode === 'linked' ? <span className="hb-w__ctx" title="Follows the workspace">Linked</span> : null}
        {inst.locked && editing ? <Icon name="pin" size={12} className="hb-w__lock" /> : null}
        <span className="hb-w__tools">
          {!editing && open ? <LCIconButton size="sm" icon="arrow-up-right" label={open.label} onClick={() => openPath(open.path)} /> : null}
          {!editing && beside ? <LCIconButton size="sm" icon="layout-split" label={beside.label} onClick={() => openPath(beside.path, true)} /> : null}
          {editing && def ? (
            <LCPopover open={settingsOpen} onOpenChange={setSettingsOpen} material="solid" width={344} align="end" label={`${def.name} settings`}
              trigger={<LCIconButton size="sm" icon="settings" label={`${def.name} settings`} />}>
              <WidgetSettings inst={inst} def={def} config={config} actions={actions} />
            </LCPopover>
          ) : null}
          {editing ? <LCIconButton size="sm" icon="x" label={`Remove ${def?.name ?? 'widget'}`} onClick={() => actions.remove(inst.id)} /> : null}
        </span>
      </header>
      <div className="hb-w__content">
        {Comp ? (
          capped ? <p className="hb-empty"><Icon name="map" size={13} />Paused — this board already runs the maximum live {def!.name} widgets.</p> : (
            <WidgetRuntimeContext.Provider value={runtime}>
              <WidgetBoundary name={def!.name}>
                {seen || lifted ? <WidgetBody Comp={Comp} inst={inst} size={size} config={config} active={runtime.active} cw={cw} ch={ch} editing={editing} actions={actions} /> : <div className="hb-offscreen" aria-hidden="true" />}
              </WidgetBoundary>
            </WidgetRuntimeContext.Provider>
          )
        ) : (
          <div className="hb-missing">
            <p>This widget ({inst.type}) is no longer available.</p>
            <LCButton size="sm" variant="quiet" onClick={() => actions.remove(inst.id)}>Remove</LCButton>
          </div>
        )}
      </div>
      {editing ? <span className="hb-w__resize" role="presentation" onPointerDown={(e) => actions.resizeStart(inst.id, e)} title="Resize" /> : null}
    </section>
  )
})
