import { useCallback, useMemo, useState, type KeyboardEvent } from 'react'
import { pushRoutePath } from '../../../app/router'
import { useDealIntelligenceDossier } from '../../../domain/deal-intelligence/useDealIntelligenceDossier'
import { useAppInstance } from '../../../modules/desktop/workspace/instance-context'
import { Icon } from '../../../shared/icons'
import { cx, LCButton, LCEmpty, LCError, LCSkeleton } from '../../../shared/lc'
import { useClaimedKeys } from '../../../shared/lc/keys'
import { ago, dateShort } from './di-format'
import { diLinks } from './di-links'
import {
  availableOf, confidenceModel, decisionState, economicBridge, evidenceGaps, gateViews, offerFigures, offerTrack, sellerIdentity,
  spectrumModel, thesis, underwritingStatus, type EvidenceFamily, type RecordCategoryKey,
} from './di-model'
import { fetchKey, hasSubject, readRecents, type DiSubject } from './di-subject'
import { DI_MODES, type DiMode, type DiSelection } from './di-types'
import { DiInspector } from './inspector/DiInspector'
import { EvidenceMode } from './modes/EvidenceMode'
import { ModelMode } from './modes/ModelMode'
import { RecordMode } from './modes/RecordMode'
import { ScenarioMode } from './modes/ScenarioMode'
import { CommandStrip } from './planes/CommandStrip'
import { ConfidencePlane, GatePlane } from './planes/ConfidenceGates'
import { DecisionPlane } from './planes/DecisionPlane'
import { PropertyPlane } from './planes/PropertyPlane'
import { ProspectPlane } from './planes/ProspectPlane'
import { SystemPlane } from './planes/SystemPlane'
import { MoneyPlane } from './planes/ThesisMoney'
import { NegotiationPlane } from './planes/NegotiationPlane'
import { useClock } from './useClock'
import { useDecisionRoom, useDealStory } from './useDecisionRoom'
import { useDecisionSubject } from './useDecisionSubject'
import { useWidth } from './useWidth'
import './di-desktop.css'

/** The inspector docks beside the work from this app width; below it, it floats over it on selection. */
const DOCK_AT = 1240
const MODE_KEYS = DI_MODES.map((m) => m.key)

export interface DealIntelligenceDesktopProps {
  /**
   * An explicit subject, for a host that embeds the surface. When given it
   * wins over the pane location and linked context; when omitted the surface
   * reads its pane's location (?property_id= / ?property= / ?thread_key= /
   * ?opportunity_id=) and, while the pane follows, the property locator.
   */
  subject?: DiSubject | null
}

/**
 * DEAL INTELLIGENCE — the acquisition decision room (desktop).
 *
 * The phone's product (identity, decision, spectrum, evidence, record, model)
 * with the room a desktop has: the decision, its economics and its
 * constraints at once, a contextual inspector, and Evidence / Record / Model
 * / Scenario as working modes. Read-only except the canonical engine re-run
 * (behind a confirm that states its effect). Nothing here sends anything.
 */
