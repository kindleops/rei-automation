import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../../../../shared/icons'
import { LCButton, LCDataGrid, LCSegmented, LCSkeleton, LCTabs, LCTimeline, cx, lcConfirm, lcToast, type LCColumn, type LCTimelineItem } from '../../../../shared/lc'
import { cancelMission, getMission, listMissions } from '../../api/wf-client'
import { normalizeRefs } from '../../api/wf-normalize'
import type { WfAssignment, WfMission, WfMissionDetail } from '../../api/wf-types'
import {
  assignmentMeta, belongsToStep, capabilityLabel, eventMeta, eventOutcome, intentLabel, isTerminalMission, progressOf, resourceRef, waitingReason,
} from '../../model/wf-model'
import { useWf } from '../../store/wf-hooks'
import { useWfNav } from '../wf-context'
import { WfPlanDag } from '../wf-dag'
import { WfAssignmentState, WfFailureState, WfMissionState, WfPanel, WfProgress, WfRefs, WfSectionHead, WfTime, WfUnknown } from '../wf-parts'
import { WfReportView } from '../wf-report'

type Lens = 'open' | 'all' | 'done'

export function MissionsSection({ tick, selected, onSelect, focusAssignment, onLive }: {
  tick: number
  selected: string | null
  onSelect: (id: string | null) => void
  focusAssignment: string | null
  onLive: (live: boolean) => void
}) {
  const nav = useWfNav()
  const [lens, setLens] = useState<Lens>('all')
  const list = useWf('wf:missions', (s) => listMissions({ limit: 60 }, s), tick)
  const rows = useMemo(() => (list.data ?? []).filter((m) => lens === 'all' || (lens === 'open' ? !isTerminalMission(m.status) : isTerminalMission(m.status))), [list.data, lens])
  // the first mission opens by default (a pane with room never shows an empty half)
  const current = selected ?? rows[0]?.mission_id ?? null
  const anyLive = (list.data ?? []).some((m) => !isTerminalMission(m.status) && m.status !== 'blocked')
  useEffect(() => { onLive(anyLive) }, [anyLive, onLive])

  return (
    <div className={cx('wf-missions', selected && 'has-selection')}>
      <aside className="wf-missions__list" aria-label="Missions">
        <WfSectionHead
          title="Missions"
          sub={list.data ? <>{list.data.filter((m) => !isTerminalMission(m.status)).length} open · {list.data.length} total</> : 'Reading missions'}
          actions={<LCSegmented<Lens> size="sm" label="Show" value={lens} onChange={setLens} options={[{ value: 'all', label: 'All' }, { value: 'open', label: 'Open' }, { value: 'done', label: 'Finished' }]} />}
        />
        {list.failure && !list.data ? <WfFailureState failure={list.failure} what="Missions did not load" onRetry={list.retry} compact /> : null}
        {list.loading ? <LCSkeleton shape="rows" count={5} /> : null}
        {list.data && !rows.length ? <p className="wf-quiet wf-pad">No missions here. A directive in Executive Command opens one.</p> : null}
        <ul className="wf-mlist">
          {rows.map((m) => <MissionRow key={m.mission_id} m={m} on={m.mission_id === current} onClick={() => onSelect(m.mission_id)} />)}
        </ul>
      </aside>
      <div className="wf-missions__detail">
        {current ? <MissionDetail key={current} id={current} tick={tick} focusAssignment={focusAssignment} onBack={() => onSelect(null)} /> : list.data ? (
          <div className="wf-pad"><p className="wf-quiet">Select a mission.</p><LCButton size="sm" variant="secondary" icon="message" onClick={() => nav.go('command')}>Open Executive Command</LCButton></div>
        ) : null}
      </div>
    </div>
  )
}

function MissionRow({ m, on, onClick }: { m: WfMission; on: boolean; onClick: () => void }) {
  const nav = useWfNav()
  const p = progressOf(m.assignment_counts)
  return (
    <li>
      <button type="button" className={cx('wf-mrow', on && 'is-on', `is-${m.status}`)} onClick={onClick} aria-current={on || undefined}>
        <span className="wf-mrow__top">
          <span className="wf-mrow__k">{intentLabel(m.objective?.intent ?? m.playbook_key)}</span>
          <WfMissionState status={m.status} />
        </span>
        <span className="wf-mrow__t">{m.title}</span>
        <span className="wf-mrow__m">
          <WfTime iso={m.completed_at ?? m.updated_at ?? m.created_at} now={nav.now} />
          {m.objective?.markets?.length ? <span>{m.objective.markets.join(', ')}</span> : null}
          {p.total ? <span className="lc-num">{p.done}/{p.total - p.cancelled}</span> : null}
        </span>
        {p.total ? <WfProgress p={p} label={`${m.title} progress`} compact /> : null}
      </button>
    </li>
  )
}

