import { useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { PaneRouteContext, pushRoutePath, replaceRoutePath, useRouteLocation } from '../../../app/router'
import { writeMapFocusSet } from '../../../domain/map/map-focus-set'
import { setPropertyLocator } from '../../../domain/locator/property-locator'
import { LCButton, LCConfirm, LCEmpty, LCLive, LCSearch, LCSkeleton, LCTabs, lcMenu, type LCMenuEntry } from '../../../shared/lc'
import { emitNotification } from '../../../shared/NotificationToast'
import { sound } from '../../../shared/sound'
import type { CampaignModel, CampaignSummary } from '../campaigns.types'
import { getDetailActions } from '../campaign-health'
import { fetchCampaignCockpit, fetchCohortPoints, type CockpitTargetRow } from './cockpit-api'
import { fetchCampaignIntel, fetchCommandBook, fetchReplyBook, type Batch, type BookCampaign, type ReplyBucketKey } from './war-room-api'
import type { DemoData } from './war-room-demo'
import { actionSpec, warActivity, type ActionSpec } from './war-room-activity'
import { useNow, useResource, useWidth } from './war-room-hooks'
import { publishCampaignSubject } from './war-room-links'
import {
  audienceSteps, bookLine, businessFunnel, capsTruth, facts, gatesOf, groupRail, heldReasons, isLiveStatus, missionOf, moneyLines,
  nameParts, nextOf, nf, paceOf, railRowOf, replySegments, riverOf, sourceWords, stoppingGate, windowTrack, zoneFamily,
  type GateKey, type RiverKey, type WarInput,
} from './war-room-model'
import { ActivityMode } from './WarActivity'
import { ExecutionMode } from './WarExecution'
import { GeoPlane } from './WarGeo'
import { WarHero, type HeroAction } from './WarHero'
import { WarInspector, type InspectorCtx } from './WarInspector'
import { PerformanceMode } from './WarPerformance'
import { AudiencePlane, FleetPlane, LatestActivity, OutcomePlane, TimePlane } from './WarPlanes'
import { MissionRail } from './WarRail'
import { ExecutionRiver, GateRail } from './WarRiver'
import { TargetsMode, type TargetStatus } from './WarTargets'
import './war-room.css'

/**
 * CAMPAIGN COMMAND 3.0 — the outbound execution war room (desktop only; the
 * phone keeps its own Campaign Command, untouched).
 *
 *   LEFT    mission rail — every campaign by its real operational state
 *   CENTER  execution room — hero, the execution river and its gates, then
 *           Overview · Execution · Targets · Activity · Performance
 *   RIGHT   intelligence inspector — contextual (gate, audience, sender,
 *           delivery, replies, outcomes, target, batch, campaign brief)
 *
 * Reads: the campaign book (rail + header), the cockpit read (one campaign's
 * live state) and the intel read (delivery, fleet, batches, replies,
 * outcomes) — all read-only. Writes: only through the existing campaign
 * action path (executeCampaignAction via `onAction`), each send-affecting one
 * stated as effects first. Never anything else.
 */

type Mode = 'overview' | 'execution' | 'targets' | 'activity' | 'performance'
const MODES: Mode[] = ['overview', 'execution', 'targets', 'activity', 'performance']

const loadBook = (_key: string, signal: AbortSignal) => fetchCommandBook(signal)
const loadReplies = (_key: string, signal: AbortSignal) => fetchReplyBook(signal)
const loadCore = (id: string, signal: AbortSignal) => fetchCampaignCockpit(id, signal)
const loadIntel = (id: string, signal: AbortSignal) => fetchCampaignIntel(id, signal)

const PRIMARY_ORDER = ['resume', 'pause', 'reschedule', 'schedule', 'build_targets', 'restore', 'duplicate']
const ACTION_LABEL: Record<string, string> = {
  pause: 'Pause', resume: 'Resume', schedule: 'Schedule', reschedule: 'Reschedule', activate: 'Launch now…', build_targets: 'Build audience',
  restore: 'Restore', duplicate: 'Duplicate', archive: 'Archive', queue_batch: 'Queue test batch…', convert_to_live: 'Switch to live…',
  edit: 'Open setup', sync_metrics: 'Recalculate counts', refresh: 'Reload',
}

function params(location: string) {
  return new URLSearchParams(location.includes('?') ? location.slice(location.indexOf('?') + 1) : '')
}

function readCtx(q: URLSearchParams): InspectorCtx | null {
  const v = q.get('ccx')
  if (!v) return null
  if (v.startsWith('gate:')) return { kind: 'gate', gate: v.slice(5) as GateKey }
  if (['campaign', 'audience', 'senders', 'delivery', 'replies', 'outcomes', 'queue'].includes(v)) return { kind: v } as InspectorCtx
  return null
}

const ctxParam = (ctx: InspectorCtx): string | null => (ctx.kind === 'gate' ? `gate:${ctx.gate}` : ['campaign', 'audience', 'senders', 'delivery', 'replies', 'outcomes', 'queue'].includes(ctx.kind) ? ctx.kind : null)

export function CampaignWarRoom({
  model, loading, failed, onRetry, onRefresh, onNew, onAction, focusCampaignId = null,
}: {
  model: CampaignModel | null
  loading: boolean
  failed: boolean
  onRetry: () => void
  onRefresh: () => void
  onNew: () => void
  onAction: (action: string, campaign: CampaignSummary, payload?: Record<string, unknown>) => Promise<unknown> | void
  focusCampaignId?: string | null
}) {
  const inPane = Boolean(useContext(PaneRouteContext))
  const location = useRouteLocation()
  const q = useMemo(() => params(location), [location])
  const urlCampaign = q.get('campaign')
  const now = useNow()
  const [rootRef, width] = useWidth<HTMLDivElement>()

  /* ── DEMO (development only, ?demo=1): fixtures through the same components ── */
  const demoOn = import.meta.env.DEV && q.get('demo') === '1'
  const [demo, setDemo] = useState<DemoData | null>(null)
  useEffect(() => {
    if (!demoOn) return
    let alive = true
    // `import.meta.env.DEV` is the literal `false` in a production build, so the
    // bundler drops this branch and never emits the fixtures chunk at all
    if (import.meta.env.DEV) void import('./war-room-demo').then((m) => { if (alive) setDemo(m.demoData(Date.now())) })
    return () => { alive = false }
  }, [demoOn])

  /* ── the book ── */
  const liveBook = useResource('cc3-book', 'book', loadBook, { pollMs: 30_000, enabled: !demoOn })
  // replies read the message log per campaign — the slower part, after the book
  const liveReplies = useResource('cc3-replies', 'replies', loadReplies, { pollMs: 120_000, enabled: Boolean(liveBook.data) && !demoOn })
  const book = demoOn ? { ...liveBook, data: demo?.book ?? null, error: null, loading: !demo, at: demo ? Date.parse(demo.book.at) : null } : liveBook
  const replyBook = demoOn ? { ...liveReplies, data: demo?.replies ?? null } : liveReplies
  const system = book.data?.system ?? null
  const summaries = useMemo(() => (demoOn ? [] : model?.campaigns ?? []), [model, demoOn])
  const summaryById = useMemo(() => new Map(summaries.map((c) => [c.id, c])), [summaries])
  const bookById = useMemo(() => {
    const replies = replyBook.data?.replies ?? null
    return new Map((book.data?.campaigns ?? []).map((c): [string, BookCampaign] => {
      if (c.archived) return [c.id, c]
      const r = replies?.[c.id] ?? null
      // nobody messaged → a true zero; messaged but the reply read is pending or failed → unknown
      const zero = { sellers_replied: 0, sellers_asked_to_stop: 0, buckets: { interested: 0, not_interested: 0, wrong_number: 0, opt_out: 0, ambiguous: 0, other: 0 }, latest_reply_at: null, truncated: false }
      return [c.id, { ...c, replies: r ?? ((c.sends?.sellers_dispatched ?? 0) === 0 && c.sends ? zero : null) }]
    }))
  }, [book.data, replyBook.data])
  const ids = useMemo(() => [...new Set([...(book.data?.campaigns ?? []).map((c) => c.id), ...summaries.map((c) => c.id)])], [book.data, summaries])
  const allRows = useMemo(() => ids.map((id) => railRowOf({ book: bookById.get(id) ?? null, summary: summaryById.get(id) ?? null, system }, now)), [ids, bookById, summaryById, system, now])
  const [query, setQuery] = useState('')
  const rows = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length) return allRows
    return allRows.filter((r) => {
      const hay = `${r.title} ${r.eyebrow} ${r.mission.label} ${r.id} ${bookById.get(r.id)?.name ?? ''} ${(bookById.get(r.id)?.source.market_values ?? []).join(' ')}`.toLowerCase()
      return words.every((w) => hay.includes(w))
    })
  }, [allRows, query, bookById])
  const groups = useMemo(() => groupRail(rows), [rows])

  /* ── selection: pane-aware, follows the location's ?campaign= ── */
  const [local, setLocal] = useState<{ id: string; url: string | null } | null>(null)
  const [seenFocus, setSeenFocus] = useState(focusCampaignId)
  if (focusCampaignId !== seenFocus) {
    setSeenFocus(focusCampaignId)
    if (focusCampaignId) setLocal({ id: focusCampaignId, url: urlCampaign })
  }
  const requested = inPane ? (local && local.url === urlCampaign ? local.id : urlCampaign ?? local?.id ?? null) : (urlCampaign ?? local?.id ?? null)
  const known = (id: string | null) => Boolean(id && ids.includes(id))
  const fallback = useMemo(() => {
    for (const g of ['attention', 'live', 'waiting', 'scheduled', 'paused', 'drafts', 'completed']) {
      const r = allRows.find((x) => x.mission.group === g)
      if (r) return r.id
    }
    return allRows[0]?.id ?? null
  }, [allRows])
  const selectedId = requested && (known(requested) || !ids.length) ? requested : fallback

  const [mode, setModeState] = useState<Mode>(() => (MODES.includes(q.get('cc') as Mode) ? (q.get('cc') as Mode) : 'overview'))
  const [ctx, setCtx] = useState<InspectorCtx>(() => readCtx(q) ?? { kind: 'campaign' })
  const [ctxStack, setCtxStack] = useState<InspectorCtx[]>([])
  const [inspPref, setInspPref] = useState<boolean | null>(() => (readCtx(q) ? true : null))
  const [railOpen, setRailOpen] = useState(false)
  const [targetStatus, setTargetStatus] = useState<TargetStatus>('all')
  const [targetReason, setTargetReason] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{ action: string; campaign: CampaignSummary; spec: ActionSpec } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const dock = width >= 1500
  const narrow = width > 0 && width < 920
  const inspOpen = inspPref ?? dock

  const writeUrl = useCallback((patch: Record<string, string | null>) => {
    if (inPane || typeof window === 'undefined') return
    const url = new URL(window.location.href)
    for (const [k, v] of Object.entries(patch)) {
      if (v) url.searchParams.set(k, v)
      else url.searchParams.delete(k)
    }
    const next = `${url.pathname}${url.search}${url.hash}`
    if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) replaceRoutePath(next)
  }, [inPane])

  const select = useCallback((id: string) => {
    setLocal({ id, url: urlCampaign })
    setCtx({ kind: 'campaign' })
    setCtxStack([])
    setRailOpen(false)
    setTargetStatus('all')
    setTargetReason(null)
    writeUrl({ campaign: id, ccx: null })
  }, [urlCampaign, writeUrl])

  const setMode = useCallback((m: Mode) => { sound.ui.select(); setModeState(m); writeUrl({ cc: m === 'overview' ? null : m }) }, [writeUrl])

  /* ── the selected campaign's reads ── */
  const bookRow = selectedId ? bookById.get(selectedId) ?? null : null
  const summary = selectedId ? summaryById.get(selectedId) ?? null : null
  const live = isLiveStatus(bookRow?.status ?? summary?.status)
  const liveCore = useResource('cc3-core', selectedId, loadCore, { pollMs: live ? 20_000 : 60_000, enabled: !demoOn })
  const liveIntel = useResource('cc3-intel', selectedId, loadIntel, { pollMs: live ? 45_000 : 120_000, enabled: !demoOn })
  const core = demoOn ? { ...liveCore, data: (selectedId && demo?.cores[selectedId]) || null, error: null, loading: !demo } : liveCore
  const intel = demoOn ? { ...liveIntel, data: (selectedId && demo?.intels[selectedId]) || null, error: null, loading: !demo } : liveIntel
  const input: WarInput = useMemo(() => ({ summary, book: bookRow, core: core.data, intel: intel.data, system }), [summary, bookRow, core.data, intel.data, system])

  const mission = useMemo(() => missionOf(input, now), [input, now])
  const river = useMemo(() => riverOf(input, now), [input, now])
  const gates = useMemo(() => gatesOf(input, now), [input, now])
  const stopping = useMemo(() => stoppingGate(gates), [gates])
  const next = useMemo(() => nextOf(input, now), [input, now])
  const pace = useMemo(() => paceOf(input, now), [input, now])
  const caps = useMemo(() => capsTruth(input), [input])
  const f = useMemo(() => facts(input), [input])
  const track = useMemo(() => windowTrack(f.window, now, Intl.DateTimeFormat().resolvedOptions().timeZone), [f.window, now])

  /* ── publish the subject (Shell 6.0 linked context) ── */
  const subjectName = bookRow?.name ?? summary?.campaign_name ?? null
  const subjectStatus = bookRow?.status ?? summary?.status ?? null
  const subjectMarkets = useMemo(() => Object.keys(intel.data?.audience?.markets ?? {}), [intel.data])
  useEffect(() => {
    if (!selectedId) return
    publishCampaignSubject({ campaignId: selectedId, name: subjectName, status: subjectStatus, markets: subjectMarkets, timezone: f.tz })
  }, [selectedId, subjectName, subjectStatus, subjectMarkets, f.tz])

  /* ── inspector navigation ── */
  const openCtx = useCallback((next: InspectorCtx, push = true) => {
    setCtxStack((s) => (push && ctx.kind !== next.kind ? [...s, ctx].slice(-4) : s))
    setCtx(next)
    setInspPref(true)
    writeUrl({ ccx: ctxParam(next) })
  }, [ctx, writeUrl])
  const back = ctxStack.length ? () => { const prev = ctxStack[ctxStack.length - 1]; setCtxStack((s) => s.slice(0, -1)); setCtx(prev); writeUrl({ ccx: ctxParam(prev) }) } : null

  const onRiver = useCallback((k: RiverKey) => {
    const map: Record<RiverKey, InspectorCtx> = {
      audience: { kind: 'audience' }, eligible: { kind: 'audience' }, planned: { kind: 'audience' }, queued: { kind: 'queue' },
      sent: { kind: 'delivery' }, delivered: { kind: 'delivery' }, replied: { kind: 'replies' }, opportunity: { kind: 'outcomes' },
    }
    openCtx(map[k])
  }, [openCtx])
  const onGate = useCallback((g: GateKey) => openCtx({ kind: 'gate', gate: g }), [openCtx])
  const onSender = useCallback((phone: string) => openCtx({ kind: 'sender', phone }), [openCtx])
  const onBatch = useCallback((b: Batch) => openCtx({ kind: 'batch', batch: b }), [openCtx])
  const onReplies = useCallback((bucket?: ReplyBucketKey) => openCtx({ kind: 'replies', bucket: bucket ?? null }), [openCtx])
  const onShowTargets = useCallback((status: TargetStatus, reason?: string | null) => {
    setTargetStatus(status)
    setTargetReason(reason ?? null)
    setMode('targets')
  }, [setMode])
  const onTarget = useCallback((row: CockpitTargetRow) => {
    openCtx({ kind: 'target', row })
    // linked panes (Map, Entity Graph, Deal Intelligence) follow the seller
    setPropertyLocator({ propertyId: row.property_id, masterOwnerId: row.master_owner_id, prospectId: row.prospect_id, threadKey: row.thread_key, address: row.property })
  }, [openCtx])

  const openMap = useCallback(async () => {
    if (!selectedId) return
    try {
      const cohort = await fetchCohortPoints(selectedId)
      const name = subjectName ?? 'this campaign'
      if (!writeMapFocusSet({ label: cohort.basis === 'source_cohort' ? `in ${name}` : `in ${name}’s audience`, tone: 'property', points: cohort.points.map((p) => ({ lat: p.lat, lng: p.lng, id: p.id, label: p.label })) })) {
        emitNotification({ title: 'Nothing to show on the Map', detail: 'None of these properties have map coordinates.', severity: 'info' })
        return
      }
      pushRoutePath('/map')
    } catch {
      emitNotification({ title: 'The cohort couldn’t be loaded', detail: 'Nothing was changed.', severity: 'warning' })
    }
  }, [selectedId, subjectName])

  /* ── actions: the existing path only; send-affecting ones state effects first ── */
  const refreshCore = liveCore.refresh
  const refreshIntel = liveIntel.refresh
  const refreshBook = liveBook.refresh
  const run = useCallback(async (action: string, c: CampaignSummary, payload?: Record<string, unknown>) => {
    setBusy(action)
    try {
      await onAction(action, c, payload)
    } finally {
      setBusy(null)
      refreshCore()
      refreshBook()
    }
  }, [onAction, refreshCore, refreshBook])

  const request = useCallback((action: string) => {
    if (demoOn) { emitNotification({ title: 'Demo data', detail: 'Actions are off while demo data is on screen. Nothing was changed.', severity: 'info' }); return }
    if (!summary) return
    if (action === 'refresh') { onRefresh(); refreshCore(); refreshIntel(); refreshBook(); return }
    if (action === 'activate') sound.ui.tap()
    const spec = actionSpec(action, summary, input)
    if (spec) { setConfirm({ action, campaign: summary, spec }); return }
    void run(action, summary)
  }, [summary, input, run, onRefresh, refreshCore, refreshIntel, refreshBook, demoOn])

  const { primary, secondary, more } = useMemo(() => {
    if (!summary) return { primary: null as HeroAction | null, secondary: null as HeroAction | null, more: [] as LCMenuEntry[] }
    const defs = getDetailActions(summary).map((d) => d.id)
    const firstId = PRIMARY_ORDER.find((id) => defs.includes(id)) ?? null
    const p: HeroAction | null = firstId ? { id: firstId, label: ACTION_LABEL[firstId] ?? firstId, variant: firstId === 'pause' ? 'secondary' : 'primary' } : null
    const s: HeroAction | null = defs.includes('activate') ? { id: 'activate', label: ACTION_LABEL.activate, variant: 'secondary' } : null
    const rest = defs.filter((id) => id !== firstId && id !== 'activate')
    const items = lcMenu(
      rest.filter((id) => id !== 'archive').map((id) => ({ id, label: ACTION_LABEL[id] ?? id, onSelect: () => request(id) })),
      [
        { id: 'edit', label: ACTION_LABEL.edit, hint: 'Audience, message, schedule, capacity', onSelect: () => request('edit') },
        ...(defs.includes('duplicate') || firstId === 'duplicate' ? [] : [{ id: 'duplicate', label: ACTION_LABEL.duplicate, onSelect: () => request('duplicate') }]),
        { id: 'sync_metrics', label: ACTION_LABEL.sync_metrics, hint: 'Recompute the stored counters', onSelect: () => request('sync_metrics') },
        { id: 'refresh', label: ACTION_LABEL.refresh, onSelect: () => request('refresh') },
      ],
      rest.includes('archive') ? [{ id: 'archive', label: ACTION_LABEL.archive, tone: 'danger' as const, onSelect: () => request('archive') }] : [],
    )
    return { primary: p, secondary: s, more: items }
  }, [summary, request])

  /* ── derived view models ── */
  const activity = useMemo(() => warActivity(input, {
    openBatch: (b) => onBatch(b),
    openReply: () => onReplies(),
    openGate: (g) => onGate(g),
    openOutcomes: () => openCtx({ kind: 'outcomes' }),
  }), [input, onBatch, onReplies, onGate, openCtx])
  const steps = useMemo(() => audienceSteps(input), [input])
  const held = useMemo(() => heldReasons(input), [input])
  const segments = useMemo(() => replySegments(f.buckets), [f.buckets])
  const funnel = useMemo(() => businessFunnel(input), [input])
  const moneyRows = useMemo(() => moneyLines(intel.data), [intel.data])
  const header = useMemo(() => bookLine(allRows), [allRows])

  const name = subjectName ?? 'Campaign'
  const parts = nameParts(name, f.sourceKind, f.explicit)
  const specs = [
    { key: 'channel', text: 'SMS' },
    ...(intel.data?.routing?.length ? [{ key: 'market', text: intel.data.routing.length > 1 ? `${intel.data.routing[0].market} +${intel.data.routing.length - 1} markets` : intel.data.routing[0].market }] : []),
    ...(f.tz ? [{ key: 'zone', text: `${zoneFamily(f.tz)} time`, hint: f.tz }] : []),
    { key: 'source', text: sourceWords(f.sourceKind) + (f.explicit ? ` · ${nf(f.explicit)} selected` : core.data?.lineage.filters.length ? ` · ${core.data.lineage.filters.length} filter${core.data.lineage.filters.length === 1 ? '' : 's'}` : '') },
    ...(pace.dayIndex && live ? [{ key: 'day', text: `Day ${nf(pace.dayIndex)}` }] : []),
  ]
  const pinAction = mission.key === 'missed_schedule' && summary ? { label: 'Reschedule', onClick: () => request('reschedule') } : null
  const ready = Boolean(book.data || model) && (!selectedId || Boolean(core.data || core.error)) && (!selectedId || Boolean(intel.data || intel.error))
  const inspMode: 'dock' | 'float' = dock ? 'dock' : 'float'
  const bodyDocked = inspOpen && dock && Boolean(selectedId)

  // the rail is loading until either read answers; it failed only when both did
  const railLoading = !book.data && !model && !(book.error && failed)
  const railFailed = !book.data && !model && Boolean(book.error) && failed
  const rail = (
    <MissionRail
      groups={groups}
      selectedId={selectedId}
      onSelect={select}
      loading={railLoading}
      failed={railFailed}
      onRetry={() => { onRetry(); book.refresh() }}
      total={allRows.length}
      onClose={narrow ? () => setRailOpen(false) : undefined}
    />
  )

  return (
    <div ref={rootRef} className="cc3" data-ready={ready ? '1' : '0'} data-layout={dock ? 'dock' : narrow ? 'narrow' : 'float'} data-mode={mode} data-demo={demoOn ? '' : undefined}>
      <header className="cc3-top">
        <div className="cc3-top__title">
          <h1>Campaign Command</h1>
          <p className="cc3-top__line">
            {header.length ? header.map((x) => <span key={x.key} data-tone={x.tone}>{x.text}</span>) : <span>{loading && !book.data ? 'Reading campaigns…' : 'No campaigns'}</span>}
            {book.data ? <LCLive live={!book.error} stale={Boolean(book.error)} updatedAt={book.at} label={book.error ? 'Delayed' : 'Live'} /> : null}
          </p>
        </div>
        {demoOn ? <p className="cc3-demo" role="status"><b>Demo data</b>development only · not production · every action is off</p> : null}
        <LCSearch value={query} onChange={setQuery} label="Search campaigns" placeholder="Search campaigns, markets, states" className="cc3-top__search" />
        <LCButton variant="primary" icon="spark" onClick={onNew}>New campaign</LCButton>
      </header>

      <div className="cc3-body" data-docked={bodyDocked ? '' : undefined}>
        {narrow ? (railOpen ? (
          <>
            <button type="button" className="cc3-scrim" aria-label="Close campaigns" onClick={() => setRailOpen(false)} />
            <div className="cc3-railslot is-drawer">{rail}</div>
          </>
        ) : null) : <div className="cc3-railslot">{rail}</div>}

        <main className="cc3-room" aria-label={selectedId ? name : 'Campaign Command'}>
          <div className="cc3-room__scroll lc-scroll" data-cc3-scroll>
            {!selectedId || (!bookRow && !summary && !core.data) ? (
              selectedId && !core.error ? (
                <div className="cc3-room__loading" aria-busy="true">
                  <LCSkeleton shape="lines" count={3} label="Campaign loading" />
                  <LCSkeleton shape="block" height={180} />
                  <div className="cc3-grid is-two"><LCSkeleton shape="block" height={220} /><LCSkeleton shape="block" height={220} /></div>
                </div>
              ) : (
                <div className="cc3-room__empty">
                  {railLoading ? <LCSkeleton shape="lines" count={3} label="Campaigns loading" /> : <LCEmpty title={ids.length ? 'Select a campaign' : railFailed ? 'Campaigns didn’t load' : 'No campaigns yet'} body={ids.length ? 'Pick one from the mission rail.' : railFailed ? 'Nothing older is available to show.' : 'Create one to start an outbound execution.'} action={!ids.length && !railFailed ? { label: 'New campaign', onClick: onNew } : railFailed ? { label: 'Try again', onClick: () => { onRetry(); book.refresh() } } : undefined} />}
                </div>
              )
            ) : (
              <>
                <WarHero
                  title={parts.title}
                  eyebrow={parts.eyebrow}
                  mission={mission}
                  specs={specs}
                  next={next}
                  primary={demoOn ? { id: 'demo', label: 'Actions off · demo', variant: 'secondary', disabled: true, reason: 'Demo data — no action can run.' } : primary ?? (summary ? null : { id: 'loading', label: 'Controls loading…', variant: 'secondary', disabled: true, reason: 'Campaign controls arrive with the campaign list.' })}
                  secondary={demoOn ? null : secondary}
                  more={demoOn ? [] : more}
                  busy={busy}
                  onAction={request}
                  inspectorOpen={inspOpen}
                  onToggleInspector={() => setInspPref(!inspOpen)}
                  onOpenRail={() => setRailOpen(true)}
                  showRailToggle={narrow}
                />

                {core.error && !core.data ? <p className="cc3-alert" data-tone="attn">Live execution state didn’t load — showing the book’s figures. ({core.error})</p> : null}

                <section className="cc3-flow" aria-label="Execution river and gates">
                  <ExecutionRiver nodes={river.nodes} pin={river.pin} selected={null} onSelect={onRiver} onPin={onGate} pinAction={pinAction} />
                  <GateRail gates={gates} stopping={stopping?.key ?? null} selected={ctx.kind === 'gate' && inspOpen ? ctx.gate : null} onSelect={onGate} />
                </section>

                <LCTabs
                  label="Campaign room mode"
                  className="cc3-modes"
                  value={mode}
                  onChange={(m) => setMode(m)}
                  items={[
                    { id: 'overview', label: 'Overview' },
                    { id: 'execution', label: 'Execution', tone: stopping && stopping.state === 'block' ? 'attn' : undefined },
                    { id: 'targets', label: 'Targets', count: f.total },
                    { id: 'activity', label: 'Activity' },
                    { id: 'performance', label: 'Performance' },
                  ]}
                />

                {mode === 'overview' ? (
                  <div className="cc3-overview">
                    <div className="cc3-grid is-two">
                      <TimePlane
                        tz={f.tz}
                        track={track}
                        zones={intel.data?.audience?.zones ?? null}
                        pace={pace}
                        buffer={{ live: f.queueLive, target: intel.data?.feeder.buffer_target ?? core.data?.feed?.buffer_target ?? 150, chunk: intel.data?.feeder.chunk ?? core.data?.feed?.chunk ?? 100, remaining: f.ready, overdue: f.overdue }}
                        system={system}
                        lastRefill={f.feeder?.last_refill_at ?? null}
                        lastPass={f.feeder ? { at: f.feeder.at, inserted: f.feeder.inserted, why: river.pin && river.pin.state === 'blocked' && river.pin.after === 'eligible' ? `Placed none: ${river.pin.detail}` : null } : null}
                        onOpen={() => setMode('execution')}
                      />
                      <OutcomePlane replied={f.replied} delivered={f.delivered} segments={segments} funnel={funnel} money={moneyRows} loading={intel.loading} onOpenReplies={onReplies} onOpenOutcomes={() => openCtx({ kind: 'outcomes' })} />
                    </div>
                    <div className="cc3-grid is-three">
                      <AudiencePlane steps={steps} held={held} onOpen={() => openCtx({ kind: 'audience' })} onReason={(code) => onShowTargets('blocked', code)} />
                      <FleetPlane intel={intel.data} onSender={onSender} onOpen={() => openCtx({ kind: 'senders' })} />
                      <GeoPlane campaignId={selectedId} campaignName={name} demo={demoOn ? (demo?.geos[selectedId] ?? null) : undefined} />
                    </div>
                    <LatestActivity events={activity} tz={f.tz} loading={intel.loading && !activity.length} onAll={() => setMode('activity')} />
                  </div>
                ) : null}
                {mode === 'execution' ? <ExecutionMode input={input} gates={gates} stopping={stopping?.key ?? null} caps={caps} pace={pace} now={now} onGate={onGate} onSender={onSender} onBatch={onBatch} /> : null}
                {mode === 'targets' ? (
                  <TargetsMode
                    campaignId={selectedId}
                    tz={f.tz}
                    counts={{ all: f.total, planned: f.planned, ready: f.ready, blocked: f.held }}
                    heldReasons={held}
                    status={targetStatus}
                    reason={targetReason}
                    onStatus={(s) => { setTargetStatus(s); setTargetReason(null) }}
                    onReason={setTargetReason}
                    activeId={ctx.kind === 'target' ? ctx.row.id : null}
                    onActivate={onTarget}
                    now={now}
                    demoRows={demoOn ? (demo ? demo.targets(selectedId) : []) : undefined}
                  />
                ) : null}
                {mode === 'activity' ? <ActivityMode events={activity} intel={intel.data} tz={f.tz} now={now} loading={intel.loading} onBatch={onBatch} /> : null}
                {mode === 'performance' ? <PerformanceMode input={input} onSender={onSender} /> : null}
              </>
            )}
          </div>
        </main>

        {selectedId ? (
          <WarInspector
            open={inspOpen}
            mode={inspMode}
            ctx={ctx}
            input={input}
            now={now}
            mission={mission}
            gates={gates}
            h={{
              onClose: () => setInspPref(false),
              onBack: back,
              onContext: (c) => openCtx(c),
              onShowTargets,
              onAction: request,
              onOpenMap: () => { void openMap() },
            }}
          />
        ) : null}
      </div>

      {confirm ? (
        <LCConfirm
          open
          onOpenChange={(o) => { if (!o) setConfirm(null) }}
          title={confirm.spec.title}
          effects={confirm.spec.effects}
          confirmLabel={confirm.spec.confirmLabel}
          tone={confirm.spec.tone}
          onConfirm={async () => {
            const { action, campaign } = confirm
            // `confirmed` tells the action path this dialog already asked
            await run(action, campaign, { confirmed: true })
          }}
        />
      ) : null}
    </div>
  )
}

export default CampaignWarRoom
