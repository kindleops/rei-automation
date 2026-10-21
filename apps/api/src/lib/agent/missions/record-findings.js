// recordFindings — the one finding writer every research / operations runtime handler uses.
//
// Package A (hotfix/research-runtime): extracted VERBATIM from rc-8.5.21
// missions/research-mission-handler.js (71479867) so that property.research and
// conversation.review_digest do not import research-mission-handler.js, whose
// mission-capability-hook imports the capability plane (agent/capabilities/index.js →
// services.js → inbox/send-now-service.js → providers/textgrid.js). The research kinds must
// have NO import path to the send stack (tests/critical/research-runtime-no-send-path.test.mjs).
// Writes go only through ctx.recordFinding (agent.runtime_record_finding: agent.finding rows,
// lease-bound, payload_is_clean CHECKs).
import { RuntimeStop } from '../runtime/runtime-tick.js'

const safeCode = (v) => String(v || 'UNKNOWN').toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 60)

export async function recordFindings(ctx, findings) {
  let written = 0
  const refused = []
  for (const f of findings) {
    try {
      await ctx.recordFinding(f)
      written += 1
    } catch (err) {
      if (err instanceof RuntimeStop && err.reason !== 'finding_shape_invalid') throw err
      refused.push({ finding_type: f.finding_type, code: safeCode(err?.code || err?.reason || 'FINDING_REFUSED') })
    }
  }
  return { written, refused: refused.slice(0, 20) }
}
