/**
 * FIXTURE · one dock conversation turn (arch §9.2 cards). SIMULATED — no
 * model is connected in S2; this is an authored event log. It shows: context
 * attached, decision lines, T0 tool rows (with the shimmer while a
 * tool.started has no completion), a streamed answer (message.delta chunks as
 * recorded, never client-side typing), a Plan card (approve → a child Deep
 * Research run opens via ui.intent), an Artifact card, and a T3 Approval card
 * whose brake is shown up-front (outbound paused by the owner).
 */
import { renderOperationLabel } from '../contracts/contracts'
import { ScenarioWriter, registerPlanTails, type DraftEvent, type FixtureScenario } from './fixture-kit'
import { LARKSPUR } from './scenario-single'

export const DEFAULT_ASK = 'Is 1418 Larkspur Ct worth an offer? If it is, text the owner.'
const PLAN_ID = 'fx-plan-1'

const tool = (label: string) => renderOperationLabel('tool.invoke', { tool_label: label })

if (import.meta.env.DEV || import.meta.env.VITE_LC_AGENT_FIXTURES === '1') registerPlanTails('conversation', {
  [PLAN_ID]: (): DraftEvent[] => [
    { t: 1, type: 'plan.approved', payload: { artifact_id: PLAN_ID, plan_hash_prefix: '9c41e0' } },
    { t: 40, type: 'run.state', payload: { from: 'awaiting_plan_approval', to: 'running', reason: 'plan_approved' } },
    { t: 120, type: 'tool.started', payload: { tool: 'research.start', tool_version: 1, tier: 'T1', operation: 'tool.invoke', label: tool('Starting Deep Research on 1418 Larkspur Ct (synthetic)'), target_refs: [{ type: 'property', id: LARKSPUR.property_id }] }, tool_call_id: 'fx-tc-4' },
    { t: 520, type: 'tool.completed', payload: { tool: 'research.start', rows: 1, duration_ms: 400, cost_usd: 0, result_summary: 'Child research run created · awaiting your scope confirmation' }, tool_call_id: 'fx-tc-4' },
    { t: 560, type: 'ui.intent', payload: { intent: 'open_research', destination: 'agent.research', object_refs: [{ type: 'research_scenario', id: 'single-deep' }], params: { scenario: 'single-deep' }, label: 'Opened Deep Research in the workspace', draft_only: true } },
    { t: 640, type: 'decision', payload: { summary: 'Deep Research opened as a child run. Confirm its scope in the workspace; I will summarise when its brief is complete.', basis_refs: [], criterion: 'child_run' } },
    { t: 700, type: 'run.state', payload: { from: 'running', to: 'waiting_tool', reason: 'child_research_run' } },
  ],
})

