import { describe, expect, it } from 'vitest'
import { buildSellerMapCardViewModel } from '../../src/views/map/seller-card/seller-map-card-view-model'

describe('buildSellerMapCardViewModel', () => {
  it('uses master owner fields only for display name', () => {
    const vm = buildSellerMapCardViewModel({
      prospect_name: 'Prospect Person',
      seller_display_name: 'Prospect Display',
      seller_name: 'Prospect Seller',
      owner_display_name: 'Anthony Polk',
      property_address_full: '5502 Cottonwood Rd, Memphis, TN 38115',
      property_type: 'Single Family',
      total_bedrooms: 4,
      total_baths: 3,
      building_square_feet: 2486,
      year_built: 1978,
      estimated_value: 285000,
      equity_amount: 198000,
      equity_percent: 69,
      estimated_repair_cost: 22000,
      owner_priority_score: 78,
      lifecycle_stage: 'ownership_confirmation',
      operational_status: 'awaiting_response',
      lead_temperature: 'warm',
    })

    expect(vm.masterOwner.displayName).toBe('Anthony Polk')
    expect(vm.masterOwner.displayName).not.toContain('Prospect')
    expect(vm.masterOwner.priorityScore).toBe(78)
    expect(vm.operations.stageLabel).not.toBe('Active')
    expect(vm.operations.statusLabel).not.toBe('ACTIVE')
  })

  it('does not fabricate priority score from motivation_score', () => {
    const vm = buildSellerMapCardViewModel({
      owner_display_name: 'Jane Owner',
      property_address_full: '100 Main St',
      motivation_score: 92,
    })

    expect(vm.masterOwner.priorityScore).toBeNull()
  })

  it('maps owner_priority_score and suppresses zeroish values', () => {
    const vm = buildSellerMapCardViewModel({
      owner_display_name: 'Jane Owner',
      property_address_full: '100 Main St',
      owner_priority_score: 0,
      building_square_feet: 0,
      estimated_value: 0,
      year_built: 0,
    })

    expect(vm.masterOwner.priorityScore).toBeNull()
    expect(vm.assetSummaryLine).not.toContain('0 sqft')
    expect(vm.peekMetrics.every((metric) => metric.value !== '$0')).toBe(true)
  })

  it('renders asset-class summary for multifamily 5+', () => {
    const vm = buildSellerMapCardViewModel({
      owner_display_name: 'Portfolio Owner',
      property_address_full: '900 Industrial Blvd',
      property_type: 'Multifamily',
      units_count: 18,
      building_square_feet: 12870,
      total_bedrooms: 25,
      total_baths: 18,
      year_built: 1972,
      estimated_value: 1900000,
      equity_amount: 900000,
      equity_percent: 47,
      owner_priority_score: 64,
    })

    expect(vm.assetSummaryLine).toContain('18 units')
    expect(vm.property.assetClassKey).toBe('multifamily_5_plus')
  })

  it('exposes follow-up eligibility for uncontacted properties', () => {
    const vm = buildSellerMapCardViewModel({
      owner_display_name: 'Jane Owner',
      property_address_full: '100 Main St',
      owner_priority_score: 78,
      outbound_count: 0,
      thread_key: 'property:100',
    })

    expect(vm.followUpEligibility.isUncontacted).toBe(true)
    expect(vm.followUpEligibility.canExecute).toBe(true)
  })

  it('builds dossier only after focus hydration flag is set', () => {
    const peek = buildSellerMapCardViewModel({
      owner_display_name: 'Jane Owner',
      property_address_full: '100 Main St',
      property_type: 'Single Family',
      building_condition: 'Good',
      construction_type: 'Brick',
    })
    expect(peek.dossier).toBeNull()

    const focus = buildSellerMapCardViewModel({
      owner_display_name: 'Jane Owner',
      property_address_full: '100 Main St',
      property_type: 'Single Family',
      building_condition: 'Good',
      construction_type: 'Brick',
      dossier_hydrated: true,
    })
    expect(focus.dossier).not.toBeNull()
    expect(focus.dossier?.propertyDetails.length).toBeGreaterThan(0)
  })
})