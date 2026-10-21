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
//
// 8.5.20 part C — the owner's DAILY OPERATING BRIEF extends this digest (it is not a
// second digest): with `operations` ({ source, store } of lib/agent/operations) the
// result and the finding also carry `brief` (operations/operating-brief.js) — work
// completed, new viable opportunities, offers prepared, negotiations advanced, deals
// awaiting approval, follow-ups completed, recovered opportunities, campaign / sender
// changes, system incidents, recommended next actions — every line linked to its source
// records; a source that cannot be read is "unavailable", never 0. Without `operations`
// the brief is present with every operations section unavailable.
import { RuntimePermanentError } from '../runtime/runtime-tick.js'
import { REVIEW_DIGEST_KIND, missionIdentity } from './mission-kinds.js'
import { recordFindings } from './record-findings.js' // Package A: not research-mission-handler.js (capability plane → send stack)
import { DEFAULT_ORG_ID } from '../runtime/pg-store.js' // Package A: the same constant, without the capability plane import
import { buildOperatingBrief } from '../operations/operating-brief.js'

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

/** The operations reads the brief needs; each settles to { unavailable: code } on failure (never 0). */
export async function collectBriefInputs({ operations = null, since, until, org_id = DEFAULT_ORG_ID } = {}) {
  const off = (code) => Promise.resolve({ unavailable: code })
  const settle = (p, code) => p.then((v) => v ?? { unavailable: code }, (e) => ({ unavailable: String(e?.code || code).toUpperCase().slice(0, 60) }))
  const src = operations?.source || null
  const st = operations?.store || null
  const [facts, recovery, workItems, actionCenter, supervisor, researchValuation, valuationBatch] = await Promise.all([
    src ? settle(src.briefFacts({ since, until }), 'BRIEF_FACTS_UNAVAILABLE') : off('OPERATIONS_SOURCE_NOT_CONFIGURED'),
    st ? settle(Promise.all([st.recoveryCandidatesSince({ since }), st.latestFinding({ finding_type: 'recovery.batch', since })]).then(([c, b]) => (b ? { candidates: c, scanned: b.value?.scanned ?? null } : null)), 'RECOVERY_NOT_RUN') : off('OPERATIONS_STORE_NOT_CONFIGURED'),
    st ? settle(Promise.all([st.resolvedWorkItemsSince({ since }), st.listWorkItems({ limit: 100 })]).then(([resolved, open]) => ({ resolved, open })), 'WORK_ITEMS_UNAVAILABLE') : off('OPERATIONS_STORE_NOT_CONFIGURED'),
    st ? settle(st.actionCenterSummary().then((x) => (x.total ? x : null)), 'ACTION_CENTER_NOT_RUN') : off('OPERATIONS_STORE_NOT_CONFIGURED'),
    st ? settle(st.latestFinding({ finding_type: 'supervisor.summary', since }).then((f) => (f ? { ...f.value, job_id: f.job_id } : null)), 'SUPERVISOR_NOT_RUN') : off('OPERATIONS_STORE_NOT_CONFIGURED'),
    // 8.5.21-b: valuation coverage / overdue offers / negotiation authority, and the latest valuation dry run
    src?.researchValuationSnapshot ? settle(src.researchValuationSnapshot({ now: until }), 'RESEARCH_VALUATION_SNAPSHOT_UNAVAILABLE') : off('RESEARCH_VALUATION_SOURCE_NOT_CONFIGURED'),
    st ? settle(st.latestFinding({ finding_type: 'valuation.refresh_batch' }).then((f) => (f ? { ...f.value, at: f.retrieved_at, job_id: f.job_id } : null)), 'VALUATION_REFRESH_NOT_RUN') : off('OPERATIONS_STORE_NOT_CONFIGURED'),
  ])
  void org_id
  return { facts, recovery, workItems, actionCenter, supervisor, researchValuation, valuationBatch }
}

/** @param {{ reads: object, shadowSource?: object|null, operations?: { source?: object, store?: object }|null, now?: () => number, org_id?: string }} deps */
export function createReviewDigestHandler({ reads, shadowSource = null, operations = null, now = () => Date.now(), org_id = DEFAULT_ORG_ID } = {}) {
  if (!reads) throw new Error('conversation.review_digest: reads required')
  async function buildBrief({ ctx, since, at, digest }) {
    const [activity, approvalsRead, ops] = await Promise.all([
      reads.activitySince({ since }).catch(() => ({ jobs: [] })),
      reads.pendingApprovals({ org_id, limit: 100 }).catch((e) => ({ unavailable: String(e?.code || 'APPROVALS_UNAVAILABLE') })),
      collectBriefInputs({ operations, since, until: at, org_id }),
    ])
    const jobs = (activity.jobs || []).filter((j) => j.job_id !== ctx.job.job_id)
    return buildOperatingBrief({ digest, jobs: jobs.slice(0, 50), approvals: approvalsRead, discoveryJobIds: jobs.filter((j) => j.kind === 'acquisition.discovery').map((j) => j.job_id).slice(0, 10), ...ops })
  }
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
        // 8.5.20 C: the brief is built here, never checkpointed (the 16 KB checkpoint cap); its
        // sources are re-read on a resumed attempt — the finding is the durable copy
        const brief = await buildBrief({ ctx, since: cp.digest.window.since, at: cp.digest.window.until, digest: cp.digest })
        cp.brief_summary = brief.sections.map((x) => ({ id: x.id, available: x.available, lines: x.lines.length, ...(x.available ? {} : { code: x.code }) }))
        cp.findings = await recordFindings(ctx, [{ finding_type: 'digest.morning', key: `digest.${cp.digest.window.until.slice(0, 10)}`, source_id: 'agent.review_digest', value: { ...cp.digest, brief }, confidence: 1 }])
        await ctx.step('findings.done', { progress: { step: 'findings', steps_done: 2, steps_total: 2, pct: 99 }, checkpoint: cp, payload: { written: cp.findings.written } })
      }
      return { result: { mission: 'review_digest', ...cp.digest, brief_sections: cp.brief_summary, findings_recorded: cp.findings.written } }
    },
  })
}
