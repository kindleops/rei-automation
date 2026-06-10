import { useState, useEffect, useCallback, type ReactNode } from 'react'
import { Icon } from '../../shared/icons'
import type { ViewWidthPercent } from '../../domain/inbox/view-layout'
import {
  getEmailOverview,
  getEmailRecords,
  getEmailThreads,
  getEmailThread,
  getBrevoHealth,
  getEmailTemplates,
  getEmailCampaigns,
  getSuppressionList,
  saveEmailDraft,
  sendEmail,
} from './emailAdapter'
import type { SendEmailResult } from './emailAdapter'
import type {
  EmailTab,
  EmailOverview,
  EmailRecord,
  EmailThread,
  EmailThreadDetail,
  BrevoHealth,
  EmailTemplate,
  EmailCampaignDraft,
  SuppressionEntry,
  InboxFolder,
} from './email.types'
import './email.css'

// ── Helpers ───────────────────────────────────────────────────────────────────

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

const fmtRelative = (iso: string | null | undefined): string => {
  if (!iso) return '—'
  const ago = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(ago / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`
  return `${Math.floor(mins / 1440)}d ago`
}

const fmtDate = (iso: string | null | undefined): string => {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

const scoreClass = (n: number) => (n >= 80 ? 'is-high' : n >= 55 ? 'is-medium' : 'is-low')

const templateCategoryLabel: Record<string, string> = {
  first_touch: 'First Touch',
  follow_up: 'Follow-Up',
  offer: 'Offer',
  appointment: 'Appointment',
  wrong_contact: 'Wrong Contact',
  long_form_inquiry: 'Long-Form Inquiry',
}

// ── KPI Card ──────────────────────────────────────────────────────────────────

const KpiCard = ({
  label,
  value,
  sub,
  variant,
}: {
  label: string
  value: string | number
  sub?: string
  variant?: 'accent' | 'success' | 'danger' | 'warning'
}) => (
  <div className="ecc__kpi-card">
    <div className="ecc__kpi-label">{label}</div>
    <div className={cls('ecc__kpi-value', variant && `is-${variant}`)}>{value}</div>
    {sub && <div className="ecc__kpi-sub">{sub}</div>}
  </div>
)

// ── Overview Tab ──────────────────────────────────────────────────────────────

const OverviewTab = ({ overview }: { overview: EmailOverview | null }) => {
  if (!overview) return <div className="ecc__loading">Loading overview…</div>
  return (
    <div className="ecc__overview">
      <div className="ecc__kpi-grid">
        <KpiCard label="Total Emails" value={overview.total_emails.toLocaleString()} sub="in database" />
        <KpiCard label="Email Eligible" value={overview.email_eligible.toLocaleString()} variant="accent" sub="cleared for outreach" />
        <KpiCard label="High Confidence" value={overview.high_confidence.toLocaleString()} variant="success" sub="score ≥ 80" />
        <KpiCard label="Suppressed" value={overview.suppressed} variant="danger" sub="bounced + unsub + complaints" />
        <KpiCard label="Bounced" value={overview.bounced} variant="danger" />
        <KpiCard label="Unsubscribed" value={overview.unsubscribed} variant="warning" />
        <KpiCard label="Sent Today" value={overview.sent_today} sub="manual sends" />
        <KpiCard label="Replies Today" value={overview.replies_today} variant="success" />
        <KpiCard label="Ready for Campaign" value={overview.ready_for_campaign.toLocaleString()} variant="accent" sub="eligible + unsuppressed" />
        <KpiCard
          label="Brevo Status"
          value={overview.brevo_status === 'connected' ? 'Connected' : overview.brevo_status === 'degraded' ? 'Degraded' : 'Offline'}
          variant={overview.brevo_status === 'connected' ? 'success' : overview.brevo_status === 'degraded' ? 'warning' : 'danger'}
          sub={`updated ${fmtRelative(overview.last_updated)}`}
        />
      </div>
    </div>
  )
}

// ── Records Tab ───────────────────────────────────────────────────────────────

const RecordsTab = () => {
  const [records, setRecords] = useState<EmailRecord[]>([])
  const [search, setSearch] = useState('')
  const [eligFilter, setEligFilter] = useState<string>('all')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    getEmailRecords({ search, eligibility: eligFilter as any })
      .then(setRecords)
      .finally(() => setLoading(false))
  }, [search, eligFilter])

  return (
    <div className="ecc__records">
      <div className="ecc__section-header">
        <span className="ecc__section-title">{records.length} records</span>
        <div className="ecc__filter-row">
          <div className="ecc__search">
            <Icon name="search" size={12} />
            <input
              placeholder="Search name or email…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select
            className="ecc__select"
            value={eligFilter}
            onChange={(e) => setEligFilter(e.target.value)}
          >
            <option value="all">All eligibility</option>
            <option value="eligible">Eligible</option>
            <option value="ineligible">Ineligible</option>
            <option value="unknown">Unknown</option>
          </select>
        </div>
      </div>
      <div className="ecc__table-wrap">
        {loading ? (
          <div className="ecc__loading">Loading records…</div>
        ) : (
          <table className="ecc__table">
            <thead>
              <tr>
                <th>Prospect / Owner</th>
                <th>Email Address</th>
                <th>Rank</th>
                <th>Score</th>
                <th>Confidence</th>
                <th>Verified</th>
                <th>Brevo Status</th>
                <th>Suppression</th>
                <th>Property</th>
                <th>Market</th>
                <th>Language</th>
                <th>Last Sent</th>
                <th>Last Reply</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.id}>
                  <td>
                    <div className="ecc__name-cell">
                      <span className="ecc__prospect-name">{r.prospect_name}</span>
                      {r.owner_name && <span className="ecc__owner-name">{r.owner_name}</span>}
                    </div>
                  </td>
                  <td className="ecc__email-cell">{r.email_address}</td>
                  <td style={{ textAlign: 'center', color: 'var(--text-2)', fontSize: 12 }}>#{r.email_rank}</td>
                  <td>
                    <span className={cls('ecc__score-chip', scoreClass(r.email_score))}>{r.email_score}</span>
                  </td>
                  <td>
                    <span className={cls('ecc__badge', `is-${r.match_confidence}`)}>
                      {r.match_confidence}
                    </span>
                  </td>
                  <td>
                    <span className={cls('ecc__badge', `is-${r.verified_status}`)}>
                      {r.verified_status}
                    </span>
                  </td>
                  <td>
                    <span className={cls('ecc__badge', `is-${r.brevo_contact_status}`)}>
                      {r.brevo_contact_status}
                    </span>
                  </td>
                  <td>
                    <span className={cls('ecc__badge', `is-${r.suppression_status}`)}>
                      {r.suppression_status === 'none' ? 'Clear' : r.suppression_status}
                    </span>
                  </td>
                  <td style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {r.property_address ? (
                      <span style={{ fontSize: 11 }}>{r.property_address}</span>
                    ) : <span style={{ color: 'var(--text-2)' }}>—</span>}
                  </td>
                  <td>{r.market ?? '—'}</td>
                  <td style={{ textTransform: 'uppercase', fontSize: 10, color: 'var(--text-2)' }}>{r.language}</td>
                  <td>{fmtDate(r.last_email_sent)}</td>
                  <td>{fmtDate(r.last_reply)}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button className="ecc__btn" style={{ padding: '3px 8px', fontSize: 10 }}>Open</button>
                      <button className="ecc__btn is-primary" style={{ padding: '3px 8px', fontSize: 10 }}>Compose</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ── Inbox Tab ─────────────────────────────────────────────────────────────────

const FOLDERS: { id: InboxFolder; label: string }[] = [
  { id: 'new_replies', label: 'New Replies' },
  { id: 'needs_review', label: 'Needs Review' },
  { id: 'interested', label: 'Interested' },
  { id: 'follow_up', label: 'Follow Up' },
  { id: 'bounced', label: 'Bounced' },
  { id: 'suppressed', label: 'Suppressed' },
  { id: 'unsubscribed', label: 'Unsubscribed' },
  { id: 'all', label: 'All' },
]

const InboxTab = ({ paneWidth = '100' }: { paneWidth?: string }) => {
  const [folder, setFolder] = useState<InboxFolder>('all')
  const [threads, setThreads] = useState<EmailThread[]>([])
  const [activeThread, setActiveThread] = useState<EmailThreadDetail | null>(null)
  const [replyText, setReplyText] = useState('')
  const [loadingThread, setLoadingThread] = useState(false)

  useEffect(() => {
    getEmailThreads({ folder }).then(setThreads)
  }, [folder])

  const selectThread = useCallback(async (thread: EmailThread) => {
    setLoadingThread(true)
    try {
      const detail = await getEmailThread(thread.id)
      setActiveThread(detail)
    } finally {
      setLoadingThread(false)
    }
  }, [])

  const folderCounts = FOLDERS.reduce<Record<InboxFolder, number>>((acc, f) => {
    acc[f.id] = f.id === 'all' ? threads.length : threads.filter((t) => t.folder === f.id).length
    return acc
  }, {} as any)

  return (
    <div className={cls('ecc__inbox', activeThread && 'is-thread-open')}>
      <div className="ecc__inbox-sidebar">
        <div className="ecc__folder-tabs">
          {FOLDERS.map((f) => (
            <button
              key={f.id}
              className={cls('ecc__folder-btn', folder === f.id && 'is-active')}
              onClick={() => setFolder(f.id)}
            >
              {f.label}
              {folderCounts[f.id] > 0 && (
                <span className="ecc__folder-count">{folderCounts[f.id]}</span>
              )}
            </button>
          ))}
        </div>
        <div className="ecc__thread-list">
          {threads.length === 0 && (
            <div style={{ padding: '20px 14px', fontSize: 12, color: 'var(--text-2)' }}>
              No threads in this folder.
            </div>
          )}
          {threads.map((t) => (
            <div
              key={t.id}
              className={cls(
                'ecc__thread-item',
                t.unread && 'is-unread',
                activeThread?.id === t.id && 'is-active'
              )}
              onClick={() => selectThread(t)}
            >
              <div className="ecc__thread-meta">
                <span className="ecc__thread-from">{t.prospect_name}</span>
                <span className="ecc__thread-time">{fmtRelative(t.last_message_at)}</span>
              </div>
              <div className="ecc__thread-subject">{t.subject}</div>
              <div className="ecc__thread-preview">{t.last_message_preview}</div>
              <div className="ecc__thread-tags">
                {t.market && <span className="ecc__thread-tag">{t.market}</span>}
                {t.has_sms_thread && <span className="ecc__thread-tag">SMS</span>}
                {t.sentiment === 'positive' && <span className="ecc__thread-tag" style={{ background: 'var(--success-soft)', color: 'var(--success)' }}>Interested</span>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {loadingThread ? (
        <div className="ecc__thread-panel">
          <div className="ecc__loading">Loading thread…</div>
        </div>
      ) : activeThread ? (
        <div className="ecc__thread-panel">
          <div className="ecc__thread-panel-header">
            {['25', '50'].includes(paneWidth) && (
              <button
                className="ecc__btn ecc__back-btn"
                onClick={() => setActiveThread(null)}
                style={{
                  marginBottom: 8,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  color: 'var(--text-1)',
                  padding: '4px 8px',
                  borderRadius: 4,
                  cursor: 'pointer',
                  fontSize: 10,
                  fontWeight: 600,
                }}
              >
                <Icon name="chevron-left" size={11} />
                <span>Back</span>
              </button>
            )}
            <div className="ecc__thread-subject-line">{activeThread.subject}</div>
            <div className="ecc__thread-participants">
              {activeThread.email_address} · {activeThread.message_count} messages
              {activeThread.has_sms_thread && (
                <span style={{ marginLeft: 8, color: 'var(--accent)', fontSize: 10, fontWeight: 700 }}>
                  SMS linked
                </span>
              )}
            </div>
          </div>

          <div className="ecc__thread-body">
            {activeThread.ai_summary && (
              <div className="ecc__ai-summary">
                <div className="ecc__ai-summary-label">AI Summary</div>
                {activeThread.ai_summary}
              </div>
            )}

            {activeThread.messages.map((msg) => (
              <div key={msg.id} className={cls('ecc__message-bubble', `is-${msg.direction}`)}>
                <div className="ecc__message-body">
                  {msg.body_html ? (
                    <span dangerouslySetInnerHTML={{ __html: msg.body_html }} />
                  ) : msg.body_preview}
                </div>
                <div className="ecc__message-ts">
                  {msg.direction === 'outbound' ? 'You' : msg.from_address} · {fmtRelative(msg.sent_at)}
                  {msg.opened && <span style={{ marginLeft: 6, color: 'var(--success)', fontSize: 10 }}>Opened</span>}
                  {msg.bounced && <span style={{ marginLeft: 6, color: 'var(--danger)', fontSize: 10 }}>Bounced</span>}
                </div>
              </div>
            ))}
          </div>

          {activeThread.property_context && (
            <div className="ecc__context-strip">
              <span className="ecc__context-item">
                <span className="ecc__context-key">Property:</span>
                <span className="ecc__context-val">{activeThread.property_context.address}</span>
              </span>
              <span className="ecc__context-item">
                <span className="ecc__context-key">Est. Value:</span>
                <span className="ecc__context-val">{activeThread.property_context.estimated_value}</span>
              </span>
              <span className="ecc__context-item">
                <span className="ecc__context-key">Market:</span>
                <span className="ecc__context-val">{activeThread.property_context.market}</span>
              </span>
              {activeThread.prospect_context && (
                <span className="ecc__context-item">
                  <span className="ecc__context-key">Lang:</span>
                  <span className="ecc__context-val" style={{ textTransform: 'uppercase' }}>{activeThread.prospect_context.language}</span>
                </span>
              )}
            </div>
          )}

          <div className="ecc__reply-composer">
            <textarea
              placeholder="Type a reply… (manual send backend not yet connected)"
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
            />
            <div className="ecc__reply-actions">
              <span style={{ fontSize: 11, color: 'var(--text-2)' }}>
                Reply via Brevo — backend required
              </span>
              <button className="ecc__btn is-primary" disabled>
                <Icon name="send" size={12} />
                Send Reply
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="ecc__thread-panel">
          <div className="ecc__empty-panel">
            <div className="ecc__empty-icon">
              <Icon name="mail" size={20} />
            </div>
            <div className="ecc__empty-label">Select a thread to view</div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Composer Tab ──────────────────────────────────────────────────────────────

const ComposerTab = ({ templates, health }: { templates: EmailTemplate[]; health: BrevoHealth | null }) => {
  const [to, setTo] = useState('')
  const [fromIdentity, setFromIdentity] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [selectedTemplate, setSelectedTemplate] = useState<string>('')
  const [statusMsg, setStatusMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [saving, setSaving] = useState(false)
  const [sending, setSending] = useState(false)
  const [lastSendResult, setLastSendResult] = useState<SendEmailResult | null>(null)

  const senderOptions = health?.sender_identities?.filter((s) => s.active) ?? []
  const noSendMode = !health?.connected || health?.api_key_valid === false
  const dryRunMode = lastSendResult?.dry_run || lastSendResult?.no_send

  useEffect(() => {
    if (senderOptions.length > 0 && !fromIdentity) {
      setFromIdentity(senderOptions[0].email)
    }
  }, [health])

  const handleTemplateChange = (templateId: string) => {
    setSelectedTemplate(templateId)
    const tpl = templates.find((t) => t.id === templateId)
    if (tpl) {
      setSubject(tpl.subject)
      setBody(tpl.body)
    }
  }

  const handleSaveDraft = async () => {
    setSaving(true)
    setStatusMsg(null)
    try {
      const result = await saveEmailDraft({
        to,
        from_identity: fromIdentity,
        subject,
        body,
        template_id: selectedTemplate || null,
        prospect_id: null,
        property_id: null,
        is_draft: true,
      })
      setStatusMsg({ ok: result.ok, text: result.ok ? `Draft saved${result.draft_id ? ` (${result.draft_id})` : ''}` : result.message ?? 'Error saving draft' })
    } finally {
      setSaving(false)
    }
  }

  const handleSend = async () => {
    if (!to || !subject || !body) {
      setStatusMsg({ ok: false, text: 'To, Subject, and Body are required.' })
      return
    }
    setSending(true)
    setStatusMsg(null)
    setLastSendResult(null)
    try {
      const result = await sendEmail({
        to,
        from_identity: fromIdentity,
        subject,
        body,
        template_id: selectedTemplate || null,
        prospect_id: null,
        property_id: null,
        is_draft: false,
      })
      setLastSendResult(result)
      if (result.dry_run || result.no_send) {
        setStatusMsg({ ok: false, text: 'No-send mode — Brevo live sending disabled.' })
      } else if (result.blocked) {
        setStatusMsg({ ok: false, text: `Blocked: ${result.error ?? 'suppression or eligibility check failed'}` })
      } else if (result.sent) {
        setStatusMsg({ ok: true, text: `Sent${result.message_id ? ` · ID ${result.message_id}` : ''}` })
      } else {
        setStatusMsg({ ok: false, text: result.message ?? result.error ?? 'Send failed' })
      }
    } finally {
      setSending(false)
    }
  }

  const activeTpl = templates.find((t) => t.id === selectedTemplate)
  const canSend = Boolean(to && subject && body && !saving && !sending)

  return (
    <div className="ecc__composer">
      <div className="ecc__compose-form">
        <div className="ecc__field">
          <label className="ecc__field-label">Template</label>
          <select value={selectedTemplate} onChange={(e) => handleTemplateChange(e.target.value)}>
            <option value="">— No template —</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </div>

        <div className="ecc__field">
          <label className="ecc__field-label">To</label>
          <input
            type="email"
            placeholder="recipient@example.com"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>

        <div className="ecc__field">
          <label className="ecc__field-label">From / Sender Identity</label>
          {senderOptions.length > 0 ? (
            <select value={fromIdentity} onChange={(e) => setFromIdentity(e.target.value)}>
              {senderOptions.map((s) => (
                <option key={s.email} value={s.email}>{s.name} &lt;{s.email}&gt;</option>
              ))}
            </select>
          ) : (
            <input
              type="email"
              placeholder="sender@example.com"
              value={fromIdentity}
              onChange={(e) => setFromIdentity(e.target.value)}
            />
          )}
        </div>

        <div className="ecc__field">
          <label className="ecc__field-label">Subject</label>
          <input
            type="text"
            placeholder="Email subject…"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
        </div>

        <div className="ecc__field">
          <label className="ecc__field-label">Body</label>
          <textarea
            placeholder="Email body…"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          {activeTpl && activeTpl.merge_fields.length > 0 && (
            <>
              <div className="ecc__field-label" style={{ marginTop: 6 }}>Merge Fields — click to insert</div>
              <div className="ecc__merge-chips">
                {activeTpl.merge_fields.map((field) => (
                  <button
                    key={field}
                    className="ecc__merge-chip"
                    onClick={() => setBody((b) => b + ` {{${field}}}`)}
                  >
                    {`{{${field}}}`}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {(noSendMode || dryRunMode) && (
          <div className="ecc__disabled-banner">
            <strong>No-send mode — Brevo live sending disabled.</strong>
            {' '}EMAIL_SEND_ENABLED is false or Brevo is not configured. Sends will be recorded as dry-run only.
          </div>
        )}

        {statusMsg && (
          <div style={{
            padding: '8px 12px', borderRadius: 6, fontSize: 12,
            background: statusMsg.ok ? 'var(--success-soft)' : 'var(--danger-soft)',
            border: `1px solid ${statusMsg.ok ? 'rgba(62,207,142,0.20)' : 'rgba(248,113,113,0.20)'}`,
            color: statusMsg.ok ? 'var(--success)' : 'var(--danger)',
          }}>
            {statusMsg.text}
          </div>
        )}

        <div className="ecc__compose-actions">
          <button className="ecc__btn" onClick={handleSaveDraft} disabled={saving || sending}>
            <Icon name="archive" size={12} />
            {saving ? 'Saving…' : 'Save Draft'}
          </button>
          <button className="ecc__btn is-primary" onClick={handleSend} disabled={!canSend}>
            <Icon name="send" size={12} />
            {sending ? 'Sending…' : 'Send Email'}
          </button>
        </div>
      </div>

      <div className="ecc__compose-context">
        <div className="ecc__context-card">
          <div className="ecc__context-card-title">Prospect Context</div>
          <div className="ecc__context-row">
            <span className="ecc__context-key">Name</span>
            <span className="ecc__context-val">—</span>
          </div>
          <div className="ecc__context-row">
            <span className="ecc__context-key">Market</span>
            <span className="ecc__context-val">—</span>
          </div>
          <div className="ecc__context-row">
            <span className="ecc__context-key">Language</span>
            <span className="ecc__context-val">—</span>
          </div>
          <div className="ecc__context-row">
            <span className="ecc__context-key">Score</span>
            <span className="ecc__context-val">—</span>
          </div>
        </div>

        <div className="ecc__context-card">
          <div className="ecc__context-card-title">Property Context</div>
          <div className="ecc__context-row">
            <span className="ecc__context-key">Address</span>
            <span className="ecc__context-val">—</span>
          </div>
          <div className="ecc__context-row">
            <span className="ecc__context-key">Est. Value</span>
            <span className="ecc__context-val">—</span>
          </div>
          <div className="ecc__context-row">
            <span className="ecc__context-key">Market</span>
            <span className="ecc__context-val">—</span>
          </div>
        </div>

        {activeTpl && (
          <div className="ecc__context-card">
            <div className="ecc__context-card-title">Template Info</div>
            <div className="ecc__context-row">
              <span className="ecc__context-key">Category</span>
              <span className="ecc__context-val">{templateCategoryLabel[activeTpl.category]}</span>
            </div>
            <div className="ecc__context-row">
              <span className="ecc__context-key">Used</span>
              <span className="ecc__context-val">{activeTpl.usage_count}×</span>
            </div>
            <div className="ecc__context-row">
              <span className="ecc__context-key">Last Used</span>
              <span className="ecc__context-val">{fmtDate(activeTpl.last_used)}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Campaigns Tab ─────────────────────────────────────────────────────────────

const CampaignsTab = ({ campaigns }: { campaigns: EmailCampaignDraft[] }) => (
  <div className="ecc__campaigns">
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
      <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
        Email campaigns are draft-only. Launch requires backend connection.
      </div>
      <button className="ecc__btn is-primary">
        <Icon name="send" size={12} />
        New Draft
      </button>
    </div>

    {campaigns.map((c) => (
      <div key={c.id} className="ecc__campaign-card">
        <div className="ecc__campaign-header">
          <div>
            <div className="ecc__campaign-name">{c.name}</div>
            <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 2 }}>
              {c.template_name ?? 'No template'} · {c.sequence_steps} step{c.sequence_steps !== 1 ? 's' : ''}
              · Created {fmtRelative(c.created_at)}
            </div>
          </div>
          <span className={cls('ecc__badge', 'is-unknown')} style={{ alignSelf: 'flex-start' }}>
            {c.status}
          </span>
        </div>

        <div className="ecc__campaign-meta">
          <div className="ecc__campaign-metric">
            <span className="ecc__campaign-metric-val">{c.target_count.toLocaleString()}</span>
            <span className="ecc__campaign-metric-label">Targets</span>
          </div>
          <div className="ecc__campaign-metric">
            <span className="ecc__campaign-metric-val" style={{ color: 'var(--success)' }}>{c.eligible_count.toLocaleString()}</span>
            <span className="ecc__campaign-metric-label">Eligible</span>
          </div>
          <div className="ecc__campaign-metric">
            <span className="ecc__campaign-metric-val" style={{ color: 'var(--text-2)' }}>{c.scheduled_at ? fmtDate(c.scheduled_at) : '—'}</span>
            <span className="ecc__campaign-metric-label">Scheduled</span>
          </div>
        </div>

        <div className="ecc__campaign-actions">
          <button className="ecc__btn">
            <Icon name="eye" size={12} />
            Dry Run
          </button>
          <button className="ecc__btn">
            <Icon name="filter" size={12} />
            Filter Contacts
          </button>
          <button className="ecc__launch-locked" disabled>
            <Icon name="shield" size={12} />
            Launch (backend required)
          </button>
        </div>
      </div>
    ))}
  </div>
)

// ── Templates Tab ─────────────────────────────────────────────────────────────

const TemplatesTab = ({ templates }: { templates: EmailTemplate[] }) => {
  const [activeId, setActiveId] = useState<string>(templates[0]?.id ?? '')
  const activeTpl = templates.find((t) => t.id === activeId)

  const renderBody = (body: string) =>
    body.replace(/\{\{(\w+)\}\}/g, (_, field) =>
      `<span class="highlight">{{${field}}}</span>`
    )

  return (
    <div className="ecc__templates">
      <div className="ecc__tpl-list">
        {templates.map((t) => (
          <div
            key={t.id}
            className={cls('ecc__tpl-item', t.id === activeId && 'is-active')}
            onClick={() => setActiveId(t.id)}
          >
            <div className="ecc__tpl-name">{t.name}</div>
            <div className="ecc__tpl-category">{templateCategoryLabel[t.category]}</div>
            <div className="ecc__tpl-usage">Used {t.usage_count}× · last {fmtDate(t.last_used)}</div>
          </div>
        ))}
      </div>
      <div className="ecc__tpl-preview">
        {activeTpl ? (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
              <div>
                <div className="ecc__tpl-preview-subject">{activeTpl.subject}</div>
                <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: -8, marginBottom: 12 }}>
                  {templateCategoryLabel[activeTpl.category]} · {activeTpl.merge_fields.length} merge fields
                </div>
              </div>
              <button className="ecc__btn is-primary">
                <Icon name="send" size={12} />
                Use in Composer
              </button>
            </div>
            <div
              className="ecc__tpl-preview-body"
              dangerouslySetInnerHTML={{ __html: renderBody(activeTpl.body) }}
            />
            {activeTpl.merge_fields.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div className="ecc__field-label" style={{ marginBottom: 6 }}>Merge Fields</div>
                <div className="ecc__merge-chips">
                  {activeTpl.merge_fields.map((f) => (
                    <span key={f} className="ecc__merge-chip" style={{ cursor: 'default' }}>{`{{${f}}}`}</span>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <div style={{ color: 'var(--text-2)', fontSize: 12 }}>Select a template</div>
        )}
      </div>
    </div>
  )
}

// ── Suppression Tab ───────────────────────────────────────────────────────────

const SuppressionTab = ({ entries }: { entries: SuppressionEntry[] }) => {
  const bounced = entries.filter((e) => e.reason === 'bounced').length
  const unsubbed = entries.filter((e) => e.reason === 'unsubscribed').length
  const complaints = entries.filter((e) => e.reason === 'complaint').length
  const manual = entries.filter((e) => e.reason === 'manual').length

  return (
    <div className="ecc__suppression">
      <div className="ecc__suppression-stats">
        <div className="ecc__sup-stat">
          <div>
            <div className="ecc__sup-stat-value" style={{ color: 'var(--danger)' }}>{bounced}</div>
            <div className="ecc__sup-stat-label">Bounced</div>
          </div>
        </div>
        <div className="ecc__sup-stat">
          <div>
            <div className="ecc__sup-stat-value" style={{ color: 'var(--warning)' }}>{unsubbed}</div>
            <div className="ecc__sup-stat-label">Unsubscribed</div>
          </div>
        </div>
        <div className="ecc__sup-stat">
          <div>
            <div className="ecc__sup-stat-value" style={{ color: 'var(--danger)' }}>{complaints}</div>
            <div className="ecc__sup-stat-label">Complaints</div>
          </div>
        </div>
        <div className="ecc__sup-stat">
          <div>
            <div className="ecc__sup-stat-value">{manual}</div>
            <div className="ecc__sup-stat-label">Manual</div>
          </div>
        </div>
        <div className="ecc__sup-stat">
          <div>
            <div className="ecc__sup-stat-value" style={{ color: 'var(--danger)' }}>{entries.length}</div>
            <div className="ecc__sup-stat-label">Total Suppressed</div>
          </div>
        </div>
      </div>

      <div className="ecc__table-wrap">
        <table className="ecc__table">
          <thead>
            <tr>
              <th>Email Address</th>
              <th>Prospect</th>
              <th>Reason</th>
              <th>Source</th>
              <th>Suppressed At</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="ecc__email-cell">{e.email_address}</td>
                <td style={{ color: 'var(--text-0)', fontWeight: 500 }}>{e.prospect_name}</td>
                <td>
                  <span className={cls('ecc__badge', `is-${e.reason}`)}>{e.reason}</span>
                </td>
                <td style={{ fontSize: 11, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{e.source}</td>
                <td>{fmtDate(e.suppressed_at)}</td>
                <td>
                  {e.can_remove ? (
                    <button className="ecc__btn is-danger-outline" style={{ padding: '3px 8px', fontSize: 10 }}>
                      Remove
                    </button>
                  ) : (
                    <span style={{ fontSize: 10, color: 'var(--text-2)' }}>Brevo-managed</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ padding: '12px 20px', borderTop: '1px solid var(--border)', display: 'flex', gap: 8, flexShrink: 0 }}>
        <button className="ecc__btn">
          <Icon name="filter" size={12} />
          Add Manual Suppress
        </button>
        <span style={{ fontSize: 11, color: 'var(--text-2)', alignSelf: 'center' }}>
          Brevo-managed suppressions cannot be removed from this UI.
        </span>
      </div>
    </div>
  )
}

// ── Brevo Health Tab ──────────────────────────────────────────────────────────

const BrevoHealthTab = ({ health }: { health: BrevoHealth | null }) => {
  if (!health) return <div className="ecc__loading">Loading health data…</div>
  return (
    <div className="ecc__health">
      <div className="ecc__health-section">
        <div className="ecc__health-section-title">Provider Status</div>
        <div className="ecc__health-row">
          <span className="ecc__health-row-label">API Connected</span>
          <span className={cls('ecc__health-row-value', health.connected ? 'is-ok' : 'is-error')}>
            {health.connected ? 'Yes' : 'No'}
          </span>
        </div>
        <div className="ecc__health-row">
          <span className="ecc__health-row-label">API Key Valid</span>
          <span className={cls('ecc__health-row-value', health.api_key_valid ? 'is-ok' : 'is-error')}>
            {health.api_key_valid ? 'Valid' : 'Invalid'}
          </span>
        </div>
        <div className="ecc__health-row">
          <span className="ecc__health-row-label">API Latency</span>
          <span className={cls('ecc__health-row-value',
            health.api_latency_ms === null ? 'is-muted' :
            health.api_latency_ms < 200 ? 'is-ok' :
            health.api_latency_ms < 500 ? 'is-warn' : 'is-error'
          )}>
            {health.api_latency_ms !== null ? `${health.api_latency_ms}ms` : '—'}
          </span>
        </div>
        <div className="ecc__health-row">
          <span className="ecc__health-row-label">Live Sending Enabled</span>
          <span className={cls('ecc__health-row-value', health.send_enabled ? 'is-ok' : 'is-warn')}>
            {health.send_enabled ? 'Enabled' : 'Disabled (dry-run)'}
          </span>
        </div>
        <div className="ecc__health-row">
          <span className="ecc__health-row-label">Webhook Configured</span>
          <span className={cls('ecc__health-row-value', health.webhook_configured ? 'is-ok' : 'is-warn')}>
            {health.webhook_configured ? 'Yes' : 'No'}
          </span>
        </div>
        {health.missing && health.missing.length > 0 && (
          <div className="ecc__health-row">
            <span className="ecc__health-row-label">Missing Config</span>
            <span className="ecc__health-row-value is-error">{health.missing.join(', ')}</span>
          </div>
        )}
        <div className="ecc__health-row">
          <span className="ecc__health-row-label">Last Checked</span>
          <span className="ecc__health-row-value is-muted">{fmtRelative(health.last_checked)}</span>
        </div>
      </div>

      <div className="ecc__health-section">
        <div className="ecc__health-section-title">Domain Authentication</div>
        <div className="ecc__health-row">
          <span className="ecc__health-row-label">DKIM / SPF Status</span>
          <span className={cls('ecc__health-row-value',
            health.domain_auth_status === 'verified' ? 'is-ok' :
            health.domain_auth_status === 'pending' ? 'is-warn' : 'is-error'
          )}>
            {health.domain_auth_status.charAt(0).toUpperCase() + health.domain_auth_status.slice(1)}
          </span>
        </div>
      </div>

      <div className="ecc__health-section">
        <div className="ecc__health-section-title">Sender Identities</div>
        <div className="ecc__sender-list">
          {health.sender_identities.map((s) => (
            <div key={s.email} className="ecc__sender-card">
              <div>
                <div className="ecc__sender-name">{s.name}</div>
                <div className="ecc__sender-email">{s.email}</div>
              </div>
              <div className="ecc__sender-badges">
                <span className={cls('ecc__badge', s.active ? 'is-active' : 'is-unknown')}>
                  {s.active ? 'Active' : 'Inactive'}
                </span>
                <span className={cls('ecc__badge', s.domain_verified ? 'is-verified' : 'is-unverified')}>
                  {s.domain_verified ? 'Verified' : 'Unverified'}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="ecc__health-section">
        <div className="ecc__health-section-title">7-Day Metrics</div>
        <div className="ecc__health-row">
          <span className="ecc__health-row-label">Bounce Rate</span>
          <span className={cls('ecc__health-row-value',
            health.bounce_rate_7d == null ? 'is-muted' :
            health.bounce_rate_7d < 2 ? 'is-ok' :
            health.bounce_rate_7d < 5 ? 'is-warn' : 'is-error'
          )}>
            {health.bounce_rate_7d != null ? `${health.bounce_rate_7d.toFixed(1)}%` : '—'}
          </span>
        </div>
        <div className="ecc__health-row">
          <span className="ecc__health-row-label">Send Failure Rate</span>
          <span className={cls('ecc__health-row-value',
            health.send_failure_rate_7d == null ? 'is-muted' :
            health.send_failure_rate_7d < 1 ? 'is-ok' :
            health.send_failure_rate_7d < 3 ? 'is-warn' : 'is-error'
          )}>
            {health.send_failure_rate_7d != null ? `${health.send_failure_rate_7d.toFixed(1)}%` : '—'}
          </span>
        </div>
      </div>
    </div>
  )
}

// ── Tab config ────────────────────────────────────────────────────────────────

const TABS: { id: EmailTab; label: string; icon: ReactNode }[] = [
  { id: 'overview',     label: 'Overview',    icon: <Icon name="stats" size={12} /> },
  { id: 'inbox',        label: 'Inbox',       icon: <Icon name="inbox" size={12} /> },
  { id: 'records',      label: 'Records',     icon: <Icon name="users" size={12} /> },
  { id: 'composer',     label: 'Composer',    icon: <Icon name="mail" size={12} /> },
  { id: 'campaigns',    label: 'Campaigns',   icon: <Icon name="send" size={12} /> },
  { id: 'templates',    label: 'Templates',   icon: <Icon name="file-text" size={12} /> },
  { id: 'suppression',  label: 'Suppression', icon: <Icon name="shield" size={12} /> },
  { id: 'brevo-health', label: 'Brevo Health',icon: <Icon name="activity" size={12} /> },
]

// ── Main Component ────────────────────────────────────────────────────────────

export const EmailCommandCenter = ({
  paneWidth = '100',
}: {
  paneWidth?: ViewWidthPercent
}) => {
  const [activeTab, setActiveTab] = useState<EmailTab>('overview')
  const [overview, setOverview] = useState<EmailOverview | null>(null)
  const [health, setHealth] = useState<BrevoHealth | null>(null)
  const [templates, setTemplates] = useState<EmailTemplate[]>([])
  const [campaigns, setCampaigns] = useState<EmailCampaignDraft[]>([])
  const [suppression, setSuppression] = useState<SuppressionEntry[]>([])

  useEffect(() => {
    getEmailOverview().then(setOverview)
    getBrevoHealth().then(setHealth)
    getEmailTemplates().then(setTemplates)
    getEmailCampaigns().then(setCampaigns)
    getSuppressionList().then(setSuppression)
  }, [])

  const brevoStatusClass = overview
    ? overview.brevo_status === 'connected' ? 'is-connected'
    : overview.brevo_status === 'degraded' ? 'is-degraded'
    : 'is-disconnected'
    : ''

  return (
    <div className={cls('ecc', `is-pane-${paneWidth}`)}>
      <header className="ecc__header">
        <div className="ecc__brand">
          <div className="ecc__brand-icon">
            <Icon name="mail" size={14} />
          </div>
          <div>
            <div className="ecc__title">Email Command Center</div>
            <div className="ecc__subtitle">Brevo · Outreach · Records · Templates</div>
          </div>
        </div>
        <div className="ecc__header-right">
          {overview && (
            <div className={cls('ecc__status-pill', brevoStatusClass)}>
              <span className="ecc__dot" />
              Brevo {overview.brevo_status}
            </div>
          )}
          {overview && (
            <div className="ecc__status-pill">
              <Icon name="users" size={11} />
              {overview.email_eligible.toLocaleString()} eligible
            </div>
          )}
        </div>
      </header>

      <nav className="ecc__tabs">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={cls('ecc__tab', activeTab === tab.id && 'is-active')}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.icon}
            {tab.label}
            {tab.id === 'inbox' && overview && overview.replies_today > 0 && (
              <span className="ecc__tab-badge">{overview.replies_today}</span>
            )}
            {tab.id === 'suppression' && overview && overview.suppressed > 0 && (
              <span className="ecc__tab-badge" style={{ background: 'var(--danger-soft)', color: 'var(--danger)' }}>
                {overview.suppressed}
              </span>
            )}
          </button>
        ))}
      </nav>

      <main className="ecc__body">
        {activeTab === 'overview'     && <OverviewTab overview={overview} />}
        {activeTab === 'inbox'        && <InboxTab paneWidth={paneWidth} />}
        {activeTab === 'records'      && <RecordsTab />}
        {activeTab === 'composer'     && <ComposerTab templates={templates} health={health} />}
        {activeTab === 'campaigns'    && <CampaignsTab campaigns={campaigns} />}
        {activeTab === 'templates'    && <TemplatesTab templates={templates} />}
        {activeTab === 'suppression'  && <SuppressionTab entries={suppression} />}
        {activeTab === 'brevo-health' && <BrevoHealthTab health={health} />}
      </main>
    </div>
  )
}
