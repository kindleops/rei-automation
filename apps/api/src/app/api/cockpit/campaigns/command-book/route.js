import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth } from '../../_shared.js'
import { buildCampaignCommandBook, buildCampaignReplyBook } from '@/lib/domain/campaigns/campaign-command-intel.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

function withCors(request, payload, status = 200) {
  return NextResponse.json(payload, { status, headers: corsHeaders(request) })
}

export async function OPTIONS(request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) })
}

/**
 * GET — every campaign's execution posture for Campaign Command's mission
 * rail and header: targets by state, sellers messaged / delivered, the live
 * queue, the contact window in the campaign's zone, the feeder's last word
 * and the system brakes. Read-only; cached 20 s.
 *   ?part=replies — replies per campaign (the message log, read per
 *                   campaign; cached 2 min), fetched after the book.
 */
export async function GET(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response
  const part = new URL(request.url).searchParams.get('part')
  try {
    const result = part === 'replies' ? await buildCampaignReplyBook() : await buildCampaignCommandBook()
    return withCors(request, result, 200)
  } catch (error) {
    const timedOut = error?.code === 'read_timeout'
    if (!timedOut) console.error('campaigns.command_book_failed', error)
    return withCors(request, { ok: false, error: timedOut ? 'campaign_command_book_timeout' : 'campaign_command_book_failed', message: error?.message || String(error) }, timedOut ? 503 : 500)
  }
}
