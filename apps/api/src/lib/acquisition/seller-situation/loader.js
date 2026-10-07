// ─── seller-situation/loader.js ─────────────────────────────────────────────
// Batched raw-facts loader: exactly ONE query per source table per call
// (seller.property_features_v1 + public.properties), keyed by primary key
// (`property_id = ANY($1)`), never one request per property, never a
// national join. Callers chunk ids (runner: ≤ 200 per call).

import { FACT_FIELDS, buildRawFactsFromRows } from './model.js';

export const MAX_IDS_PER_CALL = 500;

const FEATURE_COLUMNS = Object.freeze([
  'property_id',
  ...new Set(FACT_FIELDS.map(([, f]) => f).filter(Boolean)),
  'own_absentee_class',
]);

/** Legacy columns are read ONLY so results can carry them under legacy_shadow. */
const LEGACY_SHADOW_COLUMNS = Object.freeze([
  'final_acquisition_score', 'structured_motivation_score', 'tag_distress_score', 'deal_strength_score',
]);

const PROPERTY_COLUMNS = Object.freeze([
  'property_id', 'master_owner_id', 'market', 'property_address_state', 'property_address_zip', 'property_type',
  ...new Set(FACT_FIELDS.map(([, , p]) => p).filter(Boolean)),
  'owner_location', 'is_foreclosure', 'is_pre_foreclosure', 'is_hot_preforeclosure', 'is_hot_pre_foreclosure',
  'property_flags_text',
  ...LEGACY_SHADOW_COLUMNS,
]);

export function loaderColumns() {
  return { features: [...new Set(FEATURE_COLUMNS)], properties: [...new Set(PROPERTY_COLUMNS)] };
}

function clean(v) { return String(v ?? '').trim(); }

async function selectByIds(db, { schema, table, columns, ids }) {
  if (typeof db?.query === 'function') {
    const cols = columns.map((c) => `"${c}"`).join(',');
    const res = await db.query(`select ${cols} from ${schema}.${table} where property_id = any($1::text[])`, [ids]);
    return res.rows ?? [];
  }
  if (typeof db?.from === 'function') {
    const base = schema === 'public' || typeof db.schema !== 'function' ? db : db.schema(schema);
    const { data, error } = await base.from(table).select(columns.join(',')).in('property_id', ids);
    if (error) throw error;
    return data ?? [];
  }
  throw new Error('seller_situation_loader_requires_db');
}

/**
 * @param {string[]} propertyIds
 * @param {object} db  pg client ({query}) or supabase-js client ({from, schema})
 * @returns {Promise<Map<string, import('./index.js').SellerRawFacts>>}
 */
export async function loadSellerRawFacts(propertyIds, db) {
  const ids = [...new Set((propertyIds || []).map(clean).filter(Boolean))];
  const out = new Map();
  if (!ids.length) return out;
  if (ids.length > MAX_IDS_PER_CALL) throw new Error(`seller_situation_loader_max_${MAX_IDS_PER_CALL}_ids`);
  const { features, properties } = loaderColumns();
  const [fRows, pRows] = await Promise.all([
    selectByIds(db, { schema: 'seller', table: 'property_features_v1', columns: features, ids }),
    selectByIds(db, { schema: 'public', table: 'properties', columns: properties, ids }),
  ]);
  const fById = new Map(fRows.map((r) => [clean(r.property_id), r]));
  const pById = new Map(pRows.map((r) => [clean(r.property_id), r]));
  for (const id of ids) {
    const property = pById.get(id) ?? null;
    const feat = fById.get(id) ?? null;
    if (!property && !feat) continue;
    out.set(id, buildRawFactsFromRows({ property: property ?? { property_id: id }, features: feat }));
  }
  return out;
}
