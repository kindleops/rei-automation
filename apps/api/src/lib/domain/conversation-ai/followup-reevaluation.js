// FOLLOW-UP RE-EVALUATION (shadow): given ONE due follow-up, should it still go?
//
//   keep          nothing changed since it was scheduled; the question is still open
//   skip          the seller answered it, said no / stop / wrong number, the stage moved
//                 past it, the question was already asked twice or deflected, or it is a
//                 historical overdue row (NEVER replayed)
//   rewrite_draft the seller wrote since it was scheduled, without answering: the
//                 scheduled text no longer fits — R2 composes a new draft in shadow
//
// Pure. Shadow verdicts only; nothing here cancels, holds or sends a queue row.
import { buildThreadLedger, factLedgerOf } from './ledger.js'
import { blockedQuestionKinds, questionKindOf, questionLedger } from './questions.js'
import { deriveStageEvidence } from './context-builder.js'

export const FOLLOWUP_REEVAL_VERSION = 'conv-ai.followup-reeval.v1'
/** A follow-up due longer ago than this is historical: never replayed, always skipped. */
export const MAX_OVERDUE_MS = 6 * 60 * 60 * 1000

const STAGE_OF_KIND = Object.freeze({ ownership: 0, interest: 1, asking_price: 2, condition: 3 })
const STAGES = ['S1_ownership', 'S2_interest', 'S3_asking_price', 'S4_condition', 'S5_offer']
const DISINTEREST = new Set(['not_interested', 'opt_out', 'stop_texting', 'wrong_number', 'hostile_or_legal', 'property_specific_non_owner', 'former_owner_respondent', 'not_owner'])

/**
 * @param {object} a
 * @param {{ id?: string, use_case: string, body?: string, created_at: string, due_at: string }} a.followup
 * @param {Array<{ id: string, direction: 'inbound'|'outbound', body: string, at: string, use_case?: string|null, intent?: string|null }>} a.thread chronological
 * @param {string} a.now
 */
export function reevaluateFollowUp({ followup, thread = [], now }) {
  const t = (x) => Date.parse(x) || 0
  const reasons = []
  const due = t(followup.due_at)
  const nowMs = t(now)
  const kind = questionKindOf({ use_case: followup.use_case, body: followup.body || '' })
  if (!due || nowMs - due > MAX_OVERDUE_MS) return { verdict: 'skip', reasons: ['historical_overdue_never_replayed'], question_kind: kind, version: FOLLOWUP_REEVAL_VERSION }
  const upTo = thread.filter((m) => t(m.at) <= nowMs)
  const inbound = upTo.filter((m) => m.direction === 'inbound')
  const since = inbound.filter((m) => t(m.at) > t(followup.created_at))
  // rc-8.5.20: the canonical thread ledger (ledger.js), the same facts every consumer reads
  const facts = factLedgerOf(buildThreadLedger({ messages: upTo.map((m) => ({ id: m.id, direction: m.direction, body: m.body, at: m.at, use_case: m.use_case || null, intent: m.intent || null })), now }))
  const ledger = questionLedger(upTo, facts)
  const blocked = blockedQuestionKinds(ledger)
  const stage = deriveStageEvidence({ facts, ledger, offers: [] })
  if (since.some((m) => DISINTEREST.has(String(m.intent || '')))) reasons.push('seller_disinterested_or_stopped')
  if (['nurture', 'closed'].includes(stage.stage) && !/nurture|reengage/.test(String(followup.use_case))) reasons.push(`stage_${stage.stage}`)
  if (ledger[kind]?.answered) reasons.push(`already_answered:${kind}`)
  else if (blocked.has(kind)) reasons.push(`question_blocked:${kind}`)
  const ks = STAGE_OF_KIND[kind]
  const si = STAGES.indexOf(stage.stage)
  if (ks != null && si > ks) reasons.push(`stage_advanced:${stage.stage}`)
  if (reasons.length) return { verdict: 'skip', reasons: [...new Set(reasons)], question_kind: kind, stage: stage.stage, version: FOLLOWUP_REEVAL_VERSION }
  if (since.length) return { verdict: 'rewrite_draft', reasons: ['intervening_inbound_unanswered_question'], question_kind: kind, stage: stage.stage, intervening_inbound_ids: since.map((m) => m.id), version: FOLLOWUP_REEVAL_VERSION }
  return { verdict: 'keep', reasons: [], question_kind: kind, stage: stage.stage, version: FOLLOWUP_REEVAL_VERSION }
}
