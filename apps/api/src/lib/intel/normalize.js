/**
 * Buyer-intelligence normalization utilities (JS mirror of the SQL
 * intel_normalize_* functions). Used to prep subject-property inputs before
 * they reach the geospatial match RPC, and to canonicalize display values.
 *
 * These NEVER mutate raw source columns — they only compute canonical values.
 */

const US_STATES = {
  ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA',
  COLORADO: 'CO', CONNECTICUT: 'CT', DELAWARE: 'DE', FLORIDA: 'FL', GEORGIA: 'GA',
  HAWAII: 'HI', IDAHO: 'ID', ILLINOIS: 'IL', INDIANA: 'IN', IOWA: 'IA', KANSAS: 'KS',
  KENTUCKY: 'KY', LOUISIANA: 'LA', MAINE: 'ME', MARYLAND: 'MD', MASSACHUSETTS: 'MA',
  MICHIGAN: 'MI', MINNESOTA: 'MN', MISSISSIPPI: 'MS', MISSOURI: 'MO', MONTANA: 'MT',
  NEBRASKA: 'NE', NEVADA: 'NV', 'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ',
  'NEW MEXICO': 'NM', 'NEW YORK': 'NY', 'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND',
  OHIO: 'OH', OKLAHOMA: 'OK', OREGON: 'OR', PENNSYLVANIA: 'PA', 'RHODE ISLAND': 'RI',
  'SOUTH CAROLINA': 'SC', 'SOUTH DAKOTA': 'SD', TENNESSEE: 'TN', TEXAS: 'TX',
  UTAH: 'UT', VERMONT: 'VT', VIRGINIA: 'VA', WASHINGTON: 'WA', 'WEST VIRGINIA': 'WV',
  WISCONSIN: 'WI', WYOMING: 'WY', 'DISTRICT OF COLUMBIA': 'DC',
};

export function normalizeZip(zip) {
  if (zip === null || zip === undefined) return null;
  const digits = String(zip).replace(/\D/g, '');
  return digits.length >= 5 ? digits.slice(0, 5) : null;
}

export function normalizeState(state) {
  const raw = String(state ?? '').trim().toUpperCase();
  if (!raw) return null;
  if (US_STATES[raw]) return US_STATES[raw];
  return raw.slice(0, 2);
}

export function normalizeAssetClass(value) {
  if (value === null || value === undefined) return null;
  const v = String(value).trim();
  if (!v) return null;
  const l = v.toLowerCase();
  if (/single|sfr|sfh/.test(l)) return 'single_family';
  if (/multi|apartment|duplex|triplex|fourplex|quad/.test(l)) return 'multifamily';
  if (/condo/.test(l)) return 'condominium';
  if (/town/.test(l)) return 'townhouse';
  if (/vacant|land|lot/.test(l)) return 'land';
  if (/mobile|manufactured/.test(l)) return 'mobile_home';
  if (/commercial|office|retail|industrial|hotel/.test(l)) return 'commercial';
  return 'other';
}

function initCap(str) {
  return String(str)
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Prefer a real market label; otherwise derive "City, ST" from city + state;
 * otherwise fall back to state. Generic for every metro — no hardcoded crosswalk.
 */
export function normalizeMarket(market, city, state) {
  const m = String(market ?? '').trim();
  if (m && m.toLowerCase() !== 'other') return m;
  const st = normalizeState(state);
  const c = String(city ?? '').trim();
  if (c && st) return `${initCap(c)}, ${st}`;
  if (st) return st;
  return null;
}

export default { normalizeZip, normalizeState, normalizeAssetClass, normalizeMarket };