type Tab = 'report' | 'assignments' | 'events'

function MissionDetail({ id, tick, focusAssignment, onBack }: { id: string; tick: number; focusAssignment: string | null; onBack: () => void }) {
  const nav = useWfNav()
  const view = useWf<WfMissionDetail | null>(`wf:mission:${id}`, (s) => getMission(id, s), tick)
  const d = view.data
  const [tab, setTab] = useState<Tab>(focusAssignment ? 'assignments' : 'report')
  const [step, setStep] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)

  if (!d) return view.failure ? <WfFailureState failure={view.failure} what="The mission did not load" onRetry={view.retry} /> : <div className="wf-pad"><LCSkeleton shape="block" height={110} /><LCSkeleton shape="block" height={220} /></div>
  const m = d.mission
  const p = progressOf(d.assignments)
  const owner = nav.employees.get(m.owner_employee_id ?? '')

  const cancel = async () => {
    const ok = await lcConfirm({
      title: `Cancel "${m.title}"?`,
      effects: [
        { text: 'Every assignment that has not finished is cancelled', kind: 'stops' },
        { text: 'Completed work and its evidence stay on record', kind: 'keeps' },
        { text: 'Runtime jobs already enqueued finish under their own budgets', kind: 'note' },
      ],
      confirmLabel: 'Cancel mission',
      cancelLabel: 'Keep running',
      tone: 'danger',
      nativeText: `Cancel the mission "${m.title}"? Unfinished assignments are cancelled.`,
    })
    if (!ok) return
    setCancelling(true)
    const r = await cancelMission(m.mission_id)
    setCancelling(false)
    if (r.ok) { lcToast({ title: 'Mission cancelled', detail: m.title, severity: 'info' }); view.retry() }
    else lcToast({ title: 'The mission was not cancelled', detail: r.message, severity: 'critical' })
  }

  const stepAssignments = step ? d.assignments.filter((a) => belongsToStep(a, step)) : d.assignments
  return (
    <article className="wf-mdetail">
      <header className="wf-mdetail__h">
        <button type="button" className="wf-back" onClick={onBack}><Icon name="chevron-left" size={13} />Missions</button>
        <div className="wf-mdetail__k">
          <span>{intentLabel(m.objective?.intent ?? m.playbook_key)}</span>
          <WfMissionState status={m.status} />
          {m.plan_version ? <span className="wf-quiet">plan v{m.plan_version}</span> : null}
        </div>
        <h2 className="wf-mdetail__t">{m.title}</h2>
        <blockquote className="wf-mdetail__dir">{m.directive}</blockquote>
        <div className="wf-mdetail__meta">
          <span>Owner <b>{owner?.display_name ?? 'COO'}</b></span>
          <span>Opened <WfTime iso={m.created_at} now={nav.now} /></span>
          {m.completed_at ? <span>Finished <WfTime iso={m.completed_at} now={nav.now} /></span> : null}
          {m.objective?.markets?.length ? <span>Markets <b>{m.objective.markets.join(', ')}</b></span> : null}
          {m.objective?.count ? <span>Target <b className="lc-num">{m.objective.count}</b></span> : null}
          {!isTerminalMission(m.status) ? <LCButton size="sm" variant="ghost" icon="x" loading={cancelling} onClick={() => { void cancel() }}>Cancel mission</LCButton> : null}
        </div>
        <WfProgress p={p} label="Mission progress" />
      </header>

      <WfPanel title="Plan" icon="layers" aside={step ? <button type="button" className="wf-link" onClick={() => setStep(null)}>Show every step</button> : <span className="wf-quiet">select a step to filter its assignments</span>} className="wf-mdetail__plan">
        <WfPlanDag plan={m.plan} assignments={d.assignments} selected={step} onSelect={(k) => { setStep((cur) => (cur === k ? null : k)); setTab('assignments') }} />
      </WfPanel>

      <div className="wf-mdetail__tabs">
        <LCTabs<Tab>
          label="Mission"
          variant="line"
          value={tab}
          onChange={setTab}
          items={[
            { id: 'report', label: 'Report', count: m.report ? m.report.ranked.length || m.report.completed.length : null },
            { id: 'assignments', label: 'Assignments', count: stepAssignments.length },
            { id: 'events', label: 'Events', count: d.events.length },
          ]}
        />
      </div>
      {tab === 'report' ? (
        m.report ? <WfReportView report={m.report} assignments={d.assignments} /> : (
          <div className="wf-pending-report">
            <Icon name="clock" size={14} />
            <div>
              <b>{isTerminalMission(m.status) ? 'No report was written' : 'The report is written when every assignment has finished'}</b>
              <p>{isTerminalMission(m.status) ? 'The mission ended without a review.' : `${p.done} of ${p.total - p.cancelled} assignments are done. Nothing is reported until it completes.`}</p>
            </div>
          </div>
        )
      ) : tab === 'assignments' ? (
        <AssignmentGrid rows={stepAssignments} focus={focusAssignment} />
      ) : (
        <LCTimeline
          dense
          byDay
          label="Mission events"
          items={[...d.events].reverse().map((e): LCTimelineItem => {
            const meta = eventMeta(e.type)
            const refs = normalizeRefs(e.payload.refs)
            return {
              id: String(e.event_id),
              at: Date.parse(e.at),
              title: <>{meta.title}{e.employee_id ? <span className="wf-quiet"> · {nav.employees.get(e.employee_id)?.display_name ?? e.employee_id}</span> : null}</>,
              body: eventOutcome(e) ?? undefined,
              meta: refs.length ? <WfRefs refs={refs} quiet /> : undefined,
              icon: meta.icon,
              state: meta.tone === 'crit' ? 'failed' : meta.tone === 'attn' ? 'waiting' : 'done',
            }
          })}
        />
      )}
    </article>
  )
}

