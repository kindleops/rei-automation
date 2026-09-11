import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, corsHeaders, parseJsonSafe } from '../../_shared.js'
import { buildBulkFollowUpPlan } from '@/lib/domain/inbox/bulk-follow-up-plan.js'
import { runInboxAction } from '@/lib/cockpit/cockpit-service.js'
import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js'

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

  try {
    // No agent override is accepted: {{agent_name}} is the seller's assigned agent.
    const plan = await buildBulkFollowUpPlan({ threadKeys })
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
          // Routing authority is server-side: the sheet never manufactures a
          // sending line. Resolved per recipient from conversation continuity.
          from_phone_number: recipient.from_phone_number,
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
    const failed = results.filter((r) => !r.ok && !r.skipped)

    // TELL THE THREAD IT IS SCHEDULED.
    //
    // Writing the send_queue row alone left inbox_thread_state untouched, so a
    // successful bulk schedule was indistinguishable from doing nothing: the
    // Priority chip never moved and the Scheduled tab stayed empty.
    //
    // MEASURED 2026-09-11: the operator scheduled 16 follow-ups; all 16 rows
    // landed in send_queue with queue_status='scheduled' and a future
    // scheduled_for, while all 16 threads still read inbox_bucket='priority'
    // with next_scheduled_for = NULL.
    //
    // next_scheduled_for is the column built for exactly this, and using it
    // rather than overwriting inbox_bucket is deliberate: the bucket is the
    // classifier's opinion about the CONVERSATION, and a pending send is a
    // separate, temporary fact. Stamping it here lets the read path move the
    // thread out of the operational buckets until the send fires, after which
    // the timestamp falls into the past and the thread returns to whatever
    // bucket it genuinely belongs in - with nothing to unwind.
    if (scheduled.length > 0) {
      try {
        const supabase = getDefaultSupabaseClient()
        if (supabase) {
          await Promise.all(scheduled.map((row) => {
            const dueAt = row.effective_send_at_utc
            if (!row.thread_key || !dueAt) return Promise.resolve()
            return supabase
              .from('inbox_thread_state')
              .update({ next_scheduled_for: dueAt, updated_at: new Date().toISOString() })
              .eq('thread_key', row.thread_key)
          }))
        }
      } catch {
        // The sends are already queued and are the thing that matters. A failure
        // to stamp the marker must not turn a successful schedule into an error.
      }
    }

    // Surface WHY nothing scheduled. Without this the client could only say
    // "refused", which is indistinguishable from a bug -- an operator hitting a
    // deliberate containment brake deserves to be told that is what happened.
    const reasons = [...new Set(failed.map((r) => r.reason).filter(Boolean))]
    const blocked_reason = scheduled.length === 0 && reasons.length === 1 ? reasons[0] : null

    return NextResponse.json({
      ok: scheduled.length > 0,
      label: plan.label,
      scheduled_count: scheduled.length,
      failed_count: results.length - scheduled.length,
      blocked_reason,
      failure_reasons: reasons,
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
