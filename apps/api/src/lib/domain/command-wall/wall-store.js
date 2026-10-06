/**
 * COMMAND WALL — display registry store.
 *
 * Two implementations behind one interface:
 *   - createSupabaseWallStore(db): the PROPOSED tables
 *       command_wall_displays / command_wall_pairings / command_wall_audit
 *     (supabase/migrations/PROPOSED_20261006150000_command_wall_displays.sql —
 *     NOT applied). Until they exist every call reports `unprovisioned`, and
 *     the routes answer 503 — the wall fails closed, never open.
 *   - createMemoryWallStore(): tests, and local development when
 *     COMMAND_WALL_STORE=memory (refused in production).
 *
 * Single-use is enforced by compare-and-set transitions (`status` guarded
 * updates), not by read-then-write, so two concurrent polls cannot both
 * consume one pairing.
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'

export class WallStoreUnprovisioned extends Error {
  constructor(detail) {
    super('command_wall_registry_unprovisioned')
    this.code = 'command_wall_registry_unprovisioned'
    this.detail = detail
  }
}

const isMissingTable = (e) => /does not exist|schema cache|could not find the table|42P01|PGRST205/i.test(`${e?.code || ''} ${e?.message || ''}`)

const DISPLAY_COLS = 'id, name, status, token_hash, prev_token_hash, prev_token_valid_until, token_issued_at, token_expires_at, paired_by, paired_at, last_seen_at, last_heartbeat, revoked_at, revoked_by, preset, theme, privacy_mode, oled_protection, rotation_config, settings_json, view_command, config_version, created_at, updated_at'
const PAIRING_COLS = 'id, code_hash, poll_hash, status, display_id, client_key, client_hint, claimed_by, claimed_at, consumed_at, expires_at, created_at'

export function createSupabaseWallStore(db = defaultSupabase) {
  const run = async (q) => {
    const { data, error } = await q
    if (error) {
      if (isMissingTable(error)) throw new WallStoreUnprovisioned(error.message)
      throw error
    }
    return data
  }
  const one = (rows) => (Array.isArray(rows) ? rows[0] ?? null : rows ?? null)
  return {
    kind: 'supabase',
    async createPairing(row) { return one(await run(db.from('command_wall_pairings').insert(row).select(PAIRING_COLS))) },
    async getPairing(id) { return one(await run(db.from('command_wall_pairings').select(PAIRING_COLS).eq('id', id).limit(1))) },
    async findPairingByCodeHash(codeHash) {
      return one(await run(db.from('command_wall_pairings').select(PAIRING_COLS).eq('code_hash', codeHash).order('created_at', { ascending: false }).limit(1)))
    },
    /** CAS: only moves a pairing whose status is `fromStatus`. Returns the updated row or null. */
    async transitionPairing(id, fromStatus, patch) {
      return one(await run(db.from('command_wall_pairings').update(patch).eq('id', id).eq('status', fromStatus).select(PAIRING_COLS)))
    },
    async countPendingPairings(sinceIso) {
      const { count, error } = await db.from('command_wall_pairings').select('id', { count: 'exact', head: true }).eq('status', 'pending').gte('created_at', sinceIso)
      if (error) { if (isMissingTable(error)) throw new WallStoreUnprovisioned(error.message); throw error }
      return count || 0
    },
    async createDisplay(row) { return one(await run(db.from('command_wall_displays').insert(row).select(DISPLAY_COLS))) },
    async getDisplay(id) { return one(await run(db.from('command_wall_displays').select(DISPLAY_COLS).eq('id', id).limit(1))) },
    async findDisplayByTokenHash(hash) {
      const cur = one(await run(db.from('command_wall_displays').select(DISPLAY_COLS).eq('token_hash', hash).limit(1)))
      if (cur) return { row: cur, via: 'current' }
      const prev = one(await run(db.from('command_wall_displays').select(DISPLAY_COLS).eq('prev_token_hash', hash).limit(1)))
      return prev ? { row: prev, via: 'previous' } : null
    },
    async listDisplays() { return (await run(db.from('command_wall_displays').select(DISPLAY_COLS).order('created_at', { ascending: true }).limit(100))) || [] },
    async updateDisplay(id, patch) { return one(await run(db.from('command_wall_displays').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).select(DISPLAY_COLS))) },
    /** CAS on the token: only rotates when the stored hash is still `expectedHash`. */
    async rotateDisplayToken(id, expectedHash, patch) {
      return one(await run(db.from('command_wall_displays').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).eq('token_hash', expectedHash).select(DISPLAY_COLS)))
    },
    async appendAudit(entry) {
      try {
        await run(db.from('command_wall_audit').insert(entry))
      } catch (error) {
        // The audit trail must never take a display down; it reports, it doesn't gate.
        if (error instanceof WallStoreUnprovisioned) throw error
      }
    },
    async listAudit(displayId, limit = 50) {
      return (await run(db.from('command_wall_audit').select('id, display_id, action, actor, detail, created_at').eq('display_id', displayId).order('created_at', { ascending: false }).limit(limit))) || []
    },
  }
}

