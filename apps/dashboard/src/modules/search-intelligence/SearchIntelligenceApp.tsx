import { useCallback, useContext, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { replaceRoutePath, useRouteLocation } from '../../app/router'
import { Icon } from '../../shared/icons'
import { LCEmpty, LCError, LCKbd, LCPaneLoading, LCSearch, LCTooltip, cx } from '../../shared/lc'
import { useClaimedKeys } from '../../shared/lc/keys'
import { useBreakpoint } from '../mobile/useBreakpoint'
import { intelligenceMode } from './domain/lifecycle'
import { searchObjects } from './domain/search'
import type { ObjectRef } from './domain/types'
import { InspectorHost } from './ui/Inspector'
import { BrandMark } from './ui/parts'
import { SiContext, refLabel, type SiActions, type SiCtx } from './ui/si-context'
import { parseState, serializeState, VIEWS, type SiState, type ViewId } from './ui/state'
import { useSearchIntelligence, type SiData } from './ui/useSearchIntelligence'
import { AnalyticsView, ArchitectureView, ConnectionsView, ConversionsView, GlobeView, HomeView, KeywordsView, LaunchView, OpportunitiesView, PagesView } from './ui/views'
import { GeographyView } from './ui/GeographyView'
import './ui/search-intelligence.css'

/**
 * SEARCH INTELLIGENCE OS — a cross-brand search workspace.
 *
 * Desktop instrument (the phone gets an honest note). It owns its own state
 * in its pane path, reads only the planning snapshots and provider facts
 * (none yet), and couples to no LeadCommand runtime table.
 */
export default function SearchIntelligenceApp() {
  const { isPhone } = useBreakpoint()
  if (isPhone) {
    return (
      <div className="si si--phone">
        <LCEmpty icon="globe" title="Search Intelligence is a desktop workspace" body="Open LeadCommand on a desktop or an ultrawide display to plan and operate search." />
      </div>
    )
  }
  return <SearchIntelligenceDesktop />
}

function SearchIntelligenceDesktop() {
  const load = useSearchIntelligence()
  if (load.state === 'loading') return <div className="si si--loading"><LCPaneLoading label="Loading the search plan" /></div>
  if (load.state === 'error') return <div className="si si--loading"><LCError what="The planning snapshots could not load" detail={load.message} /></div>
  return <Workspace data={load.data} />
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '/', '[', ']']

function Workspace({ data }: { data: SiData }) {
  const location = useRouteLocation()
  const base = location.split('?')[0] || '/search-intelligence'
  const known = useMemo(() => new Set(data.model.dataset.properties.map((p) => p.id)), [data])
  const state = parseState(location, known)
  const [stack, setStack] = useState<ObjectRef[]>(() => (state.object ? [state.object] : []))
  const [focused, setFocused] = useState(false)
  useClaimedKeys(KEYS, focused)

  const write = useCallback((next: SiState) => replaceRoutePath(serializeState(base, next)), [base])
  const actions: SiActions = useMemo(() => ({
    setView: (v: ViewId) => write({ ...state, view: v }),
    setProperty: (id: string | null) => write({ ...state, property: id, object: id && state.object?.kind === 'property' ? null : state.object }),
    inspect: (ref: ObjectRef | null) => {
      setStack((s) => (ref ? [...s.filter((x) => !(x.kind === ref.kind && x.id === ref.id)), ref].slice(-12) : []))
      write({ ...state, object: ref })
    },
    setPagesView: (v: string) => write({ ...state, pagesView: v }),
  }), [state, write])
  const back = useCallback(() => {
    const next = stack.slice(0, -1)
    setStack(next)
    write({ ...state, object: next[next.length - 1] ?? null })
  }, [stack, state, write])
  const ctx: SiCtx = useMemo(() => ({ data, state, actions }), [data, state, actions])

  const searchRef = useRef<HTMLInputElement>(null)
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement
    const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable
    if (e.key === 'Escape' && state.object && !typing) { e.preventDefault(); actions.inspect(null); return }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return
    if (t.tagName === 'CANVAS' && ['0', '+', '-', '=', '_'].includes(e.key)) return // the graph owns its zoom keys
    const v = VIEWS.find((x) => x.key === e.key)
    if (v) { e.preventDefault(); actions.setView(v.id); return }
    if (e.key === '/') { e.preventDefault(); searchRef.current?.focus(); return }
    if (e.key === '[' || e.key === ']') {
      e.preventDefault()
      const ids = [null, ...data.model.dataset.properties.map((p) => p.id)]
      const i = ids.indexOf(state.property)
      actions.setProperty(ids[(i + (e.key === ']' ? 1 : ids.length - 1)) % ids.length])
    }
  }

  const scopeProps = state.property ? [data.model.property.get(state.property)!] : data.model.dataset.properties
  const mode = scopeProps.some((p) => intelligenceMode(p) === 'LIVE_INTELLIGENCE') ? 'LIVE INTELLIGENCE' : 'PLANNING'
  return (
    <SiContext.Provider value={ctx}>
      <div
        className={cx('si', state.object && 'has-inspector')}
        data-view={state.view}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false) }}
      >
        <div className="si__env" aria-hidden="true" />
        <nav className="si-rail" aria-label="Search Intelligence">
          <div className="si-rail__brand"><Icon name="globe" size={16} /><span>Search<br />Intelligence</span></div>
          {VIEWS.map((v) => (
            <LCTooltip key={v.id} content={v.label} side="right" shortcut={v.key ? [v.key] : undefined}>
              <button type="button" className={cx('si-rail__item', state.view === v.id && 'is-on')} aria-current={state.view === v.id ? 'page' : undefined} onClick={() => actions.setView(v.id)}>
                <Icon name={v.icon} size={16} />
                <span>{v.label}</span>
              </button>
            </LCTooltip>
          ))}
        </nav>
        <header className="si-top">
          <div className="si-top__title">
            <h1>{VIEWS.find((v) => v.id === state.view)?.label}</h1>
            <span className="si-modebadge" data-mode={mode === 'PLANNING' ? 'planning' : 'live'}>{mode}</span>
          </div>
          <div className="si-switch" role="tablist" aria-label="Property">
            <button type="button" role="tab" aria-selected={!state.property} className={cx('si-switch__b', !state.property && 'is-on')} onClick={() => actions.setProperty(null)}>Portfolio</button>
            {data.model.dataset.properties.map((p) => (
              <button key={p.id} type="button" role="tab" aria-selected={state.property === p.id} className={cx('si-switch__b', state.property === p.id && 'is-on')} onClick={() => actions.setProperty(p.id)} title={`${p.domain} · ${p.lifecycle.replace(/_/g, ' ').toLowerCase()}`}>
                <BrandMark property={p} size={6} />{p.brand}
              </button>
            ))}
          </div>
          <CommandSearch inputRef={searchRef} />
          <span className="si-top__fresh" title="Plans are snapshots of each property's own registry; no provider has reported data.">
            Plan snapshot {data.model.dataset.properties.find((p) => p.sources[0]?.capturedAt)?.sources[0]?.capturedAt ?? '—'} · no provider data
          </span>
        </header>
        <main className="si-main" aria-label={VIEWS.find((v) => v.id === state.view)?.label}>
          <ViewBody view={state.view} />
        </main>
        {state.object ? <aside className="si-insp"><InspectorHost stack={stack} onBack={back} /></aside> : null}
      </div>
    </SiContext.Provider>
  )
}

