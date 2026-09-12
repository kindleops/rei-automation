import assert from 'node:assert/strict'
import test from 'node:test'

import {
  repairCampaignTargetReadiness,
  READINESS_REASON,
} from '@/lib/domain/campaigns/repair-campaign-target-readiness.js'

/**
 * Security envelope for the target-scoped readiness repair.
 *
 * The point of these tests is not that the happy path works — it is that the
 * blast radius is exactly one row and that template choice stays with
 * governance no matter what the caller or the existing row says.
 */

const SENDABLE_EN = [
  { template_id: '204273', language: 'English', use_case: 'ownership_check', stage_code: 'S1', property_type_scope: 'Any Residential', is_active: true, template_body: 'Hey {{seller_first_name}}, this is {{agent_name}}. Do you own {{property_address}}?' },
  { template_id: '204529', language: 'English', use_case: 'ownership_check', stage_code: 'S1', property_type_scope: 'Any Residential', is_active: true, template_body: 'Hey {{seller_first_name}}, this is {{agent_name}}. Are you still the owner of {{property_address}}?' },
]
const SENDABLE_ES = [
  { template_id: '200002', language: 'Spanish', use_case: 'ownership_check', stage_code: 'S1', property_type_scope: 'Any Residential', is_active: true, template_body: 'Hola {{seller_first_name}}, soy {{agent_name}}. Todavia eres el dueno de {{property_address}}?' },
  { template_id: '200114', language: 'Spanish', use_case: 'ownership_check', stage_code: 'S1', property_type_scope: 'Any Residential', is_active: true, template_body: 'Hola {{seller_first_name}}, soy {{agent_name}}. Sigues siendo el dueno de {{property_address}}?' },
]
/** Active and semantically fine, but paused in governance. Must never be picked. */
// Scope and renderability deliberately match the sendable fixtures, so
// governance is the ONLY thing that can reject these two.
const PAUSED_EN = {
  template_id: '200001', language: 'English', use_case: 'ownership_check', stage_code: 'S1',
  property_type_scope: 'Any Residential', is_active: true,
  template_body: 'Hi {{seller_first_name}}, this is {{agent_name}}. Do you own {{property_address}}?',
}
/** Active, semantically fine, but has no governance row at all. */
const UNGOVERNED_EN = {
  template_id: '200017', language: 'English', use_case: 'ownership_check', stage_code: 'S1',
  property_type_scope: 'Any Residential', is_active: true,
  template_body: 'Hi {{seller_first_name}}, this is {{agent_name}}. Are you still the owner of {{property_address}}?',
}

const GOVERNANCE = [
  ...SENDABLE_EN.map((t) => ({ template_id: t.template_id, language: 'English', rotation_status: 'testing', daily_cap: 25, traffic_weight: 1.5 })),
  ...SENDABLE_ES.map((t) => ({ template_id: t.template_id, language: 'Spanish', rotation_status: 'testing', daily_cap: 20, traffic_weight: 0.5 })),
  { template_id: PAUSED_EN.template_id, language: 'English', rotation_status: 'pause', daily_cap: 0, traffic_weight: 0 },
  // UNGOVERNED_EN deliberately absent.
]

const ALL_TEMPLATES = [...SENDABLE_EN, ...SENDABLE_ES, PAUSED_EN, UNGOVERNED_EN]

function baseTarget(overrides = {}) {
  return {
    id: 'tgt-1',
    campaign_id: 'camp-1',
    target_status: 'ready',
    routing_status: 'ready',
    language: 'English',
    market: 'Miami, FL',
    to_phone_number: '+13050000001',
    master_owner_id: 'mo-1',
    property_id: 'prop-1',
    phone_id: 'ph-1',
    metadata: { candidate_snapshot: { property_type: 'Single Family' } },
    ...overrides,
  }
}

const CAMPAIGN = { id: 'camp-1', name: 'canary', status: 'draft', metadata: { stage_code: 'S1' } }

/**
 * Records every write so a test can assert the blast radius, not just the
 * return value.
 */
function makeSupabase({ target = baseTarget(), campaign = CAMPAIGN, senders = [{ phone_number: '+17866052999', market: 'Miami, FL', status: 'active' }], templates = ALL_TEMPLATES, governance = GOVERNANCE } = {}) {
  const writes = []

  const term = (data) => {
    const t = {
      select: () => t,
      eq: () => t,
      in: () => t,
      order: () => t,
      range: () => t,
      limit: () => t,
      not: () => t,
      maybeSingle: async () => ({ data: Array.isArray(data) ? data[0] ?? null : data, error: null }),
      single: async () => ({ data: Array.isArray(data) ? data[0] ?? null : data, error: null }),
      then(res, rej) { return Promise.resolve({ data, error: null }).then(res, rej) },
    }
    return t
  }

  const supabase = {
    from(table) {
      if (table === 'campaign_targets') {
        return {
          select: () => term(target ? [target] : []),
          update: (patch) => ({
            eq: async (col, val) => {
              writes.push({ table, patch, col, val })
              return { data: null, error: null }
            },
          }),
        }
      }
      if (table === 'campaigns') return { select: () => term(campaign ? [campaign] : []) }
      if (table === 'textgrid_numbers') return { select: () => term(senders) }
      if (table === 'sms_templates') return { select: () => term(templates) }
      if (table === 'ownership_template_rotation_control') return { select: () => term(governance) }
      return { select: () => term([]) }
    },
  }

  return { supabase, writes }
}

