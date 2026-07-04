import { getSupabaseClient } from '../supabaseClient'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { InboxThread } from '../../domain/inbox/inbox-model-types'

type RoutingInput = Pick<InboxThread, 'marketId' | 'market' | 'ourNumber' | 'phoneNumber' | 'textgridNumberId' | 'property_address_state' | 'propertyId' | 'threadKey'> & { allow_cluster_routing?: boolean }

interface TextgridNumberRow {
  id?: string | null
  phone_number?: string | null
  market?: string | null
  state?: string | null
  friendly_name?: string | null
  metadata?: Record<string, unknown> | null
  messages_sent_today?: number | null
  status?: string | null
}

interface RoutingResult {
  ok: boolean
  from_phone_number: string | null
  textgrid_number_id: string | null
  market_id: string | null
  routing_tier?: number
  routing_reason?: string
  routing_cluster?: string
  error?: string
  route_input_state?: string | null
  route_input_market?: string | null
  route_input_property_id?: string | null
  route_candidate_count?: number
  route_rejected_reasons?: string[]
}

export type ApprovedTextgridCluster = {
  cluster_key: string
  allowed_seller_states: string[]
  preferred_sender_markets: string[]
  fallback_sender_states: string[]
}

/** All US states + DC — every entry must appear in APPROVED_TEXTGRID_CLUSTERS. */
export const US_STATE_CODES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA',
  'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM',
  'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA',
  'WV', 'WI', 'WY',
] as const

/** Mirrors apps/api market-sending-zones STATE_CLUSTER_MAP for first-touch routing. */
export const APPROVED_TEXTGRID_CLUSTERS: ApprovedTextgridCluster[] = [
  {
    cluster_key: 'WEST_COAST',
    allowed_seller_states: ['CA', 'AZ', 'NV', 'NM', 'UT', 'CO', 'ID', 'WA', 'OR', 'MT', 'WY', 'AK', 'HI'],
    preferred_sender_markets: ['los angeles, ca', 'riverside, ca', 'stockton, ca', 'sacramento, ca'],
    fallback_sender_states: ['CA', 'AZ', 'NV'],
  },
  {
    cluster_key: 'TEXAS_OK',
    allowed_seller_states: ['TX', 'OK', 'AR'],
    preferred_sender_markets: ['dallas, tx', 'houston, tx', 'oklahoma city, ok', 'tulsa, ok'],
    fallback_sender_states: ['TX', 'OK'],
  },
  {
    cluster_key: 'SOUTHEAST_EAST',
    allowed_seller_states: ['GA', 'NC', 'SC', 'FL', 'TN', 'AL', 'LA', 'VA', 'MS', 'WV', 'DC', 'DE'],
    preferred_sender_markets: ['atlanta, ga', 'charlotte, nc', 'jacksonville, fl', 'miami, fl', 'tampa, fl', 'orlando, fl'],
    fallback_sender_states: ['GA', 'NC', 'FL'],
  },
  {
    cluster_key: 'NORTHEAST',
    allowed_seller_states: ['NY', 'NJ', 'CT', 'MA', 'RI', 'VT', 'NH', 'ME'],
    preferred_sender_markets: ['charlotte, nc', 'atlanta, ga'],
    fallback_sender_states: ['NC', 'GA', 'PA'],
  },
  {
    cluster_key: 'MIDWEST',
    allowed_seller_states: ['MN', 'WI', 'IA', 'ND', 'SD', 'MI', 'IL', 'IN', 'MO', 'KS', 'OH', 'KY', 'NE', 'PA', 'MD'],
    preferred_sender_markets: ['minneapolis, mn'],
    fallback_sender_states: ['MN', 'IL', 'OH'],
  },
]

const STATE_NAME_TO_CODE: Record<string, string> = {
  alabama: 'al',
  alaska: 'ak',
  arizona: 'az',
  arkansas: 'ar',
  california: 'ca',
  colorado: 'co',
  connecticut: 'ct',
  delaware: 'de',
  'district of columbia': 'dc',
  florida: 'fl',
  georgia: 'ga',
  hawaii: 'hi',
  idaho: 'id',
  illinois: 'il',
  indiana: 'in',
  iowa: 'ia',
  kansas: 'ks',
  kentucky: 'ky',
  louisiana: 'la',
  maine: 'me',
  maryland: 'md',
  massachusetts: 'ma',
  michigan: 'mi',
  minnesota: 'mn',
  mississippi: 'ms',
  missouri: 'mo',
  montana: 'mt',
  nebraska: 'ne',
  nevada: 'nv',
  'new hampshire': 'nh',
  'new jersey': 'nj',
  'new mexico': 'nm',
  'new york': 'ny',
  'north carolina': 'nc',
  'north dakota': 'nd',
  ohio: 'oh',
  oklahoma: 'ok',
  oregon: 'or',
  pennsylvania: 'pa',
  'rhode island': 'ri',
  'south carolina': 'sc',
  'south dakota': 'sd',
  tennessee: 'tn',
  texas: 'tx',
  utah: 'ut',
  vermont: 'vt',
  virginia: 'va',
  washington: 'wa',
  'west virginia': 'wv',
  wisconsin: 'wi',
  wyoming: 'wy',
}

