import type { SupabaseClient } from '@supabase/supabase-js'
import { callBackend } from '../../lib/api/backendClient'
import {
  resolveMapOwnershipCheckIdentity,
  type MapOwnershipCheckHints,
  type MapOwnershipCheckResolveResult,
} from './resolve-map-ownership-check'

type ResolveOptions = {
  hints?: MapOwnershipCheckHints
  supabase?: SupabaseClient
}

const RESOLVE_OWNERSHIP_CHECK_PATH = '/api/internal/dashboard/ops/map/resolve-ownership-check'

const isResolverPayload = (value: unknown): value is MapOwnershipCheckResolveResult =>
  Boolean(value && typeof value === 'object' && 'ok' in value)

/**
 * Browser sends use the authenticated API resolver: prospects/phones are not
 * readable under the dashboard anon key. Unit tests inject supabase directly.
 */
export const resolveMapOwnershipCheckIdentityForSend = async (
  propertyId: string,
  options: ResolveOptions = {},
): Promise<MapOwnershipCheckResolveResult> => {
  if (options.supabase) {
    return resolveMapOwnershipCheckIdentity(propertyId, {
      supabase: options.supabase,
      hints: options.hints,
    })
  }

  const result = await callBackend<MapOwnershipCheckResolveResult>(
    RESOLVE_OWNERSHIP_CHECK_PATH,
    {
      method: 'POST',
      body: JSON.stringify({
        property_id: propertyId,
        hints: options.hints ?? {},
      }),
    },
  )

  const payload = (result.ok ? result.data : result.upstream) as unknown
  if (isResolverPayload(payload)) {
    return payload
  }

  return { ok: false, error: 'ownership_check_resolve_unavailable' }
}