import { useMemo } from 'react'
import { Icon } from '../../../../shared/icons'
import { LCSkeleton, LCStatus } from '../../../../shared/lc'
import type { WfEmployee, WfKpi, WfMission, WfRankedItem, WfReports } from '../../api/wf-types'
import { costRollup, evSummary, kpiDisplay, latestTriage, researchFindings, usd, verdictCounts, verdictMeta } from '../../model/wf-model'
import type { WfView } from '../../store/wf-hooks'
import { useWfNav } from '../wf-context'
import { WfFailureState, WfPanel, WfRefChip, WfRefs, WfSectionHead, WfStat, WfTime, WfUnknown } from '../wf-parts'
import { WfRankedTable } from '../wf-report'

/** Ranked opportunities from the latest triage report, and what research found. Every row traces to a report. */
export function IntelligenceSection({ reports, missions }: { reports: WfView<WfReports>; missions: WfView<WfMission[]> }) {
  const nav = useWfNav()
  if (reports.failure && !reports.data) return <WfFailureState failure={reports.failure} what="Reports did not load" onRetry={reports.retry} />
  if (!reports.data) return <div className="wf-intel"><LCSkeleton shape="block" height={90} /><LCSkeleton shape="rows" count={8} /></div>
  const triage = latestTriage(reports.data.reports, missions.data ?? [])
  const r = triage?.report ?? null
  const vc = r ? verdictCounts(r.ranked) : null
  const ev = r ? evSummary(r.ranked) : null
  const findings = researchFindings(r)
  return (
    <div className="wf-intel">
      <WfSectionHead
        title="Intelligence"
        sub={triage ? <>From <button type="button" className="wf-link" onClick={() => nav.openMission(triage.mission_id)}>{triage.title}</button>, reported <WfTime iso={triage.completed_at ?? r?.generated_at} now={nav.now} /></> : 'No triage report yet'}
      />
      {!r ? (
        <WfPanel>
          <p className="wf-quiet">No opportunity triage has completed. Ask the COO to "find the 10 most promising opportunities" and the ranked list appears here when the report is written.</p>
        </WfPanel>
      ) : (
        <>
          <div className="wf-stats">
            <WfStat label="Ranked" value={r.ranked.length} sub="from the latest triage" />
            <WfStat label="CFO supported" value={vc!.supported} sub={`${vc!.challenge} challenged · ${vc!.insufficient_evidence} insufficient`} tone="ok" />
            <WfStat label="EV known" value={<>{ev!.known}<small>/{ev!.total}</small></>} sub="EV only when calibrated inputs exist" />
            <WfStat label="Known EV, summed" value={usd(ev!.sum)} unknown={ev!.sum === null ? 'No opportunity has a calibrated EV' : null} sub={ev!.known < ev!.total ? `${ev!.total - ev!.known} unknown not counted` : 'all known'} />
            <WfStat label="Escalations" value={r.escalations.length} tone={r.escalations.length ? 'attn' : null} sub="wait for the CEO" />
          </div>
          <WfPanel title="Ranked opportunities" icon="target" aside={<span className="wf-quiet">contact and identity first, then pressure, then deal quality</span>} flush>
            <WfRankedTable ranked={r.ranked} />
          </WfPanel>
          <div className="wf-split">
            <WfPanel title="Research findings" icon="search" aside={<span className="wf-count lc-num">{findings.length}</span>}>
              {findings.length ? (
                <ul className="wf-findings">
                  {findings.map((f, i) => (
                    <li key={`${f.assignment_id ?? i}`}>
                      <Icon name="check" size={12} />
                      <div><span>{f.label}</span>{f.refs.length ? <WfRefs refs={f.refs} quiet /> : null}</div>
                    </li>
                  ))}
                </ul>
              ) : <p className="wf-quiet">No research completed in this report.</p>}
              {r.pending.filter((p) => /research/i.test(p.label) || /research/.test(p.step_key ?? '')).map((p, i) => (
                <div key={`p${i}`} className="wf-finding-pending"><Icon name="clock" size={12} /><span>{p.label}</span></div>
              ))}
            </WfPanel>
            <WfPanel title="Needs the CEO" icon="flag" aside={<span className="wf-count lc-num">{r.escalations.length}</span>}>
              {r.escalations.length ? (
                <ul className="wf-findings is-attn">
                  {r.escalations.map((e, i) => (
                    <li key={i}><Icon name="flag" size={12} /><div><span>{e.label}</span>{e.reasons.length ? <small>{e.reasons.join(' · ')}</small> : null}{e.refs.length ? <WfRefs refs={e.refs} quiet /> : null}</div></li>
                  ))}
                </ul>
              ) : <p className="wf-quiet">Nothing escalated.</p>}
              {r.refused.length ? (
                <ul className="wf-findings is-crit">
                  {r.refused.map((e, i) => (
                    <li key={`r${i}`}><Icon name="shield" size={12} /><div><span>{e.label}</span>{e.reasons.length ? <small>{e.reasons[0]}</small> : null}{e.refs.length ? <WfRefs refs={e.refs} quiet /> : null}</div></li>
                  ))}
                </ul>
              ) : null}
            </WfPanel>
          </div>
        </>
      )}
    </div>
  )
}

