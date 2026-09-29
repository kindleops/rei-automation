/**
 * EMAIL → CLOSING AUTHORITY intake.
 *
 * Email Command never writes closing state. It submits what a counterparty
 * asserted — with the sender, the thread, the timestamp and the exact
 * sentence as evidence — to Closing Authority, whose own rules decide
 * (e.g. clear-to-close is refused while a title issue is open).
 *
 * Only assertions from a VERIFIED sender (the title company already on this
 * closing, reached through our own thread) are submitted. An unverified
 * sender's assertion becomes an operator review item, never state.
 *
 * Never submitted, always the operator's: closing-date changes, settlement
 * figures, anything financial, anything that looks like wire instructions.
 */
import {
  acknowledgeTitleOrder,
  setTitleCommitmentDue,
  recordTitleCommitment,
  recordClearToClose,
  openTitleIssue,
} from '@/lib/domain/closings/closing-authority.js'

const ACTOR = 'email_command'

export async function submitClosingAssertions({ db, thread, inbound, classification, attachments = [], verified, now }, deps = {}) {
  const applied = []
  let needs = null
  const closingCaseId = thread.closing_case_id
  const evidence = `email:${inbound.id}`
  const authorityDeps = { supabase: db, now: () => new Date(now), notify: deps.notify, transitionOpportunityStage: deps.transitionOpportunityStage }
  if (classification.flags.includes('wire_instructions')) return { applied, needs: classification.needs }

  const assertions = classification.assertions || []
  if (!verified && assertions.length) {
    return { applied, needs: { code: 'unverified_sender_assertion', reason: `${inbound.from_email} is not the title contact on this closing — review what they said before it counts` } }
  }

  const record = (type, res, extra = {}) => { applied.push({ type, ok: Boolean(res?.ok), code: res?.code || null, duplicate: Boolean(res?.duplicate), ...extra }); return res }

  for (const a of assertions) {
    if (a.type === 'title_acknowledged') {
      record(a.type, await acknowledgeTitleOrder({ closingCaseId, actor: ACTOR, source: 'title_email', evidenceReference: evidence, at: inbound.received_at }, authorityDeps))
    } else if (a.type === 'commitment_due' && a.value) {
      record(a.type, await setTitleCommitmentDue({ closingCaseId, actor: ACTOR, source: 'title_email', dueDate: `${a.value}T00:00:00Z`, evidenceReference: evidence }, authorityDeps), { value: a.value })
    } else if (a.type === 'title_issue') {
      const res = record(a.type, await openTitleIssue({ closingCaseId, actor: ACTOR, source: 'title_email', issueType: a.value, description: a.excerpt, evidenceReference: evidence, idempotencyKey: `email:${inbound.id}:${a.value}` }, authorityDeps), { value: a.value })
      if (!res?.ok) needs = { code: 'title_issue', reason: `Title reported an issue: "${a.excerpt}"` }
    } else if (a.type === 'clear_to_close') {
      const res = record(a.type, await recordClearToClose({ closingCaseId, actor: ACTOR, source: 'title_email', evidenceReference: evidence, at: inbound.received_at }, authorityDeps))
      if (res && !res.ok) needs = { code: 'clear_to_close_refused', reason: `Title said the file is clear to close, but Closing Authority refused: ${res.message || res.code}` }
    }
  }

  // A commitment PDF from the verified title contact, auto-classified, is the evidence.
  const commitmentDoc = attachments.find((x) => x.doc_type === 'title_commitment' && x.review_state === 'auto_classified')
  if (commitmentDoc && verified && thread.category === 'title') {
    const res = record('commitment_received', await recordTitleCommitment({ closingCaseId, actor: ACTOR, source: 'title_email', evidenceReference: `attachment:${commitmentDoc.id}`, receivedAt: inbound.received_at }, authorityDeps))
    if (res?.ok && commitmentDoc.id) {
      await db.from('email_attachments').update({ routed_entity_type: 'closing_case', routed_entity_id: closingCaseId, routed_at: new Date(now).toISOString() }).eq('id', commitmentDoc.id)
    }
  }
  return { applied, needs }
}
