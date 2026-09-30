import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Icon } from '../../../shared/icons'
import {
  fetchMessage, postThreadAction, sendReply,
  type Attachment, type Home, type Item, type MessageTelemetry, type ThreadRoom, type ThreadSummary, type Why,
} from '../mobile/email-command-api'
import { ROLE_LABEL, ago, human, money, stamp, until, where, who } from '../mobile/email-format'
import { initials, needsShort, stateMetaFor } from './desk-model'
import { LINK_ICON, goLink } from './desk-links'

/**
 * THE CONVERSATION ROOM. A compact identity header, then the thread as typed
 * objects — outbound (glass, with its system identity), inbound (clean and
 * readable), system events (thin log rows), automation explanations (a
 * secondary surface) and planned sends (ghosted, in the future) — and a glass
 * composer anchored at the bottom whose automation marker is driven only by
 * the real outbox state of the next message.
 */

type Out = Extract<Item, { kind: 'outbound' }>
type In = Extract<Item, { kind: 'inbound' }>
type Sys = Extract<Item, { kind: 'system' }>

const PLANNED = new Set(['scheduled', 'queued', 'sending', 'awaiting_approval'])
const VOID = new Set(['cancelled', 'superseded'])

export function DeskRoom({ id, room, fallback, error, home, homeError = null, inspectorOpen, onToggleInspector, onChanged, onBack = null }: {
  id: string | null
  room: ThreadRoom | null
  fallback: ThreadSummary | null
  error: string | null
  home: Home | null
  homeError?: string | null
  inspectorOpen: boolean
  onToggleInspector: () => void
  onChanged: () => void
  onBack?: (() => void) | null
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ tone: 'good' | 'bad' | 'muted'; text: string } | null>(null)
  const [owned, setOwned] = useState<boolean | null>(null)
  const [telemetry, setTelemetry] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const t = room?.thread ?? fallback
  const items = room?.items ?? null

  useEffect(() => { if (items && scrollRef.current) scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight }) }, [Boolean(items)]) // eslint-disable-line react-hooks/exhaustive-deps

  const act = useCallback(async (action: string, fields: Record<string, unknown> = {}, ok = 'Done') => {
    if (!t) return
    setBusy(action)
    if (action === 'take_over') setOwned(true)
    if (action === 'return_to_system') setOwned(false)
    const r = await postThreadAction(t.id, action, fields)
    if (!r.ok && (action === 'take_over' || action === 'return_to_system')) setOwned(null)
    setBusy(null)
    setNotice(r.ok ? { tone: 'good', text: action === 'take_over' ? `You own this conversation${r.stopped ? ` · ${r.stopped} scheduled email${r.stopped === 1 ? '' : 's'} stopped` : ''}` : ok } : { tone: 'bad', text: r.message || human(r.code) || 'Not accepted' })
    if (r.ok && !r.demo) onChanged()
  }, [t, onChanged])

  if (!id || !t) return <RoomEmpty home={home} failed={Boolean(homeError && !home)} />

  const meta = stateMetaFor(t)
  const isOwned = owned ?? t.automation === 'paused_you_own_it'
  const place = where(t)
  const market = room?.intelligence?.property?.market ?? t.market ?? null
  const links = room?.intelligence?.links ?? (t.context?.kind === 'closing' ? [{ system: 'closing_desk', label: 'Closing Desk', detail: t.context.waiting_for, href: t.context.open }] : [])
  const headLinks = links.filter((l) => ['closing_desk', 'workflow_studio', 'campaign_command', 'inbox'].includes(l.system)).slice(0, 3)
  const drafts = (items ?? []).filter((i): i is Out => i.kind === 'outbound' && i.status === 'awaiting_approval')

  return (
    <section className={`emd-room is-${meta.tone}${isOwned ? ' is-owned' : ''}`} aria-label={`Conversation with ${who(t)}`}>
      <header className="emd-room__head">
        {onBack ? <button type="button" className="emd-icon emd-room__back" aria-label="Back to conversations" onClick={onBack}><Icon name="chevron-left" /></button> : null}
        <span className={`emd-orb is-lg is-${t.category}${t.state === 'system_handling' ? ' is-live' : ''}`} aria-hidden>{initials(t)}</span>
        <span className="emd-room__id">
          <span className="emd-room__l1">
            <h2>{who(t)}</h2>
            {t.counterparty.email ? <span className="emd-room__email">{t.counterparty.email}</span> : null}
          </span>
          <span className="emd-room__l2">
            <b>{ROLE_LABEL[t.counterparty.role] || ROLE_LABEL[t.category] || t.category}</b>
            {place ? <><i aria-hidden>·</i><span>{place}</span></> : null}
            {market ? <><i aria-hidden>·</i><span className="emd-room__market">{market}</span></> : null}
          </span>
        </span>
        <span className="emd-room__acts">
          {t.category !== 'unresolved' && (t.state !== 'done' || isOwned) ? (isOwned
            ? <button type="button" className="emd-btn is-quiet" disabled={busy !== null} onClick={() => act('return_to_system', {}, 'Returned to LeadCommand')} title="Return to LeadCommand"><Icon name="play" /><span className="emd-btn__label">Return to LeadCommand</span></button>
            : <button type="button" className="emd-btn is-quiet" disabled={busy !== null} onClick={() => act('take_over')} title="Take over"><Icon name="user" /><span className="emd-btn__label">Take over</span></button>) : null}
          <button type="button" className={`emd-icon${inspectorOpen ? ' is-on' : ''}`} aria-pressed={inspectorOpen} aria-label={inspectorOpen ? 'Hide intelligence' : 'Show intelligence'} title="Intelligence  ]" onClick={onToggleInspector}><Icon name="layout-split" /></button>
        </span>
        <span className="emd-room__chips">
          <span className={`emd-state is-${meta.tone}`} key={`${t.state}`}><Icon name={meta.icon} /><b>{meta.label}</b></span>
          {t.escalated && t.state === 'needs_you' ? <span className="emd-chip is-gold"><Icon name="arrow-up-right" />Escalated by automation</span> : null}
          {isOwned ? <span className="emd-chip"><Icon name="user" />You own it</span> : null}
          {headLinks.map((l) => (
            <button key={`${l.system}:${l.href}`} type="button" className={`emd-chip is-link is-${l.system}`} onClick={() => goLink(l)} title={l.detail || l.label}>
              <Icon name={LINK_ICON[l.system] || 'link'} />{l.system === 'workflow_studio' && l.detail ? l.detail : l.label}<Icon name="arrow-up-right" />
            </button>
          ))}
        </span>
      </header>

      {t.needs || (t.failure && (t.state === 'failed' || t.failure.operator_must_act)) ? (
        <div className="emd-room__alerts">
          {t.needs ? (
            <section className="emd-exception" role="alert">
              <span className="emd-exception__eyebrow"><Icon name="flag" />Needs you · {needsShort(t.needs.code)}<time>{ago(t.needs.since)}</time></span>
              <p>{t.needs.reason}</p>
              <span className="emd-exception__acts">
                {links.filter((l) => l.system === 'closing_desk').map((l) => <button key={l.href} type="button" className="emd-btn is-quiet" onClick={() => goLink(l)}><Icon name="key" />Open Closing Desk</button>)}
                <button type="button" className="emd-btn is-quiet" disabled={busy !== null} onClick={() => act('resolve_needs', {}, 'Marked handled')}><Icon name="check" />Mark handled</button>
              </span>
            </section>
          ) : null}
          {t.failure && (t.state === 'failed' || t.failure.operator_must_act) ? <FailurePlate f={t.failure} /> : null}
        </div>
      ) : null}

      <div className="emd-room__scroll" ref={scrollRef}>
        <div className="emd-room__col">
          {notice ? <p className={`emd-notice is-${notice.tone}`} role="status">{notice.text}</p> : null}
          {error && !items ? (
            <div className="emd-room__state" role="alert"><Icon name="alert" /><strong>{error === 'not_found' ? 'This conversation no longer exists' : 'Could not open this conversation'}</strong></div>
          ) : !items ? (
            <div className="emd-skel is-room" aria-busy="true"><span className="emd-skel__msg" /><span className="emd-skel__msg is-in" /><span className="emd-skel__msg" /></div>
          ) : (
            <Timeline items={items} t={t} onTelemetry={setTelemetry} onReview={(a, decision) => act('review_attachment', { attachment_id: a.id, decision }, decision === 'reviewed' ? 'Marked reviewed' : 'Rejected')} />
          )}
        </div>
      </div>

      <Composer t={t} owned={isOwned} delivery={home?.delivery ?? null} drafts={drafts} busy={busy} onAct={act} onSent={(text, tone) => { setNotice({ tone, text }); onChanged() }} />

      {telemetry ? <TelemetryPanel id={telemetry} onClose={() => setTelemetry(null)} /> : null}
    </section>
  )
}

