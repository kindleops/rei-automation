/**
 * S6 county records: ingestion (DESIGN SKELETON; no live wiring).
 *
 * readArcgisLayer() pages an ArcGIS REST layer through an INJECTED fetchJson
 * (tests never touch the network). mapRow() turns one raw source row into
 * zero or more canonical observations carrying full provenance:
 *   source_id, source_url, retrieved_at, source_last_edit, record_date.
 * Observations are facts as the source states them. Interpretation happens
 * in evidence.js.
 */

import { createHash } from 'node:crypto';
import { SOURCE_TYPE, getPilotSource } from './sourceCatalog.js';
import { normalizeApn } from './normalize.js';

const MIN_VALID_YEAR = 1990;

/** ArcGIS dates are epoch-ms; some layers ship strings. Impossible years → null. */
export function parseSourceDate(value, now = new Date()) {
  if (value == null || value === '') return null;
  const d = typeof value === 'number' ? new Date(value) : new Date(String(value));
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  if (y < MIN_VALID_YEAR || y > now.getUTCFullYear() + 1) return null;
  return d.toISOString().slice(0, 10);
}

const truthy = (v) => v === 1 || v === true || v === '1' || v === 'Y' || v === 'y';
const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

function hashPayload(obj) {
  return createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 32);
}

function base(source, row, ctx, sourceType, extra) {
  const f = source.fields;
  const apnRaw = source.apnField ? row[source.apnField] : null;
  const obs = {
    source_id: source.id,
    source_type: sourceType,
    fips: source.fips,
    apn_raw: apnRaw ?? null,
    apn_norm: normalizeApn(source.fips, apnRaw),
    situs_raw: f.situs ? row[f.situs] ?? null : null,
    owner_of_record: f.owner ? row[f.owner] ?? null : null,
    record_date: null,
    status: null,
    amount: null,
    case_id: null,
    case_type: null,
    data_defects: [],
    retrieved_at: ctx.retrievedAt,
    source_url: source.url,
    source_last_edit: ctx.sourceLastEdit ?? null,
    ...extra,
  };
  obs.record_key = `${source.id}:${obs.case_id || obs.apn_norm || obs.apn_raw}:${sourceType}`;
  obs.payload_hash = hashPayload(row);
  return obs;
}