export function DealIntelligenceDesktop({ subject: explicit }: DealIntelligenceDesktopProps) {
  const { subject, mode, setMode, select, follows, pinned, pinLabel } = useDecisionSubject(explicit)
  const { visible } = useAppInstance()
  const room = useDecisionRoom(subject, { visible })
  const d = room.data
  const now = useClock()
  const [rootRef, rootWidth] = useWidth<HTMLDivElement>()
  const dock = rootWidth >= DOCK_AT
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [floatDefault, setFloatDefault] = useState(false)
  const [selection, setSelection] = useState<DiSelection | null>(null)
  const [family, setFamily] = useState<EvidenceFamily>('comps')
  const [category, setCategory] = useState<RecordCategoryKey>('valuation')
  const [focusWithin, setFocusWithin] = useState(false)
  useClaimedKeys(MODE_KEYS, focusWithin)

  // A new subject starts with nothing selected — never inspect one property's comp under another's header.
  const key = fetchKey(subject)
  const [seenKey, setSeenKey] = useState(key)
  if (seenKey !== key) {
    setSeenKey(key)
    setSelection(null)
    setFloatDefault(false)
  }

  const story = useDealStory(room.current ? d?.pipeline?.opportunityId : null)

  // The canonical engine run (run-engine route), reused from the phone's hook
  // with its dossier fetch disabled: only the run path is used here.
  const threadKey = d?.contact?.threadKey ?? d?.pipeline?.threadKey ?? subject.threadKey ?? undefined
  const engine = useDealIntelligenceDossier(
    threadKey ? { threadKey, propertyId: d?.subject.propertyId ?? subject.propertyId ?? undefined } : null,
    { enabled: false },
  )
  const [wasRunning, setWasRunning] = useState(false)
  if (engine.engineRunning !== wasRunning) {
    setWasRunning(engine.engineRunning)
    if (wasRunning && !engine.engineRunning) room.refresh()
  }
  const runEngine = useCallback(() => { void engine.runDecisionEngine() }, [engine])

  const model = useMemo(() => {
    if (!d) return null
    const figures = offerFigures(d)
    return {
      state: decisionState(d),
      figures,
      spectrum: spectrumModel(d),
      track: offerTrack(figures),
      conf: confidenceModel(d),
      gates: gateViews(d),
      bridge: economicBridge(d),
      gaps: evidenceGaps(d),
      thesis: thesis(d),
      identity: sellerIdentity(d),
      links: diLinks(d),
    }
  }, [d])

  const status = underwritingStatus({ d: room.current ? d : null, pending: room.pending, error: room.error, recomputing: engine.engineRunning })
  const pick = useCallback((s: DiSelection) => {
    setSelection(s)
    if (s.type === 'comp' || s.type === 'doc' || s.type === 'loan') setInspectorOpen(true)
  }, [])
  const clear = useCallback(() => setSelection(null), [])
  const openMode = useCallback((m: DiMode) => { setMode(m); setSelection(null) }, [setMode])
  const changeMode = useCallback((m: DiMode) => { setMode(m); setSelection(null); setFloatDefault(false) }, [setMode])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
    const t = e.target as HTMLElement
    if (t.closest('input, textarea, select, [contenteditable="true"], [role="slider"]')) return
    const m = DI_MODES.find((x) => x.key === e.key)
    if (m && d) { e.preventDefault(); changeMode(m.id) }
  }

  const inspectorVisible = dock ? inspectorOpen : selection !== null || floatDefault
  const decisionInInspector = dock && inspectorOpen && mode === 'decision'

  /* ── states before there is a decision on screen ─────────────────────── */
  if (!hasSubject(subject)) return <NoSubject onPick={select} now={now} rootRef={rootRef} />
  // The previous subject's decision may stay on screen (dimmed) only while the
  // next one is loading — never after the next one failed.
  if (!d || (!room.current && !room.pending)) {
    return (
      <div className="dr is-boot" ref={rootRef}>
        <div className="dr-env" aria-hidden="true" />
        {room.error ? (
          <div className="dr-boot">
            {room.error === 'property_not_found' || room.error === 'deal_decision_empty'
              ? <LCEmpty icon="home" title="No property record to underwrite" body="This subject has no property, score or parcel record." />
              : <LCError what="Deal Intelligence couldn’t load this decision" onRetry={room.refresh} detail={room.error} />}
          </div>
        ) : (
          <div className="dr-boot" aria-busy="true">
            <div className="dr-boot__strip"><LCSkeleton shape="lines" count={2} label="Loading identity" /></div>
            <div className="dr-boot__grid">
              <LCSkeleton shape="block" height={260} label="Loading the decision" />
              <LCSkeleton shape="block" height={260} />
              <LCSkeleton shape="chart" height={140} />
              <LCSkeleton shape="rows" count={4} />
            </div>
          </div>
        )}
      </div>
    )
  }

  const m = model!
  const dec = availableOf(d)
  const prospect = (variant: 'inline' | 'column') => (
    <ProspectPlane d={d} identity={m.identity} story={story.story} storyLoading={story.loading} gaps={m.gaps} selection={selection} onSelect={pick} links={m.links} now={now} variant={variant} />
  )
  const criticalRisk = d.risks.some((r) => r.severity === 'critical')

  return (
    <div
      ref={rootRef}
      className={cx('dr', room.pending && 'is-pending', dock && 'is-docked', inspectorVisible && 'has-inspector')}
      data-mode={mode}
      data-tone={m.state.tone}
      onKeyDown={onKeyDown}
      onFocus={() => setFocusWithin(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusWithin(false) }}
    >
      <div className="dr-env" aria-hidden="true" />
      <CommandStrip
        d={d}
        subject={subject}
        pending={room.pending}
        identity={m.identity}
        state={m.state}
        status={status}
        mode={mode}
        onMode={changeMode}
        links={m.links}
        link={{ follows, pinned, pinLabel }}
        inspector={{ docked: dock, open: inspectorVisible, onToggle: () => (dock ? setInspectorOpen((o) => !o) : selection ? clear() : setFloatDefault((o) => !o)) }}
        onRefresh={room.refresh}
        refreshing={room.refreshing}
        now={now}
        criticalRisk={criticalRisk}
      />
      {room.current && room.error ? (
        <div className="dr-banner"><LCError compact what="The latest re-read failed" staleSince={room.loadedAt} onRetry={room.refresh} detail={room.error} /></div>
      ) : null}
      <div className="dr-body">
        <main className="dr-main lc-scroll" aria-busy={room.pending || undefined} aria-label="Deal Intelligence">
          <div className="dr-main__inner">
            {mode === 'decision' ? (
              <div className={cx('dr-decision', decisionInInspector && 'has-prospect-docked')}>
                <div className="dr-area-hero">
                  <DecisionPlane d={d} state={m.state} figures={m.figures} spectrum={m.spectrum} track={m.track} conf={m.conf} thesis={m.thesis} selection={selection} onSelect={pick} now={now} engine={{ canRun: Boolean(threadKey), running: engine.engineRunning, onRun: runEngine }} />
                </div>
                <div className="dr-area-prop"><PropertyPlane d={d} onOpenMedia={() => pick({ type: 'media' })} /></div>
                <div className="dr-area-money"><MoneyPlane d={d} bridge={m.bridge} f={m.figures} selection={selection} onSelect={pick} />{d.offer?.negotiationV3 ? <NegotiationPlane n={d.offer.negotiationV3} /> : null}</div>
                <div className="dr-area-conf"><ConfidencePlane model={m.conf} selection={selection} onSelect={pick} /></div>
                <div className="dr-area-gates"><GatePlane gates={m.gates} tierLabel={dec?.tierLabel ?? null} selection={selection} onSelect={pick} /></div>
                <div className="dr-area-system"><SystemPlane d={d} links={m.links} now={now} /></div>
                {!decisionInInspector ? <div className="dr-area-prospect">{prospect('inline')}</div> : null}
              </div>
            ) : null}
            {mode === 'evidence' ? <EvidenceMode d={d} family={family} onFamily={(f) => { setFamily(f); setSelection(null) }} selection={selection} onSelect={pick} links={m.links} now={now} /> : null}
            {mode === 'record' ? <RecordMode d={d} category={category} onCategory={(c) => { setCategory(c); setSelection(null) }} selection={selection} onSelect={pick} links={m.links} now={now} /> : null}
            {mode === 'model' ? (
              <ModelMode d={d} conf={m.conf} gates={m.gates} selection={selection} onSelect={pick} now={now}
                engine={{ canRun: Boolean(threadKey), running: engine.engineRunning, onRun: runEngine, error: engine.engineError, progress: engine.engineProgress }} />
            ) : null}
            {mode === 'scenario' ? <ScenarioMode d={d} /> : null}
            <footer className="dr-foot">
              <span>Engine {d.lineage.engineVersion ?? '—'} · {d.lineage.policyVersion ?? 'policy not recorded'}</span>
              {d.lineage.computedAt ? <span>analyzed {dateShort(d.lineage.computedAt, now)} ({ago(d.lineage.computedAt, now)})</span> : <span>never analyzed</span>}
              <span>read {room.loadedAt ? ago(new Date(room.loadedAt).toISOString(), now) : '—'}</span>
              <span>Read-only · re-run is the only write, behind a confirm</span>
            </footer>
          </div>
        </main>
        <DiInspector
          d={d}
          mode={mode}
          selection={selection}
          onSelect={pick}
          onClear={clear}
          open={inspectorVisible}
          onClose={() => { if (dock) { if (selection) clear(); else setInspectorOpen(false) } else { clear(); setFloatDefault(false) } }}
          dock={dock}
          defaultContent={prospect('column')}
          defaultTitle={mode === 'decision' ? 'Prospect intelligence' : mode === 'evidence' ? 'Evidence freshness' : mode === 'record' ? 'Record provenance' : 'Model provenance'}
          figures={m.figures}
          gates={m.gates}
          conf={m.conf}
          gaps={m.gaps}
          links={m.links}
          now={now}
          onOpenMode={openMode}
          onUnderwrite={(s) => { select(s); setMode('decision') }}
        />
      </div>
    </div>
  )
}

