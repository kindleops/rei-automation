import { describe, expect, it } from 'vitest'
import {
  allDestinations,
  buildDestinationUrl,
  classifyUrl,
  companySearchQuery,
  COVERED_COUNTIES,
  destinationsFor,
  displayHost,
  EMBED_ALLOWLIST,
  getDestination,
  normalizeCountyName,
  propertySearchQuery,
  resolveJurisdiction,
  resolveTypedInput,
  sanitizeUrl,
  searchUrl,
} from './index'
import type { DestinationRecord, ResearchProperty } from './index'
import { FIXTURE_PROPERTIES as FX } from './__fixtures__/properties'

const rec = (id: string): DestinationRecord => {
  const r = getDestination(id)
  if (!r) throw new Error(`missing ${id}`)
  return r
}
const url = (id: string, property: ResearchProperty) => {
  const r = buildDestinationUrl(rec(id), { property })
  if (!r.ok) throw new Error(`${id}: ${r.reason}`)
  return r.url
}

describe('registry integrity', () => {
  it('every record is well-formed, https-only and dated', () => {
    const ids = new Set<string>()
    for (const d of allDestinations()) {
      expect(ids.has(d.id), d.id).toBe(false)
      ids.add(d.id)
      expect(d.last_verified_at).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(d.hosts.length).toBeGreaterThan(0)
      const hrefs = d.url.kind === 'static' ? [d.url.href] : d.url.kind === 'apn' ? [d.url.template, d.url.search_href] : 'template' in d.url ? [d.url.template] : []
      for (const h of hrefs) {
        const u = new URL(h.replace('{apn}', 'X').replace('{name}', 'X').replace('{zip}', '00000'))
        expect(u.protocol, d.id).toBe('https:')
        if (h !== (d.url.kind === 'apn' ? d.url.search_href : '')) expect(d.hosts, d.id).toContain(u.hostname)
      }
      if (d.embed === 'EMBEDS') expect(d.sandbox?.length, `${d.id} needs audited sandbox`).toBeGreaterThan(0)
      if (d.embed !== 'EMBEDS') expect(d.sandbox, d.id).toBeUndefined()
      if (d.scope.level === 'county') expect(COVERED_COUNTIES[`${d.scope.state}:${d.scope.county}`], d.id).toBeTruthy()
    }
  })

  it('every covered county has an ASSESSOR and the minimum sample is covered', () => {
    for (const key of Object.keys(COVERED_COUNTIES)) {
      const [st, c] = key.split(':')
      expect(allDestinations().some((d) => d.destination_type === 'ASSESSOR' && d.scope.level === 'county' && d.scope.state === st && d.scope.county === c), key).toBe(true)
    }
    for (const k of ['MN:hennepin', 'TX:dallas', 'TX:harris', 'IN:marion', 'GA:fulton', 'GA:dekalb', 'FL:miamidade', 'FL:broward', 'FL:hillsborough', 'CA:losangeles', 'NC:mecklenburg', 'FL:duval', 'AZ:maricopa']) {
      expect(COVERED_COUNTIES[k], k).toBeTruthy()
    }
  })

  it('embed allowlist only contains hosts proven EMBEDS', () => {
    for (const h of EMBED_ALLOWLIST) expect(classifyUrl(`https://${h}/`).embed).toBe('EMBEDS')
    expect(EMBED_ALLOWLIST).not.toContain('www.zillow.com')
    expect(EMBED_ALLOWLIST).not.toContain('www.google.com')
  })
})

