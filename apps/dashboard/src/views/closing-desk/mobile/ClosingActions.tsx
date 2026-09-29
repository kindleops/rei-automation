import { useState } from 'react'
import { Icon } from '../../../shared/icons'
import { postClosingAction, type ActionResult, type Closing } from './closing-execution-api'
import { titleCase } from './closing-format'

/**
 * CLOSING DESK ACTIONS — each one is a single authoritative server operation
 * (POST …/execution/:id/actions → closing-authority.js). The client never
 * writes a closing, settlement, stage or calendar row itself; it submits the
 * facts + evidence and shows the server's structured answer (including why it
 * refused). Only actions the current state can legitimately take are offered.
 */

type FieldType = 'text' | 'number' | 'date' | 'datetime' | 'select' | 'toggle' | 'textarea'
interface Field { key: string; label: string; type: FieldType; required?: boolean; options?: Array<[string, string]>; hint?: string; placeholder?: string }
export interface ActionSpec { action: string; label: string; group: 'Buyer' | 'EMD' | 'Title' | 'Closing' | 'Money' | 'Control'; fields: Field[]; fixed?: Record<string, unknown>; danger?: boolean; confirm?: string }

const EMD_METHODS: Array<[string, string]> = [['title_provider', 'Title / escrow confirmed'], ['document_upload', 'Receipt uploaded'], ['bank_feed', 'Bank record'], ['manual_operator', 'Operator verified']]
const SETTLE_METHODS: Array<[string, string]> = [['title_provider', 'Title provider'], ['escrow_provider', 'Escrow provider'], ['document_upload', 'Signed statement'], ['bank_feed', 'Bank record'], ['manual_operator', 'Operator verified']]
const CTC_SOURCES: Array<[string, string]> = [['title_email', 'Title email'], ['title_provider', 'Title portal / call'], ['title_integration', 'Title integration'], ['operator_confirmation', 'Operator confirmation']]
const ISSUE_TYPES: Array<[string, string]> = ['open_lien', 'probate', 'name_discrepancy', 'hoa_balance', 'missing_release', 'tax', 'judgment', 'easement', 'survey', 'other'].map((t) => [t, titleCase(t)])
const evidence = (label = 'Evidence', hint?: string): Field => ({ key: 'evidenceReference', label, type: 'text', required: true, hint: hint ?? 'Document, email, confirmation # — what proves this' })

