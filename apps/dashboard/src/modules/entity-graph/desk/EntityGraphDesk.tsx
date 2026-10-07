/**
 * ENTITY GRAPH · DESK — the relationship intelligence workspace for a desk.
 *
 * Not the phone surface stretched: a records workspace in three planes.
 *
 *   header     title, live summary, six exact KPIs, scope tabs, search,
 *              saved views, columns, Grid ↔ Graph
 *   rail       the campaign field catalog as filters (facets with every
 *              value, quick filters, any field)
 *   center     a dense windowed grid (sortable — whole-cohort server sort
 *              where an index exists, else the loaded rows, said so —
 *              resizable columns, keyboard, selection) or the relationship
 *              view of the selected network
 *   inspector  owner → properties → people/contacts (with the vendor
 *              matching tags) → title entities → debt/liens/transfers →
 *              related owners → conversations
 *
 * Layout follows the PANE (container queries on .egdk), so a split pane gets
 * a narrower composition: the rail folds behind a button and the inspector
 * floats. A selected property is the workspace's linked selection (the view
 * publishes it through the property locator); a property arriving from the
 * Map / Inbox / Deal Intelligence re-anchors the inspector.
 *
 * Phones never mount this (EntityGraphWorkspace routes isPhone to the
 * console), so the phone DOM is unchanged.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  LCBulkBar,
  LCButton,
  LCDataGrid,
  LCEmpty,
  LCIconButton,
  LCMenu,
  LCPopover,
  LCSearch,
  LCSegmented,
  LCTabs,
  cx,
  lcPrompt,
  lcToast,
  type LCColumn,
  type LCMenuEntry,
  type LCSort,
} from '../../../shared/lc'
import { useAuth } from '../../../components/auth/AuthProvider'
import { fetchEntityGraphList, fetchEntityGraphTabCounts, EntityGraphFilterError } from '../../../domain/entity-graph/entity-graph-api'
import type { EntityGraphAction, EntityGraphTabCounts, EntitySearchResult, UniversalEntityContext } from '../../../domain/entity-graph/entity-graph.types'
import { EMPTY_UNIVERSAL_ENTITY_CONTEXT } from '../../../domain/entity-graph/universal-entity-context'
import { fieldFiltersToApiParams } from '../../../domain/entity-graph/entity-graph-workspace-state'
import { parseFieldFiltersParam, type EntityGraphFieldFilter, type UnsupportedFieldFilter } from '../../../domain/entity-graph/entity-graph-field-filters'
import { writeMapFocusSet } from '../../../domain/map/map-focus-set'
import { useRouteLocation } from '../../../app/router'
import { BuyerInspectorSheet, type BuyerMapPoint } from '../buyer/BuyerInspector'
import { fetchEntityNetwork, type EntityNetwork } from '../console/entity-network-api'
import {
  COLUMN_GROUP_LABELS,
  COLUMN_GROUP_ORDER,
  SCOPE_TABLE_COLUMNS,
  defaultVisibleColumns,
  sortLoadedRows,
  visibleEnrichmentFields,
  type HeaderSort,
  type TableColumn,
} from '../mobile/entity-graph-table-columns'
import { IDENTITY_COLUMN_KEY, useEntityGraphTableLayout } from '../mobile/entity-graph-table-layout'
import { useEntityGraphColumns } from '../mobile/use-entity-graph-columns'
import { MOBILE_SCOPES, resolveIdentity, scopeNoun, tabForScope, type EntityScope } from '../mobile/entity-graph-mobile-format'
import { DeskFilterRail } from './DeskFilterRail'
import { DeskGraph } from './DeskGraph'
import { DeskInspector } from './DeskInspector'
import { fetchDeskKpis, kpisFromCounts } from './desk-api'
import {
  anchorForResult,
  anchorKey,
  GRAPH_LAYERS,
  columnByKey,
  fmtCount,
  headerSortIsLocal,
  kpiTiles,
  makeView,
  readViews,
  serverSortFor,
  writeViews,
  type DeskKpis,
  type DeskView,
  type NetworkAnchor,
} from './desk-model'
import './entity-graph-desk.css'

type Props = {
  themeMode?: string
  universalContext: UniversalEntityContext
  onUniversalContextChange: (next: UniversalEntityContext) => void
  onAction?: (action: EntityGraphAction, context: UniversalEntityContext) => void
}

const PAGE_SIZE = 60
const rowKey = (r: EntitySearchResult) => `${r.entityType}:${r.entityId}`

type ListState = {
  signature: string
  cursor: number
  results: EntitySearchResult[]
  total: number | null
  hasMore: boolean
  nextAfter: string | null
  sortApplied: boolean | null
  error: string | null
  unsupported: UnsupportedFieldFilter[] | null
}
const EMPTY_LIST: ListState = { signature: '', cursor: 0, results: [], total: null, hasMore: false, nextAfter: null, sortApplied: null, error: null, unsupported: null }

/** The network the universal context names (respecting its entity type, so an owner stays an owner). */
function anchorFromContext(ctx: UniversalEntityContext | null | undefined): NetworkAnchor | null {
  if (!ctx) return null
  if (ctx.entityType === 'master_owner' && ctx.masterOwnerId) return { type: 'owner', id: String(ctx.masterOwnerId) }
  if (ctx.entityType === 'prospect' && ctx.prospectId) return { type: 'person', id: String(ctx.prospectId) }
  if (ctx.propertyId) return { type: 'property', id: String(ctx.propertyId) }
  if (ctx.masterOwnerId) return { type: 'owner', id: String(ctx.masterOwnerId) }
  if (ctx.prospectId) return { type: 'person', id: String(ctx.prospectId) }
  return null
}