describe('resolveJurisdiction (production-shaped rows)', () => {
  it('resolves every fixture county from canonical fields', () => {
    for (const [k, p] of Object.entries(FX)) {
      const j = resolveJurisdiction(p)
      expect(j.covered, k).toBe(true)
      expect(j.source).toBe('county_field')
    }
  })
  it('normalizes prod spellings ("De Kalb", "Miami-Dade", "Saint Louis")', () => {
    expect(normalizeCountyName('De Kalb')).toBe('dekalb')
    expect(normalizeCountyName('DeKalb County')).toBe('dekalb')
    expect(normalizeCountyName('Miami-Dade')).toBe('miamidade')
    expect(normalizeCountyName('Saint Louis City')).toBe('stlouiscity')
    expect(resolveJurisdiction(FX['GA:De Kalb']).county).toBe('DeKalb')
  })
  it('uses the city table only for single-county cities', () => {
    expect(resolveJurisdiction({ property_address_state: 'MN', property_address_city: 'Minneapolis' })).toMatchObject({ key: 'MN:hennepin', source: 'city_lookup' })
    // Dallas / Houston / Atlanta span several counties — never guessed.
    for (const [st, city] of [['TX', 'Dallas'], ['TX', 'Houston'], ['GA', 'Atlanta'], ['IL', 'Chicago']]) {
      expect(resolveJurisdiction({ property_address_state: st, property_address_city: city }).covered, city).toBe(false)
    }
  })
  it('uncovered or missing jurisdiction is honest', () => {
    expect(resolveJurisdiction({ property_address_state: 'OK', property_address_county_name: 'Tulsa' })).toMatchObject({ state: 'OK', county: 'Tulsa', covered: false, key: null })
    expect(resolveJurisdiction({})).toMatchObject({ state: null, covered: false, source: 'none' })
    expect(resolveJurisdiction({ property_address_state: 'Minnesota', property_address_county_name: 'hennepin county' }).key).toBe('MN:hennepin')
  })
})

describe('parcel deep links — verified patterns with real parcels', () => {
  it('builds each county deep link from the stored APN format', () => {
    expect(url('mn-hennepin-pins', FX['MN:Hennepin'])).toBe('https://www16.co.hennepin.mn.us/pins/pidresult.jsp?pid=1002824110248')
    expect(url('mn-hennepin-tax', FX['MN:Hennepin'])).toBe('https://www16.co.hennepin.mn.us/taxpayments/taxesdue.jsp?pid=1002824110248')
    expect(url('tx-dallas-dcad', FX['TX:Dallas'])).toBe('https://www.dallascad.org/AcctDetailRes.aspx?ID=26415500060170000')
    expect(url('fl-duval-pao', FX['FL:Duval'])).toBe('https://paopropertysearch.coj.net/Basic/Detail.aspx?RE=1226430000')
    expect(url('fl-miamidade-pa', FX['FL:Miami-Dade'])).toBe('https://apps.miamidadepa.gov/PropertySearch/#/?folio=3040310000200')
    expect(url('ca-losangeles-assessor', FX['CA:Los Angeles'])).toBe('https://portal.assessor.lacounty.gov/parceldetail/5313010059')
    expect(url('nc-mecklenburg-polaris', FX['NC:Mecklenburg'])).toBe('https://polaris3g.mecklenburgcountync.gov/pid/15702401')
    expect(url('az-maricopa-assessor', FX['AZ:Maricopa'])).toBe('https://mcassessor.maricopa.gov/mcs/?q=14312808&mod=pd')
    expect(url('az-maricopa-assessor', FX['AZ:Maricopa:lettered'])).toBe('https://mcassessor.maricopa.gov/mcs/?q=10816154B&mod=pd')
    expect(url('il-cook-assessor', FX['IL:Cook'])).toBe('https://www.cookcountyassessoril.gov/pin/16133260500000')
  })

  it('missing APN → "Parcel ID required" with the county search page, never a fabricated id', () => {
    const p = { ...FX['MN:Hennepin'], apn_parcel_id: null }
    const r = buildDestinationUrl(rec('mn-hennepin-pins'), { property: p })
    expect(r).toMatchObject({ ok: false, reason: 'parcel_id_required', message: 'Parcel ID required', fallback: { url: 'https://www16.co.hennepin.mn.us/pins/' } })
    expect(buildDestinationUrl(rec('mn-hennepin-pins'), { property: { ...p, apn_parcel_id: '   ' } })).toMatchObject({ ok: false, reason: 'parcel_id_required' })
  })

  it('malformed APN (wrong length / injection) → parcel_id_invalid', () => {
    const base = FX['FL:Duval']
    for (const bad of ['12345', '122643-0000/../../evil', '1226430000?x=https://evil.tld', '12264300001234']) {
      const r = buildDestinationUrl(rec('fl-duval-pao'), { property: { ...base, apn_parcel_id: bad } })
      if (r.ok) {
        // digits-normalized injection attempts may only yield a clean, same-host URL
        expect(new URL(r.url).host).toBe('paopropertysearch.coj.net')
        expect(r.url).toMatch(/RE=\d{10}$/)
      } else expect(r.reason).toBe('parcel_id_invalid')
    }
    expect(buildDestinationUrl(rec('fl-duval-pao'), { property: { ...base, apn_parcel_id: '12345' } })).toMatchObject({ ok: false, reason: 'parcel_id_invalid' })
  })

  it('wrong-county guard: a county record never builds for another county', () => {
    const r = buildDestinationUrl(rec('mn-hennepin-pins'), { property: FX['TX:Dallas'] })
    expect(r).toMatchObject({ ok: false, reason: 'wrong_jurisdiction' })
    // Same APN shape, different county (Ramsey MN is not Hennepin)
    const ramsey = { ...FX['MN:Hennepin'], property_address_county_name: 'Ramsey' }
    expect(buildDestinationUrl(rec('mn-hennepin-pins'), { property: ramsey })).toMatchObject({ ok: false, reason: 'wrong_jurisdiction' })
    // City-scoped record: Minneapolis permits are not offered for a Hennepin suburb
    const suburb = { ...FX['MN:Hennepin'], property_address_city: 'Bloomington' }
    expect(buildDestinationUrl(rec('mn-minneapolis-property-info'), { property: suburb })).toMatchObject({ ok: false, reason: 'wrong_jurisdiction' })
  })
})

