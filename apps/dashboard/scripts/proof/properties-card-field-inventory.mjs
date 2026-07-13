#!/usr/bin/env node
/**
 * Audits public.properties columns with live population counts.
 * Output: proof/map-cards/properties-card-field-inventory.json + .md
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../..')
const OUT_JSON = path.join(ROOT, 'proof/map-cards/properties-card-field-inventory.json')
const OUT_MD = path.join(ROOT, 'proof/map-cards/properties-card-field-inventory.md')

const ZEROISH_NUMERIC = new Set([
  'stories', 'rent_estimate', 'monthly_rent', 'gross_monthly_income',
  'gross_annual_income', 'noi_estimate', 'cap_rate', 'arv_estimate', 'comp_confidence_score',
])

const HIDDEN_INTERNAL = /^(id$|_id$|_hash$|_raw$|_json$|podio_|import_|batch_|sync_|geog_|geom_|uuid$)/i

const DISPLAY_GROUPS = {
  identity: ['property_id', 'property_address', 'property_address_full', 'property_address_city', 'property_address_state', 'property_address_zip', 'market', 'latitude', 'longitude', 'master_owner_id'],
  structure: ['total_bedrooms', 'total_baths', 'building_square_feet', 'units_count', 'sum_buildings_nbr', 'sum_commercial_units', 'sum_garage_sqft', 'num_of_fireplaces', 'year_built', 'effective_year_built', 'avg_sqft_per_unit', 'avg_beds_per_unit', 'avg_baths_per_unit'],
  construction: ['building_condition', 'building_quality', 'construction_type', 'exterior_walls', 'interior_walls', 'floor_cover', 'style', 'rehab_level'],
  systems: ['air_conditioning', 'heating_type', 'heating_fuel_type', 'sewer', 'water'],
  amenities: ['basement', 'garage', 'pool', 'porch', 'patio', 'deck', 'driveway'],
  roof: ['roof_type', 'roof_cover'],
  site: ['lot_square_feet', 'lot_acreage', 'lot_frontage', 'lot_depth', 'topography', 'zoning', 'county_land_use_code', 'property_use', 'building_class', 'flood_zone', 'hoa1_name', 'hoa1_type', 'hoa_fee_amount'],
  valuation: ['estimated_value', 'equity_amount', 'equity_percent', 'estimated_repair_cost', 'assd_total_value', 'assd_land_value', 'assd_improvement_value', 'calculated_total_value', 'calculated_land_value', 'calculated_improvement_value', 'tax_amt', 'tax_year'],
  loan: ['total_loan_balance', 'loan_count', 'loan_type', 'original_loan_amount', 'loan_payment'],
  transaction: ['saleprice', 'sale_date', 'recording_date', 'document_type', 'ownership_years', 'mls_status', 'current_listing_price', 'mls_sold_date', 'mls_sold_price'],
  distress: ['tax_delinquent', 'tax_delinquent_year', 'past_due_amount', 'active_lien', 'lienholder', 'lien_type', 'lien_position', 'lien_recording_date'],
  foreclosure: [/foreclosure/i, /pre_foreclosure/i, /auction/i, /probate/i, /code_violation/i],
  media: ['streetview_image', 'map_image', 'satellite_image'],
  asset: ['property_type', 'property_class', 'normalized_asset_class', 'commercial_category', 'commercial_subtype', 'storage_subtype'],
  owner: ['owner_name', 'owner_type', 'absentee_owner', 'out_of_state_owner'],
  score: ['priority_score', 'final_acquisition_score', 'motivation_score'],
}

function runSql(sql) {
  const tmp = path.join(ROOT, '.tmp-inventory.sql')
  fs.writeFileSync(tmp, sql)
  try {
    const raw = execSync(`supabase db query --linked -f "${tmp}" -o json`, {
      cwd: path.resolve(ROOT, '../..'),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    const parsed = JSON.parse(raw)
    return parsed
  } finally {
    fs.unlinkSync(tmp)
  }
}

function classifyColumn(name, dataType, populatedPct) {
  const hide = HIDDEN_INTERNAL.test(name) || name.startsWith('internal_')
  const zeroBlocked = ZEROISH_NUMERIC.has(name) && populatedPct === 0

  let displayGroup = 'other'
  for (const [group, keys] of Object.entries(DISPLAY_GROUPS)) {
    if (keys.some((k) => (k instanceof RegExp ? k.test(name) : k === name))) {
      displayGroup = group
      break
    }
  }

  const hoverFields = new Set(['estimated_value', 'equity_percent', 'total_loan_balance', 'estimated_repair_cost', 'units_count', 'building_square_feet', 'lot_acreage', 'lot_square_feet', 'zoning', 'county_land_use_code', 'assd_land_value'])
  const expandedOnly = populatedPct > 0 && !hide && !zeroBlocked

  return {
    operatorUsefulness: hide || zeroBlocked ? 'hidden' : populatedPct >= 50 ? 'high' : populatedPct >= 10 ? 'medium' : populatedPct > 0 ? 'low' : 'none',
    displayGroup,
    inHover: hoverFields.has(name),
    inExpanded: expandedOnly && displayGroup !== 'owner',
    distressOnly: displayGroup === 'distress' || displayGroup === 'foreclosure',
    mustRemainHidden: hide || zeroBlocked,
    hydrationStatus: hoverFields.has(name) ? 'pin_feed_or_detail' : expandedOnly ? 'detail_required' : 'not_used',
    normalization: dataType.includes('numeric') || dataType === 'integer' || dataType === 'double precision'
      ? 'null_if_zeroish'
      : dataType === 'boolean'
        ? 'boolean'
        : 'text_trim',
  }
}

function displayLabel(name) {
  return name
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/Assd /, 'Assessed ')
    .replace(/Mls /, 'MLS ')
    .replace(/Hoa /, 'HOA ')
}

async function main() {
  const metaRows = runSql(`
    SELECT column_name, data_type, udt_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'properties'
    ORDER BY ordinal_position;
  `)

  const columns = metaRows.map((r) => r.column_name)
  const totalRow = runSql('SELECT count(*)::bigint AS total FROM public.properties;')[0].total

  const chunkSize = 40
  const population = {}
  for (let i = 0; i < columns.length; i += chunkSize) {
    const chunk = columns.slice(i, i + chunkSize)
    const sums = chunk.map((col) => {
      const isBool = metaRows.find((m) => m.column_name === col)?.data_type === 'boolean'
      const isNum = ['integer', 'bigint', 'numeric', 'double precision', 'real', 'smallint'].includes(
        metaRows.find((m) => m.column_name === col)?.data_type ?? '',
      )
      if (isBool) {
        return `sum(CASE WHEN "${col}" IS NOT NULL THEN 1 ELSE 0 END)::bigint AS "${col}"`
      }
      if (isNum) {
        return `sum(CASE WHEN "${col}" IS NOT NULL AND "${col}"::text <> '' AND "${col}"::double precision <> 0 THEN 1 ELSE 0 END)::bigint AS "${col}"`
      }
      return `sum(CASE WHEN "${col}" IS NOT NULL AND btrim("${col}"::text) <> '' THEN 1 ELSE 0 END)::bigint AS "${col}"`
    }).join(',\n  ')
    const row = runSql(`SELECT\n  ${sums}\nFROM public.properties;`)[0]
    Object.assign(population, row)
  }

  const sampleSql = columns.slice(0, 5).map((c) => `"${c}"`).join(', ')
  const sampleRow = runSql(`SELECT ${sampleSql} FROM public.properties WHERE property_id IS NOT NULL LIMIT 3;`)

  const inventory = metaRows.map((meta) => {
    const populatedCount = Number(population[meta.column_name] ?? 0)
    const populatedPct = totalRow > 0 ? Math.round((populatedCount / totalRow) * 10000) / 100 : 0
    const classification = classifyColumn(meta.column_name, meta.data_type, populatedPct)
    return {
      columnName: meta.column_name,
      dataType: meta.data_type,
      udtName: meta.udt_name,
      nullable: meta.is_nullable === 'YES',
      totalRows: totalRow,
      populatedCount,
      populatedPercent: populatedPct,
      displayLabel: displayLabel(meta.column_name),
      applicableAssetTypes: ['all'],
      ...classification,
    }
  })

  const payload = {
    generatedAt: new Date().toISOString(),
    table: 'public.properties',
    totalRows: totalRow,
    columnCount: inventory.length,
    sampleRows: sampleRow,
    columns: inventory,
  }

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true })
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(payload, null, 2)}\n`)

  const md = [
    '# Properties Card Field Inventory',
    '',
    `Generated: ${payload.generatedAt}`,
    '',
    `Table: \`public.properties\``,
    `Total rows: **${totalRow.toLocaleString()}**`,
    `Columns audited: **${inventory.length}**`,
    '',
    'Population counts are exact non-null / non-empty / non-zero counts from production.',
    '',
    '| Column | Type | Populated | % | Group | Hover | Expanded | Hidden |',
    '|--------|------|-----------|---|-------|-------|----------|--------|',
    ...inventory.map((c) => (
      `| ${c.columnName} | ${c.dataType} | ${c.populatedCount.toLocaleString()} | ${c.populatedPercent}% | ${c.displayGroup} | ${c.inHover ? 'yes' : 'no'} | ${c.inExpanded ? 'yes' : 'no'} | ${c.mustRemainHidden ? 'yes' : 'no'} |`
    )),
    '',
  ].join('\n')

  fs.writeFileSync(OUT_MD, md)
  console.log(`Wrote ${OUT_JSON} (${inventory.length} columns)`)
  console.log(`Wrote ${OUT_MD}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})