export function conversationScenario(): FixtureScenario {
  const w = new ScenarioWriter()
  const tc = (id: string) => ({ tool_call_id: id })
  const ref = [{ type: 'property', id: LARKSPUR.property_id, label: `${LARKSPUR.address} (synthetic)` }]

  w.emit(0, 'run.created', { kind: 'conversation', title: 'Is 1418 Larkspur Ct worth an offer?', objective_summary: 'Offer worthiness + owner contact', budget_cap_usd: 0.5, parent_run_id: null })
  w.emit(10, 'context.attached', { app: 'entity-graph', object_refs: ref, filter_summary: null, selection_count: 1 })
  w.emit(20, 'message.operator', { turn_id: 'u1', text: DEFAULT_ASK, client_msg_id: 'fx-c1' })
  w.emit(300, 'run.state', { from: 'created', to: 'running', reason: 'turn' })
  w.emit(620, 'decision', { summary: 'Starting with what LeadCommand already holds: the record, recorded liens and investor comps. No paid calls.', basis_refs: [], criterion: 'quick_scan_first' })

  w.emit(800, 'tool.started', { tool: 'property.read', tool_version: 1, tier: 'T0', operation: 'tool.invoke', label: tool('Reading the property record'), target_refs: ref }, tc('fx-tc-1'))
  w.emit(1420, 'tool.completed', { tool: 'property.read', rows: 1, duration_ms: 620, cost_usd: 0, result_summary: 'Single family · 3 bd / 1 ba · 1,236 sqft · built 1924' }, tc('fx-tc-1'))
  w.emit(1500, 'tool.started', { tool: 'liens.read', tool_version: 1, tier: 'T0', operation: 'tool.invoke', label: tool('Reading recorded mortgages and liens'), target_refs: ref }, tc('fx-tc-2'))
  w.emit(2380, 'tool.completed', { tool: 'liens.read', rows: 2, duration_ms: 880, cost_usd: 0, result_summary: 'One 1st mortgage (2011) · vendor tax-delinquent flag' }, tc('fx-tc-2'))
  w.emit(2460, 'tool.started', { tool: 'comps.read', tool_version: 1, tier: 'T0', operation: 'tool.invoke', label: tool('Reading investor-cluster comps within 0.5 mi'), target_refs: ref }, tc('fx-tc-3'))
  w.emit(3540, 'tool.completed', { tool: 'comps.read', rows: 6, duration_ms: 1080, cost_usd: 0, result_summary: '6 sales · median $64,500 · lane: SFR LLC investor cluster' }, tc('fx-tc-3'))

  w.emit(3700, 'decision', { summary: 'The vendor’s tax-delinquent and owner-occupied flags are not county-confirmed. Deep Research would check the county directly before any offer range.', basis_refs: ['fx-tc-2'], criterion: 'needs_county_confirmation' })
  w.emit(3900, 'plan.proposed', { artifact_id: PLAN_ID, plan_hash_prefix: '9c41e0', steps: [
    { label: 'Match the parcel on the county roll', tool_family: 'research', tier: 'T0', estimate_usd: 0 },
    { label: 'Check tax delinquency, code cases, foreclosure docket, deeds', tool_family: 'research', tier: 'T0', estimate_usd: 0 },
    { label: 'Extract condition notes from code-case documents', tool_family: 'research', tier: 'T0', estimate_usd: 0.02 },
    { label: 'Write the brief (sourced, sectioned)', tool_family: 'research', tier: 'T1', estimate_usd: 0.09 },
  ], estimate: { low_usd: 0.012, high_usd: 0.041, basis: 'worst_case', worst_case_usd: 0.75 } })
  w.emit(3920, 'run.state', { from: 'running', to: 'awaiting_plan_approval', reason: 'plan_required' })

  const answer = [
    'From LeadCommand’s own records: ',
    'a 1924 single family with one 2011 first mortgage, ',
    'and six investor-cluster sales within half a mile (median $64,500). ',
    'Two vendor flags matter for an offer — tax delinquency and owner occupancy — ',
    'and neither is county-confirmed yet. ',
    'I’d run Deep Research before naming a range. ',
    'Texting the owner can’t happen right now: outbound is paused, ',
    'and the owner phone isn’t identity-verified.',
  ]
  let t = 4100
  for (const chunk of answer) { w.emit(t, 'message.delta', { turn_id: 'a1', text: chunk }); t += 170 }
  w.emit(t + 40, 'message.completed', { turn_id: 'a1', text: answer.join('') })
  w.emit(t + 120, 'artifact.created', { artifact_id: 'fx-art-1', kind: 'brief', version: 1, title: 'Quick Scan · 1418 Larkspur Ct (synthetic)', status: 'draft' })
  w.emit(t + 260, 'approval.requested', { approval: {
    approval_id: 'fx-appr-1', tool_call_id: 'fx-tc-5', tool: 'sms.send_reply', tool_version: 1, tier: 'T3', title: 'Send an opener SMS to the owner',
    payload_hash_prefix: '51ab7c90e2d4',
    effects: [
      { summary: 'Sends 1 SMS to ••4471 (Cleveland) from ••1600 · English · template S1 opener', kind: 'contact', reversible: false, undo_note: 'A sent SMS cannot be recalled' },
      { summary: 'Sends 8am–9pm recipient-local only', kind: 'schedule', reversible: true, undo_note: null },
    ],
    precondition_summary: ['Not suppressed', 'Owner phone not identity-verified', 'Outbound paused: send will be refused'],
    target_scope_summary: '1 owner phone · Cleveland',
    required_role: 'operator', fresh_auth_required: false, owner_only: false,
    expires_at: '+5m', state: 'requested',
    provenance: { basis: 'turn', label: 'From your message in this run' },
    batch_id: null, identity_available: false,
    brake: 'Outbound is paused by the owner — this send would be refused.',
  } })
  w.emit(t + 300, 'usage.settled', { reserve_id: 'fx-res-c1', op_type: 'agent.turn', route: 'agent.turn', provider: 'fixture', model: 'fixture-haiku', tokens: 2140, actual_usd: 0.003, accrued_usd: 0.003, remaining_usd: 0.497 })

  return {
    id: 'conversation', kind: 'conversation', depth: null,
    title: 'Is 1418 Larkspur Ct worth an offer?', subtitle: 'Agent conversation',
    properties: [LARKSPUR], sources: [], log: w.sorted(),
  }
}
