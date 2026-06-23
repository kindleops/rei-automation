import { NextResponse } from 'next/server.js';
import { fetchCalendarNexusEvents, CALENDAR_EVENT_SOURCE_INVENTORY } from '@/lib/domain/calendar/calendar-nexus-service.js';
import { corsHeaders, ensureMutationAuth, unauthorizedJson } from '../_shared.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function GET(request) {
  const headers = corsHeaders(request);
  const auth = ensureMutationAuth(request);
  if (!auth.ok) return unauthorizedJson(auth.response, headers);

  try {
    const { searchParams } = new URL(request.url);
    const layers = searchParams.get('layers');
    const result = await fetchCalendarNexusEvents({
      start_date: searchParams.get('start_date') || searchParams.get('startDate'),
      end_date: searchParams.get('end_date') || searchParams.get('endDate'),
      master_owner_id: searchParams.get('master_owner_id') || searchParams.get('seller_id'),
      property_id: searchParams.get('property_id'),
      thread_key: searchParams.get('thread_key') || searchParams.get('thread_id'),
      market: searchParams.get('market'),
      campaign_id: searchParams.get('campaign_id'),
      workflow_definition_id: searchParams.get('workflow_definition_id'),
      overdue_only: searchParams.get('overdue_only') === 'true',
      layers: layers ? layers.split(',').map((v) => v.trim()).filter(Boolean) : null,
    });

    return NextResponse.json({
      ...result,
      source_inventory: CALENDAR_EVENT_SOURCE_INVENTORY,
    }, { status: 200, headers });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error?.message || 'calendar_events_fetch_failed' },
      { status: 500, headers },
    );
  }
}