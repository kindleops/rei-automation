import { NextResponse } from 'next/server.js'
import { ensureMutationAuth } from '../../_shared.js'
import { loadThreadContext } from '@/lib/domain/inbox/thread-context-service.js'
import { supabase } from '@/lib/supabase/client.js'

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
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-ops-dashboard-secret, X-Requested-With, Accept',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
  if (allowedOrigin) headers['Access-Control-Allow-Origin'] = allowedOrigin
  return headers
}

function clean(value) {
  return String(value ?? '').trim()
}

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  const cors = corsHeaders(request)
  const startedAt = Date.now()
  const auth = ensureMutationAuth(request)
  if (!auth.ok) {
    return NextResponse.json(
      await auth.response.json().catch(() => ({ ok: false, error: 'unauthorized' })),
      { status: auth.response.status, headers: cors },
    )
  }

  const { searchParams } = new URL(request.url)
  const thread_key = clean(searchParams.get('thread_key'))

  if (!thread_key) {
    return NextResponse.json(
      {
        ok: true,
        degraded: true,
        error_code: 'missing_thread_key',
        error: 'missing_thread_key',
        action: 'thread-dossier',
        diagnostics: { queryMs: Date.now() - startedAt, sourceUsed: null },
      },
      { status: 200, headers: cors },
    )
  }

  try {
    const contextPayload = await loadThreadContext({ thread_key, supabase })
    const safeDiagnostics = contextPayload && typeof contextPayload === 'object' ? contextPayload : {}
    const selected = safeDiagnostics.context?.selected_thread || {}
    let prospects = Array.isArray(selected.prospects) ? selected.prospects : []
    let properties = Array.isArray(selected.properties) ? selected.properties : []
    let masterOwners = Array.isArray(selected.master_owners) ? selected.master_owners : []

    if (prospects.length === 0 || properties.length === 0 || masterOwners.length === 0) {
      const { data: enrichedRows } = await supabase
        .from('canonical_inbox_threads')
        .select('*')
        .eq('thread_key', thread_key)
        .limit(1)
      const row = Array.isArray(enrichedRows) && enrichedRows.length > 0 ? enrichedRows[0] : null
      if (row) {
        if (prospects.length === 0) {
          prospects = [{
            thread_key,
            prospect_id: row.prospect_id || null,
            prospect_full_name: row.prospect_full_name || null,
            best_phone: row.best_phone || null,
            language: row.filter_language || row.language_preference || null,
            seller_state: row.seller_state || null,
          }]
        }
        if (properties.length === 0) {
          properties = [{
            thread_key,
            property_id: row.property_id || null,
            property_address_full: row.property_address_full || row.property_address || null,
            property_type: row.property_type || null,
            beds: row.beds ?? null,
            baths: row.baths ?? null,
            sqft: row.sqft ?? null,
            year_built: row.year_built ?? null,
            estimated_value: row.estimated_value ?? null,
          }]
        }
        if (masterOwners.length === 0) {
          masterOwners = [{
            thread_key,
            master_owner_id: row.master_owner_id || null,
            owner_display_name: row.owner_display_name || row.owner_name || null,
            portfolio_total_value: row.portfolio_total_value ?? null,
            portfolio_total_equity: row.portfolio_total_equity ?? null,
            portfolio_total_loan_balance: row.portfolio_total_loan_balance ?? null,
            property_count: row.property_count ?? null,
            tax_delinquent_count: row.tax_delinquent_count ?? null,
            active_lien_count: row.active_lien_count ?? null,
          }]
        }
      }
    }

    const diagnostics = {
      ...safeDiagnostics,
      context: {
        ...(safeDiagnostics.context || {}),
        selected_thread: {
          ...selected,
          prospects,
          properties,
          master_owners: masterOwners,
        },
      },
    }
    return NextResponse.json(
      {
        ok: true,
        degraded: false,
        action: 'thread-dossier',
        diagnostics,
        queryMs: Date.now() - startedAt,
        sourceUsed: 'thread-context-service',
      },
      { status: 200, headers: cors },
    )
  } catch (error) {
    return NextResponse.json(
      {
        ok: true,
        degraded: true,
        action: 'thread-dossier',
        error_code: 'thread_dossier_failed',
        error: 'thread_dossier_failed',
        message: error?.message || 'Unknown thread dossier error',
        diagnostics: {
          thread_key,
          queryMs: Date.now() - startedAt,
          sourceUsed: 'thread-context-service',
        },
      },
      { status: 200, headers: cors },
    )
  }
}
