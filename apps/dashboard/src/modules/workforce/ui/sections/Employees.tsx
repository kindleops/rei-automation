import { useMemo, useState } from 'react'
import { LCDataGrid, LCFacts, LCInspector, LCInspectorSection, LCSegmented, LCSkeleton, LCStatus, type LCColumn, type LCSort } from '../../../../shared/lc'
import { getEmployee } from '../../api/wf-client'
import type { WfEmployee, WfEmployeeProfile, WfMemoryFact, WfOverview } from '../../api/wf-types'
import {
  assignmentMeta, capabilityLabel, departmentLabel, EMPLOYEE_STATUS_STATE, factValue, HEARTBEAT_META, heartbeatOf, humanize, isTerminalAssignment,
  kpiDisplay, kpiLabel, resourceRef, roleLabel, splitMemory, usd, waitingReason,
} from '../../model/wf-model'
import { useWf, type WfView } from '../../store/wf-hooks'
import { useWfNav } from '../wf-context'
import { WfAssignmentState, WfAvatar, WfFailureState, WfKind, WfRefs, WfSectionHead, WfTime, WfUnknown } from '../wf-parts'

type Filter = 'all' | 'ai' | 'human'

export function EmployeesSection({ overview, selected, onSelect, tick }: { overview: WfView<WfOverview>; selected: string | null; onSelect: (id: string | null) => void; tick: number }) {
  const nav = useWfNav()
  const [filter, setFilter] = useState<Filter>('all')
  const [sort, setSort] = useState<LCSort>(null)
  const rows = useMemo(() => {
    const list = (overview.data?.employees ?? []).filter((e) => filter === 'all' || e.kind === filter)
    if (!sort) return list
    const dir = sort.dir === 'asc' ? 1 : -1
    const val = (e: WfEmployee): string | number => sort.id === 'open' ? e.open_assignments ?? -1 : sort.id === 'name' ? e.display_name : sort.id === 'dept' ? departmentLabel(e.department_key) : sort.id === 'activity' ? Date.parse(e.last_activity_at ?? '') || 0 : e.role_key
    return [...list].sort((a, b) => { const x = val(a); const y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * dir })
  }, [overview.data, filter, sort])

  const columns: LCColumn<WfEmployee>[] = [
    { id: 'name', header: 'Employee', minWidth: 190, sortable: true, render: (e) => (
      <span className="wf-cell-emp"><WfAvatar e={e} size={22} /><span><b>{e.display_name}</b>{e.employee_code ? <code>{e.employee_code}</code> : null}</span></span>
    ) },
    { id: 'role', header: 'Role', minWidth: 150, sortable: true, render: (e) => roleLabel(e.role_key) },
    { id: 'dept', header: 'Department', width: 140, sortable: true, hideable: true, render: (e) => departmentLabel(e.department_key) },
    { id: 'kind', header: 'Kind', width: 88, render: (e) => <WfKind kind={e.kind} /> },
    { id: 'status', header: 'Status', width: 118, render: (e) => {
      const s = EMPLOYEE_STATUS_STATE[e.status] ?? { label: humanize(e.status), tone: 'neutral' as const }
      if (e.status !== 'active' || e.kind === 'human') return <LCStatus label={s.label} tone={s.tone} quiet />
      const hb = HEARTBEAT_META[heartbeatOf(e, nav.now)]
      return <LCStatus label={hb.label} tone={hb.tone} quiet={hb.tone === 'ok'} />
    } },
    { id: 'markets', header: 'Markets', width: 150, hideable: true, render: (e) => (e.markets.length ? e.markets.join(', ') : <span className="wf-quiet">All in scope</span>) },
    { id: 'open', header: 'Open', width: 70, align: 'right', sortable: true, render: (e) => (e.open_assignments === null ? <WfUnknown reason="The overview did not report a count" /> : e.open_assignments) },
    { id: 'tier', header: 'Tier', width: 60, hideable: true, hiddenByDefault: true, render: (e) => e.tier_ceiling ?? <span className="wf-quiet">None</span> },
    { id: 'activity', header: 'Last activity', width: 120, sortable: true, hideable: true, render: (e) => <WfTime iso={e.last_activity_at} now={nav.now} /> },
  ]

  if (overview.failure && !overview.data) return <WfFailureState failure={overview.failure} what="Employees did not load" onRetry={overview.retry} />
  const all = overview.data?.employees ?? []
  return (
    <div className="wf-emps">
      <WfSectionHead
        title="Employees"
        sub={overview.data ? <>{all.length} on the roster · {all.filter((e) => e.status === 'active').length} active</> : 'Reading the roster'}
        actions={<LCSegmented<Filter> size="sm" label="Kind" value={filter} onChange={setFilter} options={[{ value: 'all', label: 'Everyone' }, { value: 'ai', label: 'AI' }, { value: 'human', label: 'Human' }]} />}
      />
      <div className="wf-emps__grid">
        <LCDataGrid<WfEmployee>
          id="wf-employees"
          label="Employees"
          rows={rows}
          rowKey={(e) => e.employee_id}
          columns={columns}
          sort={sort}
          onSortChange={setSort}
          activeKey={selected}
          onActivate={(e) => onSelect(e.employee_id)}
          loading={overview.loading}
          density="standard"
          empty={{ title: 'No employees', body: 'The seed creates the executive staff; acquisition agents are created per market by the CEO.' }}
          height="100%"
        />
      </div>
      <EmployeeInspector id={selected} onClose={() => onSelect(null)} tick={tick} />
    </div>
  )
}

