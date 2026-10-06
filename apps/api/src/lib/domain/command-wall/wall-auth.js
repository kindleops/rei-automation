/**
 * COMMAND WALL — pairing, display credentials, revocation, rotation, heartbeat.
 *
 * Pairing (§6, §61):
 *   1. The TV calls start → gets a short code (ABCD-2345) + a pairing id and a
 *      poll secret that live only in that TV tab. No credential yet.
 *   2. A signed-in operator enters the code in Settings → Displays (a cockpit
 *      route, so it rides the Worker's session + allowlist gate). The pairing
 *      becomes `claimed` and a display row is created.
 *   3. The TV's next poll (pairing id + poll secret) CONSUMES the pairing
 *      (compare-and-set claimed → consumed) and receives the display token
 *      exactly once. A second poll gets nothing.
 *
 * The display token is NOT an operator session, a Supabase JWT, the dashboard
 * secret or a service key. It authenticates only /api/wall/* read routes plus
 * the heartbeat; middleware refuses it everywhere else.
 */
import { hashSecret, mintDisplayToken, mintId, mintPairingCode, mintSecret, normalizePairingCode, safeEqualHex, looksLikeDisplayToken } from './wall-crypto.js'
import { DEFAULT_DISPLAY_CONFIG, cleanDisplayName, patchToRow, resolveDisplayConfig, validateConfigPatch, validateViewCommand } from './wall-config.js'
import { WALL_LIMITS } from './wall-rate-limit.js'

export const PAIRING_TTL_MS = 10 * 60_000
export const PAIRING_POLL_INTERVAL_MS = 4_000
export const TOKEN_TTL_MS = 180 * 864e5
export const ROTATE_AFTER_MS = 30 * 864e5
export const PREVIOUS_TOKEN_GRACE_MS = 10 * 60_000
export const HEARTBEAT_WRITE_MIN_MS = 60_000
export const AUTH_CACHE_MS = 30_000
export const MAX_PENDING_PAIRINGS = 20
export const ONLINE_WITHIN_MS = 3 * 60_000

const iso = (ms) => new Date(ms).toISOString()
const clean = (v) => String(v ?? '').trim()

export class WallAuthError extends Error {
  constructor(status, code, extra = {}) {
    super(code)
    this.status = status
    this.code = code
    Object.assign(this, extra)
  }
}

function limit(limiter, key, rule) {
  if (!limiter) return
  const r = limiter.take(key, rule)
  if (!r.ok) throw new WallAuthError(429, 'rate_limited', { retryAfterMs: r.retryAfterMs })
}

/** Client hint stored for the operator's registry view; never a secret. */
export function cleanClientHint(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const n = (v, max) => { const x = Math.round(Number(v)); return Number.isFinite(x) && x > 0 && x <= max ? x : null }
  return {
    browser: clean(src.browser).replace(/[^\w .()/-]/g, '').slice(0, 40) || null,
    width: n(src.width, 16384),
    height: n(src.height, 16384),
    dpr: Number.isFinite(Number(src.dpr)) ? Math.min(8, Math.max(0.5, Math.round(Number(src.dpr) * 100) / 100)) : null,
    render_mode: ['full', 'lite', 'safe'].includes(src.render_mode) ? src.render_mode : null,
  }
}

