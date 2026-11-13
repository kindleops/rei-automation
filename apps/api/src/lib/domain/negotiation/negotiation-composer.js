// ─── NEGOTIATION REPLY COMPOSER (8.5.21-b, owner directive Phase 8) ───────────
// Contract: lc.negotiation-composer.v1 — documented in docs/negotiation-composer-hook.md.
//
// THE call site of composerView() and checkSellerFacingText() (seller-facing-guard.js). The
// 8.5.21-a runtime calls composeNegotiationReply() for a PREPARE_OFFER or
// NEGOTIATE_WITHIN_AUTHORITY outcome (or plugs createEnvelopeNegotiationAuthority() into the
// conversation pipeline's NegotiationAuthority slot). It renders ONLY an envelope-authorized
// move and only when a SEPARATE live send authorization covers it:
//
//   1 OFF unless NEGOTIATION_COMPOSER_ENABLED=1                       → ESCALATE (no draft)
//   2 handleDecisionOutcome → position + composer_view (the ONLY projection read here)
//       needs_envelope / escalate                                     → ESCALATE (no amount)
//       within_authority + hold                                       → HOLD (no message)
//   3 send authorization (send-authorization.js) live for THIS scope, envelope, amount and
//     terms                                                           → else ESCALATE (no draft)
//   4 an APPROVED sms_templates row (real id, never local-template:*, active, the move's use
//     case, the thread's language, exactly one {{offer_price}} token, no other money)
//                                                                     → else ESCALATE
//   5 render (templates/render-template.js) with offer_price = the authorized move amount
//   6 checkSellerFacingText(draft, { position, plan, economics, envelope }) + forbidden-claim
//     scan; ANY violation                                             → ESCALATE (hold for a human,
//                                                                       never a rewrite)
//   7 DETERMINISTIC_REPLY { template_id, rendered_text, amount, authority_ref, persist }
//
// It NEVER sends, never persists an offer and never appends the ledger: `persist` tells the
// send path what to write BEFORE the send (seller-offer-authority.persistActiveOffer with
// toSellerOfferArgs, then recordNegotiationEvent) — 8.5.21-a's send path owns those writes.
import { handleDecisionOutcome } from './conversation-engine-interface.js'
import { checkSellerFacingText, composerView, extractMoneyAmounts } from './seller-facing-guard.js'
import { scopeKey } from './envelope.js'
import { sendAuthorizationStatus } from './send-authorization.js'
import { toSellerOfferArgs } from './ledger.js'
import { renderTemplate } from '../templates/render-template.js'
import { consultHold, HOLD_CAPABILITIES } from '../../agent/operations/automation-hold-gate.js'

export const NEGOTIATION_COMPOSER_VERSION = 'lc.negotiation-composer.v1'
export const NEGOTIATION_COMPOSER_FLAG = 'NEGOTIATION_COMPOSER_ENABLED'
/**
 * Approved sms_templates use cases per authorized move (first match wins, in order). Only canonical
 * seller-flow use cases the template renderer allows {{offer_price}} in (render-template.js
 * placeholderAllowedForUseCase): offer_reveal_cash, narrow_range, close_handoff.
 */
export const MOVE_TEMPLATE_USE_CASES = Object.freeze({
  open: Object.freeze(['offer_reveal_cash']),
  counter: Object.freeze(['narrow_range']),
  final: Object.freeze(['narrow_range']),
  agree_at_seller_price: Object.freeze(['close_handoff', 'offer_reveal_cash']),
})
const FORBIDDEN_CLAIM_RE = Object.freeze({
  cash_on_hand_or_funds_available: /\b(cash on hand|funds (are )?(ready|available)|we have the (cash|money)|money is ready)\b/i,
  proof_of_funds: /\b(proof of funds|pof)\b/i,
  guaranteed_close: /\b(guarantee(d)?|promise) (to )?(close|closing)\b|\bclose (in|within) \d+ (days|weeks) guaranteed\b/i,
  final_contract_terms: /\b(this is (a|the) (binding|final) contract|legally binding)\b/i,
})
const ALLOWED_TOKENS = new Set(['offer_price', 'seller_first_name', 'property_address', 'property_street', 'agent_first_name', 'agent_name', 'city', 'property_city'])

export function negotiationComposerEnabled(env = process.env) {
  return String(env?.[NEGOTIATION_COMPOSER_FLAG] ?? '').trim() === '1'
}

const usd = (n) => `$${Math.round(n).toLocaleString('en-US')}`
const lower = (v) => String(v ?? '').trim().toLowerCase()
const escalate = (reason, extra = {}) => ({ version: NEGOTIATION_COMPOSER_VERSION, action: 'ESCALATE_TO_OPERATOR', reason, rendered_text: null, amount: null, ...extra })

