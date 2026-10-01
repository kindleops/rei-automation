import { describe, expect, it } from 'vitest'
import { failureOf, readInspector, InspectorReadError } from '../inspector-read'
import { inspectRefOfCommand } from '../command-inspect'
import type { InspectorModel } from '../inspector-registry'
import { shapeProperty } from './property'
import { hasConversation, shapeSeller } from './seller'
import { shapeCampaign, heldReason } from './campaign'
import { shapeBuyer } from './buyer'
import { shapeClosing } from './closing'
import { shapeDeal } from './deal'
import { parseWorkflowRef, shapeRun, shapeWorkflow, toneOfRun } from './workflow'
// Recorded from the local API (production read, 2026-10-01), trimmed to the
// fields the shapers read; seller names, phones and message text redacted.
import propertySubject from './__fixtures__/property-subject.json'
import sellerDossier from './__fixtures__/seller-thread-dossier.json'
import campaignDetail from './__fixtures__/campaign-detail.json'
import buyerProfile from './__fixtures__/buyer-profile.json'
import closingExecution from './__fixtures__/closing-execution.json'
import dealStory from './__fixtures__/deal-story.json'
import workflowRun from './__fixtures__/workflow-run.json'
import workflowDefinition from './__fixtures__/workflow-definition.json'

const fact = (m: InspectorModel, label: string) => m.facts.find((f) => f.label === label)?.value ?? null
const val = (m: InspectorModel, label: string) => m.value?.find((f) => f.label === label)?.value ?? null
const noEmpty = (m: InspectorModel) => {
  for (const f of [...m.facts, ...(m.value ?? [])]) expect(f.value, f.label).toBeTruthy()
}
const NOW = Date.parse('2026-10-01T18:40:00Z')

describe('property inspector (properties/:id/subject)', () => {
  const m = shapeProperty(propertySubject.data as never, { type: 'property', id: '273312064' })
  it('shapes identity, facts and modeled value apart', () => {
    expect(m.title).toBe('3635 Emerson Ave N, Minneapolis, Mn 55412')
    expect(m.eyebrow).toBe('Minneapolis, MN · Hennepin County')
    expect(fact(m, 'Layout')).toBe('4 bd · 2.5 ba · 1,853 sq ft')
    expect(fact(m, 'Built')).toBe('1907')
    expect(val(m, 'Estimated value')).toBe('$213,000')
    expect(val(m, 'Equity')).toBe('$149,257 · 71%')
    expect(val(m, 'Last sale')).toBeNull() // not recorded → omitted, never "—"
    noEmpty(m)
  })
  it('opens each app with its own deep link and carries mission + replay', () => {
    expect(m.open?.map((o) => o.path)).toEqual([
      '/deal-intelligence?property_id=273312064',
      '/comp-intelligence?property_id=273312064',
      '/buyer-match?property_id=273312064',
      '/entity-graph/property/273312064',
    ])
    expect(m.mission?.propertyId).toBe('273312064')
    expect(m.replay).toEqual({ type: 'property', id: '273312064', label: m.title })
  })
  it('relates the seller only when a thread is known', () => {
    expect(m.relations).toEqual([])
    const withHint = shapeProperty(propertySubject.data as never, { type: 'property', id: '273312064', hint: { thread_key: '+15550100001' } })
    expect(withHint.relations?.[0].ref).toMatchObject({ type: 'seller', id: '+15550100001' })
  })
})

