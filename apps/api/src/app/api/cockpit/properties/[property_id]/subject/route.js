import { NextResponse } from 'next/server.js';
import { corsHeaders, ensureMutationAuth } from '../../../../_shared.js';
import { loadCanonicalSubjectProperty } from '@/lib/domain/comp-intelligence/canonical-subject-property.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function GET(request, { params }) {
  const cors = corsHeaders(request);
  const auth = ensureMutationAuth(request);
  if (!auth.ok) {
    return NextResponse.json(
      await auth.response.json().catch(() => ({ ok: false, error: 'unauthorized' })),
      { status: auth.response.status, headers: cors },
    );
  }

  const { property_id } = await params;
  const { searchParams } = new URL(request.url);
  const threadKey = searchParams.get('thread_key');
  const opportunityId = searchParams.get('opportunity_id');

  try {
    const result = await loadCanonicalSubjectProperty(property_id, {
      threadKey,
      opportunityId,
    });

    return NextResponse.json(
      {
        ok: result.ok,
        data: result.subject,
        error: result.error ?? null,
        queryMs: result.queryMs,
      },
      { status: result.ok ? 200 : 404, headers: cors },
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: 'subject_load_failed', message: error?.message },
      { status: 500, headers: cors },
    );
  }
}