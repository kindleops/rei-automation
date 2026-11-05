/**
 * WORKFORCE × AGNTEI — the Employees additions (docs/WORKFORCE-AGNTEI.md §1, §4): origin / employment badges, the
 * truthful activity, the link + binding of an Agntei employee, the owner's link steps (copyable; NOTHING here runs a
 * command), the per-employee action history and the "Register an Agntei agent" dialog (CEO only: the server checks).
 */
import { useState } from 'react'
import { LCButton, LCDialog, LCFacts, LCInspectorSection, LCSelect, LCStatus, cx, lcToast } from '../../../shared/lc'
import { registerAgnteiAgent } from '../api/wf-client'
import type { WfActivity, WfEmployee, WfEmployeeProfile, WfLinkSteps, WfRegisterResult } from '../api/wf-types'
import { AGNTEI_ROLES, EMPLOYMENT_LABEL, activityText, employeeIdFrom, lastSeenText, mergeHistory, originBadge, registerProblems } from '../model/wf-agntei-model'
import { roleLabel } from '../model/wf-model'
import { WfTime, WfUnknown } from './wf-parts'
import './wf-agntei.css'

export function WfOriginBadge({ e }: { e: Pick<WfEmployee, 'origin' | 'employment_type' | 'kind'> }) {
  const b = originBadge(e)
  return <span className={cx('wf-origin', `is-${b.kind}`)} title={b.title}>{b.label}</span>
}

export function WfActivityStatus({ activity, now, compact }: { activity: WfActivity | null | undefined; now: number; compact?: boolean }) {
  const t = activityText(activity, now)
  if (!t) return <WfUnknown reason="The server did not report this employee's activity" />
  return (
    <span className={cx('wf-activity', compact && 'is-compact')} data-state={t.state}>
      <LCStatus label={t.label} tone={t.tone} quiet={t.state === 'idle'} title={t.detail ? `${t.label}, ${t.detail}` : t.label} />
      {t.detail && !compact ? <span className="wf-activity__seen">{t.detail}</span> : null}
    </span>
  )
}

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text)
    lcToast({ severity: 'success', title: `${what} copied`, detail: 'Nothing was run: paste it where the step says.' })
  } catch {
    lcToast({ severity: 'warning', title: 'Copy failed', detail: 'Select the text and copy it by hand.' })
  }
}

export function WfLinkStepsList({ steps }: { steps: WfLinkSteps }) {
  return (
    <ol className="wf-steps" aria-label="Owner link steps">
      {steps.steps.map((s, i) => (
        <li key={s.id} className="wf-step" data-who={s.who}>
          <div className="wf-step__h">
            <span className="wf-step__n lc-num">{i + 1}</span>
            <span className="wf-step__t">{s.title}</span>
            <span className="wf-step__who">{s.who === 'owner' ? 'Owner' : s.who === 'operator' ? 'Operator' : 'Agent'}</span>
            <LCButton size="sm" variant="quiet" onClick={() => { void copy(s.command, s.title) }}>Copy</LCButton>
          </div>
          <pre className="wf-step__cmd"><code>{s.command}</code></pre>
          {s.note ? <p className="wf-step__note">{s.note}</p> : null}
        </li>
      ))}
    </ol>
  )
}

/** The Agntei link + binding of an employee (Profile tab), and the owner's steps while it is not linked. */
export function WfAgnteiLinkSection({ p, now }: { p: WfEmployeeProfile; now: number }) {
  const e = p.employee
  if (e.origin !== 'agntei') return null
  const l = p.link
  const binding = !l?.principal_id ? 'Not bound: the owner binds a minted principal'
    : l.binding_revoked_at ? 'Revoked by the owner'
      : l.binding_valid_until && Date.parse(l.binding_valid_until) <= now ? 'Expired: the owner re-binds it' : null
  return (
    <LCInspectorSection title="Agntei link" aside={<WfOriginBadge e={e} />}>
      <LCFacts rows={[
        { label: 'Employment', value: e.employment_type ? EMPLOYMENT_LABEL[e.employment_type] : null },
        { label: 'Action principal', value: l?.principal_id ? <code>{l.principal_id}</code> : 'Not bound' },
        { label: 'Binding', value: binding ?? (l?.binding_valid_until ? <>Valid until <WfTime iso={l.binding_valid_until} now={now} /></> : null) },
        { label: 'Link window', value: l?.linked ? 'Linked' : l?.link_expires_at ? <>Open until <WfTime iso={l.link_expires_at} now={now} /></> : 'Not open' },
        { label: 'Agntei agent', value: l?.external_agent_id ? <code>{l.external_agent_id}</code> : 'Not linked yet' },
        { label: 'Install', value: l?.external_install_id ? <code>{l.external_install_id}</code> : null },
        { label: 'Seen', value: lastSeenText(e.heartbeat_at, now) },
      ]} />
      {e.skills.length ? <div className="wf-caps">{e.skills.map((s) => <span key={s} className="wf-cap">{s.replace(/_/g, ' ')}</span>)}</div> : null}
      {p.link_steps ? (
        <div className="wf-steps-wrap">
          <p className="wf-quiet">Registration grants nothing. The owner runs these steps; the agent then links itself once, inside the window.</p>
          <WfLinkStepsList steps={p.link_steps} />
        </div>
      ) : null}
    </LCInspectorSection>
  )
}