describe('seller inspector (inbox/thread-dossier)', () => {
  const m = shapeSeller(sellerDossier as never, { type: 'seller', id: '+15550100001' }, NOW)
  it('renders contactability, automation, next action and latest inbound from thread state', () => {
    expect(m.title).toBe('Seller One')
    expect(fact(m, 'Contact')).toBe('Contactable')
    expect(fact(m, 'Automation')).toBe('Running · Active conversation')
    expect(fact(m, 'Next action')).toBeNull() // next_action is '' on this thread
    expect(fact(m, 'Latest inbound')).toMatch(/“\[seller message\]”$/)
    expect(fact(m, 'Stage')).toBe('Offer · locked by you')
    expect(m.status).toEqual({ label: 'Automation running', tone: 'live' })
    noEmpty(m)
  })
  it('treats a thread with no state and no timeline as not on record', () => {
    expect(hasConversation(sellerDossier as never)).toBe(true)
    expect(hasConversation({ diagnostics: { thread_key: '+15550100003', context: { selected_thread: { inbox_thread_state: null } }, automation_timeline: [] } })).toBe(false)
  })
  it('never shows a delivered row as the next scheduled send', () => {
    expect(fact(m, 'Next scheduled send')).toBeNull()
  })
  it('turns a blocked contactability into a blocker status', () => {
    const ts = { ...sellerDossier.diagnostics.context.selected_thread.inbox_thread_state, contactability_status: 'opted_out' }
    const body = { diagnostics: { ...sellerDossier.diagnostics, context: { selected_thread: { inbox_thread_state: ts, send_queue: [] } } } }
    const b = shapeSeller(body as never, { type: 'seller', id: '+15550100001' }, NOW)
    expect(b.status).toEqual({ label: 'Opted out (STOP)', tone: 'crit' })
    expect(fact(b, 'Contact')).toBe('Opted out (STOP)')
  })
  it('links the property, opens Inbox on the thread, replays the seller', () => {
    expect(m.relations?.[0].ref).toMatchObject({ type: 'property', id: '273312064' })
    expect(m.open?.[0].path).toBe('/inbox?thread=%2B15550100001')
    expect(m.replay).toMatchObject({ type: 'seller', id: '+15550100001' })
    expect(m.activity?.[0].text).toBe('Seller replied')
  })
})

describe('campaign inspector (campaigns/:id)', () => {
  const m = shapeCampaign(campaignDetail as never, { type: 'campaign', id: 'c963defc-5672-4419-b494-807d453f8d18' }, NOW)
  it('shows status, market from the send window, timezone, audience and queue-truth sends', () => {
    expect(m.status).toEqual({ label: 'Blocked', tone: 'crit' })
    expect(fact(m, 'Market')).toBe('Dallas, TX')
    expect(m.facts.find((f) => f.label === 'Market')?.hint).toBe('From its send window')
    expect(fact(m, 'Timezone')).toBe('America/Chicago')
    expect(fact(m, 'Audience')).toBe('95 sellers · of 197 selected')
    expect(fact(m, 'Eligible')).toBe('71')
    expect(fact(m, 'Sent')).toBe('55 · 50 delivered')
    expect(fact(m, 'Remaining')).toBe('14')
    expect(fact(m, 'Next window')).toMatch(/passed$/)
    expect(fact(m, 'Feeder')).toBe('Stalled — nothing placed on the queue')
    expect(fact(m, 'Health')).toBe('Healthy · 90/100')
    noEmpty(m)
  })
  it('names held reasons in operator words', () => {
    expect(fact(m, 'Held')).toBe('24 — Company owner — needs review (22); No approved message for the detected language (4); Owner not linked to a phone (2)')
    expect(heldReason('insufficient_template_rotation_pool:Portuguese:0<2')).toBe('No approved Portuguese message')
  })
  it('collapses repeated events and offers the run mission', () => {
    const texts = m.activity?.map((a) => a.text) ?? []
    texts.forEach((t, i) => { if (i) expect(t).not.toBe(texts[i - 1]) })
    expect(m.open?.[0].path).toBe('/campaign-command?campaign=c963defc-5672-4419-b494-807d453f8d18')
    expect(m.mission?.campaignId).toBe('c963defc-5672-4419-b494-807d453f8d18')
  })
})

describe('buyer inspector (entity-graph/buyer/:id)', () => {
  const m = shapeBuyer(buyerProfile.profile as never, { type: 'buyer', id: 'company:us_ak:10043936' })
  it('shapes observed buyer behaviour without outreach actions', () => {
    expect(m.title).toBe('ESSEX MORTGAGE')
    expect(m.eyebrow).toBe('Company · Active flipper')
    expect(fact(m, 'Identity')).toBe('Canonical · Registry identity match')
    expect(fact(m, 'Purchases')).toBe('5')
    expect(fact(m, 'Hold style')).toBe('Flip like · median hold 157 days')
    expect(fact(m, 'Buys')).toBe('Single family')
    expect(val(m, 'Median price paid')).toBe('$228,250')
    expect(val(m, 'Cash purchases')).toBe('20%')
    expect(m.mission).toBeNull()
    expect(m.replay).toBeNull()
    expect(m.open?.[0].path).toBe('/entity-graph?buyer=company%3Aus_ak%3A10043936')
    expect(m.activity?.[0].at).toBe('2026-06-02T12:00:00Z')
    noEmpty(m)
  })
})

