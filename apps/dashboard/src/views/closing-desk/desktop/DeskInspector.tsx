import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../../shared/icons'
import type { ActionResult, Closing, ClosingDoc, Deadline, Item, Loop, StoredFile } from '../mobile/closing-execution-api'
import { postClosingAction } from '../mobile/closing-execution-api'
import { DOC_STATUS, docTone, EMD_WORD, money, stamp, titleCase, whenLabel } from '../mobile/closing-format'
import { zonedToIso, type ActionSpec } from '../mobile/ClosingActions'
import { links, relativeMoment, SEVERITY_WORD } from './desk-model'
import { resolveAction } from './desk-actions'
import { Fact, go, OwnerTag, SevChip } from './desk-ui'

/**
 * THE INSPECTOR — one floating glass plane over the room (L3). It explains
 * the thing the operator pointed at (a blocker, a requirement, a document, a
 * deadline, an automation loop, the money) and hosts the one authoritative
 * form when the operator records a fact. It never holds state of its own.
 */

export type Subject =
  | { kind: 'item'; item: Item }
  | { kind: 'requirement'; key: string }
  | { kind: 'document'; doc: ClosingDoc | null; file?: StoredFile | null }
  | { kind: 'deadline'; deadline: Deadline; closingDate?: boolean }
  | { kind: 'loop'; loop: Loop }
  | { kind: 'money' }
  | { kind: 'form'; spec: ActionSpec }

const LOOP_STATE: Record<string, string> = {
  scheduled: 'Scheduled', due: 'Going out now', queued: 'Queued in Email Command', superseded: 'Superseded — counterparty replied',
  exhausted: 'All follow-ups sent', escalating: 'Escalating to you', escalated: 'Escalated to you', stale: 'Window missed — escalating',
  no_recipient: 'No address on record — escalating', not_started: 'Not started', satisfied: 'Done — condition met', cancelled: 'Cancelled',
}
export const loopStateWord = (s: string) => LOOP_STATE[s] || titleCase(s)
const REASON: Record<string, string> = { counterparty_replied: 'Superseded — the counterparty replied before it went out', automation_paused: 'Withdrawn — automation paused', closing_terminated: 'Withdrawn — closing ended', closing_closed: 'Withdrawn — closing finalized', no_recipient_address: 'Skipped — no address on record' }
export const reasonWord = (r: string | null | undefined) => (r ? REASON[r] || titleCase(r) : null)

export function DeskInspector({ c, subject, demo, now, collapsed, onClose, onCollapse, onExpand, onSubject, onDone }: {
  c: Closing; subject: Subject | null; demo: boolean; now: number; collapsed: boolean
  onClose: () => void; onCollapse: () => void; onExpand: () => void; onSubject: (s: Subject) => void; onDone: () => void
}) {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => { if (subject && !collapsed) ref.current?.focus({ preventScroll: true }) }, [subject, collapsed])
  if (!subject) return null
  if (collapsed) {
    return (
      <button type="button" className="cdx-insp-tab" onClick={onExpand} aria-label={`Open inspector — ${EYEBROW[subject.kind]}`}>
        <Icon name="chevron-left" /><span>{EYEBROW[subject.kind]}</span>
      </button>
    )
  }
  return (
    <aside ref={ref} tabIndex={-1} className={`cdx-insp is-${subject.kind}`} aria-label="Inspector">
      <header className="cdx-insp__bar">
        <span className="cdx-eyebrow">{EYEBROW[subject.kind]}</span>
        <span>
          <button type="button" className="cdx-icon" aria-label="Collapse inspector (])" title="Collapse ( ] )" onClick={onCollapse}><Icon name="chevron-right" /></button>
          <button type="button" className="cdx-icon" aria-label="Close inspector" onClick={onClose}><Icon name="x" /></button>
        </span>
      </header>
      <div className="cdx-insp__body">
        {subject.kind === 'item' ? <ItemView c={c} item={subject.item} now={now} onSubject={onSubject} /> : null}
        {subject.kind === 'requirement' ? <RequirementView c={c} reqKey={subject.key} onSubject={onSubject} /> : null}
        {subject.kind === 'document' ? <DocumentView c={c} doc={subject.doc} file={subject.file ?? null} /> : null}
        {subject.kind === 'deadline' ? <DeadlineView c={c} d={subject.deadline} closingDate={Boolean(subject.closingDate)} now={now} /> : null}
        {subject.kind === 'loop' ? <LoopView c={c} loop={subject.loop} now={now} /> : null}
        {subject.kind === 'money' ? <MoneyView c={c} /> : null}
        {subject.kind === 'form' ? <ActionForm key={subject.spec.action + JSON.stringify(subject.spec.fixed ?? {})} c={c} spec={subject.spec} demo={demo} onCancel={onClose} onDone={onDone} /> : null}
      </div>
    </aside>
  )
}

