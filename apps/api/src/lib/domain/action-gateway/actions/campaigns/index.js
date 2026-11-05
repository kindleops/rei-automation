// Campaign DRAFTS through the Action Gateway (PROPOSED_20261105120000_action_gateway_service_principals.sql).
//
//   create_campaign_draft  (T1, internal write) the Campaign Composer's draft for a pinned set of properties: the
//                          property ids an agent names and / or the properties of the leads (threads) it names, pinned
//                          exactly as the Composer and Entity Graph pin a selection (target_filters.properties =
//                          [{ field_key: 'properties.property_id', operator: 'is_any_of', value: [...] }]). Capability
//                          campaigns.create_draft, the same capability the agent capability plane's Campaign Composer
//                          draft carries (agent/capabilities/defs/campaigns.js). Status DRAFT, always: the ONE
//                          lease-bound writer (public.action_gateway_dw_campaign_draft) inserts a draft and nothing
//                          else. It builds no targets, schedules nothing, queues nothing, sends nothing. A human
//                          launches from Campaign Command; no gateway tool can launch, schedule or resume a campaign.
//                          Idempotent per client_request_id (the gateway intent) AND per intent inside the writer (the
//                          composer key is derived from the intent's idempotency key: a recovery re-execution finds the
//                          draft it already made).
//   get_campaign           (T1, read) the campaign's state now: id, name, status, strategy, caps, how many properties
//                          are pinned and who drafted it. The read-back agntei uses after create_campaign_draft.
import { UUID, str, int, enumOf, list, obj } from '../../../../agent/capabilities/defs/_schema.js'
import { STRATEGIES } from '../../../../agent/capabilities/defs/campaigns.js'
import crypto from 'node:crypto'
import { encodePropertyRef } from '../../../../agent/missions/mission-codec.js'
import { TIERS } from '../../constants.js'
import { gwErr } from '../../errors.js'
import { client, TEXT } from '../t2/_schema.js'
import { cleanText, neverReviveCode, deny, allow } from '../t2/shared.js'

export const CAMPAIGN_DRAFT_WRITE = 'action_gateway_dw_campaign_draft'
/** The Composer's strategies and their canonical stage codes (campaign-composer.js#COMPOSER_STRATEGIES; a unit test pins them). */
export const STRATEGY_STAGE = Object.freeze({ ownership_check: 'S1', consider_selling: 'S2', seller_asking_price: 'S3' })
export const MAX_PINNED_PROPERTIES = 200
export const MAX_LEADS = 50
const PROPERTY_ID = str(64, { minLength: 1, pattern: '^[A-Za-z0-9_-]{1,64}$' })
const low = (v) => String(v ?? '').trim().toLowerCase()
const n = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

export const CREATE_DRAFT_SPEC = Object.freeze({
  name: 'create_campaign_draft',
  title: 'Create a campaign draft (never sent)',
  description: 'Create a DRAFT campaign in LeadCommand\'s Campaign Composer for a pinned set of properties: property_ids and / or thread_ids (leads; each lead\'s property is pinned). Status is always draft: no targets are built, nothing is scheduled, queued or sent, and no gateway tool can launch it (a human launches from Campaign Command, where every launch gate runs). Retrying with the same client_request_id returns the same draft. Read it back with get_campaign.',
  capability: 'campaigns.create_draft', tier: TIERS.T1, resource: 'system',
  input: obj({ ...client, name: TEXT(80, 3), template_use_case: enumOf(STRATEGIES), property_ids: list(PROPERTY_ID, MAX_PINNED_PROPERTIES), thread_ids: list(UUID, MAX_LEADS),
    campaign_size: enumOf(['all', 'custom']), total_cap: int(1, 100_000), daily_cap: int(0, 100_000) }, ['client_request_id', 'name']),
  executor: { kind: 'domain_write', fn: CAMPAIGN_DRAFT_WRITE },
  recovery: 'reexecute',
  limits: { per_min: 6 },
  wraps: { service: 'campaign-composer#saveComposerDraft semantics (draft only, pinned selection), lease-bound writer public.action_gateway_dw_campaign_draft', module: 'apps/api/src/lib/domain/campaigns/campaign-composer.js' },
  touches: ['campaign_draft'],
})