describe('closing inspector (closing-desk/execution/:id)', () => {
  const m = shapeClosing(closingExecution.data.closing as never, { type: 'closing', id: 'closing:2b3c261d-f3dd-494a-a60c-3437cbdf39b8' })
  it('shows the terminal state, readiness and cancellation; no money when none is recorded', () => {
    expect(m.status).toEqual({ label: 'Voided', tone: 'neutral' })
    expect(m.eyebrow).toBe('Miami, FL · S6 Formal Contract')
    expect(fact(m, 'Ready')).toBe('1 of 7 requirements met')
    expect(fact(m, 'Cancelled')).toMatch(/^Voided · /)
    expect(m.value).toEqual([])
    noEmpty(m)
  })
  it('relates property, seller and deal; opens the Closing Desk case', () => {
    expect(m.relations?.map((r) => r.ref.type)).toEqual(['property', 'seller', 'deal'])
    expect(m.open?.[0].path).toBe('/closing-desk?case=closing%3A2b3c261d-f3dd-494a-a60c-3437cbdf39b8')
    expect(m.mission?.closingId).toBe('closing:2b3c261d-f3dd-494a-a60c-3437cbdf39b8')
    expect(m.activity?.[0].text).toMatch(/^Closing voided/)
  })
})

describe('deal inspector (pipeline/command/story/:id)', () => {
  const m = shapeDeal(dealStory.data as never, { type: 'deal', id: '2b3c261d-f3dd-494a-a60c-3437cbdf39b8' })
  it('keeps recommended, modeled and seller money apart', () => {
    expect(m.status).toEqual({ label: 'Needs you', tone: 'attention' })
    expect(fact(m, 'Why')).toBe('Property relationship needs review')
    expect(fact(m, 'Next')).toBe('Your review')
    expect(fact(m, 'In stage')).toBe('20 days · Waiting on operator 20d')
    expect(val(m, 'Recommended offer')).toBe('$320,900')
    expect(val(m, 'Estimated value')).toBe('$533,000')
    expect(val(m, 'Seller asking')).toBeNull()
    noEmpty(m)
  })
  it('opens Pipeline on the opportunity and replays through the seller', () => {
    expect(m.open?.[0].path).toBe('/pipeline?opp=2b3c261d-f3dd-494a-a60c-3437cbdf39b8')
    expect(m.replay).toMatchObject({ type: 'seller', id: '+15550100002' })
    expect(m.mission?.opportunityId).toBe('2b3c261d-f3dd-494a-a60c-3437cbdf39b8')
    expect(m.activity?.some((a) => a.text === 'Needs you')).toBe(false) // the synthetic "now" row is not activity
  })
})

