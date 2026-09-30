/**
 * ONE PHYSICAL DEVICE, ONE ICON.
 *
 * Two providers can publish the same camera (a state DOT and a regional 511
 * re-publishing its feed). A pair is the same device when it sits within a few
 * metres on the same road and the directions don't disagree — never on distance
 * alone, because an interchange can carry several real cameras a few metres
 * apart, and two views of one pole that face different ways are two cameras.
 *
 * The primary is the official owner first (registry priority), then a camera
 * that is actually serving, then the freshest feed, then the richer feed
 * (video over still), then a stable tiebreak. The other rows are kept with
 * `duplicate_of` set — lineage and a fallback source, not deleted.
 */
import { canonicalRoad } from './camera-model.js'

const FEED_RANK = { HLS: 3, VIDEO_STREAM: 3, MJPEG: 2, REFRESHING_STILL: 1, STILL_IMAGE: 1, PROVIDER_PAGE_ONLY: 0, UNAVAILABLE: -1 }
const tokens = (s) => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((t) => t.length > 1))
function jaccard(a, b) {
  const A = tokens(a); const B = tokens(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const t of A) if (B.has(t)) inter += 1
  return inter / (A.size + B.size - inter)
}
const dirsCompatible = (a, b) => !a || !b || a === b || a === 'BOTH' || b === 'BOTH'

/** Same device? `pair` carries both cameras' fields and their distance in metres. */
export function isSameDevice(a, b, distanceM) {
  if (!Number.isFinite(distanceM) || distanceM > 40) return false
  if (!dirsCompatible(a.direction, b.direction)) return false
  const ra = canonicalRoad(a.road)
  const rb = canonicalRoad(b.road)
  const sameRoad = ra && rb ? ra === rb : null
  if (sameRoad === false) return false
  if (distanceM <= 15) return true
  // 15–40 m: the road must match and the names must agree enough.
  return sameRoad === true && jaccard(a.name, b.name) >= 0.34
}

/** Which of two duplicates is shown. `priorityOf(provider_id)` — lower wins. */
export function pickPrimary(a, b, priorityOf = () => 100) {
  const pa = priorityOf(a.provider_id); const pb = priorityOf(b.provider_id)
  if (pa !== pb) return pa < pb ? a : b
  const la = a.status === 'LIVE' ? 1 : 0; const lb = b.status === 'LIVE' ? 1 : 0
  if (la !== lb) return la > lb ? a : b
  const ta = Date.parse(a.provider_updated_at || '') || 0; const tb = Date.parse(b.provider_updated_at || '') || 0
  if (Math.abs(ta - tb) > 60_000) return ta > tb ? a : b
  const fa = FEED_RANK[a.feed_type] ?? -1; const fb = FEED_RANK[b.feed_type] ?? -1
  if (fa !== fb) return fa > fb ? a : b
  return String(a.camera_id) < String(b.camera_id) ? a : b
}

/**
 * Turn candidate pairs (from map_camera_duplicate_pairs) into duplicate_of
 * assignments. Groups are transitive (A≈B, B≈C → one device) and every group
 * has exactly one primary. Returns every camera seen, with duplicate_of null
 * for primaries — so a camera that stopped being a duplicate is released.
 */
export function resolveDuplicates(pairs, priorityOf = () => 100) {
  const parent = new Map()
  const cams = new Map()
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x) } return x }
  const add = (c) => { if (!cams.has(c.camera_id)) { cams.set(c.camera_id, c); parent.set(c.camera_id, c.camera_id) } }
  for (const p of pairs) {
    const a = { camera_id: p.camera_id, provider_id: p.provider_id, name: p.name, road: p.road, direction: p.direction, feed_type: p.feed_type, status: p.status, provider_updated_at: p.provider_updated_at }
    const b = { camera_id: p.other_camera_id, provider_id: p.other_provider_id, name: p.other_name, road: p.other_road, direction: p.other_direction, feed_type: p.other_feed_type, status: p.other_status, provider_updated_at: p.other_provider_updated_at }
    add(a); add(b)
    if (a.provider_id === b.provider_id) continue
    if (isSameDevice(a, b, Number(p.distance_m))) parent.set(find(a.camera_id), find(b.camera_id))
  }
  const groups = new Map()
  for (const id of cams.keys()) {
    const root = find(id)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(cams.get(id))
  }
  const out = []
  for (const members of groups.values()) {
    const primary = members.reduce((best, c) => pickPrimary(best, c, priorityOf))
    for (const c of members) out.push({ camera_id: c.camera_id, duplicate_of: c.camera_id === primary.camera_id ? null : primary.camera_id })
  }
  return out
}
