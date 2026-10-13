// Registration hook between the ask service (research/ask-service.js) and the
// capability plane. The ask service stays read-only unless a hook is injected;
// the hook is created only when the plane is enabled.
//
//   hook.toolDefs()                         model-facing defs (cap__<domain>__<verb>)
//   hook.owns(apiName)                      true for cap__* names
//   hook.run({ apiName, input, run })       → { content, is_error, rows }
//
// The ctx the invoker sees is built HERE from the ask run's verified identity —
// never from the model's tool input. Each ask run gets one server-side session,
// so reading untrusted content (seller messages) taints the rest of that run.
import { DEFAULT_ORG_ID, fromApiName } from './index.js'
import { createSession } from './registry.js'

export function createCapabilityAskHook({ plane, org_id = DEFAULT_ORG_ID, maxResultChars = 12_000 }) {
  const sessions = new WeakMap()
  const sessionFor = (run) => {
    let s = sessions.get(run)
    if (!s) { s = createSession(); sessions.set(run, s) }
    return s
  }
  return Object.freeze({
    toolDefs: () => plane.toolDefs(),
    owns: (apiName) => fromApiName(apiName) !== null,
    async run({ apiName, input, run }) {
      const capability_id = fromApiName(apiName)
      const out = await plane.invoker.invoke({ capability_id, input, ctx: { org_id, identity: run.identity, source: 'model', session: sessionFor(run) } })
      let text = JSON.stringify(out.ok ? { status: out.status, trust: out.trust || 'system', result: out.result ?? null, approval_id: out.approval_id, expires_at: out.expires_at, note: out.status === 'approval_pending' ? 'A pending approval was created. Nothing was sent or changed; a human must approve it in the dashboard.' : undefined } : { error: out.code, status: out.status, detail: out.detail ?? null })
      if (text.length > maxResultChars) text = `${text.slice(0, maxResultChars)}…[truncated by server]`
      return { content: text, is_error: !out.ok, rows: Array.isArray(out.result?.rows) ? out.result.rows.length : 1 }
    },
  })
}
