// Action Gateway TIER-2 tools END TO END on a DISPOSABLE PostgreSQL 17 (the real prerequisite migrations, the follow-up
// lifecycle, links #26 + #27): every call AS lc_action_gateway through the database entry points, every write through
// the lease-bound T2 writers, every human decision through the PRODUCTION capability registry's decide path (D1).
// Per tool: the happy path, the owner's refusals (holds, suppression, STOP, property denial, ownership answers, never
// revive, closing stages, bounds), and that nothing irreversible ever happens without a named human.
import test from 'node:test'
import assert from 'node:assert/strict'

import { pgAvailable, skipReason } from '../pg/agent-pg-harness.mjs'
import { makeGateway, seedThread, sel, trapTransport, findPhoneLike, SELLER_2 } from '../helpers/action-gateway-pg.mjs'
import { t2World, seedOpportunity, seedCampaign, humanPlane, OWNER, OPERATOR } from '../helpers/action-gateway-t2-pg.mjs'
import { __setAutomationHoldResolverForTests } from '../../src/lib/domain/holds/automation-hold.js'

const skip = pgAvailable() ? false : skipReason
__setAutomationHoldResolverForTests(null)
const inDays = (d) => new Date(Date.now() + d * 86_400_000).toISOString()
const hold = (owner, { key, thread, tk, type = 'operator_hold', property = null }) => sel(owner, `insert into public.automation_holds (hold_key, hold_type, thread_key, inbox_thread_id, property_id, reason, set_by, approval_ref)
  values ($1, $2, $3, $4, $5, 'test hold', 'owner', 'test') returning id`, [key, type, tk, thread, property]).then((r) => r[0].id)
const approvalRow = async (owner, id) => (await sel(owner, `select * from agent.approval_request where approval_id = $1`, [id]))[0]

