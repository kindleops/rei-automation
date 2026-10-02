/**
 * Shared plumbing for the Signal Center cockpit routes: operator auth (Worker
 * session + OPS_ALLOWED_USER_IDS allowlist via ensureMutationAuth), the operator
 * id the Worker stamps (x-ops-user-id), and one error shape.
 */
import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth } from '../_shared.js'
import { operatorIdFromHeaders } from '@/lib/domain/intelligence/corrections/corrections.js'
import { SignalError } from '@/lib/domain/signals/signal-service.js'

export function guard(request) {
  const headers = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return { headers, denied: auth.response }
  return { headers, operatorId: operatorIdFromHeaders(request.headers) }
}

export const ok = (data, headers) => NextResponse.json(data, { status: 200, headers: { ...headers, 'Cache-Control': 'no-store' } })

export function fail(error, headers, label) {
  if (error instanceof SignalError) {
    return NextResponse.json({ ok: false, error: error.code, message: error.message }, { status: error.status, headers })
  }
  console.error(label, error?.message || error)
  return NextResponse.json({ ok: false, error: 'signals_failed', message: 'Signal Center could not be read right now.', retryable: true }, { status: 500, headers })
}