function RoomEmpty({ home, failed }: { home: Home | null; failed: boolean }) {
  const d = home?.delivery
  const total = home ? home.counts.needs_you + home.counts.system_handling + home.counts.waiting + home.counts.failed + home.counts.unresolved + home.counts.done : 0
  return (
    <section className="emd-room is-empty" aria-label="Conversation">
      <div className="emd-room__void">
        <span className="emd-void__mark" aria-hidden><Icon name="mail" /></span>
        <strong>{home ? (total ? 'Select a conversation' : 'Email Command is ready') : failed ? 'No conversation open' : 'Reading Email Command…'}</strong>
        {failed ? <p>The conversation list could not be read, so nothing is shown here rather than a guess.</p> : null}
        {home && !total ? <p>No conversation exists yet. The moment a seller, title company or buyer emails — or LeadCommand sends — it appears here with its state, reason and next move.</p> : null}
        {d ? (
          <dl className="emd-void__facts">
            <div><dt>Sending</dt><dd className={d.send_enabled ? 'is-good' : 'is-warn'}>{d.send_enabled ? 'On' : d.operator_switch ? 'Off — deployment not enabled' : 'Off — operator switch'}</dd></div>
            <div><dt>Dispatcher</dt><dd>{d.heartbeat_at ? `Heartbeat ${ago(d.heartbeat_at)}` : 'No heartbeat recorded'}</dd></div>
            <div><dt>Health</dt><dd className={d.health?.status === 'healthy' ? 'is-good' : d.health ? 'is-bad' : ''}>{d.health ? human(d.health.status) : 'Not reported'}</dd></div>
          </dl>
        ) : null}
      </div>
    </section>
  )
}

