import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../shared/icons'
import { pushRoutePath } from '../../../app/router'
import { useBackHandler } from '../../../domain/navigation/useBackHandler'
import {
  fetchMessage, fetchThread, postThreadAction, sendReply,
  type Attachment, type Item, type MessageTelemetry, type ThreadRoom, type ThreadSummary, type Why,
} from './email-command-api'
import { AUTOMATION_LABEL, ROLE_LABEL, STATE_LABEL, STATE_TONE, ago, human, money, stamp, until, where, who } from './email-format'
import { LiquidField, Monogram } from './Monogram'
import { emailRoomHost } from './sheet-host'

/**
 * CONVERSATION ROOM. Entity, deal and business state first; then the email
 * thread with system events interleaved; then what happens next and why.
 * Email Command never decides business state — "View closing" / "Open SMS"
 * hand off to the owning app.
 */

type Sheet = { kind: 'why'; title: string; why: Why | null; at?: string | null } | { kind: 'message'; id: string } | null

export function EmailThreadRoom({ id, fallback, onClose, onChanged }: { id: string; fallback: ThreadSummary | null; onClose: () => void; onChanged?: () => void }) {
  const [room, setRoom] = useState<ThreadRoom | null>(fallback ? { thread: fallback, sms_thread_key: null, items: [] } : null)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [sheet, setSheet] = useState<Sheet>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ tone: 'good' | 'bad' | 'muted'; text: string } | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)

  useBackHandler(true, 'email-room', 'Close conversation', () => { if (sheet) setSheet(null); else onClose(); return true })

  useEffect(() => {
    const ac = new AbortController()
    fetchThread(id, ac.signal)
      .then((r) => { setRoom(r); setLoaded(true); setError(null) })
      .catch((err) => { if ((err as Error)?.name !== 'AbortError') setError((err as Error)?.message || 'unavailable') })
    return () => ac.abort()
  }, [id, reloadKey])

  useEffect(() => { void postThreadAction(id, 'mark_read') }, [id])
  useEffect(() => { if (loaded) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }) }, [loaded])

  const act = useCallback(async (action: string, fields: Record<string, unknown> = {}, ok = 'Done') => {
    setBusy(action)
    // The handoff is felt immediately; the server confirms (or reverts) it.
    const before = room
    if (room && (action === 'take_over' || action === 'return_to_system')) {
      const owned = action === 'take_over'
      setRoom({ ...room, thread: { ...room.thread, automation: owned ? 'paused_you_own_it' : 'on', ball: owned ? 'you' : room.thread.ball === 'you' ? 'leadcommand' : room.thread.ball, next: owned ? null : room.thread.next } })
    }
    const r = await postThreadAction(id, action, fields)
    if (!r.ok && before) setRoom(before)
    setBusy(null)
    setNotice(r.ok ? { tone: 'good', text: action === 'take_over' ? `You own this conversation${r.stopped ? ` · ${r.stopped} scheduled email${r.stopped === 1 ? '' : 's'} stopped` : ''}` : ok } : { tone: 'bad', text: r.message || human(r.code) || 'Not accepted' })
    if (r.ok && !r.demo) { setReloadKey((k) => k + 1); onChanged?.() }
  }, [id, onChanged, room])

  const t = room?.thread ?? null
  const tone = t ? STATE_TONE[t.state] : 'active'
  const owned = t?.automation === 'paused_you_own_it'

  return createPortal(
    <div className={`em2-room is-${tone}${owned ? ' is-owned' : ''}`} role="dialog" aria-modal="true" aria-label={t ? who(t) : 'Conversation'} data-testid="email-room">
      <LiquidField needs={t?.state === 'needs_you'} live={t?.state === 'system_handling'} />
      <div className="em2-room__scroll" ref={scrollRef}>
        <header className="em2-room__bar">
          <button type="button" className="em2-icon" aria-label="Back to Email Command" onClick={onClose}><Icon name="chevron-left" /></button>
          <span className="em2-eyebrow"><i />Conversation</span>
          {t ? <span className="em2-role">{ROLE_LABEL[t.category] || t.category}</span> : <span />}
        </header>
        {!t ? (
          <div className="em2-room__state">{error ? <><Icon name="alert" /><strong>{error === 'not_found' ? 'This conversation no longer exists' : 'Could not open this conversation'}</strong></> : <span className="em2-skel__row"><i /><i /><i /></span>}</div>
        ) : (
          <>
            <ContextHero t={t} onWhy={(why, at) => setSheet({ kind: 'why', title: 'Why this is scheduled', why, at })} />
            {t.needs ? (
              <section className="em2-needs" role="alert">
                <span className="em2-needs__eyebrow">Needs you</span>
                <p>{t.needs.reason}</p>
                <button type="button" className="em2-needs__act" disabled={busy !== null} onClick={() => act('resolve_needs', {}, 'Marked handled')}>Mark handled</button>
              </section>
            ) : null}
            {t.approvals.map((a) => (
              <section key={a.queue_id} className="em2-needs is-draft">
                <span className="em2-needs__eyebrow">Draft ready · review & send</span>
                <p>{a.subject}</p>
                {a.why?.why ? <small>{String(a.why.why)}</small> : null}
                <div className="em2-needs__acts">
                  <button type="button" className="em2-btn is-quiet" disabled={busy !== null} onClick={() => act('cancel_message', { queue_id: a.queue_id }, 'Draft discarded')}>Discard</button>
                  <button type="button" className="em2-btn" disabled={busy !== null} onClick={() => act('approve_send', { queue_id: a.queue_id }, 'Approved — sending')}>Approve & send</button>
                </div>
              </section>
            ))}
            {owned ? (
              <div className="em2-handoff" role="status"><Icon name="user" /><span>You own this conversation<small>Automation is paused for this thread only. Return it to LeadCommand when you're done.</small></span></div>
            ) : null}
            {notice && !(owned && notice.tone === 'good') ? <p className={`em2-notice is-${notice.tone}`} role="status">{notice.text}</p> : null}
            <Timeline items={room?.items ?? []} loaded={loaded} openMessage={(mid) => setSheet({ kind: 'message', id: mid })} openWhy={(why, title) => setSheet({ kind: 'why', title, why })} onReview={(a, decision) => act('review_attachment', { attachment_id: a.id, decision }, decision === 'reviewed' ? 'Marked reviewed' : 'Rejected')} />
          </>
        )}
      </div>

      {t ? <Composer t={t} onSent={(text, tone) => { setNotice({ tone, text }); setReloadKey((k) => k + 1); onChanged?.() }} /> : null}

      {t ? (
        <nav className="em2-actionbar" aria-label="Conversation actions">
          {t.context?.kind === 'closing' ? <button type="button" onClick={() => pushRoutePath(t.context!.kind === 'closing' ? (t.context as { open: string }).open : '/closing-desk')}><Icon name="key" />View closing</button> : null}
          {t.context?.kind === 'seller' && t.context.open_sms ? <button type="button" onClick={() => pushRoutePath(t.context!.kind === 'seller' ? (t.context as { open_sms: string }).open_sms : '/inbox')}><Icon name="message" />Open SMS</button> : null}
          {t.context?.kind === 'seller' && t.context.open_deal ? <button type="button" onClick={() => pushRoutePath((t.context as { open_deal: string }).open_deal)}><Icon name="target" />Deal</button> : null}
          {t.automation === 'paused_you_own_it'
            ? <button type="button" className="is-owner" disabled={busy !== null} onClick={() => act('return_to_system', {}, 'Returned to LeadCommand')}><Icon name="play" />Return to LeadCommand</button>
            : <button type="button" disabled={busy !== null} onClick={() => act('take_over')}><Icon name="user" />Take over</button>}
        </nav>
      ) : null}

      {sheet ? <SheetView sheet={sheet} onClose={() => setSheet(null)} /> : null}
    </div>,
    emailRoomHost(),
  )
}

