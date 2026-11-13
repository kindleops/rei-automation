import { useMemo } from 'react'
import { LCSkeleton, cx } from '../../../../shared/lc'
import type { WfEmployee, WfOverview } from '../../api/wf-types'
import { buildOrgTree, DEPARTMENT_META, EMPLOYEE_STATUS_STATE, HEARTBEAT_META, heartbeatOf, roleLabel, type OrgDepartment } from '../../model/wf-model'
import type { WfView } from '../../store/wf-hooks'
import { useWfNav } from '../wf-context'
import { WfAvatar, WfFailureState, WfKind, WfSectionHead, WfTime } from '../wf-parts'

/**
 * The org chart: the CEO, the executive staff, then every department with
 * its head and its people. Human and AI are marked on every card; status,
 * heartbeat and open assignments are what the overview reports, nothing more.
 */
export function OrganizationSection({ overview }: { overview: WfView<WfOverview> }) {
  const tree = useMemo(() => (overview.data ? buildOrgTree(overview.data.employees, overview.data.departments) : []), [overview.data])
  if (overview.failure && !overview.data) return <WfFailureState failure={overview.failure} what="The organization did not load" onRetry={overview.retry} />
  if (!overview.data) return <div className="wf-org"><LCSkeleton shape="block" height={120} /><LCSkeleton shape="block" height={260} /></div>
  const exec = tree.find((d) => d.key === 'executive')
  const finance = tree.find((d) => d.key === 'finance')
  const ceo = exec?.head ?? null
  const staff = [...(exec?.members ?? []), ...(finance?.head ? [finance.head] : [])]
  const depts = tree.filter((d) => d.key !== 'executive' && !(d.key === 'finance' && !d.members.length))
  const all = overview.data.employees.filter((e) => e.status !== 'retired')
  const ai = all.filter((e) => e.kind === 'ai').length
  return (
    <div className="wf-org">
      <WfSectionHead
        title="Organization"
        sub={<>{all.length} people · <b>{ai}</b> AI · <b>{all.length - ai}</b> human · {depts.length + 1} departments</>}
      />
      <div className="wf-org__chart">
        <div className="wf-org__tier is-top">{ceo ? <OrgCard e={ceo} lead /> : <Vacancy role="ceo" />}</div>
        <div className="wf-org__tier is-staff">
          {staff.length ? staff.map((e) => <OrgCard key={e.employee_id} e={e} lead />) : <Vacancy role="coo" />}
        </div>
        <div className="wf-org__depts" style={{ ['--wf-cols' as string]: depts.length }}>
          {depts.map((d) => <DeptColumn key={d.key} d={d} />)}
        </div>
      </div>
    </div>
  )
}

function DeptColumn({ d }: { d: OrgDepartment }) {
  const members = d.members
  return (
    <section className="wf-dept" aria-label={d.label}>
      <header className="wf-dept__h">
        <span className="wf-dept__t">{d.label}</span>
        <span className="wf-dept__m">
          <span className="lc-num">{d.headcount}</span> {d.headcount === 1 ? 'person' : 'people'}
          {d.open !== null ? <> · <span className="lc-num">{d.open}</span> open</> : null}
        </span>
      </header>
      {d.key === 'finance' ? null : d.head ? <OrgCard e={d.head} /> : <Vacancy role={DEPARTMENT_META[d.key]?.head[0] ?? d.key} />}
      {members.length ? (
        <ul className="wf-dept__list">
          {members.map((e) => <li key={e.employee_id}><OrgCard e={e} compact /></li>)}
        </ul>
      ) : d.head ? <p className="wf-dept__none">No agents yet{d.key === 'acquisitions' ? '. The CEO creates them per market.' : ''}</p> : null}
    </section>
  )
}

function OrgCard({ e, lead, compact }: { e: WfEmployee; lead?: boolean; compact?: boolean }) {
  const nav = useWfNav()
  const hb = heartbeatOf(e, nav.now)
  const status = EMPLOYEE_STATUS_STATE[e.status] ?? { label: e.status, tone: 'neutral' }
  const dot = e.status !== 'active' ? status.tone : e.kind === 'human' ? 'neutral' : HEARTBEAT_META[hb].tone
  const pulse = e.kind === 'ai' && e.status === 'active' ? HEARTBEAT_META[hb].label : status.label
  const open = e.open_assignments === null ? <span className="wf-quiet" title="Not reported">Unknown</span> : <><b className="lc-num">{e.open_assignments}</b> open</>
  const kindInRole = !lead
  return (
    <button type="button" className={cx('wf-oc', lead && 'is-lead', compact && 'is-compact', e.status !== 'active' && 'is-dim')} onClick={() => nav.openEmployee(e.employee_id)} title={[e.display_name, e.employee_code, roleLabel(e.role_key), e.markets.join(', ')].filter(Boolean).join(' · ')}>
      <WfAvatar e={e} size={compact ? 24 : lead ? 34 : 30} />
      <span className="wf-oc__n">{e.display_name}{e.employee_code && lead ? <code>{e.employee_code}</code> : null}</span>
      {lead ? <WfKind kind={e.kind} /> : null}
      <span className="wf-oc__r">
        {kindInRole ? <WfKind kind={e.kind} /> : null}
        {compact ? <span className="wf-oc__open">{open}</span> : null}
        {compact ? <span className="wf-oc__role">{e.markets.length ? e.markets.join(', ') : roleLabel(e.role_key)}</span> : <span className="wf-oc__role">{!lead && /^head_|^ops_supervisor$/.test(e.role_key) ? 'Department head' : roleLabel(e.role_key)}{e.markets.length && lead ? <span className="wf-oc__mk"> · {e.markets.join(', ')}</span> : null}</span>}
      </span>
      {!compact ? (
        <>
          <span className="wf-oc__s">
            <span className="wf-dot" data-tone={dot} />
            {e.kind === 'human' ? (e.last_activity_at ? <>Active <WfTime iso={e.last_activity_at} now={nav.now} /></> : status.label) : e.status === 'active' ? <>{pulse}{e.heartbeat_at ? <> · <WfTime iso={e.heartbeat_at} now={nav.now} /></> : null}</> : status.label}
          </span>
          <span className="wf-oc__open">{open}</span>
        </>
      ) : <span className="wf-dot is-abs" data-tone={dot} title={pulse} />}
    </button>
  )
}

function Vacancy({ role }: { role: string }) {
  return <div className="wf-oc is-vacant"><span className="wf-oc__main"><span className="wf-oc__n">Vacant</span><span className="wf-oc__r">{roleLabel(role)}</span></span></div>
}
