#!/usr/bin/env node
// MINT the lc_mcp_reader token (the owner runs this; nothing else does).
//
//   node scripts/mint-reader-token.mjs --secret-file ~/.leadcommand/jwt-secret --out ~/.leadcommand/lc_mcp_reader.jwt [--days 30]
//
// --secret-file  a 0600 file holding the project's JWT secret: Supabase dashboard →
//                Project Settings → JWT Keys → Legacy JWT secret. The project issues HS256
//                tokens (infra/cloudflare/worker/index.ts#resolveUser). Write the file
//                yourself and delete it after minting. Refused when it is an env file, sits
//                inside this repository, or is readable by group / other.
// --out          where the token is written (0600). Refused inside this repository.
// --days         lifetime, 1–90 (default 30). Rotate by minting again. Revoke at once,
//                without rotating the secret: `revoke lc_mcp_reader from authenticator;`.
//
// The token carries ONLY { role: "lc_mcp_reader", iss: "supabase", iat, exp }. There is no
// sub, no user identity and no other claim. Its power is exactly the role's grants. It
// prints the role, the expiry and the output path, never the secret or the token.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { readCredentialFile, assertReaderJwt } from '../src/data/credential.mjs'
import { READER_ROLE } from '../src/data/inventory.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../../..')
export const MAX_DAYS = 90

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')

/** @returns {string} the token (HS256) */
export function mintReaderToken(secret, { days = 30, now = Date.now() } = {}) {
  if (!secret || secret.length < 32) throw new Error('the JWT secret must be at least 32 characters (the project secret is)')
  const d = Number(days)
  if (!Number.isInteger(d) || d < 1 || d > MAX_DAYS) throw new Error(`--days must be an integer 1–${MAX_DAYS}`)
  const iat = Math.floor(now / 1000)
  const head = b64url({ alg: 'HS256', typ: 'JWT' })
  const body = b64url({ role: READER_ROLE, iss: 'supabase', iat, exp: iat + d * 86_400 })
  const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}

const insideRepo = (p) => {
  const abs = path.resolve(p)
  return abs === REPO || abs.startsWith(`${REPO}${path.sep}`)
}

export function main(argv = process.argv.slice(2)) {
  const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null }
  const secretFile = arg('--secret-file')
  const out = arg('--out')
  if (!secretFile || !out) throw new Error('usage: --secret-file <0600 file> --out <path outside the repo> [--days 1-90]')
  const resolvedSecret = path.resolve(secretFile.replace(/^~(?=\/)/, process.env.HOME || '~'))
  const resolvedOut = path.resolve(out.replace(/^~(?=\/)/, process.env.HOME || '~'))
  if (insideRepo(resolvedSecret)) throw new Error('the JWT secret file must not be inside the repository')
  if (insideRepo(resolvedOut)) throw new Error('--out must not be inside the repository')
  const secret = readCredentialFile(resolvedSecret, '--secret-file')
  const token = mintReaderToken(secret, { days: arg('--days') ?? 30 })
  const info = assertReaderJwt(token)
  fs.writeFileSync(resolvedOut, token, { mode: 0o600 })
  fs.chmodSync(resolvedOut, 0o600)
  process.stdout.write(`${JSON.stringify({ minted: true, role: info.role, alg: info.alg, expires_at: new Date(info.exp * 1000).toISOString(), out: resolvedOut })}\n`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main() } catch (e) { process.stderr.write(`mint-reader-token: ${e.message}\n`); process.exitCode = 2 }
}