export function createMemoryWallStore() {
  const pairings = new Map()
  const displays = new Map()
  const audit = []
  const copy = (v) => (v ? structuredClone(v) : null)
  return {
    kind: 'memory',
    _dump: () => ({ pairings: [...pairings.values()], displays: [...displays.values()], audit: [...audit] }),
    async createPairing(row) { pairings.set(row.id, { ...row }); return copy(row) },
    async getPairing(id) { return copy(pairings.get(id)) },
    async findPairingByCodeHash(codeHash) {
      const list = [...pairings.values()].filter((p) => p.code_hash === codeHash)
      list.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      return copy(list[0])
    },
    async transitionPairing(id, fromStatus, patch) {
      const p = pairings.get(id)
      if (!p || p.status !== fromStatus) return null
      Object.assign(p, patch)
      return copy(p)
    },
    async countPendingPairings(sinceIso) {
      return [...pairings.values()].filter((p) => p.status === 'pending' && p.created_at >= sinceIso).length
    },
    async createDisplay(row) { displays.set(row.id, { ...row }); return copy(row) },
    async getDisplay(id) { return copy(displays.get(id)) },
    async findDisplayByTokenHash(hash) {
      for (const d of displays.values()) if (d.token_hash && d.token_hash === hash) return { row: copy(d), via: 'current' }
      for (const d of displays.values()) if (d.prev_token_hash && d.prev_token_hash === hash) return { row: copy(d), via: 'previous' }
      return null
    },
    async listDisplays() { return [...displays.values()].map(copy) },
    async updateDisplay(id, patch) {
      const d = displays.get(id)
      if (!d) return null
      Object.assign(d, patch, { updated_at: new Date().toISOString() })
      return copy(d)
    },
    async rotateDisplayToken(id, expectedHash, patch) {
      const d = displays.get(id)
      if (!d || d.token_hash !== expectedHash) return null
      Object.assign(d, patch, { updated_at: new Date().toISOString() })
      return copy(d)
    },
    async appendAudit(entry) { audit.push({ id: audit.length + 1, created_at: new Date().toISOString(), ...entry }) },
    async listAudit(displayId, limit = 50) { return audit.filter((a) => a.display_id === displayId).slice(-limit).reverse() },
  }
}

// Next.js compiles each route handler into its own bundle, so module-level
// state is NOT shared between /api/wall/* routes. Process-wide singletons live
// on globalThis instead (one registry, one authenticator cache, one tick).
const G = (globalThis.__lcCommandWall ||= {})
/**
 * The process store. Memory is a development convenience only: production
 * always uses the database registry (and therefore fails closed until the
 * proposed migration is applied).
 */
export function wallStore(env = process.env) {
  if (G.store) return G.store
  const wantsMemory = String(env.COMMAND_WALL_STORE || '').toLowerCase() === 'memory'
  const production = env.NODE_ENV === 'production' || env.VERCEL_ENV === 'production'
  G.store = wantsMemory && !production ? createMemoryWallStore() : createSupabaseWallStore()
  return G.store
}

export function _setWallStoreForTests(store) { G.store = store }
