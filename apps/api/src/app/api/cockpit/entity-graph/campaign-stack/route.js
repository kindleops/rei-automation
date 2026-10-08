/**
 * ENTITY GRAPH → CAMPAIGN · STACKED COHORTS.
 *
 *   GET                         the drafts a cohort can be stacked into
 *   POST { dry_run: true, … }   counts only (already present / ready / held / ineligible)
 *   POST { … }                  pins the eligible properties on a DRAFT (new or existing)
 *
 * Writes only a draft's targeting definition — never targets, status, a
 * schedule, a launch or send_queue. See entity-graph-campaign-stack.js.
 */
import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth, parseJsonSafe } from '../../_shared.js'
import { StackRefusal, listStackableDrafts, stackEntityGraphCohort } from '@/lib/domain/entity-graph/entity-graph-campaign-stack.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

function refuse(request, error) {
  const headers = corsHeaders(request)
  if (error instanceof StackRefusal) {
    return NextResponse.json({ ok: false, error: error.code, message: error.message, ...error.extra }, { status: error.status, headers })
  }
  if (error?.code === 'unsupported_entity_graph_filters') {
    return NextResponse.json({ ok: false, error: error.code, unsupported_filters: error.unsupported_filters || [] }, { status: 422, headers })
  }
  console.error('entity_graph.campaign_stack_failed', error)
  return NextResponse.json({ ok: false, error: 'entity_graph_campaign_stack_failed', message: error?.message || null }, { status: 500, headers })
}

export async function GET(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response
  try {
    return NextResponse.json({ ok: true, drafts: await listStackableDrafts() }, { status: 200, headers: corsHeaders(request) })
  } catch (error) {
    return refuse(request, error)
  }
}

export async function POST(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response
  try {
    const body = (await parseJsonSafe(request)) || {}
    const result = await stackEntityGraphCohort(body)
    return NextResponse.json(result, { status: 200, headers: corsHeaders(request) })
  } catch (error) {
    return refuse(request, error)
  }
}
