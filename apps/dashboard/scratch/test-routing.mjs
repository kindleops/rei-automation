import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'
dotenv.config()

const APPROVED_TEXTGRID_CLUSTERS = [
  {
    cluster_key: 'WEST_COAST',
    allowed_seller_states: ['CA', 'AZ', 'NV'],
    preferred_sender_markets: ['los angeles, ca'],
    fallback_sender_states: ['CA']
  },
  {
    cluster_key: 'TEXAS_OK',
    allowed_seller_states: ['TX', 'OK'],
    preferred_sender_markets: ['dallas, tx', 'houston, tx'],
    fallback_sender_states: ['TX']
  },
  {
    cluster_key: 'SOUTHEAST_EAST',
    allowed_seller_states: ['GA', 'NC', 'SC', 'FL'],
    preferred_sender_markets: ['atlanta, ga', 'charlotte, nc', 'jacksonville, fl', 'miami, fl'],
    fallback_sender_states: ['GA', 'NC', 'FL']
  },
  {
    cluster_key: 'MIDWEST',
    allowed_seller_states: ['MN', 'WI', 'IA', 'ND', 'SD'],
    preferred_sender_markets: ['minneapolis, mn'],
    fallback_sender_states: ['MN']
  }
]

const normalizePhone = (phone) => {
  if (!phone) return null
  const raw = String(phone).trim()
  if (!raw) return null
  const cleaned = raw.replace(/\D/g, '')
  if (cleaned.length === 10) return `+1${cleaned}`
  if (cleaned.length === 11 && cleaned.startsWith('1')) return `+${cleaned}`
  return raw.startsWith('+') ? raw : cleaned ? `+${cleaned}` : null
}

const normalizeToken = (value) => {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
}

const extractMatchText = (row) => {
  const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {}
  return [
    row.market,
    row.state,
    row.friendly_name,
    typeof metadata['state'] === 'string' ? metadata['state'] : null,
    typeof metadata['market'] === 'string' ? metadata['market'] : null,
    typeof metadata['friendly_name'] === 'string' ? metadata['friendly_name'] : null,
  ]
    .map((value) => normalizeToken(typeof value === 'string' ? value : ''))
    .filter(Boolean)
}

const scoreCandidate = (row, inputMarket, inputState) => {
  const haystacks = extractMatchText(row)
  const reasons = []
  let score = 0

  if (inputMarket) {
    const marketMatched = haystacks.some((value) => value === inputMarket || value.includes(inputMarket) || inputMarket.includes(value))
    if (marketMatched) {
      score = Math.max(score, 120)
      reasons.push(`market:${inputMarket}`)
    }
  }

  if (inputState) {
    const stateSynonyms = Array.from(new Set([inputState, inputState === 'nc' ? 'north carolina' : inputState]))
    const stateMatched = haystacks.some((value) => stateSynonyms.some((token) => value === token || value.includes(token)))
    if (stateMatched) {
      score = Math.max(score, 100)
      reasons.push(`state:${inputState}`)
    }
  }

  const usage = Number(row.messages_sent_today ?? 0)
  score -= Math.min(Math.max(usage, 0), 500) / 1000

  return { score, reasons }
}

const chooseBestCandidate = (
  rows,
  inputMarket,
  inputState,
) => {
  if (!rows.length) {
    return { row: null, reasons: ['no_active_textgrid_numbers'], candidateCount: 0 }
  }

  const scored = rows
    .map((row) => {
      const score = scoreCandidate(row, inputMarket, inputState)
      return { row, ...score }
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)

  if (!scored.length) {
    const reasons = []
    if (!inputMarket) reasons.push('missing_route_input_market')
    if (!inputState) reasons.push('missing_route_input_state')
    reasons.push('no_candidate_matched_market_or_state')
    return { row: null, reasons, candidateCount: rows.length }
  }

  return {
    row: scored[0]?.row ?? null,
    reasons: scored[0]?.reasons ?? [],
    candidateCount: rows.length,
  }
}

async function run() {
  const supabase = createClient(process.env.VITE_SUPABASE_URL || 'http://127.0.0.1:54321', process.env.VITE_SUPABASE_ANON_KEY || 'dummy')

  const { data: tgRows } = await supabase
    .from('textgrid_numbers')
    .select('*')
    .eq('status', 'active')
    .lt('messages_sent_today', 150)
    .order('messages_sent_today', { ascending: true })
    .limit(250)

  const activeRows = (Array.isArray(tgRows) ? tgRows : [])
    .map((row) => row)
    .filter((row) => row.id && normalizePhone(row.phone_number))

  const tests = [
    { market: 'phoenix, az', property_address_state: 'AZ' },
    { market: 'las vegas, nv', property_address_state: 'NV' },
    { market: 'tulsa, ok', property_address_state: 'OK' },
    { market: 'nashville, tn', property_address_state: 'TN' },
    { market: 'seattle, wa', property_address_state: 'WA' }
  ]

  for (const t of tests) {
    const routeInputState = t.property_address_state
    const routeInputMarket = normalizeToken(t.market)
    
    const match = chooseBestCandidate(activeRows, routeInputMarket, routeInputState)
    if (match.row?.id) {
      const isTier1 = match.reasons.some(r => r.startsWith('market:'))
      console.log(`${t.market} -> tier: ${isTier1 ? 1 : 2}, cluster: undefined, from: ${match.row.phone_number}, reason: ${match.reasons.join(', ')}`)
      continue
    }

    const rawState = routeInputState.toUpperCase()
    const cluster = APPROVED_TEXTGRID_CLUSTERS.find(c => c.allowed_seller_states.includes(rawState))
    
    if (cluster) {
      let clusterMatchRow = null
      for (const prefMarket of cluster.preferred_sender_markets) {
        const prefMatch = chooseBestCandidate(activeRows, prefMarket, '')
        if (prefMatch.row?.id && prefMatch.reasons.some(r => r.startsWith('market:'))) {
          clusterMatchRow = prefMatch.row
          break
        }
      }
      
      if (!clusterMatchRow) {
        for (const fbState of cluster.fallback_sender_states) {
          const fbMatch = chooseBestCandidate(activeRows, '', fbState)
          if (fbMatch.row?.id && fbMatch.reasons.some(r => r.startsWith('state:'))) {
            clusterMatchRow = fbMatch.row
            break
          }
        }
      }

      if (clusterMatchRow?.id) {
        console.log(`${t.market} -> tier: 3, cluster: ${cluster.cluster_key}, from: ${clusterMatchRow.phone_number}, reason: approved_cluster:${cluster.cluster_key}`)
        continue
      }
    }

    console.log(`${t.market} -> blocked`)
  }
}
run().catch(console.error)