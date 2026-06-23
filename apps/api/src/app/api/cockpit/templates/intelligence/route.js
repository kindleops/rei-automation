import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, corsHeaders } from '../../_shared.js'
import {
  fetchTemplateIntelligence,
  fetchTemplateIntelligenceSummary,
} from '@/lib/domain/templates/template-intelligence-service.js'
import { DEFAULT_AUTOPILOT_MODE } from '@/lib/domain/templates/template-intelligence-contract.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function parseFilters(searchParams) {
  const num = (key) => {
    const v = searchParams.get(key)
    return v != null && v !== '' ? Number(v) : undefined
  }
  return {
    query: searchParams.get('query') ?? undefined,
    stage: searchParams.get('stage') ?? undefined,
    touch_number: num('touch'),
    follow_up_number: num('follow_up'),
    use_case: searchParams.get('use_case') ?? undefined,
    language: searchParams.get('language') ?? undefined,
    persona: searchParams.get('persona') ?? undefined,
    asset_type: searchParams.get('asset_type') ?? undefined,
    market: searchParams.get('market') ?? undefined,
    campaign: searchParams.get('campaign') ?? undefined,
    sender: searchParams.get('sender') ?? undefined,
    agent: searchParams.get('agent') ?? undefined,
    lifecycle: searchParams.get('lifecycle') ?? undefined,
    active_state: searchParams.get('active_state') ?? undefined,
    rotation_state: searchParams.get('rotation_state') ?? undefined,
    performance_label: searchParams.get('performance_label') ?? undefined,
    confidence: searchParams.get('confidence') ?? undefined,
    risk_flag: searchParams.get('risk_flag') ?? undefined,
    source: searchParams.get('source') ?? undefined,
  }
}

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  const cors = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) {
    return NextResponse.json(
      await auth.response.json().catch(() => ({ ok: false, error: 'unauthorized' })),
      { status: auth.response.status, headers: cors },
    )
  }

  try {
    const { searchParams } = new URL(request.url)
    const summary = searchParams.get('summary') === '1'
    const page = Math.max(0, parseInt(searchParams.get('page') ?? '0', 10))
    const pageSize = Math.min(5000, Math.max(1, parseInt(searchParams.get('page_size') ?? '500', 10)))
    const sort = searchParams.get('sort') ?? 'template_name'
    const sortDir = searchParams.get('sort_dir') ?? 'asc'
    const range = searchParams.get('range') ?? searchParams.get('time_window') ?? '7d'
    const autopilotMode = searchParams.get('autopilot_mode') ?? DEFAULT_AUTOPILOT_MODE
    const filters = parseFilters(searchParams)

    const payload = summary
      ? await fetchTemplateIntelligenceSummary({ page, pageSize, sort, sortDir, filters, range, autopilotMode })
      : await fetchTemplateIntelligence({ page, pageSize, sort, sortDir, filters, range, autopilotMode })

    return NextResponse.json(payload, { status: 200, headers: cors })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500, headers: cors },
    )
  }
}