function BallTrack({ t }: { t: ThreadSummary }) {
  const them = ROLE_LABEL[t.counterparty.role] || 'Them'
  const nodes: Array<[string, string]> = [['you', 'You'], ['leadcommand', 'LeadCommand'], ['them', them]]
  return (
    <ol className={`em2-ball-track is-${t.ball || 'none'}${t.automation === 'paused_you_own_it' ? ' is-owned' : ''}`} aria-label={`Ball: ${t.ball || 'nobody'}`}>
      {nodes.map(([k, label]) => <li key={k} className={t.ball === k ? 'is-on' : ''}><i aria-hidden /><span>{label}</span></li>)}
    </ol>
  )
}

function NextCapsule({ t, onWhy }: { t: ThreadSummary; onWhy: (why: Why | null, at: string) => void }) {
  if (!t.next) {
    if (!['paused', 'paused_you_own_it', 'failed', 'sending'].includes(t.automation)) return null
    return <span className={`em2-capsule is-${t.automation}`}><i aria-hidden /><span>{AUTOMATION_LABEL[t.automation] || t.automation}</span></span>
  }
  const now = Date.now()
  const start = Date.parse(t.last_message.at || '') || now - 864e5
  const end = Date.parse(t.next.at)
  const pct = Number.isFinite(end) && end > start ? Math.min(100, Math.max(4, ((now - start) / (end - start)) * 100)) : 50
  return (
    <button type="button" className="em2-capsule is-next" onClick={() => onWhy(t.next!.why, t.next!.at)}>
      <i aria-hidden />
      <span className="em2-capsule__what"><em>{t.next.sequence && t.next.sequence > 1 ? `Follow-up #${t.next.sequence}` : human(t.next.action?.split('.').pop())}</em>{until(t.next.at)}</span>
      <span className="em2-capsule__why">Why?</span>
      <span className="em2-capsule__bar" style={{ ['--p' as string]: `${pct}%` }} aria-hidden />
    </button>
  )
}