test('PG T2: update_lead_stage files ONE pending human request (source = the authenticated agent); the stage changes ONLY when a named operator approves; closing / contract stages, a forged source, a held deal and an Offer without an offer event are refused', { skip }, async () => {
  const { env, cred } = await world()
  const net = trapTransport()
  try {
    const t = await seedThread(env.owner)
    const opp = await seedOpportunity(env.owner, { thread_key: t.phone })
    const { gateway } = makeGateway(env)
    const plane = humanPlane(env)
    const r = await gateway.call({ credential: cred, tool: 'update_lead_stage', args: { client_request_id: 'stage-0001', opportunity_id: opp, to_stage: 'property_condition', reason: 'Seller described the roof and the kitchen' } })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.code, 'HUMAN_APPROVAL_REQUESTED')
    const a = await approvalRow(env.owner, r.result.approval_id)
    assert.deepEqual([a.capability_id, a.state, a.requested_by, a.provenance], ['pipeline.propose_stage_change', 'pending', OPERATOR, 'model'])
    assert.equal(a.intended_change.source, 'action_gateway:agt_alpha', 'the source is the authenticated agent')
    assert.equal(a.intended_change.from_stage, 'asking_price')
    assert.equal((await sel(env.owner, `select acquisition_stage from public.acquisition_opportunities where id = $1`, [opp]))[0].acquisition_stage, 'asking_price', 'the request changed nothing')
    // replay: the recorded outcome, no second approval
    const again = await gateway.call({ credential: cred, tool: 'update_lead_stage', args: { client_request_id: 'stage-0001', opportunity_id: opp, to_stage: 'property_condition', reason: 'Seller described the roof and the kitchen' } })
    assert.equal(again.status, 'replayed')
    assert.equal(again.result.approval_id, r.result.approval_id)
    // the HUMAN decides through the production registry; the transition runs with the agent source + the human actor
    const d = await plane.decide(r.result.approval_id)
    assert.equal(d.ok, true, JSON.stringify(d))
    assert.equal(plane.calls.transition.length, 1)
    assert.deepEqual([plane.calls.transition[0].source, plane.calls.transition[0].actor, plane.calls.transition[0].to_stage], ['action_gateway:agt_alpha', OWNER, 'property_condition'])
    assert.equal((await sel(env.owner, `select acquisition_stage from public.acquisition_opportunities where id = $1`, [opp]))[0].acquisition_stage, 'property_condition')
    // approval replay: never a second execution
    const d2 = await plane.decide(r.result.approval_id)
    assert.equal(d2.replayed, true)
    assert.equal(plane.calls.transition.length, 1)
    // refusals
    const closing = await gateway.call({ credential: cred, tool: 'update_lead_stage', args: { client_request_id: 'stage-0002', opportunity_id: opp, to_stage: 'closed', reason: 'Seller signed' } })
    assert.equal(closing.code, 'CONTRACT_OR_CLOSING_STAGE_REFUSED')
    assert.equal(closing.status, 'refused')
    const contract = await gateway.call({ credential: cred, tool: 'update_lead_stage', args: { client_request_id: 'stage-0003', opportunity_id: opp, to_stage: 'formal_contract', reason: 'Seller agreed' } })
    assert.equal(contract.code, 'CONTRACT_OR_CLOSING_STAGE_REFUSED')
    const forged = await gateway.call({ credential: cred, tool: 'update_lead_stage', args: { client_request_id: 'stage-0004', opportunity_id: opp, to_stage: 'offer', reason: 'x offer', source: 'closing_authority' } })
    assert.equal(forged.error.class, 'invalid_input', 'a source argument is never accepted')
    const forged2 = await gateway.call({ credential: cred, tool: 'update_lead_stage', args: { client_request_id: 'stage-0005', opportunity_id: opp, to_stage: 'offer', reason: 'x offer', offer_event: { amount: 1 } } })
    assert.equal(forged2.error.class, 'invalid_input')
    const offer = await gateway.call({ credential: cred, tool: 'update_lead_stage', args: { client_request_id: 'stage-0006', opportunity_id: opp, to_stage: 'offer', reason: 'Seller wants an offer' } })
    assert.equal(offer.code, 'OFFER_EVENT_REQUIRED', 'an agent source needs a recorded offer event (pipeline = projection)')
    await hold(env.owner, { key: 'test:opp-hold', thread: t.thread_id, tk: t.phone })
    await env.owner.query(`update public.automation_holds set opportunity_id = $1 where hold_key = 'test:opp-hold'`, [opp]).catch(() => {})
    const held = await gateway.call({ credential: cred, tool: 'update_lead_stage', args: { client_request_id: 'stage-0007', opportunity_id: opp, to_stage: 'offer', reason: 'Seller wants an offer' } })
    assert.equal(held.code, 'AUTOMATION_HOLD')
    assert.equal((await sel(env.owner, `select count(*)::int n from agent.approval_request where capability_id = 'pipeline.propose_stage_change'`))[0].n, 1, 'no refused request filed an approval')
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('PG T2: update_lead_disposition: a human approval runs the lead-state writer (dry run first); "No thanks" to the ownership question can never become not_interested; a suppressed / held thread and contactability codes are refused', { skip }, async () => {
  const { env, cred } = await world()
  try {
    const t = await seedThread(env.owner, { inboundBody: 'Yes I own it but not ready yet' })
    const { gateway } = makeGateway(env)
    const plane = humanPlane(env)
    const r = await gateway.call({ credential: cred, tool: 'update_lead_disposition', args: { client_request_id: 'disp-0001', thread_id: t.thread_id, disposition: 'interested', reason: 'Seller confirmed ownership and asked about timing' } })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal((await sel(env.owner, `select disposition from public.inbox_thread_state where id = $1`, [t.thread_id]))[0].disposition, null, 'nothing changed before the human')
    const d = await plane.decide(r.result.approval_id)
    assert.equal(d.ok, true, JSON.stringify(d))
    assert.deepEqual(plane.calls.patch.map((p) => [p.dryRun === true, p.patch.disposition, p.meta.actor]), [[true, 'interested', OWNER], [false, 'interested', OWNER]])
    assert.equal((await sel(env.owner, `select disposition from public.inbox_thread_state where id = $1`, [t.thread_id]))[0].disposition, 'interested')
    // the ownership-answer rule (owner 2026-10-17): "No thanks" to "do you still own…" is declined_unverified
    const t2 = await seedThread(env.owner, { phone: SELLER_2, property: 'p200', inboundBody: 'No thanks' })
    const ni = await gateway.call({ credential: cred, tool: 'update_lead_disposition', args: { client_request_id: 'disp-0002', thread_id: t2.thread_id, disposition: 'not_interested', reason: 'Seller said no thanks' } })
    assert.equal(ni.code, 'DECLINED_UNVERIFIED_REQUIRED', JSON.stringify(ni))
    const du = await gateway.call({ credential: cred, tool: 'update_lead_disposition', args: { client_request_id: 'disp-0003', thread_id: t2.thread_id, disposition: 'declined_unverified', reason: 'Seller declined the ownership question' } })
    assert.equal(du.code, 'HUMAN_APPROVAL_REQUESTED', JSON.stringify(du))
    for (const [k, disposition, code] of [['disp-0004', 'wrong_number', 'DISPOSITION_NOT_ALLOWED'], ['disp-0005', 'suppressed', 'DISPOSITION_NOT_ALLOWED'], ['disp-0006', 'wrong_person', 'DISPOSITION_NOT_ALLOWED']]) {
      const x = await gateway.call({ credential: cred, tool: 'update_lead_disposition', args: { client_request_id: k, thread_id: t.thread_id, disposition, reason: 'agent guess' } })
      assert.equal(x.code, code, disposition)
    }
    await env.owner.query(`update public.inbox_thread_state set is_suppressed = true where id = $1`, [t.thread_id])
    const sup = await gateway.call({ credential: cred, tool: 'update_lead_disposition', args: { client_request_id: 'disp-0007', thread_id: t.thread_id, disposition: 'no_response', reason: 'No reply in a week' } })
    assert.equal(sup.code, 'CONTACT_NOT_PERMITTED')
    await hold(env.owner, { key: 'test:disp-hold', thread: t2.thread_id, tk: t2.phone })
    const held = await gateway.call({ credential: cred, tool: 'update_lead_disposition', args: { client_request_id: 'disp-0008', thread_id: t2.thread_id, disposition: 'no_response', reason: 'No reply in a week' } })
    assert.equal(held.code, 'AUTOMATION_HOLD')
  } finally { await env.db.drop() }
})

test('PG T2: create_deal_action lands ONE opportunity-bound task in the Action Center (standing grant alone); the Hartford deal (CLOSED LOST) is never revived', { skip }, async () => {
  const { env, cred } = await world()
  try {
    const opp = await seedOpportunity(env.owner, {})
    const hartford = await seedOpportunity(env.owner, { id: '9b690ce3-ff88-400b-b56e-69e9bd0055b0', property: '225438557', status: 'archived', stage: 'offer' })
    const { gateway } = makeGateway(env)
    const r = await gateway.call({ credential: cred, tool: 'create_deal_action', args: { client_request_id: 'deal-0001', opportunity_id: opp, action_kind: 'schedule_walkthrough', title: 'Schedule a walkthrough with the seller', note: 'Seller is at 312-555-0161 after 5pm', priority: 400 } })
    assert.equal(r.ok, true, JSON.stringify(r))
    const w = (await sel(env.owner, `select * from agent.ops_work_item where work_item_id = $1`, [r.result.work_item_id]))[0]
    assert.deepEqual([w.scope, w.kind, w.subject_type, w.subject_id, w.detail.deal_action, w.priority], ['agent', 'agent_task', 'opportunity', opp, 'schedule_walkthrough', 400])
    assert.equal(findPhoneLike(JSON.stringify(w.detail)), null)
    const again = await gateway.call({ credential: cred, tool: 'create_deal_action', args: { client_request_id: 'deal-0001', opportunity_id: opp, action_kind: 'schedule_walkthrough', title: 'Schedule a walkthrough with the seller', note: 'Seller is at 312-555-0161 after 5pm', priority: 400 } })
    assert.equal(again.status, 'replayed')
    assert.equal((await sel(env.owner, `select count(*)::int n from agent.ops_work_item where scope = 'agent'`))[0].n, 1)
    const h = await gateway.call({ credential: cred, tool: 'create_deal_action', args: { client_request_id: 'deal-0002', opportunity_id: hartford, action_kind: 'call_seller', title: 'Call the Hartford seller back' } })
    assert.equal(h.code, 'CLOSED_LOST_NEVER_REVIVE')
    assert.equal((await sel(env.owner, `select count(*)::int n from agent.ops_work_item where scope = 'agent'`))[0].n, 1)
  } finally { await env.db.drop() }
})

test('PG T2: request_thread_hold_release files a RELEASE REQUEST; the hold stays until a named operator approves (the release is the operator\'s, audited); the agent can never self-release; the Maxwell permanent exclusion and the Hartford hold are refused outright', { skip }, async () => {
  const { env, cred } = await world()
  try {
    const t = await seedThread(env.owner)
    const hid = await hold(env.owner, { key: `agent_hold:${t.thread_id}`, thread: t.thread_id, tk: t.phone })
    const { gateway } = makeGateway(env)
    const plane = humanPlane(env)
    const r = await gateway.call({ credential: cred, tool: 'request_thread_hold_release', args: { client_request_id: 'rel-0001', thread_id: t.thread_id, hold_id: hid, reason_code: 'seller_confirmed_ownership', note: 'Seller confirmed Oak St is theirs' } })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.code, 'HUMAN_APPROVAL_REQUESTED')
    assert.equal((await sel(env.owner, `select released_at from public.automation_holds where id = $1`, [hid]))[0].released_at, null, 'never self-executed')
    // the gateway role itself cannot release a hold
    await assert.rejects(env.db.pool.query(`set role lc_action_gateway; update public.automation_holds set released_at = now(), released_by = 'agent', release_reason = 'x' where id = '${hid}'`), /permission denied/)
    await env.db.pool.query('reset role')
    const d = await plane.decide(r.result.approval_id)
    assert.equal(d.ok, true, JSON.stringify(d))
    const h = (await sel(env.owner, `select released_at, released_by, release_reason from public.automation_holds where id = $1`, [hid]))[0]
    assert.ok(h.released_at)
    assert.equal(h.released_by, `operator:${OWNER}`, 'the release is the approving operator\'s')
    assert.match(h.release_reason, /^agent_request:seller_confirmed_ownership; approval:apr_/)
    assert.equal((await sel(env.owner, `select count(*)::int n from public.automation_hold_events where event_type = 'hold_released'`))[0].n, 1)
    // Maxwell (permanent exclusion) and Hartford: refused outright
    const pe = await hold(env.owner, { key: 'owner_handled_20261014:maxwell', thread: t.thread_id, tk: t.phone, type: 'permanent_exclusion' })
    const m = await gateway.call({ credential: cred, tool: 'request_thread_hold_release', args: { client_request_id: 'rel-0002', thread_id: t.thread_id, hold_id: pe, reason_code: 'issue_resolved' } })
    assert.equal(m.code, 'PERMANENT_EXCLUSION')
    const ht = await seedThread(env.owner, { phone: SELLER_2, property: '225438557', id: '596a9368-6ef8-40f8-97cb-fcc46e6672d3' })
    const hh = await hold(env.owner, { key: 'owner_hold_20261016:hartford', thread: ht.thread_id, tk: ht.phone, property: '225438557' })
    const hr = await gateway.call({ credential: cred, tool: 'request_thread_hold_release', args: { client_request_id: 'rel-0003', thread_id: ht.thread_id, hold_id: hh, reason_code: 'issue_resolved' } })
    assert.equal(hr.code, 'CLOSED_LOST_NEVER_REVIVE')
    // defence in depth: even an operator-path release of those is refused by the release writer
    const { releaseAutomationHoldByOperator } = await import('../../src/lib/domain/holds/automation-hold-release.js')
    assert.equal((await releaseAutomationHoldByOperator({ hold_id: pe, released_by: OWNER, release_reason: 'x' }, { supabase: plane.sb })).code, 'PERMANENT_EXCLUSION')
    assert.equal((await releaseAutomationHoldByOperator({ hold_id: hh, released_by: OWNER, release_reason: 'x' }, { supabase: plane.sb })).code, 'CLOSED_LOST_NEVER_REVIVE')
    assert.equal((await sel(env.owner, `select count(*)::int n from public.automation_holds where released_at is null`))[0].n, 2)
  } finally { await env.db.drop() }
})

test('PG T2: schedule_followup plans ONE intent in the durable lifecycle (born under followup_execution_mode OFF: planned, never materialized); holds AT PLAN, STOP, a property denial and a decline to the ownership question are refused; cancel_followup cancels it through the lifecycle cancel path, even under a hold', { skip }, async () => {
  const { env, cred } = await world()
  try {
    // rc-8.5.21.1: the latest reply answers our OWNERSHIP question, so a follow-up needs an explicit SELLING answer in it
    // (followup-lifecycle#burstHasSellingAnswer); a callback request alone is not one (asserted below)
    const t = await seedThread(env.owner, { inboundBody: 'Yes I own it but no plans to sell right now. Call me back next month please' })
    const { gateway } = makeGateway(env)
    const bare = await seedThread(env.owner, { phone: '+13125550165', property: 'p500', inboundBody: 'Call me back next month please' })
    const noSell = await gateway.call({ credential: cred, tool: 'schedule_followup', args: { client_request_id: 'fu-00000', thread_id: bare.thread_id, kind: 'seller_requested_callback', due_at: inDays(20), reason_code: 'seller_asked_for_callback' } })
    assert.equal(noSell.code, 'OWNERSHIP_DECLINED_UNVERIFIED', 'an ownership answer without a selling answer is refused through the gateway')
    assert.equal(noSell.result.reason, 'selling_nurture_requires_selling_intent_answer')
    const fuArgs = { client_request_id: 'fu-00001', thread_id: t.thread_id, kind: 'seller_requested_callback', due_at: inDays(20), reason_code: 'seller_asked_for_callback' }
    const r = await gateway.call({ credential: cred, tool: 'schedule_followup', args: fuArgs })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.code, 'FOLLOWUP_PLANNED')
    const fi = (await sel(env.owner, `select * from public.followup_intents where id = $1`, [r.result.followup_intent_id]))[0]
    assert.deepEqual([fi.state, fi.kind, fi.writer, fi.use_case, fi.row_spec.metadata.messaging_category], ['planned', 'seller_requested_callback', 'action_gateway', 'nurture_seller_callback', 'scheduled_followup'])
    assert.equal((await sel(env.owner, `select count(*)::int n from public.send_queue where metadata ->> 'followup_intent_id' is not null`))[0].n, 0, 'nothing materialized: the lifecycle switch is OFF')
    assert.ok((await sel(env.owner, `select follow_up_at from public.inbox_thread_state where id = $1`, [t.thread_id]))[0].follow_up_at, 'follow_up_at is the projection')
    const again = await gateway.call({ credential: cred, tool: 'schedule_followup', args: fuArgs })
    assert.equal(again.status, 'replayed')
    const soon = await gateway.call({ credential: cred, tool: 'schedule_followup', args: { client_request_id: 'fu-00002', thread_id: t.thread_id, kind: 'not_interested_nurture', due_at: inDays(3), reason_code: 'not_interested_30_day' } })
    assert.equal(soon.code, 'NURTURE_TOO_SOON')
    // cancel it, under a hold (risk-lowering is always allowed)
    const hid = await hold(env.owner, { key: 'test:fu-hold', thread: t.thread_id, tk: t.phone })
    const held = await gateway.call({ credential: cred, tool: 'schedule_followup', args: { client_request_id: 'fu-00003', thread_id: t.thread_id, kind: 'seller_requested_callback', due_at: inDays(25), reason_code: 'seller_asked_for_callback' } })
    assert.equal(held.code, 'AUTOMATION_HOLD', 'R7: the hold is checked AT PLAN')
    const c = await gateway.call({ credential: cred, tool: 'cancel_followup', args: { client_request_id: 'fuc-00001', thread_id: t.thread_id, followup_intent_id: r.result.followup_intent_id, reason_code: 'seller_replied' } })
    assert.equal(c.code, 'FOLLOWUP_CANCELLED', JSON.stringify(c))
    const fi2 = (await sel(env.owner, `select state, reason from public.followup_intents where id = $1`, [r.result.followup_intent_id]))[0]
    assert.deepEqual([fi2.state, fi2.reason], ['cancelled', 'agent_cancel:seller_replied'])
    assert.equal((await sel(env.owner, `select actor from public.followup_intent_events where intent_id = $1 order by id desc limit 1`, [r.result.followup_intent_id]))[0].actor, 'agent:agt_alpha')
    const none = await gateway.call({ credential: cred, tool: 'cancel_followup', args: { client_request_id: 'fuc-00002', thread_id: t.thread_id, reason_code: 'plan_changed' } })
    assert.equal(none.code, 'NOTHING_LIVE_TO_CANCEL')
    await env.owner.query(`update public.automation_holds set released_at = now(), released_by = 'owner', release_reason = 'test' where id = $1`, [hid])
    // STOP on the latest inbound
    const ts = await seedThread(env.owner, { phone: SELLER_2, property: 'p200', inboundBody: 'STOP' })
    const stop = await gateway.call({ credential: cred, tool: 'schedule_followup', args: { client_request_id: 'fu-00004', thread_id: ts.thread_id, kind: 'seller_requested_callback', due_at: inDays(5), reason_code: 'operator_requested' } })
    assert.equal(stop.code, 'STOP_REQUESTED')
    // a decline to the ownership question: no selling nurture
    const tn = await seedThread(env.owner, { phone: '+13125550163', property: 'p300', inboundBody: 'No thanks' })
    const decl = await gateway.call({ credential: cred, tool: 'schedule_followup', args: { client_request_id: 'fu-00005', thread_id: tn.thread_id, kind: 'not_interested_nurture', due_at: inDays(30), reason_code: 'not_interested_30_day' } })
    assert.equal(decl.code, 'OWNERSHIP_DECLINED_UNVERIFIED', JSON.stringify(decl))
    // a property denial for this property × contact
    const td = await seedThread(env.owner, { phone: '+13125550164', property: 'p400', inboundBody: 'Can you call me in a few weeks' })
    await env.owner.query(`insert into public.contact_property_resolution (property_id, contact_phone_e164, contact_property_role, rejected_at, rejection_reason) values ('p400', '+13125550164', 'not_owner', now(), 'seller said not the owner')`)
    const den = await gateway.call({ credential: cred, tool: 'schedule_followup', args: { client_request_id: 'fu-00006', thread_id: td.thread_id, kind: 'seller_requested_callback', due_at: inDays(14), reason_code: 'seller_asked_for_callback' } })
    assert.equal(den.code, 'PROPERTY_DENIAL', JSON.stringify(den))
    assert.equal((await sel(env.owner, `select count(*)::int n from public.followup_intents where writer = 'action_gateway'`))[0].n, 1, 'refusals planned nothing')
  } finally { await env.db.drop() }
})

