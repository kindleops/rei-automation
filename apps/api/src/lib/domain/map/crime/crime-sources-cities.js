/**
 * CRIME SOURCES — the 2026-10-05 expansion. Every endpoint below was queried
 * live, without a key, on 2026-10-05 (job map-overlays/SOURCES.txt); field
 * names are copied from the live responses.
 *
 * Privacy, uniformly: many of these cities geocode to the exact address, so
 * EVERY point here is rounded to 3 decimals (about 100 m) before it leaves
 * this module — coarser than any city's own block generalisation. Only
 * offense words, a date/time and the rounded point are read; no address,
 * case/report number (a key is only hashed for de-duplication), name,
 * victim, suspect, officer or narrative field is ever selected for output.
 *
 * Not covered, and why, is in CITY_NOT_COVERED (no coordinates, stale, bulk
 * CSV only, no feed) so the Map can say so instead of drawing nothing.
 */
import { arcgisBox, arcgisSince, cityDay, cityTime, familyFromCrimeAgainst, joinDayTime, socrataSince } from './crime-sources.js'

const clean = (v) => (v === null || v === undefined ? '' : String(v).trim())
const num = (v) => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN; return Number.isFinite(n) ? n : null }
const titleCase = (s) => clean(s).toLowerCase().replace(/[-_]+/g, ' ').replace(/\b([a-z])/g, (m) => m.toUpperCase())
const r3 = (v) => (v === null ? null : Number(v.toFixed(3)))
/**
 * LAPD's "statute - code - grade - words - NIBRS" string → the words only:
 *   "459 - PC - F - BFMV- Burglary From Motor Vehicle  - 23F" → "Burglary From Motor Vehicle"
 *   "484(A) - PC - M - Petty Theft - All Other Larceny - 23H"   → "Petty Theft - All Other Larceny"
 */
export function lapdWords(s) {
  const parts = clean(s).split(/\s+-\s+/).map((x) => x.trim()).filter(Boolean)
  const kept = parts.slice(1).filter((x) => !/^[A-Z]{1,3}$/.test(x) && !/^\d{2,3}[A-Z]?$/.test(x)).map((x) => x.replace(/^[A-Z]{2,6}-\s*/, ''))
  return titleCase((kept.length ? kept : parts).join(' - ').replace(/\s{2,}/g, ' '))
}
const ROUNDED = 'Rounded by LeadCommand to about 100 m (the city publishes the address)'
const BLOCKISH = 'Generalised to the block by the city; LeadCommand rounds to about 100 m'

/** Reject a point that is not a real place (0,0 / -1,-1 masks) or outside the city's own extent. */
const placed = (lat, lng, b) => lat !== null && lng !== null && lat >= b.south - 0.2 && lat <= b.north + 0.2 && lng >= b.west - 0.2 && lng <= b.east + 0.2

/**
 * An ArcGIS layer source. `pick(attrs, geometry)` returns the city's own
 * words and coordinates; the factory owns the query, the date bound and the
 * rounding.
 */
function arcgis(cfg) {
  const { layer, dateField, outFields, tz, extraWhere, maxRows, pick } = cfg
  const urlFor = (layerUrl) => ({ box, sinceMs, limit }) => {
    const where = [arcgisSince(dateField, sinceMs), extraWhere].filter(Boolean).join(' AND ')
    const q = new URLSearchParams({ where, ...arcgisBox(box), outFields, ...(cfg.unordered ? {} : { orderByFields: `${dateField} DESC` }), resultRecordCount: String(Math.min(limit, maxRows || limit)) })
    return `${layerUrl}/query?${q}`
  }
  return {
    ...cfg,
    max_rows: maxRows || null,
    ...(Array.isArray(layer) ? { urls: (q) => layer.map((l) => ({ url: urlFor(l.url)(q), tag: l.tag })) } : { url: urlFor(layer) }),
    rows: (body) => {
      if (body?.error) throw new Error('source_query_error')
      return Array.isArray(body?.features) ? body.features : []
    },
    normalize: (f) => {
      const a = f?.attributes || {}
      const p = pick(a, f?.geometry || {}, f?.__tag)
      if (!p) return null
      const lat = num(p.lat)
      const lng = num(p.lng)
      const category = titleCase(p.category)
      if (!placed(lat, lng, cfg.bounds) || !category || !clean(p.key)) return null
      const day = p.day !== undefined ? p.day : cityDay(p.when, tz)
      return { key: `${cfg.source_id}:${clean(p.key)}`, category, offense: p.offense ? titleCase(p.offense) : null, family: p.family || 'other', occurred_on: day, occurred_at: p.at !== undefined ? p.at : cityTime(p.when, tz), lat: r3(lat), lng: r3(lng) }
    },
  }
}