/* ── no subject: follow a selection, or reopen a recent one ───────────── */

function NoSubject({ onPick, now, rootRef }: { onPick: (s: DiSubject) => void; now: number; rootRef: (n: HTMLDivElement | null) => void }) {
  const [recents] = useState(readRecents)
  return (
    <div className="dr is-empty" ref={rootRef}>
      <div className="dr-env" aria-hidden="true" />
      <div className="dr-nosubject">
        <span className="dr-eyebrow">Deal Intelligence</span>
        <h1>Choose a subject to underwrite</h1>
        <p>Deal Intelligence follows your selection: pick a seller in Inbox, a deal in Pipeline or a property on the Map, and its decision, evidence and economics open here.</p>
        <div className="dr-nosubject__actions">
          <LCButton icon="inbox" onClick={() => pushRoutePath('/inbox')}>Inbox</LCButton>
          <LCButton icon="layers" onClick={() => pushRoutePath('/pipeline')}>Pipeline</LCButton>
          <LCButton icon="map" onClick={() => pushRoutePath('/map')}>Map</LCButton>
        </div>
        {recents.length ? (
          <div className="dr-recents">
            <span className="dr-eyebrow">Recently underwritten here</span>
            <ul>
              {recents.map((r) => (
                <li key={r.propertyId}>
                  <button type="button" onClick={() => onPick({ propertyId: r.propertyId, threadKey: r.threadKey, opportunityId: null, prospectId: null, masterOwnerId: null, address: r.address })}>
                    <Icon name="target" size={13} />
                    <span><b>{r.address?.split(',')[0] ?? r.propertyId}</b><em>{[r.seller, r.tier].filter(Boolean).join(' · ')}</em></span>
                    <small>{ago(new Date(r.at).toISOString(), now)}</small>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  )
}