const EYEBROW: Record<Subject['kind'], string> = { item: 'Open item', requirement: 'Requirement', document: 'Document', deadline: 'Deadline', loop: 'Automation', money: 'Money', form: 'Record' }

function ActionButtons({ c, action, onSubject }: { c: Closing; action: string | null; onSubject: (s: Subject) => void }) {
  const r = resolveAction(action, c)
  if (!r || r.kind === 'review') return null
  return (
    <div className="cdx-insp__acts">
      {r.kind === 'form'
        ? <button type="button" className="cdx-btn is-primary" onClick={() => onSubject({ kind: 'form', spec: r.spec })}>{r.label}</button>
        : <button type="button" className="cdx-btn is-primary" onClick={() => go(r.path, r.locate ? c : null)}>{r.label}<Icon name="arrow-up-right" /></button>}
    </div>
  )
}

function ItemView({ c, item, now, onSubject }: { c: Closing; item: Item; now: number; onSubject: (s: Subject) => void }) {
  const loop = c.automation?.loops?.find((l) => (item.requirement === 'emd' && l.key === 'buyer_emd') || (item.requirement === 'agreement' && l.key === 'buyer_agreement') || (item.requirement === 'title' && ['title_ack', 'title_commitment', 'clear_to_close'].includes(l.key) && l.state !== 'satisfied') || (item.key === 'statement_missing' && l.key === 'settlement'))
  return (
    <>
      <div className="cdx-insp__head">
        <SevChip severity={item.severity} />
        <h3>{item.what}</h3>
        {item.why ? <p>{item.why}</p> : null}
      </div>
      <dl className="cdx-facts">
        <Fact k="Who has the ball" v={<OwnerTag owner={item.owner} />} />
        <Fact k={item.severity === 'resolved' ? 'Resolved' : item.severity === 'overdue' || item.severity === 'due_soon' ? 'Due' : 'Since'} v={item.at ? relativeMoment(item.at, c.property.tz, now, item.dateOnly) : null} />
        <Fact k="Blocks" v={item.requirement ? c.requirements.find((r) => r.key === item.requirement)?.label : item.requirements?.map((k) => c.requirements.find((r) => r.key === k)?.label).filter(Boolean).join(' · ')} />
        <Fact k="Source" v={item.source ? titleCase(item.source) : null} />
        <Fact k="Severity" v={SEVERITY_WORD[item.severity]} />
      </dl>
      {loop ? (
        <button type="button" className="cdx-insp__loop" onClick={() => onSubject({ kind: 'loop', loop })}>
          <Icon name="refresh-cw" />
          <span><b>{loop.label}</b><small>{loopStateWord(loop.state)}{loop.next ? ` · #${loop.next.sequence} ${relativeMoment(loop.next.at, c.property.tz, now)}` : ''}{loop.escalateAt ? ` · escalates ${relativeMoment(loop.escalateAt, c.property.tz, now)}` : ''}</small></span>
          <Icon name="chevron-right" />
        </button>
      ) : null}
      {item.severity !== 'resolved' ? <ActionButtons c={c} action={item.action} onSubject={onSubject} /> : null}
    </>
  )
}