/** Per-employee action history: the Workforce events + the Action Gateway audit of its principal. */
export function WfHistoryTab({ p, now }: { p: WfEmployeeProfile; now: number }) {
  const h = p.history
  if (!h) return <WfUnknown reason="The server did not return this employee's history" inline />
  const rows = mergeHistory(h.events, h.gateway)
  return (
    <>
      {!h.gateway_available && p.employee.action_principal_id ? <p className="wf-quiet">The Action Gateway audit is not readable here{h.gateway_reason ? ` (${h.gateway_reason.replace(/_/g, ' ')})` : ''}; only Workforce events are shown.</p> : null}
      {rows.length ? (
        <ul className="wf-hist">
          {rows.map((r) => (
            <li key={r.key} className="wf-hist__row" data-source={r.source}>
              <span className="wf-hist__src">{r.source === 'gateway' ? 'Gateway' : 'Workforce'}</span>
              <span className="wf-hist__what">{r.what}{r.code ? <code>{r.code}</code> : null}</span>
              <WfTime iso={r.at} now={now} />
            </li>
          ))}
        </ul>
      ) : <p className="wf-quiet">No actions recorded yet.</p>}
    </>
  )
}

const slugs = (v: string) => [...new Set(v.split(/[,\n]/).map((x) => x.trim()).filter(Boolean))].slice(0, 20)

/** "Register an Agntei agent" — CEO only (the server answers 403 otherwise). Creates a pending_link employee; runs nothing. */
export function WfRegisterAgnteiDialog({ open, onOpenChange, onRegistered }: { open: boolean; onOpenChange: (o: boolean) => void; onRegistered?: (r: WfRegisterResult) => void }) {
  const [name, setName] = useState('')
  const [id, setId] = useState<string | null>(null)
  const [role, setRole] = useState<string>('research_analyst')
  const [markets, setMarkets] = useState('')
  const [skills, setSkills] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<WfRegisterResult | null>(null)
  const employee_id = id ?? employeeIdFrom(name)
  const problems = registerProblems({ employee_id, display_name: name, role_key: role, markets: slugs(markets) })
  const reset = () => { setName(''); setId(null); setMarkets(''); setSkills(''); setError(null); setDone(null) }
  async function submit() {
    if (problems.length || !employee_id) return
    setBusy(true); setError(null)
    const r = await registerAgnteiAgent({ employee_id, role_key: role, display_name: name.trim(), markets: slugs(markets), skills: slugs(skills) })
    setBusy(false)
    if (!r.ok) { setError(r.message); return }
    setDone(r.data)
    onRegistered?.(r.data)
  }
  return (
    <LCDialog
      open={open}
      onOpenChange={(o) => { if (!o) reset(); onOpenChange(o) }}
      title={done ? 'Agntei agent registered' : 'Register an Agntei agent'}
      description={done ? 'Pending link. Nothing was minted, granted or run: the owner runs the steps below.' : 'Creates a pending_link employee for an operator-directed Agntei agent. It grants nothing and runs nothing.'}
      width={640}
      footer={done ? <LCButton variant="primary" onClick={() => { reset(); onOpenChange(false) }}>Done</LCButton> : (
        <>
          <LCButton variant="quiet" onClick={() => onOpenChange(false)}>Cancel</LCButton>
          <LCButton variant="primary" loading={busy} disabled={problems.length > 0} onClick={() => { void submit() }}>Register</LCButton>
        </>
      )}
    >
      {done?.link ? <WfLinkStepsList steps={done.link} /> : (
        <div className="wf-reg">
          <label className="lc-field"><span className="lc-field__label">Name</span><input className="lc-field__input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Ridge" /></label>
          <label className="lc-field"><span className="lc-field__label">Employee id</span><input className="lc-field__input wf-reg__mono" value={employee_id ?? ''} maxLength={44} onChange={(e) => setId(e.target.value || null)} placeholder="emp_ridge" /></label>
          <div className="lc-field"><span className="lc-field__label">Role</span>
            <LCSelect label="Role" value={role} onChange={setRole} options={AGNTEI_ROLES.map((r) => ({ value: r, label: roleLabel(r) }))} variant="field" />
          </div>
          <label className="lc-field"><span className="lc-field__label">Markets</span><input className="lc-field__input" value={markets} onChange={(e) => setMarkets(e.target.value)} placeholder="Dallas, TX" /></label>
          <label className="lc-field wf-reg__wide"><span className="lc-field__label">Skills</span><input className="lc-field__input" value={skills} onChange={(e) => setSkills(e.target.value)} placeholder="probate, title research" /></label>
          {problems.length && name ? <ul className="wf-reg__problems">{problems.map((p) => <li key={p}>{p}</li>)}</ul> : null}
          {error ? <p className="wf-reg__error" role="alert">{error}</p> : null}
        </div>
      )}
    </LCDialog>
  )
}