function contextForAnchor(a: NetworkAnchor, net?: EntityNetwork | null): UniversalEntityContext {
  if (a.type === 'property') return { ...EMPTY_UNIVERSAL_ENTITY_CONTEXT, entityType: 'property', entityId: a.id, propertyId: a.id, masterOwnerId: net?.owner.id ?? null }
  if (a.type === 'person') return { ...EMPTY_UNIVERSAL_ENTITY_CONTEXT, entityType: 'prospect', entityId: a.id, prospectId: a.id }
  return { ...EMPTY_UNIVERSAL_ENTITY_CONTEXT, entityType: 'master_owner', entityId: a.id, masterOwnerId: a.id }
}

function useElementWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    setW(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

export function EntityGraphDesk({ themeMode = 'dark', universalContext, onUniversalContextChange, onAction }: Props) {
  const uid = useAuth().user?.id || 'local'
  const location = useRouteLocation()
  const initialParams = useMemo(() => new URLSearchParams(location.split('?')[1] ?? ''), []) // eslint-disable-line react-hooks/exhaustive-deps

  const [scope, setScope] = useState<EntityScope>(() => {
    const s = initialParams.get('egs') as EntityScope | null
    return s && SCOPE_TABLE_COLUMNS[s] ? s : 'properties'
  })
  const [contactSubtype, setContactSubtype] = useState<'phone' | 'email'>('phone')
  const [query, setQuery] = useState(() => initialParams.get('q') ?? '')
  const [debouncedQuery, setDebouncedQuery] = useState(() => (initialParams.get('q') ?? '').trim())
  const [filters, setFilters] = useState<EntityGraphFieldFilter[]>(() => parseFieldFiltersParam(initialParams.get('ff')))
  const [center, setCenter] = useState<'grid' | 'graph'>(() => (initialParams.get('egv') === 'graph' ? 'graph' : 'grid'))
  // 'auto' = shown on a wide pane, folded on a narrow one; a click makes it explicit.
  const [railPref, setRailPref] = useState<'auto' | 'shown' | 'hidden'>('auto')
  const [hiddenLayers, setHiddenLayers] = useState<Set<string>>(() => new Set())
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  // `?buyer=<public buyer_id>` (Comps "View buyer", Buyer Match) opens that buyer.
  const [buyerId, setBuyerId] = useState<string | null>(() => initialParams.get('buyer') || null)
  const [views, setViews] = useState<DeskView[]>(() => readViews(uid))
  const [rootRef, width] = useElementWidth<HTMLElement>()
  const narrow = width > 0 && width < 980
  const wide = width >= 1060

  const { layout, setColumns, setSort } = useEntityGraphTableLayout()
  const headerSort: HeaderSort | null = layout.sort[scope] ?? null
  const visibleKeys = layout.columns[scope] ?? defaultVisibleColumns(scope)

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(query.trim()), 260)
    return () => window.clearTimeout(t)
  }, [query])

  /* ── KPIs + scope counts ───────────────────────────────────────────────── */
  const [counts, setCounts] = useState<EntityGraphTabCounts | null>(null)
  const [kpis, setKpis] = useState<DeskKpis | null | 'loading'>('loading')
  useEffect(() => {
    const ctl = new AbortController()
    void fetchEntityGraphTabCounts(ctl.signal).then(setCounts).catch(() => setCounts(null))
    void fetchDeskKpis(ctl.signal).then((k) => { if (!ctl.signal.aborted) setKpis(k) }).catch(() => { if (!ctl.signal.aborted) setKpis(null) })
    return () => ctl.abort()
  }, [])
  const effectiveKpis = kpis === 'loading' ? null : (kpis ?? kpisFromCounts(counts))
  const tiles = kpiTiles(effectiveKpis)

  /* ── The list ──────────────────────────────────────────────────────────── */
  const searching = Boolean(debouncedQuery)
  const sort = serverSortFor(scope, headerSort, searching)
  const localSort = headerSortIsLocal(scope, headerSort, searching)
  const signature = `${scope}|${contactSubtype}|${debouncedQuery}|${JSON.stringify(filters)}|${sort.sortBy}|${sort.ascending ? 1 : 0}`
  const [list, setList] = useState<ListState>(EMPTY_LIST)
  const [cursor, setCursor] = useState(0)
  const [seenSig, setSeenSig] = useState(signature)
  if (seenSig !== signature) {
    setSeenSig(signature)
    setCursor(0)
    setSelected(new Set())
  }
  const isCurrent = list.signature === signature
  const results = isCurrent ? list.results : EMPTY_LIST.results
  const loading = !isCurrent
  const loadingMore = isCurrent && cursor > list.cursor
  const generation = useRef(0)

  useEffect(() => {
    const ctl = new AbortController()
    const gen = ++generation.current
    const reqSig = signature
    const reqCursor = cursor
    void fetchEntityGraphList({
      tab: tabForScope(scope),
      q: debouncedQuery || undefined,
      cursor,
      page_size: PAGE_SIZE,
      ...(reqCursor > 0 && list.signature === reqSig && list.nextAfter ? { after: list.nextAfter } : {}),
      subtype: scope === 'contact_methods' ? contactSubtype : undefined,
      sort_by: sort.sortBy,
      ascending: sort.ascending ? '1' : '0',
      ...fieldFiltersToApiParams(filters),
    }, ctl.signal)
      .then((res) => {
        if (gen !== generation.current) return
        setList((cur) => {
          const appending = reqCursor > 0 && cur.signature === reqSig
          const seen = new Set(appending ? cur.results.map(rowKey) : [])
          const fresh = res.results.filter((r) => { const k = rowKey(r); if (seen.has(k)) return false; seen.add(k); return true })
          return {
            signature: reqSig,
            cursor: reqCursor,
            results: appending ? [...cur.results, ...fresh] : fresh,
            total: appending && res.pagination.total === null ? cur.total : res.pagination.total,
            hasMore: res.pagination.hasMore,
            nextAfter: res.pagination.nextAfter ?? null,
            sortApplied: res.pagination.sort ? res.pagination.sort.sortApplied : null,
            error: null,
            unsupported: null,
          }
        })
      })
      .catch((error: unknown) => {
        if (gen !== generation.current || ctl.signal.aborted) return
        const unsupported = error instanceof EntityGraphFilterError ? error.unsupportedFilters : null
        const message = error instanceof Error ? error.message : 'load_failed'
        setList((cur) => (reqCursor > 0 && cur.signature === reqSig
          ? { ...cur, cursor: reqCursor, error: message }
          : { ...EMPTY_LIST, signature: reqSig, cursor: reqCursor, error: message, unsupported }))
      })
    return () => ctl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- signature + cursor encode the request
  }, [signature, cursor])

  const enrichment = useEntityGraphColumns(results, visibleEnrichmentFields(scope, visibleKeys), scope === 'properties')
  const headerColumn = headerSort && headerSort.key !== IDENTITY_COLUMN_KEY ? columnByKey(scope, headerSort.key) : null
  const identitySortColumn = useMemo<TableColumn>(() => ({ key: IDENTITY_COLUMN_KEY, label: 'Name', group: 'overview', width: 0, render: (r) => resolveIdentity(scope, r).primary || null }), [scope])
  const rows = useMemo(() => {
    if (!localSort || !headerSort) return enrichment.rows
    const col = headerSort.key === IDENTITY_COLUMN_KEY ? identitySortColumn : headerColumn
    return col ? sortLoadedRows(scope, enrichment.rows, col, headerSort.dir) : enrichment.rows
  }, [enrichment.rows, localSort, headerSort, headerColumn, identitySortColumn, scope])

  /* ── Selection → inspector ─────────────────────────────────────────────── */
  const [anchor, setAnchor] = useState<NetworkAnchor | null>(() => anchorFromContext(universalContext))
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [inspectorOpen, setInspectorOpen] = useState(() => Boolean(anchorFromContext(universalContext)))
  // The inspector docks wherever the grid keeps ≥ ~600px; on a mid-width pane
  // an open inspector folds the rail (auto) rather than squeezing the grid.
  const inspectorMode: 'dock' | 'float' = wide ? 'dock' : 'float'
  const railShown = railPref === 'auto' ? !narrow && !(inspectorOpen && inspectorMode === 'dock' && width < 1420) : railPref === 'shown'
  // A subject arriving from another app (Map, Inbox, a deep link) re-anchors the inspector.
  const ctxAnchor = anchorFromContext(universalContext)
  const ctxKey = anchorKey(ctxAnchor)
  const [seenCtx, setSeenCtx] = useState(ctxKey)
  if (seenCtx !== ctxKey) {
    setSeenCtx(ctxKey)
    if (ctxAnchor && ctxKey !== anchorKey(anchor)) {
      setAnchor(ctxAnchor)
      setInspectorOpen(true)
    }
  }

  const [netState, setNetState] = useState<{ key: string; data: EntityNetwork | null; failed: boolean } | null>(null)
  const [netAttempt, setNetAttempt] = useState(0)
  const netKey = `${anchorKey(anchor)}#${netAttempt}`
  const network = netState?.key === netKey ? netState.data : null
  const netLoading = Boolean(anchor) && netState?.key !== netKey
  const netFailed = netState?.key === netKey && netState.failed
  useEffect(() => {
    if (!anchor) return
    const ctl = new AbortController()
    const key = netKey
    void fetchEntityNetwork(anchor.type, anchor.id, ctl.signal)
      .then((n) => { if (!ctl.signal.aborted) setNetState({ key, data: n, failed: !n }) })
      .catch(() => { if (!ctl.signal.aborted) setNetState({ key, data: null, failed: true }) })
    return () => ctl.abort()
  }, [anchor, netKey])

  const openAnchor = (a: NetworkAnchor, opts: { rowKey?: string | null } = {}) => {
    setAnchor(a)
    setActiveKey(opts.rowKey ?? null)
    setInspectorOpen(true)
    const ctx = contextForAnchor(a)
    setSeenCtx(anchorKey(a))
    onUniversalContextChange(ctx)
  }

  const activate = (r: EntitySearchResult) => {
    if (r.entityType === 'buyer') { setBuyerId(r.entityId); return }
    const a = anchorForResult(r)
    if (!a) { lcToast({ title: 'This record has no relationship network to open.', severity: 'info' }); return }
    openAnchor(a, { rowKey: rowKey(r) })
  }

  /* ── Grid columns ──────────────────────────────────────────────────────── */
  const gridColumns = useMemo<Array<LCColumn<EntitySearchResult>>>(() => {
    const identity: LCColumn<EntitySearchResult> = {
      id: IDENTITY_COLUMN_KEY,
      header: scope === 'properties' ? 'Property' : scope === 'contact_methods' ? 'Contact' : 'Name',
      width: scope === 'properties' ? 300 : 260,
      minWidth: 180,
      sortable: true,
      render: (r) => {
        const id = resolveIdentity(scope, r)
        return (
          <span className="egdk-cell-id">
            <span className="egdk-cell-id__primary">{id.primary}</span>
            {id.secondary ? <span className="egdk-cell-id__secondary">{id.secondary}</span> : null}
          </span>
        )
      },
    }
    const byKey = new Map(SCOPE_TABLE_COLUMNS[scope].map((c) => [c.key, c]))
    const cols = visibleKeys.map((k) => byKey.get(k)).filter((c): c is TableColumn => Boolean(c)).map((c): LCColumn<EntitySearchResult> => ({
      id: c.key,
      header: c.label,
      width: Math.round(c.width * 1.18) + 12,
      minWidth: 64,
      align: c.align === 'right' ? 'right' : 'left',
      sortable: true,
      hint: c.sortBy && !searching ? `${c.label} · sorts the whole cohort` : `${c.label} · sorts the loaded rows`,
      render: (r) => {
        const v = c.render(r)
        return v === null || v === '' ? <span className="egdk-cell-none">—</span> : v
      },
    }))
    return [identity, ...cols]
  }, [scope, visibleKeys, searching])

  const gridSort: LCSort = headerSort ? { id: headerSort.key, dir: headerSort.dir } : null
  const onSortChange = (next: LCSort) => setSort(scope, next ? { key: next.id, dir: next.dir } : null)

  /* ── Saved views ───────────────────────────────────────────────────────── */
  const saveView = async () => {
    const name = await lcPrompt({ title: 'Save view', label: 'Name', placeholder: 'e.g. Atlanta probate, 60%+ equity', confirmLabel: 'Save view', nativeText: 'Name this view' })
    if (name === null) return
    const next = [makeView({ name, scope, query: debouncedQuery, fieldFilters: filters, sort: headerSort, columns: layout.columns[scope] ?? null }), ...views]
    setViews(next)
    writeViews(uid, next)
    lcToast({ title: `Saved “${next[0].name}”`, severity: 'success' })
  }
  const applyView = (v: DeskView) => {
    setScope(v.scope)
    setQuery(v.query)
    setDebouncedQuery(v.query)
    setFilters(v.fieldFilters)
    setSort(v.scope, v.sort)
    if (v.columns) setColumns(v.scope, v.columns)
  }
  const deleteView = (v: DeskView) => {
    const next = views.filter((x) => x.id !== v.id)
    setViews(next)
    writeViews(uid, next)
  }
  const viewItems: LCMenuEntry[] = [
    ...(views.length ? views.map((v): LCMenuEntry => ({
      kind: 'sub', id: v.id, label: v.name,
      items: [
        { id: `${v.id}:open`, label: 'Open', hint: `${MOBILE_SCOPES.find((s) => s.key === v.scope)?.label ?? v.scope}${v.fieldFilters.length ? ` · ${v.fieldFilters.length} filters` : ''}${v.query ? ` · “${v.query}”` : ''}`, onSelect: () => applyView(v) },
        { id: `${v.id}:delete`, label: 'Delete', tone: 'danger', onSelect: () => deleteView(v) },
      ],
    })) : [{ kind: 'label' as const, id: 'none', label: 'No saved views yet' }]),
    { kind: 'separator', id: 'sep' },
    { id: 'save', label: 'Save current view…', icon: 'bookmark', onSelect: () => { void saveView() } },
  ]

  /* ── Bulk (selected rows) ──────────────────────────────────────────────── */
  const selectedRows = rows.filter((r) => selected.has(rowKey(r)))
  const exportSelected = () => {
    const cols = gridColumns
    const esc = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
    const byKey = new Map(SCOPE_TABLE_COLUMNS[scope].map((c) => [c.key, c]))
    const header = ['id', ...cols.map((c) => c.header)]
    const lines = selectedRows.map((r) => [r.entityId, resolveIdentity(scope, r).primary, ...cols.slice(1).map((c) => byKey.get(c.id)?.render(r) ?? '')].map(esc).join(','))
    const blob = new Blob([[header.map(esc).join(','), ...lines].join('\n')], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `entity-graph-${scope}-${selectedRows.length}.csv`
    a.click()
    window.setTimeout(() => URL.revokeObjectURL(a.href), 2000)
  }
  const showOnMap = () => {
    const pts = selectedRows.map((r) => ({ id: r.entityId, lat: Number(r.details?.lat), lng: Number(r.details?.lng), label: r.title }))
    const ok = writeMapFocusSet({ label: `${pts.length} from Entity Graph`, tone: 'property', points: pts })
    if (!ok) { lcToast({ title: 'None of these have map coordinates.', severity: 'info' }); return }
    const first = selectedRows[0]
    onAction?.('open_in_map', { ...EMPTY_UNIVERSAL_ENTITY_CONTEXT, entityType: 'property', entityId: first.entityId, propertyId: first.entityId })
  }

  /* ── Render ────────────────────────────────────────────────────────────── */
  const scopeTabs = MOBILE_SCOPES.map((s) => ({
    id: s.key,
    label: s.label,
    count: counts ? (s.key === 'contact_methods' ? counts.contact_methods : (counts[s.countKey as keyof EntityGraphTabCounts] as number | null | undefined) ?? null) : null,
  }))
  const total = isCurrent ? list.total : null
  const noun = scopeNoun(scope, total ?? 2)
  const summary = loading
    ? 'Reading the universe…'
    : list.error && !results.length
      ? 'This cohort could not be read'
      : `${total !== null ? fmtCount(total) : 'Uncounted'} ${noun}${searching ? ` matching “${debouncedQuery}”` : ''}${filters.length ? ` · ${filters.length} ${filters.length === 1 ? 'filter' : 'filters'}` : ''}`
  const sortNote = !isCurrent ? null
    : localSort && headerSort ? `Sorted within ${fmtCount(results.length)} loaded rows${searching ? ' — search results are ranked' : ' — this column has no whole-cohort index'}`
      : list.sortApplied === false ? 'The server could not apply that order — showing its fallback order'
        : null

  const emptyState: { title: string; body?: ReactNode } = list.unsupported?.length
    ? { title: 'These filters could not be applied', body: `Nothing was queried, so no cohort is shown. Remove or change: ${list.unsupported.map((u) => `${u.field_key ?? 'filter'} (${u.reason.replace(/_/g, ' ')})`).join(', ')}` }
    : searching ? { title: `No ${scopeNoun(scope, 2)} match “${debouncedQuery}”`, body: 'Search reads addresses, names, phones and emails in this scope; a market name returns the whole market.' }
      : filters.length ? { title: 'No records match these filters', body: 'Every filter is applied exactly — remove one to widen the cohort.' }
        : { title: 'No records in this scope' }

  const graphPane = (
    <div className="egdk-graphpane">
      {network ? (
        <>
          <div className="egdk-graphpane__bar">
            <div className="egdk-graphpane__title">
              <span className="egdk-eyebrow">Relationship view</span>
              <strong>{network.owner.name}</strong>
              <small>{`${fmtCount(network.graph.nodes.length)} records · ${fmtCount(network.graph.edges.length)} links`}</small>
            </div>
            <div className="egdk-layers" role="group" aria-label="Layers">
              {GRAPH_LAYERS.filter((l) => network.graph.nodes.some((n) => n.type === l.type || (l.type === 'phone' && n.type === 'email'))).map((l) => {
                const off = hiddenLayers.has(l.type)
                return (
                  <button key={l.type} type="button" aria-pressed={!off} className={cx('egdk-layer', `is-${l.type}`, off && 'is-off')} onClick={() => setHiddenLayers((cur) => { const n = new Set(cur); if (n.has(l.type)) n.delete(l.type); else n.add(l.type); return n })}>
                    <span className="egdk-dot" aria-hidden="true" />{l.label}
                  </button>
                )
              })}
            </div>
          </div>
          <DeskGraph network={network} hiddenTypes={hiddenLayers} onOpen={(a) => openAnchor(a)} />
        </>
      ) : netLoading ? (
        <div className="egdk-graphpane__state"><span className="lc-skel egdk-graphpane__skel" role="status" aria-label="Drawing the network" /></div>
      ) : (
        <div className="egdk-graphpane__state">
          <LCEmpty icon="layers" title={anchor ? 'This network did not load' : 'Pick a record to draw its network'} body={anchor ? undefined : 'Select any property, owner or person in the grid — its owner, portfolio, people, contacts, title entities and recorded documents draw here.'} action={anchor ? { label: 'Try again', onClick: () => setNetAttempt((n) => n + 1) } : { label: 'Back to the grid', onClick: () => setCenter('grid') }} />
        </div>
      )}
    </div>
  )

  return (
    <section ref={rootRef} className={cx('egdk', `is-${themeMode}`, narrow && 'is-narrow', wide && 'is-wide', !railShown && 'is-rail-hidden', narrow && railShown && 'is-rail-over', inspectorOpen && inspectorMode === 'dock' && 'has-dock')} data-scope={scope}>
      <header className="egdk-head">
        <div className="egdk-head__id">
          <h1>Entity Graph</h1>
          <p className="egdk-head__summary" aria-live="polite">{summary}</p>
        </div>
        <div className="egdk-kpis" role="list" aria-label="Universe">
          {tiles.map((t) => (
            <div key={t.key} role="listitem" className={cx('egdk-kpi', t.value === null && 'is-na')} title={t.basis}>
              <span className="egdk-kpi__label">{t.label}</span>
              <b className="egdk-kpi__value">{kpis === 'loading' && t.value === null ? <span className="lc-skel egdk-kpi__skel" /> : t.value === null ? 'Not available' : t.unit === '%' ? `${t.value}%` : fmtCount(t.value)}</b>
              <span className="egdk-kpi__basis">{t.basis}</span>
            </div>
          ))}
        </div>
      </header>

      <div className="egdk-bar">
        <LCIconButton icon="filter" label={railShown ? 'Hide filters' : 'Show filters'} size="sm" selected={railShown} count={filters.length || null} onClick={() => setRailPref(railShown ? 'hidden' : 'shown')} className="egdk-bar__rail" />
        <LCTabs items={scopeTabs} value={scope} onChange={(id) => { setScope(id as EntityScope); setFilters([]) }} label="Entity scope" variant="line" className="egdk-bar__tabs" />
        <div className="egdk-bar__tools">
          <LCSegmented size="sm" label="View" value={center} onChange={(v) => setCenter(v as 'grid' | 'graph')} options={[{ value: 'grid', icon: 'list', label: 'Grid' }, { value: 'graph', icon: 'layers', label: 'Graph' }]} />
        </div>
      </div>

      <div className="egdk-body">
        {railShown ? <DeskFilterRail scope={scope} filters={filters} onChange={setFilters} /> : null}
        <main className="egdk-center" aria-label={center === 'grid' ? 'Records' : 'Relationship view'}>
          {center === 'grid' ? (
            <>
              <div className="egdk-tablebar">
                <LCSearch value={query} onChange={setQuery} label={`Search ${MOBILE_SCOPES.find((s) => s.key === scope)?.label.toLowerCase() ?? 'records'}`} placeholder={scope === 'properties' ? 'Search address, city or market…' : 'Search name, phone, email…'} loading={loading && searching} className="egdk-tablebar__search" />
                {scope === 'contact_methods' ? (
                  <LCSegmented size="sm" label="Contact type" value={contactSubtype} onChange={(v) => setContactSubtype(v as 'phone' | 'email')} options={[{ value: 'phone', label: 'Phones' }, { value: 'email', label: 'Emails' }]} />
                ) : null}
                <span className="egdk-tablebar__count">{loading ? '' : total !== null ? `${fmtCount(total)} ${noun}` : `${fmtCount(results.length)} loaded · count unavailable`}</span>
                <LCMenu trigger={<LCButton size="sm" variant="quiet" icon="bookmark">Views{views.length ? ` · ${views.length}` : ''}</LCButton>} items={viewItems} label="Saved views" title="Saved views" width={280} />
                <ColumnPicker scope={scope} visible={visibleKeys} onChange={(next) => setColumns(scope, next)} />
              </div>
              {sortNote || enrichment.error ? (
                <p className="egdk-note" role="status">{sortNote}{sortNote && enrichment.error ? ' · ' : ''}{enrichment.error ? 'Some column values did not load — those cells read —' : ''}</p>
              ) : null}
              <LCDataGrid
                id={`entity-graph-desk-${scope}`}
                label={`${MOBILE_SCOPES.find((s) => s.key === scope)?.label ?? 'Records'}`}
                rows={rows}
                rowKey={rowKey}
                columns={gridColumns}
                sort={gridSort}
                onSortChange={onSortChange}
                activeKey={activeKey}
                onActivate={(r) => activate(r)}
                selected={selected}
                onSelectedChange={setSelected}
                density="dense"
                loading={loading}
                error={isCurrent && list.error && !list.unsupported ? { what: 'These records didn’t load', onRetry: () => setList(EMPTY_LIST) } : null}
                empty={emptyState}
                total={total}
                loadingMore={loadingMore}
                onEndReached={() => { if (isCurrent && list.hasMore && !loadingMore && !list.error) setCursor(list.cursor + PAGE_SIZE) }}
                className="egdk-grid"
              />
              {selected.size ? (
                <LCBulkBar
                  className="egdk-bulk"
                  count={selected.size}
                  inView={rows.length}
                  all={selected.size >= rows.length ? 'all' : 'some'}
                  noun={{ one: scopeNoun(scope, 1), many: scopeNoun(scope, 2) }}
                  onSelectAll={() => setSelected(new Set(rows.map(rowKey)))}
                  onClear={() => setSelected(new Set())}
                  actions={[
                    { id: 'map', label: 'Show on Map', icon: 'map', onRun: showOnMap, disabled: scope !== 'properties', disabledReason: 'Map handoff is property-scoped' },
                    { id: 'export', label: 'Export CSV', icon: 'archive', onRun: exportSelected },
                  ]}
                />
              ) : null}
            </>
          ) : graphPane}
        </main>
        <DeskInspector
          open={inspectorOpen && Boolean(anchor)}
          mode={inspectorMode}
          anchor={anchor}
          network={network}
          loading={netLoading}
          error={netFailed}
          onRetry={() => setNetAttempt((n) => n + 1)}
          onClose={() => { setInspectorOpen(false); setActiveKey(null) }}
          onOpen={(a) => openAnchor(a)}
          onOpenGraph={() => setCenter('graph')}
          onAction={onAction}
          onOpenBuyer={(id) => setBuyerId(id)}
        />
      </div>

      <BuyerInspectorSheet
        buyerId={buyerId}
        open={Boolean(buyerId)}
        onClose={() => setBuyerId(null)}
        onOpenProperty={(propertyId) => { setBuyerId(null); openAnchor({ type: 'property', id: propertyId }) }}
        onOpenBuyer={(id) => setBuyerId(id)}
        onShowOnMap={(points: BuyerMapPoint[]) => {
          setBuyerId(null)
          if (writeMapFocusSet({ label: 'from this buyer', tone: 'buyer', points: points.map((p) => ({ lat: p.lat, lng: p.lng, id: p.propertyId, label: p.address ?? null })) })) {
            const first = points.find((p) => p.propertyId)
            if (first?.propertyId) onAction?.('open_in_map', { ...EMPTY_UNIVERSAL_ENTITY_CONTEXT, entityType: 'property', entityId: first.propertyId, propertyId: first.propertyId })
          }
        }}
        onOpenBuyerMatch={(propertyId) => onAction?.('open_buyer_match', { ...EMPTY_UNIVERSAL_ENTITY_CONTEXT, entityType: propertyId ? 'property' : null, entityId: propertyId ?? null, propertyId: propertyId ?? null })}
      />
    </section>
  )
}

