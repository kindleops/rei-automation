import type { SupabaseClient } from '@supabase/supabase-js'
import {
  resolveMapOwnershipCheckIdentity,
  type MapOwnershipCheckHints,
  type MapOwnershipCheckResolveResult,
} from './resolve-map-ownership-check'

type ResolveOptions = {
  hints?: MapOwnershipCheckHints
  supabase?: SupabaseClient
}

/**
 * Browser sends must use the server resolver: prospects/phones are not readable
 * under the dashboard anon key. Unit tests inject supabase directly.
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

  const response = await fetch('/api/internal/map/resolve-ownership-check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      property_id: propertyId,
      hints: options.hints ?? {},
    }),
  })

  const payload = await response.json().catch(() => null) as MapOwnershipCheckResolveResult | null
  if (!payload || typeof payload !== 'object' || !('ok' in payload)) {
    return { ok: false, error: 'ownership_check_resolve_unavailable' }
  }

  return payload
}