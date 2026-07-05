import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveMapOwnershipCheckIdentityForSend } from '../../src/domain/map/resolve-map-ownership-check-client'
import * as resolverModule from '../../src/domain/map/resolve-map-ownership-check'
import * as backendClient from '../../src/lib/api/backendClient'

describe('resolveMapOwnershipCheckIdentityForSend', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('uses callBackend for browser sends instead of direct protected-table reads', async () => {
    const callBackend = vi.spyOn(backendClient, 'callBackend').mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        ok: true,
        identity: {
          propertyId: '274564949',
          masterOwnerId: 'mo_804d2f26377bee1f43019235',
          phoneId: 'ph_amanda',
          recipientPhone: '+16514428447',
          prospectId: 'pros1_5d2dfe5ae95f982c0941f648',
          prospectFirstName: 'Amanda',
          prospectFullName: 'Amanda L Tallen',
          smsEligible: true,
          agentName: 'Andre Thompson',
          agentFirstName: 'Andre',
          ownerDisplayName: 'Trust',
          ownerLanguage: 'English',
          propertyAddress: '983 Edmund Ave, Saint Paul, MN 55104',
          sellerDisplayName: 'Amanda L Tallen',
          smsAgentId: null,
          selectedAgentId: null,
          resolutionSource: 'hydrated_map_identity',
          resolutionDiagnostics: { candidateCount: 1, source: 'hydrated_map_identity' },
        },
      },
    })

    const directResolver = vi.spyOn(resolverModule, 'resolveMapOwnershipCheckIdentity')

    const result = await resolveMapOwnershipCheckIdentityForSend('274564949', {
      hints: { prospectFirstName: 'Amanda' },
    })

    expect(callBackend).toHaveBeenCalledWith(
      '/api/internal/dashboard/ops/map/resolve-ownership-check',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(directResolver).not.toHaveBeenCalled()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.identity.prospectFirstName).toBe('Amanda')
    }
  })

  it('preserves exact API error codes from 422 upstream payloads', async () => {
    vi.spyOn(backendClient, 'callBackend').mockResolvedValue({
      ok: false,
      status: 422,
      error: 'property_owner_link_missing',
      upstream: {
        ok: false,
        error: 'property_owner_link_missing',
        diagnostics: { candidateCount: 0, sources: [] },
      },
    })

    const result = await resolveMapOwnershipCheckIdentityForSend('prop-missing')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('property_owner_link_missing')
      expect(result.diagnostics?.candidateCount).toBe(0)
    }
  })

  it('still allows unit tests to inject supabase directly', async () => {
    const supabase = { from: vi.fn() } as unknown as SupabaseClient
    const directResolver = vi.spyOn(resolverModule, 'resolveMapOwnershipCheckIdentity').mockResolvedValue({
      ok: false,
      error: 'phone_not_linked_to_human_prospect',
    })

    const result = await resolveMapOwnershipCheckIdentityForSend('274564949', { supabase })
    expect(directResolver).toHaveBeenCalledWith('274564949', { supabase, hints: undefined })
    expect(result.ok).toBe(false)
  })
})