const DEPS = (supabase) => ({
  supabase,
  // Inject rather than reach the control plane.
  dispatchBlockedSets: { template_ids: new Set(), sender_numbers: new Set() },
})

test('assigns a governed, sendable template and reports readiness', async () => {
  const { supabase, writes } = makeSupabase()
  const res = await repairCampaignTargetReadiness({ campaign_target_id: 'tgt-1' }, DEPS(supabase))

  assert.equal(res.ok, true)
  assert.equal(res.reason, READINESS_REASON.READY)
  assert.ok(
    SENDABLE_EN.some((t) => t.template_id === res.template_id),
    `expected a governed English template, got ${res.template_id}`,
  )
  assert.equal(res.market, 'Miami, FL')
})

test('SEND SAFETY: creates no queue row, no dispatch, no activation', async () => {
  const { supabase, writes } = makeSupabase()
  const res = await repairCampaignTargetReadiness({ campaign_target_id: 'tgt-1' }, DEPS(supabase))

  assert.equal(res.queue_rows_created, 0)
  assert.equal(res.campaign_activated, false)
  assert.equal(res.auto_send_enabled_changed, false)
  // The structural guarantee: campaign_targets is the ONLY table written.
  assert.deepEqual([...new Set(writes.map((w) => w.table))], ['campaign_targets'])
})

test('TARGET SCOPE: exactly one target touched, no siblings', async () => {
  const { supabase, writes } = makeSupabase()
  await repairCampaignTargetReadiness({ campaign_target_id: 'tgt-1' }, DEPS(supabase))

  assert.equal(writes.length, 1)
  assert.equal(writes[0].col, 'id')
  assert.equal(writes[0].val, 'tgt-1')
})

test('GOVERNANCE: a paused template is never assigned', async () => {
  // Only the paused template exists in the catalog at all.
  const { supabase } = makeSupabase({ templates: [PAUSED_EN], governance: GOVERNANCE })
  const res = await repairCampaignTargetReadiness({ campaign_target_id: 'tgt-1' }, DEPS(supabase))

  assert.equal(res.ok, false)
  assert.notEqual(res.template_id, PAUSED_EN.template_id)
  assert.equal(res.template_id, null)
})

test('GOVERNANCE: an ungoverned template is never assigned', async () => {
  const { supabase } = makeSupabase({ templates: [UNGOVERNED_EN], governance: GOVERNANCE })
  const res = await repairCampaignTargetReadiness({ campaign_target_id: 'tgt-1' }, DEPS(supabase))

  assert.equal(res.ok, false)
  assert.notEqual(res.template_id, UNGOVERNED_EN.template_id)
  assert.equal(res.template_id, null)
})

test('REGRESSION: a paused template already named on the row is cleared, not honoured', async () => {
  // This is the drift that produced "ready with a paused template" in
  // production: the row already carried 200001. Passing its id through
  // metadata must not be a way to select it.
  const target = baseTarget({
    metadata: { template_id: PAUSED_EN.template_id, candidate_snapshot: { property_type: 'Single Family' } },
  })
  const { supabase, writes } = makeSupabase({ target, templates: [PAUSED_EN], governance: GOVERNANCE })
  const res = await repairCampaignTargetReadiness({ campaign_target_id: 'tgt-1' }, DEPS(supabase))

  assert.equal(res.ok, false)
  assert.equal(res.template_id, null)
  // and the stale id must be cleared on the row, not left behind
  assert.equal(writes[0].patch.metadata.template_id, null)
})

test('LANGUAGE: an English target never receives a Spanish template', async () => {
  const { supabase } = makeSupabase()
  const res = await repairCampaignTargetReadiness({ campaign_target_id: 'tgt-1' }, DEPS(supabase))

  assert.equal(res.ok, true)
  assert.ok(!SENDABLE_ES.some((t) => t.template_id === res.template_id))
  assert.equal(res.language, 'English')
})