function FailurePlate({ f }: { f: NonNullable<ThreadSummary['failure']> }) {
  const CLASS: Record<string, string> = { delivery: 'Delivery failure', transport: 'Transport', suppression: 'Suppression', blocked: 'Blocked', provider: 'Provider issue', unknown: 'Failure' }
  return (
    <section className={`emd-failure is-${f.class}`}>
      <span className="emd-failure__eyebrow"><Icon name="alert" />{CLASS[f.class] || 'Failure'} · {f.label}</span>
      <dl>
        <div><dt>What failed</dt><dd>{f.what}</dd></div>
        <div><dt>Retry</dt><dd>{f.retry === 'exhausted' ? `Exhausted after ${f.attempts} attempt${f.attempts === 1 ? '' : 's'}` : 'None — not retried automatically'}</dd></div>
        <div><dt>You</dt><dd>{f.operator_must_act ? f.action : 'No action required'}</dd></div>
      </dl>
    </section>
  )
}

/* ── timeline ─────────────────────────────────────────────────────────── */

type Row =
  | { kind: 'out'; it: Out }
  | { kind: 'planned'; it: Out }
  | { kind: 'void'; it: Out }
  | { kind: 'in'; it: In; explain: Sys[] }
  | { kind: 'log'; it: Sys }
  | { kind: 'day'; label: string }

const EXPLAINS = new Set(['seller_brain', 'email_command'])

function composeTimeline(items: Item[]): Row[] {
  const rows: Row[] = []
  const used = new Set<number>()
  let lastDay = ''
  items.forEach((it, i) => {
    if (used.has(i)) return
    const day = new Date(it.at).toDateString()
    if (day !== lastDay && Number.isFinite(Date.parse(it.at))) {
      lastDay = day
      const d = new Date(it.at)
      const today = new Date().toDateString() === day
      const future = d.getTime() > Date.now() && !today
      rows.push({ kind: 'day', label: today ? 'Today' : future ? `Planned · ${d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}` : d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }) })
    }
    if (it.kind === 'inbound') {
      // The automation's reading of THIS email travels with it, as a secondary surface.
      const explain: Sys[] = []
      const at = Date.parse(it.at)
      items.forEach((x, j) => {
        if (j <= i || used.has(j) || x.kind !== 'system' || !EXPLAINS.has(String(x.source))) return
        const dt = Date.parse(x.at) - at
        if (dt >= -60e3 && dt <= 15 * 60e3) { explain.push(x); used.add(j) }
      })
      rows.push({ kind: 'in', it, explain })
    } else if (it.kind === 'outbound') {
      rows.push({ kind: PLANNED.has(it.status) ? 'planned' : VOID.has(it.status) ? 'void' : 'out', it })
    } else rows.push({ kind: 'log', it })
  })
  return rows
}

