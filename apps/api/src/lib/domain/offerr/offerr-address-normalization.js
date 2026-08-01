/**
 * Offerr Evaluation Spine — deterministic seller-address normalization.
 *
 * Parses ordinary seller-entered address variation into structured
 * components so the resolver can compare street number / name / suffix /
 * directional / unit / city / state / ZIP individually instead of relying on
 * one monolithic string. Everything here is a pure deterministic function:
 * fixed token maps, no scoring, no network, no randomness.
 *
 * The canonical `properties` table stores addresses as strings
 * (property_address_full + city/state/zip columns), so canonical rows are
 * parsed with the SAME parser; structured columns override parsed values
 * where present. This is a documented limitation, not fabricated certainty —
 * a future provider adapter can supply pre-structured components through the
 * same shape.
 */

/** USPS-style street-suffix normalization (both directions map to the short form). */
const SUFFIX_MAP = Object.freeze({
  street: 'st', st: 'st',
  avenue: 'ave', ave: 'ave', av: 'ave',
  road: 'rd', rd: 'rd',
  drive: 'dr', dr: 'dr',
  boulevard: 'blvd', blvd: 'blvd',
  lane: 'ln', ln: 'ln',
  court: 'ct', ct: 'ct',
  circle: 'cir', cir: 'cir',
  highway: 'hwy', hwy: 'hwy',
  parkway: 'pkwy', pkwy: 'pkwy',
  place: 'pl', pl: 'pl',
  terrace: 'ter', ter: 'ter',
  trail: 'trl', trl: 'trl',
  way: 'way',
  loop: 'loop',
  cove: 'cv', cv: 'cv',
  square: 'sq', sq: 'sq',
});

const DIRECTIONAL_MAP = Object.freeze({
  north: 'n', n: 'n',
  south: 's', s: 's',
  east: 'e', e: 'e',
  west: 'w', w: 'w',
  northeast: 'ne', ne: 'ne',
  northwest: 'nw', nw: 'nw',
  southeast: 'se', se: 'se',
  southwest: 'sw', sw: 'sw',
});

/** Full state names -> USPS abbreviations (plus identity for abbreviations). */
const STATE_NAME_MAP = Object.freeze({
  alabama: 'al', alaska: 'ak', arizona: 'az', arkansas: 'ar', california: 'ca',
  colorado: 'co', connecticut: 'ct', delaware: 'de', florida: 'fl', georgia: 'ga',
  hawaii: 'hi', idaho: 'id', illinois: 'il', indiana: 'in', iowa: 'ia',
  kansas: 'ks', kentucky: 'ky', louisiana: 'la', maine: 'me', maryland: 'md',
  massachusetts: 'ma', michigan: 'mi', minnesota: 'mn', mississippi: 'ms',
  missouri: 'mo', montana: 'mt', nebraska: 'ne', nevada: 'nv',
  'new hampshire': 'nh', 'new jersey': 'nj', 'new mexico': 'nm', 'new york': 'ny',
  'north carolina': 'nc', 'north dakota': 'nd', ohio: 'oh', oklahoma: 'ok',
  oregon: 'or', pennsylvania: 'pa', 'rhode island': 'ri', 'south carolina': 'sc',
  'south dakota': 'sd', tennessee: 'tn', texas: 'tx', utah: 'ut', vermont: 'vt',
  virginia: 'va', washington: 'wa', 'west virginia': 'wv', wisconsin: 'wi',
  wyoming: 'wy', 'district of columbia': 'dc',
});

const STATE_ABBREVS = new Set(Object.values(STATE_NAME_MAP));

const UNIT_DESIGNATORS = Object.freeze(['apt', 'apartment', 'unit', 'ste', 'suite', 'lot', '#']);

function clean(value) {
  return String(value ?? '').trim();
}

/**
 * Lowercase, strip punctuation to spaces (commas preserved as segment
 * separators by the caller), split glued directionals ("123N Main" ->
 * "123 n main"), collapse whitespace.
 */