// ── 1. TV starts a pairing ────────────────────────────────────────────────────
export async function startPairing(store, { clientKey, hint } = {}, { now = Date.now, limiter, env } = {}) {
  limit(limiter, `pair:start:${clientKey || 'anon'}`, WALL_LIMITS.pair_start_per_client)
  limit(limiter, 'pair:start:global', WALL_LIMITS.pair_start_global)
  const t = now()
  if ((await store.countPendingPairings(iso(t - PAIRING_TTL_MS))) >= MAX_PENDING_PAIRINGS) {
    throw new WallAuthError(429, 'too_many_pending_pairings', { retryAfterMs: 60_000 })
  }
  const code = mintPairingCode()
  const pollSecret = mintSecret()
  const row = {
    id: mintId('cwp'),
    code_hash: hashSecret(code, { purpose: 'pairing-code', env }),
    poll_hash: hashSecret(pollSecret, { purpose: 'pairing-poll', env }),
    status: 'pending',
    display_id: null,
    client_key: clientKey || null,
    client_hint: cleanClientHint(hint),
    claimed_by: null,
    claimed_at: null,
    consumed_at: null,
    expires_at: iso(t + PAIRING_TTL_MS),
    created_at: iso(t),
  }
  await store.createPairing(row)
  return { pairing_id: row.id, code, poll_secret: pollSecret, expires_at: row.expires_at, poll_interval_ms: PAIRING_POLL_INTERVAL_MS }
}

// ── 2. Operator claims the code ──────────────────────────────────────────────
export async function claimPairing(store, { code, operatorId, name, config, displayId = null } = {}, { now = Date.now, limiter, env } = {}) {
  if (!clean(operatorId)) throw new WallAuthError(401, 'operator_required')
  limit(limiter, `pair:claim:${operatorId}`, WALL_LIMITS.claim_per_operator)
  const normalized = normalizePairingCode(code)
  const failure = (status, codeName) => {
    limit(limiter, 'pair:claim:failures', WALL_LIMITS.claim_failures_global)
    return new WallAuthError(status, codeName)
  }
  if (!normalized) throw failure(400, 'bad_code')
  const pairing = await store.findPairingByCodeHash(hashSecret(normalized, { purpose: 'pairing-code', env }))
  const t = now()
  if (!pairing) throw failure(404, 'code_not_found')
  if (pairing.status !== 'pending') throw failure(409, 'code_already_used')
  if (Date.parse(pairing.expires_at) <= t) throw failure(410, 'code_expired')

  const { patch } = validateConfigPatch(config || {})
  let display
  if (displayId) {
    const existing = await store.getDisplay(displayId)
    if (!existing) throw new WallAuthError(404, 'display_not_found')
    display = await store.updateDisplay(displayId, {
      ...patchToRow(patch, existing),
      status: 'awaiting_handoff', token_hash: null, prev_token_hash: null, prev_token_valid_until: null,
      paired_by: operatorId, paired_at: iso(t), revoked_at: null, revoked_by: null,
      config_version: (Number(existing.config_version) || 0) + 1,
    })
  } else {
    const row = patchToRow({ ...DEFAULT_DISPLAY_CONFIG, ...patch, name: cleanDisplayName(name) || patch.name || 'Command Wall' })
    display = await store.createDisplay({
      id: mintId('cwd'),
      name: row.name,
      status: 'awaiting_handoff',
      token_hash: null, prev_token_hash: null, prev_token_valid_until: null, token_issued_at: null, token_expires_at: null,
      paired_by: operatorId, paired_at: iso(t), last_seen_at: null, last_heartbeat: null, revoked_at: null, revoked_by: null,
      preset: row.preset, theme: row.theme, privacy_mode: row.privacy_mode, oled_protection: row.oled_protection,
      rotation_config: row.rotation_config, settings_json: row.settings_json, view_command: null, config_version: 1,
      created_at: iso(t), updated_at: iso(t),
    })
  }
  const claimed = await store.transitionPairing(pairing.id, 'pending', { status: 'claimed', display_id: display.id, claimed_by: operatorId, claimed_at: iso(t) })
  if (!claimed) {
    // lost a race for the same code: never leave a half-created display behind
    if (!displayId) await store.updateDisplay(display.id, { status: 'revoked', revoked_at: iso(t), revoked_by: 'system:claim_race' })
    throw new WallAuthError(409, 'code_already_used')
  }
  await store.appendAudit({ display_id: display.id, action: displayId ? 'repaired' : 'paired', actor: operatorId, detail: { pairing_id: pairing.id, client: pairing.client_hint || null } })
  return { display: publicDisplay(display, t) }
}

