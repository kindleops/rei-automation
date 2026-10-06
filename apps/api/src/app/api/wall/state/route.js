/**
 * GET /api/wall/state[?mi=1&markets=dallas-tx,houston-tx] — the shared snapshot,
 * projected through this display's privacy mode. Cached server-side for every
 * display (wall-snapshot-service), so N displays cost one build per 30 s.
 */
import { resolveDisplayConfig } from '@/lib/domain/command-wall/wall-config.js'
import { projectSnapshot } from '@/lib/domain/command-wall/wall-privacy.js'
import { wallSnapshot, deriveSystem } from '@/lib/domain/command-wall/wall-snapshot-service.js'
import { wallFeed } from '@/lib/domain/command-wall/wall-feed-service.js'
import { marketIntelService } from '@/lib/domain/market-intelligence/mi-service.js'
import { wallJson, wallError, requireDisplay } from '@/lib/domain/command-wall/wall-http.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MARKET = /^[a-z0-9][a-z0-9-]{1,62}$/

export async function GET(request) {
  try {
    const auth = await requireDisplay(request)
    const config = resolveDisplayConfig(auth.display)
    const url = new URL(request.url)
    const includeMi = url.searchParams.get('mi') === '1'
    const asked = String(url.searchParams.get('markets') || '').split(',').map((s) => s.trim()).filter((s) => MARKET.test(s)).slice(0, 4)
    const snapshot = wallSnapshot({ mi: marketIntelService })
    const feed = wallFeed()
    const core = await snapshot.read()
    // market geography for every live campaign market (cached 6 h in the feed's geo kit)
    const campaigns = []
    for (const c of core.campaigns?.items || []) {
      campaigns.push({ ...c, market_id: await feed.geo.marketIdForName(c.market_name).catch(() => null) })
    }
    // MI focus: what the wall asked for, else its watched markets, else where campaigns are live
    const liveMarkets = [...new Set(campaigns.filter((c) => c.status === 'active' && c.market_id).map((c) => c.market_id))]
    const miMarkets = asked.length ? asked : config.watched_markets.length ? config.watched_markets : liveMarkets
    const snap = includeMi ? await snapshot.read({ includeMi, miMarkets }) : core
    const ids = [...campaigns.map((c) => c.market_id).filter(Boolean), ...config.watched_markets]
    const markets = await feed.geo.marketsWithCentroids(ids).catch(() => [])
    const system = deriveSystem({ queue: snap.queue, fleet: snap.fleet, signals: snap.signals, feed: feed.statusNow() })
    const body = projectSnapshot({
      generated_at: snap.generated_at,
      metrics: snap.metrics,
      queue: snap.queue,
      fleet: snap.fleet,
      offers: snap.offers,
      system,
      campaigns,
      campaigns_status: snap.campaigns?.status || 'unavailable',
      signals: snap.signals?.items || [],
      signals_status: snap.signals?.status || 'unavailable',
      markets,
      mi: snap.mi || null,
    }, config.privacy_mode)
    return wallJson({ ok: true, ...body })
  } catch (error) {
    return wallError(error)
  }
}