function RequirementView({ c, reqKey, onSubject }: { c: Closing; reqKey: string; onSubject: (s: Subject) => void }) {
  const r = c.requirements.find((x) => x.key === reqKey)
  if (!r) return null
  const b = c.emd.buyer?.receipt
  const evidence = r.key === 'emd' && b ? [b.method ? titleCase(b.method) : null, b.verifiedBy ? `by ${b.verifiedBy}` : null, b.evidence].filter(Boolean).join(' · ')
    : r.key === 'title' && c.title.ctc ? [titleCase(c.title.ctc.source), c.title.ctc.actor, c.title.ctc.evidence].filter(Boolean).join(' · ')
      : r.key === 'schedule' && c.closing?.confirmedAt ? `Confirmed ${stamp(c.closing.confirmedAt, c.property.tz)}${c.closing.source ? ` · ${titleCase(c.closing.source)}` : ''}`
        : r.key === 'contract' && c.contract.envelope ? `DocuSign envelope ${c.contract.envelope}` : null
  const action = !r.met ? ({ contract: null, buyer: 'select_buyer', agreement: 'send_buyer_agreement', emd: c.emd.buyer?.state === 'received' ? 'verify_emd' : 'chase_emd', issues: 'resolve_title_issue', title: 'email_title', schedule: 'schedule_closing' } as Record<string, string | null>)[r.key] ?? null : null
  return (
    <>
      <div className="cdx-insp__head">
        <span className={`cdx-sev ${r.met ? 'is-resolved' : 'is-pending'}`}>{r.met ? 'Met' : 'Open'}</span>
        <h3>{r.label}</h3>
        {r.detail ? <p>{r.detail}</p> : null}
      </div>
      <dl className="cdx-facts">
        <Fact k="Guard code" v={r.code} mono />
        <Fact k="Owner" v={r.met ? null : <OwnerTag owner={r.owner ?? null} />} />
        <Fact k="Evidence" v={r.met ? evidence : null} />
      </dl>
      <p className="cdx-muted">Read from the same S10 guard Pipeline's finalize uses — the desk has no rule of its own.</p>
      <ActionButtons c={c} action={action} onSubject={onSubject} />
    </>
  )
}

function DocumentView({ c, doc, file }: { c: Closing; doc: ClosingDoc | null; file: StoredFile | null }) {
  const isPdf = file?.contentType?.includes('pdf')
  const isImage = file?.contentType?.startsWith('image/')
  return (
    <>
      <div className="cdx-insp__head">
        {doc ? <span className={`cdx-doc-status is-${docTone(doc)}`}>{DOC_STATUS[doc.status] ?? titleCase(doc.status)}</span> : <span className="cdx-doc-status is-good">Stored file</span>}
        <h3>{doc?.label || file?.filename || 'Document'}</h3>
      </div>
      {file?.previewUrl && (isPdf || isImage) ? (
        <div className="cdx-preview">{isPdf ? <iframe title={file.filename || 'Document preview'} src={file.previewUrl} /> : <img alt={file.filename || 'Document'} src={file.previewUrl} />}</div>
      ) : null}
      <dl className="cdx-facts">
        <Fact k="Party" v={doc?.party || file?.party} />
        <Fact k="Source" v={doc?.source ? titleCase(doc.source) : file ? 'Email Command attachment' : null} />
        <Fact k="Reference" v={doc?.reference} mono />
        <Fact k="Version" v={doc?.version ? `v${doc.version}` : null} />
        <Fact k="Date" v={doc?.at ? stamp(doc.at, c.property.tz) : file?.at ? stamp(file.at, c.property.tz) : null} />
        <Fact k="File" v={file ? [file.filename, file.contentType, file.size ? `${Math.round(file.size / 1024)} KB` : null].filter(Boolean).join(' · ') : null} />
        <Fact k="Classified" v={file?.docType ? `${titleCase(file.docType)}${file.review ? ` · ${titleCase(file.review)}` : ''}` : null} />
      </dl>
      <p className="cdx-muted">{doc?.status === 'missing' ? 'Expected by now and not on record — nothing is inferred from its absence.' : file?.previewUrl ? 'Preview link is short-lived and read-only.' : 'No stored file in LeadCommand for this record — the reference points to its source.'}</p>
      {file?.previewUrl ? <a className="cdx-btn" href={file.previewUrl} target="_blank" rel="noreferrer">Open file<Icon name="external-link" /></a> : null}
    </>
  )
}

function DeadlineView({ c, d, closingDate, now }: { c: Closing; d: Deadline; closingDate: boolean; now: number }) {
  const w = whenLabel(d)
  return (
    <>
      <div className="cdx-insp__head">
        <span className={`cdx-dl-state is-${d.state || (d.met ? 'satisfied' : d.overdue ? 'overdue' : 'upcoming')}`}>{titleCase(d.state || (d.met ? 'satisfied' : d.overdue ? 'overdue' : 'upcoming'))}</span>
        <h3>{d.label}</h3>
        <p>{w.main}{w.alt ? ` · ${w.alt}` : ''}</p>
      </div>
      <dl className="cdx-facts">
        <Fact k="Owner" v={<OwnerTag owner={d.owner ?? null} />} />
        <Fact k="Record" v={d.field} mono />
        <Fact k="Relative" v={d.state === 'superseded' ? null : relativeMoment(d.at, c.property.tz, now, !d.time)} />
        <Fact k="Superseded" v={d.supersededAt ? `${stamp(d.supersededAt, c.property.tz)}${d.by ? ` · ${d.by}` : ''}` : null} />
        <Fact k="Reason" v={d.reason} />
      </dl>
      {d.calendar ? <button type="button" className="cdx-btn" onClick={() => go(links.calendarEvent(d.calendar!.eventId, d.calendar!.date))}><Icon name="calendar" />Open in Calendar</button> : null}
      <p className="cdx-muted">{closingDate ? 'The closing date moves only through the closing authority (reason + source kept); Calendar shows the same event.' : d.state === 'superseded' ? 'A superseded date is history — it is not projected to Calendar.' : 'Deadlines change only by amendment, recorded in Closing Desk.'}</p>
    </>
  )
}

