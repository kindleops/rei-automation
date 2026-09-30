/**
 * ENTITY GRAPH — the relationship brain, on a phone.
 *
 * Graph-first: one ownership network at a time (a property, an owner or a
 * person), drawn as a constellation with the controlling party at its heart,
 * and an intelligence sheet beneath it. Search or the largest networks start
 * it; related owners hop you to the next network; Back retraces the path.
 * Selection is a work surface: pick properties (or a whole portfolio) and hand
 * them to a campaign DRAFT or the Map. List mode keeps every record browsable
 * with the full filter builder.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../../shared/icons'
import { MobileBottomSheet, type BottomSheetSnap } from '../../mobile/MobileBottomSheet'
import { fetchEntityGraphList } from '../../../domain/entity-graph/entity-graph-api'
import { EMPTY_ENTITY_GRAPH_FILTERS, type EntityGraphAction, type EntitySearchResult, type UniversalEntityContext } from '../../../domain/entity-graph/entity-graph.types'
import { EMPTY_UNIVERSAL_ENTITY_CONTEXT } from '../../../domain/entity-graph/universal-entity-context'
import { openInboxThread } from '../../mobile/mobile-inbox-bridge'
import { EntityGraphMobile } from '../mobile/EntityGraphMobile'
import { EntityGraphCampaignSheet } from '../mobile/EntityGraphCampaignSheet'
import { BuyerInspectorSheet, type BuyerMapPoint } from '../buyer/BuyerInspector'
import { writeMapFocusSet } from '../../../domain/map/map-focus-set'
import { fetchEntityNetwork, fetchTopNetworks, money, type EntityNetwork, type TopNetwork } from './entity-network-api'
import { EntityNetworkStage, NODE_ICON } from './EntityNetworkStage'
import { EntityNetworkInspector, type InspectorActions } from './EntityNetworkInspector'
import { visibleNetwork } from './network-layout'
import { LandingFx } from './LandingFx'
import { CountUp } from '../../../shared/motion/CountUp'
import './entity-graph-console.css'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

type Anchor = { type: 'property' | 'owner' | 'person'; id: string }
type Props = {
  themeMode?: string
  universalContext: UniversalEntityContext
  onUniversalContextChange: (next: UniversalEntityContext) => void
  onAction?: (action: EntityGraphAction, context: UniversalEntityContext) => void
}

const LAYERS: Array<{ type: string; label: string }> = [
  { type: 'property', label: 'Properties' },
  { type: 'entity', label: 'Title' },
  { type: 'person', label: 'People' },
  { type: 'phone', label: 'Contacts' },
  { type: 'mailing', label: 'Mailing' },
  { type: 'related_owner', label: 'Related' },
  { type: 'conversation', label: 'Talks' },
  { type: 'sale', label: 'History' },
  { type: 'mortgage', label: 'Debt' },
  { type: 'lien', label: 'Liens' },
]

const SHEET_HEIGHTS: Record<BottomSheetSnap, string> = { collapsed: '34dvh', half: '58dvh', expanded: 'calc(100dvh - 96px)' }

function anchorFromContext(ctx: UniversalEntityContext): Anchor | null {
  if (ctx.propertyId) return { type: 'property', id: String(ctx.propertyId) }
  if (ctx.masterOwnerId) return { type: 'owner', id: String(ctx.masterOwnerId) }
  if (ctx.prospectId) return { type: 'person', id: String(ctx.prospectId) }
  return null
}

function anchorFromResult(r: EntitySearchResult): Anchor | null {
  const t = r.entityType
  if (t === 'property') return { type: 'property', id: r.entityId }
  if (t === 'master_owner' || t === 'owner') return { type: 'owner', id: r.entityId }
  if (t === 'prospect' || t === 'person') return { type: 'person', id: r.entityId }
  const ids = r.contextIds
  if (ids?.masterOwnerId) return { type: 'owner', id: ids.masterOwnerId }
  if (ids?.propertyId) return { type: 'property', id: ids.propertyId }
  return null
}

export function EntityGraphConsole(props: Props) {
  const { universalContext, onUniversalContextChange, onAction } = props
  // The universe (list) is home; the network opens for a record, or on arrival
  // from another app with a subject.
  const [mode, setMode] = useState<'graph' | 'list'>(() => (anchorFromContext(universalContext) ? 'graph' : 'list'))
  // `?buyer=<public buyer_id>` opens that buyer (Comps "View buyer" and other deep links).
  const [buyerId, setBuyerId] = useState<string | null>(() => {
    try { return new URLSearchParams(window.location.search).get('buyer') || null } catch { return null }
  })
  // `&section=owned` (Buyer Match "View portfolio") opens that part of the deep-linked buyer.
  const [buyerSection, setBuyerSection] = useState<string | null>(() => {
    try { return new URLSearchParams(window.location.search).get('section') || null } catch { return null }
  })
  const [anchor, setAnchor] = useState<Anchor | null>(() => anchorFromContext(universalContext))
  const [trail, setTrail] = useState<Array<{ anchor: Anchor; name: string }>>([])
  const [network, setNetwork] = useState<EntityNetwork | null>(null)
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle')
  const [focusId, setFocusId] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [selectMode, setSelectMode] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [hidden, setHidden] = useState<Set<string>>(() => new Set())
  const [snap, setSnap] = useState<BottomSheetSnap>('collapsed')
  const [campaignFor, setCampaignFor] = useState<string[] | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const reducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

  // Cross-app arrival (Map, Inbox, a deep link) re-anchors the console.
  const ctxAnchor = anchorFromContext(universalContext)
  const ctxKey = ctxAnchor ? `${ctxAnchor.type}:${ctxAnchor.id}` : ''
  const lastCtxKey = useRef(ctxKey)
  useEffect(() => {
    if (ctxKey === lastCtxKey.current) return
    lastCtxKey.current = ctxKey
    // In the universe the list owns context changes (opening a row publishes
    // it); only a real arrival while the network is showing re-anchors it.
    if (mode === 'list') return
    if (ctxAnchor) { setAnchor(ctxAnchor); setMode('graph') }
  }, [ctxKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Load the network for the anchor.
  useEffect(() => {
    if (!anchor) { setNetwork(null); return }
    const ctrl = new AbortController()
    setState('loading')
    setFocusId(null)
    setExpanded(false)
    setSnap('collapsed')
    fetchEntityNetwork(anchor.type, anchor.id, ctrl.signal)
      .then((n) => {
        if (ctrl.signal.aborted) return
        if (!n) { setState('error'); return }
        setNetwork(n)
        setState('idle')
        // A property arrival focuses that property; an owner arrival shows the network.
        if (anchor.type === 'property') setFocusId(`property:${anchor.id}`)
        if (anchor.type === 'person') setFocusId(`person:${anchor.id}`)
      })
      .catch(() => { if (!ctrl.signal.aborted) setState('error') })
    return () => ctrl.abort()
  }, [anchor])

  // Keep the URL / cross-app context on the network being explored.
  const publish = useCallback((a: Anchor) => {
    const next: UniversalEntityContext = {
      ...EMPTY_UNIVERSAL_ENTITY_CONTEXT,
      entityType: a.type === 'owner' ? 'master_owner' : a.type === 'person' ? 'prospect' : 'property',
      entityId: a.id,
      propertyId: a.type === 'property' ? a.id : null,
      masterOwnerId: a.type === 'owner' ? a.id : null,
      prospectId: a.type === 'person' ? a.id : null,
    }
    lastCtxKey.current = `${a.type}:${a.id}`
    onUniversalContextChange(next)
  }, [onUniversalContextChange])

  const go = useCallback((next: Anchor, pushTrail = true) => {
    if (pushTrail && anchor && network) setTrail((t) => [...t, { anchor, name: network.owner.name }].slice(-12))
    setAnchor(next)
    setMode('graph')
    publish(next)
  }, [anchor, network, publish])

  const back = () => {
    const prev = trail[trail.length - 1]
    // Out of the first network: back to the universe it was opened from.
    if (!prev) {
      setAnchor(null); setNetwork(null); setMode('list')
      // Leaving the network is not a request to open that record in the list.
      lastCtxKey.current = ''
      onUniversalContextChange({ ...EMPTY_UNIVERSAL_ENTITY_CONTEXT })
      return
    }
    setTrail((t) => t.slice(0, -1))
    setAnchor(prev.anchor)
    publish(prev.anchor)
  }

  const vis = useMemo(() => (network ? visibleNetwork(network.graph.nodes, network.graph.edges, { expanded, anchorId: network.anchor.nodeId, hiddenTypes: hidden }) : null), [network, expanded, hidden])
  const focusNode = useMemo(() => network?.graph.nodes.find((n) => n.id === focusId) ?? null, [network, focusId])

  // Selection: property nodes carry ids; selecting the owner selects the portfolio.
  const toggleSelect = useCallback((ids: string[], on?: boolean) => {
    if (!network) return
    const expandIds = ids.flatMap((id) => {
      if (id.startsWith('owner:') || id.startsWith('entity:')) return network.properties.map((p) => `property:${p.id}`)
      return id.startsWith('property:') ? [id] : []
    })
    if (!expandIds.length) return
    setSelected((cur) => {
      const next = new Set(cur)
      const turnOn = on ?? !expandIds.every((id) => next.has(id))
      for (const id of expandIds) { if (turnOn) next.add(id); else next.delete(id) }
      return next
    })
  }, [network])

  const selectedProps = useMemo(() => (network ? network.properties.filter((p) => selected.has(`property:${p.id}`)) : []), [network, selected])
  const selectedValue = selectedProps.reduce((s, p) => s + (p.value ?? 0), 0)

  const campaignSelection = useMemo<EntitySearchResult[]>(() => {
    if (!campaignFor || !network) return []
    return campaignFor.map((id) => {
      const p = network.properties.find((x) => x.id === id)
      return { entityType: 'property', entityId: id, title: p?.address ?? id, subtitle: [p?.city, p?.state].filter(Boolean).join(', '), badges: [], linkedCounts: {}, contextIds: { propertyId: id, masterOwnerId: p?.ownerId ?? undefined } } as EntitySearchResult
    })
  }, [campaignFor, network])

  const actions: InspectorActions = {
    openNetwork: (type, id) => go({ type, id }),
    focus: (nodeId) => { if (nodeId) { setFocusId(nodeId); setSnap((s) => (s === 'collapsed' ? 'half' : s)) } },
    toggleSelect,
    showOnMap: (propertyId) => onAction?.('show_on_map', { ...EMPTY_UNIVERSAL_ENTITY_CONTEXT, entityType: 'property', entityId: propertyId, propertyId }),
    openConversation: (threadKey) => openInboxThread({ threadKey }),
    addToCampaign: (ids) => setCampaignFor(ids),
    openBuyer: (id) => { setBuyerSection(null); setBuyerId(id) },
  }

  // ── Cross-surface handoffs ────────────────────────────────────────────────
  const showSetOnMap = useCallback((label: string, tone: 'property' | 'buyer' | 'portfolio', points: Array<{ propertyId?: string; lat?: number | null; lng?: number | null; address?: string | null }>) => {
    const usable = points.filter((p) => Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)))
    const first = points.find((p) => p.propertyId)
    if (usable.length) {
      writeMapFocusSet({ label, tone, points: usable.map((p) => ({ lat: Number(p.lat), lng: Number(p.lng), id: p.propertyId, label: p.address ?? null })) })
    }
    if (first?.propertyId) {
      onAction?.('open_in_map', { ...EMPTY_UNIVERSAL_ENTITY_CONTEXT, entityType: 'property', entityId: first.propertyId, propertyId: first.propertyId })
    } else if (!usable.length) {
      setToast('None of these have map coordinates.')
      window.setTimeout(() => setToast(null), 3000)
    }
  }, [onAction])

  const openNetworkFor = useCallback((r: EntitySearchResult) => {
    const a = anchorFromResult(r)
    if (!a) return
    setTrail([])
    go(a, false)
  }, [go])

  const buyerSheet = (
    <BuyerInspectorSheet
      buyerId={buyerId}
      open={Boolean(buyerId)}
      focusSection={buyerSection}
      onClose={() => { setBuyerId(null); setBuyerSection(null) }}
      onOpenProperty={(propertyId) => { setBuyerId(null); setBuyerSection(null); setTrail([]); go({ type: 'property', id: propertyId }, false) }}
      onOpenBuyer={(id) => { setBuyerSection(null); setBuyerId(id) }}
      onShowOnMap={(points: BuyerMapPoint[]) => { setBuyerId(null); setBuyerSection(null); showSetOnMap('from this buyer', 'buyer', points) }}
      onOpenBuyerMatch={(propertyId) => onAction?.('open_buyer_match', { ...EMPTY_UNIVERSAL_ENTITY_CONTEXT, entityType: propertyId ? 'property' : null, entityId: propertyId ?? null, propertyId: propertyId ?? null })}
    />
  )

  // ── Landing: search + the largest ownership networks ─────────────────────
  const [q, setQ] = useState('')
  const [results, setResults] = useState<EntitySearchResult[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [top, setTop] = useState<TopNetwork[] | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  useEffect(() => {
    if (top || (anchor && !searchOpen)) return
    const ctrl = new AbortController()
    void fetchTopNetworks('', ctrl.signal).then((rows) => { if (!ctrl.signal.aborted) setTop(rows) })
    return () => ctrl.abort()
  }, [anchor, searchOpen, top])
  useEffect(() => {
    const term = q.trim()
    if (term.length < 2) { setResults(null); return }
    const ctrl = new AbortController()
    const t = window.setTimeout(() => {
      setSearching(true)
      fetchEntityGraphList({ tab: 'all', q: term, page_size: 12 }, ctrl.signal)
        .then((r) => { if (!ctrl.signal.aborted) setResults(r.results) })
        .catch(() => { if (!ctrl.signal.aborted) setResults([]) })
        .finally(() => { if (!ctrl.signal.aborted) setSearching(false) })
    }, 260)
    return () => { window.clearTimeout(t); ctrl.abort() }
  }, [q])

  const pick = (r: EntitySearchResult) => {
    const a = anchorFromResult(r)
    if (!a) return
    setSearchOpen(false)
    setQ('')
    setTrail([])
    go(a, false)
  }

  if (mode === 'list') {
    return (
      <div className="egx-listmode">
        <EntityGraphMobile
          {...props}
          onOpenNetwork={openNetworkFor}
          onOpenBuyer={(id) => { setBuyerSection(null); setBuyerId(id) }}
          onShowOnMap={(points) => showSetOnMap(`propert${points.length === 1 ? 'y' : 'ies'} from Entity Graph`, 'property', points)}
        />
        {buyerSheet}
      </div>
    )
  }

  const searchPanel = (
    <div className="egx-search">
      <label className="egx-search__field">
        <Icon name="search" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Owner, LLC, trust, address, person, phone…"
          autoFocus={searchOpen}
          inputMode="search"
          enterKeyHint="search"
          aria-label="Search the relationship graph"
        />
        {q && <button type="button" className="egx-search__clear" onClick={() => setQ('')} aria-label="Clear search"><Icon name="close" /></button>}
      </label>
      {results && (
        <div className="egx-results" role="listbox">
          {searching && <p className="egx-empty">Searching…</p>}
          {!searching && results.length === 0 && <p className="egx-empty">Nothing matches “{q}”.</p>}
          {results.map((r) => {
            const type = r.entityType === 'master_owner' ? 'owner' : r.entityType === 'prospect' ? 'person' : r.entityType
            const can = Boolean(anchorFromResult(r))
            return (
              <button key={`${r.entityType}:${r.entityId}`} type="button" className="egx-result" disabled={!can} onClick={() => pick(r)}>
                <span className={cls('egx-result__icon', `is-${type}`)}><Icon name={NODE_ICON[type] ?? 'grid'} /></span>
                <span><strong>{r.title}</strong><em>{r.subtitle || type.replace('_', ' ')}</em></span>
                {r.linkedCounts?.properties ? <b>{r.linkedCounts.properties}</b> : null}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )

  if (!anchor) {
    return (
      <div className="egx egx-landing">
        <div className="egx-aurora is-landing" aria-hidden="true"><i /><i /><i /></div>
        <LandingFx />
        <header className="egx-landing__head">
          <span className="egx-eyebrow">Entity Graph</span>
          <h1>Who really owns it.</h1>
          <p>Owners, the LLCs and trusts they hold title under, the people behind them, their debt, every sale — and every other record that is secretly the same party.</p>
        </header>
        {searchPanel}
        {!results && (
          <section className="egx-top">
            <header><h3>Largest ownership networks</h3><button type="button" className="egx-link" onClick={() => setMode('list')}>Browse every record</button></header>
            {!top && <div className="egx-skel"><i /><i /><i /></div>}
            <div className="egx-top__list">
              {(top ?? []).map((t, i) => (
                <button key={t.id} type="button" className="egx-net" style={{ animationDelay: `${i * 40}ms` }} onClick={() => go({ type: 'owner', id: t.id }, false)} data-egx-network={t.id}>
                  <span className="egx-net__orbit" aria-hidden="true">
                    <span className="egx-net__ring" style={{ animationDuration: `${10 + (i % 5) * 3}s`, animationDirection: i % 2 ? 'reverse' : 'normal' }}>
                      {Array.from({ length: Math.min(9, t.propertyCount) }, (_, k) => <i key={k} style={{ transform: `rotate(${(k / Math.min(9, t.propertyCount)) * 360}deg) translateX(19px)` }} />)}
                    </span>
                    <b><Icon name="star" /></b>
                  </span>
                  <span className="egx-net__body">
                    <strong>{t.name}</strong>
                    <em>{t.propertyCount.toLocaleString()} properties{t.markets.length ? ` · ${t.markets.slice(0, 2).join(', ')}` : ''}</em>
                  </span>
                  <span className="egx-net__value"><CountUp value={t.value} format={(x) => money(x)} ms={1400 + i * 60} /></span>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    )
  }

  return (
    <div className={cls('egx', selectMode && 'is-select-mode')}>
      <header className="egx-top-bar">
        <button type="button" className="egx-icon-btn" onClick={back} aria-label={trail.length ? `Back to ${trail[trail.length - 1].name}` : 'All networks'}>
          <Icon name="chevron-left" />
        </button>
        <div className="egx-top-bar__title">
          <span className="egx-eyebrow">{trail.length ? `via ${trail[trail.length - 1].name}` : 'Relationship network'}</span>
          <strong>{network?.owner.name ?? (state === 'loading' ? 'Tracing the network…' : 'Network')}</strong>
        </div>
        <button type="button" className="egx-icon-btn" onClick={() => setSearchOpen((v) => !v)} aria-label="Search" aria-expanded={searchOpen}><Icon name="search" /></button>
        <button type="button" className="egx-icon-btn" onClick={() => setMode('list')} aria-label="List view" data-egx-mode="list"><Icon name="list" /></button>
      </header>

      {searchOpen && <div className="egx-search-pop">{searchPanel}</div>}

      <div className="egx-layers" role="toolbar" aria-label="Relationship layers">
        <button type="button" className={cls('egx-layer is-select', selectMode && 'is-on')} onClick={() => setSelectMode((v) => !v)} aria-pressed={selectMode}><Icon name="check" />Select</button>
        {LAYERS.map((l) => {
          const count = network?.graph.nodes.filter((n) => n.type === l.type || (l.type === 'phone' && n.type === 'email')).length ?? 0
          if (!count) return null
          const on = !hidden.has(l.type)
          return (
            <button key={l.type} type="button" className={cls('egx-layer', `is-${l.type}`, on && 'is-on')} aria-pressed={on} onClick={() => setHidden((h) => { const n = new Set(h); if (n.has(l.type)) n.delete(l.type); else n.add(l.type); return n })}>
              <i aria-hidden="true" />{l.label}<b>{l.type === 'property' ? (network?.owner.propertyCount ?? count) : count}</b>
            </button>
          )
        })}
      </div>

      {selected.size > 0 && (
        <div className="egx-dock" role="region" aria-label="Selection">
          <div className="egx-dock__count"><strong>{selected.size}</strong><span>selected · {money(selectedValue)}</span></div>
          <button type="button" className="egx-dock__btn is-primary" onClick={() => setCampaignFor(selectedProps.map((p) => p.id))} data-egx-action="campaign"><Icon name="send" />Campaign</button>
          <button type="button" className="egx-dock__btn" onClick={() => showSetOnMap('selected from the network', 'portfolio', selectedProps.map((p) => ({ propertyId: p.id, lat: p.lat, lng: p.lng, address: p.address })))} aria-label="Show selection on Map"><Icon name="map" /></button>
          <button type="button" className="egx-dock__btn" onClick={() => setSelected(new Set())} aria-label="Clear selection"><Icon name="close" /></button>
        </div>
      )}

      {state === 'loading' && !network && (
        <div className="egx-tracing"><span className="egx-tracing__orb" /><p>Tracing ownership, title, people and debt…</p></div>
      )}
      {state === 'error' && (
        <div className="egx-tracing is-error"><p>Couldn’t load this network.</p><button type="button" className="egx-act" onClick={() => setAnchor({ ...anchor })}>Retry</button></div>
      )}

      {network && vis && (
        <EntityNetworkStage
          nodes={vis.nodes}
          edges={vis.edges}
          anchorId={network.anchor.nodeId}
          focusId={focusId}
          selected={selected}
          selectMode={selectMode}
          fitKey={`${network.anchor.nodeId}|${expanded}|${[...hidden].join(',')}`}
          onFocus={(id) => { setFocusId(id); if (id) setSnap((s) => (s === 'collapsed' ? 'collapsed' : s)) }}
          onToggleSelect={(id) => toggleSelect([id])}
          onExpandCluster={() => setExpanded(true)}
          reducedMotion={reducedMotion}
        />
      )}

      {network && (
        <MobileBottomSheet
          open
          snap={snap}
          snapHeights={SHEET_HEIGHTS}
          onSnapChange={setSnap}
          showBackdrop={false}
          className="egx-sheet"
        >
          <EntityNetworkInspector network={network} node={focusNode} selected={selected} actions={actions} />
        </MobileBottomSheet>
      )}

      <EntityGraphCampaignSheet
        open={campaignFor !== null}
        scope="properties"
        filters={{ ...EMPTY_ENTITY_GRAPH_FILTERS }}
        fieldFilters={[]}
        query=""
        cohortTotal={null}
        selected={campaignSelection}
        onClose={() => setCampaignFor(null)}
        onDone={(message) => { setCampaignFor(null); setToast(message); window.setTimeout(() => setToast(null), 3200) }}
      />
      {buyerSheet}
      {toast && <div className="egx-toast" role="status">{toast}</div>}
    </div>
  )
}