/** A Socrata dataset source. `geo(box)` is the dataset's own spatial clause. */
function socrata(cfg) {
  const { domain, id, dateField, select, geo, extraWhere, pick, tz } = cfg
  return {
    ...cfg,
    url: ({ box, sinceMs, limit }) => {
      const q = new URLSearchParams({ $select: select, $where: `${socrataSince(dateField, sinceMs)}${extraWhere ? `${extraWhere} AND ` : ''}${geo(box)}`, $order: `${dateField} DESC`, $limit: String(limit) })
      return `https://${domain}/resource/${id}.json?${q}`
    },
    rows: (body) => (Array.isArray(body) ? body : []),
    normalize: (r) => {
      const p = pick(r)
      if (!p) return null
      const lat = num(p.lat)
      const lng = num(p.lng)
      const category = titleCase(p.category)
      if (!placed(lat, lng, cfg.bounds) || !category || !clean(p.key)) return null
      const day = p.day !== undefined ? p.day : cityDay(p.when, tz)
      return { key: `${cfg.source_id}:${clean(p.key)}`, category, offense: p.offense ? titleCase(p.offense) : null, family: p.family || 'other', occurred_on: day, occurred_at: p.at !== undefined ? p.at : cityTime(p.when, tz), lat: r3(lat), lng: r3(lng) }
    },
  }
}
const sBox = (latF, lngF) => (b) => `${latF} between ${b.south.toFixed(5)} and ${b.north.toFixed(5)} AND ${lngF} between ${b.west.toFixed(5)} and ${b.east.toFixed(5)}`
const sWithin = (geoF) => (b) => `within_box(${geoF}, ${b.north.toFixed(5)}, ${b.west.toFixed(5)}, ${b.south.toFixed(5)}, ${b.east.toFixed(5)})`

const CHI = 'America/Chicago'
const NYC = 'America/New_York'
const LAX = 'America/Los_Angeles'
const DEN = 'America/Denver'

const HOU_LAYER = 'https://mycity2.houstontx.gov/gisweb02/rest/services/HPD/NIBRS_Recent_Crime_Reports/FeatureServer'

