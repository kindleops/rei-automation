/**
 * CRIME SOURCES — city open-data portals only. One entry per city: who
 * publishes it, where it covers, what its terms say, how it is queried and how
 * a record becomes a canonical incident.
 *
 * Product rules (owner): reported incidents as the city publishes them —
 * category, date, source, coverage. NO safety score, no SAFE/UNSAFE, no
 * "crime index". A city that is not listed here is "not covered", never zero.
 *
 * Privacy: we read only category, offense, date and the city's own location
 * (already block-generalised by Chicago and Minneapolis). Dallas publishes
 * address-level points, so they are rounded to ~100 m. No case numbers,
 * addresses, names, victim or officer fields ever leave this module.
 */

const clean = (v) => (v === null || v === undefined ? '' : String(v).trim())
const num = (v) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}
/** The day an incident occurred, in the city's own calendar: 'YYYY-MM-DD'. */
const DAY_FMT = new Map()
export function cityDay(v, timeZone) {
  if (v === null || v === undefined || v === '') return null
  // Socrata floating timestamps ("2026-10-03 00:00:00.0000000") are already city-local.
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10)
  const t = typeof v === 'number' ? v : Date.parse(String(v))
  if (!Number.isFinite(t)) return null
  if (!DAY_FMT.has(timeZone)) DAY_FMT.set(timeZone, new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }))
  return DAY_FMT.get(timeZone).format(new Date(t))
}
/** Socrata floating timestamps carry no zone: compare in the city's own day. */
const socrataDay = (ms) => new Date(ms).toISOString().slice(0, 10) + 'T00:00:00'

/** NIBRS "crime against" → the family used for colour. A label, not a score. */
export function familyFromCrimeAgainst(v) {
  const s = clean(v).toLowerCase()
  if (s.startsWith('person')) return 'person'
  if (s.startsWith('property')) return 'property'
  if (s.startsWith('society')) return 'society'
  return 'other'
}

// Chicago publishes IUCR primary types, not NIBRS families.
const CHI_PERSON = new Set(['ASSAULT', 'BATTERY', 'HOMICIDE', 'ROBBERY', 'CRIMINAL SEXUAL ASSAULT', 'CRIM SEXUAL ASSAULT', 'SEX OFFENSE', 'KIDNAPPING', 'HUMAN TRAFFICKING', 'INTIMIDATION', 'STALKING', 'OFFENSE INVOLVING CHILDREN'])
const CHI_PROPERTY = new Set(['THEFT', 'BURGLARY', 'MOTOR VEHICLE THEFT', 'CRIMINAL DAMAGE', 'DECEPTIVE PRACTICE', 'ARSON', 'CRIMINAL TRESPASS'])
const CHI_SOCIETY = new Set(['NARCOTICS', 'WEAPONS VIOLATION', 'PUBLIC PEACE VIOLATION', 'LIQUOR LAW VIOLATION', 'GAMBLING', 'PROSTITUTION', 'INTERFERENCE WITH PUBLIC OFFICER', 'CONCEALED CARRY LICENSE VIOLATION', 'OBSCENITY', 'PUBLIC INDECENCY', 'OTHER NARCOTIC VIOLATION'])
export function chicagoFamily(primaryType) {
  const t = clean(primaryType).toUpperCase()
  if (CHI_PERSON.has(t)) return 'person'
  if (CHI_PROPERTY.has(t)) return 'property'
  if (CHI_SOCIETY.has(t)) return 'society'
  return 'other'
}

const titleCase = (s) => clean(s).toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase())
const round = (v, dp) => (v === null ? null : Number(v.toFixed(dp)))

/**
 * @typedef {object} CrimeSource
 * @property {string} source_id
 * @property {string} city
 * @property {string} state
 * @property {string} publisher
 * @property {{west:number,south:number,east:number,north:number}} bounds  the city's own extent
 * @property {string[]} metadata_hosts
 * @property {string} attribution
 * @property {string} licence
 * @property {string} terms_url
 * @property {string} dataset_url
 * @property {string} lag_note       how far behind "today" the city publishes
 * @property {string} location_note  how the city generalises locations
 * @property {(q:{box:object, sinceMs:number, limit:number}) => string} url
 * @property {(body:unknown) => unknown[]} rows
 * @property {(raw:any) => object|null} normalize
 */

