/**
 * S6 county-record discovery: source catalog (DESIGN ONLY; no live wiring).
 *
 * Each entry describes one public record source that can corroborate or
 * contradict a vendor distress flag. The values here were observed by
 * read-only spot checks on 2026-10-08 (layer metadata + count queries only).
 * See ~/.claude/jobs/c39b0175/tmp/s6/S6_DESIGN.md for the full catalog.
 *
 * Nothing imports this module from a route, job or cron. Adding a fetch
 * schedule is an owner decision.
 */

export const SOURCE_TYPE = Object.freeze({
  TAX_DELINQUENCY: 'tax_delinquency',
  TAX_SALE: 'tax_sale',
  CODE_ENFORCEMENT: 'code_enforcement',
  VACANT_REGISTRY: 'vacant_registry',
  CONDEMNATION: 'condemnation',
  DEMOLITION: 'demolition',
  LIS_PENDENS: 'lis_pendens',
  SHERIFF_SALE: 'sheriff_sale',
  LAND_BANK: 'land_bank',
  PARCEL_ROLL: 'parcel_roll',
});

export const ACCESS = Object.freeze({
  ARCGIS_REST: 'arcgis_rest', // FeatureServer/MapServer query API, paged JSON
  SOCRATA: 'socrata', // SODA API, paged JSON/CSV
  BULK_FILE: 'bulk_file', // CSV/XLSX/ZIP download
  PDF_LIST: 'pdf_list', // published PDF; parse manually, low cadence
  SEARCH_HTML: 'search_html', // per-parcel lookup page only; verification, not discovery
  BLOCKED: 'blocked', // 403 / paid / captcha; do not automate
});

/**
 * Per-source freshness ceiling in days: an observation older than this (by
 * retrieved_at, and by the source's own record/as-of date) is not a fact for
 * targeting, only history.
 */
export const FRESHNESS_DAYS = Object.freeze({
  [SOURCE_TYPE.TAX_DELINQUENCY]: 30,
  [SOURCE_TYPE.TAX_SALE]: 30,
  [SOURCE_TYPE.CODE_ENFORCEMENT]: 30, // status must be re-read; open-status only
  [SOURCE_TYPE.VACANT_REGISTRY]: 60,
  [SOURCE_TYPE.CONDEMNATION]: 30,
  [SOURCE_TYPE.DEMOLITION]: 30,
  [SOURCE_TYPE.LIS_PENDENS]: 30,
  [SOURCE_TYPE.SHERIFF_SALE]: 14,
  [SOURCE_TYPE.LAND_BANK]: 30,
  [SOURCE_TYPE.PARCEL_ROLL]: 30,
});

/**
 * Pilot sources (open, machine-readable, parcel-keyed). `fields` maps the
 * source's columns onto the canonical observation shape used by ingest.js.
 */