export const CITY_CRIME_SOURCES = [
  arcgis({
    source_id: 'tx_houston_hpd', city: 'Houston', state: 'TX', publisher: 'Houston Police Department',
    bounds: { west: -95.8, south: 29.5, east: -95.0, north: 30.15 }, metadata_hosts: ['mycity2.houstontx.gov'],
    attribution: 'City of Houston · Houston Police Department (NIBRS Recent Crime Reports)', licence: 'HPD disclaimer (no use restriction stated)',
    terms_url: 'https://www.houstontx.gov/police/cs/Monthly_Crime_Data_by_Street_and_Police_Beat.htm', dataset_url: 'https://mycity2.houstontx.gov/gisweb02/rest/services/HPD/NIBRS_Recent_Crime_Reports/FeatureServer',
    lag_note: 'HPD publishes a rolling 30 days only (All = 30 days here)', location_note: BLOCKISH,
    // Groups A Person / Property / Society: one query per published layer (the layer IS the crime-against).
    layer: [{ url: `${HOU_LAYER}/0`, tag: 'person' }, { url: `${HOU_LAYER}/1`, tag: 'property' }, { url: `${HOU_LAYER}/2`, tag: 'society' }],
    dateField: 'USER_RMSOccurrenceDate', tz: CHI, maxRows: 2000,
    outFields: 'OBJECTID,USER_RMSOccurrenceDate,USER_RMSOccurrenceHour,USER_NIBRSDescription',
    pick: (a, g, tag) => {
      const day = cityDay(a.USER_RMSOccurrenceDate, 'UTC')
      const h = num(a.USER_RMSOccurrenceHour)
      return { key: `${tag}:${a.OBJECTID}`, category: a.USER_NIBRSDescription, family: tag, when: a.USER_RMSOccurrenceDate, day, at: day && h !== null && h > 0 && h < 24 ? `${day}T${String(h).padStart(2, '0')}:00` : null, lat: g.y, lng: g.x }
    },
  }),
  arcgis({
    source_id: 'tx_fortworth_fwpd', city: 'Fort Worth', state: 'TX', publisher: 'Fort Worth Police Department',
    bounds: { west: -97.6, south: 32.55, east: -97.03, north: 33.05 }, metadata_hosts: ['mapit.fortworthtexas.gov'],
    attribution: 'City of Fort Worth Open Data · Fort Worth Police Department (Crime Data)', licence: 'City of Fort Worth open data (no licence stated on the item)',
    terms_url: 'https://data.fortworthtexas.gov/', dataset_url: 'https://mapit.fortworthtexas.gov/ags/rest/services/CIVIC/Crime_Data/MapServer/0',
    lag_note: 'Updated daily by the city', location_note: ROUNDED,
    layer: 'https://mapit.fortworthtexas.gov/ags/rest/services/CIVIC/Crime_Data/MapServer/0', dateField: 'From_Date', tz: CHI, maxRows: 1000,
    outFields: 'OBJECTID,From_Date,Offense_Desc,Nature_Of_Call,Latitude,Longitude',
    pick: (a) => ({ key: a.OBJECTID, category: a.Offense_Desc || a.Nature_Of_Call, offense: a.Nature_Of_Call && a.Nature_Of_Call !== a.Offense_Desc ? a.Nature_Of_Call : null, when: a.From_Date, lat: a.Latitude, lng: a.Longitude }),
  }),
  arcgis({
    source_id: 'ga_atlanta_apd', city: 'Atlanta', state: 'GA', publisher: 'Atlanta Police Department',
    bounds: { west: -84.56, south: 33.64, east: -84.28, north: 33.89 }, metadata_hosts: ['services3.arcgis.com'],
    attribution: 'Atlanta Police Department Open Data (Crime)', licence: 'City of Atlanta open data (no licence stated on the item)',
    terms_url: 'https://opendata.atlantapd.org/', dataset_url: 'https://opendata.atlantapd.org/',
    lag_note: 'Updated daily by APD', location_note: ROUNDED,
    layer: 'https://services3.arcgis.com/Et5Qfajgiyosiw4d/arcgis/rest/services/OpenDataWebsite_Crime_view/FeatureServer/0', dateField: 'OccurredFromDate', tz: NYC, maxRows: 2000,
    extraWhere: 'OccurredFromDate < CURRENT_TIMESTAMP',
    outFields: 'OBJECTID,OccurredFromDate,Crime_Against,NIBRS_Offense,Latitude,Longitude',
    pick: (a, g) => ({ key: a.OBJECTID, category: a.NIBRS_Offense, family: familyFromCrimeAgainst(a.Crime_Against), when: a.OccurredFromDate, lat: a.Latitude ?? g.y, lng: a.Longitude ?? g.x }),
  }),
  arcgis({
    source_id: 'fl_tampa_tpd', city: 'Tampa', state: 'FL', publisher: 'Tampa Police Department',
    bounds: { west: -82.65, south: 27.85, east: -82.25, north: 28.18 }, metadata_hosts: ['services1.arcgis.com'],
    attribution: 'City of Tampa · Tampa Police Department (Crimes, last 365 days)', licence: 'City of Tampa open data (no licence stated on the item)',
    terms_url: 'https://policedepartmenthub-tampa.hub.arcgis.com/', dataset_url: 'https://policedepartmenthub-tampa.hub.arcgis.com/',
    lag_note: 'Rolling 365 days, refreshed nightly (All = 365 days here)', location_note: ROUNDED,
    layer: 'https://services1.arcgis.com/IbNXlmt2RVVRCZ6M/arcgis/rest/services/crimes_public_365days/FeatureServer/0', dateField: 'occurfrdate', tz: NYC, maxRows: 2000,
    outFields: 'OBJECTID,occurfrdate,nibrsdesc,nibrsoffense,nibrscrimeag',
    pick: (a, g) => ({ key: a.OBJECTID, category: a.nibrsdesc || a.nibrsoffense, family: familyFromCrimeAgainst(clean(a.nibrscrimeag).replace(/^crimes against /i, '')), when: a.occurfrdate, lat: g.y, lng: g.x }),
  }),
  arcgis({
    source_id: 'fl_jacksonville_jso', city: 'Jacksonville', state: 'FL', publisher: "Jacksonville Sheriff's Office",
    bounds: { west: -82.05, south: 30.1, east: -81.3, north: 30.6 }, metadata_hosts: ['services3.arcgis.com'],
    attribution: "Jacksonville Sheriff's Office · Public Transparency Data", licence: 'JSO transparency data (no licence stated on the item)',
    terms_url: 'https://transparency.jaxsheriff.org/', dataset_url: 'https://transparency.jaxsheriff.org/',
    lag_note: 'Updated daily by JSO', location_note: ROUNDED,
    layer: 'https://services3.arcgis.com/7C7xW0yv6W8spzhp/arcgis/rest/services/Public_Transparency_Data_View/FeatureServer/0', dateField: 'IncidentDateTime', tz: NYC, maxRows: 2000,
    outFields: 'OBJECTID,IncidentDateTime,nibrsDescription',
    pick: (a, g) => ({ key: a.OBJECTID, category: a.nibrsDescription, when: a.IncidentDateTime, lat: g.y, lng: g.x }),
  }),
  arcgis({
    source_id: 'fl_miami_mpd', city: 'Miami', state: 'FL', publisher: 'City of Miami Police Department',
    bounds: { west: -80.33, south: 25.70, east: -80.13, north: 25.86 }, metadata_hosts: ['services1.arcgis.com'],
    attribution: 'City of Miami · Miami Police Department (Crimes)', licence: 'City of Miami open data (no licence stated on the item)',
    terms_url: 'https://datahub-miamigis.opendata.arcgis.com/', dataset_url: 'https://datahub-miamigis.opendata.arcgis.com/',
    lag_note: 'Updated near-daily by the city (City of Miami only, not Miami-Dade) · report date', location_note: BLOCKISH,
    // occurfrdate is often empty in this feed: the window and the day are the report date.
    layer: 'https://services1.arcgis.com/CvuPhqcTQpZPT9qY/arcgis/rest/services/Crimes_public_67c0535145c14baf897e47a8d4986539/FeatureServer/0', dateField: 'reportdate', tz: NYC, maxRows: 2000,
    outFields: 'OBJECTID,reportdate,occurfrdate,nibrsdesc,nibrsoffense,nibrscrimeag',
    pick: (a, g) => ({ key: a.OBJECTID, category: a.nibrsdesc || a.nibrsoffense, family: familyFromCrimeAgainst(clean(a.nibrscrimeag).replace(/^crimes against /i, '')), when: a.occurfrdate || a.reportdate, lat: g.y, lng: g.x }),
  }),
  arcgis({
    source_id: 'nc_charlotte_cmpd', city: 'Charlotte', state: 'NC', publisher: 'Charlotte-Mecklenburg Police Department',
    bounds: { west: -81.06, south: 35.0, east: -80.65, north: 35.4 }, metadata_hosts: ['gis.charlottenc.gov'],
    attribution: 'City of Charlotte · CMPD Incidents', licence: 'City of Charlotte open data (no licence stated on the item)',
    terms_url: 'https://data.charlottenc.gov/', dataset_url: 'https://data.charlottenc.gov/',
    lag_note: 'Updated daily by CMPD', location_note: 'CMPD publishes "public" coordinates; LeadCommand rounds to about 100 m',
    layer: 'https://gis.charlottenc.gov/arcgis/rest/services/CMPD/CMPDIncidents/MapServer/0', dateField: 'DATE_INCIDENT_BEGAN', tz: NYC, maxRows: 2000,
    outFields: 'OBJECTID,DATE_INCIDENT_BEGAN,HIGHEST_NIBRS_DESCRIPTION,LATITUDE_PUBLIC,LONGITUDE_PUBLIC',
    pick: (a) => ({ key: a.OBJECTID, category: a.HIGHEST_NIBRS_DESCRIPTION, when: a.DATE_INCIDENT_BEGAN, lat: a.LATITUDE_PUBLIC, lng: a.LONGITUDE_PUBLIC }),
  }),
  arcgis({
    source_id: 'nc_raleigh_rpd', city: 'Raleigh', state: 'NC', publisher: 'Raleigh Police Department',
    bounds: { west: -78.82, south: 35.69, east: -78.47, north: 36.0 }, metadata_hosts: ['services.arcgis.com'],
    attribution: 'City of Raleigh Open Data · Raleigh Police Department (Police Incidents)', licence: 'City of Raleigh open data (RPD disclaimer)',
    terms_url: 'https://data-ral.opendata.arcgis.com/', dataset_url: 'https://data-ral.opendata.arcgis.com/',
    lag_note: 'Updated daily by the city · report date', location_note: BLOCKISH,
    // Unordered: ordering this layer takes 30+ s per box. Under the cap every row is returned anyway.
    layer: 'https://services.arcgis.com/v400IkDOw1ad7Yad/arcgis/rest/services/Police_Incidents/FeatureServer/0', dateField: 'reported_date', tz: NYC, maxRows: 2000, unordered: true,
    outFields: 'OBJECTID,reported_date,crime_category,crime_description,crime_type,latitude,longitude',
    pick: (a, g) => ({ key: a.OBJECTID, category: a.crime_category, offense: a.crime_description, family: familyFromCrimeAgainst(clean(a.crime_type).replace(/^crimes against /i, '')), when: a.reported_date, lat: a.latitude ?? g.y, lng: a.longitude ?? g.x }),
  }),
  arcgis({
    source_id: 'oh_cleveland_cdp', city: 'Cleveland', state: 'OH', publisher: 'Cleveland Division of Police',
    bounds: { west: -81.88, south: 41.39, east: -81.53, north: 41.61 }, metadata_hosts: ['services3.arcgis.com'],
    attribution: 'City of Cleveland Open Data · Division of Police (Crime Incidents)', licence: 'Open Database License (ODbL)',
    terms_url: 'https://opendatacommons.org/licenses/odbl/', dataset_url: 'https://data.clevelandohio.gov/',
    lag_note: 'Updated daily by the city', location_note: BLOCKISH,
    layer: 'https://services3.arcgis.com/dty2kHktVXHrqO8i/arcgis/rest/services/Crime_Incidents_P1RMS/FeatureServer/0', dateField: 'OffenseDate', tz: NYC, maxRows: 2000,
    outFields: 'OBJECTID,OffenseDate,StatDesc,IncidentDesc,LAT,LON',
    pick: (a, g) => ({ key: a.OBJECTID, category: a.StatDesc || a.IncidentDesc, offense: a.IncidentDesc, when: a.OffenseDate, lat: a.LAT ?? g.y, lng: a.LON ?? g.x }),
  }),
  arcgis({
    source_id: 'oh_columbus_cpd', city: 'Columbus', state: 'OH', publisher: 'Columbus Division of Police',
    bounds: { west: -83.21, south: 39.81, east: -82.77, north: 40.16 }, metadata_hosts: ['services1.arcgis.com'],
    attribution: 'City of Columbus · Division of Police (Police Incident Reports)', licence: 'City of Columbus open data (no licence stated on the item)',
    terms_url: 'https://opendata.columbus.gov/', dataset_url: 'https://opendata.columbus.gov/',
    lag_note: 'Updated by the city', location_note: BLOCKISH,
    layer: 'https://services1.arcgis.com/9yy6msODkIBzkUXU/arcgis/rest/services/Police_Incident_Reports/FeatureServer/0', dateField: 'OccurredOn', tz: NYC, maxRows: 2000,
    outFields: 'OBJECTID,OccurredOn,ColumbusSubject,GeneralSubject',
    pick: (a, g) => ({ key: a.OBJECTID, category: a.GeneralSubject || a.ColumbusSubject, offense: a.ColumbusSubject ? clean(a.ColumbusSubject).replace(/^\d+\s*-\s*/, '') : null, when: a.OccurredOn, lat: g.y, lng: g.x }),
  }),
  socrata({
    source_id: 'oh_cincinnati_cpd', city: 'Cincinnati', state: 'OH', publisher: 'Cincinnati Police Department',
    bounds: { west: -84.72, south: 39.05, east: -84.36, north: 39.23 }, metadata_hosts: ['data.cincinnati-oh.gov'],
    attribution: 'City of Cincinnati Open Data · CPD (Reported Crime, STARS)', licence: 'City of Cincinnati open data terms',
    terms_url: 'https://data.cincinnati-oh.gov/', dataset_url: 'https://data.cincinnati-oh.gov/d/7aqy-xrv9',
    lag_note: 'Updated daily by the city', location_note: BLOCKISH,
    domain: 'data.cincinnati-oh.gov', id: '7aqy-xrv9', dateField: 'datefrom', tz: NYC,
    select: 'incident_no,datefrom,stars_category,type,latitude_x,longitude_x',
    geo: sBox('latitude_x', 'longitude_x'),
    pick: (r) => ({ key: r.incident_no, category: r.stars_category, family: /violent/i.test(r.type) ? 'person' : /property/i.test(r.type) ? 'property' : 'other', when: r.datefrom, lat: r.latitude_x, lng: r.longitude_x }),
  }),
  arcgis({
    source_id: 'in_indianapolis_impd', city: 'Indianapolis', state: 'IN', publisher: 'Indianapolis Metropolitan Police Department',
    bounds: { west: -86.33, south: 39.63, east: -85.94, north: 39.93 }, metadata_hosts: ['gis.indy.gov'],
    attribution: 'City of Indianapolis · IMPD Public Data (Incidents)', licence: 'City of Indianapolis open data (no licence stated on the item)',
    terms_url: 'https://impdtransparency.indy.gov/', dataset_url: 'https://impdtransparency.indy.gov/',
    lag_note: 'Updated daily by IMPD', location_note: ROUNDED,
    layer: 'https://gis.indy.gov/server/rest/services/IMPD/IMPD_Public_Data/MapServer/1', dateField: 'OccurredFrom', tz: 'America/Indiana/Indianapolis', maxRows: 2000,
    extraWhere: "NIBRSClassCode IS NOT NULL AND NIBRSClassCode <> ''",
    outFields: 'OBJECTID,OccurredFrom,NIBRSClassDesc,Latitude,Longitude',
    pick: (a) => ({ key: a.OBJECTID, category: a.NIBRSClassDesc, when: a.OccurredFrom, lat: a.Latitude, lng: a.Longitude }),
  }),
  socrata({
    source_id: 'mo_kansascity_kcpd', city: 'Kansas City', state: 'MO', publisher: 'Kansas City Police Department',
    bounds: { west: -94.77, south: 38.83, east: -94.38, north: 39.36 }, metadata_hosts: ['data.kcmo.org'],
    attribution: 'Open Data KC · KCPD Crime Data 2026', licence: 'Public Domain',
    terms_url: 'https://data.kcmo.org/', dataset_url: 'https://data.kcmo.org/d/f7wj-ckmw',
    lag_note: 'Updated weekly by the city · one dataset per year (this year only)', location_note: BLOCKISH,
    domain: 'data.kcmo.org', id: 'f7wj-ckmw', dateField: 'from_date', tz: CHI,
    select: 'report,ibrs,from_date,description,location',
    geo: sWithin('location'),
    pick: (r) => ({ key: `${r.report}:${r.ibrs}`, category: r.description, when: r.from_date, lat: r.location?.coordinates?.[1], lng: r.location?.coordinates?.[0] }),
  }),
  arcgis({
    source_id: 'tn_memphis_mpd', city: 'Memphis', state: 'TN', publisher: 'Memphis Police Department',
    bounds: { west: -90.15, south: 34.99, east: -89.7, north: 35.3 }, metadata_hosts: ['services2.arcgis.com'],
    attribution: 'City of Memphis · MPD Public Safety Incidents', licence: 'City of Memphis open data (no licence stated on the item)',
    terms_url: 'https://data.memphistn.gov/', dataset_url: 'https://data.memphistn.gov/',
    lag_note: 'Updated daily by the city · sex and juvenile offenses omitted by MPD', location_note: 'Rounded to about 100 m by the city',
    layer: 'https://services2.arcgis.com/saWmpKJIUAjyyNVc/arcgis/rest/services/MPD_Public_Safety_Incidents/FeatureServer/0', dateField: 'Offense_Datetime', tz: CHI, maxRows: 1000,
    outFields: 'ObjectId,Offense_Datetime,UCR_Category,UCR_Description,NIBRS_Offense_Group,Latitude,Longitude',
    pick: (a, g) => ({ key: a.ObjectId, category: a.UCR_Category || a.UCR_Description, offense: a.UCR_Description, family: familyFromCrimeAgainst(clean(a.NIBRS_Offense_Group).replace(/^crimes against /i, '')), when: a.Offense_Datetime, lat: a.Latitude ?? g.y, lng: a.Longitude ?? g.x }),
  }),
  arcgis({
    source_id: 'tn_nashville_mnpd', city: 'Nashville', state: 'TN', publisher: 'Metro Nashville Police Department',
    bounds: { west: -87.05, south: 35.97, east: -86.52, north: 36.4 }, metadata_hosts: ['services2.arcgis.com'],
    attribution: 'Metro Nashville Open Data · MNPD Incidents', licence: 'Metro Nashville open data (no licence stated on the item)',
    terms_url: 'https://data.nashville.gov/', dataset_url: 'https://data.nashville.gov/',
    lag_note: 'Updated by Metro Nashville', location_note: 'Rounded to about 100 m by Metro',
    layer: 'https://services2.arcgis.com/HdTo6HJqh92wn4D8/arcgis/rest/services/Metro_Nashville_Police_Department_Incidents_view/FeatureServer/0', dateField: 'Incident_Occurred', tz: CHI, maxRows: 2000,
    outFields: 'OBJECTID,Incident_Number,Offense_NIBRS,Incident_Occurred,Offense_Description,Latitude,Longitude',
    // one row per offense × victim: an incident + offense is one mark
    pick: (a, g) => ({ key: `${a.Incident_Number}:${a.Offense_NIBRS}`, category: a.Offense_Description, when: a.Incident_Occurred, lat: a.Latitude ?? g.y, lng: a.Longitude ?? g.x }),
  }),
  socrata({
    source_id: 'ca_losangeles_lapd', city: 'Los Angeles', state: 'CA', publisher: 'Los Angeles Police Department',
    bounds: { west: -118.67, south: 33.7, east: -118.15, north: 34.34 }, metadata_hosts: ['data.lacity.org'],
    attribution: 'City of Los Angeles Open Data · LAPD NIBRS Offenses', licence: 'City of Los Angeles open data terms',
    terms_url: 'https://data.lacity.org/', dataset_url: 'https://data.lacity.org/d/k7nn-b2ep',
    lag_note: 'Refreshed roughly weekly by the city', location_note: 'Hundred-block location by the city; LeadCommand rounds to about 100 m',
    domain: 'data.lacity.org', id: 'k7nn-b2ep', dateField: 'date_occ', tz: LAX,
    select: 'uniquenibrno,date_occ,time_occ,nibr_description,crime_against,hndrdth_lat,hndrdth_lon',
    geo: sBox('hndrdth_lat', 'hndrdth_lon'),
    pick: (r) => {
      const t = clean(r.time_occ)
      return { key: r.uniquenibrno, category: lapdWords(r.nibr_description), family: familyFromCrimeAgainst(r.crime_against), when: r.date_occ, at: /^\d{4}$/.test(t) ? joinDayTime(cityDay(r.date_occ, LAX), `${t.slice(0, 2)}:${t.slice(2)}`) : null, lat: r.hndrdth_lat, lng: r.hndrdth_lon }
    },
  }),
  socrata({
    source_id: 'ca_sanfrancisco_sfpd', city: 'San Francisco', state: 'CA', publisher: 'San Francisco Police Department',
    bounds: { west: -122.52, south: 37.70, east: -122.35, north: 37.84 }, metadata_hosts: ['data.sf.gov'],
    attribution: 'DataSF · SFPD Incident Reports (2018 to present)', licence: 'Public Domain Dedication and License (PDDL)',
    terms_url: 'https://opendatacommons.org/licenses/pddl/', dataset_url: 'https://data.sf.gov/d/wg3w-h783',
    lag_note: 'Updated daily by the city', location_note: 'Intersection / block by the city; LeadCommand rounds to about 100 m',
    domain: 'data.sf.gov', id: 'wg3w-h783', dateField: 'incident_datetime', tz: LAX,
    select: 'row_id,incident_datetime,incident_category,incident_subcategory,incident_description,latitude,longitude',
    geo: sBox('latitude', 'longitude'),
    pick: (r) => ({ key: r.row_id, category: r.incident_category, offense: r.incident_description, when: r.incident_datetime, lat: r.latitude, lng: r.longitude }),
  }),
  socrata({
    source_id: 'wa_seattle_spd', city: 'Seattle', state: 'WA', publisher: 'Seattle Police Department',
    bounds: { west: -122.44, south: 47.49, east: -122.23, north: 47.74 }, metadata_hosts: ['data.seattle.gov'],
    attribution: 'City of Seattle Open Data · SPD Crime Data', licence: 'Public Domain',
    terms_url: 'https://data.seattle.gov/', dataset_url: 'https://data.seattle.gov/d/tazs-3rd5',
    lag_note: 'Updated daily by the city · masked records are not drawn', location_note: BLOCKISH,
    domain: 'data.seattle.gov', id: 'tazs-3rd5', dateField: 'offense_date', tz: LAX,
    select: 'offense_id,offense_date,nibrs_crime_against_category,offense_sub_category,nibrs_offense_code_description,latitude,longitude',
    // latitude/longitude are TEXT here, with "REDACTED" / "-1.0" masks that break a numeric cast. Text
    // comparison is a superset filter for Seattle (all 47.x / -122.x; negative strings sort reversed);
    // the exact box is re-applied to parsed numbers after the read.
    geo: (b) => `latitude between '${b.south.toFixed(5)}' and '${b.north.toFixed(5)}' AND longitude between '${b.east.toFixed(5)}' and '${b.west.toFixed(5)}'`,
    pick: (r) => ({ key: r.offense_id, category: r.nibrs_offense_code_description || r.offense_sub_category, offense: r.offense_sub_category, family: familyFromCrimeAgainst(r.nibrs_crime_against_category), when: r.offense_date, lat: r.latitude, lng: r.longitude }),
  }),
  arcgis({
    source_id: 'mi_detroit_dpd', city: 'Detroit', state: 'MI', publisher: 'Detroit Police Department',
    bounds: { west: -83.29, south: 42.25, east: -82.91, north: 42.46 }, metadata_hosts: ['services2.arcgis.com'],
    attribution: 'City of Detroit Open Data · RMS Crime Incidents', licence: 'City of Detroit open data (no licence stated on the item)',
    terms_url: 'https://data.detroitmi.gov/', dataset_url: 'https://data.detroitmi.gov/',
    lag_note: 'Updated daily by the city', location_note: 'Nearest intersection by the city; LeadCommand rounds to about 100 m',
    layer: 'https://services2.arcgis.com/qvkbeam7Wirps6zC/arcgis/rest/services/RMS_Crime_Incidents/FeatureServer/0', dateField: 'incident_occurred_at', tz: NYC, maxRows: 2000,
    outFields: 'ESRI_OID,incident_occurred_at,offense_category,offense_description,latitude,longitude',
    pick: (a, g) => ({ key: a.ESRI_OID, category: a.offense_category, offense: a.offense_description, when: a.incident_occurred_at, lat: a.latitude ?? g.y, lng: a.longitude ?? g.x }),
  }),
  {
    source_id: 'pa_philadelphia_ppd', city: 'Philadelphia', state: 'PA', publisher: 'Philadelphia Police Department',
    bounds: { west: -75.29, south: 39.86, east: -74.95, north: 40.14 }, metadata_hosts: ['phl.carto.com'],
    attribution: 'OpenDataPhilly · Philadelphia Police Department (Crime Incidents, Part I & II)', licence: 'OpenDataPhilly terms (public)',
    terms_url: 'https://opendataphilly.org/', dataset_url: 'https://opendataphilly.org/datasets/crime-incidents/',
    lag_note: 'Updated daily by the city · dispatch time', location_note: BLOCKISH,
    // Carto SQL (the city's own API): the ArcGIS NIBRS layer takes 20–40 s per box; this answers in < 1 s.
    url: ({ box, sinceMs, limit }) => {
      const since = sinceMs === null || sinceMs === undefined ? '' : `dispatch_date >= '${new Date(sinceMs).toISOString().slice(0, 10)}' AND `
      const env = [box.west, box.south, box.east, box.north].map((v) => Number(v).toFixed(5)).join(',')
      const sql = `SELECT cartodb_id, dispatch_date, dispatch_time, text_general_code, point_x, point_y FROM incidents_part1_part2 WHERE ${since}the_geom && ST_MakeEnvelope(${env}, 4326) ORDER BY dispatch_date DESC, dispatch_time DESC LIMIT ${Math.min(Number(limit) || 0, 2000)}`
      return `https://phl.carto.com/api/v2/sql?${new URLSearchParams({ q: sql })}`
    },
    rows: (body) => {
      if (body?.error) throw new Error('source_query_error')
      return Array.isArray(body?.rows) ? body.rows : []
    },
    normalize: (r) => {
      const lat = num(r?.point_y)
      const lng = num(r?.point_x)
      const category = titleCase(r?.text_general_code)
      if (!placed(lat, lng, { west: -75.29, south: 39.86, east: -74.95, north: 40.14 }) || !category || !clean(r?.cartodb_id)) return null
      const day = clean(r.dispatch_date).slice(0, 10) || null
      return { key: `pa_philadelphia_ppd:${clean(r.cartodb_id)}`, category, offense: null, family: 'other', occurred_on: day, occurred_at: joinDayTime(day, clean(r.dispatch_time).slice(0, 5)), lat: r3(lat), lng: r3(lng) }
    },
  },
  arcgis({
    source_id: 'md_baltimore_bpd', city: 'Baltimore', state: 'MD', publisher: 'Baltimore Police Department',
    bounds: { west: -76.72, south: 39.19, east: -76.52, north: 39.38 }, metadata_hosts: ['services1.arcgis.com'],
    attribution: 'Open Baltimore · BPD NIBRS Group A Crime Data', licence: 'Open Baltimore terms (public)',
    terms_url: 'https://data.baltimorecity.gov/', dataset_url: 'https://data.baltimorecity.gov/',
    lag_note: 'Updated weekly by the city', location_note: BLOCKISH,
    layer: 'https://services1.arcgis.com/UWYHeuuJISiGmgXx/arcgis/rest/services/NIBRS_GroupA_Crime_Data/FeatureServer/0', dateField: 'CrimeDateTime', tz: NYC, maxRows: 2000,
    outFields: 'RowID,CrimeDateTime,Description',
    pick: (a, g) => ({ key: a.RowID, category: a.Description, when: a.CrimeDateTime, lat: g.y, lng: g.x }),
  }),
  arcgis({
    source_id: 'co_denver_dpd', city: 'Denver', state: 'CO', publisher: 'Denver Police Department',
    bounds: { west: -105.11, south: 39.61, east: -104.6, north: 39.92 }, metadata_hosts: ['services1.arcgis.com'],
    attribution: 'Denver Open Data Catalog · Crime (offenses)', licence: 'Denver open data (CC BY 3.0)',
    terms_url: 'https://opendata-geospatialdenver.hub.arcgis.com/', dataset_url: 'https://opendata-geospatialdenver.hub.arcgis.com/',
    lag_note: 'Updated daily · sex crimes are excluded by the city', location_note: ROUNDED,
    layer: 'https://services1.arcgis.com/zdB7qR0BtYrg0Xpl/arcgis/rest/services/ODC_CRIME_OFFENSES_P/FeatureServer/324', dateField: 'FIRST_OCCURRENCE_DATE', tz: DEN, maxRows: 2000,
    extraWhere: 'IS_CRIME = 1',
    outFields: 'OBJECTID,FIRST_OCCURRENCE_DATE,OFFENSE_TYPE_ID,OFFENSE_CATEGORY_ID,GEO_LON,GEO_LAT',
    pick: (a) => ({ key: a.OBJECTID, category: a.OFFENSE_CATEGORY_ID, offense: a.OFFENSE_TYPE_ID, when: a.FIRST_OCCURRENCE_DATE, lat: a.GEO_LAT, lng: a.GEO_LON }),
  }),
  arcgis({
    source_id: 'dc_washington_mpd', city: 'Washington', state: 'DC', publisher: 'Metropolitan Police Department',
    bounds: { west: -77.12, south: 38.79, east: -76.91, north: 39.0 }, metadata_hosts: ['maps2.dcgis.dc.gov'],
    attribution: 'Open Data DC · MPD Crime Incidents (last 30 days)', licence: 'Creative Commons Attribution 4.0 (CC BY 4.0)',
    terms_url: 'https://creativecommons.org/licenses/by/4.0/', dataset_url: 'https://opendata.dc.gov/',
    lag_note: 'MPD publishes a rolling 30-day feed (All = 30 days here)', location_note: 'Block centroid by the city; LeadCommand rounds to about 100 m',
    layer: 'https://maps2.dcgis.dc.gov/dcgis/rest/services/FEEDS/MPD/FeatureServer/39', dateField: 'REPORT_DAT', tz: NYC, maxRows: 2000,
    outFields: 'OBJECTID,REPORT_DAT,START_DATE,OFFENSE,METHOD,LATITUDE,LONGITUDE',
    pick: (a, g) => ({ key: a.OBJECTID, category: a.OFFENSE, offense: a.METHOD && clean(a.METHOD).toUpperCase() !== 'OTHERS' ? `${clean(a.OFFENSE)} (${clean(a.METHOD).toLowerCase()})` : null, when: a.START_DATE || a.REPORT_DAT, lat: a.LATITUDE ?? g.y, lng: a.LONGITUDE ?? g.x }),
  }),
  arcgis({
    source_id: 'nv_lasvegas_lvmpd', city: 'Las Vegas', state: 'NV', publisher: 'Las Vegas Metropolitan Police Department',
    bounds: { west: -115.42, south: 35.95, east: -114.9, north: 36.38 }, metadata_hosts: ['services.arcgis.com'],
    attribution: 'LVMPD · Weekly Public Crimes', licence: 'LVMPD open data (no licence stated on the item)',
    terms_url: 'https://opendata-lvmpd.hub.arcgis.com/', dataset_url: 'https://opendata-lvmpd.hub.arcgis.com/',
    lag_note: 'Updated weekly by LVMPD · report date', location_note: ROUNDED,
    layer: 'https://services.arcgis.com/jjSk6t82vIntwDbs/arcgis/rest/services/Weekly_Public_Crimes/FeatureServer/0', dateField: 'ReportedOn', tz: LAX, maxRows: 2000,
    outFields: 'OBJECTID,ReportedOn,CrimeAgainst,OffenseCategory,Offense,Latitude,Longitude',
    pick: (a, g) => ({ key: a.OBJECTID, category: a.OffenseCategory || a.Offense, offense: a.Offense, family: familyFromCrimeAgainst(a.CrimeAgainst), when: a.ReportedOn, lat: a.Latitude ?? g.y, lng: a.Longitude ?? g.x }),
  }),
]