function LoopView({ c, loop, now }: { c: Closing; loop: Loop; now: number }) {
  const mine = (c.automation?.emails ?? []).filter((e) => e.category.split(':')[0] === loop.key).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
  return (
    <>
      <div className="cdx-insp__head">
        <span className="cdx-sev is-system">{loopStateWord(loop.state)}</span>
        <h3>{loop.label}</h3>
        {loop.why ? <p>Why: {loop.why.toLowerCase()}</p> : null}
      </div>
      <dl className="cdx-facts">
        <Fact k="Progress" v={loop.max ? `${loop.done} of ${loop.max} sent or queued` : null} />
        <Fact k="Next" v={loop.next ? `#${loop.next.sequence} · ${relativeMoment(loop.next.at, c.property.tz, now)}` : null} />
        <Fact k="Escalates" v={loop.escalateAt ? relativeMoment(loop.escalateAt, c.property.tz, now) : null} />
        <Fact k="Held" v={c.automation?.held ? titleCase(c.automation.held) : null} />
      </dl>
      {mine.length ? (
        <ol className="cdx-reqlog">
          {mine.map((e) => (
            <li key={e.id || `${e.category}:${e.sequence}`} className={`is-${e.status}`}>
              <b>#{e.sequence} · {titleCase(e.status)}</b>
              <small>{e.sentAt ? `Sent ${stamp(e.sentAt, c.property.tz)}` : e.requestedAt ? `Requested ${stamp(e.requestedAt, c.property.tz)}` : ''}{e.reason ? ` · ${reasonWord(e.reason)}` : ''}</small>
            </li>
          ))}
        </ol>
      ) : <p className="cdx-muted">Nothing requested yet.</p>}
      <div className="cdx-insp__acts">
        <button type="button" className="cdx-btn" onClick={() => go(links.workflowRun(c.id))}><Icon name="activity" />View run</button>
        {c.title.thread?.id && loop.party === 'title' ? <button type="button" className="cdx-btn" onClick={() => go(links.emailThread(c.title.thread!.id!), c)}><Icon name="mail" />Title thread</button> : null}
        {c.buyer?.thread?.id && loop.party === 'buyer' ? <button type="button" className="cdx-btn" onClick={() => go(links.emailThread(c.buyer!.thread!.id!), c)}><Icon name="mail" />Buyer thread</button> : null}
      </div>
      <p className="cdx-muted">Closing automation requests; Email Command sends (or supersedes, when the counterparty has already replied).</p>
    </>
  )
}

function MoneyView({ c }: { c: Closing }) {
  const e = c.money.estimated
  return (
    <>
      <div className="cdx-insp__head"><h3>Expected vs actual</h3><p>Expected figures come from the closing record and offers; actuals only from a settled settlement statement.</p></div>
      <dl className="cdx-facts">
        <Fact k="Purchase price" v={e.contractPrice ? `${money(e.contractPrice.value)} · ${e.contractPrice.basis}` : null} />
        <Fact k="Buyer price" v={e.buyerPrice ? `${money(e.buyerPrice.value)} · ${e.buyerPrice.basis}` : null} />
        <Fact k="Expected fee" v={e.assignmentFee ? `${money(e.assignmentFee.value)} · ${e.assignmentFee.basis}` : null} />
        <Fact k="Actual net" v={c.money.actual ? money(c.money.actual.netProceeds) : 'Not settled'} />
        <Fact k="Buyer EMD" v={c.emd.buyer ? `${money(c.emd.buyer.amount)} · ${EMD_WORD[c.emd.buyer.state]}` : null} />
      </dl>
    </>
  )
}

/* ── the one authoritative form (closing-authority.js via the actions route) ── */

