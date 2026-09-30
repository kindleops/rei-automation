import type { ReactNode } from 'react'
import { Icon } from '../../../shared/icons'
import type { ThreadIntelligence, ThreadRoom, ThreadSummary } from '../mobile/email-command-api'
import { ROLE_LABEL, ago, human, stamp, until, where, who } from '../mobile/email-format'
import { renderLine } from './desk-model'
import { LINK_ICON, goLink } from './desk-links'

/**
 * INTELLIGENCE INSPECTOR — explains the selected conversation; it never
 * repeats it. Summary, automation, WHY (in business language), the systems it
 * is truly linked to, the party, the property, delivery and activity. Every
 * value is the server's; a value that is not recorded says so plainly.
 * Loaded lazily: it is the one plane the desk can live without.
 */

const STATUS: Record<string, string> = { queued: 'Queued', sending: 'Sending', scheduled: 'Scheduled', retrying: 'Retrying', held: 'Held', awaiting_approval: 'Needs approval', needs_you: 'Your call' }
const MODE_TONE: Record<string, string> = { system_handling: 'cyan', waiting: 'quiet', escalated: 'gold', needs_you: 'gold', manual: 'plain', paused: 'quiet', failed: 'red', done: 'green', off: 'quiet' }
const ballLine = (owner: string | null, role: string | null) => (owner === 'you' ? 'You have the ball' : owner === 'leadcommand' ? 'LeadCommand has the ball' : owner === 'them' ? `${role || 'The counterparty'} has the ball` : 'Nobody owes a move')

export function DeskInspector({ room, fallback, onClose }: { room: ThreadRoom | null; fallback: ThreadSummary | null; onClose: () => void }) {
  const t = room?.thread ?? fallback
  const i = room?.intelligence ?? null
  if (!t) return null
  return (
    <div className="emd-insp__inner">
      <header className="emd-insp__head">
        <span><Icon name="brain" />Intelligence</span>
        <button type="button" className="emd-icon" aria-label="Hide intelligence" title="Hide  ]" onClick={onClose}><Icon name="close" /></button>
      </header>
      {!i ? (
        <div className="emd-insp__loading" aria-busy="true"><span /><span /><span /><span /></div>
      ) : (
        <div className="emd-insp__scroll">
          <Summary t={t} i={i} />
          <Automation i={i} />
          {i.why ? <Why i={i} /> : null}
          {i.links.length ? <Links i={i} /> : null}
          <Party t={t} i={i} />
          {i.property ? <Property i={i} t={t} /> : null}
          {i.delivery ? <Delivery i={i} /> : null}
          <Activity i={i} />
        </div>
      )}
    </div>
  )
}

function Section({ label, children, tone }: { label: string; children: ReactNode; tone?: string }) {
  return (
    <section className={`emd-sec${tone ? ` is-${tone}` : ''}`}>
      <h3 className="emd-sec__label">{label}</h3>
      {children}
    </section>
  )
}

function Row({ k, children, muted = false }: { k: string; children: ReactNode; muted?: boolean }) {
  return <div className={`emd-kv${muted ? ' is-muted' : ''}`}><dt>{k}</dt><dd>{children}</dd></div>
}

