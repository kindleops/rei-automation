import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import type { Plugin } from 'vite'
import { createClient } from '@supabase/supabase-js'
import { fetchCensusZcta, fetchCensusCounty } from './src/lib/census/censusClient'
import { transformCensusRow } from './src/lib/census/censusTransform'

const requireFromDashboard = createRequire(import.meta.url)
const tslibShim = fileURLToPath(new URL('./src/lib/tslib-shim.ts', import.meta.url))
const reactEntry = path.dirname(requireFromDashboard.resolve('react/package.json'))
const reactDomEntry = path.dirname(requireFromDashboard.resolve('react-dom/package.json'))

/* ── Underwriting Logic (Shared with API) ────────────────────────── */

const SFR_MIN_PROFIT = 20000
const MF_MIN_PROFIT = 50000
const MF_PERCENT_PROFIT = 0.05

function calculateWholesaleDeal(input: any) {
  const { propertyType, arv, repairs, askingPrice } = input
  let minAssignmentFee = SFR_MIN_PROFIT
  if (propertyType?.startsWith('multifamily')) {
    minAssignmentFee = Math.max(MF_MIN_PROFIT, arv * MF_PERCENT_PROFIT)
  }
  const mao = (arv * 0.70) - repairs - minAssignmentFee
  const maoCeiling = (arv * 0.75) - repairs - minAssignmentFee
  const equity = arv - repairs - (askingPrice || mao)
  const marginPercent = askingPrice ? ((mao - askingPrice) / mao) * 100 : 0
  let score = 50
  if (askingPrice) {
    if (askingPrice <= mao) score += 30
    if (askingPrice <= mao * 0.9) score += 20
  }
  let verdict = 'maybe'
  if (score >= 80) verdict = 'strong-buy'
  else if (score >= 60) verdict = 'buy'
  else if (score < 40) verdict = 'pass'

  return {
    mao: Math.max(0, Math.floor(mao)),
    maoCeiling: Math.max(0, Math.floor(maoCeiling)),
    assignmentFee: minAssignmentFee,
    equity: Math.floor(equity),
    marginPercent: parseFloat(marginPercent.toFixed(2)),
    verdict,
    score
  }
}

async function fetchUnderwritingResearch(address: string, propertyType: string, apiKey: string) {
  const prompt = `You are an expert Real Estate Acquisitions Analyst. Your goal is to provide deep-dive research and comparables for a property address.

ADDRESS: ${address}
PROPERTY TYPE: ${propertyType}

RESEARCH SOURCE PRIORITY:
- SFR Comps: 1. Zillow Sold, 2. Redfin Sold, 3. Realtor.com Sold, 4. County Assessor/Recorder, 5. Google Maps.
- Rental Comps: 1. Zillow Rentals, 2. Rentometer, 3. Apartments.com, 4. Realtor.
- Multifamily Comps: 1. Crexi, 2. LoopNet, 3. Apartments.com, 4. County Records, 5. Local broker listings.

STRICT RULES:
1. SOLD COMPS ONLY for ARV. Sold comps override active listings.
2. PUBLIC RECORDS override estimates. NEVER use Zestimate or Redfin Estimate as the final ARV.
3. PROXIMITY: Prefer comps within 0.5 miles and 6 months. Expand to 1 mile and 12 months ONLY if needed.
4. MATCHING: Match property type, beds, baths, sqft, year built, and condition.
5. EVIDENCE: Provide a source_url for EVERY comp.
6. WEAK COMPS: Flag any comp further than 1 mile or older than 12 months as a "Weak Comp" in the market_context.

Return ONLY a valid JSON object matching the requested schema.`

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt + '\n\nIMPORTANT: Return ONLY the JSON object. Do not include markdown formatting or preamble.' }] }]
      })
    }
  )

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`Gemini API failed: ${err}`)
  }

  const result = await response.json() as any
  let content = result.candidates?.[0]?.content?.parts?.[0]?.text
  if (!content) throw new Error('Empty response from Gemini')
  
  // Clean potential markdown backticks
  content = content.replace(/```json/g, '').replace(/```/g, '').trim()
  
  return JSON.parse(content)
}