/** Checked 2026-10-05 and NOT drawn, with why (SOURCES.txt). */
export const CITY_NOT_COVERED = Object.freeze([
  { city: 'San Antonio', state: 'TX', reason: 'SAPD publishes offenses by ZIP and service area only — no coordinates', bounds: { west: -98.8, south: 29.2, east: -98.2, north: 29.75 } },
  { city: 'Austin', state: 'TX', reason: 'APD removed coordinates (census block group only)', bounds: { west: -97.95, south: 30.1, east: -97.55, north: 30.52 } },
  { city: 'Orlando', state: 'FL', reason: 'The city crime dataset was withdrawn; no public point feed', bounds: { west: -81.51, south: 28.35, east: -81.2, north: 28.62 } },
  { city: 'Phoenix', state: 'AZ', reason: 'Published data ends 2025-12-31 and has no coordinates', bounds: { west: -112.34, south: 33.29, east: -111.92, north: 33.92 } },
  { city: 'St. Louis', state: 'MO', reason: 'SLMPD publishes monthly CSV files only (no query API)', bounds: { west: -90.32, south: 38.53, east: -90.17, north: 38.78 } },
  { city: 'San Diego', state: 'CA', reason: 'Published as daily bulk CSV only (no query API)', bounds: { west: -117.3, south: 32.53, east: -116.9, north: 33.12 } },
  { city: 'Louisville', state: 'KY', reason: 'LMPD publishes block addresses only — no coordinates', bounds: { west: -85.95, south: 37.99, east: -85.4, north: 38.38 } },
  { city: 'New Orleans', state: 'LA', reason: 'Newest published year is 2025 (stale)', bounds: { west: -90.14, south: 29.86, east: -89.9, north: 30.07 } },
])