function ColumnPicker({ scope, visible, onChange }: { scope: EntityScope; visible: string[]; onChange: (next: string[]) => void }) {
  const all = SCOPE_TABLE_COLUMNS[scope]
  const on = new Set(visible)
  const groups = COLUMN_GROUP_ORDER.map((g) => ({ g, cols: all.filter((c) => c.group === g) })).filter((x) => x.cols.length)
  const [find, setFind] = useState('')
  const q = find.trim().toLowerCase()
  return (
    <LCPopover
      trigger={<LCButton size="sm" variant="quiet" icon="grid">Columns · {visible.length}</LCButton>}
      align="end"
      width={320}
      label="Columns"
      className="egdk-cols"
    >
      <div className="egdk-cols__head">
        <LCSearch value={find} onChange={setFind} label="Find a column" placeholder={`Find a column · ${all.length}`} />
        <button type="button" className="egdk-link" onClick={() => onChange(defaultVisibleColumns(scope))}>Reset</button>
      </div>
      <div className="egdk-cols__list lc-scroll">
        {groups.map(({ g, cols }) => {
          const shown = q ? cols.filter((c) => c.label.toLowerCase().includes(q)) : cols
          if (!shown.length) return null
          return (
            <div key={g} className="egdk-cols__group">
              <span className="egdk-eyebrow">{COLUMN_GROUP_LABELS[g]}</span>
              {shown.map((c) => (
                <label key={c.key} className="egdk-cols__item">
                  <input type="checkbox" checked={on.has(c.key)} onChange={() => onChange(on.has(c.key) ? visible.filter((k) => k !== c.key) : [...visible, c.key])} />
                  <span>{c.label}</span>
                  {c.sortBy ? <small title="Sorts the whole cohort">indexed</small> : null}
                </label>
              ))}
            </div>
          )
        })}
      </div>
    </LCPopover>
  )
}