type Tab = 'profile' | 'memory' | 'work'

function EmployeeInspector({ id, onClose, tick }: { id: string | null; onClose: () => void; tick: number }) {
  const [tab, setTab] = useState<Tab>('profile')
  const view = useWf<WfEmployeeProfile | null>(id ? `wf:emp:${id}` : null, (s) => getEmployee(id!, s), tick)
  const p = view.data
  const e = p?.employee
  const mem = p ? splitMemory(p.memory) : null
  const open = p ? p.assignments.filter((a) => !isTerminalAssignment(a.status)).length : null
  return (
    <LCInspector
      open={Boolean(id)}
      onClose={onClose}
      id="wf-employee"
      mode="float"
      width={460}
      eyebrow={e ? `${departmentLabel(e.department_key)} · ${e.kind === 'ai' ? 'AI employee' : 'Human'}` : 'Employee'}
      title={e ? <span className="wf-insp-title"><WfAvatar e={e} size={26} />{e.display_name}{e.employee_code ? <code>{e.employee_code}</code> : null}</span> : 'Employee'}
      label={e?.display_name ?? 'Employee'}
      subtitle={e ? roleLabel(e.role_key) : undefined}
      contentKey={`${id}:${tab}`}
      tabs={{ value: tab, onChange: (v) => setTab(v as Tab), items: [
        { id: 'profile', label: 'Profile' },
        { id: 'memory', label: 'Memory', count: mem ? mem.verified.length + mem.interpretation.length + mem.policy.length : null },
        { id: 'work', label: 'Work', count: open },
      ] }}
    >
      {!p ? (view.failure ? <WfFailureState failure={view.failure} what="The profile did not load" onRetry={view.retry} compact /> : <LCSkeleton shape="lines" count={8} />) : (
        tab === 'profile' ? <ProfileTab p={p} /> : tab === 'memory' ? <MemoryTab p={p} /> : <WorkTab p={p} />
      )}
    </LCInspector>
  )
}

function ProfileTab({ p }: { p: WfEmployeeProfile }) {
  const nav = useWfNav()
  const e = p.employee
  const manager = e.manager_employee_id ? nav.employees.get(e.manager_employee_id) : null
  return (
    <>
      <LCInspectorSection title="Charter">
        {p.charter ? (
          <div className="wf-charter">
            {p.charter.mandate ? <p className="wf-charter__m">{p.charter.mandate}</p> : null}
            {p.charter.responsibilities.length ? <ul className="wf-bullets">{p.charter.responsibilities.map((r) => <li key={r}>{r}</li>)}</ul> : null}
          </div>
        ) : <WfUnknown reason="The role charter was not returned" inline />}
      </LCInspectorSection>
      <LCInspectorSection title="Authority">
        <LCFacts rows={[
          { label: 'Tier ceiling', value: e.tier_ceiling ?? 'None' },
          { label: 'Charter maximum', value: p.charter?.max_tier ?? null },
          { label: 'Action principal', value: e.action_principal_id ? <code>{e.action_principal_id}</code> : 'Not linked: no Action Gateway mutations' },
          { label: 'Reports to', value: manager ? <button type="button" className="wf-link" onClick={() => nav.openEmployee(manager.employee_id)}>{manager.display_name}</button> : e.role_key === 'ceo' ? 'Owner' : null },
          { label: 'Markets', value: e.markets.length ? e.markets.join(', ') : 'All in scope' },
          { label: 'Daily spend cap', value: e.spend_day_cap_usd !== null ? usd(e.spend_day_cap_usd, true) : e.kind === 'human' ? 'Not metered' : null },
        ]} />
        {p.charter?.capabilities.length ? (
          <div className="wf-caps">{p.charter.capabilities.map((c) => <span key={c} className="wf-cap" title={c}>{capabilityLabel(c)}</span>)}</div>
        ) : null}
        {p.policies.length ? (
          <ul className="wf-pol-mini">
            {p.policies.map((pol) => (
              <li key={pol.policy_id} data-status={pol.status}>
                <span>{capabilityLabel(pol.action_key)}</span>
                <span className="wf-quiet">{[pol.limits?.per_day ? `${pol.limits.per_day}/day` : null, pol.review && pol.review !== 'none' ? `${pol.review.toUpperCase()} review` : 'no review', pol.status !== 'active' ? pol.status : null].filter(Boolean).join(' · ')}</span>
              </li>
            ))}
          </ul>
        ) : <p className="wf-quiet">No policy names this employee or role; the charter default applies (read allowed, internal within daily caps).</p>}
      </LCInspectorSection>
      <LCInspectorSection title="KPIs">
        {p.kpis.length ? (
          <dl className="wf-kpis is-grid">
            {p.kpis.map((k) => { const d = kpiDisplay(k); return <div key={k.kpi_key}><dt>{kpiLabel(k.kpi_key)}{k.window ? <small> · {k.window}</small> : null}</dt><dd className="lc-num">{d.unknown ? <WfUnknown reason={d.reason} /> : d.value}</dd></div> })}
          </dl>
        ) : <WfUnknown reason="No KPI has been computed for this employee" inline />}
      </LCInspectorSection>
      <LCInspectorSection title="Cost">
        {p.cost ? (
          <LCFacts rows={[
            { label: 'Today', value: p.cost.status === 'known' ? usd(p.cost.today_usd, true) : <WfUnknown reason={p.cost.reason} inline /> },
            { label: p.cost.window ? `Last ${p.cost.window}` : 'Window', value: p.cost.window_usd !== null ? usd(p.cost.window_usd, true) : <WfUnknown reason={p.cost.reason} /> },
            { label: 'Daily cap', value: p.cost.cap_usd !== null ? usd(p.cost.cap_usd, true) : 'None' },
          ]} />
        ) : <WfUnknown reason="The spend ledger is not linked to this employee" inline />}
        {p.cost?.reason && p.cost.status === 'known' ? <p className="wf-quiet">{p.cost.reason}</p> : null}
      </LCInspectorSection>
    </>
  )
}