function ViewBody({ view }: { view: ViewId }) {
  switch (view) {
    case 'home': return <HomeView />
    case 'globe': return <GlobeView />
    case 'architecture': return <ArchitectureView />
    case 'pages': return <PagesView />
    case 'keywords': return <KeywordsView />
    case 'geography': return <GeographyView />
    case 'opportunities': return <OpportunitiesView />
    case 'launch': return <LaunchView />
    case 'analytics': return <AnalyticsView />
    case 'conversions': return <ConversionsView />
    case 'connections': return <ConnectionsView />
  }
}

const KIND_ICON = { property: 'globe', page: 'file-text', cluster: 'hash', keyword: 'search', geography: 'map', wave: 'flag', opportunity: 'target' } as const

function CommandSearch({ inputRef }: { inputRef: RefObject<HTMLInputElement> }) {
  const ctx = useContextSafe()
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const hits = useMemo(() => (ctx ? searchObjects(ctx.data.index, q, null, 14) : []), [ctx, q])
  if (!ctx) return null
  const open = (i: number) => {
    const h = hits[i]
    if (!h) return
    if (h.ref.kind === 'property') ctx.actions.setProperty(h.ref.id)
    else ctx.actions.inspect(h.ref)
    setQ('')
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!hits.length) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(hits.length - 1, a + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); open(active) }
    else if (e.key === 'Escape') { e.stopPropagation(); setQ('') }
  }
  return (
    <div className="si-cmd" onKeyDown={onKey}>
      <LCSearch ref={inputRef} value={q} onChange={(v) => { setQ(v); setActive(0) }} label="Search pages, clusters, keywords, places, waves" placeholder="Search the plan" hint="/" role="combobox" aria-expanded={hits.length > 0} aria-controls="si-cmd-list" />
      {hits.length ? (
        <ul id="si-cmd-list" className="si-cmd__list" role="listbox" aria-label="Results">
          {hits.map((h, i) => {
            const prop = h.propertyId ? ctx.data.model.property.get(h.propertyId) : null
            return (
              <li key={`${h.ref.kind}:${h.ref.id}`} role="option" aria-selected={i === active}>
                <button type="button" className={cx('si-cmd__item', i === active && 'is-active')} onMouseEnter={() => setActive(i)} onClick={() => open(i)}>
                  <Icon name={KIND_ICON[h.ref.kind]} size={13} />
                  <span className="si-cmd__l">{h.label}</span>
                  <span className="si-cmd__d">{h.detail}</span>
                  {prop ? <span className="si-cmd__p"><BrandMark property={prop} size={5} />{prop.brand}</span> : null}
                </button>
              </li>
            )
          })}
          <li className="si-cmd__foot"><LCKbd keys={['↑', '↓']} /> move <LCKbd keys={['↵']} /> inspect <LCKbd keys={['esc']} /> clear · {refHint(ctx)}</li>
        </ul>
      ) : null}
    </div>
  )
}

function refHint(ctx: SiCtx): string {
  return ctx.state.object ? `inspecting ${refLabel(ctx, ctx.state.object)}` : 'searches every property'
}

/** CommandSearch renders inside the provider. */
function useContextSafe(): SiCtx | null { return useContext(SiContext) }
