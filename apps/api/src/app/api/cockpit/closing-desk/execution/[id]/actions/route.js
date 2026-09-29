import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth, unauthorizedJson } from '../../../_shared.js'
import * as authority from '@/lib/domain/closings/closing-authority.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

/**
 * POST /api/cockpit/closing-desk/execution/:id/actions   { action, ...fields }
 *
 * The ONLY write path Closing Desk uses. Every action is one authoritative
 * server operation (closing-authority.js) — the client never updates a closing
 * case, settlement, stage or calendar row itself.
 *
 * Actor = the operator the Cloudflare Worker verified (x-ops-user-id, set
 * after the Supabase session + allowlist check, overwriting any client value).
 * The body can never choose who the actor is.
 */
const ACTIONS = {
  record_emd_receipt: (b, id, actor) => authority.recordEmdReceipt({ ...b, closingCaseId: id, actor }),
  verify_emd: (b, id, actor) => authority.verifyEmdReceipt({ ...b, actor }),
  waive_buyer_emd: (b, id, actor) => authority.waiveBuyerEmd({ ...b, closingCaseId: id, actor }),
  record_contract_emd_deposit: (b, id, actor) => authority.recordContractEmdDeposit({ ...b, closingCaseId: id, actor }),
  record_buyer_offer: (b, id, actor) => authority.recordBuyerOffer({ ...b, closingCaseId: id, actor }),
  select_buyer: (b, id, actor) => authority.selectBuyerOffer({ ...b, closingCaseId: id, actor }),
  record_buyer_agreement: (b, id, actor) => authority.recordBuyerAgreementStatus({ ...b, closingCaseId: id, actor }),
  commit_buyer: (b, id, actor) => authority.commitBuyer({ ...b, closingCaseId: id, actor }),
  acknowledge_title: (b, id, actor) => authority.acknowledgeTitleOrder({ ...b, closingCaseId: id, actor }),
  record_title_commitment: (b, id, actor) => authority.recordTitleCommitment({ ...b, closingCaseId: id, actor }),
  open_title_issue: (b, id, actor) => authority.openTitleIssue({ ...b, closingCaseId: id, actor }),
  update_title_issue: (b, id, actor) => authority.updateTitleIssue({ ...b, actor }),
  record_clear_to_close: (b, id, actor) => authority.recordClearToClose({ ...b, closingCaseId: id, actor }),
  set_closing_date: (b, id, actor) => authority.setClosingDate({ ...b, closingCaseId: id, actor }),
  record_settlement: (b, id, actor) => authority.recordSettlement({ ...b, closingCaseId: id, actor }),
  finalize_closing: (b, id, actor) => authority.finalizeClosing({ closingCaseId: id, actor, source: 'closing_desk' }),
  terminate_closing: (b, id, actor) => authority.terminateClosing({ ...b, closingCaseId: id, actor }),
  set_automation_paused: (b, id, actor) => authority.setAutomationPaused({ ...b, closingCaseId: id, actor }),
  guard: (b, id) => authority.getClosingGuard(id),
}

export async function POST(request, { params }) {
  const headers = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return unauthorizedJson(auth.response, headers)
  try {
    const { id } = await params
    const body = await request.json().catch(() => ({}))
    const run = ACTIONS[String(body.action || '')]
    if (!run) return NextResponse.json({ ok: false, code: 'UNKNOWN_ACTION', actions: Object.keys(ACTIONS) }, { status: 400, headers })
    const { actor: _ignored, ...fields } = body
    const actor = String(request.headers.get('x-ops-user-id') || '').trim() || 'operator'
    const result = await run(fields, decodeURIComponent(String(id || '')), actor)
    const status = result.ok ? 200 : result.code === 'CLOSING_NOT_FOUND' ? 404 : 422
    return NextResponse.json({ ok: Boolean(result.ok), data: result }, { status, headers })
  } catch (error) {
    // DB constraints are the last line (e.g. SETTLEMENT_IMMUTABLE, CLOSING_BLOCKED): surface their message.
    const message = String(error?.message || 'closing_action_failed')
    const code = /SETTLEMENT_IMMUTABLE|CLOSING_BLOCKED/.exec(message)?.[0] || (error?.code === '23514' ? 'CONSTRAINT_VIOLATION' : 'CLOSING_ACTION_FAILED')
    return NextResponse.json({ ok: false, data: { ok: false, code, message } }, { status: code === 'CLOSING_ACTION_FAILED' ? 500 : 422, headers })
  }
}
