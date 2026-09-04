import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, corsHeaders, parseJsonSafe } from '../../_shared.js'
import { buildBulkFollowUpPlan } from '@/lib/domain/inbox/bulk-follow-up-plan.js'
import { runInboxAction } from '@/lib/cockpit/cockpit-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

/**
 * Bulk "Conversation Restart" follow-ups.
 *
 * mode=preview  -> eligibility + rendered examples + per-recipient schedule. Writes nothing.
 * mode=schedule -> routes EACH recipient through the canonical schedule-reply
 *                  action, so containment, suppression, contact windows and the
 *                  queue model all apply exactly as they do for a single send.
 *                  There is no bulk bypass.
 */
export async function POST(request) {
  const cors = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return withAuthCors(request, auth.response)

  const payload = await parseJsonSafe(request)
  const mode = String(payload?.mode || 'preview').toLowerCase()
  const threadKeys = Array.isArray(payload?.thread_keys) ? payload.thread_keys : []
  const agentName = payload?.agent_name || null

  try {
    const plan = await buildBulkFollowUpPlan({ threadKeys, agentName })
    if (!plan.ok) return NextResponse.json(plan, { status: 400, headers: cors })

    if (mode === 'preview') {
      return NextResponse.json(plan, { status: 200, headers: cors })
    }

    if (mode !== 'schedule') {
      return NextResponse.json({ ok: false, error: 'unsupported_mode' }, { status: 400, headers: cors })
    }

    const results = []
    for (const recipient of plan.recipients) {
      if (!recipient.eligible) {
        results.push({ thread_key: recipient.thread_key, ok: false, reason: recipient.reason, skipped: true })
        continue
      }
      // Canonical single-recipient path. Each call resolves its OWN schedule.
      const result = await runInboxAction({
        action: 'schedule-reply',
        payload: {
          thread_key: recipient.thread_key,
          to_phone_number: recipient.thread_key,
          from_phone_number: payload?.from_phone_number || null,
          message_body: recipient.message_body,
          scheduled_for: recipient.schedule.scheduled_for_utc,
          timezone: recipient.schedule.timezone,
          // Lineage: persisted so template performance can be attributed later.
          template_id: recipient.template_id,
          selected_template_id: recipient.template_id,
          template_source: 'fus2_bulk_conversation_restart',
          use_case_template: 'reengagement',
          seller_first_name: recipient.seller_name,
          agent_name: recipient.agent_name,
          property_address: recipient.property_address,
          source: 'inbox_bulk_follow_up',
          dry_run: false,
        },
      })
      results.push({
        thread_key: recipient.thread_key,
        ok: result?.ok === true,
        reason: result?.reason || null,
        template_id: recipient.template_id,
        effective_send_at_utc: result?.effective_send_at_utc || null,
        effective_local_label: result?.effective_local_label || null,
      })
    }

    const scheduled = results.filter((r) => r.ok)
    return NextResponse.json({
      ok: scheduled.length > 0,
      label: plan.label,
      scheduled_count: scheduled.length,
      failed_count: results.length - scheduled.length,
      results,
    }, { status: 200, headers: cors })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error?.message || 'bulk_follow_up_failed' },
      { status: 500, headers: cors },
    )
  }
}

function withAuthCors(request, response) {
  const headers = corsHeaders(request)
  for (const [key, value] of Object.entries(headers)) response.headers.set(key, value)
  return response
}
