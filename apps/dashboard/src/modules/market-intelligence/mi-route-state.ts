/**
 * Market Intelligence view state lives in the pane's path, so a pane, a
 * reload, Back and a pasted link all restore exactly what was on screen.
 *
 *   /market-intelligence?geo=zip:55411&tab=rankings&period=1y&asset=all
 *     &rl=zip&rm=investor_purchase_count&rd=desc&rmin=0     rankings
 *     &cmp=market:dallas-tx,market:houston-tx  &cq=Dallas|Houston   compare (ids, or names to resolve)
 *     &sl=zip&sw=state:TX&sm=all&sf=<json filters>          screener
 *     &hm=investor_purchase_count                           map heat metric
 *     &q=<text>                                             a search to run on open (deck)
 */
export const MI_ROUTE = '/market-intelligence'
export const MI_TABS = ['overview', 'rankings', 'map', 'trends', 'investors', 'multifamily', 'demographics', 'compare', 'screener'] as const
export type MiTab = (typeof MI_TABS)[number]

export interface MiRouteState {
  geo: string
  tab: MiTab
  period: string
  asset: string
  rl: string | null
  rm: string
  rd: 'asc' | 'desc'
  rmin: number
  cmp: string[]
  cq: string[]
  sl: string
  sw: string | null
  sm: 'all' | 'any'
  sf: Array<{ metric: string; op: 'gte' | 'lte' | 'gt' | 'lt'; value: number }>
  hm: string
  q: string | null
}

export const DEFAULT_STATE: MiRouteState = {
  geo: 'nation:US', tab: 'overview', period: '1y', asset: 'all', rl: null, rm: 'investor_purchase_share', rd: 'desc', rmin: 0,
  cmp: [], cq: [], sl: 'zip', sw: null, sm: 'all', sf: [], hm: 'investor_purchase_share', q: null,
}

const GEO_ID = /^(nation:US|state:[A-Z]{2}|zip:\d{5}|market:[a-z0-9-]+|(county|city):[A-Z]{2}:.+)$/
const OPS = new Set(['gte', 'lte', 'gt', 'lt'])

export function parseMiLocation(location: string): MiRouteState {
  const q = new URLSearchParams(location.includes('?') ? location.slice(location.indexOf('?') + 1) : '')
  const geo = q.get('geo') || ''
  const tab = (MI_TABS as readonly string[]).includes(q.get('tab') || '') ? (q.get('tab') as MiTab) : DEFAULT_STATE.tab
  let sf: MiRouteState['sf'] = []
  try {
    const raw = JSON.parse(q.get('sf') || '[]')
    if (Array.isArray(raw)) sf = raw.filter((f) => f && typeof f.metric === 'string' && OPS.has(f.op) && Number.isFinite(Number(f.value))).slice(0, 12).map((f) => ({ metric: f.metric, op: f.op, value: Number(f.value) }))
  } catch { sf = [] }
  const ids = (k: string) => (q.get(k) || '').split(',').map((s) => s.trim()).filter((s) => GEO_ID.test(s))
  return {
    geo: GEO_ID.test(geo) ? geo : DEFAULT_STATE.geo,
    tab,
    period: q.get('period') || DEFAULT_STATE.period,
    asset: q.get('asset') || DEFAULT_STATE.asset,
    rl: q.get('rl'),
    rm: q.get('rm') || DEFAULT_STATE.rm,
    rd: q.get('rd') === 'asc' ? 'asc' : 'desc',
    rmin: Math.max(0, Number(q.get('rmin')) || 0),
    cmp: [...new Set(ids('cmp'))].slice(0, 6),
    cq: (q.get('cq') || '').split('|').map((s) => s.trim()).filter(Boolean).slice(0, 6),
    sl: q.get('sl') || DEFAULT_STATE.sl,
    sw: GEO_ID.test(q.get('sw') || '') ? q.get('sw') : null,
    sm: q.get('sm') === 'any' ? 'any' : 'all',
    sf,
    hm: q.get('hm') || DEFAULT_STATE.hm,
    q: q.get('q'),
  }
}

/** Serialise, omitting defaults so links stay short. */
export function miPath(s: Partial<MiRouteState>): string {
  const full = { ...DEFAULT_STATE, ...s }
  const q = new URLSearchParams()
  const put = (k: string, v: string | null | undefined, d?: string | null) => { if (v !== null && v !== undefined && v !== '' && v !== d) q.set(k, v) }
  put('geo', full.geo, DEFAULT_STATE.geo)
  put('tab', full.tab, DEFAULT_STATE.tab)
  put('period', full.period, DEFAULT_STATE.period)
  put('asset', full.asset, DEFAULT_STATE.asset)
  put('rl', full.rl)
  put('rm', full.rm, DEFAULT_STATE.rm)
  put('rd', full.rd, 'desc')
  put('rmin', full.rmin ? String(full.rmin) : null)
  put('cmp', full.cmp.join(','))
  put('cq', full.cq.join('|'))
  put('sl', full.sl, DEFAULT_STATE.sl)
  put('sw', full.sw)
  put('sm', full.sm, 'all')
  put('sf', full.sf.length ? JSON.stringify(full.sf) : null)
  put('hm', full.hm, DEFAULT_STATE.hm)
  put('q', full.q)
  const t = q.toString()
  return t ? `${MI_ROUTE}?${t}` : MI_ROUTE
}

/** The level a geography's rankings default to. */
export const childLevelOf = (level: string): string | null =>
  ({ nation: 'state', state: 'zip', market: 'zip', county: 'zip', city: 'zip', zip: null } as Record<string, string | null>)[level] ?? null

export const levelOfId = (id: string) => id.split(':')[0]