const translateApiPlugin = (): Plugin => ({
  name: 'nexus-translate-api',
  configureServer(server) {
    server.middlewares.use('/api/translate', async (req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: 'Method not allowed' }))
        return
      }

      let rawBody = ''
      req.on('data', (chunk) => {
        rawBody += chunk
      })

      req.on('end', async () => {
        try {
          const parsed = JSON.parse(rawBody || '{}') as {
            text?: unknown
            targetLanguage?: unknown
            sourceLanguage?: unknown
          }

          const text = typeof parsed.text === 'string' ? parsed.text.trim() : ''
          const targetLanguage = typeof parsed.targetLanguage === 'string' && parsed.targetLanguage.trim()
            ? parsed.targetLanguage.trim().toLowerCase()
            : 'en'
          const sourceLanguage = typeof parsed.sourceLanguage === 'string' && parsed.sourceLanguage.trim()
            ? parsed.sourceLanguage.trim().toLowerCase()
            : 'auto'

          if (!text) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'Missing text payload' }))
            return
          }

          const upstream = await fetch(
            `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sourceLanguage)}&tl=${encodeURIComponent(targetLanguage)}&dt=t&q=${encodeURIComponent(text)}`,
          )

          if (!upstream.ok) {
            res.statusCode = 502
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: `Translation provider failed (${upstream.status})` }))
            return
          }

          const payload = await upstream.json() as unknown
          const top = Array.isArray(payload) ? payload : []
          const sentenceRows = Array.isArray(top[0]) ? top[0] as unknown[] : []
          const translatedText = sentenceRows
            .map((row) => (Array.isArray(row) && typeof row[0] === 'string' ? row[0] : ''))
            .join('')
            .trim()
          const detectedLanguage = typeof top[2] === 'string' ? top[2] : null

          if (!translatedText) {
            res.statusCode = 502
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'Empty translation response' }))
            return
          }

          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({
            translatedText,
            detectedLanguage,
            targetLanguage,
          }))
        } catch (error) {
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({
            error: error instanceof Error ? error.message : 'Translation failed',
          }))
        }
      })
    })
  },
})

const underwriteApiPlugin = (env: Record<string, string>): Plugin => ({
  name: 'nexus-underwrite-api',
  configureServer(server) {
    server.middlewares.use('/api/internal/offers/underwrite', async (req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: 'Method not allowed' }))
        return
      }

      let rawBody = ''
      req.on('data', (chunk) => { rawBody += chunk })
      req.on('end', async () => {
        try {
          const parsed = JSON.parse(rawBody || '{}')
          const { address, propertyType = 'sfh', askingPrice } = parsed
          const apiKey = env.GEMINI_API_KEY

          if (!apiKey) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'GEMINI_API_KEY not configured in .env.local' }))
            return
          }

          if (!address) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'Address is required' }))
            return
          }

          const research = await fetchUnderwritingResearch(address, propertyType, apiKey)
          const financialAnalysis = calculateWholesaleDeal({
            propertyType,
            arv: research.valuation.arv_estimate,
            repairs: research.valuation.repair_estimate,
            askingPrice: askingPrice ? parseFloat(askingPrice) : null
          })

          const payload = {
            address,
            property_info: research.property_info,
            valuation: { ...research.valuation, ...financialAnalysis },
            comps: research.comps,
            market_context: research.market_context,
            underwritten_at: new Date().toISOString(),
            version: '1.0.0-dev'
          }

          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(payload))
        } catch (error) {
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Underwriting failed' }))
        }
      })
    })
  }
})

// ─── Census Sync Plugin ───────────────────────────────────────────────────────

const readBody = (req: import('node:http').IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => { raw += chunk })
    req.on('end', () => resolve(raw))
  })

const jsonRes = (res: import('node:http').ServerResponse, status: number, body: unknown): void => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