// ── 3. TV polls; the claimed pairing is consumed exactly once ────────────────
export async function pollPairing(store, { pairingId, pollSecret } = {}, { now = Date.now, limiter, env } = {}) {
  const id = clean(pairingId)
  if (!id || !clean(pollSecret)) throw new WallAuthError(400, 'bad_poll')
  limit(limiter, `pair:poll:${id}`, WALL_LIMITS.pair_poll_per_pairing)
  const pairing = await store.getPairing(id)
  if (!pairing || !safeEqualHex(pairing.poll_hash, hashSecret(clean(pollSecret), { purpose: 'pairing-poll', env }))) {
    throw new WallAuthError(404, 'pairing_not_found')
  }
  const t = now()
  if (pairing.status === 'consumed') throw new WallAuthError(410, 'pairing_consumed')
  if (pairing.status === 'pending') {
    if (Date.parse(pairing.expires_at) <= t) {
      await store.transitionPairing(id, 'pending', { status: 'expired' })
      throw new WallAuthError(410, 'pairing_expired')
    }
    return { paired: false, expires_at: pairing.expires_at, poll_interval_ms: PAIRING_POLL_INTERVAL_MS }
  }
  if (pairing.status !== 'claimed') throw new WallAuthError(410, 'pairing_expired')
  // A claim must be picked up promptly too: an unattended claimed code is not a standing offer.
  if (Date.parse(pairing.expires_at) + PAIRING_TTL_MS <= t) {
    await store.transitionPairing(id, 'claimed', { status: 'expired' })
    throw new WallAuthError(410, 'pairing_expired')
  }
  const consumed = await store.transitionPairing(id, 'claimed', { status: 'consumed', consumed_at: iso(t) })
  if (!consumed) throw new WallAuthError(410, 'pairing_consumed')
  const token = mintDisplayToken()
  const display = await store.updateDisplay(pairing.display_id, {
    status: 'active',
    token_hash: hashSecret(token, { env }),
    prev_token_hash: null,
    prev_token_valid_until: null,
    token_issued_at: iso(t),
    token_expires_at: iso(t + TOKEN_TTL_MS),
    last_seen_at: iso(t),
  })
  if (!display) throw new WallAuthError(410, 'display_missing')
  await store.appendAudit({ display_id: display.id, action: 'connected', actor: 'display', detail: { via: 'pairing' } })
  return { paired: true, token, token_expires_at: display.token_expires_at, display: displaySession(display) }
}

// ── Display authentication (every /api/wall read) ────────────────────────────
export function createDisplayAuthenticator(store, { now = Date.now, env, cacheMs = AUTH_CACHE_MS } = {}) {
  const cache = new Map()
  return {
    async authenticate(token) {
      if (!looksLikeDisplayToken(token)) throw new WallAuthError(401, 'display_unpaired')
      const hash = hashSecret(token, { env })
      const t = now()
      const hit = cache.get(hash)
      let found = hit && hit.until > t ? hit.found : undefined
      if (found === undefined) {
        found = await store.findDisplayByTokenHash(hash)
        cache.set(hash, { found, until: t + cacheMs })
        if (cache.size > 200) cache.delete(cache.keys().next().value)
      }
      if (!found) throw new WallAuthError(401, 'display_unpaired')
      const { row, via } = found
      if (row.status === 'revoked' || row.revoked_at) throw new WallAuthError(401, 'display_revoked')
      if (row.status !== 'active') throw new WallAuthError(401, 'display_unpaired')
      if (via === 'current' && row.token_expires_at && Date.parse(row.token_expires_at) <= t) throw new WallAuthError(401, 'display_token_expired')
      if (via === 'previous' && !(row.prev_token_valid_until && Date.parse(row.prev_token_valid_until) > t)) throw new WallAuthError(401, 'display_token_rotated')
      return { display: row, tokenHash: hash, via }
    },
    /** Refreshes the cached row after this process wrote it (heartbeat, rotation). */
    remember(hash, row) {
      const hit = cache.get(hash)
      if (hit?.found && row) cache.set(hash, { found: { ...hit.found, row }, until: hit.until })
    },
    /** Revocation / rotation in this process takes effect at once (other processes: ≤ cacheMs). */
    forget() { cache.clear() },
  }
}