function FactRow({ f }: { f: WfMemoryFact }) {
  const nav = useWfNav()
  return (
    <li className="wf-fact" data-epistemic={f.epistemic}>
      <span className="wf-fact__k">{humanize(f.fact_key)}<small>{f.scope}{f.scope_key && f.scope !== 'property' ? ` · ${f.scope_key}` : ''}</small></span>
      <span className="wf-fact__v">{factValue(f.value)}</span>
      <span className="wf-fact__m">
        {f.confidence !== null ? <span className="lc-num">confidence {Math.round(f.confidence * 100)}%</span> : null}
        <WfTime iso={f.valid_from} now={nav.now} />
      </span>
      {f.source_refs.length ? <WfRefs refs={f.source_refs} quiet /> : null}
    </li>
  )
}

function MemoryTab({ p }: { p: WfEmployeeProfile }) {
  const m = splitMemory(p.memory)
  return (
    <>
      <LCInspectorSection title="Verified" aside={<span className="wf-quiet">every fact cites a source</span>}>
        {m.verified.length ? <ul className="wf-facts">{m.verified.map((f) => <FactRow key={f.fact_id} f={f} />)}</ul> : <p className="wf-quiet">No verified facts.</p>}
      </LCInspectorSection>
      <LCInspectorSection title="Interpretation" aside={<span className="wf-quiet">judgement, not record</span>}>
        {m.interpretation.length ? <ul className="wf-facts is-interp">{m.interpretation.map((f) => <FactRow key={f.fact_id} f={f} />)}</ul> : <p className="wf-quiet">No interpretations.</p>}
      </LCInspectorSection>
      {m.policy.length ? (
        <LCInspectorSection title="CEO policy">
          <ul className="wf-facts is-policy">{m.policy.map((f) => <FactRow key={f.fact_id} f={f} />)}</ul>
        </LCInspectorSection>
      ) : null}
    </>
  )
}

function WorkTab({ p }: { p: WfEmployeeProfile }) {
  const nav = useWfNav()
  const list = [...p.assignments].sort((a, b) => Number(isTerminalAssignment(a.status)) - Number(isTerminalAssignment(b.status)) || Date.parse(b.updated_at ?? '') - Date.parse(a.updated_at ?? ''))
  if (!list.length) return <p className="wf-quiet">No assignments.</p>
  return (
    <ul className="wf-alist">
      {list.map((a) => (
        <li key={a.assignment_id}>
          <button type="button" className="wf-alist__row" onClick={() => nav.openAssignment(a.assignment_id, a.mission_id)}>
            <span className="wf-alist__t">{capabilityLabel(a.capability_key)}<small>{a.step_key}</small></span>
            <WfAssignmentState status={a.status} quiet={assignmentMeta(a.status).group === 'done'} />
          </button>
          {waitingReason(a) ? <p className="wf-alist__why">{waitingReason(a)}</p> : null}
          {resourceRef(a) ? <WfRefs refs={[resourceRef(a)!]} quiet /> : null}
        </li>
      ))}
    </ul>
  )
}
