// The CEO queue: what a recorded decision means (docs/WORKFORCE.md §4.2 escalation, §6). Pure text.
//
// A decision on a queued item (an escalation, an offer-recommendation review, an underwriting or operator
// review) is RECORDED inside Workforce and nothing else happens: no seller message, no offer, no stage
// change, no runtime job, no new assignment. The copy below says exactly that, per task, so neither the
// API response, the COO line nor the UI can imply that "approve" set anything in motion.
// Properties are pid_ refs (decoded for display by the API presenter); never a phone, an email or a name.

export const DECISIONS = Object.freeze(['approve', 'decline', 'done'])
export const NOTHING_ELSE = 'Nothing was sent, no offer was made and no stage changed.'
/** every effect a decision could have outside Workforce: all false in Phase A, pinned by tests */
export const DECISION_EFFECTS = Object.freeze({ recorded_in_workforce: true, seller_contacted: false, offer_made: false, stage_changed: false, runtime_job_started: false, work_created: false })

const TASK_NOUN = Object.freeze({
  escalation: 'the executive review',
  review_offer_recommendation: 'the offer recommendation review',
  underwrite_review: 'the underwriting review',
  operator_review: 'the operator review',
})
const taskNoun = (task) => TASK_NOUN[task] || 'the queued item'
const subject = (property_ref) => (property_ref ? ` of property ${property_ref}` : '')

/** the next step, always internal and always a person's (Workforce starts nothing from a decision in Phase A) */
function nextStep(task, decision) {
  if (decision === 'decline') return 'Workforce plans no further work on it in this mission.'
  if (decision === 'done') return 'Workforce plans no further work on it.'
  switch (task) {
    case 'review_offer_recommendation': return 'Next step stays internal and with you: review the offer recommendation in Deal Intelligence. Workforce prepares nothing new from this.'
    case 'underwrite_review': return 'Next step stays internal and with you: the underwriting in Deal Intelligence. Workforce starts no new work from this.'
    case 'operator_review': return 'Next step stays internal and with you: the conversation and the deal in Deal Intelligence. Workforce starts no new work from this.'
    case 'escalation': return 'It is cleared past the executive threshold inside Workforce only. Any offer still goes through Deal Intelligence and its own approval.'
    default: return 'Workforce starts no new work from this.'
  }
}

/**
 * @param {{ decision: 'approve'|'decline'|'done', task?: string|null, property_ref?: string|null }} o
 * @returns {{ headline: string, next_step: string, message: string, effects: typeof DECISION_EFFECTS }}
 */
export function decisionOutcome({ decision, task = null, property_ref = null }) {
  const verb = decision === 'approve' ? 'approved' : decision === 'decline' ? 'declined' : 'marked done'
  const headline = `Recorded: you ${verb} ${taskNoun(task)}${subject(property_ref)}.`
  const next_step = nextStep(task, decision)
  return { headline, next_step, message: `${headline} ${next_step} ${NOTHING_ELSE}`, effects: DECISION_EFFECTS }
}

/** The COO's acknowledgement line in the executive conversation. */
export function decisionAck({ decision, task = null, property_ref = null, note = null }) {
  const o = decisionOutcome({ decision, task, property_ref })
  const verb = decision === 'approve' ? 'approved' : decision === 'decline' ? 'declined' : 'closed'
  const why = note ? ' Your note is on the item.' : ''
  return `Noted: you ${verb} ${taskNoun(task)}${subject(property_ref)}. I recorded it in Workforce.${why} ${o.next_step} ${NOTHING_ELSE}`
}