// ── Heartbeat (§29): throttled write, token rotation, view-command delivery ──
export async function recordHeartbeat(store, auth, payload = {}, { now = Date.now, env } = {}) {
  const t = now()
  const d = auth.display
  const hb = {
    build: clean(payload.build).slice(0, 40) || null,
    preset: clean(payload.preset).slice(0, 32) || null,
    mode: ['full', 'lite', 'safe'].includes(payload.render_mode) ? payload.render_mode : null,
    route: clean(payload.route).replace(/[^\w/-]/g, '').slice(0, 40) || null,
    connection: ['live', 'degraded', 'offline'].includes(payload.connection) ? payload.connection : null,
    ...cleanClientHint(payload.client),
    config_version_seen: Number.isFinite(Number(payload.config_version)) ? Number(payload.config_version) : null,
    uptime_s: Number.isFinite(Number(payload.uptime_s)) ? Math.max(0, Math.round(Number(payload.uptime_s))) : null,
    errors: Number.isFinite(Number(payload.errors)) ? Math.max(0, Math.round(Number(payload.errors))) : null,
    reconnects: Number.isFinite(Number(payload.reconnects)) ? Math.max(0, Math.round(Number(payload.reconnects))) : null,
  }
  const lastSeen = d.last_seen_at ? Date.parse(d.last_seen_at) : 0
  const prevBuild = d.last_heartbeat?.build || null
  let row = d
  let rotated = null
  const due = t - lastSeen >= HEARTBEAT_WRITE_MIN_MS || prevBuild !== hb.build
  const rotateDue = auth.via === 'current' && d.token_issued_at && t - Date.parse(d.token_issued_at) >= ROTATE_AFTER_MS
  if (rotateDue) {
    const token = mintDisplayToken()
    const next = await store.rotateDisplayToken(d.id, auth.tokenHash, {
      token_hash: hashSecret(token, { env }),
      prev_token_hash: auth.tokenHash,
      prev_token_valid_until: iso(t + PREVIOUS_TOKEN_GRACE_MS),
      token_issued_at: iso(t),
      token_expires_at: iso(t + TOKEN_TTL_MS),
      last_seen_at: iso(t),
      last_heartbeat: hb,
    })
    if (next) {
      row = next
      rotated = { token, token_expires_at: next.token_expires_at }
      await store.appendAudit({ display_id: d.id, action: 'token_rotated', actor: 'display', detail: {} })
    }
  } else if (due) {
    row = (await store.updateDisplay(d.id, { last_seen_at: iso(t), last_heartbeat: hb })) || d
  }
  if (prevBuild && hb.build && prevBuild !== hb.build) {
    await store.appendAudit({ display_id: d.id, action: 'version_changed', actor: 'display', detail: { from: prevBuild, to: hb.build } })
  }
  return { written: Boolean(due || rotated), rotated, row, session: displaySession(row, t) }
}

// ── Operator actions (cockpit routes only) ───────────────────────────────────
export async function updateDisplayConfig(store, id, input, { operatorId, now = Date.now } = {}) {
  const current = await store.getDisplay(id)
  if (!current) throw new WallAuthError(404, 'display_not_found')
  const { patch, rejected } = validateConfigPatch(input)
  if (!Object.keys(patch).length) throw new WallAuthError(400, 'empty_patch', { rejected })
  const row = await store.updateDisplay(id, { ...patchToRow(patch, current), config_version: (Number(current.config_version) || 0) + 1 })
  await store.appendAudit({ display_id: id, action: 'config_changed', actor: operatorId || 'operator', detail: { fields: Object.keys(patch) } })
  return { display: publicDisplay(row, now()), rejected }
}