describe('destinationsFor', () => {
  it('offers county official records + market + search for every covered fixture county', () => {
    for (const [k, p] of Object.entries(FX)) {
      const list = destinationsFor({ type: 'property', property: p })
      const j = resolveJurisdiction(p)
      for (const d of list) {
        if (d.record.scope.level === 'county' || d.record.scope.level === 'city') expect(`${d.record.scope.state}:${d.record.scope.county}`, k).toBe(j.key)
        expect(d.record.destination_type).not.toBe('STATE_CORPORATE')
      }
      expect(list.some((d) => d.group === 'official' && d.record.destination_type === 'ASSESSOR'), k).toBe(true)
      expect(list.some((d) => d.record.destination_type === 'ZILLOW' && d.build.ok), k).toBe(true)
      expect(list.some((d) => d.record.destination_type === 'WEB_SEARCH' && d.build.ok), k).toBe(true)
      expect(list.some((d) => d.record.id === 'web-search-county-site'), k).toBe(false)
    }
  })

  it('uncovered jurisdiction → web search + county-site search, no invented county URLs', () => {
    const tulsa: ResearchProperty = { property_address: '123 Main St', property_address_city: 'Tulsa', property_address_state: 'OK', property_address_zip: '74103', property_address_county_name: 'Tulsa', apn_parcel_id: '00000-00-00-00000-0' }
    const list = destinationsFor({ type: 'property', property: tulsa })
    expect(list.every((d) => d.record.scope.level === 'national')).toBe(true)
    const county = list.find((d) => d.record.id === 'web-search-county-site')
    expect(county?.build.ok && county.build.url).toBe('https://www.google.com/search?q=Tulsa%20County%20OK%20property%20search')
  })

  it('company → its state registry (+ web search); Sunbiz deep-links by name', () => {
    const list = destinationsFor({ type: 'company', company: { name: 'Kindle Enterprises LLC', state: 'FL' } })
    expect(list.map((d) => d.record.id)).toEqual(['fl-sunbiz', 'web-search-company'])
    expect(list[0].build.ok && list[0].build.url).toBe('https://search.sunbiz.org/Inquiry/CorporationSearch/SearchResults?inquiryType=EntityName&searchTerm=Kindle%20Enterprises%20LLC')
    const mn = destinationsFor({ type: 'company', company: { name: 'Acme Holdings LLC', state: 'MN' } })
    expect(mn[0].build).toMatchObject({ ok: true, url: 'https://mblsportal.sos.mn.gov/Business/Search', copy: { label: 'Company', value: 'Acme Holdings LLC' } })
  })

  it('search-page destinations carry the context to copy', () => {
    const list = destinationsFor({ type: 'property', property: FX['FL:Broward'] })
    const bcpa = list.find((d) => d.record.id === 'fl-broward-bcpa')
    expect(bcpa?.build).toMatchObject({ ok: true, copy: { label: 'Parcel ID', value: '51-42-19-01-0830' } })
  })
})

