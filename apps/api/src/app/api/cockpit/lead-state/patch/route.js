import { NextResponse } from 'next/server.js';
import { ensureMutationAuth, corsHeaders } from '../../_shared.js';
import { supabase } from '@/lib/supabase/client.js';
import { patchUniversalLeadState } from '@/lib/domain/lead-state/patch-universal-lead-state.js';
import { buildOperatorSuppressionEvidence } from '@/lib/domain/lead-state/suppression-evidence.js';
import { beginCorrectionCapture } from '@/lib/domain/intelligence/runtime/observation.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function clean(value) {
  return String(value ?? '').trim();
}

// IC8: the operator-correctable classifications on inbox_thread_state (stage,
// status/bucket, intent disposition, temperature, contactability, next action).
const IC8_CORRECTION_FIELDS = ['lifecycle_stage', 'operational_status', 'lead_temperature', 'disposition', 'contactability_status', 'next_action'];

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function PATCH(request) {
  const cors = corsHeaders(request);
  const auth = ensureMutationAuth(request);
  if (!auth.ok) return auth.response;

  try {
    const body = await request.json();
    const threadKey = clean(body.thread_key || body.threadKey);
    const patch = body.patch && typeof body.patch === 'object' ? body.patch : body;
    const dryRun = ['1', 'true', 'yes'].includes(clean(body.dry_run || body.dryRun).toLowerCase());
    const executeNextAction = body.execute_next_action === true || body.executeNextAction === true;

    // Suppression evidence is built SERVER-SIDE from the authenticated session
    // and is never read from the request body — a caller must not be able to
    // mint its own authority to silence a seller. This route's auth is an
    // ops-dashboard shared-secret/session gate rather than a per-user identity,
    // so the recorded actor is that session; any client-supplied operator id is
    // kept only as a non-authoritative hint in the audit metadata.
    const operatorActor =
      clean(auth.auth?.identity_label) || clean(auth.auth?.via) || 'cockpit_lead_state_patch';
    const changeSource = body.change_source || body.changeSource || 'manual';
    const suppressionEvidence = buildOperatorSuppressionEvidence({
      actor: operatorActor,
      reason: body.reason || null,
      source_authority: 'cockpit_lead_state_patch',
    });

    // IC8 correction capture (fail-open; inert unless both IC8 logging gates
    // are on, and only for manual, non-dry-run patches).
    const correction = dryRun || clean(changeSource).toLowerCase() !== 'manual' || !threadKey
      ? { commit: () => ({ scheduled: 0 }) }
      : await beginCorrectionCapture({
        headers: request.headers,
        source: 'route:/api/cockpit/lead-state/patch',
        reason: body.reason || null,
        load: async () => {
          const { data: before } = await supabase.from('inbox_thread_state').select(IC8_CORRECTION_FIELDS.join(',')).eq('thread_key', threadKey).maybeSingle();
          return IC8_CORRECTION_FIELDS.map((field) => ({ subject: { type: 'thread', id: threadKey }, field, original: before?.[field] ?? null, corrected: undefined, metadata: { source_view: clean(body.source_view || body.sourceView) || null } }));
        },
      });

    const result = await patchUniversalLeadState({
      threadKey,
      patch,
      dryRun,
      supabase,
      meta: {
        // Left as-is deliberately: operator_id feeds operator_entity_preferences,
        // so substituting the session label here would create preference rows
        // keyed on a shared secret. The suppression actor travels separately.
        operator_id: body.operator_id || body.operatorId || auth.userId || null,
        updated_by: body.updated_by || body.updatedBy || auth.userId || null,
        source_view: body.source_view || body.sourceView || null,
        reason: body.reason || null,
        change_source: changeSource,
        executed_next_action: executeNextAction,
        manual_stage_lock: body.manual_stage_lock,
        manual_temperature_lock: body.manual_temperature_lock,
        resume_automatic_scoring: body.resume_automatic_scoring === true,
        suppression_evidence: suppressionEvidence,
        // Lifting a binding suppression is an operator-only act. The console is
        // that authority, but only when the request is actually labelled as a
        // manual operator action — never under an automation change_source.
        suppression_clearance:
          suppressionEvidence && clean(changeSource).toLowerCase() === 'manual'
            ? { type: 'operator_release', actor: operatorActor }
            : null,
        metadata: {
          ...(body.metadata && typeof body.metadata === 'object' ? body.metadata : {}),
          suppression_actor: operatorActor,
          operator_id_hint: body.operator_id || body.operatorId || null,
        },
      },
    });

    if (!result.ok) {
      return NextResponse.json(result, { status: 400, headers: cors });
    }
    if (!result.dry_run) {
      const written = new Set(result.realtime_event?.fields || []);
      correction.commit(Object.fromEntries(IC8_CORRECTION_FIELDS.filter((f) => written.has(f)).map((f) => [f, result.row?.[f] ?? null])));
    }

    return NextResponse.json({
      ok: true,
      action: 'patch_universal_lead_state',
      ...result,
    }, { status: 200, headers: cors });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error?.message || String(error),
    }, { status: 500, headers: cors });
  }
}