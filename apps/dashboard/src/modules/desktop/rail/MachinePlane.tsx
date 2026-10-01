import { pushRoutePath } from '../../../app/router'
import { LCStatus, cx } from '../../../shared/lc'
import { machineState, runtimeHealth, type ShellRuntime } from './rail-model'
import { appName, type RailSnapshot } from './rail-store'

/**
 * THE MACHINE PLANE — what the machine has been doing (Live Machine) and the
 * heartbeat of every runtime that does it. Live Machine is ambient activity,
 * not notifications: nothing here asks for action; it shows what happened.
 */

const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })
const ago = (iso: string | null, now: number) => {
  if (!iso) return null
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

function RuntimeRow({ r, now }: { r: ShellRuntime; now: number }) {
  const h = runtimeHealth(r, now)
  return (
    <li>
      <button type="button" className={cx('crm__rt', `is-${h}`)} onClick={() => pushRoutePath(r.owner_href && r.owner_href !== '/inbox' ? (r.owner_href === '/campaigns' ? '/campaign-command' : r.owner_href) : '/workflow-studio')}>
        <span className="crm__rtname">{r.name}</span>
        {h === 'current' ? <LCStatus tone="ok" quiet label={ago(r.heartbeat_at, now) ?? 'current'} /> : null}
        {h === 'delayed' ? <LCStatus tone="attn" label={`Delayed · ${ago(r.heartbeat_at, now)}`} /> : null}
        {h === 'off' ? <LCStatus tone="neutral" quiet hollow label="Off" /> : null}
        {h === 'event' ? <span className="crm__meta">{r.last_run_at ? `ran ${ago(r.last_run_at, now)}` : 'event-driven'}</span> : null}
        {h === 'never' ? <span className="crm__meta">not running</span> : null}
      </button>
    </li>
  )
}

export function MachinePlane({ rail }: { rail: RailSnapshot }) {
  const now = rail.updatedAt ?? 0
  const t = rail.telemetry
  const m = machineState(t, now)
  const clocked = (t?.runtimes ?? []).filter((r) => { const h = runtimeHealth(r, now); return h !== 'event' && h !== 'never' })
  const evented = (t?.runtimes ?? []).filter((r) => runtimeHealth(r, now) === 'event')
  return (
    <div className="crm">
      <header className="crm__head">
        <span className={cx('crm__state', `is-${m.state}`)}><i aria-hidden="true" />{m.state === 'degraded' ? 'System · degraded' : m.state === 'live' ? 'Machine · live' : m.state === 'idle' ? 'Machine · idle' : 'Machine'}</span>
        {rail.updatedAt ? <span className="crm__meta">updated {clock(rail.updatedAt)}</span> : null}
      </header>
      {m.reason ? <p className="crm__reason">{m.reason}</p> : null}

      <section className="crm__sec" aria-label="Live machine">
        <span className="lc-eyebrow">Live machine</span>
        {rail.recent.length ? (
          <ol className="crm__events">
            {rail.recent.slice(0, 12).map((e) => (
              <li key={e.id} data-tone={e.priority === 1 ? (e.transient === 'failure' ? 'crit' : 'attn') : undefined}>
                <time className="lc-t-stamp">{clock(Date.parse(e.occurred_at) || e.seenAt)}</time>
                <span className="crm__what">
                  <b>{e.text || e.label}</b>
                  <small>{appName(e.app)}{e.subject ? ` · ${e.subject}` : ''}</small>
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="crm__quiet">Nothing has moved since this window opened. Events appear here as runtimes record them.</p>
        )}
      </section>

      <section className="crm__sec" aria-label="Runtimes">
        <span className="lc-eyebrow">Runtimes</span>
        <ul className="crm__rts">{clocked.map((r) => <RuntimeRow key={r.key} r={r} now={now} />)}</ul>
        {evented.length ? <ul className="crm__rts is-evented">{evented.map((r) => <RuntimeRow key={r.key} r={r} now={now} />)}</ul> : null}
      </section>
    </div>
  )
}
