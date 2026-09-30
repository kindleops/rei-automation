import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * "The owner can't schedule campaigns" (2026-09-30) — the builder half.
 *
 * Reach must lead with what Build will produce (build_simulation), a filter
 * the campaign audience can't apply must arrive disabled with its reason, and
 * Reach must be asked to simulate the same send limit Schedule builds.
 */

const callBackend = vi.fn()
vi.mock('../../lib/api/backendClient', () => ({ callBackend: (...args: unknown[]) => callBackend(...args) }))

const { getFieldCatalog, isFieldCampaignInapplicable, previewTargets, createEmptyFilterGroups } = await import('./campaignWizardAdapter')

beforeEach(() => { callBackend.mockReset() })

function catalogPayload() {
  const field = (key: string, extra: Record<string, unknown> = {}) => ({
    key,
    domain: key.split('.')[0],
    category: 'Property',
    label: key.split('.')[1],
    type: 'text',
    source_column: key.split('.')[1],
    supported_in_preview: true,
    ...extra,
  })
  return {
    ok: true,
    domains: [{
      id: 'properties',
      label: 'Properties',
      categories: [{
        id: 'properties.property',
        label: 'Property',
        fields: [
          field('properties.seller_tags_text', { campaign_applicable: true, campaign_column: 'podio_tags' }),
          field('properties.units_count', {
            type: 'number',
            campaign_applicable: false,
            campaign_inapplicable_reason: 'no_audience_data',
            campaign_inapplicable_message: 'No seller in the campaign audience has a value for this field yet, so it can’t narrow a campaign.',
          }),
          field('properties.tag_distress_score', {
            type: 'number',
            campaign_applicable: false,
            campaign_inapplicable_reason: 'not_in_audience',
            campaign_inapplicable_message: 'This field isn’t part of the campaign audience data, so it can’t narrow a campaign.',
          }),
        ],
      }],
    }],
  }
}

describe('field catalog applicability', () => {
  it('a field the audience can’t filter on arrives flagged, with the reason, not hidden', async () => {
    callBackend.mockResolvedValueOnce({ ok: true, data: catalogPayload() })
    const catalog = await getFieldCatalog()
    const byKey = new Map(catalog.fields.map((f) => [f.key, f]))

    expect(isFieldCampaignInapplicable(byKey.get('properties.seller_tags_text'))).toBe(false)
    const units = byKey.get('properties.units_count')
    expect(units).toBeDefined()
    expect(isFieldCampaignInapplicable(units)).toBe(true)
    expect(units?.campaign_inapplicable_message).toMatch(/No seller in the campaign audience/)
    expect(byKey.get('properties.tag_distress_score')?.campaign_inapplicable_reason).toBe('not_in_audience')
  })

  it('a catalog without the annotation (older backend) treats every field as usable', () => {
    expect(isFieldCampaignInapplicable({})).toBe(false)
    expect(isFieldCampaignInapplicable(null)).toBe(false)
  })
})

describe('Reach = Build', () => {
  const draft = () => ({
    name: 'Yes',
    description: '',
    template_use_case: 'ownership_check',
    stage_code: 'S1',
    target_filters: createEmptyFilterGroups(),
  })

  it('asks the backend to simulate the send limit Schedule will build', async () => {
    callBackend.mockResolvedValueOnce({ ok: true, data: { ok: true, total_matched: 10, ready_to_queue: 8 } })
    await previewTargets(draft(), { requestId: 'r1', buildLimit: 1000 })
    const body = JSON.parse(String(callBackend.mock.calls[0][1].body))
    expect(body.build_limit).toBe(1000)
  })

  it('carries the build simulation, filter notes and refused filters through', async () => {
    callBackend.mockResolvedValueOnce({
      ok: true,
      data: {
        ok: true,
        total_matched: 41148,
        ready_to_queue: 27257,
        build_simulation: {
          ok: true,
          eligible_in_audience: 27257,
          requested_limit: 1000,
          queue_eligible_rows_read: 1000,
          recipients: 984,
          duplicate_phones_collapsed: 16,
          built: 984,
          ready: 484,
          held: 500,
          held_by_reason: { entity_contact_requires_review: 474, missing_identity_linkage: 22, ambiguous_phone_ownership: 4 },
          sendable_now: 60,
          no_sendable_number: 424,
          sender_markets: [{ market: 'Miami, FL', sellers: 97, sendable: false, summary: 'Miami, FL (97 sellers): +13058975670 blocked by operator' }],
        },
        filter_notes: [{ field_key: 'properties.property_type', message: 'Property type Apartment also includes Multi-Family, Multifamily 5+ — the same kind of building under another label.' }],
        inapplicable_filters: [{ field_key: 'properties.units_count', label: 'Units Count', reason: 'no_audience_data', message: 'Not applied: No seller in the campaign audience has a value for this field yet, so it can’t narrow a campaign.' }],
      },
    })
    const preview = await previewTargets(draft(), { requestId: 'r2', buildLimit: 1000 })
    expect(preview.build_simulation?.ready).toBe(484)
    expect(preview.build_simulation?.held_by_reason?.entity_contact_requires_review).toBe(474)
    expect(preview.ready_to_queue).toBe(27257)
    expect(preview.filter_notes?.[0].message).toMatch(/Apartment also includes Multi-Family/)
    expect(preview.inapplicable_filters?.[0]).toMatchObject({ field_key: 'properties.units_count', reason: 'no_audience_data' })
  })
})