describe('market + maps builders', () => {
  it('Zillow uses the public _rb address path; Street View needs coordinates', () => {
    expect(url('zillow', FX['MN:Hennepin'])).toBe('https://www.zillow.com/homes/345-E-38th-St-Minneapolis-MN-55409_rb/')
    expect(url('google-maps', FX['MN:Hennepin'])).toBe('https://www.google.com/maps/search/?api=1&query=345%20E%2038th%20St%2C%20Minneapolis%2C%20MN')
    expect(url('street-view', FX['MN:Hennepin'])).toMatch(/^https:\/\/www\.google\.com\/maps\/@\?api=1&map_action=pano&viewpoint=-?\d+\.\d{6},-?\d+\.\d{6}$/)
    expect(buildDestinationUrl(rec('street-view'), { property: { ...FX['MN:Hennepin'], latitude: null } })).toMatchObject({ ok: false, reason: 'coordinates_required' })
    expect(url('redfin', FX['MN:Hennepin'])).toBe('https://www.redfin.com/zipcode/55409')
  })
})

describe('URL sanitization', () => {
  it('rejects javascript:, data:, file:, blob:, about:, credentials and control characters', () => {
    for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', ' javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'blob:https://x.com/uuid', 'about:blank', 'vbscript:x', 'chrome://settings']) {
      expect(sanitizeUrl(bad).ok, bad).toBe(false)
      expect(classifyUrl(bad).ok, bad).toBe(false)
      expect(resolveTypedInput(bad).kind, bad).toBe('invalid')
    }
    expect(sanitizeUrl('https://hennepin.us@evil.tld/')).toEqual({ ok: false, reason: 'credentials_in_url' })
    expect(sanitizeUrl('https://evil.tld/\nfoo').ok).toBe(false)
    expect(sanitizeUrl('java\tscript:alert(1)').ok).toBe(false)
  })
  it('accepts http with an insecure flag; shows the real punycode host', () => {
    expect(sanitizeUrl('http://legacy.county.gov/x')).toMatchObject({ ok: true, insecure: true, host: 'legacy.county.gov' })
    expect(displayHost('https://www.zillow.com/homes/x')).toBe('zillow.com')
    expect(displayHost('https://www.gооgle.com/')).toMatch(/^xn--/) // Cyrillic о
  })
  it('classifyUrl: exact-host allowlist, unknown → UNKNOWN, lookalike suffix is not trusted', () => {
    expect(classifyUrl('https://www16.co.hennepin.mn.us/pins/').embed).toBe('EMBEDS')
    expect(classifyUrl('https://www16.co.hennepin.mn.us.evil.tld/pins/').embed).toBe('UNKNOWN')
    expect(classifyUrl('https://evil-www16.co.hennepin.mn.us/').embed).toBe('UNKNOWN')
    expect(classifyUrl('https://www.zillow.com/homedetails/x').embed).toBe('BLOCKED')
    expect(classifyUrl('https://example.com/').embed).toBe('UNKNOWN')
    expect(classifyUrl('http://www16.co.hennepin.mn.us/pins/').embed).toBe('EXTERNAL_ONLY')
  })
  it('no builder output can leave its declared hosts (no open redirect)', () => {
    const hostile: ResearchProperty = {
      property_address: 'https://evil.tld/ ../../ @evil.tld',
      property_address_full: 'javascript:alert(1), x, y',
      property_address_city: '//evil.tld',
      property_address_state: 'MN',
      property_address_zip: '55409?next=https://evil.tld',
      property_address_county_name: 'Hennepin',
      apn_parcel_id: '//evil.tld/1002824110248',
      latitude: 'NaN',
      longitude: 1e9,
    }
    for (const d of allDestinations()) {
      const r = buildDestinationUrl(d, { property: hostile, company: { name: 'https://evil.tld/?x=', state: 'FL' } })
      if (r.ok) {
        expect(d.hosts, d.id).toContain(new URL(r.url).hostname)
        expect(r.url.startsWith('https://'), d.id).toBe(true)
      }
      if (!r.ok && r.fallback) expect(new URL(r.fallback.url).protocol).toBe('https:')
    }
  })
})