test('PG T2: pause_campaign pauses IMMEDIATELY through the lifecycle writer (standing grant, reversible); request_campaign_resume only asks a human (approval re-runs the lifecycle resume); adjust_campaign_plan is bounded (caps / pacing / 08:00 to 21:00 window), never audience or market', { skip }, async () => {
  const { env, cred } = await world()
  try {
    const camp = await seedCampaign(env.owner)
    const draft = await seedCampaign(env.owner, { status: 'draft' })
    const { gateway } = makeGateway(env)
    const plane = humanPlane(env)
    const p = await gateway.call({ credential: cred, tool: 'pause_campaign', args: { client_request_id: 'pause-0001', campaign_id: camp, reason_code: 'complaint_spike' } })
    assert.equal(p.code, 'CAMPAIGN_PAUSED', JSON.stringify(p))
    const c = (await sel(env.owner, `select status, paused_at, last_transition_reason from public.campaigns where id = $1`, [camp]))[0]
    assert.equal(c.status, 'paused')
    assert.ok(c.paused_at)
    assert.equal(c.last_transition_reason, 'agent_pause:agt_alpha:complaint_spike')
    const p2 = await gateway.call({ credential: cred, tool: 'pause_campaign', args: { client_request_id: 'pause-0002', campaign_id: camp, reason_code: 'complaint_spike' } })
    assert.equal(p2.code, 'ALREADY_PAUSED')
    const pd = await gateway.call({ credential: cred, tool: 'pause_campaign', args: { client_request_id: 'pause-0003', campaign_id: draft, reason_code: 'other' } })
    assert.equal(pd.code, 'CAMPAIGN_NOT_PAUSABLE')
    // resume: a human request only
    const rr = await gateway.call({ credential: cred, tool: 'request_campaign_resume', args: { client_request_id: 'resume-0001', campaign_id: camp, reason: 'Complaints were from one bad list; list removed' } })
    assert.equal(rr.code, 'HUMAN_APPROVAL_REQUESTED', JSON.stringify(rr))
    assert.equal((await sel(env.owner, `select status from public.campaigns where id = $1`, [camp]))[0].status, 'paused', 'the agent cannot resume')
    const d = await plane.decide(rr.result.approval_id)
    assert.equal(d.ok, true, JSON.stringify(d))
    assert.equal(plane.calls.lifecycle[0].action, 'resume')
    assert.equal((await sel(env.owner, `select status from public.campaigns where id = $1`, [camp]))[0].status, 'active')
    const rr2 = await gateway.call({ credential: cred, tool: 'request_campaign_resume', args: { client_request_id: 'resume-0002', campaign_id: camp, reason: 'again please' } })
    assert.equal(rr2.code, 'CAMPAIGN_NOT_PAUSED')
    // adjust: bounded
    const adj = await gateway.call({ credential: cred, tool: 'adjust_campaign_plan', args: { client_request_id: 'adj-00001', campaign_id: camp, changes: { daily_cap: 80, send_interval_seconds: 120, contact_window_end: '19:00' }, reason: 'Slow down while reply volume is high' } })
    assert.equal(adj.code, 'HUMAN_APPROVAL_REQUESTED', JSON.stringify(adj))
    const a = await approvalRow(env.owner, adj.result.approval_id)
    assert.deepEqual(a.intended_change.before, { daily_cap: 200, send_interval_seconds: 60, contact_window_end: '20:00' })
    assert.equal((await plane.decide(adj.result.approval_id)).ok, true)
    assert.deepEqual(plane.calls.update[0], { id: camp, daily_cap: 80, send_interval_seconds: 120, contact_window_end: '19:00' })
    const late = await gateway.call({ credential: cred, tool: 'adjust_campaign_plan', args: { client_request_id: 'adj-00002', campaign_id: camp, changes: { contact_window_end: '22:30' }, reason: 'Text later' } })
    assert.equal(late.code, 'WINDOW_OUTSIDE_POLICY')
    const wide = await gateway.call({ credential: cred, tool: 'adjust_campaign_plan', args: { client_request_id: 'adj-00003', campaign_id: camp, changes: { market: 'Dallas' }, reason: 'Widen' } })
    assert.equal(wide.error.class, 'invalid_input', 'audience / market are not in the schema')
  } finally { await env.db.drop() }
})

async function world(opts) { return t2World(opts) }