describe('workflow inspector (observatory)', () => {
  it('parses run refs', () => {
    expect(parseWorkflowRef('seller_inbound:3004ae79-99a0-49ff-909f-7de5b03ad129')).toEqual({ key: 'seller_inbound', runId: '3004ae79-99a0-49ff-909f-7de5b03ad129' })
    expect(parseWorkflowRef('seller_inbound')).toEqual({ key: 'seller_inbound', runId: null })
    expect(toneOfRun('needs_you')).toBe('attention')
    expect(toneOfRun('failed')).toBe('crit')
  })
  it('shapes one run with its seller + property and a Studio deep link', () => {
    const m = shapeRun(workflowRun as never, { type: 'workflow', id: 'seller_inbound:3004ae79-99a0-49ff-909f-7de5b03ad129', label: 'Seller conversation' })
    expect(m.status).toEqual({ label: 'Needs you', tone: 'attention' })
    expect(fact(m, 'Why')).toBe('Low confidence — needs a human read')
    expect(fact(m, 'Seller stage')).toBe('Stayed Offer')
    expect(m.relations?.map((r) => [r.ref.type, r.ref.id])).toEqual([['seller', '+15550100001'], ['property', '273312064']])
    expect(m.open?.[0].path).toBe('/workflow-studio?wf=seller_inbound&run=3004ae79-99a0-49ff-909f-7de5b03ad129')
    expect(m.replay).toMatchObject({ type: 'workflow', id: 'seller_inbound:3004ae79-99a0-49ff-909f-7de5b03ad129' })
    noEmpty(m)
  })
  it('reads thread_key subjects and bare result codes (wf_runs ledger shape)', () => {
    const run = { ok: true, run: { run_id: '43d25669-73a4-4345-86ca-bd7cae465df8', workflow_key: 'seller_review_escalation', status: 'completed', status_label: 'Completed', trigger: 'human review requested', result: 'escalated', reason: null, current_node: null, finished_at: '2026-10-01T16:25:27.98+00:00', subject: { kind: 'thread_key', id: '+15550100001', name: 'Seller One', address: '3635 Emerson Ave N, Minneapolis, Mn 55412' } }, links: [{ href: '/inbox?thread=%2B15550100001' }], decisions: [], timeline: [] }
    const m = shapeRun(run as never, { type: 'workflow', id: 'seller_review_escalation:43d25669-73a4-4345-86ca-bd7cae465df8' })
    expect(fact(m, 'Result')).toBe('Escalated')
    expect(m.status).toEqual({ label: 'Completed', tone: 'ok' })
    expect(m.relations?.[0].ref).toMatchObject({ type: 'seller', id: '+15550100001' })
  })
  it('shapes a workflow definition', () => {
    const m = shapeWorkflow(workflowDefinition as never, { type: 'workflow', id: 'seller_inbound' })
    expect(m.title).toBe('Seller Conversation · Inbound')
    expect(fact(m, 'Starts when')).toBe('Seller replies by SMS or email')
    expect(fact(m, 'Runs, last 24h')).toBe('13')
    expect(m.open?.[0].path).toBe('/workflow-studio?wf=seller_inbound')
    noEmpty(m)
  })
})

describe('read failures → operator states', () => {
  it('classifies statuses', () => {
    expect(failureOf({ status: 401, error: 'unauthorized' })).toBe('denied')
    expect(failureOf({ status: 404, error: 'closing_not_found' })).toBe('not_found')
    expect(failureOf({ status: 502, error: 'BACKEND_UNAVAILABLE' })).toBe('not_connected')
    expect(failureOf({ status: 500, error: 'campaign_summary_failed' })).toBe('unavailable')
  })
  it('throws typed errors, including ok:false bodies', async () => {
    const ctl = new AbortController()
    const call = (async () => ({ ok: true, status: 200, data: { ok: false, error: 'deal_context_not_found' } })) as never
    await expect(readInspector('/x', ctl.signal, call)).rejects.toMatchObject({ kind: 'not_found' })
    const denied = (async () => ({ ok: false, status: 403, error: 'forbidden', message: '' })) as never
    await expect(readInspector('/x', ctl.signal, denied)).rejects.toBeInstanceOf(InspectorReadError)
  })
})

describe('Command Deck ⇧↵ inspect', () => {
  it('maps seller and property results; ignores others', () => {
    expect(inspectRefOfCommand({ id: 'c', type: 'conversation', title: 'Seller One', subtitle: '', score: 1, payload: { kind: 'focus_thread', threadId: '+15550100001', propertyId: '273312064' } })).toMatchObject({ type: 'seller', id: '+15550100001', hint: { property_id: '273312064' } })
    expect(inspectRefOfCommand({ id: 'p', type: 'property', title: '3635 Emerson Ave N', subtitle: '', score: 1, payload: { propertyId: '273312064', threadKey: null } })).toMatchObject({ type: 'property', id: '273312064' })
    expect(inspectRefOfCommand({ id: 'b', type: 'buyer', title: 'X', subtitle: '', score: 1, payload: { kind: 'focus_buyer', buyerKey: 'k' } })).toBeNull()
  })
})
