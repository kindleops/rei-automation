/**
 * ANALYTICS 4.0 · THE INTELLIGENCE LAB (desktop).
 *
 *   Level 0  the liquid environment (the desktop backdrop under the pane)
 *   Level 1  the workspace: command bar · lenses · the active slice
 *   Level 2  analytical planes — hero graph, map, funnel / flow — each a
 *            different shape and depth, never a grid of equal cards
 *   Level 3  the contextual inspector (definition, datum, market, stage …)
 *   Level 4  the exact records behind a number
 *   Level 5  popovers: explorer, views, definitions
 *
 * One analytical query state (in the URL), one server registry and engine,
 * one query store: two sections asking the same question share one request.
 * Composition follows the PANE (container queries on .ix), from ~480 px to an
 * ultrawide; the phone keeps its own Analytics surface.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DimensionDef, LabOverview, MetricDef } from '../../../domain/analytics/analytics-lab-api'
import { LCError, cx } from '../../../shared/lc'
import { useClaimedKeys } from '../../../shared/lc/keys'
import { sound } from '../../../shared/sound'
import type { LabShared, RecordsRequest, Subject } from './intel-context'
import { LabContextReact } from './intel-context'
import { intelStore, paths, useIntel } from './intel-data'
import { useWidth } from './intel-hooks'
import type { IntelRegistry } from './intel-model'
import { HERO_METRICS } from './intel-model'
import type { IntelActions } from './intel-state'
import { serverContext, useIntelContext } from './intel-state'
import { IntelCohortBar, IntelCommandBar, IntelLenses } from './IntelChrome'
import { IntelHero } from './IntelHero'
import { IntelRibbon } from './IntelRibbon'
import { IntelFunnel } from './IntelFunnel'
import { IntelGeo } from './IntelGeo'
import { IntelPipeline } from './IntelPipeline'
import { IntelMoney } from './IntelMoney'
import { IntelChanges } from './IntelChanges'
import { IntelComms } from './IntelComms'
import { IntelAutomation } from './IntelAutomation'
import { IntelCampaigns } from './IntelCampaigns'
import { IntelBuyers, IntelGrowth, IntelGrowthLine } from './IntelBuyers'
import { IntelInspector } from './IntelInspector'
import { IntelRecords } from './IntelRecords'
import { GoalsLens } from '../goals/GoalsLens'
import './intelligence.css'

const LIVE_REFRESH_MS = 90_000
const DOCK_AT = 1500

/**
 * Analytics stays almost silent: changing the period, the comparison, the
 * breadcrumb, the cohort or a filter selects; opening and closing the
 * inspector or the records drawer opens / closes; an operator's read that
 * fails errs. Nothing sounds on chart draw, hover, refresh or live updates.
 */
const SELECTING: ReadonlyArray<keyof IntelActions> = ['setRange', 'setCompare', 'addFilter', 'removeFilter', 'pushSegment', 'removeSegment', 'popSegmentTo', 'setCohort', 'clearSlice']
function withSound(act: IntelActions, onAction: () => void): IntelActions {
  const out = { ...act }
  for (const k of SELECTING) {
    const fn = act[k] as (...a: unknown[]) => void
    ;(out as Record<string, unknown>)[k] = (...a: unknown[]) => { onAction(); sound.ui.select(); fn(...a) }
  }
  out.set = (patch) => { onAction(); act.set(patch) }
  return out
}

/** When the operator last changed the question: an error soon after it is theirs to hear. */
let lastActedAt = 0
const markActed = () => { lastActedAt = Date.now() }

