import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { AnimatePresence, LayoutGroup, motion } from 'framer-motion'
import { LCSegmented, cx, useLcReducedMotion } from '../../../../shared/lc'
import { isTerminal, progressOf, type ResearchView } from '../../model/research-model'
import { setUi, useAgentUi, type CenterTab, type RunSnapshot } from '../../runtime/agent-store'
import { usePreservedScroll } from '../../runtime/ui-memory'
import { fmtClock } from '../format'
import { useWidth } from '../hooks'
import { ActivityTimeline } from './ActivityTimeline'
import { BatchBoard } from './BatchBoard'
import { FixturePreflight } from './MissionPreflight'
import { ResearchBrief } from './ResearchBrief'
import { TaskHeader } from './ResearchHeader'
import { SourceExplorer } from './SourceExplorer'

/**
 * THE RESEARCH CANVAS (S3 P2 centre) — task header → latest decision → the
 * investigation: activity, sources, the brief. The canvas adds COLUMNS as it
 * widens (one with tabs → two → three) instead of whitespace; at 5120×1440
 * activity, sources and the brief sit side by side. When the run finishes
 * the brief takes the lead column (a layout morph). Each column keeps its
 * scroll position per run × property, so switching runs or batch properties
 * and coming back lands where you were.
 */
export function ResearchCanvas({ snap }: { snap: RunSnapshot }) {
  const view = snap.research as ResearchView
  const ui = useAgentUi()
  const reduced = useLcReducedMotion()
  const [ref, width] = useWidth<HTMLDivElement>()
  const isBatch = snap.properties.length > 1 || view.property_count > 1
  const pid = isBatch ? ui.focusPropertyId : snap.properties[0]?.property_id ?? view.propertyOrder[0] ?? null
  const pv = pid ? view.properties[pid] ?? null : null
  const terminal = isTerminal(view)
  const cols = width >= 1640 ? 3 : width >= 1040 ? 2 : 1
  const runId = snap.record.runId

  // finishing moves the narrow canvas to the brief, once
  const was = useRef(terminal)
  useEffect(() => {
    if (terminal && !was.current && !isBatch) setUi({ centerTab: 'brief' })
    was.current = terminal
  }, [terminal, isBatch])

  const latestDecision = useMemo(() => {
    for (let i = view.decisions.length - 1; i >= 0; i -= 1) {
      const d = view.decisions[i]
      if (!pid || !d.property_id || d.property_id === pid) return d
    }
    return null
  }, [view.decisions, pid])

  const p = progressOf(view, isBatch ? pid : null)
  const scopeKey = `${runId}:${pid ?? 'all'}`
  const activity = <ActivityTimeline view={view} sources={snap.sources} propertyId={isBatch ? pid : null} arrivalFloor={snap.arrivalFloor} runId={runId} mode={snap.mode} />
  const explorer = <SourceExplorer view={view} sources={snap.sources} propertyId={isBatch ? pid : null} arrivalFloor={snap.arrivalFloor} mode={snap.mode} />
  const brief = <ResearchBrief snap={snap} view={view} property={pv} />
  const srcCount = view.sources.filter((s) => !pid || !isBatch || s.property_id === pid).length
  const tabs = (allow: CenterTab[]) => (
    <LCSegmented<CenterTab> size="sm" label="Canvas view" value={allow.includes(ui.centerTab) ? ui.centerTab : allow[0]} onChange={(v) => setUi({ centerTab: v })}
      options={allow.map((v) => ({ value: v, label: v === 'activity' ? `Activity · ${p.planned}` : v === 'sources' ? `Sources · ${srcCount}` : terminal ? 'Brief' : 'Brief · writing' }))} />
  )
  const pick = (allow: CenterTab[]) => {
    const t = allow.includes(ui.centerTab) ? ui.centerTab : allow[0]
    return { node: t === 'activity' ? activity : t === 'sources' ? explorer : brief, key: t }
  }

  let body: ReactNode
  if (view.state === 'draft' && snap.mode === 'fixture') body = <div className="agx-canvas__pre"><FixturePreflight snap={snap} view={view} /></div>
  else if (isBatch && !pid) {
    const board = <BatchBoard snap={snap} view={view} arrivalFloor={snap.arrivalFloor} />
    body = cols === 1 ? <Col scrollKey={`${scopeKey}:batch`}>{board}</Col>
      : (
        <div className={cx('agx-cols', `is-${cols}`)} style={{ gridTemplateColumns: cols === 3 ? 'minmax(0,1.45fr) minmax(0,1fr) minmax(0,0.85fr)' : 'minmax(0,1.3fr) minmax(0,1fr)' }}>
          <Col title="Triage" scrollKey={`${scopeKey}:batch`}>{board}</Col>
          <Col title="Activity · all properties" scrollKey={`${scopeKey}:activity`}>{activity}</Col>
          {cols === 3 ? <Col title="Sources · all properties" scrollKey={`${scopeKey}:sources`}>{explorer}</Col> : null}
        </div>
      )
  } else {
    const order: Array<'activity' | 'sources' | 'brief'> = terminal ? ['brief', 'activity', 'sources'] : ['activity', 'brief', 'sources']
    const fr = terminal ? ['1.45fr', '1fr', '0.85fr'] : ['1.15fr', '1fr', '0.85fr']
    const content = { activity, sources: explorer, brief }
    const titles = { activity: 'Activity', sources: 'Sources', brief: terminal ? 'Brief' : 'Brief · writing' }
    body = (
      <LayoutGroup>
        {isBatch && cols >= 2 ? (
          <div className="agx-cols is-2" style={{ gridTemplateColumns: 'minmax(0,0.9fr) minmax(0,1.25fr)' }}>
            <Col title="Triage" scrollKey={`${runId}:all:batch`}><BatchBoard snap={snap} view={view} arrivalFloor={snap.arrivalFloor} compact /></Col>
            {(() => { const pk = pick(['activity', 'sources', 'brief']); return <Col title={pv?.display_address ?? 'Property'} tools={tabs(['activity', 'sources', 'brief'])} scrollKey={`${scopeKey}:${pk.key}`}>{pk.node}</Col> })()}
          </div>
        ) : cols === 3 ? (
          <div className="agx-cols is-3" style={{ gridTemplateColumns: fr.map((f) => `minmax(0,${f})`).join(' ') }}>
            {order.map((k) => <motion.div key={k} layout={!reduced} transition={{ duration: reduced ? 0 : 0.46, ease: [0.22, 1, 0.36, 1] }} className="agx-col-wrap"><Col title={titles[k]} scrollKey={`${scopeKey}:${k}`} lead={k === order[0]}>{content[k]}</Col></motion.div>)}
          </div>
        ) : cols === 2 ? (
          <div className="agx-cols is-2" style={{ gridTemplateColumns: terminal ? 'minmax(0,1.25fr) minmax(0,1fr)' : 'minmax(0,1.1fr) minmax(0,1fr)' }}>
            {terminal
              ? <><Col title="Brief" scrollKey={`${scopeKey}:brief`} lead>{brief}</Col>{(() => { const pk = pick(['activity', 'sources']); return <Col title="Evidence" tools={tabs(['activity', 'sources'])} scrollKey={`${scopeKey}:${pk.key}`}>{pk.node}</Col> })()}</>
              : <><Col title="Activity" scrollKey={`${scopeKey}:activity`} lead>{activity}</Col>{(() => { const pk = pick(['brief', 'sources']); return <Col title="Brief & sources" tools={tabs(['brief', 'sources'])} scrollKey={`${scopeKey}:${pk.key}`}>{pk.node}</Col> })()}</>}
          </div>
        ) : (() => { const pk = pick(['activity', 'sources', 'brief']); return <Col tools={tabs(['activity', 'sources', 'brief'])} scrollKey={`${scopeKey}:${pk.key}`}>{pk.node}</Col> })()}
      </LayoutGroup>
    )
  }

  return (
    <div className={cx('agx-canvas', `is-${snap.mode}`, view.running_count > 0 && 'is-running')} ref={ref}>
      <TaskHeader snap={snap} view={view} propertyId={isBatch ? pid : null} crumb={isBatch && pid ? { label: `All ${snap.properties.length} properties`, onClick: () => setUi({ focusPropertyId: null }) } : null} />
      {view.state !== 'draft' && latestDecision ? (
        <div className="agx-why" aria-label="Latest investigative decision">
          <span className="agx-tl__why">Why</span>
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.p key={latestDecision.event_id} initial={reduced ? false : { opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: reduced ? 0 : 0.12 } }} transition={{ duration: reduced ? 0 : 0.2 }}>{latestDecision.summary}</motion.p>
          </AnimatePresence>
          <time>{fmtClock(latestDecision.at)}</time>
        </div>
      ) : null}
      {view.gap ? <p className="agx-gap">A gap in the event sequence was detected — {snap.mode === 'live' ? 'the client is rebuilding from the start of the log.' : 'the live client refetches from the snapshot here.'}</p> : null}
      <div className="agx-canvas__body">{body}</div>
    </div>
  )
}

function Col({ title, tools, children, scrollKey, lead }: { title?: string; tools?: ReactNode; children: ReactNode; scrollKey: string; lead?: boolean }) {
  const [ref, onScroll] = usePreservedScroll<HTMLDivElement>(scrollKey)
  return (
    <section className={cx('agx-col', lead && 'is-lead')}>
      {title || tools ? <header className="agx-col__head">{title ? <h4>{title}</h4> : null}{tools}</header> : null}
      <div className="agx-col__scroll" ref={ref} onScroll={onScroll}>{children}</div>
    </section>
  )
}
