import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, corsHeaders } from '../_shared.js'
import { getEntityGraphDossier } from '@/lib/domain/entity-graph/entity-graph-service.js'

export async function handleEntityGraphDossierGET(request, type, id) {
  const headers = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) {
    return NextResponse.json(
      await auth.response.json().catch(() => ({ ok: false, error: 'unauthorized' })),
      { status: auth.response.status, headers },
    )
  }

  try {
    const dossier = await getEntityGraphDossier(type, id)
    if (!dossier) {
      return NextResponse.json({ ok: false, error: 'entity_not_found' }, { status: 404, headers })
    }
    return NextResponse.json({ ok: true, data: dossier }, { status: 200, headers })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error?.message || 'entity_graph_dossier_failed' },
      { status: 500, headers },
    )
  }
}

export function entityGraphDossierOPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}