export function IntelligenceLab() {
  const [ctx, rawAct] = useIntelContext()
  const act = useMemo(() => withSound(rawAct, markActed), [rawAct])
  const reg = useIntel<IntelRegistry>(paths.registry(), 30 * 60_000)
  const registry = reg.data
  // the overview is read for a FIXED metric: switching the hero metric never re-reads it
  const ovPath = paths.overview(serverContext(ctx, { metric: 'reply_rate', groupBy: null }))
  const ov = useIntel<LabOverview>(registry ? ovPath : null)
  const overview = ov.data

  const defs = useMemo<Record<string, MetricDef>>(() => Object.fromEntries((registry?.metrics || []).map((m) => [m.id, m])), [registry])
  const dims = useMemo<Record<string, DimensionDef>>(() => registry?.dimensions || {}, [registry])

  // the inspector is a stack (back step), the records drawer one cohort
  const [stack, setStack] = useState<Subject[]>([])
  const [rec, setRec] = useState<RecordsRequest | null>(null)
  const open = stack.length > 0
  const inspect = useCallback((s: Subject) => {
    if (!open) sound.panel.open()
    markActed()
    setStack((st) => (st.length && JSON.stringify(st[st.length - 1]) === JSON.stringify(s) ? st : [...st.slice(-7), s]))
  }, [open])
  const records = useCallback((r: RecordsRequest) => { sound.panel.open(); markActed(); setRec(r) }, [])
  const closeInspector = useCallback(() => { sound.panel.close(); setStack([]) }, [])
  const closeRecords = useCallback(() => { sound.panel.close(); setRec(null) }, [])

  // an error the operator caused (within a minute of changing the question) is audible once; a background refresh never is
  const sounded = useRef<string | null>(null)
  useEffect(() => {
    if (!ov.error || sounded.current === ov.error) return
    if (Date.now() - lastActedAt > 60_000) return
    sounded.current = ov.error
    sound.outcome.error()
  }, [ov.error])

  // LIVE: a window that touches now re-reads every 90 s while the tab is visible (money is current-state and refreshes on its own TTL)
  // the server resolves the period against now: a window whose end is the data's own "as of" is live
  const live = overview ? Date.parse(overview.period.end) >= Date.parse(overview.dataAsOf || overview.period.end) - 10 * 60_000 : ctx.range.preset !== 'custom'
  useEffect(() => {
    if (!live || !registry) return
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') intelStore.reload(ovPath) }, LIVE_REFRESH_MS)
    return () => window.clearInterval(t)
  }, [live, ovPath, registry])

  const [rootRef, width] = useWidth<HTMLDivElement>()
  const mode: 'float' | 'dock' = width >= DOCK_AT ? 'dock' : 'float'
  // keys the Lab owns while mounted: arrows / Home / End / PageUp / PageDown on a focused chart, Esc for its own layers
  useClaimedKeys(['Escape'], Boolean(stack.length || rec))

  const shared: LabShared | null = registry ? {
    ctx, act, registry, defs, dims, overview: overview || null, refreshing: Boolean(ov.loading && overview), inspect, records,
  } : null
  const updatedAt = overview?.dataAsOf ? Date.parse(overview.dataAsOf) : null

  return (
    <div ref={rootRef} className={cx('ix', `lens-${ctx.lens}`, stack.length && `has-inspector is-${mode}`)} data-lens={ctx.lens}>
      <div className="ix__field" aria-hidden="true" />
      {!shared ? (
        <div className="ix__boot">
          {reg.error ? <LCError what="Analytics couldn’t load its definitions" detail={reg.error} onRetry={reg.reload} /> : <div className="ix__bootrows" aria-busy="true"><i /><i /><i /><span>Reading the machine’s definitions…</span></div>}
        </div>
      ) : (
        <LabContextReact.Provider value={shared}>
          <IntelCommandBar live={live} updatedAt={updatedAt} loading={ov.loading} onRefresh={() => intelStore.reload(ovPath)} onFilters={() => inspect({ kind: 'filters' })} />
          <IntelLenses />
          <IntelCohortBar onFilters={() => inspect({ kind: 'filters' })} />
          <div className="ix__body">
            <main className="ix__canvas lc-scroll" aria-label={`Analytics · ${ctx.lens}`}>
              {ov.error && !overview ? (
                <div className="ix__failed"><LCError what="The period’s analytics didn’t load — nothing is shown rather than estimates" detail={ov.error} onRetry={ov.reload} /></div>
              ) : <Lens lens={ctx.lens} />}
            </main>
            <IntelInspector
              subject={stack[stack.length - 1] || null}
              canBack={stack.length > 1}
              onBack={() => setStack((s) => s.slice(0, -1))}
              onClose={closeInspector}
              mode={mode}
              onInspect={inspect}
            />
          </div>
          {rec ? <IntelRecords cohort={rec.cohort} title={rec.title} onClose={closeRecords} /> : null}
        </LabContextReact.Provider>
      )}
    </div>
  )
}

function Lens({ lens }: { lens: string }) {
  switch (lens) {
    case 'acquisition':
      return (
        <div className="ix-compose is-acq">
          <div className="ix-band is-lead">
            <IntelHero variant="lens" metrics={['sellers_reached', 'reached_replied', 'reply_rate', 'interest_rate', 'interested_sellers', 'opportunity_rate', 'opportunities_created', 'opt_out_rate', 'median_reply_latency']} />
            <IntelChanges variant="lens" />
            <IntelFunnel variant="lens" />
          </div>
        </div>
      )
    case 'pipeline':
      return <div className="ix-compose is-single"><IntelPipeline variant="lens" /><IntelMoney variant="overview" /></div>
    case 'campaigns':
      return <div className="ix-compose is-single"><IntelCampaigns variant="lens" /></div>
    case 'communications':
      return <div className="ix-compose is-single"><IntelComms variant="lens" /></div>
    case 'geography':
      return <div className="ix-compose is-single"><IntelGeo variant="lens" /><IntelBuyers variant="overview" /></div>
    case 'automation':
      return <div className="ix-compose is-single"><IntelAutomation variant="lens" /></div>
    case 'financial':
      return <div className="ix-compose is-single"><IntelMoney variant="lens" /><IntelPipeline variant="overview" /></div>
    case 'buyers':
      return <div className="ix-compose is-single"><IntelBuyers variant="lens" /></div>
    case 'growth':
      return <div className="ix-compose is-single"><IntelGrowth /></div>
    case 'goals':
      return <div className="ix-compose is-single"><GoalsLens /></div>
    default:
      return <Overview />
  }
}

/** THE OVERVIEW — mixed shapes and depths, composed in BANDS so a tall plane
 * never leaves a hole beside a short one: the wide graph plane and the funnel
 * beside the thin period instrument; the stage band across the whole width;
 * the spatial screen beside the money ledger; deltas beside the delivery
 * flow; the dense campaign region across; automation beside buyers and the
 * external line. Below ~1100 px of pane every band folds into one column in
 * reading order (hero, period, funnel, …). */
function Overview() {
  return (
    <div className="ix-compose is-overview">
      <div className="ix-band is-lead">
        <IntelHero variant="overview" metrics={HERO_METRICS} />
        <IntelRibbon />
        <IntelFunnel />
      </div>
      <div className="ix-band is-wide"><IntelPipeline /></div>
      <div className="ix-band is-where">
        <IntelGeo />
        <IntelMoney />
      </div>
      <div className="ix-band">
        <IntelChanges />
        <IntelComms />
      </div>
      <div className="ix-band is-wide"><IntelCampaigns /></div>
      <div className="ix-band is-tail">
        <IntelAutomation />
        <IntelBuyers />
        <IntelGrowthLine />
      </div>
    </div>
  )
}

export default IntelligenceLab