/** Approved, sendable template for a move (pure). */
export function selectMoveTemplate(templates = [], { move_kind, language = 'english' } = {}) {
  const lang = lower(language) === 'es' ? 'spanish' : lower(language) === 'en' ? 'english' : lower(language) || 'english'
  for (const uc of MOVE_TEMPLATE_USE_CASES[move_kind] || []) {
    for (const t of templates) {
      const id = String(t?.id ?? '').trim()
      const body = String(t?.template_body ?? t?.text ?? '').trim()
      if (!id || /^local-template:/i.test(id) || id === 'null') continue
      if (lower(t?.use_case) !== uc) continue
      if (!(t?.is_active === true || t?.active === 'Yes')) continue
      if (lower(t?.language || 'english') !== lang) continue
      const tokens = [...body.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/gi)].map((m) => m[1].toLowerCase())
      if (tokens.filter((x) => x === 'offer_price').length !== 1) continue
      if (tokens.some((x) => !ALLOWED_TOKENS.has(x))) continue
      if (extractMoneyAmounts(body.replace(/\{\{[^}]*\}\}/g, '')).length) continue // the template itself states no money
      return { id, use_case: uc, body, language: lang }
    }
  }
  return null
}

/** Forbidden-claim scan (the composer view's forbidden_claims, as text rules). */
export function forbiddenClaimViolations(text) {
  return Object.entries(FORBIDDEN_CLAIM_RE).filter(([, re]) => re.test(String(text || ''))).map(([k]) => `forbidden_claim:${k}`)
}

/**
 * @param {object} a
 * @param {'PREPARE_OFFER'|'NEGOTIATE_WITHIN_AUTHORITY'} a.outcome
 * @param {object} a.context     handleDecisionOutcome context: { thread_key, property_id, opportunity_id?, seller_request?, fact_ledger?, economics?, offer_plan?, now? }
 * @param {object} a.deps        handleDecisionOutcome deps ({ store, assessEconomics?, planOffer? })
 * @param {{ latestFor: (scope_key) => Promise<{ authorization, revoked }>, usesFor: (id, o) => Promise<{ count, has_use }> }} a.sendAuthorizations
 * @param {Array<object>} a.templates   approved sms_templates rows for the move use cases
 * @param {{ language?: string, template_context?: object, send_use_key?: string }} [a.thread]
 *        send_use_key: the durable send-budget reservation this send already holds (R5); the caller's own
 *        count is never read
 * @param {object} [a.env]
 */
