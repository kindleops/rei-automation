/**
 * POST /api/cockpit/deal-intelligence/decision/run?property_id=…[&thread_key=…]
 *
 * "Analyze this property" for the Deal Intelligence decision room: the SAME
 * canonical engine run as the Inbox's run-engine route
 * (runAcquisitionEngineWithProgress → ensurePropertyAcquisitionDecision,
 * force) — scoped to a PROPERTY, so a property opened from the Map, Pipeline
 * or a search can be analyzed without a conversation. Nothing else is
 * written; nothing is sent.
 *
 * Why it exists (2026-10-10): the decision room could only run the engine
 * through /thread/[thread_key]/run-engine, so (1) a property with no linked
 * conversation showed "A conversation is needed to run the engine" and could
 * not be analyzed at all, and (2) an engine that REPORTED failure
 * (ensured.status = engine_failed) still closed the stream as
 * `decision_ready … done`, which the client read as success — the run
 * "finished" and the property stayed unpriced with no reason shown.
 *
 * Stream (application/x-ndjson): progress events, then exactly one terminal
 * event — { ok: true, stage: 'decision_ready', decision_status } or
 * { ok: false, error, decision_status }. The client re-reads the decision
 * itself; no dossier is rebuilt here.
 */
import { NextResponse } from 'next/server.js'
import { runAcquisitionEngineWithProgress } from '@/lib/cockpit/deal-intelligence-dossier.js'
import { terminalEvent } from '@/lib/domain/deal-intelligence/engine-run-events.js'
import { corsHeaders, ensureMutationAuth } from '../../../_shared.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

const SAFE = /^[\w+:.@-]{1,120}$/
const clean = (v) => String(v ?? '').trim()

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function POST(request) {
  const headers = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  const url = new URL(request.url)
  let payload = {}
  try { payload = await request.json() } catch { payload = {} }
  const propertyId = clean(url.searchParams.get('property_id') || payload.property_id)
  const threadKey = clean(url.searchParams.get('thread_key') || payload.thread_key)
  if (!propertyId) return NextResponse.json({ ok: false, error: 'property_id_required' }, { status: 400, headers })
  if (!SAFE.test(propertyId) || (threadKey && !SAFE.test(threadKey))) return NextResponse.json({ ok: false, error: 'invalid_subject' }, { status: 400, headers })

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
      try {
        const result = await runAcquisitionEngineWithProgress(
          propertyId,
          // progress only; the engine's own decision_ready is replaced by the honest terminal event
          (progress) => { if (progress?.stage !== 'decision_ready') emit({ ok: true, ...progress }) },
          threadKey ? { thread_key: threadKey } : {},
        )
        emit(terminalEvent(result))
      } catch (error) {
        console.error('deal_intelligence.decision_run_failed', error)
        emit({ ok: false, error: error?.message || 'run_engine_failed', decision_status: null })
      }
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { ...headers, 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' } })
}