/** Costs from report.costs only; CFO verdicts across reports; caps from the roster. Unknown when absent, never 0. */
export function FinanceSection({ reports, kpis, employees }: { reports: WfView<WfReports>; kpis: WfView<WfKpi[]>; employees: ReadonlyArray<WfEmployee> }) {
  const nav = useWfNav()
  const roll = useMemo(() => costRollup(reports.data?.reports ?? []), [reports.data])
  const ranked = useMemo(() => (reports.data?.reports ?? []).flatMap((x) => (x.report?.ranked ?? []).map((it) => ({ it, mission: x.title, mission_id: x.mission_id }))), [reports.data])
  const vc = verdictCounts(ranked.map((x) => x.it))
  const jobs = (reports.data?.reports ?? []).flatMap((x) => (x.report?.costs?.status === 'known' ? x.report.costs.by_job.map((l) => ({ ...l, mission: x.title })) : []))
  const spend = (kpis.data ?? []).find((k) => k.subject_type === 'org' && k.kpi_key === 'spend_usd') ?? null
  const caps = employees.filter((e) => e.kind === 'ai' && e.status === 'active')
  const capsKnown = caps.filter((e) => e.spend_day_cap_usd !== null)
  if (reports.failure && !reports.data) return <WfFailureState failure={reports.failure} what="Financial performance did not load" onRetry={reports.retry} />
  if (!reports.data) return <div className="wf-fin"><LCSkeleton shape="block" height={90} /><LCSkeleton shape="rows" count={6} /></div>
  const total = vc.supported + vc.challenge + vc.insufficient_evidence + vc.none
  const challenged = ranked.filter((x) => x.it.cfo_verdict?.verdict === 'challenge')
  return (
    <div className="wf-fin">
      <WfSectionHead title="Financial Performance" sub="What Workforce spent, and what the CFO concluded. Costs come from mission reports only." />
      <div className="wf-stats">
        <WfStat label="Mission spend" value={usd(roll.total_usd, true)} unknown={roll.total_usd === null ? (roll.missions.length ? `${roll.unknown} of ${roll.missions.length} reports have no known cost` : 'No mission report yet') : null} sub={roll.missions.length ? `${roll.known} of ${roll.missions.length} reports priced` : undefined} />
        <WfStat label="Spend, 7 days" value={spend ? kpiDisplay(spend).value : null} unknown={!spend ? 'The spend KPI was not computed' : kpiDisplay(spend).unknown ? kpiDisplay(spend).reason : null} sub="agent.spend_ledger" />
        <WfStat label="AI daily caps" value={usd(capsKnown.reduce((a, e) => a + (e.spend_day_cap_usd ?? 0), 0), true)} unknown={!capsKnown.length ? 'No AI employee has a cap recorded' : null} sub={`${capsKnown.length} of ${caps.length} active AI employees capped`} />
        <WfStat label="CFO reviews" value={total} sub={total ? `${vc.supported} supported · ${vc.challenge} challenged` : 'none yet'} />
      </div>
      <div className="wf-split">
        <WfPanel title="Cost by mission" icon="dollar-sign">
          {!roll.missions.length ? <p className="wf-quiet">No mission report yet.</p> : (
            <ul className="wf-ledger">
              {roll.missions.map((m) => (
                <li key={m.mission_id}>
                  <button type="button" className="wf-link" onClick={() => nav.openMission(m.mission_id)}>{m.title}</button>
                  <WfTime iso={m.at} now={nav.now} />
                  <span className="lc-num wf-ledger__v">{m.usd === null ? <WfUnknown reason={m.reason} /> : usd(m.usd, true)}</span>
                </li>
              ))}
            </ul>
          )}
          {jobs.length ? (
            <>
              <h4 className="wf-sub">Runtime jobs</h4>
              <ul className="wf-ledger is-jobs">
                {jobs.map((j, i) => (
                  <li key={j.runtime_job_id ?? i}>
                    {j.runtime_job_id ? <WfRefChip r={{ type: 'job', id: j.runtime_job_id, label: j.kind ?? j.runtime_job_id }} quiet /> : <span>{j.kind ?? 'Job'}</span>}
                    <span className="wf-quiet">{j.mission}</span>
                    <span className="lc-num wf-ledger__v">{j.usd === null ? <WfUnknown /> : usd(j.usd, true)}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </WfPanel>
        <WfPanel title="CFO verdicts" icon="shield">
          {!total ? <p className="wf-quiet">The CFO has not reviewed a ranked opportunity yet.</p> : (
            <>
              <div className="wf-verdicts">
                {(['supported', 'challenge', 'insufficient_evidence'] as const).map((k) => (
                  <div key={k} className="wf-verdicts__r" data-v={k}>
                    <LCStatus label={verdictMeta(k).label} tone={verdictMeta(k).tone} quiet />
                    <span className="wf-verdicts__bar"><i style={{ width: `${(vc[k] / total) * 100}%` }} /></span>
                    <b className="lc-num">{vc[k]}</b>
                  </div>
                ))}
                {vc.none ? <div className="wf-verdicts__r" data-v="none"><LCStatus label="Not reviewed" tone="neutral" hollow /><span className="wf-verdicts__bar"><i style={{ width: `${(vc.none / total) * 100}%` }} /></span><b className="lc-num">{vc.none}</b></div> : null}
              </div>
              {challenged.length ? (
                <>
                  <h4 className="wf-sub">Challenged</h4>
                  <ul className="wf-findings is-attn">
                    {challenged.map(({ it }: { it: WfRankedItem }, i) => (
                      <li key={i}><Icon name="alert" size={12} /><div><span>{it.label ?? 'Opportunity'}</span><small>{it.cfo_verdict?.reasons.join(' · ')}</small></div></li>
                    ))}
                  </ul>
                </>
              ) : null}
            </>
          )}
        </WfPanel>
      </div>
    </div>
  )
}