export const resolveApprovedClusterForState = (
  state: string | null | undefined,
): ApprovedTextgridCluster | null => {
  const normalized = normalizeState(state)
  if (!normalized) return null
  const code = normalized.toUpperCase()
  return APPROVED_TEXTGRID_CLUSTERS.find((cluster) => cluster.allowed_seller_states.includes(code)) ?? null
}

export const uncoveredUsStates = (): string[] => {
  const covered = new Set(APPROVED_TEXTGRID_CLUSTERS.flatMap((cluster) => cluster.allowed_seller_states))
  return US_STATE_CODES.filter((state) => !covered.has(state))
}

const normalizePhone = (phone: string | null | undefined): string | null => {
  if (!phone) return null
  const raw = String(phone).trim()
  if (!raw) return null
  const cleaned = raw.replace(/\D/g, '')
  if (cleaned.length === 10) return `+1${cleaned}`
  if (cleaned.length === 11 && cleaned.startsWith('1')) return `+${cleaned}`
  return raw.startsWith('+') ? raw : cleaned ? `+${cleaned}` : null
}

const normalizeToken = (value: string | null | undefined): string => {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
}

export const normalizeState = (value: string | null | undefined): string => {
  const token = normalizeToken(value)
  if (!token) return ''
  if (STATE_NAME_TO_CODE[token]) return STATE_NAME_TO_CODE[token]
  if (token.length === 2) return token.toLowerCase()
  return token
}

const buildPhoneVariants = (phone: string | null): string[] => {
  if (!phone) return []
  const cleaned = normalizePhone(phone)
  if (!cleaned) return []
  return Array.from(new Set([cleaned, cleaned.replace(/^\+1/, ''), cleaned.replace(/^\+/, '')].filter(Boolean)))
}

const resolveTextgridNumberId = async (
  fromPhone: string | null,
  supabase: SupabaseClient,
): Promise<{ textgridNumberId: string | null; from_phone_number: string | null }> => {
  if (!fromPhone) return { textgridNumberId: null, from_phone_number: null }

  const { data: tgRows } = await supabase
    .from('textgrid_numbers')
    .select('*')
    .in('phone_number', buildPhoneVariants(fromPhone))
    .eq('status', 'active')
    .limit(1)

  const row = Array.isArray(tgRows) ? (tgRows[0] as TextgridNumberRow | undefined) : undefined
  if (!row?.id) {
    return { textgridNumberId: null, from_phone_number: normalizePhone(fromPhone) }
  }

  return {
    textgridNumberId: row.id ?? null,
    from_phone_number: normalizePhone(row.phone_number) || normalizePhone(fromPhone),
  }
}