/** What this closing can legitimately record right now. */
export function availableActions(c: Closing): ActionSpec[] {
  if (c.terminal || c.closed) return []
  const out: ActionSpec[] = []
  const b = c.buyer
  const executed = c.contract.status === 'fully_executed'

  // BUYER — selected ≠ committed ≠ agreement ≠ EMD.
  if (!b || ['withdrawn', 'rejected', 'superseded'].includes(b.offerStatus || '')) {
    out.push({ action: 'record_buyer_offer', label: 'Record buyer offer', group: 'Buyer', fields: [
      { key: 'buyerId', label: 'Buyer ID', type: 'text', required: true, hint: 'The buyer entity / record id' },
      { key: 'buyerName', label: 'Buyer company', type: 'text' },
      { key: 'offerPrice', label: 'Offer price', type: 'number', required: true },
      { key: 'strategy', label: 'Strategy', type: 'select', options: [['assignment', 'Assignment'], ['double_close', 'Double close'], ['novation', 'Novation']] },
      { key: 'emdAmount', label: 'Buyer EMD', type: 'number' },
      { key: 'emdDueDate', label: 'EMD due', type: 'date' },
      { key: 'closingDate', label: "Buyer's closing date", type: 'date' },
    ] })
  } else if (b.offerStatus === 'submitted' || b.offerStatus === 'draft') {
    out.push({ action: 'select_buyer', label: 'Select this buyer', group: 'Buyer', fixed: { buyerOfferId: b.offerId }, fields: [{ key: 'reason', label: 'Why this buyer', type: 'text' }] })
  }
  if (b?.selected && !b.committed && executed) {
    out.push({ action: 'record_buyer_agreement', label: 'Update buyer agreement', group: 'Buyer', fixed: { buyerOfferId: b.offerId }, fields: [
      { key: 'status', label: 'Agreement status', type: 'select', required: true, options: [['sent', 'Sent'], ['viewed', 'Viewed'], ['buyer_signed', 'Buyer signed'], ['counterparty_signed', 'We signed'], ['fully_executed', 'Fully executed'], ['declined', 'Declined'], ['voided', 'Voided'], ['expired', 'Expired']] },
      { key: 'providerEnvelopeId', label: 'Signing envelope ID', type: 'text', hint: 'Required for Fully executed (or a signed-document reference below)' },
      { key: 'evidenceReference', label: 'Signed document reference', type: 'text' },
    ] })
    out.push({ action: 'commit_buyer', label: 'Confirm commitment (no agreement)', group: 'Buyer', fixed: { buyerOfferId: b.offerId, commitmentType: 'other' }, fields: [evidence('Commitment evidence', 'The communication confirming the buyer is bound')] })
  }

  // EMD — receipts only; verified needs provenance.
  const buyerEmd = c.emd.buyer
  if (b?.selected && buyerEmd && !buyerEmd.receipt && buyerEmd.state !== 'not_required') {
    out.push({ action: 'record_emd_receipt', label: 'Record buyer EMD received', group: 'EMD', fixed: { buyerOfferId: b.offerId }, fields: [
      { key: 'amount', label: 'Amount', type: 'number', required: true },
      { key: 'receivedAt', label: 'Received', type: 'datetime', required: true },
      { key: 'escrowDestination', label: 'Held by', type: 'text', required: true, placeholder: c.title.company || 'Title / escrow' },
      { key: 'externalReference', label: 'Wire / receipt #', type: 'text' },
      { key: 'evidenceReference', label: 'Receipt reference', type: 'text' },
    ] })
    out.push({ action: 'waive_buyer_emd', label: 'Waive buyer EMD', group: 'EMD', fixed: { buyerOfferId: b.offerId }, fields: [{ key: 'reason', label: 'Reason', type: 'text', required: true }, evidence()] })
  }
  if (buyerEmd?.receipt?.status === 'received_unverified' && buyerEmd.receipt.id) {
    out.push({ action: 'verify_emd', label: 'Verify buyer EMD', group: 'EMD', fixed: { receiptId: buyerEmd.receipt.id }, fields: [{ key: 'method', label: 'Verified by', type: 'select', required: true, options: EMD_METHODS }, evidence()] })
  }
  if (c.emd.contract && !c.emd.contract.receipt) {
    out.push({ action: 'record_contract_emd_deposit', label: 'Record seller-contract EMD deposit', group: 'EMD', fields: [
      { key: 'amount', label: 'Amount', type: 'number', required: true },
      { key: 'depositedAt', label: 'Deposited', type: 'datetime', required: true },
      { key: 'escrowDestination', label: 'Held by', type: 'text' },
      evidence(),
    ] })
  }

  // TITLE — clear to close is explicit, from a trusted source, with evidence.
  if (executed) {
    const t = c.title
    if (!t.clearToClose) {
      out.push({ action: 'acknowledge_title', label: 'Title acknowledged the order', group: 'Title', fields: [{ key: 'source', label: 'How', type: 'select', options: [['title_email', 'Title email'], ['phone', 'Phone'], ['title_provider', 'Title portal']] }, { key: 'evidenceReference', label: 'Reference', type: 'text' }] })
      out.push({ action: 'record_title_commitment', label: 'Title commitment received', group: 'Title', fields: [{ key: 'receivedAt', label: 'Received', type: 'datetime' }, evidence('Commitment reference')] })
      out.push({ action: 'open_title_issue', label: 'Report a title issue', group: 'Title', fields: [
        { key: 'issueType', label: 'Issue', type: 'select', required: true, options: ISSUE_TYPES },
        { key: 'description', label: 'Detail', type: 'textarea' },
        { key: 'owner', label: 'Who resolves it', type: 'select', options: [['title', 'Title'], ['seller', 'Seller'], ['you', 'You'], ['buyer', 'Buyer'], ['lender', 'Lender']] },
        { key: 'source', label: 'Reported by', type: 'select', required: true, options: [['title_commitment', 'Title commitment'], ['title_email', 'Title email'], ['operator', 'Operator']] },
        { key: 'evidenceReference', label: 'Reference', type: 'text' },
      ] })
      out.push({ action: 'record_clear_to_close', label: 'Record clear to close', group: 'Title', fields: [{ key: 'source', label: 'From', type: 'select', required: true, options: CTC_SOURCES }, evidence('Clear-to-close confirmation')] })
    }
    for (const i of (c.titleIssues || []).filter((x) => x.status === 'open' || x.status === 'in_progress')) {
      out.push({ action: 'update_title_issue', label: `Resolve: ${titleCase(i.type)}`, group: 'Title', fixed: { issueId: i.id }, fields: [
        { key: 'status', label: 'Outcome', type: 'select', required: true, options: [['resolved', 'Resolved'], ['waived', 'Waived'], ['in_progress', 'In progress']] },
        { key: 'resolutionEvidence', label: 'Resolution evidence', type: 'text', hint: 'Required to resolve or waive' },
        { key: 'notes', label: 'Notes', type: 'textarea' },
      ] })
    }
  }

  // CLOSING DATE — history kept; zone = the property's.
  out.push({ action: 'set_closing_date', label: c.closing ? 'Reschedule / confirm closing' : 'Set closing date', group: 'Closing', fixed: { tz: c.property.tz }, fields: [
    { key: 'scheduledAt', label: `Closing (${c.property.tz ? c.property.tz.split('/').pop()?.replace('_', ' ') : 'local'} time)`, type: 'datetime', required: true },
    { key: 'confirmed', label: 'Confirmed by title', type: 'toggle' },
    { key: 'reason', label: 'Reason', type: 'text', required: true },
    { key: 'source', label: 'Source', type: 'select', required: true, options: [['title_email', 'Title email'], ['operator', 'Operator'], ['buyer', 'Buyer'], ['seller', 'Seller']] },
  ] })

  // MONEY — actuals only from the statement; settled needs evidence and is final.
  out.push({ action: 'record_settlement', label: 'Record settlement statement', group: 'Money', fields: [
    { key: 'statementType', label: 'Statement', type: 'select', options: [['alta', 'ALTA'], ['hud1', 'HUD-1'], ['closing_statement', 'Closing statement'], ['other', 'Other']] },
    { key: 'statementReference', label: 'Statement reference', type: 'text' },
    { key: 'actualSellerAmount', label: 'Purchase (seller) — actual', type: 'number' },
    { key: 'actualBuyerAmount', label: 'Sale (buyer) — actual', type: 'number' },
    { key: 'actualAssignmentFee', label: 'Assignment fee — actual', type: 'number' },
    { key: 'actualClosingCosts', label: 'Closing costs — actual', type: 'number' },
    { key: 'actualNetProceeds', label: 'Net proceeds — actual', type: 'number' },
    { key: 'settle', label: 'Final & settled (cannot be edited after)', type: 'toggle' },
    { key: 'closedAt', label: 'Settled at', type: 'datetime' },
    { key: 'closingProvider', label: 'Settled by', type: 'text', placeholder: c.title.company || 'Title / escrow' },
    { key: 'verificationMethod', label: 'Verified by', type: 'select', options: SETTLE_METHODS },
    { key: 'evidenceReference', label: 'Final statement / confirmation', type: 'text' },
  ] })

  // CONTROL
  out.push({ action: 'finalize_closing', label: 'Finalize closing (S10)', group: 'Control', fields: [], confirm: 'Close this deal? This writes the final record and moves it to Closed.' })
  out.push({ action: 'set_automation_paused', label: c.automation?.paused ? 'Resume automation' : 'Pause automation', group: 'Control', fixed: { paused: !c.automation?.paused }, fields: c.automation?.paused ? [] : [{ key: 'reason', label: 'Why pause', type: 'text', required: true }] })
  out.push({ action: 'terminate_closing', label: 'Cancel / withdraw closing', group: 'Control', danger: true, fields: [
    { key: 'outcome', label: 'Outcome', type: 'select', required: true, options: [['cancelled', 'Cancelled'], ['withdrawn', 'Withdrawn'], ['failed', 'Failed']] },
    { key: 'reason', label: 'Reason', type: 'text', required: true },
  ], confirm: 'End this closing? Automation stops; history is kept; it will never be marked Closed.' })
  return out
}

