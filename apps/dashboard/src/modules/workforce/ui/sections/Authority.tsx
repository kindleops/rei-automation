import { useMemo, useState } from 'react'
import { Icon } from '../../../../shared/icons'
import { LCButton, LCDataGrid, LCSkeleton, LCStatus, cx, lcConfirm, lcToast, type LCColumn } from '../../../../shared/lc'
import { getAuthority, getReports, revokePolicy } from '../../api/wf-client'
import type { WfOverview, WfPolicy, WfReportEntry } from '../../api/wf-types'
import { capabilityLabel, humanize, roleLabel, usd } from '../../model/wf-model'
import { useWf, type WfView } from '../../store/wf-hooks'
import { useWfNav } from '../wf-context'
import { WfFailureState, WfMissionState, WfPanel, WfRefs, WfSectionHead, WfTime, WfUnknown } from '../wf-parts'
import { WfReportView } from '../wf-report'

const flagValue = (v: boolean | string | null) => (v === true ? 'On' : v === false ? 'Off' : v === null ? 'Unknown' : String(v))

/** Policies, thresholds, proposed grants (display only), protective restrictions, the emergency state and the flags. */
export function AuthoritySection({ tick, overview }: { tick: number; overview: WfView<WfOverview> }) {
  const nav = useWfNav()
  const view = useWf('wf:authority', (s) => getAuthority(s), tick)
  const [showRevoked, setShowRevoked] = useState(false)
  const a = view.data
  const flags = useMemo(() => ({ ...(overview.data?.flags ?? {}), ...(a?.flags ?? {}) }), [overview.data, a])
  if (view.failure && !a) return <WfFailureState failure={view.failure} what="The authority center did not load" onRetry={view.retry} />
  if (!a) return <div className="wf-auth"><LCSkeleton shape="block" height={100} /><LCSkeleton shape="rows" count={6} /></div>
  const stop = a.emergency?.stop ?? overview.data?.runtime.emergency_stop ?? null
  const policies = a.policies.filter((p) => showRevoked || p.status === 'active')

  const revoke = async (p: WfPolicy) => {
    const ok = await lcConfirm({
      title: `Revoke ${capabilityLabel(p.action_key)} for ${p.employee_id ? nav.employees.get(p.employee_id)?.display_name ?? p.employee_id : roleLabel(p.role_key ?? '')}?`,
      effects: [
        { text: 'The engine stops allowing this action under this policy at the next evaluation', kind: 'stops' },
        { text: 'The charter default still applies (read allowed, internal within daily caps)', kind: 'note' },
        { text: 'The policy stays on record as revoked', kind: 'keeps' },
      ],
      confirmLabel: 'Revoke policy',
      tone: 'danger',
      nativeText: `Revoke policy ${p.policy_id}?`,
    })
    if (!ok) return
    const r = await revokePolicy(p.policy_id)
    if (r.ok) { lcToast({ title: 'Policy revoked', detail: capabilityLabel(p.action_key), severity: 'info' }); view.retry() }
    else lcToast({ title: 'The policy was not revoked', detail: r.message, severity: 'critical' })
  }

  const columns: LCColumn<WfPolicy>[] = [
    { id: 'who', header: 'Applies to', minWidth: 170, render: (p) => (p.employee_id ? <b>{nav.employees.get(p.employee_id)?.display_name ?? p.employee_id}</b> : roleLabel(p.role_key ?? 'any')) },
    { id: 'action', header: 'Action', minWidth: 170, render: (p) => <span className="wf-cell-step" title={p.action_key}><b>{capabilityLabel(p.action_key)}</b></span> },
    { id: 'scope', header: 'Scope', width: 170, render: (p) => [p.scope?.markets?.join(', '), p.scope?.resource_types?.join(', '), p.scope?.property_types?.join(', ')].filter(Boolean).join(' · ') || <span className="wf-quiet">Any</span> },
    { id: 'limits', header: 'Limits', width: 160, render: (p) => [p.limits?.per_day ? `${p.limits.per_day}/day` : null, p.limits?.max_usd ? `${usd(p.limits.max_usd, true)} max` : null, p.limits?.max_price ? `price < ${usd(p.limits.max_price)}` : null].filter(Boolean).join(' · ') || <span className="wf-quiet">Daily caps</span> },
    { id: 'risk', header: 'Risk', width: 74, render: (p) => (p.risk ? humanize(p.risk) : <span className="wf-quiet">Any</span>) },
    { id: 'review', header: 'Review', width: 80, render: (p) => (p.review && p.review !== 'none' ? p.review.toUpperCase() : <span className="wf-quiet">None</span>) },
    { id: 'valid', header: 'Valid until', width: 108, render: (p) => (p.valid_until ? <WfTime iso={p.valid_until} now={nav.now} /> : <span className="wf-quiet">Open</span>) },
    { id: 'status', header: 'Status', width: 118, render: (p) => <span className="wf-pol-status"><LCStatus label={humanize(p.status)} tone={p.status === 'active' ? 'ok' : 'neutral'} quiet />{p.version ? <small className="lc-num">v{p.version}</small> : null}</span> },
    { id: 'act', header: '', width: 84, render: (p) => (p.status === 'active' ? <LCButton size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); void revoke(p) }}>Revoke</LCButton> : null) },
  ]

  return (
    <div className="wf-auth">
      <WfSectionHead title="Authority Center" sub="What each employee may do, what escalates to you, and what protects the seller. Grants stay owner-created in the Action Gateway." />
      <div className="wf-auth__top">
        <WfPanel title="Emergency stop" icon="alert-circle" className={cx('wf-estop', stop === true && 'is-on')}>
          <div className="wf-estop__v">
            <span className="wf-dot" data-tone={stop === true ? 'crit' : stop === false ? 'ok' : 'neutral'} />
            <b>{stop === true ? 'ON: the runtime claims nothing' : stop === false ? 'Off' : <WfUnknown reason="The runtime did not report its emergency state" />}</b>
          </div>
          {a.emergency?.reason ? <p>{a.emergency.reason}</p> : null}
          {a.emergency?.since ? <p className="wf-quiet">Since <WfTime iso={a.emergency.since} now={nav.now} /></p> : null}
          <p className="wf-quiet">Only the owner sets or lifts it.</p>
        </WfPanel>
        <WfPanel title="Escalation" icon="flag">
          <dl className="wf-kv">
            <div><dt>Executive review price</dt><dd className="lc-num">{a.settings?.exec_review_price_usd !== null && a.settings?.exec_review_price_usd !== undefined ? usd(a.settings.exec_review_price_usd) : <WfUnknown reason="Settings were not returned" />}</dd></div>
            {Object.entries(a.settings?.escalation ?? {}).map(([k, v]) => <div key={k}><dt>{humanize(k)}</dt><dd className="lc-num">{typeof v === 'boolean' ? (v ? 'Escalates' : 'Ignored') : String(v)}</dd></div>)}
          </dl>
          <p className="wf-quiet">A price at or above the threshold, valuation uncertainty or title ambiguity creates a CEO assignment with the reasons. It is never a silent block.</p>
        </WfPanel>
        <WfPanel title="Flags" icon="settings">
          <dl className="wf-kv is-flags">
            {Object.entries(flags).map(([k, v]) => <div key={k}><dt><code>{k}</code></dt><dd data-v={String(v)}>{flagValue(v)}</dd></div>)}
          </dl>
          {!Object.keys(flags).length ? <WfUnknown reason="No flags were reported" inline /> : null}
        </WfPanel>
      </div>
      <WfPanel title="Policies" icon="key" aside={<button type="button" className="wf-link" onClick={() => setShowRevoked((v) => !v)}>{showRevoked ? 'Hide revoked' : `Show revoked (${a.policies.filter((p) => p.status !== 'active').length})`}</button>} flush>
        <div className="wf-pgrid" style={{ height: Math.min(440, 52 + Math.max(2, policies.length) * 40) }}>
          <LCDataGrid<WfPolicy> id="wf-policies" label="Policies" rows={policies} rowKey={(p) => p.policy_id} columns={columns} density="standard" empty={{ title: 'No policies', body: 'With no policy the charter default applies: read allowed, internal within the daily caps.' }} height="100%" />
        </div>
      </WfPanel>
      <div className="wf-split">
        <WfPanel title="Proposed grants" icon="briefcase" aside={<span className="wf-chip-quiet">Display only</span>}>
          {a.proposed_grants.length ? (
            <ul className="wf-grants">
              {a.proposed_grants.map((g, i) => (
                <li key={i}>
                  <div className="wf-grants__h"><code>{g.action}</code><span>{g.employee_id ? nav.employees.get(g.employee_id)?.display_name ?? g.employee_id : 'Any principal'}</span></div>
                  <div className="wf-grants__m">
                    {g.agent_id ? <span>principal <code>{g.agent_id}</code></span> : <span className="wf-warn">No Action Gateway principal linked</span>}
                    {g.limits ? <span>{Object.entries(g.limits).map(([k, v]) => `${humanize(k)} ${String(v)}`).join(' · ')}</span> : null}
                    {g.scope ? <span>{Object.entries(g.scope).map(([k, v]) => `${humanize(k)} ${Array.isArray(v) ? v.join(', ') : String(v)}`).join(' · ')}</span> : null}
                  </div>
                  {g.note ? <p className="wf-quiet">{g.note}</p> : null}
                </li>
              ))}
            </ul>
          ) : <p className="wf-quiet">No grant is proposed. Phase A ships no T2 call path.</p>}
        </WfPanel>
        <WfPanel title="Protective restrictions" icon="shield">
          {a.restrictions.length ? (
            <ul className="wf-restr">
              {a.restrictions.map((r, i) => (
                <li key={i} data-kind={r.kind}>
                  <span className="wf-restr__k">{humanize(r.kind)}</span>
                  <div><b>{r.label}</b>{r.reason ? <p>{r.reason}</p> : null}{r.refs.length ? <WfRefs refs={r.refs} quiet /> : null}</div>
                  {r.since ? <WfTime iso={r.since} now={nav.now} /> : null}
                </li>
              ))}
            </ul>
          ) : <WfUnknown reason="The holds and exclusions registry was not returned" inline />}
          <p className="wf-quiet">Holds, static exclusions and suppression are honoured before any capability runs.</p>
        </WfPanel>
      </div>
    </div>
  )
}

