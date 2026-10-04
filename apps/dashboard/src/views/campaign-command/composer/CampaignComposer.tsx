import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  LCButton, LCDialog, LCPopover, LCStatus, LCTooltip, cx, lcToast, lcTransition, LC_SPRING, useLcReducedMotion, type LCComboOption,
} from '../../../shared/lc'
import { Icon } from '../../../shared/icons'
import { sound } from '../../../shared/sound'
import { inspectObject, propertyObject } from '../../../modules/desktop/objects'
import { isWorkspaceRunning, openApp } from '../../../modules/desktop/workspace/workspace-store'
import { pushRoutePath } from '../../../app/router'
import { campaignPreviewMapPath, clearCampaignPreview, marketsOfSpec, previewSpecKey, publishCampaignPreview } from '../../../domain/campaign-preview/campaign-preview-context'
import { getFieldCatalog, searchFieldOptions, type CampaignFieldCatalog } from '../campaignWizardAdapter'
import { fetchCommandBook, type BookCampaign } from '../desktop/war-room-api'
import { duplicateAsDraft, launch, loadCampaign, prepareLaunch, readAudience, readCohort, readCoverage, readFleet, readTemplates, saveDraft } from './composer-api'
import type { ComposerAudience, ComposerCohort, ComposerCoverage, ComposerFleet, ComposerTemplates, PrepareResult } from './composer-types'
import {
  audienceSpec, capacityPlan, clauseId, clausesFromTargetFilters, compositionDiff, compositionPayload, deriveReadiness, eligibleOf, emptyComposition, fmt,
  coverageMarkets, inferSource, launchSentence, LAUNCH_ERROR_WORDS, n0, withCohort, zoneWaves,
  type Composition, type FilterClause, type Layer, type ReadinessCheck,
} from './composer-model'
import type { DropResolution, Intake } from './composer-intake'
import { GEO_INTAKE_FIELD } from './composer-intake'
import { AudiencePlane, type QuickSource } from './ComposerAudience'
import { DeliveryBody, ScheduleBody, StrategyBody } from './ComposerPlanes'
import { reasonWords } from './composer-format'
import { Plane } from './ComposerParts'
import './composer.css'

/**
 * CAMPAIGN COMPOSER 2.0 (desktop).
 *
 * Five persistent layers — AUDIENCE · STRATEGY · DELIVERY · SCHEDULE · LAUNCH
 * — composed as one surface: raw universe → eligible cohort → strategy →
 * capacity → time → ready → live. Hosted as Campaign Command's composition
 * surface (full app, or a workspace pane beside Map / Entity Graph); the
 * layout is container-queried on its own root.
 *
 * Every number is the server's (composer-api.ts). Writes: the draft through
 * the canonical create / PATCH (never status, never automation), launch
 * through prepare → confirm → launch (idempotent per launch key, fail closed).
 */