/** @type {CrimeSource[]} */
export const CRIME_SOURCES = [
  {
    source_id: 'mn_minneapolis_mpd',
    city: 'Minneapolis',
    state: 'MN',
    publisher: 'Minneapolis Police Department',
    bounds: { west: -93.33, south: 44.89, east: -93.19, north: 45.06 },
    metadata_hosts: ['services.arcgis.com'],
    attribution: 'City of Minneapolis Open Data · Minneapolis Police Department (Crime Data)',
    licence: 'City of Minneapolis open data (no licence stated on the item)',
    terms_url: 'https://opendata.minneapolismn.gov/',
    dataset_url: 'https://opendata.minneapolismn.gov/datasets/cityoflakes::crime-data',
    lag_note: 'Refreshed daily by the city',
    location_note: 'Addresses generalised to the block by the city',
    url: ({ box, sinceMs, limit }) => {
      const since = new Date(sinceMs).toISOString().slice(0, 19).replace('T', ' ')
      const q = new URLSearchParams({
        where: `Occurred_Date >= TIMESTAMP '${since}'`,
        geometry: [box.west, box.south, box.east, box.north].map((v) => v.toFixed(5)).join(','),
        geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
        outFields: 'OBJECTID,Offense_Category,Offense,Occurred_Date,NIBRS_Crime_Against',
        returnGeometry: 'true', outSR: '4326', orderByFields: 'Occurred_Date DESC', resultRecordCount: String(limit), f: 'json',
      })
      return `https://services.arcgis.com/afSMGVsC7QlRK1kZ/arcgis/rest/services/Crime_Data/FeatureServer/0/query?${q}`
    },
    rows: (body) => {
      if (body?.error) throw new Error('source_query_error')
      return Array.isArray(body?.features) ? body.features : []
    },
    normalize: (f) => {
      const a = f?.attributes || {}
      const lat = num(f?.geometry?.y)
      const lng = num(f?.geometry?.x)
      const category = clean(a.Offense_Category)
      if (lat === null || lng === null || !category) return null
      return { key: `mpls:${a.OBJECTID}`, category, offense: clean(a.Offense) || null, family: familyFromCrimeAgainst(a.NIBRS_Crime_Against), occurred_on: cityDay(a.Occurred_Date, 'America/Chicago'), lat: round(lat, 5), lng: round(lng, 5) }
    },
  },
  {
    source_id: 'tx_dallas_dpd',
    city: 'Dallas',
    state: 'TX',
    publisher: 'Dallas Police Department',
    bounds: { west: -97.0, south: 32.61, east: -96.55, north: 33.03 },
    metadata_hosts: ['www.dallasopendata.com'],
    attribution: 'Dallas OpenData · Dallas Police Department (Police Incidents)',
    licence: 'Open Data Commons Attribution License (ODC-By 1.0)',
    terms_url: 'http://opendatacommons.org/licenses/by/1.0/',
    dataset_url: 'https://www.dallasopendata.com/Public-Safety/Police-Incidents/qv6i-rri7',
    lag_note: 'Updated daily by the city',
    location_note: 'The city geocodes to the address; LeadCommand rounds to about 100 m',
    url: ({ box, sinceMs, limit }) => {
      const q = new URLSearchParams({
        $select: 'incidentnum,date1,nibrs_crime_category,nibrs_crime,nibrs_crimeagainst,geocoded_column',
        $where: `date1 >= '${socrataDay(sinceMs)}' AND within_box(geocoded_column, ${box.north.toFixed(5)}, ${box.west.toFixed(5)}, ${box.south.toFixed(5)}, ${box.east.toFixed(5)})`,
        $order: 'date1 DESC',
        $limit: String(limit),
      })
      return `https://www.dallasopendata.com/resource/qv6i-rri7.json?${q}`
    },
    rows: (body) => (Array.isArray(body) ? body : []),
    normalize: (r) => {
      const lat = num(r?.geocoded_column?.latitude)
      const lng = num(r?.geocoded_column?.longitude)
      const category = titleCase(r?.nibrs_crime_category)
      if (lat === null || lng === null || !category || !clean(r?.incidentnum)) return null
      // One row per offense × victim: an incident + offense is one mark.
      return { key: `dal:${clean(r.incidentnum)}:${clean(r.nibrs_crime)}`, category, offense: titleCase(r.nibrs_crime) || null, family: familyFromCrimeAgainst(r.nibrs_crimeagainst), occurred_on: cityDay(r.date1, 'America/Chicago'), lat: round(lat, 3), lng: round(lng, 3) }
    },
  },
  {
    source_id: 'il_chicago_cpd',
    city: 'Chicago',
    state: 'IL',
    publisher: 'Chicago Police Department',
    bounds: { west: -87.94, south: 41.64, east: -87.52, north: 42.03 },
    metadata_hosts: ['data.cityofchicago.org'],
    attribution: 'City of Chicago Data Portal · Chicago Police Department (Crimes – 2001 to Present)',
    licence: 'City of Chicago Data Portal Terms of Use',
    terms_url: 'https://www.chicago.gov/city/en/narr/foia/data_disclaimer.html',
    dataset_url: 'https://data.cityofchicago.org/Public-Safety/Crimes-2001-to-Present/ijzp-q8t2',
    lag_note: 'Published about 7 days behind by the city',
    location_note: 'Locations shifted to the block by the city',
    url: ({ box, sinceMs, limit }) => {
      const q = new URLSearchParams({
        $select: 'id,date,primary_type,description,latitude,longitude',
        $where: `date >= '${socrataDay(sinceMs)}' AND latitude between ${box.south.toFixed(5)} and ${box.north.toFixed(5)} AND longitude between ${box.west.toFixed(5)} and ${box.east.toFixed(5)}`,
        $order: 'date DESC',
        $limit: String(limit),
      })
      return `https://data.cityofchicago.org/resource/ijzp-q8t2.json?${q}`
    },
    rows: (body) => (Array.isArray(body) ? body : []),
    normalize: (r) => {
      const lat = num(r?.latitude)
      const lng = num(r?.longitude)
      const category = titleCase(r?.primary_type)
      if (lat === null || lng === null || !category || !clean(r?.id)) return null
      return { key: `chi:${clean(r.id)}`, category, offense: titleCase(r.description) || null, family: chicagoFamily(r.primary_type), occurred_on: cityDay(r.date, 'America/Chicago'), lat: round(lat, 5), lng: round(lng, 5) }
    },
  },
]

/** Cities checked and NOT covered, with why — so "not covered" can say it plainly. */
export const CRIME_NOT_COVERED = Object.freeze([
  { city: 'Houston', state: 'TX', reason: 'HPD publishes monthly spreadsheets, not a queryable point feed' },
])

export const crimeSourceById = (id) => CRIME_SOURCES.find((s) => s.source_id === id) || null