function Summary({ t, i }: { t: ThreadSummary; i: ThreadIntelligence }) {
  const s = i.summary
  return (
    <Section label="Summary">
      <dl className="emd-kvs">
        <Row k="Intent" muted={!s.intent}>{s.intent ? <>{s.intent.label}<small>{s.intent.source}</small></> : t.last_message.direction === 'outbound' && !s.last_reply_at ? 'No reply yet' : 'Not recorded'}</Row>
        <Row k="Sentiment" muted>Not measured</Row>
        {s.stage ? (
          <Row k={s.stage.closing ? 'Closing' : 'Stage'}>
            {s.stage.label}
            {s.stage.moved === 'moved' && s.stage.from ? <small>Moved from {s.stage.from}</small> : s.stage.moved === 'stayed' ? <small>Stayed on the last reply</small> : s.stage.at ? <small>Set by the last reply</small> : null}
          </Row>
        ) : null}
        {s.lead_state && !s.stage?.closing ? <Row k="Lead state">{s.lead_state}</Row> : null}
        <Row k="Next planned" muted={!s.next_action}>
          {s.next_action ? <>{s.next_action.label}{s.next_action.at ? <small>{until(s.next_action.at)}{s.next_action.status ? ` · ${STATUS[s.next_action.status] || human(s.next_action.status)}` : ''}</small> : null}</> : 'Nothing planned'}
        </Row>
        <Row k="Last reply" muted={!s.last_reply_at}>{s.last_reply_at ? <>{ago(s.last_reply_at)}<small>{stamp(s.last_reply_at)}</small></> : 'No reply yet'}</Row>
        <Row k="Channel">
          {ballLine(s.channel.owner, i.party.role)}
          <small>{[s.channel.preference === 'email' ? 'Prefers email' : s.channel.preference === 'sms' ? 'Prefers SMS' : null, s.channel.sms_linked ? 'Shares the seller brain with SMS' : null].filter(Boolean).join(' · ') || 'Email only'}</small>
        </Row>
      </dl>
    </Section>
  )
}

function Automation({ i }: { i: ThreadIntelligence }) {
  const a = i.automation
  return (
    <Section label="Automation">
      <span className={`emd-mode is-${MODE_TONE[a.mode] || 'plain'}`}>
        {a.mode === 'system_handling' ? <span className="emd-orbit is-sm" aria-hidden><i /></span> : <i className="emd-mode__dot" aria-hidden />}
        {a.label}
      </span>
      {a.armed.length ? (
        <ol className="emd-armed">
          {a.armed.map((x) => (
            <li key={x.queue_id} className={`is-${x.status || 'scheduled'}`}>
              <Icon name={x.status === 'queued' || x.status === 'sending' ? 'send' : x.status === 'retrying' ? 'refresh-cw' : x.status === 'held' ? 'shield' : 'clock'} />
              <span><b>{x.label}</b><small>{x.status === 'scheduled' ? until(x.at) : x.status === 'queued' ? `Queued ${ago(x.at)}` : STATUS[x.status || ''] || ''}</small></span>
            </li>
          ))}
        </ol>
      ) : <p className="emd-sec__none">Nothing armed on this conversation</p>}
      <dl className="emd-kvs">
        {a.approvals ? <Row k="Approvals">{a.approvals} draft{a.approvals === 1 ? '' : 's'} waiting for you</Row> : null}
        {a.send_enabled !== null ? <Row k="Sending" muted={!a.send_enabled}>{a.send_enabled ? 'On' : a.operator_switch ? 'Off — deployment not enabled' : 'Off — operator switch'}</Row> : null}
        {a.taken_over_at ? <Row k="Taken over">{ago(a.taken_over_at)}</Row> : null}
      </dl>
    </Section>
  )
}

function Why({ i }: { i: ThreadIntelligence }) {
  const w = i.why!
  return (
    <Section label="Why" tone="why">
      <p className="emd-why__title">{w.title}</p>
      <ul className="emd-why">
        {w.lines.map((l, k) => <li key={k} className={l.tone ? `is-${l.tone}` : ''}><i aria-hidden />{renderLine(l.text, l.at, l.fmt)}</li>)}
      </ul>
    </Section>
  )
}

function Links({ i }: { i: ThreadIntelligence }) {
  return (
    <Section label="Linked systems">
      <ul className="emd-links">
        {i.links.map((l) => (
          <li key={`${l.system}:${l.href}`}>
            <button type="button" onClick={() => goLink(l)}>
              <span className="emd-links__glyph" aria-hidden><Icon name={LINK_ICON[l.system] || 'link'} /></span>
              <span className="emd-links__body"><b>{l.label}</b>{l.detail ? <small>{l.detail}</small> : null}</span>
              <Icon name="arrow-up-right" />
            </button>
          </li>
        ))}
      </ul>
    </Section>
  )
}