const censusSyncPlugin = (env: Record<string, string>): Plugin => ({
  name: 'nexus-census-sync-api',
  configureServer(server) {
    server.middlewares.use('/api/internal/census/sync', async (req, res) => {
      if (req.method !== 'POST') { jsonRes(res, 405, { error: 'Method not allowed' }); return }

      const apiKey = env['CENSUS_API_KEY']
      if (!apiKey) {
        jsonRes(res, 500, { error: 'CENSUS_API_KEY not configured in .env.local — do not hardcode this key' })
        return
      }

      const supabaseUrl = env['VITE_SUPABASE_URL']
      const supabaseKey = env['VITE_SUPABASE_SERVICE_ROLE_KEY'] || env['VITE_SUPABASE_ANON_KEY']
      if (!supabaseUrl || !supabaseKey) {
        jsonRes(res, 500, { error: 'Supabase env vars missing' })
        return
      }
      const supabase = createClient(supabaseUrl, supabaseKey)

      let body: unknown
      try { body = JSON.parse(await readBody(req) || '{}') } catch { jsonRes(res, 400, { error: 'Invalid JSON' }); return }

      const b = body as Record<string, unknown>
      const geoLevel = b['geo_level'] as string
      if (geoLevel !== 'zcta' && geoLevel !== 'county') {
        jsonRes(res, 400, { error: 'geo_level must be zcta or county' }); return
      }
      const sourceYear = typeof b['source_year'] === 'number' ? b['source_year'] : 2024

      // Create run record
      const runId = `run_${Date.now()}`
      await supabase.from('census_sync_runs').insert({
        run_id: runId,
        geo_level: geoLevel,
        source_year: sourceYear,
        status: 'running',
        started_at: new Date().toISOString(),
      }).maybeSingle()

      const errors: string[] = []
      let insertedOrUpdated = 0
      const examples: Array<{ geoid: string; acquisition_pressure_score: number }> = []

      try {
        if (geoLevel === 'zcta') {
          const zctas: string[] = Array.isArray(b['zctas']) ? (b['zctas'] as string[]) : []
          if (zctas.length === 0) { jsonRes(res, 400, { error: 'zctas array required' }); return }

          for (const zcta of zctas) {
            try {
              const rawRow = await fetchCensusZcta(zcta, sourceYear, apiKey)
              if (!rawRow) { errors.push(`ZCTA ${zcta}: no data returned`); continue }
              const metricsRow = transformCensusRow(rawRow)
              const { error: upsertError } = await supabase
                .from('census_geo_metrics')
                .upsert(metricsRow, { onConflict: 'geo_level,geoid,source_year' })
              if (upsertError) { errors.push(`ZCTA ${zcta} upsert: ${upsertError.message}`); continue }
              insertedOrUpdated++
              if (examples.length < 3) examples.push({ geoid: metricsRow.geoid, acquisition_pressure_score: metricsRow.acquisition_pressure_score })
            } catch (err) {
              errors.push(`ZCTA ${zcta}: ${err instanceof Error ? err.message : String(err)}`)
            }
          }

          const status = errors.length === 0 ? 'completed' : insertedOrUpdated > 0 ? 'partial' : 'failed'
          await supabase.from('census_sync_runs').update({
            status,
            completed_at: new Date().toISOString(),
            inserted_or_updated_count: insertedOrUpdated,
            error_count: errors.length,
          }).eq('run_id', runId)

          jsonRes(res, 200, {
            run_id: runId,
            requested_count: zctas.length,
            inserted_or_updated_count: insertedOrUpdated,
            error_count: errors.length,
            examples,
            errors: errors.slice(0, 10),
            status,
          })
        } else {
          // county
          const stateFips = String(b['state_fips'] ?? '')
          const countyFips = String(b['county_fips'] ?? '')
          if (!stateFips || !countyFips) { jsonRes(res, 400, { error: 'state_fips and county_fips required for county sync' }); return }

          try {
            const rawRow = await fetchCensusCounty(stateFips, countyFips, sourceYear, apiKey)
            if (rawRow) {
              const metricsRow = transformCensusRow(rawRow)
              const { error: upsertError } = await supabase
                .from('census_geo_metrics')
                .upsert(metricsRow, { onConflict: 'geo_level,geoid,source_year' })
              if (upsertError) errors.push(`County upsert: ${upsertError.message}`)
              else {
                insertedOrUpdated = 1
                examples.push({ geoid: metricsRow.geoid, acquisition_pressure_score: metricsRow.acquisition_pressure_score })
              }
            } else {
              errors.push(`County ${stateFips}/${countyFips}: no data returned`)
            }
          } catch (err) {
            errors.push(err instanceof Error ? err.message : String(err))
          }

          const status = errors.length === 0 ? 'completed' : 'failed'
          await supabase.from('census_sync_runs').update({
            status,
            completed_at: new Date().toISOString(),
            inserted_or_updated_count: insertedOrUpdated,
            error_count: errors.length,
          }).eq('run_id', runId)

          jsonRes(res, 200, {
            run_id: runId,
            requested_count: 1,
            inserted_or_updated_count: insertedOrUpdated,
            error_count: errors.length,
            examples,
            errors: errors.slice(0, 10),
            status,
          })
        }
      } catch (err) {
        await supabase.from('census_sync_runs').update({ status: 'failed', completed_at: new Date().toISOString() }).eq('run_id', runId)
        jsonRes(res, 500, { error: err instanceof Error ? err.message : 'Census sync failed' })
      }
    })
  },
})

