import { useEffect, useState, type FormEvent } from 'react'
import { LCButton, LCError, LCSkeleton, LCStatus } from '../../../shared/lc'
import {
  fetchEventTypes, fetchPermissions, fetchTeam, saveEventType, saveResource, schedulingErrorText, setPoolMember,
  type EventTypeConfig, type TeamMember, type TeamPool,
} from '../../../domain/scheduling/scheduling-api'
import './scheduling.css'

const STRATEGIES = [['round_robin', 'Round robin (pool)'], ['qualified_pool', 'Least loaded (pool)'], ['specific_owner', 'Record owner first']] as const
const OWNERS = [['', '—'], ['opportunity_owner', 'Opportunity owner'], ['transaction_owner', 'Transaction owner']] as const

/**
 * Team & routing — who is bookable, which pools they serve, how each brand's
 * appointment types route. Shown only to operators with scheduling.admin; the
 * API refuses everyone else regardless of what the browser shows.
 */
export function TeamAdminCard() {
  const [allowed, setAllowed] = useState<boolean | null>(null)
  const [team, setTeam] = useState<TeamMember[] | null>(null)
  const [pools, setPools] = useState<TeamPool[]>([])
  const [types, setTypes] = useState<EventTypeConfig[]>([])
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const [tick, setTick] = useState(0)
  useEffect(() => {
    const c = new AbortController()
    fetchPermissions(c.signal)
      .then(async (p) => {
        setAllowed(p.scheduling_admin)
        if (!p.scheduling_admin) return
        const [t, e] = await Promise.all([fetchTeam(c.signal), fetchEventTypes(c.signal)])
        setTeam(t.team); setPools(t.pools); setTypes(e.event_types); setError(null)
      })
      .catch((err) => { if (!c.signal.aborted) setError(schedulingErrorText(err)) })
    return () => c.abort()
  }, [tick])
  const load = () => setTick((n) => n + 1)

  if (allowed === false) return null
  if (error) return <section className="sch-card"><LCError what="Team & routing" detail={error} onRetry={load} /></section>
  if (allowed === null || !team) return <section className="sch-card" aria-busy="true"><LCSkeleton count={4} /></section>

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setNote(null)
    try { await fn(); setNote(done); load() } catch (err) { setNote(schedulingErrorText(err)) }
  }

  return (
    <section className="sch-card sch-admin" aria-label="Team and routing">
      <header className="sch-card__head"><h3>Team &amp; routing</h3><LCStatus tone="neutral" label="Scheduling admin" /></header>
      {note ? <p className="sch-muted" role="status">{note}</p> : null}

      <h4 className="sch-eyebrow">Pools</h4>
      <table className="sch-table">
        <thead><tr><th scope="col">Person</th>{pools.map((p) => <th key={`${p.brand}:${p.key}`} scope="col">{p.name}<small> {p.brand.replace(/_/g, ' ')}</small></th>)}</tr></thead>
        <tbody>
          {team.map((m) => (
            <tr key={m.id}>
              <th scope="row">{m.name}<small> {m.timezone}{m.active ? '' : ' · inactive'}</small></th>
              {pools.map((p) => {
                const on = p.members.includes(m.id)
                return (
                  <td key={`${p.brand}:${p.key}`}>
                    <input type="checkbox" aria-label={`${m.name} in ${p.name}`} checked={on}
                      onChange={() => void act(() => setPoolMember({ brand: p.brand, pool_key: p.key, resource_id: m.id, active: !on }), `${m.name} ${on ? 'removed from' : 'added to'} ${p.name}.`)} />
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <h4 className="sch-eyebrow">Make someone bookable</h4>
      <PersonForm onSave={(body) => act(() => saveResource(body), `${body.display_name} saved.`)} />

      <h4 className="sch-eyebrow">Appointment types</h4>
      {types.map((t) => <TypeRow key={t.id} type={t} pools={pools.filter((p) => p.brand === t.brand)} onSave={(patch) => act(() => saveEventType({ id: t.id, ...patch }), `${t.name} updated.`)} />)}
    </section>
  )
}

function PersonForm({ onSave }: { onSave: (body: Parameters<typeof saveResource>[0]) => Promise<void> }) {
  const [f, setF] = useState({ user: '', name: '', publicName: '', email: '', tz: 'America/New_York', keys: '' })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void onSave({ ops_user_id: f.user.trim(), display_name: f.name.trim(), public_name: f.publicName.trim() || undefined, email: f.email.trim() || undefined, timezone: f.tz.trim(), weekly_hours: {}, operator_keys: f.keys.split(',').map((k) => k.trim()).filter(Boolean), active: true })
  }
  return (
    <form className="sch-form sch-grid2" onSubmit={submit} aria-label="Make someone bookable">
      <label className="sch-field"><span>Operator user id</span><input className="sch-input" required pattern="[0-9a-fA-F-]{36}" value={f.user} onChange={(e) => setF({ ...f, user: e.target.value })} /></label>
      <label className="sch-field"><span>Name (team)</span><input className="sch-input" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
      <label className="sch-field"><span>Name customers see (optional)</span><input className="sch-input" value={f.publicName} onChange={(e) => setF({ ...f, publicName: e.target.value })} /></label>
      <label className="sch-field"><span>Email</span><input className="sch-input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
      <label className="sch-field"><span>Time zone</span><input className="sch-input" required value={f.tz} onChange={(e) => setF({ ...f, tz: e.target.value })} /></label>
      <label className="sch-field"><span>Record-owner keys (comma)</span><input className="sch-input" value={f.keys} onChange={(e) => setF({ ...f, keys: e.target.value })} placeholder="values in assigned_operator" /></label>
      <LCButton type="submit" variant="primary" size="sm">Save person</LCButton>
    </form>
  )
}

function TypeRow({ type, pools, onSave }: { type: EventTypeConfig; pools: TeamPool[]; onSave: (patch: Partial<EventTypeConfig>) => Promise<void> }) {
  const [r, setR] = useState({ strategy: type.routing.strategy ?? 'qualified_pool', owner: type.routing.owner ?? '', pool: type.routing.pool ?? '', fallback: type.routing.fallback_pool ?? '', unavailable: type.routing.owner_unavailable ?? 'route_to_pool', duration: type.duration_minutes, after: type.buffer_after_minutes, notice: type.min_notice_minutes })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const routing: EventTypeConfig['routing'] = { strategy: r.strategy }
    if (r.pool) routing.pool = r.pool
    if (r.fallback) routing.fallback_pool = r.fallback
    if (r.strategy === 'specific_owner' && r.owner) { routing.owner = r.owner; routing.owner_unavailable = r.unavailable }
    void onSave({ routing, duration_minutes: Number(r.duration), buffer_after_minutes: Number(r.after), min_notice_minutes: Number(r.notice) })
  }
  const poolSelect = (value: string, set: (v: string) => void, label: string) => (
    <label className="sch-field"><span>{label}</span><select className="sch-input" value={value} onChange={(e) => set(e.target.value)}><option value="">—</option>{pools.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}</select></label>
  )
  return (
    <form className="sch-form sch-type" onSubmit={submit} aria-label={`${type.name} routing`}>
      <strong>{type.name}<small> {type.brand.replace(/_/g, ' ')}{type.environment === 'test' ? ' · test' : ''}</small></strong>
      <div className="sch-grid2">
        <label className="sch-field"><span>Routing</span><select className="sch-input" value={r.strategy} onChange={(e) => setR({ ...r, strategy: e.target.value })}>{STRATEGIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        {r.strategy === 'specific_owner' ? <label className="sch-field"><span>Owner</span><select className="sch-input" value={r.owner} onChange={(e) => setR({ ...r, owner: e.target.value })}>{OWNERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label> : null}
        {r.strategy === 'specific_owner' ? <label className="sch-field"><span>Owner busy</span><select className="sch-input" value={r.unavailable} onChange={(e) => setR({ ...r, unavailable: e.target.value })}><option value="route_to_pool">Offer the pool</option><option value="next_available_owner">Only the owner's times</option></select></label> : null}
        {poolSelect(r.pool, (v) => setR({ ...r, pool: v }), 'Pool')}
        {poolSelect(r.fallback, (v) => setR({ ...r, fallback: v }), 'Fallback pool')}
        <label className="sch-field"><span>Minutes</span><input className="sch-input" type="number" min={5} max={480} value={r.duration} onChange={(e) => setR({ ...r, duration: Number(e.target.value) })} /></label>
        <label className="sch-field"><span>Buffer after</span><input className="sch-input" type="number" min={0} max={240} value={r.after} onChange={(e) => setR({ ...r, after: Number(e.target.value) })} /></label>
        <label className="sch-field"><span>Notice (min)</span><input className="sch-input" type="number" min={0} value={r.notice} onChange={(e) => setR({ ...r, notice: Number(e.target.value) })} /></label>
      </div>
      <LCButton type="submit" size="sm">Save routing</LCButton>
    </form>
  )
}