function Timeline({ items, t, onTelemetry, onReview }: { items: Item[]; t: ThreadSummary; onTelemetry: (id: string) => void; onReview: (a: Attachment, d: 'reviewed' | 'rejected') => void }) {
  const rows = useMemo(() => composeTimeline(items), [items])
  const lastIn = rows.reduce((acc, r, i) => (r.kind === 'in' ? i : acc), -1)
  if (!items.length) return <p className="emd-none">No messages in this conversation yet.</p>
  return (
    <ol className="emd-tl" aria-label="Conversation">
      {rows.map((r, i) => (
        <li key={i} className={`emd-tl__item is-${r.kind}`} style={{ ['--i' as string]: Math.min(i, 7) } as CSSProperties}>
          {r.kind === 'day' ? <span className="emd-day">{r.label}</span>
            : r.kind === 'log' ? <LogRow it={r.it} />
              : r.kind === 'void' ? <VoidRow it={r.it} />
                : r.kind === 'in' ? <Inbound it={r.it} explain={r.explain} t={t} last={i === lastIn} onReview={onReview} />
                  : r.kind === 'planned' ? <Planned it={r.it} />
                    : <Outbound it={r.it} onTelemetry={onTelemetry} onReview={onReview} />}
        </li>
      ))}
    </ol>
  )
}

const SOURCE_LABEL: Record<string, string> = { title_email: 'from title email', seller_brain: 'seller brain', email_command: 'Email Command', closing_authority: 'Closing Authority' }

function LogRow({ it }: { it: Sys }) {
  return (
    <div className="emd-log">
      <i aria-hidden />
      <span>{it.label}</span>
      {it.source ? <em>{SOURCE_LABEL[it.source] || human(it.source)}</em> : null}
      <time>{ago(it.at)}</time>
    </div>
  )
}

function VoidRow({ it }: { it: Out }) {
  return (
    <div className="emd-log is-void">
      <i aria-hidden />
      <span><s>{it.subject}</s> — not sent{it.cancel_reason ? `: ${human(it.cancel_reason.split(':')[0]).toLowerCase()}` : ''}</span>
      <time>{ago(it.at)}</time>
    </div>
  )
}

function DeliveryTrack({ it }: { it: Out }) {
  const e = it.engagement
  const steps: Array<[string, boolean, string]> = [
    ['Sent', true, ''],
    ['Delivered', Boolean(e.delivered_at), ''],
    [e.open_signals ? `Opened ${e.open_signals}×` : 'Opened', e.open_signals > 0, ''],
    ...(e.clicks ? [[`Clicked ${e.clicks}×`, true, ''] as [string, boolean, string]] : []),
    [e.bounce ? (e.bounce.type === 'soft_bounce' ? 'Soft bounce' : 'Bounced') : 'Replied', Boolean(e.replied_at || e.bounce), e.bounce ? 'is-bad' : 'is-good'],
  ]
  return (
    <span className="emd-track" aria-label="Delivery">
      {steps.map(([label, on, cls], i) => <span key={i} className={`${on ? `is-on ${cls}` : ''}`}>{label}</span>)}
    </span>
  )
}

function whyRows(why: Why | null): Array<[string, string]> {
  if (!why) return []
  const rows: Array<[string, string]> = []
  if (why.why) rows.push(['Reason', String(why.why)])
  if (why.category) rows.push(['Family', human(String(why.category).split(':')[0])])
  if (why.use_case) rows.push(['Seller question', human(String(why.use_case).replace(/_probe$/, ''))])
  if (why.audit_reason) rows.push(['Decision', human(String(why.audit_reason))])
  if (why.due_at) rows.push(['Due', stamp(String(why.due_at))])
  if (why.template_version) rows.push(['Template', String(why.template_version)])
  return rows
}

