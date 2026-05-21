import { createClient } from '@supabase/supabase-js'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function loadEnv() {
  const envFiles = ['.env.local', '.env']
  const env = {}
  for (const file of envFiles) {
    const envPath = path.join(__dirname, '../../', file)
    if (!fs.existsSync(envPath)) continue
    const content = fs.readFileSync(envPath, 'utf-8')
    content.split('\n').forEach((line) => {
      const [key, ...valueParts] = line.split('=')
      if (!key || valueParts.length === 0) return
      env[key.trim()] = valueParts.join('=').trim().replace(/^"(.*)"$/, '$1')
    })
    break
  }
  return env
}

const env = loadEnv()
const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
const supabaseAnonKey = env.VITE_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  console.error('Missing Supabase credentials. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: false },
})

const text = (value) => String(value ?? '').trim()
const zeroish = (value) => {
  if (value === null || value === undefined) return true
  if (typeof value === 'number') return !Number.isFinite(value) || value === 0
  const raw = text(value)
  if (!raw) return true
  const numeric = Number(raw)
  return Number.isFinite(numeric) ? numeric === 0 : false
}

const hasDisplayName = (pin) => Boolean(
  text(pin.seller_display_name)
  || text(pin.owner_display_name)
  || text(pin.owner_name)
  || text(pin.entity_name)
  || text(pin.seller_name),
)

const hasAddress = (pin) => Boolean(
  text(pin.property_address_full)
  || text(pin.property_address)
  || [text(pin.property_address_city), text(pin.property_address_state), text(pin.property_address_zip)].filter(Boolean).join(' '),
)

const hasPhysical = (pin) => [pin.total_bedrooms, pin.total_baths, pin.building_square_feet, pin.year_built].some((value) => !zeroish(value))
const hasValue = (pin) => !zeroish(pin.estimated_value)

async function fetchAllPins() {
  const pageSize = 1000
  let from = 0
  const rows = []

  for (;;) {
    const { data, error } = await supabase
      .from('v_command_map_seller_pin_feed')
      .select([
        'property_id',
        'seller_state',
        'seller_display_name',
        'owner_display_name',
        'owner_name',
        'entity_name',
        'seller_name',
        'property_address',
        'property_address_full',
        'property_address_city',
        'property_address_state',
        'property_address_zip',
        'market',
        'filter_market',
        'estimated_value',
        'total_bedrooms',
        'total_baths',
        'building_square_feet',
        'year_built',
        'latitude',
        'longitude',
      ].join(','))
      .range(from, from + pageSize - 1)

    if (error) throw error
    if (!data || data.length === 0) break
    rows.push(...data)
    if (data.length < pageSize || from >= 10000) break
    from += pageSize
  }

  return rows
}

function summarize(pins) {
  const byMarket = new Map()
  let notContactedWithCoords = 0
  let missingSellerName = 0
  let missingAddress = 0
  let missingEstimatedValue = 0
  let missingPhysical = 0
  const incompleteSamples = []

  for (const pin of pins) {
    const market = text(pin.market) || text(pin.filter_market) || 'Market Unknown'
    const sellerState = text(pin.seller_state) || 'not_contacted'
    const coordsPresent = !zeroish(pin.latitude) && !zeroish(pin.longitude)
    const nameMissing = !hasDisplayName(pin)
    const addressMissing = !hasAddress(pin)
    const valueMissing = !hasValue(pin)
    const physicalMissing = !hasPhysical(pin)
    const isNotContacted = sellerState === 'not_contacted'

    if (!byMarket.has(market)) {
      byMarket.set(market, {
        totalPins: 0,
        notContactedPins: 0,
        notContactedWithCoords: 0,
        missingSellerName: 0,
        missingAddress: 0,
        missingEstimatedValue: 0,
        missingBedsBathsSqft: 0,
      })
    }

    const bucket = byMarket.get(market)
    bucket.totalPins += 1

    if (isNotContacted) {
      bucket.notContactedPins += 1
      if (coordsPresent) {
        bucket.notContactedWithCoords += 1
        notContactedWithCoords += 1
      }
      if (nameMissing) {
        bucket.missingSellerName += 1
        missingSellerName += 1
      }
      if (addressMissing) {
        bucket.missingAddress += 1
        missingAddress += 1
      }
      if (valueMissing) {
        bucket.missingEstimatedValue += 1
        missingEstimatedValue += 1
      }
      if (physicalMissing) {
        bucket.missingBedsBathsSqft += 1
        missingPhysical += 1
      }
      if (incompleteSamples.length < 8 && (nameMissing || addressMissing || valueMissing || physicalMissing)) {
        incompleteSamples.push({
          property_id: pin.property_id,
          market,
          seller_state: sellerState,
          seller_display_name: pin.seller_display_name ?? pin.owner_display_name ?? pin.owner_name ?? pin.entity_name ?? pin.seller_name ?? null,
          property_address_full: pin.property_address_full ?? pin.property_address ?? null,
          estimated_value: pin.estimated_value ?? null,
          total_bedrooms: pin.total_bedrooms ?? null,
          total_baths: pin.total_baths ?? null,
          building_square_feet: pin.building_square_feet ?? null,
          year_built: pin.year_built ?? null,
        })
      }
    }
  }

  return {
    totalPins: pins.length,
    notContactedPins: pins.filter((pin) => (text(pin.seller_state) || 'not_contacted') === 'not_contacted').length,
    notContactedWithCoords,
    missingSellerName,
    missingAddress,
    missingEstimatedValue,
    missingBedsBathsSqft: missingPhysical,
    markets: Array.from(byMarket.entries())
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([market, stats]) => ({ market, ...stats })),
    sampleIncompletePins: incompleteSamples,
  }
}

async function main() {
  console.log('[CommandMapSellerPinsHydrationProof] starting')
  const pins = await fetchAllPins()
  const summary = summarize(pins)
  console.log(JSON.stringify(summary, null, 2))
}

main().catch((error) => {
  console.error('[CommandMapSellerPinsHydrationProof] failed', error?.message || error)
  process.exit(1)
})
