import { NextResponse } from 'next/server.js';
import { createManualCalendarEvent } from '@/lib/domain/calendar/calendar-nexus-service.js';
import { corsHeaders, ensureMutationAuth, unauthorizedJson } from '../_shared.js';
import { parseJsonSafe } from '../../../_shared.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function POST(request) {
  const headers = corsHeaders(request);
  const auth = ensureMutationAuth(request);
  if (!auth.ok) return unauthorizedJson(auth.response, headers);

  try {
    const payload = await parseJsonSafe(request);
    const result = await createManualCalendarEvent(payload);
    const status = result.ok ? 200 : 400;
    return NextResponse.json(result, { status, headers });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error?.message || 'manual_event_create_failed' },
      { status: 500, headers },
    );
  }
}