function Outbound({ it, onTelemetry, onReview }: { it: Out; onTelemetry: (id: string) => void; onReview: (a: Attachment, d: 'reviewed' | 'rejected') => void }) {
  const [why, setWhy] = useState(false)
  const prov = it.provenance
  const rows = whyRows(it.why)
  return (
    <article className={`emd-msg is-out is-${prov?.kind || (it.automated ? 'system' : 'operator')}${it.failure ? ' is-failed' : ''}`}>
      <header className="emd-msg__head">
        <span className="emd-msg__who"><i className="emd-msg__mark" aria-hidden />{it.automated ? 'LeadCommand' : it.from.name || 'You'}</span>
        {it.automated && prov?.label ? <span className="emd-msg__prov">{prov.label}</span> : null}
        {it.sequence && it.sequence > 1 ? <span className="emd-msg__seq">Follow-up #{it.sequence}</span> : null}
        <time>{stamp(it.at)}</time>
      </header>
      <h4 className="emd-msg__subject">{it.subject}</h4>
      <p className="emd-msg__body">{it.text || '(no text)'}</p>
      {it.attachments.map((a) => <AttachmentChip key={a.id} a={a} onReview={onReview} />)}
      {it.failure ? (
        <p className="emd-msg__fail"><Icon name="alert" /><b>{it.failure.label}</b>{it.failure.what}</p>
      ) : null}
      <footer className="emd-msg__foot">
        <DeliveryTrack it={it} />
        <span className="emd-msg__tools">
          {it.automated && rows.length ? <button type="button" className={`emd-link${why ? ' is-on' : ''}`} aria-expanded={why} onClick={() => setWhy((v) => !v)}>Why it sent</button> : null}
          <button type="button" className="emd-link" onClick={() => onTelemetry(it.id)}>Details</button>
        </span>
      </footer>
      {why ? (
        <dl className="emd-explain is-inline">
          {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
        </dl>
      ) : null}
    </article>
  )
}

const PLANNED_LABEL: Record<string, string> = { scheduled: 'Planned', queued: 'Queued', sending: 'Sending now', awaiting_approval: 'Draft · waiting for your approval' }

function Planned({ it }: { it: Out }) {
  const live = it.status === 'queued' || it.status === 'sending'
  return (
    <article className={`emd-msg is-planned${live ? ' is-live' : ''}`}>
      <header className="emd-msg__head">
        <span className="emd-msg__who">{live ? <span className="emd-orbit" aria-hidden><i /></span> : <Icon name="clock" />}{PLANNED_LABEL[it.status] || human(it.status)}</span>
        {it.provenance?.label ? <span className="emd-msg__prov">{it.provenance.label}</span> : null}
        {it.sequence && it.sequence > 1 ? <span className="emd-msg__seq">Follow-up #{it.sequence}</span> : null}
        <time>{it.status === 'scheduled' ? until(it.at) : ago(it.at)}</time>
      </header>
      <h4 className="emd-msg__subject">{it.subject}</h4>
      {it.text ? <p className="emd-msg__body is-clamp">{it.text}</p> : null}
      {it.why?.why ? <p className="emd-msg__whyline"><Icon name="brain" />{String(it.why.why)}</p> : null}
    </article>
  )
}

function Inbound({ it, explain, t, last, onReview }: { it: In; explain: Sys[]; t: ThreadSummary; last: boolean; onReview: (a: Attachment, d: 'reviewed' | 'rejected') => void }) {
  const [full, setFull] = useState(false)
  const [sig, setSig] = useState(false)
  const u = it.understood as { primary_intent?: string | null; applied?: Array<{ type: string; ok: boolean; value?: unknown }>; flags?: string[]; assertions?: Array<{ type: string }> }
  const flags = u?.flags ?? []
  const applied = (u?.applied ?? []).filter((a) => a.ok)
  const reading = [
    u?.primary_intent ? `Read as ${human(u.primary_intent).toLowerCase()}` : null,
    ...applied.filter(() => !explain.length).map((a) => `${human(a.type)}${a.value ? ` · ${human(String(a.value)).toLowerCase()}` : ''}`),
  ].filter(Boolean) as string[]
  const lines = [...reading, ...explain.map((x) => x.label.replace(/^From this email: /, ''))]
  const paused = last && t.state === 'needs_you' && Boolean(t.needs) && t.context?.kind === 'closing' && t.context.automation_paused
  return (
    <article className="emd-msg is-in">
      <header className="emd-msg__head">
        <span className="emd-msg__who"><b>{it.from.name || it.from.email}</b>{it.from.name ? <span className="emd-msg__addr">{it.from.email}</span> : null}</span>
        <time>{stamp(it.at)}</time>
      </header>
      {flags.includes('wire_instructions') ? <p className="emd-warn"><Icon name="shield" />Mentions wire or bank details — verify by phone with a known number. Never act on emailed wire details.</p> : null}
      {full && it.html ? <div className="emd-msg__html" dangerouslySetInnerHTML={{ __html: it.html }} /> : <p className="emd-msg__body">{it.reply || '(no text)'}</p>}
      {(it.quoted || it.html || (it.signature && !full)) ? (
        <span className="emd-msg__more">
          {it.quoted || it.html ? <button type="button" className="emd-link" onClick={() => setFull((v) => !v)}>{full ? 'Reply only' : 'Show full email'}</button> : null}
          {it.signature && !full ? <button type="button" className="emd-link" onClick={() => setSig((v) => !v)}>{sig ? 'Hide signature' : 'Signature'}</button> : null}
        </span>
      ) : null}
      {sig && it.signature && !full ? <p className="emd-msg__sig">{it.signature}</p> : null}
      {it.attachments.map((a) => <AttachmentChip key={a.id} a={a} onReview={onReview} />)}
      {lines.length ? (
        <div className="emd-explain">
          <span className="emd-explain__eyebrow"><Icon name="brain" />LeadCommand read this</span>
          <ul>{lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
          {paused ? <span className="emd-explain__stop"><Icon name="pause" />Closing automation paused — waiting for your decision</span> : null}
        </div>
      ) : null}
    </article>
  )
}

const DOC_LABEL: Record<string, string> = { title_commitment: 'Title commitment', settlement_statement: 'Settlement statement', seller_contract: 'Seller contract', buyer_agreement: 'Buyer agreement', emd_receipt: 'EMD receipt', proof_of_funds: 'Proof of funds', funding_letter: 'Funding letter', invoice: 'Invoice' }

function AttachmentChip({ a, onReview }: { a: Attachment; onReview: (a: Attachment, d: 'reviewed' | 'rejected') => void }) {
  const label = a.doc_type ? DOC_LABEL[a.doc_type] || human(a.doc_type) : 'Attachment'
  const state = a.review_state === 'auto_classified' ? 'High confidence' : a.review_state === 'needs_review' ? 'Needs review' : a.review_state === 'reviewed' ? 'Reviewed' : a.review_state === 'rejected' ? 'Rejected' : 'Unclassified'
  return (
    <div className={`emd-att is-${a.review_state}`}>
      <span className="emd-att__icon" aria-hidden><Icon name="paperclip" /></span>
      <span className="emd-att__body">
        <b>{label}</b>
        <small>{a.filename}{a.size_bytes ? ` · ${Math.max(1, Math.round(a.size_bytes / 1024))} KB` : ''}</small>
      </span>
      <em className="emd-att__state">{state}{a.routed ? ' · on the closing' : ''}</em>
      <span className="emd-att__acts">
        {a.url ? <a href={a.url} target="_blank" rel="noopener noreferrer">View</a> : null}
        {a.review_state === 'needs_review' || a.review_state === 'unclassified' ? <button type="button" onClick={() => onReview(a, 'reviewed')}>Mark reviewed</button> : null}
      </span>
    </div>
  )
}

/* ── composer ─────────────────────────────────────────────────────────── */

const DRAFT_KEY = (id: string) => `nx.email.draft.${id}`

function AutomationCapsule({ t, owned, delivery }: { t: ThreadSummary; owned: boolean; delivery: Home['delivery'] | null }) {
  const off = delivery ? !delivery.send_enabled : false
  const n = t.next
  if (owned) return <span className="emd-cap is-owned"><Icon name="user" /><b>You own this conversation</b><em>Automation is paused for this thread only</em></span>
  if (t.automation === 'paused') return <span className="emd-cap is-paused"><Icon name="pause" /><b>Automation paused</b></span>
  if (n?.status === 'queued' || n?.status === 'sending') {
    const reply = String(n.action || '').startsWith('seller.reply')
    return (
      <span className="emd-cap is-live" role="status">
        <span className="emd-orbit" aria-hidden><i /></span>
        <b>{reply ? 'LeadCommand is replying' : 'LeadCommand is sending'}</b>
        <em>{n.status === 'sending' ? 'In flight now' : off ? 'Queued — held while sending is off' : `Queued ${ago(n.at)}`}</em>
      </span>
    )
  }
  if (n?.status === 'retrying') return <span className="emd-cap is-live"><Icon name="refresh-cw" /><b>Retrying delivery</b><em>Attempt {(n.attempts || 0) + 1} · {until(n.at)}</em></span>
  if (n?.status === 'held') return <span className="emd-cap is-held"><Icon name="shield" /><b>Held by the safety gate</b><em>{human(n.held_reason)}</em></span>
  if (n) return <span className="emd-cap is-armed"><Icon name="bolt" /><b>{n.sequence && n.sequence > 1 ? `Follow-up #${n.sequence} armed` : 'Next send armed'}</b><em>{until(n.at)}{off ? ' · sending is off' : ''}</em></span>
  if (t.state === 'needs_you') return <span className="emd-cap is-stopped"><Icon name="flag" /><b>{t.escalated ? 'Automation stopped — your call' : 'Waiting on your decision'}</b></span>
  if (t.state === 'failed' && t.failure) return <span className="emd-cap is-failed"><Icon name="alert" /><b>{t.failure.label}</b><em>{t.failure.operator_must_act ? t.failure.action : 'No action required'}</em></span>
  if (t.state === 'waiting') return <span className="emd-cap is-watch"><Icon name="eye" /><b>Watching for a reply</b></span>
  return null
}

function Composer({ t, owned, delivery, drafts, busy, onAct, onSent }: {
  t: ThreadSummary
  owned: boolean
  delivery: Home['delivery'] | null
  drafts: Out[]
  busy: string | null
  onAct: (action: string, fields?: Record<string, unknown>, ok?: string) => Promise<void>
  onSent: (text: string, tone: 'good' | 'bad' | 'muted') => void
}) {
  const [text, setText] = useState(() => { try { return localStorage.getItem(DRAFT_KEY(t.id)) || '' } catch { return '' } })
  const [savedAt, setSavedAt] = useState<number | null>(() => { try { return localStorage.getItem(DRAFT_KEY(t.id)) ? Date.now() : null } catch { return null } })
  const [sending, setSending] = useState(false)
  const [focus, setFocus] = useState(false)
  const key = useMemo(() => `ec:${t.id}:${Date.now().toString(36)}`, [t.id])
  const area = useRef<HTMLTextAreaElement>(null)
  const resolved = t.resolution === 'resolved' && Boolean(t.counterparty.email)
  const canSend = resolved && text.trim().length > 0 && !sending

  // Draft state is real: kept per conversation on this device until sent or cleared.
  useEffect(() => {
    const h = window.setTimeout(() => {
      try {
        if (text.trim()) { localStorage.setItem(DRAFT_KEY(t.id), text); setSavedAt(Date.now()) }
        else { localStorage.removeItem(DRAFT_KEY(t.id)); setSavedAt(null) }
      } catch { /* storage unavailable */ }
    }, 450)
    return () => window.clearTimeout(h)
  }, [text, t.id])

  useEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [text])

  const send = async () => {
    if (!canSend) return
    setSending(true)
    const r = await sendReply({ thread_id: t.id, to: t.counterparty.email!, subject: t.subject?.startsWith('Re:') ? t.subject : `Re: ${t.subject || where(t) || 'your property'}`, body: text.trim(), idempotency_key: key })
    setSending(false)
    if (r.ok) {
      setText('')
      try { localStorage.removeItem(DRAFT_KEY(t.id)) } catch { /* ignore */ }
      onSent(r.send_enabled === false ? 'Queued — email sending is off; it goes when sending is turned on' : 'Queued · sending now', r.send_enabled === false ? 'muted' : 'good')
    } else onSent(r.message || human(r.error) || 'Could not send', 'bad')
  }

  const ctx = t.context
  const fact = ctx?.kind === 'seller' ? ctx.known_facts[0] : null
  const strip = [ctx?.kind === 'seller' ? ctx.stage_label : ctx?.kind === 'closing' ? ctx.waiting_for : null, fact ? `${fact.label} ${fact.key === 'asking_price' ? money(fact.value) : fact.value}` : null].filter(Boolean).join(' · ')

  return (
    <form className={`emd-compose${focus || text ? ' is-active' : ''}`} onSubmit={(e) => { e.preventDefault(); void send() }}>
      <div className="emd-compose__top">
        <AutomationCapsule t={t} owned={owned} delivery={delivery} />
        {strip ? <span className="emd-compose__ctx">{strip}</span> : null}
      </div>
      {drafts.map((d) => (
        <div key={d.id} className="emd-suggest">
          <span className="emd-suggest__eyebrow"><Icon name="spark" />Suggested by LeadCommand · waiting for your approval</span>
          <p>{d.text || d.subject}</p>
          <span className="emd-suggest__acts">
            <button type="button" className="emd-btn is-quiet" onClick={() => setText(d.text || '')}>Edit as reply</button>
            <button type="button" className="emd-btn is-quiet" disabled={busy !== null} onClick={() => onAct('cancel_message', { queue_id: d.id }, 'Draft discarded')}>Discard</button>
            <button type="button" className="emd-btn is-primary" disabled={busy !== null} onClick={() => onAct('approve_send', { queue_id: d.id }, 'Approved — sending')}>Approve &amp; send</button>
          </span>
        </div>
      ))}
      <div className="emd-compose__box">
        <textarea
          ref={area}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send() } }}
          rows={1}
          placeholder={resolved ? `Reply to ${who(t)}` : 'Identify this sender before replying'}
          disabled={!resolved}
          aria-label="Reply"
        />
        <span className="emd-compose__bar">
          <span className="emd-compose__meta">
            {resolved ? <span>To {t.counterparty.email}</span> : <span>Replies are disabled until the sender is identified</span>}
            {savedAt && text.trim() ? <span className="emd-compose__saved"><Icon name="check" />Draft saved</span> : null}
          </span>
          <button type="submit" className="emd-send" disabled={!canSend} aria-label="Send reply" title="Send  ⌘↵"><Icon name="send" />Send</button>
        </span>
      </div>
    </form>
  )
}

