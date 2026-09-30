/**
 * Writes the dashboard's ?demo=1 Closing Desk data by running the raw
 * scenario rows (tests/fixtures/closing-execution-scenarios.mjs) through the
 * REAL derivation. Demo data is never served by the API and is always
 * labelled DEMO in the UI. Re-run after changing the model:
 *   node --import ./tests/register-aliases.mjs scripts/gen-closing-demo.mjs
 *
 * The activity feed per closing is the audit trail the closing authority
 * writes for exactly these rows (one event per canonical write), so the demo's
 * ACTIVITY section shows what production would show for the same facts.
 */
import { writeFileSync } from 'node:fs'
import { deriveClosingExecution, summarizePortfolio } from '../src/lib/domain/closings/closing-execution-model.js'
import { closingScenarios, scenarioRuntime, SCENARIO_NOW } from '../tests/fixtures/closing-execution-scenarios.mjs'

const NOW = SCENARIO_NOW
const scenarios = closingScenarios(NOW)
const items = scenarios.map((s) => deriveClosingExecution({ ...s, now: NOW }))

/** The audit events closing-authority.js writes for these canonical rows. */
function auditFor(s, x) {
  const c = s.closingCase
  const out = []
  const push = (type, at, actor, source, detail = {}) => { if (at) out.push({ id: `${x.id}:${type}:${out.length}`, type, actor, source, detail, at }) }
  push('docusign_status', c.contract_signed_date || c.envelope_sent_at, 'docusign', 'docusign_webhook', { status: c.contract_status })
  push('title_intro_email', c.title_intro_sent_at, 'closing_automation', 'title_intro', { to: c.title_company_email })
  push('title_acknowledged', c.title_acknowledged_at, 'email_command', c.title_acknowledged_source || 'title_email', { after: 'opened' })
  push('title_commitment_received', c.title_commitment_received_at, 'email_command', 'title_email', { evidence: c.title_commitment_evidence })
  push('clear_to_close', c.clear_to_close_at, c.clear_to_close_actor, c.clear_to_close_source, { evidence: c.clear_to_close_evidence })
  for (const o of s.offers || []) {
    push('buyer_selected', o.selected_at, o.selected_by || 'operator', 'operator', { buyer_offer_id: o.buyer_offer_id })
    push('buyer_committed', o.committed_at, 'operator', 'agreement_execution', { buyer_offer_id: o.buyer_offer_id })
  }
  for (const a of s.agreements || []) {
    push('buyer_agreement_status', a.sent_at, 'operator', a.provider || 'docusign', { after: 'sent' })
    push('buyer_agreement_status', a.executed_at, 'docusign', a.provider || 'docusign', { after: 'fully_executed' })
  }
  for (const r of s.emdReceipts || []) {
    push('emd_received', r.received_at, 'operator', r.source, { amount: r.amount })
    push('emd_verified', r.verified_at, r.verified_by, r.verification_method, { evidence: r.evidence_reference })
  }
  for (const i of s.titleIssues || []) push('title_issue_opened', i.opened_at, i.opened_by, i.source, { type: i.issue_type, description: i.description })
  for (const st of s.settlements || []) push(st.settlement_status === 'settled' ? 'settlement_settled' : 'settlement_recorded', st.verified_at || st.created_at, st.verified_by || 'operator', st.source || 'title_provider', { statement: st.settlement_statement_reference })
  for (const r of s.emailRequests || []) push('email_requested', r.requested_at, 'closing_automation', 'closing_automation', { action: r.action, sequence: r.sequence, status: r.status, reason: r.status_reason })
  for (const a of s.activity || []) push(a.event_type, a.created_at, a.actor, a.source, a.detail)
  push('closing_terminated', c.terminal_at, c.terminal_actor, 'operator', { outcome: c.terminal_outcome, reason: c.terminal_reason })
  if (c.closed_at) push('closing_finalized', c.closed_at, c.closed_by, 'closing_desk', {})
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)))
}

const runtime = scenarioRuntime(NOW)
const out = {
  generatedFrom: 'apps/api/tests/fixtures/closing-execution-scenarios.mjs',
  now: new Date(NOW).toISOString(),
  runtime,
  portfolio: { items, view: 'full', summary: summarizePortfolio(items, { now: NOW }), runtime: { automationEnabled: runtime.automationEnabled, heartbeatAt: runtime.heartbeatAt, emailSendEnabled: runtime.emailSendEnabled, emailSwitch: { operator: true, deployment: true } }, degraded: [], sort: 'most_urgent', recentDays: 120, generatedAt: new Date(NOW).toISOString() },
  activity: Object.fromEntries(items.map((x, i) => [x.id, auditFor(scenarios[i], x)])),
}
writeFileSync(new URL('../../dashboard/src/views/closing-desk/mobile/closing-demo.generated.json', import.meta.url), JSON.stringify(out) + '\n')
console.log('wrote', items.length, 'demo closings')
