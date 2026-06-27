import { NextResponse } from 'next/server.js';
import { ensureMutationAuth, corsHeaders } from '../../_shared.js';
import { supabase } from '@/lib/supabase/client.js';
import { patchUniversalLeadState } from '@/lib/domain/lead-state/patch-universal-lead-state.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function clean(value) {
  return String(value ?? '').trim();
}

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

    const result = await patchUniversalLeadState({
      threadKey,
      patch,
      dryRun,
      supabase,
      meta: {
        operator_id: body.operator_id || body.operatorId || auth.userId || null,
        updated_by: body.updated_by || body.updatedBy || auth.userId || null,
        source_view: body.source_view || body.sourceView || null,
        reason: body.reason || null,
        change_source: body.change_source || body.changeSource || 'manual',
        executed_next_action: executeNextAction,
        manual_stage_lock: body.manual_stage_lock,
        manual_temperature_lock: body.manual_temperature_lock,
        resume_automatic_scoring: body.resume_automatic_scoring === true,
        metadata: body.metadata || {},
      },
    });

    if (!result.ok) {
      return NextResponse.json(result, { status: 400, headers: cors });
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