/* ── message telemetry (level 4) ──────────────────────────────────────── */

function TelemetryPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const [msg, setMsg] = useState<MessageTelemetry | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { fetchMessage(id).then(setMsg).catch((e) => setErr((e as Error).message)) }, [id])
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return (
    <div className="emd-pop" role="dialog" aria-label="Message details" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="emd-pop__panel">
        <header>
          <span className="emd-pop__eyebrow">Message</span>
          <h3>{msg?.message.subject || 'Loading…'}</h3>
          <button type="button" className="emd-icon" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
        </header>
        {msg ? (
          <>
            <dl className="emd-dl">
              {([
                ['Status', human(msg.message.status)],
                ['To', msg.message.to],
                ['From', [msg.message.from, msg.message.sender].filter(Boolean).join(' · ')],
                ['Sending domain', msg.message.sending_domain],
                ['Provider', msg.message.provider],
                ['Lane', human(msg.message.lane)],
                ['Campaign', msg.message.campaign_id],
                ['Template', [msg.message.template, msg.message.template_version].filter(Boolean).join(' · ')],
                ['Sent', stamp(msg.message.sent_at)],
                ['Delivered', stamp(msg.engagement.delivered_at) || (msg.message.sent_at ? 'Not confirmed by the provider' : '')],
                ['Open signals', msg.engagement.open_signals ? `${msg.engagement.open_signals} · ${msg.engagement.likely_human_opens} likely human` : 'None'],
                ['Clicks', msg.engagement.clicks ? String(msg.engagement.clicks) : 'None'],
                ['Reply', stamp(msg.engagement.replied_at) || 'None'],
                ['Bounce', msg.engagement.bounce ? `${human(msg.engagement.bounce.type)}${msg.engagement.bounce.reason ? ` — ${msg.engagement.bounce.reason}` : ''}` : 'None'],
                ['Why it sent', msg.message.why?.why ? String(msg.message.why.why) : msg.message.source === 'manual' ? 'Sent by an operator' : ''],
                ['Logical ID', msg.message.logical_id],
              ] as Array<[string, unknown]>).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{String(v)}</dd></div>)}
            </dl>
            <p className="emd-caveat">Open signals include privacy proxies and security scanners — they are not proof a person read the email.</p>
            {msg.events.length ? (
              <ol className="emd-events">
                {msg.events.map((e, i) => <li key={i}><time>{stamp(e.event_at)}</time><b>{human(e.event_type)}</b><small>{human(e.event_source)}{e.signal_class ? ` · ${human(e.signal_class)}` : ''}{e.reason ? ` · ${e.reason}` : ''}</small></li>)}
              </ol>
            ) : null}
          </>
        ) : <p className="emd-none">{err ? 'Could not load this message.' : 'Reading the message ledger…'}</p>}
      </div>
    </div>
  )
}