export const GET_CAMPAIGN_SPEC = Object.freeze({
  name: 'get_campaign',
  title: 'Read a campaign',
  description: 'One campaign\'s state now: campaign_id, name, status (draft until a human launches it), strategy, caps, pinned property count, and whether an agent drafted it through the gateway. The read-back after create_campaign_draft.',
  capability: 'campaigns.read', tier: TIERS.T1, scope: null, resource: 'campaign',
  input: obj({ campaign_id: UUID }, ['campaign_id']),
  limits: { per_min: 60 },
  wraps: { service: 'public.campaigns (the gateway read inventory)', module: 'apps/api/src/lib/domain/campaigns/campaign-automation-service.js#getCampaign (projection)' },
})

function pinnedIdsOf(row) {
  const groups = row?.metadata?.target_filters?.properties
  const ids = []
  for (const f of Array.isArray(groups) ? groups : []) if (f?.field_key === 'properties.property_id' && Array.isArray(f.value)) ids.push(...f.value)
  return ids
}

/** The read-back projection (ids, codes, counts; never a property id list, an address or a phone). */
export function campaignView(row) {
  const md = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {}
  const src = md.composer_source && typeof md.composer_source === 'object' ? md.composer_source : {}
  const status = low(row?.status) || null
  return {
    campaign_id: row?.id || null,
    name: cleanText(row?.name, 120) || null,
    status,
    is_draft: status === 'draft',
    template_use_case: md.template_use_case || null,
    stage_code: md.stage_code || null,
    campaign_size: md.composer_campaign_size || null,
    daily_cap: n(row?.daily_cap),
    total_cap: n(row?.total_cap),
    pinned_properties: pinnedIdsOf(row).length,
    created_at: row?.created_at || null,
    drafted_through_gateway: src.kind === 'action_gateway',
    drafted_by_agent: src.kind === 'action_gateway' ? src.agent_id || null : null,
    launch: 'human_only',
  }
}

