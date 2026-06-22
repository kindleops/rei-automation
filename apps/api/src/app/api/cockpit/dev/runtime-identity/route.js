import { NextResponse } from 'next/server.js'
import { corsHeaders } from '../../_shared.js'
import { buildRuntimeIdentity, isRuntimeIdentityExposed } from '@/lib/dev/runtime-identity.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function withCors(request, payload, status = 200) {
  const headers = corsHeaders(request)
  return NextResponse.json(payload, { status, headers })
}

export async function OPTIONS(request) {
  const headers = corsHeaders(request)
  return new Response(null, { status: 204, headers })
}

export async function GET(request) {
  if (!isRuntimeIdentityExposed()) {
    return withCors(request, { ok: false, error: 'not_found' }, 404)
  }

  const identity = buildRuntimeIdentity({
    appName: 'nexus-api',
    cwd: process.cwd(),
    port: Number(process.env.PORT || 3000),
  })

  return withCors(request, identity, 200)
}