function ContextHero({ t, onWhy }: { t: ThreadSummary; onWhy: (why: Why | null, at: string) => void }) {
  const place = where(t)
  const ctx = t.context
  return (
    <section className={`em2-hero is-${STATE_TONE[t.state]}`}>
      <span className="em2-sheen" aria-hidden />
      <span className="em2-hero__id">
        <Monogram t={t} />
        <span>
          <span className="em2-hero__who">{who(t)}</span>
          <span className="em2-hero__addr">{ROLE_LABEL[t.counterparty.role] || t.category}</span>
        </span>
        <span className={`em2-pill is-${STATE_TONE[t.state]}`}>{STATE_LABEL[t.state]}</span>
      </span>
      {place ? <strong className="em2-hero__place">{place}</strong> : null}
      {ctx?.kind === 'closing' ? <span className="em2-hero__state"><em>Closing</em>{ctx.waiting_for}</span> : null}
      {ctx?.kind === 'seller' ? (
        <>
          {ctx.stage_label ? <span className="em2-hero__state"><em>Seller</em>{ctx.stage_label}</span> : null}
          {ctx.known_facts.length ? (
            <ul className="em2-facts" aria-label="Known facts">
              {ctx.known_facts.map((f) => <li key={f.key}><em>{f.label}</em><b>{f.key === 'asking_price' ? money(f.value) : String(f.value)}</b></li>)}
            </ul>
          ) : null}
          {t.contact_preference === 'email' ? <span className="em2-hero__pref"><Icon name="mail" />Seller prefers email</span> : null}
        </>
      ) : null}
      <BallTrack t={t} />
      <NextCapsule t={t} onWhy={onWhy} />
    </section>
  )
}

function Timeline({ items, loaded, openMessage, openWhy, onReview }: { items: Item[]; loaded: boolean; openMessage: (id: string) => void; openWhy: (why: Why | null, title: string) => void; onReview: (a: Attachment, decision: 'reviewed' | 'rejected') => void }) {
  if (!loaded && !items.length) return <div className="em2-skel"><span className="em2-skel__row"><i /><i /><i /></span></div>
  if (!items.length) return <p className="em2-none">No messages in this conversation yet.</p>
  return (
    <ol className="em2-thread" aria-label="Conversation">
      {items.map((it, i) => (
        <li key={`${it.kind}:${'id' in it ? it.id : i}`} className={`em2-item is-${it.kind}`}>
          {it.kind === 'system' ? (
            <div className="em2-sys"><i aria-hidden /><b>{it.label}</b><time>{ago(it.at)}</time></div>
          ) : it.kind === 'inbound' ? (
            <InboundBubble it={it} onReview={onReview} />
          ) : (
            <OutboundBubble it={it} openMessage={openMessage} openWhy={openWhy} onReview={onReview} />
          )}
        </li>
      ))}
    </ol>
  )
}