function normalizeSegmentText(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[.]/g, ' ')
    .replace(/#/g, ' # ')
    .replace(/\b(\d+)(n|s|e|w|ne|nw|se|sw)\b/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pull a ZIP / ZIP+4 out of a token stream, scanning from the end.
 *
 * `minIndex` protects the leading street number. Without a comma tail the
 * combined stream IS the street segment, so token 0 is the house number — and
 * a five-digit house number ("12345 Main St") matches the ZIP pattern exactly.
 * Consuming it left `tokens[0] === 'main'`, which failed the street-number
 * test and returned `missing_street_number` for a perfectly valid address.
 * Canonical `property_address_full` values are parsed by this same function,
 * so those rows failed to parse too.
 */
function extractZip(tokens, { minIndex = 0 } = {}) {
  for (let i = tokens.length - 1; i >= minIndex; i -= 1) {
    const m = /^(\d{5})(?:-(\d{4}))?$/.exec(tokens[i]);
    if (m) {
      tokens.splice(i, 1);
      return { zip5: m[1], zip4: m[2] ?? null };
    }
  }
  return { zip5: null, zip4: null };
}

function extractState(tokens, { allowCollisions = false } = {}) {
  if (tokens.length === 0) return null;
  const last = tokens[tokens.length - 1];
  // In comma-less input, "Ct" (court) and "NE" (quadrant) style tokens are
  // suffix/directional homographs — never claim them as states there.
  const collides = Boolean(SUFFIX_MAP[last] || DIRECTIONAL_MAP[last]);
  if (last.length === 2 && STATE_ABBREVS.has(last) && (allowCollisions || !collides)) {
    tokens.pop();
    return last;
  }
  const lastTwo = tokens.slice(-2).join(' ');
  if (STATE_NAME_MAP[lastTwo]) {
    tokens.splice(-2, 2);
    return STATE_NAME_MAP[lastTwo];
  }
  const three = tokens.slice(-3).join(' ');
  if (STATE_NAME_MAP[three]) {
    tokens.splice(-3, 3);
    return STATE_NAME_MAP[three];
  }
  if (STATE_NAME_MAP[last]) {
    tokens.pop();
    return STATE_NAME_MAP[last];
  }
  return null;
}

function extractUnit(tokens) {
  for (let i = 0; i < tokens.length; i += 1) {
    const designator = tokens[i];
    if (UNIT_DESIGNATORS.includes(designator) && i + 1 < tokens.length) {
      const value = tokens[i + 1];
      if (/^[a-z0-9-]{1,8}$/.test(value)) {
        tokens.splice(i, 2);
        return value.toUpperCase();
      }
      if (designator === '#') {
        tokens.splice(i, 1);
        return null;
      }
    }
  }
  return null;
}

/**
 * Parse one address string into deterministic structured components.
 *
 * @param {string} raw - Seller-entered or canonical address string.
 * @returns {{
 *   ok: boolean,
 *   reason: string|null,
 *   street_number: string|null,
 *   pre_directional: string|null,
 *   street_name: string|null,
 *   suffix: string|null,
 *   post_directional: string|null,
 *   unit: string|null,
 *   city: string|null,
 *   state: string|null,
 *   zip5: string|null,
 *   zip4: string|null,
 *   base_key: string|null,
 *   full_key: string|null,
 * }}
 */
export function parseSellerAddress(raw) {
  const empty = {
    ok: false,
    reason: 'empty_address',
    street_number: null,
    pre_directional: null,
    street_name: null,
    suffix: null,
    post_directional: null,
    unit: null,
    city: null,
    state: null,
    zip5: null,
    zip4: null,
    base_key: null,
    full_key: null,
  };
  const text = clean(raw);
  if (!text) return empty;

  // Commas are authoritative segment separators when present.
  const segments = text
    .split(',')
    .map((s) => normalizeSegmentText(s))
    .filter(Boolean);
  if (segments.length === 0) return empty;

  let streetTokens;
  let cityTokens = [];
  let tailTokens = [];

  if (segments.length >= 2) {
    streetTokens = segments[0].split(' ');
    const rest = segments.slice(1).join(' ').split(' ').filter(Boolean);
    tailTokens = rest;
  } else {
    streetTokens = segments[0].split(' ');
  }

  // ZIP and state always live in the tail of the combined token stream.
  const hasCommaTail = tailTokens.length > 0;
  const combinedTail = hasCommaTail ? tailTokens : streetTokens;
  // With a comma tail the tail contains no house number, so every token is a
  // ZIP candidate. Without one, token 0 is the house number and must never be
  // consumed as a ZIP.
  const { zip5, zip4 } = extractZip(combinedTail, { minIndex: hasCommaTail ? 0 : 1 });
  const state = extractState(combinedTail, { allowCollisions: hasCommaTail });

  const unit =
    extractUnit(streetTokens) ?? (tailTokens.length > 0 ? extractUnit(tailTokens) : null);

  if (tailTokens.length > 0) {
    cityTokens = tailTokens.filter(Boolean);
  }

  // Street segment: number, optional pre-directional, name, suffix,
  // optional post-directional; without commas the remainder is the city.
  const tokens = streetTokens.filter(Boolean);
  const numberToken = tokens[0];
  if (!numberToken || !/^\d+[a-z]?$/.test(numberToken)) {
    return { ...empty, ok: false, reason: 'missing_street_number', zip5, zip4, state };
  }
  tokens.shift();

  let preDirectional = null;
  if (tokens.length > 1 && DIRECTIONAL_MAP[tokens[0]]) {
    preDirectional = DIRECTIONAL_MAP[tokens[0]];
    tokens.shift();
  }

  // Last suffix-looking token bounds the street name; tokens after it are the
  // post-directional and (comma-less input) the city.
  let suffixIndex = -1;
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    if (SUFFIX_MAP[tokens[i]]) {
      suffixIndex = i;
      break;
    }
  }

  let nameTokens;
  let suffix = null;
  let postDirectional = null;
  let inlineCityTokens = [];

  if (suffixIndex >= 0) {
    nameTokens = tokens.slice(0, suffixIndex);
    suffix = SUFFIX_MAP[tokens[suffixIndex]];
    let after = tokens.slice(suffixIndex + 1);
    if (after.length > 0 && DIRECTIONAL_MAP[after[0]]) {
      postDirectional = DIRECTIONAL_MAP[after[0]];
      after = after.slice(1);
    }
    inlineCityTokens = after;
  } else {
    nameTokens = tokens;
  }

  // "10 North St": consuming the directional emptied the name — the
  // directional WAS the street name.
  if (nameTokens.length === 0 && preDirectional) {
    nameTokens = [preDirectional === 'n' ? 'north' : preDirectional === 's' ? 'south' : preDirectional === 'e' ? 'east' : preDirectional === 'w' ? 'west' : preDirectional];
    preDirectional = null;
  }

  if (nameTokens.length === 0) {
    return { ...empty, ok: false, reason: 'missing_street_name', zip5, zip4, state };
  }

  if (cityTokens.length === 0 && inlineCityTokens.length > 0) {
    cityTokens = inlineCityTokens;
  }

  const streetName = nameTokens.join(' ');
  const city = cityTokens.length > 0 ? cityTokens.join(' ') : null;

  const baseKey = [numberToken, preDirectional, streetName, suffix, postDirectional]
    .filter(Boolean)
    .join(' ');

  return {
    ok: true,
    reason: null,
    street_number: numberToken,
    pre_directional: preDirectional,
    street_name: streetName,
    suffix,
    post_directional: postDirectional,
    unit,
    city,
    state,
    zip5,
    zip4,
    base_key: baseKey,
    full_key: unit ? `${baseKey} #${unit.toLowerCase()}` : baseKey,
  };
}

/** Normalize a free-text city for comparison ("St. Louis" ~ "st louis"). */
export function normalizeCityName(value) {
  return normalizeSegmentText(value);
}

/** Normalize a state (full name or abbreviation) to its USPS abbreviation. */
export function normalizeStateCode(value) {
  const v = normalizeSegmentText(value);
  if (!v) return null;
  if (v.length === 2 && STATE_ABBREVS.has(v)) return v;
  return STATE_NAME_MAP[v] ?? null;
}

/** Five-digit ZIP from any ZIP or ZIP+4 string. */
export function normalizeZip5(value) {
  const m = /^(\d{5})(?:-\d{4})?$/.exec(clean(value));
  return m ? m[1] : null;
}

export default {
  parseSellerAddress,
  normalizeCityName,
  normalizeStateCode,
  normalizeZip5,
};
