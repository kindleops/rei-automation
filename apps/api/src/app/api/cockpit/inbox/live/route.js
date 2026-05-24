import { NextResponse } from 'next/server.js'
import { ensureMutationAuth } from '../../_shared.js'
import { getLiveInbox } from '@/lib/domain/inbox/live-inbox-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return withCors(request, auth.response)
  const { searchParams } = new URL(request.url)
  const data = await getLiveInbox(Object.fromEntries(searchParams.entries()))
  return withCors(request, NextResponse.json({ ok: true, action: 'inbox-live', diagnostics: data }, { status: 200 }))
}

export async function OPTIONS(request) {
  return handleOptionsResponse(request);
}
