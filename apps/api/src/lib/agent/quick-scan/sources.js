// Quick Scan source registry (S3). Every source is an EXISTING LeadCommand
// data surface read through the app's own service. access_mode 'supabase',
// billable false, never an external host — Quick Scan is $0 by structure.
//
// source_class is the P4 visual class (contracts/evidence.js). Classification
// is deliberately conservative:
//   * seller.* recorded documents (mortgages, liens, foreclosures, deed sales)
//     are county-RECORDED instruments, but they reach LeadCommand through a
//     data vendor's import (seller.* import batches), not from the recorder.
//     Only the instrument facts the recorder actually records (document type,
//     recording date, recorded amount, lien position, parties' existence) are
//     classed official_public_record / 'recorded', with the limitation
//     "vendor-transcribed; not re-verified against the county recorder".
//     A row with no recording/filing date is NOT treated as recorded.
//     Vendor estimates on those rows (est_balance, est_payment, interest rate,
//     due date) are third_party_vendor.
//   * properties / seller.property attributes and flags (Free And Clear, High
//     Equity, tax delinquent, active lien, estimated value) are vendor snapshots.
//   * nothing in Quick Scan is county_confirmed: no county system is contacted.

export const QUICK_SCAN_SOURCES = Object.freeze({
  'lc.property_record': Object.freeze({
    source_id: 'lc.property_record',
    adapter_id: 'tool:eg.property_core',
    adapter_version: 1,
    name: 'LeadCommand property record',
    authority_class: 'commercial',
    source_class: 'third_party_vendor',
    access_mode: 'supabase',
    host: 'leadcommand',
    jurisdiction: null,
    finding_types: ['property_facts', 'ownership', 'street_view'],
    supports_negative: false,
    billable: false,
    provenance: 'public.properties (vendor property export, refreshed by LeadCommand imports)',
    limitations: ['Vendor snapshot attributes; not verified against the assessor.'],
  }),
  'lc.recorded_documents': Object.freeze({
    source_id: 'lc.recorded_documents',
    adapter_id: 'tool:eg.recorded_documents',
    adapter_version: 1,
    name: 'Recorded documents (vendor-transcribed)',
    authority_class: 'commercial',
    source_class: 'official_public_record',
    access_mode: 'supabase',
    host: 'leadcommand',
    jurisdiction: null,
    finding_types: ['mortgage', 'lien', 'foreclosure', 'transfer_history'],
    supports_negative: false,
    billable: false,
    provenance: 'entity_graph_property_records → seller.property_mortgage / property_lien / property_foreclosure / property_sale (vendor import batches of county-recorded instruments)',
    limitations: [
      'County-recorded instruments as transcribed by the data vendor; not re-verified against the county recorder.',
      'Releases / satisfactions may be missing: a recorded mortgage is not proof it is still open.',
      'The feed is not proven complete: no recorded document found is NOT evidence that none exists.',
    ],
  }),
  'lc.vendor_parcel': Object.freeze({
    source_id: 'lc.vendor_parcel',
    adapter_id: 'tool:eg.recorded_documents',
    adapter_version: 1,
    name: 'Vendor parcel snapshot',
    authority_class: 'commercial',
    source_class: 'third_party_vendor',
    access_mode: 'supabase',
    host: 'leadcommand',
    jurisdiction: null,
    finding_types: ['parcel', 'tax_status'],
    supports_negative: false,
    billable: false,
    provenance: 'seller.property (vendor parcel snapshot; first/last observed in vendor files)',
    limitations: ['Vendor parcel snapshot; flags (tax delinquent, liens, equity) are the vendor\'s, as of its observation date.'],
  }),
  'lc.decision_engine': Object.freeze({
    source_id: 'lc.decision_engine',
    adapter_id: 'tool:valuation.read',
    adapter_version: 1,
    name: 'LeadCommand Decision Engine',
    authority_class: 'internal',
    source_class: 'internal_record',
    access_mode: 'supabase',
    host: 'leadcommand',
    jurisdiction: null,
    finding_types: ['valuation'],
    supports_negative: false,
    billable: false,
    provenance: 'property_acquisition_scores (Decision Engine output; written on demand)',
    limitations: ['Absent when the engine has not run for the property — absence is "not scored", not a value.'],
  }),
  'lc.campaign_target_graph': Object.freeze({
    source_id: 'lc.campaign_target_graph',
    adapter_id: 'tool:eg.sms_eligibility',
    adapter_version: 1,
    name: 'Campaign target graph',
    authority_class: 'internal',
    source_class: 'internal_record',
    access_mode: 'supabase',
    host: 'leadcommand',
    jurisdiction: null,
    finding_types: ['sms_eligibility'],
    supports_negative: false,
    billable: false,
    provenance: 'campaign_target_graph through resolveCampaignTargetReadiness (the target builder\'s own per-row rule)',
    limitations: ['Eligibility is the builder\'s verdict at read time; outbound is paused by the owner regardless.'],
  }),
  'lc.outreach': Object.freeze({
    source_id: 'lc.outreach',
    adapter_id: 'tool:eg.outreach_state',
    adapter_version: 1,
    name: 'Outreach state (inbox, pipeline, campaigns)',
    authority_class: 'internal',
    source_class: 'internal_record',
    access_mode: 'supabase',
    host: 'leadcommand',
    jurisdiction: null,
    finding_types: ['outreach_state'],
    supports_negative: false,
    billable: false,
    provenance: 'getEntityGraphOutreachState: inbox_thread_state, acquisition_opportunities, campaign_targets, campaign_target_graph',
    limitations: ['Message text is never read into evidence; only dates, direction, stage and status.'],
  }),
  'lc.market_intelligence': Object.freeze({
    source_id: 'lc.market_intelligence',
    adapter_id: 'tool:mi.zip_context',
    adapter_version: 1,
    name: 'Market Intelligence ZIP rollup',
    authority_class: 'internal',
    source_class: 'internal_record',
    access_mode: 'supabase',
    host: 'leadcommand',
    jurisdiction: null,
    finding_types: ['market_context', 'investor_demand'],
    supports_negative: false,
    billable: false,
    provenance: 'mi_geo_period_rollup (current ready build) + eg_buyer_index',
    limitations: ['Aggregates of recorded transactions in the current MI build; buyer activity data horizon applies. Demographics source (census_geo_metrics) is empty in prod.'],
  }),
  'lc.derived_rules': Object.freeze({
    source_id: 'lc.derived_rules',
    adapter_id: 'rule:quick_scan',
    adapter_version: 1,
    name: 'LeadCommand truth rules',
    authority_class: 'internal',
    source_class: 'derived_inferred',
    access_mode: 'supabase',
    host: 'leadcommand',
    jurisdiction: null,
    finding_types: ['equity'],
    supports_negative: false,
    billable: false,
    provenance: 'entity-graph-truth.js equityTruth (rule equity_known_v1) over cited inputs',
    limitations: ['Never stronger than its weakest input.'],
  }),
})

export function quickScanSource(id) {
  const s = QUICK_SCAN_SOURCES[id]
  if (!s) throw new Error(`UNKNOWN_QUICK_SCAN_SOURCE:${id}`)
  return s
}

/** SourceDescriptor list for the UI (contracts/evidence.js SourceDescriptor + source_class). */
export function listQuickScanSources() {
  return Object.values(QUICK_SCAN_SOURCES).map((s) => ({ ...s, test_data: false, live: true }))
}