describe('search privacy', () => {
  it('property query = street, city, state only — no owner, phone, notes, ZIP, parcel or ids', () => {
    const p = { ...FX['MN:Hennepin'], owner_name: 'JANE DOE', phone: '6125550100', notes: 'motivated', score: 91 } as ResearchProperty
    expect(propertySearchQuery(p)).toBe('345 E 38th St, Minneapolis, MN')
    const u = url('web-search-property', p)
    expect(u).toBe('https://www.google.com/search?q=345%20E%2038th%20St%2C%20Minneapolis%2C%20MN')
    for (const leak of ['DOE', '6125550100', 'motivated', '55409', '1002824110248', FX['MN:Hennepin'].property_id ?? 'x']) expect(decodeURIComponent(u)).not.toContain(leak)
  })
  it('falls back to the street segment of the full address, never a bare city', () => {
    expect(propertySearchQuery({ property_address_full: '1348 S 6th St, Los Angeles, Ca 90017', property_address_city: 'Los Angeles', property_address_state: 'CA' })).toBe('1348 S 6th St, Los Angeles, CA')
    expect(propertySearchQuery({ property_address_full: 'Tampa, Fl 33604', property_address_city: 'Tampa', property_address_state: 'FL' })).toBeNull()
  })
  it('company research is a separate explicit query', () => {
    expect(companySearchQuery({ name: 'Kindle Enterprises LLC', state: 'Minnesota' })).toBe('"Kindle Enterprises LLC" MN')
    expect(companySearchQuery({ name: '   ' })).toBeNull()
  })
  it('providers + typed input', () => {
    expect(searchUrl('a b', 'bing')).toBe('https://www.bing.com/search?q=a%20b')
    expect(searchUrl('a b', 'duckduckgo')).toBe('https://duckduckgo.com/?q=a%20b')
    expect(resolveTypedInput('hcad.org/property-search')).toMatchObject({ kind: 'url', url: 'https://hcad.org/property-search' })
    expect(resolveTypedInput('zillow 3635 emerson')).toMatchObject({ kind: 'search', query: 'zillow 3635 emerson' })
    expect(resolveTypedInput('')).toMatchObject({ kind: 'invalid', reason: 'empty' })
  })
})