function AssignmentGrid({ rows, focus }: { rows: WfAssignment[]; focus: string | null }) {
  const nav = useWfNav()
  const columns: LCColumn<WfAssignment>[] = [
    { id: 'step', header: 'Step', minWidth: 190, render: (a) => <span className="wf-cell-step" title={a.step_key}><b>{capabilityLabel(a.capability_key)}</b><code>{a.step_key.includes('.') ? `#${a.step_key.split('.').pop()}` : ''}</code></span> },
    { id: 'who', header: 'Assignee', width: 130, render: (a) => nav.employees.get(a.assignee_employee_id ?? '')?.display_name ?? a.assignee_employee_id ?? 'Unassigned' },
    { id: 'status', header: 'State', width: 150, render: (a) => <WfAssignmentState status={a.status} quiet={assignmentMeta(a.status).group === 'done'} /> },
    { id: 'outcome', header: 'Outcome', width: 96, render: (a) => (a.outcome_class ? <span className="wf-oc-class" data-class={a.outcome_class}>{a.outcome_class}</span> : <span className="wf-quiet">None yet</span>) },
    { id: 'why', header: 'Reason', minWidth: 200, render: (a) => waitingReason(a) ?? <span className="wf-quiet">None</span> },
    { id: 'record', header: 'Record', width: 200, render: (a) => (resourceRef(a) ? <WfRefs refs={[resourceRef(a)!]} quiet /> : a.runtime_job_id ? <code>{a.runtime_job_id}</code> : <span className="wf-quiet">None</span>) },
    { id: 'attempt', header: 'Try', width: 58, align: 'right', render: (a) => (a.attempt === null ? <WfUnknown /> : `${a.attempt}${a.max_attempts ? `/${a.max_attempts}` : ''}`) },
    { id: 'updated', header: 'Updated', width: 100, render: (a) => <WfTime iso={a.updated_at} now={nav.now} /> },
  ]
  return (
    <div className="wf-agrid">
      <LCDataGrid<WfAssignment>
        id="wf-mission-assignments"
        label="Assignments"
        rows={rows}
        rowKey={(a) => a.assignment_id}
        columns={columns}
        activeKey={focus}
        density="standard"
        rowTone={(a) => { const g = assignmentMeta(a.status).group; return g === 'blocked' || g === 'failed' ? 'crit' : a.status === 'waiting_approval' ? 'attn' : null }}
        empty={{ title: 'No assignments', body: 'The COO creates assignments when the plan is written.' }}
        height="100%"
      />
    </div>
  )
}
