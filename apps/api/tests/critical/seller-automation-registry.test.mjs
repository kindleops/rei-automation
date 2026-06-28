import test from 'node:test'
import assert from 'node:assert/strict'

import {
  SELLER_AUTOMATION_ACTION_REGISTRY,
  listSellerAutomationRegistryResponse,
  getSellerAutomationAction,
} from '../../src/lib/domain/seller-automation/seller-automation-action-registry.js'

const REQUIRED_ACTION_KEYS = [
  'inbound_message_received',
  'property_resolved',
  'participant_resolved',
  'phone_thread_resolved',
  'message_classified',
  'facts_extracted',
  'ownership_confirmed',
  'ownership_inferred',
  'ownership_denied',
  'seller_interest_detected',
  'asking_price_extracted',
  'property_condition_extracted',
  'motivation_extracted',
  'timeline_extracted',
  'decision_intelligence_evaluated',
  'offer_calculated',
  'offer_message_generated',
  'automatic_reply_selected',
  'template_rendered',
  'contactability_checked',
  'duplicate_send_check',
  'message_queued',
  'message_claimed',
  'message_sent',
  'message_delivered',
  'message_failed',
  'follow_up_scheduled',
  'follow_up_became_due',
  'follow_up_executed',
  'stage_advanced',
  'operational_status_changed',
  'temperature_changed',
  'disposition_changed',
  'contactability_changed',
  'next_best_contact_selected',
  'conversation_archived',
  'conversation_unarchived',
  'lead_paused',
  'lead_resumed',
  'contract_generated',
  'contract_sent',
  'contract_viewed',
  'contract_signed',
  'under_contract_handoff',
  'disposition_started',
  'prepared_to_close',
  'deal_closed',
  'needs_review_created',
  'automation_blocked',
  'retry_executed',
  'recovery_worker_repaired',
  'notification_emitted',
]

test('seller automation registry exposes canonical workflow actions', () => {
  const keys = new Set(SELLER_AUTOMATION_ACTION_REGISTRY.map((entry) => entry.action_key))
  for (const actionKey of REQUIRED_ACTION_KEYS) {
    assert.equal(keys.has(actionKey), true, `missing action ${actionKey}`)
    const action = getSellerAutomationAction(actionKey)
    assert.ok(action?.node_type, `missing node_type for ${actionKey}`)
    assert.ok(action?.display_name, `missing display_name for ${actionKey}`)
    assert.ok(action?.backend_handler, `missing backend_handler for ${actionKey}`)
  }
})

test('seller automation registry response is frontend-ready', () => {
  const payload = listSellerAutomationRegistryResponse()
  assert.equal(payload.workflow_id, 'seller-inbound-v1')
  assert.ok(payload.nodes.length >= REQUIRED_ACTION_KEYS.length)
  assert.ok(payload.edges.length > 0)
  assert.ok(Object.keys(payload.categories).length > 0)
  for (const node of payload.nodes) {
    assert.ok(node.node_type)
    assert.ok(node.display_name)
    assert.equal(typeof node.enabled, 'boolean')
  }
})