export const PILOT_SOURCES = Object.freeze([
  {
    id: 'cle_property_insights',
    county: 'Cuyahoga',
    fips: '39035',
    jurisdiction: 'City of Cleveland only (suburban parcels are absent)',
    types: [SOURCE_TYPE.TAX_DELINQUENCY, SOURCE_TYPE.CODE_ENFORCEMENT, SOURCE_TYPE.LAND_BANK, SOURCE_TYPE.PARCEL_ROLL],
    access: ACCESS.ARCGIS_REST,
    url: 'https://services3.arcgis.com/dty2kHktVXHrqO8i/arcgis/rest/services/Parcel_Analytics_(PUBLIC_DRAFT_)/FeatureServer/0',
    maxRecordCount: 2000,
    observed: { checkedAt: '2026-10-08', lastEdit: '2026-10-05', rows: 162875, taxDelinquentRows: 23004 },
    apnField: 'parcelpinDashed',
    fields: {
      owner: 'parcel_owner',
      situs: 'par_addr_all',
      taxDelinquent: 'isTaxDelinquent',
      taxDelinquentAmount: 'taxDelinquencyAmount',
      certSold: 'cert_sold_flag',
      foreclosureFlag: 'foreclosure_flag',
      paymentPlan: 'payment_plan_flag',
      codeViolations6mo: 'numBuildingCodeViolationsLast6Mo',
      lastCodeViolationDate: 'lastBuildingCodeViolationDate',
      countyLandBank: 'isCountyLandBank',
      cityLandBank: 'isCityLandBank',
      cityOwned: 'isCityOwned',
      lastTransferDate: 'last_transfer_date',
      rentalRegistered: 'activeRentalRegistrationFlag',
      recordDate: 'taxbill_update_date',
    },
    reliability: 'high: county tax bill + city building data, refreshed ~daily; draft label on the layer',
  },
  {
    id: 'cle_active_condemnations',
    county: 'Cuyahoga',
    fips: '39035',
    jurisdiction: 'City of Cleveland',
    types: [SOURCE_TYPE.CONDEMNATION],
    access: ACCESS.ARCGIS_REST,
    url: 'https://services3.arcgis.com/dty2kHktVXHrqO8i/arcgis/rest/services/Current_Condemnations/FeatureServer/0',
    maxRecordCount: 1000,
    observed: { checkedAt: '2026-10-08', lastEdit: '2026-10-04', rows: 2592 },
    apnField: 'Parcel_Number',
    fields: { situs: 'Address', caseDate: 'Condemnation_Date', status: 'Active_Condemnation' },
    reliability: 'high: list is active-only by construction',
  },
  {
    id: 'cbus_code_cases',
    county: 'Franklin',
    fips: '39049',
    jurisdiction: 'City of Columbus',
    types: [SOURCE_TYPE.CODE_ENFORCEMENT, SOURCE_TYPE.VACANT_REGISTRY],
    access: ACCESS.ARCGIS_REST,
    url: 'https://maps2.columbus.gov/arcgis/rest/services/Schemas/BuildingZoning/MapServer/23',
    maxRecordCount: 1000,
    observed: { checkedAt: '2026-10-08', newestCaseFiled: '2026-10-05', rows: 318004 },
    apnField: 'B1_PARCEL_NBR',
    fields: {
      caseId: 'B1_ALT_ID',
      caseType: 'B1_PER_TYPE',
      caseSubType: 'B1_PER_SUB_TYPE',
      caseDate: 'B1_FILE_DD',
      status: 'B1_APPL_STATUS',
      situs: 'SITE_ADDRESS',
      lastInspectionDate: 'INSP_LAST_DATE',
      lastInspectionResult: 'INSP_LAST_RESULT',
    },
    reliability: 'high for open/closed status; includes noise/zoning/vehicle cases that are not distress',
  },
  {
    id: 'franklin_tax_lien_list',
    county: 'Franklin',
    fips: '39049',
    jurisdiction: 'Franklin County',
    types: [SOURCE_TYPE.TAX_SALE, SOURCE_TYPE.TAX_DELINQUENCY],
    access: ACCESS.BULK_FILE,
    url: 'https://treasurer.franklincountyohio.gov/files/assets/treasurer/v/1/documents/final-tax-lien-list-2025.csv',
    observed: { checkedAt: '2026-10-08', asOf: '2025-10-27', note: 'annual; stale for targeting, use as history + verify per parcel' },
    apnField: null, // columns not yet inspected (no download performed)
    fields: {},
    reliability: 'authoritative but annual; a 2025 listing is history, not current delinquency',
  },
  {
    id: 'det_blight_tickets',
    county: 'Wayne',
    fips: '26163',
    jurisdiction: 'City of Detroit',
    types: [SOURCE_TYPE.CODE_ENFORCEMENT],
    access: ACCESS.ARCGIS_REST,
    url: 'https://services2.arcgis.com/qvkbeam7Wirps6zC/arcgis/rest/services/blight_tickets/FeatureServer/0',
    maxRecordCount: 1000,
    observed: { checkedAt: '2026-10-08', lastEdit: '2026-10-07', rows: 907655, defect: 'ticket_issued_date contains impossible years (e.g. 8535-09-25)' },
    apnField: 'parcel_id',
    fields: {
      caseId: 'ticket_number',
      caseType: 'ordinance_description',
      caseDate: 'ticket_issued_date',
      judgmentDate: 'judgment_date',
      amountDue: 'amt_balance_due',
      paymentStatus: 'payment_status',
      owner: 'property_owner_name',
      situs: 'address',
      updatedAt: 'ticket_updated_at',
    },
    reliability: 'medium: unpaid balances persist for years; dates need validation',
  },
  {
    id: 'det_dlba_buildings',
    county: 'Wayne',
    fips: '26163',
    jurisdiction: 'City of Detroit',
    types: [SOURCE_TYPE.LAND_BANK],
    access: ACCESS.ARCGIS_REST,
    url: 'https://services2.arcgis.com/qvkbeam7Wirps6zC/arcgis/rest/services/development_opportunities_dlba_buildings/FeatureServer/0',
    maxRecordCount: 1000,
    observed: { checkedAt: '2026-10-08', lastEdit: '2026-10-07', rows: 1794 },
    apnField: 'parcel_id',
    fields: { caseId: 'dlba_case_number', situs: 'address' },
    reliability: 'high; land-bank-owned parcels are an EXCLUSION (no private seller)',
  },
]);

export function getPilotSource(id) {
  return PILOT_SOURCES.find((s) => s.id === id) || null;
}
