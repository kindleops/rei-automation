/**
 * S6 county records: parcel (APN) and situs-address normalization.
 * Pure and deterministic. Matching order is APN first, address second;
 * an address-only match is never auto-accepted (see matchProperty).
 */

const digitsOnly = (v) => String(v ?? '').replace(/\D+/g, '');
const squash = (v) => String(v ?? '').trim().toUpperCase().replace(/\s+/g, '');

/**
 * County-specific canonical APN. Returns null when the raw value cannot be a
 * parcel id for that county (better unmatched than mis-matched).
 * Formats verified 2026-10-08 against seller.property.apn and the open layers.
 */
const APN_RULES = {
  // Cuyahoga: seller.property '001-04-015'; Cleveland layer parcelpinDashed same.
  '39035': (raw) => {
    const d = digitsOnly(raw);
    if (d.length !== 8) return null;
    return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
  },
  // Franklin: seller.property '010-137397'; Columbus code layer '010137397';
  // auditor sometimes appends a '-00' split suffix.
  '39049': (raw) => {
    let d = digitsOnly(raw);
    if (d.length === 11 && d.endsWith('00')) d = d.slice(0, 9);
    if (d.length !== 9) return null;
    return `${d.slice(0, 3)}-${d.slice(3)}`;
  },
  // Wayne / Detroit: ward-item ids such as '22125216.', '22050187-8',
  // '02003617.001'. Punctuation is significant; only trim and upper-case.
  '26163': (raw) => {
    const s = squash(raw);
    if (!/^\d{2}\d{3,6}[.\-]?[0-9A-Z.\-]*$/.test(s)) return null;
    return s;
  },
  // Miami-Dade folio: 13 digits; seller.property '01-0103-040-1110'.
  '12086': (raw) => {
    const d = digitsOnly(raw);
    return d.length === 13 ? d : null;
  },
};

export function normalizeApn(fips, raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const rule = APN_RULES[String(fips)];
  if (rule) return rule(raw);
  const s = squash(raw);
  return s || null;
}

const SUFFIX = {
  STREET: 'ST', ST: 'ST', AVENUE: 'AVE', AVE: 'AVE', AV: 'AVE', ROAD: 'RD', RD: 'RD',
  DRIVE: 'DR', DR: 'DR', BOULEVARD: 'BLVD', BLVD: 'BLVD', LANE: 'LN', LN: 'LN',
  COURT: 'CT', CT: 'CT', PLACE: 'PL', PL: 'PL', TERRACE: 'TER', TER: 'TER',
  CIRCLE: 'CIR', CIR: 'CIR', PARKWAY: 'PKWY', PKWY: 'PKWY', HIGHWAY: 'HWY', HWY: 'HWY',
  WAY: 'WAY', TRAIL: 'TRL', TRL: 'TRL',
};
const DIRECTION = { NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W', N: 'N', S: 'S', E: 'E', W: 'W' };
const UNIT_MARKERS = new Set(['APT', 'UNIT', 'STE', 'SUITE', '#', 'FL', 'FLOOR', 'REAR', 'BLDG']);

/**
 * Situs address key: 'NUM [DIR] STREET [SUFFIX]' (+ '|zip5' when known).
 * Units are dropped on purpose: county code cases are filed per structure.
 */
export function normalizeSitus(address, zip) {
  if (!address) return null;
  const head = String(address).toUpperCase().split(',')[0];
  const tokens = head.replace(/[.]/g, '').replace(/#/g, ' # ').split(/\s+/).filter(Boolean);
  const out = [];
  for (const t of tokens) {
    if (UNIT_MARKERS.has(t)) break;
    out.push(SUFFIX[t] || DIRECTION[t] || t);
  }
  if (out.length < 2 || !/^\d+[A-Z]?$/.test(out[0])) return null;
  const z = digitsOnly(zip).slice(0, 5);
  return z.length === 5 ? `${out.join(' ')}|${z}` : out.join(' ');
}

/** Owner name key for owner-of-record comparison (not a person resolver). */
export function ownerKey(name) {
  if (!name) return null;
  const s = String(name)
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\b(LLC|INC|CORP|CO|LTD|LP|TRUST|TR|TRS|TRUSTEE|ETAL|ET AL|JR|SR|II|III|THE|AND)\b/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1)
    .sort();
  return s.length ? s.join(' ') : null;
}

/**
 * Match one county observation to our property index.
 * index: { byApn: Map<fips|apn, propertyId[]>, bySitus: Map<situsKey, propertyId[]> }
 * Returns { propertyId, method, confidence } or { propertyId: null, reason }.
 */
export function matchProperty(obs, index) {
  const apn = normalizeApn(obs.fips, obs.apnRaw);
  if (apn) {
    const hits = index.byApn.get(`${obs.fips}|${apn}`) || [];
    if (hits.length === 1) return { propertyId: hits[0], method: 'apn', confidence: 'exact' };
    if (hits.length > 1) return { propertyId: null, reason: 'apn_ambiguous', candidates: hits };
  }
  const situs = normalizeSitus(obs.situsRaw, obs.zipRaw);
  if (situs) {
    const hits = index.bySitus.get(situs) || [];
    if (hits.length === 1) return { propertyId: hits[0], method: 'situs', confidence: 'review' };
    if (hits.length > 1) return { propertyId: null, reason: 'situs_ambiguous', candidates: hits };
  }
  return { propertyId: null, reason: apn ? 'apn_not_in_universe' : 'unparseable_apn' };
}