export async function revokeDisplay(store, id, { operatorId, now = Date.now, authenticator } = {}) {
  const current = await store.getDisplay(id)
  if (!current) throw new WallAuthError(404, 'display_not_found')
  const t = now()
  const row = await store.updateDisplay(id, { status: 'revoked', token_hash: null, prev_token_hash: null, prev_token_valid_until: null, revoked_at: iso(t), revoked_by: operatorId || 'operator' })
  authenticator?.forget()
  await store.appendAudit({ display_id: id, action: 'revoked', actor: operatorId || 'operator', detail: {} })
  return { display: publicDisplay(row, t) }
}

/** "Regenerate pairing": the current credential dies now; the TV shows a fresh code. */
export async function requireRepair(store, id, { operatorId, now = Date.now, authenticator } = {}) {
  const current = await store.getDisplay(id)
  if (!current) throw new WallAuthError(404, 'display_not_found')
  const row = await store.updateDisplay(id, { status: 'pairing_required', token_hash: null, prev_token_hash: null, prev_token_valid_until: null })
  authenticator?.forget()
  await store.appendAudit({ display_id: id, action: 'pairing_regenerated', actor: operatorId || 'operator', detail: {} })
  return { display: publicDisplay(row, now()) }
}

export async function sendViewCommand(store, id, input, { operatorId, now = Date.now } = {}) {
  const current = await store.getDisplay(id)
  if (!current) throw new WallAuthError(404, 'display_not_found')
  const v = validateViewCommand(input)
  if (!v.ok) throw new WallAuthError(400, v.error)
  const t = now()
  const command = { ...v.command, id: mintId('cwv'), issued_at: iso(t), expires_at: iso(t + v.command.hold_minutes * 60_000) }
  const row = await store.updateDisplay(id, { view_command: command, config_version: (Number(current.config_version) || 0) + 1 })
  await store.appendAudit({ display_id: id, action: 'view_sent', actor: operatorId || 'operator', detail: { preset: command.preset, market: command.market, campaign_id: command.campaign_id } })
  return { display: publicDisplay(row, t) }
}

// ── Projections ──────────────────────────────────────────────────────────────
export function connectionState(row, t = Date.now()) {
  if (!row) return 'unknown'
  if (row.status === 'revoked') return 'revoked'
  if (row.status !== 'active') return row.status
  const seen = row.last_seen_at ? Date.parse(row.last_seen_at) : 0
  if (!seen || t - seen > ONLINE_WITHIN_MS) return 'offline'
  return row.last_heartbeat?.connection === 'degraded' || row.last_heartbeat?.connection === 'offline' ? 'degraded' : 'online'
}

/** What the TV itself learns about itself. No hashes, no operator identity. */
export function displaySession(row, t = Date.now()) {
  const cmd = row.view_command && Date.parse(row.view_command.expires_at) > t ? row.view_command : null
  return {
    id: row.id,
    name: row.name,
    config: resolveDisplayConfig(row),
    config_version: Number(row.config_version) || 0,
    view_command: cmd,
    token_expires_at: row.token_expires_at || null,
  }
}

/** The operator registry row (§7, §72). Never a hash. */
export function publicDisplay(row, t = Date.now()) {
  if (!row) return null
  const hb = row.last_heartbeat || {}
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    connection: connectionState(row, t),
    paired_at: row.paired_at || null,
    paired_by: row.paired_by || null,
    last_seen_at: row.last_seen_at || null,
    revoked_at: row.revoked_at || null,
    token_expires_at: row.token_expires_at || null,
    config: resolveDisplayConfig(row),
    config_version: Number(row.config_version) || 0,
    view_command: row.view_command && Date.parse(row.view_command.expires_at) > t ? row.view_command : null,
    client: { build: hb.build || null, browser: hb.browser || null, width: hb.width || null, height: hb.height || null, dpr: hb.dpr || null, render_mode: hb.mode || null, connection: hb.connection || null, uptime_s: hb.uptime_s ?? null, errors: hb.errors ?? null, reconnects: hb.reconnects ?? null },
  }
}