const MAPPERS = {
  cle_property_insights(source, row, ctx) {
    const f = source.fields;
    const out = [];
    const recordDate = parseSourceDate(row[f.recordDate], ctx.now);
    const amount = num(row[f.taxDelinquentAmount]);
    // Always emit the roll row: a NOT-delinquent reading contradicts a vendor flag.
    out.push(
      base(source, row, ctx, SOURCE_TYPE.PARCEL_ROLL, {
        record_date: recordDate,
        status: 'of_record',
        last_transfer_date: parseSourceDate(row[f.lastTransferDate], ctx.now),
        rental_registered: truthy(row[f.rentalRegistered]),
        gov_owned: truthy(row[f.countyLandBank]) || truthy(row[f.cityLandBank]) || truthy(row[f.cityOwned]),
      }),
    );
    out.push(
      base(source, row, ctx, SOURCE_TYPE.TAX_DELINQUENCY, {
        record_date: recordDate,
        status: truthy(row[f.taxDelinquent]) ? 'delinquent' : 'current',
        amount,
        payment_plan: truthy(row[f.paymentPlan]),
      }),
    );
    if (truthy(row[f.certSold])) {
      out.push(base(source, row, ctx, SOURCE_TYPE.TAX_SALE, { record_date: recordDate, status: 'certificate_sold' }));
    }
    if (truthy(row[f.foreclosureFlag])) {
      out.push(base(source, row, ctx, SOURCE_TYPE.TAX_SALE, { record_date: recordDate, status: 'tax_foreclosure_filed' }));
    }
    const v6 = num(row[f.codeViolations6mo]) || 0;
    if (v6 > 0) {
      out.push(
        base(source, row, ctx, SOURCE_TYPE.CODE_ENFORCEMENT, {
          record_date: parseSourceDate(row[f.lastCodeViolationDate], ctx.now),
          status: 'violation_last_6mo',
          amount: v6,
        }),
      );
    }
    if (truthy(row[f.countyLandBank]) || truthy(row[f.cityLandBank])) {
      out.push(base(source, row, ctx, SOURCE_TYPE.LAND_BANK, { record_date: recordDate, status: 'land_bank_owned' }));
    }
    return out;
  },

  cle_active_condemnations(source, row, ctx) {
    const f = source.fields;
    return [
      base(source, row, ctx, SOURCE_TYPE.CONDEMNATION, {
        record_date: parseSourceDate(row[f.caseDate], ctx.now),
        status: truthy(row[f.status]) || row[f.status] == null ? 'active' : 'inactive',
      }),
    ];
  },

  cbus_code_cases(source, row, ctx) {
    const f = source.fields;
    const type = String(row[f.caseType] || '');
    const sub = String(row[f.caseSubType] || '');
    const status = String(row[f.status] || '');
    // Noise, inoperable vehicles, PACE and plain zoning are not seller distress.
    const relevant = /Housing Code|Vacant Structure|Emergency Order|Environmental Nuisance|Building/i.test(type);
    if (!relevant) return [];
    const isVacant = /Vacant/i.test(type) || /Vacant/i.test(sub);
    return [
      base(source, row, ctx, isVacant ? SOURCE_TYPE.VACANT_REGISTRY : SOURCE_TYPE.CODE_ENFORCEMENT, {
        record_date: parseSourceDate(row[f.caseDate], ctx.now),
        status: /closed/i.test(status) ? 'closed' : status.toLowerCase() || 'unknown',
        case_id: row[f.caseId] ?? null,
        case_type: sub ? `${type} / ${sub}` : type,
        last_inspection_date: parseSourceDate(row[f.lastInspectionDate], ctx.now),
      }),
    ];
  },

  det_blight_tickets(source, row, ctx) {
    const f = source.fields;
    const issued = parseSourceDate(row[f.caseDate], ctx.now);
    const balance = num(row[f.amountDue]);
    const defects = [];
    if (row[f.caseDate] && !issued) defects.push('impossible_issue_date');
    return [
      base(source, row, ctx, SOURCE_TYPE.CODE_ENFORCEMENT, {
        record_date: issued || parseSourceDate(row[f.judgmentDate], ctx.now),
        status: balance && balance > 0 ? 'unpaid_balance' : 'paid_or_dismissed',
        amount: balance,
        case_id: row[f.caseId] ?? null,
        case_type: row[f.caseType] ?? null,
        data_defects: defects,
      }),
    ];
  },

  det_dlba_buildings(source, row, ctx) {
    const f = source.fields;
    return [base(source, row, ctx, SOURCE_TYPE.LAND_BANK, { status: 'land_bank_owned', case_id: row[f.caseId] ?? null })];
  },
};

export function mapRow(sourceId, row, ctx) {
  const source = getPilotSource(sourceId);
  const mapper = MAPPERS[sourceId];
  if (!source || !mapper) throw new Error(`no mapper for source ${sourceId}`);
  return mapper(source, row, ctx);
}

/**
 * Page an ArcGIS layer. `where` should be parcel-scoped for the pilot
 * (e.g. 'parcelpinDashed IN (...)' over our own universe), never 1=1.
 * deps: { fetchJson(url, body) → json, sleep(ms) }.
 */
export async function readArcgisLayer({ url, where, outFields, pageSize = 1000, maxPages = 50, delayMs = 1000 }, deps) {
  const rows = [];
  for (let page = 0; page < maxPages; page += 1) {
    const body = {
      where,
      outFields: outFields.join(','),
      returnGeometry: 'false',
      resultOffset: String(page * pageSize),
      resultRecordCount: String(pageSize),
      orderByFields: 'OBJECTID',
      f: 'json',
    };
    const json = await deps.fetchJson(`${url}/query`, body);
    if (json?.error) throw new Error(`arcgis error ${json.error.code}: ${json.error.message || ''}`);
    const feats = Array.isArray(json?.features) ? json.features : [];
    for (const ft of feats) rows.push(ft.attributes || {});
    if (!json?.exceededTransferLimit && feats.length < pageSize) break;
    if (delayMs) await deps.sleep(delayMs);
  }
  return rows;
}

/** Chunk a parcel list into IN-clauses that stay under URL/body limits. */
export function parcelInClauses(field, apns, chunk = 150) {
  const clean = [...new Set(apns.filter(Boolean).map((a) => String(a).replace(/'/g, '')))];
  const out = [];
  for (let i = 0; i < clean.length; i += chunk) {
    out.push(`${field} IN (${clean.slice(i, i + chunk).map((a) => `'${a}'`).join(',')})`);
  }
  return out;
}
