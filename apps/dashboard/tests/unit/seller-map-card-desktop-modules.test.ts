import { describe, expect, it } from 'vitest'
import { buildSellerMapCardViewModel } from '../../src/views/map/seller-card/seller-map-card-view-model'
import { buildWeightedTags, collapseWeightedTags } from '../../src/views/map/seller-card/seller-weighted-tags'
import { buildOwnerPressureInput, computeOwnerPressureProfile } from '../../src/views/map/seller-card/seller-owner-pressure'
import { buildProspectContactabilityProfile } from '../../src/views/map/seller-card/seller-prospect-contactability'
import { buildFinancialProfile } from '../../src/views/map/seller-card/seller-financial-profile'
import { resolveSellerActionBar } from '../../src/views/map/seller-card/seller-action-bar'

describe('desktop map card modules', () => {
  it('1. SFR hover card uses four compact metrics', () => {
    const vm = buildSellerMapCardViewModel({
      owner_display_name: 'Jane Owner',
      property_address_full: '100 Main St, Memphis, TN',
      property_type: 'Single Family',
      estimated_value: 250000,
      equity_percent: 72,
      estimated_repair_cost: 18000,
      mortgage_balance: 70000,
    })

    expect(vm.property.assetClassKey).toBe('single_family')
    expect(vm.peekMetrics).toHaveLength(4)
    expect(vm.peekMetrics[0]?.label).toBe('Estimated Value')
    expect(vm.peekMetrics[3]?.label).toBe('Mortgage Balance')
  })

  it('3. Multifamily 5+ hover card prioritizes units and avg sqft/unit', () => {
    const vm = buildSellerMapCardViewModel({
      owner_display_name: 'Portfolio Owner',
      property_address_full: '900 Industrial Blvd',
      property_type: 'Multifamily',
      units_count: 20,
      building_square_feet: 14000,
      estimated_value: 2100000,
      equity_percent: 51,
    })

    expect(vm.property.assetClassKey).toBe('multifamily_5_plus')
    expect(vm.peekMetrics.some((metric) => metric.label === 'Units')).toBe(true)
  })

  it('12. Financial profile exposes equity and leverage meters', () => {
    const profile = buildFinancialProfile({
      estimatedValue: 400000,
      equityAmount: 250000,
      equityPercent: 62,
      mortgageBalance: 150000,
      repairs: 30000,
      pricePerUnit: null,
      pricePerSqft: 200,
      units: null,
      sqft: 2000,
    }, 'single_family')

    expect(profile.meters.some((meter) => meter.key === 'equity')).toBe(true)
    expect(profile.meters.some((meter) => meter.key === 'leverage')).toBe(true)
  })

  it('13. Master owner pressure score is deterministic with drivers', () => {
    const profile = computeOwnerPressureProfile(buildOwnerPressureInput({
      estimated_value: 500000,
      equity_percent: 40,
      mortgage_balance: 360000,
      tax_delinquent: true,
      absentee_owner: true,
      ownership_years: 16,
      property_count: 4,
    }))

    expect(profile.score).not.toBeNull()
    expect(profile.tier).toBeTruthy()
    expect(profile.drivers.length).toBeGreaterThan(0)
  })

  it('14. Prospect contactability module handles unresolved prospect state', () => {
    const profile = buildProspectContactabilityProfile({}, { suppressed: false, suppressionReason: null })
    expect(profile.emptyState).toBe('No resolved prospect yet')
  })

  it('15-18. weighted tags sort critical and positive tiers', () => {
    const tags = buildWeightedTags({
      property_flags_text: 'Probate, Tired Landlord',
      tax_delinquent: true,
      sms_eligible: true,
      canonical_e164: '+19015551212',
    }, {
      equityPercent: 96,
      assetClassKey: 'single_family',
      units: 1,
      portfolioCount: 1,
      ownershipYears: 20,
      ownerType: 'Individual',
      hasPriorContact: false,
      ownerPriorityScore: null,
    })

    const collapsed = collapseWeightedTags(tags, 6)
    expect(collapsed.visible[0]?.tier).toBe('critical')
    expect(tags.some((tag) => tag.tier === 'positive')).toBe(true)
    expect(collapsed.hiddenCount).toBeGreaterThanOrEqual(0)
  })

  it('19. tag tooltip is present on weighted tags', () => {
    const tags = buildWeightedTags({ tax_delinquent: true }, {
      equityPercent: 10,
      assetClassKey: 'single_family',
      units: 1,
      portfolioCount: 1,
      ownershipYears: 1,
      ownerType: 'Individual',
      hasPriorContact: false,
      ownerPriorityScore: null,
    })
    expect(tags.find((tag) => tag.label === 'Tax Delinquent')?.tooltip).toContain('Tax')
  })

  it('20-21. action bar exposes ownership check and disabled reason', () => {
    const enabled = resolveSellerActionBar({
      followUpEligibility: {
        visible: true,
        canExecute: true,
        label: 'Send Ownership Check',
        disabledReason: null,
        isUncontacted: true,
      },
      status: 'not_contacted',
      messagingBlocked: false,
      messagingBlockReason: null,
      hasThread: false,
    })
    expect(enabled.primary.action).toBe('ownership_check')
    expect(enabled.primary.enabled).toBe(true)

    const disabled = resolveSellerActionBar({
      followUpEligibility: {
        visible: true,
        canExecute: false,
        label: 'Send Ownership Check',
        disabledReason: 'Suppressed',
        isUncontacted: true,
      },
      status: 'not_contacted',
      messagingBlocked: true,
      messagingBlockReason: 'Suppressed',
      hasThread: false,
    })
    expect(disabled.primary.enabled).toBe(false)
    expect(disabled.primary.disabledReason).toBe('Suppressed')
  })

  it('22. follow up state maps to action bar', () => {
    const bar = resolveSellerActionBar({
      followUpEligibility: {
        visible: true,
        canExecute: true,
        label: 'Follow Up',
        disabledReason: null,
        isUncontacted: false,
      },
      status: 'follow_up_due',
      messagingBlocked: false,
      messagingBlockReason: null,
      hasThread: true,
    })
    expect(bar.primary.label).toBe('Follow Up')
  })

  it('expanded dossier includes financial, owner pressure, and prospect sections', () => {
    const vm = buildSellerMapCardViewModel({
      owner_display_name: 'Entity Holdings LLC',
      prospect_full_name: 'Amanda Tallen',
      sms_eligible: true,
      property_address_full: '12 Oak Ave',
      property_type: 'Commercial',
      building_square_feet: 9200,
      estimated_value: 1200000,
      equity_percent: 58,
      tax_delinquent: true,
      property_count: 3,
      owner_priority_score: 66,
      lifecycle_stage: 'ownership_confirmation',
      operational_status: 'contacted',
    })

    expect(vm.financialProfile.fields.length).toBeGreaterThan(0)
    expect(vm.ownerPressure.score).not.toBeNull()
    expect(vm.prospectProfile.resolvedName).toBe('Amanda Tallen')
    expect(vm.propertyProfileGroups.length).toBeGreaterThan(0)
    expect(vm.actionBar.secondary.label).toBe('Message')
  })
})