function Party({ t, i }: { t: ThreadSummary; i: ThreadIntelligence }) {
  const p = i.party
  const identity = p.resolution === 'resolved' ? 'Identified' : p.resolution === 'ambiguous' ? `Ambiguous · ${p.candidates} possible match${p.candidates === 1 ? '' : 'es'}` : 'Unidentified'
  return (
    <Section label="Party">
      <dl className="emd-kvs">
        <Row k="Name">{who(t)}</Row>
        {p.email ? <Row k="Email"><span className="emd-mono">{p.email}</span></Row> : null}
        <Row k="Role">{p.role || ROLE_LABEL[t.category] || human(t.category)}</Row>
        <Row k="Identity" muted={p.resolution !== 'resolved'}>{identity}{p.method ? <small>{human(p.method.replace(/^automated:/, 'automated '))}</small> : null}</Row>
      </dl>
    </Section>
  )
}

function Property({ i, t }: { i: ThreadIntelligence; t: ThreadSummary }) {
  const p = i.property!
  return (
    <Section label="Property">
      <dl className="emd-kvs">
        <Row k="Address">{p.address || where(t) || 'Not recorded'}</Row>
        <Row k="Market" muted={!p.market}>{p.market || 'Not recorded'}</Row>
      </dl>
    </Section>
  )
}

function Delivery({ i }: { i: ThreadIntelligence }) {
  const d = i.delivery!
  const e = d.engagement
  return (
    <Section label="Delivery">
      <dl className="emd-kvs">
        <Row k="Last send">{human(d.status)}<small>{d.at ? stamp(d.at) : ''}{d.provenance?.label ? ` · ${d.provenance.label}` : ''}</small></Row>
        {d.from || d.domain ? <Row k="Sender"><span className="emd-mono">{d.from || d.domain}</span>{d.provider ? <small>via {human(d.provider)}</small> : null}</Row> : null}
        <Row k="Engagement">
          {e.open_signals ? `${e.open_signals} open signal${e.open_signals === 1 ? '' : 's'}` : 'No open signals'}{e.clicks ? ` · ${e.clicks} click${e.clicks === 1 ? '' : 's'}` : ''}
          <small>{e.replied_at ? `Replied ${ago(e.replied_at)}` : e.bounce ? `${human(e.bounce.type)}${e.bounce.reason ? ` — ${e.bounce.reason}` : ''}` : e.delivered_at ? `Delivered ${ago(e.delivered_at)}` : 'Delivery not confirmed by the provider'}{e.likely_human_opens ? ` · ${e.likely_human_opens} likely human` : ''}</small>
        </Row>
      </dl>
      <p className="emd-caveat">Open signals include privacy proxies and scanners — judge by replies.</p>
    </Section>
  )
}

function Activity({ i }: { i: ThreadIntelligence }) {
  const a = i.activity
  const cells: Array<[string, number]> = [['In', a.inbound], ['Out', a.outbound], ['Planned', a.planned], ['Files', a.attachments]]
  return (
    <Section label="Activity">
      <div className="emd-cells">
        {cells.map(([k, n]) => <span key={k} className={n ? '' : 'is-zero'}><b>{n}</b><small>{k}</small></span>)}
      </div>
      <dl className="emd-kvs">
        <Row k="Written by">{[a.automated ? `LeadCommand ${a.automated}` : null, a.manual ? `You ${a.manual}` : null].filter(Boolean).join(' · ') || 'Nothing sent yet'}</Row>
        {a.first_at ? <Row k="Opened">{stamp(a.first_at)}</Row> : null}
        {a.last_at ? <Row k="Last activity">{ago(a.last_at)}</Row> : null}
      </dl>
    </Section>
  )
}
