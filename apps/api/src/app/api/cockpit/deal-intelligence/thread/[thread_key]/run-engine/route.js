import { NextResponse } from 'next/server.js'
import { ensureMutationAuth } from '../../../../_shared.js'
import { runAcquisitionEngineWithProgress } from '@/lib/cockpit/deal-intelligence-dossier.js'
import { getUniversalDealDossier } from '@/lib/cockpit/universal-deal-dossier-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

const ALLOWED_ORIGINS = new Set([
  'https://ops.leadcommand.ai',
  'https://nexus-dashboard.vercel.app',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
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

export async function POST(request, { params }) {
  const cors = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  const { thread_key } = await params
  const url = new URL(request.url)
  let payload = {}
  try {
    payload = await request.json()
  } catch {
    payload = {}
  }

  const property_id = clean(url.searchParams.get('property_id') || payload.property_id)
  if (!property_id) {
    return NextResponse.json({ ok: false, error: 'property_id_required' }, { status: 400, headers: cors })
  }

  const accept = request.headers.get('accept') || ''
  const wantsStream = accept.includes('application/x-ndjson') || url.searchParams.get('stream') === 'true'

  if (wantsStream) {
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        const emit = (event) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
        try {
          const result = await runAcquisitionEngineWithProgress(
            property_id,
            (progress) => emit({ ok: true, ...progress }),
            { thread_key },
          )
          const dossier = await getUniversalDealDossier({ thread_key, property_id })
          emit({ ok: true, stage: 'decision_ready', status: 'done', dossier })
          controller.close()
        } catch (error) {
          emit({ ok: false, error: error?.message || 'run_engine_failed' })
          controller.close()
        }
      },
    })
    return new Response(stream, {
      status: 200,
      headers: { ...cors, 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' },
    })
  }

  const stages = []
  try {
    const result = await runAcquisitionEngineWithProgress(
      property_id,
      (progress) => {
        stages.push(progress)
      },
      { thread_key },
    )
    const dossier = await getUniversalDealDossier({ thread_key, property_id })
    return NextResponse.json(
      { ok: true, stages, result, dossier },
      { status: 200, headers: cors },
    )
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: 'run_engine_failed', message: error?.message, stages },
      { status: 500, headers: cors },
    )
  }
}

function clean(value) {
  return String(value ?? '').trim()
}