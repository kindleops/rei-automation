import { getSupabaseAdminClient, hasSupabaseAdminEnv } from '../../_lib/supabaseAdmin'
import {
  resolveMapOwnershipCheckIdentity,
  type MapOwnershipCheckHints,
} from '../../../src/domain/map/resolve-map-ownership-check'

type ApiRequest = {
  method?: string
  body?: unknown
}

type ApiResponse = {
  status: (code: number) => ApiResponse
  json: (body: unknown) => void
}

type ResolveBody = {
  property_id?: string
  propertyId?: string
  hints?: MapOwnershipCheckHints
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' })
    return
  }

  if (!hasSupabaseAdminEnv) {
    res.status(500).json({ ok: false, error: 'supabase_admin_unavailable' })
    return
  }

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as ResolveBody
  const propertyId = String(body.property_id || body.propertyId || '').trim()
  if (!propertyId) {
    res.status(400).json({ ok: false, error: 'property_id is required' })
    return
  }

  try {
    const supabase = getSupabaseAdminClient()
    const result = await resolveMapOwnershipCheckIdentity(propertyId, {
      supabase,
      hints: body.hints ?? {},
    })
    res.status(result.ok ? 200 : 422).json(result)
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'resolve_ownership_check_failed',
    })
  }
}