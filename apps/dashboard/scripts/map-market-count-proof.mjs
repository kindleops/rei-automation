#!/usr/bin/env node
/**
 * Proves national + market totals against direct Supabase aggregate RPCs.
 * Usage: node scripts/map-market-count-proof.mjs
 */
import { execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const apiDir = join(dirname(fileURLToPath(import.meta.url)), '../../api')

const runQuery = (sql) => {
  const out = execSync(
    `supabase db query --linked --output json ${JSON.stringify(sql)}`,
    { cwd: apiDir, encoding: 'utf8' },
  )
  return JSON.parse(out)
}

const national = runQuery(
  'SELECT COUNT(*)::bigint AS markets, SUM(property_count)::bigint AS total FROM get_map_market_aggregates(NULL, NULL);',
)
const markets = runQuery(
  "SELECT market, property_count::bigint AS property_count FROM get_map_market_aggregates(NULL, NULL) WHERE market IN ('Los Angeles, CA', 'Memphis, TN', 'Dallas, TX', 'Miami, FL') ORDER BY market;",
)

const expected = {
  total: 124_046,
  'Dallas, TX': 5_682,
  'Los Angeles, CA': 4_848,
  'Memphis, TN': 3_360,
  'Miami, FL': 11_756,
}

const total = Number(national[0]?.total ?? 0)
if (total !== expected.total) {
  console.error(`FAIL national total: got ${total}, expected ${expected.total}`)
  process.exit(1)
}

for (const row of markets) {
  const want = expected[row.market]
  const got = Number(row.property_count)
  if (want !== got) {
    console.error(`FAIL ${row.market}: got ${got}, expected ${want}`)
    process.exit(1)
  }
}

console.log('OK map market count proof', { total, markets: markets.length })