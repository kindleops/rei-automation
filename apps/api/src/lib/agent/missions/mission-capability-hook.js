// Capability tools for a HEADLESS mission's ask (same shape as capabilities/ask-hook.js).
//
// Offered: autonomous_internal capabilities (reads + internal drafts) and
// requires_explicit_approval capabilities (they only ever PREPARE a pending
// approval — a human decides in the dashboard). Never offered: within_approved_policy
// (a policy could execute without a human) and missions.* (a mission never spawns
// missions from model output). Every call goes through the ONE invoker, with the
// mission principal's identity built by server code (never from model input) and a
// per-run session (reading seller messages taints the run: writes are then refused).
import { DEFAULT_ORG_ID, fromApiName, toApiName } from '../capabilities/index.js'
import { createSession } from '../capabilities/registry.js'

export const MISSION_TOOL_TIERS = Object.freeze(['autonomous_internal', 'requires_explicit_approval'])
const NEVER_OFFERED = /^missions\./

export function missionOfferable(spec) {
  return Boolean(spec) && MISSION_TOOL_TIERS.includes(spec.tier) && !NEVER_OFFERED.test(spec.id)
}

export function createMissionCapabilityHook({ plane, org_id = DEFAULT_ORG_ID, maxResultChars = 12_000 }) {
  const offered = plane.registry.list().filter(missionOfferable)
  const ids = new Set(offered.map((c) => c.id))
  const sessions = new WeakMap()
  const ledger = { approvals: [], drafts: [], refused: {}, calls: 0 }
  const sessionFor = (run) => {
    let s = sessions.get(run)
    if (!s) { s = createSession(); sessions.set(run, s) }
    return s
  }
  return Object.freeze({
    ledger,
    offered: () => [...ids],
    toolDefs: () => offered.map((c) => ({
      name: toApiName(c.id),
      description: `${c.description} [${c.side_effect}; ${c.tier === 'requires_explicit_approval' ? 'creates a pending approval only — a human decides' : c.tier}]`,
      input_schema: c.input_schema,
    })).sort((a, b) => a.name.localeCompare(b.name)),
    owns: (apiName) => fromApiName(apiName) !== null,
    async run({ apiName, input, run }) {
      const capability_id = fromApiName(apiName)
      ledger.calls += 1
      if (!ids.has(capability_id)) {
        ledger.refused.CAPABILITY_NOT_OFFERED = (ledger.refused.CAPABILITY_NOT_OFFERED || 0) + 1
        return { content: JSON.stringify({ error: 'CAPABILITY_NOT_OFFERED', note: 'This capability is not available to a background mission.' }), is_error: true, rows: 0 }
      }
      const out = await plane.invoker.invoke({ capability_id, input, ctx: { org_id, identity: run.identity, source: 'model', session: sessionFor(run) } })
      if (out.ok && out.status === 'approval_pending' && out.approval_id) ledger.approvals.push({ approval_id: out.approval_id, capability_id, expires_at: out.expires_at || null, deduped: Boolean(out.deduped) })
      if (out.ok && capability_id === 'campaigns.create_draft' && out.result?.campaign_id) ledger.drafts.push({ campaign_id: out.result.campaign_id, status: out.result.status || 'draft' })
      if (!out.ok) ledger.refused[out.code || 'REFUSED'] = (ledger.refused[out.code || 'REFUSED'] || 0) + 1
      let text = JSON.stringify(out.ok ? { status: out.status, trust: out.trust || 'system', result: out.result ?? null, approval_id: out.approval_id, expires_at: out.expires_at, note: out.status === 'approval_pending' ? 'A pending approval was created. Nothing was sent or changed; a human must approve it in the dashboard.' : undefined } : { error: out.code, status: out.status, detail: out.detail ?? null })
      if (text.length > maxResultChars) text = `${text.slice(0, maxResultChars)}…[truncated by server]`
      return { content: text, is_error: !out.ok, rows: Array.isArray(out.result?.rows) ? out.result.rows.length : 1 }
    },
  })
}
