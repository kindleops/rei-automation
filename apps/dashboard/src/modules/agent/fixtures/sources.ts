/**
 * FIXTURE SOURCE REGISTRY — SIMULATED. Display names follow the kinds of
 * public offices the coverage registry will hold, but every entry here is a
 * fixture: `test_data: true`, hosts end in `.sim` (never resolvable), nothing
 * is fetched, and no favicon is loaded from a third party (Favicon.tsx draws a
 * local monogram).
 */
import { fxSource } from './fixture-kit'

export const SRC = {
  lcRecord: /* @__PURE__ */ fxSource({ source_id: 'fx-lc-record', adapter_id: 'internal.property_record', name: 'LeadCommand property record', authority_class: 'internal', access_mode: 'supabase', host: 'property-record.lc.sim', jurisdiction: null, finding_types: ['parcel', 'ownership'] }),
  lcRecorded: /* @__PURE__ */ fxSource({ source_id: 'fx-lc-recorded', adapter_id: 'internal.recorded_documents', name: 'LeadCommand recorded documents', authority_class: 'internal', access_mode: 'supabase', host: 'recorded-docs.lc.sim', jurisdiction: null, finding_types: ['mortgage', 'lien'] }),
  vendor: /* @__PURE__ */ fxSource({ source_id: 'fx-vendor', adapter_id: 'internal.vendor_flags', name: 'Vendor property flags (snapshot)', authority_class: 'commercial', access_mode: 'supabase', host: 'vendor-snapshot.sim', jurisdiction: null, finding_types: ['tax_delinquency', 'ownership'] }),
  lcComps: /* @__PURE__ */ fxSource({ source_id: 'fx-lc-comps', adapter_id: 'internal.investor_comps', name: 'LeadCommand comps · investor cluster', authority_class: 'internal', access_mode: 'supabase', host: 'comps.lc.sim', jurisdiction: null, finding_types: ['comparable_sales'] }),
  lcBuyers: /* @__PURE__ */ fxSource({ source_id: 'fx-lc-buyers', adapter_id: 'internal.buyer_index', name: 'LeadCommand buyer index', authority_class: 'internal', access_mode: 'supabase', host: 'buyers.lc.sim', jurisdiction: null, finding_types: ['investor_demand'] }),
  listing: /* @__PURE__ */ fxSource({ source_id: 'fx-listing', adapter_id: 'licensed.listing_status', name: 'Licensed listing provider', authority_class: 'licensed', access_mode: 'licensed_api', host: 'listing-provider.sim', jurisdiction: null, finding_types: ['listing_status'], billable: true }),
  model: /* @__PURE__ */ fxSource({ source_id: 'fx-model', adapter_id: 'model.extract', name: 'Extraction model (fixture)', authority_class: 'internal', access_mode: 'supabase', host: 'model-gateway.lc.sim', jurisdiction: null, finding_types: [], billable: true }),

  // Cuyahoga County, OH
  cuyFiscal: /* @__PURE__ */ fxSource({ source_id: 'fx-cuy-fiscal', adapter_id: 'cuyahoga.fiscal_parcel', name: 'Cuyahoga Fiscal Officer · parcel roll', authority_class: 'official', access_mode: 'open_api', host: 'cuyahoga-fiscal.sim', jurisdiction: 'Cuyahoga County, OH', finding_types: ['parcel', 'ownership'] }),
  cuyTreasurer: /* @__PURE__ */ fxSource({ source_id: 'fx-cuy-treasurer', adapter_id: 'cuyahoga.delinquent_list', name: 'Cuyahoga Treasurer · delinquent tax list', authority_class: 'official', access_mode: 'bulk_file', host: 'cuyahoga-treasurer.sim', jurisdiction: 'Cuyahoga County, OH', finding_types: ['tax_delinquency', 'tax_status'], supports_negative: true }),
  cleCode: /* @__PURE__ */ fxSource({ source_id: 'fx-cle-code', adapter_id: 'cleveland.code_cases', name: 'Cleveland Building & Housing · code cases', authority_class: 'official', access_mode: 'open_api', host: 'cleveland-bh.sim', jurisdiction: 'Cuyahoga County, OH', finding_types: ['code_violation', 'condemnation'], supports_negative: true }),
  cuyClerk: /* @__PURE__ */ fxSource({ source_id: 'fx-cuy-clerk', adapter_id: 'cuyahoga.foreclosure_docket', name: 'Cuyahoga Common Pleas · foreclosure docket', authority_class: 'official', access_mode: 'official_lookup', host: 'cuyahoga-clerk.sim', jurisdiction: 'Cuyahoga County, OH', finding_types: ['foreclosure'], supports_negative: true }),
  cuyRecorder: /* @__PURE__ */ fxSource({ source_id: 'fx-cuy-recorder', adapter_id: 'cuyahoga.recorder_deeds', name: 'Cuyahoga Recorder · deeds', authority_class: 'official', access_mode: 'official_lookup', host: 'cuyahoga-recorder.sim', jurisdiction: 'Cuyahoga County, OH', finding_types: ['ownership'] }),

  // Duval County, FL
  duvalTax: /* @__PURE__ */ fxSource({ source_id: 'fx-duval-tax', adapter_id: 'duval.tax_collector', name: 'Duval Tax Collector', authority_class: 'official', access_mode: 'official_lookup', host: 'duval-tax-collector.sim', jurisdiction: 'Duval County, FL', finding_types: ['tax_status', 'tax_delinquency'] }),
  duvalPa: /* @__PURE__ */ fxSource({ source_id: 'fx-duval-pa', adapter_id: 'duval.property_appraiser', name: 'Duval Property Appraiser · tax roll', authority_class: 'official', access_mode: 'open_api', host: 'duval-appraiser.sim', jurisdiction: 'Duval County, FL', finding_types: ['tax_status', 'parcel'] }),
  duvalClerk: /* @__PURE__ */ fxSource({ source_id: 'fx-duval-clerk', adapter_id: 'duval.tax_deed_index', name: 'Duval Clerk · tax-deed index', authority_class: 'official', access_mode: 'official_lookup', host: 'duval-clerk.sim', jurisdiction: 'Duval County, FL', finding_types: ['tax_delinquency'], supports_negative: true }),
  duvalOr: /* @__PURE__ */ fxSource({ source_id: 'fx-duval-or', adapter_id: 'duval.official_records', name: 'Duval Official Records', authority_class: 'official', access_mode: 'official_lookup', host: 'duval-records.sim', jurisdiction: 'Duval County, FL', finding_types: ['ownership', 'parcel'] }),
  jaxCode: /* @__PURE__ */ fxSource({ source_id: 'fx-jax-code', adapter_id: 'jacksonville.code_compliance', name: 'Jacksonville Code Compliance', authority_class: 'official', access_mode: 'open_api', host: 'jax-code.sim', jurisdiction: 'Duval County, FL', finding_types: ['code_violation'] }),

  // Batch pilots
  stlAssessor: /* @__PURE__ */ fxSource({ source_id: 'fx-stl-assessor', adapter_id: 'stlouis.assessor', name: 'St. Louis City Assessor · parcels', authority_class: 'official', access_mode: 'open_api', host: 'stl-assessor.sim', jurisdiction: 'St. Louis City, MO', finding_types: ['parcel'] }),
  stlCollector: /* @__PURE__ */ fxSource({ source_id: 'fx-stl-collector', adapter_id: 'stlouis.collector_revenue', name: 'St. Louis Collector of Revenue', authority_class: 'official', access_mode: 'official_lookup', host: 'stl-collector.sim', jurisdiction: 'St. Louis City, MO', finding_types: ['tax_status', 'tax_delinquency'] }),
  stlCsb: /* @__PURE__ */ fxSource({ source_id: 'fx-stl-csb', adapter_id: 'stlouis.citizens_service', name: 'St. Louis Building Division · condemnations', authority_class: 'official', access_mode: 'open_api', host: 'stl-building.sim', jurisdiction: 'St. Louis City, MO', finding_types: ['code_violation', 'condemnation'], supports_negative: true }),
  henParcel: /* @__PURE__ */ fxSource({ source_id: 'fx-hen-parcel', adapter_id: 'hennepin.parcel', name: 'Hennepin County · property information', authority_class: 'official', access_mode: 'open_api', host: 'hennepin-property.sim', jurisdiction: 'Hennepin County, MN', finding_types: ['parcel', 'tax_status'] }),
  mplsCode: /* @__PURE__ */ fxSource({ source_id: 'fx-mpls-code', adapter_id: 'minneapolis.regulatory', name: 'Minneapolis Regulatory Services · violations', authority_class: 'official', access_mode: 'open_api', host: 'mpls-regulatory.sim', jurisdiction: 'Hennepin County, MN', finding_types: ['code_violation', 'condemnation'], supports_negative: true }),
} as const

export const ALL_SOURCES = /* @__PURE__ */ Object.values(SRC)
