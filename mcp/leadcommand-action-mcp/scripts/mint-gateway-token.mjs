#!/usr/bin/env node
// MINT the lc_action_gateway token (the OWNER runs this; nothing else does).
//
//   node scripts/mint-gateway-token.mjs --secret-file ~/.leadcommand/jwt-secret --org <served org uuid> --out ~/.leadcommand/lc_action_gateway.jwt [--days 30]
//
// The token carries ONLY { role: "lc_action_gateway", lc_org: <org>, iss: "supabase", iat, exp }. PostgREST verifies it
// and SET ROLE lc_action_gateway; every gateway RLS policy and entry point reads lc_org (the tenant). Its power is
// exactly the role's grants (PROPOSED_20261019160000_action_gateway.sql). Revoke at once without rotating the
// secret: `revoke lc_action_gateway from authenticator;`. Prints the role, org and expiry, never the secret or token.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { readCredentialFile } from '../../leadcommand-mcp/src/data/credential.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const inside = (p) => { const a = path.resolve(p); return a === REPO || a.startsWith(`${REPO}${path.sep}`) }
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
export const MAX_DAYS = 90

export function mintGatewayToken(secret, { org, days = 30, now = Date.now() } = {}) {
  if (!secret || secret.length < 32) throw new Error('the JWT secret must be at least 32 characters')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(org || ''))) throw new Error('--org must be the served org uuid')
  const d = Number(days)
  if (!Number.isInteger(d) || d < 1 || d > MAX_DAYS) throw new Error(`--days must be an integer 1–${MAX_DAYS}`)
  const iat = Math.floor(now / 1000)
  const head = b64url({ alg: 'HS256', typ: 'JWT' })
  const body = b64url({ role: 'lc_action_gateway', lc_org: String(org).toLowerCase(), iss: 'supabase', iat, exp: iat + d * 86_400 })
  return `${head}.${body}.${crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`
}

export function main(argv = process.argv.slice(2)) {
  const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null }
  const resolve = (p) => path.resolve(String(p).replace(/^~(?=\/)/, process.env.HOME || '~'))
  const secretFile = arg('--secret-file')
  const out = arg('--out')
  if (!secretFile || !out) throw new Error('usage: --secret-file <0600 file> --org <uuid> --out <path outside the repo> [--days 1-90]')
  if (inside(resolve(secretFile)) || inside(resolve(out))) throw new Error('the secret file and --out must be outside the repository')
  const token = mintGatewayToken(readCredentialFile(resolve(secretFile), '--secret-file'), { org: arg('--org'), days: arg('--days') ?? 30 })
  fs.writeFileSync(resolve(out), token, { mode: 0o600 })
  fs.chmodSync(resolve(out), 0o600)
  const exp = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).exp
  process.stdout.write(`${JSON.stringify({ minted: true, role: 'lc_action_gateway', org: arg('--org'), expires_at: new Date(exp * 1000).toISOString(), out: resolve(out) })}\n`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main() } catch (e) { process.stderr.write(`mint-gateway-token: ${e.message}\n`); process.exitCode = 2 }
}
