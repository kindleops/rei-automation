import { useMemo, useState } from 'react'
import { LCActivityFeed, LCLive, LCSegmented, LCSelect, type LCActivityEvent } from '../../../../shared/lc'
import { normalizeRefs } from '../../api/wf-normalize'
import type { WfAssignment, WfEvent } from '../../api/wf-types'
import { listAssignments } from '../../api/wf-client'
import {
  ASSIGNMENT_GROUPS, assignmentMeta, capabilityLabel, eventMeta, eventOutcome, isRecovery, resourceRef, waitingReason, type AssignmentGroup,
} from '../../model/wf-model'
import { useWf, useWfFeed } from '../../store/wf-hooks'
import { useWfNav } from '../wf-context'
import { useWfDecisions } from '../../store/wf-decisions-store'
import { pruneDecisions, type DecisionState } from '../../model/wf-decisions'
import { WfDecideBar, WfDecisionRecorded } from '../wf-decide'
import { WfAssignmentState, WfFailureState, WfMore, WfPanel, WfRefs, WfSectionHead, WfTime, WfUnknown } from '../wf-parts'

type Scope = 'all' | 'outcomes' | 'problems'
const isOutcome = (t: string) => /completed|failed|refus|escalat|cancelled|blocked/.test(t)
const isProblem = (t: string) => /failed|refus|escalat|blocked|requeued|reaped|retry/.test(t)

/** The live operations feed: every Workforce event, newest first, with its records and outcome. Cursor-paged both ways. */
export function OperationsSection({ tick, pollMs }: { tick: number; pollMs: number }) {
  const nav = useWfNav()
  const feed = useWfFeed(tick)
  const [scope, setScope] = useState<Scope>('all')
  const events = useMemo(() => feed.events.filter((e) => scope === 'all' || (scope === 'outcomes' ? isOutcome(e.type) : isProblem(e.type))), [feed.events, scope])
  const items = useMemo(() => events.map((e) => toActivity(e, nav)), [events, nav])
  const live = !feed.failure && feed.at !== null
  return (
    <div className="wf-ops">
      <WfSectionHead
        title="Operations"
        sub={<><LCLive live={live} updatedAt={feed.at} stale={Boolean(feed.at && nav.now - feed.at > Math.max(pollMs, 20_000) * 2.5)} /> every Workforce event, newest first</>}
        actions={<LCSegmented<Scope> size="sm" label="Show" value={scope} onChange={setScope} options={[{ value: 'all', label: 'Everything' }, { value: 'outcomes', label: 'Outcomes' }, { value: 'problems', label: 'Problems' }]} />}
      />
      {feed.failure && !feed.events.length ? <WfFailureState failure={feed.failure} what="The operations feed did not load" /> : (
        <WfPanel flush className="wf-ops__feed">
          <LCActivityFeed events={items} loading={feed.loading} windowMs={90_000} max={400} label="Operations" empty={{ title: scope === 'all' ? 'No events yet' : 'Nothing matches', body: scope === 'all' ? 'Events appear as missions are planned and assignments move.' : undefined }} />
          {feed.hasOlder && feed.events.length ? <WfMore onClick={feed.loadOlder} loading={feed.loadingOlder} /> : feed.events.length ? <p className="wf-quiet wf-end">Start of the record</p> : null}
        </WfPanel>
      )}
    </div>
  )
}

function toActivity(e: WfEvent, nav: ReturnType<typeof useWfNav>): LCActivityEvent {
  const meta = eventMeta(e.type)
  const who = e.employee_id ? nav.employees.get(e.employee_id)?.display_name ?? e.employee_id : null
  const refs = normalizeRefs(e.payload.refs)
  const outcome = eventOutcome(e)
  const mission = e.mission_id ? [{ type: 'mission' as const, id: e.mission_id, label: 'Mission' }] : []
  return {
    id: String(e.event_id),
    at: Date.parse(e.at),
    title: meta.title,
    subject: who ?? undefined,
    source: <span className="wf-ev-type">{e.type}</span>,
    result: <span className="wf-ev-out">{outcome ? <span>{outcome}</span> : null}<WfRefs refs={[...refs, ...mission]} quiet max={4} /></span>,
    icon: meta.icon,
    tone: meta.tone,
    // a burst of the same kind from one employee folds into one row
    groupKey: `${e.type}:${e.employee_id ?? ''}`,
    groupNoun: `${meta.title.toLowerCase()} events`,
  }
}