function ActionForm({ c, spec, demo, onCancel, onDone }: { c: Closing; spec: ActionSpec; demo: boolean; onCancel: () => void; onDone: () => void }) {
  const [values, setValues] = useState<Record<string, string | boolean>>({})
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ActionResult | null>(null)
  const [confirming, setConfirming] = useState(false)
  const set = (k: string, v: string | boolean) => setValues((p) => ({ ...p, [k]: v }))

  const send = async () => {
    const fields: Record<string, unknown> = { ...(spec.fixed || {}) }
    for (const f of spec.fields) {
      const v = values[f.key]
      if (v === undefined || v === '') continue
      fields[f.key] = f.type === 'number' ? Number(v) : f.type === 'datetime' ? zonedToIso(String(v), c.property.tz) : f.type === 'toggle' ? v === true : v
    }
    setBusy(true)
    const r = await postClosingAction(c.id, spec.action, fields)
    setBusy(false)
    setConfirming(false)
    setResult(r)
    if (r.ok) window.setTimeout(onDone, 700)
  }
  const submit = () => {
    if (demo) return
    const missing = spec.fields.filter((f) => f.required && (values[f.key] === undefined || values[f.key] === ''))
    if (missing.length) { setResult({ ok: false, code: 'MISSING_FIELDS', message: `Required: ${missing.map((f) => f.label).join(', ')}` }); return }
    if (spec.confirm) { setConfirming(true); return }
    void send()
  }
  const finalizeLocked = spec.action === 'finalize_closing' && !c.finalize?.ok

  return (
    <div className="cdx-form">
      <div className="cdx-insp__head"><span className="cdx-eyebrow">{spec.group}</span><h3>{spec.label}</h3></div>
      {demo ? <p className="cdx-note is-warn"><Icon name="alert" />Demo data — nothing can be recorded.</p> : null}
      {finalizeLocked ? (
        <div className="cdx-note is-bad"><Icon name="alert" /><span>The S10 guard refuses: {(c.finalize?.blockers ?? []).map((b) => b.message).join(' · ')}</span></div>
      ) : null}
      {spec.fields.map((f) => (
        <label key={f.key} className={`cdx-field${f.type === 'toggle' ? ' is-toggle' : ''}`}>
          <span>{f.label}{f.required ? <b aria-hidden> *</b> : null}</span>
          {f.type === 'select' ? (
            <select value={String(values[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)} disabled={demo || busy}>
              <option value="">Choose…</option>
              {f.options?.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          ) : f.type === 'toggle' ? (
            <input type="checkbox" checked={values[f.key] === true} onChange={(e) => set(f.key, e.target.checked)} disabled={demo || busy} />
          ) : f.type === 'textarea' ? (
            <textarea rows={3} value={String(values[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)} disabled={demo || busy} />
          ) : (
            <input type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : f.type === 'datetime' ? 'datetime-local' : 'text'} placeholder={f.placeholder} value={String(values[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)} disabled={demo || busy} />
          )}
          {f.hint ? <small>{f.hint}</small> : null}
        </label>
      ))}
      {result ? (
        <div className={`cdx-note ${result.ok ? 'is-good' : 'is-bad'}`} role="status">
          <Icon name={result.ok ? 'check' : 'alert'} />
          <span><b>{result.ok ? 'Recorded' : titleCase(String(result.code || 'Refused'))}</b>{result.message ? ` — ${result.message}` : ''}{result.blockers?.length ? <> — {result.blockers.map((b) => b.message || titleCase(b.code)).join(' · ')}</> : null}</span>
        </div>
      ) : null}
      <div className="cdx-insp__acts">
        <button type="button" className="cdx-btn" onClick={onCancel}>Cancel</button>
        <button type="button" className={`cdx-btn is-primary${spec.danger ? ' is-danger' : ''}`} disabled={demo || busy || finalizeLocked} onClick={submit}>{busy ? 'Saving…' : spec.action === 'finalize_closing' ? 'Finalize' : 'Record'}</button>
      </div>
      <p className="cdx-muted">Recorded with your identity, the time and the evidence you give. The server decides — and says exactly why if it refuses.</p>
      {confirming ? (
        <div className="cdx-confirm" role="alertdialog" aria-modal="true" aria-label="Confirm">
          <div className="cdx-confirm__card">
            <h4>{spec.action === 'finalize_closing' ? 'Finalize this closing?' : 'End this closing?'}</h4>
            <p>{spec.confirm}</p>
            <div className="cdx-insp__acts">
              <button type="button" className="cdx-btn" onClick={() => setConfirming(false)} autoFocus>Go back</button>
              <button type="button" className={`cdx-btn is-primary${spec.danger ? ' is-danger' : ''}`} onClick={() => void send()} disabled={busy}>{spec.action === 'finalize_closing' ? 'Finalize closing' : 'Confirm'}</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
