// FIXTURE / TEST DATA ONLY. Every source below is fictional test data for the
// S2 design-review prototype. Hosts use the reserved `.invalid` TLD so nothing
// can ever be fetched. No seller data, no real parcel numbers, no real people.

/** @type {import('../evidence.js').SourceDescriptor[]} */
export const FIXTURE_SOURCES = Object.freeze([
  {
    source_id: 'fx-src-lc-records',
    adapter_id: 'fixture.supabase.record_summary',
    adapter_version: 1,
    name: 'LeadCommand records [test data]',
    authority_class: 'internal',
    access_mode: 'supabase',
    host: 'records.fixture.invalid',
    jurisdiction: null,
    finding_types: ['ownership', 'parcel', 'mortgage', 'comparable_sales', 'investor_demand'],
    supports_negative: false,
    billable: false,
    test_data: true,
  },
  {
    source_id: 'fx-src-vendor-flags',
    adapter_id: 'fixture.supabase.vendor_flags',
    adapter_version: 1,
    name: 'Vendor property flags [test data]',
    authority_class: 'commercial',
    access_mode: 'supabase',
    host: 'vendor.fixture.invalid',
    jurisdiction: null,
    finding_types: ['tax_delinquency', 'foreclosure', 'physical_condition'],
    supports_negative: false,
    billable: false,
    test_data: true,
  },
  {
    source_id: 'fx-src-cuyahoga-tax',
    adapter_id: 'fixture.cuyahoga.tax_roll',
    adapter_version: 1,
    name: 'Fixture Cuyahoga tax roll [test data]',
    authority_class: 'official',
    access_mode: 'open_api',
    host: 'cuyahoga-tax.fixture.invalid',
    jurisdiction: 'Cuyahoga County',
    finding_types: ['tax_status', 'tax_delinquency'],
    supports_negative: true,
    billable: false,
    test_data: true,
  },
  {
    source_id: 'fx-src-cleveland-code',
    adapter_id: 'fixture.cleveland.code_cases',
    adapter_version: 1,
    name: 'Fixture Cleveland code cases [test data]',
    authority_class: 'official',
    access_mode: 'open_api',
    host: 'cleveland-code.fixture.invalid',
    jurisdiction: 'Cleveland',
    finding_types: ['code_violation', 'condemnation'],
    supports_negative: true,
    billable: false,
    test_data: true,
  },
  {
    source_id: 'fx-src-cuyahoga-recorder',
    adapter_id: 'fixture.cuyahoga.recorder',
    adapter_version: 1,
    name: 'Fixture Cuyahoga recorder index [test data]',
    authority_class: 'official',
    access_mode: 'official_lookup',
    host: 'cuyahoga-recorder.fixture.invalid',
    jurisdiction: 'Cuyahoga County',
    finding_types: ['lien', 'foreclosure', 'probate'],
    supports_negative: false,
    billable: false,
    test_data: true,
  },
  {
    source_id: 'fx-src-code-pdf-extract',
    adapter_id: 'fixture.model.extract_code_pdf',
    adapter_version: 1,
    name: 'Fixture code-case PDF extraction [test data]',
    authority_class: 'official',
    access_mode: 'open_api',
    host: 'cleveland-code.fixture.invalid',
    jurisdiction: 'Cleveland',
    finding_types: ['condemnation'],
    supports_negative: false,
    billable: true,
    test_data: true,
  },
  {
    source_id: 'fx-src-duval-tax-collector',
    adapter_id: 'fixture.duval.tax_collector',
    adapter_version: 1,
    name: 'Fixture Duval tax collector [test data]',
    authority_class: 'official',
    access_mode: 'official_lookup',
    host: 'duval-tax.fixture.invalid',
    jurisdiction: 'Duval County',
    finding_types: ['tax_status', 'tax_delinquency'],
    supports_negative: true,
    billable: false,
    test_data: true,
  },
  {
    source_id: 'fx-src-duval-appraiser',
    adapter_id: 'fixture.duval.appraiser_roll',
    adapter_version: 1,
    name: 'Fixture Duval appraiser roll [test data]',
    authority_class: 'official',
    access_mode: 'open_api',
    host: 'duval-appraiser.fixture.invalid',
    jurisdiction: 'Duval County',
    finding_types: ['tax_status', 'ownership'],
    supports_negative: false,
    billable: false,
    test_data: true,
  },
  {
    source_id: 'fx-src-duval-clerk',
    adapter_id: 'fixture.duval.clerk_tax_deed',
    adapter_version: 1,
    name: 'Fixture Duval clerk tax-deed index [test data]',
    authority_class: 'official',
    access_mode: 'official_lookup',
    host: 'duval-clerk.fixture.invalid',
    jurisdiction: 'Duval County',
    finding_types: ['tax_delinquency'],
    supports_negative: true,
    billable: false,
    test_data: true,
  },
  {
    source_id: 'fx-src-browser-manual',
    adapter_id: 'fixture.browser.manual',
    adapter_version: 1,
    name: 'Open in Browser (manual) [test data]',
    authority_class: 'official',
    access_mode: 'manual_link',
    host: 'browser.fixture.invalid',
    jurisdiction: null,
    finding_types: ['tax_status'],
    supports_negative: false,
    billable: false,
    test_data: true,
  },
])

export function fixtureSource(source_id) {
  const s = FIXTURE_SOURCES.find((x) => x.source_id === source_id)
  if (!s) throw new Error(`UNKNOWN_FIXTURE_SOURCE:${source_id}`)
  return s
}

/** Fictional properties. Addresses use "Fixture" street names; never real records. */
export function fixtureProperty(index, market = 'cleveland') {
  const n = String(index).padStart(3, '0')
  const markets = {
    cleveland: { city: 'Cleveland', state: 'OH', jurisdiction: 'Cuyahoga County', fips: 'FX39035' },
    jacksonville: { city: 'Jacksonville', state: 'FL', jurisdiction: 'Duval County', fips: 'FX12031' },
  }
  const m = markets[market] || markets.cleveland
  return {
    property_id: `fx-prop-${market.slice(0, 3)}-${n}`,
    display_address: `${100 + index * 4} Fixture Ave, ${m.city}, ${m.state} [test data]`,
    ...m,
    test_data: true,
  }
}