describe('prod APN formats (read-only shape census 2026-10-02) — every stored shape builds', () => {
  const P = (st: string, county: string, apn: string): ResearchProperty => ({ property_address_state: st, property_address_county_name: county, apn_parcel_id: apn })
  // [record, state, county as stored in prod, real stored APN, expected URL tail]
  const CASES: [string, string, string, string, string][] = [
    ['mn-hennepin-pins', 'MN', 'Hennepin', '04-029-24-43-0175', 'pid=0402924430175'],
    ['mn-hennepin-pins', 'MN', 'Hennepin', '01-027-24-34-0007', 'pid=0102724340007'],
    ['mn-hennepin-tax', 'MN', 'Hennepin', '04-029-24-43-0175', 'pid=0402924430175'],
    ['tx-dallas-dcad', 'TX', 'Dallas', '00-00011-057-800-0000', 'ID=00000110578000000'],
    ['tx-dallas-dcad', 'TX', 'Dallas', '28-04363-00D-002-0000', 'ID=280436300D0020000'],
    ['tx-dallas-dcad', 'TX', 'Dallas', '26-58750-000-51R-0000', 'ID=265875000051R0000'],
    ['tx-dallas-dcad', 'TX', 'Dallas', '00-00013-945-300-00HS', 'ID=000001394530000HS'],
    ['tx-dallas-dcad', 'TX', 'Dallas', '00000126433000000', 'ID=00000126433000000'],
    ['fl-miamidade-pa', 'FL', 'Miami-Dade', '01-0103-040-1110', 'folio=0101030401110'],
    ['fl-duval-pao', 'FL', 'Duval', '000147-0010', 'RE=0001470010'],
    ['ca-losangeles-assessor', 'CA', 'Los Angeles', '2006-008-033', 'parceldetail/2006008033'],
    ['nc-mecklenburg-polaris', 'NC', 'Mecklenburg', '027-011-06', 'pid/02701106'],
    ['az-maricopa-assessor', 'AZ', 'Maricopa', '101-10-006', 'q=10110006&mod=pd'],
    ['az-maricopa-assessor', 'AZ', 'Maricopa', '102-05-153-A', 'q=10205153A&mod=pd'],
    ['az-maricopa-assessor', 'AZ', 'Maricopa', '102-21-251A', 'q=10221251A&mod=pd'],
    ['il-cook-assessor', 'IL', 'Cook', '02-14-400-054-0000', 'pin/02144000540000'],
  ]
  it.each(CASES)('%s builds from stored %s/%s "%s"', (id, st, county, apn, tail) => {
    const r = buildDestinationUrl(rec(id), { property: P(st, county, apn) })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    if (r.ok) expect(r.url.endsWith(tail), r.url).toBe(true)
  })

  it('leading zeros are preserved, whitespace / NBSP / unicode dashes tolerated', () => {
    for (const apn of ['  04-029-24-43-0175 ', '04–029–24–43–0175', '04 029 24 43 0175', '04 029-24-43-0175', '0402924430175']) {
      expect(buildDestinationUrl(rec('mn-hennepin-pins'), { property: P('MN', 'Hennepin', apn) })).toMatchObject({ ok: true, url: 'https://www16.co.hennepin.mn.us/pins/pidresult.jsp?pid=0402924430175' })
    }
  })

  it('accepts other layers’ field names for the same stored value (parcel_apn, apn)', () => {
    const base = { property_address_state: 'MN', property_address_county_name: 'Hennepin' }
    expect(buildDestinationUrl(rec('mn-hennepin-pins'), { property: { ...base, parcel_apn: '04-029-24-43-0175' } })).toMatchObject({ ok: true })
    expect(buildDestinationUrl(rec('mn-hennepin-pins'), { property: { ...base, apn: '04-029-24-43-0175' } })).toMatchObject({ ok: true })
  })

  it('search-page counties copy the APN exactly as stored (incl. Fulton spacing)', () => {
    const r = buildDestinationUrl(rec('ga-fulton-qpublic'), { property: P('GA', 'Fulton', '07 220100250470') })
    expect(r).toMatchObject({ ok: true, copy: { label: 'Parcel ID', value: '07 220100250470' } })
    const d = buildDestinationUrl(rec('ga-dekalb-assessor'), { property: P('GA', 'De Kalb', '11-232-01-007') })
    expect(d).toMatchObject({ ok: true, copy: { value: '11-232-01-007' } })
  })
})