const extractMatchText = (row: TextgridNumberRow): string[] => {
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

const scoreCandidate = (row: TextgridNumberRow, inputMarket: string, inputState: string) => {
  const haystacks = extractMatchText(row)
  const reasons: string[] = []
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
  rows: TextgridNumberRow[],
  inputMarket: string,
  inputState: string,
): { row: TextgridNumberRow | null; reasons: string[]; candidateCount: number } => {
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

const chooseLeastUsedSender = (rows: TextgridNumberRow[]): TextgridNumberRow | null => {
  if (!rows.length) return null
  const sorted = [...rows].sort(
    (left, right) => Number(left.messages_sent_today ?? 0) - Number(right.messages_sent_today ?? 0),
  )
  return sorted[0] ?? null
}

const resolveClusterSender = (
  cluster: ApprovedTextgridCluster,
  activeRows: TextgridNumberRow[],
): TextgridNumberRow | null => {
  for (const prefMarket of cluster.preferred_sender_markets) {
    const prefMatch = chooseBestCandidate(activeRows, prefMarket, '')
    if (prefMatch.row?.id && prefMatch.reasons.some((reason) => reason.startsWith('market:'))) {
      return prefMatch.row
    }
  }

  for (const fbState of cluster.fallback_sender_states) {
    const fbMatch = chooseBestCandidate(activeRows, '', fbState)
    if (fbMatch.row?.id && fbMatch.reasons.some((reason) => reason.startsWith('state:'))) {
      return fbMatch.row
    }
  }

  return null
}

export const resolveOutboundTextgridNumber = async (
  thread: RoutingInput,
  _allowEnvFallback = false,
): Promise<RoutingResult> => {
  const supabase = getSupabaseClient()
  const routeInputMarket = normalizeToken(thread.market || thread.marketId || '')
  const routeInputState = normalizeState(thread.property_address_state)
  const routeInputPropertyId = thread.propertyId ?? null

  // 1. If we already have a textgridNumberId, validate it.
  if (thread.textgridNumberId) {
    const { data: tgRows } = await supabase
      .from('textgrid_numbers')
      .select('*')
      .eq('id', thread.textgridNumberId)
      .eq('status', 'active')
      .limit(1)

    const row = Array.isArray(tgRows) ? (tgRows[0] as TextgridNumberRow | undefined) : undefined
    if (row?.id) {
      return {
        ok: true,
        from_phone_number: normalizePhone(row.phone_number),
        textgrid_number_id: row.id ?? null,
        market_id: row.market ?? null,
        routing_tier: 0,
        routing_reason: 'Direct assignment',
        route_input_state: routeInputState || null,
        route_input_market: routeInputMarket || null,
        route_input_property_id: routeInputPropertyId,
        route_candidate_count: 1,
        route_rejected_reasons: [],
      }
    }
  }

  // 2. If we have a from_phone_number (ourNumber), resolve its ID.
  if (thread.ourNumber) {
    const { textgridNumberId, from_phone_number } = await resolveTextgridNumberId(thread.ourNumber, supabase)
    if (textgridNumberId && from_phone_number) {
      return {
        ok: true,
        from_phone_number,
        textgrid_number_id: textgridNumberId,
        market_id: null,
        routing_tier: 1,
        routing_reason: 'Resolved from existing number',
        route_input_state: routeInputState || null,
        route_input_market: routeInputMarket || null,
        route_input_property_id: routeInputPropertyId,
        route_candidate_count: 1,
        route_rejected_reasons: [],
      }
    }
  }

  const { data: tgRows } = await supabase
    .from('textgrid_numbers')
    .select('*')
    .eq('status', 'active')
    .lt('messages_sent_today', 150)
    .order('messages_sent_today', { ascending: true })
    .limit(250)

  const activeRows = (Array.isArray(tgRows) ? tgRows : [])
    .map((row) => row as TextgridNumberRow)
    .filter((row) => row.id && normalizePhone(row.phone_number))

  const match = chooseBestCandidate(activeRows, routeInputMarket, routeInputState)
  if (match.row?.id) {
    const isTier1 = match.reasons.some((reason) => reason.startsWith('market:'))
    return {
      ok: true,
      from_phone_number: normalizePhone(match.row.phone_number),
      textgrid_number_id: match.row.id ?? null,
      market_id: match.row.market ?? null,
      routing_tier: isTier1 ? 1 : 2,
      routing_reason: match.reasons.join(', ') || 'Market/state match',
      route_input_state: routeInputState || null,
      route_input_market: routeInputMarket || null,
      route_input_property_id: routeInputPropertyId,
      route_candidate_count: match.candidateCount,
      route_rejected_reasons: [],
    }
  }

  // Tier 3: Approved cluster fallback
  const allowCluster = thread.allow_cluster_routing !== false
  if (allowCluster && routeInputState) {
    const cluster = resolveApprovedClusterForState(routeInputState)

    if (cluster) {
      const clusterMatchRow = resolveClusterSender(cluster, activeRows)

      if (clusterMatchRow?.id) {
        return {
          ok: true,
          from_phone_number: normalizePhone(clusterMatchRow.phone_number),
          textgrid_number_id: clusterMatchRow.id ?? null,
          market_id: clusterMatchRow.market ?? null,
          routing_tier: 3,
          routing_reason: `approved_cluster:${cluster.cluster_key}`,
          routing_cluster: cluster.cluster_key,
          route_input_state: routeInputState || null,
          route_input_market: routeInputMarket || null,
          route_input_property_id: routeInputPropertyId,
          route_candidate_count: activeRows.length,
          route_rejected_reasons: [],
        }
      }
    }
  }

  // Tier 4: Nationwide fallback — least-used active sender
  if (allowCluster) {
    const fallbackRow = chooseLeastUsedSender(activeRows)
    if (fallbackRow?.id) {
      return {
        ok: true,
        from_phone_number: normalizePhone(fallbackRow.phone_number),
        textgrid_number_id: fallbackRow.id ?? null,
        market_id: fallbackRow.market ?? null,
        routing_tier: 4,
        routing_reason: routeInputState
          ? 'nationwide_fallback'
          : 'nationwide_fallback_missing_state',
        route_input_state: routeInputState || null,
        route_input_market: routeInputMarket || null,
        route_input_property_id: routeInputPropertyId,
        route_candidate_count: activeRows.length,
        route_rejected_reasons: match.reasons,
      }
    }
  }

  // Tier 5: Block (No valid sender)
  return {
    ok: false,
    from_phone_number: null,
    textgrid_number_id: null,
    market_id: null,
    error: 'NO_VALID_LOCAL_TEXTGRID_NUMBER',
    route_input_state: routeInputState || null,
    route_input_market: routeInputMarket || null,
    route_input_property_id: routeInputPropertyId,
    route_candidate_count: activeRows.length,
    route_rejected_reasons: match.reasons,
  }
}