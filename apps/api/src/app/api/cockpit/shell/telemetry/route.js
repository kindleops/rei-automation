/**
 * SHELL TELEMETRY — the desktop command rail's one read (resting metrics,
 * runtime heartbeats, and ledger events since the rail's cursor). Read-only;
 * see lib/domain/shell/shell-telemetry-service.js for every definition.
 */
import { NextResponse } from 'next/server.js'
import { getShellTelemetry } from '@/lib/domain/shell/shell-telemetry-service.js'
import { corsHeaders, ensureDashboardReadAuth } from '../../_shared.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  const headers = corsHeaders(request)
  const auth = ensureDashboardReadAuth(request)
  if (!auth.ok) {
    return NextResponse.json({ ok: false, errorType: 'auth_error', error: 'unauthorized' }, { status: auth.response?.status || 401, headers })
  }
  try {
    const since = new URL(request.url).searchParams.get('since')
    const data = await getShellTelemetry({ since })
    return NextResponse.json(data, { status: 200, headers: { ...headers, 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('shell.telemetry_failed', error)
    return NextResponse.json({ ok: false, errorType: 'query_failed', error: 'shell_telemetry_failed', message: error?.message || null, retryable: true }, { status: 500, headers })
  }
}