// ─── Buyer Activity Rollup Plugin ─────────────────────────────────────────────

const buyerActivityPlugin = (env: Record<string, string>): Plugin => ({
  name: 'nexus-buyer-activity-api',
  configureServer(server) {
    server.middlewares.use('/api/internal/buyer-activity/rollup', async (req, res) => {
      if (req.method !== 'POST') { jsonRes(res, 405, { error: 'Method not allowed' }); return }

      const supabaseUrl = env['VITE_SUPABASE_URL']
      const supabaseKey = env['VITE_SUPABASE_SERVICE_ROLE_KEY'] || env['VITE_SUPABASE_ANON_KEY']
      if (!supabaseUrl || !supabaseKey) { jsonRes(res, 500, { error: 'Supabase env vars missing' }); return }
      const supabase = createClient(supabaseUrl, supabaseKey)

      let body: unknown
      try { body = JSON.parse(await readBody(req) || '{}') } catch { jsonRes(res, 400, { error: 'Invalid JSON' }); return }

      const b = body as Record<string, unknown>
      const timeframeDays = typeof b['timeframe_days'] === 'number' ? b['timeframe_days'] : 180
      const geoLevels: string[] = Array.isArray(b['geo_levels']) ? (b['geo_levels'] as string[]) : ['zip']
      const apply = b['apply'] === true

      // Fetch recently sold properties within timeframe
      const cutoffDate = new Date(Date.now() - timeframeDays * 86400000).toISOString().split('T')[0]
      const { data: soldRows, error: fetchError } = await supabase
        .from('recently_sold_properties')
        .select('*')
        .gte('sale_date', cutoffDate)
        .limit(10000)

      if (fetchError) { jsonRes(res, 500, { error: `Failed to fetch recently_sold_properties: ${fetchError.message}` }); return }

      const rows = (soldRows ?? []) as Record<string, unknown>[]
      const scannedRows = rows.length

      type RollupAccum = {
        prices: number[]
        ppsfs: number[]
        sqfts: number[]
        buyerKeys: Set<string>
        corpCount: number
        cashCount: number
        lats: number[]
        lngs: number[]
        propTypes: Record<string, number>
        buyerTypes: Record<string, number>
        topBuyers: Record<string, { count: number; totalPrice: number }>
        units: number[]
        lastSaleDate: string
      }

      const groups = new Map<string, RollupAccum>()

      const getOrCreate = (key: string): RollupAccum => {
        if (!groups.has(key)) {
          groups.set(key, {
            prices: [], ppsfs: [], sqfts: [], buyerKeys: new Set(),
            corpCount: 0, cashCount: 0, lats: [], lngs: [],
            propTypes: {}, buyerTypes: {}, topBuyers: {}, units: [], lastSaleDate: '',
          })
        }
        return groups.get(key)!
      }

      const safeNum = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null }
      const safeStr = (v: unknown): string => String(v ?? '').trim()
      const domKey = (rec: Record<string, number>): string => Object.entries(rec).sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
      const median = (arr: number[]): number | null => {
        if (arr.length === 0) return null
        const sorted = [...arr].sort((a, b) => a - b)
        const mid = Math.floor(sorted.length / 2)
        return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
      }
      const clamp = (v: number, lo = 0, hi = 100): number => Math.max(lo, Math.min(hi, v))

      for (const row of rows) {
        const price = safeNum(row['sale_price'])
        const sqft = safeNum(row['building_square_feet'] ?? row['sqft'])
        const lat = safeNum(row['latitude'] ?? row['lat'])
        const lng = safeNum(row['longitude'] ?? row['lng'])
        const buyerKey = safeStr(row['buyer_key'] ?? row['buyer_name'] ?? `anon_${Math.random()}`)
        const buyerName = safeStr(row['buyer_name'] ?? 'Unknown')
        const buyerType = safeStr(row['buyer_type'] ?? row['category'] ?? 'unknown')
        const propType = safeStr(row['property_type'] ?? row['propertyType'] ?? 'unknown')
        const saleDate = safeStr(row['sale_date'])
        const isCorpBuyer = /llc|corp|inc|fund|trust|reit/i.test(buyerName)

        const applyToGroup = (acc: RollupAccum) => {
          if (price) acc.prices.push(price)
          if (sqft && price) acc.ppsfs.push(price / sqft)
          if (sqft) acc.sqfts.push(sqft)
          acc.buyerKeys.add(buyerKey)
          if (isCorpBuyer) acc.corpCount++
          if (lat) acc.lats.push(lat)
          if (lng) acc.lngs.push(lng)
          acc.propTypes[propType] = (acc.propTypes[propType] ?? 0) + 1
          acc.buyerTypes[buyerType] = (acc.buyerTypes[buyerType] ?? 0) + 1
          if (!acc.topBuyers[buyerKey]) acc.topBuyers[buyerKey] = { count: 0, totalPrice: 0 }
          acc.topBuyers[buyerKey].count++
          if (price) acc.topBuyers[buyerKey].totalPrice += price
          if (saleDate > acc.lastSaleDate) acc.lastSaleDate = saleDate
        }

        if (geoLevels.includes('zip')) {
          const zip = safeStr(row['property_address_zip'] ?? row['zip'])
          if (zip) applyToGroup(getOrCreate(`zip::${zip}`))
        }
        if (geoLevels.includes('county')) {
          const county = safeStr(row['county'] ?? row['property_county_name'] ?? row['property_address_county'])
          if (county) applyToGroup(getOrCreate(`county::${county}`))
        }
        if (geoLevels.includes('market')) {
          const market = safeStr(row['market'] ?? row['market_id'])
          if (market) applyToGroup(getOrCreate(`market::${market}`))
        }
      }

      const rollups: Record<string, unknown>[] = []
      for (const [compositeKey, acc] of groups) {
        const [geoLevel, geoKey] = compositeKey.split('::')
        const purchaseCount = acc.prices.length || acc.buyerKeys.size
        const buyerCount = acc.buyerKeys.size
        const avgPrice = acc.prices.length ? acc.prices.reduce((s, v) => s + v, 0) / acc.prices.length : null
        const medPrice = median(acc.prices)
        const avgPpsf = acc.ppsfs.length ? acc.ppsfs.reduce((s, v) => s + v, 0) / acc.ppsfs.length : null
        const medPpsf = median(acc.ppsfs)
        const avgSqft = acc.sqfts.length ? acc.sqfts.reduce((s, v) => s + v, 0) / acc.sqfts.length : null
        const centroidLat = acc.lats.length ? acc.lats.reduce((s, v) => s + v, 0) / acc.lats.length : null
        const centroidLng = acc.lngs.length ? acc.lngs.reduce((s, v) => s + v, 0) / acc.lngs.length : null
        const topBuyersArr = Object.entries(acc.topBuyers)
          .sort((a, b) => b[1].count - a[1].count)
          .slice(0, 5)
          .map(([key, v]) => ({ buyer_key: key, purchase_count: v.count, total_spend: v.totalPrice }))
        const priceBands = {
          under_100k: acc.prices.filter((p) => p < 100000).length,
          '100k_200k': acc.prices.filter((p) => p >= 100000 && p < 200000).length,
          '200k_400k': acc.prices.filter((p) => p >= 200000 && p < 400000).length,
          '400k_plus': acc.prices.filter((p) => p >= 400000).length,
        }

        const velocityScore = clamp(Math.round((purchaseCount / timeframeDays) * 30 * 10))
        const liquidityScore = clamp(Math.round((buyerCount / Math.max(purchaseCount, 1)) * 50 + Math.min(purchaseCount, 50)))
        const investorDemandScore = clamp(Math.round((acc.corpCount / Math.max(purchaseCount, 1)) * 100))
        const buyerHeatScore = clamp(Math.round((velocityScore * 0.4) + (liquidityScore * 0.3) + (investorDemandScore * 0.3)))
        const retailExitScore = clamp(Math.round(100 - investorDemandScore))

        rollups.push({
          geo_level: geoLevel,
          geo_key: geoKey,
          timeframe_days: timeframeDays,
          purchase_count: purchaseCount,
          buyer_count: buyerCount,
          corporate_buyer_count: acc.corpCount,
          cash_buyer_count: acc.cashCount,
          avg_purchase_price: avgPrice,
          median_purchase_price: medPrice,
          min_purchase_price: acc.prices.length ? Math.min(...acc.prices) : null,
          max_purchase_price: acc.prices.length ? Math.max(...acc.prices) : null,
          avg_ppsf: avgPpsf,
          median_ppsf: medPpsf,
          avg_sqft: avgSqft,
          avg_units: null,
          dominant_property_type: domKey(acc.propTypes),
          dominant_buyer_type: domKey(acc.buyerTypes),
          liquidity_score: liquidityScore,
          velocity_score: velocityScore,
          buyer_heat_score: buyerHeatScore,
          investor_demand_score: investorDemandScore,
          retail_exit_score: retailExitScore,
          centroid_lat: centroidLat,
          centroid_lng: centroidLng,
          top_buyers: topBuyersArr,
          price_bands: priceBands,
          raw_summary: { scanned: scannedRows, timeframe_days: timeframeDays, last_sale_date: acc.lastSaleDate },
          updated_at: new Date().toISOString(),
        })
      }

      let upserted = 0
      const upsertErrors: string[] = []
      if (apply && rollups.length > 0) {
        const { error: upsertError } = await supabase
          .from('buyer_activity_geo_rollups')
          .upsert(rollups, { onConflict: 'geo_level,geo_key,timeframe_days' })
        if (upsertError) upsertErrors.push(upsertError.message)
        else upserted = rollups.length
      }

      jsonRes(res, 200, {
        scanned_rows: scannedRows,
        rollups_generated: rollups.length,
        rollups_upserted: upserted,
        examples: rollups.slice(0, 3).map((r) => ({
          geo_level: r['geo_level'],
          geo_key: r['geo_key'],
          purchase_count: r['purchase_count'],
          buyer_heat_score: r['buyer_heat_score'],
        })),
        errors: upsertErrors,
      })
    })
  },
})

