import { NextResponse } from 'next/server.js'
import { requireOpsDashboardAuth } from '@/lib/security/dashboard-auth.js'

export function parseJsonSafe(request) {
  return request.json().catch(() => ({}))
}

export function responseFromResult(result, status = 200) {
  return NextResponse.json(result, { status })
}

export function ensureMutationAuth(request) {
  const auth = requireOpsDashboardAuth(request)
  if (!auth.authorized) {
    return { ok: false, response: auth.response }
  }
  return { ok: true, auth: auth.auth }
}
