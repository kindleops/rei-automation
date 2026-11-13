// Campaign metrics. REUSED: the research tools' campaign column whitelist and
// projection (CAMPAIGN_COLUMNS / projectCampaign / pinnedPropertyIds — pinned ids
// are counted, never returned). Target status counts are EXACT per-status head
// counts on the (campaign_id, target_status) btree — never a sample.
//
// NOT in 1.0: launch readiness (evaluateCampaignLaunchReadiness imports the
// outbound feeder / sender routing modules — outside the read-only import fence),
// truthful reply counts (message_events pairing — no bounded read path yet).
import { CAMPAIGN_COLUMNS, projectCampaign, pinnedPropertyIds } from '@/lib/agent/research/research-tools.js'
import { err } from '../errors.mjs'
import { prov } from '../provenance.mjs'
import { untrusted, isoOrNull, read } from './common.mjs'

export const TARGET_STATUSES = Object.freeze(['ready', 'planned', 'blocked', 'queued', 'scheduled', 'sent', 'failed', 'skipped', 'suppressed', 'replied'])
const COLS = `${CAMPAIGN_COLUMNS},progress_synced_at`

function shape(c, now) {
  const p = projectCampaign(c, { pinned: pinnedPropertyIds(c) })
  return {
    campaign_id: p.campaign_id,
    name: untrusted(p.name, 120),
    status: p.status, objective: untrusted(p.objective, 60), candidate_source: untrusted(p.candidate_source, 60), market: p.market, state: p.state,
    created_at: isoOrNull(p.created_at), updated_at: isoOrNull(p.updated_at),
    lifecycle: p.lifecycle,
    counters: {
      ...p.counts,
      provenance: prov({ kind: 'derived', source: 'campaigns row counters (progress sync)', as_of: c.progress_synced_at, window_days: 1, now }),
      caveat: 'replied / positive / opt_out counters are synced counters and have been measured to under-count; truthful reply counts come from message_events pairing, which MCP 1.0 does not expose.',
    },
    caps: p.caps,
    audience: { source: untrusted(p.audience.source, 60), handoff_mode: untrusted(p.audience.handoff_mode, 60), pinned_property_count: p.audience.pinned_property_count, entity_graph_stack_steps: p.audience.entity_graph_stack_steps, stack_labels: (p.audience.stack_labels || []).map((x) => untrusted(x, 80)) },
  }
}

export async function getCampaignMetrics(input, svc, { now }) {
  if (!input.campaign_id) {
    let q = svc.db.from('campaigns').select(COLS).order('updated_at', { ascending: false }).limit(input.limit)
    if (input.status) q = q.eq('status', input.status)
    const { rows } = await read(q, 'campaigns')
    return { campaigns: rows.map((c) => { const s = shape(c, now); delete s.audience.stack_labels; return s }), targets: null }
  }
  const { rows } = await read(svc.db.from('campaigns').select(COLS).eq('id', input.campaign_id).limit(1), 'campaigns')
  if (!rows[0]) throw err('not_found', 'no campaign with this id', { code: 'CAMPAIGN_NOT_FOUND' })
  const total = await read(svc.db.from('campaign_targets').select('id', { count: 'exact', head: true }).eq('campaign_id', input.campaign_id), 'campaign_targets')
  const counts = await Promise.all(TARGET_STATUSES.map((st) => read(svc.db.from('campaign_targets').select('id', { count: 'exact', head: true }).eq('campaign_id', input.campaign_id).eq('target_status', st), 'campaign_targets').then((r) => [st, r.count])))
  const by = Object.fromEntries(counts.filter(([, n]) => n != null && n > 0))
  const known = counts.reduce((a, [, n]) => a + (n || 0), 0)
  const t = total.count
  return {
    campaigns: [shape(rows[0], now)],
    targets: {
      total: t,
      by_status: by,
      other_statuses: t == null ? null : Math.max(t - known, 0),
      method: 'exact head counts per status on (campaign_id, target_status)',
      provenance: prov({ kind: 'fact', source: 'campaign_targets', as_of: now.toISOString() }),
    },
  }
}
