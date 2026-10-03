/**
 * Research-destination registry DATA (versioned config module).
 *
 * Every record below was verified on 2026-10-02 by a read-only GET (status + framing headers)
 * and, for parcel deep links, by loading the link for real production properties in headless
 * Chromium and confirming the parcel/street rendered (evidence: tmp/browser/evidence/).
 * `embed` comes from the embedding audit (headers + real sandboxed iframe on localhost) —
 * never from assumption. See HOW-TO-ADD-A-COUNTY.md before adding anything.
 */
import type { DestinationRecord, EmbedMode, SandboxFlag } from './types'

export const REGISTRY_VERSION = '2026-10-02.1'
const V = '2026-10-02'

export const COVERED_COUNTIES: Readonly<Record<string, { name: string; state: string }>> = {
  'MN:hennepin': { name: 'Hennepin', state: 'MN' },
  'TX:dallas': { name: 'Dallas', state: 'TX' },
  'TX:tarrant': { name: 'Tarrant', state: 'TX' },
  'TX:harris': { name: 'Harris', state: 'TX' },
  'IN:marion': { name: 'Marion', state: 'IN' },
  'GA:fulton': { name: 'Fulton', state: 'GA' },
  'GA:dekalb': { name: 'DeKalb', state: 'GA' },
  'FL:miamidade': { name: 'Miami-Dade', state: 'FL' },
  'FL:broward': { name: 'Broward', state: 'FL' },
  'FL:hillsborough': { name: 'Hillsborough', state: 'FL' },
  'FL:duval': { name: 'Duval', state: 'FL' },
  'CA:losangeles': { name: 'Los Angeles', state: 'CA' },
  'NC:mecklenburg': { name: 'Mecklenburg', state: 'NC' },
  'AZ:maricopa': { name: 'Maricopa', state: 'AZ' },
  'IL:cook': { name: 'Cook', state: 'IL' },
}

type Rec = DestinationRecord
const county = (state: string, c: string) => ({ level: 'county' as const, state, county: c })
const city = (state: string, c: string, ci: string) => ({ level: 'city' as const, state, county: c, city: ci })
const stateScope = (state: string) => ({ level: 'state' as const, state })
const national = { level: 'national' as const }

/** Embed verdicts from the audit, keyed by record id (filled from evidence/results.json). */
const E = (embed: EmbedMode, sandbox?: readonly SandboxFlag[]) => ({ embed, ...(sandbox ? { sandbox } : {}) })
const BLOCKED = E('BLOCKED')
/** Audited: rendered fully with scripts but WITHOUT allow-same-origin. */
const SCRIPTED: readonly SandboxFlag[] = ['allow-scripts', 'allow-forms']
/** Audited: needed allow-same-origin (storage/cookies) to render. Safe for cross-origin content only. */
const SCRIPTED_SAME_ORIGIN: readonly SandboxFlag[] = ['allow-scripts', 'allow-same-origin', 'allow-forms']

