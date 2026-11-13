// The live data client: supabase-js over PostgREST, through the guarded fetch, as lc_action_gateway.
//
//   gateway token  a JWT the OWNER mints with the project's JWT secret: { role: "lc_action_gateway",
//                  lc_org: <the served org>, iss, iat, exp }. PostgREST verifies it, SET ROLE lc_action_gateway,
//                  and exposes the lc_org claim to SQL (request.jwt.claims): every RLS policy of the gateway
//                  tables and every entry point reads it. Refused here, before any request: any other role
//                  claim (service_role, authenticated, anon, postgres …), no / past / > 366-day expiry,
//                  alg none, an lc_org claim that is not the configured served org.
import { createClient } from '@supabase/supabase-js'
import { decodeJwtUnverified, assertPublicApiKey } from '../../../leadcommand-mcp/src/data/credential.mjs'
import { createGuardedFetch } from './guarded-fetch.mjs'
import { GATEWAY_ROLE } from './inventory.mjs'

export const MAX_TOKEN_LIFETIME_DAYS = 366
const fail = (code, message) => Object.assign(new Error(message), { code })

export function assertGatewayJwt(token, { orgId, now = Date.now() } = {}) {
  const { header, payload } = decodeJwtUnverified(token)
  const alg = String(header.alg || '')
  if (!alg || alg.toLowerCase() === 'none') throw fail('TOKEN_UNSIGNED', 'the gateway token is unsigned (alg none)')
  if (payload.role !== GATEWAY_ROLE) throw fail('ROLE_REFUSED', `the gateway token's role claim must be ${GATEWAY_ROLE} (a ${payload.role === 'service_role' ? 'SERVICE-ROLE' : 'different-role'} token is refused)`)
  if (String(payload.lc_org || '').toLowerCase() !== String(orgId || '').toLowerCase()) throw fail('TENANT_MISMATCH', 'the gateway token\'s lc_org claim is not the served org')
  const exp = Number(payload.exp)
  if (!Number.isFinite(exp)) throw fail('TOKEN_NO_EXPIRY', 'the gateway token has no exp claim')
  const left = exp * 1000 - now
  if (left <= 0) throw fail('TOKEN_EXPIRED', 'the gateway token expired; mint a new one')
  if (left > MAX_TOKEN_LIFETIME_DAYS * 86_400_000) throw fail('TOKEN_LIFETIME', 'the gateway token lives too long; mint a shorter-lived one')
  return { role: payload.role, org: payload.lc_org, alg, exp, days_left: Math.floor(left / 86_400_000) }
}

/** @param {{ supabaseUrl: string, apiKey: string, gatewayJwt: string, orgId: string, baseFetch?: Function, onRefused?: Function }} o */
export function createGatewayClient({ supabaseUrl, apiKey, gatewayJwt, orgId, baseFetch = globalThis.fetch, onRefused = null }) {
  assertPublicApiKey(apiKey)
  const token = assertGatewayJwt(gatewayJwt, { orgId })
  const fetch = createGuardedFetch({ origin: supabaseUrl, apiKey, gatewayJwt, base: baseFetch, onRefused })
  const db = createClient(supabaseUrl, apiKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch, headers: { 'x-client-info': 'leadcommand-action-mcp' } }, db: { schema: 'public' } })
  return { db, token }
}