export async function composeNegotiationReply({ outcome, context = {}, deps = {}, sendAuthorizations = null, templates = [], thread = {}, checkAutomationHold = null, env = process.env } = {}) {
  if (!negotiationComposerEnabled(env)) return escalate('negotiation_composer_disabled')
  // owner P0: the automation-hold registry first (fail closed); a held thread gets no draft
  const hold = await consultHold(checkAutomationHold, { threadKey: context.thread_key || null, propertyId: context.property_id || null, opportunityId: context.opportunity_id || null, capability: HOLD_CAPABILITIES.negotiation_compose })
  if (hold.held) return escalate(`automation_hold:${hold.hold_type || 'unknown'}`, { hold })
  const now = typeof context.now === 'number' ? context.now : Date.parse(context.now || '') || Date.now()
  const handled = await handleDecisionOutcome(outcome, { ...context, now }, deps)
  const view = handled.composer_view || composerView(handled.position)
  const position = handled.position
  if (view.status !== 'within_authority') {
    return escalate(view.status === 'needs_envelope' ? 'needs_envelope:route_proposed_envelope_to_operator' : `position_escalate:${(position?.escalation?.reasons || []).join(',') || 'unspecified'}`, { next: handled.next, composer_view: view })
  }
  const move = view.move
  if (!move || move.kind === 'hold' || move.amount == null) return { version: NEGOTIATION_COMPOSER_VERSION, action: 'HOLD', reason: 'our_offer_stands_no_new_message', rendered_text: null, amount: null, composer_view: view }

  // the DISTINCT send authorization
  let sk
  try { sk = scopeKey(context.thread_key, context.property_id) } catch { return escalate('scope_missing') }
  if (!sendAuthorizations?.latestFor) return escalate('send_authorization_store_unavailable', { composer_view: view })
  const latestEnv = await deps.store.latestEnvelope(sk)
  const sa = await sendAuthorizations.latestFor(sk).catch(() => ({ authorization: null, revoked: false }))
  // R5: the budget is the DURABLE use count (public.negotiation_send_authorization_uses), never a caller-supplied
  // number. A send that already holds its reservation (thread.send_use_key, consumed atomically before this call)
  // is checked against the OTHER uses; a store that cannot count uses fails closed.
  let sendsUsed = null
  if (sa?.authorization) {
    if (typeof sendAuthorizations.usesFor !== 'function') return escalate('send_authorization:send_budget_unverifiable', { composer_view: view })
    let u
    try { u = await sendAuthorizations.usesFor(sa.authorization.send_authorization_id, { excluding_use_key: thread.send_use_key || null }) } catch { return escalate('send_authorization:send_budget_unverifiable', { composer_view: view }) }
    if (thread.send_use_key && u?.has_use !== true) return escalate('send_authorization:send_use_not_reserved', { composer_view: view })
    sendsUsed = Number(u?.count)
    if (!Number.isFinite(sendsUsed)) return escalate('send_authorization:send_budget_unverifiable', { composer_view: view })
  }
  const st = sendAuthorizationStatus(sa?.authorization || null, { scope_key: sk, envelope: latestEnv?.envelope || null, envelope_meta: { revoked: latestEnv?.revoked, latest_version: latestEnv?.latest_version }, amount: move.amount, terms: view.allowed_terms, sends_used: sendsUsed ?? 0, revoked: sa?.revoked, now })
  if (!st.live) return escalate(`send_authorization:${st.reason}`, { composer_view: view })

  // an approved template only (ZERO hard-coded copy)
  const tpl = selectMoveTemplate(templates, { move_kind: move.kind, language: thread.language || 'english' })
  if (!tpl) return escalate(`no_approved_template_for_move:${move.kind}`, { composer_view: view })
  const rendered = renderTemplate({ template_text: tpl.body, context: { summary: thread.template_context || {} }, overrides: { offer_price: usd(move.amount) }, use_case: tpl.use_case })
  const text = String(rendered?.rendered_text || '').trim()
  if (!text || rendered.missing_placeholders?.length || rendered.invalid_placeholders?.length) return escalate('template_render_incomplete', { composer_view: view })

  // the seller-facing guard: only the authorized amount; no ceiling / internal numbers / comps / claims
  const guard = checkSellerFacingText(text, { position, plan: context.offer_plan || null, economics: context.economics || null, envelope: latestEnv?.envelope || null })
  const claims = forbiddenClaimViolations(text)
  const violations = [...guard.violations, ...claims]
  if (!guard.ok || claims.length) return escalate(`seller_facing_guard:${violations.join(',')}`, { composer_view: view, validation: { ok: false, violations } })

  const event = { event_type: position.move.ledger_event_type, actor: 'engine', authority: 'within_envelope', envelope_id: latestEnv.envelope.envelope_id, amount: move.amount, quote_type: position.move.quote_type || 'FORMAL_OFFER' }
  return {
    version: NEGOTIATION_COMPOSER_VERSION,
    action: 'DETERMINISTIC_REPLY',
    reason: `within_authority:${move.kind}`,
    template_use_case: tpl.use_case,
    template_id: tpl.id,
    rendered_text: text,
    amount: move.amount,
    authority_ref: { envelope_id: latestEnv.envelope.envelope_id, envelope_version: Number(latestEnv.envelope.version), send_authorization_id: sa.authorization.send_authorization_id },
    validation: { ok: true, violations: [], amounts: guard.amounts },
    composer_view: view,
    // the send path writes these BEFORE it sends (this module writes nothing)
    persist: {
      seller_offer_args: toSellerOfferArgs({ event, envelope: latestEnv.envelope, opportunity_id: context.opportunity_id || null, thread_key: context.thread_key, property_id: context.property_id }),
      ledger_event: event,
    },
  }
}

/**
 * A NegotiationAuthority (conversation-ai/pipeline/negotiation-authority.js) backed by the envelope +
 * send authorization + composer. resolveContext(pipelineCtx) → { context, thread } is injected by the
 * runtime (the pipeline ctx carries only refs). The pipeline normalizes the answer to
 * { action, reason, template_use_case, authority_ref } — the runtime that wants the rendered text calls
 * composeNegotiationReply directly.
 */
export function createEnvelopeNegotiationAuthority({ resolveContext, deps, sendAuthorizations, templatesFor, checkAutomationHold = null, env = process.env }) {
  const run = (outcome) => async (pctx) => {
    const resolved = await resolveContext(pctx).catch(() => null)
    if (!resolved?.context?.thread_key || !resolved?.context?.property_id) return { action: 'ESCALATE_TO_OPERATOR', reason: 'negotiation_context_unresolved' }
    const templates = typeof templatesFor === 'function' ? await templatesFor(resolved).catch(() => []) : []
    const r = await composeNegotiationReply({ outcome, context: resolved.context, deps, sendAuthorizations, templates, thread: resolved.thread || {}, checkAutomationHold, env })
    return { action: r.action, reason: r.reason, template_use_case: r.template_use_case || null, authority_ref: r.authority_ref ? `${r.authority_ref.envelope_id}:${r.authority_ref.send_authorization_id}` : null }
  }
  return Object.freeze({ version: NEGOTIATION_COMPOSER_VERSION, prepareOffer: run('PREPARE_OFFER'), negotiateWithinAuthority: run('NEGOTIATE_WITHIN_AUTHORITY') })
}
