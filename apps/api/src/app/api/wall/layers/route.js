/**
 * GET /api/wall/layers?kind=cameras|crime|presence&bbox=w,s,e,n&zoom=z
 *
 * Spatial-intelligence context for the wall, through the SAME services the
 * desktop map uses (camera network, crime, investor presence). The viewport is
 * snapped outward to a 0.1° grid and zoom to 0.5 steps and cached 10 minutes,
 * so a slowly drifting TV map re-uses one read for a long time and N displays
 * on one market share it. Display credential only; read-only.
 */
import { createReadCache } from '@/lib/domain/home/home-read-kit.js'
import { resolveDisplayConfig } from '@/lib/domain/command-wall/wall-config.js'
import { getCamerasInView } from '@/lib/domain/map/cameras/camera-network-service.js'
import { getCrimeInView } from '@/lib/domain/map/crime/crime-service.js'
import { getInvestorPresence } from '@/lib/domain/map/investor-presence-service.js'
import { wallJson, wallError, requireDisplay } from '@/lib/domain/command-wall/wall-http.js'
import { WallAuthError } from '@/lib/domain/command-wall/wall-auth.js'
import { snapViewport } from '@/lib/domain/command-wall/wall-viewport.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const cache = createReadCache({ ttlMs: 10 * 60_000, max: 60 })
export async function GET(request) {
  try {
    const auth = await requireDisplay(request)
    const config = resolveDisplayConfig(auth.display)
    const url = new URL(request.url)
    const kind = url.searchParams.get('kind')
    const vp = snapViewport(url.searchParams.get('bbox'), url.searchParams.get('zoom'))
    if (!vp) throw new WallAuthError(400, 'bad_viewport')
    if (kind === 'crime' && config.privacy_mode === 'public_safe') return wallJson({ ok: true, kind, hidden: 'privacy_mode' })
    const key = `${kind}|${vp.bbox}|${vp.zoom}`
    let result
    if (kind === 'cameras') result = await cache(key, () => getCamerasInView({ bbox: vp.bbox, zoom: vp.zoom }))
    else if (kind === 'crime') result = await cache(key, () => getCrimeInView({ bbox: vp.bbox, zoom: vp.zoom, days: 30 }))
    else if (kind === 'presence') result = await cache(key, () => getInvestorPresence({ bbox: vp.bbox, zoom: vp.zoom, months: 24 }))
    else throw new WallAuthError(400, 'bad_kind')
    return wallJson({ ...result, kind, viewport: vp }, result?.ok === false ? result.status || 400 : 200)
  } catch (error) {
    return wallError(error)
  }
}