export const DESTINATIONS: readonly Rec[] = [
  // ───────────────────────────── Hennepin County, MN ─────────────────────────────
  {
    id: 'mn-hennepin-pins', destination_type: 'ASSESSOR', scope: county('MN', 'hennepin'),
    display_name: 'Hennepin County Property Information', hosts: ['www16.co.hennepin.mn.us'],
    url: { kind: 'apn', template: 'https://www16.co.hennepin.mn.us/pins/pidresult.jsp?pid={apn}', normalize: 'digits', pattern: '^\\d{13}$', search_href: 'https://www16.co.hennepin.mn.us/pins/' },
    required_fields: ['apn'], ...E('EMBEDS', SCRIPTED), authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'deep', verified_by: 'content', last_verified_at: V,
    notes: 'PID = 13 digits (APN without dashes). Verified with 4 prod parcels; page shows value, tax, owner.',
  },
  {
    id: 'mn-hennepin-tax', destination_type: 'TAX', scope: county('MN', 'hennepin'),
    display_name: 'Hennepin County Property Tax Due', hosts: ['www16.co.hennepin.mn.us'],
    url: { kind: 'apn', template: 'https://www16.co.hennepin.mn.us/taxpayments/taxesdue.jsp?pid={apn}', normalize: 'digits', pattern: '^\\d{13}$', search_href: 'https://www16.co.hennepin.mn.us/pins/' },
    required_fields: ['apn'], ...E('EMBEDS', SCRIPTED), authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'deep', verified_by: 'content', last_verified_at: V,
    notes: 'Taxes-due page (county e-check flow). Research only — never pay from LeadCommand.',
  },
  {
    id: 'mn-hennepin-gis', destination_type: 'GIS', scope: county('MN', 'hennepin'),
    display_name: 'Hennepin County Property Map', hosts: ['gis.hennepin.us'],
    url: { kind: 'static', href: 'https://gis.hennepin.us/property/' },
    required_fields: [], ...E('EMBEDS', SCRIPTED_SAME_ORIGIN), authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'address', verified_by: 'status', last_verified_at: V,
  },
  {
    id: 'mn-hennepin-recorder', destination_type: 'RECORDER', scope: county('MN', 'hennepin'),
    display_name: 'Hennepin County Land Title Records', hosts: ['www.hennepincounty.gov'],
    url: { kind: 'static', href: 'https://www.hennepincounty.gov/services/property/land-title-records-access' },
    required_fields: [], ...BLOCKED, authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'apn', verified_by: 'status', last_verified_at: V,
    notes: 'Access page for recorded documents (online index requires the county subscription service).',
  },
  {
    id: 'mn-minneapolis-property-info', destination_type: 'PERMITS', scope: city('MN', 'hennepin', 'minneapolis'),
    display_name: 'Minneapolis Property Information (permits, inspections)', hosts: ['apps.ci.minneapolis.mn.us'],
    url: { kind: 'static', href: 'https://apps.ci.minneapolis.mn.us/PIApp/' },
    required_fields: [], ...BLOCKED, authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'address', verified_by: 'challenge', last_verified_at: V,
    notes: 'Cloudflare challenge to automated clients; X-Frame-Options SAMEORIGIN.',
  },

  // ───────────────────────────── Dallas County, TX ─────────────────────────────
  {
    id: 'tx-dallas-dcad', destination_type: 'ASSESSOR', scope: county('TX', 'dallas'),
    display_name: 'Dallas CAD — Residential Account', hosts: ['www.dallascad.org'],
    url: { kind: 'apn', template: 'https://www.dallascad.org/AcctDetailRes.aspx?ID={apn}', normalize: 'alnum_upper', pattern: '^[0-9A-Z]{17}$', search_href: 'https://www.dallascad.org/SearchAddr.aspx' },
    required_fields: ['apn'], ...E('EMBEDS', SCRIPTED), authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'deep', verified_by: 'content', last_verified_at: V,
    notes: 'DCAD account = APN without dashes (17 chars). Residential detail page; commercial accounts use the address search fallback.',
  },
  {
    id: 'tx-dallas-dcad-search', destination_type: 'COUNTY_PROPERTY_SEARCH', scope: county('TX', 'dallas'),
    display_name: 'Dallas CAD — Search by Address', hosts: ['www.dallascad.org'],
    url: { kind: 'static', href: 'https://www.dallascad.org/SearchAddr.aspx' },
    required_fields: [], ...E('EMBEDS', SCRIPTED), authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'address', verified_by: 'status', last_verified_at: V,
  },
  {
    id: 'tx-dallas-tax', destination_type: 'TAX', scope: county('TX', 'dallas'),
    display_name: 'Dallas County Tax Office — Property Search', hosts: ['www.dallasact.com'],
    url: { kind: 'static', href: 'https://www.dallasact.com/act_webdev/dallas/searchbyproperty.jsp' },
    required_fields: [], ...E('EMBEDS', SCRIPTED), authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'address', verified_by: 'status', last_verified_at: V,
  },
  {
    id: 'tx-dallas-clerk', destination_type: 'RECORDER', scope: county('TX', 'dallas'),
    display_name: 'Dallas County Clerk — Official Records', hosts: ['dallas.tx.publicsearch.us'],
    url: { kind: 'static', href: 'https://dallas.tx.publicsearch.us/' },
    required_fields: [], ...E('EMBEDS', SCRIPTED_SAME_ORIGIN), authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'address', verified_by: 'status', last_verified_at: V,
  },
  {
    id: 'tx-dallas-gis', destination_type: 'GIS', scope: county('TX', 'dallas'),
    display_name: 'DCAD Property Map', hosts: ['maps.dcad.org'],
    url: { kind: 'static', href: 'https://maps.dcad.org/prd/dpm/' },
    required_fields: [], ...E('EMBEDS', SCRIPTED_SAME_ORIGIN), authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'address', verified_by: 'status', last_verified_at: V,
  },

  // ───────────────────────────── Tarrant County, TX ─────────────────────────────
  {
    id: 'tx-tarrant-tad', destination_type: 'ASSESSOR', scope: county('TX', 'tarrant'),
    display_name: 'Tarrant Appraisal District — Property Search', hosts: ['tarrant.prodigycad.com'],
    url: { kind: 'static', href: 'https://tarrant.prodigycad.com/property-search' },
    required_fields: [], ...E('EMBEDS', SCRIPTED_SAME_ORIGIN), authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'apn', verified_by: 'status', last_verified_at: V,
    notes: '/property-detail/{account} did not render the parcel for GET-only loads — search page only.',
  },

  // ───────────────────────────── Harris County, TX ─────────────────────────────
  {
    id: 'tx-harris-hcad', destination_type: 'ASSESSOR', scope: county('TX', 'harris'),
    display_name: 'Harris Central Appraisal District — Property Search', hosts: ['search.hcad.org'],
    url: { kind: 'static', href: 'https://search.hcad.org/' },
    required_fields: [], ...BLOCKED, authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'apn', verified_by: 'challenge', last_verified_at: V,
    notes: 'HCAD account = APN digits (13). Cloudflare challenge to automated clients; XFO SAMEORIGIN.',
  },
  {
    id: 'tx-harris-tax', destination_type: 'TAX', scope: county('TX', 'harris'),
    display_name: 'Harris County Tax Office — Property Tax', hosts: ['www.hctax.net'],
    url: { kind: 'static', href: 'https://www.hctax.net/Property/PropertyTax' },
    required_fields: [], ...E('EMBEDS', SCRIPTED), authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'apn', verified_by: 'status', last_verified_at: V,
  },
  {
    id: 'tx-harris-clerk', destination_type: 'RECORDER', scope: county('TX', 'harris'),
    display_name: 'Harris County Clerk — Real Property Records', hosts: ['www.cclerk.hctx.net'],
    url: { kind: 'static', href: 'https://www.cclerk.hctx.net/applications/websearch/RP.aspx' },
    required_fields: [], ...E('EMBEDS', SCRIPTED), authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'address', verified_by: 'status', last_verified_at: V,
  },
  {
    id: 'tx-harris-gis', destination_type: 'GIS', scope: county('TX', 'harris'),
    display_name: 'HCAD Parcel Viewer', hosts: ['arcweb.hcad.org'],
    url: { kind: 'static', href: 'https://arcweb.hcad.org/parcel-viewer-v2.0/' },
    required_fields: [], ...E('EMBEDS', SCRIPTED), authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'address', verified_by: 'status', last_verified_at: V,
  },
  {
    id: 'tx-houston-permits', destination_type: 'PERMITS', scope: city('TX', 'harris', 'houston'),
    display_name: 'Houston Permitting Center', hosts: ['www.houstonpermittingcenter.org'],
    url: { kind: 'static', href: 'https://www.houstonpermittingcenter.org/' },
    required_fields: [], ...BLOCKED, authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'address', verified_by: 'status', last_verified_at: V,
  },

  // ───────────────────────────── Marion County, IN ─────────────────────────────
  {
    id: 'in-marion-property-cards', destination_type: 'ASSESSOR', scope: county('IN', 'marion'),
    display_name: 'Marion County Assessor — Property Cards', hosts: ['maps.indy.gov'],
    url: { kind: 'static', href: 'https://maps.indy.gov/AssessorPropertyCards/' },
    required_fields: [], ...E('EMBEDS', SCRIPTED_SAME_ORIGIN), authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'address', verified_by: 'status', last_verified_at: V,
    notes: 'Cards are keyed by the 7-digit local parcel number, which is NOT in our 18-digit state parcel id — search by address.',
  },
  {
    id: 'in-marion-mapindy', destination_type: 'GIS', scope: county('IN', 'marion'),
    display_name: 'MapIndy', hosts: ['maps.indy.gov'],
    url: { kind: 'static', href: 'https://maps.indy.gov/MapIndy/' },
    required_fields: [], ...E('EMBEDS', SCRIPTED_SAME_ORIGIN), authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'address', verified_by: 'status', last_verified_at: V,
  },
  {
    id: 'in-marion-treasurer', destination_type: 'TAX', scope: county('IN', 'marion'),
    display_name: 'Marion County Treasurer', hosts: ['www.indy.gov'],
    url: { kind: 'static', href: 'https://www.indy.gov/agency/marion-county-treasurer' },
    required_fields: [], ...BLOCKED, authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'apn', verified_by: 'status', last_verified_at: V,
  },
  {
    id: 'in-marion-recorder', destination_type: 'RECORDER', scope: county('IN', 'marion'),
    display_name: 'Marion County Recorder', hosts: ['www.indy.gov'],
    url: { kind: 'static', href: 'https://www.indy.gov/agency/marion-county-recorder' },
    required_fields: [], ...BLOCKED, authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'apn', verified_by: 'status', last_verified_at: V,
  },
  {
    id: 'in-indianapolis-bns', destination_type: 'PERMITS', scope: city('IN', 'marion', 'indianapolis'),
    display_name: 'Indianapolis Business & Neighborhood Services (permits, code)', hosts: ['www.indy.gov'],
    url: { kind: 'static', href: 'https://www.indy.gov/agency/department-of-business-and-neighborhood-services' },
    required_fields: [], ...BLOCKED, authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'address', verified_by: 'status', last_verified_at: V,
  },

  // ───────────────────────────── Fulton County, GA ─────────────────────────────
  {
    id: 'ga-fulton-qpublic', destination_type: 'ASSESSOR', scope: county('GA', 'fulton'),
    display_name: 'Fulton County Assessor (qPublic)', hosts: ['qpublic.schneidercorp.com'],
    url: { kind: 'static', href: 'https://qpublic.schneidercorp.com/Application.aspx?App=FultonCountyGA&Layer=Parcels&PageType=Search' },
    required_fields: [], ...BLOCKED, authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'apn', verified_by: 'challenge', last_verified_at: V,
    notes: 'County-contracted Schneider qPublic. Cloudflare challenge to automated clients; XFO SAMEORIGIN.',
  },
  {
    id: 'ga-fulton-tax', destination_type: 'TAX', scope: county('GA', 'fulton'),
    display_name: 'Fulton County Tax Commissioner', hosts: ['fultoncountytaxes.org'],
    url: { kind: 'static', href: 'https://fultoncountytaxes.org/' },
    required_fields: [], ...BLOCKED, authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'apn', verified_by: 'challenge', last_verified_at: V,
  },
  {
    id: 'ga-fulton-gis', destination_type: 'GIS', scope: county('GA', 'fulton'),
    display_name: 'Fulton County Maps', hosts: ['fultoncountyga.gov'],
    url: { kind: 'static', href: 'https://fultoncountyga.gov/maps' },
    required_fields: [], ...E('EMBEDS', SCRIPTED), authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'address', verified_by: 'status', last_verified_at: V,
  },
  {
    id: 'ga-fulton-gsccca', destination_type: 'RECORDER', scope: county('GA', 'fulton'),
    display_name: 'GSCCCA Real Estate Index (Georgia clerks)', hosts: ['search.gsccca.org'],
    url: { kind: 'static', href: 'https://search.gsccca.org/' },
    required_fields: [], ...E('EMBEDS', SCRIPTED), authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'address', verified_by: 'status', last_verified_at: V,
    notes: 'Statewide clerks index. Landing page embeds (audited); document search needs a GSCCCA account — the operator signs in on the site itself, never through LeadCommand.',
  },

  // ───────────────────────────── DeKalb County, GA ─────────────────────────────
  {
    id: 'ga-dekalb-assessor', destination_type: 'ASSESSOR', scope: county('GA', 'dekalb'),
    display_name: 'DeKalb County Property Appraisal', hosts: ['propertyappraisal.dekalbcountyga.gov'],
    url: { kind: 'static', href: 'https://propertyappraisal.dekalbcountyga.gov/' },
    required_fields: [], ...BLOCKED, authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'apn', verified_by: 'status', last_verified_at: V,
  },
  {
    id: 'ga-dekalb-tax', destination_type: 'TAX', scope: county('GA', 'dekalb'),
    display_name: 'DeKalb County Tax Commissioner', hosts: ['dekalbtaxga.gov'],
    url: { kind: 'static', href: 'https://dekalbtaxga.gov/' },
    required_fields: [], ...BLOCKED, authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'apn', verified_by: 'status', last_verified_at: V,
  },
  {
    id: 'ga-dekalb-gsccca', destination_type: 'RECORDER', scope: county('GA', 'dekalb'),
    display_name: 'GSCCCA Real Estate Index (Georgia clerks)', hosts: ['search.gsccca.org'],
    url: { kind: 'static', href: 'https://search.gsccca.org/' },
    required_fields: [], ...E('EMBEDS', SCRIPTED), authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'address', verified_by: 'status', last_verified_at: V,
    notes: 'Statewide clerks index. Landing page embeds (audited); document search needs a GSCCCA account.',
  },

  // ───────────────────────────── Miami-Dade County, FL ─────────────────────────────
  {
    id: 'fl-miamidade-pa', destination_type: 'ASSESSOR', scope: county('FL', 'miamidade'),
    display_name: 'Miami-Dade Property Appraiser', hosts: ['apps.miamidadepa.gov'],
    url: { kind: 'apn', template: 'https://apps.miamidadepa.gov/PropertySearch/#/?folio={apn}', normalize: 'digits', pattern: '^\\d{13}$', search_href: 'https://apps.miamidadepa.gov/PropertySearch/' },
    required_fields: ['apn'], ...BLOCKED, authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'deep', verified_by: 'content', last_verified_at: V,
    notes: 'Folio = 13 digits. Verified with 4 prod folios. frame-ancestors self + granicus only.',
  },
  {
    id: 'fl-miamidade-tax', destination_type: 'TAX', scope: county('FL', 'miamidade'),
    display_name: 'Miami-Dade Tax Collector', hosts: ['county-taxes.net'],
    url: { kind: 'static', href: 'https://county-taxes.net/fl-miamidade/property-tax' },
    required_fields: [], ...BLOCKED, authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'apn', verified_by: 'challenge', last_verified_at: V,
    notes: 'Grant Street county-taxes.net (miamidade.county-taxes.com redirects here). Cloudflare challenge; XFO SAMEORIGIN.',
  },
  {
    id: 'fl-miamidade-clerk', destination_type: 'RECORDER', scope: county('FL', 'miamidade'),
    display_name: 'Miami-Dade Clerk — Official Records', hosts: ['onlineservices.miamidadeclerk.gov'],
    url: { kind: 'static', href: 'https://onlineservices.miamidadeclerk.gov/officialrecords/' },
    required_fields: [], ...BLOCKED, authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'address', verified_by: 'status', last_verified_at: V,
  },
  {
    id: 'fl-miamidade-gis', destination_type: 'GIS', scope: county('FL', 'miamidade'),
    display_name: 'Miami-Dade GIS', hosts: ['gisweb.miamidade.gov', 'experience.arcgis.com'],
    url: { kind: 'static', href: 'https://gisweb.miamidade.gov/' },
    required_fields: [], ...E('EMBEDS', SCRIPTED), authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'address', verified_by: 'status', last_verified_at: V,
    notes: 'Redirects to the county ArcGIS Experience app.',
  },

  // ───────────────────────────── Broward County, FL ─────────────────────────────
  {
    id: 'fl-broward-bcpa', destination_type: 'ASSESSOR', scope: county('FL', 'broward'),
    display_name: 'Broward County Property Appraiser', hosts: ['web.bcpa.net'],
    url: { kind: 'static', href: 'https://web.bcpa.net/BcpaClient/#/Record-Search' },
    required_fields: [], ...BLOCKED, authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'apn', verified_by: 'status', last_verified_at: V,
    notes: 'No verified parcel deep link (#/Record/{folio} redirected home) — search page.',
  },
  {
    id: 'fl-broward-tax', destination_type: 'TAX', scope: county('FL', 'broward'),
    display_name: 'Broward County Tax Collector', hosts: ['county-taxes.net'],
    url: { kind: 'static', href: 'https://county-taxes.net/fl-broward/property-tax' },
    required_fields: [], ...BLOCKED, authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'apn', verified_by: 'challenge', last_verified_at: V,
  },
  {
    id: 'fl-broward-records', destination_type: 'RECORDER', scope: county('FL', 'broward'),
    display_name: 'Broward County Official Records', hosts: ['officialrecords.broward.org'],
    url: { kind: 'static', href: 'https://officialrecords.broward.org/AcclaimWeb' },
    required_fields: [], ...BLOCKED, authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'address', verified_by: 'status', last_verified_at: V,
  },
  {
    id: 'fl-broward-gis', destination_type: 'GIS', scope: county('FL', 'broward'),
    display_name: 'BCPA Web Map', hosts: ['gisweb-adapters.bcpa.net'],
    url: { kind: 'static', href: 'https://gisweb-adapters.bcpa.net/bcpawebmap_ex/bcpawebmap.aspx' },
    required_fields: [], ...E('EMBEDS', SCRIPTED), authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'address', verified_by: 'status', last_verified_at: V,
  },

  // ───────────────────────────── Hillsborough County, FL ─────────────────────────────
  {
    id: 'fl-hillsborough-hcpa', destination_type: 'ASSESSOR', scope: county('FL', 'hillsborough'),
    display_name: 'Hillsborough County Property Appraiser', hosts: ['gis.hcpafl.org'],
    url: { kind: 'static', href: 'https://gis.hcpafl.org/propertysearch/' },
    required_fields: [], ...E('EMBEDS', SCRIPTED), authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'apn', verified_by: 'status', last_verified_at: V,
    notes: 'No verified folio deep link — search page.',
  },
  {
    id: 'fl-hillsborough-tax', destination_type: 'TAX', scope: county('FL', 'hillsborough'),
    display_name: 'Hillsborough County Tax Collector', hosts: ['county-taxes.net'],
    url: { kind: 'static', href: 'https://county-taxes.net/fl-hillsborough/property-tax' },
    required_fields: [], ...BLOCKED, authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'apn', verified_by: 'challenge', last_verified_at: V,
  },
  {
    id: 'fl-hillsborough-clerk', destination_type: 'RECORDER', scope: county('FL', 'hillsborough'),
    display_name: 'Hillsborough Clerk — Official Records', hosts: ['publicaccess.hillsclerk.com'],
    url: { kind: 'static', href: 'https://publicaccess.hillsclerk.com/oripublicaccess/' },
    required_fields: [], ...E('UNKNOWN'), authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'address', verified_by: 'status', last_verified_at: V,
    notes: 'No framing headers, but the SPA rendered no content inside the test iframe — unproven, so external.',
  },

  // ───────────────────────────── Duval County, FL ─────────────────────────────
  {
    id: 'fl-duval-pao', destination_type: 'ASSESSOR', scope: county('FL', 'duval'),
    display_name: 'Duval County Property Appraiser', hosts: ['paopropertysearch.coj.net'],
    url: { kind: 'apn', template: 'https://paopropertysearch.coj.net/Basic/Detail.aspx?RE={apn}', normalize: 'digits', pattern: '^\\d{10}$', search_href: 'https://paopropertysearch.coj.net/Basic/Search.aspx' },
    required_fields: ['apn'], ...BLOCKED, authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'deep', verified_by: 'content', last_verified_at: V,
    notes: 'RE# = 10 digits. Verified with 4 prod parcels. frame-ancestors self.',
  },
  {
    id: 'fl-duval-tax', destination_type: 'TAX', scope: county('FL', 'duval'),
    display_name: 'Duval County Tax Collector', hosts: ['county-taxes.net'],
    url: { kind: 'static', href: 'https://county-taxes.net/fl-duval/property-tax' },
    required_fields: [], ...BLOCKED, authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'apn', verified_by: 'challenge', last_verified_at: V,
  },
  {
    id: 'fl-duval-clerk', destination_type: 'RECORDER', scope: county('FL', 'duval'),
    display_name: 'Duval Clerk — Official Records', hosts: ['or.duvalclerk.com'],
    url: { kind: 'static', href: 'https://or.duvalclerk.com/' },
    required_fields: [], ...BLOCKED, authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'address', verified_by: 'status', last_verified_at: V,
  },
  {
    id: 'fl-duval-gis', destination_type: 'GIS', scope: county('FL', 'duval'),
    display_name: 'Duval Property Map', hosts: ['maps.coj.net'],
    url: { kind: 'static', href: 'https://maps.coj.net/duvalproperty/' },
    required_fields: [], ...E('EMBEDS', SCRIPTED), authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'address', verified_by: 'status', last_verified_at: V,
  },

  // ───────────────────────────── Los Angeles County, CA ─────────────────────────────
  {
    id: 'ca-losangeles-assessor', destination_type: 'ASSESSOR', scope: county('CA', 'losangeles'),
    display_name: 'LA County Assessor — Parcel Detail', hosts: ['portal.assessor.lacounty.gov'],
    url: { kind: 'apn', template: 'https://portal.assessor.lacounty.gov/parceldetail/{apn}', normalize: 'digits', pattern: '^\\d{10}$', search_href: 'https://portal.assessor.lacounty.gov/' },
    required_fields: ['apn'], ...BLOCKED, authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'deep', verified_by: 'content', last_verified_at: V,
    notes: 'AIN = 10 digits. Verified with 4 prod parcels.',
  },
  {
    id: 'ca-losangeles-tax', destination_type: 'TAX', scope: county('CA', 'losangeles'),
    display_name: 'LA County Treasurer & Tax Collector — Property Tax', hosts: ['vcheck.ttc.lacounty.gov'],
    url: { kind: 'static', href: 'https://vcheck.ttc.lacounty.gov/' },
    required_fields: [], ...BLOCKED, authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'apn', verified_by: 'status', last_verified_at: V,
  },
  {
    id: 'ca-losangeles-recorder', destination_type: 'RECORDER', scope: county('CA', 'losangeles'),
    display_name: 'LA County Registrar-Recorder', hosts: ['www.lavote.gov'],
    url: { kind: 'static', href: 'https://www.lavote.gov/home/recorder' },
    required_fields: [], ...BLOCKED, authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'apn', verified_by: 'status', last_verified_at: V,
    notes: 'Information page; LA does not publish a free online grantor/grantee index.',
  },
  {
    id: 'ca-losangeles-gis', destination_type: 'GIS', scope: county('CA', 'losangeles'),
    display_name: 'LA County Assessor — Map Search', hosts: ['portal.assessor.lacounty.gov'],
    url: { kind: 'static', href: 'https://portal.assessor.lacounty.gov/mapsearch' },
    required_fields: [], ...BLOCKED, authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'apn', verified_by: 'status', last_verified_at: V,
  },
  {
    id: 'ca-losangeles-zimas', destination_type: 'CODE', scope: city('CA', 'losangeles', 'losangeles'),
    display_name: 'ZIMAS — City of LA Zoning & Parcel', hosts: ['zimas.lacity.org'],
    url: { kind: 'static', href: 'https://zimas.lacity.org/' },
    required_fields: [], ...BLOCKED, authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'address', verified_by: 'status', last_verified_at: V,
  },
  {
    id: 'ca-losangeles-ladbs', destination_type: 'PERMITS', scope: city('CA', 'losangeles', 'losangeles'),
    display_name: 'LADBS Online Services (permits)', hosts: ['www.ladbsservices2.lacity.org'],
    url: { kind: 'static', href: 'https://www.ladbsservices2.lacity.org/OnlineServices/' },
    required_fields: [], ...BLOCKED, authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'address', verified_by: 'status', last_verified_at: V,
  },

  // ───────────────────────────── Mecklenburg County, NC ─────────────────────────────
  {
    id: 'nc-mecklenburg-assessor', destination_type: 'ASSESSOR', scope: county('NC', 'mecklenburg'),
    display_name: 'Mecklenburg County Property Record Cards', hosts: ['property.spatialest.com'],
    url: { kind: 'static', href: 'https://property.spatialest.com/nc/mecklenburg/' },
    required_fields: [], ...BLOCKED, authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'apn', verified_by: 'status', last_verified_at: V,
    notes: '#/property/{pid} routes to #/404 — search page only.',
  },
  {
    id: 'nc-mecklenburg-polaris', destination_type: 'GIS', scope: county('NC', 'mecklenburg'),
    display_name: 'POLARIS 3G — Parcel', hosts: ['polaris3g.mecklenburgcountync.gov'],
    url: { kind: 'apn', template: 'https://polaris3g.mecklenburgcountync.gov/pid/{apn}', normalize: 'digits', pattern: '^\\d{8}$', search_href: 'https://polaris3g.mecklenburgcountync.gov/' },
    required_fields: ['apn'], ...BLOCKED, authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'deep', verified_by: 'content', last_verified_at: V,
    notes: 'PID = 8 digits. Verified with 4 prod parcels. frame-ancestors *.mecklenburgcountync.gov only.',
  },
  {
    id: 'nc-mecklenburg-tax', destination_type: 'TAX', scope: county('NC', 'mecklenburg'),
    display_name: 'Mecklenburg County Tax Bill Search', hosts: ['taxbill.co.mecklenburg.nc.us'],
    url: { kind: 'static', href: 'https://taxbill.co.mecklenburg.nc.us/publicwebaccess/' },
    required_fields: [], ...BLOCKED, authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'apn', verified_by: 'status', last_verified_at: V,
  },
  {
    id: 'nc-mecklenburg-rod', destination_type: 'RECORDER', scope: county('NC', 'mecklenburg'),
    display_name: 'Mecklenburg Register of Deeds', hosts: ['meckrod.manatron.com'],
    url: { kind: 'static', href: 'https://meckrod.manatron.com/' },
    required_fields: [], ...BLOCKED, authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'address', verified_by: 'status', last_verified_at: V,
  },

  // ───────────────────────────── Maricopa County, AZ ─────────────────────────────
  {
    id: 'az-maricopa-assessor', destination_type: 'ASSESSOR', scope: county('AZ', 'maricopa'),
    display_name: 'Maricopa County Assessor — Parcel', hosts: ['mcassessor.maricopa.gov'],
    url: { kind: 'apn', template: 'https://mcassessor.maricopa.gov/mcs/?q={apn}&mod=pd', normalize: 'alnum_upper', pattern: '^\\d{8}[A-Z]?$', search_href: 'https://mcassessor.maricopa.gov/' },
    required_fields: ['apn'], ...E('EMBEDS', SCRIPTED_SAME_ORIGIN), authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'deep', verified_by: 'content', last_verified_at: V,
    notes: 'APN = 8 digits + optional split letter (108-16-154-B → 10816154B). Verified with 4 prod parcels incl. lettered.',
  },
  {
    id: 'az-maricopa-treasurer', destination_type: 'TAX', scope: county('AZ', 'maricopa'),
    display_name: 'Maricopa County Treasurer', hosts: ['treasurer.maricopa.gov'],
    url: { kind: 'static', href: 'https://treasurer.maricopa.gov/' },
    required_fields: [], ...E('EMBEDS', SCRIPTED), authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'apn', verified_by: 'status', last_verified_at: V,
    notes: '/Parcel/?Parcel= did not render the parcel — search page only.',
  },
  {
    id: 'az-maricopa-recorder', destination_type: 'RECORDER', scope: county('AZ', 'maricopa'),
    display_name: 'Maricopa County Recorder — Document Search', hosts: ['legacy.recorder.maricopa.gov'],
    url: { kind: 'static', href: 'https://legacy.recorder.maricopa.gov/recdocdata/' },
    required_fields: [], ...BLOCKED, authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'address', verified_by: 'status', last_verified_at: V,
  },
  {
    id: 'az-maricopa-gis', destination_type: 'GIS', scope: county('AZ', 'maricopa'),
    display_name: 'Maricopa County Assessor Map', hosts: ['maps.mcassessor.maricopa.gov'],
    url: { kind: 'static', href: 'https://maps.mcassessor.maricopa.gov/' },
    required_fields: [], ...E('EMBEDS', SCRIPTED_SAME_ORIGIN), authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'apn', verified_by: 'status', last_verified_at: V,
  },

  // ───────────────────────────── Cook County, IL ─────────────────────────────
  {
    id: 'il-cook-assessor', destination_type: 'ASSESSOR', scope: county('IL', 'cook'),
    display_name: 'Cook County Assessor — PIN', hosts: ['www.cookcountyassessoril.gov'],
    url: { kind: 'apn', template: 'https://www.cookcountyassessoril.gov/pin/{apn}', normalize: 'digits', pattern: '^\\d{14}$', search_href: 'https://www.cookcountyassessoril.gov/' },
    required_fields: ['apn'], ...BLOCKED, authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'deep', verified_by: 'content', last_verified_at: V,
    notes: 'PIN = 14 digits. Verified with 4 prod PINs (cookcountyassessor.com redirects to .il.gov).',
  },
  {
    id: 'il-cook-treasurer', destination_type: 'TAX', scope: county('IL', 'cook'),
    display_name: 'Cook County Treasurer', hosts: ['www.cookcountytreasurer.com'],
    url: { kind: 'static', href: 'https://www.cookcountytreasurer.com/' },
    required_fields: [], ...E('EMBEDS', SCRIPTED_SAME_ORIGIN), authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'apn', verified_by: 'status', last_verified_at: V,
  },
  {
    id: 'il-cook-clerk', destination_type: 'RECORDER', scope: county('IL', 'cook'),
    display_name: 'Cook County Clerk — Recordings', hosts: ['crs.cookcountyclerkil.gov'],
    url: { kind: 'static', href: 'https://crs.cookcountyclerkil.gov/Search' },
    required_fields: [], ...BLOCKED, authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'apn', verified_by: 'status', last_verified_at: V,
  },
  {
    id: 'il-cook-gis', destination_type: 'GIS', scope: county('IL', 'cook'),
    display_name: 'CookViewer', hosts: ['maps.cookcountyil.gov'],
    url: { kind: 'static', href: 'https://maps.cookcountyil.gov/cookviewer/' },
    required_fields: [], ...E('EMBEDS', SCRIPTED_SAME_ORIGIN), authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'apn', verified_by: 'status', last_verified_at: V,
  },

  // ───────────────────────────── State corporate registries ─────────────────────────────
  {
    id: 'mn-sos', destination_type: 'STATE_CORPORATE', scope: stateScope('MN'),
    display_name: 'Minnesota Secretary of State — Business Search', hosts: ['mblsportal.sos.mn.gov'],
    url: { kind: 'static', href: 'https://mblsportal.sos.mn.gov/Business/Search' },
    required_fields: ['company_name'], ...BLOCKED, authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'company_name', verified_by: 'status', last_verified_at: V,
  },
  {
    id: 'tx-comptroller', destination_type: 'STATE_CORPORATE', scope: stateScope('TX'),
    display_name: 'Texas Comptroller — Franchise Tax Account Status', hosts: ['comptroller.texas.gov'],
    url: { kind: 'static', href: 'https://comptroller.texas.gov/taxes/franchise/account-status/search' },
    required_fields: ['company_name'], ...BLOCKED, authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'company_name', verified_by: 'status', last_verified_at: V,
    notes: 'Free public entity lookup (registered agent, officers). TX SOSDirect itself is a paid sign-in.',
  },
  {
    id: 'in-sos', destination_type: 'STATE_CORPORATE', scope: stateScope('IN'),
    display_name: 'Indiana Secretary of State — Business Search', hosts: ['bsd.sos.in.gov'],
    url: { kind: 'static', href: 'https://bsd.sos.in.gov/publicbusinesssearch' },
    required_fields: ['company_name'], ...E('UNKNOWN'), authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'company_name', verified_by: 'challenge', last_verified_at: V,
    notes: 'Returns 202 with an empty bot-check body to automated clients; embed unproven (blank in iframe).',
  },
  {
    id: 'ga-sos', destination_type: 'STATE_CORPORATE', scope: stateScope('GA'),
    display_name: 'Georgia Secretary of State — Business Search', hosts: ['ecorp.sos.ga.gov'],
    url: { kind: 'static', href: 'https://ecorp.sos.ga.gov/BusinessSearch' },
    required_fields: ['company_name'], ...BLOCKED, authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'company_name', verified_by: 'status', last_verified_at: V,
  },
  {
    id: 'fl-sunbiz', destination_type: 'STATE_CORPORATE', scope: stateScope('FL'),
    display_name: 'Florida Sunbiz — Entity Name Search', hosts: ['search.sunbiz.org'],
    url: { kind: 'company', template: 'https://search.sunbiz.org/Inquiry/CorporationSearch/SearchResults?inquiryType=EntityName&searchTerm={name}' },
    required_fields: ['company_name'], ...BLOCKED, authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'deep', verified_by: 'content', last_verified_at: V,
    notes: 'searchTerm verified (results list rendered for the term).',
  },
  {
    id: 'ca-sos', destination_type: 'STATE_CORPORATE', scope: stateScope('CA'),
    display_name: 'California bizfile — Business Search', hosts: ['bizfileonline.sos.ca.gov'],
    url: { kind: 'static', href: 'https://bizfileonline.sos.ca.gov/search/business' },
    required_fields: ['company_name'], ...E('UNKNOWN'), authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'company_name', verified_by: 'status', last_verified_at: V,
  },
  {
    id: 'nc-sos', destination_type: 'STATE_CORPORATE', scope: stateScope('NC'),
    display_name: 'North Carolina Secretary of State — Business Search', hosts: ['www.sosnc.gov'],
    url: { kind: 'static', href: 'https://www.sosnc.gov/online_services/search/by_title/_Business_Registration' },
    required_fields: ['company_name'], ...BLOCKED, authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'company_name', verified_by: 'challenge', last_verified_at: V,
  },
  {
    id: 'az-acc', destination_type: 'STATE_CORPORATE', scope: stateScope('AZ'),
    display_name: 'Arizona Corporation Commission — Business Search', hosts: ['arizonabusinesscenter.azcc.gov'],
    url: { kind: 'static', href: 'https://arizonabusinesscenter.azcc.gov/businesssearch' },
    required_fields: ['company_name'], ...E('EMBEDS', SCRIPTED_SAME_ORIGIN), authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'company_name', verified_by: 'status', last_verified_at: V,
    notes: 'ecorp.azcc.gov no longer resolves (ENOTFOUND 2026-10-02).',
  },
  {
    id: 'il-sos', destination_type: 'STATE_CORPORATE', scope: stateScope('IL'),
    display_name: 'Illinois Secretary of State — Business Entity Search', hosts: ['apps.ilsos.gov'],
    url: { kind: 'static', href: 'https://apps.ilsos.gov/businessentitysearch/' },
    required_fields: ['company_name'], ...BLOCKED, authority: 'Official', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'company_name', verified_by: 'status', last_verified_at: V,
  },

  // ───────────────────────────── Market + maps (national) ─────────────────────────────
  {
    id: 'zillow', destination_type: 'ZILLOW', scope: national,
    display_name: 'Zillow', hosts: ['www.zillow.com'],
    url: { kind: 'zillow_address' },
    required_fields: ['street', 'city', 'state'], ...BLOCKED, authority: 'Commercial', confidence: 'VERIFIED', enabled: true,
    link_kind: 'deep', verified_by: 'content', last_verified_at: V,
    notes: 'Public /homes/{address}_rb/ redirects to the home page (verified). Navigation only; CSP frame-ancestors none; bot-blocks headless.',
  },
  {
    id: 'redfin', destination_type: 'REDFIN', scope: national,
    display_name: 'Redfin — ZIP market', hosts: ['www.redfin.com'],
    url: { kind: 'zip', template: 'https://www.redfin.com/zipcode/{zip}' },
    required_fields: ['zip'], ...BLOCKED, authority: 'Commercial', confidence: 'VERIFIED', enabled: true,
    link_kind: 'search', copy_hint: 'address', verified_by: 'status', last_verified_at: V,
    notes: 'No public address URL pattern — ZIP page + address to copy. Navigation only.',
  },
  {
    id: 'realtor', destination_type: 'REALTOR', scope: national,
    display_name: 'Realtor.com', hosts: ['www.realtor.com'],
    url: { kind: 'static', href: 'https://www.realtor.com/' },
    required_fields: [], ...BLOCKED, authority: 'Commercial', confidence: 'GENERIC', enabled: true,
    link_kind: 'search', copy_hint: 'address', verified_by: 'challenge', last_verified_at: V,
    notes: 'Returns 429 to automated clients, so no URL pattern could be verified — home page + address to copy.',
  },
  {
    id: 'google-maps', destination_type: 'GOOGLE_MAPS', scope: national,
    display_name: 'Google Maps', hosts: ['www.google.com'],
    url: { kind: 'maps_query' },
    required_fields: ['street', 'city', 'state'], ...BLOCKED, authority: 'Commercial', confidence: 'VERIFIED', enabled: true,
    link_kind: 'deep', verified_by: 'documented', last_verified_at: V,
    notes: 'Google Maps URLs API (maps/search/?api=1&query=). XFO SAMEORIGIN.',
  },
  {
    id: 'street-view', destination_type: 'STREET_VIEW', scope: national,
    display_name: 'Google Street View', hosts: ['www.google.com'],
    url: { kind: 'street_view' },
    required_fields: ['lat_lng'], ...BLOCKED, authority: 'Commercial', confidence: 'VERIFIED', enabled: true,
    link_kind: 'deep', verified_by: 'documented', last_verified_at: V,
    notes: 'Google Maps URLs API (map_action=pano&viewpoint=lat,lng).',
  },

  // ───────────────────────────── Search (national) ─────────────────────────────
  {
    id: 'web-search-property', destination_type: 'WEB_SEARCH', scope: national,
    display_name: 'Search the web', hosts: ['www.google.com', 'www.bing.com', 'duckduckgo.com'],
    url: { kind: 'web_search', subject: 'property' },
    required_fields: ['street', 'city', 'state'], ...BLOCKED, authority: 'Search', confidence: 'GENERIC', enabled: true,
    link_kind: 'deep', verified_by: 'documented', last_verified_at: V,
    notes: 'Query = street, city, ST only. Embed audit: Google + DuckDuckGo refuse framing; Bing /search sent no XFO but rendered an empty results pane under the standard sandbox — treated as external.',
  },
  {
    id: 'web-search-county-site', destination_type: 'COUNTY_PROPERTY_SEARCH', scope: national,
    display_name: 'Find the county property search', hosts: ['www.google.com', 'www.bing.com', 'duckduckgo.com'],
    url: { kind: 'web_search', subject: 'county_site' },
    required_fields: ['state'], ...BLOCKED, authority: 'Search', confidence: 'GENERIC', enabled: true,
    link_kind: 'deep', verified_by: 'documented', last_verified_at: V,
    notes: 'Fallback for uncovered jurisdictions: searches "<County> County <ST> property search" — no property data in the query.',
  },
  {
    id: 'web-search-company', destination_type: 'WEB_SEARCH', scope: national,
    display_name: 'Search the web for this company', hosts: ['www.google.com', 'www.bing.com', 'duckduckgo.com'],
    url: { kind: 'web_search', subject: 'company' },
    required_fields: ['company_name'], ...BLOCKED, authority: 'Search', confidence: 'GENERIC', enabled: true,
    link_kind: 'deep', verified_by: 'documented', last_verified_at: V,
  },
]