/** The model's next-action verb → the form that records it (when one exists). */
export function actionForNext(action: string | null | undefined, c: Closing): ActionSpec | null {
  const map: Record<string, string> = {
    verify_emd: 'verify_emd', record_contract_emd: 'record_contract_emd_deposit', schedule_closing: 'set_closing_date',
    select_buyer: 'record_buyer_offer', send_buyer_agreement: 'record_buyer_agreement', resolve_emd: 'record_emd_receipt',
  }
  const want = map[action || '']
  return want ? availableActions(c).find((a) => a.action === want) ?? null : null
}

/* ── wall time in the property's zone → exact instant ── */
export function zonedToIso(local: string, tz: string | null): string | null {
  if (!local) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local)
  if (!m) return null
  const [y, mo, d, h, mi] = m.slice(1).map(Number)
  const guess = Date.UTC(y, mo - 1, d, h, mi)
  if (!tz) return new Date(guess).toISOString()
  const offsetAt = (t: number) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(t)).map((x) => [x.type, x.value]))
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute)) - t
  }
  const first = guess - offsetAt(guess)
  return new Date(guess - offsetAt(first)).toISOString()
}

export function ActionForm({ c, spec, demo, onClose, onDone }: { c: Closing; spec: ActionSpec; demo: boolean; onClose: () => void; onDone: () => void }) {
  const [values, setValues] = useState<Record<string, string | boolean>>({})
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ActionResult | null>(null)
  const [armed, setArmed] = useState(false)
  const set = (k: string, v: string | boolean) => setValues((p) => ({ ...p, [k]: v }))

  const submit = async () => {
    if (demo) return
    const missing = spec.fields.filter((f) => f.required && (values[f.key] === undefined || values[f.key] === ''))
    if (missing.length) { setResult({ ok: false, code: 'MISSING_FIELDS', message: `Required: ${missing.map((f) => f.label).join(', ')}` }); return }
    // High-impact actions take a second, deliberate tap (no blocking browser dialog).
    if (spec.confirm && !armed) { setArmed(true); return }
    const fields: Record<string, unknown> = { ...(spec.fixed || {}) }
    for (const f of spec.fields) {
      const v = values[f.key]
      if (v === undefined || v === '') continue
      fields[f.key] = f.type === 'number' ? Number(v) : f.type === 'datetime' ? zonedToIso(String(v), c.property.tz) : f.type === 'toggle' ? v === true : v
    }
    setBusy(true)
    const r = await postClosingAction(c.id, spec.action, fields)
    setBusy(false)
    setResult(r)
    if (r.ok) window.setTimeout(onDone, 650)
  }

  return (
    <div className="cd2-sheet" role="dialog" aria-modal="true" aria-label={spec.label}>
      <button type="button" className="cd2-sheet__scrim" aria-label="Close" onClick={onClose} />
      <div className="cd2-sheet__panel">
        <div className="cd2-sheet__grab" />
        <span className="cd2-eyebrow"><i />{spec.group}</span>
        <h3>{spec.label}</h3>
        {demo ? <p className="cd2-degraded"><Icon name="alert" />Demo data — actions are disabled.</p> : null}
        <div className="cd2-form">
          {spec.fields.map((f) => (
            <label key={f.key} className={`cd2-field${f.type === 'toggle' ? ' is-toggle' : ''}`}>
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
                <input
                  type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : f.type === 'datetime' ? 'datetime-local' : 'text'}
                  inputMode={f.type === 'number' ? 'decimal' : undefined}
                  placeholder={f.placeholder}
                  value={String(values[f.key] ?? '')}
                  onChange={(e) => set(f.key, e.target.value)}
                  disabled={demo || busy}
                />
              )}
              {f.hint ? <small>{f.hint}</small> : null}
            </label>
          ))}
        </div>
        {armed && spec.confirm && !result ? <p className="cd2-degraded"><Icon name="alert" />{spec.confirm} Tap again to confirm.</p> : null}
        {result ? (
          <div className={`cd2-result${result.ok ? ' is-ok' : ' is-bad'}`} role="status">
            <strong>{result.ok ? 'Recorded' : titleCase(String(result.code || 'Refused'))}</strong>
            {result.message ? <p>{result.message}</p> : null}
            {result.blockers?.length ? <ul>{result.blockers.map((b) => <li key={b.code}>{b.message || titleCase(b.code)}{b.owner ? ` · ${titleCase(b.owner)}` : ''}</li>)}</ul> : null}
          </div>
        ) : null}
        <div className="cd2-form__acts">
          <button type="button" className="cd2-act" onClick={onClose}>Cancel</button>
          <button type="button" className={`cd2-act is-primary${spec.danger ? ' is-danger' : ''}`} disabled={demo || busy} onClick={() => void submit()}>{busy ? 'Saving…' : armed ? 'Confirm' : spec.action === 'finalize_closing' ? 'Finalize' : 'Record'}</button>
        </div>
        <p className="cd2-muted">Recorded with your identity, the time, and the evidence you give. The server decides — it will say exactly why if it refuses.</p>
      </div>
    </div>
  )
}
