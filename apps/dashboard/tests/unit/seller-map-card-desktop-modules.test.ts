import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildPropertyDossierContract } from '../../src/views/map/seller-card/seller-property-dossier-contract'
import { buildSellerMapCardViewModel } from '../../src/views/map/seller-card/seller-map-card-view-model'
import { buildWeightedTags } from '../../src/views/map/seller-card/seller-weighted-tags'
import { COMMAND_MAP_PROPERTY_DOSSIER_SELECT } from '../../src/views/map/seller-card/seller-property-dossier-select'

const hydratedRecord = (overrides: Record<string, unknown> = {}) => ({
  owner_display_name: 'Jane Owner',
  property_address_full: '100 Main St, Memphis, TN',
  property_type: 'Single Family',
  dossier_hydrated: true,
  ...overrides,
})

const tagContext = {
  equityPercent: 72,
  assetClassKey: 'single_family',
  units: 1,
  portfolioCount: 1,
  ownershipYears: 12,
  ownerType: 'LLC',
  hasPriorContact: false,
  ownerPriorityScore: 56,
}

describe('desktop map card enriched dossier', () => {
  it('1. hover layout places badge rail below the Street View image', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/views/map/seller-card/SellerMapCard.tsx'),
      'utf8',
    )
    const peekBodyStart = source.indexOf('const peekBody = (')
    const peekBody = source.slice(peekBodyStart, peekBodyStart + 500)
    const stickySummaryStart = source.indexOf('const stickySummary = (')
    const stickySummary = source.slice(stickySummaryStart, stickySummaryStart + 400)
    expect(peekBody.indexOf('{imageBlock}')).toBeGreaterThan(-1)
    expect(peekBody.indexOf('{stickySummary}')).toBeGreaterThan(-1)
    expect(peekBody.indexOf('{imageBlock}')).toBeLessThan(peekBody.indexOf('{stickySummary}'))
    expect(stickySummary).toContain('SellerMapCardBadgeRail')
    const sections = readFileSync(
      resolve(process.cwd(), 'src/views/map/seller-card/SellerMapCardDesktopSections.tsx'),
      'utf8',
    )
    expect(sections).toContain('smc-state-row--below-image')
    expect(source).not.toContain('smc-peek-hero__overlay')
  })

  it('2. peek card uses dense body without placeholder dossier modules', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/views/map/seller-card/SellerMapCard.tsx'),
      'utf8',
    )
    expect(source).toContain('smc-body--peek-dense')
    expect(source).not.toContain('smc-section--owner-pressure')
    expect(source).not.toContain('smc-section--prospect')
  })

  it('3. each top metric label appears once in peek metrics', () => {
    const vm = buildSellerMapCardViewModel(hydratedRecord({
      estimated_value: 250000,
      equity_percent: 72,
      estimated_repair_cost: 18000,
      total_loan_balance: 70000,
    }))
    const labels = vm.peekMetrics.map((metric) => metric.label)
    expect(labels).toHaveLength(4)
    expect(new Set(labels).size).toBe(4)
  })

  it('4. score appears once in the badge rail', () => {
    const vm = buildSellerMapCardViewModel(hydratedRecord({ owner_priority_score: 56 }))
    const scoreBadges = vm.headerBadges.filter((badge) => badge.tone === 'score')
    expect(scoreBadges).toHaveLength(1)
    expect(scoreBadges[0]?.label).toBe('Score 56')
  })

  it('5. contact state appears once in the summary badges', () => {
    const vm = buildSellerMapCardViewModel(hydratedRecord({ operational_status: 'not_contacted' }))
    const statusBadges = vm.headerBadges.filter((badge) => badge.tone === 'status')
    expect(statusBadges).toHaveLength(1)
    expect(statusBadges[0]?.label).toBe('Not Contacted')
  })

  it('6. owner pressure module is absent from dossier contract', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/views/map/seller-card/SellerMapCardDesktopSections.tsx'),
      'utf8',
    )
    expect(source).not.toContain('owner-pressure')
    expect(source).not.toContain('Owner Pressure')
  })

  it('7. acquisition fit module is absent from dossier contract', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/views/map/seller-card/SellerMapCardDesktopSections.tsx'),
      'utf8',
    )
    expect(source).not.toContain('acquisition-fit')
    expect(source).not.toContain('Acquisition Fit')
  })

  it('8. prospect contactability module is absent', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/views/map/seller-card/SellerMapCardDesktopSections.tsx'),
      'utf8',
    )
    expect(source).not.toContain('contactability')
    expect(source).not.toContain('Phone Coverage')
  })

  it('9. automation module is absent when inactive', () => {
    const vm = buildSellerMapCardViewModel(hydratedRecord({ automation_state: 'idle' }))
    const source = readFileSync(
      resolve(process.cwd(), 'src/views/map/seller-card/SellerMapCardDesktopSections.tsx'),
      'utf8',
    )
    expect(source).not.toContain('Automation')
    expect(vm.dossier?.distressLegal ?? []).not.toContain('automation')
  })

  it('10. buyer demand tag is absent from weighted signals', () => {
    const tags = buildWeightedTags({
      property_flags_text: 'Buyer Demand, Cash Buyer',
    }, tagContext)
    expect(tags.some((tag) => /buyer demand/i.test(tag.label))).toBe(false)
  })

  it('11. has phone tag is absent from weighted signals', () => {
    const tags = buildWeightedTags({
      property_flags_text: 'Has Phone, SMS Eligible',
      canonical_e164: '+19015551212',
    }, tagContext)
    expect(tags.some((tag) => /has phone/i.test(tag.label))).toBe(false)
    expect(tags.some((tag) => /sms eligible/i.test(tag.label))).toBe(false)
  })

  it('12. LLC and corporate owner tags are absent from weighted signals', () => {
    const tags = buildWeightedTags({
      property_flags_text: 'LLC, Corporate Owner',
      owner_type: 'LLC',
    }, tagContext)
    expect(tags.some((tag) => tag.label === 'LLC')).toBe(false)
    expect(tags.some((tag) => tag.label === 'Corporate Owner')).toBe(false)
  })

  it('13. asset type is not repeated in the lower dossier', () => {
    const vm = buildSellerMapCardViewModel(hydratedRecord({
      property_type: 'Single Family',
      construction_type: 'Frame',
      building_condition: 'Average',
    }))
    const dossier = vm.dossier
    expect(dossier).not.toBeNull()
    const allLabels = [
      ...(dossier?.valuationAssessment ?? []).map((field) => field.label),
      ...(dossier?.loanTransaction ?? []).map((field) => field.label),
      ...(dossier?.assetSpecific ?? []).map((field) => field.label),
      ...(dossier?.propertyDetails ?? []).flatMap((group) => group.fields.map((field) => field.label)),
    ]
    expect(allLabels.some((label) => /property type/i.test(label))).toBe(false)
    expect(allLabels.some((label) => label === 'Single Family')).toBe(false)
  })

  it('14. location section is absent from dossier sections', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/views/map/seller-card/SellerMapCardDesktopSections.tsx'),
      'utf8',
    )
    expect(source).not.toContain('Location')
    expect(source).not.toContain('Ownership Type')
  })

  it('15. property details renders populated construction fields', () => {
    const dossier = buildPropertyDossierContract(hydratedRecord({
      construction_type: 'Masonry',
      exterior_walls: 'Brick',
    }), 'single_family')
    const construction = dossier?.propertyDetails.find((group) => group.key === 'construction')
    expect(construction?.fields.some((field) => field.label === 'Construction Type')).toBe(true)
    expect(construction?.fields.some((field) => field.value === 'Masonry')).toBe(true)
  })

  it('16. property details renders populated condition fields', () => {
    const dossier = buildPropertyDossierContract(hydratedRecord({
      building_condition: 'Good',
      building_quality: 'Average',
    }), 'single_family')
    const construction = dossier?.propertyDetails.find((group) => group.key === 'construction')
    expect(construction?.fields.some((field) => field.label === 'Building Condition')).toBe(true)
    expect(construction?.fields.some((field) => field.label === 'Building Quality')).toBe(true)
  })

  it('17. property details renders populated roof fields', () => {
    const dossier = buildPropertyDossierContract(hydratedRecord({
      roof_type: 'Gable',
      roof_cover: 'Composition Shingle',
    }), 'single_family')
    const roof = dossier?.propertyDetails.find((group) => group.key === 'roof')
    expect(roof?.fields.some((field) => field.label === 'Roof Type')).toBe(true)
    expect(roof?.fields.some((field) => field.label === 'Roof Cover')).toBe(true)
  })

  it('18. property details renders populated systems fields', () => {
    const dossier = buildPropertyDossierContract(hydratedRecord({
      air_conditioning: 'Central',
      heating_type: 'Forced Air',
      sewer: 'Public',
      water: 'Public',
    }), 'single_family')
    const systems = dossier?.propertyDetails.find((group) => group.key === 'systems')
    expect(systems?.fields.some((field) => field.label === 'Air Conditioning')).toBe(true)
    expect(systems?.fields.some((field) => field.label === 'Heating Type')).toBe(true)
    expect(systems?.fields.some((field) => field.label === 'Sewer')).toBe(true)
    expect(systems?.fields.some((field) => field.label === 'Water')).toBe(true)
  })

  it('19. missing fields do not reserve space in dossier groups', () => {
    const dossier = buildPropertyDossierContract(hydratedRecord({
      building_condition: 'Good',
    }), 'single_family')
    const construction = dossier?.propertyDetails.find((group) => group.key === 'construction')
    expect(construction?.fields.every((field) => field.value !== '—')).toBe(true)
    expect(construction?.fields.some((field) => field.label === 'Building Quality')).toBe(false)
  })

  it('20. distress section renders only when applicable', () => {
    const clean = buildPropertyDossierContract(hydratedRecord(), 'single_family')
    expect(clean?.distressLegal).toBeNull()

    const distressed = buildPropertyDossierContract(hydratedRecord({
      tax_delinquent: true,
      tax_delinquent_year: 2024,
    }), 'single_family')
    expect(distressed?.distressLegal?.length).toBeGreaterThan(0)
  })

  it('21. multifamily profile uses multifamily fields', () => {
    const dossier = buildPropertyDossierContract(hydratedRecord({
      property_type: 'Multifamily',
      units_count: 8,
      building_square_feet: 6200,
    }), 'multifamily_2_4')
    const structure = dossier?.propertyDetails.find((group) => group.key === 'structure')
    expect(structure?.fields.some((field) => field.label === 'Building Sqft')).toBe(true)
    const vm = buildSellerMapCardViewModel(hydratedRecord({
      property_type: 'Multifamily',
      units_count: 8,
      estimated_value: 900000,
      equity_percent: 55,
    }))
    expect(vm.peekMetrics.some((metric) => metric.label === 'Units')).toBe(true)
  })

  it('22. commercial profile uses commercial fields', () => {
    const dossier = buildPropertyDossierContract(hydratedRecord({
      property_type: 'Retail',
      commercial_category: 'Strip Center',
      building_square_feet: 9200,
    }), 'retail')
    expect(dossier?.assetSpecific.some((field) => field.label === 'Commercial Category')).toBe(true)
    const vm = buildSellerMapCardViewModel(hydratedRecord({
      property_type: 'Retail',
      building_square_feet: 9200,
      estimated_value: 1200000,
      equity_percent: 58,
    }))
    expect(vm.property.assetClassKey).toBe('retail')
    expect(vm.peekMetrics.some((metric) => metric.label === 'Building Sqft')).toBe(true)
  })

  it('23. storage profile uses storage fields', () => {
    const dossier = buildPropertyDossierContract(hydratedRecord({
      property_type: 'Self Storage',
      storage_units: 120,
      property_class: 'Climate Controlled',
      units_count: 120,
    }), 'storage')
    expect(dossier?.assetSpecific.some((field) => field.label === 'Storage Units')).toBe(true)
    const vm = buildSellerMapCardViewModel(hydratedRecord({
      property_type: 'Self Storage',
      units_count: 120,
      building_square_feet: 18000,
      estimated_value: 2100000,
    }))
    expect(vm.property.assetClassKey).toBe('storage')
  })

  it('24. land profile uses land fields', () => {
    const dossier = buildPropertyDossierContract(hydratedRecord({
      property_type: 'Land',
      lot_acreage: 2.4,
      zoning: 'AG',
      assd_land_value: 85000,
      topography: 'Level',
      flood_zone: 'X',
      county_land_use_code: 'Agricultural',
    }), 'land')
    const site = dossier?.propertyDetails.find((group) => group.key === 'site')
    expect(site?.fields.some((field) => field.label === 'Topography')).toBe(true)
    expect(site?.fields.some((field) => field.label === 'Flood Zone')).toBe(true)
    expect(dossier?.assetSpecific.some((field) => field.label === 'Land Use')).toBe(true)
    const vm = buildSellerMapCardViewModel(hydratedRecord({
      property_type: 'Land',
      lot_acreage: 2.4,
      zoning: 'AG',
      assd_land_value: 85000,
      estimated_value: 120000,
    }))
    expect(vm.peekMetrics.some((metric) => metric.label === 'Lot Acres')).toBe(true)
  })

  it('25. dossier scroll body reserves space above sticky footer', () => {
    const css = readFileSync(
      resolve(process.cwd(), 'src/views/map/seller-card/seller-map-card.css'),
      'utf8',
    )
    expect(css).toContain('.smc-body--dossier-scroll')
    expect(css).toContain('.smc-actions--sticky')
    expect(css).toMatch(/smc-body--dossier-scroll[\s\S]*padding-bottom/)
  })

  it('26. hover view model stays lightweight without dossier hydration', () => {
    const vm = buildSellerMapCardViewModel({
      owner_display_name: 'Jane Owner',
      property_address_full: '100 Main St',
      property_type: 'Single Family',
      estimated_value: 250000,
      equity_percent: 72,
      building_condition: 'Good',
      construction_type: 'Frame',
    })
    expect(vm.dossierReady).toBe(false)
    expect(vm.dossier).toBeNull()
    expect(vm.peekMetrics).toHaveLength(4)
  })

  it('dossier select includes verified enrichment columns', () => {
    expect(COMMAND_MAP_PROPERTY_DOSSIER_SELECT).toContain('building_condition')
    expect(COMMAND_MAP_PROPERTY_DOSSIER_SELECT).toContain('roof_cover')
    expect(COMMAND_MAP_PROPERTY_DOSSIER_SELECT).toContain('rehab_level')
    expect(COMMAND_MAP_PROPERTY_DOSSIER_SELECT).not.toContain('storage_subtype')
    expect(COMMAND_MAP_PROPERTY_DOSSIER_SELECT).toContain('lot_size_frontage_feet')
    expect(COMMAND_MAP_PROPERTY_DOSSIER_SELECT).toContain('mls_market_status')
  })
})