// Platform ops + missions capabilities.
//
// platform.health: heartbeats judged from the ISO timestamp stored in
// system_control.value (updated_at is not maintained for these keys), queue
// health from the system watchdog's one read-only snapshot, and the campaign
// feeder's last-run diagnostics (campaign_feeder_last_*). Unknown is unknown.
//
// missions.create: enqueues an R2 runtime mission through agent.runtime_enqueue
// (SECURITY DEFINER; PROPOSED schema — refuses until applied). Only kinds with a
// registered runtime handler are accepted; the mission is accountable to the
// verified operator and is idempotent per operator × kind × input × UTC hour.
import { evaluateHealthSnapshot, OPS_HEALTH_CHECK_KIND } from '../../runtime/handlers/ops-health-check.js'
import { runtimeIdempotencyKey } from '../../runtime/job-runtime.js'
import { canonicalJson } from '../../runtime/canonical.js'
import { refusal } from '../registry.js'
import { HEARTBEAT_KEYS, FEEDER_KEYS } from '../services.js'
import { int, enumOf, obj, clean, n, isoOrNull } from './_schema.js'

/** Kinds with a registered runtime handler (runtime-service DEFAULT_RUNTIME_HANDLERS). */
export const MISSION_KINDS = Object.freeze([OPS_HEALTH_CHECK_KIND])

export const platformCapabilities = [
  {
    id: 'platform.health',
    version: 1,
    domain: 'platform_ops',
    title: 'Platform health',
    description: 'Scheduler heartbeats (age from the stored timestamp), queue processor modes, overdue / stuck send counts and watchdog findings, and the campaign feeder\'s last-run diagnostics.',
    input_schema: obj({}),
    output_schema: { type: 'object' },
    side_effect: 'read',
    tier: 'autonomous_internal',
    cost_class: 'db_light',
    limits: { per_min: 12, per_day: 2000, timeout_ms: 30_000, rows_to_model: 25 },
    wraps: { service: 'system-control#getSystemValue + system-watchdog#collectWatchdogSnapshot/evaluateWatchdog + ops-health-check#evaluateHealthSnapshot' },
    async execute(_input, ctx) {
      const [values, wd] = await Promise.all([
        ctx.services.platform.systemValues([...HEARTBEAT_KEYS, ...FEEDER_KEYS]),
        ctx.services.platform.watchdog().catch((e) => ({ error: String(e?.code || 'watchdog_unavailable') })),
      ])
      const snap = wd?.snapshot || {}
      // followup_no_response_heartbeat_at is event-driven (written on delivery
      // receipts): judged against the newest delivery when the snapshot has it,
      // else 'unverified' -- never a false 'stale' on a quiet night (8.5.15).
      const hb = evaluateHealthSnapshot({ at: new Date(ctx.now()).toISOString(), keys: values, queue: {}, ...(snap.last_delivered_at ? { deliveries: { last_delivered_at: isoOrNull(snap.last_delivered_at) } } : {}) })
      return {
        at: hb.at,
        heartbeats: hb.heartbeats,
        modes: hb.modes,
        queue: wd?.error ? { unavailable: wd.error } : {
          sends_due_waiting: n(snap.sends_due_waiting), last_sent_at: isoOrNull(snap.last_sent_at), sent_in_window: n(snap.sent_in_window),
          failed_1h: n(snap.failed_1h), attempts_1h: n(snap.attempts_1h), auto_replies_blocked_1h: n(snap.auto_replies_blocked_1h),
          followups_overdue: n(snap.followups_overdue), inbound_unprocessed_2h: n(snap.inbound_unprocessed_2h), outbound_enabled: snap.outbound_enabled ?? null,
          read_error: snap.read_error ? 'snapshot_read_failed' : null,
        },
        watchdog: wd?.evaluation ? { findings: (wd.evaluation.findings || []).map((f) => ({ code: f.code, severity: f.severity, summary: clean(f.summary).slice(0, 200) })), unknown: wd.evaluation.unknown || [] } : null,
        feeder_last: {
          batch_at: isoOrNull(values.campaign_feeder_last_batch_at), inserted: n(values.campaign_feeder_last_inserted_count), blocked: n(values.campaign_feeder_last_blocked_count),
          campaigns: n(values.campaign_feeder_last_campaign_count), stalled: n(values.campaign_feeder_last_stalled_count), reason: clean(values.campaign_feeder_last_reason) || null,
        },
      }
    },
    audit: (_i, r) => ({ stale: (r?.heartbeats || []).filter((h) => h.status === 'stale').length, unverified: (r?.heartbeats || []).filter((h) => h.status === 'unverified').length }),
  },
  {
    id: 'missions.create',
    version: 1,
    domain: 'missions',
    title: 'Create a runtime mission',
    description: `Enqueue a persistent runtime mission (kinds: ${MISSION_KINDS.join(', ')}). Deterministic, $0, no outbound. Idempotent per kind and input within the hour.`,
    input_schema: obj({ kind: enumOf(MISSION_KINDS), overdue_minutes: int(1, 1440), processing_stale_minutes: int(1, 1440), priority: int(1, 1000) }, ['kind']),
    output_schema: { type: 'object' },
    side_effect: 'internal_write',
    tier: 'autonomous_internal',
    cost_class: 'db_light',
    limits: { per_min: 3, per_day: 50, timeout_ms: 15_000, rows_to_model: 5 },
    touches: ['agent_runtime_job'],
    wraps: { service: 'agent.runtime_enqueue (job-runtime#createRuntimePgStore.enqueue, PROPOSED R2)' },
    compensation: { kind: 'cancel_mission', note: 'agent.runtime_cancel(job_id) by the operator before it runs; a health check writes findings only.' },
    idempotency: (input, ctx) => canonicalJson({ k: input.kind, i: { o: input.overdue_minutes ?? null, p: input.processing_stale_minutes ?? null }, h: new Date(ctx.now()).toISOString().slice(0, 13) }),
    async execute(input, ctx) {
      const missionInput = {}
      if (input.overdue_minutes) missionInput.overdue_minutes = input.overdue_minutes
      if (input.processing_stale_minutes) missionInput.processing_stale_minutes = input.processing_stale_minutes
      const key = runtimeIdempotencyKey('capability.missions.create', ctx.org_id, ctx.actor, this.idempotency(input, ctx))
      const r = await ctx.services.missions.enqueue({ kind: input.kind, idempotency_key: key, input: missionInput, requested_by: ctx.actor, priority: input.priority ?? 100, max_attempts: 3, budget_cap_usd: 0, require_approval: false })
      if (!r?.ok) throw refusal(String(r?.reason || 'ENQUEUE_REFUSED').toUpperCase())
      // read back the mission's own event stream (job.enqueued) when the runtime exposes it
      let readback = { state: r.state, event: null }
      if (typeof ctx.services.missions.events === 'function') {
        const ev = await ctx.services.missions.events(r.job_id).catch(() => null)
        const first = Array.isArray(ev) ? ev[0] : null
        readback = { state: first?.state || r.state, event: first?.type || null }
        if (!first) throw refusal('READBACK_FAILED', 'no job event after enqueue')
      }
      return { job_id: r.job_id, state: r.state, deduped: Boolean(r.deduped), readback }
    },
    audit: (input, r) => ({ result: r ? { job_id: r.job_id, state: r.state, deduped: r.deduped } : null, kind: input.kind }),
  },
]
