/**
 * BUYER OUTREACH — PREFLIGHT, COMMIT, AND THE TRUTH ABOUT WHAT HAPPENED.
 *
 * GET   → the current outreach state for this property, straight from
 *         `buyer_outreach_targets`. This is what the mobile surface renders
 *         after submitting, so the operator sees the state the system actually
 *         holds rather than an optimistic local echo (§9).
 *
 * POST  → `dry_run: true` (the default) returns the eligibility verdict and
 *         writes nothing; `dry_run: false` materializes targets and queues
 *         them through the canonical send queue.
 *
 * THE RECIPIENT IS NEVER TAKEN FROM THE REQUEST. The body names buyers by
 * `buyer_key`; the destination is resolved server-side from `buyer_contacts_v2`
 * and any phone number in the payload is discarded. A surface bug or a stale
 * client must not be able to direct a live SMS at an arbitrary number.
 *
 * DEFAULTING TO A DRY RUN IS DELIBERATE. A caller that omits the field gets the
 * preflight, not a send.
 */
import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, parseJsonSafe } from '../../../../../_shared.js'
import { supabase } from '@/lib/supabase/client.js'
import { materializeBuyerOutreach } from '@/lib/domain/buyers/materialize-buyer-outreach.js'
import { resolveBuyerContacts } from '@/lib/domain/buyers/resolve-buyer-contact.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_ORIGINS = new Set([
  'https://ops.leadcommand.ai',
  'https://nexus-dashboard.vercel.app',
  'http://localhost:5173',
])

function resolveAllowedOrigin(origin) {
  if (!origin) return null
  if (ALLOWED_ORIGINS.has(origin)) return origin
  if (/^https:\/\/nexus-dashboard(-[a-z0-9]+)*\.vercel\.app$/.test(origin)) return origin
  return null
}

function corsHeaders(request) {
  const origin = request.headers.get('origin')
  const allowedOrigin = resolveAllowedOrigin(origin)
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-ops-dashboard-secret, X-Requested-With, Accept',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
  if (allowedOrigin) headers['Access-Control-Allow-Origin'] = allowedOrigin
  return headers
}

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request, { params }) {
  const cors = corsHeaders(request)
  const { property_id } = await params

  const { data, error } = await supabase
    .from('buyer_outreach_targets')
    .select(
      'id,buyer_key,buyer_name,to_phone_number,touch_number,status,blocked_reason,' +
      'scheduled_at,provider_message_id,delivery_status,send_queue_key,created_at,updated_at'
    )
    .eq('property_id', property_id)
    .order('created_at', { ascending: false })
    .limit(200)

  if (error) {
    // An unreadable table is reported as unreadable. It is not "no outreach".
    return NextResponse.json(
      { ok: false, error: 'buyer_outreach_unreadable', detail: error.message },
      { status: 503, headers: cors },
    )
  }

  return NextResponse.json({ ok: true, data: { targets: data || [] } }, { status: 200, headers: cors })
}

export async function POST(request, { params }) {
  const cors = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401, headers: cors })
  }

  const { property_id } = await params
  const body = await parseJsonSafe(request)
  const dry_run = body?.dry_run !== false

  const selected = Array.isArray(body?.buyers) ? body.buyers : []
  if (selected.length === 0) {
    return NextResponse.json(
      { ok: false, error: 'no_buyers_selected' },
      { status: 400, headers: cors },
    )
  }

  const resolved = await resolveBuyerContacts(selected, { supabase })
  if (!resolved.ok) {
    return NextResponse.json(
      { ok: false, error: resolved.reason, detail: resolved.detail || null },
      { status: 503, headers: cors },
    )
  }

  try {
    const result = await materializeBuyerOutreach(
      {
        property_id,
        buyers: resolved.buyers,
        message_body: body?.message_body ?? null,
        template_id: body?.template_id ?? null,
        scheduled_at: body?.scheduled_at ?? null,
        touch_number: body?.touch_number ?? 1,
        dry_run,
      },
      { supabase },
    )

    return NextResponse.json(
      { ok: result.ok !== false, data: result },
      { status: result.ok === false ? 409 : 200, headers: cors },
    )
  } catch (error) {
    console.error('[BUYER_OUTREACH_ERROR]', { property_id, error: error?.message })
    return NextResponse.json(
      { ok: false, error: 'buyer_outreach_failed', detail: error?.message || null },
      { status: 500, headers: cors },
    )
  }
}
