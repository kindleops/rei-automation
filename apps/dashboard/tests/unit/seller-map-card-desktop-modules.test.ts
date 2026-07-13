import { describe, expect, it } from 'vitest'
import { buildSellerMapCardViewModel } from '../../src/views/map/seller-card/seller-map-card-view-model'
import { buildWeightedTags, collapseWeightedTags } from '../../src/views/map/seller-card/seller-weighted-tags'
import {
  buildOwnerPressureInput,
  computeAcquisitionFitProfile,
  computeOwnerPressureProfile,
} from '../../src/views/map/seller-card/seller-owner-pressure'
import { buildProspectContactabilityProfile } from '../../src/views/map/seller-card/seller-prospect-contactability'
import { buildFinancialProfile } from '../../src/views/map/seller-card/seller-financial-profile'
import { buildPropertyProfileGroups } from '../../src/views/map/seller-card/seller-property-profile'
import { resolveSellerActionBar } from '../../src/views/map/seller-card/seller-action-bar'
import { safeHumanName } from '../../src/lib/identity/entityDetection'

describe('desktop map card modules', () => {
  it('1. SFR hover card uses four compact metrics max', () => {
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

  it('2. no duplicate contact state — badge uses canonical status only', () => {
    const vm = buildSellerMapCardViewModel({
      owner_display_name: 'Jane Owner',
      property_address_full: '100 Main St',
      operational_status: 'not_contacted',
    })

    expect(vm.contactStateLabel).toBe('Not Contacted')
    expect(vm.activity.headline).toBe('NO CONTACT YET')
    expect(vm.contactStateLabel).not.toBe(vm.activity.headline)
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

  it('4. contactability does not show Ready without valid recipient/channel', () => {
    const noProspect = buildProspectContactabilityProfile({
      canonical_e164: '+19015551212',
    }, { suppressed: false, suppressionReason: null })
    expect(noProspect.meterLabel).not.toBe('Ready')
    expect(noProspect.meterLabel).toBe('Partial')

    const noChannel = buildProspectContactabilityProfile({}, { suppressed: false, suppressionReason: null })
    expect(noChannel.meterLabel).toBe('Not ready')

    const resolved = buildProspectContactabilityProfile({
      prospect_full_name: 'Amanda Tallen',
      sms_eligible: true,
      canonical_e164: '+19015551212',
    }, { suppressed: false, suppressionReason: null })
    expect(resolved.meterLabel).toBe('Ready')
  })

  it('5. low owner pressure with strong acquisition fit for LLC absentee free-and-clear', () => {
    const input = buildOwnerPressureInput({
      owner_display_name: 'Entity Holdings LLC',
      owner_type: 'LLC',
      equity_percent: 100,
      absentee_owner: true,
      ownership_years: 18,
      property_count: 1,
    })

    const pressure = computeOwnerPressureProfile(input)
    const fit = computeAcquisitionFitProfile(input)

    expect(pressure.label).toBe('Low')
    expect(pressure.summary).toContain('No legal/financial pressure detected')
    expect(fit.label).toBe('Strong')
    expect(fit.drivers.some((d) => d.label === 'Free & clear')).toBe(true)
  })

  it('6. critical tags sort before amber/green/cyan/gray', () => {
    const tags = buildWeightedTags({
      property_flags_text: 'Probate, Tired Landlord',
      tax_delinquent: true,
      sms_eligible: true,
      canonical_e164: '+19015551212',
      prospect_full_name: 'Amanda Tallen',
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

  it('7. Cash Buyer tag maps to Buyer Demand', () => {
    const tags = buildWeightedTags({
      property_flags_text: 'Cash Buyer',
    }, {
      equityPercent: 50,
      assetClassKey: 'single_family',
      units: 1,
      portfolioCount: 1,
      ownershipYears: 5,
      ownerType: 'Individual',
      hasPriorContact: true,
      ownerPriorityScore: 50,
    })
    expect(tags.some((tag) => tag.label === 'Buyer Demand')).toBe(true)
    expect(tags.some((tag) => tag.label.toLowerCase().includes('cash buyer signal'))).toBe(false)
  })

  it('8. hover card max metric count is four', () => {
    const vm = buildSellerMapCardViewModel({
      owner_display_name: 'Owner',
      property_address_full: '1 Main',
      property_type: 'Commercial',
      building_square_feet: 5000,
      estimated_value: 900000,
      equity_percent: 80,
      mortgage_balance: 100000,
      estimated_repair_cost: 25000,
    })
    expect(vm.peekMetrics.length).toBeLessThanOrEqual(4)
  })

  it('9. expanded property profile hides empty fields', () => {
    const vm = buildSellerMapCardViewModel({
      owner_display_name: 'Owner',
      property_address_full: '1 Main St',
      property_type: 'Single Family',
      property_address_city: 'Memphis',
      property_address_state: 'TN',
      bedrooms: 3,
      bathrooms: 2,
    })
    const groups = buildPropertyProfileGroups(vm, {
      property_address_city: 'Memphis',
      property_address_state: 'TN',
    })
    const allFields = groups.flatMap((g) => g.fields)
    expect(allFields.every((f) => f.value !== '—')).toBe(true)
    expect(allFields.some((f) => f.label === 'City')).toBe(true)
  })

  it('10. entity owner is never SMS greeting in header', () => {
    const vm = buildSellerMapCardViewModel({
      owner_display_name: 'Entity Holdings LLC',
      entity_name: 'Entity Holdings LLC',
      property_address_full: '12 Oak Ave',
    })
    expect(vm.headerDisplayName).toBe('Entity Holdings LLC')
    expect(safeHumanName(vm.headerDisplayName)).toBeFalsy()
  })

  it('11. action bar disabled reason and hidden secondary when blocked', () => {
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
    expect(disabled.secondary.action).toBe('none')
  })

  it('12. financial profile exposes compact summary chips and meters', () => {
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

    expect(profile.summaryChips.some((chip) => chip.label === 'Equity')).toBe(true)
    expect(profile.meters.some((meter) => meter.key === 'equity')).toBe(true)
    expect(profile.meters.some((meter) => meter.key === 'leverage')).toBe(true)
  })

  it('13. owner pressure score is distress-only with drivers', () => {
    const profile = computeOwnerPressureProfile(buildOwnerPressureInput({
      estimated_value: 500000,
      equity_percent: 40,
      mortgage_balance: 400000,
      tax_delinquent: true,
      absentee_owner: true,
      ownership_years: 16,
      property_count: 4,
    }))

    expect(profile.score).toBeGreaterThan(0)
    expect(profile.tier).toBeTruthy()
    expect(profile.drivers.some((d) => d.impact === 'negative')).toBe(true)
    expect(profile.drivers.some((d) => d.label === 'Absentee')).toBe(false)
  })

  it('14. prospect contactability module handles unresolved prospect with phone', () => {
    const profile = buildProspectContactabilityProfile({
      canonical_e164: '+19015551212',
    }, { suppressed: false, suppressionReason: null, isUncontacted: true })
    expect(profile.emptyState).toBe('No resolved prospect')
    expect(profile.channelLine).toBe('Phone coverage available')
    expect(profile.meterLabel).toBe('Partial')
  })

  it('15. weighted tag tooltip is present', () => {
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

  it('16. action bar exposes ownership check primary for uncontacted', () => {
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
  })

  it('17. follow up state maps to action bar', () => {
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

  it('18. expanded dossier includes financial, pressure, fit, and prospect sections', () => {
    const vm = buildSellerMapCardViewModel({
      owner_display_name: 'Entity Holdings LLC',
      prospect_full_name: 'Amanda Tallen',
      sms_eligible: true,
      canonical_e164: '+19015551212',
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
    expect(vm.financialProfile.summaryChips.length).toBeGreaterThan(0)
    expect(vm.ownerPressure.score).not.toBeNull()
    expect(vm.acquisitionFit.score).not.toBeNull()
    expect(vm.prospectProfile.resolvedName).toBe('Amanda Tallen')
    expect(vm.propertyProfileGroups.length).toBeGreaterThan(0)
    expect(vm.actionBar.secondary.label).toBe('Message')
  })
})