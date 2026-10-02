/**
 * Sale-record vocabulary for the IC8 comp micro-market challenger.
 *
 * Converts snapshot records (schema comp-snapshot-v1, written by
 * scripts/intelligence/comps/build-comp-snapshot.mjs) into internal sale
 * objects and owns the three classifications every other module reads:
 *   - asset family  (sfr / mf_2_4 / mf_5_plus / condo / land / ...),
 *   - sale validity (is this a market transaction, and if not, why),
 *   - sale regime   (retail / investor / unknown).
 *
 * Fair housing: only property and transaction facts are read. Buyer type is a
 * transaction category (company/institution vs natural person); no names,
 * demographics or person attributes exist in these records.
 */

export const RECORD_SCHEMA_VERSION = 'comp-snapshot-v1';

export const ASSET_FAMILIES = Object.freeze([
  'sfr', 'mf_2_4', 'mf_5_plus', 'mf_unknown_units', 'condo', 'land', 'commercial', 'mobile', 'other',
  'sfr_unit_count_not_credible',
]);

/** Minimum floor area per unit for a recorded unit count to describe a building (engine rule, 2026-09-27). */
export const MIN_CREDIBLE_SQFT_PER_UNIT = 350;

const DISTRESS_OR_TRANSFER_DOC = /(quit\s*claim|trustee|sheriff|foreclos|tax deed|executor|personal representative|affidavit|gift|interfamily|public action|certificate of transfer|re-?recorded|correction|lis pendens)/i;

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Asset family from the record's own vocabulary plus a credible unit count. */
export function assetFamilyOf(record) {
  const type = String(record?.property_type ?? '').toLowerCase();
  const nac = String(record?.nac ?? '').toLowerCase();
  const units = num(record?.units);
  const sqft = num(record?.sqft);
  const byUnits = () => (units >= 5 ? 'mf_5_plus' : 'mf_2_4');
  if (/vacant|\bland\b|\blot\b/.test(type) || nac === 'land') return 'land';
  if (/commercial|office|retail|industrial|warehouse/.test(type) || nac === 'commercial') return 'commercial';
  if (/mobile|manufactured/.test(type) || nac === 'mobile_home') return 'mobile';
  if (/condo/.test(type) || nac === 'condo') return 'condo';
  if (/apartment/.test(type) || nac === 'apartment') return units >= 2 ? byUnits() : 'other';
  if (/multi|duplex|triplex|quad|plex/.test(type) || nac === 'multifamily') return units >= 2 ? byUnits() : 'mf_unknown_units';
  if (/single|townhouse|town home|row ?house/.test(type) || (!type && nac === 'single_family')) {
    if (units !== null && units > 1) {
      if (!sqft || sqft / units < MIN_CREDIBLE_SQFT_PER_UNIT) return 'sfr_unit_count_not_credible';
      return byUnits();
    }
    return 'sfr';
  }
  if (units !== null && units >= 2) return byUnits();
  return 'other';
}

/**
 * Is this a market transaction usable as evidence or as a label?
 * Returns { valid, reasons[] }. Reasons are codes, never prose.
 */
export function saleValidity(record) {
  const reasons = [];
  const price = num(record?.price);
  if (price === null) reasons.push('price_missing');
  else if (price < 10_000) reasons.push('price_below_floor');
  if (record?.price_estimated === true) reasons.push('price_estimated');
  const estValue = num(record?.est_value);
  if (record?.nominal_flag === true || (price !== null && estValue !== null && estValue > 0 && price / estValue < 0.25)) {
    reasons.push('nominal_price');
  }
  if (record?.distress_flag === true || DISTRESS_OR_TRANSFER_DOC.test(String(record?.doc_type ?? ''))) {
    reasons.push('distress_or_transfer_deed');
  }
  if (record?.arms_length === false) reasons.push('non_arms_length');
  if ((num(record?.package_n) ?? 0) >= 2) reasons.push('package_sale');
  if (record?.date_kind === 'deed_contract') reasons.push('contract_dated');
  if (!record?.sale_date) reasons.push('sale_date_missing');
  return { valid: reasons.length === 0, reasons };
}

/**
 * Sale regime: retail (end-user market), investor (company / institutional
 * buyer), or unknown (no buyer information). An MLS sale with an unknown
 * buyer is retail.
 */
export function saleRegime(record) {
  const buyer = record?.buyer_type;
  if (buyer === 'investor' || buyer === 'institutional') return 'investor';
  if (buyer === 'individual') return 'retail';
  if (record?.sale_type === 'mls') return 'retail';
  return 'unknown';
}

export function monthOf(dateText) {
  return String(dateText).slice(0, 7);
}

export function monthIndex(dateText) {
  const y = Number(String(dateText).slice(0, 4));
  const m = Number(String(dateText).slice(5, 7));
  return y * 12 + (m - 1);
}

export function daysBetween(a, b) {
  return (Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

/** Calendar-correct date minus N months (clamped to month end, like Postgres). */
export function subtractMonths(dateText, months) {
  const y = Number(dateText.slice(0, 4));
  const m = Number(dateText.slice(5, 7)) - 1;
  const d = Number(dateText.slice(8, 10));
  const target = y * 12 + m - months;
  const ty = Math.floor(target / 12);
  const tm = target - ty * 12;
  const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return `${String(ty).padStart(4, '0')}-${String(tm + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Snapshot record -> internal sale. Keeps the original record under `raw`
 * (the champion replica needs the engine-shaped fields).
 */
export function toSale(record) {
  const validity = saleValidity(record);
  const family = assetFamilyOf(record);
  const sqft = num(record.sqft);
  const price = num(record.price);
  return {
    id: record.id,
    src: record.src,
    region: record.region ?? null,
    market: record.market ?? null,
    pid: record.pid ?? null,
    addr_key: record.addr_key ?? null,
    parcel_key: record.parcel_key ?? null,
    lat: num(record.lat),
    lng: num(record.lng),
    zip: record.zip ?? null,
    sale_date: record.sale_date,
    known_date: record.known_date ?? record.sale_date,
    family,
    attached: record.unit_designator === true || family === 'condo',
    units: num(record.units),
    sqft: sqft && sqft >= 200 ? sqft : null,
    beds: num(record.beds),
    baths: num(record.baths),
    year_built: num(record.year_built),
    lot_sqft: num(record.lot_sqft),
    price,
    sale_type: record.sale_type,
    buyer_type: record.buyer_type ?? 'unknown',
    regime: saleRegime(record),
    valid: validity.valid,
    invalid_reasons: validity.reasons,
    dedup_role: record.dedup?.role ?? null,
    raw: record,
  };
}

/** Same physical property (any record of the subject is never its own comp). */
export function sameProperty(a, b) {
  if (a.pid && b.pid && a.pid === b.pid) return true;
  if (a.parcel_key && b.parcel_key && a.parcel_key === b.parcel_key) return true;
  if (a.addr_key && b.addr_key && a.addr_key === b.addr_key) return true;
  return false;
}