const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`)

const subscribeOnline = (cb: () => void) => { window.addEventListener('online', cb); window.addEventListener('offline', cb); return () => { window.removeEventListener('online', cb); window.removeEventListener('offline', cb) } }
const readOnline = () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false)

function initialComposition(intake: Intake | null): Composition {
  const c = emptyComposition()
  if (intake?.kind === 'market') {
    c.filters = [{ id: clauseId(), domain: 'properties', category: 'Location & Market', fieldKey: 'properties.market', label: 'Market', operator: 'is_any_of', value: intake.markets }]
    c.source = { kind: 'market', label: intake.markets.length > 2 ? `${intake.markets.length} markets` : intake.market }
  }
  if (intake?.kind === 'geography') {
    // Market Intelligence hand-off: the geography becomes the canonical location filter, nothing else.
    // The Composer computes the audience from the graph as for any filter.
    const f = GEO_INTAKE_FIELD[intake.level]
    c.filters = [{ id: clauseId(), domain: 'properties', category: 'Location & Market', fieldKey: f.fieldKey, label: f.label, operator: 'is_any_of', value: intake.values }]
    if (intake.state && intake.level !== 'state') c.filters.push({ id: clauseId(), domain: 'properties', category: 'Location & Market', fieldKey: GEO_INTAKE_FIELD.state.fieldKey, label: GEO_INTAKE_FIELD.state.label, operator: 'is_any_of', value: [intake.state] })
    c.source = { kind: 'filters', label: intake.label }
  }
  if (intake?.kind === 'properties') {
    c.filters = [{ id: clauseId(), domain: 'properties', category: 'Identity', fieldKey: 'properties.property_id', label: 'Selected properties', operator: 'in', value: intake.propertyIds }]
    c.source = { kind: 'property_set', label: intake.label }
  }
  return c
}

function compositionFromCampaign(row: Record<string, unknown>, labelOf: (k: string) => string): Composition {
  const md = (row.metadata && typeof row.metadata === 'object' ? row.metadata : {}) as Record<string, unknown>
  const c = emptyComposition()
  const str = (v: unknown, d = '') => (v === null || v === undefined ? d : String(v))
  c.name = str(row.name)
  c.description = str(row.description)
  c.template_use_case = str(md.template_use_case ?? row.objective, c.template_use_case)
  c.stage_code = str(md.stage_code, c.stage_code)
  c.filters = clausesFromTargetFilters(md.target_filters, labelOf)
  const src = md.composer_source as Composition['source'] | undefined
  const legacySource = str(md.source)
  c.source = src && typeof src === 'object' && src.kind ? src
    : legacySource === 'map_area' ? { kind: 'map_area', label: 'Map area', detail: str((md.area as Record<string, unknown> | undefined)?.label) || null }
    : legacySource === 'entity_graph' ? { kind: 'graph_selection', label: 'Entity Graph selection', detail: str(md.handoff_mode) || null }
    : inferSource(c.filters)
  c.daily_cap = str(row.daily_cap, c.daily_cap)
  // the explicit size choice is stored with the draft; an older draft without one must choose again
  const size = str(md.composer_campaign_size)
  c.campaign_size = size === 'all' || size === 'custom' ? size : null
  c.total_cap = c.campaign_size === 'custom' ? str(row.total_cap) : ''
  c.per_sender_cap = str(row.per_sender_cap)
  c.send_interval_seconds = str(row.send_interval_seconds, c.send_interval_seconds)
  c.contact_window_start = str(row.contact_window_start, c.contact_window_start).slice(0, 5)
  c.contact_window_end = str(row.contact_window_end, c.contact_window_end).slice(0, 5)
  const planned = str(md.planned_first_scheduled_at)
  c.start = planned ? { mode: 'at', at: planned } : { mode: 'now', at: null }
  return c
}

type Loadable<T> = { data: T | null; error: string | null }
type ReviewPhase = 'saving' | 'building' | 'ready' | 'launching' | 'done' | 'failed'
type Review = { open: boolean; phase: ReviewPhase; prepared: PrepareResult | null; error: string | null; code: string | null; launchKey: string }

export interface CampaignComposerProps {
  intake: Intake | null
  /** the route the composition belongs to: a workspace move remounts the pane, the composition survives */
  persistKey?: string
  onClose: () => void
  onLaunched: (campaignId: string) => void
}

type Persisted = { composerKey: string; composition: Composition; baseline: Composition | null; campaignId: string | null }
const PERSIST_PREFIX = 'lc.composer.v1:'
function readPersisted(key: string | undefined): Persisted | null {
  if (!key || typeof sessionStorage === 'undefined') return null
  try { return JSON.parse(sessionStorage.getItem(PERSIST_PREFIX + key) || 'null') as Persisted | null } catch { return null }
}

export function CampaignComposer({ intake, persistKey, onClose, onLaunched }: CampaignComposerProps) {
  const reduced = useLcReducedMotion()
  const online = useSyncExternalStore(subscribeOnline, readOnline, () => true)
  const [restored] = useState(() => readPersisted(persistKey))
  const [composerKey] = useState(() => restored?.composerKey ?? newKey())
  const [composition, setComposition] = useState<Composition>(() => restored?.composition ?? initialComposition(intake))
  const [baseline, setBaseline] = useState<Composition | null>(restored?.baseline ?? null)
  const [campaignId, setCampaignId] = useState<string | null>(restored?.campaignId ?? null)
  const [draftReq, setDraftReq] = useState<string | null>(intake?.kind === 'draft' && !restored ? intake.campaignId : null)
  const [draftState, setDraftState] = useState<{ id: string; state: 'ready' | 'not_editable' | 'error'; status?: string; message?: string } | null>(null)
  const [catalog, setCatalog] = useState<CampaignFieldCatalog | null>(null)
  const [markets, setMarkets] = useState<LCComboOption[] | null>(null)
  const [fleet, setFleet] = useState<Loadable<ComposerFleet>>({ data: null, error: null })
  const [templates, setTemplates] = useState<Loadable<ComposerTemplates>>({ data: null, error: null })
  const [drafts, setDrafts] = useState<BookCampaign[] | null>(null)
  const [aud, setAud] = useState<{ key: string; data: ComposerAudience | null; error: string | null } | null>(null)
  const [nonce, setNonce] = useState(0)
  const [save, setSave] = useState<{ state: 'unsaved' | 'saving' | 'saved' | 'error'; key: string | null; message?: string }>({ state: 'unsaved', key: null })
  const [now, setNow] = useState(() => Date.now())
  const [collapsed, setCollapsed] = useState<Record<Layer, boolean>>({ audience: false, strategy: false, delivery: false, schedule: false, launch: false })
  const [focus, setFocus] = useState<{ layer: Layer; n: number } | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [fieldRequest, setFieldRequest] = useState<string | null>(null)
  const [snapNote, setSnapNote] = useState<string | null>(null)
  const [review, setReview] = useState<Review>({ open: false, phase: 'saving', prepared: null, error: null, code: null, launchKey: '' })
  const busy = useRef(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const patch = useCallback((p: Partial<Composition>) => setComposition((c) => ({ ...c, ...p })), [])
  const labelOf = useCallback((key: string) => catalog?.fields.find((f) => f.key === key)?.label ?? key.split('.').pop()!.replace(/_/g, ' '), [catalog])

  /* ── reads ─────────────────────────────────────────────────────────── */
  useEffect(() => {
    let dead = false
    getFieldCatalog().then((c) => { if (!dead) setCatalog(c) }).catch(() => { /* filter command stays disabled; audience still works from sources */ })
    searchFieldOptions('properties.market', '').then((rows) => { if (!dead) setMarkets(rows.map((o) => ({ value: o.value, label: o.label, meta: typeof o.count === 'number' ? fmt(o.count) : undefined, icon: 'globe' as const }))) }).catch(() => { if (!dead) setMarkets([]) })
    readTemplates().then((r) => { if (!dead) setTemplates(r.ok ? { data: r.data, error: null } : { data: null, error: r.message }) })
    fetchCommandBook().then((b) => { if (!dead) setDrafts(b.campaigns.filter((c) => (c.status === 'draft' || c.status === 'built') && !c.archived).slice(0, 40)) }).catch(() => { if (!dead) setDrafts([]) })
    const loadFleet = () => readFleet().then((r) => { if (!dead) setFleet((prev) => (r.ok ? { data: r.data, error: null } : { data: prev.data, error: r.message })) })
    loadFleet()
    const fleetTimer = window.setInterval(loadFleet, 60_000)
    const tick = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => { dead = true; window.clearInterval(fleetTimer); window.clearInterval(tick) }
  }, [])

  // an existing draft (Map area / Entity Graph hand-offs, deep links, drops)
  useEffect(() => {
    if (!draftReq) return
    let dead = false
    loadCampaign(draftReq).then((r) => {
      if (dead) return
      if (!r.ok) { setDraftState({ id: draftReq, state: 'error', message: r.message }); return }
      const status = String(r.data.status ?? '').toLowerCase()
      if (!['draft', 'built'].includes(status)) { setDraftState({ id: draftReq, state: 'not_editable', status, message: String(r.data.name ?? '') }); return }
      const next = compositionFromCampaign(r.data, labelOf)
      setComposition(next)
      setBaseline(next)
      setCampaignId(draftReq)
      setSave({ state: 'saved', key: JSON.stringify(compositionPayload(next)) })
      setDraftState({ id: draftReq, state: 'ready', status })
    })
    return () => { dead = true }
    // labelOf only names chips; re-reading the draft when the catalog lands would wipe edits
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftReq])

  // the audience: debounced, abortable, keyed by exactly what changes the answer
  const spec = useMemo(() => audienceSpec(composition), [composition])
  const specKey = `${JSON.stringify(spec)}#${nonce}`
  const hasAudience = composition.filters.length > 0
  useEffect(() => {
    if (!hasAudience) return
    const ctl = new AbortController()
    const timer = window.setTimeout(() => {
      readAudience(spec, ctl.signal).then((r) => {
        if (ctl.signal.aborted) return
        setAud(r.ok ? { key: specKey, data: r.data, error: null } : { key: specKey, data: null, error: r.message })
      })
    }, 450)
    return () => { window.clearTimeout(timer); ctl.abort() }
    // spec is derived from specKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specKey, hasAudience])
  // the whole cohort, counted by the build's own pipeline (slower; aggregates only)
  const cohortKey = JSON.stringify({ f: spec.filters, u: spec.template_use_case, n: nonce })
  const [cohort, setCohort] = useState<{ key: string; data: ComposerCohort | null; error: string | null } | null>(null)
  useEffect(() => {
    if (!hasAudience) return
    const ctl = new AbortController()
    const timer = window.setTimeout(() => {
      readCohort({ filters: spec.filters, template_use_case: spec.template_use_case }, ctl.signal).then((r) => {
        if (ctl.signal.aborted) return
        setCohort(r.ok ? { key: cohortKey, data: r.data, error: null } : { key: cohortKey, data: null, error: r.message })
      })
    }, 650)
    return () => { window.clearTimeout(timer); ctl.abort() }
    // spec is derived from cohortKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cohortKey, hasAudience])
  const cohortNow = cohort?.key === cohortKey ? cohort : null
  const audLoading = hasAudience && aud?.key !== specKey
  // keep showing the last answer while the next one settles (counts move, never blank)
  const audience = hasAudience ? withCohort(aud?.data ?? null, cohortNow?.data ?? null) : null
  const cohortError = cohortNow?.error ?? null
  const audError = hasAudience && aud?.key === specKey ? aud.error ?? (cohortError ? `whole-cohort count failed — ${cohortError}` : null) : null

  /* ── autosave (only once a draft exists; never status / automation) ─── */
  const payloadKey = useMemo(() => JSON.stringify(compositionPayload(composition)), [composition])
  useEffect(() => {
    if (!campaignId || save.key === payloadKey || !composition.name.trim()) return
    const timer = window.setTimeout(() => {
      setSave((s) => ({ ...s, state: 'saving' }))
      saveDraft({ composer_key: composerKey, campaign_id: campaignId, composition: compositionPayload(composition) }).then((r) => {
        setSave(r.ok ? { state: 'saved', key: payloadKey } : { state: 'error', key: null, message: r.message })
      })
    }, 1200)
    return () => window.clearTimeout(timer)
  }, [campaignId, payloadKey, save.key, composition, composerKey])

  // the composition survives a workspace move (the pane remounts from its route)
  useEffect(() => {
    if (!persistKey) return
    try { sessionStorage.setItem(PERSIST_PREFIX + persistKey, JSON.stringify({ composerKey, composition, baseline, campaignId } satisfies Persisted)) } catch { /* storage full or blocked: the composition still lives in memory */ }
  }, [persistKey, composerKey, composition, baseline, campaignId])
  const forget = useCallback(() => { if (persistKey) try { sessionStorage.removeItem(PERSIST_PREFIX + persistKey) } catch { /* ignore */ } }, [persistKey])

  /* ── derived ──────────────────────────────────────────────────────── */
  const window_ = useMemo(() => ({ start: composition.contact_window_start, end: composition.contact_window_end }), [composition.contact_window_start, composition.contact_window_end])
  const hourStart = Math.floor(now / 3600_000) * 3600_000
  const waves = useMemo(() => zoneWaves(audience?.distributions.zones ?? [], window_, hourStart, 48), [audience, window_, hourStart])
  // sender coverage from the routing engine that dispatches now — recomputed whenever the audience's markets change
  const covMarkets = useMemo(() => coverageMarkets(audience), [audience])
  const covKey = JSON.stringify(covMarkets)
  const [coverage, setCoverage] = useState<{ key: string; data: ComposerCoverage | null; error: string | null } | null>(null)
  useEffect(() => {
    if (!covMarkets.length) return
    const ctl = new AbortController()
    const timer = window.setTimeout(() => {
      readCoverage(covMarkets, ctl.signal).then((r) => {
        if (ctl.signal.aborted) return
        setCoverage(r.ok ? { key: covKey, data: r.data, error: null } : { key: covKey, data: null, error: r.message })
      })
    }, 250)
    return () => { window.clearTimeout(timer); ctl.abort() }
    // covMarkets is derived from covKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [covKey])
  const coverageData = covMarkets.length ? coverage?.data ?? null : null
  const coverageLoading = covMarkets.length > 0 && coverage?.key !== covKey
  const coverageError = coverage?.key === covKey ? coverage.error : null
  const plan = useMemo(() => capacityPlan(coverageData, composition), [coverageData, composition])
  const eligible = eligibleOf(audience)
  const server = review.prepared?.readiness ?? null
  const readiness = useMemo(() => deriveReadiness({
    composition, audience, audienceError: audError, audienceLoading: audLoading, templates: templates.data, fleet: fleet.data, coverage: coverageLoading ? null : coverageData, coverageError, online, now, waves,
  }), [composition, audience, audError, audLoading, templates.data, fleet.data, coverageData, coverageLoading, coverageError, online, now, waves])
  const diff = useMemo(() => compositionDiff(baseline, composition), [baseline, composition])
  const canReview = readiness.state === 'ready' || readiness.state === 'warning'

  // one restrained cue when the composition becomes ready
  const lastState = useRef(readiness.state)
  useEffect(() => {
    if (readiness.state === 'ready' && lastState.current !== 'ready' && lastState.current !== 'warning') sound.outcome.ready()
    lastState.current = readiness.state
  }, [readiness.state])

  /* ── Campaign Map Preview: publish what is being composed (Map panes consume it) ── */
  const previewSpec = useMemo(() => ({ filters: spec.filters, template_use_case: spec.template_use_case }), [spec.filters, spec.template_use_case])
  const previewMarkets = useMemo(() => marketsOfSpec(previewSpec.filters), [previewSpec])
  const previewSection = focus?.layer ?? null
  useEffect(() => {
    publishCampaignPreview({
      key: composerKey,
      draftId: campaignId,
      name: composition.name.trim(),
      markets: previewMarkets,
      activeMarket: previewMarkets[previewMarkets.length - 1] ?? null,
      spec: previewSpec,
      specKey: previewSpecKey(previewSpec),
      composerEligible: eligible,
      section: previewSection,
    })
  }, [composerKey, campaignId, composition.name, previewMarkets, previewSpec, eligible, previewSection])
  // the preview ends with this Composer (closed, or another campaign opened in its place)
  useEffect(() => () => clearCampaignPreview(composerKey), [composerKey])

  /* ── actions ──────────────────────────────────────────────────────── */
  const focusLayer = (layer: Layer) => {
    setCollapsed((c) => ({ ...c, [layer]: false }))
    setFocus((f) => ({ layer, n: (f?.n ?? 0) + 1 }))
    const el = rootRef.current?.querySelector<HTMLElement>(`#ccz-${layer}`)
    el?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'nearest' })
    el?.focus({ preventScroll: true })
  }

  const setFilters = (filters: FilterClause[]) => setComposition((c) => ({ ...c, filters, source: c.source && c.source.kind !== 'filters' && filters.length ? c.source : inferSource(filters) }))

  const chooseMarket = (market: string) => {
    setComposition((c) => ({
      ...c,
      filters: [...c.filters.filter((f) => f.fieldKey !== 'properties.market'), { id: clauseId(), domain: 'properties', category: 'Location & Market', fieldKey: 'properties.market', label: 'Market', operator: 'is_any_of', value: [market] }],
      source: { kind: 'market', label: market },
      name: c.name || `${market.split(',')[0]} · ${new Date(now).toLocaleDateString([], { month: 'short', day: 'numeric' })}`,
    }))
  }

  const onDrop = (res: DropResolution) => {
    if (res.ignored.length) lcToast({ title: `${res.ignored.length} dropped ${res.ignored.length === 1 ? 'item' : 'items'} not used`, detail: res.ignored.slice(0, 2).map((i) => `${i.label}: ${i.reason}`).join(' · '), severity: 'warning' })
    if (res.propertyIds.length) {
      setComposition((c) => {
        const existing = c.filters.find((f) => f.fieldKey === 'properties.property_id')
        const prior = existing && Array.isArray(existing.value) ? existing.value.map(String) : []
        const ids = [...new Set([...prior, ...res.propertyIds])]
        const clause: FilterClause = { id: existing?.id ?? clauseId(), domain: 'properties', category: 'Identity', fieldKey: 'properties.property_id', label: 'Selected properties', operator: 'in', value: ids }
        return {
          ...c,
          filters: existing ? c.filters.map((f) => (f.id === existing.id ? clause : f)) : [...c.filters, clause],
          source: { kind: 'property_set', label: `${fmt(ids.length)} selected ${ids.length === 1 ? 'property' : 'properties'}`, detail: c.filters.length > (existing ? 1 : 0) ? 'and the filters below (AND)' : 'dropped in' },
        }
      })
      sound.workspace.drop('stack')
    }
    if (res.campaignIds.length && !hasAudience) setDraftReq(res.campaignIds[0])
    else if (res.campaignIds.length) lcToast({ title: 'Campaign not folded in', detail: 'Audiences combine by filters; open that campaign’s draft instead.', severity: 'info' })
  }

  const quick: QuickSource[] = useMemo(() => {
    // null while the catalog loads (disabled, no claim); false only when the catalog says so
    const has = (key: string) => (catalog ? catalog.fields.some((f) => f.key === key && f.campaign_applicable !== false) : null)
    const why = (key: string, no: string) => { const h = has(key); return h === null ? 'Reading the field catalog…' : h ? null : no }
    const mapDrafts = (drafts ?? []).filter((d) => d.source?.kind === 'map_area')
    const graphDrafts = (drafts ?? []).filter((d) => d.source?.kind === 'entity_graph' || d.source?.kind === 'selection')
    return [
      { key: 'zip', label: 'ZIP codes', detail: 'Pick ZIPs from the graph', icon: 'target', run: () => setFieldRequest('properties.property_address_zip'), disabled: why('properties.property_address_zip', 'Not available in the catalog') },
      { key: 'county', label: 'County', detail: 'Pick counties', icon: 'globe', run: () => setFieldRequest('properties.property_address_county_name'), disabled: why('properties.property_address_county_name', 'Not available in the catalog') },
      {
        key: 'reengage', label: 'Re-engagement', detail: 'Previously contacted prospects', icon: 'refresh-cw',
        run: () => setComposition((c) => ({ ...c, filters: [...c.filters, { id: clauseId(), domain: 'outreach', category: 'Rules', fieldKey: 'outreach.never_contacted', label: 'Never contacted', operator: 'is_false', value: '' }], source: { kind: 'reengagement', label: 'Re-engagement' } })),
        disabled: why('outreach.never_contacted', 'Not targetable'),
      },
      { key: 'map', label: `Map area drafts${drafts ? ` · ${mapDrafts.length}` : ''}`, detail: mapDrafts[0] ? `Latest: ${mapDrafts[0].name}` : 'Drawn on the Map', icon: 'map', run: () => mapDrafts[0] && setDraftReq(mapDrafts[0].id), disabled: !drafts ? 'Reading drafts…' : !mapDrafts.length ? 'No Map area drafts' : null },
      { key: 'graph', label: `Entity Graph drafts${drafts ? ` · ${graphDrafts.length}` : ''}`, detail: graphDrafts[0] ? `Latest: ${graphDrafts[0].name}` : 'Selections handed off', icon: 'users', run: () => graphDrafts[0] && setDraftReq(graphDrafts[0].id), disabled: !drafts ? 'Reading drafts…' : !graphDrafts.length ? 'No Entity Graph drafts' : null },
    ]
  }, [catalog, drafts])

  const openReview = async () => {
    if (busy.current || !canReview || !online) return
    busy.current = true
    setReview({ open: true, phase: 'saving', prepared: null, error: null, code: null, launchKey: newKey() })
    try {
      const saved = await saveDraft({ composer_key: composerKey, campaign_id: campaignId, composition: compositionPayload(composition) })
      if (!saved.ok) { setReview((r) => ({ ...r, phase: 'failed', error: saved.message, code: saved.error })); return }
      const id = saved.data.campaign_id
      setCampaignId(id)
      setSave({ state: 'saved', key: payloadKey })
      setReview((r) => ({ ...r, phase: 'building' }))
      const prepared = await prepareLaunch(id)
      if (!prepared.ok) { setReview((r) => ({ ...r, phase: 'failed', error: prepared.message, code: prepared.error })); return }
      setReview((r) => ({ ...r, phase: 'ready', prepared: prepared.data }))
    } finally { busy.current = false }
  }

  const serverReady = Boolean(server && server.blockers.length === 0 && n0(server.launch_ready) > 0)
  const doLaunch = async () => {
    if (busy.current || review.phase !== 'ready' || !serverReady || !campaignId || !online) return
    busy.current = true
    setReview((r) => ({ ...r, phase: 'launching', error: null, code: null }))
    try {
      const r = await launch({
        campaign_id: campaignId,
        launch_key: review.launchKey,
        start: composition.start,
        expected_eligible: n0(server!.launch_ready),
        audit: {
          source: composition.source,
          counts: { matched: audience?.matched ?? null, eligible_preview: eligible, launch_ready: server!.launch_ready, held: audience?.build.held ?? null },
          strategy: { use_case: composition.template_use_case, stage_code: composition.stage_code },
          templates: { sendable: templates.data?.strategies.find((s) => s.use_case === composition.template_use_case)?.sendable ?? null },
          schedule: composition.start,
          capacity: { daily_cap: composition.daily_cap, total_cap: composition.total_cap, available_per_day: plan.available_per_day, modeled_per_day: plan.effective_per_day },
          automation: { auto_reply_mode: fleet.data?.system.auto_reply_mode ?? null, followup_automation_mode: fleet.data?.system.followup_automation_mode ?? null },
          zones: waves.map((w) => w.zone),
        },
      })
      if (!r.ok) {
        const body = r.body
        setReview((rv) => ({ ...rv, phase: 'failed', error: body?.message || LAUNCH_ERROR_WORDS[r.error] || r.message, code: r.error, prepared: body?.readiness && rv.prepared ? { ...rv.prepared, readiness: body.readiness } : rv.prepared }))
        sound.outcome.error()
        return
      }
      setReview((rv) => ({ ...rv, phase: 'done' }))
      sound.outcome.success('strong')
      lcToast({
        title: r.data.mode === 'now' ? 'Campaign launched' : 'Campaign scheduled',
        detail: `${fmt(r.data.eligible)} eligible · ${r.data.mode === 'now' ? 'starting through recipient-local windows' : `from ${new Date(r.data.scheduled_for ?? '').toLocaleString()}`}${r.data.idempotent ? ' · already recorded' : ''}`,
        severity: 'success',
      })
      forget()
      window.setTimeout(() => onLaunched(campaignId), reduced ? 0 : 700)
    } catch {
      setReview((rv) => ({ ...rv, phase: 'failed', error: LAUNCH_ERROR_WORDS.network, code: 'network' }))
    } finally { busy.current = false }
  }

  const saveNow = async () => {
    if (!composition.name.trim()) { focusLayer('launch'); return }
    setSave((s) => ({ ...s, state: 'saving' }))
    const r = await saveDraft({ composer_key: composerKey, campaign_id: campaignId, composition: compositionPayload(composition) })
    if (r.ok) { setCampaignId(r.data.campaign_id); setSave({ state: 'saved', key: payloadKey }); if (!baseline) setBaseline(composition) }
    else setSave({ state: 'error', key: null, message: r.message })
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      if (review.open && review.phase === 'ready') void doLaunch()
      else if (!review.open) void openReview()
    }
  }

  // Map beside opens the Map in Campaign Preview Mode, bound to THIS composition
  const besideMap = () => { if (isWorkspaceRunning()) openApp(campaignPreviewMapPath(composerKey), 'beside'); else pushRoutePath('/map') }

  /* ── render ───────────────────────────────────────────────────────── */
  if (draftState?.state === 'not_editable') {
    return (
      <div className="ccz ccz--notice">
        <div className="ccz-notice">
          <Icon name="layers" size={18} />
          <h2>{draftState.message || 'This campaign'} is {draftState.status}</h2>
          <p className="ccz-muted">The Composer edits drafts. A {draftState.status} campaign is commanded in Campaign Command.</p>
          <div className="ccz-notice__row">
            <LCButton variant="primary" onClick={async () => { const r = await duplicateAsDraft(draftState.id); if (r.ok) { setDraftState(null); setDraftReq(r.data) } else lcToast({ title: 'Duplicate failed', detail: r.message, severity: 'critical' }) }}>Duplicate as draft</LCButton>
            <LCButton variant="quiet" onClick={() => onLaunched(draftState.id)}>Open in Campaign Command</LCButton>
            <LCButton variant="ghost" onClick={onClose}>Close</LCButton>
          </div>
        </div>
      </div>
    )
  }

  const stateTone = readiness.state === 'ready' ? 'ok' : readiness.state === 'warning' ? 'attn' : readiness.state === 'blocked' ? 'crit' : 'neutral'
  const layerState = (layer: Layer) => {
    // the launch step reads the whole composition's readiness
    if (layer === 'launch') return readiness.state === 'ready' ? 'ok' as const : readiness.state === 'warning' ? 'warn' as const : readiness.state === 'blocked' ? 'block' as const : 'checking' as const
    const xs = readiness.checks.filter((c) => c.layer === layer)
    if (!xs.length) return 'idle' as const
    if (xs.some((c) => c.state === 'block')) return 'block' as const
    if (xs.some((c) => c.state === 'checking')) return 'checking' as const
    if (xs.some((c) => c.state === 'warn')) return 'warn' as const
    return 'ok' as const
  }
  const strategy = templates.data?.strategies.find((s) => s.use_case === composition.template_use_case) ?? null
  const spine: Array<{ layer: Layer; label: string; line: string }> = [
    { layer: 'audience', label: 'Audience', line: !hasAudience ? 'Raw universe' : eligible === null ? (audLoading ? 'Counting…' : '—') : `${fmt(audience?.matched)} → ${fmt(eligible)} eligible` },
    { layer: 'strategy', label: 'Strategy', line: strategy ? `${strategy.label} · ${fmt(strategy.sendable)} templates` : '—' },
    { layer: 'delivery', label: 'Delivery', line: coverageData ? `${fmt(plan.effective_per_day)}/day · ${plan.uncovered_markets.length ? `${plan.uncovered_markets.length} unrouted` : 'all routed'}` : '—' },
    { layer: 'schedule', label: 'Schedule', line: composition.start.mode === 'now' ? `On launch · ${waves.map((w) => w.short).join(' → ') || 'zones pending'}` : new Date(composition.start.at ?? '').toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) },
    { layer: 'launch', label: 'Launch', line: readiness.state === 'ready' ? 'Ready' : readiness.state === 'warning' ? `Ready · ${readiness.warnings} warnings` : readiness.state === 'blocked' ? `${readiness.blockers} blocking` : 'Checking' },
  ]
  const plane = (layer: Layer) => ({
    layer,
    state: layerState(layer),
    collapsed: collapsed[layer],
    onToggle: () => setCollapsed((c) => ({ ...c, [layer]: !c[layer] })),
    focused: focus?.layer === layer,
  })

  return (
    <div className={cx('ccz', `is-${readiness.state}`)} ref={rootRef} onKeyDown={onKeyDown} aria-label="Campaign Composer">
      <header className="ccz-head">
        <LCTooltip content="Back to Campaign Command"><button type="button" className="ccz-back" onClick={() => { forget(); onClose() }} aria-label="Close Composer"><Icon name="chevron-left" size={15} /></button></LCTooltip>
        <div className="ccz-head__title">
          <span className="ccz-kicker">{campaignId ? 'Draft' : 'New campaign'}</span>
          <input className="ccz-name" value={composition.name} placeholder="Name this campaign" onChange={(e) => patch({ name: e.target.value })} aria-label="Campaign name" />
        </div>
        <div className="ccz-head__meta">
          {diff.length ? (
            <LCPopover width={320} label="Changes since saved" trigger={<button type="button" className="ccz-diffbtn">{diff.length} {diff.length === 1 ? 'change' : 'changes'}</button>}>
              <ul className="ccz-diff">{diff.map((d) => <li key={d.label}><span>{d.label}</span><s>{d.from}</s><Icon name="chevron-right" size={11} /><b>{d.to}</b></li>)}</ul>
            </LCPopover>
          ) : null}
          <span className={cx('ccz-save', `is-${save.state}`)} role="status" aria-live="polite">
            {save.state === 'saving' ? 'Saving…' : save.state === 'saved' ? <><Icon name="check" size={12} /> Saved</> : save.state === 'error' ? `Not saved — ${save.message ?? 'error'}` : campaignId ? 'Unsaved changes' : 'Not saved yet'}
          </span>
          {!campaignId ? <LCButton size="sm" variant="quiet" onClick={saveNow} disabled={!composition.name.trim() || !online}>Save draft</LCButton> : null}
          <LCButton size="sm" variant="ghost" icon="map" onClick={besideMap}>Map beside</LCButton>
        </div>
      </header>

      <nav className="ccz-spine" aria-label="Composition">
        {spine.map((s, i) => (
          <button key={s.layer} type="button" className={cx('ccz-spine__step', `is-${layerState(s.layer)}`)} onClick={() => focusLayer(s.layer)}>
            <span className="ccz-spine__idx">{String(i + 1).padStart(2, '0')}</span>
            <span className="ccz-spine__txt"><b>{s.label}</b><em>{s.line}</em></span>
          </button>
        ))}
      </nav>

      {draftState?.state === 'error' ? <div className="ccz-err ccz-err--bar" role="alert"><Icon name="alert-circle" size={14} /> The draft couldn’t be opened — {draftState.message}</div> : null}
      {!online ? <div className="ccz-err ccz-err--bar" role="alert"><Icon name="alert-circle" size={14} /> Connection lost — readiness can’t be verified; launch is disabled.</div> : null}

      <div className="ccz-stage">
        <div className="ccz-grid">
          <Plane {...plane('audience')} title="Audience" className="ccz-col-a" summary={hasAudience ? (eligible === null ? 'Counting…' : `${fmt(eligible)} eligible`) : 'Choose a source'}>
            <AudiencePlane
              audience={audience}
              loading={audLoading}
              error={audError}
              filters={composition.filters}
              source={composition.source}
              catalog={catalog}
              quick={quick}
              markets={markets}
              onMarket={chooseMarket}
              onFilters={setFilters}
              onDrop={onDrop}
              onRetry={() => setNonce((x) => x + 1)}
              editing={editing}
              setEditing={setEditing}
              fieldRequest={fieldRequest}
              onFieldRequestDone={() => setFieldRequest(null)}
            />
          </Plane>
          <div className="ccz-col-b">
            <Plane {...plane('strategy')} title="Strategy" summary={strategy ? `${strategy.label} · ${strategy.stage_code}` : templates.error ? 'Templates unavailable' : 'Reading…'}>
              {templates.error && !templates.data ? <div className="ccz-err"><Icon name="alert" size={14} /> Template coverage didn’t load — {templates.error}</div> : null}
              <StrategyBody
                templates={templates.data}
                audience={audience}
                composition={composition}
                fleet={fleet.data}
                onStrategy={(s) => patch({ template_use_case: s.use_case, stage_code: s.stage_code })}
                onInspect={(sample) => sample.property_id && inspectObject(propertyObject({ propertyId: sample.property_id, label: sample.place, source: 'campaign-composer' }))}
              />
            </Plane>
            <Plane {...plane('delivery')} title="Delivery" summary={coverageData ? `${fmt(plan.effective_per_day)}/day modeled · ${fmt(plan.available_per_day)} routable today` : coverageError ? 'Routing unavailable' : 'Reading…'}>
              {fleet.error && !fleet.data ? <div className="ccz-err"><Icon name="alert" size={14} /> System controls didn’t load — {fleet.error}</div> : null}
              <DeliveryBody
                fleet={fleet.data}
                coverage={coverageData}
                coverageError={coverageError}
                coverageLoading={coverageLoading}
                plan={plan}
                composition={composition}
                eligibleInAudience={audience?.eligible_in_audience ?? null}
                snapNote={snapNote}
                onPatch={(p) => { setSnapNote(null); patch(p) }}
                onDailyCap={(value, reason) => { setSnapNote(reason); patch({ daily_cap: value }) }}
              />
            </Plane>
          </div>
          <Plane {...plane('schedule')} title="Schedule" className="ccz-col-c" summary={composition.start.mode === 'now' ? 'Starts on launch' : `Starts ${new Date(composition.start.at ?? '').toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`}>
            <ScheduleBody composition={composition} waves={waves} audience={audience} plan={plan} eligible={coverageData ? plan.covered_targets : eligible} held={audience?.build.held ?? null} now={now} onStart={(start) => patch({ start })} />
          </Plane>
          <Plane {...plane('launch')} title="Readiness" className="ccz-col-d" summary={readiness.state === 'checking' ? 'Checking…' : `${readiness.blockers} blocking · ${readiness.warnings} warnings`}>
            <ReadinessList checks={readiness.checks} onFocus={focusLayer} />
          </Plane>
        </div>
      </div>

      <footer className={cx('ccz-dock', `is-${readiness.state}`)}>
        <div className="ccz-dock__state">
          <LCStatus label={readiness.state === 'ready' ? 'Ready' : readiness.state === 'warning' ? 'Ready with warnings' : readiness.state === 'blocked' ? 'Blocked' : 'Checking'} tone={stateTone} />
          <span className="ccz-dock__line">
            {readiness.checks.filter((c) => c.state === 'block' || c.state === 'warn').slice(0, 2).map((c) => (
              <button key={c.key} type="button" className={cx('ccz-dock__issue', `is-${c.state}`)} onClick={() => focusLayer(c.layer)}>{c.text}</button>
            ))}
            {readiness.state === 'ready' ? <span className="ccz-muted">{launchSentence(eligible ?? 0, composition.start)}</span> : null}
          </span>
        </div>
        <div className="ccz-dock__go">
          <span className="ccz-dock__count"><b className="ccz-num">{eligible === null ? '—' : fmt(eligible)}</b><em>eligible</em></span>
          <LCTooltip content={canReview ? 'Save, build targets and run the preflight' : 'Resolve the blocking checks first'} shortcut={['⌘', '↵']}>
            <span>
              <LCButton variant="primary" size="lg" onClick={() => void openReview()} disabled={!canReview || !online} trailingIcon="chevron-right" className="ccz-go">
                Review launch
              </LCButton>
            </span>
          </LCTooltip>
        </div>
      </footer>

      <LCDialog
        open={review.open}
        onOpenChange={(o) => { if (!o && review.phase !== 'launching' && review.phase !== 'saving' && review.phase !== 'building') setReview((r) => ({ ...r, open: false })) }}
        title={review.phase === 'done' ? 'Launched' : 'Launch summary'}
        description={review.phase === 'ready' || review.phase === 'launching' ? launchSentence(n0(server?.launch_ready), composition.start) : undefined}
        width={640}
        sticky
        footer={
          <div className="ccz-review__foot">
            <LCButton variant="quiet" onClick={() => setReview((r) => ({ ...r, open: false }))} disabled={review.phase === 'launching' || review.phase === 'saving' || review.phase === 'building'}>Cancel</LCButton>
            <LCButton variant="primary" size="lg" onClick={() => void doLaunch()} disabled={review.phase !== 'ready' || !serverReady || !online} loading={review.phase === 'launching'} className="ccz-launch">
              {composition.start.mode === 'now' ? 'Launch now' : 'Schedule launch'}
            </LCButton>
          </div>
        }
      >
        <ReviewBody review={review} composition={composition} eligible={eligible} strategyLabel={strategy?.label ?? composition.template_use_case} plan={plan} waves={waves.map((w) => w.short)} />
      </LCDialog>
    </div>
  )
}

function ReadinessList({ checks, onFocus }: { checks: ReadinessCheck[]; onFocus: (l: Layer) => void }) {
  const reduced = useLcReducedMotion()
  return (
    <ul className="ccz-checks" aria-label="Readiness checks">
      <AnimatePresence initial={false}>
        {checks.map((c) => (
          <motion.li key={c.key} layout={!reduced} initial={reduced ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={lcTransition(reduced, LC_SPRING.layout)}>
            <button type="button" className={cx('ccz-check', `is-${c.state}`)} onClick={() => onFocus(c.layer)}>
              <i aria-hidden="true" />
              <span className="ccz-check__k">{c.label}</span>
              <span className="ccz-check__v">{c.text}</span>
            </button>
          </motion.li>
        ))}
      </AnimatePresence>
    </ul>
  )
}

function ReviewBody({ review, composition, eligible, strategyLabel, plan, waves }: {
  review: Review
  composition: Composition
  eligible: number | null
  strategyLabel: string
  plan: ReturnType<typeof capacityPlan>
  waves: string[]
}) {
  const r = review.prepared?.readiness ?? null
  const steps: Array<[ReviewPhase, string]> = [['saving', 'Draft saved'], ['building', 'Targets built'], ['ready', 'Preflight']]
  const order: ReviewPhase[] = ['saving', 'building', 'ready', 'launching', 'done']
  const at = review.phase === 'failed' ? -1 : review.phase === 'ready' ? 3 : order.indexOf(review.phase)
  return (
    <div className="ccz-review">
      <ol className="ccz-review__steps">
        {steps.map(([phase, label], i) => (
          <li key={phase} className={cx(at > i && 'is-done', at === i && 'is-now')}><i />{label}</li>
        ))}
      </ol>
      {review.phase === 'failed' ? (
        <div className="ccz-err" role="alert">
          <Icon name="alert-circle" size={14} />
          <span><b>{LAUNCH_ERROR_WORDS[review.code ?? ''] ?? 'Not launched'}</b> — {review.error}. Nothing changed; the composition is kept.</span>
        </div>
      ) : null}
      {r ? (
        <>
          <dl className="ccz-review__grid">
            <div><dt>Audience</dt><dd><b className="ccz-num">{fmt(r.launch_ready)}</b> launch-ready <span className="ccz-dim">({fmt(eligible)} previewed · {composition.source?.label ?? 'filters'})</span></dd></div>
            <div><dt>Strategy</dt><dd>{strategyLabel} · {composition.stage_code} · {r.template_readiness ?? '—'}</dd></div>
            <div><dt>Delivery</dt><dd>{fmt(plan.effective_per_day)}/day modeled · cap {composition.daily_cap}/day · size {composition.campaign_size === 'all' ? 'all eligible' : composition.campaign_size === 'custom' ? composition.total_cap : 'not chosen'}</dd></div>
            <div><dt>Schedule</dt><dd>{composition.start.mode === 'now' ? 'On launch' : new Date(composition.start.at ?? '').toLocaleString()} · {waves.join(' → ') || '—'} local windows {composition.contact_window_start}–{composition.contact_window_end}</dd></div>
            <div><dt>Completion</dt><dd>{plan.effective_per_day ? (() => { const d = Math.max(1, Math.ceil(n0(r.launch_ready) / plan.effective_per_day)); return `~${d} ${d === 1 ? 'day' : 'days'} (modeled)` })() : '—'}</dd></div>
            <div><dt>Guardrails</dt><dd>Suppression, DNC, quiet hours per recipient, sender health and paused templates enforced at send. Auto send / auto reply unchanged.</dd></div>
          </dl>
          {r.blockers.length ? <ul className="ccz-review__issues is-block">{r.blockers.map((b) => <li key={b}>{b}</li>)}</ul> : null}
          {r.warnings.length ? <ul className="ccz-review__issues">{r.warnings.slice(0, 5).map((w) => <li key={w}>{w}</li>)}</ul> : null}
          {r.language_coverage.some((l) => l.renders === false) ? <p className="ccz-muted">Languages without a message: {r.language_coverage.filter((l) => l.renders === false).map((l) => `${l.language} (${reasonWords(l.reason)})`).join(', ')}</p> : null}
        </>
      ) : review.phase !== 'failed' ? <div className="ccz-skel-rows" aria-busy="true"><span /><span /><span /></div> : null}
    </div>
  )
}