function InboundBubble({ it, onReview }: { it: Extract<Item, { kind: 'inbound' }>; onReview: (a: Attachment, d: 'reviewed' | 'rejected') => void }) {
  const [full, setFull] = useState(false)
  const [sig, setSig] = useState(false)
  const flags = it.understood?.flags ?? []
  return (
    <div className="em2-bubble is-in">
      <span className="em2-bubble__meta"><b>{it.from.name || it.from.email}</b><time>{stamp(it.at)}</time></span>
      {flags.includes('wire_instructions') ? <span className="em2-warn"><Icon name="shield" />Mentions wire / bank details — verify by phone with a known number</span> : null}
      {full && it.html ? <div className="em2-html" dangerouslySetInnerHTML={{ __html: it.html }} /> : <p className="em2-text">{it.reply || '(no text)'}</p>}
      {it.signature && !full ? (sig ? <p className="em2-sig">{it.signature}</p> : <button type="button" className="em2-link is-small" onClick={() => setSig(true)}>Signature</button>) : null}
      {(it.quoted || it.html) ? <button type="button" className="em2-link is-small" onClick={() => setFull((v) => !v)}>{full ? 'Show reply only' : 'Show previous message'}</button> : null}
      {it.attachments.map((a) => <AttachmentCard key={a.id} a={a} onReview={onReview} />)}
      {it.understood?.applied?.filter((a) => a.ok).length ? <span className="em2-applied"><Icon name="check" />{it.understood.applied.filter((a) => a.ok).map((a) => human(a.type)).join(' · ')}</span> : null}
    </div>
  )
}

function Telemetry({ it }: { it: Extract<Item, { kind: 'outbound' }> }) {
  const e = it.engagement
  if (['scheduled', 'queued', 'awaiting_approval', 'cancelled', 'superseded', 'failed', 'sending'].includes(it.status)) {
    return <span className={`em2-tel is-${it.status}`}><span className="is-on">{human(it.status)}</span></span>
  }
  const steps: Array<[string, boolean, string]> = [
    ['Sent', true, ''],
    ['Delivered', Boolean(e.delivered_at), ''],
    [e.open_signals ? `Opened ${e.open_signals}×` : 'Opened', e.open_signals > 0, ''],
    ...(e.clicks ? [[`Clicked ${e.clicks}×`, true, ''] as [string, boolean, string]] : []),
    [e.bounce ? (e.bounce.type === 'soft_bounce' ? 'Soft bounce' : 'Bounced') : 'Replied', Boolean(e.replied_at || e.bounce), e.bounce ? 'is-bad' : 'is-good'],
  ]
  return (
    <span className={`em2-tel is-${it.status}`}>
      {steps.map(([label, on, cls], i) => <span key={i} className={`${on ? 'is-on' : ''} ${on ? cls : ''}`}>{label}</span>)}
    </span>
  )
}

