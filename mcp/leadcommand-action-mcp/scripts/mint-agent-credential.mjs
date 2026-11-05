#!/usr/bin/env node
// MINT one agent credential (the OWNER runs this; nothing else does).
//
//   node --import ./src/loader/register.mjs scripts/mint-agent-credential.mjs --pepper-file ~/.leadcommand/action-pepper --agent-id agt_research_1 --out ~/.leadcommand/agt_research_1.credential
//
// --pepper-file  the 0600 file holding the Action MCP's credential pepper (≥ 32 bytes; the SAME file the server reads)
// --agent-id     agt_<lowercase, digits, _> (3–41 chars)
// --out          where the credential is written (0600). Refused inside this repository. Hand it to the agent's host.
//
// Prints ONLY the HMAC digest and the SQL an org OWNER runs (SQL editor / service_role) to register the principal
// and its standing grants; the credential itself is never printed. Rotation = mint again + update
// credential_digest and credential_rotated_at; revocation = status 'revoked'.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readCredentialFile } from '../../leadcommand-mcp/src/data/credential.mjs'
import { mintAgentCredential } from '@/lib/domain/action-gateway/credentials.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const inside = (p) => { const a = path.resolve(p); return a === REPO || a.startsWith(`${REPO}${path.sep}`) }

export function main(argv = process.argv.slice(2)) {
  const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null }
  const pepperFile = arg('--pepper-file')
  const agentId = String(arg('--agent-id') || '')
  const out = arg('--out')
  if (!pepperFile || !out || !/^agt_[a-z0-9][a-z0-9_]{2,40}$/.test(agentId)) throw new Error('usage: --pepper-file <0600 file> --agent-id agt_<name> --out <path outside the repo>')
  const resolve = (p) => path.resolve(p.replace(/^~(?=\/)/, process.env.HOME || '~'))
  if (inside(resolve(out))) throw new Error('--out must not be inside the repository')
  const pepper = readCredentialFile(resolve(pepperFile), '--pepper-file')
  const { token, digest } = mintAgentCredential(pepper)
  fs.writeFileSync(resolve(out), `${token}\n`, { mode: 0o600 })
  fs.chmodSync(resolve(out), 0o600)
  process.stdout.write(`${JSON.stringify({ minted: true, agent_id: agentId, out: resolve(out), credential_digest: digest })}\n`)
  process.stdout.write(`-- run as an org OWNER (replace <ORG>, <SPONSOR_OPERATOR>, <OWNER>):
insert into action_gateway.agent_principals (agent_id, org_id, display_name, sponsor_user_id, credential_digest, credential_expires_at, tier_ceiling, read_scopes, created_by)
values ('${agentId}', '<ORG>', '${agentId}', '<SPONSOR_OPERATOR>', '${digest}', now() + interval '30 days', 1, '{}', '<OWNER>');
-- one standing grant per capability × scope (bounded; see docs/ACTION-MCP.md §Standing grants), e.g.:
insert into action_gateway.capability_grants (org_id, agent_id, capability, max_tier, scope, envelope, max_uses_per_hour, max_uses_per_day, max_spend_usd_per_day, granted_by, expires_at)
values ('<ORG>', '${agentId}', 'tasks.create_operator_task', 1, '{}', '{}', 20, 100, 0, '<OWNER>', now() + interval '30 days');
`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main() } catch (e) { process.stderr.write(`mint-agent-credential: ${e.message}\n`); process.exitCode = 2 }
}