function resolveDevGitIdentity() {
  const repoRoot = path.resolve(process.cwd(), '../..')
  const read = (command: string) => {
    try {
      return String(execSync(command, { cwd: repoRoot, encoding: 'utf8' })).trim()
    } catch {
      return 'unknown'
    }
  }
  const commitSha = read('git rev-parse HEAD')
  const branch = read('git rev-parse --abbrev-ref HEAD')
  const worktreeId = crypto.createHash('sha256').update(repoRoot).digest('hex').slice(0, 12)
  return { commitSha, branch, worktreeId }
}

function resolveBackendProxyTarget(env: Record<string, string>, mode: string): string {
  const configured = (env.VITE_BACKEND_API_URL || '').trim()
  if (mode !== 'development') {
    return configured || 'http://localhost:3000'
  }
  // Local API dev server runs on 3000 by default. Port 3001 is often a stale
  // secondary instance with a corrupted .next cache that returns HTML 500s.
  if (!configured || /localhost:3001\b/.test(configured)) {
    return 'http://localhost:3000'
  }
  return configured
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const backendProxyTarget = resolveBackendProxyTarget(env, mode)
  const devIdentity = resolveDevGitIdentity()
  return {
    define: {
      'import.meta.env.VITE_COMMIT_SHA': JSON.stringify(process.env.VERCEL_GIT_COMMIT_SHA || 'local'),
      'import.meta.env.VITE_BUILD_TIME': JSON.stringify(new Date().toISOString()),
      'import.meta.env.VITE_VERCEL_PROJECT': JSON.stringify(process.env.VERCEL_PROJECT_NAME || 'rei-automation-dashboard'),
      'import.meta.env.VITE_DASHBOARD_GIT_SHA': JSON.stringify(devIdentity.commitSha),
      'import.meta.env.VITE_DASHBOARD_GIT_BRANCH': JSON.stringify(devIdentity.branch),
      'import.meta.env.VITE_DASHBOARD_WORKTREE_ID': JSON.stringify(devIdentity.worktreeId),
    },
    plugins: [react(), translateApiPlugin(), underwriteApiPlugin(env), censusSyncPlugin(env), buyerActivityPlugin(env)],
    server: {
      host: '0.0.0.0',
      port: 5173,
      strictPort: true,
      allowedHosts: true,
      proxy: {
        '/api/cockpit': {
          target: backendProxyTarget,
          changeOrigin: true,
          secure: false,
        },
        '/api/intel': {
          target: backendProxyTarget,
          changeOrigin: true,
          secure: false,
        },
        '/api/ops': {
          target: backendProxyTarget,
          changeOrigin: true,
          secure: false,
        },
        '/api/internal': {
          target: backendProxyTarget,
          changeOrigin: true,
          secure: false,
        },
        '/api/workflows': {
          target: backendProxyTarget,
          changeOrigin: true,
          secure: false,
        },
      }
    },
    resolve: {
      alias: {
        tslib: tslibShim,
        react: reactEntry,
        'react-dom': reactDomEntry,
        'react/jsx-runtime': path.resolve(reactEntry, 'jsx-runtime.js'),
        'react/jsx-dev-runtime': path.resolve(reactEntry, 'jsx-dev-runtime.js'),
      },
      dedupe: ['react', 'react-dom', 'framer-motion'],
    },
  }
})
