import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Icon } from '../../../shared/icons'
import { LCButton, LCConfirm, LCEmpty, LCError, LCIconButton, LCSkeleton, LCStatus, cx } from '../../../shared/lc'
import {
  SHARE_KINDS, fetchPortalConversations, fetchPortalThread, humanCode, postPortalAction,
  type PortalConversation, type PortalShare, type PortalShareable, type PortalThread, type ShareKind,
} from '../../../domain/seller-portal/seller-portal-ops-api'
import { formatExactTime, formatRelativeTime } from './ledger-model'
import './seller-portal-panel.css'

/**
 * SELLER PORTAL — the conversations sellers start from their portal, read
 * from /api/cockpit/seller-portal. A list (unread first) that opens one
 * thread in place: its messages, a reply box, the documents shared with the
 * seller and the calls they booked. Opening a thread marks it read on the
 * server; every write re-reads the thread rather than patching it.
 */

const sortUnreadFirst = (list: PortalConversation[]) =>
  [...list].sort((a, b) => Number(b.unread) - Number(a.unread) || Date.parse(b.last_at) - Date.parse(a.last_at))

const AUTHOR_WORD: Record<string, string> = { seller: 'Seller', operator: 'You', system: 'System' }

export function SellerPortalPanel() {
  const [openId, setOpenId] = useState<string | null>(null)
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [list, setList] = useState<{ key: string; rows: PortalConversation[] } | null>(null)
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null)
  const [tick, setTick] = useState(0)

  const key = `${unreadOnly}:${tick}`
  useEffect(() => {
    const ctl = new AbortController()
    fetchPortalConversations(unreadOnly, ctl.signal).then((d) => { setList({ key, rows: sortUnreadFirst(d.conversations) }); setFailure(null) })
      .catch((e: unknown) => { if (!ctl.signal.aborted) setFailure({ key, message: humanCode(e instanceof Error ? e.message : 'seller_portal_failed') }) })
    return () => ctl.abort()
  }, [key, unreadOnly])
  // new seller messages arrive on a quiet re-read while the list is in view
  useEffect(() => {
    if (openId) return
    const id = window.setInterval(() => { if (document.visibilityState === 'visible') setTick((t) => t + 1) }, 45_000)
    return () => window.clearInterval(id)
  }, [openId])

  const markedRead = useCallback((id: string) => {
    setList((l) => (l ? { ...l, rows: l.rows.map((r) => (r.opportunity_id === id ? { ...r, unread: false } : r)) } : l))
  }, [])

  if (openId) return <PortalThreadPane id={openId} onBack={() => { setOpenId(null); setTick((t) => t + 1) }} onRead={markedRead} />

  const rows = list?.rows ?? null
  const error = failure?.key === key ? failure.message : null
  const unread = rows?.filter((r) => r.unread).length ?? 0
  return (
    <section className="spx" aria-label="Seller portal conversations">
      <header className="spx-head">
        <h2 className="spx-title">Seller portal{rows ? <span className="spx-count">{unread ? `${unread} unread` : 'All read'}</span> : null}</h2>
        <label className="spx-toggle"><input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />Unread only</label>
      </header>
      {error && !rows ? <LCError compact what="Portal conversations didn't load" detail={error} onRetry={() => setTick((t) => t + 1)} />
        : !rows ? <LCSkeleton shape="rows" count={5} label="Loading portal conversations" />
          : !rows.length ? (
            <LCEmpty compact tone="calm" icon="inbox" title={unreadOnly ? 'No unread portal messages' : 'No portal conversations yet'}
              body="When a seller writes from their portal, the conversation appears here with the property and stage." />
          ) : (
            <ul className="spx-list">
              {rows.map((r) => (
                <li key={r.opportunity_id}>
                  <button type="button" className={cx('spx-row', r.unread && 'is-unread')} onClick={() => setOpenId(r.opportunity_id)}
                    aria-label={`${r.opportunity?.seller_display_name || 'Seller'}${r.unread ? ', unread' : ''} — open conversation`}>
                    <span className="spx-row__dot" aria-hidden="true" />
                    <span className="spx-row__main">
                      <b>{r.opportunity?.seller_display_name || 'Seller not named'}</b>
                      <span className="spx-row__addr">{r.opportunity?.property_address_full || 'No property address'}</span>
                      <span className="spx-row__preview">{AUTHOR_WORD[r.last_author] ?? 'Seller'}: {r.preview || 'No text'}</span>
                    </span>
                    <span className="spx-row__meta">
                      <time dateTime={r.last_at} title={formatExactTime(r.last_at)}>{formatRelativeTime(r.last_at)}</time>
                      {r.opportunity?.acquisition_stage ? <span>{humanCode(r.opportunity.acquisition_stage)}</span> : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
      {error && rows ? <p className="spx-error" role="status">The last refresh failed: {error}</p> : null}
    </section>
  )
}

function PortalThreadPane({ id, onBack, onRead }: { id: string; onBack: () => void; onRead: (id: string) => void }) {
  const [data, setData] = useState<{ id: string; thread: PortalThread } | null>(null)
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null)
  const [tick, setTick] = useState(0)
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const [replyError, setReplyError] = useState<string | null>(null)
  const [sharing, setSharing] = useState<PortalShareable | null>(null)
  const [revoking, setRevoking] = useState<PortalShare | null>(null)

  useEffect(() => {
    const ctl = new AbortController()
    fetchPortalThread(id, ctl.signal).then((d) => { setData({ id, thread: d }); setFailure(null) })
      .catch((e: unknown) => { if (!ctl.signal.aborted) setFailure({ id, message: humanCode(e instanceof Error ? e.message : 'seller_portal_failed') }) })
    return () => ctl.abort()
  }, [id, tick])
  // opening the thread is reading it: one mark on the server, mirrored in the list
  useEffect(() => {
    postPortalAction(id, { action: 'mark_read' }).then(() => onRead(id)).catch(() => { /* stays unread; the list re-reads on back */ })
  }, [id, onRead])

  const t = data?.id === id ? data.thread : null
  const error = failure?.id === id ? failure.message : null
  const reload = () => setTick((n) => n + 1)
  const sharedIds = useMemo(() => new Set((t?.documents.shares ?? []).filter((s) => !s.revoked_at).map((s) => s.attachment_id)), [t])

  const send = async (e?: FormEvent) => {
    e?.preventDefault()
    const body = reply.trim()
    if (!body) return
    setSending(true)
    setReplyError(null)
    try { await postPortalAction(id, { action: 'reply', body }); setReply(''); reload() } catch (err) { setReplyError(humanCode(err instanceof Error ? err.message : 'reply_failed')) } finally { setSending(false) }
  }

  return (
    <section className="spx spx-thread" aria-label="Seller portal conversation">
      <header className="spx-thread__head">
        <LCIconButton icon="chevron-left" label="Back to portal conversations" size="sm" onClick={onBack} />
        <div className="spx-thread__title">
          <h2 className="spx-title">{t?.opportunity.seller || (t ? 'Seller not named' : 'Loading…')}</h2>
          {t ? <p className="spx-muted">{[t.opportunity.address, humanCode(t.opportunity.stage), humanCode(t.opportunity.status), t.opportunity.assigned_operator ? `Owner ${t.opportunity.assigned_operator}` : null].filter(Boolean).join(' · ')}</p> : null}
        </div>
      </header>
      {error && !t ? <LCError compact what="This conversation didn't load" detail={error} onRetry={reload} />
        : !t ? <LCSkeleton shape="lines" count={6} label="Loading conversation" />
          : (
            <div className="spx-thread__body">
              {t.portal_accounts.length ? <p className="spx-muted">Portal access: {t.portal_accounts.map((p) => p.name ? `${p.name} <${p.email}>` : p.email).join(', ')}</p> : null}

              <ol className="spx-msgs" aria-label="Messages">
                {t.messages.length ? t.messages.map((m) => (
                  <li key={m.id} className={cx('spx-msg', `is-${m.author_kind === 'seller' ? 'seller' : m.author_kind === 'system' ? 'system' : 'operator'}`)}>
                    <span className="spx-msg__who">{m.author_kind === 'seller' ? 'Seller' : m.author_kind === 'system' ? 'System' : m.author_operator || 'Team'} · <time dateTime={m.created_at} title={formatExactTime(m.created_at)}>{formatRelativeTime(m.created_at)}</time></span>
                    <p>{m.body}</p>
                  </li>
                )) : <li className="spx-muted">No messages yet. A reply here appears in the seller's portal.</li>}
              </ol>

              <form className="spx-reply" onSubmit={(e) => void send(e)}>
                <label className="spx-field">
                  <span>Reply in the portal</span>
                  <textarea className="spx-input" rows={3} value={reply} onChange={(e) => setReply(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send() } }} />
                </label>
                {replyError ? <p className="spx-error" role="alert">{replyError}</p> : null}
                <div className="spx-actions"><LCButton type="submit" variant="primary" size="sm" icon="send" loading={sending} disabled={!reply.trim()}>Send reply</LCButton></div>
              </form>

              <section className="spx-sec" aria-label="Documents">
                <span className="spx-eyebrow">Shared with the seller</span>
                {t.documents.shares.length ? (
                  <ul className="spx-docs">
                    {t.documents.shares.map((s) => (
                      <li key={s.id} className={cx(s.revoked_at && 'is-revoked')}>
                        <span><b>{s.label}</b><em>{humanCode(s.document_kind)} · {s.revoked_at ? `revoked ${formatRelativeTime(s.revoked_at)}${s.revoked_by ? ` by ${s.revoked_by}` : ''}` : `${humanCode(s.seller_status)} · shared ${formatRelativeTime(s.shared_at)}${s.shared_by ? ` by ${s.shared_by}` : ''}`}</em></span>
                        {!s.revoked_at ? <LCButton variant="quiet" size="sm" onClick={() => setRevoking(s)}>Revoke</LCButton> : null}
                      </li>
                    ))}
                  </ul>
                ) : <p className="spx-muted">Nothing is shared yet. Documents you share appear in the seller's portal.</p>}

                <span className="spx-eyebrow">Can be shared</span>
                {t.documents.shareable.length ? (
                  <ul className="spx-docs">
                    {t.documents.shareable.map((d) => (
                      <li key={d.id}>
                        <span><b>{d.filename}</b><em>{[humanCode(d.doc_type), d.size_bytes ? `${Math.max(1, Math.round(d.size_bytes / 1024)).toLocaleString('en-US')} KB` : null, d.received_at ? `received ${formatRelativeTime(d.received_at)}` : null].filter(Boolean).join(' · ')}</em></span>
                        {sharing?.id === d.id ? null : <LCButton variant="secondary" size="sm" icon="send" onClick={() => setSharing(d)}>{sharedIds.has(d.id) ? 'Share again' : 'Share'}</LCButton>}
                        {sharing?.id === d.id ? <ShareForm doc={d} opportunityId={id} onCancel={() => setSharing(null)} onDone={() => { setSharing(null); reload() }} /> : null}
                      </li>
                    ))}
                  </ul>
                ) : <p className="spx-muted">Attachments received on this deal (emails, uploads) appear here and can be shared with the seller.</p>}
              </section>

              <section className="spx-sec" aria-label="Calls">
                <span className="spx-eyebrow">Calls</span>
                {t.calls.length ? (
                  <ul className="spx-docs">
                    {t.calls.map((c) => (
                      <li key={c.id}>
                        <span><b>{formatExactTime(c.start_at)}</b><em>{[c.reason, c.sync_status && c.sync_status !== 'synced' ? humanCode(c.sync_status) : null].filter(Boolean).join(' · ') || 'No reason given'}</em></span>
                        <LCStatus label={humanCode(c.status)} tone={c.status === 'completed' || c.status === 'confirmed' ? 'ok' : c.status === 'cancelled' || c.status === 'no_show' ? 'neutral' : 'exec'} quiet />
                      </li>
                    ))}
                  </ul>
                ) : <p className="spx-muted">Calls the seller books from the portal appear here.</p>}
              </section>
            </div>
          )}
      <LCConfirm open={Boolean(revoking)} onOpenChange={(o) => { if (!o) setRevoking(null) }} tone="danger"
        title={`Revoke “${revoking?.label ?? ''}”?`} confirmLabel="Revoke" cancelLabel="Keep it shared"
        effects={[
          { text: 'The seller can no longer open it from their portal', kind: 'stops' },
          { text: 'The document itself stays on the deal', kind: 'keeps' },
          { text: 'You can share it again later', kind: 'note' },
        ]}
        onConfirm={async () => {
          if (!revoking) return
          try { await postPortalAction(id, { action: 'revoke', share_id: revoking.id }) } catch (e) { throw new Error(humanCode(e instanceof Error ? e.message : 'revoke_failed')) }
          reload()
        }} />
    </section>
  )
}

function ShareForm({ doc, opportunityId, onCancel, onDone }: { doc: PortalShareable; opportunityId: string; onCancel: () => void; onDone: () => void }) {
  const [label, setLabel] = useState(doc.filename.replace(/\.[a-z0-9]+$/i, ''))
  const [kind, setKind] = useState<ShareKind>('other')
  const [status, setStatus] = useState<'ready' | 'needs_signature'>('ready')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!label.trim()) return
    setSaving(true)
    setError(null)
    try { await postPortalAction(opportunityId, { action: 'share', attachment_id: doc.id, label: label.trim(), kind, status }); onDone() } catch (err) { setError(humanCode(err instanceof Error ? err.message : 'share_failed')) } finally { setSaving(false) }
  }
  return (
    <form className="spx-share" onSubmit={(e) => void submit(e)} aria-label={`Share ${doc.filename}`}>
      <label className="spx-field"><span>Label the seller sees</span><input className="spx-input" value={label} onChange={(e) => setLabel(e.target.value)} required /></label>
      <div className="spx-grid2">
        <label className="spx-field">
          <span>Kind</span>
          <select className="spx-input" value={kind} onChange={(e) => setKind(e.target.value as ShareKind)}>
            {SHARE_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
        </label>
        <label className="spx-field">
          <span>For the seller</span>
          <select className="spx-input" value={status} onChange={(e) => setStatus(e.target.value as 'ready' | 'needs_signature')}>
            <option value="ready">Ready to view</option>
            <option value="needs_signature">Needs their signature</option>
          </select>
        </label>
      </div>
      {error ? <p className="spx-error" role="alert"><Icon name="alert" size={11} /> {error}</p> : null}
      <div className="spx-actions">
        <LCButton type="button" variant="quiet" size="sm" onClick={onCancel} disabled={saving}>Cancel</LCButton>
        <LCButton type="submit" variant="primary" size="sm" loading={saving} disabled={!label.trim()}>Share with seller</LCButton>
      </div>
    </form>
  )
}