function OutboundBubble({ it, openMessage, openWhy, onReview }: { it: Extract<Item, { kind: 'outbound' }>; openMessage: (id: string) => void; openWhy: (why: Why | null, title: string) => void; onReview: (a: Attachment, d: 'reviewed' | 'rejected') => void }) {
  return (
    <div className={`em2-bubble is-out${['cancelled', 'superseded'].includes(it.status) ? ' is-void' : ''}`}>
      <span className="em2-bubble__meta">
        <b>{it.automated ? 'LeadCommand' : it.from.name || 'You'}</b>
        {it.sequence && it.sequence > 1 ? <em>Follow-up #{it.sequence}</em> : null}
        <time>{stamp(it.at)}</time>
      </span>
      <p className="em2-text">{it.text || it.subject}</p>
      {it.cancel_reason ? <span className="em2-void">Not sent — {human(it.cancel_reason.split(':')[0])}</span> : null}
      <span className="em2-bubble__foot">
        <button type="button" className="em2-telbtn" onClick={() => openMessage(it.id)}><Telemetry it={it} /><Icon name="chevron-right" /></button>
        {it.automated && it.why ? <button type="button" className="em2-link is-small" onClick={() => openWhy(it.why, 'Why this email sent')}>Why?</button> : null}
      </span>
      {it.attachments.map((a) => <AttachmentCard key={a.id} a={a} onReview={onReview} />)}
    </div>
  )
}

const DOC_LABEL: Record<string, string> = { title_commitment: 'Title commitment', settlement_statement: 'Settlement statement', seller_contract: 'Seller contract', buyer_agreement: 'Buyer agreement', emd_receipt: 'EMD receipt', proof_of_funds: 'Proof of funds', funding_letter: 'Funding letter', invoice: 'Invoice' }

function AttachmentCard({ a, onReview }: { a: Attachment; onReview: (a: Attachment, d: 'reviewed' | 'rejected') => void }) {
  const label = a.doc_type ? DOC_LABEL[a.doc_type] || human(a.doc_type) : 'Attachment'
  const state = a.review_state === 'auto_classified' ? 'High confidence' : a.review_state === 'needs_review' ? 'Needs review' : a.review_state === 'reviewed' ? 'Reviewed' : a.review_state === 'rejected' ? 'Rejected' : 'Unclassified'
  return (
    <div className={`em2-att is-${a.review_state}`}>
      <Icon name="paperclip" />
      <span className="em2-att__body">
        <b>{label}</b>
        <small>{a.filename}{a.size_bytes ? ` · ${Math.max(1, Math.round(a.size_bytes / 1024))} KB` : ''}</small>
        <em>{state}{a.routed ? ' · attached to closing' : ''}{a.fetch_status !== 'stored' ? ` · ${human(a.fetch_status)}` : ''}</em>
      </span>
      <span className="em2-att__acts">
        {a.url ? <a href={a.url} target="_blank" rel="noopener noreferrer">View</a> : null}
        {a.review_state === 'needs_review' || a.review_state === 'unclassified' ? <button type="button" onClick={() => onReview(a, 'reviewed')}>Reviewed</button> : null}
      </span>
    </div>
  )
}

function Composer({ t, onSent }: { t: ThreadSummary; onSent: (text: string, tone: 'good' | 'bad' | 'muted') => void }) {
  const [text, setText] = useState('')

  const [sending, setSending] = useState(false)
  const key = useMemo(() => `ec:${t.id}:${Date.now().toString(36)}`, [t.id])
  const canSend = Boolean(t.counterparty.email) && t.resolution === 'resolved' && text.trim().length > 0 && !sending
  const ctx = t.context
  const strip = [where(t), ctx?.kind === 'seller' ? ctx.stage_label : ctx?.kind === 'closing' ? ctx.waiting_for : null, ctx?.kind === 'seller' && ctx.known_facts[0] ? `${ctx.known_facts[0].label} ${ctx.known_facts[0].key === 'asking_price' ? money(ctx.known_facts[0].value) : ctx.known_facts[0].value}` : null].filter(Boolean).join(' · ')
  const send = async () => {
    if (!canSend) return
    setSending(true)
    const r = await sendReply({ thread_id: t.id, to: t.counterparty.email!, subject: t.subject?.startsWith('Re:') ? t.subject : `Re: ${t.subject || where(t) || 'your property'}`, body: text.trim(), idempotency_key: key })
    setSending(false)
    if (r.ok) {
      setText('')
      onSent(r.send_enabled === false ? 'Queued — email sending is off, it will go when enabled' : 'Queued · sending now', r.send_enabled === false ? 'muted' : 'good')
    } else onSent(r.message || human(r.error) || 'Could not send', 'bad')
  }
  return (
    <form className="em2-compose" onSubmit={(e) => { e.preventDefault(); void send() }}>
      {strip ? <span className="em2-compose__ctx">{strip}</span> : null}
      <span className="em2-compose__row">
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={text.split('\n').length > 3 ? 5 : 2} placeholder={t.resolution === 'resolved' ? `Reply to ${who(t)}` : 'Identify this sender before replying'} disabled={t.resolution !== 'resolved'} aria-label="Reply" />
        <button type="submit" className="em2-send" disabled={!canSend} aria-label="Send reply"><Icon name="send" /></button>
      </span>
    </form>
  )
}

function SheetView({ sheet, onClose }: { sheet: NonNullable<Sheet>; onClose: () => void }) {
  const [msg, setMsg] = useState<MessageTelemetry | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    if (sheet.kind !== 'message') return
    fetchMessage(sheet.id).then(setMsg).catch((e) => setErr((e as Error).message))
  }, [sheet])
  return (
    <div className="em2-sheet" role="dialog" aria-modal="true" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="em2-sheet__panel">
        <span className="em2-sheet__grip" aria-hidden />
        {sheet.kind === 'why' ? (
          <>
            <h3>{sheet.title}</h3>
            <dl className="em2-dl">
              {whyRows(sheet.why, sheet.at).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
            </dl>
          </>
        ) : msg ? (
          <>
            <h3>{msg.message.subject}</h3>
            <dl className="em2-dl">
              {([
                ['Status', human(msg.message.status)],
                ['To', msg.message.to],
                ['From', [msg.message.from, msg.message.sender].filter(Boolean).join(' · ')],
                ['Sending domain', msg.message.sending_domain],
                ['Provider', msg.message.provider],
                ['Lane', human(msg.message.lane)],
                ['Campaign', msg.message.campaign_id],
                ['Sequence step', msg.message.sequence_step],
                ['Template', [msg.message.template, msg.message.template_version].filter(Boolean).join(' · ')],
                ['Sent', stamp(msg.message.sent_at)],
                ['Delivered', stamp(msg.engagement.delivered_at) || (msg.message.sent_at ? 'Not confirmed by provider' : '')],
                ['Open signals', msg.engagement.open_signals ? `${msg.engagement.open_signals} · first ${stamp(msg.engagement.first_open_at)} · last ${stamp(msg.engagement.last_open_at)}` : 'None'],
                ['Clicks', msg.engagement.clicks ? `${msg.engagement.clicks}` : 'None'],
                ['Reply', stamp(msg.engagement.replied_at) || 'None'],
                ['Bounce', msg.engagement.bounce ? `${human(msg.engagement.bounce.type)}${msg.engagement.bounce.reason ? ` — ${msg.engagement.bounce.reason}` : ''}` : 'None'],
                ['Why it sent', msg.message.why?.why ? String(msg.message.why.why) : msg.message.source === 'manual' ? 'Sent by an operator' : ''],
                ['Logical ID', msg.message.logical_id],
              ] as Array<[string, unknown]>).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{String(v)}</dd></div>)}
            </dl>
            <p className="em2-caveat">Open signals include privacy proxies and security scanners — they are not proof a person read the email.</p>
            {msg.links.length ? (
              <>
                <h4>Links</h4>
                <ul className="em2-links">{msg.links.map((l) => <li key={l.id}><span>{l.destination_url}</span><b>{l.clicks}</b></li>)}</ul>
              </>
            ) : null}
            <details className="em2-details">
              <summary>Event history ({msg.events.length})</summary>
              <ol>{msg.events.map((e, i) => <li key={i}><time>{stamp(e.event_at)}</time><b>{human(e.event_type)}</b><small>{human(e.event_source)}{e.signal_class ? ` · ${human(e.signal_class)}` : ''}{e.reason ? ` · ${e.reason}` : ''}</small></li>)}</ol>
            </details>
          </>
        ) : <p className="em2-none">{err ? 'Could not load this message.' : 'Loading…'}</p>}
        <button type="button" className="em2-btn is-quiet em2-sheet__close" onClick={onClose}>Close</button>
      </div>
    </div>
  )
}

function whyRows(why: Why | null, at?: string | null): Array<[string, string]> {
  if (!why) return [['Reason', 'No reason was recorded']]
  const rows: Array<[string, string]> = []
  if (why.why) rows.push(['Reason', String(why.why)])
  if (why.category) rows.push(['Follow-up family', human(String(why.category).split(':')[0])])
  if (why.sequence) rows.push(['Follow-up', `#${why.sequence}`])
  if (why.due_at) rows.push(['Due', stamp(String(why.due_at))])
  if (at) rows.push(['Scheduled', until(at)])
  if (why.use_case) rows.push(['Seller question', human(String(why.use_case))])
  if (why.audit_reason) rows.push(['Decision', human(String(why.audit_reason))])
  if (why.template_version) rows.push(['Template', String(why.template_version)])
  return rows.length ? rows : [['Reason', 'No reason was recorded']]
}