export const CAMPAIGN_LOGIC = Object.freeze({
  create_campaign_draft: {
    async resolve(input, { reads }) {
      const ids = new Set((input.property_ids || []).map(String))
      for (const tid of input.thread_ids || []) {
        const t = await reads.thread(tid)
        if (!t?.thread_key) throw gwErr('not_found', 'THREAD_NOT_FOUND', 'no lead (inbox thread) with this id')
        if (!t.property_id) throw gwErr('invalid_input', 'LEAD_HAS_NO_PROPERTY', 'a named lead has no property to pin')
        ids.add(String(t.property_id))
      }
      if (!ids.size) throw gwErr('invalid_input', 'AUDIENCE_REQUIRED', 'name at least one property_id or thread_id (the draft pins exactly those properties)')
      if (ids.size > MAX_PINNED_PROPERTIES) throw gwErr('invalid_input', 'AUDIENCE_TOO_LARGE', `a gateway draft pins at most ${MAX_PINNED_PROPERTIES} properties`)
      const found = new Set((await reads.properties([...ids])).map((p) => String(p.property_id)))
      const missing = [...ids].filter((id) => !found.has(id))
      if (missing.length) throw gwErr('not_found', 'PROPERTY_NOT_FOUND', `${missing.length} of the named properties do not exist`)
      // an audience never includes a contact LeadCommand says may not be contacted: a suppressed, opted-out or
      // do-not-contact lead on any pinned property (and a STOP on a named lead) refuses the whole draft; nothing is pinned
      const blocked = await ineligiblePins([...ids], input.thread_ids || [], reads)
      if (blocked.count) throw gwErr('forbidden', 'AUDIENCE_NOT_ELIGIBLE', `${blocked.count} of the named properties have a contact that may not be contacted (${blocked.reasons.join(', ')}); leave them out`, { ineligible: blocked.count, reasons: blocked.reasons })
      return { type: 'system', id: 'campaign_draft', refs: { property_ids: [...ids].sort(), lead_count: (input.thread_ids || []).length } }
    },
    params(input, resource) {
      const uc = input.template_use_case || 'ownership_check'
      return {
        name: cleanText(input.name, 80),
        template_use_case: uc,
        stage_code: STRATEGY_STAGE[uc] || 'S1',
        // stored as pid_ letter refs (agent.payload_is_clean never sees a raw digit run); the writer decodes them
        property_refs: resource.refs.property_ids.map(encodePropertyRef),
        lead_count: resource.refs.lead_count,
        ...(input.campaign_size ? { campaign_size: input.campaign_size } : {}),
        ...(input.total_cap != null ? { total_cap: input.total_cap } : {}),
        ...(input.daily_cap != null ? { daily_cap: input.daily_cap } : {}),
        status: 'draft',
      }
    },
    async policy({ input, resource }) {
      if (input.campaign_size === 'custom' && input.total_cap == null) return deny('CAMPAIGN_SIZE_NUMBER_REQUIRED', { field: 'total_cap' })
      for (const pid of resource.refs.property_ids) {
        const nr = neverReviveCode({ property_id: pid })
        if (nr) return deny(nr, {})
      }
      for (const tid of input.thread_ids || []) {
        const nr = neverReviveCode({ thread_id: tid })
        if (nr) return deny(nr, {})
      }
      return allow({ status: 'draft', pinned_properties: resource.refs.property_ids.length, sends: 0, launch: 'human_only' })
    },
  },
  get_campaign: {
    async read({ input, reads, coverResource }) {
      const row = await reads.campaign(input.campaign_id)
      if (!row) throw gwErr('not_found', 'CAMPAIGN_NOT_FOUND', 'no campaign with this id')
      coverResource({ type: 'campaign', id: String(row.id), refs: { market: row.market || null } })
      // the audience read-back: how many properties are pinned, a digest of exactly which (so the caller can match its own
      // list without LeadCommand returning property ids), and how many of them may NOT be contacted right now
      const pinned = pinnedIdsOf(row).map(String)
      const now = await ineligiblePins(pinned, [], reads)
      return { resource_type: 'campaign', campaign: { ...campaignView(row), audience: { pinned_properties: pinned.length, digest: audienceDigest(pinned), ineligible_now: now.count, ineligible_reasons: now.reasons } } }
    },
  },
})

/** sha256 over the sorted, de-duplicated property ids joined by newlines: the audience's identity without the ids. */
export function audienceDigest(ids) {
  return crypto.createHash('sha256').update([...new Set((ids || []).map(String))].sort().join('\n')).digest('hex')
}
/** Pinned properties with a contact that may not be contacted (and STOP on a named lead): count + reason codes. */
async function ineligiblePins(propertyIds, threadIds, reads) {
  if (typeof reads.audienceEligibility !== 'function') throw gwErr('unavailable', 'AUDIENCE_CHECK_UNAVAILABLE', 'the audience eligibility read is not available; no draft is made without it')
  const rowsOf = await reads.audienceEligibility(propertyIds)
  const bad = new Set(); const reasons = new Set()
  for (const r of rowsOf) if (r.reasons.length) { bad.add(r.property_id); r.reasons.forEach((x) => reasons.add(x)) }
  for (const tid of threadIds) {
    const t = await reads.thread(tid)
    const p = t && typeof reads.permission === 'function' ? await reads.permission(t) : null
    if (p?.blocked) { bad.add(String(t.property_id)); p.reasons.forEach((x) => reasons.add(x)) }
  }
  return { count: bad.size, reasons: [...reasons].sort() }
}

export const CAMPAIGN_ACTIONS = Object.freeze([CREATE_DRAFT_SPEC])
export const CAMPAIGN_READS = Object.freeze([GET_CAMPAIGN_SPEC])
export const CAMPAIGN_NAMES = Object.freeze([...CAMPAIGN_ACTIONS, ...CAMPAIGN_READS].map((s) => s.name))
