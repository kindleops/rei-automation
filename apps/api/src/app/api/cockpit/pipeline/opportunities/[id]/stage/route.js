import { NextResponse } from 'next/server.js';
import { transitionOpportunityStage } from '@/lib/domain/opportunity/opportunity-service.js';
import { supabase } from '@/lib/supabase/client.js';
import { beginCorrectionCapture } from '@/lib/domain/intelligence/runtime/observation.js';
import { corsHeaders, ensureMutationAuth, unauthorizedJson } from '../../../_shared.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function PATCH(request, { params }) {
  const headers = corsHeaders(request);
  const auth = ensureMutationAuth(request);
  if (!auth.ok) return unauthorizedJson(auth.response, headers);

  try {
    const body = await request.json().catch(() => ({}));
    // IC8 correction capture (fail-open; inert unless both IC8 logging gates are on).
    const correction = await beginCorrectionCapture({
      headers: request.headers,
      source: 'route:/api/cockpit/pipeline/opportunities/[id]/stage',
      reason: typeof body?.reason === 'string' ? body.reason : null,
      load: async () => {
        const { data: before } = await supabase.from('acquisition_opportunities').select('acquisition_stage').eq('id', params.id).maybeSingle();
        return before ? [{ subject: { type: 'opportunity', id: params.id }, field: 'acquisition_stage', original: before.acquisition_stage ?? null, corrected: null }] : [];
      },
    });
    const result = await transitionOpportunityStage(params.id, body);
    if (!result.ok) {
      return NextResponse.json(result, { status: 422, headers });
    }
    correction.commit({ acquisition_stage: result.opportunity?.acquisition_stage ?? null });
    return NextResponse.json(result, { status: 200, headers });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error?.message || 'pipeline_stage_transition_failed' },
      { status: 500, headers },
    );
  }
}