test('LANGUAGE: a Spanish target never receives an English template', async () => {
  const target = baseTarget({ language: 'Spanish' })
  const { supabase } = makeSupabase({ target })
  const res = await repairCampaignTargetReadiness({ campaign_target_id: 'tgt-1' }, DEPS(supabase))

  assert.equal(res.ok, true)
  assert.ok(SENDABLE_ES.some((t) => t.template_id === res.template_id))
  assert.ok(!SENDABLE_EN.some((t) => t.template_id === res.template_id))
})

test('LANGUAGE: no cross-language fallback when the language pool is empty', async () => {
  // Spanish target, but only English templates are governed.
  const target = baseTarget({ language: 'Spanish' })
  const { supabase } = makeSupabase({ target, templates: SENDABLE_EN })
  const res = await repairCampaignTargetReadiness({ campaign_target_id: 'tgt-1' }, DEPS(supabase))

  assert.equal(res.ok, false)
  assert.ok(!SENDABLE_EN.some((t) => t.template_id === res.template_id))
  assert.equal(res.template_id, null)
})

test('MARKET: an unresolved market is reported, never invented', async () => {
  const target = baseTarget({ market: '', metadata: {} })
  const { supabase, writes } = makeSupabase({ target, campaign: { ...CAMPAIGN, market: null } })
  const res = await repairCampaignTargetReadiness({ campaign_target_id: 'tgt-1' }, DEPS(supabase))

  assert.equal(res.ok, false)
  assert.equal(res.reason, READINESS_REASON.MARKET_UNRESOLVED)
  assert.equal(writes.length, 0, 'must not write a fabricated market')
})

test('MARKET: a market with no active sender inventory fails closed', async () => {
  const { supabase, writes } = makeSupabase({ senders: [] })
  const res = await repairCampaignTargetReadiness({ campaign_target_id: 'tgt-1' }, DEPS(supabase))

  assert.equal(res.ok, false)
  assert.equal(res.reason, READINESS_REASON.MARKET_UNPROVISIONED)
  assert.equal(writes.length, 0, 'an unprovisioned market must not be recorded as readiness')
})

test('a non-ready target is reported, not repaired', async () => {
  const { supabase, writes } = makeSupabase({ target: baseTarget({ target_status: 'suppressed' }) })
  const res = await repairCampaignTargetReadiness({ campaign_target_id: 'tgt-1' }, DEPS(supabase))

  assert.equal(res.ok, false)
  assert.equal(res.reason, READINESS_REASON.TARGET_NOT_READY)
  assert.equal(writes.length, 0)
})

test('a missing target id is refused before any read', async () => {
  const { supabase, writes } = makeSupabase()
  const res = await repairCampaignTargetReadiness({}, DEPS(supabase))

  assert.equal(res.ok, false)
  assert.equal(res.reason, READINESS_REASON.TARGET_REQUIRED)
  assert.equal(writes.length, 0)
})

test('S2 BOUNDARY: a consider_selling campaign is refused, not silently assigned', async () => {
  // governanceApplies() is true only for ownership_check, so for
  // consider_selling evaluateTemplateGovernance short-circuits to ok:true and
  // EVERY active template becomes eligible. Without the guard this route would
  // hand an autonomous caller an ungoverned S2 template.
  const campaign = { ...CAMPAIGN, metadata: { stage_code: 'S2', template_use_case: 'consider_selling' } }
  const s2Templates = [{
    template_id: '999001', language: 'English', use_case: 'consider_selling', stage_code: 'S2',
    property_type_scope: 'Any Residential', is_active: true,
    template_body: 'Hi {{seller_first_name}}, would you consider selling {{property_address}}?',
  }]
  const { supabase, writes } = makeSupabase({ campaign, templates: s2Templates, governance: [] })
  const res = await repairCampaignTargetReadiness({ campaign_target_id: 'tgt-1' }, DEPS(supabase))

  assert.equal(res.ok, false)
  assert.equal(res.reason, READINESS_REASON.USE_CASE_UNGOVERNED)
  assert.equal(res.template_id, null)
  assert.equal(writes.length, 0, 'an ungoverned use case must not write readiness')
})

test('S2 BOUNDARY: the guard is the governance predicate, not a hardcoded string', () => {
  // If someone later replaces the predicate with a literal use-case check,
  // consider_selling gaining a governance surface would silently stay locked
  // out — and worse, a third use case could be let in by a typo.
  const source = repairCampaignTargetReadiness.toString()
  assert.ok(
    /governanceApplies\(/.test(source),
    'the S1 boundary must be expressed via governanceApplies()',
  )
})

test('the function exposes no template_id input a caller could use', () => {
  // Selection authority must not be reachable from the call site. If someone
  // later adds a template_id parameter, this fails and forces the conversation.
  const source = repairCampaignTargetReadiness.toString()
  assert.ok(
    !/input\.(template_id|templateId)/.test(source),
    'repairCampaignTargetReadiness must not read a caller-supplied template id',
  )
})
