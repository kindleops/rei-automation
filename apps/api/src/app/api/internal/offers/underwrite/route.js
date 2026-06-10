import { NextResponse } from 'next/server.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request) {
  const body = await request.json().catch(() => ({}))

  return NextResponse.json({
    ok: false,
    route: 'internal/offers/underwrite',
    action: 'underwrite_preview',
    error: 'UNDERWRITE_PREVIEW_NOT_WIRED',
    message: 'Underwriting preview is not wired to a launch-safe backend service yet. Use the canonical push-to-underwriting workflow for live routing.',
    received: {
      property_id: body?.property_id ?? body?.propertyId ?? null,
      thread_key: body?.thread_key ?? body?.threadKey ?? null,
      has_payload: Boolean(body && typeof body === 'object' && Object.keys(body).length),
    },
  }, { status: 501 })
}
