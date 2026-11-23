// POST /api/cockpit/queue/owner-release
//
// FOUNDER P0 2026-11-23 (round 2, blocking item 3): the ONE way to authorize a
// historical send_queue row (held, paused, failed, older than 24 h, written
// before a freeze/brake event, or one the seller has replied past).
//
// AUTHENTICATION. /api/cockpit/* reaches the container only through the
// Cloudflare Worker's browser gate (infra/cloudflare/worker/index.ts
// handleBrowserApi): it verifies the Supabase session, checks the user against
// OPS_ALLOWED_USER_IDS, strips any caller-sent x-ops-dashboard-secret, then
// attaches the real secret and stamps x-ops-user-id with the VERIFIED user id.
// This route requires that secret (ensureMutationAuth), requires the stamped
// user id, and re-checks it against OPS_ALLOWED_USER_IDS itself.
//
// THE ACTOR IS THE LOGGED-IN USER. Body fields `actor`, `actor_user_id` or
// anything else naming a person are ignored; the release is attributed to the
// session's user id and signed with the server secret (owner-release-signature.js).
//
// Body: { queue_item_id, release_ids: [queue_item_id], reason, confirm: 'OWNER_RELEASE', dry_run }

import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, parseJsonSafe, withCors, handleOptionsResponse } from '../../_shared.js'
import { runQueueAction } from '@/lib/cockpit/cockpit-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const clean = (value) => String(value ?? '').trim()

function allowedOperatorIds(env = process.env) {
  return new Set(clean(env.OPS_ALLOWED_USER_IDS).split(',').map(clean).filter(Boolean))
}

function refuse(request, status, reason, message) {
  return withCors(request, NextResponse.json({ ok: false, action: 'owner-release', reason, error: reason, message }, { status }))
}

export async function POST(request, { runAction = runQueueAction, env = process.env } = {}) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return withCors(request, auth.response)

  const operator = auth.operator
  // Only the Worker's header path carries a verified user id. A cookie session
  // or a missing x-ops-user-id has no person to attribute the release to.
  if (!operator || operator.authenticated !== true || !clean(operator.id) || clean(operator.via) !== 'header:x-ops-dashboard-secret') {
    return refuse(request, 403, 'owner_release_requires_logged_in_operator', 'Sign in to Cockpit to release a held message.')
  }
  // Defence in depth: the API re-checks the allowlist the Worker enforces.
  // Empty or unset allowlist authorizes nobody.
  if (!allowedOperatorIds(env).has(clean(operator.id))) {
    return refuse(request, 403, 'owner_release_operator_not_allowed', 'This account may not release held messages.')
  }

  const body = await parseJsonSafe(request)
  const payload = {
    queue_item_id: clean(body?.queue_item_id || body?.queue_id || body?.id),
    release_ids: Array.isArray(body?.release_ids) ? body.release_ids : [],
    reason: clean(body?.reason),
    confirm: clean(body?.confirm),
    dry_run: body?.dry_run,
    // NOTE: no actor field is forwarded. The service takes the actor from `operator`.
  }

  const result = await runAction({ action: 'owner-release', payload, operator, env })
  const status = result?.ok ? 200 : (result?.reason === 'queue_item_not_found' ? 404 : 409)
  return withCors(request, NextResponse.json(result, { status }))
}

export async function OPTIONS(request) {
  return handleOptionsResponse(request)
}
