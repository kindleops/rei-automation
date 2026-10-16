// Runtime handler `conversation.review_digest` — the morning briefing (schedule
// 'conversation-review-digest', born DISABLED). Deterministic, no model, $0.
//
// Summarizes REAL completed work in the window (default 24 h), each number read
// from its own source — never estimated:
//   missions        agent.research_job (runtime rows) by kind × state, + ledger cost
//   findings        agent.finding (job findings) by finding_type
//   shadow          public.conversation_ai_shadow_decisions by outcome (read-only;
//                   'unavailable' when the PROPOSED table is not applied — never 0)
//   approvals       agent.approval_request pending, not expired (count + capabilities)
// Writes one finding: digest.morning, key digest.<UTC date>.
import { RuntimePermanentError } from '../runtime/runtime-tick.js'
import { REVIEW_DIGEST_KIND, missionIdentity } from './mission-kinds.js'
import { recordFindings } from './research-mission-handler.js'
import { DEFAULT_ORG_ID } from '../capabilities/index.js'

/** Optional shadow source over the guarded GET-only read client: { summary({ since }) → { by_outcome, total } }. */
export function createShadowSupabaseSource({ db }) {
  return Object.freeze({
    async summary({ since, limit = 2000 }) {
      const { data, error } = await db.from('conversation_ai_shadow_decisions').select('outcome,validation_status,created_at').gte('created_at', since).order('created_at', { ascending: false }).limit(limit)
      if (error) return { available: false, code: String(error.code || '') === 'PGRST205' || String(error.code || '') === '42P01' ? 'SOURCE_NOT_APPLIED' : 'SOURCE_UNAVAILABLE' }
      const by = {}
      let validated = 0
      for (const r of data || []) { by[r.outcome] = (by[r.outcome] || 0) + 1; if (r.validation_status === 'validated_draft') validated += 1 }
      return { available: true, total: (data || []).length, capped: (data || []).length >= limit, by_outcome: by, validated_drafts: validated }
    },
  })
}

export function buildDigest({ activity, approvals, shadow, since, at }) {
  const byKind = {}
  let cost = 0
  for (const j of activity.jobs) {
    const k = (byKind[j.kind] ||= { total: 0, by_state: {}, cost_usd: 0 })
    k.total += 1
    k.by_state[j.state] = (k.by_state[j.state] || 0) + 1
    k.cost_usd = Math.round((k.cost_usd + Number(j.cost_usd || 0)) * 1e6) / 1e6
    cost += Number(j.cost_usd || 0)
  }
  const capCounts = {}
  for (const a of approvals) capCounts[a.capability_id] = (capCounts[a.capability_id] || 0) + 1
  return {
    window: { since, until: at },
    missions: { total: activity.jobs.length, completed: activity.jobs.filter((j) => j.state === 'completed').length, failed: activity.jobs.filter((j) => ['failed', 'dead_letter'].includes(j.state)).length, open: activity.jobs.filter((j) => !j.ended_at).length, by_kind: byKind, cost_usd: Math.round(cost * 1e6) / 1e6 },
    findings: { total: activity.findings.reduce((a, f) => a + f.n, 0), by_type: Object.fromEntries(activity.findings.map((f) => [f.finding_type, f.n])) },
    shadow_decisions: shadow ? (shadow.available ? { available: true, total: shadow.total, capped: shadow.capped, by_outcome: shadow.by_outcome, validated_drafts: shadow.validated_drafts } : { available: false, code: shadow.code }) : { available: false, code: 'SOURCE_NOT_CONFIGURED' },
    approvals_waiting: { total: approvals.length, by_capability: capCounts, oldest_created_at: approvals.length ? approvals.map((a) => a.created_at).sort()[0] : null },
  }
}

/** @param {{ reads: object, shadowSource?: object|null, now?: () => number, org_id?: string }} deps */
export function createReviewDigestHandler({ reads, shadowSource = null, now = () => Date.now(), org_id = DEFAULT_ORG_ID } = {}) {
  if (!reads) throw new Error('conversation.review_digest: reads required')
  return Object.freeze({
    kind: REVIEW_DIGEST_KIND,
    async run(ctx) {
      if (!missionIdentity(ctx.job.requested_by).verified) throw new RuntimePermanentError('MISSION_PRINCIPAL_INVALID')
      const hours = Math.min(Math.max(Number(ctx.job.input?.window_hours) || 24, 1), 168)
      const at = new Date(now()).toISOString()
      const since = new Date(now() - hours * 3600_000).toISOString()
      const cp = { v: 1, ...(ctx.job.checkpoint || {}) }
      if (!cp.digest) {
        await ctx.step('collect', { progress: { step: 'collect', steps_done: 0, steps_total: 2, pct: 10 }, checkpoint: cp })
        const [activity, approvals, shadow] = await Promise.all([
          reads.activitySince({ since }),
          reads.pendingApprovals({ org_id, limit: 100 }).catch(() => []),
          shadowSource ? shadowSource.summary({ since }).catch(() => ({ available: false, code: 'SOURCE_UNAVAILABLE' })) : Promise.resolve(null),
        ])
        // the digest job itself is not "work done"
        activity.jobs = activity.jobs.filter((j) => j.job_id !== ctx.job.job_id)
        cp.digest = buildDigest({ activity, approvals, shadow, since, at })
        await ctx.step('collect.done', { progress: { step: 'collect', steps_done: 1, steps_total: 2, pct: 60 }, checkpoint: cp, payload: { missions: cp.digest.missions.total, approvals_waiting: cp.digest.approvals_waiting.total } })
      }
      if (!cp.findings) {
        cp.findings = await recordFindings(ctx, [{ finding_type: 'digest.morning', key: `digest.${cp.digest.window.until.slice(0, 10)}`, source_id: 'agent.review_digest', value: cp.digest, confidence: 1 }])
        await ctx.step('findings.done', { progress: { step: 'findings', steps_done: 2, steps_total: 2, pct: 99 }, checkpoint: cp, payload: { written: cp.findings.written } })
      }
      return { result: { mission: 'review_digest', ...cp.digest, findings_recorded: cp.findings.written } }
    },
  })
}