/** Mission reports and the daily brief. */
export function ReportsSection({ tick, selected, onSelect }: { tick: number; selected: string | null; onSelect: (id: string | null) => void }) {
  const nav = useWfNav()
  const view = useWf('wf:reports', (s) => getReports(s), tick)
  if (view.failure && !view.data) return <WfFailureState failure={view.failure} what="Reports did not load" onRetry={view.retry} />
  if (!view.data) return <div className="wf-reports"><LCSkeleton shape="rows" count={6} /></div>
  const list = [...view.data.reports].sort((a, b) => Date.parse(b.completed_at ?? '') - Date.parse(a.completed_at ?? ''))
  const cur: WfReportEntry | null = list.find((r) => r.mission_id === selected) ?? list[0] ?? null
  const brief = view.data.daily_brief
  return (
    <div className="wf-reports">
      <aside className="wf-reports__list">
        <WfSectionHead title="Reports" sub={`${list.length} mission report${list.length === 1 ? '' : 's'}`} />
        <WfPanel title="Daily brief" icon="briefing" className="wf-brief">
          {!brief ? <WfUnknown reason="No daily brief source is linked" inline /> : !brief.available ? <WfUnknown reason={brief.code ? `Not available: ${humanize(brief.code)}` : 'The review digest has not run'} inline /> : (
            <>
              {brief.summary ? <p>{brief.summary}</p> : null}
              {brief.items.length ? <ul className="wf-bullets">{brief.items.map((x) => <li key={x}>{x}</li>)}</ul> : null}
              {brief.generated_at ? <p className="wf-quiet">conversation.review_digest · <WfTime iso={brief.generated_at} now={nav.now} /></p> : null}
            </>
          )}
        </WfPanel>
        <ul className="wf-mlist">
          {list.map((r) => (
            <li key={r.mission_id}>
              <button type="button" className={cx('wf-mrow', cur?.mission_id === r.mission_id && 'is-on')} onClick={() => onSelect(r.mission_id)}>
                <span className="wf-mrow__top"><span className="wf-mrow__k">Mission report</span>{r.status ? <WfMissionState status={r.status} /> : null}</span>
                <span className="wf-mrow__t">{r.title}</span>
                <span className="wf-mrow__m"><WfTime iso={r.completed_at ?? r.report?.generated_at} now={nav.now} />{r.report ? <span>{r.report.ranked.length ? `${r.report.ranked.length} ranked` : `${r.report.completed.length} completed`}</span> : null}</span>
              </button>
            </li>
          ))}
        </ul>
        {!list.length ? <p className="wf-quiet wf-pad">No mission has reported yet.</p> : null}
      </aside>
      <div className="wf-reports__detail">
        {cur?.report ? (
          <article className="wf-mdetail">
            <header className="wf-mdetail__h">
              <button type="button" className="wf-back" onClick={() => onSelect(null)}><Icon name="chevron-left" size={13} />Reports</button>
              <div className="wf-mdetail__k"><span>Mission report</span>{cur.status ? <WfMissionState status={cur.status} /> : null}</div>
              <h2 className="wf-mdetail__t"><button type="button" className="wf-link is-title" onClick={() => nav.openMission(cur.mission_id)}>{cur.title}</button></h2>
            </header>
            <WfReportView report={cur.report} />
          </article>
        ) : cur ? <p className="wf-quiet wf-pad">This mission has no report.</p> : null}
      </div>
    </div>
  )
}