/** The work queue: every assignment by state, with why it is not moving, and the recoveries. */
export function QueueSection({ tick }: { tick: number }) {
  const nav = useWfNav()
  const view = useWf('wf:assignments', (s) => listAssignments({}, s), tick)
  const decisions = useWfDecisions(view.retry)
  const local = useMemo(() => pruneDecisions(decisions.map, nav.now), [decisions.map, nav.now])
  const [who, setWho] = useState<string>('all')
  // optimistic but reconciled: a recorded decision shows the server's returned row (completed) until the next list lands
  const rows = useMemo(() => (view.data ?? []).map((a) => (local[a.assignment_id]?.phase === 'recorded' && a.status === 'waiting_approval' ? local[a.assignment_id].item : a))
    .filter((a) => who === 'all' || a.assignee_employee_id === who), [view.data, who, local])
  const recorded = Object.values(local).filter((s) => s.phase === 'recorded')
  const groups = useMemo(() => {
    const g = new Map<AssignmentGroup, WfAssignment[]>()
    for (const a of rows) { const k = assignmentMeta(a.status).group; g.set(k, [...(g.get(k) ?? []), a]) }
    for (const list of g.values()) list.sort((x, y) => Date.parse(y.updated_at ?? '') - Date.parse(x.updated_at ?? ''))
    return g
  }, [rows])
  const recoveries = rows.filter(isRecovery)
  const people = useMemo(() => [...new Set((view.data ?? []).map((a) => a.assignee_employee_id).filter((x): x is string => Boolean(x)))], [view.data])
  if (view.failure && !view.data) return <WfFailureState failure={view.failure} what="The work queue did not load" onRetry={view.retry} />
  const lanes = ASSIGNMENT_GROUPS.filter((g) => g.id !== 'done')
  return (
    <div className="wf-queue">
      <WfSectionHead
        title="Work Queue"
        sub={view.data ? <>{rows.filter((a) => assignmentMeta(a.status).group !== 'done').length} open · {recoveries.length} recovered or retrying</> : 'Reading assignments'}
        actions={(
          <LCSelect size="sm" variant="quiet" label="Assignee" prefix="Assignee" value={who} onChange={setWho} options={[{ value: 'all', label: 'Everyone' }, ...people.map((id) => ({ value: id, label: nav.employees.get(id)?.display_name ?? id }))]} />
        )}
      />
      {recorded.length ? (
        <ul className="wf-needs wf-needs--recorded wf-queue__recorded" aria-label="Decisions just recorded">
          {recorded.map((x) => <WfDecisionRecorded key={x.item.assignment_id} s={x} onDismiss={() => decisions.dismiss(x.item.assignment_id)} />)}
        </ul>
      ) : null}
      <div className="wf-lanes">
        {lanes.map((g) => {
          const list = groups.get(g.id) ?? []
          return (
            <section key={g.id} className="wf-lane" data-group={g.id} aria-label={g.label}>
              <header><span>{g.label}</span><b className="lc-num">{view.data ? list.length : ''}</b></header>
              {!view.data ? <div className="wf-lane__skel" /> : !list.length ? <p className="wf-quiet">None</p> : (
                <ul>
                  {list.slice(0, 40).map((a) => <QueueCard key={a.assignment_id} a={a} state={local[a.assignment_id] ?? null} onDecide={(x, d) => { void decisions.decide(x, d) }} />)}
                  {list.length > 40 ? <li className="wf-quiet">+{list.length - 40} more</li> : null}
                </ul>
              )}
            </section>
          )
        })}
      </div>
      <WfPanel title="Recoveries" icon="refresh-cw" aside={<span className="wf-quiet">leases reaped, retries scheduled, attempts past the first</span>}>
        {!view.data ? null : !recoveries.length ? <p className="wf-quiet">No assignment has needed a second attempt.</p> : (
          <ul className="wf-recov">
            {recoveries.map((a) => (
              <li key={a.assignment_id}>
                <button type="button" className="wf-link" onClick={() => nav.openAssignment(a.assignment_id, a.mission_id)}>{capabilityLabel(a.capability_key)}</button>
                <span className="lc-num">attempt {a.attempt ?? <WfUnknown />}{a.max_attempts ? ` of ${a.max_attempts}` : ''}</span>
                <WfAssignmentState status={a.status} quiet />
                <span className="wf-recov__why">{a.last_error?.message ?? waitingReason(a) ?? 'Recovered'}</span>
              </li>
            ))}
          </ul>
        )}
      </WfPanel>
    </div>
  )
}

function QueueCard({ a, state, onDecide }: { a: WfAssignment; state: DecisionState | null; onDecide: (a: WfAssignment, d: 'approve' | 'decline' | 'done') => void }) {
  const nav = useWfNav()
  const why = waitingReason(a)
  const ref = resourceRef(a)
  const who = nav.employees.get(a.assignee_employee_id ?? '')
  return (
    <li className="wf-qcard" data-status={a.status}>
      <button type="button" className="wf-qcard__h" onClick={() => nav.openAssignment(a.assignment_id, a.mission_id)}>
        <span className="wf-qcard__t">{capabilityLabel(a.capability_key)}</span>
        <WfAssignmentState status={a.status} quiet />
      </button>
      {why ? <p className="wf-qcard__why">{why}</p> : null}
      <div className="wf-qcard__f">
        <span className="wf-qcard__who">{who ? `${who.display_name}${who.kind === 'human' ? ' (human)' : ''}` : a.assignee_employee_id ?? 'Unassigned'}</span>
        <WfTime iso={a.updated_at} now={nav.now} />
      </div>
      {ref ? <WfRefs refs={[ref]} quiet /> : null}
      <WfDecideBar a={a} state={state} onDecide={onDecide} compact terse />
    </li>
  )
}
